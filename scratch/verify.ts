/**
 * Verification probes for the three behaviours added on top of MAC-first
 * resolution: identity write-back (mac + address), key-first auth ordering,
 * and MAC seeding when a host is added. Run with:
 * node --experimental-strip-types scratch/verify.ts
 */
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostStore } from '../src/store.ts'
import { buildConnectConfig, DEFAULTS, isEncryptedPrivateKey } from '../src/engine/connection-pool.ts'
import { MAC_DEFAULTS, recordConnectionIdentity, resolveMacTarget, invalidateMacCache } from '../src/mac/resolve.ts'
import type { SshHostEntry } from '../src/protocol.ts'

const ok = (name: string, pass: boolean, detail = ''): void => {
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail === '' ? '' : '  ' + detail))
}

/** A store double: records patches without touching disk. */
function fakeStore(initial: { host: string; mac?: string }) {
  const state = { ...initial }
  return {
    state,
    patches: [] as Array<{ host?: string; mac?: string }>,
    find() { return { host: state.host, ...(state.mac !== undefined ? { mac: state.mac } : {}) } },
    update(_alias: string, patch: { host?: string; mac?: string }) {
      if (patch.host !== undefined) state.host = patch.host
      if (patch.mac !== undefined) state.mac = patch.mac
      this.patches.push(patch)
      return state
    },
  }
}

const opts = { ...MAC_DEFAULTS }

// 1. A record reached by MAC at a new address records that address.
invalidateMacCache()
const moved = fakeStore({ host: '192.168.0.178' })
await recordConnectionIdentity(moved, 'TianJi', '192.168.0.195', opts)
ok('identity: address follows the machine', moved.state.host === '192.168.0.195', JSON.stringify(moved.patches))

// 2. A record with no MAC learns the one the neighbour table knows.
const bare = fakeStore({ host: '192.168.0.195' })
await recordConnectionIdentity(bare, 'TianJi', '192.168.0.195', opts)
ok('identity: MAC learned from neighbour table', bare.state.mac === '20:bd:1d:28:be:d2', String(bare.state.mac))

// 3. A recorded MAC is never overwritten.
const kept = fakeStore({ host: '192.168.0.195', mac: 'aa:bb:cc:dd:ee:ff' })
await recordConnectionIdentity(kept, 'TianJi', '192.168.0.195', opts)
ok('identity: recorded MAC kept', kept.state.mac === 'aa:bb:cc:dd:ee:ff', String(kept.state.mac))

// 4. A public address teaches nothing and rewrites nothing.
const publicHost = fakeStore({ host: '112.91.138.94' })
const publicOutcome = await recordConnectionIdentity(publicHost, 'chx-A100', '112.91.138.94', opts)
ok('identity: public address untouched', publicHost.patches.length === 0 && publicOutcome?.mac === undefined, JSON.stringify(publicHost.patches))

// 5. updateHost=false keeps the stored address.
const frozen = fakeStore({ host: '192.168.0.178' })
await recordConnectionIdentity(frozen, 'TianJi', '192.168.0.195', { ...opts, updateHost: false })
ok('identity: updateHost=false respected', frozen.state.host === '192.168.0.178', String(frozen.state.host))

// 6. Failing resolution still dials the recorded address.
invalidateMacCache()
const fallback = await resolveMacTarget({ alias: 'luoshi', host: '192.168.201.15', mac: 'f0:68:e3:82:1a:2b' }, { ...opts, sweepTimeoutMs: 300 })
ok('resolve: fallback keeps the record dialable', fallback.host === '192.168.201.15', fallback.source + ' ' + String(fallback.durationMs) + 'ms')

// 7. Concurrent callers share one resolution and both get the address.
invalidateMacCache()
const [a, b] = await Promise.all([
  resolveMacTarget({ alias: 'TianJi', host: '192.168.0.178', mac: '20:bd:1d:28:be:d2' }, opts),
  resolveMacTarget({ alias: 'TianJi-alt', host: '192.168.0.178', mac: '20:bd:1d:28:be:d2' }, opts),
])
ok('resolve: concurrent callers agree', a.host === '192.168.0.195' && b.host === '192.168.0.195' && b.alias === 'TianJi-alt', a.source + '/' + b.source)

// 8. Key-first ordering: a password record with a default identity offers the key first.
const passwordEntry: SshHostEntry = {
  alias: 'demo',
  host: '192.168.0.195',
  port: 22,
  user: 'nvidia',
  auth: { kind: 'password', password: 'secret', keyPath: undefined },
  proxyJump: [],
  tags: [],
  createdAt: 0,
  updatedAt: 0,
} as SshHostEntry
const keyFirst = buildConnectConfig(passwordEntry, undefined, { ...DEFAULTS, preferKey: true })
ok('auth: key offered first', Array.isArray(keyFirst.authHandler) && (keyFirst.authHandler as string[])[1] === 'publickey' && (keyFirst.authHandler as string[])[2] === 'password', JSON.stringify(keyFirst.authHandler))
const passwordOnly = buildConnectConfig(passwordEntry, undefined, { ...DEFAULTS, preferKey: false })
ok('auth: preferKey=false keeps password-only', passwordOnly.authHandler === undefined && passwordOnly.password === 'secret', String(passwordOnly.authHandler))

// 9. Seeding: a new record picks up the MAC the table already knows.
const dir = mkdtempSync(join(tmpdir(), 'ssh-mac-verify-'))
const seeded = new HostStore(join(dir, 'hosts.json'), join(dir, 'missing-config'), host => host === '192.168.0.195' ? '20:bd:1d:28:be:d2' : undefined)
const created = seeded.create({ alias: 'seeded', host: '192.168.0.195', user: 'nvidia', auth: { kind: 'password', password: 'x' } })
ok('seed: MAC taken at add time', created.mac === '20:bd:1d:28:be:d2', String(created.mac))
const remote = seeded.create({ alias: 'remote', host: '112.91.138.94', user: 'root', auth: { kind: 'password', password: 'x' } })
ok('seed: public host gets no MAC', remote.mac === undefined, String(remote.mac))

// 10. The stored file round-trips the seeded MAC.
const reopened = new HostStore(join(dir, 'hosts.json'), join(dir, 'missing-config'))
ok('store: seeded MAC persisted', reopened.find('seeded')?.mac === '20:bd:1d:28:be:d2', String(reopened.find('seeded')?.mac))

// 11. Reorder: mentioned aliases lead, the rest keep their order, unknown ones
// are ignored, and a partial list never drops a record.
const ordered = reopened.reorder(['ghost', 'remote']).map(entry => entry.alias)
ok('store: reorder leads with the mentioned alias', ordered.join(',') === 'remote,seeded', ordered.join(','))
const restored = reopened.reorder(['seeded', 'remote']).map(entry => entry.alias)
ok('store: reorder persists', restored.join(',') === 'seeded,remote', restored.join(','))
ok('store: reorder keeps every record', new HostStore(join(dir, 'hosts.json'), join(dir, 'missing-config')).list().length === 2, String(reopened.list().length))
writeFileSync(join(dir, 'ignore.txt'), readdirSync(dir).join(','))

// 11. An encrypted key is recognised before ssh2 chokes on it.
const encryptedLegacy = '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123\n\nAAAA\n-----END RSA PRIVATE KEY-----\n'
ok('auth: encrypted legacy key detected', isEncryptedPrivateKey(encryptedLegacy))
const openSshEncrypted = '-----BEGIN OPENSSH PRIVATE KEY-----\n'
  + Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(9); return b })(),
    Buffer.from('aes256-ctr', 'latin1'),
    Buffer.from('garbage'),
  ]).toString('base64') + '\n-----END OPENSSH PRIVATE KEY-----\n'
ok('auth: encrypted openssh key detected', isEncryptedPrivateKey(openSshEncrypted))
const openSshPlain = '-----BEGIN OPENSSH PRIVATE KEY-----\n'
  + Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(4); return b })(),
    Buffer.from('none', 'latin1'),
    Buffer.from('garbage'),
  ]).toString('base64') + '\n-----END OPENSSH PRIVATE KEY-----\n'
ok('auth: plain openssh key accepted', !isEncryptedPrivateKey(openSshPlain))

// 12. A failed resolution is remembered, so the sweep is not repeated on
// every connect.
invalidateMacCache()
const unreachable = { alias: 'offline', host: '10.42.0.7', mac: '02:00:00:00:00:99' }
const first = await resolveMacTarget(unreachable, { ...opts, sweepTimeoutMs: 200 })
const second = await resolveMacTarget(unreachable, { ...opts, sweepTimeoutMs: 200 })
ok('resolve: failure is cached', second.durationMs < first.durationMs && (second.note ?? '').includes('recent resolution failed'), String(second.note))


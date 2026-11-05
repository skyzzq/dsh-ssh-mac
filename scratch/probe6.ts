import { resolveMacTarget, MAC_DEFAULTS, invalidateMacCache } from '../src/mac/resolve.ts'
const opts = { ...MAC_DEFAULTS }
for (const [alias, host, mac] of [
  ['TianJi', '192.168.200.159', '20:bd:1d:28:be:d2'],
  ['chx4090', '192.168.200.31', '50:ee:32:ab:e0:f5'],
] as const) {
  invalidateMacCache()
  const started = Date.now()
  const r = await resolveMacTarget({ alias, host, mac }, opts)
  console.log(alias, '->', r.host, '|', r.source, '| resolved', r.resolved, '|', r.durationMs, 'ms', r.note ?? '')
}

/**
 * MAC-first address resolution, the reason this plugin exists. A host record
 * keeps the hardware address of the machine; every connect resolves it to
 * the DHCP address that machine holds right now. The order follows
 * MAC-SSH.md: neighbour table first, then (only when that yields nothing)
 * a sweep of the local subnet, then the recorded address as the last resort.
 *
 * Nothing here opens an SSH connection — the resolver only decides which
 * address ssh2 should dial, so the transport stays a plain ssh2 connect and
 * ProxyJump / ProxyCommand / the host key alias keep working unchanged.
 */

import { isPrivateIpv4, isSkippedIpv4, sweepCidrFor, cidrHosts, inCidr, localIpv4Networks } from './net-utils.ts'
import { sanitizeMac } from './mac-address.ts'
import { readNeighborTable, describe } from './neighbor.ts'
import { mapLimit, tcpProbe } from './probe.ts'

/** Knobs for MAC-first resolution. */
export interface MacOptions {
  /** Resolve recorded hardware addresses before connecting (default true). */
  enabled: boolean
  /** Write a discovered hardware address back into a host that has none. */
  learn: boolean
  /**
   * Keep the recorded address current: after a connect that used the MAC to
   * reach the machine, the dialled address becomes the record's address, so
   * the fallback tracks the DHCP lease instead of a stale one.
   */
  updateHost: boolean
  /** Sweep the local subnet when the neighbour table has no mapping. */
  sweep: boolean
  /** How long a resolved address is reused (ms). */
  ttlMs: number
  /** How long a failed resolution is remembered before retrying (ms). */
  negativeTtlMs: number
  /** Port probed to tell same-MAC addresses apart, and to refresh ARP. */
  probePort: number
  /** Per-probe ceiling (ms). */
  probeTimeoutMs: number
  /** Ceiling for one sweep phase (ms). */
  sweepTimeoutMs: number
  /** Probes in flight during a sweep. */
  sweepConcurrency: number
  /** Cap on addresses swept per attempt. */
  sweepMaxHosts: number
}

/** Default resolution knobs. */
export const MAC_DEFAULTS: MacOptions = {
  enabled: true,
  learn: true,
  updateHost: true,
  sweep: true,
  ttlMs: 5 * 60_000,
  negativeTtlMs: 30_000,
  probePort: 22,
  probeTimeoutMs: 700,
  sweepTimeoutMs: 6_000,
  sweepConcurrency: 128,
  sweepMaxHosts: 2048,
}

/** Where a resolved address came from. */
export type MacSource = 'configured' | 'cache' | 'neighbor' | 'neighbor-probe' | 'sweep' | 'fallback'

/** One resolution outcome, reported to tools and logs. */
export interface MacResolution {
  alias: string
  /** The normalised hardware address the record carries, when it has one. */
  mac?: string
  /** The address the record holds (the fallback). */
  configuredHost: string
  /** The address to dial. */
  host: string
  /** How {@link host} was chosen. */
  source: MacSource
  /** True when the hardware address produced the address. */
  resolved: boolean
  /** Addresses the neighbour table mapped to the hardware address. */
  candidates: string[]
  /** Subnets probed, when a sweep ran. */
  swept: string[]
  /** Wall-clock cost of the resolution (ms). */
  durationMs: number
  /** Human-readable detail: skip reasons, mismatches, warnings. */
  note?: string
}

/** The fields the resolver needs from a host record. */
export interface MacTarget {
  alias: string
  host: string
  mac?: string
}

interface CacheEntry {
  host: string
  at: number
  ttlMs: number
}

const resolvedCache = new Map<string, CacheEntry>()
/** Failed resolutions: mac → the pause and how many failures produced it. */
interface NegativeEntry { until: number; failures: number }
const negativeCache = new Map<string, NegativeEntry>()
/**
 * Remember a failed resolution, each consecutive failure buying a longer
 * pause. Without the escalation an unreachable machine (a host on another
 * subnet, a laptop that is off) pays a full subnet sweep on every single
 * connect; with it the cost decays to one sweep every few minutes.
 * @param mac - hardware address that could not be resolved.
 * @param opts - resolution knobs.
 */
function markFailed(mac: string, opts: MacOptions): void {
  const previous = negativeCache.get(mac)
  const failures = (previous?.failures ?? 0) + 1
  const window = Math.min(opts.negativeTtlMs * 2 ** Math.min(failures - 1, 5), 10 * 60_000)
  negativeCache.set(mac, { until: Date.now() + window, failures })
}

/**
 * Drop cached resolutions — all of them, or the ones for one hardware
 * address. Called when a host record changes so an edited MAC takes effect
 * immediately instead of after the TTL.
 * @param mac - hardware address to forget; omit to clear everything.
 */
export function invalidateMacCache(mac?: string): void {
  if (mac === undefined) {
    resolvedCache.clear()
    negativeCache.clear()
    return
  }
  resolvedCache.delete(mac)
  negativeCache.delete(mac)
}

/** Only private, non-link-local addresses may be adopted. */
function usableAddress(ip: string): boolean {
  return isPrivateIpv4(ip) && !isSkippedIpv4(ip)
}

/** Unique values, order preserved. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/**
 * Probe candidate addresses of the same hardware address and keep the single
 * live one; zero or several live answers cannot identify the host.
 * @param candidates - addresses sharing one hardware address.
 * @param opts - resolution knobs.
 */
async function disambiguate(candidates: readonly string[], opts: MacOptions): Promise<string | undefined> {
  const probes = await mapLimit(candidates, 8, ip => tcpProbe(ip, opts.probePort, opts.probeTimeoutMs))
  const alive = probes.filter(probe => probe.alive).map(probe => probe.ip)
  return alive.length === 1 ? alive[0] : undefined
}

/** Sweep one address list with a hard wall-clock deadline. */
async function sweepAddresses(addresses: readonly string[], opts: MacOptions): Promise<void> {
  if (addresses.length === 0) return
  let stopped = false
  const timer = setTimeout(() => { stopped = true }, opts.sweepTimeoutMs)
  try {
    await mapLimit(addresses, opts.sweepConcurrency, async (ip) => {
      if (stopped) return
      await tcpProbe(ip, opts.probePort, opts.probeTimeoutMs)
    })
  } finally {
    clearTimeout(timer)
  }
}

/** One in-flight resolution, shared by every caller that needs the same MAC. */
interface CoreResolution {
  host: string
  source: MacSource
  resolved: boolean
  candidates: string[]
  swept: string[]
  durationMs: number
  note?: string
}

/**
 * Resolutions still running, keyed by MAC plus recorded address. Two connects
 * that start together (a cluster fan-out, a tunnel plus an exec) must not
 * sweep the subnet twice; the second waits for the first instead.
 */
const inflight = new Map<string, Promise<CoreResolution>>()

/**
 * Resolve one hardware address. This is the expensive half: it exists so that
 * concurrent callers share a single neighbour-table read and a single sweep.
 * @param mac - normalised hardware address.
 * @param configuredHost - the recorded address, the last resort.
 * @param opts - resolution knobs.
 */
async function resolveEntry(mac: string, configuredHost: string, opts: MacOptions): Promise<CoreResolution> {
  const started = Date.now()
  const base: Omit<CoreResolution, 'host' | 'source' | 'resolved'> = {
    candidates: [],
    swept: [],
    durationMs: 0,
  }

  /** Settle one outcome. */
  const done = (host: string, source: MacSource, resolved: boolean, note?: string): CoreResolution => {
    const result: CoreResolution = { ...base, host, source, resolved, durationMs: Date.now() - started }
    if (note !== undefined) result.note = note
    return result
  }

  const cached = resolvedCache.get(mac)
  if (cached !== undefined && Date.now() - cached.at < cached.ttlMs) {
    return done(cached.host, 'cache', true)
  }
  const negative = negativeCache.get(mac)
  if (negative !== undefined && negative.until > Date.now()) {
    return done(configuredHost, 'fallback', false, 'recent resolution failed; retrying after the negative-cache window')
  }

  let table = await readNeighborTable()
  let candidates = unique((table.byMac.get(mac) ?? []).filter(usableAddress))

  if (candidates.length === 1) {
    base.candidates = candidates
    resolvedCache.set(mac, { host: candidates[0]!, at: Date.now(), ttlMs: opts.ttlMs })
    negativeCache.delete(mac)
    return done(candidates[0]!, 'neighbor', true)
  }
  if (candidates.length > 1) {
    base.candidates = candidates
    const alive = await disambiguate(candidates, opts)
    if (alive !== undefined) {
      resolvedCache.set(mac, { host: alive, at: Date.now(), ttlMs: opts.ttlMs })
      negativeCache.delete(mac)
      return done(alive, 'neighbor-probe', true, 'several addresses shared the MAC; picked the one answering on port ' + opts.probePort)
    }
    return done(configuredHost, 'fallback', false, 'several addresses shared the MAC and none answered uniquely')
  }

  const notes: string[] = []
  if (table.error !== undefined) notes.push(table.error)

  if (!opts.sweep) {
    markFailed(mac, opts)
    return done(configuredHost, 'fallback', false, ['no neighbour entry for the MAC', 'sweep disabled', ...notes].join('; '))
  }

  // A public recorded address means the machine is reached across the
  // internet, which no local-subnet sweep can see; sweeping would only add
  // seconds to every connect (MAC-SSH.md: "HostName 是公网则不扫").
  if (!isPrivateIpv4(configuredHost)) {
    markFailed(mac, opts)
    return done(configuredHost, 'fallback', false, ['recorded address ' + configuredHost + ' is not private', 'skipped the local sweep', ...notes].join('; '))
  }

  // Sweep: the machine's own networks bound the search. When the recorded
  // address still lives on one of them, that network alone is enough.
  const networks = localIpv4Networks()
  let windows = unique(networks.map(sweepCidrFor))
  if (isPrivateIpv4(configuredHost)) {
    const recorded = windows.filter(cidr => inCidr(configuredHost, cidr))
    if (recorded.length > 0) windows = recorded
  }
  const own = new Set(networks.map(network => network.address))
  const addresses = unique(windows.flatMap(cidr => cidrHosts(cidr, opts.sweepMaxHosts)))
    .filter(ip => !own.has(ip) && !isSkippedIpv4(ip))
  base.swept = windows

  if (addresses.length === 0) {
    markFailed(mac, opts)
    return done(configuredHost, 'fallback', false, ['no local IPv4 network to sweep', ...notes].join('; '))
  }

  await sweepAddresses(addresses, opts)
  table = await readNeighborTable()
  candidates = unique((table.byMac.get(mac) ?? []).filter(usableAddress))
  base.candidates = candidates
  if (candidates.length === 1) {
    resolvedCache.set(mac, { host: candidates[0]!, at: Date.now(), ttlMs: opts.ttlMs })
    negativeCache.delete(mac)
    return done(candidates[0]!, 'sweep', true, 'found after sweeping ' + windows.join(', '))
  }
  if (candidates.length > 1) {
    const alive = await disambiguate(candidates, opts)
    if (alive !== undefined) {
      resolvedCache.set(mac, { host: alive, at: Date.now(), ttlMs: opts.ttlMs })
      negativeCache.delete(mac)
      return done(alive, 'neighbor-probe', true, 'found after sweeping; several addresses answered, picked port ' + opts.probePort)
    }
  }

  markFailed(mac, opts)
  return done(configuredHost, 'fallback', false, ['MAC not found on ' + windows.join(', '), ...notes].join('; '))
}

/**
 * Resolve the address to dial for one record.
 *
 * The order is deliberate: a cached answer avoids a probe storm on repeated
 * connects; the neighbour table is a single cheap process call; the sweep is
 * expensive and only runs when nothing else matched; the configured address
 * stays the last resort so a wrong MAC can never make a host unreachable.
 *
 * @param target - the host record (alias, configured address, hardware address).
 * @param opts - resolution knobs.
 * @returns the resolution outcome; `host` is always dialable.
 */
export async function resolveMacTarget(target: MacTarget, opts: MacOptions): Promise<MacResolution> {
  const started = Date.now()
  const configuredHost = target.host
  const mac = sanitizeMac(target.mac)
  const result: MacResolution = {
    alias: target.alias,
    configuredHost,
    host: configuredHost,
    source: 'configured',
    resolved: false,
    candidates: [],
    swept: [],
    durationMs: 0,
  }
  if (mac !== undefined) result.mac = mac

  if (!opts.enabled || mac === undefined) {
    if (mac === undefined && opts.enabled) result.note = 'no MAC recorded for this host'
    return result
  }

  const key = mac + '@' + configuredHost
  let pending = inflight.get(key)
  if (pending === undefined) {
    const created = resolveEntry(mac, configuredHost, opts)
    pending = created
    inflight.set(key, created)
    void created.finally(() => { if (inflight.get(key) === created) inflight.delete(key) }).catch(() => undefined)
  }
  const core = await pending
  result.host = core.host
  result.source = core.source
  result.resolved = core.resolved
  result.candidates = [...core.candidates]
  result.swept = [...core.swept]
  result.durationMs = Date.now() - started
  if (core.note !== undefined) result.note = core.note
  return result
}

/** What a successful connect taught the store. */
export interface RecordedIdentity {
  /** The hardware address seen at the dialled address, when the table had one. */
  mac?: string
  /** The address written into the record, when it changed. */
  host?: string
}

/** The slice of the store this module needs; keeps the resolver testable. */
export interface IdentityStore {
  find(alias: string): { host: string; mac?: string } | undefined
  update(alias: string, patch: { host?: string; mac?: string }): unknown
}

/**
 * Write back what a successful connection proved: the address the machine
 * answered on, and — when the record carries no hardware address yet — the
 * hardware address behind that address.
 *
 * Both writes are deliberately narrow. The address is only rewritten when it
 * differs and is usable on this network, so a fallback connect (which dials
 * the recorded address) never rewrites anything. A recorded MAC is never
 * replaced: a mismatch means the record is wrong or the address was recycled,
 * and silently adopting it would follow a stranger. The MAC is only learned
 * when the neighbour table already knows the address, because at this point
 * the connection is established and `arp -a` has the entry for free.
 *
 * @param store - the host store.
 * @param alias - the connected record.
 * @param address - the address the connection went to.
 * @param opts - resolution knobs.
 * @returns what was recorded, if anything.
 */
export async function recordConnectionIdentity(
  store: IdentityStore,
  alias: string,
  address: string,
  opts: MacOptions,
): Promise<RecordedIdentity | undefined> {
  const entry = store.find(alias)
  if (entry === undefined) return undefined
  const recorded: RecordedIdentity = {}
  const patch: { host?: string; mac?: string } = {}

  if (opts.updateHost && entry.host !== address && usableAddress(address)) {
    patch.host = address
    recorded.host = address
  }

  if (opts.learn && usableAddress(address)) {
    const table = await readNeighborTable()
    const mac = table.byIp.get(address)
    if (mac !== undefined) {
      recorded.mac = mac
      if (entry.mac === undefined) patch.mac = mac
      else if (entry.mac !== mac) console.warn('[dsh-ssh-mac] ' + alias + ': recorded MAC ' + entry.mac + ' does not match ' + mac + ' seen at ' + address)
    }
  }

  if (patch.host === undefined && patch.mac === undefined) return recorded
  try {
    store.update(alias, patch)
    const parts: string[] = []
    if (patch.mac !== undefined) parts.push('MAC ' + patch.mac)
    if (patch.host !== undefined) parts.push('address ' + patch.host)
    console.info('[dsh-ssh-mac] ' + alias + ': recorded ' + parts.join(' and ') + ' from ' + address)
  } catch (error) {
    console.warn('[dsh-ssh-mac] ' + alias + ': could not record ' + address + ': ' + describe(error))
  }
  return recorded
}

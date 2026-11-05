/**
 * The IPv6 neighbour table (neighbour discovery), read through the platform
 * tool. A LAN that hands out IPv6 link-local addresses only still exposes the
 * hardware address here, which is what MAC-first resolution needs when ARP has
 * nothing left to show.
 */

import { execFile } from 'node:child_process'
import { isUnicastMac, normalizeMac } from './mac-address.ts'

/** One neighbour discovery cache entry. */
export interface Neighbor6Entry {
  /** Zone-qualified address: `fe80::1%12` on Windows, `fe80::1%wlan0` elsewhere. */
  ip: string
  /** Normalised hardware address. */
  mac: string
  /** Interface index (Windows) or interface name (Linux, macOS). */
  zone: string
  /** The state the platform printed, verbatim. */
  state: string
}

/** One parsed IPv6 neighbour table. */
export interface NeighborTable6 {
  /** Every usable entry, in platform order. */
  entries: Neighbor6Entry[]
  /** Hardware address → its entries. */
  byMac: Map<string, Neighbor6Entry[]>
  /** Which source produced the table. */
  source: 'powershell' | 'ip-neigh' | 'ndp' | 'none'
  /** Why the table could not be read, when it could not. */
  error?: string
}

/** States that mean the platform has no confirmed layer-two path. */
const DEAD_STATES = new Set(['unreachable', 'incomplete', 'failed', 'permanent'])

/**
 * Run a platform command and return stdout, or undefined on any failure.
 * @param file - executable.
 * @param args - arguments.
 * @param timeoutMs - hard ceiling for the child process.
 */
function run(file: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        resolve(error === null ? stdout : undefined)
      })
    } catch {
      resolve(undefined)
    }
  })
}

/** An empty table. */
export function emptyNeighborTable6(source: NeighborTable6['source'], error?: string): NeighborTable6 {
  return error === undefined ? { entries: [], byMac: new Map(), source } : { entries: [], byMac: new Map(), source, error }
}

/**
 * Record one row, dropping what cannot identify a LAN peer.
 * @param table - table being built.
 * @param address - address as printed.
 * @param zone - interface index or name.
 * @param rawMac - hardware address as printed.
 * @param state - neighbour state as printed.
 */
function addEntry(table: NeighborTable6, address: string, zone: string, rawMac: string, state: string): void {
  const normalised = state.trim().toLowerCase()
  if (DEAD_STATES.has(normalised)) return
  const mac = normalizeMac(rawMac)
  if (mac === undefined || !isUnicastMac(mac)) return
  const printed = address.trim()
  if (printed === '') return
  const ip = printed.includes('%') || zone === '' ? printed : printed + '%' + zone
  const entry: Neighbor6Entry = { ip, mac, zone: zone.trim(), state: state.trim() }
  table.entries.push(entry)
  const list = table.byMac.get(mac)
  if (list === undefined) table.byMac.set(mac, [entry])
  else list.push(entry)
}

/**
 * Parse the pipe-delimited rows produced by the PowerShell probe.
 * @param text - `ip|mac|interfaceIndex|state` per line.
 * @param table - table being built.
 */
function parseDelimited(text: string, table: NeighborTable6): void {
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split('|')
    if (parts.length < 4) continue
    addEntry(table, parts[0]!, parts[2]!, parts[1]!, parts[3]!)
  }
}

/**
 * Parse `ip -6 neigh show` output.
 * @param text - command output.
 * @param table - table being built.
 */
function parseIpNeigh6(text: string, table: NeighborTable6): void {
  for (const line of text.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/)
    if (tokens.length < 4) continue
    const address = tokens[0]!
    if (!address.includes(':')) continue
    const devAt = tokens.indexOf('dev')
    const lladdrAt = tokens.indexOf('lladdr')
    if (devAt < 0 || lladdrAt < 0) continue
    addEntry(table, address, tokens[devAt + 1] ?? '', tokens[lladdrAt + 1] ?? '', tokens[tokens.length - 1] ?? '')
  }
}

/**
 * Parse `ndp -an` output on macOS.
 * @param text - command output.
 * @param table - table being built.
 */
function parseNdp(text: string, table: NeighborTable6): void {
  for (const line of text.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/)
    if (tokens.length < 3) continue
    const address = tokens[0]!
    if (!address.includes(':')) continue
    addEntry(table, address, tokens[2] ?? '', tokens[1] ?? '', tokens.slice(3).join(' '))
  }
}

/** The PowerShell probe: optionally ping all-nodes first, then dump the cache. */
function powershellScript(discover: boolean): string {
  const ping = discover ? '$true' : '$false'
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$discover = ' + ping,
    'if ($discover) {',
    '  $idx = Get-NetIPAddress -AddressFamily IPv6 | Where-Object { $_.IPAddress -like "fe80*" } | Select-Object -ExpandProperty InterfaceIndex -Unique',
    '  foreach ($i in $idx) { ping -6 -n 1 -w 200 "ff02::1%$i" | Out-Null }',
    '}',
    'Get-NetNeighbor -AddressFamily IPv6 | Where-Object { $_.LinkLayerAddress -match "-" } | ForEach-Object { "$($_.IPAddress)|$($_.LinkLayerAddress)|$($_.InterfaceIndex)|$($_.State)" }',
  ].join('\n')
}

/**
 * Read the IPv6 neighbour cache.
 * @param options - `discover` pings the all-nodes multicast group first, which
 * populates the cache on an otherwise quiet LAN.
 * @param timeoutMs - ceiling for the platform command.
 */
export async function readNeighborTable6(
  options: { discover?: boolean; timeoutMs?: number } = {},
): Promise<NeighborTable6> {
  const discover = options.discover === true
  const timeoutMs = options.timeoutMs ?? (discover ? 4_000 : 5_000)

  if (process.platform === 'win32') {
    const text = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', powershellScript(discover)], timeoutMs)
    if (text === undefined) return emptyNeighborTable6('none', 'powershell could not read the IPv6 neighbour cache')
    const table = emptyNeighborTable6('powershell')
    parseDelimited(text, table)
    return table
  }

  if (process.platform === 'darwin') {
    const text = await run('ndp', ['-an'], timeoutMs)
    if (text === undefined) return emptyNeighborTable6('none', 'ndp could not read the IPv6 neighbour cache')
    const table = emptyNeighborTable6('ndp')
    parseNdp(text, table)
    return table
  }

  const text = await run('ip', ['-6', 'neigh', 'show'], timeoutMs)
  if (text === undefined) return emptyNeighborTable6('none', 'ip -6 neigh could not read the IPv6 neighbour cache')
  const table = emptyNeighborTable6('ip-neigh')
  parseIpNeigh6(text, table)
  return table
}

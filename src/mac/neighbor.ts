/**
 * The machine's neighbour (ARP) table, read through the platform tool. This
 * is the cheap first lookup of MAC-first resolution: a host that talked to
 * this machine recently is already mapped from hardware address to address.
 */

import { execFile, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isUnicastMac, normalizeMac } from './mac-address.ts'

/** One parsed neighbour table. */
export interface NeighborTable {
  /** Hardware address → the addresses currently mapped to it. */
  byMac: Map<string, string[]>
  /** Address → hardware address. */
  byIp: Map<string, string>
  /** Which source produced the table. */
  source: 'arp' | 'ip-neigh' | 'proc-arp' | 'none'
  /** Why the table could not be read, when it could not. */
  error?: string
}

/** An empty table. */
export function emptyNeighborTable(source: NeighborTable['source'], error?: string): NeighborTable {
  return error === undefined ? { byMac: new Map(), byIp: new Map(), source } : { byMac: new Map(), byIp: new Map(), source, error }
}

/**
 * Run a platform command and return stdout, or undefined on any failure.
 * @param file - executable.
 * @param args - arguments.
 * @param timeoutMs - hard ceiling for the child process.
 */
function run(file: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error !== null && (stdout === undefined || stdout === '')) {
        resolve(undefined)
        return
      }
      resolve(stdout)
    })
  })
}

/** Add one address/hardware pair, ignoring junk and non-unicast addresses. */
function add(table: NeighborTable, ip: string, rawMac: string): void {
  const mac = normalizeMac(rawMac)
  if (mac === undefined || !isUnicastMac(mac)) return
  const octets = ip.split('.').map(Number)
  if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return
  if (octets[0] === 0 || octets[0] >= 224) return
  table.byIp.set(ip, mac)
  const list = table.byMac.get(mac)
  if (list === undefined) table.byMac.set(mac, [ip])
  else if (!list.includes(ip)) list.push(ip)
}

/**
 * Parse `arp -a` output, which Windows and macOS both print as address /
 * hardware pairs in either order (macOS wraps the address in parentheses and
 * the hardware address may be `(incomplete)`).
 * @param text - command output.
 * @param table - the table to fill.
 */
function parseArp(text: string, table: NeighborTable): void {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('Interface') || trimmed.startsWith('接口')) continue
    const ip = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(trimmed)
    const mac = /([0-9a-fA-F]{2}(?:[-:.][0-9a-fA-F]{2}){5})/.exec(trimmed)
    if (ip === null || mac === null) continue
    add(table, ip[1]!, mac[1]!)
  }
}

/** Parse `ip -4 neigh show` output: `<ip> dev <if> lladdr <mac> <STATE>`. */
function parseIpNeigh(text: string, table: NeighborTable): void {
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\d{1,3}(?:\.\d{1,3}){3})\s+dev\s+\S+.*\blladdr\s+([0-9a-fA-F:]{17})/i.exec(line.trim())
    if (match === null) continue
    add(table, match[1]!, match[2]!)
  }
}

/** Parse `/proc/net/arp`: `<ip> <hwtype> <flags> <mac> <mask> <dev>`. */
function parseProcArp(text: string, table: NeighborTable): void {
  for (const line of text.split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 4) continue
    add(table, fields[0]!, fields[3]!)
  }
}

/**
 * Read the platform neighbour table.
 * @param timeoutMs - ceiling for the platform command.
 * @returns the parsed table; `source` is 'none' when nothing could be read.
 */
export async function readNeighborTable(timeoutMs = 4_000): Promise<NeighborTable> {
  const table = emptyNeighborTable('none')
  if (process.platform === 'win32') {
    const text = await run('arp', ['-a'], timeoutMs)
    if (text === undefined) return emptyNeighborTable('none', 'arp -a failed')
    table.source = 'arp'
    parseArp(text, table)
    return table
  }
  if (process.platform === 'darwin') {
    const text = await run('arp', ['-an'], timeoutMs)
    if (text === undefined) return emptyNeighborTable('none', 'arp -an failed')
    table.source = 'arp'
    parseArp(text, table)
    return table
  }
  const neigh = await run('ip', ['-4', 'neigh', 'show'], timeoutMs)
  if (neigh !== undefined && neigh.trim() !== '') {
    table.source = 'ip-neigh'
    parseIpNeigh(neigh, table)
    if (table.byIp.size > 0) return table
  }
  try {
    const proc = await readFile('/proc/net/arp', 'utf8')
    table.source = 'proc-arp'
    parseProcArp(proc, table)
    return table
  } catch (error) {
    return emptyNeighborTable(neigh === undefined ? 'none' : table.source, 'no neighbour table: ' + describe(error))
  }
}

/**
 * Read the neighbour table synchronously, for the one moment that cannot
 * wait: adding a host to the list. The address being added is usually still
 * in the table from a recent ssh, ping or GUI session, and reading it then is
 * what makes a new record MAC-first from its very first connect instead of
 * after the first successful one.
 *
 * Every failure is silence by design — a missing table must never stop a host
 * from being added.
 *
 * @param timeoutMs - ceiling for the platform command.
 * @returns the parsed table; empty with `source` 'none' when unreadable.
 */
export function readNeighborTableSync(timeoutMs = 2_000): NeighborTable {
  const table = emptyNeighborTable('none')
  const command = process.platform === 'darwin' ? ['arp', ['-an']] as const : ['arp', ['-a']] as const
  if (process.platform === 'win32' || process.platform === 'darwin') {
    try {
      const text = execFileSync(command[0], [...command[1]], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' })
      table.source = 'arp'
      parseArp(text, table)
      return table
    } catch {
      return emptyNeighborTable('none', 'arp failed')
    }
  }
  try {
    const neigh = execFileSync('ip', ['-4', 'neigh', 'show'], { timeout: timeoutMs, encoding: 'utf8' })
    table.source = 'ip-neigh'
    parseIpNeigh(neigh, table)
    if (table.byIp.size > 0) return table
  } catch {
    // Fall through to /proc/net/arp.
  }
  try {
    table.source = 'proc-arp'
    parseProcArp(readFileSync('/proc/net/arp', 'utf8'), table)
    return table
  } catch {
    return emptyNeighborTable('none', 'no neighbour table')
  }
}

/** One-line error text. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

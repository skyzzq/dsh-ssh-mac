/**
 * IPv4 helpers for MAC-first resolution: address arithmetic, the subnet
 * policy from MAC-SSH.md (private ranges only, local prefixes only, the
 * always-skipped ranges), and the machine's own IPv4 networks.
 */

import { networkInterfaces } from 'node:os'
import { formatEndpoint, isIpv6Address, isLinkLocalIpv6, splitZone } from './net-format.ts'

/** One of the machine's own IPv4 networks. */
export interface LocalIpv4Network {
  /** Interface name (`WLAN`, `eth0`, ...). */
  name: string
  /** The interface's own address. */
  address: string
  /** Dotted netmask. */
  netmask: string
  /** Prefix length (0-32). */
  prefix: number
  /** Network address in CIDR form (`192.168.1.0/24`). */
  cidr: string
}

/**
 * Convert a dotted IPv4 address to its 32-bit unsigned value.
 * @param ip - dotted quad.
 * @returns the integer, or undefined when the string is not IPv4.
 */
export function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = value * 256 + octet
  }
  return value >>> 0
}

/**
 * Convert a 32-bit unsigned value back to a dotted IPv4 address.
 * @param value - the integer.
 */
export function intToIpv4(value: number): string {
  const n = value >>> 0
  return [n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.')
}

/**
 * Whether an address is inside a CIDR block.
 * @param ip - dotted quad.
 * @param cidr - network in `a.b.c.d/len` form.
 */
export function inCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/')
  if (slash < 0) return false
  const base = ipv4ToInt(cidr.slice(0, slash))
  const value = ipv4ToInt(ip)
  const prefix = Number(cidr.slice(slash + 1))
  if (base === undefined || value === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
  if (prefix === 0) return true
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0
  return (base & mask) >>> 0 === (value & mask) >>> 0
}

/**
 * Whether an address is RFC1918 private — the only space a hardware address
 * is allowed to resolve into, so a recorded MAC can never redirect a public
 * host record into an unrelated public address.
 * @param ip - dotted quad.
 */
export function isPrivateIpv4(ip: string): boolean {
  return inCidr(ip, '10.0.0.0/8') || inCidr(ip, '172.16.0.0/12') || inCidr(ip, '192.168.0.0/16')
}

/** Ranges that never host a resolvable LAN peer (MAC-SSH.md skip list). */
const SKIPPED_RANGES = ['0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '198.18.0.0/15', '100.64.0.0/10']

/**
 * Whether an address belongs to a range the sweep must leave alone:
 * "this host", link-local, benchmark space and carrier-grade NAT.
 * @param ip - dotted quad.
 */
export function isSkippedIpv4(ip: string): boolean {
  return SKIPPED_RANGES.some(range => inCidr(ip, range))
}

/**
 * The machine's own non-loopback IPv4 networks, which bound any sweep.
 * @returns one entry per address, in interface order.
 */
export function localIpv4Networks(): LocalIpv4Network[] {
  const networks: LocalIpv4Network[] = []
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const info of addresses ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      const ip = ipv4ToInt(info.address)
      const mask = ipv4ToInt(info.netmask)
      if (ip === undefined || mask === undefined) continue
      let prefix = 0
      for (let bit = 0; bit < 32; bit += 1) {
        if ((mask >>> (31 - bit)) & 1) prefix += 1
        else break
      }
      const network = (ip & mask) >>> 0
      networks.push({
        name,
        address: info.address,
        netmask: info.netmask,
        prefix,
        cidr: intToIpv4(network) + '/' + prefix,
      })
    }
  }
  return networks
}

/**
 * The sweep window for one local network: the real prefix while it is narrow
 * enough (/22 or longer), otherwise the /24 the address sits in. A /16 office
 * VLAN would otherwise cost 65 534 probes per attempt.
 * @param network - one of the machine's networks.
 */
export function sweepCidrFor(network: LocalIpv4Network): string {
  if (network.prefix >= 22) return network.cidr
  const ip = ipv4ToInt(network.address)
  if (ip === undefined) return network.cidr
  return intToIpv4(ip & 0xffffff00) + '/24'
}

/**
 * Every usable host address in a CIDR block (network and broadcast excluded
 * for prefixes up to /30), capped so one oversized range cannot stall a
 * connect attempt.
 * @param cidr - network in `a.b.c.d/len` form.
 * @param cap - maximum addresses to return.
 */
export function cidrHosts(cidr: string, cap = 2048): string[] {
  const slash = cidr.indexOf('/')
  if (slash < 0) return []
  const base = ipv4ToInt(cidr.slice(0, slash))
  const prefix = Number(cidr.slice(slash + 1))
  if (base === undefined || !Number.isInteger(prefix) || prefix < 16 || prefix > 32) return []
  const size = 2 ** (32 - prefix)
  const first = prefix >= 31 ? base : base + 1
  const last = prefix >= 31 ? base + size - 1 : base + size - 2
  const hosts: string[] = []
  for (let value = first; value <= last && hosts.length < cap; value += 1) hosts.push(intToIpv4(value))
  return hosts
}

/**
 * Whether a LAN sweep or neighbour lookup can reach this recorded address at
 * all: a private IPv4 address or an IPv6 link-local one. A public address is
 * reached across the internet, where no hardware address is observable.
 * @param host - recorded address.
 */
export function isLocalDialAddress(host: string): boolean {
  if (isIpv6Address(host)) return isLinkLocalIpv6(host)
  return isPrivateIpv4(host)
}

export { formatEndpoint, isIpv6Address, isLinkLocalIpv6, splitZone }

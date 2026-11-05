/**
 * Address and endpoint formatting shared by the host and the browser halves of
 * the plugin. Nothing here touches node: APIs, so the client bundle can import
 * it without dragging `node:os` into the browser build.
 */

/**
 * Split a zone-qualified IPv6 literal into the address and its zone. A zone
 * is an interface index on Windows (`fe80::1%12`) and an interface name on
 * Linux and macOS (`fe80::1%wlan0`).
 * @param host - address, possibly zone-qualified.
 */
export function splitZone(host: string): { address: string; zone?: string } {
  const trimmed = host.trim()
  const percent = trimmed.lastIndexOf('%')
  if (percent <= 0) return { address: trimmed }
  return { address: trimmed.slice(0, percent), zone: trimmed.slice(percent + 1) }
}

/**
 * Whether a recorded address is an IPv6 literal.
 * @param host - address, possibly zone-qualified.
 */
export function isIpv6Address(host: string): boolean {
  return splitZone(host).address.includes(':')
}

/**
 * Whether an address is IPv6 link-local (`fe80::/10`) — the only IPv6 range a
 * hardware address can resolve into on a LAN.
 * @param host - address, possibly zone-qualified.
 */
export function isLinkLocalIpv6(host: string): boolean {
  const { address } = splitZone(host)
  if (!address.includes(':')) return false
  const first = address.split(':')[0] ?? ''
  if (first === '') return false
  const value = Number.parseInt(first, 16)
  return Number.isFinite(value) && value >= 0xfe80 && value <= 0xfebf
}

/**
 * Render `host:port`, bracketing IPv6 literals the way a URL or ssh does.
 * @param host - address.
 * @param port - port number.
 */
export function formatEndpoint(host: string, port: number): string {
  const trimmed = host.trim()
  return trimmed.includes(':') ? '[' + trimmed + ']:' + port : trimmed + ':' + port
}

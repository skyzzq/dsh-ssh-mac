/**
 * MAC address normalisation. Hosts are keyed by hardware address so a DHCP
 * lease change (the reason this plugin exists) does not break the alias.
 */

/** Anything that is not a hex digit: `-`, `:`, `.`, spaces and stray labels. */
const NON_HEX = /[^0-9a-f]/g

/**
 * Canonicalise a MAC address to lowercase colon form (`aa:bb:cc:dd:ee:ff`).
 * Accepts the Windows (`aa-bb-cc-dd-ee-ff`) and Cisco (`aabb.ccdd.eeff`)
 * spellings too, because they are what `arp -a` and switch listings print.
 * @param raw - the candidate string.
 * @returns the canonical form, or undefined when it is not a MAC address.
 */
export function normalizeMac(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string') return undefined
  const hex = raw.trim().toLowerCase().replace(NON_HEX, '')
  if (hex.length !== 12) return undefined
  const octets: string[] = []
  for (let index = 0; index < 12; index += 2) octets.push(hex.slice(index, index + 2))
  return octets.join(':')
}

/**
 * Whether a normalised MAC can identify a host: all-zero (unset), broadcast
 * and multicast addresses (the group bit is octal 01) never do.
 * @param mac - a normalised MAC address.
 */
export function isUnicastMac(mac: string): boolean {
  if (mac === '00:00:00:00:00:00' || mac === 'ff:ff:ff:ff:ff:ff') return false
  const first = Number.parseInt(mac.slice(0, 2), 16)
  if (!Number.isFinite(first)) return false
  // The least significant bit of the first octet marks group addresses.
  return (first & 0x01) === 0
}

/** Normalise and vet in one step; the value the store accepts. */
export function sanitizeMac(raw: string | undefined | null): string | undefined {
  const mac = normalizeMac(raw)
  return mac !== undefined && isUnicastMac(mac) ? mac : undefined
}

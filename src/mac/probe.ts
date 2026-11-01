/**
 * Liveness probes used when one hardware address maps to several addresses.
 * A TCP connect attempt is enough: the kernel resolves the hardware address
 * before the SYN leaves the interface, so the probe also refreshes the
 * neighbour table entry the resolver is about to read again.
 */

import { connect } from 'node:net'

/** Result of one probe. */
export interface ProbeResult {
  ip: string
  alive: boolean
  /** Milliseconds until the probe settled. */
  elapsedMs: number
}

/**
 * Attempt a TCP connection; resolve true when it is accepted, false on any
 * error or timeout. The socket is destroyed either way.
 * @param ip - peer address.
 * @param port - peer port.
 * @param timeoutMs - per-probe ceiling.
 */
export function tcpProbe(ip: string, port: number, timeoutMs: number): Promise<ProbeResult> {
  const started = Date.now()
  return new Promise(resolve => {
    let settled = false
    const socket = connect({ host: ip, port })
    const finish = (alive: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ip, alive, elapsedMs: Date.now() - started })
    }
    socket.setTimeout(timeoutMs, () => { finish(false) })
    socket.once('connect', () => { finish(true) })
    socket.once('error', () => { finish(false) })
  })
}

/**
 * Run an async function over items with bounded concurrency.
 * @param items - the work items.
 * @param limit - maximum in flight.
 * @param fn - the worker.
 * @returns results in input order.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await fn(items[index]!, index)
    }
  })
  await Promise.all(workers)
  return results
}

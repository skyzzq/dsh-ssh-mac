/**
 * Host-side probe: open a PTY over the plugin's own WebSocket and type
 * `cd /u` + Tab, so we can tell whether the remote shell completes paths and
 * whether the host forwards the 0x09 byte. If completion shows up here, the
 * browser half is what drops the key.
 *
 * Usage: node scratch/probe-tab.mjs [alias] [port]
 */
import WebSocket from 'ws'

const alias = process.argv[2] ?? 'chx-A100'
const port = process.argv[3] ?? '62583'
const url = `ws://127.0.0.1:${port}/api/dsh-ssh/terminal?alias=${encodeURIComponent(alias)}&cols=120&rows=30`

const socket = new WebSocket(url)
let output = ''

const send = data => socket.send(JSON.stringify({ type: 'input', data }))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

socket.on('message', raw => {
  let frame
  try { frame = JSON.parse(raw.toString()) } catch { return }
  if (frame.type === 'output' && typeof frame.data === 'string') output += frame.data
  if (frame.type === 'ready') console.log('[ready] session', frame.sessionId)
  if (frame.type === 'auth') console.log('[auth prompt]', JSON.stringify(frame.prompt?.name ?? frame))
  if (frame.type === 'exit') console.log('[exit]', JSON.stringify(frame))
})

socket.on('open', async () => {
  await wait(2500)
  send('cd /u')
  await wait(400)
  send('\t')
  await wait(900)
  send('\t')
  await wait(900)
  send('\u0003')          // ^C so the probe never leaves a half-typed command
  await wait(300)
  const tail = output.slice(-1200)
  console.log('--- tail ---')
  console.log(JSON.stringify(tail))
  console.log('--- rendered ---')
  console.log(tail.replace(/\r/g, ''))
  console.log('--- verdict ---')
  console.log('single /u candidate (usr):', /cd \/usr/.test(tail))
  socket.send(JSON.stringify({ type: 'close' }))
  await wait(300)
  socket.close()
  process.exit(0)
})

socket.on('error', error => { console.error('ws error:', error.message); process.exit(1) })
setTimeout(() => { console.error('timeout'); process.exit(1) }, 20000)

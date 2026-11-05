const net = require('node:net');
function probe(ip, port, ms) {
  return new Promise((res) => {
    const s = new net.Socket(); let done = false;
    const fin = (v) => { if (!done) { done = true; s.destroy(); res(v); } };
    s.setTimeout(ms); s.once('connect', () => fin(true)); s.once('timeout', () => fin(false));
    s.once('error', () => fin(false)); s.connect(port, ip);
  });
}
async function sweep(prefix, tag) {
  const ips = []; for (let i = 1; i <= 254; i++) ips.push(prefix + i);
  let idx = 0; const open = [];
  await Promise.all(Array.from({ length: 128 }, async () => {
    while (idx < ips.length) { const ip = ips[idx++]; if (await probe(ip, 22, 600)) open.push(ip); }
  }));
  console.log(tag, 'port22 open:', open.join(' ') || '(none)');
}
(async () => {
  const t = Date.now();
  await Promise.all([sweep('10.147.1.', 'wlan 10.147.1.0/24'), sweep('192.168.71.', 'eth 192.168.71.0/24')]);
  console.log('elapsed', Date.now() - t, 'ms');
})();

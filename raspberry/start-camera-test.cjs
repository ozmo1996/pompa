// Nietrwaly test: haslo kamery tylko w pamieci go2rtc, bez wpisywania go do plikow.
const fs = require('node:fs');
const child = require('node:child_process');
const net = require('node:net');
const dir = '/home/pi/pompa-kamery-test';
async function portFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
function start(name, executable, args, env = {}) {
  const log = fs.openSync(dir + '/' + name + '.log', 'a', 0o600);
  const proc = child.spawn('nice', ['-n', '19', executable, ...args], {
    cwd: dir, detached: true, stdio: ['ignore', log, log], env: { PATH: process.env.PATH, HOME: '/home/pi', ...env }
  });
  proc.unref(); fs.closeSync(log);
  fs.writeFileSync(dir + '/' + name + '.pid', String(proc.pid), { mode: 0o600, flag: 'wx' });
  return proc.pid;
}
(async () => {
  if (process.platform !== 'linux') throw new Error('Wylacznie Raspberry Linux');
  if (!process.env.CAMERA_TEST_PASSWORD) throw new Error('Brak hasla w pamieci. Nie podawaj go jako argument polecenia.');
  if ((fs.statSync(dir).mode & 0o077) !== 0) throw new Error('Katalog testowy musi miec prawa 0700');
  for (const name of ['go2rtc.pid', 'gateway.pid', 'go2rtc.yaml', 'gateway.json', 'camera-gateway.cjs'])
    if (fs.existsSync(dir + '/' + name)) throw new Error('Istnieje poprzedni test: ' + name + '. Nie nadpisuje go.');
  await portFree(1984); await portFree(1986);
  const adminModule = require.resolve('firebase-admin', { paths: ['/home/pi/pompa-alarmy'] });
  const serviceAccount = '/home/pi/pompa-alarmy/serviceAccount.json';
  fs.accessSync(serviceAccount, fs.constants.R_OK);
  const response = await fetch('https://raw.githubusercontent.com/ozmo1996/pompa/dc452a5/raspberry/camera-gateway.js', { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Nie pobrano bramki');
  fs.writeFileSync(dir + '/camera-gateway.cjs', await response.text(), { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(dir + '/go2rtc.yaml', JSON.stringify({ api: { listen: '127.0.0.1:1984' }, rtsp: { listen: '' }, webrtc: { listen: '' }, log: { level: 'panic' }, streams: { kamera_test: '${CAMERA_TEST_URL}' } }), { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(dir + '/gateway.json', JSON.stringify({ adminModule, serviceAccount,
    allowedOrigin: 'https://ozmo1996.github.io', databaseURL: 'https://pompa-bdd30-default-rtdb.europe-west1.firebasedatabase.app',
    streamUrl: 'http://127.0.0.1:1984/api/stream.mp4?src=kamera_test&video=h264', mime: 'video/mp4; codecs="avc1.4D0033"'
  }), { mode: 0o600, flag: 'wx' });
  const url = 'rtsp://admin:' + encodeURIComponent(process.env.CAMERA_TEST_PASSWORD) + '@192.168.1.168:554/cam/realmonitor?channel=1&subtype=1';
  delete process.env.CAMERA_TEST_PASSWORD;
  const goPid = start('go2rtc', dir + '/go2rtc', ['-config', dir + '/go2rtc.yaml'], { CAMERA_TEST_URL: url });
  const gatewayPid = start('gateway', process.execPath, [dir + '/camera-gateway.cjs'], { CAMERA_GATEWAY_CONFIG: dir + '/gateway.json' });
  console.log('TEST_URUCHOMIONY', { go2rtcPid: goPid, gatewayPid });
  console.log('Haslo nie zostalo zapisane w plikach. Po restarcie Raspberry test wymaga ponownego uruchomienia.');
})().catch((error) => { console.error('START_TESTU_PRZERWANY', error.message); process.exitCode = 1; });

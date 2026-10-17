// Przelacza tylko testowy go2rtc miedzy potwierdzonym lekkim (1) i HD (2) strumieniem.
const fs = require('node:fs');
const child = require('node:child_process');
const dir = '/home/pi/pompa-kamery-test';
(async () => {
  const profile = process.argv[2];
  if (process.platform !== 'linux' || !['1', '2'].includes(profile)) throw new Error('Podaj profil 1 albo 2');
  const value = fs.readFileSync(dir + '/go2rtc.pid', 'utf8').trim();
  if (!/^[1-9]\d*$/.test(value) || Number(value) <= 1) throw new Error('Nieprawidlowy PID');
  const procPath = '/proc/' + value;
  if (fs.readFileSync(procPath + '/cmdline', 'utf8').split('\0')[0] !== dir + '/go2rtc') throw new Error('Inny proces - odmowa restartu');
  const entry = fs.readFileSync(procPath + '/environ', 'utf8').split('\0').find(x => x.startsWith('CAMERA_TEST_URL='));
  const url = new URL(entry.slice('CAMERA_TEST_URL='.length));
  if (url.hostname !== '192.168.1.168' || url.pathname !== '/cam/realmonitor') throw new Error('Inna kamera');
  if (url.searchParams.get('subtype') === profile) { console.log('Profil juz wybrany'); return; }
  url.searchParams.set('subtype', profile);
  process.kill(Number(value), 'SIGTERM');
  for (let i = 0; i < 60 && fs.existsSync(procPath); i++) await new Promise(resolve => setTimeout(resolve, 100));
  if (fs.existsSync(procPath)) throw new Error('Stary proces nadal dziala');
  const log = fs.openSync(dir + '/go2rtc.log', 'a', 0o600);
  const proc = child.spawn(dir + '/go2rtc', ['-config', dir + '/go2rtc.yaml'], { cwd: dir, detached: true,
    stdio: ['ignore', log, log], env: { PATH: process.env.PATH, HOME: '/home/pi', CAMERA_TEST_URL: url.toString() }
  });
  proc.unref(); fs.closeSync(log);
  fs.writeFileSync(dir + '/go2rtc.pid', String(proc.pid), { mode: 0o600 });
  console.log('CAMERA_TEST_PROFILE', { profile, pid: proc.pid });
})().catch(error => { console.error('Przelaczenie testu przerwane:', error.message); process.exitCode = 1; });

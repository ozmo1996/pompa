// Zmienia tylko ExtraFormat[1] (trzeci strumien), nigdy MainFormat ani ustawienia sieci/bezpieczenstwa.
const fs = require('node:fs');
const cp = require('node:child_process');
const dir = '/home/pi/pompa-kamery-test';
const mode = process.argv[2] || 'inspect';
if (process.platform !== 'linux' || !['inspect', 'apply', 'restore'].includes(mode)) throw new Error('Nieprawidlowy tryb');
const pid = fs.readFileSync(dir + '/go2rtc.pid', 'utf8').trim();
if (!/^[1-9]\d*$/.test(pid)) throw new Error('Nieprawidlowy PID');
if (fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0')[0] !== dir + '/go2rtc') throw new Error('Inny proces, odmowa odczytu');
const row = fs.readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0').find(x => x.startsWith('CAMERA_TEST_URL='));
const camera = new URL(row.slice('CAMERA_TEST_URL='.length));
if (camera.hostname !== '192.168.1.168') throw new Error('Inna kamera');
const credentials = decodeURIComponent(camera.username) + ':' + decodeURIComponent(camera.password);
function call(path, query = {}) {
  const url = new URL('http://' + camera.hostname + path);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  try { return cp.execFileSync('curl', ['--max-time', '12', '-sfS', '--digest', '--user', credentials, url.toString()], { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
  catch { throw new Error('Blad polaczenia z API kamery (dane dostepowe nie sa logowane)'); }
}
function parse(body) {
  return Object.fromEntries(body.split(/\r?\n/).filter(line => line.includes('=')).map(line => {
    const i = line.indexOf('='); return [line.slice(0, i).replace(/^table\./, ''), line.slice(i + 1).trim()];
  }));
}
const config = () => parse(call('/cgi-bin/configManager.cgi', { action: 'getConfig', name: 'Encode' }));
const before = config();
const prefix = 'Encode[0].ExtraFormat[1]';
const target = {
  [prefix + '.VideoEnable']: 'true', [prefix + '.AudioEnable']: 'false',
  [prefix + '.Video.Width']: '1280', [prefix + '.Video.Height']: '720',
  [prefix + '.Video.FPS']: '20', [prefix + '.Video.GOP']: '20',
  [prefix + '.Video.BitRate']: '1280', [prefix + '.Video.BitRateControl']: 'CBR',
  [prefix + '.Video.Compression']: 'H.264', [prefix + '.Video.Profile']: 'Main'
};
const original = Object.fromEntries(Object.keys(target).map(key => {
  if (before[key] === undefined) throw new Error('Kamera nie udostepnia parametru ' + key);
  return [key, before[key]];
}));
const mainBefore = Object.fromEntries(Object.entries(before).filter(([key]) => key.includes('.MainFormat[')));
const set = (values) => {
  const result = call('/cgi-bin/configManager.cgi', { action: 'setConfig', ...values }).trim();
  if (result !== 'OK') throw new Error('Kamera odrzucila konfiguracje');
};
const verify = (values, after) => Object.entries(values).every(([key, value]) => after[key] === value);
const file = dir + '/camera-quality-backup.json';
if (mode === 'inspect') console.log(JSON.stringify({ current: original, proposed: target }));
if (mode === 'apply') {
  const caps = call('/cgi-bin/encode.cgi', { action: 'getConfigCaps', channel: '0' });
  if (!/ExtraFormat\[1\]\.Video\.ResolutionTypes=.*720P/.test(caps)) throw new Error('Brak potwierdzonej obslugi HD w trzecim strumieniu');
  if (!/ExtraFormat\[1\]\.Video\.FPSMax=25/.test(caps) || !/ExtraFormat\[1\]\.Video\.BitRateOptions=156,1280/.test(caps)) throw new Error('Inne limity kamery - wymagana ponowna ocena');
  fs.writeFileSync(file, JSON.stringify({ original, target, mainBefore }, null, 2), { mode: 0o600, flag: 'wx' });
  try {
    set(target);
    const after = config();
    if (!verify(target, after) || !verify(mainBefore, after)) throw new Error('Odczyt kontrolny nie potwierdzil konfiguracji');
    console.log('CAMERA_HD_VERIFIED', JSON.stringify(Object.fromEntries(Object.keys(target).map(key => [key, after[key]]))));
  } catch (error) {
    set(original);
    if (!verify(original, config())) throw new Error('Nie potwierdzono cofniecia ustawien - sprawdz kamere');
    throw error;
  }
}
if (mode === 'restore') {
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!verify(saved.target, before)) throw new Error('Ustawienia zmieniono od testu. Nie nadpisuje ich automatycznie.');
  set(saved.original);
  if (!verify(saved.original, config())) throw new Error('Nie potwierdzono przywrocenia');
  console.log('CAMERA_QUALITY_RESTORED');
}

// Instalacja binariów testowych w nowym katalogu; bez roota, zmiany DNS, tras i usług pompy.
const fs = require('node:fs');
const crypto = require('node:crypto');
const child = require('node:child_process');
const dir = '/home/pi/pompa-kamery-test';

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000), headers: { 'User-Agent': 'Pompa-camera-test' } });
  if (!response.ok) throw new Error('Nie pobrano oficjalnego pliku: HTTP ' + response.status);
  return Buffer.from(await response.arrayBuffer());
}
function saveVerified(name, data, hash) {
  if (!/^[a-f0-9]{64}$/i.test(hash) || crypto.createHash('sha256').update(data).digest('hex') !== hash.toLowerCase())
    throw new Error('Nieprawidłowa suma SHA256: ' + name);
  fs.writeFileSync(dir + '/' + name, data, { mode: 0o600, flag: 'wx' });
}

(async () => {
  if (process.platform !== 'linux' || process.arch !== 'arm64') throw new Error('Wyłącznie Raspberry Linux ARM64');
  if (fs.existsSync(dir)) throw new Error('Katalog testowy istnieje — nie nadpisuję go. Sprawdź poprzednią instalację.');
  const tarName = 'tailscale_1.104.1_arm64.tgz';
  const hash = (await download('https://pkgs.tailscale.com/stable/' + tarName + '.sha256')).toString().trim().split(/\s/)[0];
  const tar = await download('https://pkgs.tailscale.com/stable/' + tarName);
  const release = JSON.parse((await download('https://api.github.com/repos/AlexxIT/go2rtc/releases/tags/v1.9.14')).toString());
  const asset = release.assets.find((a) => a.name === 'go2rtc_linux_arm64');
  if (!asset?.digest?.startsWith('sha256:')) throw new Error('Brak sumy oficjalnego go2rtc');
  const go2rtc = await download(asset.browser_download_url);
  fs.mkdirSync(dir, { mode: 0o700 });
  saveVerified(tarName, tar, hash);
  saveVerified('go2rtc', go2rtc, asset.digest.slice(7));
  child.execFileSync('tar', ['-xzf', dir + '/' + tarName, '--strip-components=1', '-C', dir,
    'tailscale_1.104.1_arm64/tailscale', 'tailscale_1.104.1_arm64/tailscaled']);
  for (const name of ['tailscale', 'tailscaled', 'go2rtc']) fs.chmodSync(dir + '/' + name, 0o700);
  fs.mkdirSync(dir + '/tailscale-state', { mode: 0o700 });
  const log = fs.openSync(dir + '/tailscaled.log', 'a', 0o600);
  const daemon = child.spawn(dir + '/tailscaled', [
    '--tun=userspace-networking', '--port=0', '--state=' + dir + '/tailscale-state/state', '--socket=' + dir + '/tailscale.sock'
  ], { detached: true, stdio: ['ignore', log, log] });
  daemon.unref();
  fs.closeSync(log);
  fs.writeFileSync(dir + '/tailscaled.pid', String(daemon.pid), { mode: 0o600, flag: 'wx' });
  console.log('INSTALACJA_TESTOWA_OK', { tailscaledPid: daemon.pid, katalog: dir });
  console.log('Zainstalowano wyłącznie w katalogu testowym. Daemon userspace nie zmienia tras ani DNS i nie jest uruchamiany przy restarcie.');
})().catch((error) => { console.error('INSTALACJA_PRZERWANA', error.message); process.exitCode = 1; });

// Naprawia wylacznie nasz testowy daemon: zachowuje tozsamosc i dodaje katalog certyfikatow.
const fs = require('node:fs');
const child = require('node:child_process');
const dir = '/home/pi/pompa-kamery-test';
(async () => {
  if (process.platform !== 'linux') throw new Error('Wylacznie Raspberry Linux');
  const value = fs.readFileSync(dir + '/tailscaled.pid', 'utf8').trim();
  if (!/^[1-9]\d*$/.test(value) || Number(value) <= 1) throw new Error('Nieprawidlowy PID');
  const pid = Number(value), procPath = '/proc/' + value + '/cmdline';
  const args = fs.readFileSync(procPath, 'utf8').split('\0');
  if (args[0] !== dir + '/tailscaled' || !args.includes('--tun=userspace-networking') || !args.includes('--state=' + dir + '/tailscale-state/state')) throw new Error('Nie jest to nasz odizolowany daemon. Odmowa restartu.');
  if (args.includes('--statedir=' + dir + '/tailscale-state')) throw new Error('Katalog juz ustawiony. Nie restartuje ponownie.');
  if ((fs.statSync(dir + '/tailscale-state').mode & 0o077) !== 0) throw new Error('Nieprawidlowe prawa katalogu prywatnego');
  fs.accessSync(dir + '/tailscale-state/state', fs.constants.R_OK);
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 60 && fs.existsSync(procPath); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (fs.existsSync(procPath)) throw new Error('Stary daemon jeszcze dziala. Nie uruchamiam drugiego.');
  const log = fs.openSync(dir + '/tailscaled.log', 'a', 0o600);
  const daemon = child.spawn(dir + '/tailscaled', [
    '--tun=userspace-networking', '--port=0', '--statedir=' + dir + '/tailscale-state',
    '--state=' + dir + '/tailscale-state/state', '--socket=' + dir + '/tailscale.sock'
  ], { detached: true, stdio: ['ignore', log, log] });
  daemon.unref(); fs.closeSync(log);
  fs.writeFileSync(dir + '/tailscaled.pid', String(daemon.pid), { mode: 0o600 });
  console.log('TEST_TLS_STATEDIR_OK', { poprzedniPid: pid, nowyPid: daemon.pid });
})().catch((error) => { console.error('NAPRAWA_PRZERWANA', error.message); process.exitCode = 1; });

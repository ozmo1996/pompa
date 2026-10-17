// Zatrzymuje tylko procesy prototypu po weryfikacji /proc. Nie usuwa plikow ani uslug pompy.
const fs = require('node:fs');
const dir = '/home/pi/pompa-kamery-test';
if (process.platform !== 'linux') throw new Error('Wylacznie Raspberry Linux');
for (const [name, expected] of [['gateway', dir + '/camera-gateway.cjs'], ['go2rtc', dir + '/go2rtc'], ['tailscaled', dir + '/tailscaled']]) {
  const file = dir + '/' + name + '.pid';
  if (!fs.existsSync(file)) continue;
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!/^[1-9]\d*$/.test(value) || Number(value) <= 1) throw new Error('Nieprawidlowy PID testu');
  const procFile = '/proc/' + value + '/cmdline';
  if (!fs.existsSync(procFile)) { console.log(name + ': juz nie pracuje'); continue; }
  const args = fs.readFileSync(procFile, 'utf8').split('\0');
  if (!args.includes(expected)) throw new Error('PID nalezy do innego procesu. Nie zatrzymuje: ' + name);
  process.kill(Number(value), 'SIGTERM');
  console.log('Zatrzymano wylacznie test: ' + name);
}

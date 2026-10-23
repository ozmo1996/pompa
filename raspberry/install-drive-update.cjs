const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
function patchDrive(source) {
  if (source.includes('readTemperature(PLIK_TEMPERATURY_WODY)')) return source;
  const once = (old, next) => {
    if (source.split(old).length !== 2) throw Error('Nieznany fragment serwisu: ' + old.slice(0, 80));
    source = source.replace(old, next);
  };
  once('await falownik.writeRegister(REJ.sterowanie, STEROWANIE_STOP);',
    "pressureRuntime.stopNeeded = true;\n      await require('./drive-stop').stopDrive(falownik, p.trybStop || 'lagodny');\n      pressureRuntime.stopNeeded = false;");
  once('async function wykonajPolecenie(p) {', `async function wykonajPolecenie(p) {
  if (p && p.akcja === 'stop' && p.id !== ostatniIdPolecenia && Number.isFinite(p.czas) && Date.now() - p.czas < cfg.bezpieczenstwo.maksWiekPoleceniaSek * 1000 && Date.now() - p.czas > -5000) {
    pressureRuntime.operatorStopping = true;
    pressureRuntime.engine.stopped();
  }`);
  // Próg programowy, nie parametry zapisane w falowniku.
  if (!source.includes('cfg.falownik.minCzestotliwosc')) throw Error('Brak ograniczenia Hz');
  source = source.replaceAll('cfg.falownik.minCzestotliwosc', '0');
  const start = source.indexOf("    const odczyt = await fs.promises.readFile(PLIK_TEMPERATURY_WODY, 'utf8');");
  const end = source.indexOf('    const teraz = Date.now();', start);
  if (start < 0 || end < start || end - start > 1600) throw Error('Nieznana pętla temperatury');
  source = source.slice(0, start) + "    const sample = await require('./water-temperature').readTemperature(PLIK_TEMPERATURY_WODY);\n    const temperatura = sample.celsius;\n    stan.temperaturaWodyPonowienia = sample.retries;\n" + source.slice(end);
  return source;
}
if (require.main === module) {
  if (!['--apply-stopped','--check'].includes(process.argv[2])) throw Error('Wymagane potwierdzenie fizycznego postoju: --apply-stopped');
  const target = '/home/pi/pompa/index.js';
  const source = fs.readFileSync(target, 'utf8'), next = patchDrive(source);
  const updates = [[target, next]];
  for (const name of ['pressure-controller.js','pressure-control-runtime.js','pressure-control-schema.js','drive-stop.js','water-temperature.js']) {
    const text = fs.readFileSync(path.join(__dirname, name),'utf8');
    new (require('node:vm').Script)(text);
    updates.push(['/home/pi/pompa/' + name, text]);
  }
  const alarmPath = '/home/pi/pompa-alarmy/alarmy.js';
  let alarm = fs.readFileSync(alarmPath,'utf8');
  if (!alarm.includes('prev.czestotliwoscWyjsciowa > 0.7')) {
    const needle = '    s.awaria !== true &&';
    if (alarm.split(needle).length !== 2) throw Error('Nieznany alarm postoju');
    alarm = alarm.replace(needle, needle + '\n    num(prev.czestotliwoscWyjsciowa) && prev.czestotliwoscWyjsciowa > 0.7 &&\n    !(num(s.czestotliwoscZadana) && s.czestotliwoscZadana <= 0.7) &&');
  }
  updates.push([alarmPath, alarm]);
  const configPath = '/home/pi/pompa/config.json';
  const cfg = JSON.parse(fs.readFileSync(configPath,'utf8'));
  if (!cfg.falownik || !Number.isFinite(cfg.falownik.minCzestotliwosc)) throw Error('Nieznany config falownika');
  cfg.falownik.minCzestotliwosc = 0;
  updates.push([configPath, JSON.stringify(cfg,null,2)]);
  for(const [file, text] of updates) if(file.endsWith('.js')) new (require('node:vm').Script)(text);
  if (process.argv[2] === '--check') { console.log('DRIVE_UPDATE_CHECK_OK files=' + updates.length); process.exit(); }
  const backup = '/home/pi/pompa/backup-drive-' + Date.now();
  fs.mkdirSync(backup,{mode:0o700});
  const manifest = updates.map(([file],i)=>({file,backup: path.join(backup,String(i)),exists:fs.existsSync(file)}));
  for(const item of manifest) if(item.exists) fs.copyFileSync(item.file,item.backup,fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(backup,'manifest.json'),JSON.stringify(manifest),{mode:0o600});
  try {
    for(const [file,text] of updates) {
      const temp = file + '.drive-new.js';
      fs.writeFileSync(temp,text,{flag:'wx',mode:0o600});
      fs.renameSync(temp,file);
    }
  } catch(error) {
    for(const item of manifest) if(item.exists) fs.copyFileSync(item.backup,item.file);
    throw error;
  }
  console.log('DRIVE_UPDATE_INSTALLED backup=' + backup);
}
module.exports = {patchDrive};

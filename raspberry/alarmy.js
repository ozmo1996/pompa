"use strict";
// pompa-alarmy — wykrywa awarie i nagłe zmiany parametrów, zapisuje je w pompa/alarmy
// i wysyła powiadomienia push (FCM) na zarejestrowane telefony.
// Serwis tylko czyta pompa/status i pompa/polecenie — nie steruje falownikiem.

const path = require("path");
const admin = require("firebase-admin");
const schema = require("./alarm-schema");
const { wetBulb, stationPressure } = require("./psychrometrics");
let settings = schema.defaults();
const ruleFor = (typ) => (typ.startsWith("wlasny_") ? settings.wlasne?.[typ.slice(7)] : settings.reguly[typ]);

const CFG = {
  serviceAccount: process.env.SERVICE_ACCOUNT || path.join(__dirname, "serviceAccount.json"),
  databaseURL: "https://pompa-bdd30-default-rtdb.europe-west1.firebasedatabase.app",
  healthcheckUrl: process.env.HEALTHCHECK_URL || "", // np. https://hc-ping.com/xxxx (opcjonalnie)
  mocZnamionowa: 90, // kW — silnik CELMA Sg 280M2
  pradZnamionowy: 159, // A
};

// Progi — zmieniaj tutaj, po zmianie: sudo systemctl restart pompa-alarmy
const P = {
  brakDanychS: 90, // brak nowego odczytu z serwisu pomiarowego
  brakKomunikacjiS: 20, // falownik niepołączony dłużej niż
  skokOknoS: 60, // porównanie z odczytem sprzed ~1 min
  skokMocyProc: 15, // nagła zmiana mocy przy stałej częstotliwości
  skokNapieciaProc: 10,
  stalaHz: 0.5, // "stała częstotliwość" = zmiana nie większa niż
  minMocDoSkoku: 10, // kW — poniżej nie oceniamy skoków
  spadekWodyProc: 5, // punkty % poziomu…
  spadekWodyMin: 10, // …w ciągu tylu minut
  wyciekProc: 2, // spadek przy zatrzymanej pompie…
  wyciekMin: 30, // …przez tyle minut
  poziomWysoki: 97, // % — możliwy przelew (info)
  sondaMinMa: 1.0,
  sondaMaxMa: 20.5,
  sondaStoiMin: 30, // identyczny prąd sondy przy pracującej pompie
  tempOstrzezenie: 1.0,
  tempAwaria: 0.3, // °C
  spadekTempC: 1.0,
  spadekTempMin: 30,
  odchylkaHz: 2,
  odchylkaS: 120, // wyjście ≠ zadana (poza rampą)
  przeciazenieS: 60,
  limitDlugoMin: 15,
  stopBezPoleceniaS: 90, // stop bez polecenia z aplikacji w tym oknie = nieoczekiwany
  mokryMaxC: -2, // termometr mokry powyżej = za ciepło na śnieg…
  mokryMin: 10, // …przez tyle minut pracy pompy
  porywMaxKmh: 50, // porywy wiatru przy pracy armatek
  pogodaWaznaMin: 10, // starsze dane pogodowe są pomijane
  cooldownZdarzenMin: 10,
  zakonczenieS: 60, // warunek musi ustąpić na tyle, by zamknąć alarm
};
Object.assign(P, settings.progi);

admin.initializeApp({ credential: admin.credential.cert(require(CFG.serviceAccount)), databaseURL: CFG.databaseURL });
const db = admin.database();
const now = () => Date.now();
const num = (v) => typeof v === "number" && Number.isFinite(v);
const f = (v, d = 1) => (num(v) ? v.toLocaleString("pl-PL", { maximumFractionDigits: d }) : "—");
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- bufor odczytów ----------
let samples = []; // {t, s}
let status = null,
  statusAt = 0;
let lastStopCmdAt = 0;
const seenCommands = new Set();

function kw(s) {
  if (num(s?.moc)) return s.moc;
  if (s?.pracuje && num(s?.prad) && num(s?.napiecie)) return (Math.sqrt(3) * s.napiecie * s.prad * 0.91) / 1000;
  return null;
}
// ostatni odczyt starszy niż sec (ale nie dużo starszy)
function ago(sec) {
  const lim = now() - sec * 1000,
    min = now() - (sec * 2 + 60) * 1000;
  for (let i = samples.length - 1; i >= 0; i--) if (samples[i].t <= lim) return samples[i].t >= min ? samples[i] : null;
  return null;
}
// odczyty z ostatnich min minut; null, jeśli bufor nie pokrywa całego okna
function windowOf(min) {
  const from = now() - min * 60000;
  if (!samples.length || samples[0].t > from + 60000) return null;
  return samples.filter((x) => x.t >= from);
}

// ---------- alarmy ----------
const active = new Map(); // typ -> {id, clearSince}
const pending = new Map(); // typ -> since (warunek z opóźnieniem)
const lastEvent = new Map(); // typ -> czas

async function raise(typ, def, zdarzenie) {
  const rule = ruleFor(typ);
  if (rule?.wlaczony === false) return null;
  if (rule?.poziom && rule.poziom !== "auto") def = { ...def, poziom: rule.poziom };
  const rec = {
    typ,
    poziom: def.poziom,
    tytul: def.tytul,
    opis: def.opis || "",
    czas: now(),
    aktywny: !zdarzenie,
    zdarzenie: !!zdarzenie,
  };
  const r = db.ref("pompa/alarmy").push();
  await r.set(rec);
  log(zdarzenie ? "ZDARZENIE" : "ALARM", def.poziom, typ, def.tytul, "|", def.opis);
  push(rec, r.key).catch((e) => log("push błąd", e.message));
  return r.key;
}
// alarm stanowy: trwa, dopóki warunek jest spełniony
function cond(typ, isTrue, defFn, { delayS = 0, clearS = P.zakonczenieS } = {}) {
  const rule = ruleFor(typ);
  if (rule) {
    isTrue = isTrue && rule.wlaczony;
    delayS = rule.opoznienieS;
    clearS = rule.wlaczony ? rule.zakonczenieS : 0;
  }
  const a = active.get(typ);
  if (isTrue) {
    if (a) {
      a.clearSince = 0;
      a.retryAt = 0;
      if (a.closing) {
        a.resume = defFn;
        return;
      }
      const level = rule?.poziom === "auto" ? defFn().poziom : rule?.poziom;
      if (level && a.id && a.poziom !== level) {
        a.poziom = level;
        db.ref("pompa/alarmy/" + a.id)
          .update({ poziom: level })
          .catch((e) => log("ważność błąd", e.message));
      }
      return;
    }
    if (delayS > 0) {
      if (!pending.has(typ)) pending.set(typ, now());
      if (now() - pending.get(typ) < delayS * 1000) return;
    }
    pending.delete(typ);
    const entry = { id: null, clearSince: 0, creating: true };
    active.set(typ, entry);
    const def = defFn();
    if (rule?.poziom && rule.poziom !== "auto") def.poziom = rule.poziom;
    entry.poziom = def.poziom;
    entry.tytul = def.tytul;
    raise(typ, def, false)
      .then((id) => {
        entry.id = id;
        entry.creating = false;
      })
      .catch((e) => {
        active.delete(typ);
        log("zapis błąd", e.message);
      });
  } else {
    pending.delete(typ);
    if (a?.closing) {
      a.resume = null;
      return;
    }
    if (!a || a.creating || a.closing || now() < (a.retryAt || 0)) return;
    if (!a.clearSince) a.clearSince = now();
    if (now() - a.clearSince >= clearS * 1000) {
      if (!a.id) return;
      a.closing = true;
      a.retryAt = 0;
      db.ref("pompa/alarmy/" + a.id)
        .update({ aktywny: false, zakonczono: now() })
        .then(() => {
          if (active.get(typ) === a) active.delete(typ);
          log("KONIEC", typ);
          if (a.poziom === "awaria")
            push(
              { typ, poziom: "awaria", tytul: "Ustąpiło: " + a.tytul, opis: "Warunek alarmu już nie występuje." },
              a.id,
              true,
            ).catch(() => {});
          if (a.resume) cond(typ, true, a.resume);
        })
        .catch((e) => {
          a.closing = false;
          a.resume = null;
          a.retryAt = now() + 5000;
          log("zamknięcie błąd — ponowienie", e.message);
        });
    }
  }
}
// zdarzenie jednorazowe (skok, nieoczekiwany stop) z ochroną przed zalewem powiadomień
function event(typ, def) {
  if (ruleFor(typ)?.wlaczony === false) return;
  if (now() - (lastEvent.get(typ) || 0) < P.cooldownZdarzenMin * 60000) return;
  lastEvent.set(typ, now());
  raise(typ, def, true).catch((e) => log("zapis błąd", e.message));
}

// ---------- reguły ----------
function evaluate() {
  const s = status;
  if (!s) return;
  const t = now(),
    fresh = num(s.aktualizacja) && t - s.aktualizacja >= -60000 && t - s.aktualizacja < P.brakDanychS * 1000;
  const lastRunning = samples.length && samples.at(-1).s.pracuje === true;

  cond("brakDanych", !fresh, () => ({
    poziom: lastRunning ? "awaria" : "ostrzezenie",
    tytul: "Brak nowych pomiarów",
    opis: `Serwis pomiarowy nie przesłał danych od ${f((t - (s.aktualizacja || statusAt)) / 1000, 0)} s. Stan pompy nie jest znany.`,
  }));
  if (!fresh) {
    evaluateCustom();
    retryClosures();
    return;
  } // ND20 i pogoda mają własne znaczniki czasu

  const prev = samples.length > 1 ? samples.at(-2).s : null;
  const hz = s.czestotliwoscWyjsciowa,
    p = kw(s),
    run = s.pracuje === true;

  // falownik
  cond(
    "brakKomunikacji",
    s.polaczony === false,
    () => ({
      poziom: lastRunning ? "awaria" : "ostrzezenie",
      tytul: "Brak komunikacji z falownikiem",
      opis: "Raspberry nie odczytuje falownika przez Modbus (RS-485). Sprawdź konwerter, przewód i zasilanie falownika.",
    }),
    { delayS: P.brakKomunikacjiS },
  );
  cond("awariaFalownika", s.polaczony !== false && s.awaria === true, () => ({
    poziom: "awaria",
    tytul: "Awaria falownika",
    opis: `Kod: ${s.kodAwarii || "nieznany"}. Pompa zatrzymana przez zabezpieczenie falownika.`,
  }));
  if (
    prev &&
    prev.pracuje === true &&
    s.pracuje === false &&
    s.awaria !== true &&
    t - lastStopCmdAt > P.stopBezPoleceniaS * 1000
  )
    event("nieoczekiwanyStop", {
      poziom: "awaria",
      tytul: "Pompa zatrzymała się bez polecenia",
      opis: `Pracowała na ${f(prev.czestotliwoscWyjsciowa)} Hz. Możliwy stop lokalny, zanik zasilania (agregat) lub zabezpieczenie zewnętrzne. Sprawdź instalację — ryzyko zamarznięcia rurociągu.`,
    });

  // przeciążenie i praca
  cond(
    "przeciazenie",
    s.polaczony && run && ((num(p) && p > P.mocZnamionowa) || (num(s.prad) && s.prad > P.pradZnamionowy)),
    () => ({
      poziom: "ostrzezenie",
      tytul: "Silnik powyżej ustawionych progów",
      opis: `Moc ${f(p)} kW (próg ${P.mocZnamionowa}), prąd ${f(s.prad)} A (próg ${P.pradZnamionowy}) przez ponad ${settings.reguly.przeciazenie.opoznienieS} s.`,
    }),
  );
  const target = s.limitAktywny ? s.czestotliwoscZadana : (s.czestotliwoscCel ?? s.czestotliwoscZadana);
  cond("odchylkaHz", s.polaczony && run && num(hz) && num(target) && Math.abs(hz - target) > P.odchylkaHz, () => ({
    poziom: "ostrzezenie",
    tytul: "Falownik nie osiąga częstotliwości celu",
    opis: `Wyjście ${f(hz)} Hz, cel ${f(target)} Hz od ponad ${settings.reguly.odchylkaHz.opoznienieS} s.`,
  }));
  cond("limitDlugo", run && s.limitAktywny === true, () => ({
    poziom: "info",
    tytul: "Limit mocy aktywny od dłuższego czasu",
    opis: `Automatyczny limit obniża częstotliwość od ponad ${f(settings.reguly.limitDlugo.opoznienieS / 60)} min (teraz ${f(s.czestotliwoscZadana)} Hz).`,
  }));

  // nagłe skoki przy stałej częstotliwości
  const b = ago(P.skokOknoS)?.s;
  if (
    run &&
    b?.pracuje === true &&
    num(hz) &&
    num(b.czestotliwoscWyjsciowa) &&
    Math.abs(hz - b.czestotliwoscWyjsciowa) <= P.stalaHz
  ) {
    const p0 = kw(b);
    if (num(p) && num(p0) && p0 >= P.minMocDoSkoku) {
      const d = ((p - p0) / p0) * 100;
      if (d >= P.skokMocyProc)
        event("skokMocyWzrost", {
          poziom: "ostrzezenie",
          tytul: `Moc nagle wzrosła o ${f(d, 0)} %`,
          opis: `${f(p0)} → ${f(p)} kW w ~1 min przy stałych ${f(hz)} Hz. Możliwe otwarcie armatki, rozszczelnienie rurociągu lub opory mechaniczne.`,
        });
      if (d <= -P.skokMocyProc)
        event("skokMocySpadek", {
          poziom: "ostrzezenie",
          tytul: `Moc nagle spadła o ${f(-d, 0)} %`,
          opis: `${f(p0)} → ${f(p)} kW w ~1 min przy stałych ${f(hz)} Hz. Możliwe zamknięcie/zamarznięcie armatki, zapowietrzenie lub suchobieg pompy.`,
        });
    }
    if (num(s.napiecie) && num(b.napiecie) && b.napiecie > 50) {
      const d = ((s.napiecie - b.napiecie) / b.napiecie) * 100;
      if (Math.abs(d) >= P.skokNapieciaProc)
        event("skokNapiecia", {
          poziom: "ostrzezenie",
          tytul: `Napięcie zmieniło się o ${f(d, 0)} %`,
          opis: `${f(b.napiecie, 0)} → ${f(s.napiecie, 0)} V przy stałej częstotliwości. Sprawdź zasilanie / agregat.`,
        });
    }
  }

  // woda
  const lvl = s.sondaPolaczona === true ? s.poziomWodyProc : null,
    ma = s.sondaPolaczona === true ? s.poziomWodyMa : null;
  cond("niskiPoziom", num(lvl) && lvl < P.poziomNiski, () => ({
    poziom: "awaria",
    tytul: "Niski poziom wody",
    opis: `Poziom ${f(lvl)} % (próg ${f(P.poziomNiski)} %). Ryzyko suchobiegu pompy.`,
  }));
  cond("sondaNiepolaczona", s.sondaPolaczona === false, () => ({
    poziom: "ostrzezenie",
    tytul: "Brak komunikacji z sondą poziomu",
    opis: "Sprawdź zasilanie i połączenie modułu pomiarowego.",
  }));
  cond("sondaPoziomu", num(ma) && (ma < P.sondaMinMa || ma > P.sondaMaxMa), () => ({
    poziom: "awaria",
    tytul: "Uszkodzenie sondy poziomu",
    opis: `Prąd sondy ${f(ma, 2)} mA poza zakresem roboczym. Około 3,7 mA oznacza suchy czujnik; wartość poniżej 1,0 mA wskazuje brak sygnału.`,
  }));
  cond("przelew", num(lvl) && lvl >= P.poziomWysoki, () => ({
    poziom: "info",
    tytul: "Zbiornik prawie pełny",
    opis: `Poziom ${f(lvl)} %.`,
  }));

  const w10 = ago(P.spadekWodyMin * 60)?.s;
  const drop = num(lvl) && w10?.sondaPolaczona === true && num(w10.poziomWodyProc) ? w10.poziomWodyProc - lvl : null;
  cond(
    "szybkiSpadek",
    drop !== null && drop >= (active.has("szybkiSpadek") ? P.spadekWodyProc * 0.6 : P.spadekWodyProc),
    () => {
      const perH = (drop / P.spadekWodyMin) * 60,
        eta = perH > 0 ? (lvl / perH) * 60 : null;
      return {
        poziom: "ostrzezenie",
        tytul: "Woda szybko opada",
        opis: `−${f(drop)} % w ${P.spadekWodyMin} min (≈ ${f(perH, 0)} %/h).${eta ? ` Przy tym tempie zbiornik opróżni się za ok. ${f(eta, 0)} min.` : ""} Sprawdź dopływ.`,
      };
    },
  );
  const w30 = windowOf(P.wyciekMin);
  if (w30) {
    const stopped = w30.every((x) => x.s.polaczony === true && x.s.pracuje === false && x.s.sondaPolaczona === true),
      first = w30[0].s.poziomWodyProc;
    cond("wyciek", stopped && num(first) && num(lvl) && first - lvl >= P.wyciekProc, () => ({
      poziom: "ostrzezenie",
      tytul: "Poziom spada przy zatrzymanej pompie",
      opis: `−${f(first - lvl)} % w ${P.wyciekMin} min bez pracy pompy. Możliwy wyciek lub otwarty spust.`,
    }));
  }
  const ws = windowOf(P.sondaStoiMin);
  if (ws) {
    const vals = ws.map((x) => x.s.poziomWodyMa).filter(num);
    cond(
      "sondaStoi",
      ws.every((x) => x.s.pracuje === true && x.s.sondaPolaczona === true) &&
        vals.length > 5 &&
        Math.max(...vals) - Math.min(...vals) < 0.001,
      () => ({
        poziom: "ostrzezenie",
        tytul: "Odczyt poziomu stoi w miejscu",
        opis: `Prąd sondy bez zmian od ${P.sondaStoiMin} min mimo pracy pompy. Możliwe zamarznięcie sondy lub zawieszony przetwornik.`,
      }),
    );
  }

  // pogoda (tylko gdy dane ze stacji są świeże — serwis pogody odświeża je przy otwartej aplikacji)
  const w = s.pogoda,
    wt = Number(w?.czasPomiaru || w?.pobrano),
    wFresh = num(wt) && t - wt < P.pogodaWaznaMin * 60000;
  const wb = wFresh ? wetBulb(w.temperatura, w.wilgotnosc, stationPressure(w)) : null;
  cond("pogodaNieaktualna", !wFresh, () => ({
    poziom: "ostrzezenie",
    tytul: "Brak aktualnych danych pogodowych",
    opis: `Pomiar starszy niż ${P.pogodaWaznaMin} min lub niedostępny.`,
  }));
  cond("nd20Niepolaczony", s.nd20?.polaczony === false || (s.nd20 && t - (s.nd20.aktualizacja || 0) > 15000), () => ({
    poziom: "ostrzezenie",
    tytul: "Brak komunikacji z ND20",
    opis: "Sprawdź zasilanie miernika agregatu i port C3.",
  }));
  cond(
    "zaCieplo",
    run && num(wb) && wb > P.mokryMaxC,
    () => ({
      poziom: "ostrzezenie",
      tytul: "Za ciepło na śnieg",
      opis: `Termometr mokry ${f(wb)} °C (próg ${f(P.mokryMaxC)} °C) przy ${f(w.temperatura)} °C i wilgotności ${f(w.wilgotnosc, 0)} %. Armatki dają mokry śnieg lub wodę — rozważ zatrzymanie.`,
    }),
    { delayS: P.mokryMin * 60, clearS: 600 },
  );
  cond(
    "silnyWiatr",
    run && wFresh && num(w.poryw) && w.poryw >= P.porywMaxKmh,
    () => ({
      poziom: "ostrzezenie",
      tytul: "Silny wiatr przy pracy armatek",
      opis: `Porywy ${f(w.poryw, 0)} km/h (próg ${P.porywMaxKmh}). Śnieg może być wywiewany poza trasę — sprawdź ustawienie armatek.`,
    }),
    { clearS: 1800 },
  );

  // temperatura wody
  const tw = s.temperaturaWodyPolaczona === true ? s.temperaturaWody : null;
  cond("temperaturaNiepolaczona", s.temperaturaWodyPolaczona === false, () => ({
    poziom: "ostrzezenie",
    tytul: "Brak odczytu temperatury wody",
    opis: "Sprawdź sondę DS18B20 i przewód.",
  }));
  cond("zamarzanie", num(tw) && tw <= P.tempAwaria, () => ({
    poziom: "awaria",
    tytul: "Woda zamarza",
    opis: `Temperatura wody ${f(tw)} °C.`,
  }));
  cond(
    "zimnaWoda",
    num(tw) && tw <= P.tempOstrzezenie && (tw > P.tempAwaria || !settings.reguly.zamarzanie.wlaczony),
    () => ({
      poziom: "ostrzezenie",
      tytul: "Woda bliska zamarzania",
      opis: `Temperatura wody ${f(tw)} °C.`,
    }),
  );
  const t30 = ago(P.spadekTempMin * 60)?.s?.temperaturaWody;
  if (num(tw) && num(t30) && t30 - tw >= P.spadekTempC && tw < P.spadekTempPonizejC)
    event("spadekTemp", {
      poziom: "ostrzezenie",
      tytul: "Woda szybko się wychładza",
      opis: `${f(t30)} → ${f(tw)} °C w ${P.spadekTempMin} min.`,
    });
  evaluateCustom();
  retryClosures();
}

function retryClosures() {
  for (const [typ, entry] of active) if (entry.retryAt && now() >= entry.retryAt) cond(typ, false, () => ({}));
}

function evaluateCustom() {
  for (const [id, r] of Object.entries(settings.wlasne || {})) {
    const v = schema.metricValue(status, r.pomiar, now(), P.pogodaWaznaMin),
      m = schema.METRICS[r.pomiar];
    cond(
      "wlasny_" + id,
      v !== null &&
        (!r.tylkoPraca || (status.polaczony && status.pracuje)) &&
        (r.operator === "lt" ? v < r.prog : v > r.prog),
      () => ({
        poziom: r.poziom === "auto" ? "ostrzezenie" : r.poziom,
        tytul: r.tytul,
        opis: `${m.title}: ${f(v, 2)} ${m.unit}; próg ${r.operator === "lt" ? "poniżej" : "powyżej"} ${f(r.prog, 2)} ${m.unit}.`,
      }),
    );
  }
}

async function applySettings(value) {
  const next = value || schema.defaults(),
    error = schema.validate(next);
  if (error) {
    log("ustawienia odrzucone", error);
    return;
  }
  settings = { ...next, wlasne: next.wlasne || {} };
  Object.assign(P, settings.progi);
  pending.clear();
  for (const [typ, entry] of active) {
    if (typ.startsWith("zabezpieczenieWody")) continue; // osobne ustawienia zabezpieczenia lokalnego
    const r = ruleFor(typ);
    if (!r || !r.wlaczony) cond(typ, false, () => ({}), { clearS: 0 });
    else if (r.poziom !== "auto" && entry.id && entry.poziom !== r.poziom) {
      await db.ref("pompa/alarmy/" + entry.id).update({ poziom: r.poziom });
      entry.poziom = r.poziom;
    }
  }
  await reportSettings();
  if (status) evaluate();
}
function reportSettings() {
  return db
    .ref("pompa/statusAlarmow")
    .update({ wersja: "2.21", aktualizacja: now(), ustawieniaId: settings.id || "domyslne" });
}

// ---------- powiadomienia push ----------
async function tokensFor(filter) {
  const snap = await db.ref("pompa/tokeny").get();
  const list = [];
  snap.forEach((c) => {
    const v = c.val();
    if (v?.token && filter(v)) list.push({ key: c.key, token: v.token });
  });
  return list;
}
async function sendTo(list, data, urgent) {
  if (!list.length) return 0;
  let ok = 0;
  for (let i = 0; i < list.length; i += 500) {
    const part = list.slice(i, i + 500);
    const res = await admin.messaging().sendEachForMulticast({
      tokens: part.map((x) => x.token),
      data,
      webpush: { headers: { Urgency: urgent ? "high" : "normal", TTL: urgent ? "86400" : "3600" } },
    });
    res.responses.forEach((r, j) => {
      if (r.success) ok++;
      else if (
        ["messaging/registration-token-not-registered", "messaging/invalid-registration-token"].includes(r.error?.code)
      ) {
        db.ref("pompa/tokeny/" + part[j].key)
          .remove()
          .catch(() => {});
        log("usunięto nieaktualny token", part[j].key);
      } else log("push nieudany", r.error?.code);
    });
  }
  return ok;
}
async function push(rec, id, ended) {
  if (rec.poziom === "info" || ruleFor(rec.typ)?.push === false || ruleFor(rec.typ)?.wlaczony === false) return;
  const list = await tokensFor((v) => (rec.poziom === "awaria" ? v.awarie !== false : v.ostrzezenia === true));
  const n = await sendTo(
    list,
    {
      tytul: ended ? rec.tytul : (rec.poziom === "awaria" ? "AWARIA: " : "Ostrzeżenie: ") + rec.tytul,
      tresc: rec.opis || "",
      poziom: ended ? "koniec" : rec.poziom,
      typ: rec.typ,
      id: id || "",
      czas: String(now()),
    },
    rec.poziom === "awaria" && !ended,
  );
  log("push", rec.typ, "→", n, "urządzeń");
}

// ---------- nasłuch ----------
async function start() {
  await applySettings((await db.ref("pompa/ustawienia/alarmy").get()).val());
  // odtwórz aktywne alarmy po restarcie serwisu
  const snap = await db.ref("pompa/alarmy").orderByChild("aktywny").equalTo(true).get();
  snap.forEach((c) => {
    const v = c.val();
    if (v?.typ && !active.has(v.typ)) active.set(v.typ, { id: c.key, clearSince: 0, poziom: v.poziom, tytul: v.tytul });
  });
  log("start, aktywne alarmy:", [...active.keys()].join(", ") || "brak");
  db.ref("pompa/statusZabezpieczeniaWody").on("value", (s) => {
    const w = s.val();
    if (!w || !num(w.aktualizacja) || now() - w.aktualizacja > 10000) return;
    cond(
      "zabezpieczenieWodyStop",
      !!w.awaria,
      () => ({
        poziom: "awaria",
        tytul: "Zabezpieczenie poziomu wody — blokada pompy",
        opis:
          w.awaria +
          (w.stopNiepotwierdzony
            ? ". STOP niepotwierdzony, ponawianie."
            : ". Wymagane ręczne skasowanie blokady. Brak automatycznego wznowienia."),
      }),
      { clearS: 0 },
    );
    cond(
      "zabezpieczenieWodyOstrzezenie",
      w.ostrzegaj === true && w.ostrzezenie === true && !w.awaria,
      () => ({
        poziom: "ostrzezenie",
        tytul: "Poziom wody zbliża się do progu zatrzymania",
        opis: `Poziom ${f(w.poziomCm)} cm; ostrzeżenie ${f(w.ostrzezenieCm)} cm. STOP: ${w.wlaczony ? f(w.stopCm) + " cm" : "wyłączony"}.`,
      }),
      { clearS: 0 },
    );
  });
  db.ref("pompa/ustawienia/alarmy").on("value", (s) => {
    applySettings(s.val()).catch((e) => log("ustawienia błąd", e.message));
  });

  db.ref("pompa/status").on("value", (s) => {
    status = s.val();
    statusAt = now();
    if (status) {
      samples.push({ t: now(), s: status });
      const cut = now() - 121 * 60000;
      while (samples.length && samples[0].t < cut) samples.shift();
      if (samples.length > 30000) samples.splice(0, samples.length - 30000);
    }
    try {
      evaluate();
    } catch (e) {
      log("evaluate błąd", e);
    }
  });

  let firstCmd = true;
  db.ref("pompa/polecenie").on("value", (s) => {
    const c = s.val();
    if (!c?.id) {
      firstCmd = false;
      return;
    }
    if (c.akcja === "stop" && num(c.czas)) lastStopCmdAt = Math.max(lastStopCmdAt, Math.min(c.czas, now()));
    if (firstCmd) {
      seenCommands.add(c.id);
      firstCmd = false;
      return;
    }
    if (c.wykonane === false && !seenCommands.has(c.id)) {
      seenCommands.add(c.id);
      event("polecenieOdrzucone", {
        poziom: "ostrzezenie",
        tytul: "Polecenie odrzucone",
        opis: `Akcja „${c.akcja}”${num(c.czestotliwosc) ? ` (${f(c.czestotliwosc)} Hz)` : ""}: ${c.blad || "brak potwierdzenia"}.`,
      });
    }
    if (seenCommands.size > 200) seenCommands.clear();
  });

  // test powiadomień wysłany z aplikacji
  db.ref("pompa/testPowiadomienia").on("value", async (s) => {
    const r = s.val();
    if (!r?.uid || !num(r.czas) || r.wyslano || now() - r.czas > 60000) return;
    try {
      const n = await sendTo(
        await tokensFor((v) => v.uid === r.uid),
        {
          tytul: "Test powiadomień",
          tresc: "Powiadomienia z pompy działają na tym urządzeniu.",
          poziom: "test",
          typ: "test",
          id: "",
          czas: String(now()),
        },
        true,
      );
      await s.ref.update({
        wyslano: now(),
        wynik: n ? `Wysłano do ${n} urządz.` : "Brak zarejestrowanych urządzeń dla tego konta",
      });
    } catch (e) {
      await s.ref.update({ wyslano: now(), wynik: "Błąd: " + e.message });
    }
  });

  // watchdog: brak danych nie wywoła zdarzenia 'value', więc sprawdzamy cyklicznie
  setInterval(() => {
    try {
      evaluate();
    } catch (e) {
      log("evaluate błąd", e);
    }
  }, 15000);
  setInterval(() => reportSettings().catch((e) => log("status alarmów błąd", e.message)), 30000);

  // zewnętrzny monitoring — ping tylko przy świeżych danych
  if (CFG.healthcheckUrl)
    setInterval(() => {
      if (status && num(status.aktualizacja) && now() - status.aktualizacja < P.brakDanychS * 1000)
        fetch(CFG.healthcheckUrl, { signal: AbortSignal.timeout(10000) }).catch((e) => log("healthcheck", e.message));
    }, 60000);
}

if (require.main === module) {
  start().catch((e) => {
    log("start nieudany", e);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => log("unhandledRejection", e));
}

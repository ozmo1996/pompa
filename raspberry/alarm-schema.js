// Wspólny katalog formularza, walidacji Firebase i serwisu Raspberry.
(function (root) {
  "use strict";
  const threshold = (label, value, min, max, unit = "", step = 1) => ({ label, value, min, max, unit, step });
  const PROGI = {
    brakDanychS: threshold("Brak nowych pomiarów po", 90, 15, 3600, "s"),
    skokOknoS: threshold("Okno porównania skoków", 60, 10, 3600, "s"),
    skokMocyProc: threshold("Zmiana mocy", 15, 1, 100, "%"),
    skokNapieciaProc: threshold("Zmiana napięcia", 10, 1, 100, "%"),
    stalaHz: threshold("Tolerancja stałej częstotliwości", 0.5, 0, 10, "Hz", 0.1),
    minMocDoSkoku: threshold("Oceniaj skoki od mocy", 10, 0, 500, "kW", 0.1),
    poziomNiski: threshold("Niski poziom poniżej", 20, 0, 100, "%", 0.1),
    poziomWysoki: threshold("Zbiornik pełny od", 97, 0, 100, "%", 0.1),
    spadekWodyProc: threshold("Szybki spadek poziomu", 5, 0.1, 100, "pkt %", 0.1),
    spadekWodyMin: threshold("Okno spadku wody", 10, 1, 120, "min"),
    wyciekProc: threshold("Spadek na postoju", 2, 0.1, 100, "pkt %", 0.1),
    wyciekMin: threshold("Okno spadku na postoju", 30, 1, 120, "min"),
    sondaMinMa: threshold("Minimalny prąd sondy", 1, 0, 20, "mA", 0.1),
    sondaMaxMa: threshold("Maksymalny prąd sondy", 20.5, 1, 30, "mA", 0.1),
    sondaStoiMin: threshold("Niezmienny odczyt przez", 30, 1, 120, "min"),
    tempOstrzezenie: threshold("Woda bliska zamarzania od", 1, -10, 20, "°C", 0.1),
    tempAwaria: threshold("Woda zamarza od", 0.3, -10, 20, "°C", 0.1),
    spadekTempC: threshold("Spadek temperatury", 1, 0.1, 30, "°C", 0.1),
    spadekTempMin: threshold("Okno spadku temperatury", 30, 1, 120, "min"),
    spadekTempPonizejC: threshold("Oceniaj wychładzanie poniżej", 4, -10, 30, "°C", 0.1),
    odchylkaHz: threshold("Odchyłka od częstotliwości celu", 2, 0.1, 50, "Hz", 0.1),
    mocZnamionowa: threshold("Próg mocy silnika", 90, 1, 500, "kW", 0.1),
    pradZnamionowy: threshold("Próg prądu silnika", 159, 1, 2000, "A", 0.1),
    stopBezPoleceniaS: threshold("Uwzględniaj polecenie stop z ostatnich", 90, 10, 3600, "s"),
    mokryMaxC: threshold("Za ciepło od temperatury mokrej", -2, -30, 20, "°C", 0.1),
    porywMaxKmh: threshold("Silny wiatr od porywów", 50, 1, 300, "km/h", 0.1),
    pogodaWaznaMin: threshold("Maksymalny wiek pogody", 12, 1, 120, "min"),
    cooldownZdarzenMin: threshold("Odstęp powtarzanych zdarzeń", 10, 1, 120, "min"),
  };
  const rule = (group, title, severity, fields = [], delay = 0, clear = 60, event = false, enabled = true) => ({
    group,
    title,
    severity,
    fields,
    delay,
    clear,
    event,
    enabled,
  });
  const RULES = {
    brakDanych: rule("Łączność", "Brak nowych pomiarów z Raspberry", "auto", ["brakDanychS"]),
    brakKomunikacji: rule("Falownik", "Brak komunikacji z falownikiem", "auto", [], 20),
    awariaFalownika: rule("Falownik", "Awaria zgłoszona przez falownik", "awaria"),
    nieoczekiwanyStop: rule(
      "Falownik",
      "Pompa zatrzymała się bez polecenia",
      "awaria",
      ["stopBezPoleceniaS"],
      0,
      60,
      true,
    ),
    przeciazenie: rule("Falownik", "Przeciążenie silnika", "ostrzezenie", ["mocZnamionowa", "pradZnamionowy"], 60),
    odchylkaHz: rule("Falownik", "Falownik nie osiąga częstotliwości celu", "ostrzezenie", ["odchylkaHz"], 120),
    limitDlugo: rule("Falownik", "Limit mocy aktywny zbyt długo", "info", [], 900),
    skokMocyWzrost: rule(
      "Falownik",
      "Nagły wzrost mocy",
      "ostrzezenie",
      ["skokMocyProc", "skokOknoS", "stalaHz", "minMocDoSkoku"],
      0,
      60,
      true,
    ),
    skokMocySpadek: rule("Falownik", "Nagły spadek mocy", "ostrzezenie", [], 0, 60, true),
    skokNapiecia: rule("Falownik", "Nagła zmiana napięcia", "ostrzezenie", ["skokNapieciaProc"], 0, 60, true),
    niskiPoziom: rule("Woda", "Niski poziom wody", "awaria", ["poziomNiski"]),
    przelew: rule("Woda", "Zbiornik prawie pełny", "info", ["poziomWysoki"]),
    sondaPoziomu: rule("Woda", "Prąd sondy poza zakresem", "awaria", ["sondaMinMa", "sondaMaxMa"]),
    sondaNiepolaczona: rule("Woda", "Brak komunikacji z sondą poziomu", "ostrzezenie", [], 30),
    szybkiSpadek: rule("Woda", "Woda szybko opada", "ostrzezenie", ["spadekWodyProc", "spadekWodyMin"]),
    wyciek: rule("Woda", "Poziom spada na postoju", "ostrzezenie", ["wyciekProc", "wyciekMin"]),
    sondaStoi: rule("Woda", "Odczyt poziomu stoi podczas pracy", "ostrzezenie", ["sondaStoiMin"]),
    zamarzanie: rule("Temperatura", "Woda zamarza", "awaria", ["tempAwaria"]),
    zimnaWoda: rule("Temperatura", "Woda bliska zamarzania", "ostrzezenie", ["tempOstrzezenie"]),
    spadekTemp: rule(
      "Temperatura",
      "Woda szybko się wychładza",
      "ostrzezenie",
      ["spadekTempC", "spadekTempMin", "spadekTempPonizejC"],
      0,
      60,
      true,
    ),
    temperaturaNiepolaczona: rule("Temperatura", "Brak odczytu temperatury wody", "ostrzezenie", [], 30),
    zaCieplo: rule("Pogoda", "Za ciepło na śnieg podczas pracy", "ostrzezenie", ["mokryMaxC"], 600, 600),
    silnyWiatr: rule("Pogoda", "Silny wiatr podczas pracy", "ostrzezenie", ["porywMaxKmh"], 0, 1800),
    pogodaNieaktualna: rule(
      "Pogoda",
      "Brak aktualnych danych pogodowych",
      "ostrzezenie",
      ["pogodaWaznaMin"],
      60,
      60,
      false,
      false,
    ),
    nd20Niepolaczony: rule("Agregat", "Brak komunikacji z ND20", "ostrzezenie", [], 30, 60, false, false),
    polecenieOdrzucone: rule("Łączność", "Polecenie z aplikacji odrzucone", "ostrzezenie", [], 0, 60, true),
  };
  const METRICS = {};
  const metric = (id, title, unit, source, min, max) => {
    METRICS[id] = { title, unit, source, min, max };
  };
  metric("poziomWodyProc", "Poziom wody", "%", "woda", 0, 100);
  metric("poziomWodyCm", "Wysokość słupa wody", "cm", "woda", 0, 250);
  metric("poziomWodyMa", "Prąd sondy", "mA", "woda", 0, 30);
  metric("temperaturaWody", "Temperatura wody", "°C", "temperatura", -55, 125);
  for (const [id, title, unit, max] of [
    ["moc", "Moc falownika", "kW", 500],
    ["prad", "Prąd falownika", "A", 2000],
    ["napiecie", "Napięcie falownika", "V", 1000],
    ["czestotliwoscWyjsciowa", "Częstotliwość wyjściowa", "Hz", 100],
  ])
    metric(id, title, unit, "falownik", 0, max);
  for (const [field, title, unit, min, max] of [
    ["mocKw", "Moc agregatu", "kW", -500, 500],
    ["czestotliwoscHz", "Częstotliwość agregatu", "Hz", 0, 100],
    ["pf", "Współczynnik mocy agregatu", "", -1, 1],
    ...["L1", "L2", "L3"].flatMap((p) => [
      ["napiecie" + p, "Napięcie " + p, "V", 0, 1000],
      ["prad" + p, "Prąd " + p, "A", 0, 2000],
    ]),
    ...["L1L2", "L2L3", "L3L1"].map((p) => ["napiecie" + p, "Napięcie " + p, "V", 0, 1000]),
  ])
    metric("nd20." + field, title, unit, "nd20", min, max);
  for (const [field, title, unit, min, max] of [
    ["temperatura", "Temperatura powietrza", "°C", -60, 60],
    ["wilgotnosc", "Wilgotność", "%", 0, 100],
    ["cisnienie", "Ciśnienie atmosferyczne", "hPa", 500, 1200],
    ["wiatr", "Wiatr", "km/h", 0, 300],
    ["poryw", "Porywy wiatru", "km/h", 0, 300],
    ["opadDzienny", "Opad dzienny", "mm", 0, 1000],
    ["uv", "Indeks UV", "", 0, 30],
    ["promieniowanie", "Promieniowanie słoneczne", "W/m²", 0, 2000],
  ])
    metric("pogoda." + field, title, unit, "pogoda", min, max);
  const levels = ["info", "ostrzezenie", "awaria", "auto"];
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  function defaults() {
    return {
      wersja: 1,
      progi: Object.fromEntries(Object.entries(PROGI).map(([k, p]) => [k, p.value])),
      reguly: Object.fromEntries(
        Object.entries(RULES).map(([k, r]) => [
          k,
          { wlaczony: r.enabled, poziom: r.severity, push: true, opoznienieS: r.delay, zakonczenieS: r.clear },
        ]),
      ),
      wlasne: {},
    };
  }
  function validate(c) {
    if (
      !c ||
      c.wersja !== 1 ||
      !c.progi ||
      !c.reguly ||
      (c.wlasne && (typeof c.wlasne !== "object" || Array.isArray(c.wlasne)))
    )
      return "Nieprawidłowy format ustawień.";
    for (const [key, p] of Object.entries(PROGI))
      if (!finite(c.progi[key]) || c.progi[key] < p.min || c.progi[key] > p.max)
        return `${p.label}: zakres ${p.min}–${p.max} ${p.unit}.`;
    if (Object.keys(c.progi).some((k) => !PROGI[k])) return "Nieznany próg.";
    if (c.progi.sondaMinMa >= c.progi.sondaMaxMa) return "Minimalny prąd sondy musi być mniejszy od maksymalnego.";
    if (c.progi.poziomNiski >= c.progi.poziomWysoki) return "Niski poziom musi być mniejszy od wysokiego.";
    if (c.progi.tempAwaria > c.progi.tempOstrzezenie)
      return "Próg zamarzania musi być niższy lub równy progowi zimnej wody.";
    const validRule = (r) =>
      r &&
      typeof r.wlaczony === "boolean" &&
      levels.includes(r.poziom) &&
      typeof r.push === "boolean" &&
      finite(r.opoznienieS) &&
      r.opoznienieS >= 0 &&
      r.opoznienieS <= 7200 &&
      finite(r.zakonczenieS) &&
      r.zakonczenieS >= 0 &&
      r.zakonczenieS <= 7200;
    for (const k of Object.keys(RULES))
      if (!validRule(c.reguly[k])) return `Nieprawidłowe ustawienia: ${RULES[k].title}.`;
    if (Object.keys(c.reguly).some((k) => !RULES[k])) return "Nieznana reguła.";
    if (Object.keys(c.wlasne || {}).length > 30) return "Możesz ustawić maksymalnie 30 własnych alertów.";
    for (const [id, r] of Object.entries(c.wlasne || {})) {
      const m = METRICS[r?.pomiar];
      if (
        !/^[a-zA-Z0-9_-]{1,80}$/.test(id) ||
        !validRule(r) ||
        !m ||
        !["lt", "gt"].includes(r.operator) ||
        !finite(r.prog) ||
        r.prog < m.min ||
        r.prog > m.max ||
        typeof r.tylkoPraca !== "boolean" ||
        typeof r.tytul !== "string" ||
        !r.tytul.trim() ||
        r.tytul.length > 100
      )
        return "Sprawdź nazwę, pomiar i próg własnego alertu.";
    }
    return "";
  }
  function metricValue(s, id, t, weatherAgeMin = 12) {
    const m = METRICS[id];
    if (!m || !s) return null;
    const fresh = (stamp, maxAge) => finite(stamp) && t - stamp >= -60000 && t - stamp < maxAge;
    if (m.source === "nd20") {
      if (!s.nd20?.polaczony || !fresh(s.nd20.aktualizacja, 15000)) return null;
    } else if (m.source === "pogoda") {
      if (!fresh(Number(s.pogoda?.czasPomiaru || s.pogoda?.pobrano), weatherAgeMin * 60000)) return null;
    } else if (
      !fresh(s.aktualizacja, 30000) ||
      (m.source === "woda" && s.sondaPolaczona !== true) ||
      (m.source === "temperatura" && s.temperaturaWodyPolaczona !== true) ||
      (m.source === "falownik" && s.polaczony !== true)
    )
      return null;
    const v =
      id === "poziomWodyCm"
        ? finite(s.poziomWodyProc)
          ? s.poziomWodyProc * 2.5
          : null
        : id.split(".").reduce((obj, key) => obj?.[key], s);
    return finite(v) ? v : null;
  }
  const schema = { PROGI, RULES, METRICS, defaults, validate, metricValue };
  root.POMPA_ALARM_SCHEMA = schema;
  if (typeof module !== "undefined" && module.exports) module.exports = schema;
})(globalThis);

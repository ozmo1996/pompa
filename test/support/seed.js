// Przykładowe dane bazy dla testów w przeglądarce — realistyczny stan pracującej pompy.
export function seedData(now = Date.now(), { fresh = true } = {}) {
  const t = fresh ? now - 3000 : now - 10 * 60000;
  const historia = {},
    historiaPogody = {};
  for (let i = 0; i < 24 * 60; i += 2) {
    const czas = now - (24 * 60 - i) * 60000,
      pracuje = i > 600,
      poziom = 60 + 25 * Math.sin(i / 180);
    historia["h" + i] = {
      czas,
      poziom: Math.round(poziom * 10) / 10,
      mA: 4 + (poziom / 100) * 16,
      m3: poziom * 12,
      temperaturaWody: 3 + Math.sin(i / 300),
      falownikPolaczony: true,
      pracuje,
      hz: pracuje ? 42 : 0,
      hzZadana: pracuje ? 42 : 0,
      prad: pracuje ? 120 : 0,
      napiecie: 400,
      moc: pracuje ? 70 + (i % 7) : 0,
    };
    if (i % 10 === 0)
      historiaPogody["p" + i] = {
        czas,
        pogoda: { temperatura: -4 + Math.sin(i / 200) * 3, wilgotnosc: 70, cisnienie: 1013, wiatr: 8, poryw: 15 },
      };
  }
  return {
    pompa: {
      status: {
        aktualizacja: t,
        polaczony: true,
        pracuje: true,
        awaria: false,
        czestotliwoscWyjsciowa: 42,
        czestotliwoscZadana: 42,
        prad: 120,
        napiecie: 400,
        moc: 72.4,
        energia: 12345.6,
        limitAktywny: false,
        poziomWodyProc: 64.2,
        poziomWodyM3: 770.4,
        poziomWodyMa: 14.27,
        temperaturaWody: 3.4,
        pogoda: {
          stacja: "IBYSTR6",
          pobrano: t,
          temperatura: -5.2,
          odczuwalna: -9.1,
          wilgotnosc: 68,
          cisnienie: 1016.3,
          wiatr: 9.4,
          poryw: 18.2,
          kierunekWiatru: 250,
          opadDzienny: 0,
          uv: 0,
          promieniowanie: 12,
        },
      },
      ustawienia: { limitMocy: { wlaczony: true, kw: 85, minHz: 35 } },
      historia,
      historiaPogody,
      zdarzenia: { e1: { czas: now - 3600e3, opis: "Uruchomienie pompy" } },
      alarmy: {
        a1: {
          czas: now - 7200e3,
          poziom: "ostrzezenie",
          tytul: "Nagły spadek poziomu",
          opis: "−5 % w 2 min",
          zakonczono: now - 7000e3,
        },
        a2: { czas: now - 600e3, poziom: "awaria", tytul: "Awaria falownika", opis: "Kod F0001", aktywny: true },
      },
    },
  };
}

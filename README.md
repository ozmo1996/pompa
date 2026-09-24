# pompa

Mobilny panel instalacji naśnieżania: podgląd zbiornika, pogody i falownika pompy (90 kW) oraz zdalne sterowanie.
Aplikacja jest statyczną stroną (PWA) bez budowania i bez własnego serwera. Całą komunikację z Raspberry Pi
prowadzi przez Firebase Realtime Database.

```
Telefon (PWA) ⇄ Firebase Realtime Database ⇄ Raspberry Pi ⇄ falownik · sonda poziomu 4–20 mA · stacja pogodowa
                └─ Firebase Cloud Messaging (powiadomienia o alarmach, wysyła Raspberry)
```

## Struktura

| Plik | Rola |
| --- | --- |
| `index.html` | Szkielet strony (znaczniki, bez logiki) |
| `styles.css` | Wszystkie style; sekcje w kolejności kaskady |
| `config.js` | **Jedyne miejsce konfiguracji**: Firebase, wersja SDK, klucz VAPID, dane silnika, progi ostrzeżeń |
| `js/main.js` | Start: ładowanie Firebase, logowanie, subskrypcje bazy, odświeżanie co 5 s |
| `js/state.js` | Wspólny stan, czas serwera, przełączanie zakładek |
| `js/logic.js` | Czysta logika bez DOM (świeżość danych, moc, prognozy, walidacja, cykle) — testowana jednostkowo |
| `js/sensors.js` | Zakładka „Czujniki” i nagłówek połączenia |
| `js/control.js` | Zakładka „Sterowanie”: polecenia, limit mocy, licznik mocy |
| `js/stats.js`, `js/history.js` | Statystyki i pamięć podręczna historii (dociąganie tylko brakujących danych) |
| `js/paramChart.js` | Wykres 6 h po dotknięciu parametru |
| `js/alarms.js`, `js/push.js` | Alarmy i powiadomienia push |
| `js/heartbeat.js` | „Puls pogody” — częstsze pobieranie pogody, gdy aplikacja jest otwarta |
| `js/notes.js` | Notatki i zadania z opcjonalnym terminem, wspólne dla zalogowanych urządzeń |
| `firebase-messaging-sw.js` | Service worker: powiadomienia w tle i praca bez sieci |
| `test/` | Testy logiki (`node --test`) i scenariusze w przeglądarce z atrapą Firebase |

Zmiana wersji Firebase SDK, mocy silnika czy progów ostrzeżeń to zmiana jednej wartości w `config.js`.
Przy każdym wdrożeniu podnieś `wersja` w `config.js`, bo od niej zależy odświeżenie pamięci service workera.

## Zasady bezpieczeństwa sterowania

- **Stop** działa zawsze, gdy aplikacja ma połączenie z bazą, także przy nieaktualnych danych z Raspberry
  i przy awarii falownika. Nie wymaga potwierdzenia.
- **Start i zmiana częstotliwości** wymagają świeżych danych (status młodszy niż 30 s), połączonego falownika
  i braku awarii. Start pompy oraz duży skok częstotliwości albo zbliżenie do limitu mocy wymagają potwierdzenia.
  Po potwierdzeniu stan jest sprawdzany ponownie, zanim polecenie zostanie wysłane.
- Świeżość danych jest liczona według **czasu serwera Firebase** (`.info/serverTimeOffset`), więc źle ustawiony
  zegar telefonu nie sprawia, że stare dane wyglądają na aktualne (ani odwrotnie).
- Każde polecenie ma unikalne `id` i czeka 20 s na potwierdzenie z Raspberry. Bez potwierdzenia aplikacja prosi
  o sprawdzenie stanu przed ponowieniem.

## Kontrakt danych z Raspberry Pi

Aplikacja **czyta**:

| Ścieżka | Zawartość |
| --- | --- |
| `pompa/status` | `aktualizacja` (ms), `polaczony`, `pracuje`, `awaria`, `kodAwarii`, `czestotliwoscWyjsciowa`, `czestotliwoscZadana`, `czestotliwoscCel`, `limitAktywny`, `prad`, `napiecie`, `moc` (kW), `energia` (kWh), `poziomWodyProc`, `poziomWodyM3`, `poziomWodyMa`, `temperaturaWody`, `alarmPoziomu`, `pogoda{stacja, pobrano\|czasPomiaru, temperatura, odczuwalna, wilgotnosc, cisnienie, wiatr, poryw, kierunekWiatru, opadDzienny, uv, promieniowanie}` |
| `pompa/historia/*` | co ok. 1 min: `czas`, `poziom`, `mA`, `m3`, `temperaturaWody`, `falownikPolaczony`, `pracuje`, `hz`, `hzZadana`, `prad`, `napiecie`, `moc` |
| `pompa/historiaPogody/*` | `czas`, `pogoda{…}` jak w statusie |
| `pompa/zdarzenia/*` | `czas`, `opis` lub `typ` |
| `pompa/alarmy/*` | `czas`, `poziom` (`awaria` / `ostrzezenie` / `info`), `tytul`, `opis`, `aktywny`, `zakonczono`, `zdarzenie`, `potwierdzono`, `potwierdzil` |

Aplikacja **zapisuje**:

| Ścieżka | Zawartość |
| --- | --- |
| `pompa/polecenie` | `{id, akcja: "start" \| "czestotliwosc" \| "stop", czestotliwosc?, czas, wazneDo}`. Raspberry odpowiada, dopisując `wykonane: true/false` i ewentualnie `blad` |
| `pompa/ustawienia/limitMocy` | `{wlaczony, kw, minHz, zmieniono, zmienil}` |
| `pompa/ustawienia/pogoda/aktywnaDo` | czas (ms) do którego Raspberry ma pobierać pogodę co 30 s |
| `pompa/alarmy/<id>/potwierdzono`, `…/potwierdzil` | potwierdzenie alarmu |
| `pompa/tokeny/<skrót>` | token FCM urządzenia i preferencje (`ostrzezenia`) |
| `pompa/testPowiadomienia` | `{uid, czas}`; Raspberry dopisuje `wynik` |

Wszystkie znaczniki czasu zapisywane przez aplikację są w czasie serwera Firebase.

**Zalecenie dla Raspberry:** odrzucaj polecenia, dla których aktualny czas przekracza `wazneDo`. Firebase
kolejkuje zapisy wykonane bez zasięgu i może je dostarczyć dopiero po odzyskaniu połączenia. Pole `wazneDo`
pozwala nie wykonać spóźnionego „Start”.

Reguły bezpieczeństwa bazy (`database.rules.json`) nie są częścią tego repozytorium.
Regułę dla `pompa/notatki` instaluje `scripts/deploy-notes-rules.cjs`, zachowując pozostałe reguły.
Notatki zapisują: temat, opis, opcjonalny termin, autora i stan wykonania. Termin jest wyróżniany
w aplikacji po upływie; nie wysyła powiadomienia w tle. Wysokość wody w centymetrach jest liczona
z procentów przy zakresie 250 cm ustawionym w `config.js`; wynik wymaga końcowej kalibracji sondy.

## Testy

```bash
npm install          # Playwright i Prettier (tylko do testów)
npm test             # logika (node --test)
npm run test:e2e     # scenariusze w Chromium z atrapą Firebase: brak sieci, stare dane, zły zegar, brak uprawnień…
```

Testy uruchamia też GitHub Actions (`.github/workflows/test.yml`).

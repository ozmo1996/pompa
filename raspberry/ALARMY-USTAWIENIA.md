# Ustawienia alarmów v2.19

Aplikacja: zakładka Alarmy → Ustawienia alertów, ostrzeżeń i awarii.
26 reguł wbudowanych, progi i ważność oraz do 30 własnych alertów dla dostępnych pomiarów.
Informacje pozostają w dzienniku. Ostrzeżenia i awarie korzystają z preferencji push danego telefonu.
Wyłączenie reguły zamyka jej bieżący alarm. Zmiana ważności aktualizuje bieżący incydent, bez tworzenia duplikatu.
Ustawienia nie zmieniają zabezpieczeń falownika ani poleceń sterujących pompą.

Własne alerty mają operator poniżej/powyżej, próg, opóźnienie, czas zakończenia i opcję tylko podczas pracy.
Odczyty offline lub nieaktualne nie są traktowane jako zero.
Progi skoków mocy, okno porównania i tolerancja częstotliwości są wspólne dla odpowiednich reguł.

## Wdrożenie Raspberry

Pliki `alarmy.js`, `alarm-schema.js`, `alarm-rules.js`, `deploy-alarm-rules.js` do `/home/pi/pompa-alarmy/`.
Istniejący `serviceAccount.json`, zależności i jednostka `pompa-alarmy.service` pozostają na miejscu.
Przed zastąpieniem `alarmy.js` zachować kopię. Wykonać `node --check alarmy.js`.
Z katalogu serwisu wykonać `node deploy-alarm-rules.js --apply`, potem `sudo systemctl restart pompa-alarmy`.
Skrypt zapisuje kopię całych reguł przed zmianą tylko `pompa/ustawienia/alarmy`.

Konfiguracja: `pompa/ustawienia/alarmy`, wersja schematu 1; `id` jest identyfikatorem zapisu.
Serwis potwierdza jej stosowanie w `pompa/statusAlarmow` co 30 sekund (`ustawieniaId`, `wersja`, `aktualizacja`).
Aplikacja używa transakcji, aby nie nadpisać zmian z innego urządzenia.
Brak konfiguracji oznacza domyślne progi. Nowe alarmy braku ND20 i starej pogody domyślnie są wyłączone.

## Kontrola

Testy `raspberry/alarm-config.test.js` sprawdzają realne warunki, opóźnienia, wyłączenia i ważność.
Testy przeglądarki sprawdzają zapis, konflikty i układ mobilny.
Kontrolować log `journalctl -u pompa-alarmy`, potwierdzenie `statusAlarmow` oraz uprawnienia do zapisu ustawień.

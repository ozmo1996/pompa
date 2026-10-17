# Niski poziom wody — v2.26

Ustawienia: `pompa/ustawienia/zabezpieczenieWody`. Progi w cm przy dotychczasowej kalibracji 0–250 cm (1% poziomu = 2,5 cm). Nie jest to procent objętości. STOP i ostrzeżenia są niezależne; nowe ustawienia domyślnie mają obie funkcje wyłączone. 25/50 cm to przykłady, nie potwierdzone bezpieczne minimum instalacji.

`WaterSafety` działa w głównym procesie Raspberry, przez ten sam mutex falownika co regulator ciśnienia i limit mocy. Nie powstaje konkurencyjny proces sterujący RS485. Co 500 ms sprawdza lokalny stan. Gdy STOP włączony: aktualny poziom ≤ stopCm lub brak ważnej próbki sondy przez 5 s podczas pracy wywołuje STOP. Ważność liczona z `aktualizacjaPoziomu`, nie ogólnego heartbeat. Nieudana komenda jest ponawiana. Zatrzask i ustawienia atomowo zapisywane do `water-safety-state.json` (0600); po utracie sieci działa ostatnia kopia lokalna. Nie ma automatycznego rozruchu.

Kasowanie: nowy `resetId`, potwierdzona komunikacja z zatrzymanym falownikiem i świeży poziom > stopCm + 5 cm, chyba że STOP celowo wyłączony. Sam wzrost poziomu, zwykły zapis, wyłączenie czy restart nie kasują blokady. Kasowanie również nie wysyła START. Ustawienia chronione rolą `uprawnieni` i walidacją progów. Zapis formularza transakcyjny (konflikty drugiego urządzenia).

Ostrzeżenie podczas pracy przy poziomie ≤ ostrzezenieCm, gaśnie dopiero ponad ostrzezenieCm + 5 cm lub po zatrzymaniu. Baner i komunikat w aplikacji; osobny serwis alarmów zapisuje historię i wysyła push według preferencji urządzenia. Brak sieci uniemożliwia nowe zdalne komunikaty, ale nie lokalny STOP.

Wdrożenie wymaga `water-safety.js`, `water-safety-schema.js`, nowego `pressure-control-runtime.js` w `/home/pi/pompa/` i nowego `alarmy.js` w `/home/pi/pompa-alarmy/`. Reguły wdraża `deploy-water-safety.js` (z `water-safety-rules.js`) z kopią i ETag. Restart głównej usługi wyłącznie na postoju; sprawdzić, czy automat ciśnienia nie zgłasza wznowienia po restarcie. Nie uruchamiać pompy w ramach wdrożenia.

Pierwszą próbę wykonać pod nadzorem przy bezpiecznym poziomie, sprawdzając sondę niezależnie. Nie obniżać poziomu do suchobiegu, aby testować program. To nie jest niezależny certyfikowany układ zabezpieczenia; wymagane zabezpieczenia fizyczne i właściwy próg uwzględniający zanurzenie wlotu, falowanie, kalibrację oraz czas zatrzymania.

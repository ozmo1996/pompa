# Zmiany 2.31 — zakres 0–50 Hz, dwa zatrzymania, temperatura

Wdrożenie tylko po fizycznym potwierdzeniu postoju pompy. Nie uruchamiać silnika automatycznie.
Przed aktualizacją zatrzymać pompa i pompa-alarmy, uruchomić instalator z --check,
następnie --apply-stopped. Instalator zapisuje kopie w prywatnym backup-drive-*.
Reguły i migracja minimum: deploy-pressure-control.js --apply --minimum-zero.
Nie zmieniać parametrów nieulotnych falownika ani sprzętowych zabezpieczeń.

- Zatrzymaj: zapis 0 do 40009, zdjęcie STF, hamowanie wg aktualnej rampy Pr.8.
  Nie zmieniamy Pr.8 bez pomiarów hydrauliki; nie gwarantujemy czasu hamowania.
- STOP: po sprawdzeniu Pr.17=0 oraz Pr.187=24 zapis 1024 do 40009 (MRS).
  Wyjście odłączone, ale silnik wybiega. Nie jest to gwarancja natychmiastowego zatrzymania wału
  ani funkcja bezpieczeństwa E-STOP. Nie resetujemy MRS automatycznie. Następny ręczny START
  zapisuje zwykłe STF; MRS pozostaje do tego czasu aktywne.
- Przy niepotwierdzonym przypisaniu MRS wysyłamy zwykłe zatrzymanie i zgłaszamy błąd,
  zamiast deklarować skuteczne odcięcie wyjścia. Falownik offline uniemożliwia weryfikację MRS.
- Pola trybStop dotyczą tylko akcji stop i są walidowane przez Firebase.
- Regulator, limit oraz walidacja przyjmują 0–50 Hz. RUN=0 przy małej częstotliwości
  nie odbiera uzbrojenia regulatora. Wyłącznie ręczny Start uzbraja regulator.
- Brak narastania ciśnienia liczony jest przez 10 s rzeczywistej pracy od 35 Hz, nie od
  uruchomienia rampy z zera. Ten próg diagnostyczny nie jest minimum regulacji.
- Podczas hamowania operatora regulator nie podnosi Hz i nie zgłasza braku uzbrojenia.
- DS18B20: do 3 prób, każda z kontrolą CRC i limitem 1,5 s. Po błędach stan niepołączony,
  brak udawania świeżej temperatury. Ponowienia łagodzą sporadyczne błędy, nie naprawiają
  zakłóconego przewodu, zasilania, masy ani rezystora podciągającego.
- Testy bez uruchamiania urządzeń nie zastępują próby hamowania i strojenia pod nadzorem.

Źródła: instrukcja Mitsubishi FR-F700 Applied, ib0600177engf, rejestr 40009, Pr.17,
Pr.187 oraz mapowanie parametrów 41000 + numer Pr.

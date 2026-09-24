# Lumel ND20 — przygotowanie portu 3 i schemat agregatu

Źródło: [instrukcja ND20 Lumel, rys. 4 oraz rozdział 8](https://www.lumel.com.pl/resources/Pliki%20do%20pobrania/ND20/ND20_instrukcja_obslugi.pdf). Dotyczy **ND20**, nie ND20CT/ND20Lite. Przed podaniem napięcia potwierdzić pełny kod wykonania z tabliczki, dopuszczalne napięcie zasilania/wejść, wariant 1 A albo 5 A i układ agregatu (3P+N czy 3P bez N).

## Strona danych (niskie napięcie)

```text
Raspberry Pi — czteroportowy USB/RS-485 — kanał C3
  /dev/serial/by-id/usb-WCH.CN_USB_Quad_Serial_BDFFD2ABCD-if04
  A  ────────────────────────────────────── ND20: 18 (A)
  B  ────────────────────────────────────── ND20: 19 (B)
  GND sygnałowy ─────────────────────────── ND20: 20 (GNDI), jeśli adapter zapewnia GND
```

Nie łączyć GNDI z PE ani z N agregatu na podstawie tego schematu. Jeśli brak komunikacji, najpierw sprawdzić oznaczenia A/B na obu urządzeniach (producenci stosują różne konwencje), a nie przepinać obwodów mocy. Domyślne ustawienia ND20: adres 1, 9600 bit/s, 8N2. Na Raspberry C3 to `if04` / `/dev/ttyACM2`; C1 i C2 pozostają bez zmian.

## Strona energetyczna — wariant poglądowy 3 × 230/400 V, 3P+N

```text
                   wyjście agregatu → zabezpieczenia/rozdzielnica → odbiory
L1 ───────[przekładnik CT1, P1→P2]───────────────┬─ tor L1
L2 ───────[przekładnik CT2, P1→P2]───────────────┬─ tor L2
L3 ───────[przekładnik CT3, P1→P2]───────────────┬─ tor L3
 N ───────────────────────────────────────────────┬─ tor N
                  │ pomiar napięć przez właściwie dobrane zabezpieczenia
                  └─ ND20: L1→9, L2→8, L3→7, N→11

CT1/CT2/CT3: wtórne S1/S2 → odpowiadające wejścia prądowe ND20
                 przez listwę zwarciową przekładników; zgodnie z rys. 4
ND20: zasilanie pomocnicze → zaciski 27–26, tylko w zakresie
      przewidzianym dla konkretnego kodu wykonania miernika
```

**Nie podłączać wyjścia agregatu do wejść prądowych ND20 bez przekładników.** Dobrać CT do prądu znamionowego agregatu i wejścia ND20 (1 A lub 5 A), ustawić w mierniku przekładnię `tr_I`, tryb `3Ph/4W` i właściwy zakres napięciowy. Nie rozłączać obwodu wtórnego CT przy pracującym agregacie — przed odłączeniem miernika zewrzeć wtórne na dedykowanej listwie. Montaż, zabezpieczenia pomiarowe, sposób uziemienia i próby należy zlecić elektrykowi z odpowiednimi kwalifikacjami.

Jeśli agregat jest **3-przewodowy, bez N** albo ma inne napięcie (np. 3 × 400 V bez neutralnego), powyższy wariant napięciowy **nie obowiązuje**. Użyć schematu `3Ph/3W` z instrukcji i dobrać przekładniki napięciowe, jeśli wymagane przez zakres konkretnego ND20. Nie mostkować zacisku N z PE.

## Uruchomienie po wykonaniu połączeń

1. Elektryk potwierdza tabliczki ND20, agregatu i CT oraz pomiary przed załączeniem.
2. Na ND20 ustawia właściwy układ 3Ph/4W albo 3Ph/3W, zakres napięcia, przekładnie CT/VT oraz 9600, 8N2, adres 1.
3. W `/home/pi/pompa/config.json` zmienić tylko `nd20.wlaczony` na `true` po montażu.
4. Jednorazowo zainstalować wgrany już plik usługi: `sudo install -m 644 /home/pi/pompa/pompa-nd20.service /etc/systemd/system/pompa-nd20.service` i `sudo systemctl daemon-reload`. Usługa nie jest włączona automatycznie podczas przygotowania.
5. Uruchomić `sudo systemctl enable --now pompa-nd20`; sprawdzić `systemctl status pompa-nd20` oraz `journalctl -u pompa-nd20 -n 30`.
6. Porównać U, I, Hz, kW i kierunek przepływu mocy z wyświetlaczem ND20. Dane pojawiają się pod `pompa/status/nd20`; nie sterują pompą ani limitem mocy.

Przygotowany sterownik używa wyłącznie funkcji Modbus 03 (odczyt). Nie zapisuje nastaw miernika. Do uruchomienia produkcyjnego konieczne są wyniki porównania z wyświetlaczem ND20.

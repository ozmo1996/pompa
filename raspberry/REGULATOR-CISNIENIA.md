# Opcjonalny regulator ciśnienia — v2.24

Regulator jest wdrażany **wyłączony**. Cel 25 bar, minimum 35 Hz, maksimum 50 Hz,
próg STOP 32 bar to nastawy startowe, nie potwierdzone strojenie instalacji.
Zakres ciśnienia zadanego: 5–30 bar. Próg STOP musi być co najmniej 2 bar ponad
celem i nie większy niż 32 bar (dotychczas podane maksimum pracy instalacji).

## Praca

W zakładce Sterowanie włącz przełącznik, ustaw parametry i zapisz. Nowy tryb i
granice Hz zmieniaj na postoju. Sam zapis nigdy nie uruchamia pompy. Ręczny Start
uruchamia ją od minimum Hz. Ciśnienie jest mierzone na tłoczeniu, nie przy armacie.
W czasie regulacji ręczna zmiana Hz jest odrzucana także przez Raspberry.
STOP pozostaje niezależny od przełącznika. Wyłączenie automatu pozostawia aktualne
Hz, zamiast wracać skokowo do dawnego celu użytkownika. Zmiana celu w pracy jest
obsługiwana z tym samym ograniczeniem tempa, bez bezpośredniego skoku Hz.

Regulator działa w procesie `/home/pi/pompa/index.js`, bez telefonu i bez
oczekiwania na Firebase. Po restarcie nie uzbraja się sam: jeśli falownik nadal
pracuje w trybie automatycznym, wysyła STOP i zatrzaskuje blokadę.

## Pomiar i arbitraż

- N4AIA04 V1 + dotychczasowe C2 są czytane jednym zapytaniem FC03 (0–3) co około 1 s.
- Pętla falownika również pracuje z przerwą 1 s; rzeczywisty okres zawiera czas komunikacji.
- Proporcjonalne, przyrostowe korekty, bez całki; filtr EMA, strefa ±0,3 bar.
- Regulator zmienia zadane Hz najwyżej o 0,2 na krok, nie częściej niż co 1 s.
- Istniejący limit mocy ma pierwszeństwo i może szybciej obniżać Hz.
  Wymagane w automacie: włączony limit 10–90 kW, minimum limitu ≥35 Hz i ≤minimum regulatora.
- Gdy moc jest blisko limitu (3 kW), regulator nie zwiększa Hz. Nie kumuluje błędu.
- Powstaje tylko jedno końcowe polecenie Hz; automat nie nadpisuje korekty limitu kW.
- Wspólna kolejka zabezpiecza transakcje Modbus falownika przed równoległym wykonaniem.
- Firebase i dziennik nie blokują kolejki sterowania. Watchdog sprawdza czujnik co 0,5 s.

## Zatrzymanie i blokada

STOP przy: ciśnieniu ≥progu, nieprawidłowym V1 lub pomiarze starszym niż 3 s,
utracie komunikacji/awarii falownika, niepoprawnej częstotliwości, braku mocy
po rozruchu, wyłączonym limicie kW, ciśnieniu <2 bar po 10 s albo braku osiągnięcia
celu przez 60 s przy maksimum Hz. Niepotwierdzony STOP jest ponawiany.
Zatrzask zapisuje się atomowo w `pressure-control-state.json`; błąd zapisu również blokuje automat.
Kasowanie: wyłącz tryb, poczekaj na odczyt potwierdzający postój, usuń przyczynę,
włącz tryb i osobno użyj Start. Sam powrót czujnika lub Internetu nie wznawia pompy.

Nastawy: `pompa/ustawienia/regulatorCisnienia`. Potwierdzenie i blokada:
`pompa/statusRegulatoraCisnienia`. Uprawnienia tylko dla istniejących kont `uprawnieni`;
reguły RTDB walidują liczby, zakresy i zależności. Usunięcie ustawień przez aplikację zabronione.

## Granice bezpieczeństwa i pierwsze uruchomienie

Testy automatyczne i symulacja **nie zastępują próby na instalacji**. Szybszy
odczyt nie usuwa opóźnień RS485, rampy falownika, bezwładności hydrauliki ani uderzeń wodnych.
Regulator nie wykryje wiarygodnie czujnika, który zablokował się na pozornie poprawnym napięciu.
Nie zagwarantuje zatrzymania przy awarii Raspberry, komunikacji lub układu wykonawczego.
Wymagane są niezależne sprzętowe zabezpieczenia nadciśnieniowe i silnikowe.
Przed włączeniem: porównaj V1 z manometrem w kilku punktach, sprawdź zawory/przepływ,
minimum Hz, próg STOP i limit mocy. Pierwszy rozruch pod nadzorem, z możliwością
lokalnego odłączenia. W razie oscylacji nie kontynuuj automatu — wymagane strojenie.

Wdrożenie nie uruchamia pompy i nie testuje fizycznego osiągania 25 bar.

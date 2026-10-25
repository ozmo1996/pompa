# Liczniki i zapis lokalny — v2.39

## Zachowanie

- Sumy całkowite kWh i m³ zawsze pozostają w telemetry.db. Zerowanie zmienia tylko punkt odniesienia wskazania okresowego.
- Aplikacja wymaga potwierdzenia oraz wpisania ZERUJ, a następnie czeka na potwierdzenie Raspberry. Można wybrać wodę, energię pompy, energię agregatu lub wszystkie trzy.
- Prośba ma UUID, autora i krótki termin ważności. SQLite chroni przed powtórnym wykonaniem tej samej prośby także po restarcie.
- Audyt zerowania jest zachowany lokalnie i wysyłany do zdarzeń Firebase. Dane historyczne nie są kasowane ani przeliczane. Wykres m³ pozostaje licznikiem całkowitym.
- Ciśnienie ssania jest wspólną, potwierdzaną konfiguracją. Jego zmiana rozpoczyna nowy segment szacunku, a historyczne rekordy zachowują dawny parametr i identyfikator konfiguracji.

## Offline

ZapisStatusu publikuje niezależnie od Firebase do prywatnego katalogu RAM /dev/shm/pompa-UID/status.json. Odczyty falownika mają własny znacznik czasu. Żadne await zapisu pliku ani chmury nie zostało dodane do regulatora.

Proces pomiarowy czyta ten lokalny strumień, sumuje i archiwizuje w SQLite. Osobna wysyłka opróżnia trwałą kolejkę; oczekująca operacja Firebase nie zatrzymuje odczytów ND20 ani sumowania.

Brak lub nieaktualność źródła oznacza lukę, a nie doliczenie fikcyjnego zużycia. Przerwa w zasilaniu lub awaria samego pomiaru nadal może powodować niedoszacowanie. Szacunek przepływu nie zastępuje przepływomierza.

## Miejsce i historia

Funkcja nie włącza kasowania historii. Co 5 minut kontroluje wolny dysk i wielkość dwóch baz z WAL/SHM. Ostrzega przy mniej niż 15% wolnego miejsca lub mniej niż 2 GiB.

Limit 30 dni w interfejsie nie jest limitem archiwizacji. Niezależna kopia na innym nośniku nadal jest potrzebna przed jakąkolwiek polityką usuwania szczegółowych próbek. Kopii na tym samym nośniku nie należy traktować jako ochrony przed awarią karty.

## Wdrożenie

1. Fizyczny postój potwierdzony przez operatora.
2. Pobranie plików z konkretnego commitu i kontrola składni/sum.
3. deploy-counter-rules.cjs --apply: kopia reguł i zmiana tylko ustawienia/liczniki, wyłącznie dla uprawnionych kont.
4. install-measurements.cjs --check; --apply-stopped: kontrola znanych źródeł, kopia plików i restart wyłącznie pompa oraz pompa-nd20.
5. verify-measurements.cjs: próby w :memory: oraz odczyt bieżącego pliku lokalnego. Nie zeruje prawdziwych liczników, nie zapisuje do Modbus.
6. Sprawdzenie aktywności serwisów, logów i potwierdzeń Firebase. Historia i stare tabele nie są usuwane.

Poprawki nie zmieniają parametrów falownika, ochrony poziomu ani nastaw regulatora. Nie stanowią kalibracji pojemności zbiornika; do dokładnej analizy sezonowej potrzebny jest niezależny punkt odniesienia przepływu i bilans dopływu.

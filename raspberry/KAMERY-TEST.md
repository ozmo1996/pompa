# Kamery — odwracalny prototyp, niezależny od pompy

Status: kod testowy. Samo opublikowanie strony NIE uruchamia bramki, tunelu ani kamery.
Nie uznawać testów atrap za potwierdzenie obrazu na telefonie przez LTE.

Weryfikacja rzeczywista 2026-10-17: obraz z kamery odebrany w zalogowanej przeglądarce przez
publiczny Funnel HTTPS, poza LAN Raspberry. Zwykłe połączenie przez publiczny DNS bez tokenu
zwraca 401 i poprawny nagłówek CORS. Po zatrzymaniu odtwarzacza go2rtc potwierdziło 0 odbiorców.
Wszystkie cztery usługi pompy pozostały aktywne. Test na fizycznym telefonie przez LTE pozostaje
do wykonania przez użytkownika. Certyfikaty wymagają `--statedir`; poprawka istniejącego testu
jest w `repair-camera-tls.cjs` i restartuje tylko zweryfikowany testowy proces tailscaled.

Profil obrazu zweryfikowany 2026-10-17: dodatkowy strumień `subtype=2`, H.264 Main,
1280 × 720, 20 kl./s, CBR 1280 kb/s, GOP 20 (klatka kluczowa co sekundę), bez audio.
Pomiar go2rtc: 82 zdekodowane klatki w 4,1 s; rzeczywisty obraz HD odebrany przez Funnel.
Główny strumień 1080p i lekki `subtype=1` pozostają bez zmian. Odtwarzacz łagodnie koryguje
tempo przy odchyleniu bufora; wyświetlany bufor nie jest pomiarem pełnego opóźnienia kamery.
`tune-camera-test.cjs` zapisuje prywatną kopię ustawień i weryfikuje zapis oraz brak zmian
głównego strumienia. `camera-profile-test.cjs 2` przełącza wyłącznie testowy go2rtc na HD.
Pierwszy instalator nadal startuje z profilem 1; po jego ponownym uruchomieniu HD wymaga
ponownego wybrania profilu 2. Wycofanie obrazu: najpierw `camera-profile-test.cjs 1`,
następnie `tune-camera-test.cjs restore` w katalogu `/home/pi/pompa-kamery-test`.

Strona testu: `/pompa/beta/kamery/`. Produkcyjny index, style, config i service worker pozostają bez zmian.
Test nie rejestruje service workera, powiadomień, pulsu pogody ani zapisów do Firebase.
Logowanie korzysta z tego samego projektu Firebase i istniejącej sesji; wylogowanie z testu wylogowuje
również zwykłą aplikację w tej samej przeglądarce. Nie należy wpisywać tu hasła kamery.

## Połączenie testowe

Telefon → HTTPS → oddzielna bramka tylko do odczytu :1986 (localhost) → go2rtc :1984 (localhost) → kamera RTSP.

Wybrany tunel: Tailscale Funnel, tylko na Raspberry. Telefon nie wymaga VPN.
Instalator `install-camera-test.cjs` umieszcza zweryfikowane binaria we własnym katalogu 0700,
uruchamia tailscaled w trybie userspace bez roota i bez zmian DNS/tras.
`start-camera-test.cjs` uruchamia go2rtc i bramkę jako osobne procesy o niższym priorytecie.
Hasło kamery przekazywane jest jednorazowo przez ukryty `read -rs` i środowisko potomnego procesu,
nie zapisuje się go do konfiguracji. Nie wpisywać hasła w linię poleceń ani w link przeglądarki.
Procesy NIE startują po restarcie Raspberry. To celowy zakres pierwszego, odwracalnego testu.

- Bez przekierowania portów routera, publicznego RTSP i panelu administracyjnego go2rtc.
- Token Firebase wysyłany w nagłówku Authorization, nigdy w URL, localStorage lub logach aplikacji.
- Bramka sprawdza podpis, projekt, unieważnienie tokenu i `uprawnieni/<uid> === true`.
- Nie wystarczy ukrycie przycisku lub sama znajomość adresu. Brak tokenu/uprawnień blokuje transmisję.
- Maksymalnie 2 równoczesne transmisje; sesja do 15 minut lub wygaśnięcia tokenu.
- Klient nie wybiera dowolnego źródła: jedyny backendowy strumień pochodzi z lokalnej konfiguracji.
- H.264 i dokładny identyfikator kodeka muszą zostać potwierdzone w rzeczywistej kamerze.
- Testowy odtwarzacz wymaga MediaSource lub ManagedMediaSource. Starszy iPhone może nie być obsługiwany.
- Brak nagrywania i dźwięku. Po ukryciu strony, wylogowaniu lub zmianie zakładki żądanie jest przerywane.

## Konfiguracja prywatna na Raspberry (nie publikować)

Osobny katalog `/home/pi/pompa-kamery-test`, pliki konfiguracji 0600, katalog 0700.
`gateway.json` zawiera: `adminModule` (istniejąca ścieżka modułu firebase-admin), `serviceAccount`
(istniejący prywatny plik), `databaseURL`, `allowedOrigin: "https://ozmo1996.github.io"`,
`streamUrl: "http://127.0.0.1:1984/api/stream.mp4?src=kamera_test&video=h264"`,
`mime` w formacie `video/mp4; codecs="avc1.XXXXXX"` z rzeczywistego SPS kamery.
Nie wpisywać domyślnego/zgadywanego kodeka jako potwierdzonego.

go2rtc: `api.listen: "127.0.0.1:1984"`, `rtsp.listen: ""`, `webrtc.listen: ""`.
Tylko nazwany strumień `kamera_test` z potwierdzonym URL RTSP; dane dostępowe wyłącznie w lokalnym
prywatnym pliku go2rtc, bez publicznego API konfiguracji. Nie uruchamiać transkodowania CPU bez pomiaru
obciążenia i sprawdzenia wpływu na odczyty/zabezpieczenia pompy.

Tunel wystawia WYŁĄCZNIE bramkę 127.0.0.1:1986. Nie wystawia :1984, kamery :80/:554, SSH ani usług pompy.
Wybór usługi wymaga konta/domeny albo innego jawnie uzgodnionego sposobu publikacji; nie tworzymy
anonimowego publicznego podglądu. Nie zmieniać obecnych usług pompy i nie restartować ich podczas tego wdrożenia.

## Wycofanie

1. Wrócić do `/pompa/` — produkcja nie ma zależności od prototypu.
2. Uruchomić `node /home/pi/pompa-kamery-test/stop-camera-test.cjs`. Skrypt sprawdza PID i dokładny
   argument procesu w `/proc` przed wysłaniem SIGTERM; zatrzymuje tylko bramkę, go2rtc i testowy tailscaled.
   Nie usuwa plików ani danych. Nie zatrzymywać usług `pompa`, `pompa-alarmy`, `pompa-nd20`.
3. Cofnąć commit dodający wyłącznie `beta/kamery/`, kod i dokumentację testu. Niczego nie kasować z historii pomiarów.

## Kryteria odbioru przed wdrożeniem produkcyjnym

Obraz rzeczywisty na telefonie przy WYŁĄCZONYM Wi-Fi, zatrzymanie przesyłu przy wyjściu/w tle,
odmowa bez tokenu i dla konta bez uprawnień, odmowa `/api/config` i dowolnego źródła,
brak hasła/tokenów w URL/logach, brak portów poza localhost, obciążenie Pi i częstotliwości odczytów
niepogorszone, odłączenie kamery nie wpływa na pompę. Dopiero potem połączenie zakładki z główną aplikacją.

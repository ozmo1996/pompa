import { normalizeEndpoint, appendChunk } from "./camera-logic.js";

const $ = (id) => document.getElementById(id);
const video = $("cameraVideo");
let auth,
  api,
  active = null,
  objectUrl = null,
  endpoint = "",
  generation = 0;
const text = (message) => ($("message").textContent = message);
try {
  endpoint = normalizeEndpoint(localStorage.getItem("pompaCameraTestEndpoint") || "");
} catch {}
$("endpoint").value = endpoint;

function stop(message = "Podgląd zatrzymany.") {
  generation++;
  active?.abort();
  active = null;
  video.pause();
  video.removeAttribute("src");
  video.srcObject = null;
  video.load();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  $("placeholder").hidden = false;
  $("stop").disabled = true;
  $("play").disabled = !auth?.currentUser || !endpoint;
  $("connection").textContent = "Wyłączony";
  text(message);
}

async function play() {
  stop();
  if (!auth?.currentUser || !endpoint || document.hidden) return;
  const run = generation,
    controller = new globalThis.AbortController();
  active = controller;
  $("play").disabled = true;
  $("stop").disabled = false;
  $("connection").textContent = "Łączenie…";
  text("Sprawdzanie dostępu i pobieranie obrazu…");
  let lastFrame = Date.now();
  const timeout = setInterval(() => {
    if (Date.now() - lastFrame > 15000) stop("Brak świeżego obrazu. Sprawdź kamerę lub połączenie i spróbuj ponownie.");
  }, 1000);
  const progress = () => {
    lastFrame = Date.now();
  };
  video.addEventListener("timeupdate", progress);
  try {
    const token = await auth.currentUser.getIdToken();
    if (run !== generation) return;
    const response = await fetch(endpoint + "/stream", {
      headers: { Authorization: "Bearer " + token },
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        response.status === 401 || response.status === 403
          ? "Brak uprawnień do kamery. Zaloguj się ponownie lub sprawdź dostęp konta."
          : "Brak obrazu z bramki lub kamery.",
      );
    const mime = response.headers.get("Content-Type");
    const Source = window.ManagedMediaSource || window.MediaSource;
    if (!Source || !mime?.startsWith("video/mp4") || !Source.isTypeSupported(mime))
      throw new Error(
        "Ten telefon lub kodek kamery nie obsługuje jeszcze testowego odtwarzacza. Potrzebny jest strumień H.264.",
      );
    const media = new Source();
    if (window.ManagedMediaSource) {
      video.disableRemotePlayback = true;
      video.srcObject = media;
    } else {
      objectUrl = URL.createObjectURL(media);
      video.src = objectUrl;
    }
    await new Promise((resolve, reject) => {
      media.addEventListener("sourceopen", resolve, { once: true });
      controller.signal.addEventListener("abort", () => reject(new Error("Przerwano")), { once: true });
    });
    if (run !== generation) return;
    const buffer = media.addSourceBuffer(mime),
      reader = response.body.getReader();
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      await appendChunk(buffer, value, controller.signal);
      if (video.buffered.length) {
        const end = video.buffered.end(video.buffered.length - 1);
        if (end - video.currentTime > 5) video.currentTime = Math.max(0, end - 1);
        const cutoff = video.currentTime - 15;
        if (cutoff > 0 && buffer.buffered.length && buffer.buffered.start(0) < cutoff) {
          await new Promise((resolve) => {
            buffer.addEventListener("updateend", resolve, { once: true });
            buffer.remove(0, cutoff);
          });
        }
      }
      if (video.paused && video.readyState >= 2)
        video.play().catch(() => text("Naciśnij przycisk odtwarzania na obrazie."));
    }
    if (run === generation) stop("Transmisja zakończona. Możesz uruchomić ją ponownie.");
  } catch (error) {
    if (run === generation)
      stop(
        error.message?.startsWith("Brak ") || error.message?.startsWith("Ten telefon")
          ? error.message
          : "Nie można połączyć się z obrazem. Sprawdź adres bramki, internet i działanie usługi kamer.",
      );
  } finally {
    clearInterval(timeout);
    video.removeEventListener("timeupdate", progress);
  }
}

video.addEventListener("playing", () => {
  if (!active) return;
  $("placeholder").hidden = true;
  $("connection").textContent = "Odtwarzanie";
  text("Podgląd na żywo · bez nagrywania");
});
video.addEventListener("error", () => {
  if (active) stop("Nie można odtworzyć obrazu. Sprawdź kodek kamery (H.264).");
});
$("play").addEventListener("click", play);
$("stop").addEventListener("click", () => stop());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stop("Podgląd zatrzymany po przejściu aplikacji w tło.");
});
window.addEventListener("pagehide", () => stop());
window.addEventListener("offline", () => stop("Brak internetu. Podgląd zatrzymany."));
for (const name of ["cameras", "help"])
  $(name + "Tab").addEventListener("click", () => {
    stop();
    for (const key of ["cameras", "help"]) {
      $(key + "View").hidden = key !== name;
      $(key + "Tab").setAttribute("aria-pressed", String(key === name));
    }
  });
$("endpointForm").addEventListener("submit", (event) => {
  event.preventDefault();
  stop();
  try {
    const value = normalizeEndpoint($("endpoint").value.trim());
    if (
      !confirm(
        "Zezwolić bramce " +
          value +
          " na weryfikację Twojego konta Pompa? Używaj wyłącznie adresu skonfigurowanego na Twoim Raspberry.",
      )
    )
      return;
    endpoint = value;
    try {
      localStorage.setItem("pompaCameraTestEndpoint", endpoint);
    } catch {}
    $("endpointMessage").textContent = "Zapisano adres. Przejdź do zakładki Kamery.";
    stop();
  } catch (error) {
    $("endpointMessage").textContent = error.message;
  }
});
$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("loginButton").disabled = true;
  try {
    await api.signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
  } catch {
    text("Logowanie nie powiodło się. Sprawdź konto aplikacji i połączenie.");
  } finally {
    $("password").value = "";
    $("loginButton").disabled = false;
  }
});
$("logout").addEventListener("click", () => {
  stop();
  api.signOut(auth).catch(() => text("Wylogowanie nie powiodło się."));
});

async function boot() {
  const cfg = globalThis.POMPA_CONFIG,
    sdk = `https://www.gstatic.com/firebasejs/${cfg.firebaseSdk}/firebase-`;
  const [app, authApi] = await Promise.all([import(sdk + "app.js"), import(sdk + "auth.js")]);
  api = authApi;
  auth = api.getAuth(app.initializeApp(cfg.firebase));
  api.onAuthStateChanged(auth, (user) => {
    stop(
      user
        ? endpoint
          ? "Gotowe. Włącz podgląd."
          : "Brak adresu bramki. Ustaw go w zakładce Połączenie."
        : "Zaloguj się kontem aplikacji Pompa.",
    );
    $("loginPanel").hidden = !!user;
    $("account").hidden = !user;
    $("accountName").textContent = user?.email || "";
  });
  $("loginButton").disabled = false;
}
boot().catch(() => text("Nie udało się załadować logowania. Sprawdź połączenie i odśwież stronę."));

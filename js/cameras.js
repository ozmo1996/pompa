import { $, user, VIEWS, onShowView, currentView } from "./state.js";
import { CFG } from "./logic.js";
import { normalizeEndpoint, appendChunk, removeRange, playbackPlan } from "./cameraLogic.js";

let active = null,
  objectUrl = null,
  generation = 0,
  timer = null,
  manualStop = false,
  leaving = false;
const video = () => $("cameraVideo");
const eligible = () =>
  !!user() && !document.hidden && !$("dashboard").hidden && currentView() === "cameras" && !leaving;

export function stopCamera(message = "Podgląd wyłączony. Obraz nie jest pobierany na tym urządzeniu.") {
  generation++;
  active?.abort();
  active = null;
  clearInterval(timer);
  timer = null;
  const v = video();
  v.pause();
  v.playbackRate = 1;
  v.removeAttribute("src");
  v.srcObject = null;
  v.load();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  $("cameraPlaceholder").hidden = false;
  $("cameraConnection").textContent = "Wyłączony";
  $("cameraInfo").textContent = "";
  $("cameraMessage").textContent = message;
  $("cameraPlay").disabled = !eligible();
  $("cameraStop").disabled = true;
}

async function playCamera() {
  if (!eligible() || active) return;
  stopCamera();
  const run = generation,
    controller = new globalThis.AbortController(),
    v = video();
  active = controller;
  $("cameraPlay").disabled = true;
  $("cameraStop").disabled = false;
  $("cameraConnection").textContent = "Łączenie…";
  $("cameraMessage").textContent = "Pobieranie obrazu…";
  let lastProgress = Date.now(),
    previousTime = -1;
  timer = setInterval(() => {
    if (!eligible()) return stopCamera();
    if (v.currentTime !== previousTime) {
      previousTime = v.currentTime;
      lastProgress = Date.now();
    }
    if (Date.now() - lastProgress > 15000)
      return stopCamera("Brak świeżego obrazu. Sprawdź połączenie i naciśnij Wznów podgląd.");
    if (v.videoWidth && v.buffered.length) {
      const gap = Math.max(0, v.buffered.end(v.buffered.length - 1) - v.currentTime);
      $("cameraInfo").textContent =
        `${v.videoWidth} × ${v.videoHeight} · H.264 · bufor ${gap.toFixed(1).replace(".", ",")} s`;
    }
  }, 1000);
  try {
    const endpoint = normalizeEndpoint(CFG.kamera.endpoint);
    const token = await user().getIdToken();
    // Wyjście w trakcie pobierania tokenu nie może uruchomić transmisji.
    if (run !== generation || !eligible()) return;
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
          ? "Brak uprawnień do kamery. Zaloguj się ponownie."
          : response.status === 429
            ? "Obraz ogląda już dwóch użytkowników. Spróbuj później."
            : "Kamera lub bramka jest niedostępna. Spróbuj ponownie.",
      );
    if (run !== generation || !eligible()) return;
    const mime = response.headers.get("Content-Type"),
      Source = window.ManagedMediaSource || window.MediaSource;
    if (!Source || !mime?.startsWith("video/mp4") || !Source.isTypeSupported(mime))
      throw new Error("Ta przeglądarka nie obsługuje podglądu H.264. Użyj aktualnej przeglądarki.");
    const media = new Source();
    if (window.ManagedMediaSource) {
      v.disableRemotePlayback = true;
      v.srcObject = media;
    } else {
      objectUrl = URL.createObjectURL(media);
      v.src = objectUrl;
    }
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        media.removeEventListener("sourceopen", opened);
        controller.signal.removeEventListener("abort", aborted);
      };
      const opened = () => {
        cleanup();
        resolve();
      };
      const aborted = () => {
        cleanup();
        reject(new Error("Przerwano"));
      };
      media.addEventListener("sourceopen", opened, { once: true });
      controller.signal.addEventListener("abort", aborted, { once: true });
      if (controller.signal.aborted) aborted();
    });
    if (run !== generation || !eligible()) return;
    const buffer = media.addSourceBuffer(mime),
      reader = response.body.getReader();
    let started = false;
    while (!controller.signal.aborted && eligible()) {
      const { done, value } = await reader.read();
      if (done) break;
      if (run !== generation || !eligible()) return;
      await appendChunk(buffer, value, controller.signal);
      if (v.buffered.length) {
        const plan = playbackPlan(
          v.currentTime,
          v.buffered.start(v.buffered.length - 1),
          v.buffered.end(v.buffered.length - 1),
          v.playbackRate,
        );
        if (plan.seek !== null) v.currentTime = plan.seek;
        v.playbackRate = plan.rate;
        const cutoff = v.currentTime - 15;
        if (cutoff > 0 && buffer.buffered.length && buffer.buffered.start(0) < cutoff)
          await removeRange(buffer, 0, cutoff, controller.signal);
      }
      if (!started && v.readyState >= 2) {
        started = true;
        v.play().catch(() => {
          if (run === generation) $("cameraMessage").textContent = "Naciśnij odtwarzanie na obrazie.";
        });
      }
    }
    if (run === generation) stopCamera("Transmisja zakończona. Naciśnij Wznów podgląd.");
  } catch (error) {
    if (run === generation)
      stopCamera(
        error.message?.startsWith("Brak uprawnień") ||
          error.message?.startsWith("Kamera lub") ||
          error.message?.startsWith("Obraz ogląda") ||
          error.message?.startsWith("Ta przeglądarka")
          ? error.message
          : "Nie można pobrać obrazu. Sprawdź internet i naciśnij Wznów podgląd.",
      );
  } finally {
    if (run === generation && active === controller) stopCamera();
  }
}

export function initCameras() {
  const sync = () => {
    if (!eligible()) stopCamera();
    else if (!manualStop) playCamera();
  };
  for (const name of VIEWS)
    onShowView(name, () => {
      manualStop = false;
      sync();
    });
  $("cameraPlay").addEventListener("click", () => {
    manualStop = false;
    playCamera();
  });
  $("cameraStop").addEventListener("click", () => {
    manualStop = true;
    stopCamera();
  });
  $("logout").addEventListener("click", () => {
    manualStop = true;
    stopCamera();
  });
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("pagehide", () => {
    leaving = true;
    stopCamera();
  });
  window.addEventListener("pageshow", () => {
    leaving = false;
    sync();
  });
  window.addEventListener("offline", () => stopCamera("Brak internetu. Obraz wyłączony."));
  video().addEventListener("playing", () => {
    if (!active || !eligible()) return;
    $("cameraPlaceholder").hidden = true;
    $("cameraConnection").textContent = "Na żywo";
    $("cameraMessage").textContent = "Podgląd na żywo · bez nagrywania";
  });
  video().addEventListener("error", () => {
    if (active) stopCamera("Nie można odtworzyć obrazu. Spróbuj ponownie.");
  });
}

// Akceptujemy wyłącznie bezhasłowy adres bramki, nigdy URL RTSP ani login kamery.
export function normalizeEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Podaj sam adres HTTPS bramki, bez hasła, ścieżki i parametrów.");
  return url.origin;
}

// Lagodnie nadrabiamy niewielki bufor; skok tylko po duzej przerwie albo wypadnieciu poza bufor.
export function playbackPlan(time, start, end, rate = 1) {
  if (![time, start, end].every(Number.isFinite) || end <= start) return { rate: 1, seek: null };
  const gap = end - time;
  if (time < start - 0.1 || gap > 12) return { rate: 1, seek: Math.max(start, end - 2.5) };
  if (gap > 3.75 || (rate > 1 && gap > 2.75)) return { rate: 1.04, seek: null };
  if (gap < 0.5 || (rate < 1 && gap < 1.25)) return { rate: 0.98, seek: null };
  return { rate: 1, seek: null };
}

export const appendChunk = (buffer, bytes, signal) => mutateBuffer(buffer, () => buffer.appendBuffer(bytes), signal);
export const removeRange = (buffer, start, end, signal) =>
  mutateBuffer(buffer, () => buffer.remove(start, end), signal);

async function mutateBuffer(buffer, mutate, signal) {
  if (signal.aborted) throw new Error("Przerwano");
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      buffer.removeEventListener("updateend", end);
      buffer.removeEventListener("error", fail);
      signal.removeEventListener("abort", fail);
    };
    const end = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("Przerwano odtwarzanie"));
    };
    buffer.addEventListener("updateend", end, { once: true });
    buffer.addEventListener("error", fail, { once: true });
    signal.addEventListener("abort", fail, { once: true });
    try {
      mutate();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

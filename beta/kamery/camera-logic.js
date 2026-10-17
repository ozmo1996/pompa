// Akceptujemy wyłącznie bezhasłowy adres bramki, nigdy URL RTSP ani login kamery.
export function normalizeEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Podaj sam adres HTTPS bramki, bez hasła, ścieżki i parametrów.");
  return url.origin;
}

export async function appendChunk(buffer, bytes, signal) {
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
      buffer.appendBuffer(bytes);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

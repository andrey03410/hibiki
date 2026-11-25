import { AudioDelivery } from "./audio-delivery";

const workerPath = "/audio-worker.js?v=3";
function registerRelay() {
  try {
    if (!globalThis.isSecureContext || typeof MessageChannel === "undefined" || typeof ReadableStream === "undefined") return;
    const workers = navigator.serviceWorker;
    if (!workers) return;
    void workers.register(workerPath).catch(() => {});
    return workers;
  } catch { return; }
}
const workers = registerRelay();

export function audioRelayReady() {
  return !!workers && workers.controller?.scriptURL === new URL(workerPath, location.origin).href;
}

export function subscribeAudioRelay(listener: () => void) {
  if (!workers) return () => {};
  workers.addEventListener("controllerchange", listener);
  return () => workers.removeEventListener("controllerchange", listener);
}

// Sending a transferable stream can start its producer even if the worker
// has timed out. Send only headers until the worker actually pulls a chunk.
export function offerAudioResponse(port: MessagePort, response?: Response, onClose?: () => void) {
  const reader = response?.body?.getReader();
  let closed = false, reading = false;
  const timer = setTimeout(close, 5000);
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    port.close();
    void reader?.cancel().catch(() => {});
    onClose?.();
  }
  port.onmessage = async ({ data }) => {
    if (data === "cancel") { close(); return; }
    if (data !== "pull" || reading || !reader) return;
    clearTimeout(timer);
    reading = true;
    try {
      const { done, value } = await reader.read();
      if (closed) return;
      if (done) { port.postMessage({ done }); close(); }
      else port.postMessage({ value }, [value.buffer]);
    } catch {
      if (!closed) port.postMessage({ error: true });
      close();
    } finally { reading = false; }
  };
  port.onmessageerror = close;
  port.postMessage(response ? { status: response.status, headers: [...response.headers], hasBody: !!reader } : null);
  if (!reader) close();
  return close;
}

export function listenForAudioRanges(delivery: AudioDelivery) {
  if (!workers) return;
  const offers = new Set<() => void>();
  const receive = (event: MessageEvent) => {
    if (event.data?.type !== "hibiki-audio-read-v2" || event.source !== workers.controller) return;
    const port = event.ports[0];
    if (!port) return;
    if (Date.now() >= event.data.deadline) { port.close(); return; }
    const response = delivery.response(event.data.token, event.data.range);
    let stop: () => void;
    stop = offerAudioResponse(port, response, () => offers.delete(stop));
    if (response?.body) offers.add(stop);
  };
  workers.addEventListener("message", receive);
  return () => {
    workers.removeEventListener("message", receive);
    for (const stop of offers) stop();
  };
}

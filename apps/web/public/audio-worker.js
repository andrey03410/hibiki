// The worker owns no audio bytes. Each native range is served by its tab.
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

async function audioResponse(event, token) {
  const client = event.clientId && await self.clients.get(event.clientId);
  if (!client) return Response.error();
  const { port1, port2 } = new MessageChannel();
  let timer, rejectRead, closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    event.request.signal.removeEventListener("abort", close);
    port1.postMessage("cancel");
    port1.close();
    rejectRead?.(new Error("Audio range closed"));
  };
  function exchange(send, timeout) {
    return new Promise((resolve, reject) => {
      if (closed) { reject(new Error("Audio range closed")); return; }
      rejectRead = reject;
      timer = setTimeout(close, timeout);
      port1.onmessage = ({ data }) => {
        clearTimeout(timer);
        rejectRead = undefined;
        resolve(data);
      };
      port1.onmessageerror = close;
      send();
    });
  }
  event.request.signal.addEventListener("abort", close, { once: true });
  if (event.request.signal.aborted) close();
  try {
    const headers = await exchange(() => client.postMessage({
      type: "hibiki-audio-read-v2", token, range: event.request.headers.get("Range"), deadline: Date.now() + 2000,
    }, [port2]), 2000);
    if (!headers) { close(); return Response.error(); }
    if (!headers.hasBody) { close(); return new Response(null, headers); }
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const result = await exchange(() => port1.postMessage("pull"), 30000);
          if (result.error) throw new Error("Audio read failed");
          if (result.done) { controller.close(); close(); }
          else controller.enqueue(result.value);
        } catch (error) { controller.error(error); close(); }
      },
      cancel: close,
    }, { highWaterMark: 0 });
    return new Response(body, headers);
  } catch { close(); return Response.error(); }
}

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  const token = url.searchParams.get("hibiki-audio");
  if (event.request.method === "GET" && url.origin === self.location.origin &&
      /^(?:\/files\/[\w-]+(?:\/audio)?|\/api\/items\/[\w-]+\/sound\/\d+|\/api\/(?:shared-items\/[^/]+|(?:shared|shared-playlists)\/[^/]+\/items\/[^/]+)\/(?:sources\/[\w-]+(?:\/audio)?|sound\/\d+))$/.test(url.pathname) && token) event.respondWith(audioResponse(event, token));
});

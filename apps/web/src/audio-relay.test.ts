import { expect, it } from "vitest";
import { offerAudioResponse } from "./audio-relay";

function nextData(port: MessagePort) {
  return new Promise<any>(resolve => { port.onmessage = event => resolve(event.data); });
}

it("offers headers without pulling bytes on a port that the worker already closed", async () => {
  const { port1, port2 } = new MessageChannel();
  port1.close();
  let pulls = 0;
  const body = new ReadableStream({ pull() { pulls++; } }, { highWaterMark: 0 });
  const stop = offerAudioResponse(port2, new Response(body));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(pulls).toBe(0);
  stop();
});

it("reads one chunk for each worker acknowledgement and forwards cancellation", async () => {
  const { port1, port2 } = new MessageChannel();
  let pulls = 0, cancelled = false;
  const ready = nextData(port1);
  const stop = offerAudioResponse(port2, new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array([++pulls])); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 })));
  try {
    expect((await ready).status).toBe(200);
    expect(pulls).toBe(0);
    const chunk = nextData(port1);
    port1.postMessage("pull");
    expect((await chunk).value).toEqual(new Uint8Array([1]));
    expect(pulls).toBe(1);
    port1.postMessage("cancel");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(cancelled).toBe(true);
  } finally { stop(); port1.close(); }
});

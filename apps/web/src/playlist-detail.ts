import type { PlaylistDetailDto } from "@hibiki/contracts";
import { api } from "./api";

// React may replace an effect and immediately subscribe to the same detail.
// Give the next subscriber one microtask to retain the in-flight request.
export class PlaylistDetails {
  private pending = new Map<string, { request: AbortController; readers: number; result: Promise<PlaylistDetailDto> }>();

  read(path: string, version: string, priority: RequestPriority, signal: AbortSignal) {
    signal.throwIfAborted();
    const key = JSON.stringify([path, version]);
    let entry = this.pending.get(key);
    if (!entry) {
      const request = new AbortController();
      const result = api<PlaylistDetailDto>(path, "GET", undefined, priority, request.signal);
      entry = {request, result, readers: 0};
      this.pending.set(key, entry);
    }
    const shared = entry;
    shared.readers++;
    const release = () => {
      shared.readers--;
      if (!shared.readers) queueMicrotask(() => {
        if (!shared.readers && this.pending.get(key) === shared) {
          this.pending.delete(key);
          shared.request.abort();
        }
      });
    };
    signal.addEventListener("abort", release, {once:true});
    return shared.result.then(data => { signal.throwIfAborted(); return data; }).finally(() => {
      signal.removeEventListener("abort", release);
      if (this.pending.get(key) === shared) this.pending.delete(key);
    });
  }
}

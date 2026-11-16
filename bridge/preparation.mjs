// One unused, session-free preparation per provider. Taking it transfers
// ownership to exactly one generation; no prompt or response is cached here.
export function createPreparation({create, dispose, ttlMs = 60_000}) {
  let idle;
  const releases = new Set();
  const abortError = signal => signal?.reason instanceof Error ? signal.reason
    : new DOMException('接続準備が中断されました。', 'AbortError');

  function release(entry) {
    const operation = (async () => {
      clearTimeout(entry.timer);
      entry.controller.abort();
      try {await dispose(await entry.promise);} catch { /* Failed preparation owns its cleanup. */ }
    })();
    releases.add(operation);
    void operation.then(() => releases.delete(operation), () => releases.delete(operation));
    return operation;
  }

  async function prepare({signal} = {}) {
    if (signal?.aborted) throw abortError(signal);
    if (!idle) {
      const entry = {controller: new AbortController()};
      idle = entry;
      entry.promise = Promise.resolve().then(() => create(entry.controller.signal));
      entry.promise.catch(() => {if (idle === entry) {idle = null; clearTimeout(entry.timer);}});
      entry.timer = setTimeout(() => {
        if (idle === entry) {idle = null; void release(entry);}
      }, ttlMs);
      entry.timer.unref?.();
    }
    const entry = idle;
    const cancel = () => {
      // Once a generation takes the preparation, its own signal owns it.
      if (idle === entry) {idle = null; void release(entry);}
    };
    signal?.addEventListener('abort', cancel, {once: true});
    try {await entry.promise; if (signal?.aborted) throw abortError(signal);}
    finally {signal?.removeEventListener('abort', cancel);}
  }

  async function take({signal} = {}) {
    if (signal?.aborted) throw abortError(signal);
    const entry = idle;
    if (!entry) return create(signal);
    idle = null;
    clearTimeout(entry.timer);
    const cancel = () => entry.controller.abort(abortError(signal));
    signal?.addEventListener('abort', cancel, {once: true});
    try {
      const resource = await entry.promise;
      if (signal?.aborted) {await dispose(resource); throw abortError(signal);}
      return resource;
    } finally {signal?.removeEventListener('abort', cancel);}
  }

  async function clear() {
    const entry = idle;
    idle = null;
    if (entry) void release(entry);
    // Expiry/cancellation may already have detached the idle entry while its
    // runtime is still stopping. Host shutdown must wait for those releases too.
    while (releases.size) await Promise.allSettled([...releases]);
  }
  return {prepare, take, clear};
}

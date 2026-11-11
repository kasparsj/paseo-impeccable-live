export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("The operation was canceled.");
}

/** Referenced deadline timers also work when an HTTP stream has no active socket. */
export function deadlineSignal(timeoutMs: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) controller.abort();
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent?.removeEventListener("abort", abort); } };
}

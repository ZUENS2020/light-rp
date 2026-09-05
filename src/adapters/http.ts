/** Bounded response reads, including a body that stalls after its headers arrive. */
export async function readResponseText(
  response: Response,
  signal: AbortSignal,
  maxBytes = 4 * 1024 * 1024,
): Promise<string> {
  signal.throwIfAborted();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) return text + decoder.decode();
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error("Response exceeds size limit");
      text += decoder.decode(part.value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    // Always observe the source, even if cancellation happened while it was created.
    // Some bindings reject later instead of stopping immediately on AbortSignal.
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

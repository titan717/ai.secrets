/** Minimal spec-compliant SSE reader: yields the `data` payload of each event (multi-line data joined by \n). Comment lines (": ...") are skipped. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let data: string[] = [];
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n/)) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + (buf[idx] === "\r" ? 2 : 1));
        if (line === "") {
          if (data.length) yield data.join("\n");
          data = [];
        } else if (line.startsWith(":")) {
          continue;
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
    if (data.length) yield data.join("\n");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** Turn a non-2xx provider response into a readable message (no secrets). */
export async function describeHttpError(provider: string, res: Response): Promise<string> {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message ?? j?.message ?? text;
      const raw = j?.error?.metadata?.raw;
      if (raw && typeof raw === "string") detail += ` (${raw.slice(0, 300)})`;
    } catch {
      detail = text;
    }
  } catch {
    /* ignore */
  }
  detail = String(detail).slice(0, 600);
  const hint =
    res.status === 401 || res.status === 403 || (res.status === 400 && /api[ _-]?key/i.test(detail))
      ? `Invalid or unauthorized ${provider} API key.`
      : res.status === 402
        ? `${provider}: insufficient credits.`
        : res.status === 429
          ? `${provider} rate limit or quota exceeded — wait a moment and retry.`
          : res.status === 404
            ? `${provider}: model or endpoint not found.`
            : `${provider} request failed (${res.status}).`;
  return detail ? `${hint} ${detail}` : hint;
}

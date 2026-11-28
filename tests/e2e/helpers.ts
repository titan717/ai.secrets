/** Shared helpers for the bridge e2e tests (SSE reader, authenticated API calls). */
import type { startBridge } from "../../src/bridge/server.js";

export type Frame = { id?: string; event?: string; data: any };
export type Started = Awaited<ReturnType<typeof startBridge>>;

export const bodies: string[] = [];

/** Read an SSE response, calling onFrame for each frame; stop when it returns "stop" or the stream ends. */
export async function readSse(res: Response, onFrame?: (f: Frame) => unknown, timeoutMs = 10000): Promise<Frame[]> {
  const frames: Frame[] = [];
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let raw = "";
  const timer = setTimeout(() => void reader.cancel().catch(() => {}), timeoutMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      raw += value;
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const f: Frame = { data: undefined };
        const data: string[] = [];
        for (const line of chunk.split("\n")) {
          if (line.startsWith("id: ")) f.id = line.slice(4);
          else if (line.startsWith("event: ")) f.event = line.slice(7);
          else if (line.startsWith("data: ")) data.push(line.slice(6));
        }
        if (!data.length) continue;
        f.data = JSON.parse(data.join("\n"));
        frames.push(f);
        if ((await onFrame?.(f)) === "stop") {
          await reader.cancel().catch(() => {});
          return frames;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    bodies.push(raw);
  }
  return frames;
}

export function api(h: Started) {
  const H = { authorization: `Bearer ${h.token}`, "content-type": "application/json" };
  const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await fetch(h.url + path, { method, headers: { ...H, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, json: text ? JSON.parse(text) : undefined, headers: res.headers };
  };
  const send = (sid: string, text: string, extra: Record<string, string> = {}) =>
    fetch(`${h.url}/v1/sessions/${sid}/messages`, { method: "POST", headers: { ...H, ...extra }, body: JSON.stringify({ text }) });
  const session = async () => (await call("POST", "/v1/sessions", { title: "t" })).json.session.id as string;
  const fakeInfo = async () => (await h.bridge.runtime().client.request("GET", "/__fake/info")) as any;
  return { H, call, send, session, fakeInfo };
}

export const types = (fs: Frame[]) => fs.map((f) => f.data.type);
export const until = (t: string) => (f: Frame) => (f.data.type === t ? "stop" : undefined);


import { afterEach, describe, expect, it } from "vitest";
import { frameToEvent, SseParser, streamTurn, StreamDroppedError, HttpStatusError, type SseFrame } from "../../src/cli/sse.js";
import { BridgeClient } from "../../src/cli/client.js";
import type { AiEvent } from "../../src/core/events.js";
import { startFakeBridge, type FakeBridge } from "./cli-fake-bridge.js";

function feedAll(chunks: string[]): SseFrame[] {
  const p = new SseParser();
  return chunks.flatMap((c) => p.push(c));
}

describe("SseParser", () => {
  const stream = 'id: 1\nevent: text.delta\ndata: {"type":"text.delta","sessionId":"s","text":"hi"}\n\n: ping\n\nid: 2\nevent: session.idle\ndata: {"type":"session.idle","sessionId":"s"}\n\n';

  it("parses id/event/data frames and ignores ping comments", () => {
    const f = feedAll([stream]);
    expect(f).toHaveLength(2);
    expect(f[0]).toEqual({ id: "1", event: "text.delta", data: '{"type":"text.delta","sessionId":"s","text":"hi"}' });
    expect(frameToEvent(f[1]!)).toEqual({ type: "session.idle", sessionId: "s" });
  });

  it("is independent of chunk boundaries (every split point)", () => {
    const whole = feedAll([stream]);
    for (let i = 1; i < stream.length; i++) expect(feedAll([stream.slice(0, i), stream.slice(i)])).toEqual(whole);
    expect(feedAll(stream.split(""))).toEqual(whole);
  });

  it("handles CRLF and bare CR, including CR/LF split across chunks", () => {
    const crlf = stream.replace(/\n/g, "\r\n");
    const whole = feedAll([stream]);
    expect(feedAll([crlf])).toEqual(whole);
    for (let i = 1; i < crlf.length; i++) expect(feedAll([crlf.slice(0, i), crlf.slice(i)])).toEqual(whole);
    expect(feedAll([stream.replace(/\n/g, "\r")])).toEqual(whole);
  });

  it("joins multi-line data with \\n and strips one leading space", () => {
    const f = feedAll(["data: line1\ndata:line2\ndata:  indented\n\n"]);
    expect(f).toEqual([{ event: "message", data: "line1\nline2\n indented" }]);
  });

  it("tracks lastEventId across frames and ignores unknown fields / retry", () => {
    const p = new SseParser();
    p.push("retry: 1000\nfoo: bar\nid: 41\ndata: x\n\n");
    expect(p.lastEventId).toBe("41");
    const f = p.push("data: y\n\n");
    expect(f).toEqual([{ event: "message", data: "y" }]);
    expect(p.lastEventId).toBe("41");
  });

  it("discards an unterminated frame at end and frames with no data", () => {
    const p = new SseParser();
    expect(p.push("event: x\n\nid: 3\ndata: partial")).toEqual([]);
    expect(p.end()).toEqual([]);
  });

  it("frameToEvent rejects non-JSON or untyped data", () => {
    expect(frameToEvent({ event: "x", data: "nope" })).toBeNull();
    expect(frameToEvent({ event: "x", data: '{"a":1}' })).toBeNull();
  });
});

const sseResponse = (body: string, close = true) => {
  let sent = false;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(new TextEncoder().encode(body));
        } else if (close) c.close();
        else c.error(new Error("socket hang up"));
      },
    }),
  );
};
const frame = (id: number, ev: object) => `id: ${id}\ndata: ${JSON.stringify(ev)}\n\n`;

describe("streamTurn reconnect", () => {
  it("resumes with Last-Event-ID after a drop and skips duplicates", async () => {
    const seen: Array<string | undefined> = [];
    const evs: AiEvent[] = [];
    for await (const ev of streamTurn({
      open: async () => sseResponse(frame(1, { type: "text.delta", sessionId: "s", text: "a" }), false),
      reconnect: async (last) => {
        seen.push(last);
        return sseResponse(frame(1, { type: "text.delta", sessionId: "s", text: "a" }) + frame(2, { type: "text.delta", sessionId: "s", text: "b" }) + frame(3, { type: "session.idle", sessionId: "s" }));
      },
      backoff: () => 0,
    }))
      evs.push(ev);
    expect(seen).toEqual(["1"]);
    expect(evs.map((e) => (e.type === "text.delta" ? e.text : e.type))).toEqual(["a", "b", "session.idle"]);
  });

  it("gives up after maxReconnects", async () => {
    const it = streamTurn({ open: async () => sseResponse(""), reconnect: async () => sseResponse(""), backoff: () => 0, maxReconnects: 2 });
    await expect(it.next()).rejects.toBeInstanceOf(StreamDroppedError);
  });

  it("does not retry HTTP errors from reconnect", async () => {
    const it = streamTurn({
      open: async () => sseResponse(""),
      reconnect: async () => {
        throw new HttpStatusError("gone", 404);
      },
      backoff: () => 0,
    });
    await expect(it.next()).rejects.toBeInstanceOf(HttpStatusError);
  });
});

describe("BridgeClient.sendMessage against the fake bridge", () => {
  let fb: FakeBridge;
  afterEach(() => fb?.close());

  it("reconnects to /events with Last-Event-ID when the stream drops mid-turn", async () => {
    fb = await startFakeBridge({
      scenario: () => [
        { event: { type: "text.delta", text: "one " } },
        { delay: 20 },
        { drop: true },
        { event: { type: "text.delta", text: "two" } },
        { event: { type: "session.idle" } },
      ],
    });
    const c = new BridgeClient({ url: fb.url, token: fb.token });
    const s = await c.createSession();
    let text = "";
    let reconnects = 0;
    for await (const ev of c.sendMessage(s.id, { text: "hi" }, { backoff: () => 30, onReconnect: () => reconnects++ })) if (ev.type === "text.delta") text += ev.text;
    expect(text).toBe("one two");
    expect(reconnects).toBe(1);
    const re = fb.requests.find((r) => r.path.endsWith("/events"));
    expect(re?.headers["last-event-id"]).toBe("1");
  });
});

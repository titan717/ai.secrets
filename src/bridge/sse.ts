import type { ServerResponse } from "node:http";
import type { FastifyReply } from "fastify";

/**
 * Server-Sent Events writer over a hijacked Fastify reply.
 * Framing: `id: <seq>\nevent: <type>\ndata: <json>\n\n`, plus `: ping` comments every pingMs.
 */
export class SseStream {
  readonly raw: ServerResponse;
  closed = false;
  private ping: NodeJS.Timeout;
  private closers: Array<() => void> = [];

  constructor(reply: FastifyReply, opts: { pingMs?: number; headers?: Record<string, string> } = {}) {
    reply.hijack();
    this.raw = reply.raw;
    const inherited = reply.getHeaders() as Record<string, string>;
    this.raw.writeHead(200, {
      ...inherited,
      ...(opts.headers ?? {}),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    this.raw.flushHeaders?.();
    this.raw.write(": connected\n\n");
    this.ping = setInterval(() => this.comment("ping"), opts.pingMs ?? 15_000);
    this.ping.unref?.();
    const onClose = () => this.close();
    this.raw.on("close", onClose);
    reply.request.raw.on("close", () => {
      if (!this.raw.writableEnded && this.raw.destroyed) this.close();
    });
  }

  onClose(fn: () => void): void {
    if (this.closed) fn();
    else this.closers.push(fn);
  }

  /** Write a typed event. */
  event(type: string, data: unknown, id?: number | string): void {
    if (this.closed) return;
    let frame = "";
    if (id !== undefined) frame += `id: ${id}\n`;
    frame += `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    this.raw.write(frame);
  }

  /** Write a data-only frame (legacy clients). */
  data(data: unknown): void {
    if (this.closed) return;
    this.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  comment(text: string): void {
    if (this.closed) return;
    this.raw.write(`: ${text}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ping);
    try {
      if (!this.raw.writableEnded) this.raw.end();
    } catch {
      /* socket gone */
    }
    for (const fn of this.closers.splice(0)) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }
}

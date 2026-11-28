import type { AiEvent } from "../core/events.js";

export interface StoredEvent {
  seq: number;
  ev: AiEvent;
}
type Listener = (e: StoredEvent) => void;

/**
 * Per-session ring buffer + fan-out. Sequence numbers are bridge-wide and start at a time-based
 * value, so ids from a previous bridge process are always lower than new ones.
 */
export class EventHub {
  private seq = Date.now() * 1000;
  private buffers = new Map<string, StoredEvent[]>();
  private subs = new Map<string, Set<Listener>>();

  constructor(private capacity = 2000) {}

  publish(ev: AiEvent): StoredEvent {
    const e = { seq: ++this.seq, ev };
    let buf = this.buffers.get(ev.sessionId);
    if (!buf) {
      buf = [];
      this.buffers.set(ev.sessionId, buf);
    }
    buf.push(e);
    if (buf.length > this.capacity) buf.splice(0, buf.length - this.capacity);
    for (const fn of [...(this.subs.get(ev.sessionId) ?? [])]) fn(e);
    return e;
  }

  /** Buffered events with seq > after. */
  since(sessionId: string, after: number): StoredEvent[] {
    return (this.buffers.get(sessionId) ?? []).filter((e) => e.seq > after);
  }

  subscribe(sessionId: string, fn: Listener): () => void {
    let set = this.subs.get(sessionId);
    if (!set) {
      set = new Set();
      this.subs.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
    };
  }

  drop(sessionId: string): void {
    this.buffers.delete(sessionId);
  }
}

import type { AiEvent } from "../core/events.js";
import type { Logger } from "../core/log.js";
import { RECONNECT_EVENT, type RawEvent } from "../opencode/client.js";
import { Normalizer } from "../opencode/normalize.js";
import { OpenCodeSupervisor, type SupervisorOptions } from "../supervisor/index.js";

export interface RuntimeHooks {
  onEvent(ev: AiEvent, rt: WorkspaceRuntime): void;
  onRaw?(raw: RawEvent, rt: WorkspaceRuntime): void;
  /** Sessions with a turn in flight on this runtime (for restart/reconnect resync). */
  activeSessions(rt: WorkspaceRuntime): string[];
  maxSteps?(sessionId: string): number | undefined;
}

/** One supervised OpenCode child + its event subscription and normalizer. */
export class WorkspaceRuntime {
  readonly sup: OpenCodeSupervisor;
  readonly normalizer: Normalizer;
  private ctrl = new AbortController();
  private connectedGen = -1;
  private waiters: Array<() => void> = [];
  private loopStarted = false;

  constructor(
    readonly workspace: string,
    supOpts: SupervisorOptions,
    private hooks: RuntimeHooks,
    private log: Logger,
  ) {
    this.sup = new OpenCodeSupervisor(supOpts);
    this.normalizer = new Normalizer({ maxSteps: (id) => hooks.maxSteps?.(id) });
    // Child gone (crash, restart for config change, or stop): in-flight turns can never finish.
    this.sup.on("exit", () => {
      this.normalizer.reset();
      this.failActive("OpenCode stopped; the turn was interrupted", "OpenCodeRestarted");
    });
  }

  get client() {
    return this.sup.client;
  }

  /** Start the child (if needed) and the event loop. */
  async start(): Promise<void> {
    if (!this.loopStarted) {
      this.loopStarted = true;
      void this.loop();
    }
    await this.sup.start();
  }

  /** Resolve once the child is healthy AND our /event stream is connected to the current child. */
  async waitConnected(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    if (!this.loopStarted) await this.start().catch(() => {});
    await this.sup.ready(timeoutMs);
    while (this.connectedGen !== this.sup.generation) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out connecting to the opencode event stream");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 250));
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
      if (this.sup.state.state !== "running") await this.sup.ready(Math.max(1, deadline - Date.now()));
    }
  }

  private emit(evs: AiEvent[]) {
    for (const ev of evs) this.hooks.onEvent(ev, this);
  }

  /** Terminate every in-flight turn with an error (child restarted, events lost). */
  private failActive(message: string, code: string) {
    for (const sid of this.hooks.activeSessions(this)) {
      this.emit([
        { type: "error", sessionId: sid, message, code },
        { type: "session.idle", sessionId: sid },
      ]);
    }
  }

  private async resync() {
    // Same child, stream blip: anything that went idle while we were disconnected is finished.
    try {
      const status = await this.client.sessionStatus();
      for (const sid of this.hooks.activeSessions(this)) {
        if (!status[sid] || status[sid]!.type === "idle") this.emit(this.normalizer.push({ type: "session.idle", properties: { sessionID: sid } }));
      }
    } catch (e) {
      this.log.debug("resync failed", e);
    }
  }

  private async loop() {
    let lastGen = -1;
    while (!this.ctrl.signal.aborted) {
      if (this.sup.state.state !== "running") {
        try {
          await this.sup.ready(60_000);
        } catch {
          if (this.ctrl.signal.aborted) return;
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
      }
      try {
        for await (const raw of this.client.events({ signal: this.ctrl.signal, backoffMs: 100, maxBackoffMs: 1000, onError: (e) => this.log.debug("event stream error", e) })) {
          if (raw.type === RECONNECT_EVENT) continue;
          if (raw.type === "server.connected") {
            const gen = this.sup.generation;
            if (lastGen !== -1 && gen !== lastGen) {
              this.normalizer.reset();
              this.failActive("OpenCode restarted; the turn was interrupted", "OpenCodeRestarted");
            } else if (lastGen !== -1) {
              await this.resync();
            }
            lastGen = gen;
            this.connectedGen = gen;
            for (const w of this.waiters.splice(0)) w();
            continue;
          }
          this.hooks.onRaw?.(raw, this);
          this.emit(this.normalizer.push(raw));
        }
      } catch (e) {
        this.log.debug("event loop error", e);
      }
    }
  }

  async stop(): Promise<void> {
    this.ctrl.abort();
    await this.sup.stop();
  }
}

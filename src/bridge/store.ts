import type { BridgeSession, SessionUsage } from "../core/api.js";
import { paths } from "../core/paths.js";
import { readJsonFile, writePrivateJson } from "../core/secure-file.js";

const emptyUsage = (): SessionUsage => ({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 });

/** Persistent session index (title, workspace, usage totals) in paths.sessionsFile() (0600). */
export class SessionStore {
  private file: string;
  private map = new Map<string, BridgeSession>();

  constructor(env?: NodeJS.ProcessEnv) {
    this.file = paths.sessionsFile(env);
    const data = readJsonFile<{ sessions?: BridgeSession[] }>(this.file, {});
    for (const s of data.sessions ?? []) {
      if (!s || typeof s.id !== "string") continue;
      // Nothing can be running right after a bridge (re)start.
      this.map.set(s.id, { ...s, status: "idle", usage: { ...emptyUsage(), ...(s.usage ?? {}) } });
    }
  }

  private save() {
    writePrivateJson(this.file, { version: 1, sessions: [...this.map.values()] });
  }

  list(): BridgeSession[] {
    return [...this.map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id: string): BridgeSession | undefined {
    return this.map.get(id);
  }
  add(s: { id: string; title: string; workspace: string }): BridgeSession {
    const now = Date.now();
    const rec: BridgeSession = { id: s.id, title: s.title, workspace: s.workspace, createdAt: now, updatedAt: now, status: "idle", usage: emptyUsage() };
    this.map.set(s.id, rec);
    this.save();
    return rec;
  }
  remove(id: string): boolean {
    const ok = this.map.delete(id);
    if (ok) this.save();
    return ok;
  }
  update(id: string, patch: Partial<Pick<BridgeSession, "title" | "status">>): void {
    const s = this.map.get(id);
    if (!s) return;
    if ((patch.title === undefined || patch.title === s.title) && (patch.status === undefined || patch.status === s.status)) return;
    Object.assign(s, patch, { updatedAt: Date.now() });
    this.save();
  }
  addUsage(id: string, u: { inputTokens: number; outputTokens: number; reasoningTokens: number; costUsd: number }): void {
    const s = this.map.get(id);
    if (!s) return;
    s.usage.inputTokens += u.inputTokens;
    s.usage.outputTokens += u.outputTokens;
    s.usage.reasoningTokens += u.reasoningTokens;
    s.usage.costUsd += u.costUsd;
    s.updatedAt = Date.now();
    this.save();
  }
}

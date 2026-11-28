/**
 * Minimal read-only client for the Secrets API (github.com/titan717/secrets, apps/api).
 * Auth: `Authorization: Bearer <token>` (the API also accepts `x-secrets-token` or the session
 * cookie; bearer skips the CSRF check). Errors are `{ error, message }` JSON.
 *
 * PROTOTYPE NOTE: MessageView.ciphertext currently holds plaintext JSON MessageBody
 * (packages/shared/src/envelope.ts). Once real E2EE lands the server can no longer read it and
 * these tools will only see ciphertext; see docs/MCP.md.
 */
import { redact, registerSecret } from "../core/redact.js";

export interface ApiUser { id: string; username: string; display_name?: string }
export interface ApiMessage { id: string; conversation_id: string; sender_id: string; ciphertext: string; nonce: string | null; created_at: string; edited_at?: string | null; deleted?: boolean; pinned?: boolean; reactions?: { emoji: string; user_ids: string[] }[] }
export interface ApiConversation { id: string; kind: "dm" | "group" | "channel"; title: string | null; dock_id: string | null; members?: ApiUser[] }
export interface ApiChannel { id: string; dock_id: string; name: string; topic: string; position: number }
export interface ApiDock { id: string; name: string; handle: string; description?: string; channels?: ApiChannel[] }
export interface ApiDockMember { user: ApiUser; role: string; joined_at: string }
export interface MessageBody { text?: string; reply_to?: string | null; attachments?: { name?: string; mime: string }[]; kind?: "text" | "system" }

/** API page size cap (apps/api messages/service.ts clamps limit to 1..100). */
export const API_PAGE_MAX = 100;

export class SecretsApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export function openBody(m: Pick<ApiMessage, "ciphertext" | "nonce">): MessageBody {
  if (m.nonce) return { text: "[encrypted message]" };
  try {
    const b = JSON.parse(m.ciphertext);
    return b && typeof b === "object" ? (b as MessageBody) : { text: String(b) };
  } catch {
    return { text: m.ciphertext };
  }
}

export class SecretsApi {
  private readonly base: string;
  constructor(baseUrl: string | undefined, private readonly token: string | undefined, private readonly fetchImpl: typeof fetch = fetch) {
    this.base = (baseUrl ?? "").replace(/\/+$/, "");
    registerSecret(token);
  }

  async get<T>(path: string): Promise<T> {
    if (!this.base || !/^https?:\/\//.test(this.base)) throw new SecretsApiError("SECRETS_API_URL is not set to an http(s) URL");
    if (!this.token) throw new SecretsApiError("SECRETS_TOKEN is not set; sign in to Secrets and enable the Secrets tools again");
    let res: Response;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      res = await this.fetchImpl(this.base + path, { headers: { authorization: `Bearer ${this.token}`, accept: "application/json" }, signal: ctrl.signal });
    } catch (e) {
      throw new SecretsApiError(redact(`Could not reach the Secrets API: ${(e as Error)?.name === "AbortError" ? "timed out" : (e as Error)?.message}`));
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const route = path.split("?")[0];
      const hint =
        res.status === 401 ? "Secrets token expired or invalid (service tokens last 10 min); send a fresh x-secrets-token with the next request so the bridge restarts opencode" :
        res.status === 403 ? "you don't have access to this conversation" :
        res.status === 404 ? "not found" :
        res.status === 429 ? "rate limited, try again shortly" : "";
      const msg = typeof body?.message === "string" ? body.message.slice(0, 200) : "";
      throw new SecretsApiError(redact(`Secrets API ${route} failed (${res.status})${hint ? `: ${hint}` : ""}${msg && msg !== hint ? ` (${msg})` : ""}`), res.status);
    }
    return body as T;
  }

  conversation(id: string) {
    return this.get<ApiConversation>(`/v1/conversations/${encodeURIComponent(id)}`);
  }

  /** Newest `limit` messages, returned oldest-first. Pages with `before` past the API cap of 100. */
  async messages(id: string, limit: number): Promise<ApiMessage[]> {
    const out: ApiMessage[] = [];
    let before: string | undefined;
    while (out.length < limit) {
      const n = Math.min(API_PAGE_MAX, limit - out.length);
      const q = `limit=${n}${before ? `&before=${encodeURIComponent(before)}` : ""}`;
      const page = await this.get<ApiMessage[]>(`/v1/conversations/${encodeURIComponent(id)}/messages?${q}`);
      if (!Array.isArray(page)) throw new SecretsApiError("Secrets API returned an unexpected messages payload");
      out.push(...page);
      if (page.length < n) break;
      before = page[page.length - 1]!.id;
    }
    return out.reverse();
  }

  dock(id: string) {
    return this.get<ApiDock>(`/v1/docks/${encodeURIComponent(id)}`);
  }

  dockMembers(id: string) {
    return this.get<ApiDockMember[]>(`/v1/docks/${encodeURIComponent(id)}/members`);
  }
}

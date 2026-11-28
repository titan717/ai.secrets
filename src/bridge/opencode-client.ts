import type { PermissionDecision } from "../events.js";

export interface OpenCodeRawEvent {
  type: string;
  properties?: any;
}

export interface SendPromptBody {
  text: string;
  model?: string;
  variant?: string;
  system?: string;
}

/**
 * HTTP + SSE client for a local OpenCode server.
 */
export class OpenCodeClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/doc`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async listSessions(): Promise<any[]> {
    const res = await fetch(`${this.baseUrl}/session`);
    if (!res.ok) {
      throw new Error(`OpenCode listSessions failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as any[];
  }

  async createSession(directory: string, title?: string): Promise<{ id: string; [k: string]: unknown }> {
    const res = await fetch(`${this.baseUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        directory,
        ...(title !== undefined ? { title } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenCode createSession failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as { id: string; [k: string]: unknown };
  }

  async sendPrompt(sessionId: string, body: SendPromptBody, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      throw new Error(`OpenCode sendPrompt failed: ${res.status} ${res.statusText}`);
    }
  }

  async abortSession(sessionId: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}/abort`, {
      method: "POST",
    });
    return res.ok;
  }

  async respondPermission(
    sessionId: string,
    permissionId: string,
    decision: PermissionDecision,
  ): Promise<boolean> {
    const response = decision === "allow" ? "once" : decision === "allow_session" ? "always" : "reject";
    const res = await fetch(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response }),
      },
    );
    return res.ok;
  }

  async *subscribeEvents(signal?: AbortSignal): AsyncIterable<OpenCodeRawEvent> {
    const res = await fetch(`${this.baseUrl}/event`, {
      headers: { Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`OpenCode subscribeEvents failed: ${res.status} ${res.statusText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];

    const flushEvent = (): OpenCodeRawEvent | null => {
      if (dataLines.length === 0) return null;
      const payload = dataLines.join("\n").trim();
      dataLines = [];
      if (!payload) return null;
      try {
        return JSON.parse(payload) as OpenCodeRawEvent;
      } catch {
        return null;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let newlineIdx = buffer.indexOf("\n");

        while (newlineIdx !== -1) {
          const rawLine = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

          if (line === "") {
            const evt = flushEvent();
            if (evt) yield evt;
          } else if (!line.startsWith(":")) {
            if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trimStart());
            }
          }

          newlineIdx = buffer.indexOf("\n");
        }
      }

      const trailing = buffer.trim();
      if (trailing.startsWith("data:")) {
        dataLines.push(trailing.slice(5).trimStart());
      }
      const finalEvt = flushEvent();
      if (finalEvt) yield finalEvt;
    } finally {
      reader.releaseLock();
    }
  }
}

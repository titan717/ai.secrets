import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AiEvent } from "../src/events.js";

const FAKE_BIN = resolve(process.cwd(), "tests/fake-opencode.mjs");

describe("Bridge API E2E (with fake opencode)", () => {
  const dirs: string[] = [];

  function tempWorkspace() {
    const d = mkdtempSync(join(tmpdir(), "secrets-ai-e2e-"));
    dirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("enforces Bearer auth, creates sessions, streams normalized AiEvents, and handles permissions", async () => {
    const ws = tempWorkspace();
    const token = "sai_test_token_123456";
    const app = await buildApp({
      bridgeToken: token,
      requireAuth: true,
      defaultWorkspaceDir: ws,
      supervisorOptions: {
        command: process.execPath,
        argsPrefix: [FAKE_BIN],
      },
    });

    const addr = await app.listen({ port: 0, host: "127.0.0.1" });

    try {
      // 1. Auth enforcement
      const unauth = await fetch(`${addr}/v1/sessions`);
      expect(unauth.status).toBe(401);

      const authHeaders = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };

      // 2. Settings update
      const setRes = await fetch(`${addr}/v1/settings`, {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify({ effort: { level: "high", maxSteps: 20 } }),
      });
      expect(setRes.status).toBe(200);

      // 3. Create session
      const createRes = await fetch(`${addr}/v1/sessions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ title: "E2E Chat" }),
      });
      expect(createRes.status).toBe(201);
      const { session } = (await createRes.json()) as { session: { id: string } };
      expect(session.id).toMatch(/^ses_/);

      // 4. List sessions
      const listRes = await fetch(`${addr}/v1/sessions`, { headers: authHeaders });
      expect(listRes.status).toBe(200);
      const listJson = (await listRes.json()) as { sessions: { id: string }[] };
      expect(listJson.sessions.some((s) => s.id === session.id)).toBe(true);

      // 5. Stream messages + approve permission
      const msgRes = await fetch(`${addr}/v1/sessions/${session.id}/messages`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ text: "please write a file with permission" }),
      });
      expect(msgRes.status).toBe(200);

      const events: AiEvent[] = [];
      const reader = msgRes.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const ev = JSON.parse(line.slice(5).trim()) as AiEvent;
            events.push(ev);
            if (ev.type === "permission.request") {
              const permRes = await fetch(`${addr}/v1/permissions/${ev.permissionId}/respond`, {
                method: "POST",
                headers: authHeaders,
                body: JSON.stringify({ decision: "allow" }),
              });
              expect(permRes.status).toBe(200);
            }
          }
        }
      }

      const types = events.map((e) => e.type);
      expect(types).toContain("reasoning.delta");
      expect(types).toContain("tool.start");
      expect(types).toContain("tool.end");
      expect(types).toContain("permission.request");
      expect(types).toContain("text.delta");
      expect(types).toContain("usage");
      expect(types[types.length - 1]).toBe("session.idle");
    } finally {
      await app.close();
    }
  }, 15_000);
});

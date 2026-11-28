/** Executes one chat turn: streams events, answers permissions/questions, reports the outcome. */
import type { QuestionRespondRequest, SendMessageRequest } from "../core/api.js";
import type { AiEvent, PermissionDecision } from "../core/events.js";
import { redact } from "../core/redact.js";
import type { BridgeClient } from "./client.js";

export interface TurnHandlers {
  onEvent(ev: AiEvent): void;
  decidePermission(ev: Extract<AiEvent, { type: "permission.request" }>): Promise<PermissionDecision>;
  answerQuestion(ev: Extract<AiEvent, { type: "question" }>): Promise<QuestionRespondRequest>;
  onReconnect?(attempt: number): void;
}

export interface TurnResult {
  ok: boolean;
  errors: string[];
  aborted: boolean;
}

export interface TurnControl {
  /** Request abort of the running turn (POST /abort). Resolves when the request was sent. */
  abort(): Promise<void>;
  done: Promise<TurnResult>;
}

export function startTurn(
  client: BridgeClient,
  sessionId: string,
  req: SendMessageRequest,
  h: TurnHandlers,
  opts: { backoff?: (n: number) => number; maxReconnects?: number } = {},
): TurnControl {
  let aborted = false;
  const errors: string[] = [];
  const done = (async (): Promise<TurnResult> => {
    let sawIdle = false;
    for await (const ev of client.sendMessage(sessionId, req, { ...opts, onReconnect: (n) => h.onReconnect?.(n) })) {
      h.onEvent(ev);
      if (ev.type === "error") errors.push(redact(ev.message));
      else if (ev.type === "session.idle") sawIdle = true;
      else if (ev.type === "permission.request") {
        const decision = await h.decidePermission(ev);
        await client.respondPermission(ev.permissionId, decision);
      } else if (ev.type === "question") {
        const answer = await h.answerQuestion(ev);
        await client.respondQuestion(ev.questionId, answer);
      }
    }
    return { ok: sawIdle && errors.length === 0 && !aborted, errors, aborted };
  })();
  return {
    done,
    abort: async () => {
      aborted = true;
      await client.abort(sessionId).catch(() => undefined);
    },
  };
}

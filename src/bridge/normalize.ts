import type { AiEvent } from "../events.js";

export interface RawOpenCodeEvent {
  type?: string;
  properties?: any;
}

function extractSessionId(props: any, fallbackSessionId: string): string {
  const candidate =
    props?.sessionID ??
    props?.sessionId ??
    props?.part?.sessionID ??
    props?.part?.sessionId ??
    props?.info?.sessionID ??
    props?.info?.sessionId ??
    props?.info?.id;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : fallbackSessionId;
}

function normalizeToolPart(part: any, props: any, sessionId: string): AiEvent | null {
  const state = part?.state ?? {};
  const status = state.status ?? part?.status ?? props?.status;
  const callId = String(part?.callID ?? part?.callId ?? part?.id ?? props?.callId ?? "");
  const name = String(part?.tool ?? part?.name ?? "tool");
  const input = state.input ?? part?.input ?? {};

  if (status === "running" || status === "pending") {
    return { type: "tool.start", sessionId, callId, name, input };
  }
  if (status === "completed") {
    return {
      type: "tool.end",
      sessionId,
      callId,
      output: state.output ?? part?.output ?? null,
    };
  }
  if (status === "error") {
    const rawErr = state.error ?? part?.error;
    const error =
      typeof rawErr === "string"
        ? rawErr
        : typeof rawErr?.message === "string"
          ? rawErr.message
          : "Tool error";
    return {
      type: "tool.end",
      sessionId,
      callId,
      output: part?.output ?? state.output ?? null,
      error,
    };
  }
  return null;
}

/**
 * Normalizes a raw OpenCode SSE event into a shared `AiEvent`, or `null` if ignored.
 */
export function normalizeOpenCodeEvent(raw: RawOpenCodeEvent, fallbackSessionId: string): AiEvent | null {
  const type = raw?.type;
  if (!type) return null;

  if (type === "server.connected" || type === "server.heartbeat") {
    return null;
  }

  const props = raw.properties ?? {};
  const sessionId = extractSessionId(props, fallbackSessionId);

  switch (type) {
    case "message.part.delta": {
      const part = props.part ?? props;
      const text =
        typeof props.delta === "string"
          ? props.delta
          : typeof part?.delta === "string"
            ? part.delta
            : typeof part?.text === "string"
              ? part.text
              : "";
      if (part?.type === "reasoning") {
        return { type: "reasoning.delta", sessionId, text };
      }
      if (part?.type === "text") {
        return { type: "text.delta", sessionId, text };
      }
      return null;
    }

    case "part.updated": {
      const part = props.part ?? props;
      if (part?.type === "tool" || part?.tool) {
        return normalizeToolPart(part, props, sessionId);
      }
      return null;
    }

    case "permission.asked":
    case "permission.updated": {
      const permissionId = String(props.id ?? props.permissionID ?? props.permissionId ?? "");
      const action = String(props.permission ?? props.type ?? props.action ?? "permission");
      const detail = props.metadata ?? props.patterns ?? props.detail ?? props;
      return {
        type: "permission.request",
        sessionId,
        permissionId,
        action,
        detail,
      };
    }

    case "question.asked": {
      const questionId = String(props.id ?? props.questionID ?? props.questionId ?? "");
      const text = String(props.text ?? props.question ?? props.prompt ?? "");
      const options = Array.isArray(props.options)
        ? props.options.map((opt: unknown) =>
            typeof opt === "string" ? opt : String((opt as { label?: unknown })?.label ?? opt),
          )
        : undefined;
      return {
        type: "question",
        sessionId,
        questionId,
        text,
        ...(options ? { options } : {}),
      };
    }

    case "session.idle":
      return { type: "session.idle", sessionId };

    case "session.updated": {
      const status = props.status ?? props.info?.status;
      if (status === "idle" || status?.type === "idle") {
        return { type: "session.idle", sessionId };
      }
      return null;
    }

    case "session.error":
    case "error": {
      const err = props.error ?? props;
      const message =
        typeof err === "string"
          ? err
          : typeof err?.data?.message === "string"
            ? err.data.message
            : typeof err?.message === "string"
              ? err.message
              : "Unknown error";
      return { type: "error", sessionId, message };
    }

    case "message.updated": {
      const info = props.info ?? props;
      const tokens = info?.tokens ?? props.tokens;
      const cost = info?.cost ?? props.cost;
      if (tokens !== undefined || cost !== undefined) {
        const inputTokens =
          typeof tokens?.input === "number"
            ? tokens.input
            : typeof tokens?.inputTokens === "number"
              ? tokens.inputTokens
              : undefined;
        const outputTokens =
          typeof tokens?.output === "number"
            ? tokens.output
            : typeof tokens?.outputTokens === "number"
              ? tokens.outputTokens
              : undefined;
        const costUsd =
          typeof cost === "number"
            ? cost
            : typeof cost?.total === "number"
              ? cost.total
              : undefined;
        return {
          type: "usage",
          sessionId,
          inputTokens,
          outputTokens,
          costUsd,
        };
      }
      return null;
    }

    default:
      return null;
  }
}

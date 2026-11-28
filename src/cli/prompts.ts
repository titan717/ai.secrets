/** Interactive answers for permission requests and agent questions. */
import type { QuestionRespondRequest } from "../core/api.js";
import type { AiEvent, PermissionDecision } from "../core/events.js";
import type { LineReader } from "./io.js";

type PermissionEv = Extract<AiEvent, { type: "permission.request" }>;
type QuestionEv = Extract<AiEvent, { type: "question" }>;

export function parsePermissionAnswer(s: string): PermissionDecision | null {
  const a = s.trim().toLowerCase();
  if (a === "a" || a === "allow" || a === "y" || a === "yes" || a === "once") return "allow";
  if (a === "s" || a === "session" || a === "always") return "allow_session";
  if (a === "d" || a === "deny" || a === "n" || a === "no" || a === "reject") return "deny";
  return null;
}

/** Ask until a valid answer; EOF (or Ctrl+D) denies. */
export async function askPermission(lines: LineReader, _ev: PermissionEv): Promise<PermissionDecision> {
  for (let i = 0; i < 5; i++) {
    const line = await lines.next("[a]llow once / [s]ession / [d]eny: ");
    if (line === null) return "deny";
    const d = parsePermissionAnswer(line);
    if (d) return d;
  }
  return "deny";
}

/**
 * Parse one answer: numbers ("2" or "1,3" when multiple) select options, anything else is free
 * text. Empty input returns null (caller treats it as "skip").
 */
export function parseQuestionAnswer(input: string, options: string[], multiple = false): string[] | null {
  const t = input.trim();
  if (!t) return null;
  if (options.length && /^\d+(\s*,\s*\d+)*$/.test(t)) {
    const idx = t.split(",").map((x) => Number(x.trim()) - 1);
    if (idx.every((i) => i >= 0 && i < options.length)) {
      const picked = idx.map((i) => options[i]!);
      return multiple ? [...new Set(picked)] : [picked[0]!];
    }
  }
  return [t];
}

/** Ask each question; an empty answer or EOF dismisses the whole request. */
export async function askQuestion(lines: LineReader, ev: QuestionEv): Promise<QuestionRespondRequest> {
  const qs = ev.questions?.length ? ev.questions : [{ question: ev.text, options: ev.options ?? [], multiple: false }];
  const answers: string[][] = [];
  for (const q of qs) {
    const hint = q.options.length ? (q.multiple ? "number(s), e.g. 1,3, or text" : "number or text") : "answer";
    const line = await lines.next(`${hint} (empty to dismiss): `);
    if (line === null) return { reject: true };
    const a = parseQuestionAnswer(line, q.options, q.multiple);
    if (!a) return { reject: true };
    answers.push(a);
  }
  return { answers };
}

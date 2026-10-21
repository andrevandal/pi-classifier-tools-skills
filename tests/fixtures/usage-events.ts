/**
 * Synthetic host `turn_end` events for the usage tests. Every event plants canary strings in the fields the plugin
 * must never copy, so a test can show that a record is rebuilt from an allowlist. Nothing here is real data.
 */

import type { TurnEndEvent } from "@earendil-works/pi-coding-agent";

/** One canary per place a host puts content. A record that contains any of them leaked. */
export const CANARY = {
  text: "CANARY_TEXT_T1",
  args: "CANARY_ARGS_A2",
  result: "CANARY_RESULT_R3",
  error: "CANARY_ERROR_E4",
  detail: "CANARY_DETAIL_D5",
  extra: "CANARY_EXTRA_X6",
} as const;

interface Counters {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

function usageObject(o: Counters): Record<string, unknown> {
  const { input = 100, output = 10, cacheRead = 0, cacheWrite = 0, cost = 0.0005 } = o;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: cost / 2, output: cost / 2, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

/** OMP's `usage` on an assistant message; `reasoningTokens` is present only when given. */
export function ompUsage(o: Counters & { reasoningTokens?: number } = {}): Record<string, unknown> {
  const usage = usageObject(o);
  if (o.reasoningTokens !== undefined) usage.reasoningTokens = o.reasoningTokens;
  return usage;
}

/** pi's `usage` on an assistant message; `reasoning` is present only when given. */
export function piUsage(o: Counters & { reasoning?: number } = {}): Record<string, unknown> {
  const usage = usageObject(o);
  if (o.reasoning !== undefined) usage.reasoning = o.reasoning;
  return usage;
}

/** A tool-result message. Its content, details and own usage numbers must never reach a record. */
export function toolResult(name = "read", isError = false): Record<string, unknown> {
  const own = { input: 9_000_000, output: 9_000_000, cacheRead: 9_000_000, cacheWrite: 9_000_000, cost: { total: 99 } };
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: name,
    content: [{ type: "text", text: CANARY.result }],
    details: { note: CANARY.detail, usage: own },
    usage: own,
    isError,
    timestamp: 1_760_000_000_000,
  };
}

/**
 * What one `turn_end` carries. A key present with the value `undefined` leaves that field out of the event, which is
 * how a test builds a message with no `usage` or a turn without `toolResults`.
 */
export interface TurnSpec {
  turnIndex?: number;
  stopReason?: string;
  /** The host's `usage` object; defaults to `ompUsage()` or `piUsage()`. */
  usage?: unknown;
  /** Content blocks after the text block: a string becomes a `toolCall` block of that name, anything else is used as given. */
  calls?: Array<string | Record<string, unknown>>;
  /** Tool-result messages of this turn; default none. */
  results?: unknown[];
  errorStatus?: number;
  /** pi's `messageEntryId`; default `"a1b2c3d4"`. */
  entryId?: string;
}

function given<T>(spec: TurnSpec, key: keyof TurnSpec, fallback: T): T {
  return Object.hasOwn(spec, key) ? (spec[key] as T) : fallback;
}

function defined<T extends Record<string, unknown>>(object: T): T {
  for (const key of Object.keys(object)) if (object[key] === undefined) delete object[key];
  return object;
}

/** A fresh message object each call: a replay guard keyed on identity must see two calls as two messages. */
function assistantMessage(spec: TurnSpec, defaultUsage: Record<string, unknown>): Record<string, unknown> {
  const stopReason = given<string | undefined>(spec, "stopReason", "stop");
  const calls = (spec.calls ?? []).map((call, index) =>
    typeof call === "string"
      ? { type: "toolCall", id: `call_${index + 1}`, name: call, arguments: { path: CANARY.args } }
      : call,
  );
  return defined({
    role: "assistant",
    content: [{ type: "thinking", thinking: CANARY.text }, { type: "text", text: CANARY.text }, ...calls],
    usage: given(spec, "usage", defaultUsage),
    stopReason,
    errorStatus: spec.errorStatus,
    errorMessage: stopReason === "error" || stopReason === "aborted" ? CANARY.error : undefined,
    responseId: "resp-1",
    provider: "synthetic",
    model: "synthetic-1",
    timestamp: 1_760_000_000_000,
    note: CANARY.extra,
  });
}

/** OMP's `turn_end`: `turnIndex`, `message` and `toolResults`, nothing else. */
export function ompTurnEnd(spec: TurnSpec = {}): Record<string, unknown> {
  return defined({
    type: "turn_end",
    turnIndex: given(spec, "turnIndex", 0),
    message: assistantMessage(spec, ompUsage()),
    toolResults: given<unknown[] | undefined>(spec, "results", []),
  });
}

/** pi's `turn_end`: OMP's fields plus the entry id of the message and pi's boundary state. */
export function piTurnEnd(spec: TurnSpec = {}): Record<string, unknown> {
  const piFields = {
    type: "turn_end",
    turnIndex: given(spec, "turnIndex", 0),
    messageEntryId: given(spec, "entryId", "a1b2c3d4"),
    toolResultEntryIds: [],
  } satisfies Pick<TurnEndEvent, "type" | "turnIndex" | "messageEntryId" | "toolResultEntryIds">;
  return defined({
    ...piFields,
    message: assistantMessage(spec, piUsage()),
    toolResults: given<unknown[] | undefined>(spec, "results", []),
    outcome: "completed",
    entries: [],
    continue: false,
    context: { note: CANARY.extra },
  });
}

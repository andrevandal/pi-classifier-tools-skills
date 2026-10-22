/**
 * Session-local `loadout.usage` v1, one per assistant message the host reports through `turn_end`. A decision links
 * only through lifecycle events this plugin saw, never by time, content or order; anything uncertain stays unassigned
 * (`decisionId: null`). Host payloads go through allowlists, so message text, tool arguments and results, and error
 * text never reach a record.
 */

import { newId, normalizeUsage, type UsageObservationV1 } from "./telemetry.ts";

export interface UsageTracker {
  /** The run observations join: opened by `agent_start`, ended by a context boundary. */
  run: { runId: string; decisionId: string | null } | null;
  /** A decision whose hook completed and that no run or turn has claimed yet. */
  armed: string | null;
  /** True from a claim until the next observed turn: a user message in that window is the one the claiming hook classified. */
  fresh: boolean;
  /** The retry number the host announced for the next model attempt (OMP only). */
  retry: number | null;
  /** Assistant messages already observed, by identity: a replayed `turn_end` is not a new model call. */
  seen: WeakSet<object>;
  /** Memory only: observations so far and the latest one. */
  observed: number;
  last: UsageObservationV1 | null;
}

export function createUsageTracker(): UsageTracker {
  return { run: null, armed: null, fresh: false, retry: null, seen: new WeakSet(), observed: 0, last: null };
}

export function armDecision(tracker: UsageTracker, decisionId: string | null): void {
  tracker.armed = decisionId;
}

/** A new run takes the armed decision; retry, wake-up and compaction continuations have none. */
export function startRun(tracker: UsageTracker): void {
  tracker.run = { runId: newId(), decisionId: tracker.armed };
  tracker.fresh = true;
  tracker.armed = null;
}

/** A decision armed inside an open run (queued follow-up or steer) applies from this turn on. */
export function openTurn(tracker: UsageTracker): void {
  if (tracker.run === null) startRun(tracker);
  else if (tracker.armed !== null) {
    tracker.run.decisionId = tracker.armed;
    tracker.fresh = true;
    tracker.armed = null;
  }
}

/**
 * A user message after an observed turn was never classified by a hook (pi delivers a queued follow-up or steer without
 * one), so the rest of the run is unassigned. A message under a claimed decision (an OMP follow-up with a hook) keeps it.
 */
export function deliverMessage(tracker: UsageTracker, event: unknown): void {
  if (tracker.run === null || tracker.fresh) return;
  if (isRecord(event) && isRecord(event.message) && event.message.role === "user") tracker.run.decisionId = null;
}

export function noteRetry(tracker: UsageTracker, attempt: unknown): void {
  tracker.retry = typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt >= 1 ? attempt : null;
}

export function clearRetry(tracker: UsageTracker): void {
  tracker.retry = null;
}

/** A pending decision stays: the host may compact between the hook and the run. */
export function endRun(tracker: UsageTracker): void {
  tracker.run = null;
  tracker.retry = null;
}

/** A decision no run claimed must not reach a later one. */
export function dropArmed(tracker: UsageTracker): void {
  tracker.armed = null;
}

export function endContext(tracker: UsageTracker): void {
  endRun(tracker);
  dropArmed(tracker);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Tool-call counts by name, for registered tools only: a made-up or injected name can carry a path or a secret. */
function toolCallCounts(content: unknown, registered: ReadonlySet<string>): Map<string, number> {
  const counts = new Map<string, number>();
  if (!Array.isArray(content)) return counts;
  for (const block of content) {
    if (isRecord(block) && block.type === "toolCall" && typeof block.name === "string" && registered.has(block.name)) {
      counts.set(block.name, (counts.get(block.name) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * The observation for one `turn_end`, or null when it is not a new assistant message. OMP's event has `turnIndex`,
 * `message` and `toolResults`; pi's adds `messageEntryId`.
 */
export function observeTurn(
  tracker: UsageTracker,
  sessionId: string | null,
  event: unknown,
  registeredTools: ReadonlySet<string>,
): UsageObservationV1 | null {
  if (!isRecord(event) || !isRecord(event.message) || event.message.role !== "assistant") return null;
  const { message } = event;
  if (tracker.seen.has(message)) return null;
  tracker.seen.add(message);
  tracker.run ??= { runId: newId(), decisionId: null };

  const pi = typeof event.messageEntryId === "string";
  const usage = isRecord(message.usage) ? message.usage : {};
  // A host told no usage reports all-zero counters: unknown, not free.
  const reported = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some(
    (value) => typeof value === "number" && value > 0,
  );
  const toolResults = Array.isArray(event.toolResults) ? event.toolResults : null;
  const record = normalizeUsage({
    v: 1,
    eventId: newId(),
    sessionId,
    runId: tracker.run.runId,
    decisionId: tracker.run.decisionId,
    turnIndex: event.turnIndex,
    host: pi ? "pi" : "omp",
    hostEntryId: pi ? event.messageEntryId : null,
    stopReason: message.stopReason,
    tokens: reported
      ? {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          reasoning: pi ? usage.reasoning : usage.reasoningTokens,
        }
      : {},
    costTotal: reported && isRecord(usage.cost) ? usage.cost.total : null,
    toolCalls: Object.fromEntries(toolCallCounts(message.content, registeredTools)),
    toolErrors:
      toolResults === null ? null : toolResults.filter((item) => isRecord(item) && item.isError === true).length,
    errorStatus: message.errorStatus,
    retryAttempt: tracker.retry,
  });
  tracker.retry = null;
  tracker.fresh = false;
  if (record) {
    tracker.observed++;
    tracker.last = record;
  }
  return record;
}

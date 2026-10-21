/**
 * Session-local usage observation: one `loadout.usage` v1 per assistant message the host reports through
 * `turn_end`. A decision is linked only through lifecycle events this plugin saw: the hook that finished, then
 * the run or turn that started after it, and a user message that no hook claimed ends the link. Nothing is matched
 * by time, content or transcript order, and anything uncertain stays unassigned (`decisionId: null`).
 *
 * Host payloads are read through the allowlists below and the record is rebuilt by `normalizeUsage`, so message
 * text, tool arguments and results, and error text never reach it. A tool name in a model message is model output,
 * so only names of tools the host registered are counted.
 */

import { newId, normalizeUsage, type UsageObservationV1 } from "./telemetry.ts";

export interface UsageTracker {
  /** The run observations join: opened by `agent_start`, replaced by the next one, ended by a context boundary. */
  run: { runId: string; decisionId: string | null } | null;
  /** A decision whose hook completed and that no run or turn has claimed yet. */
  armed: string | null;
  /**
   * True from a claim (a run opens, or a turn takes the armed decision) until the next observed turn. A user message
   * that arrives in that window is the one the claiming hook classified.
   */
  fresh: boolean;
  /** The retry number the host announced for the next model attempt (OMP only). */
  retry: number | null;
  /** Assistant messages already observed, by identity: a replayed `turn_end` is not a new model call. */
  seen: WeakSet<object>;
  /** Memory only, kept when nothing is persisted: observations so far and the latest one. */
  observed: number;
  last: UsageObservationV1 | null;
}

export function createUsageTracker(): UsageTracker {
  return { run: null, armed: null, fresh: false, retry: null, seen: new WeakSet(), observed: 0, last: null };
}

/** `before_agent_start` finished: the next run, or inside an open run the next turn, belongs to this decision. */
export function armDecision(tracker: UsageTracker, decisionId: string | null): void {
  tracker.armed = decisionId;
}

/** `agent_start`: a new run. It takes the armed decision; retry, wake-up and compaction continuations have none. */
export function startRun(tracker: UsageTracker): void {
  tracker.run = { runId: newId(), decisionId: tracker.armed };
  tracker.fresh = true;
  tracker.armed = null;
}

/** `turn_start`: a decision armed inside an open run (queued follow-up or steer) applies from this turn on. */
export function openTurn(tracker: UsageTracker): void {
  if (tracker.run === null) startRun(tracker);
  else if (tracker.armed !== null) {
    tracker.run.decisionId = tracker.armed;
    tracker.fresh = true;
    tracker.armed = null;
  }
}

/**
 * `message_start`: a user message that arrives in an open run after an observed turn used the run's decision was
 * never classified by a hook (pi delivers a queued follow-up or steer without one), so the rest of the run is
 * unassigned. A user message that arrives with a claimed decision, like a follow-up OMP ran the hook for, keeps it.
 */
export function deliverMessage(tracker: UsageTracker, event: unknown): void {
  if (tracker.run === null || tracker.fresh) return;
  if (isRecord(event) && isRecord(event.message) && event.message.role === "user") tracker.run.decisionId = null;
}

/** `auto_retry_start` (OMP): the next model attempt is retry number `attempt`. */
export function noteRetry(tracker: UsageTracker, attempt: unknown): void {
  tracker.retry = typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt >= 1 ? attempt : null;
}

export function clearRetry(tracker: UsageTracker): void {
  tracker.retry = null;
}

/** Compaction: later turns are not part of this run. A pending decision stays, because the host may compact between the hook and the run. */
export function endRun(tracker: UsageTracker): void {
  tracker.run = null;
  tracker.retry = null;
}

/** `agent_end`: a decision still pending was never claimed by a run, so it must not reach a later one. */
export function dropArmed(tracker: UsageTracker): void {
  tracker.armed = null;
}

/** A tree move, branch or switch: the run ends and a pending decision no longer applies. */
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
 * The observation for one `turn_end`, or null when the event is not a new assistant message. Reads only the
 * allowlisted fields below: OMP's `turn_end` has `turnIndex`, `message` and `toolResults`; pi's adds `messageEntryId`.
 * `registeredTools` is the host's tool registry: a tool call is counted only under a name in it.
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
  // A host that was told no usage shows all-zero counters. A model turn always consumes tokens, so that is unknown, not free.
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

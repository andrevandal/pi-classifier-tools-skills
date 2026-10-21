/**
 * The usage tracker and the observation builder, driven directly with synthetic `turn_end` events.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ID_PATTERN, newId, type UsageObservationV1 } from "../src/telemetry.ts";
import {
  armDecision,
  clearRetry,
  createUsageTracker,
  dropArmed,
  endContext,
  endRun,
  noteRetry,
  observeTurn,
  openTurn,
  startRun,
  type UsageTracker,
} from "../src/usage.ts";
import {
  CANARY,
  ompTurnEnd,
  ompUsage,
  piTurnEnd,
  piUsage,
  toolResult,
  type TurnSpec,
} from "./fixtures/usage-events.ts";

const SESSION = "session-usage-1";
const KEYS = [
  "v",
  "eventId",
  "sessionId",
  "runId",
  "decisionId",
  "turnIndex",
  "host",
  "hostEntryId",
  "stopReason",
  "tokens",
  "costTotal",
  "toolCalls",
  "toolErrors",
  "errorStatus",
  "retryAttempt",
].sort();
const NO_TOKENS = { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null };
/** The tokens of the default `ompUsage()`. */
const DEFAULT_TOKENS = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: null };

/** One model turn the way the host runs it: `turn_start`, then `turn_end`. */
function turn(tracker: UsageTracker, spec?: TurnSpec): UsageObservationV1 {
  openTurn(tracker);
  const observation = observeTurn(tracker, SESSION, ompTurnEnd(spec));
  assert.ok(observation, "an assistant turn is observed");
  return observation;
}

test("usage: model turns of one run are separate observations that share the run and the armed decision", () => {
  const tracker = createUsageTracker();
  const d1 = newId();
  armDecision(tracker, d1);
  startRun(tracker);
  const first = turn(tracker, { turnIndex: 0 });
  const second = turn(tracker, { turnIndex: 1 });

  assert.equal(first.runId, second.runId);
  assert.equal(first.decisionId, d1);
  assert.equal(second.decisionId, d1);
  assert.notEqual(first.eventId, second.eventId);
  for (const observation of [first, second]) {
    assert.match(observation.eventId, ID_PATTERN);
    assert.match(observation.runId, ID_PATTERN);
    assert.equal(observation.sessionId, SESSION);
  }
  assert.deepEqual([first.turnIndex, second.turnIndex], [0, 1]);
  assert.equal(tracker.observed, 2);
  assert.equal(tracker.last, second);
});

test("usage: a new run restarts the turn index and never reuses a run, an observation or the previous decision", () => {
  const tracker = createUsageTracker();
  const d1 = newId();
  const d2 = newId();
  armDecision(tracker, d1);
  startRun(tracker);
  const a = turn(tracker, { turnIndex: 0 });
  const b = turn(tracker, { turnIndex: 1 });

  startRun(tracker);
  const c = turn(tracker, { turnIndex: 0 });
  assert.equal(c.turnIndex, 0);
  assert.equal(c.decisionId, null);
  assert.notEqual(c.runId, b.runId);
  assert.notEqual(c.eventId, b.eventId);

  armDecision(tracker, d2);
  startRun(tracker);
  const d = turn(tracker, { turnIndex: 0 });
  assert.equal(d.decisionId, d2);
  assert.equal(new Set([a.runId, c.runId, d.runId]).size, 3);
  assert.equal(new Set([a.eventId, b.eventId, c.eventId, d.eventId]).size, 4);
});

test("usage: a decision armed inside an open run applies from the next turn only", () => {
  const tracker = createUsageTracker();
  const [d1, d2, d3] = [newId(), newId(), newId()];
  armDecision(tracker, d1);
  startRun(tracker);
  const first = turn(tracker);
  assert.equal(first.decisionId, d1);

  armDecision(tracker, d2);
  const second = turn(tracker, { turnIndex: 1 });
  assert.equal(second.decisionId, d2);
  assert.equal(second.runId, first.runId);
  assert.equal(turn(tracker, { turnIndex: 2 }).decisionId, d2);

  // Armed while a model call is in flight: that turn stays on d2, the next one is d3.
  openTurn(tracker);
  armDecision(tracker, d3);
  const inFlight = observeTurn(tracker, SESSION, ompTurnEnd({ turnIndex: 3 }));
  assert.equal(inFlight?.decisionId, d2);
  assert.equal(turn(tracker, { turnIndex: 4 }).decisionId, d3);
});

test("usage: a decision is claimed once and a hook whose prompt never ran does not leak into a later run", () => {
  const tracker = createUsageTracker();
  const d1 = newId();
  armDecision(tracker, d1);
  startRun(tracker);
  assert.equal(turn(tracker).decisionId, d1);

  startRun(tracker);
  assert.equal(turn(tracker).decisionId, null);

  armDecision(tracker, d1);
  dropArmed(tracker);
  startRun(tracker);
  assert.equal(turn(tracker).decisionId, null);

  // Two run starts with no turn between them: the decision belongs to the first run only.
  armDecision(tracker, d1);
  startRun(tracker);
  startRun(tracker);
  assert.equal(turn(tracker).decisionId, null);
});

test("usage: context boundaries end the run; compaction keeps a pending decision and a tree move drops it", () => {
  const d1 = newId();

  const a = createUsageTracker();
  armDecision(a, d1);
  startRun(a);
  const before = turn(a);
  endRun(a);
  const after = turn(a);
  assert.notEqual(after.runId, before.runId);
  assert.equal(after.decisionId, null);

  const b = createUsageTracker();
  armDecision(b, d1);
  endRun(b);
  startRun(b);
  assert.equal(turn(b).decisionId, d1);

  const c = createUsageTracker();
  armDecision(c, d1);
  endContext(c);
  startRun(c);
  assert.equal(turn(c).decisionId, null);

  const d = createUsageTracker();
  startRun(d);
  noteRetry(d, 1);
  endRun(d);
  assert.equal(turn(d).retryAttempt, null);
});

test("usage: a turn seen without agent_start or turn_start still gets a run and no decision", () => {
  const tracker = createUsageTracker();
  const first = observeTurn(tracker, SESSION, ompTurnEnd());
  assert.ok(first);
  assert.match(first.runId, ID_PATTERN);
  assert.equal(first.decisionId, null);

  const second = observeTurn(tracker, SESSION, ompTurnEnd({ turnIndex: 1 }));
  assert.equal(second?.runId, first.runId);

  // A turn start with no run opens one, and it claims the decision armed before it.
  const fresh = createUsageTracker();
  const d1 = newId();
  armDecision(fresh, d1);
  openTurn(fresh);
  const claimed = observeTurn(fresh, SESSION, ompTurnEnd());
  assert.equal(claimed?.decisionId, d1);
  assert.match(claimed?.runId ?? "", ID_PATTERN);
});

test("usage: omp and pi turn_end payloads map to one schema with unsupported fields unknown", () => {
  const omp = observeTurn(
    createUsageTracker(),
    SESSION,
    ompTurnEnd({
      usage: ompUsage({ input: 80, output: 15, cacheRead: 40, reasoningTokens: 7, cost: 0.00013 }),
      calls: ["read"],
      results: [toolResult()],
    }),
  );
  assert.ok(omp);
  assert.equal(omp.host, "omp");
  assert.equal(omp.hostEntryId, null);
  assert.deepEqual(omp.tokens, { input: 80, output: 15, cacheRead: 40, cacheWrite: 0, reasoning: 7 });
  assert.equal(omp.costTotal, 0.00013);
  assert.deepEqual(omp.toolCalls, { read: 1 });
  assert.equal(omp.toolErrors, 0);
  assert.equal(omp.errorStatus, null);
  assert.equal(omp.retryAttempt, null);

  const pi = observeTurn(
    createUsageTracker(),
    SESSION,
    piTurnEnd({
      usage: piUsage({ input: 80, output: 15, cacheRead: 40, reasoning: 7, cost: 0.00013 }),
      calls: ["read"],
      results: [toolResult()],
    }),
  );
  assert.ok(pi);
  assert.equal(pi.host, "pi");
  assert.equal(pi.hostEntryId, "a1b2c3d4");
  assert.deepEqual(pi.tokens, omp.tokens);
  assert.equal(pi.costTotal, omp.costTotal);
  assert.equal(pi.errorStatus, null);
  assert.equal(pi.retryAttempt, null);

  assert.equal(observeTurn(createUsageTracker(), SESSION, ompTurnEnd())?.tokens.reasoning, null);
  assert.equal(observeTurn(createUsageTracker(), SESSION, piTurnEnd())?.tokens.reasoning, null);
  assert.equal(observeTurn(createUsageTracker(), SESSION, ompTurnEnd({ errorStatus: 503 }))?.errorStatus, 503);
  for (const observation of [omp, pi]) assert.deepEqual(Object.keys(observation).sort(), KEYS);
});

test("usage: error, aborted and missing-usage turns stay unknown instead of becoming zero-cost successes", () => {
  const zeros = ompUsage({ input: 0, output: 0, cost: 0 });
  const cases: Array<{
    name: string;
    spec: TurnSpec;
    tokens: UsageObservationV1["tokens"];
    costTotal: number | null;
    stopReason: UsageObservationV1["stopReason"];
    errorStatus?: number;
  }> = [
    {
      name: "an error with a status and zero counters",
      spec: { stopReason: "error", errorStatus: 503, usage: zeros },
      tokens: NO_TOKENS,
      costTotal: null,
      stopReason: "error",
      errorStatus: 503,
    },
    {
      name: "an aborted turn with zero counters",
      spec: { stopReason: "aborted", usage: zeros },
      tokens: NO_TOKENS,
      costTotal: null,
      stopReason: "aborted",
    },
    {
      name: "an error that did report input tokens keeps the measured zeros",
      spec: { stopReason: "error", usage: ompUsage({ input: 12, output: 0, cost: 0.0001 }) },
      tokens: { input: 12, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null },
      costTotal: 0.0001,
      stopReason: "error",
    },
    {
      name: "a success with zero counters",
      spec: { usage: zeros },
      tokens: NO_TOKENS,
      costTotal: null,
      stopReason: "stop",
    },
    {
      name: "a success with no usage",
      spec: { usage: undefined },
      tokens: NO_TOKENS,
      costTotal: null,
      stopReason: "stop",
    },
    {
      name: "a success reporting only input and no cost",
      spec: { usage: { input: 5 } },
      tokens: { input: 5, output: null, cacheRead: null, cacheWrite: null, reasoning: null },
      costTotal: null,
      stopReason: "stop",
    },
    {
      name: "counters and cost that are not valid numbers",
      spec: { usage: { input: Number.NaN, output: -3, cacheRead: 1.5, cacheWrite: "9", cost: { total: -1 } } },
      tokens: NO_TOKENS,
      costTotal: null,
      stopReason: "stop",
    },
    {
      name: "no stop reason",
      spec: { stopReason: undefined },
      tokens: DEFAULT_TOKENS,
      costTotal: 0.0005,
      stopReason: null,
    },
  ];
  for (const { name, spec, tokens, costTotal, stopReason, errorStatus } of cases) {
    const observation = observeTurn(createUsageTracker(), SESSION, ompTurnEnd(spec));
    assert.ok(observation, name);
    assert.deepEqual(observation.tokens, tokens, name);
    assert.equal(observation.costTotal, costTotal, name);
    assert.equal(observation.stopReason, stopReason, name);
    assert.equal(observation.errorStatus, errorStatus ?? null, name);
  }

  for (const stopReason of ["pending", "weird CANARY"]) {
    const observation = observeTurn(createUsageTracker(), SESSION, ompTurnEnd({ stopReason }));
    assert.equal(observation?.stopReason, "other", stopReason);
  }
});

test("usage: a host retry announcement marks only the next observation", () => {
  const tracker = createUsageTracker();
  noteRetry(tracker, 2);
  assert.equal(turn(tracker).retryAttempt, 2);
  assert.equal(turn(tracker).retryAttempt, null);

  noteRetry(tracker, 1);
  clearRetry(tracker);
  assert.equal(turn(tracker).retryAttempt, null);

  for (const attempt of [0, "3", 1.5, undefined]) {
    noteRetry(tracker, attempt);
    assert.equal(turn(tracker).retryAttempt, null, String(attempt));
  }
});

test("usage: a replayed turn_end counts once and only assistant messages are observed", () => {
  const tracker = createUsageTracker();
  const event = ompTurnEnd();
  assert.ok(observeTurn(tracker, SESSION, event));
  assert.equal(observeTurn(tracker, SESSION, event), null);
  assert.equal(tracker.observed, 1);

  const assistant = ompTurnEnd().message;
  const ignored: unknown[] = [
    { ...ompTurnEnd(), message: { role: "user", content: "hello" } },
    { ...ompTurnEnd(), message: toolResult() },
    { ...ompTurnEnd(), message: null },
    { ...ompTurnEnd(), message: undefined },
    { ...ompTurnEnd(), message: 7 },
    { ...ompTurnEnd(), message: [assistant] },
    null,
    undefined,
    7,
    "turn_end",
    [event],
  ];
  for (const value of ignored) assert.equal(observeTurn(tracker, SESSION, value), null);
  assert.equal(tracker.observed, 1);
});

test("usage: tool counts and errors come from this message and this turn's results only", () => {
  const calls = ["read", "read", "bash", "bash; CANARY", "__proto__", { type: "toolCall", id: "call_9", name: 42 }];
  const results = [toolResult("read", true), toolResult("read", false), { isError: "yes" }, null];
  const observation = observeTurn(createUsageTracker(), SESSION, ompTurnEnd({ calls, results }));
  assert.ok(observation);
  assert.deepEqual(observation.toolCalls, { read: 2, bash: 1 });
  assert.equal(observation.toolErrors, 1);
  // A tool result's own usage is not this turn's usage.
  assert.deepEqual(observation.tokens, DEFAULT_TOKENS);
  assert.equal(observation.costTotal, 0.0005);

  assert.equal(observeTurn(createUsageTracker(), SESSION, ompTurnEnd({ calls, results: undefined }))?.toolErrors, null);
  assert.equal(observeTurn(createUsageTracker(), SESSION, ompTurnEnd({ calls, results: [] }))?.toolErrors, 0);
});

test("usage: the record is rebuilt from an allowlist", () => {
  const event = {
    ...piTurnEnd({ stopReason: "error", calls: ["read"], results: [toolResult("read", true)] }),
    entries: [{ type: "custom", customType: "x", data: CANARY.extra }],
  };
  // Guard: every canary is in the event, so a clean record is not a clean input.
  for (const canary of Object.values(CANARY)) assert.ok(JSON.stringify(event).includes(canary), canary);

  const observation = observeTurn(createUsageTracker(), SESSION, event);
  assert.ok(observation);
  assert.doesNotMatch(JSON.stringify(observation), /CANARY/);
  assert.deepEqual(Object.keys(observation).sort(), KEYS);
  assert.deepEqual(observation.toolCalls, { read: 1 });
});

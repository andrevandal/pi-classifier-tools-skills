/**
 * The usage tracker and the observation builder, driven directly with synthetic `turn_end` events, and the plugin
 * inside real in-process pi sessions on pi's faux provider (no network, no credentials).
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { findPackageJSON } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import loadout from "../src/index.ts";
import { type DecisionRecordV3, ID_PATTERN, newId, type UsageObservationV1 } from "../src/telemetry.ts";
import {
  armDecision,
  clearRetry,
  createUsageTracker,
  deliverMessage,
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
  INVENTED_TOOL_NAMES,
  ompTurnEnd,
  ompUsage,
  piTurnEnd,
  piUsage,
  toolResult,
  type TurnSpec,
} from "./fixtures/usage-events.ts";

// npm nests pi-ai under pi's shrinkwrap, Bun hoists it: resolve from pi so both layouts load pi's own copy.
const piAiJson = findPackageJSON("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent"));
if (piAiJson === undefined) throw new Error("@earendil-works/pi-ai not found next to @earendil-works/pi-coding-agent");
const piAiEntry = path.join(path.dirname(piAiJson), JSON.parse(fs.readFileSync(piAiJson, "utf8")).exports["."].import);
const { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore } = await import(
  pathToFileURL(piAiEntry).href
);

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
/** The tools this host has registered. Any other name in a tool call is model output, not a tool. */
const REGISTERED: ReadonlySet<string> = new Set(["read", "bash", "edit", "task"]);

/** One model turn the way the host runs it: `turn_start`, then `turn_end`. */
function turn(tracker: UsageTracker, spec?: TurnSpec): UsageObservationV1 {
  openTurn(tracker);
  const observation = observeTurn(tracker, SESSION, ompTurnEnd(spec), REGISTERED);
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
  const inFlight = observeTurn(tracker, SESSION, ompTurnEnd({ turnIndex: 3 }), REGISTERED);
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
  const first = observeTurn(tracker, SESSION, ompTurnEnd(), REGISTERED);
  assert.ok(first);
  assert.match(first.runId, ID_PATTERN);
  assert.equal(first.decisionId, null);

  const second = observeTurn(tracker, SESSION, ompTurnEnd({ turnIndex: 1 }), REGISTERED);
  assert.equal(second?.runId, first.runId);

  // A turn start with no run opens one, and it claims the decision armed before it.
  const fresh = createUsageTracker();
  const d1 = newId();
  armDecision(fresh, d1);
  openTurn(fresh);
  const claimed = observeTurn(fresh, SESSION, ompTurnEnd(), REGISTERED);
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
    REGISTERED,
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
    REGISTERED,
  );
  assert.ok(pi);
  assert.equal(pi.host, "pi");
  assert.equal(pi.hostEntryId, "a1b2c3d4");
  assert.deepEqual(pi.tokens, omp.tokens);
  assert.equal(pi.costTotal, omp.costTotal);
  assert.equal(pi.errorStatus, null);
  assert.equal(pi.retryAttempt, null);

  assert.equal(observeTurn(createUsageTracker(), SESSION, ompTurnEnd(), REGISTERED)?.tokens.reasoning, null);
  assert.equal(observeTurn(createUsageTracker(), SESSION, piTurnEnd(), REGISTERED)?.tokens.reasoning, null);
  assert.equal(
    observeTurn(createUsageTracker(), SESSION, ompTurnEnd({ errorStatus: 503 }), REGISTERED)?.errorStatus,
    503,
  );
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
    const observation = observeTurn(createUsageTracker(), SESSION, ompTurnEnd(spec), REGISTERED);
    assert.ok(observation, name);
    assert.deepEqual(observation.tokens, tokens, name);
    assert.equal(observation.costTotal, costTotal, name);
    assert.equal(observation.stopReason, stopReason, name);
    assert.equal(observation.errorStatus, errorStatus ?? null, name);
  }

  for (const stopReason of ["pending", "weird CANARY"]) {
    const observation = observeTurn(createUsageTracker(), SESSION, ompTurnEnd({ stopReason }), REGISTERED);
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
  assert.ok(observeTurn(tracker, SESSION, event, REGISTERED));
  assert.equal(observeTurn(tracker, SESSION, event, REGISTERED), null);
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
  for (const value of ignored) assert.equal(observeTurn(tracker, SESSION, value, REGISTERED), null);
  assert.equal(tracker.observed, 1);
});

test("usage: tool counts and errors come from this message and this turn's results only", () => {
  const calls = [
    "read",
    "read",
    "bash",
    "bash; CANARY",
    "__proto__",
    ...INVENTED_TOOL_NAMES,
    { type: "toolCall", id: "call_9", name: 42 },
  ];
  const results = [toolResult("read", true), toolResult("read", false), { isError: "yes" }, null];
  const observation = observeTurn(createUsageTracker(), SESSION, ompTurnEnd({ calls, results }), REGISTERED);
  assert.ok(observation);
  assert.deepEqual(observation.toolCalls, { read: 2, bash: 1 });
  assert.doesNotMatch(JSON.stringify(observation), /CANARY|secret|example\.com|sk-live/);
  assert.equal(observation.toolErrors, 1);
  // A tool result's own usage is not this turn's usage.
  assert.deepEqual(observation.tokens, DEFAULT_TOKENS);
  assert.equal(observation.costTotal, 0.0005);

  assert.equal(
    observeTurn(createUsageTracker(), SESSION, ompTurnEnd({ calls, results: undefined }), REGISTERED)?.toolErrors,
    null,
  );
  assert.equal(
    observeTurn(createUsageTracker(), SESSION, ompTurnEnd({ calls, results: [] }), REGISTERED)?.toolErrors,
    0,
  );
});

test("usage: only names of registered tools are stored, so a name the model made up never reaches a record", () => {
  const calls = ["read", ...INVENTED_TOOL_NAMES, "bash", "read"];
  // Guard: the made-up names are in the event, and the record schema accepts the spelling of each one. When the host
  // did register them they are counted, so the registry decides, not the spelling.
  for (const name of INVENTED_TOOL_NAMES) assert.ok(JSON.stringify(ompTurnEnd({ calls })).includes(name), name);
  const registeredToo = new Set([...REGISTERED, ...INVENTED_TOOL_NAMES]);
  const counted = observeTurn(createUsageTracker(), SESSION, ompTurnEnd({ calls }), registeredToo);
  assert.deepEqual(counted?.toolCalls, {
    read: 2,
    bash: 1,
    ...Object.fromEntries(INVENTED_TOOL_NAMES.map((name) => [name, 1])),
  });

  const observation = observeTurn(createUsageTracker(), SESSION, ompTurnEnd({ calls }), REGISTERED);
  assert.deepEqual(observation?.toolCalls, { read: 2, bash: 1 });
  assert.doesNotMatch(JSON.stringify(observation), /CANARY|secret|example\.com|sk-live/);

  // A registry that could not be read counts no names, and the rest of the record is intact.
  const unreadable = observeTurn(createUsageTracker(), SESSION, ompTurnEnd({ calls }), new Set());
  assert.deepEqual(unreadable?.toolCalls, {});
  assert.deepEqual(unreadable?.tokens, DEFAULT_TOKENS);
  assert.equal(unreadable?.stopReason, "stop");
});

test("usage: the record is rebuilt from an allowlist", () => {
  const event = {
    ...piTurnEnd({ stopReason: "error", calls: ["read", CANARY.tool], results: [toolResult("read", true)] }),
    entries: [{ type: "custom", customType: "x", data: CANARY.extra }],
  };
  // Guard: every canary is in the event, so a clean record is not a clean input.
  for (const canary of Object.values(CANARY)) assert.ok(JSON.stringify(event).includes(canary), canary);

  const observation = observeTurn(createUsageTracker(), SESSION, event, REGISTERED);
  assert.ok(observation);
  assert.doesNotMatch(JSON.stringify(observation), /CANARY/);
  assert.deepEqual(Object.keys(observation).sort(), KEYS);
  assert.deepEqual(observation.toolCalls, { read: 1 });
});

/** The host's `message_start` for a message with this role. */
const messageStart = (role: unknown) => ({ type: "message_start", message: { role, content: CANARY.text } });

test("usage: a user message that no decision hook claimed leaves the rest of the run unassigned", () => {
  const tracker = createUsageTracker();
  const [d1, d2] = [newId(), newId()];
  armDecision(tracker, d1);
  startRun(tracker);
  // The prompt the hook classified arrives with the run's first turn.
  openTurn(tracker);
  deliverMessage(tracker, messageStart("user"));
  const first = observeTurn(tracker, SESSION, ompTurnEnd(), REGISTERED);
  assert.equal(first?.decisionId, d1);

  // A queued follow-up or steer on pi: no hook ran, so only the host's turn start and its user message arrive.
  openTurn(tracker);
  deliverMessage(tracker, messageStart("user"));
  const second = observeTurn(tracker, SESSION, ompTurnEnd({ turnIndex: 1 }), REGISTERED);
  assert.equal(second?.decisionId, null);
  assert.equal(second?.runId, first?.runId);
  // The turns that follow in the run stay unassigned.
  assert.equal(turn(tracker, { turnIndex: 2 }).decisionId, null);

  // The next hook starts a new run under its own decision.
  armDecision(tracker, d2);
  startRun(tracker);
  openTurn(tracker);
  deliverMessage(tracker, messageStart("user"));
  const third = observeTurn(tracker, SESSION, ompTurnEnd(), REGISTERED);
  assert.equal(third?.decisionId, d2);
  assert.notEqual(third?.runId, first?.runId);

  // A hook that built no decision (null) does not leave the previous decision on its message either.
  armDecision(tracker, null);
  openTurn(tracker);
  deliverMessage(tracker, messageStart("user"));
  assert.equal(observeTurn(tracker, SESSION, ompTurnEnd({ turnIndex: 1 }), REGISTERED)?.decisionId, null);
});

test("usage: a user message that a hook claimed keeps its decision", () => {
  const tracker = createUsageTracker();
  const [d1, d2] = [newId(), newId()];
  armDecision(tracker, d1);
  startRun(tracker);
  // Two user messages before the run's first model call (one queued before the first turn) are one turn of d1.
  openTurn(tracker);
  deliverMessage(tracker, messageStart("user"));
  deliverMessage(tracker, messageStart("user"));
  assert.equal(observeTurn(tracker, SESSION, ompTurnEnd(), REGISTERED)?.decisionId, d1);

  // omp runs the hook for a queued follow-up: it is claimed at the turn start, before the user message.
  armDecision(tracker, d2);
  openTurn(tracker);
  deliverMessage(tracker, messageStart("user"));
  assert.equal(observeTurn(tracker, SESSION, ompTurnEnd({ turnIndex: 1 }), REGISTERED)?.decisionId, d2);
  assert.equal(turn(tracker, { turnIndex: 2 }).decisionId, d2);
});

test("usage: only a user message changes the run, and anything else changes nothing", () => {
  const tracker = createUsageTracker();
  const d1 = newId();
  armDecision(tracker, d1);
  startRun(tracker);
  // The first turn used the claim: from here on, a user message would unassign the run.
  assert.equal(turn(tracker).decisionId, d1);

  const roles = ["assistant", "toolResult", "custom", "developer", "bashExecution", 7, null, undefined];
  const ignored: unknown[] = [
    null,
    undefined,
    7,
    "x",
    [],
    {},
    { message: null },
    { message: 7 },
    { message: [] },
    { message: {} },
    { message: { role: ["user"] } },
    { message: { role: "User" } },
    ...roles.map(messageStart),
  ];
  for (const event of ignored) deliverMessage(tracker, event);
  assert.equal(turn(tracker, { turnIndex: 1 }).decisionId, d1);

  // Without a run there is nothing to unassign, and none is made up.
  const empty = createUsageTracker();
  deliverMessage(empty, messageStart("user"));
  assert.equal(empty.run, null);
});

// Real pi sessions: the plugin loaded as an extension of an in-process AgentSession on pi's faux provider.

let home = "";

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "loadout-usage-"));
  fs.mkdirSync(path.join(home, ".omp"));
  process.env.HOME = home;
  delete process.env.LOADOUT_CONFIG;
});

after(() => fs.rmSync(home, { recursive: true, force: true }));

async function piSession(loadoutConfig: Record<string, unknown>) {
  fs.writeFileSync(path.join(home, ".omp", "loadout.json"), JSON.stringify(loadoutConfig));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loadout-usage-pi-"));
  const cwd = path.join(root, "cwd");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd);
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(cwd, "notes.txt"), "synthetic notes\n");
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  // In-memory stores: pi's file-backed ones write auth.json and models-store.json after the session is disposed.
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [loadout] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 },
    }),
    tools: ["read"],
  });
  return {
    session,
    faux,
    dispose: () => {
      session.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function customEntries(session: AgentSession, customType: string): unknown[] {
  return session.sessionManager
    .getEntries()
    .flatMap((entry) => (entry.type === "custom" && entry.customType === customType ? [entry.data] : []));
}

const usageEntries = (session: AgentSession) => customEntries(session, "loadout.usage") as UsageObservationV1[];
const decisionEntries = (session: AgentSession) => customEntries(session, "loadout.decision") as DecisionRecordV3[];

/** The persisted assistant message that a record's `hostEntryId` points at. */
function assistantMessageOf(session: AgentSession, entryId: string | null) {
  const entry = entryId === null ? undefined : session.sessionManager.getEntry(entryId);
  assert.ok(entry?.type === "message" && entry.message.role === "assistant", `no assistant message entry ${entryId}`);
  return entry.message;
}

test("pi session: two model turns and a tool call give two observations linked to the decision", async () => {
  const { session, faux, dispose } = await piSession({ enabled: false, notify: false });
  try {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("DONE"),
    ]);
    await session.prompt("Read notes.txt and reply DONE.");
    assert.equal(faux.getPendingResponseCount(), 0);

    const decisions = decisionEntries(session);
    const usages = usageEntries(session);
    assert.equal(decisions.length, 1);
    assert.equal(usages.length, 2);
    const [first, second] = usages;
    assert.ok(first && second);
    assert.equal(first.decisionId, decisions[0]?.decisionId);
    assert.equal(second.decisionId, decisions[0]?.decisionId);
    assert.equal(first.runId, second.runId);
    assert.deepEqual([first.turnIndex, second.turnIndex], [0, 1]);
    assert.deepEqual([first.host, second.host], ["pi", "pi"]);
    assert.deepEqual([first.toolCalls, second.toolCalls], [{ read: 1 }, {}]);
    assert.deepEqual([first.toolErrors, second.toolErrors], [0, 0]);
    for (const observation of usages) {
      const message = assistantMessageOf(session, observation.hostEntryId);
      assert.equal(message.stopReason, observation.stopReason);
      assert.equal(message.usage.input, observation.tokens.input);
      assert.equal(message.usage.cost.total, observation.costTotal);
    }
  } finally {
    dispose();
  }
});

test("pi session: a second prompt starts a new run under its own decision", async () => {
  const { session, faux, dispose } = await piSession({ enabled: false, notify: false });
  try {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("first done"),
      fauxAssistantMessage("second done"),
    ]);
    await session.prompt("Read notes.txt and reply.");
    await session.prompt("Reply once more.");
    assert.equal(faux.getPendingResponseCount(), 0);

    const decisions = decisionEntries(session);
    const usages = usageEntries(session);
    assert.equal(decisions.length, 2);
    assert.equal(usages.length, 3);
    const [first, , third] = usages;
    assert.ok(first && third);
    assert.notEqual(third.runId, first.runId);
    assert.equal(third.turnIndex, 0);
    assert.equal(third.decisionId, decisions[1]?.decisionId);
    assert.notEqual(decisions[1]?.decisionId, decisions[0]?.decisionId);
    assert.equal(new Set(usages.map((observation) => observation.eventId)).size, 3);
  } finally {
    dispose();
  }
});

test("pi session: a provider error and its continuation are two observations and the continuation is unassigned", async () => {
  const { session, faux, dispose } = await piSession({ enabled: false, notify: false });
  try {
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable: overloaded" }),
      fauxAssistantMessage("recovered"),
    ]);
    await session.prompt("Reply once.");
    assert.equal(faux.getPendingResponseCount(), 0);

    const decisions = decisionEntries(session);
    const usages = usageEntries(session);
    assert.equal(decisions.length, 1);
    assert.equal(usages.length, 2);
    const [failed, recovered] = usages;
    assert.ok(failed && recovered);
    assert.equal(failed.stopReason, "error");
    assert.equal(failed.decisionId, decisions[0]?.decisionId);
    assert.equal(assistantMessageOf(session, failed.hostEntryId).stopReason, "error");
    assert.equal(recovered.stopReason, "stop");
    assert.equal(recovered.decisionId, null);
    assert.notEqual(recovered.runId, failed.runId);
    assert.equal(recovered.turnIndex, 0);
    assert.equal(recovered.retryAttempt, null);
  } finally {
    dispose();
  }
});

test("pi session: machine telemetry off writes nothing while the turns complete", async () => {
  const { session, faux, dispose } = await piSession({ telemetry: false, enabled: false, notify: false });
  try {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("DONE"),
    ]);
    await session.prompt("Read notes.txt and reply DONE.");
    assert.equal(faux.getPendingResponseCount(), 0);

    const entries = session.sessionManager.getEntries();
    assert.equal(
      entries.filter((entry) => entry.type === "custom" && entry.customType.startsWith("loadout.")).length,
      0,
    );
    assert.equal(entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length, 2);
  } finally {
    dispose();
  }
});

const userMessageCount = (session: AgentSession) =>
  session.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user")
    .length;

test("pi session: a follow-up queued during a run is delivered without a decision hook and is unassigned", async () => {
  const { session, faux, dispose } = await piSession({ enabled: false, notify: false });
  try {
    faux.setResponses([
      // The follow-up is queued while the first model call is in flight, like a user typing during the reply.
      async () => {
        await session.followUp("Reply once more.");
        return fauxAssistantMessage("first done");
      },
      fauxAssistantMessage("second done"),
    ]);
    await session.prompt("Reply once.");
    assert.equal(faux.getPendingResponseCount(), 0);

    // Guard: the follow-up ran inside this run as a second user message, and pi ran no second hook for it.
    assert.equal(userMessageCount(session), 2);
    const decisions = decisionEntries(session);
    assert.equal(decisions.length, 1);
    const usages = usageEntries(session);
    assert.equal(usages.length, 2);
    const [first, second] = usages;
    assert.ok(first && second);
    assert.equal(first.decisionId, decisions[0]?.decisionId);
    assert.equal(second.decisionId, null);
    assert.equal(second.runId, first.runId);
    assert.deepEqual([first.turnIndex, second.turnIndex], [0, 1]);
  } finally {
    dispose();
  }
});

test("pi session: a steer queued during a tool turn is delivered without a decision hook and is unassigned", async () => {
  const { session, faux, dispose } = await piSession({ enabled: false, notify: false });
  try {
    faux.setResponses([
      async () => {
        await session.steer("Skip the rest.");
        return fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })], { stopReason: "toolUse" });
      },
      fauxAssistantMessage("steered"),
    ]);
    await session.prompt("Read notes.txt.");
    assert.equal(faux.getPendingResponseCount(), 0);

    assert.equal(userMessageCount(session), 2);
    const decisions = decisionEntries(session);
    assert.equal(decisions.length, 1);
    const usages = usageEntries(session);
    assert.equal(usages.length, 2);
    const [first, second] = usages;
    assert.ok(first && second);
    assert.equal(first.stopReason, "toolUse");
    assert.equal(first.decisionId, decisions[0]?.decisionId);
    assert.equal(second.decisionId, null);
    assert.equal(second.runId, first.runId);
    assert.deepEqual([first.turnIndex, second.turnIndex], [0, 1]);
  } finally {
    dispose();
  }
});

test("pi session: a tool name the model made up is not stored, a registered one is", async () => {
  const { session, faux, dispose } = await piSession({ enabled: false, notify: false });
  try {
    const calls = [
      fauxToolCall("read", { path: "notes.txt" }, { id: "call_1" }),
      ...INVENTED_TOOL_NAMES.map((name, index) => fauxToolCall(name, {}, { id: `call_${index + 2}` })),
    ];
    faux.setResponses([fauxAssistantMessage(calls, { stopReason: "toolUse" }), fauxAssistantMessage("DONE")]);
    await session.prompt("Read notes.txt.");
    assert.equal(faux.getPendingResponseCount(), 0);

    const [first] = usageEntries(session);
    assert.ok(first);
    // Guard: pi stored the made-up calls in the assistant message and flagged each one as a failed tool result.
    const content = JSON.stringify(assistantMessageOf(session, first.hostEntryId).content);
    for (const name of INVENTED_TOOL_NAMES) assert.ok(content.includes(name), name);
    assert.equal(first.toolErrors, INVENTED_TOOL_NAMES.length);
    assert.deepEqual(first.toolCalls, { read: 1 });
    assert.doesNotMatch(JSON.stringify(usageEntries(session)), /CANARY|secret|example\.com|sk-live/);
  } finally {
    dispose();
  }
});

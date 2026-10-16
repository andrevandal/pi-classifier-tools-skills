import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultConfig } from "../src/config.ts";
import { decideSkills, decideTools, profileOrder } from "../src/select.ts";
import {
  buildDecisionRecord,
  type ClassifierEvidence,
  type DecisionInput,
  ID_PATTERN,
  newId,
  normalizeDecision,
  normalizeHttp,
  normalizeUsage,
  persistRecord,
  safeErrorCode,
  safeModel,
  safeStatus,
  safeTiming,
  safeUsage,
  settingsSnapshot,
} from "../src/telemetry.ts";
import type { Answer } from "../src/types.ts";

const BASELINE = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const ON = { persist: true, reason: "default" } as const;
const OFF = { persist: false, reason: "machine-off" } as const;

function evidence(over: Partial<ClassifierEvidence> = {}): ClassifierEvidence {
  return {
    requestId: newId(),
    model: "jev-latest",
    elapsedMs: 40,
    budgetMs: 3250,
    timeoutMs: 3000,
    guardFired: false,
    usage: { inputTokens: 11, outputTokens: 7 },
    server: null,
    status: null,
    promptChars: 120,
    sentChars: 120,
    questions: 1,
    ...over,
  };
}

function choice(probabilities: Record<string, number>): Answer {
  return { type: "choice", choice: "answer", probabilities, confidence: 0.9 };
}

function input(over: Partial<DecisionInput> = {}): DecisionInput {
  const config = defaultConfig();
  const order = profileOrder(config.tools);
  return {
    eventId: newId(),
    decisionId: newId(),
    sessionId: "sess-1",
    settings: settingsSnapshot(config, null),
    gate: null,
    failure: null,
    classifier: evidence(),
    decision: {
      tools: decideTools(config.tools, BASELINE, choice({ answer: 0.95, edit: 0.03, full: 0.02 })),
      skills: decideSkills({ ...config.skills, enabled: true }, [{ name: "pdf", description: "d" }], {
        "skill:pdf": { type: "noul", noul: 0.9, confidence: 0.8 },
      }),
    },
    order,
    maxRisk: config.tools.maxRisk,
    skills: {
      discovered: 2,
      eligible: 1,
      maxCandidates: 40,
      asked: 1,
      filteredOut: null,
      delivery: "hint",
      decision: null,
    },
    ratchet: { narrowAllowed: true, before: null, after: "answer", admitted: true },
    application: { status: "applied", restoration: null, actualTools: ["read", "grep"], error: null },
    ...over,
  };
}

test("ids are UUIDv4 and unique", () => {
  const a = newId();
  assert.match(a, ID_PATTERN);
  assert.notEqual(a, newId());
  assert.doesNotMatch(a.toUpperCase(), ID_PATTERN);
  assert.doesNotMatch("6ba7b810-9dad-11d1-80b4-00c04fd430c8", ID_PATTERN);
  assert.doesNotMatch("not-an-id", ID_PATTERN);
});

test("sanitizers keep identifiers and numbers, and drop everything else", () => {
  assert.equal(safeModel("jev-latest"), "jev-latest");
  for (const bad of ["a b", "x".repeat(65), "", 5, null]) assert.equal(safeModel(bad), null);
  assert.equal(safeStatus(503), 503);
  for (const bad of [99, 600, 1.5, "503", Number.NaN]) assert.equal(safeStatus(bad), null);
  assert.deepEqual(safeUsage({ input_tokens: 11, output_tokens: 7, secret: "x" }), {
    inputTokens: 11,
    outputTokens: 7,
  });
  assert.deepEqual(safeUsage({ input_tokens: 5 }), { inputTokens: 5, outputTokens: null });
  assert.equal(safeUsage({ input_tokens: -1, output_tokens: Number.NaN }), null);
  assert.deepEqual(safeTiming({ queueMs: 3, inferenceMs: "x" }), { queueMs: 3, inferenceMs: null });
  assert.equal(safeTiming({}), null);
  assert.equal(safeErrorCode(Object.assign(new Error("m"), { code: "EACCES" })), "EACCES");
  for (const bad of [Object.assign(new Error("x"), { code: "ECONNRESET" }), new Error("EACCES"), "EACCES", null]) {
    assert.equal(safeErrorCode(bad), "error");
  }
  const hostile = {
    get code(): string {
      throw new Error("boom");
    },
  };
  assert.equal(safeErrorCode(hostile), "error");
});

test("persistRecord: suppressed, handed off, and failures by code only", () => {
  const calls: unknown[][] = [];
  const record = { a: 1 };
  assert.deepEqual(
    persistRecord((...a) => calls.push(a), OFF, "t", record),
    { outcome: "suppressed" },
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(
    persistRecord((...a) => calls.push(a), ON, "t", record),
    { outcome: "handed-off" },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], "t");
  assert.equal(calls[0]?.[1], record);

  const result = persistRecord(
    () => {
      throw Object.assign(new Error("EACCES: open '/home/x/secret/s.jsonl'"), { code: "EACCES" });
    },
    ON,
    "t",
    record,
  );
  assert.deepEqual(result, { outcome: "failed", code: "EACCES" });
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  const thrown = persistRecord(
    () => {
      throw "just a string";
    },
    ON,
    "t",
    record,
  );
  assert.deepEqual(thrown, { outcome: "failed", code: "error" });
});

test("persistRecord: serialization failure never reaches the host", () => {
  let appended = 0;
  const append = () => {
    appended++;
  };
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.deepEqual(persistRecord(append, ON, "t", { n: 1n }), { outcome: "failed", code: "serialize" });
  assert.deepEqual(persistRecord(append, ON, "t", circular), { outcome: "failed", code: "serialize" });
  assert.equal(appended, 0);
});

test("buildDecisionRecord: one record per outcome", () => {
  const classified = buildDecisionRecord(input());
  assert.equal(classified.v, 3);
  assert.equal(classified.outcome, "classified");
  assert.equal(classified.failure, null);
  assert.equal(classified.tools?.profile, "answer");
  assert.equal(classified.tools?.maxRisk, 0.1);
  assert.deepEqual(
    classified.tools?.risks?.map((r) => r.profile),
    ["answer", "edit"],
  );
  assert.equal(classified.settings.configScope, "default");
  assert.equal(classified.settings.transport, "python");

  // A gate wins even when a decision is present.
  const skipped = buildDecisionRecord(input({ gate: "command" }));
  assert.equal(skipped.outcome, "skipped");
  assert.equal(skipped.skip, "command");
  assert.equal(skipped.failure, null);

  const failed = buildDecisionRecord(input({ decision: null, skills: null }));
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.failure, "error");
  assert.equal(failed.tools, null);
  assert.equal(buildDecisionRecord(input({ decision: null, failure: "timeout" })).failure, "timeout");
});

test("buildDecisionRecord: risks are null without probabilities and null per entry when not finite", () => {
  const config = defaultConfig();
  const none = buildDecisionRecord(
    input({
      decision: { tools: decideTools(config.tools, BASELINE, choice({})), skills: decideSkills(config.skills, [], {}) },
    }),
  );
  assert.equal(none.tools?.risks, null);
  assert.equal(none.tools?.reason, "low-confidence");

  const base = input();
  const nan = buildDecisionRecord({
    ...base,
    decision: {
      ...base.decision!,
      tools: { ...base.decision!.tools, probabilities: { answer: 0.5, full: Number.NaN } },
    },
  });
  assert.equal(nan.tools?.risks?.[0]?.risk, null);
  assert.deepEqual(nan.tools?.probabilities, { answer: 0.5 });
});

test("buildDecisionRecord: unknown keys and names never survive", () => {
  const base = input();
  const record = buildDecisionRecord({
    ...base,
    sessionId: "has spaces and CANARY",
    decision: {
      tools: {
        ...base.decision!.tools,
        profile: "CANARY_PROFILE",
        active: ["read", "CANARY LIST ITEM"],
        probabilities: { answer: 0.9, CANARY_PROB: 0.1, "bad key": 0.2 },
      },
      skills: { selected: ["pdf", "CANARY skill name"], scores: { pdf: 0.9, "CANARY key": 0.3 }, reason: "selected" },
    },
    skills: {
      ...base.skills!,
      decision: { selected: ["pdf", "CANARY skill name"], scores: { pdf: 0.9, "CANARY key": 0.3 }, reason: "selected" },
    },
    classifier: {
      ...evidence(),
      model: "prose that CANARY is not a model id",
      usage: { inputTokens: 3, outputTokens: 4, secret: "CANARY_USAGE" } as never,
      requestId: "CANARY-not-an-id",
    },
  });
  const json = JSON.stringify(record);
  assert.doesNotMatch(json, /CANARY/);
  assert.equal(record.sessionId, null);
  assert.equal(record.tools?.profile, null);
  assert.deepEqual(record.tools?.active, ["read", "(redacted)"]);
  assert.deepEqual(record.skills?.selected, ["pdf", "(redacted)"]);
  assert.deepEqual(record.skills?.scores, { pdf: 0.9 });
  assert.equal(record.classifier?.model, null);
  assert.equal(record.classifier?.requestId, null);
  assert.deepEqual(record.classifier?.usage, { inputTokens: 3, outputTokens: 4 });
});

test("buildDecisionRecord is deterministic", () => {
  const i = input();
  assert.deepEqual(buildDecisionRecord(i), buildDecisionRecord(i));
});

test("settingsSnapshot holds no endpoint, env var, path or rubric", () => {
  const config = defaultConfig();
  config.backend = "laya";
  config.laya.transport = "http";
  config.laya.endpoint = "http://CANARY_ENDPOINT/";
  config.laya.apiKeyEnvVar = "CANARY_LAYA_KEY";
  config.laya.pythonBin = "CANARY_PYTHON";
  config.laya.workerScript = "CANARY_WORKER";
  config.jev.endpoint = "http://CANARY_JEV/";
  config.jev.apiKeyEnvVar = "CANARY_JEV_KEY";
  config.tools.question.instructions = "CANARY_RUBRIC";
  const snapshot = settingsSnapshot(config, "project");
  assert.doesNotMatch(JSON.stringify(snapshot), /CANARY/);
  assert.equal(snapshot.transport, "http");
  assert.equal(snapshot.configScope, "project");
  assert.equal(settingsSnapshot({ ...config, backend: "jev" }, null).transport, null);
});

test("normalizeDecision: a v3 record round-trips", () => {
  const record = buildDecisionRecord(input());
  const view = normalizeDecision(JSON.parse(JSON.stringify(record)));
  assert.ok(view);
  assert.equal(view.version, 3);
  assert.equal(view.eventId, record.eventId);
  assert.equal(view.decisionId, record.decisionId);
  assert.equal(view.sessionId, "sess-1");
  assert.equal(view.outcome, "classified");
  assert.equal(view.backend, "laya");
  assert.equal(view.dryRun, false);
  assert.equal(view.latencyMs, 40);
  assert.deepEqual(view.settings, record.settings);
  assert.deepEqual(view.classifier, record.classifier);
  assert.equal(view.tools?.profile, "answer");
  assert.deepEqual(view.tools?.risks, record.tools?.risks);
  assert.deepEqual(view.ratchet, record.ratchet);
  assert.deepEqual(view.application, record.application);
  assert.equal(view.skills?.delivery, "hint");
});

test("normalizeDecision: a v2 record maps what it has and drops the rest", () => {
  const view = normalizeDecision({
    v: 2,
    failure: null,
    message: "CANARY",
    tools: { active: ["read"], profile: "answer", probabilities: { answer: 0.9 }, risk: 0.1, reason: "selected" },
    skills: { selected: null, scores: {}, reason: "disabled" },
    applied: "answer",
    backend: "jev",
    dryRun: true,
    latencyMs: 12,
  });
  assert.ok(view);
  assert.equal(view.version, 2);
  assert.equal(view.eventId, null);
  assert.equal(view.outcome, "classified");
  assert.equal(view.backend, "jev");
  assert.equal(view.dryRun, true);
  assert.equal(view.latencyMs, 12);
  assert.deepEqual(view.ratchet, { narrowAllowed: null, before: null, after: "answer", admitted: null });
  assert.equal(view.application, null);
  assert.equal(view.settings, null);
  assert.equal(view.tools?.risks, null);
  assert.equal(view.tools?.maxRisk, null);
  assert.equal(view.skills?.discovered, null);
  assert.doesNotMatch(JSON.stringify(view), /CANARY/);

  const failed = normalizeDecision({
    v: 2,
    failure: "timeout",
    tools: null,
    skills: null,
    applied: null,
    backend: "laya",
    dryRun: false,
    latencyMs: 5,
  });
  assert.equal(failed?.outcome, "failed");
  assert.equal(failed?.failure, "timeout");
});

test("normalizeDecision: unknown versions and shapes are null", () => {
  const good = JSON.parse(JSON.stringify(buildDecisionRecord(input())));
  assert.equal(normalizeDecision({ v: 2, tools: null }), null);
  assert.equal(normalizeDecision({ tools: { profile: "full" } }), null);
  assert.equal(normalizeDecision({ ...good, v: 4 }), null);
  assert.equal(normalizeDecision({ ...good, eventId: "nope" }), null);
  assert.equal(normalizeDecision({ ...good, outcome: "weird" }), null);
  for (const junk of [null, "x", 5, [], undefined]) assert.equal(normalizeDecision(junk), null);
});

test("normalizeDecision: a hostile v3 record yields an allowlisted view", () => {
  const good = JSON.parse(JSON.stringify(buildDecisionRecord(input())));
  const view = normalizeDecision({
    ...good,
    extra: "CANARY",
    classifier: {
      ...good.classifier,
      model: "prose CANARY here",
      elapsedMs: Number.NaN,
      usage: { inputTokens: -4, outputTokens: "x" },
      leak: "CANARY",
    },
    tools: {
      ...good.tools,
      active: ["read", "CANARY name"],
      probabilities: { "bad key CANARY": 1, answer: 0.5 },
      risks: [{ profile: "CANARY p", risk: 1 }],
    },
    application: { ...good.application, error: "CANARY message", actualTools: "CANARY" },
  });
  assert.ok(view);
  assert.doesNotMatch(JSON.stringify(view), /CANARY/);
  assert.equal(view.classifier?.model, null);
  assert.equal(view.classifier?.elapsedMs, null);
  assert.equal(view.classifier?.usage, null);
  assert.equal(view.latencyMs, null);
  assert.deepEqual(view.tools?.probabilities, { answer: 0.5 });
  assert.deepEqual(view.tools?.risks, []);
  assert.equal(view.application?.error, "error");
  assert.equal(view.application?.actualTools, null);
});

test("normalizeUsage", () => {
  const base = {
    v: 1,
    eventId: newId(),
    runId: newId(),
    sessionId: "s1",
    decisionId: null,
    turnIndex: 2,
    host: "omp",
    hostEntryId: null,
    stopReason: "stop",
    tokens: { input: 10, output: 5, cacheRead: -1, cacheWrite: null, reasoning: 1.5 },
    costTotal: 0.002,
    toolCalls: { read: 2, "bad key": 1, bash: -1 },
    toolErrors: 0,
    errorStatus: 99,
    retryAttempt: null,
    note: "CANARY",
  };
  const usage = normalizeUsage(base);
  assert.ok(usage);
  assert.deepEqual(usage.tokens, { input: 10, output: 5, cacheRead: null, cacheWrite: null, reasoning: null });
  assert.deepEqual(usage.toolCalls, { read: 2 });
  assert.equal(usage.errorStatus, null);
  assert.equal(usage.toolErrors, 0);
  assert.doesNotMatch(JSON.stringify(usage), /CANARY/);
  assert.equal(normalizeUsage({ ...base, stopReason: "weird" })?.stopReason, "other");
  assert.equal(normalizeUsage({ ...base, stopReason: undefined })?.stopReason, null);
  assert.equal(normalizeUsage({ ...base, host: "vscode" }), null);
  assert.equal(normalizeUsage({ ...base, eventId: "x" }), null);
  assert.equal(normalizeUsage({ ...base, runId: "x" }), null);
  assert.equal(normalizeUsage({ ...base, v: 2 }), null);
});

test("normalizeHttp", () => {
  const requestId = newId();
  const base = {
    type: "loadout.http",
    v: 1,
    requestId,
    idStatus: "valid",
    at: "2026-10-16T12:00:00.123Z",
    outcome: "ok",
    status: 200,
    queueMs: 1,
    inferenceMs: 2,
    totalMs: 4,
    errorClass: null,
  };
  const ok = normalizeHttp(base);
  assert.equal(ok?.idStatus, "valid");
  assert.equal(ok?.requestId, requestId);
  // idStatus is derived from the id, never trusted.
  assert.equal(normalizeHttp({ ...base, requestId: null })?.idStatus, "invalid");
  assert.equal(normalizeHttp({ ...base, requestId: null, idStatus: "absent" })?.idStatus, "absent");
  assert.equal(normalizeHttp({ ...base, requestId: "garbage", idStatus: "garbage" })?.idStatus, "invalid");
  assert.equal(normalizeHttp({ ...base, at: "yesterday" }), null);
  assert.equal(normalizeHttp({ ...base, outcome: "weird" }), null);
  assert.equal(normalizeHttp({ ...base, type: "other" }), null);
  assert.equal(normalizeHttp({ ...base, status: 99 })?.status, null);
  assert.equal(normalizeHttp({ ...base, errorClass: "has space" })?.errorClass, null);
  assert.equal(normalizeHttp({ ...base, errorClass: "BrokenPipe" })?.errorClass, "BrokenPipe");
});

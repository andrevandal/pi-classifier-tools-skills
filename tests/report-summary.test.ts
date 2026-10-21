import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { readSessions } from "../src/report/read.ts";
import { NO_FILTERS } from "../src/report/scope.ts";
import {
  cacheRate,
  DISCLOSURES,
  percentile,
  promptTokensPerRequest,
  type Stats,
  statsOf,
  sumOf,
  type Summary,
  summarize,
  tally,
  transcriptTotals,
} from "../src/report/summary.ts";
import { renderSummary } from "../src/report/text.ts";
import { DECISION_ENTRY, USAGE_ENTRY } from "../src/telemetry.ts";
import {
  application,
  assistantMessage,
  chain,
  classifier,
  custom,
  decisionV3,
  header,
  httpRecord,
  INVENTED_TOOL_NAMES,
  R1,
  ratchet,
  reportInput,
  serviceLog,
  settings,
  tmp,
  toolCallTurn,
  tools,
  usageV1,
  uuid,
  writeBranches,
  writeMixed,
  writeSession,
  writeUsageHistory,
} from "./fixtures/report.ts";

const EPS = 1e-9;

function close(actual: number | null, expected: number, label: string): void {
  assert.ok(actual !== null && Math.abs(actual - expected) < EPS, `${label}: ${actual} is not ${expected}`);
}

/** Every field exactly, the mean within an epsilon. */
function checkStats(actual: Stats, expected: Stats, label: string): void {
  const { mean, ...rest } = actual;
  const { mean: expectedMean, ...expectedRest } = expected;
  assert.deepEqual(rest, expectedRest, label);
  if (expectedMean === null) assert.equal(mean, null, label);
  else close(mean, expectedMean, label);
}

const one = (value: number): Stats => ({ n: 1, mean: value, p10: value, p50: value, p90: value, max: value });
const EMPTY_STATS: Stats = { n: 0, mean: null, p10: null, p50: null, p90: null, max: null };

function finiteEverywhere(value: unknown, where = "summary"): void {
  if (typeof value === "number") assert.ok(Number.isFinite(value), `${where} is not finite`);
  else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) finiteEverywhere(item, `${where}[${i}]`);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) finiteEverywhere(item, `${where}.${key}`);
  }
}

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]);
}

function allNumbers(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(allNumbers);
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(allNumbers);
}

function mixed() {
  return writeMixed(tmp()).file;
}

test("summary: percentiles are nearest-rank and empty input stays null", () => {
  checkStats(statsOf([4, 4, 4, 4, 6, 6]), { n: 6, mean: 28 / 6, p10: 4, p50: 4, p90: 6, max: 6 }, "stats");
  assert.deepEqual(statsOf([]), EMPTY_STATS);
  assert.ok(Number.isNaN(percentile([], 50)), "the old contract: bench relies on NaN");
  assert.equal(percentile([1, 2, 3, 4], 2.5), 1);
  assert.equal(percentile([1, 2, 3, 4], 97.5), 4);
  assert.equal(percentile([9, 1, 5], 50), 5, "unsorted input");
  assert.deepEqual(sumOf([1, null, 2]), { sum: 3, known: 2, unknown: 1 });
  assert.deepEqual(sumOf([]), { sum: 0, known: 0, unknown: 0 });
  assert.deepEqual(Object.keys(tally(["b", "a", "b", "c", "a", "b"])), ["b", "a", "c"], "count desc, then key");
  assert.deepEqual(Object.keys(tally(["y", "x"])), ["x", "y"]);
  const big = Array.from({ length: 300_000 }, (_, i) => i);
  assert.equal(statsOf(big).max, 299_999, "a long list does not overflow the argument stack");
});

test("summary: mixed v2 and v3 history keeps counts, unknowns and coverage", () => {
  const s = summarize(reportInput([mixed()]));
  finiteEverywhere(s);
  assert.equal(s.schema, "loadout-report.summary/1");

  const d = s.decisions;
  assert.equal(d.total, 10);
  assert.deepEqual(d.outcomes, { classified: 7, failed: 2, skipped: 1 });
  assert.deepEqual(d.versions, { v2: 2, v3: 8 });
  assert.deepEqual(d.skips, { command: 1 });
  assert.deepEqual(d.branch, { active: 10, abandoned: 0, unknown: 0 });
  assert.equal(d.sessions, 1);
  assert.deepEqual(d.dryRun, { yes: 1, no: 8, unknown: 0 });
  assert.deepEqual(d.failures, { timeout: 2 });
  checkStats(d.latencyMs, { n: 9, mean: 900, p10: 50, p50: 90, p90: 4300, max: 4300 }, "latency");

  const p = d.proposals;
  assert.deepEqual([p.tools, p.none, p.narrowing, p.keepBaseline], [7, 2, 6, 1]);
  assert.deepEqual(p.profiles, { answer: 4, edit: 2, full: 1, "(none)": 2 });
  assert.deepEqual(p.reasons, { selected: 6, "low-confidence": 1, failed: 2 });
  checkStats(p.proposedTools, { n: 6, mean: 28 / 6, p10: 4, p50: 4, p90: 6, max: 6 }, "proposedTools");
  checkStats(p.risk, { n: 6, mean: 0.04, p10: 0.02, p50: 0.05, p90: 0.05, max: 0.05 }, "risk");

  assert.deepEqual(d.application.statuses, {
    applied: 2,
    unchanged: 1,
    "dry-run": 1,
    "not-admitted": 1,
    failed: 1,
    "not-attempted": 1,
    unknown: 2,
  });
  checkStats(d.application.actualTools, { n: 7, mean: 43 / 7, p10: 4, p50: 7, p90: 7, max: 7 }, "actualTools");
  assert.deepEqual(d.selection, {
    narrow: { applied: 2, "dry-run": 1, "not-admitted": 1, failed: 1, unknown: 1 },
    "keep-baseline": { unchanged: 1 },
    none: { "not-attempted": 1, unknown: 1 },
  });
  assert.deepEqual(d.ratchet, { blocked: 1, admitted: 5, unknown: 3 });
  assert.deepEqual(d.skills.reasons, { disabled: 6, "too-many-candidates": 1, failed: 2 });
  assert.deepEqual(d.skills.selected, {});
  assert.equal(d.skills.candidateLimit, 1);
  assert.deepEqual(d.skills.delivery, { none: 7, unknown: 2 });
  assert.deepEqual(d.blockers, {
    "classifier-failed": 2,
    "low-confidence": 1,
    "ratchet-refused": 1,
    "candidate-limit": 1,
    "application-failed": 1,
  });

  const c = s.classifier;
  assert.deepEqual([c.attempts, c.evidence], [9, 7]);
  assert.deepEqual(c.guardFired, { yes: 1, no: 6, unknown: 2 });
  assert.deepEqual(c.tokens.input, { sum: 41, known: 1, unknown: 8 });
  assert.deepEqual(c.tokens.output, { sum: 3, known: 1, unknown: 8 });
  assert.equal(c.server.reported, 1);
  assert.equal(c.server.unreported, 8);
  checkStats(c.server.queueMs, one(5), "queueMs");
  checkStats(c.server.inferenceMs, one(40), "inferenceMs");
  assert.deepEqual(c.models, { "model-a": 7, unknown: 2 });
  assert.deepEqual(c.requestIds, { present: 2, absent: 7 });
  assert.deepEqual(c.promptClipped, { yes: 0, no: 7, unknown: 2 });

  assert.deepEqual(
    s.leads.map((lead) => [lead.id, lead.count, lead.of]),
    [
      ["classifier-failed", 2, 9],
      ["application-failed", 1, 7],
      ["candidate-limit", 1, 8],
      ["low-confidence", 1, 7],
      ["ratchet-refused", 1, 5],
    ],
  );
  const lead = (id: string) => s.leads.find((candidate) => candidate.id === id)?.evidence;
  assert.deepEqual(lead("classifier-failed"), { failures: { timeout: 2 }, guardFired: 1, serverEvidence: null });
  assert.deepEqual(lead("application-failed"), { errors: { EIO: 1 }, restoration: { restored: 1 } });
  const candidate = lead("candidate-limit");
  checkStats(candidate?.eligible as Stats, one(50), "eligible");
  assert.deepEqual(candidate?.maxCandidates, [40]);
  const lowConfidence = lead("low-confidence");
  checkStats(lowConfidence?.closestNarrowerRisk as Stats, one(0.27), "closestNarrowerRisk");
  assert.equal(lowConfidence?.riskUnknown, 0);
  assert.deepEqual(lowConfidence?.maxRisk, [0.1]);
  assert.deepEqual(lead("ratchet-refused"), { dryRun: 0 });

  assert.deepEqual(s.coverage.files, { read: 1, unreadable: 0, withoutHeader: 0, skippedByMtime: 0 });
  assert.equal(s.coverage.malformedLines, 0);
  assert.deepEqual(s.coverage.duplicatesRemoved, { decisions: 0, usage: 0 });
  assert.deepEqual(s.coverage.unidentifiable, { decisions: 2 });
  assert.deepEqual(s.coverage.unsupported, { decisions: 0, usage: 0 });
  assert.deepEqual(s.coverage.provenance, { origin: 8, inherited: 0, unknown: 0 });
  const nothing = { outsideRange: 0, unplaced: 0, branch: 0, outcome: 0 };
  assert.deepEqual(s.coverage.removedByFilters, { decisions: nothing, usage: nothing, transcript: nothing });
  assert.equal(s.usage.turns, 0);
  assert.equal(s.transcript.turns, 0);
  assert.equal(s.http, null);
  assert.deepEqual(s.scope, {
    kind: "session",
    files: 1,
    nestedChildFiles: 0,
    childFilesNotRead: 0,
    childDirsUnreadable: 0,
    since: null,
    until: null,
    projects: null,
  });
  assert.deepEqual(s.filters, { branch: "all", outcome: { decision: null, usage: null } });
  assert.deepEqual(s.disclosures, DISCLOSURES);
  assert.doesNotMatch(JSON.stringify(s), /CANARY/);
});

test("summary: a proposal is never reported as an applied change or a saving", () => {
  const s = summarize(reportInput([mixed()]));
  assert.equal(s.decisions.proposals.narrowing, 6);
  assert.equal(s.decisions.application.statuses.applied, 2, "6 proposed a narrowing, 2 were applied");
  const narrow = s.decisions.selection.narrow;
  assert.deepEqual(
    [narrow["dry-run"], narrow["not-admitted"], narrow.failed, narrow.unknown],
    [1, 1, 1, 1],
    "the dry-run, refused and failed proposals keep their own status",
  );
  assert.equal(
    Object.values(narrow).reduce((sum, n) => sum + n, 0),
    s.decisions.proposals.narrowing,
    "every proposal is accounted for",
  );
  assert.deepEqual(
    keysOf(JSON.parse(JSON.stringify(s))).filter((key) => /sav/i.test(key)),
    [],
  );
});

test("summary: retries, errors, interruptions and copies count each turn once", () => {
  const { file, fork } = writeUsageHistory(tmp());
  const check = (s: Summary): void => {
    finiteEverywhere(s);
    const u = s.usage;
    assert.deepEqual([u.turns, u.runs], [5, 2]);
    assert.deepEqual(u.hosts, { omp: 5 });
    assert.deepEqual(u.outcomes, { stop: 2, toolUse: 1, error: 1, aborted: 1, length: 0, other: 0, unknown: 0 });
    assert.deepEqual(u.branch, { active: 5, abandoned: 0, unknown: 0 });
    assert.deepEqual(u.tokens.input, { sum: 65, known: 4, unknown: 1 });
    assert.deepEqual(u.tokens.output, { sum: 23, known: 4, unknown: 1 });
    assert.deepEqual(u.tokens.cacheRead, { sum: 320, known: 4, unknown: 1 });
    assert.deepEqual(u.tokens.cacheWrite, { sum: 10, known: 4, unknown: 1 });
    assert.deepEqual(u.tokens.reasoning, { sum: 3, known: 1, unknown: 4 });
    assert.deepEqual([u.cost.known, u.cost.unknown], [3, 2]);
    close(u.cost.sum, 0.006, "cost");
    assert.deepEqual(u.toolCalls, { total: 4, byTool: { read: 2, bash: 1, edit: 1 } });
    assert.deepEqual(u.toolErrors, { sum: 1, known: 3, unknown: 2 });
    assert.deepEqual(u.errorStatus, { "529": 1 });
    assert.deepEqual(u.retries, { reported: 2, unreported: 3, maxAttempt: 2, byAttempt: { "1": 1, "2": 1 } });
    assert.deepEqual(u.assignment, { assigned: 2, unassigned: 3 });
  };

  const alone = summarize(reportInput([file]));
  check(alone);
  assert.deepEqual(alone.coverage.duplicatesRemoved, { decisions: 0, usage: 0 });
  assert.deepEqual(alone.coverage.provenance, { origin: 5, inherited: 0, unknown: 0 });

  const copied = summarize(reportInput([file, fork]));
  check(copied);
  assert.equal(copied.coverage.duplicatesRemoved.usage, 5);

  const forkOnly = summarize(reportInput([fork]));
  check(forkOnly);
  assert.deepEqual(forkOnly.coverage.provenance, { origin: 0, inherited: 5, unknown: 0 });
  assert.deepEqual(forkOnly.coverage.duplicatesRemoved, { decisions: 0, usage: 0 });
});

test("summary: usage records and transcript turns are separate sources", () => {
  const dir = tmp();
  const lines = (id: string) => [
    header({ id, cwd: "/p/one" }),
    ...chain([
      assistantMessage({ usage: { input: 7, output: 1, cacheRead: 0, cacheWrite: 0 } }),
      custom(
        USAGE_ENTRY,
        usageV1({
          eventId: uuid(501),
          tokens: { input: 100, output: 2, cacheRead: null, cacheWrite: null, reasoning: null },
        }),
      ),
      assistantMessage({ usage: { input: 9, output: 1, cacheRead: 0, cacheWrite: 0 } }),
      custom(
        USAGE_ENTRY,
        usageV1({
          eventId: uuid(502),
          tokens: { input: 200, output: 2, cacheRead: null, cacheWrite: null, reasoning: null },
        }),
      ),
    ]),
  ];
  const file = writeSession(path.join(dir, "a.jsonl"), lines("sess-U"));
  const copy = writeSession(path.join(dir, "b.jsonl"), lines("sess-copy"));

  const s = summarize(reportInput([file]));
  assert.deepEqual([s.usage.turns, s.transcript.turns], [2, 2]);
  assert.equal(s.usage.tokens.input.sum, 300);
  assert.equal(s.transcript.tokens.input.sum, 16);
  assert.equal(allNumbers(s).includes(316), false, "no field adds the two sources (300 + 16)");

  const both = summarize(reportInput([file, copy]));
  assert.equal(both.usage.turns, 2, "usage records deduplicate by event id");
  assert.equal(both.transcript.turns, 4, "host messages have no identity to deduplicate on");
  assert.equal(both.transcript.deduplicated, false);
  assert.equal(both.transcript.tokens.input.sum, 32);
});

test("summary: a transcript tool name is printed only when the plugin's own records vouch for it", () => {
  const dir = tmp();
  const file = writeSession(path.join(dir, "v.jsonl"), [
    header({ id: "sess-V", cwd: "/p/one" }),
    ...chain([
      toolCallTurn("read", "bash", ...INVENTED_TOOL_NAMES),
      toolCallTurn("read", "edit", "CANARY_TOOL_N7"),
      toolCallTurn("write", "CANARY tool name"),
      custom(USAGE_ENTRY, usageV1({ eventId: uuid(601), toolCalls: { read: 2, edit: 1 } })),
      custom(
        DECISION_ENTRY,
        decisionV3({
          eventId: uuid(61),
          decisionId: uuid(261),
          application: application({ actualTools: ["read", "bash"] }),
        }),
      ),
    ]),
  ]);
  const bare = writeSession(path.join(dir, "bare.jsonl"), [header({ id: "sess-B" }), ...chain([toolCallTurn("read")])]);

  // `read` and `edit` are vouched by a usage record, `bash` by a decision's actual tools. Every other name,
  // whatever it looks like, is the model's own text: it counts, under one label, and is never printed.
  const summary = summarize(reportInput([file]));
  assert.deepEqual(summary.transcript.toolCalls, {
    total: 11,
    byTool: { read: 2, bash: 1, edit: 1, "(redacted)": 7 },
  });
  assert.deepEqual(summary.usage.toolCalls, { total: 3, byTool: { read: 2, edit: 1 } });
  for (const name of [...INVENTED_TOOL_NAMES, "CANARY tool name"]) {
    assert.equal(JSON.stringify(summary).includes(name), false, name);
  }

  // A session with no plugin record vouches for nothing: the counts stay, the names go.
  assert.deepEqual(summarize(reportInput([bare])).transcript.toolCalls, { total: 1, byTool: { "(redacted)": 1 } });

  // A caller that passes no set (the benchmark) gets the reader's names.
  const read = readSessions([file]);
  assert.equal(transcriptTotals(read.turns, read.toolResults).toolCalls.byTool.CANARY_TOOL_N7, 2);
  assert.deepEqual(transcriptTotals(read.turns, read.toolResults, false, new Set(["read"])).toolCalls.byTool, {
    read: 2,
    "(redacted)": 9,
  });
});

test("summary: abandoned branches count by default and filter on demand", () => {
  const { file } = writeBranches(tmp());
  const all = summarize(reportInput([file]));
  assert.equal(all.usage.turns, 2);
  assert.deepEqual(all.usage.branch, { active: 1, abandoned: 1, unknown: 0 });
  assert.equal(all.transcript.turns, 2);
  assert.deepEqual(all.transcript.branch, { active: 1, abandoned: 1, unknown: 0 });
  assert.equal(all.transcript.tokens.input.sum, 30);

  const active = summarize(reportInput([file], { filters: { ...NO_FILTERS, branch: "active" } }));
  assert.equal(active.usage.turns, 1);
  assert.equal(active.transcript.turns, 1);
  assert.equal(active.transcript.tokens.input.sum, 20);
  assert.equal(active.coverage.removedByFilters.usage.branch, 1);
  assert.equal(active.coverage.removedByFilters.transcript.branch, 1);
  assert.deepEqual(active.filters, { branch: "active", outcome: { decision: null, usage: null } });
});

/** Fixture J: an attempt that carries a request id but never sent it to a server (not the HTTP transport). */
function writeJ(dir: string): string {
  return writeSession(path.join(dir, "j.jsonl"), [
    header({ id: "sess-J", cwd: "/p/one" }),
    ...chain([
      custom(
        DECISION_ENTRY,
        decisionV3({
          eventId: uuid(11),
          sessionId: "sess-J",
          decisionId: uuid(211),
          settings: settings({ backend: "jev", transport: null }),
          classifier: classifier({ requestId: uuid(300) }),
        }),
      ),
    ]),
  ]);
}

function buckets(s: Summary): number {
  const u = s.http?.unmatched;
  return (s.http?.joined ?? 0) + (u?.clientWithoutRecord ?? 0) + (u?.ambiguous ?? 0) + (u?.notJoinable ?? 0);
}

test("summary: service evidence joins by request id and stays unknown without it", () => {
  const dir = tmp();
  const file = mixed();
  const h1 = serviceLog(path.join(dir, "h1.log"));
  const h2 = serviceLog(path.join(dir, "h2.log"), { withoutR2: true });

  const s = summarize(reportInput([file], { serviceLogs: [h1] }));
  finiteEverywhere(s);
  const http = s.http;
  assert.ok(http !== null);
  assert.deepEqual(http.lines, { total: 9, records: 4, unsupported: 1, other: 4 });
  assert.equal(http.records, 3);
  assert.equal(http.duplicates, 1);
  assert.equal(http.conflicts, 0);
  assert.equal(http.joined, 2);
  assert.deepEqual(http.unmatched, {
    clientWithoutRecord: 0,
    notJoinable: 0,
    ambiguous: 0,
    recordsNotInScope: 1,
    recordsWithoutRequestId: 0,
  });
  assert.deepEqual(http.outcomes, { ok: 1, "client-gone": 1 });
  checkStats(http.phases.queueMs, { n: 2, mean: 1452.5, p10: 5, p50: 5, p90: 2900, max: 2900 }, "queue");
  checkStats(http.phases.inferenceMs, { n: 2, mean: 170, p10: 40, p50: 40, p90: 300, max: 300 }, "inference");
  checkStats(http.phases.totalMs, { n: 2, mean: 1648.5, p10: 47, p50: 47, p90: 3250, max: 3250 }, "total");
  assert.equal(http.timeouts.clientTimeouts, 1, "the v2 timeout has no request id and cannot join");
  assert.equal(http.timeouts.joined, 1);
  assert.deepEqual(http.timeouts.outcomes, { "client-gone": 1 });
  checkStats(http.timeouts.queueMs, one(2900), "timeout queue");
  checkStats(http.timeouts.inferenceMs, one(300), "timeout inference");
  assert.equal(buckets(s), s.classifier.requestIds.present);
  const failed = s.leads.find((lead) => lead.id === "classifier-failed");
  assert.deepEqual(failed?.evidence.serverEvidence, { joined: 1, outcomes: { "client-gone": 1 } });
  assert.deepEqual(Object.keys(http.timeouts).sort(), [
    "clientTimeouts",
    "inferenceMs",
    "joined",
    "outcomes",
    "queueMs",
  ]);

  const missing = summarize(reportInput([file], { serviceLogs: [h2] })).http;
  assert.equal(missing?.joined, 1);
  assert.equal(missing?.unmatched.clientWithoutRecord, 1, "no record is unknown, not 'no server work'");

  assert.equal(summarize(reportInput([file])).http, null);

  const withJ = summarize(reportInput([file, writeJ(dir)], { serviceLogs: [h1] }));
  assert.equal(withJ.http?.unmatched.notJoinable, 1);
  assert.equal(withJ.http?.unmatched.clientWithoutRecord, 0);
  assert.equal(withJ.http?.joined, 2);
  assert.equal(withJ.http?.unmatched.recordsNotInScope, 1);
  assert.equal(buckets(withJ), withJ.classifier.requestIds.present);
  assert.equal(withJ.classifier.requestIds.present, 3);
});

test("summary: a service record without a request id is counted only as such", () => {
  const dir = tmp();
  const log = path.join(dir, "n.log");
  fs.writeFileSync(
    log,
    `${[
      JSON.stringify(httpRecord({ requestId: null, idStatus: "absent" })),
      JSON.stringify(httpRecord({ requestId: R1, queueMs: 5 })),
    ].join("\n")}\n`,
  );
  const http = summarize(reportInput([mixed()], { serviceLogs: [log] })).http;
  assert.equal(http?.unmatched.recordsWithoutRequestId, 1);
  assert.equal(http?.unmatched.recordsNotInScope, 0, "a record that names nothing is not known to be out of scope");
  assert.equal(http?.joined, 1);
});

test("summary: conflicting service records for one request id join nothing", () => {
  const dir = tmp();
  const log = path.join(dir, "c.log");
  fs.writeFileSync(
    log,
    `${[
      JSON.stringify(httpRecord({ requestId: R1, queueMs: 5, inferenceMs: 40, totalMs: 47 })),
      JSON.stringify(httpRecord({ requestId: R1, outcome: "rejected", status: 401, totalMs: 1 })),
    ].join("\n")}\n`,
  );
  const s = summarize(reportInput([mixed()], { serviceLogs: [log] }));
  const http = s.http;
  assert.equal(http?.lines.records, 2);
  assert.equal(http?.records, 2);
  assert.equal(http?.duplicates, 0);
  assert.equal(http?.conflicts, 1);
  assert.equal(http?.joined, 0);
  assert.equal(http?.unmatched.ambiguous, 1, "the R1 attempt");
  assert.equal(http?.unmatched.clientWithoutRecord, 1, "the R2 attempt has no record");
  assert.equal(http?.unmatched.recordsNotInScope, 0);
  assert.deepEqual(http?.outcomes, {});
  assert.equal(buckets(s), s.classifier.requestIds.present);
});

test("summary: leads are descriptive and appear only with evidence", () => {
  const s = summarize(reportInput([mixed()]));
  assert.deepEqual(
    s.leads.map((lead) => lead.id),
    ["classifier-failed", "application-failed", "candidate-limit", "low-confidence", "ratchet-refused"],
  );
  assert.ok(s.leads.every((lead) => Object.keys(lead).sort().join() === "count,evidence,id,of"));

  const quiet = writeSession(path.join(tmp(), "quiet.jsonl"), [
    header({ id: "sess-M" }),
    ...chain([
      custom(DECISION_ENTRY, decisionV3({ eventId: uuid(1) })),
      custom(DECISION_ENTRY, decisionV3({ eventId: uuid(2) })),
    ]),
  ]);
  const none = summarize(reportInput([quiet]));
  assert.deepEqual(none.leads, []);
  assert.deepEqual(none.decisions.blockers, {
    "classifier-failed": 0,
    "low-confidence": 0,
    "ratchet-refused": 0,
    "candidate-limit": 0,
    "application-failed": 0,
  });
});

test("summary: the ratchet-refused lead counts live and dry-run refusals, and reports the dry-run share", () => {
  const refused = ratchet({ narrowAllowed: false, before: "full", after: "full", admitted: false });
  const file = writeSession(path.join(tmp(), "ratchet.jsonl"), [
    header({ id: "sess-M" }),
    ...chain([
      custom(
        DECISION_ENTRY,
        decisionV3({ eventId: uuid(1), ratchet: refused, application: application({ status: "not-admitted" }) }),
      ),
      custom(
        DECISION_ENTRY,
        decisionV3({
          eventId: uuid(2),
          settings: settings({ dryRun: true }),
          ratchet: refused,
          application: application({ status: "dry-run" }),
        }),
      ),
      custom(
        DECISION_ENTRY,
        decisionV3({
          eventId: uuid(3),
          settings: settings({ dryRun: true }),
          application: application({ status: "dry-run" }),
        }),
      ),
      custom(
        DECISION_ENTRY,
        decisionV3({
          eventId: uuid(4),
          tools: tools({ active: null }),
          ratchet: refused,
          application: application({ status: "unchanged" }),
        }),
      ),
    ]),
  ]);
  const s = summarize(reportInput([file]));
  const lead = s.leads.find((candidate) => candidate.id === "ratchet-refused");
  assert.equal(lead?.count, 2, "the live and the dry-run refusal");
  assert.equal(lead?.of, 3, "narrowing proposals only; the keep-baseline record is outside the population");
  assert.deepEqual(lead?.evidence, { dryRun: 1 });
  assert.equal(s.decisions.blockers["ratchet-refused"], 2);
  assert.equal(
    s.decisions.ratchet.blocked,
    3,
    "the keep-baseline record's refused ratchet is counted here, not in the lead",
  );
  assert.match(renderSummary(s), /ratchet-refused: 2 of 3 \| dry run: 1/);

  const live = writeSession(path.join(tmp(), "live.jsonl"), [
    header({ id: "sess-M" }),
    ...chain([
      custom(
        DECISION_ENTRY,
        decisionV3({ eventId: uuid(1), ratchet: refused, application: application({ status: "not-admitted" }) }),
      ),
    ]),
  ]);
  const liveSummary = summarize(reportInput([live]));
  assert.deepEqual(liveSummary.leads.find((candidate) => candidate.id === "ratchet-refused")?.evidence, { dryRun: 0 });
  assert.doesNotMatch(renderSummary(liveSummary), /dry run:/);
});

test("summary: empty input is zero counts and null statistics", () => {
  const s = summarize(reportInput([]));
  finiteEverywhere(s);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s, "no NaN, Infinity or undefined survives");
  assert.equal(s.decisions.total, 0);
  assert.deepEqual(s.decisions.outcomes, { classified: 0, failed: 0, skipped: 0 });
  assert.deepEqual(s.decisions.latencyMs, EMPTY_STATS);
  assert.deepEqual(s.decisions.proposals.risk, EMPTY_STATS);
  assert.deepEqual(s.decisions.proposals.proposedTools, EMPTY_STATS);
  assert.deepEqual(s.decisions.application.actualTools, EMPTY_STATS);
  assert.deepEqual(s.classifier.tokens.input, { sum: 0, known: 0, unknown: 0 });
  assert.deepEqual(s.classifier.server.queueMs, EMPTY_STATS);
  assert.deepEqual(s.usage.tokens.input, { sum: 0, known: 0, unknown: 0 });
  assert.deepEqual(s.usage.cost, { sum: 0, known: 0, unknown: 0 });
  assert.equal(s.usage.retries.maxAttempt, null);
  assert.equal(s.usage.turns, 0);
  assert.equal(s.transcript.turns, 0);
  assert.equal(s.http, null);
  assert.deepEqual(s.leads, []);
  assert.deepEqual(s.coverage.files, { read: 0, unreadable: 0, withoutHeader: 0, skippedByMtime: 0 });
});

test("summary: classifier evidence keeps null apart from zero", () => {
  const attempt = (n: number, over: Parameters<typeof classifier>[0]) =>
    custom(DECISION_ENTRY, decisionV3({ eventId: uuid(n), classifier: classifier(over) }));
  const damaged = custom(DECISION_ENTRY, {
    ...decisionV3({ eventId: uuid(5) }),
    classifier: { ...classifier(), promptChars: null },
  });
  const file = writeSession(path.join(tmp(), "c.jsonl"), [
    header({ id: "sess-M" }),
    ...chain([
      attempt(1, { usage: null }),
      attempt(2, { usage: { inputTokens: 41, outputTokens: null } }),
      attempt(3, { promptChars: 30, sentChars: 20 }),
      attempt(4, { promptChars: 20, sentChars: 20 }),
      damaged,
    ]),
  ]);
  const c = summarize(reportInput([file])).classifier;
  assert.deepEqual(c.tokens.input, { sum: 41, known: 1, unknown: 4 });
  assert.deepEqual(c.tokens.output, { sum: 0, known: 0, unknown: 5 }, "a missing count is unknown, never zero");
  assert.deepEqual(c.promptClipped, { yes: 1, no: 3, unknown: 1 });
});

test("summary: transcript totals reproduce the benchmark numbers", () => {
  const file = path.join(tmp(), "s.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", cwd: "/x" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          stopReason: "error",
          content: [{ type: "toolCall", name: "bash" }],
          usage: { input: 100, output: 10, cacheRead: 300, cacheWrite: 5, cost: { total: 0.01 } },
        },
      }),
      JSON.stringify({ type: "message", message: { role: "toolResult", isError: true } }),
      "{ truncated",
    ].join("\n"),
  );
  const read = readSessions([file]);
  const totals = transcriptTotals(read.turns, read.toolResults);
  assert.deepEqual(
    [totals.turns, totals.outcomes.error, totals.tokens.input.sum, totals.tokens.cacheRead.sum, totals.toolErrors],
    [1, 1, 100, 300, 1],
  );
  assert.equal(totals.toolResults, 1);
  assert.deepEqual(totals.toolCalls, { total: 1, byTool: { bash: 1 } });
  close(totals.cost.sum, 0.01, "cost");
  assert.equal(cacheRate(totals.tokens), 300 / 405);
  assert.equal(promptTokensPerRequest(totals), 405);

  const filtered = transcriptTotals(read.turns, read.toolResults, true);
  assert.equal(filtered.toolResults, null);
  assert.equal(filtered.toolErrors, null);
  assert.equal(filtered.turns, 1);

  const empty = transcriptTotals([], []);
  assert.equal(cacheRate(empty.tokens), 0);
  assert.equal(promptTokensPerRequest(empty), 0);
});

test("summary: astronomically large values never reach the output as Infinity", () => {
  const huge = 1e308;
  const decision = (n: number) =>
    custom(
      DECISION_ENTRY,
      decisionV3({ eventId: uuid(n), classifier: classifier({ server: { queueMs: huge, inferenceMs: 1 } }) }),
    );
  const file = writeSession(path.join(tmp(), "huge.jsonl"), [
    header({ id: "sess-M" }),
    ...chain([
      assistantMessage({ usage: { input: huge, output: 7, cacheRead: 0, cacheWrite: 0, cost: { total: huge } } }),
      assistantMessage({ usage: { input: huge, output: 7, cacheRead: 0, cacheWrite: 0, cost: { total: huge } } }),
      custom(USAGE_ENTRY, usageV1({ eventId: uuid(501), costTotal: huge })),
      custom(USAGE_ENTRY, usageV1({ eventId: uuid(502), costTotal: huge })),
      decision(1),
      decision(2),
    ]),
  ]);

  const s = summarize(reportInput([file]));
  finiteEverywhere(s);
  assert.deepEqual(s.transcript.tokens.input, { sum: 0, known: 0, unknown: 2 }, "not a safe integer: unknown");
  assert.deepEqual(s.transcript.tokens.output, { sum: 14, known: 2, unknown: 0 });
  assert.deepEqual(s.transcript.cost, { sum: huge, known: 1, unknown: 1 }, "the second cannot be added: it overflows");
  assert.deepEqual(s.usage.cost, { sum: huge, known: 1, unknown: 1 });
  assert.equal(s.classifier.server.queueMs.mean, huge, "the mean of two huge values does not overflow");

  assert.deepEqual(sumOf([huge, huge]), { sum: huge, known: 1, unknown: 1 });
  assert.deepEqual(statsOf([huge, huge]), { n: 2, mean: huge, p10: huge, p50: huge, p90: huge, max: huge });
});

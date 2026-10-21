/**
 * Synthetic session, record and service-log builders for the report tests.
 * Everything here is invented data: no real transcript text. Tests import this
 * module; it never imports `node:test`, so a smoke script can use it too.
 *
 * `tmp()` registers the directories it creates and removes them when the
 * process exits. The `write*` builders write under a path the caller passes in
 * and never register it, so a smoke script's tree survives the script.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readServiceLogs, readSessions } from "../../src/report/read.ts";
import { applyFilters, type FilterSpec, NO_FILTERS, type ScopeSpec, selectFiles } from "../../src/report/scope.ts";
import type { ReportInput } from "../../src/report/summary.ts";
import {
  type ApplicationRecord,
  type ClassifierEvidence,
  DECISION_ENTRY,
  type DecisionRecordV3,
  type HttpServerRecordV1,
  type RatchetRecord,
  type SafeSettings,
  type SkillsRecord,
  type ToolsRecord,
  USAGE_ENTRY,
  type UsageObservationV1,
} from "../../src/telemetry.ts";

export const T0 = "2026-10-10T00:00:00.000Z";

/** A uuid that matches `ID_PATTERN`. */
export const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** The request ids of fixture M's two attempts that carry one. */
export const R1 = uuid(101);
export const R2 = uuid(102);

const created: string[] = [];
process.on("exit", () => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a test that left a directory unreadable must not fail the exit.
    }
  }
});

export function tmp(prefix = "loadout-report-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function header(over: { id?: string | null; cwd?: string; timestamp?: string } = {}): Record<string, unknown> {
  const { id = "sess-H", cwd = "/p/one", timestamp = T0 } = over;
  return { type: "session", version: 3, ...(id === null ? {} : { id }), timestamp, cwd };
}

/** OMP may write a title slot (no id) before the header. */
export function titleSlot(title = "synthetic title"): Record<string, unknown> {
  return { type: "title", title, timestamp: T0 };
}

export const settings = (over: Partial<SafeSettings> = {}): SafeSettings => ({
  enabled: true,
  backend: "laya",
  transport: "http",
  dryRun: false,
  notify: true,
  maxPromptChars: 8000,
  configScope: "global",
  tools: { enabled: true, maxRisk: 0.1 },
  skills: { enabled: false, mode: "auto", threshold: 0.5, maxSkills: 5, maxCandidates: 40 },
  ...over,
});

export const classifier = (over: Partial<ClassifierEvidence> = {}): ClassifierEvidence => ({
  requestId: null,
  model: "model-a",
  elapsedMs: 100,
  budgetMs: 3250,
  timeoutMs: 3000,
  guardFired: false,
  usage: null,
  server: null,
  status: null,
  promptChars: 20,
  sentChars: 20,
  questions: 1,
  ...over,
});

export const tools = (over: Partial<ToolsRecord> = {}): ToolsRecord => ({
  reason: "selected",
  profile: "answer",
  active: ["read", "grep", "find", "ls"],
  probabilities: { answer: 0.95, edit: 0.03, full: 0.02 },
  risk: 0.05,
  risks: [
    { profile: "answer", risk: 0.05 },
    { profile: "edit", risk: 0.02 },
  ],
  maxRisk: 0.1,
  ...over,
});

export const skills = (over: Partial<SkillsRecord> = {}): SkillsRecord => ({
  reason: "disabled",
  selected: null,
  scores: {},
  discovered: 0,
  eligible: 0,
  maxCandidates: 40,
  asked: 0,
  filteredOut: null,
  delivery: "none",
  ...over,
});

export const ratchet = (over: Partial<RatchetRecord> = {}): RatchetRecord => ({
  narrowAllowed: true,
  before: null,
  after: "answer",
  admitted: true,
  ...over,
});

export const application = (over: Partial<ApplicationRecord> = {}): ApplicationRecord => ({
  status: "applied",
  restoration: null,
  actualTools: ["read", "grep", "find", "ls"],
  error: null,
  ...over,
});

export const decisionV3 = (over: Partial<DecisionRecordV3> = {}): DecisionRecordV3 => ({
  v: 3,
  eventId: uuid(1),
  sessionId: "sess-M",
  decisionId: uuid(201),
  outcome: "classified",
  skip: null,
  failure: null,
  settings: settings(),
  classifier: classifier(),
  tools: tools(),
  skills: skills(),
  ratchet: ratchet(),
  application: application(),
  ...over,
});

/** A stored v2 payload. */
export const decisionV2 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 2,
  failure: null,
  message: "synthetic v2 message",
  backend: "laya",
  dryRun: false,
  latencyMs: 100,
  tools: {
    reason: "selected",
    profile: "answer",
    active: ["read", "grep", "find", "ls"],
    probabilities: { answer: 0.95, edit: 0.03, full: 0.02 },
    risk: 0.05,
  },
  skills: { reason: "disabled", selected: null, scores: {} },
  applied: "answer",
  ...over,
});

export const usageV1 = (over: Partial<UsageObservationV1> = {}): UsageObservationV1 => ({
  v: 1,
  eventId: uuid(501),
  sessionId: "sess-U",
  runId: uuid(900),
  decisionId: null,
  turnIndex: null,
  host: "omp",
  hostEntryId: null,
  stopReason: "stop",
  tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null },
  costTotal: null,
  toolCalls: {},
  toolErrors: null,
  errorStatus: null,
  retryAttempt: null,
  ...over,
});

export const httpRecord = (over: Partial<HttpServerRecordV1> = {}): HttpServerRecordV1 => ({
  type: "loadout.http",
  v: 1,
  requestId: uuid(101),
  idStatus: "valid",
  at: T0,
  outcome: "ok",
  status: 200,
  queueMs: null,
  inferenceMs: null,
  totalMs: null,
  errorClass: null,
  ...over,
});

/** A plugin record as the host stores it. */
export const custom = (customType: string, data: unknown): Record<string, unknown> => ({
  type: "custom",
  customType,
  data,
});

export const userMessage = (text: string): Record<string, unknown> => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});

export const assistantMessage = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "synthetic reply" }],
    stopReason: "stop",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
    ...over,
  },
});

export const toolResultMessage = (isError = false): Record<string, unknown> => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text: "synthetic result" }],
    isError,
  },
});

/** Link entries into one linear branch: id `e<i>`, the previous id as parent, a timestamp one step after the last. */
export function chain(
  entries: Record<string, unknown>[],
  opts: { start?: string; stepMs?: number } = {},
): Record<string, unknown>[] {
  const start = Date.parse(opts.start ?? T0);
  const stepMs = opts.stepMs ?? 60_000;
  return entries.map((entry, i) => ({
    ...entry,
    id: `e${i}`,
    parentId: i === 0 ? null : `e${i - 1}`,
    timestamp: new Date(start + (i + 1) * stepMs).toISOString(),
  }));
}

/** Write a session file. A string line is written verbatim, so a test can plant a malformed line. */
export function writeSession(file: string, lines: Array<Record<string, unknown> | string>, mtime?: Date): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`,
  );
  if (mtime !== undefined) fs.utimesSync(file, mtime, mtime);
  return file;
}

/**
 * Fixture H1: a service log holding four records (one of them a verbatim repeat), a record of an unsupported
 * version and four noise lines. `withoutR2` gives H2, the same log without the `R2` record.
 */
export function serviceLog(file: string, opts: { withoutR2?: boolean } = {}): string {
  const l1 = JSON.stringify(httpRecord({ requestId: R1, queueMs: 5, inferenceMs: 40, totalMs: 47 }));
  const l2Record = httpRecord({
    requestId: R2,
    outcome: "client-gone",
    status: null,
    queueMs: 2900,
    inferenceMs: 300,
    totalMs: 3250,
  });
  const l2 = `Oct 10 00:00:05 host python[123]: ${JSON.stringify(l2Record)}`;
  const l3 = JSON.stringify(httpRecord({ requestId: uuid(109) }));
  const l5 = JSON.stringify({ ...httpRecord({ requestId: uuid(110) }), v: 2 });
  const lines = [
    l1,
    ...(opts.withoutR2 === true ? [] : [l2]),
    l3,
    l1,
    l5,
    "ready on http://127.0.0.1:8799",
    "Traceback (most recent call last):",
    "{ not json",
    '{"type":"other","v":1}',
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

export const BASE7 = ["read", "bash", "edit", "write", "grep", "find", "ls"];
export const SIX = ["read", "grep", "find", "ls", "edit", "write"];

/**
 * Fixture M: one session (header `sess-M`, cwd `/p/one`) holding ten decision records one minute apart: two v2
 * (one failed) and eight v3 covering a plain apply, a dry run, a low-confidence answer, a refused narrowing, a
 * failed attempt, a skip, a failed apply and a candidate-limit.
 */
export function writeMixed(dir: string): { file: string } {
  const decision = (n: number, over: Partial<DecisionRecordV3> = {}): Record<string, unknown> =>
    custom(DECISION_ENTRY, decisionV3({ eventId: uuid(n), decisionId: uuid(200 + n), ...over }));
  const records = [
    custom(DECISION_ENTRY, decisionV2({ message: "CANARY_V2_MESSAGE" })),
    custom(
      DECISION_ENTRY,
      decisionV2({
        failure: "timeout",
        message: "CANARY_V2_FAILURE",
        latencyMs: 4300,
        tools: null,
        skills: null,
        applied: null,
      }),
    ),
    decision(3, {
      classifier: classifier({
        requestId: R1,
        elapsedMs: 50,
        usage: { inputTokens: 41, outputTokens: 3 },
        server: { queueMs: 5, inferenceMs: 40 },
      }),
    }),
    decision(4, {
      settings: settings({ dryRun: true }),
      classifier: classifier({ elapsedMs: 60 }),
      tools: tools({
        profile: "edit",
        active: SIX,
        risk: 0.02,
        probabilities: { answer: 0.02, edit: 0.96, full: 0.02 },
      }),
      application: application({ status: "dry-run", actualTools: BASE7 }),
    }),
    decision(5, {
      classifier: classifier({ elapsedMs: 70 }),
      tools: tools({
        reason: "low-confidence",
        profile: "full",
        active: null,
        probabilities: { answer: 0.42, edit: 0.31, full: 0.27 },
        risk: null,
        risks: [
          { profile: "answer", risk: 0.58 },
          { profile: "edit", risk: 0.27 },
        ],
        maxRisk: 0.1,
      }),
      ratchet: ratchet({ after: "full" }),
      application: application({ status: "unchanged", actualTools: BASE7 }),
    }),
    decision(6, {
      classifier: classifier({ elapsedMs: 80 }),
      ratchet: ratchet({ narrowAllowed: false, before: "full", after: "full", admitted: false }),
      application: application({ status: "not-admitted", actualTools: BASE7 }),
    }),
    decision(7, {
      outcome: "failed",
      failure: "timeout",
      classifier: classifier({ requestId: R2, elapsedMs: 3250, guardFired: true }),
      tools: null,
      skills: skills({ reason: null }),
      ratchet: null,
      application: application({ status: "not-attempted", actualTools: BASE7 }),
    }),
    decision(8, {
      outcome: "skipped",
      skip: "command",
      classifier: null,
      tools: null,
      skills: null,
      ratchet: null,
      application: application({ status: "restored", restoration: "restored", actualTools: BASE7 }),
    }),
    decision(9, {
      classifier: classifier({ elapsedMs: 90 }),
      tools: tools({ profile: "edit", active: SIX, risk: 0.02 }),
      application: application({ status: "failed", restoration: "restored", actualTools: BASE7, error: "EIO" }),
    }),
    decision(10, {
      classifier: classifier({ elapsedMs: 100 }),
      skills: skills({ reason: "too-many-candidates", discovered: 50, eligible: 50, maxCandidates: 40 }),
    }),
  ];
  const file = writeSession(path.join(dir, "mixed.jsonl"), [
    header({ id: "sess-M", cwd: "/p/one" }),
    ...chain(records),
  ]);
  return { file };
}

/**
 * Fixture U: five usage records (header `sess-U`, cwd `/p/two`): a stop, a tool use with two tools and a tool error,
 * a 529 error on its first retry, a stop on its second retry, and an abort. Records 1 and 2 belong to decision
 * `uuid(201)`; the first four share run `uuid(900)`, the last is run `uuid(901)`. `fork` is a verbatim copy with
 * header `sess-U2`.
 */
export function writeUsageHistory(dir: string): { file: string; fork: string } {
  const none = { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null };
  const rows: Array<Partial<UsageObservationV1>> = [
    {
      decisionId: uuid(201),
      stopReason: "stop",
      tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, reasoning: null },
      costTotal: 0.001,
      toolErrors: 0,
    },
    {
      decisionId: uuid(201),
      stopReason: "toolUse",
      tokens: { input: 20, output: 8, cacheRead: 100, cacheWrite: 0, reasoning: 3 },
      costTotal: 0.002,
      toolCalls: { read: 2, bash: 1 },
      toolErrors: 1,
    },
    { stopReason: "error", tokens: none, errorStatus: 529, retryAttempt: 1 },
    {
      stopReason: "stop",
      tokens: { input: 30, output: 9, cacheRead: 120, cacheWrite: 10, reasoning: null },
      costTotal: 0.003,
      toolCalls: { edit: 1 },
      toolErrors: 0,
      retryAttempt: 2,
    },
    {
      runId: uuid(901),
      stopReason: "aborted",
      tokens: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: null },
    },
  ];
  const entries = (id: string): Array<Record<string, unknown>> => [
    header({ id, cwd: "/p/two" }),
    ...chain(rows.map((row, i) => custom(USAGE_ENTRY, usageV1({ eventId: uuid(501 + i), ...row })))),
  ];
  return {
    file: writeSession(path.join(dir, "usage.jsonl"), entries("sess-U")),
    fork: writeSession(path.join(dir, "usage-fork.jsonl"), entries("sess-U2")),
  };
}

/**
 * Fixture V: a user message `u1` with two assistant replies, `a1` (input 10) and `a2` (input 20), each followed by a
 * usage record (`c1`, `c2`); the leaf is `c2`, so `a1` and `c1` sit on an abandoned branch.
 */
export function writeBranches(dir: string): { file: string } {
  const reply = (input: number): Record<string, unknown> =>
    assistantMessage({ usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } });
  const link = (entry: Record<string, unknown>, id: string, parentId: string | null, minute: number) => ({
    ...entry,
    id,
    parentId,
    timestamp: new Date(Date.parse(T0) + minute * 60_000).toISOString(),
  });
  const file = writeSession(path.join(dir, "branches.jsonl"), [
    header({ id: "sess-V", cwd: "/p/three" }),
    link(userMessage("synthetic prompt"), "u1", null, 1),
    link(reply(10), "a1", "u1", 2),
    link(custom(USAGE_ENTRY, usageV1({ eventId: uuid(521), sessionId: "sess-V" })), "c1", "a1", 3),
    link(reply(20), "a2", "u1", 4),
    link(custom(USAGE_ENTRY, usageV1({ eventId: uuid(522), sessionId: "sess-V" })), "c2", "a2", 5),
  ]);
  return { file };
}

/** What the summary and export take: select, read and filter as `buildSummary` does, without the CLI. */
export function reportInput(
  files: string[],
  opts: { filters?: FilterSpec; serviceLogs?: string[]; scope?: ScopeSpec } = {},
): ReportInput {
  const scope: ScopeSpec = opts.scope ?? { kind: "session", files };
  const filters = opts.filters ?? NO_FILTERS;
  const selection = selectFiles(scope);
  return {
    scope,
    selection,
    filters,
    filtered: applyFilters(readSessions(selection.files), scope, filters),
    service: opts.serviceLogs === undefined ? null : readServiceLogs(opts.serviceLogs),
  };
}

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

import type {
  ApplicationRecord,
  ClassifierEvidence,
  DecisionRecordV3,
  HttpServerRecordV1,
  RatchetRecord,
  SafeSettings,
  SkillsRecord,
  ToolsRecord,
  UsageObservationV1,
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

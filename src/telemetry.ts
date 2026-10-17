/**
 * Trace records the plugin writes into the host session, and the readers that
 * turn stored records back into typed views.
 *
 * Privacy rule: a record holds allowlisted identifiers, counts and durations
 * only. Free text from a prompt, a skill description, a rubric or a backend
 * reply never reaches one. Every writer-side field is rebuilt through the
 * primitives below, and the readers apply the same primitives again, so a
 * hostile or corrupted record cannot smuggle text into a report.
 *
 * Record types: `loadout.decision` v3 is produced by the extension.
 * `loadout.usage` v1 and `loadout.http` v1 are defined here for later slices.
 */

import { randomUUID } from "node:crypto";

import { profileRisks } from "./select.ts";
import type {
  FailureReason,
  LayaTransport,
  LoadoutConfig,
  LoadoutDecision,
  SkillsDecision,
  SkillsMode,
  SkillsReason,
  TelemetryState,
  ToolsReason,
} from "./types.ts";

export const DECISION_ENTRY = "loadout.decision";
export const USAGE_ENTRY = "loadout.usage";
export const HTTP_ENTRY = "loadout.http";

export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const newId = (): string => randomUUID();

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,99}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,63}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const REDACTED = "(redacted)";

const ERRNO = new Set([
  "EACCES",
  "EPERM",
  "ENOENT",
  "ENOSPC",
  "EROFS",
  "EIO",
  "EMFILE",
  "ENFILE",
  "EDQUOT",
  "EBUSY",
  "EISDIR",
  "ENOTDIR",
  "ENAMETOOLONG",
  "ELOOP",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SkipReason = "disabled" | "empty-prompt" | "command" | "no-questions";
export type DecisionOutcome = "classified" | "failed" | "skipped";
export type SkillDelivery = "filter" | "hint" | "none" | "dry-run";
export type Restoration = "restored" | "unchanged" | "failed";
export type ApplicationStatus =
  | "applied"
  | "unchanged"
  | "dry-run"
  | "not-admitted"
  | "restored"
  | "failed"
  | "not-attempted";

const SKIPS: readonly SkipReason[] = ["disabled", "empty-prompt", "command", "no-questions"];
const OUTCOMES: readonly DecisionOutcome[] = ["classified", "failed", "skipped"];
const DELIVERIES: readonly SkillDelivery[] = ["filter", "hint", "none", "dry-run"];
const RESTORATIONS: readonly Restoration[] = ["restored", "unchanged", "failed"];
const STATUSES: readonly ApplicationStatus[] = [
  "applied",
  "unchanged",
  "dry-run",
  "not-admitted",
  "restored",
  "failed",
  "not-attempted",
];
const FAILURES: readonly FailureReason[] = [
  "warming",
  "unavailable",
  "timeout",
  "auth",
  "transport",
  "protocol",
  "aborted",
  "error",
];
const TOOLS_REASONS: readonly ToolsReason[] = ["selected", "disabled", "missing-answer", "low-confidence"];
const SKILLS_REASONS: readonly SkillsReason[] = [
  "selected",
  "disabled",
  "no-candidates",
  "too-many-candidates",
  "missing-answer",
];
const SKILLS_MODES: readonly SkillsMode[] = ["auto", "filter", "hint"];
const TRANSPORTS: readonly LayaTransport[] = ["python", "http"];
const BACKENDS: readonly ("jev" | "laya")[] = ["jev", "laya"];
const SCOPES: readonly SafeSettings["configScope"][] = ["default", "project", "global", "explicit"];
const STOP_REASONS = ["stop", "length", "toolUse", "error", "aborted", "other"] as const;
const HTTP_OUTCOMES = ["ok", "client-gone", "error", "rejected"] as const;

/** The settings that shaped a decision. Holds no paths, endpoints, env-var names, rubrics or tool lists. */
export interface SafeSettings {
  enabled: boolean;
  backend: "jev" | "laya";
  transport: LayaTransport | null;
  dryRun: boolean;
  notify: boolean;
  maxPromptChars: number | null;
  configScope: "default" | "project" | "global" | "explicit";
  tools: { enabled: boolean; maxRisk: number };
  skills: { enabled: boolean; mode: SkillsMode; threshold: number; maxSkills: number; maxCandidates: number };
}

export interface ClassifierEvidence {
  requestId: string | null;
  model: string | null;
  elapsedMs: number;
  budgetMs: number;
  timeoutMs: number;
  guardFired: boolean;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  server: { queueMs: number | null; inferenceMs: number | null } | null;
  status: number | null;
  promptChars: number;
  sentChars: number;
  questions: number;
}

export interface ProfileRisk {
  profile: string;
  risk: number | null;
}

export interface ToolsRecord {
  reason: ToolsReason;
  profile: string | null;
  /** The proposal (tools asked for), or null = keep the baseline. NOT what the host ran: see `application.actualTools`. */
  active: string[] | null;
  probabilities: Record<string, number>;
  risk: number | null;
  /** Every profile narrower than the broadest, in profileOrder; null when the answer had no probability. */
  risks: ProfileRisk[] | null;
  maxRisk: number;
}

export interface SkillsRecord {
  reason: SkillsReason | null;
  selected: string[] | null;
  scores: Record<string, number>;
  discovered: number;
  eligible: number;
  maxCandidates: number;
  asked: number;
  /** Skills removed from the host prompt by the filter; null unless delivery is "filter". */
  filteredOut: number | null;
  delivery: SkillDelivery;
}

export interface SkillsEvidence {
  discovered: number;
  eligible: number;
  maxCandidates: number;
  asked: number;
  filteredOut: number | null;
  delivery: SkillDelivery;
  decision: SkillsDecision | null;
}

/** `narrowAllowed` is the value before this decision. */
export interface RatchetRecord {
  narrowAllowed: boolean;
  before: string | null;
  after: string | null;
  admitted: boolean;
}

export interface ApplicationRecord {
  status: ApplicationStatus;
  restoration: Restoration | null;
  /** Read back from the host after applying or restoring; null when it could not be read. */
  actualTools: string[] | null;
  /** Errno code or "error"; never a message. */
  error: string | null;
}

export interface DecisionRecordV3 {
  v: 3;
  eventId: string;
  sessionId: string | null;
  decisionId: string;
  outcome: DecisionOutcome;
  skip: SkipReason | null;
  failure: FailureReason | null;
  settings: SafeSettings;
  classifier: ClassifierEvidence | null;
  tools: ToolsRecord | null;
  skills: SkillsRecord | null;
  ratchet: RatchetRecord | null;
  application: ApplicationRecord;
}

/** One assistant message's usage. Defined here; produced by a later slice. */
export interface UsageObservationV1 {
  v: 1;
  eventId: string;
  sessionId: string | null;
  runId: string;
  decisionId: string | null;
  turnIndex: number | null;
  host: "omp" | "pi";
  hostEntryId: string | null;
  stopReason: (typeof STOP_REASONS)[number] | null;
  tokens: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    reasoning: number | null;
  };
  costTotal: number | null;
  toolCalls: Record<string, number>;
  toolErrors: number | null;
  errorStatus: number | null;
  retryAttempt: number | null;
}

/** One Laya HTTP server request. Defined here; produced by a later slice. */
export interface HttpServerRecordV1 {
  type: "loadout.http";
  v: 1;
  requestId: string | null;
  idStatus: "valid" | "absent" | "invalid";
  at: string;
  outcome: (typeof HTTP_OUTCOMES)[number];
  status: number | null;
  queueMs: number | null;
  inferenceMs: number | null;
  totalMs: number | null;
  errorClass: string | null;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A safe integer >= 0, else null. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Like `count` for in-process numbers that may carry a fraction (elapsed milliseconds). */
function whole(value: unknown): number | null {
  return count(typeof value === "number" ? Math.round(value) : value);
}

/** A finite number >= 0, else null. */
function measure(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function id(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

function name(value: unknown): string | null {
  return typeof value === "string" && SAFE_NAME.test(value) ? value : null;
}

function sessionIdOf(value: unknown): string | null {
  return typeof value === "string" && SESSION_ID.test(value) ? value : null;
}

/** A list of identifiers; one that is not a safe identifier is replaced, never copied. */
function names(value: unknown): string[] | null {
  return Array.isArray(value) ? value.map((item) => name(item) ?? REDACTED) : null;
}

function numberMap(source: unknown, allowedKeys?: ReadonlySet<string>): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(source)) return out;
  for (const [key, value] of Object.entries(source)) {
    const number = finite(value);
    if (number !== null && SAFE_NAME.test(key) && (allowedKeys === undefined || allowedKeys.has(key)))
      out[key] = number;
  }
  return out;
}

function countMap(source: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(source)) return out;
  for (const [key, value] of Object.entries(source)) {
    const number = count(value);
    if (number !== null && SAFE_NAME.test(key)) out[key] = number;
  }
  return out;
}

export function safeModel(value: unknown): string | null {
  return typeof value === "string" && MODEL.test(value) ? value : null;
}

export function safeStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

/** Backend usage (`input_tokens`/`output_tokens`) as the stored shape; null when neither count is valid. */
export function safeUsage(value: unknown): { inputTokens: number | null; outputTokens: number | null } | null {
  if (!isRecord(value)) return null;
  return storedUsage({ inputTokens: value.input_tokens, outputTokens: value.output_tokens });
}

function storedUsage(value: unknown): { inputTokens: number | null; outputTokens: number | null } | null {
  if (!isRecord(value)) return null;
  const inputTokens = count(value.inputTokens);
  const outputTokens = count(value.outputTokens);
  return inputTokens === null && outputTokens === null ? null : { inputTokens, outputTokens };
}

export function safeTiming(value: unknown): { queueMs: number | null; inferenceMs: number | null } | null {
  if (!isRecord(value)) return null;
  const queueMs = measure(value.queueMs);
  const inferenceMs = measure(value.inferenceMs);
  return queueMs === null && inferenceMs === null ? null : { queueMs, inferenceMs };
}

/** The errno code of a failure, or "error". Total: a hostile error object cannot make it throw or leak text. */
export function safeErrorCode(error: unknown): string {
  try {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && ERRNO.has(code) ? code : "error";
  } catch {
    return "error";
  }
}

function storedError(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && (ERRNO.has(value) || value === "error") ? value : "error";
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export function settingsSnapshot(config: LoadoutConfig, scope: "project" | "global" | "explicit" | null): SafeSettings {
  return {
    enabled: config.enabled,
    backend: config.backend,
    transport: config.backend === "laya" ? config.laya.transport : null,
    dryRun: config.dryRun,
    notify: config.notify,
    maxPromptChars: config.maxPromptChars,
    configScope: scope ?? "default",
    tools: { enabled: config.tools.enabled, maxRisk: config.tools.maxRisk },
    skills: {
      enabled: config.skills.enabled,
      mode: config.skills.mode,
      threshold: config.skills.threshold,
      maxSkills: config.skills.maxSkills,
      maxCandidates: config.skills.maxCandidates,
    },
  };
}

export interface DecisionInput {
  eventId: string;
  decisionId: string;
  sessionId: string | null;
  settings: SafeSettings;
  /** Set => outcome "skipped". */
  gate: SkipReason | null;
  /** Used when there is no gate and no decision; default "error". */
  failure: FailureReason | null;
  classifier: ClassifierEvidence | null;
  decision: LoadoutDecision | null;
  /** `profileOrder(config.tools)`: the only profile ids a record may name. */
  order: string[];
  maxRisk: number;
  skills: SkillsEvidence | null;
  ratchet: RatchetRecord | null;
  application: ApplicationRecord;
}

function classifierRecord(raw: unknown): ClassifierEvidence | null {
  const view = readClassifier(raw);
  if (view === null) return null;
  return {
    ...view,
    elapsedMs: view.elapsedMs ?? 0,
    budgetMs: view.budgetMs ?? 0,
    timeoutMs: view.timeoutMs ?? 0,
    guardFired: view.guardFired ?? false,
    promptChars: view.promptChars ?? 0,
    sentChars: view.sentChars ?? 0,
    questions: view.questions ?? 0,
  };
}

function toolsRecord(decision: LoadoutDecision["tools"], order: string[], maxRisk: number): ToolsRecord {
  const probabilities = isRecord(decision.probabilities) ? decision.probabilities : {};
  const risks = profileRisks(order, probabilities);
  return {
    reason: oneOf(decision.reason, TOOLS_REASONS) ?? "missing-answer",
    profile: order.includes(decision.profile as string) ? decision.profile : null,
    active: names(decision.active),
    probabilities: numberMap(probabilities, new Set(order)),
    risk: finite(decision.risk),
    risks: risks === null ? null : risks.map(({ profile, risk }) => ({ profile, risk: finite(risk) })),
    maxRisk: finite(maxRisk) ?? 0,
  };
}

function skillsRecord(evidence: SkillsEvidence): SkillsRecord {
  const decision = evidence.decision;
  return {
    reason: oneOf(decision?.reason, SKILLS_REASONS),
    selected: names(decision?.selected),
    scores: numberMap(decision?.scores),
    discovered: count(evidence.discovered) ?? 0,
    eligible: count(evidence.eligible) ?? 0,
    maxCandidates: count(evidence.maxCandidates) ?? 0,
    asked: count(evidence.asked) ?? 0,
    filteredOut: count(evidence.filteredOut),
    delivery: oneOf(evidence.delivery, DELIVERIES) ?? "none",
  };
}

/** Pure; rebuilds every field from allowlists and never throws on hostile input. */
export function buildDecisionRecord(input: DecisionInput): DecisionRecordV3 {
  const outcome: DecisionOutcome = input.gate ? "skipped" : input.decision ? "classified" : "failed";
  const ratchet = readRatchet(input.ratchet);
  return {
    v: 3,
    eventId: input.eventId,
    sessionId: sessionIdOf(input.sessionId),
    decisionId: input.decisionId,
    outcome,
    skip: input.gate,
    failure: outcome === "failed" ? (oneOf(input.failure, FAILURES) ?? "error") : null,
    settings: input.settings,
    classifier: classifierRecord(input.classifier),
    tools: input.decision ? toolsRecord(input.decision.tools, input.order, input.maxRisk) : null,
    skills: input.skills ? skillsRecord(input.skills) : null,
    ratchet: ratchet && {
      narrowAllowed: ratchet.narrowAllowed ?? false,
      before: ratchet.before,
      after: ratchet.after,
      admitted: ratchet.admitted ?? false,
    },
    application: {
      status: oneOf(input.application.status, STATUSES) ?? "not-attempted",
      restoration: oneOf(input.application.restoration, RESTORATIONS),
      actualTools: names(input.application.actualTools),
      error: storedError(input.application.error),
    },
  };
}

export type PersistResult = { outcome: "handed-off" } | { outcome: "suppressed" } | { outcome: "failed"; code: string };

/**
 * Hand a record to the host. "handed-off" means the host's append did not
 * raise; it does not mean the record reached disk. Never throws, and a failure
 * is reported by errno code only.
 */
export function persistRecord(
  append: (type: string, data: unknown) => void,
  state: TelemetryState,
  type: string,
  record: unknown,
): PersistResult {
  if (!state.persist) return { outcome: "suppressed" };
  // The host must never receive a payload that cannot be serialized: some hosts latch a disk failure on one.
  try {
    JSON.stringify(record);
  } catch {
    return { outcome: "failed", code: "serialize" };
  }
  try {
    append(type, record);
    return { outcome: "handed-off" };
  } catch (error) {
    return { outcome: "failed", code: safeErrorCode(error) };
  }
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export type Nullable<T> = { [K in keyof T]: T[K] | null };

export type ToolsView = Nullable<Omit<ToolsRecord, "reason" | "probabilities">> & {
  reason: ToolsReason;
  probabilities: Record<string, number>;
};
export type SkillsView = Nullable<Omit<SkillsRecord, "scores">> & { scores: Record<string, number> };

/** A decision record of any supported version, with everything a version did not record as null. */
export interface DecisionView {
  version: 2 | 3;
  eventId: string | null;
  decisionId: string | null;
  sessionId: string | null;
  outcome: DecisionOutcome;
  skip: SkipReason | null;
  failure: FailureReason | null;
  backend: "jev" | "laya" | null;
  dryRun: boolean | null;
  latencyMs: number | null;
  settings: SafeSettings | null;
  classifier: Nullable<ClassifierEvidence> | null;
  tools: ToolsView | null;
  skills: SkillsView | null;
  ratchet: Nullable<RatchetRecord> | null;
  application: ApplicationRecord | null;
}

function readClassifier(raw: unknown): Nullable<ClassifierEvidence> | null {
  if (!isRecord(raw)) return null;
  return {
    requestId: id(raw.requestId),
    model: safeModel(raw.model),
    elapsedMs: whole(raw.elapsedMs),
    budgetMs: whole(raw.budgetMs),
    timeoutMs: whole(raw.timeoutMs),
    guardFired: flag(raw.guardFired),
    usage: storedUsage(raw.usage),
    server: safeTiming(raw.server),
    status: safeStatus(raw.status),
    promptChars: count(raw.promptChars),
    sentChars: count(raw.sentChars),
    questions: count(raw.questions),
  };
}

function readRatchet(raw: unknown): Nullable<RatchetRecord> | null {
  if (!isRecord(raw)) return null;
  return {
    narrowAllowed: flag(raw.narrowAllowed),
    before: name(raw.before),
    after: name(raw.after),
    admitted: flag(raw.admitted),
  };
}

function readApplication(raw: unknown): ApplicationRecord | null {
  if (!isRecord(raw)) return null;
  const status = oneOf(raw.status, STATUSES);
  if (status === null) return null;
  return {
    status,
    restoration: oneOf(raw.restoration, RESTORATIONS),
    actualTools: names(raw.actualTools),
    error: storedError(raw.error),
  };
}

function readTools(raw: unknown): ToolsView | null {
  if (!isRecord(raw)) return null;
  const reason = oneOf(raw.reason, TOOLS_REASONS);
  if (reason === null) return null;
  const risks = Array.isArray(raw.risks)
    ? raw.risks.flatMap((entry) => {
        const profile = isRecord(entry) ? name(entry.profile) : null;
        return profile === null ? [] : [{ profile, risk: finite((entry as Record<string, unknown>).risk) }];
      })
    : null;
  return {
    reason,
    profile: name(raw.profile),
    active: names(raw.active),
    probabilities: numberMap(raw.probabilities),
    risk: finite(raw.risk),
    risks,
    maxRisk: finite(raw.maxRisk),
  };
}

function readSkills(raw: unknown): SkillsView | null {
  if (!isRecord(raw)) return null;
  return {
    reason: oneOf(raw.reason, SKILLS_REASONS),
    selected: names(raw.selected),
    scores: numberMap(raw.scores),
    discovered: count(raw.discovered),
    eligible: count(raw.eligible),
    maxCandidates: count(raw.maxCandidates),
    asked: count(raw.asked),
    filteredOut: count(raw.filteredOut),
    delivery: oneOf(raw.delivery, DELIVERIES),
  };
}

function readSettings(raw: unknown): SafeSettings | null {
  if (!isRecord(raw) || !isRecord(raw.tools) || !isRecord(raw.skills)) return null;
  const backend = oneOf(raw.backend, BACKENDS);
  const configScope = oneOf(raw.configScope, SCOPES);
  const mode = oneOf(raw.skills.mode, SKILLS_MODES);
  const enabled = flag(raw.enabled);
  const dryRun = flag(raw.dryRun);
  const notify = flag(raw.notify);
  const toolsEnabled = flag(raw.tools.enabled);
  const skillsEnabled = flag(raw.skills.enabled);
  const maxRisk = finite(raw.tools.maxRisk);
  const threshold = finite(raw.skills.threshold);
  const maxSkills = count(raw.skills.maxSkills);
  const maxCandidates = count(raw.skills.maxCandidates);
  if (
    backend === null ||
    configScope === null ||
    mode === null ||
    enabled === null ||
    dryRun === null ||
    notify === null ||
    toolsEnabled === null ||
    skillsEnabled === null ||
    maxRisk === null ||
    threshold === null ||
    maxSkills === null ||
    maxCandidates === null
  ) {
    return null;
  }
  return {
    enabled,
    backend,
    transport: oneOf(raw.transport, TRANSPORTS),
    dryRun,
    notify,
    maxPromptChars: count(raw.maxPromptChars),
    configScope,
    tools: { enabled: toolsEnabled, maxRisk },
    skills: { enabled: skillsEnabled, mode, threshold, maxSkills, maxCandidates },
  };
}

function normalizeV3(data: Record<string, unknown>): DecisionView | null {
  const eventId = id(data.eventId);
  const outcome = oneOf(data.outcome, OUTCOMES);
  if (eventId === null || outcome === null) return null;
  const settings = readSettings(data.settings);
  const classifier = readClassifier(data.classifier);
  return {
    version: 3,
    eventId,
    decisionId: id(data.decisionId),
    sessionId: sessionIdOf(data.sessionId),
    outcome,
    skip: oneOf(data.skip, SKIPS),
    failure: oneOf(data.failure, FAILURES),
    backend: settings?.backend ?? null,
    dryRun: settings?.dryRun ?? null,
    latencyMs: classifier?.elapsedMs ?? null,
    settings,
    classifier,
    tools: readTools(data.tools),
    skills: readSkills(data.skills),
    ratchet: readRatchet(data.ratchet),
    application: readApplication(data.application),
  };
}

function normalizeV2(data: Record<string, unknown>): DecisionView | null {
  if (!Object.hasOwn(data, "failure")) return null;
  const failure = data.failure === null ? null : oneOf(data.failure, FAILURES);
  if (data.failure !== null && failure === null) return null;
  const tools = readTools(data.tools);
  const skills = readSkills(data.skills);
  return {
    version: 2,
    eventId: null,
    decisionId: null,
    sessionId: null,
    outcome: failure === null ? "classified" : "failed",
    skip: null,
    failure,
    backend: oneOf(data.backend, BACKENDS),
    dryRun: flag(data.dryRun),
    latencyMs: measure(data.latencyMs),
    settings: null,
    classifier: null,
    tools: tools && { ...tools, risks: null, maxRisk: null },
    skills: skills && {
      ...skills,
      discovered: null,
      eligible: null,
      maxCandidates: null,
      asked: null,
      filteredOut: null,
      delivery: null,
    },
    ratchet: { narrowAllowed: null, before: null, after: name(data.applied), admitted: null },
    application: null,
  };
}

/** Read a stored `loadout.decision` payload of any supported version; null for an unknown version or shape. */
export function normalizeDecision(data: unknown): DecisionView | null {
  if (!isRecord(data)) return null;
  if (data.v === 3) return normalizeV3(data);
  if (data.v === 2) return normalizeV2(data);
  return null;
}

export function normalizeUsage(data: unknown): UsageObservationV1 | null {
  if (!isRecord(data) || data.v !== 1) return null;
  const eventId = id(data.eventId);
  const runId = id(data.runId);
  const host = oneOf(data.host, ["omp", "pi"] as const);
  if (eventId === null || runId === null || host === null) return null;
  const tokens = isRecord(data.tokens) ? data.tokens : {};
  return {
    v: 1,
    eventId,
    sessionId: sessionIdOf(data.sessionId),
    runId,
    decisionId: id(data.decisionId),
    turnIndex: count(data.turnIndex),
    host,
    hostEntryId: sessionIdOf(data.hostEntryId),
    stopReason: typeof data.stopReason === "string" ? (oneOf(data.stopReason, STOP_REASONS) ?? "other") : null,
    tokens: {
      input: count(tokens.input),
      output: count(tokens.output),
      cacheRead: count(tokens.cacheRead),
      cacheWrite: count(tokens.cacheWrite),
      reasoning: count(tokens.reasoning),
    },
    costTotal: measure(data.costTotal),
    toolCalls: countMap(data.toolCalls),
    toolErrors: count(data.toolErrors),
    errorStatus: safeStatus(data.errorStatus),
    retryAttempt: count(data.retryAttempt),
  };
}

export function normalizeHttp(data: unknown): HttpServerRecordV1 | null {
  if (!isRecord(data) || data.type !== "loadout.http" || data.v !== 1) return null;
  const outcome = oneOf(data.outcome, HTTP_OUTCOMES);
  if (outcome === null || typeof data.at !== "string" || !ISO_UTC.test(data.at)) return null;
  const requestId = id(data.requestId);
  return {
    type: "loadout.http",
    v: 1,
    requestId,
    idStatus: requestId !== null ? "valid" : data.idStatus === "absent" ? "absent" : "invalid",
    at: data.at,
    outcome,
    status: safeStatus(data.status),
    queueMs: measure(data.queueMs),
    inferenceMs: measure(data.inferenceMs),
    totalMs: measure(data.totalMs),
    errorClass: typeof data.errorClass === "string" && ERROR_CLASS.test(data.errorClass) ? data.errorClass : null,
  };
}

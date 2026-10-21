/**
 * Aggregate decisions, model-turn usage, host-transcript turns and service evidence into one summary.
 *
 * Unknown stays unknown: a missing measurement is `null` or counted as unknown, never zero, and a `Stats` over
 * no values is all null. Closed vocabularies are zero-filled; open maps list only observed keys. Nothing here
 * reads a clock or a path, so the output is deterministic, and nothing names a cause, a remedy or a saving.
 * Model-turn usage (`loadout.usage`) and host-transcript turns are separate sources and are never added.
 */

import type { DecisionView, HttpServerRecordV1 } from "../telemetry.ts";
import type {
  Branch,
  DecisionEvent,
  Provenance,
  ServiceRead,
  ToolResultEvent,
  TurnEvent,
  TurnOutcome,
  UsageEvent,
} from "./read.ts";
import type { FilterSpec, Filtered, ScopeSpec, Selection } from "./scope.ts";

export type Count = Record<string, number>;
export interface Sum {
  sum: number;
  known: number;
  unknown: number;
}
export interface Stats {
  n: number;
  mean: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  max: number | null;
}

export const DISCLOSURES = [
  "identifiers-are-local-metadata-not-anonymous",
  "proposals-are-not-applied-changes",
  "unknown-is-not-zero",
  "usage-and-transcript-are-separate-sources",
  "no-child-session-rollup",
  "observed-usage-is-not-billing",
  "absent-records-are-not-evidence-of-no-activity",
] as const;

// ---------------------------------------------------------------------------
// Summary types
// ---------------------------------------------------------------------------

export interface ScopeInfo {
  kind: "session" | "historical";
  /** Files selected, read or not. */
  files: number;
  nestedChildFiles: number;
  childFilesNotRead: number;
  /** Session scope: child directories that could not be listed or examined, so `childFilesNotRead` is a lower bound. */
  childDirsUnreadable: number;
  /** ISO UTC; `since` is inclusive, `until` exclusive. */
  since: string | null;
  until: string | null;
  /** Never the paths themselves. */
  projects: "exact" | "all-projects" | null;
}

export interface FilterInfo {
  branch: "all" | "active" | "abandoned";
  outcome: { decision: string[] | null; usage: string[] | null };
}

export interface Coverage {
  /** `unreadable` includes unreadable directories. */
  files: { read: number; unreadable: number; withoutHeader: number; skippedByMtime: number };
  /** File-level, before filters. */
  malformedLines: number;
  /** Instances discarded while reading, before filters. */
  duplicatesRemoved: { decisions: number; usage: number };
  /** v2 decisions among the decisions kept: they have no event id and cannot be deduplicated. */
  unidentifiable: { decisions: number };
  /** After filters. */
  unsupported: { decisions: number; usage: number };
  /** Identifiable decisions (v3) and usage records, after filters. */
  provenance: Record<Provenance, number>;
  removedByFilters: Filtered["removed"];
}

export interface DecisionsSummary {
  total: number;
  outcomes: { classified: number; failed: number; skipped: number };
  versions: { v2: number; v3: number };
  branch: Record<Branch, number>;
  skips: Count;
  sessions: number;
  dryRun: { yes: number; no: number; unknown: number };
  failures: Count;
  latencyMs: Stats;
  proposals: {
    tools: number;
    none: number;
    narrowing: number;
    keepBaseline: number;
    profiles: Count;
    reasons: Count;
    proposedTools: Stats;
    risk: Stats;
  };
  application: { statuses: Count; actualTools: Stats };
  selection: { narrow: Count; "keep-baseline": Count; none: Count };
  ratchet: { blocked: number; admitted: number; unknown: number };
  skills: { reasons: Count; selected: Count; candidateLimit: number; delivery: Count };
  blockers: Record<LeadId, number>;
}

export interface ClassifierSummary {
  attempts: number;
  evidence: number;
  guardFired: { yes: number; no: number; unknown: number };
  tokens: { input: Sum; output: Sum };
  server: { reported: number; unreported: number; queueMs: Stats; inferenceMs: Stats };
  models: Count;
  requestIds: { present: number; absent: number };
  promptClipped: { yes: number; no: number; unknown: number };
}

export interface UsageSummary {
  turns: number;
  runs: number;
  hosts: Count;
  outcomes: Record<TurnOutcome, number>;
  branch: Record<Branch, number>;
  tokens: { input: Sum; output: Sum; cacheRead: Sum; cacheWrite: Sum; reasoning: Sum };
  cost: Sum;
  toolCalls: { total: number; byTool: Count };
  toolErrors: Sum;
  errorStatus: Count;
  retries: { reported: number; unreported: number; maxAttempt: number | null; byAttempt: Count };
  assignment: { assigned: number; unassigned: number };
}

export interface TranscriptSummary {
  turns: number;
  outcomes: Record<TurnOutcome, number>;
  branch: Record<Branch, number>;
  tokens: { input: Sum; output: Sum; cacheRead: Sum; cacheWrite: Sum };
  cost: Sum;
  toolCalls: { total: number; byTool: Count };
  /** Null when a model-turn outcome filter is on: a tool result cannot be attributed to a turn outcome. */
  toolResults: number | null;
  toolErrors: number | null;
  /** Host messages carry no identity to deduplicate on, so a copied history repeats its turns. */
  deduplicated: false;
}

export interface HttpSummary {
  files: number;
  unreadable: number;
  lines: { total: number; records: number; unsupported: number; other: number };
  /** After dedupe of identical repeats; every record of a conflicting id stays counted. */
  records: number;
  duplicates: number;
  /** Request ids that have two or more different records. */
  conflicts: number;
  /** Joinable attempts whose id has exactly one record. */
  joined: number;
  unmatched: {
    clientWithoutRecord: number;
    notJoinable: number;
    ambiguous: number;
    recordsNotInScope: number;
    recordsWithoutRequestId: number;
  };
  outcomes: Count;
  phases: { queueMs: Stats; inferenceMs: Stats; totalMs: Stats };
  timeouts: { clientTimeouts: number; joined: number; outcomes: Count; queueMs: Stats; inferenceMs: Stats };
}

export const LEAD_IDS = [
  "classifier-failed",
  "low-confidence",
  "ratchet-refused",
  "candidate-limit",
  "application-failed",
] as const;
export type LeadId = (typeof LEAD_IDS)[number];

/** A recorded count with the population it is out of. Names no remedy and makes no claim about causes or savings. */
export interface Lead {
  id: LeadId;
  count: number;
  of: number;
  evidence: Record<string, unknown>;
}

export interface Summary {
  schema: "loadout-report.summary/1";
  scope: ScopeInfo;
  filters: FilterInfo;
  coverage: Coverage;
  decisions: DecisionsSummary;
  classifier: ClassifierSummary;
  usage: UsageSummary;
  transcript: TranscriptSummary;
  /** Null unless a service log was given: every join figure is then unknown. */
  http: HttpSummary | null;
  leads: Lead[];
  disclosures: readonly string[];
}

export interface ReportInput {
  scope: ScopeSpec;
  selection: Selection;
  filtered: Filtered;
  filters: FilterSpec;
  service: ServiceRead | null;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function ranked(counts: ReadonlyMap<string, number>): Count {
  return Object.fromEntries([...counts].sort(([a, x], [b, y]) => y - x || byText(a, b)));
}

/** Count by key, most frequent first, then by key. */
export function tally(keys: Iterable<string>): Count {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return ranked(counts);
}

/**
 * The sum of the known values. A value that would push the total past what a number can hold (only a corrupt or
 * hostile record has one) is counted unknown, never added as Infinity.
 */
export function sumOf(values: Array<number | null>): Sum {
  let sum = 0;
  let known = 0;
  for (const value of values) {
    if (value === null || !Number.isFinite(sum + value)) continue;
    sum += value;
    known++;
  }
  return { sum, known, unknown: values.length - known };
}

/** Nearest-rank percentile; NaN for no values (the contract the benchmark relies on). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] as number;
}

/** The mean. When the plain total would overflow, each value is scaled first: the mean of finite values is finite. */
function meanOf(values: number[]): number {
  const total = values.reduce((a, b) => a + b, 0);
  return Number.isFinite(total) ? total / values.length : values.reduce((a, b) => a + b / values.length, 0);
}

/** Statistics over the known values only; every field is null when there are none. */
export function statsOf(values: number[]): Stats {
  if (values.length === 0) return { n: 0, mean: null, p10: null, p50: null, p90: null, max: null };
  return {
    n: values.length,
    mean: meanOf(values),
    p10: percentile(values, 10),
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    max: values.reduce((a, b) => (b > a ? b : a)),
  };
}

/** The known entries of a list that may hold nulls. */
const known = (values: Array<number | null>): number[] => values.filter((value): value is number => value !== null);

const sortedDistinct = (values: Array<number | null>): number[] => [...new Set(known(values))].sort((a, b) => a - b);

function branches(items: Iterable<{ where: { branch: Branch } }>): Record<Branch, number> {
  const out: Record<Branch, number> = { active: 0, abandoned: 0, unknown: 0 };
  for (const item of items) out[item.where.branch]++;
  return out;
}

function turnOutcomes(outcomes: Iterable<TurnOutcome>): Record<TurnOutcome, number> {
  const out: Record<TurnOutcome, number> = {
    stop: 0,
    length: 0,
    toolUse: 0,
    error: 0,
    aborted: 0,
    other: 0,
    unknown: 0,
  };
  for (const outcome of outcomes) out[outcome]++;
  return out;
}

function threeWay(values: Iterable<boolean | null>): { yes: number; no: number; unknown: number } {
  const out = { yes: 0, no: 0, unknown: 0 };
  for (const value of values) out[value === null ? "unknown" : value ? "yes" : "no"]++;
  return out;
}

function toolCalls(perTurn: Iterable<Record<string, number>>): { total: number; byTool: Count } {
  const byTool = new Map<string, number>();
  let total = 0;
  for (const calls of perTurn) {
    for (const [name, n] of Object.entries(calls)) {
      byTool.set(name, (byTool.get(name) ?? 0) + n);
      total += n;
    }
  }
  return { total, byTool: ranked(byTool) };
}

// ---------------------------------------------------------------------------
// Transcript and usage
// ---------------------------------------------------------------------------

/** Totals over host-transcript turns. Not deduplicated; `toolResults` and `toolErrors` are null when `usageFiltered`. */
export function transcriptTotals(
  turns: readonly TurnEvent[],
  toolResults: readonly ToolResultEvent[],
  usageFiltered = false,
): TranscriptSummary {
  return {
    turns: turns.length,
    outcomes: turnOutcomes(turns.map((turn) => turn.outcome)),
    branch: branches(turns),
    tokens: {
      input: sumOf(turns.map((turn) => turn.tokens.input)),
      output: sumOf(turns.map((turn) => turn.tokens.output)),
      cacheRead: sumOf(turns.map((turn) => turn.tokens.cacheRead)),
      cacheWrite: sumOf(turns.map((turn) => turn.tokens.cacheWrite)),
    },
    cost: sumOf(turns.map((turn) => turn.cost)),
    toolCalls: toolCalls(turns.map((turn) => turn.tools)),
    toolResults: usageFiltered ? null : toolResults.length,
    toolErrors: usageFiltered ? null : toolResults.filter((result) => result.isError).length,
    deduplicated: false,
  };
}

type PromptTokens = Pick<TranscriptSummary["tokens"], "input" | "cacheRead" | "cacheWrite">;

/** Share of all prompt tokens read from cache; cache writes count as prompt tokens, not hits. */
export function cacheRate(tokens: PromptTokens): number {
  const prompt = tokens.input.sum + tokens.cacheRead.sum + tokens.cacheWrite.sum;
  return prompt === 0 ? 0 : tokens.cacheRead.sum / prompt;
}

/** Prompt tokens sent per assistant message, fresh and cached alike. */
export function promptTokensPerRequest(totals: TranscriptSummary): number {
  const prompt = totals.tokens.input.sum + totals.tokens.cacheRead.sum + totals.tokens.cacheWrite.sum;
  return totals.turns === 0 ? 0 : prompt / totals.turns;
}

function summarizeUsage(events: readonly UsageEvent[]): UsageSummary {
  const records = events.map((event) => event.record);
  const attempts = known(records.map((record) => record.retryAttempt));
  return {
    turns: records.length,
    runs: new Set(records.map((record) => record.runId)).size,
    hosts: tally(records.map((record) => record.host)),
    outcomes: turnOutcomes(records.map((record) => record.stopReason ?? "unknown")),
    branch: branches(events),
    tokens: {
      input: sumOf(records.map((record) => record.tokens.input)),
      output: sumOf(records.map((record) => record.tokens.output)),
      cacheRead: sumOf(records.map((record) => record.tokens.cacheRead)),
      cacheWrite: sumOf(records.map((record) => record.tokens.cacheWrite)),
      reasoning: sumOf(records.map((record) => record.tokens.reasoning)),
    },
    cost: sumOf(records.map((record) => record.costTotal)),
    toolCalls: toolCalls(records.map((record) => record.toolCalls)),
    toolErrors: sumOf(records.map((record) => record.toolErrors)),
    errorStatus: tally(known(records.map((record) => record.errorStatus)).map(String)),
    // `retryAttempt` is informational in the schema; the report assigns it no meaning.
    retries: {
      reported: attempts.length,
      unreported: records.length - attempts.length,
      maxAttempt: attempts.length === 0 ? null : attempts.reduce((a, b) => (b > a ? b : a)),
      byAttempt: tally(attempts.map(String)),
    },
    assignment: {
      assigned: records.filter((record) => record.decisionId !== null).length,
      unassigned: records.filter((record) => record.decisionId === null).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Service join
// ---------------------------------------------------------------------------

/**
 * Join attempts to service records by request id. Only a joinable attempt takes part: it has a request id and used
 * the Laya HTTP transport, the only one that sends the id to a server. An attempt of any other transport has an id
 * and can never have a server record, so its id is no evidence of a missing one. When one id has two or more
 * different records the id is a conflict: none of its records joins and the attempts that name it are ambiguous.
 * The time range never filters service records. `joined` holds each joined record once; `pairs` maps an attempt to
 * the record it joined.
 */
export function joinService(
  attempts: readonly DecisionEvent[],
  service: ServiceRead,
): { http: HttpSummary; joined: HttpServerRecordV1[]; pairs: Map<DecisionEvent, HttpServerRecordV1> } {
  const byId = new Map<string, HttpServerRecordV1[]>();
  for (const record of service.records) {
    if (record.requestId === null) continue;
    const group = byId.get(record.requestId);
    if (group === undefined) byId.set(record.requestId, [record]);
    else group.push(record);
  }

  const pairs = new Map<DecisionEvent, HttpServerRecordV1>();
  const named = new Set<string>();
  const unmatched = {
    clientWithoutRecord: 0,
    notJoinable: 0,
    ambiguous: 0,
    recordsNotInScope: 0,
    recordsWithoutRequestId: 0,
  };
  for (const attempt of attempts) {
    const requestId = attempt.view.classifier?.requestId ?? null;
    if (requestId === null) continue;
    if (attempt.view.settings?.transport !== "http") {
      unmatched.notJoinable++;
      continue;
    }
    named.add(requestId);
    const records = byId.get(requestId);
    if (records === undefined) unmatched.clientWithoutRecord++;
    else if (records.length > 1) unmatched.ambiguous++;
    else pairs.set(attempt, records[0] as HttpServerRecordV1);
  }
  for (const record of service.records) {
    if (record.requestId === null) unmatched.recordsWithoutRequestId++;
    else if (!named.has(record.requestId)) unmatched.recordsNotInScope++;
  }

  const joinedIds = new Set([...pairs.values()].map((record) => record.requestId));
  const joined = service.records.filter((record) => joinedIds.has(record.requestId));
  const phases = (records: readonly HttpServerRecordV1[], key: "queueMs" | "inferenceMs" | "totalMs"): Stats =>
    statsOf(known(records.map((record) => record[key])));
  const timedOut = [...pairs].filter(([attempt]) => attempt.view.failure === "timeout").map(([, record]) => record);
  return {
    http: {
      files: service.files,
      unreadable: service.unreadable,
      lines: service.lines,
      records: service.records.length,
      duplicates: service.duplicates,
      conflicts: [...byId.values()].filter((group) => group.length > 1).length,
      joined: pairs.size,
      unmatched,
      outcomes: tally(joined.map((record) => record.outcome)),
      phases: {
        queueMs: phases(joined, "queueMs"),
        inferenceMs: phases(joined, "inferenceMs"),
        totalMs: phases(joined, "totalMs"),
      },
      timeouts: {
        clientTimeouts: attempts.filter(
          (attempt) =>
            attempt.view.failure === "timeout" &&
            attempt.view.classifier?.requestId != null &&
            attempt.view.settings?.transport === "http",
        ).length,
        joined: timedOut.length,
        outcomes: tally(timedOut.map((record) => record.outcome)),
        queueMs: phases(timedOut, "queueMs"),
        inferenceMs: phases(timedOut, "inferenceMs"),
      },
    },
    joined,
    pairs,
  };
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

/** The smallest known risk among an attempt's narrower profiles, or null when it recorded none. */
function closestRisk(attempt: DecisionEvent): number | null {
  const risks = known((attempt.view.tools?.risks ?? []).map((entry) => entry.risk));
  return risks.length === 0 ? null : risks.reduce((a, b) => (b < a ? b : a));
}

function leadCandidates(
  attempts: readonly DecisionEvent[],
  pairs: ReadonlyMap<DecisionEvent, HttpServerRecordV1> | null,
): Lead[] {
  const failed = attempts.filter((attempt) => attempt.view.outcome === "failed");
  const serverRecords = pairs === null ? [] : failed.flatMap((attempt) => pairs.get(attempt) ?? []);

  const withTools = attempts.filter((attempt) => attempt.view.tools !== null);
  const lowConfidence = withTools.filter((attempt) => attempt.view.tools?.reason === "low-confidence");
  const closest = lowConfidence.map(closestRisk);

  const narrowing = attempts.filter(
    (attempt) => attempt.view.application !== null && attempt.view.tools?.active != null,
  );
  const refused = narrowing.filter((attempt) => attempt.view.application?.status === "not-admitted");

  const withSkills = attempts.filter((attempt) => attempt.view.skills !== null);
  const limited = withSkills.filter((attempt) => attempt.view.skills?.reason === "too-many-candidates");

  const withApplication = attempts.filter((attempt) => attempt.view.application !== null);
  const applyFailed = withApplication.filter((attempt) => attempt.view.application?.status === "failed");

  return [
    {
      id: "classifier-failed",
      count: failed.length,
      of: attempts.length,
      evidence: {
        failures: tally(failed.map((attempt) => attempt.view.failure ?? "unknown")),
        guardFired: failed.filter((attempt) => attempt.view.classifier?.guardFired === true).length,
        serverEvidence:
          pairs === null
            ? null
            : { joined: serverRecords.length, outcomes: tally(serverRecords.map((record) => record.outcome)) },
      },
    },
    {
      id: "low-confidence",
      count: lowConfidence.length,
      of: withTools.length,
      evidence: {
        closestNarrowerRisk: statsOf(known(closest)),
        riskUnknown: closest.filter((risk) => risk === null).length,
        maxRisk: sortedDistinct(lowConfidence.map((attempt) => attempt.view.tools?.maxRisk ?? null)),
      },
    },
    { id: "ratchet-refused", count: refused.length, of: narrowing.length, evidence: {} },
    {
      id: "candidate-limit",
      count: limited.length,
      of: withSkills.length,
      evidence: {
        eligible: statsOf(known(limited.map((attempt) => attempt.view.skills?.eligible ?? null))),
        maxCandidates: sortedDistinct(limited.map((attempt) => attempt.view.skills?.maxCandidates ?? null)),
      },
    },
    {
      id: "application-failed",
      count: applyFailed.length,
      of: withApplication.length,
      evidence: {
        errors: tally(applyFailed.map((attempt) => attempt.view.application?.error ?? "unknown")),
        restoration: tally(applyFailed.map((attempt) => attempt.view.application?.restoration ?? "none")),
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Decisions and classifier
// ---------------------------------------------------------------------------

type SelectionRow = "none" | "narrow" | "keep-baseline";

/** Where a proposal sits in the cross-tab of what was proposed against what happened. */
const rowOf = (view: DecisionView): SelectionRow =>
  view.tools === null ? "none" : view.tools.active !== null ? "narrow" : "keep-baseline";

const statusOf = (view: DecisionView): string => view.application?.status ?? "unknown";

function summarizeDecisions(
  all: readonly DecisionEvent[],
  attempts: readonly DecisionEvent[],
  blockers: Record<LeadId, number>,
): DecisionsSummary {
  const views = attempts.map((attempt) => attempt.view);
  const withTools = views.flatMap((view) => (view.tools === null ? [] : [view.tools]));
  const narrowing = withTools.flatMap((tools) => (tools.active === null ? [] : [tools.active]));
  const select = (row: SelectionRow): Count => tally(views.filter((view) => rowOf(view) === row).map(statusOf));
  const outcomes = { classified: 0, failed: 0, skipped: 0 };
  for (const event of all) outcomes[event.view.outcome]++;
  return {
    total: all.length,
    outcomes,
    versions: {
      v2: all.filter((event) => event.view.version === 2).length,
      v3: all.filter((event) => event.view.version === 3).length,
    },
    branch: branches(all),
    skips: tally(all.filter((event) => event.view.outcome === "skipped").map((event) => event.view.skip ?? "unknown")),
    sessions: new Set(attempts.map((attempt) => attempt.where.file)).size,
    dryRun: threeWay(views.map((view) => view.dryRun)),
    failures: tally(views.filter((view) => view.outcome === "failed").map((view) => view.failure ?? "unknown")),
    latencyMs: statsOf(known(views.map((view) => view.latencyMs))),
    proposals: {
      tools: withTools.length,
      none: views.length - withTools.length,
      narrowing: narrowing.length,
      keepBaseline: withTools.length - narrowing.length,
      profiles: tally(views.map((view) => view.tools?.profile ?? "(none)")),
      reasons: tally(views.map((view) => view.tools?.reason ?? "failed")),
      proposedTools: statsOf(narrowing.map((active) => active.length)),
      risk: statsOf(known(withTools.map((tools) => tools.risk))),
    },
    application: {
      statuses: tally(views.map(statusOf)),
      actualTools: statsOf(
        views.flatMap((view) => (view.application?.actualTools == null ? [] : [view.application.actualTools.length])),
      ),
    },
    selection: { narrow: select("narrow"), "keep-baseline": select("keep-baseline"), none: select("none") },
    ratchet: {
      blocked: views.filter((view) => view.ratchet?.admitted === false).length,
      admitted: views.filter((view) => view.ratchet?.admitted === true).length,
      unknown: views.filter((view) => (view.ratchet?.admitted ?? null) === null).length,
    },
    skills: {
      reasons: tally(views.map((view) => view.skills?.reason ?? "failed")),
      selected: tally(
        views.flatMap((view) => {
          const selected = view.skills?.selected;
          if (selected === undefined || selected === null) return [];
          return selected.length === 0 ? ["(none)"] : selected;
        }),
      ),
      candidateLimit: views.filter((view) => view.skills?.reason === "too-many-candidates").length,
      delivery: tally(views.map((view) => view.skills?.delivery ?? "unknown")),
    },
    blockers,
  };
}

function summarizeClassifier(attempts: readonly DecisionEvent[]): ClassifierSummary {
  const evidence = attempts.flatMap((attempt) => (attempt.view.classifier === null ? [] : [attempt.view.classifier]));
  const servers = evidence.flatMap((item) => (item.server === null ? [] : [item.server]));
  return {
    attempts: attempts.length,
    evidence: evidence.length,
    guardFired: threeWay(attempts.map((attempt) => attempt.view.classifier?.guardFired ?? null)),
    tokens: {
      input: sumOf(attempts.map((attempt) => attempt.view.classifier?.usage?.inputTokens ?? null)),
      output: sumOf(attempts.map((attempt) => attempt.view.classifier?.usage?.outputTokens ?? null)),
    },
    server: {
      reported: servers.length,
      unreported: attempts.length - servers.length,
      queueMs: statsOf(known(servers.map((server) => server.queueMs))),
      inferenceMs: statsOf(known(servers.map((server) => server.inferenceMs))),
    },
    models: tally(attempts.map((attempt) => attempt.view.classifier?.model ?? "unknown")),
    requestIds: {
      present: attempts.filter((attempt) => attempt.view.classifier?.requestId != null).length,
      absent: attempts.filter((attempt) => attempt.view.classifier?.requestId == null).length,
    },
    promptClipped: threeWay(
      attempts.map((attempt) => {
        const prompt = attempt.view.classifier?.promptChars ?? null;
        const sent = attempt.view.classifier?.sentChars ?? null;
        return prompt === null || sent === null ? null : prompt > sent;
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Header and summary
// ---------------------------------------------------------------------------

/** The part of a summary and of an export that describes what was read: scope, filters and coverage. */
export function buildHeader(input: ReportInput): { scope: ScopeInfo; filters: FilterInfo; coverage: Coverage } {
  const { scope, selection, filtered, filters } = input;
  const historical = scope.kind === "historical" ? scope : null;
  const files = filtered.files;
  const identifiable = [...filtered.decisions.filter((event) => event.view.eventId !== null), ...filtered.usage];
  const provenance: Record<Provenance, number> = { origin: 0, inherited: 0, unknown: 0 };
  for (const event of identifiable) provenance[event.identity.provenance]++;
  return {
    scope: {
      kind: scope.kind,
      files: selection.files.length,
      nestedChildFiles: files.filter((file) => file.nestedChild).length,
      childFilesNotRead: selection.childFilesNotRead,
      childDirsUnreadable: selection.childDirsUnreadable,
      since: historical === null ? null : new Date(historical.since).toISOString(),
      until: historical === null ? null : new Date(historical.until).toISOString(),
      projects: historical === null ? null : historical.projects === null ? "all-projects" : "exact",
    },
    filters: {
      branch: filters.branch,
      outcome: {
        decision: filters.decision === null ? null : [...filters.decision],
        usage: filters.usage === null ? null : [...filters.usage],
      },
    },
    coverage: {
      files: {
        read: files.filter((file) => !file.unreadable).length,
        unreadable: files.filter((file) => file.unreadable).length + selection.unreadable,
        withoutHeader: files.filter((file) => !file.unreadable && !file.hasHeader).length,
        skippedByMtime: selection.skippedByMtime,
      },
      malformedLines: files.reduce((sum, file) => sum + file.malformedLines, 0),
      duplicatesRemoved: filtered.duplicatesRemoved,
      unidentifiable: { decisions: filtered.decisions.filter((event) => event.view.eventId === null).length },
      unsupported: {
        decisions: filtered.unsupported.filter((event) => event.family === "decision").length,
        usage: filtered.unsupported.filter((event) => event.family === "usage").length,
      },
      provenance,
      removedByFilters: filtered.removed,
    },
  };
}

export function summarize(input: ReportInput): Summary {
  const { filtered, service } = input;
  const attempts = filtered.decisions.filter((event) => event.view.outcome !== "skipped");
  const join = service === null ? null : joinService(attempts, service);
  const candidates = leadCandidates(attempts, join === null ? null : join.pairs);
  const blockers: Record<LeadId, number> = {
    "classifier-failed": 0,
    "low-confidence": 0,
    "ratchet-refused": 0,
    "candidate-limit": 0,
    "application-failed": 0,
  };
  for (const lead of candidates) blockers[lead.id] = lead.count;
  return {
    schema: "loadout-report.summary/1",
    ...buildHeader(input),
    decisions: summarizeDecisions(filtered.decisions, attempts, blockers),
    classifier: summarizeClassifier(attempts),
    usage: summarizeUsage(filtered.usage),
    transcript: transcriptTotals(filtered.turns, filtered.toolResults, filtered.usageFiltered),
    http: join === null ? null : join.http,
    leads: candidates.filter((lead) => lead.count > 0).sort((a, b) => b.count - a.count || byText(a.id, b.id)),
    disclosures: DISCLOSURES,
  };
}

/**
 * The shareable export: one document of content-free events plus the same scope, filter and coverage header a
 * summary carries.
 *
 * Every event is rebuilt from a declared allowlist, so a field nobody listed cannot leave the process, whatever a
 * record, a transcript or a service log contained. The normalizers in `telemetry.ts` already validated each value
 * at the source; the allowlist is the second, independent gate. It exports identifier-shaped values from
 * identifier fields exactly as a record carries them: session, event, decision, run, request and host-entry ids,
 * model ids, profile, tool and skill names, and an HTTP error class. Nothing else leaves: no path, title, message,
 * tool argument or result, and no id of the transcript itself (the reporter never adds a session file's header id,
 * or the entry and parent ids it reads for branch labels).
 */

import { type Branch, isObject, IDENTIFIER, parseInstant, type Provenance } from "./read.ts";
import {
  buildHeader,
  type Coverage,
  DISCLOSURES,
  type FilterInfo,
  joinService,
  type ReportInput,
  type ScopeInfo,
} from "./summary.ts";

/** What to keep of a value. `true` keeps a scalar, or an array of them; `"map"` keeps identifier keys with finite numbers. */
export type Allow = true | "map" | readonly [Allow] | { readonly [key: string]: Allow };

export interface ExportEvent {
  type: "decision" | "usage" | "http";
  /** ISO UTC from the host entry's timestamp, or the service record's own `at`; null when unknown. */
  at: string | null;
  /** Null for a service record: it belongs to no transcript. */
  branch: Branch | null;
  provenance: Provenance | null;
  /** Duplicate instances of the record that were discarded. */
  copies: number | null;
  record: Record<string, unknown>;
}

export interface ExportDoc {
  schema: "loadout-report.export/1";
  scope: ScopeInfo;
  filters: FilterInfo;
  coverage: Coverage;
  /** Records read against records exported; null without a service log. Only a joined record is exported. */
  http: { records: number; exported: number } | null;
  disclosures: readonly string[];
  events: ExportEvent[];
}

const isList = (allow: Allow): allow is readonly [Allow] => Array.isArray(allow);

const scalar = (value: unknown): string | number | boolean | null =>
  typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
    ? value
    : null;

function numberMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    if (IDENTIFIER.test(key) && typeof item === "number" && Number.isFinite(item)) out[key] = item;
  }
  return out;
}

/** Rebuild `value` to the shape of `allow`: unlisted keys are dropped, a missing or mistyped value is null. */
export function pick(value: unknown, allow: Allow): unknown {
  if (allow === true) return Array.isArray(value) ? value.map(scalar) : scalar(value);
  if (allow === "map") return numberMap(value);
  if (isList(allow)) return Array.isArray(value) ? value.map((item) => pick(item, allow[0])) : null;
  if (!isObject(value)) return null;
  return Object.fromEntries(Object.entries(allow).map(([key, rule]) => [key, pick(value[key], rule)]));
}

export const DECISION: Allow = {
  version: true,
  eventId: true,
  decisionId: true,
  sessionId: true,
  outcome: true,
  skip: true,
  failure: true,
  backend: true,
  dryRun: true,
  latencyMs: true,
  settings: {
    enabled: true,
    backend: true,
    transport: true,
    dryRun: true,
    notify: true,
    maxPromptChars: true,
    configScope: true,
    tools: { enabled: true, maxRisk: true },
    skills: { enabled: true, mode: true, threshold: true, maxSkills: true, maxCandidates: true },
  },
  classifier: {
    requestId: true,
    model: true,
    elapsedMs: true,
    budgetMs: true,
    timeoutMs: true,
    guardFired: true,
    usage: { inputTokens: true, outputTokens: true },
    server: { queueMs: true, inferenceMs: true },
    status: true,
    promptChars: true,
    sentChars: true,
    questions: true,
  },
  tools: {
    reason: true,
    profile: true,
    active: true,
    probabilities: "map",
    risk: true,
    risks: [{ profile: true, risk: true }],
    maxRisk: true,
  },
  skills: {
    reason: true,
    selected: true,
    scores: "map",
    discovered: true,
    eligible: true,
    maxCandidates: true,
    asked: true,
    filteredOut: true,
    delivery: true,
  },
  ratchet: { narrowAllowed: true, before: true, after: true, admitted: true },
  application: { status: true, restoration: true, actualTools: true, error: true },
};

export const USAGE: Allow = {
  v: true,
  eventId: true,
  sessionId: true,
  runId: true,
  decisionId: true,
  turnIndex: true,
  host: true,
  hostEntryId: true,
  stopReason: true,
  tokens: { input: true, output: true, cacheRead: true, cacheWrite: true, reasoning: true },
  costTotal: true,
  toolCalls: "map",
  toolErrors: true,
  errorStatus: true,
  retryAttempt: true,
};

export const HTTP: Allow = {
  type: true,
  v: true,
  requestId: true,
  idStatus: true,
  at: true,
  outcome: true,
  status: true,
  queueMs: true,
  inferenceMs: true,
  totalMs: true,
  errorClass: true,
};

const iso = (epochMs: number | null): string | null => (epochMs === null ? null : new Date(epochMs).toISOString());

function asRecord(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

export function exportDocument(input: ReportInput): ExportDoc {
  const { filtered, service } = input;
  const attempts = filtered.decisions.filter((event) => event.view.outcome !== "skipped");
  const join = service === null ? null : joinService(attempts, service);

  const decisions = filtered.decisions.map(
    (event): ExportEvent => ({
      type: "decision",
      at: iso(event.where.at),
      branch: event.where.branch,
      provenance: event.identity.provenance,
      copies: event.identity.copies,
      record: asRecord(pick(event.view, DECISION)),
    }),
  );
  const usage = filtered.usage.map(
    (event): ExportEvent => ({
      type: "usage",
      at: iso(event.where.at),
      branch: event.where.branch,
      provenance: event.identity.provenance,
      copies: event.identity.copies,
      record: asRecord(pick(event.record, USAGE)),
    }),
  );
  // A service record has no file or line; its own timestamp orders it, and ties keep the log order.
  const http = (join === null ? [] : join.joined)
    .map((record) => ({ record, at: parseInstant(record.at) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.at - b.at)
    .map(
      ({ record }): ExportEvent => ({
        type: "http",
        at: record.at,
        branch: null,
        provenance: null,
        copies: null,
        record: asRecord(pick(record, HTTP)),
      }),
    );

  return {
    schema: "loadout-report.export/1",
    ...buildHeader(input),
    http: service === null || join === null ? null : { records: service.records.length, exported: join.joined.length },
    disclosures: DISCLOSURES,
    events: [...decisions, ...usage, ...http],
  };
}

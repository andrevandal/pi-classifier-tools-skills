/**
 * The plugin's words for what it did, in one place: the per-turn notice and the text of `/loadout status`, `explain`
 * and `stats`. Pure: a record and a few counters in, text out. Nothing here reads a file, the environment or a
 * clock, and nothing counts anything from disk (`/loadout stats` prints what `src/report/` counted).
 *
 * One vocabulary everywhere. The word `applied` belongs to a change that was applied and to nothing else: a dry run,
 * a ratchet block and a low-confidence answer say what was proposed and why nothing changed. An unknown value reads
 * `unknown` or `not reported`, never `0`. Nothing here advises; it describes.
 */

import { renderSummary } from "./report/text.ts";
import type { Summary } from "./report/summary.ts";
import type { DecisionOutcome, DecisionRecordV3, PersistResult, ToolsRecord } from "./telemetry.ts";
import type { LoadoutConfig, TelemetryReason, TelemetryState } from "./types.ts";

/** What the plugin kept of the latest hook call. Memory only. */
export interface Observation {
  /** Null when the hook ran but no record could be built. */
  record: DecisionRecordV3 | null;
  /** Failure text of that call; never persisted. */
  message: string | null;
  /** `{ outcome: "failed", code: "error" }` when no record was built. */
  stored: PersistResult;
}

export interface CollectionCounters {
  handedOff: number;
  suppressed: number;
  failed: number;
  lastFailure: string | null;
}

export interface StatusInput {
  config: LoadoutConfig;
  source: string | null;
  scope: "project" | "global" | "explicit" | null;
  telemetry: TelemetryState;
  collection: CollectionCounters;
  baseline: readonly string[] | null;
  lastRecord: DecisionRecordV3 | null;
  latest: Observation | null;
  seen: Record<DecisionOutcome, number>;
  modelTurns: number;
}

export interface ExplainInput {
  latest: Observation | null;
  lastRecord: DecisionRecordV3 | null;
  baselineSize: number | undefined;
  telemetry: TelemetryState;
}

export interface StatsInput {
  summary: Summary;
  /** Whether the report covers exactly this session's file, so it can be set beside this process's own counters. */
  compare: boolean;
  telemetry: TelemetryState;
  collection: CollectionCounters;
}

/** The delivered notice is `[loadout] ` plus this, so it stays within one terminal line. */
const NOTICE_MAX = 150;
const FAILURE_TEXT_MAX = 200;

const two = (value: number): string => value.toFixed(2);
const millis = (value: number): string => String(Number(value.toFixed(1)));
const names = (list: readonly string[]): string => (list.length === 0 ? "none" : list.join(", "));
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const phase = (value: number | null): string => (value === null ? "not reported" : `${millis(value)} ms`);

// ---------------------------------------------------------------------------
// Headline
// ---------------------------------------------------------------------------

/** The smallest known risk among the narrower profiles, or null when none is known. */
function closestRisk(tools: ToolsRecord): number | null {
  const known = (tools.risks ?? []).flatMap(({ risk }) => (risk === null ? [] : [risk]));
  return known.length === 0 ? null : Math.min(...known);
}

/** Why the tools stayed as they were when no narrower profile was proposed. */
function keepText(tools: ToolsRecord): string {
  switch (tools.reason) {
    case "low-confidence": {
      const closest = closestRisk(tools);
      return closest === null
        ? "low confidence (no risk known)"
        : `low confidence (closest narrower risk ${two(closest)} > max ${two(tools.maxRisk)})`;
    }
    case "missing-answer":
      return "no answer to the tool question";
    case "disabled":
      return "tool selection off";
    default:
      return "baseline";
  }
}

function classifiedHeadline(record: DecisionRecordV3, baselineSize: number | undefined): string {
  const { tools, application } = record;
  if (tools === null) return `proposed nothing (application ${application.status})`;
  const profile = tools.profile ?? "a narrower set";
  const keep = keepText(tools);
  const active = tools.active !== null;
  const actual = application.actualTools?.length;
  const size =
    actual === undefined ? "" : ` (tools ${actual}${baselineSize === undefined ? "" : ` of ${baselineSize}`})`;
  switch (application.status) {
    case "applied":
      return active ? `applied ${profile}${size}` : `applied: baseline restored (${keep})`;
    case "unchanged":
      return active ? `already matching ${profile}${size}` : `all tools kept: ${keep}`;
    case "restored":
    case "not-attempted":
      if (!active) return `all tools kept: ${keep}`;
      break;
    case "dry-run":
      if (tools.active === null) return `dry run: would keep all tools (${keep})`;
      // The ratchet is evaluated in a dry run too, so a proposal it would refuse is not offered as the proposal.
      return record.ratchet?.admitted === false
        ? `dry run: widen-only would keep ${record.ratchet.before ?? "the current tools"}, not ${profile}; nothing changed`
        : `dry run: would use ${profile} (tools ${tools.active.length}), nothing changed`;
    case "not-admitted":
      return `kept ${record.ratchet?.before ?? "the current tools"}: widen-only blocked narrowing to ${profile}`;
    case "failed": {
      const restore =
        application.restoration === "restored"
          ? ", baseline restored"
          : application.restoration === "failed"
            ? ", baseline restore failed"
            : "";
      return `could not apply ${(active ? tools.profile : null) ?? "tools"}: ${application.error ?? "error"}${restore}`;
    }
  }
  return `proposed ${tools.profile ?? "nothing"} (application ${application.status})`;
}

/** What happened to the skills, appended to a classified headline; empty when there is nothing to add. */
function skillsSuffix(record: DecisionRecordV3): string {
  const { skills } = record;
  switch (skills?.reason) {
    case "too-many-candidates":
      return `; skills: ${skills.eligible} candidates > limit ${skills.maxCandidates}, none asked`;
    case "selected": {
      const picked = skills.selected?.length ?? 0;
      return record.application.status === "dry-run"
        ? `; skills: would select ${picked}`
        : `; skills: ${picked} selected`;
    }
    case "missing-answer":
      return "; skills: no answer";
    default:
      return "";
  }
}

function skippedHeadline(record: DecisionRecordV3): string {
  switch (record.skip) {
    case "disabled":
      return "skipped: selection is off";
    case "empty-prompt":
      return "skipped: empty prompt";
    case "command":
      return "skipped: slash command, not classified";
    case "no-questions": {
      const { skills } = record;
      const over =
        skills?.reason === "too-many-candidates"
          ? ` (${skills.eligible} candidates > limit ${skills.maxCandidates})`
          : "";
      return `skipped: nothing to ask${over}`;
    }
    default:
      return "skipped";
  }
}

function failedHeadline(record: DecisionRecordV3): string {
  const evidence = record.classifier;
  if (record.failure === "warming") return "classifier still loading; full loadout kept";
  if (record.failure === "timeout") {
    return evidence === null
      ? "classification failed: timeout"
      : `classification failed: timeout after ${millis(evidence.elapsedMs)} ms (budget ${millis(evidence.budgetMs)} ms${evidence.guardFired ? ", guard fired" : ""})`;
  }
  const status = evidence?.status == null ? "" : ` (HTTP ${evidence.status})`;
  const after = evidence === null ? "" : ` after ${millis(evidence.elapsedMs)} ms`;
  return `classification failed: ${record.failure ?? "error"}${status}${after}`;
}

/** One line saying what the invocation came to, with no prefix. `baselineSize` is the caller's, when it has one. */
export function headline(record: DecisionRecordV3, baselineSize?: number): string {
  if (record.outcome === "skipped") return skippedHeadline(record);
  if (record.outcome === "failed") return failedHeadline(record);
  return `${classifiedHeadline(record, baselineSize)}${skillsSuffix(record)}`;
}

/**
 * The per-turn notice: the headline of a classified turn whose application did not fail, cut to one short line.
 * A skip gets none, and a failed classification or application keeps its own warning.
 */
export function noticeText(record: DecisionRecordV3, baselineSize?: number): string | null {
  if (record.outcome !== "classified" || record.application.status === "failed") return null;
  const text = headline(record, baselineSize);
  return text.length > NOTICE_MAX ? `${text.slice(0, NOTICE_MAX - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function backendText(config: LoadoutConfig): string {
  return config.backend === "laya" ? `laya (${config.laya.transport})` : "jev";
}

function provenance(reason: TelemetryReason, scope: StatusInput["scope"]): string {
  switch (reason) {
    case "machine-off":
      return "hard machine-wide override in ~/.omp/loadout.*; no project, session or LOADOUT_CONFIG setting can turn it back on";
    case "machine-unreadable":
      return "the machine setting in ~/.omp/loadout.* could not be read; nothing is recorded (fail closed)";
    case "config-error":
      return "the config has an error; nothing is recorded until it is fixed and the session restarts";
    case "config-off":
      return `the effective config (${scope ?? "built-in defaults"}) sets telemetry false`;
    default:
      return "records are not being written";
  }
}

/**
 * The settings in force and what this process has seen. Prints no endpoint, variable name, Python path or question
 * text. The `config:` line is the config file's path as the loader resolved it, an absolute path.
 */
export function statusText(input: StatusInput): string {
  const { config, telemetry, collection, latest, lastRecord, seen } = input;
  const size = input.baseline?.length;
  const timeoutMs = config.backend === "laya" ? config.laya.timeoutMs : config.jev.timeoutMs;
  const tools = config.tools.enabled
    ? `profiles ${Object.keys(config.tools.profiles).join(", ")} (max risk ${two(config.tools.maxRisk)})`
    : "off";
  const lines = [
    "[loadout] status",
    `  selection: ${config.enabled ? "enabled" : "disabled"} | dry run ${config.dryRun ? "on" : "off"} | notices ${config.notify ? "on" : "off"}`,
    `  classifier: ${backendText(config)} | timeout ${timeoutMs} ms`,
    `  config: ${input.source ?? "built-in defaults"}${input.scope === null ? "" : ` (${input.scope})`}`,
    `  tools: ${tools} | skills: ${config.skills.enabled ? config.skills.mode : "off"}`,
    `  baseline tools: ${input.baseline === null ? "not captured yet" : `${input.baseline.join(", ")} (${input.baseline.length})`}`,
    `  last decision: ${lastRecord === null ? "none yet" : headline(lastRecord, size)}`,
  ];
  if (latest !== null) {
    if (latest.record === null) {
      const code = latest.stored.outcome === "failed" ? latest.stored.code : "error";
      lines.push(`  latest invocation: no record could be built (${code})`);
    } else if (latest.record.outcome === "skipped") {
      lines.push(`  latest invocation: ${headline(latest.record, size)}`);
    }
  }
  if (telemetry.persist) {
    const last = collection.lastFailure === null ? "" : ` (${collection.lastFailure})`;
    lines.push(
      `  telemetry: on (${telemetry.reason}) | records handed to host ${collection.handedOff} | failed ${collection.failed}${last}`,
    );
  } else {
    lines.push(`  telemetry: off (${telemetry.reason}) | records suppressed ${collection.suppressed}`);
    lines.push(`  provenance: ${provenance(telemetry.reason, input.scope)}`);
  }
  const prompts = seen.classified + seen.failed + seen.skipped;
  lines.push(
    `  this session: prompts observed ${prompts} (classified ${seen.classified}, failed ${seen.failed}, skipped ${seen.skipped}) | model turns observed ${input.modelTurns} | memory only, this session in this process`,
    "  not included: child and subagent sessions (each has its own plugin instance and records)",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Explain
// ---------------------------------------------------------------------------

function storedText(latest: Observation, telemetry: TelemetryState): string {
  const { stored } = latest;
  if (latest.record === null)
    return `no record could be built (${stored.outcome === "failed" ? stored.code : "error"})`;
  if (stored.outcome === "handed-off") return "record handed to host";
  if (stored.outcome === "suppressed") return `record not stored: telemetry off (${telemetry.reason})`;
  return `record not stored: ${stored.code}`;
}

function toolsLine(tools: ToolsRecord): string {
  switch (tools.reason) {
    case "selected":
      return `tools: selected ${tools.profile ?? "a narrower set"} (risk ${tools.risk === null ? "unknown" : two(tools.risk)} <= max risk ${two(tools.maxRisk)})`;
    case "low-confidence":
      return `tools: low confidence, no profile within max risk ${two(tools.maxRisk)}`;
    case "missing-answer":
      return "tools: no answer to the tool question";
    default:
      return "tools: selection off";
  }
}

/** One row per narrower profile, narrowest first, then the broadest: the baseline, which carries no risk of its own. */
function profileRows(tools: ToolsRecord): string[] {
  if (tools.risks === null) return ["    risks: unknown (no probability in the answer)"];
  const rows = tools.risks.map(({ profile, risk }) => {
    const p = tools.probabilities[profile];
    const gate = risk === null ? "unknown" : `${two(risk)} ${risk <= tools.maxRisk ? "<=" : ">"} ${two(tools.maxRisk)}`;
    const chosen = tools.reason === "selected" && tools.profile === profile ? " <- chosen" : "";
    return `    ${profile}: p ${p === undefined ? "unknown" : two(p)}, risk ${gate}${chosen}`;
  });
  const narrower = new Set(tools.risks.map(({ profile }) => profile));
  for (const [profile, p] of Object.entries(tools.probabilities)) {
    if (!narrower.has(profile)) rows.push(`    ${profile}: p ${two(p)} (broadest, the baseline)`);
  }
  return rows;
}

/** What kept the proposal from changing the tools, in a fixed order. */
function blockers(record: DecisionRecordV3, tools: ToolsRecord): string[] {
  const { application, skills } = record;
  const found = [
    application.status === "dry-run" ? "dry run" : null,
    record.ratchet?.admitted === false
      ? `widen-only ratchet (${application.status === "dry-run" ? "would keep" : "kept"} ${record.ratchet.before ?? "the current tools"})`
      : null,
    tools.reason === "low-confidence" ? "low confidence" : null,
    tools.reason === "missing-answer" ? "no tool answer" : null,
    skills?.reason === "too-many-candidates" ? "skills over the candidate limit" : null,
  ];
  return found.filter((text) => text !== null);
}

function skillsLine(skills: NonNullable<DecisionRecordV3["skills"]>): string {
  const counts = `discovered ${skills.discovered}, eligible ${skills.eligible}`;
  switch (skills.reason) {
    case "disabled":
      return `skills: selection off (${counts})`;
    case "no-candidates":
      return `skills: none eligible (discovered ${skills.discovered})`;
    case "too-many-candidates":
      return `skills: ${skills.eligible} eligible > limit ${skills.maxCandidates} (discovered ${skills.discovered}): none asked, all skills kept`;
    case "missing-answer":
      return `skills: asked ${skills.asked}, no usable answer: all skills kept`;
    case "selected": {
      const hidden = skills.filteredOut === null ? "" : ` (${skills.filteredOut} hidden)`;
      const best = Object.entries(skills.scores)
        .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, 5)
        .map(([name, score]) => `${name} ${two(score)}`);
      return `skills: asked ${skills.asked}, selected ${names(skills.selected ?? [])} | delivery ${skills.delivery}${hidden} | scores ${names(best)}`;
    }
    default:
      return `skills: not evaluated (${counts})`;
  }
}

/** The classifier call: what was asked, what it cost in time, and what the server reported. */
function classifierLines(record: DecisionRecordV3): string[] {
  const evidence = record.classifier;
  if (evidence === null) return record.outcome === "failed" ? ["  classifier: no call recorded"] : [];
  const asked = record.skills?.asked ?? 0;
  const { questions } = evidence;
  const clipped = evidence.promptChars > evidence.sentChars ? "clipped" : "not clipped";
  const usage = evidence.usage;
  const tokens =
    usage === null
      ? "tokens not reported"
      : `tokens in ${usage.inputTokens ?? "unknown"}, out ${usage.outputTokens ?? "unknown"}`;
  const server =
    evidence.server === null
      ? "server: not reported"
      : `server: queue ${phase(evidence.server.queueMs)}, inference ${phase(evidence.server.inferenceMs)}`;
  const http = evidence.status === null ? "" : ` | HTTP ${evidence.status}`;
  // Only the Laya HTTP transport puts the id on the wire; for any other transport it is a label no server ever saw.
  const request =
    evidence.requestId === null
      ? "none"
      : record.settings.transport === "http"
        ? evidence.requestId
        : `${evidence.requestId} (not sent)`;
  return [
    `  classifier: ${questions} question${questions === 1 ? "" : "s"} (tools ${Math.max(0, questions - asked)}, skills ${asked}) | prompt ${evidence.promptChars} chars, sent ${evidence.sentChars} (${clipped}) | model ${evidence.model ?? "unknown"} | ${tokens}`,
    `  timing: ${millis(evidence.elapsedMs)} ms of ${millis(evidence.budgetMs)} ms budget (timeout ${millis(evidence.timeoutMs)} ms), guard ${evidence.guardFired ? "fired" : "not fired"}${http}`,
    `  ${server} | request ${request}`,
  ];
}

function applicationLine(record: DecisionRecordV3): string {
  const { application } = record;
  const restore = application.restoration === null ? "" : ` (restore: ${application.restoration})`;
  const error = application.error === null ? "" : ` [${application.error}]`;
  const actual =
    application.actualTools === null
      ? "unknown"
      : `${names(application.actualTools)} (${application.actualTools.length})`;
  return `  application: ${application.status}${restore}${error} | actual tools: ${actual}`;
}

function settingsLine(record: DecisionRecordV3): string {
  const { settings } = record;
  const backend = settings.transport === null ? settings.backend : `${settings.backend} (${settings.transport})`;
  return `  settings then: dry run ${settings.dryRun ? "on" : "off"} | max risk ${two(settings.tools.maxRisk)} | ${backend} | skills ${settings.skills.enabled ? settings.skills.mode : "off"} | config ${settings.configScope}`;
}

/** The latest invocation of any outcome, from memory. Says where the record went, and never claims more than that. */
export function explainText(input: ExplainInput): string {
  const { latest, lastRecord, baselineSize, telemetry } = input;
  if (latest === null) return "[loadout] explain: nothing observed yet in this process";
  const { record } = latest;
  const lines = ["[loadout] explain: latest invocation", `  source: in memory | ${storedText(latest, telemetry)}`];
  const failure =
    latest.message === null
      ? []
      : [`  failure text (memory only, never stored): ${oneLine(latest.message).slice(0, FAILURE_TEXT_MAX)}`];
  const previous = (): string[] =>
    lastRecord === null ? [] : [`  previous decision: ${headline(lastRecord, baselineSize)}`];

  if (record === null) return [...lines, ...failure, ...previous()].join("\n");

  lines.push(`  outcome: ${headline(record, baselineSize)}`);
  const { tools, skills, ratchet } = record;
  if (tools !== null) {
    lines.push(`  ${toolsLine(tools)}`, ...profileRows(tools));
    lines.push(
      tools.active === null
        ? "  proposal: keep all tools (baseline)"
        : `  proposal: ${tools.profile ?? "a narrower set"}: ${names(tools.active)} (${tools.active.length})`,
    );
  }
  if (ratchet !== null) {
    lines.push(
      `  ratchet: ${ratchet.before ?? "-"} -> ${ratchet.after ?? "-"} (${ratchet.admitted ? "admitted" : "blocked"}, narrowing ${ratchet.narrowAllowed ? "open" : "locked"})`,
    );
  }
  lines.push(applicationLine(record));
  if (tools !== null) lines.push(`  blocked: ${names(blockers(record, tools))}`);
  if (skills !== null) lines.push(`  ${skillsLine(skills)}`);
  lines.push(...classifierLines(record), settingsLine(record), ...failure);
  if (record.outcome === "skipped") lines.push(...previous());
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** The report of `src/report/` as one block, headed by what this process itself handed to the host. */
export function statsText(input: StatsInput): string {
  const { summary, compare, telemetry, collection } = input;
  const lines = [`[loadout] stats: ${summary.scope.kind === "session" ? "session files" : "history"}`];
  if (telemetry.persist) {
    const last = collection.lastFailure === null ? "" : ` (${collection.lastFailure})`;
    lines.push(
      `  telemetry: on (${telemetry.reason}) | this process handed ${collection.handedOff} records to the host, failed ${collection.failed}${last}`,
    );
    if (compare) {
      lines.push(
        `  file: ${summary.decisions.total} decisions and ${summary.usage.turns} model-turn records were read here; this process handed ${collection.handedOff} to the host (earlier history, or records the host has not written yet, explain a difference)`,
      );
    }
  } else {
    lines.push(
      `  telemetry: off (${telemetry.reason}) | nothing from this process was stored (${collection.suppressed} suppressed); the figures cover records already in the files read`,
    );
  }
  for (const line of renderSummary(summary).split("\n")) lines.push(`  ${line}`);
  return lines.join("\n");
}

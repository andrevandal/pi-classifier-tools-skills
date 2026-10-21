/**
 * Loadout selector for pi and Oh My Pi (omp).
 *
 * Before each turn the prompt is classified by a System-One model (Jev over
 * HTTP, or Laya locally or on a shared host). One `choice` answer picks a tool
 * profile, and one `noul` answer per skill says whether that skill is relevant.
 * The turn then runs with only those tools active and only those skills shown.
 *
 * Nothing on this path may break a turn: any failure restores the session's
 * baseline tools and leaves skills alone.
 *
 * Host differences, detected structurally:
 * - pi exposes `event.systemPromptOptions`, so skills can be filtered out of
 *   the prompt. omp only exposes the rendered prompt, so skills are hinted with
 *   an injected message instead.
 * - `setActiveTools` is sync on pi and async on omp; awaiting covers both. On
 *   both hosts a call made inside `before_agent_start` applies to that turn.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createClassifier } from "./classify/index.ts";
import { loadConfig } from "./config.ts";
import {
  buildQuestions,
  decideSkills,
  isSlashCommand,
  profileOrder,
  skillCandidates,
  skillsAskable,
} from "./select.ts";
import {
  type ApplicationStatus,
  buildDecisionRecord,
  DECISION_ENTRY,
  type DecisionRecordV3,
  newId,
  type PersistResult,
  persistRecord,
  type RatchetRecord,
  type Restoration,
  safeErrorCode,
  type SkillDelivery,
  type SkipReason,
  settingsSnapshot,
  type ToolsRecord,
  USAGE_ENTRY,
} from "./telemetry.ts";
import { errorText, runTurn, type TurnOutcome } from "./turn.ts";
import type {
  Classifier,
  FailureReason,
  LoadoutConfig,
  SkillCandidate,
  SkillsDecision,
  SkillsReason,
  TelemetryState,
} from "./types.ts";
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
} from "./usage.ts";

const PREFIX = "[loadout]";
const COMMAND = "loadout";
const SUBCOMMANDS = ["status", "on", "off", "explain"] as const;
const HINT_MESSAGE = "loadout.skills";

/** The parts of the prompt event this extension reads; `systemPromptOptions` is pi-only. */
interface PromptEvent {
  prompt: string;
  systemPromptOptions?: { skills?: Array<{ name: string; description: string }> };
}

interface SessionState {
  cwd: string;
  projectTrusted: boolean;
  config: LoadoutConfig;
  source: string | null;
  scope: "project" | "global" | "explicit" | null;
  telemetry: TelemetryState;
  classifierKey: string;
  /** Whether this session counts as a user of the shared classifier for `classifierKey`. */
  holdsClassifier: boolean;
  /** Tools the user had active; every selection is a subset of this. */
  baseline: string[] | null;
  /** What this extension last activated, to notice changes made by anyone else. */
  lastApplied: string[] | null;
  /** Rank in `profileOrder` of the tools in force; the broadest is the baseline. Null before the first decision. */
  appliedRank: number | null;
  /** Whether the next decision may narrow: at the start, and again after compaction or `/loadout on|off`. */
  allowNarrow: boolean;
  /** Latest non-skipped record; a skip never replaces it. */
  lastRecord: DecisionRecordV3 | null;
  /** Failure text of `lastRecord`; memory only, never persisted. */
  lastMessage: string | null;
  /** The latest record built, skips included; null when building it threw. */
  lastDecisionId: string | null;
  /** Run and decision links for usage observations; session-local, carried across config reloads. */
  usage: UsageTracker;
  collection: { handedOff: number; suppressed: number; failed: number; lastFailure: string | null };
  /** Last failure already reported; repeats stay quiet until a turn succeeds. */
  lastFailure: string | null;
}

interface SharedClassifier {
  classifier: Classifier;
  users: number;
}

const sessions = new Map<string, SessionState>();
/** Keyed by backend config, so sessions with one config share one Laya sidecar. */
const classifiers = new Map<string, SharedClassifier>();

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The host's session id, or null when it has none; records never carry a made-up one. */
function hostSessionId(ctx: ExtensionContext): string | null {
  try {
    const id = ctx.sessionManager.getSessionId();
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

/** Map key only; records use `hostSessionId`. */
function sessionKey(ctx: ExtensionContext): string {
  return hostSessionId(ctx) ?? "unknown";
}

function readTools(pi: ExtensionAPI): string[] | null {
  try {
    return [...pi.getActiveTools()];
  } catch {
    return null;
  }
}

function isProjectTrusted(ctx: ExtensionContext): boolean {
  try {
    return typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted() === true;
  } catch {
    return false;
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((name) => set.has(name));
}

function notify(ctx: ExtensionContext, config: LoadoutConfig, message: string, level: "info" | "warning" | "error") {
  if (!config.notify && level === "info") return;
  try {
    ctx.ui.notify(`${PREFIX} ${oneLine(message)}`, level);
  } catch {
    // Notifications are best-effort; a headless host may not have a UI.
  }
}

function classifierKeyFor(config: LoadoutConfig): string {
  return JSON.stringify({ backend: config.backend, jev: config.jev, laya: config.laya });
}

function acquireClassifier(config: LoadoutConfig): Classifier {
  const key = classifierKeyFor(config);
  const shared = classifiers.get(key);
  if (shared) {
    shared.users++;
    return shared.classifier;
  }
  const classifier = createClassifier(config);
  classifiers.set(key, { classifier, users: 1 });
  if (classifier.warmup) void classifier.warmup().catch(() => {});
  return classifier;
}

function releaseClassifier(key: string): void {
  const shared = classifiers.get(key);
  if (!shared || --shared.users > 0) return;
  classifiers.delete(key);
  void shared.classifier.dispose().catch(() => {});
}

function classifierFor(state: SessionState): Classifier {
  if (!state.holdsClassifier) {
    state.holdsClassifier = true;
    return acquireClassifier(state.config);
  }
  return classifiers.get(state.classifierKey)!.classifier;
}

function dropClassifier(state: SessionState): void {
  if (!state.holdsClassifier) return;
  state.holdsClassifier = false;
  releaseClassifier(state.classifierKey);
}

/** Start a fresh ratchet: the next decision may narrow again. */
function resetRatchet(state: SessionState): void {
  state.appliedRank = null;
  state.allowNarrow = true;
}

/** Load (or reload, when cwd or project trust changed) this session's config. */
function ensureSession(ctx: ExtensionContext): SessionState {
  const key = sessionKey(ctx);
  const projectTrusted = isProjectTrusted(ctx);
  const existing = sessions.get(key);
  if (existing && existing.cwd === ctx.cwd && existing.projectTrusted === projectTrusted) return existing;

  const result = loadConfig(ctx.cwd, { projectTrusted, explicitPath: process.env.LOADOUT_CONFIG || undefined });
  for (const error of result.errors) notify(ctx, result.config, `config error: ${error}`, "error");
  for (const warning of result.warnings) notify(ctx, result.config, `config warning: ${warning}`, "warning");

  const classifierKey = classifierKeyFor(result.config);
  const keepClassifier = existing?.classifierKey === classifierKey && existing.holdsClassifier;
  if (existing && !keepClassifier) dropClassifier(existing);

  const state: SessionState = {
    cwd: ctx.cwd,
    projectTrusted,
    config: result.config,
    source: result.source,
    scope: result.scope,
    telemetry: result.telemetry,
    classifierKey,
    holdsClassifier: keepClassifier,
    baseline: existing?.baseline ?? null,
    lastApplied: existing?.lastApplied ?? null,
    lastRecord: existing?.lastRecord ?? null,
    lastMessage: existing?.lastMessage ?? null,
    lastDecisionId: existing?.lastDecisionId ?? null,
    usage: existing?.usage ?? createUsageTracker(),
    collection: existing?.collection ?? { handedOff: 0, suppressed: 0, failed: 0, lastFailure: null },
    // A config reload is not a new session: keep the ratchet, so a cwd change cannot reopen narrowing.
    appliedRank: existing?.appliedRank ?? null,
    allowNarrow: existing?.allowNarrow ?? true,
    lastFailure: null,
  };
  sessions.set(key, state);
  // Start Laya's multi-second weight load now rather than on the first prompt.
  if (state.config.enabled) classifierFor(state);
  return state;
}

/** Skills from the prompt options (pi), else from the host's skill commands (omp). */
function listSkills(pi: ExtensionAPI, event: PromptEvent): SkillCandidate[] {
  const fromPrompt = event.systemPromptOptions?.skills;
  if (Array.isArray(fromPrompt)) return fromPrompt.map(({ name, description }) => ({ name, description }));
  try {
    return pi
      .getCommands()
      .filter((command) => command.source === "skill")
      .map((command) => ({ name: command.name.replace(/^skill:/, ""), description: command.description ?? "" }));
  } catch {
    return [];
  }
}

/** True when the host's setter ran. */
async function activateTools(pi: ExtensionAPI, state: SessionState, tools: string[]): Promise<boolean> {
  const changed = !sameSet(pi.getActiveTools(), tools);
  if (changed) await pi.setActiveTools(tools);
  state.lastApplied = [...tools];
  return changed;
}

/**
 * Re-capture the baseline when the active tools are not what this extension
 * last set: the first turn, or a change made by the user or another extension.
 */
function refreshBaseline(pi: ExtensionAPI, state: SessionState): string[] {
  const current = pi.getActiveTools();
  if (state.baseline === null || state.lastApplied === null || !sameSet(current, state.lastApplied)) {
    state.baseline = current;
  }
  return state.baseline;
}

async function restoreBaseline(pi: ExtensionAPI, state: SessionState): Promise<"restored" | "unchanged" | null> {
  if (state.baseline === null || state.lastApplied === null) return null;
  return (await activateTools(pi, state, state.baseline)) ? "restored" : "unchanged";
}

function summarize(
  tools: Pick<ToolsRecord, "active" | "profile" | "risk" | "reason">,
  skills: { selected: string[] | null; reason: SkillsReason | null },
  baselineSize: number,
): string {
  const toolPart =
    tools.active === null
      ? `tools: all (${tools.reason})`
      : `tools: ${tools.profile} (risk ${tools.risk?.toFixed(2) ?? "-"}) -> ${tools.active.length}/${baselineSize}`;
  const skillPart =
    skills.selected === null
      ? `skills: all (${skills.reason})`
      : `skills: ${skills.selected.length > 0 ? skills.selected.join(", ") : "none"}`;
  return `${toolPart} | ${skillPart}`;
}

function describe(record: DecisionRecordV3, message: string | null, baselineSize: number): string {
  if (record.tools === null || record.skills === null) {
    return `failed (${record.failure ?? "error"}): ${message ?? "no details kept"}`;
  }
  return summarize(record.tools, record.skills, baselineSize);
}

/** The user-facing reason a turn fell back to the baseline. */
function failureNotice(failure: FailureReason, message: string | null): { text: string; level: "warning" | "error" } {
  if (failure === "warming") return { text: message ?? "classifier is still loading", level: "warning" };
  if (failure === "error") {
    return { text: `selection error: ${message}; using the full loadout until it recovers`, level: "error" };
  }
  const text = `classification failed (${failure}): ${message}; using the full loadout until it recovers`;
  return { text, level: "warning" };
}

function skillHint(selected: string[]): string {
  return [
    "Skills most relevant to this request, chosen by a classifier:",
    ...selected.map((name) => `- ${name}`),
    "Load the relevant ones before starting. Other listed skills are unlikely to apply.",
  ].join("\n");
}

/** Everything one hook call learns, so a record can be built after apply/restore whatever happened. */
interface HookTrace {
  decisionId: string;
  gate: SkipReason | null;
  turn: TurnOutcome | null;
  listed: boolean;
  discovered: number;
  eligible: number;
  asked: number;
  skillsDecision: SkillsDecision | null;
  delivery: SkillDelivery;
  filteredOut: number | null;
  ratchet: RatchetRecord | null;
  status: ApplicationStatus;
  restoration: Restoration | null;
  error: string | null;
  /** Failure text; kept in memory for /loadout explain, never in a record. */
  message: string | null;
}

type HookResult = { message: { customType: string; content: string; display: boolean } } | undefined;

async function runHook(
  pi: ExtensionAPI,
  event: PromptEvent,
  ctx: ExtensionContext,
  state: SessionState,
  trace: HookTrace,
): Promise<HookResult> {
  const { config } = state;
  const gate: SkipReason | null = !config.enabled
    ? "disabled"
    : event.prompt.trim() === ""
      ? "empty-prompt"
      : isSlashCommand(event.prompt)
        ? "command"
        : null;
  if (gate !== null) {
    trace.gate = gate;
    trace.restoration = await restoreBaseline(pi, state);
    trace.status = trace.restoration ?? "not-attempted";
    return;
  }

  const baseline = refreshBaseline(pi, state);
  const discovered = listSkills(pi, event);
  const candidates = skillCandidates(discovered, config.skills);
  trace.listed = true;
  trace.discovered = discovered.length;
  trace.eligible = candidates.length;
  const questions = buildQuestions(config, candidates);
  if (Object.keys(questions).length === 0) {
    trace.gate = "no-questions";
    trace.skillsDecision = decideSkills(config.skills, candidates, {});
    return;
  }
  trace.asked = skillsAskable(config.skills, candidates) ? candidates.length : 0;

  const turn = await runTurn({
    config,
    classifier: classifierFor(state),
    prompt: event.prompt,
    questions,
    baseline,
    candidates,
    persist: state.telemetry.persist,
  });
  trace.turn = turn;
  trace.message = turn.message;
  const { decision } = turn;
  trace.skillsDecision = decision?.skills ?? null;

  const order = profileOrder(config.tools);
  const broadest = order.length - 1;
  // A failed turn and a "don't know" turn both want the baseline, which is the broadest rank.
  const target = decision?.tools.active ? order.indexOf(decision.tools.profile ?? "") : broadest;
  const rankName = (rank: number | null): string | null =>
    config.tools.enabled && rank !== null ? (order[rank] ?? null) : null;
  const narrowAllowed = state.allowNarrow;
  const before = rankName(state.appliedRank);
  // Widen-only ratchet: once narrowed, a later turn may keep or widen the tools, never narrow them further.
  const admitted = state.allowNarrow || state.appliedRank === null || target >= state.appliedRank;
  if (admitted) {
    state.appliedRank = target;
    state.allowNarrow = false;
  }
  trace.ratchet = { narrowAllowed, before, after: rankName(state.appliedRank), admitted };

  if (decision === null) {
    const notice = failureNotice(turn.failure ?? "error", turn.message);
    if (notice.text !== state.lastFailure) {
      state.lastFailure = notice.text;
      notify(ctx, config, notice.text, notice.level);
    }
    trace.restoration = await restoreBaseline(pi, state);
    trace.status = trace.restoration ?? "not-attempted";
    return;
  }

  state.lastFailure = null;
  notify(
    ctx,
    config,
    `${config.dryRun ? "(dry run) " : ""}${summarize(decision.tools, decision.skills, baseline.length)}`,
    "info",
  );
  const selected = decision.skills.selected;
  if (config.dryRun) {
    trace.status = "dry-run";
    trace.delivery = selected === null ? "none" : "dry-run";
    return;
  }

  if (admitted) {
    trace.status = (await activateTools(pi, state, decision.tools.active ?? baseline)) ? "applied" : "unchanged";
  } else {
    trace.status = "not-admitted";
  }

  if (selected === null) return;
  const promptSkills = event.systemPromptOptions?.skills;
  const filter = config.skills.mode === "filter" || (config.skills.mode === "auto" && Array.isArray(promptSkills));
  if (filter && event.systemPromptOptions && Array.isArray(promptSkills)) {
    const keep = new Set([...selected, ...config.skills.exclude]);
    const kept = promptSkills.filter((skill) => keep.has(skill.name));
    // Reassign rather than splice: the array may be shared with the host's base prompt options.
    event.systemPromptOptions.skills = kept;
    trace.delivery = "filter";
    trace.filteredOut = promptSkills.length - kept.length;
    return;
  }
  if (selected.length === 0) return;
  trace.delivery = "hint";
  return { message: { customType: HINT_MESSAGE, content: skillHint(selected), display: false } };
}

function countRecord(ctx: ExtensionContext, state: SessionState, result: PersistResult): void {
  const { collection } = state;
  if (result.outcome === "handed-off") collection.handedOff++;
  else if (result.outcome === "suppressed") collection.suppressed++;
  else {
    collection.failed++;
    collection.lastFailure = result.code;
    if (collection.failed === 1) {
      const text = `telemetry record not stored (${result.code}); later failures are counted in /loadout status`;
      notify(ctx, state.config, text, "warning");
    }
  }
}

/** Build the record after apply/restore and hand it to the host once. Never throws. */
function recordDecision(pi: ExtensionAPI, ctx: ExtensionContext, state: SessionState | undefined, trace: HookTrace) {
  if (!state) return;
  try {
    const { turn } = trace;
    const { config } = state;
    const record = buildDecisionRecord({
      eventId: newId(),
      decisionId: trace.decisionId,
      sessionId: hostSessionId(ctx),
      settings: settingsSnapshot(config, state.scope),
      gate: trace.gate,
      failure: turn?.failure ?? null,
      classifier: turn?.classifier ?? null,
      decision: turn?.decision ?? null,
      order: profileOrder(config.tools),
      maxRisk: config.tools.maxRisk,
      skills: trace.listed
        ? {
            discovered: trace.discovered,
            eligible: trace.eligible,
            maxCandidates: config.skills.maxCandidates,
            asked: trace.asked,
            filteredOut: trace.filteredOut,
            delivery: trace.delivery,
            decision: trace.skillsDecision,
          }
        : null,
      ratchet: trace.ratchet,
      application: {
        status: trace.status,
        restoration: trace.restoration,
        actualTools: readTools(pi),
        error: trace.error,
      },
    });
    state.lastDecisionId = record.decisionId;
    if (record.outcome !== "skipped") {
      state.lastRecord = record;
      state.lastMessage = trace.message;
    }
    countRecord(
      ctx,
      state,
      persistRecord((type, data) => pi.appendEntry(type, data), state.telemetry, DECISION_ENTRY, record),
    );
  } catch {
    state.lastDecisionId = null;
    countRecord(ctx, state, { outcome: "failed", code: "error" });
  }
}

async function onBeforeAgentStart(pi: ExtensionAPI, event: PromptEvent, ctx: ExtensionContext) {
  const trace: HookTrace = {
    decisionId: newId(),
    gate: null,
    turn: null,
    listed: false,
    discovered: 0,
    eligible: 0,
    asked: 0,
    skillsDecision: null,
    delivery: "none",
    filteredOut: null,
    ratchet: null,
    status: "not-attempted",
    restoration: null,
    error: null,
    message: null,
  };
  let state: SessionState | undefined;
  let result: HookResult;
  try {
    state = ensureSession(ctx);
    result = await runHook(pi, event, ctx, state, trace);
  } catch (error) {
    if (!state) return; // fail closed: no record without a session
    trace.message = errorText(error);
    trace.status = "failed";
    trace.error = safeErrorCode(error);
    const text = `selection error: ${errorText(error)}; using the full loadout until it recovers`;
    if (text !== state.lastFailure) {
      state.lastFailure = text;
      notify(ctx, state.config, text, "error");
    }
    try {
      trace.restoration = await restoreBaseline(pi, state);
    } catch {
      trace.restoration = "failed";
    }
  }
  recordDecision(pi, ctx, state, trace);
  // The next run, or the next turn of an open one, belongs to this decision (null when none was built).
  if (state) armDecision(state.usage, state.lastDecisionId);
  return result;
}

function commandStatus(ctx: ExtensionContext, state: SessionState): void {
  const { config, collection } = state;
  const telemetry = state.telemetry.persist
    ? `on | handed to host ${collection.handedOff} | failed ${collection.failed}${collection.lastFailure ? ` (${collection.lastFailure})` : ""}`
    : `off (${state.telemetry.reason}) | suppressed ${collection.suppressed}`;
  const lines = [
    `${config.enabled ? "enabled" : "disabled"}${config.dryRun ? " (dry run)" : ""} | backend ${config.backend}`,
    `config: ${state.source ?? "built-in defaults"}`,
    `tools: ${config.tools.enabled ? `profiles ${Object.keys(config.tools.profiles).join(", ")}` : "off"} | skills: ${config.skills.enabled ? config.skills.mode : "off"}`,
    `baseline tools: ${state.baseline?.join(", ") ?? "not captured yet"}`,
    `last decision: ${state.lastRecord ? describe(state.lastRecord, state.lastMessage, state.baseline?.length ?? 0) : "none"}`,
    `telemetry: ${telemetry}`,
  ];
  for (const line of lines) ctx.ui.notify(`${PREFIX} ${line}`, "info");
}

function applicationLine(record: DecisionRecordV3): string {
  const { application } = record;
  const restore = application.restoration ? ` (restore: ${application.restoration})` : "";
  const error = application.error ? ` [${application.error}]` : "";
  return `application: ${application.status}${restore}${error} | actual tools: ${application.actualTools?.join(", ") ?? "unknown"}`;
}

function commandExplain(ctx: ExtensionContext, state: SessionState): void {
  const record = state.lastRecord;
  if (!record) {
    ctx.ui.notify(`${PREFIX} no decision yet`, "info");
    return;
  }
  const { tools, skills } = record;
  const latency = `latency: ${record.classifier?.elapsedMs ?? "-"}ms`;
  if (tools === null || skills === null) {
    const baselineSize = state.baseline?.length ?? 0;
    for (const line of [describe(record, state.lastMessage, baselineSize), latency, applicationLine(record)]) {
      ctx.ui.notify(`${PREFIX} ${line}`, "info");
    }
    return;
  }
  const scores = Object.entries(skills.scores)
    .sort(([, a], [, b]) => b - a)
    .map(([name, score]) => `${name}=${score.toFixed(2)}`)
    .join(", ");
  const probabilities = Object.entries(tools.probabilities)
    .sort(([, a], [, b]) => b - a)
    .map(([name, p]) => `${name}=${p.toFixed(2)}`)
    .join(", ");
  const risks = tools.risks?.map(({ profile, risk }) => `${profile}=${risk?.toFixed(2) ?? "-"}`).join(" ");
  const { ratchet } = record;
  const lines = [
    `tools: profile ${tools.profile ?? "-"} | risk ${tools.risk?.toFixed(2) ?? "-"} | reason ${tools.reason}`,
    `profile probabilities: ${probabilities || "none"}`,
    risks ? `risks: ${risks} (max ${tools.maxRisk.toFixed(2)})` : "risks: none",
    `proposed: ${tools.active?.join(", ") ?? "baseline"}`,
    ratchet
      ? `ratchet: ${ratchet.before ?? "-"} -> ${ratchet.after ?? "-"} (${ratchet.admitted ? "admitted" : "blocked"}, narrowing ${ratchet.narrowAllowed ? "open" : "locked"})`
      : "ratchet: none",
    applicationLine(record),
    `skills: reason ${skills.reason ?? "-"} | selected ${skills.selected?.join(", ") ?? "all"} | discovered ${skills.discovered} eligible ${skills.eligible} cap ${skills.maxCandidates} asked ${skills.asked}`,
    `skill scores: ${scores || "none"}`,
    latency,
  ];
  for (const line of lines) ctx.ui.notify(`${PREFIX} ${line}`, "info");
}

/** Usage bookkeeping for one lifecycle event: best effort, never throws into the host. */
function track(ctx: ExtensionContext, update: (usage: UsageTracker) => void): void {
  try {
    const state = sessions.get(sessionKey(ctx));
    if (state) update(state.usage);
  } catch {
    // Usage tracking must not affect the agent.
  }
}

/**
 * The names of the tools the host has registered. A tool name in a model message is model output, so only these may
 * reach a record. A registry that cannot be read counts as empty: the record is still written, without tool names.
 */
function registeredToolNames(pi: ExtensionAPI): ReadonlySet<string> {
  const names = new Set<string>();
  try {
    for (const tool of pi.getAllTools() as ReadonlyArray<{ name?: unknown } | null>) {
      if (typeof tool?.name === "string") names.add(tool.name);
    }
  } catch {
    return new Set();
  }
  return names;
}

/** One `loadout.usage` per assistant model turn. Returns nothing: pi reads a `turn_end` result as boundary entries. */
function onTurnEnd(pi: ExtensionAPI, event: unknown, ctx: ExtensionContext): void {
  const state = sessions.get(sessionKey(ctx));
  if (!state) return;
  try {
    const record = observeTurn(state.usage, hostSessionId(ctx), event, registeredToolNames(pi));
    if (!record) return;
    const append = (type: string, data: unknown) => pi.appendEntry(type, data);
    countRecord(ctx, state, persistRecord(append, state.telemetry, USAGE_ENTRY, record));
  } catch {
    countRecord(ctx, state, { outcome: "failed", code: "error" });
  }
}

export default function loadout(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    try {
      ensureSession(ctx);
    } catch {
      // A broken config is reported on the next prompt; the session must start.
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const key = sessionKey(ctx);
    const state = sessions.get(key);
    if (!state) return;
    sessions.delete(key);
    dropClassifier(state);
  });

  pi.on("session_compact", (_event, ctx) => {
    // Compaction summarizes the history, so the next decision may narrow again.
    const state = sessions.get(sessionKey(ctx));
    if (!state) return;
    state.allowNarrow = true;
    // The usage run ends too; a pending decision stays because omp compacts between the hook and the run.
    endRun(state.usage);
  });

  pi.on("before_agent_start", (event, ctx) => onBeforeAgentStart(pi, event as PromptEvent, ctx));

  // Usage observation. Handlers are best effort and return nothing.
  pi.on("agent_start", (_event, ctx) => track(ctx, startRun));
  pi.on("turn_start", (_event, ctx) => track(ctx, openTurn));
  pi.on("message_start", (event, ctx) => track(ctx, (usage) => deliverMessage(usage, event)));
  pi.on("turn_end", (event, ctx) => onTurnEnd(pi, event, ctx));
  pi.on("agent_end", (_event, ctx) => track(ctx, dropArmed));
  pi.on("session_tree", (_event, ctx) => track(ctx, endContext));
  // omp-only events: pi's typed `on` does not list them and pi never emits them.
  const onHost = pi.on.bind(pi) as unknown as (
    event: string,
    handler: (event: unknown, ctx: ExtensionContext) => void,
  ) => void;
  onHost("auto_retry_start", (event, ctx) =>
    track(ctx, (usage) => noteRetry(usage, (event as { attempt?: unknown } | null)?.attempt)),
  );
  onHost("auto_retry_end", (_event, ctx) => track(ctx, clearRetry));
  onHost("session_branch", (_event, ctx) => track(ctx, endContext));
  onHost("session_switch", (_event, ctx) => track(ctx, endContext));

  pi.registerCommand(COMMAND, {
    description: "Inspect and control classifier-driven tool and skill selection",
    getArgumentCompletions: (prefix: string) => {
      const matches = SUBCOMMANDS.filter((name) => name.startsWith(prefix.trim()));
      return matches.length > 0 ? matches.map((name) => ({ value: name, label: name })) : null;
    },
    handler: async (args: string, ctx) => {
      const state = ensureSession(ctx);
      const subcommand = args.trim().split(/\s+/)[0] || "status";
      switch (subcommand) {
        case "status":
          commandStatus(ctx, state);
          return;
        case "explain":
          commandExplain(ctx, state);
          return;
        case "on":
          state.config.enabled = true;
          resetRatchet(state);
          classifierFor(state);
          ctx.ui.notify(`${PREFIX} selection enabled`, "info");
          return;
        case "off":
          state.config.enabled = false;
          resetRatchet(state);
          await restoreBaseline(pi, state);
          ctx.ui.notify(`${PREFIX} selection disabled; full loadout restored`, "info");
          return;
        default:
          ctx.ui.notify(`${PREFIX} usage: /${COMMAND} [${SUBCOMMANDS.join("|")}]`, "warning");
      }
    },
  });
}

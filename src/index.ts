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
  clipPrompt,
  decideSkills,
  decideTools,
  isSlashCommand,
  skillCandidates,
  TOOLS_QUESTION_ID,
} from "./select.ts";
import { ClassifierError } from "./types.ts";
import type { Classifier, LoadoutConfig, LoadoutDecision, SkillCandidate } from "./types.ts";

const PREFIX = "[loadout]";
const COMMAND = "loadout";
const SUBCOMMANDS = ["status", "on", "off", "explain"] as const;
const DECISION_ENTRY = "loadout.decision";
const HINT_MESSAGE = "loadout.skills";
/** Extra time past the backend's own budget before the outer guard gives up. */
const GUARD_MS = 250;

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
  classifierKey: string;
  /** Whether this session counts as a user of the shared classifier for `classifierKey`. */
  holdsClassifier: boolean;
  /** Tools the user had active; every selection is a subset of this. */
  baseline: string[] | null;
  /** What this extension last activated, to notice changes made by anyone else. */
  lastApplied: string[] | null;
  lastDecision: (LoadoutDecision & { latencyMs: number }) | null;
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionKey(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId();
  } catch {
    return "unknown";
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
    classifierKey,
    holdsClassifier: keepClassifier,
    baseline: existing?.baseline ?? null,
    lastApplied: existing?.lastApplied ?? null,
    lastDecision: existing?.lastDecision ?? null,
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

async function activateTools(pi: ExtensionAPI, state: SessionState, tools: string[]): Promise<void> {
  if (!sameSet(pi.getActiveTools(), tools)) await pi.setActiveTools(tools);
  state.lastApplied = [...tools];
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

async function restoreBaseline(pi: ExtensionAPI, state: SessionState): Promise<void> {
  if (state.baseline !== null && state.lastApplied !== null) await activateTools(pi, state, state.baseline);
}

async function classify(state: SessionState, prompt: string, questions: ReturnType<typeof buildQuestions>) {
  const config = state.config;
  const budget = (config.backend === "laya" ? config.laya.timeoutMs : config.jev.timeoutMs) + GUARD_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ClassifierError(config.backend, "timeout", `no answer within ${budget}ms`));
    }, budget);
  });
  try {
    const call = classifierFor(state).classify(clipPrompt(prompt, config.maxPromptChars), questions, {
      signal: controller.signal,
    });
    return await Promise.race([call, guard]);
  } finally {
    clearTimeout(timer);
  }
}

function summarize(decision: LoadoutDecision, baselineSize: number): string {
  const { tools, skills } = decision;
  const toolPart =
    tools.active === null
      ? `tools: all (${tools.reason})`
      : `tools: ${tools.profile} ${tools.confidence.toFixed(2)} -> ${tools.active.length}/${baselineSize}`;
  const skillPart =
    skills.selected === null
      ? `skills: all (${skills.reason})`
      : `skills: ${skills.selected.length > 0 ? skills.selected.join(", ") : "none"}`;
  return `${toolPart} | ${skillPart}`;
}

function skillHint(selected: string[]): string {
  return [
    "Skills most relevant to this request, chosen by a classifier:",
    ...selected.map((name) => `- ${name}`),
    "Load the relevant ones before starting. Other listed skills are unlikely to apply.",
  ].join("\n");
}

async function onBeforeAgentStart(pi: ExtensionAPI, event: PromptEvent, ctx: ExtensionContext) {
  let state: SessionState | undefined;
  try {
    state = ensureSession(ctx);
    const { config } = state;
    if (!config.enabled || event.prompt.trim() === "" || isSlashCommand(event.prompt)) {
      await restoreBaseline(pi, state);
      return;
    }

    const baseline = refreshBaseline(pi, state);
    const allSkills = listSkills(pi, event);
    const candidates = skillCandidates(allSkills, config.skills);
    const questions = buildQuestions(config, candidates);
    if (Object.keys(questions).length === 0) return;

    const startedAt = Date.now();
    const result = await classify(state, event.prompt, questions);
    const decision: LoadoutDecision = {
      tools: decideTools(config.tools, baseline, result.answers[TOOLS_QUESTION_ID]),
      skills: decideSkills(config.skills, candidates, result.answers),
    };
    const latencyMs = Date.now() - startedAt;
    state.lastDecision = { ...decision, latencyMs };
    state.lastFailure = null;

    pi.appendEntry(DECISION_ENTRY, { ...decision, backend: config.backend, dryRun: config.dryRun, latencyMs });
    notify(ctx, config, `${config.dryRun ? "(dry run) " : ""}${summarize(decision, baseline.length)}`, "info");
    if (config.dryRun) return;

    await activateTools(pi, state, decision.tools.active ?? baseline);

    const selected = decision.skills.selected;
    if (selected === null) return;
    const promptSkills = event.systemPromptOptions?.skills;
    const filter = config.skills.mode === "filter" || (config.skills.mode === "auto" && Array.isArray(promptSkills));
    if (filter && event.systemPromptOptions && Array.isArray(promptSkills)) {
      const keep = new Set([...selected, ...config.skills.exclude]);
      // Reassign rather than splice: the array may be shared with the host's base prompt options.
      event.systemPromptOptions.skills = promptSkills.filter((skill) => keep.has(skill.name));
      return;
    }
    if (selected.length === 0) return;
    return { message: { customType: HINT_MESSAGE, content: skillHint(selected), display: false } };
  } catch (error) {
    if (!state) return;
    const reason =
      error instanceof ClassifierError
        ? `classification failed (${error.code}): ${error.message}`
        : `selection error: ${errorText(error)}`;
    if (reason !== state.lastFailure) {
      state.lastFailure = reason;
      notify(
        ctx,
        state.config,
        `${reason}; using the full loadout until it recovers`,
        error instanceof ClassifierError ? "warning" : "error",
      );
    }
    try {
      await restoreBaseline(pi, state);
    } catch {
      // Restoring is best-effort; the turn must still run.
    }
  }
}

function commandStatus(ctx: ExtensionContext, state: SessionState): void {
  const { config } = state;
  const lines = [
    `${config.enabled ? "enabled" : "disabled"}${config.dryRun ? " (dry run)" : ""} | backend ${config.backend}`,
    `config: ${state.source ?? "built-in defaults"}`,
    `tools: ${config.tools.enabled ? `profiles ${Object.keys(config.tools.profiles).join(", ")}` : "off"} | skills: ${config.skills.enabled ? config.skills.mode : "off"}`,
    `baseline tools: ${state.baseline?.join(", ") ?? "not captured yet"}`,
    `last decision: ${state.lastDecision ? summarize(state.lastDecision, state.baseline?.length ?? 0) : "none"}`,
  ];
  for (const line of lines) ctx.ui.notify(`${PREFIX} ${line}`, "info");
}

function commandExplain(ctx: ExtensionContext, state: SessionState): void {
  const decision = state.lastDecision;
  if (!decision) {
    ctx.ui.notify(`${PREFIX} no decision yet`, "info");
    return;
  }
  const { tools, skills } = decision;
  const scores = Object.entries(skills.scores)
    .sort(([, a], [, b]) => b - a)
    .map(([name, score]) => `${name}=${score.toFixed(2)}`)
    .join(", ");
  const lines = [
    `tools: profile ${tools.profile ?? "-"} | confidence ${tools.confidence.toFixed(2)} | reason ${tools.reason}`,
    `active: ${tools.active?.join(", ") ?? "baseline"}`,
    `skills: reason ${skills.reason} | selected ${skills.selected?.join(", ") ?? "all"}`,
    `skill scores: ${scores || "none"}`,
    `latency: ${decision.latencyMs}ms`,
  ];
  for (const line of lines) ctx.ui.notify(`${PREFIX} ${line}`, "info");
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

  pi.on("before_agent_start", (event, ctx) => onBeforeAgentStart(pi, event as PromptEvent, ctx));

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
          classifierFor(state);
          ctx.ui.notify(`${PREFIX} selection enabled`, "info");
          return;
        case "off":
          state.config.enabled = false;
          await restoreBaseline(pi, state);
          ctx.ui.notify(`${PREFIX} selection disabled; full loadout restored`, "info");
          return;
        default:
          ctx.ui.notify(`${PREFIX} usage: /${COMMAND} [${SUBCOMMANDS.join("|")}]`, "warning");
      }
    },
  });
}

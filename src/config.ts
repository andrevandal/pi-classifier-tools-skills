/**
 * Config discovery, validation and defaults.
 *
 * Search order is project before global, JSON before YAML:
 *   <cwd>/.omp/loadout.{json,yml,yaml}, then ~/.omp/loadout.{json,yml,yaml}
 * `LOADOUT_CONFIG=<file>` replaces the search with that one file, which lets
 * a benchmark or CI run pin each session's config from outside the project.
 *
 * Project files are read only when the host trusts the project: a config picks
 * the executable the Laya sidecar runs and the endpoint that receives prompts,
 * so a cloned repository must not be able to supply one.
 *
 * The first file that parses and validates wins. A file that parses but holds a
 * bad value is rejected: the plugin turns itself off and reports the error,
 * because silently mis-selecting tools is worse than leaving the loadout alone.
 *
 * `telemetry: false` in `~/.omp/loadout.*` is a machine-wide ceiling. It is read
 * outside the search above, so no project or `LOADOUT_CONFIG` file can lift it;
 * those files can only turn telemetry off. An unreadable machine setting or any
 * config error also means no persistence (fail closed). It is applied when a
 * session loads its config, so a change needs a restart.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { profileOrder } from "./select.ts";
import type { LoadoutConfig, LoadoutConfigInput, TelemetryState, ToolList } from "./types.ts";

export const CONFIG_BASENAME = "loadout";
const MIN_PROMPT_CHARS = 200;
/** Longest classification budget a backend may ask for; a turn never waits longer. */
export const MAX_BACKEND_TIMEOUT_MS = 20_000;
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "glob", "lsp", "web_search", "todo"];

export function defaultConfig(): LoadoutConfig {
  return {
    enabled: true,
    backend: "laya",
    jev: {
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: "jev-latest",
      apiKeyEnvVar: "TYPESAFE_API_KEY",
      timeoutMs: 3000,
    },
    laya: {
      transport: "python",
      endpoint: "",
      apiKeyEnvVar: "",
      pythonBin: "python3",
      workerScript: "python/laya_worker.py",
      repo: "convaiinnovations/laya",
      subfolder: null,
      device: null,
      router: true,
      maxLoaded: null,
      preload: true,
      timeoutMs: 4000,
      warmupTimeoutMs: 600000,
      hfTokenEnvVar: "HF_TOKEN",
    },
    tools: {
      enabled: true,
      question: {
        type: "choice",
        instructions: "Which tools does an AI coding agent need to handle this request?",
        criteria: {
          answer: "explain or answer a question by reading code; needs no shell, git, or file changes",
          edit: "change files directly; no commands, tests, or builds need to run",
          full: "run commands, tests, builds, git, or anything not covered above",
        },
      },
      // Names cover both hosts (pi: find/ls, omp: glob/lsp/ast_edit/...); absent ones are dropped.
      profiles: {
        answer: READ_ONLY_TOOLS,
        edit: [...READ_ONLY_TOOLS, "edit", "write", "ast_edit"],
        full: "*",
      },
      alwaysOn: [],
      maxRisk: 0.1,
    },
    skills: {
      enabled: false,
      mode: "auto",
      threshold: 0.5,
      maxSkills: 5,
      maxCandidates: 40,
      alwaysInclude: [],
      exclude: [],
    },
    maxPromptChars: 8000,
    dryRun: false,
    notify: true,
    telemetry: true,
  };
}

export interface ConfigSource {
  path: string;
  scope: "project" | "global" | "explicit";
}

export interface LoadResult {
  config: LoadoutConfig;
  /** The file the config came from, or null when the defaults apply. */
  source: string | null;
  /** Which kind of file `source` is; null when the defaults apply. */
  scope: ConfigSource["scope"] | null;
  /** Whether this session may persist trace records, and why not. */
  telemetry: TelemetryState;
  errors: string[];
  warnings: string[];
}

export interface LoadOptions {
  projectTrusted: boolean;
  home?: string;
  /** YAML parser; defaults to `Bun.YAML.parse` when running on Bun. */
  parseYaml?: ((text: string) => unknown) | null;
  /** Load exactly this file instead of searching (from `LOADOUT_CONFIG`). */
  explicitPath?: string;
}

function bunYaml(): ((text: string) => unknown) | null {
  const bun = (globalThis as { Bun?: { YAML?: { parse?: (text: string) => unknown } } }).Bun;
  const parse = bun?.YAML?.parse;
  return typeof parse === "function" ? (text) => parse.call(bun?.YAML, text) : null;
}

function configFiles(dir: string, scope: ConfigSource["scope"]): ConfigSource[] {
  return ["json", "yml", "yaml"].map((ext) => ({ path: path.join(dir, ".omp", `${CONFIG_BASENAME}.${ext}`), scope }));
}

export function configCandidates(cwd: string, home: string): ConfigSource[] {
  return [...configFiles(cwd, "project"), ...configFiles(home, "global")];
}

function searchConfig(
  cwd: string,
  options: LoadOptions,
  home: string,
  parseYaml: ((text: string) => unknown) | null,
): Omit<LoadResult, "telemetry"> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const projectIsHome = path.resolve(cwd) === path.resolve(home);

  const candidates: ConfigSource[] = options.explicitPath
    ? [{ path: path.resolve(options.explicitPath), scope: "explicit" }]
    : configCandidates(cwd, home);
  for (const source of candidates) {
    if (!fs.existsSync(source.path)) {
      if (source.scope === "explicit") errors.push(`${source.path}: LOADOUT_CONFIG names a file that does not exist`);
      continue;
    }
    if (source.scope === "project" && (projectIsHome || !options.projectTrusted)) {
      if (!projectIsHome) warnings.push(`${source.path}: ignored because this project is not trusted`);
      continue;
    }

    let raw: unknown;
    try {
      const text = fs.readFileSync(source.path, "utf8");
      if (source.path.endsWith(".json")) {
        raw = JSON.parse(text);
      } else if (parseYaml) {
        raw = parseYaml(text);
      } else {
        errors.push(`${source.path}: YAML needs Bun (omp); use ${CONFIG_BASENAME}.json on pi`);
        continue;
      }
    } catch (error) {
      errors.push(`${source.path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const parsed = parseConfig(raw);
    warnings.push(...parsed.warnings.map((w) => `${source.path}: ${w}`));
    if (parsed.errors.length > 0) {
      errors.push(...parsed.errors.map((e) => `${source.path}: ${e}`));
      return { config: { ...defaultConfig(), enabled: false }, source: null, scope: null, errors, warnings };
    }
    return { config: parsed.config, source: source.path, scope: source.scope, errors, warnings };
  }
  // A file that was named but could not be used disables the plugin rather than running on guessed defaults.
  const config = errors.length > 0 ? { ...defaultConfig(), enabled: false } : defaultConfig();
  return { config, source: null, scope: null, errors, warnings };
}

/**
 * The machine-level `telemetry` setting in the first existing `~/.omp/loadout.*`
 * file. It is read outside the normal search so nothing a project or
 * `LOADOUT_CONFIG` says can lift it. Anything unreadable is `"unreadable"`, which
 * callers treat as off. `"on"` and `"absent"` behave alike: it is a ceiling, not a force.
 */
export type MachineTelemetry = "absent" | "on" | "off" | "unreadable";

export function readMachineTelemetry(
  home: string,
  parseYaml: ((text: string) => unknown) | null = bunYaml(),
): MachineTelemetry {
  for (const source of configFiles(home, "global")) {
    let text: string;
    try {
      text = fs.readFileSync(source.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return "unreadable";
    }
    let raw: unknown;
    try {
      if (source.path.endsWith(".json")) raw = JSON.parse(text);
      else if (parseYaml) raw = parseYaml(text);
      else return "unreadable";
    } catch {
      return "unreadable";
    }
    if (!isRecord(raw)) return "unreadable";
    if (!Object.hasOwn(raw, "telemetry")) return "absent";
    return raw.telemetry === false ? "off" : raw.telemetry === true ? "on" : "unreadable";
  }
  return "absent";
}

function resolveTelemetry(machine: MachineTelemetry, found: Omit<LoadResult, "telemetry">): TelemetryState {
  if (machine === "off") return { persist: false, reason: "machine-off" };
  if (machine === "unreadable") return { persist: false, reason: "machine-unreadable" };
  if (found.errors.length > 0) return { persist: false, reason: "config-error" };
  if (!found.config.telemetry) return { persist: false, reason: "config-off" };
  return { persist: true, reason: "default" };
}

export function loadConfig(cwd: string, options: LoadOptions): LoadResult {
  const home = options.home ?? os.homedir();
  const parseYaml = options.parseYaml === undefined ? bunYaml() : options.parseYaml;
  const found = searchConfig(cwd, options, home, parseYaml);
  return { ...found, telemetry: resolveTelemetry(readMachineTelemetry(home, parseYaml), found) };
}

const SECTIONS = ["jev", "laya", "tools", "skills"] as const;
const NULLABLE = new Set(["maxPromptChars", "laya.subfolder", "laya.device", "laya.maxLoaded"]);
/** Replaced wholesale and checked by `validateTools`, not by the generic type check. */
const STRUCTURED = new Set(["tools.question", "tools.profiles"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/** Type-check `input` against the shape of `defaults`, collecting unknown keys and mismatches. */
function checkShape(
  input: Record<string, unknown>,
  defaults: Record<string, unknown>,
  prefix: string,
  errors: string[],
  warnings: string[],
): void {
  for (const [key, value] of Object.entries(input)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (key.startsWith("$") || STRUCTURED.has(keyPath)) continue;
    if (!(key in defaults)) {
      warnings.push(`unknown key "${keyPath}" (ignored)`);
      continue;
    }
    if (prefix === "" && (SECTIONS as readonly string[]).includes(key)) continue;
    if (value === null && NULLABLE.has(keyPath)) continue;
    const expected = NULLABLE.has(keyPath) && defaults[key] === null ? "number|string" : kindOf(defaults[key]);
    const actual = kindOf(value);
    if (!expected.split("|").includes(actual)) errors.push(`"${keyPath}" must be ${expected}, got ${actual}`);
    else if (actual === "array" && !(value as unknown[]).every((item) => typeof item === "string")) {
      errors.push(`"${keyPath}" must be a list of strings`);
    }
  }
}

function isToolList(value: unknown): value is ToolList {
  return value === "*" || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function validateTools(config: LoadoutConfig, errors: string[]): void {
  const { question, profiles } = config.tools;
  if (!isRecord(question) || question.type !== "choice" || !isRecord(question.criteria)) {
    errors.push(`"tools.question" must be a choice question with criteria`);
    return;
  }
  const options = Object.keys(question.criteria);
  if (options.length < 2) errors.push(`"tools.question" needs at least two options`);
  if (!isRecord(profiles)) {
    errors.push(`"tools.profiles" must map each option to a tool list or "*"`);
    return;
  }
  for (const option of options) {
    if (!(option in profiles)) errors.push(`"tools.profiles" has no entry for option "${option}"`);
  }
  for (const [name, tools] of Object.entries(profiles)) {
    if (!isToolList(tools)) errors.push(`"tools.profiles.${name}" must be a list of tool names or "*"`);
  }
}

function checkRange(errors: string[], keyPath: string, value: number, min: number, max = Number.POSITIVE_INFINITY) {
  if (!(value >= min && value <= max)) errors.push(`"${keyPath}" must be between ${min} and ${max}`);
}

export function parseConfig(raw: unknown): { config: LoadoutConfig; errors: string[]; warnings: string[] } {
  const defaults = defaultConfig();
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(raw)) return { config: defaults, errors: ["config must be an object"], warnings };

  const defaultsRecord = defaults as unknown as Record<string, unknown>;
  checkShape(raw, defaultsRecord, "", errors, warnings);
  for (const section of SECTIONS) {
    const value = raw[section];
    if (value === undefined) continue;
    if (!isRecord(value)) errors.push(`"${section}" must be an object`);
    else checkShape(value, defaultsRecord[section] as Record<string, unknown>, section, errors, warnings);
  }
  if (errors.length > 0) return { config: defaults, errors, warnings };

  const input = raw as LoadoutConfigInput;
  const config: LoadoutConfig = {
    ...defaults,
    ...input,
    jev: { ...defaults.jev, ...input.jev },
    laya: { ...defaults.laya, ...input.laya },
    tools: { ...defaults.tools, ...input.tools },
    skills: { ...defaults.skills, ...input.skills },
  };

  if (!["jev", "laya"].includes(config.backend)) errors.push(`"backend" must be "jev" or "laya"`);
  if (!["python", "http"].includes(config.laya.transport)) errors.push(`"laya.transport" must be "python" or "http"`);
  if (config.backend === "laya" && config.laya.transport === "http" && !/^https?:\/\//.test(config.laya.endpoint)) {
    errors.push(`"laya.endpoint" must be an http(s) URL when laya.transport is "http"`);
  }
  if (!["auto", "filter", "hint"].includes(config.skills.mode)) {
    errors.push(`"skills.mode" must be "auto", "filter" or "hint"`);
  }
  checkRange(errors, "tools.maxRisk", config.tools.maxRisk, 0, 1);
  checkRange(errors, "skills.threshold", config.skills.threshold, 0, 1);
  checkRange(errors, "skills.maxSkills", config.skills.maxSkills, 1);
  checkRange(errors, "skills.maxCandidates", config.skills.maxCandidates, 1);
  checkRange(errors, "jev.timeoutMs", config.jev.timeoutMs, 1, MAX_BACKEND_TIMEOUT_MS);
  checkRange(errors, "laya.timeoutMs", config.laya.timeoutMs, 1, MAX_BACKEND_TIMEOUT_MS);
  if (config.maxPromptChars !== null) checkRange(errors, "maxPromptChars", config.maxPromptChars, MIN_PROMPT_CHARS);
  validateTools(config, errors);
  if (errors.length === 0) {
    try {
      profileOrder(config.tools);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return errors.length > 0 ? { config: defaults, errors, warnings } : { config, errors, warnings };
}

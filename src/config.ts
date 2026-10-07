/**
 * Config discovery, validation and defaults.
 *
 * Search order is project before global, JSON before YAML:
 *   <cwd>/.omp/loadout.{json,yml,yaml}, then ~/.omp/loadout.{json,yml,yaml}
 *
 * Project files are read only when the host trusts the project: a config picks
 * the executable the Laya sidecar runs and the endpoint that receives prompts,
 * so a cloned repository must not be able to supply one.
 *
 * The first file that parses and validates wins. A file that parses but holds a
 * bad value is rejected and the defaults apply, because silently mis-selecting
 * tools is worse than leaving the loadout alone.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { LoadoutConfig, LoadoutConfigInput, ToolList } from "./types.ts";

export const CONFIG_BASENAME = "loadout";
const MIN_PROMPT_CHARS = 200;
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
          answer: "explain, review, or answer a question about code; nothing is changed or executed",
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
      confidenceThreshold: 0.6,
    },
    skills: {
      enabled: true,
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
  };
}

export interface ConfigSource {
  path: string;
  scope: "project" | "global";
}

export interface LoadResult {
  config: LoadoutConfig;
  /** The file the config came from, or null when the defaults apply. */
  source: string | null;
  errors: string[];
  warnings: string[];
}

export interface LoadOptions {
  projectTrusted: boolean;
  home?: string;
  /** YAML parser; defaults to `Bun.YAML.parse` when running on Bun. */
  parseYaml?: ((text: string) => unknown) | null;
}

function bunYaml(): ((text: string) => unknown) | null {
  const bun = (globalThis as { Bun?: { YAML?: { parse?: (text: string) => unknown } } }).Bun;
  const parse = bun?.YAML?.parse;
  return typeof parse === "function" ? (text) => parse.call(bun?.YAML, text) : null;
}

export function configCandidates(cwd: string, home: string): ConfigSource[] {
  const files = (dir: string, scope: ConfigSource["scope"]): ConfigSource[] =>
    ["json", "yml", "yaml"].map((ext) => ({ path: path.join(dir, ".omp", `${CONFIG_BASENAME}.${ext}`), scope }));
  return [...files(cwd, "project"), ...files(home, "global")];
}

export function loadConfig(cwd: string, options: LoadOptions): LoadResult {
  const home = options.home ?? os.homedir();
  const parseYaml = options.parseYaml === undefined ? bunYaml() : options.parseYaml;
  const errors: string[] = [];
  const warnings: string[] = [];
  const projectIsHome = path.resolve(cwd) === path.resolve(home);

  for (const source of configCandidates(cwd, home)) {
    if (!fs.existsSync(source.path)) continue;
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
      return { config: defaultConfig(), source: null, errors, warnings };
    }
    return { config: parsed.config, source: source.path, errors, warnings };
  }
  return { config: defaultConfig(), source: null, errors, warnings };
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
  checkRange(errors, "tools.confidenceThreshold", config.tools.confidenceThreshold, 0, 1);
  checkRange(errors, "skills.threshold", config.skills.threshold, 0, 1);
  checkRange(errors, "skills.maxSkills", config.skills.maxSkills, 1);
  checkRange(errors, "skills.maxCandidates", config.skills.maxCandidates, 1);
  checkRange(errors, "jev.timeoutMs", config.jev.timeoutMs, 1);
  checkRange(errors, "laya.timeoutMs", config.laya.timeoutMs, 1);
  if (config.maxPromptChars !== null) checkRange(errors, "maxPromptChars", config.maxPromptChars, MIN_PROMPT_CHARS);
  validateTools(config, errors);

  return errors.length > 0 ? { config: defaults, errors, warnings } : { config, errors, warnings };
}

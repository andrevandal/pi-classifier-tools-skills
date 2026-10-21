/**
 * Assemble a report from a scope and print it. `buildSummary` and `buildExport` are the library entry points (the
 * CLI and `/loadout stats` call them); `parseArgv` and `main` are the command line around them.
 *
 * The command line is strict and explicit: it needs a scope (named session files, or a time window plus a project
 * or all projects), says which flag is missing or in conflict, and never reads the default sessions directory
 * for an incomplete query. stdout carries only the JSON document; every diagnostic goes to stderr.
 */

import * as fs from "node:fs";
import { parseArgs } from "node:util";

import { type ExportDoc, exportDocument } from "./export.ts";
import { defaultSessionsDir, isObject, parseInstant, readServiceLogs, readSessions } from "./read.ts";
import {
  applyFilters,
  DECISION_OUTCOMES,
  type FilterSpec,
  type ScopeSpec,
  selectFiles,
  USAGE_OUTCOMES,
} from "./scope.ts";
import { type ReportInput, type Summary, summarize } from "./summary.ts";

export interface ReportSpec {
  scope: ScopeSpec;
  filters: FilterSpec;
  /** Explicit server log files for the request-id join; none means no join is attempted. */
  serviceLogs: string[];
}

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

export type Parsed =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; command: "summary" | "export"; spec: ReportSpec };

function gather(spec: ReportSpec): ReportInput {
  const selection = selectFiles(spec.scope);
  return {
    scope: spec.scope,
    selection,
    filters: spec.filters,
    filtered: applyFilters(readSessions(selection.files), spec.scope, spec.filters),
    service: spec.serviceLogs.length === 0 ? null : readServiceLogs(spec.serviceLogs),
  };
}

/** Select, read, filter and aggregate. Unreadable input is counted as coverage, never thrown. */
export function buildSummary(spec: ReportSpec): Summary {
  return summarize(gather(spec));
}

export function buildExport(spec: ReportSpec): ExportDoc {
  return exportDocument(gather(spec));
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const OUTCOMES: readonly string[] = [...DECISION_OUTCOMES, ...USAGE_OUTCOMES];

export const USAGE = `loadout-report: read-only, content-free reports over local /loadout telemetry

Usage:
  loadout-report summary [scope] [filters] [--service-log <file>]
  loadout-report export  [scope] [filters] [--service-log <file>]

summary prints counts and statistics; export prints the events behind them. Both print one JSON document on
stdout and send diagnostics to stderr. Exit status: 0 success, 1 unexpected error, 2 usage error.

Scope (one form is required):
  --session <file>             the current session's file; repeatable
  --since <ISO> --until <ISO> (--project <path> | --all-projects)
                               a history: events with since <= time < until. Both bounds and one project form
                               are required. --project is repeatable and matches a session's working
                               directory exactly.
  --sessions-dir <dir>         history root; repeatable. Default ~/.omp/agent/sessions (pi: ~/.pi/agent/sessions)

Evidence and filters:
  --service-log <file>         Laya server log to join by request id; repeatable
  --branch <all|active|abandoned>
                               default all
  --outcome <value>            repeatable. Decisions: ${DECISION_OUTCOMES.join(", ")}.
                               Model turns: ${USAGE_OUTCOMES.join(", ")}.

  -h, --help                   print this text
  -v, --version                print the version
`;

const OPTIONS = {
  session: { type: "string", multiple: true },
  since: { type: "string" },
  until: { type: "string" },
  project: { type: "string", multiple: true },
  "all-projects": { type: "boolean" },
  "sessions-dir": { type: "string", multiple: true },
  "service-log": { type: "string", multiple: true },
  branch: { type: "string" },
  outcome: { type: "string", multiple: true },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

interface Args {
  session?: string[];
  since?: string;
  until?: string;
  project?: string[];
  "all-projects"?: boolean;
  "sessions-dir"?: string[];
  "service-log"?: string[];
  branch?: string;
  outcome?: string[];
  help?: boolean;
  version?: boolean;
}

class UsageError extends Error {}

function usage(message: string): never {
  throw new UsageError(message);
}

function kindOf(file: string): "file" | "dir" | null {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : null;
  } catch {
    return null;
  }
}

function parseScope(args: Args): ScopeSpec {
  const historical = [
    args.since === undefined ? null : "--since",
    args.until === undefined ? null : "--until",
    args.project === undefined ? null : "--project",
    args["all-projects"] === true ? "--all-projects" : null,
    args["sessions-dir"] === undefined ? null : "--sessions-dir",
  ].filter((flag) => flag !== null);

  if (args.session !== undefined) {
    if (historical.length > 0) usage(`--session cannot be combined with ${historical.join(", ")}`);
    for (const file of args.session) if (kindOf(file) !== "file") usage(`--session ${file}: not a file`);
    return { kind: "session", files: args.session };
  }
  if (historical.length === 0) {
    usage("no scope: pass --session <file>, or --since <ISO> --until <ISO> with --project <path> or --all-projects");
  }

  const { since, until } = args;
  const missing = [
    since === undefined ? "--since" : null,
    until === undefined ? "--until" : null,
    args.project === undefined && args["all-projects"] !== true ? "--project <path> or --all-projects" : null,
  ].filter((flag) => flag !== null);
  if (missing.length > 0 || since === undefined || until === undefined) {
    usage(`incomplete historical scope: missing ${missing.join(", ")}`);
  }
  if (args.project !== undefined && args["all-projects"] === true) {
    usage("--project and --all-projects are mutually exclusive");
  }
  const from = parseInstant(since);
  if (from === null) usage(`--since ${since}: not an ISO 8601 date or UTC date-time`);
  const to = parseInstant(until);
  if (to === null) usage(`--until ${until}: not an ISO 8601 date or UTC date-time`);
  if (from >= to) usage(`--since ${since} must be before --until ${until}`);

  const explicit = args["sessions-dir"];
  for (const dir of explicit ?? []) if (kindOf(dir) !== "dir") usage(`--sessions-dir ${dir}: not a directory`);
  return {
    kind: "historical",
    since: from,
    until: to,
    projects: args.project ?? null,
    roots: explicit ?? [defaultSessionsDir()],
  };
}

function parseFilters(args: Args): FilterSpec {
  const branch = args.branch ?? "all";
  if (branch !== "all" && branch !== "active" && branch !== "abandoned") {
    usage(`--branch ${branch}: use all, active or abandoned`);
  }
  const given = args.outcome ?? [];
  const unknown = given.filter((value) => !OUTCOMES.includes(value));
  if (unknown.length > 0) usage(`--outcome ${unknown.join(", ")}: use one of ${OUTCOMES.join(", ")}`);
  const decision = DECISION_OUTCOMES.filter((outcome) => given.includes(outcome));
  const turns = USAGE_OUTCOMES.filter((outcome) => given.includes(outcome));
  return {
    branch,
    decision: decision.length === 0 ? null : decision,
    usage: turns.length === 0 ? null : turns,
  };
}

function validate(args: Args, positionals: string[]): Parsed {
  if (args.help === true) return { kind: "help" };
  if (args.version === true) return { kind: "version" };
  if (positionals.length !== 1) {
    usage(
      positionals.length === 0
        ? "missing subcommand: summary or export"
        : `expected one subcommand, got ${positionals.join(" ")}`,
    );
  }
  const command = positionals[0];
  if (command !== "summary" && command !== "export") usage(`unknown subcommand ${command}: use summary or export`);
  const scope = parseScope(args);
  const filters = parseFilters(args);
  const serviceLogs = args["service-log"] ?? [];
  for (const file of serviceLogs) if (kindOf(file) !== "file") usage(`--service-log ${file}: not a file`);
  return { kind: "run", command, spec: { scope, filters, serviceLogs } };
}

function isParseArgsError(error: unknown): error is Error {
  return error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS");
}

/** Parse errors, then help, then version, then the subcommand, scope, filters and service logs. */
export function parseArgv(argv: string[]): { ok: true; parsed: Parsed } | { ok: false; message: string } {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    return { ok: true, parsed: validate(values, positionals) };
  } catch (error) {
    if (error instanceof UsageError || isParseArgsError(error)) return { ok: false, message: error.message };
    throw error;
  }
}

function packageVersion(): string {
  const manifest: unknown = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  return isObject(manifest) && typeof manifest.version === "string" ? manifest.version : "unknown";
}

const STDIO: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** Exit status: 0 success, 1 unexpected error, 2 usage error. */
export function main(argv: string[], io: Io = STDIO): number {
  try {
    const result = parseArgv(argv);
    if (!result.ok) {
      io.err(`loadout-report: ${result.message}\nTry loadout-report --help.\n`);
      return 2;
    }
    const { parsed } = result;
    if (parsed.kind === "help") {
      io.out(USAGE);
      return 0;
    }
    if (parsed.kind === "version") {
      io.out(`${packageVersion()}\n`);
      return 0;
    }
    const input = gather(parsed.spec);
    if (input.selection.files.length === 0) {
      io.err("loadout-report: warning: no session files matched the scope; every count is zero\n");
    }
    const document = parsed.command === "summary" ? summarize(input) : exportDocument(input);
    io.out(`${JSON.stringify(document, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.err(`loadout-report: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

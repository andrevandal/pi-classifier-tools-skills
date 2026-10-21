/**
 * `/loadout stats`: argument handling over the shared report library. `splitArgs` splits the command text and
 * `runStats` turns the tokens after `stats` into one result. `parseArgv` is the only validator and the library reads
 * every session file; this module's one filesystem call is `statSync` on the host's current session file.
 */

import * as fs from "node:fs";

import { buildExport, buildSummary, parseArgv } from "./report/report.ts";
import type { Summary } from "./report/summary.ts";

export type StatsResult =
  | { kind: "refused"; level: "info" | "warning"; text: string }
  | { kind: "json"; text: string }
  | { kind: "summary"; summary: Summary; compare: boolean };

const PREFIX = "[loadout] stats: ";

const STATS_USAGE = `[loadout] stats [summary|export] [--json] [scope] [filters]
  scope: this session's file by default; or --session <file>; or a history: --since <ISO> --until <ISO> with --project <path> or --all-projects (root: --sessions-dir <dir>)
  filters: --branch <all|active|abandoned>, --outcome <value> (repeatable), --service-log <file>
  --json prints the loadout-report summary document and export prints the export document, exactly as the CLI does
  a history scan reads session files inside the host and blocks it until it finishes: prefer --project and a short window`;

const NO_SESSION_FILE = `${PREFIX}no session file yet. The host writes it with the first assistant message (an unsaved session never writes one); ask again after the first reply, or name a scope (see /loadout stats --help)`;

// A history scope that names nothing on disk. Parsing it reads nothing, so it lets every other argument be validated
// before the session file exists.
const PROBE_SCOPE = ["--since", "1970-01-01", "--until", "1970-01-02", "--all-projects"];

// A scope or filter flag, bare or as `--flag=value`.
const SCOPE_FLAG = /^--(session|since|until|project|all-projects|sessions-dir)(=|$)/;
const FILTER_FLAG = /^--(branch|outcome|service-log)(=|$)/;

/**
 * Split command text into tokens. Whitespace separates tokens; `"..."` and `'...'` group text (no escapes, and the
 * other quote is literal inside) and join the text they touch, so `--project="a b"` is one token. Null when a quote
 * is unterminated.
 */
export function splitArgs(args: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let started = false; // an empty quoted string is still a token
  let quote: string | null = null;
  for (const char of args) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else token += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote !== null) return null;
  if (started) tokens.push(token);
  return tokens;
}

/** A regular file on disk. The only filesystem call in this module. */
function isRegularFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Run the tokens after `stats`. `sessionFile` is the host's current session file, undefined until the first assistant
 * message; it is the scope only when no scope flag is given.
 */
export function runStats(tokens: string[], sessionFile: string | undefined): StatsResult {
  const json = tokens.includes("--json");
  const args = tokens.filter((token) => token !== "--json");
  const [first, ...afterFirst] = args;
  const isView = first === "summary" || first === "export";
  if (first !== undefined && !isView && !first.startsWith("-")) {
    return { kind: "refused", level: "warning", text: `${PREFIX}unknown view ${first} (use summary or export)` };
  }
  const view = first === "export" ? "export" : "summary";
  const rest = isView ? afterFirst : args;

  let result = parseArgv([view, ...rest]);
  let compare = false;
  // Without a scope flag the scope is this session's file. Help and version parse without one, so they win here.
  if (!result.ok && !rest.some((token) => SCOPE_FLAG.test(token))) {
    // The other arguments are checked first, so a bad flag is refused the same way before the session file exists as
    // after it, and only a valid command is answered with the missing file.
    const probe = parseArgv([view, ...PROBE_SCOPE, ...rest]);
    if (!probe.ok) return { kind: "refused", level: "warning", text: `${PREFIX}${probe.message}` };
    if (sessionFile === undefined || !isRegularFile(sessionFile)) {
      return { kind: "refused", level: "info", text: NO_SESSION_FILE };
    }
    result = parseArgv([view, "--session", sessionFile, ...rest]);
    compare = !rest.some((token) => FILTER_FLAG.test(token));
  }

  if (!result.ok) return { kind: "refused", level: "warning", text: `${PREFIX}${result.message}` };
  const { parsed } = result;
  if (parsed.kind === "help") return { kind: "refused", level: "info", text: STATS_USAGE };
  if (parsed.kind === "version") {
    return {
      kind: "refused",
      level: "warning",
      text: `${PREFIX}--version is not a stats option (see /loadout stats --help)`,
    };
  }
  if (parsed.command === "export") return { kind: "json", text: JSON.stringify(buildExport(parsed.spec), null, 2) };
  if (json) return { kind: "json", text: JSON.stringify(buildSummary(parsed.spec), null, 2) };
  return { kind: "summary", summary: buildSummary(parsed.spec), compare };
}

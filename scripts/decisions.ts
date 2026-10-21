/**
 * The decision report as text: how often each profile was picked, how much risk the classifier left, which skills
 * it selected and what it cost in latency. It reads through `src/report/`, so its scope rules are the CLI's: it takes
 * the `loadout-report summary` flags (see `loadout-report --help`) plus `--json`, which prints the same JSON.
 *
 *   node scripts/decisions.ts --since <ISO> --until <ISO> (--project <path> | --all-projects) [--sessions-dir <dir>]
 *   node scripts/decisions.ts --session <file>
 */

import { buildSummary, main as reportMain, parseArgv, USAGE } from "../src/report/report.ts";
import { renderDecisions } from "../src/report/text.ts";

function main(argv: string[]): number {
  const json = argv.includes("--json");
  const result = parseArgv(["summary", ...argv.filter((arg) => arg !== "--json")]);
  if (!result.ok) {
    console.error(`decisions: ${result.message}`);
    return 2;
  }
  const { parsed } = result;
  if (parsed.kind === "version") return reportMain(["--version"]);
  if (parsed.kind === "help") {
    console.log(`usage: node scripts/decisions.ts <loadout-report summary flags> [--json]\n\n${USAGE}`);
    return 0;
  }
  const summary = buildSummary(parsed.spec);
  if (summary.scope.files === 0) console.error("decisions: warning: no session files matched the scope");
  console.log(json ? JSON.stringify(summary, null, 2) : renderDecisions(summary));
  return 0;
}

process.exitCode = main(process.argv.slice(2));

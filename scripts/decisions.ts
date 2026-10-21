/**
 * The decision report as text: how often each profile was picked, how much risk the classifier left, which skills
 * it selected and what it cost in latency. It reads through `src/report/`, so its scope rules are the CLI's: it takes
 * the `loadout-report summary` flags (see `loadout-report --help`) plus `--json`, which prints the same JSON.
 *
 *   node scripts/decisions.ts --since <ISO> --until <ISO> (--project <path> | --all-projects) [--sessions-dir <dir>]
 *   node scripts/decisions.ts --session <file>
 */

import { buildSummary, parseArgv, USAGE } from "../src/report/report.ts";
import type { Count, Stats, Summary } from "../src/report/summary.ts";

const fixed = (n: number | null, digits = 2): string => (n === null ? "-" : n.toFixed(digits));

function render(summary: Summary): string {
  const { decisions, classifier, coverage } = summary;
  const attempts = classifier.attempts;
  const pct = (n: number): string => `${((n * 100) / Math.max(attempts, 1)).toFixed(0)}%`;
  const table = (counts: Count): string =>
    Object.entries(counts)
      .map(([key, count]) => `  ${key.padEnd(24)} ${String(count).padStart(5)}  ${pct(count)}`)
      .join("\n") || "  (none)";
  const skipped = Object.entries(decisions.skips)
    .map(([reason, n]) => `${reason} ${n}`)
    .join(", ");

  const lines = [`loadout decisions: ${attempts} in ${decisions.sessions} sessions (${decisions.dryRun.yes} dry run)`];
  if (skipped) lines.push(`skipped: ${skipped}`);
  if (coverage.unsupported.decisions > 0) {
    lines.push(`unsupported records: ${coverage.unsupported.decisions} (unknown version or shape; not counted above)`);
  }
  if (attempts === 0) {
    lines.push("no loadout.decision attempts matched; check the scope and the filters");
    return lines.join("\n");
  }

  const { proposals, application, skills } = decisions;
  const risk: Stats = proposals.risk;
  const latency = decisions.latencyMs;
  lines.push(`\ntool profile\n${table(proposals.profiles)}`);
  lines.push(`\ntool reason\n${table(proposals.reasons)}`);
  lines.push(`\nfailures\n${table(decisions.failures)}`);
  lines.push(
    `\nrisk p10/p50/p90: ${fixed(risk.p10)} / ${fixed(risk.p50)} / ${fixed(risk.p90)}` +
      ` | kept baseline ${((proposals.keepBaseline * 100) / Math.max(proposals.tools, 1)).toFixed(0)}%` +
      ` | mean tools proposed when narrowing ${fixed(proposals.proposedTools.mean, 1)}`,
  );
  lines.push(`\napplication status\n${table(application.statuses)}`);
  lines.push(`\nskill reason\n${table(skills.reasons)}`);
  lines.push(`\nskills selected (per decision)\n${table(skills.selected)}`);
  lines.push(
    `\nclassifier latency p50/p90/max: ${fixed(latency.p50, 0)} / ${fixed(latency.p90, 0)} / ${fixed(latency.max, 0)} ms`,
  );
  if (coverage.duplicatesRemoved.decisions > 0) {
    lines.push(`\nnote: ${coverage.duplicatesRemoved.decisions} duplicate decision records removed (copied sessions)`);
  }
  if (coverage.unidentifiable.decisions > 0) {
    lines.push(
      `note: ${coverage.unidentifiable.decisions} v2 decision records have no event id and cannot be deduplicated`,
    );
  }
  return lines.join("\n");
}

function main(argv: string[]): number {
  const json = argv.includes("--json");
  const result = parseArgv(["summary", ...argv.filter((arg) => arg !== "--json")]);
  if (!result.ok) {
    console.error(`decisions: ${result.message}`);
    return 2;
  }
  if (result.parsed.kind !== "run") {
    console.log(`usage: node scripts/decisions.ts <loadout-report summary flags> [--json]\n\n${USAGE}`);
    return 0;
  }
  const summary = buildSummary(result.parsed.spec);
  if (summary.scope.files === 0) console.error("decisions: warning: no session files matched the scope");
  console.log(json ? JSON.stringify(summary, null, 2) : render(summary));
  return 0;
}

process.exitCode = main(process.argv.slice(2));

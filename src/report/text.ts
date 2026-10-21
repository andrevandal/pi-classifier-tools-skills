/**
 * The one text renderer over a `Summary`: `renderDecisions` for `scripts/decisions.ts`, and (with
 * `renderSummary`) `/loadout stats`. Pure functions; nothing here reads a file or a clock. It lives in `src/`
 * because `src/` ships in the npm package and `scripts/` does not.
 */

import type { Count, Stats, Summary } from "./summary.ts";

const fixed = (n: number | null, digits = 2): string => (n === null ? "-" : n.toFixed(digits));

export function renderDecisions(summary: Summary): string {
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

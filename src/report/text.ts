/**
 * The one text renderer over a `Summary`: `renderDecisions` for `scripts/decisions.ts`, and (with
 * `renderSummary`) `/loadout stats`. Pure functions; nothing here reads a file or a clock. It lives in `src/`
 * because `src/` ships in the npm package and `scripts/` does not.
 */

import type { Count, Lead, Stats, Sum, Summary } from "./summary.ts";

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

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Milliseconds, counts: one decimal at most (`3.2`, `22`). */
const ms = (value: number): string => String(Number(value.toFixed(1)));
const risk = (value: number): string => value.toFixed(2);

/** A `Sum`: `unknown` when nothing was known, `0` when nothing was expected, else the sum and how many values were unknown. */
function sumText(sum: Sum): string {
  if (sum.known === 0) return sum.unknown > 0 ? "unknown" : "0";
  const total = String(Number(sum.sum.toPrecision(12)));
  return sum.unknown > 0 ? `${total} (+${sum.unknown} unknown)` : total;
}

/** `Stats` as `p50 <v> / p90 <v>`, or `unknown` when it covers no value. */
function statsText(stats: unknown, format: (value: number) => string): string {
  if (!isObject(stats) || !finite(stats.n) || stats.n === 0 || !finite(stats.p50) || !finite(stats.p90))
    return "unknown";
  return `p50 ${format(stats.p50)} / p90 ${format(stats.p90)}`;
}

/** A count map as `<key> <n>, ...` in the order given. */
function countsText(counts: unknown): string {
  if (!isObject(counts)) return "";
  return Object.entries(counts)
    .filter(([, n]) => finite(n))
    .map(([key, n]) => `${key} ${n}`)
    .join(", ");
}

/** What a blocker counted, from the evidence `leadCandidates` (summary.ts) attaches; null when it attaches none. */
function evidenceText(lead: Lead): string | null {
  const e = lead.evidence;
  const numbers = (value: unknown, format: (n: number) => string): string =>
    Array.isArray(value) ? value.filter(finite).map(format).join(", ") : "";
  switch (lead.id) {
    case "classifier-failed":
      return [
        `failures ${countsText(e.failures)}`,
        ...(finite(e.guardFired) && e.guardFired > 0 ? [`guard fired ${e.guardFired}`] : []),
      ].join(" | ");
    case "low-confidence":
      return `closest narrower risk ${statsText(e.closestNarrowerRisk, risk)} (max risk ${numbers(e.maxRisk, risk) || "unknown"})${finite(e.riskUnknown) && e.riskUnknown > 0 ? `, risk unknown ${e.riskUnknown}` : ""}`;
    case "candidate-limit":
      return `eligible ${statsText(e.eligible, ms)}, limit ${numbers(e.maxCandidates, String) || "unknown"}`;
    case "application-failed":
      return `errors ${countsText(e.errors)}`;
    default:
      return null;
  }
}

/** The whole `/loadout stats` report for one summary; `renderDecisions` is embedded unchanged. */
export function renderSummary(summary: Summary): string {
  const { scope, coverage, classifier, usage, transcript, http } = summary;
  const { files } = coverage;
  const lines: string[] = [];

  lines.push(
    scope.kind === "session"
      ? `scope: session files | files ${scope.files} (read ${files.read}, unreadable ${files.unreadable}) | child sessions not read ${scope.childFilesNotRead}${scope.childDirsUnreadable > 0 ? " (at least; a directory was unreadable)" : ""}`
      : `scope: history ${scope.since} to ${scope.until} (UTC, until exclusive) | ${scope.projects === "all-projects" ? "all projects" : "exact project match"} | files ${scope.files} (read ${files.read}, unreadable ${files.unreadable}, skipped by mtime ${files.skippedByMtime}) | nested child sessions read separately ${scope.nestedChildFiles}`,
  );
  if (scope.files === 0) lines.push("no session files matched this scope; every count is zero");
  lines.push(renderDecisions(summary));

  if (summary.leads.length === 0) {
    lines.push("blockers: none recorded in this scope");
  } else {
    lines.push("blockers (counts, each out of the population shown; descriptive, no cause implied)");
    for (const lead of summary.leads) {
      const evidence = evidenceText(lead);
      lines.push(`  ${lead.id}: ${lead.count} of ${lead.of}${evidence === null ? "" : ` | ${evidence}`}`);
    }
  }

  const { server, guardFired, promptClipped, requestIds } = classifier;
  lines.push(`classifier calls (loadout.decision attempts; not model turns): ${classifier.attempts}`);
  lines.push(`  tokens: in ${sumText(classifier.tokens.input)}, out ${sumText(classifier.tokens.output)}`);
  lines.push(
    `  server timing: reported ${server.reported}, not reported ${server.unreported} | queue ${statsText(server.queueMs, ms)} | inference ${statsText(server.inferenceMs, ms)}`,
  );
  lines.push(
    `  guard fired: ${guardFired.yes} yes, ${guardFired.no} no, ${guardFired.unknown} unknown | prompt clipped: ${promptClipped.yes} yes, ${promptClipped.no} no, ${promptClipped.unknown} unknown | request ids: ${requestIds.present} present, ${requestIds.absent} absent`,
  );
  if (Object.keys(classifier.models).length > 0) lines.push(`  models: ${countsText(classifier.models)}`);

  const { tokens } = usage;
  const outcomes = Object.fromEntries(Object.entries(usage.outcomes).filter(([, n]) => n > 0));
  const byTool = countsText(usage.toolCalls.byTool);
  lines.push(`model turns (loadout.usage; separate from classifier calls): ${usage.turns} in ${usage.runs} runs`);
  lines.push(`  hosts: ${countsText(usage.hosts) || "none"} | outcomes: ${countsText(outcomes) || "none"}`);
  lines.push(`  assigned to a decision: ${usage.assignment.assigned}, unassigned: ${usage.assignment.unassigned}`);
  lines.push(
    `  tokens: input ${sumText(tokens.input)}, output ${sumText(tokens.output)}, cache read ${sumText(tokens.cacheRead)}, cache write ${sumText(tokens.cacheWrite)}, reasoning ${sumText(tokens.reasoning)}`,
  );
  lines.push(`  cost: ${sumText(usage.cost)} (the host's own pricing, not a bill)`);
  lines.push(
    `  tool calls: ${usage.toolCalls.total}${byTool === "" ? "" : ` (${byTool})`} | tool errors: ${sumText(usage.toolErrors)}`,
  );
  lines.push(`  retries: reported ${usage.retries.reported}, unreported ${usage.retries.unreported}`);

  lines.push(
    `host transcript turns (the host's own messages, never added to the model-turn figures): ${transcript.turns}`,
  );
  if (transcript.turns > 0) {
    lines.push(
      `  tokens: input ${sumText(transcript.tokens.input)}, output ${sumText(transcript.tokens.output)} | cost ${sumText(transcript.cost)}`,
    );
  }

  lines.push(
    http === null
      ? "service log: not read (--service-log <file> joins server records by request id)"
      : `service log: ${http.records} records in ${http.files} files | joined ${http.joined} of ${classifier.attempts} attempts | attempts without a record ${http.unmatched.clientWithoutRecord}, not joinable (not HTTP) ${http.unmatched.notJoinable}, records not in scope ${http.unmatched.recordsNotInScope}, no request id ${http.unmatched.recordsWithoutRequestId}, ambiguous ${http.unmatched.ambiguous} | client timeouts ${http.timeouts.clientTimeouts} (joined ${http.timeouts.joined})`,
  );

  const removed = Object.values(coverage.removedByFilters);
  const removedTotal = removed.reduce((sum, c) => sum + c.outsideRange + c.unplaced + c.branch + c.outcome, 0);
  const unplaced = removed.reduce((sum, c) => sum + c.unplaced, 0);
  lines.push(
    `coverage: files read ${files.read}, unreadable ${files.unreadable}, without header ${files.withoutHeader} | malformed lines ${coverage.malformedLines} | unsupported records: decisions ${coverage.unsupported.decisions}, model turns ${coverage.unsupported.usage} | duplicates removed: decisions ${coverage.duplicatesRemoved.decisions}, model turns ${coverage.duplicatesRemoved.usage} | v2 decisions without event id ${coverage.unidentifiable.decisions}${removedTotal > 0 ? ` | removed by the window or filters ${removedTotal} (no timestamp ${unplaced})` : ""}`,
  );
  lines.push(
    "read as: identifiers are local metadata; unknown is not zero; usage is observed, not billed; child sessions are not rolled up",
  );
  return lines.join("\n");
}

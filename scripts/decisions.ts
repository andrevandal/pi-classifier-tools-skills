/**
 * Summarize `loadout.decision` entries across session transcripts: how often
 * each profile was picked, how much risk the classifier left, which skills it
 * selected, and what it cost in latency.
 *
 *   node scripts/decisions.ts [--folder <substr>] [--since 7d|24h|<ISO date>] [--sessions-dir <dir>] [--json]
 */

import * as fs from "node:fs";
import { parseArgs } from "node:util";

import {
  type Decision,
  defaultSessionsDir,
  listSessionFiles,
  metricsFor,
  percentile,
  sessionCwd,
} from "./lib/sessions.ts";

const { values } = parseArgs({
  options: {
    folder: { type: "string" },
    since: { type: "string" },
    "sessions-dir": { type: "string", default: defaultSessionsDir() },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(
    "usage: node scripts/decisions.ts [--folder <substr>] [--since 7d|24h|<ISO>] [--sessions-dir <dir>] [--json]",
  );
  process.exit(0);
}

function parseSince(value: string | undefined): number | null {
  if (!value) return null;
  const relative = /^(\d+)([hd])$/.exec(value);
  if (relative) return Date.now() - Number(relative[1]) * (relative[2] === "d" ? 86_400_000 : 3_600_000);
  const absolute = Date.parse(value);
  if (Number.isNaN(absolute)) throw new Error(`--since: expected 7d, 24h or an ISO date, got "${value}"`);
  return absolute;
}

const since = parseSince(values.since);
const files = listSessionFiles(values["sessions-dir"]!).filter((file) => {
  if (since !== null && fs.statSync(file).mtimeMs < since) return false;
  if (!values.folder) return true;
  return (sessionCwd(file) ?? file).includes(values.folder);
});
const metrics = metricsFor(files);

function countBy<T>(items: T[], key: (item: T) => string | string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    for (const value of [key(item)].flat()) counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([, a], [, b]) => b - a));
}

function summarize(all: Decision[], unsupported: number) {
  const list = all.filter((d) => d.outcome !== "skipped");
  const decided = list.flatMap((d) => (d.tools === null ? [] : [d.tools]));
  const risks = decided.flatMap((t) => (t.risk === null ? [] : [t.risk]));
  const narrowed = decided.flatMap((t) => (t.active === null ? [] : [t.active]));
  const latencies = list.flatMap((d) => (d.latencyMs === null ? [] : [d.latencyMs]));
  return {
    decisions: list.length,
    sessions: new Set(list.map((d) => d.file)).size,
    dryRun: list.filter((d) => d.dryRun === true).length,
    failures: countBy(
      list.flatMap((d) => (d.failure === null ? [] : [d.failure])),
      (reason) => reason,
    ),
    toolProfiles: countBy(list, (d) => d.tools?.profile ?? "(none)"),
    toolReasons: countBy(list, (d) => d.tools?.reason ?? "failed"),
    keptBaselineRate:
      decided.length === 0 ? 0 : decided.filter((t) => t.reason === "low-confidence").length / decided.length,
    risk: {
      p10: percentile(risks, 10),
      p50: percentile(risks, 50),
      p90: percentile(risks, 90),
    },
    avgActiveTools: narrowed.length === 0 ? null : narrowed.reduce((s, a) => s + a.length, 0) / narrowed.length,
    skillReasons: countBy(list, (d) => d.skills?.reason ?? "failed"),
    skillsSelected: countBy(
      list.flatMap((d) => (d.skills?.selected ? [d.skills.selected] : [])),
      (selected) => (selected.length > 0 ? selected : ["(none)"]),
    ),
    latencyMs: { p50: percentile(latencies, 50), p90: percentile(latencies, 90), max: Math.max(...latencies, 0) },
    skipped: countBy(
      all.filter((d) => d.outcome === "skipped"),
      (d) => d.skip ?? "(unknown)",
    ),
    unsupported,
  };
}

const inRange = metrics.decisions.filter((d) => since === null || Date.parse(d.timestamp ?? "") >= since);
const report = summarize(inRange, metrics.unsupportedDecisions);

if (values.json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const fixed = (n: number | null, digits = 2) => (n === null || Number.isNaN(n) ? "-" : n.toFixed(digits));
const table = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(
      ([key, count]) =>
        `  ${key.padEnd(24)} ${String(count).padStart(5)}  ${pct(count / Math.max(report.decisions, 1))}`,
    )
    .join("\n") || "  (none)";

console.log(`loadout decisions: ${report.decisions} in ${report.sessions} sessions (${report.dryRun} dry run)`);
const skippedText = Object.entries(report.skipped)
  .map(([reason, n]) => `${reason} ${n}`)
  .join(", ");
if (skippedText) console.log(`skipped: ${skippedText}`);
if (report.unsupported > 0) {
  console.log(`unsupported records: ${report.unsupported} (unknown version or shape; not counted above)`);
}
if (report.decisions === 0) {
  console.log("no loadout.decision entries matched; check --sessions-dir, --folder and --since");
  process.exit(0);
}
console.log(`\ntool profile\n${table(report.toolProfiles)}`);
console.log(`\ntool reason\n${table(report.toolReasons)}`);
console.log(`\nfailures\n${table(report.failures)}`);
console.log(
  `\nrisk p10/p50/p90: ${fixed(report.risk.p10)} / ${fixed(report.risk.p50)} / ${fixed(report.risk.p90)}` +
    ` | kept baseline (low-confidence) ${pct(report.keptBaselineRate)} | avg active tools when narrowed ${fixed(report.avgActiveTools, 1)}`,
);
console.log(`\nskill reason\n${table(report.skillReasons)}`);
console.log(`\nskills selected (per decision)\n${table(report.skillsSelected)}`);
console.log(
  `\nclassifier latency p50/p90/max: ${report.latencyMs.p50} / ${report.latencyMs.p90} / ${report.latencyMs.max} ms`,
);

/**
 * Summarize `loadout.decision` entries across session transcripts: how often
 * each profile was picked, how confident the classifier was, which skills it
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
const decisions = metricsFor(files).decisions.filter(
  (decision) => since === null || Date.parse(decision.timestamp ?? "") >= since,
);

function countBy<T>(items: T[], key: (item: T) => string | string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    for (const value of [key(item)].flat()) counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([, a], [, b]) => b - a));
}

function summarize(list: Decision[]) {
  const confidences = list.map((d) => d.tools.confidence).filter((c) => c > 0);
  const latencies = list.map((d) => d.latencyMs);
  const narrowed = list.filter((d) => d.tools.active !== null);
  return {
    decisions: list.length,
    sessions: new Set(list.map((d) => d.file)).size,
    dryRun: list.filter((d) => d.dryRun).length,
    toolProfiles: countBy(list, (d) => d.tools.profile ?? "(none)"),
    toolReasons: countBy(list, (d) => d.tools.reason),
    lowConfidenceRate:
      list.length === 0 ? 0 : list.filter((d) => d.tools.reason === "low-confidence").length / list.length,
    confidence: {
      p10: percentile(confidences, 10),
      p50: percentile(confidences, 50),
      p90: percentile(confidences, 90),
    },
    avgActiveTools:
      narrowed.length === 0 ? null : narrowed.reduce((s, d) => s + (d.tools.active?.length ?? 0), 0) / narrowed.length,
    skillReasons: countBy(list, (d) => d.skills.reason),
    skillsSelected: countBy(
      list.filter((d) => d.skills.selected !== null),
      (d) => (d.skills.selected!.length > 0 ? d.skills.selected! : ["(none)"]),
    ),
    latencyMs: { p50: percentile(latencies, 50), p90: percentile(latencies, 90), max: Math.max(...latencies, 0) },
  };
}

const report = summarize(decisions);

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
if (report.decisions === 0) {
  console.log("no loadout.decision entries matched; check --sessions-dir, --folder and --since");
  process.exit(0);
}
console.log(`\ntool profile\n${table(report.toolProfiles)}`);
console.log(`\ntool reason\n${table(report.toolReasons)}`);
console.log(
  `\nconfidence p10/p50/p90: ${fixed(report.confidence.p10)} / ${fixed(report.confidence.p50)} / ${fixed(report.confidence.p90)}` +
    ` | low-confidence rate ${pct(report.lowConfidenceRate)} | avg active tools when narrowed ${fixed(report.avgActiveTools, 1)}`,
);
console.log(`\nskill reason\n${table(report.skillReasons)}`);
console.log(`\nskills selected (per decision)\n${table(report.skillsSelected)}`);
console.log(
  `\nclassifier latency p50/p90/max: ${report.latencyMs.p50} / ${report.latencyMs.p90} / ${report.latencyMs.max} ms`,
);

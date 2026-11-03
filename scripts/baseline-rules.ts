#!/usr/bin/env node
/**
 * Context rules, no model: predict a turn's profile from what the session already did, and score them on the newest
 * part of a file written by `scripts/mine-labels.ts`. A first turn has no context, so every rule keeps `full` there.
 *
 *   node scripts/baseline-rules.ts --labels <jsonl> [--test 0.3]
 */

import fs from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { labels: { type: "string" }, test: { type: "string", default: "0.3" } },
  strict: true,
});
if (!values.labels) {
  console.error("usage: node scripts/baseline-rules.ts --labels <jsonl> [--test 0.3]");
  process.exit(2);
}

const ORDER = ["answer", "edit", "full"];

interface Row {
  expect: string;
  prev: string | null;
  history: string | null;
}

const RULES: Record<string, (row: Row) => string> = {
  "keep last turn's profile": (row) => row.prev ?? "full",
  "keep the session's widest profile so far": (row) => row.history ?? "full",
};

const all = fs
  .readFileSync(values.labels, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Row);
const test = all.slice(Math.floor(all.length * (1 - Number(values.test))));
const share = (n: number, d: number) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}% (${n}/${d})`);

console.log(`test ${test.length}; first turns ${test.filter((row) => row.prev === null).length} (kept full)\n`);
console.log(
  "| rule | narrowed | over-narrowed (of narrowed) | over-narrowed (of all) | exact |\n| --- | --- | --- | --- | --- |",
);
for (const [name, rule] of Object.entries(RULES)) {
  let narrowed = 0;
  let over = 0;
  let exact = 0;
  for (const row of test) {
    const chosen = ORDER.indexOf(rule(row));
    const expected = ORDER.indexOf(row.expect);
    if (chosen < ORDER.length - 1) narrowed++;
    if (chosen < expected) over++;
    if (chosen === expected) exact++;
  }
  console.log(
    `| ${name} | ${share(narrowed, test.length)} | ${share(over, narrowed)} | ${share(over, test.length)} | ${share(exact, test.length)} |`,
  );
}

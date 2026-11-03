#!/usr/bin/env node
/**
 * A no-GPU baseline for the tool-profile question: multinomial naive Bayes over word unigrams and bigrams, trained
 * on the older part of a labeled file and scored on the newest part, through the same `pickProfile` rule the plugin
 * uses. A classifier worth shipping has to beat this.
 *
 *   node scripts/baseline-tools.ts --labels <jsonl> [--test 0.3]
 *
 * `--labels` is the output of `scripts/mine-labels.ts` (sorted by time; the split is chronological).
 */

import fs from "node:fs";
import { parseArgs } from "node:util";

import { pickProfile } from "../src/select.ts";

const { values } = parseArgs({
  options: { labels: { type: "string" }, test: { type: "string", default: "0.3" } },
  strict: true,
});
const testShare = Number(values.test);
if (!values.labels || !(testShare > 0 && testShare < 1)) {
  console.error(
    "usage: node scripts/baseline-tools.ts --labels <jsonl> [--test 0.3]  (--test is a share between 0 and 1)",
  );
  process.exit(2);
}

const ORDER = ["answer", "edit", "full"];
const RISKS = [0.02, 0.05, 0.1, 0.2, 0.3, 0.5];
const ALPHA = 0.5;

interface Row {
  prompt: string;
  expect: string;
}

function features(prompt: string): string[] {
  const words = prompt
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1);
  return [...words, ...words.slice(1).map((word, i) => `${words[i]} ${word}`)];
}

function train(rows: Row[]) {
  const counts: Record<string, Map<string, number>> = {};
  const totals: Record<string, number> = {};
  const docs: Record<string, number> = {};
  const vocab = new Set<string>();
  for (const label of ORDER) {
    counts[label] = new Map();
    totals[label] = 0;
    docs[label] = 0;
  }
  for (const row of rows) {
    docs[row.expect] = (docs[row.expect] ?? 0) + 1;
    for (const feature of features(row.prompt)) {
      vocab.add(feature);
      counts[row.expect]!.set(feature, (counts[row.expect]!.get(feature) ?? 0) + 1);
      totals[row.expect] = (totals[row.expect] ?? 0) + 1;
    }
  }
  return (prompt: string): Record<string, number> => {
    const logs = ORDER.map((label) => {
      let score = Math.log((docs[label]! + 1) / (rows.length + ORDER.length));
      for (const feature of features(prompt)) {
        score += Math.log(((counts[label]!.get(feature) ?? 0) + ALPHA) / (totals[label]! + ALPHA * vocab.size));
      }
      return score;
    });
    const top = Math.max(...logs);
    const exp = logs.map((score) => Math.exp(score - top));
    const sum = exp.reduce((a, b) => a + b, 0);
    return Object.fromEntries(ORDER.map((label, i) => [label, exp[i]! / sum]));
  };
}

const all = fs
  .readFileSync(values.labels, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Row)
  .filter((row) => ORDER.includes(row.expect));
const cut = Math.floor(all.length * (1 - Number(values.test)));
const trainRows = all.slice(0, cut);
const testRows = all.slice(cut);
const predict = train(trainRows);

const dist = (rows: Row[]) =>
  ORDER.map((label) => `${label} ${rows.filter((r) => r.expect === label).length}`).join(", ");
console.log(`train ${trainRows.length} (${dist(trainRows)})\ntest  ${testRows.length} (${dist(testRows)})\n`);

const scored = testRows.map((row) => ({ row, probabilities: predict(row.prompt) }));
const accuracy =
  scored.filter(
    ({ row, probabilities }) =>
      ORDER.reduce((best, label) => (probabilities[label]! > probabilities[best]! ? label : best)) === row.expect,
  ).length / scored.length;
console.log(
  `argmax accuracy ${(accuracy * 100).toFixed(1)}% (always-full: ${(
    (testRows.filter((r) => r.expect === "full").length / testRows.length) * 100
  ).toFixed(1)}%)\n`,
);

console.log("| maxRisk | narrowed | over-narrowed (of narrowed) | over-narrowed (of all) |\n| --- | --- | --- | --- |");
for (const risk of RISKS) {
  let narrowed = 0;
  let over = 0;
  for (const { row, probabilities } of scored) {
    const picked = pickProfile(ORDER, probabilities, risk);
    if (!picked) continue;
    narrowed++;
    if (ORDER.indexOf(picked.profile) < ORDER.indexOf(row.expect)) over++;
  }
  const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}% (${n}/${d})`);
  console.log(`| ${risk} | ${pct(narrowed, scored.length)} | ${pct(over, narrowed)} | ${pct(over, scored.length)} |`);
}

#!/usr/bin/env node
/**
 * Measures the classifier's tool selection against labeled prompts, and proposes
 * a `tools.maxRisk` from the result.
 *
 *   node scripts/eval-classifier.ts --labels <jsonl> [--config <json>] [--json]
 *   node scripts/eval-classifier.ts --mine --out <jsonl> [--sessions-dir <dir>] [--since 30d]
 *
 * A label is `{ "id", "prompt", "expect" }` per line, where `expect` is the profile
 * the prompt needs. `--mine` collects first prompts from past sessions without
 * `expect`; label them by hand before evaluating.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { createClassifier } from "../src/classify/index.ts";
import { parseConfig } from "../src/config.ts";
import { buildQuestions, clipPrompt, pickProfile, profileOrder, TOOLS_QUESTION_ID } from "../src/select.ts";
import type { Classifier, LoadoutConfig } from "../src/types.ts";
import { errorText } from "../src/turn.ts";
import { defaultSessionsDir, listSessionFiles } from "../src/report/read.ts";

const USAGE = `usage: node scripts/eval-classifier.ts --labels <jsonl> [--config <json>] [--json]
       node scripts/eval-classifier.ts --mine --out <jsonl> [--sessions-dir <dir>] [--since 30d]

  --labels <jsonl>       one { "id", "prompt", "expect" } per line; expect is a profile id
  --config <json>        loadout config to evaluate (default: built-in defaults)
  --json                 print the results as JSON instead of markdown
  --mine                 collect first prompts from past sessions instead of evaluating
  --out <jsonl>          with --mine: where to write the candidates (no expect yet)
  --sessions-dir <dir>   with --mine: default ~/.omp/agent/sessions
  --since <n>d           with --mine: only sessions modified in the last n days (default 30d)
`;

const { values } = parseArgs({
  options: {
    labels: { type: "string" },
    config: { type: "string" },
    json: { type: "boolean", default: false },
    mine: { type: "boolean", default: false },
    out: { type: "string" },
    "sessions-dir": { type: "string" },
    since: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

/** maxRisk levels to compare, from none to half the probability mass. */
const RISK_LEVELS = [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5];
/** A level is recommended only if its 95% upper bound on over-narrowing is at most this. */
const TARGET_OVER_NARROW = 0.05;
/** Labels needed before a level with no over-narrowing meets the bound: with zero successes the Wilson upper bound is about z^2 / (n + z^2). */
const LABELS_FOR_ZERO_OVER = Math.ceil(1.96 ** 2 * (1 / TARGET_OVER_NARROW - 1));
/** How long to wait for a warming backend before giving up. */
const WARMUP_LIMIT_MS = 600_000;
/** Shorter first prompts are rarely about tool selection, so `--mine` drops them. */
const MIN_PROMPT_CHARS = 20;

interface Label {
  id: string;
  prompt: string;
  expect: string;
}

interface Row extends Label {
  /** Tool probabilities by profile, or null when the backend gave no usable answer. */
  probabilities: Record<string, number> | null;
  error: string | null;
}

interface Judged {
  expect: string;
  chosen: string;
  narrowed: boolean;
}

interface RiskRow {
  risk: number;
  scored: number;
  coverage: number;
  overNarrowed: number;
  overRate: number;
  overUpper: number;
  underNarrowed: number;
}

interface Report {
  backend: string;
  maxRisk: number;
  order: string[];
  labels: number;
  failures: { id: string; error: string }[];
  confusion: { expect: string; counts: number[] }[];
  risks: RiskRow[];
  recommended: number | null;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

/** Upper bound of the 95% Wilson score interval for `k` successes in `n` trials. */
function wilsonUpper(k: number, n: number): number {
  if (n === 0) return 1;
  const z = 1.96;
  const p = k / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (center + margin) / (1 + (z * z) / n);
}

function loadConfig(file: string | undefined): LoadoutConfig {
  const raw: unknown = file === undefined ? {} : JSON.parse(fs.readFileSync(file, "utf8"));
  const { config, errors } = parseConfig(raw);
  if (errors.length > 0) fail(`config: ${errors.join("; ")}`);
  return config;
}

function loadLabels(file: string, order: string[]): Label[] {
  const labels: Label[] = [];
  for (const [index, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
    if (line.trim() === "") continue;
    const where = `${file}:${index + 1}`;
    const row: Partial<Label> = JSON.parse(line);
    if (typeof row.id !== "string" || typeof row.prompt !== "string") {
      fail(`${where}: needs string "id" and "prompt"`);
    }
    if (typeof row.expect !== "string" || !order.includes(row.expect)) {
      fail(`${where}: "expect" must be a profile id (${order.join(", ")}); label the prompt by hand`);
    }
    labels.push({ id: row.id, prompt: row.prompt, expect: row.expect });
  }
  if (labels.length === 0) fail(`${file}: no labels`);
  return labels;
}

async function startUp(classifier: Classifier): Promise<void> {
  try {
    await classifier.warmup?.();
  } catch (error) {
    fail(`${classifier.name} warm-up failed: ${errorText(error)}`);
  }
  const deadline = Date.now() + WARMUP_LIMIT_MS;
  while (classifier.readiness() === "warming") {
    if (Date.now() > deadline) fail(`${classifier.name} still warming after ${WARMUP_LIMIT_MS / 1000}s`);
    await sleep(1000);
  }
  if (classifier.readiness() === "failed") fail(`${classifier.name} failed to start`);
}

async function classifyAll(labels: Label[], classifier: Classifier, config: LoadoutConfig): Promise<Row[]> {
  const questions = buildQuestions(config, []);
  const rows: Row[] = [];
  for (const [index, label] of labels.entries()) {
    console.error(`[${index + 1}/${labels.length}] ${label.id}`);
    try {
      const result = await classifier.classify(clipPrompt(label.prompt, config.maxPromptChars), questions);
      const answer = result.answers[TOOLS_QUESTION_ID];
      const probabilities = answer?.type === "choice" ? (answer.probabilities ?? null) : null;
      rows.push({ ...label, probabilities, error: probabilities === null ? "no tools answer" : null });
    } catch (error) {
      rows.push({ ...label, probabilities: null, error: errorText(error) });
    }
  }
  return rows;
}

/** The profile each usable row would get at `risk`; the baseline when nothing is narrow enough. */
function judge(rows: Row[], order: string[], risk: number): Judged[] {
  const baseline = order.at(-1) ?? "";
  return rows.flatMap((row) => {
    if (row.probabilities === null) return [];
    const picked = pickProfile(order, row.probabilities, risk);
    return [{ expect: row.expect, chosen: picked?.profile ?? baseline, narrowed: picked !== null }];
  });
}

function buildReport(config: LoadoutConfig, order: string[], rows: Row[]): Report {
  const rank = (profile: string) => order.indexOf(profile);
  const risks: RiskRow[] = RISK_LEVELS.map((risk) => {
    const judged = judge(rows, order, risk);
    const scored = judged.length;
    const overNarrowed = judged.filter((j) => rank(j.chosen) < rank(j.expect)).length;
    const underNarrowed = judged.filter((j) => rank(j.chosen) > rank(j.expect)).length;
    return {
      risk,
      scored,
      coverage: scored === 0 ? 0 : judged.filter((j) => j.narrowed).length / scored,
      overNarrowed,
      overRate: scored === 0 ? 0 : overNarrowed / scored,
      overUpper: wilsonUpper(overNarrowed, scored),
      underNarrowed,
    };
  });

  const current = judge(rows, order, config.tools.maxRisk);
  const confusion = order.map((expect) => ({
    expect,
    counts: order.map((chosen) => current.filter((j) => j.expect === expect && j.chosen === chosen).length),
  }));
  const passing = risks.filter((r) => r.coverage > 0 && r.overUpper <= TARGET_OVER_NARROW);

  return {
    backend: config.backend,
    maxRisk: config.tools.maxRisk,
    order,
    labels: rows.length,
    failures: rows.flatMap((row) =>
      row.probabilities === null ? [{ id: row.id, error: row.error ?? "no tools answer" }] : [],
    ),
    confusion,
    risks,
    recommended: passing.at(-1)?.risk ?? null,
  };
}

function renderMarkdown(report: Report): string {
  const row = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;
  const lines = [
    `# classifier eval`,
    ``,
    `backend \`${report.backend}\`: ${report.labels} labels, ${report.failures.length} failed. Configured maxRisk ${report.maxRisk}.`,
    ``,
    `## Confusion at maxRisk ${report.maxRisk}`,
    ``,
    `Rows are the expected profile, columns the chosen one, narrowest first. The last column is the baseline.`,
    ``,
    row(["expect", ...report.order]),
    row(["---", ...report.order.map(() => "---:")]),
    ...report.confusion.map((line) => row([line.expect, ...line.counts])),
    ``,
    `## maxRisk`,
    ``,
    `Over-narrowed: a narrower profile than expected, so a needed tool goes missing. Under-narrowed: broader than needed, so savings are lost. The upper bound is the 95% Wilson score interval on the over-narrowed rate.`,
    ``,
    row(["maxRisk", "narrowed", "over-narrowed", "over rate", "95% upper", "under-narrowed"]),
    row(["---:", "---:", "---:", "---:", "---:", "---:"]),
    ...report.risks.map((r) =>
      row([
        r.risk,
        pct(r.coverage),
        `${r.overNarrowed}/${r.scored}`,
        pct(r.overRate),
        pct(r.overUpper),
        r.underNarrowed,
      ]),
    ),
    ``,
    report.recommended === null
      ? `recommended maxRisk: none. No level keeps the 95% upper bound on over-narrowing at or below ${pct(TARGET_OVER_NARROW)} with ${report.labels} labels. Even zero over-narrowing needs ${LABELS_FOR_ZERO_OVER} labels to meet it; keep ${report.maxRisk}.`
      : `recommended maxRisk: ${report.recommended} (95% upper bound on over-narrowing <= ${pct(TARGET_OVER_NARROW)}).`,
  ];
  if (report.failures.length > 0) {
    lines.push("", "## Failures", "", ...report.failures.map((f) => `- ${f.id}: ${f.error}`));
  }
  return `${lines.join("\n")}\n`;
}

async function evaluate(): Promise<void> {
  const labelsFile = values.labels;
  if (!labelsFile) fail("eval needs --labels <jsonl> (or --mine to collect candidates)");
  const config = loadConfig(values.config);
  if (!config.tools.enabled) fail("tools.enabled is false, so there is no tools decision to evaluate");
  const order = profileOrder(config.tools);
  const labels = loadLabels(path.resolve(labelsFile), order);

  const classifier = createClassifier(config);
  try {
    await startUp(classifier);
    const rows = await classifyAll(labels, classifier, config);
    const report = buildReport(config, order, rows);
    console.log(values.json ? JSON.stringify(report, null, 2) : renderMarkdown(report));
    if (report.failures.length === report.labels) {
      process.exitCode = 2;
      console.error("every label failed: the backend is not answering");
    }
  } finally {
    await classifier.dispose();
  }
}

function sinceCutoff(since: string): number {
  const match = /^(\d+)d$/.exec(since);
  if (match === null) fail(`--since must look like 30d, got "${since}"`);
  return Date.now() - Number(match[1]) * 86_400_000;
}

/** The text of the first user message in a session file, or null if it has none. */
function firstUserPrompt(file: string): string | null {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry.message;
    if (entry.type !== "message" || message?.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content.trim();
    const parts: { type?: string; text?: string }[] = Array.isArray(content) ? content : [];
    return parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();
  }
  return null;
}

function mine(): void {
  const out = values.out;
  if (!out) fail("--mine needs --out <jsonl>");
  const root = values["sessions-dir"] ?? defaultSessionsDir();
  const cutoff = sinceCutoff(values.since ?? "30d");

  const seen = new Set<string>();
  const found: { id: string; prompt: string }[] = [];
  let sessions = 0;
  for (const file of listSessionFiles(root)) {
    // Advisor and subagent sessions are named `__<role>`; their "user" turns are injected, not typed.
    if (path.basename(file).startsWith("__") || fs.statSync(file).mtimeMs < cutoff) continue;
    sessions++;
    const prompt = firstUserPrompt(file);
    if (prompt === null || prompt.startsWith("/") || prompt.startsWith("### ")) continue;
    if (prompt.length < MIN_PROMPT_CHARS || seen.has(prompt)) continue;
    seen.add(prompt);
    found.push({ id: path.basename(file, ".jsonl"), prompt });
  }
  fs.writeFileSync(out, found.map((row) => `${JSON.stringify(row)}\n`).join(""));
  console.log(
    `mined ${found.length} prompts from ${sessions} sessions into ${out}. Add "expect" to each line before evaluating.`,
  );
}

if (values.mine) mine();
else await evaluate();

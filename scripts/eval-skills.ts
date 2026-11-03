/**
 * Measures skill selection against the skills real sessions read.
 *
 * The label is a `skill://<name>` read in a past session, joined to that session's first prompt, so it is the
 * agent's choice, not ground truth: an unread skill may still have been relevant. `--noise` adds skills from
 * other catalogs that are never labeled, so they only act as distractors.
 *
 *   node scripts/eval-skills.ts [--noise <dir>]... [--k 10] [--negatives 60] [--config <json>]
 *
 * Compares: the lexical ranker alone, the classifier over the whole pool (in `maxCandidates` chunks), and the
 * lexical top-K handed to the classifier, for each question wording.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { createClassifier } from "../src/classify/index.ts";
import { parseConfig } from "../src/config.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { rankSkills } from "../src/rank.ts";
import { skillQuestion, skillQuestionId } from "../src/select.ts";
import { defaultSessionsDir, listSessionFiles } from "../src/report/read.ts";
import type { Classifier, LoadoutConfig, NoulQuestion, SkillCandidate } from "../src/types.ts";

/** The fields of a session line this script reads. */
interface SessionLine {
  type?: string;
  customType?: string;
  message?: { role?: string; content?: unknown };
  data?: { args?: { path?: unknown } };
}

const { values } = parseArgs({
  options: {
    catalog: { type: "string", multiple: true },
    noise: { type: "string", multiple: true },
    since: { type: "string", default: "90d" },
    config: { type: "string" },
    k: { type: "string", default: "10" },
    negatives: { type: "string", default: "60" },
    ignore: { type: "string", multiple: true, default: ["using-superpowers"] },
    judged: { type: "string" },
  },
});

const HOME = process.env.HOME ?? "";
const WORDINGS: Record<string, (skill: SkillCandidate) => NoulQuestion> = {
  current: skillQuestion,
  strict: (skill) => ({
    type: "noul",
    instructions: `A user sent this request to a coding agent. Skill "${skill.name}": ${skill.description}\nDoes the request explicitly need this skill's specific workflow?`,
    criteria: {
      true: "the request names or clearly requires this skill's specific topic or workflow",
      false: "the request is generic, or about something else; general coding does not need this skill",
    },
  }),
};

function fail(message: string): never {
  console.error(`eval-skills: ${message}`);
  process.exit(2);
}

/** Every SKILL.md under `root`, as name and one-line description from its frontmatter. */
function readCatalog(root: string): SkillCandidate[] {
  const found: SkillCandidate[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") walk(full, depth + 1);
      if (entry.name !== "SKILL.md") continue;
      const front = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(full, "utf8"))?.[1] ?? "";
      const name =
        /^name:\s*(.+)$/m
          .exec(front)?.[1]
          ?.trim()
          .replace(/^["']|["']$/g, "") ?? path.basename(dir);
      const description = /^description:\s*(?:[>|][-+]?)?\s*([\s\S]*?)(?=\n[\w-]+:|$)/m.exec(front)?.[1] ?? "";
      found.push({ name, description: description.replace(/\s+/g, " ").trim() });
    }
  };
  walk(root, 0);
  return found;
}

interface Labeled {
  id: string;
  prompt: string;
  used: string[];
}

/** First prompts of top-level sessions and the catalog skills each session read. */
function mineSessions(known: Set<string>, ignore: Set<string>, sinceDays: number): Labeled[] {
  const cutoff = Date.now() - sinceDays * 86_400_000;
  const rows: Labeled[] = [];
  for (const file of listSessionFiles(defaultSessionsDir())) {
    const base = path.basename(file, ".jsonl");
    if (!/^\d{4}-\d\d-\d\dT/.test(base) || fs.statSync(file).mtimeMs < cutoff) continue;
    let prompt: string | null = null;
    const used = new Set<string>();
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (line === "") continue;
      let entry: SessionLine;
      try {
        entry = JSON.parse(line) as SessionLine;
      } catch {
        continue;
      }
      if (prompt === null && entry.type === "message" && entry.message?.role === "user") {
        const content = entry.message.content;
        const parts: { type?: string; text?: string }[] = Array.isArray(content) ? content : [];
        prompt = (
          typeof content === "string"
            ? content
            : parts
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("\n")
        ).trim();
        if (prompt === "") break;
      }
      const target = entry.data?.args?.path;
      if (prompt !== null && entry.customType === "tool_execution_start" && typeof target === "string") {
        const name = /^skill:\/\/([^/\s]+)/.exec(target)?.[1];
        if (name !== undefined && known.has(name) && !ignore.has(name)) used.add(name);
      }
    }
    if (
      prompt &&
      prompt.length >= 25 &&
      prompt.length <= 3000 &&
      !prompt.startsWith("/") &&
      !prompt.startsWith("### ")
    ) {
      rows.push({ id: base.slice(-12), prompt, used: [...used] });
    }
  }
  return rows;
}

interface Tally {
  ranks: number[];
  selected: number;
  prompts: number;
  hits: number;
  uses: number;
}

const newTally = (): Tally => ({ ranks: [], selected: 0, prompts: 0, hits: 0, uses: 0 });

function record(tally: Tally, used: string[], ranked: string[], selected: string[]): void {
  tally.prompts++;
  tally.selected += selected.length;
  for (const name of used) {
    tally.uses++;
    const rank = ranked.indexOf(name) + 1;
    if (rank > 0) tally.ranks.push(rank);
    else tally.ranks.push(Infinity);
    if (selected.includes(name)) tally.hits++;
  }
}

function row(label: string, t: Tally): string {
  const mrr = t.ranks.reduce((sum, r) => sum + 1 / r, 0) / Math.max(t.uses, 1);
  const at = (n: number) => (100 * t.ranks.filter((r) => r <= n).length) / Math.max(t.uses, 1);
  return `| ${label} | ${mrr.toFixed(2)} | ${at(3).toFixed(0)}% | ${at(10).toFixed(0)}% | ${((100 * t.hits) / Math.max(t.uses, 1)).toFixed(0)}% | ${(t.selected / Math.max(t.prompts, 1)).toFixed(1)} |`;
}

async function scoreChunks(
  classifier: Classifier,
  config: LoadoutConfig,
  prompt: string,
  pool: SkillCandidate[],
  wording: (skill: SkillCandidate) => NoulQuestion,
): Promise<Record<string, number>> {
  const scores: Record<string, number> = {};
  const size = config.skills.maxCandidates;
  for (let i = 0; i < pool.length; i += size) {
    const chunk = pool.slice(i, i + size);
    const questions: Record<string, NoulQuestion> = {};
    for (const skill of chunk) questions[skillQuestionId(skill.name)] = wording(skill);
    const result = await classifier.classify(prompt.slice(0, config.maxPromptChars ?? 8000), questions);
    for (const skill of chunk) {
      const answer = result.answers[skillQuestionId(skill.name)];
      if (answer?.type === "noul") scores[skill.name] = answer.noul;
    }
  }
  return scores;
}

const raw: unknown = values.config === undefined ? {} : JSON.parse(fs.readFileSync(values.config, "utf8"));
const { config, errors } = parseConfig(raw);
if (errors.length > 0) fail(`config: ${errors.join("; ")}`);
const k = Number(values.k);
const threshold = config.skills.threshold;

const own = (values.catalog ?? [`${HOME}/.omp/agent/skills`, `${HOME}/.omp/agent/managed-skills`]).flatMap(readCatalog);
const noise = (values.noise ?? []).flatMap(readCatalog);
const seen = new Set(own.map((skill) => skill.name));
const pool = [...own, ...noise.filter((skill) => !seen.has(skill.name))];
const labeled: Labeled[] = values.judged
  ? fs
      .readFileSync(values.judged, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const row = JSON.parse(line) as { id: string; prompt: string; skills: string[] };
        return { id: row.id, prompt: row.prompt, used: row.skills.filter((name) => seen.has(name)) };
      })
  : mineSessions(seen, new Set(values.ignore), Number.parseInt(values.since ?? "90d", 10));
const positives = labeled.filter((row) => row.used.length > 0);
const negatives = labeled.filter((row) => row.used.length === 0).slice(0, Number(values.negatives));
const sample = [...positives, ...negatives];
if (positives.length === 0) fail("no session read a catalog skill; check --catalog and --since");

const lexical = newTally();
const upper = newTally();
const classifier = createClassifier(config);
await classifier.warmup?.();
while (classifier.readiness() === "warming") await sleep(1000);

const whole: Record<string, Tally> = {};
const piped: Record<string, Tally> = {};
for (const name of Object.keys(WORDINGS)) {
  whole[name] = newTally();
  piped[name] = newTally();
}
try {
  for (const [index, item] of sample.entries()) {
    console.error(`[${index + 1}/${sample.length}] ${item.id}`);
    const ranked = rankSkills(item.prompt, pool).map((entry) => entry.skill);
    const top = ranked.slice(0, k);
    const names = ranked.map((skill) => skill.name);
    record(lexical, item.used, names, names.slice(0, k));
    record(upper, item.used, names, names.slice(0, k));
    for (const [name, wording] of Object.entries(WORDINGS)) {
      const all = await scoreChunks(classifier, config, item.prompt, pool, wording);
      const byScore = Object.entries(all)
        .sort((a, b) => b[1] - a[1])
        .map(([n]) => n);
      record(
        whole[name]!,
        item.used,
        byScore,
        byScore.filter((n) => all[n]! >= threshold),
      );
      const some = await scoreChunks(classifier, config, item.prompt, top, wording);
      const inTop = Object.entries(some)
        .sort((a, b) => b[1] - a[1])
        .map(([n]) => n);
      record(
        piped[name]!,
        item.used,
        inTop,
        inTop.filter((n) => some[n]! >= threshold),
      );
    }
  }
} finally {
  await classifier.dispose();
}

console.log(`# skill eval

Pool ${pool.length} skills (${own.length} yours, ${pool.length - own.length} noise). Sample ${sample.length} prompts: ${positives.length} where the agent read a skill (${positives.reduce((n, p) => n + p.used.length, 0)} reads), ${negatives.length} where it read none. Threshold ${threshold}, K ${k}.

"selected" is the share of reads the pipeline would have loaded; "per prompt" is how many skills it loads per prompt. Rank columns are over the pool.

| pipeline | MRR | rank<=3 | rank<=10 | selected | per prompt |
| --- | ---: | ---: | ---: | ---: | ---: |
${row(`lexical top ${k} (no model)`, lexical)}
${Object.keys(WORDINGS)
  .map((name) => row(`classifier on whole pool, ${name}`, whole[name]!))
  .join("\n")}
${Object.keys(WORDINGS)
  .map((name) => row(`lexical top ${k} then classifier, ${name}`, piped[name]!))
  .join("\n")}
`);

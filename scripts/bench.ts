/**
 * A/B benchmark: run the same tasks headless through omp in two git worktrees
 * of one repository and compare what each arm cost and whether it succeeded.
 *
 *   loadout  the plugin selects tools and skills
 *   control  the plugin runs in dry run: it classifies and records what it
 *            would have chosen, but changes nothing
 *
 * Both arms pay the classifier's overhead, so differences come from the
 * selection itself. Each arm gets its config through LOADOUT_CONFIG, so the
 * worktrees stay clean, and runs in its own folder, so `omp stats` separates
 * the arms too.
 *
 *   node scripts/bench.ts --repo <path> --tasks bench/tasks.json [--model <m>] [--runs 2]
 *
 * Worktrees are reset (`git reset --hard` + `git clean -fd`) before every run,
 * and only worktrees this script created are touched.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";

import {
  cacheRate,
  defaultSessionsDir,
  listSessionFiles,
  metricsFor,
  percentile,
  sessionCwd,
  totalToolCalls,
  type UsageMetrics,
} from "./lib/sessions.ts";

const USAGE = `usage: node scripts/bench.ts --repo <path> --tasks <file.json> [options]

  --repo <path>          git repository the tasks run against (required)
  --tasks <file>         JSON array of { id, prompt, check? } (required)
  --ref <rev>            commit every run starts from (default: HEAD)
  --model <model>        pin the model for both arms (recommended)
  --runs <n>             repetitions per task and arm (default: 1)
  --config <file>        base loadout config (default: ~/.omp/loadout.json, else built-in defaults)
  --setup <cmd>          run once in each new worktree, e.g. "npm ci"
  --out <dir>            results directory (default: bench-results/<timestamp>)
  --timeout-min <n>      per-run limit (default: 20)
  --omp <bin>            omp executable (default: omp)
  --sessions-dir <dir>   where omp writes sessions (default: ~/.omp/agent/sessions)`;

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    tasks: { type: "string" },
    ref: { type: "string", default: "HEAD" },
    model: { type: "string" },
    runs: { type: "string", default: "1" },
    config: { type: "string" },
    setup: { type: "string" },
    out: { type: "string" },
    "timeout-min": { type: "string", default: "20" },
    omp: { type: "string", default: "omp" },
    "sessions-dir": { type: "string", default: defaultSessionsDir() },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help || !values.repo || !values.tasks) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

interface Task {
  id: string;
  prompt: string;
  /** Shell command run in the worktree after the agent finishes; exit 0 = pass. */
  check?: string;
}

type Arm = "loadout" | "control";
const ARMS: Arm[] = ["loadout", "control"];

interface RunResult {
  run: number;
  task: string;
  arm: Arm;
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  pass: boolean | null;
  requests: number;
  errors: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheRate: number;
  cost: number;
  toolCalls: number;
  toolErrors: number;
  toolsUsed: Record<string, number>;
  profile: string | null;
  confidence: number | null;
  activeTools: number | null;
  skills: string[] | null;
  classifierMs: number | null;
  warning: string | null;
  sessionFiles: string[];
}

function fail(message: string): never {
  console.error(`bench: ${message}`);
  process.exit(1);
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) fail(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function loadTasks(file: string): Task[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const tasks = Array.isArray(raw) ? raw : raw?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) fail(`${file}: expected a non-empty array of tasks`);
  const ids = new Set<string>();
  for (const task of tasks) {
    if (typeof task?.id !== "string" || typeof task?.prompt !== "string")
      fail(`${file}: every task needs id and prompt`);
    if (ids.has(task.id)) fail(`${file}: duplicate task id "${task.id}"`);
    ids.add(task.id);
  }
  return tasks;
}

function loadBaseConfig(file: string | undefined): Record<string, unknown> {
  const fallback = path.join(os.homedir(), ".omp", "loadout.json");
  const source = file ?? (fs.existsSync(fallback) ? fallback : null);
  if (source === null) return {};
  const parsed = JSON.parse(fs.readFileSync(source, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    fail(`${source}: config must be an object`);
  return parsed;
}

function runOmp(task: Task, cwd: string, configFile: string, logFile: string, timeoutMs: number) {
  const args = [...(values.model ? ["--model", values.model] : []), "-p", task.prompt];
  const log = fs.openSync(logFile, "w");
  const started = Date.now();
  return new Promise<{ exitCode: number | null; timedOut: boolean; wallMs: number }>((resolve) => {
    const child = spawn(values.omp!, args, {
      cwd,
      env: { ...process.env, LOADOUT_CONFIG: configFile },
      stdio: ["ignore", log, log],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      fs.closeSync(log);
      resolve({ exitCode, timedOut, wallMs: Date.now() - started });
    };
    child.on("error", (error) => {
      fs.writeSync(log, `\nbench: could not start ${values.omp}: ${error.message}\n`);
      finish(null);
    });
    child.on("exit", (code) => finish(code));
  });
}

function summarizeRun(metrics: UsageMetrics, expectDryRun: boolean): Partial<RunResult> & { mismatch: boolean } {
  const decision = metrics.decisions[0];
  const mismatch = metrics.decisions.some((d) => d.dryRun !== expectDryRun);
  return {
    mismatch,
    profile: decision?.tools.profile ?? null,
    confidence: decision?.tools.confidence ?? null,
    activeTools: decision?.tools.active?.length ?? null,
    skills: decision?.skills.selected ?? null,
    classifierMs: decision?.latencyMs ?? null,
    warning: decision ? null : "no loadout.decision recorded (plugin not loaded, or the classifier failed)",
  };
}

const repo = path.resolve(values.repo);
const tasks = loadTasks(path.resolve(values.tasks));
const runs = Number.parseInt(values.runs!, 10);
const timeoutMs = Number(values["timeout-min"]) * 60_000;
if (!(runs >= 1)) fail("--runs must be at least 1");
if (!(timeoutMs > 0)) fail("--timeout-min must be positive");

const sha = git(repo, "rev-parse", values.ref!);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = path.resolve(values.out ?? path.join("bench-results", stamp));
if (fs.existsSync(out) && fs.readdirSync(out).length > 0) fail(`${out} already exists and is not empty`);
fs.mkdirSync(path.join(out, "logs"), { recursive: true });

const base = loadBaseConfig(values.config);
// Forget worktrees whose directories were deleted, e.g. an earlier results dir.
git(repo, "worktree", "prune");
const worktrees = {} as Record<Arm, string>;
const configs = {} as Record<Arm, string>;
for (const arm of ARMS) {
  configs[arm] = path.join(out, `loadout.${arm}.json`);
  const armConfig = { ...base, enabled: true, dryRun: arm === "control", notify: false };
  fs.writeFileSync(configs[arm], `${JSON.stringify(armConfig, null, 2)}\n`);

  worktrees[arm] = path.join(out, `wt-${arm}`);
  git(repo, "worktree", "add", "--detach", worktrees[arm], sha);
  worktrees[arm] = fs.realpathSync(worktrees[arm]);
  if (values.setup) {
    console.log(`[${arm}] setup: ${values.setup}`);
    const setup = spawnSync("sh", ["-c", values.setup], { cwd: worktrees[arm], stdio: "inherit" });
    if (setup.status !== 0) fail(`setup failed in ${worktrees[arm]}`);
  }
}

console.log(`bench: ${tasks.length} tasks x ${runs} runs x 2 arms at ${sha.slice(0, 10)} -> ${out}`);
const resultsFile = path.join(out, "results.jsonl");
const results: RunResult[] = [];

for (let run = 1; run <= runs; run++) {
  for (const [index, task] of tasks.entries()) {
    // Alternate which arm goes first so provider-side drift hits both equally.
    const order: Arm[] = (index + run) % 2 === 0 ? ["loadout", "control"] : ["control", "loadout"];
    for (const arm of order) {
      const cwd = worktrees[arm];
      git(cwd, "reset", "-q", "--hard", sha);
      git(cwd, "clean", "-qfd");

      const before = new Set(listSessionFiles(values["sessions-dir"]!));
      const logFile = path.join(out, "logs", `${task.id}.${arm}.run${run}.log`);
      process.stdout.write(`run ${run} | ${task.id} | ${arm.padEnd(7)} ... `);
      const outcome = await runOmp(task, cwd, configs[arm], logFile, timeoutMs);

      const sessionFiles = listSessionFiles(values["sessions-dir"]!).filter(
        (file) => !before.has(file) && (sessionCwd(file) ?? "").startsWith(cwd),
      );
      const metrics = metricsFor(sessionFiles);
      const { mismatch, ...decision } = summarizeRun(metrics, arm === "control");
      if (mismatch) {
        fail(`${task.id}/${arm}: the session ran with the wrong dryRun setting, so LOADOUT_CONFIG was not applied`);
      }

      let pass: boolean | null = null;
      if (task.check) {
        const check = spawnSync("sh", ["-c", task.check], { cwd, encoding: "utf8", timeout: timeoutMs });
        fs.appendFileSync(logFile, `\n--- check: ${task.check}\n${check.stdout ?? ""}${check.stderr ?? ""}`);
        pass = check.status === 0;
      }

      const result: RunResult = {
        run,
        task: task.id,
        arm,
        ...outcome,
        pass,
        requests: metrics.requests,
        errors: metrics.errors,
        input: metrics.input,
        output: metrics.output,
        cacheRead: metrics.cacheRead,
        cacheWrite: metrics.cacheWrite,
        cacheRate: cacheRate(metrics),
        cost: metrics.cost,
        toolCalls: totalToolCalls(metrics),
        toolErrors: metrics.toolErrors,
        toolsUsed: metrics.toolCalls,
        profile: null,
        confidence: null,
        activeTools: null,
        skills: null,
        classifierMs: null,
        warning: null,
        ...decision,
        sessionFiles,
      };
      if (sessionFiles.length === 0) result.warning = "no session file found for this run";
      else if (metrics.errors > 0) result.warning ??= `${metrics.errors} model request(s) ended in error; see the log`;
      results.push(result);
      fs.appendFileSync(resultsFile, `${JSON.stringify(result)}\n`);
      console.log(
        `${pass === null ? "" : pass ? "pass " : "FAIL "}$${result.cost.toFixed(4)} ${result.requests} req ` +
          `${result.errors > 0 ? `${result.errors} err ` : ""}${result.toolCalls} tools ${(result.wallMs / 1000).toFixed(0)}s` +
          `${result.profile ? ` [${result.profile}]` : ""}${result.warning ? ` (${result.warning})` : ""}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const sum = (rows: RunResult[], key: keyof RunResult) => rows.reduce((s, r) => s + (r[key] as number), 0);
const median = (rows: RunResult[], key: keyof RunResult) =>
  percentile(
    rows.map((r) => r[key] as number),
    50,
  );
const passRate = (rows: RunResult[]) => {
  const checked = rows.filter((r) => r.pass !== null);
  return checked.length === 0 ? "-" : `${checked.filter((r) => r.pass).length}/${checked.length}`;
};
const delta = (a: number, b: number) => (b === 0 ? "-" : `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(1)}%`);
const money = (n: number) => `$${n.toFixed(4)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function armRow(label: string, rows: RunResult[]) {
  const totals = { input: sum(rows, "input"), cacheRead: sum(rows, "cacheRead") };
  return [
    label,
    passRate(rows),
    money(sum(rows, "cost")),
    String(sum(rows, "input")),
    pct(cacheRate(totals)),
    String(sum(rows, "requests")),
    String(sum(rows, "errors")),
    String(sum(rows, "toolCalls")),
    `${(median(rows, "wallMs") / 1000).toFixed(0)}s`,
  ];
}

const header = ["", "pass", "cost", "input tok", "cache rate", "requests", "errors", "tool calls", "median wall"];
const mdRow = (cells: string[]) => `| ${cells.join(" | ")} |`;
const byArm = (arm: Arm, rows = results) => rows.filter((r) => r.arm === arm);
const A = byArm("loadout");
const B = byArm("control");

const lines = [
  `# loadout benchmark`,
  ``,
  `${tasks.length} tasks x ${runs} runs at \`${sha.slice(0, 10)}\`${values.model ? `, model \`${values.model}\`` : ""}.`,
  `\`loadout\` selects tools and skills; \`control\` only records what it would have chosen.`,
  ``,
  `## Totals`,
  ``,
  mdRow(header),
  mdRow(header.map(() => "---")),
  mdRow(armRow("loadout", A)),
  mdRow(armRow("control", B)),
  mdRow([
    "loadout vs control",
    "",
    delta(sum(A, "cost"), sum(B, "cost")),
    delta(sum(A, "input"), sum(B, "input")),
    "",
    delta(sum(A, "requests"), sum(B, "requests")),
    "",
    delta(sum(A, "toolCalls"), sum(B, "toolCalls")),
    delta(median(A, "wallMs"), median(B, "wallMs")),
  ]),
  ``,
  `## Per task`,
  ``,
  mdRow([
    "task",
    "arm",
    "pass",
    "cost",
    "input tok",
    "cache rate",
    "requests",
    "errors",
    "tool calls",
    "median wall",
    "profile",
  ]),
  mdRow(Array(11).fill("---")),
];
for (const task of tasks) {
  for (const arm of ARMS) {
    const rows = results.filter((r) => r.task === task.id && r.arm === arm);
    const profiles = [...new Set(rows.map((r) => r.profile ?? "-"))].join(", ");
    lines.push(mdRow([task.id, ...armRow(arm, rows), profiles]));
  }
}
const warnings = results.filter((r) => r.warning);
if (warnings.length > 0) {
  lines.push("", "## Warnings", "", ...warnings.map((r) => `- ${r.task} / ${r.arm} / run ${r.run}: ${r.warning}`));
}
lines.push(
  "",
  "Per-run rows: `results.jsonl`. Agent output: `logs/`. In `omp stats`, the arms are the folders",
  `\`${worktrees.loadout}\` and \`${worktrees.control}\`.`,
  "",
  `Remove the worktrees when done: \`git -C ${repo} worktree remove --force ${worktrees.loadout}\` (and the control one).`,
);

const summary = `${lines.join("\n")}\n`;
fs.writeFileSync(path.join(out, "summary.md"), summary);
console.log(`\n${summary}`);

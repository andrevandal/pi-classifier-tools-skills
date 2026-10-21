/**
 * The benchmark and decision report against a fake `omp` that writes the
 * same session files the real one does.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { readSessions } from "../src/report/read.ts";
import { cacheRate, promptTokensPerRequest, type Summary, transcriptTotals } from "../src/report/summary.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_OMP = path.join(ROOT, "tests", "fixtures", "fake-omp.mjs");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loadout-bench-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

  const tasks = path.join(dir, "tasks.json");
  fs.writeFileSync(
    tasks,
    JSON.stringify([
      { id: "explain", prompt: "what is this repo?", check: 'test -f done.txt && grep -q "ANSWER: 42" "$BENCH_LOG"' },
      { id: "missing-check", prompt: "do something", check: "test -f never.txt" },
    ]),
  );
  const config = path.join(dir, "base.json");
  fs.writeFileSync(config, JSON.stringify({ backend: "laya" }));
  return { dir, repo, tasks, config, sessions: path.join(dir, "sessions"), out: path.join(dir, "out") };
}

// An empty HOME, so a developer's real ~/.omp/loadout.* cannot change what the scripts do.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "loadout-home-"));

function runScript(script: string, args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME, ...env },
  });
}

test("bench runs every task in both arms, resets worktrees, and summarizes", () => {
  const ctx = setup();
  const result = runScript(
    "bench.ts",
    [
      ...["--repo", ctx.repo, "--tasks", ctx.tasks, "--config", ctx.config, "--runs", "2", "--model", "fake"],
      ...["--omp", FAKE_OMP, "--sessions-dir", ctx.sessions, "--out", ctx.out],
    ],
    { FAKE_SESSIONS_DIR: ctx.sessions },
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const rows = fs
    .readFileSync(path.join(ctx.out, "results.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 8);
  assert.ok(rows.every((row) => row.exitCode === 0 && row.sessionFiles.length === 1 && row.warning === null));
  assert.deepEqual(
    rows.filter((row) => row.task === "explain").map((row) => row.pass),
    [true, true, true, true],
  );
  assert.ok(rows.filter((row) => row.task === "missing-check").every((row) => row.pass === false));

  const loadoutInput = rows.filter((r) => r.arm === "loadout").reduce((s, r) => s + r.input, 0);
  const controlInput = rows.filter((r) => r.arm === "control").reduce((s, r) => s + r.input, 0);
  assert.ok(loadoutInput < controlInput);

  const configs = ["loadout", "control"].map((arm) =>
    JSON.parse(fs.readFileSync(path.join(ctx.out, `loadout.${arm}.json`), "utf8")),
  );
  assert.deepEqual(
    configs.map((c) => [c.backend, c.dryRun, c.telemetry]),
    [
      ["laya", false, true],
      ["laya", true, true],
    ],
  );
  assert.ok(rows.every((row) => row.profile === "answer"));
  for (const row of rows.filter((r) => r.arm === "loadout")) {
    assert.equal(row.applied, "answer");
    assert.equal(row.activeToolNames.length, 4);
  }
  for (const row of rows.filter((r) => r.arm === "control")) {
    assert.equal(row.applied, null);
    assert.equal(row.activeToolNames.length, 7);
  }

  const summary = fs.readFileSync(path.join(ctx.out, "summary.md"), "utf8");
  assert.match(summary, /\| loadout \| 2\/4 \|/);
  assert.match(summary, /\| loadout vs control \| {2}\| -38\.1% \| -38\.1% \|/);
  assert.match(summary, /## Selection/);
  assert.match(summary, /\| accuracy/);
  assert.equal(spawnSync("git", ["-C", ctx.repo, "status", "--porcelain"], { encoding: "utf8" }).stdout, "");
});

test("bench refuses to reuse a non-empty results directory", () => {
  const ctx = setup();
  fs.mkdirSync(ctx.out);
  fs.writeFileSync(path.join(ctx.out, "x"), "");
  const result = runScript(
    "bench.ts",
    ["--repo", ctx.repo, "--tasks", ctx.tasks, "--out", ctx.out, "--model", "fake"],
    {},
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not empty/);
});

test("decisions reports profiles, failures and skills across sessions", () => {
  const ctx = setup();
  runScript(
    "bench.ts",
    [
      ...["--repo", ctx.repo, "--tasks", ctx.tasks, "--config", ctx.config, "--model", "fake"],
      ...["--omp", FAKE_OMP, "--sessions-dir", ctx.sessions, "--out", ctx.out],
    ],
    { FAKE_SESSIONS_DIR: ctx.sessions },
  );
  const day = 86_400_000;
  const window = [
    ...["--since", new Date(Date.now() - day).toISOString()],
    ...["--until", new Date(Date.now() + day).toISOString()],
  ];
  const result = runScript("decisions.ts", ["--sessions-dir", ctx.sessions, ...window, "--all-projects", "--json"], {});
  assert.equal(result.status, 0, result.stderr);
  const report: Summary = JSON.parse(result.stdout);
  assert.equal(report.classifier.attempts, 4);
  assert.deepEqual(report.decisions.skips, { command: 4 });
  assert.equal(report.coverage.unsupported.decisions, 0);
  assert.equal(report.decisions.dryRun.yes, 2);
  assert.deepEqual(report.decisions.proposals.profiles, { answer: 4 });
  assert.deepEqual(report.decisions.skills.selected, { pdf: 4 });
  assert.deepEqual(report.decisions.failures, {});
  assert.deepEqual(report.decisions.application.statuses, { applied: 2, "dry-run": 2 });
  assert.deepEqual(Object.values(report.coverage.removedByFilters.decisions), [0, 0, 0, 0]);

  const control = path.join(fs.realpathSync(ctx.out), "wt-control");
  const filtered = runScript(
    "decisions.ts",
    ["--sessions-dir", ctx.sessions, ...window, "--project", control, "--json"],
    {},
  );
  assert.equal(filtered.status, 0, filtered.stderr);
  const scoped: Summary = JSON.parse(filtered.stdout);
  assert.equal(scoped.classifier.attempts, 2);
});

test("bench refuses to run when the machine opts out of telemetry", () => {
  const ctx = setup();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "loadout-home-off-"));
  fs.mkdirSync(path.join(home, ".omp"));
  fs.writeFileSync(path.join(home, ".omp", "loadout.json"), JSON.stringify({ telemetry: false }));
  const result = runScript(
    "bench.ts",
    ["--repo", ctx.repo, "--tasks", ctx.tasks, "--config", ctx.config, "--model", "fake", "--out", ctx.out],
    { HOME: home },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /telemetry/);
  assert.equal(fs.existsSync(ctx.out), false);
});

test("bench refuses to run when the machine telemetry setting is unreadable", () => {
  const ctx = setup();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "loadout-home-bad-"));
  fs.mkdirSync(path.join(home, ".omp"));
  fs.writeFileSync(path.join(home, ".omp", "loadout.json"), "{");
  const result = runScript(
    "bench.ts",
    ["--repo", ctx.repo, "--tasks", ctx.tasks, "--config", ctx.config, "--model", "fake", "--out", ctx.out],
    { HOME: home },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /telemetry/);
  assert.equal(fs.existsSync(ctx.out), false);
});

test("session metrics sum usage, tool calls and cache rate", () => {
  const ctx = setup();
  const file = path.join(ctx.dir, "s.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", cwd: "/x" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          stopReason: "error",
          content: [{ type: "toolCall", name: "bash" }],
          usage: { input: 100, output: 10, cacheRead: 300, cacheWrite: 5, cost: { total: 0.01 } },
        },
      }),
      JSON.stringify({ type: "message", message: { role: "toolResult", isError: true } }),
      "{ truncated",
    ].join("\n"),
  );
  const read = readSessions([file]);
  const totals = transcriptTotals(read.turns, read.toolResults);
  assert.deepEqual(
    [totals.turns, totals.outcomes.error, totals.tokens.input.sum, totals.tokens.cacheRead.sum, totals.toolErrors],
    [1, 1, 100, 300, 1],
  );
  assert.deepEqual(totals.toolCalls.byTool, { bash: 1 });
  assert.equal(cacheRate(totals.tokens), 300 / 405);
  assert.equal(promptTokensPerRequest(totals), 405);
});

test("bench refuses to run without --model, so the arms cannot differ in model", () => {
  const ctx = setup();
  const result = runScript("bench.ts", ["--repo", ctx.repo, "--tasks", ctx.tasks], {});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--model is required/);
});

test("bench rejects an expect label that is not a profile id", () => {
  const ctx = setup();
  const labeled = path.join(ctx.dir, "labeled.json");
  fs.writeFileSync(labeled, JSON.stringify([{ id: "q", prompt: "hi", expect: "nope" }]));
  const result = runScript(
    "bench.ts",
    ["--repo", ctx.repo, "--tasks", labeled, "--config", ctx.config, "--model", "fake"],
    {},
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /every expect must be a profile id/);
});

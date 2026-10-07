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

import { cacheRate, metricsFor } from "../scripts/lib/sessions.ts";

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
      { id: "explain", prompt: "what is this repo?", check: "test -f done.txt" },
      { id: "missing-check", prompt: "do something", check: "test -f never.txt" },
    ]),
  );
  const config = path.join(dir, "base.json");
  fs.writeFileSync(config, JSON.stringify({ backend: "laya" }));
  return { dir, repo, tasks, config, sessions: path.join(dir, "sessions"), out: path.join(dir, "out") };
}

function runScript(script: string, args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("bench runs every task in both arms, resets worktrees, and summarizes", () => {
  const ctx = setup();
  const result = runScript(
    "bench.ts",
    [
      ...["--repo", ctx.repo, "--tasks", ctx.tasks, "--config", ctx.config, "--runs", "2"],
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
    configs.map((c) => [c.backend, c.dryRun]),
    [
      ["laya", false],
      ["laya", true],
    ],
  );

  const summary = fs.readFileSync(path.join(ctx.out, "summary.md"), "utf8");
  assert.match(summary, /\| loadout \| 2\/4 \|/);
  assert.match(summary, /\| loadout vs control \| {2}\| -38\.1% \| -38\.1% \|/);
  assert.equal(spawnSync("git", ["-C", ctx.repo, "status", "--porcelain"], { encoding: "utf8" }).stdout, "");
});

test("bench refuses to reuse a non-empty results directory", () => {
  const ctx = setup();
  fs.mkdirSync(ctx.out);
  fs.writeFileSync(path.join(ctx.out, "x"), "");
  const result = runScript("bench.ts", ["--repo", ctx.repo, "--tasks", ctx.tasks, "--out", ctx.out], {});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not empty/);
});

test("decisions reports profiles, confidence and skills across sessions", () => {
  const ctx = setup();
  runScript(
    "bench.ts",
    [
      ...["--repo", ctx.repo, "--tasks", ctx.tasks, "--config", ctx.config],
      ...["--omp", FAKE_OMP, "--sessions-dir", ctx.sessions, "--out", ctx.out],
    ],
    { FAKE_SESSIONS_DIR: ctx.sessions },
  );
  const result = runScript("decisions.ts", ["--sessions-dir", ctx.sessions, "--json"], {});
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.decisions, 4);
  assert.equal(report.dryRun, 2);
  assert.deepEqual(report.toolProfiles, { answer: 4 });
  assert.deepEqual(report.skillsSelected, { pdf: 4 });
  assert.equal(report.confidence.p50, 0.8);

  const filtered = runScript("decisions.ts", ["--sessions-dir", ctx.sessions, "--folder", "wt-control", "--json"], {});
  assert.equal(JSON.parse(filtered.stdout).decisions, 2);
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
  const metrics = metricsFor([file]);
  assert.deepEqual(
    [metrics.requests, metrics.errors, metrics.input, metrics.cacheRead, metrics.toolErrors],
    [1, 1, 100, 300, 1],
  );
  assert.deepEqual(metrics.toolCalls, { bash: 1 });
  assert.equal(cacheRate(metrics), 0.75);
});

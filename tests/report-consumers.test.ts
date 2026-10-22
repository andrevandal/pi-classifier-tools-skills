import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSummary } from "../src/report/report.ts";
import { NO_FILTERS } from "../src/report/scope.ts";
import type { Summary } from "../src/report/summary.ts";
import { header, tmp, userMessage, writeMixed, writeSession } from "./fixtures/report.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION: string = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

function script(name: string, args: string[]) {
  // An empty HOME, so a developer's real sessions and settings cannot change what a script reads.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp("loadout-report-home-") };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [path.join(ROOT, "scripts", name), ...args], { encoding: "utf8", env });
}

test("decisions script: text view and --json share the report's scope rules", () => {
  const { file } = writeMixed(tmp());

  const unscoped = script("decisions.ts", []);
  assert.equal(unscoped.status, 2);
  assert.equal(unscoped.stdout, "", "no scope reads nothing");
  assert.notEqual(unscoped.stderr, "");
  assert.equal(script("decisions.ts", ["--since", "2026-10-01", "--json"]).status, 2, "a partial scope is refused too");
  for (const flag of ["--version", "-v"]) {
    const version = script("decisions.ts", [flag]);
    assert.equal(version.status, 0, flag);
    assert.equal(version.stdout.trim(), VERSION, `${flag} prints the version, not the usage text`);
  }

  const spec = { scope: { kind: "session" as const, files: [file] }, filters: NO_FILTERS, serviceLogs: [] };
  const json = script("decisions.ts", ["--session", file, "--json"]);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), JSON.parse(JSON.stringify(buildSummary(spec))));

  const text = script("decisions.ts", ["--session", file]);
  assert.equal(text.status, 0, text.stderr);
  assert.notEqual(text.stdout.trim(), "");
  assert.doesNotMatch(text.stdout, /NaN|undefined|\[object/);
  const summary: Summary = JSON.parse(json.stdout);
  for (const profile of Object.keys(summary.decisions.proposals.profiles)) {
    assert.ok(text.stdout.includes(profile), `the text view lists the ${profile} profile`);
  }

  const empty = script("decisions.ts", [
    "--sessions-dir",
    tmp(),
    "--since",
    "2026-10-01",
    "--until",
    "2026-11-01",
    "--all-projects",
  ]);
  assert.equal(empty.status, 0, "a scope that matches nothing is not an error");
  assert.doesNotMatch(empty.stdout, /NaN|undefined|\[object/);
});

test("eval --mine: discovery keeps its filters and is deterministic", () => {
  const dir = tmp();
  const session = (name: string, text: string, mtime?: Date) =>
    writeSession(path.join(dir, name), [header({ id: name }), userMessage(text)], mtime);
  session("one.jsonl", "Explain how the retry logic works in the loader module");
  session("two.jsonl", "Explain how the retry logic works in the loader module");
  session("slash.jsonl", "/review the staged changes please now");
  session("short.jsonl", "hi there");
  session("__advisor.jsonl", "Explain how the advisor decides what to say next");
  session("old.jsonl", "Explain how the scheduler orders pending work items", new Date(Date.now() - 60 * 86_400_000));

  const out = path.join(tmp(), "mined.jsonl");
  const result = script("eval-classifier.ts", ["--mine", "--out", out, "--sessions-dir", dir]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mined 1 prompts from 4 sessions/);
  assert.deepEqual(
    fs
      .readFileSync(out, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [{ id: "one", prompt: "Explain how the retry logic works in the loader module" }],
    "sorted discovery makes one win over two every time",
  );
});

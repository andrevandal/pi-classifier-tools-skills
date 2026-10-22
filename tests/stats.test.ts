/** `/loadout stats` argument handling (`src/stats.ts`); expectations are the report library's own output or the CLI's refusal. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildExport, buildSummary, parseArgv, type ReportSpec } from "../src/report/report.ts";
import { type FilterSpec, NO_FILTERS } from "../src/report/scope.ts";
import { runStats, type StatsResult, splitArgs } from "../src/stats.ts";
import { DECISION_ENTRY } from "../src/telemetry.ts";
import {
  chain,
  custom,
  decisionV3,
  header,
  serviceLog,
  T0,
  tmp,
  uuid,
  writeMixed,
  writeSession,
} from "./fixtures/report.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** The explanation of a missing session file; only its first sentence is the contract, the advice after it may change. */
const NO_SESSION_FILE = /^\[loadout\] stats: no session file yet\. /;
const HELP_LINE = "[loadout] stats [summary|export] [--json] [scope] [filters]";
const UNTIL = "2026-10-11T00:00:00.000Z";

let savedHome: string | undefined;
before(() => {
  savedHome = process.env.HOME;
  // Empty: a stray read of the default history finds nothing, so no test touches the real sessions.
  process.env.HOME = tmp("loadout-stats-home-");
});
after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

function sessionSpec(file: string, filters: FilterSpec = NO_FILTERS, serviceLogs: string[] = []): ReportSpec {
  return { scope: { kind: "session", files: [file] }, filters, serviceLogs };
}

function summaryOf(result: StatsResult): Extract<StatsResult, { kind: "summary" }> {
  if (result.kind !== "summary") {
    assert.fail(`expected a summary, got ${result.kind === "refused" ? result.text : result.kind}`);
  }
  return result;
}

function refusalOf(result: StatsResult): Extract<StatsResult, { kind: "refused" }> {
  if (result.kind !== "refused") assert.fail(`expected a refusal, got ${result.kind}`);
  return result;
}

test("splitArgs: quotes, spaces and an unterminated quote", () => {
  assert.deepEqual(splitArgs(`--project "/a b"`), ["--project", "/a b"]);
  assert.deepEqual(splitArgs("--project '/a b'"), ["--project", "/a b"]);
  assert.deepEqual(splitArgs("--since=2026-10-01"), ["--since=2026-10-01"]);
  assert.deepEqual(splitArgs(`--project="/a b"`), ["--project=/a b"]);
  assert.deepEqual(splitArgs(`'a "b" c'`), [`a "b" c`]);
  assert.deepEqual(splitArgs(`--project "" --json`), ["--project", "", "--json"]);
  assert.deepEqual(splitArgs("  summary\t--json  "), ["summary", "--json"]);
  assert.deepEqual(splitArgs(""), []);
  assert.equal(splitArgs(`--project "/a b`), null);
  assert.equal(splitArgs("--project '/a b"), null);
});

test("stats: the current session's file is the default scope, and a missing file is explained", () => {
  const { file } = writeMixed(tmp());
  const result = summaryOf(runStats([], file));
  assert.deepEqual(result.summary, buildSummary(sessionSpec(file)));
  assert.equal(result.compare, true);
  assert.equal(summaryOf(runStats(["--session", file], undefined)).compare, false);

  for (const sessionFile of [undefined, tmp(), path.join(tmp(), "not-yet.jsonl")]) {
    const explained = refusalOf(runStats([], sessionFile));
    assert.equal(explained.level, "info");
    assert.match(explained.text, NO_SESSION_FILE);
  }
});

test("stats: --json and export are the report library's documents", () => {
  const { file } = writeMixed(tmp());
  const spec = sessionSpec(file);
  const summaryJson = JSON.stringify(buildSummary(spec), null, 2);
  const exportJson = JSON.stringify(buildExport(spec), null, 2);

  assert.deepEqual(runStats(["--json"], file), { kind: "json", text: summaryJson });
  assert.deepEqual(runStats(["--json", "summary"], file), { kind: "json", text: summaryJson });
  assert.deepEqual(runStats(["summary", "--json"], file), { kind: "json", text: summaryJson });
  assert.deepEqual(runStats(["export"], file), { kind: "json", text: exportJson });
  assert.deepEqual(runStats(["--json", "export"], file), { kind: "json", text: exportJson });

  assert.equal(summaryOf(runStats(["--branch", "active"], file)).compare, false);
});

test("stats: a historical scope must be complete", () => {
  const { file } = writeMixed(tmp());
  const dir = tmp();
  const since = "2026-10-01T00:00:00.000Z";
  const project = path.join(dir, "project");
  const cases = [
    ["--since", since],
    [`--since=${since}`],
    ["--since", since, "--until", UNTIL],
    ["--until", UNTIL, "--project", project],
    ["--project", project],
    ["--all-projects"],
    ["--sessions-dir", dir],
    ["--session", file, "--since", since, "--until", UNTIL, "--project", project],
  ];
  for (const tokens of cases) {
    const parsed = parseArgv(["summary", ...tokens]);
    assert.ok(!parsed.ok, `the CLI must refuse ${tokens.join(" ")}`);
    assert.deepEqual(runStats(tokens, file), {
      kind: "refused",
      level: "warning",
      text: `[loadout] stats: ${parsed.message}`,
    });
  }
});

test("stats: only the named project is read, and benchmark sessions need --all-projects", () => {
  const sessions = tmp("loadout-stats-sessions-");
  const work = tmp("loadout-stats-work-");
  const projectA = path.join(work, "a");
  const projectB = path.join(work, "b");
  const benchCwd = path.join(work, "bench-out", "wt-loadout");
  // Inside the window, so the modification-time rule keeps every file.
  const mtime = new Date("2026-10-10T12:00:00.000Z");
  let events = 0;
  const write = (name: string, id: string, cwd: string, count: number, start = T0): void => {
    const entries = Array.from({ length: count }, () => {
      events += 1;
      return custom(
        DECISION_ENTRY,
        decisionV3({ sessionId: id, eventId: uuid(events), decisionId: uuid(1000 + events) }),
      );
    });
    writeSession(path.join(sessions, name), [header({ id, cwd }), ...chain(entries, { start })], mtime);
  };

  write("a/one.jsonl", "sess-a", projectA, 2);
  write("a/late.jsonl", "sess-a-late", projectA, 1, "2026-10-10T23:59:00.000Z"); // first record at --until: out
  write("a/old.jsonl", "sess-a-old", projectA, 1, "2026-10-09T23:00:00.000Z"); // before --since: out
  write("b/one.jsonl", "sess-b", projectB, 3);
  write("bench/run.jsonl", "sess-bench", benchCwd, 4);
  write("a-worktree.jsonl", "sess-a-wt", path.join(projectA, ".worktrees", "x"), 1);

  const window = ["--since", T0, "--until", UNTIL, "--sessions-dir", sessions];
  const total = (scope: string[]): number =>
    summaryOf(runStats([...window, ...scope], undefined)).summary.decisions.total;
  assert.equal(total(["--project", projectA]), 2);
  assert.equal(total(["--project", projectB]), 3);
  assert.equal(total(["--all-projects"]), 2 + 3 + 4 + 1);
});

test("stats: filters and the service log pass through", () => {
  const { file } = writeMixed(tmp());
  const log = serviceLog(path.join(tmp(), "server.log"));

  const branch = summaryOf(runStats(["--branch", "active"], file));
  assert.deepEqual(branch.summary, buildSummary(sessionSpec(file, { ...NO_FILTERS, branch: "active" })));
  assert.equal(branch.compare, false);

  const outcome = summaryOf(runStats(["--outcome", "failed"], file));
  assert.deepEqual(outcome.summary, buildSummary(sessionSpec(file, { ...NO_FILTERS, decision: ["failed"] })));
  assert.notDeepEqual(outcome.summary, buildSummary(sessionSpec(file)));
  assert.equal(outcome.compare, false);

  const joined = summaryOf(runStats(["--service-log", log], file));
  assert.deepEqual(joined.summary, buildSummary(sessionSpec(file, NO_FILTERS, [log])));
  assert.notEqual(joined.summary.http, null);
  assert.equal(joined.compare, false);
});

test("stats: help, version and unknown views", () => {
  const { file } = writeMixed(tmp());

  const help = refusalOf(runStats(["--help"], undefined));
  assert.equal(help.level, "info");
  const lines = help.text.split("\n");
  assert.equal(lines[0], HELP_LINE);
  assert.equal(lines.filter((line) => line.startsWith("  ")).length, 4);
  assert.deepEqual(runStats(["-h"], file), help);

  for (const flag of ["--version", "-v"]) {
    const version = refusalOf(runStats([flag], file));
    assert.equal(version.level, "warning");
    assert.match(version.text, /^\[loadout\] stats: /);
  }

  assert.deepEqual(runStats(["bogus"], file), {
    kind: "refused",
    level: "warning",
    text: "[loadout] stats: unknown view bogus (use summary or export)",
  });
});

test("stats: a bad argument is refused the same way before the first session file exists as after it", () => {
  const { file } = writeMixed(tmp());
  const unsaved = [undefined, path.join(tmp(), "not-yet.jsonl")];
  const bad = [
    ["--sumary"],
    ["--branch", "nope"],
    ["--branch"],
    ["--outcome", "typo"],
    ["--service-log", path.join(tmp(), "none.log")],
    ["--json=1"],
    ["summary", "export"],
    ["export", "--sumary"],
  ];
  for (const tokens of bad) {
    const label = tokens.join(" ");
    // The CLI's own message for the same arguments with a real scope; a leading `summary` or `export` is the view.
    const [first, ...others] = tokens;
    const named = first === "summary" || first === "export";
    const cli = parseArgv(named ? [first, "--session", file, ...others] : ["summary", "--session", file, ...tokens]);
    assert.ok(!cli.ok, `the CLI must refuse ${label}`);
    const refusal: StatsResult = { kind: "refused", level: "warning", text: `[loadout] stats: ${cli.message}` };
    for (const sessionFile of [file, ...unsaved]) assert.deepEqual(runStats(tokens, sessionFile), refusal, label);
  }

  const log = serviceLog(path.join(tmp(), "server.log"));
  const valid = [
    [],
    ["summary"],
    ["export"],
    ["--branch", "active"],
    ["--outcome", "failed"],
    ["export", "--service-log", log],
  ];
  for (const tokens of valid) {
    for (const sessionFile of unsaved) {
      const explained = refusalOf(runStats(tokens, sessionFile));
      assert.equal(explained.level, "info", tokens.join(" "));
      assert.match(explained.text, NO_SESSION_FILE);
    }
  }
});

test("the packed file set loads the extension entry", () => {
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const [manifest] = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
  const listed = (manifest?.files ?? []).map((file) => file.path);

  const missing = ["src/diagnostics.ts", "src/stats.ts", "src/report/text.ts"].filter((file) => !listed.includes(file));
  assert.deepEqual(missing, [], "the packed file set lacks modules of the extension entry");

  // Only what npm would ship: an import of anything else in the checkout fails in the copy.
  const out = tmp("loadout-stats-pack-");
  for (const file of listed) {
    fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(out, file));
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // The child imports the entry dynamically: a static import here would load this checkout, not the packed copy.
  const script =
    "import { pathToFileURL } from 'node:url'; const m = await import(pathToFileURL(process.argv[1]).href); console.log(typeof m.default)";
  const loaded = spawnSync(process.execPath, ["--input-type=module", "-e", script, path.join(out, "src", "index.ts")], {
    cwd: out,
    encoding: "utf8",
    env,
  });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(loaded.stdout.trim(), "function");
});

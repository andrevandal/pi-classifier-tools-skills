import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExportDoc } from "../src/report/export.ts";
import { buildExport, buildSummary } from "../src/report/report.ts";
import { NO_FILTERS } from "../src/report/scope.ts";
import type { Summary } from "../src/report/summary.ts";
import { DECISION_ENTRY, USAGE_ENTRY } from "../src/telemetry.ts";
import {
  chain,
  custom,
  decisionV3,
  header,
  INVENTED_TOOL_NAMES,
  serviceLog,
  tmp,
  toolCallTurn,
  usageV1,
  uuid,
  writeBranches,
  writeMixed,
  writeSession,
  writeSmokeTree,
  writeUsageHistory,
} from "./fixtures/report.ts";

const CLI = fileURLToPath(new URL("../src/report/cli.ts", import.meta.url));
const PACKAGE = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const A = "2026-10-01";
const B = "2026-11-01";
/** Fixture files are stamped far from "now" so a historical window never depends on the clock. */
const STAMP = new Date("2026-10-11T00:00:00.000Z");

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** A spawned report that blocks is killed after this long, so a regression fails instead of hanging the suite. */
const LIMIT_MS = 20_000;

function cleanEnv(over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...over };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function run(
  args: string[],
  home = tmp("loadout-report-home-"),
  command = process.execPath,
  entry: string[] = [CLI],
): Run {
  const result = spawnSync(command, [...entry, ...args], {
    encoding: "utf8",
    env: cleanEnv({ HOME: home }),
    timeout: LIMIT_MS,
    killSignal: "SIGKILL",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const summaryOf = (result: Run): Summary => JSON.parse(result.stdout);
const exportOf = (result: Run): ExportDoc => JSON.parse(result.stdout);

function stamped(file: string): string {
  fs.utimesSync(file, STAMP, STAMP);
  return file;
}

function history(): { root: string; file: string } {
  const root = tmp();
  const { file } = writeMixed(root);
  return { root, file: stamped(file) };
}

test("cli: scope errors exit 2 with nothing on stdout", () => {
  const { root, file } = history();
  const missing = path.join(root, "missing.jsonl");
  const log = path.join(root, "svc.log");
  const win = ["--since", A, "--until", B];
  const rows: Array<[string, string[], string[]]> = [
    ["no subcommand", [], []],
    ["no scope", ["summary"], ["--session", "--since"]],
    ["since only", ["summary", "--since", A], ["--until", "--project", "--all-projects"]],
    ["no project scope", ["summary", ...win], ["--project", "--all-projects"]],
    ["until only", ["summary", "--until", B, "--all-projects"], ["--since"]],
    [
      "both project forms",
      ["summary", ...win, "--project", "/p/one", "--all-projects"],
      ["--project", "--all-projects"],
    ],
    ["empty project", ["summary", ...win, "--project", ""], ["--project"]],
    ["empty project in the = form", ["summary", ...win, "--project="], ["--project"]],
    ["empty window", ["summary", "--since", A, "--until", A, "--all-projects"], ["--since", "--until"]],
    ["reversed window", ["summary", "--since", B, "--until", A, "--all-projects"], ["--since", "--until"]],
    ["relative instant", ["summary", "--since", "7d", "--until", B, "--all-projects"], ["--since"]],
    ["session mixed with a window", ["summary", "--session", file, ...win, "--all-projects"], ["--session"]],
    [
      "session mixed with a root",
      ["summary", "--session", file, "--sessions-dir", root],
      ["--session", "--sessions-dir"],
    ],
    ["missing session", ["summary", "--session", missing], ["--session"]],
    ["session is a directory", ["summary", "--session", root], ["--session"]],
    ["missing root", ["summary", "--sessions-dir", missing, ...win, "--all-projects"], ["--sessions-dir"]],
    ["unknown subcommand", ["frobnicate", "--session", file], []],
    ["two subcommands", ["summary", "export", "--session", file], []],
    ["unknown branch", ["summary", "--session", file, "--branch", "weird"], ["--branch"]],
    ["unknown outcome", ["summary", "--session", file, "--outcome", "weird"], ["--outcome"]],
    ["missing service log", ["summary", "--session", file, "--service-log", log], ["--service-log"]],
    ["unknown flag", ["summary", "--session", file, "--frobnicate"], []],
    ["flag without a value", ["summary", "--session"], []],
  ];
  for (const [label, argv, flags] of rows) {
    const result = run(argv);
    assert.equal(result.status, 2, `${label}: exit status`);
    assert.equal(result.stdout, "", `${label}: stdout`);
    assert.notEqual(result.stderr, "", `${label}: stderr`);
    for (const flag of flags) assert.ok(result.stderr.includes(flag), `${label}: stderr names ${flag}`);
  }
});

test("cli: summary and export each print one JSON document", () => {
  const { root, file } = history();
  const log = serviceLog(path.join(root, "svc.log"));
  const spec = { scope: { kind: "session" as const, files: [file] }, filters: NO_FILTERS, serviceLogs: [log] };
  const args = ["--session", file, "--service-log", log];

  const summary = run(["summary", ...args]);
  assert.equal(summary.status, 0);
  assert.equal(summary.stderr, "");
  assert.equal(summaryOf(summary).schema, "loadout-report.summary/1");
  assert.deepEqual(summaryOf(summary), JSON.parse(JSON.stringify(buildSummary(spec))), "the CLI adds nothing");
  assert.equal(
    summary.stdout,
    `${JSON.stringify(buildSummary(spec), null, 2)}\n`,
    "two-space indent, one trailing newline",
  );

  const exported = run(["export", ...args]);
  assert.equal(exported.status, 0);
  assert.equal(exported.stderr, "");
  assert.equal(exportOf(exported).schema, "loadout-report.export/1");
  assert.deepEqual(exportOf(exported), JSON.parse(JSON.stringify(buildExport(spec))));
});

test("cli: an unscoped query does not read the machine's sessions", () => {
  const home = tmp("loadout-report-home-");
  const { file } = writeMixed(path.join(home, ".omp", "agent", "sessions", "proj"));
  stamped(file);

  for (const argv of [["summary"], ["summary", "--since", A], ["summary", "--since", A, "--until", B]]) {
    const result = run(argv, home);
    assert.equal(result.status, 2, argv.join(" "));
    assert.equal(result.stdout, "", "the default directory is never aggregated without a full scope");
  }
  const scoped = run(["summary", "--since", A, "--until", B, "--all-projects"], home);
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.equal(summaryOf(scoped).decisions.total, 10);
});

test("cli: help and version exit 0", () => {
  for (const flag of ["--help", "-h"]) {
    const result = run([flag]);
    assert.equal(result.status, 0, flag);
    for (const word of ["summary", "export", "--session", "--since", "--until", "--project", "--all-projects"]) {
      assert.ok(result.stdout.includes(word), `${flag} names ${word}`);
    }
    for (const word of ["--sessions-dir", "--service-log", "--branch", "--outcome"]) {
      assert.ok(result.stdout.includes(word), `${flag} names ${word}`);
    }
  }
  for (const flag of ["--version", "-v"]) {
    const result = run([flag]);
    assert.equal(result.status, 0, flag);
    assert.equal(result.stdout.trim(), PACKAGE.version);
  }
  assert.equal(run(["--help", "--branch", "weird"]).status, 0, "help beats an invalid value");
  assert.equal(run(["--version", "frobnicate", "--branch", "weird"]).stdout.trim(), PACKAGE.version);
  assert.ok(run(["--help", "--version"]).stdout.includes("summary"), "help comes before version");
});

test("cli: filters and service logs reach the report", () => {
  const dir = tmp();
  const { file: v } = writeBranches(dir);
  const active = summaryOf(run(["summary", "--session", v, "--branch", "active"]));
  assert.deepEqual(active.filters, { branch: "active", outcome: { decision: null, usage: null } });
  assert.equal(active.usage.turns, 1);
  assert.equal(active.transcript.turns, 1);

  const { file: u } = writeUsageHistory(dir);
  const errors = summaryOf(run(["summary", "--session", u, "--outcome", "error", "--outcome", "aborted"]));
  assert.deepEqual(errors.filters.outcome, { decision: null, usage: ["error", "aborted"] });
  assert.equal(errors.usage.turns, 2);
  assert.equal(errors.transcript.toolResults, null);

  const { file: m } = writeMixed(dir);
  const failed = summaryOf(run(["summary", "--session", m, "--outcome", "failed"]));
  assert.deepEqual(failed.decisions.outcomes, { classified: 0, failed: 2, skipped: 0 });

  const log = serviceLog(path.join(dir, "svc.log"));
  const joined = summaryOf(run(["summary", "--session", m, "--service-log", log]));
  assert.equal(joined.http?.joined, 2);
});

test("cli: unreadable history is coverage and an empty match is a warning", (t) => {
  const empty = tmp();
  const result = run(["summary", "--sessions-dir", empty, "--since", A, "--until", B, "--all-projects"]);
  assert.equal(result.status, 0);
  assert.notEqual(result.stderr, "", "a scope that matches nothing warns");
  const summary = summaryOf(result);
  assert.equal(summary.decisions.total, 0);
  assert.deepEqual(summary.coverage.files, {
    read: 0,
    unreadable: 0,
    withoutHeader: 0,
    skippedByMtime: 0,
  });

  const noHome = run(["summary", "--since", A, "--until", B, "--all-projects"]);
  assert.equal(noHome.status, 0, "a missing default directory is zero files and a warning");
  assert.notEqual(noHome.stderr, "");

  if (process.getuid?.() === 0) return t.diagnostic("running as root: the unreadable-history rows were not run");
  const root = tmp();
  const ok = writeSession(path.join(root, "ok", "valid.jsonl"), [
    header({ id: "s-ok" }),
    ...chain([custom(DECISION_ENTRY, decisionV3({ eventId: uuid(1), sessionId: "s-ok" }))]),
  ]);
  stamped(ok);
  const lockedFile = stamped(writeSession(path.join(root, "locked.jsonl"), [header({ id: "s-locked" })]));
  const lockedDir = path.join(root, "locked-dir");
  stamped(writeSession(path.join(lockedDir, "x.jsonl"), [header({ id: "s-x" })]));
  fs.chmodSync(lockedFile, 0o000);
  fs.chmodSync(lockedDir, 0o000);
  try {
    const result = run(["summary", "--sessions-dir", root, "--since", A, "--until", B, "--all-projects"]);
    assert.equal(result.status, 0, result.stderr);
    const summary = summaryOf(result);
    assert.equal(summary.coverage.files.unreadable, 2);
    assert.equal(summary.coverage.files.read, 1);
    assert.equal(summary.decisions.total, 1);
  } finally {
    fs.chmodSync(lockedFile, 0o600);
    fs.chmodSync(lockedDir, 0o700);
  }
});

function snapshot(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true })
    .map((entry) => {
      const stat = fs.statSync(path.join(dir, String(entry)));
      return `${entry}:${stat.size}:${stat.mtimeMs}`;
    })
    .sort();
}

test("cli: reading never writes to the sessions directory", () => {
  const { root } = history();
  writeUsageHistory(root);
  const before = snapshot(root);
  const scope = ["--sessions-dir", root, "--since", A, "--until", B, "--all-projects"];
  assert.equal(run(["summary", ...scope]).status, 0);
  assert.equal(run(["export", ...scope]).status, 0);
  assert.deepEqual(snapshot(root), before);
});

test("cli: output is deterministic", () => {
  const dir = tmp();
  const { file: m } = writeMixed(dir);
  const { file: u } = writeUsageHistory(dir);
  const first = run(["summary", "--session", m, "--session", u]);
  assert.equal(first.status, 0);
  assert.equal(run(["summary", "--session", m, "--session", u]).stdout, first.stdout);
  assert.equal(run(["summary", "--session", u, "--session", m]).stdout, first.stdout, "argument order is irrelevant");
  const exported = run(["export", "--session", m, "--session", u]);
  assert.equal(run(["export", "--session", u, "--session", m]).stdout, exported.stdout);
});

const hasBun = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
test("cli: Bun and Node print the same document", { skip: !hasBun && "bun is not on PATH" }, () => {
  const { file } = writeMixed(tmp());
  const node = run(["summary", "--session", file]);
  const bun = run(["summary", "--session", file], tmp("loadout-report-home-"), "bun", [CLI]);
  assert.equal(bun.status, 0, bun.stderr);
  assert.equal(bun.stdout, node.stdout);
});

test("cli: the synthetic smoke tree reports the derived figures", () => {
  const root = tmp();
  const { since, until, narrowSince, narrowUntil } = writeSmokeTree(root);
  const tree = (...flags: string[]): Summary => summaryOf(run(["summary", "--sessions-dir", root, ...flags]));
  const win = ["--since", since, "--until", until];

  const all = tree(...win, "--all-projects");
  assert.equal(all.coverage.files.read, 4);
  assert.equal(all.coverage.files.skippedByMtime, 1);
  assert.equal(all.scope.nestedChildFiles, 1);
  assert.equal(all.decisions.total, 7);
  assert.deepEqual(all.decisions.outcomes, { classified: 5, failed: 1, skipped: 1 });
  assert.deepEqual(all.coverage.duplicatesRemoved, { decisions: 2, usage: 1 });
  assert.equal(all.coverage.unidentifiable.decisions, 2);
  assert.equal(all.coverage.provenance.origin, 6);
  assert.equal(all.usage.turns, 1);
  assert.equal(all.coverage.malformedLines, 1);

  const one = tree(...win, "--project", "/smoke/one");
  assert.equal(one.decisions.total, 5);
  assert.deepEqual(one.decisions.outcomes, { classified: 4, failed: 1, skipped: 0 });
  assert.equal(one.coverage.malformedLines, 0);
  const two = tree(...win, "--project", "/smoke/two");
  assert.equal(two.decisions.total, 2);
  assert.equal(two.coverage.malformedLines, 1);
  const parent = tree(...win, "--project", "/smoke");
  assert.equal(parent.decisions.total, 0, "a parent directory is not the project");
  assert.equal(parent.coverage.files.read, 0);

  const narrow = tree("--since", narrowSince, "--until", narrowUntil, "--all-projects");
  assert.equal(narrow.decisions.total, 2);
  assert.equal(narrow.usage.turns, 1);
  assert.equal(narrow.coverage.removedByFilters.decisions.outsideRange, 5);
});

/** `mkfifo` is POSIX; where it is missing the pipe cases are skipped. */
function mkfifo(file: string): boolean {
  return spawnSync("mkfifo", [file]).status === 0;
}

const historical = (command: "summary" | "export", root: string, ...scope: string[]): string[] => [
  ...[command, "--sessions-dir", root, "--since", A, "--until", B],
  ...scope,
];

test("cli: a looping or dangling *.jsonl entry is counted as unreadable and the rest is reported", () => {
  const root = tmp();
  stamped(writeMixed(path.join(root, "p")).file);
  fs.symlinkSync("loop.jsonl", path.join(root, "loop.jsonl"));
  fs.symlinkSync("missing.jsonl", path.join(root, "dangling.jsonl"));
  fs.symlinkSync("b.jsonl", path.join(root, "a.jsonl"));
  fs.symlinkSync("a.jsonl", path.join(root, "b.jsonl"));

  for (const scope of [["--project", "/p/one"], ["--all-projects"]]) {
    const label = scope.join(" ");
    const result = run(historical("summary", root, ...scope));
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    const summary = summaryOf(result);
    assert.equal(summary.coverage.files.read, 1, label);
    assert.equal(summary.decisions.total, 10, label);
    assert.equal(summary.coverage.files.unreadable, 4, `${label}: the four entries that are not files`);

    const exported = run(historical("export", root, ...scope));
    assert.equal(exported.status, 0, `${label}: ${exported.stderr}`);
    assert.equal(exportOf(exported).coverage.files.unreadable, 4, label);
  }
});

test("cli: a session whose parent or child location is a loop is still read", () => {
  const root = tmp();
  const { file } = writeMixed(path.join(root, "proj"));
  fs.symlinkSync("proj.jsonl", path.join(root, "proj.jsonl")); // where a parent session file would be
  fs.symlinkSync("mixed", path.join(root, "proj", "mixed")); // where this file's child directory would be

  const result = run(["summary", "--session", file]);
  assert.equal(result.status, 0, result.stderr);
  const summary = summaryOf(result);
  assert.equal(summary.coverage.files.read, 1);
  assert.equal(summary.decisions.total, 10);
  assert.equal(summary.coverage.files.unreadable, 0, "the only in-scope file was read");
  assert.equal(summary.scope.childDirsUnreadable, 1, "the child location could not be examined");
  assert.equal(summary.scope.childFilesNotRead, 0);
  assert.equal(summary.scope.nestedChildFiles, 0);

  const direct = buildSummary({ scope: { kind: "session", files: [file] }, filters: NO_FILTERS, serviceLogs: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(direct)), summary);
});

test("cli: a pipe named *.jsonl is counted, never opened, and never blocks a report", (t) => {
  const root = tmp();
  stamped(writeMixed(path.join(root, "p")).file);
  const pipe = path.join(root, "pipe.jsonl");
  if (!mkfifo(pipe)) return t.skip("mkfifo is not available");

  for (const scope of [["--project", "/p/one"], ["--all-projects"]]) {
    const label = scope.join(" ");
    const result = run(historical("summary", root, ...scope));
    assert.equal(result.status, 0, `${label}: ${result.stderr || "killed: it blocked on the pipe"}`);
    const summary = summaryOf(result);
    assert.equal(summary.coverage.files.read, 1, label);
    assert.equal(summary.decisions.total, 10, label);
    assert.equal(summary.coverage.files.unreadable, 1, `${label}: the pipe`);
  }

  // The library entry points never open a pipe, whichever path names it (a call that blocked would be killed).
  const reader = new URL("../src/report/read.ts", import.meta.url).href;
  const probe = spawnSync(
    process.execPath,
    [
      ...["--input-type=module", "-e"],
      `import { readHeader, readServiceLogs, readSessions } from ${JSON.stringify(reader)};
const pipe = process.argv[1];
console.log(JSON.stringify({
  header: readHeader(pipe),
  sessionUnreadable: readSessions([pipe]).files[0]?.unreadable,
  logUnreadable: readServiceLogs([pipe]).unreadable,
}));`,
      pipe,
    ],
    { encoding: "utf8", env: cleanEnv(), timeout: LIMIT_MS, killSignal: "SIGKILL" },
  );
  assert.equal(probe.status, 0, probe.stderr || "killed: a reader blocked on the pipe");
  assert.deepEqual(JSON.parse(probe.stdout), { header: null, sessionUnreadable: true, logUnreadable: 1 });
});

test("cli: a tool name the model wrote never reaches summary or export stdout", () => {
  const file = writeSession(path.join(tmp(), "t.jsonl"), [
    header({ id: "sess-T", cwd: "/p/one" }),
    ...chain([
      toolCallTurn("read", ...INVENTED_TOOL_NAMES),
      custom(USAGE_ENTRY, usageV1({ eventId: uuid(701), toolCalls: { read: 1 } })),
    ]),
  ]);
  assert.match(fs.readFileSync(file, "utf8"), /CANARY_TOOL_N7/, "the invented names are in the transcript");

  for (const command of ["summary", "export"]) {
    const result = run([command, "--session", file]);
    assert.equal(result.status, 0, result.stderr);
    for (const name of INVENTED_TOOL_NAMES) {
      assert.equal(result.stdout.includes(name), false, `${command} prints ${name}`);
    }
  }
  assert.deepEqual(summaryOf(run(["summary", "--session", file])).transcript.toolCalls, {
    total: 5,
    byTool: { read: 1, "(redacted)": 4 },
  });
});

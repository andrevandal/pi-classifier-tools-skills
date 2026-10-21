import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { readSessions } from "../src/report/read.ts";
import {
  applyFilters,
  type FilterSpec,
  NO_FILTERS,
  type ScopeSpec,
  type Selection,
  selectFiles,
} from "../src/report/scope.ts";
import { DECISION_ENTRY, USAGE_ENTRY } from "../src/telemetry.ts";
import {
  assistantMessage,
  custom,
  decisionV3,
  header,
  T0,
  tmp,
  toolResultMessage,
  usageV1,
  userMessage,
  uuid,
  writeSession,
} from "./fixtures/report.ts";

const isRoot = process.getuid?.() === 0;
const SINCE = Date.parse("2026-10-01T00:00:00.000Z");
const at = (minute: number): string => new Date(Date.parse(T0) + minute * 60_000).toISOString();

function historical(roots: string[], projects: string[] | null): ScopeSpec {
  return { kind: "historical", since: SINCE, until: Date.parse("2026-11-01T00:00:00.000Z"), projects, roots };
}

const relative = (root: string, selection: Selection): string[] =>
  selection.files.map((file) => path.relative(root, file));

function put(root: string, rel: string, cwd: string | null, mtime?: Date): string {
  const lines = cwd === null ? [custom(DECISION_ENTRY, decisionV3())] : [header({ id: rel, cwd })];
  return writeSession(path.join(root, rel), lines, mtime);
}

test("scope: historical selection is exact on project, mtime and root", () => {
  const root = tmp();
  put(root, "one/a.jsonl", "/p/one");
  put(root, "one/a2.jsonl", "/p/one/sub");
  put(root, "two/b.jsonl", "/p/two");
  put(root, "one/a/child.jsonl", "/p/one");
  put(root, "old/c.jsonl", "/p/one", new Date("2020-01-01T00:00:00Z"));
  put(root, "none.jsonl", null);

  const one = selectFiles(historical([root], ["/p/one"]));
  assert.deepEqual(relative(root, one), ["one/a.jsonl", "one/a/child.jsonl"]);
  assert.equal(one.skippedByMtime, 1);
  assert.equal(one.unreadable, 0);

  const everything = selectFiles(historical([root], null));
  assert.deepEqual(relative(root, everything), [
    "none.jsonl",
    "one/a.jsonl",
    "one/a/child.jsonl",
    "one/a2.jsonl",
    "two/b.jsonl",
  ]);
  assert.equal(everything.skippedByMtime, 1);

  for (const spelling of ["/p/one/", "/p/x/../one"]) {
    assert.deepEqual(
      relative(root, selectFiles(historical([root], [spelling]))),
      ["one/a.jsonl", "one/a/child.jsonl"],
      spelling,
    );
  }
  assert.deepEqual(
    relative(root, selectFiles(historical([root], ["/p"]))),
    [],
    "a parent directory is not the project",
  );
  assert.deepEqual(
    relative(root, selectFiles(historical([root], ["/p/one", "/p/two"]))),
    ["one/a.jsonl", "one/a/child.jsonl", "two/b.jsonl"],
    "several projects",
  );

  const other = tmp();
  put(other, "three.jsonl", "/p/one");
  const merged = selectFiles(historical([root, root, other], ["/p/one"]));
  assert.deepEqual(
    merged.files.map((file) => path.basename(file)).sort(),
    ["a.jsonl", "child.jsonl", "three.jsonl"],
    "two roots merge",
  );
  assert.equal(merged.files.length, 3, "the same root twice lists each file once");
  assert.deepEqual([...merged.files].sort(), merged.files, "the result is sorted");
});

test("scope: a symlinked project path matches the real working directory", () => {
  const base = tmp();
  const proj = path.join(base, "proj");
  fs.mkdirSync(proj);
  fs.symlinkSync(proj, path.join(base, "link"));
  const sessions = path.join(base, "sessions");
  put(sessions, "s.jsonl", proj);

  assert.deepEqual(relative(sessions, selectFiles(historical([sessions], [path.join(base, "link")]))), ["s.jsonl"]);
  assert.deepEqual(relative(sessions, selectFiles(historical([sessions], [proj]))), ["s.jsonl"]);
  assert.deepEqual(relative(sessions, selectFiles(historical([sessions], [path.join(base, "other")]))), []);
});

test("scope: an unreadable directory is counted and the rest is selected", { skip: isRoot }, () => {
  const root = tmp();
  put(root, "open/a.jsonl", "/p/one");
  put(root, "locked/b.jsonl", "/p/one");
  fs.chmodSync(path.join(root, "locked"), 0o000);
  try {
    const selection = selectFiles(historical([root], null));
    assert.deepEqual(relative(root, selection), ["open/a.jsonl"]);
    assert.equal(selection.unreadable, 1);
  } finally {
    fs.chmodSync(path.join(root, "locked"), 0o755);
  }
});

test("scope: session scope reads the named files and reports unread children", () => {
  const dir = tmp();
  const parent = put(dir, "A.jsonl", "/p/one");
  put(dir, "A/c1.jsonl", "/p/one");
  put(dir, "A/sub/c2.jsonl", "/p/one");

  const selection = selectFiles({ kind: "session", files: [parent] });
  assert.deepEqual(selection.files, [parent]);
  assert.equal(selection.childFilesNotRead, 2);
  assert.equal(selection.skippedByMtime, 0);
  assert.deepEqual(selectFiles({ kind: "session", files: [parent, parent] }).files, [parent]);
  assert.equal(selectFiles({ kind: "session", files: [path.join(dir, "A", "c1.jsonl")] }).childFilesNotRead, 0);
});

/** Four families at minutes 0 to 4, plus one of each with no timestamp. */
function timedFile(): string {
  const lines: Array<Record<string, unknown>> = [header()];
  for (const minute of [0, 1, 2, 3, 4, null]) {
    const n = minute ?? 9;
    const stamp = minute === null ? {} : { timestamp: at(minute) };
    lines.push({ ...custom(DECISION_ENTRY, decisionV3({ eventId: uuid(10 + n) })), ...stamp });
    lines.push({ ...custom(USAGE_ENTRY, usageV1({ eventId: uuid(510 + n) })), ...stamp });
    lines.push({ ...assistantMessage(), ...stamp });
    lines.push({ ...toolResultMessage(), ...stamp });
  }
  return writeSession(path.join(tmp(), "timed.jsonl"), lines);
}

test("scope: the time window is half-open and unplaced events are counted", () => {
  const file = timedFile();
  const read = readSessions([file]);
  const window: ScopeSpec = {
    kind: "historical",
    since: Date.parse(at(1)),
    until: Date.parse(at(3)),
    projects: null,
    roots: [],
  };

  const filtered = applyFilters(read, window, NO_FILTERS);
  assert.deepEqual(
    filtered.decisions.map((event) => event.view.eventId),
    [uuid(11), uuid(12)],
    "minutes 1 and 2 stay; minute 3 is the exclusive end",
  );
  assert.equal(filtered.usage.length, 2);
  assert.equal(filtered.turns.length, 2);
  assert.equal(filtered.toolResults.length, 2);
  const three = { outsideRange: 3, unplaced: 1, branch: 0, outcome: 0 };
  assert.deepEqual(filtered.removed.decisions, three);
  assert.deepEqual(filtered.removed.usage, three);
  assert.deepEqual(filtered.removed.transcript, { outsideRange: 6, unplaced: 2, branch: 0, outcome: 0 });

  const session = applyFilters(read, { kind: "session", files: [file] }, NO_FILTERS);
  assert.equal(session.decisions.length, 6, "a session scope has no window, so an untimed event stays");
  assert.equal(session.usage.length, 6);
  assert.equal(session.turns.length, 6);
  assert.equal(session.toolResults.length, 6);
  const none = { outsideRange: 0, unplaced: 0, branch: 0, outcome: 0 };
  assert.deepEqual(session.removed, { decisions: none, usage: none, transcript: none });
  assert.equal(session.usageFiltered, false);
});

const node = (entry: Record<string, unknown>, id: string | null, parentId: string | null, minute: number) => ({
  ...entry,
  ...(id === null ? {} : { id, parentId }),
  timestamp: at(minute),
});

/**
 * One file with two branches under `u1` (leaf `d1`), plus two entries without ids:
 * abandoned a1 t1 c1 x1 ux, active a2 t2 c2 dx d1, unknown z1 z2.
 */
function branchedFile(): string {
  return writeSession(path.join(tmp(), "branched.jsonl"), [
    header(),
    node(userMessage("synthetic"), "u1", null, 1),
    node(assistantMessage({ stopReason: "error" }), "a1", "u1", 2),
    node(toolResultMessage(true), "t1", "a1", 3),
    node(custom(USAGE_ENTRY, usageV1({ eventId: uuid(541), stopReason: "error" })), "c1", "a1", 4),
    node(
      custom(DECISION_ENTRY, decisionV3({ eventId: uuid(41), outcome: "failed", failure: "timeout" })),
      "x1",
      "a1",
      5,
    ),
    node(custom(USAGE_ENTRY, { v: 9 }), "ux", "a1", 6),
    node(assistantMessage({ stopReason: "stop" }), "a2", "u1", 7),
    node(toolResultMessage(false), "t2", "a2", 8),
    node(custom(USAGE_ENTRY, usageV1({ eventId: uuid(542), stopReason: "stop" })), "c2", "t2", 9),
    node(custom(DECISION_ENTRY, { v: 4 }), "dx", "c2", 10),
    node(custom(DECISION_ENTRY, decisionV3({ eventId: uuid(42) })), "d1", "dx", 11),
    node(custom(USAGE_ENTRY, usageV1({ eventId: uuid(543), stopReason: "aborted" })), null, null, 12),
    node(custom(DECISION_ENTRY, { v: 4 }), null, null, 13),
  ]);
}

const filterSpec = (over: Partial<FilterSpec>): FilterSpec => ({ ...NO_FILTERS, ...over });
const session = (file: string): ScopeSpec => ({ kind: "session", files: [file] });
const ids = (
  events: Array<{ record: { eventId: string } } | { view: { eventId: string | null } }>,
): Array<string | null> => events.map((event) => ("record" in event ? event.record.eventId : event.view.eventId));

test("scope: branch and outcome filters count each removal once", () => {
  const file = branchedFile();
  const read = readSessions([file]);
  assert.deepEqual(
    [...read.decisions, ...read.usage, ...read.turns, ...read.toolResults].map((event) => event.where.branch).sort(),
    ["abandoned", "abandoned", "abandoned", "abandoned", "active", "active", "active", "active", "unknown"],
  );

  const active = applyFilters(read, session(file), filterSpec({ branch: "active" }));
  assert.deepEqual(ids(active.decisions), [uuid(42)]);
  assert.deepEqual(ids(active.usage), [uuid(542)]);
  assert.equal(active.turns.length, 1);
  assert.equal(active.toolResults.length, 1);
  assert.equal(active.unsupported.length, 1, "only the unsupported record on the active branch stays");
  assert.deepEqual(active.removed.decisions, { outsideRange: 0, unplaced: 0, branch: 2, outcome: 0 });
  assert.deepEqual(active.removed.usage, { outsideRange: 0, unplaced: 0, branch: 3, outcome: 0 });
  assert.deepEqual(active.removed.transcript, { outsideRange: 0, unplaced: 0, branch: 2, outcome: 0 });

  const abandoned = applyFilters(read, session(file), filterSpec({ branch: "abandoned" }));
  assert.deepEqual(ids(abandoned.decisions), [uuid(41)]);
  assert.deepEqual(ids(abandoned.usage), [uuid(541)]);

  const failed = applyFilters(read, session(file), filterSpec({ decision: ["failed"] }));
  assert.deepEqual(ids(failed.decisions), [uuid(41)]);
  assert.deepEqual(failed.removed.decisions, { outsideRange: 0, unplaced: 0, branch: 0, outcome: 1 });
  assert.equal(failed.usage.length, 3, "a decision outcome never filters model turns");
  assert.equal(failed.turns.length, 2);
  assert.equal(failed.unsupported.length, 3, "an unsupported event follows time and branch, not outcome");

  const stopped = applyFilters(read, session(file), filterSpec({ usage: ["error", "aborted"] }));
  assert.deepEqual(ids(stopped.usage), [uuid(541), uuid(543)]);
  assert.equal(stopped.turns.length, 1);
  assert.equal(stopped.decisions.length, 2, "a model-turn outcome never filters decisions");
  assert.deepEqual(stopped.removed.usage, { outsideRange: 0, unplaced: 0, branch: 0, outcome: 1 });
  assert.deepEqual(stopped.removed.transcript, { outsideRange: 0, unplaced: 0, branch: 0, outcome: 1 });
  assert.equal(stopped.unsupported.length, 3);

  const both = applyFilters(read, session(file), filterSpec({ branch: "active", usage: ["error"] }));
  assert.deepEqual(
    both.removed.usage,
    { outsideRange: 0, unplaced: 0, branch: 3, outcome: 1 },
    "counted under the first filter",
  );
  assert.deepEqual(both.removed.transcript, { outsideRange: 0, unplaced: 0, branch: 2, outcome: 1 });

  const window: ScopeSpec = {
    kind: "historical",
    since: Date.parse(at(5)),
    until: Date.parse(at(30)),
    projects: null,
    roots: [],
  };
  const windowed = applyFilters(read, window, filterSpec({ branch: "active" }));
  assert.deepEqual(
    windowed.removed.usage,
    { outsideRange: 1, unplaced: 0, branch: 2, outcome: 0 },
    "outside the window and abandoned: only outsideRange",
  );
  assert.deepEqual(windowed.removed.decisions, { outsideRange: 0, unplaced: 0, branch: 2, outcome: 0 });
  assert.deepEqual(windowed.removed.transcript, { outsideRange: 2, unplaced: 0, branch: 0, outcome: 0 });
});

test("scope: an outcome filter on model turns marks the tool results unattributable", () => {
  const file = branchedFile();
  const read = readSessions([file]);

  const filtered = applyFilters(read, session(file), filterSpec({ usage: ["error"] }));
  assert.equal(filtered.usageFiltered, true);
  assert.equal(filtered.toolResults.length, 2, "tool results are not filtered by a turn outcome");
  assert.equal(applyFilters(read, session(file), filterSpec({ decision: ["failed"] })).usageFiltered, false);
  assert.equal(applyFilters(read, session(file), NO_FILTERS).usageFiltered, false);

  const active = applyFilters(read, session(file), filterSpec({ usage: ["error"], branch: "active" }));
  assert.equal(active.toolResults.length, 1, "time and branch filters still remove tool results");
  assert.deepEqual(active.removed.transcript, { outsideRange: 0, unplaced: 0, branch: 2, outcome: 1 });
});

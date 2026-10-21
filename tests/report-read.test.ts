import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  listSessionFiles,
  parseInstant,
  parseServiceLine,
  readHeader,
  readServiceLogs,
  readSessions,
} from "../src/report/read.ts";
import { DECISION_ENTRY, HTTP_ENTRY, normalizeUsage, USAGE_ENTRY } from "../src/telemetry.ts";
import {
  application,
  assistantMessage,
  chain,
  custom,
  decisionV2,
  decisionV3,
  header,
  httpRecord,
  R1,
  R2,
  serviceLog,
  T0,
  titleSlot,
  tmp,
  toolResultMessage,
  usageV1,
  userMessage,
  uuid,
  writeSession,
} from "./fixtures/report.ts";

const isRoot = process.getuid?.() === 0;

test("reader: versions and unsupported records are counted, not guessed", () => {
  const file = writeSession(path.join(tmp(), "s.jsonl"), [
    header({ id: "sess-M" }),
    ...chain([
      custom(DECISION_ENTRY, decisionV2({ message: "CANARY_V2" })),
      custom(
        DECISION_ENTRY,
        decisionV3({
          eventId: uuid(2),
          outcome: "skipped",
          skip: "command",
          classifier: null,
          tools: null,
          skills: null,
          ratchet: null,
          application: application({ status: "restored", restoration: "restored" }),
        }),
      ),
      custom(DECISION_ENTRY, { tools: { profile: "full" }, dryRun: false }),
      custom(DECISION_ENTRY, { ...decisionV3({ eventId: uuid(3) }), v: 4 }),
      custom(DECISION_ENTRY, { v: 2, tools: null }),
      custom(USAGE_ENTRY, usageV1()),
      custom(USAGE_ENTRY, { ...usageV1({ eventId: uuid(502) }), host: "other" }),
    ]),
  ]);

  const read = readSessions([file]);
  assert.equal(read.decisions.length, 2);
  assert.equal(read.unsupported.filter((event) => event.family === "decision").length, 3);
  assert.equal(read.usage.length, 1);
  assert.equal(read.unsupported.filter((event) => event.family === "usage").length, 1);

  const [old, current] = read.decisions.map((event) => event.view);
  assert.equal(old?.version, 2);
  assert.equal(old?.eventId, null);
  assert.equal(old?.outcome, "classified");
  assert.equal(old?.application, null);
  assert.equal(old?.ratchet?.after, "answer");
  assert.equal(current?.version, 3);
  assert.equal(current?.outcome, "skipped");
  assert.equal(current?.skip, "command");
  assert.doesNotMatch(JSON.stringify(read), /CANARY_V2/);
});

test("reader: malformed, partial and non-object lines never stop a file", () => {
  const file = path.join(tmp(), "s.jsonl");
  const cut = JSON.stringify(custom(USAGE_ENTRY, usageV1({ eventId: uuid(502) }))).slice(0, 40);
  fs.writeFileSync(
    file,
    `${[
      JSON.stringify(header()),
      JSON.stringify(custom(DECISION_ENTRY, decisionV3())),
      "{ truncated",
      "[1,2]",
      '"string"',
      "42",
      "",
      JSON.stringify(custom(USAGE_ENTRY, usageV1())),
    ].join("\n")}\n${cut}`,
  );

  const read = readSessions([file]);
  assert.equal(read.decisions.length, 1);
  assert.equal(read.usage.length, 1);
  assert.equal(read.files[0]?.malformedLines, 5);
});

test("reader: header is found after a title slot and ids never reach events", () => {
  const dir = tmp();
  const withHeader = writeSession(path.join(dir, "a.jsonl"), [
    titleSlot("CANARY_TITLE"),
    header({ id: "sess-H", cwd: "/p/h" }),
    custom(DECISION_ENTRY, decisionV3()),
    custom(USAGE_ENTRY, usageV1()),
  ]);
  const withoutHeader = writeSession(path.join(dir, "b.jsonl"), [
    custom(DECISION_ENTRY, decisionV3({ eventId: uuid(2) })),
    custom(USAGE_ENTRY, usageV1({ eventId: uuid(502) })),
  ]);

  const read = readSessions([withHeader, withoutHeader]);
  const [a, b] = read.files;
  assert.deepEqual([a?.id, a?.cwd, a?.hasHeader], ["sess-H", "/p/h", true]);
  assert.deepEqual([b?.id, b?.cwd, b?.hasHeader], [null, null, false]);
  assert.equal(read.decisions.length, 2);
  assert.equal(read.usage.length, 2);
  const events = JSON.stringify([read.decisions, read.usage, read.turns, read.toolResults, read.unsupported]);
  for (const secret of ["sess-H", "/p/h", "CANARY_TITLE"]) assert.ok(!events.includes(secret), secret);

  assert.deepEqual(readHeader(withHeader), { id: "sess-H", cwd: "/p/h" });
  assert.equal(readHeader(withoutHeader), null);
});

test("reader: only the first four non-blank lines can hold the header, and the peek is bounded", () => {
  const dir = tmp();
  const late = writeSession(path.join(dir, "late.jsonl"), [
    ...[1, 2, 3, 4].map((n) => ({ type: "custom", customType: "other", n })),
    header({ id: "sess-L", cwd: "/p/late" }),
  ]);
  assert.equal(readHeader(late), null);
  assert.equal(readSessions([late]).files[0]?.hasHeader, false);

  const big = writeSession(path.join(dir, "big.jsonl"), [
    header({ id: "sess-B", cwd: "/p/big" }),
    { type: "custom", customType: "other", padding: "x".repeat(200_000) },
  ]);
  assert.deepEqual(readHeader(big), { id: "sess-B", cwd: "/p/big" });
  assert.equal(readHeader(path.join(dir, "missing.jsonl")), null);
});

function branchesOf(entries: Array<Record<string, unknown>>, preamble: Array<Record<string, unknown>> = []): string[] {
  const file = path.join(tmp(), "b.jsonl");
  writeSession(file, [
    ...preamble,
    header(),
    ...entries.map((entry, i) => ({
      ...custom(USAGE_ENTRY, usageV1({ eventId: uuid(600 + i) })),
      timestamp: new Date(Date.parse(T0) + (i + 1) * 60_000).toISOString(),
      ...entry,
    })),
  ]);
  return readSessions([file]).usage.map((event) => event.where.branch);
}

test("reader: branch labels follow the host leaf rule", () => {
  const linear = [
    { id: "a", parentId: null },
    { id: "b", parentId: "a" },
    { id: "c", parentId: "b" },
    { id: "d", parentId: "c" },
  ];
  assert.deepEqual(branchesOf(linear), ["active", "active", "active", "active"]);
  assert.deepEqual(branchesOf(linear, [titleSlot()]), ["active", "active", "active", "active"]);

  // u1 a1 x1 on one branch, a2 x2 on a later one.
  const forked = [
    { id: "u1", parentId: null },
    { id: "a1", parentId: "u1" },
    { id: "x1", parentId: "a1" },
    { id: "a2", parentId: "u1" },
    { id: "x2", parentId: "a2" },
  ];
  assert.deepEqual(branchesOf(forked), ["active", "abandoned", "abandoned", "active", "active"]);
  // A late entry that names the leaf keeps it; without the name the leaf moves to the late entry.
  assert.deepEqual(branchesOf([...forked, { id: "late", parentId: "x1", activeLeafId: "x2" }]), [
    "active",
    "abandoned",
    "abandoned",
    "active",
    "active",
    "abandoned",
  ]);
  assert.deepEqual(branchesOf([...forked, { id: "late", parentId: "x1" }]), [
    "active",
    "active",
    "active",
    "abandoned",
    "abandoned",
    "active",
  ]);

  const unknown = ["unknown", "unknown"];
  assert.deepEqual(branchesOf([{}, {}]), unknown, "no ids");
  assert.deepEqual(
    branchesOf([
      { id: "a", parentId: null },
      { id: "b", parentId: "a", activeLeafId: null },
    ]),
    unknown,
    "no leaf",
  );
  assert.deepEqual(
    branchesOf([
      { id: "a", parentId: "gone" },
      { id: "b", parentId: "a" },
    ]),
    unknown,
    "dangling parent",
  );
  assert.deepEqual(
    branchesOf([
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
    ]),
    unknown,
    "cycle",
  );
  assert.deepEqual(branchesOf([{ id: "a" }, { id: "b", parentId: "a" }]), unknown, "a root without parentId null");

  // A last entry that names a leaf the file does not hold falls back to the newest entry that selects itself.
  assert.deepEqual(
    branchesOf([
      { id: "a", parentId: null },
      { id: "b", parentId: "a" },
      { id: "c", parentId: "b", activeLeafId: "nope" },
    ]),
    ["active", "active", "abandoned"],
  );
  assert.deepEqual(branchesOf([{ id: "a", parentId: null, activeLeafId: "nope" }]), ["unknown"]);
});

test("reader: a pi-shaped file labels its linear chain active", () => {
  const file = writeSession(path.join(tmp(), "pi.jsonl"), [
    { type: "session", version: 3, id: "pi-1", timestamp: T0, cwd: "/p/pi", parentSession: "/elsewhere/parent.jsonl" },
    ...chain([
      userMessage("hello"),
      assistantMessage(),
      custom(USAGE_ENTRY, usageV1({ host: "pi", hostEntryId: "abc12345" })),
    ]),
  ]);
  const read = readSessions([file]);
  assert.deepEqual(
    [read.turns[0]?.where.branch, read.usage[0]?.where.branch, read.usage[0]?.record.host],
    ["active", "active", "pi"],
  );
});

test("reader: transcript turns keep unknown apart from zero and carry no text", () => {
  const file = writeSession(path.join(tmp(), "t.jsonl"), [
    header(),
    ...chain([
      userMessage("CANARY_USER"),
      assistantMessage({ usage: { input: 0, output: 5 } }),
      assistantMessage({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }),
      assistantMessage({ usage: { input: 7, cost: { total: 0.5 } }, stopReason: "weird" }),
      assistantMessage({ stopReason: undefined }),
      assistantMessage({ usage: { input: -1, output: "NaN", cacheRead: "12", cacheWrite: 3, cost: { total: -2 } } }),
      assistantMessage({
        content: [
          { type: "text", text: "CANARY_ASSISTANT" },
          { type: "toolCall", id: "1", name: "read", arguments: { path: "CANARY_ARGS" } },
          { type: "toolCall", id: "2", name: "CANARY tool name", arguments: {} },
        ],
        errorMessage: "CANARY_ERRMSG",
        stopReason: "toolUse",
      }),
      {
        type: "message",
        message: {
          role: "toolResult",
          isError: true,
          usage: { input: 999, output: 999 },
          content: [{ type: "text", text: "CANARY_RESULT" }],
        },
      },
      toolResultMessage(false),
    ]),
  ]);

  const read = readSessions([file]);
  const turns = read.turns;
  assert.equal(turns.length, 6);
  assert.deepEqual(turns[0]?.tokens, { input: 0, output: 5, cacheRead: null, cacheWrite: null });
  assert.equal(turns[0]?.cost, null);
  assert.deepEqual(turns[1]?.tokens, { input: null, output: null, cacheRead: null, cacheWrite: null });
  assert.equal(turns[1]?.cost, null, "no counter above 0 is no measurement");
  assert.deepEqual(turns[2]?.tokens, { input: 7, output: null, cacheRead: null, cacheWrite: null });
  assert.equal(turns[2]?.cost, 0.5);
  assert.equal(turns[2]?.outcome, "other");
  assert.equal(turns[3]?.outcome, "unknown");
  assert.deepEqual(turns[4]?.tokens, { input: null, output: null, cacheRead: null, cacheWrite: 3 });
  assert.equal(turns[4]?.cost, null);
  assert.deepEqual(turns[5]?.tools, { read: 1, "(redacted)": 1 });
  assert.equal(turns[5]?.outcome, "toolUse");

  assert.deepEqual(
    read.toolResults.map((event) => event.isError),
    [true, false],
  );
  assert.deepEqual(
    turns.map((turn) => turn.tokens.input),
    [0, null, 7, 10, null, 10],
    "a usage block on a tool result (input 999) is never read",
  );
  assert.doesNotMatch(JSON.stringify([read.turns, read.toolResults, read.decisions, read.usage]), /CANARY_/);
  assert.match(fs.readFileSync(file, "utf8"), /CANARY_USER/, "the canary is in the transcript");
});

test("reader: transcript token counts must be safe integers, so no sum can overflow", () => {
  const file = writeSession(path.join(tmp(), "t.jsonl"), [
    header(),
    ...chain([
      assistantMessage({
        usage: { input: 1e308, output: 5, cacheRead: 2.5, cacheWrite: 2 ** 53, cost: { total: 0.25 } },
      }),
      assistantMessage({ usage: { input: 1e308, cost: { total: 0.25 } } }),
    ]),
  ]);

  const { turns } = readSessions([file]);
  assert.deepEqual(turns[0]?.tokens, { input: null, output: 5, cacheRead: null, cacheWrite: null });
  assert.equal(turns[0]?.cost, 0.25);
  assert.deepEqual(
    turns[1]?.tokens,
    { input: null, output: null, cacheRead: null, cacheWrite: null },
    "no valid counter above 0 is no measurement",
  );
  assert.equal(turns[1]?.cost, null);
});

function copyFixture(dir: string) {
  const lines = (id: string | null) => [
    header({ id, cwd: "/p/one" }),
    ...chain([
      custom(DECISION_ENTRY, decisionV3({ eventId: uuid(1), sessionId: "s-a" })),
      custom(USAGE_ENTRY, usageV1({ eventId: uuid(501), sessionId: "s-a" })),
      custom(DECISION_ENTRY, decisionV2()),
    ]),
  ];
  return {
    a: writeSession(path.join(dir, "a.jsonl"), lines("s-a")),
    b: writeSession(path.join(dir, "b.jsonl"), lines("s-b")),
    noId: writeSession(path.join(dir, "c.jsonl"), lines(null)),
  };
}

test("reader: copied histories count once and keep their provenance", () => {
  const { a, b, noId } = copyFixture(tmp());

  const both = readSessions([a, b]);
  const v3 = both.decisions.filter((event) => event.view.version === 3);
  const v2 = both.decisions.filter((event) => event.view.version === 2);
  assert.deepEqual(
    v3.map((event) => event.identity),
    [{ provenance: "origin", copies: 1 }],
  );
  assert.deepEqual(
    both.usage.map((event) => event.identity),
    [{ provenance: "origin", copies: 1 }],
  );
  assert.deepEqual(
    v2.map((event) => event.identity),
    [
      { provenance: "unknown", copies: 0 },
      { provenance: "unknown", copies: 0 },
    ],
  );
  assert.deepEqual(both.duplicatesRemoved, { decisions: 1, usage: 1 });
  assert.deepEqual(readSessions([b, a]), both, "argument order does not matter");

  const copyOnly = readSessions([b]);
  const identities = [...copyOnly.decisions, ...copyOnly.usage]
    .filter((event) => (event.kind === "decision" ? event.view.version === 3 : true))
    .map((event) => event.identity);
  assert.deepEqual(identities, [
    { provenance: "inherited", copies: 0 },
    { provenance: "inherited", copies: 0 },
  ]);

  const headerless = readSessions([noId]);
  assert.deepEqual(
    [...headerless.decisions, ...headerless.usage].filter((event) => event.identity.provenance !== "unknown"),
    [],
  );

  const twice = readSessions([a, a]);
  assert.equal(twice.files.length, 1);
  assert.deepEqual(twice.duplicatesRemoved, { decisions: 0, usage: 0 });
});

test("reader: a record appended twice inside one file counts one copy", () => {
  const record = custom(DECISION_ENTRY, decisionV3({ eventId: uuid(1), sessionId: "s-a" }));
  const file = writeSession(path.join(tmp(), "dup.jsonl"), [header({ id: "s-a" }), ...chain([record, record])]);
  const read = readSessions([file]);
  assert.equal(read.decisions.length, 1);
  assert.deepEqual(read.decisions[0]?.identity, { provenance: "origin", copies: 1 });
  assert.deepEqual(read.duplicatesRemoved, { decisions: 1, usage: 0 });
});

test("reader: nested child sessions are flagged, not rolled up", () => {
  const dir = tmp();
  const parent = writeSession(path.join(dir, "d", "s.jsonl"), [
    header({ id: "s-p" }),
    ...chain([custom(DECISION_ENTRY, decisionV3({ eventId: uuid(1), sessionId: "s-p" }))]),
  ]);
  const child = writeSession(path.join(dir, "d", "s", "child.jsonl"), [
    header({ id: "s-c" }),
    ...chain([custom(DECISION_ENTRY, decisionV3({ eventId: uuid(2), sessionId: "s-c" }))]),
  ]);

  const read = readSessions([child, parent]);
  const byPath = new Map(read.files.map((info) => [info.path, info]));
  assert.equal(byPath.get(fs.realpathSync(parent))?.nestedChild, false);
  assert.equal(byPath.get(fs.realpathSync(child))?.nestedChild, true);
  assert.deepEqual(
    read.decisions.map((event) => [read.files[event.where.file]?.id, event.view.eventId]),
    [
      ["s-p", uuid(1)],
      ["s-c", uuid(2)],
    ],
  );
});

test("reader: a looping parent location is no parent and never throws", () => {
  const dir = tmp();
  const file = writeSession(path.join(dir, "d", "s.jsonl"), [header({ id: "s-p" })]);
  fs.symlinkSync("d.jsonl", path.join(dir, "d.jsonl"));

  const info = readSessions([file]).files[0];
  assert.equal(info?.unreadable, false);
  assert.equal(info?.nestedChild, false);
});

test("reader: unreadable paths are reported, never thrown", () => {
  const dir = tmp();
  const good = writeSession(path.join(dir, "good.jsonl"), [header(), ...chain([custom(DECISION_ENTRY, decisionV3())])]);
  const directory = path.join(dir, "adir.jsonl");
  fs.mkdirSync(directory);

  const read = readSessions([path.join(dir, "missing.jsonl"), directory, good]);
  assert.equal(read.files.length, 3);
  assert.deepEqual(
    read.files.map((info) => [path.basename(info.path), info.unreadable]),
    [
      ["adir.jsonl", true],
      ["good.jsonl", false],
      ["missing.jsonl", true],
    ],
  );
  assert.equal(read.decisions.length, 1);
});

test("reader: session discovery is recursive, sorted, jsonl-only and tolerates a missing root", () => {
  const root = tmp();
  for (const rel of ["b/z.jsonl", "a/y.jsonl", "a/y/child.jsonl", "a/note.txt", "c.jsonl.bak", "top.jsonl"]) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), "");
  }
  const found = listSessionFiles(root).map((file) => path.relative(root, file));
  assert.deepEqual(found, ["a/y.jsonl", "a/y/child.jsonl", "b/z.jsonl", "top.jsonl"]);
  assert.deepEqual(listSessionFiles(path.join(root, "missing")), []);
});

test("reader: an unreadable directory is reported once and the rest is listed", { skip: isRoot }, () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "open"));
  fs.mkdirSync(path.join(root, "locked"));
  fs.writeFileSync(path.join(root, "open", "a.jsonl"), "");
  fs.writeFileSync(path.join(root, "locked", "b.jsonl"), "");
  fs.chmodSync(path.join(root, "locked"), 0o000);
  try {
    let unreadable = 0;
    const found = listSessionFiles(root, () => unreadable++).map((file) => path.relative(root, file));
    assert.deepEqual(found, ["open/a.jsonl"]);
    assert.equal(unreadable, 1);
  } finally {
    fs.chmodSync(path.join(root, "locked"), 0o755);
  }
});

test("reader: timestamps accept strict ISO only", () => {
  const accepted: Array<[string, number]> = [
    ["2026-10-01", 1790812800000],
    ["2026-10-01T00:00:00Z", 1790812800000],
    ["2026-10-01T00:00:00.5Z", 1790812800500],
    ["2026-10-01T00:00:00.123456789Z", 1790812800123],
    ["2026-10-01T02:00:00+02:00", 1790812800000],
    ["2026-10-01T00:00:00+02:00", 1790805600000],
    ["2024-02-29", Date.UTC(2024, 1, 29)],
  ];
  for (const [text, ms] of accepted) assert.equal(parseInstant(text), ms, text);

  const rejected = [
    "2026-10-01T00:00:00",
    "2026-10-01T00:00Z",
    "7d",
    "CANARY 2026",
    "2026-02-30",
    "2026-02-29",
    "2026-13-01",
    "2026-10-01T24:00:00Z",
    "2026-10-01T23:59:60Z",
    "2026-10-01T00:00:00+0200",
    "2026-10-01T00:00:00+24:00",
    "1969-12-31",
    " 2026-10-01",
    "",
  ];
  for (const text of rejected) assert.equal(parseInstant(text), null, JSON.stringify(text));

  const file = writeSession(path.join(tmp(), "t.jsonl"), [
    header(),
    { ...custom(USAGE_ENTRY, usageV1({ eventId: uuid(1) })), timestamp: "CANARY 2026" },
    custom(USAGE_ENTRY, usageV1({ eventId: uuid(2) })),
    { ...custom(USAGE_ENTRY, usageV1({ eventId: uuid(3) })), timestamp: T0 },
  ]);
  const ats = readSessions([file]).usage.map((event) => event.where.at);
  assert.deepEqual(ats, [Date.parse(T0), null, null], "a malformed or missing timestamp is unplaced, never now");
});

test("reader: a transcript tool name is a candidate only when it is identifier-shaped, by normalizeUsage's rule", () => {
  const names = [
    "read",
    "mcp__srv__tool",
    "a.b:c@d/e+f-g",
    "x".repeat(100),
    "x".repeat(101),
    " lead",
    "has space",
    "",
    "-dash",
  ];
  const file = writeSession(path.join(tmp(), "n.jsonl"), [
    header(),
    ...chain(
      names.map((name) =>
        assistantMessage({ content: [{ type: "toolCall", id: "1", name, arguments: {} }], stopReason: "toolUse" }),
      ),
    ),
  ]);
  // The reader's gate is the shape alone: a model can write an identifier-shaped name that no host registered, so a
  // report prints a candidate only when a plugin record vouches for it (see the summary test).
  const turns = readSessions([file]).turns;
  assert.equal(turns.length, names.length);
  for (const [i, name] of names.entries()) {
    const kept = Object.keys(normalizeUsage({ ...usageV1(), toolCalls: { [name]: 1 } })?.toolCalls ?? {}).length === 1;
    assert.deepEqual(turns[i]?.tools, kept ? { [name]: 1 } : { "(redacted)": 1 }, JSON.stringify(name));
  }
});

test("reader: service logs keep records, skip noise and dedupe request ids", () => {
  const dir = tmp();
  const log = serviceLog(path.join(dir, "h1.log"));
  const read = readServiceLogs([log, path.join(dir, "missing.log")]);
  assert.deepEqual(read.lines, { total: 9, records: 4, unsupported: 1, other: 4 });
  assert.equal(read.records.length, 3);
  assert.equal(read.duplicates, 1);
  assert.equal(read.unreadable, 1);
  assert.deepEqual(
    read.records.map((record) => record.requestId),
    [R1, R2, uuid(109)],
  );

  const nulls = path.join(dir, "nulls.log");
  const anonymous = JSON.stringify(httpRecord({ requestId: null, idStatus: "absent" }));
  fs.writeFileSync(nulls, `${anonymous}\n${anonymous}\n`);
  const kept = readServiceLogs([nulls]);
  assert.equal(kept.records.length, 2, "null-id records are never deduplicated");
  assert.equal(kept.duplicates, 0);

  const different = path.join(dir, "different.log");
  fs.writeFileSync(
    different,
    `${JSON.stringify(httpRecord({ requestId: R1 }))}\n${JSON.stringify(httpRecord({ requestId: R1, outcome: "rejected", status: 401 }))}\n`,
  );
  const conflicting = readServiceLogs([different]);
  assert.equal(conflicting.records.length, 2, "records that differ for one id are all kept");
  assert.equal(conflicting.duplicates, 0);
});

test("reader: a service line parses after plain, journald and cat framing", () => {
  const record = httpRecord({ requestId: R1, queueMs: 3 });
  const json = JSON.stringify(record);
  for (const line of [json, `Oct 10 00:00:05 host python[123]: ${json}`, `  ${json}`]) {
    assert.deepEqual(parseServiceLine(line), record, line);
  }
  assert.equal(parseServiceLine("   "), "blank");
  assert.equal(parseServiceLine("ready on http://127.0.0.1:8799"), "other");
  assert.equal(parseServiceLine("{ not json"), "other");
  assert.equal(parseServiceLine('{"type":"other","v":1}'), "other");
  assert.equal(parseServiceLine("[1,2]"), "other");
  assert.equal(parseServiceLine(JSON.stringify({ ...record, v: 2 })), "unsupported");
  assert.equal(parseServiceLine(JSON.stringify({ type: HTTP_ENTRY, v: 1, outcome: "ok" })), "unsupported");
});

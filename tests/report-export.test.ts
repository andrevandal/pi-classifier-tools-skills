import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { type Allow, DECISION, exportDocument, HTTP, pick, USAGE } from "../src/report/export.ts";
import { DISCLOSURES, summarize } from "../src/report/summary.ts";
import { DECISION_ENTRY, normalizeDecision, normalizeHttp, normalizeUsage, USAGE_ENTRY } from "../src/telemetry.ts";
import {
  application,
  assistantMessage,
  chain,
  classifier,
  custom,
  decisionV2,
  decisionV3,
  header,
  httpRecord,
  R1,
  R2,
  ratchet,
  reportInput,
  serviceLog,
  skills,
  titleSlot,
  tmp,
  tools,
  usageV1,
  userMessage,
  uuid,
  writeMixed,
  writeSession,
} from "./fixtures/report.ts";

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]);
}

/** Every hostile surface at once: transcript text, host entries, plugin records with extra and unsafe fields. */
function hostile(dir: string): { file: string; log: string } {
  const decision = {
    ...decisionV3({ eventId: uuid(21), decisionId: uuid(221) }),
    sessionId: "CANARY session id",
    extra: "CANARY_EXTRA",
    classifier: { ...classifier({ requestId: uuid(200) }), model: "CANARY model text" },
    tools: {
      ...tools(),
      profile: "CANARY text profile",
      extra: "CANARY_NESTED",
      probabilities: { "CANARY key": 1, IDENT_KEY: 0.5 },
    },
    skills: { ...skills(), selected: ["CANARY skill text"] },
    ratchet: { ...ratchet(), before: "CANARY ratchet text" },
    application: { ...application(), error: "CANARY error text" },
  };
  const file = writeSession(path.join(dir, "hostile.jsonl"), [
    titleSlot("CANARY_TITLE"),
    header({ id: "sess-H", cwd: "/p/CANARY_CWD" }),
    userMessage("CANARY_USER"),
    assistantMessage({
      content: [
        { type: "text", text: "CANARY_ASSISTANT" },
        { type: "toolCall", id: "1", name: "read", arguments: { path: "CANARY_ARGS" } },
        { type: "toolCall", id: "2", name: "CANARY tool name", arguments: {} },
      ],
      errorMessage: "CANARY_ERRMSG",
    }),
    {
      type: "message",
      message: { role: "toolResult", isError: true, content: [{ type: "text", text: "CANARY_RESULT" }] },
    },
    { type: "custom_message", customType: "loadout.skills", content: "CANARY_SKILLS", display: false },
    custom("other.plugin", { text: "CANARY_OTHER" }),
    { type: "model_usage", errorMessage: "CANARY_MODEL_USAGE" },
    custom(DECISION_ENTRY, decision),
    custom(
      DECISION_ENTRY,
      decisionV3({ eventId: uuid(22), decisionId: uuid(222), classifier: classifier({ requestId: uuid(201) }) }),
    ),
    custom(USAGE_ENTRY, {
      ...usageV1({ eventId: uuid(521) }),
      toolCalls: { "CANARY tool name": 1, IDENT_tool: 2 },
      stopReason: "CANARY",
      note: "CANARY_NOTE",
    }),
    custom(DECISION_ENTRY, "CANARY_DATA_STRING"),
    '{ "broken": CANARY_MALFORMED',
  ]);
  const record = (requestId: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ ...httpRecord({ requestId, queueMs: 3 }), ...extra });
  const log = path.join(dir, "hostile.log");
  fs.writeFileSync(
    log,
    `${[
      record(uuid(200), { errorClass: "CANARY error", body: "CANARY_BODY" }),
      "CANARY_NOISE",
      "Traceback ... {CANARY_TRACE",
      `CANARY_HOST python[1]: ${record(uuid(201))}`,
    ].join("\n")}\n`,
  );
  return { file, log };
}

test("export: canaries in transcripts, records and logs never reach the output", () => {
  const { file, log } = hostile(tmp());
  const input = reportInput([file], { serviceLogs: [log] });
  const doc = exportDocument(input);
  const summary = summarize(input);

  assert.doesNotMatch(JSON.stringify(doc), /CANARY/);
  assert.doesNotMatch(JSON.stringify(summary), /CANARY/);
  assert.match(fs.readFileSync(file, "utf8"), /CANARY_USER/, "the canary is in the transcript");
  assert.deepEqual([...new Set(doc.events.map((event) => event.type))].sort(), ["decision", "http", "usage"]);
  assert.deepEqual(doc.http, { records: 2, exported: 2 });
  assert.equal(doc.events.filter((event) => event.type === "http").length, 2);

  // The documented limit: an identifier-shaped value in an identifier field is exported.
  const exported = JSON.stringify(doc);
  assert.match(exported, /IDENT_KEY/);
  assert.match(exported, /IDENT_tool/);
});

test("export: identifier-shaped values are exported from identifier fields and nowhere else", () => {
  const dir = tmp();
  const decision = {
    ...decisionV3({ eventId: uuid(31), decisionId: uuid(331), sessionId: "IDENT_session" }),
    extra: "IDENT_extra",
    classifier: { ...classifier({ requestId: uuid(300) }), model: "IDENT_model" },
    tools: {
      ...tools({
        profile: "IDENT_profile",
        active: ["IDENT_active"],
        risks: [{ profile: "IDENT_riskProfile", risk: 0.1 }],
      }),
      probabilities: { IDENT_probability: 0.5 },
      extra: "IDENT_nested",
    },
    skills: skills({ reason: "selected", selected: ["IDENT_skill"], scores: { IDENT_score: 0.9 } }),
    ratchet: ratchet({ before: "IDENT_before", after: "IDENT_after" }),
    application: application({ actualTools: ["IDENT_actual"] }),
  };
  const file = writeSession(path.join(dir, "ident.jsonl"), [
    header({ id: "sess-I" }),
    ...chain([
      custom(DECISION_ENTRY, decision),
      custom(USAGE_ENTRY, {
        ...usageV1({
          eventId: uuid(531),
          sessionId: "IDENT_usageSession",
          hostEntryId: "IDENT_hostEntry",
          toolCalls: { IDENT_call: 1 },
        }),
        extra: "IDENT_usageExtra",
      }),
    ]),
  ]);
  const log = path.join(dir, "ident.log");
  fs.writeFileSync(
    log,
    `${JSON.stringify({ ...httpRecord({ requestId: uuid(300) }), errorClass: "IDENT_ErrClass", body: "IDENT_body" })}\n`,
  );

  const text = JSON.stringify(exportDocument(reportInput([file], { serviceLogs: [log] })));
  const markers = [...new Set([...text.matchAll(/IDENT_\w+/g)].map((match) => match[0]))].sort();
  assert.deepEqual(
    markers,
    [
      ...["IDENT_ErrClass", "IDENT_active", "IDENT_actual", "IDENT_after", "IDENT_before", "IDENT_call"],
      ...["IDENT_hostEntry", "IDENT_model", "IDENT_probability", "IDENT_profile", "IDENT_riskProfile"],
      ...["IDENT_score", "IDENT_session", "IDENT_skill", "IDENT_usageSession"],
    ].sort(),
    "an unlisted field (extra, nested, usageExtra, body) never carries a value out",
  );
});

test("export: events are built from a declared allowlist", () => {
  const complete = normalizeDecision(
    decisionV3({
      eventId: uuid(7),
      classifier: classifier({
        requestId: uuid(8),
        usage: { inputTokens: 1, outputTokens: 2 },
        server: { queueMs: 3, inferenceMs: 4 },
        status: 500,
      }),
      skills: skills({
        reason: "selected",
        selected: ["pdf"],
        scores: { pdf: 0.9 },
        discovered: 2,
        eligible: 2,
        asked: 2,
        filteredOut: 1,
        delivery: "filter",
      }),
      application: application({ restoration: "restored", error: "EIO" }),
    }),
  );
  assert.ok(complete !== null);
  assert.deepEqual(pick(complete, DECISION), complete, "a view field missing from the allowlist fails here");

  const extra = JSON.parse(JSON.stringify(complete));
  extra.sneaky = "x";
  extra.settings.sneaky = "x";
  extra.classifier.sneaky = "x";
  extra.tools.sneaky = "x";
  extra.tools.risks[0].sneaky = "x";
  assert.deepEqual(pick(extra, DECISION), complete);

  const v2 = normalizeDecision(decisionV2());
  assert.ok(v2 !== null);
  const picked = pick(v2, DECISION) as Record<string, unknown>;
  assert.deepEqual(picked, v2);
  assert.equal(picked.settings, null);
  assert.equal(picked.classifier, null);

  const usage = normalizeUsage(
    usageV1({
      decisionId: uuid(9),
      turnIndex: 2,
      hostEntryId: "abc",
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 },
      costTotal: 0.5,
      toolCalls: { read: 1 },
      toolErrors: 0,
      errorStatus: 529,
      retryAttempt: 1,
    }),
  );
  assert.deepEqual(pick(usage, USAGE), usage);
  const http = normalizeHttp(httpRecord({ requestId: uuid(10), status: 200, queueMs: 1, inferenceMs: 2, totalMs: 3 }));
  assert.deepEqual(pick(http, HTTP), http);

  assert.deepEqual(pick({ a: 1, extra: 2 }, { a: true }), { a: 1 });
  assert.deepEqual(pick([{ x: 1, y: 2 }, { x: 3 }], [{ x: true }]), [{ x: 1 }, { x: 3 }]);
  assert.deepEqual(pick({ a: [1, "x", {}] }, { a: true }), { a: [1, "x", null] }, "an array of scalars keeps scalars");
  assert.deepEqual(pick({ ok: 1, "bad key": 2, text: "3", inf: Number.POSITIVE_INFINITY, "": 4 }, "map"), { ok: 1 });
  assert.deepEqual(pick("text", "map"), {});
  assert.deepEqual(
    pick({}, { a: true, b: { c: true }, d: [true] }),
    { a: null, b: null, d: null },
    "a missing value is null",
  );
  assert.deepEqual(pick({ a: { b: 1 }, c: "x", d: Number.NaN }, { a: true, c: { z: true }, d: true }), {
    a: null,
    c: null,
    d: null,
  });
  const rule: Allow = { a: true };
  assert.equal(pick("not an object", rule), null);
  assert.equal(pick("not an array", [true]), null);
});

test("export: events keep provenance and carry no paths", () => {
  const dir = tmp("loadout-export-paths-");
  const lines = (id: string) => [
    header({ id, cwd: "/p/cwd-marker" }),
    ...chain([
      custom(DECISION_ENTRY, decisionV3({ eventId: uuid(1), sessionId: "s-a" })),
      custom(USAGE_ENTRY, usageV1({ eventId: uuid(501), sessionId: "s-a" })),
    ]),
  ];
  const a = writeSession(path.join(dir, "a.jsonl"), lines("s-a"));
  const b = writeSession(path.join(dir, "b.jsonl"), lines("s-b"));

  const doc = exportDocument(reportInput([a, b]));
  assert.deepEqual(
    doc.events.map((event) => [event.type, event.branch, event.provenance, event.copies]),
    [
      ["decision", "active", "origin", 1],
      ["usage", "active", "origin", 1],
    ],
  );
  const text = JSON.stringify(doc);
  for (const secret of [dir, "s-b", "/p/cwd-marker", "a.jsonl", "b.jsonl"]) assert.ok(!text.includes(secret), secret);

  // A header id that no record carries never leaves the process.
  const private_ = writeSession(path.join(dir, "c.jsonl"), [
    header({ id: "hdr-private", cwd: "/p/cwd-marker" }),
    ...chain([custom(DECISION_ENTRY, decisionV3({ eventId: uuid(2), sessionId: "recorded-id" }))]),
  ]);
  const inherited = exportDocument(reportInput([private_]));
  assert.equal(inherited.events[0]?.provenance, "inherited");
  assert.ok(!JSON.stringify(inherited).includes("hdr-private"));

  const forbidden = ["path", "cwd", "title", "message", "content", "text", "prompt", "arguments", "args", "body"];
  const recordKeys = keysOf(doc.events.map((event) => event.record));
  assert.deepEqual(
    recordKeys.filter((key) => forbidden.includes(key)),
    [],
  );
});

test("export: only joined http records are exported and the document carries disclosures", () => {
  const dir = tmp();
  const file = writeMixed(dir).file;
  const h1 = serviceLog(path.join(dir, "h1.log"));

  const doc = exportDocument(reportInput([file], { serviceLogs: [h1] }));
  const http = doc.events.filter((event) => event.type === "http");
  assert.deepEqual(
    http.map((event) => event.record.requestId),
    [R1, R2],
    "nothing is exported for the record no in-scope attempt names",
  );
  assert.deepEqual(doc.http, { records: 3, exported: 2 });
  for (const event of http) assert.deepEqual([event.branch, event.provenance, event.copies], [null, null, null]);
  assert.deepEqual(
    http.map((event) => event.at),
    [http[0]?.record.at, http[1]?.record.at],
  );
  assert.deepEqual(doc.disclosures, DISCLOSURES);
  assert.equal(doc.schema, "loadout-report.export/1");

  const conflict = path.join(dir, "conflict.log");
  fs.writeFileSync(
    conflict,
    `${[
      JSON.stringify(httpRecord({ requestId: R1, queueMs: 5, inferenceMs: 40, totalMs: 47 })),
      JSON.stringify(httpRecord({ requestId: R1, outcome: "rejected", status: 401, totalMs: 1 })),
    ].join("\n")}\n`,
  );
  const conflicting = exportDocument(reportInput([file], { serviceLogs: [conflict] }));
  assert.equal(conflicting.events.filter((event) => event.type === "http").length, 0);
  assert.deepEqual(conflicting.http, { records: 2, exported: 0 });

  const without = exportDocument(reportInput([file]));
  assert.equal(without.http, null);
  assert.equal(without.events.filter((event) => event.type === "http").length, 0);
  assert.equal(without.events.length, 10, "ten decisions");
});

test("export: output is independent of argument order", () => {
  const dir = tmp();
  const lines = (id: string) => [
    header({ id, cwd: "/p/one" }),
    ...chain([
      custom(DECISION_ENTRY, decisionV3({ eventId: uuid(1), sessionId: "s-a" })),
      custom(USAGE_ENTRY, usageV1({ eventId: uuid(501), sessionId: "s-a" })),
      custom(DECISION_ENTRY, decisionV2()),
    ]),
  ];
  const a = writeSession(path.join(dir, "a.jsonl"), lines("s-a"));
  const b = writeSession(path.join(dir, "b.jsonl"), lines("s-b"));
  const log = serviceLog(path.join(dir, "h1.log"));

  const forward = exportDocument(reportInput([a, b], { serviceLogs: [log] }));
  assert.deepEqual(exportDocument(reportInput([b, a], { serviceLogs: [log] })), forward);

  const order = forward.events.map((event) => event.type);
  assert.deepEqual(
    order,
    [...order].sort((x, y) => ["decision", "usage", "http"].indexOf(x) - ["decision", "usage", "http"].indexOf(y)),
  );
  for (const type of ["decision", "usage"]) {
    const stamps = forward.events.filter((event) => event.type === type).map((event) => Date.parse(event.at ?? ""));
    assert.deepEqual(
      stamps,
      [...stamps].sort((x, y) => x - y),
    );
  }
});

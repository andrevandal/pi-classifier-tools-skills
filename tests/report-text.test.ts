/**
 * The text renderer behind `scripts/decisions.ts` and `/loadout stats`: pure functions over a `Summary`.
 * Every expectation derives from the `Summary` the report library built, never from a typed-in copy of its numbers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSummary } from "../src/report/report.ts";
import { NO_FILTERS, type ScopeSpec } from "../src/report/scope.ts";
import type { Sum, Summary } from "../src/report/summary.ts";
import { renderDecisions, renderSummary } from "../src/report/text.ts";
import { DECISION_ENTRY, USAGE_ENTRY } from "../src/telemetry.ts";
import {
  chain,
  classifier,
  custom,
  decisionV2,
  decisionV3,
  header,
  serviceLog,
  settings,
  tmp,
  usageV1,
  uuid,
  writeMixed,
  writeSession,
  writeSmokeTree,
  writeUsageHistory,
} from "./fixtures/report.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sessionSummary = (files: string[], serviceLogs: string[] = []): Summary =>
  buildSummary({ scope: { kind: "session", files }, filters: NO_FILTERS, serviceLogs });

const historicalSummary = (root: string, over: Partial<Extract<ScopeSpec, { kind: "historical" }>> = {}): Summary =>
  buildSummary({
    scope: {
      kind: "historical",
      since: Date.parse("2026-10-01T00:00:00.000Z"),
      until: Date.parse("2026-11-01T00:00:00.000Z"),
      projects: null,
      roots: [root],
      ...over,
    },
    filters: NO_FILTERS,
    serviceLogs: [],
  });

/** The mixed decision history and the usage history side by side in one session scope. */
function twoFileSummary(): Summary {
  const dir = tmp();
  return sessionSummary([writeMixed(dir).file, writeUsageHistory(dir).file]);
}

function lineStarting(text: string, prefix: string): string {
  const found = text.split("\n").find((line) => line.startsWith(prefix));
  assert.ok(found !== undefined, `no line starts with ${JSON.stringify(prefix)}`);
  return found;
}

/** The heading line and the indented lines under it. */
function section(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.startsWith(heading));
  assert.ok(at >= 0, `no section starts with ${JSON.stringify(heading)}`);
  const out = [lines[at] as string];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith("  ")) break;
    out.push(line);
  }
  return out;
}

const within = (lines: string[], prefix: string): string => {
  const found = lines.find((line) => line.startsWith(prefix));
  assert.ok(found !== undefined, `no line starts with ${JSON.stringify(prefix)} in ${lines[0]}`);
  return found;
};

const numbers = (line: string): number[] => [...line.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));

/** The contract for a `Sum` (plan D2.6): `unknown`, `0`, the sum, or the sum with how many values were unknown. */
function sumText(sum: Sum): string {
  if (sum.known === 0) return sum.unknown > 0 ? "unknown" : "0";
  return sum.unknown > 0 ? `${sum.sum} (+${sum.unknown} unknown)` : String(sum.sum);
}

test("decisions script prints exactly renderDecisions", () => {
  const { file } = writeMixed(tmp());
  const summary = sessionSummary([file]);

  // An empty HOME, so a developer's real sessions cannot change what the script reads.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp("loadout-report-home-") };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, [path.join(ROOT, "scripts", "decisions.ts"), "--session", file], {
    encoding: "utf8",
    env,
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `${renderDecisions(summary)}\n`);
});

test("renderSummary starts with the scope and contains renderDecisions verbatim", () => {
  const { file } = writeMixed(tmp());
  const summary = sessionSummary([file]);
  const text = renderSummary(summary);
  const { scope, coverage } = summary;
  const first = text.split("\n")[0];
  assert.equal(
    first,
    `scope: session files | files ${scope.files} (read ${coverage.files.read}, unreadable ${coverage.files.unreadable}) | child sessions not read ${scope.childFilesNotRead}`,
  );
  assert.ok(text.includes(renderDecisions(summary)), "the decisions text is embedded unchanged");

  const root = tmp();
  writeSmokeTree(root);
  for (const projects of [null, ["/smoke/one"]]) {
    const history = historicalSummary(root, { projects });
    const line = renderSummary(history).split("\n")[0];
    assert.equal(
      line,
      `scope: history ${history.scope.since} to ${history.scope.until} (UTC, until exclusive) | ${projects === null ? "all projects" : "exact project match"} | files ${history.scope.files} (read ${history.coverage.files.read}, unreadable ${history.coverage.files.unreadable}, skipped by mtime ${history.coverage.files.skippedByMtime}) | nested child sessions read separately ${history.scope.nestedChildFiles}`,
    );
    assert.ok(renderSummary(history).includes(renderDecisions(history)));
  }
});

test("renderSummary keeps classifier calls and model turns in separate sections", () => {
  const summary = twoFileSummary();
  const text = renderSummary(summary);
  const attempts = summary.classifier.attempts;
  const turns = summary.usage.turns;
  assert.ok(attempts > 0 && turns > 0 && attempts !== turns, "the fixture has both kinds of record");

  assert.deepEqual(numbers(lineStarting(text, "classifier calls")), [attempts]);
  const model = lineStarting(text, "model turns");
  assert.equal(numbers(model)[0], turns);
  assert.notEqual(lineStarting(text, "classifier calls"), model);

  const total = new RegExp(`\\b${attempts + turns}\\b`);
  for (const line of text.split("\n")) {
    if (/^(classifier calls|model turns|host transcript turns)/.test(line)) assert.doesNotMatch(line, total, line);
  }
});

test("renderSummary prints the Summary's own figures", () => {
  const summary = twoFileSummary();
  const text = renderSummary(summary);
  const { classifier, usage, coverage } = summary;

  const calls = section(text, "classifier calls");
  assert.deepEqual(numbers(calls[0] as string), [classifier.attempts]);
  assert.equal(
    within(calls, "  tokens:"),
    `  tokens: in ${sumText(classifier.tokens.input)}, out ${sumText(classifier.tokens.output)}`,
  );
  assert.deepEqual(numbers(within(calls, "  server timing:")).slice(0, 2), [
    classifier.server.reported,
    classifier.server.unreported,
  ]);
  assert.deepEqual(numbers(within(calls, "  guard fired:")), [
    classifier.guardFired.yes,
    classifier.guardFired.no,
    classifier.guardFired.unknown,
    classifier.promptClipped.yes,
    classifier.promptClipped.no,
    classifier.promptClipped.unknown,
    classifier.requestIds.present,
    classifier.requestIds.absent,
  ]);
  for (const [model, n] of Object.entries(classifier.models)) {
    assert.match(within(calls, "  models:"), new RegExp(`${model} ${n}\\b`));
  }

  const turns = section(text, "model turns");
  assert.deepEqual(numbers(turns[0] as string).slice(0, 2), [usage.turns, usage.runs]);
  assert.deepEqual(numbers(within(turns, "  assigned to a decision:")), [
    usage.assignment.assigned,
    usage.assignment.unassigned,
  ]);
  const { tokens } = usage;
  assert.equal(
    within(turns, "  tokens:"),
    `  tokens: input ${sumText(tokens.input)}, output ${sumText(tokens.output)}, cache read ${sumText(tokens.cacheRead)}, cache write ${sumText(tokens.cacheWrite)}, reasoning ${sumText(tokens.reasoning)}`,
  );
  const cost = within(turns, "  cost:");
  assert.ok(Math.abs((numbers(cost)[0] as number) - usage.cost.sum) < 1e-9, cost);
  assert.match(
    cost,
    usage.cost.unknown > 0 ? new RegExp(`\\(\\+${usage.cost.unknown} unknown\\)`) : /^[^(]*\(the host/,
  );
  const toolCalls = within(turns, "  tool calls:");
  assert.equal(numbers(toolCalls)[0], usage.toolCalls.total);
  for (const [tool, n] of Object.entries(usage.toolCalls.byTool))
    assert.match(toolCalls, new RegExp(`${tool} ${n}\\b`));
  assert.ok(toolCalls.endsWith(`tool errors: ${sumText(usage.toolErrors)}`), toolCalls);

  const cov = within(text.split("\n"), "coverage:");
  assert.deepEqual(numbers(cov).slice(0, 9), [
    coverage.files.read,
    coverage.files.unreadable,
    coverage.files.withoutHeader,
    coverage.malformedLines,
    coverage.unsupported.decisions,
    coverage.unsupported.usage,
    coverage.duplicatesRemoved.decisions,
    coverage.duplicatesRemoved.usage,
    coverage.unidentifiable.decisions,
  ]);
  assert.equal(
    lineStarting(text, "host transcript turns").includes(`: ${summary.transcript.turns}`),
    true,
    "the transcript section has its own total",
  );
});

test("renderSummary prints unknown as unknown", () => {
  const dir = tmp();
  const rows = [1, 2, 3].map((n) => custom(USAGE_ENTRY, usageV1({ eventId: uuid(600 + n), runId: uuid(900 + n) })));
  const allNull = sessionSummary([writeSession(path.join(dir, "nulls.jsonl"), [header(), ...chain(rows)])]);
  assert.equal(allNull.usage.turns, 3);
  assert.equal(allNull.usage.tokens.input.known, 0);
  const text = renderSummary(allNull);
  const turns = section(text, "model turns");
  assert.equal(
    within(turns, "  tokens:"),
    "  tokens: input unknown, output unknown, cache read unknown, cache write unknown, reasoning unknown",
  );
  assert.match(within(turns, "  cost:"), /^ {2}cost: unknown /);
  assert.equal(within(turns, "  tool calls:").endsWith("tool errors: unknown"), true);
  assert.doesNotMatch(within(turns, "  tokens:") + within(turns, "  cost:"), /\b0\b/);
  assert.doesNotMatch(text, /NaN|undefined|null|\[object/);

  // A sum that is known for some turns says how many were not.
  const partly = twoFileSummary();
  const { input, output } = partly.usage.tokens;
  assert.ok(input.known > 0 && input.unknown > 0, "the fixture has a turn without tokens");
  assert.ok(
    within(section(renderSummary(partly), "model turns"), "  tokens:").startsWith(
      `  tokens: input ${input.sum} (+${input.unknown} unknown), output ${output.sum} (+${output.unknown} unknown)`,
    ),
  );
});

test("renderSummary prints blockers with their population", () => {
  const summary = twoFileSummary();
  const text = renderSummary(summary);
  assert.ok(summary.leads.length > 0);
  assert.ok(text.includes("blockers (counts, each out of the population shown; descriptive, no cause implied)"));
  for (const lead of summary.leads) {
    assert.ok(text.includes(`  ${lead.id}: ${lead.count} of ${lead.of}`), `${lead.id} is listed with its population`);
  }
  assert.doesNotMatch(text, /blockers: none/);

  const clean = writeSession(path.join(tmp(), "clean.jsonl"), [
    header(),
    ...chain([custom(DECISION_ENTRY, decisionV3())]),
  ]);
  const quiet = sessionSummary([clean]);
  assert.equal(quiet.leads.length, 0);
  const none = renderSummary(quiet);
  assert.ok(none.includes("blockers: none recorded in this scope"));
  assert.doesNotMatch(none, /blockers \(counts/);
});

test("renderSummary names what was not read or counted", () => {
  const dir = tmp();
  const decision = (n: number) =>
    custom(DECISION_ENTRY, decisionV3({ eventId: uuid(700 + n), decisionId: uuid(800 + n) }));
  const file = writeSession(path.join(dir, "s.jsonl"), [
    header({ id: "sess-C" }),
    ...chain([
      decision(1),
      decision(1),
      decision(2),
      custom(DECISION_ENTRY, { ...decisionV3({ eventId: uuid(790) }), v: 9 }),
      custom(DECISION_ENTRY, decisionV2()),
    ]),
    "{ not json",
  ]);
  writeSession(path.join(dir, "s", "child.jsonl"), [header({ id: "sess-child" }), ...chain([decision(3)])]);

  const summary = sessionSummary([file]);
  const { coverage, scope } = summary;
  assert.deepEqual(
    [
      coverage.malformedLines,
      coverage.duplicatesRemoved.decisions,
      coverage.unsupported.decisions,
      coverage.unidentifiable.decisions,
      scope.childFilesNotRead,
    ],
    [1, 1, 1, 1, 1],
    "the fixture holds each case once",
  );
  const text = renderSummary(summary);
  assert.ok(text.split("\n")[0]?.endsWith(`child sessions not read ${scope.childFilesNotRead}`));
  const cov = lineStarting(text, "coverage:");
  assert.ok(cov.includes(`malformed lines ${coverage.malformedLines}`), cov);
  assert.ok(
    cov.includes(
      `unsupported records: decisions ${coverage.unsupported.decisions}, model turns ${coverage.unsupported.usage}`,
    ),
    cov,
  );
  assert.ok(
    cov.includes(
      `duplicates removed: decisions ${coverage.duplicatesRemoved.decisions}, model turns ${coverage.duplicatesRemoved.usage}`,
    ),
    cov,
  );
  assert.ok(cov.includes(`v2 decisions without event id ${coverage.unidentifiable.decisions}`), cov);
  assert.doesNotMatch(cov, /removed by the window or filters/, "a scope that removes nothing prints no such clause");

  // A historical window removes records, and a record whose host entry has no timestamp cannot be placed in it.
  const root = tmp();
  const w = writeSmokeTree(root);
  writeSession(path.join(root, "undated", "u.jsonl"), [
    header({ id: "s-u", cwd: "/smoke/one" }),
    { ...decision(4), id: "e1", parentId: null },
  ]);
  const history = historicalSummary(root, { since: Date.parse(w.narrowSince), until: Date.parse(w.narrowUntil) });
  const counters = Object.values(history.coverage.removedByFilters);
  const removed = counters.reduce((sum, c) => sum + c.outsideRange + c.unplaced + c.branch + c.outcome, 0);
  const unplaced = counters.reduce((sum, c) => sum + c.unplaced, 0);
  assert.ok(removed > unplaced && unplaced > 0, "the window removes records and one record has no timestamp");
  assert.ok(
    lineStarting(renderSummary(history), "coverage:").endsWith(
      `removed by the window or filters ${removed} (no timestamp ${unplaced})`,
    ),
  );
});

test("renderSummary is descriptive only", () => {
  const root = tmp();
  writeSmokeTree(root);
  const dir = tmp();
  const { file } = writeMixed(dir);
  const usage = writeUsageHistory(dir).file;
  const summaries = [
    sessionSummary([file]),
    sessionSummary([usage]),
    sessionSummary([file, usage], [serviceLog(path.join(dir, "service.log"))]),
    historicalSummary(root),
    historicalSummary(tmp()),
  ];
  const advice = /\b(raise|lower|loosen|increase|should|recommend|saving|saved|benefit|improve|because)\b/i;
  for (const summary of summaries) assert.doesNotMatch(renderSummary(summary), advice);
});

test("renderSummary says when a scope matches nothing", () => {
  const summary = historicalSummary(tmp());
  assert.equal(summary.scope.files, 0);
  const text = renderSummary(summary);
  assert.ok(text.includes("no session files matched this scope; every count is zero"));
  assert.ok(text.includes("loadout decisions: 0"));
  assert.doesNotMatch(text, /NaN|undefined|null|\[object/);

  const { file } = writeMixed(tmp());
  assert.doesNotMatch(renderSummary(sessionSummary([file])), /no session files matched/);
});

test("renderSummary shows the service join only when a log was given", () => {
  const dir = tmp();
  const { file } = writeMixed(dir);
  const log = serviceLog(path.join(dir, "service.log"));
  const joined = sessionSummary([file], [log]);
  assert.ok(joined.http !== null && joined.http.joined > 0, "the fixture joins a request id");
  const line = lineStarting(renderSummary(joined), "service log:");
  assert.ok(line.includes(`joined ${joined.http.joined} of ${joined.classifier.attempts} attempts`), line);
  assert.ok(line.includes(`${joined.http.records} records in ${joined.http.files} files`), line);
  assert.ok(line.includes("not joinable (not HTTP) 0"), "a log was read and no attempt was off the HTTP transport");

  // An attempt that carries a request id but went to a transport the server never sees is counted apart, so the
  // joined and unjoined attempts can be added up.
  const jev = writeSession(path.join(dir, "jev.jsonl"), [
    header({ id: "sess-jev", cwd: "/p/one" }),
    ...chain([
      custom(
        DECISION_ENTRY,
        decisionV3({
          eventId: uuid(11),
          sessionId: "sess-jev",
          decisionId: uuid(211),
          settings: settings({ backend: "jev", transport: null }),
          classifier: classifier({ requestId: uuid(300) }),
        }),
      ),
    ]),
  ]);
  const withJev = sessionSummary([file, jev], [log]);
  const notJoinable = withJev.http?.unmatched.notJoinable;
  assert.equal(notJoinable, 1, "the fixture has one attempt that cannot join");
  const jevLine = lineStarting(renderSummary(withJev), "service log:");
  assert.ok(jevLine.includes(`not joinable (not HTTP) ${notJoinable}`), jevLine);

  assert.equal(
    lineStarting(renderSummary(sessionSummary([file])), "service log:"),
    "service log: not read (--service-log <file> joins server records by request id)",
  );
});

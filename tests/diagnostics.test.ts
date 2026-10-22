/** Notice, `status`, `explain` and `stats` texts; pure, so records and counters go in and text comes out. */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { defaultConfig } from "../src/config.ts";
import {
  type ExplainInput,
  explainText,
  headline,
  noticeText,
  type Observation,
  type StatusInput,
  statsText,
  statusText,
} from "../src/diagnostics.ts";
import { buildSummary } from "../src/report/report.ts";
import { NO_FILTERS } from "../src/report/scope.ts";
import { renderSummary } from "../src/report/text.ts";
import type { DecisionRecordV3, PersistResult, ToolsRecord } from "../src/telemetry.ts";
import type { LoadoutConfig, TelemetryReason, TelemetryState } from "../src/types.ts";
import {
  application,
  BASE7,
  classifier,
  decisionV3,
  ratchet,
  settings,
  skills,
  tmp,
  tools,
  uuid,
  writeMixed,
  writeUsageHistory,
} from "./fixtures/report.ts";

const ANSWER = ["read", "grep", "find", "ls"];
const BASELINE_SIZE = BASE7.length;
const LOW_RISKS = [
  { profile: "answer", risk: 0.45 },
  { profile: "edit", risk: 0.15 },
];

const lowConfidence = (over: Partial<ToolsRecord> = {}) =>
  tools({
    reason: "low-confidence",
    profile: "full",
    active: null,
    probabilities: { answer: 0.55, edit: 0.3, full: 0.15 },
    risk: null,
    risks: LOW_RISKS,
    maxRisk: 0.1,
    ...over,
  });
const noAnswer = (reason: "missing-answer" | "disabled") =>
  tools({ reason, profile: null, active: null, probabilities: {}, risk: null, risks: null });
const baselineChosen = () =>
  tools({ reason: "selected", profile: "full", active: null, probabilities: { full: 0.9 }, risk: 0, risks: [] });
const skipped = (skip: DecisionRecordV3["skip"], over: Partial<DecisionRecordV3> = {}): DecisionRecordV3 =>
  decisionV3({
    outcome: "skipped",
    skip,
    classifier: null,
    tools: null,
    skills: null,
    ratchet: null,
    application: application({ status: "restored", restoration: "restored", actualTools: BASE7 }),
    ...over,
  });
const failed = (failure: DecisionRecordV3["failure"], over: Partial<DecisionRecordV3> = {}): DecisionRecordV3 =>
  decisionV3({
    outcome: "failed",
    failure,
    tools: null,
    skills: skills({ reason: null }),
    application: application({ status: "not-attempted", actualTools: BASE7 }),
    ...over,
  });

function rows(): Map<string, DecisionRecordV3> {
  const live = (over: Partial<DecisionRecordV3>) => decisionV3(over);
  const entries: Array<[string, DecisionRecordV3]> = [
    ["applied", live({})],
    ["applied-baseline", live({ tools: baselineChosen(), application: application({ actualTools: BASE7 }) })],
    ["already-matching", live({ application: application({ status: "unchanged" }) })],
    [
      "keep-low-confidence",
      live({ tools: lowConfidence(), application: application({ status: "unchanged", actualTools: BASE7 }) }),
    ],
    [
      "keep-low-confidence-no-risk",
      live({
        tools: lowConfidence({ risks: null }),
        application: application({ status: "unchanged", actualTools: BASE7 }),
      }),
    ],
    [
      "keep-no-answer",
      live({ tools: noAnswer("missing-answer"), application: application({ status: "restored", actualTools: BASE7 }) }),
    ],
    [
      "keep-selection-off",
      live({ tools: noAnswer("disabled"), application: application({ status: "not-attempted", actualTools: BASE7 }) }),
    ],
    [
      "keep-baseline",
      live({ tools: baselineChosen(), application: application({ status: "unchanged", actualTools: BASE7 }) }),
    ],
    [
      "dry-run",
      live({
        settings: settings({ dryRun: true }),
        application: application({ status: "dry-run", actualTools: BASE7 }),
      }),
    ],
    [
      "dry-run-keep",
      live({
        settings: settings({ dryRun: true }),
        tools: lowConfidence(),
        application: application({ status: "dry-run", actualTools: BASE7 }),
      }),
    ],
    [
      "widen-only",
      live({
        ratchet: ratchet({ narrowAllowed: false, before: "edit", after: "edit", admitted: false }),
        application: application({ status: "not-admitted", actualTools: BASE7 }),
      }),
    ],
    [
      "dry-run-widen-only",
      live({
        settings: settings({ dryRun: true }),
        ratchet: ratchet({ narrowAllowed: false, before: "edit", after: "edit", admitted: false }),
        application: application({ status: "dry-run", actualTools: BASE7 }),
      }),
    ],
    [
      "apply-failed",
      live({
        application: application({ status: "failed", restoration: "restored", actualTools: BASE7, error: "EIO" }),
      }),
    ],
    [
      "apply-failed-no-restore",
      live({
        application: application({ status: "failed", restoration: "failed", actualTools: ANSWER, error: "EIO" }),
      }),
    ],
    [
      "apply-failed-keep",
      live({
        tools: lowConfidence(),
        application: application({ status: "failed", restoration: null, actualTools: BASE7, error: "error" }),
      }),
    ],
    [
      "skills-over-limit",
      live({ skills: skills({ reason: "too-many-candidates", discovered: 52, eligible: 52, maxCandidates: 40 }) }),
    ],
    [
      "skills-selected",
      live({
        skills: skills({
          reason: "selected",
          selected: ["pdf", "deploy"],
          scores: { pdf: 0.8, deploy: 0.6 },
          asked: 2,
          eligible: 2,
          discovered: 2,
        }),
      }),
    ],
    [
      "skills-would-select",
      live({
        settings: settings({ dryRun: true }),
        application: application({ status: "dry-run", actualTools: BASE7 }),
        skills: skills({
          reason: "selected",
          selected: ["pdf"],
          scores: { pdf: 0.8 },
          asked: 1,
          eligible: 1,
          discovered: 1,
        }),
      }),
    ],
    ["skills-no-answer", live({ skills: skills({ reason: "missing-answer", asked: 2, eligible: 2, discovered: 2 }) })],
    ["skip-off", skipped("disabled")],
    ["skip-empty", skipped("empty-prompt")],
    ["skip-command", skipped("command")],
    [
      "skip-nothing-to-ask",
      skipped("no-questions", { skills: skills({ reason: "disabled", discovered: 3, eligible: 3 }) }),
    ],
    [
      "skip-nothing-to-ask-over-limit",
      skipped("no-questions", {
        skills: skills({ reason: "too-many-candidates", discovered: 52, eligible: 52, maxCandidates: 40 }),
      }),
    ],
    [
      "timeout",
      failed("timeout", {
        classifier: classifier({ elapsedMs: 4300, budgetMs: 4250, timeoutMs: 4000, guardFired: true }),
      }),
    ],
    ["unavailable", failed("unavailable", { classifier: classifier({ elapsedMs: 12, status: 503 }) })],
    ["warming", failed("warming", { classifier: classifier({ elapsedMs: 0 }) })],
    ["error-no-call", failed("error", { classifier: null })],
  ];
  return new Map(entries);
}

const ROWS = rows();
const row = (label: string): DecisionRecordV3 => {
  const found = ROWS.get(label);
  assert.ok(found, `no row ${label}`);
  return found;
};

const HANDED: PersistResult = { outcome: "handed-off" };
const observation = (record: DecisionRecordV3 | null, over: Partial<Observation> = {}): Observation => ({
  record,
  message: null,
  stored: HANDED,
  ...over,
});
const ON: TelemetryState = { persist: true, reason: "default" };
const off = (reason: TelemetryReason): TelemetryState => ({ persist: false, reason });
const explain = (latest: Observation | null, over: Partial<ExplainInput> = {}): string =>
  explainText({ latest, lastRecord: null, baselineSize: BASELINE_SIZE, telemetry: ON, ...over });
const statusOf = (over: Partial<StatusInput> = {}): string =>
  statusText({
    config: defaultConfig(),
    source: null,
    scope: null,
    telemetry: ON,
    collection: { handedOff: 0, suppressed: 0, failed: 0, lastFailure: null },
    baseline: null,
    lastRecord: null,
    latest: null,
    seen: { classified: 0, failed: 0, skipped: 0 },
    modelTurns: 0,
    ...over,
  });

const lineOf = (text: string, prefix: string): string => {
  const found = text.split("\n").find((line) => line.trimStart().startsWith(prefix));
  assert.ok(found !== undefined, `no line starts with ${JSON.stringify(prefix)} in:\n${text}`);
  return found;
};
const ADVICE = /\b(raise|lower|loosen|increase|should|recommend|saving|saved|benefit|improve)\b/i;

test("headline: low confidence, skill overflow, dry run, ratchet rejection, application, already matching, timeout and collection failure read differently, and only an applied change says applied", () => {
  const headlines = new Map([...ROWS].map(([label, record]) => [label, headline(record, BASELINE_SIZE)]));
  assert.equal(new Set(headlines.values()).size, ROWS.size, "every row reads differently");

  const text = (label: string): string => headlines.get(label) as string;
  for (const label of ["keep-low-confidence", "dry-run-keep"]) {
    for (const fact of ["low confidence", "0.15", "0.10"]) assert.ok(text(label).includes(fact), `${label}: ${fact}`);
  }
  assert.ok(text("keep-low-confidence-no-risk").includes("no risk known"));
  assert.ok(text("skills-over-limit").includes("52") && text("skills-over-limit").includes("limit 40"));
  assert.ok(
    text("skip-nothing-to-ask-over-limit").includes("52") &&
      text("skip-nothing-to-ask-over-limit").includes("limit 40"),
  );
  assert.ok(text("dry-run").includes("dry run") && text("dry-run").includes("nothing changed"));
  assert.ok(
    text("dry-run").includes(`would use answer (tools ${ANSWER.length})`),
    "an admitted proposal is the proposal",
  );
  const dryBlocked = text("dry-run-widen-only");
  for (const fact of ["dry run", "widen-only would keep edit", "not answer", "nothing changed"]) {
    assert.ok(dryBlocked.includes(fact), `dry-run-widen-only: ${fact}`);
  }
  assert.ok(!dryBlocked.includes("would use"), "a narrowing the ratchet refuses is not offered as the proposal");
  assert.ok(
    text("widen-only").includes("widen-only") && text("widen-only").includes("edit"),
    "names the profile it kept",
  );
  assert.ok(text("widen-only").includes("answer"), "names the blocked proposal");
  assert.ok(text("already-matching").includes("already matching"));
  assert.ok(text("apply-failed").includes("EIO") && text("apply-failed").includes("baseline restored"));
  assert.ok(text("apply-failed-no-restore").includes("baseline restore failed"));
  for (const fact of ["timeout after", "4300", "4250", "guard fired"]) assert.ok(text("timeout").includes(fact), fact);
  assert.ok(text("unavailable").includes("HTTP 503") && text("unavailable").includes("12 ms"));
  assert.ok(text("skills-selected").includes("2 selected"));
  assert.ok(text("skills-would-select").includes("would select 1"));
  assert.ok(text("skip-command").includes("slash command"));

  // `applied` belongs to an applied change and nothing else.
  for (const [label, record] of ROWS) {
    assert.equal(
      /\bapplied\b/i.test(text(label)),
      record.outcome === "classified" && record.application.status === "applied",
      `${label}: ${text(label)}`,
    );
  }
});

test("headline: the baseline size is used only when the caller has it", () => {
  const record = row("applied");
  assert.ok(headline(record, BASELINE_SIZE).includes(`(tools ${ANSWER.length} of ${BASELINE_SIZE})`));
  const without = headline(record);
  assert.ok(without.includes(`(tools ${ANSWER.length})`) && !without.includes(" of "), without);
  const unreadable = headline({ ...record, application: { ...record.application, actualTools: null } }, BASELINE_SIZE);
  assert.ok(!unreadable.includes("(") && unreadable.startsWith("applied "), unreadable);
});

test("explain: shows each profile's probability and risk against the threshold, the gate, candidate counts, questions, clipping, usage and server timing", () => {
  const record = decisionV3({
    tools: lowConfidence(),
    skills: skills({ reason: "too-many-candidates", discovered: 52, eligible: 52, maxCandidates: 40, asked: 0 }),
    classifier: classifier({
      requestId: uuid(7),
      model: "model-a",
      elapsedMs: 120,
      budgetMs: 4250,
      timeoutMs: 4000,
      usage: { inputTokens: 41, outputTokens: 3 },
      server: { queueMs: 3.2, inferenceMs: 41.5 },
      promptChars: 30,
      sentChars: 24,
      questions: 1,
    }),
    ratchet: ratchet({ narrowAllowed: true, before: null, after: "full", admitted: true }),
    application: application({ status: "unchanged", actualTools: BASE7 }),
  });
  const text = explain(observation(record));
  assert.equal(text.split("\n")[0], "[loadout] explain: latest invocation");
  for (const fact of [
    "answer: p 0.55, risk 0.45 > 0.10",
    "edit: p 0.30, risk 0.15 > 0.10",
    "full: p 0.15 (broadest, the baseline)",
    "tools: low confidence, no profile within max risk 0.10",
    "proposal: keep all tools (baseline)",
    "ratchet: - -> full (admitted, narrowing open)",
    "blocked: low confidence, skills over the candidate limit",
    "skills: 52 eligible > limit 40 (discovered 52): none asked, all skills kept",
    "classifier: 1 question (tools 1, skills 0) | prompt 30 chars, sent 24 (clipped) | model model-a | tokens in 41, out 3",
    "timing: 120 ms of 4250 ms budget (timeout 4000 ms), guard not fired",
    `server: queue 3.2 ms, inference 41.5 ms | request ${uuid(7)}`,
    "settings then: dry run off | max risk 0.10 | laya (http) | skills off | config global",
  ]) {
    assert.ok(text.includes(fact), `missing ${JSON.stringify(fact)} in:\n${text}`);
  }
  assert.ok(text.includes("outcome: all tools kept: low confidence"), "the outcome is the headline");
  assert.ok(!text.includes("applied"), "an unchanged low-confidence turn never reads as applied");

  const chosen = explain(observation(decisionV3()));
  assert.ok(chosen.includes("tools: selected answer (risk 0.05 <= max risk 0.10)"), chosen);
  assert.ok(chosen.includes("answer: p 0.95, risk 0.05 <= 0.10 <- chosen"), chosen);
  assert.ok(chosen.includes("edit: p 0.03, risk 0.02 <= 0.10"), chosen);
  assert.ok(!lineOf(chosen, "edit:").includes("<- chosen"));
  assert.ok(chosen.includes("proposal: answer: read, grep, find, ls (4)"), chosen);
  assert.ok(
    chosen.includes("classifier: 1 question (tools 1, skills 0) | prompt 20 chars, sent 20 (not clipped)"),
    chosen,
  );
  assert.ok(chosen.includes("blocked: none"), chosen);
  assert.ok(chosen.includes("skills: selection off (discovered 0, eligible 0)"), chosen);

  const skillRows = explain(observation(row("skills-selected")));
  assert.ok(
    skillRows.includes("skills: asked 2, selected pdf, deploy | delivery none | scores pdf 0.80, deploy 0.60"),
    skillRows,
  );
  const filtered = explain(
    observation(
      decisionV3({
        skills: skills({
          reason: "selected",
          selected: ["pdf"],
          scores: { pdf: 0.9 },
          asked: 1,
          delivery: "filter",
          filteredOut: 3,
        }),
      }),
    ),
  );
  assert.ok(filtered.includes("delivery filter (3 hidden)"), filtered);
});

test("explain: a request id that the transport never sent is marked not sent", () => {
  const id = uuid(7);
  const requestLine = (over: Parameters<typeof settings>[0], requestId: string | null = id): string =>
    lineOf(
      explain(observation(decisionV3({ settings: settings(over), classifier: classifier({ requestId }) }))),
      "server:",
    );

  assert.ok(requestLine({ transport: "http" }).endsWith(`| request ${id}`), "the Laya HTTP transport sends it");
  assert.ok(
    requestLine({ transport: "python" }).endsWith(`| request ${id} (not sent)`),
    "the local sidecar never sends it",
  );
  assert.ok(
    requestLine({ backend: "jev", transport: null }).endsWith(`| request ${id} (not sent)`),
    "Jev never sends it",
  );
  assert.ok(requestLine({ transport: "python" }, null).endsWith("| request none"), "no id: nothing to mark");
});

test("explain: unknown stays unknown", () => {
  const record = decisionV3({
    tools: tools({ risks: null }),
    classifier: classifier({ model: null, usage: null, server: null, requestId: null }),
  });
  const text = explain(observation(record));
  assert.ok(text.includes("    risks: unknown (no probability in the answer)"), text);
  assert.ok(text.includes("model unknown | tokens not reported"), text);
  assert.ok(text.includes("server: not reported | request none"), text);
  assert.doesNotMatch(text, /NaN|undefined|null/);
  assert.doesNotMatch(lineOf(text, "server:"), /\b0\b/);
  assert.doesNotMatch(lineOf(text, "classifier:"), /tokens in/);

  const oneKnown = explain(
    observation(decisionV3({ classifier: classifier({ server: { queueMs: 3.2, inferenceMs: null } }) })),
  );
  assert.ok(oneKnown.includes("server: queue 3.2 ms, inference not reported | request none"), oneKnown);
  const halfTokens = explain(
    observation(decisionV3({ classifier: classifier({ usage: { inputTokens: 41, outputTokens: null } }) })),
  );
  assert.ok(halfTokens.includes("tokens in 41, out unknown"), halfTokens);
  const otherHalf = explain(
    observation(decisionV3({ classifier: classifier({ usage: { inputTokens: null, outputTokens: 3 } }) })),
  );
  assert.ok(otherHalf.includes("tokens in unknown, out 3"), otherHalf);

  const unknownApplication = explain(observation(decisionV3({ application: application({ actualTools: null }) })));
  assert.ok(unknownApplication.includes("actual tools: unknown"), unknownApplication);
  assert.doesNotMatch(unknownApplication, /NaN|undefined|null/);

  const noProbability = explain(
    observation(decisionV3({ tools: tools({ probabilities: { edit: 0.03, full: 0.02 } }) })),
  );
  assert.ok(noProbability.includes("answer: p unknown, risk 0.05 <= 0.10"), noProbability);
});

test("explain: proposal versus actual application and the blockers", () => {
  const dry = explain(observation(row("dry-run")));
  assert.ok(dry.includes("blocked: dry run"), dry);
  assert.ok(dry.includes(`proposal: answer: read, grep, find, ls (${ANSWER.length})`), dry);
  assert.ok(dry.includes(`application: dry-run | actual tools: ${BASE7.join(", ")} (${BASE7.length})`), dry);
  assert.ok(!/\bapplied\b/i.test(dry), "a dry run is never called applied");
  assert.equal(lineOf(dry, "blocked:"), "  blocked: dry run", "an admitted dry run names no ratchet");

  const dryBlocked = explain(observation(row("dry-run-widen-only")));
  assert.equal(lineOf(dryBlocked, "blocked:"), "  blocked: dry run, widen-only ratchet (would keep edit)");
  assert.ok(dryBlocked.includes("ratchet: edit -> edit (blocked, narrowing locked)"), dryBlocked);
  assert.ok(dryBlocked.includes("application: dry-run"), dryBlocked);
  assert.ok(!/\bapplied\b/i.test(dryBlocked), "a dry run is never called applied");

  const combined = explain(
    observation(
      decisionV3({
        settings: settings({ dryRun: true }),
        tools: lowConfidence(),
        skills: skills({ reason: "too-many-candidates", discovered: 3, eligible: 3, maxCandidates: 2 }),
        application: application({ status: "dry-run", actualTools: BASE7 }),
      }),
    ),
  );
  assert.ok(combined.includes("blocked: dry run, low confidence, skills over the candidate limit"), combined);
  assert.ok(combined.includes("skills: 3 eligible > limit 2 (discovered 3): none asked, all skills kept"), combined);
  assert.ok(!/\bapplied\b/i.test(combined));

  const ratchetBlock = explain(observation(row("widen-only")));
  assert.ok(ratchetBlock.includes("blocked: widen-only ratchet (kept edit)"), ratchetBlock);
  assert.ok(ratchetBlock.includes("ratchet: edit -> edit (blocked, narrowing locked)"), ratchetBlock);
  assert.ok(ratchetBlock.includes("application: not-admitted"), ratchetBlock);

  const missing = explain(
    observation(
      decisionV3({
        tools: noAnswer("missing-answer"),
        application: application({ status: "unchanged", actualTools: BASE7 }),
      }),
    ),
  );
  assert.ok(missing.includes("blocked: no tool answer"), missing);
  assert.ok(missing.includes("tools: no answer to the tool question"), missing);

  const applyFailed = explain(observation(row("apply-failed")));
  assert.ok(applyFailed.includes("application: failed (restore: restored) [EIO] | actual tools:"), applyFailed);
  const restored = explain(observation(skipped("command")));
  assert.ok(restored.includes("application: restored (restore: restored) | actual tools:"), restored);
  const applied = explain(observation(decisionV3()));
  assert.ok(applied.includes("application: applied | actual tools: read, grep, find, ls (4)"), applied);
});

test("explain: in memory is told apart from stored", () => {
  const record = decisionV3();
  const source = (latest: Observation, telemetry: TelemetryState = ON): string =>
    lineOf(explain(latest, { telemetry }), "source:");

  assert.equal(source(observation(record)), "  source: in memory | record handed to host");
  for (const reason of ["machine-off", "machine-unreadable", "config-error", "config-off"] as const) {
    const text = explain(observation(record, { stored: { outcome: "suppressed" } }), { telemetry: off(reason) });
    assert.equal(lineOf(text, "source:"), `  source: in memory | record not stored: telemetry off (${reason})`);
    assert.ok(!text.includes("handed to host"), "never claims a hand-over that did not happen");
  }
  const refused = explain(observation(record, { stored: { outcome: "failed", code: "EACCES" } }));
  assert.equal(lineOf(refused, "source:"), "  source: in memory | record not stored: EACCES");
  assert.ok(!refused.includes("handed to host"));

  const lost = observation(null, { stored: { outcome: "failed", code: "error" }, message: "boom\nsecond line" });
  const text = explain(lost, { lastRecord: row("already-matching") });
  assert.equal(lineOf(text, "source:"), "  source: in memory | no record could be built (error)");
  assert.deepEqual(
    text.split("\n").map((line) => line.trim().split(":")[0]),
    ["[loadout] explain", "source", "failure text (memory only, never stored)", "previous decision"],
  );
  assert.ok(text.includes("failure text (memory only, never stored): boom second line"), "one line");
  assert.ok(text.includes(`previous decision: ${headline(row("already-matching"), BASELINE_SIZE)}`));
  const bare = explain(observation(null, { stored: { outcome: "failed", code: "error" } }));
  assert.equal(bare.split("\n").length, 2, "no message and no earlier decision: the title and the source only");
});

test("explain: skipped, failed and unbuildable invocations", () => {
  const command = explain(observation(row("skip-command")));
  assert.ok(command.includes("outcome: skipped: slash command, not classified"), command);
  for (const absent of ["tools:", "proposal:", "blocked:", "classifier:", "timing:", "server:", "ratchet:"]) {
    assert.ok(!command.includes(`  ${absent}`), `a skip has no ${absent} line`);
  }
  assert.ok(command.includes("application: restored (restore: restored)"), command);
  assert.ok(command.includes("settings then:"), command);

  const overflow = explain(observation(row("skip-nothing-to-ask-over-limit")));
  assert.ok(overflow.includes("outcome: skipped: nothing to ask (52 candidates > limit 40)"), overflow);
  assert.ok(overflow.includes("skills: 52 eligible > limit 40 (discovered 52): none asked, all skills kept"), overflow);

  const timeout = explain(observation(row("timeout")));
  assert.ok(
    timeout.includes("outcome: classification failed: timeout after 4300 ms (budget 4250 ms, guard fired)"),
    timeout,
  );
  assert.ok(timeout.includes("timing: 4300 ms of 4250 ms budget (timeout 4000 ms), guard fired"), timeout);
  assert.ok(timeout.includes("server: not reported | request none"), timeout);
  assert.ok(!timeout.includes("  tools:") && !timeout.includes("proposal:"), "a failure made no proposal");

  const unavailable = explain(observation(row("unavailable"), { message: "classifier said CANARY_MESSAGE_M1" }));
  assert.ok(unavailable.includes("outcome: classification failed: unavailable (HTTP 503) after 12 ms"), unavailable);
  assert.ok(
    unavailable.includes("timing: 12 ms of 3250 ms budget (timeout 3000 ms), guard not fired | HTTP 503"),
    unavailable,
  );
  assert.ok(
    unavailable.includes("failure text (memory only, never stored): classifier said CANARY_MESSAGE_M1"),
    unavailable,
  );

  const long = explain(observation(row("unavailable"), { message: `${"x".repeat(500)}\nmore` }));
  assert.ok(lineOf(long, "failure text").length <= "  failure text (memory only, never stored): ".length + 200);

  const noCall = explain(observation(row("error-no-call")));
  assert.ok(noCall.includes("classifier: no call recorded"), noCall);

  assert.equal(explain(null), "[loadout] explain: nothing observed yet in this process");
});

test("explain: the previous decision is one line when the latest is a skip", () => {
  const last = row("already-matching");
  const text = explain(observation(row("skip-command")), { lastRecord: last });
  const lines = text.split("\n").filter((line) => line.includes("previous decision:"));
  assert.deepEqual(lines, [`  previous decision: ${headline(last, BASELINE_SIZE)}`]);
  assert.equal(text.split("\n").at(-1), lines[0], "it closes the block");

  assert.ok(
    !explain(observation(row("skip-command"))).includes("previous decision"),
    "none when there is no earlier one",
  );
  assert.ok(!explain(observation(decisionV3()), { lastRecord: last }).includes("previous decision"), "only for a skip");
});

test("status: prints the safe effective settings and nothing else", () => {
  const base = defaultConfig();
  const canaries = [
    "CANARY_ENDPOINT_E1",
    "CANARY_QUERY_Q1",
    "CANARY_ENV_NAME_V1",
    "CANARY_PYTHON_P1",
    "CANARY_REPO_R1",
    "CANARY_HF_VAR_H1",
    "CANARY_MODEL_M1",
    "CANARY_QUESTION_TEXT_T1",
    "CANARY_WORKER_W1",
  ];
  const config: LoadoutConfig = {
    ...base,
    backend: "laya",
    laya: {
      ...base.laya,
      transport: "http",
      endpoint: "http://CANARY_ENDPOINT_E1.invalid/classify?token=CANARY_QUERY_Q1",
      apiKeyEnvVar: "CANARY_ENV_NAME_V1",
      pythonBin: "/CANARY_PYTHON_P1/bin/python",
      workerScript: "CANARY_WORKER_W1.py",
      repo: "CANARY_REPO_R1/laya",
      hfTokenEnvVar: "CANARY_HF_VAR_H1",
      timeoutMs: 4000,
    },
    jev: {
      ...base.jev,
      endpoint: "http://CANARY_ENDPOINT_E1.invalid/jev",
      apiKeyEnvVar: "CANARY_ENV_NAME_V1",
      model: "CANARY_MODEL_M1",
      timeoutMs: 2500,
    },
    tools: { ...base.tools, question: { ...base.tools.question, instructions: "CANARY_QUESTION_TEXT_T1" } },
    skills: { ...base.skills, enabled: true, mode: "auto" },
  };

  const laya = statusOf({ config });
  assert.ok(laya.includes("classifier: laya (http) | timeout 4000 ms"), laya);
  const jev = statusOf({ config: { ...config, backend: "jev" } });
  assert.ok(jev.includes("classifier: jev | timeout 2500 ms"), jev);
  const python = statusOf({ config: { ...config, laya: { ...config.laya, transport: "python" } } });
  assert.ok(python.includes("classifier: laya (python) | timeout 4000 ms"), python);
  for (const text of [laya, jev, python]) {
    for (const canary of canaries) assert.ok(!text.includes(canary), `${canary} leaked into:\n${text}`);
  }

  assert.equal(laya.split("\n")[0], "[loadout] status");
  assert.ok(
    laya
      .split("\n")
      .slice(1)
      .every((line) => line.startsWith("  ")),
    "one block: every other line is indented",
  );
  assert.ok(laya.includes("selection: enabled | dry run off | notices on"), laya);
  assert.ok(laya.includes("tools: profiles answer, edit, full (max risk 0.10) | skills: auto"), laya);
  const disabled = statusOf({
    config: {
      ...config,
      enabled: false,
      dryRun: true,
      notify: false,
      tools: { ...config.tools, enabled: false },
      skills: { ...config.skills, enabled: false },
    },
  });
  assert.ok(disabled.includes("selection: disabled | dry run on | notices off"), disabled);
  assert.ok(disabled.includes("tools: off | skills: off"), disabled);
  assert.ok(
    statusOf({ source: "/synthetic/loadout.json", scope: "explicit" }).includes(
      "config: /synthetic/loadout.json (explicit)",
    ),
  );
  assert.ok(statusOf().includes("config: built-in defaults\n"));
  assert.ok(statusOf({ baseline: BASE7 }).includes(`baseline tools: ${BASE7.join(", ")} (${BASE7.length})`));
  assert.ok(statusOf().includes("baseline tools: not captured yet"));
  assert.ok(statusOf().includes("last decision: none yet"));
  assert.ok(
    statusOf({ baseline: BASE7, lastRecord: row("applied") }).includes(
      `last decision: ${headline(row("applied"), BASELINE_SIZE)}`,
    ),
  );
});

test("status: collection state and provenance for every reason, and the machine override is explicit", () => {
  const on = statusOf({ collection: { handedOff: 4, suppressed: 0, failed: 2, lastFailure: "EACCES" } });
  assert.ok(on.includes("telemetry: on (default) | records handed to host 4 | failed 2 (EACCES)"), on);
  assert.ok(!on.includes("provenance:"), "an on state needs no provenance");
  assert.ok(statusOf().includes("records handed to host 0 | failed 0\n"));

  const provenance: Record<string, RegExp> = {
    "machine-off": /hard machine-wide override/,
    "machine-unreadable": /could not be read; nothing is recorded \(fail closed\)/,
    "config-error": /config has an error; nothing is recorded until it is fixed and the session restarts/,
    "config-off": /effective config \(project\) sets telemetry false/,
  };
  for (const [reason, expected] of Object.entries(provenance)) {
    const text = statusOf({
      telemetry: off(reason as TelemetryReason),
      scope: "project",
      collection: { handedOff: 0, suppressed: 3, failed: 0, lastFailure: null },
    });
    assert.ok(text.includes(`telemetry: off (${reason}) | records suppressed 3`), text);
    assert.match(lineOf(text, "provenance:"), expected);
    assert.ok(!text.includes("handed to host"), "off never claims a hand-over");
  }
  assert.ok(
    lineOf(statusOf({ telemetry: off("machine-off") }), "provenance:").includes(
      "no project, session or LOADOUT_CONFIG setting can turn it back on",
    ),
  );

  const noRecord = statusOf({ latest: observation(null, { stored: { outcome: "failed", code: "error" } }) });
  assert.ok(noRecord.includes("latest invocation: no record could be built (error)"), noRecord);
  const skipNewer = statusOf({ baseline: BASE7, lastRecord: row("applied"), latest: observation(row("skip-command")) });
  assert.ok(skipNewer.includes(`latest invocation: ${headline(row("skip-command"), BASELINE_SIZE)}`), skipNewer);
  assert.ok(skipNewer.includes("last decision: applied"), "the skip does not replace the last decision");
  const decidedLast = statusOf({ lastRecord: row("applied"), latest: observation(row("applied")) });
  assert.ok(!decidedLast.includes("latest invocation"), "shown only when it is a skip or has no record");
});

test("status: counters are records and coverage is session-local", () => {
  const text = statusOf({
    collection: { handedOff: 9, suppressed: 0, failed: 0, lastFailure: null },
    seen: { classified: 4, failed: 1, skipped: 2 },
    modelTurns: 6,
  });
  assert.ok(text.includes("records handed to host 9"), text);
  assert.ok(text.includes("prompts observed 7 (classified 4, failed 1, skipped 2)"), text);
  assert.ok(text.includes("model turns observed 6"), text);
  assert.ok(text.includes("memory only, this session in this process"), text);
  assert.ok(text.includes("not included: child and subagent sessions"), text);

  const quiet = statusOf({
    telemetry: off("config-off"),
    collection: { handedOff: 0, suppressed: 9, failed: 0, lastFailure: null },
    seen: { classified: 4, failed: 1, skipped: 2 },
  });
  assert.ok(quiet.includes("records suppressed 9") && quiet.includes("prompts observed 7"), quiet);
});

test("notice: only a classified turn whose application did not fail, one line, no tool list and no probabilities", () => {
  for (const [label, record] of ROWS) {
    const text = noticeText(record, BASELINE_SIZE);
    if (record.outcome !== "classified" || record.application.status === "failed") {
      assert.equal(text, null, `${label} gets no notice`);
      continue;
    }
    assert.ok(text !== null, label);
    assert.ok(!text.includes("\n") && text.length <= 150, `${label}: ${text.length} characters`);
    assert.doesNotMatch(text, /\b(grep|find|ls|write|bash)\b/, label);
    assert.doesNotMatch(text, /\w=\d|\bp \d/, `${label}: no probability list`);
    assert.equal(text, headline(record, BASELINE_SIZE), "the notice is the headline");
  }
  assert.equal(noticeText(row("applied")), headline(row("applied")));
  const long = decisionV3({ tools: tools({ profile: "p".repeat(300) }) });
  assert.ok(
    (noticeText(long, BASELINE_SIZE) ?? "").length <= 150,
    "a long profile id cannot break the one-line budget",
  );
});

test("no advice: no output of this module contains raise, lower, loosen, increase, should, recommend, saving, benefit or improve", () => {
  const texts: string[] = [];
  for (const [label, record] of ROWS) {
    texts.push(headline(record, BASELINE_SIZE), noticeText(record) ?? "");
    for (const stored of [
      HANDED,
      { outcome: "suppressed" } as PersistResult,
      { outcome: "failed", code: "EACCES" } as PersistResult,
    ]) {
      texts.push(
        explain(
          observation(record, { stored, message: label.startsWith("unavailable") ? "synthetic failure" : null }),
          { lastRecord: row("applied") },
        ),
      );
    }
  }
  for (const reason of ["machine-off", "machine-unreadable", "config-error", "config-off"] as const) {
    texts.push(
      statusOf({
        telemetry: off(reason),
        scope: "global",
        lastRecord: row("applied"),
        latest: observation(row("skip-off")),
      }),
    );
  }
  texts.push(statusOf({ latest: observation(null, { stored: { outcome: "failed", code: "error" } }) }), explain(null));
  const dir = tmp();
  const { file } = writeMixed(dir);
  const usage = writeUsageHistory(dir).file;
  const summary = buildSummary({
    scope: { kind: "session", files: [file, usage] },
    filters: NO_FILTERS,
    serviceLogs: [],
  });
  for (const telemetry of [ON, off("machine-off")]) {
    texts.push(
      statsText({
        summary,
        compare: true,
        telemetry,
        collection: { handedOff: 3, suppressed: 2, failed: 1, lastFailure: "EACCES" },
      }),
    );
  }
  assert.ok(texts.length > 50);
  for (const text of texts) assert.doesNotMatch(text, ADVICE, text);
});

test("stats: the collection state, the file comparison and the report lines in one block", () => {
  const dir = tmp();
  const { file } = writeMixed(dir);
  const usage = writeUsageHistory(dir).file;
  const summary = buildSummary({
    scope: { kind: "session", files: [file, usage] },
    filters: NO_FILTERS,
    serviceLogs: [],
  });
  const collection = { handedOff: 14, suppressed: 0, failed: 1, lastFailure: "EACCES" };

  const text = statsText({ summary, compare: true, telemetry: ON, collection });
  const lines = text.split("\n");
  assert.equal(lines[0], "[loadout] stats: session files");
  assert.ok(
    lines.slice(1).every((line) => line.startsWith("  ")),
    "one block: every other line is indented",
  );
  assert.equal(lines[1], "  telemetry: on (default) | this process handed 14 records to the host, failed 1 (EACCES)");
  assert.equal(
    lines[2],
    `  file: ${summary.decisions.total} decisions and ${summary.usage.turns} model-turn records were read here; this process handed 14 to the host (earlier history, or records the host has not written yet, explain a difference)`,
  );
  const report = renderSummary(summary)
    .split("\n")
    .map((line) => `  ${line}`);
  assert.deepEqual(lines.slice(3), report, "the report follows, each line indented two spaces");

  const filtered = statsText({ summary, compare: false, telemetry: ON, collection });
  assert.ok(!filtered.includes("  file:"), "no comparison once a filter or an explicit scope is in play");

  const optedOut = statsText({
    summary,
    compare: true,
    telemetry: off("machine-off"),
    collection: { handedOff: 0, suppressed: 2, failed: 0, lastFailure: null },
  });
  assert.equal(
    optedOut.split("\n")[1],
    "  telemetry: off (machine-off) | nothing from this process was stored (2 suppressed); the figures cover records already in the files read",
  );
  assert.ok(!optedOut.includes("  file:"), "no comparison while collection is off");

  const history = buildSummary({
    scope: {
      kind: "historical",
      since: Date.parse("2026-10-01T00:00:00Z"),
      until: Date.parse("2026-11-01T00:00:00Z"),
      projects: null,
      roots: [path.join(dir, "none")],
    },
    filters: NO_FILTERS,
    serviceLogs: [],
  });
  const empty = statsText({ summary: history, compare: false, telemetry: ON, collection });
  assert.equal(empty.split("\n")[0], "[loadout] stats: history");
  assert.ok(empty.includes("no session files matched this scope"), empty);
});

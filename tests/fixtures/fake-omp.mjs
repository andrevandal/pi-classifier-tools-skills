#!/usr/bin/env node
// Stand-in for `omp -p`: records one session the way omp does, with loadout.decision
// records built by the plugin's own record builder from LOADOUT_CONFIG, and edits the worktree.
import * as fs from "node:fs";
import * as path from "node:path";

import { defaultConfig } from "../../src/config.ts";
import { decideSkills, decideTools, profileOrder } from "../../src/select.ts";
import { buildDecisionRecord, newId, settingsSnapshot } from "../../src/telemetry.ts";

const config = JSON.parse(fs.readFileSync(process.env.LOADOUT_CONFIG, "utf8"));
const cwd = process.cwd();
if (fs.existsSync(path.join(cwd, "done.txt"))) {
  console.error("worktree was not reset between runs");
  process.exit(2);
}
fs.writeFileSync(path.join(cwd, "done.txt"), "ok\n");

const dir = path.join(process.env.FAKE_SESSIONS_DIR, `--${cwd.replace(/\//g, "-")}--`);
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${Date.now()}_${Math.random().toString(16).slice(2)}.jsonl`);
const input = config.dryRun ? 1000 : 600;

const full = { ...defaultConfig(), backend: config.backend ?? "laya", dryRun: config.dryRun === true };
const baseline = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const candidates = [{ name: "pdf", description: "read and write PDF files" }];
const answers = {
  tool_profile: {
    type: "choice",
    choice: "answer",
    probabilities: { answer: 0.95, edit: 0.03, full: 0.02 },
    confidence: 0.95,
  },
  "skill:pdf": { type: "noul", noul: 0.9, confidence: 0.8 },
};
const decision = {
  tools: decideTools(full.tools, baseline, answers.tool_profile),
  skills: decideSkills({ ...full.skills, enabled: true }, candidates, answers),
};
const common = {
  sessionId: "s",
  settings: settingsSnapshot(full, null),
  order: profileOrder(full.tools),
  maxRisk: full.tools.maxRisk,
};
const entry = (data) => ({ type: "custom", customType: "loadout.decision", timestamp: new Date().toISOString(), data });

const skip = buildDecisionRecord({
  ...common,
  eventId: newId(),
  decisionId: newId(),
  gate: "command",
  failure: null,
  classifier: null,
  decision: null,
  skills: null,
  ratchet: null,
  application: { status: "not-attempted", restoration: null, actualTools: null, error: null },
});
const classified = buildDecisionRecord({
  ...common,
  eventId: newId(),
  decisionId: newId(),
  gate: null,
  failure: null,
  classifier: {
    requestId: null,
    model: null,
    elapsedMs: 40,
    budgetMs: 3250,
    timeoutMs: 3000,
    guardFired: false,
    usage: null,
    server: null,
    status: null,
    promptChars: 20,
    sentChars: 20,
    questions: 2,
  },
  decision,
  skills: {
    discovered: 1,
    eligible: 1,
    maxCandidates: full.skills.maxCandidates,
    asked: 1,
    filteredOut: null,
    delivery: full.dryRun ? "dry-run" : "hint",
    decision: decision.skills,
  },
  ratchet: { narrowAllowed: true, before: null, after: "answer", admitted: true },
  application: {
    status: full.dryRun ? "dry-run" : "applied",
    restoration: null,
    actualTools: full.dryRun ? baseline : decision.tools.active,
    error: null,
  },
});

const entries = [
  { type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd },
  ...(config.telemetry === false ? [] : [entry(skip), entry(classified)]),
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }],
      usage: { input, output: 100, cacheRead: 400, cacheWrite: 0, cost: { total: input / 100000 } },
      stopReason: "toolUse",
    },
  },
  { type: "message", message: { role: "toolResult", toolCallId: "1", toolName: "read", content: [], isError: false } },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: { input: 50, output: 20, cacheRead: 900, cacheWrite: 0, cost: { total: 0.0005 } },
      stopReason: "stop",
    },
  },
];
fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
console.log("fake omp done\nANSWER: 42");

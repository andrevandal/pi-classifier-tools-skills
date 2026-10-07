#!/usr/bin/env node
// Stand-in for `omp -p`: records one session the way omp does, with a
// loadout.decision that reflects LOADOUT_CONFIG, and edits the worktree.
import * as fs from "node:fs";
import * as path from "node:path";

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
const entries = [
  { type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd },
  {
    type: "custom",
    customType: "loadout.decision",
    timestamp: new Date().toISOString(),
    data: {
      tools: { active: ["read", "grep"], profile: "answer", confidence: 0.8, reason: "selected" },
      skills: { selected: ["pdf"], scores: { pdf: 0.9 }, reason: "selected" },
      backend: "laya",
      dryRun: config.dryRun,
      latencyMs: 40,
    },
  },
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
console.log("fake omp done");

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { metricsFor } from "../scripts/lib/sessions.ts";
import { defaultConfig } from "../src/config.ts";
import { profileOrder } from "../src/select.ts";
import { buildDecisionRecord, newId, settingsSnapshot } from "../src/telemetry.ts";

function decisionEntry(data: Record<string, unknown>): string {
  return JSON.stringify({ type: "custom", customType: "loadout.decision", timestamp: "2026-10-11T00:00:00Z", data });
}

test("v2 and v3 records are normalized and unknown versions are counted as unsupported", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loadout-sessions-"));
  const file = path.join(dir, "session.jsonl");
  const config = defaultConfig();
  const v3 = buildDecisionRecord({
    eventId: newId(),
    decisionId: newId(),
    sessionId: "s",
    settings: settingsSnapshot(config, null),
    gate: "command",
    failure: null,
    classifier: null,
    decision: null,
    order: profileOrder(config.tools),
    maxRisk: config.tools.maxRisk,
    skills: null,
    ratchet: null,
    application: { status: "not-attempted", restoration: null, actualTools: null, error: null },
  });
  const entries = [
    decisionEntry({
      v: 2,
      failure: null,
      message: "CANARY",
      tools: { active: ["read"], profile: "answer", probabilities: {}, risk: 0, reason: "selected" },
      skills: null,
      applied: "answer",
      backend: "laya",
      dryRun: false,
      latencyMs: 9,
    }),
    decisionEntry({ ...v3 }),
    decisionEntry({ tools: { profile: "full" }, dryRun: false }),
    decisionEntry({ ...v3, v: 4 }),
    decisionEntry({ v: 2, tools: null }),
  ];
  fs.writeFileSync(file, `${entries.join("\n")}\n`);

  const metrics = metricsFor([file]);
  assert.equal(metrics.decisions.length, 2);
  assert.equal(metrics.unsupportedDecisions, 3);
  const [old, current] = metrics.decisions;
  assert.equal(old?.version, 2);
  assert.equal(old?.eventId, null);
  assert.equal(old?.outcome, "classified");
  assert.equal(old?.application, null);
  assert.equal(old?.ratchet?.after, "answer");
  assert.doesNotMatch(JSON.stringify(old), /CANARY/);
  assert.equal(current?.version, 3);
  assert.equal(current?.outcome, "skipped");
  assert.equal(current?.skip, "command");
});

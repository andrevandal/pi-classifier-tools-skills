import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { metricsFor } from "../scripts/lib/sessions.ts";

function decisionEntry(data: Record<string, unknown>): string {
  return JSON.stringify({ type: "custom", customType: "loadout.decision", timestamp: "2026-10-11T00:00:00Z", data });
}

test("transcripts from before record version 2 are skipped, not reported as failures", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loadout-sessions-"));
  const file = path.join(dir, "session.jsonl");
  const old = decisionEntry({ tools: { profile: "full" }, dryRun: false });
  const current = decisionEntry({ v: 2, failure: null, tools: { profile: "answer", risk: 0 }, dryRun: false });
  fs.writeFileSync(file, `${old}\n${current}\n`);

  const metrics = metricsFor([file]);
  assert.equal(metrics.decisions.length, 1);
  assert.equal(metrics.decisions[0]?.failure, null);
});

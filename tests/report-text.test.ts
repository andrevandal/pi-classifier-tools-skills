/**
 * The text renderer behind `scripts/decisions.ts` and `/loadout stats`: pure functions over a `Summary`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSummary } from "../src/report/report.ts";
import { NO_FILTERS } from "../src/report/scope.ts";
import { renderDecisions } from "../src/report/text.ts";
import { tmp, writeMixed } from "./fixtures/report.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("decisions script prints exactly renderDecisions", () => {
  const { file } = writeMixed(tmp());
  const summary = buildSummary({ scope: { kind: "session", files: [file] }, filters: NO_FILTERS, serviceLogs: [] });

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

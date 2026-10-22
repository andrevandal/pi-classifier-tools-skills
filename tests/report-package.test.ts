import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { tmp, writeMixed } from "./fixtures/report.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("package: the packed files run the CLI without the rest of the checkout", () => {
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const [manifest] = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
  const listed = (manifest?.files ?? []).map((file) => file.path);

  const bin = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).bin["loadout-report"];
  for (const name of ["cli", "read", "scope", "summary", "export", "report"]) {
    assert.ok(listed.includes(`src/report/${name}.ts`), `src/report/${name}.ts is packed`);
  }
  for (const required of ["src/telemetry.ts", "src/select.ts", bin]) assert.ok(listed.includes(required), required);
  assert.deepEqual(
    listed.filter((file) => /^(tests|scripts|docs)\//.test(file)),
    [],
  );

  // Only what npm would ship: a dependency on anything else in the checkout fails here.
  const out = tmp("loadout-report-pack-");
  for (const file of listed) {
    fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(out, file));
  }
  const { file } = writeMixed(tmp());
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [path.join(out, bin), "summary", "--session", file], {
    cwd: out,
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decisions.total, 10);
});

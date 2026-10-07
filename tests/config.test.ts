import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { defaultConfig, loadConfig, parseConfig } from "../src/config.ts";

function tempDirs(): { home: string; project: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loadout-config-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(home, ".omp"), { recursive: true });
  fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
  return { home, project };
}

function write(dir: string, name: string, value: unknown): void {
  fs.writeFileSync(path.join(dir, ".omp", name), typeof value === "string" ? value : JSON.stringify(value));
}

test("no file means the defaults", () => {
  const { home, project } = tempDirs();
  const result = loadConfig(project, { projectTrusted: true, home });
  assert.equal(result.source, null);
  assert.deepEqual(result.config, defaultConfig());
});

test("Laya's local sidecar is the default backend", () => {
  assert.equal(defaultConfig().backend, "laya");
  assert.equal(defaultConfig().laya.transport, "python");
});

test("sections merge over the defaults", () => {
  const { config, errors } = parseConfig({ backend: "jev", skills: { maxSkills: 2 }, dryRun: true });
  assert.deepEqual(errors, []);
  assert.equal(config.backend, "jev");
  assert.equal(config.skills.maxSkills, 2);
  assert.equal(config.skills.threshold, defaultConfig().skills.threshold);
  assert.equal(config.dryRun, true);
});

test("a trusted project file wins over the global one; an untrusted one is skipped", () => {
  const { home, project } = tempDirs();
  write(home, "loadout.json", { dryRun: true });
  write(project, "loadout.json", { notify: false });

  const trusted = loadConfig(project, { projectTrusted: true, home });
  assert.equal(trusted.config.notify, false);
  assert.equal(trusted.config.dryRun, false);

  const untrusted = loadConfig(project, { projectTrusted: false, home });
  assert.equal(untrusted.config.dryRun, true);
  assert.match(untrusted.warnings.join("\n"), /not trusted/);
});

test("YAML needs a parser and reports clearly without one", () => {
  const { home, project } = tempDirs();
  write(home, "loadout.yml", "dryRun: true\n");
  const withParser = loadConfig(project, { projectTrusted: true, home, parseYaml: () => ({ dryRun: true }) });
  assert.equal(withParser.config.dryRun, true);
  const without = loadConfig(project, { projectTrusted: true, home, parseYaml: null });
  assert.match(without.errors.join("\n"), /YAML needs Bun/);
});

test("bad values reject the file and fall back to the defaults", () => {
  const cases: unknown[] = [
    { backend: "gpt" },
    { skills: { threshold: 2 } },
    { tools: { confidenceThreshold: "high" } },
    { tools: { profiles: { answer: ["read"], edit: ["edit"] } } },
    { tools: { profiles: { answer: ["read"], edit: "all", full: "*" } } },
    { maxPromptChars: 10 },
    { backend: "laya", laya: { transport: "http", endpoint: "" } },
    [],
  ];
  for (const raw of cases) {
    const { config, errors } = parseConfig(raw);
    assert.ok(errors.length > 0, `expected errors for ${JSON.stringify(raw)}`);
    assert.deepEqual(config, defaultConfig());
  }
});

test("custom profiles must cover every option of the question", () => {
  const { errors } = parseConfig({
    tools: {
      question: { type: "choice", instructions: "?", criteria: { quick: null, deep: null } },
      profiles: { quick: ["read"], deep: "*" },
    },
  });
  assert.deepEqual(errors, []);
});

test("unknown keys warn, $ keys are annotations", () => {
  const { errors, warnings } = parseConfig({ $comment: "x", skils: {}, tools: { treshold: 1 } });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, ['unknown key "skils" (ignored)', 'unknown key "tools.treshold" (ignored)']);
});

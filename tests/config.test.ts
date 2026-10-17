import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { defaultConfig, loadConfig, parseConfig, readMachineTelemetry } from "../src/config.ts";

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
    { tools: { maxRisk: "high" } },
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

test("an explicit path replaces the search, and a missing one is an error", () => {
  const { home, project } = tempDirs();
  write(home, "loadout.json", { dryRun: true });
  const explicit = path.join(project, "arm.json");
  fs.writeFileSync(explicit, JSON.stringify({ notify: false }));

  const found = loadConfig(project, { projectTrusted: true, home, explicitPath: explicit });
  assert.equal(found.source, explicit);
  assert.equal(found.config.notify, false);
  assert.equal(found.config.dryRun, false);

  const missing = loadConfig(project, { projectTrusted: true, home, explicitPath: path.join(project, "nope.json") });
  assert.equal(missing.source, null);
  assert.match(missing.errors.join("\n"), /LOADOUT_CONFIG/);
  assert.equal(missing.config.enabled, false);
});

test("a file with errors disables the plugin instead of running on defaults", () => {
  const { home, project } = tempDirs();
  write(home, "loadout.json", { jev: { timeoutMs: 30000 } });
  const result = loadConfig(project, { projectTrusted: true, home });
  assert.equal(result.config.enabled, false);
  assert.match(result.errors.join("\n"), /"jev\.timeoutMs" must be between 1 and 20000/);
});

test("tools.profiles must nest: each profile's tools fit inside the next", () => {
  const { errors } = parseConfig({
    tools: {
      question: { type: "choice", instructions: "?", criteria: { answer: null, edit: null, full: null } },
      profiles: { answer: ["read"], edit: ["edit"], full: "*" },
    },
  });
  assert.match(errors.join("\n"), /"tools\.profiles" must be nested/);
});

test("the shipped example loadout parses without errors", () => {
  const raw: unknown = JSON.parse(fs.readFileSync(new URL("../examples/loadout.json", import.meta.url), "utf8"));
  assert.deepEqual(parseConfig(raw).errors, []);
});

test("no file means telemetry on by default", () => {
  const { home, project } = tempDirs();
  const result = loadConfig(project, { projectTrusted: true, home });
  assert.deepEqual(result.telemetry, { persist: true, reason: "default" });
  assert.equal(result.config.telemetry, true);
  assert.equal(result.scope, null);
});

test("the machine telemetry setting is a ceiling that nothing else lifts", () => {
  const yml = (text: string) => text;
  const cases: Array<{ name: string; setup: (d: { home: string; project: string }) => object; reason: string }> = [
    {
      name: "trusted project cannot lift it",
      setup: ({ home, project }) => {
        write(home, "loadout.json", { telemetry: false });
        write(project, "loadout.json", { telemetry: true });
        return { projectTrusted: true };
      },
      reason: "machine-off",
    },
    {
      name: "explicit file cannot lift it",
      setup: ({ home, project }) => {
        write(home, "loadout.json", { telemetry: false });
        write(project, "explicit.json", { telemetry: true });
        return { projectTrusted: true, explicitPath: path.join(project, ".omp", "explicit.json") };
      },
      reason: "machine-off",
    },
    {
      name: "project can turn it off",
      setup: ({ home, project }) => {
        write(home, "loadout.json", { telemetry: true });
        write(project, "loadout.json", { telemetry: false });
        return { projectTrusted: true };
      },
      reason: "config-off",
    },
    {
      name: "explicit file can turn it off",
      setup: ({ project }) => {
        write(project, "explicit.json", { telemetry: false });
        return { projectTrusted: true, explicitPath: path.join(project, ".omp", "explicit.json") };
      },
      reason: "config-off",
    },
    {
      name: "machine off outranks a config error",
      setup: ({ home, project }) => {
        write(home, "loadout.json", { telemetry: false });
        write(project, "loadout.json", { dryRun: "x" });
        return { projectTrusted: true };
      },
      reason: "machine-off",
    },
    {
      name: "a config error fails closed",
      setup: ({ project }) => {
        write(project, "loadout.json", { dryRun: "x" });
        return { projectTrusted: true };
      },
      reason: "config-error",
    },
    {
      name: "non-boolean machine value",
      setup: ({ home }) => {
        write(home, "loadout.json", { telemetry: "no" });
        return { projectTrusted: true };
      },
      reason: "machine-unreadable",
    },
    {
      name: "malformed machine file",
      setup: ({ home }) => {
        write(home, "loadout.json", "{ not json");
        return { projectTrusted: true };
      },
      reason: "machine-unreadable",
    },
    {
      name: "non-object machine file",
      setup: ({ home }) => {
        write(home, "loadout.json", "[]");
        return { projectTrusted: true };
      },
      reason: "machine-unreadable",
    },
    {
      name: "machine YAML without a parser",
      setup: ({ home }) => {
        write(home, "loadout.yml", yml("telemetry: false\n"));
        return { projectTrusted: true, parseYaml: null };
      },
      reason: "machine-unreadable",
    },
    {
      name: "machine YAML with a parser",
      setup: ({ home }) => {
        write(home, "loadout.yml", yml("telemetry: false\n"));
        return { projectTrusted: true, parseYaml: () => ({ telemetry: false }) };
      },
      reason: "machine-off",
    },
  ];
  for (const { name, setup, reason } of cases) {
    const dirs = tempDirs();
    const options = setup(dirs);
    const result = loadConfig(dirs.project, { ...options, projectTrusted: true, home: dirs.home });
    assert.deepEqual(result.telemetry, { persist: false, reason }, name);
  }
});

test("readMachineTelemetry reads only the first existing machine file", () => {
  const { home } = tempDirs();
  assert.equal(readMachineTelemetry(home, null), "absent");
  write(home, "loadout.json", { telemetry: true });
  assert.equal(readMachineTelemetry(home, null), "on");
  write(home, "loadout.json", { telemetry: false });
  assert.equal(readMachineTelemetry(home, null), "off");
  write(home, "loadout.json", { notify: false });
  write(home, "loadout.yml", "telemetry: false\n");
  assert.equal(
    readMachineTelemetry(home, () => ({ telemetry: false })),
    "absent",
  );

  const other = tempDirs();
  fs.mkdirSync(path.join(other.home, ".omp", "loadout.json"));
  assert.equal(readMachineTelemetry(other.home, null), "unreadable");
});

test("scope names the kind of file the config came from", () => {
  const { home, project } = tempDirs();
  assert.equal(loadConfig(project, { projectTrusted: true, home }).scope, null);
  write(home, "loadout.json", { notify: false });
  assert.equal(loadConfig(project, { projectTrusted: true, home }).scope, "global");
  write(project, "loadout.json", { notify: false });
  assert.equal(loadConfig(project, { projectTrusted: true, home }).scope, "project");
  const explicitPath = path.join(project, ".omp", "loadout.json");
  assert.equal(loadConfig(project, { projectTrusted: true, home, explicitPath }).scope, "explicit");
});

test("a non-boolean telemetry value rejects the file", () => {
  assert.match(parseConfig({ telemetry: "no" }).errors.join("\n"), /telemetry/);
});

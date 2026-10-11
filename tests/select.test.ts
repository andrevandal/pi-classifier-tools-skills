import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultConfig } from "../src/config.ts";
import {
  buildQuestions,
  clipPrompt,
  decideSkills,
  decideTools,
  isSlashCommand,
  profileOrder,
  skillCandidates,
  skillQuestionId,
  TOOLS_QUESTION_ID,
} from "../src/select.ts";
import type { Answers, ChoiceAnswer, SkillCandidate } from "../src/types.ts";

const BASELINE = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const SKILLS: SkillCandidate[] = [
  { name: "pdf", description: "read and write PDF files" },
  { name: "deploy", description: "deploy the app" },
  { name: "review", description: "review a diff" },
];

function choice(value: string, probabilities: Record<string, number>): ChoiceAnswer {
  return { type: "choice", choice: value, probabilities, confidence: probabilities[value] ?? 0 };
}

function nouls(scores: Record<string, number>): Answers {
  const answers: Answers = {};
  for (const [name, noul] of Object.entries(scores)) {
    answers[skillQuestionId(name)] = { type: "noul", noul, confidence: Math.abs(noul - 0.5) * 2 };
  }
  return answers;
}

test("the narrowest profile within maxRisk is chosen, and its risk is the mass on broader profiles", () => {
  const decision = decideTools(
    defaultConfig().tools,
    BASELINE,
    choice("answer", { answer: 0.95, edit: 0.03, full: 0.02 }),
  );
  assert.equal(decision.profile, "answer");
  assert.deepEqual(decision.active, ["read", "grep", "find", "ls"]);
  assert.ok(Math.abs((decision.risk ?? Number.NaN) - 0.05) < 1e-9);
});

test("a small margin between two narrow profiles does not block narrowing", () => {
  const decision = decideTools(
    defaultConfig().tools,
    BASELINE,
    choice("answer", { answer: 0.5, edit: 0.45, full: 0.05 }),
  );
  assert.equal(decision.profile, "edit");
  assert.ok(Math.abs((decision.risk ?? Number.NaN) - 0.05) < 1e-9);
});

test("mass above maxRisk on broader profiles keeps the baseline", () => {
  const decision = decideTools(
    defaultConfig().tools,
    BASELINE,
    choice("answer", { answer: 0.42, edit: 0.31, full: 0.27 }),
  );
  assert.equal(decision.reason, "low-confidence");
  assert.equal(decision.active, null);
});

test("a profile never grants a tool missing from the baseline", () => {
  const decision = decideTools(defaultConfig().tools, ["read", "bash"], choice("edit", { answer: 0.1, edit: 0.9 }));
  assert.deepEqual(decision.active, ["read"]);
});

test("the broadest profile is the baseline, and alwaysOn adds to a narrower one", () => {
  const config = defaultConfig().tools;
  assert.equal(decideTools(config, BASELINE, choice("full", { full: 1 })).active, null);
  config.alwaysOn = ["bash"];
  const decision = decideTools(config, BASELINE, choice("answer", { answer: 0.95, edit: 0.05 }));
  assert.deepEqual(decision.active, ["read", "bash", "grep", "find", "ls"]);
});

test("a missing answer, or one with no probabilities, keeps the baseline", () => {
  const config = defaultConfig().tools;
  assert.equal(decideTools(config, BASELINE, undefined).reason, "missing-answer");
  assert.equal(decideTools(config, BASELINE, choice("answer", {})).active, null);
});

test("profiles are ordered narrowest first, with the wildcard last", () => {
  assert.deepEqual(profileOrder(defaultConfig().tools), ["answer", "edit", "full"]);
});

test("skills above the threshold are selected, highest first, capped at maxSkills", () => {
  const config = { ...defaultConfig().skills, enabled: true, maxSkills: 1 };
  const decision = decideSkills(config, SKILLS, nouls({ pdf: 0.7, deploy: 0.9, review: 0.2 }));
  assert.deepEqual(decision.selected, ["deploy"]);
  assert.equal(decision.reason, "selected");
});

test("alwaysInclude is selected without being asked, and no relevant skill selects none", () => {
  const config = { ...defaultConfig().skills, enabled: true, alwaysInclude: ["review"] };
  const candidates = skillCandidates(SKILLS, config);
  assert.deepEqual(
    candidates.map((s) => s.name),
    ["pdf", "deploy"],
  );
  assert.deepEqual(decideSkills(config, candidates, nouls({ pdf: 0.1, deploy: 0.1 })).selected, ["review"]);
});

test("skill selection keeps every skill when it cannot decide", () => {
  const config = { ...defaultConfig().skills, enabled: true };
  assert.equal(decideSkills(config, [], {}).reason, "no-candidates");
  assert.equal(decideSkills(config, SKILLS, {}).reason, "missing-answer");
  assert.equal(decideSkills({ ...config, maxCandidates: 2 }, SKILLS, {}).reason, "too-many-candidates");
  assert.equal(decideSkills({ ...config, enabled: false }, SKILLS, {}).selected, null);
});

test("questions hold the tool question plus one noul per candidate skill", () => {
  const config = { ...defaultConfig(), skills: { ...defaultConfig().skills, enabled: true } };
  const questions = buildQuestions(config, SKILLS);
  assert.deepEqual(Object.keys(questions), [TOOLS_QUESTION_ID, "skill:pdf", "skill:deploy", "skill:review"]);
  assert.equal(questions["skill:pdf"]?.type, "noul");

  config.skills.maxCandidates = 2;
  config.tools.enabled = false;
  assert.deepEqual(buildQuestions(config, SKILLS), {});
});

test("clipPrompt keeps both ends of a long prompt within the limit", () => {
  const prompt = `HEAD${"x".repeat(1000)}TAIL`;
  const clipped = clipPrompt(prompt, 300);
  assert.ok(clipped.length <= 300);
  assert.ok(clipped.startsWith("HEAD") && clipped.endsWith("TAIL"));
  assert.match(clipped, /characters omitted/);
  assert.equal(clipPrompt("short", 300), "short");
  assert.equal(clipPrompt(prompt, null), prompt);
});

test("slash commands are recognized, paths are not", () => {
  assert.ok(isSlashCommand("/loadout status"));
  assert.ok(isSlashCommand("  /review"));
  assert.ok(!isSlashCommand("/home/me/app.ts is failing"));
  assert.ok(!isSlashCommand("fix the build"));
});

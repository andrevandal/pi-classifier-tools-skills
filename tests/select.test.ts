import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultConfig } from "../src/config.ts";
import {
  buildQuestions,
  clipPrompt,
  decideSkills,
  decideTools,
  isSlashCommand,
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

function choice(value: string, confidence: number): ChoiceAnswer {
  return { type: "choice", choice: value, probabilities: { [value]: confidence }, confidence };
}

function nouls(scores: Record<string, number>): Answers {
  const answers: Answers = {};
  for (const [name, noul] of Object.entries(scores)) {
    answers[skillQuestionId(name)] = { type: "noul", noul, confidence: Math.abs(noul - 0.5) * 2 };
  }
  return answers;
}

test("a profile narrows tools to its intersection with the baseline", () => {
  const decision = decideTools(defaultConfig().tools, BASELINE, choice("answer", 0.9));
  assert.deepEqual(decision.active, ["read", "grep", "find", "ls"]);
  assert.equal(decision.reason, "selected");
});

test("a profile never grants a tool missing from the baseline", () => {
  const decision = decideTools(defaultConfig().tools, ["read", "bash"], choice("edit", 0.9));
  assert.deepEqual(decision.active, ["read"]);
});

test('"*" keeps the whole baseline and alwaysOn adds to a profile', () => {
  const config = defaultConfig().tools;
  assert.deepEqual(decideTools(config, BASELINE, choice("full", 0.9)).active, BASELINE);
  config.alwaysOn = ["bash"];
  assert.deepEqual(decideTools(config, BASELINE, choice("answer", 0.9)).active, ["read", "bash", "grep", "find", "ls"]);
});

test("low confidence, unknown profiles and missing answers keep the baseline", () => {
  const config = defaultConfig().tools;
  assert.equal(decideTools(config, BASELINE, choice("answer", 0.3)).reason, "low-confidence");
  assert.equal(decideTools(config, BASELINE, choice("nope", 0.9)).reason, "unknown-profile");
  assert.equal(decideTools(config, BASELINE, undefined).reason, "missing-answer");
  for (const answer of [choice("answer", 0.3), choice("nope", 0.9), undefined]) {
    assert.equal(decideTools(config, BASELINE, answer).active, null);
  }
});

test("skills above the threshold are selected, highest first, capped at maxSkills", () => {
  const config = { ...defaultConfig().skills, maxSkills: 1 };
  const decision = decideSkills(config, SKILLS, nouls({ pdf: 0.7, deploy: 0.9, review: 0.2 }));
  assert.deepEqual(decision.selected, ["deploy"]);
  assert.equal(decision.reason, "selected");
});

test("alwaysInclude is selected without being asked, and no relevant skill selects none", () => {
  const config = { ...defaultConfig().skills, alwaysInclude: ["review"] };
  const candidates = skillCandidates(SKILLS, config);
  assert.deepEqual(
    candidates.map((s) => s.name),
    ["pdf", "deploy"],
  );
  assert.deepEqual(decideSkills(config, candidates, nouls({ pdf: 0.1, deploy: 0.1 })).selected, ["review"]);
});

test("skill selection keeps every skill when it cannot decide", () => {
  const config = defaultConfig().skills;
  assert.equal(decideSkills(config, [], {}).reason, "no-candidates");
  assert.equal(decideSkills(config, SKILLS, {}).reason, "missing-answer");
  assert.equal(decideSkills({ ...config, maxCandidates: 2 }, SKILLS, {}).reason, "too-many-candidates");
  assert.equal(decideSkills({ ...config, enabled: false }, SKILLS, {}).selected, null);
});

test("questions hold the tool question plus one noul per candidate skill", () => {
  const config = defaultConfig();
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

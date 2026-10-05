/**
 * Pure selection logic: build the typed questions for a turn and turn the
 * classifier's answers into a loadout. No I/O and no host access, so every
 * rule here is unit-testable on its own.
 *
 * Every "don't know" path returns `null` (keep the baseline), never an empty
 * set: a wrong narrowing costs the model a capability, while a missed narrowing
 * only costs some context.
 */

import type {
  Answer,
  Answers,
  LoadoutConfig,
  NoulQuestion,
  Questions,
  SkillCandidate,
  SkillsDecision,
  SkillsSelectorConfig,
  ToolsDecision,
  ToolsSelectorConfig,
} from "./types.ts";

export const TOOLS_QUESTION_ID = "tool_profile";
const SKILL_QUESTION_PREFIX = "skill:";

export function skillQuestionId(name: string): string {
  return `${SKILL_QUESTION_PREFIX}${name}`;
}

/** Skills worth asking about: not excluded and not already always included. */
export function skillCandidates(all: SkillCandidate[], config: SkillsSelectorConfig): SkillCandidate[] {
  const skip = new Set([...config.exclude, ...config.alwaysInclude]);
  return all.filter((skill) => !skip.has(skill.name));
}

function skillQuestion(skill: SkillCandidate): NoulQuestion {
  return {
    type: "noul",
    instructions: `Would an AI coding agent handling this request benefit from loading the skill "${skill.name}"? Skill description: ${skill.description || "(none)"}`,
    criteria: {
      true: "the request falls within what the skill covers",
      false: "the skill is unrelated to the request",
    },
  };
}

/** Whether skill selection runs this turn, given the candidate count. */
export function skillsAskable(config: SkillsSelectorConfig, candidates: SkillCandidate[]): boolean {
  return config.enabled && candidates.length > 0 && candidates.length <= config.maxCandidates;
}

export function buildQuestions(config: LoadoutConfig, candidates: SkillCandidate[]): Questions {
  const questions: Questions = {};
  if (config.tools.enabled) questions[TOOLS_QUESTION_ID] = config.tools.question;
  if (skillsAskable(config.skills, candidates)) {
    for (const skill of candidates) questions[skillQuestionId(skill.name)] = skillQuestion(skill);
  }
  return questions;
}

/**
 * Map the tool-profile answer to the tools to activate. The result is always a
 * subset of `baseline`, so the selector can narrow the session's tools but
 * never grant one the user did not enable.
 */
export function decideTools(
  config: ToolsSelectorConfig,
  baseline: string[],
  answer: Answer | undefined,
): ToolsDecision {
  if (!config.enabled) return { active: null, profile: null, confidence: 0, reason: "disabled" };
  if (answer?.type !== "choice") return { active: null, profile: null, confidence: 0, reason: "missing-answer" };

  const { choice: profile, confidence } = answer;
  if (confidence < config.confidenceThreshold) return { active: null, profile, confidence, reason: "low-confidence" };

  const tools = config.profiles[profile];
  if (tools === undefined) return { active: null, profile, confidence, reason: "unknown-profile" };
  if (tools === "*") return { active: [...baseline], profile, confidence, reason: "selected" };

  const wanted = new Set([...tools, ...config.alwaysOn]);
  return { active: baseline.filter((name) => wanted.has(name)), profile, confidence, reason: "selected" };
}

export function decideSkills(
  config: SkillsSelectorConfig,
  candidates: SkillCandidate[],
  answers: Answers,
): SkillsDecision {
  if (!config.enabled) return { selected: null, scores: {}, reason: "disabled" };
  if (candidates.length === 0) return { selected: null, scores: {}, reason: "no-candidates" };
  if (candidates.length > config.maxCandidates) return { selected: null, scores: {}, reason: "too-many-candidates" };

  const scores: Record<string, number> = {};
  for (const skill of candidates) {
    const answer = answers[skillQuestionId(skill.name)];
    if (answer?.type === "noul") scores[skill.name] = answer.noul;
  }
  if (Object.keys(scores).length === 0) return { selected: null, scores, reason: "missing-answer" };

  const relevant = Object.entries(scores)
    .filter(([, score]) => score >= config.threshold)
    .sort(([, a], [, b]) => b - a)
    .slice(0, config.maxSkills)
    .map(([name]) => name);
  return { selected: [...new Set([...config.alwaysInclude, ...relevant])], scores, reason: "selected" };
}

/**
 * Keep the start and end of a long prompt, where the actual request usually
 * is, around an omission marker.
 */
export function clipPrompt(prompt: string, maxChars: number | null): string {
  if (maxChars === null || prompt.length <= maxChars) return prompt;
  const omitted = prompt.length - maxChars;
  const marker = `\n[... ${omitted} characters omitted ...]\n`;
  const half = Math.floor((maxChars - marker.length) / 2);
  return `${prompt.slice(0, half)}${marker}${prompt.slice(prompt.length - half)}`;
}

/** Slash commands are host commands, not requests for the model. */
export function isSlashCommand(prompt: string): boolean {
  return /^\/[^\s/]+(\s|$)/.test(prompt.trimStart());
}

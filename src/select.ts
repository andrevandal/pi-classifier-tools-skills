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
 * Profile ids from narrowest to broadest. Each profile's tools (with `alwaysOn`)
 * must fit inside the next one's, so "narrower" is well defined; the wildcard
 * `"*"` is the broadest and always comes last.
 */
export function profileOrder(tools: ToolsSelectorConfig): string[] {
  const wildcards = Object.keys(tools.profiles).filter((id) => tools.profiles[id] === "*");
  if (wildcards.length > 1) throw new Error(`"tools.profiles" may have only one "*" profile`);
  const sets = Object.entries(tools.profiles).flatMap(([id, list]) =>
    list === "*" ? [] : [{ id, names: new Set([...list, ...tools.alwaysOn]) }],
  );
  sets.sort((a, b) => a.names.size - b.names.size);
  for (let i = 0; i + 1 < sets.length; i++) {
    const narrower = sets[i]!;
    const broader = sets[i + 1]!;
    if (![...narrower.names].every((name) => broader.names.has(name))) {
      throw new Error(`"tools.profiles" must be nested: "${narrower.id}" is not a subset of "${broader.id}"`);
    }
  }
  return [...sets.map(({ id }) => id), ...wildcards];
}

/**
 * The risk of every profile narrower than the broadest: the probability mass on
 * the profiles broader than it. Null when the answer reports no probability for
 * any profile: that would read as zero risk everywhere and pick the narrowest.
 */
export function profileRisks(
  order: string[],
  probabilities: Record<string, number>,
): Array<{ profile: string; risk: number }> | null {
  if (!order.some((id) => id in probabilities)) return null;
  return order.slice(0, -1).map((profile, i) => ({
    profile,
    risk: order.slice(i + 1).reduce((sum, id) => sum + (probabilities[id] ?? 0), 0),
  }));
}

/**
 * The narrowest profile whose risk is within `maxRisk`, where a profile's risk is
 * the probability mass on the profiles broader than it. The broadest profile is
 * never picked: it stands for the baseline. Null when no profile qualifies.
 */
export function pickProfile(
  order: string[],
  probabilities: Record<string, number>,
  maxRisk: number,
): { profile: string; risk: number } | null {
  return profileRisks(order, probabilities)?.find((entry) => entry.risk <= maxRisk) ?? null;
}

/**
 * Map the classifier's probabilities over profiles to the tools to activate: the
 * narrowest profile whose risk is within `maxRisk`, else the baseline. The result
 * is always a subset of `baseline`, so the selector can narrow the session's tools
 * but never grant one the user did not enable.
 */
export function decideTools(
  config: ToolsSelectorConfig,
  baseline: string[],
  answer: Answer | undefined,
): ToolsDecision {
  if (!config.enabled) return { active: null, profile: null, probabilities: {}, risk: null, reason: "disabled" };
  if (answer?.type !== "choice") {
    return { active: null, profile: null, probabilities: {}, risk: null, reason: "missing-answer" };
  }

  const probabilities = answer.probabilities ?? {};
  const order = profileOrder(config);
  const picked = pickProfile(order, probabilities, config.maxRisk);
  if (picked === null) {
    return { active: null, profile: order.at(-1) ?? null, probabilities, risk: null, reason: "low-confidence" };
  }

  const { profile, risk } = picked;
  const tools = config.profiles[profile]!;
  if (tools === "*") return { active: [...baseline], profile, probabilities, risk, reason: "selected" };

  const wanted = new Set([...tools, ...config.alwaysOn]);
  return { active: baseline.filter((name) => wanted.has(name)), profile, probabilities, risk, reason: "selected" };
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

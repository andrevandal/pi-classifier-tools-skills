/**
 * Cheap lexical ranking of skills against a prompt (TF-IDF over name and description). It picks which skills are
 * worth a classifier question: the classifier cannot rank a large catalog, and `maxCandidates` caps what it is asked.
 */

import type { SkillCandidate } from "./types.ts";

const STOP: Record<string, true> = {
  the: true,
  and: true,
  for: true,
  use: true,
  when: true,
  with: true,
  this: true,
  that: true,
  not: true,
  are: true,
  any: true,
  from: true,
  avoid: true,
};

function tokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2 && STOP[word] === undefined);
}

/** The skills ordered best first, with their score. Ties keep catalog order. */
export function rankSkills(prompt: string, skills: SkillCandidate[]): Array<{ skill: SkillCandidate; score: number }> {
  const docs = skills.map((skill) => tokens(`${skill.name} ${skill.name} ${skill.description}`));
  const df = new Map<string, number>();
  for (const doc of docs) for (const word of new Set(doc)) df.set(word, (df.get(word) ?? 0) + 1);
  const wanted = new Set(tokens(prompt));
  return skills
    .map((skill, i) => {
      const doc = docs[i]!;
      const hit = doc
        .filter((word) => wanted.has(word))
        .reduce((sum, word) => sum + Math.log(1 + skills.length / (df.get(word) ?? 0.5)), 0);
      return { skill, score: doc.length === 0 ? 0 : hit / Math.sqrt(doc.length) };
    })
    .sort((a, b) => b.score - a.score);
}

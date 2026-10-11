/**
 * One turn of selection: classify the prompt, decide tools and skills, and
 * describe the outcome as a `TurnRecord`. Never throws; a failure is a record.
 */

import { clipPrompt, decideSkills, decideTools, TOOLS_QUESTION_ID } from "./select.ts";
import { ClassifierError } from "./types.ts";
import type {
  Classifier,
  FailureReason,
  LoadoutConfig,
  LoadoutDecision,
  Questions,
  SkillCandidate,
  TurnRecord,
} from "./types.ts";

/** Extra time past the backend's own budget before the outer guard gives up. */
const GUARD_MS = 250;

export interface TurnInput {
  config: LoadoutConfig;
  classifier: Classifier;
  prompt: string;
  questions: Questions;
  baseline: string[];
  candidates: SkillCandidate[];
}

export interface TurnOutcome {
  record: TurnRecord;
  /** Null when the turn failed; the caller keeps the baseline. */
  decision: LoadoutDecision | null;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function classify(input: TurnInput) {
  const { config, classifier, prompt, questions } = input;
  const budget = (config.backend === "laya" ? config.laya.timeoutMs : config.jev.timeoutMs) + GUARD_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ClassifierError(config.backend, "timeout", `no answer within ${budget}ms`));
    }, budget);
  });
  try {
    const call = classifier.classify(clipPrompt(prompt, config.maxPromptChars), questions, {
      signal: controller.signal,
    });
    return await Promise.race([call, guard]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runTurn(input: TurnInput): Promise<TurnOutcome> {
  const { config, baseline, candidates } = input;
  const startedAt = Date.now();
  const common = { v: 2, applied: null, backend: config.backend, dryRun: config.dryRun } as const;

  try {
    const result = await classify(input);
    const decision: LoadoutDecision = {
      tools: decideTools(config.tools, baseline, result.answers[TOOLS_QUESTION_ID]),
      skills: decideSkills(config.skills, candidates, result.answers),
    };
    const record: TurnRecord = {
      ...common,
      failure: null,
      message: null,
      ...decision,
      latencyMs: Date.now() - startedAt,
    };
    return { record, decision };
  } catch (error) {
    const failure: FailureReason = error instanceof ClassifierError ? error.code : "error";
    const record: TurnRecord = {
      ...common,
      failure,
      message: errorText(error),
      tools: null,
      skills: null,
      latencyMs: Date.now() - startedAt,
    };
    return { record, decision: null };
  }
}

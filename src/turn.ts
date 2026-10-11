/**
 * One turn of selection: classify the prompt, decide tools and skills, and
 * describe the outcome as a `TurnRecord`. Never throws; a failure is a record.
 */

import { MAX_BACKEND_TIMEOUT_MS } from "./config.ts";
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
  const timeout = config.backend === "laya" ? config.laya.timeoutMs : config.jev.timeoutMs;
  const budget = Math.min(timeout + GUARD_MS, MAX_BACKEND_TIMEOUT_MS);
  const controller = new AbortController();
  const guard = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    controller.abort();
    guard.reject(new ClassifierError(config.backend, "timeout", `no answer within ${budget}ms`));
  }, budget);
  try {
    const call = classifier.classify(clipPrompt(prompt, config.maxPromptChars), questions, {
      signal: controller.signal,
    });
    return await Promise.race([call, guard.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** A turn that produced no decision; the caller keeps the baseline. */
function failedTurn(config: LoadoutConfig, startedAt: number, failure: FailureReason, message: string): TurnOutcome {
  const record: TurnRecord = {
    v: 2,
    failure,
    message,
    tools: null,
    skills: null,
    applied: null,
    backend: config.backend,
    dryRun: config.dryRun,
    latencyMs: Date.now() - startedAt,
  };
  return { record, decision: null };
}

export async function runTurn(input: TurnInput): Promise<TurnOutcome> {
  const { config, classifier, baseline, candidates } = input;
  const startedAt = Date.now();

  try {
    // A cold Laya would spend the whole budget loading weights; the full loadout is the safe answer meanwhile.
    if (classifier.readiness() === "warming") {
      return failedTurn(config, startedAt, "warming", "classifier is still loading; using the full loadout");
    }
    const result = await classify(input);
    const decision: LoadoutDecision = {
      tools: decideTools(config.tools, baseline, result.answers[TOOLS_QUESTION_ID]),
      skills: decideSkills(config.skills, candidates, result.answers),
    };
    const record: TurnRecord = {
      v: 2,
      failure: null,
      message: null,
      ...decision,
      applied: null,
      backend: config.backend,
      dryRun: config.dryRun,
      latencyMs: Date.now() - startedAt,
    };
    return { record, decision };
  } catch (error) {
    const failure: FailureReason = error instanceof ClassifierError ? error.code : "error";
    return failedTurn(config, startedAt, failure, errorText(error));
  }
}

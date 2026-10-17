/**
 * One turn of selection: classify the prompt and decide tools and skills.
 * Never throws; a failure is an outcome. The outcome carries the evidence a
 * trace record needs, already reduced to allowlisted values.
 */

import { MAX_BACKEND_TIMEOUT_MS } from "./config.ts";
import { clipPrompt, decideSkills, decideTools, TOOLS_QUESTION_ID } from "./select.ts";
import { type ClassifierEvidence, newId, safeModel, safeStatus, safeTiming, safeUsage } from "./telemetry.ts";
import { ClassifierError } from "./types.ts";
import type {
  ClassificationResult,
  Classifier,
  FailureReason,
  LoadoutConfig,
  LoadoutDecision,
  Questions,
  SkillCandidate,
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
  /** Whether records are persisted this session: a request id exists only then. */
  persist: boolean;
}

export interface TurnOutcome {
  /** Null when the turn failed; the caller keeps the baseline. */
  decision: LoadoutDecision | null;
  failure: FailureReason | null;
  /** Human-readable failure text for notices and /loadout explain. Memory only: never put it in a record. */
  message: string | null;
  classifier: ClassifierEvidence;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function classify(
  input: TurnInput,
  sent: string,
  budgetMs: number,
  evidence: ClassifierEvidence,
): Promise<ClassificationResult> {
  const { config, classifier, questions } = input;
  const controller = new AbortController();
  const guard = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    evidence.guardFired = true;
    controller.abort();
    guard.reject(new ClassifierError(config.backend, "timeout", `no answer within ${budgetMs}ms`));
  }, budgetMs);
  try {
    const call = classifier.classify(sent, questions, {
      signal: controller.signal,
      ...(evidence.requestId === null ? {} : { requestId: evidence.requestId }),
      ...(input.persist ? {} : { telemetryOff: true }),
    });
    return await Promise.race([call, guard.promise]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runTurn(input: TurnInput): Promise<TurnOutcome> {
  const { config, classifier, baseline, candidates } = input;
  const timeoutMs = config.backend === "laya" ? config.laya.timeoutMs : config.jev.timeoutMs;
  const budgetMs = Math.min(timeoutMs + GUARD_MS, MAX_BACKEND_TIMEOUT_MS);
  const sent = clipPrompt(input.prompt, config.maxPromptChars);
  const evidence: ClassifierEvidence = {
    requestId: null,
    model: null,
    elapsedMs: 0,
    budgetMs,
    timeoutMs,
    guardFired: false,
    usage: null,
    server: null,
    status: null,
    promptChars: input.prompt.length,
    sentChars: sent.length,
    questions: Object.keys(input.questions).length,
  };
  const startedAt = performance.now();
  const finish = (): ClassifierEvidence => ({ ...evidence, elapsedMs: Math.round(performance.now() - startedAt) });
  const fail = (failure: FailureReason, message: string): TurnOutcome => ({
    decision: null,
    failure,
    message,
    classifier: finish(),
  });

  try {
    // A cold Laya would spend the whole budget loading weights; the full loadout is the safe answer meanwhile.
    if (classifier.readiness() === "warming")
      return fail("warming", "classifier is still loading; using the full loadout");
    if (input.persist) evidence.requestId = newId();
    const result = await classify(input, sent, budgetMs, evidence);
    const decision: LoadoutDecision = {
      tools: decideTools(config.tools, baseline, result.answers[TOOLS_QUESTION_ID]),
      skills: decideSkills(config.skills, candidates, result.answers),
    };
    // Decision first: a sanitizer bug must never turn a decided turn into failure "error".
    evidence.model = safeModel(result.model);
    evidence.usage = safeUsage(result.usage);
    evidence.server = safeTiming(result.timing);
    return { decision, failure: null, message: null, classifier: finish() };
  } catch (error) {
    if (error instanceof ClassifierError) {
      evidence.status = safeStatus(error.status);
      evidence.server = safeTiming(error.timing);
    }
    return fail(error instanceof ClassifierError ? error.code : "error", errorText(error));
  }
}

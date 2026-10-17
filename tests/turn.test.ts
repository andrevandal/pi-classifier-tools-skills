import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultConfig } from "../src/config.ts";
import { ID_PATTERN } from "../src/telemetry.ts";
import { runTurn, type TurnInput } from "../src/turn.ts";
import {
  type ClassificationResult,
  type Classifier,
  ClassifierError,
  type ClassifyOptions,
  type Readiness,
} from "../src/types.ts";

const BASELINE = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const ANSWERS: ClassificationResult["answers"] = {
  tool_profile: { type: "choice", choice: "answer", probabilities: { answer: 0.95, full: 0.05 }, confidence: 0.95 },
};

interface Seen {
  options: ClassifyOptions[];
  states: unknown[];
}

function fakeClassifier(
  classify: (options: ClassifyOptions) => Promise<ClassificationResult>,
  readiness: Readiness = "ready",
): { classifier: Classifier; seen: Seen } {
  const seen: Seen = { options: [], states: [] };
  const classifier: Classifier = {
    name: "fake",
    readiness: () => readiness,
    dispose: async () => {},
    classify: async (state, _questions, options = {}) => {
      seen.options.push(options);
      seen.states.push(state);
      return classify(options);
    },
  };
  return { classifier, seen };
}

function turnInput(classifier: Classifier, over: Partial<TurnInput> = {}): TurnInput {
  return {
    config: defaultConfig(),
    classifier,
    prompt: "explain this",
    questions: { tool_profile: defaultConfig().tools.question },
    baseline: BASELINE,
    candidates: [],
    persist: true,
    ...over,
  };
}

test("persisting offers the transport one request id, and the evidence carries the same one", async () => {
  const { classifier, seen } = fakeClassifier(async () => ({ answers: ANSWERS }));
  const outcome = await runTurn(turnInput(classifier));
  const [options] = seen.options;
  assert.match(options?.requestId ?? "", ID_PATTERN);
  assert.equal(options?.telemetryOff, undefined);
  assert.equal(outcome.classifier.requestId, options?.requestId);
  assert.equal(outcome.failure, null);
  assert.equal(outcome.decision?.tools.profile, "answer");
});

test("without persistence no request id exists and the transport is told to record nothing", async () => {
  const { classifier, seen } = fakeClassifier(async () => ({ answers: ANSWERS }));
  const outcome = await runTurn(turnInput(classifier, { persist: false }));
  assert.equal(seen.options[0]?.telemetryOff, true);
  assert.equal("requestId" in (seen.options[0] ?? {}), false);
  assert.equal(outcome.classifier.requestId, null);
});

test("a warming classifier is not called, gets no request id, and keeps its message in memory", async () => {
  const { classifier, seen } = fakeClassifier(async () => ({ answers: ANSWERS }), "warming");
  const outcome = await runTurn(turnInput(classifier));
  assert.equal(seen.options.length, 0);
  assert.equal(outcome.failure, "warming");
  assert.equal(outcome.classifier.requestId, null);
  assert.ok(outcome.message);
  assert.equal(outcome.decision, null);
});

test("the guard aborts a classifier that never answers and says so", async () => {
  const config = defaultConfig();
  config.laya.timeoutMs = 1;
  let signal: AbortSignal | undefined;
  const { classifier } = fakeClassifier((options) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  const outcome = await runTurn(turnInput(classifier, { config }));
  assert.equal(outcome.failure, "timeout");
  assert.equal(outcome.classifier.guardFired, true);
  assert.equal(outcome.classifier.budgetMs, 251);
  assert.equal(outcome.classifier.timeoutMs, 1);
  assert.equal(signal?.aborted, true);
});

test("a backend timeout that arrives first does not count as the guard firing", async () => {
  const { classifier } = fakeClassifier(async () => {
    throw new ClassifierError("fake", "timeout", "slow");
  });
  const outcome = await runTurn(turnInput(classifier));
  assert.equal(outcome.failure, "timeout");
  assert.equal(outcome.classifier.guardFired, false);
});

test("backend metadata is reduced to allowlisted values", async () => {
  const prose = fakeClassifier(async () => ({
    answers: ANSWERS,
    model: "a model, as described in prose",
    usage: { input_tokens: 11, output_tokens: 7, secret: "x" } as never,
  }));
  const a = await runTurn(turnInput(prose.classifier));
  assert.equal(a.classifier.model, null);
  assert.deepEqual(a.classifier.usage, { inputTokens: 11, outputTokens: 7 });

  const bad = fakeClassifier(async () => ({ answers: ANSWERS, model: "jev-latest", usage: { input_tokens: -1 } }));
  const b = await runTurn(turnInput(bad.classifier));
  assert.equal(b.classifier.model, "jev-latest");
  assert.equal(b.classifier.usage, null);
});

test("a failed call keeps the status and server timing the transport saw, sanitized", async () => {
  const failing = (status: number) =>
    fakeClassifier(async () => {
      throw new ClassifierError("fake", "unavailable", "HTTP failure", {
        status,
        timing: { queueMs: 5, inferenceMs: 7 },
      });
    }).classifier;
  const ok = await runTurn(turnInput(failing(503)));
  assert.equal(ok.classifier.status, 503);
  assert.deepEqual(ok.classifier.server, { queueMs: 5, inferenceMs: 7 });
  assert.equal((await runTurn(turnInput(failing(99)))).classifier.status, null);
});

test("the prompt is clipped before it is sent and both lengths are recorded", async () => {
  const config = defaultConfig();
  config.maxPromptChars = 200;
  const long = fakeClassifier(async () => ({ answers: ANSWERS }));
  const clipped = await runTurn(turnInput(long.classifier, { config, prompt: "x".repeat(500) }));
  assert.equal(clipped.classifier.promptChars, 500);
  assert.ok(clipped.classifier.sentChars < 500);
  assert.equal((long.seen.states[0] as string).length, clipped.classifier.sentChars);

  const short = fakeClassifier(async () => ({ answers: ANSWERS }));
  const whole = await runTurn(turnInput(short.classifier, { config, prompt: "short" }));
  assert.equal(whole.classifier.promptChars, whole.classifier.sentChars);
});

test("a non-classifier error is failure 'error', and its text stays out of the evidence", async () => {
  const { classifier } = fakeClassifier(async () => {
    throw new Error("CANARY_ERROR_TEXT");
  });
  const outcome = await runTurn(turnInput(classifier));
  assert.equal(outcome.failure, "error");
  assert.match(outcome.message ?? "", /CANARY_ERROR_TEXT/);
  assert.doesNotMatch(JSON.stringify(outcome.classifier), /CANARY/);
});

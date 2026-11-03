import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDecision, formatDecision } from "../src/decide.ts";

test("long options sharing a prefix stay distinct, and bad argument shapes are refused", () => {
  const prefix = "x".repeat(120);
  const built = buildDecision({ ask: "which?", options: [`${prefix}a`, `${prefix}b`] });
  assert.equal(typeof built, "string", "options that collapse after truncation leave fewer than two");

  const ok = buildDecision({ ask: "which?", options: ["grep", " grep ", "read"] });
  assert.ok(typeof ok !== "string");
  assert.deepEqual(Object.keys(ok.question.criteria), ["grep", "read"]);

  assert.match(String(buildDecision({ ask: "", options: ["a", "b"] })), /ask/);
  assert.match(String(buildDecision({ ask: "q", options: ["a", 3] })), /options/);
  assert.match(String(buildDecision(null)), /ask/);
});

test("formatDecision reports the choice with the rest by probability, and never invents a probability", () => {
  assert.equal(
    formatDecision({ type: "choice", choice: "b", probabilities: { a: 0.1, b: 0.7, c: 0.2 }, confidence: 0.7 }),
    "b (p=0.70); others: c 0.20, a 0.10",
  );
  assert.equal(formatDecision({ type: "choice", choice: "b", probabilities: {}, confidence: 0 }), "b");
  assert.match(formatDecision(undefined), /^no decision/);
});

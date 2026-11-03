/**
 * The `ask_decision` tool: an agent hands the classifier a question and its options and gets back the most likely
 * option with probabilities. Pure: builds the typed question and formats the answer; `index.ts` owns the call.
 */

import type { Answer, ChoiceQuestion } from "./types.ts";

export const DECIDE_TOOL = "ask_decision";
export const DECIDE_QUESTION_ID = "ask";

const MAX_ASK_CHARS = 500;
const MAX_OPTIONS = 12;
const MAX_OPTION_CHARS = 120;
const MIN_OPTIONS = 2;

/** Plain JSON Schema, so no schema library is needed; both hosts accept it for tool parameters. */
export const DECIDE_PARAMETERS = {
  type: "object",
  properties: {
    ask: { type: "string", description: "The decision to make, as one question." },
    options: {
      type: "array",
      items: { type: "string" },
      minItems: MIN_OPTIONS,
      maxItems: MAX_OPTIONS,
      description: "The candidate answers. Make each self-explanatory.",
    },
    context: { type: "string", description: "Optional text the decision is about, such as the user request." },
  },
  required: ["ask", "options"],
} as const;

export const DECIDE_DESCRIPTION =
  "Ask a small classifier model to pick one of your options (for example which tool, skill or approach fits). " +
  "Returns the likeliest option with probabilities. Advisory only; you decide.";

export interface DecideArgs {
  ask: string;
  options: string[];
  context?: string;
}

/** A validated question and its options, or the reason the arguments are unusable. */
export function buildDecision(args: unknown): { question: ChoiceQuestion; state: string; options: string[] } | string {
  const { ask, options, context } = (args ?? {}) as Partial<DecideArgs>;
  if (typeof ask !== "string" || ask.trim() === "") return "ask must be a non-empty string";
  if (!Array.isArray(options) || options.some((option) => typeof option !== "string" || option.trim() === "")) {
    return "options must be a list of non-empty strings";
  }
  // Truncate before deduplicating: two long options sharing a prefix must not collapse into one criteria key.
  const unique = [...new Set(options.map((option) => option.trim().slice(0, MAX_OPTION_CHARS)))];
  if (unique.length < MIN_OPTIONS || unique.length > MAX_OPTIONS) {
    return `options needs ${MIN_OPTIONS} to ${MAX_OPTIONS} distinct entries`;
  }
  const question: ChoiceQuestion = {
    type: "choice",
    instructions: ask.slice(0, MAX_ASK_CHARS),
    criteria: Object.fromEntries(unique.map((option) => [option, null])),
  };
  return { question, state: typeof context === "string" && context !== "" ? context : ask, options: unique };
}

/** One line: the choice, then the others by probability. Empty probabilities are never reported as zero. */
export function formatDecision(answer: Answer | undefined): string {
  if (answer?.type !== "choice") return "no decision: the classifier returned no answer to this question";
  const rest = Object.entries(answer.probabilities ?? {})
    .filter(([option]) => option !== answer.choice)
    .sort((a, b) => b[1] - a[1])
    .map(([option, p]) => `${option} ${p.toFixed(2)}`);
  const own = answer.probabilities?.[answer.choice];
  const head = `${answer.choice}${own === undefined ? "" : ` (p=${own.toFixed(2)})`}`;
  return rest.length > 0 ? `${head}; others: ${rest.join(", ")}` : head;
}

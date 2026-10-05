/**
 * Shared contract for the loadout selector.
 *
 * The classifier half (questions, answers, `Classifier`, backend configs) is the
 * System-One contract from pi-classifier-router, kept verbatim so its Jev and
 * Laya clients drop in unchanged. The loadout half describes how answers become
 * a per-turn set of active tools and visible skills.
 */

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/** `instructions` / criterion descriptions accept structured payloads, per TypeSafe. */
export type InstructionValue = string | Record<string, unknown> | unknown[];

export interface ChoiceQuestion {
  type: "choice";
  instructions: InstructionValue;
  /** Option id -> rubric description (null when the id is self-describing). */
  criteria: Record<string, InstructionValue | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: InstructionValue;
  /** Ordered, at least two levels, lowest first. */
  criteria: InstructionValue[];
}

export interface NoulQuestion {
  type: "noul";
  instructions: InstructionValue;
  criteria?: { true?: InstructionValue; false?: InstructionValue };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

/** Question id -> question. Ids are for code and are never sent to the model. */
export type Questions = Record<string, Question>;

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  /** Every option mapped to its probability. */
  probabilities: Record<string, number>;
  /** 0..1, derived from the probability distribution. */
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted value across the levels; may land between levels. */
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  /** Probability the answer is yes, 0..1. */
  noul: number;
  confidence: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type Answers = Record<string, Answer>;

/** Normalized backend reply. `answers` is the only field routing reads. */
export interface ClassificationResult {
  model?: string;
  answers: Answers;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** The state handed to a classifier: prompt text, or a structured document. */
export type ClassifierState = string | Record<string, unknown> | unknown[];

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

export interface ClassifyOptions {
  signal?: AbortSignal;
}

/**
 * A classifier turns state + typed questions into typed answers.
 *
 * Implementations MUST throw `ClassifierError` on any failure (transport,
 * auth, timeout, malformed reply). They MUST NOT throw for a well-formed reply
 * that merely lacks a question id; callers treat missing answers as absent.
 */
export interface Classifier {
  /** Stable backend id, e.g. `"jev"` or `"laya"`. */
  readonly name: string;
  /**
   * Optional: make the backend ready before the first classification.
   * `classify` MUST still work without a prior `warmup` call.
   */
  warmup?(options?: ClassifyOptions): Promise<void>;
  classify(state: ClassifierState, questions: Questions, options?: ClassifyOptions): Promise<ClassificationResult>;
  /** Release resources (HTTP handles, sidecar processes). Idempotent. */
  dispose(): Promise<void>;
}

export type ClassifierErrorCode = "unavailable" | "timeout" | "auth" | "transport" | "protocol" | "aborted";

export class ClassifierError extends Error {
  readonly code: ClassifierErrorCode;
  readonly backend: string;

  constructor(backend: string, code: ClassifierErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClassifierError";
    this.backend = backend;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface JevBackendConfig {
  /** Evaluation endpoint, e.g. `https://api.typesafe.ai/v1/systemone`. */
  endpoint: string;
  /** Model alias sent with the request, e.g. `jev-latest`. */
  model: string;
  /** Environment variable holding the bearer token. */
  apiKeyEnvVar: string;
  timeoutMs: number;
}

/** Where Laya inference runs: the local python sidecar, or a remote HTTP host. */
export type LayaTransport = "python" | "http";

/**
 * Laya System-One backend.
 *
 * `transport` selects the implementation: `"python"` spawns the local sidecar
 * worker, `"http"` posts typed questions to `endpoint` and needs no local
 * install. The python-only fields below are ignored when
 * `transport === "http"`; `endpoint`/`apiKeyEnvVar` are ignored when
 * `transport === "python"`.
 *
 * The http transport sends no `model` field: the remote host owns checkpoint
 * selection, so there is deliberately no `model` here.
 */
export interface LayaBackendConfig {
  /** Where inference runs. */
  transport: LayaTransport;
  /** Full URL of a System-One-compatible endpoint; used when `transport === "http"`. */
  endpoint: string;
  /**
   * Env var holding an optional bearer token for `endpoint`; an unset or empty
   * value means no `Authorization` header is sent.
   */
  apiKeyEnvVar: string;
  /** Python interpreter used to run the sidecar worker. Ignored for `"http"`. */
  pythonBin: string;
  /** Path to `python/laya_worker.py`, absolute or relative to the extension root. */
  workerScript: string;
  /** Hugging Face repo bundling the checkpoints. */
  repo: string;
  /** Checkpoint subfolder: `null` = English root, `"multilingual"`, `"typed-decisions"`. */
  subfolder: string | null;
  /** Torch device (`cpu`, `cuda`, `mps`), or `null` for auto-detect. */
  device: string | null;
  /**
   * Serve every checkpoint through `laya.Router` (adds multilingual routing).
   * The Router always serves the upstream `convaiinnovations/laya` checkpoints,
   * so `repo` and `subfolder` cannot be combined with it.
   */
  router: boolean;
  /**
   * Checkpoints `laya.Router` keeps resident; `null` keeps Laya's own default
   * (English + multilingual). Only meaningful with `router: true`.
   */
  maxLoaded: number | null;
  /** Load weights during `warmup` instead of on the first classification. */
  preload: boolean;
  /** Per-classification budget; exceeding it fails the call. */
  timeoutMs: number;
  /** Budget for loading weights during `warmup`. */
  warmupTimeoutMs: number;
  /** Environment variable holding the Hugging Face token, if the repo is gated. */
  hfTokenEnvVar: string;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Loadout
// ---------------------------------------------------------------------------

/** `"*"` stands for every tool that was active when the session started. */
export type ToolList = string[] | "*";

export interface ToolsSelectorConfig {
  enabled: boolean;
  /** The `choice` question whose options are the keys of `profiles`. */
  question: ChoiceQuestion;
  /** Profile id -> tools to activate. Always intersected with the session baseline. */
  profiles: Record<string, ToolList>;
  /** Tools kept active under every profile (still intersected with the baseline). */
  alwaysOn: string[];
  /** Below this confidence the baseline is kept. */
  confidenceThreshold: number;
}

/**
 * How a skill selection is applied.
 * - `filter`: hide unselected skills from the system prompt (pi only).
 * - `hint`: keep every skill listed and inject a message naming the relevant ones.
 * - `auto`: `filter` where the host exposes prompt options, otherwise `hint`.
 */
export type SkillsMode = "auto" | "filter" | "hint";

export interface SkillsSelectorConfig {
  enabled: boolean;
  mode: SkillsMode;
  /** Minimum yes-probability for a skill to count as relevant. */
  threshold: number;
  /** Most skills selected per turn, highest probability first. */
  maxSkills: number;
  /** Above this many candidates, selection is skipped so per-turn cost stays bounded. */
  maxCandidates: number;
  /** Skills selected on every turn regardless of the answers. */
  alwaysInclude: string[];
  /** Skills never offered to the classifier (and never hidden by it). */
  exclude: string[];
}

export interface LoadoutConfig {
  enabled: boolean;
  backend: "jev" | "laya";
  jev: JevBackendConfig;
  laya: LayaBackendConfig;
  tools: ToolsSelectorConfig;
  skills: SkillsSelectorConfig;
  /** Longest prompt sent to the classifier; `null` sends it whole. */
  maxPromptChars: number | null;
  /** Classify and record, but never change tools or skills. */
  dryRun: boolean;
  notify: boolean;
}

export interface LoadoutConfigInput {
  enabled?: boolean;
  backend?: LoadoutConfig["backend"];
  jev?: Partial<JevBackendConfig>;
  laya?: Partial<LayaBackendConfig>;
  tools?: Partial<ToolsSelectorConfig>;
  skills?: Partial<SkillsSelectorConfig>;
  maxPromptChars?: number | null;
  dryRun?: boolean;
  notify?: boolean;
}

/** A skill as the classifier sees it. */
export interface SkillCandidate {
  name: string;
  description: string;
}

export type ToolsReason = "selected" | "disabled" | "missing-answer" | "low-confidence" | "unknown-profile";
export type SkillsReason = "selected" | "disabled" | "no-candidates" | "too-many-candidates" | "missing-answer";

export interface ToolsDecision {
  /** Tools to activate, or null to keep the baseline. */
  active: string[] | null;
  profile: string | null;
  confidence: number;
  reason: ToolsReason;
}

export interface SkillsDecision {
  /** Selected skill names, or null to keep every skill. */
  selected: string[] | null;
  /** Yes-probability per candidate, for reporting. */
  scores: Record<string, number>;
  reason: SkillsReason;
}

export interface LoadoutDecision {
  tools: ToolsDecision;
  skills: SkillsDecision;
}

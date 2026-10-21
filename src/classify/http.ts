/**
 * Shared System-One HTTP client.
 *
 * Both backends speak the same wire format, so this is the single transport:
 * `POST <endpoint>` with `Authorization: Bearer <token>` (only when a token is
 * configured and present), `Content-Type: application/json`, and body
 * `{ state, model?, questions }`; response `{ model?, answers, usage? }`.
 *
 * The bearer token is read from the configured environment variable and is
 * never logged or embedded in errors. Every request is bounded by `timeoutMs`,
 * composed with the caller's own signal so either side can abort, and the
 * timer is always cleared.
 *
 * Our own Laya server is correlated with (`correlation`): the call carries `X-Request-Id`, or `X-Loadout-Telemetry: off`
 * when the caller opted out, and the server's `Server-Timing` queue/infer metrics are read back. Every failure raised
 * after the body was read keeps that response's HTTP status, and those timings, on the `ClassifierError`.
 */

import { ID_PATTERN } from "../telemetry.ts";
import { ClassifierError } from "../types.ts";
import type {
  Answers,
  ClassificationResult,
  Classifier,
  ClassifierErrorCode,
  ClassifierState,
  ClassifyOptions,
  Questions,
  Readiness,
  ServerTiming,
} from "../types.ts";
import type { ClassifierDeps } from "./index.ts";

/** Body snippet length kept for diagnostics; long bodies are never echoed. */
const SNIPPET_LIMIT = 200;

export interface HttpClassifierOptions {
  /** Backend id reported on `Classifier.name` and on `ClassifierError.backend`. */
  name: string;
  endpoint: string;
  /** Value for the request body's `model` field; omitted from the body when null. */
  model: string | null;
  /** Env var holding the bearer token; when unset or empty, no Authorization header is sent. */
  apiKeyEnvVar: string;
  timeoutMs: number;
  /**
   * Correlate with our own Laya server: send `X-Request-Id` (or `X-Loadout-Telemetry: off` for an opted-out caller) and
   * read the `queue`/`infer` metrics of the `Server-Timing` response header. Only that server understands them, so a
   * third-party endpoint (Jev) never sees the headers and never has its timing read. Default false.
   */
  correlation?: boolean;
}

/** An opted-out request carries the off signal and no id; otherwise only a well-formed id is sent. */
function correlationHeaders(options: ClassifyOptions | undefined): Record<string, string> {
  if (options?.telemetryOff) return { "X-Loadout-Telemetry": "off" };
  const requestId = options?.requestId;
  return requestId !== undefined && ID_PATTERN.test(requestId) ? { "X-Request-Id": requestId } : {};
}

const DURATION = /^dur=(\d{1,9}(?:\.\d{1,6})?)$/;

/**
 * The `queue` and `infer` metrics of a `Server-Timing` header, in ms. Other metrics and parameters are ignored. A metric
 * that is repeated or has no plain non-negative decimal `dur` stays unknown (absent), never zero.
 */
function parseServerTiming(header: string | null): ServerTiming | undefined {
  if (header === null) return undefined;
  const found = new Map<string, number | null>();
  for (const metric of header.split(",")) {
    const [name = "", ...params] = metric.split(";").map((part) => part.trim());
    if (name !== "queue" && name !== "infer") continue;
    const duration = params.map((param) => DURATION.exec(param)?.[1]).find((value) => value !== undefined);
    found.set(name, found.has(name) || duration === undefined ? null : Number(duration));
  }
  const timing: ServerTiming = {};
  const queueMs = found.get("queue");
  const inferenceMs = found.get("infer");
  if (queueMs != null) timing.queueMs = queueMs;
  if (inferenceMs != null) timing.inferenceMs = inferenceMs;
  return Object.keys(timing).length > 0 ? timing : undefined;
}

export function createHttpClassifier(options: HttpClassifierOptions, deps: ClassifierDeps = {}): Classifier {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const backend = options.name;

  function token(): string {
    const envVar = options.apiKeyEnvVar;
    if (envVar.trim() === "") return "";
    const fromDeps = deps.env?.[envVar];
    const value = fromDeps ?? process.env[envVar];
    return (value ?? "").trim();
  }

  return {
    name: backend,

    /**
     * Uniform no-op: probing the endpoint would spend tokens for no signal, and
     * `classify` works without a prior warmup.
     */
    async warmup(): Promise<void> {},

    /** HTTP has no load phase: every request is served on arrival. */
    readiness(): Readiness {
      return "ready";
    },

    async classify(
      state: ClassifierState,
      questions: Questions,
      classifyOptions?: ClassifyOptions,
    ): Promise<ClassificationResult> {
      const bearer = token();
      const envVar = options.apiKeyEnvVar;
      if (bearer === "" && envVar.trim() !== "") {
        throw new ClassifierError(backend, "unavailable", `${envVar} is not set; ${backend} is unavailable`);
      }

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (bearer !== "") headers["Authorization"] = `Bearer ${bearer}`;
      if (options.correlation) Object.assign(headers, correlationHeaders(classifyOptions));

      const body: Record<string, unknown> = { state, questions };
      if (options.model !== null) body["model"] = options.model;

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs);
      const caller = classifyOptions?.signal;
      const onCallerAbort = (): void => controller.abort();
      if (caller) {
        if (caller.aborted) controller.abort();
        else caller.addEventListener("abort", onCallerAbort, { once: true });
      }

      try {
        const response = await fetchImpl(options.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        // What the call saw of the server, kept on every failure raised after the body was read: unknown stays unknown.
        const seen = {
          status: response.status,
          timing: options.correlation ? parseServerTiming(response.headers.get("server-timing")) : undefined,
        };
        const bodyText = await response.text();
        if (!response.ok) {
          const code: ClassifierErrorCode =
            response.status === 401 || response.status === 403
              ? "auth"
              : response.status === 429 || response.status >= 500
                ? "unavailable"
                : "protocol";
          const collapsed = bodyText.replace(/\s+/g, " ").trim().slice(0, SNIPPET_LIMIT);
          throw new ClassifierError(
            backend,
            code,
            `${backend} endpoint returned ${response.status}: ${collapsed}`,
            seen,
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(bodyText);
        } catch (error) {
          throw new ClassifierError(backend, "protocol", `${backend} response was not JSON`, { cause: error, ...seen });
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new ClassifierError(backend, "protocol", `${backend} response was not a JSON object`, seen);
        }

        const record = parsed as Record<string, unknown>;
        const answers = record["answers"];
        if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
          throw new ClassifierError(backend, "protocol", `${backend} response has no answers object`, seen);
        }

        const result: ClassificationResult = { answers: answers as Answers };
        if (seen.timing) result.timing = seen.timing;
        if (typeof record["model"] === "string") result.model = record["model"];
        const usage = record["usage"];
        if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
          result.usage = usage as ClassificationResult["usage"];
        }
        return result;
      } catch (error) {
        if (error instanceof ClassifierError) throw error;
        if (controller.signal.aborted) {
          if (caller?.aborted) {
            throw new ClassifierError(backend, "aborted", `${backend} request aborted by caller`, {
              cause: error,
            });
          }
          if (timedOut) {
            throw new ClassifierError(backend, "timeout", `${backend} request exceeded ${options.timeoutMs}ms`, {
              cause: error,
            });
          }
        }
        throw new ClassifierError(
          backend,
          "transport",
          `${backend} request failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      } finally {
        clearTimeout(timer);
        if (caller) caller.removeEventListener("abort", onCallerAbort);
      }
    },

    async dispose(): Promise<void> {},
  };
}

/**
 * Laya (remote System One) classifier over HTTP.
 *
 * Targets any host running the same typed-question protocol as the local
 * sidecar: a containerized `python/laya_worker.py`, a FastAPI wrapper, or any
 * other compatible System-One server. It spawns no child process, so the
 * deployment shape "one shared GPU host, thin TypeScript clients" needs no
 * local Laya install.
 *
 * The remote host owns checkpoint selection, so no `model` field is sent. Requests are correlated with the host: the
 * request id goes out in `X-Request-Id`, and the host's queue and inference times come back in `Server-Timing`. A
 * compatible host that sends neither just reports no timing.
 */

import type { Classifier, LayaBackendConfig } from "../types.ts";
import { createHttpClassifier } from "./http.ts";
import type { ClassifierDeps } from "./index.ts";

export function createLayaHttpClassifier(config: LayaBackendConfig, deps: ClassifierDeps = {}): Classifier {
  return createHttpClassifier(
    {
      name: "laya",
      endpoint: config.endpoint,
      model: null,
      apiKeyEnvVar: config.apiKeyEnvVar,
      timeoutMs: config.timeoutMs,
      correlation: true,
    },
    deps,
  );
}

/**
 * Tests for the shared System-One HTTP client and the Laya http transport.
 *
 * A `node:http` stub server on port 0 stands in for a remote GPU host: no real
 * network, no real key. Every server and socket is torn down so the file is
 * suite-safe.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { createClassifier, type LayaSpawn } from "../src/classify/index.ts";
import { createHttpClassifier } from "../src/classify/http.ts";
import { createJevClassifier } from "../src/classify/jev.ts";
import { createLayaHttpClassifier } from "../src/classify/laya-http.ts";
import { defaultConfig } from "../src/config.ts";
import { ClassifierError } from "../src/types.ts";
import type { Answers, LayaBackendConfig, Questions, LoadoutConfig, ServerTiming } from "../src/types.ts";

const TOKEN_VAR = "CLASS_ROUTER_TEST_LAYAA_HTTP_TOKEN";
const TOKEN = "s3cret-laya-token";
const MISSING_VAR = "CLASS_ROUTER_TEST_LAYAA_HTTP_MISSING";
delete process.env[MISSING_VAR];

const QUESTIONS: Questions = {
  primary: {
    type: "choice",
    instructions: "Which model should answer?",
    criteria: { fast: "a cheap model", deep: "the slowest, smartest model" },
  },
};

const ANSWERS: Answers = {
  primary: { type: "choice", choice: "fast", probabilities: { fast: 0.91, deep: 0.09 }, confidence: 0.91 },
};

interface Captured {
  method: string | undefined;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const captured: Captured[] = [];
const sockets = new Set<Socket>();

const server = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    captured.push({ method: request.method, url: request.url ?? "", headers: request.headers, body });

    switch (request.url) {
      case "/ok": {
        response.writeHead(200, { "Content-Type": "application/json" });
        // `extra` proves unknown fields are dropped rather than passed through.
        response.end(
          JSON.stringify({
            model: "laya-stub",
            answers: ANSWERS,
            usage: { input_tokens: 7, output_tokens: 3 },
            extra: true,
          }),
        );
        return;
      }
      case "/unauthorized":
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "bad token" }));
        return;
      case "/forbidden":
        response.writeHead(403);
        response.end("nope");
        return;
      case "/throttled":
        response.writeHead(429);
        response.end("slow down");
        return;
      case "/garbage":
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("this is not json");
        return;
      case "/no-answers":
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ model: "laya-stub", answers: [] }));
        return;
      case "/timing":
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Server-Timing": "queue;dur=1.500, infer;dur=38.250",
        });
        response.end(JSON.stringify({ model: "laya-stub", answers: ANSWERS }));
        return;
      case "/failed-with-timing":
        response.writeHead(500, { "Content-Type": "application/json", "Server-Timing": "queue;dur=2, infer;dur=40" });
        response.end(JSON.stringify({ error: "ValueError: CANARY-BODY" }));
        return;
      case "/garbage-with-timing":
        response.writeHead(200, { "Server-Timing": "queue;dur=2, infer;dur=40" });
        response.end("this is not json");
        return;
      case "/stall":
        return; // never answers: only the client's own timeout or abort ends the call
      default:
        response.writeHead(404);
        response.end();
    }
  });
});

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

let endpoint = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function layaConfig(path: string, apiKeyEnvVar = "", timeoutMs = 2000): LayaBackendConfig {
  return {
    transport: "http",
    endpoint: `${endpoint}${path}`,
    apiKeyEnvVar,
    pythonBin: "python3",
    workerScript: "python/laya_worker.py",
    repo: "convaiinnovations/laya",
    subfolder: null,
    device: null,
    router: true,
    maxLoaded: null,
    preload: true,
    timeoutMs,
    warmupTimeoutMs: 3000,
    hfTokenEnvVar: "HF_TOKEN",
  };
}

async function rejection(promise: Promise<unknown>, code: string, backend = "laya"): Promise<ClassifierError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ClassifierError, `expected ClassifierError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.backend, backend);
    return error;
  }
  throw new assert.AssertionError({ message: `expected rejection with code ${code}` });
}

test("classifies through the http transport, passing questions through unchanged", async () => {
  const laya = createLayaHttpClassifier(layaConfig("/ok"), { env: {} });
  assert.equal(laya.name, "laya");

  const result = await laya.classify("hello world", QUESTIONS);
  await laya.dispose();

  const sent = captured.at(-1);
  assert.ok(sent, "server captured no request");
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, "/ok");
  assert.match(String(sent.headers["content-type"]), /application\/json/);
  const body = JSON.parse(sent.body) as Record<string, unknown>;
  assert.equal(body["state"], "hello world");
  assert.deepEqual(body["questions"], QUESTIONS);
  // The remote host owns checkpoint selection, so laya sends no `model`.
  assert.equal("model" in body, false);

  assert.deepEqual(result.answers, ANSWERS);
  assert.equal(result.model, "laya-stub");
  assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 3 });
  assert.equal("extra" in result, false);
});

test("includes the model field only when one is configured", async () => {
  const withoutModel = createHttpClassifier(
    { name: "laya", endpoint: `${endpoint}/ok`, model: null, apiKeyEnvVar: "", timeoutMs: 2000 },
    { env: {} },
  );
  await withoutModel.classify("x", QUESTIONS);
  const omitted = JSON.parse(captured.at(-1)!.body) as Record<string, unknown>;
  assert.equal("model" in omitted, false);

  const withModel = createHttpClassifier(
    { name: "laya", endpoint: `${endpoint}/ok`, model: "laya-model-x", apiKeyEnvVar: "", timeoutMs: 2000 },
    { env: {} },
  );
  await withModel.classify("x", QUESTIONS);
  const present = JSON.parse(captured.at(-1)!.body) as Record<string, unknown>;
  assert.equal(present["model"], "laya-model-x");
});

test("sends no Authorization header when apiKeyEnvVar is unset or blank", async () => {
  const unset = createHttpClassifier(
    { name: "laya", endpoint: `${endpoint}/ok`, model: null, apiKeyEnvVar: "", timeoutMs: 2000 },
    { env: {} },
  );
  await unset.classify("x", QUESTIONS);
  assert.equal("authorization" in captured.at(-1)!.headers, false);

  const blank = createHttpClassifier(
    { name: "laya", endpoint: `${endpoint}/ok`, model: null, apiKeyEnvVar: "   ", timeoutMs: 2000 },
    { env: {} },
  );
  await blank.classify("x", QUESTIONS);
  assert.equal("authorization" in captured.at(-1)!.headers, false);
});

test("sends a bearer header when a token is configured", async () => {
  const laya = createLayaHttpClassifier(layaConfig("/ok", TOKEN_VAR), { env: { [TOKEN_VAR]: TOKEN } });
  await laya.classify("x", QUESTIONS);
  assert.equal(captured.at(-1)!.headers["authorization"], `Bearer ${TOKEN}`);
});

test("a configured but missing token variable is unavailable without a request", async () => {
  const laya = createLayaHttpClassifier(layaConfig("/ok", MISSING_VAR), { env: {} });
  const before = captured.length;
  const error = await rejection(laya.classify("x", QUESTIONS), "unavailable");
  assert.match(error.message, new RegExp(MISSING_VAR));
  assert.equal(captured.length, before);
});

test("maps 401 and 403 to auth", async () => {
  const unauthorized = await rejection(
    createLayaHttpClassifier(layaConfig("/unauthorized"), { env: {} }).classify("x", QUESTIONS),
    "auth",
  );
  assert.match(unauthorized.message, /401/);
  await rejection(createLayaHttpClassifier(layaConfig("/forbidden"), { env: {} }).classify("x", QUESTIONS), "auth");
});

test("maps 429 to unavailable and reports the status", async () => {
  const error = await rejection(
    createLayaHttpClassifier(layaConfig("/throttled"), { env: {} }).classify("x", QUESTIONS),
    "unavailable",
  );
  assert.match(error.message, /429/);
});

test("an unreachable endpoint is a transport failure", async () => {
  const dead = http.createServer();
  await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
  const deadPort = (dead.address() as AddressInfo).port;
  await new Promise<void>((resolve) => dead.close(() => resolve()));

  const error = await rejection(
    createHttpClassifier(
      { name: "laya", endpoint: `http://127.0.0.1:${deadPort}/ok`, model: null, apiKeyEnvVar: "", timeoutMs: 2000 },
      { env: {} },
    ).classify("x", QUESTIONS),
    "transport",
  );
  assert.match(error.message, /laya request failed/);
});

test("maps a malformed answer body to protocol", async () => {
  await rejection(createLayaHttpClassifier(layaConfig("/garbage"), { env: {} }).classify("x", QUESTIONS), "protocol");
  await rejection(
    createLayaHttpClassifier(layaConfig("/no-answers"), { env: {} }).classify("x", QUESTIONS),
    "protocol",
  );
});

test("createClassifier uses the http transport without spawning a child process", async () => {
  const spawnCalls: string[] = [];
  const blockedSpawn: LayaSpawn = (command) => {
    spawnCalls.push(command);
    throw new Error("spawn blocked by test");
  };

  const config: LoadoutConfig = defaultConfig();
  config.backend = "laya";
  config.laya.transport = "http";
  config.laya.endpoint = `${endpoint}/ok`;
  config.laya.apiKeyEnvVar = "";

  const classifier = createClassifier(config, { spawnImpl: blockedSpawn, env: {} });
  assert.equal(classifier.name, "laya");

  const result = await classifier.classify("hello", QUESTIONS);
  await classifier.dispose();

  assert.deepEqual(result.answers, ANSWERS);
  assert.deepEqual(spawnCalls, []);
  const sent = captured.at(-1)!;
  assert.equal(sent.url, "/ok");
  assert.equal("model" in JSON.parse(sent.body), false);
});

test("createClassifier still uses the python sidecar for the python transport", async () => {
  const spawnCalls: string[] = [];
  const blockedSpawn: LayaSpawn = (command) => {
    spawnCalls.push(command);
    throw new Error("spawn blocked by test");
  };

  const config: LoadoutConfig = defaultConfig();
  config.backend = "laya";

  const classifier = createClassifier(config, { spawnImpl: blockedSpawn, env: {} });
  assert.equal(classifier.name, "laya");

  const error = await rejection(classifier.classify("x", QUESTIONS), "unavailable");
  assert.match(error.message, /could not spawn laya worker/);
  assert.equal(spawnCalls.length, 1);
});

// --- request correlation and server timing ---------------------------------------------------------------------------

const REQUEST_ID = "6f1c2a9e-3b4d-4c5e-8f60-7a8b9c0d1e2f";

test("laya http sends the request id and reads the server's queue and inference time", async () => {
  const laya = createLayaHttpClassifier(layaConfig("/timing"), { env: {} });
  const result = await laya.classify("x", QUESTIONS, { requestId: REQUEST_ID });

  const headers = captured.at(-1)!.headers;
  assert.equal(headers["x-request-id"], REQUEST_ID);
  assert.equal("x-loadout-telemetry" in headers, false);
  assert.deepEqual(result.timing, { queueMs: 1.5, inferenceMs: 38.25 });
  assert.deepEqual(result.answers, ANSWERS, "the answers are unaffected");
});

test("an opted-out request carries the off signal and no request id, even if one is offered", async () => {
  const laya = createLayaHttpClassifier(layaConfig("/timing"), { env: {} });
  await laya.classify("x", QUESTIONS, { requestId: REQUEST_ID, telemetryOff: true });

  const headers = captured.at(-1)!.headers;
  assert.equal(headers["x-loadout-telemetry"], "off");
  assert.equal("x-request-id" in headers, false);
});

test("a call without telemetry options sends no correlation header", async () => {
  await createLayaHttpClassifier(layaConfig("/timing"), { env: {} }).classify("x", QUESTIONS);
  const headers = captured.at(-1)!.headers;
  assert.equal("x-request-id" in headers, false);
  assert.equal("x-loadout-telemetry" in headers, false);
});

test("a request id that is not a UUIDv4 is never sent, and the call still succeeds", async () => {
  const laya = createLayaHttpClassifier(layaConfig("/ok"), { env: {} });
  for (const requestId of ["", "not-an-id", REQUEST_ID.toUpperCase(), `${REQUEST_ID}\r\nX-Injected: 1`]) {
    const result = await laya.classify("x", QUESTIONS, { requestId });
    assert.deepEqual(result.answers, ANSWERS);
    const headers = captured.at(-1)!.headers;
    assert.equal("x-request-id" in headers, false, JSON.stringify(requestId));
    assert.equal("x-injected" in headers, false);
  }
});

test("jev never receives correlation headers and never has its timing read", async () => {
  const jevOptions = { model: "jev-test-model", apiKeyEnvVar: "", timeoutMs: 2000 };
  const timed = createJevClassifier({ ...jevOptions, endpoint: `${endpoint}/timing` }, { env: {} });
  const failing = createJevClassifier({ ...jevOptions, endpoint: `${endpoint}/failed-with-timing` }, { env: {} });

  for (const options of [{ requestId: REQUEST_ID }, { telemetryOff: true }]) {
    const result = await timed.classify("x", QUESTIONS, options);
    const headers = captured.at(-1)!.headers;
    assert.equal("x-request-id" in headers, false);
    assert.equal("x-loadout-telemetry" in headers, false);
    assert.equal("timing" in result, false, "the server sent a timing header; jev ignores it");
  }
  // The HTTP status of a failed call is plain HTTP, so jev reports it; its timing is still not read.
  const error = await rejection(failing.classify("x", QUESTIONS), "unavailable", "jev");
  assert.deepEqual([error.status, error.timing], [500, undefined]);
});

test("only plain queue and infer durations are read; anything else stays unknown", async () => {
  const table: Array<[string, ServerTiming | undefined]> = [
    ["queue;dur=0, infer;dur=12.5", { queueMs: 0, inferenceMs: 12.5 }],
    ["infer;dur=12.5", { inferenceMs: 12.5 }],
    ["queue;dur=3", { queueMs: 3 }],
    ['cache;desc="hit", queue;dur=1.25, infer;dur=2;desc="x"', { queueMs: 1.25, inferenceMs: 2 }],
    ["queue;dur=1, queue;dur=2, infer;dur=3", { inferenceMs: 3 }],
    ['queue;desc="a, b";dur=7, queue;dur=9', undefined],
    ["queue;dur=-1, infer;dur=NaN", undefined],
    ["queue;dur=1e3", undefined],
    ["queue;dur=Infinity", undefined],
    ["queue;dur=12345678901", undefined],
    ["queue", undefined],
    ["queue;dur=", undefined],
    ['queue;dur="5"', undefined],
    ["queue;dur=CANARY-SECRET, infer;dur=CANARY-SECRET", undefined],
    ["", undefined],
  ];
  for (const [header, expected] of table) {
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ answers: ANSWERS }), {
        headers: { "Content-Type": "application/json", "Server-Timing": header },
      });
    const laya = createHttpClassifier(
      {
        name: "laya",
        endpoint: "http://stub.invalid/",
        model: null,
        apiKeyEnvVar: "",
        timeoutMs: 2000,
        correlation: true,
      },
      { env: {}, fetchImpl },
    );
    const result = await laya.classify("x", QUESTIONS);
    assert.deepEqual(result.answers, ANSWERS, header);
    if (expected === undefined) assert.equal("timing" in result, false, header);
    else assert.deepEqual(result.timing, expected, header);
    assert.equal(JSON.stringify(result).includes("CANARY"), false);
  }
});

test("a failed call carries the HTTP status and the phases the server reported, nothing from the body", async () => {
  const failed = await rejection(
    createLayaHttpClassifier(layaConfig("/failed-with-timing"), { env: {} }).classify("x", QUESTIONS, {
      requestId: REQUEST_ID,
    }),
    "unavailable",
  );
  assert.deepEqual([failed.status, failed.timing], [500, { queueMs: 2, inferenceMs: 40 }]);
  assert.equal(JSON.stringify({ status: failed.status, timing: failed.timing }).includes("CANARY"), false);

  const rejected = await rejection(
    createLayaHttpClassifier(layaConfig("/unauthorized"), { env: {} }).classify("x", QUESTIONS),
    "auth",
  );
  assert.deepEqual([rejected.status, rejected.timing], [401, undefined]);

  const malformed = await rejection(
    createLayaHttpClassifier(layaConfig("/garbage-with-timing"), { env: {} }).classify("x", QUESTIONS),
    "protocol",
  );
  assert.deepEqual([malformed.status, malformed.timing], [200, { queueMs: 2, inferenceMs: 40 }]);
});

test("a call that never got a response carries no status and no timing", async () => {
  const timedOut = await rejection(
    createLayaHttpClassifier(layaConfig("/stall", "", 100), { env: {} }).classify("x", QUESTIONS, {
      requestId: REQUEST_ID,
    }),
    "timeout",
  );
  assert.deepEqual([timedOut.status, timedOut.timing], [undefined, undefined]);

  const controller = new AbortController();
  const pending = createLayaHttpClassifier(layaConfig("/stall", "", 5000), { env: {} }).classify("x", QUESTIONS, {
    signal: controller.signal,
  });
  controller.abort();
  const aborted = await rejection(pending, "aborted");
  assert.deepEqual([aborted.status, aborted.timing], [undefined, undefined]);
});

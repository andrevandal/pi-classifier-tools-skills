/**
 * The real python/laya_http_server.py, run against the fake `laya` module so no
 * torch or checkpoints are needed. Covers the predict round trip, the bearer
 * token gate, the body-size cap, the non-loopback refusal and the request telemetry (`loadout.http` stderr line,
 * `Server-Timing`, opt-outs).
 */

import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createLayaHttpClassifier } from "../src/classify/laya-http.ts";
import { defaultConfig } from "../src/config.ts";
import { normalizeHttp } from "../src/telemetry.ts";
import { ClassifierError } from "../src/types.ts";
import type { Questions } from "../src/types.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(TEST_DIR, "..", "python", "laya_http_server.py");
const FAKE_LAYA = path.join(TEST_DIR, "fixtures", "fake_laya");
const PYTHON = "python3";
const QUESTIONS: Questions = { t: { type: "choice", instructions: "x", criteria: { a: "a", b: "b" } } };
const bodyOf = (state: unknown): string => JSON.stringify({ state, questions: QUESTIONS });
const BODY = bodyOf("explain this");

/** The parent environment without a token, so each test sets its own. */
function baseEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, PYTHONPATH: FAKE_LAYA };
  delete env["LAYA_SERVER_TOKEN"];
  return env;
}

function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    if (address === null || typeof address === "string") {
      reject(new Error("no TCP address"));
      return;
    }
    probe.close(() => resolve(address.port));
  });
  return promise;
}

interface Server {
  child: ChildProcess;
  port: number;
  out(): string;
  log(): string;
}

/** `closeStderr` starts the server with fd 2 closed. */
async function start(
  port: number,
  env: Record<string, string | undefined>,
  args: string[] = [],
  closeStderr = false,
): Promise<Server> {
  const argv = [SERVER, "--repo", "fake/repo", "--port", String(port), ...args];
  const child = closeStderr
    ? spawn("sh", ["-c", 'exec "$0" "$@" 2>&-', PYTHON, ...argv], { env, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(PYTHON, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
  const ready = Promise.withResolvers<void>();
  let output = "";
  let log = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    output += chunk;
    if (output.includes("ready on")) ready.resolve();
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    log += chunk;
  });
  child.on("exit", (code) => ready.reject(new Error(`server exited (${code}) before it was ready`)));
  await ready.promise;
  return { child, port, out: () => output, log: () => log };
}

const probe = spawnSync(PYTHON, ["--version"], { encoding: "utf8" });

if (probe.error || probe.status !== 0) {
  test("laya http server suite", { skip: `${PYTHON} is unavailable` }, () => {});
} else {
  test("POST /predicts through the classifier and answers with its result", async (t) => {
    const port = await freePort();
    const { child } = await start(port, baseEnv());
    t.after(() => child.kill());

    const response = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: BODY });
    assert.equal(response.status, 200);
    const reply = (await response.json()) as { answers?: Record<string, unknown> };
    assert.equal(reply.answers?.["state"], "explain this");
  });

  test("with LAYA_SERVER_TOKEN set, a POST without the bearer token is 401", async (t) => {
    const port = await freePort();
    const { child } = await start(port, { ...baseEnv(), LAYA_SERVER_TOKEN: "s3cret" });
    t.after(() => child.kill());

    const url = `http://127.0.0.1:${port}/`;
    const anonymous = await fetch(url, { method: "POST", body: BODY });
    assert.equal(anonymous.status, 401);

    const wrong = await fetch(url, { method: "POST", headers: { Authorization: "Bearer nope" }, body: BODY });
    assert.equal(wrong.status, 401);

    const authorized = await fetch(url, { method: "POST", headers: { Authorization: "Bearer s3cret" }, body: BODY });
    assert.equal(authorized.status, 200);
  });

  test("a body over 1 MiB is refused with 413 before it is read", async (t) => {
    const port = await freePort();
    const { child } = await start(port, baseEnv());
    t.after(() => child.kill());

    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const request = http.request(
      { host: "127.0.0.1", port, method: "POST", headers: { "Content-Length": String(1_048_577) } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end();
    const status = await promise;
    assert.equal(status, 413);
  });

  test("a non-loopback host is refused without --allow-remote", () => {
    const result = spawnSync(PYTHON, [SERVER, "--repo", "fake/repo", "--host", "0.0.0.0"], {
      env: baseEnv(),
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /refusing non-loopback --host without --allow-remote/);
  });

  test("--allow-remote requires a token", () => {
    const result = spawnSync(PYTHON, [SERVER, "--repo", "fake/repo", "--host", "0.0.0.0", "--allow-remote"], {
      env: baseEnv(),
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--allow-remote requires LAYA_SERVER_TOKEN/);
  });

  interface Reply {
    status: number;
    headers: Record<string, string>;
    text: string;
  }

  type Line = Record<string, unknown>;

  async function started(
    t: TestContext,
    env: Record<string, string | undefined> = baseEnv(),
    args: string[] = [],
    closeStderr = false,
  ): Promise<Server> {
    const server = await start(await freePort(), env, args, closeStderr);
    t.after(() => server.child.kill());
    return server;
  }

  /** Waits for stderr to close, so `log()` is complete afterwards. */
  async function stop(server: Server): Promise<void> {
    server.child.kill();
    await once(server.child, "close");
  }

  function requestText(body: string, extra: string[], length: number | string): string {
    return ["POST / HTTP/1.1", "Host: x", `Content-Length: ${length}`, ...extra, "", body].join("\r\n");
  }

  /** Resolves when the server closes the socket, which happens after its handler and telemetry line finished. */
  function rawPost(
    port: number,
    body: string,
    extra: string[] = [],
    length: number | string = Buffer.byteLength(body),
  ): Promise<Reply> {
    const { promise, resolve, reject } = Promise.withResolvers<Reply>();
    const chunks: Buffer[] = [];
    const socket = net.connect(port, "127.0.0.1", () => socket.write(requestText(body, extra, length)));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const [head = "", ...rest] = Buffer.concat(chunks).toString("utf8").split("\r\n\r\n");
      const [statusLine = "", ...fields] = head.split("\r\n");
      const headers: Record<string, string> = {};
      for (const field of fields)
        headers[field.slice(0, field.indexOf(":")).toLowerCase()] = field.slice(field.indexOf(":") + 1).trim();
      resolve({ status: Number(statusLine.split(" ")[1]), headers, text: rest.join("\r\n\r\n") });
    });
    return promise;
  }

  /** Disconnects `afterMs` later (RST or FIN), in real time, so the server is inside inference. */
  async function abandon(port: number, body: string, extra: string[], afterMs: number, how: "reset" | "close") {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(requestText(body, extra, Buffer.byteLength(body)));
      setTimeout(() => {
        if (how === "reset") socket.resetAndDestroy();
        else socket.destroy();
        resolve();
      }, afterMs);
    });
    socket.on("error", reject);
    await promise;
  }

  function answers(reply: Reply): Record<string, unknown> {
    const parsed = JSON.parse(reply.text) as { answers: Record<string, unknown> };
    return parsed.answers;
  }

  function lines(server: Server): Line[] {
    return server
      .log()
      .split("\n")
      .flatMap((text) => {
        try {
          const data = JSON.parse(text) as Line;
          return data["type"] === "loadout.http" ? [data] : [];
        } catch {
          return [];
        }
      });
  }

  /** A disconnect is only noticed after inference, so the line may not exist yet. */
  async function lineFor(server: Server, requestId: string, timeoutMs = 5000): Promise<Line> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const found = lines(server).find((line) => line["requestId"] === requestId);
      if (found) return found;
      if (performance.now() > deadline) assert.fail(`no loadout.http line for ${requestId}`);
      await sleep(20);
    }
  }

  const num = (value: unknown): number => {
    assert.equal(typeof value, "number", `expected a number, got ${String(value)}`);
    return value as number;
  };

  function layaOver(port: number, timeoutMs = 2000) {
    return createLayaHttpClassifier(
      {
        ...defaultConfig().laya,
        transport: "http",
        endpoint: `http://127.0.0.1:${port}/`,
        apiKeyEnvVar: "",
        timeoutMs,
      },
      { env: {} },
    );
  }

  test("a request id ties the client call to one server line with queue, inference and total in ms", async (t) => {
    const server = await started(t);
    const id = randomUUID();
    const result = await layaOver(server.port).classify("explain this", QUESTIONS, { requestId: id });

    const line = await lineFor(server, id);
    assert.deepEqual(normalizeHttp(line), line, "the line is a valid loadout.http v1 record, field for field");
    assert.deepEqual(
      [line["idStatus"], line["outcome"], line["status"], line["errorClass"]],
      ["valid", "ok", 200, null],
    );
    const [queueMs, inferenceMs, totalMs] = [num(line["queueMs"]), num(line["inferenceMs"]), num(line["totalMs"])];
    assert.ok(totalMs >= queueMs + inferenceMs, "total covers the queue wait and the inference");
    assert.deepEqual(result.timing, { queueMs, inferenceMs });
    assert.equal(lines(server).length, 1);
  });

  test("lock contention: the waiting request's delay is queue time, and predictions keep their order", async (t) => {
    const server = await started(t);
    const [first, second] = [randomUUID(), randomUUID()];
    const slow = rawPost(server.port, bodyOf({ sleep_ms: 1200 }), [`X-Request-Id: ${first}`]);
    // Real time on purpose: the second request must arrive while the first still holds the server's lock.
    await sleep(300);
    const quick = rawPost(server.port, bodyOf({ sleep_ms: 0 }), [`X-Request-Id: ${second}`]);
    const replies = await Promise.all([slow, quick]);

    assert.deepEqual(
      replies.map((reply) => answers(reply)["calls"]),
      [1, 2],
      "the request that arrived first is predicted first",
    );
    const [a, b] = [await lineFor(server, first), await lineFor(server, second)];
    assert.ok(num(a["queueMs"]) < 100 && num(a["inferenceMs"]) >= 1100, "the first request computes without waiting");
    assert.ok(
      num(b["queueMs"]) >= 600 && num(b["inferenceMs"]) < 300,
      "the second request waits, then computes briefly",
    );
    assert.ok(num(b["totalMs"]) >= num(b["queueMs"]));
  });

  test("a client that resets the connection mid-inference leaves a client-gone line with its phases", async (t) => {
    const server = await started(t);
    const id = randomUUID();
    await abandon(server.port, bodyOf({ sleep_ms: 500 }), [`X-Request-Id: ${id}`], 150, "reset");

    const line = await lineFor(server, id);
    assert.equal(line["outcome"], "client-gone");
    assert.match(String(line["errorClass"]), /^(ConnectionResetError|BrokenPipeError|ConnectionAbortedError)$/);
    assert.equal(line["status"], 200, "the status the server chose to send");
    assert.ok(num(line["queueMs"]) < 100 && num(line["inferenceMs"]) >= 400, "inference ran to the end first");
    assert.deepEqual(normalizeHttp(line), line);
  });

  test("a client that times out still has a correlated server line, and learns no phases", async (t) => {
    const server = await started(t);
    const id = randomUUID();
    const error = await layaOver(server.port, 150)
      .classify({ sleep_ms: 500 }, QUESTIONS, { requestId: id })
      .then(
        () => assert.fail("expected a timeout"),
        (caught: unknown) => caught,
      );
    assert.ok(error instanceof ClassifierError && error.code === "timeout");
    assert.deepEqual([error.status, error.timing], [undefined, undefined], "unknown, not zero");

    const line = await lineFor(server, id);
    // A peer that closed cleanly may still accept the write: only the line's existence and phases are certain.
    assert.ok(line["outcome"] === "ok" || line["outcome"] === "client-gone");
    assert.ok(num(line["inferenceMs"]) >= 400, "the server finished the work the client had abandoned");
  });

  test("a per-request opt-out writes no line and sends no timing", async (t) => {
    const server = await started(t);
    const id = randomUUID();
    const cases: Array<{ extra: string[]; recorded: boolean }> = [
      { extra: [], recorded: true },
      { extra: ["X-Loadout-Telemetry: on"], recorded: true },
      { extra: ["X-Loadout-Telemetry: off"], recorded: false },
      { extra: ["X-Loadout-Telemetry: OFF"], recorded: false },
      { extra: ["X-Loadout-Telemetry:   off  "], recorded: false },
      { extra: ["X-Loadout-Telemetry: banana"], recorded: false },
      { extra: ["X-Loadout-Telemetry:"], recorded: false },
      { extra: ["X-Loadout-Telemetry: on", "X-Loadout-Telemetry: off"], recorded: false },
      { extra: [`X-Request-Id: ${id}`, "X-Loadout-Telemetry: off"], recorded: false },
    ];
    const replies: Reply[] = [];
    for (const { extra } of cases) replies.push(await rawPost(server.port, BODY, extra));
    await stop(server);

    cases.forEach(({ extra, recorded }, index) => {
      const reply = replies[index] as Reply;
      const label = extra.join(" | ") || "(no header)";
      assert.equal(reply.status, 200, label);
      assert.equal(answers(reply)["state"], "explain this", label);
      assert.equal("server-timing" in reply.headers, recorded, label);
    });
    assert.equal(lines(server).length, cases.filter((entry) => entry.recorded).length);
    assert.equal(server.log().includes(id), false, "an opted-out request id is not logged");
  });

  test("--no-telemetry writes no line and sends no timing for any request", async (t) => {
    const server = await started(t, baseEnv(), ["--no-telemetry"]);
    const replies: Reply[] = [];
    for (const extra of [[], [`X-Request-Id: ${randomUUID()}`], ["X-Loadout-Telemetry: on"]]) {
      replies.push(await rawPost(server.port, BODY, extra));
    }
    await stop(server);

    for (const reply of replies) {
      assert.equal(reply.status, 200);
      assert.equal(answers(reply)["state"], "explain this");
      assert.equal("server-timing" in reply.headers, false);
    }
    assert.deepEqual(lines(server), []);
  });

  test("an untrusted request id is logged as invalid and never copied", async (t) => {
    const server = await started(t);
    const valid = "6f1c2a9e-3b4d-4c5e-8f60-7a8b9c0d1e2f";
    const table: Array<{ extra: string[]; requestId: string | null; idStatus: string }> = [
      { extra: [], requestId: null, idStatus: "absent" },
      { extra: [`X-Request-Id: ${valid}`], requestId: valid, idStatus: "valid" },
      { extra: [`X-Request-Id:    ${valid}   `], requestId: valid, idStatus: "valid" },
      { extra: ["X-Request-Id: CANARY-ID-SECRET"], requestId: null, idStatus: "invalid" },
      { extra: [`X-Request-Id: ${valid.toUpperCase()}`], requestId: null, idStatus: "invalid" },
      { extra: [`X-Request-Id: ${valid.slice(0, 14)}1${valid.slice(15)}`], requestId: null, idStatus: "invalid" }, // a UUIDv1
      { extra: [`X-Request-Id: ${valid}x`], requestId: null, idStatus: "invalid" },
      { extra: [`X-Request-Id: ${"a".repeat(300)}`], requestId: null, idStatus: "invalid" },
      { extra: ["X-Request-Id:"], requestId: null, idStatus: "invalid" },
      { extra: [`X-Request-Id: ${valid}`, `X-Request-Id: ${randomUUID()}`], requestId: null, idStatus: "invalid" },
    ];
    for (const { extra } of table) assert.equal((await rawPost(server.port, BODY, extra)).status, 200);
    await stop(server);

    assert.deepEqual(
      lines(server).map((line) => [line["requestId"], line["idStatus"]]),
      table.map((entry) => [entry.requestId, entry.idStatus]),
    );
    assert.equal(server.log().includes("CANARY-ID-SECRET"), false);
  });

  test("synthetic secrets in headers, body, answers and errors never reach the log", async (t) => {
    const server = await started(t, { ...baseEnv(), LAYA_SERVER_TOKEN: "tok-CANARY-SERVER" });
    const secrets = [
      "CANARY-SERVER",
      "CANARY-PRESENTED",
      "CANARY-PROMPT",
      "CANARY-HEADER",
      "CANARY-COOKIE",
      "CANARY-LENGTH",
    ];
    const noise = ["X-Canary: CANARY-HEADER", "Cookie: sid=CANARY-COOKIE"];
    const bearer = "Authorization: Bearer tok-CANARY-SERVER";

    const rejected = await rawPost(server.port, BODY, ["Authorization: Bearer CANARY-PRESENTED", ...noise]);
    assert.equal(rejected.status, 401);
    const answered = await rawPost(server.port, bodyOf("CANARY-PROMPT"), [bearer, ...noise]);
    assert.equal(answered.status, 200);
    assert.ok(answered.text.includes("CANARY-PROMPT"), "the answer carries the prompt back, so the log must not");
    const broken = await rawPost(server.port, BODY, [bearer, ...noise], "CANARY-LENGTH");
    assert.equal(broken.status, 500);
    assert.ok(broken.text.includes("CANARY-LENGTH"), "the 500 body echoes the exception text, so the log must not");
    await stop(server);

    assert.equal(lines(server).length, 3);
    for (const secret of secrets) assert.equal(server.log().includes(secret), false, secret);
    for (const line of lines(server)) assert.deepEqual(normalizeHttp(line), line);
  });

  test("rejections and early failures report unknown phases, not zero", async (t) => {
    const server = await started(t, { ...baseEnv(), LAYA_SERVER_TOKEN: "s3cret" });
    const auth = "Authorization: Bearer s3cret";
    const replies = [
      await rawPost(server.port, BODY),
      await rawPost(server.port, "", [auth], 1_048_577),
      await rawPost(server.port, "{not json", [auth]),
    ];
    await stop(server);

    assert.deepEqual(
      replies.map((reply) => reply.status),
      [401, 413, 500],
    );
    for (const reply of replies)
      assert.equal("server-timing" in reply.headers, false, "no phase ran, so none is reported");
    assert.deepEqual(
      lines(server).map((line) => [line["outcome"], line["status"], line["errorClass"]]),
      [
        ["rejected", 401, null],
        ["rejected", 413, null],
        ["error", 500, "JSONDecodeError"],
      ],
    );
    for (const line of lines(server)) {
      assert.deepEqual([line["queueMs"], line["inferenceMs"], line["idStatus"]], [null, null, "absent"]);
      assert.ok(num(line["totalMs"]) >= 0);
    }
  });

  test("a failed inference reports the phases it measured, and the client sees them with the status", async (t) => {
    const server = await started(t);
    const id = randomUUID();
    const error = await layaOver(server.port)
      .classify({ sleep_ms: -1 }, QUESTIONS, { requestId: id })
      .then(
        () => assert.fail("expected a failure"),
        (caught: unknown) => caught,
      );
    assert.ok(error instanceof ClassifierError && error.code === "unavailable");
    assert.equal(error.status, 500);

    const line = await lineFor(server, id);
    assert.deepEqual([line["outcome"], line["status"], line["errorClass"]], ["error", 500, "ValueError"]);
    assert.deepEqual(error.timing, { queueMs: num(line["queueMs"]), inferenceMs: num(line["inferenceMs"]) });
  });

  test("an unwritable log stream never fails a request nor adds error output", async (t) => {
    // With fd 2 closed the server's stderr is None and writing the line raises; an exception escaping the handler would reach stdout.
    const server = await started(t, baseEnv(), [], true);
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await rawPost(server.port, BODY, [`X-Request-Id: ${randomUUID()}`]);
      assert.equal(reply.status, 200);
      assert.equal(answers(reply)["state"], "explain this");
    }
    await stop(server);
    assert.equal(server.out(), `laya_http_server: ready on http://127.0.0.1:${server.port}\n`);
  });
}

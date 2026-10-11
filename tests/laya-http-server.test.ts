/**
 * The real python/laya_http_server.py, run against the fake `laya` module so no
 * torch or checkpoints are needed. Covers the predict round trip, the bearer
 * token gate, the body-size cap, and the refusal to bind a non-loopback host.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(TEST_DIR, "..", "python", "laya_http_server.py");
const FAKE_LAYA = path.join(TEST_DIR, "fixtures", "fake_laya");
const PYTHON = "python3";
const BODY = JSON.stringify({
  state: "explain this",
  questions: { t: { type: "choice", instructions: "x", criteria: { a: "a", b: "b" } } },
});

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

/** Start the server and resolve once it logs that it is listening. */
async function start(port: number, env: Record<string, string | undefined>): Promise<ChildProcess> {
  const child = spawn(PYTHON, [SERVER, "--repo", "fake/repo", "--port", String(port)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ready = Promise.withResolvers<void>();
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    output += chunk;
    if (output.includes("ready on")) ready.resolve();
  });
  child.stderr?.resume();
  child.on("exit", (code) => ready.reject(new Error(`server exited (${code}) before it was ready`)));
  await ready.promise;
  return child;
}

const probe = spawnSync(PYTHON, ["--version"], { encoding: "utf8" });

if (probe.error || probe.status !== 0) {
  test("laya http server suite", { skip: `${PYTHON} is unavailable` }, () => {});
} else {
  test("POST /predicts through the classifier and answers with its result", async (t) => {
    const port = await freePort();
    const child = await start(port, baseEnv());
    t.after(() => child.kill());

    const response = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: BODY });
    assert.equal(response.status, 200);
    const reply = (await response.json()) as { answers?: Record<string, unknown> };
    assert.equal(reply.answers?.["state"], "explain this");
  });

  test("with LAYA_SERVER_TOKEN set, a POST without the bearer token is 401", async (t) => {
    const port = await freePort();
    const child = await start(port, { ...baseEnv(), LAYA_SERVER_TOKEN: "s3cret" });
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
    const child = await start(port, baseEnv());
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
}

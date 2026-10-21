/**
 * `/loadout status`, `explain` and `stats` inside a real in-process pi session. Commands go through pi's own command
 * path (`session.prompt`); the model is pi's faux provider and the classifier is a stub System-One server on an
 * ephemeral port. No network, no credentials.
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { findPackageJSON } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import loadout from "../src/index.ts";
import { buildSummary } from "../src/report/report.ts";
import { NO_FILTERS } from "../src/report/scope.ts";

// Resolved at runtime and loaded from pi's location: a static import would resolve from this file, which can load
// another pi-ai than pi's (npm nests it under pi's shrinkwrap, Bun hoists it).
const piAiJson = findPackageJSON("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent"));
if (piAiJson === undefined) throw new Error("@earendil-works/pi-ai not found next to @earendil-works/pi-coding-agent");
const piAiEntry = path.join(path.dirname(piAiJson), JSON.parse(fs.readFileSync(piAiJson, "utf8")).exports["."].import);
const { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } = await import(
  pathToFileURL(piAiEntry).href
);

const TOKEN_VAR = "LOADOUT_COMMANDS_PI_TOKEN";
/** The stub's answer to the tool-profile question: the read-only profile, with high confidence. */
const TOOL_PROFILE = { type: "choice", choice: "answer", probabilities: { answer: 0.9 }, confidence: 0.9 };
const COMMANDS = [
  ["/loadout status", "[loadout] status"],
  ["/loadout explain", "[loadout] explain"],
  ["/loadout stats", "[loadout] stats"],
] as const;

interface Notice {
  message: string;
  type: "info" | "warning" | "error";
}

let server: http.Server;
let endpoint = "";
let classifierCalls = 0;
let home = "";
let savedEnv: Record<string, string | undefined> = {};

before(async () => {
  savedEnv = {
    HOME: process.env.HOME,
    LOADOUT_CONFIG: process.env.LOADOUT_CONFIG,
    [TOKEN_VAR]: process.env[TOKEN_VAR],
  };
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      classifierCalls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answers: { tool_profile: TOOL_PROFILE } }));
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "loadout-commands-pi-home-"));
  fs.mkdirSync(path.join(home, ".omp"));
  process.env.HOME = home;
  delete process.env.LOADOUT_CONFIG;
  process.env[TOKEN_VAR] = "test-token";
});

after(() => {
  server.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

/** A file-backed pi session with the plugin loaded; its notifications are collected from the UI context. */
async function piSession() {
  fs.writeFileSync(
    path.join(home, ".omp", "loadout.json"),
    JSON.stringify({ backend: "jev", jev: { endpoint, apiKeyEnvVar: TOKEN_VAR }, skills: { enabled: false } }),
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loadout-commands-pi-"));
  const cwd = path.join(root, "cwd");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(root, "sessions");
  for (const dir of [cwd, agentDir, sessionDir]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(cwd, "notes.txt"), "synthetic notes\n");
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  // In-memory stores: pi's file-backed ones write auth.json and models-store.json after the session is disposed.
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [loadout] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: faux.getModel(),
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.create(cwd, sessionDir),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 },
    }),
    tools: ["read"],
  });
  const notices: Notice[] = [];
  // Only `notify` is supplied; the cast is needed because `ExtensionUIContext` has many more required members.
  await session.bindExtensions({
    uiContext: {
      notify: (message: string, type: Notice["type"] = "info") => {
        notices.push({ message, type });
      },
    } as never,
  });
  return {
    session,
    faux,
    notices,
    dispose: () => {
      session.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The one notification a step produced; any other count fails the test. */
function single(notices: Notice[]): Notice {
  assert.equal(notices.length, 1, `expected one notification, got ${JSON.stringify(notices)}`);
  return notices[0]!;
}

test("real pi session: status, explain and stats work through pi's own command path", { timeout: 60000 }, async () => {
  const { session, faux, notices, dispose } = await piSession();
  try {
    // Runs one line through pi's prompt path and returns the notifications it added.
    const said = async (line: string): Promise<Notice[]> => {
      const start = notices.length;
      await session.prompt(line);
      return notices.slice(start);
    };

    // Before the first reply there is no session file, and `stats` says so in one notification.
    const early = single(await said("/loadout stats"));
    assert.match(early.message, /no session file yet/);
    assert.equal(early.type, "info");
    assert.equal(classifierCalls, 0);

    // One normal prompt: the per-turn notice is one info line, and the first reply writes the session file.
    faux.setResponses([fauxAssistantMessage("DONE")]);
    const turn = single(await said("Reply DONE."));
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.equal(classifierCalls, 1);
    assert.equal(turn.type, "info");
    assert.match(turn.message, /^\[loadout\] /);
    assert.ok(!turn.message.includes("\n"), "the per-turn notice is one line");
    const sessionFile = session.sessionManager.getSessionFile()!;
    assert.ok(fs.existsSync(sessionFile), "the first reply writes the session file");

    // Each command adds exactly one notification, and its first line starts with the command's title.
    for (const [line, title] of COMMANDS) {
      const notice = single(await said(line));
      assert.ok(notice.message.split("\n")[0]?.startsWith(title), `${line}: ${notice.message}`);
      assert.equal(notice.type, "info", line);
    }
    assert.equal(classifierCalls, 1, "commands make no classifier call");

    // The JSON view is the report library's summary of the same session file.
    const json = single(await said("/loadout stats --json"));
    assert.equal(json.type, "info");
    const expected = buildSummary({
      scope: { kind: "session", files: [sessionFile] },
      filters: NO_FILTERS,
      serviceLogs: [],
    });
    assert.deepEqual(JSON.parse(json.message), expected);
  } finally {
    dispose();
  }
});

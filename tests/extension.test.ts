/**
 * End-to-end: the extension against a fake host (pi-shaped or omp-shaped) and
 * a stub System-One server standing in for Jev.
 */

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import loadout from "../src/index.ts";
import type { Answers } from "../src/types.ts";

const TOKEN_VAR = "LOADOUT_TEST_TOKEN";
const BASELINE = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const SKILLS = [
  { name: "pdf", description: "read and write PDF files" },
  { name: "deploy", description: "deploy the app" },
];

let server: http.Server;
let reply: { status: number; answers: Answers } = { status: 200, answers: {} };
const requests: Array<{ questions: Record<string, unknown> }> = [];
let home: string;
let project: string;
let sessionCounter = 0;

function writeConfig(config: Record<string, unknown>): void {
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
  const file = path.join(home, ".omp", "loadout.json");
  fs.writeFileSync(file, JSON.stringify({ ...config, jev: { endpoint, apiKeyEnvVar: TOKEN_VAR } }));
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ answers: reply.answers }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loadout-ext-"));
  home = path.join(root, "home");
  project = path.join(root, "project");
  fs.mkdirSync(path.join(home, ".omp"), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  process.env.HOME = home;
  process.env[TOKEN_VAR] = "test-token";
});

after(() => server.close());

beforeEach(() => {
  requests.length = 0;
  reply = {
    status: 200,
    answers: {
      tool_profile: { type: "choice", choice: "answer", probabilities: { answer: 0.9 }, confidence: 0.9 },
      "skill:pdf": { type: "noul", noul: 0.8, confidence: 0.6 },
      "skill:deploy": { type: "noul", noul: 0.1, confidence: 0.8 },
    },
  };
  writeConfig({});
});

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakeHost(kind: "pi" | "omp") {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const entries: Array<{ type: string; data: unknown }> = [];
  const notes: string[] = [];
  let active = [...BASELINE];
  const sessionId = `session-${++sessionCounter}`;

  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, options),
    getActiveTools: () => [...active],
    setActiveTools: (tools: string[]) => {
      active = [...tools];
      return kind === "omp" ? Promise.resolve() : undefined;
    },
    getCommands: () =>
      SKILLS.map((skill) => ({ name: `skill:${skill.name}`, description: skill.description, source: "skill" })),
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
  };
  const ctx = {
    cwd: project,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: (message: string) => notes.push(message) },
  };
  loadout(pi as never);

  return {
    entries,
    notes,
    active: () => active,
    setActive: (tools: string[]) => {
      active = [...tools];
    },
    async prompt(text: string) {
      const event: { prompt: string; systemPromptOptions?: { skills: typeof SKILLS } } = { prompt: text };
      if (kind === "pi") event.systemPromptOptions = { skills: [...SKILLS] };
      const result = await handlers.get("before_agent_start")!(event, ctx);
      return { event, result: result as { message?: { content: string } } | undefined };
    },
    command: (args: string) => commands.get("loadout")!.handler(args, ctx),
    shutdown: () => handlers.get("session_shutdown")!({}, ctx),
  };
}

test("pi: narrows tools and filters skills out of the prompt", async () => {
  const host = fakeHost("pi");
  const { event, result } = await host.prompt("what does parseConfig return?");

  assert.deepEqual(host.active(), ["read", "grep", "find", "ls"]);
  assert.deepEqual(
    event.systemPromptOptions?.skills.map((s) => s.name),
    ["pdf"],
  );
  assert.equal(result, undefined);
  assert.equal(host.entries[0]?.type, "loadout.decision");
  assert.deepEqual(Object.keys(requests[0]!.questions), ["tool_profile", "skill:pdf", "skill:deploy"]);
  host.shutdown();
});

test("omp: narrows tools and hints skills with a message", async () => {
  const host = fakeHost("omp");
  const { result } = await host.prompt("convert report.pdf to text");

  assert.deepEqual(host.active(), ["read", "grep", "find", "ls"]);
  assert.match(result?.message?.content ?? "", /- pdf/);
  assert.doesNotMatch(result?.message?.content ?? "", /deploy/);
  host.shutdown();
});

test("slash commands are not classified and restore the baseline", async () => {
  const host = fakeHost("pi");
  await host.prompt("explain this");
  assert.notDeepEqual(host.active(), BASELINE);

  await host.prompt("/review");
  assert.deepEqual(host.active(), BASELINE);
  assert.equal(requests.length, 1);
  host.shutdown();
});

test("a classifier failure keeps the full loadout and never throws", async () => {
  const host = fakeHost("pi");
  await host.prompt("explain this");
  reply = { status: 500, answers: {} };

  const { event } = await host.prompt("now fix it");
  assert.deepEqual(host.active(), BASELINE);
  assert.equal(event.systemPromptOptions?.skills.length, SKILLS.length);
  assert.match(host.notes.join("\n"), /classification failed \(unavailable\)/);
  host.shutdown();
});

test("a tool change made by the user becomes the new baseline", async () => {
  const host = fakeHost("pi");
  await host.prompt("explain this");
  host.setActive(["read", "bash"]);

  reply.answers.tool_profile = { type: "choice", choice: "full", probabilities: { full: 0.9 }, confidence: 0.9 };
  await host.prompt("run the tests");
  assert.deepEqual(host.active(), ["read", "bash"]);
  host.shutdown();
});

test("dry run records the decision but changes nothing", async () => {
  writeConfig({ dryRun: true });
  const host = fakeHost("pi");
  const { event } = await host.prompt("explain this");

  assert.deepEqual(host.active(), BASELINE);
  assert.equal(event.systemPromptOptions?.skills.length, SKILLS.length);
  assert.equal(host.entries.length, 1);
  host.shutdown();
});

test("/loadout off restores the baseline and stops classifying", async () => {
  const host = fakeHost("pi");
  await host.prompt("explain this");
  await host.command("off");
  assert.deepEqual(host.active(), BASELINE);

  await host.prompt("explain that");
  assert.equal(requests.length, 1);
  host.shutdown();
});

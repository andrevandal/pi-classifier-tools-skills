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

import { defaultConfig } from "../src/config.ts";
import loadout from "../src/index.ts";
import { buildExport, buildSummary, parseArgv, type ReportSpec } from "../src/report/report.ts";
import { type DecisionRecordV3, ID_PATTERN, normalizeDecision, type UsageObservationV1 } from "../src/telemetry.ts";
import type { Answers } from "../src/types.ts";
import {
  CANARY,
  INVENTED_TOOL_NAMES,
  ompTurnEnd,
  piTurnEnd,
  toolResult,
  type TurnSpec,
} from "./fixtures/usage-events.ts";

const TOKEN_VAR = "LOADOUT_TEST_TOKEN";
const BASELINE = ["read", "bash", "edit", "write", "grep", "find", "ls"];
/** Every tool the fake host has registered: the active baseline and one that is registered but not active. */
const REGISTRY = [...BASELINE, "task"];
const SKILLS = [
  { name: "pdf", description: "read and write PDF files" },
  { name: "deploy", description: "deploy the app" },
];

let server: http.Server;
let reply: { status: number; answers: Answers; body?: string; extra?: Record<string, unknown>; delayMs?: number } = {
  status: 200,
  answers: {},
};
const requests: Array<{ questions: Record<string, unknown> }> = [];
let home: string;
let project: string;
let sessionCounter = 0;

const ANSWER_SET = ["read", "grep", "find", "ls"];
const GLOBAL_FILE = () => path.join(home, ".omp", "loadout.json");

function endpointConfig(query = ""): Record<string, unknown> {
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone${query}`;
  return { backend: "jev", jev: { endpoint, apiKeyEnvVar: TOKEN_VAR } };
}

function writeConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(GLOBAL_FILE(), JSON.stringify({ skills: { enabled: true }, ...config, ...endpointConfig() }));
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const current = reply;
      const respond = () => {
        res.writeHead(current.status, { "Content-Type": "application/json" });
        res.end(current.body ?? JSON.stringify({ ...current.extra, answers: current.answers }));
      };
      // Only the timeout test sets a delay. The Jev client times out on a real socket timer that fake timers cannot
      // drive, so the stub must answer late in real time.
      if (current.delayMs === undefined) respond();
      else setTimeout(respond, current.delayMs);
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
  delete process.env.LOADOUT_CONFIG;
  fs.rmSync(path.join(project, ".omp"), { recursive: true, force: true });
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

interface HostOptions {
  skills?: typeof SKILLS;
  /** The host's session file: `sessionManager.getSessionFile` returns it, and `appendEntry` also writes to it. */
  sessionFile?: string;
  sessionIdThrows?: boolean;
  getAllToolsThrows?: boolean;
  /** Called before each append; returning an error makes it throw without storing the entry. */
  onAppend?: (call: number) => Error | undefined;
  /** Called before each setActiveTools; `mutate` applies the tools first, then the call fails. */
  onSet?: (call: number) => { error: Error; mutate: boolean } | undefined;
}

function fakeHost(kind: "pi" | "omp", options: HostOptions = {}) {
  const skills = options.skills ?? SKILLS;
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const entries: Array<{ type: string; data: unknown }> = [];
  const notes: string[] = [];
  const notices: Array<{ message: string; level: string; callsBefore: number }> = [];
  const calls: string[] = [];
  let active = [...BASELINE];
  let setCalls = 0;
  let appendCalls = 0;
  let appendFault: HostOptions["onAppend"] | null = options.onAppend ?? null;
  const sessionId = `session-${++sessionCounter}`;
  // What the host writes to its session file: a header before the first entry, then one custom entry per append.
  let fileEntries = 0;
  let lastFileId: string | null = null;
  const writeEntry = (file: string, customType: string, data: unknown) => {
    if (!fs.existsSync(file)) {
      const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: ctx.cwd };
      fs.writeFileSync(file, `${JSON.stringify(header)}\n`);
    }
    const id = `e${fileEntries++}`;
    const entry = { type: "custom", customType, data, id, parentId: lastFileId, timestamp: new Date().toISOString() };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    lastFileId = id;
  };

  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, command),
    getActiveTools: () => [...active],
    getAllTools: () => {
      if (options.getAllToolsThrows) throw new Error("tool registry not ready");
      return REGISTRY.map((name) => ({ name, description: `the ${name} tool` }));
    },
    setActiveTools: (tools: string[]) => {
      calls.push("set");
      const fault = options.onSet?.(++setCalls);
      if (fault) {
        if (fault.mutate) active = [...tools];
        if (kind === "omp") return Promise.reject(fault.error);
        throw fault.error;
      }
      active = [...tools];
      return kind === "omp" ? Promise.resolve() : undefined;
    },
    getCommands: () =>
      skills.map((skill) => ({ name: `skill:${skill.name}`, description: skill.description, source: "skill" })),
    appendEntry: (type: string, data: unknown) => {
      const fault = appendFault?.(++appendCalls);
      if (fault) throw fault;
      calls.push("append");
      entries.push({ type, data });
      if (options.sessionFile !== undefined) writeEntry(options.sessionFile, type, data);
    },
  };
  const ctx = {
    cwd: project,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => {
        if (options.sessionIdThrows) throw new Error("no session");
        return sessionId;
      },
      ...(options.sessionFile === undefined ? {} : { getSessionFile: () => options.sessionFile }),
    },
    ui: {
      notify: (message: string, level: string) => {
        notes.push(message);
        notices.push({ message, level, callsBefore: calls.length });
      },
    },
  };
  loadout(pi as never);

  return {
    entries,
    notes,
    notices,
    calls,
    sessionId,
    active: () => active,
    setActive: (tools: string[]) => {
      active = [...tools];
    },
    setAppendFault: (fault: HostOptions["onAppend"] | null) => {
      appendFault = fault;
    },
    async prompt(text: string) {
      const event: { prompt: string; systemPromptOptions?: { skills: typeof SKILLS } } = { prompt: text };
      if (kind === "pi") event.systemPromptOptions = { skills: [...skills] };
      const result = await handlers.get("before_agent_start")!(event, ctx);
      return { event, result: result as { message?: { content: string } } | undefined };
    },
    command: (args: string) => commands.get("loadout")!.handler(args, ctx),
    shutdown: () => handlers.get("session_shutdown")!({}, ctx),
    compact: () => handlers.get("session_compact")!({}, ctx),
    fire: (name: string, event?: unknown) => handlers.get(name)?.(event, ctx),
    /** Move the host's working directory: the next hook reloads this session's config. */
    setCwd: (dir: string) => {
      ctx.cwd = dir;
    },
  };
}

const record = (host: { entries: Array<{ data: unknown }> }, i = host.entries.length - 1) =>
  host.entries[i]!.data as DecisionRecordV3;
const sorted = (list: readonly string[] | null | undefined) => [...(list ?? [])].sort();
const setCount = (host: { calls: string[] }) => host.calls.filter((call) => call === "set").length;
const errorWith = (message: string, code: string) => Object.assign(new Error(message), { code });

type Host = ReturnType<typeof fakeHost>;
const usageOf = (host: Host) =>
  host.entries.filter((entry) => entry.type === "loadout.usage").map((entry) => entry.data as UsageObservationV1);
const decisionsOf = (host: Host) =>
  host.entries.filter((entry) => entry.type === "loadout.decision").map((entry) => entry.data as DecisionRecordV3);
const turn = (host: Host, kind: "pi" | "omp", spec?: TurnSpec) => {
  host.fire("turn_start", { type: "turn_start", turnIndex: spec?.turnIndex ?? 0 });
  return host.fire("turn_end", (kind === "pi" ? piTurnEnd : ompTurnEnd)(spec));
};
const userMessage = (host: Host) =>
  host.fire("message_start", {
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text: CANARY.text }], timestamp: 1_760_000_000_000 },
  });
const userTurn = (host: Host, kind: "pi" | "omp", spec?: TurnSpec) => {
  host.fire("turn_start", { type: "turn_start", turnIndex: spec?.turnIndex ?? 0 });
  userMessage(host);
  return host.fire("turn_end", (kind === "pi" ? piTurnEnd : ompTurnEnd)(spec));
};

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
  const view = normalizeDecision(host.entries[0]!.data);
  assert.ok(view);
  assert.equal(view.outcome, "classified");
  assert.equal(view.application?.status, "applied");
  assert.deepEqual(sorted(view.application?.actualTools), sorted(host.active()));
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
  assert.equal(record(host, 0).settings.dryRun, true);
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

test("a failure that repeats is reported once, and again after a recovery", async () => {
  const host = fakeHost("pi");
  reply = { status: 500, answers: {} };
  await host.prompt("one");
  await host.prompt("two");
  const failures = () => host.notes.filter((note) => note.includes("classification failed")).length;
  assert.equal(failures(), 1);

  reply = { status: 200, answers: {} };
  await host.prompt("three");
  reply = { status: 500, answers: {} };
  await host.prompt("four");
  assert.equal(failures(), 2);
  host.shutdown();
});

test("a failed classification is recorded as a decision with its failure", async () => {
  reply = { status: 500, answers: {} };
  const host = fakeHost("pi");
  await host.prompt("explain this");
  assert.equal(host.entries.length, 1);
  const failed = record(host, 0);
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.failure, "unavailable");
  assert.equal(failed.tools, null);
  assert.match(failed.classifier?.requestId ?? "", ID_PATTERN);
  assert.equal(failed.skills?.reason, null);
  assert.equal(failed.skills?.discovered, 2);
  assert.equal(failed.application.status, "not-attempted");
  host.shutdown();
});

test("an out-of-range timeout disables the plugin: it reports the error and classifies nothing", async () => {
  fs.writeFileSync(
    path.join(home, ".omp", "loadout.json"),
    JSON.stringify({ backend: "jev", jev: { timeoutMs: 30000 } }),
  );
  const host = fakeHost("pi");
  await host.prompt("explain this");
  assert.match(host.notes.join("\n"), /config error: .*jev\.timeoutMs/);
  assert.equal(requests.length, 0);
  assert.deepEqual(host.active(), BASELINE);
  host.shutdown();
});

test("once narrowed, tools only widen until compaction", async () => {
  const host = fakeHost("pi");
  await host.prompt("explain this");
  assert.deepEqual(host.active(), ["read", "grep", "find", "ls"]);

  reply.answers.tool_profile = { type: "choice", choice: "full", probabilities: { full: 0.9 }, confidence: 0.9 };
  await host.prompt("run the tests");
  assert.deepEqual(host.active(), BASELINE);

  reply.answers.tool_profile = { type: "choice", choice: "answer", probabilities: { answer: 0.9 }, confidence: 0.9 };
  await host.prompt("explain that");
  assert.deepEqual(host.active(), BASELINE);
  const blocked = record(host);
  assert.equal(blocked.application.status, "not-admitted");
  assert.equal(blocked.ratchet?.after, "full");

  await host.compact();
  await host.prompt("explain once more");
  assert.deepEqual(host.active(), ["read", "grep", "find", "ls"]);
  host.shutdown();
});

const answerReply = (probabilities: Record<string, number>, choice = "answer"): Answers["tool_profile"] => ({
  type: "choice",
  choice,
  probabilities,
  confidence: 0.9,
});

test("low confidence: every narrower profile's risk and the threshold are recorded while the tools stay unchanged", async () => {
  reply.answers.tool_profile = answerReply({ answer: 0.42, edit: 0.31, full: 0.27 });
  const host = fakeHost("pi");
  await host.prompt("explain this");

  assert.deepEqual(host.active(), BASELINE);
  const { tools, application, ratchet } = record(host, 0);
  assert.equal(tools?.reason, "low-confidence");
  assert.equal(tools?.active, null);
  assert.equal(tools?.profile, "full");
  assert.equal(tools?.risk, null);
  assert.equal(tools?.maxRisk, 0.1);
  assert.deepEqual(
    tools?.risks?.map((r) => r.profile),
    ["answer", "edit"],
  );
  assert.ok(Math.abs((tools?.risks?.[0]?.risk ?? 0) - 0.58) < 1e-9);
  assert.ok(Math.abs((tools?.risks?.[1]?.risk ?? 0) - 0.27) < 1e-9);
  assert.equal(application.status, "unchanged");
  assert.deepEqual(sorted(application.actualTools), sorted(BASELINE));
  assert.equal(ratchet?.admitted, true);
  host.shutdown();
});

test("dry run: the proposal is recorded but the actual tools are the baseline", async () => {
  writeConfig({ dryRun: true });
  const host = fakeHost("pi");
  await host.prompt("explain this");

  assert.deepEqual(host.active(), BASELINE);
  const rec = record(host, 0);
  assert.deepEqual(sorted(rec.tools?.active), sorted(ANSWER_SET));
  assert.equal(rec.application.status, "dry-run");
  assert.deepEqual(sorted(rec.application.actualTools), sorted(BASELINE));
  assert.equal(rec.skills?.delivery, "dry-run");
  assert.equal(rec.ratchet?.after, "answer");
  assert.ok(!host.calls.includes("set"));
  host.shutdown();
});

test("widen-only: a later confident narrowing is recorded as not admitted with the tools the host really has", async () => {
  const host = fakeHost("pi");
  await host.prompt("explain this");
  reply.answers.tool_profile = answerReply({ full: 0.9 }, "full");
  await host.prompt("run the tests");
  reply.answers.tool_profile = answerReply({ answer: 0.9 });
  await host.prompt("explain that");

  const blocked = record(host);
  assert.equal(blocked.application.status, "not-admitted");
  assert.deepEqual(blocked.ratchet, { narrowAllowed: false, before: "full", after: "full", admitted: false });
  assert.equal(blocked.tools?.profile, "answer");
  assert.deepEqual(sorted(blocked.tools?.active), sorted(ANSWER_SET));
  assert.deepEqual(sorted(blocked.application.actualTools), sorted(BASELINE));

  await host.compact();
  await host.prompt("explain once more");
  assert.equal(record(host).application.status, "applied");
  host.shutdown();
});

test("application: a narrowing is applied and read back", async () => {
  const host = fakeHost("pi");
  await host.prompt("explain this");
  const { application } = record(host, 0);
  assert.equal(application.status, "applied");
  assert.equal(application.restoration, null);
  assert.deepEqual(sorted(application.actualTools), sorted(ANSWER_SET));
  assert.equal(setCount(host), 1);
  host.shutdown();
});

test("application: tools that already match are unchanged and the setter is not called", async () => {
  const host = fakeHost("pi");
  await host.prompt("explain this");
  await host.prompt("explain this");
  assert.equal(record(host, 1).application.status, "unchanged");
  assert.equal(setCount(host), 1);
  host.shutdown();
});

const WIDEN_TO_EDIT = () => {
  reply.answers.tool_profile = answerReply({ edit: 0.95, full: 0.05 }, "edit");
};

for (const kind of ["pi", "omp"] as const) {
  test(`application: a setter that throws is recorded as failed and the baseline is restored (${kind})`, async () => {
    const host = fakeHost(kind, {
      onSet: (call) => (call === 2 ? { error: errorWith("boom /secret/path", "EIO"), mutate: true } : undefined),
    });
    await host.prompt("explain this");
    WIDEN_TO_EDIT();
    await host.prompt("now edit it");

    assert.deepEqual(sorted(host.active()), sorted(BASELINE));
    const rec = record(host);
    assert.equal(rec.outcome, "classified");
    assert.equal(rec.tools?.profile, "edit");
    assert.equal(rec.application.status, "failed");
    assert.equal(rec.application.restoration, "restored");
    assert.equal(rec.application.error, "EIO");
    assert.deepEqual(sorted(rec.application.actualTools), sorted(BASELINE));
    assert.doesNotMatch(JSON.stringify(host.entries), /secret\/path/);
    host.shutdown();
  });
}

test("application: when restoration also fails the record shows the tools the host really has", async () => {
  const host = fakeHost("omp", {
    onSet: (call) => {
      if (call === 2) return { error: errorWith("boom", "EIO"), mutate: true };
      if (call === 3) return { error: errorWith("boom again", "EIO"), mutate: false };
      return undefined;
    },
  });
  await host.prompt("explain this");
  WIDEN_TO_EDIT();
  await host.prompt("now edit it");

  const rec = record(host);
  assert.equal(rec.application.status, "failed");
  assert.equal(rec.application.restoration, "failed");
  assert.deepEqual(sorted(rec.application.actualTools), sorted(["read", "edit", "write", "grep", "find", "ls"]));
  host.shutdown();
});

test("application: a first-turn setter failure records the host's real tools and no restoration", async () => {
  const host = fakeHost("pi", {
    onSet: (call) => (call === 1 ? { error: errorWith("boom", "EIO"), mutate: true } : undefined),
  });
  await host.prompt("explain this");

  const rec = record(host, 0);
  assert.equal(rec.application.status, "failed");
  assert.equal(rec.application.restoration, null);
  assert.deepEqual(sorted(rec.application.actualTools), sorted(ANSWER_SET));
  host.shutdown();
});

test("skill overflow records the real counts and cap and invents no scores", async () => {
  writeConfig({ skills: { enabled: true, maxCandidates: 1 } });
  const host = fakeHost("pi");
  await host.prompt("explain this");

  assert.deepEqual(Object.keys(requests[0]!.questions), ["tool_profile"]);
  const rec = record(host, 0);
  assert.equal(rec.skills?.reason, "too-many-candidates");
  assert.deepEqual(
    [rec.skills?.discovered, rec.skills?.eligible, rec.skills?.maxCandidates, rec.skills?.asked],
    [2, 2, 1, 0],
  );
  assert.deepEqual(rec.skills?.scores, {});
  assert.equal(rec.skills?.selected, null);
  assert.equal(rec.skills?.delivery, "none");
  assert.equal(rec.skills?.filteredOut, null);
  assert.deepEqual(sorted(host.active()), sorted(ANSWER_SET));
  host.shutdown();
});

test("skill filtering records how many skills it removed", async () => {
  const host = fakeHost("pi");
  await host.prompt("explain this");
  const rec = record(host, 0);
  assert.equal(rec.skills?.delivery, "filter");
  assert.equal(rec.skills?.filteredOut, 1);
  assert.deepEqual(rec.skills?.selected, ["pdf"]);
  host.shutdown();
});

test("skips: every prompt the plugin sees leaves one record, and a skip never replaces the last decision", async () => {
  const host = fakeHost("pi");
  await host.prompt("   ");
  const empty = record(host, 0);
  assert.equal(empty.outcome, "skipped");
  assert.equal(empty.skip, "empty-prompt");
  assert.deepEqual([empty.classifier, empty.tools, empty.skills, empty.ratchet], [null, null, null, null]);
  assert.equal(empty.application.status, "not-attempted");

  await host.prompt("explain this");
  await host.prompt("/review");
  const command = record(host);
  assert.equal(command.skip, "command");
  assert.equal(command.application.status, "restored");
  assert.equal(command.application.restoration, "restored");
  assert.deepEqual(sorted(command.application.actualTools), sorted(BASELINE));
  assert.equal(requests.length, 1);

  host.notes.length = 0;
  await host.command("explain");
  assert.match(host.notes.join("\n"), /outcome: skipped: slash command, not classified/);
  assert.match(host.notes.join("\n"), /previous decision: applied answer/);
  host.shutdown();
});

test("skips: disabled by config or by /loadout off", async () => {
  writeConfig({ enabled: false });
  const off = fakeHost("pi");
  await off.prompt("explain this");
  assert.equal(record(off, 0).skip, "disabled");
  off.shutdown();

  writeConfig({});
  const host = fakeHost("pi");
  await host.prompt("explain this");
  await host.command("off");
  await host.prompt("explain that");
  const rec = record(host);
  assert.equal(rec.skip, "disabled");
  assert.equal(rec.application.status, "unchanged");
  assert.equal(requests.length, 1);
  host.shutdown();
});

test("skips: nothing to ask records the skill counts", async () => {
  writeConfig({ tools: { enabled: false }, skills: { enabled: false } });
  const none = fakeHost("pi");
  await none.prompt("explain this");
  assert.equal(requests.length, 0);
  const a = record(none, 0);
  assert.equal(a.skip, "no-questions");
  assert.deepEqual(
    [a.skills?.reason, a.skills?.discovered, a.skills?.eligible, a.skills?.asked],
    ["disabled", 2, 2, 0],
  );
  none.shutdown();

  writeConfig({ tools: { enabled: false }, skills: { enabled: true, maxCandidates: 1 } });
  const many = fakeHost("pi");
  await many.prompt("explain this");
  assert.equal(requests.length, 0);
  const b = record(many, 0);
  assert.equal(b.skip, "no-questions");
  assert.equal(b.skills?.reason, "too-many-candidates");
  many.shutdown();
});

test("one record per prompt, written after the tools were applied", async () => {
  const host = fakeHost("pi");
  await host.prompt("explain this");
  assert.deepEqual(host.calls, ["set", "append"]);
  await host.prompt("/review");
  await host.prompt("explain more");
  assert.equal(host.entries.length, 3);
  host.shutdown();
});

test("session id is the host's, or null when it has none", async () => {
  const host = fakeHost("pi");
  await host.prompt("explain this");
  assert.equal(record(host, 0).sessionId, host.sessionId);
  host.shutdown();

  const anonymous = fakeHost("pi", { sessionIdThrows: true });
  await anonymous.prompt("explain this");
  assert.equal(record(anonymous, 0).sessionId, null);
  anonymous.shutdown();
});

const machineOff = () => fs.writeFileSync(GLOBAL_FILE(), JSON.stringify({ telemetry: false }));

async function assertSilentAndWorking(host: ReturnType<typeof fakeHost>, reason: string) {
  assert.equal(host.entries.length, 0);
  assert.deepEqual(sorted(host.active()), sorted(ANSWER_SET));
  host.notes.length = 0;
  await host.command("explain");
  assert.match(host.notes.join("\n"), /outcome: applied answer/);
  assert.match(host.notes.join("\n"), /application: applied/);
  assert.match(host.notes.join("\n"), new RegExp(`record not stored: telemetry off \\(${reason}\\)`));
  host.notes.length = 0;
  await host.command("status");
  assert.match(host.notes.join("\n"), new RegExp(`telemetry: off \\(${reason}\\)`));
}

test("machine telemetry off beats trusted-project, explicit-file and /loadout on", async () => {
  // The machine file itself carries the endpoint.
  writeConfig({ telemetry: false });
  const global = fakeHost("pi");
  await global.prompt("explain this");
  assert.equal(requests.length, 1);
  await assertSilentAndWorking(global, "machine-off");
  global.shutdown();

  // A trusted project file cannot lift it.
  requests.length = 0;
  machineOff();
  fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".omp", "loadout.json"),
    JSON.stringify({ skills: { enabled: true }, telemetry: true, ...endpointConfig() }),
  );
  const trusted = fakeHost("pi");
  await trusted.prompt("explain this");
  assert.equal(requests.length, 1);
  await assertSilentAndWorking(trusted, "machine-off");
  trusted.shutdown();

  // Neither can LOADOUT_CONFIG.
  requests.length = 0;
  fs.rmSync(path.join(project, ".omp"), { recursive: true, force: true });
  const explicit = path.join(home, "explicit.json");
  fs.writeFileSync(explicit, JSON.stringify({ skills: { enabled: true }, telemetry: true, ...endpointConfig() }));
  process.env.LOADOUT_CONFIG = explicit;
  const viaEnv = fakeHost("pi");
  await viaEnv.prompt("explain this");
  assert.equal(requests.length, 1);
  await assertSilentAndWorking(viaEnv, "machine-off");
  viaEnv.shutdown();
  delete process.env.LOADOUT_CONFIG;

  // /loadout on cannot lift it either.
  requests.length = 0;
  writeConfig({ telemetry: false });
  const toggled = fakeHost("pi");
  await toggled.prompt("explain this");
  await toggled.command("off");
  await toggled.prompt("explain that");
  await toggled.command("on");
  await toggled.prompt("explain once more");
  assert.equal(requests.length, 2);
  await assertSilentAndWorking(toggled, "machine-off");
  toggled.shutdown();
});

test("telemetry fails closed on a config error and on an unreadable machine setting", async () => {
  fs.writeFileSync(GLOBAL_FILE(), JSON.stringify({ backend: "jev", jev: { timeoutMs: 30000 } }));
  const broken = fakeHost("pi");
  await broken.prompt("explain this");
  assert.equal(broken.entries.length, 0);
  await broken.command("status");
  assert.match(broken.notes.join("\n"), /telemetry: off \(config-error\)/);
  broken.shutdown();

  for (const text of ["{ not json", JSON.stringify({ telemetry: "no" })]) {
    fs.writeFileSync(GLOBAL_FILE(), text);
    const host = fakeHost("pi");
    await host.prompt("explain this");
    assert.equal(host.entries.length, 0);
    await host.command("status");
    assert.match(host.notes.join("\n"), /telemetry: off \(machine-unreadable\)/);
    host.shutdown();
  }
});

test("the machine opt-out is read when the session loads its config, so a change needs a restart", async () => {
  const host = fakeHost("pi");
  await host.prompt("explain this");
  assert.equal(host.entries.length, 1);
  writeConfig({ telemetry: false });
  await host.prompt("explain that");
  assert.equal(host.entries.length, 2);
  host.shutdown();
});

test("canaries never reach serialized telemetry", async () => {
  const question = {
    ...defaultConfig().tools.question,
    instructions: "CANARY_RUBRIC_C3",
  };
  const skills = [
    { name: "pdf", description: "CANARY_SKILL_DESC_B2 read and write PDF files" },
    { name: "deploy", description: "deploy the app" },
  ];
  fs.writeFileSync(
    GLOBAL_FILE(),
    JSON.stringify({ skills: { enabled: true }, tools: { question }, ...endpointConfig("?q=CANARY_QUERY_D4") }),
  );
  process.env[TOKEN_VAR] = "CANARY_TOKEN_E5";
  try {
    reply.answers.tool_profile = answerReply({ answer: 0.9, CANARY_PROB_I9: 0.1 });
    reply.extra = {
      model: "CANARY_MODEL_G7 prose that is not a model id",
      usage: { input_tokens: 11, output_tokens: 7, secret: "CANARY_USAGE_H8" },
    };
    const host = fakeHost("pi", { skills });
    await host.prompt("CANARY_PROMPT_A1 explain this");
    const first = record(host, 0);
    assert.equal(first.classifier?.model, null);
    assert.deepEqual(first.classifier?.usage, { inputTokens: 11, outputTokens: 7 });
    assert.deepEqual(Object.keys(first.tools?.probabilities ?? {}), ["answer"]);

    reply = { status: 500, answers: {}, body: "upstream said CANARY_BODY_F6" };
    await host.prompt("CANARY_PROMPT_A1 now fix it");

    assert.equal(host.entries.length, 2);
    assert.doesNotMatch(JSON.stringify(host.entries), /CANARY/);
    // The guards: the canaries were really in play, and in-memory diagnostics survive.
    assert.match(JSON.stringify(requests), /CANARY_PROMPT_A1/);
    assert.match(JSON.stringify(requests), /CANARY_SKILL_DESC_B2/);
    assert.match(host.notes.join("\n"), /CANARY_BODY_F6/);
    host.shutdown();
  } finally {
    process.env[TOKEN_VAR] = "test-token";
  }
});

test("persist failure: the turn continues, tools are applied, and the failure is counted with a code only", async () => {
  const host = fakeHost("pi", {
    onAppend: () => errorWith("EACCES: permission denied, open '/home/x/secret-dir/s.jsonl'", "EACCES"),
  });
  await assert.doesNotReject(host.prompt("explain this"));
  assert.deepEqual(sorted(host.active()), sorted(ANSWER_SET));
  assert.equal(host.entries.length, 0);
  const stored = () => host.notes.filter((note) => /telemetry record not stored \(EACCES\)/.test(note));
  assert.equal(stored().length, 1);

  await host.prompt("explain that");
  assert.equal(stored().length, 1);

  host.setAppendFault(null);
  await host.prompt("explain once more");
  assert.equal(host.entries.length, 1);

  await host.command("status");
  assert.match(host.notes.join("\n"), /failed 2 \(EACCES\)/);
  assert.match(host.notes.join("\n"), /handed to host 1/);
  assert.doesNotMatch(host.notes.join("\n") + JSON.stringify(host.entries), /secret-dir/);
  host.shutdown();
});

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
const NO_TOKENS = { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null };

for (const kind of ["omp", "pi"] as const) {
  test(`usage: model turns under one decision link to it and keep separate identities (${kind})`, async () => {
    const host = fakeHost(kind);
    await host.prompt("explain this");
    host.fire("agent_start");
    const returned = [turn(host, kind, { stopReason: "toolUse", calls: ["read"] }), turn(host, kind, { turnIndex: 1 })];
    assert.deepEqual(returned, [undefined, undefined]);
    assert.deepEqual(
      host.entries.map((entry) => entry.type),
      ["loadout.decision", "loadout.usage", "loadout.usage"],
    );
    const [first, second] = usageOf(host);
    const [decision] = decisionsOf(host);
    assert.ok(first && second && decision);
    assert.equal(first.decisionId, decision.decisionId);
    assert.equal(second.decisionId, decision.decisionId);
    assert.equal(first.runId, second.runId);
    assert.notEqual(first.eventId, second.eventId);
    assert.deepEqual([first.turnIndex, second.turnIndex], [0, 1]);
    assert.deepEqual([first.host, second.host], [kind, kind]);
    assert.deepEqual([first.sessionId, second.sessionId], [host.sessionId, host.sessionId]);
    assert.deepEqual([first.stopReason, first.toolCalls], ["toolUse", { read: 1 }]);

    await host.prompt("explain that");
    host.fire("agent_start");
    turn(host, kind);
    const third = usageOf(host)[2];
    assert.ok(third);
    assert.notEqual(third.runId, first.runId);
    assert.equal(third.turnIndex, 0);
    assert.equal(third.decisionId, decisionsOf(host)[1]?.decisionId);
    assert.notEqual(third.decisionId, decision.decisionId);
    host.shutdown();
  });
}

test("usage: a queued follow-up's decision applies from its own turn", async () => {
  const host = fakeHost("omp");
  await host.prompt("explain this");
  host.fire("agent_start");
  turn(host, "omp", { stopReason: "toolUse", calls: ["read"] });
  turn(host, "omp", { turnIndex: 1 });
  // The host runs the hook again for a queued follow-up. No agent_start follows: the run is still open.
  await host.prompt("and this");
  turn(host, "omp", { turnIndex: 2 });
  // A second follow-up arrives while turn 3 is in flight: its hook runs between that turn's start and end.
  host.fire("turn_start", { type: "turn_start", turnIndex: 3 });
  await host.prompt("and that");
  host.fire("turn_end", ompTurnEnd({ turnIndex: 3 }));
  turn(host, "omp", { turnIndex: 4 });

  const [d1, d2, d3] = decisionsOf(host).map((decision) => decision.decisionId);
  const records = usageOf(host);
  assert.equal(new Set([d1, d2, d3]).size, 3);
  assert.deepEqual(
    records.map((r) => r.decisionId),
    [d1, d1, d2, d2, d3],
  );
  assert.deepEqual(
    records.map((r) => r.turnIndex),
    [0, 1, 2, 3, 4],
  );
  assert.equal(new Set(records.map((r) => r.runId)).size, 1);
  host.shutdown();
});

test("usage: a continuation without a decision hook is unassigned and carries the host's retry number on omp only", async () => {
  const omp = fakeHost("omp");
  await omp.prompt("explain this");
  omp.fire("agent_start");
  turn(omp, "omp", { stopReason: "error", usage: ZERO_USAGE });
  omp.fire("auto_retry_start", { attempt: 1, maxAttempts: 3, delayMs: 10 });
  omp.fire("agent_end");
  omp.fire("agent_start");
  turn(omp, "omp");
  omp.fire("auto_retry_end", { success: true, attempt: 1 });
  const [failed, retried] = usageOf(omp);
  assert.ok(failed && retried);
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.decisionId, decisionsOf(omp)[0]?.decisionId);
  assert.equal(failed.retryAttempt, null);
  assert.deepEqual(failed.tokens, NO_TOKENS);
  assert.equal(failed.costTotal, null);
  assert.equal(retried.decisionId, null);
  assert.notEqual(retried.runId, failed.runId);
  assert.equal(retried.retryAttempt, 1);
  // A retry that was announced but never ran (cancelled during its delay) must not mark an unrelated later turn.
  omp.fire("auto_retry_start", { attempt: 2, maxAttempts: 3, delayMs: 10 });
  omp.fire("auto_retry_end", { success: false, attempt: 2 });
  turn(omp, "omp", { turnIndex: 1 });
  assert.equal(usageOf(omp)[2]?.retryAttempt, null);
  omp.shutdown();

  // pi has no retry event: the continuation is still unassigned, and its retry number stays unknown.
  const pi = fakeHost("pi");
  await pi.prompt("explain this");
  pi.fire("agent_start");
  turn(pi, "pi", { stopReason: "error", usage: ZERO_USAGE });
  pi.fire("agent_end");
  pi.fire("agent_start");
  turn(pi, "pi");
  pi.fire("agent_start");
  turn(pi, "pi");
  const [piFailed, piRetried, piLater] = usageOf(pi);
  assert.ok(piFailed && piRetried && piLater);
  assert.equal(piFailed.decisionId, decisionsOf(pi)[0]?.decisionId);
  assert.deepEqual([piFailed.retryAttempt, piRetried.retryAttempt, piLater.retryAttempt], [null, null, null]);
  assert.deepEqual([piRetried.decisionId, piLater.decisionId], [null, null]);
  assert.notEqual(piRetried.runId, piFailed.runId);
  pi.shutdown();
});

test("usage: compaction, branch and tree boundaries leave later turns unassigned", async () => {
  const started = async () => {
    const host = fakeHost("omp");
    await host.prompt("explain this");
    return host;
  };

  const compacted = await started();
  compacted.fire("agent_start");
  turn(compacted, "omp");
  await compacted.compact();
  turn(compacted, "omp", { turnIndex: 1 });
  const [before, after] = usageOf(compacted);
  assert.ok(before && after);
  assert.equal(before.decisionId, decisionsOf(compacted)[0]?.decisionId);
  assert.notEqual(after.runId, before.runId);
  assert.equal(after.decisionId, null);
  compacted.shutdown();

  const early = await started();
  await early.compact();
  early.fire("agent_start");
  turn(early, "omp");
  assert.equal(usageOf(early)[0]?.decisionId, decisionsOf(early)[0]?.decisionId);
  early.shutdown();

  for (const name of ["session_tree", "session_branch", "session_switch"]) {
    const host = await started();
    host.fire("agent_start");
    turn(host, "omp");
    host.fire(name);
    turn(host, "omp", { turnIndex: 1 });
    const [one, two] = usageOf(host);
    assert.ok(one && two, name);
    assert.notEqual(two.runId, one.runId, name);
    assert.equal(two.decisionId, null, name);
    host.shutdown();
  }

  const moved = await started();
  moved.fire("session_tree");
  moved.fire("agent_start");
  turn(moved, "omp");
  assert.equal(usageOf(moved)[0]?.decisionId, null);
  moved.shutdown();

  const unclaimed = await started();
  unclaimed.fire("agent_end");
  unclaimed.fire("agent_start");
  turn(unclaimed, "omp");
  assert.equal(usageOf(unclaimed)[0]?.decisionId, null);
  unclaimed.shutdown();
});

test("usage: sessions never mix, a tool result's own usage adds nothing, and a replayed turn counts once", async () => {
  const a = fakeHost("omp");
  const b = fakeHost("pi");
  await a.prompt("explain this");
  await b.prompt("explain that");
  a.fire("agent_start");
  b.fire("agent_start");
  turn(a, "omp", { stopReason: "toolUse", calls: ["task"], results: [toolResult("task")] });
  turn(b, "pi");
  turn(a, "omp", { turnIndex: 1 });
  const replayed = piTurnEnd({ turnIndex: 1 });
  b.fire("turn_start");
  b.fire("turn_end", replayed);
  b.fire("turn_end", replayed);

  const [a0, a1] = usageOf(a);
  const [b0, b1] = usageOf(b);
  assert.ok(a0 && a1 && b0 && b1);
  assert.equal(usageOf(a).length, 2);
  assert.equal(usageOf(b).length, 2);
  assert.deepEqual([a0.sessionId, a1.sessionId], [a.sessionId, a.sessionId]);
  assert.deepEqual([b0.sessionId, b1.sessionId], [b.sessionId, b.sessionId]);
  const [decisionA] = decisionsOf(a);
  const [decisionB] = decisionsOf(b);
  assert.ok(decisionA && decisionB);
  assert.notEqual(decisionA.decisionId, decisionB.decisionId);
  assert.deepEqual([a0.decisionId, a1.decisionId], [decisionA.decisionId, decisionA.decisionId]);
  assert.deepEqual([b0.decisionId, b1.decisionId], [decisionB.decisionId, decisionB.decisionId]);
  assert.equal(a0.runId, a1.runId);
  assert.equal(b0.runId, b1.runId);
  assert.notEqual(a0.runId, b0.runId);
  assert.deepEqual(a0.tokens, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: null });
  assert.equal(a0.costTotal, 0.0005);
  assert.deepEqual([a0.toolCalls, a0.toolErrors], [{ task: 1 }, 0]);
  a.shutdown();
  b.shutdown();
});

/** A function, not a constant: `home` is assigned in the `before` hook. */
function optOutLayers(): Array<{ reason: string; arrange: () => void }> {
  const explicit = path.join(home, "explicit.json");
  return [
    { reason: "machine-off", arrange: () => writeConfig({ telemetry: false }) },
    { reason: "machine-unreadable", arrange: () => fs.writeFileSync(GLOBAL_FILE(), "{ not json") },
    {
      reason: "config-error",
      arrange: () => fs.writeFileSync(GLOBAL_FILE(), JSON.stringify({ backend: "jev", jev: { timeoutMs: 30000 } })),
    },
    {
      reason: "config-off",
      arrange: () => {
        fs.writeFileSync(
          explicit,
          JSON.stringify({ skills: { enabled: true }, telemetry: false, ...endpointConfig() }),
        );
        process.env.LOADOUT_CONFIG = explicit;
      },
    },
  ];
}

test("usage: opt-out writes no usage record in any layer", async () => {
  try {
    for (const { reason, arrange } of optOutLayers()) {
      writeConfig({});
      delete process.env.LOADOUT_CONFIG;
      arrange();
      const host = fakeHost("omp");
      await host.prompt("explain this");
      host.fire("agent_start");
      turn(host, "omp", { stopReason: "toolUse", calls: ["read"] });
      turn(host, "omp", { turnIndex: 1 });
      assert.deepEqual(host.entries, [], reason);
      assert.ok(!host.calls.includes("append"), reason);
      await host.command("status");
      assert.match(
        host.notes.join("\n"),
        new RegExp(`telemetry: off \\(${reason}\\) \\| records suppressed 3`),
        reason,
      );
      host.shutdown();
    }
  } finally {
    delete process.env.LOADOUT_CONFIG;
  }
});

test("usage: canaries in messages, arguments, results and errors never reach a record", async () => {
  for (const kind of ["omp", "pi"] as const) {
    const host = fakeHost(kind);
    await host.prompt("explain this");
    host.fire("agent_start");
    const build = kind === "pi" ? piTurnEnd : ompTurnEnd;
    const events = [
      build({ stopReason: "error", calls: ["read", ...INVENTED_TOOL_NAMES] }),
      build({ turnIndex: 1, calls: ["read"], results: [toolResult("read", true)] }),
    ];
    // Guard: every canary is really in the events, so a clean record is not a clean input.
    for (const canary of Object.values(CANARY)) assert.ok(JSON.stringify(events).includes(canary), canary);
    for (const event of events) {
      host.fire("turn_start");
      host.fire("turn_end", event);
    }
    assert.equal(usageOf(host).length, 2, kind);
    assert.doesNotMatch(JSON.stringify(usageOf(host)), /CANARY/, kind);
    host.shutdown();
  }
});

test("usage: a failing append never reaches the agent and later turns are still recorded", async () => {
  const host = fakeHost("pi", {
    onAppend: (call) =>
      call >= 2 ? errorWith("EACCES: permission denied, open '/home/x/secret-dir/s.jsonl'", "EACCES") : undefined,
  });
  await host.prompt("explain this");
  host.fire("agent_start");
  assert.equal(host.entries.length, 1);
  const tools = [...host.active()];

  assert.doesNotThrow(() => {
    turn(host, "pi");
    turn(host, "pi", { turnIndex: 1 });
  });
  assert.equal(host.entries.length, 1);
  assert.equal(host.notes.filter((note) => /telemetry record not stored \(EACCES\)/.test(note)).length, 1);
  assert.deepEqual(host.active(), tools);

  host.setAppendFault(null);
  turn(host, "pi", { turnIndex: 2 });
  assert.equal(usageOf(host).length, 1);

  await host.command("status");
  assert.match(host.notes.join("\n"), /failed 2 \(EACCES\)/);
  assert.match(host.notes.join("\n"), /handed to host 2/);
  assert.doesNotMatch(host.notes.join("\n") + JSON.stringify(host.entries), /secret-dir/);
  host.shutdown();
});

test("usage: hostile events never throw and never change the event", async () => {
  const host = fakeHost("pi");
  await host.prompt("explain this");
  host.fire("agent_start");
  const notes = host.notes.length;

  for (const hostile of [null, undefined, 7, "x", []]) assert.equal(host.fire("turn_end", hostile), undefined);
  assert.equal(usageOf(host).length, 0);
  assert.equal(host.notes.length, notes);

  const throwing = {
    type: "turn_end",
    turnIndex: 0,
    toolResults: [],
    get message(): unknown {
      throw new Error("CANARY_THROWN_TEXT");
    },
  };
  assert.equal(host.fire("turn_end", throwing), undefined);
  assert.equal(host.notes.filter((note) => /telemetry record not stored \(error\)/.test(note)).length, 1);
  assert.doesNotMatch(host.notes.join("\n"), /CANARY/);

  const event = piTurnEnd({ calls: ["read"], results: [toolResult()] });
  const before = structuredClone(event);
  assert.equal(host.fire("turn_end", event), undefined);
  assert.deepEqual(event, before);
  assert.equal(usageOf(host).length, 1);
  host.shutdown();
});

test("usage: classifier calls are not model turns", async () => {
  reply.extra = { usage: { input_tokens: 4141, output_tokens: 313 } };
  const host = fakeHost("omp");
  await host.prompt("explain this");
  host.fire("agent_start");
  assert.deepEqual(decisionsOf(host)[0]?.classifier?.usage, { inputTokens: 4141, outputTokens: 313 });
  assert.equal(usageOf(host).length, 0);

  turn(host, "omp");
  const records = usageOf(host);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]?.tokens, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: null });
  host.shutdown();
});

test("usage: skip decisions link too", async () => {
  writeConfig({ enabled: false });
  const host = fakeHost("omp");
  await host.prompt("explain this");
  host.fire("agent_start");
  turn(host, "omp");
  const [decision] = decisionsOf(host);
  assert.equal(decision?.outcome, "skipped");
  assert.match(decision?.decisionId ?? "", ID_PATTERN);
  assert.equal(usageOf(host)[0]?.decisionId, decision?.decisionId);
  host.shutdown();
});

test("usage: a config reload inside a run does not split the run", async () => {
  const other = path.join(path.dirname(project), "other-cwd");
  fs.mkdirSync(other, { recursive: true });
  const host = fakeHost("omp");
  await host.prompt("explain this");
  host.fire("agent_start");
  turn(host, "omp");
  host.setCwd(other);
  await host.prompt("and this");
  turn(host, "omp", { turnIndex: 1 });

  const [first, second] = usageOf(host);
  const [d1, d2] = decisionsOf(host).map((decision) => decision.decisionId);
  assert.ok(first && second);
  assert.equal(second.runId, first.runId);
  assert.deepEqual([first.decisionId, second.decisionId], [d1, d2]);
  host.shutdown();
});

test("usage: pi runs no hook for a queued follow-up or steer, so the rest of the run is unassigned", async () => {
  // A follow-up arrives after the run would have stopped; a steer arrives after a tool turn. Neither has a hook.
  for (const queued of ["follow-up", "steer"]) {
    const host = fakeHost("pi");
    await host.prompt("explain this");
    host.fire("agent_start");
    if (queued === "steer") {
      userTurn(host, "pi", { stopReason: "toolUse", calls: ["read"] });
      turn(host, "pi", { turnIndex: 1 });
    } else {
      userTurn(host, "pi");
    }
    userTurn(host, "pi", { turnIndex: queued === "steer" ? 2 : 1 });
    turn(host, "pi", { turnIndex: queued === "steer" ? 3 : 2 });

    const records = usageOf(host);
    const [d1] = decisionsOf(host).map((decision) => decision.decisionId);
    const before = queued === "steer" ? 2 : 1;
    assert.equal(decisionsOf(host).length, 1, queued);
    assert.deepEqual(
      records.map((r) => r.decisionId),
      [...Array(before).fill(d1), null, null],
      queued,
    );
    assert.equal(new Set(records.map((r) => r.runId)).size, 1, queued);

    await host.prompt("and now");
    host.fire("agent_start");
    userTurn(host, "pi");
    const last = usageOf(host).at(-1);
    assert.equal(last?.decisionId, decisionsOf(host)[1]?.decisionId, queued);
    assert.notEqual(last?.runId, records[0]?.runId, queued);
    host.shutdown();
  }
});

test("usage: omp runs the hook for a queued message, so its decision applies from its own turn", async () => {
  const host = fakeHost("omp");
  await host.prompt("explain this");
  host.fire("agent_start");
  userTurn(host, "omp", { stopReason: "toolUse", calls: ["read"] });
  turn(host, "omp", { turnIndex: 1 });
  // A follow-up: the hook runs between turn_end and turn_start, and the host's user message follows turn_start.
  await host.prompt("and this");
  userTurn(host, "omp", { turnIndex: 2 });
  // A steer queued while turn 3 is in flight: its hook runs before that turn ends, and applies from the next one.
  host.fire("turn_start", { type: "turn_start", turnIndex: 3 });
  await host.prompt("and that");
  host.fire("turn_end", ompTurnEnd({ turnIndex: 3 }));
  userTurn(host, "omp", { turnIndex: 4 });

  const [d1, d2, d3] = decisionsOf(host).map((decision) => decision.decisionId);
  assert.deepEqual(
    usageOf(host).map((r) => r.decisionId),
    [d1, d1, d2, d2, d3],
  );
  assert.equal(new Set(usageOf(host).map((r) => r.runId)).size, 1);
  host.shutdown();
});

test("usage: user message events that are not a delivered user message never change the run", async () => {
  const host = fakeHost("pi");
  await host.prompt("explain this");
  host.fire("agent_start");
  userTurn(host, "pi");
  const notes = host.notes.length;

  const throwing = {
    type: "message_start",
    get message(): unknown {
      throw new Error("CANARY_THROWN_TEXT");
    },
  };
  const roles = ["assistant", "toolResult", "custom", "developer", "bashExecution", 7, null, undefined];
  const hostile: unknown[] = [
    null,
    undefined,
    7,
    "x",
    [],
    {},
    { message: null },
    { message: 7 },
    { message: [] },
    { message: { role: ["user"] } },
    { message: { role: "User" } },
    throwing,
    ...roles.map((role) => ({ type: "message_start", message: { role, content: CANARY.text } })),
  ];
  for (const event of hostile) assert.equal(host.fire("message_start", event), undefined);
  assert.equal(host.notes.length, notes);
  assert.doesNotMatch(host.notes.join("\n"), /CANARY/);

  turn(host, "pi", { turnIndex: 1 });
  const [first, second] = usageOf(host);
  assert.ok(first && second);
  assert.equal(second.decisionId, decisionsOf(host)[0]?.decisionId);
  assert.equal(second.runId, first.runId);
  host.shutdown();
});

for (const kind of ["omp", "pi"] as const) {
  test(`usage: only names of tools the host registered are stored (${kind})`, async () => {
    const host = fakeHost(kind);
    await host.prompt("explain this");
    host.fire("agent_start");
    const calls = ["read", ...INVENTED_TOOL_NAMES, "task", "read"];
    // Guard: the event holds the made-up names.
    for (const name of INVENTED_TOOL_NAMES) assert.ok(JSON.stringify(ompTurnEnd({ calls })).includes(name), name);
    turn(host, kind, { calls });

    const [observation] = usageOf(host);
    assert.deepEqual(observation?.toolCalls, { read: 2, task: 1 });
    assert.doesNotMatch(JSON.stringify(host.entries), /CANARY|secret|example\.com|sk-live/);
    host.shutdown();
  });
}

test("usage: a tool registry that cannot be read leaves the record without tool names and is not a failure", async () => {
  const host = fakeHost("pi", { getAllToolsThrows: true });
  await host.prompt("explain this");
  host.fire("agent_start");
  turn(host, "pi", { calls: ["read", "task"], results: [toolResult("read", true)] });

  const [observation] = usageOf(host);
  assert.ok(observation);
  assert.deepEqual(observation.toolCalls, {});
  assert.equal(observation.toolErrors, 1);
  assert.deepEqual(observation.tokens, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: null });
  assert.doesNotMatch(host.notes.join("\n"), /telemetry record not stored/);
  await host.command("status");
  assert.match(host.notes.join("\n"), /failed 0/);
  host.shutdown();
});

/** A fresh directory for one test's session file, so a history scan reads only that test's files. */
function sessionDir(): string {
  return fs.mkdtempSync(path.join(home, "sessions-"));
}

function sessionSpec(file: string): ReportSpec {
  const result = parseArgv(["summary", "--session", file]);
  if (!result.ok || result.parsed.kind !== "run") throw new Error(`no session scope for ${file}`);
  return result.parsed.spec;
}

async function runCommand(host: Host, args: string) {
  const from = host.notices.length;
  await host.command(args);
  return host.notices.slice(from);
}

async function promptInfo(host: Host, text: string) {
  const from = host.notices.length;
  await host.prompt(text);
  return host.notices.slice(from).filter((notice) => notice.level === "info");
}

function onlyNotice<T>(notices: T[]): T {
  assert.equal(notices.length, 1);
  return notices[0]!;
}

async function explainOf(host: Host): Promise<string> {
  return onlyNotice(await runCommand(host, "explain")).message;
}

function assertCompact(text: string): void {
  assert.ok(text.length <= 160, text);
  assert.doesNotMatch(text, /\n/);
  // A tool list is two tool names in a row; a profile name that is also a tool name ("would keep edit, not answer") is not.
  assert.doesNotMatch(
    text,
    /\b(?:read|bash|edit|write|grep|find|ls|task), (?:read|bash|edit|write|grep|find|ls|task)\b/,
  );
  assert.doesNotMatch(text, /\bp \d\.\d\d\b|\b(?:answer|edit|full): \d/);
}

test("extension: commands print exactly one notification each", async () => {
  const host = fakeHost("pi", { sessionFile: path.join(sessionDir(), "session.jsonl") });
  await host.prompt("explain this");

  const status = onlyNotice(await runCommand(host, "status")).message;
  const explain = onlyNotice(await runCommand(host, "explain")).message;
  const stats = onlyNotice(await runCommand(host, "stats")).message;
  const json = await runCommand(host, "stats --json");
  const usage = onlyNotice(await runCommand(host, "bogus"));

  assert.match(status, /^\[loadout\] status\n/);
  assert.match(explain, /^\[loadout\] explain: latest invocation\n/);
  assert.match(stats, /^\[loadout\] stats: session files\n/);
  assert.equal(onlyNotice(json).level, "info");
  assert.equal(JSON.parse(onlyNotice(json).message).scope.kind, "session");
  assert.equal(usage.level, "warning");
  host.shutdown();
});

test("extension: explain traces the latest invocation of any outcome", async () => {
  const host = fakeHost("pi");
  await host.prompt("explain this");
  await host.prompt("/review");
  const skipped = await explainOf(host);
  assert.match(skipped, /^ {2}outcome: skipped: slash command, not classified$/m);
  assert.match(skipped, /^ {2}previous decision: applied answer \(tools 4 of 7\); skills: 1 selected$/m);

  const canary = "CANARY_FAILURE_Q9";
  reply = { status: 500, answers: {}, body: `upstream said ${canary}` };
  await host.prompt("now fix it");
  const failed = await explainOf(host);
  assert.match(failed, /^ {2}outcome: classification failed: unavailable \(HTTP 500\) after \d+ ms$/m);
  assert.match(failed, new RegExp(`^  failure text \\(memory only, never stored\\): .*${canary}`, "m"));
  assert.doesNotMatch(failed, /previous decision/);
  // Guards: the canary reached the in-memory text, and no record holds it.
  assert.match(host.notes.join("\n"), new RegExp(canary));
  assert.doesNotMatch(JSON.stringify(host.entries), new RegExp(canary));
  host.shutdown();
});

test("extension: outcomes through the real hook read differently", async () => {
  const headlines: string[] = [];

  // Low confidence: no narrower profile is within the risk ceiling, so every tool stays.
  reply.answers.tool_profile = answerReply({ answer: 0.55, edit: 0.3, full: 0.15 });
  let host = fakeHost("pi");
  const low = onlyNotice(await promptInfo(host, "explain this")).message;
  assert.equal(
    low,
    "[loadout] all tools kept: low confidence (closest narrower risk 0.15 > max 0.10); skills: 1 selected",
  );
  headlines.push(low);
  const lowExplain = await explainOf(host);
  assert.match(lowExplain, /^ {2}tools: low confidence, no profile within max risk 0\.10$/m);
  assert.match(lowExplain, /^ {4}answer: p 0\.55, risk 0\.45 > 0\.10$/m);
  assert.match(lowExplain, /^ {4}edit: p 0\.30, risk 0\.15 > 0\.10$/m);
  assert.match(lowExplain, /^ {4}full: p 0\.15 \(broadest, the baseline\)$/m);
  assert.match(lowExplain, /^ {2}blocked: low confidence$/m);
  host.shutdown();

  // Skill overflow: two candidates over a limit of one, so no skill is asked and none is filtered.
  writeConfig({ skills: { enabled: true, maxCandidates: 1 } });
  reply.answers.tool_profile = answerReply({ answer: 0.9 });
  host = fakeHost("pi");
  const overflow = onlyNotice(await promptInfo(host, "explain this")).message;
  assert.equal(overflow, "[loadout] applied answer (tools 4 of 7); skills: 2 candidates > limit 1, none asked");
  headlines.push(overflow);
  const overflowExplain = await explainOf(host);
  assert.match(overflowExplain, /^ {2}skills: 2 eligible > limit 1 \(discovered 2\): none asked, all skills kept$/m);
  assert.match(overflowExplain, /^ {2}blocked: skills over the candidate limit$/m);
  host.shutdown();

  writeConfig({ dryRun: true });
  host = fakeHost("pi");
  const dry = onlyNotice(await promptInfo(host, "explain this")).message;
  assert.equal(dry, "[loadout] dry run: would use answer (tools 4), nothing changed; skills: would select 1");
  headlines.push(dry);
  assert.deepEqual(host.active(), BASELINE);
  assert.match(await explainOf(host), /^ {2}blocked: dry run$/m);
  host.shutdown();

  writeConfig({});
  host = fakeHost("pi");
  WIDEN_TO_EDIT();
  assert.equal(
    onlyNotice(await promptInfo(host, "run the tests")).message,
    "[loadout] applied edit (tools 6 of 7); skills: 1 selected",
  );
  reply.answers.tool_profile = answerReply({ answer: 0.9 });
  const ratchet = onlyNotice(await promptInfo(host, "explain that")).message;
  assert.equal(ratchet, "[loadout] kept edit: widen-only blocked narrowing to answer; skills: 1 selected");
  headlines.push(ratchet);
  const ratchetExplain = await explainOf(host);
  assert.match(ratchetExplain, /^ {2}ratchet: edit -> edit \(blocked, narrowing locked\)$/m);
  assert.match(ratchetExplain, /^ {2}blocked: widen-only ratchet \(kept edit\)$/m);
  host.shutdown();

  host = fakeHost("pi");
  const applied = onlyNotice(await promptInfo(host, "explain this")).message;
  assert.equal(applied, "[loadout] applied answer (tools 4 of 7); skills: 1 selected");
  headlines.push(applied);
  assert.match(await explainOf(host), /^ {2}application: applied \| actual tools: read, grep, find, ls \(4\)$/m);
  host.shutdown();

  host = fakeHost("pi");
  WIDEN_TO_EDIT();
  await host.prompt("run the tests");
  WIDEN_TO_EDIT();
  const matching = onlyNotice(await promptInfo(host, "run the tests again")).message;
  assert.equal(matching, "[loadout] already matching edit (tools 6 of 7); skills: 1 selected");
  headlines.push(matching);
  host.shutdown();

  host = fakeHost("pi", {
    onAppend: () => errorWith("EACCES: permission denied, open '/home/x/secret-dir/s.jsonl'", "EACCES"),
  });
  WIDEN_TO_EDIT();
  const collected = onlyNotice(await promptInfo(host, "run the tests")).message;
  assert.equal(collected, "[loadout] applied edit (tools 6 of 7); skills: 1 selected");
  headlines.push(collected);
  const unstored = await explainOf(host);
  assert.match(unstored, /^ {2}source: in memory \| record not stored: EACCES$/m);
  assert.doesNotMatch(unstored, /secret-dir/);
  const warnings = host.notes.filter((note) => note.startsWith("[loadout] telemetry record not stored (EACCES)"));
  assert.equal(warnings.length, 1);
  host.shutdown();

  // Timeout: the Jev request is cut at 50 ms; the 300 ms guard budget never fires. Warn, and send no info line.
  fs.writeFileSync(
    GLOBAL_FILE(),
    JSON.stringify({
      skills: { enabled: true },
      backend: "jev",
      jev: { ...(endpointConfig().jev as Record<string, unknown>), timeoutMs: 50 },
    }),
  );
  reply.delayMs = 300;
  host = fakeHost("pi");
  assert.deepEqual(await promptInfo(host, "explain this"), []);
  const timedOut = await explainOf(host);
  const timeoutHeadline = /^ {2}outcome: (.*)$/m.exec(timedOut)?.[1] ?? "";
  assert.match(timeoutHeadline, /^classification failed: timeout after \d+ ms \(budget 300 ms\)$/);
  headlines.push(timeoutHeadline);
  assert.match(timedOut, /^ {2}timing: \d+ ms of 300 ms budget \(timeout 50 ms\), guard not fired$/m);
  assert.ok(host.notes.some((note) => note.startsWith("[loadout] classification failed (timeout)")));
  host.shutdown();

  assert.equal(headlines.length, 8);
  assert.equal(new Set(headlines).size, headlines.length, headlines.join("\n"));
});

test("extension: status prints safe effective settings only", async () => {
  const envName = "CANARY_ENV_NAME_K6";
  const jev = {
    ...(endpointConfig("?q=CANARY_QUERY_K4").jev as Record<string, unknown>),
    apiKeyEnvVar: envName,
    timeoutMs: 2500,
  };
  fs.writeFileSync(GLOBAL_FILE(), JSON.stringify({ skills: { enabled: true }, backend: "jev", jev }));
  process.env[envName] = "test-token";
  try {
    const host = fakeHost("pi");
    await host.prompt("explain this");
    const status = onlyNotice(await runCommand(host, "status")).message;
    const explain = await explainOf(host);
    assert.match(status, /^ {2}classifier: jev \| timeout 2500 ms$/m);
    assert.match(status, /^ {2}telemetry: on \(default\) \| records handed to host 1 \| failed 0$/m);
    // Guards: the canaries were in the config the plugin read, and the classifier call went out.
    const config = fs.readFileSync(GLOBAL_FILE(), "utf8");
    assert.match(config, /CANARY_QUERY_K4/);
    assert.match(config, new RegExp(envName));
    assert.equal(requests.length, 1);
    for (const text of [status, explain, JSON.stringify(host.entries)]) assert.doesNotMatch(text, /CANARY/);
    host.shutdown();
  } finally {
    delete process.env[envName];
  }
});

test("extension: status: collection provenance for every layer, and machine-off is a hard override", async () => {
  const provenance: Record<string, string> = {
    "machine-off":
      "hard machine-wide override in ~/.omp/loadout.*; no project, session or LOADOUT_CONFIG setting can turn it back on",
    "machine-unreadable":
      "the machine setting in ~/.omp/loadout.* could not be read; nothing is recorded (fail closed)",
    "config-error": "the config has an error; nothing is recorded until it is fixed and the session restarts",
    "config-off": "the effective config (explicit) sets telemetry false",
  };
  try {
    for (const { reason, arrange } of optOutLayers()) {
      writeConfig({});
      delete process.env.LOADOUT_CONFIG;
      arrange();
      requests.length = 0;
      const host = fakeHost("omp");
      await host.prompt("explain this");

      // machine-off and config-off keep selection on; an invalid config switches selection off and asks nothing.
      const selecting = reason === "machine-off" || reason === "config-off";
      assert.equal(requests.length, selecting ? 1 : 0, reason);
      assert.deepEqual(sorted(host.active()), sorted(selecting ? ANSWER_SET : BASELINE), reason);
      assert.deepEqual(host.entries, [], reason);
      assert.ok(!host.calls.includes("append"), reason);

      const status = onlyNotice(await runCommand(host, "status")).message.split("\n");
      assert.ok(status.includes(`  telemetry: off (${reason}) | records suppressed 1`), reason);
      assert.ok(status.includes(`  provenance: ${provenance[reason]}`), reason);

      const explain = await explainOf(host);
      assert.ok(explain.includes(`  source: in memory | record not stored: telemetry off (${reason})`), reason);
      assert.match(
        explain,
        selecting ? /^ {2}outcome: applied answer/m : /^ {2}outcome: skipped: selection is off$/m,
        reason,
      );
      host.shutdown();
    }
  } finally {
    delete process.env.LOADOUT_CONFIG;
  }
});

test("extension: status counts records and session coverage", async () => {
  for (const mode of ["on", "off"] as const) {
    if (mode === "off") writeConfig({ telemetry: false });
    const host = fakeHost("pi");
    await host.prompt("explain this");
    host.fire("agent_start");
    turn(host, "pi");
    turn(host, "pi", { turnIndex: 1 });
    await host.prompt("explain that");
    host.fire("agent_start");
    turn(host, "pi", { turnIndex: 2 });

    const status = onlyNotice(await runCommand(host, "status")).message;
    if (mode === "on") assert.match(status, /^ {2}telemetry: on \(default\) \| records handed to host 5 \| failed 0$/m);
    else assert.match(status, /^ {2}telemetry: off \(machine-off\) \| records suppressed 5$/m);
    assert.match(
      status,
      /^ {2}this session: prompts observed 2 \(classified 2, failed 0, skipped 0\) \| model turns observed 3 \|/m,
    );
    assert.match(
      status,
      /^ {2}not included: child and subagent sessions \(each has its own plugin instance and records\)$/m,
    );
    host.shutdown();
  }
});

test("extension: a config reload keeps the latest observation and the counters", async () => {
  const host = fakeHost("pi");
  await host.prompt("explain this");
  const other = path.join(path.dirname(project), "other-cwd");
  fs.mkdirSync(other, { recursive: true });
  host.setCwd(other);

  const explain = await explainOf(host);
  assert.match(explain, /^ {2}outcome: applied answer \(tools 4 of 7\); skills: 1 selected$/m);
  assert.match(explain, /^ {2}source: in memory \| record handed to host$/m);
  const status = onlyNotice(await runCommand(host, "status")).message;
  assert.match(status, /^ {2}last decision: applied answer \(tools 4 of 7\); skills: 1 selected$/m);
  assert.match(status, /^ {2}telemetry: on \(default\) \| records handed to host 1 \| failed 0$/m);
  assert.match(status, /^ {2}this session: prompts observed 1 \(classified 1, failed 0, skipped 0\)/m);
  host.shutdown();
});

test("extension: per-turn notice: one compact line after application, honors notify, never says applied for a dry run or a blocked proposal", async () => {
  writeConfig({ dryRun: true });
  let host = fakeHost("pi");
  const dry = onlyNotice(await promptInfo(host, "explain this")).message;
  assertCompact(dry);
  assert.match(dry, /^\[loadout\] dry run: would use answer \(tools 4\), nothing changed/);
  assert.doesNotMatch(dry, /\bapplied\b/i);
  host.shutdown();

  // Applied: one line, sent after the tools were set, so the notice's call count is past the set call.
  writeConfig({});
  host = fakeHost("pi");
  const applied = onlyNotice(await promptInfo(host, "explain this"));
  assertCompact(applied.message);
  assert.equal(applied.message, "[loadout] applied answer (tools 4 of 7); skills: 1 selected");
  assert.ok(applied.callsBefore > host.calls.indexOf("set"));
  host.shutdown();

  host = fakeHost("pi");
  WIDEN_TO_EDIT();
  await host.prompt("run the tests");
  reply.answers.tool_profile = answerReply({ answer: 0.9 });
  const blocked = onlyNotice(await promptInfo(host, "explain that")).message;
  assertCompact(blocked);
  assert.match(blocked, /^\[loadout\] kept edit: widen-only blocked narrowing to answer/);
  assert.doesNotMatch(blocked, /->/);
  assert.doesNotMatch(blocked, /\bapplied\b/i);
  host.shutdown();

  host = fakeHost("pi");
  WIDEN_TO_EDIT();
  await host.prompt("run the tests");
  WIDEN_TO_EDIT();
  const matching = onlyNotice(await promptInfo(host, "run them again")).message;
  assertCompact(matching);
  assert.match(matching, /^\[loadout\] already matching edit \(tools 6 of 7\)/);
  assert.doesNotMatch(matching, /\bapplied\b/i);
  host.shutdown();

  reply.answers.tool_profile = answerReply({ answer: 0.55, edit: 0.3, full: 0.15 });
  host = fakeHost("pi");
  const low = onlyNotice(await promptInfo(host, "explain this")).message;
  assertCompact(low);
  assert.match(low, /^\[loadout\] all tools kept: low confidence \(closest narrower risk 0\.15 > max 0\.10\)/);
  assert.doesNotMatch(low, /\bapplied\b/i);
  host.shutdown();

  writeConfig({ skills: { enabled: true, maxCandidates: 1 } });
  reply.answers.tool_profile = answerReply({ answer: 0.9 });
  host = fakeHost("pi");
  const limited = onlyNotice(await promptInfo(host, "explain this")).message;
  assertCompact(limited);
  assert.equal(limited, "[loadout] applied answer (tools 4 of 7); skills: 2 candidates > limit 1, none asked");
  host.shutdown();

  writeConfig({});
  host = fakeHost("pi");
  assert.deepEqual(await promptInfo(host, "/review"), []);
  assert.deepEqual(await promptInfo(host, "   "), []);
  host.shutdown();

  writeConfig({ notify: false });
  host = fakeHost("pi");
  assert.deepEqual(await promptInfo(host, "explain this"), []);
  reply = { status: 500, answers: {} };
  assert.deepEqual(await promptInfo(host, "now fix it"), []);
  assert.ok(
    host.notices.some(
      (notice) => notice.level === "warning" && /classification failed \(unavailable\)/.test(notice.message),
    ),
  );
  assert.match(onlyNotice(await runCommand(host, "status")).message, /^\[loadout\] status\n/);
  host.shutdown();
});

test("extension: a dry run reports what the widen-only ratchet would keep, never a narrowing it would refuse", async () => {
  // Answer, then a widening to edit, then answer again: the third proposal would narrow below the tools in force.
  writeConfig({ dryRun: true, skills: { enabled: false } });
  let host = fakeHost("pi");
  reply.answers.tool_profile = answerReply({ answer: 0.9 });
  assert.equal(
    onlyNotice(await promptInfo(host, "explain this")).message,
    "[loadout] dry run: would use answer (tools 4), nothing changed",
  );
  WIDEN_TO_EDIT();
  assert.equal(
    onlyNotice(await promptInfo(host, "run the tests")).message,
    "[loadout] dry run: would use edit (tools 6), nothing changed",
  );
  reply.answers.tool_profile = answerReply({ answer: 0.9 });
  const refused = onlyNotice(await promptInfo(host, "explain that")).message;
  assert.equal(refused, "[loadout] dry run: widen-only would keep edit, not answer; nothing changed");
  assertCompact(refused);
  const refusedExplain = await explainOf(host);
  assert.match(refusedExplain, /^ {2}ratchet: edit -> edit \(blocked, narrowing locked\)$/m);
  assert.match(refusedExplain, /^ {2}blocked: dry run, widen-only ratchet \(would keep edit\)$/m);
  assert.doesNotMatch(refusedExplain, /\bapplied\b/i);
  assert.deepEqual(host.active(), BASELINE, "a dry run changes no tool");
  assert.ok(!host.calls.includes("set"));
  host.shutdown();

  reply.answers.tool_profile = answerReply({ answer: 0.55, edit: 0.3, full: 0.15 });
  host = fakeHost("pi");
  assert.equal(
    onlyNotice(await promptInfo(host, "explain this")).message,
    "[loadout] dry run: would keep all tools (low confidence (closest narrower risk 0.15 > max 0.10))",
  );
  reply.answers.tool_profile = answerReply({ answer: 0.9 });
  const locked = onlyNotice(await promptInfo(host, "explain that")).message;
  assert.equal(locked, "[loadout] dry run: widen-only would keep full, not answer; nothing changed");
  const lockedExplain = await explainOf(host);
  assert.match(lockedExplain, /^ {2}ratchet: full -> full \(blocked, narrowing locked\)$/m);
  assert.match(lockedExplain, /^ {2}blocked: dry run, widen-only ratchet \(would keep full\)$/m);
  assert.match(
    onlyNotice(await runCommand(host, "status")).message,
    /^ {2}last decision: dry run: widen-only would keep full/m,
  );
  host.shutdown();

  writeConfig({ skills: { enabled: false } });
  reply.answers.tool_profile = answerReply({ answer: 0.55, edit: 0.3, full: 0.15 });
  host = fakeHost("pi");
  await host.prompt("explain this");
  reply.answers.tool_profile = answerReply({ answer: 0.9 });
  assert.equal(
    onlyNotice(await promptInfo(host, "explain that")).message,
    "[loadout] kept full: widen-only blocked narrowing to answer",
  );
  host.shutdown();
});

test("extension: commands add nothing to the model context or the session", async () => {
  const host = fakeHost("omp", { sessionFile: path.join(sessionDir(), "session.jsonl") });
  await host.prompt("explain this");
  const records = host.entries.length;
  for (const args of [
    "status",
    "explain",
    "stats",
    "stats --json",
    "stats export",
    "stats --since 2026-10-01",
    "bogus",
    "off",
    "on",
  ]) {
    await host.command(args);
    assert.equal(host.entries.length, records, args);
  }
  assert.deepEqual(
    host.notices.filter((notice) => notice.message.includes("selection error")),
    [],
  );
  // The next hook still returns only the skill hint: no command output reaches the model.
  const { result } = await host.prompt("explain that");
  assert.match(result?.message?.content ?? "", /^Skills most relevant to this request/);
  assert.doesNotMatch(result?.message?.content ?? "", /\[loadout\]/);
  host.shutdown();
});

test("extension: stats: current session by default, text and JSON agree, and JSON is the report library's summary", async () => {
  const file = path.join(sessionDir(), "session.jsonl");
  const host = fakeHost("omp", { sessionFile: file });
  for (let i = 0; i < 3; i++) {
    await host.prompt(`explain ${i}`);
    host.fire("agent_start");
    turn(host, "omp", { turnIndex: i });
  }
  const text = onlyNotice(await runCommand(host, "stats")).message;
  const json = JSON.parse(onlyNotice(await runCommand(host, "stats --json")).message);
  const exported = JSON.parse(onlyNotice(await runCommand(host, "stats export")).message);

  assert.equal(json.classifier.attempts, 3);
  assert.equal(json.usage.turns, 3);
  assert.match(text, /^ {2}classifier calls \(loadout\.decision attempts; not model turns\): 3$/m);
  assert.match(
    text,
    new RegExp(
      `^  model turns \\(loadout\\.usage; separate from classifier calls\\): ${json.usage.turns} in ${json.usage.runs} runs$`,
      "m",
    ),
  );
  assert.match(text, /^ {2}telemetry: on \(default\) \| this process handed 6 records to the host, failed 0$/m);
  assert.match(
    text,
    /^ {2}file: 3 decisions and 3 model-turn records were read here; this process handed 6 to the host/m,
  );
  // The JSON is the report library's own summary of this file; export is its export document.
  assert.deepEqual(json, JSON.parse(JSON.stringify(buildSummary(sessionSpec(file)))));
  assert.deepEqual(exported, JSON.parse(JSON.stringify(buildExport(sessionSpec(file)))));
  host.shutdown();
});

test("extension: stats refuses a partial history and reads only the named scope", async () => {
  const dir = sessionDir();
  const file = path.join(dir, "session.jsonl");
  const host = fakeHost("pi", { sessionFile: file });
  await host.prompt("explain this");

  const refusals: Array<[string, string]> = [
    [
      "stats --since 2026-10-01T00:00:00Z",
      "incomplete historical scope: missing --until, --project <path> or --all-projects",
    ],
    [
      "stats --since 2026-10-01T00:00:00Z --until 2026-10-02T00:00:00Z",
      "incomplete historical scope: missing --project <path> or --all-projects",
    ],
    [
      "stats --since 2026-10-01T00:00:00Z --until 2026-10-02T00:00:00Z --project /x --all-projects",
      "--project and --all-projects are mutually exclusive",
    ],
    [`stats --session ${file} --since 2026-10-01T00:00:00Z`, "--session cannot be combined with --since"],
    ["stats --version", "--version is not a stats option (see /loadout stats --help)"],
  ];
  for (const [args, reason] of refusals) {
    const notice = onlyNotice(await runCommand(host, args));
    assert.equal(notice.level, "warning", args);
    assert.equal(notice.message, `[loadout] stats: ${reason}`, args);
  }

  const since = new Date(Date.now() - 3_600_000).toISOString();
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const inWindow = onlyNotice(
    await runCommand(host, `stats --since ${since} --until ${until} --project ${project} --sessions-dir ${dir}`),
  ).message;
  assert.match(inWindow, /^\[loadout\] stats: history$/m);
  assert.match(
    inWindow,
    /^ {2}scope: history .* \| exact project match \| files 1 \(read 1, unreadable 0, skipped by mtime 0\) \| nested child sessions read separately 0$/m,
  );
  assert.match(inWindow, /^ {2}classifier calls \(loadout\.decision attempts; not model turns\): 1$/m);

  const elsewhere = path.join(path.dirname(project), "elsewhere");
  const other = onlyNotice(
    await runCommand(host, `stats --since ${since} --until ${until} --project ${elsewhere} --sessions-dir ${dir}`),
  ).message;
  assert.match(other, /no session files matched this scope; every count is zero/);
  host.shutdown();
});

test("extension: stats before the first session file explains itself", async () => {
  const none = fakeHost("pi");
  await none.prompt("explain this");
  const absent = onlyNotice(await runCommand(none, "stats"));
  assert.equal(absent.level, "info");
  assert.match(absent.message, /^\[loadout\] stats: no session file yet\. /);
  const bad = onlyNotice(await runCommand(none, "stats --sumary"));
  assert.equal(bad.level, "warning");
  assert.match(bad.message, /^\[loadout\] stats: /);
  assert.doesNotMatch(bad.message, /no session file yet/);
  none.shutdown();

  const file = path.join(sessionDir(), "session.jsonl");
  const pending = fakeHost("pi", { sessionFile: file });
  const asText = onlyNotice(await runCommand(pending, "stats"));
  const asJson = onlyNotice(await runCommand(pending, "stats --json"));
  assert.equal(asText.level, "info");
  assert.equal(asJson.level, "info");
  assert.match(asJson.message, /^\[loadout\] stats: no session file yet\. /);
  assert.throws(() => JSON.parse(asJson.message));
  assert.equal(fs.existsSync(file), false);
  pending.shutdown();
});

test("extension: stats works while opted out", async () => {
  const file = path.join(sessionDir(), "session.jsonl");
  const first = fakeHost("pi", { sessionFile: file });
  await first.prompt("explain this");
  first.shutdown();
  const before = fs.readFileSync(file, "utf8");

  writeConfig({ telemetry: false });
  const host = fakeHost("pi", { sessionFile: file });
  const text = onlyNotice(await runCommand(host, "stats")).message;
  assert.match(text, /^ {2}telemetry: off \(machine-off\) \| nothing from this process was stored \(0 suppressed\)/m);
  assert.match(text, /^ {2}classifier calls \(loadout\.decision attempts; not model turns\): 1$/m);
  assert.equal(host.entries.length, 0);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  host.shutdown();
});

test("extension: selection controls and usage text are preserved", async () => {
  const host = fakeHost("pi");
  await host.prompt("explain this");
  assert.notDeepEqual(host.active(), BASELINE);

  await host.command("off");
  assert.deepEqual(host.active(), BASELINE);
  await host.prompt("explain that");
  assert.equal(record(host).skip, "disabled");
  assert.equal(requests.length, 1);

  await host.command("on");
  await host.prompt("explain once more");
  assert.equal(requests.length, 2);
  assert.deepEqual(sorted(host.active()), sorted(ANSWER_SET));

  const usage = onlyNotice(await runCommand(host, "bogus"));
  assert.equal(usage.level, "warning");
  assert.equal(usage.message, "[loadout] usage: /loadout [status|on|off|explain|stats]");
  host.shutdown();
});

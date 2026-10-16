# Issue #2 — Privacy-safe decision and application traces: implementation plan

Issue andrevandal/pi-classifier-tools-skills#2 ("[Observability 1/7] Record privacy-safe decision and actual application traces"), epic #1.
Base `12752a5165e399d73ba5ea9648df9ddc8c37ef7f`. Worktree `/home/andrevandal/www/andrevandal/pi-classifier-tools-skills/.worktrees/issue-2`, branch `obs/issue-2-decision-traces`.

## 1. Context

Today `src/index.ts` (`onBeforeAgentStart`) appends a v2 `loadout.decision` with `pi.appendEntry` before it calls `activateTools`. That record's `applied` is a ratchet rank, not the host's real tool set. Its `message` can carry backend body text, because `src/classify/http.ts` embeds a 200-char snippet in the error. Turns that never classify (disabled, empty prompt, slash command, no questions) leave no trace. This slice replaces it with a v3 record built after apply/restore, adds a machine-level `telemetry:false` ceiling that nothing else can lift, and freezes the `loadout.usage` v1 and `loadout.http` v1 contracts for slices #4/#5. The frozen contracts are types, normalizers and docs only. It moves every reader (`scripts/lib/sessions.ts`, `scripts/decisions.ts`, `scripts/bench.ts`) onto a normalizer that reads v2 and v3. Selection behavior, the widen-only ratchet and every default are unchanged.

### Binding decisions (user-confirmed; do not reopen)

- **Record.** Keep entry type `loadout.decision`, bump to v3. One record per `before_agent_start` call, built AFTER apply/restore and appended once.
  - `outcome` is `classified|failed|skipped`.
  - `skip` is `disabled|empty-prompt|command|no-questions`.
  - It carries a safe settings snapshot and `classifier{requestId, sanitized model, elapsed/budget/timeout ms, guardFired, usage|null, server timing|null (#4 fills), status|null, promptChars/sentChars, question count}`.
  - It carries the tools proposal plus the risk of every narrower profile (same summation as `pickProfile`, null not 0 when there are no probabilities) plus `maxRisk`.
  - It carries skills `discovered/eligible/cap/asked/delivery`, the ratchet `{narrowAllowed, before, after, admitted}`, and `application{applied|unchanged|dry-run|not-admitted|restored|failed|not-attempted, restoration, actualTools via getActiveTools() read-back, safe error code}`.
  - The v2 `message` is dropped; v2 is normalized with missing = unknown.
- **IDs.** `sessionId` is the host id or null, never "unknown". The plugin makes `eventId` (fork dedup key), `decisionId` and `requestId` (UUIDv4, only when persisting).
- **Privacy/config.**
  - `telemetry:false` in `~/.omp/loadout.{json,yml,yaml}` is read outside the normal search and is a ceiling.
  - Project and `LOADOUT_CONFIG` files can only turn telemetry off.
  - Fail closed: an unreadable or non-boolean machine setting, or any config-search error, means no persistence.
  - It is applied at config load (session start, cwd/trust reload); restart is documented.
  - Skip records are always written when telemetry is on, including `enabled:false` and `/loadout off`.
  - Opt-out stops every plugin append. In-memory explain stays. The `loadout.skills` hint message stays (selection behavior, not telemetry).
- **Persistence.** `persistRecord` wraps `appendEntry` in a sync try/catch and classifies by `error.code` only. The outcome means "handed to host", never "durable".
  - pi throws EACCES but keeps the entry in memory.
  - OMP swallows disk errors, invisibly to the plugin.
  - Both defer writes until the first assistant message.
  - A telemetry failure can no longer abort the turn (today it does on pi).
- **Shared schemas frozen here.**
  - `loadout.usage` v1: per assistant message; `stopReason` is `stop|length|toolUse|error|aborted|other`; tokens `input/output/cacheRead/cacheWrite/reasoning` are each number|null; synthetic-failure zero usage = unknown; pi `hostEntryId` when given, OMP null; retry attempt is informational only.
  - `loadout.http` v1: `X-Request-Id` plus `Server-Timing` queue/infer, Laya-only; "ok" = the write did not raise, not delivery; never infer a timeout from EPIPE.
  - #2 defines types, normalizers and docs only; #4/#5 produce them.
- **Kept as-is (visible only).** The narrowing lock after any low-confidence or failed turn until compaction or `/loadout on|off`. The HTTP server's lack of a deadline.
- **Consumers.** Migrate sessions/decisions/bench and their tests minimally (skip counts; bench fails fast under machine-off and sets `telemetry:true` in arm configs). Replace the fake-omp fixture and version pins with behavior checks. Docs: new `docs/telemetry.md` plus README fixes.
- **Smoke.** Real OMP, the user's default model, at most 4 one-line turns. pi smoke is recorded as "not run".

### Planner-fixed details (not in the confirmed tree; binding on the implementer)

- **P1.** `TelemetryReason`/`TelemetryState` live in `src/types.ts`, so `telemetry.ts` does not depend on `config.ts`.
  - Reasons: `"machine-off"|"machine-unreadable"|"config-error"|"config-off"|"default"`, resolved in that precedence order.
  - `LoadoutConfig.telemetry: boolean` (default `true`).
  - `LoadResult` gains `telemetry` and `scope: "project"|"global"|"explicit"|null`.
- **P2.** `readMachineTelemetry(home, parseYaml?)` returns `"absent"|"on"|"off"|"unreadable"`.
  - It reads only the first *existing* of `loadout.json|yml|yaml` under `~/.omp` and never falls through to a later file.
  - Malformed, non-object, non-boolean `telemetry`, a non-ENOENT read error, or YAML without a parser all give `unreadable`.
  - `"on"` and `"absent"` behave identically (it is a ceiling, not a force).
- **P3.** `profileRisks` in `select.ts` is the single risk summation; `pickProfile` is rewritten on it with an identical signature.
- **P4.** v3 record shapes are those in Step 3.
  - `tools.active` keeps its v2 name and is documented as the *proposal*; the real set is `application.actualTools`.
  - `risks` is an ordered array, not a map.
  - `skills.filteredOut` is added so the issue's "filtering counts" are recorded.
  - Settings are nested and hold no paths, endpoints or env-var names.
  - The telemetry reason is not persisted (a persisted record implies `persist:true`).
- **P5.** Sanitizers are the Step 3 regexes. Invalid names in lists become `"(redacted)"`. Invalid map keys are dropped. Probability keys are limited to configured profile ids. Error codes come from a closed errno allowlist, else `"error"`.
- **P6.** `persistRecord` pre-validates with `JSON.stringify` (code `"serialize"`), so the host never receives an unserializable payload. It never throws.
  - The session keeps in-memory counters `{handedOff, suppressed, failed, lastFailure}`, shown in `/loadout status`.
  - The first persist failure per session emits one `warning` notice containing the code only.
- **P7.** `state.lastRecord` is updated only by non-skipped records, so a skip never replaces "last decision". The failure message stays in memory: `state.lastMessage` is set from `trace.message` in `recordDecision`, inside the same `if (record.outcome !== "skipped")` as `lastRecord`, so explain never pairs a skip's text with an older decision.
  - `state.lastDecisionId: string | null` is set to `record.decisionId` for every record built (skips included, persisted or not) and to `null` when building throws. It is carried across `ensureSession` reloads like `lastRecord`. It is #5's usage→decision link; `lastDecisionId !== lastRecord?.decisionId` means the latest call was a skip.
- **P8.** Gate rules:
  - A disabled/empty/command gate keeps `restoreBaseline` and records a skip.
  - The no-questions gate keeps its no-restore behavior and records skills counts via `decideSkills(config.skills, candidates, {})`.
  - Dry-run wins over the admitted check (the ratchet is still simulated).
  - If `ensureSession` throws, no record is written (fail closed).
  - `sessionKey` keeps its `"unknown"` Map-key fallback, but records use `sessionId: null`.
- **P9.** `requestId` is generated only when persisting and a request is actually issued (never on "warming"). `ClassifyOptions` gains `requestId?` and `telemetryOff?`. `ClassificationResult.timing?` and `ClassifierError.status?/timing?` are seams that #4 fills. Real runs show `status: null` and `server: null` until then.
- **P10.** Usage v1 includes `costTotal`, `toolCalls`, `toolErrors` and `errorStatus` beyond the confirmed field list. The epic text asks for "tool names/counts/error counts" and "stop/error info".
- **P11.** Readers:
  - Unknown or absent `v` is counted as `unsupportedDecisions`, never guessed at.
  - A v3 record with an invalid `eventId` is rejected; v2 has no eventId.
  - `decisions` counts non-skipped records only (the old denominator).
  - Bench picks the first non-skipped decision.
  - Bench `activeToolNames`/`applied` reflect the host's real state when v3 provides it.
- **P12.** `fake-omp.mjs` emits records through the real `buildDecisionRecord`/`decideTools`/`decideSkills`/`defaultConfig`/`settingsSnapshot` (Node type stripping), preceded by a skip record. Fixture and producer cannot drift.
- **P13.** `tests/turn.test.ts` is new. It is not in the HANDOFF lease table; the issue's source targets name "relevant turn/report tests". Flagged for orchestrator audit.
- **P14.** `package.json` `files` is `src, python, examples, README.md`, so `docs/` is not published. The README Telemetry section is therefore self-contained and links `docs/telemetry.md` only for full schemas. `package.json` is outside the lease and stays untouched.

## 2. Preconditions

1. **Worktree.** Work only in the worktree above. Check `git rev-parse HEAD` = `12752a5…`, `git branch --show-current` = `obs/issue-2-decision-traces`, and `git status --porcelain` empty. It has no `node_modules`. The anchor checkout is integration-only; never edit it.
2. **Runtime.** Node 26.11.1 (pinned in `~/.prototools:4`; `package.json` engines ≥ 22.18).
   - `node --test` strips types, so use erasable TypeScript only: no `enum`, `namespace` or parameter properties.
   - Imports end in `.ts`.
3. **Tooling.** `npm run` adds every ancestor's `node_modules/.bin` to PATH (`@npmcli/run-script/lib/set-path.js`), so the worktree resolves the anchor's `tsc`/`biome`/`@types/node`; no install is expected.
   - Contingency: if `npm run typecheck` or `npm run lint` reports a missing binary or types in the worktree, run `npm ci` in the worktree (never `npm install`; lockfiles are outside the lease). `git status --porcelain` must stay empty afterwards.
4. **Style.** biome.json: 2-space indent, width 120, double quotes, trailing commas, semicolons, `noNonNullAssertion` off. Biome checks only `src/**`, `tests/**`, `scripts/**`. tsconfig: strict, `noUncheckedIndexedAccess`, `allowImportingTsExtensions`, `types:["node"]`.
   - Type-only imports must use `import type` or inline `type`. Node strips types at runtime and the tsconfig has no `verbatimModuleSyntax`, so `tsc` will not catch a value import of an interface.
5. **Baseline.** Run the Step 0 baseline before any code edit and record the counts. HANDOFF.md reports 86 tests, typecheck and lint passing at this SHA in a previous session, not re-run. A pre-existing failure is recorded verbatim; the bar is "no new failure".
6. **Reference check.** Callsites at `12752a5`; re-`grep` before changing each symbol.

   | symbol | callsites |
   | --- | --- |
   | `TurnRecord` | `src/types.ts` (def, line 307-319), `src/turn.ts`, `src/index.ts`, `scripts/lib/sessions.ts`, `tests/extension.test.ts` |
   | `runTurn` / `TurnOutcome` | `src/turn.ts`, `src/index.ts` only (no test imports it) |
   | `errorText` | `src/turn.ts` (def), `src/index.ts`, `scripts/eval-classifier.ts:22` — keep the export |
   | `pickProfile` | `src/select.ts` (`decideTools`), `scripts/eval-classifier.ts` — keep the signature |
   | `profileOrder` | `src/select.ts`, `src/config.ts`, `src/index.ts`, `scripts/bench.ts`, `scripts/eval-classifier.ts` |
   | `loadConfig` / `LoadResult` | `src/index.ts` (`ensureSession`), `tests/config.test.ts`. `configCandidates` is used only inside `config.ts` |
   | `parseConfig` / `defaultConfig` | `scripts/bench.ts`, `scripts/eval-classifier.ts`, tests. `LoadoutConfig` is built literally only in `defaultConfig()` and `parseConfig`'s spread |
   | `DECISION_ENTRY` | duplicated at `src/index.ts:31` and `scripts/lib/sessions.ts:13` (only `sessions.ts` uses its copy) |
   | `Decision` / `UsageMetrics` / `metricsFor` / `addFile` / `emptyMetrics` | `scripts/lib/sessions.ts`; imported by `decisions.ts`, `bench.ts`, `tests/bench.test.ts`, `tests/sessions.test.ts` |
   | `ClassifyOptions` | `src/types.ts`; `src/classify/http.ts` and `laya.ts` read `.signal` only |
   | `new ClassifierError(` | `src/turn.ts:49`, `src/classify/http.ts` (several), `src/classify/laya.ts` (several). The constructor change is additive |

7. **Operational constraints.**
   - Never touch the Laya service on ports 8765/8766, the installed plugin, or `~/.omp/loadout.*`.
   - No push, PR or history rewrite (the orchestrator owns those).
   - Stage by explicit path, never `git add -A`.
   - `HANDOFF.md` at the anchor root is untracked reference only.
   - Post-approval orchestration (orchestrator, not the implementer): (a) Step 0 commits this plan alone as `docs/plans/observability/issue-2.md`; (b) the orchestrator records plan approval and this revision in the live ledger of the ignored `/home/andrevandal/www/andrevandal/pi-classifier-tools-skills/HANDOFF.md`; (c) the orchestrator removes the temporary probe dirs `/tmp/plan2-probe/` and `/tmp/pi-probe-0Bdrep/`; (d) push, PR, merge, public issue edits and service restarts are NOT part of this plan and need separate user authorization.

## 3. Approach

Write the tests of a step first, run them, and confirm they fail for the stated reason. Then implement and run the step's checks: `node --test tests/<file>.test.ts`, `npm run typecheck`, `npm run lint`. Commit after each step as listed in section 5. The cutover (Step 5) comes after the consumers (Step 4) on purpose: the normalizer already reads v2, so each commit builds and passes.

### Step 0 — Plan commit and baseline (no code)

1. `mkdir -p docs/plans/observability`. Copy this plan verbatim to `docs/plans/observability/issue-2.md`. Run `git add docs/plans/observability/issue-2.md` and commit it alone: `docs(plan): issue #2 decision traces plan`.
2. Run `npm test`, `npm run typecheck`, `npm run lint`. Record pass/fail counts for the PR body.

### Step 1 — `src/select.ts`: expose per-profile risks

Files: `src/select.ts`, `tests/select.test.ts`.

Tests first (import `profileRisks`, `pickProfile`; they fail with "does not provide an export named profileRisks"):
- `profileRisks(["answer","edit","full"], {answer:.42, edit:.31, full:.27})` ≈ `[{answer,.58},{edit,.27}]` (epsilon compare).
- `profileRisks(order, {})` and `{unrelated:1}` return `null`.
- `{full:.9}` returns `[{answer,.9},{edit,.9}]` (a key for the broadest profile counts as "has probabilities").
- `profileRisks(["full"], {full:1})` returns `[]`, and `pickProfile` returns `null`.
- Fixed-value table with `order=["answer","edit","full"]`, `maxRisk=0.1` (do not re-implement the old loop in the test):

  | probabilities | expected `pickProfile` |
  | --- | --- |
  | `{answer:.95,edit:.03,full:.02}` | `{answer, ≈.05}` |
  | `{answer:.5,edit:.45,full:.05}` | `{edit, ≈.05}` |
  | `{answer:.42,edit:.31,full:.27}` | `null` |
  | `{edit:.95,full:.05}` | `{edit, ≈.05}` |

Implement:
```ts
/** Risk of every profile narrower than the broadest: the probability mass on the profiles broader than it. Null when the
 * answer reports no probability for any profile (that would read as zero risk everywhere). */
export function profileRisks(order: string[], probabilities: Record<string, number>): Array<{ profile: string; risk: number }> | null {
  if (!order.some((id) => id in probabilities)) return null;
  return order.slice(0, -1).map((profile, i) => ({
    profile,
    risk: order.slice(i + 1).reduce((sum, id) => sum + (probabilities[id] ?? 0), 0),
  }));
}
export function pickProfile(order: string[], probabilities: Record<string, number>, maxRisk: number): { profile: string; risk: number } | null {
  return profileRisks(order, probabilities)?.find((entry) => entry.risk <= maxRisk) ?? null;
}
```
Keep the existing doc comment on `pickProfile` and move the "no probability" comment to `profileRisks`.

### Step 2 — Config: machine telemetry ceiling

Files: `src/types.ts`, `src/config.ts`, `tests/config.test.ts`.

`src/types.ts`:
- Add `telemetry: boolean` to `LoadoutConfig`, after `notify`. Doc comment: "Persist plugin-owned trace records; a machine-level `false` outranks this key."
- Add `telemetry?: boolean` to `LoadoutConfigInput`.
- Add:
```ts
export type TelemetryReason = "machine-off" | "machine-unreadable" | "config-error" | "config-off" | "default";
export interface TelemetryState { persist: boolean; reason: TelemetryReason }
```

`src/config.ts`:
- Header comment: add a paragraph on the machine ceiling, and fix the stale claim at `config.ts:13-15` ("rejected and the defaults apply"): the code turns the plugin off (`:166-171`). Make it say a file with a bad value is rejected, the plugin turns itself off and reports the error — matching the README fix in Step 6.
- `defaultConfig()`: add `telemetry: true`. `checkShape` then validates the boolean automatically; a non-boolean value rejects the file.
- Extract the inner `files` helper of `configCandidates` into module-level `configFiles(dir, scope)`. `configCandidates` calls it.
- Add `export type MachineTelemetry = "absent" | "on" | "off" | "unreadable"` and:
```ts
export function readMachineTelemetry(home: string, parseYaml: ((text: string) => unknown) | null = bunYaml()): MachineTelemetry {
  for (const source of configFiles(home, "global")) {
    let text: string;
    try { text = fs.readFileSync(source.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return "unreadable"; }
    let raw: unknown;
    try {
      if (source.path.endsWith(".json")) raw = JSON.parse(text);
      else if (parseYaml) raw = parseYaml(text);
      else return "unreadable";
    } catch { return "unreadable"; }
    if (!isRecord(raw)) return "unreadable";
    if (!Object.hasOwn(raw, "telemetry")) return "absent";
    return raw.telemetry === false ? "off" : raw.telemetry === true ? "on" : "unreadable";
  }
  return "absent";
}
```
- Rename the current `loadConfig` body to `searchConfig(cwd, options, home, parseYaml): Omit<LoadResult, "telemetry">`.
  - Its success return adds `scope: source.scope`; all other returns add `scope: null`.
- `LoadResult` gains `scope: ConfigSource["scope"] | null` and `telemetry: TelemetryState`.
- New `loadConfig`:
```ts
export function loadConfig(cwd: string, options: LoadOptions): LoadResult {
  const home = options.home ?? os.homedir();
  const parseYaml = options.parseYaml === undefined ? bunYaml() : options.parseYaml;
  const found = searchConfig(cwd, options, home, parseYaml);
  return { ...found, telemetry: resolveTelemetry(readMachineTelemetry(home, parseYaml), found) };
}
function resolveTelemetry(machine: MachineTelemetry, found: Omit<LoadResult, "telemetry">): TelemetryState {
  if (machine === "off") return { persist: false, reason: "machine-off" };
  if (machine === "unreadable") return { persist: false, reason: "machine-unreadable" };
  if (found.errors.length > 0) return { persist: false, reason: "config-error" };
  if (!found.config.telemetry) return { persist: false, reason: "config-off" };
  return { persist: true, reason: "default" };
}
```
- Untrusted project files, including their `telemetry` key, stay ignored. Selection-setting precedence is untouched.

Tests first in `tests/config.test.ts` (reuse `tempDirs`/`write`):
- No files: `telemetry` is `{persist:true, reason:"default"}` and `config.telemetry` is `true`. The existing "no file means the defaults" deepEqual still passes.
- Ceiling matrix, each expecting `{persist:false}`:

  | setup | reason |
  | --- | --- |
  | home `{telemetry:false}` + trusted project `{telemetry:true}` | `machine-off` |
  | home `{telemetry:false}` + `explicitPath` `{telemetry:true}` | `machine-off` |
  | home `{telemetry:true}` + project `{telemetry:false}` | `config-off` |
  | explicit `{telemetry:false}`, no machine file | `config-off` |
  | home `{telemetry:false}` and project `{dryRun:"x"}` (config error) | `machine-off` |
  | project `{dryRun:"x"}`, machine absent | `config-error` |
  | home `{telemetry:"no"}` | `machine-unreadable` |
  | home `{ not json` | `machine-unreadable` |
  | home `[]` | `machine-unreadable` |
  | home `loadout.yml` + `parseYaml:null` | `machine-unreadable` |
  | home `loadout.yml` + `parseYaml: () => ({telemetry:false})` | `machine-off` |

- `readMachineTelemetry` called directly: absent, on, off, only the first existing file counts (`.json` lacking the key + `.yml` with `false` ⇒ `absent`), and a directory named `loadout.json` ⇒ `unreadable`.
- `scope` is `"project"`/`"global"`/`"explicit"`/`null` as appropriate.
- `parseConfig({telemetry:"no"})` has an error naming `telemetry`. The shipped example test must still pass (`examples/loadout.json` is unchanged).

### Step 3 — `src/telemetry.ts` and classifier seams

Files: `src/types.ts`, new `src/telemetry.ts`, new `tests/telemetry.test.ts`.

`src/types.ts` additions (additive):
```ts
/** Server-measured phases of one classification, in ms. Absent = unknown; 0 = measured zero. */
export interface ServerTiming { queueMs?: number; inferenceMs?: number }
export interface ClassifyOptions {
  signal?: AbortSignal;
  /** UUIDv4 offered to the transport; set only when the caller persists telemetry. A record carries it even when the transport failed before sending (e.g. Jev token unset). Only the Laya HTTP transport may forward it. */
  requestId?: string;
  /** The caller opted out of telemetry: a transport that records requests must not record this one. */
  telemetryOff?: boolean;
}
// ClassificationResult: add `timing?: ServerTiming;`
// ClassifierError: add `readonly status?: number; readonly timing?: ServerTiming;` and
// constructor(backend, code, message, options?: { cause?: unknown; status?: number; timing?: ServerTiming })
//   { super(message, options); …existing…; this.status = options?.status; this.timing = options?.timing; }
```
`src/classify/*` is not touched; #4 fills these.

`src/telemetry.ts` imports only `node:crypto`, `./select.ts` (`profileRisks`) and `./types.ts`. Exports:

- **Constants and ids.**
  - `DECISION_ENTRY="loadout.decision"`, `USAGE_ENTRY="loadout.usage"`, `HTTP_ENTRY="loadout.http"`.
  - `ID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`.
  - `newId=()=>randomUUID()`.
- **Private patterns.**
  - `SAFE_NAME=/^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,99}$/`.
  - `MODEL=/^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,63}$/`.
  - `SESSION_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`.
  - `ERROR_CLASS=/^[A-Za-z][A-Za-z0-9_]{0,63}$/`.
  - `ISO_UTC=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/`.
- **Sanitizers (exported for `turn.ts` and tests).**
  - `safeModel(v): string|null` — MODEL else null.
  - `safeStatus(v): number|null` — integer 100..599.
  - `safeUsage(v): {inputTokens:number|null; outputTokens:number|null}|null` — reads `input_tokens`/`output_tokens` only; each must be a safe integer ≥ 0; null when neither is valid.
  - `safeTiming(v): {queueMs:number|null; inferenceMs:number|null}|null` — finite ≥ 0 each; null when both invalid.
  - `safeErrorCode(error): string` — total, never throws: `try { const c = (error as { code?: unknown } | null)?.code; return typeof c === "string" && ERRNO.has(c) ? c : "error"; } catch { return "error"; }` where `ERRNO` = {EACCES, EPERM, ENOENT, ENOSPC, EROFS, EIO, EMFILE, ENFILE, EDQUOT, EBUSY, EISDIR, ENOTDIR, ENAMETOOLONG, ELOOP}.
  - Internal helpers: `count` (safe integer ≥ 0), `measure` (finite ≥ 0), `finite`, `oneOf`, `id`, name-list (invalid ⇒ `"(redacted)"`), `numberMap(source, allowedKeys?)` (keys must match SAFE_NAME and be in `allowedKeys` if given, values finite; plain `{}` result).

Types (all exported):
```ts
export type SkipReason = "disabled" | "empty-prompt" | "command" | "no-questions";
export type DecisionOutcome = "classified" | "failed" | "skipped";
export type SkillDelivery = "filter" | "hint" | "none" | "dry-run";
export type Restoration = "restored" | "unchanged" | "failed";
export type ApplicationStatus = "applied" | "unchanged" | "dry-run" | "not-admitted" | "restored" | "failed" | "not-attempted";
export interface SafeSettings {
  enabled: boolean; backend: "jev" | "laya"; transport: LayaTransport | null; dryRun: boolean; notify: boolean;
  maxPromptChars: number | null; configScope: "default" | "project" | "global" | "explicit";
  tools: { enabled: boolean; maxRisk: number };
  skills: { enabled: boolean; mode: SkillsMode; threshold: number; maxSkills: number; maxCandidates: number };
}
export interface ClassifierEvidence {
  requestId: string | null; model: string | null; elapsedMs: number; budgetMs: number; timeoutMs: number; guardFired: boolean;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  server: { queueMs: number | null; inferenceMs: number | null } | null;
  status: number | null; promptChars: number; sentChars: number; questions: number;
}
export interface ProfileRisk { profile: string; risk: number | null }
export interface ToolsRecord {
  reason: ToolsReason; profile: string | null;
  /** The proposal (tools asked for), or null = keep the baseline. NOT what the host ran: see `application.actualTools`. */
  active: string[] | null;
  probabilities: Record<string, number>; risk: number | null;
  /** Every profile narrower than the broadest, in profileOrder; null when the answer had no probability. */
  risks: ProfileRisk[] | null; maxRisk: number;
}
export interface SkillsRecord {
  reason: SkillsReason | null; selected: string[] | null; scores: Record<string, number>;
  discovered: number; eligible: number; maxCandidates: number; asked: number;
  /** Skills removed from the host prompt by the filter; null unless delivery is "filter". */
  filteredOut: number | null; delivery: SkillDelivery;
}
export interface SkillsEvidence { discovered: number; eligible: number; maxCandidates: number; asked: number; filteredOut: number | null; delivery: SkillDelivery; decision: SkillsDecision | null }
export interface RatchetRecord { narrowAllowed: boolean; before: string | null; after: string | null; admitted: boolean }
export interface ApplicationRecord { status: ApplicationStatus; restoration: Restoration | null; actualTools: string[] | null; error: string | null }
export interface DecisionRecordV3 {
  v: 3; eventId: string; sessionId: string | null; decisionId: string; outcome: DecisionOutcome;
  skip: SkipReason | null; failure: FailureReason | null; settings: SafeSettings; classifier: ClassifierEvidence | null;
  tools: ToolsRecord | null; skills: SkillsRecord | null; ratchet: RatchetRecord | null; application: ApplicationRecord;
}
```
Semantics: `eligible = discovered − (skills.exclude ∪ skills.alwaysInclude)`, per `skillCandidates`. `asked = skillsAskable(...) ? eligible : 0`. `ratchet.narrowAllowed` is the value *before* this decision.

Functions:

- `settingsSnapshot(config: LoadoutConfig, scope: "project"|"global"|"explicit"|null): SafeSettings`. `transport` is `config.laya.transport` only when the backend is laya. `configScope` is `scope ?? "default"`. It never copies endpoints, env-var names, paths, rubrics or profile tool lists.
- `buildDecisionRecord(input: DecisionInput): DecisionRecordV3` is pure and never throws on hostile input:
  ```ts
  export interface DecisionInput {
    eventId: string; decisionId: string; sessionId: string | null; settings: SafeSettings;
    gate: SkipReason | null;             // set => outcome "skipped"
    failure: FailureReason | null;       // used when no gate and no decision; default "error"
    classifier: ClassifierEvidence | null; decision: LoadoutDecision | null;
    order: string[];                     // profileOrder(config.tools): the only profile ids a record may name
    maxRisk: number; skills: SkillsEvidence | null; ratchet: RatchetRecord | null; application: ApplicationRecord;
  }
  ```
  - `outcome = gate ? "skipped" : decision ? "classified" : "failed"`. `skip = gate`. `failure` is non-null only for `failed`. `sessionId` is kept only if it matches SESSION_ID, else null.
  - `tools` = null when there is no decision. Otherwise `reason` is copied; `profile` is kept only if it is in `order`; `active` is a name-list; `probabilities` = `numberMap(…, new Set(order))`; `risk` is finite or null; `risks` = `profileRisks(order, rawProbabilities)` mapped with non-finite ⇒ null (null when `profileRisks` is null); `maxRisk` is copied.
  - `skills` = null when `input.skills` is null. Otherwise counts and `delivery` come from `input.skills`; `reason = input.skills.decision?.reason ?? null`; `selected` = name-list of `input.skills.decision?.selected` or null; `scores = numberMap(input.skills.decision?.scores ?? {})`.
  - `classifier` is re-sanitized for fields a backend or host can influence: `requestId` must match ID_PATTERN; `model`, `usage`, `server` and `status` go through the sanitizers. In-process numbers are rounded to integers ≥ 0.
  - `application.actualTools` is a name-list or null. `application.error` passes through `safeErrorCode` shape: it is `null` or a string in the errno allowlist or `"error"`.
- `PersistResult = {outcome:"handed-off"} | {outcome:"suppressed"} | {outcome:"failed"; code:string}` and:
  ```ts
  export function persistRecord(append: (type: string, data: unknown) => void, state: TelemetryState, type: string, record: unknown): PersistResult {
    if (!state.persist) return { outcome: "suppressed" };
    try { JSON.stringify(record); } catch { return { outcome: "failed", code: "serialize" }; }
    try { append(type, record); return { outcome: "handed-off" }; }
    catch (error) { return { outcome: "failed", code: safeErrorCode(error) }; }
  }
  ```
  The pre-check exists because OMP's `#lineFor` would latch a disk failure on an unserializable payload and pi's fork would throw later.
- Usage v1 and HTTP v1 types (defined, no producer):
  ```ts
  export interface UsageObservationV1 {
    v: 1; eventId: string; sessionId: string | null; runId: string; decisionId: string | null; turnIndex: number | null;
    host: "omp" | "pi"; hostEntryId: string | null;
    stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | "other" | null;
    tokens: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; reasoning: number | null };
    costTotal: number | null; toolCalls: Record<string, number>; toolErrors: number | null; errorStatus: number | null; retryAttempt: number | null;
  }
  export interface HttpServerRecordV1 {
    type: "loadout.http"; v: 1; requestId: string | null; idStatus: "valid" | "absent" | "invalid";
    at: string; outcome: "ok" | "client-gone" | "error" | "rejected"; status: number | null;
    queueMs: number | null; inferenceMs: number | null; totalMs: number | null; errorClass: string | null;
  }
  ```
- **Reader side.**
  ```ts
  export type Nullable<T> = { [K in keyof T]: T[K] | null };
  export interface DecisionView {
    version: 2 | 3; eventId: string | null; decisionId: string | null; sessionId: string | null; outcome: DecisionOutcome;
    skip: SkipReason | null; failure: FailureReason | null; backend: "jev" | "laya" | null; dryRun: boolean | null; latencyMs: number | null;
    settings: SafeSettings | null; classifier: Nullable<ClassifierEvidence> | null; tools: ToolsView | null; skills: SkillsView | null;
    ratchet: Nullable<RatchetRecord> | null; application: ApplicationRecord | null;
  }
  export type ToolsView = Nullable<Omit<ToolsRecord, "reason" | "probabilities">> & { reason: ToolsReason; probabilities: Record<string, number> };
  export type SkillsView = Nullable<Omit<SkillsRecord, "scores">> & { scores: Record<string, number> };
  ```
  - `normalizeDecision(data: unknown): DecisionView | null` re-allowlists every field through the same primitives. Unknown fields are dropped. Sub-objects that are invalid become null; a numeric field that is invalid becomes null.
  - v3 requires a valid `eventId` and a valid `outcome`; otherwise it returns null. `dryRun`/`backend` come from `settings`, `latencyMs` from `classifier.elapsedMs`.
  - v2 requires the `failure` key; otherwise it returns null. `message` is ignored. `outcome = failure === null ? "classified" : "failed"`. `ratchet = {narrowAllowed:null, before:null, after:<v2 applied>, admitted:null}`. `settings`, `classifier`, `application`, `eventId`, `decisionId`, `sessionId` and `skip` are null. `tools.risks`/`maxRisk` are null. The `skills` counts and `delivery` are null. `dryRun`, `backend` and `latencyMs` come from the v2 fields.
  - Any other or absent `v` returns null.
  - `normalizeUsage(data): UsageObservationV1 | null` returns null when `v!==1`, `eventId`/`runId` don't match ID_PATTERN, or `host` is not omp/pi. Counts, durations and names are sanitized; `stopReason` outside the enum becomes `"other"`; `hostEntryId` must match SESSION_ID, else null.
  - `normalizeHttp(data): HttpServerRecordV1 | null` returns null when `type!=="loadout.http"`, `v!==1`, `at` doesn't match ISO_UTC, or `outcome` is outside its enum. `requestId = id(data.requestId)`; `idStatus = requestId!==null ? "valid" : claimed==="absent" ? "absent" : "invalid"`; `status` is 100..599 or null; `errorClass` must match ERROR_CLASS.

Tests first (`tests/telemetry.test.ts`; they fail with module-not-found):
- ids: `newId()` matches ID_PATTERN, two calls differ, uppercase/UUIDv1/junk fail the pattern.
- `safeModel`: `"jev-latest"` ok; `"a b"`, 65 chars, `""`, non-string ⇒ null.
- `safeStatus`: 503 ok; 99, 600, 1.5, `"503"`, NaN ⇒ null.
- `safeUsage`: `{input_tokens:11, output_tokens:7, secret:"x"}` ⇒ `{inputTokens:11, outputTokens:7}`; `{input_tokens:5}` ⇒ `{5, null}`; negatives/NaN ⇒ null.
- `safeTiming`: `{queueMs:3, inferenceMs:"x"}` ⇒ `{3, null}`; `{}` ⇒ null.
- `safeErrorCode`: EACCES passes; ECONNRESET, a message-only Error, a string and null ⇒ `"error"`.
- `persistRecord`:
  - suppressed: append is not called.
  - handed-off: append is called once with `(type, sameReference)`.
  - EACCES whose message holds a path ⇒ `{failed, code:"EACCES"}`, and the path is absent from `JSON.stringify(result)`.
  - Non-Error throw ⇒ code `"error"`.
  - BigInt payload and circular payload ⇒ `{failed, code:"serialize"}`, append never called.
  - It never throws.
- `buildDecisionRecord`:
  - One case per outcome (classified, skipped gate wins over a decision, failed defaults to `"error"`).
  - `risks` null when no probabilities; non-finite ⇒ null.
  - Unknown probability keys and bad score keys are dropped; a bad list name ⇒ `"(redacted)"`.
  - Hostile classifier evidence is re-sanitized (prose model ⇒ null, extra usage keys gone).
  - Invalid sessionId ⇒ null.
  - `JSON.stringify(record)` contains none of the canaries placed in descriptions/rubrics/model/usage extras.
  - Determinism.
- `settingsSnapshot`: build a config whose `jev.endpoint`, `laya.endpoint`, `apiKeyEnvVar`s, `pythonBin`, `workerScript` and `tools.question.instructions` hold canaries; the snapshot JSON contains none.
- `normalizeDecision`:
  - v3 round trip (build, `JSON.parse(JSON.stringify())`, view fields equal).
  - v2 mapping per the rules above, with a `message:"CANARY"` input absent from the view.
  - v2 without `failure`, no `v`, `v:4`, v3 with a bad eventId, non-objects ⇒ null.
  - Hostile v3 (extra keys, NaN, weird names, prose model) ⇒ allowlisted view.
- `normalizeUsage`/`normalizeHttp`: valid cases; invalid host/eventId ⇒ null; negative tokens ⇒ null fields; the idStatus consistency table (valid id ⇒ `valid`; claimed `valid` with no id ⇒ `invalid`; `absent` ⇒ `absent`; garbage ⇒ `invalid`); bad `at` ⇒ null; `errorClass` pattern; `status` 99 ⇒ null.

### Step 4 — Consumers: readers, fixture and their tests

Files: `scripts/lib/sessions.ts`, `scripts/decisions.ts`, `scripts/bench.ts`, `tests/fixtures/fake-omp.mjs`, `tests/sessions.test.ts`, `tests/bench.test.ts`.

Tests first:
- `tests/sessions.test.ts`: replace "transcripts from before record version 2 are skipped…" with a behavior test. Write one file containing, as entries via `decisionEntry`:
  - a v2 classified record with `message:"CANARY"` and `applied:"answer"`;
  - a v3 skipped record built with `buildDecisionRecord` (`gate:"command"`);
  - an unversioned record `{tools:{profile:"full"}}`;
  - a `v:4` record;
  - a v2 record lacking the `failure` key.

  Assert: `decisions.length===2`; `unsupportedDecisions===3`; the v2 view has `version 2`, `eventId null`, `outcome "classified"`, `application null`, `ratchet.after "answer"`, and its JSON lacks "CANARY"; the v3 view has `outcome "skipped"` and `skip "command"`.
- `tests/bench.test.ts`:
  - Module-level `const HOME = fs.mkdtempSync(...)` (an empty temp dir). `runScript` spawns with `{ ...process.env, HOME, ...env }` so the real `~/.omp/loadout.*` of a developer can't change results.
  - Strengthen the first test: `rows.every(r => r.profile==="answer")`; loadout rows have `applied==="answer"` and `activeToolNames` of length 4; control rows have `applied===null` and `activeToolNames` of length 7; arm configs map to `[backend, dryRun, telemetry]` = `[["laya",false,true],["laya",true,true]]`.
  - In the decisions test: `report.decisions===4`, `report.skipped` deepEquals `{command:4}`, `report.unsupported===0`, plus the existing assertions. With `--folder wt-control`, `decisions===2`.
  - New "bench refuses to run when the machine opts out of telemetry": a temp HOME with `.omp/loadout.json={"telemetry":false}`, run with `--config ctx.config` ⇒ exit 1, stderr matches /telemetry/, and `fs.existsSync(ctx.out)` is false (nothing created).
  - New "…when the machine telemetry setting is unreadable": HOME `.omp/loadout.json` = `{`; run with `--config ctx.config` ⇒ exit 1, stderr /telemetry/, `!fs.existsSync(ctx.out)`. (`--config` is required: without it `loadBaseConfig` dies first on `JSON.parse`, `bench.ts:153-157`.)
  - They fail now because the fixture and readers are v2-only.

Implement:
- `scripts/lib/sessions.ts`:
  - Delete its `DECISION_ENTRY`; import `{ DECISION_ENTRY, normalizeDecision, type DecisionView }` from `../../src/telemetry.ts`. Remove the `TurnRecord` import.
  - `export type Decision = DecisionView & { timestamp?: string; file?: string };`
  - `UsageMetrics` gains `unsupportedDecisions: number` (doc: "`loadout.decision` entries of an unknown version or shape; counted, never guessed at"). `emptyMetrics` sets it to 0.
  - `addFile` replaces the `v===2` gate: `const view = normalizeDecision(entry.data); if (view === null) metrics.unsupportedDecisions++; else metrics.decisions.push({ ...view, timestamp: entry.timestamp as string, file }); continue;`.
- `scripts/decisions.ts`:
  - Take `const all = metricsFor(files)`; filter `all.decisions` by `--since` as today.
  - `summarize(all: Decision[], unsupported: number)`: `list = all.filter(d => d.outcome !== "skipped")`. Keep every existing metric computed from `list`, except that latencies drop nulls: `list.flatMap(d => d.latencyMs === null ? [] : [d.latencyMs])`. `dryRun` counts `d.dryRun === true`.
  - Add `skipped: countBy(skippedList, d => d.skip ?? "(unknown)")` and `unsupported`.
  - Text output: before the `decisions === 0` early exit, print `skipped: <reason n, …>` and `unsupported records: n (unknown version or shape; not counted above)` when non-zero. Print `skipped` as plain counts, not percentages.
- `scripts/bench.ts`:
  - Import `readMachineTelemetry` from `../src/config.ts`.
  - Immediately after the `parsed.errors` check and before any `git`/`mkdir`, add:
    ```ts
    const machine = readMachineTelemetry(os.homedir());
    if (machine === "off" || machine === "unreadable") {
      fail(machine === "off"
        ? "telemetry is off for this machine (~/.omp/loadout.* sets telemetry: false); the bench reads loadout.decision records and cannot run"
        : "the telemetry setting in ~/.omp/loadout.{json,yml,yaml} cannot be read here (malformed, not an object, not a boolean, or YAML without Bun); fix it first");
    }
    ```
  - Arm config: `{ ...base, enabled: true, dryRun: arm === "control", notify: false, telemetry: true }`.
  - `summarizeRun`:
    ```ts
    const decision = metrics.decisions.find((d) => d.outcome !== "skipped");
    const mismatch = metrics.decisions.some((d) => d.dryRun !== null && d.dryRun !== expectDryRun);
    // applied: v2 keeps its meaning (ratchet.after = old `applied`); v3 only when the plugin really settled on that profile
    const status = decision?.application?.status;
    const applied = decision === undefined ? null
      : decision.application === null || !["dry-run", "failed", "not-attempted"].includes(status ?? "") ? (decision.ratchet?.after ?? null) : null;
    const names = decision === undefined ? null : decision.application !== null ? decision.application.actualTools : (decision.tools?.active ?? null);
    ```
    - `activeToolNames = names`, `activeTools = names?.length ?? null`.
    - `warning = failure===null ? null : \`classifier failed (${failure})\``. A skipped-only session gets `only skipped decisions recorded (${metrics.decisions[0]?.skip})`. The no-decision text becomes `no loadout.decision recorded (plugin not loaded, or telemetry is off)`.
    - `decided` stays `decision !== undefined`.
  - Header comment: one sentence that the bench needs telemetry on.
- `tests/fixtures/fake-omp.mjs`:
  - Import `defaultConfig` from `../../src/config.ts`, `decideSkills`/`decideTools`/`profileOrder` from `../../src/select.ts`, `buildDecisionRecord`/`newId`/`settingsSnapshot` from `../../src/telemetry.ts`.
  - `full = {...defaultConfig(), backend: config.backend ?? "laya", dryRun: config.dryRun === true}`. `baseline = ["read","bash","edit","write","grep","find","ls"]`. `candidates = [{name:"pdf", description:"read and write PDF files"}]`.
  - `answers = {tool_profile:{type:"choice", choice:"answer", probabilities:{answer:.95, edit:.03, full:.02}, confidence:.95}, "skill:pdf":{type:"noul", noul:.9, confidence:.8}}`.
  - `decision = {tools: decideTools(full.tools, baseline, answers.tool_profile), skills: decideSkills({...full.skills, enabled:true}, candidates, answers)}`.
  - Entries: session header; a skip record (`gate:"command"`, `classifier:null`, `decision:null`, `skills:null`, `ratchet:null`, `application:{status:"not-attempted", restoration:null, actualTools:null, error:null}`); then a classified record.
    - Classified record: `ratchet {narrowAllowed:true, before:null, after:"answer", admitted:true}`; `skills` evidence with `delivery: full.dryRun ? "dry-run" : "hint"`; `application {status: full.dryRun ? "dry-run" : "applied", restoration:null, actualTools: full.dryRun ? baseline : decision.tools.active, error:null}`; classifier evidence with `elapsedMs:40`, `requestId:null`, other fields plain.
  - Keep the existing assistant/toolResult message entries, the worktree done.txt behavior and the "ANSWER: 42" output.
  - If `config.telemetry === false`, write no decision records.
  - Drop the hand-written impossible v2 record.

### Step 5 — Producer cutover

Files: `src/turn.ts`, `src/index.ts`, `src/types.ts` (delete `TurnRecord`), new `tests/turn.test.ts`, `tests/extension.test.ts`.

Edit order: `turn.ts`, then `index.ts`, then delete `TurnRecord` from `types.ts`, then tests green.

`src/turn.ts` (keep `errorText` exported; remove `failedTurn`):
```ts
export interface TurnInput { /* existing six fields */ /** Whether records are persisted this session: a request id exists only then. */ persist: boolean }
export interface TurnOutcome {
  decision: LoadoutDecision | null;       // null when the turn failed; the caller keeps the baseline
  failure: FailureReason | null;
  /** Human-readable failure text for notices and /loadout explain. Memory only: never put it in a record. */
  message: string | null;
  classifier: ClassifierEvidence;
}
export async function runTurn(input: TurnInput): Promise<TurnOutcome> {
  const { config, classifier, baseline, candidates } = input;
  const timeoutMs = config.backend === "laya" ? config.laya.timeoutMs : config.jev.timeoutMs;
  const budgetMs = Math.min(timeoutMs + GUARD_MS, MAX_BACKEND_TIMEOUT_MS);
  const sent = clipPrompt(input.prompt, config.maxPromptChars);
  const evidence: ClassifierEvidence = { requestId: null, model: null, elapsedMs: 0, budgetMs, timeoutMs, guardFired: false,
    usage: null, server: null, status: null, promptChars: input.prompt.length, sentChars: sent.length, questions: Object.keys(input.questions).length };
  const startedAt = performance.now();
  const finish = (): ClassifierEvidence => ({ ...evidence, elapsedMs: Math.round(performance.now() - startedAt) });
  const fail = (failure: FailureReason, message: string): TurnOutcome => ({ decision: null, failure, message, classifier: finish() });
  try {
    if (classifier.readiness() === "warming") return fail("warming", "classifier is still loading; using the full loadout");
    if (input.persist) evidence.requestId = newId();
    const result = await classify(input, sent, budgetMs, evidence);
    const decision: LoadoutDecision = {
      tools: decideTools(config.tools, baseline, result.answers[TOOLS_QUESTION_ID]),
      skills: decideSkills(config.skills, candidates, result.answers),
    };
    // Decision first: a sanitizer bug must never turn a decided turn into failure "error".
    evidence.model = safeModel(result.model); evidence.usage = safeUsage(result.usage); evidence.server = safeTiming(result.timing);
    return { decision, failure: null, message: null, classifier: finish() };
  } catch (error) {
    if (error instanceof ClassifierError) { evidence.status = safeStatus(error.status); evidence.server = safeTiming(error.timing); }
    return fail(error instanceof ClassifierError ? error.code : "error", errorText(error));
  }
}
```
`classify(input, sent, budget, evidence)` keeps the guard (`AbortController`, `Promise.withResolvers`, the timer). The timer sets `evidence.guardFired = true` before aborting. Its options are `{signal}` plus `requestId` when `evidence.requestId !== null` plus `telemetryOff:true` when `!input.persist`. It sends `sent` (the already clipped prompt), not the raw one.

`src/index.ts`:
- Remove the local `DECISION_ENTRY`; import `{ buildDecisionRecord, DECISION_ENTRY, newId, persistRecord, safeErrorCode, settingsSnapshot, type ApplicationStatus, type DecisionRecordV3, type RatchetRecord, type Restoration, type SkillDelivery, type SkillsDecision, type SkipReason }` from `./telemetry.ts`. Update the `types.ts` imports (`TurnRecord` out, `TelemetryState` and `SkillsDecision` in).
- `SessionState`: `lastRecord: DecisionRecordV3 | null`, plus `lastMessage: string | null`, `lastDecisionId: string | null`, `scope: "project" | "global" | "explicit" | null`, `telemetry: TelemetryState`, `collection: {handedOff:number; suppressed:number; failed:number; lastFailure:string | null}`. In `ensureSession` set `scope: result.scope`, `telemetry: result.telemetry`; carry `lastRecord`, `lastMessage`, `lastDecisionId` and `collection` from `existing`; the fresh `collection` is all zeros with `lastFailure: null`.
- Helpers:
  ```ts
  function hostSessionId(ctx: ExtensionContext): string | null {
    try { const id = ctx.sessionManager.getSessionId(); return typeof id === "string" && id !== "" ? id : null; } catch { return null; }
  }
  const sessionKey = (ctx: ExtensionContext): string => hostSessionId(ctx) ?? "unknown";   // Map key only; records use null
  function readTools(pi: ExtensionAPI): string[] | null { try { return [...pi.getActiveTools()]; } catch { return null; } }
  async function activateTools(pi, state, tools): Promise<boolean> {   // true when the setter ran
    const changed = !sameSet(pi.getActiveTools(), tools);
    if (changed) await pi.setActiveTools(tools);
    state.lastApplied = [...tools];
    return changed;
  }
  async function restoreBaseline(pi, state): Promise<"restored" | "unchanged" | null> {
    if (state.baseline === null || state.lastApplied === null) return null;
    return (await activateTools(pi, state, state.baseline)) ? "restored" : "unchanged";
  }
  ```
- `summarize(tools: Pick<ToolsRecord,"active"|"profile"|"risk"|"reason">, skills: {selected: string[] | null; reason: SkillsReason | null}, baselineSize: number)` has the same text as today (`ToolsDecision` and `SkillsDecision` satisfy it). Add `describe(record: DecisionRecordV3, message: string | null, baselineSize: number)`: if `tools` or `skills` is null return `failed (${record.failure ?? "error"}): ${message ?? "no details kept"}`, else `summarize(...)`.
- `failureNotice(failure: FailureReason, message: string | null)` has the same texts as today, with `message` passed in.
- Hook flow. Keep notices at their current positions and wording. Types for `HookTrace` and `HookResult` are local.
  ```ts
  interface HookTrace {
    decisionId: string; gate: SkipReason | null; turn: TurnOutcome | null;
    listed: boolean; discovered: number; eligible: number; asked: number; skillsDecision: SkillsDecision | null;
    delivery: SkillDelivery; filteredOut: number | null; ratchet: RatchetRecord | null;
    status: ApplicationStatus; restoration: Restoration | null; error: string | null; message: string | null;
  }
  async function onBeforeAgentStart(pi, event, ctx) {
    const trace: HookTrace = { decisionId: newId(), gate: null, turn: null, listed: false, discovered: 0, eligible: 0, asked: 0,
      skillsDecision: null, delivery: "none", filteredOut: null, ratchet: null, status: "not-attempted", restoration: null, error: null, message: null };
    let state: SessionState | undefined;
    let result: HookResult | undefined;
    try {
      state = ensureSession(ctx);
      result = await runHook(pi, event, ctx, state, trace);
    } catch (error) {
      if (!state) return;                              // fail closed: no record without a session
      trace.message = errorText(error);
      trace.status = "failed"; trace.error = safeErrorCode(error);
      const text = `selection error: ${errorText(error)}; using the full loadout until it recovers`;
      if (text !== state.lastFailure) { state.lastFailure = text; notify(ctx, state.config, text, "error"); }
      try { trace.restoration = await restoreBaseline(pi, state); } catch { trace.restoration = "failed"; }
    }
    recordDecision(pi, ctx, state, trace);
    return result;
  }
  ```
  - `runHook` (the old body, returning the old return values):
    - Gate: `!config.enabled ? "disabled" : prompt.trim()==="" ? "empty-prompt" : isSlashCommand(prompt) ? "command" : null`. If a gate applies: set `trace.gate`; `trace.restoration = await restoreBaseline(pi, state)`; `trace.status = trace.restoration ?? "not-attempted"`; return.
    - Else `baseline = refreshBaseline(...)`; `discovered = listSkills(pi, event)`; `candidates = skillCandidates(discovered, config.skills)`; set `trace.listed = true`, `discovered`, `eligible = candidates.length`.
    - `questions = buildQuestions(...)`. If it is empty: `trace.gate = "no-questions"`; `trace.skillsDecision = decideSkills(config.skills, candidates, {})`; return (no restore, as today).
    - `trace.asked = skillsAskable(config.skills, candidates) ? candidates.length : 0`.
    - `turn = await runTurn({ …existing, persist: state.telemetry.persist })`; `trace.turn = turn`; `trace.message = turn.message`; `decision = turn.decision`; `trace.skillsDecision = decision?.skills ?? null`.
    - Ratchet (same arithmetic as today): `order = profileOrder(config.tools)`, `broadest = order.length-1`, `target = decision?.tools.active ? order.indexOf(decision.tools.profile ?? "") : broadest`, `narrowAllowed = state.allowNarrow`, `before = rankName(state.appliedRank)`, `admitted = state.allowNarrow || state.appliedRank === null || target >= state.appliedRank`. If admitted, set `appliedRank = target` and `allowNarrow = false`. Then `trace.ratchet = {narrowAllowed, before, after: rankName(state.appliedRank), admitted}`, where `rankName(rank) = config.tools.enabled && rank !== null ? (order[rank] ?? null) : null`.
    - If `decision === null`: failure notice (`failureNotice(turn.failure ?? "error", turn.message)`, deduped through `state.lastFailure` as today); `trace.restoration = await restoreBaseline(...)`; `trace.status = trace.restoration ?? "not-attempted"`; return.
    - Otherwise: `state.lastFailure = null`; the info notice with `summarize(decision.tools, decision.skills, baseline.length)`.
      - If `config.dryRun`: `trace.status = "dry-run"`, `trace.delivery = decision.skills.selected === null ? "none" : "dry-run"` ("dry-run" never claims a suppressed delivery when none was due); return.
      - If admitted: `trace.status = (await activateTools(pi, state, decision.tools.active ?? baseline)) ? "applied" : "unchanged"`; otherwise `trace.status = "not-admitted"`.
      - Skill delivery as today. In the filter branch, compute `kept = promptSkills.filter(...)`, assign it to `event.systemPromptOptions.skills`, and set `trace.delivery = "filter"`, `trace.filteredOut = promptSkills.length - kept.length`. In the hint branch set `trace.delivery = "hint"` before returning the message. `selected === null` or an empty hint leaves `"none"`.
  - `recordDecision(pi, ctx, state, trace)` is `void`, never throws, and returns immediately if `state` is undefined:
    ```ts
    try {
      const { turn } = trace; const { config } = state;
      const record = buildDecisionRecord({
        eventId: newId(), decisionId: trace.decisionId, sessionId: hostSessionId(ctx), settings: settingsSnapshot(config, state.scope),
        gate: trace.gate, failure: turn?.failure ?? null, classifier: turn?.classifier ?? null, decision: turn?.decision ?? null,
        order: profileOrder(config.tools), maxRisk: config.tools.maxRisk,
        skills: trace.listed ? { discovered: trace.discovered, eligible: trace.eligible, maxCandidates: config.skills.maxCandidates,
          asked: trace.asked, filteredOut: trace.filteredOut, delivery: trace.delivery, decision: trace.skillsDecision } : null,
        ratchet: trace.ratchet,
        application: { status: trace.status, restoration: trace.restoration, actualTools: readTools(pi), error: trace.error },
      });
      state.lastDecisionId = record.decisionId;
      if (record.outcome !== "skipped") { state.lastRecord = record; state.lastMessage = trace.message; }
      countRecord(ctx, state, persistRecord((type, data) => pi.appendEntry(type, data), state.telemetry, DECISION_ENTRY, record));
    } catch { state.lastDecisionId = null; countRecord(ctx, state, { outcome: "failed", code: "error" }); }
    ```
    - `countRecord`: `handed-off` ⇒ `handedOff++`; `suppressed` ⇒ `suppressed++`; `failed` ⇒ `failed++`, `lastFailure = code`, and when `failed === 1` call `notify(ctx, state.config, \`telemetry record not stored (${code}); later failures are counted in /loadout status\`, "warning")`.
- `commandStatus`: append the line `telemetry: on | handed to host N | failed M[ (CODE)]` when `persist`, or `telemetry: off (<reason>) | suppressed N` when not. The last-decision line uses `describe(state.lastRecord, state.lastMessage, baselineSize)`.
- `commandExplain`:
  - Source is `state.lastRecord`. A failed or toolless record shows `describe(...)`, `latency: ${classifier?.elapsedMs ?? "-"}ms` and the application line.
  - For a decided record: keep the existing lines, but rename the label `active:` to `proposed:` and add:
    - `risks: answer=0.58 edit=0.27 (max 0.10)` (or `risks: none`);
    - `ratchet: <before> -> <after> (admitted|blocked, narrowing open|locked)`;
    - `application: <status>[ (restore: <restoration>)][ [<error>]] | actual tools: <list|unknown>`;
    - `skills: …` extended with `discovered N eligible M cap C asked A`; `latency: ${classifier.elapsedMs}ms`.
- Everything else (`/loadout on|off`, `session_*` handlers, classifier sharing) is unchanged.

Delete `TurnRecord` from `src/types.ts`. Afterwards `grep TurnRecord` must hit nothing in `src scripts tests README.md`.

Tests first (`tests/turn.test.ts`, new; use `defaultConfig()`, fake `Classifier` objects with `readiness()`, `classify()`, `dispose()`):
- persist true ⇒ `options.requestId` matches ID_PATTERN, `telemetryOff` undefined, and `outcome.classifier.requestId` equals it.
- persist false ⇒ `telemetryOff:true`, no `requestId`, evidence `requestId` null.
- warming ⇒ `classify` never called, failure `warming`, `requestId` null, `message` set.
- Guard: `config.laya.timeoutMs = 1` (default backend is `laya`, `config.ts:34`; `turn.ts:43` picks the backend's timeout) and a never-resolving classify ⇒ failure `timeout`, `guardFired` true, `budgetMs` 251, `timeoutMs` 1, and `options.signal.aborted` is true.
- A backend `ClassifierError("jev","timeout")` thrown immediately ⇒ `guardFired` false.
- Metadata sanitization: prose model ⇒ null; extra usage keys dropped; `usage:{input_tokens:-1}` ⇒ null.
- `ClassifierError(…,{status:503, timing:{queueMs:5, inferenceMs:7}})` ⇒ `status` 503 and `server {5,7}`; status 99 ⇒ null.
- `promptChars` > `sentChars` when `maxPromptChars:200` and a 500-char prompt; equal when short.
- A non-ClassifierError ⇒ failure `error`.
- `JSON.stringify(outcome.classifier)` never contains the canary placed in the error message.

Tests first (`tests/extension.test.ts`). Harness changes:
- Import `type { DecisionRecordV3 } from "../src/telemetry.ts"` instead of `TurnRecord`. Add `const record = (host, i) => host.entries[i]!.data as DecisionRecordV3`.
- `beforeEach`: also `delete process.env.LOADOUT_CONFIG` and `fs.rmSync(path.join(project, ".omp"), {recursive:true, force:true})`.
- Server reply: `{status, answers, body?, extra?}`. The handler responds with `res.end(reply.body ?? JSON.stringify({ ...reply.extra, answers: reply.answers }))`.
- Factor `endpointConfig()` out of `writeConfig`.
- `fakeHost(kind, options = {})` with `options.skills` (default `SKILLS`, used by both `getCommands` and pi's `systemPromptOptions.skills`), `options.sessionIdThrows`, `options.onAppend?: (call:number) => Error | undefined` (throw before storing), `options.onSet?: (call:number) => {error:Error; mutate:boolean} | undefined`. The setter assigns `active` first when `mutate`, then throws on pi or returns `Promise.reject` on omp. A `calls: string[]` log records `"set"`/`"append"`. Expose `host.sessionId`, `host.calls` and `host.setAppendFault(fn | null)`.

Updated and new tests (inputs ⇒ asserted outputs):
- Existing pi narrowing test: `const view = normalizeDecision(host.entries[0]!.data)`; assert `view !== null`, `view.outcome === "classified"`, `view.application?.status === "applied"`, and `view.application?.actualTools` set-equal to `host.active()`. No assertion on `v`. Request question keys unchanged.
- Existing dry-run test: `settings.dryRun true`, plus the new dry-run assertions below. Existing failure test: `outcome "failed"`, `failure "unavailable"`, `tools null`, `classifier.requestId` matches ID_PATTERN, `skills` has counts with `reason null`, `application.status "not-attempted"`.
- Existing ratchet test: replace `blocked.applied === "full"` with the widen-only assertions below.
- **Low confidence.** Reply `tool_profile = {choice:"answer", probabilities:{answer:.42, edit:.31, full:.27}}`. Expect `host.active()` equals BASELINE; `tools.reason "low-confidence"`, `tools.active null`, `tools.profile "full"`, `tools.risk null`, `tools.maxRisk 0.1`, `tools.risks` ≈ `[{answer,.58},{edit,.27}]`, `application.status "unchanged"`, `actualTools` equals BASELINE, `ratchet.admitted true`.
- **Dry run.** `writeConfig({dryRun:true})`. Expect `host.active()` equals BASELINE; `tools.active` is the 4-tool answer set; `application.status "dry-run"`; `actualTools` equals BASELINE; `skills.delivery "dry-run"`; `ratchet.after "answer"`; no `"set"` in `host.calls`.
- **Widen-only.**
  1. Default reply, so prompt 1 narrows.
  2. `full` reply `{full:.9}`.
  3. `answer` reply.

  Expect the last record: `application.status "not-admitted"`; `ratchet {narrowAllowed:false, before:"full", after:"full", admitted:false}`; `tools.profile "answer"` and `tools.active` is the answer set (the proposal); `actualTools` equals BASELINE. After `host.compact()` the next prompt is `applied` again.
- **Applied vs unchanged.**
  - Applied: status `applied`, `restoration null`, `actualTools` set-equals the answer set, exactly one `"set"`.
  - The same prompt twice: the second record is `unchanged` and the setter total stays 1.
- **Setter failure.** Prompt 1 (default reply) narrows; setter call 1 succeeds. Prompt 2 replies `tool_profile={type:"choice",choice:"edit",probabilities:{edit:0.95,full:0.05},confidence:0.95}`, which widens to `edit` (admitted). `onSet` call 2 returns `{error:Object.assign(new Error("boom /secret/path"),{code:"EIO"}),mutate:true}`.
  - pi: no throw; `host.active()` = BASELINE; record 2 has `outcome "classified"`, `tools.profile "edit"`, `application {status "failed", restoration "restored", error "EIO"}`, `actualTools` = BASELINE; its JSON lacks `/secret/path`.
  - omp kind: same assertions.
- **Restoration also fails (omp).** Same two prompts. `onSet` call 2 `{error,mutate:true}`, call 3 `{error,mutate:false}`. Expect `status "failed"`, `restoration "failed"`, `actualTools` set-equal to `["read","edit","write","grep","find","ls"]`.
- **First-turn setter failure (pi).** `onSet` call 1 `{error,mutate:true}`. Expect `status "failed"`, `restoration null`, `actualTools` = the answer set (restore is a no-op before any successful apply: `lastApplied` is set only after the setter succeeds, `index.ts:200-202,217-218`).
- Never change `restoreBaseline` to make these pass.
- **Skill overflow.** `writeConfig({skills:{enabled:true, maxCandidates:1}})`. Expect request question keys `["tool_profile"]`; `skills.reason "too-many-candidates"`, `discovered 2`, `eligible 2`, `maxCandidates 1`, `asked 0`, `scores {}`, `selected null`, `delivery "none"`, `filteredOut null`; tools were still decided and applied.
- **Skip records.**
  - `"   "` ⇒ `outcome "skipped"`, `skip "empty-prompt"`, `classifier/tools/skills/ratchet` null, `application.status "not-attempted"`.
  - Narrow, then `/review` ⇒ `skip "command"`, `status "restored"`, `restoration "restored"`, `actualTools` equals BASELINE, `requests.length` stays 1.
  - `writeConfig({enabled:false})` ⇒ `skip "disabled"`.
  - Narrow, `/loadout off`, then a prompt ⇒ `skip "disabled"`, `status "unchanged"`.
  - `writeConfig({tools:{enabled:false}, skills:{enabled:false}})` ⇒ `requests.length 0`, `skip "no-questions"`, `skills.reason "disabled"`, `discovered 2`, `eligible 2`, `asked 0`.
  - `writeConfig({tools:{enabled:false}, skills:{enabled:true, maxCandidates:1}})` ⇒ `requests.length 0`, `skip "no-questions"`, `skills.reason "too-many-candidates"` (`writeConfig` replaces `skills` wholesale, `extension.test.ts:34-37`, so `enabled` must be explicit).
  - A skip does not replace `/loadout explain`'s last decision.
- **Ordering and count.** On the narrowing prompt, `calls` shows `"set"` before `"append"`. Over 3 prompts there are exactly 3 entries.
- **Session id.** `record.sessionId === host.sessionId`; with `sessionIdThrows` it is `null`.
- **Machine opt-out (acceptance 6).** Each case asserts `host.entries.length===0`, `host.active()` is still the narrowed answer set, and `requests.length` is 1 per prompt. Then `host.command("explain")` notices include `profile answer` and `application: applied`, and `host.command("status")` contains `telemetry: off (machine-off)`.
  - Global machine file `{telemetry:false}` with `writeConfig`'s endpoint (default enable).
  - Trusted project `.omp/loadout.json` with `telemetry:true` plus the endpoint config; the machine file is `{telemetry:false}` written to the global path.
  - `LOADOUT_CONFIG` pointing at a file with `telemetry:true` plus the endpoint config; the global file is `{telemetry:false}`.
  - `/loadout off`, a prompt, `/loadout on`, a prompt: zero entries.
- **Fail closed.**
  - The existing out-of-range timeout file ⇒ 0 entries and status `off (config-error)`.
  - Global file `{ not json` ⇒ 0 entries and `machine-unreadable`.
  - Global file `{"telemetry":"no"}` ⇒ 0 entries and `machine-unreadable`.
- **Load-time semantics.** Start a host, prompt once (1 entry). Then `writeConfig({telemetry:false})` and prompt again: still 2 entries. The test's title says the opt-out is read when the session loads its config.
- **Canary (acceptance 7).**
  - Setup:
    - Skill descriptions contain `CANARY_SKILL_DESC_B2`.
    - The prompt contains `CANARY_PROMPT_A1`.
    - `tools.question.instructions` is `CANARY_RUBRIC_C3` with the default criteria.
    - The endpoint is `<base>?q=CANARY_QUERY_D4`.
    - `process.env[TOKEN_VAR]="CANARY_TOKEN_E5"` (restore it afterwards).
    - Run 1: reply 200 with `extra:{model:"CANARY_MODEL_G7 prose that is not a model id", usage:{input_tokens:11, output_tokens:7, secret:"CANARY_USAGE_H8"}}` and `probabilities:{answer:.9, CANARY_PROB_I9:.1}`.
    - Run 2: reply 500 with `body:"upstream said CANARY_BODY_F6"`.
  - Assert:
    - `JSON.stringify(host.entries)` contains no `CANARY`.
    - Run 1: `classifier.model===null`, `classifier.usage` deepEquals `{inputTokens:11, outputTokens:7}`, `tools.probabilities` has only profile ids.
    - Guards against a vacuous pass: `JSON.stringify(requests)` contains `CANARY_PROMPT_A1` and `CANARY_SKILL_DESC_B2`, and `host.notes.join()` contains `CANARY_BODY_F6` (in-memory diagnostics survive).
- **Persist failure (acceptance 9).**
  1. `fakeHost("pi",{onAppend: () => Object.assign(new Error("EACCES: permission denied, open '/home/x/secret-dir/s.jsonl'"), {code:"EACCES"})})`.
  2. `await host.prompt("explain this")` does not throw. `host.active()` is the 4-tool answer set. `host.entries.length===0`. Exactly one note matches `/telemetry record not stored \(EACCES\)/`.
  3. A second prompt adds no second such note.
  4. `host.setAppendFault(null)`, a third prompt gives `entries.length===1`.
  5. `host.command("status")` shows `failed 2 (EACCES)` and `handed to host 1`.
  6. No entry and no note contains `secret-dir`.

### Step 6 — Documentation

Files: new `docs/telemetry.md`, `README.md`.

`docs/telemetry.md` sections, in order:
1. Overview: which entries exist and who produces them (`loadout.decision` v3 now; `loadout.usage` v1 and `loadout.http` v1 are defined here with no producer yet — #4/#5).
2. Privacy: never stored (prompt text, skill descriptions, rubrics, endpoints, env-var names, paths, backend response/error text, arbitrary payloads), and stored (allowlisted identifiers, counts, durations). Tool/skill names are stored as identifiers if they match the name pattern, otherwise `(redacted)`. Truncation is plugin-side only: `promptChars` > `sentChars`; backend-side truncation is unknown.
3. Opt-out and precedence: the reason table in precedence order; machine file lookup (first existing file only); project and `LOADOUT_CONFIG` can only turn off; fail-closed cases; load-time application and restart; what opt-out does not stop (host conversation logging, the `loadout.skills` hint message, which the host may store; in-memory explain/status).
4. `loadout.decision` v3: a field table from the `telemetry.ts` interfaces. Include `application.status` semantics: `applied`, `unchanged` (target equals the active set; no setter call), `dry-run`, `not-admitted`, `restored`, `failed`, `not-attempted` (nothing to apply or restore). `tools.active` is the proposal and `actualTools` is a read-back.
5. Units and unknowns: ms; chars = JS string length; counts are integers; `null` = unknown or not applicable; `0` = measured zero.
6. IDs: `eventId` (fork dedup key), `decisionId`, `requestId` ("offered to the transport"; a record carries it even when the transport failed before sending; only the Laya HTTP transport may forward it, and none does until #4), `sessionId` nullable. In-memory `state.lastDecisionId` is the usage→decision link for #5 (set for every record built, skips included). `classifier.status` is the HTTP status of a failed call; null on success and for non-HTTP transports.
7. Durability: "handed to host" ≠ durable, per host, plus the plugin's counters and the one-time warning.
8. `loadout.usage` v1 and `loadout.http` v1 field tables with the frozen semantics from the Binding decisions. Completeness is per field: `null` = not observed or not reported by this host; `decisionId:null` = unassigned; there is no separate flag. Producers build a candidate and append `normalizeUsage(candidate)`; a null result is not appended.
9. Versioning: readers ignore unknown fields; an unknown `v` is counted as unsupported; a breaking change bumps `v`.
10. v2 to view mapping table (`message` dropped; `applied` ⇒ `ratchet.after`; everything else unknown). v2 `probabilities`/`scores` keys are only shape-checked (SAFE_NAME), because v2 carries no profile list.
11. Reading records: `normalizeDecision`, `npm run decisions` (`skipped`, `unsupported`), bench behavior.
12. Synthetic examples: classified, skipped, failed, plus one usage and one http line.
13. Known limits: the docs are not packaged; `status` and `server` are null until #4; the narrowing lock; the HTTP no-deadline; no durability guarantee.

Every enum value in `telemetry.ts` must appear in this file (check with `grep`).

README edits (the README must stay self-contained):
1. Guarantees bullet "Every turn is recorded…" becomes: "**Every prompt it sees is recorded unless you opt out.** With telemetry on (the default) each prompt the host hands the plugin becomes one content-free `loadout.decision` session entry — skips and failures included — written after tools were applied. See [Telemetry](#telemetry)."
2. Configuration paragraph: "A file with a bad value is rejected and the defaults apply" becomes "A file with a bad value is rejected: the plugin turns itself off, reports the error, and writes no telemetry until the file is fixed."
3. Add the config table row after `notify`: ``| `telemetry` | `true` | write `loadout.decision` entries; `false` writes none. A machine-wide `false` in `~/.omp/loadout.*` cannot be overridden (see [Telemetry](#telemetry)) |``
4. After the `LOADOUT_CONFIG` paragraph add: "The machine telemetry setting is still read from `~/.omp/loadout.*`."
5. Command section: `status` adds "telemetry state"; `explain` becomes "last decision in full: per-profile risks, the proposal versus the tools actually active, skill counts and scores".
6. New `## Telemetry` section between Command and Trade-offs (a self-contained summary):
   - What a record holds.
   - What it never holds.
   - How to turn it off: `{"telemetry": false}` in `~/.omp/loadout.json`; first existing file only; project and `LOADOUT_CONFIG` files can only turn it off.
   - Fail closed: unreadable or non-boolean machine setting, or any config error, writes nothing. Applied when a session loads its config, so restart.
   - Opt-out writes nothing, deletes nothing, leaves `/loadout explain` working, and leaves the `loadout.skills` hint.
   - Handed to the host is not durable (pi may throw but keep in memory, OMP swallows disk errors, writes wait for the first assistant message).
   - Link to `docs/telemetry.md` for full schemas, noting it is in the repository and not in the npm package.
7. Trade-offs "Privacy" bullet: add "The `loadout.decision` entries hold no prompt text, descriptions or backend responses; see [Telemetry](#telemetry)."
8. Benchmarking:
   - After the "Each arm gets its config…" paragraph add: "The bench needs telemetry on: it stops before creating anything when `~/.omp/loadout.*` turns telemetry off or cannot be read, and sets `telemetry: true` in each arm's config."
   - After the "Needed tool missing" sentence add: "The loadout's active set is what the host reported after the plugin acted, not the plugin's proposal."
9. Decision report section: add "Reads record versions 2 and 3; unknown versions are counted as unsupported. Skipped turns (`disabled`, `empty-prompt`, `command`, `no-questions`) are counted separately and are not in the percentages."
10. Development table: add `| \`src/telemetry.ts\` | trace record schemas, privacy allowlists, safe persistence, v2/v3 readers |`.
11. Leave `examples/loadout.json` unchanged. Telemetry defaults on, and the machine opt-out is not a project example.

### Step 7 — Final gate, smoke and PR evidence

1. Run section 6(b) in full, then the smoke in 6(c).
2. PR body evidence:
   - Baseline versus final counts for the three commands.
   - The smoke table.
   - Not run: pi smoke.
   - `unverified` items from section 7 and how each resolved.
   - Behavior changes users will see:
     - skip records are now written (one record per prompt);
     - the append now happens after apply, so a pi persistence error no longer aborts the turn;
     - `/loadout explain` label `active` is now `proposed` and gained lines;
     - `decisions` counts exclude skips and gain `skipped`/`unsupported`;
     - unversioned or unknown-version records are now counted, not silently skipped;
     - bench `activeToolNames`/`applied` reflect real tools;
     - telemetry fails closed on any config error;
     - `docs/` is not packaged.

## 4. File lease

| path | action | lease basis (HANDOFF.md) |
| --- | --- | --- |
| `docs/plans/observability/issue-2.md` | create | orchestrator-mandated plan commit |
| `src/types.ts` | modify | #2 owns |
| `src/config.ts` | modify | #2 owns |
| `src/select.ts` | modify | #2 owns |
| `src/turn.ts` | modify | #2 owns |
| `src/telemetry.ts` | create | #2 owns (new shared telemetry module) |
| `src/index.ts` | modify | #2 owns |
| `scripts/lib/sessions.ts` | modify | #2 minimal consumer migration |
| `scripts/decisions.ts` | modify | #2 minimal consumer migration |
| `scripts/bench.ts` | modify | #2 minimal consumer migration |
| `tests/config.test.ts` | modify | #2 owns |
| `tests/select.test.ts` | modify | #2 owns |
| `tests/telemetry.test.ts` | create | #2 owns |
| `tests/turn.test.ts` | create | #2 owns (orchestrator lease audit: added to the published #2 path table) |
| `tests/extension.test.ts` | modify | #2 owns |
| `tests/sessions.test.ts` | modify | #2 minimal consumer migration |
| `tests/bench.test.ts` | modify | #2 minimal consumer migration |
| `tests/fixtures/fake-omp.mjs` | modify | #2 minimal consumer migration |
| `docs/telemetry.md` | create | #2 owns |
| `README.md` | modify | #2 owns |

Untouched: `src/classify/*`, `python/*`, `package.json`, `package-lock.json`, `bun.lock`, `scripts/eval-classifier.ts`, `CONTRIBUTING.md`, `docs/guides/*`, `examples/*`, `bench/*`, HTTP/Jev/Laya tests and fixtures, `.gitignore`, `HANDOFF.md`, `biome.json`, `tsconfig.json`. No file is deleted.

Published #2 path table additions (orchestrator lease audit): `tests/config.test.ts`, `tests/select.test.ts`, `tests/telemetry.test.ts` (new), `tests/turn.test.ts` (new), `docs/plans/observability/issue-2.md`, `docs/telemetry.md`.

Frozen after #2: `src/types.ts`, `src/config.ts`, `src/select.ts`, `src/turn.ts`, `src/telemetry.ts`, `tests/telemetry.test.ts`, `tests/turn.test.ts`, `docs/telemetry.md`; changes need architect reconciliation.

## 5. Commit grouping

| # | message | files |
| --- | --- | --- |
| 1 | `docs(plan): issue #2 decision traces plan` | `docs/plans/observability/issue-2.md` |
| 2 | `feat(select): expose per-profile risks` | `src/select.ts`, `tests/select.test.ts` |
| 3 | `feat(config): add machine-level telemetry ceiling` | `src/types.ts`, `src/config.ts`, `tests/config.test.ts` |
| 4 | `feat(telemetry): define versioned trace records and safe persistence` | `src/types.ts`, `src/telemetry.ts`, `tests/telemetry.test.ts` |
| 5 | `refactor(reports): read decision records through the shared normalizer` | `scripts/lib/sessions.ts`, `scripts/decisions.ts`, `scripts/bench.ts`, `tests/fixtures/fake-omp.mjs`, `tests/sessions.test.ts`, `tests/bench.test.ts` |
| 6 | `feat(trace): record actual tool application in loadout.decision v3` | `src/turn.ts`, `src/index.ts`, `src/types.ts`, `tests/turn.test.ts`, `tests/extension.test.ts` |
| 7 | `docs(telemetry): document trace schemas, privacy and opt-out` | `docs/telemetry.md`, `README.md` |

Each commit must pass `npm test`, `npm run typecheck` and `npm run lint` on its own. Commits 3 and 4 both edit `src/types.ts`, but sequentially, so there is no partial staging.

## 6. Verification

### (a) Named regressions, one per acceptance bullet

1. Low-confidence: `tests/extension.test.ts` — "low confidence: every narrower profile's risk and the threshold are recorded while the tools stay unchanged".
2. Dry-run: "dry run: the proposal is recorded but the actual tools are the baseline".
3. Widen-only: "widen-only: a later confident narrowing is recorded as not admitted with the tools the host really has" (replaces the `applied==="full"` pin).
4. Application outcomes, five tests:
   - "application: a narrowing is applied and read back";
   - "application: tools that already match are unchanged and the setter is not called";
   - "application: a setter that throws is recorded as failed and the baseline is restored";
   - "application: when restoration also fails the record shows the tools the host really has";
   - "application: a first-turn setter failure records the host's real tools and no restoration".
5. Overflow: "skill overflow records the real counts and cap and invents no scores".
6. Machine off: "machine telemetry off beats trusted-project, explicit-file and /loadout on" (plus the config-error, malformed and non-boolean variants and the load-time test).
7. Canary: "canaries never reach serialized telemetry".
8. Readability:
   - `tests/telemetry.test.ts`: the `normalizeDecision` v2/v3 cases;
   - `tests/sessions.test.ts`: "v2 and v3 records are normalized and unknown versions are counted as unsupported";
   - `tests/bench.test.ts`: "decisions reports profiles, failures, skips and skills across sessions" and the strengthened bench test.
9. Storage failure: `tests/extension.test.ts` — "persist failure: the turn continues, tools are applied, and the failure is counted with a code only", plus `tests/telemetry.test.ts` — "persistRecord: serialization failure never reaches the host".

Also covered: the skip-record tests, ordering/one-record-per-prompt, `sessionId` null, `tests/turn.test.ts`, `tests/config.test.ts` and `tests/select.test.ts`.

### (b) Commands (run in the worktree)

```bash
cd /home/andrevandal/www/andrevandal/pi-classifier-tools-skills/.worktrees/issue-2
node --version                                   # 26.11.1 (>= 22.18)
node --test tests/select.test.ts                 # step 1
node --test tests/config.test.ts                 # step 2
node --test tests/telemetry.test.ts              # step 3
node --test tests/sessions.test.ts tests/bench.test.ts   # step 4
node --test tests/turn.test.ts tests/extension.test.ts   # step 5
npm test                                         # node --test tests/*.test.ts  (all steps; final gate)
npm run typecheck                                # tsc --noEmit
npm run lint                                     # biome check .
git status --porcelain                           # empty at every commit
git log --oneline 12752a5..HEAD                  # 7 commits in section 5 order
git diff --name-only 12752a5..HEAD               # must be a subset of the section 4 table
```
Leftover checks with the grep tool over `src scripts tests README.md`:
- `TurnRecord` and `failedTurn` have zero hits.
- `DECISION_ENTRY` is defined only in `src/telemetry.ts`.
- `v === 2` appears only in the `normalizeDecision` v2 branch.

### (c) Real OMP smoke

Goal: run the actual plugin hook and application path on a real host with controlled classifier answers. It uses exactly 4 one-line model turns on the user's default model (no `--model`) and records proposed-versus-actual and opt-out behavior. pi smoke is recorded as "not run".

Prerequisites (zero tokens):
- Every `omp` call below uses `--no-extensions -e <worktree>/src/index.ts`. `--no-extensions` should keep the installed marketplace plugin out, while explicit `-e` still loads; verified in `launch-help.ts` and `main.ts`, runtime unverified. A duplicate record per prompt would mean the installed plugin also loaded: abort.
- All state lives under `$SMOKE`. Never use ports 8765/8766, never touch `~/.omp/loadout.*` or the installed plugin.
- Machine-setting check for the real HOME: it must print `absent` or `on`. If it prints `off` or `unreadable`, stop and report; do not edit the user's file.
  ```bash
  node --input-type=module -e 'import os from "node:os"; const m = await import("/home/andrevandal/www/andrevandal/pi-classifier-tools-skills/.worktrees/issue-2/src/config.ts"); console.log(m.readMachineTelemetry(os.homedir()))'
  ```

Setup:
```bash
WT=/home/andrevandal/www/andrevandal/pi-classifier-tools-skills/.worktrees/issue-2
REAL_HOME=$HOME
SMOKE=$(mktemp -d /tmp/loadout-smoke-XXXXXX)
mkdir -p "$SMOKE/cwd" "$SMOKE/home-off/.omp"
printf '{"telemetry": false}\n' > "$SMOKE/home-off/.omp/loadout.json"
cat > "$SMOKE/stub.mjs" <<'EOF'
// Scripted System-One stub. Usage: node stub.mjs <script.json> <logfile> <portfile>. Logs question ids only.
import fs from "node:fs";
import http from "node:http";
const [scriptFile, logFile, portFile] = process.argv.slice(2);
const script = JSON.parse(fs.readFileSync(scriptFile, "utf8"));
let next = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const reply = script[next++];
    fs.appendFileSync(logFile, `${JSON.stringify({ n: next, questions: Object.keys(JSON.parse(body || "{}").questions ?? {}) })}\n`);
    res.writeHead(reply ? 200 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply ?? { error: "script exhausted" }));
  });
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  if (port === 8765 || port === 8766) process.exit(3);
  fs.writeFileSync(portFile, String(port));
});
EOF
EDIT='{"model":"smoke-stub-1","usage":{"input_tokens":41,"output_tokens":3},"answers":{"tool_profile":{"type":"choice","choice":"edit","probabilities":{"answer":0.02,"edit":0.96,"full":0.02},"confidence":0.96}}}'
ANSWER='{"model":"smoke-stub-1","usage":{"input_tokens":41,"output_tokens":3},"answers":{"tool_profile":{"type":"choice","choice":"answer","probabilities":{"answer":0.97,"edit":0.02,"full":0.01},"confidence":0.97}}}'
printf '[%s,%s,%s,%s]\n' "$EDIT" "$ANSWER" "$ANSWER" "$EDIT" > "$SMOKE/script.json"
node "$SMOKE/stub.mjs" "$SMOKE/script.json" "$SMOKE/requests.log" "$SMOKE/port" & echo $! > "$SMOKE/stub.pid"
for i in $(seq 1 50); do [ -s "$SMOKE/port" ] && break; sleep 0.1; done; [ -s "$SMOKE/port" ] || echo "stub did not start"
PORT=$(cat "$SMOKE/port")
for name in smoke dry; do
  EXTRA=; [ "$name" = dry ] && EXTRA=',"dryRun":true'
  printf '{"backend":"laya","laya":{"transport":"http","endpoint":"http://127.0.0.1:%s/","apiKeyEnvVar":"","timeoutMs":3000},"notify":false,"telemetry":true%s}\n' "$PORT" "$EXTRA" > "$SMOKE/loadout.$name.json"
done
```
Zero-token precheck for the HOME override. The first line must print the temp HOME. The second must print `off`. `omp models --no-extensions` under the override must list the same models as the normal run (its first 10 lines).
```bash
HOME="$SMOKE/home-off" bun -e 'console.log(require("node:os").homedir())'
HOME="$SMOKE/home-off" node --input-type=module -e 'import os from "node:os"; const m = await import("'"$WT"'/src/config.ts"); console.log(m.readMachineTelemetry(os.homedir()))'
[ -z "${OMP_PROFILE:-}${PI_PROFILE:-}" ] || echo "named OMP profile active: use Session C' (below)"
OVR="HOME=$SMOKE/home-off PI_CODING_AGENT_DIR=$REAL_HOME/.omp/agent PI_NATIVES_DIR=$REAL_HOME/.omp/natives"
env $OVR omp models --no-extensions | head -10   # must match the real-HOME run; any error => Session C'
```
Why: OMP's config root follows HOME (`pi-utils/src/dirs.ts:115-117,531-533`); `~/.omp/natives/` exists so `PI_NATIVES_DIR` is required (`dirs.ts:877-879`); `PI_CODING_AGENT_DIR` is ignored under a named profile (`dirs.ts:470-481`); `~/.omp/auth-broker.token` is read from the config root and a configured broker URL throws `MissingApiKeyError` without it (`pi-ai/src/auth-broker/discover.ts:56-58,343-357`).

Do not copy, print or symlink `auth-broker.token` without the user's explicit OK. If the precheck fails, run turn 4 as **Session C′** instead: real HOME; `LOADOUT_CONFIG` = a copy of `loadout.smoke.json` with `"telemetry": false`; `--session-dir "$SMOKE/sessions-c"`. Pass = stub request 4 present, an assistant message present, zero `loadout.*` entries. Record "machine ceiling on the real host: not run (covered by extension tests)".

The four turns (prompts are one-line; the stub replies in order, so request lines and sessions line up):
```bash
cd "$SMOKE/cwd"
LOADOUT_CONFIG="$SMOKE/loadout.smoke.json" omp --no-extensions -e "$WT/src/index.ts" --no-title --session-dir "$SMOKE/sessions-a" -p "Reply with the single word OK." "Reply with the single word OK again."
wc -l < "$SMOKE/requests.log"    # 2
LOADOUT_CONFIG="$SMOKE/loadout.dry.json" omp --no-extensions -e "$WT/src/index.ts" --no-title --session-dir "$SMOKE/sessions-b" -p "Reply with the single word OK."
wc -l < "$SMOKE/requests.log"    # 3
env $OVR LOADOUT_CONFIG="$SMOKE/loadout.smoke.json" omp --no-extensions -e "$WT/src/index.ts" --no-title --session-dir "$SMOKE/sessions-c" -p "Reply with the single word OK."
wc -l < "$SMOKE/requests.log"    # 4
```
Evidence read. Dump the plugin entries:
```bash
cat > "$SMOKE/dump.mjs" <<'EOF'
import fs from "node:fs";
import path from "node:path";
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".jsonl") ? [path.join(d, e.name)] : []);
for (const dir of process.argv.slice(2)) for (const file of walk(dir)) for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  let entry; try { entry = JSON.parse(line); } catch { continue; }
  if (entry?.type === "custom" && String(entry.customType).startsWith("loadout.")) console.log(path.basename(dir), JSON.stringify(entry.data));
}
EOF
node "$SMOKE/dump.mjs" "$SMOKE/sessions-a" "$SMOKE/sessions-b" "$SMOKE/sessions-c"
for d in a b c; do node "$WT/scripts/decisions.ts" --sessions-dir "$SMOKE/sessions-$d" --json; done
```
Pass criteria:
- **Session A, prompt 1** (confident `edit`): exactly one v3 record. `outcome "classified"`; `tools.profile "edit"`; `application.status "applied"`; `actualTools` strictly narrower than session B's `actualTools`; `ratchet.admitted true`; `classifier.requestId` matches the UUIDv4 pattern; `classifier.model "smoke-stub-1"`; `classifier.usage {inputTokens:41, outputTokens:3}`. Record whether `actualTools` set-equals `tools.active`; a difference is an observation, not a failure.
- **Session A, prompt 2** (confident `answer`, narrower than `edit`): `application.status "not-admitted"`; `ratchet {narrowAllowed:false, before:"edit", after:"edit", admitted:false}`; `actualTools` equals prompt 1's; `tools.profile "answer"`.
- **Session B** (dry run): `application.status "dry-run"`; `actualTools` equals the untouched host baseline; `tools.active` narrower than `actualTools`; `skills.delivery "none"` (its config leaves skills off, so no delivery was due).
- **Session C** (machine off): the stub's 4th request is present (classification still ran), the session JSONL has an assistant message, and zero `loadout.*` entries. The explicit file's `telemetry:true` lost to the machine file. If the precheck sent turn 4 to Session C′, use its pass criteria instead.
- **Everywhere**: exactly one `loadout.decision` per prompt; a duplicate aborts the smoke.
- **Consumer check**: `decisions.ts --json` on A reports `decisions 2` and `unsupported 0`.

Cleanup: `kill "$(cat "$SMOKE/stub.pid")"; rm -rf "$SMOKE"`. Paste the dump (synthetic prompts only) and the pass/fail table into the PR body.

## 7. Assumptions & contingencies

**Unverified — confirm first** (each with its pre-decided fallback):
- A `.mjs` fixture can import `.ts` through type stripping (the test suite already depends on it for `.ts` tests). If the fixture import fails, have `tests/bench.test.ts` build the record JSON with `buildDecisionRecord` and pass it to the fixture through an env var, and keep the rest of Step 4 unchanged.
- OMP boots and authenticates under the `$OVR` override. The zero-token precheck decides; on failure use Session C′ (section 6(c)) and the in-process machine-off extension tests remain the ceiling evidence.
- `--no-extensions` excludes the installed plugin at runtime, and `-e` loads under `-p` without a trust prompt (`--trusted-extension` is a separate mode). The duplicate-record check is the guard.
- OMP makes no extra background model calls beyond the title (`--no-title` avoids that one). Memory consolidation at dispose is uncontrolled. If a fifth model call is observed, record it in the PR.
- The user's own `~/.omp/loadout.*` has no `telemetry:false`. The zero-token precheck decides.
- Real `setActiveTools` rejection behavior on OMP and whether `getActiveTools()` equals the set passed in are observed in the smoke, not assumed.
- Real Jev/Laya backends return `model`/`usage`; the plan handles both presence and absence.

**Contingencies:**
- Pre-existing baseline failure: record it verbatim and proceed; any new failure blocks.
- If `npm run lint` flags import order, fix by hand. `npm run format` rewrites formatting only; inspect `git diff` afterwards.
- A YAML machine file read under Node (bench or scripts) has no parser, so bench refuses with the "cannot be read here" message. The fix is a JSON machine file or running under Bun. This is documented in `docs/telemetry.md`.
- If a host calls the hook twice per prompt, `eventId` still makes records unique, and fork duplicates are dedup'd by `eventId` in later readers (#4+).
- The smoke is a gate. A failed pass criterion means fix the plugin and rerun with a fresh `$SMOKE` (still within the 4-turn budget only if turns remain; otherwise report the failure rather than spend more tokens without the user's approval).
- Rollback: nothing is activated; the branch is not installed. Discard by abandoning the branch, only with orchestrator approval. After merge, a user opts out with `telemetry:false` in `~/.omp/loadout.json` and a session restart.
- Packaging: `docs/` is not published. README carries the privacy and opt-out essentials; do not edit `package.json` (outside the lease).

## Review record

- Architect review (ObsArchitectReview, 2026-10-16): APPROVE-WITH-MECHANICAL-FIXES; all 5 major + 14 minor findings applied in this revision; no user decision required. Verified smoke mechanisms: `-e` (`cli/flag-tables.ts:79-82,228-229`), `--no-extensions` keeps explicit `-e` (`main.ts:1722-1724,1830-1831`), `-p` sequential positional messages (`modes/print-mode.ts:280-292`), no trust prompt (`extensions/runner.ts:1422`), `--no-title`, `--session-dir`; plugin home = `os.homedir()` (`config.ts:127`). Installed OMP is 18.11.2.
- Orchestrator lease audit: all Files paths inside #2 lease; untouched: `src/classify/*`, `python/*`, `package.json`, lockfiles, `scripts/eval-classifier.ts`.

# Telemetry: trace records

Source of truth: [`src/telemetry.ts`](../src/telemetry.ts). This page is in the repository only; it is not part of the npm package, so the README carries the privacy and opt-out essentials.

## 1. Overview

| entry (`customType`) | version | producer |
| --- | --- | --- |
| `loadout.decision` | 3 (2 is still read) | the extension, once per prompt it sees |
| `loadout.usage` | 1 | defined here, no producer yet (slice #4) |
| `loadout.http` | 1 | defined here, no producer yet (slice #5) |

All three are session entries the host stores next to the conversation. The plugin only ever appends them; it never reads them back during a session.

## 2. Privacy

Never stored: prompt text, skill descriptions, rubrics, endpoints, environment variable names, file paths, backend response or error text, and any payload that is not in an allowlist below.

Stored: allowlisted identifiers, counts and durations. Tool and skill names are stored as identifiers when they match `^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,99}$`; anything else in a list becomes `"(redacted)"`, and an invalid map key is dropped. Profile probabilities are limited to the configured profile ids. A model id is stored only when it looks like one (`^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,63}$`), so prose from a backend becomes `null`. Error codes come from a closed errno list (`EACCES EPERM ENOENT ENOSPC EROFS EIO EMFILE ENFILE EDQUOT EBUSY EISDIR ENOTDIR ENAMETOOLONG ELOOP`) plus `"serialize"` and `"error"`; a message is never stored.

Truncation happens only in the plugin: `classifier.promptChars` > `classifier.sentChars` means the prompt was clipped to `maxPromptChars`. Whether a backend truncates further is unknown.

## 3. Opt-out and precedence

`telemetry: false` in the **first existing** of `~/.omp/loadout.json`, `.yml`, `.yaml` is a machine-wide ceiling. It is read outside the normal config search, and a later file is never consulted. Project and `LOADOUT_CONFIG` files can only turn telemetry off.

| reason | persists | when (in precedence order) |
| --- | --- | --- |
| `machine-off` | no | the machine file says `telemetry: false` |
| `machine-unreadable` | no | the machine file is malformed, not an object, has a non-boolean `telemetry`, cannot be read (not just missing), or is YAML and no YAML parser exists (Node without Bun) |
| `config-error` | no | any config search error, e.g. a bad value or a missing `LOADOUT_CONFIG` file |
| `config-off` | no | the effective config says `telemetry: false` |
| `default` | yes | none of the above |

A machine file with `telemetry: true` or no `telemetry` key behaves the same: it is a ceiling, not a switch.

The decision is made when a session loads its config (session start, or a cwd or project-trust change), so **restart the session after editing** the setting. Opt-out stops every record the plugin appends. It does not stop the host's own conversation logging, nor the `loadout.skills` hint message (selection behavior, which the host may store). `/loadout explain` and `/loadout status` keep working from memory.

## 4. `loadout.decision` v3

One record per `before_agent_start` call, built after tools were applied or restored and appended once.

| field | type | meaning |
| --- | --- | --- |
| `v` | `3` | |
| `eventId` | uuid | dedup key for forked sessions |
| `sessionId` | string or null | the host's id; null when it has none (never `"unknown"`) |
| `decisionId` | uuid | links later `loadout.usage` records |
| `outcome` | `classified` `failed` `skipped` | |
| `skip` | `disabled` `empty-prompt` `command` `no-questions` or null | set only when `outcome` is `skipped` |
| `failure` | `warming` `unavailable` `timeout` `auth` `transport` `protocol` `aborted` `error` or null | set only when `outcome` is `failed` |
| `settings` | object | `enabled`, `backend` (`jev` `laya`), `transport` (`python` `http`, laya only), `dryRun`, `notify`, `maxPromptChars`, `configScope` (`default` `project` `global` `explicit`), `tools` with `enabled` and `maxRisk`, `skills` with `enabled`, `mode` (`auto` `filter` `hint`), `threshold`, `maxSkills` and `maxCandidates` |
| `classifier` | object or null | null on a skip. `requestId`, `model`, `elapsedMs`, `budgetMs`, `timeoutMs`, `guardFired`, `usage {inputTokens, outputTokens}`, `server {queueMs, inferenceMs}`, `status`, `promptChars`, `sentChars`, `questions` |
| `tools` | object or null | null unless a decision was made. `reason` (`selected` `disabled` `missing-answer` `low-confidence`), `profile`, `active`, `probabilities`, `risk`, `risks [{profile, risk}]`, `maxRisk` |
| `skills` | object or null | null unless skills were listed. `reason` (`selected` `disabled` `no-candidates` `too-many-candidates` `missing-answer`), `selected`, `scores`, `discovered`, `eligible`, `maxCandidates`, `asked`, `filteredOut`, `delivery` (`filter` `hint` `none` `dry-run`) |
| `ratchet` | object or null | `narrowAllowed` (before this decision), `before`, `after`, `admitted` |
| `application` | object | `status`, `restoration`, `actualTools`, `error` |

`tools.active` is the **proposal** (the tools asked for; null = keep the baseline). The tools the host really had are `application.actualTools`, a read-back from the host after applying or restoring. `tools.risks` lists every profile narrower than the broadest in order, with the probability mass on the profiles broader than it; it is null (not zero) when the answer had no probability. `eligible = discovered - (skills.exclude + skills.alwaysInclude)`, and `asked` is `eligible` when skill selection ran, else 0. `filteredOut` is non-null only for delivery `filter`; a dry run never claims a delivery that was not due (`none`).

`application.status`:

| value | meaning |
| --- | --- |
| `applied` | the host's setter ran and changed the active tools |
| `unchanged` | the target equals the active set; no setter call |
| `dry-run` | classified and recorded; nothing changed |
| `not-admitted` | the widen-only ratchet blocked a narrowing; tools kept |
| `restored` | a skip or failure put the baseline back |
| `failed` | applying threw; `error` holds the errno code or `error`, and `restoration` says whether the baseline came back |
| `not-attempted` | nothing to apply or restore |

`restoration` is `restored` (the setter ran), `unchanged` (already the baseline), `failed` (the restore threw) or null.

## 5. Units and unknowns

Durations are milliseconds. Lengths are characters (JS string length). Counts are integers. `null` means unknown or not applicable; `0` means measured zero.

## 6. IDs

- `eventId`: unique per record; the dedup key when a host forks a session and copies its entries.
- `decisionId`: identifies one decision. In memory, `lastDecisionId` is set for every record built, skips included, and is `null` when building failed. A later slice uses it to link usage to a decision.
- `requestId`: a UUIDv4 *offered to the transport*, generated only when persisting and a request is actually issued. A record carries it even when the transport failed before sending (for example an unset Jev token). Only the Laya HTTP transport may forward it, and none does until #4.
- `sessionId`: the host's id, or null.

`classifier.status` is the HTTP status of a failed call: the Laya and Jev HTTP transports keep it, and the Laya transport keeps the server's timing, for any response whose body was read, including a 200 whose body was unusable. It is null on success, when no response arrived or its body could not be read (timeout, abort, transport failure), and for non-HTTP transports. `classifier.server` holds the `queue` and `infer` times, in ms, that the Laya HTTP server reported in its `Server-Timing` header (section 8). It is null for every other transport, when no response arrived or its body could not be read, and whenever the server sent none (an older server, an opted-out request, a rejected or unparsable request). Inside `server`, a phase the server did not report is null, never 0.

## 7. Durability

"Handed to host" means the host's append did not raise. It does not mean the record reached disk.

- pi throws EACCES on a disk error but keeps the entry in memory.
- OMP swallows disk errors; the plugin cannot see them.
- Both defer writes until the first assistant message.

The plugin counts per session `{handedOff, suppressed, failed, lastFailure}`, shown by `/loadout status`, and shows one `warning` notice (code only) on the first failure. A persistence failure never aborts the turn. An unserializable payload is refused before the host sees it (code `serialize`).

## 8. `loadout.usage` v1 and `loadout.http` v1

Defined here, with normalizers (`normalizeUsage`, `normalizeHttp`); nothing produces them yet. Completeness is per field: `null` means not observed or not reported by this host, `decisionId: null` means unassigned. There is no separate completeness flag. A producer builds a candidate and appends `normalizeUsage(candidate)`; a null result is not appended.

`loadout.usage` v1, one per assistant model turn the host reports through `turn_end` (OMP and pi). This plugin produces it: one record per observed turn, appended with the session's other records through the same persistence path and opt-out as `loadout.decision`.

| field | meaning |
| --- | --- |
| `v`, `eventId`, `sessionId`, `runId`, `decisionId`, `turnIndex` | identity; `eventId` and `runId` are UUIDv4. `eventId` is new for every observation and is the dedup key when a host copies entries into a fork or branch. `runId` groups the turns of one run. `turnIndex` is the host's counter: informational, it restarts at 0 with each host run (`agent_start`), so it keeps counting when the plugin starts a new `runId` at a compaction or boundary, and it is never a join key |
| `host` | `omp` or `pi`, told apart by the shape of the event (pi's `turn_end` carries `messageEntryId`) |
| `hostEntryId` | pi's id of the assistant message entry; null on OMP, whose `turn_end` has none |
| `stopReason` | `stop` `length` `toolUse` `error` `aborted`; any other host value (pi also has `pending` and `deferred`) is `other`; null when the host gives none |
| `tokens` | `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`: each the host's count or null. The buckets are the host's own (OMP's `input` excludes cache reads, and `reasoning` is part of `output`); nothing is summed or reconciled. `reasoning` is OMP's `reasoningTokens` or pi's `reasoning`, null when the provider does not report it. A host shows "no usage reported" as zero counters, and a model turn always consumes tokens, so when none of the four counters is above zero all five token fields and `costTotal` are null. This covers failed and interrupted attempts and providers that report nothing. On an `error` or `aborted` turn the counters can be partial: a zero next to a positive counter may only mean the stream stopped before the host received that count. A stop message the host writes itself without calling a model, such as OMP's stop before a model call (`aborted`, no counters), is counted as a turn with null tokens |
| `costTotal` | the host's `usage.cost.total`, which the host computes from its configured prices. It is not a bill: `0` can mean free or unpriced. Null when unknown |
| `toolCalls`, `toolErrors` | `toolCalls` counts the tool calls in this message by name, for the tools the host has registered when the turn ends. A tool name in a model message is model output, and a made-up or injected one can carry a path or a secret, so any other name is dropped: the counts can sum to less than the calls, and are `{}` when the host's tool list cannot be read. `toolErrors` is how many of this turn's tool results the host flagged as errors: 0 for an empty list of results, which includes calls that never ran, and null only when the host sent no list. A tool result's own usage or details are never read |
| `errorStatus` | OMP's HTTP status of a failed request; null on pi, which has none, and for failures that carry no status, such as a dropped stream |
| `retryAttempt` | OMP: the attempt number from the host's `auto_retry_start`, on the first observation after it. pi: always null, because its extension API has no retry event. Informational only: null does not prove a first attempt |

Attribution. A record links to a decision only through lifecycle events the plugin saw, never by time, content or transcript order:

- A decision (a skip included) is pending once its `before_agent_start` hook finishes. The run that starts next takes it. OMP runs the hook again for a follow-up or steer queued inside an open run, so that decision applies from the first turn after the hook, and earlier turns keep the previous one. pi runs no hook for a queued follow-up or steer, so no decision was made for that message: from the turn that delivers it the rest of the run is unassigned. The plugin tells these apart from the host's `message_start` event: a user message that arrives after an observed turn used the run's decision, and that no hook claimed, ends the link. A message delivered together with the run's first turn, such as a steer queued before the first model call, counts with that turn's decision.
- `agent_start` opens a run with a new `runId`. A run that starts without a decision hook (a retry, a compaction continuation, a wake-up) is unassigned: `decisionId` is null. So is the retry of a failed attempt.
- Compaction ends the run; the next turn is a new, unassigned run. A pending decision stays pending, because OMP may compact between the hook and the run. A tree move, branch or switch ends the run and drops a pending decision. `agent_end` drops a pending decision too.
- A decision whose prompt the host cancelled before any run began stays pending until the next decision, `agent_end` or boundary, so an unrelated run that starts in between could be linked to it.

Coverage. These records do not claim complete billing or complete coverage:

- One record per assistant message that reaches `turn_end`: failed and interrupted ones, and a stop message the host writes itself without a model call, are included. Classifier calls are not model turns and are never in these records.
- Not observed: model calls the host makes without telling extensions (session titles, memory consolidation, compaction summaries), transport retries the host performs inside one model call (no message exists, so nothing is reported), usage fields the schema has no slot for (OMP's orchestration, server-tool and credit counters), and anything before the plugin loaded or after it was disabled. A pi turn whose message entry id cannot be resolved is not delivered by pi, so it is not observed.
- Subagent and child sessions are never added to the parent's records. Each session's plugin instance writes its own records, nothing here reads or sums other sessions' logs, and a reader that combines sessions deduplicates by `eventId` (the collab guest below is the exception).
- An OMP collab guest that runs `/loadout` while joined mirrors the host's turns into its own replica session, and the plugin there can record them again with new `eventId`s. Those copies cannot be told apart by `eventId`, so usage summed over the host's and that guest's session files counts those turns twice.
- A replayed `turn_end` for the same message object (OMP can replay one when it resumes unpaired tool calls) counts once. The same usage arriving as a different object cannot be told apart and counts again.
- With telemetry off nothing is written. The plugin still counts the turns in memory, and `/loadout status` shows them as suppressed.

`loadout.http` v1, one per `POST` to the Laya HTTP server (`python/laya_http_server.py`), written as one JSON line on the server's stderr. That is the server's existing log (the journal under systemd), not a new file or datastore. `GET` health checks write no line.

| field | meaning |
| --- | --- |
| `type`, `v` | `loadout.http`, `1` |
| `requestId`, `idStatus` | `requestId` is the `X-Request-Id` header when the request carried exactly one and it is a lowercase UUIDv4 (`idStatus` `valid`). Otherwise it is null and `idStatus` is `absent` (no header) or `invalid` (anything else, including a repeated header); an invalid value is never copied. `idStatus` is derived from the id on read |
| `at` | UTC ISO timestamp with milliseconds: when the line was written, after the answer write was attempted |
| `outcome` | `ok`: a 2xx answer was written and the write did not raise. `rejected`: the server refused the request itself (`401` unauthorized, `413` body over 1 MiB). `error`: the answer was a 5xx, an exception while reading, parsing or predicting. `client-gone`: writing the answer raised a connection error. `ok` is not delivery: a peer that closed cleanly often still accepts the write, so an abandoned request can read `ok`. Never infer a timeout from the outcome |
| `status` | the HTTP status the server chose to send; for `client-gone` it may never have arrived |
| `queueMs` | milliseconds waiting for the server's single prediction lock; null when the request never reached it |
| `inferenceMs` | milliseconds holding that lock, until the model answered or raised (a failed inference still reports it); null when the request never reached it |
| `totalMs` | milliseconds from the start of handling (request line and headers already read) to the end of the write attempt; always present |
| `errorClass` | a class name matching `^[A-Za-z][A-Za-z0-9_]{0,63}$`, never its text: the exception behind an `error`, the connection error behind a `client-gone`; null otherwise |

Durations come from `time.monotonic()` and carry three decimals. A phase that was not measured is null, never 0. Lines appear in the order handlers finish, not the order requests arrived.

Headers (Laya HTTP transport only; Jev and the python sidecar neither send nor read them):

- `X-Request-Id` (request): the plugin's `classifier.requestId`, which it generates only when it persists records.
- `Server-Timing` (response): `queue;dur=<ms>, infer;dur=<ms>`, only for the phases that were measured. A 5xx after a failed inference carries both; a rejection or an early failure (bad JSON, bad length) carries none. The plugin keeps `queue` and `infer`, ignores any other metric, and treats a repeated or malformed one as unknown (`classifier.server`, section 6).

Opt-out. A plugin that does not persist records (any reason in section 3) sends `X-Loadout-Telemetry: off` and no `X-Request-Id`. The server also takes `--no-telemetry`. In both cases the request gets no line and no `Server-Timing` header. The server fails closed: any `X-Loadout-Telemetry` value other than `on` counts as off. A request without the header (another client, `npm run eval`, or a plugin session started before this version) is recorded; only `--no-telemetry` silences those. Opting out never touches the server's ordinary error output, and nothing already written is deleted.

Reading the evidence. A client timeout is recorded by the client (`failure`, `elapsedMs`, `budgetMs`, `guardFired`); the server line joins it through `requestId`, and `queueMs` shows whether the request spent its time waiting behind another. The server has no deadline and notices a disconnect only when it writes the answer, so an abandoned request still runs its inference and its line says `ok` or `client-gone`; neither says why the client left. Under systemd: `journalctl --user -u laya-server -o cat | grep '"type":"loadout.http"'`.

Never logged: bodies, prompts, answers, tokens, headers other than the two named, URLs, and exception text.

## 9. Versioning

Readers ignore unknown fields. A record of an unknown or absent `v`, or an invalid shape, is counted as unsupported and never guessed at. A breaking change bumps `v`.

## 10. v2 to view mapping

| v2 field | in the view |
| --- | --- |
| `message` | dropped (it could hold backend body text) |
| `failure` | `failure`; `outcome` is `classified` when null, else `failed`. A v2 record without the `failure` key is unsupported |
| `applied` | `ratchet.after` |
| `tools`, `skills` | kept; `tools.risks`, `tools.maxRisk` and the skills counts and `delivery` are null |
| `backend`, `dryRun`, `latencyMs` | kept |
| everything else (`eventId`, `decisionId`, `sessionId`, `skip`, `settings`, `classifier`, `application`, other ratchet fields) | null |

v2 `probabilities` and `scores` keys are only shape-checked against the identifier pattern, because v2 carries no profile list.

## 11. Reading records

- `normalizeDecision(data)` returns a `DecisionView` for v2 and v3, or null.
- `loadout-report` and the `npm run decisions` text view read all three record families (`loadout.decision`, `loadout.usage`, `loadout.http`) through `src/report/`. Skipped and unsupported records are counted apart from the decision figures; see section 11a.
- `npm run bench` refuses to run when the machine opts out or the setting is unreadable, and sets `telemetry: true` in each arm's config. A YAML machine file read under Node has no parser, so use a JSON machine file or run under Bun. Bench `activeToolNames` and `applied` reflect the host's real tools when a v3 record provides them. Its sessions are read through the same reader as `loadout-report`.

## 11a. Reporting and export (loadout-report)

Source: [`src/report/`](../src/report/). `loadout-report summary` and `loadout-report export` read session transcripts and explicit service logs. `npm run decisions` prints a text view of the same summary, and `npm run report -- <args>` runs the CLI from a checkout under Node. Reading never writes, and no output carries transcript text.

### CLI

`loadout-report <summary|export> [flags]`. Flags are parsed strictly: an unknown flag, or a flag without its value, is a usage error.

| flag | meaning |
| --- | --- |
| `--session <file>` (repeatable) | current-session scope; each must exist and be a file |
| `--since <ISO>`, `--until <ISO>` | historical window `[since, until)`; both required, `since` before `until` |
| `--project <path>` (repeatable), `--all-projects` | historical project scope; exactly one of the two |
| `--sessions-dir <dir>` (repeatable) | historical roots; default `~/.omp/agent/sessions`, for pi `~/.pi/agent/sessions`; an explicit root must be a directory |
| `--service-log <file>` (repeatable) | service log for the request-id join; must be a file |
| `--branch <value>` | `all` (default) or one branch, see [Branch labels](#branch-labels) |
| `--outcome <value>` (repeatable) | one decision or model-turn outcome, see [Filters](#filters) |
| `--help`, `-h`; `--version`, `-v` | help text, or the package version, on stdout; exit 0 |

| exit | meaning |
| --- | --- |
| 0 | success. A scope that matches no session files still exits 0: a warning on stderr and every count zero |
| 1 | unexpected error: the message only, on stderr |
| 2 | usage error: stdout is empty and stderr names the flag or flags at fault |

Stdout carries only the JSON document: two-space indent, one trailing newline. Every diagnostic goes to stderr. `--help` and `--version` are answered before the subcommand, scope and filters are checked.

Scope errors, all exit 2: no scope; `--session` with a historical flag or with `--sessions-dir`; a historical scope missing `--since`, missing `--until`, or missing `--project` or `--all-projects` (every missing piece is named); `--project` with `--all-projects`; an empty `--project` value, which would silently mean the current directory; `--since` not before `--until`; an instant the rules in the next subsection reject; an unknown `--branch` or `--outcome` value; a `--session`, `--service-log` or explicit `--sessions-dir` path that is missing or of the wrong kind.

### Scope and boundaries

- **Session scope** (`--session`) reads exactly the named files and has no time window. Child sessions of a named file are not read; `scope.childFilesNotRead` counts them. A child directory that cannot be listed or examined (no permission, a symlink loop) is counted in `scope.childDirsUnreadable` and makes `childFilesNotRead` a lower bound. It is not part of `coverage.files.unreadable`, because no in-scope file was lost.
- **Historical scope** reads every `.jsonl` file under each root, recursively, and keeps events with `since <= at < until` (half-open). A date means UTC midnight; a date-time needs `Z` or a `+HH:MM` or `-HH:MM` offset. Zone-less times, relative values such as `7d` and impossible dates are rejected.
- **Unplaced events:** an event whose entry has no parsable timestamp is removed from a historical scope and counted as `unplaced`. A session scope has no window and keeps such events.
- **mtime shortcut:** before a file is parsed, a file last modified before `since` is skipped and counted in `coverage.files.skippedByMtime`. Only `since` is compared with the modification time, so a restore or copy tool that resets mtimes can hide old files. A file modified after `until` is read, and its events after the window are removed.
- **Exact project:** with `--project`, a file is selected when its header `cwd` equals a project path after `path.resolve` (trailing slashes and `..` are normalized), or after `realpath` when both exist, so a symlinked project path matches its target. A parent directory is not the project. A file with no header matches no project.
- **Nested children:** a child session sits in `<parent>/` beside `<parent>.jsonl`. A historical scope reads each child as its own session and counts it in `scope.nestedChildFiles`. Nothing is rolled up into the parent.
- **Roots:** several roots are merged, a root given twice lists each file once, and selected files are sorted. Unreadable directories are counted in `coverage.files.unreadable`. So is a listed `.jsonl` entry that does not resolve to a regular file (a pipe, a device, a symlink loop or a dangling link): it is counted and never opened.
- **pi:** pass `--sessions-dir ~/.pi/agent/sessions`. A pi file has no active-leaf field, so its last entry is the leaf (see [Branch labels](#branch-labels)).

### Filters

Filters run after selection, in this order: the time window (historical scope), then `--branch`, then `--outcome`. An event removed by one filter is counted once, under the first filter that removes it, in `coverage.removedByFilters`.

- `--branch active` or `--branch abandoned` keeps one branch. Entries labelled `unknown` are removed by either; `all` keeps every entry.
- `--outcome` takes decision outcomes (`DecisionOutcome`: `classified`, `failed`, `skipped`) and model-turn outcomes (`TurnOutcome`: `stop`, `length`, `toolUse`, `error`, `aborted`, `other`, `unknown`). A decision value filters decision records only. A model-turn value filters `loadout.usage` records and transcript turns only.
- A model-turn filter sets `transcript.toolResults` and `transcript.toolErrors` to `null`: a tool result has no turn outcome, so it cannot be attributed to one.
- An unsupported record follows the window and branch filters, never the outcome filter.
- `filters` echoes what was applied. A list is `null` when no value of its kind was given.

### Branch labels

Each entry takes a `Branch` from its own session file:

- `active`: on the root path of the active leaf. The last entry with an id names the leaf through its `activeLeafId`; when that field is absent the entry itself is the leaf. If the named leaf is not in the file, the newest entry that is its own leaf is used.
- `abandoned`: any other entry with an id.
- `unknown`: an entry with no string id.

If the leaf is `null`, the chain from the leaf to a root is broken (a dangling parent, a cycle, or a `parentId` that is neither an id nor `null`), or the file has no ids, every entry of that file is `unknown`. Append order is never used to guess.

### Provenance and dedupe

Decision records (v3) and usage records carry an event id. The report keeps one instance per id and counts the discarded ones in `copies`. It keeps the instance from the file whose header id equals the record's `sessionId`. `Provenance` says where that instance came from:

- `origin`: kept from the session file that wrote it.
- `inherited`: no instance matches its own file, and the kept file's header id and the record's `sessionId` are both known and differ. This is a copied or forked history.
- `unknown`: the kept file has no header id, or the record has no `sessionId`.

Without a matching file, the first instance in sorted path order is kept. Files are read in sorted resolved-path order, so argument order never changes a result.

The v2 limit: a v2 decision has no event id, so it cannot be deduplicated. A forked session repeats its v2 decisions. Each one is counted in `coverage.unidentifiable.decisions` and has provenance `unknown` and `copies` 0.

Transcript turns have no identity, so they are never deduplicated: a copied history counts twice in `transcript`, and `transcript.deduplicated` is always `false`. The deduplicated figures are `decisions` and `usage`.

### Unknown versus zero

- A missing measurement is `null`, never `0`. A `Sum` (`{sum, known, unknown}`) adds only the known values and counts the unknown ones. A `known` of 0 is not a measured zero. A value that would push the total past what a number can hold is counted unknown as well, so no `Sum` or `Stats` ever holds `Infinity` or `NaN`.
- A `Stats` (`{n, mean, p10, p50, p90, max}`) covers known values only; every field is `null` when `n` is 0. Percentiles are nearest-rank over the in-scope sample.
- Closed vocabularies (the `Branch`, `TurnOutcome` and `Provenance` counts, `decisions.outcomes` and `decisions.blockers`) are zero-filled. Open maps (`decisions.skips`, `decisions.failures`, `classifier.models`, `usage.toolCalls.byTool` and the other open maps below) list only the keys seen.
- A boolean count is three-way: `yes`, `no` and `unknown`.
- A transcript turn's token counts are accepted only as safe integers of 0 or more, the check `normalizeUsage` applies to the counters of a `loadout.usage` record; any other value is `null`. A turn with no valid counter above 0 has every token count and its cost `null`. A turn with some counter above 0 keeps its zeros as zeros, and its missing counters stay `null`. The reader applies the same rule as the `loadout.usage` producer (section 8).

### Summary

`loadout-report summary` prints one `Summary` with `schema` `loadout-report.summary/1`. Every figure is after the scope and filters. An **attempt** is a decision whose outcome is not `skipped`. The `decisions` figures cover attempts, except `total`, `outcomes`, `versions` and `branch`, which cover every kept decision record, and `skips`, which counts only the skipped records.

| key | meaning |
| --- | --- |
| `schema` | `loadout-report.summary/1` |
| `scope` | what was selected (table below) |
| `filters` | what was applied (table below) |
| `coverage` | what was read, skipped or removed (table below) |
| `decisions` | `loadout.decision` records (table below) |
| `classifier` | classifier evidence of attempts (table below) |
| `usage` | `loadout.usage` records (table below) |
| `transcript` | host-transcript assistant turns (table below) |
| `http` | service-log join (table below); `null` without `--service-log` |
| `leads` | counted leads (see Leads) |
| `disclosures` | disclosure ids (see Disclosures) |

#### `scope`

| key | meaning |
| --- | --- |
| `scope.kind` | `session` or `historical` |
| `scope.files` | files selected, read or not |
| `scope.nestedChildFiles` | selected files that are child sessions: their `<name>/` directory has a parent `<name>.jsonl` |
| `scope.childFilesNotRead` | session scope only: `.jsonl` files under the named files' `<name>/` directories, not read; always 0 in a historical scope |
| `scope.childDirsUnreadable` | session scope only: child directories that could not be listed or examined, so `scope.childFilesNotRead` is a lower bound; not part of `coverage.files.unreadable`; always 0 in a historical scope |
| `scope.since`, `scope.until` | ISO UTC instants, `since` inclusive and `until` exclusive; `null` in a session scope |
| `scope.projects` | `exact` for `--project`, `all-projects`, or `null` in a session scope |

#### `filters`

| key | meaning |
| --- | --- |
| `filters.branch` | the `--branch` value: `all`, `active` or `abandoned` |
| `filters.outcome` | object with the two lists below |
| `filters.outcome.decision` | the decision outcome values applied, or `null` |
| `filters.outcome.usage` | the model-turn outcome values applied, or `null` |

#### `coverage`

The last column says when each counter is computed: before parsing, at file level, while reading, or after filters.

| key | meaning | computed |
| --- | --- | --- |
| `coverage.files` | object with the four file counts below | |
| `coverage.files.read` | selected files that were read | file level, before filters |
| `coverage.files.unreadable` | files that could not be read, `.jsonl` entries that do not resolve to a regular file (a pipe, a device, a symlink loop, a dangling link), and unreadable directories met while listing a root | file level, before filters |
| `coverage.files.withoutHeader` | read files with no session header among their first four non-blank lines | file level, before filters |
| `coverage.files.skippedByMtime` | files skipped because they were last modified before `since` | before parsing |
| `coverage.malformedLines` | non-blank session-file lines that are not a JSON object | file level, before filters |
| `coverage.duplicatesRemoved` | object with `decisions` and `usage` | while reading, before filters |
| `coverage.duplicatesRemoved.decisions` | instances of decision records discarded as duplicates | while reading, before filters |
| `coverage.duplicatesRemoved.usage` | instances of usage records discarded as duplicates | while reading, before filters |
| `coverage.unidentifiable` | object with `decisions` | after filters |
| `coverage.unidentifiable.decisions` | kept v2 decisions, which have no event id | after filters |
| `coverage.unsupported` | object with `decisions` and `usage` | after filters |
| `coverage.unsupported.decisions` | kept decision records of an unknown version or shape | after filters |
| `coverage.unsupported.usage` | kept usage records of an unknown version or shape | after filters |
| `coverage.provenance` | object with the three counts below | after filters |
| `coverage.provenance.origin` | kept identifiable decisions (v3) and usage records with `origin` provenance | after filters |
| `coverage.provenance.inherited` | the same, with `inherited` provenance | after filters |
| `coverage.provenance.unknown` | the same, with `unknown` provenance | after filters |
| `coverage.removedByFilters` | object with `decisions`, `usage` and `transcript`: counters of what the window and filters removed | after filters |
| `coverage.removedByFilters.decisions` | decision records and unsupported decision records removed | after filters |
| `coverage.removedByFilters.usage` | usage records and unsupported usage records removed | after filters |
| `coverage.removedByFilters.transcript` | transcript turns and tool results removed, counted together | after filters |
| `coverage.removedByFilters.<family>.outsideRange` | removed for lying outside `[since, until)` | after filters |
| `coverage.removedByFilters.<family>.unplaced` | removed for having no parsable timestamp (historical scope only) | after filters |
| `coverage.removedByFilters.<family>.branch` | removed by `--branch` | after filters |
| `coverage.removedByFilters.<family>.outcome` | removed by `--outcome`; unsupported records never are | after filters |

#### `decisions`

| key | meaning |
| --- | --- |
| `decisions.total` | kept decision records, skipped included |
| `decisions.outcomes` | object with `classified`, `failed` and `skipped` (below) |
| `decisions.outcomes.classified`, `.failed`, `.skipped` | kept records by outcome |
| `decisions.versions` | object with `v2` and `v3` (below) |
| `decisions.versions.v2`, `.v3` | kept records by version (v2 has no event id) |
| `decisions.branch` | kept records by `Branch` |
| `decisions.skips` | skipped records by skip reason (values in section 4); open map, `unknown` when no reason is recorded |
| `decisions.sessions` | session files holding at least one attempt |
| `decisions.dryRun` | object with `yes`, `no` and `unknown` (below) |
| `decisions.dryRun.yes`, `.no`, `.unknown` | attempts by dry run (the `settings.dryRun` flag; v2 has its own flag) |
| `decisions.failures` | failed attempts by failure reason (values in section 4); open map, `unknown` when none is recorded |
| `decisions.latencyMs` | `Stats` of the classifier's elapsed milliseconds (v2: its recorded `latencyMs`) |
| `decisions.proposals` | object with the keys below; a proposal is what the classifier asked for |
| `decisions.proposals.tools` | attempts with a tools record |
| `decisions.proposals.none` | attempts with no tools record |
| `decisions.proposals.narrowing` | proposals that name an active set (`tools.active` is not `null`) |
| `decisions.proposals.keepBaseline` | proposals that keep the baseline (`tools.active` is `null`) |
| `decisions.proposals.profiles` | proposals by profile; `(none)` when no profile is recorded |
| `decisions.proposals.reasons` | proposals by tools reason (values in section 4); `failed` for an attempt with no tools record |
| `decisions.proposals.proposedTools` | `Stats` of the tool count of each narrowing proposal |
| `decisions.proposals.risk` | `Stats` of the risk of each proposal |
| `decisions.application` | object with `statuses` and `actualTools` (below) |
| `decisions.application.statuses` | attempts by application status (values in section 4); `unknown` when there is no application record |
| `decisions.application.actualTools` | `Stats` of the tools the host reported after applying or restoring |
| `decisions.selection` | object with `narrow`, `keep-baseline` and `none` (below) |
| `decisions.selection.narrow` | application statuses of narrowing proposals; open map |
| `decisions.selection.keep-baseline` | application statuses of baseline-keeping proposals; open map |
| `decisions.selection.none` | application statuses of attempts with no tools record; open map |
| `decisions.ratchet` | object with `blocked`, `admitted` and `unknown` (below) |
| `decisions.ratchet.blocked`, `.admitted`, `.unknown` | attempts the widen-only ratchet refused, admitted, or could not say |
| `decisions.skills` | object with the four keys below |
| `decisions.skills.reasons` | attempts by skill reason (values in section 4); `failed` when there is no skills record |
| `decisions.skills.selected` | count per selected skill name, over attempts; `(none)` for an empty selection |
| `decisions.skills.candidateLimit` | attempts whose skill reason is `too-many-candidates` |
| `decisions.skills.delivery` | attempts by skill delivery (values in section 4); `unknown` when none is recorded |
| `decisions.blockers` | count per lead id, zero-filled; each equals that lead's `count`, or 0 when the lead is absent |

#### `classifier`

| key | meaning |
| --- | --- |
| `classifier.attempts` | attempts |
| `classifier.evidence` | attempts with a classifier record |
| `classifier.guardFired` | object with `yes`, `no` and `unknown` (below) |
| `classifier.guardFired.yes`, `.no`, `.unknown` | the time-budget guard fired: the request was aborted at its budget |
| `classifier.tokens` | object with `input` and `output` (below) |
| `classifier.tokens.input`, `.output` | `Sum` of the backend's reported input and output tokens (`classifier.usage`) |
| `classifier.server` | object with the four keys below |
| `classifier.server.reported`, `.unreported` | attempts whose classifier record carries server timing, and the rest (see section 13) |
| `classifier.server.queueMs`, `.inferenceMs` | `Stats` of the server's queue and inference milliseconds |
| `classifier.models` | attempts by model id; open map, `unknown` when none is recorded |
| `classifier.requestIds` | object with `present` and `absent` (below) |
| `classifier.requestIds.present`, `.absent` | attempts with and without a request id |
| `classifier.promptClipped` | object with `yes`, `no` and `unknown` (below) |
| `classifier.promptClipped.yes`, `.no`, `.unknown` | `yes` when the prompt was longer than what was sent (`promptChars` above `sentChars`); `unknown` when either is missing |

#### `usage`

| key | meaning |
| --- | --- |
| `usage.turns` | kept `loadout.usage` records, deduplicated by event id |
| `usage.runs` | distinct `runId` values |
| `usage.hosts` | records by host (`omp` or `pi`); open map |
| `usage.outcomes` | records by `TurnOutcome`; a `null` stop reason counts as `unknown` |
| `usage.branch` | records by `Branch` |
| `usage.tokens` | object with the five token counters (below) |
| `usage.tokens.input`, `.output`, `.cacheRead`, `.cacheWrite`, `.reasoning` | `Sum` of each token counter |
| `usage.cost` | `Sum` of `costTotal` |
| `usage.toolCalls` | object with `total` and `byTool` (below) |
| `usage.toolCalls.total` | tool calls summed over the records |
| `usage.toolCalls.byTool` | tool calls by name; open map; a name that is not an identifier was already dropped by the normalizer |
| `usage.toolErrors` | `Sum` of tool errors |
| `usage.errorStatus` | records by HTTP error status; records with no status are not counted |
| `usage.retries` | object with the four keys below |
| `usage.retries.reported`, `.unreported` | records with and without `retryAttempt` |
| `usage.retries.maxAttempt` | the largest reported `retryAttempt`; `null` when none is reported |
| `usage.retries.byAttempt` | records by `retryAttempt` value; the report gives the value no meaning |
| `usage.assignment` | object with `assigned` and `unassigned` (below) |
| `usage.assignment.assigned`, `.unassigned` | records with and without a `decisionId` |

#### `transcript`

| key | meaning |
| --- | --- |
| `transcript.turns` | kept assistant messages; not deduplicated |
| `transcript.outcomes` | turns by `TurnOutcome` |
| `transcript.branch` | turns by `Branch` |
| `transcript.tokens` | object with the four token counters (below) |
| `transcript.tokens.input`, `.output`, `.cacheRead`, `.cacheWrite` | `Sum` of each counter in the turns' usage blocks |
| `transcript.cost` | `Sum` of each turn's `usage.cost.total` |
| `transcript.toolCalls` | object with `total` and `byTool` (below) |
| `transcript.toolCalls.total` | tool calls in the kept turns |
| `transcript.toolCalls.byTool` | tool calls by name. A transcript's tool names are the model's own text, so a name is printed only when a `loadout.usage` record's `toolCalls` or a decision's `application.actualTools`, in the same scope and filters, names that tool. Every other name, identifier-shaped or not, counts as `(redacted)`, and `total` does not change. A session with no plugin record prints only `(redacted)` |
| `transcript.toolResults` | kept tool-result messages; `null` under a model-turn filter |
| `transcript.toolErrors` | kept tool results with `isError`; `null` under a model-turn filter |
| `transcript.deduplicated` | always `false` |

#### `http`

`null` without `--service-log`. Otherwise (see [Service-log join](#service-log-join)):

| key | meaning |
| --- | --- |
| `http.files` | distinct service-log files |
| `http.unreadable` | service-log files that could not be read |
| `http.lines` | object with the four counters below |
| `http.lines.total` | non-blank lines read |
| `http.lines.records` | lines that parsed as `loadout.http` records, before identical repeats are removed |
| `http.lines.unsupported` | `loadout.http` lines of an unknown version or an invalid shape |
| `http.lines.other` | every other non-blank line |
| `http.records` | records kept after identical repeats are removed; every record of a conflicting id is kept |
| `http.duplicates` | identical repeats removed |
| `http.conflicts` | request ids with two or more different records |
| `http.joined` | joinable attempts whose id has exactly one record |
| `http.unmatched` | object with the five counters below |
| `http.unmatched.clientWithoutRecord` | joinable attempts whose id has no record |
| `http.unmatched.notJoinable` | attempts with a request id that cannot join |
| `http.unmatched.ambiguous` | joinable attempts whose id has two or more different records |
| `http.unmatched.recordsNotInScope` | records whose id no joinable in-scope attempt names |
| `http.unmatched.recordsWithoutRequestId` | records with no valid request id |
| `http.outcomes` | joined records by outcome; open map |
| `http.phases` | object with `queueMs`, `inferenceMs` and `totalMs` (below) |
| `http.phases.queueMs`, `.inferenceMs`, `.totalMs` | `Stats` over the joined records |
| `http.timeouts` | object with the five keys below |
| `http.timeouts.clientTimeouts` | joinable attempts that failed with `timeout` |
| `http.timeouts.joined` | those attempts that joined a record |
| `http.timeouts.outcomes` | outcomes of the records joined to them; open map |
| `http.timeouts.queueMs`, `.inferenceMs` | `Stats` over those records |

### Leads

| key | meaning |
| --- | --- |
| `leads` | counted leads, only those with `count` above 0, highest count first, then by id |
| `leads[].id` | a lead id from the table below |
| `leads[].count` | attempts in the population that match |
| `leads[].of` | size of the population |
| `leads[].evidence` | detail for the lead, see the table below |

A lead is a count with the population it is out of. Leads name no remedy and make no claim about causes or savings.

| lead id | counts | population (`of`) | `evidence` keys |
| --- | --- | --- | --- |
| `classifier-failed` | failed attempts | attempts | `failures` (per failure reason); `guardFired` (failed attempts whose budget guard fired); `serverEvidence`: `null` without a service log, else `joined` (the failed attempts' joined records) and their `outcomes` |
| `low-confidence` | attempts whose tools reason is `low-confidence` | attempts with a tools record | `closestNarrowerRisk` (`Stats` of each attempt's smallest known risk among narrower profiles); `riskUnknown` (attempts with no known narrower risk); `maxRisk` (distinct values, sorted) |
| `ratchet-refused` | narrowing proposals whose application status is `not-admitted` | narrowing proposals with an application record | none (`{}`) |
| `candidate-limit` | attempts whose skill reason is `too-many-candidates` | attempts with a skills record | `eligible` (`Stats`); `maxCandidates` (distinct values, sorted) |
| `application-failed` | attempts whose application status is `failed` | attempts with an application record | `errors` (per error code, `unknown` when none); `restoration` (per restoration value, `none` when none) |

### Service-log join

Only with `--service-log`. Without one, `http` is `null` and every join figure is unknown, not zero. The reader takes each line from its first `{` and parses a `loadout.http` record from there, so a journald prefix or `journalctl -o cat` output both parse. A record's `outcome` is one of `ok`, `client-gone`, `error` or `rejected`. A disconnect (`client-gone`) is not a cause: it is counted as an outcome, and the report never treats it as the reason an attempt failed.

- **Joinable attempt:** a non-skipped decision with a request id whose settings name the `http` transport. The request id is the only join key, and the time range never filters service records.
- **Not joinable:** any other attempt with a request id is `unmatched.notJoinable`. It cannot have a server record, so its id is no evidence that a record is missing.
- **Absent evidence is unknown:** a joinable attempt whose id has no record is `unmatched.clientWithoutRecord`. That means the record is not in the log, not that the server did no work.
- **Conflicts:** records that differ for one request id join nothing. All of them stay counted in `records`, the id counts once in `conflicts`, and each attempt that names it is `unmatched.ambiguous`. An identical repeat counts once, in `duplicates`.
- **No id:** a record without a valid request id is never deduplicated or joined. It is counted in `unmatched.recordsWithoutRequestId`. `unmatched.recordsNotInScope` counts records whose id no joinable in-scope attempt names.
- **Invariant:** `http.joined`, `unmatched.clientWithoutRecord`, `unmatched.ambiguous` and `unmatched.notJoinable` add up to `classifier.requestIds.present`.
- **Lines:** a line of `loadout.http` type with an unknown version or an invalid shape is `lines.unsupported`. Any other non-blank line is `lines.other`.

### Export

`loadout-report export` prints one `ExportDoc` with `schema` `loadout-report.export/1`, the same `scope`, `filters` and `coverage` as the summary, and:

| key | meaning |
| --- | --- |
| `http` | `null` without a service log; otherwise an object with `records` and `exported` |
| `http.records` | records the log held, after identical repeats were removed |
| `http.exported` | joined service records written to `events` |
| `disclosures` | disclosure ids (see Disclosures) |
| `events` | one `ExportEvent` per record: decisions (skipped included), then usage, then joined service records; each group in time order, unplaced entries last |

Each `ExportEvent`:

| key | meaning |
| --- | --- |
| `type` | `decision`, `usage` or `http` |
| `at` | ISO UTC: the entry's timestamp, or the service record's own `at`; `null` when unplaced |
| `branch` | the entry's `Branch`; `null` for `http` |
| `provenance` | the record's `Provenance`; `null` for `http` |
| `copies` | discarded duplicate instances; `null` for `http` |
| `record` | the allowlisted fields of the record |

`record` is rebuilt from a declared allowlist: `DECISION`, `USAGE` and `HTTP` in [`src/report/export.ts`](../src/report/export.ts). A field that is not on its list is dropped, whatever the record carried. A new view field stays out of exports until it is added to the list on purpose; the test suite fails when a view field is missing from a list. No free-text field is on any list. Identifier-shaped values in identifier fields are exported (see the disclosure `identifiers-are-local-metadata-not-anonymous`). An export never includes a path, a title, a message, a tool argument or result, or a working directory, and the reporter never adds a session file's own header id or the entry ids it reads to label branches. A record's own ids are exported as the plugin recorded them: `sessionId`, which usually equals that header id, and a usage record's `hostEntryId`, which is pi's entry id when the plugin recorded one.

### Disclosures

Every summary and export carries these ids in `disclosures`.

- `identifiers-are-local-metadata-not-anonymous`: the ids a record carries (session, event, decision, run and request ids, and a usage record's host entry id) and the names it carries (model ids, profile, tool and skill names, and an HTTP `errorClass`) are exported as recorded when identifier-shaped; they are local metadata, not anonymous.
- `proposals-are-not-applied-changes`: a tools or skills proposal is what the classifier asked for; `application` records what the host had afterwards, and no figure is a saving.
- `unknown-is-not-zero`: a missing measurement is `null` or counted as unknown, never zero.
- `usage-and-transcript-are-separate-sources`: `loadout.usage` records and transcript turns are reported in separate sections and are never added together.
- `no-child-session-rollup`: nested child sessions are read and counted as their own sessions, and nothing is rolled up into a parent.
- `observed-usage-is-not-billing`: token and cost figures are what the host reported for each turn; they are not a bill.
- `absent-records-are-not-evidence-of-no-activity`: a missing decision, usage or service record means the activity is unknown, not that nothing happened.

### Shortcuts

- **Whole-file reads.** Each file is read whole, one at a time, so memory is bounded by the largest file plus the extracted events. A whole-machine scan reads every transcript byte; selection prunes before any file is parsed. A file larger than the JavaScript engine's string limit counts as unreadable. Upgrade to streaming if real transcripts approach that limit or scans become too slow.
- **mtime pre-filter.** A restore or copy tool that resets modification times can hide old files from the pre-filter. `coverage.files.skippedByMtime` makes the count visible.
- **One object per line.** Concatenated JSON objects on one line count as malformed; the host writes one object per line.
- **Directory listing.** Unreadable directories are skipped and counted in `coverage.files.unreadable`. Symlinked directories are not followed. A listed `.jsonl` entry that does not resolve to a regular file (a pipe, a device, a symlink loop, a dangling link) is counted there too and never opened.
- **Service-log framing.** A line is parsed from its first `{`. A prefix that itself contains `{` breaks that line, which then counts as `lines.other`.
- **Completions.** No shell completions.
- **Percentiles.** Nearest-rank over the in-scope sample, not estimates.

## 12. Synthetic examples

Classified (abridged):

```json
{"v":3,"eventId":"6f1c2a9e-3b4d-4c5e-8f60-7a8b9c0d1e2f","sessionId":"s-1","decisionId":"0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d","outcome":"classified","skip":null,"failure":null,"settings":{"enabled":true,"backend":"jev","transport":null,"dryRun":false,"notify":true,"maxPromptChars":8000,"configScope":"global","tools":{"enabled":true,"maxRisk":0.1},"skills":{"enabled":true,"mode":"auto","threshold":0.5,"maxSkills":5,"maxCandidates":40}},"classifier":{"requestId":"1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f","model":"jev-latest","elapsedMs":212,"budgetMs":3250,"timeoutMs":3000,"guardFired":false,"usage":{"inputTokens":41,"outputTokens":3},"server":null,"status":null,"promptChars":24,"sentChars":24,"questions":3},"tools":{"reason":"selected","profile":"answer","active":["read","grep","find","ls"],"probabilities":{"answer":0.95,"edit":0.03,"full":0.02},"risk":0.05,"risks":[{"profile":"answer","risk":0.05},{"profile":"edit","risk":0.02}],"maxRisk":0.1},"skills":{"reason":"selected","selected":["pdf"],"scores":{"pdf":0.9},"discovered":2,"eligible":2,"maxCandidates":40,"asked":2,"filteredOut":1,"delivery":"filter"},"ratchet":{"narrowAllowed":true,"before":null,"after":"answer","admitted":true},"application":{"status":"applied","restoration":null,"actualTools":["read","grep","find","ls"],"error":null}}
```

Skipped:

```json
{"v":3,"eventId":"2b3c4d5e-6f70-4a81-92a3-b4c5d6e7f809","sessionId":"s-1","decisionId":"3c4d5e6f-7081-4a92-a3b4-c5d6e7f8091a","outcome":"skipped","skip":"command","failure":null,"settings":{"enabled":true,"backend":"jev","transport":null,"dryRun":false,"notify":true,"maxPromptChars":8000,"configScope":"default","tools":{"enabled":true,"maxRisk":0.1},"skills":{"enabled":false,"mode":"auto","threshold":0.5,"maxSkills":5,"maxCandidates":40}},"classifier":null,"tools":null,"skills":null,"ratchet":null,"application":{"status":"restored","restoration":"restored","actualTools":["read","bash","edit","write","grep","find","ls"],"error":null}}
```

Failed (abridged): `"outcome":"failed","failure":"unavailable","tools":null`, a `classifier` with `requestId` set and `status` 500, and `application.status` `not-attempted`.

`loadout.usage`:

```json
{"v":1,"eventId":"4d5e6f70-8192-4aa3-b4c5-d6e7f8091a2b","sessionId":"s-1","runId":"5e6f7081-92a3-4bb4-85c6-e7f8091a2b3c","decisionId":"0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d","turnIndex":1,"host":"omp","hostEntryId":null,"stopReason":"stop","tokens":{"input":600,"output":100,"cacheRead":400,"cacheWrite":0,"reasoning":null},"costTotal":0.006,"toolCalls":{"read":1},"toolErrors":0,"errorStatus":null,"retryAttempt":null}
```

`loadout.http`:

```json
{"type":"loadout.http","v":1,"requestId":"1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f","idStatus":"valid","at":"2026-10-16T12:00:00.123Z","outcome":"ok","status":200,"queueMs":1,"inferenceMs":38,"totalMs":41,"errorClass":null}
```

## 13. Known limits

- This page is not packaged with the npm release.
- `classifier.status` and `classifier.server` are null until #4; `loadout.usage` and `loadout.http` have no producer until #4 and #5.
- After a low-confidence or failed turn the ratchet keeps narrowing locked until compaction or `/loadout on|off`. This is visible in `ratchet` but unchanged.
- The Laya HTTP server has no request deadline.
- No durability guarantee: see section 7.

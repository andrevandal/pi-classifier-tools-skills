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
- `npm run decisions` summarizes non-skipped records and reports `skipped` (by reason) and `unsupported` separately.
- `npm run bench` refuses to run when the machine opts out or the setting is unreadable, and sets `telemetry: true` in each arm's config. A YAML machine file read under Node has no parser, so use a JSON machine file or run under Bun. Bench `activeToolNames` and `applied` reflect the host's real tools when a v3 record provides them.

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

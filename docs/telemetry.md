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

`classifier.status` is the HTTP status of a failed call; null on success and for non-HTTP transports. `classifier.server` and `status` stay null until #4 fills them.

## 7. Durability

"Handed to host" means the host's append did not raise. It does not mean the record reached disk.

- pi throws EACCES on a disk error but keeps the entry in memory.
- OMP swallows disk errors; the plugin cannot see them.
- Both defer writes until the first assistant message.

The plugin counts per session `{handedOff, suppressed, failed, lastFailure}`, shown by `/loadout status`, and shows one `warning` notice (code only) on the first failure. A persistence failure never aborts the turn. An unserializable payload is refused before the host sees it (code `serialize`).

## 8. `loadout.usage` v1 and `loadout.http` v1

Defined here, with normalizers (`normalizeUsage`, `normalizeHttp`); nothing produces them yet. Completeness is per field: `null` means not observed or not reported by this host, `decisionId: null` means unassigned. There is no separate completeness flag. A producer builds a candidate and appends `normalizeUsage(candidate)`; a null result is not appended.

`loadout.usage` v1, one per assistant message:

| field | meaning |
| --- | --- |
| `v`, `eventId`, `sessionId`, `runId`, `decisionId`, `turnIndex` | identity; `eventId` and `runId` are UUIDv4 |
| `host` | `omp` or `pi` |
| `hostEntryId` | pi's entry id when given; null on OMP |
| `stopReason` | `stop` `length` `toolUse` `error` `aborted` `other`, or null |
| `tokens` | `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, each a number or null. A synthetic failure's zero usage is unknown, so null |
| `costTotal`, `toolCalls` (name to count), `toolErrors`, `errorStatus` | totals for the message |
| `retryAttempt` | informational only |

`loadout.http` v1, one per Laya HTTP server request:

| field | meaning |
| --- | --- |
| `type`, `v` | `loadout.http`, `1` |
| `requestId`, `idStatus` | the `X-Request-Id`; `idStatus` is `valid`, `absent` or `invalid`, and is derived from the id on read |
| `at` | UTC ISO timestamp |
| `outcome` | `ok` `client-gone` `error` `rejected`. `ok` means the write did not raise, not that it was delivered. Never infer a timeout from EPIPE |
| `status`, `queueMs`, `inferenceMs`, `totalMs` | from the response and `Server-Timing` (`queue`, `infer`); Laya only |
| `errorClass` | `^[A-Za-z][A-Za-z0-9_]{0,63}$` or null |

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

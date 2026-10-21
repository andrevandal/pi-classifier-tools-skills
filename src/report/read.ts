/**
 * Read session transcripts and service logs into normalized, content-free events.
 *
 * The reader never writes and keeps no text from a transcript: message content, titles, tool arguments, error
 * text and every key it does not name are never read. Plugin records go through the frozen normalizers of
 * `../telemetry.ts`, so a hostile record cannot carry free text into a report. A damaged line, file or
 * directory is counted and skipped; a transcript being written while we read it must not abort a report.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DECISION_ENTRY,
  type DecisionView,
  HTTP_ENTRY,
  type HttpServerRecordV1,
  normalizeDecision,
  normalizeHttp,
  normalizeUsage,
  USAGE_ENTRY,
  type UsageObservationV1,
} from "../telemetry.ts";

export type Branch = "active" | "abandoned" | "unknown";
export type Provenance = "origin" | "inherited" | "unknown";
export type TurnOutcome = "stop" | "length" | "toolUse" | "error" | "aborted" | "other" | "unknown";

/** `at` is epoch milliseconds from the host entry's `timestamp`; the plugin record carries no time of its own. */
export interface Where {
  file: number;
  /** 0-based line number. */
  index: number;
  at: number | null;
  branch: Branch;
}

/** `copies` is the number of discarded duplicate instances. */
export interface Identity {
  provenance: Provenance;
  copies: number;
}

export interface FileInfo {
  /** Resolved; never exported. */
  path: string;
  /** The header's session id, compared with a record's `sessionId` and never exported. */
  id: string | null;
  /** The header's working directory, compared with `--project` and never exported. */
  cwd: string | null;
  hasHeader: boolean;
  unreadable: boolean;
  nestedChild: boolean;
  malformedLines: number;
}

export interface DecisionEvent {
  kind: "decision";
  where: Where;
  view: DecisionView;
  identity: Identity;
}

export interface UsageEvent {
  kind: "usage";
  where: Where;
  record: UsageObservationV1;
  identity: Identity;
}

/** One assistant message of the host transcript. Never any text. */
export interface TurnEvent {
  kind: "turn";
  where: Where;
  outcome: TurnOutcome;
  tokens: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null };
  cost: number | null;
  tools: Record<string, number>;
}

export interface ToolResultEvent {
  kind: "toolResult";
  where: Where;
  isError: boolean;
}

export interface UnsupportedEvent {
  kind: "unsupported";
  family: "decision" | "usage";
  where: Where;
}

export interface SessionRead {
  /** Sorted by resolved path; `Where.file` indexes this array. */
  files: FileInfo[];
  decisions: DecisionEvent[];
  usage: UsageEvent[];
  turns: TurnEvent[];
  toolResults: ToolResultEvent[];
  unsupported: UnsupportedEvent[];
  duplicatesRemoved: { decisions: number; usage: number };
}

export interface ServiceRead {
  files: number;
  unreadable: number;
  lines: { total: number; records: number; unsupported: number; other: number };
  /** After dedupe of identical repeats by valid request id; records without an id are kept. */
  records: HttpServerRecordV1[];
  duplicates: number;
}

/** The identifier pattern of `telemetry.ts` (its private `SAFE_NAME`); a test pins the two together. */
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,99}$/;

/** What stands in for a value a report must not print. */
export const REDACTED = "(redacted)";
/** The host writes the header on line 1 or 2, after an optional title slot. */
const HEADER_WINDOW = 4;
const PEEK_BYTES = 64 * 1024;
const TURN_OUTCOMES: readonly string[] = ["stop", "length", "toolUse", "error", "aborted"];

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}))?$/;

/**
 * An ISO date (UTC midnight) or an ISO date-time with `Z` or `+-HH:MM`, to epoch milliseconds; null for anything
 * else. `Date.parse` is not used: it reads a zone-less time as local time, accepts prose and rolls impossible
 * dates over.
 */
export function parseInstant(text: string): number | null {
  const m = INSTANT.exec(text);
  if (m === null) return null;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4] ?? "0", m[5] ?? "0", m[6] ?? "0"].map(
    Number,
  ) as [number, number, number, number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (year < 1970 || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offset = 0;
  const zone = m[8];
  if (zone !== undefined && zone !== "Z") {
    const [oh, om] = [Number(zone.slice(1, 3)), Number(zone.slice(4, 6))];
    if (oh > 23 || om > 59) return null;
    offset = (zone[0] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  const ms = Number((m[7] ?? "").slice(0, 3).padEnd(3, "0"));
  return Date.UTC(year, month - 1, day, hour, minute, second, ms) - offset * 60_000;
}

// ---------------------------------------------------------------------------
// Discovery and headers
// ---------------------------------------------------------------------------

export function defaultSessionsDir(): string {
  return path.join(os.homedir(), ".omp", "agent", "sessions");
}

/** The resolved path of a file, or `path.resolve` when it cannot be resolved (it does not exist). */
export function canonical(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** `fs.statSync`, or null when the path cannot be examined: missing, a symlink loop, no permission. */
export function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

/** The text of a regular file. Null for anything else (opening a pipe or a device would block) or on a read error. */
function readRegularText(file: string): string | null {
  if (statOrNull(file)?.isFile() !== true) return null;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Every `.jsonl` file under `root`, recursive and sorted by plain comparison. A missing root yields none; an
 * unreadable directory calls `onUnreadable` and is skipped.
 */
export function listSessionFiles(root: string, onUnreadable?: () => void): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      onUnreadable?.();
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return files.sort();
}

function parseObject(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function findHeader(lines: readonly string[]): { index: number; id: string | null; cwd: string | null } | null {
  let seen = 0;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    if (++seen > HEADER_WINDOW) return null;
    const entry = parseObject(line);
    if (entry?.type === "session") {
      return {
        index,
        id: typeof entry.id === "string" ? entry.id : null,
        cwd: typeof entry.cwd === "string" ? entry.cwd : null,
      };
    }
  }
  return null;
}

/**
 * A bounded peek at a session's header: at most the first 64 KiB, under the same first-four-non-blank-lines
 * rule as a full read. Null when the file has no header, is not a regular file or cannot be read.
 */
export function readHeader(file: string): { id: string | null; cwd: string | null } | null {
  if (statOrNull(file)?.isFile() !== true) return null;
  let text: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(PEEK_BYTES);
      const bytes = fs.readSync(fd, buffer, 0, PEEK_BYTES, 0);
      text = buffer.toString("utf8", 0, bytes);
      // A full buffer ends mid-line: drop the partial last line.
      if (bytes === PEEK_BYTES) text = text.slice(0, text.lastIndexOf("\n") + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const header = findHeader(text.split("\n"));
  return header === null ? null : { id: header.id, cwd: header.cwd };
}

// ---------------------------------------------------------------------------
// Branch labels
// ---------------------------------------------------------------------------

/**
 * Active means on the root path of the active leaf, by the host's own rule (OMP `resolveSessionLeafId`; pi's
 * leaf is the last entry, which the same rule yields because pi entries carry no `activeLeafId`). A file with no
 * ids, no leaf, a dangling parent, a cycle or a root that is not `parentId === null` is all `unknown`. Append
 * order is never used to guess.
 */
function labelBranches(entries: Record<string, unknown>[]): Branch[] {
  const unknown = (): Branch[] => entries.map(() => "unknown");
  const withId = entries.filter((entry) => typeof entry.id === "string");
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of withId) if (!byId.has(entry.id as string)) byId.set(entry.id as string, entry);
  const selects = (entry: Record<string, unknown>): string | null =>
    typeof entry.activeLeafId === "string" || entry.activeLeafId === null ? entry.activeLeafId : (entry.id as string);
  const last = withId.at(-1);
  if (last === undefined) return unknown();
  let leaf = selects(last);
  if (leaf !== null && leaf !== last.id && !byId.has(leaf)) {
    leaf = (withId.findLast((entry) => selects(entry) === entry.id)?.id as string | undefined) ?? null;
  }
  const onPath = new Set<string>();
  for (let cursor = leaf; cursor !== null; ) {
    const node = byId.get(cursor);
    if (node === undefined || onPath.has(cursor)) return unknown();
    onPath.add(cursor);
    const parent = node.parentId;
    if (parent !== null && typeof parent !== "string") return unknown();
    cursor = parent;
  }
  if (leaf === null) return unknown();
  return entries.map((entry) =>
    typeof entry.id !== "string" ? "unknown" : onPath.has(entry.id) ? "active" : "abandoned",
  );
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/** A finite number >= 0, else null: a message's cost. */
function measure(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A safe integer >= 0, else null: the check `normalizeUsage` applies to token counts, so no sum can overflow. */
function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function turnOf(where: Where, message: Record<string, unknown>): TurnEvent {
  const usage = isObject(message.usage) ? message.usage : {};
  let tokens = {
    input: tokenCount(usage.input),
    output: tokenCount(usage.output),
    cacheRead: tokenCount(usage.cacheRead),
    cacheWrite: tokenCount(usage.cacheWrite),
  };
  let cost = measure(isObject(usage.cost) ? usage.cost.total : undefined);
  // Zeros everywhere (or no usage block) carry no measurement, so they are never reported as measured zeros.
  if (!Object.values(tokens).some((value) => value !== null && value > 0)) {
    tokens = { input: null, output: null, cacheRead: null, cacheWrite: null };
    cost = null;
  }
  const stop = message.stopReason;
  const outcome: TurnOutcome =
    typeof stop !== "string" ? "unknown" : TURN_OUTCOMES.includes(stop) ? (stop as TurnOutcome) : "other";
  const calls = new Map<string, number>();
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (!isObject(part) || part.type !== "toolCall") continue;
    const name = typeof part.name === "string" && IDENTIFIER.test(part.name) ? part.name : REDACTED;
    calls.set(name, (calls.get(name) ?? 0) + 1);
  }
  return { kind: "turn", where, outcome, tokens, cost, tools: Object.fromEntries(calls) };
}

interface Scanned {
  info: FileInfo;
  decisions: DecisionEvent[];
  usage: UsageEvent[];
  turns: TurnEvent[];
  toolResults: ToolResultEvent[];
  unsupported: UnsupportedEvent[];
}

/** A child session sits in `<parent session file minus .jsonl>/`. A parent location that cannot be examined is no parent. */
function isNestedChild(file: string): boolean {
  return statOrNull(`${path.dirname(file)}.jsonl`)?.isFile() === true;
}

function scanFile(file: string, fileIndex: number): Scanned {
  const info: FileInfo = {
    path: file,
    id: null,
    cwd: null,
    hasHeader: false,
    unreadable: false,
    nestedChild: isNestedChild(file),
    malformedLines: 0,
  };
  const out: Scanned = { info, decisions: [], usage: [], turns: [], toolResults: [], unsupported: [] };
  const text = readRegularText(file);
  if (text === null) {
    info.unreadable = true;
    return out;
  }
  const lines = text.split("\n");
  const header = findHeader(lines);
  if (header !== null) {
    info.hasHeader = true;
    info.id = header.id;
    info.cwd = header.cwd;
  }

  const tree: Array<{ index: number; entry: Record<string, unknown> }> = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    const entry = parseObject(line);
    if (entry === null) info.malformedLines++;
    else if (index !== header?.index && entry.type !== "title") tree.push({ index, entry });
  }
  const labels = labelBranches(tree.map((item) => item.entry));

  for (const [k, { index, entry }] of tree.entries()) {
    const stamp = typeof entry.timestamp === "string" ? parseInstant(entry.timestamp) : null;
    const where: Where = { file: fileIndex, index, at: stamp, branch: labels[k] ?? "unknown" };
    const identity: Identity = { provenance: "unknown", copies: 0 };
    if (entry.type === "custom" && entry.customType === DECISION_ENTRY) {
      const view = normalizeDecision(entry.data);
      if (view === null) out.unsupported.push({ kind: "unsupported", family: "decision", where });
      else out.decisions.push({ kind: "decision", where, view, identity });
    } else if (entry.type === "custom" && entry.customType === USAGE_ENTRY) {
      const record = normalizeUsage(entry.data);
      if (record === null) out.unsupported.push({ kind: "unsupported", family: "usage", where });
      else out.usage.push({ kind: "usage", where, record, identity });
    } else if (entry.type === "message" && isObject(entry.message)) {
      if (entry.message.role === "assistant") out.turns.push(turnOf(where, entry.message));
      else if (entry.message.role === "toolResult") {
        out.toolResults.push({ kind: "toolResult", where, isError: entry.message.isError === true });
      }
    }
  }
  return out;
}

/** `(at, file, line)` with an unplaced event last. */
function byWhere(a: { where: Where }, b: { where: Where }): number {
  const x = a.where.at ?? Number.POSITIVE_INFINITY;
  const y = b.where.at ?? Number.POSITIVE_INFINITY;
  if (x !== y) return x < y ? -1 : 1;
  return a.where.file - b.where.file || a.where.index - b.where.index;
}

/**
 * Keep one instance per `eventId`: the first whose file header id equals the record's `sessionId`, else the first
 * in canonical order. A record with no `eventId` (a v2 decision) cannot be deduplicated and is kept as read.
 */
function dedupe<T extends { where: Where; identity: Identity }>(
  events: readonly T[],
  keyOf: (event: T) => { eventId: string | null; sessionId: string | null },
  headerIds: ReadonlyArray<string | null>,
): { events: T[]; removed: number } {
  const groups = new Map<string, T[]>();
  const kept: T[] = [];
  for (const event of events) {
    const eventId = keyOf(event).eventId;
    if (eventId === null) {
      kept.push(event);
      continue;
    }
    const group = groups.get(eventId);
    if (group === undefined) groups.set(eventId, [event]);
    else group.push(event);
  }
  let removed = 0;
  for (const group of groups.values()) {
    const owner = group.find((event) => {
      const headerId = headerIds[event.where.file] ?? null;
      return headerId !== null && headerId === keyOf(event).sessionId;
    });
    const winner = owner ?? (group[0] as T);
    const known = keyOf(winner).sessionId !== null && (headerIds[winner.where.file] ?? null) !== null;
    winner.identity = {
      provenance: owner !== undefined ? "origin" : known ? "inherited" : "unknown",
      copies: group.length - 1,
    };
    removed += group.length - 1;
    kept.push(winner);
  }
  return { events: kept.sort(byWhere), removed };
}

/**
 * Read session files into events. Files are deduplicated by resolved path and sorted, so the result never depends
 * on argument order. Never throws: an unreadable file is marked and skipped.
 */
export function readSessions(files: readonly string[]): SessionRead {
  const paths = [...new Set(files.map(canonical))].sort();
  const scanned = paths.map((file, index) => scanFile(file, index));
  const headerIds = scanned.map((item) => item.info.id);
  const decisions = dedupe(
    scanned.flatMap((item) => item.decisions),
    (event) => ({ eventId: event.view.eventId, sessionId: event.view.sessionId }),
    headerIds,
  );
  const usage = dedupe(
    scanned.flatMap((item) => item.usage),
    (event) => ({ eventId: event.record.eventId, sessionId: event.record.sessionId }),
    headerIds,
  );
  return {
    files: scanned.map((item) => item.info),
    decisions: decisions.events,
    usage: usage.events,
    turns: scanned.flatMap((item) => item.turns).sort(byWhere),
    toolResults: scanned.flatMap((item) => item.toolResults).sort(byWhere),
    unsupported: scanned.flatMap((item) => item.unsupported).sort(byWhere),
    duplicatesRemoved: { decisions: decisions.removed, usage: usage.removed },
  };
}

// ---------------------------------------------------------------------------
// Service logs
// ---------------------------------------------------------------------------

/**
 * One line of a service log. The text from the first `{` is parsed, so plain stderr, a journald prefix
 * (`journalctl -o short`) and `journalctl -o cat` all work.
 */
export function parseServiceLine(line: string): "blank" | "other" | "unsupported" | HttpServerRecordV1 {
  if (line.trim() === "") return "blank";
  const start = line.indexOf("{");
  if (start < 0) return "other";
  let value: unknown;
  try {
    value = JSON.parse(line.slice(start));
  } catch {
    return "other";
  }
  if (!isObject(value) || value.type !== HTTP_ENTRY) return "other";
  return normalizeHttp(value) ?? "unsupported";
}

/**
 * Read explicit service log files. Records that share a valid request id and are identical count once; ones that
 * differ are all kept (the summary reports the id as a conflict). A record without an id is never deduplicated.
 */
export function readServiceLogs(files: readonly string[]): ServiceRead {
  const paths = [...new Set(files.map(canonical))].sort();
  const read: ServiceRead = {
    files: paths.length,
    unreadable: 0,
    lines: { total: 0, records: 0, unsupported: 0, other: 0 },
    records: [],
    duplicates: 0,
  };
  const seen = new Map<string, Set<string>>();
  for (const file of paths) {
    const text = readRegularText(file);
    if (text === null) {
      read.unreadable++;
      continue;
    }
    for (const line of text.split("\n")) {
      const parsed = parseServiceLine(line);
      if (parsed === "blank") continue;
      read.lines.total++;
      if (parsed === "other" || parsed === "unsupported") {
        read.lines[parsed]++;
        continue;
      }
      read.lines.records++;
      if (parsed.requestId !== null) {
        const form = JSON.stringify(parsed);
        const variants = seen.get(parsed.requestId) ?? new Set<string>();
        if (variants.has(form)) {
          read.duplicates++;
          continue;
        }
        variants.add(form);
        seen.set(parsed.requestId, variants);
      }
      read.records.push(parsed);
    }
  }
  return read;
}

/**
 * Which session files a report reads, and which of their events it keeps.
 *
 * Scope is explicit: the current session (named files) or a history (a time window plus one project or all
 * projects). Selection prunes by file modification time and project before any file is parsed; filters then run
 * on the parsed events in a fixed order, and an event is counted once, under the first filter that removes it.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { DecisionOutcome } from "../telemetry.ts";
import { canonical, listSessionFiles, readHeader, type SessionRead, type TurnOutcome, type Where } from "./read.ts";

export type ScopeSpec =
  | { kind: "session"; files: string[] }
  | { kind: "historical"; since: number; until: number; projects: string[] | null; roots: string[] };

export interface Selection {
  files: string[];
  /** Unreadable directories met while listing. Unreadable files are found later, by the reader. */
  unreadable: number;
  skippedByMtime: number;
  childFilesNotRead: number;
}

export const DECISION_OUTCOMES: readonly DecisionOutcome[] = ["classified", "failed", "skipped"];
export const USAGE_OUTCOMES: readonly TurnOutcome[] = [
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "other",
  "unknown",
];

export interface FilterSpec {
  branch: "all" | "active" | "abandoned";
  /** Null leaves decisions unfiltered. */
  decision: DecisionOutcome[] | null;
  /** Null leaves model turns (usage records and transcript turns) unfiltered. */
  usage: TurnOutcome[] | null;
}

export const NO_FILTERS: FilterSpec = { branch: "all", decision: null, usage: null };

export interface Counters {
  outsideRange: number;
  unplaced: number;
  branch: number;
  outcome: number;
}
export type Removed = Record<"decisions" | "usage" | "transcript", Counters>;

export interface Filtered extends SessionRead {
  removed: Removed;
  /** True when a model-turn outcome filter is on: a tool result cannot be attributed to a turn outcome. */
  usageFiltered: boolean;
}

function realOrNull(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/** The nested child sessions of a named session file sit in `<file minus .jsonl>/`. */
function childDirOf(file: string): string | null {
  if (!file.endsWith(".jsonl")) return null;
  const dir = file.slice(0, -".jsonl".length);
  return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true ? dir : null;
}

/**
 * Session scope reads exactly the named files. Historical scope lists every root, drops files last modified
 * before `since` (a restore or copy tool that resets modification times can hide old files; the count keeps that
 * visible) and, for `--project`, keeps a file only when its header cwd is exactly a project path: equal after
 * `path.resolve`, or equal after `realpath` when both exist. A file without a header matches no project.
 */
export function selectFiles(scope: ScopeSpec): Selection {
  const selection: Selection = { files: [], unreadable: 0, skippedByMtime: 0, childFilesNotRead: 0 };
  const onUnreadable = (): void => {
    selection.unreadable++;
  };

  if (scope.kind === "session") {
    selection.files = [...new Set(scope.files.map(canonical))].sort();
    for (const file of selection.files) {
      const dir = childDirOf(file);
      if (dir !== null) selection.childFilesNotRead += listSessionFiles(dir, onUnreadable).length;
    }
    return selection;
  }

  const projects = scope.projects?.map((project) => ({ resolved: path.resolve(project), real: realOrNull(project) }));
  const matchesProject = (cwd: string): boolean => {
    const resolved = path.resolve(cwd);
    const real = realOrNull(cwd);
    return (projects ?? []).some(
      (project) => project.resolved === resolved || (project.real !== null && project.real === real),
    );
  };

  const seen = new Set<string>();
  for (const root of scope.roots) {
    for (const listed of listSessionFiles(root, onUnreadable)) {
      const file = canonical(listed);
      if (seen.has(file)) continue;
      seen.add(file);
      const mtime = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
      if (mtime !== undefined && mtime < scope.since) {
        selection.skippedByMtime++;
        continue;
      }
      if (projects !== undefined) {
        const cwd = readHeader(file)?.cwd;
        if (cwd === undefined || cwd === null || !matchesProject(cwd)) continue;
      }
      selection.files.push(file);
    }
  }
  selection.files.sort();
  return selection;
}

const noCounters = (): Counters => ({ outsideRange: 0, unplaced: 0, branch: 0, outcome: 0 });

/**
 * Time, then branch, then outcome. A historical scope keeps `since <= at < until` and removes an unplaced event;
 * a session scope has no window. An event removed by one filter is not counted by a later one.
 */
export function applyFilters(read: SessionRead, scope: ScopeSpec, filters: FilterSpec): Filtered {
  const removed: Removed = { decisions: noCounters(), usage: noCounters(), transcript: noCounters() };
  const window = scope.kind === "historical" ? scope : null;

  const keep = (where: Where, counters: Counters, outcomeOk: boolean): boolean => {
    if (window !== null) {
      if (where.at === null) {
        counters.unplaced++;
        return false;
      }
      if (where.at < window.since || where.at >= window.until) {
        counters.outsideRange++;
        return false;
      }
    }
    if (filters.branch !== "all" && where.branch !== filters.branch) {
      counters.branch++;
      return false;
    }
    if (!outcomeOk) {
      counters.outcome++;
      return false;
    }
    return true;
  };
  const pass = <T extends { where: Where }>(
    events: readonly T[],
    counters: Counters,
    accepts: (event: T) => boolean = () => true,
  ): T[] => events.filter((event) => keep(event.where, counters, accepts(event)));

  const decisionOutcomes: readonly string[] | null = filters.decision;
  const usageOutcomes: readonly string[] | null = filters.usage;
  return {
    ...read,
    decisions: pass(
      read.decisions,
      removed.decisions,
      (event) => decisionOutcomes === null || decisionOutcomes.includes(event.view.outcome),
    ),
    usage: pass(
      read.usage,
      removed.usage,
      (event) => usageOutcomes === null || usageOutcomes.includes(event.record.stopReason ?? "unknown"),
    ),
    turns: pass(
      read.turns,
      removed.transcript,
      (event) => usageOutcomes === null || usageOutcomes.includes(event.outcome),
    ),
    toolResults: pass(read.toolResults, removed.transcript),
    unsupported: read.unsupported.filter((event) =>
      keep(event.where, event.family === "decision" ? removed.decisions : removed.usage, true),
    ),
    removed,
    usageFiltered: filters.usage !== null,
  };
}

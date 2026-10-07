/**
 * Read omp/pi session transcripts (JSONL) into the numbers the benchmark and
 * decision report need. Malformed lines are skipped: a transcript being
 * written while we read it must not abort a report.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DECISION_ENTRY = "loadout.decision";

export interface Decision {
  tools: { active: string[] | null; profile: string | null; confidence: number; reason: string };
  skills: { selected: string[] | null; scores: Record<string, number>; reason: string };
  backend: string;
  dryRun: boolean;
  latencyMs: number;
  timestamp?: string;
  file?: string;
}

export interface UsageMetrics {
  requests: number;
  errors: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  toolCalls: Record<string, number>;
  toolErrors: number;
  decisions: Decision[];
}

export function defaultSessionsDir(): string {
  return path.join(os.homedir(), ".omp", "agent", "sessions");
}

export function listSessionFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(root);
  return files;
}

export function readEntries(file: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line);
      if (value !== null && typeof value === "object") entries.push(value);
    } catch {
      // A partially written last line is expected while a session is live.
    }
  }
  return entries;
}

/** The session's working directory, from its header entry. */
export function sessionCwd(file: string): string | null {
  const header = readEntries(file).find((entry) => entry.type === "session");
  return typeof header?.cwd === "string" ? header.cwd : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function emptyMetrics(): UsageMetrics {
  return {
    requests: 0,
    errors: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    toolCalls: {},
    toolErrors: 0,
    decisions: [],
  };
}

export function addFile(metrics: UsageMetrics, file: string): UsageMetrics {
  for (const entry of readEntries(file)) {
    if (entry.type === "custom" && entry.customType === DECISION_ENTRY) {
      metrics.decisions.push({ ...(entry.data as Decision), timestamp: entry.timestamp as string, file });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    if (message?.role === "toolResult") {
      if (message.isError === true) metrics.toolErrors++;
      continue;
    }
    if (message?.role !== "assistant") continue;

    metrics.requests++;
    if (message.stopReason === "error") metrics.errors++;
    const usage = (message.usage ?? {}) as Record<string, unknown>;
    metrics.input += num(usage.input);
    metrics.output += num(usage.output);
    metrics.cacheRead += num(usage.cacheRead);
    metrics.cacheWrite += num(usage.cacheWrite);
    metrics.cost += num((usage.cost as Record<string, unknown> | undefined)?.total);
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part?.type === "toolCall" && typeof part.name === "string") {
        metrics.toolCalls[part.name] = (metrics.toolCalls[part.name] ?? 0) + 1;
      }
    }
  }
  return metrics;
}

export function metricsFor(files: string[]): UsageMetrics {
  return files.reduce(addFile, emptyMetrics());
}

/** Share of prompt tokens served from cache, as omp stats computes it. */
export function cacheRate(metrics: Pick<UsageMetrics, "input" | "cacheRead">): number {
  const prompt = metrics.input + metrics.cacheRead;
  return prompt === 0 ? 0 : metrics.cacheRead / prompt;
}

export function totalToolCalls(metrics: Pick<UsageMetrics, "toolCalls">): number {
  return Object.values(metrics.toolCalls).reduce((sum, count) => sum + count, 0);
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

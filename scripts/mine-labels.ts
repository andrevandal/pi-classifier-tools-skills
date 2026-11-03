#!/usr/bin/env node
/**
 * Mines tool-profile labels from past sessions: each real user prompt is labeled by the tools the agent actually
 * called before the next user prompt. The label is what the agent used, not ground truth for what it needed:
 * `bash` for a read-only check counts as `full`, which errs toward keeping tools.
 *
 *   node scripts/mine-labels.ts --out <jsonl> [--sessions-dir <dir>]
 *
 * Output rows are `{ id, prompt, expect, tools, at }`, sorted by time so a caller can split train and test by date.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { defaultSessionsDir, listSessionFiles } from "../src/report/read.ts";

const { values } = parseArgs({
  options: { out: { type: "string" }, "sessions-dir": { type: "string" } },
  strict: true,
});
if (!values.out) {
  console.error("usage: node scripts/mine-labels.ts --out <jsonl> [--sessions-dir <dir>]");
  process.exit(2);
}

const MIN_CHARS = 20;
// Tools the `answer` profile allows (plus ones that never change what a turn needs).
const READ_ONLY: Record<string, true> = Object.fromEntries(
  ["read", "grep", "find", "ls", "glob", "lsp", "web_search", "todo", "ask", "recall", "yield"].map((tool) => [
    tool,
    true,
  ]),
);
const EDIT: Record<string, true> = { edit: true, write: true, ast_edit: true };
const MAX_CHARS = 3000;

const READ_ONLY_COMMANDS = new RegExp(
  `^(${["cat", "ls", "grep", "rg", "find", "head", "tail", "wc", "pwd", "echo", "which", "stat", "du", "df", "jq", "sort", "diff", "file", "tree", "ps", "date", "env", "printf", "cd", "test", "true"].join("|")})$`,
);
const READ_ONLY_GIT =
  /^git\s+(-C\s+\S+\s+)?(status|log|diff|show|branch|remote|rev-parse|ls-files|blame|describe|config\s+--get)\b/;

/** A shell command that only reads: every segment starts with a read-only program and nothing redirects, deletes or executes. */
function isReadOnlyShell(command: unknown): boolean {
  if (typeof command !== "string" || /[>]|\$\(|`|\b(-delete|-exec|xargs|tee)\b/.test(command)) return false;
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .every((segment) => READ_ONLY_COMMANDS.test(segment.split(/\s+/)[0]!) || READ_ONLY_GIT.test(segment));
}

interface Row {
  id: string;
  prompt: string;
  expect: "answer" | "edit" | "full";
  tools: string[];
  at: string;
  /** Label of the previous turn in this session, or null for the first. */
  prev: Row["expect"] | null;
  /** Label of everything the session did before this turn, or null for the first. */
  history: Row["expect"] | null;
}

function label(tools: Set<string>): Row["expect"] {
  if ([...tools].some((tool) => !READ_ONLY[tool] && tool !== "bash:ro" && !EDIT[tool])) return "full";
  return [...tools].some((tool) => EDIT[tool]) ? "edit" : "answer";
}

interface Entry {
  type?: string;
  timestamp?: string;
  message?: { role?: string; attribution?: string; content?: unknown };
}

function userText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  const parts = Array.isArray(content) ? (content as { type?: string; text?: string }[]) : [];
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

const rows: Row[] = [];
const seen = new Set<string>();
for (const file of listSessionFiles(values["sessions-dir"] ?? defaultSessionsDir())) {
  // Top-level sessions only: subagent files are not named by a leading timestamp.
  if (!/^\d{4}-\d\d-\d\dT/.test(path.basename(file))) continue;
  let current: { prompt: string; at: string; tools: Set<string> } | null = null;
  let prev: Row["expect"] | null = null;
  const before = new Set<string>();
  const flush = () => {
    if (current) {
      const history = before.size === 0 ? null : label(before);
      if (!seen.has(current.prompt)) {
        seen.add(current.prompt);
        rows.push({
          id: String(rows.length).padStart(5, "0"),
          prompt: current.prompt,
          expect: label(current.tools),
          tools: [...current.tools].sort(),
          at: current.at,
          prev,
          history,
        });
      }
      prev = label(current.tools);
      for (const tool of current.tools) before.add(tool);
    }
    current = null;
  };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line === "") continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    const message = entry.type === "message" ? entry.message : undefined;
    if (message?.role === "user" && message.attribution === "user") {
      flush();
      const prompt = userText(message.content);
      if (prompt.length >= MIN_CHARS && prompt.length <= MAX_CHARS && !prompt.startsWith("/")) {
        current = { prompt, at: entry.timestamp ?? "", tools: new Set() };
      }
    } else if (current && message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as { type?: string; name?: string; arguments?: { command?: unknown } }[]) {
        if (part.type !== "toolCall" || !part.name) continue;
        const readOnlyShell = part.name === "bash" && isReadOnlyShell(part.arguments?.command);
        current.tools.add(readOnlyShell ? "bash:ro" : part.name);
      }
    }
  }
  flush();
}

rows.sort((a, b) => a.at.localeCompare(b.at));
fs.writeFileSync(values.out, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
const counts: Record<string, number> = {};
for (const row of rows) counts[row.expect] = (counts[row.expect] ?? 0) + 1;
console.log(`${rows.length} labeled prompts -> ${values.out}`, counts);

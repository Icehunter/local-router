import { randomBytes } from "node:crypto";
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";

export interface UsageFileWritten {
  path: string;
  created: boolean;
  added: number;
  removed: number;
}

export interface UsageEntry {
  v: 1;
  ts: string;
  call_id: string;
  pid: number;
  cwd: string;
  client: string | null;
  tier: string | null;
  model: string;
  tool: "local_implement" | "local_direct";
  task: string | null;
  mode: "text" | "apply";
  outcome: "ok" | "applied" | "no_change" | "refused" | "rejected" | "error";
  root: string | null;
  files_read: string[];
  files_truncated: string[];
  files_skipped: string[];
  targets: string[];
  files_written: UsageFileWritten[];
  prompt_bytes: number;
  file_bytes: number;
  bytes_in: number;
  bytes_out: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  attempts: number;
  finish_reason: string | null;
  stray_lines: number;
  upstream_ms: number | null;
  duration_ms: number;
  reasons: string[];
}

export function newCallId(now: Date = new Date()): string {
  const year = String(now.getUTCFullYear()).padStart(4, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hours = String(now.getUTCHours()).padStart(2, "0");
  const minutes = String(now.getUTCMinutes()).padStart(2, "0");
  const seconds = String(now.getUTCSeconds()).padStart(2, "0");
  const hex = randomBytes(3).toString("hex").slice(0, 6);
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z-${hex}`;
}

let ledgerWarnedOnce = false;

/**
 * Writes one JSONL line to <stateDir>/usage.jsonl. Silent no-op when stateDir is
 * null (ledger disabled). Never throws: a write failure warns once to stderr and
 * is otherwise swallowed, because a broken log must never break a tool call.
 */
export function appendUsage(config: Config, entry: UsageEntry): void {
  if (config.stateDir === null) {
    return;
  }
  try {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    appendFileSync(join(config.stateDir, "usage.jsonl"), JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch (err) {
    if (!ledgerWarnedOnce) {
      ledgerWarnedOnce = true;
      process.stderr.write(`[local-router] usage ledger write failed (${config.stateDir}): ${(err as Error).message}\n`);
    }
  }
}

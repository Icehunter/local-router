import { realpathSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UsageEntry } from "./ledger.js";

export interface UsageRow {
  day: string;   // "YYYY-MM-DD", the UTC date portion of ts
  tier: string;  // entry.tier, or the literal string "(none)" when tier is null
  calls: number;
  ok: number;
  applied: number;
  no_change: number;
  refused: number;
  rejected: number;
  error: number;
}

export interface SummarizeResult {
  rows: UsageRow[];
  malformed: number;
}

const OUTCOMES = ["ok", "applied", "no_change", "refused", "rejected", "error"] as const;
type Outcome = (typeof OUTCOMES)[number];

function isOutcome(v: unknown): v is Outcome {
  return typeof v === "string" && (OUTCOMES as readonly string[]).includes(v);
}

export function summarizeUsage(lines: readonly string[]): SummarizeResult {
  const groups = new Map<string, UsageRow>();
  let malformed = 0;

  for (const line of lines) {
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      malformed++;
      continue;
    }

    const entry = parsed as Partial<UsageEntry>;
    if (typeof entry.ts !== "string") {
      malformed++;
      continue;
    }
    if (!isOutcome(entry.outcome)) {
      malformed++;
      continue;
    }

    const day = entry.ts.slice(0, 10);
    const tier = typeof entry.tier === "string" ? entry.tier : "(none)";
    const key = `${day}\u0000${tier}`;

    let row = groups.get(key);
    if (!row) {
      row = { day, tier, calls: 0, ok: 0, applied: 0, no_change: 0, refused: 0, rejected: 0, error: 0 };
      groups.set(key, row);
    }

    row.calls++;
    switch (entry.outcome) {
      case "ok": row.ok++; break;
      case "applied": row.applied++; break;
      case "no_change": row.no_change++; break;
      case "refused": row.refused++; break;
      case "rejected": row.rejected++; break;
      case "error": row.error++; break;
    }
  }

  const rows = Array.from(groups.values()).sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    if (a.tier !== b.tier) return a.tier < b.tier ? -1 : 1;
    return 0;
  });

  return { rows, malformed };
}

export function formatTable(result: SummarizeResult): string {
  if (result.rows.length === 0) {
    return "No usage recorded.";
  }

  const headers = ["day", "tier", "calls", "ok", "applied", "no_change", "refused", "rejected", "error"];
  const numericCols = new Set(["calls", "ok", "applied", "no_change", "refused", "rejected", "error"]);

  type Cell = string;
  const rows: Cell[][] = result.rows.map((r) => [
    r.day,
    r.tier,
    String(r.calls),
    String(r.ok),
    String(r.applied),
    String(r.no_change),
    String(r.refused),
    String(r.rejected),
    String(r.error),
  ]);

  const widths = headers.map((h, i) => {
    let w = h.length;
    for (const row of rows) {
      if (row[i].length > w) w = row[i].length;
    }
    return w + 2; // plus 2 spaces of padding
  });

  const padLeft = (s: string, width: number): string => s.padStart(width);
  const padRight = (s: string, width: number): string => s.padEnd(width);

  const headerLine = headers.map((h, i) => numericCols.has(h) ? padLeft(h, widths[i]) : padRight(h, widths[i])).join("");

  const lines: string[] = [headerLine];
  for (const row of rows) {
    lines.push(row.map((cell, i) => numericCols.has(headers[i]) ? padLeft(cell, widths[i]) : padRight(cell, widths[i])).join(""));
  }

  const totalCalls = result.rows.reduce((n, r) => n + r.calls, 0);
  lines.push("");
  lines.push(`${totalCalls} total call(s) across ${result.rows.length} day/tier group(s)`);
  if (result.malformed > 0) {
    lines.push(`${result.malformed} malformed line(s) skipped`);
  }

  return lines.join("\n");
}

export function defaultLogPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "logs", "usage.jsonl");
}

function isDirectRun(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  let entry: string | null = null;
  try {
    entry = realpathSync(argv1);
  } catch {
    // fall through to the .js-appended fallback below
  }

  const metaPath = fileURLToPath(import.meta.url);
  if (entry !== null) {
    let self: string | null = null;
    try {
      self = realpathSync(metaPath);
    } catch {
      // ignore
    }
    if (self !== null && entry === self) return true;
  }

  // Fallback for a bin shim that omits the extension.
  const withJs = argv1.endsWith(".js") ? argv1 : `${argv1}.js`;
  try {
    const entryWithJs = realpathSync(withJs);
    let self: string | null = null;
    try {
      self = realpathSync(metaPath);
    } catch {
      // ignore
    }
    if (self !== null && entryWithJs === self) return true;
  } catch {
    // ignore
  }

  return false;
}

async function main(): Promise<void> {
  let path = defaultLogPath();
  let fileFlagGiven = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--file") {
      path = argv[i + 1];
      fileFlagGiven = true;
      break;
    }
  }

  if (!fileFlagGiven) {
    const stateDir = process.env.LOCAL_LLM_STATE_DIR;
    if (stateDir && stateDir.length > 0) {
      path = join(stateDir, "usage.jsonl");
    }
  }

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    process.stdout.write(`No usage log at ${path}.\n`);
    return;
  }

  const lines = content.split(/\r?\n/);
  const result = summarizeUsage(lines);
  process.stdout.write(`${formatTable(result)}\n`);
}

if (isDirectRun()) {
  main().catch((err) => {
    process.stderr.write(`[local-router] usage: ${(err as Error).message}\n`);
    process.exit(1);
  });
}

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { estimateTokens } from "./tokens.js";

/**
 * Returns true when `real` IS `base`, or is a path lexically under it. Both arguments
 * must already be realpath-resolved by the caller; this function does no I/O
 * and no normalization of its own.
 */
export function isInside(real: string, base: string): boolean {
  return real === base || real.startsWith(base + sep);
}

/** Guards against reading one huge file into memory in a single call. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Lines kept from each end of a file when it has to be shrunk to fit budget. */
const INITIAL_KEEP_LINES = 40;
const MIN_KEEP_LINES = 5;

export interface FileReadResult {
  /** Assembled `--- file: path ---` blocks for every included/truncated file, in order. */
  text: string;
  included: string[];
  truncated: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Resolves `root` and verifies it (after symlink resolution) sits inside one
 * of `allowedRoots` (also symlink-resolved, so a root declared as a symlink
 * cannot be used to point outside itself). Throws with a caller-actionable
 * message on every rejection path rather than returning a boolean, matching
 * the rest of this codebase's validation style.
 */
export function resolveAllowedRoot(root: unknown, allowedRoots: readonly string[] | null): string {
  if (allowedRoots === null) {
    throw new Error(
      "`root`/`files` are not enabled on this instance. Set LOCAL_LLM_ALLOWED_ROOTS to enable " +
        "server-side file reads, or inline content into `prompt` instead.",
    );
  }
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error("`root` is required and must be a non-empty string when `files` is provided");
  }
  if (!isAbsolute(root)) {
    throw new Error(`\`root\` must be an absolute path; got: ${JSON.stringify(root)}`);
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (err) {
    throw new Error(`\`root\` does not exist or is not readable: ${root} (${(err as Error).message})`);
  }
  const isContained = allowedRoots.some((allowedRoot) => {
    let realAllowed: string;
    try {
      realAllowed = realpathSync(allowedRoot);
    } catch {
      return false;
    }
    return realRoot === realAllowed || realRoot.startsWith(realAllowed + sep);
  });
  if (!isContained) {
    throw new Error(
      `\`root\` (${root}) is outside the configured allowedRoots (${allowedRoots.join(", ")}).`,
    );
  }
  return realRoot;
}

function formatFileBlock(relPath: string, content: string): string {
  return `--- file: ${relPath} ---\n${content}\n`;
}

/** Keeps the first and last `keepLines` lines, dropping the middle. */
function truncateMiddle(content: string, keepLines: number): { text: string; omitted: number } {
  const lines = content.split("\n");
  if (lines.length <= keepLines * 2) return { text: content, omitted: 0 };
  const head = lines.slice(0, keepLines);
  const tail = lines.slice(lines.length - keepLines);
  const omitted = lines.length - keepLines * 2;
  return {
    text: `${head.join("\n")}\n[... ${omitted} lines omitted ...]\n${tail.join("\n")}`,
    omitted,
  };
}

/**
 * Reads `files` relative to `realRoot` (already validated by
 * resolveAllowedRoot), rejecting any entry that escapes the root after
 * symlink resolution. Assembles them in the order given; when a file would
 * overflow `budgetTokens` it is truncated head/tail to fit rather than
 * failing the whole call, and anything after the budget runs out is skipped
 * with a reason — a caller who asked for five files usually still wants the
 * first four whole rather than an error naming none of them.
 */
export function readRequestedFiles(
  realRoot: string,
  files: readonly unknown[],
  budgetTokens: number,
): FileReadResult {
  const included: string[] = [];
  const truncated: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const blocks: string[] = [];
  let remaining = budgetTokens;

  for (const raw of files) {
    if (typeof raw !== "string" || raw.trim() === "") {
      skipped.push({ path: JSON.stringify(raw), reason: "not a non-empty string" });
      continue;
    }
    const rel = raw;
    const resolved = resolve(realRoot, rel);
    let real: string;
    try {
      real = realpathSync(resolved);
    } catch (err) {
      skipped.push({ path: rel, reason: `not found: ${(err as Error).message}` });
      continue;
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      skipped.push({ path: rel, reason: "escapes root" });
      continue;
    }
    let stat;
    try {
      stat = statSync(real);
    } catch (err) {
      skipped.push({ path: rel, reason: `stat failed: ${(err as Error).message}` });
      continue;
    }
    if (!stat.isFile()) {
      skipped.push({ path: rel, reason: "not a regular file" });
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      skipped.push({ path: rel, reason: `too large (${stat.size} bytes, cap ${MAX_FILE_BYTES})` });
      continue;
    }
    if (remaining <= 0) {
      skipped.push({ path: rel, reason: "token budget exhausted" });
      continue;
    }
    let content: string;
    try {
      content = readFileSync(real, "utf8");
    } catch (err) {
      skipped.push({ path: rel, reason: `read failed: ${(err as Error).message}` });
      continue;
    }
    const relDisplay = relative(realRoot, real) || rel;
    let block = formatFileBlock(relDisplay, content);
    let cost = estimateTokens(block);
    if (cost > remaining) {
      let keepLines = INITIAL_KEEP_LINES;
      let fitted = false;
      while (keepLines >= MIN_KEEP_LINES) {
        const { text, omitted } = truncateMiddle(content, keepLines);
        if (omitted === 0) break; // file has too few lines to shrink further this way
        const candidate = formatFileBlock(relDisplay, text);
        const candidateCost = estimateTokens(candidate);
        if (candidateCost <= remaining) {
          block = candidate;
          cost = candidateCost;
          truncated.push(relDisplay);
          fitted = true;
          break;
        }
        keepLines = Math.floor(keepLines / 2);
      }
      if (!fitted) {
        skipped.push({ path: rel, reason: "does not fit in remaining token budget even truncated" });
        continue;
      }
    }
    blocks.push(block);
    included.push(relDisplay);
    remaining -= cost;
  }

  return { text: blocks.join("\n"), included, truncated, skipped };
}

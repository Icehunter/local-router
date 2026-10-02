import { existsSync, lstatSync, readFileSync, realpathSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, rmdirSync, chmodSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { isInside } from "./fileaccess.js";
import { createTwoFilesPatch, structuredPatch } from "diff";

export interface PreparedTarget {
  rel: string;
  abs: string;
  exists: boolean;
  /** Original file content. Empty string when exists is false. */
  text: string;
  eol: "\n" | "\r\n";
  /** File mode bits (st.mode & 0o7777) for an existing file; 0o644 for a new one. */
  mode: number;
}

export interface Change {
  rel: string;
  before: string;
  after: string;
  created: boolean;
}

export interface WrittenFile {
  rel: string;
  created: boolean;
  added: number;
  removed: number;
}

export interface CommitResult {
  ok: boolean;
  files: WrittenFile[];
  /** Present only when ok is false: one entry per file naming its final state. */
  errors?: string[];
}

export function isInsideScope(real: string, roots: readonly string[]): boolean {
  return roots.some((r) => isInside(real, r));
}

function findNearestExisting(startDir: string): string | null {
  let p = startDir;
  while (true) {
    if (existsSync(p)) {
      return p;
    }
    const parent = dirname(p);
    if (parent === p) {
      // hit filesystem root without finding anything that exists
      return null;
    }
    p = parent;
  }
}

export function prepareTargets(
  realRoot: string,
  rels: readonly string[],
  writeRoots: readonly string[],
): PreparedTarget[] {
  const results: PreparedTarget[] = [];
  for (const rel of rels) {
    // 1. Validate relative path
    if (rel.length === 0 || rel.trim().length === 0 || rel.startsWith("/") || rel.includes("\\") || rel.split("/").includes("..")) {
      throw new Error(`${rel}: not a valid relative path`);
    }

    const components = rel.split("/");
    const lowerComponents = components.map((c) => c.toLowerCase());
    if (lowerComponents.some((c) => c === ".git" || c === ".claude" || c === "node_modules")) {
      throw new Error(`${rel}: matches denylist`);
    }
    const lastComponentLower = lowerComponents[lowerComponents.length - 1];
    if (lastComponentLower === "claude.md" || lastComponentLower === "agents.md" || lastComponentLower === "memory.md" || lastComponentLower === ".mcp.json") {
      throw new Error(`${rel}: matches denylist`);
    }

    // 2. Compute absolute path
    const abs = resolve(realRoot, rel);

    // 3. Check existence via lstatSync
    let st;
    try {
      st = lstatSync(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        st = null;
      } else {
        throw new Error(`${rel}: could not stat (${(err as Error).message})`);
      }
    }

    if (st !== null) {
      if (st.isSymbolicLink()) {
        throw new Error(`${rel}: is a symlink, not a plain file`);
      }
      if (!st.isFile()) {
        throw new Error(`${rel}: is not a regular file`);
      }
      if (st.size > 2 * 1024 * 1024) {
        throw new Error(`${rel}: too large (over 2MB)`);
      }

      const real = realpathSync(abs);
      const realWriteRoots = writeRoots.map((w) => realpathSync(w));
      if (!isInsideScope(real, [realRoot]) || !isInsideScope(real, realWriteRoots)) {
        throw new Error(`${rel}: escapes the allowed write scope`);
      }

      const buf = readFileSync(abs);
      if (buf.includes(0)) {
        throw new Error(`${rel}: contains a NUL byte`);
      }

      const text = buf.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(buf)) {
        throw new Error(`${rel}: is not valid UTF-8`);
      }

      let hasNewline = false;
      let allCrlf = true;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") {
          hasNewline = true;
          if (i === 0 || text[i - 1] !== "\r") {
            allCrlf = false;
            break;
          }
        }
      }
      const eol: "\n" | "\r\n" = hasNewline && allCrlf ? "\r\n" : "\n";

      const mode = st.mode & 0o7777;
      results.push({ rel, abs, exists: true, text, eol, mode });
    } else {
      const nearestExisting = findNearestExisting(dirname(abs));
      if (nearestExisting === null) {
        throw new Error(`${rel}: no existing ancestor directory found`);
      }

      const parentSt = lstatSync(nearestExisting);
      if (!parentSt.isDirectory()) {
        throw new Error(`${rel}: parent path is not a directory`);
      }

      const realParent = realpathSync(nearestExisting);
      const realWriteRoots = writeRoots.map((w) => realpathSync(w));
      if (!isInsideScope(realParent, [realRoot]) || !isInsideScope(realParent, realWriteRoots)) {
        throw new Error(`${rel}: escapes the allowed write scope`);
      }

      results.push({ rel, abs, exists: false, text: "", eol: "\n", mode: 0o644 });
    }
  }
  return results;
}

export function commitChanges(changes: readonly Change[], prepared: readonly PreparedTarget[], realRoot: string, writeRoots: readonly string[]): CommitResult {
  const preparedMap = new Map<string, PreparedTarget>();
  for (const p of prepared) {
    preparedMap.set(p.rel, p);
  }

  const errors: string[] = [];
  let failed = false;

  for (const change of changes) {
    const prep = preparedMap.get(change.rel);
    if (!prep) {
      throw new Error(`${change.rel}: no prepared target found (programmer error)`);
    }

    // Re-verify scope at commit time to prevent TOCTOU symlink swaps
    let dirToCheck: string | null = null;
    try {
      const stNow = lstatSync(prep.abs);
      if (!change.created && stNow.isSymbolicLink()) {
        errors.push(`${change.rel}: is now a symlink`);
        failed = true;
        continue;
      }
      
      if (change.created) {
        dirToCheck = findNearestExisting(dirname(prep.abs));
      } else {
        dirToCheck = dirname(prep.abs);
      }
    } catch (err) {
      // If lstatSync fails with ENOENT for a non-created file, the existing logic below will handle it as "changed on disk"
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        dirToCheck = change.created ? findNearestExisting(dirname(prep.abs)) : dirname(prep.abs);
      } else {
        throw err;
      }
    }

    if (dirToCheck !== null) {
      try {
        const realDir = realpathSync(dirToCheck);
        const realWriteRoots = writeRoots.map((w) => realpathSync(w));
        if (!isInsideScope(realDir, [realRoot]) || !isInsideScope(realDir, realWriteRoots)) {
          errors.push(`${change.rel}: escapes the allowed write scope`);
          failed = true;
          continue;
        }
      } catch (err) {
        // If realpathSync fails, it's likely because the directory doesn't exist or is inaccessible.
        // For created files, findNearestExisting should have found an existing dir. 
        // If it still fails, we can't verify scope, so fail safely.
        errors.push(`${change.rel}: escapes the allowed write scope`);
        failed = true;
        continue;
      }
    }

    if (change.created) {
      let existsNow = false;
      try {
        lstatSync(prep.abs);
        existsNow = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
      if (existsNow) {
        errors.push(`${change.rel}: now exists on disk (created since it was read)`);
        failed = true;
      }
    } else {
      let currentBuf: Buffer;
      try {
        currentBuf = readFileSync(prep.abs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          errors.push(`${change.rel}: changed on disk while the model was working`);
          failed = true;
          continue;
        }
        throw err;
      }
      const originalBuf = Buffer.from(prep.text, "utf8");
      if (!currentBuf.equals(originalBuf)) {
        errors.push(`${change.rel}: changed on disk while the model was working`);
        failed = true;
      }
    }
  }

  if (failed) {
    return { ok: false, files: [], errors };
  }

  const written: WrittenFile[] = [];
  const renamedSoFar: Array<{ rel: string; prepared: PreparedTarget }> = [];
  const createdDirsMap = new Map<string, string[]>();

  for (const change of changes) {
    const prep = preparedMap.get(change.rel)!;
    let tmpPath: string | null = null;

    try {
      const createdDirs = ensureDirCreated(dirname(prep.abs));
      
      const targetDir = dirname(prep.abs);
      const baseName = basename(prep.abs);
      const tmpName = `.${baseName}.lr-${randomBytes(4).toString("hex")}.tmp`;
      tmpPath = join(targetDir, tmpName);

      const fd = openSync(tmpPath, "wx", prep.mode);
      writeSync(fd, Buffer.from(change.after, "utf8"));
      fsyncSync(fd);
      closeSync(fd);
      chmodSync(tmpPath, prep.mode);
      renameSync(tmpPath, prep.abs);

      const patch = structuredPatch(change.rel, change.rel, change.before, change.after, "", "", { context: 0 });
      let added = 0;
      let removed = 0;
      for (const hunk of patch.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith("+")) {
            added++;
          } else if (line.startsWith("-")) {
            removed++;
          }
        }
      }

      written.push({ rel: change.rel, created: change.created, added, removed });
      renamedSoFar.push({ rel: change.rel, prepared: prep });
      createdDirsMap.set(change.rel, createdDirs);
    } catch (err) {
      const message = (err as Error).message;

      if (tmpPath !== null) { try { unlinkSync(tmpPath); } catch { /* best effort */ } }

      const rollbackErrors: string[] = [];
      for (let i = renamedSoFar.length - 1; i >= 0; i--) {
        const entry = renamedSoFar[i];
        try {
          if (!entry.prepared.exists) {
            unlinkSync(entry.prepared.abs);
            const dirsToRmdir = createdDirsMap.get(entry.rel) || [];
            for (let j = dirsToRmdir.length - 1; j >= 0; j--) {
              try {
                rmdirSync(dirsToRmdir[j]);
              } catch {
                // ignore
              }
            }
          } else {
            writeTempAndRename(entry.prepared.abs, entry.prepared.text, entry.prepared.mode);
          }
        } catch (rbErr) {
          rollbackErrors.push(`${entry.rel}: now holds the model's version (rollback failed: ${(rbErr as Error).message})`);
        }
      }

      const finalErrors: string[] = [];
      for (let i = 0; i < renamedSoFar.length; i++) {
        const entry = renamedSoFar[i];
        const rbFail = rollbackErrors.find((e) => e.startsWith(`${entry.rel}:`));
        if (rbFail) {
          finalErrors.push(rbFail);
        } else {
          finalErrors.push(`${entry.rel}: rolled back`);
        }
      }
      finalErrors.push(`${change.rel}: ${message}`);

      return { ok: false, files: [], errors: finalErrors };
    }
  }

  return { ok: true, files: written };
}

function ensureDirCreated(dir: string): string[] {
  const created: string[] = [];
  const missing: string[] = [];
  let current = dir;
  while (!existsSync(current)) {
    missing.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const d of missing) {
    mkdirSync(d, { mode: 0o755 });
    created.push(d);
  }
  return created;
}

function writeTempAndRename(targetAbs: string, content: string, mode: number): void {
  const targetDir = dirname(targetAbs);
  const baseName = basename(targetAbs);
  const tmpName = `.${baseName}.lr-${randomBytes(4).toString("hex")}.tmp`;
  const tmpPath = join(targetDir, tmpName);

  const fd = openSync(tmpPath, "wx", mode);
  try {
    writeSync(fd, Buffer.from(content, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmpPath, mode);
  renameSync(tmpPath, targetAbs);
}

export function buildDiff(changes: readonly Change[]): { diff: string; added: number; removed: number } {
  let totalAdded = 0;
  let totalRemoved = 0;
  const parts: string[] = [];

  for (const change of changes) {
    const patchText = createTwoFilesPatch(
      change.created ? "/dev/null" : `a/${change.rel}`,
      `b/${change.rel}`,
      change.before,
      change.after,
      "",
      "",
      { context: 3 },
    );

    const lines = patchText.split("\n");
    const startIdx = lines.length > 0 && /^=+$/.test(lines[0]) ? 1 : 0;
    const stripped = lines.slice(startIdx).join("\n");
    parts.push(stripped);

    const sp = structuredPatch(change.rel, change.rel, change.before, change.after, "", "", { context: 3 });
    for (const hunk of sp.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) {
          totalAdded++;
        } else if (line.startsWith("-")) {
          totalRemoved++;
        }
      }
    }
  }

  const diff = parts.join("");

  if (diff.length > 200_000) {
    return {
      diff: `Diff too large to show (${totalAdded} added, ${totalRemoved} removed across ${changes.length} file(s)). Run: git diff -- ${changes.map((c) => c.rel).join(" ")}`,
      added: totalAdded,
      removed: totalRemoved,
    };
  }

  return { diff, added: totalAdded, removed: totalRemoved };
}

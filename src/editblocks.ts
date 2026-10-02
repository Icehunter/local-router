// src/editblocks.ts

export interface EditPair {
  search: string[];
  replace: string[];
}

export interface EditSection {
  kind: "edit";
  path: string;
  pairs: EditPair[];
}

export interface FileSection {
  kind: "file";
  path: string;
  content: string;
}

export type ParsedSection = EditSection | FileSection;

export interface ParseResult {
  sections: ParsedSection[];
  need: string | null;
  errors: string[];
  strayLines: number;
}

const RE_EDIT_HEADER = /^\s*===\s*EDIT:\s*(.*?)\s*===\s*$/;
const RE_FILE_HEADER = /^\s*===\s*FILE:\s*(.*?)\s*===\s*$/;
const RE_END_EDIT = /^\s*===\s*END\s+EDIT\s*===\s*$/;
const RE_END_FILE = /^\s*===\s*END\s+FILE\s*===\s*$/;
const RE_SEARCH_MARKER = /^<{7}\s*SEARCH\s*$/;
const RE_DIVIDER = /^={7}\s*$/;
const RE_REPLACE_MARKER = /^>{7}\s*REPLACE\s*$/;
const RE_FENCE_OPEN = /^```([a-zA-Z0-9_-]*)$/;

function cleanPath(raw: string): string {
  let s = raw.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === "`" && last === "`") || (first === '"' && last === '"')) {
      s = s.slice(1, s.length - 1);
    }
  }
  if (s.startsWith("./")) {
    s = s.slice(2);
  }
  return s.replace(/\\/g, "/");
}

function stripFences(content: string, path: string): string {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".md")) {
    return content;
  }

  let trimmed = content;
  while (trimmed.startsWith("\n")) {
    trimmed = trimmed.slice(1);
  }
  while (trimmed.endsWith("\n")) {
    trimmed = trimmed.slice(0, trimmed.length - 1);
  }

  if (trimmed === "") {
    return content;
  }

  const lines = trimmed.split("\n");
  if (lines.length < 2) {
    return content;
  }

  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];

  const fenceMatch = firstLine.match(RE_FENCE_OPEN);
  if (fenceMatch !== null && lastLine === "```") {
    const inner = lines.slice(1, lines.length - 1);
    return inner.join("\n");
  }

  return content;
}

export function parseEditReply(reply: string): ParseResult {
  const trimmedReply = reply.trim();

  if (trimmedReply.startsWith("NEED:")) {
    const nonBlankLines = trimmedReply.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (nonBlankLines.length === 1 && nonBlankLines[0].startsWith("NEED:")) {
      return {
        sections: [],
        need: nonBlankLines[0].slice(5).trim(),
        errors: [],
        strayLines: 0,
      };
    }
  }

  const lines = reply.split(/\r?\n/);
  const sections: ParsedSection[] = [];
  const errors: string[] = [];
  let strayLines = 0;

  type EditSubState = "between" | "search" | "replace";

  let currentEdit: EditSection | null = null;
  let editSubState: EditSubState = "between";
  let searchBuffer: string[] = [];
  let replaceBuffer: string[] = [];

  let currentFile: FileSection | null = null;
  let fileContentBuffer: string[] = [];

  function closeEdit(): void {
    if (currentEdit === null) return;
    const path = currentEdit.path;
    if (editSubState === "search" || editSubState === "replace") {
      errors.push(`EDIT section for ${path} is cut off or malformed`);
    } else if (currentEdit.pairs.length === 0) {
      errors.push(`EDIT section for ${path} has no search/replace pairs`);
    }
    currentEdit = null;
    editSubState = "between";
    searchBuffer = [];
    replaceBuffer = [];
  }

  function closeFile(): void {
    if (currentFile === null) return;
    const rawContent = fileContentBuffer.join("\n");
    currentFile.content = stripFences(rawContent, currentFile.path);
    currentFile = null;
    fileContentBuffer = [];
  }

  function closeAll(): void {
    if (currentEdit !== null) {
      closeEdit();
    }
    if (currentFile !== null) {
      closeFile();
    }
  }

  for (const line of lines) {
    const editHeaderMatch = line.match(RE_EDIT_HEADER);
    const fileHeaderMatch = line.match(RE_FILE_HEADER);
    const endEditMatch = line.match(RE_END_EDIT);
    const endFileMatch = line.match(RE_END_FILE);
    const searchMarkerMatch = line.match(RE_SEARCH_MARKER);
    const dividerMatch = line.match(RE_DIVIDER);
    const replaceMarkerMatch = line.match(RE_REPLACE_MARKER);
    const fenceOpenMatch = line.match(RE_FENCE_OPEN);

    if (editHeaderMatch !== null) {
      closeAll();
      const path = cleanPath(editHeaderMatch[1]);
      let existing: EditSection | undefined;
      for (const s of sections) {
        if (s.kind === "edit" && s.path === path) {
          existing = s;
          break;
        }
      }
      if (existing !== undefined) {
        currentEdit = existing;
      } else {
        const newSection: EditSection = { kind: "edit", path, pairs: [] };
        sections.push(newSection);
        currentEdit = newSection;
      }
      editSubState = "between";
      searchBuffer = [];
      replaceBuffer = [];
    } else if (fileHeaderMatch !== null) {
      closeAll();
      const path = cleanPath(fileHeaderMatch[1]);
      const newFile: FileSection = { kind: "file", path, content: "" };
      sections.push(newFile);
      currentFile = newFile;
      fileContentBuffer = [];
    } else if (endEditMatch !== null) {
      closeAll();
    } else if (endFileMatch !== null) {
      closeAll();
    } else if (currentEdit !== null) {
      if (editSubState === "between") {
        if (searchMarkerMatch !== null) {
          editSubState = "search";
          searchBuffer = [];
        } else if (dividerMatch !== null || replaceMarkerMatch !== null) {
          errors.push(`marker outside an EDIT section: ${line}`);
        } else if (line.trim() === "" || fenceOpenMatch !== null) {
          // silently ignored
        } else {
          strayLines++;
        }
      } else if (editSubState === "search") {
        if (dividerMatch !== null) {
          editSubState = "replace";
          replaceBuffer = [];
        } else {
          searchBuffer.push(line);
        }
      } else {
        // editSubState === "replace"
        if (replaceMarkerMatch !== null) {
          currentEdit.pairs.push({
            search: [...searchBuffer],
            replace: [...replaceBuffer],
          });
          editSubState = "between";
          searchBuffer = [];
          replaceBuffer = [];
        } else {
          replaceBuffer.push(line);
        }
      }
    } else if (currentFile !== null) {
      fileContentBuffer.push(line);
    } else {
      // outside any section
      if (searchMarkerMatch !== null || dividerMatch !== null || replaceMarkerMatch !== null) {
        errors.push(`marker outside an EDIT section: ${line}`);
      } else if (line.trim() === "" || fenceOpenMatch !== null) {
        // silently ignored
      } else {
        strayLines++;
      }
    }
  }

  closeAll();

  return { sections, need: null, errors, strayLines };
}

export interface PreparedTargetInput {
  rel: string;
  exists: boolean;
  /** Original file content. Empty string when exists is false. */
  text: string;
  eol: "\n" | "\r\n";
}

export interface PlannedChange {
  rel: string;
  before: string;
  after: string;
  created: boolean;
}

export interface PlanResult {
  changes: PlannedChange[];
  errors: string[];
}

interface Span {
  start: number;
  end: number;
  replace: string[];
}

function deepEqualArrays(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function planEdits(
  parsed: ParseResult,
  prepared: readonly PreparedTargetInput[]
): PlanResult {
  const lookup = new Map<string, PreparedTargetInput>();
  for (const p of prepared) {
    if (!lookup.has(p.rel)) {
      lookup.set(p.rel, p);
    }
  }

  const changes: PlannedChange[] = [];
  const errors: string[] = [];
  const resolvedRels = new Set<string>();
  const fileBlockPaths = new Set<string>();

  for (const section of parsed.sections) {
    if (!lookup.has(section.path)) {
      const allowed = prepared.map((p) => p.rel).join(", ");
      errors.push(
        `path ${section.path} is not in the prepared targets; allowed: ${allowed}`
      );
      continue;
    }

    const target = lookup.get(section.path)!;

    if (section.kind === "file") {
      if (target.exists) {
        errors.push(
          `${section.path} has a FILE block but already exists; use EDIT blocks instead`
        );
        continue;
      }
      if (fileBlockPaths.has(section.path)) {
        errors.push(`multiple FILE blocks for the same new file: ${section.path}`);
        continue;
      }

      let content = section.content;
      if (!content.endsWith("\n")) {
        content += "\n";
      }
      fileBlockPaths.add(section.path);

      if (!resolvedRels.has(target.rel)) {
        changes.push({
          rel: section.path,
          before: "",
          after: content,
          created: true,
        });
        resolvedRels.add(target.rel);
      }
    } else {
      // section.kind === "edit"
      if (!target.exists && !fileBlockPaths.has(section.path)) {
        errors.push(
          `${section.path} is new but only has EDIT blocks; provide one FILE block with the complete content`
        );
        continue;
      }
      if (!target.exists) {
        errors.push(
          `${section.path} is new and has both a FILE block and EDIT blocks; use only one`
        );
        continue;
      }

      // target exists
      const lines = target.text.split(/\r?\n/);
      let pathErrored = false;
      const spans: Span[] = [];

      for (let i = 0; i < section.pairs.length; i++) {
        const pair = section.pairs[i];
        const editNum = i + 1;

        if (pair.search.length === 0) {
          errors.push(`SEARCH is empty (edit ${editNum})`);
          pathErrored = true;
          continue;
        }

        const matches: number[] = [];
        for (let k = 0; k + pair.search.length <= lines.length; k++) {
          let allMatch = true;
          for (let j = 0; j < pair.search.length; j++) {
            if (lines[k + j] !== pair.search[j]) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            matches.push(k);
          }
        }

        if (matches.length === 0) {
          errors.push(`SEARCH matched 0 times (edit ${editNum})`);
          pathErrored = true;
        } else if (matches.length > 1) {
          errors.push(
            `SEARCH matched ${matches.length} times, expected exactly 1 (edit ${editNum})`
          );
          pathErrored = true;
        } else {
          const k = matches[0];
          spans.push({ start: k, end: k + pair.search.length, replace: pair.replace });
        }
      }

      // Check for overlapping spans
      if (!pathErrored) {
        for (let a = 0; a < spans.length; a++) {
          for (let b = a + 1; b < spans.length; b++) {
            const sa = spans[a];
            const sb = spans[b];
            if (sa.start < sb.end && sb.start < sa.end) {
              errors.push("edits overlap");
              pathErrored = true;
              break;
            }
          }
          if (pathErrored) break;
        }
      }

      if (!pathErrored) {
        // Sort spans by descending start index
        const sortedSpans = [...spans].sort((a, b) => b.start - a.start);
        for (const span of sortedSpans) {
          lines.splice(span.start, span.end - span.start, ...span.replace);
        }

        const newText = lines.join(target.eol);
        if (newText !== target.text && !resolvedRels.has(target.rel)) {
          changes.push({
            rel: section.path,
            before: target.text,
            after: newText,
            created: false,
          });
          resolvedRels.add(target.rel);
        }
      }
    }
  }

  return { changes, errors };
}

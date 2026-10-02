import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
  linkSync,
  chmodSync,
  statSync,
  realpathSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareTargets, commitChanges, buildDiff } from "../src/apply.js";

describe("prepareTargets", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "local-router-apply-")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns an existing file with its text and eol", () => {
    writeFileSync(join(root, "a.txt"), "line1\nline2\n");
    const prepared = prepareTargets(root, ["a.txt"], [root]);
    expect(prepared).toHaveLength(1);
    const entry = prepared[0];
    expect(entry.exists).toBe(true);
    expect(entry.text).toBe("line1\nline2\n");
    expect(entry.eol).toBe("\n");
    expect(typeof entry.mode).toBe("number");
    expect((entry.mode & 0o777) > 0).toBe(true);
  });

  it("returns a non-existent file with an existing parent dir", () => {
    const prepared = prepareTargets(root, ["new.txt"], [root]);
    expect(prepared).toHaveLength(1);
    const entry = prepared[0];
    expect(entry.exists).toBe(false);
    expect(entry.text).toBe("");
    expect(entry.eol).toBe("\n");
    expect(entry.mode).toBe(0o644);
  });

  it("does not throw for a non-existent file in a not-yet-created subdirectory", () => {
    const prepared = prepareTargets(root, ["sub/dir/new.txt"], [root]);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].exists).toBe(false);
  });

  it("rejects an absolute rel path", () => {
    expect(() => prepareTargets(root, ["/etc/passwd"], [root])).toThrow();
  });

  it("rejects a .. traversal segment", () => {
    expect(() => prepareTargets(root, ["../escape.txt"], [root])).toThrow();
    expect(() => prepareTargets(root, ["sub/../../escape.txt"], [root])).toThrow();
  });

  it("rejects a target that is itself a symlink (even inside root)", () => {
    writeFileSync(join(root, "real.txt"), "x");
    symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
    expect(() => prepareTargets(root, ["link.txt"], [root])).toThrow(/symlink/i);
  });

  it("rejects a target reached through a symlinked directory pointing outside root", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "local-router-apply-outside-")));
    try {
      writeFileSync(join(outside, "f.txt"), "x");
      symlinkSync(outside, join(root, "esc"));
      expect(() => prepareTargets(root, ["esc/f.txt"], [root])).toThrow(/escapes/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a NEW (non-existent) target reached through a symlinked directory pointing outside root", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "local-router-apply-outside-")));
    try {
      mkdirSync(join(outside, "sub"));
      symlinkSync(outside, join(root, "esc2"));
      expect(() => prepareTargets(root, ["esc2/sub/does-not-exist.txt"], [root])).toThrow(/escapes/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a target outside the given writeRoots scope", () => {
    const writeSubDir = join(root, "writable");
    mkdirSync(writeSubDir);
    writeFileSync(join(root, "outside-write-scope.txt"), "x");
    expect(() => prepareTargets(root, ["outside-write-scope.txt"], [writeSubDir])).toThrow(
      /escapes|write scope/i
    );
  });

  it("rejects a file over 2MB", () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(3 * 1024 * 1024));
    expect(() => prepareTargets(root, ["big.txt"], [root])).toThrow(/large|2MB/i);
  });

  it("rejects a file containing a NUL byte", () => {
    writeFileSync(join(root, "nul.txt"), Buffer.from([0x61, 0x00, 0x62]));
    expect(() => prepareTargets(root, ["nul.txt"], [root])).toThrow(/NUL/i);
  });

  it("detects CRLF files correctly", () => {
    writeFileSync(join(root, "crlf.txt"), "a\r\nb\r\n");
    const prepared = prepareTargets(root, ["crlf.txt"], [root]);
    expect(prepared[0].eol).toBe("\r\n");
  });

  it("parses a file with no trailing newline", () => {
    writeFileSync(join(root, "no-nl.txt"), "just one line, no newline");
    const prepared = prepareTargets(root, ["no-nl.txt"], [root]);
    expect(prepared[0].exists).toBe(true);
    expect(prepared[0].text).toBe("just one line, no newline");
  });

  it("rejects a target whose path has a denylisted component or basename (case-insensitive)", () => {
    expect(() => prepareTargets(root, [".git/config"], [root])).toThrow(/denylist/i);
    expect(() => prepareTargets(root, ["CLAUDE.MD"], [root])).toThrow(/denylist/i);
    expect(() => prepareTargets(root, ["sub/AGENTS.md"], [root])).toThrow(/denylist/i);
  });

  it("rejects a lexical .. that stays inside root after resolution", () => {
    mkdirSync(join(root, "sub"));
    expect(() => prepareTargets(root, ["sub/../file.txt"], [root])).toThrow();
  });
});

describe("commitChanges", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "local-router-apply-")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates two new files together", () => {
    const prepared = prepareTargets(root, ["new1.txt", "new2.txt"], [root]);
    const result = commitChanges(
      [
        { rel: "new1.txt", before: "", after: "hello\n", created: true },
        { rel: "new2.txt", before: "", after: "world\n", created: true },
      ],
      prepared,
      root,
      [root]
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "new1.txt"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(root, "new2.txt"), "utf8")).toBe("world\n");
    expect(result.files).toHaveLength(2);
    for (const f of result.files) {
      expect(f.created).toBe(true);
      expect(f.added).toBe(1);
    }
  });

  it("edits an existing file", () => {
    writeFileSync(join(root, "e.txt"), "old\n");
    const prepared = prepareTargets(root, ["e.txt"], [root]);
    const result = commitChanges(
      [{ rel: "e.txt", before: "old\n", after: "new\n", created: false }],
      prepared,
      root,
      [root]
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "e.txt"), "utf8")).toBe("new\n");
    expect(result.files[0].created).toBe(false);
    expect(result.files[0].added).toBe(1);
    expect(result.files[0].removed).toBe(1);
  });

  it("creates a file whose parent directory does not exist yet", () => {
    const prepared = prepareTargets(root, ["sub/dir/new.txt"], [root]);
    const result = commitChanges(
      [{ rel: "sub/dir/new.txt", before: "", after: "content\n", created: true }],
      prepared,
      root,
      [root]
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "sub/dir/new.txt"), "utf8")).toBe("content\n");
  });

  it("refuses a file that changed on disk between prepare and commit", () => {
    writeFileSync(join(root, "e2.txt"), "a\n");
    const prepared = prepareTargets(root, ["e2.txt"], [root]);
    writeFileSync(join(root, "e2.txt"), "mutated externally\n");
    const result = commitChanges(
      [{ rel: "e2.txt", before: "a\n", after: "b\n", created: false }],
      prepared,
      root,
      [root]
    );
    expect(result.ok).toBe(false);
    expect((result.errors ?? []).join("\n")).toMatch(/e2\.txt/);
    expect((result.errors ?? []).join("\n")).toMatch(/changed on disk/i);
    expect(readFileSync(join(root, "e2.txt"), "utf8")).toBe("mutated externally\n");
  });

  it("refuses a target prepared as new that came to exist on disk", () => {
    const prepared = prepareTargets(root, ["new3.txt"], [root]);
    writeFileSync(join(root, "new3.txt"), "surprise\n");
    const result = commitChanges(
      [{ rel: "new3.txt", before: "", after: "b\n", created: true }],
      prepared,
      root,
      [root]
    );
    expect(result.ok).toBe(false);
    expect(readFileSync(join(root, "new3.txt"), "utf8")).toBe("surprise\n");
  });

  it("is atomic across multiple files (re-verify before any write)", () => {
    writeFileSync(join(root, "m1.txt"), "one\n");
    writeFileSync(join(root, "m2.txt"), "two\n");
    writeFileSync(join(root, "m3.txt"), "three\n");
    const prepared = prepareTargets(root, ["m1.txt", "m2.txt", "m3.txt"], [root]);

    writeFileSync(join(root, "m2.txt"), "mutated externally\n");

    const beforeM1 = readFileSync(join(root, "m1.txt"));
    const beforeM2 = readFileSync(join(root, "m2.txt"));
    const beforeM3 = readFileSync(join(root, "m3.txt"));

    const result = commitChanges(
      [
        { rel: "m1.txt", before: "one\n", after: "ONE\n", created: false },
        { rel: "m2.txt", before: "two\n", after: "TWO\n", created: false },
        { rel: "m3.txt", before: "three\n", after: "THREE\n", created: false },
      ],
      prepared,
      root,
      [root]
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(join(root, "m1.txt"))).toEqual(beforeM1);
    expect(readFileSync(join(root, "m2.txt"))).toEqual(beforeM2);
    expect(readFileSync(join(root, "m3.txt"))).toEqual(beforeM3);
  });

  it("preserves file mode", () => {
    writeFileSync(join(root, "perm.txt"), "v1\n");
    chmodSync(join(root, "perm.txt"), 0o755);
    const prepared = prepareTargets(root, ["perm.txt"], [root]);
    const result = commitChanges(
      [{ rel: "perm.txt", before: "v1\n", after: "v2\n", created: false }],
      prepared,
      root,
      [root]
    );
    expect(result.ok).toBe(true);
    expect(statSync(join(root, "perm.txt")).mode & 0o777).toBe(0o755);
  });

  it("preserves a hard link for the other link (rename replaces directory entry)", () => {
    writeFileSync(join(root, "orig.txt"), "v1\n");
    linkSync(join(root, "orig.txt"), join(root, "linked.txt"));
    const prepared = prepareTargets(root, ["orig.txt"], [root]);
    const result = commitChanges(
      [{ rel: "orig.txt", before: "v1\n", after: "v2\n", created: false }],
      prepared,
      root,
      [root]
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "orig.txt"), "utf8")).toBe("v2\n");
    expect(readFileSync(join(root, "linked.txt"), "utf8")).toBe("v1\n");
  });

  it("refuses a commit when an existing file's directory was swapped for a symlink pointing outside scope between prepare and commit", () => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub/f.txt"), "v1\n");
    const prepared = prepareTargets(root, ["sub/f.txt"], [root]);

    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "local-router-apply-outside-")));
    try {
      writeFileSync(join(outsideDir, "f.txt"), "v1\n");
      rmSync(join(root, "sub"), { recursive: true });
      symlinkSync(outsideDir, join(root, "sub"));

      const result = commitChanges(
        [{ rel: "sub/f.txt", before: "v1\n", after: "PWNED\n", created: false }],
        prepared,
        root,
        [root]
      );

      expect(result.ok).toBe(false);
      expect(readFileSync(join(outsideDir, "f.txt"), "utf8")).toBe("v1\n");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("refuses a commit for a new target whose parent directory was swapped for a symlink pointing outside scope", () => {
    mkdirSync(join(root, "nd"));
    const prepared = prepareTargets(root, ["nd/new.txt"], [root]);

    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "local-router-apply-outside-")));
    try {
      rmSync(join(root, "nd"), { recursive: true });
      symlinkSync(outsideDir, join(root, "nd"));

      const result = commitChanges(
        [{ rel: "nd/new.txt", before: "", after: "CREATED\n", created: true }],
        prepared,
        root,
        [root]
      );

      expect(result.ok).toBe(false);
      expect(existsSync(join(outsideDir, "new.txt"))).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("does not remove a pre-existing directory on rollback, and removes only the directories this call created, deepest first", () => {
    mkdirSync(join(root, "existing"));
    const prepared = prepareTargets(
      root,
      ["existing/newfile.txt", "brandnew/nested/other.txt"],
      [root]
    );

    mkdirSync(join(root, "brandnew/nested"), { recursive: true });
    writeFileSync(join(root, "brandnew/nested/other.txt"), "already here\n");

    const result = commitChanges(
      [
        { rel: "existing/newfile.txt", before: "", after: "A\n", created: true },
        { rel: "brandnew/nested/other.txt", before: "", after: "B\n", created: true },
      ],
      prepared,
      root,
      [root]
    );

    expect(result.ok).toBe(false);
    expect(existsSync(join(root, "existing"))).toBe(true);

    const checkDir = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry.includes(".lr-") && entry.includes(".tmp")) {
          throw new Error(`Leftover temp file found: ${join(dir, entry)}`);
        }
      }
    };

    checkDir(root);
    if (existsSync(join(root, "existing"))) checkDir(join(root, "existing"));
    if (existsSync(join(root, "brandnew"))) {
      checkDir(join(root, "brandnew"));
      if (existsSync(join(root, "brandnew/nested"))) checkDir(join(root, "brandnew/nested"));
    }
  });
});

describe("buildDiff", () => {
  it("handles one created file", () => {
    const result = buildDiff([
      { rel: "new.txt", before: "", after: "a\nb\n", created: true },
    ]);
    expect(result.diff).toContain("/dev/null");
    expect(result.diff).toContain("b/new.txt");
    expect(/^Index:/m.test(result.diff)).toBe(false);
    expect(/^=+$/m.test(result.diff)).toBe(false);
    expect(result.added).toBe(2);
    expect(result.removed).toBe(0);
  });

  it("handles one edited file", () => {
    const result = buildDiff([
      { rel: "e.txt", before: "old line\n", after: "new line\n", created: false },
    ]);
    expect(result.diff).toContain("a/e.txt");
    expect(result.diff).toContain("b/e.txt");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
  });

  it("handles two files in one call", () => {
    const result = buildDiff([
      { rel: "new.txt", before: "", after: "a\nb\n", created: true },
      { rel: "e.txt", before: "old line\n", after: "new line\n", created: false },
    ]);
    expect(result.diff).toContain("new.txt");
    expect(result.diff).toContain("e.txt");
    expect(result.added).toBe(3);
    expect(result.removed).toBe(1);
  });
});

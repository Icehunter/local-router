import { describe, it, expect } from "vitest";
import { parseEditReply, planEdits } from "../src/editblocks.js";
import type { ParseResult, PreparedTargetInput } from "../src/editblocks.js";

describe("parseEditReply", () => {
  it("parses a single EDIT block with one search/replace pair into one EditSection with one pair", () => {
    const reply = [
      "=== EDIT: src/foo.ts ===",
      "<<<<<<< SEARCH",
      "old line",
      "=======",
      "new line",
      ">>>>>>> REPLACE",
      "=== END EDIT ===",
    ].join("\n");

    const result = parseEditReply(reply);

    expect(result.sections).toHaveLength(1);
    const section = result.sections[0];
    expect(section.kind).toBe("edit");
    if (section.kind !== "edit") throw new Error("expected edit section");
    expect(section.path).toBe("src/foo.ts");
    expect(section.pairs).toHaveLength(1);
    expect(section.pairs[0].search).toEqual(["old line"]);
    expect(section.pairs[0].replace).toEqual(["new line"]);
    expect(result.errors).toEqual([]);
    expect(result.need).toBeNull();
  });

  it("parses a FILE block for a new file into one FileSection with content joined by \\n plus trailing newline", () => {
    const reply = [
      "=== FILE: src/new.ts ===",
      "line one",
      "line two",
      "line three",
      "=== END FILE ===",
    ].join("\n");

    const result = parseEditReply(reply);

    expect(result.sections).toHaveLength(1);
    const section = result.sections[0];
    expect(section.kind).toBe("file");
    if (section.kind !== "file") throw new Error("expected file section");
    expect(section.path).toBe("src/new.ts");
    expect(section.content).toBe("line one\nline two\nline three");
  });

  it("strips a single wrapping triple-backtick fence pair from FILE content when path does not end in .md, and does NOT strip when it ends in .md", () => {
    const nonMdReply = [
      "=== FILE: src/new.ts ===",
      "```ts",
      "line one",
      "line two",
      "```",
      "=== END FILE ===",
    ].join("\n");

    const nonMdResult = parseEditReply(nonMdReply);
    expect(nonMdResult.sections).toHaveLength(1);
    const nonMdSection = nonMdResult.sections[0];
    expect(nonMdSection.kind).toBe("file");
    if (nonMdSection.kind !== "file") throw new Error("expected file section");
    expect(nonMdSection.content).toBe("line one\nline two");

    const mdReply = [
      "=== FILE: docs/readme.md ===",
      "```ts",
      "line one",
      "line two",
      "```",
      "=== END FILE ===",
    ].join("\n");

    const mdResult = parseEditReply(mdReply);
    expect(mdResult.sections).toHaveLength(1);
    const mdSection = mdResult.sections[0];
    expect(mdSection.kind).toBe("file");
    if (mdSection.kind !== "file") throw new Error("expected file section");
    expect(mdSection.content).toBe("```ts\nline one\nline two\n```");
  });

  it("accumulates two EDIT blocks for the same path into a single EditSection with two pairs", () => {
    const reply = [
      "=== EDIT: src/foo.ts ===",
      "<<<<<<< SEARCH",
      "first old",
      "=======",
      "first new",
      ">>>>>>> REPLACE",
      "=== END EDIT ===",
      "=== EDIT: src/foo.ts ===",
      "<<<<<<< SEARCH",
      "second old",
      "=======",
      "second new",
      ">>>>>>> REPLACE",
      "=== END EDIT ===",
    ].join("\n");

    const result = parseEditReply(reply);

    expect(result.sections).toHaveLength(1);
    const section = result.sections[0];
    expect(section.kind).toBe("edit");
    if (section.kind !== "edit") throw new Error("expected edit section");
    expect(section.path).toBe("src/foo.ts");
    expect(section.pairs).toHaveLength(2);
    expect(section.pairs[0].search).toEqual(["first old"]);
    expect(section.pairs[0].replace).toEqual(["first new"]);
    expect(section.pairs[1].search).toEqual(["second old"]);
    expect(section.pairs[1].replace).toEqual(["second new"]);
  });

  it("recognizes NEED: <reason> as the whole reply", () => {
    const result = parseEditReply("NEED: I need more context");

    expect(result.sections).toEqual([]);
    expect(result.need).toBe("I need more context");
    expect(result.errors).toEqual([]);
    expect(result.strayLines).toBe(0);
  });

  it("does NOT treat a reply as NEED when there is other non-blank content alongside the NEED line", () => {
    const reply = [
      "NEED: something",
      "=== EDIT: src/foo.ts ===",
      "<<<<<<< SEARCH",
      "old",
      "=======",
      "new",
      ">>>>>>> REPLACE",
      "=== END EDIT ===",
    ].join("\n");

    const result = parseEditReply(reply);

    expect(result.need).toBeNull();
    expect(result.sections).toHaveLength(1);
    const section = result.sections[0];
    expect(section.kind).toBe("edit");
  });

  it('reports an error containing "cut off or malformed" for an EDIT block whose SEARCH is opened but never closed', () => {
    const reply = [
      "=== EDIT: src/foo.ts ===",
      "<<<<<<< SEARCH",
      "old line",
    ].join("\n");

    const result = parseEditReply(reply);

    expect(result.errors.some((e) => e.includes("cut off or malformed"))).toBe(true);
  });

  it('reports an error containing "no search/replace pairs" for an EDIT header immediately followed by END EDIT', () => {
    const reply = [
      "=== EDIT: src/foo.ts ===",
      "=== END EDIT ===",
    ].join("\n");

    const result = parseEditReply(reply);

    expect(result.errors.some((e) => e.includes("no search/replace pairs"))).toBe(true);
  });

  it("counts a stray non-blank, non-fence line outside any section in strayLines, but not blank lines or bare fence lines", () => {
    const reply = [
      "",
      "```",
      "stray text here",
      "",
      "```",
    ].join("\n");

    const result = parseEditReply(reply);

    expect(result.strayLines).toBe(1);
  });

  it('reports an error containing "marker outside an EDIT section" for a lone ======= or >>>>>>> REPLACE line', () => {
    const replyWithDivider = [
      "=======",
    ].join("\n");

    const resultWithDivider = parseEditReply(replyWithDivider);
    expect(resultWithDivider.errors.some((e) => e.includes("marker outside an EDIT section"))).toBe(true);

    const replyWithReplace = [
      ">>>>>>> REPLACE",
    ].join("\n");

    const resultWithReplace = parseEditReply(replyWithReplace);
    expect(resultWithReplace.errors.some((e) => e.includes("marker outside an EDIT section"))).toBe(true);
  });
});

describe("planEdits", () => {
  it("applies a single search/replace pair to an existing file, producing one PlannedChange with created: false", () => {
    const parsed: ParseResult = {
      sections: [
        {
          kind: "edit",
          path: "src/foo.ts",
          pairs: [{ search: ["old line"], replace: ["new line"] }],
        },
      ],
      need: null,
      errors: [],
      strayLines: 0,
    };

    const prepared: PreparedTargetInput[] = [
      { rel: "src/foo.ts", exists: true, text: "line one\nold line\nline three\n", eol: "\n" },
    ];

    const result = planEdits(parsed, prepared);

    expect(result.errors).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].rel).toBe("src/foo.ts");
    expect(result.changes[0].created).toBe(false);
    expect(result.changes[0].before).toBe("line one\nold line\nline three\n");
    expect(result.changes[0].after).toBe("line one\nnew line\nline three\n");
  });

  it("creates a new file from a FILE-kind section when the prepared target has exists: false", () => {
    const parsed: ParseResult = {
      sections: [
        { kind: "file", path: "src/new.ts", content: "hello\nworld\n" },
      ],
      need: null,
      errors: [],
      strayLines: 0,
    };

    const prepared: PreparedTargetInput[] = [
      { rel: "src/new.ts", exists: false, text: "", eol: "\n" },
    ];

    const result = planEdits(parsed, prepared);

    expect(result.errors).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].rel).toBe("src/new.ts");
    expect(result.changes[0].created).toBe(true);
    expect(result.changes[0].before).toBe("");
    expect(result.changes[0].after).toBe("hello\nworld\n");
  });

  it('reports an error containing "not in the prepared targets" when a section path is not present', () => {
    const parsed: ParseResult = {
      sections: [
        {
          kind: "edit",
          path: "src/missing.ts",
          pairs: [{ search: ["old"], replace: ["new"] }],
        },
      ],
      need: null,
      errors: [],
      strayLines: 0,
    };

    const prepared: PreparedTargetInput[] = [
      { rel: "src/other.ts", exists: true, text: "content\n", eol: "\n" },
    ];

    const result = planEdits(parsed, prepared);

    expect(result.errors.some((e) => e.includes("not in the prepared targets"))).toBe(true);
    expect(result.changes).toEqual([]);
  });

  it('reports an error containing "matched 0 times" when SEARCH lines do not appear in target text', () => {
    const parsed: ParseResult = {
      sections: [
        {
          kind: "edit",
          path: "src/foo.ts",
          pairs: [{ search: ["nonexistent line"], replace: ["new"] }],
        },
      ],
      need: null,
      errors: [],
      strayLines: 0,
    };

    const prepared: PreparedTargetInput[] = [
      { rel: "src/foo.ts", exists: true, text: "line one\nline two\nline three\n", eol: "\n" },
    ];

    const result = planEdits(parsed, prepared);

    expect(result.errors.some((e) => e.includes("matched 0 times"))).toBe(true);
  });

  it('reports an error containing "matched" and "expected exactly 1" when SEARCH appears more than once', () => {
    const parsed: ParseResult = {
      sections: [
        {
          kind: "edit",
          path: "src/foo.ts",
          pairs: [{ search: ["dup"], replace: ["new"] }],
        },
      ],
      need: null,
      errors: [],
      strayLines: 0,
    };

    const prepared: PreparedTargetInput[] = [
      { rel: "src/foo.ts", exists: true, text: "dup\nline two\ndup\nline four\n", eol: "\n" },
    ];

    const result = planEdits(parsed, prepared);

    expect(result.errors.some((e) => e.includes("matched") && e.includes("expected exactly 1"))).toBe(true);
  });

  it('reports an error containing "overlap" when two edit pairs resolve to overlapping line spans', () => {
    const parsed: ParseResult = {
      sections: [
        {
          kind: "edit",
          path: "src/foo.ts",
          pairs: [
            { search: ["line one", "line two"], replace: ["replaced one"] },
            { search: ["line two", "line three"], replace: ["replaced two"] },
          ],
        },
      ],
      need: null,
      errors: [],
      strayLines: 0,
    };

    const prepared: PreparedTargetInput[] = [
      { rel: "src/foo.ts", exists: true, text: "line one\nline two\nline three\nline four\n", eol: "\n" },
    ];

    const result = planEdits(parsed, prepared);

    expect(result.errors.some((e) => e.includes("overlap"))).toBe(true);
  });

  it("applies two non-overlapping edit pairs to the same file correctly", () => {
    const parsed: ParseResult = {
      sections: [
        {
          kind: "edit",
          path: "src/foo.ts",
          pairs: [
            { search: ["line one"], replace: ["first new"] },
            { search: ["line three"], replace: ["second new"] },
          ],
        },
      ],
      need: null,
      errors: [],
      strayLines: 0,
    };

    const prepared: PreparedTargetInput[] = [
      { rel: "src/foo.ts", exists: true, text: "line one\nline two\nline three\nline four\n", eol: "\n" },
    ];

    const result = planEdits(parsed, prepared);

    expect(result.errors).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].after).toBe("first new\nline two\nsecond new\nline four\n");
  });

  it("produces no change when a section edit results in text identical to the original (no-op replace)", () => {
    const parsed: ParseResult = {
      sections: [
        {
          kind: "edit",
          path: "src/foo.ts",
          pairs: [{ search: ["same line"], replace: ["same line"] }],
        },
      ],
      need: null,
      errors: [],
      strayLines: 0,
    };

    const prepared: PreparedTargetInput[] = [
      { rel: "src/foo.ts", exists: true, text: "line one\nsame line\nline three\n", eol: "\n" },
    ];

    const result = planEdits(parsed, prepared);

    expect(result.errors).toEqual([]);
    expect(result.changes).toEqual([]);
  });

  it('reports an error containing "already exists" when a FILE-kind section path matches a prepared target with exists: true', () => {
    const parsed: ParseResult = {
      sections: [
        { kind: "file", path: "src/existing.ts", content: "new content\n" },
      ],
      need: null,
      errors: [],
      strayLines: 0,
    };

    const prepared: PreparedTargetInput[] = [
      { rel: "src/existing.ts", exists: true, text: "old content\n", eol: "\n" },
    ];

    const result = planEdits(parsed, prepared);

    expect(result.errors.some((e) => e.includes("already exists"))).toBe(true);
  });

  it('reports an error containing "only has EDIT blocks" when an EDIT-kind section path matches a prepared target with exists: false and no FILE section exists for that path', () => {
    const parsed: ParseResult = {
      sections: [
        {
          kind: "edit",
          path: "src/missing.ts",
          pairs: [{ search: ["old"], replace: ["new"] }],
        },
      ],
      need: null,
      errors: [],
      strayLines: 0,
    };

    const prepared: PreparedTargetInput[] = [
      { rel: "src/missing.ts", exists: false, text: "", eol: "\n" },
    ];

    const result = planEdits(parsed, prepared);

    expect(result.errors.some((e) => e.includes("only has EDIT blocks"))).toBe(true);
  });
});

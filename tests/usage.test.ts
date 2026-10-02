import { describe, it, expect } from "vitest";
import { summarizeUsage, formatTable } from "../src/usage.js";

describe("summarizeUsage", () => {
  it("returns empty rows and zero malformed for an empty input array", () => {
    const result = summarizeUsage([]);
    expect(result).toEqual({ rows: [], malformed: 0 });
  });

  it("skips blank lines silently (not counted as malformed, no row)", () => {
    const result = summarizeUsage(["", "   ", "\t\n"]);
    expect(result.rows).toEqual([]);
    expect(result.malformed).toBe(0);
  });

  it("counts a non-JSON line as malformed and produces no row", () => {
    const result = summarizeUsage(["this is not json at all"]);
    expect(result.rows).toEqual([]);
    expect(result.malformed).toBe(1);
  });

  it("counts valid JSON that is not an object as malformed", () => {
    const result = summarizeUsage([JSON.stringify([1, 2]), "42", "null"]);
    expect(result.rows).toEqual([]);
    expect(result.malformed).toBe(3);
  });

  it("counts a JSON object missing ts string field as malformed", () => {
    const result = summarizeUsage([JSON.stringify({ tier: "coder", outcome: "ok" })]);
    expect(result.rows).toEqual([]);
    expect(result.malformed).toBe(1);
  });

  it("counts a JSON object with non-string ts as malformed", () => {
    const result = summarizeUsage([JSON.stringify({ ts: 42, tier: "coder", outcome: "ok" })]);
    expect(result.rows).toEqual([]);
    expect(result.malformed).toBe(1);
  });

  it("counts a JSON object with an invalid outcome as malformed", () => {
    const result = summarizeUsage([
      JSON.stringify({ ts: "2026-09-26T14:15:02.123Z", tier: "coder", outcome: "weird" }),
    ]);
    expect(result.rows).toEqual([]);
    expect(result.malformed).toBe(1);
  });

  it("produces exactly one row for a well-formed line with the expected counters", () => {
    const result = summarizeUsage([
      JSON.stringify({ ts: "2026-09-26T14:15:02.123Z", tier: "coder", outcome: "applied" }),
    ]);
    expect(result.malformed).toBe(0);
    expect(result.rows).toEqual([
      {
        day: "2026-09-26",
        tier: "coder",
        calls: 1,
        ok: 0,
        applied: 1,
        no_change: 0,
        refused: 0,
        rejected: 0,
        error: 0,
      },
    ]);
  });

  it("groups lines with tier null under '(none)'", () => {
    const result = summarizeUsage([
      JSON.stringify({ ts: "2026-09-26T14:15:02.123Z", tier: null, outcome: "ok" }),
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].tier).toBe("(none)");
  });

  it("groups lines with an absent tier field under '(none)'", () => {
    const result = summarizeUsage([
      JSON.stringify({ ts: "2026-09-26T14:15:02.123Z", outcome: "ok" }),
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].tier).toBe("(none)");
  });

  it("merges same day+tier with different outcomes into one row, summing calls", () => {
    const result = summarizeUsage([
      JSON.stringify({ ts: "2026-09-26T14:15:02.123Z", tier: "coder", outcome: "ok" }),
      JSON.stringify({ ts: "2026-09-26T15:00:00.000Z", tier: "coder", outcome: "applied" }),
    ]);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.day).toBe("2026-09-26");
    expect(row.tier).toBe("coder");
    expect(row.calls).toBe(2);
    expect(row.ok).toBe(1);
    expect(row.applied).toBe(1);
  });

  it("produces separate rows for the same day with different tiers", () => {
    const result = summarizeUsage([
      JSON.stringify({ ts: "2026-09-26T14:15:02.123Z", tier: "coder", outcome: "ok" }),
      JSON.stringify({ ts: "2026-09-26T14:15:02.123Z", tier: "planner", outcome: "ok" }),
    ]);
    expect(result.rows).toHaveLength(2);
  });

  it("produces separate rows for the same tier with different days (UTC date portion)", () => {
    const result = summarizeUsage([
      JSON.stringify({ ts: "2026-09-25T14:15:02.123Z", tier: "coder", outcome: "ok" }),
      JSON.stringify({ ts: "2026-09-26T14:15:02.123Z", tier: "coder", outcome: "ok" }),
    ]);
    expect(result.rows).toHaveLength(2);
  });

  it("sorts rows by day ascending then tier ascending regardless of input order", () => {
    const lines = [
      JSON.stringify({ ts: "2026-09-27T14:15:02.123Z", tier: "zeta", outcome: "ok" }),
      JSON.stringify({ ts: "2026-09-25T14:15:02.123Z", tier: "coder", outcome: "ok" }),
      JSON.stringify({ ts: "2026-09-27T14:15:02.123Z", tier: "alpha", outcome: "ok" }),
      JSON.stringify({ ts: "2026-09-25T14:15:02.123Z", tier: "beta", outcome: "ok" }),
    ];
    const result = summarizeUsage(lines);
    expect(result.rows.map((r) => `${r.day}|${r.tier}`)).toEqual([
      "2026-09-25|beta",
      "2026-09-25|coder",
      "2026-09-27|alpha",
      "2026-09-27|zeta",
    ]);
  });

  it("lands each of the six outcomes in its matching field with calls = 6", () => {
    const ts = "2026-09-26T14:15:02.123Z";
    const tier = "coder";
    const lines = (["ok", "applied", "no_change", "refused", "rejected", "error"] as const).map(
      (outcome) => JSON.stringify({ ts, tier, outcome })
    );
    const result = summarizeUsage(lines);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.calls).toBe(6);
    expect(row.ok).toBe(1);
    expect(row.applied).toBe(1);
    expect(row.no_change).toBe(1);
    expect(row.refused).toBe(1);
    expect(row.rejected).toBe(1);
    expect(row.error).toBe(1);
  });
});

describe("formatTable", () => {
  it('returns exactly "No usage recorded." for empty rows and zero malformed', () => {
    const out = formatTable({ rows: [], malformed: 0 });
    expect(out).toBe("No usage recorded.");
  });

  it("includes every header word on the first line, with no digit in that line", () => {
    const row = {
      day: "2026-09-26",
      tier: "coder",
      calls: 3,
      ok: 1,
      applied: 2,
      no_change: 0,
      refused: 0,
      rejected: 0,
      error: 0,
    };
    const out = formatTable({ rows: [row], malformed: 0 });
    const firstLine = out.split("\n")[0];
    for (const word of ["day", "tier", "calls", "ok", "applied", "no_change", "refused", "rejected", "error"]) {
      expect(firstLine).toContain(word);
    }
    expect(/\d/.test(firstLine)).toBe(false);
  });

  it("contains a line with both the day and tier, plus the summary line for one row", () => {
    const row = {
      day: "2026-09-26",
      tier: "coder",
      calls: 3,
      ok: 1,
      applied: 2,
      no_change: 0,
      refused: 0,
      rejected: 0,
      error: 0,
    };
    const out = formatTable({ rows: [row], malformed: 0 });
    const lines = out.split("\n");
    expect(lines.some((l) => l.includes("2026-09-26") && l.includes("coder"))).toBe(true);
    expect(out).toContain("3 total call(s) across 1 day/tier group(s)");
  });

  it('includes the malformed line when malformed > 0', () => {
    const row = {
      day: "2026-09-26",
      tier: "coder",
      calls: 3,
      ok: 1,
      applied: 2,
      no_change: 0,
      refused: 0,
      rejected: 0,
      error: 0,
    };
    const out = formatTable({ rows: [row], malformed: 2 });
    expect(out).toContain("2 malformed line(s) skipped");
  });

  it('does not contain "malformed" anywhere when malformed is 0 and there is at least one row', () => {
    const row = {
      day: "2026-09-26",
      tier: "coder",
      calls: 3,
      ok: 1,
      applied: 2,
      no_change: 0,
      refused: 0,
      rejected: 0,
      error: 0,
    };
    const out = formatTable({ rows: [row], malformed: 0 });
    expect(out).not.toContain("malformed");
  });
});

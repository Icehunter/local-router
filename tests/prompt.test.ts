import { describe, expect, it } from "vitest";
import {
  buildMessages,
  DEFAULT_SYSTEM_PROMPT,
  REVIEW_REMINDER,
  wrapWithReviewReminder,
} from "../src/prompt.js";

describe("buildMessages", () => {
  it("uses default system prompt when none provided", () => {
    const messages = buildMessages({ prompt: "write hello" });
    expect(messages[0]).toEqual({
      role: "system",
      content: DEFAULT_SYSTEM_PROMPT,
    });
  });

  it("uses provided system prompt when given", () => {
    const messages = buildMessages({ prompt: "x", system: "custom system" });
    expect(messages[0].content).toBe("custom system");
  });

  it("appends 'code' format directive by default", () => {
    const messages = buildMessages({ prompt: "write a fn" });
    const user = messages[1].content;
    expect(user).toContain("write a fn");
    expect(user).toContain("Return only code");
  });

  it("appends 'diff' format directive when output_format='diff'", () => {
    const messages = buildMessages({ prompt: "fix bug", output_format: "diff" });
    expect(messages[1].content).toContain("Return a unified diff");
  });

  it("appends 'explanation' format directive when output_format='explanation'", () => {
    const messages = buildMessages({ prompt: "explain x", output_format: "explanation" });
    expect(messages[1].content).toContain("Explain in prose");
  });

  it("returns exactly two messages, system then user", () => {
    const messages = buildMessages({ prompt: "x" });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
  });

  it("uses '\\n\\n---\\n\\n' as the separator between prompt and directive", () => {
    const messages = buildMessages({ prompt: "write a fn", output_format: "code" });
    expect(messages[1].content).toBe(
      "write a fn\n\n---\n\nReturn only code. No prose, no fences unless syntactically required by the language.",
    );
  });
});

describe("wrapWithReviewReminder", () => {
  it("wraps output in <qwen_output> tags", () => {
    const wrapped = wrapWithReviewReminder("function add(a, b) { return a + b; }");
    expect(wrapped).toContain("<qwen_output>\nfunction add(a, b) { return a + b; }\n</qwen_output>");
  });

  it("appends the review reminder after the wrapped output", () => {
    const wrapped = wrapWithReviewReminder("code");
    expect(wrapped).toBe(`<qwen_output>\ncode\n</qwen_output>\n\n${REVIEW_REMINDER}`);
  });

  it("review reminder names Task tool and Sonnet subagent", () => {
    expect(REVIEW_REMINDER).toContain("Task tool");
    expect(REVIEW_REMINDER).toContain("Sonnet subagent");
  });

  it("review reminder forbids Edit/Write before review returns", () => {
    expect(REVIEW_REMINDER).toContain("Do not call Edit or Write");
  });

  it("preserves the original output verbatim inside the wrapper", () => {
    const original = "line1\n  line2\n\tline3 with <tags> & special chars";
    const wrapped = wrapWithReviewReminder(original);
    expect(wrapped).toContain(original);
  });

  it("review reminder lists objective skip criteria and post-review actions", () => {
    expect(REVIEW_REMINDER).toContain("ALL THREE");
    expect(REVIEW_REMINDER).toContain("fewer than 5 lines");
    expect(REVIEW_REMINDER).toContain("regenerate via qwen_implement");
  });
});

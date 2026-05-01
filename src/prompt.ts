export type OutputFormat = "code" | "diff" | "explanation";

export interface BuildMessagesInput {
  prompt: string;
  system?: string;
  output_format?: OutputFormat;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const DEFAULT_SYSTEM_PROMPT =
  "You are a careful, focused code-generation assistant. " +
  "You produce correct, minimal, well-structured code. " +
  "You follow the conventions visible in any code the user shows you. " +
  "You do not invent APIs you have not seen. " +
  "If the request is ambiguous, you state your assumption briefly and proceed.";

const FORMAT_DIRECTIVES: Record<OutputFormat, string> = {
  code: "Return only code. No prose, no fences unless syntactically required by the language.",
  diff: "Return a unified diff. Use `--- a/path` and `+++ b/path` headers. No prose.",
  explanation: "Explain in prose. Be concise.",
};

export const REVIEW_REMINDER =
  "Before applying any of the code above, dispatch a Sonnet subagent via the Task tool to review it against:\n" +
  "  - the requirements you sent in the prompt\n" +
  "  - the project conventions in CLAUDE.md and the README\n" +
  "  - obvious bugs, missing imports, or syntax errors\n" +
  "Do not call Edit or Write until the review returns. " +
  "Skip the review only when ALL THREE: (a) the output is fewer than 5 lines, (b) it is a complete self-contained snippet (not a partial edit to existing code), and (c) the review work would clearly cost more than the change's blast radius. " +
  "If the review surfaces 1-2 small issues, fix them yourself when applying the Edit. " +
  "If it surfaces structural problems or multiple issues, regenerate via qwen_implement with the feedback baked into the prompt.";

export function wrapWithReviewReminder(qwenOutput: string): string {
  return `<qwen_output>\n${qwenOutput}\n</qwen_output>\n\n${REVIEW_REMINDER}`;
}

export function buildMessages(input: BuildMessagesInput): ChatMessage[] {
  const system = input.system ?? DEFAULT_SYSTEM_PROMPT;
  const format = input.output_format ?? "code";
  const directive = FORMAT_DIRECTIVES[format];
  const userContent = `${input.prompt}\n\n---\n\n${directive}`;
  return [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ];
}

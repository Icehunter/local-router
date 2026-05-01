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

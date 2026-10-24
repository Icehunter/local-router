import { createHash } from "node:crypto";
import type { ChatMessage } from "./prompt.js";

export interface TraceRequest {
  model: string;
  messages: ChatMessage[];
  parameters: Record<string, unknown>;
}

export interface TraceCapture {
  endpoint_id: string;
  complete: boolean;
  request: TraceRequest;
  response: {
    content: string;
    finish_reason: string | null;
    usage: { prompt_tokens: number; completion_tokens: number } | null;
  };
}

export interface LocalRouterTrace extends TraceCapture {
  version: 1;
  request_id: string;
}

export interface CapturedRequest {
  endpoint_id: string;
  request: TraceRequest;
}

// The caller passes the very JSON string assigned to fetch.body. Parsing that
// string preserves all and only the fields actually transmitted on the wire.
export function captureRequest(body: string, upstreamURL: string): CapturedRequest {
  const { model, messages, ...parameters } = JSON.parse(body) as {
    model: string; messages: ChatMessage[]; [key: string]: unknown;
  };
  const endpoint = new URL(upstreamURL);
  endpoint.username = "";
  endpoint.password = "";
  endpoint.search = "";
  endpoint.hash = "";
  return {
    endpoint_id: "sha256:" + createHash("sha256").update(endpoint.toString()).digest("hex"),
    request: { model, messages, parameters },
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function absent(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

// Never spread an upstream response into a trace. Only the supported public
// answer is copied; private reasoning, tool calls and unknown fields are omitted.
export function captureResponse(captured: CapturedRequest, value: unknown): TraceCapture {
  const root = object(value);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const choice = object(choices[0]);
  const message = object(choice?.message);
  const finish_reason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  let content = typeof message?.content === "string" ? message.content : "";
  const inlineReasoning = /<\/?(?:think|thinking|analysis)\b[^>]*>/i.test(content);
  if (inlineReasoning) content = "";
  const allowedRoot = new Set(["id", "object", "created", "model", "choices", "usage", "system_fingerprint", "service_tier", "timings"]);
  const allowedChoice = new Set(["index", "message", "finish_reason", "logprobs"]);
  const allowedMessage = new Set(["role", "content", "refusal", "reasoning", "reasoning_content", "tool_calls", "function_call"]);
  let complete = choices.length === 1 && finish_reason === "stop" && message?.role === "assistant"
    && content.trim() !== "" && !inlineReasoning
    && Object.keys(root ?? {}).every((key) => allowedRoot.has(key))
    && Object.keys(choice ?? {}).every((key) => allowedChoice.has(key))
    && Object.keys(message ?? {}).every((key) => allowedMessage.has(key))
    && ["refusal", "reasoning", "reasoning_content", "tool_calls", "function_call"].every((key) => absent(message?.[key]));
  let usage: TraceCapture["response"]["usage"] = null;
  if (root?.usage !== undefined && root.usage !== null) {
    const raw = object(root.usage);
    if (typeof raw?.prompt_tokens === "number" && Number.isSafeInteger(raw.prompt_tokens) && raw.prompt_tokens >= 0
      && typeof raw.completion_tokens === "number" && Number.isSafeInteger(raw.completion_tokens) && raw.completion_tokens >= 0) {
      usage = { prompt_tokens: raw.prompt_tokens, completion_tokens: raw.completion_tokens };
    } else {
      complete = false;
    }
  }
  return { ...captured, complete, response: { content, finish_reason, usage } };
}

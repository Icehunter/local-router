import { appendFileSync } from "node:fs";
import type { Config } from "./config.js";
import type { ChatMessage } from "./prompt.js";

const TRUNCATE_BYTES = 8192;

function truncate(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= TRUNCATE_BYTES) return text;
  return text.slice(0, TRUNCATE_BYTES) + "...[truncated]";
}

function writeDebugLog(
  config: Config,
  entry: {
    request: { url: string; model: string; messages: unknown[] };
    response: { ok: true; content: string } | { ok: false; error: string };
  },
): void {
  if (!config.debugLogPath) return;
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    request: {
      ...entry.request,
      messages: entry.request.messages.map((m) => {
        const msg = m as { role?: string; content?: string };
        return {
          role: msg.role,
          content: typeof msg.content === "string" ? truncate(msg.content) : msg.content,
        };
      }),
    },
    response:
      entry.response.ok
        ? { ok: true, content: truncate(entry.response.content) }
        : { ok: false, error: truncate(entry.response.error) },
  }) + "\n";
  try {
    appendFileSync(config.debugLogPath, line, "utf8");
  } catch {
    // Debug log failures must never break the actual call. Swallow.
  }
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "AbortError";
}

async function callQwenInner(
  messages: ChatMessage[],
  config: Config,
  url: string,
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.requestTimeoutMs,
  );

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          messages,
          max_tokens: config.maxTokens,
          temperature: config.temperature,
          top_p: config.topP,
          top_k: config.topK,
          min_p: config.minP,
          repeat_penalty: config.repeatPenalty,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(
          `Qwen request timed out after ${config.requestTimeoutMs}ms (url: ${url})`,
        );
      }
      throw new Error(
        `Cannot reach upstream at ${config.baseUrl}: ${(err as Error).message}`,
      );
    }

    if (!response.ok) {
      let body: string;
      try {
        body = await response.text();
      } catch (err) {
        if (isAbortError(err)) {
          throw new Error(
            `Qwen request timed out after ${config.requestTimeoutMs}ms (url: ${url})`,
          );
        }
        throw err;
      }
      throw new Error(
        `Upstream returned ${response.status}: ${body.slice(0, 500)}`,
      );
    }

    let json: { choices?: Array<{ message?: { content?: string } }> };
    try {
      json = (await response.json()) as typeof json;
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(
          `Qwen request timed out after ${config.requestTimeoutMs}ms (url: ${url})`,
        );
      }
      throw new Error(
        `Upstream at ${url} returned 200 but unparseable JSON: ${(err as Error).message}`,
      );
    }

    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(
        `Unexpected response from upstream (no choices[0].message.content): ${JSON.stringify(json).slice(0, 300)}`,
      );
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callQwen(
  messages: ChatMessage[],
  config: Config,
): Promise<string> {
  const url = `${config.baseUrl}/v1/chat/completions`;
  const requestSummary = { url, model: config.model, messages };
  try {
    const content = await callQwenInner(messages, config, url);
    writeDebugLog(config, { request: requestSummary, response: { ok: true, content } });
    return content;
  } catch (err) {
    writeDebugLog(config, {
      request: requestSummary,
      response: { ok: false, error: (err as Error).message },
    });
    throw err;
  }
}

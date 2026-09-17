import { appendFileSync, chmodSync, existsSync, statSync } from "node:fs";
import type { Config } from "./config.js";
import type { ChatMessage } from "./prompt.js";

const TRUNCATE_BYTES = 8192;

let debugLogWarnedOnce = false;

export interface LocalModelResult {
  content: string;
  /** Upstream `finish_reason`; "length" means the generation hit max_tokens. */
  finishReason: string | null;
}

function truncate(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= TRUNCATE_BYTES) return text;
  // Back off to a codepoint boundary; cutting inside a multi-byte sequence
  // decodes as U+FFFD and corrupts the last character in the log.
  let end = TRUNCATE_BYTES;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.toString("utf8", 0, end) + "...[truncated]";
}

function writeDebugLog(
  config: Config,
  entry: {
    request: { url: string; model: string; messages: unknown[] };
    response:
      | { ok: true; content: string; finishReason: string | null }
      | { ok: false; error: string };
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
        ? {
            ok: true,
            finishReason: entry.response.finishReason,
            content: truncate(entry.response.content),
          }
        : { ok: false, error: truncate(entry.response.error) },
  }) + "\n";
  try {
    // 0600: the log holds full prompt bodies, which routinely include source code.
    // `mode` only applies when appendFileSync creates the file, so an existing
    // world-readable log would keep its permissions forever without the chmod.
    const existed = existsSync(config.debugLogPath);
    appendFileSync(config.debugLogPath, line, { encoding: "utf8", mode: 0o600 });
    if (existed && (statSync(config.debugLogPath).mode & 0o077) !== 0) {
      chmodSync(config.debugLogPath, 0o600);
    }
    // Re-arm: a later failure after a working stretch is new information.
    debugLogWarnedOnce = false;
  } catch (err) {
    if (!debugLogWarnedOnce) {
      debugLogWarnedOnce = true;
      process.stderr.write(`[local-router] debug log write failed (${config.debugLogPath}): ${(err as Error).message}\n`);
    }
  }
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "AbortError";
}

async function callLocalModelInner(
  messages: ChatMessage[],
  config: Config,
  url: string,
  externalSignal?: AbortSignal,
): Promise<LocalModelResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  // Bail before building or dispatching anything: relying on fetch to reject an
  // already-aborted signal leaves the outcome up to the runtime.
  if (externalSignal?.aborted) {
    throw new Error("Local model request cancelled by the caller");
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.requestTimeoutMs,
  );
  // Without this the caller cancelling a tool call left the upstream generating
  // to completion, holding a slot and burning GPU for a result nobody reads.
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    let response: Response;
    try {
      const body: Record<string, unknown> = {
        model: config.model,
        messages,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        top_p: config.topP,
        top_k: config.topK,
        min_p: config.minP,
        repeat_penalty: config.repeatPenalty,
      };
      // Omitted entirely when null: backends that do not understand
      // chat_template_kwargs should not have to ignore it.
      if (config.enableThinking !== null) {
        body.chat_template_kwargs = { enable_thinking: config.enableThinking };
      }
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        if (externalSignal?.aborted) {
          throw new Error("Local model request cancelled by the caller");
        }
        throw new Error(
          `Local model request timed out after ${config.requestTimeoutMs}ms (url: ${url})`,
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
            `Local model request timed out after ${config.requestTimeoutMs}ms (url: ${url})`,
          );
        }
        // Re-throwing raw here lost the status and the plugin attribution, so a
        // 503 with a dropped connection surfaced as a bare "socket hang up".
        throw new Error(
          `Upstream returned ${response.status} and the body could not be read: ${(err as Error).message} (url: ${url})`,
        );
      }
      throw new Error(
        `Upstream returned ${response.status}: ${body.slice(0, 500)}`,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      if (isAbortError(err)) {
        throw new Error(
          `Local model request timed out after ${config.requestTimeoutMs}ms (url: ${url})`,
        );
      }
      throw new Error(
        `Upstream at ${url} returned 200 but unparseable JSON: ${(err as Error).message}`,
      );
    }

    if (json === null || typeof json !== "object") {
      throw new Error(
        `Upstream at ${url} returned 200 but a non-object body: ${JSON.stringify(json).slice(0, 300)}`,
      );
    }

    const choice = (json as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    }).choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string") {
      throw new Error(
        `Unexpected response from upstream (no choices[0].message.content): ${JSON.stringify(json).slice(0, 300)}`,
      );
    }
    if (content.trim() === "") {
      if (choice?.finish_reason === "length") {
        throw new Error(
          `Upstream stopped at max_tokens (${config.maxTokens}) before producing any output. ` +
            `For a reasoning model the whole budget went to reasoning_content: raise maxTokens, ` +
            `or set enableThinking false.`,
        );
      }
      throw new Error(
        `Upstream returned an empty completion (finish_reason: ${String(choice?.finish_reason ?? "none")}). ` +
          `The model produced no output; retry or reduce the prompt.`,
      );
    }
    return {
      content,
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    };
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

export async function callLocalModel(
  messages: ChatMessage[],
  config: Config,
  signal?: AbortSignal,
): Promise<LocalModelResult> {
  const url = `${config.baseUrl}/v1/chat/completions`;
  const requestSummary = { url, model: config.model, messages };
  try {
    const result = await callLocalModelInner(messages, config, url, signal);
    writeDebugLog(config, {
      request: requestSummary,
      response: { ok: true, content: result.content, finishReason: result.finishReason },
    });
    return result;
  } catch (err) {
    writeDebugLog(config, {
      request: requestSummary,
      response: { ok: false, error: (err as Error).message },
    });
    throw err;
  }
}

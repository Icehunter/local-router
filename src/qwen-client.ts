import type { Config } from "./config.js";
import type { ChatMessage } from "./prompt.js";

const MAX_TOKENS = 16000;

export async function callQwen(
  messages: ChatMessage[],
  config: Config,
): Promise<string> {
  const url = `${config.baseUrl}/v1/chat/completions`;
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

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: MAX_TOKENS,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(
        `Qwen request timed out after ${config.requestTimeoutMs}ms (url: ${url})`,
      );
    }
    throw new Error(
      `Cannot reach upstream at ${config.baseUrl}: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Upstream returned ${response.status}: ${body.slice(0, 500)}`,
    );
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(
      `Unexpected response from upstream (no choices[0].message.content): ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return content;
}

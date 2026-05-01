import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const ConfigSchema = z.object({
  baseUrl: z
    .string()
    .url()
    .transform((u) => u.replace(/\/+$/, "")),
  model: z.string().min(1),
  apiKey: z.string().nullable().default(null),
  tokenBudget: z.number().int().positive().default(180000),
  requestTimeoutMs: z.number().int().positive().default(300000),
});

export type Config = z.infer<typeof ConfigSchema>;

interface RawConfig {
  baseUrl?: unknown;
  model?: unknown;
  apiKey?: unknown;
  tokenBudget?: unknown;
  requestTimeoutMs?: unknown;
}

function readConfigFile(): RawConfig {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return {};
  const path = join(root, "config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RawConfig;
  } catch (err) {
    throw new Error(
      `Failed to parse ${path}: ${(err as Error).message}`,
    );
  }
}

function applyEnvOverrides(raw: RawConfig): RawConfig {
  const out: RawConfig = { ...raw };
  if (process.env.QWEN_BASE_URL) out.baseUrl = process.env.QWEN_BASE_URL;
  if (process.env.QWEN_MODEL) out.model = process.env.QWEN_MODEL;
  if (process.env.QWEN_API_KEY) out.apiKey = process.env.QWEN_API_KEY;
  if (process.env.QWEN_TOKEN_BUDGET) {
    out.tokenBudget = Number(process.env.QWEN_TOKEN_BUDGET);
  }
  if (process.env.QWEN_REQUEST_TIMEOUT_MS) {
    out.requestTimeoutMs = Number(process.env.QWEN_REQUEST_TIMEOUT_MS);
  }
  return out;
}

export function loadConfig(): Config {
  const merged = applyEnvOverrides(readConfigFile());
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid Qwen plugin config:\n${issues}\n\n` +
        `Set baseUrl and model via config.json (\${CLAUDE_PLUGIN_ROOT}/config.json) or env vars QWEN_BASE_URL and QWEN_MODEL.`,
    );
  }
  return result.data;
}

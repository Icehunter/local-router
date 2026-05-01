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
  maxTokens: z.number().int().positive().default(16000),
  temperature: z.number().min(0).max(2).default(0.7),
  topP: z.number().min(0).max(1).default(0.8),
  topK: z.number().int().nonnegative().default(20),
  minP: z.number().min(0).max(1).default(0.05),
  repeatPenalty: z.number().min(0).max(2).default(1.1),
  debugLogPath: z.string().nullable().default(null),
});

export type Config = z.infer<typeof ConfigSchema>;

interface RawConfig {
  baseUrl?: unknown;
  model?: unknown;
  apiKey?: unknown;
  tokenBudget?: unknown;
  requestTimeoutMs?: unknown;
  maxTokens?: unknown;
  temperature?: unknown;
  topP?: unknown;
  topK?: unknown;
  minP?: unknown;
  repeatPenalty?: unknown;
  debugLogPath?: unknown;
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
  if (process.env.QWEN_TOKEN_BUDGET !== undefined) {
    const n = Number(process.env.QWEN_TOKEN_BUDGET);
    if (!Number.isFinite(n)) {
      throw new Error(
        `QWEN_TOKEN_BUDGET must be a number, got: "${process.env.QWEN_TOKEN_BUDGET}"`,
      );
    }
    out.tokenBudget = n;
  }
  if (process.env.QWEN_REQUEST_TIMEOUT_MS !== undefined) {
    const n = Number(process.env.QWEN_REQUEST_TIMEOUT_MS);
    if (!Number.isFinite(n)) {
      throw new Error(
        `QWEN_REQUEST_TIMEOUT_MS must be a number, got: "${process.env.QWEN_REQUEST_TIMEOUT_MS}"`,
      );
    }
    out.requestTimeoutMs = n;
  }
  if (process.env.QWEN_MAX_TOKENS !== undefined) {
    const raw = process.env.QWEN_MAX_TOKENS;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(`QWEN_MAX_TOKENS must be a number, got: "${raw}"`);
    }
    out.maxTokens = n;
  }
  if (process.env.QWEN_TEMPERATURE !== undefined) {
    const n = Number(process.env.QWEN_TEMPERATURE);
    if (!Number.isFinite(n)) {
      throw new Error(
        `QWEN_TEMPERATURE must be a number, got: "${process.env.QWEN_TEMPERATURE}"`,
      );
    }
    out.temperature = n;
  }
  if (process.env.QWEN_TOP_P !== undefined) {
    const n = Number(process.env.QWEN_TOP_P);
    if (!Number.isFinite(n)) {
      throw new Error(
        `QWEN_TOP_P must be a number, got: "${process.env.QWEN_TOP_P}"`,
      );
    }
    out.topP = n;
  }
  if (process.env.QWEN_TOP_K !== undefined) {
    const n = Number(process.env.QWEN_TOP_K);
    if (!Number.isFinite(n)) {
      throw new Error(
        `QWEN_TOP_K must be a number, got: "${process.env.QWEN_TOP_K}"`,
      );
    }
    out.topK = n;
  }
  if (process.env.QWEN_MIN_P !== undefined) {
    const n = Number(process.env.QWEN_MIN_P);
    if (!Number.isFinite(n)) {
      throw new Error(
        `QWEN_MIN_P must be a number, got: "${process.env.QWEN_MIN_P}"`,
      );
    }
    out.minP = n;
  }
  if (process.env.QWEN_REPEAT_PENALTY !== undefined) {
    const raw = process.env.QWEN_REPEAT_PENALTY;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(`QWEN_REPEAT_PENALTY must be a number, got: "${raw}"`);
    }
    out.repeatPenalty = n;
  }
  if (process.env.QWEN_DEBUG_LOG_PATH !== undefined) {
    out.debugLogPath = process.env.QWEN_DEBUG_LOG_PATH;
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

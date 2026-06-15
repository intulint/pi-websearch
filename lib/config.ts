/**
 * Configuration module — .env loading, model resolution, env provider setup.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ============================================================================
// Module-level state
// ============================================================================

export let EXTENSION_DIR = "";
export let cachedEnvUrl = "";
export let cachedEnvModel = "";
export let cachedEnvApiKey = "";

export let detectedModelId = "";
export let detectedBaseUrl = "";
export let detectedApiKey = "";

// ============================================================================
// Env loader
// ============================================================================

export function initConfig(extDir: string): void {
  EXTENSION_DIR = extDir;
}

interface EnvConfig {
  url: string;
  model: string;
  apiKey: string;
}

function getEnvConfig(): EnvConfig {
  return {
    url: process.env.LLM_URL || "",
    model: process.env.LLM_MODEL || "",
    apiKey: process.env.LLM_API_KEY || "",
  };
}

export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !process.env[key]) process.env[key] = value;
    }
  } catch {
    /* ignore */
  }
}

export function ensureEnvLoaded(): void {
  loadEnvFile(join(EXTENSION_DIR, ".env"));
  const env = getEnvConfig();
  cachedEnvUrl = env.url;
  cachedEnvModel = env.model;
  cachedEnvApiKey = env.apiKey;
}

// ============================================================================
// Model resolution
// ============================================================================

export function resolveModel(): { url: string; model: string; apiKey?: string } | null {
  ensureEnvLoaded();
  if (cachedEnvUrl && cachedEnvModel) {
    return { url: cachedEnvUrl, model: cachedEnvModel, apiKey: cachedEnvApiKey || undefined };
  }
  if (detectedModelId && detectedBaseUrl) {
    return { url: detectedBaseUrl, model: detectedModelId, apiKey: detectedApiKey || undefined };
  }
  return null;
}

export function buildChatUrl(baseUrl: string): string {
  const url = baseUrl.trim();
  // Already has the full path
  if (url.endsWith("/v1/chat/completions")) return url;
  // Has base like "/v1" — append /chat/completions
  if (url.endsWith("/v1")) return `${url}/chat/completions`;
  // Default: assume "/v1" base
  return `${url}/v1/chat/completions`;
}

export function resolveModelFromPi(
  source: { id?: string; provider?: string; baseUrl?: string } | undefined,
  registry: unknown,
): void {
  if (!source?.id) return;

  detectedModelId = source.id;
  const baseUrl = source.baseUrl || "";
  if (baseUrl) {
    detectedBaseUrl = baseUrl;
  } else if (registry && typeof registry === "object" && "find" in registry) {
    const findFn = (registry as { find: (provider: string, id: string) => unknown }).find;
    const found = findFn(source.provider ?? "", source.id);
    if (found && typeof found === "object" && found !== null) {
      detectedBaseUrl = (found as { baseUrl?: string }).baseUrl ?? "";
      detectedApiKey = (found as { apiKey?: string }).apiKey ?? "";
    }
  }
}

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

let detectedModelId = "";
let detectedBaseUrl = "";
let detectedApiKey = "";

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

export function resolveModel(): { url: string; model: string; apiKey?: string; source: "env" | "pi" } | null {
  ensureEnvLoaded();
  if (cachedEnvUrl && cachedEnvModel) {
    return { url: cachedEnvUrl, model: cachedEnvModel, apiKey: cachedEnvApiKey || undefined, source: "env" };
  }
  const pi = getPiModelConfig();
  if (pi) return { ...pi, source: "pi" };
  return null;
}

/**
 * Get only the Pi-detected model config (never .env).
 * Used as fallback when .env model is unreachable.
 */
export function getPiModelConfig(): { url: string; model: string; apiKey?: string } | null {
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

export function updateDetectedModel(id: string, baseUrl?: string, apiKey?: string): void {
  detectedModelId = id;
  detectedBaseUrl = baseUrl ?? "";
  detectedApiKey = apiKey ?? "";
}

export async function resolveModelFromPi(
  source: { id?: string; provider?: string; baseUrl?: string } | undefined,
  registry: unknown,
): Promise<void> {
  if (!source?.id) return;

  // New model → reset previously detected values so stale data from the
  // previous model never leaks through (different baseUrl / apiKey).
  detectedModelId = source.id;
  detectedBaseUrl = "";
  detectedApiKey = "";

  const baseUrl = source.baseUrl || "";
  if (baseUrl) {
    detectedBaseUrl = baseUrl;
  }

  // Get baseUrl + apiKey from registry (apiKey is async via getApiKeyAndHeaders)
  const provider = source.provider ?? "";
  if (registry && typeof registry === "object" && "find" in registry && "getApiKeyAndHeaders" in registry && provider) {
    try {
      const r = registry as {
        find: (p: string, id: string) => unknown;
        getApiKeyAndHeaders: (m: unknown) => Promise<{ ok: boolean; apiKey?: string }>;
      };
      const found = r.find(provider, source.id);
      if (found && typeof found === "object" && found !== null) {
        const model = found as { baseUrl?: string };
        if (!detectedBaseUrl) {
          detectedBaseUrl = model.baseUrl ?? "";
        }
        // Always fetch the key fresh — a model without a key must clear it,
        // not keep the previous model's key.
        const auth = await r.getApiKeyAndHeaders(found);
        if (auth.ok && auth.apiKey) {
          detectedApiKey = auth.apiKey;
        }
      }
    } catch {
      // registry.find/getApiKeyAndHeaders may throw — ignore silently
    }
  }
}

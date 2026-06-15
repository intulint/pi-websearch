/**
 * pi-websearch — Web search and structured content extraction tools for Pi.
 *
 * Tools:
 *   - get_current_date — Returns current date in ISO format
 *   - search_web       — Web search via DuckDuckGo HTML scraping
 *   - extract          — Fetches URLs, extracts readable content via local LLM
 *
 * Model selection (priority):
 *   1. .env (LLM_URL + LLM_MODEL) — explicit override
 *   2. Pi's currently active model (auto-detected)
 *
 * Install deps: npm install && npx playwright install chromium
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { join, dirname } from "path";

// ── Modules ──────────────────────────────────────────────────────────────────

import {
  initConfig,
  resolveModelFromPi,
  updateDetectedModel,
  cachedEnvUrl,
  cachedEnvModel,
  cachedEnvApiKey,
} from "./lib/config.js";
import { searchDdg } from "./lib/search.js";
import { extractContent } from "./lib/extract.js";
import { logToolCall, flushLogs } from "./lib/logger.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface ExtModel {
  id: string;
  provider: string;
  baseUrl?: string;
}

interface ExtModelRegistryEntry {
  id: string;
  name: string;
  input?: string[];
  contextWindow?: number;
  baseUrl?: string;
  apiKey?: string;
}

interface ExtProviderConfig {
  name: string;
  baseUrl: string;
  api: string;
  models: ExtModelRegistryEntry[];
  apiKey?: string;
}

// ── Initialization ───────────────────────────────────────────────────────────

const EXTENSION_DIR = dirname(new URL(import.meta.url).pathname);
initConfig(EXTENSION_DIR);

// ── Module state ─────────────────────────────────────────────────────────────

let _piRef: ExtensionAPI | undefined;
let _envProviderRegistered = false;
let _extractAllowed = true; // batch restriction: one extract per turn

// ============================================================================
// Pi extension
// ============================================================================

export default function piWebsearch(pi: ExtensionAPI): void {
  _piRef = pi;

  // --- Model events ---

  pi.on("session_start", async (_event, ctx) => {
    resolveModelFromPi(ctx.model, ctx.modelRegistry);

    // Register env provider once per session
    if (cachedEnvUrl && cachedEnvModel) {
      const safeId = cachedEnvModel.replace(/[/:]/g, "-");
      const providerName = "env-overridden";

      const providerConfig: ExtProviderConfig = {
        name: "Env Overridden",
        baseUrl: cachedEnvUrl,
        api: "openai-completions",
        models: [
          {
            id: safeId,
            name: cachedEnvModel,
            input: ["text"],
            contextWindow: 131072,
          },
        ],
      };
      if (cachedEnvApiKey) {
        providerConfig.apiKey = cachedEnvApiKey;
      }
      // Always register/overwrite env provider so the latest .env is active
      pi.registerProvider(providerName, providerConfig as any);
      _envProviderRegistered = true;
    }
  });

  pi.on("session_shutdown", () => {
    // Clean up env provider and reset for next session
    if (_envProviderRegistered) {
      pi.unregisterProvider("env-overridden");
      _envProviderRegistered = false;
    }
    flushLogs();
  });

  pi.on("model_select", (event, _ctx) => {
    const m = event.model as ExtModel | undefined;
    if (m?.id) {
      updateDetectedModel(m.id, m.baseUrl);
    }
  });

  pi.on("turn_start", () => {
    _extractAllowed = true;
  });

  // --- Tool: get_current_date ---

  pi.registerTool({
    name: "get_current_date",
    label: "Current Date",
    description:
      "Get the current date in ISO format (YYYY-MM-DD) with day of week.",
    promptSnippet: "Get the current date (YYYY-MM-DD with day of week)",
    promptGuidelines: [
      "Use get_current_date when you need to know today's date or day of week.",
    ],
    parameters: Type.Object({}) as any,
    async execute() {
      const now = new Date();
      const isoDate = now.toISOString().split("T")[0];
      const dayNames = [
        "Sunday", "Monday", "Tuesday", "Wednesday",
        "Thursday", "Friday", "Saturday",
      ];
      return {
        content: [{ type: "text", text: `${isoDate} (${dayNames[now.getUTCDay()]})` }],
        details: {},
      };
    },
  });

  // --- Tool: search_web ---

  pi.registerTool({
    name: "search_web",
    label: "Web Search",
    description:
      "Search the web for a query. Returns titles, URLs, and snippet descriptions. Uses DuckDuckGo HTML scraping. WARNING: Do NOT call this tool multiple times in a row — rate limits apply. Wait between calls.",
    promptSnippet: "Search the web via DuckDuckGo (titles, URLs, descriptions)",
    promptGuidelines: [
      "Use search_web to find current information, documentation, or web pages before using extract.",
      "Do NOT call search_web multiple times in a row — DuckDuckGo rate limits apply. Wait at least a few seconds between calls.",
      "Start with a specific query; if results are poor, refine and retry with different terms.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(
        Type.Number({ description: "Maximum number of results (default: 10)" }),
      ),
    }) as any,
    async execute(_toolCallId, params: { query: string; limit?: number }, signal, _onUpdate, _ctx) {
      const limit = params.limit ?? 10;
      const data = await searchDdg(params.query, limit, signal);
      const result = JSON.stringify(data, null, 2);
      logToolCall("search_web", { query: params.query, limit, provider: "ddg" }, result);
      return { content: [{ type: "text", text: result }], details: {} };
    },
  });

  // --- Tool: extract ---

  pi.registerTool({
    name: "extract",
    label: "Extract Content",
    description:
      "Extract structured data from one or more URLs. Fetches pages (with optional Playwright browser mode), extracts readable content, then sends to local LLM for structured extraction. Use search_web first to find URLs.",
    promptSnippet: "Fetch URLs and extract structured data via local LLM",
    promptGuidelines: [
      "Use extract to fetch and parse web page content. Always use search_web first to find relevant URLs.",
      "Use extract with a clear prompt describing exactly what data to extract. At least one of prompt or schema is required.",
      "Only ONE extract call is allowed per batch — combine multiple URLs into a single extract call instead.",
      "Set useBrowser: true (default) for JavaScript-heavy sites; false for simple/static pages.",
      "If extract returns an empty result, it will explain why (login wall, blocked content, etc.) — do not retry blindly.",
    ],
    parameters: Type.Object({
      urls: Type.Array(Type.String(), { description: "URLs to extract from" }),
      prompt: Type.Optional(
        Type.String({ description: "What data to extract from the page content" }),
      ),
      schema: Type.Optional(Type.Unknown()),
      useBrowser: Type.Optional(
        Type.Boolean({
          description: "Use Playwright browser for JS-heavy sites (default: true)",
        }),
      ),
    }) as any,
    async execute(_toolCallId, params: {
      urls: string[];
      prompt?: string;
      schema?: unknown;
      useBrowser?: boolean;
    }, signal, _onUpdate, _ctx) {
      if (!_extractAllowed) {
        return {
          content: [
            {
              type: "text",
              text: "Extract tool is already running in this batch. Only one extract call is allowed per batch.",
            },
          ],
          details: {},
        };
      }
      _extractAllowed = false;

      // Capture original model info for restoration after tool execution
      const originalProvider = _ctx.model?.provider;
      const originalId = _ctx.model?.id;
      const origModel =
        (originalProvider && originalId
          ? _ctx.modelRegistry?.find(originalProvider, originalId)
          : undefined) as ExtModelRegistryEntry | undefined;

      try {
        // Switch to .env model for the LLM call (if .env is configured)
        if (_piRef && cachedEnvUrl && cachedEnvModel) {
          const safeId = cachedEnvModel.replace(/[/:]/g, "-");
          const envModel = _ctx.modelRegistry?.find("env-overridden", safeId);
          if (envModel) {
            await _piRef.setModel(envModel as any);
          }
        }

        try {
          const result = await extractContent(
            params.urls,
            params.prompt ?? null,
            params.schema ?? null,
            params.useBrowser !== false,
            signal,
          );
          return { content: [{ type: "text", text: result }], details: {} };
        } finally {
          // Restore original Pi model after tool execution
          if (_piRef && originalProvider && originalId && origModel) {
            await _piRef.setModel(origModel as any);
          }
        }
      } catch (e) {
        _extractAllowed = true; // Reset on error so next turn can retry
        throw e;
      }
    },
  });
}

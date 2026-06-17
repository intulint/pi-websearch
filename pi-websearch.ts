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
import { Text } from "@mariozechner/pi-tui";

// ── Modules ──────────────────────────────────────────────────────────────────

import {
  initConfig,
  resolveModelFromPi,
  updateDetectedModel,
  cachedEnvUrl,
  cachedEnvModel,
  cachedEnvApiKey,
} from "./lib/config.js";
import { searchDdg, type SearchResult } from "./lib/search.js";
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
    promptSnippet: "Search the web to find relevant URLs and preview snippets — use before extract to discover pages",
    promptGuidelines: [
      "Use search_web when you need to find information on the web — news, documentation, forum posts, product pages, etc.",
      "Search_web returns titles, URLs, and short descriptions — use it to discover pages, then use extract to read the full content.",
      "Use specific, targeted queries — include key terms, product names, or topics to get relevant results.",
      "If results are poor, refine your query with different keywords or more specific terms before trying again.",
      "Wait at least a few seconds between search_web calls — DuckDuckGo rate limits frequent requests.",
      "Use the limit parameter (default 10) to get fewer or more results — set lower when you only need top matches.",
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
      return { content: [{ type: "text", text: result }], details: { results: data } };
    },
    renderCall(args, theme, _context) {
      const query = args.query.length > 80 ? `${args.query.slice(0, 77)}...` : args.query;
      let text = theme.fg("toolTitle", theme.bold("search_web "));
      text += theme.fg("accent", query);
      if (args.limit !== undefined) {
        text += theme.fg("dim", ` (limit: ${args.limit})`);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as { results?: SearchResult[] } | undefined;
      const results = details?.results;

      if (!results || results.length === 0) {
        const content = result.content[0];
        if (content?.type === "text") {
          return new Text(theme.fg("error", content.text), 0, 0);
        }
        return new Text(theme.fg("error", "No results"), 0, 0);
      }

      let text = theme.fg("success", `${results.length} result${results.length > 1 ? "s" : ""}`);

      if (expanded) {
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          text += `\n${theme.fg("accent", `[${i + 1}] ${r.title}`)}\n`;
          text += `    ${theme.fg("dim", r.url)}\n`;
          text += `    ${theme.fg("toolOutput", r.description)}\n`;
        }
      }

      return new Text(text, 0, 0);
    },
  });

  // --- Tool: extract ---

  function shortenUrl(url: string): string {
    try {
      const u = new URL(url);
      const path = u.pathname.length > 50 ? u.pathname.slice(0, 47) + "..." : u.pathname;
      return `${u.hostname}${path}`;
    } catch {
      return url.length > 60 ? url.slice(0, 57) + "..." : url;
    }
  }

  pi.registerTool({
    name: "extract",
    label: "Extract Content",
    description:
      "Extract structured data from one or more URLs. Fetches pages (with optional Playwright browser mode), extracts readable content, then sends to local LLM for structured extraction. Use search_web first to find URLs.",
    promptSnippet: "Fetch a URL and ask the LLM to extract specific structured data from the page content",
    promptGuidelines: [
      "Use extract to read a webpage and get specific information from it — prices, articles, tables, profiles, API docs, documentation, etc.",
      "Always use search_web first to find URLs, then extract to get the actual content from those URLs.",
      "Provide a clear prompt describing what data to extract — be specific about what fields or information you need from the page.",
      "Use schema when you need structured JSON output — describe the shape of data you want (e.g. array of products with name, price, description).",
      "Only ONE extract call per batch — combine multiple URLs into a single call to save time.",
      "Set useBrowser: false for simple pages (HTML docs, blogs); keep true (default) for JS-heavy sites (SPAs, dashboards).",
      "If extract fails or returns empty, read the error — it may be a login wall, blocked page, or the content didn't contain the requested data.",
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
          return { content: [{ type: "text", text: result }], details: { urls: params.urls, prompt: params.prompt, schema: params.schema } };
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
    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("extract "));
      const urlList = args.urls.map((u: string) => shortenUrl(u));
      text += theme.fg("accent", urlList.join(", "));
      if (args.prompt) {
        const p = args.prompt.length > 60 ? `${args.prompt.slice(0, 57)}...` : args.prompt;
        text += `\n${theme.fg("dim", `prompt: ${p}`)}`;
      }
      if (args.schema) {
        text += `\n${theme.fg("dim", "[schema extraction]")}`;
      }
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as { urls?: string[]; prompt?: string } | undefined;

      if (result.content.some((c) => c.type === "text" && c.text.startsWith("Extract tool is already running"))) {
        return new Text(theme.fg("warning", "Extract already running in this batch"), 0, 0);
      }

      const content = result.content[0];
      const textContent = content?.type === "text" ? content.text : "";

      if (!textContent) {
        return new Text(theme.fg("error", "No content"), 0, 0);
      }

      let text = theme.fg("success", `Extracted`);
      if (details?.urls) {
        text += ` from ${details.urls.length} url${details.urls.length > 1 ? "s" : ""}`;
      }

      if (expanded) {
        // Show prompt if available
        if (details?.prompt) {
          const p = details.prompt.length > 80 ? `${details.prompt.slice(0, 77)}...` : details.prompt;
          text += `\n${theme.fg("dim", `prompt: ${p}`)}`;
        }
        // Show URLs
        if (details?.urls) {
          for (const url of details.urls) {
            text += `\n${theme.fg("dim", shortenUrl(url))}`;
          }
        }
        // Show extracted content
        text += `\n${theme.fg("toolOutput", textContent)}`;
      }

      return new Text(text, 0, 0);
    },
  });
}

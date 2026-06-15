/**
 * Content extraction — fetch pages (HTTP + Playwright), clean, LLM extraction.
 */

import { httpGet, httpPostJson, type RequestOptions } from "./http.js";
import { resolveModel, buildChatUrl } from "./config.js";
import { logToolCall } from "./logger.js";

// ============================================================================
// Constants
// ============================================================================

const FETCH_TIMEOUT_MS = 60_000;
const LLM_TIMEOUT_MS = 600_000;
const PLAYWRIGHT_GENERAL_TIMEOUT_MS = 90_000;
const MAX_CONTENT_CHARS = 12_000;
const MIN_TEXT_LENGTH_BEFORE_FALLBACK = 50;

// ============================================================================
// Content processing
// ============================================================================

export function htmlToClean(html: string): string {
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/[^\S\n]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim() : "";
}

// ============================================================================
// Browser-based page fetch (Playwright)
// ============================================================================

function getProxyConfig(): { server: string; bypass?: string } | undefined {
  const proxyUrl =
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.ALL_PROXY;

  if (!proxyUrl) return undefined;

  const noProxy = process.env.NO_PROXY
    ? process.env.NO_PROXY.split(",").map((s) => s.trim()).join(",")
    : undefined;

  return { server: proxyUrl, bypass: noProxy };
}

async function fetchPageWithBrowser(
  url: string,
  timeoutMs = FETCH_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<{ title: string; text: string; error?: string }> {
  let browser: import("playwright").Browser | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const { chromium: playwrightChromium } = await import("playwright");
    const proxyConfig = getProxyConfig();

    browser = await playwrightChromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      proxy: proxyConfig,
    });

    // Wire abort signal to close browser
    onAbort = () => { browser?.close().catch(() => {}); };
    if (onAbort) {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    if (signal?.aborted) {
      await browser.close().catch(() => {});
      return { title: url, text: "", error: "Aborted" };
    }

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(PLAYWRIGHT_GENERAL_TIMEOUT_MS);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(2000);

    const title = (await page.title()) || url;
    const text = await page.evaluate(() => {
      document
        .querySelectorAll("script, style, nav, footer, header, aside")
        .forEach((el) => el.remove());
      return (document.body?.innerText || "")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[^\S\n]+/g, " ")
        .trim();
    });

    return { title, text: text || "" };
  } catch (e) {
    return { title: url, text: "", error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (browser) await browser.close().catch(() => {});
  }
}

// ============================================================================
// HTTP-based page fetch (fallback for simple pages)
// ============================================================================

export async function fetchPage(
  url: string,
  useBrowser: boolean,
  signal?: AbortSignal,
): Promise<{ title: string; text: string; error?: string }> {
  if (useBrowser) return fetchPageWithBrowser(url, FETCH_TIMEOUT_MS, signal);

  try {
    const html = await httpGet(url, { timeoutMs: FETCH_TIMEOUT_MS, signal });
    const title = extractTitle(html) || url;
    let text = htmlToClean(html);
    if (text.length < MIN_TEXT_LENGTH_BEFORE_FALLBACK) {
      text = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, "\n")
        .trim();
    }
    return { title, text };
  } catch (e) {
    return {
      title: url,
      text: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ============================================================================
// LLM extraction
// ============================================================================

const EXTRACTION_SYSTEM_PROMPT = [
  "You are a data extraction assistant.",
  "Extract the requested information from the provided web page content.",
  "Be precise and only return the extracted data.",
  "Be as detailed as possible without including extra information.",
  "NEVER return an empty result.",
  "If you cannot find the requested data, you MUST explain why — e.g. the page didn't contain it, the content was blocked, the page was a login wall, etc.",
].join("\n");

export async function llmExtract(
  content: string,
  prompt: string | null,
  schema: unknown | null,
  signal?: AbortSignal,
): Promise<string> {
  let systemMsg = EXTRACTION_SYSTEM_PROMPT;

  if (schema) {
    systemMsg += `\n\nReturn the data as JSON matching this schema:\n${JSON.stringify(schema, null, 2)}`;
  }

  const userContent = prompt
    ? `${content}\n\n---\nExtraction request: ${prompt}`
    : content;

  const llmConfig = resolveModel();
  if (!llmConfig) {
    throw new Error(
      "No LLM configuration found.\n" +
      "Set LLM_URL and LLM_MODEL in .env, or switch to a model in pi.",
    );
  }

  const chatUrl = buildChatUrl(llmConfig.url);

  const requestOptions: RequestOptions = {
    timeoutMs: LLM_TIMEOUT_MS,
    signal,
  };
  if (llmConfig.apiKey) {
    requestOptions.headers = { Authorization: `Bearer ${llmConfig.apiKey}` };
  }

  const response = await httpPostJson(
    chatUrl,
    {
      model: llmConfig.model,
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: userContent },
      ],
      temperature: 0.1,
      stream: false,
    },
    requestOptions,
  );

  const data = response as Record<string, unknown>;
  // Cline API wraps response in { data: { choices: [...] } }, others use { choices: [...] }
  const inner = ((data as Record<string, unknown>).data as Record<string, unknown>) ?? data;
  const choices = (inner as Record<string, unknown>).choices as Array<Record<string, unknown>> | undefined;
  const contentBlocks = choices?.[0]?.message as
    | { content?: string }
    | undefined;

  if (!contentBlocks?.content) {
    throw new Error("No content in LLM response");
  }
  return contentBlocks.content;
}

// ============================================================================
// Public extract entry point
// ============================================================================

export async function extractContent(
  urls: string[],
  prompt: string | null = null,
  schema: unknown | null = null,
  useBrowser: boolean = true,
  signal?: AbortSignal,
): Promise<string> {
  if (!prompt && !schema) {
    logToolCall("extract", { urls }, JSON.stringify({ error: "At least one of prompt or schema is required." }));
    throw new Error("At least one of prompt or schema is required.");
  }

  const parts: string[] = [];
  for (const url of urls) {
    if (signal?.aborted) throw new Error("Extraction aborted");
    const result = await fetchPage(url, useBrowser, signal);
    if (result.error) {
      throw new Error(
        `Failed to fetch "${url}": ${result.error}`,
      );
    }
    let text = result.text;
    if (text.length > MAX_CONTENT_CHARS) {
      text = text.slice(0, MAX_CONTENT_CHARS) + "\n... [truncated]";
    }
    parts.push(`=== ${url} ===\n${result.title}\n\n${text}`);
  }

  const combined = parts.join("\n\n");
  if (signal?.aborted) throw new Error("Extraction aborted");
  const result = await llmExtract(combined, prompt, schema, signal);
  logToolCall("extract", { urls, prompt, schema, useBrowser }, result);
  return result;
}

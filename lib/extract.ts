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
): Promise<{ title: string; text: string; error?: string }> {
  let browser;
  try {
    const { chromium: playwrightChromium } = await import("playwright");
    const proxyConfig = getProxyConfig();

    browser = await playwrightChromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      proxy: proxyConfig,
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

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
    if (browser) await browser.close().catch(() => {});
  }
}

// ============================================================================
// HTTP-based page fetch (fallback for simple pages)
// ============================================================================

export async function fetchPage(
  url: string,
  useBrowser: boolean,
): Promise<{ title: string; text: string; error?: string }> {
  if (useBrowser) return fetchPageWithBrowser(url);

  try {
    const html = await httpGet(url, { timeoutMs: FETCH_TIMEOUT_MS });
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
  const inner = (data as any)?.data ?? data;
  const choices = inner?.choices as Array<Record<string, unknown>> | undefined;
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
): Promise<string> {
  if (!prompt && !schema) {
    const err = JSON.stringify({ error: "At least one of prompt or schema is required." });
    logToolCall("extract", { urls }, err);
    return err;
  }

  const parts: string[] = [];
  for (const url of urls) {
    const result = await fetchPage(url, useBrowser);
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
  const result = await llmExtract(combined, prompt, schema);
  logToolCall("extract", { urls, prompt, schema, useBrowser }, result);
  return result;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseResults } = await jiti.import("../lib/search.ts");

function ddgBlock(
  title: string,
  href: string,
  snippet: string,
  extra?: string,
): string {
  return `<div class="result results_links results_links_deep web_result">${extra ?? ""}
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="${href}">${title}</a>
  </h2>
  <a class="result__snippet" href="${href}">${snippet}</a>
</div>`;
}

test("parseResults: extracts title, decoded url, description", () => {
  const html = ddgBlock(
    "Example <b>Title</b>",
    "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc",
    "Some description.",
  );
  const results = parseResults(html, 10);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Example Title");
  assert.equal(results[0].url, "https://example.com/page");
  assert.equal(results[0].description, "Some description.");
});

test("parseResults: multiple blocks, limit caps the count", () => {
  const blocks = Array.from({ length: 5 }, (_, i) =>
    ddgBlock(`Title ${i}`, `https://example.com/${i}`, `Desc ${i}`),
  ).join("\n");
  assert.equal(parseResults(blocks, 3).length, 3);
  assert.equal(parseResults(blocks, 10).length, 5);
});

test("parseResults: empty html returns empty array", () => {
  assert.deepEqual(parseResults("", 10), []);
  assert.deepEqual(parseResults("<html><body>no results</body></html>", 10), []);
});

test("parseResults: blocks without a title or url are skipped", () => {
  const noTitle = `<div class="result results_links web_result"><a class="result__a" href="https://example.com">x</a></div>`;
  const noUrl = `<div class="result results_links web_result"><h2><a class="result__a">no href</a></h2></div>`;
  const html = ddgBlock("Good", "https://example.com/good", "ok") + noTitle + noUrl;
  const results = parseResults(html, 10);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Good");
});

test("parseResults: zero/negative limit returns empty", () => {
  const html = ddgBlock("T", "https://example.com/1", "D");
  assert.deepEqual(parseResults(html, 0), []);
  assert.deepEqual(parseResults(html, -1), []);
});

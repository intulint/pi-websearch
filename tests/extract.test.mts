import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { htmlToClean, extractTitle } = await jiti.import("../lib/extract.ts");

test("htmlToClean: strips script and style blocks", () => {
  const html = `<html><head><style>body{color:red}</style></head><body>
    <script>alert('xss')</script>
    <p>Hello</p></body></html>`;
  const text = htmlToClean(html);
  assert.ok(!text.includes("alert"), "script content must be removed");
  assert.ok(!text.includes("color:red"), "style content must be removed");
  assert.ok(text.includes("Hello"), "visible text preserved");
});

test("htmlToClean: strips tags and collapses whitespace", () => {
  const html = `<div><h1>  Title  </h1>\n<p>Line one</p>   <p>Line two</p></div>`;
  const text = htmlToClean(html);
  // Tags become single spaces; horizontal whitespace runs are collapsed.
  assert.equal(text, "Title \n Line one Line two");
});

test("htmlToClean: no long whitespace runs", () => {
  const html = `<p>a</p>\n\n\n\n\n<p>b</p>`;
  const text = htmlToClean(html);
  assert.ok(!/\n{3,}/.test(text), "no 3+ consecutive newlines");
});

test("htmlToClean: empty input returns empty string", () => {
  assert.equal(htmlToClean(""), "");
  assert.equal(htmlToClean("<script>alert(1)</script>"), "");
});

test("extractTitle: finds <title> and trims", () => {
  assert.equal(extractTitle("<title>  My Page  </title><body>x</body>"), "My Page");
  assert.equal(extractTitle("<title>Plain</title>"), "Plain");
});

test("extractTitle: missing title returns empty string", () => {
  assert.equal(extractTitle("<html><body>no title</body></html>"), "");
  assert.equal(extractTitle(""), "");
});

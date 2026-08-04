import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildChatUrl } = await jiti.import("../lib/config.ts");

test("buildChatUrl: plain base gets /v1/chat/completions", () => {
  assert.equal(buildChatUrl("http://llm:8080"), "http://llm:8080/v1/chat/completions");
});

test("buildChatUrl: /v1 base keeps single /v1", () => {
  assert.equal(buildChatUrl("http://llm:8080/v1"), "http://llm:8080/v1/chat/completions");
});

test("buildChatUrl: trailing slashes are normalized (no double path)", () => {
  assert.equal(buildChatUrl("http://llm:8080/v1/"), "http://llm:8080/v1/chat/completions");
  assert.equal(buildChatUrl("http://llm:8080/v1///"), "http://llm:8080/v1/chat/completions");
});

test("buildChatUrl: full chat/completions URL passes through", () => {
  assert.equal(
    buildChatUrl("http://llm:8080/v1/chat/completions"),
    "http://llm:8080/v1/chat/completions",
  );
});

test("buildChatUrl: surrounding whitespace is trimmed", () => {
  assert.equal(buildChatUrl("  http://llm:8080/v1  "), "http://llm:8080/v1/chat/completions");
});

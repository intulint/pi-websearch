/**
 * Tool call logging — persistent JSON log in project root.
 * Debounced writes to reduce I/O frequency.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { EXTENSION_DIR } from "./config.js";

const TOOL_CALL_LOG_PATH = join(EXTENSION_DIR, "tool_calls.log.json");
const MAX_ENTRIES = 10;
const FLUSH_INTERVAL_MS = 3_000;
const MAX_BUFFER_SIZE = 5;

// ============================================================================
// Types
// ============================================================================

export interface ToolCallLogEntry {
  logged_at: string;
  tool: string;
  arguments: unknown;
  result: string;
}

// ============================================================================
// Debounce state
// ============================================================================

let buffer: ToolCallLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let initialLogs: ToolCallLogEntry[] | null = null; // lazy-loaded

function loadInitialLogs(): ToolCallLogEntry[] {
  if (initialLogs !== null) return initialLogs;

  initialLogs = [];
  if (existsSync(TOOL_CALL_LOG_PATH)) {
    try {
      const data = JSON.parse(readFileSync(TOOL_CALL_LOG_PATH, "utf-8"));
      if (Array.isArray(data)) {
        initialLogs = data.slice(-MAX_ENTRIES);
      }
    } catch {
      initialLogs = [];
    }
  }
  return initialLogs;
}

function flushBuffer(): void {
  if (buffer.length === 0) return;

  const allLogs = [...loadInitialLogs(), ...buffer];
  const trimmed = allLogs.slice(-MAX_ENTRIES);
  try {
    writeFileSync(TOOL_CALL_LOG_PATH, JSON.stringify(trimmed, null, 2));
  } catch {
    /* ignore */
  }
  buffer = [];
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushBuffer();
    flushTimer = null;
  }, FLUSH_INTERVAL_MS);
}

// ============================================================================
// Public API
// ============================================================================

export function logToolCall(toolName: string, args: unknown, result: string): void {
  const entry: ToolCallLogEntry = {
    logged_at: new Date().toISOString(),
    tool: toolName,
    arguments: args,
    result,
  };

  buffer.push(entry);

  if (buffer.length >= MAX_BUFFER_SIZE) {
    if (flushTimer) clearTimeout(flushTimer);
    flushBuffer();
  } else {
    scheduleFlush();
  }
}

/** Explicitly flush all pending logs (call on extension shutdown). */
export function flushLogs(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  flushBuffer();
}

import type { EventSource } from "./types";

// ─── Command-based detection ─────────────────────────────────────────────────

const NEXT_CMD_RE = /\bnext\b/i;
const VITE_CMD_RE = /\bvite\b/i;

/**
 * Detect framework from the command string. Returns null if ambiguous.
 */
export function detectFramework(cmd: string): EventSource | null {
  if (NEXT_CMD_RE.test(cmd)) return "next";
  if (VITE_CMD_RE.test(cmd)) return "vite";
  return null;
}

// ─── Output-based detection ──────────────────────────────────────────────────

const NEXT_OUTPUT_PATTERNS: RegExp[] = [
  /Next\.js/i,
  /\bnext dev\b/i,
  /Compiled\s+\//,
];

const VITE_OUTPUT_PATTERNS: RegExp[] = [
  /\bVITE\b/,
  /\bvite\b/,
  /➜\s+Local:/,
];

/**
 * Classify a single line of output. Always returns a source — never null.
 * This is a pure/stateless function — no locking. For stateful detection
 * with locking, use createDetector().
 */
export function classifyOutput(line: string): EventSource {
  for (const re of NEXT_OUTPUT_PATTERNS) {
    if (re.test(line)) return "next";
  }
  for (const re of VITE_OUTPUT_PATTERNS) {
    if (re.test(line)) return "vite";
  }
  return "devserver";
}

/**
 * Create an isolated detector instance with its own lock state.
 * Once a framework is positively identified from output, the detector
 * locks in that source for subsequent ambiguous lines.
 */
export function createDetector() {
  let locked: EventSource | null = null;

  return {
    detectFramework,
    classifyOutput(line: string): EventSource {
      for (const re of NEXT_OUTPUT_PATTERNS) {
        if (re.test(line)) {
          locked = "next";
          return "next";
        }
      }
      for (const re of VITE_OUTPUT_PATTERNS) {
        if (re.test(line)) {
          locked = "vite";
          return "vite";
        }
      }
      if (locked) return locked;
      return "devserver";
    },
    get lockedSource(): EventSource | null {
      return locked;
    },
    setLocked(source: EventSource | null) {
      locked = source;
    },
  };
}

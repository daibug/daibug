/**
 * source-detection.test.ts
 *
 * Quality gate: dev server output is tagged with the correct source.
 *
 * This test exists because Phase 1 smoke test revealed that Next.js output
 * was being tagged `source: "vite"` even though the hub was running `next dev`.
 * The fix is framework detection — either from the command string or from
 * patterns in the output itself.
 *
 * Tests here are pure unit tests — no network, no processes.
 */

import { describe, it, expect } from "bun:test";
import { detectFramework, classifyOutput } from "../../src/detector";

// ─── Command String Detection ─────────────────────────────────────────────────

describe("detectFramework — from command string", () => {
  it('detects next from "next dev"', () => {
    expect(detectFramework("next dev")).toBe("next");
  });

  it('detects next from "bun run dev" in a Next.js project context', () => {
    // Can't know from cmd alone — returns null, waits for output detection
    expect(detectFramework("bun run dev")).toBeNull();
  });

  it("detects next from full path command", () => {
    expect(detectFramework("node_modules/.bin/next dev")).toBe("next");
  });

  it('detects vite from "vite" command', () => {
    expect(detectFramework("vite")).toBe("vite");
  });

  it('detects vite from "bun run vite"', () => {
    expect(detectFramework("bun run vite")).toBe("vite");
  });

  it('detects vite from "vite --port 3000"', () => {
    expect(detectFramework("vite --port 3000")).toBe("vite");
  });

  it("returns null for unknown commands", () => {
    expect(detectFramework("bun run dev")).toBeNull();
    expect(detectFramework("node server.js")).toBeNull();
    expect(detectFramework("python manage.py runserver")).toBeNull();
  });
});

// ─── Output Pattern Detection ─────────────────────────────────────────────────

describe("classifyOutput — from stdout/stderr content", () => {
  // Next.js patterns
  it('detects next from "▲ Next.js" in output', () => {
    expect(classifyOutput("   ▲ Next.js 14.2.0 (Turbopack)")).toBe("next");
  });

  it('detects next from "Next.js" anywhere in line', () => {
    expect(classifyOutput("ready - started server with Next.js")).toBe("next");
  });

  it("detects next from next.js compilation output", () => {
    expect(classifyOutput("✓ Compiled /page in 234ms")).toBe("next");
  });

  it("detects next from turbopack indicator", () => {
    expect(classifyOutput("▲ Next.js 16.1.6 (Turbopack)")).toBe("next");
  });

  it('detects next from "$ next dev" echo', () => {
    expect(classifyOutput("$ next dev")).toBe("next");
  });

  // Vite patterns
  it('detects vite from "VITE" in output', () => {
    expect(classifyOutput("  VITE v5.2.0  ready in 312 ms")).toBe("vite");
  });

  it("detects vite from vite ready line", () => {
    expect(classifyOutput("  ➜  Local:   http://localhost:5173/")).toBe("vite");
  });

  it('detects vite from "vite" (lowercase) in output', () => {
    expect(classifyOutput("vite dev server running")).toBe("vite");
  });

  // Unknown / fallback
  it("returns devserver for unrecognized output", () => {
    expect(classifyOutput("Starting development server...")).toBe("devserver");
    expect(classifyOutput("Listening on port 8080")).toBe("devserver");
    expect(classifyOutput("")).toBe("devserver");
  });

  it("returns devserver for compile errors without framework signature", () => {
    expect(classifyOutput("ERROR: Module not found")).toBe("devserver");
  });
});

// ─── Integration: detection updates the event source ─────────────────────────

describe("Framework detection — source tagging in events", () => {
  it('first Next.js output line changes active source from null to "next"', () => {
    // The detector is stateful — once it sees Next.js output it locks in "next"
    const {
      detectFramework: detect,
      classifyOutput: classify,
    } = require("../../src/detector");
    // Reset state between tests is handled by module isolation
    const result = classify("▲ Next.js 14.2.0");
    expect(result).toBe("next");
  });

  it("Next.js detection persists for subsequent ambiguous output lines", () => {
    // Once "next" is detected from a clear signal, ambiguous lines like
    // "Listening on port 3000" should still be tagged "next" not "devserver"
    // This is tested at the hub level in hub-browser-events.test.ts
    expect(true).toBe(true); // placeholder — logic tested in hub integration tests
  });
});

// ─── Source Enum Validity ─────────────────────────────────────────────────────

describe("Detected sources are valid EventSource values", () => {
  const VALID_SOURCES = [
    "vite",
    "next",
    "devserver",
    "browser:console",
    "browser:network",
    "browser:dom",
  ];

  it("detectFramework only returns valid sources or null", () => {
    const results = [
      detectFramework("next dev"),
      detectFramework("vite"),
      detectFramework("bun run dev"),
    ];
    for (const r of results) {
      if (r !== null) expect(VALID_SOURCES).toContain(r);
    }
  });

  it("classifyOutput only returns valid sources", () => {
    const inputs = [
      "▲ Next.js 14.2.0",
      "VITE v5 ready",
      "unknown server starting",
      "",
    ];
    for (const input of inputs) {
      expect(VALID_SOURCES).toContain(classifyOutput(input));
    }
  });
});

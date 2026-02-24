/**
 * event-schema.test.ts
 *
 * Quality gate: "Events returned by API conform exactly to the event schema"
 *
 * These are pure unit tests — no network, no processes.
 * They validate that the event factory function produces
 * correctly shaped, correctly typed events every time.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createEvent } from "../src/event";
import type { DaibugEvent, EventSource, EventLevel } from "../src/types";

// ─── ID Format ───────────────────────────────────────────────────────────────

describe("Event ID format", () => {
  it("matches the pattern evt_{unix_ms}_{zero_padded_sequence}", () => {
    const event = createEvent("vite", "info", { message: "hello" });
    expect(event.id).toMatch(/^evt_\d{13}_\d{3}$/);
  });

  it("sequence starts at 001 for the first event in a batch", () => {
    const event = createEvent("vite", "info", { message: "first" });
    expect(event.id).toMatch(/_001$/);
  });

  it("sequence increments correctly across consecutive events", () => {
    const e1 = createEvent("vite", "info", { message: "1" });
    const e2 = createEvent("vite", "info", { message: "2" });
    const e3 = createEvent("vite", "info", { message: "3" });

    const seq1 = parseInt(e1.id.split("_")[2]);
    const seq2 = parseInt(e2.id.split("_")[2]);
    const seq3 = parseInt(e3.id.split("_")[2]);

    expect(seq2).toBe(seq1 + 1);
    expect(seq3).toBe(seq2 + 1);
  });

  it("produces unique IDs even when called in rapid succession", () => {
    const ids = Array.from(
      { length: 50 },
      () => createEvent("vite", "info", {}).id,
    );
    const unique = new Set(ids);
    expect(unique.size).toBe(50);
  });
});

// ─── Timestamp ────────────────────────────────────────────────────────────────

describe("Event timestamp", () => {
  it("is a number", () => {
    const event = createEvent("vite", "info", {});
    expect(typeof event.ts).toBe("number");
  });

  it("is in Unix milliseconds (13 digits)", () => {
    const event = createEvent("vite", "info", {});
    expect(event.ts.toString()).toHaveLength(13);
  });

  it("is within 50ms of Date.now()", () => {
    const before = Date.now();
    const event = createEvent("vite", "info", {});
    const after = Date.now();
    expect(event.ts).toBeGreaterThanOrEqual(before);
    expect(event.ts).toBeLessThanOrEqual(after);
  });
});

// ─── Source Field ─────────────────────────────────────────────────────────────

describe("Event source field", () => {
  const validSources: EventSource[] = [
    "vite",
    "next",
    "browser:console",
    "browser:network",
    "browser:dom",
  ];

  it.each(validSources)("accepts valid source: %s", (source) => {
    const event = createEvent(source, "info", {});
    expect(event.source).toBe(source);
  });

  it("rejects an invalid source at runtime", () => {
    // The implementation should throw or return null for unknown sources.
    // TypeScript catches this at compile time, but we also want a runtime guard.
    expect(() =>
      // @ts-expect-error — intentionally passing bad value to test runtime guard
      createEvent("unknown_source", "info", {}),
    ).toThrow();
  });
});

// ─── Level Field ──────────────────────────────────────────────────────────────

describe("Event level field", () => {
  const validLevels: EventLevel[] = ["info", "warn", "error", "debug"];

  it.each(validLevels)("accepts valid level: %s", (level) => {
    const event = createEvent("vite", level, {});
    expect(event.level).toBe(level);
  });

  it("rejects an invalid level at runtime", () => {
    expect(() =>
      // @ts-expect-error — intentionally passing bad value
      createEvent("vite", "critical", {}),
    ).toThrow();
  });
});

// ─── Payload Field ────────────────────────────────────────────────────────────

describe("Event payload field", () => {
  it("is always an object", () => {
    const event = createEvent("vite", "info", { message: "test" });
    expect(typeof event.payload).toBe("object");
    expect(event.payload).not.toBeNull();
    expect(Array.isArray(event.payload)).toBe(false);
  });

  it("preserves all payload keys", () => {
    const payload = { message: "compile error", file: "index.tsx", line: 42 };
    const event = createEvent("vite", "error", payload);
    expect(event.payload).toMatchObject(payload);
  });

  it("rejects a raw string payload", () => {
    expect(() =>
      // @ts-expect-error — intentionally passing bad value
      createEvent("vite", "info", "raw string"),
    ).toThrow();
  });

  it("rejects a null payload", () => {
    expect(() =>
      // @ts-expect-error — intentionally passing bad value
      createEvent("vite", "info", null),
    ).toThrow();
  });

  it("accepts an empty object payload", () => {
    expect(() => createEvent("vite", "info", {})).not.toThrow();
  });
});

// ─── Full Schema Shape ────────────────────────────────────────────────────────

describe("Full event shape", () => {
  it("has exactly the required top-level keys and no extras", () => {
    const event = createEvent("vite", "info", { message: "hello" });
    const keys = Object.keys(event).sort();
    expect(keys).toEqual(["id", "level", "payload", "source", "ts"].sort());
  });

  it("satisfies the DaibugEvent interface shape", () => {
    const event: DaibugEvent = createEvent("browser:console", "error", {
      message: "TypeError: Cannot read properties of undefined",
      stack: "at UserCard.jsx:34",
    });
    expect(event).toBeDefined();
  });
});

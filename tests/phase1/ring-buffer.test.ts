/**
 * ring-buffer.test.ts
 *
 * Quality gate: "Ring buffer caps correctly at 500 events (oldest dropped first)"
 *
 * Pure unit tests for the RingBuffer data structure.
 * No I/O, no network, no processes.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createRingBuffer } from "../src/ring-buffer";
import { createEvent } from "../src/event";
import type { DaibugEvent } from "../src/types";

// ─── Basic Operations ─────────────────────────────────────────────────────────

describe("RingBuffer — basic operations", () => {
  it("starts empty", () => {
    const buf = createRingBuffer<DaibugEvent>(500);
    expect(buf.size).toBe(0);
    expect(buf.toArray()).toHaveLength(0);
  });

  it("reports correct capacity", () => {
    const buf = createRingBuffer<DaibugEvent>(500);
    expect(buf.capacity).toBe(500);
  });

  it("stores pushed items", () => {
    const buf = createRingBuffer<DaibugEvent>(500);
    const event = createEvent("vite", "info", { message: "hello" });
    buf.push(event);
    expect(buf.size).toBe(1);
    expect(buf.toArray()[0]).toEqual(event);
  });

  it("toArray returns items in insertion order (oldest first)", () => {
    const buf = createRingBuffer<DaibugEvent>(500);
    const e1 = createEvent("vite", "info", { n: 1 });
    const e2 = createEvent("vite", "info", { n: 2 });
    const e3 = createEvent("vite", "info", { n: 3 });
    buf.push(e1);
    buf.push(e2);
    buf.push(e3);
    const arr = buf.toArray();
    expect(arr[0].payload.n).toBe(1);
    expect(arr[1].payload.n).toBe(2);
    expect(arr[2].payload.n).toBe(3);
  });

  it("clear() empties the buffer", () => {
    const buf = createRingBuffer<DaibugEvent>(500);
    buf.push(createEvent("vite", "info", {}));
    buf.push(createEvent("vite", "warn", {}));
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.toArray()).toHaveLength(0);
  });

  it("size increments with each push up to capacity", () => {
    const buf = createRingBuffer<DaibugEvent>(10);
    for (let i = 0; i < 8; i++) {
      buf.push(createEvent("vite", "info", { i }));
    }
    expect(buf.size).toBe(8);
  });
});

// ─── Capacity Enforcement (the core Phase 1 gate) ────────────────────────────

describe("RingBuffer — capacity enforcement", () => {
  it("never exceeds capacity of 500", () => {
    const buf = createRingBuffer<DaibugEvent>(500);
    for (let i = 0; i < 600; i++) {
      buf.push(createEvent("vite", "info", { i }));
    }
    expect(buf.size).toBe(500);
    expect(buf.toArray()).toHaveLength(500);
  });

  it("drops the OLDEST event when capacity is exceeded", () => {
    const buf = createRingBuffer<DaibugEvent>(3);
    const e1 = createEvent("vite", "info", { order: "first" });
    const e2 = createEvent("vite", "info", { order: "second" });
    const e3 = createEvent("vite", "info", { order: "third" });
    const e4 = createEvent("vite", "info", { order: "fourth" });

    buf.push(e1);
    buf.push(e2);
    buf.push(e3);
    buf.push(e4); // should evict e1

    const arr = buf.toArray();
    expect(arr).toHaveLength(3);
    expect(arr[0].payload.order).toBe("second"); // oldest remaining
    expect(arr[2].payload.order).toBe("fourth"); // newest
  });

  it("oldest 100 events are dropped after pushing 600 into a 500-capacity buffer", () => {
    const buf = createRingBuffer<DaibugEvent>(500);
    for (let i = 0; i < 600; i++) {
      buf.push(createEvent("vite", "info", { i }));
    }
    const arr = buf.toArray();
    // Item 0 in the array should be what was originally pushed at index 100
    expect(arr[0].payload.i).toBe(100);
    // Last item should be index 599
    expect(arr[499].payload.i).toBe(599);
  });

  it("size is capped at capacity, never goes higher", () => {
    const buf = createRingBuffer<DaibugEvent>(500);
    for (let i = 0; i < 1000; i++) {
      buf.push(createEvent("vite", "info", { i }));
    }
    expect(buf.size).toBe(500);
  });

  it("handles exactly capacity events without dropping any", () => {
    const buf = createRingBuffer<DaibugEvent>(500);
    for (let i = 0; i < 500; i++) {
      buf.push(createEvent("vite", "info", { i }));
    }
    expect(buf.size).toBe(500);
    expect(buf.toArray()[0].payload.i).toBe(0);
    expect(buf.toArray()[499].payload.i).toBe(499);
  });
});

// ─── Immutability ─────────────────────────────────────────────────────────────

describe("RingBuffer — toArray immutability", () => {
  it("toArray returns a new array each call (not the internal reference)", () => {
    const buf = createRingBuffer<DaibugEvent>(500);
    buf.push(createEvent("vite", "info", {}));
    const arr1 = buf.toArray();
    const arr2 = buf.toArray();
    expect(arr1).not.toBe(arr2); // different references
    expect(arr1).toEqual(arr2); // same content
  });

  it("mutating the returned array does not affect the buffer", () => {
    const buf = createRingBuffer<DaibugEvent>(500);
    buf.push(createEvent("vite", "info", { n: 1 }));
    buf.push(createEvent("vite", "info", { n: 2 }));
    const arr = buf.toArray();
    arr.pop(); // mutate the returned array
    expect(buf.size).toBe(2); // buffer unaffected
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe("RingBuffer — edge cases", () => {
  it("works with a capacity of 1", () => {
    const buf = createRingBuffer<DaibugEvent>(1);
    const e1 = createEvent("vite", "info", { n: 1 });
    const e2 = createEvent("vite", "info", { n: 2 });
    buf.push(e1);
    buf.push(e2);
    expect(buf.size).toBe(1);
    expect(buf.toArray()[0].payload.n).toBe(2);
  });

  it("clear then repush works correctly", () => {
    const buf = createRingBuffer<DaibugEvent>(500);
    for (let i = 0; i < 500; i++) buf.push(createEvent("vite", "info", { i }));
    buf.clear();
    buf.push(createEvent("vite", "info", { after: "clear" }));
    expect(buf.size).toBe(1);
    expect(buf.toArray()[0].payload.after).toBe("clear");
  });
});

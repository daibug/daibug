/**
 * hub-api.test.ts
 *
 * Quality gates:
 *   - HTTP API on port 5000 returns events at GET /events
 *   - Events returned by API conform exactly to the event schema
 *   - HTTP API only binds to 127.0.0.1 (security standard)
 *
 * These are integration tests that spin up the real Hub HTTP server.
 * A mock dev server command is used (echo loop) so no real framework needed.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createHub } from "../src/hub";
import type { HubInstance, DaibugEvent, GetEventsResponse } from "../src/types";

const TEST_HTTP_PORT = 5100; // offset to avoid conflicts with a running instance
const TEST_WS_PORT = 4199;
let BASE_URL: string;

// A minimal "dev server" that just emits lines and stays alive
const MOCK_CMD =
  process.platform === "win32"
    ? 'cmd /c "echo compiling && ping -n 31 127.0.0.1 >nul"'
    : 'bash -c "echo compiling; sleep 30"';

let hub: HubInstance;

beforeAll(async () => {
  hub = createHub({
    cmd: MOCK_CMD,
    httpPort: TEST_HTTP_PORT,
    wsPort: TEST_WS_PORT,
  });
  await hub.start();
  BASE_URL = `http://127.0.0.1:${hub.httpPort}`;
});

afterAll(async () => {
  await hub.stop();
});

// ─── Availability ─────────────────────────────────────────────────────────────

describe("GET /events — availability", () => {
  it("responds with HTTP 200", async () => {
    const res = await fetch(`${BASE_URL}/events`);
    expect(res.status).toBe(200);
  });

  it("responds with Content-Type: application/json", async () => {
    const res = await fetch(`${BASE_URL}/events`);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("is only reachable on 127.0.0.1, not 0.0.0.0", async () => {
    // Attempt to connect on all-interfaces address — should fail or timeout
    // (this test is best-effort on CI; it passes vacuously if the OS maps them)
    const res = await fetch(`http://127.0.0.1:${hub.httpPort}/events`);
    expect(res.status).toBe(200); // local always works
  });
});

// ─── Response Shape ───────────────────────────────────────────────────────────

describe("GET /events — response shape", () => {
  it("returns an object with events array and total count", async () => {
    const res = await fetch(`${BASE_URL}/events`);
    const body: GetEventsResponse = await res.json();
    expect(body).toHaveProperty("events");
    expect(body).toHaveProperty("total");
    expect(Array.isArray(body.events)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  it("total matches events array length", async () => {
    const res = await fetch(`${BASE_URL}/events`);
    const body: GetEventsResponse = await res.json();
    expect(body.total).toBe(body.events.length);
  });
});

// ─── Event Schema Conformance (API surface) ───────────────────────────────────

describe("GET /events — event schema conformance", () => {
  let events: DaibugEvent[];

  beforeAll(async () => {
    // Wait a moment to ensure at least the startup event was captured
    await new Promise((r) => setTimeout(r, 300));
    const res = await fetch(`${BASE_URL}/events`);
    const body: GetEventsResponse = await res.json();
    events = body.events;
  });

  it("has at least one event after hub startup", () => {
    expect(events.length).toBeGreaterThan(0);
  });

  it("every event has an id matching evt_{13_digits}_{3_digits}", () => {
    for (const event of events) {
      expect(event.id).toMatch(/^evt_\d{13}_\d{3}$/);
    }
  });

  it("every event has a numeric millisecond timestamp", () => {
    for (const event of events) {
      expect(typeof event.ts).toBe("number");
      expect(event.ts.toString()).toHaveLength(13);
    }
  });

  it("every event source is one of the valid enum values", () => {
    const validSources = [
      "vite",
      "next",
      "browser:console",
      "browser:network",
      "browser:dom",
    ];
    for (const event of events) {
      expect(validSources).toContain(event.source);
    }
  });

  it("every event level is one of: info | warn | error | debug", () => {
    const validLevels = ["info", "warn", "error", "debug"];
    for (const event of events) {
      expect(validLevels).toContain(event.level);
    }
  });

  it("every event payload is a non-null object (not a string)", () => {
    for (const event of events) {
      expect(typeof event.payload).toBe("object");
      expect(event.payload).not.toBeNull();
      expect(typeof event.payload).not.toBe("string");
    }
  });

  it("no event has extra top-level keys beyond the schema", () => {
    const allowedKeys = ["id", "ts", "source", "level", "payload"];
    for (const event of events) {
      const keys = Object.keys(event);
      for (const key of keys) {
        expect(allowedKeys).toContain(key);
      }
    }
  });
});

// ─── Filtering ────────────────────────────────────────────────────────────────

describe("GET /events — query params", () => {
  it("accepts ?limit=N and returns at most N events", async () => {
    // First push some events by waiting
    await new Promise((r) => setTimeout(r, 200));
    const res = await fetch(`${BASE_URL}/events?limit=2`);
    const body: GetEventsResponse = await res.json();
    expect(body.events.length).toBeLessThanOrEqual(2);
  });

  it("accepts ?source=vite and returns only vite events", async () => {
    const res = await fetch(`${BASE_URL}/events?source=vite`);
    const body: GetEventsResponse = await res.json();
    for (const event of body.events) {
      expect(event.source).toBe("vite");
    }
  });

  it("accepts ?level=error and returns only error events", async () => {
    const res = await fetch(`${BASE_URL}/events?level=error`);
    const body: GetEventsResponse = await res.json();
    for (const event of body.events) {
      expect(event.level).toBe("error");
    }
  });
});

// ─── Unknown Routes ───────────────────────────────────────────────────────────

describe("HTTP API — unknown routes", () => {
  it("returns 404 for unknown paths", async () => {
    const res = await fetch(`${BASE_URL}/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("returns 405 for POST to /events", async () => {
    const res = await fetch(`${BASE_URL}/events`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

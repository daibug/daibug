/**
 * hub-browser-events.test.ts
 *
 * Quality gates:
 *   - Hub receives browser:console, browser:network, browser:dom events via WebSocket
 *   - Browser events are stored in the ring buffer with correct schema
 *   - Browser events are returned by GET /events
 *   - Browser events are broadcast to other WS clients in real time
 *   - Source detection: Next.js output tagged "next", Vite output tagged "vite"
 *
 * These are integration tests. They simulate what the browser extension
 * does — connect to the Hub WS and send structured events — without
 * needing an actual browser or extension.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import WebSocket from "ws";
import { createHub } from "../../src/hub";
import type {
  HubInstance,
  DaibugEvent,
  GetEventsResponse,
} from "../../src/types";
import { MOCK_NEXT_SERVER, MOCK_VITE_SERVER, idle } from "../helpers/cmd";

const BASE_HTTP = 5600;
const BASE_WS = 4699;
let portCounter = 0;
function ports() {
  portCounter++;
  return { httpPort: BASE_HTTP + portCounter, wsPort: BASE_WS + portCounter };
}

/** Send a DaibugEvent to the hub as if we are the browser extension */
async function sendBrowserEvent(
  wsPort: number,
  event: Omit<DaibugEvent, "id" | "ts">,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    ws.on("open", () => {
      ws.send(JSON.stringify(event));
      setTimeout(() => {
        ws.close();
        resolve();
      }, 50);
    });
    ws.on("error", reject);
  });
}

// ─── Browser Event Ingestion ──────────────────────────────────────────────────

describe("Hub ingestion — browser:console events", () => {
  let hub: HubInstance;
  let p: ReturnType<typeof ports>;

  beforeAll(async () => {
    p = ports();
    hub = createHub({ cmd: idle(30), ...p });
    await hub.start();
  });

  afterAll(async () => {
    await hub.stop();
  });

  it("stores a browser:console event sent over WebSocket", async () => {
    await sendBrowserEvent(hub.wsPort, {
      source: "browser:console",
      level: "error",
      payload: {
        message: "TypeError: Cannot read properties of undefined",
        stack: "at App.tsx:42",
      },
    });

    await new Promise((r) => setTimeout(r, 100));

    const events = hub.getEvents();
    const match = events.find(
      (e) =>
        e.source === "browser:console" &&
        typeof e.payload.message === "string" &&
        (e.payload.message as string).includes("TypeError"),
    );
    expect(match).toBeDefined();
  });

  it("browser:console event has correct schema after storage", async () => {
    await sendBrowserEvent(hub.wsPort, {
      source: "browser:console",
      level: "warn",
      payload: { message: "Schema test warning" },
    });

    await new Promise((r) => setTimeout(r, 100));

    const events = hub.getEvents();
    const match = events.find(
      (e) =>
        e.source === "browser:console" &&
        e.payload.message === "Schema test warning",
    );
    expect(match).toBeDefined();
    expect(match!.id).toMatch(/^evt_\d{13}_\d{3}$/);
    expect(match!.ts).toBeGreaterThan(0);
    expect(match!.source).toBe("browser:console");
    expect(match!.level).toBe("warn");
  });

  it("browser:console event appears in GET /events response", async () => {
    await sendBrowserEvent(hub.wsPort, {
      source: "browser:console",
      level: "debug",
      payload: { message: "api-visibility-test" },
    });

    await new Promise((r) => setTimeout(r, 150));

    const res = await fetch(`http://127.0.0.1:${hub.httpPort}/events`);
    const body: GetEventsResponse = await res.json();
    const match = body.events.find(
      (e) =>
        e.source === "browser:console" &&
        e.payload.message === "api-visibility-test",
    );
    expect(match).toBeDefined();
  });
});

// ─── Network Events ───────────────────────────────────────────────────────────

describe("Hub ingestion — browser:network events", () => {
  let hub: HubInstance;
  let p: ReturnType<typeof ports>;

  beforeAll(async () => {
    p = ports();
    hub = createHub({ cmd: idle(30), ...p });
    await hub.start();
  });

  afterAll(async () => {
    await hub.stop();
  });

  it("stores a browser:network event with request details", async () => {
    await sendBrowserEvent(hub.wsPort, {
      source: "browser:network",
      level: "error",
      payload: {
        url: "http://localhost:3000/api/user",
        method: "GET",
        status: 401,
        duration: 234,
        responseBody: '{"error":"Unauthorized"}',
      },
    });

    await new Promise((r) => setTimeout(r, 100));

    const events = hub.getEvents();
    const match = events.find(
      (e) => e.source === "browser:network" && e.payload.status === 401,
    );
    expect(match).toBeDefined();
    expect(match!.payload.url).toBe("http://localhost:3000/api/user");
    expect(match!.payload.method).toBe("GET");
  });

  it("4xx network event is tagged level error", async () => {
    await sendBrowserEvent(hub.wsPort, {
      source: "browser:network",
      level: "error",
      payload: { url: "/api/data", method: "POST", status: 404 },
    });
    await new Promise((r) => setTimeout(r, 100));

    const events = hub.getEvents();
    const match = events.find(
      (e) => e.source === "browser:network" && e.payload.status === 404,
    );
    expect(match!.level).toBe("error");
  });

  it("5xx network event is tagged level error", async () => {
    await sendBrowserEvent(hub.wsPort, {
      source: "browser:network",
      level: "error",
      payload: { url: "/api/crash", method: "GET", status: 500 },
    });
    await new Promise((r) => setTimeout(r, 100));

    const events = hub.getEvents();
    const match = events.find(
      (e) => e.source === "browser:network" && e.payload.status === 500,
    );
    expect(match!.level).toBe("error");
  });

  it("2xx network event is tagged level info", async () => {
    await sendBrowserEvent(hub.wsPort, {
      source: "browser:network",
      level: "info",
      payload: { url: "/api/ok", method: "GET", status: 200 },
    });
    await new Promise((r) => setTimeout(r, 100));

    const events = hub.getEvents();
    const match = events.find(
      (e) => e.source === "browser:network" && e.payload.status === 200,
    );
    expect(match!.level).toBe("info");
  });
});

// ─── DOM Events ───────────────────────────────────────────────────────────────

describe("Hub ingestion — browser:dom events", () => {
  let hub: HubInstance;
  let p: ReturnType<typeof ports>;

  beforeAll(async () => {
    p = ports();
    hub = createHub({ cmd: idle(30), ...p });
    await hub.start();
  });

  afterAll(async () => {
    await hub.stop();
  });

  it("stores a browser:dom snapshot event", async () => {
    await sendBrowserEvent(hub.wsPort, {
      source: "browser:dom",
      level: "info",
      payload: {
        trigger: "on-demand",
        nodeCount: 142,
        snapshot: "<html>...</html>",
      },
    });

    await new Promise((r) => setTimeout(r, 100));

    const events = hub.getEvents();
    const match = events.find((e) => e.source === "browser:dom");
    expect(match).toBeDefined();
    expect(match!.payload.trigger).toBe("on-demand");
    expect(match!.payload.nodeCount).toBe(142);
  });
});

// ─── Source Detection in Hub ──────────────────────────────────────────────────

describe("Hub — dev server source detection", () => {
  it('tags Next.js output as source "next"', async () => {
    const p = ports();
    const hub = createHub({ cmd: MOCK_NEXT_SERVER, ...p });
    await hub.start();
    await new Promise((r) => setTimeout(r, 2000));

    const events = hub.getEvents();
    const nextEvents = events.filter((e) => e.source === "next");
    expect(nextEvents.length).toBeGreaterThan(0);

    // None should be tagged "vite" since this is clearly Next.js
    const wronglyTagged = events.filter(
      (e) =>
        e.source === "vite" &&
        typeof e.payload.message === "string" &&
        (e.payload.message as string).includes("Next.js"),
    );
    expect(wronglyTagged.length).toBe(0);

    await hub.stop();
  });

  it('tags Vite output as source "vite"', async () => {
    const p = ports();
    const hub = createHub({ cmd: MOCK_VITE_SERVER, ...p });
    await hub.start();
    await new Promise((r) => setTimeout(r, 1500));

    const events = hub.getEvents();
    const viteEvents = events.filter((e) => e.source === "vite");
    expect(viteEvents.length).toBeGreaterThan(0);

    await hub.stop();
  });

  it('tags unknown server output as source "devserver"', async () => {
    const p = ports();
    const hub = createHub({
      cmd: MOCK_NEXT_SERVER.replace("Next.js", "MyServer"),
      ...p,
    });
    await hub.start();
    await new Promise((r) => setTimeout(r, 1500));

    const events = hub.getEvents();
    // Should have devserver events (unknown framework)
    const devEvents = events.filter((e) => e.source === "devserver");
    expect(devEvents.length).toBeGreaterThan(0);

    await hub.stop();
  });
});

// ─── Real-time Broadcast ──────────────────────────────────────────────────────

describe("Hub — browser events broadcast to other WS clients", () => {
  it("browser event sent by extension is broadcast to a second connected client", async () => {
    const p = ports();
    const hub = createHub({ cmd: idle(30), ...p });
    await hub.start();

    const received: DaibugEvent[] = [];

    // Second client listens
    const listener = new WebSocket(`ws://127.0.0.1:${hub.wsPort}`);
    await new Promise<void>((r) => listener.on("open", r));
    listener.on("message", (data) => {
      received.push(JSON.parse(data.toString()));
    });

    // Small delay to ensure listener is registered
    await new Promise((r) => setTimeout(r, 50));

    // Extension client sends an event
    await sendBrowserEvent(hub.wsPort, {
      source: "browser:console",
      level: "error",
      payload: { message: "broadcast-test-error" },
    });

    await new Promise((r) => setTimeout(r, 200));
    listener.close();

    const match = received.find(
      (e) =>
        e.source === "browser:console" &&
        e.payload.message === "broadcast-test-error",
    );
    expect(match).toBeDefined();

    await hub.stop();
  });
});

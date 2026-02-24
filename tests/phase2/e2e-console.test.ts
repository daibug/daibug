/**
 * e2e-console.test.ts
 *
 * Quality gates (Playwright):
 *   - Extension connects to Hub WebSocket automatically on localhost URLs
 *   - console.error() in browser appears in Hub event log within 200ms
 *   - console.warn(), console.log(), console.debug() are also captured
 *   - window.onerror (uncaught exceptions) are captured
 *   - window.onunhandledrejection (unhandled promises) are captured
 *   - Extension does NOT connect on non-localhost URLs
 *
 * WINDOWS NOTE: Chrome extensions do not work in headless mode on older Chrome.
 * Use --headless=new (Chrome 112+) which supports extensions.
 * If headless fails, set DAIBUG_E2E_HEADED=1 to run headed.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type BrowserContext } from "playwright";
import path from "path";
import { createHub } from "../../src/hub";
import type { HubInstance, GetEventsResponse } from "../../src/types";
import { idle } from "../helpers/cmd";
import { createTestPageServer } from "../helpers/test-page-server";

const EXT_PATH = path.join(process.cwd(), "extension");
const HUB_WS_PORT = 4850;
const HUB_HTTP_PORT = 5850;
const TEST_PAGE_PORT = 7850;

const HEADLESS = process.env.DAIBUG_E2E_HEADED !== "1";

let hub: HubInstance;
let context: BrowserContext;
let testServerStop: () => void;
let testPageUrl: string;

beforeAll(async () => {
  // Start Hub
  hub = createHub({
    cmd: idle(120),
    wsPort: HUB_WS_PORT,
    httpPort: HUB_HTTP_PORT,
  });
  await hub.start();

  // Start local test page server
  const server = await createTestPageServer(TEST_PAGE_PORT);
  testServerStop = server.stop;
  testPageUrl = `http://localhost:${TEST_PAGE_PORT}`;

  // Launch Chrome with extension loaded
  context = await chromium.launchPersistentContext("", {
    channel: "chrome",
    headless: HEADLESS,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      ...(HEADLESS ? ["--headless=new"] : []),
    ],
  });
}, 30_000);

afterAll(async () => {
  await context?.close();
  testServerStop?.();
  await hub?.stop();
});

// ─── Auto-connect ─────────────────────────────────────────────────────────────

describe("Extension — auto-connect on localhost", () => {
  it("connects to Hub WS when navigating to localhost", async () => {
    const page = await context.newPage();
    await page.goto(testPageUrl);
    await page.waitForTimeout(500); // give extension time to connect

    // The extension should have connected — verify by checking the Hub
    // has received a connection event or at minimum the WS server has a client
    const res = await fetch(`http://127.0.0.1:${HUB_HTTP_PORT}/status`);
    const status = await res.json();
    expect(status.connectedClients).toBeGreaterThanOrEqual(1);

    await page.close();
  });

  it("does NOT connect on external URLs", async () => {
    // Navigate to a page that is clearly not localhost
    // We use a data: URL since we can't reach the real internet in tests
    const page = await context.newPage();
    const initialClients = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/status`,
    )
      .then((r) => r.json())
      .then((s) => s.connectedClients as number);

    await page.goto("about:blank");
    await page.waitForTimeout(300);

    const afterClients = await fetch(`http://127.0.0.1:${HUB_HTTP_PORT}/status`)
      .then((r) => r.json())
      .then((s) => s.connectedClients as number);

    // Should not have gained a new connection from about:blank
    expect(afterClients).toBe(initialClients);
    await page.close();
  });
});

// ─── Console Capture ──────────────────────────────────────────────────────────

describe("Extension — console interception", () => {
  it("captures console.error() within 200ms", async () => {
    const page = await context.newPage();
    await page.goto(testPageUrl);
    await page.waitForTimeout(300);

    const marker = `console-error-${Date.now()}`;
    await page.evaluate((msg) => console.error(msg), marker);

    await page.waitForTimeout(200);

    const res = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/events?source=browser:console&level=error`,
    );
    const body: GetEventsResponse = await res.json();
    const match = body.events.find(
      (e) =>
        typeof e.payload.message === "string" &&
        (e.payload.message as string).includes(marker),
    );
    expect(match).toBeDefined();
    expect(match!.source).toBe("browser:console");
    expect(match!.level).toBe("error");

    await page.close();
  });

  it("captures console.warn()", async () => {
    const page = await context.newPage();
    await page.goto(testPageUrl);
    await page.waitForTimeout(300);

    const marker = `console-warn-${Date.now()}`;
    await page.evaluate((msg) => console.warn(msg), marker);
    await page.waitForTimeout(200);

    const res = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/events?source=browser:console`,
    );
    const body: GetEventsResponse = await res.json();
    const match = body.events.find(
      (e) =>
        typeof e.payload.message === "string" &&
        (e.payload.message as string).includes(marker),
    );
    expect(match?.level).toBe("warn");
    await page.close();
  });

  it("captures console.log() with level info", async () => {
    const page = await context.newPage();
    await page.goto(testPageUrl);
    await page.waitForTimeout(300);

    const marker = `console-log-${Date.now()}`;
    await page.evaluate((msg) => console.log(msg), marker);
    await page.waitForTimeout(200);

    const res = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/events?source=browser:console`,
    );
    const body: GetEventsResponse = await res.json();
    const match = body.events.find(
      (e) =>
        typeof e.payload.message === "string" &&
        (e.payload.message as string).includes(marker),
    );
    expect(match?.level).toBe("info");
    await page.close();
  });

  it("captures console.debug() with level debug", async () => {
    const page = await context.newPage();
    await page.goto(testPageUrl);
    await page.waitForTimeout(300);

    const marker = `console-debug-${Date.now()}`;
    await page.evaluate((msg) => console.debug(msg), marker);
    await page.waitForTimeout(200);

    const res = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/events?source=browser:console`,
    );
    const body: GetEventsResponse = await res.json();
    const match = body.events.find(
      (e) =>
        typeof e.payload.message === "string" &&
        (e.payload.message as string).includes(marker),
    );
    expect(match?.level).toBe("debug");
    await page.close();
  });

  it("captures window.onerror (uncaught exception)", async () => {
    const page = await context.newPage();
    await page.goto(testPageUrl);
    await page.waitForTimeout(300);

    const marker = `uncaught-${Date.now()}`;
    // Throw a deliberately uncaught error
    await page.evaluate((msg) => {
      setTimeout(() => {
        throw new Error(msg);
      }, 10);
    }, marker);

    await page.waitForTimeout(300);

    const res = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/events?source=browser:console&level=error`,
    );
    const body: GetEventsResponse = await res.json();
    const match = body.events.find(
      (e) =>
        typeof e.payload.message === "string" &&
        (e.payload.message as string).includes(marker),
    );
    expect(match).toBeDefined();
    await page.close();
  });

  it("captures unhandledrejection (unhandled promise rejection)", async () => {
    const page = await context.newPage();
    await page.goto(testPageUrl);
    await page.waitForTimeout(300);

    const marker = `unhandled-promise-${Date.now()}`;
    await page.evaluate((msg) => {
      Promise.reject(new Error(msg));
    }, marker);

    await page.waitForTimeout(300);

    const res = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/events?source=browser:console&level=error`,
    );
    const body: GetEventsResponse = await res.json();
    const match = body.events.find(
      (e) =>
        typeof e.payload.message === "string" &&
        (e.payload.message as string).includes(marker),
    );
    expect(match).toBeDefined();
    await page.close();
  });

  it("captured console event has a stack trace when available", async () => {
    const page = await context.newPage();
    await page.goto(testPageUrl);
    await page.waitForTimeout(300);

    const marker = `stack-trace-${Date.now()}`;
    await page.evaluate((msg) => console.error(msg), marker);
    await page.waitForTimeout(200);

    const res = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/events?source=browser:console&level=error`,
    );
    const body: GetEventsResponse = await res.json();
    const match = body.events.find(
      (e) =>
        typeof e.payload.message === "string" &&
        (e.payload.message as string).includes(marker),
    );
    expect(match?.payload.stack).toBeDefined();
    await page.close();
  });
});

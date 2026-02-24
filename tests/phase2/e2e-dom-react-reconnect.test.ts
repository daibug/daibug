/**
 * e2e-dom-react-reconnect.test.ts
 *
 * Quality gates (Playwright):
 *   - On-demand DOM snapshot returned within 1 second
 *   - React component tree captured (tested on React 18)
 *   - Extension reconnects automatically if Hub restarts
 *   - Extension overhead is < 1ms per console event (performance gate)
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type BrowserContext, type Page } from "playwright";
import path from "path";
import { createHub } from "../../src/hub";
import type { HubInstance, GetEventsResponse } from "../../src/types";
import { idle } from "../helpers/cmd";
import { createTestPageServer } from "../helpers/test-page-server";

const EXT_PATH = path.join(process.cwd(), "extension");
const HUB_WS_PORT = 4870;
const HUB_HTTP_PORT = 5870;
const TEST_PAGE_PORT = 7870;

const HEADLESS = process.env.DAIBUG_E2E_HEADED !== "1";

let hub: HubInstance;
let context: BrowserContext;
let testServerStop: () => void;
let testPageUrl: string;

beforeAll(async () => {
  hub = createHub({
    cmd: idle(120),
    wsPort: HUB_WS_PORT,
    httpPort: HUB_HTTP_PORT,
  });
  await hub.start();

  const server = await createTestPageServer(TEST_PAGE_PORT);
  testServerStop = server.stop;
  testPageUrl = `http://localhost:${TEST_PAGE_PORT}`;

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

// ─── DOM Snapshot ─────────────────────────────────────────────────────────────

describe("Extension — on-demand DOM snapshot", () => {
  it("DOM snapshot event appears in Hub within 1 second of request", async () => {
    const page = await context.newPage();
    await page.goto(`${testPageUrl}/react-app`);
    await page.waitForTimeout(500);

    const requestedAt = Date.now();

    // Trigger snapshot via Hub API (the hub sends a command to the extension via WS)
    const triggerRes = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/command`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "snapshot_dom" }),
      },
    );
    expect(triggerRes.status).toBe(202);

    // Poll for the snapshot event
    let snapshotEvent = null;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const res = await fetch(
        `http://127.0.0.1:${HUB_HTTP_PORT}/events?source=browser:dom`,
      );
      const body: GetEventsResponse = await res.json();
      snapshotEvent = body.events.find((e) => e.source === "browser:dom");
      if (snapshotEvent) break;
    }

    const elapsed = Date.now() - requestedAt;
    expect(snapshotEvent).toBeDefined();
    expect(elapsed).toBeLessThan(1000);

    await page.close();
  });

  it("DOM snapshot payload contains nodeCount and snapshot string", async () => {
    const page = await context.newPage();
    await page.goto(`${testPageUrl}/react-app`);
    await page.waitForTimeout(500);

    await fetch(`http://127.0.0.1:${HUB_HTTP_PORT}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "snapshot_dom" }),
    });

    await new Promise((r) => setTimeout(r, 800));

    const res = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/events?source=browser:dom`,
    );
    const body: GetEventsResponse = await res.json();
    const snap = body.events.find((e) => e.source === "browser:dom");

    expect(snap?.payload.nodeCount).toBeDefined();
    expect(typeof snap?.payload.nodeCount).toBe("number");
    expect(snap?.payload.nodeCount as number).toBeGreaterThan(0);
    expect(typeof snap?.payload.snapshot).toBe("string");

    await page.close();
  });
});

// ─── React State Capture ──────────────────────────────────────────────────────

describe("Extension — React component tree capture", () => {
  it("captures React 18 component tree on demand", async () => {
    const page = await context.newPage();
    // The react-app test page uses React 18
    await page.goto(`${testPageUrl}/react-app`);
    await page.waitForTimeout(800);

    // Verify React is on the page
    const hasReact = await page.evaluate(
      () =>
        !!(window as unknown as Record<string, unknown>)
          .__REACT_DEVTOOLS_GLOBAL_HOOK__,
    );
    expect(hasReact).toBe(true);

    // Trigger component tree capture
    await fetch(`http://127.0.0.1:${HUB_HTTP_PORT}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "capture_react" }),
    });

    await new Promise((r) => setTimeout(r, 800));

    const res = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/events?source=browser:dom`,
    );
    const body: GetEventsResponse = await res.json();
    const reactEvent = body.events.find(
      (e) => e.source === "browser:dom" && e.payload.type === "react-tree",
    );

    expect(reactEvent).toBeDefined();
    expect(reactEvent!.payload.components).toBeDefined();

    await page.close();
  });

  it("React component capture includes component names", async () => {
    const page = await context.newPage();
    await page.goto(`${testPageUrl}/react-app`);
    await page.waitForTimeout(800);

    await fetch(`http://127.0.0.1:${HUB_HTTP_PORT}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "capture_react" }),
    });

    await new Promise((r) => setTimeout(r, 800));

    const res = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/events?source=browser:dom`,
    );
    const body: GetEventsResponse = await res.json();
    const reactEvent = body.events.find((e) => e.payload.type === "react-tree");

    const components = reactEvent?.payload.components as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(components)).toBe(true);
    expect(components.length).toBeGreaterThan(0);
    // Each component should have a name
    expect(typeof components[0].name).toBe("string");

    await page.close();
  });
});

// ─── Reconnection ─────────────────────────────────────────────────────────────

describe("Extension — automatic reconnection", () => {
  it("resumes sending events after Hub restarts", async () => {
    // This test has its own hub so it can restart it mid-test
    const reconnectHubPorts = { wsPort: 4875, httpPort: 5875 };
    const reconnectHub = createHub({ cmd: idle(120), ...reconnectHubPorts });
    await reconnectHub.start();

    const reconnectPage = await context.newPage();
    // Navigate to localhost which should trigger extension to connect to this hub
    // NOTE: extension needs to support configurable port, or this uses default
    await reconnectPage.goto(testPageUrl);
    await reconnectPage.waitForTimeout(500);

    // Confirm initial connection works
    await reconnectPage.evaluate(() => console.error("before-restart"));
    await new Promise((r) => setTimeout(r, 200));

    const beforeRes = await fetch(
      `http://127.0.0.1:${reconnectHubPorts.httpPort}/events?source=browser:console`,
    );
    const beforeBody: GetEventsResponse = await beforeRes.json();
    expect(
      beforeBody.events.some((e) => e.payload.message === "before-restart"),
    ).toBe(true);

    // Restart the hub
    await reconnectHub.stop();
    await new Promise((r) => setTimeout(r, 300));

    const restartedHub = createHub({ cmd: idle(120), ...reconnectHubPorts });
    await restartedHub.start();

    // Wait for extension to reconnect (exponential backoff — up to 3s)
    await new Promise((r) => setTimeout(r, 3000));

    // Send another event — should be captured by restarted hub
    const marker = `after-restart-${Date.now()}`;
    await reconnectPage.evaluate((msg) => console.error(msg), marker);
    await new Promise((r) => setTimeout(r, 500));

    const afterRes = await fetch(
      `http://127.0.0.1:${reconnectHubPorts.httpPort}/events?source=browser:console`,
    );
    const afterBody: GetEventsResponse = await afterRes.json();
    const reconnectedEvent = afterBody.events.find(
      (e) =>
        typeof e.payload.message === "string" &&
        (e.payload.message as string).includes(marker),
    );
    expect(reconnectedEvent).toBeDefined();

    await reconnectPage.close();
    await restartedHub.stop();
  }, 15_000);
});

// ─── Performance Gate ─────────────────────────────────────────────────────────

describe("Extension — performance overhead", () => {
  it("console interception adds less than 1ms overhead per call", async () => {
    const page = await context.newPage();
    await page.goto(testPageUrl);
    await page.waitForTimeout(300);

    // Measure time for 100 console.log calls with the extension active
    const withExtension = await page.evaluate(async () => {
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        console.log(`perf-test-${i}`);
      }
      return performance.now() - start;
    });

    // Average per call
    const avgMs = withExtension / 100;

    // < 1ms per call. In practice this is much lower (< 0.1ms) but 1ms is the gate.
    expect(avgMs).toBeLessThan(1);

    await page.close();
  });
});

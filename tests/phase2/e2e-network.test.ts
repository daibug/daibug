/**
 * e2e-network.test.ts
 *
 * Quality gates (Playwright):
 *   - Failed network requests (4xx/5xx) appear in Hub event log with correct status code
 *   - Successful requests (2xx) are also captured with level info
 *   - Request method, URL, and status code are present in payload
 *   - Response body is captured (up to 50kb limit)
 *   - Timing information is present
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type BrowserContext } from "playwright";
import path from "path";
import { createHub } from "../../src/hub";
import type { HubInstance, GetEventsResponse } from "../../src/types";
import { idle } from "../helpers/cmd";
import { createTestPageServer } from "../helpers/test-page-server";

const EXT_PATH = path.join(process.cwd(), "extension");
const HUB_WS_PORT = 4860;
const HUB_HTTP_PORT = 5860;
const TEST_PAGE_PORT = 7860;

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

// ─── Network Capture ──────────────────────────────────────────────────────────

describe("Extension — network interception", () => {
  it("captures a 404 request with correct status code", async () => {
    const page = await context.newPage();
    await page.goto(testPageUrl);
    await page.waitForTimeout(300);

    // The test page server returns 404 for /not-found
    await page.evaluate(() => fetch("/not-found").catch(() => {}));
    await page.waitForTimeout(300);

    const res = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/events?source=browser:network&level=error`,
    );
    const body: GetEventsResponse = await res.json();
    const match = body.events.find(
      (e) => e.source === "browser:network" && e.payload.status === 404,
    );
    expect(match).toBeDefined();
    expect(match!.level).toBe("error");

    await page.close();
  });

  it("captures a 500 response with level error", async () => {
    const page = await context.newPage();
    await page.goto(testPageUrl);
    await page.waitForTimeout(300);

    await page.evaluate(() => fetch("/internal-error").catch(() => {}));
    await page.waitForTimeout(300);

    const res = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/events?source=browser:network`,
    );
    const body: GetEventsResponse = await res.json();
    const match = body.events.find(
      (e) => e.source === "browser:network" && e.payload.status === 500,
    );
    expect(match?.level).toBe("error");
    await page.close();
  });

  it("captures a successful 200 request with level info", async () => {
    const page = await context.newPage();
    await page.goto(testPageUrl);
    await page.waitForTimeout(300);

    await page.evaluate(() => fetch("/api/ok"));
    await page.waitForTimeout(300);

    const res = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/events?source=browser:network`,
    );
    const body: GetEventsResponse = await res.json();
    const match = body.events.find(
      (e) =>
        e.source === "browser:network" &&
        e.payload.status === 200 &&
        typeof e.payload.url === "string" &&
        (e.payload.url as string).includes("/api/ok"),
    );
    expect(match).toBeDefined();
    expect(match!.level).toBe("info");
    await page.close();
  });

  it("network event payload contains url, method, and status", async () => {
    const page = await context.newPage();
    await page.goto(testPageUrl);
    await page.waitForTimeout(300);

    await page.evaluate(() =>
      fetch("/api/post-test", { method: "POST", body: "{}" }).catch(() => {}),
    );
    await page.waitForTimeout(300);

    const res = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/events?source=browser:network`,
    );
    const body: GetEventsResponse = await res.json();
    const match = body.events.find(
      (e) =>
        e.source === "browser:network" &&
        typeof e.payload.url === "string" &&
        (e.payload.url as string).includes("/api/post-test"),
    );
    expect(match).toBeDefined();
    expect(match!.payload.method).toBe("POST");
    expect(typeof match!.payload.status).toBe("number");
    await page.close();
  });

  it("network event payload contains duration in milliseconds", async () => {
    const page = await context.newPage();
    await page.goto(testPageUrl);
    await page.waitForTimeout(300);

    await page.evaluate(() => fetch("/api/ok"));
    await page.waitForTimeout(300);

    const res = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/events?source=browser:network`,
    );
    const body: GetEventsResponse = await res.json();
    const match = body.events.find(
      (e) =>
        e.source === "browser:network" &&
        typeof e.payload.url === "string" &&
        (e.payload.url as string).includes("/api/ok"),
    );
    expect(typeof match?.payload.duration).toBe("number");
    expect(match!.payload.duration as number).toBeGreaterThan(0);
    await page.close();
  });

  it("captures XHR requests (not just fetch)", async () => {
    const page = await context.newPage();
    await page.goto(testPageUrl);
    await page.waitForTimeout(300);

    const marker = `/api/xhr-${Date.now()}`;
    await page.evaluate((url) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url);
      xhr.send();
    }, marker);

    await page.waitForTimeout(300);

    const res = await fetch(
      `http://127.0.0.1:${HUB_HTTP_PORT}/events?source=browser:network`,
    );
    const body: GetEventsResponse = await res.json();
    const match = body.events.find(
      (e) =>
        typeof e.payload.url === "string" &&
        (e.payload.url as string).includes(marker),
    );
    expect(match).toBeDefined();
    await page.close();
  });
});

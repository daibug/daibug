/**
 * playwright-shim.ts
 *
 * Patches Playwright's launchPersistentContext for E2E extension testing:
 *
 * 1. Drops `channel: 'chrome'` — system Chrome ignores --load-extension
 *    because Playwright injects --disable-extensions into default args.
 *    Bundled Chromium handles extensions correctly.
 *
 * 2. Forces headed mode — Chromium headless (even --headless=new) doesn't
 *    support MV3 service worker extensions in Playwright's bundled build.
 *    Extensions only load in headed mode.
 */

import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const playwrightPath = path.join(
  path.dirname(require.resolve("playwright/package.json")),
  "index.js",
);
const pw = require(playwrightPath);

const origLaunch = pw.chromium.launchPersistentContext.bind(pw.chromium);

pw.chromium.launchPersistentContext = async function (
  userDataDir: string,
  options?: Record<string, unknown>,
) {
  const opts = { ...options };

  // Use bundled Chromium instead of system Chrome
  delete opts.channel;

  // Force headed mode for extension support
  const args = (opts.args as string[]) || [];
  opts.args = args.filter((a: string) => !a.startsWith("--headless"));
  opts.headless = false;

  const ctx = await origLaunch(userDataDir, opts);

  // Wait for the extension service worker to start before returning,
  // so tests don't race against service worker initialization.
  if (ctx.serviceWorkers().length === 0) {
    await ctx
      .waitForEvent("serviceworker", { timeout: 5000 })
      .catch(() => {});
  }
  // Give the service worker time to run discover() and establish WS connections
  await new Promise((r) => setTimeout(r, 500));

  return ctx;
};

export const chromium = pw.chromium;
export const firefox = pw.firefox;
export const webkit = pw.webkit;
export const devices = pw.devices;
export const errors = pw.errors;
export const request = pw.request;
export const selectors = pw.selectors;

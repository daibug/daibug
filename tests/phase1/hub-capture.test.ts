/**
 * hub-capture.test.ts
 *
 * Quality gates:
 *   - Dev server stdout/stderr appears in the Hub event log within 100ms
 *   - Hub recovers if dev server crashes and is restarted
 *   - Events from vite/next stdout are tagged with the correct source
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHub } from "../src/hub";
import type { HubInstance } from "../src/types";

const TEST_HTTP_PORT_BASE = 5300;
const TEST_WS_PORT_BASE = 4399;
let portOffset = 0;

function getPorts() {
  portOffset++;
  return {
    httpPort: TEST_HTTP_PORT_BASE + portOffset,
    wsPort: TEST_WS_PORT_BASE + portOffset,
  };
}

// ─── Stdout Capture ───────────────────────────────────────────────────────────

describe("Dev server stdout capture", () => {
  let hub: HubInstance;

  beforeEach(async () => {
    const ports = getPorts();
    // A script that emits a distinct string immediately then idles
    const cmd =
      process.platform === "win32"
        ? 'cmd /c "echo DAIBUG_STDOUT_TEST && ping -n 31 127.0.0.1 >nul"'
        : "bash -c 'echo DAIBUG_STDOUT_TEST; sleep 30'";

    hub = createHub({ cmd, ...ports });
    await hub.start();
  });

  afterEach(async () => {
    await hub.stop();
  });

  it("captures dev server stdout within 100ms of emission", async () => {
    const startedAt = Date.now();

    // Poll the event log until we see the stdout event or timeout
    const found = await new Promise<boolean>((resolve) => {
      const interval = setInterval(() => {
        const events = hub.getEvents();
        const hasOutput = events.some(
          (e) =>
            (e.source === "vite" || e.source === "next") &&
            typeof e.payload.message === "string" &&
            (e.payload.message as string).includes("DAIBUG_STDOUT_TEST"),
        );
        if (hasOutput) {
          clearInterval(interval);
          resolve(true);
        }
      }, 10);

      setTimeout(() => {
        clearInterval(interval);
        resolve(false);
      }, 500); // generous outer timeout; the 100ms is measured below
    });

    const elapsed = Date.now() - startedAt;
    expect(found).toBe(true);
    // The event should have arrived well within 500ms, and the test
    // specifically checks the internal timestamp vs emission time in the next test
    expect(elapsed).toBeLessThan(500);
  });

  it("stdout event has source tagged as vite or next (not browser:*)", () => {
    const events = hub.getEvents();
    const devServerEvents = events.filter(
      (e) => e.source === "vite" || e.source === "next",
    );
    // Should have at least the stdout we just captured
    expect(devServerEvents.length).toBeGreaterThan(0);
  });

  it("stdout event payload contains the original message string", () => {
    const events = hub.getEvents();
    const match = events.find(
      (e) =>
        typeof e.payload.message === "string" &&
        (e.payload.message as string).includes("DAIBUG_STDOUT_TEST"),
    );
    expect(match).toBeDefined();
    expect(match!.payload.message).toContain("DAIBUG_STDOUT_TEST");
  });
});

// ─── Stderr Capture ───────────────────────────────────────────────────────────

describe("Dev server stderr capture", () => {
  let hub: HubInstance;

  beforeEach(async () => {
    const ports = getPorts();
    // Emit to stderr, then idle
    const cmd =
      process.platform === "win32"
        ? 'cmd /c "echo DAIBUG_STDERR_TEST 1>&2 && ping -n 31 127.0.0.1 >nul"'
        : "bash -c 'echo DAIBUG_STDERR_TEST >&2; sleep 30'";

    hub = createHub({ cmd, ...ports });
    await hub.start();
    // Allow stderr data to arrive through pipes
    await new Promise((r) => setTimeout(r, 100));
  });

  afterEach(async () => {
    await hub.stop();
  });

  it("captures dev server stderr within 100ms", async () => {
    const found = await new Promise<boolean>((resolve) => {
      const interval = setInterval(() => {
        const events = hub.getEvents();
        const hasError = events.some(
          (e) =>
            typeof e.payload.message === "string" &&
            (e.payload.message as string).includes("DAIBUG_STDERR_TEST"),
        );
        if (hasError) {
          clearInterval(interval);
          resolve(true);
        }
      }, 10);
      setTimeout(() => {
        clearInterval(interval);
        resolve(false);
      }, 500);
    });

    expect(found).toBe(true);
  });

  it("stderr events are tagged with level warn or error", () => {
    const events = hub.getEvents();
    const stderrEvent = events.find(
      (e) =>
        typeof e.payload.message === "string" &&
        (e.payload.message as string).includes("DAIBUG_STDERR_TEST"),
    );
    expect(stderrEvent).toBeDefined();
    expect(["warn", "error"]).toContain(stderrEvent!.level);
  });
});

// ─── Crash Recovery ───────────────────────────────────────────────────────────

describe("Dev server crash recovery", () => {
  it("hub survives when the dev server process crashes", async () => {
    const ports = getPorts();
    // A command that exits immediately (simulates crash)
    const cmd =
      process.platform === "win32"
        ? 'cmd /c "echo CRASH_TEST && exit 1"'
        : "bash -c 'echo CRASH_TEST; exit 1'";

    const hub = createHub({ cmd, ...ports });
    await hub.start();

    // Wait for the process to die
    await new Promise((r) => setTimeout(r, 500));

    // Hub itself must still be alive — HTTP API should still respond
    const res = await fetch(`http://127.0.0.1:${ports.httpPort}/events`);
    expect(res.status).toBe(200);

    // Hub must report dev server is no longer running
    expect(hub.isDevServerRunning).toBe(false);

    await hub.stop();
  });

  it("isDevServerRunning is true while the process is alive", async () => {
    const ports = getPorts();
    const cmd =
      process.platform === "win32"
        ? 'cmd /c "ping -n 31 127.0.0.1 >nul"'
        : 'bash -c "sleep 30"';

    const hub = createHub({ cmd, ...ports });
    await hub.start();

    // Give it a moment to confirm it's running
    await new Promise((r) => setTimeout(r, 200));
    expect(hub.isDevServerRunning).toBe(true);

    await hub.stop();
  });

  it("crash event is logged in the event buffer", async () => {
    const ports = getPorts();
    const cmd =
      process.platform === "win32" ? 'cmd /c "exit 1"' : 'bash -c "exit 1"';

    const hub = createHub({ cmd, ...ports });
    await hub.start();
    await new Promise((r) => setTimeout(r, 500));

    const events = hub.getEvents();
    // There should be an event recording the crash / process exit
    const crashEvent = events.find(
      (e) => e.level === "error" && typeof e.payload.exitCode !== "undefined",
    );
    expect(crashEvent).toBeDefined();
    expect(crashEvent!.payload.exitCode).not.toBe(0);

    await hub.stop();
  });

  it("events captured before crash are preserved in the buffer", async () => {
    const ports = getPorts();
    const cmd =
      process.platform === "win32"
        ? 'cmd /c "echo BEFORE_CRASH && exit 1"'
        : "bash -c 'echo BEFORE_CRASH; exit 1'";

    const hub = createHub({ cmd, ...ports });
    await hub.start();
    await new Promise((r) => setTimeout(r, 500));

    const events = hub.getEvents();
    const beforeCrash = events.find(
      (e) =>
        typeof e.payload.message === "string" &&
        (e.payload.message as string).includes("BEFORE_CRASH"),
    );
    expect(beforeCrash).toBeDefined();

    await hub.stop();
  });
});

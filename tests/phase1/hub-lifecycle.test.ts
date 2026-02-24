/**
 * hub-lifecycle.test.ts
 *
 * Quality gates:
 *   - `npx daibug dev --cmd "npm run dev"` starts successfully
 *   - Hub shuts down cleanly when killed
 *   - Child process is also terminated on hub shutdown (no orphans)
 *   - All async operations complete within defined timeouts
 */

import { describe, it, expect } from "bun:test";
import { execSync, spawn } from "child_process";
import { createHub } from "../src/hub";
import type { HubInstance } from "../src/types";

const BASE_HTTP = 5400;
const BASE_WS = 4499;
let counter = 0;
function ports() {
  counter++;
  return { httpPort: BASE_HTTP + counter, wsPort: BASE_WS + counter };
}

// ─── Startup ──────────────────────────────────────────────────────────────────

describe("Hub lifecycle — startup", () => {
  it("start() resolves without throwing", async () => {
    const hub = createHub({
      cmd:
        process.platform === "win32" ? 'cmd /c "ping -n 6 127.0.0.1 >nul"' : "sleep 5",
      ...ports(),
    });
    await hub.start();
    await hub.stop();
  });

  it("start() resolves in under 3 seconds", async () => {
    const hub = createHub({
      cmd:
        process.platform === "win32" ? 'cmd /c "ping -n 6 127.0.0.1 >nul"' : "sleep 5",
      ...ports(),
    });

    const t0 = Date.now();
    await hub.start();
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(3000);
    await hub.stop();
  });

  it("HTTP API is reachable immediately after start() resolves", async () => {
    const p = ports();
    const hub = createHub({
      cmd:
        process.platform === "win32" ? 'cmd /c "ping -n 6 127.0.0.1 >nul"' : "sleep 5",
      ...p,
    });
    await hub.start();

    const res = await fetch(`http://127.0.0.1:${hub.httpPort}/events`);
    expect(res.status).toBe(200);

    await hub.stop();
  });

  it("calling start() twice throws a clear error", async () => {
    const hub = createHub({
      cmd:
        process.platform === "win32" ? 'cmd /c "ping -n 6 127.0.0.1 >nul"' : "sleep 5",
      ...ports(),
    });
    await hub.start();
    await expect(hub.start()).rejects.toThrow();
    await hub.stop();
  });
});

// ─── Shutdown ─────────────────────────────────────────────────────────────────

describe("Hub lifecycle — shutdown", () => {
  it("stop() resolves without throwing", async () => {
    const hub = createHub({
      cmd:
        process.platform === "win32"
          ? 'cmd /c "ping -n 31 127.0.0.1 >nul"'
          : "sleep 30",
      ...ports(),
    });
    await hub.start();
    await hub.stop();
  });

  it("stop() resolves in under 3 seconds (clean shutdown)", async () => {
    const hub = createHub({
      cmd:
        process.platform === "win32"
          ? 'cmd /c "ping -n 31 127.0.0.1 >nul"'
          : "sleep 30",
      ...ports(),
    });
    await hub.start();

    const t0 = Date.now();
    await hub.stop();
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(3000);
  });

  it("HTTP API is unreachable after stop() resolves", async () => {
    const p = ports();
    const hub = createHub({
      cmd:
        process.platform === "win32"
          ? 'cmd /c "ping -n 31 127.0.0.1 >nul"'
          : "sleep 30",
      ...p,
    });
    await hub.start();
    await hub.stop();

    await expect(
      fetch(`http://127.0.0.1:${hub.httpPort}/events`),
    ).rejects.toThrow(); // connection refused
  });

  it("calling stop() before start() throws a clear error", async () => {
    const hub = createHub({
      cmd: "sleep 30",
      ...ports(),
    });
    await expect(hub.stop()).rejects.toThrow();
  });

  it("calling stop() twice does not throw (idempotent)", async () => {
    const hub = createHub({
      cmd:
        process.platform === "win32"
          ? 'cmd /c "ping -n 31 127.0.0.1 >nul"'
          : "sleep 30",
      ...ports(),
    });
    await hub.start();
    await hub.stop();
    // Second stop should be a no-op, not a crash
    await hub.stop();
  });
});

// ─── No Orphan Processes ──────────────────────────────────────────────────────

describe("Hub lifecycle — no orphan processes", () => {
  it("dev server child process is killed when hub stops", async () => {
    const p = ports();

    // Use a command whose PID we can track
    // We'll check if the process with that command is still running after stop()
    const marker = `daibug-test-marker-${Date.now()}`;
    const cmd =
      process.platform === "win32"
        ? `cmd /c "title ${marker} && ping -n 31 127.0.0.1 >nul"`
        : `bash -c "sleep 30 # ${marker}"`;

    const hub = createHub({ cmd, ...p });
    await hub.start();
    await new Promise((r) => setTimeout(r, 300)); // let it fully start

    await hub.stop();
    await new Promise((r) => setTimeout(r, 300)); // give OS time to reap

    // On Unix, check if any process with our marker is still running
    if (process.platform !== "win32") {
      let orphanFound = false;
      try {
        const result = execSync(`pgrep -f "${marker}"`, { encoding: "utf8" });
        orphanFound = result.trim().length > 0;
      } catch {
        // pgrep exits non-zero when nothing found — that's what we want
        orphanFound = false;
      }
      expect(orphanFound).toBe(false);
    }

    // Regardless of platform: isDevServerRunning must be false
    expect(hub.isDevServerRunning).toBe(false);
  });

  it("isDevServerRunning is false after stop()", async () => {
    const hub = createHub({
      cmd:
        process.platform === "win32"
          ? 'cmd /c "ping -n 31 127.0.0.1 >nul"'
          : "sleep 30",
      ...ports(),
    });
    await hub.start();
    expect(hub.isDevServerRunning).toBe(true);
    await hub.stop();
    expect(hub.isDevServerRunning).toBe(false);
  });
});

// ─── Timeout Guarantees ───────────────────────────────────────────────────────

describe("Hub lifecycle — timeout guarantees", () => {
  it("getEvents() returns synchronously (no async needed)", async () => {
    const hub = createHub({
      cmd:
        process.platform === "win32" ? 'cmd /c "ping -n 6 127.0.0.1 >nul"' : "sleep 5",
      ...ports(),
    });
    await hub.start();

    // Must not hang — getEvents is synchronous
    const result = hub.getEvents();
    expect(Array.isArray(result)).toBe(true);

    await hub.stop();
  });

  it("hub does not hang indefinitely if the dev command does not exist", async () => {
    const hub = createHub({
      cmd: "this-command-does-not-exist-at-all",
      ...ports(),
    });

    // Should either throw immediately or resolve with an error event
    // — but must NOT hang for more than 3 seconds
    const raceResult = await Promise.race([
      hub
        .start()
        .then(() => "started")
        .catch(() => "errored"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 3000)),
    ]);

    expect(raceResult).not.toBe("timeout");

    // Cleanup — may already be stopped
    try {
      await hub.stop();
    } catch {}
  });
});

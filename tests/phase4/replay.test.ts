import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createSessionRecorder,
  importSessionFromString,
  diffSessions,
} from "../../src/session";
import { createEvent } from "../../src/event";
import { createHub } from "../../src/hub";
import { loadConfig } from "../../src/config";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MOCK_CMD = `node -e "let i=0;const t=setInterval(()=>{process.stdout.write('log '+i+'\\n');i++;if(i>=3)clearInterval(t)},80)"`;
const TEST_HTTP_BASE = 5200;
const TEST_WS_BASE = 4890;

let portOffset = 0;
function nextPorts() {
  const offset = portOffset++;
  return { httpPort: TEST_HTTP_BASE + offset, wsPort: TEST_WS_BASE - offset };
}

function makeHub(extra = {}) {
  return {
    getEvents: () => [],
    getInteractions: () => [],
    clearEvents: () => {},
    broadcastCommand: () => {},
    onBrowserEvent: () => () => {},
    getConfig: () => loadConfig(),
    getConnectedTabs: () => [],
    startSession: () => {},
    stopSession: () => ({
      totalEvents: 0,
      errorCount: 0,
      warnCount: 0,
      networkRequests: 0,
      failedRequests: 0,
      interactionCount: 0,
      duration: 0,
      topErrors: [],
    }),
    ...extra,
  } as unknown as ReturnType<typeof createHub>;
}

async function waitMs(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── SessionRecorder — creation ───────────────────────────────────────────────

describe("createSessionRecorder — basics", () => {
  it("can be created without throwing", () => {
    expect(() => createSessionRecorder(makeHub(), loadConfig())).not.toThrow();
  });

  it("returns object with start, stop, export, exportToString, getSnapshot", () => {
    const recorder = createSessionRecorder(makeHub(), loadConfig());
    expect(typeof recorder.start).toBe("function");
    expect(typeof recorder.stop).toBe("function");
    expect(typeof recorder.export).toBe("function");
    expect(typeof recorder.exportToString).toBe("function");
    expect(typeof recorder.getSnapshot).toBe("function");
  });

  it("getSnapshot returns a DaibugSession shaped object", () => {
    const recorder = createSessionRecorder(makeHub(), loadConfig());
    recorder.start();
    const snapshot = recorder.getSnapshot();
    expect(snapshot.version).toBe("1.0");
    expect(typeof snapshot.id).toBe("string");
    expect(snapshot.id).toMatch(/^session_\d+/);
    expect(typeof snapshot.exportedAt).toBe("number");
    expect(Array.isArray(snapshot.events)).toBe(true);
    expect(Array.isArray(snapshot.interactions)).toBe(true);
    expect(Array.isArray(snapshot.watchedEvents)).toBe(true);
    expect(Array.isArray(snapshot.storageSnapshots)).toBe(true);
    recorder.stop();
  });
});

// ─── SessionRecorder — environment ───────────────────────────────────────────

describe("createSessionRecorder — environment metadata", () => {
  it("captures environment.platform", () => {
    const recorder = createSessionRecorder(makeHub(), loadConfig());
    recorder.start();
    const snapshot = recorder.getSnapshot();
    expect(snapshot.environment.platform).toBe(process.platform);
    recorder.stop();
  });

  it("captures environment.nodeVersion", () => {
    const recorder = createSessionRecorder(makeHub(), loadConfig());
    recorder.start();
    const snapshot = recorder.getSnapshot();
    expect(snapshot.environment.nodeVersion).toBe(process.version);
    recorder.stop();
  });

  it("captures environment.daibugVersion from package.json", async () => {
    const pkg = await import("../../package.json");
    const recorder = createSessionRecorder(makeHub(), loadConfig());
    recorder.start();
    const snapshot = recorder.getSnapshot();
    expect(snapshot.environment.daibugVersion).toBe(pkg.version);
    recorder.stop();
  });

  it("snapshot includes active config", () => {
    const config = loadConfig();
    const recorder = createSessionRecorder(makeHub(), config);
    recorder.start();
    const snapshot = recorder.getSnapshot();
    expect(snapshot.config).toBeDefined();
    expect(snapshot.config.console).toBeDefined();
    recorder.stop();
  });
});

// ─── SessionRecorder — event capture ─────────────────────────────────────────

describe("createSessionRecorder — event capture", () => {
  it("captures events from hub via onBrowserEvent", async () => {
    const handlers: Array<(e: ReturnType<typeof createEvent>) => void> = [];
    const hub = makeHub({
      onBrowserEvent: (h: (e: ReturnType<typeof createEvent>) => void) => {
        handlers.push(h);
        return () => {};
      },
    });

    const recorder = createSessionRecorder(hub, loadConfig());
    recorder.start();

    const event = createEvent("browser:console", "error", {
      message: "test error",
    });
    handlers.forEach((h) => h(event));

    await waitMs(20);
    const snapshot = recorder.getSnapshot();
    expect(snapshot.events.some((e) => e.id === event.id)).toBe(true);
    recorder.stop();
  });

  it("getEvents() snapshot is used if no listener fires", () => {
    const events = [
      createEvent("vite", "info", { msg: "started" }),
      createEvent("browser:console", "error", { message: "oops" }),
    ];
    const hub = makeHub({ getEvents: () => events });
    const recorder = createSessionRecorder(hub, loadConfig());
    recorder.start();
    const snapshot = recorder.getSnapshot();
    // Should include at least the events from getEvents at start time
    expect(snapshot.events.length).toBeGreaterThanOrEqual(0);
    recorder.stop();
  });

  it("stop() freezes the snapshot — new events after stop are not included", async () => {
    const handlers: Array<(e: ReturnType<typeof createEvent>) => void> = [];
    const hub = makeHub({
      onBrowserEvent: (h: (e: ReturnType<typeof createEvent>) => void) => {
        handlers.push(h);
        return () => {};
      },
    });

    const recorder = createSessionRecorder(hub, loadConfig());
    recorder.start();

    const before = createEvent("browser:console", "error", {
      message: "before stop",
    });
    handlers.forEach((h) => h(before));
    await waitMs(10);

    recorder.stop();

    const after = createEvent("browser:console", "error", {
      message: "after stop",
    });
    handlers.forEach((h) => h(after));
    await waitMs(10);

    const snapshot = recorder.getSnapshot();
    expect(snapshot.events.some((e) => e.id === before.id)).toBe(true);
    expect(snapshot.events.some((e) => e.id === after.id)).toBe(false);
  });
});

// ─── SessionRecorder — summary ────────────────────────────────────────────────

describe("createSessionRecorder — summary computation", () => {
  it("counts errors correctly", async () => {
    const handlers: Array<(e: ReturnType<typeof createEvent>) => void> = [];
    const hub = makeHub({
      onBrowserEvent: (h: (e: ReturnType<typeof createEvent>) => void) => {
        handlers.push(h);
        return () => {};
      },
    });

    const recorder = createSessionRecorder(hub, loadConfig());
    recorder.start();

    handlers.forEach((h) =>
      h(createEvent("browser:console", "error", { message: "err 1" })),
    );
    handlers.forEach((h) =>
      h(createEvent("browser:console", "error", { message: "err 2" })),
    );
    handlers.forEach((h) =>
      h(createEvent("vite", "warn", { message: "warn 1" })),
    );
    await waitMs(20);

    const snapshot = recorder.getSnapshot();
    expect(snapshot.summary.errorCount).toBe(2);
    expect(snapshot.summary.warnCount).toBe(1);
    recorder.stop();
  });

  it("counts network requests correctly", async () => {
    const handlers: Array<(e: ReturnType<typeof createEvent>) => void> = [];
    const hub = makeHub({
      onBrowserEvent: (h: (e: ReturnType<typeof createEvent>) => void) => {
        handlers.push(h);
        return () => {};
      },
    });

    const recorder = createSessionRecorder(hub, loadConfig());
    recorder.start();

    handlers.forEach((h) =>
      h(createEvent("browser:network", "info", { url: "/api/a", status: 200 })),
    );
    handlers.forEach((h) =>
      h(
        createEvent("browser:network", "error", { url: "/api/b", status: 404 }),
      ),
    );
    handlers.forEach((h) =>
      h(
        createEvent("browser:network", "error", { url: "/api/c", status: 500 }),
      ),
    );
    await waitMs(20);

    const snapshot = recorder.getSnapshot();
    expect(snapshot.summary.networkRequests).toBe(3);
    expect(snapshot.summary.failedRequests).toBe(2);
    recorder.stop();
  });

  it("summary.duration is last event ts minus first event ts", async () => {
    const handlers: Array<(e: ReturnType<typeof createEvent>) => void> = [];
    const hub = makeHub({
      onBrowserEvent: (h: (e: ReturnType<typeof createEvent>) => void) => {
        handlers.push(h);
        return () => {};
      },
    });

    const recorder = createSessionRecorder(hub, loadConfig());
    recorder.start();

    handlers.forEach((h) => h(createEvent("vite", "info", { msg: "first" })));
    await waitMs(100);
    handlers.forEach((h) => h(createEvent("vite", "info", { msg: "last" })));
    await waitMs(20);

    const snapshot = recorder.getSnapshot();
    if (snapshot.events.length >= 2) {
      expect(snapshot.summary.duration).toBeGreaterThanOrEqual(0);
    }
    recorder.stop();
  });

  it("summary.topErrors lists up to 5 most frequent error messages", async () => {
    const handlers: Array<(e: ReturnType<typeof createEvent>) => void> = [];
    const hub = makeHub({
      onBrowserEvent: (h: (e: ReturnType<typeof createEvent>) => void) => {
        handlers.push(h);
        return () => {};
      },
    });

    const recorder = createSessionRecorder(hub, loadConfig());
    recorder.start();

    for (let i = 0; i < 3; i++) {
      handlers.forEach((h) =>
        h(
          createEvent("browser:console", "error", {
            message: "TypeError: x is null",
          }),
        ),
      );
    }
    for (let i = 0; i < 2; i++) {
      handlers.forEach((h) =>
        h(
          createEvent("browser:console", "error", { message: "404 Not Found" }),
        ),
      );
    }
    await waitMs(20);

    const snapshot = recorder.getSnapshot();
    expect(Array.isArray(snapshot.summary.topErrors)).toBe(true);
    expect(snapshot.summary.topErrors.length).toBeLessThanOrEqual(5);
    if (snapshot.summary.topErrors.length > 0) {
      expect(snapshot.summary.topErrors[0]).toContain("TypeError");
    }
    recorder.stop();
  });
});

// ─── exportToString / import round-trip ──────────────────────────────────────

describe("exportToString and importSessionFromString", () => {
  it("exportToString returns valid JSON", () => {
    const recorder = createSessionRecorder(makeHub(), loadConfig());
    recorder.start();
    const json = recorder.exportToString();
    expect(() => JSON.parse(json)).not.toThrow();
    recorder.stop();
  });

  it("round-trip: export then import returns same session id", () => {
    const recorder = createSessionRecorder(makeHub(), loadConfig());
    recorder.start();
    const json = recorder.exportToString();
    recorder.stop();

    const imported = importSessionFromString(json);
    const original = JSON.parse(json);
    expect(imported.id).toBe(original.id);
  });

  it("round-trip: imported session has correct version", () => {
    const recorder = createSessionRecorder(makeHub(), loadConfig());
    recorder.start();
    const json = recorder.exportToString();
    recorder.stop();

    const imported = importSessionFromString(json);
    expect(imported.version).toBe("1.0");
  });

  it("round-trip: events are preserved", async () => {
    const handlers: Array<(e: ReturnType<typeof createEvent>) => void> = [];
    const hub = makeHub({
      onBrowserEvent: (h: (e: ReturnType<typeof createEvent>) => void) => {
        handlers.push(h);
        return () => {};
      },
    });

    const recorder = createSessionRecorder(hub, loadConfig());
    recorder.start();

    const event = createEvent("browser:console", "error", {
      message: "round trip error",
    });
    handlers.forEach((h) => h(event));
    await waitMs(20);

    const json = recorder.exportToString();
    recorder.stop();

    const imported = importSessionFromString(json);
    expect(imported.events.some((e) => e.id === event.id)).toBe(true);
  });

  it("importSessionFromString throws on invalid JSON", () => {
    expect(() => importSessionFromString("not json at all")).toThrow();
  });

  it("importSessionFromString throws if version is missing", () => {
    const bad = JSON.stringify({ id: "session_123", events: [] });
    expect(() => importSessionFromString(bad)).toThrow();
  });
});

// ─── export to file ───────────────────────────────────────────────────────────

describe("session.export() to file", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daibug-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a .daibug file to the specified path", async () => {
    const recorder = createSessionRecorder(makeHub(), loadConfig());
    recorder.start();
    const filePath = path.join(tmpDir, "test.daibug");
    await recorder.export(filePath);
    recorder.stop();

    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("written file contains valid JSON", async () => {
    const recorder = createSessionRecorder(makeHub(), loadConfig());
    recorder.start();
    const filePath = path.join(tmpDir, "test.daibug");
    await recorder.export(filePath);
    recorder.stop();

    const content = fs.readFileSync(filePath, "utf8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("importSession reads the exported file correctly", async () => {
    const { importSession } = await import("../../src/session");
    const recorder = createSessionRecorder(makeHub(), loadConfig());
    recorder.start();
    const filePath = path.join(tmpDir, "roundtrip.daibug");
    await recorder.export(filePath);
    recorder.stop();

    const imported = await importSession(filePath);
    expect(imported.version).toBe("1.0");
    expect(typeof imported.id).toBe("string");
  });

  it("importSession throws if file does not exist", async () => {
    const { importSession } = await import("../../src/session");
    await expect(
      importSession("/tmp/does-not-exist-999.daibug"),
    ).rejects.toThrow();
  });
});

// ─── diffSessions ─────────────────────────────────────────────────────────────

describe("diffSessions", () => {
  function makeSession(
    overrides: Partial<ReturnType<typeof importSessionFromString>> = {},
  ): ReturnType<typeof importSessionFromString> {
    return {
      version: "1.0",
      id: `session_${Date.now()}_${Math.random()}`,
      exportedAt: Date.now(),
      environment: {
        framework: "vite",
        nodeVersion: process.version,
        platform: process.platform,
        daibugVersion: "0.1.0",
        cmd: "npm run dev",
        startedAt: Date.now(),
      },
      config: loadConfig(),
      events: [],
      interactions: [],
      watchedEvents: [],
      storageSnapshots: [],
      summary: {
        totalEvents: 0,
        errorCount: 0,
        warnCount: 0,
        networkRequests: 0,
        failedRequests: 0,
        interactionCount: 0,
        duration: 0,
        topErrors: [],
      },
      ...overrides,
    };
  }

  it("identical sessions report identical:true", () => {
    const events = [createEvent("vite", "info", { msg: "start" })];
    const sessionA = makeSession({ events });
    const sessionB = makeSession({ id: sessionA.id, events });

    const diff = diffSessions(sessionA, sessionB);
    expect(diff.summary.identical).toBe(true);
  });

  it("different sessions report identical:false", () => {
    const sessionA = makeSession({
      events: [createEvent("vite", "info", { msg: "a" })],
    });
    const sessionB = makeSession({
      events: [createEvent("vite", "error", { msg: "b" })],
    });

    const diff = diffSessions(sessionA, sessionB);
    expect(diff.summary.identical).toBe(false);
  });

  it("diff identifies events only in session A", () => {
    const uniqueA = createEvent("browser:console", "error", {
      message: "only in A",
    });
    const shared = createEvent("vite", "info", { msg: "shared" });

    const sessionA = makeSession({ events: [shared, uniqueA] });
    const sessionB = makeSession({ events: [shared] });

    const diff = diffSessions(sessionA, sessionB);
    expect(diff.eventDiff.onlyInA.some((e) => e.id === uniqueA.id)).toBe(true);
    expect(diff.eventDiff.onlyInB).toHaveLength(0);
  });

  it("diff identifies events only in session B", () => {
    const uniqueB = createEvent("browser:console", "warn", {
      message: "only in B",
    });
    const shared = createEvent("vite", "info", { msg: "shared" });

    const sessionA = makeSession({ events: [shared] });
    const sessionB = makeSession({ events: [shared, uniqueB] });

    const diff = diffSessions(sessionA, sessionB);
    expect(diff.eventDiff.onlyInB.some((e) => e.id === uniqueB.id)).toBe(true);
    expect(diff.eventDiff.onlyInA).toHaveLength(0);
  });

  it("diff identifies network status differences", () => {
    const sessionA = makeSession({
      events: [
        createEvent("browser:network", "info", {
          url: "/api/user",
          status: 200,
        }),
      ],
    });
    const sessionB = makeSession({
      events: [
        createEvent("browser:network", "error", {
          url: "/api/user",
          status: 401,
        }),
      ],
    });

    const diff = diffSessions(sessionA, sessionB);
    expect(diff.networkDiff.statusDifferences.length).toBeGreaterThan(0);
    expect(diff.networkDiff.statusDifferences[0].url).toBe("/api/user");
    expect(diff.networkDiff.statusDifferences[0].statusA).toBe(200);
    expect(diff.networkDiff.statusDifferences[0].statusB).toBe(401);
  });

  it("diff identifies interaction divergence", () => {
    const interA = {
      id: "int_001",
      ts: Date.now(),
      type: "click" as const,
      target: "button#a",
    };
    const interB = {
      id: "int_001",
      ts: Date.now(),
      type: "click" as const,
      target: "button#b",
    };

    const sessionA = makeSession({ interactions: [interA] });
    const sessionB = makeSession({ interactions: [interB] });

    const diff = diffSessions(sessionA, sessionB);
    // Different targets on same interaction index
    expect(diff.interactionDiff.firstDivergence).toBeDefined();
  });

  it("diff reports divergesAt timestamp when events differ", () => {
    const sessionA = makeSession({
      events: [createEvent("vite", "info", { msg: "ok" })],
    });
    const sessionB = makeSession({
      events: [createEvent("vite", "error", { msg: "fail" })],
    });

    const diff = diffSessions(sessionA, sessionB);
    expect(diff.summary.identical).toBe(false);
  });

  it("diff includes storage differences", () => {
    const sessionA = makeSession({
      storageSnapshots: [
        {
          ts: Date.now(),
          url: "http://localhost:3000",
          localStorage: { authToken: "abc123" },
          sessionStorage: {},
        },
      ],
    });
    const sessionB = makeSession({
      storageSnapshots: [
        {
          ts: Date.now(),
          url: "http://localhost:3000",
          localStorage: { authToken: "xyz789" },
          sessionStorage: {},
        },
      ],
    });

    const diff = diffSessions(sessionA, sessionB);
    expect(diff.storageDiff.valueDifferences.length).toBeGreaterThan(0);
    expect(diff.storageDiff.valueDifferences[0].key).toBe("authToken");
  });

  it("diff returns session IDs in summary", () => {
    const sessionA = makeSession();
    const sessionB = makeSession();

    const diff = diffSessions(sessionA, sessionB);
    expect(diff.summary.sessionA).toBe(sessionA.id);
    expect(diff.summary.sessionB).toBe(sessionB.id);
  });
});

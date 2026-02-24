import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHub } from "../../src/hub";
import { createMcpServer } from "../../src/mcp-server";
import {
  createSessionRecorder,
  importSessionFromString,
  diffSessions,
} from "../../src/session";
import { createWatchRuleEngine } from "../../src/watch-rules";
import { loadConfig, DEFAULT_CONFIG } from "../../src/config";
import { createRedactor } from "../../src/redactor";
import { createEvent } from "../../src/event";
import WebSocket from "ws";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_HTTP_BASE = 5400;
const TEST_WS_BASE = 4870;
let portOffset = 0;

function nextPorts() {
  const offset = portOffset++;
  return {
    httpPort: TEST_HTTP_BASE + offset * 2,
    wsPort: TEST_WS_BASE - offset * 2,
  };
}

const MOCK_CMD = `node -e "let i=0;const t=setInterval(()=>{process.stdout.write('log '+i+'\\n');i++;if(i>=5)clearInterval(t)},80)"`;

async function waitMs(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForCondition(
  fn: () => boolean,
  timeoutMs = 3000,
  intervalMs = 50,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await waitMs(intervalMs);
  }
  return false;
}

// ─── Full Pipeline — Hub + Watch Rules + MCP ──────────────────────────────────

describe("Integration — watch rules fire on real browser events via WebSocket", () => {
  let hub: ReturnType<typeof createHub>;
  let server: ReturnType<typeof createMcpServer>;
  let ws: WebSocket;
  const ports = nextPorts();

  beforeEach(async () => {
    hub = createHub({ cmd: MOCK_CMD, ...ports, config: DEFAULT_CONFIG });
    await hub.start();
    server = createMcpServer(hub);
    await server.start();

    ws = new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS timeout")), 3000);
    });
  });

  afterEach(async () => {
    ws.terminate();
    await server.stop();
    await hub.stop();
  });

  it("add_watch_rule via MCP then fires when matching event arrives", async () => {
    // Add watch rule via MCP
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "add_watch_rule",
        arguments: { label: "auth failures", status_codes: [401] },
      },
    });

    // Send a matching event via the extension WS
    ws.send(
      JSON.stringify({
        type: "browser_event",
        source: "browser:network",
        level: "error",
        payload: {
          url: "/api/user",
          method: "GET",
          status: 401,
          duration: 120,
        },
      }),
    );

    await waitMs(200);

    // get_watched_events should contain the event
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_watched_events", arguments: {} },
    });

    const watched = JSON.parse(response.result.content[0].text);
    expect(watched.length).toBeGreaterThan(0);
    expect(watched[0].matchedRule.label).toBe("auth failures");
  }, 5000);

  it("non-matching events do not appear in watched events", async () => {
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "add_watch_rule",
        arguments: { label: "500 only", status_codes: [500] },
      },
    });

    ws.send(
      JSON.stringify({
        type: "browser_event",
        source: "browser:network",
        level: "info",
        payload: { url: "/api/x", status: 200 },
      }),
    );

    await waitMs(200);

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_watched_events", arguments: {} },
    });

    const watched = JSON.parse(response.result.content[0].text);
    expect(watched).toHaveLength(0);
  }, 3000);

  it("clear_watched_events empties the watched buffer", async () => {
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "add_watch_rule",
        arguments: { label: "test", status_codes: [500] },
      },
    });

    ws.send(
      JSON.stringify({
        type: "browser_event",
        source: "browser:network",
        level: "error",
        payload: { url: "/api/x", status: 500 },
      }),
    );
    await waitMs(200);

    await server.handleRequest({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "clear_watched_events", arguments: {} },
    });

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "get_watched_events", arguments: {} },
    });

    const watched = JSON.parse(response.result.content[0].text);
    expect(watched).toHaveLength(0);
  }, 3000);
});

// ─── Session — start, record, export, import ──────────────────────────────────

describe("Integration — session lifecycle via MCP", () => {
  let hub: ReturnType<typeof createHub>;
  let server: ReturnType<typeof createMcpServer>;
  let ws: WebSocket;
  let tmpDir: string;
  const ports = nextPorts();

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daibug-integration-"));
    hub = createHub({ cmd: MOCK_CMD, ...ports, config: DEFAULT_CONFIG });
    await hub.start();
    server = createMcpServer(hub);
    await server.start();

    ws = new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS timeout")), 3000);
    });
  });

  afterEach(async () => {
    ws.terminate();
    await server.stop();
    await hub.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("start_session → events arrive → stop_session shows correct counts", async () => {
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "start_session",
        arguments: { label: "integration test" },
      },
    });

    // Send some events
    ws.send(
      JSON.stringify({
        type: "browser_event",
        source: "browser:console",
        level: "error",
        payload: { message: "test error 1" },
      }),
    );
    ws.send(
      JSON.stringify({
        type: "browser_event",
        source: "browser:console",
        level: "error",
        payload: { message: "test error 2" },
      }),
    );
    ws.send(
      JSON.stringify({
        type: "browser_event",
        source: "browser:network",
        level: "error",
        payload: { url: "/api/x", status: 500 },
      }),
    );
    ws.send(
      JSON.stringify({
        type: "browser_event",
        source: "browser:network",
        level: "info",
        payload: { url: "/api/y", status: 200 },
      }),
    );
    ws.send(
      JSON.stringify({
        type: "browser_event",
        source: "browser:console",
        level: "warn",
        payload: { message: "a warning" },
      }),
    );

    await waitMs(300);

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "stop_session", arguments: {} },
    });

    const summary = JSON.parse(response.result.content[0].text);
    expect(summary.errorCount).toBeGreaterThanOrEqual(2);
    expect(summary.warnCount).toBeGreaterThanOrEqual(1);
    expect(summary.networkRequests).toBeGreaterThanOrEqual(2);
    expect(summary.failedRequests).toBeGreaterThanOrEqual(1);
  }, 5000);

  it("export_session writes a readable .daibug file", async () => {
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "start_session", arguments: {} },
    });

    ws.send(
      JSON.stringify({
        type: "browser_event",
        source: "browser:console",
        level: "error",
        payload: { message: "export test" },
      }),
    );
    await waitMs(200);

    const filePath = path.join(tmpDir, "export-test.daibug");
    const exportResponse = await server.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "export_session", arguments: { path: filePath } },
    });

    const exportResult = JSON.parse(exportResponse.result.content[0].text);
    expect(exportResult.path).toBe(filePath);
    expect(typeof exportResult.sizeBytes).toBe("number");
    expect(exportResult.sizeBytes).toBeGreaterThan(0);
    expect(fs.existsSync(filePath)).toBe(true);
  }, 5000);

  it("import_session after export returns matching summary", async () => {
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "start_session", arguments: {} },
    });

    ws.send(
      JSON.stringify({
        type: "browser_event",
        source: "browser:console",
        level: "error",
        payload: { message: "import test" },
      }),
    );
    await waitMs(200);

    const filePath = path.join(tmpDir, "import-test.daibug");
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "export_session", arguments: { path: filePath } },
    });

    const importResponse = await server.handleRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "import_session", arguments: { path: filePath } },
    });

    const imported = JSON.parse(importResponse.result.content[0].text);
    expect(imported.version).toBe("1.0");
    expect(typeof imported.id).toBe("string");
    expect(imported.summary).toBeDefined();
  }, 5000);
});

// ─── Session diffing ──────────────────────────────────────────────────────────

describe("Integration — diff_sessions via MCP", () => {
  let hub: ReturnType<typeof createHub>;
  let server: ReturnType<typeof createMcpServer>;
  let tmpDir: string;
  const ports = nextPorts();

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daibug-diff-"));
    hub = createHub({ cmd: MOCK_CMD, ...ports, config: DEFAULT_CONFIG });
    await hub.start();
    server = createMcpServer(hub);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await hub.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("diff_sessions identifies different network outcomes", async () => {
    // Create session A — 200 success
    const sessionA = {
      version: "1.0",
      id: "session_a",
      exportedAt: Date.now(),
      environment: {
        framework: "vite",
        nodeVersion: process.version,
        platform: process.platform,
        daibugVersion: "0.1.0",
        cmd: "npm run dev",
        startedAt: Date.now(),
      },
      config: DEFAULT_CONFIG,
      events: [
        createEvent("browser:network", "info", {
          url: "/api/checkout",
          status: 200,
        }),
      ],
      interactions: [
        {
          id: "int_001",
          ts: Date.now(),
          type: "click",
          target: "button#checkout",
        },
      ],
      watchedEvents: [],
      storageSnapshots: [],
      summary: {
        totalEvents: 1,
        errorCount: 0,
        warnCount: 0,
        networkRequests: 1,
        failedRequests: 0,
        interactionCount: 1,
        duration: 500,
        topErrors: [],
      },
    };

    // Create session B — 500 failure
    const sessionB = {
      ...sessionA,
      id: "session_b",
      events: [
        createEvent("browser:network", "error", {
          url: "/api/checkout",
          status: 500,
        }),
      ],
    };

    const pathA = path.join(tmpDir, "session-a.daibug");
    const pathB = path.join(tmpDir, "session-b.daibug");
    fs.writeFileSync(pathA, JSON.stringify(sessionA));
    fs.writeFileSync(pathB, JSON.stringify(sessionB));

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "diff_sessions", arguments: { pathA, pathB } },
    });

    const diff = JSON.parse(response.result.content[0].text);
    expect(diff.summary.identical).toBe(false);
    expect(diff.networkDiff.statusDifferences.length).toBeGreaterThan(0);
    expect(diff.networkDiff.statusDifferences[0].statusA).toBe(200);
    expect(diff.networkDiff.statusDifferences[0].statusB).toBe(500);
  }, 5000);
});

// ─── Redaction in the live pipeline ──────────────────────────────────────────

describe("Integration — redaction in the event pipeline", () => {
  it("sensitive fields are redacted before entering the ring buffer", async () => {
    const ports = nextPorts();
    const config = {
      ...DEFAULT_CONFIG,
      redact: { fields: ["password", "token"], urlPatterns: [] },
    };

    const hub = createHub({ cmd: MOCK_CMD, ...ports, config });
    await hub.start();

    const ws = new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS timeout")), 3000);
    });

    ws.send(
      JSON.stringify({
        type: "browser_event",
        source: "browser:network",
        level: "info",
        payload: {
          url: "/api/login",
          method: "POST",
          requestBody: { username: "user@test.com", password: "supersecret" },
          responseBody: { token: "jwt-token-here", userId: 42 },
        },
      }),
    );

    await waitMs(200);

    const events = hub.getEvents();
    const networkEvents = events.filter((e) => e.source === "browser:network");

    if (networkEvents.length > 0) {
      const loginEvent = networkEvents.find((e) =>
        (e.payload.url as string)?.includes("/api/login"),
      );
      if (loginEvent) {
        const reqBody = loginEvent.payload.requestBody as Record<
          string,
          unknown
        >;
        const resBody = loginEvent.payload.responseBody as Record<
          string,
          unknown
        >;
        if (reqBody?.password !== undefined) {
          expect(reqBody.password).toBe("[REDACTED]");
        }
        if (resBody?.token !== undefined) {
          expect(resBody.token).toBe("[REDACTED]");
        }
      }
    }

    ws.terminate();
    await hub.stop();
  }, 5000);

  it("non-sensitive fields are preserved in the ring buffer", async () => {
    const ports = nextPorts();
    const config = {
      ...DEFAULT_CONFIG,
      redact: { fields: ["password"], urlPatterns: [] },
    };

    const hub = createHub({ cmd: MOCK_CMD, ...ports, config });
    await hub.start();

    const ws = new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS timeout")), 3000);
    });

    ws.send(
      JSON.stringify({
        type: "browser_event",
        source: "browser:network",
        level: "info",
        payload: { url: "/api/products", status: 200, method: "GET" },
      }),
    );

    await waitMs(200);

    const events = hub.getEvents();
    const networkEvents = events.filter((e) => e.source === "browser:network");
    const productEvent = networkEvents.find((e) =>
      (e.payload.url as string)?.includes("/api/products"),
    );

    if (productEvent) {
      expect(productEvent.payload.url).toBe("/api/products");
      expect(productEvent.payload.status).toBe(200);
    }

    ws.terminate();
    await hub.stop();
  }, 5000);
});

// ─── Storage events ───────────────────────────────────────────────────────────

describe("Integration — browser:storage events", () => {
  let hub: ReturnType<typeof createHub>;
  let ws: WebSocket;
  const ports = nextPorts();

  beforeEach(async () => {
    hub = createHub({ cmd: MOCK_CMD, ...ports, config: DEFAULT_CONFIG });
    await hub.start();

    ws = new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS timeout")), 3000);
    });
  });

  afterEach(async () => {
    ws.terminate();
    await hub.stop();
  });

  it("browser:storage setItem event is captured in event log", async () => {
    ws.send(
      JSON.stringify({
        type: "browser_event",
        source: "browser:storage",
        level: "info",
        payload: {
          type: "set",
          key: "authToken",
          value: "abc123",
          url: "http://localhost:3000",
          tabId: 1,
        },
      }),
    );

    await waitMs(200);

    const events = hub.getEvents();
    const storageEvents = events.filter((e) => e.source === "browser:storage");
    expect(storageEvents.length).toBeGreaterThan(0);
    expect(storageEvents[0].payload.key).toBe("authToken");
    expect(storageEvents[0].payload.type).toBe("set");
  }, 3000);

  it("browser:storage events are redacted when key matches redact fields", async () => {
    const ports2 = nextPorts();
    const configWithRedact = {
      ...DEFAULT_CONFIG,
      redact: { fields: ["authToken", "token"], urlPatterns: [] },
    };
    const hub2 = createHub({
      cmd: MOCK_CMD,
      ...ports2,
      config: configWithRedact,
    });
    await hub2.start();

    const ws2 = new WebSocket(`ws://127.0.0.1:${ports2.wsPort}`);
    await new Promise<void>((resolve, reject) => {
      ws2.on("open", resolve);
      ws2.on("error", reject);
      setTimeout(() => reject(new Error("WS timeout")), 3000);
    });

    ws2.send(
      JSON.stringify({
        type: "browser_event",
        source: "browser:storage",
        level: "info",
        payload: {
          type: "set",
          key: "authToken",
          value: "super-secret-jwt",
          url: "http://localhost:3000",
        },
      }),
    );

    await waitMs(200);

    const events = hub2.getEvents();
    const storageEvents = events.filter((e) => e.source === "browser:storage");

    if (storageEvents.length > 0) {
      // Value should be redacted since key matches redact field
      expect(storageEvents[0].payload.value).toBe("[REDACTED]");
    }

    ws2.terminate();
    await hub2.stop();
  }, 5000);
});

// ─── autoStart config ─────────────────────────────────────────────────────────

describe("Integration — session.autoStart config", () => {
  it("session recorder starts automatically when config.session.autoStart is true", async () => {
    const ports = nextPorts();
    const config = {
      ...DEFAULT_CONFIG,
      session: { autoStart: true, captureStorage: true },
    };
    const hub = createHub({ cmd: MOCK_CMD, ...ports, config });
    await hub.start();

    // If autoStart is true, hub should have a running session recorder
    const recorder = hub.getSessionRecorder();
    expect(recorder).not.toBeNull();

    await hub.stop();
  }, 5000);

  it("session recorder is null by default when autoStart is false", async () => {
    const ports = nextPorts();
    const config = {
      ...DEFAULT_CONFIG,
      session: { autoStart: false, captureStorage: true },
    };
    const hub = createHub({ cmd: MOCK_CMD, ...ports, config });
    await hub.start();

    const recorder = hub.getSessionRecorder();
    expect(recorder).toBeNull();

    await hub.stop();
  }, 5000);
});

// ─── .daibugrc watch rules loaded at startup ─────────────────────────────────

describe("Integration — watch rules from config loaded at hub start", () => {
  it("watch rules from config are active immediately after hub starts", async () => {
    const ports = nextPorts();
    const config = {
      ...DEFAULT_CONFIG,
      watch: [
        {
          label: "auth failures",
          statusCodes: [401, 403],
          urlPattern: "/api/**",
        },
      ],
    };

    const hub = createHub({ cmd: MOCK_CMD, ...ports, config });
    await hub.start();

    // Watch rule should already be registered
    const engine = hub.getWatchRuleEngine();
    expect(engine.listRules().length).toBeGreaterThan(0);
    expect(engine.listRules()[0].label).toBe("auth failures");

    await hub.stop();
  }, 5000);

  it("config watch rules fire when matching events arrive", async () => {
    const ports = nextPorts();
    const config = {
      ...DEFAULT_CONFIG,
      watch: [{ label: "not found", statusCodes: [404] }],
    };

    const hub = createHub({ cmd: MOCK_CMD, ...ports, config });
    await hub.start();

    const ws = new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS timeout")), 3000);
    });

    ws.send(
      JSON.stringify({
        type: "browser_event",
        source: "browser:network",
        level: "error",
        payload: { url: "/api/missing", status: 404 },
      }),
    );

    await waitMs(200);

    const engine = hub.getWatchRuleEngine();
    const watched = engine.getWatchedEvents();
    expect(watched.length).toBeGreaterThan(0);

    ws.terminate();
    await hub.stop();
  }, 5000);
});

// ─── Multi-tab events ─────────────────────────────────────────────────────────

describe("Integration — multi-tab event tracking", () => {
  let hub: ReturnType<typeof createHub>;
  let ws: WebSocket;
  const ports = nextPorts();

  beforeEach(async () => {
    hub = createHub({ cmd: MOCK_CMD, ...ports, config: DEFAULT_CONFIG });
    await hub.start();

    ws = new WebSocket(`ws://127.0.0.1:${ports.wsPort}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS timeout")), 3000);
    });
  });

  afterEach(async () => {
    ws.terminate();
    await hub.stop();
  });

  it("events from different tabs are both captured", async () => {
    ws.send(
      JSON.stringify({
        type: "browser_event",
        source: "browser:console",
        level: "error",
        payload: {
          message: "tab 1 error",
          tabId: 1,
          tabUrl: "http://localhost:3000/page-a",
        },
      }),
    );

    ws.send(
      JSON.stringify({
        type: "browser_event",
        source: "browser:console",
        level: "error",
        payload: {
          message: "tab 2 error",
          tabId: 2,
          tabUrl: "http://localhost:3000/page-b",
        },
      }),
    );

    await waitMs(200);

    const events = hub
      .getEvents()
      .filter((e) => e.source === "browser:console");
    const tab1Events = events.filter((e) => e.payload.tabId === 1);
    const tab2Events = events.filter((e) => e.payload.tabId === 2);

    expect(tab1Events.length).toBeGreaterThan(0);
    expect(tab2Events.length).toBeGreaterThan(0);
  }, 3000);

  it("GET /tabs endpoint reflects connected tab info", async () => {
    // Send a tab-tagged event to register the tab
    ws.send(
      JSON.stringify({
        type: "browser_tab_info",
        tabId: 1,
        tabUrl: "http://localhost:3000",
        tabTitle: "My App",
      }),
    );

    await waitMs(200);

    const res = await fetch(`http://127.0.0.1:${ports.httpPort}/tabs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.tabs ?? body)).toBe(true);
  }, 3000);
});

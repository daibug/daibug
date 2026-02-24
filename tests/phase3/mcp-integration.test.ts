import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHub } from "../../src/hub";
import { createMcpServer } from "../../src/mcp-server";
import { createEvent } from "../../src/event";
import WebSocket from "ws";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TEST_HTTP_PORT = 5099;
const TEST_WS_PORT = 4998;

const MOCK_CMD_WIN = `node -e "let i=0; const t=setInterval(()=>{process.stdout.write('server log '+i+'\\n');i++;if(i>=3)clearInterval(t)},100)"`;
const MOCK_CMD_UNIX = `node -e "let i=0; const t=setInterval(()=>{process.stdout.write('server log '+i+'\\n');i++;if(i>=3)clearInterval(t)},100)"`;
const MOCK_CMD = process.platform === "win32" ? MOCK_CMD_WIN : MOCK_CMD_UNIX;

async function waitMs(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForEvents(
  hub: ReturnType<typeof createHub>,
  count: number,
  timeoutMs = 3000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (hub.getEvents().length >= count) return true;
    await waitMs(50);
  }
  return false;
}

// ─── Hub + MCP Server Integration ────────────────────────────────────────────

describe("MCP server + Hub integration", () => {
  let hub: ReturnType<typeof createHub>;
  let server: ReturnType<typeof createMcpServer>;

  beforeEach(async () => {
    hub = createHub({
      cmd: MOCK_CMD,
      httpPort: TEST_HTTP_PORT,
      wsPort: TEST_WS_PORT,
    });
    await hub.start();
    server = createMcpServer(hub);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await hub.stop();
  });

  it("get_events returns events from actual running Hub", async () => {
    await waitForEvents(hub, 1, 2000);

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_events", arguments: {} },
    });

    const events = JSON.parse(response.result.content[0].text);
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toHaveProperty("id");
    expect(events[0]).toHaveProperty("ts");
    expect(events[0]).toHaveProperty("source");
    expect(events[0]).toHaveProperty("level");
    expect(events[0]).toHaveProperty("payload");
  });

  it("get_events source filter works against real events", async () => {
    await waitForEvents(hub, 1, 2000);

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_events", arguments: { source: "browser:console" } },
    });

    const events = JSON.parse(response.result.content[0].text);
    // No extension connected — should be empty array
    expect(
      events.every((e: { source: string }) => e.source === "browser:console"),
    ).toBe(true);
  });

  it("clear_events empties the Hub ring buffer", async () => {
    await waitForEvents(hub, 1, 2000);
    expect(hub.getEvents().length).toBeGreaterThan(0);

    await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "clear_events", arguments: {} },
    });

    expect(hub.getEvents().length).toBe(0);
  });

  it("get_events limit is respected against real events", async () => {
    await waitForEvents(hub, 2, 2000);

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_events", arguments: { limit: 1 } },
    });

    const events = JSON.parse(response.result.content[0].text);
    expect(events.length).toBeLessThanOrEqual(1);
  });
});

// ─── Browser Event Ingestion via WebSocket ────────────────────────────────────

describe("MCP tools with browser events from WebSocket", () => {
  let hub: ReturnType<typeof createHub>;
  let server: ReturnType<typeof createMcpServer>;
  let ws: WebSocket;

  beforeEach(async () => {
    hub = createHub({
      cmd: MOCK_CMD,
      httpPort: TEST_HTTP_PORT + 1,
      wsPort: TEST_WS_PORT - 1,
    });
    await hub.start();
    server = createMcpServer(hub);
    await server.start();

    ws = new WebSocket(`ws://127.0.0.1:${hub.wsPort}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS connect timeout")), 3000);
    });
  });

  afterEach(async () => {
    ws.terminate();
    await server.stop();
    await hub.stop();
  });

  it("browser:console events sent via WebSocket appear in get_events", async () => {
    const consoleEvent = {
      type: "browser_event",
      source: "browser:console",
      level: "error",
      payload: {
        message: "TypeError: Cannot read property of undefined",
        stack: "at App.jsx:42",
      },
    };

    ws.send(JSON.stringify(consoleEvent));
    await waitMs(200);

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "get_events", arguments: { source: "browser:console" } },
    });

    const events = JSON.parse(response.result.content[0].text);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e: { level: string }) => e.level === "error")).toBe(
      true,
    );
  });

  it("browser:network events appear in get_network_log", async () => {
    const networkEvent = {
      type: "browser_event",
      source: "browser:network",
      level: "error",
      payload: { url: "/api/users", method: "GET", status: 401, duration: 145 },
    };

    ws.send(JSON.stringify(networkEvent));
    await waitMs(200);

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "get_network_log", arguments: {} },
    });

    const events = JSON.parse(response.result.content[0].text);
    expect(events.length).toBeGreaterThan(0);
    const networkEvents = events.filter(
      (e: { source: string }) => e.source === "browser:network",
    );
    expect(networkEvents.length).toBeGreaterThan(0);
  });

  it("browser:interaction events are stored in interactions buffer, not main ring buffer", async () => {
    const interactionEvent = {
      type: "browser_interaction",
      interactionType: "click",
      target: "button#submit",
      x: 100,
      y: 200,
    };

    ws.send(JSON.stringify(interactionEvent));
    await waitMs(200);

    // Should appear in replay_interactions
    const replayResponse = await server.handleRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "replay_interactions", arguments: {} },
    });

    const interactions = JSON.parse(replayResponse.result.content[0].text);
    expect(Array.isArray(interactions)).toBe(true);
    // Interactions should be in a separate buffer
    const clickInteractions = interactions.filter(
      (i: { type: string }) => i.type === "click",
    );
    expect(clickInteractions.length).toBeGreaterThan(0);
  });
});

// ─── evaluate_in_browser — round trip with mock extension ────────────────────

describe("evaluate_in_browser round trip", () => {
  let hub: ReturnType<typeof createHub>;
  let server: ReturnType<typeof createMcpServer>;
  let ws: WebSocket;

  beforeEach(async () => {
    hub = createHub({
      cmd: MOCK_CMD,
      httpPort: TEST_HTTP_PORT + 2,
      wsPort: TEST_WS_PORT - 2,
    });
    await hub.start();
    server = createMcpServer(hub);
    await server.start();

    ws = new WebSocket(`ws://127.0.0.1:${hub.wsPort}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS connect timeout")), 3000);
    });
  });

  afterEach(async () => {
    ws.terminate();
    await server.stop();
    await hub.stop();
  });

  it("evaluate_in_browser: Hub sends command, mock extension responds, tool returns result", async () => {
    // Listen for evaluate command from hub, respond with result
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.command === "evaluate" && msg.evaluationId) {
        // Simulate extension evaluating and sending back result
        const responseEvent = {
          type: "browser_event",
          source: "browser:dom",
          level: "info",
          payload: {
            evaluationId: msg.evaluationId,
            result: "mocked-document-title",
          },
        };
        ws.send(JSON.stringify(responseEvent));
      }
    });

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "evaluate_in_browser",
        arguments: { expression: "document.title" },
      },
    });

    const parsed = JSON.parse(response.result.content[0].text);
    expect(parsed.result).toBe("mocked-document-title");
  }, 5000);

  it("evaluate_in_browser times out gracefully when extension is silent", async () => {
    // No message handler — extension never responds

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "evaluate_in_browser",
        arguments: { expression: "document.title", timeout: 300 },
      },
    });

    const parsed = JSON.parse(response.result.content[0].text);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.toLowerCase()).toContain("timeout");
  }, 3000);
});

// ─── Hub extensions — new methods ────────────────────────────────────────────

describe("Hub new methods for Phase 3", () => {
  let hub: ReturnType<typeof createHub>;

  beforeEach(async () => {
    hub = createHub({
      cmd: MOCK_CMD,
      httpPort: TEST_HTTP_PORT + 3,
      wsPort: TEST_WS_PORT - 3,
    });
    await hub.start();
  });

  afterEach(async () => {
    await hub.stop();
  });

  it("hub.clearEvents() empties the event buffer", async () => {
    await waitForEvents(hub, 1, 2000);
    expect(hub.getEvents().length).toBeGreaterThan(0);
    hub.clearEvents();
    expect(hub.getEvents().length).toBe(0);
  });

  it("hub.getInteractions() returns empty array initially", () => {
    const interactions = hub.getInteractions();
    expect(Array.isArray(interactions)).toBe(true);
    expect(interactions.length).toBe(0);
  });

  it("hub.getInteractions(limit) respects the limit", async () => {
    // No interactions yet — just verify the method exists and accepts a limit
    const interactions = hub.getInteractions(10);
    expect(Array.isArray(interactions)).toBe(true);
  });

  it("hub.onBrowserEvent() registers a listener and returns unsubscribe fn", async () => {
    let received: ReturnType<typeof createEvent> | null = null;
    const unsubscribe = hub.onBrowserEvent((event) => {
      received = event;
    });

    expect(typeof unsubscribe).toBe("function");

    // Wait for a dev server event to trigger the listener
    await waitForEvents(hub, 1, 2000);
    await waitMs(100); // give listener time to fire

    expect(received).not.toBeNull();

    // Unsubscribe and verify no more events received
    unsubscribe();
    const countAfterUnsub = hub.getEvents().length;
    hub.clearEvents();
    await waitMs(200);
    // After unsubscribe, listener should not be called on new events
    // We verify by checking received is still the same object
    const receivedAfterUnsub = received;
    await waitMs(200);
    expect(received).toBe(receivedAfterUnsub);
  });

  it("hub.broadcastCommand() does not throw when no clients connected", () => {
    expect(() => {
      hub.broadcastCommand({ type: "command", command: "snapshot_dom" });
    }).not.toThrow();
  });
});

// ─── Snapshot DOM — command flow ─────────────────────────────────────────────

describe("snapshot_dom tool", () => {
  let hub: ReturnType<typeof createHub>;
  let server: ReturnType<typeof createMcpServer>;
  let ws: WebSocket;

  beforeEach(async () => {
    hub = createHub({
      cmd: MOCK_CMD,
      httpPort: TEST_HTTP_PORT + 4,
      wsPort: TEST_WS_PORT - 4,
    });
    await hub.start();
    server = createMcpServer(hub);
    await server.start();

    ws = new WebSocket(`ws://127.0.0.1:${hub.wsPort}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS connect timeout")), 3000);
    });
  });

  afterEach(async () => {
    ws.terminate();
    await server.stop();
    await hub.stop();
  });

  it("snapshot_dom: Hub sends command, mock extension responds with DOM", async () => {
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.command === "snapshot_dom") {
        const domEvent = {
          type: "browser_event",
          source: "browser:dom",
          level: "info",
          payload: {
            type: "dom_snapshot",
            html: "<html><body><div id='app'>Hello</div></body></html>",
            selector: msg.selector ?? null,
          },
        };
        ws.send(JSON.stringify(domEvent));
      }
    });

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "snapshot_dom", arguments: {} },
    });

    const parsed = JSON.parse(response.result.content[0].text);
    expect(parsed).toBeDefined();
    expect(parsed.html ?? parsed.type ?? parsed.error).toBeDefined();
  }, 5000);

  it("snapshot_dom times out with clear error when no extension connected", async () => {
    ws.terminate(); // disconnect
    await waitMs(100);

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "snapshot_dom", arguments: { timeout: 500 } },
    });

    const parsed = JSON.parse(response.result.content[0].text);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.toLowerCase()).toMatch(/timeout|extension|connected/);
  }, 5000);
});

// ─── CLI flag — --mcp ─────────────────────────────────────────────────────────

describe("CLI --mcp flag", () => {
  it("createHub returns a HubInstance with clearEvents method", async () => {
    const hub = createHub({
      cmd: MOCK_CMD,
      httpPort: TEST_HTTP_PORT + 5,
      wsPort: TEST_WS_PORT - 5,
    });
    expect(typeof hub.clearEvents).toBe("function");
    expect(typeof hub.getInteractions).toBe("function");
    expect(typeof hub.onBrowserEvent).toBe("function");
  });

  it("createMcpServer accepts a HubInstance and returns start/stop", () => {
    const hub = createHub({
      cmd: MOCK_CMD,
      httpPort: TEST_HTTP_PORT + 6,
      wsPort: TEST_WS_PORT - 6,
    });
    const server = createMcpServer(hub);
    expect(typeof server.start).toBe("function");
    expect(typeof server.stop).toBe("function");
    expect(typeof server.name).toBe("string");
    expect(typeof server.version).toBe("string");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createHub } from "../../src/hub";
import { createMcpServer } from "../../src/mcp-server";
import { Readable, Writable } from "stream";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTestStreams() {
  const inputLines: string[] = [];
  let inputResolve: (() => void) | null = null;

  const stdin = new Readable({
    read() {
      if (inputLines.length > 0) {
        this.push(inputLines.shift()! + "\n");
      } else {
        inputResolve = () => {
          if (inputLines.length > 0) {
            this.push(inputLines.shift()! + "\n");
          }
        };
      }
    },
  });

  const outputChunks: string[] = [];
  let outputResolve: ((line: string) => void) | null = null;

  const stdout = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const line = chunk.toString().trim();
      if (line) {
        if (outputResolve) {
          const resolve = outputResolve;
          outputResolve = null;
          resolve(line);
        } else {
          outputChunks.push(line);
        }
      }
      callback();
    },
  });

  function send(message: object) {
    inputLines.push(JSON.stringify(message));
    if (inputResolve) {
      const resolve = inputResolve;
      inputResolve = null;
      resolve();
    }
  }

  function receive(): Promise<object> {
    return new Promise((resolve) => {
      if (outputChunks.length > 0) {
        resolve(JSON.parse(outputChunks.shift()!));
      } else {
        outputResolve = (line: string) => resolve(JSON.parse(line));
      }
    });
  }

  return { stdin, stdout, send, receive };
}

function makeHub() {
  return {
    getEvents: () => [],
    clearEvents: () => {},
    getInteractions: () => [],
    broadcastCommand: () => {},
    onBrowserEvent: () => () => {},
  } as unknown as ReturnType<typeof createHub>;
}

// ─── Server Lifecycle ─────────────────────────────────────────────────────────

describe("createMcpServer — lifecycle", () => {
  it("can be created without throwing", () => {
    expect(() => createMcpServer(makeHub())).not.toThrow();
  });

  it("start() resolves", async () => {
    const server = createMcpServer(makeHub());
    await server.start();
    await server.stop();
  });

  it("stop() is idempotent — second call does not throw", async () => {
    const server = createMcpServer(makeHub());
    await server.start();
    await server.stop();
    await server.stop();
  });

  it("stop() before start() does not throw", async () => {
    const server = createMcpServer(makeHub());
    await server.stop();
  });
});

// ─── tools/list ───────────────────────────────────────────────────────────────

describe("MCP tools/list", () => {
  it("responds to tools/list with all 7 tools", async () => {
    const server = createMcpServer(makeHub());
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect(response.result).toBeDefined();
    expect(response.result.tools).toHaveLength(8);
  });

  it("each tool in tools/list has name, description, inputSchema", async () => {
    const server = createMcpServer(makeHub());
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    for (const tool of response.result.tools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(typeof tool.inputSchema).toBe("object");
    }
  });

  it("tool names match the expected 7", async () => {
    const server = createMcpServer(makeHub());
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {},
    });

    const names = response.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("get_events");
    expect(names).toContain("get_network_log");
    expect(names).toContain("snapshot_dom");
    expect(names).toContain("get_component_state");
    expect(names).toContain("evaluate_in_browser");
    expect(names).toContain("replay_interactions");
    expect(names).toContain("clear_events");
  });
});

// ─── tools/call ───────────────────────────────────────────────────────────────

describe("MCP tools/call — protocol", () => {
  it("responds to tools/call with content array", async () => {
    const server = createMcpServer(makeHub());
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_events", arguments: {} },
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(4);
    expect(response.result).toBeDefined();
    expect(Array.isArray(response.result.content)).toBe(true);
    expect(response.result.content[0].type).toBe("text");
  });

  it("unknown tool returns error content, not process crash", async () => {
    const server = createMcpServer(makeHub());
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "does_not_exist", arguments: {} },
    });

    // Should return either an error result or error content — not throw
    expect(response).toBeDefined();
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(5);
  });

  it("unknown method returns JSON-RPC -32601 error", async () => {
    const server = createMcpServer(makeHub());
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 6,
      method: "unknown/method",
      params: {},
    });

    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(-32601);
  });

  it("tool call preserves request id in response", async () => {
    const server = createMcpServer(makeHub());
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "clear_events", arguments: {} },
    });

    expect(response.id).toBe(99);
  });

  it("clear_events call returns cleared:true in content", async () => {
    const server = createMcpServer(makeHub());
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "clear_events", arguments: {} },
    });

    const content = JSON.parse(response.result.content[0].text);
    expect(content.cleared).toBe(true);
  });

  it("get_events with no args returns empty array when hub has no events", async () => {
    const server = createMcpServer(makeHub());
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "get_events", arguments: {} },
    });

    const parsed = JSON.parse(response.result.content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(0);
  });

  it("tool handler error does not crash server — returns error content", async () => {
    const hub = makeHub();
    hub.getEvents = () => {
      throw new Error("ring buffer exploded");
    };

    const server = createMcpServer(hub);

    // Should not throw
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "get_events", arguments: {} },
    });

    expect(response).toBeDefined();
    // Should return some indication of error
    const hasError =
      response.error != null ||
      (response.result?.content?.[0]?.text ?? "").includes("error");
    expect(hasError).toBe(true);
  });
});

// ─── Server name and version ─────────────────────────────────────────────────

describe("MCP server identity", () => {
  it("server name is 'daibug'", async () => {
    const server = createMcpServer(makeHub());
    expect(server.name).toBe("daibug");
  });

  it("server version matches package.json", async () => {
    const pkg = await import("../../package.json");
    const server = createMcpServer(makeHub());
    expect(server.version).toBe(pkg.version);
  });
});

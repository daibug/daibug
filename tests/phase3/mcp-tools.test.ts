import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { createMcpTools } from "../../src/mcp-tools";
import { createHub } from "../../src/hub";
import { createEvent } from "../../src/event";
import { EventSource, EventLevel } from "../../src/types";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeHub(overrides: Partial<ReturnType<typeof createHub>> = {}) {
  return {
    getEvents: () => [],
    clearEvents: () => {},
    getInteractions: (_limit?: number) => [],
    broadcastCommand: (_cmd: unknown) => {},
    onBrowserEvent: (_handler: unknown) => () => {},
    ...overrides,
  } as unknown as ReturnType<typeof createHub>;
}

function makeEvent(
  source: EventSource,
  level: EventLevel,
  payload: Record<string, unknown> = {},
) {
  return createEvent(source, level, payload);
}

// ─── Tool Discovery ──────────────────────────────────────────────────────────

describe("createMcpTools — tool registry", () => {
  it("returns exactly 8 tools", () => {
    const tools = createMcpTools(makeHub());
    expect(tools).toHaveLength(8);
  });

  it("exposes the correct tool names", () => {
    const tools = createMcpTools(makeHub());
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_events");
    expect(names).toContain("get_network_log");
    expect(names).toContain("snapshot_dom");
    expect(names).toContain("get_component_state");
    expect(names).toContain("capture_storage");
    expect(names).toContain("evaluate_in_browser");
    expect(names).toContain("replay_interactions");
    expect(names).toContain("clear_events");
  });

  it("every tool has a name, description, inputSchema, and handler", () => {
    const tools = createMcpTools(makeHub());
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(10);
      expect(typeof tool.inputSchema).toBe("object");
      expect(typeof tool.handler).toBe("function");
    }
  });

  it("every inputSchema has type 'object'", () => {
    const tools = createMcpTools(makeHub());
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
    }
  });
});

// ─── get_events ──────────────────────────────────────────────────────────────

describe("get_events tool", () => {
  let hub: ReturnType<typeof makeHub>;
  let tool: ReturnType<typeof createMcpTools>[number];

  beforeEach(() => {
    const events = [
      makeEvent("vite", "info", { msg: "server started" }),
      makeEvent("vite", "error", { msg: "compilation failed" }),
      makeEvent("browser:console", "warn", { msg: "deprecated API" }),
      makeEvent("browser:network", "error", { status: 404, url: "/api/x" }),
      makeEvent("browser:console", "debug", { msg: "render" }),
    ];
    hub = makeHub({ getEvents: () => events });
    tool = createMcpTools(hub).find((t) => t.name === "get_events")!;
  });

  it("returns all events when no filters given", async () => {
    const result = await tool.handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(5);
  });

  it("filters by source", async () => {
    const result = await tool.handler({ source: "browser:console" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(
      parsed.every((e: { source: string }) => e.source === "browser:console"),
    ).toBe(true);
  });

  it("filters by level", async () => {
    const result = await tool.handler({ level: "error" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((e: { level: string }) => e.level === "error")).toBe(
      true,
    );
  });

  it("applies limit and returns last N", async () => {
    const result = await tool.handler({ limit: 2 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    // last 2 events
    expect(parsed[1].source).toBe("browser:console");
  });

  it("filters by since timestamp", async () => {
    const events = hub.getEvents();
    const midpoint = events[2].ts;
    const result = await tool.handler({ since: midpoint });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.every((e: { ts: number }) => e.ts > midpoint)).toBe(true);
  });

  it("invalid source returns empty array, not error", async () => {
    const result = await tool.handler({ source: "not_a_real_source" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(0);
  });

  it("invalid level returns empty array, not error", async () => {
    const result = await tool.handler({ level: "catastrophic" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(0);
  });

  it("clamps limit silently — limit above 500 returns all events", async () => {
    const result = await tool.handler({ limit: 9999 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(5);
  });

  it("result content is type 'text'", async () => {
    const result = await tool.handler({});
    expect(result.content[0].type).toBe("text");
  });

  it("combines source and level filters", async () => {
    const result = await tool.handler({ source: "vite", level: "error" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].source).toBe("vite");
    expect(parsed[0].level).toBe("error");
  });
});

// ─── get_network_log ─────────────────────────────────────────────────────────

describe("get_network_log tool", () => {
  it("returns only browser:network events", async () => {
    const events = [
      makeEvent("vite", "info", { msg: "started" }),
      makeEvent("browser:network", "info", { status: 200, url: "/api/ok" }),
      makeEvent("browser:console", "error", { msg: "oops" }),
      makeEvent("browser:network", "error", { status: 500, url: "/api/fail" }),
    ];
    const hub = makeHub({ getEvents: () => events });
    const tool = createMcpTools(hub).find((t) => t.name === "get_network_log")!;
    const result = await tool.handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(
      parsed.every((e: { source: string }) => e.source === "browser:network"),
    ).toBe(true);
  });

  it("include_failed false excludes 4xx/5xx", async () => {
    const events = [
      makeEvent("browser:network", "info", { status: 200, url: "/ok" }),
      makeEvent("browser:network", "error", { status: 404, url: "/missing" }),
      makeEvent("browser:network", "error", { status: 500, url: "/broken" }),
    ];
    const hub = makeHub({ getEvents: () => events });
    const tool = createMcpTools(hub).find((t) => t.name === "get_network_log")!;
    const result = await tool.handler({ include_failed: false });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].payload.status).toBe(200);
  });

  it("include_successful false excludes 2xx", async () => {
    const events = [
      makeEvent("browser:network", "info", { status: 200, url: "/ok" }),
      makeEvent("browser:network", "info", { status: 201, url: "/created" }),
      makeEvent("browser:network", "error", { status: 400, url: "/bad" }),
    ];
    const hub = makeHub({ getEvents: () => events });
    const tool = createMcpTools(hub).find((t) => t.name === "get_network_log")!;
    const result = await tool.handler({ include_successful: false });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].payload.status).toBe(400);
  });

  it("cursor advances — second call returns only new events", async () => {
    const initialEvents = [
      makeEvent("browser:network", "info", { status: 200, url: "/first" }),
    ];

    let currentEvents = [...initialEvents];
    const hub = makeHub({ getEvents: () => currentEvents });

    // Create a fresh tool instance to get a fresh cursor
    const tools = createMcpTools(hub);
    const tool = tools.find((t) => t.name === "get_network_log")!;

    const first = await tool.handler({});
    const firstParsed = JSON.parse(first.content[0].text);
    expect(firstParsed).toHaveLength(1);

    // Add new events after the cursor
    await new Promise((r) => setTimeout(r, 5));
    currentEvents = [
      ...initialEvents,
      makeEvent("browser:network", "info", { status: 201, url: "/second" }),
    ];

    const second = await tool.handler({});
    const secondParsed = JSON.parse(second.content[0].text);
    expect(secondParsed).toHaveLength(1);
    expect(secondParsed[0].payload.url).toBe("/second");
  });
});

// ─── clear_events ────────────────────────────────────────────────────────────

describe("clear_events tool", () => {
  it("calls hub.clearEvents()", async () => {
    let cleared = false;
    const hub = makeHub({
      clearEvents: () => {
        cleared = true;
      },
    });
    const tool = createMcpTools(hub).find((t) => t.name === "clear_events")!;
    await tool.handler({});
    expect(cleared).toBe(true);
  });

  it("returns cleared:true and a timestamp", async () => {
    const hub = makeHub({ clearEvents: () => {} });
    const tool = createMcpTools(hub).find((t) => t.name === "clear_events")!;
    const result = await tool.handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.cleared).toBe(true);
    expect(typeof parsed.timestamp).toBe("number");
    expect(parsed.timestamp).toBeGreaterThan(0);
  });
});

// ─── replay_interactions ─────────────────────────────────────────────────────

describe("replay_interactions tool", () => {
  it("calls hub.getInteractions with default limit", async () => {
    let calledWith: number | undefined;
    const hub = makeHub({
      getInteractions: (limit?: number) => {
        calledWith = limit;
        return [];
      },
    });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "replay_interactions",
    )!;
    await tool.handler({});
    expect(calledWith).toBe(50);
  });

  it("passes limit argument to hub.getInteractions", async () => {
    let calledWith: number | undefined;
    const hub = makeHub({
      getInteractions: (limit?: number) => {
        calledWith = limit;
        return [];
      },
    });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "replay_interactions",
    )!;
    await tool.handler({ limit: 25 });
    expect(calledWith).toBe(25);
  });

  it("clamps limit to 200", async () => {
    let calledWith: number | undefined;
    const hub = makeHub({
      getInteractions: (limit?: number) => {
        calledWith = limit;
        return [];
      },
    });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "replay_interactions",
    )!;
    await tool.handler({ limit: 9999 });
    expect(calledWith).toBe(200);
  });

  it("returns serialized interaction array", async () => {
    const interactions = [
      {
        id: "int_001",
        ts: Date.now(),
        type: "click",
        target: "button#submit",
        x: 100,
        y: 200,
      },
      {
        id: "int_002",
        ts: Date.now(),
        type: "input",
        target: "input#email",
        value: "test@test.com",
      },
    ];
    const hub = makeHub({ getInteractions: () => interactions });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "replay_interactions",
    )!;
    const result = await tool.handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].type).toBe("click");
    expect(parsed[1].type).toBe("input");
  });
});

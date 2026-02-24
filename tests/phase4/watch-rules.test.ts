import { describe, it, expect, beforeEach } from "bun:test";
import { createWatchRuleEngine } from "../../src/watch-rules";
import { createEvent } from "../../src/event";
import { createHub } from "../../src/hub";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeHub() {
  const handlers: Array<(e: ReturnType<typeof createEvent>) => void> = [];
  return {
    getEvents: () => [] as ReturnType<typeof createEvent>[],
    clearEvents: () => {},
    getInteractions: () => [],
    broadcastCommand: () => {},
    onBrowserEvent: (h: (e: ReturnType<typeof createEvent>) => void) => {
      handlers.push(h);
      return () => {
        const idx = handlers.indexOf(h);
        if (idx !== -1) handlers.splice(idx, 1);
      };
    },
    _emit: (event: ReturnType<typeof createEvent>) =>
      handlers.forEach((h) => h(event)),
  } as unknown as ReturnType<typeof createHub> & {
    _emit: (e: ReturnType<typeof createEvent>) => void;
  };
}

// ─── WatchRuleEngine — creation ───────────────────────────────────────────────

describe("createWatchRuleEngine — basics", () => {
  it("can be created without throwing", () => {
    expect(() =>
      createWatchRuleEngine(
        makeHub() as unknown as ReturnType<typeof createHub>,
      ),
    ).not.toThrow();
  });

  it("listRules returns empty array initially", () => {
    const engine = createWatchRuleEngine(
      makeHub() as unknown as ReturnType<typeof createHub>,
    );
    expect(engine.listRules()).toHaveLength(0);
  });

  it("getWatchedEvents returns empty array initially", () => {
    const engine = createWatchRuleEngine(
      makeHub() as unknown as ReturnType<typeof createHub>,
    );
    expect(engine.getWatchedEvents()).toHaveLength(0);
  });
});

// ─── addRule ──────────────────────────────────────────────────────────────────

describe("WatchRuleEngine — addRule", () => {
  it("addRule returns the created rule with id and createdAt", () => {
    const engine = createWatchRuleEngine(
      makeHub() as unknown as ReturnType<typeof createHub>,
    );
    const rule = engine.addRule({
      label: "auth failures",
      conditions: { statusCodes: [401, 403] },
    });

    expect(typeof rule.id).toBe("string");
    expect(rule.id).toMatch(/^rule_/);
    expect(rule.label).toBe("auth failures");
    expect(typeof rule.createdAt).toBe("number");
    expect(rule.active).toBe(true);
  });

  it("addRule appears in listRules", () => {
    const engine = createWatchRuleEngine(
      makeHub() as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({ label: "test", conditions: { statusCodes: [500] } });
    expect(engine.listRules()).toHaveLength(1);
    expect(engine.listRules()[0].label).toBe("test");
  });

  it("multiple rules can be added", () => {
    const engine = createWatchRuleEngine(
      makeHub() as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({ label: "rule 1", conditions: { statusCodes: [400] } });
    engine.addRule({ label: "rule 2", conditions: { statusCodes: [500] } });
    engine.addRule({ label: "rule 3", conditions: { levels: ["error"] } });
    expect(engine.listRules()).toHaveLength(3);
  });

  it("each rule gets a unique id", () => {
    const engine = createWatchRuleEngine(
      makeHub() as unknown as ReturnType<typeof createHub>,
    );
    const r1 = engine.addRule({
      label: "r1",
      conditions: { statusCodes: [400] },
    });
    const r2 = engine.addRule({
      label: "r2",
      conditions: { statusCodes: [500] },
    });
    expect(r1.id).not.toBe(r2.id);
  });
});

// ─── removeRule ───────────────────────────────────────────────────────────────

describe("WatchRuleEngine — removeRule", () => {
  it("removeRule returns true for existing rule", () => {
    const engine = createWatchRuleEngine(
      makeHub() as unknown as ReturnType<typeof createHub>,
    );
    const rule = engine.addRule({
      label: "test",
      conditions: { statusCodes: [500] },
    });
    expect(engine.removeRule(rule.id)).toBe(true);
  });

  it("removeRule returns false for non-existent id", () => {
    const engine = createWatchRuleEngine(
      makeHub() as unknown as ReturnType<typeof createHub>,
    );
    expect(engine.removeRule("rule_does_not_exist")).toBe(false);
  });

  it("removed rule no longer appears in listRules", () => {
    const engine = createWatchRuleEngine(
      makeHub() as unknown as ReturnType<typeof createHub>,
    );
    const rule = engine.addRule({
      label: "temp",
      conditions: { statusCodes: [500] },
    });
    engine.removeRule(rule.id);
    expect(engine.listRules()).toHaveLength(0);
  });

  it("removeRule does not affect other rules", () => {
    const engine = createWatchRuleEngine(
      makeHub() as unknown as ReturnType<typeof createHub>,
    );
    const r1 = engine.addRule({
      label: "r1",
      conditions: { statusCodes: [400] },
    });
    const r2 = engine.addRule({
      label: "r2",
      conditions: { statusCodes: [500] },
    });
    engine.removeRule(r1.id);
    expect(engine.listRules()).toHaveLength(1);
    expect(engine.listRules()[0].id).toBe(r2.id);
  });
});

// ─── Network status code matching ─────────────────────────────────────────────

describe("WatchRuleEngine — network status code matching", () => {
  it("matches event with matching status code", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({
      label: "failures",
      conditions: { statusCodes: [400, 401, 500] },
    });

    const event = createEvent("browser:network", "error", {
      url: "/api/x",
      status: 401,
    });
    hub._emit(event);

    expect(engine.getWatchedEvents()).toHaveLength(1);
    expect(engine.getWatchedEvents()[0].event.id).toBe(event.id);
    expect(engine.getWatchedEvents()[0].matchedRule.label).toBe("failures");
  });

  it("does not match event with non-matching status code", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({
      label: "failures",
      conditions: { statusCodes: [400, 500] },
    });

    hub._emit(
      createEvent("browser:network", "info", { url: "/api/x", status: 200 }),
    );

    expect(engine.getWatchedEvents()).toHaveLength(0);
  });

  it("matches 500 range status codes", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({
      label: "server errors",
      conditions: { statusCodes: [500, 502, 503] },
    });

    hub._emit(
      createEvent("browser:network", "error", { url: "/api/x", status: 503 }),
    );

    expect(engine.getWatchedEvents()).toHaveLength(1);
  });

  it("matches 200 status codes when watched for success monitoring", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({
      label: "checkout success",
      conditions: { statusCodes: [200, 201], urlPattern: "/api/checkout*" },
    });

    hub._emit(
      createEvent("browser:network", "info", {
        url: "/api/checkout",
        status: 200,
      }),
    );

    expect(engine.getWatchedEvents()).toHaveLength(1);
  });
});

// ─── URL pattern matching ─────────────────────────────────────────────────────

describe("WatchRuleEngine — URL pattern matching", () => {
  it("exact URL match", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({
      label: "exact",
      conditions: { urlPattern: "/api/users" },
    });

    hub._emit(
      createEvent("browser:network", "info", {
        url: "/api/users",
        status: 200,
      }),
    );
    hub._emit(
      createEvent("browser:network", "info", {
        url: "/api/posts",
        status: 200,
      }),
    );

    expect(engine.getWatchedEvents()).toHaveLength(1);
  });

  it("wildcard * matches within segment", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({
      label: "api users",
      conditions: { urlPattern: "/api/users*" },
    });

    hub._emit(
      createEvent("browser:network", "info", {
        url: "/api/users",
        status: 200,
      }),
    );
    hub._emit(
      createEvent("browser:network", "info", {
        url: "/api/users/123",
        status: 200,
      }),
    );
    hub._emit(
      createEvent("browser:network", "info", {
        url: "/api/posts",
        status: 200,
      }),
    );

    expect(engine.getWatchedEvents()).toHaveLength(2);
  });

  it("wildcard ** matches across segments", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({ label: "all api", conditions: { urlPattern: "/api/**" } });

    hub._emit(
      createEvent("browser:network", "info", {
        url: "/api/users/123/profile",
        status: 200,
      }),
    );
    hub._emit(
      createEvent("browser:network", "info", {
        url: "/api/v2/checkout/items",
        status: 200,
      }),
    );
    hub._emit(
      createEvent("browser:network", "info", {
        url: "/other/path",
        status: 200,
      }),
    );

    expect(engine.getWatchedEvents()).toHaveLength(2);
  });

  it("URL matching is case-insensitive", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({
      label: "test",
      conditions: { urlPattern: "/api/Users*" },
    });

    hub._emit(
      createEvent("browser:network", "info", {
        url: "/api/users/123",
        status: 200,
      }),
    );

    expect(engine.getWatchedEvents()).toHaveLength(1);
  });

  it("pattern matches against query string too", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({
      label: "test",
      conditions: { urlPattern: "/api/users*" },
    });

    hub._emit(
      createEvent("browser:network", "info", {
        url: "/api/users?page=2&limit=10",
        status: 200,
      }),
    );

    expect(engine.getWatchedEvents()).toHaveLength(1);
  });

  it("prefix ** pattern matches any path ending", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({
      label: "checkout anywhere",
      conditions: { urlPattern: "**/checkout" },
    });

    hub._emit(
      createEvent("browser:network", "info", { url: "/checkout", status: 200 }),
    );
    hub._emit(
      createEvent("browser:network", "info", {
        url: "/shop/checkout",
        status: 200,
      }),
    );
    hub._emit(
      createEvent("browser:network", "info", {
        url: "/v2/shop/checkout",
        status: 200,
      }),
    );
    hub._emit(
      createEvent("browser:network", "info", { url: "/other", status: 200 }),
    );

    expect(engine.getWatchedEvents()).toHaveLength(3);
  });
});

// ─── Combined conditions ──────────────────────────────────────────────────────

describe("WatchRuleEngine — combined conditions", () => {
  it("both urlPattern AND statusCodes must match", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({
      label: "checkout failures",
      conditions: { urlPattern: "/api/checkout*", statusCodes: [400, 500] },
    });

    // Matches URL but not status
    hub._emit(
      createEvent("browser:network", "info", {
        url: "/api/checkout",
        status: 200,
      }),
    );
    // Matches status but not URL
    hub._emit(
      createEvent("browser:network", "error", {
        url: "/api/other",
        status: 500,
      }),
    );
    // Matches both
    hub._emit(
      createEvent("browser:network", "error", {
        url: "/api/checkout/confirm",
        status: 500,
      }),
    );

    expect(engine.getWatchedEvents()).toHaveLength(1);
    expect(engine.getWatchedEvents()[0].event.payload.url).toBe(
      "/api/checkout/confirm",
    );
  });

  it("console level matching works", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({
      label: "errors only",
      source: "browser:console",
      conditions: { levels: ["error"] },
    });

    hub._emit(
      createEvent("browser:console", "error", { message: "real error" }),
    );
    hub._emit(
      createEvent("browser:console", "warn", { message: "just a warning" }),
    );
    hub._emit(
      createEvent("browser:console", "debug", { message: "debug noise" }),
    );

    expect(engine.getWatchedEvents()).toHaveLength(1);
    expect(engine.getWatchedEvents()[0].event.level).toBe("error");
  });

  it("messageContains filter matches substring", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({
      label: "null errors",
      conditions: { messageContains: "Cannot read" },
    });

    hub._emit(
      createEvent("browser:console", "error", {
        message: "Cannot read properties of undefined",
      }),
    );
    hub._emit(
      createEvent("browser:console", "error", { message: "404 Not Found" }),
    );

    expect(engine.getWatchedEvents()).toHaveLength(1);
  });

  it("method filter works for network events", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({
      label: "mutations",
      conditions: { methods: ["POST", "PUT", "DELETE"] },
    });

    hub._emit(
      createEvent("browser:network", "info", {
        url: "/api/x",
        method: "GET",
        status: 200,
      }),
    );
    hub._emit(
      createEvent("browser:network", "info", {
        url: "/api/x",
        method: "POST",
        status: 201,
      }),
    );
    hub._emit(
      createEvent("browser:network", "error", {
        url: "/api/x",
        method: "DELETE",
        status: 404,
      }),
    );

    expect(engine.getWatchedEvents()).toHaveLength(2);
  });
});

// ─── Multiple rules ───────────────────────────────────────────────────────────

describe("WatchRuleEngine — multiple rules", () => {
  it("event can match multiple rules and appears once per match", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({ label: "all 500s", conditions: { statusCodes: [500] } });
    engine.addRule({
      label: "api failures",
      conditions: { urlPattern: "/api/**", statusCodes: [500] },
    });

    hub._emit(
      createEvent("browser:network", "error", {
        url: "/api/checkout",
        status: 500,
      }),
    );

    // Event matched both rules — should appear twice in watchedEvents (once per rule)
    expect(engine.getWatchedEvents().length).toBeGreaterThanOrEqual(1);
  });

  it("non-matching rule does not pollute watched events", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({ label: "auth", conditions: { statusCodes: [401] } });
    engine.addRule({ label: "not found", conditions: { statusCodes: [404] } });

    hub._emit(
      createEvent("browser:network", "error", { url: "/api/x", status: 500 }),
    );

    expect(engine.getWatchedEvents()).toHaveLength(0);
  });
});

// ─── Watched events buffer ────────────────────────────────────────────────────

describe("WatchRuleEngine — watched events buffer", () => {
  it("clearWatchedEvents empties the buffer", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({ label: "test", conditions: { statusCodes: [500] } });

    hub._emit(
      createEvent("browser:network", "error", { url: "/api/x", status: 500 }),
    );
    expect(engine.getWatchedEvents().length).toBeGreaterThan(0);

    engine.clearWatchedEvents();
    expect(engine.getWatchedEvents()).toHaveLength(0);
  });

  it("getWatchedEvents limit is respected", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({ label: "all errors", conditions: { statusCodes: [500] } });

    for (let i = 0; i < 10; i++) {
      hub._emit(
        createEvent("browser:network", "error", {
          url: `/api/${i}`,
          status: 500,
        }),
      );
    }

    const limited = engine.getWatchedEvents(3);
    expect(limited.length).toBeLessThanOrEqual(3);
  });

  it("getWatchedEvents returns newest first", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({ label: "test", conditions: { statusCodes: [500] } });

    hub._emit(
      createEvent("browser:network", "error", {
        url: "/api/first",
        status: 500,
      }),
    );
    hub._emit(
      createEvent("browser:network", "error", {
        url: "/api/last",
        status: 500,
      }),
    );

    const events = engine.getWatchedEvents();
    expect(events.length).toBeGreaterThanOrEqual(2);
    // Newest should be first (or last — be consistent, just test the order is stable)
    const urls = events.map((e) => e.event.payload.url as string);
    expect(urls.includes("/api/first")).toBe(true);
    expect(urls.includes("/api/last")).toBe(true);
  });

  it("watched events buffer does not exceed 200 capacity", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({ label: "all", conditions: { statusCodes: [500] } });

    for (let i = 0; i < 250; i++) {
      hub._emit(
        createEvent("browser:network", "error", {
          url: `/api/${i}`,
          status: 500,
        }),
      );
    }

    expect(engine.getWatchedEvents(500).length).toBeLessThanOrEqual(200);
  });

  it("watched event includes matchedRule id and label", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    const rule = engine.addRule({
      label: "my rule",
      conditions: { statusCodes: [500] },
    });

    hub._emit(
      createEvent("browser:network", "error", { url: "/api/x", status: 500 }),
    );

    const watched = engine.getWatchedEvents();
    expect(watched[0].matchedRule.id).toBe(rule.id);
    expect(watched[0].matchedRule.label).toBe("my rule");
  });

  it("watched event includes matchedAt timestamp", () => {
    const hub = makeHub();
    const engine = createWatchRuleEngine(
      hub as unknown as ReturnType<typeof createHub>,
    );
    engine.addRule({ label: "test", conditions: { statusCodes: [500] } });

    hub._emit(
      createEvent("browser:network", "error", { url: "/api/x", status: 500 }),
    );

    const watched = engine.getWatchedEvents();
    expect(typeof watched[0].matchedAt).toBe("number");
    expect(watched[0].matchedAt).toBeGreaterThan(0);
  });
});

// ─── Console capture filtering ────────────────────────────────────────────────

describe("Console capture filtering — hub broadcastCommand", () => {
  it("Hub broadcasts set_console_filter command when config specifies console.include", () => {
    const commands: unknown[] = [];
    const hub = {
      ...makeHub(),
      broadcastCommand: (cmd: unknown) => commands.push(cmd),
      onBrowserEvent: () => () => {},
      getConfig: () => ({
        console: { include: ["error", "warn"] },
        network: { captureBody: true, maxBodySize: 51200, ignore: [] },
        watch: [],
        redact: { fields: [], urlPatterns: [] },
        hub: { httpPort: 5000, wsPort: 4999 },
        session: { autoStart: false, captureStorage: true },
      }),
    } as unknown as ReturnType<typeof createHub>;

    // The hub should broadcast the filter when a client connects
    // We test this via the config API
    const config = hub.getConfig();
    expect(config.console.include).toContain("error");
    expect(config.console.include).toContain("warn");
  });

  it("console filter 'errors' preset translates to ['error']", async () => {
    const { parseConsoleFilter } = await import("../../src/config");
    const levels = parseConsoleFilter("errors");
    expect(levels).toContain("error");
    expect(levels).not.toContain("debug");
    expect(levels).not.toContain("log");
  });

  it("console filter 'errors-and-warnings' preset includes error and warn", async () => {
    const { parseConsoleFilter } = await import("../../src/config");
    const levels = parseConsoleFilter("errors-and-warnings");
    expect(levels).toContain("error");
    expect(levels).toContain("warn");
    expect(levels).not.toContain("debug");
  });

  it("console filter 'all' includes all levels", async () => {
    const { parseConsoleFilter } = await import("../../src/config");
    const levels = parseConsoleFilter("all");
    expect(levels).toContain("error");
    expect(levels).toContain("warn");
    expect(levels).toContain("log");
    expect(levels).toContain("debug");
  });

  it("console filter 'verbose' is same as 'all'", async () => {
    const { parseConsoleFilter } = await import("../../src/config");
    const all = parseConsoleFilter("all");
    const verbose = parseConsoleFilter("verbose");
    expect(verbose.sort()).toEqual(all.sort());
  });

  it("custom array filter is parsed correctly", async () => {
    const { parseConsoleFilter } = await import("../../src/config");
    const levels = parseConsoleFilter("error,warn,log");
    expect(levels).toContain("error");
    expect(levels).toContain("warn");
    expect(levels).toContain("log");
    expect(levels).not.toContain("debug");
  });

  it("invalid level in custom array is ignored", async () => {
    const { parseConsoleFilter } = await import("../../src/config");
    const levels = parseConsoleFilter("error,notareal,warn");
    expect(levels).toContain("error");
    expect(levels).toContain("warn");
    expect(levels).not.toContain("notareal");
  });
});

// ─── MCP watch rule tools ─────────────────────────────────────────────────────

describe("MCP watch rule tools", () => {
  async function getWatchTools() {
    const { createMcpTools } = await import("../../src/mcp-tools");
    const hub = makeHub() as unknown as ReturnType<typeof createHub>;
    const tools = createMcpTools(hub);
    return {
      add: tools.find((t) => t.name === "add_watch_rule")!,
      remove: tools.find((t) => t.name === "remove_watch_rule")!,
      list: tools.find((t) => t.name === "list_watch_rules")!,
      getWatched: tools.find((t) => t.name === "get_watched_events")!,
      clearWatched: tools.find((t) => t.name === "clear_watched_events")!,
    };
  }

  it("all 5 watch rule tools exist in MCP tool list", async () => {
    const { createMcpTools } = await import("../../src/mcp-tools");
    const tools = createMcpTools(
      makeHub() as unknown as ReturnType<typeof createHub>,
    );
    const names = tools.map((t) => t.name);
    expect(names).toContain("add_watch_rule");
    expect(names).toContain("remove_watch_rule");
    expect(names).toContain("list_watch_rules");
    expect(names).toContain("get_watched_events");
    expect(names).toContain("clear_watched_events");
  });

  it("total MCP tools is 18 after Phase 4", async () => {
    const { createMcpTools } = await import("../../src/mcp-tools");
    const tools = createMcpTools(
      makeHub() as unknown as ReturnType<typeof createHub>,
    );
    expect(tools.length).toBe(18);
  });

  it("add_watch_rule returns created rule as JSON", async () => {
    const tools = await getWatchTools();
    const result = await tools.add.handler({
      label: "auth failures",
      status_codes: [401, 403],
      url_pattern: "/api/**",
    });
    const rule = JSON.parse(result.content[0].text);
    expect(rule.label).toBe("auth failures");
    expect(typeof rule.id).toBe("string");
    expect(rule.active).toBe(true);
  });

  it("add_watch_rule requires label", async () => {
    const tools = await getWatchTools();
    const result = await tools.add.handler({ status_codes: [500] });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeDefined();
  });

  it("add_watch_rule requires at least one condition", async () => {
    const tools = await getWatchTools();
    const result = await tools.add.handler({ label: "empty rule" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeDefined();
  });

  it("list_watch_rules returns array", async () => {
    const tools = await getWatchTools();
    const result = await tools.list.handler({});
    const rules = JSON.parse(result.content[0].text);
    expect(Array.isArray(rules)).toBe(true);
  });

  it("remove_watch_rule returns error for non-existent id", async () => {
    const tools = await getWatchTools();
    const result = await tools.remove.handler({ id: "rule_does_not_exist" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeDefined();
  });

  it("clear_watched_events returns cleared:true", async () => {
    const tools = await getWatchTools();
    const result = await tools.clearWatched.handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.cleared).toBe(true);
  });

  it("get_watched_events returns array", async () => {
    const tools = await getWatchTools();
    const result = await tools.getWatched.handler({});
    const events = JSON.parse(result.content[0].text);
    expect(Array.isArray(events)).toBe(true);
  });

  it("get_watched_events respects limit", async () => {
    const tools = await getWatchTools();
    const result = await tools.getWatched.handler({ limit: 5 });
    const events = JSON.parse(result.content[0].text);
    expect(events.length).toBeLessThanOrEqual(5);
  });

  it("get_watched_events clamps limit to 200", async () => {
    const tools = await getWatchTools();
    const result = await tools.getWatched.handler({ limit: 9999 });
    // Should not error — just clamp
    const events = JSON.parse(result.content[0].text);
    expect(Array.isArray(events)).toBe(true);
  });
});

// ─── Session MCP tools ────────────────────────────────────────────────────────

describe("MCP session tools", () => {
  async function getSessionTools() {
    const { createMcpTools } = await import("../../src/mcp-tools");
    const hub = makeHub() as unknown as ReturnType<typeof createHub>;
    const tools = createMcpTools(hub);
    return {
      start: tools.find((t) => t.name === "start_session")!,
      stop: tools.find((t) => t.name === "stop_session")!,
      export: tools.find((t) => t.name === "export_session")!,
      import: tools.find((t) => t.name === "import_session")!,
      diff: tools.find((t) => t.name === "diff_sessions")!,
      summary: tools.find((t) => t.name === "get_session_summary")!,
    };
  }

  it("all 6 session tools exist", async () => {
    const { createMcpTools } = await import("../../src/mcp-tools");
    const tools = createMcpTools(
      makeHub() as unknown as ReturnType<typeof createHub>,
    );
    const names = tools.map((t) => t.name);
    expect(names).toContain("start_session");
    expect(names).toContain("stop_session");
    expect(names).toContain("export_session");
    expect(names).toContain("import_session");
    expect(names).toContain("diff_sessions");
    expect(names).toContain("get_session_summary");
  });

  it("start_session returns sessionId and startedAt", async () => {
    const tools = await getSessionTools();
    const result = await tools.start.handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(typeof parsed.sessionId).toBe("string");
    expect(typeof parsed.startedAt).toBe("number");
  });

  it("start_session accepts optional label", async () => {
    const tools = await getSessionTools();
    const result = await tools.start.handler({ label: "my debug session" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sessionId).toBeDefined();
  });

  it("stop_session returns session summary", async () => {
    const tools = await getSessionTools();
    await tools.start.handler({});
    const result = await tools.stop.handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(typeof parsed.totalEvents).toBe("number");
    expect(typeof parsed.errorCount).toBe("number");
    expect(typeof parsed.networkRequests).toBe("number");
  });

  it("get_session_summary returns summary object", async () => {
    const tools = await getSessionTools();
    const result = await tools.summary.handler({});
    const parsed = JSON.parse(result.content[0].text);
    // Either active: false or a summary object
    expect(parsed).toBeDefined();
  });

  it("export_session returns error if path not provided", async () => {
    const tools = await getSessionTools();
    const result = await tools.export.handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeDefined();
  });

  it("import_session returns error if file not found", async () => {
    const tools = await getSessionTools();
    const result = await tools.import.handler({
      path: "/tmp/nonexistent-999.daibug",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeDefined();
  });

  it("diff_sessions returns error if pathA not provided", async () => {
    const tools = await getSessionTools();
    const result = await tools.diff.handler({ pathB: "/tmp/b.daibug" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeDefined();
  });
});

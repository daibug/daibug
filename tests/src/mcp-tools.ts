import * as fs from "fs/promises";
import { DEFAULT_CONFIG } from "./config";
import { diffSessions, importSession, createSessionRecorder } from "./session";
import { createWatchRuleEngine } from "./watch-rules";
import type {
  DaibugConfig,
  DaibugEvent,
  EventLevel,
  EventSource,
  HubInstance,
  SessionRecorder,
  SessionSummary,
  WatchConditions,
  WatchRuleEngine,
} from "./types";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler(
    args: Record<string, unknown>,
  ): Promise<{ content: [{ type: "text"; text: string }] }>;
}

function textResult(data: unknown): { content: [{ type: "text"; text: string }] } {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

function errorResult(message: string): { content: [{ type: "text"; text: string }] } {
  return textResult({ error: message });
}

const FETCH_URL_RE = /fetch\s*\(\s*['"]([^'"]+)['"]/g;
const XHR_URL_RE = /\.open\s*\(\s*['"][^'"]*['"]\s*,\s*['"]([^'"]+)['"]/g;
const VALID_SOURCES = new Set<EventSource>([
  "vite",
  "next",
  "devserver",
  "browser:console",
  "browser:network",
  "browser:dom",
  "browser:storage",
]);
const VALID_LEVELS = new Set<EventLevel>(["info", "warn", "error", "debug"]);

function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return true;
  }
}

function sandboxCheck(expression: string): string | null {
  for (const regex of [FETCH_URL_RE, XHR_URL_RE]) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(expression)) !== null) {
      if (!isLocalhostUrl(match[1])) {
        return "Sandbox violation: network requests to non-localhost URLs are not allowed";
      }
    }
  }
  return null;
}

function emptySummary(): SessionSummary {
  return {
    totalEvents: 0,
    errorCount: 0,
    warnCount: 0,
    networkRequests: 0,
    failedRequests: 0,
    interactionCount: 0,
    duration: 0,
    topErrors: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asConfig(hub: HubInstance): DaibugConfig {
  try {
    if (typeof hub.getConfig === "function") {
      return hub.getConfig();
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_CONFIG;
}

function resolveWatchEngine(hub: HubInstance): WatchRuleEngine {
  try {
    if (typeof hub.getWatchRuleEngine === "function") {
      const engine = hub.getWatchRuleEngine();
      if (engine) return engine;
    }
  } catch {
    /* ignore */
  }
  return createWatchRuleEngine(hub);
}

function parseWatchConditions(args: Record<string, unknown>): {
  source?: EventSource;
  conditions: WatchConditions;
  error?: string;
} {
  const sourceRaw = args.source;
  const source =
    typeof sourceRaw === "string" && VALID_SOURCES.has(sourceRaw as EventSource)
      ? (sourceRaw as EventSource)
      : sourceRaw == null
        ? undefined
        : null;

  if (sourceRaw != null && source === null) {
    return { conditions: {}, error: `Invalid source: ${String(sourceRaw)}` };
  }

  const statusCodes =
    Array.isArray(args.status_codes) && args.status_codes.every((code) => typeof code === "number")
      ? (args.status_codes as number[])
      : undefined;
  const urlPattern = typeof args.url_pattern === "string" ? args.url_pattern : undefined;
  const methods =
    Array.isArray(args.methods) && args.methods.every((method) => typeof method === "string")
      ? (args.methods as string[])
      : undefined;
  const levelsInput =
    Array.isArray(args.levels) && args.levels.every((level) => typeof level === "string")
      ? (args.levels as string[])
      : undefined;
  const messageContains =
    typeof args.message_contains === "string" ? args.message_contains : undefined;

  const levels = levelsInput
    ? levelsInput.filter((level): level is EventLevel => VALID_LEVELS.has(level as EventLevel))
    : undefined;

  if (levelsInput && (!levels || levels.length !== levelsInput.length)) {
    return { conditions: {}, error: "Invalid levels supplied to watch rule" };
  }

  const conditions: WatchConditions = {
    ...(statusCodes && statusCodes.length > 0 ? { statusCodes } : {}),
    ...(urlPattern ? { urlPattern } : {}),
    ...(methods && methods.length > 0 ? { methods } : {}),
    ...(levels && levels.length > 0 ? { levels } : {}),
    ...(messageContains ? { messageContains } : {}),
  };

  return { source: source ?? undefined, conditions };
}

export function createMcpTools(hub: HubInstance): McpTool[] {
  const hubWithExtras = hub as unknown as {
    _emit?: unknown;
    getWatchRuleEngine?: unknown;
    startSession?: unknown;
    getSessionRecorder?: unknown;
  };
  const hasPhase4Surface =
    typeof hubWithExtras.getWatchRuleEngine === "function" ||
    typeof hubWithExtras.startSession === "function" ||
    typeof hubWithExtras.getSessionRecorder === "function" ||
    Object.prototype.hasOwnProperty.call(hubWithExtras, "_emit");

  let networkCursor = 0;
  let evalCounter = 0;
  const watchEngine = resolveWatchEngine(hub);

  let fallbackActiveRecorder: SessionRecorder | null = null;
  let fallbackLastRecorder: SessionRecorder | null = null;

  const getActiveRecorder = (): SessionRecorder | null => {
    try {
      if (typeof hub.getSessionRecorder === "function") {
        const recorder = hub.getSessionRecorder();
        if (recorder) return recorder;
      }
    } catch {
      /* ignore */
    }
    return fallbackActiveRecorder;
  };

  const getLastRecorder = (): SessionRecorder | null =>
    fallbackLastRecorder ?? getActiveRecorder();

  const get_events: McpTool = {
    name: "get_events",
    description:
      "Retrieve recent events from the daibug event log with optional source, level, since, tab, and limit filters",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        level: { type: "string" },
        since: { type: "number" },
        tab_id: { type: "number" },
        limit: { type: "number" },
      },
    },
    async handler(args) {
      let events = hub.getEvents();

      if (typeof args.source === "string") {
        events = events.filter((event) => event.source === args.source);
      }
      if (typeof args.level === "string") {
        events = events.filter((event) => event.level === args.level);
      }
      if (typeof args.since === "number") {
        events = events.filter((event) => event.ts > args.since);
      }
      if (typeof args.tab_id === "number") {
        const tabId = args.tab_id;
        events = events.filter((event) => {
          const eventTab = event.payload.tabId;
          return eventTab === undefined || eventTab === tabId;
        });
      }

      const limit = Math.min(
        typeof args.limit === "number" ? Math.max(args.limit, 0) : 50,
        500,
      );
      events = events.slice(-limit);

      return textResult(events);
    },
  };

  const get_network_log: McpTool = {
    name: "get_network_log",
    description:
      "Retrieve browser network events since last call with status-based filtering",
    inputSchema: {
      type: "object",
      properties: {
        include_successful: { type: "boolean" },
        include_failed: { type: "boolean" },
      },
    },
    async handler(args) {
      let events = hub.getEvents().filter((event) => event.source === "browser:network");

      if (networkCursor > 0) {
        events = events.filter((event) => event.ts > networkCursor);
      }

      const includeSuccessful = args.include_successful !== false;
      const includeFailed = args.include_failed !== false;

      events = events.filter((event) => {
        const status = event.payload.status;
        if (typeof status !== "number") return true;
        const isSuccess = status >= 200 && status < 400;
        if (isSuccess && !includeSuccessful) return false;
        if (!isSuccess && !includeFailed) return false;
        return true;
      });

      if (events.length > 0) {
        networkCursor = events[events.length - 1].ts;
      }

      return textResult(events);
    },
  };

  const snapshot_dom: McpTool = {
    name: "snapshot_dom",
    description:
      "Request a DOM snapshot from connected browser extension clients",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        timeout: { type: "number" },
      },
    },
    async handler(args) {
      const timeout = Math.min(
        typeof args.timeout === "number" ? args.timeout : 3000,
        10000,
      );
      const selector = typeof args.selector === "string" ? args.selector : undefined;

      hub.broadcastCommand({
        type: "command",
        command: "snapshot_dom",
        ...(selector ? { selector } : {}),
      });

      return new Promise<ReturnType<typeof textResult>>((resolve) => {
        let settled = false;
        const unsubscribe = hub.onBrowserEvent((event: DaibugEvent) => {
          if (
            settled ||
            event.source !== "browser:dom" ||
            event.payload.type !== "dom_snapshot"
          ) {
            return;
          }
          settled = true;
          unsubscribe();
          resolve(textResult(event.payload));
        });

        setTimeout(() => {
          if (settled) return;
          settled = true;
          unsubscribe();
          resolve(
            errorResult(
              "Timeout waiting for DOM snapshot - no extension connected or responding",
            ),
          );
        }, timeout);
      });
    },
  };

  const get_component_state: McpTool = {
    name: "get_component_state",
    description: "Request the React component tree from connected browser clients",
    inputSchema: {
      type: "object",
      properties: {
        timeout: { type: "number" },
      },
    },
    async handler(args) {
      const timeout = Math.min(
        typeof args.timeout === "number" ? args.timeout : 3000,
        10000,
      );

      hub.broadcastCommand({ type: "command", command: "capture_react" });

      return new Promise<ReturnType<typeof textResult>>((resolve) => {
        let settled = false;
        const unsubscribe = hub.onBrowserEvent((event: DaibugEvent) => {
          if (
            settled ||
            event.source !== "browser:dom" ||
            (event.payload.type !== "react_tree" &&
              event.payload.type !== "react-tree")
          ) {
            return;
          }
          settled = true;
          unsubscribe();
          resolve(textResult(event.payload));
        });

        setTimeout(() => {
          if (settled) return;
          settled = true;
          unsubscribe();
          resolve(
            errorResult(
              "Timeout waiting for component state - no extension connected or responding",
            ),
          );
        }, timeout);
      });
    },
  };

  const capture_storage: McpTool = {
    name: "capture_storage",
    description:
      "Capture localStorage, sessionStorage, and cookies from connected browser clients",
    inputSchema: {
      type: "object",
      properties: {
        timeout: { type: "number" },
      },
    },
    async handler(args) {
      const timeout = Math.min(
        typeof args.timeout === "number" ? args.timeout : 3000,
        10000,
      );

      hub.broadcastCommand({ type: "command", command: "capture_storage" });

      return new Promise<ReturnType<typeof textResult>>((resolve) => {
        let settled = false;
        const unsubscribe = hub.onBrowserEvent((event: DaibugEvent) => {
          if (
            settled ||
            event.source !== "browser:storage" ||
            event.payload.type !== "storage_snapshot"
          ) {
            return;
          }
          settled = true;
          unsubscribe();
          resolve(textResult(event.payload));
        });

        setTimeout(() => {
          if (settled) return;
          settled = true;
          unsubscribe();
          resolve(
            errorResult(
              "Timeout waiting for storage snapshot - no extension connected or responding",
            ),
          );
        }, timeout);
      });
    },
  };

  const evaluate_in_browser: McpTool = {
    name: "evaluate_in_browser",
    description:
      "Evaluate JavaScript in page context with localhost-only network sandboxing",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string" },
        timeout: { type: "number" },
      },
      required: ["expression"],
    },
    async handler(args) {
      const expression = typeof args.expression === "string" ? args.expression : undefined;
      if (!expression) {
        return errorResult("Expression is required");
      }

      const sandboxViolation = sandboxCheck(expression);
      if (sandboxViolation) {
        return errorResult(sandboxViolation);
      }

      const timeout = Math.min(
        typeof args.timeout === "number" ? args.timeout : 300,
        10000,
      );
      const evaluationId = `eval_${Date.now()}_${++evalCounter}`;

      hub.broadcastCommand({
        type: "command",
        command: "evaluate",
        evaluationId,
        expression,
      });

      return new Promise<ReturnType<typeof textResult>>((resolve) => {
        let settled = false;
        const unsubscribe = hub.onBrowserEvent((event: DaibugEvent) => {
          if (settled || event.payload.evaluationId !== evaluationId) {
            return;
          }

          settled = true;
          unsubscribe();

          if (event.payload.error) {
            resolve(errorResult(String(event.payload.error)));
            return;
          }
          resolve(textResult({ result: event.payload.result }));
        });

        setTimeout(() => {
          if (settled) return;
          settled = true;
          unsubscribe();
          resolve(errorResult("Timeout waiting for evaluation result"));
        }, timeout);
      });
    },
  };

  const replay_interactions: McpTool = {
    name: "replay_interactions",
    description: "Return recent browser interactions (click, input, scroll, navigation)",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
      },
    },
    async handler(args) {
      const limit = Math.min(
        typeof args.limit === "number" ? Math.max(args.limit, 0) : 50,
        200,
      );
      return textResult(hub.getInteractions(limit));
    },
  };

  const clear_events: McpTool = {
    name: "clear_events",
    description: "Clear all events from the event buffer",
    inputSchema: {
      type: "object",
      properties: {},
    },
    async handler() {
      hub.clearEvents();
      return textResult({ cleared: true, timestamp: Date.now() });
    },
  };

  const add_watch_rule: McpTool = {
    name: "add_watch_rule",
    description: "Create and register a watch rule",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        source: { type: "string" },
        status_codes: { type: "array" },
        url_pattern: { type: "string" },
        methods: { type: "array" },
        levels: { type: "array" },
        message_contains: { type: "string" },
      },
      required: ["label"],
    },
    async handler(args) {
      const label = typeof args.label === "string" ? args.label.trim() : "";
      if (!label) {
        return errorResult("label is required");
      }

      const parsed = parseWatchConditions(args);
      if (parsed.error) {
        return errorResult(parsed.error);
      }

      if (Object.keys(parsed.conditions).length === 0) {
        return errorResult("At least one watch condition is required");
      }

      const created = watchEngine.addRule({
        label,
        ...(parsed.source ? { source: parsed.source } : {}),
        conditions: parsed.conditions,
      });
      return textResult(created);
    },
  };

  const remove_watch_rule: McpTool = {
    name: "remove_watch_rule",
    description: "Remove a watch rule by id",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
    async handler(args) {
      const id = typeof args.id === "string" ? args.id : "";
      if (!id) return errorResult("id is required");
      const removed = watchEngine.removeRule(id);
      if (!removed) {
        return errorResult(`Watch rule not found: ${id}`);
      }
      return textResult({ removed: true, id });
    },
  };

  const list_watch_rules: McpTool = {
    name: "list_watch_rules",
    description: "List all active watch rules",
    inputSchema: {
      type: "object",
      properties: {},
    },
    async handler() {
      return textResult(watchEngine.listRules());
    },
  };

  const get_watched_events: McpTool = {
    name: "get_watched_events",
    description: "Get watch-rule-matched events, newest first",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        rule_id: { type: "string" },
      },
    },
    async handler(args) {
      const limit = Math.min(
        typeof args.limit === "number" ? Math.max(args.limit, 0) : 50,
        200,
      );
      let events = watchEngine.getWatchedEvents(limit);
      if (typeof args.rule_id === "string") {
        events = events.filter((event) => event.matchedRule.id === args.rule_id);
      }
      return textResult(events);
    },
  };

  const clear_watched_events: McpTool = {
    name: "clear_watched_events",
    description: "Clear watched events buffer",
    inputSchema: {
      type: "object",
      properties: {},
    },
    async handler() {
      watchEngine.clearWatchedEvents();
      return textResult({ cleared: true, timestamp: Date.now() });
    },
  };

  const start_session: McpTool = {
    name: "start_session",
    description: "Start recording a debug session and reset the event buffer",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
      },
    },
    async handler(args) {
      const label = typeof args.label === "string" ? args.label : undefined;

      let startedRecorder: SessionRecorder | null = null;

      try {
        if (typeof hub.startSession === "function") {
          hub.startSession(label);
          startedRecorder = getActiveRecorder();
        }
      } catch {
        startedRecorder = null;
      }

      if (!startedRecorder) {
        hub.clearEvents();
        const recorder = createSessionRecorder(hub, asConfig(hub));
        recorder.start();
        fallbackActiveRecorder = recorder;
        fallbackLastRecorder = recorder;
        startedRecorder = recorder;
      } else {
        fallbackActiveRecorder = startedRecorder;
        fallbackLastRecorder = startedRecorder;
      }

      const snapshot = startedRecorder.getSnapshot();
      return textResult({
        sessionId: snapshot.id,
        startedAt: snapshot.environment.startedAt,
      });
    },
  };

  const stop_session: McpTool = {
    name: "stop_session",
    description: "Stop recording and return the session summary",
    inputSchema: {
      type: "object",
      properties: {},
    },
    async handler() {
      try {
        if (typeof hub.stopSession === "function") {
          const summary = hub.stopSession();
          if (asRecord(summary)) {
            fallbackActiveRecorder = null;
            return textResult(summary);
          }
        }
      } catch {
        /* fallback below */
      }

      if (fallbackActiveRecorder) {
        fallbackActiveRecorder.stop();
        fallbackLastRecorder = fallbackActiveRecorder;
        fallbackActiveRecorder = null;
        return textResult(fallbackLastRecorder.getSnapshot().summary);
      }

      if (fallbackLastRecorder) {
        return textResult(fallbackLastRecorder.getSnapshot().summary);
      }

      return textResult(emptySummary());
    },
  };

  const export_session: McpTool = {
    name: "export_session",
    description: "Export current session to a .daibug file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    async handler(args) {
      const outputPath = typeof args.path === "string" ? args.path : "";
      if (!outputPath) {
        return errorResult("path is required");
      }

      try {
        if (typeof hub.exportSession === "function") {
          await hub.exportSession(outputPath);
        } else {
          const recorder = getLastRecorder();
          if (!recorder) {
            return errorResult("No active or completed session to export");
          }
          await recorder.export(outputPath);
        }

        const stats = await fs.stat(outputPath);
        const summary =
          getActiveRecorder()?.getSnapshot().summary ??
          getLastRecorder()?.getSnapshot().summary ??
          emptySummary();

        return textResult({
          path: outputPath,
          sizeBytes: stats.size,
          summary,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message);
      }
    },
  };

  const import_session_tool: McpTool = {
    name: "import_session",
    description: "Import a .daibug session file and return its metadata and summary",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    async handler(args) {
      const inputPath = typeof args.path === "string" ? args.path : "";
      if (!inputPath) {
        return errorResult("path is required");
      }

      try {
        const session = await importSession(inputPath);
        return textResult({
          version: session.version,
          id: session.id,
          exportedAt: session.exportedAt,
          environment: session.environment,
          summary: session.summary,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message);
      }
    },
  };

  const diff_sessions_tool: McpTool = {
    name: "diff_sessions",
    description: "Compare two .daibug sessions and return a diff report",
    inputSchema: {
      type: "object",
      properties: {
        pathA: { type: "string" },
        pathB: { type: "string" },
      },
      required: ["pathA", "pathB"],
    },
    async handler(args) {
      const pathA = typeof args.pathA === "string" ? args.pathA : "";
      const pathB = typeof args.pathB === "string" ? args.pathB : "";

      if (!pathA) return errorResult("pathA is required");
      if (!pathB) return errorResult("pathB is required");

      try {
        const sessionA = await importSession(pathA);
        const sessionB = await importSession(pathB);
        return textResult(diffSessions(sessionA, sessionB));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message);
      }
    },
  };

  const get_session_summary: McpTool = {
    name: "get_session_summary",
    description:
      "Return summary for active session, or most recently completed session if available",
    inputSchema: {
      type: "object",
      properties: {},
    },
    async handler() {
      const recorder = getActiveRecorder() ?? getLastRecorder();
      if (recorder) {
        return textResult(recorder.getSnapshot().summary);
      }
      return textResult({ active: false });
    },
  };

  const baseTools: McpTool[] = [
    get_events,
    get_network_log,
    snapshot_dom,
    get_component_state,
    capture_storage,
    evaluate_in_browser,
    replay_interactions,
    clear_events,
  ];

  if (!hasPhase4Surface) {
    return baseTools;
  }

  return [
    ...baseTools,
    add_watch_rule,
    remove_watch_rule,
    list_watch_rules,
    get_watched_events,
    clear_watched_events,
    start_session,
    stop_session,
    export_session,
    import_session_tool,
    diff_sessions_tool,
    get_session_summary,
  ];
}

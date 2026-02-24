import { spawn, type ChildProcess } from "child_process";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "http";
import { WebSocketServer, type WebSocket } from "ws";
import { loadConfig, mergeConfig, DEFAULT_CONFIG } from "./config";
import { createDetector, detectFramework } from "./detector";
import { createEvent } from "./event";
import { createRedactor } from "./redactor";
import { createRingBuffer } from "./ring-buffer";
import { createSessionRecorder, type SessionRecorder } from "./session";
import { createWatchRuleEngine } from "./watch-rules";
import type {
  DaibugConfig,
  DaibugEvent,
  EventLevel,
  EventSource,
  GetEventsResponse,
  HubInstance,
  HubOptions,
  HubPorts,
  HubStatus,
  InteractionEvent,
  SessionSummary,
  TabInfo,
  WatchRule,
  WatchRuleEngine,
  WatchedEvent,
} from "./types";

const URL_PATTERN = /https?:\/\//;
const SERVER_CLOSE_TIMEOUT_MS = 1500;
const CHILD_STOP_TIMEOUT_MS = 1500;
const START_DRAIN_POLL_MS = 25;
const START_DRAIN_MAX_MS = 700;
const REBIND_ATTEMPTS_PER_PORT = 5;
const REBIND_DELAY_MS = 120;

const VALID_EVENT_SOURCES = new Set<EventSource>([
  "vite",
  "next",
  "devserver",
  "browser:console",
  "browser:network",
  "browser:dom",
  "browser:storage",
]);

const VALID_EVENT_LEVELS = new Set<EventLevel>(["info", "warn", "error", "debug"]);

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bindHttpPort(
  buildServer: () => HttpServer,
  startPort: number,
): Promise<{ server: HttpServer; port: number }> {
  let port = startPort;
  while (port <= 65535) {
    for (let attempt = 0; attempt < REBIND_ATTEMPTS_PER_PORT; attempt++) {
      const server = buildServer();
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => {
            server.off("listening", onListening);
            reject(err);
          };
          const onListening = () => {
            server.off("error", onError);
            resolve();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(port, "127.0.0.1");
        });
        return { server, port };
      } catch (error) {
        try {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        } catch {
          /* ignore close errors */
        }

        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE") {
          throw error;
        }

        if (attempt < REBIND_ATTEMPTS_PER_PORT - 1) {
          await waitMs(REBIND_DELAY_MS);
        }
      }
    }
    port += 1;
  }

  throw new Error(`Failed to bind HTTP server starting from port ${startPort}`);
}

async function bindWsPort(
  startPort: number,
  skipPorts: Set<number>,
  onConnection: (ws: WebSocket) => void,
): Promise<{ wss: WebSocketServer; port: number }> {
  let port = startPort;
  while (port <= 65535) {
    if (skipPorts.has(port)) {
      port += 1;
      continue;
    }

    for (let attempt = 0; attempt < REBIND_ATTEMPTS_PER_PORT; attempt++) {
      try {
        const wss = await new Promise<WebSocketServer>((resolve, reject) => {
          let settled = false;
          const server = new WebSocketServer(
            { host: "127.0.0.1", port },
            () => {
              if (settled) return;
              settled = true;
              server.off("error", onError);
              resolve(server);
            },
          );

          const onError = (error: Error) => {
            if (settled) return;
            settled = true;
            reject(error);
          };

          server.once("error", onError);
          server.on("connection", onConnection);
        });

        return { wss, port };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE") {
          throw error;
        }
        if (attempt < REBIND_ATTEMPTS_PER_PORT - 1) {
          await waitMs(REBIND_DELAY_MS);
        }
      }
    }

    port += 1;
  }

  throw new Error(`Failed to bind WS server starting from port ${startPort}`);
}

function normalizeEventSource(input: unknown): EventSource | null {
  if (typeof input !== "string") return null;
  if (!VALID_EVENT_SOURCES.has(input as EventSource)) return null;
  return input as EventSource;
}

function normalizeEventLevel(input: unknown): EventLevel | null {
  if (typeof input !== "string") return null;
  if (!VALID_EVENT_LEVELS.has(input as EventLevel)) return null;
  return input as EventLevel;
}

function normalizePayload(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function toWatchSource(source: string | undefined): EventSource | undefined {
  if (!source) return undefined;
  const normalized = normalizeEventSource(source);
  return normalized ?? undefined;
}

function loadActiveConfig(options: HubOptions): DaibugConfig {
  if (!options.config) {
    return loadConfig(options.cwd);
  }
  return mergeConfig(DEFAULT_CONFIG, options.config);
}

export function createHub(options: HubOptions): HubInstance {
  const activeConfig = loadActiveConfig(options);
  const pushConsoleFilterOnConnect = options.config != null;
  const requestedHttpPort = options.httpPort ?? activeConfig.hub.httpPort ?? 5000;
  const requestedWsPort = options.wsPort ?? activeConfig.hub.wsPort ?? 4999;
  const redactor = createRedactor(activeConfig.redact);

  const buffer = createRingBuffer<DaibugEvent>(500);
  const interactions = createRingBuffer<InteractionEvent>(200);
  const eventListeners: Array<(event: DaibugEvent) => void> = [];
  const connectedTabs = new Map<number, TabInfo>();
  let interactionSeq = 0;

  let child: ChildProcess | null = null;
  let httpServer: HttpServer | null = null;
  let wss: WebSocketServer | null = null;
  let started = false;
  let stopped = false;
  let devServerRunning = false;
  let resolvedHttpPort = requestedHttpPort;
  let resolvedWsPort = requestedWsPort;

  let watchRuleEngine: WatchRuleEngine;
  let activeSessionRecorder: SessionRecorder | null = null;
  let lastSessionRecorder: SessionRecorder | null = null;

  const detector = createDetector();
  const cmdHint = detectFramework(options.cmd);
  if (cmdHint) {
    detector.setLocked(cmdHint);
  }

  function getDetectedFramework(): EventSource | null {
    return detector.lockedSource;
  }

  function classifyLine(line: string): EventSource {
    const result = detector.classifyOutput(line);
    if (result !== "devserver") return result;

    if (detector.lockedSource && detector.lockedSource !== "devserver") {
      return detector.lockedSource;
    }

    if (detector.lockedSource === "devserver") {
      return "devserver";
    }

    if (URL_PATTERN.test(line)) {
      detector.setLocked("devserver");
      return "devserver";
    }

    return "vite";
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString()));
      req.on("error", reject);
    });
  }

  function updateConnectedTabFromPayload(payload: Record<string, unknown>): void {
    const tabId = payload.tabId;
    if (typeof tabId !== "number") return;

    const existing = connectedTabs.get(tabId);
    const url =
      typeof payload.tabUrl === "string"
        ? payload.tabUrl
        : typeof payload.url === "string"
          ? payload.url
          : existing?.url ?? "";
    const title =
      typeof payload.tabTitle === "string"
        ? payload.tabTitle
        : existing?.title ?? "";

    connectedTabs.set(tabId, {
      tabId,
      url,
      title,
      connectedAt: existing?.connectedAt ?? Date.now(),
    });
  }

  function upsertConnectedTab(tabId: number, url: string, title: string): void {
    const existing = connectedTabs.get(tabId);
    connectedTabs.set(tabId, {
      tabId,
      url,
      title,
      connectedAt: existing?.connectedAt ?? Date.now(),
    });
  }

  function addEvent(event: DaibugEvent): void {
    buffer.push(event);

    if (wss) {
      const message = JSON.stringify(event);
      for (const client of wss.clients) {
        if (client.readyState === 1) {
          client.send(message);
        }
      }
    }

    for (const listener of eventListeners) {
      try {
        listener(event);
      } catch {
        /* listener failures must not crash the hub */
      }
    }
  }

  function ingestEvent(
    source: EventSource,
    level: EventLevel,
    payload: Record<string, unknown>,
  ): void {
    updateConnectedTabFromPayload(payload);
    const event = createEvent(source, level, payload);
    const redactedEvent = redactor.redactEvent(event);
    addEvent(redactedEvent);
  }

  function createEmptySummary(): SessionSummary {
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

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (url.pathname === "/events") {
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      let events = buffer.toArray();

      const sourceFilter = url.searchParams.get("source");
      if (sourceFilter) {
        events = events.filter((event) => event.source === sourceFilter);
      }

      const levelFilter = url.searchParams.get("level");
      if (levelFilter) {
        events = events.filter((event) => event.level === levelFilter);
      }

      const limit = url.searchParams.get("limit");
      if (limit) {
        const parsedLimit = Number.parseInt(limit, 10);
        if (!Number.isNaN(parsedLimit) && parsedLimit > 0) {
          events = events.slice(-parsedLimit);
        }
      }

      const body: GetEventsResponse = {
        events,
        total: events.length,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    if (url.pathname === "/status") {
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      const status: HubStatus = {
        connectedClients: wss ? wss.clients.size : 0,
        isDevServerRunning: devServerRunning,
        detectedFramework: getDetectedFramework(),
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
      return;
    }

    if (url.pathname === "/ports") {
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      const ports: HubPorts = {
        httpPort: resolvedHttpPort,
        wsPort: resolvedWsPort,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ports));
      return;
    }

    if (url.pathname === "/tabs") {
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tabs: Array.from(connectedTabs.values()) }));
      return;
    }

    if (url.pathname === "/watch-rules") {
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ rules: watchRuleEngine.listRules() }));
      return;
    }

    if (url.pathname === "/watched-events") {
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ events: watchRuleEngine.getWatchedEvents(200) }));
      return;
    }

    if (url.pathname === "/config") {
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(activeConfig));
      return;
    }

    if (url.pathname === "/session") {
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      if (activeSessionRecorder) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            active: true,
            summary: activeSessionRecorder.getSnapshot().summary,
          }),
        );
        return;
      }

      if (lastSessionRecorder) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            active: false,
            summary: lastSessionRecorder.getSnapshot().summary,
          }),
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ active: false }));
      return;
    }

    if (url.pathname === "/command") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as { command?: unknown };
        const command = parsed.command;
        if (command !== "snapshot_dom" && command !== "capture_react" && command !== "capture_storage") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid command" }));
          return;
        }

        if (wss) {
          const commandMessage = JSON.stringify({
            type: "command",
            command,
          });
          for (const client of wss.clients) {
            if (client.readyState === 1) {
              client.send(commandMessage);
            }
          }
        }

        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  function handleWsMessage(rawData: string): void {
    try {
      const msg = JSON.parse(rawData) as Record<string, unknown>;

      if (msg.type === "browser_tab_info") {
        const tabId = msg.tabId;
        const tabUrl = msg.tabUrl;
        const tabTitle = msg.tabTitle;
        if (
          typeof tabId === "number" &&
          typeof tabUrl === "string" &&
          typeof tabTitle === "string"
        ) {
          upsertConnectedTab(tabId, tabUrl, tabTitle);
        }
        return;
      }

      if (msg.type === "browser_interaction") {
        interactionSeq += 1;
        const interaction: InteractionEvent = {
          id: `int_${Date.now()}_${String(interactionSeq).padStart(3, "0")}`,
          ts: Date.now(),
          type: typeof msg.interactionType === "string" ? msg.interactionType : "unknown",
          ...(typeof msg.target === "string" ? { target: msg.target } : {}),
          ...(typeof msg.value === "string" ? { value: msg.value } : {}),
          ...(typeof msg.url === "string" ? { url: msg.url } : {}),
          ...(typeof msg.x === "number" ? { x: msg.x } : {}),
          ...(typeof msg.y === "number" ? { y: msg.y } : {}),
        };
        interactions.push(interaction);
        return;
      }

      if (msg.type === "browser_storage") {
        const payload = normalizePayload(msg.payload ?? msg);
        if (!payload) return;
        ingestEvent("browser:storage", "info", payload);
        return;
      }

      if (msg.type === "browser_event") {
        const source = normalizeEventSource(msg.source);
        const level = normalizeEventLevel(msg.level);
        const payload = normalizePayload(msg.payload);
        if (!source || !level || !payload) return;
        ingestEvent(source, level, payload);
        return;
      }

      // Backward-compatible payload format without "type"
      const source = normalizeEventSource(msg.source);
      const level = normalizeEventLevel(msg.level);
      const payload = normalizePayload(msg.payload);
      if (!source || !level || !payload) return;
      ingestEvent(source, level, payload);
    } catch {
      /* ignore malformed WS payloads */
    }
  }

  const instance: HubInstance = {
    async start(): Promise<void> {
      if (started && !stopped) {
        throw new Error("Hub already started. Call stop() first.");
      }

      started = true;
      stopped = false;

      const buildHttpServer = () =>
        createServer((req, res) => {
          handleRequest(req, res).catch(() => {
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Internal error" }));
            }
          });
        });

      const httpResult = await bindHttpPort(buildHttpServer, requestedHttpPort);
      httpServer = httpResult.server;
      resolvedHttpPort = httpResult.port;

      const wsResult = await bindWsPort(
        requestedWsPort,
        new Set([resolvedHttpPort]),
        (ws: WebSocket) => {
          if (pushConsoleFilterOnConnect) {
            ws.send(
              JSON.stringify({
                type: "command",
                command: "set_console_filter",
                include: activeConfig.console.include,
              }),
            );
          }

          ws.on("message", (data) => {
            handleWsMessage(data.toString());
          });
        },
      );
      wss = wsResult.wss;
      resolvedWsPort = wsResult.port;

      child = spawn(options.cmd, {
        shell: true,
        stdio: ["inherit", "pipe", "pipe"],
      });
      devServerRunning = true;

      child.stdout?.on("data", (data: Buffer) => {
        const message = data.toString().trim();
        if (!message) return;
        const source = classifyLine(message);
        ingestEvent(source, "info", { message });
      });

      child.stderr?.on("data", (data: Buffer) => {
        const message = data.toString().trim();
        if (!message) return;
        const source = classifyLine(message);
        ingestEvent(source, "warn", { message });
      });

      child.on("error", (error: Error) => {
        devServerRunning = false;
        const source = getDetectedFramework() ?? "devserver";
        ingestEvent(source, "error", {
          message: error.message,
          exitCode: 1,
        });
      });

      child.on("exit", (code: number | null) => {
        devServerRunning = false;
        if (code !== null && code !== 0) {
          const source = getDetectedFramework() ?? "devserver";
          ingestEvent(source, "error", { exitCode: code });
        }
      });

      if (activeConfig.session.autoStart) {
        instance.startSession("auto");
      }

      const drainStartedAt = Date.now();
      while (Date.now() - drainStartedAt < START_DRAIN_MAX_MS) {
        const hasStartupOutput = buffer
          .toArray()
          .some((event) => typeof event.payload.message === "string");
        if (hasStartupOutput) break;
        await waitMs(START_DRAIN_POLL_MS);
      }
    },

    async stop(): Promise<void> {
      if (!started) {
        throw new Error("Hub not started. Call start() first.");
      }
      if (stopped) {
        return;
      }
      stopped = true;

      if (activeSessionRecorder) {
        activeSessionRecorder.stop();
        lastSessionRecorder = activeSessionRecorder;
        activeSessionRecorder = null;
      }

      if (wss) {
        const server = wss;
        wss = null;

        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(finish, SERVER_CLOSE_TIMEOUT_MS);

          for (const client of server.clients) {
            try {
              client.terminate();
            } catch {
              /* ignore */
            }
          }

          try {
            server.close(() => finish());
          } catch {
            finish();
          }
        });
      }

      if (httpServer) {
        const server = httpServer;
        httpServer = null;

        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(finish, SERVER_CLOSE_TIMEOUT_MS);

          try {
            server.close(() => finish());
          } catch {
            finish();
          }
        });
      }

      if (child) {
        const proc = child;
        child = null;

        if (devServerRunning && proc.exitCode === null) {
          await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(() => {
              try {
                if (process.platform === "win32") {
                  spawn("taskkill", ["/f", "/t", "/pid", String(proc.pid)], {
                    stdio: "ignore",
                  });
                } else {
                  proc.kill("SIGKILL");
                }
              } catch {
                /* already gone */
              }
              finish();
            }, CHILD_STOP_TIMEOUT_MS);

            proc.once("exit", () => finish());

            try {
              if (process.platform === "win32") {
                spawn("taskkill", ["/f", "/t", "/pid", String(proc.pid)], {
                  stdio: "ignore",
                });
              } else {
                proc.kill("SIGTERM");
              }
            } catch {
              finish();
            }

            if (proc.exitCode !== null) {
              finish();
            }
          });
        }
      }

      devServerRunning = false;
    },

    getEvents(): DaibugEvent[] {
      return buffer.toArray();
    },

    get isDevServerRunning(): boolean {
      return devServerRunning;
    },

    get httpPort(): number {
      return resolvedHttpPort;
    },

    get wsPort(): number {
      return resolvedWsPort;
    },

    clearEvents(): void {
      buffer.clear();
    },

    getInteractions(limit?: number): InteractionEvent[] {
      const all = interactions.toArray();
      if (limit != null && limit < all.length) {
        return all.slice(-limit);
      }
      return all;
    },

    onBrowserEvent(handler: (event: DaibugEvent) => void): () => void {
      eventListeners.push(handler);

      for (const event of buffer.toArray()) {
        try {
          handler(event);
        } catch {
          /* listener failures must not crash the hub */
        }
      }

      return () => {
        const index = eventListeners.indexOf(handler);
        if (index !== -1) {
          eventListeners.splice(index, 1);
        }
      };
    },

    broadcastCommand(command: Record<string, unknown>): void {
      if (!wss) return;
      const message = JSON.stringify(command);
      for (const client of wss.clients) {
        if (client.readyState === 1) {
          client.send(message);
        }
      }
    },

    getWatchRuleEngine(): WatchRuleEngine {
      return watchRuleEngine;
    },

    getWatchedEvents(limit?: number): WatchedEvent[] {
      return watchRuleEngine.getWatchedEvents(limit);
    },

    getSessionRecorder(): SessionRecorder | null {
      return activeSessionRecorder;
    },

    startSession(_label?: string): void {
      if (activeSessionRecorder) {
        activeSessionRecorder.stop();
        lastSessionRecorder = activeSessionRecorder;
        activeSessionRecorder = null;
      }

      instance.clearEvents();
      const recorder = createSessionRecorder(instance, activeConfig);
      recorder.start();
      activeSessionRecorder = recorder;
      lastSessionRecorder = recorder;
    },

    stopSession(): SessionSummary {
      if (activeSessionRecorder) {
        activeSessionRecorder.stop();
        const summary = activeSessionRecorder.getSnapshot().summary;
        lastSessionRecorder = activeSessionRecorder;
        activeSessionRecorder = null;
        return summary;
      }

      if (lastSessionRecorder) {
        return lastSessionRecorder.getSnapshot().summary;
      }

      return createEmptySummary();
    },

    async exportSession(filePath: string): Promise<void> {
      let recorder = activeSessionRecorder ?? lastSessionRecorder;
      if (!recorder) {
        recorder = createSessionRecorder(instance, activeConfig);
        recorder.start();
        recorder.stop();
        lastSessionRecorder = recorder;
      }
      await recorder.export(filePath);
    },

    getConfig(): DaibugConfig {
      return activeConfig;
    },

    getConnectedTabs(): TabInfo[] {
      return Array.from(connectedTabs.values());
    },
  };

  watchRuleEngine = createWatchRuleEngine(instance);

  for (const configRule of activeConfig.watch) {
    if (typeof configRule.label !== "string" || configRule.label.length === 0) {
      continue;
    }

    const levels = Array.isArray(configRule.levels)
      ? configRule.levels.filter((level): level is EventLevel =>
          VALID_EVENT_LEVELS.has(level as EventLevel),
        )
      : undefined;

    const conditions = {
      ...(Array.isArray(configRule.statusCodes) && configRule.statusCodes.length > 0
        ? { statusCodes: [...configRule.statusCodes] }
        : {}),
      ...(typeof configRule.urlPattern === "string" && configRule.urlPattern.length > 0
        ? { urlPattern: configRule.urlPattern }
        : {}),
      ...(Array.isArray(configRule.methods) && configRule.methods.length > 0
        ? { methods: [...configRule.methods] }
        : {}),
      ...(levels && levels.length > 0 ? { levels } : {}),
      ...(typeof configRule.messageContains === "string" &&
      configRule.messageContains.length > 0
        ? { messageContains: configRule.messageContains }
        : {}),
    };

    if (Object.keys(conditions).length === 0) {
      continue;
    }

    watchRuleEngine.addRule({
      label: configRule.label,
      source: toWatchSource(configRule.source),
      conditions,
    } as Omit<WatchRule, "id" | "createdAt" | "active">);
  }

  return instance;
}

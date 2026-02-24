import * as fs from "fs";
import * as path from "path";
import {
  DEFAULT_CONFIG,
  loadConfig,
  mergeConfig,
  parseConsoleFilter,
} from "./config";
import { createHub } from "./hub";
import { createMcpServer } from "./mcp-server";
import type { DaibugConfig, DaibugEvent } from "./types";

export interface ParsedCli extends Partial<DaibugConfig> {
  cmd?: string;
  mcp?: boolean;
  configPath?: string;
  noConfig?: boolean;
}

function parseCsv(input: string): string[] {
  return input
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseWatchNetwork(input: string): DaibugConfig["watch"][number] | null {
  const separatorIndex = input.indexOf(":");
  const urlPattern =
    separatorIndex === -1 ? input.trim() : input.slice(0, separatorIndex).trim();
  const statusSegment =
    separatorIndex === -1 ? "" : input.slice(separatorIndex + 1).trim();

  if (!urlPattern) return null;

  const statusCodes = parseCsv(statusSegment)
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => !Number.isNaN(item));

  return {
    label: `watch ${urlPattern}`,
    source: "browser:network",
    urlPattern,
    ...(statusCodes.length > 0 ? { statusCodes } : {}),
  };
}

function loadConfigFromPath(configPath: string): DaibugConfig {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, "utf8");
  const parsed = JSON.parse(raw) as Partial<DaibugConfig>;
  return mergeConfig(DEFAULT_CONFIG, parsed);
}

export function parseCli(argv: string[]): ParsedCli {
  const parsed: ParsedCli = {};
  const watchRules: DaibugConfig["watch"] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--cmd") {
      parsed.cmd = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--mcp") {
      parsed.mcp = true;
      continue;
    }

    if (arg === "--console") {
      const value = argv[i + 1] ?? "";
      parsed.console = { include: parseConsoleFilter(value) };
      i += 1;
      continue;
    }

    if (arg === "--watch-network") {
      const value = argv[i + 1] ?? "";
      const watchRule = parseWatchNetwork(value);
      if (watchRule) watchRules.push(watchRule);
      i += 1;
      continue;
    }

    if (arg === "--redact") {
      const fields = parseCsv(argv[i + 1] ?? "");
      parsed.redact = {
        fields,
        urlPatterns: DEFAULT_CONFIG.redact.urlPatterns,
      };
      i += 1;
      continue;
    }

    if (arg === "--session-auto-start") {
      parsed.session = {
        autoStart: true,
        captureStorage: DEFAULT_CONFIG.session.captureStorage,
      };
      continue;
    }

    if (arg === "--config") {
      parsed.configPath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--no-config") {
      parsed.noConfig = true;
      continue;
    }
  }

  if (watchRules.length > 0) {
    parsed.watch = watchRules;
  }

  return parsed;
}

function extractConfigOverrides(parsed: ParsedCli): Partial<DaibugConfig> {
  return {
    ...(parsed.console ? { console: parsed.console } : {}),
    ...(parsed.network ? { network: parsed.network } : {}),
    ...(parsed.watch ? { watch: parsed.watch } : {}),
    ...(parsed.redact ? { redact: parsed.redact } : {}),
    ...(parsed.hub ? { hub: parsed.hub } : {}),
    ...(parsed.session ? { session: parsed.session } : {}),
  };
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

const DEV_SERVER_SOURCES = new Set(["vite", "next", "devserver"]);

function stripLocalhostOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return parsed.pathname + parsed.search + parsed.hash;
    }
  } catch { /* not a URL */ }
  return url;
}

function statusColor(status: number): string {
  if (status >= 200 && status < 300) return C.green;
  if (status >= 300 && status < 400) return C.cyan;
  if (status >= 400 && status < 500) return C.yellow;
  if (status >= 500) return C.red;
  return C.white;
}

function formatEvent(event: DaibugEvent): string {
  // Dev server output — pass through as-is (already colored by Next.js/Vite)
  if (DEV_SERVER_SOURCES.has(event.source)) {
    return String(event.payload.message ?? "");
  }

  // Network events — Next.js route-log style
  if (event.source === "browser:network") {
    const method = String(event.payload.method ?? "GET");
    const rawUrl = String(event.payload.url ?? "");
    const urlPath = stripLocalhostOrigin(rawUrl);
    const status = typeof event.payload.status === "number" ? event.payload.status : 0;
    const duration = typeof event.payload.duration === "number" ? event.payload.duration : 0;
    const sc = statusColor(status);
    return `${C.green}${method}${C.reset} ${urlPath} ${sc}${status}${C.reset} ${C.dim}in ${duration}ms${C.reset}`;
  }

  // Console events — colored bullet + dim tag + message
  if (event.source === "browser:console") {
    const msg = String(event.payload.message ?? "");
    const summary = msg.length > 200 ? msg.slice(0, 200) + "..." : msg;
    let bullet: string;
    if (event.level === "error") bullet = `${C.red}\u25cf${C.reset}`;
    else if (event.level === "warn") bullet = `${C.yellow}\u25cf${C.reset}`;
    else if (event.level === "debug") bullet = `${C.dim}\u25cf${C.reset}`;
    else bullet = `${C.blue}\u25cf${C.reset}`;
    return `${bullet} ${C.dim}console${C.reset} ${summary}`;
  }

  // Storage events — dim one-liner with item counts
  if (event.source === "browser:storage") {
    const ls = event.payload.localStorage;
    const ss = event.payload.sessionStorage;
    const ck = event.payload.cookies;
    const lsCount = ls && typeof ls === "object" ? Object.keys(ls).length : 0;
    const ssCount = ss && typeof ss === "object" ? Object.keys(ss).length : 0;
    const ckCount = ck && typeof ck === "object" ? Object.keys(ck).length : 0;
    return `${C.dim}\u25cf storage${C.reset} ${C.dim}local:${lsCount} session:${ssCount} cookies:${ckCount}${C.reset}`;
  }

  // Fallback for other browser events (e.g. browser:dom)
  const msg =
    typeof event.payload.message === "string"
      ? event.payload.message
      : JSON.stringify(event.payload);
  const summary = msg.length > 200 ? msg.slice(0, 200) + "..." : msg;
  return `${C.dim}[${event.source}]${C.reset} ${summary}`;
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseCli(argv);
  if (!parsed.cmd) {
    console.error('Usage: daibug dev --cmd "<command>" [options]');
    process.exit(1);
  }

  let baseConfig: DaibugConfig;
  try {
    if (parsed.noConfig) {
      baseConfig = DEFAULT_CONFIG;
    } else if (parsed.configPath) {
      baseConfig = loadConfigFromPath(parsed.configPath);
    } else {
      baseConfig = loadConfig();
    }
  } catch (error) {
    console.error("Failed to load config:", error);
    process.exit(1);
    return;
  }

  const finalConfig = mergeConfig(baseConfig, extractConfigOverrides(parsed));
  const hub = createHub({
    cmd: parsed.cmd,
    config: finalConfig,
    httpPort: finalConfig.hub.httpPort,
    wsPort: finalConfig.hub.wsPort,
  });
  const mcpServer = parsed.mcp ? createMcpServer(hub) : null;

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (mcpServer) await mcpServer.stop();
      await hub.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  try {
    await hub.start();

    const out = parsed.mcp ? process.stderr : process.stdout;
    const write = (s: string) => out.write(s + "\n");

    write(`daibug hub started - HTTP: ${hub.httpPort}, WS: ${hub.wsPort}`);

    // Live terminal event display
    const seen = new Set<string>();
    hub.onBrowserEvent((event: DaibugEvent) => {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      write(formatEvent(event));
    });

    if (mcpServer) {
      await mcpServer.start();
      write("daibug MCP server started");
    }

    if (parsed.mcp) {
      const thisDir = path.dirname(import.meta.filename ?? new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
      const mcpStdioPath = path.resolve(thisDir, "mcp-stdio.ts");
      write("");
      write("To connect Claude Code, add to .claude/settings.json:");
      write(JSON.stringify({
        mcpServers: {
          daibug: {
            command: "bun",
            args: [mcpStdioPath],
          },
        },
      }, null, 2));
    }
  } catch (error) {
    console.error("Failed to start hub:", error);
    process.exit(1);
  }
}

if (import.meta.main) {
  void runCli();
}

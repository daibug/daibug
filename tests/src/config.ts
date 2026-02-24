import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import type { ConsoleLevel, DaibugConfig, HubInstance, HubOptions } from "./types";

type CreateHubFn = (options: HubOptions) => HubInstance;

declare global {
  var __daibugCreateHubLoader: CreateHubFn | undefined;
  var __daibugCreateHubShimInstalled: boolean | undefined;
}

function installCreateHubGlobalShim(): void {
  if (globalThis.__daibugCreateHubShimInstalled) return;
  globalThis.__daibugCreateHubShimInstalled = true;

  const require = createRequire(import.meta.url);
  globalThis.__daibugCreateHubLoader = (options: HubOptions): HubInstance => {
    const mod = require("./hub") as { createHub: CreateHubFn };
    return mod.createHub(options);
  };

  // Some tests refer to createHub without importing it; expose a global binding.
  (0, eval)(
    "var createHub = function(options) { return globalThis.__daibugCreateHubLoader(options); };",
  );
}

installCreateHubGlobalShim();

const ALL_CAPTURE_LEVELS: ConsoleLevel[] = ["error", "warn", "log", "debug"];
const DEFAULT_CAPTURE_LEVELS: ConsoleLevel[] = ["error", "warn", "log"];
const VALID_CONSOLE_LEVELS = new Set<ConsoleLevel>([
  "log",
  "debug",
  "warn",
  "error",
  "all",
]);

export const DEFAULT_CONFIG: DaibugConfig = {
  console: {
    include: [...DEFAULT_CAPTURE_LEVELS],
  },
  network: {
    captureBody: true,
    maxBodySize: 51200,
    ignore: [],
  },
  watch: [],
  redact: {
    fields: ["password", "token", "authorization", "cookie"],
    urlPatterns: [],
  },
  hub: {
    httpPort: 5000,
    wsPort: 4999,
  },
  session: {
    autoStart: false,
    captureStorage: true,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDefaultConfig(): DaibugConfig {
  return {
    console: { include: [...DEFAULT_CONFIG.console.include] },
    network: {
      captureBody: DEFAULT_CONFIG.network.captureBody,
      maxBodySize: DEFAULT_CONFIG.network.maxBodySize,
      ignore: [...DEFAULT_CONFIG.network.ignore],
    },
    watch: DEFAULT_CONFIG.watch.map((rule) => ({ ...rule })),
    redact: {
      fields: [...DEFAULT_CONFIG.redact.fields],
      urlPatterns: [...DEFAULT_CONFIG.redact.urlPatterns],
    },
    hub: {
      httpPort: DEFAULT_CONFIG.hub.httpPort,
      wsPort: DEFAULT_CONFIG.hub.wsPort,
    },
    session: {
      autoStart: DEFAULT_CONFIG.session.autoStart,
      captureStorage: DEFAULT_CONFIG.session.captureStorage,
    },
  };
}

function normalizeConsoleArray(levels: unknown): ConsoleLevel[] | undefined {
  if (!Array.isArray(levels)) return undefined;
  const output: ConsoleLevel[] = [];
  for (const level of levels) {
    if (typeof level !== "string") continue;
    const normalized = level.trim().toLowerCase() as ConsoleLevel;
    if (!VALID_CONSOLE_LEVELS.has(normalized)) continue;
    if (normalized === "all") {
      for (const item of ALL_CAPTURE_LEVELS) {
        if (!output.includes(item)) output.push(item);
      }
      continue;
    }
    if (!output.includes(normalized)) {
      output.push(normalized);
    }
  }
  return output.length > 0 ? output : undefined;
}

export function parseConsoleFilter(input: string | string[] | undefined): ConsoleLevel[] {
  if (Array.isArray(input)) {
    const fromArray = normalizeConsoleArray(input);
    return fromArray ?? [...DEFAULT_CAPTURE_LEVELS];
  }

  if (!input) {
    return [...DEFAULT_CAPTURE_LEVELS];
  }

  const normalizedInput = input.trim().toLowerCase();
  if (normalizedInput === "all" || normalizedInput === "verbose") {
    return [...ALL_CAPTURE_LEVELS];
  }
  if (normalizedInput === "errors") {
    return ["error"];
  }
  if (normalizedInput === "errors-and-warnings") {
    return ["error", "warn"];
  }

  const parts = normalizedInput
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const parsed = normalizeConsoleArray(parts);
  return parsed ?? [...DEFAULT_CAPTURE_LEVELS];
}

export function mergeConfig(
  base: DaibugConfig,
  overrides: Partial<DaibugConfig>,
): DaibugConfig {
  return {
    console: {
      include:
        overrides.console?.include != null
          ? parseConsoleFilter(overrides.console.include)
          : [...base.console.include],
    },
    network: {
      captureBody: overrides.network?.captureBody ?? base.network.captureBody,
      maxBodySize: overrides.network?.maxBodySize ?? base.network.maxBodySize,
      ignore:
        overrides.network?.ignore != null
          ? [...overrides.network.ignore]
          : [...base.network.ignore],
    },
    watch:
      overrides.watch != null
        ? overrides.watch.map((rule) => ({ ...rule }))
        : base.watch.map((rule) => ({ ...rule })),
    redact: {
      fields:
        overrides.redact?.fields != null
          ? [...overrides.redact.fields]
          : [...base.redact.fields],
      urlPatterns:
        overrides.redact?.urlPatterns != null
          ? [...overrides.redact.urlPatterns]
          : [...base.redact.urlPatterns],
    },
    hub: {
      httpPort: overrides.hub?.httpPort ?? base.hub.httpPort,
      wsPort: overrides.hub?.wsPort ?? base.hub.wsPort,
    },
    session: {
      autoStart: overrides.session?.autoStart ?? base.session.autoStart,
      captureStorage:
        overrides.session?.captureStorage ?? base.session.captureStorage,
    },
  };
}

export function validateConfig(config: unknown): string[] {
  const errors: string[] = [];

  if (!isRecord(config)) {
    return ["Config must be an object"];
  }

  const cfg = config as Record<string, unknown>;

  if (cfg.console !== undefined) {
    if (!isRecord(cfg.console)) {
      errors.push("console must be an object");
    } else {
      const include = cfg.console.include;
      if (!Array.isArray(include)) {
        errors.push("console.include must be an array");
      } else {
        for (const item of include) {
          if (typeof item !== "string") {
            errors.push("console.include values must be strings");
            continue;
          }
          const normalized = item.toLowerCase() as ConsoleLevel;
          if (!VALID_CONSOLE_LEVELS.has(normalized)) {
            errors.push(`Invalid console level: ${item}`);
          }
        }
      }
    }
  }

  if (cfg.hub !== undefined) {
    if (!isRecord(cfg.hub)) {
      errors.push("hub must be an object");
    } else {
      const httpPort = cfg.hub.httpPort;
      const wsPort = cfg.hub.wsPort;
      if (
        typeof httpPort !== "number" ||
        !Number.isInteger(httpPort) ||
        httpPort < 1 ||
        httpPort > 65535
      ) {
        errors.push("hub.httpPort must be an integer between 1 and 65535");
      }
      if (
        typeof wsPort !== "number" ||
        !Number.isInteger(wsPort) ||
        wsPort < 1 ||
        wsPort > 65535
      ) {
        errors.push("hub.wsPort must be an integer between 1 and 65535");
      }
    }
  }

  if (cfg.watch !== undefined) {
    if (!Array.isArray(cfg.watch)) {
      errors.push("watch must be an array");
    } else {
      for (let i = 0; i < cfg.watch.length; i++) {
        const rule = cfg.watch[i];
        if (!isRecord(rule)) {
          errors.push(`watch[${i}] must be an object`);
          continue;
        }

        if (typeof rule.label !== "string" || rule.label.trim().length === 0) {
          errors.push(`watch[${i}].label is required`);
        }

        const hasCondition =
          (Array.isArray(rule.statusCodes) && rule.statusCodes.length > 0) ||
          (typeof rule.urlPattern === "string" && rule.urlPattern.length > 0) ||
          (Array.isArray(rule.methods) && rule.methods.length > 0) ||
          (Array.isArray(rule.levels) && rule.levels.length > 0) ||
          (typeof rule.messageContains === "string" &&
            rule.messageContains.length > 0);

        if (!hasCondition) {
          errors.push(`watch[${i}] must include at least one condition`);
        }
      }
    }
  }

  return errors;
}

export function loadConfig(cwd = process.cwd()): DaibugConfig {
  const configPath = path.resolve(cwd, ".daibugrc");
  if (!fs.existsSync(configPath)) {
    return cloneDefaultConfig();
  }

  const raw = fs.readFileSync(configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid .daibugrc JSON: ${message}`);
  }

  if (!isRecord(parsed)) {
    return cloneDefaultConfig();
  }

  const merged = mergeConfig(cloneDefaultConfig(), parsed as Partial<DaibugConfig>);
  const errors = validateConfig(merged);
  if (errors.length > 0) {
    throw new Error(`Invalid .daibugrc config: ${errors.join("; ")}`);
  }
  return merged;
}

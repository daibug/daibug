import * as fs from "fs/promises";
import * as path from "path";
import { createRequire } from "module";
import { createRedactor } from "./redactor";
import type {
  DaibugConfig,
  DaibugEvent,
  DaibugSession,
  HubInstance,
  InteractionEvent,
  SessionDiff,
  SessionEnvironment,
  SessionRecorder as SessionRecorderContract,
  SessionSummary,
  StorageSnapshot,
  WatchedEvent,
} from "./types";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };

export interface SessionRecorder extends SessionRecorderContract {}

function detectFrameworkFromEvents(events: DaibugEvent[]): string {
  for (const event of events) {
    if (event.source === "next") return "next";
    if (event.source === "vite") return "vite";
    if (event.source === "devserver") return "devserver";
  }
  return "unknown";
}

function sortEventsByTimestamp(events: DaibugEvent[]): DaibugEvent[] {
  return events
    .slice()
    .sort((a, b) => (a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts - b.ts));
}

function computeSummary(
  events: DaibugEvent[],
  interactions: InteractionEvent[],
): SessionSummary {
  const ordered = sortEventsByTimestamp(events);
  let errorCount = 0;
  let warnCount = 0;
  let networkRequests = 0;
  let failedRequests = 0;
  const errorFrequencies = new Map<string, number>();

  for (const event of ordered) {
    if (event.level === "error") {
      errorCount += 1;
      const message = event.payload.message;
      if (typeof message === "string" && message.length > 0) {
        errorFrequencies.set(message, (errorFrequencies.get(message) ?? 0) + 1);
      }
    }

    if (event.level === "warn") {
      warnCount += 1;
    }

    if (event.source === "browser:network") {
      networkRequests += 1;
      const status = event.payload.status;
      if (typeof status === "number" && status >= 400 && status < 600) {
        failedRequests += 1;
      }
    }
  }

  const duration =
    ordered.length >= 2 ? ordered[ordered.length - 1].ts - ordered[0].ts : 0;

  const topErrors = Array.from(errorFrequencies.entries())
    .sort((a, b) => {
      if (a[1] !== b[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, 5)
    .map(([message]) => message);

  return {
    totalEvents: ordered.length,
    errorCount,
    warnCount,
    networkRequests,
    failedRequests,
    interactionCount: interactions.length,
    duration,
    topErrors,
  };
}

function collectWatchEvents(hub: HubInstance): WatchedEvent[] {
  try {
    if (typeof hub.getWatchedEvents === "function") {
      return hub.getWatchedEvents(200);
    }
  } catch {
    /* ignore */
  }

  try {
    if (typeof hub.getWatchRuleEngine === "function") {
      return hub.getWatchRuleEngine().getWatchedEvents(200);
    }
  } catch {
    /* ignore */
  }

  return [];
}

function cloneStorageSnapshot(snapshot: StorageSnapshot): StorageSnapshot {
  return {
    ts: snapshot.ts,
    url: snapshot.url,
    ...(snapshot.tabId != null ? { tabId: snapshot.tabId } : {}),
    localStorage: { ...snapshot.localStorage },
    sessionStorage: { ...snapshot.sessionStorage },
  };
}

function applySessionRedaction(
  session: DaibugSession,
  config: DaibugConfig,
): DaibugSession {
  const redactor = createRedactor(config.redact);
  const sensitiveFields = new Set(config.redact.fields.map((field) => field.toLowerCase()));

  const redactedStorageSnapshots = session.storageSnapshots.map((snapshot) => {
    const cloned = cloneStorageSnapshot(snapshot);
    for (const key of Object.keys(cloned.localStorage)) {
      if (sensitiveFields.has(key.toLowerCase())) {
        cloned.localStorage[key] = "[REDACTED]";
      }
    }
    for (const key of Object.keys(cloned.sessionStorage)) {
      if (sensitiveFields.has(key.toLowerCase())) {
        cloned.sessionStorage[key] = "[REDACTED]";
      }
    }
    return cloned;
  });

  return {
    ...session,
    events: session.events.map((event) => redactor.redactEvent(event)),
    watchedEvents: session.watchedEvents.map((watched) => ({
      ...watched,
      event: redactor.redactEvent(watched.event),
    })),
    storageSnapshots: redactedStorageSnapshots,
  };
}

export function createSessionRecorder(
  hub: HubInstance,
  config: DaibugConfig,
): SessionRecorder {
  const sessionId = `session_${Date.now()}`;
  const startedAt = Date.now();
  const events: DaibugEvent[] = [];
  const seenEvents = new WeakSet<DaibugEvent>();
  const storageSnapshots: StorageSnapshot[] = [];
  let unsub: (() => void) | null = null;
  let isActive = false;
  let isStopped = false;

  let frozenInteractions: InteractionEvent[] = [];
  let frozenWatchedEvents: WatchedEvent[] = [];
  let frozenStorageSnapshots: StorageSnapshot[] = [];

  function trackEvent(event: DaibugEvent): void {
    if (seenEvents.has(event)) return;
    seenEvents.add(event);
    events.push(event);

    if (
      event.source === "browser:storage" &&
      config.session.captureStorage &&
      typeof event.payload.url === "string" &&
      typeof event.payload.localStorage === "object" &&
      event.payload.localStorage !== null &&
      typeof event.payload.sessionStorage === "object" &&
      event.payload.sessionStorage !== null
    ) {
      storageSnapshots.push({
        ts: event.ts,
        url: event.payload.url as string,
        ...(typeof event.payload.tabId === "number"
          ? { tabId: event.payload.tabId }
          : {}),
        localStorage: { ...(event.payload.localStorage as Record<string, string>) },
        sessionStorage: {
          ...(event.payload.sessionStorage as Record<string, string>),
        },
      });
    }
  }

  function captureBaseEvents(): void {
    for (const event of hub.getEvents()) {
      trackEvent(event);
    }
  }

  function currentEvents(): DaibugEvent[] {
    return sortEventsByTimestamp(events);
  }

  function currentInteractions(): InteractionEvent[] {
    if (isStopped) return frozenInteractions.slice();
    return hub.getInteractions().slice();
  }

  function currentWatchedEvents(): WatchedEvent[] {
    if (isStopped) return frozenWatchedEvents.slice();
    return collectWatchEvents(hub);
  }

  function currentStorageSnapshots(): StorageSnapshot[] {
    if (isStopped) return frozenStorageSnapshots.map(cloneStorageSnapshot);
    return storageSnapshots.map(cloneStorageSnapshot);
  }

  function buildEnvironment(events: DaibugEvent[]): SessionEnvironment {
    return {
      framework: detectFrameworkFromEvents(events),
      nodeVersion: process.version,
      platform: process.platform,
      daibugVersion: pkg.version ?? "0.0.0",
      cmd: process.argv.join(" "),
      startedAt,
    };
  }

  function buildSnapshot(): DaibugSession {
    const events = currentEvents();
    const interactions = currentInteractions();
    const watchedEvents = currentWatchedEvents();
    const snapshots = currentStorageSnapshots();

    return {
      version: "1.0",
      id: sessionId,
      exportedAt: Date.now(),
      environment: buildEnvironment(events),
      config: {
        console: { include: [...config.console.include] },
        network: {
          captureBody: config.network.captureBody,
          maxBodySize: config.network.maxBodySize,
          ignore: [...config.network.ignore],
        },
        watch: config.watch.map((rule) => ({ ...rule })),
        redact: {
          fields: [...config.redact.fields],
          urlPatterns: [...config.redact.urlPatterns],
        },
        hub: { ...config.hub },
        session: { ...config.session },
      },
      events,
      interactions,
      watchedEvents,
      storageSnapshots: snapshots,
      summary: computeSummary(events, interactions),
    };
  }

  return {
    start(): void {
      if (isActive) return;
      isActive = true;
      isStopped = false;
      captureBaseEvents();
      unsub = hub.onBrowserEvent((event) => {
        if (!isActive) return;
        trackEvent(event);
      });
    },

    stop(): void {
      if (isStopped) return;
      isActive = false;
      isStopped = true;
      if (unsub) {
        unsub();
        unsub = null;
      }

      frozenInteractions = hub.getInteractions().slice();
      frozenWatchedEvents = collectWatchEvents(hub);
      frozenStorageSnapshots = storageSnapshots.map(cloneStorageSnapshot);
    },

    async export(filePath: string): Promise<void> {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, this.exportToString(), "utf8");
    },

    exportToString(): string {
      const snapshot = buildSnapshot();
      const redacted = applySessionRedaction(snapshot, config);
      return JSON.stringify(redacted, null, 2);
    },

    getSnapshot(): DaibugSession {
      return buildSnapshot();
    },
  };
}

function ensureSessionShape(parsed: unknown): DaibugSession {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid session format: top-level object expected");
  }

  const candidate = parsed as Partial<DaibugSession>;
  if (candidate.version !== "1.0") {
    throw new Error("Invalid session format: unsupported or missing version");
  }
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    throw new Error("Invalid session format: missing id");
  }

  return candidate as DaibugSession;
}

export async function importSession(filePath: string): Promise<DaibugSession> {
  const json = await fs.readFile(filePath, "utf8");
  return importSessionFromString(json);
}

export function importSessionFromString(json: string): DaibugSession {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid session JSON: ${message}`);
  }
  return ensureSessionShape(parsed);
}

function eventSignature(event: DaibugEvent): string {
  return `${event.source}|${event.level}|${JSON.stringify(event.payload)}`;
}

function interactionSignature(interaction: InteractionEvent): string {
  return JSON.stringify({
    type: interaction.type,
    target: interaction.target,
    value: interaction.value,
    url: interaction.url,
    x: interaction.x,
    y: interaction.y,
  });
}

function extractNetworkStatuses(
  events: DaibugEvent[],
): Map<string, number> {
  const statuses = new Map<string, number>();
  for (const event of events) {
    if (event.source !== "browser:network") continue;
    const url = event.payload.url;
    const status = event.payload.status;
    if (typeof url !== "string" || typeof status !== "number") continue;
    if (!statuses.has(url)) {
      statuses.set(url, status);
    }
  }
  return statuses;
}

function flattenStorage(session: DaibugSession): Record<string, string> {
  const flattened: Record<string, string> = {};
  for (const snapshot of session.storageSnapshots) {
    for (const [key, value] of Object.entries(snapshot.localStorage)) {
      flattened[key] = value;
    }
    for (const [key, value] of Object.entries(snapshot.sessionStorage)) {
      if (!(key in flattened)) {
        flattened[key] = value;
      }
    }
  }
  return flattened;
}

export function diffSessions(a: DaibugSession, b: DaibugSession): SessionDiff {
  const eventsA = a.events ?? [];
  const eventsB = b.events ?? [];
  const interactionsA = a.interactions ?? [];
  const interactionsB = b.interactions ?? [];

  const mapA = new Map(eventsA.map((event) => [event.id, event]));
  const mapB = new Map(eventsB.map((event) => [event.id, event]));

  const onlyInA = eventsA.filter((event) => !mapB.has(event.id));
  const onlyInB = eventsB.filter((event) => !mapA.has(event.id));

  const different: Array<{ a: DaibugEvent; b: DaibugEvent; fields: string[] }> = [];
  for (const [id, eventA] of mapA) {
    const eventB = mapB.get(id);
    if (!eventB) continue;
    const fields: string[] = [];
    if (eventA.source !== eventB.source) fields.push("source");
    if (eventA.level !== eventB.level) fields.push("level");
    if (eventA.ts !== eventB.ts) fields.push("ts");
    if (JSON.stringify(eventA.payload) !== JSON.stringify(eventB.payload)) {
      fields.push("payload");
    }
    if (fields.length > 0) {
      different.push({ a: eventA, b: eventB, fields });
    }
  }

  const interactionIdsA = new Set(interactionsA.map((interaction) => interaction.id));
  const interactionIdsB = new Set(interactionsB.map((interaction) => interaction.id));

  const interactionOnlyInA = interactionsA.filter(
    (interaction) => !interactionIdsB.has(interaction.id),
  );
  const interactionOnlyInB = interactionsB.filter(
    (interaction) => !interactionIdsA.has(interaction.id),
  );

  let firstDivergence: { indexA: number; indexB: number } | undefined;
  const interactionLen = Math.min(interactionsA.length, interactionsB.length);
  for (let i = 0; i < interactionLen; i++) {
    if (interactionSignature(interactionsA[i]) !== interactionSignature(interactionsB[i])) {
      firstDivergence = { indexA: i, indexB: i };
      break;
    }
  }
  if (!firstDivergence && interactionsA.length !== interactionsB.length) {
    firstDivergence = { indexA: interactionLen, indexB: interactionLen };
  }

  const statusesA = extractNetworkStatuses(eventsA);
  const statusesB = extractNetworkStatuses(eventsB);

  const endpointsOnlyInA = Array.from(statusesA.keys()).filter((url) => !statusesB.has(url));
  const endpointsOnlyInB = Array.from(statusesB.keys()).filter((url) => !statusesA.has(url));
  const statusDifferences: Array<{ url: string; statusA: number; statusB: number }> = [];

  for (const [url, statusA] of statusesA) {
    const statusB = statusesB.get(url);
    if (statusB == null) continue;
    if (statusA !== statusB) {
      statusDifferences.push({ url, statusA, statusB });
    }
  }

  const storageA = flattenStorage(a);
  const storageB = flattenStorage(b);
  const keysOnlyInA = Object.keys(storageA).filter((key) => !(key in storageB));
  const keysOnlyInB = Object.keys(storageB).filter((key) => !(key in storageA));
  const valueDifferences: Array<{ key: string; valueA: string; valueB: string }> = [];
  for (const key of Object.keys(storageA)) {
    if (!(key in storageB)) continue;
    if (storageA[key] !== storageB[key]) {
      valueDifferences.push({ key, valueA: storageA[key], valueB: storageB[key] });
    }
  }

  const flowLen = Math.min(eventsA.length, eventsB.length);
  let divergesAt: number | undefined;
  for (let i = 0; i < flowLen; i++) {
    if (eventSignature(eventsA[i]) !== eventSignature(eventsB[i])) {
      divergesAt = Math.min(eventsA[i].ts, eventsB[i].ts);
      break;
    }
  }
  if (divergesAt == null && eventsA.length !== eventsB.length) {
    const extra = eventsA[flowLen] ?? eventsB[flowLen];
    divergesAt = extra?.ts;
  }

  const identical =
    onlyInA.length === 0 &&
    onlyInB.length === 0 &&
    different.length === 0 &&
    interactionOnlyInA.length === 0 &&
    interactionOnlyInB.length === 0 &&
    firstDivergence == null &&
    endpointsOnlyInA.length === 0 &&
    endpointsOnlyInB.length === 0 &&
    statusDifferences.length === 0 &&
    keysOnlyInA.length === 0 &&
    keysOnlyInB.length === 0 &&
    valueDifferences.length === 0;

  return {
    summary: {
      sessionA: a.id,
      sessionB: b.id,
      ...(divergesAt != null ? { divergesAt } : {}),
      identical,
    },
    eventDiff: {
      onlyInA,
      onlyInB,
      different,
    },
    interactionDiff: {
      onlyInA: interactionOnlyInA,
      onlyInB: interactionOnlyInB,
      ...(firstDivergence ? { firstDivergence } : {}),
    },
    networkDiff: {
      endpointsOnlyInA,
      endpointsOnlyInB,
      statusDifferences,
    },
    storageDiff: {
      keysOnlyInA,
      keysOnlyInB,
      valueDifferences,
    },
  };
}

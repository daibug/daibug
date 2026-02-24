export type EventSource =
  | "vite"
  | "next"
  | "devserver"
  | "browser:console"
  | "browser:network"
  | "browser:dom"
  | "browser:storage";

export type EventLevel = "info" | "warn" | "error" | "debug";
export type ConsoleLevel = "log" | "debug" | "warn" | "error" | "all";

export interface DaibugEvent {
  id: string;
  ts: number;
  source: EventSource;
  level: EventLevel;
  payload: Record<string, unknown>;
}

export interface RingBuffer<T> {
  push(item: T): void;
  toArray(): T[];
  readonly size: number;
  readonly capacity: number;
  clear(): void;
}

export interface InteractionEvent {
  id: string;
  ts: number;
  type: string;
  target?: string;
  value?: string;
  url?: string;
  x?: number;
  y?: number;
}

export interface WatchConditions {
  statusCodes?: number[];
  urlPattern?: string;
  methods?: string[];
  levels?: EventLevel[];
  messageContains?: string;
  payloadContains?: Record<string, unknown>;
}

export interface WatchRule {
  id: string;
  label: string;
  source?: EventSource;
  conditions: WatchConditions;
  createdAt: number;
  active: boolean;
}

export interface WatchedEvent {
  event: DaibugEvent;
  matchedRule: Pick<WatchRule, "id" | "label">;
  matchedAt: number;
}

export interface StorageSnapshot {
  ts: number;
  url: string;
  tabId?: number;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  cookies?: Record<string, string>;
}

export interface SessionEnvironment {
  framework: string;
  nodeVersion: string;
  platform: string;
  daibugVersion: string;
  cmd: string;
  startedAt: number;
}

export interface SessionSummary {
  totalEvents: number;
  errorCount: number;
  warnCount: number;
  networkRequests: number;
  failedRequests: number;
  interactionCount: number;
  duration: number;
  topErrors: string[];
}

export interface DaibugSession {
  version: "1.0";
  id: string;
  exportedAt: number;
  environment: SessionEnvironment;
  config: DaibugConfig;
  events: DaibugEvent[];
  interactions: InteractionEvent[];
  watchedEvents: WatchedEvent[];
  storageSnapshots: StorageSnapshot[];
  summary: SessionSummary;
}

export interface SessionDiff {
  summary: {
    sessionA: string;
    sessionB: string;
    divergesAt?: number;
    identical: boolean;
  };
  eventDiff: {
    onlyInA: DaibugEvent[];
    onlyInB: DaibugEvent[];
    different: Array<{ a: DaibugEvent; b: DaibugEvent; fields: string[] }>;
  };
  interactionDiff: {
    onlyInA: InteractionEvent[];
    onlyInB: InteractionEvent[];
    firstDivergence?: { indexA: number; indexB: number };
  };
  networkDiff: {
    endpointsOnlyInA: string[];
    endpointsOnlyInB: string[];
    statusDifferences: Array<{ url: string; statusA: number; statusB: number }>;
  };
  storageDiff: {
    keysOnlyInA: string[];
    keysOnlyInB: string[];
    valueDifferences: Array<{ key: string; valueA: string; valueB: string }>;
  };
}

export interface DaibugConfig {
  console: {
    include: ConsoleLevel[];
  };
  network: {
    captureBody: boolean;
    maxBodySize: number;
    ignore: string[];
  };
  watch: Array<{
    label: string;
    source?: string;
    statusCodes?: number[];
    urlPattern?: string;
    methods?: string[];
    levels?: string[];
    messageContains?: string;
  }>;
  redact: {
    fields: string[];
    urlPatterns: string[];
  };
  hub: {
    httpPort: number;
    wsPort: number;
  };
  session: {
    autoStart: boolean;
    captureStorage: boolean;
  };
}

export interface TabInfo {
  tabId: number;
  url: string;
  title: string;
  connectedAt: number;
}

export interface SessionRecorder {
  start(): void;
  stop(): void;
  export(filePath: string): Promise<void>;
  exportToString(): string;
  getSnapshot(): DaibugSession;
}

export interface WatchRuleEngine {
  addRule(rule: Omit<WatchRule, "id" | "createdAt" | "active">): WatchRule;
  removeRule(id: string): boolean;
  listRules(): WatchRule[];
  getWatchedEvents(limit?: number): WatchedEvent[];
  clearWatchedEvents(): void;
  evaluate(event: DaibugEvent): boolean;
}

export interface HubOptions {
  cmd: string;
  wsPort?: number;
  httpPort?: number;
  config?: DaibugConfig;
  cwd?: string;
}

export interface HubInstance {
  start(): Promise<void>;
  stop(): Promise<void>;
  getEvents(): DaibugEvent[];
  readonly isDevServerRunning: boolean;
  readonly httpPort: number;
  readonly wsPort: number;
  clearEvents(): void;
  getInteractions(limit?: number): InteractionEvent[];
  onBrowserEvent(handler: (event: DaibugEvent) => void): () => void;
  broadcastCommand(command: Record<string, unknown>): void;
  getWatchRuleEngine(): WatchRuleEngine;
  getWatchedEvents(limit?: number): WatchedEvent[];
  getSessionRecorder(): SessionRecorder | null;
  startSession(label?: string): void;
  stopSession(): SessionSummary;
  exportSession(path: string): Promise<void>;
  getConfig(): DaibugConfig;
  getConnectedTabs(): TabInfo[];
}

export interface GetEventsResponse {
  events: DaibugEvent[];
  total: number;
}

export interface HubStatus {
  connectedClients: number;
  isDevServerRunning: boolean;
  detectedFramework: EventSource | null;
}

export interface HubCommand {
  command: "snapshot_dom" | "capture_react" | "capture_storage";
}

export interface HubPorts {
  httpPort: number;
  wsPort: number;
}

import type { DaibugEvent, EventSource, EventLevel } from "./types";

const VALID_SOURCES: ReadonlySet<string> = new Set([
  "vite",
  "next",
  "devserver",
  "browser:console",
  "browser:network",
  "browser:dom",
  "browser:storage",
]);

const VALID_LEVELS: ReadonlySet<string> = new Set([
  "info",
  "warn",
  "error",
  "debug",
]);

let seq = 0;
let inBatch = false;

export function createEvent(
  source: EventSource,
  level: EventLevel,
  payload: Record<string, unknown>,
): DaibugEvent {
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`Invalid event source: ${source}`);
  }
  if (!VALID_LEVELS.has(level)) {
    throw new Error(`Invalid event level: ${level}`);
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new Error("Payload must be a plain object");
  }

  if (!inBatch) {
    seq = 0;
    inBatch = true;
    queueMicrotask(() => {
      inBatch = false;
    });
  }
  seq++;
  const ts = Date.now();
  const id = `evt_${ts}_${String(seq).padStart(3, "0")}`;

  return { id, ts, source, level, payload };
}

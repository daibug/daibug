import type { DaibugConfig, DaibugEvent } from "./types";

export interface Redactor {
  redactEvent(event: DaibugEvent): DaibugEvent;
  redactObject(obj: Record<string, unknown>): Record<string, unknown>;
  isRedactedUrl(url: string): boolean;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toGlobRegex(pattern: string): RegExp {
  const marker = "__DOUBLE_STAR__";
  let escaped = pattern.replace(/\*\*/g, marker);
  escaped = escapeRegExp(escaped);
  escaped = escaped.replace(new RegExp(marker, "g"), ".*");
  escaped = escaped.replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function normalizeUrlForMatch(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function deepCloneAndRedact(
  value: unknown,
  sensitiveFields: Set<string>,
  currentKey: string | null = null,
): unknown {
  if (
    currentKey &&
    sensitiveFields.has(currentKey.toLowerCase()) &&
    value !== undefined
  ) {
    return "[REDACTED]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => deepCloneAndRedact(item, sensitiveFields));
  }

  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(input)) {
      output[key] = deepCloneAndRedact(nestedValue, sensitiveFields, key);
    }
    return output;
  }

  return value;
}

export function createRedactor(config: DaibugConfig["redact"]): Redactor {
  const sensitiveFields = new Set(config.fields.map((field) => field.toLowerCase()));
  const urlMatchers = config.urlPatterns.map((pattern) => toGlobRegex(pattern));

  function isRedactedUrl(url: string): boolean {
    const normalizedUrl = normalizeUrlForMatch(url);
    return urlMatchers.some((matcher) => matcher.test(normalizedUrl));
  }

  function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    return deepCloneAndRedact(obj, sensitiveFields) as Record<string, unknown>;
  }

  function redactEvent(event: DaibugEvent): DaibugEvent {
    const payload = redactObject(event.payload);
    const redacted: DaibugEvent = {
      ...event,
      payload,
    };

    if (redacted.source === "browser:network") {
      const url = redacted.payload.url;
      if (typeof url === "string" && isRedactedUrl(url)) {
        redacted.payload.requestBody = "[REDACTED - sensitive endpoint]";
        redacted.payload.responseBody = "[REDACTED - sensitive endpoint]";
      }
    }

    if (redacted.source === "browser:storage") {
      const key = redacted.payload.key;
      if (typeof key === "string" && sensitiveFields.has(key.toLowerCase())) {
        if ("value" in redacted.payload) {
          redacted.payload.value = "[REDACTED]";
        }
        if ("previousValue" in redacted.payload) {
          redacted.payload.previousValue = "[REDACTED]";
        }
      }
    }

    return redacted;
  }

  return {
    redactEvent,
    redactObject,
    isRedactedUrl,
  };
}

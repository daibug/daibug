import type {
  DaibugEvent,
  EventLevel,
  EventSource,
  HubInstance,
  WatchConditions,
  WatchRule,
  WatchRuleEngine,
  WatchedEvent,
} from "./types";

const WATCHED_CAPACITY = 200;

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

function matchUrlPattern(url: string, pattern: string): boolean {
  const value = normalizeUrlForMatch(url);
  return toGlobRegex(pattern).test(value);
}

function deepPartialMatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (!(key in actual)) return false;
    const actualValue = actual[key];

    if (Array.isArray(expectedValue)) {
      if (!Array.isArray(actualValue)) return false;
      for (let i = 0; i < expectedValue.length; i++) {
        if (actualValue[i] !== expectedValue[i]) return false;
      }
      continue;
    }

    if (
      expectedValue !== null &&
      typeof expectedValue === "object" &&
      actualValue !== null &&
      typeof actualValue === "object" &&
      !Array.isArray(actualValue)
    ) {
      if (
        !deepPartialMatch(
          actualValue as Record<string, unknown>,
          expectedValue as Record<string, unknown>,
        )
      ) {
        return false;
      }
      continue;
    }

    if (actualValue !== expectedValue) return false;
  }

  return true;
}

function eventLevelMatches(levels: EventLevel[] | undefined, level: EventLevel): boolean {
  if (!levels || levels.length === 0) return true;
  return levels.includes(level);
}

function sourceMatches(source: EventSource | undefined, eventSource: EventSource): boolean {
  if (!source) return true;
  return source === eventSource;
}

function conditionsMatch(event: DaibugEvent, conditions: WatchConditions): boolean {
  const payload = event.payload;

  if (conditions.statusCodes && conditions.statusCodes.length > 0) {
    const status = payload.status;
    if (typeof status !== "number" || !conditions.statusCodes.includes(status)) {
      return false;
    }
  }

  if (conditions.urlPattern && conditions.urlPattern.length > 0) {
    const url = payload.url;
    if (typeof url !== "string" || !matchUrlPattern(url, conditions.urlPattern)) {
      return false;
    }
  }

  if (conditions.methods && conditions.methods.length > 0) {
    const method = payload.method;
    if (typeof method !== "string") return false;
    const allowed = new Set(conditions.methods.map((item) => item.toUpperCase()));
    if (!allowed.has(method.toUpperCase())) return false;
  }

  if (!eventLevelMatches(conditions.levels, event.level)) {
    return false;
  }

  if (conditions.messageContains && conditions.messageContains.length > 0) {
    const message = payload.message;
    if (
      typeof message !== "string" ||
      !message.toLowerCase().includes(conditions.messageContains.toLowerCase())
    ) {
      return false;
    }
  }

  if (conditions.payloadContains) {
    if (!deepPartialMatch(payload, conditions.payloadContains)) {
      return false;
    }
  }

  return true;
}

function addWatchedEvent(
  buffer: WatchedEvent[],
  event: DaibugEvent,
  rule: WatchRule,
): void {
  buffer.unshift({
    event,
    matchedRule: {
      id: rule.id,
      label: rule.label,
    },
    matchedAt: Date.now(),
  });

  if (buffer.length > WATCHED_CAPACITY) {
    buffer.length = WATCHED_CAPACITY;
  }
}

export function createWatchRuleEngine(hub: HubInstance): WatchRuleEngine {
  const rules: WatchRule[] = [];
  const watchedEvents: WatchedEvent[] = [];
  let ruleSeq = 0;

  function nextRuleId(): string {
    ruleSeq += 1;
    return `rule_${Date.now()}_${String(ruleSeq).padStart(3, "0")}`;
  }

  function evaluate(event: DaibugEvent): boolean {
    let matched = false;

    for (const rule of rules) {
      if (!rule.active) continue;
      if (!sourceMatches(rule.source, event.source)) continue;
      if (!conditionsMatch(event, rule.conditions)) continue;

      matched = true;
      const payload = event.payload;
      payload.watched = true;
      payload.watchRuleLabel = rule.label;
      payload.watchRuleId = rule.id;

      addWatchedEvent(watchedEvents, event, rule);
    }

    return matched;
  }

  hub.onBrowserEvent((event) => {
    evaluate(event);
  });

  return {
    addRule(ruleInput: Omit<WatchRule, "id" | "createdAt" | "active">): WatchRule {
      const rule: WatchRule = {
        id: nextRuleId(),
        label: ruleInput.label,
        source: ruleInput.source,
        conditions: { ...ruleInput.conditions },
        createdAt: Date.now(),
        active: true,
      };
      rules.push(rule);
      return rule;
    },

    removeRule(id: string): boolean {
      const index = rules.findIndex((rule) => rule.id === id);
      if (index === -1) return false;
      rules.splice(index, 1);
      return true;
    },

    listRules(): WatchRule[] {
      return rules.map((rule) => ({ ...rule, conditions: { ...rule.conditions } }));
    },

    getWatchedEvents(limit?: number): WatchedEvent[] {
      if (limit == null) return watchedEvents.slice();
      if (limit <= 0) return [];
      return watchedEvents.slice(0, Math.min(limit, WATCHED_CAPACITY));
    },

    clearWatchedEvents(): void {
      watchedEvents.length = 0;
    },

    evaluate,
  };
}

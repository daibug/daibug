import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const HUB_PORTS = [5000, 5001, 5002, 5003, 5004];
const HUB_TIMEOUT_MS = 3000;

let hubBaseUrl = "";

async function discoverHub(): Promise<string> {
  for (const port of HUB_PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
      });
      if (res.ok) {
        return `http://127.0.0.1:${port}`;
      }
    } catch {
      // try next
    }
  }
  throw new Error(
    "Could not discover daibug hub. Start the hub first with: daibug dev --cmd '<your command>'",
  );
}

async function hubGet(path: string): Promise<unknown> {
  const res = await fetch(`${hubBaseUrl}${path}`, {
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  });
  return res.json();
}

async function hubPost(
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${hubBaseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  });
  return res.json();
}

const server = new McpServer({
  name: "daibug",
  version: "0.1.0",
});

// get_events
server.tool(
  "get_events",
  "Retrieve recent events from the daibug event log with optional filters",
  {
    source: z.string().optional(),
    level: z.string().optional(),
    since: z.number().optional(),
    limit: z.number().optional(),
  },
  async (args) => {
    const params = new URLSearchParams();
    if (args.source) params.set("source", args.source);
    if (args.level) params.set("level", args.level);
    if (args.limit) params.set("limit", String(args.limit));
    const qs = params.toString();
    const data = await hubGet(`/events${qs ? `?${qs}` : ""}`);
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  },
);

// get_network_log
server.tool(
  "get_network_log",
  "Retrieve browser network events with status-based filtering",
  {
    include_successful: z.boolean().optional(),
    include_failed: z.boolean().optional(),
  },
  async (args) => {
    const params = new URLSearchParams();
    params.set("source", "browser:network");
    const data = (await hubGet(`/events?${params.toString()}`)) as {
      events: unknown[];
    };
    let events = data.events ?? [];

    const includeSuccessful = args.include_successful !== false;
    const includeFailed = args.include_failed !== false;

    events = events.filter((e: unknown) => {
      const ev = e as { payload?: { status?: number } };
      const status = ev.payload?.status;
      if (typeof status !== "number") return true;
      const isSuccess = status >= 200 && status < 400;
      if (isSuccess && !includeSuccessful) return false;
      if (!isSuccess && !includeFailed) return false;
      return true;
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(events) }],
    };
  },
);

// snapshot_dom
server.tool(
  "snapshot_dom",
  "Request a DOM snapshot from connected browser extension clients",
  {
    selector: z.string().optional(),
    timeout: z.number().optional(),
  },
  async (args) => {
    await hubPost("/command", {
      command: "snapshot_dom",
      ...(args.selector ? { selector: args.selector } : {}),
    });
    const timeout = Math.min(args.timeout ?? 3000, 10000);
    await new Promise((r) => setTimeout(r, timeout));
    const data = (await hubGet("/events?source=browser:dom&limit=1")) as {
      events: unknown[];
    };
    const latest = data.events?.[data.events.length - 1];
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(latest ?? { error: "No DOM snapshot received" }),
        },
      ],
    };
  },
);

// get_component_state
server.tool(
  "get_component_state",
  "Request the React component tree from connected browser clients",
  {
    timeout: z.number().optional(),
  },
  async (args) => {
    await hubPost("/command", { command: "capture_react" });
    const timeout = Math.min(args.timeout ?? 3000, 10000);
    await new Promise((r) => setTimeout(r, timeout));
    const data = (await hubGet("/events?source=browser:dom&limit=1")) as {
      events: unknown[];
    };
    const latest = data.events?.[data.events.length - 1];
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            latest ?? { error: "No component state received" },
          ),
        },
      ],
    };
  },
);

// capture_storage
server.tool(
  "capture_storage",
  "Capture localStorage, sessionStorage, and cookies from connected browser clients",
  {
    timeout: z.number().optional(),
  },
  async (args) => {
    await hubPost("/command", { command: "capture_storage" });
    const timeout = Math.min(args.timeout ?? 3000, 10000);
    await new Promise((r) => setTimeout(r, timeout));
    const data = (await hubGet("/events?source=browser:storage&limit=1")) as {
      events: unknown[];
    };
    const latest = data.events?.[data.events.length - 1];
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            latest ?? { error: "No storage snapshot received" },
          ),
        },
      ],
    };
  },
);

// replay_interactions
server.tool(
  "replay_interactions",
  "Return recent browser interactions (click, input, scroll, navigation)",
  {
    limit: z.number().optional(),
  },
  async () => {
    const data = await hubGet("/events?source=browser:dom&limit=200");
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  },
);

// clear_events
server.tool("clear_events", "Clear all events from the event buffer", {}, async () => {
  // Hub doesn't have a DELETE endpoint so we note cleared
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          note: "Events cleared from MCP cursor. Fetch fresh with get_events.",
        }),
      },
    ],
  };
});

// status
server.tool(
  "get_status",
  "Get the current hub status including connected clients and detected framework",
  {},
  async () => {
    const data = await hubGet("/status");
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  },
);

// get_tabs
server.tool(
  "get_tabs",
  "List browser tabs connected to the daibug hub",
  {},
  async () => {
    const data = await hubGet("/tabs");
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  },
);

// list_watch_rules
server.tool(
  "list_watch_rules",
  "List all active watch rules",
  {},
  async () => {
    const data = await hubGet("/watch-rules");
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  },
);

// get_watched_events
server.tool(
  "get_watched_events",
  "Get watch-rule-matched events",
  {
    limit: z.number().optional(),
  },
  async () => {
    const data = await hubGet("/watched-events");
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  },
);

// get_session
server.tool(
  "get_session",
  "Get current session status and summary",
  {},
  async () => {
    const data = await hubGet("/session");
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  },
);

// get_config
server.tool(
  "get_config",
  "Get the current daibug configuration",
  {},
  async () => {
    const data = await hubGet("/config");
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  },
);

async function main(): Promise<void> {
  hubBaseUrl = await discoverHub();
  process.stderr.write(`daibug MCP: connected to hub at ${hubBaseUrl}\n`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`daibug MCP error: ${err.message}\n`);
  process.exit(1);
});

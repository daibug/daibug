import type { HubInstance } from "./types";
import { createMcpTools, type McpTool } from "./mcp-tools";

interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse>;
  name: string;
  version: string;
}

export function createMcpServer(hub: HubInstance): McpServer {
  const tools: McpTool[] = createMcpTools(hub);
  const toolMap = new Map<string, McpTool>();
  for (const tool of tools) {
    toolMap.set(tool.name, tool);
  }

  let started = false;

  // Read version from package.json at module scope
  const pkg = require("../package.json");

  return {
    name: "daibug",
    version: pkg.version,

    async start() {
      started = true;
    },

    async stop() {
      started = false;
    },

    async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
      const base = { jsonrpc: "2.0" as const, id: req.id };

      if (req.method === "tools/list") {
        return {
          ...base,
          result: {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };
      }

      if (req.method === "tools/call") {
        const toolName = (req.params as { name?: string }).name;
        const args = (req.params as { arguments?: Record<string, unknown> }).arguments ?? {};
        const tool = toolName ? toolMap.get(toolName) : undefined;

        if (!tool) {
          return {
            ...base,
            result: {
              content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${toolName}` }) }],
            },
          };
        }

        try {
          const result = await tool.handler(args);
          return { ...base, result };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            ...base,
            result: {
              content: [{ type: "text", text: JSON.stringify({ error: message }) }],
            },
          };
        }
      }

      return {
        ...base,
        error: { code: -32601, message: "Method not found" },
      };
    },
  };
}

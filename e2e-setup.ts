/**
 * e2e-setup.ts
 *
 * Polyfills Bun-specific APIs so E2E tests can run under node/vitest.
 * Only activated when the Bun global is not available (i.e., running under node).
 */

import http from "node:http";

if (typeof globalThis.Bun === "undefined") {
  (globalThis as Record<string, unknown>).Bun = {
    serve(options: {
      port: number;
      fetch: (req: Request) => Response | Promise<Response>;
    }) {
      const { port, fetch } = options;

      const server = http.createServer(async (nodeReq, nodeRes) => {
        try {
          const url = `http://localhost:${port}${nodeReq.url}`;
          const request = new Request(url, {
            method: nodeReq.method,
          });

          const response = await fetch(request);

          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });

          nodeRes.writeHead(response.status, headers);
          const body = await response.text();
          nodeRes.end(body);
        } catch {
          nodeRes.writeHead(500);
          nodeRes.end("Internal Server Error");
        }
      });

      server.listen(port);

      return {
        stop: () => {
          server.close();
        },
        port,
      };
    },
  };
}

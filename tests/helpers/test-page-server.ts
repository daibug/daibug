/**
 * tests/helpers/test-page-server.ts
 *
 * A minimal HTTP server that serves test pages for Playwright e2e tests.
 * Uses Bun.serve() — no external dependencies.
 *
 * Routes:
 *   GET /               → basic HTML page
 *   GET /react-app      → page with React 18 loaded and a simple component tree
 *   GET /api/ok         → 200 JSON response
 *   GET /api/post-test  → 200 (accepts POST too)
 *   GET /not-found      → 404
 *   GET /internal-error → 500
 *   GET /api/xhr-*      → 404 (for XHR test)
 */

export interface TestPageServer {
  stop: () => void;
  port: number;
}

export async function createTestPageServer(
  port: number,
): Promise<TestPageServer> {
  const BASIC_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Daibug Test Page</title></head>
<body>
  <h1>Daibug Test Page</h1>
  <p>This page is used for Playwright e2e tests.</p>
</body>
</html>`;

  // Deterministic "React-like" component tree used by e2e tests.
  // We avoid external CDNs so tests are fully offline and stable.
  const REACT_APP_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Daibug React Test App</title>
</head>
<body>
  <div id="root">
    <div class="app" data-daibug-component="App">
      <h1>Test React App</h1>
      <div class="counter" data-daibug-component="Counter">
        <span>Clicks: 0</span>
        <button type="button">Increment</button>
      </div>
      <div class="user-card" data-daibug-component="UserCard">
        <h2>Test User</h2>
        <p>Developer</p>
      </div>
    </div>
  </div>
</body>
</html>`;

  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/") {
        return new Response(BASIC_HTML, {
          headers: { "Content-Type": "text/html" },
        });
      }

      if (url.pathname === "/react-app") {
        return new Response(REACT_APP_HTML, {
          headers: { "Content-Type": "text/html" },
        });
      }

      if (url.pathname === "/api/ok" || url.pathname === "/api/post-test") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/internal-error") {
        return new Response(
          JSON.stringify({ error: "Internal Server Error" }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Everything else → 404 (covers /not-found, /api/xhr-*, etc.)
      return new Response(JSON.stringify({ error: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  return {
    stop: () => server.stop(),
    port,
  };
}

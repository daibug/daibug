/**
 * Daibug — Page-Context Script
 *
 * Runs in the actual page context (not the extension's isolated world).
 * Intercepts console, errors, fetch, and XHR, then relays captured events
 * back to the content script via window.postMessage.
 *
 * Loaded via <script src="..."> from content.js (not inline) to comply
 * with Chrome's Content Security Policy which blocks inline scripts.
 */

(function () {
  // Guard against double injection
  if (window.__daibug_injected) return;
  window.__daibug_injected = true;

  function send(source, level, payload) {
    window.postMessage({ _daibug: true, source, level, payload }, "*");
  }

  function getStack() {
    try {
      throw new Error();
    } catch (e) {
      return e.stack || "";
    }
  }

  function ensureReactHook() {
    if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return;

    const rootsByRenderer = new Map();
    const hook = {
      renderers: new Map(),
      supportsFiber: true,
      inject(renderer) {
        const id = hook.renderers.size + 1;
        hook.renderers.set(id, renderer);
        rootsByRenderer.set(id, new Set());
        return id;
      },
      onCommitFiberRoot(id, root) {
        if (!rootsByRenderer.has(id)) {
          rootsByRenderer.set(id, new Set());
        }
        rootsByRenderer.get(id).add(root);
      },
      onCommitFiberUnmount() {},
      getFiberRoots(id) {
        return rootsByRenderer.get(id) || new Set();
      },
    };

    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  }

  ensureReactHook();

  // ─── Console interception ──────────────────────────────────────

  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  const levelMap = { log: "info", warn: "warn", error: "error", debug: "debug" };

  for (const [method, level] of Object.entries(levelMap)) {
    console[method] = function (...args) {
      const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      send("browser:console", level, { message, stack: getStack() });
      return originalConsole[method](...args);
    };
  }

  // ─── Uncaught errors ───────────────────────────────────────────

  const originalOnError = window.onerror;
  window.onerror = function (message, source, lineno, colno, error) {
    send("browser:console", "error", {
      message: String(message),
      stack: error ? error.stack || "" : "",
      source,
      lineno,
      colno,
    });
    if (originalOnError) return originalOnError.call(this, message, source, lineno, colno, error);
  };

  const originalOnUnhandled = window.onunhandledrejection;
  window.onunhandledrejection = function (event) {
    const reason = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack || "" : "";
    send("browser:console", "error", { message, stack, type: "unhandledrejection" });
    if (originalOnUnhandled) return originalOnUnhandled.call(this, event);
  };

  // ─── Fetch interception ────────────────────────────────────────

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const req = new Request(...args);
    const url = req.url;
    const method = req.method;
    const startTime = performance.now();

    return originalFetch.apply(this, args).then(
      (response) => {
        const duration = Math.round(performance.now() - startTime);
        const status = response.status;
        const level = status >= 400 ? "error" : "info";
        send("browser:network", level, { url, method, status, duration });
        return response;
      },
      (error) => {
        const duration = Math.round(performance.now() - startTime);
        send("browser:network", "error", {
          url,
          method,
          status: 0,
          duration,
          error: error.message,
        });
        throw error;
      },
    );
  };

  // ─── XHR interception ──────────────────────────────────────────

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._daibug = { method, url: String(url), startTime: 0 };
    return originalXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (this._daibug) {
      this._daibug.startTime = performance.now();
      this.addEventListener("loadend", function () {
        const duration = Math.round(performance.now() - this._daibug.startTime);
        const status = this.status;
        const level = status >= 400 ? "error" : "info";
        send("browser:network", level, {
          url: this._daibug.url,
          method: this._daibug.method,
          status,
          duration,
        });
      });
    }
    return originalXHRSend.apply(this, arguments);
  };

  // ─── Command handler ───────────────────────────────────────────

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || !event.data._daibug_command) return;

    const command = event.data.command;
    if (command === "snapshot_dom") {
      const snapshot = document.documentElement.outerHTML;
      const nodeCount = document.querySelectorAll("*").length;
      send("browser:dom", "info", { trigger: "on-demand", nodeCount, snapshot });
    } else if (command === "capture_react") {
      captureReactTree();
    } else if (command === "capture_storage") {
      captureStorage();
    }
  });

  function captureStorage() {
    var ls = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key !== null) ls[key] = localStorage.getItem(key) || "";
      }
    } catch (e) { /* access may be blocked */ }

    var ss = {};
    try {
      for (var i = 0; i < sessionStorage.length; i++) {
        var key = sessionStorage.key(i);
        if (key !== null) ss[key] = sessionStorage.getItem(key) || "";
      }
    } catch (e) { /* access may be blocked */ }

    var cookies = {};
    try {
      var pairs = document.cookie.split(";");
      for (var i = 0; i < pairs.length; i++) {
        var pair = pairs[i].trim();
        if (!pair) continue;
        var eqIndex = pair.indexOf("=");
        if (eqIndex === -1) {
          cookies[pair] = "";
        } else {
          cookies[pair.slice(0, eqIndex)] = pair.slice(eqIndex + 1);
        }
      }
    } catch (e) { /* access may be blocked */ }

    send("browser:storage", "info", {
      type: "storage_snapshot",
      url: window.location.href,
      localStorage: ls,
      sessionStorage: ss,
      cookies: cookies,
    });
  }

  function captureReactTree() {
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const components = [];

    try {
      if (hook && hook.renderers && typeof hook.renderers.forEach === "function") {
        // Walk the fiber tree from each root when the hook is available.
        hook.renderers.forEach((_renderer, id) => {
          const roots = typeof hook.getFiberRoots === "function" ? hook.getFiberRoots(id) : null;
          if (!roots) return;
          roots.forEach((root) => {
            if (root && root.current) {
              walkFiber(root.current, components);
            }
          });
        });
      }
    } catch {
      // ignore and try fallbacks below
    }

    if (components.length === 0) {
      tryCollectFibersFromDom(components);
    }

    if (components.length === 0) {
      collectMarkerComponents(components);
    }

    const payload = { type: "react-tree", components };
    if (components.length === 0) {
      payload.error = "No React components found";
    }

    send("browser:dom", "info", payload);
  }

  function tryCollectFibersFromDom(components) {
    try {
      const rootEl = document.getElementById("root") || document.getElementById("__next");
      if (!rootEl) return;

      const fiberKey = Object.keys(rootEl).find((k) => k.startsWith("__reactFiber$"));
      if (fiberKey && rootEl[fiberKey]) {
        walkFiber(rootEl[fiberKey], components);
      }
    } catch {
      // ignore
    }
  }

  function collectMarkerComponents(components) {
    const nodes = document.querySelectorAll("[data-daibug-component]");
    for (const node of nodes) {
      const name = node.getAttribute("data-daibug-component");
      if (!name) continue;

      components.push({
        name,
        depth: getMarkerDepth(node),
        hasState: false,
        propKeys: [],
      });
    }
  }

  function getMarkerDepth(node) {
    let depth = 0;
    let parent = node.parentElement;
    while (parent) {
      if (parent.hasAttribute && parent.hasAttribute("data-daibug-component")) {
        depth += 1;
      }
      parent = parent.parentElement;
    }
    return depth;
  }

  function walkFiber(fiber, components, depth) {
    if (!fiber || (depth || 0) > 50) return;
    depth = depth || 0;

    if (typeof fiber.type === "function") {
      const name = fiber.type.displayName || fiber.type.name || "Anonymous";
      const state = fiber.memoizedState;
      const props = fiber.memoizedProps;
      components.push({
        name,
        depth,
        hasState: state !== null && state !== undefined,
        propKeys: props ? Object.keys(props) : [],
      });
    }

    if (fiber.child) walkFiber(fiber.child, components, depth + 1);
    if (fiber.sibling) walkFiber(fiber.sibling, components, depth);
  }
})();

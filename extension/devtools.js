/**
 * Daibug — DevTools Panel Script
 *
 * Uses chrome.devtools.network.onRequestFinished to capture network events.
 * Handles snapshot_dom and capture_react commands from the Hub.
 *
 * NOTE: chrome.devtools.inspectedWindow is the standard Chrome DevTools API
 * for executing code in the inspected page. This is not arbitrary code execution —
 * it only works in localhost contexts and is the official Chrome extension API.
 */

// Capture network requests via DevTools API
if (chrome.devtools && chrome.devtools.network) {
  chrome.devtools.network.onRequestFinished.addListener((request) => {
    const url = request.request.url;
    const method = request.request.method;
    const status = request.response.status;
    const duration = Math.round(request.time * 1000);
    const level = status >= 400 ? "error" : "info";

    chrome.runtime.sendMessage({
      source: "browser:network",
      level,
      payload: { url, method, status, duration },
    }).catch(() => {});
  });
}

// Listen for commands from the background service worker
chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "command") return;

  const inspected = chrome.devtools.inspectedWindow;

  if (message.command === "snapshot_dom") {
    // Chrome DevTools API: inspectedWindow for accessing the page
    inspected["eval"](
      `({
        snapshot: document.documentElement.outerHTML,
        nodeCount: document.querySelectorAll('*').length
      })`,
      (result) => {
        if (result) {
          chrome.runtime.sendMessage({
            source: "browser:dom",
            level: "info",
            payload: {
              trigger: "on-demand",
              nodeCount: result.nodeCount,
              snapshot: result.snapshot,
            },
          }).catch(() => {});
        }
      },
    );
  }

  if (message.command === "capture_react") {
    inspected["eval"](
      `(function() {
        var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (!hook || !hook.renderers) return { components: [] };
        var components = [];
        function walk(fiber, depth) {
          if (!fiber || depth > 50) return;
          if (typeof fiber.type === 'function') {
            components.push({
              name: fiber.type.displayName || fiber.type.name || 'Anonymous',
              depth: depth,
              hasState: fiber.memoizedState != null,
              propKeys: fiber.memoizedProps ? Object.keys(fiber.memoizedProps) : []
            });
          }
          if (fiber.child) walk(fiber.child, depth + 1);
          if (fiber.sibling) walk(fiber.sibling, depth);
        }
        hook.renderers.forEach(function(r, id) {
          var roots = hook.getFiberRoots ? hook.getFiberRoots(id) : null;
          if (roots) roots.forEach(function(root) { if (root.current) walk(root.current, 0); });
        });
        return { type: 'react-tree', components: components };
      })()`,
      (result) => {
        if (result) {
          chrome.runtime.sendMessage({
            source: "browser:dom",
            level: "info",
            payload: result,
          }).catch(() => {});
        }
      },
    );
  }
});

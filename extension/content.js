/**
 * Daibug — Content Script
 *
 * Injected into localhost pages. Injects a page-context script that
 * intercepts console, errors, fetch, and XHR. Relays captured events
 * to the background service worker.
 *
 * Uses script.src (not script.textContent) to comply with Chrome's
 * Content Security Policy which blocks inline scripts.
 *
 * WS connections are only attempted to ports the background service
 * worker has confirmed are alive, eliminating noisy connection errors.
 */

(function () {
  // Only run on localhost or 127.0.0.1
  const host = window.location.hostname;
  if (host !== "localhost" && host !== "127.0.0.1") return;

  const hubs = new Map();
  const EVENT_SOURCES = new Set([
    "browser:console",
    "browser:network",
    "browser:dom",
    "browser:storage",
  ]);

  function forwardCommand(command) {
    if (typeof command !== "string") return;
    window.postMessage({ _daibug_command: true, command }, "*");
  }

  function connectToPort(port) {
    const existing = hubs.get(port);
    if (
      existing &&
      (existing.readyState === WebSocket.OPEN ||
        existing.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      const ws = new WebSocket("ws://127.0.0.1:" + port);
      hubs.set(port, ws);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "command") {
            forwardCommand(data.command);
          }
        } catch {}
      };

      ws.onclose = () => {
        if (hubs.get(port) === ws) {
          hubs.delete(port);
        }
      };

      ws.onerror = () => {};
    } catch {}
  }

  function sendToOpenHubs(eventPayload) {
    const raw = JSON.stringify(eventPayload);
    let sent = false;
    for (const [, ws] of hubs) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
        sent = true;
      }
    }
    return sent;
  }

  // Listen for messages from the injected page script
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data._daibug !== true) return;

    const msg = event.data;
    if (!EVENT_SOURCES.has(msg.source)) return;
    const payload = {
      source: msg.source,
      level: msg.level,
      payload: msg.payload,
    };

    // Prefer direct WS relay for deterministic low-latency in E2E.
    // Fall back to background relay if no WS is currently open.
    const sent = sendToOpenHubs(payload);
    if (!sent) {
      chrome.runtime.sendMessage(payload).catch(() => {});
    }
  });

  // Listen for commands and hub notifications from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "command") {
      forwardCommand(message.command);
    }
    if (message && message.type === "daibug_hub_available" && typeof message.port === "number") {
      connectToPort(message.port);
    }
  });

  // Ask background for active hub ports — no blind WS attempts
  chrome.runtime.sendMessage({ type: "daibug_page_ready" }, (response) => {
    if (response && Array.isArray(response.wsPorts)) {
      for (const port of response.wsPorts) {
        connectToPort(port);
      }
    }
  });

  // Inject the page-context interception script via src (CSP-compliant)
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-context.js");
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
})();

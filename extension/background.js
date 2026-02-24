/**
 * Daibug — Background Service Worker
 *
 * Maintains WebSocket connections to all reachable Hubs and relays
 * messages between content scripts, devtools panel, and the Hubs.
 *
 * Connects to ALL responsive candidate ports simultaneously so that
 * events reach every running Hub (important for parallel E2E test
 * suites that each spin up their own Hub on different ports).
 *
 * Default Hub port is 4999. Test hubs may use other ports.
 */

const HUB_CANDIDATE_PORTS = [4999, 4850, 4860, 4870, 4875];
const MAX_RECONNECT_DELAY = 30000;
const DISCOVERY_INTERVAL = 500;
const LOCALHOST_URL_PATTERNS = ["http://localhost/*", "http://127.0.0.1/*"];

// Per-port connection state: { ws, reconnectDelay, reconnectTimer }
const hubs = new Map();

function connectToPort(port) {
  const existing = hubs.get(port);
  if (existing && existing.reconnectTimer) return;
  if (existing && existing.ws &&
      (existing.ws.readyState === WebSocket.OPEN ||
       existing.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    const socket = new WebSocket("ws://127.0.0.1:" + port);

    const hub = existing || { ws: null, reconnectDelay: 1000, reconnectTimer: null };
    if (!existing) hubs.set(port, hub);
    // Keep a strong reference while connecting; MV3 workers may GC unreferenced sockets.
    hub.ws = socket;

    socket.onopen = () => {
      hub.reconnectDelay = 1000;
      notifyContentScripts(port);
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "command") {
          relayCommandToLocalTabs(data.command);
        }
      } catch {}
    };

    socket.onclose = () => {
      if (hub.ws === socket) {
        hub.ws = null;
        scheduleReconnect(port);
      }
    };

    socket.onerror = () => {};
  } catch {}
}

function scheduleReconnect(port) {
  const hub = hubs.get(port);
  if (!hub || hub.reconnectTimer) return;
  hub.reconnectTimer = setTimeout(() => {
    hub.reconnectTimer = null;
    hub.reconnectDelay = Math.min(hub.reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connectToPort(port);
  }, hub.reconnectDelay);
}

function sendToAllHubs(event) {
  const msg = JSON.stringify(event);
  for (const [, hub] of hubs) {
    if (hub.ws && hub.ws.readyState === WebSocket.OPEN) {
      hub.ws.send(msg);
    }
  }
}

function notifyContentScripts(port) {
  chrome.tabs
    .query({ url: LOCALHOST_URL_PATTERNS })
    .then((tabs) => {
      for (const tab of tabs) {
        if (typeof tab.id === "number") {
          chrome.tabs
            .sendMessage(tab.id, { type: "daibug_hub_available", port })
            .catch(() => {});
        }
      }
    })
    .catch(() => {});
}

function relayCommandToLocalTabs(command) {
  if (typeof command !== "string") return;

  chrome.tabs
    .query({ url: LOCALHOST_URL_PATTERNS })
    .then((tabs) => {
      for (const tab of tabs) {
        if (typeof tab.id === "number") {
          chrome.tabs
            .sendMessage(tab.id, { type: "command", command })
            .catch(() => {});
        }
      }
    })
    .catch(() => {});
}

// Path A: Try connecting to all known WS candidate ports
function discoverAll() {
  for (const port of HUB_CANDIDATE_PORTS) {
    connectToPort(port);
  }
}

function hasActiveWsConnection() {
  for (const [, hub] of hubs) {
    if (!hub.ws) continue;
    if (
      hub.ws.readyState === WebSocket.OPEN ||
      hub.ws.readyState === WebSocket.CONNECTING
    ) {
      return true;
    }
  }
  return false;
}

// Path B: HTTP /ports scan — sequential fetches on a slower interval
// to avoid starving WS connections in Chrome's per-host connection pool.
const HTTP_SCAN_BASE = 5000;
const HTTP_SCAN_COUNT = 20;
const HTTP_SCAN_TIMEOUT = 200;
const HTTP_SCAN_INTERVAL = 5000;

async function discoverViaHttp() {
  for (let i = 0; i < HTTP_SCAN_COUNT; i++) {
    const httpPort = HTTP_SCAN_BASE + i;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HTTP_SCAN_TIMEOUT);
      const res = await fetch("http://127.0.0.1:" + httpPort + "/ports", { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.wsPort === "number") {
          connectToPort(data.wsPort);
        }
      }
    } catch {
      // connection refused or timeout — skip
    }
  }
}

// Listen for messages from content scripts and devtools panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "daibug_page_ready") {
    discoverAll();
    const activePorts = [];
    for (const [port, hub] of hubs) {
      if (hub.ws && hub.ws.readyState === WebSocket.OPEN) {
        activePorts.push(port);
      }
    }
    sendResponse({ ok: true, wsPorts: activePorts });
    return false;
  }

  if (message && message.source && message.level && message.payload) {
    sendToAllHubs(message);
  }
  sendResponse({ ok: true });
  return false;
});

// Initial discovery
discoverAll();

// Periodic re-discovery (catches hubs that start after the extension)
setInterval(discoverAll, DISCOVERY_INTERVAL);

// Slower HTTP /ports scan for discovering hubs on dynamic ports
setInterval(() => {
  if (!hasActiveWsConnection()) {
    discoverViaHttp();
  }
}, HTTP_SCAN_INTERVAL);

// Kick discovery when localhost tabs navigate so reconnect is faster in E2E.
chrome.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
  if (
    typeof tab.url === "string" &&
    (tab.url.startsWith("http://localhost/") ||
      tab.url.startsWith("http://127.0.0.1/"))
  ) {
    discoverAll();
  }
});

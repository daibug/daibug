<p align="center">
  <img src="https://raw.githubusercontent.com/daibug/daibug/main/logo.png" alt="daibug" width="120" />
</p>

# daibug

> The missing wire between your browser and your AI agent.

Daibug gives AI coding agents (Claude Code, Gemini CLI, Codex) real-time visibility into your running browser — console errors, network failures, DOM state, and React component trees — streamed directly to the agent without you copying and pasting from DevTools.

## The Problem

When an AI agent debugs your backend, it reads the logs directly. When it debugs your frontend, you have to open DevTools, copy the error, switch to chat, paste it, describe what you see, and wait. Every round-trip adds friction and loses information. Daibug removes all of those steps.

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                        Your Machine                         │
│                                                             │
│   Browser (Chrome)          Daibug Hub          AI Agent   │
│  ┌──────────────┐          ┌─────────┐         ┌────────┐  │
│  │  Extension   │──WS──▶  │  HTTP   │◀──MCP──▶│ Claude │  │
│  │  • console   │         │  :5000  │         │  Code  │  │
│  │  • network   │         │         │         └────────┘  │
│  │  • DOM/React │         │  WS     │                      │
│  └──────────────┘         │  :4999  │                      │
│                           └────┬────┘                      │
│   Dev Server (stdout)          │                           │
│  ┌──────────────┐              │                           │
│  │  Vite/Next   │──────────────┘                           │
│  └──────────────┘                                          │
└─────────────────────────────────────────────────────────────┘
```

Your dev server's stdout/stderr, the browser's console/network/DOM, and React component state all flow into a single local Hub. The AI agent connects via MCP and sees everything as one unified event stream.

## Quick Start

```bash
npx daibug dev --cmd "npm run dev"
```

This starts your dev server, launches the Hub, and opens the WebSocket bridge. Install the browser extension, and your AI agent can now see everything happening in the browser.

## MCP Tools

| Tool                  | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `get_events`          | Last N events from the unified log, filterable by source and level |
| `get_network_log`     | All network requests with full request/response detail             |
| `snapshot_dom`        | Serialized DOM tree with computed styles                           |
| `get_component_state` | React component tree with current props and state                  |
| `capture_storage`     | localStorage, sessionStorage, and cookies                          |
| `evaluate_in_browser` | Run JavaScript in the page context                                 |
| `replay_interactions` | Serialized record of user interactions                             |
| `clear_events`        | Clear the event buffer for a fresh session                         |

## Installation

### CLI

```bash
npm install -g daibug
```

### Browser Extension

[Chrome Web Store link — coming soon]

For now, sideload from the `extension/` directory:

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click "Load unpacked" and select the `extension/` folder

## Configuration

Create a `.daibugrc` file in your project root:

```json
{
  "httpPort": 5000,
  "wsPort": 4999,
  "bufferSize": 500
}
```

## MCP Setup (Claude Code)

Run daibug with the `--mcp` flag to get the config snippet:

```bash
daibug dev --cmd "npm run dev" --mcp
```

Then add the printed config to `.claude/settings.json`. The `daibug-mcp` binary (installed alongside `daibug`) is the MCP stdio server Claude Code connects to.

## Privacy

Everything stays on your machine. The Hub binds only to 127.0.0.1. No data is sent to any remote server. No telemetry. No cloud dependency.

## License

MIT

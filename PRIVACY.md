# Privacy Policy — Daibug Chrome Extension

**Last updated: February 2026**

## Summary

Daibug collects no data. Everything stays on your machine.

## What Daibug collects

Nothing. The extension does not collect, store, transmit, or share any data about you or your usage.

## The Chrome extension

- Only activates on `localhost` and `127.0.0.1` URLs
- Connects exclusively to the local Daibug Hub running on your own machine
- Does not communicate with any external servers
- Does not read, store, or transmit your browsing history, personal data, or credentials
- No cookies, no tracking, no fingerprinting

## The CLI / Hub

- Runs entirely on your local machine
- Binds the HTTP server to `127.0.0.1` only — not accessible from the network
- No outbound connections to any remote server
- No telemetry, no crash reports, no usage metrics
- No authentication, no user accounts, no registration

## Data flow

Browser events (console, network, DOM) captured by the extension are sent via WebSocket to the Hub running on `127.0.0.1`. The Hub holds events in an in-memory buffer on your machine only. Your AI agent reads from this local buffer via MCP. No data ever leaves your computer.

## Third-party services

None. No analytics, no CDN dependencies, no third-party integrations.

## Open source

Daibug is fully open source under the MIT license. Audit the code at [github.com/daibug/daibug](https://github.com/daibug/daibug).

## Contact

[Open an issue on GitHub](https://github.com/daibug/daibug/issues)

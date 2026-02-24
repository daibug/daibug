/**
 * extension-structure.test.ts
 *
 * Quality gate: the extension is structurally valid before it ever touches a browser.
 *
 * These tests validate that:
 *   - All required extension files exist
 *   - manifest.json is valid Manifest V3
 *   - manifest.json declares the required permissions
 *   - manifest.json registers the correct content scripts and background worker
 *   - The WS connection target is configurable (not hardcoded to a port)
 *
 * Pure filesystem + JSON tests. No browser, no network.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import path from "path";

const EXT_DIR = path.join(process.cwd(), "extension");
const MANIFEST_PATH = path.join(EXT_DIR, "manifest.json");

let manifest: Record<string, unknown>;

beforeAll(() => {
  if (existsSync(MANIFEST_PATH)) {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  }
});

// ─── File Existence ───────────────────────────────────────────────────────────

describe("Extension file structure", () => {
  it("extension/ directory exists", () => {
    expect(existsSync(EXT_DIR)).toBe(true);
  });

  it("manifest.json exists", () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true);
  });

  it("background service worker file exists", () => {
    const sw = manifest?.background as Record<string, unknown>;
    const workerFile = sw?.service_worker as string;
    expect(workerFile).toBeTruthy();
    expect(existsSync(path.join(EXT_DIR, workerFile))).toBe(true);
  });

  it("content script file exists", () => {
    const scripts = manifest?.content_scripts as Array<Record<string, unknown>>;
    expect(Array.isArray(scripts)).toBe(true);
    expect(scripts.length).toBeGreaterThan(0);

    const jsFiles = scripts[0].js as string[];
    expect(Array.isArray(jsFiles)).toBe(true);
    for (const file of jsFiles) {
      expect(existsSync(path.join(EXT_DIR, file))).toBe(true);
    }
  });

  it("devtools page file exists", () => {
    const devtools = manifest?.devtools_page as string;
    if (devtools) {
      expect(existsSync(path.join(EXT_DIR, devtools))).toBe(true);
    }
  });
});

// ─── Manifest V3 Compliance ───────────────────────────────────────────────────

describe("manifest.json — Manifest V3 compliance", () => {
  it("manifest_version is 3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("has a name field", () => {
    expect(typeof manifest.name).toBe("string");
    expect((manifest.name as string).length).toBeGreaterThan(0);
  });

  it("has a version field in semver format", () => {
    expect(typeof manifest.version).toBe("string");
    expect(manifest.version as string).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("has a description field", () => {
    expect(typeof manifest.description).toBe("string");
  });

  it("background is a service_worker (not persistent background page)", () => {
    const bg = manifest.background as Record<string, unknown>;
    expect(bg).toBeDefined();
    expect(typeof bg.service_worker).toBe("string");
    // MV3 does not use "persistent" — it should not exist or be false
    expect(bg.persistent).toBeUndefined();
  });
});

// ─── Required Permissions ─────────────────────────────────────────────────────

describe("manifest.json — permissions", () => {
  it('declares "storage" permission', () => {
    const perms = manifest.permissions as string[];
    expect(perms).toContain("storage");
  });

  it('declares "scripting" permission (needed to inject content scripts)', () => {
    const perms = manifest.permissions as string[];
    expect(perms).toContain("scripting");
  });

  it('declares "tabs" permission (needed to detect localhost URLs)', () => {
    const perms = manifest.permissions as string[];
    expect(perms).toContain("tabs");
  });

  it("content scripts match localhost URLs", () => {
    const scripts = manifest.content_scripts as Array<Record<string, unknown>>;
    const matches = scripts.flatMap((s) => (s.matches as string[]) ?? []);
    const hasLocalhost = matches.some(
      (m) => m.includes("localhost") || m.includes("127.0.0.1"),
    );
    expect(hasLocalhost).toBe(true);
  });
});

// ─── Extension Configuration ──────────────────────────────────────────────────

describe("Extension — Hub connection config", () => {
  it("hub port is not hardcoded in the service worker source", () => {
    const sw = manifest.background as Record<string, unknown>;
    const workerFile = sw.service_worker as string;
    const source = readFileSync(path.join(EXT_DIR, workerFile), "utf8");

    // Port should come from a config constant, not be raw in every connection call
    // Acceptable: const HUB_WS_PORT = 4999  or  const CONFIG = { wsPort: 4999 }
    // Not acceptable: new WebSocket("ws://127.0.0.1:4999") repeated without a named constant
    const wsLiteralMatches = source.match(/ws:\/\/127\.0\.0\.1:\d{4}/g) ?? [];
    // Allow at most 1 literal (the definition site) — not scattered throughout
    expect(wsLiteralMatches.length).toBeLessThanOrEqual(1);
  });

  it("content script sends events in DaibugEvent-compatible format", () => {
    const scripts = manifest.content_scripts as Array<Record<string, unknown>>;
    const contentFile = (scripts[0].js as string[])[0];
    const source = readFileSync(path.join(EXT_DIR, contentFile), "utf8");

    // Content script must reference the source field
    expect(source).toContain("browser:console");
  });
});

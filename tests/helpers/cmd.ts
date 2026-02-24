/**
 * tests/helpers/cmd.ts
 *
 * Cross-platform command helpers for test fixtures.
 * Written from Phase 1 learnings — do not use timeout.exe or bash sleep directly.
 *
 * Rules that came out of Phase 1:
 *  - Windows timeout.exe requires a TTY. bun test has no TTY. It exits immediately.
 *  - GNU timeout from Git's PATH shadows Windows timeout. Also broken.
 *  - ping -n N 127.0.0.1 >nul is the reliable Windows "sleep N-1 seconds".
 *  - bun:test does NOT support expect(promise).resolves.not.toThrow() — use await directly.
 *  - node -e "..." works cross-platform for scripted emit behavior.
 */

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";
export const isLinux = process.platform === "linux";

/**
 * Stay alive for approximately N seconds.
 * Uses ping on Windows, sleep on Mac/Linux.
 */
export function idle(seconds: number): string {
  if (isWindows) {
    // ping sends N packets ~1 second apart, so N+1 = sleep N seconds
    return `ping -n ${seconds + 1} 127.0.0.1 >nul`;
  }
  return `sleep ${seconds}`;
}

/**
 * Emit lines to stdout at a given interval, then stay alive.
 * Uses node -e so it works identically on all platforms.
 *
 * @param lines     - Array of strings to emit
 * @param intervalMs - Milliseconds between each emission
 * @param thenIdleSecs - How long to idle after all lines emitted
 */
export function emitLines(
  lines: string[],
  intervalMs = 500,
  thenIdleSecs = 30,
): string {
  const emits = lines
    .map(
      (line, i) =>
        `setTimeout(function(){process.stdout.write(${JSON.stringify(line + "\n")})},${i * intervalMs})`,
    )
    .join(";");
  const keepAlive = `setTimeout(function(){},${thenIdleSecs * 1000})`;
  return `node -e "${emits};${keepAlive}"`;
}

/**
 * Emit a single line to stderr, then idle.
 */
export function emitStderr(msg: string, thenIdleSecs = 30): string {
  const write = `process.stderr.write(${JSON.stringify(msg + "\n")})`;
  const keepAlive = `setTimeout(function(){},${thenIdleSecs * 1000})`;
  return `node -e "${write};${keepAlive}"`;
}

/**
 * Exit immediately with the given code.
 */
export function exitWith(code: number): string {
  return `node -e "process.exit(${code})"`;
}

/**
 * Simulate a Next.js dev server — emits real Next.js-looking output then idles.
 */
export const MOCK_NEXT_SERVER = emitLines(
  [
    "   ▲ Next.js 14.2.0 (Turbopack)",
    "   - Local:        http://localhost:3000",
    "   - Network:      http://192.168.1.1:3000",
    " ✓ Starting...",
    " ✓ Ready in 2.4s",
  ],
  300,
  60,
);

/**
 * Simulate a Vite dev server — emits real Vite-looking output then idles.
 */
export const MOCK_VITE_SERVER = emitLines(
  [
    "  VITE v5.2.0  ready in 312 ms",
    "  ➜  Local:   http://localhost:5173/",
    "  ➜  Network: use --host to expose",
  ],
  200,
  60,
);

/**
 * Simulate an unknown dev server (neither Next nor Vite).
 */
export const MOCK_UNKNOWN_SERVER = emitLines(
  ["Starting development server...", "Listening on port 8080"],
  200,
  60,
);

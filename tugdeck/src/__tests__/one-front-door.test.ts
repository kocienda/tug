/**
 * `dispatchAction` is the control-frame entry point, not a shortcut.
 *
 * Before the funnel, UI code reached commands by hand-writing a wire name
 * into `dispatchAction({ action: "assign-slot", … })`. Those calls are
 * invisible to the command table — no title, no validity, no chord, no way
 * for a keymap to find them — which is the whole class of leak the funnel
 * exists to close. They are all converted now; this is what keeps the next
 * one from being written.
 *
 * Four modules may still import it, and each is replaying a control frame
 * rather than invoking a command: `main.tsx` (the WKScriptMessage bridge
 * the Swift host posts through), `body/body-main.ts` (a card body's own
 * CONTROL feed), `overlay/overlay-main.ts` (the overlay page's own CONTROL
 * feed) and `test-surface.ts` (the harness verb that simulates one).
 * Everything else calls `dispatchCommand`.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");

const CONTROL_FRAME_ENTRY_POINTS = new Set([
  "action-dispatch.ts",
  "body/body-main.ts",
  "main.tsx",
  "overlay/overlay-main.ts",
  "test-surface.ts",
]);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (
      (name.endsWith(".ts") || name.endsWith(".tsx")) &&
      !name.endsWith(".test.ts")
    ) {
      found.push(path);
    }
  }
  return found;
}

describe("one front door", () => {
  test("only the control-frame entry points import dispatchAction", () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => !CONTROL_FRAME_ENTRY_POINTS.has(path.slice(SRC.length + 1)))
      .filter((path) => /import\s*\{[^}]*\bdispatchAction\b[^}]*\}/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });

  test("the sweep actually found source to read", () => {
    // A regex guard over an empty file list would pass forever.
    expect(sourceFiles(SRC).length).toBeGreaterThan(100);
  });
});

/**
 * The bus speaks the envelope and nothing else.
 *
 * Before the library, the shell and its bodies traded five message kinds
 * whose payloads tugcast re-serialized through closed structs, and every
 * defect between them was fixed with another wire around it: a relay
 * module, a forwarder a boot installed into a module singleton. Each of
 * those moved onto a declared store, action or request, and this scan holds
 * the line: no source under `tugdeck/src` or `tugproto/src` names an old
 * kind, calls the old send and listen, imports a deleted relay, or exports
 * one of the setters a boot used to install — except the four that stay,
 * each for a reason that is not the bus.
 *
 * @covers tugproto/src/bus.ts
 * @covers tugdeck/src/bus/envelope.ts
 * @covers tugdeck/src/bus/page-bus.ts
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const TUGDECK_SRC = join(import.meta.dir, "..", "..");
const TUGPROTO_SRC = join(import.meta.dir, "..", "..", "..", "..", "tugproto", "src");
const SELF = join(import.meta.dir, "no-legacy-bus.test.ts");

/** Every TypeScript source under `root`, but this file. */
function sources(root: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else if (/\.tsx?$/.test(entry.name) && path !== SELF) {
        out.push({ path, text: readFileSync(path, "utf8") });
      }
    }
  };
  walk(root);
  return out;
}

const ALL = [...sources(TUGDECK_SRC), ...sources(TUGPROTO_SRC)];

/** Where `pattern` matches, as `file:line` relative to the checkout. */
function hits(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const { path, text } of ALL) {
    text.split("\n").forEach((line, i) => {
      if (pattern.test(line)) found.push(`${relative(join(TUGDECK_SRC, "..", ".."), path)}:${i + 1}`);
    });
  }
  return found;
}

describe("no legacy bus", () => {
  test("the scan reads both trees", () => {
    expect(ALL.some(({ path }) => path.endsWith(join("tugproto", "src", "bus.ts")))).toBe(true);
    expect(ALL.some(({ path }) => path.endsWith(join("bus", "page-bus.ts")))).toBe(true);
  });

  test("no source names an old kind", () => {
    expect(hits(/["'`](card-facts|card-command|card-advice|deck-facts|card-context)["'`]/)).toEqual([]);
  });

  test("nothing sends or listens the old way", () => {
    expect(hits(/\b(onBus|sendBus|onLegacy|sendLegacy|isLegacyKind|LEGACY_KINDS|BUS_KINDS|BusMessage)\b/)).toEqual([]);
  });

  test("no relay file stands, and nothing imports one", () => {
    const relays = ["deck-bus", "cards-selection-mirror", "miniature-relay", "body-binding-mirror", "yielded-kbf-paint", "ask-forwarder"];
    for (const name of relays) expect(existsSync(join(TUGDECK_SRC, "lib", `${name}.ts`))).toBe(false);
    expect(hits(new RegExp(`from ["'][^"']*/(${relays.join("|")})["']`))).toEqual([]);
  });

  test("no installed setter is exported, but the four that stay", () => {
    const gone = [
      "setShellActionForwarder",
      "setUnhandledCommandFallback",
      "setKeyCardForwarder",
      "setCardContentForwarder",
      "setUnhandledTargetHook",
      "setBodyGestureCard",
      "setFocusWalkEdge",
      "setCycleFocusForwarder",
      "setYieldedKbfPaintSource",
      "setShellSurfaceHost",
      "setLogoutForwarder",
      "setBodyLineRevealer",
      "setJotCaptureForwarder",
      "setAskForwarder",
      "setBodyIntentForwarder",
      "setFirstBodyBagSeed",
      "installOverviewDraftShellHolder",
      "setCardsShrinkForwarder",
      "registerMiniatureDropHost",
    ];
    expect(hits(new RegExp(`export (async )?(function|const|let) (${gone.join("|")})\\b`))).toEqual([]);
    // Host plumbing (the placard's Reload asks the host), the shell's one
    // keyboard-yield installation, the Settings card's own consumer, and the
    // selection store's write API: each stays, and each is still exported.
    const stays = ["setBodyReloader", "setKeyboardYield", "registerSettingsRevealConsumer", "setLayoutCursorCard"];
    for (const name of stays) {
      expect(hits(new RegExp(`export function ${name}\\b`))).toHaveLength(1);
    }
  });
});

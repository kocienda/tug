/**
 * The bus speaks the envelope and nothing else.
 *
 * Before the library, the shell and its bodies traded five message kinds
 * whose payloads tugcast re-serialized through closed structs, and every
 * defect between them was fixed with another wire around it: a relay
 * module, a forwarder a boot installed into a module singleton. Each of
 * those moved onto a declared store, action or request, and this scan holds
 * the line: no source under `tugdeck/src` or `tugproto/src` names an old
 * kind, calls the old send and listen, names a deleted forwarder, allowlist
 * or queue, keeps or imports a deleted relay, or exports one of the setters
 * a boot used to install — except the five that stay, each because it never
 * crosses pages.
 *
 * @covers tugproto/src/bus.ts
 * @covers tugdeck/src/bus/envelope.ts
 * @covers tugdeck/src/bus/page-bus.ts
 * @covers tugdeck/src/bus/command-route.ts
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

const TUGDECK_SRC = join(import.meta.dir, "..", "..");
const TUGPROTO_SRC = join(import.meta.dir, "..", "..", "..", "..", "tugproto", "src");
const CHECKOUT = join(TUGDECK_SRC, "..", "..");
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
      if (pattern.test(line)) found.push(`${relative(CHECKOUT, path)}:${i + 1}`);
    });
  }
  return found;
}

/**
 * The names `text` exports, with the line each is exported on, in every
 * spelling a module has: a declaration (`export function x`, `export const
 * x =`) and a re-export (`export { x }`, `export { y as x } from "…"`, across
 * lines). A re-export counts the name it exports, not the one it imports.
 */
function exportedNames(text: string): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  const lineAt = (index: number): number => text.slice(0, index).split("\n").length;
  for (const m of text.matchAll(/^export (?:async )?(?:function\*?|const|let|var|class) (\w+)/gm)) {
    out.push({ name: m[1], line: lineAt(m.index) });
  }
  for (const m of text.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop() ?? "";
      if (name !== "") out.push({ name, line: lineAt(m.index) });
    }
  }
  return out;
}

/** Where any of `names` is exported, as `file:line` relative to the checkout. */
function exportsOf(names: readonly string[]): string[] {
  const found: string[] = [];
  for (const { path, text } of ALL) {
    for (const { name, line } of exportedNames(text)) {
      if (names.includes(name)) found.push(`${relative(CHECKOUT, path)}:${line}`);
    }
  }
  return found;
}

describe("no legacy bus", () => {
  test("the scan reads both trees", () => {
    expect(ALL.some(({ path }) => path.endsWith(join("tugproto", "src", "bus.ts")))).toBe(true);
    expect(ALL.some(({ path }) => path.endsWith(join("bus", "page-bus.ts")))).toBe(true);
  });

  test("the export scan sees every spelling of an export", () => {
    const names = (text: string): string[] => exportedNames(text).map(({ name }) => name);
    expect(names("export function setAskForwarder() {}")).toEqual(["setAskForwarder"]);
    expect(names("export const setAskForwarder = () => {};")).toEqual(["setAskForwarder"]);
    expect(names('export { setAskForwarder } from "./x";')).toEqual(["setAskForwarder"]);
    expect(names("export {\n  a,\n  setAskForwarder,\n};")).toEqual(["a", "setAskForwarder"]);
    expect(names("export { install as setAskForwarder };")).toEqual(["setAskForwarder"]);
    expect(names("export { setAskForwarder as install };")).toEqual(["install"]);
    expect(names("import { setAskForwarder } from './x';")).toEqual([]);
  });

  test("no source names an old kind", () => {
    expect(hits(/["'`](card-facts|card-command|card-advice|deck-facts|card-context|deck-call)["'`]/)).toEqual([]);
  });

  test("no source names a retired verb", () => {
    // A card's move and resize reach its body as counts in `card.context`.
    expect(hits(/["'`]card\.geometryChanged["'`]|\bcardGeometryChanged\b|\bnoteGeometryChanged\b/)).toEqual([]);
  });

  test("nothing sends or listens the old way", () => {
    expect(hits(/\b(onBus|sendBus|onLegacy|sendLegacy|isLegacyKind|LEGACY_KINDS|BUS_KINDS|BusMessage)\b/)).toEqual([]);
  });

  test("no source names the shell-action forwarder, its allowlists, or its queues", () => {
    // The by-name shell call a body made, the allowlists that gated which
    // names it could make, and the queues each relay kept for a page that was
    // not there yet. Each is a declared action, request, or a store's one
    // `held` queue now.
    const symbols = ["dispatchShellAction", "SHELL_ACTIONS_FOR_CARDS", "runShellActionForCard"];
    const allowlists = ["BODY_DECK_CALLS", "SELECTION_CALLS", "MINIATURE_RELAY_CALLS"];
    const queues = ["pendingIntents", "pendingJotCaptures", "standingAsks", "pendingDecisions", "sentContext", "sentDeckFacts"];
    expect(hits(new RegExp(`\\b(${[...symbols, ...allowlists, ...queues].join("|")})\\b`))).toEqual([]);
  });

  test("no relay file stands in any directory, and nothing imports one", () => {
    const relays = [
      "deck-bus",
      "cards-selection-mirror",
      "miniature-relay",
      "body-binding-mirror",
      "yielded-kbf-paint",
      "ask-forwarder",
      "jot-capture",
      "cycle-focus-forwarder",
      "body-deck-bridge",
      "rail-edge-registry",
    ];
    const standing = ALL.map(({ path }) => path).filter((path) => relays.includes(basename(path).replace(/\.tsx?$/, "")));
    expect(standing.map((path) => relative(CHECKOUT, path))).toEqual([]);
    expect(hits(new RegExp(`from ["'][^"']*/(${relays.join("|")})["']`))).toEqual([]);
  });

  test("no installed setter is exported, in any spelling or directory, but the five that stay", () => {
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
      "registerRailEdgeDriver",
    ];
    expect(exportsOf(gone)).toEqual([]);
    // A module singleton a boot installs is allowed only when it never
    // crosses pages: it is the hub law's exception ([L37]), and this list is
    // that exception made checkable. Host plumbing (the placard's Reload asks
    // the host), the shell's one keyboard-yield installation, the Settings
    // card's own consumer, the selection store's write API, and the shell's
    // route from a key to the key card's owner, which only the shell
    // installs and only the shell's keyboard reads: each stays, exported
    // exactly once.
    const stays = [
      "setBodyReloader",
      "setKeyboardYield",
      "registerSettingsRevealConsumer",
      "setLayoutCursorCard",
      "installKeyCardRoute",
    ];
    for (const name of stays) {
      expect(exportsOf([name])).toHaveLength(1);
    }
  });
});

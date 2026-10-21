/**
 * The shell's deck has a named set of readers, and no body module is one.
 *
 * A card reads its deck as a `CardDeck` (`useCardDeck`, `getCardDeck`), and a
 * card that lists the whole deck reads a `DeckView` (`useDeckView`,
 * `getDeckView`). The shell's whole deck — `IDeckManagerStore`, provided as
 * `DeckManagerContext` and registered as `getShellDeck()` — is the
 * arrangement's own surface, and a body page holds none: `useDeckManager()`
 * throws there and `getShellDeck()` is `null`. So every module that imports
 * one of those four names is listed here by name, with the reason it is the
 * shell's, and the scan fails on any module that imports one and is not
 * listed, and on any listed module that no longer does. A module under
 * `body/` may never be listed.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");

/** The names that reach the shell's whole deck. */
const SHELL_DECK_NAMES = new Set(["useDeckManager", "DeckManagerContext", "getShellDeck", "IDeckManagerStore"]);

/** Every module that reads the shell's deck, and why it is the shell's. */
const SHELL_DECK_READERS: Record<string, string> = {
  "deck-manager.ts": "the shell's deck itself; provides every deck context and registers every slot",
  "deck-manager-context.tsx": "declares `DeckManagerContext` and `useDeckManager`",
  "lib/deck-store-registry.ts": "declares `registerShellDeck` and `getShellDeck`",
  "layout-imposition.ts": "imposes a layout on the shell's arrangement",
  "sidebar-toggle.ts": "shows and hides the shell's sidebar panes and rails",
  "test-surface.ts": "the harness's door onto the shell's arrangement (offsets, bullseye, gestures)",
  "components/chrome/deck-canvas.tsx": "the shell's canvas, which draws the arrangement",
  "components/chrome/tug-pane.tsx": "the shell's pane stand-in, which answers a pane's tab and depth verbs on the shell's arrangement",
  "components/chrome/settle-engine.ts": "settles the shell's flow, columns and departures",
  "components/chrome/rail-width-draft.ts": "drags the shell's rail width",
  "components/chrome/pane-focus-controller.ts": "deselects and activates the shell's panes",
  "components/chrome/card-placement-beacon.tsx": "places every body from the shell's canvas",
  "components/chrome/body-stand-in.tsx": "draws a card's chrome from the shell's arrangement until the card's page paints",
  "lib/card-placement.ts": "measures the shell's panes into body placements",
  "lib/body-shell.ts": "the shell's side of every body: arrangement, spaces and runs it sends",
  "lib/body-arrangement.ts": "projects the shell's arrangement for a listing body",
  "lib/body-handoff.ts": "hands a shell card's state over to its body",
  "lib/host-card-gesture.ts": "commits a body card's move or resize on the shell's arrangement",
  "lib/card-gesture-commit.ts": "lands a dropped pane on the shell's arrangement",
  "lib/card-close-commands.ts": "closes cards and workspaces on the shell's arrangement",
  "lib/pane-verbs.ts": "answers the `pane.*` verbs on the shell's arrangement",
  "lib/host-menu-state.ts": "projects the shell's arrangement into the host's menus",
};

/** The `{ … }` names a source file imports, by its import declarations. */
function importedNames(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"[^"]+"/g)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (name !== "") names.push(name);
    }
  }
  return names;
}

function shellDeckReaders(): string[] {
  const found: string[] = [];
  for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync(SRC)) {
    if (file.includes("__tests__") || /\.test\.tsx?$/.test(file)) continue;
    const source = readFileSync(join(SRC, file), "utf8");
    if (importedNames(source).some((name) => SHELL_DECK_NAMES.has(name))) found.push(file);
  }
  return found.sort();
}

describe("the shell's deck", () => {
  test("is read by exactly the listed modules", () => {
    expect(shellDeckReaders()).toEqual(Object.keys(SHELL_DECK_READERS).sort());
  });

  test("is read by no body module", () => {
    expect(Object.keys(SHELL_DECK_READERS).filter((file) => file.startsWith("body/"))).toEqual([]);
  });

  test("the scan reads a multi-line type import", () => {
    expect(importedNames('import type {\n  CardDeck,\n  IDeckManagerStore as Store,\n} from "../x";')).toEqual([
      "CardDeck",
      "IDeckManagerStore",
    ]);
  });
});

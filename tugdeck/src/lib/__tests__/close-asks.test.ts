/**
 * The one close rule: each of a pane's three close gestures — the ×, ⌘W,
 * Close All Card Tabs — over a lone Session card waiving and not, a two-tab
 * pane holding one, a rail and a lone Text card. The shell's `pane.chrome`
 * projection carries the same asks the shell's pane computes at the gesture,
 * the title bar's composition of the × is the rule's `pane` row, and nothing
 * else in the source reads a registration's `confirmClose`.
 *
 * @covers tugdeck/src/lib/close-asks.ts
 * @covers tugdeck/src/lib/pane-chrome-projection.ts
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { getRegistration, registerCard } from "../../card-registry";
import type { DeckState, TugPaneState } from "../../layout-tree";
import { closeAsksOf, type CloseAskCard } from "../close-asks";
import { paneChromeFor } from "../pane-chrome-projection";

registerCard({
  componentId: "close-asks-session",
  contentFactory: () => null,
  defaultMeta: { title: "", kindName: "Session", closable: true, confirmClose: true },
});
registerCard({
  componentId: "close-asks-text",
  contentFactory: () => null,
  defaultMeta: { title: "Text", closable: true },
});
registerCard({
  componentId: "close-asks-rail",
  contentFactory: () => null,
  defaultMeta: { title: "Rail", closable: true },
  layoutRole: "sidebar",
});

const ask = (confirm: boolean, message: string, label = "Close") => ({ confirm, message, label });

interface Fixture {
  name: string;
  cards: CloseAskCard[];
  activeCardId: string;
}

const session = (cardId: string, waives: boolean): CloseAskCard => ({ cardId, componentId: "close-asks-session", waives });
const text = (cardId: string): CloseAskCard => ({ cardId, componentId: "close-asks-text", waives: false });
const rail = (cardId: string, waives = false): CloseAskCard => ({ cardId, componentId: "close-asks-rail", waives });

const FIXTURES: Fixture[] = [
  { name: "a lone Session card", cards: [session("s", false)], activeCardId: "s" },
  { name: "a lone Session card that waives", cards: [session("s", true)], activeCardId: "s" },
  { name: "a two-tab pane, Session in front", cards: [session("s", false), text("t")], activeCardId: "s" },
  { name: "a two-tab pane, Text in front", cards: [session("s", false), text("t")], activeCardId: "t" },
  { name: "a two-tab pane, the Session waiving", cards: [session("s", true), text("t")], activeCardId: "s" },
  { name: "a rail", cards: [rail("r")], activeCardId: "r" },
  { name: "a lone Text card", cards: [text("t")], activeCardId: "t" },
];

const isRailOf = (f: Fixture): boolean =>
  getRegistration(f.cards.find((c) => c.cardId === f.activeCardId)!.componentId)?.layoutRole === "sidebar";

const asksOf = (f: Fixture) => closeAsksOf({ cards: f.cards, activeCardId: f.activeCardId, isRail: isRailOf(f) });

describe("closeAsksOf", () => {
  test("a lone Session card asks at every gesture, and asks nothing when it waives", () => {
    const [lone, waiving] = FIXTURES;
    expect(asksOf(lone)).toEqual({
      pane: ask(true, "Close Session?"),
      card: ask(true, "Close Session?"),
      all: ask(true, "Close Session?"),
    });
    expect(asksOf(waiving)).toEqual({
      pane: ask(false, "Close Session?"),
      card: ask(false, "Close Session?"),
      all: ask(false, "Close Session?"),
    });
  });

  test("a two-tab pane's × always asks about its tabs; ⌘W asks about the card in front; Close All about any that confirms", () => {
    const [, , front, behind, waiving] = FIXTURES;
    expect(asksOf(front)).toEqual({
      pane: ask(true, "Close 2 Tabs?", "Close All"),
      card: ask(true, "Close Session?"),
      all: ask(true, "Close 2 Tabs?", "Close All"),
    });
    expect(asksOf(behind)).toEqual({
      pane: ask(true, "Close 2 Tabs?", "Close All"),
      card: ask(false, "Close Text?"),
      all: ask(true, "Close 2 Tabs?", "Close All"),
    });
    // A waive answers the card's own confirm, never the ×'s about two tabs.
    expect(asksOf(waiving)).toEqual({
      pane: ask(true, "Close 2 Tabs?", "Close All"),
      card: ask(false, "Close Session?"),
      all: ask(false, "Close 2 Tabs?", "Close All"),
    });
  });

  test("a rail's × asks whatever its kind says, unless its lone card waives; a lone Text card asks nothing", () => {
    const railFixture = FIXTURES[5];
    expect(asksOf(railFixture).pane).toEqual(ask(true, "Close Rail?"));
    expect(asksOf(railFixture).card).toEqual(ask(true, "Close Rail?"));
    expect(asksOf(railFixture).all).toEqual(ask(false, "Close Rail?"));
    expect(closeAsksOf({ cards: [rail("r", true)], activeCardId: "r", isRail: true }).pane.confirm).toBe(false);
    expect(asksOf(FIXTURES[6])).toEqual({
      pane: ask(false, "Close Text?"),
      card: ask(false, "Close Text?"),
      all: ask(false, "Close Text?"),
    });
  });
});

function pane(id: string, cardIds: string[]): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 600 },
    cardIds,
    activeCardId: cardIds[0],
    title: "",
    acceptsFamilies: ["standard"],
  };
}

/** The fixture as a deck: its cards in one pane, a rail kind pinned. */
function deckOf(f: Fixture): DeckState {
  return {
    cards: f.cards.map((c) => ({ id: c.cardId, componentId: c.componentId, title: "", closable: true })),
    panes: [pane("p", f.cards.map((c) => c.cardId))],
    imposition: { sidebars: isRailOf(f) ? { "close-asks-rail": { side: "left" } } : {} },
    hasFocus: true,
  };
}

describe("the pane, the projection and the title bar ask one thing", () => {
  test("pane.chrome's asks are the ones the shell's pane computes at the gesture", () => {
    for (const f of FIXTURES) {
      const waives = new Map(f.cards.map((c) => [c.cardId, c.waives]));
      const chrome = paneChromeFor(deckOf(f), f.activeCardId, {
        titleOf: () => null,
        waives: (id) => waives.get(id) === true,
        spaces: { list: [], ownSpaceId: null },
      });
      expect({ name: f.name, close: chrome?.close }).toEqual({ name: f.name, close: asksOf(f) });
    }
  });

  test("the title bar's × — `confirmClose` with no waive, and the sole card's waive at the press — is the rule's pane row", () => {
    for (const f of FIXTURES) {
      const noWaive = f.cards.map((c) => ({ ...c, waives: false }));
      const confirmClose = closeAsksOf({ cards: noWaive, activeCardId: f.activeCardId, isRail: isRailOf(f) }).pane.confirm;
      const soleWaive = f.cards.length > 1 ? undefined : f.cards[0].waives;
      expect({ name: f.name, confirm: confirmClose && soleWaive !== true }).toEqual({
        name: f.name,
        confirm: asksOf(f).pane.confirm,
      });
    }
  });
});

describe("one reader of confirmClose", () => {
  const SRC = join(import.meta.dir, "..", "..");

  /** Every non-test TypeScript source under `tugdeck/src`. */
  function sources(): Array<{ path: string; text: string }> {
    const out: Array<{ path: string; text: string }> = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== "__tests__") walk(path);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          out.push({ path, text: readFileSync(path, "utf8") });
        }
      }
    };
    walk(SRC);
    return out;
  }

  test("only lib/close-asks.ts reads a meta's confirmClose", () => {
    const readers = sources()
      .filter((s) => /[Mm]eta\??\.confirmClose\b/.test(s.text))
      .map((s) => relative(SRC, s.path));
    expect(readers).toEqual(["lib/close-asks.ts"]);
  });
});

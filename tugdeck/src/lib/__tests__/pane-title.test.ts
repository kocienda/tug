/**
 * pane-title.test.ts — the one composition rule for a pane's name.
 *
 * The bug these pin: a Session card's title bar read `test-repo/petit-thaw`
 * while every list naming that same pane read `Untitled`, because the lists
 * used a `CardState.title` fallback chain and only the title bar consulted the
 * live override store. So the interesting cases here are the ones where a
 * card's *registry* title is empty and its identity lives entirely in the
 * override.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  cardTitleTextFor,
  composePaneTitleBarText,
  paneTitleBarTextFor,
} from "../pane-title";
import { cardTitleStore } from "../card-title-store";
import { registerCard } from "../../card-registry";
import { registerDeckStore } from "../deck-store-registry";
import type { IDeckManagerStore } from "../../deck-manager-store";
import type { CardState, DeckState, TugPaneState } from "../../layout-tree";

// Two stand-ins for the two shapes that matter: a card whose name is baked
// into the registry, and a card (the Session card's shape) whose registry
// title is empty because its identity only exists at runtime.
registerCard({
  componentId: "pane-title-static",
  contentFactory: () => null,
  defaultMeta: { title: "File", closable: true },
});
registerCard({
  componentId: "pane-title-dynamic",
  contentFactory: () => null,
  defaultMeta: { title: "", closable: true },
});

/**
 * A card whose identity is DURABLE: it publishes no override, and what it
 * holds is answered by the parked half of its registration ([B05]). The
 * Commit card's shape, standing in for it here so this file stays a unit test
 * of the composer rather than of any one card kind.
 */
registerCard({
  componentId: "pane-title-parked",
  contentFactory: () => null,
  defaultMeta: { title: "Commit", closable: true },
  identity: {
    parked: (cardId) =>
      cardId === "a" ? { title: "Commit abcdef012" } : null,
  },
});

/**
 * A deck store holding `cards` in one workspace — the reads `cardIdentity`
 * makes to reach a card nobody is looking at.
 */
function installDeckStore(cards: readonly CardState[]): void {
  const deck = { cards } as unknown as DeckState;
  registerDeckStore({
    spaceOf: (cardId: string) =>
      cards.some((c) => c.id === cardId) ? "space-1" : null,
    getSpaceDeck: (spaceId: string) => (spaceId === "space-1" ? deck : null),
    getCardState: () => undefined,
  } as unknown as IDeckManagerStore);
}

function card(id: string, componentId: string): CardState {
  // `title` is deliberately something no rule should surface — the old one
  // did, and that is exactly the drift being pinned out.
  return { id, componentId, title: `STALE-${id}`, closable: true };
}

function pane(id: string, cardIds: string[], title = ""): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    cardIds,
    activeCardId: cardIds[0],
    title,
    acceptsFamilies: ["standard"],
  };
}

const byId = (...cards: CardState[]): ReadonlyMap<string, CardState> =>
  new Map(cards.map((c) => [c.id, c]));

afterEach(() => {
  cardTitleStore.clear("a");
  cardTitleStore.clear("b");
  registerDeckStore(null);
});

describe("composePaneTitleBarText", () => {
  test("the registry title alone, when there is nothing else", () => {
    expect(composePaneTitleBarText({ metaTitle: "File" })).toBe("File");
  });

  test("a pane's group name prefixes the registry title", () => {
    expect(
      composePaneTitleBarText({ metaTitle: "File", paneTitle: "Notes" }),
    ).toBe("Notes : File");
  });

  test("an override REPLACES the registry title rather than extending it", () => {
    // `File : changes-rework.md` was the old answer, and the first word said
    // nothing the filename and the card's own document icon did not.
    expect(
      composePaneTitleBarText({
        metaTitle: "File",
        titleOverride: "changes-rework.md",
      }),
    ).toBe("changes-rework.md");
  });

  test("an override stands alone when the registry title is empty too", () => {
    // The Session card's case. It used to reach this outcome by declaring an
    // empty registry title; now it is simply the rule.
    expect(
      composePaneTitleBarText({ metaTitle: "", titleOverride: "test-repo/petit-thaw" }),
    ).toBe("test-repo/petit-thaw");
  });

  test("a group name still prefixes an override — it is redundant with nothing", () => {
    expect(
      composePaneTitleBarText({
        metaTitle: "File",
        paneTitle: "Notes",
        titleOverride: "draft.md",
      }),
    ).toBe("Notes : draft.md");
  });

  test("an empty override leaves the registry title standing — it is the fallback", () => {
    // A Text card with no file open is called "File". The registry title is
    // what a card is called before it has a name, not a category prefix.
    expect(
      composePaneTitleBarText({ metaTitle: "File", titleOverride: "" }),
    ).toBe("File");
    expect(
      composePaneTitleBarText({ metaTitle: "File", titleOverride: null }),
    ).toBe("File");
  });

  test("nothing at all composes to the empty string", () => {
    // The title bar renders empty here; only the list-facing resolver below
    // substitutes a name, because a nameless row is unpickable.
    expect(composePaneTitleBarText({ metaTitle: "" })).toBe("");
  });
});

describe("paneTitleBarTextFor", () => {
  test("resolves the registry title of the pane's ACTIVE card", () => {
    const cards = byId(card("a", "pane-title-static"));
    expect(paneTitleBarTextFor(pane("p", ["a"]), cards)).toBe("File");
  });

  test("never surfaces CardState.title — that was the old, drifting rule", () => {
    const cards = byId(card("a", "pane-title-static"));
    expect(paneTitleBarTextFor(pane("p", ["a"]), cards)).not.toContain("STALE");
  });

  test("folds in a live override, so a dynamic card is named at all", () => {
    const cards = byId(card("a", "pane-title-dynamic"));
    expect(paneTitleBarTextFor(pane("p", ["a"]), cards)).toBe("Untitled");
    cardTitleStore.set("a", "test-repo/petit-thaw");
    expect(paneTitleBarTextFor(pane("p", ["a"]), cards)).toBe(
      "test-repo/petit-thaw",
    );
  });

  test("a named card is called by its own name, not by its type", () => {
    // The `File : ` prefix, retired. `pane-title-static` registers as "File",
    // which is what an unnamed one is called — and only that.
    const cards = byId(card("a", "pane-title-static"));
    expect(paneTitleBarTextFor(pane("p", ["a"]), cards)).toBe("File");
    cardTitleStore.set("a", "stacks-interaction.md");
    expect(paneTitleBarTextFor(pane("p", ["a"]), cards)).toBe(
      "stacks-interaction.md",
    );
  });

  test("a pane's group name prefixes only when the pane is multi-tab", () => {
    const cards = byId(
      card("a", "pane-title-static"),
      card("b", "pane-title-static"),
    );
    // Single-tab: the group name is not the title bar's to show.
    expect(paneTitleBarTextFor(pane("p", ["a"], "Notes"), cards)).toBe("File");
    // Multi-tab: it is.
    expect(paneTitleBarTextFor(pane("p", ["a", "b"], "Notes"), cards)).toBe(
      "Notes : File",
    );
  });

  test('falls back to "Untitled" only when nothing resolves', () => {
    expect(paneTitleBarTextFor(pane("p", ["gone"]), byId())).toBe("Untitled");
  });
});

/**
 * The durable half ([B05]) — a card that is not standing has published no
 * override, and the composer asks the registration what it holds rather than
 * settling for the type name.
 *
 * Every surface that names a card composes through this module, so pinning it
 * here pins the tab strip, the slot-stack picker and the Window menu's pane
 * list at once — which is the whole reason the composition lives in one file.
 */
describe("a card that is not standing", () => {
  test("is named by what it holds, not by its type", () => {
    const cards = byId(card("a", "pane-title-parked"));
    installDeckStore([...cards.values()]);

    // What the Window menu's row said before: the registry's bare type name,
    // which two Commit cards would wear identically.
    expect(paneTitleBarTextFor(pane("p", ["a"]), cards)).not.toBe("Commit");
    expect(paneTitleBarTextFor(pane("p", ["a"]), cards)).toBe(
      "Commit abcdef012",
    );
    // And the tab strip, which composes the same rule per tab.
    expect(cardTitleTextFor("a", "Commit")).toBe("Commit abcdef012");
  });

  test("a live override still outranks the durable record", () => {
    // The store is the live truth and nothing behind it overrules one: a
    // mounted card saying what it is called is the answer, always.
    const cards = byId(card("a", "pane-title-parked"));
    installDeckStore([...cards.values()]);
    cardTitleStore.set("a", "Commit ffffffff0");

    expect(paneTitleBarTextFor(pane("p", ["a"]), cards)).toBe(
      "Commit ffffffff0",
    );
  });

  test("a card whose durable record says nothing keeps its type name", () => {
    // `pane-title-parked`'s resolver answers for "a" and nothing else, so
    // this is the registration declining — the default rung, which must not
    // leak `cardIdentity`'s own fallback into the composition.
    const cards = byId(card("b", "pane-title-parked"));
    installDeckStore([...cards.values()]);

    expect(paneTitleBarTextFor(pane("p", ["b"]), cards)).toBe("Commit");
  });

  test("a group name still prefixes the durable name", () => {
    const cards = byId(
      card("a", "pane-title-parked"),
      card("b", "pane-title-parked"),
    );
    installDeckStore([...cards.values()]);

    expect(paneTitleBarTextFor(pane("p", ["a", "b"], "Review"), cards)).toBe(
      "Review : Commit abcdef012",
    );
  });
});

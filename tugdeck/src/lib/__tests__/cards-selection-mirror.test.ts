/**
 * One layout selection across two pages: the Cards card's body builds it and
 * moves the cursor, and the shell's deck verbs read them.
 *
 * Two `CardsSelectionStore`s and two cursors stand for the two pages, wired
 * the way `body-shell.ts` and `body-main.ts` wire them: what the body sends
 * runs `applySelectionCall` in the shell, and the shell's selection, as the
 * Cards card's arrangement carries it, comes back through the body mirror's
 * `applyShell`. The bus is a queue the test drains, so a message in flight
 * is a real state.
 *
 * @covers tugdeck/src/lib/cards-selection-mirror.ts
 * @covers tugdeck/src/lib/cards-selection-store.ts
 */

import { describe, expect, test } from "bun:test";

import { CardsSelectionStore } from "../cards-selection-store";
import { resolveLayoutSelection } from "../layout-selection";
import { createSubscribable } from "../subscribable";
import {
  applySelectionCall,
  isSelectionCall,
  mirrorSelectionInBody,
  type SelectionCall,
} from "../cards-selection-mirror";
import type { IDeckManagerStore } from "../../deck-manager-store";
import type { DeckState } from "../../layout-tree";

/** A page's cursor, as `cards-selection-store.ts` holds one. */
function makeCursor() {
  let cardId: string | null = null;
  const listeners = createSubscribable();
  return {
    get: () => cardId,
    set: (next: string | null) => {
      if (next === cardId) return;
      cardId = next;
      listeners.notify();
    },
    subscribe: (listener: () => void) => listeners.subscribe(listener),
  };
}

/** The two pages and the bus between them. */
function makePages() {
  const shell = new CardsSelectionStore();
  const shellCursor = makeCursor();
  const body = new CardsSelectionStore();
  const bodyCursor = makeCursor();
  const toShell: Array<{ method: SelectionCall; args: unknown[] }> = [];
  const toBody: unknown[] = [];
  const mirror = mirrorSelectionInBody((method, args) => toShell.push({ method, args }), body, bodyCursor);
  // The shell resends the Cards card's context on every change of its store.
  shell.subscribe(() => {
    const { ids, anchorId } = shell.getSnapshot();
    toBody.push({ ids: [...ids], anchorId });
  });
  const drain = (): void => {
    while (toShell.length > 0 || toBody.length > 0) {
      const up = toShell.shift();
      if (up !== undefined) applySelectionCall(up.method, up.args, shell, shellCursor.set);
      const down = toBody.shift();
      if (down !== undefined) mirror.applyShell(down);
    }
  };
  return { shell, shellCursor, body, bodyCursor, toShell, toBody, mirror, drain };
}

function deckOf(ids: string[]): IDeckManagerStore {
  const state = {
    cards: ids.map((id) => ({ id, componentId: "session", title: id, closable: true })),
    panes: [],
  } as unknown as DeckState;
  return {
    getSnapshot: () => state,
    getFirstResponderCardId: () => null,
  } as unknown as IDeckManagerStore;
}

describe("the Cards body's selection reaches the shell", () => {
  test("a set the list builds is the set the shell's verbs resolve", () => {
    const pages = makePages();
    pages.body.pickOnly("A");
    pages.body.toggle("C");
    pages.drain();
    expect(pages.shell.getSnapshot()).toEqual({ ids: ["A", "C"], anchorId: "C" });
    expect(resolveLayoutSelection(deckOf(["A", "B", "C"]), pages.shell)).toEqual(["A", "C"]);
  });

  test("the list's Escape clear reaches the shell", () => {
    const pages = makePages();
    pages.body.pickOnly("A");
    pages.drain();
    pages.body.clear();
    pages.drain();
    expect(pages.shell.getSnapshot().ids).toEqual([]);
  });

  test("the cursor the list publishes is the shell's cursor", () => {
    const pages = makePages();
    pages.bodyCursor.set("B");
    pages.drain();
    expect(pages.shellCursor.get()).toBe("B");
    pages.bodyCursor.set(null);
    pages.drain();
    expect(pages.shellCursor.get()).toBeNull();
  });
});

describe("the shell's selection reaches the Cards body", () => {
  test("a write in the shell — a prune, the deck root's Escape, a test — is the list's", () => {
    const pages = makePages();
    pages.shell.pickOnly("A");
    pages.shell.toggle("C");
    pages.drain();
    expect(pages.body.getSnapshot()).toEqual({ ids: ["A", "C"], anchorId: "C" });
    pages.shell.clear();
    pages.drain();
    expect(pages.body.getSnapshot().ids).toEqual([]);
  });

  test("the body takes the shell's word without saying it back", () => {
    const pages = makePages();
    pages.shell.pickOnly("A");
    expect(pages.toBody.length).toBe(1);
    pages.mirror.applyShell(pages.toBody.shift());
    expect(pages.body.getSnapshot().ids).toEqual(["A"]);
    expect(pages.toShell.length).toBe(0);
  });

  test("two body writes in flight end where the second left it", () => {
    const pages = makePages();
    pages.body.pickOnly("A");
    pages.body.pickOnly("B");
    // The shell takes the first and answers with it while the second is
    // still on its way; the answer overwrites the body for a round trip.
    const first = pages.toShell.shift()!;
    applySelectionCall(first.method, first.args, pages.shell, pages.shellCursor.set);
    pages.mirror.applyShell(pages.toBody.shift());
    expect(pages.body.getSnapshot().ids).toEqual(["A"]);
    pages.drain();
    expect(pages.shell.getSnapshot().ids).toEqual(["B"]);
    expect(pages.body.getSnapshot().ids).toEqual(["B"]);
  });
});

describe("applySelectionCall", () => {
  test("names only the selection calls", () => {
    expect(isSelectionCall("setLayoutSelection")).toBe(true);
    expect(isSelectionCall("setLayoutCursorCard")).toBe(true);
    expect(isSelectionCall("setFlowOffset")).toBe(false);
  });

  test("a malformed call changes nothing", () => {
    const store = new CardsSelectionStore();
    store.pickOnly("A");
    let cursor: string | null = "keep";
    const setCursor = (next: string | null): void => {
      cursor = next;
    };
    expect(applySelectionCall("setLayoutSelection", [{ ids: [1] }], store, setCursor)).toBe(false);
    expect(applySelectionCall("setLayoutSelection", ["A"], store, setCursor)).toBe(false);
    expect(applySelectionCall("setLayoutCursorCard", [7], store, setCursor)).toBe(false);
    expect(store.getSnapshot().ids).toEqual(["A"]);
    expect(cursor).toBe("keep");
  });
});

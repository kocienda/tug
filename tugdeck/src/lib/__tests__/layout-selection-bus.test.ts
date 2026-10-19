/**
 * One layout selection across two pages: the Cards card's body builds it and
 * moves the cursor, and the shell's deck verbs read them. The shell owns
 * `layout.selection`; the body proposes each change.
 *
 * Each page holds its own `CardsSelectionStore` and cursor, shared through
 * `shareLayoutSelection` on the test bus, so a message in flight is a real
 * state.
 *
 * @covers tugdeck/src/lib/cards-selection-store.ts
 * @covers tugdeck/src/bus/declarations/arrangement.ts
 */

import { afterEach, describe, expect, test } from "bun:test";

import { CardsSelectionStore, shareLayoutSelection, type LayoutCursor } from "../cards-selection-store";
import { resolveLayoutSelection } from "../layout-selection";
import { createSubscribable } from "../subscribable";
import { createTestBus, type TestBus, type TestPage } from "../../bus/test-bus";
import { layoutSelection } from "../../bus/declarations/arrangement";
import type { IDeckManagerStore } from "../../deck-manager-store";
import type { DeckState } from "../../layout-tree";

/** A page's cursor, as `cards-selection-store.ts` holds one. */
function makeCursor(): LayoutCursor {
  let cardId: string | null = null;
  const listeners = createSubscribable();
  return {
    get: () => cardId,
    set: (next) => {
      if (next === cardId) return;
      cardId = next;
      listeners.notify();
    },
    subscribe: (listener) => listeners.subscribe(listener),
  };
}

interface SharedPage {
  page: TestPage;
  selection: CardsSelectionStore;
  cursor: LayoutCursor;
}

let bus: TestBus;
afterEach(() => bus?.dispose());

function share(page: TestPage): SharedPage {
  const selection = new CardsSelectionStore();
  const cursor = makeCursor();
  shareLayoutSelection(page.bus, selection, cursor);
  return { page, selection, cursor };
}

/** The shell and one Cards body, each sharing its selection. */
async function makePages(): Promise<{ shell: SharedPage; body: SharedPage }> {
  bus = createTestBus();
  const shell = share(bus.shell());
  const body = share(bus.body("cards-1", "cards"));
  await bus.flush();
  return { shell, body };
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
  test("a set the list builds is the set the shell's verbs resolve", async () => {
    const { shell, body } = await makePages();
    body.selection.pickOnly("A");
    body.selection.toggle("C");
    await bus.flush();
    expect(shell.selection.getSnapshot()).toEqual({ ids: ["A", "C"], anchorId: "C" });
    expect(resolveLayoutSelection(deckOf(["A", "B", "C"]), shell.selection)).toEqual(["A", "C"]);
  });

  test("the list's Escape clear reaches the shell", async () => {
    const { shell, body } = await makePages();
    body.selection.pickOnly("A");
    await bus.flush();
    body.selection.clear();
    await bus.flush();
    expect(shell.selection.getSnapshot().ids).toEqual([]);
  });

  test("the cursor the list publishes shows in the body at once and is the shell's cursor one delivery later", async () => {
    const { shell, body } = await makePages();
    body.cursor.set("B");
    // Optimistic: the body's replica says it before the shell has heard.
    expect(layoutSelection.on(body.page.bus).getSnapshot().cursor).toBe("B");
    expect(shell.cursor.get()).toBeNull();
    await bus.flush();
    expect(shell.cursor.get()).toBe("B");
    body.cursor.set(null);
    await bus.flush();
    expect(shell.cursor.get()).toBeNull();
  });
});

describe("the shell's selection reaches the Cards body", () => {
  test("a write in the shell — a prune, the deck root's Escape, a test — is the list's", async () => {
    const { shell, body } = await makePages();
    shell.selection.pickOnly("A");
    shell.selection.toggle("C");
    await bus.flush();
    expect(body.selection.getSnapshot()).toEqual({ ids: ["A", "C"], anchorId: "C" });
    shell.selection.clear();
    await bus.flush();
    expect(body.selection.getSnapshot().ids).toEqual([]);
  });

  test("the body takes the shell's word without saying it back", async () => {
    const { shell, body } = await makePages();
    const before = bus.frames().length;
    shell.selection.pickOnly("A");
    await bus.flush();
    expect(body.selection.getSnapshot().ids).toEqual(["A"]);
    const sent = bus.frames().slice(before);
    expect(sent.every((f) => f.from === shell.page.pageId)).toBe(true);
  });

  test("an owner prune after the body's write overrides it once the write is acknowledged", async () => {
    const { shell, body } = await makePages();
    body.selection.pickOnly("A");
    body.selection.toggle("B");
    await bus.flush();
    // The card B named is closed: the shell prunes it.
    shell.selection.pruneTo(["A"]);
    await bus.flush();
    expect(shell.selection.getSnapshot().ids).toEqual(["A"]);
    expect(body.selection.getSnapshot().ids).toEqual(["A"]);
  });

  test("two body writes in flight end where the second left it, with no flicker back to the first", async () => {
    const { shell, body } = await makePages();
    const seen: string[][] = [];
    body.selection.subscribe(() => seen.push([...body.selection.getSnapshot().ids]));
    body.selection.pickOnly("A");
    body.selection.pickOnly("B");
    await bus.flush();
    expect(shell.selection.getSnapshot().ids).toEqual(["B"]);
    expect(body.selection.getSnapshot().ids).toEqual(["B"]);
    expect(seen).toEqual([["A"], ["B"]]);
  });
});

describe("the shell's cursor", () => {
  test("a Cards body letting go of a cursor another holds leaves it standing", async () => {
    const { shell, body } = await makePages();
    const parked = share(bus.body("cards-2", "cards"));
    await bus.flush();
    body.cursor.set("B");
    await bus.flush();
    parked.cursor.set("X");
    parked.cursor.set(null);
    await bus.flush();
    // The second body held the cursor last and let it go: the shell's goes.
    expect(shell.cursor.get()).toBeNull();
    body.cursor.set("C");
    await bus.flush();
    parked.cursor.set("Y");
    await bus.flush();
    body.cursor.set(null);
    await bus.flush();
    // The first let go of a cursor the second now holds: it stands.
    expect(shell.cursor.get()).toBe("Y");
  });

  test("goes with the page that held it", async () => {
    const { shell, body } = await makePages();
    body.cursor.set("B");
    await bus.flush();
    expect(shell.cursor.get()).toBe("B");
    bus.detach("cards-1");
    await bus.flush();
    expect(shell.cursor.get()).toBeNull();
  });
});

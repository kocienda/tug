/**
 * New Workspace through the naming modal: the bounded wait for the pending
 * pages, in its three endings, the gesture's two outcomes over a deck that
 * holds a pending workspace, and the close's bounded wait for the new row's
 * rect, which the modal zooms out to.
 *
 * @covers tugdeck/src/lib/new-workspace.ts
 * @covers tugdeck/src/lib/workspace-name-zoom.ts
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cardsSpaceVerbRequest } from "../cards-space-verb-request";
import { newWorkspaceThroughModal, waitForPaint, type PaintWaitDeps } from "../new-workspace";
import {
  answerWorkspaceName,
  getWorkspaceNameRequest,
  resetWorkspaceNameRequestForTests,
  setWorkspaceNameTimerForTests,
  WORKSPACE_NAME_DESTINATION_BOUND_MS,
  type WorkspaceNameTimer,
} from "../workspace-name-request";
import { answerSpaceRow } from "../workspace-name-zoom";
import { CARDS_CARD_ID } from "../cards-card-id";
import type { IDeckManagerStore } from "../../deck-manager-store";
import type { DeckState } from "../../layout-tree";
import type { SpacesSnapshot } from "../../spaces";

/** Pages whose states the test moves by hand, and a clock it fires by hand. */
function fakePages(painted: string[]): {
  deps: PaintWaitDeps;
  paint: (cardId: string) => void;
  fireBound: () => void;
  listeners: () => number;
} {
  const done = new Set(painted);
  const listeners = new Set<() => void>();
  let bound: (() => void) | null = null;
  return {
    deps: {
      settled: (cardId) => done.has(cardId),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      after: (fn) => {
        bound = fn;
        return () => {
          bound = null;
        };
      },
    },
    paint: (cardId) => {
      done.add(cardId);
      for (const listener of [...listeners]) listener();
    },
    fireBound: () => bound?.(),
    listeners: () => listeners.size,
  };
}

describe("waitForPaint", () => {
  test("pages painted already: no wait, and it says so at once", async () => {
    const pages = fakePages(["a", "b"]);
    const wait = waitForPaint(["a", "b"], pages.deps);
    expect(wait.already).toBe(true);
    expect(await wait.done).toBe("painted");
    expect(pages.listeners()).toBe(0);
  });

  test("pages painted during the wait: it ends when the last one paints", async () => {
    const pages = fakePages(["a"]);
    const wait = waitForPaint(["a", "b", "c"], pages.deps);
    expect(wait.already).toBe(false);
    pages.paint("b");
    let ended = false;
    void wait.done.then(() => {
      ended = true;
    });
    await Promise.resolve();
    expect(ended).toBe(false);
    pages.paint("c");
    expect(await wait.done).toBe("painted-during-wait");
    expect(pages.listeners()).toBe(0);
  });

  test("a page that never paints: it ends at the bound", async () => {
    const pages = fakePages([]);
    const wait = waitForPaint(["a"], pages.deps);
    pages.fireBound();
    expect(await wait.done).toBe("bound");
    expect(pages.listeners()).toBe(0);
  });
});

/**
 * A deck that holds one pending workspace of cards with no pages to wait on;
 * with `cardsCard`, the deck on screen holds a Workspaces card.
 */
function fakeDeck(cardsCard = false): { store: IDeckManagerStore; log: string[] } {
  const log: string[] = [];
  let pending: string | null = null;
  const rail: DeckState = {
    cards: [],
    panes: [],
    imposition: { sidebars: {} },
    hasFocus: true,
  };
  const store = {
    getSnapshot: () => ({ cards: cardsCard ? [{ id: "cards-1", componentId: CARDS_CARD_ID }] : [] }),
    getSpacesSnapshot: (): SpacesSnapshot => ({
      spaces: [{ id: "home", name: "Home" }],
      activeSpaceId: "home",
      mountedSpaceIds: ["home"],
      mountedDecks: new Map(),
      ...(pending !== null ? { pendingSpaceId: pending } : {}),
    }),
    getSpaceDeck: (spaceId: string) => (spaceId === pending ? rail : null),
    beginPendingSpace: () => {
      pending = "new";
      log.push("begin");
      return { id: "new", name: "Workspace 2" };
    },
    discardPendingSpace: () => {
      pending = null;
      log.push("discard");
    },
    adoptPendingSpace: (name?: string) => {
      pending = null;
      log.push(`adopt ${name}`);
      return "new";
    },
  };
  return { store: store as unknown as IDeckManagerStore, log };
}

describe("newWorkspaceThroughModal", () => {
  afterEach(() => {
    resetWorkspaceNameRequestForTests();
    cardsSpaceVerbRequest.clear();
  });

  test("asks with the pending workspace's proposed name, and a cancel discards it", async () => {
    const { store, log } = fakeDeck();
    const gesture = newWorkspaceThroughModal(store);
    const request = getWorkspaceNameRequest();
    expect(request.open).toBe(true);
    expect(request.verb).toBe("new");
    expect(request.proposed).toBe("Workspace 2");
    answerWorkspaceName(request.seq, null);
    expect(await gesture).toBeNull();
    expect(log).toEqual(["begin", "discard"]);
    expect(cardsSpaceVerbRequest.getSnapshot()).toBeNull();
  });

  test("a committed name cuts before the question closes, then lands the keyboard on its row", async () => {
    const { store, log } = fakeDeck();
    const gesture = newWorkspaceThroughModal(store);
    answerWorkspaceName(getWorkspaceNameRequest().seq, "Notes");
    // Its pages had painted, so the cut is in the answer's own task.
    expect(log).toEqual(["begin", "adopt Notes"]);
    expect(getWorkspaceNameRequest().open).toBe(false);
    expect(await gesture).toBe("new");
    expect(cardsSpaceVerbRequest.getSnapshot()).toMatchObject({ verb: "focus", spaceId: "new" });
  });

  test("a New fired while a committed name waits is not adopted under that name", async () => {
    // A deck whose begin mints a fresh pending workspace each time, replacing
    // any held, as the deck manager's does; each holds one rail card.
    const log: string[] = [];
    let pending: string | null = null;
    let minted = 0;
    const rail = { cards: [{ id: "rail" }], panes: [], imposition: { sidebars: {} }, hasFocus: true } as unknown as DeckState;
    const store = {
      getSnapshot: () => ({ cards: [] }),
      getSpacesSnapshot: (): SpacesSnapshot => ({
        spaces: [{ id: "home", name: "Home" }],
        activeSpaceId: "home",
        mountedSpaceIds: ["home"],
        mountedDecks: new Map(),
        ...(pending !== null ? { pendingSpaceId: pending } : {}),
      }),
      getSpaceDeck: (spaceId: string) => (spaceId === pending ? rail : null),
      beginPendingSpace: () => {
        minted += 1;
        pending = `new-${minted}`;
        log.push(`begin ${pending}`);
        return { id: pending, name: `Workspace ${minted + 1}` };
      },
      discardPendingSpace: () => {
        log.push(`discard ${pending}`);
        pending = null;
      },
      adoptPendingSpace: (name?: string) => {
        const id = pending;
        pending = null;
        log.push(`adopt ${id} ${name}`);
        return id;
      },
    } as unknown as IDeckManagerStore;

    const firstPages = fakePages([]);
    const first = newWorkspaceThroughModal(store, { pages: firstPages.deps });
    answerWorkspaceName(getWorkspaceNameRequest().seq, "First");
    expect(getWorkspaceNameRequest().waiting).toBe(true);

    // The second New takes the modal and the pending slot while the first waits.
    const second = newWorkspaceThroughModal(store, { pages: fakePages(["rail"]).deps });
    const secondSeq = getWorkspaceNameRequest().seq;
    firstPages.paint("rail");
    expect(await first).toBeNull();
    expect(getWorkspaceNameRequest()).toMatchObject({ open: true, seq: secondSeq, waiting: false });

    answerWorkspaceName(secondSeq, "Second");
    expect(await second).toBe("new-2");
    expect(log).toEqual(["begin new-1", "begin new-2", "adopt new-2 Second"]);
  });
});

describe("the close's wait for the new row", () => {
  const ROW = { top: 72, left: 8, width: 280, height: 28 };
  let bound: (() => void) | null = null;
  const timer: WorkspaceNameTimer = (fn, ms) => {
    expect(ms).toBe(WORKSPACE_NAME_DESTINATION_BOUND_MS);
    bound = fn;
    return () => {
      bound = null;
    };
  };

  afterEach(() => {
    resetWorkspaceNameRequestForTests();
    cardsSpaceVerbRequest.clear();
    bound = null;
  });

  test("the cut asks the Workspaces card for the row, and the close waits for its rect", async () => {
    setWorkspaceNameTimerForTests(timer);
    const { store, log } = fakeDeck(true);
    const gesture = newWorkspaceThroughModal(store, { from: { top: 30, left: 260, width: 20, height: 20 } });
    answerWorkspaceName(getWorkspaceNameRequest().seq, "Notes");
    // Cut, and asked where the row is — between the cut and the close.
    expect(log).toEqual(["begin", "adopt Notes"]);
    expect(cardsSpaceVerbRequest.getSnapshot()).toMatchObject({ verb: "locate", spaceId: "new" });
    expect(getWorkspaceNameRequest()).toMatchObject({ open: true, waiting: true, to: null });
    // The card answers; the question closes carrying the row.
    cardsSpaceVerbRequest.clear();
    answerSpaceRow("cards-1", ROW);
    expect(getWorkspaceNameRequest()).toMatchObject({ open: false, to: ROW });
    expect(bound).toBeNull();
    expect(await gesture).toBe("new");
    // The keyboard lands on the row after the close, as it always did.
    expect(cardsSpaceVerbRequest.getSnapshot()).toMatchObject({ verb: "focus", spaceId: "new" });
  });

  test("a card that never answers: the question closes at the bound, with no row", async () => {
    setWorkspaceNameTimerForTests(timer);
    const { store } = fakeDeck(true);
    const gesture = newWorkspaceThroughModal(store);
    answerWorkspaceName(getWorkspaceNameRequest().seq, "Notes");
    expect(getWorkspaceNameRequest().open).toBe(true);
    bound?.();
    expect(getWorkspaceNameRequest()).toMatchObject({ open: false, to: null });
    expect(await gesture).toBe("new");
    // Late: the row reports after the bound closed the question, and is dropped.
    answerSpaceRow("cards-1", ROW);
    expect(getWorkspaceNameRequest().to).toBeNull();
  });

  test("a card with no row on screen answers none, and the close goes ahead at once", async () => {
    setWorkspaceNameTimerForTests(timer);
    const { store } = fakeDeck(true);
    const gesture = newWorkspaceThroughModal(store);
    answerWorkspaceName(getWorkspaceNameRequest().seq, "Notes");
    answerSpaceRow("cards-1", null);
    expect(getWorkspaceNameRequest()).toMatchObject({ open: false, to: null });
    expect(await gesture).toBe("new");
  });

  test("a deck with no Workspaces card has no row to land on: no ask, no wait", async () => {
    setWorkspaceNameTimerForTests(timer);
    const { store } = fakeDeck(false);
    const gesture = newWorkspaceThroughModal(store);
    answerWorkspaceName(getWorkspaceNameRequest().seq, "Notes");
    expect(getWorkspaceNameRequest()).toMatchObject({ open: false, to: null });
    expect(bound).toBeNull();
    expect(await gesture).toBe("new");
  });
});

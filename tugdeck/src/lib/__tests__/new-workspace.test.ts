/**
 * New Workspace through the naming modal: the bounded wait for the pending
 * pages, in its three endings, and the gesture's two outcomes over a deck
 * that holds a pending workspace.
 *
 * @covers tugdeck/src/lib/new-workspace.ts
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cardsSpaceVerbRequest } from "../cards-space-verb-request";
import { newWorkspaceThroughModal, waitForPaint, type PaintWaitDeps } from "../new-workspace";
import {
  answerWorkspaceName,
  getWorkspaceNameRequest,
  resetWorkspaceNameRequestForTests,
} from "../workspace-name-request";
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

/** A deck that holds one pending workspace of cards with no pages to wait on. */
function fakeDeck(): { store: IDeckManagerStore; log: string[] } {
  const log: string[] = [];
  let pending: string | null = null;
  const rail: DeckState = {
    cards: [],
    panes: [],
    imposition: { sidebars: {} },
    hasFocus: true,
  };
  const store = {
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
    const first = newWorkspaceThroughModal(store, firstPages.deps);
    answerWorkspaceName(getWorkspaceNameRequest().seq, "First");
    expect(getWorkspaceNameRequest().waiting).toBe(true);

    // The second New takes the modal and the pending slot while the first waits.
    const second = newWorkspaceThroughModal(store, fakePages(["rail"]).deps);
    const secondSeq = getWorkspaceNameRequest().seq;
    firstPages.paint("rail");
    expect(await first).toBeNull();
    expect(getWorkspaceNameRequest()).toMatchObject({ open: true, seq: secondSeq, waiting: false });

    answerWorkspaceName(secondSeq, "Second");
    expect(await second).toBe("new-2");
    expect(log).toEqual(["begin new-1", "begin new-2", "adopt new-2 Second"]);
  });
});

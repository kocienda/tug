/**
 * close-guard-walk.test.ts — the shared walk over a set of cards' close
 * guards.
 *
 * The walk is what two destructive gestures owe the user: closing a pane of
 * tabs and deleting a workspace both destroy several cards at once, and both
 * must visit each one that holds unsaved work, show its sheet over its own
 * content, and abandon the whole gesture at the first Cancel. It used to live
 * inside the pane; the workspace delete needed the same sequence, and the
 * second copy is how two surfaces come to disagree about which cards get
 * asked.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { registerCardCloseGuard } from "../card-close-guard";
import { closeGuardWalk } from "../close-guard-walk";

const releases: (() => void)[] = [];

afterEach(() => {
  for (const release of releases.splice(0)) release();
});

/**
 * Register a guard for `cardId` whose sheet answers `answer` and whose dirty
 * probe is read LIVE from the returned handle, so a test can clean a card
 * mid-walk the way a Save All would.
 */
function seedGuard(
  cardId: string,
  answer: "close" | "cancel",
  dirty = true,
): { ran: string[]; setDirty: (value: boolean) => void } {
  const state = { dirty };
  const ran: string[] = [];
  releases.push(
    registerCardCloseGuard(cardId, {
      needsDecision: () => state.dirty,
      run: async () => {
        ran.push(cardId);
        return answer;
      },
    }),
  );
  return { ran, setDirty: (value) => (state.dirty = value) };
}

describe("closeGuardWalk", () => {
  test("answers null when no card registers a guard at all", () => {
    expect(closeGuardWalk(["a", "b"], () => {}, () => false)).toBeNull();
  });

  test("answers null when every guard is clean — the caller keeps its own confirm", () => {
    // This is the property that keeps a multi-tab pane's "Close N Tabs?"
    // stray-click protection. A resolver answering "close" here would look
    // equivalent and would silently swallow that popover.
    seedGuard("clean-1", "close", false);
    seedGuard("clean-2", "close", false);
    expect(
      closeGuardWalk(["clean-1", "clean-2"], () => {}, () => false),
    ).toBeNull();
  });

  test("visits the guarded cards in the order given, fronting each dirty one", async () => {
    const first = seedGuard("v-first", "close");
    const second = seedGuard("v-second", "close");
    const fronted: string[] = [];

    // "v-unguarded" registers nothing and must not be visited or fronted —
    // a card with no unsaved state has no decision to make.
    const decision = closeGuardWalk(
      ["v-first", "v-unguarded", "v-second"],
      (id) => fronted.push(id),
      () => false,
    );
    expect(decision).not.toBeNull();
    expect(await decision?.()).toBe("close");

    expect(first.ran).toEqual(["v-first"]);
    expect(second.ran).toEqual(["v-second"]);
    expect(fronted).toEqual(["v-first", "v-second"]);
  });

  test("fronts only the cards that are dirty, and only those not already front", async () => {
    seedGuard("f-dirty", "close");
    // Clean, so it is guarded (and therefore visited) but has no sheet to
    // put over anything.
    seedGuard("f-clean", "close", false);
    seedGuard("f-front", "close");
    const fronted: string[] = [];

    const decision = closeGuardWalk(
      ["f-dirty", "f-clean", "f-front"],
      (id) => fronted.push(id),
      (id) => id === "f-front",
    );
    expect(await decision?.()).toBe("close");
    expect(fronted).toEqual(["f-dirty"]);
  });

  test("re-resolves each guard at visit time, so a card cleaned mid-walk is not fronted", async () => {
    const fronted: string[] = [];
    const later = seedGuard("r-later", "close");
    // The first card's sheet cleans the second, the way a Save All does.
    releases.push(
      registerCardCloseGuard("r-first", {
        needsDecision: () => true,
        run: async () => {
          later.setDirty(false);
          return "close";
        },
      }),
    );

    const decision = closeGuardWalk(
      ["r-first", "r-later"],
      (id) => fronted.push(id),
      () => false,
    );
    expect(await decision?.()).toBe("close");
    // Visited — it is still guarded — but never fronted, because by the time
    // the walk reached it there was nothing left to ask about. A list of
    // guard objects captured up front would have prompted for work that was
    // already saved.
    expect(later.ran).toEqual(["r-later"]);
    expect(fronted).toEqual(["r-first"]);
  });

  test("a cancel stops the walk where it stands and abandons the gesture", async () => {
    const first = seedGuard("c-first", "cancel");
    const never = seedGuard("c-never", "close");

    const decision = closeGuardWalk(
      ["c-first", "c-never"],
      () => {},
      () => false,
    );
    expect(await decision?.()).toBe("cancel");
    expect(first.ran).toEqual(["c-first"]);
    expect(
      never.ran,
      "the cards after the cancel are never even asked",
    ).toEqual([]);
  });
});

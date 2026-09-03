/**
 * `bind_arc_ok` / `unbind_arc_ok` at the `initActionDispatch` level.
 *
 * These frames are how a card learns which arc it is working on after the
 * moment it opened — and the hardest case is the one nobody was testing: the
 * **rotation seat**. The Wheel mints a fresh segment mid-arc, tugcast carries
 * the binding forward onto it and announces the mating, and the deck has to
 * find the card. Its ordinary route is the segment → line → card walk, which
 * cannot answer for a segment it has never heard of.
 *
 * So the contract under test is routing, in three doors, plus the one thing a
 * handler on this path must never do again: drop the frame in silence. The
 * card it was meant for reads "unbound" for the rest of its arc, and no
 * gesture from inside that session can repair it
 * (`notes/wheel-rotation-strands-the-arc.md`).
 *
 * The harness is the real `initActionDispatch` over a mock connection, so the
 * frames arrive the way tugcast sends them — through `dispatchAction`, not by
 * calling a handler directly. The other frame this wiring routes by line —
 * `pendingAskStore`'s injected `sessionFor` — needs a live services bag and so
 * a wire connection, and is covered next door in
 * `pending-ask-line-routing.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { initActionDispatch, dispatchAction, _resetForTest } from "../action-dispatch";
import {
  cardSessionBindingStore,
  type CardSessionBinding,
} from "../lib/card-session-binding-store";
import { sessionLineStore } from "../lib/session-line-store";

// ---- the harness ----

/** Frames the deck sent back, in order. */
interface SentControlFrame {
  action: string;
  payload: Record<string, unknown>;
}

function createMockConnection(sent: SentControlFrame[]) {
  const frameCallbacks = new Map<number, (payload: Uint8Array) => void>();
  return {
    onFrame(feedId: number, cb: (payload: Uint8Array) => void): () => void {
      frameCallbacks.set(feedId, cb);
      return () => frameCallbacks.delete(feedId);
    },
    sendControlFrame(action: string, payload: Record<string, unknown>): void {
      sent.push({ action, payload });
    },
  };
}

function createMockDeckManager(focusedCardId: string | null = null) {
  return {
    addCard: (): string | null => null,
    showSingletonCard: (): string | null => null,
    prepareForReload: (): Promise<void> => Promise.resolve(),
    getFocusedCardId: (): string | null => focusedCardId,
  };
}

/** Card ids this file has bound, so each test can put the store back. */
const TOUCHED_CARDS = new Set<string>();

/** Seat `cardId` on `(tugSessionId, lineId)`, unbound. */
function seatCard(cardId: string, tugSessionId: string, lineId: string): void {
  TOUCHED_CARDS.add(cardId);
  const binding: CardSessionBinding = {
    tugSessionId,
    lineId,
    workspaceKey: "/work/bind-arc-ok-test",
    projectDir: "/work/bind-arc-ok-test",
    sessionMode: "new",
  };
  cardSessionBindingStore.setBinding(cardId, binding);
}

function arcOf(cardId: string): string | undefined {
  return cardSessionBindingStore.getBinding(cardId)?.arc?.name;
}

let sent: SentControlFrame[] = [];
let dispose: () => void = () => {};

/** Stand the real wiring up. Returns the warnings it emits. */
function init(focusedCardId: string | null = null): string[] {
  _resetForTest();
  sent = [];
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    dispose = initActionDispatch(
      createMockConnection(sent) as never,
      createMockDeckManager(focusedCardId) as never,
    );
  } finally {
    console.warn = realWarn;
  }
  return warnings;
}

/**
 * Dispatch one frame, capturing whatever the handler warned about.
 *
 * `CardServicesStore` grumbles about the absent wire connection every time a
 * binding moves — it is not this file's subject and there is no connection to
 * give it here, so it is filtered out rather than asserted around.
 */
function dispatch(payload: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    dispatchAction(payload);
  } finally {
    console.warn = realWarn;
  }
  return warnings.filter((w) => !w.startsWith("CardServicesStore:"));
}

beforeEach(() => {
  init();
});

afterEach(() => {
  dispose();
  dispose = () => {};
  for (const cardId of TOUCHED_CARDS) cardSessionBindingStore.clearBinding(cardId);
  TOUCHED_CARDS.clear();
  _resetForTest();
});

// ---- routing ----

describe("bind_arc_ok routing", () => {
  it("paints the card whose seated session the frame names", () => {
    seatCard("card-1", "seg-a", "line-1");

    const warnings = dispatch({
      action: "bind_arc_ok",
      tug_session_id: "seg-a",
      arc_id: "tugarc/demo#1",
      arc_name: "demo",
    });

    expect(arcOf("card-1")).toBe("demo");
    expect(warnings).toEqual([]);
  });

  it("routes a rotation's fresh segment by the card_id the seat sends", () => {
    // The card is still seated on the segment it was born on; the Wheel has
    // just minted `seg-new` and no frame has yet told this deck about it.
    seatCard("card-1", "seg-old", "line-1");

    dispatch({
      action: "bind_arc_ok",
      tug_session_id: "seg-new",
      arc_id: "tugarc/demo#1",
      arc_name: "demo",
      line_id: "line-1",
      card_id: "card-1",
    });

    expect(arcOf("card-1")).toBe("demo");
  });

  it("routes by line_id when the seat names no card", () => {
    seatCard("card-1", "seg-old", "line-1");

    dispatch({
      action: "bind_arc_ok",
      tug_session_id: "seg-new",
      arc_id: "tugarc/demo#1",
      arc_name: "demo",
      line_id: "line-1",
    });

    expect(arcOf("card-1")).toBe("demo");
  });

  it("ignores a card_id no card holds and falls through to the line", () => {
    seatCard("card-1", "seg-old", "line-1");

    dispatch({
      action: "bind_arc_ok",
      tug_session_id: "seg-new",
      arc_id: "tugarc/demo#1",
      arc_name: "demo",
      line_id: "line-1",
      card_id: "card-that-closed",
    });

    expect(arcOf("card-1")).toBe("demo");
  });

  it("still routes an old server's frame, which carries neither field", () => {
    // The version-skew shape: a new deck against a tugcast that predates the
    // routing halves. The deck's own segment → line walk is what answers, so
    // the frame must degrade rather than be refused.
    seatCard("card-1", "seg-old", "line-1");
    sessionLineStore.bind("seg-new", "line-1");

    dispatch({
      action: "bind_arc_ok",
      tug_session_id: "seg-new",
      arc_id: "tugarc/demo#1",
      arc_name: "demo",
    });

    expect(arcOf("card-1")).toBe("demo");
  });

  it("records the pair the frame names, so later frames resolve for free", () => {
    seatCard("card-1", "seg-old", "line-1");

    dispatch({
      action: "bind_arc_ok",
      tug_session_id: "seg-new",
      arc_id: "tugarc/demo#1",
      arc_name: "demo",
      line_id: "line-1",
      card_id: "card-1",
    });

    expect(sessionLineStore.lineOf("seg-new")).toBe("line-1");
    expect(sessionLineStore.seatOf("line-1")).toBe("seg-new");
  });

  it("warns rather than dropping an announcement it cannot route", () => {
    const warnings = dispatch({
      action: "bind_arc_ok",
      tug_session_id: "seg-nobody-holds",
      arc_id: "tugarc/demo#1",
      arc_name: "demo",
    });

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("bind_arc_ok");
  });

  it("warns on a malformed frame and changes nothing", () => {
    seatCard("card-1", "seg-a", "line-1");

    const warnings = dispatch({
      action: "bind_arc_ok",
      tug_session_id: "seg-a",
      arc_id: "tugarc/demo#1",
    });

    expect(warnings.length).toBe(1);
    expect(arcOf("card-1")).toBeUndefined();
  });
});

describe("unbind_arc_ok routing", () => {
  it("clears the card's arc half", () => {
    seatCard("card-1", "seg-a", "line-1");
    dispatch({
      action: "bind_arc_ok",
      tug_session_id: "seg-a",
      arc_id: "tugarc/demo#1",
      arc_name: "demo",
    });
    expect(arcOf("card-1")).toBe("demo");

    const warnings = dispatch({
      action: "unbind_arc_ok",
      tug_session_id: "seg-a",
    });

    expect(arcOf("card-1")).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("warns rather than dropping an unmating it cannot route", () => {
    const warnings = dispatch({
      action: "unbind_arc_ok",
      tug_session_id: "seg-nobody-holds",
    });

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("unbind_arc_ok");
  });
});


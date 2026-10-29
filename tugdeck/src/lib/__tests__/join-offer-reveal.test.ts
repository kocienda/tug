/**
 * join-offer-reveal — the unbidden Changes reveal's gate.
 *
 * Pins the one thing the gate exists to decide: which conditions defer the
 * reveal, that a folded card is one of them ([B06]), and that every deferral
 * is a deferral rather than a refusal — the caller spends the arc head only on
 * a `true`, so the table below is also the record of what does NOT spend it.
 * A half-typed composer is not in the table: it stopped being a hold ([B05]),
 * and the record says so by its absence.
 */

import { describe, expect, test } from "bun:test";

import {
  isLandingInFlight,
  JoinOfferMemory,
  joinOfferRevealHold,
  joinOfferRevealHoldSentence,
  JoinOfferRevealReceipts,
  shouldRevealJoinOffer,
  type JoinOfferRevealInput,
} from "../join-offer-reveal";

/** A quiet, open card with an unseen offer — the one state that reveals. */
function quiet(over: Partial<JoinOfferRevealInput> = {}): JoinOfferRevealInput {
  return {
    alreadyRevealed: false,
    landingInFlight: false,
    turnInFlight: false,
    anyLandingActive: false,
    shadeShowing: false,
    folded: false,
    ...over,
  };
}

describe("shouldRevealJoinOffer", () => {
  test("a quiet open card with an unseen offer reveals", () => {
    expect(shouldRevealJoinOffer(quiet())).toBe(true);
  });

  test("a folded card defers — the room has no door in the folded form", () => {
    expect(shouldRevealJoinOffer(quiet({ folded: true }))).toBe(false);
  });

  test("the fold defers a card that is otherwise entirely quiet", () => {
    // The point of [B06]: every other condition holding is exactly the case the
    // old gate fired on, and it is the case that opened a room behind Z2.
    expect(shouldRevealJoinOffer(quiet({ folded: true }))).toBe(false);
    expect(shouldRevealJoinOffer(quiet({ folded: false }))).toBe(true);
  });

  test.each([
    ["a head already revealed on this mount", { alreadyRevealed: true }],
    ["this card's own landing in flight", { landingInFlight: true }],
    ["a turn in flight", { turnInFlight: true }],
    ["a landing already up", { anyLandingActive: true }],
    ["a shade already showing", { shadeShowing: true }],
    ["a folded card", { folded: true }],
  ] as const)("%s defers", (_name, over) => {
    expect(shouldRevealJoinOffer(quiet(over))).toBe(false);
  });

  test("the unfold is what re-opens it — same inputs, fold flipped", () => {
    const folded = quiet({ folded: true });
    expect(shouldRevealJoinOffer(folded)).toBe(false);
    expect(shouldRevealJoinOffer({ ...folded, folded: false })).toBe(true);
  });

  test("the fold does not outrank the once-per-head memory", () => {
    // Unfolding must not re-open the room for work already shown: the memory is
    // what says "you have seen this", and no other condition overrides it.
    expect(
      shouldRevealJoinOffer(quiet({ alreadyRevealed: true, folded: false })),
    ).toBe(false);
  });
});

describe("a Join press holds the reveal until the join settles", () => {
  test("the commit after the press reads clear everywhere but the landing", () => {
    // The press exits the mode, hides the shade and restores an empty prompt,
    // so every other input is the quiet state that reveals. The landing in
    // flight is the only thing left to keep the room from coming back over it.
    const afterPress = quiet({
      landingInFlight: isLandingInFlight({
        narrating: true,
        landProgress: { terminal: false },
        joinPhase: "idle",
      }),
    });
    expect(shouldRevealJoinOffer(afterPress)).toBe(false);
    expect(shouldRevealJoinOffer({ ...afterPress, landingInFlight: false })).toBe(true);
  });
});

describe("isLandingInFlight", () => {
  const idle = { narrating: false, landProgress: null, joinPhase: "idle" } as const;

  test("nothing running is not in flight", () => {
    expect(isLandingInFlight(idle)).toBe(false);
  });

  test("a narrating register is in flight", () => {
    expect(isLandingInFlight({ ...idle, narrating: true })).toBe(true);
  });

  test("a non-terminal land beat is in flight, a terminal one is not", () => {
    expect(isLandingInFlight({ ...idle, landProgress: {} })).toBe(true);
    expect(isLandingInFlight({ ...idle, landProgress: { terminal: false } })).toBe(true);
    expect(isLandingInFlight({ ...idle, landProgress: { terminal: true } })).toBe(false);
  });

  test("a pending join verb is in flight, a settled one is not", () => {
    expect(isLandingInFlight({ ...idle, joinPhase: "pending" })).toBe(true);
    for (const phase of ["done", "conflict", "error"]) {
      expect(isLandingInFlight({ ...idle, joinPhase: phase })).toBe(false);
    }
  });

  test("a narration resting on a settled join is not in flight", () => {
    // A failed join keeps its register narrating as the standing surface, so
    // the narration outlives the run; the terminal beat is what says it ended.
    const failed = { narrating: true, landProgress: { terminal: true }, joinPhase: "error" };
    expect(isLandingInFlight(failed)).toBe(false);
    expect(isLandingInFlight({ ...failed, landProgress: { terminal: false } })).toBe(true);
  });
});

describe("JoinOfferMemory — any entry into join mode spends the offer", () => {
  const offer = { ownerId: "arc-1", key: "head-a" } as const;

  test("a room opened by hand under a held gate spends its offer", () => {
    // The gate held (a turn in flight), so the passive reveal never fired;
    // the user opened the room by a hand door instead. Closing it must not
    // leave the head unspent for the reveal to re-open.
    const memory = new JoinOfferMemory();
    expect(shouldRevealJoinOffer(quiet({ turnInFlight: true }))).toBe(false);
    expect(memory.spendOnEntry("arc-1", offer)).toBe(true);
    const afterClose = quiet({ alreadyRevealed: memory.has(offer.key) });
    expect(shouldRevealJoinOffer(afterClose)).toBe(false);
  });

  test("join mode down spends nothing", () => {
    const memory = new JoinOfferMemory();
    expect(memory.spendOnEntry(null, offer)).toBe(false);
    expect(memory.has(offer.key)).toBe(false);
  });

  test("join mode on another arc spends nothing", () => {
    const memory = new JoinOfferMemory();
    expect(memory.spendOnEntry("arc-2", offer)).toBe(false);
    expect(memory.has(offer.key)).toBe(false);
  });

  test("no standing offer spends nothing", () => {
    const memory = new JoinOfferMemory();
    expect(memory.spendOnEntry("arc-1", null)).toBe(false);
  });

  test("a key that moves while the room is open is spent too", () => {
    const memory = new JoinOfferMemory();
    memory.spendOnEntry("arc-1", offer);
    memory.spendOnEntry("arc-1", { ...offer, key: "head-b" });
    expect(memory.has("head-a")).toBe(true);
    expect(memory.has("head-b")).toBe(true);
  });

  test("a new key the room never showed is not spent", () => {
    const memory = new JoinOfferMemory();
    memory.spendOnEntry("arc-1", offer);
    expect(memory.has("head-b")).toBe(false);
  });

  test("forget makes shown work new again", () => {
    const memory = new JoinOfferMemory();
    memory.spendOnEntry("arc-1", offer);
    memory.forget();
    expect(memory.has(offer.key)).toBe(false);
  });
});

describe("joinOfferRevealHold — the gate's first failing reason", () => {
  test("a quiet open card has no hold", () => {
    expect(joinOfferRevealHold(quiet())).toBeNull();
  });

  test.each([
    [{ alreadyRevealed: true }, "already-shown"],
    [{ landingInFlight: true }, "landing-in-flight"],
    [{ folded: true }, "folded"],
    [{ turnInFlight: true }, "turn-in-flight"],
    [{ anyLandingActive: true }, "landing-active"],
    [{ shadeShowing: true }, "shade-showing"],
  ] as const)("%o holds as %s", (over, hold) => {
    expect(joinOfferRevealHold(quiet(over))).toBe(hold);
  });

  test("the first failing input is the one named", () => {
    // A folded card with a running turn waits on the unfold first: the turn
    // ending would still leave the room with no door.
    expect(joinOfferRevealHold(quiet({ folded: true, turnInFlight: true }))).toBe("folded");
    expect(
      joinOfferRevealHold(quiet({ alreadyRevealed: true, turnInFlight: true })),
    ).toBe("already-shown");
  });

  test("the dot says what a deferral waits on, in the gate's words", () => {
    expect(joinOfferRevealHoldSentence("turn-in-flight")).toBe("opens when the turn finishes");
    expect(joinOfferRevealHoldSentence("landing-active")).toBe("opens when this landing closes");
    expect(joinOfferRevealHoldSentence("folded")).toBe("unfold to open");
  });

  test("a room that has shown its work, or has no hold, says nothing extra", () => {
    expect(joinOfferRevealHoldSentence("already-shown")).toBeNull();
    expect(joinOfferRevealHoldSentence(null)).toBeNull();
  });
});

describe("JoinOfferRevealReceipts — once per key and reason", () => {
  test("a new answer is due once, and its repeat is not", () => {
    const receipts = new JoinOfferRevealReceipts();
    const deferred = { key: "head-a", verdict: "deferred", reason: "turn-in-flight" } as const;
    expect(receipts.due(deferred)).toBe(true);
    expect(receipts.due(deferred)).toBe(false);
  });

  test("a different reason for the same key is due", () => {
    const receipts = new JoinOfferRevealReceipts();
    receipts.due({ key: "head-a", verdict: "deferred", reason: "turn-in-flight" });
    expect(
      receipts.due({ key: "head-a", verdict: "deferred", reason: "shade-showing" }),
    ).toBe(true);
    expect(receipts.due({ key: "head-a", verdict: "revealed", reason: null })).toBe(true);
  });

  test("the same reason for a new key is due", () => {
    const receipts = new JoinOfferRevealReceipts();
    receipts.due({ key: "head-a", verdict: "deferred", reason: "folded" });
    expect(receipts.due({ key: "head-b", verdict: "deferred", reason: "folded" })).toBe(true);
  });

  test("an already-shown hold is a receipt like the others, once", () => {
    const receipts = new JoinOfferRevealReceipts();
    expect(
      receipts.due({ key: "head-a", verdict: "deferred", reason: "already-shown" }),
    ).toBe(true);
    expect(
      receipts.due({ key: "head-a", verdict: "deferred", reason: "already-shown" }),
    ).toBe(false);
  });
});

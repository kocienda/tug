/**
 * Card Registry unit tests -- Step 1.
 *
 * Tests cover:
 * - T01: registerCard stores a registration and getRegistration retrieves it
 * - T02: getRegistration returns undefined for unregistered component
 * - T03: duplicate registerCard overwrites and logs warning
 * - T04: getAllRegistrations returns all registered entries
 * - T05: _resetForTest clears the registry
 */

import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import {
  registerCard,
  getRegistration,
  getAllRegistrations,
  getStackSizePolicy,
  getFoldedSizePolicy,
  getUnboundSizePolicy,
  DEFAULT_SIZE_POLICY,
  getLayoutRole,
  isSidebarCard,
  getGreedRank,
  getComfortWidth,
  DEFAULT_GREED_RANK,
  _resetForTest,
} from "../card-registry";
import type { CardRegistration, CardSizePolicy } from "../card-registry";

// ---- Helpers ----

function makeRegistration(componentId: string): CardRegistration {
  return {
    componentId,
    contentFactory: () => null,
    defaultMeta: { title: `${componentId} card`, closable: true },
  };
}

/** Register a card type carrying an explicit size policy. */
function registerSized(componentId: string, sizePolicy: CardSizePolicy): void {
  registerCard({ ...makeRegistration(componentId), sizePolicy });
}

/** Register a card type carrying both an open and a folded policy. */
function registerFoldable(
  componentId: string,
  sizePolicy: CardSizePolicy,
  foldedSizePolicy: CardSizePolicy,
): void {
  registerCard({
    ...makeRegistration(componentId),
    sizePolicy,
    foldedSizePolicy,
  });
}

/**
 * The Session card's shape ([P04]): a tall open floor, and a folded policy
 * pinning the height at the tier while leaving the width unbounded.
 */
const TIER = 160;
const OPEN_POLICY: CardSizePolicy = {
  min: { width: 675, height: 600 },
  preferred: { width: 900, height: 1200 },
};
const FOLDED_POLICY: CardSizePolicy = {
  min: { width: 675, height: TIER },
  max: { width: Number.POSITIVE_INFINITY, height: TIER },
  preferred: { width: 900, height: TIER },
};

/**
 * The unbound form ([P06]). A WIDTH and no height: while the card is only its
 * sheet, what it needs across is a fact about the card type, and what it needs
 * down is measured — the opening bid the deck reads off the form before it
 * commits the pane, and then the sheet's own reservation. A height declared
 * here would be a third answer that disagreed with both.
 */
const UNBOUND_WIDTH: { min: number; preferred: number; max?: number } = {
  min: 675,
  preferred: 900,
};

function registerUnboundable(
  componentId: string,
  sizePolicy: CardSizePolicy,
  unboundWidthPolicy: { min: number; preferred: number; max?: number },
  foldedSizePolicy?: CardSizePolicy,
): void {
  registerCard({
    ...makeRegistration(componentId),
    sizePolicy,
    unboundWidthPolicy,
    ...(foldedSizePolicy !== undefined ? { foldedSizePolicy } : {}),
  });
}

beforeEach(() => {
  _resetForTest();
});

// ---- T01: registerCard and getRegistration ----

describe("registerCard and getRegistration", () => {
  it("T01: registerCard stores a registration and getRegistration retrieves it", () => {
    const reg = makeRegistration("hello");
    registerCard(reg);
    const retrieved = getRegistration("hello");
    expect(retrieved).toBe(reg);
  });
});

// ---- T02: getRegistration for unregistered component ----

describe("getRegistration for unregistered", () => {
  it("T02: returns undefined for an unregistered componentId", () => {
    const result = getRegistration("nonexistent");
    expect(result).toBeUndefined();
  });
});

// ---- T03: duplicate registration ----

describe("duplicate registerCard", () => {
  it("T03: overwrites existing registration and logs a warning", () => {
    const spy = spyOn(console, "warn").mockImplementation(() => {});

    const first = makeRegistration("terminal");
    const second = makeRegistration("terminal");
    second.defaultMeta = { title: "Terminal v2", closable: false };

    registerCard(first);
    registerCard(second);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toContain("terminal");

    const retrieved = getRegistration("terminal");
    expect(retrieved).toBe(second);
    expect(retrieved?.defaultMeta.title).toBe("Terminal v2");

    spy.mockRestore();
  });
});

// ---- T04: getAllRegistrations ----

describe("getAllRegistrations", () => {
  it("T04: returns all registered entries", () => {
    const a = makeRegistration("alpha");
    const b = makeRegistration("beta");
    registerCard(a);
    registerCard(b);

    const all = getAllRegistrations();
    expect(all.size).toBe(2);
    expect(all.get("alpha")).toBe(a);
    expect(all.get("beta")).toBe(b);
  });

  it("returns empty map when nothing is registered", () => {
    const all = getAllRegistrations();
    expect(all.size).toBe(0);
  });
});

// ---- T05: _resetForTest ----

describe("_resetForTest", () => {
  it("T05: clears the registry", () => {
    registerCard(makeRegistration("foo"));
    registerCard(makeRegistration("bar"));
    expect(getAllRegistrations().size).toBe(2);

    _resetForTest();
    expect(getAllRegistrations().size).toBe(0);
    expect(getRegistration("foo")).toBeUndefined();
    expect(getRegistration("bar")).toBeUndefined();
  });
});

// ---- Phase 5b3 Step 1: family, acceptsFamilies, defaultCards, defaultTitle fields ----

describe("CardRegistration – family, acceptsFamilies, defaultCards, defaultTitle", () => {
  it("registers a card with family and getRegistration returns it", () => {
    registerCard({
      ...makeRegistration("gallery-buttons"),
      family: "maker",
    });
    const reg = getRegistration("gallery-buttons");
    expect(reg).toBeDefined();
    expect(reg!.family).toBe("maker");
  });

  it("registers a card with acceptsFamilies and getRegistration returns it", () => {
    registerCard({
      ...makeRegistration("gallery-host"),
      acceptsFamilies: ["maker"],
    });
    const reg = getRegistration("gallery-host");
    expect(reg).toBeDefined();
    expect(reg!.acceptsFamilies).toEqual(["maker"]);
  });

  it("registers a card with defaultTitle and getRegistration returns it", () => {
    registerCard({
      ...makeRegistration("component-gallery"),
      defaultTitle: "Component Gallery",
    });
    const reg = getRegistration("component-gallery");
    expect(reg).toBeDefined();
    expect(reg!.defaultTitle).toBe("Component Gallery");
  });

  it("registers a card with defaultCards and getRegistration returns them", () => {
    const defaultCards = [
      { id: "tmpl-1", componentId: "gallery-buttons", title: "Buttons", closable: false },
      { id: "tmpl-2", componentId: "gallery-chain-actions", title: "Chain Actions", closable: false },
    ] as const;
    registerCard({
      ...makeRegistration("gallery-host-cards"),
      defaultCards,
    });
    const reg = getRegistration("gallery-host-cards");
    expect(reg).toBeDefined();
    expect(reg!.defaultCards).toBeDefined();
    expect(reg!.defaultCards!.length).toBe(2);
    expect(reg!.defaultCards![0].componentId).toBe("gallery-buttons");
    expect(reg!.defaultCards![1].componentId).toBe("gallery-chain-actions");
  });

  it("fields are all optional: registration without them is valid", () => {
    registerCard(makeRegistration("plain-card"));
    const reg = getRegistration("plain-card");
    expect(reg).toBeDefined();
    expect(reg!.family).toBeUndefined();
    expect(reg!.acceptsFamilies).toBeUndefined();
    expect(reg!.defaultCards).toBeUndefined();
    expect(reg!.defaultTitle).toBeUndefined();
  });
});

// ---- getStackSizePolicy — pane-level aggregation across a stack ----

describe("getStackSizePolicy", () => {
  it("returns DEFAULT_SIZE_POLICY for an empty stack", () => {
    expect(getStackSizePolicy([])).toEqual(DEFAULT_SIZE_POLICY);
  });

  it("takes the element-wise max of the cards' minimums", () => {
    registerSized("wide", {
      min: { width: 800, height: 240 },
      preferred: { width: 900, height: 600 },
    });
    registerSized("tall", {
      min: { width: 300, height: 700 },
      preferred: { width: 400, height: 800 },
    });
    const policy = getStackSizePolicy(["wide", "tall"]);
    expect(policy.min).toEqual({ width: 800, height: 700 });
  });

  it("takes the element-wise min of the cards' defined maximums", () => {
    registerSized("capped", {
      min: { width: 200, height: 150 },
      max: { width: 1000, height: 900 },
      preferred: { width: 400, height: 300 },
    });
    registerSized("tighter", {
      min: { width: 200, height: 150 },
      max: { width: 700, height: 1200 },
      preferred: { width: 400, height: 300 },
    });
    expect(getStackSizePolicy(["capped", "tighter"]).max).toEqual({
      width: 700,
      height: 900,
    });
  });

  it("omits max when every card in the stack is unbounded", () => {
    registerSized("free-a", {
      min: { width: 200, height: 150 },
      preferred: { width: 400, height: 300 },
    });
    registerSized("free-b", {
      min: { width: 250, height: 180 },
      preferred: { width: 400, height: 300 },
    });
    expect(getStackSizePolicy(["free-a", "free-b"]).max).toBeUndefined();
  });

  it("an unbounded card does not relax a bounded sibling's ceiling", () => {
    registerSized("capped", {
      min: { width: 200, height: 150 },
      max: { width: 1000, height: 900 },
      preferred: { width: 400, height: 300 },
    });
    registerSized("free", {
      min: { width: 200, height: 150 },
      preferred: { width: 400, height: 300 },
    });
    expect(getStackSizePolicy(["capped", "free"]).max).toEqual({
      width: 1000,
      height: 900,
    });
  });

  it("treats an unregistered id as DEFAULT_SIZE_POLICY", () => {
    registerSized("narrow", {
      min: { width: 100, height: 100 },
      preferred: { width: 200, height: 200 },
    });
    // DEFAULT_SIZE_POLICY.min (250 × 180) floors the result.
    expect(getStackSizePolicy(["narrow", "ghost"]).min).toEqual(
      DEFAULT_SIZE_POLICY.min,
    );
  });

  it("floors preferred to the aggregated minimum", () => {
    registerSized("wide-min-small-pref", {
      min: { width: 800, height: 600 },
      preferred: { width: 400, height: 300 },
    });
    expect(getStackSizePolicy(["wide-min-small-pref"]).preferred).toEqual({
      width: 800,
      height: 600,
    });
  });
});

// ---- getStackSizePolicy — the folded form ([P04]) ----

describe("getStackSizePolicy({ folded })", () => {
  it("returns the tier as both the floor and the ceiling on the height axis", () => {
    registerFoldable("session", OPEN_POLICY, FOLDED_POLICY);
    const policy = getStackSizePolicy(["session"], { folded: true });
    expect(policy.min.height).toBe(TIER);
    // `min === max` on the height axis is exactly what `TugPane` reads as
    // `heightPinned` — the whole point of the declaration.
    expect(policy.max?.height).toBe(policy.min.height);
  });

  it("leaves the width unpinned, because a folded card is as wide as its slot", () => {
    registerFoldable("session", OPEN_POLICY, FOLDED_POLICY);
    const policy = getStackSizePolicy(["session"], { folded: true });
    expect(policy.max?.width).toBe(Number.POSITIVE_INFINITY);
    expect(policy.max?.width === policy.min.width).toBe(false);
  });

  it("a height-only bound survives aggregation — the whole pin rests on it", () => {
    // The regression this pins: the old emit gate was `isFinite(maxWidth) &&
    // isFinite(maxHeight)`, which dropped the aggregate `max` ENTIRELY for a
    // policy whose width is unbounded — and `heightPinned` would then be false
    // forever, with nothing failing to say so.
    registerFoldable("session", OPEN_POLICY, FOLDED_POLICY);
    expect(getStackSizePolicy(["session"], { folded: true }).max).toEqual({
      width: Number.POSITIVE_INFINITY,
      height: TIER,
    });
  });

  it("uses the ordinary policy when the option is absent", () => {
    registerFoldable("session", OPEN_POLICY, FOLDED_POLICY);
    expect(getStackSizePolicy(["session"]).min.height).toBe(600);
    expect(getStackSizePolicy(["session"]).max).toBeUndefined();
  });

  it("aggregates a card with no folded policy at its ordinary floor", () => {
    // A pane is one box: a Session tab folded beside a Text tab still has
    // to fit the Text tab, so the tier does not win the aggregation and the
    // pane is not pinned — `min.height` (420) and `max.height` (160) differ.
    registerFoldable("session", OPEN_POLICY, FOLDED_POLICY);
    registerSized("text", {
      min: { width: 300, height: 420 },
      preferred: { width: 400, height: 500 },
    });
    const policy = getStackSizePolicy(["session", "text"], { folded: true });
    expect(policy.min).toEqual({ width: 675, height: 420 });
    expect(policy.max?.height === policy.min.height).toBe(false);
  });
});

// ---- getStackSizePolicy — the unbound form ([P06]) ----

describe("getStackSizePolicy({ unbound })", () => {
  it("contributes NO height floor, and no ceiling on any axis", () => {
    registerUnboundable("session", OPEN_POLICY, UNBOUND_WIDTH);
    const policy = getStackSizePolicy(["session"], { unbound: true });
    // The width is the card type's own; the height is zero, because the deck
    // has two better answers for it — the measured opening bid and the sheet's
    // reservation — and a declared one would only argue with them.
    expect(policy.min.width).toBe(675);
    expect(policy.min.height).toBe(0);
    // A folded card is a band and reads `min === max`; an unbound card is a
    // member that takes more where its column has more to give.
    expect(policy.max).toBeUndefined();
  });

  it("uses the ordinary policy when the option is absent", () => {
    registerUnboundable("session", OPEN_POLICY, UNBOUND_WIDTH);
    expect(getStackSizePolicy(["session"]).min.height).toBe(600);
  });

  it("lets FOLDED win when both forms are named", () => {
    // They are forms of one card rather than independent flags, and a folded
    // card is not showing the sheet its unbound form was declared for — the
    // same precedence `placeMembers`' branch order takes.
    registerUnboundable("session", OPEN_POLICY, UNBOUND_WIDTH, FOLDED_POLICY);
    const policy = getStackSizePolicy(["session"], {
      folded: true,
      unbound: true,
    });
    expect(policy.min.height).toBe(TIER);
    expect(policy.max?.height).toBe(TIER);
  });

  it("aggregates a card with no unbound policy at its ordinary floor", () => {
    // A pane is one box, the folded case's reason exactly: an unbound Session
    // tab beside a Text tab is still a box that has to fit the Text tab, and a
    // Text tab taller than the declaration wins the floor.
    registerUnboundable("session", OPEN_POLICY, UNBOUND_WIDTH);
    registerSized("text", {
      min: { width: 300, height: 700 },
      preferred: { width: 400, height: 800 },
    });
    const policy = getStackSizePolicy(["session", "text"], { unbound: true });
    expect(policy.min).toEqual({ width: 675, height: 700 });
    expect(policy.max).toBeUndefined();
  });
});

// ---- getUnboundSizePolicy — the per-card resolver ----

describe("getUnboundSizePolicy", () => {
  it("composes the declared width with a ZERO height floor", () => {
    registerUnboundable("session", OPEN_POLICY, UNBOUND_WIDTH);
    expect(getUnboundSizePolicy("session")).toEqual({
      min: { width: 675, height: 0 },
      // The preferred height is the ORDINARY policy's, carried over so the
      // result is a well-formed policy rather than one that prefers nothing.
      preferred: { width: 900, height: 1200 },
    });
  });

  it("carries a declared max width through, with an unbounded height", () => {
    registerUnboundable("session", OPEN_POLICY, {
      min: 675,
      preferred: 900,
      max: 1400,
    });
    expect(getUnboundSizePolicy("session").max).toEqual({
      width: 1400,
      height: Infinity,
    });
  });

  it("falls back to the ordinary policy for a card with no unbound form", () => {
    registerSized("text", {
      min: { width: 300, height: 420 },
      preferred: { width: 400, height: 500 },
    });
    expect(getUnboundSizePolicy("text").min).toEqual({
      width: 300,
      height: 420,
    });
  });

  it("falls back to DEFAULT_SIZE_POLICY for an unregistered id", () => {
    expect(getUnboundSizePolicy("ghost")).toEqual(DEFAULT_SIZE_POLICY);
  });
});

// ---- getFoldedSizePolicy — the per-card resolver ----

describe("getFoldedSizePolicy", () => {
  it("returns the declared folded policy", () => {
    registerFoldable("session", OPEN_POLICY, FOLDED_POLICY);
    expect(getFoldedSizePolicy("session")).toEqual(FOLDED_POLICY);
  });

  it("falls back to the ordinary policy for a card with no folded form", () => {
    registerSized("text", {
      min: { width: 300, height: 420 },
      preferred: { width: 400, height: 500 },
    });
    expect(getFoldedSizePolicy("text").min).toEqual({
      width: 300,
      height: 420,
    });
  });

  it("falls back to DEFAULT_SIZE_POLICY for an unregistered id", () => {
    expect(getFoldedSizePolicy("ghost")).toEqual(DEFAULT_SIZE_POLICY);
  });
});

describe("layoutRole", () => {
  it("resolves to content when a registration declares nothing", () => {
    registerCard(makeRegistration("plain"));
    expect(getLayoutRole("plain")).toBe("content");
    expect(isSidebarCard("plain")).toBe(false);
  });

  it("resolves what the registration declares", () => {
    registerCard({ ...makeRegistration("rail"), layoutRole: "sidebar" });
    expect(getLayoutRole("rail")).toBe("sidebar");
    expect(isSidebarCard("rail")).toBe(true);
  });

  it("treats an unregistered componentId as content, not as a sidebar", () => {
    // A card seeded before its registration lands must be arranged, never
    // silently pinned to a deck edge.
    expect(getLayoutRole("never-registered")).toBe("content");
    expect(isSidebarCard("never-registered")).toBe(false);
  });
});

describe("greedRank", () => {
  it("resolves what the registration declares", () => {
    registerCard({ ...makeRegistration("hungry"), greedRank: 1 });
    expect(getGreedRank("hungry")).toBe(1);
  });

  it("resolves to the default when a registration declares nothing", () => {
    registerCard(makeRegistration("indifferent"));
    expect(getGreedRank("indifferent")).toBe(DEFAULT_GREED_RANK);
  });

  it("resolves an unregistered componentId to the default", () => {
    expect(getGreedRank("never-registered")).toBe(DEFAULT_GREED_RANK);
  });

  it("keeps the default the least greedy rank", () => {
    // Every declared rank must be greedier than the fallback, or a card that
    // reasoned about its greed would lose to one that never did.
    expect(DEFAULT_GREED_RANK).toBeGreaterThan(3);
  });
});

describe("comfortWidth", () => {
  it("resolves what the registration declares", () => {
    registerCard({ ...makeRegistration("prose"), comfortWidth: 512 });
    expect(getComfortWidth("prose")).toBe(512);
  });

  it("falls back to the hard floor when a registration declares none", () => {
    // No comfort band means comfort sits ON the hard floor, which makes the
    // allocator's comfort tier empty for that rail — today's behavior exactly.
    registerCard({
      ...makeRegistration("plainrail"),
      sizePolicy: {
        min: { width: 320, height: 100 },
        preferred: { width: 420, height: 400 },
      },
    });
    expect(getComfortWidth("plainrail")).toBe(320);
  });

  it("resolves an unregistered componentId to the default policy's floor", () => {
    expect(getComfortWidth("never-registered")).toBe(
      DEFAULT_SIZE_POLICY.min.width,
    );
  });
});

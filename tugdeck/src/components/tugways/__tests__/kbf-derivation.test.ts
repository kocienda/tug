/**
 * KBF mode — pure-logic tests for the engagement derivation (Spec S01 of
 * `dash/kbf-mode.md`).
 *
 * The mode bit is *derived*, never latched: every read of `kbfEngaged()`
 * recomputes from four inputs — accessibility mode (Class C), the manual ⌥⇥
 * bit, a trapped mode entry on the **active** context (Class A), and the key
 * card's `kbfAtRest` declaration (Class B). That property is the whole reason a
 * sheet closing can never strand the deck in a ringed mode, so it is what these
 * pin: each input in isolation, each combination that matters, and — the two
 * corrections the plan calls out — a **non-trapped** descend scope that must
 * not engage, and a trap on a **background** card that must not either.
 *
 * DOM-free by construction: `FocusManager` runs its in-memory derivation with
 * no document, and the projection is asserted through `computeProjection()`
 * rather than through stamped attributes (which the app-tests cover).
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { FocusManager } from "../focus-manager";
import { ResponderChainManager } from "../responder-chain";
import { getRegistration, registerCard } from "@/card-registry";
import { registerLensCard } from "@/components/lens/lens-register-card";
import { LENS_CARD_ID } from "@/lib/lens-card-id";
import { registerJotsCard } from "@/components/jots/jots-card-registration";
import { JOTS_CARD_ID } from "@/lib/jots-card-id";
import { registerOverviewCard } from "@/components/overview/overview-card-registration";
import { OVERVIEW_CARD_ID } from "@/lib/overview-card-id";
import { registerSettingsCard } from "@/components/tugways/cards/settings-card";
import { registerKeyboardCard } from "@/components/tugways/cards/keyboard-card";
import { registerDevtoolsCard } from "@/components/devtools/devtools-card";
import { registerSessionCard } from "@/components/tugways/cards/session-card-registration";
import { registerTextCard } from "@/components/tugways/cards/text-card-registration";
import { registerFileViewCard } from "@/components/tugways/cards/file-view-card-registration";
import { registerDiffCard } from "@/components/tugways/cards/diff-card";
import { registerHelloWorldCard } from "@/components/tugways/cards/hello-world-card";
import { registerAboutCard } from "@/components/tugways/cards/about-card";
import { registerDeckStore } from "@/lib/deck-store-registry";
import type { IDeckManagerStore } from "@/deck-manager-store";
import type { DeckState } from "@/layout-tree";

/** A card type that declares itself an at-rest KBF surface (Class B). */
const AT_REST_COMPONENT = "kbf-derivation-at-rest";
/** A card type that declares nothing — the mode-OFF-at-rest default. */
const PLAIN_COMPONENT = "kbf-derivation-plain";

const AT_REST_CARD_ID = "card-at-rest";
const PLAIN_CARD_ID = "card-plain";

/**
 * The Class-B lookup goes cardId → componentId through the deck store, so the
 * derivation needs a store that knows these two cards. Only `getSnapshot` is
 * ever reached from this path; the rest of the store surface is irrelevant to
 * the question under test.
 */
function registerCardsAndStore(): void {
  const content = () => null;
  registerCard({
    componentId: AT_REST_COMPONENT,
    contentFactory: content,
    defaultMeta: { title: "At rest" },
    kbfAtRest: true,
    hidden: true,
  });
  registerCard({
    componentId: PLAIN_COMPONENT,
    contentFactory: content,
    defaultMeta: { title: "Plain" },
    hidden: true,
  });
  const snapshot = {
    cards: [
      { id: AT_REST_CARD_ID, componentId: AT_REST_COMPONENT },
      { id: PLAIN_CARD_ID, componentId: PLAIN_COMPONENT },
    ],
  } as unknown as DeckState;
  registerDeckStore({
    getSnapshot: () => snapshot,
  } as unknown as IDeckManagerStore);
}

function setupWithChain(): { fm: FocusManager; chain: ResponderChainManager } {
  const chain = new ResponderChainManager();
  const fm = new FocusManager();
  fm.attach(chain);
  return { fm, chain };
}

function setup(): FocusManager {
  return setupWithChain().fm;
}

beforeEach(() => {
  registerCardsAndStore();
});

afterAll(() => {
  registerDeckStore(null);
});

describe("KBF derivation (Spec S01)", () => {
  test("a fresh deck is disengaged", () => {
    expect(setup().kbfEngaged()).toBe(false);
  });

  test("the manual bit engages and disengages", () => {
    const fm = setup();
    fm.setKbfManual(true);
    expect(fm.kbfEngaged()).toBe(true);
    expect(fm.kbfManual()).toBe(true);
    fm.setKbfManual(false);
    expect(fm.kbfEngaged()).toBe(false);
  });

  test("toggle flips the manual bit", () => {
    const fm = setup();
    fm.toggleKbfManual();
    expect(fm.kbfEngaged()).toBe(true);
    fm.toggleKbfManual();
    expect(fm.kbfEngaged()).toBe(false);
  });

  test("a trapped mode engages while pushed and disengages on pop", () => {
    const fm = setup();
    fm.pushFocusMode("sheet", { trapped: true });
    expect(fm.kbfEngaged()).toBe(true);
    fm.popFocusMode("sheet");
    expect(fm.kbfEngaged()).toBe(false);
  });

  test("a trapped mode with `kbf: false` never engages", () => {
    const fm = setup();
    fm.pushFocusMode("open-quickly", { trapped: true, kbf: false });
    expect(fm.kbfEngaged()).toBe(false);
  });

  test("a NON-trapped descend scope does not engage", () => {
    const fm = setup();
    fm.pushFocusMode("row-scope", { trapped: false });
    expect(fm.kbfEngaged()).toBe(false);
  });

  test("an engaging trap above a descend scope still engages", () => {
    const fm = setup();
    fm.pushFocusMode("row-scope", { trapped: false });
    fm.pushFocusMode("popover", { trapped: true });
    expect(fm.kbfEngaged()).toBe(true);
    fm.popFocusMode("popover");
    expect(fm.kbfEngaged()).toBe(false);
  });

  test("a trap on a BACKGROUND card does not engage the deck", () => {
    const fm = setup();
    fm.setKeyCard(PLAIN_CARD_ID);
    fm.contextFor("some-other-card").pushFocusMode("bg-sheet", {
      trapped: true,
    });
    expect(fm.kbfEngaged()).toBe(false);
    // …and it engages the moment that card becomes the key card.
    fm.setKeyCard("some-other-card");
    expect(fm.kbfEngaged()).toBe(true);
  });

  test("accessibility mode is permanently engaged (Class C)", () => {
    const fm = setup();
    fm.setKeyboardAccessMode("accessibility");
    expect(fm.kbfEngaged()).toBe(true);
    // Nothing else can turn it off.
    fm.setKbfManual(false);
    expect(fm.kbfEngaged()).toBe(true);
    fm.setKeyboardAccessMode("standard");
    expect(fm.kbfEngaged()).toBe(false);
  });

  test("a `kbfAtRest` key card engages; a plain one does not (Class B)", () => {
    const fm = setup();
    fm.setKeyCard(PLAIN_CARD_ID);
    expect(fm.kbfEngaged()).toBe(false);
    fm.setKeyCard(AT_REST_CARD_ID);
    expect(fm.kbfEngaged()).toBe(true);
    fm.setKeyCard(PLAIN_CARD_ID);
    expect(fm.kbfEngaged()).toBe(false);
  });

  test("an unregistered key card resolves to disengaged", () => {
    const fm = setup();
    fm.setKeyCard("card-nobody-registered");
    expect(fm.kbfEngaged()).toBe(false);
  });

  test("the manual bit survives a key-card change ([P05])", () => {
    const fm = setup();
    fm.setKbfManual(true);
    fm.setKeyCard(PLAIN_CARD_ID);
    expect(fm.kbfEngaged()).toBe(true);
    expect(fm.kbfManual()).toBe(true);
  });
});

describe("The ⌥⇥ gesture (Spec S04)", () => {
  test("with the ring live, ⌥⇥ flips the bit", () => {
    const fm = setup();
    expect(fm.toggleKbfManual()).toBe(true);
    expect(fm.kbfEngaged()).toBe(true);
    expect(fm.toggleKbfManual()).toBe(false);
    expect(fm.kbfEngaged()).toBe(false);
  });

  test("with a live caret, ⌥⇥ engages rather than toggling ([P09])", () => {
    const { fm, chain } = setupWithChain();
    chain.register({ id: "editor", parentId: null, actions: {}, focus: () => {} });
    fm.place(null, { kind: "responder", responderId: "editor" });
    expect(fm.keyboardRoute()).toBe("dom-granted");
    // A caret never toggles the mode OFF: the press is a request to return to
    // the ring, so the bit goes up whatever it was.
    expect(fm.toggleKbfManual()).toBe(true);
    // And the gesture PARKS the stop it landed on, which is what makes the ring
    // appear where the keyboard already is. The park moves the route, so the
    // caret is gone — and the second press is therefore the ordinary toggle's
    // other half, not the same request again. Without the park the route would
    // stay granted and every later press would be forced back to `true`: a bit
    // that can never come down, wearing a ring that never appears.
    expect(fm.keyboardRoute()).toBe("engine-routed");
    expect(fm.toggleKbfManual()).toBe(false);
  });

  test("inside a forced mode, ⌥⇥ never turns the mode off ([P09])", () => {
    const fm = setup();
    fm.pushFocusMode("sheet", { trapped: true });
    fm.toggleKbfManual();
    fm.toggleKbfManual();
    // The manual bit may be either way; the DERIVED mode stays on, because the
    // surface forces it.
    expect(fm.kbfEngaged()).toBe(true);
  });
});

describe("The pointer exit ([P05])", () => {
  test("a pointerdown clears the manual bit and pops a live cycle", () => {
    const fm = setup();
    fm.setKbfManual(true);
    fm.pushFocusMode("cycle", { trapped: true, escapeExits: true });
    fm.clearKbfManualForPointer();
    expect(fm.kbfManual()).toBe(false);
    expect(fm.kbfEngaged()).toBe(false);
    expect(fm.isFocusModePushed("cycle")).toBe(false);
    expect(fm.kbfClearedByPointer()).toBe(true);
  });

  test("a pointerdown leaves a SHEET over the cycle alone", () => {
    const fm = setup();
    fm.setKbfManual(true);
    fm.pushFocusMode("cycle", { trapped: true, escapeExits: true });
    fm.pushFocusMode("sheet", { trapped: true });
    fm.clearKbfManualForPointer();
    // The sheet owns its own close; only the manual bit drops. The mode stays
    // engaged because the sheet is still a Class-A trap.
    expect(fm.isFocusModePushed("sheet")).toBe(true);
    expect(fm.isFocusModePushed("cycle")).toBe(true);
    expect(fm.kbfEngaged()).toBe(true);
  });

  test("a keyboard clear does not read as a pointer exit", () => {
    const fm = setup();
    fm.setKbfManual(true);
    fm.setKbfManual(false);
    expect(fm.kbfClearedByPointer()).toBe(false);
  });
});

describe("Class-B declarations on the real registrations ([P10])", () => {
  // The shipped registrations, not fixtures: the dispositions are the decision
  // this step made, so they are pinned against the cards themselves.
  test("the navigation and utility cards declare `kbfAtRest`", () => {
    registerLensCard();
    registerJotsCard();
    registerSettingsCard();
    registerKeyboardCard();
    registerOverviewCard();
    registerDevtoolsCard();
    for (const componentId of [
      LENS_CARD_ID,
      JOTS_CARD_ID,
      "settings",
      "keyboard",
      OVERVIEW_CARD_ID,
      "devtools",
    ]) {
      expect(getRegistration(componentId)?.kbfAtRest).toBe(true);
    }
  });

  test("the text-first and stop-less cards do not", () => {
    registerSessionCard();
    registerTextCard();
    registerFileViewCard();
    registerDiffCard();
    registerHelloWorldCard();
    registerAboutCard();
    for (const componentId of [
      "session",
      "text",
      "file-view",
      // The diff card registers no focus stops, and About is static text —
      // the empty-group check keeps both OFF: a mode pointing at no ring.
      "diff",
      "hello",
      "about",
    ]) {
      expect(getRegistration(componentId)?.kbfAtRest).toBeUndefined();
    }
  });
});

describe("The park predicate (Spec S05, [P12])", () => {
  /** A manager whose sole target is a contract-bearing text responder. */
  function withTextStop(): { fm: FocusManager; chain: ResponderChainManager } {
    const { fm, chain } = setupWithChain();
    chain.register({ id: "editor", parentId: null, actions: {}, focus: () => {} });
    return { fm, chain };
  }

  const TEXT = { kind: "responder", responderId: "editor" } as const;

  test("mode OFF: a text stop grants however it was reached", () => {
    const { fm } = withTextStop();
    fm.place(null, TEXT, { arrival: "movement" });
    expect(fm.keyboardRoute()).toBe("dom-granted");
  });

  test("mode ON + MOVEMENT: the text stop parks", () => {
    const { fm } = withTextStop();
    fm.setKbfManual(true);
    fm.place(null, TEXT, { arrival: "movement" });
    expect(fm.keyboardRoute()).toBe("engine-routed");
  });

  test("mode ON + PLACEMENT: a seeded text stop grants (the seed rule)", () => {
    const { fm } = withTextStop();
    fm.setKbfManual(true);
    // No `arrival` at all is the default — every seed, restore, and pointer
    // placement takes this path, which is why a text-first sheet opens with a
    // caret even though it auto-engages.
    fm.place(null, TEXT);
    expect(fm.keyboardRoute()).toBe("dom-granted");
    fm.place(null, TEXT, { arrival: "placement" });
    expect(fm.keyboardRoute()).toBe("dom-granted");
  });

  test("accessibility mode never parks (Class C carve-out)", () => {
    const { fm } = withTextStop();
    fm.setKeyboardAccessMode("accessibility");
    fm.place(null, TEXT, { arrival: "movement" });
    expect(fm.kbfEngaged()).toBe(true);
    expect(fm.keyboardRoute()).toBe("dom-granted");
  });

  test("a NON-text stop is unaffected by the predicate", () => {
    const { fm, chain } = setupWithChain();
    chain.register({ id: "panel", parentId: null, actions: {} });
    fm.setKbfManual(true);
    fm.place(null, { kind: "responder", responderId: "panel" }, {
      arrival: "movement",
    });
    // Engine-routed either way — it has no caret to withhold.
    expect(fm.keyboardRoute()).toBe("engine-routed");
  });

  test("a grant un-parks: the arrival flips and the route re-derives", () => {
    const { fm } = withTextStop();
    fm.setKbfManual(true);
    fm.place(null, TEXT, { arrival: "movement" });
    expect(fm.keyboardRoute()).toBe("engine-routed");
    fm.grantParkedTextStop();
    expect(fm.keyboardRoute()).toBe("dom-granted");
    // Idempotent: a second grant has nothing left to un-park.
    expect(fm.grantParkedTextStop()).toBe(false);
    expect(fm.keyboardRoute()).toBe("dom-granted");
  });

  test("toggling the mode re-derives a stale route rather than leaving it", () => {
    const { fm } = withTextStop();
    fm.setKbfManual(true);
    fm.place(null, TEXT, { arrival: "movement" });
    expect(fm.keyboardRoute()).toBe("engine-routed");
    // Disengaging must not leave the keyboard routed by the old mode's answer:
    // the route is a CACHE, and the settle re-realizes it (Spec S05).
    fm.setKbfManual(false);
    expect(fm.keyboardRoute()).toBe("dom-granted");
  });
});

describe("KBF projection (Spec S03)", () => {
  test("`computeProjection().kbf` tracks the derivation", () => {
    const fm = setup();
    expect(fm.computeProjection().kbf).toBe(false);
    fm.setKbfManual(true);
    expect(fm.computeProjection().kbf).toBe(true);
    fm.setKbfManual(false);
    fm.pushFocusMode("sheet", { trapped: true });
    expect(fm.computeProjection().kbf).toBe(true);
  });
});

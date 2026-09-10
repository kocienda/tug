/**
 * at0040-multi-tab-close-confirm.test.ts — title-bar X close
 * confirmation, a pane-level feature applied uniformly to every pane.
 *
 * ## Behavior matrix
 *
 *   1. **Plain click, single-tab.** Click X → "Close Card?" popover
 *      opens and STAYS open until the user confirms or cancels.
 *      Confirm ("Close") closes the pane; cancel keeps it.
 *   2. **Plain click, multi-tab.** Click X → "Close N Tabs?" popover
 *      opens and STAYS open. Confirm ("Close All") closes the entire
 *      pane; cancel keeps it.
 *   3. **Option-click.** Option(alt)-click X → the pane closes
 *      immediately, no popover. The power-user escape hatch, single-
 *      and multi-tab alike.
 *   4. **Inactive pane.** Click X on a background pane → the pane
 *      comes forward (activates) AND the confirm popover opens. The
 *      user needs to see what they are about to discard. Holds for
 *      single-tab and multi-tab background panes alike — the X
 *      button carries no `data-no-activate`.
 *   5. **Half out of the band.** An ALREADY-ACTIVE pane straddling the
 *      band's near edge is brought whole into view BEFORE the popover
 *      opens. The question is asked on the card it is about: a popover
 *      hung off a title bar that is itself half off the band can be
 *      clipped by that edge, and the reader is being asked to discard
 *      something they can only half see. Case 4 is why the fixture's
 *      pane must already be active — an inactive pane's X activates it,
 *      and activation has always committed a reveal of its own, so only
 *      an active pane isolates the close's own reveal.
 *   6. **A sidebar card asks.** A rail card confirms whatever its
 *      registration says about `confirmClose`. A rail is a singleton the
 *      deck keeps one of, its X sits on a bar the reader is already
 *      pointing at for the resize edge and the stack badge, and nothing
 *      visible remains afterwards to say what went. The policy is the
 *      pane's, not an opt-in each rail card repeats.
 *
 * Case 2 also gates the "popover-flash" regression that motivated
 * the original pass: if `Popover.Trigger`'s auto-toggle ever ends up
 * composed onto the X button again, the popover briefly opens and
 * immediately closes via the toggle inverting the just-opened state
 * on the trailing `click` event. Any future change that reintroduces
 * a Trigger on the X button would fail this test on the
 * "popover still present 300ms after click" assertion.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/card-close-guard.ts
 * @covers tugdeck/src/components/tugways/tug-confirm-popover.tsx
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/deck-manager.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import type { App } from "./_harness";
import {
  IMPOSITION_GAP_PX,
  RAIL_GUTTER_PX,
} from "../../tugdeck/src/lib/layout-imposer";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 60_000;

// The pane-close confirmation is the shared `TugConfirmPopover` component
// (data-slot "tug-confirm-popover"); on these close-confirm routes it is the
// only confirm popover present.
const CONFIRM_POPOVER_SELECTOR = "[data-slot=\"tug-confirm-popover\"]";

function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) =>
    (
      globalThis as unknown as {
        setTimeout: (fn: () => void, ms: number) => unknown;
      }
    ).setTimeout(() => resolve(), ms),
  );
}

function paneCloseButtonSelector(paneId: string): string {
  return `.tug-pane[data-pane-id="${paneId}"] [data-testid="tug-pane-close-button"]`;
}

function popoverButtonByText(label: string): string {
  return `(function(){
    var root = document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)});
    if (root === null) return null;
    var btns = root.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].textContent && btns[i].textContent.trim() === ${JSON.stringify(label)}) {
        return btns[i];
      }
    }
    return null;
  })()`;
}

/**
 * Option(alt)-click an element. `holdModifier` buffers native verbs
 * into one atomic RPC with the modifier held; `evalJS` is not allowed
 * inside that scope, so the element's viewport-center point is
 * resolved beforehand.
 */
async function optionClickElement(app: App, selector: string): Promise<void> {
  const point = await app.evalJS<{ x: number; y: number }>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) throw new Error("[at0040] option-click target missing: " + ${JSON.stringify(selector)});
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
  );
  await app.holdModifier(["alt"], async (inner) => {
    await inner.rpcCall<void>("nativeClick", { viewportPoint: point });
  });
}

/** Two cards in a single pane → multi-tab pane. */
function multiTabActiveDeckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-input" as const, title: "TugInput", closable: true },
      { id: "B", componentId: "gallery-textarea" as const, title: "TugTextarea", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 600, height: 540 },
        cardIds: ["A", "B"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"] as const,
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/**
 * Two panes: p1 (multi-tab, contains M+N cards) and p2 (active,
 * single card). p2 is active so p1 starts inactive — this is the
 * setup case 4 needs.
 */
function inactiveMultiTabDeckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-input" as const, title: "TugInput", closable: true },
      { id: "B", componentId: "gallery-textarea" as const, title: "TugTextarea", closable: true },
      { id: "C", componentId: "gallery-input" as const, title: "Other", closable: true },
    ],
    panes: [
      {
        id: "p1",
        // Background pane (inactive) with two tabs.
        position: { x: 40, y: 40 },
        size: { width: 600, height: 540 },
        cardIds: ["A", "B"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"] as const,
      },
      {
        id: "p2",
        // Foreground pane (active) with one tab. Its existence
        // makes p1 the inactive pane.
        position: { x: 700, y: 40 },
        size: { width: 460, height: 540 },
        cardIds: ["C"],
        activeCardId: "C",
        title: "",
        acceptsFamilies: ["maker"] as const,
      },
    ],
    activePaneId: "p2",
    hasFocus: true,
  };
}

/** Inactive single-tab variant — case 4, single-tab cell. */
function inactiveSingleTabDeckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-input" as const, title: "TugInput", closable: true },
      { id: "C", componentId: "gallery-input" as const, title: "Other", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 460, height: 540 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"] as const,
      },
      {
        id: "p2",
        position: { x: 540, y: 40 },
        size: { width: 460, height: 540 },
        cardIds: ["C"],
        activeCardId: "C",
        title: "",
        acceptsFamilies: ["maker"] as const,
      },
    ],
    activePaneId: "p2",
    hasFocus: true,
  };
}

/** The width the Layout rail is seeded at, and what `band()` subtracts. */
const RAIL_WIDTH = 420;
/** Wide enough that five of them overrun any band this harness opens. */
const FLOW_PANE_WIDTH = 700;
/** How far the wheel pans the strip — half a pane, so the target straddles
 *  the band's near edge with its title bar's trailing end still in the clear. */
const PAN_PX = 350;
/** The wheel gesture commits after an idle window (`FLOW_WHEEL_IDLE_MS` = 180);
 *  this clears it, and the reveal's settle, with room. */
const AFTER_SETTLE_MS = 900;
/** Frames are measured in device pixels; a rounded pin is within a pixel. */
const TOL = 2;

/** Active single-tab variant — case 1. */
function activeSingleTabDeckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-input" as const, title: "TugInput", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 460, height: 540 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"] as const,
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/**
 * Case 5's deck: five imposed panes in a flow strip, plus the Layout card
 * pinned right.
 *
 * `p1` holds two cards, so it confirms on close unconditionally, and it is the
 * ACTIVE pane — the reveal under test has to be the close's own rather than an
 * activation's (see case 4).
 */
function flowDeckShape() {
  const pane = (id: string, slot: number, cardIds: string[]) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: FLOW_PANE_WIDTH, height: 400 },
    cardIds,
    activeCardId: cardIds[0],
    title: "",
    acceptsFamilies: ["maker"] as const,
    slot,
  });
  return {
    cards: [
      { id: "A", componentId: "gallery-input" as const, title: "TugInput", closable: true },
      { id: "B", componentId: "gallery-textarea" as const, title: "TugTextarea", closable: true },
      { id: "C", componentId: "hello" as const, title: "Card C", closable: true },
      { id: "D", componentId: "hello" as const, title: "Card D", closable: true },
      { id: "E", componentId: "hello" as const, title: "Card E", closable: true },
      { id: "F", componentId: "hello" as const, title: "Card F", closable: true },
      { id: "L", componentId: "layout" as const, title: "Layout", closable: true },
    ],
    panes: [
      pane("p1", 0, ["A", "B"]),
      pane("p2", 1, ["C"]),
      pane("p3", 2, ["D"]),
      pane("p4", 3, ["E"]),
      pane("p5", 4, ["F"]),
      railPane(),
    ],
    activePaneId: "p1",
    imposition: FLOW_SIX_UP,
    hasFocus: true,
  };
}

/** Case 6's deck: one content pane, and the Layout card in its rail. */
function railDeckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-input" as const, title: "TugInput", closable: true },
      { id: "L", componentId: "layout" as const, title: "Layout", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 460, height: 540 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"] as const,
        slot: 0,
      },
      railPane(),
    ],
    activePaneId: "p1",
    imposition: FLOW_SIX_UP,
    hasFocus: true,
  };
}

const FLOW_SIX_UP = {
  kind: "six-up",
  layout: "flow",
  sidebars: { layout: { side: "right" } },
} as const;

function railPane() {
  return {
    id: "pRail",
    position: { x: 0, y: 0 },
    size: { width: RAIL_WIDTH, height: 900 },
    cardIds: ["L"],
    activeCardId: "L",
    title: "Layout",
    acceptsFamilies: [] as const,
  };
}

/**
 * The band's edges in viewport coordinates — the arithmetic `resolveSpan`
 * does, read from the pixels the deck actually drew: one card gap in from the
 * canvas edge, and one rail gutter short of the rail's near edge.
 *
 * Measured off the rail's painted frame rather than off the
 * `--tug-imposer-inset-*` properties, which resolve to a `calc()` that
 * `parseFloat` answers NaN for. at0454's helper, for at0454's reason.
 */
function band(app: App): Promise<{ left: number; right: number }> {
  return app.evalJS<{ left: number; right: number }>(
    `(function () {
      var box = document
        .querySelector("[data-deck-canvas-background]")
        .getBoundingClientRect();
      var rail = document
        .querySelector('.tug-pane[data-pane-id="pRail"]')
        .getBoundingClientRect();
      return {
        left: box.left + ${IMPOSITION_GAP_PX},
        right: rail.left - ${RAIL_GUTTER_PX},
      };
    })()`,
  );
}

function paneRect(
  app: App,
  paneId: string,
): Promise<{ left: number; right: number }> {
  return app.evalJS<{ left: number; right: number }>(
    `(function () {
      var box = document
        .querySelector('.tug-pane[data-pane-id="${paneId}"]')
        .getBoundingClientRect();
      return { left: box.left, right: box.right };
    })()`,
  );
}

/**
 * Pan the flow strip by `deltaX` through the deck's own wheel handler — the
 * gesture a trackpad sends, so the offset that lands is one the product
 * clamped and committed rather than one this test wrote into the store.
 *
 * The listener is on the canvas container, which is the element carrying
 * `data-deck-canvas-background` itself rather than a child of it.
 */
async function panBand(app: App, deltaX: number): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var el = document.querySelector("[data-deck-canvas-background]");
      el.dispatchEvent(new WheelEvent("wheel", {
        deltaX: ${deltaX},
        deltaY: 0,
        bubbles: true,
        cancelable: true,
      }));
      return null;
    })()`,
  );
  await pause(AFTER_SETTLE_MS);
}

describe.skipIf(!SHOULD_RUN)(
  "at0040: title-bar X close confirmation — a uniform pane feature",
  () => {
    test(
      "case 1 — single-tab non-opt-in: plain X click closes immediately, no confirm",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c1-single-immediate" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: activeSingleTabDeckShape(),
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );

          await app.nativeClickAtElement(paneCloseButtonSelector("p1"));

          // Per-card policy: a single-tab pane confirms on close ONLY when its card
          // type opts in (`confirmClose: true`, e.g. the Session card). `gallery-input`
          // does not, so a plain X click closes the pane immediately — no popover.
          // (Multi-tab panes always confirm — see case 2.)
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-pane-id="p1"]') === null`,
            { timeoutMs: 2000 },
          );
          const popoverPresent = await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)}) !== null`,
          );
          expect(
            popoverPresent,
            "no confirm popover should render for a non-opt-in single-tab pane",
          ).toBe(false);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "case 2 — multi-tab: X opens 'Close 2 Tabs?' popover and the popover STAYS open",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c2-multi-open" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: multiTabActiveDeckShape(),
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
          );

          await app.nativeClickAtElement(paneCloseButtonSelector("p1"));

          // The flash bug closed the popover within 1–2 frames.
          // Sleep past that window to gate that the popover holds.
          await pause(300);

          const popoverState = await app.evalJS<{ present: boolean; text: string | null }>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)});
              if (el === null) return { present: false, text: null };
              return { present: true, text: el.textContent };
            })()`,
          );
          expect(
            popoverState.present,
            "confirm popover must still be in the DOM 300ms after the X click",
          ).toBe(true);
          expect(
            popoverState.text ?? "",
            "popover prompt must read 'Close 2 Tabs?'",
          ).toContain("Close 2 Tabs?");

          // Pane must still exist — confirm wasn't pressed.
          const paneStillExists = await app.evalJS<boolean>(
            `document.querySelector('[data-pane-id="p1"]') !== null`,
          );
          expect(paneStillExists, "pane must still exist while popover is open").toBe(true);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "case 2 — multi-tab: confirming 'Close All' closes the entire pane",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c2-multi-confirm" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: multiTabActiveDeckShape(),
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
          );

          await app.nativeClickAtElement(paneCloseButtonSelector("p1"));
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)}) !== null`,
            { timeoutMs: 2000 },
          );

          // Click the Close All button by text.
          await app.evalJS<void>(
            `(function(){
              var btn = ${popoverButtonByText("Close All")};
              if (btn === null) throw new Error("[at0040] Close All button missing");
              btn.click();
            })()`,
          );

          await app.waitForCondition<boolean>(
            `document.querySelector('[data-pane-id="p1"]') === null`,
            { timeoutMs: 2000 },
          );
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "case 3 — Option-click on X closes a single-tab pane immediately, no popover",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c3-option-single" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: activeSingleTabDeckShape(),
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );

          await optionClickElement(app, paneCloseButtonSelector("p1"));
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-pane-id="p1"]') === null`,
            { timeoutMs: 2000 },
          );

          // No popover ever rendered — Option-click bypasses it.
          const popoverPresent = await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)}) !== null`,
          );
          expect(
            popoverPresent,
            "no confirm popover should render for an Option-click close",
          ).toBe(false);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "case 3 — Option-click on X closes a multi-tab pane immediately, no popover",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c3-option-multi" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: multiTabActiveDeckShape(),
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B")`,
          );

          await optionClickElement(app, paneCloseButtonSelector("p1"));
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-pane-id="p1"]') === null`,
            { timeoutMs: 2000 },
          );

          const popoverPresent = await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)}) !== null`,
          );
          expect(
            popoverPresent,
            "no confirm popover should render for an Option-click close",
          ).toBe(false);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "case 4 — inactive single-tab non-opt-in: X click closes the pane, no confirm",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c4-inactive-single" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: inactiveSingleTabDeckShape(),
            focusCardId: "C",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("C")`,
          );

          // Sanity: C is the active card (foreground pane); p1 (A) is inactive.
          const activeBefore = await app.evalJS<string | null>(
            `window.__tug.getActiveCardId()`,
          );
          expect(activeBefore, "C must be active before the click").toBe("C");

          await app.nativeClickAtElement(paneCloseButtonSelector("p1"));

          // Per-card policy: `gallery-input` does not opt into confirm, so even an
          // inactive single-tab pane closes immediately on the X click — no popover.
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-pane-id="p1"]') === null`,
            { timeoutMs: 2000 },
          );
          const popoverPresent = await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)}) !== null`,
          );
          expect(
            popoverPresent,
            "no confirm popover should render for a non-opt-in single-tab pane",
          ).toBe(false);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "case 4 — inactive multi-tab: X activates the pane AND opens the confirm popover",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c4-inactive-multi" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({
            state: inactiveMultiTabDeckShape(),
            focusCardId: "C",
          });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A") && window.__tug.assertHostRootRegistered("B") && window.__tug.assertHostRootRegistered("C")`,
          );

          // Sanity: C is the active card; p1 (containing A+B) is
          // the background pane.
          const activeBefore = await app.evalJS<string | null>(
            `window.__tug.getActiveCardId()`,
          );
          expect(activeBefore, "C must be active before the click").toBe("C");

          await app.nativeClickAtElement(paneCloseButtonSelector("p1"));
          await pause(300);

          // After the click, p1's active card (A) must be the new
          // first responder — clicking X on an inactive pane brings
          // the pane forward.
          const activeAfter = await app.evalJS<string | null>(
            `window.__tug.getActiveCardId()`,
          );
          expect(
            activeAfter,
            "case 4: A must be active — clicking X on an inactive pane must bring it forward",
          ).toBe("A");

          // And the popover must be open with the right prompt.
          const popoverState = await app.evalJS<{ present: boolean; text: string | null }>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)});
              if (el === null) return { present: false, text: null };
              return { present: true, text: el.textContent };
            })()`,
          );
          expect(popoverState.present, "popover must be open").toBe(true);
          expect(popoverState.text ?? "", "popover must read 'Close 2 Tabs?'").toContain(
            "Close 2 Tabs?",
          );
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "case 5 — an active pane half out of the band is brought whole in before the confirm opens",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c5-reveal-before-confirm" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: flowDeckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await pause(AFTER_SETTLE_MS);

          // ── The fixture earns its assertion ─────────────────────────────
          const bandBox = await band(app);
          await panBand(app, PAN_PX);
          const before = await paneRect(app, "p1");
          const offsetBefore = await app.evalJS<number>(
            `window.tugdeck.diag.getDeckState().flowOffset || 0`,
          );
          note(
            `[at0040] band [${bandBox.left.toFixed(1)}, ${bandBox.right.toFixed(1)}]; ` +
              `p1 before [${before.left.toFixed(1)}, ${before.right.toFixed(1)}]; ` +
              `flowOffset ${offsetBefore}`,
          );
          expect(
            before.left,
            "fixture: p1 must straddle the band's near edge before the click",
          ).toBeLessThan(bandBox.left - TOL);
          expect(
            before.right,
            "fixture: p1's trailing edge — and its X — must still be inside the band",
          ).toBeGreaterThan(bandBox.left + TOL);
          const activeBefore = await app.evalJS<string | undefined>(
            `window.tugdeck.diag.getDeckState().activePaneId`,
          );
          expect(
            activeBefore,
            "fixture: p1 must already be active, so no activation reveal can run",
          ).toBe("p1");

          // ── The gesture ─────────────────────────────────────────────────
          await app.nativeClickAtElement(paneCloseButtonSelector("p1"));

          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)}) !== null`,
            { timeoutMs: 5000 },
          );

          const after = await paneRect(app, "p1");
          note(`[at0040] p1 after [${after.left.toFixed(1)}, ${after.right.toFixed(1)}]`);
          expect(
            after.left,
            "p1's near edge must be inside the band by the time the question is asked",
          ).toBeGreaterThanOrEqual(bandBox.left - TOL);
          expect(
            after.right,
            "p1's far edge must be inside the band too — revealed WHOLE, not nudged",
          ).toBeLessThanOrEqual(bandBox.right + TOL);

          // The popover is what the travel was for, so it has to be readable.
          const popover = await app.evalJS<{
            left: number;
            width: number;
            text: string;
          }>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)});
              var b = el.getBoundingClientRect();
              return { left: b.left, width: b.width, text: el.textContent || "" };
            })()`,
          );
          expect(popover.text, "the question is the pane's own").toContain(
            "Close 2 Tabs?",
          );
          expect(
            popover.left,
            "the popover must not be clipped by the window's near edge",
          ).toBeGreaterThanOrEqual(0);
          expect(popover.width, "the popover must have been laid out").toBeGreaterThan(0);

          const paneStillThere = await app.evalJS<boolean>(
            `document.querySelector('.tug-pane[data-pane-id="p1"]') !== null`,
          );
          expect(
            paneStillThere,
            "the pane must survive an unanswered question",
          ).toBe(true);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "case 6 — a sidebar card's X asks first, and closes only on the answer",
      async () => {
        const app = await launchTugApp({ testName: "at0040-c6-sidebar-confirm" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: railDeckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelector('.tug-pane[data-pane-id="pRail"]') !== null`,
            { timeoutMs: 8000 },
          );

          await app.nativeClickAtElement(paneCloseButtonSelector("pRail"));

          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)}) !== null`,
            { timeoutMs: 5000 },
          );
          const text = await app.evalJS<string>(
            `document.querySelector(${JSON.stringify(CONFIRM_POPOVER_SELECTOR)}).textContent || ""`,
          );
          expect(text, "a rail card asks the single-card question").toContain(
            "Close Card?",
          );
          const railStanding = await app.evalJS<boolean>(
            `document.querySelector('.tug-pane[data-pane-id="pRail"]') !== null`,
          );
          expect(
            railStanding,
            "the rail must still stand while the question is unanswered",
          ).toBe(true);

          await app.evalJS<null>(
            `(function(){
              var btn = ${popoverButtonByText("Close")};
              if (btn === null) throw new Error("[at0040] Close button missing");
              btn.click();
              return null;
            })()`,
          );

          await app.waitForCondition<boolean>(
            `document.querySelector('.tug-pane[data-pane-id="pRail"]') === null`,
            { timeoutMs: 5000 },
          );
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

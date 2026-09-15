/**
 * at0268-focus-projection.test.ts — the focus DOM marks are a projection of
 * engine state, not a residue of the transitions that produced them ([AT0268]).
 *
 * ## Why this exists
 *
 * The engine's DOM marks (`data-key-view`, `data-key-view-kbd`,
 * `data-key-within`, `data-focus-mode`, `data-default-ring`) used to be written
 * by four per-mark sync methods, each running on the transitions it happened to
 * observe, and each opening with a document-wide "clear everything, then stamp."
 * That made a transient key-card change destructive: `setKeyCard(A → null)`
 * activated the empty default context, whose projection wiped A's marks
 * globally and stamped nothing, and only another `setKeyCard(A)` restamped
 * them. Engine state said "this is the key view"; the DOM said nothing was.
 *
 * The marks are now derived by ONE computation over engine state
 * (`computeProjection`) and applied by ONE pass (`reproject`), diff-then-write.
 * Because the derivation reads state rather than the transition, the round trip
 * cannot lose anything: whatever the marks were before a key-card change, they
 * are again after it returns.
 *
 * This is the live repro. The record-level half of the property (round-trip
 * identity of the derivation itself, with no DOM) is pinned in
 * `tugdeck/src/components/tugways/__tests__/focus-projection.test.ts`; this file
 * pins that the DOM actually converges to it in the real app.
 *
 * ## What this pins
 *
 *   1. **Marks land.** Tab into the accordion: the key view is marked on it,
 *      keyboard-reached, and the engine agrees (`data-key-view` names the id
 *      the engine reports).
 *   2. **A descend adds the within mark and a focus mode**, and ascending
 *      removes both — the marks track the mode stack, not a stored copy.
 *   3. **A key-card round trip is lossless.** Snapshot every mark, deselect to
 *      the canvas background (key card → null), reactivate the card, and the
 *      snapshot must match exactly. This is the seam the rework closes.
 *   4. **Reprojection is idempotent.** Nothing about the marks changes when the
 *      engine is asked to project a second time from the same state.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/components/tugways/cards/gallery-accordion.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import { keyboardIsInCard } from "./_harness/selectors";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const TITLE = `${CARD} [data-testid="accordion-focus-title"]`;
const DEMO = `${CARD} [data-testid="accordion-focus-demo"]`;
const PANE = '.tug-pane[data-pane-id="p1"]';

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Accordion", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 560, height: 500 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/**
 * Every engine mark in the document, as ids rather than element handles — the
 * comparable form. `keyViewId` is read back off the DOM (not off the engine) on
 * purpose: this test is about whether the DOM matches the engine, so reading
 * both sides from the engine would assert nothing.
 */
interface MarkSnapshot {
  keyViewId: string | null;
  keyViewKbd: boolean;
  keyWithinCount: number;
  keyWithinIsWithinCard: boolean;
  focusMode: string | null;
  defaultRingCount: number;
  /** Guards against a mark stamped on two elements at once. */
  keyViewCount: number;
}

const MARK_SNAPSHOT = `(function(){
  var kv = document.querySelectorAll('[data-key-view]');
  var kw = document.querySelector('[data-key-within]');
  var card = document.querySelector(${JSON.stringify(CARD)});
  return {
    keyViewId: kv.length === 0 ? null : kv[0].getAttribute('data-key-view'),
    keyViewKbd: kv.length !== 0 && kv[0].hasAttribute('data-key-view-kbd'),
    keyViewCount: kv.length,
    keyWithinCount: document.querySelectorAll('[data-key-within]').length,
    keyWithinIsWithinCard: kw !== null && card !== null && card.contains(kw),
    focusMode: document.documentElement.getAttribute('data-focus-mode'),
    defaultRingCount: document.querySelectorAll('[data-default-ring]').length,
  };
})()`;

function snapshot(app: App): Promise<MarkSnapshot> {
  return app.evalJS<MarkSnapshot>(MARK_SNAPSHOT);
}

describe.skipIf(!SHOULD_RUN)("AT0268: focus marks are a projection of engine state", () => {
  test(
    "marks track the mode stack, survive a key-card round trip, and reproject idempotently",
    async () => {
      const app = await launchTugApp({ testName: "at0268-focus-projection" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TITLE)}) !== null`,
          { timeoutMs: 15_000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(`${CARD} [data-tug-focusable]`)}).length >= 1`,
          { timeoutMs: 6000 },
        );

        await app.nativeClickAtElement(TITLE);
        await app.waitForCondition<boolean>(keyboardIsInCard("A"), { timeoutMs: 6000 });

        // (1) Tab lands the key view on the accordion, keyboard-reached, and
        // the DOM names exactly what the engine says the key view is.
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${DEMO} [data-key-view-kbd]`)}) !== null`,
          { timeoutMs: 6000 },
        );
        const landed = await snapshot(app);
        expect(landed.keyViewCount).toBe(1);
        expect(landed.keyViewKbd).toBe(true);
        expect(landed.keyViewId).not.toBeNull();

        // (2) Space expands the cursor section, Enter descends into it: the
        // within mark appears on the container we descended from and a focus
        // mode is stamped on the document root. Escape removes both.
        await app.nativeKey(" ");
        await app.nativeKey("Enter");
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-key-within]') !== null`,
          { timeoutMs: 6000 },
        );
        const descended = await snapshot(app);
        expect(descended.keyWithinCount).toBe(1);
        expect(descended.keyWithinIsWithinCard).toBe(true);
        expect(descended.focusMode).not.toBeNull();
        expect(descended.keyViewId).not.toBe(landed.keyViewId);

        // (3) The round trip. Deselect by clicking the canvas well clear of the
        // only pane — the key card goes null, which is the transition that used
        // to wipe the marks with nothing to restamp them.
        const paneBounds = await app.getElementBounds(PANE);
        const emptyPoint = {
          x: Math.round(paneBounds.x + paneBounds.width + 120),
          y: Math.round(paneBounds.y + paneBounds.height - 40),
        };
        await app.nativeClick(emptyPoint);
        // `getActiveCardId()` is the composite first-responder bit the engine
        // follows as its key card — the one that actually goes null on a
        // deselect. (`getFocusedCardId()` reports the topmost pane's active
        // card, a z-order fact that survives deselect.)
        await app.waitForCondition<boolean>(
          `window.__tug.getActiveCardId() === null`,
          { timeoutMs: 6000 },
        );
        // With no key card the default context is active, and it has no key
        // view — so nothing in the document should carry the mark.
        const deselected = await snapshot(app);
        expect(deselected.keyViewCount).toBe(0);

        // Reactivate the card. Its marks come back as they were — the descended
        // state included, since the mode stack never moved.
        //
        // With ONE mark legitimately changed: `keyViewKbd`. The round trip was
        // made with the POINTER, and using the mouse leaves keyboard-focus mode
        // ([P05]); in mode OFF the keyboard-ness is withheld at the projection
        // ([P04]), so the key view comes back marked but not ringed. That is the
        // mode doing its job, not the projection losing state — the key view
        // itself, the descend, the mode stamp and the within mark all return
        // intact, which is what this step is about.
        await app.nativeClickAtElement(TITLE);
        await app.waitForCondition<boolean>(keyboardIsInCard("A"), { timeoutMs: 6000 });
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-key-view]') !== null`,
          { timeoutMs: 6000 },
        );
        const afterPointerRoundTrip = { ...descended, keyViewKbd: false };
        const restored = await snapshot(app);
        expect(restored).toEqual(afterPointerRoundTrip);

        // (4) Asking the engine to project again from unchanged state changes
        // nothing — the pass is a convergence, not an accumulation.
        await app.evalJS<null>(`(window.__tug.reprojectFocus(), null)`);
        expect(await snapshot(app)).toEqual(afterPointerRoundTrip);

        const report = await app.evalJS<{ violations: number }>(
          `window.__tug.getFocusInvariantReport()`,
        );
        expect(report.violations).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the reconciler heals a mark stripped from outside the engine",
    async () => {
      const app = await launchTugApp({ testName: "at0268-mark-heal" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TITLE)}) !== null`,
          { timeoutMs: 15_000 },
        );
        await app.nativeClickAtElement(TITLE);
        await app.waitForCondition<boolean>(keyboardIsInCard("A"), { timeoutMs: 6000 });
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${DEMO} [data-key-view-kbd]`)}) !== null`,
          { timeoutMs: 6000 },
        );
        const marked = await snapshot(app);
        expect(marked.keyViewCount).toBe(1);

        // Strip the mark from outside the engine — a React re-render dropping
        // an attribute, a peer script, the wipe a transient key-card change
        // used to leave behind. Engine state is untouched and still says this
        // element is the key view; only the image of that state is now wrong.
        await app.evalJS<null>(
          `(function(){
            var el = document.querySelector('[data-key-view]');
            if (el !== null) {
              el.removeAttribute('data-key-view');
              el.removeAttribute('data-key-view-kbd');
            }
            return null;
          })()`,
        );
        expect((await snapshot(app)).keyViewCount).toBe(0);

        // Wake the reconciler with a settled focus change — the provider's
        // focusin/focusout capture listeners are its guard. A blur to body
        // is the realistic shape: it is the routine transient middle of the
        // browser's own teardown sequences.
        //
        // Deliberately NOT a placement or an arrow-rove: those reproject on
        // their own, so healing through one would prove nothing about the
        // reconciler. Nothing here touches engine state; the mark comes back
        // only because it is DERIVED from that state, which is the capability
        // the transition-driven syncs never had.
        await app.evalJS<null>(
          `(function(){
            var el = document.activeElement;
            if (el instanceof HTMLElement) el.blur();
            return null;
          })()`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-key-view]') !== null`,
          { timeoutMs: 6000 },
        );
        const healedSnapshot = await snapshot(app);
        expect(healedSnapshot.keyViewCount).toBe(1);
        expect(healedSnapshot.keyViewKbd).toBe(true);

        // Healing a mark is not a focus steal — nothing took the keyboard —
        // so the loud ledger the steal budgets read stays flat.
        const report = await app.evalJS<{
          violations: number;
          steals: Record<string, number>;
        }>(`window.__tug.getFocusInvariantReport()`);
        expect(report.violations).toBe(0);
        expect(Object.keys(report.steals)).toEqual([]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

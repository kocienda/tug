/**
 * at0109-focus-ring.test.ts — the single app-owned focus ring (focus-ring.css +
 * the --tugx-focus-ring-* theme tokens).
 *
 * One ring, on the keyboard-active control: it appears on **keyboard** focus and
 * never on a mouse click. The key view is engine state projected to the DOM as
 * `data-key-view` — internal plumbing with no visual of its own. The ring paints
 * only when that key view is *keyboard-reached* (`data-key-view-kbd`), the mark
 * the engine sets when the Tab walk (not a pointer) lands the key view.
 *
 * Under the keyboard-as-engine-state model, DOM focus rests on the app's
 * `tug-key-sink`, not on the clicked control — the engine routes keys off the
 * sink and derives the key view from its own register, so a control's ring is a
 * function of engine state, not of `document.activeElement`. The two halves:
 *
 *   - a **mouse click** parks a key view (pointer modality) on the card's
 *     focusable — `data-key-view` is set, but it is NOT `data-key-view-kbd`, so
 *     no ring paints (outline width 0). The keyboard is the engine's, not the
 *     control's;
 *   - a **keyboard** Tab drives the engine walk onto a registered focusable and
 *     marks that key view keyboard-reached (`data-key-view-kbd`), so the ring
 *     paints.
 *
 * The click half asserts "the keyboard is not on the control" plus a clean
 * guard, not "`activeElement` is the sink". The sink is one legal register
 * among several: a bare `<body>` left behind by the browser's own mousedown
 * default is equally legal and is what actually settles here, so pinning the
 * sink specifically was asserting a mechanism the engine never promised.
 *
 * Outline width is read from `getComputedStyle` in the real WKWebView, where the
 * ring's `data-key-view-kbd` styling actually resolves.
 *
 * @covers tugdeck/styles/focus-ring.css
 * @covers tugdeck/styles/themes/
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/focus-ring-modality-store.ts
 * @covers tugdeck/src/keyboard-access-store.ts
 * @covers tugdeck/src/components/tugways/cards/gallery-chain-actions.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const DEMO = `${CARD} [data-testid="keybinding-demo"]`;
const DEMO_TARGET = `${CARD} [data-testid="keybinding-demo-target"]`;

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "gallery-chain-actions", title: "Chain", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 560, height: 520 },
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

// Snapshot the element currently carrying the key view (whatever it is) and the
// keyboard-reached ring element (if any). A single read keeps the pointer- and
// keyboard-modality assertions consistent across one paint.
const RING_PROBE = `(function(){
  var kv = document.querySelector("[data-key-view]");
  var kbd = document.querySelector("[data-key-view-kbd]");
  var ae = document.activeElement;
  var target = document.querySelector(${JSON.stringify(DEMO_TARGET)});
  var report = window.__tug.getFocusInvariantReport();
  return {
    keyView: kv ? kv.getAttribute("data-key-view") : null,
    keyViewOutline: kv ? getComputedStyle(kv).outlineWidth : null,
    keyViewIsKbd: kv ? kv.hasAttribute("data-key-view-kbd") : null,
    kbdOutline: kbd ? getComputedStyle(kbd).outlineWidth : null,
    activeInControl: ae !== null && target !== null && target.contains(ae),
    violations: report === null ? -1 : report.violations,
  };
})()`;

interface RingProbe {
  keyView: string | null;
  keyViewOutline: string | null;
  keyViewIsKbd: boolean | null;
  kbdOutline: string | null;
  activeInControl: boolean;
  violations: number;
}

describe.skipIf(!SHOULD_RUN)("AT0109: single focus ring on the keyboard-active control", () => {
  test(
    "a mouse click paints no ring; keyboard focus paints the ring",
    async () => {
      const app = await launchTugApp({ testName: "at0109-focus-ring" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DEMO)}) !== null`,
          { timeoutMs: 8000 },
        );

        // Mouse click — parks a key view (pointer modality) on the card's
        // focusable. The key view lands, but it is not keyboard-reached, so no
        // ring paints; DOM focus rests on the sink, never on the control.
        await app.nativeClickAtElement(DEMO_TARGET);
        await app.waitForCondition<boolean>(
          `document.querySelector("[data-key-view]") !== null`,
          { timeoutMs: 6000 },
        );
        // The park is the settled state, not the immediate one: the browser's
        // own mousedown focus default lands after the engine's capture-phase
        // placement, and the watchdog re-parks on the next macrotask. Poll it
        // rather than sampling, or this reads the browser's transient.
        const clicked = await app.evalJS<RingProbe>(RING_PROBE);
        console.log("[at0109] after click:", JSON.stringify(clicked));
        expect(clicked?.keyView).not.toBeNull();
        expect(clicked?.keyViewIsKbd).toBe(false);
        expect(parseFloat(clicked?.keyViewOutline ?? "0")).toBe(0);
        // The keyboard is the engine's, not the control's. Asserted as the
        // invariant rather than as a specific register: an engine-routed
        // placement parks the sink, but a bare `<body>` left behind by the
        // browser's own mousedown default is equally legal (a standing legality
        // class — see focus-language.md), and the guard is what says so.
        expect(clicked?.activeInControl).toBe(false);
        expect(clicked?.violations).toBe(0);

        // Keyboard Tab — drives the engine walk onto a registered focusable and
        // marks the key view keyboard-reached (`data-key-view-kbd`), so the ring
        // paints even though WebKit withholds :focus-visible from the sink's
        // programmatic focus.
        await app.nativeKey("Tab");
        await app.waitForCondition<boolean>(
          `document.querySelector("[data-key-view-kbd]") !== null`,
          { timeoutMs: 6000 },
        );
        const keyboard = await app.evalJS<RingProbe>(RING_PROBE);
        expect(keyboard?.keyViewIsKbd).toBe(true);
        expect(parseFloat(keyboard?.kbdOutline ?? "0")).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

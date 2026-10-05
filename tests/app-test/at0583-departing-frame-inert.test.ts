/**
 * at0583-departing-frame-inert.test.ts — while a closed card is carried out on
 * its own frame, nothing can reach it.
 *
 * ## What this gates
 *
 * A closing pane leaves on its REAL frame: the store keeps it in the deck it
 * publishes for one settle, the canvas draws it `data-departing`, and the
 * settle fades it where it stood (`lib/departing.ts`, `settle-engine.ts`). For
 * the length of that beat the card is fully mounted — its transcript, its
 * focusables, its scroll keys — and every one of them is still something the
 * document can find. That is the point: the card's own content reads itself
 * unchanged while it leaves. What must not happen is that anything REACHES it:
 * a click landing on a card that has closed, a keystroke typed into it, focus
 * restored into it.
 *
 * So the frame is `inert` and takes no pointer, and the store's close moved
 * the first responder to the close's successor before the frame became
 * departing. This file reads all three on the real gesture.
 *
 * It is also the tripwire against a planted stand-in coming back: exactly one
 * frame answers to the departing pane's id while it departs. A stand-in was a
 * second set of answers to every document-wide query a card is addressed by,
 * and the frame that leaves now is the one set there is.
 *
 * ## The claim
 *
 * On the first animation frame the departing frame exists on:
 *
 * 1. It carries `inert`.
 * 2. Its COMPUTED `pointer-events` is `none` — what a hit test reads.
 * 3. `document.activeElement` is not inside it.
 * 4. Exactly one `.tug-pane` in the document carries the pane's id.
 *
 * The census of {@link LIVE_SELECTORS} inside the departing frame is reported
 * in a `note()`: it is now one set of answers — the real card's — rather than
 * a copy's, and what it says is what an inert card still holds while it
 * leaves.
 *
 * The card that leaves is a Session card bound to a REAL resumed transcript —
 * the slice (`real-transcript-fixture.ts`) — so the subtree that must be
 * unreachable is the one a user's card holds: list cells, a composer, a
 * scroller with rows in it. Inertness is not a question a transcript's size
 * can change, so the slice is the one arm this file runs.
 *
 * @covers tugdeck/src/components/chrome/settle-engine.ts
 * @covers tugdeck/src/components/chrome/space-layer.css
 * @covers tests/app-test/real-transcript-fixture.ts
 */
import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { bindForTest } from "./real-transcript-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The width each seeded card stands at. */
const SLIM_PX = 560;
/** How long the sampler watches the departure. */
const CENSUS_MS = 2_000;

/**
 * Every selector by which something in the running app addresses a LIVE node,
 * with what reaches for it — read off the source: each appears in a
 * `querySelector`, a `closest`, or a `querySelectorAll` that expects to find a
 * thing it may then focus, scroll, hit-test, portal onto, or click.
 */
const LIVE_SELECTORS: { selector: string; who: string }[] = [
  { selector: "[id]", who: "anything addressing a node by name" },
  { selector: "[data-card-id]", who: "the deck, the harness, every app-test" },
  { selector: "[data-testid]", who: "every test" },
  { selector: "[data-tug-focus-key]", who: "the focus machinery" },
  { selector: "[data-slot]", who: "a stylesheet and a test naming a part" },
  { selector: "[data-responder-id]", who: "focus-manager, focus-transfer" },
  { selector: "[data-tug-focusable]", who: "focus-manager, tug-accordion" },
  { selector: "[data-tug-scroll-key]", who: "card-host's scroll restoration" },
  { selector: "[data-tug-state-key]", who: "focus-transfer's state preservation" },
  { selector: "[data-card-host]", who: "the gesture interpreter, deck-manager" },
  { selector: "[data-tug-list-cell-index]", who: "tug-list-view" },
  { selector: "[data-item-action]", who: "the editor context menu" },
  { selector: "[data-tug-annotation]", who: "the commit and file tip portals" },
];

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

interface Reading {
  /** How many nodes each live selector found inside the departing frame. */
  answered: Record<string, number>;
  inert: boolean;
  pointerEvents: string;
  /** Whether `document.activeElement` stood inside the departing frame. */
  focusInside: boolean;
  /** How many frames carried the departing pane's id when the reading was taken. */
  frames: number;
}

/**
 * A five-up FLOW band holding three `hello` cards, so a Session card opened
 * into it has real neighbours and the departure is a real arrangement change.
 */
function deckShape() {
  const ids = ["C", "D", "E"];
  return {
    cards: ids.map((id) => ({
      id,
      componentId: "hello",
      title: `Card ${id}`,
      closable: true,
    })),
    panes: ids.map((id, index) => ({
      id: `p${index + 1}`,
      position: { x: 40, y: 40 },
      size: { width: SLIM_PX, height: 400 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["maker"],
      slot: index + 2,
    })),
    activePaneId: "p2",
    imposition: { kind: "five-up", sidebars: {}, layout: "flow" },
    hasFocus: true,
  };
}

/**
 * Read the departing frame once, at the first animation frame it exists on.
 *
 * Armed before the gesture and latched on the FIRST frame that carries the
 * mark, because the reading has to be taken while the frame is departing and
 * its whole departure is one beat. A poll after the fact would find nothing.
 */
async function arm(app: App, paneId: string): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      window.__at0583 = null;
      var selectors = ${JSON.stringify(LIVE_SELECTORS.map((s) => s.selector))};
      var t0 = performance.now();
      var tick = function () {
        var frame = document.querySelector('.tug-pane[data-departing][data-pane-id=${JSON.stringify(paneId)}]');
        if (frame !== null && window.__at0583 === null) {
          var answered = {};
          for (var i = 0; i < selectors.length; i += 1) {
            answered[selectors[i]] = frame.querySelectorAll(selectors[i]).length;
          }
          window.__at0583 = {
            answered: answered,
            inert: frame.hasAttribute("inert"),
            pointerEvents: getComputedStyle(frame).pointerEvents,
            focusInside: frame.contains(document.activeElement),
            frames: document.querySelectorAll('.tug-pane[data-pane-id=${JSON.stringify(paneId)}]').length,
          };
        }
        if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0583: the departing frame is inert", () => {
  test(
    "a departing frame is inert, takes no pointer, holds no focus, and stands alone",
    async () => {
      const app = await launchTugApp({ testName: "at0583-departing-frame-inert" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "C" });
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p2"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(1_400);

        // A Session card, because its subtree is the RICH one: a transcript,
        // focusables, scroll keys, list cells and a state key — and it holds
        // the keyboard when it opens, so the close has focus to move. It opens
        // on its picker and is then bound to a real transcript.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("show-card", { component: "session" }), null)`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(".session-card-picker-form") !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(1_200);
        const paneId = await app.evalJS<string>(
          `(function () {
            var panes = window.tugdeck.diag.getDeckState().panes;
            for (var i = panes.length - 1; i >= 0; i -= 1) {
              if (["p1", "p2", "p3"].indexOf(panes[i].id) === -1) return panes[i].id;
            }
            return "";
          })()`,
        );
        expect(paneId, "the Session card opened into its own pane").not.toBe("");
        const cardId = await app.evalJS<string>(
          `(function () {
            var pane = window.tugdeck.diag.getDeckState().panes.find(function (p) {
              return p.id === ${JSON.stringify(paneId)};
            });
            return pane ? pane.activeCardId : "";
          })()`,
        );
        await bindForTest(app, [cardId], { size: "slice", label: "at0583" });
        await wait(1_200);

        await arm(app, paneId);
        await app.evalJS<null>(
          `(window.__tug.closePane(${JSON.stringify(paneId)}), null)`,
        );
        await wait(CENSUS_MS + 300);

        const reading = await app.evalJS<Reading | null>(`window.__at0583`);
        expect(
          reading,
          "the census must have caught the frame while it departed",
        ).not.toBeNull();
        const read = reading as Reading;
        note(
          "what the leaving card still holds",
          LIVE_SELECTORS.filter((s) => (read.answered[s.selector] ?? 0) > 0)
            .map((s) => `${s.selector}×${read.answered[s.selector]}`)
            .join(", ") || "(nothing)",
        );
        note(
          "inertness",
          `inert=${read.inert} pointer-events=${read.pointerEvents} focusInside=${read.focusInside} frames=${read.frames}`,
        );

        expect(read.inert, "the departing frame is inert").toBe(true);
        expect(
          read.pointerEvents,
          "and takes no pointer events",
        ).toBe("none");
        expect(
          read.focusInside,
          "and the keyboard is not inside it",
        ).toBe(false);
        expect(read.frames, "and no second frame stands in for it").toBe(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

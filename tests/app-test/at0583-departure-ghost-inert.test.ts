/**
 * at0583-departure-ghost-inert.test.ts — while a ghost stands, nothing in the
 * document answers from inside it.
 *
 * ## What this gates
 *
 * A departure ghost is a blank tile. For one day it carried a FACE — a
 * `cloneNode(true)` of a whole live `.tug-pane`, planted in it and left standing
 * for the length of the fade — and every attribute the clone carried came with
 * it. An attribute is how nearly everything in the deck ADDRESSES a live thing:
 * the focus machinery resolves
 * `[data-tug-focusable="…"]` and `[data-responder-id="…"]`, the card host
 * restores scroll through `[data-tug-scroll-key]`, focus transfer finds a
 * component's saved state through `[data-tug-state-key]`, the gesture
 * interpreter classifies a press by `closest("[data-card-host]")`, the tip
 * portals mount onto `[data-tug-annotation="commit-sha"]`, and every app-test
 * names anything at all with `[data-testid]`.
 *
 * `takeDepartureFace` stripped six of those and the others were not on the list,
 * so for the whole beat a ghost stood, the document held a SECOND set of answers
 * to questions whose true answer is "that card closed" — and the queries above
 * are document-wide, so the still was not merely reachable, it was reachable
 * FIRST when it sorted before the live card in document order. The strip list
 * could not be finished, and the clone is retired for that reason.
 *
 * So this file is the TRIPWIRE on that decision. An empty tile answers nothing
 * by construction — but "by construction" is a property of today's code, and the
 * census below is what turns re-planting anything live inside a ghost back into a
 * red rather than into a quiet second set of answers. It reads the real selectors
 * rather than a list of attributes checked against itself, and it runs against
 * the richest card there is, so the day something IS planted the census names it.
 *
 * ## The claim
 *
 * While a ghost stands:
 *
 * 1. It carries no nodes at all — the blank tile, read as a count.
 * 2. No selector in {@link LIVE_SELECTORS} resolves inside it.
 * 3. It takes no pointer events — read as COMPUTED `pointer-events`, because
 *    that is what a hit test reads.
 *
 * The census also reports every `data-*` attribute still standing inside the
 * ghost, in a `note()`. On a blank tile that list is empty and the note says so,
 * which is the cheapest possible reading of the rule this file holds.
 *
 * `deck-canvas.tsx` is what plants a ghost and is not in the `@covers` list, on
 * at0587's precedent: it is already recorded at the selection ceiling in
 * `select-tests.ts`, and the ratchet lets recorded debt be paid down rather
 * than refinanced in place. `tug-pane.css` carries the ghost's whole styling,
 * including the `pointer-events: none` this file reads computed.
 *
 * @covers tugdeck/src/components/tugways/tug-pane.css
 */
import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The width each seeded card stands at. */
const SLIM_PX = 560;
/** How long the sampler watches the departure. */
const CENSUS_MS = 2_000;

/**
 * Every selector by which something in the running app addresses a LIVE node,
 * with what reaches for it.
 *
 * Read off the source rather than imagined: each of these appears in a
 * `querySelector`, a `closest`, or a `querySelectorAll` that expects to find a
 * thing it may then focus, scroll, hit-test, portal onto, or click.
 */
const LIVE_SELECTORS: { selector: string; who: string }[] = [
  { selector: "[id]", who: "anything addressing a node by name" },
  { selector: "[data-pane-id]", who: "the settle's own walk" },
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

interface Standing {
  /** How many nodes each live selector found inside the ghost, keyed by selector. */
  answered: Record<string, number>;
  /** Every `data-*` attribute name still standing anywhere inside the ghost. */
  survivors: string[];
  /** How many nodes stand inside the ghost. A departure is a blank tile. */
  carried: number;
  ghostInert: boolean;
  ghostAriaHidden: string;
  ghostPointerEvents: string;
  /** How many ghosts stood when the reading was taken. */
  ghosts: number;
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
 * Read the standing ghost once, at the first animation frame it exists on.
 *
 * Armed before the gesture and latched on the FIRST frame that carries a ghost,
 * because the reading has to be taken while the still is in the document and
 * the ghost's whole life is one fade. A poll after the fact would find nothing
 * and pass by having looked at an empty document.
 */
async function arm(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      window.__at0583 = null;
      var selectors = ${JSON.stringify(LIVE_SELECTORS.map((s) => s.selector))};
      var t0 = performance.now();
      var tick = function () {
        var ghost = document.querySelector(".tug-pane-exit-ghost");
        if (ghost !== null && window.__at0583 === null) {
          var answered = {};
          for (var i = 0; i < selectors.length; i += 1) {
            answered[selectors[i]] = ghost.querySelectorAll(selectors[i]).length;
          }
          var survivors = {};
          var walk = ghost.querySelectorAll("*");
          for (var n = 0; n < walk.length; n += 1) {
            var attrs = walk[n].attributes;
            for (var a = 0; a < attrs.length; a += 1) {
              if (attrs[a].name.indexOf("data-") === 0) survivors[attrs[a].name] = 1;
            }
          }
          window.__at0583 = {
            answered: answered,
            survivors: Object.keys(survivors).sort(),
            carried: ghost.childNodes.length,
            ghostInert: ghost.hasAttribute("inert"),
            ghostAriaHidden: ghost.getAttribute("aria-hidden") || "",
            ghostPointerEvents: getComputedStyle(ghost).pointerEvents,
            ghosts: document.querySelectorAll(".tug-pane-exit-ghost").length,
          };
        }
        if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return null;
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0583: the departure ghost answers nothing", () => {
  test(
    "a standing ghost carries nothing, answers nothing, and takes no pointer events",
    async () => {
      const app = await launchTugApp({ testName: "at0583-departure-ghost-inert" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "C" });
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p2"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(1_400);

        // A Session card, because its subtree is the RICH one: a picker form,
        // focusables, scroll keys, list cells and a state key. A `hello` pane
        // would pass this census by having almost nothing in it to leak.
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

        await arm(app);
        await app.evalJS<null>(
          `(window.__tug.closePane(${JSON.stringify(paneId)}), null)`,
        );
        await wait(CENSUS_MS + 300);

        const standing = await app.evalJS<Standing | null>(`window.__at0583`);
        expect(
          standing,
          "the census must have caught the ghost while it stood",
        ).not.toBeNull();
        const read = standing as Standing;
        note(
          "data-* attributes still standing inside the ghost",
          read.survivors.join(", ") || "(none)",
        );
        note(
          "inertness",
          `ghost: carries ${read.carried} node(s), inert=${read.ghostInert} aria-hidden="${read.ghostAriaHidden}" pointer-events=${read.ghostPointerEvents}`,
        );

        const answering = LIVE_SELECTORS.filter(
          (s) => (read.answered[s.selector] ?? 0) > 0,
        ).map(
          (s) =>
            `${s.selector} resolved ${read.answered[s.selector]} node(s) inside the ghost — ${s.who} would find them`,
        );
        expect(
          answering,
          "while a ghost stands, nothing the app addresses a live node by resolves inside it",
        ).toEqual([]);

        // The blank tile itself. A departure carries nothing, which is what
        // makes the census above answer nothing rather than merely happen to.
        expect(
          read.carried,
          "a departure is a blank tile — nothing stands inside it",
        ).toBe(0);
        expect(
          read.ghostPointerEvents,
          "the ghost takes no pointer events",
        ).toBe("none");
        expect(read.ghosts, "one departure, one ghost").toBe(1);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

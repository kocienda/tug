/**
 * at0589-hidden-mount-visibility.test.ts — a card that is rebuilt in the dark
 * is visible when the light comes on.
 *
 * A card that moves workspaces changes React parent: `DeckCanvas` renders one
 * `.tug-space-layer` per mounted workspace, and `space-layer.css` gives the
 * inactive ones `display: none`. So the move is a full unmount and remount of
 * the card's subtree, and the remount lands inside a subtree with no boxes
 * ([F01]–[F03] of the arc's brief). The `[A9]` state bag replays user data
 * across that rebuild; what it does not carry is DERIVED APPEARANCE — an
 * entrance animation's end state, a published CSS metric, a measured cap — and
 * every mount-time one-shot that writes one became a latent defect the day a
 * visited workspace started staying mounted.
 *
 * The user-visible shape is a blank Session card: `SessionCardBody`'s
 * first-mount fade writes `el.style.opacity = "0"` by hand and leaves the end
 * value to `TugAnimator`'s `commitStyles()`, which THROWS for an element that
 * is not rendered — a throw the animator deliberately swallows. Nothing
 * re-runs the fade, so the hand-written `"0"` is the card's inline style
 * forever.
 *
 * What this drives, and why it is shaped this way:
 *
 *   1. A real fixture session in the home workspace. Then a round trip to the
 *      away workspace and back, WHICH IS THE PREMISE: `mountedSpaceIds`
 *      (`tugdeck/src/spaces.ts`) is "the active one and every one the user has
 *      visited this run", so without the visit the away layer does not exist,
 *      the move takes the card out of the DOM entirely, and `activate-space`
 *      builds it inside a layer that is already shown. That is the sound path,
 *      not the one under test.
 *   2. The move, into the now-mounted-but-hidden away workspace.
 *   3. The reading WHILE IT IS STILL HIDDEN — the only moment at which an
 *      inline `"0"` is provably the fade's and not a later write — plus the
 *      `card-host-mount` that proves the remount happened at all.
 *   4. The switch.
 *   5. **State, not layout.** Seven earlier probes of this defect were green
 *      because they asserted geometry, and the geometry was correct: the card
 *      was laid out exactly where it belonged, at `opacity: 0`. So the three
 *      assertions here read inline `opacity` on `.session-card`, inline
 *      `opacity` on the host pane's content element (`CardHost`'s pre-restore
 *      mask, lifted only by a child commit that may never come), and the
 *      composer's `--tugx-editor-line-box`, which `line-box-metric.ts`
 *      declines to publish from a row with no box and then never asks again.
 *
 * The hypotheses this test was written to sort, from the plan's
 * (#why-the-harness-was-green):
 *
 *   0. The destination workspace was never mounted (the likeliest, and what
 *      leg 1's round trip removes).
 *   1. The far-side mount skipped the fade, because `deriveColdRestoreActive`
 *      held. Leg 3's reading of the inline opacity while hidden is the
 *      diagnostic.
 *   2. Motion was off, so the animation finished before the element was
 *      hidden. Leg 1 records the computed `--tug-motion`.
 *   3. The document timeline was suspended by window occlusion, which would
 *      have made a probe RED rather than green — but a green run with an
 *      animation still attached would be misleading, so the count is recorded.
 *
 * RED ON THE PRE-FIX TREE, and the diagnosis is hypothesis 0's refutation.
 * The run recorded `card-host-mount: ["A"]`, so the rebuild DID land in the
 * dark; `cardOpacity: "0"` with `animations: 1` while hidden, so the fade ran
 * and wrote its `"0"` there — hypotheses 0 and 1 are both out. `motion: "1"`
 * puts hypothesis 2 out. Hypothesis 3 is out by construction: an animation
 * that never finished would have left the card at `"0"` and made the earlier
 * probes RED.
 *
 * What the earlier probes were was LUCKY. The first run of this test switched
 * workspaces while the fade was still in flight (`animations: 1`), and the
 * animation then finished on the far side where `commitStyles()` had a box to
 * work against — so the card came back at `opacity: 1` and only the line box
 * was wrong (30px before the move, 14px after: the metric declined to measure
 * a row with no box, fell back to `defaultLineHeight`, and never asked again).
 * Waiting for the fade to DRAIN while the layer is still hidden is what makes
 * the user's own defect appear, and the run with that wait reads
 * `the card once shown: {"computed":"0","inline":"0"}` — a Session card that
 * is laid out exactly where it belongs and cannot be seen.
 *
 * So the timing is the reproduction, and the wait in leg 3 is load-bearing.
 *
 * `@covers` does NOT name `tugways/cards/session-card.tsx`, where the fade
 * itself lives, on at0506's and at0580's precedent: it sits at 21 in
 * `ACCEPTED_FANOUT` already, and the ratchet lets recorded debt be paid down
 * rather than refinanced — a twenty-second namer would raise the figure the
 * entry exists to hold down. `card-host.tsx` is named instead and is the right
 * address anyway: the remount this test turns on is `CardHost`'s, the mask is
 * `CardHost`'s own, and the card's subtree is rebuilt inside it.
 *
 * @covers tugdeck/src/components/chrome/card-host.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/line-box-metric.ts
 * @covers tugdeck/src/components/chrome/space-layer.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { seedFixtureSession } from "./fixtures/resolve";
import {
  openFixtureSession,
  SCROLLER,
  waitForTranscriptSettled,
} from "./fixtures/runner";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const HOME_SPACE = "space-home";
const AWAY_SPACE = "space-away";

/** The line box is a rasterized measurement; a pixel of drift is not a defect. */
const LINE_BOX_TOLERANCE_PX = 1;

/**
 * Two workspaces, at0580's blob. The home one is empty — the fixture runner
 * seeds the ACTIVE workspace's deck — and the away one holds a Text card so it
 * renders something of its own and the arrival lands beside a sitter.
 */
const TWO_SPACE_BLOB = {
  version: 5,
  activeSpaceId: HOME_SPACE,
  spaces: [
    {
      id: HOME_SPACE,
      name: "Home",
      deck: { cards: [], panes: [], imposition: { sidebars: {} } },
    },
    {
      id: AWAY_SPACE,
      name: "Away",
      deck: {
        cards: [{ id: "B", componentId: "text", title: "File", closable: true }],
        panes: [
          {
            id: "p-b",
            position: { x: 60, y: 60 },
            size: { width: 700, height: 500 },
            cardIds: ["B"],
            activeCardId: "B",
            title: "",
            acceptsFamilies: ["standard"],
          },
        ],
        activePaneId: "p-b",
        imposition: { kind: "one-up", sidebars: {} },
      },
    },
  ],
};

/** The card's own root, wherever it currently lives. */
const SESSION_CARD = ".session-card";
/** The composer's editor element — `view.dom`, which is what the plugin writes. */
const EDITOR = ".session-card .cm-editor";
/** The same two, but constrained to a layer the canvas is hiding. */
const HIDDEN_LAYER = ".tug-space-layer:not([data-space-shown])";
/** The pane content element hosting `A`, reached through the card host div. */
const HOST_CONTENT = `(function(){
  var host = document.querySelector('[data-card-host][data-card-id="A"]');
  return host === null ? null : host.closest(".tug-pane-content");
})()`;

interface Motion {
  motion: string;
  bodyAttr: string | null;
}

interface HiddenReading {
  found: boolean;
  cardOpacity: string | null;
  animations: number | null;
  contentOpacity: string | null;
}

/** The card's opacity as the user would see it, inline write and computed. */
interface Shown {
  inline: string;
  computed: string;
}

describe.skipIf(!SHOULD_RUN)(
  "at0589 — a card rebuilt in a hidden workspace comes back visible",
  () => {
    test(
      "the moved card carries no inline opacity and republishes its line box",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        const seeded = await seedFixtureSession(
          "session-transcript-basic",
          "at0589",
        );
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.dev",
          "recent-projects",
          "json",
          JSON.stringify({ paths: [seeded.projectDir] }),
        );
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(TWO_SPACE_BLOB),
        );

        const app = await launchTugApp({
          testName: "at0589-hidden-mount-visibility",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `typeof window.tugdeck !== "undefined" && window.tugdeck.diag.getSpaces().spaces.length === 2`,
            { timeoutMs: 10_000 },
          );

          // ---- 1. A real session in the home workspace.
          await openFixtureSession(app, seeded);
          await waitForTranscriptSettled(app);

          // Scroll it, as at0580 does. This is not scenery: `CardHost` arms
          // its pre-restore opacity mask only when the bag carries a `scroll`,
          // so a card that was never scrolled makes the second of leg 5's
          // three assertions vacuous — it would pass over a mask that was
          // never applied.
          await app.evalJS<number>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(SCROLLER)});
              el.scrollTop = Math.max(0, Math.floor((el.scrollHeight - el.clientHeight) * 0.4));
              el.dispatchEvent(new Event("scroll", { bubbles: true }));
              return el.scrollTop;
            })()`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SCROLLER)}).getAttribute("data-tug-scroll-state") !== null`,
            { timeoutMs: 4_000 },
          );

          // The round trip that mounts the away workspace. Without it the far
          // side does not exist to mount into and the move is the sound path.
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(AWAY_SPACE)} }), null)`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(`.tug-space-layer[data-space-layer="${AWAY_SPACE}"][data-space-shown]`)}) !== null`,
            { timeoutMs: 8_000 },
          );
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(HOME_SPACE)} }), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.listCardIds().indexOf("A") !== -1`,
            { timeoutMs: 8_000 },
          );
          await waitForTranscriptSettled(app);

          // The metric as it stands before anything moves: the number the
          // card must still be publishing on the far side.
          const beforeLineBox = await app.waitForCondition<number>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(EDITOR)});
              if (el === null) return 0;
              var v = getComputedStyle(el).getPropertyValue("--tugx-editor-line-box").trim();
              var n = parseFloat(v);
              return Number.isFinite(n) && n > 0 ? n : 0;
            })()`,
            { timeoutMs: 8_000 },
          );
          note(`line box before the move: ${beforeLineBox}px`);

          const motion = await app.evalJS<Motion>(
            `(function(){
              return {
                motion: getComputedStyle(document.documentElement).getPropertyValue("--tug-motion").trim(),
                bodyAttr: document.body.getAttribute("data-tug-motion"),
              };
            })()`,
          );
          note(`motion: ${JSON.stringify(motion)}`);

          // ---- 2. The move, into the mounted-but-hidden away workspace.
          const mark = await app.evalJS<number>(
            `(window.__deckTrace.enable(true), window.__deckTrace.mark())`,
          );
          expect(
            await app.evalJS<boolean>(
              `window.tugdeck.lab.moveCardToSpace("A", ${JSON.stringify(AWAY_SPACE)})`,
            ),
          ).toBe(true);
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.listCardIds().indexOf("A") === -1`,
            { timeoutMs: 8_000 },
          );

          // ---- 3. Read it in the dark. This is the only moment at which an
          // inline "0" is provably the fade's own write.
          const hidden = await app.evalJS<HiddenReading>(
            `(function(){
              var card = document.querySelector(${JSON.stringify(`${HIDDEN_LAYER} ${SESSION_CARD}`)});
              var content = ${HOST_CONTENT};
              return {
                found: card !== null,
                cardOpacity: card === null ? null : card.style.opacity,
                animations: card === null ? null : card.getAnimations().length,
                contentOpacity: content === null ? null : content.style.opacity,
              };
            })()`,
          );
          note(`while hidden: ${JSON.stringify(hidden)}`);

          // Let the fade FINISH while the layer is still hidden. This is the
          // moment the defect is made: `commitStyles()` throws for an element
          // with no box, `tug-animator.ts` swallows the throw, `cancel()`
          // takes the animation away, and the hand-written "0" becomes the
          // element's inline style with nothing left to clear it. Switch
          // before the animation ends and it commits on the far side by luck
          // of timing — which is what the first run of this test recorded, and
          // why the wait is here rather than left to the clock.
          await app
            .waitForCondition<boolean>(
              `(function(){
                var card = document.querySelector(${JSON.stringify(`${HIDDEN_LAYER} ${SESSION_CARD}`)});
                return card !== null && card.getAnimations().length === 0;
              })()`,
              { timeoutMs: 4_000 },
            )
            .catch(() => undefined);
          const drained = await app.evalJS<HiddenReading>(
            `(function(){
              var card = document.querySelector(${JSON.stringify(`${HIDDEN_LAYER} ${SESSION_CARD}`)});
              var content = ${HOST_CONTENT};
              return {
                found: card !== null,
                cardOpacity: card === null ? null : card.style.opacity,
                animations: card === null ? null : card.getAnimations().length,
                contentOpacity: content === null ? null : content.style.opacity,
              };
            })()`,
          );
          note(`hidden, after the fade drained: ${JSON.stringify(drained)}`);

          // The remount is the premise: without it there is nothing to be
          // stuck, and a green run below would be saying nothing.
          const mounts = await app.evalJS<string[]>(
            `window.__deckTrace.since(${mark})
              .filter(function (e) { return e.kind === "card-host-mount"; })
              .map(function (e) { return e.cardId; })`,
          );
          note(`card-host-mount since the mark: ${JSON.stringify(mounts)}`);
          expect(mounts).toContain("A");

          // ---- 4. Switch to it.
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(AWAY_SPACE)} }), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.listCardIds().indexOf("A") !== -1`,
            { timeoutMs: 8_000 },
          );
          await waitForTranscriptSettled(app);

          // ---- 5. State, not layout. Bounded at 4s so a fade genuinely in
          // flight has time to land its end value. The wait is allowed to time
          // out: what this test owes is a named state assertion, not a
          // `TimeoutError` that says only that some expression stayed falsy.
          const SHOWN_PROBE = `(function(){
            var el = document.querySelector(${JSON.stringify(SESSION_CARD)});
            if (el === null) return { inline: "<no card>", computed: "<no card>" };
            return { inline: el.style.opacity, computed: getComputedStyle(el).opacity };
          })()`;
          await app
            .waitForCondition<Shown | false>(
              `(function(){
                var s = ${SHOWN_PROBE};
                return s.inline !== "0" && s.computed === "1" ? s : false;
              })()`,
              { timeoutMs: 4_000 },
            )
            .catch(() => undefined);
          const shown = await app.evalJS<Shown>(SHOWN_PROBE);
          note(`the card once shown: ${JSON.stringify(shown)}`);
          // The fade's hand-written "0" outliving the animation is the defect.
          expect(shown.inline).not.toBe("0");
          expect(shown.computed).toBe("1");

          const contentOpacity = await app.evalJS<string | null>(
            `(function(){
              var el = ${HOST_CONTENT};
              return el === null ? null : el.style.opacity;
            })()`,
          );
          note(`host content inline opacity: ${JSON.stringify(contentOpacity)}`);
          // `CardHost`'s pre-restore mask, whose only lifter is a child commit.
          expect(contentOpacity).not.toBe("0");

          const afterLineBox = await app.evalJS<number>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(EDITOR)});
              if (el === null) return -1;
              var n = parseFloat(getComputedStyle(el).getPropertyValue("--tugx-editor-line-box").trim());
              return Number.isFinite(n) ? n : -1;
            })()`,
          );
          note(`line box after the move: ${afterLineBox}px`);
          // A metric that refused to measure in the dark and never asked again
          // reads as the fallback, not as the number it published before.
          expect(Math.abs(afterLineBox - beforeLineBox)).toBeLessThanOrEqual(
            LINE_BOX_TOLERANCE_PX,
          );

          // ---- 6. The mask's deadline, once Step 4 of the plan exists. Zero
          // or one is legal; the note is what makes the case readable.
          const deadlines = await app.evalJS<number>(
            `window.__deckTrace.since(${mark})
              .filter(function (e) { return e.kind === "card-host-mask-deadline"; }).length`,
          );
          note(`card-host-mask-deadline events since the mark: ${deadlines}`);
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

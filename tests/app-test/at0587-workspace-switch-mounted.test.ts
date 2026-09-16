/**
 * at0587-workspace-switch-mounted.test.ts — a visited workspace stays mounted.
 *
 * Before this test's step, a workspace switch was an unmount of every card on
 * one side and a mount of every card on the other, and everything the user
 * had — a transcript's reading position, a scroll offset, a selection — came
 * back only because a capture had written it into a bag and `CardHost`
 * replayed it onto a fresh mount ([F06]). That is a lot of machinery to keep
 * correct for a gesture whose whole promise is that nothing happened.
 *
 * So the canvas now renders one wrapper per MOUNTED workspace and shows
 * exactly one ([B06]). A switch is a style change: the outgoing workspace's
 * panes are still in the document, still holding their cards, with no boxes;
 * the incoming workspace's panes were never taken down to be rebuilt.
 *
 * The test drives the real app and asserts the negative twice over:
 *
 *   1. A real session is opened in workspace one and its transcript scrolled
 *      to a mid anchor. The scroller element is stamped with an attribute, so
 *      the assertion at the end is about the same DOM NODE rather than about
 *      a node that happens to look the same.
 *   2. Workspace two is visited once — the first visit is where a mount is
 *      owed and expected — and then workspace one again. Both are now mounted.
 *   3. Mark the trace, switch to two, and assert **no** `card-host-unmount`
 *      for workspace one's cards and **no** `card-host-mount` for workspace
 *      two's. Those two events are `CardHost`'s own record of being stood up
 *      and taken down, so their absence is the claim stated at its source.
 *   4. The outgoing workspace's panes are still in the document, inside the
 *      wrapper that carries no `data-space-shown`, and have no client rects —
 *      mounted and hidden, which is the whole shape.
 *   5. Switch back, and the stamped scroller is the same node at the same
 *      pixel. at0578 asserts the same pixel from the replay side; this one
 *      asserts it from the side where there was nothing to replay.
 *   6. And the switch is a CLICK rather than a press ([B01], [B02]). A press
 *      on a parked workspace's row in the Workspaces card that travels a few
 *      pixels is a drag, so it selects nothing and switches nothing: the
 *      workspace on screen at the end of the gesture is the one that was on
 *      screen when it began. The press used to commit the selection on the
 *      pointerdown, which is why nothing in a parked workspace could be
 *      dragged at all.
 *   7. And the mark on those headers is an EYE ([B03]): the workspace on
 *      screen carries an open one and the parked one a closed one, in a
 *      column that holds its width either way so the names do not move when
 *      the mark changes.
 *   8. The other half of [B02], and the reason the deferral is a deferral
 *      rather than a refusal: a press on that same parked row that does NOT
 *      travel is an ordinary click, and it switches the workspace exactly as
 *      it did when the switch landed on the mousedown. Leg 6 alone would be
 *      satisfied by a door that had simply stopped working.
 *
 * The second test is the other half of the same design, and it is the one
 * that keeps [B06] honest rather than merely cheap. A workspace hidden with
 * `display: none` has no boxes, and every canvas geometry is a measurement of
 * real boxes — the rail's width, the flow strip's offsets, a pane's
 * chrome-measured floor. A measurement taken while the workspace was in the
 * dark would read zero and stick, so the rule is that a hidden workspace
 * measures nothing and every reading is armed on the transition to shown. The
 * test states that as an equality a defect cannot satisfy by accident: the
 * same workspace, laid out under flow with a pinned rail, is reached twice —
 * once by switching into it and once by booting straight into it — and every
 * pane's frame must land on the same pixels both ways.
 *
 * `deck-canvas.tsx` and `deck-manager.ts` are the files the step moves and
 * neither is in the `@covers` list, on at0580's and at0584's precedent: both
 * are already recorded at the selection ceiling in `select-tests.ts`, and the
 * ratchet lets recorded debt be paid down rather than refinanced in place.
 * `space-layer.ts` is the new module the change turns on and this test is its
 * owner; `spaces.ts` carries the snapshot fields the canvas reads.
 * `cards-card.tsx` joins them for leg 6: the arm that makes the switch a click
 * is written there, and no narrower module holds it. `cards-space-header.tsx`
 * and `cards-card.css` join them for leg 7 — the eye is rendered in the one
 * and the column that holds its width is stated in the other.
 *
 * @covers tugdeck/src/components/chrome/space-layer.ts
 * @covers tugdeck/src/spaces.ts
 * @covers tugdeck/src/components/chrome/space-layer.css
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/components/cards/cards-space-header.tsx
 * @covers tugdeck/src/components/cards/cards-card.css
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
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

const SPACE_ONE = "space-one";
const SPACE_TWO = "space-two";

/** Pixel tolerance for "landed on the same spot", as at0190 and at0578 use. */
const RESTORE_TOLERANCE_PX = 2;

/** The stamp that makes step 5's assertion about one DOM node. */
const STAMP = "data-at0587-scroller";

/** A beat for the arrangement to finish committing before a reading. */
const settle = (ms = 600): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * Two workspaces on disk, the same shape at0578 uses: the first is empty so
 * the fixture runner's `seedDeckState` can fill it, the second holds one Text
 * card so the switch has real panes on the far side.
 */
const TWO_SPACE_BLOB = {
  version: 5,
  activeSpaceId: SPACE_ONE,
  spaces: [
    {
      id: SPACE_ONE,
      name: "Main",
      deck: { cards: [], panes: [], imposition: { sidebars: {} } },
    },
    {
      id: SPACE_TWO,
      name: "Second",
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

interface HostEvent {
  kind: string;
  cardId?: string;
}

interface LayerReading {
  layers: number;
  shown: number;
  hiddenPanes: number;
  hiddenPanesWithBoxes: number;
  shownPanes: number;
  stampedIsHidden: boolean;
  stampedIsInDocument: boolean;
}

/**
 * A workspace worth measuring: a pinned rail on the right and three cards
 * under flow, so the reading covers the rail's width, the band it insets, and
 * the strip positions every flow frame is anchored against.
 */
function flowSpaceDeck(): unknown {
  const ids = ["F1", "F2", "F3"];
  return {
    cards: [
      { id: "RAIL", componentId: "cards", title: "Workspaces", closable: true },
      ...ids.map((id) => ({
        id,
        componentId: "text",
        title: `Card ${id}`,
        closable: true,
      })),
    ],
    panes: [
      {
        id: "p-rail",
        position: { x: 40, y: 40 },
        // The width the sidebar retune settles on for this canvas. Seeded at
        // that number on purpose: a boot RUNS `retuneSidebarAllocation` over
        // the active deck and an activation does not, so a rail seeded any
        // narrower comes back two different widths for a reason that has
        // nothing to do with what this test is about. That asymmetry is
        // older than the mounted switch — `activateSpace` never retuned —
        // and it is recorded in the arc's `baseline.md` rather than
        // smuggled into this assertion.
        size: { width: 420, height: 600 },
        cardIds: ["RAIL"],
        activeCardId: "RAIL",
        title: "",
        acceptsFamilies: ["standard"],
      },
      ...ids.map((id, index) => ({
        id: `p-${id}`,
        position: { x: 40, y: 40 },
        size: { width: 420, height: 400 },
        cardIds: [id],
        activeCardId: id,
        title: "",
        acceptsFamilies: ["standard"],
        slot: index,
      })),
    ],
    activePaneId: "p-F1",
    imposition: {
      kind: "six-up",
      layout: "flow",
      sidebars: { cards: { side: "right" } },
    },
  };
}

/** The two-workspace blob, with `activeSpaceId` the caller's. */
function geometryBlob(activeSpaceId: string): unknown {
  return {
    version: 5,
    activeSpaceId,
    spaces: [
      {
        id: SPACE_ONE,
        name: "Main",
        deck: {
          cards: [
            { id: "Z", componentId: "text", title: "Plain", closable: true },
          ],
          panes: [
            {
              id: "p-z",
              position: { x: 80, y: 80 },
              size: { width: 600, height: 400 },
              cardIds: ["Z"],
              activeCardId: "Z",
              title: "",
              acceptsFamilies: ["standard"],
            },
          ],
          activePaneId: "p-z",
          imposition: { sidebars: {} },
        },
      },
      { id: SPACE_TWO, name: "Second", deck: flowSpaceDeck() },
    ],
  };
}

/**
 * Every shown pane's frame, canvas-relative and rounded to the pixel, keyed
 * by pane id. Canvas-relative because the window's own origin is not what is
 * under test, and rounded because two identical layouts may still differ in
 * the sub-pixel tail of a `calc()` chain.
 */
const SHOWN_FRAMES = `(function () {
  var canvas = document.querySelector('[data-deck-canvas-background]');
  var box = canvas.getBoundingClientRect();
  var out = {};
  var frames = document.querySelectorAll(
    '[data-space-layer][data-space-shown] .tug-pane[data-pane-id]'
  );
  Array.prototype.forEach.call(frames, function (el) {
    var r = el.getBoundingClientRect();
    out[el.getAttribute('data-pane-id')] = {
      left: Math.round(r.left - box.left),
      top: Math.round(r.top - box.top),
      width: Math.round(r.width),
      height: Math.round(r.height)
    };
  });
  return out;
})()`;

type FrameMap = Record<
  string,
  { left: number; top: number; width: number; height: number }
>;

/**
 * Boot into `activeSpaceId`, run `reach` (which may switch), and read the
 * shown workspace's frames.
 */
async function framesReached(
  activeSpaceId: string,
  reach: (app: App) => Promise<void>,
): Promise<FrameMap> {
  const tugbankPath = mkTempTugbank();
  seedTugbankForLaunch(tugbankPath);
  tugbankWrite(
    tugbankPath,
    "dev.tugapp.deck.layout",
    "layout",
    "json",
    JSON.stringify(geometryBlob(activeSpaceId)),
  );
  const app = await launchTugApp({
    testName: "at0587-workspace-switch-mounted",
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
    await reach(app);
    await app.waitForCondition<boolean>(
      `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(SPACE_TWO)}`,
      { timeoutMs: 8_000 },
    );
    // The frames settle over a beat after an arrangement commits, so the
    // reading waits for every flow pane to have a box rather than for a
    // duration.
    await app.waitForCondition<boolean>(
      `Object.keys(${SHOWN_FRAMES}).length === 4`,
      { timeoutMs: 8_000 },
    );
    await settle();
    return await app.evalJS<FrameMap>(SHOWN_FRAMES);
  } finally {
    await app.close();
    rmTempTugbank(tugbankPath);
  }
}

describe.skipIf(!SHOULD_RUN)(
  "at0587 — a visited workspace stays mounted across a switch",
  () => {
    test(
      "switching hides and shows: no card host is taken down, and none is stood up",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        const seeded = await seedFixtureSession(
          "session-transcript-basic",
          "at0587",
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
          testName: "at0587-workspace-switch-mounted",
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

          // ---- 1. A real session, scrolled, and its scroller stamped.
          await openFixtureSession(app, seeded);
          await waitForTranscriptSettled(app);

          const savedTop = await app.evalJS<number>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(SCROLLER)});
              el.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true, cancelable: true }));
              el.scrollTop = Math.max(0, Math.floor((el.scrollHeight - el.clientHeight) * 0.4));
              el.dispatchEvent(new Event('scroll', { bubbles: true }));
              el.setAttribute(${JSON.stringify(STAMP)}, "1");
              return el.scrollTop;
            })()`,
          );
          expect(savedTop).toBeGreaterThan(RESTORE_TOLERANCE_PX);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SCROLLER)}).getAttribute("data-tug-scroll-state") !== null`,
            { timeoutMs: 4_000 },
          );

          // ---- 2. Visit workspace two once, then come back. The first visit
          // is the one that owes a mount, and it is deliberately outside the
          // mark below.
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(SPACE_TWO)} }), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.listCardIds().indexOf("B") !== -1`,
            { timeoutMs: 8_000 },
          );
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(SPACE_ONE)} }), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.listCardIds().indexOf("A") !== -1`,
            { timeoutMs: 8_000 },
          );
          await waitForTranscriptSettled(app);

          // ---- 3. The switch under test.
          const mark = await app.evalJS<number>(
            `(window.__deckTrace.enable(true), window.__deckTrace.mark())`,
          );
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(SPACE_TWO)} }), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(SPACE_TWO)}`,
            { timeoutMs: 8_000 },
          );

          const hostEvents = await app.evalJS<HostEvent[]>(
            `window.__deckTrace.since(${mark})
              .filter(function (e) {
                return e.kind === "card-host-mount" || e.kind === "card-host-unmount";
              })
              .map(function (e) { return { kind: e.kind, cardId: e.cardId }; })`,
          );
          note(
            `card-host events over the switch: ${JSON.stringify(hostEvents)}`,
          );
          // The outgoing workspace's session card was not taken down, and the
          // incoming workspace's card was not stood up. Stated over the whole
          // set rather than per id, because a third card appearing here would
          // be the same defect wearing another name.
          expect(hostEvents).toEqual([]);

          // ---- 4. Mounted and hidden.
          const reading = await app.evalJS<LayerReading>(
            `(function(){
              var layers = Array.prototype.slice.call(
                document.querySelectorAll('[data-space-layer]')
              );
              var shown = layers.filter(function (l) {
                return l.hasAttribute('data-space-shown');
              });
              var hidden = layers.filter(function (l) {
                return !l.hasAttribute('data-space-shown');
              });
              var panesIn = function (els) {
                var out = [];
                els.forEach(function (l) {
                  out = out.concat(Array.prototype.slice.call(
                    l.querySelectorAll('.tug-pane[data-pane-id]')
                  ));
                });
                return out;
              };
              var hiddenPanes = panesIn(hidden);
              var stamped = document.querySelector('[' + ${JSON.stringify(STAMP)} + ']');
              return {
                layers: layers.length,
                shown: shown.length,
                hiddenPanes: hiddenPanes.length,
                hiddenPanesWithBoxes: hiddenPanes.filter(function (p) {
                  return p.getClientRects().length > 0;
                }).length,
                shownPanes: panesIn(shown).length,
                stampedIsInDocument: stamped !== null,
                stampedIsHidden:
                  stamped !== null &&
                  hidden.some(function (l) { return l.contains(stamped); })
              };
            })()`,
          );
          note(`layer reading after the switch: ${JSON.stringify(reading)}`);
          expect(reading.layers).toBe(2);
          expect(reading.shown).toBe(1);
          expect(reading.shownPanes).toBeGreaterThan(0);
          // The workspace we left is still standing, with no boxes.
          expect(reading.hiddenPanes).toBeGreaterThan(0);
          expect(reading.hiddenPanesWithBoxes).toBe(0);
          // And the very element holding the transcript is one of the things
          // standing in it — the same node, not a rebuilt one.
          expect(reading.stampedIsInDocument).toBe(true);
          expect(reading.stampedIsHidden).toBe(true);

          // ---- 4b. And it measures nothing while it is hidden.
          //
          // The title bar publishes its controls' width as a custom property
          // so the masthead can run its lower lines under them — a DOM write
          // off a `ResizeObserver`, and a `display: none` subtree resizes to
          // nothing the moment it is hidden. An unguarded observer therefore
          // writes `0px` into a bar that has not changed, and the bar wears
          // that number until something resizes it again. Every canvas
          // geometry has the same shape, which is why the rule is that a
          // hidden workspace measures nothing ((#geometry-on-show)).
          const hiddenBars = await app.evalJS<string[]>(
            `Array.prototype.map.call(
               document.querySelectorAll(
                 '[data-space-layer]:not([data-space-shown]) [data-testid="tug-pane-title-bar"]'
               ),
               function (bar) {
                 return bar.style.getPropertyValue('--tugx-pane-controls-width') || "(unset)";
               }
             )`,
          );
          note(`hidden title bars: ${JSON.stringify(hiddenBars)}`);
          expect(hiddenBars.length).toBeGreaterThan(0);
          expect(hiddenBars).not.toContain("0px");

          // ---- 5. Back again: the same node, at the same pixel, with no
          // replay in between.
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(SPACE_ONE)} }), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(SPACE_ONE)}`,
            { timeoutMs: 8_000 },
          );

          const landed = await app.evalJS<{
            sameNode: boolean;
            scrollTop: number;
          }>(
            `(function(){
              var stamped = document.querySelector('[' + ${JSON.stringify(STAMP)} + ']');
              var live = document.querySelector(${JSON.stringify(SCROLLER)});
              return {
                sameNode: stamped !== null && stamped === live,
                scrollTop: live === null ? -1 : live.scrollTop
              };
            })()`,
          );
          note(`after the return: ${JSON.stringify(landed)}`);
          expect(landed.sameNode).toBe(true);
          expect(Math.abs(landed.scrollTop - savedTop)).toBeLessThanOrEqual(
            RESTORE_TOLERANCE_PX,
          );
          expect(await app.getActiveCardId()).toBe("A");

          // ---- 6. A press on a parked workspace's row that travels switches
          // nothing. The gesture runs in one pass because what it proves is
          // true only while the pointer is down — and the reading that matters
          // is taken immediately after the pointerdown, which is exactly where
          // the switch used to land.
          await app.dispatchControlAction("toggle-cards");
          const PARKED_ROW = `.cards-list .cards-row[data-cards-space-run=${JSON.stringify(SPACE_TWO)}][data-cards-row-id]`;
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(PARKED_ROW)}) !== null`,
            { timeoutMs: 15_000 },
          );
          const pressed = await app.evalJS<{
            activeAfterPress: string;
            engaged: boolean;
            activeAfterTravel: string;
          }>(
            `(function(){
              var row = document.querySelector(${JSON.stringify(PARKED_ROW)});
              if (row === null) throw new Error("no parked row");
              var r = row.getBoundingClientRect();
              var opts = function (cx, cy) {
                return { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, button: 0 };
              };
              var x = r.left + r.width / 2;
              var y = r.top + r.height / 2;
              row.dispatchEvent(new PointerEvent("pointerdown", opts(x, y)));
              var activeAfterPress = window.tugdeck.diag.getSpaces().activeSpaceId;
              window.dispatchEvent(new PointerEvent("pointermove", opts(x, y + 8)));
              var engaged = row.getAttribute("data-dragging") === "true";
              window.dispatchEvent(new PointerEvent("pointerup", opts(x, y + 8)));
              return {
                activeAfterPress: activeAfterPress,
                engaged: engaged,
                activeAfterTravel: window.tugdeck.diag.getSpaces().activeSpaceId
              };
            })()`,
          );
          note(`the parked press: ${JSON.stringify(pressed)}`);
          // The press claimed the gesture rather than acting on it.
          expect(pressed.engaged).toBe(true);
          expect(pressed.activeAfterPress).toBe(SPACE_ONE);
          expect(pressed.activeAfterTravel).toBe(SPACE_ONE);
          // A drag swallows its own trailing click, so nothing arrives late.
          await settle();
          expect(
            await app.evalJS<string>(
              `window.tugdeck.diag.getSpaces().activeSpaceId`,
            ),
          ).toBe(SPACE_ONE);

          // ---- 7. The mark. What this column reports is visibility, so it
          // reports it with an eye: open on the workspace being drawn, closed
          // on the ones that are not. A dot is the house's ACTIVITY mark and
          // carries a phase, which being the workspace you are in is not.
          const marks = await app.evalJS<
            { id: string; active: string | null; eye: string; column: number }[]
          >(
            `Array.prototype.map.call(
              document.querySelectorAll("[data-space-layer][data-space-shown] .cards-space-header"),
              function (el) {
                var glyph = el.querySelector(".cards-header-glyph");
                return {
                  id: el.getAttribute("data-cards-space-id"),
                  active: el.getAttribute("data-cards-space-active"),
                  eye: glyph === null
                    ? "no-column"
                    : glyph.querySelector(".lucide-eye") !== null
                      ? "open"
                      : glyph.querySelector(".lucide-eye-closed") !== null
                        ? "closed"
                        : "none",
                  column: glyph === null ? -1 : Math.round(glyph.getBoundingClientRect().width)
                };
              },
            )`,
          );
          note(`the workspace marks: ${JSON.stringify(marks)}`);
          const active = marks.filter((m) => m.active === "true");
          const parked = marks.filter((m) => m.active !== "true");
          expect(active.map((m) => m.id)).toEqual([SPACE_ONE]);
          expect(parked.length).toBeGreaterThan(0);
          // The open eye on the one workspace on screen, the closed one on
          // every other: the same fact in two states rather than a mark that
          // is sometimes simply absent.
          expect(active.every((m) => m.eye === "open")).toBe(true);
          expect(parked.every((m) => m.eye === "closed")).toBe(true);
          // The column is the same width whether or not it holds the mark, so
          // no name moves when the mark does.
          expect(new Set(marks.map((m) => m.column)).size).toBe(1);
          expect(marks[0].column).toBeGreaterThan(0);

          // ---- 8. And the door still opens. The press moved to the click;
          // it did not go away. A press on the same parked row that stays a
          // click selects the row and fronts its card, and fronting a card
          // that lives somewhere else is what takes the user there.
          const parkedRow = `.cards-list .cards-row[data-cards-space-run=${JSON.stringify(SPACE_TWO)}][data-cards-row-id]`;
          await app.evalJS<null>(
            `(function(){
              var row = document.querySelector(${JSON.stringify(parkedRow)});
              if (row === null) throw new Error("no parked row");
              var r = row.getBoundingClientRect();
              var x = r.left + r.width / 2;
              var y = r.top + r.height / 2;
              var opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0 };
              row.dispatchEvent(new PointerEvent("pointerdown", opts));
              window.dispatchEvent(new PointerEvent("pointerup", opts));
              row.dispatchEvent(new MouseEvent("click", opts));
              return null;
            })()`,
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(SPACE_TWO)}`,
            { timeoutMs: 8_000 },
          );
          note("the untravelled press switched, as a click");
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a workspace switched into is laid out exactly as one booted into",
      async () => {
        // Reached by a switch: the workspace was hidden while the deck it is
        // laid out against was being measured, and every reading it takes has
        // to wait for the commit that shows it.
        const switched = await framesReached(SPACE_ONE, async (app) => {
          await app.evalJS<null>(
            `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(SPACE_TWO)} }), null)`,
          );
        });
        // Reached by a boot: it was never hidden, so this is what the layout
        // is worth.
        const booted = await framesReached(SPACE_TWO, async () => {});

        note(`at0587 frames, switched into: ${JSON.stringify(switched)}`);
        note(`at0587 frames, booted into:   ${JSON.stringify(booted)}`);

        // Not a subset and not a tolerance: the same four frames on the same
        // pixels. A geometry taken in the dark reads zero, and a zero that
        // stuck would show up here as a rail of no width or a strip anchored
        // at the canvas edge.
        expect(Object.keys(switched).sort()).toEqual(
          ["p-F1", "p-F2", "p-F3", "p-rail"],
        );
        expect(switched).toEqual(booted);
        // And the rail is a rail either way — the one frame whose width the
        // band's inset is derived from, stated on its own so a failure names
        // it rather than leaving it in a diff of four objects.
        expect(switched["p-rail"].width).toBeGreaterThan(0);
        expect(switched["p-rail"].width).toBe(booted["p-rail"].width);
      },
      TEST_TIMEOUT_MS,
    );
  },
);

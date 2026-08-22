/**
 * at0372-bullseye.test.ts — ⌃⌘B puts the focused card in a centred,
 * comfy-width reading posture, and every exit door puts it back exactly.
 *
 * **The load-bearing claim is the no-write one.** A probe that "centred the
 * pane" by calling `movePane` with a computed rect would pass every geometry
 * assertion in this file and fail only the store-record one — and it would be
 * the worse implementation by a distance, because `movePane` calls
 * `scheduleSave()` unconditionally and rewrites the `widthPreset` stamp on any
 * width change. Within one save debounce the posture is in the persisted blob
 * and the user's stamp is gone, so a crash or quit mid-bullseye strands them
 * in a stance they thought was temporary. That is the failure this test
 * exists to make impossible to ship, which is why the store read sits in the
 * middle of the geometry assertions rather than at the end as a formality.
 *
 * What the other assertions are chosen to catch:
 *
 *  1. **The frame is the imposer's one-up placement, not new centring math.**
 *     Width is asserted at exactly 800 and the frame's centre against the
 *     band's centre, computed from the container rect and the LIVE
 *     `--tug-imposer-inset-*` values rather than from a number typed here —
 *     so an implementation that centred in the canvas instead of the band
 *     (ignoring the rails) fails, which is precisely the mistake that reads
 *     as correct on a deck with no Lens open.
 *  2. **Every exit door, one case per row of the plan's table.** The two
 *     shapes fail differently and both are covered: the focus-shaped doors
 *     (a second chord, clicking another pane, clicking bare canvas) are a
 *     DERIVATION over the first responder, while the geometry-shaped doors
 *     (the width popup, the deck-wide Card Width) are explicit clears at the
 *     mutation sites. The `set-content-width` case is the one an
 *     implementation gated on call sites rather than on what changed would
 *     miss, because it bypasses `movePane` entirely.
 *  3. **Exit is pixel-identical, not approximately right.** Each door's
 *     rect is compared against the rect captured before entry, to the pixel.
 *     "Restores nothing because it disturbed nothing" is only worth claiming
 *     if it is exact.
 *  4. **An imposed pane returns to its slot.** Bullseye takes precedence
 *     over the imposition while it holds and hands the pane back to it on
 *     exit, which is the branch-ordering claim in `tug-pane.tsx`.
 *  5. **A rail bullseyes, and its place stays reserved.** The Lens takes the
 *     posture like any other pane, and the assertion that separates that from
 *     a HIDE is the band's centre: read before entry, it is the same number
 *     the bullseyed Lens is centred on and the same number the band still
 *     reports while it holds. A rail treated as gone would hand its inset
 *     back, the chain would re-impose wider, and both would move. The menu
 *     gate is read in the same breath, enabled and then checked, so the gate
 *     and the geometry answer from the same derived value.
 *  6. **The other content panes leave, and the rails do not.** A card that
 *     is merely dimmed is still a card you can read, so every other content
 *     pane slides off the horizontal edge it was nearest — asserted as no
 *     overlap with the canvas at all, plus the side it left by, since a pane
 *     sent out the wrong edge is equally invisible and equally wrong. The
 *     rail is asserted UNMOVED in the same breath: a rail that left would
 *     take the band's insets with it and the bullseyed card would jump the
 *     moment the posture began.
 *
 * What this fixture deliberately cannot prove:
 *
 *  - **The recede's colour.** It is a themed, transitioning value; read
 *     mid-flight it returns an interpolated `oklab(...)`. The `data-bullseye`
 *     hook is asserted instead, and the token values are the theme-contrast
 *     audit's job.
 *  - **The tween's intermediate frames.** Background app-test windows run no
 *     rAF, and an assertion hung on an animation's mid-state is banned by the
 *     harness doctrine. Every rect here is read after the settle window.
 *  - **`AppDelegate.swift`.** The Swift half — the item, its identifier, the
 *     swept key equivalent — is pinned by `at0181-keymap-chord-sweep`, the
 *     same division at0371 follows.
 *
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/deck-store-selectors.ts
 * @covers tugdeck/src/layout-tree.ts
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/components/tugways/action-vocabulary.ts
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/lib/host-menu-state.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import { chooseWidth } from "./fixtures/card-width";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
} from "./_harness/tugbank-helpers";

/** Where `settings-api.ts` writes the v4 layout blob. */
const LAYOUT_DOMAIN = "dev.tugtool.deck.layout";
const LAYOUT_KEY = "layout";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The title bar's bullseye control — the pane-addressed door. */
const TARGET_BUTTON = '[data-testid="tug-pane-title-bar-bullseye-button"]';

/** Comfy, as `lib/layout-imposer.ts` fixes it — bullseye's one width. */
const COMFY = 800;
/** Slim, for the explicit-width exit door. */
const SLIM = 675;

/** Seeded widths chosen so no preset resolves to them: a pane that moved
 *  because something reached every pane is unmistakable from one that did
 *  not move at all. */
const SEEDED_WIDTH = 511;
const LENS_WIDTH = 412;

/** The settle window (`IMPOSITION_SETTLE_MS`), with room for the tween. */
const AFTER_LAND_MS = 900;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PaneRecord {
  position: { x: number; y: number };
  size: { width: number; height: number };
  slot: number | null;
  widthPreset: string | null;
}

/**
 * Two free content panes and a pinned Lens. Free rather than slotted so the
 * ordinary case is the plain one; the imposed case gets its own seed below.
 */
function freeDeck(): Record<string, unknown> {
  const pane = (id: string, x: number, cardId: string) => ({
    id,
    position: { x, y: 40 },
    size: { width: SEEDED_WIDTH, height: 620 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
  });
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Card A", closable: true },
      { id: "B", componentId: "gallery-accordion", title: "Card B", closable: true },
      { id: "L", componentId: "lens", title: "Lens", closable: true },
    ],
    panes: [
      pane("p1", 40, "A"),
      pane("p2", 60, "B"),
      {
        id: "pLens",
        position: { x: 0, y: 0 },
        size: { width: LENS_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Lens",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "p1",
    imposition: { sidebars: { lens: { side: "right" } } },
    hasFocus: true,
  };
}

/**
 * A full `three-up`: slots 0, 1, 2 left to right, plus the Lens. The seeded
 * `position.x` values are deliberately all bunched at the left and in an
 * order that does NOT match the slots — because an imposed pane's stored
 * position is a last-known value the imposer superseded, and reading it
 * instead of the resolved pin is what once sent all three cards out the same
 * edge.
 */
function threeUpDeck(): Record<string, unknown> {
  const pane = (
    id: string,
    cardId: string,
    slot: number,
  ): Record<string, unknown> => ({
    id,
    position: { x: 40 + slot * 4, y: 40 },
    size: { width: SEEDED_WIDTH, height: 620 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Card A", closable: true },
      { id: "B", componentId: "gallery-accordion", title: "Card B", closable: true },
      { id: "C", componentId: "gallery-accordion", title: "Card C", closable: true },
      { id: "L", componentId: "lens", title: "Lens", closable: true },
    ],
    panes: [
      pane("pLeft", "A", 0),
      pane("pMid", "B", 1),
      pane("pRight", "C", 2),
      {
        id: "pLens",
        position: { x: 0, y: 0 },
        size: { width: LENS_WIDTH, height: 900 },
        cardIds: ["L"],
        activeCardId: "L",
        title: "Lens",
        acceptsFamilies: [],
      },
    ],
    activePaneId: "pMid",
    imposition: { kind: "three-up", sidebars: { lens: { side: "right" } } },
    hasFocus: true,
  };
}

/** The same deck under `three-up`, with both content panes slotted. */
function imposedDeck(): Record<string, unknown> {
  const shape = freeDeck() as {
    panes: Record<string, unknown>[];
    imposition: Record<string, unknown>;
  };
  shape.panes[0].slot = 0;
  shape.panes[1].slot = 2;
  shape.imposition = { kind: "three-up", sidebars: { lens: { side: "right" } } };
  return shape as unknown as Record<string, unknown>;
}

const RECT_JS = (paneId: string): string =>
  `(function () {
    var r = document.querySelector('.tug-pane[data-pane-id="${paneId}"]').getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  })()`;

async function paneRect(app: App, paneId: string): Promise<Rect> {
  return app.evalJS<Rect>(RECT_JS(paneId));
}

async function paneRecord(app: App, paneId: string): Promise<PaneRecord> {
  const record = await app.evalJS<PaneRecord | null>(
    `window.__tug.getPaneRecord(${JSON.stringify(paneId)})`,
  );
  if (record === null) throw new Error(`no pane record for "${paneId}"`);
  return record;
}

/**
 * The band's centre in viewport x — the canvas minus the rails and their
 * gaps, from the LIVE `--tug-imposer-inset-*` values, so this is the
 * imposer's own idea of the band rather than a number transcribed from it.
 *
 * Each inset is measured by giving a throwaway probe that inset as its width
 * and reading the rect back. `getComputedStyle().getPropertyValue()` is no
 * use here: a custom property resolves to its declared TEXT, and these are
 * declared as `calc(var(--tug-sidebar-width-right) + 8px)` — `parseFloat` of
 * that is `NaN`, which silently reads as a zero inset and turns this
 * function into "the canvas centre", i.e. exactly the wrong answer the
 * assertion exists to catch. Layout is what resolves a calc, so the probe
 * goes through layout.
 */
async function bandCentreX(app: App): Promise<number> {
  return app.evalJS<number>(
    `(function () {
      var host = document.querySelector("[data-deck-canvas-background]");
      if (host === null) throw new Error("frames container not found");
      function inset(side) {
        var probe = document.createElement("div");
        probe.style.position = "absolute";
        probe.style.top = "0px";
        probe.style.left = "0px";
        probe.style.height = "1px";
        probe.style.visibility = "hidden";
        probe.style.pointerEvents = "none";
        probe.style.width = "var(--tug-imposer-inset-" + side + ", 0px)";
        host.appendChild(probe);
        var w = probe.getBoundingClientRect().width;
        probe.remove();
        return w;
      }
      var r = host.getBoundingClientRect();
      var left = inset("left");
      var right = inset("right");
      return Math.round(r.left + left + (r.width - left - right) / 2);
    })()`,
  );
}

/**
 * The canvas-background deselect, driven as the gesture it is: a pointerdown
 * on the background surface, which `pane-focus-controller.ts` answers with
 * `deselectActiveCard()`. There is no control-action door for it, and there
 * should not be — the door under test is the click.
 */
async function clickBareCanvas(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var bg = document.querySelector("[data-deck-canvas-background]");
      if (bg === null) throw new Error("canvas background marker not found");
      bg.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, composed: true, view: window,
        pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0,
      }));
      return null;
    })()`,
  );
  await wait(AFTER_LAND_MS);
}

/** `state === 1` is `NSControl.StateValue.on` — the item's check mark. */
async function menuItem(
  app: App,
  identifier: string,
): Promise<{ enabled: boolean; checked: boolean }> {
  const snapshot = await app.menuItemState(identifier);
  if (!snapshot.found) throw new Error(`menu item "${identifier}" not found`);
  return { enabled: snapshot.enabled, checked: snapshot.state === 1 };
}

/** Press ⌃⌘B and wait out the settle so every rect is read at rest. */
async function bullseyeChord(app: App): Promise<void> {
  await app.nativeKey("b", ["ctrl", "cmd"]);
  await wait(AFTER_LAND_MS);
}

/** The width popup, then the settle — the door the retired ⌃⌘ digits used to
 *  stand beside. Both doors land on `set-card-width` and reach the store
 *  through `movePane`, which is the whole of what this test needs from it. */
async function setWidth(
  app: App,
  paneId: string,
  preset: "slim" | "comfy" | "wide",
): Promise<void> {
  await chooseWidth(app, paneId, preset);
  await wait(AFTER_LAND_MS);
}

async function focusCard(app: App, cardId: string): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("focus-session-card", { cardId: ${JSON.stringify(cardId)} }), null)`,
  );
  await wait(AFTER_LAND_MS);
}

async function isBullseyed(app: App, paneId: string): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector('.tug-pane[data-pane-id="${paneId}"]').hasAttribute('data-bullseye')`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0372 — bullseye is a presentation, and every exit door is exact",
  () => {
    test(
      "entry centres at comfy without writing geometry, and each exit door restores the rect",
      async () => {
        const app = await launchTugApp({ testName: "at0372-bullseye" });
        try {
          await app.seedDeckState({ state: freeDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-pane-id]').length === 3`,
            { timeoutMs: 8_000 },
          );
          await wait(AFTER_LAND_MS);

          const restRect = await paneRect(app, "p1");
          const restRecord = await paneRecord(app, "p1");
          const otherRect = await paneRect(app, "p2");
          const lensRect = await paneRect(app, "pLens");
          expect(restRect.width).toBe(SEEDED_WIDTH);

          // --- Entry: comfy, centred in the band, full vertical run. --------
          await bullseyeChord(app);
          const inRect = await paneRect(app, "p1");
          expect(inRect.width).toBe(COMFY);
          const centre = Math.round(inRect.left + inRect.width / 2);
          // One pixel of slack for the sub-pixel rounding in the calc chain;
          // an implementation centring in the CANVAS rather than the band
          // misses by half the Lens's width, not by one.
          expect(Math.abs(centre - (await bandCentreX(app)))).toBeLessThanOrEqual(1);
          // The run is top gap to bottom gap, not the pane's stored height.
          expect(inRect.height).toBeGreaterThan(restRect.height);
          expect(await isBullseyed(app, "p1")).toBe(true);

          // --- The no-write claim, read WHILE bullseyed. --------------------
          // Nothing the store holds moved: not the width the frame is
          // visibly not at, not the position, not the slot, not the stamp.
          const heldRecord = await paneRecord(app, "p1");
          expect(heldRecord).toEqual(restRecord);
          expect(heldRecord.size.width).toBe(SEEDED_WIDTH);

          // --- The other content pane has LEFT the canvas. ------------------
          // Receding a card that is still sitting there is not what
          // distraction-free means, so every other content pane slides off
          // the horizontal edge it was nearest. Asserted as "no overlap with
          // the canvas at all" rather than against a specific coordinate:
          // the exit distance is a percentage of the canvas and the point is
          // that none of the pane remains visible.
          const canvas = await app.evalJS<Rect>(
            `(function () {
              var r = document.querySelector("[data-deck-canvas-background]").getBoundingClientRect();
              return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
            })()`,
          );
          const gone = await paneRect(app, "p2");
          expect(
            gone.left + gone.width <= canvas.left || gone.left >= canvas.left + canvas.width,
          ).toBe(true);
          // It left by the side it was ON, relative to the bullseyed card:
          // p2 is seeded at x=60, just right of p1 at x=40, so it goes RIGHT
          // — even though both sit left of the canvas centre. Asserting the
          // side and not merely the absence is the point; a pane sent out the
          // wrong edge still passes the overlap test above.
          expect(gone.left).toBeGreaterThanOrEqual(canvas.left + canvas.width);

          // The rail, by contrast, keeps its pin. A rail that left would take
          // the band's insets with it and the bullseyed card would jump the
          // moment the posture began.
          expect(await paneRect(app, "pLens")).toEqual(lensRect);

          // The Window item reports checked while the posture holds.
          expect(await menuItem(app, "window.bullseye")).toEqual({
            enabled: true,
            checked: true,
          });

          // The [P03] tell, in the UI: the frame is painted at comfy, and
          // Window ▸ Comfy is NOT checked — because the STORE never took
          // comfy, and a settled control shows what the store holds. An
          // implementation that centred the pane by writing width would tick
          // this row, which is the visible face of the same bug the store
          // read above catches.
          expect((await menuItem(app, "window.cardWidth.comfy")).checked).toBe(false);
          expect((await menuItem(app, "window.cardWidth.slim")).checked).toBe(false);
          expect((await menuItem(app, "window.cardWidth.wide")).checked).toBe(false);

          // --- Exit door 1: the chord again. --------------------------------
          await bullseyeChord(app);
          expect(await paneRect(app, "p1")).toEqual(restRect);
          expect(await isBullseyed(app, "p1")).toBe(false);
          // The pane that left comes all the way back, to the pixel. Nothing
          // was written on the way out, so there is nothing to restore
          // wrongly — this is what that claim looks like from outside.
          expect(await paneRect(app, "p2")).toEqual(otherRect);
          expect((await menuItem(app, "window.bullseye")).checked).toBe(false);

          // --- Exit door 2: focus moves to another pane. --------------------
          // A derivation, not a handler: nothing clears the field, the
          // accessor simply stops matching.
          await bullseyeChord(app);
          expect(await isBullseyed(app, "p1")).toBe(true);
          await focusCard(app, "B");
          expect(await paneRect(app, "p1")).toEqual(restRect);
          expect(await isBullseyed(app, "p1")).toBe(false);
          // ...and it did not transfer to the pane that took focus.
          expect(await isBullseyed(app, "p2")).toBe(false);

          // --- Exit door 3: a click on bare canvas. -------------------------
          await focusCard(app, "A");
          await bullseyeChord(app);
          expect(await isBullseyed(app, "p1")).toBe(true);
          await clickBareCanvas(app);
          expect(await paneRect(app, "p1")).toEqual(restRect);
          expect(await isBullseyed(app, "p1")).toBe(false);
          // With nothing selected the command does not apply at all.
          expect((await menuItem(app, "window.bullseye")).enabled).toBe(false);

          // --- Exit door 4: an explicit width (the `movePane` clear). -------
          // Choosing Slim must land the pane at slim AT ITS STORED POSITION,
          // not at comfy centred: the explicit gesture wins over the posture.
          await focusCard(app, "A");
          await bullseyeChord(app);
          expect(await isBullseyed(app, "p1")).toBe(true);
          await setWidth(app, "p1", "slim");
          expect(await isBullseyed(app, "p1")).toBe(false);
          const afterWidth = await paneRect(app, "p1");
          expect(afterWidth.width).toBe(SLIM);
          expect(afterWidth.left).toBe(restRect.left);
          expect(afterWidth.top).toBe(restRect.top);

          // --- Exit door 5: the deck-wide Card Width (`setContentWidth`). ---
          // The row a call-site-shaped implementation would miss: this path
          // builds its pane array inline and bypasses `movePane` entirely.
          await bullseyeChord(app);
          expect(await isBullseyed(app, "p1")).toBe(true);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-content-width", { preset: "wide" }), null)`,
          );
          await wait(AFTER_LAND_MS);
          expect(await isBullseyed(app, "p1")).toBe(false);
          expect((await paneRect(app, "p1")).width).toBe(1230);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a rail bullseyes with its place reserved, and an imposed pane returns to its slot",
      async () => {
        const app = await launchTugApp({ testName: "at0372-bullseye-imposed" });
        try {
          await app.seedDeckState({ state: imposedDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-pane-id]').length === 3`,
            { timeoutMs: 8_000 },
          );
          await wait(AFTER_LAND_MS);

          // --- A rail takes the posture, and its edge stays reserved. -------
          // The claim that separates this from a hide: while the Lens stands
          // in the middle of the band, the band is still inset by the rail's
          // width on the right. A rail that had been treated as gone would
          // hand that inset back, the chain would re-impose wider, and the
          // Lens would land somewhere else on exit. So the band centre is
          // read BEFORE entry and asserted to be the same one the bullseyed
          // Lens is centred on — one number that can only agree if the place
          // was held open.
          const lensRect = await paneRect(app, "pLens");
          const lensRecord = await paneRecord(app, "pLens");
          const bandBefore = await bandCentreX(app);
          await focusCard(app, "L");
          expect((await menuItem(app, "window.bullseye")).enabled).toBe(true);

          await bullseyeChord(app);
          expect(await isBullseyed(app, "pLens")).toBe(true);
          const lensIn = await paneRect(app, "pLens");
          expect(lensIn.width).toBe(COMFY);
          expect(
            Math.abs(Math.round(lensIn.left + lensIn.width / 2) - bandBefore),
          ).toBeLessThanOrEqual(1);
          expect(await bandCentreX(app)).toBe(bandBefore);
          // And nothing about the rail's record moved — the side and the
          // width the band is inset by are exactly what they were.
          expect(await paneRecord(app, "pLens")).toEqual(lensRecord);
          expect((await menuItem(app, "window.bullseye")).checked).toBe(true);

          // Out again, to the pixel: the rail drops back onto the edge it
          // never stopped holding.
          await bullseyeChord(app);
          expect(await paneRect(app, "pLens")).toEqual(lensRect);
          expect(await isBullseyed(app, "pLens")).toBe(false);

          // --- An imposed pane bullseyes and returns to its slot anchor. ----
          await focusCard(app, "A");
          const slotRect = await paneRect(app, "p1");
          const slotRecord = await paneRecord(app, "p1");
          expect(slotRecord.slot).toBe(0);

          await bullseyeChord(app);
          const inRect = await paneRect(app, "p1");
          expect(inRect.width).toBe(COMFY);
          expect(await isBullseyed(app, "p1")).toBe(true);
          // A bullseyed pane is not standing in its slot while it holds the
          // posture, so it renders no `data-imposed` — but the store still
          // says slot 0, which is what it returns to.
          expect(
            await app.evalJS<boolean>(
              `document.querySelector('.tug-pane[data-pane-id="p1"]').hasAttribute('data-imposed')`,
            ),
          ).toBe(false);
          expect(await paneRecord(app, "p1")).toEqual(slotRecord);

          await bullseyeChord(app);
          expect(await paneRect(app, "p1")).toEqual(slotRect);
          expect(await isBullseyed(app, "p1")).toBe(false);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the title bar's target button is a door of its own, on a card and on a rail",
      async () => {
        // The button is PANE-ADDRESSED where the chord is selection-relative:
        // it names the pane it stands on. Pressing one on a background pane
        // therefore has to do two things in one gesture — activate that pane
        // and put it in the posture — and the assertion that it landed on the
        // pane whose button was pressed is what a chord-shaped implementation
        // (dispatch `toggle-bullseye` and hope) would fail here.
        const app = await launchTugApp({ testName: "at0372-bullseye-button" });
        try {
          // The IMPOSED seed, not the free one, for a pointer test: the free
          // deck's two panes are seeded 20px apart and overlap by most of
          // their width, so the background pane's control cluster sits under
          // the raised pane and the click lands on the wrong frame. Slots 0
          // and 2 put a whole slot of air between them.
          await app.seedDeckState({ state: imposedDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-pane-id]').length === 3`,
            { timeoutMs: 8_000 },
          );
          await wait(AFTER_LAND_MS);

          const button = (paneId: string): string =>
            `.tug-pane[data-pane-id="${paneId}"] ${TARGET_BUTTON}`;

          // Every pane has one, rails included.
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(TARGET_BUTTON)}).length`,
            ),
          ).toBe(3);

          // --- On a BACKGROUND content pane. --------------------------------
          const restRect = await paneRect(app, "p2");
          const restRecord = await paneRecord(app, "p2");
          await app.nativeClickAtElement(button("p2"));
          await wait(AFTER_LAND_MS);
          // The press did both halves in one gesture: it raised the pane it
          // stands on, and put THAT pane in the posture.
          expect(
            await app.evalJS<string | null>(
              `(function(){var e=document.querySelector('.tug-pane[data-focused="true"]');return e?e.getAttribute('data-pane-id'):null;})()`,
            ),
          ).toBe("p2");
          expect(await isBullseyed(app, "p2")).toBe(true);
          expect(await isBullseyed(app, "p1")).toBe(false);
          expect((await paneRect(app, "p2")).width).toBe(COMFY);
          // Still a presentation, whichever door opened it.
          expect(await paneRecord(app, "p2")).toEqual(restRecord);
          // The button says so, which is what makes a second press read as
          // an exit rather than a no-op.
          expect(
            await app.getElementAttribute(button("p2"), "aria-pressed"),
          ).toBe("true");

          // --- And the same button takes it back out. -----------------------
          await app.nativeClickAtElement(button("p2"));
          await wait(AFTER_LAND_MS);
          expect(await isBullseyed(app, "p2")).toBe(false);
          expect(await paneRect(app, "p2")).toEqual(restRect);

          // --- On the RAIL, where the button is the only pointer door. ------
          const lensRect = await paneRect(app, "pLens");
          await app.nativeClickAtElement(button("pLens"));
          await wait(AFTER_LAND_MS);
          expect(await isBullseyed(app, "pLens")).toBe(true);
          expect((await paneRect(app, "pLens")).width).toBe(COMFY);
          // A bullseyed rail exposes no edge: its one handle drags the RAIL's
          // width from the deck edge, and the frame is not standing there.
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll('.tug-pane[data-pane-id="pLens"] .tug-pane-resize').length`,
            ),
          ).toBe(0);

          await app.nativeClickAtElement(button("pLens"));
          await wait(AFTER_LAND_MS);
          expect(await isBullseyed(app, "pLens")).toBe(false);
          expect(await paneRect(app, "pLens")).toEqual(lensRect);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the leaving pane is animated out, and comes back by the edge it left",
      async () => {
        // The motion carries the meaning: a card that vanishes reads as
        // CLOSED, while a card you watch slide off the edge reads as moved
        // aside and retrievable. So "it ends up offscreen" is not enough to
        // assert — it has to be seen going.
        //
        // This is a legitimate assertion on animation despite the harness
        // rule against hanging outcomes on motion, because nothing here
        // races it: every tween is PAUSED and its `currentTime` pinned, so
        // the frame under test is exact rather than whatever the sampler
        // happened to catch. The resting outcome is asserted separately, in
        // the cases above.
        //
        // What it defends: the travel on the two sides being equal. An
        // earlier cut parked left-leaving panes a full canvas-width out
        // while right-leaving ones stopped just past the edge. The spring is
        // critically damped, so it spends most of its distance early — over
        // that much travel the card was gone within ~50ms and read as having
        // simply disappeared, while the return, which decelerates INTO view,
        // looked fine. Same tween, opposite direction, and only one of them
        // legible. A regression here would be silent in every resting-rect
        // assertion in this file.
        const app = await launchTugApp({ testName: "at0372-bullseye-motion" });
        try {
          await app.seedDeckState({ state: freeDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-pane-id]').length === 3`,
            { timeoutMs: 8_000 },
          );
          await wait(AFTER_LAND_MS);

          const canvasJS = `document.querySelector("[data-deck-canvas-background]").getBoundingClientRect()`;
          /** Pin every running tween to `ms` and read the frozen rects. */
          const pinAt = async (ms: number): Promise<Record<string, number[]>> =>
            app.evalJS<Record<string, number[]>>(
              `(function () {
                var out = {};
                document.querySelectorAll('.tug-pane[data-pane-id]').forEach(function (el) {
                  el.getAnimations().forEach(function (a) { a.pause(); a.currentTime = ${ms}; });
                });
                document.querySelectorAll('.tug-pane[data-pane-id]').forEach(function (el) {
                  var r = el.getBoundingClientRect();
                  out[el.getAttribute('data-pane-id')] = [Math.round(r.left), Math.round(r.right), el.getAnimations().length];
                });
                var c = ${canvasJS};
                out.canvas = [Math.round(c.left), Math.round(c.right), 0];
                return out;
              })()`,
            );

          const homeLeft = (await paneRect(app, "p2")).left;

          // --- On the way OUT, caught in transit. ---------------------------
          await app.nativeKey("b", ["ctrl", "cmd"]);
          await wait(60);
          const out = await pinAt(40);
          // A tween is actually running on the leaving pane...
          expect(out["p2"][2]).toBeGreaterThan(0);
          // ...and the bullseyed pane is mid-flight too, not already parked.
          expect(out["p1"][2]).toBeGreaterThan(0);
          await wait(AFTER_LAND_MS * 2);
          const parkedLeft = (await paneRect(app, "p2")).left;
          // p2 sits just right of the bullseyed p1, so it leaves rightward.
          expect(parkedLeft).toBeGreaterThan(homeLeft);

          // Strictly BETWEEN home and parked at the pinned instant — the
          // direction-agnostic form of "it was seen going". Asserting a
          // straddle of a particular canvas edge would be wrong here: how far
          // a pane travels depends on where it started, and this fixture's
          // two cards are stacked at the far left, so the one leaving
          // rightward crosses the whole canvas.
          const outMid = out["p2"][0];
          expect(outMid).toBeGreaterThan(homeLeft + 20);
          expect(outMid).toBeLessThan(parkedLeft - 20);

          // --- On the way BACK, along the same line. ------------------------
          await app.nativeKey("b", ["ctrl", "cmd"]);
          await wait(60);
          const back = await pinAt(40);
          expect(back["p2"][2]).toBeGreaterThan(0);
          const backMid = back["p2"][0];
          expect(backMid).toBeGreaterThan(homeLeft + 20);
          expect(backMid).toBeLessThan(parkedLeft - 20);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "on a three-up, each dismissed card leaves by its own nearest edge",
      async () => {
        // Bullseye the MIDDLE slot: the left card must go left and the right
        // card must go right. This is the case that caught the real bug — the
        // edge was being decided from `position.x`, which for an imposed pane
        // is a stale last-known value the imposer superseded. Every pane in a
        // three-up can be stored at nearly the same x while sitting left,
        // centre and right on screen, so all three were reading as "left
        // half" and leaving by the same edge.
        //
        // The fixture seeds the stored positions bunched at the left ON
        // PURPOSE, so a regression to reading them fails here rather than
        // passing on a deck where stored and resolved happen to agree.
        const app = await launchTugApp({ testName: "at0372-bullseye-three-up" });
        try {
          await app.seedDeckState({ state: threeUpDeck(), focusCardId: "B" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-pane-id]').length === 4`,
            { timeoutMs: 8_000 },
          );
          await wait(AFTER_LAND_MS);

          const canvasOf = async (): Promise<Rect> =>
            app.evalJS<Rect>(
              `(function () {
                var r = document.querySelector("[data-deck-canvas-background]").getBoundingClientRect();
                return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
              })()`,
            );

          const canvas = await canvasOf();
          const restLeft = await paneRect(app, "pLeft");
          const restRight = await paneRect(app, "pRight");
          const restLens = await paneRect(app, "pLens");
          // Sanity: the fixture really is left / centre / right on screen,
          // whatever the stored positions say.
          expect(restLeft.left).toBeLessThan(restRight.left);

          await bullseyeChord(app);
          expect(await isBullseyed(app, "pMid")).toBe(true);

          const goneLeft = await paneRect(app, "pLeft");
          const goneRight = await paneRect(app, "pRight");
          const canvasRight = canvas.left + canvas.width;

          // The left card left by the LEFT edge...
          expect(goneLeft.left + goneLeft.width).toBeLessThanOrEqual(canvas.left);
          // ...and the right card by the RIGHT edge. Both fully off, by
          // opposite sides — the assertion the single-pane cases cannot make.
          expect(goneRight.left).toBeGreaterThanOrEqual(canvasRight);

          // The rail still stands.
          expect(await paneRect(app, "pLens")).toEqual(restLens);

          // And both come back to their slot anchors, to the pixel.
          await bullseyeChord(app);
          expect(await paneRect(app, "pLeft")).toEqual(restLeft);
          expect(await paneRect(app, "pRight")).toEqual(restRight);

          // --- The case that pins the rule: bullseye the LEFTMOST card. ----
          // Both remaining cards are to its RIGHT, so both must leave
          // rightward — even though the middle card sits left of the CANVAS
          // centre. Sorting around the canvas would send that one left,
          // straight through the card arriving at the middle. Sorting around
          // the bullseyed card's own former place cannot produce a crossing,
          // and this assertion is the difference between the two rules.
          await focusCard(app, "A");
          await bullseyeChord(app);
          expect(await isBullseyed(app, "pLeft")).toBe(true);

          const midGone = await paneRect(app, "pMid");
          const rightGone = await paneRect(app, "pRight");
          expect(midGone.left).toBeGreaterThanOrEqual(canvasRight);
          expect(rightGone.left).toBeGreaterThanOrEqual(canvasRight);

          await bullseyeChord(app);
          expect(await paneRect(app, "pRight")).toEqual(restRight);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "quitting while bullseyed persists no posture and no changed width",
      async () => {
        // The claim the no-write rule exists for, at the only layer that can
        // actually make it: the BYTES on disk after a quit taken mid-posture.
        // The unit test pins `serialize()`'s key set and the in-app read pins
        // the store record, but neither watches the save path — and the save
        // path is where the trap was. `movePane` calls `scheduleSave()`
        // unconditionally, so an implementation that centred the pane by
        // writing geometry would land the posture's width in this blob within
        // one debounce, and the user would come back to a stance they never
        // asked to keep.
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);

        try {
          // ── Phase A: bullseye a card, then quit while it holds. ──────────
          {
            const app = await launchTugApp({
              testName: "at0372-bullseye-reload-A",
              env: { TUGBANK_PATH: tugbankPath },
              persistInTestMode: true,
            });
            await app.seedDeckState({ state: freeDeck(), focusCardId: "A" });
            await app.waitForCondition<boolean>(
              `document.querySelectorAll('.tug-pane[data-pane-id]').length === 3`,
              { timeoutMs: 8_000 },
            );
            await wait(AFTER_LAND_MS);

            await bullseyeChord(app);
            expect(await isBullseyed(app, "p1")).toBe(true);
            expect((await paneRect(app, "p1")).width).toBe(COMFY);

            // Quit rather than close, so the deck takes its save path out.
            await app.quitGracefully();
          }

          // ── The blob on disk carries no posture and no moved width. ──────
          const onDisk = tugbankRead<Record<string, unknown>>(
            tugbankPath,
            LAYOUT_DOMAIN,
            LAYOUT_KEY,
          );
          expect(onDisk).not.toBeNull();
          const blob = onDisk!.value;
          expect(JSON.stringify(blob)).not.toContain("bullseye");
          const stored = (blob as { panes?: { id: string; size: { width: number } }[] })
            .panes?.find((p) => p.id === "p1");
          expect(stored).toBeDefined();
          expect(stored!.size.width).toBe(SEEDED_WIDTH);

          // ── Phase B: relaunch off that blob, un-bullseyed and intact. ────
          {
            const app = await launchTugApp({
              testName: "at0372-bullseye-reload-B",
              env: { TUGBANK_PATH: tugbankPath },
              persistInTestMode: true,
              restoreInTestMode: true,
            });
            try {
              await app.waitForCondition<boolean>(
                `document.querySelectorAll('.tug-pane[data-pane-id]').length === 3`,
                { timeoutMs: 8_000 },
              );
              await wait(AFTER_LAND_MS);

              expect(await isBullseyed(app, "p1")).toBe(false);
              expect(
                await app.evalJS<boolean>(
                  `document.querySelector("[data-deck-canvas-background]").hasAttribute("data-bullseye")`,
                ),
              ).toBe(false);
              expect((await paneRect(app, "p1")).width).toBe(SEEDED_WIDTH);
              expect((await paneRecord(app, "p1")).size.width).toBe(SEEDED_WIDTH);
            } finally {
              await app.close();
            }
          }
        } finally {
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

/**
 * at0451-lens-multiselect.test.ts — a layout verb acts on the selection, and
 * moves all of it at once.
 *
 * Before the layout selection there was one target and one way to name it: the
 * deck's first responder. That reading has a hole the user falls into daily —
 * with the keyboard in the Lens, the first responder IS the Lens card, which is
 * a rail, so `MOVE_TO_SLOT` refused every ⌘-digit typed while the Cards list
 * had focus. The chord did nothing and said nothing, at exactly the moment the
 * user was looking at the list of cards and deciding where to put one.
 *
 * `resolveLayoutSelection` replaces that reading with a ladder — the selection,
 * else the row the Cards list's cursor is standing on, else the first
 * responder, else nothing — and this test drives every rung through the real
 * chords against a real deck.
 *
 * The second test is the Cards list's own key and pointer model, which the
 * ladder is only half of. Space and Return stopped meaning the same thing: one
 * NAMES a row, the other OPENS it, and a list that acts on both leaves the
 * keyboard no way to say "this one" without opening it. ⇧+arrow extends and
 * ⌘+arrow walks, both taking the row they start from, because extension names
 * where the cursor LANDS and the origin row would otherwise be the one row the
 * walk could never reach — and the seed is the ARROW's doing, not the
 * modifier's, so a bare Shift held down selects nothing and the first ⇧↓ spends
 * itself on the origin row without moving the caret off it. And a plain click
 * MOVES the selection rather than activating a row and leaving the fill behind
 * on another one.
 *
 * Escape drops the selection before it does anything else, and it does so from
 * BOTH sides of the keyboard — which is the claim worth two presses rather than
 * one. The engine's Escape ladder outranks the responder chain at every rung,
 * and a plain click on a Cards row fronts the card it names and takes the
 * keyboard out of the Lens; so the press had two ways to be swallowed, each
 * reachable by an ordinary gesture, and which one the user was in was invisible.
 * The list CAPTURES Escape while it holds the keyboard and a set stands, and the
 * root responder registers a `CANCEL_DIALOG` entry for exactly as long as one
 * stands at all. Both presses are asserted, on a keyboard-made set and on a
 * mouse-made one.
 *
 * The second half is the batch. A multi-card move must be ONE arrangement, not
 * N: the FLIP settle in `deck-canvas.tsx` measures where the frames were on the
 * store event and where they landed after React's commit, so a gesture that
 * notifies once per card offers that measurement a half-moved deck each time
 * and re-arms the settle window on every one of them. That failure is invisible
 * to a geometry assertion — the cards still end up in the right places — so it
 * is held by the cut detector instead: a re-armed settle drops a frame mid-tween
 * and the detector records the jump. Zero cuts across a two-card move is the
 * assertion that the commit was single.
 *
 * @covers tugdeck/src/components/lens/lens-selection-store.ts
 * @covers tugdeck/src/lib/layout-selection.ts
 * @covers tugdeck/src/components/lens/sections/cards-section.tsx
 * @covers tugdeck/src/components/tugways/list-multi-select.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/lens/lens-content.tsx
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const FRAMES = ".tug-pane[data-pane-id]";
const LENS_WIDTH = 675;
const PANE_WIDTH = 420;
/** The settle window (`IMPOSITION_SETTLE_MS`) plus room for the tween to land. */
const AFTER_LAND_MS = 900;

interface CutRecord {
  kind: "jump" | "appeared";
  paneId: string;
}

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

function deckShape() {
  const card = (id: string, title: string) => ({
    id,
    componentId: "gallery-accordion",
    title,
    closable: true,
  });
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: PANE_WIDTH, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: [
      card("A", "Card A"),
      card("B", "Card B"),
      card("C", "Card C"),
      { id: "L", componentId: "lens", title: "Lens", closable: true },
    ],
    panes: [
      pane("p1", 0, "A"),
      pane("p2", 1, "B"),
      pane("p3", 2, "C"),
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
    imposition: { kind: "three-up", lens: "right" },
    hasFocus: true,
  };
}

/** Every content pane's slot, keyed by the card it holds. */
async function slotsByCard(app: App): Promise<Record<string, number | null>> {
  return app.evalJS<Record<string, number | null>>(
    `(function () {
      var deck = window.tugdeck.diag.getDeckState();
      var out = {};
      for (var i = 0; i < deck.panes.length; i += 1) {
        var pane = deck.panes[i];
        for (var j = 0; j < pane.cardIds.length; j += 1) {
          out[pane.cardIds[j]] = pane.slot === undefined ? null : pane.slot;
        }
      }
      return out;
    })()`,
  );
}

/** Every content pane's width preset, keyed by the card it holds. */
async function widthsByCard(app: App): Promise<Record<string, string | null>> {
  return app.evalJS<Record<string, string | null>>(
    `(function () {
      var deck = window.tugdeck.diag.getDeckState();
      var out = {};
      for (var i = 0; i < deck.panes.length; i += 1) {
        var pane = deck.panes[i];
        for (var j = 0; j < pane.cardIds.length; j += 1) {
          out[pane.cardIds[j]] =
            pane.widthPreset === undefined ? null : pane.widthPreset;
        }
      }
      return out;
    })()`,
  );
}

/** The card standing in front — the deck's composite first responder. */
async function frontCard(app: App): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function () {
      var deck = window.tugdeck.diag.getDeckState();
      var pane = deck.panes.find(function (p) { return p.id === deck.activePaneId; });
      return pane === undefined ? null : pane.activeCardId;
    })()`,
  );
}

async function setSelection(app: App, cardIds: string[]): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setLayoutSelection(${JSON.stringify(cardIds)}), null)`,
  );
}

async function getSelection(app: App): Promise<string[]> {
  return app.evalJS<string[]>(`window.__tug.getLayoutSelection()`);
}

/** The Cards row the movement cursor is standing on. */
const CURSOR_ROW = ".lens-cards-list .tug-list-view-cell[data-key-cursor]";

async function cursorTitle(app: App): Promise<string> {
  return app.evalJS<string>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(CURSOR_ROW)});
      return el === null ? "" : (el.textContent || "");
    })()`,
  );
}

/**
 * Park the cursor on the row whose text contains `title`.
 *
 * Home first, then down — never down from wherever the cursor happens to be.
 * The list's last row hands the arrow onward to the next Lens section rather
 * than clamping (the liveliness net), so a walk that starts below its target
 * leaves the Cards list entirely and the cursor stops existing. Fails loudly
 * rather than walking forever: a cursor that will not move is the interesting
 * failure.
 */
async function walkCursorTo(app: App, title: string): Promise<void> {
  await app.nativeKey("Home");
  await wait(150);
  for (let i = 0; i < 12; i += 1) {
    if ((await cursorTitle(app)).includes(title)) return;
    await app.nativeKey("ArrowDown");
    await wait(120);
  }
  throw new Error(
    `cursor never reached "${title}" (stopped on ${JSON.stringify(
      await cursorTitle(app),
    )})`,
  );
}

/**
 * Put the keyboard in the Cards list and wait until its cursor is painted.
 *
 * Called again after every slot chord, because assigning a slot RAISES the card
 * it moved and takes the keyboard with it — the Lens's documented slot-assign
 * exit, pinned by at0278. That is deliberate behavior this test rides rather
 * than fights.
 */
async function focusCardsList(app: App): Promise<void> {
  await app.dispatchControlAction("focus-lens");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(CURSOR_ROW)}) !== null`,
    { timeoutMs: 8_000 },
  );
}

/** Click the Cards row whose text contains `title`, on its title text — never
 *  on a close box or a slot button, which act on the row rather than pick it. */
async function clickRowTitled(app: App, title: string): Promise<boolean> {
  const box = await app.evalJS<{ x: number; y: number } | null>(
    `(function () {
      var rows = document.querySelectorAll(".lens-cards-list .tug-list-view-cell");
      for (var i = 0; i < rows.length; i += 1) {
        if ((rows[i].textContent || "").indexOf(${JSON.stringify(title)}) === -1) continue;
        var label = rows[i].querySelector(".tug-list-row-content") || rows[i];
        var r = label.getBoundingClientRect();
        return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) };
      }
      return null;
    })()`,
  );
  if (box === null) return false;
  await app.nativeClick(box, { activateFirst: false });
  return true;
}

async function seedLensPreferred(app: App): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0451 — the layout selection is what a layout verb acts on",
  () => {
    test(
      "slot and width chords resolve through the selection, and move it as one",
      async () => {
        const app = await launchTugApp({ testName: "at0451-lens-multiselect" });
        try {
          await seedLensPreferred(app);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 4`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);

          // ---- Rung 2: no selection, so the chord means the first responder ----
          //
          // The behavior that predates the selection, now the degenerate case.
          // It runs first so a later failure cannot be read as "the chord never
          // worked at all".
          await setSelection(app, []);
          await app.nativeKey("3", ["cmd"]);
          await wait(AFTER_LAND_MS);
          let slots = await slotsByCard(app);
          expect(slots.A, "⌘3 with no selection moves the first responder").toBe(
            2,
          );
          expect(slots.B, "and moves nothing else").toBe(1);

          // ---- Rung 1: a selection outranks the first responder ----
          //
          // A is still the first responder. The selection names B and C, and it
          // is B and C that move — the chord asks the resolver, not the deck.
          await setSelection(app, ["B", "C"]);
          expect(await getSelection(app)).toEqual(["B", "C"]);

          // Armed across the move: a per-card commit re-arms the settle window
          // mid-flight and the dropped frame reads as a jump. Zero is the proof
          // that both slot writes landed in one commit.
          await app.evalJS<null>(`(window.__tug.armCutDetector(), null)`);
          await app.evalJS<unknown[]>(`window.__tug.takeCutRecords()`);

          await app.nativeKey("1", ["cmd"]);
          await wait(AFTER_LAND_MS);
          const cuts = await app.evalJS<CutRecord[]>(
            `window.__tug.takeCutRecords()`,
          );
          await app.evalJS<null>(`(window.__tug.disarmCutDetector(), null)`);
          note(
            `two-card move cuts: ${cuts.length === 0 ? "none" : cuts.map((c) => `${c.paneId}:${c.kind}`).join(", ")}`,
          );
          expect(
            cuts.length,
            "a two-card slot move is one arrangement, so nothing cuts",
          ).toBe(0);

          slots = await slotsByCard(app);
          expect(slots.B, "the selection's first card took the slot").toBe(0);
          expect(slots.C, "and so did its second — one slot, both cards").toBe(0);
          expect(slots.A, "the unselected card kept its slot").toBe(2);

          // ---- The headline bug: the chord works with the keyboard in the Lens ----
          //
          // Fronting the Lens makes a RAIL the first responder. Read through the
          // first responder alone this refuses; read through the selection it
          // does what the user asked. The activation also proves the collapse
          // rule's limit: a rail taking focus is not the user leaving the
          // selection behind, so the set survives.
          await app.evalJS<null>(`(window.__tug.activateCard("L"), null)`);
          await wait(200);
          expect(
            await getSelection(app),
            "fronting a rail leaves the selection alone",
          ).toEqual(["B", "C"]);

          await app.nativeKey("2", ["cmd"]);
          await wait(AFTER_LAND_MS);
          slots = await slotsByCard(app);
          expect(
            slots.B,
            "⌘2 with the keyboard in the Lens moves the selection",
          ).toBe(1);
          expect(slots.C, "both of it").toBe(1);

          // ---- The width chord resolves the same way ----
          await app.nativeKey("1", ["ctrl", "cmd"]);
          await wait(AFTER_LAND_MS);
          const widths = await widthsByCard(app);
          expect(widths.B, "⌃⌘1 widths the selection").toBe("slim");
          expect(widths.C, "all of it").toBe("slim");
          expect(
            widths.A,
            "and leaves the cards outside it at their own width",
          ).toBeNull();

          // ---- Collapse: activating a CONTENT card outside the set ends it ----
          await app.evalJS<null>(`(window.__tug.activateCard("A"), null)`);
          await wait(200);
          expect(
            await getSelection(app),
            "fronting an unselected content card collapses the set to it",
          ).toEqual(["A"]);

          // ---- Prune: a closed card cannot stay selected ----
          await setSelection(app, ["B", "C"]);
          await app.evalJS<null>(`(window.__tug.closePane("p3"), null)`);
          await wait(AFTER_LAND_MS);
          expect(
            await getSelection(app),
            "the closed card is pruned; the survivor stays",
          ).toEqual(["B"]);

          // The pruned-down selection is still what the next verb acts on.
          await app.nativeKey("3", ["cmd"]);
          await wait(AFTER_LAND_MS);
          slots = await slotsByCard(app);
          expect(slots.B, "and the verb acts on what survived").toBe(2);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the Cards list builds the selection from the keyboard and the mouse",
      async () => {
        const app = await launchTugApp({ testName: "at0451-lens-gestures" });
        try {
          await seedLensPreferred(app);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 4`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);
          await setSelection(app, []);

          // ⌘L seeds the keyboard onto the Cards list, which is where every
          // gesture below is typed. From here the first responder is the LENS —
          // a rail — for the whole test, so nothing that follows could be
          // reaching the deck through the old first-responder reading.
          await focusCardsList(app);
          await walkCursorTo(app, "Card B");
          note(`cursor parked on: ${JSON.stringify(await cursorTitle(app))}`);

          // ---- The cursor is a statement, even with nothing selected -------
          //
          // The row under the caret is plainly what the user means. Requiring a
          // Space first would make the keyboard the one way of working that has
          // to announce itself twice — and reading the first responder instead
          // would find the Lens and refuse.
          expect(await getSelection(app)).toEqual([]);
          await app.nativeKey("3", ["cmd"]);
          await wait(AFTER_LAND_MS);
          let slots = await slotsByCard(app);
          expect(slots.B, "⌘3 acts on the row the caret is on").toBe(2);
          expect(slots.A, "and on nothing else").toBe(0);
          expect(slots.C).toBe(2);

          // ---- Space selects without opening; Return opens ------------------
          //
          // The two keys are different acts. A list where both front the card
          // has no way to say "this row is what I mean" without also opening
          // it, which is the whole purpose of a selection.
          //
          // Driven on a row that is NOT already fronted, because assigning a
          // slot raises the card it moved — the ⌘3 above left B in front, and
          // asserting "Space did not front" against a card already in front
          // would pass whatever Space did.
          await focusCardsList(app);
          await setSelection(app, []);
          await walkCursorTo(app, "Card A");
          const frontBeforeSpace = await frontCard(app);
          expect(frontBeforeSpace).not.toBe("A");

          await app.nativeKey(" ");
          await wait(300);
          expect(
            await getSelection(app),
            "Space commits the caret row into the selection",
          ).toEqual(["A"]);
          expect(
            await frontCard(app),
            "and fronts nothing — Space names a row, it does not open it",
          ).toBe(frontBeforeSpace);

          await app.nativeKey("Enter");
          await wait(400);
          expect(await frontCard(app), "Return is the key that opens").toBe("A");

          // ---- Space toggles, so the keyboard can build a set --------------
          //
          // ⌘+arrow walks the caret past rows without disturbing the selection;
          // Space picks up the ones the walk stops on. Replace-on-Space would
          // make the pair useless and leave no keyboard route to a
          // discontiguous set at all.
          await focusCardsList(app);
          await setSelection(app, []);
          await walkCursorTo(app, "Card A");
          await app.nativeKey(" ");
          await wait(200);
          expect(await getSelection(app)).toEqual(["A"]);

          await app.nativeKey("ArrowDown", ["cmd"]);
          await wait(200);
          expect(
            await getSelection(app),
            "⌘+arrow walks over the selection rather than through it",
          ).toEqual(["A"]);
          expect(await cursorTitle(app)).toContain("Card B");

          await app.nativeKey("ArrowDown", ["cmd"]);
          await wait(200);
          await app.nativeKey(" ");
          await wait(200);
          expect(
            await getSelection(app),
            "Space adds the walked-to row instead of replacing the set",
          ).toEqual(["A", "C"]);

          await app.nativeKey(" ");
          await wait(200);
          expect(
            await getSelection(app),
            "and takes it back out again — Space is a toggle",
          ).toEqual(["A"]);

          // ---- The first modifier-arrow takes the row it starts on ---------
          //
          // Extension names where the caret LANDS, so without a seed the row
          // the user was looking at when they pressed ⇧↓ is the one row the
          // walk could never select.
          await setSelection(app, []);
          await walkCursorTo(app, "Card A");

          // ...and the modifier ALONE is not the gesture. A bare Shift keydown
          // carries `shiftKey: true` with no movement behind it, so a seed keyed
          // off the flag would select a row for resting a finger on the key.
          // `withModifiersHeld` posts the real physical press; `data-mods` going
          // to "shift" is the proof it reached JS, which is what keeps the
          // assertion under it from passing vacuously.
          await app.withModifiersHeld(["shift"], async () => {
            await app.waitForCondition<boolean>(
              `document.documentElement.getAttribute("data-mods") === "shift"`,
              { timeoutMs: 4_000 },
            );
            expect(
              await getSelection(app),
              "holding Shift is not a selection gesture",
            ).toEqual([]);
          });

          // The first ⇧↓ spends itself on the seed: it takes the row the caret
          // is standing on and leaves the caret there. Seeding AND moving would
          // select two rows on the first press, which is never what it means.
          await app.nativeKey("ArrowDown", ["shift"]);
          await wait(200);
          expect(
            await getSelection(app),
            "the first ⇧↓ takes the origin row",
          ).toEqual(["A"]);
          expect(
            await cursorTitle(app),
            "and does not move the caret off it",
          ).toContain("Card A");

          await app.nativeKey("ArrowDown", ["shift"]);
          await wait(200);
          expect(
            await getSelection(app),
            "the second ⇧↓ is the ordinary extend",
          ).toEqual(["A", "B"]);

          // ---- Escape drops the selection before it does anything else -----
          //
          // A selection is a standing statement about what the next verb acts
          // on, so the user needs a way to take it back that is not "select
          // something else". The Lens keeps the keyboard: one press, one job.
          //
          // The list CAPTURES the press while a set stands, which is what makes
          // this the same answer every time. Every rung of the engine's Escape
          // ladder outranks the responder chain, so an uncaptured Escape typed
          // here would have gone to "leave the keyboard mode" instead — and the
          // same selection built with the mouse would have cleared. The case
          // below repeats the press on a mouse-made set for exactly that reason.
          await app.nativeKey("Escape");
          await wait(300);
          expect(
            await getSelection(app),
            "Escape clears the selection",
          ).toEqual([]);
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(CURSOR_ROW)}) !== null`,
            ),
            "and stops there — it does not also throw the keyboard out of the Lens",
          ).toBe(true);

          // ---- A plain click MOVES the selection ---------------------------
          //
          // Not "activate the clicked row and leave the selection behind": a
          // click is the plainest way there is to say which row you mean, and a
          // selection that stayed put after one would be describing a row the
          // user has visibly moved on from.
          await setSelection(app, ["C"]);
          const clicked = await clickRowTitled(app, "Card A");
          expect(clicked, "found the row to click").toBe(true);
          await wait(400);
          expect(
            await getSelection(app),
            "the click collapses the selection onto the row it landed on",
          ).toEqual(["A"]);

          // ---- ...and Escape clears THAT set too ---------------------------
          //
          // Same press, same answer, on a set the mouse made rather than the
          // keyboard. This is the half that used to fail: how a selection was
          // built decided which rung of the Escape ladder the press reached,
          // and the user has no way to know which state they are in.
          // The click FRONTED the card it named, which took the keyboard out of
          // the Lens: the Cards list is not holding it, and the Lens's own
          // responder is off the chain. So this press can only be answered by
          // the root — which is the point. A selection is deck state, and the
          // key that takes it back cannot depend on where the keyboard drifted.
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(CURSOR_ROW)}) !== null`,
            ),
            "the click left the Lens without the keyboard",
          ).toBe(false);
          await app.nativeKey("Escape");
          await wait(300);
          expect(
            await getSelection(app),
            "Escape clears a mouse-made selection the same way",
          ).toEqual([]);

          // ---- Escape only ever shrinks state -----------------------------
          //
          // Repeating the press must walk one way: selection, then focus, then
          // nothing. It used not to. Escape with an empty set focuses OUT of
          // the Lens, which re-activates the card that was fronted before ⌘L —
          // and the deck attacher reads any content-card activation as "the
          // user moved on" and collapses the selection onto it. So the
          // focus-out MADE a selection, and the next press cleared the one the
          // press before it had created: press, clear, press, select, forever,
          // with the user watching a set they never asked for reappear.
          //
          // A restore is not a user activation. Four presses, and the set is
          // empty from the first one onward.
          await focusCardsList(app);
          await walkCursorTo(app, "Card A");
          await app.nativeKey(" ");
          await wait(200);
          expect(
            await getSelection(app),
            "a set to walk the presses against",
          ).toEqual(["A"]);

          for (let press = 1; press <= 4; press += 1) {
            await app.nativeKey("Escape");
            await wait(300);
            expect(
              await getSelection(app),
              `Escape #${press} leaves the selection empty`,
            ).toEqual([]);
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

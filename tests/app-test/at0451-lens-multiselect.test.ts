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
 * `resolveLayoutSelection` replaces that reading with a ladder — the selection
 * if there is one, the first responder otherwise, nothing if neither — and this
 * test drives all three rungs through the real chords against a real deck.
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

async function setSelection(app: App, cardIds: string[]): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setLayoutSelection(${JSON.stringify(cardIds)}), null)`,
  );
}

async function getSelection(app: App): Promise<string[]> {
  return app.evalJS<string[]>(`window.__tug.getLayoutSelection()`);
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
  },
);

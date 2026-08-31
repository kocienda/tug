/**
 * at0452-nudge-slot.test.ts — a nudge moves the selection sideways, or refuses
 * to move any of it.
 *
 * ⌘1..9 name a slot; ⌥⇧⌘[ / ⌥⇧⌘] name a direction. That is the whole difference,
 * and it is the difference that makes the nudge the one slot verb able to run
 * off the end of the arrangement — which is where its interesting behavior
 * lives. A group nudged against the edge must not be clamped: clamping arrives
 * with every member stacked on the last slot, destroying the arrangement the
 * gesture exists to move. So the rule is all-or-nothing, and the refusal is
 * visible — the member that blocked it flashes its pane border, because a
 * refused gesture must produce the act or a reason and never silence.
 *
 * The two verbs resolve through the same ladder (`resolveLayoutSelection`), and
 * this test drives the nudge through three of its rungs so the two cannot
 * quietly disagree about what they are acting on: the first responder with no
 * selection, an explicit multi-card selection, and — the rung the whole ladder
 * was built for — the Cards list's cursor row while the keyboard is in the
 * Lens, where the first responder is a rail and reading it alone would refuse.
 *
 * The batch claim is held the way at0451 holds it, by the cut detector rather
 * than by geometry: both cards land in the right slots whether the mutator
 * committed once or twice, but a per-card commit re-arms the FLIP settle
 * mid-flight and the dropped frame reads as a jump. Zero cuts across a two-card
 * nudge is the assertion that the commit was single.
 *
 * The chord is deliberately unpromoted — no menu item — so it is JS-routed and
 * arrives in a background app-test like ⌘1..9 do, rather than needing the
 * foreground the way a menu key equivalent would.
 *
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/components/tugways/action-vocabulary.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/lib/layout-selection.ts
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

/**
 * ⌥⇧⌘[ / ⌥⇧⌘] — the nudge modifiers.
 *
 * Spelled as the chord rather than as the character the shift makes:
 * `nativeKey("}", ["cmd", "alt"])` posts the identical event, but `"]"` plus an
 * explicit shift is what `command-registry.ts` declares.
 *
 * That these arrive at all is half of what this file pins. ⌥⌘[/] one modifier
 * away are Window-menu key equivalents, and the natural way to check whether
 * AppKit claims the ⌥⇧⌘ press too — a page-level `keydown` listener — CANNOT
 * answer it: a chord the keymap matches is consumed with
 * `stopImmediatePropagation`, so "AppKit ate it" and "we handled it" read
 * identically. Pressing the chord and watching the slots move is the only
 * probe that separates them, which is what the assertions below do.
 */
const NUDGE = ["cmd", "alt", "shift"] as const;

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

async function setSelection(app: App, cardIds: string[]): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setLayoutSelection(${JSON.stringify(cardIds)}), null)`,
  );
}

/** Whether the pane holding `cardId` is wearing the one-shot flash class. */
async function paneIsFlashing(app: App, cardId: string): Promise<boolean> {
  return app.evalJS<boolean>(
    `(function () {
      var pane = window.tugdeck.diag.getDeckState().panes.find(function (p) {
        return p.cardIds.indexOf(${JSON.stringify(cardId)}) !== -1;
      });
      if (pane === undefined) return false;
      var el = document.querySelector(
        '.tug-pane[data-pane-id="' + pane.id + '"]');
      return el !== null && el.classList.contains("tug-pane-flash");
    })()`,
  );
}

/** The Cards row the movement cursor is standing on. */
const CURSOR_ROW = ".cards-list .tug-list-view-cell[data-key-cursor]";

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
 * Home first, then down — never down from wherever the cursor happens to be:
 * the list's last row hands the arrow onward to the next Lens section rather
 * than clamping, so a walk that starts below its target leaves the Cards list
 * and the cursor stops existing. Fails loudly rather than walking forever.
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

/** Put the keyboard in the Cards list and wait until its cursor is painted. */
async function focusCardsList(app: App): Promise<void> {
  await app.dispatchControlAction("toggle-cards");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(CURSOR_ROW)}) !== null`,
    { timeoutMs: 8_000 },
  );
}

async function seedLensPreferred(app: App): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugtool.lens", "widthPx", { kind: "i64", value: ${LENS_WIDTH} }), null)`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0452 — the nudge moves the layout selection one slot, or none of it",
  () => {
    test(
      "one card, then a group, then the edge that refuses the whole group",
      async () => {
        const app = await launchTugApp({ testName: "at0452-nudge-slot" });
        try {
          await seedLensPreferred(app);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 4`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);

          // ---- One card, through the first-responder rung ----
          //
          // No selection, so the nudge means the card in front — the degenerate
          // case, run first so a later failure cannot be read as "the chord
          // never arrived at all".
          await setSelection(app, []);
          await app.nativeKey("]", NUDGE);
          await wait(AFTER_LAND_MS);
          let slots = await slotsByCard(app);
          expect(slots.A, "⌥⇧⌘] moved the front card one slot right").toBe(1);
          expect(slots.B, "and moved nothing else").toBe(1);
          expect(slots.C, "nor anything else").toBe(2);

          await app.nativeKey("[", NUDGE);
          await wait(AFTER_LAND_MS);
          slots = await slotsByCard(app);
          expect(slots.A, "⌥⇧⌘[ took it back").toBe(0);

          // ---- A group, moving as one arrangement ----
          //
          // A at 0 and B at 1 step to 1 and 2. The cut detector is what holds
          // the "one commit" claim: the geometry is right either way, but a
          // per-card commit re-arms the settle mid-flight and drops a frame.
          await setSelection(app, ["A", "B"]);
          await app.evalJS<null>(`(window.__tug.armCutDetector(), null)`);
          await app.evalJS<unknown[]>(`window.__tug.takeCutRecords()`);

          await app.nativeKey("]", NUDGE);
          await wait(AFTER_LAND_MS);
          const cuts = await app.evalJS<CutRecord[]>(
            `window.__tug.takeCutRecords()`,
          );
          await app.evalJS<null>(`(window.__tug.disarmCutDetector(), null)`);
          note(
            `two-card nudge cuts: ${cuts.length === 0 ? "none" : cuts.map((c) => `${c.paneId}:${c.kind}`).join(", ")}`,
          );
          expect(
            cuts.length,
            "a two-card nudge is one arrangement, so nothing cuts",
          ).toBe(0);

          slots = await slotsByCard(app);
          expect(slots.A, "both members moved — the first").toBe(1);
          expect(slots.B, "and the second, keeping their spacing").toBe(2);
          expect(slots.C, "the unselected card stayed put").toBe(2);

          // ---- The edge refuses the whole group ----
          //
          // B is on the last slot of a three-up, so a further right nudge has
          // nowhere to put it. A could still move, and that is exactly what
          // must not happen: a half-applied nudge collapses the pair onto one
          // slot. Both keep their slots, and B — the member that blocked it —
          // flashes.
          await app.nativeKey("]", NUDGE);
          await app.waitForCondition<boolean>(
            `(function () {
              var pane = window.tugdeck.diag.getDeckState().panes.find(function (p) {
                return p.cardIds.indexOf("B") !== -1;
              });
              if (pane === undefined) return false;
              var el = document.querySelector(
                '.tug-pane[data-pane-id="' + pane.id + '"]');
              return el !== null && el.classList.contains("tug-pane-flash");
            })()`,
            { timeoutMs: 2_000 },
          );
          expect(
            await paneIsFlashing(app, "A"),
            "the refusal names the blocking member, not the whole selection",
          ).toBe(false);

          await wait(AFTER_LAND_MS);
          slots = await slotsByCard(app);
          expect(slots.A, "the group refused whole — the leading member").toBe(
            1,
          );
          expect(slots.B, "and the blocked one").toBe(2);

          // The left edge is the same rule, mirrored: A back to 0, B to 1, then
          // a further left nudge has nowhere to put A.
          await app.nativeKey("[", NUDGE);
          await wait(AFTER_LAND_MS);
          slots = await slotsByCard(app);
          expect(slots.A, "the pair came back left").toBe(0);
          expect(slots.B, "together").toBe(1);

          await app.nativeKey("[", NUDGE);
          await wait(AFTER_LAND_MS);
          slots = await slotsByCard(app);
          expect(slots.A, "and refuses at slot 0 the same way").toBe(0);
          expect(slots.B, "leaving the arrangement intact").toBe(1);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the chord reaches the handler with the keyboard in the Lens",
      async () => {
        const app = await launchTugApp({ testName: "at0452-nudge-lens" });
        try {
          await seedLensPreferred(app);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(FRAMES)}).length === 4`,
            { timeoutMs: 5_000 },
          );
          await wait(AFTER_LAND_MS);
          await setSelection(app, []);

          // With the keyboard in the Cards list the first responder is the Lens
          // — a rail, which has no slot. Read through the first responder alone
          // this refuses; read through the ladder's cursor rung it moves the row
          // the caret is standing on, which is the whole reason the rung exists.
          await focusCardsList(app);
          await walkCursorTo(app, "Card C");
          expect(
            await cursorTitle(app),
            "the caret is on the row about to move",
          ).toContain("Card C");

          await app.nativeKey("[", NUDGE);
          await wait(AFTER_LAND_MS);
          const slots = await slotsByCard(app);
          expect(
            slots.C,
            "the cursor row nudged left while the Lens held the keyboard",
          ).toBe(1);
          expect(slots.A, "and nothing else moved").toBe(0);
          expect(slots.B, "nothing at all").toBe(1);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

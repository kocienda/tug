/**
 * at0371-card-width-chords.test.ts — ⌃⌘1/2/3 sets the focused card's width,
 * and only the focused card's.
 *
 * Width had one door before this: the title bar's width popup, which is a
 * mouse trip for a property you retune while reading ([D130]). The chords are
 * a second door onto the same act, and the claim worth pinning end to end is
 * that they are the SAME act — the chord lands on `set-card-width` and gets
 * the clamp and the `widthPreset` stamp from it, rather than reaching
 * `movePane` with a raw number of its own. A separate path would look right
 * on a plain content pane and diverge exactly where the popup's rules bite.
 *
 * What the assertions are chosen to catch:
 *
 *  1. **The digit is an index into the preset order, not into a table
 *     somebody typed twice.** All three are pressed, so a transposed pair
 *     fails rather than passing on the one that happens to match.
 *  2. **It is per-card.** The deck's Card Width default reaches every content
 *     pane at once (at0357); this must not. The second pane is measured after
 *     every press, and holds its seeded width to the pixel.
 *  3. **It moves with the selection.** Focus goes to the second card and the
 *     next press lands there while the first card keeps the width it had, so
 *     the chord is reading the selection at press time rather than latching
 *     the pane it first found. (It does NOT distinguish "first responder's
 *     pane" from "last pane in z-order": every raise path writes
 *     `activePaneId` and moves the pane to the end of the array in one
 *     commit, so those name the same pane — the invariant `stackDepth`
 *     rests on in `host-menu-state.ts`. A probe swapping one for the other
 *     passes, and the docblock says so rather than claiming a guarantee
 *     this fixture cannot make.)
 *  4. **A rail is inert as a TARGET, and does not swallow the chord.** A
 *     sidebar's width is the allocator's answer, never a preset ([P04]),
 *     which is the same condition the title bar hides its popup behind. So
 *     the Lens never takes a width — and the Lens is the pane that would be
 *     most visibly wrong. But "the Lens is focused" no longer means "the
 *     chord does nothing": the verb resolves through the LAYOUT SELECTION,
 *     which drops rails and keeps the content cards, so a chord typed with
 *     the keyboard in the Lens lands on the card the user last worked in
 *     instead of dying silently. Both halves are asserted below — with a
 *     selection the chord travels to it, and with none it falls to the row
 *     the Lens's own caret is standing on. The ladder is at0451's subject;
 *     what is pinned here is that the rail never takes the width either way.
 *  5. **A rail's own width is not spent by a card's width chord.** The verb
 *     commits with the space allocator held off, unlike the deck-wide Card
 *     Width default. Re-solving here would shrink the Lens to its floor on
 *     an ordinary ⌃⌘-digit — the user's rail spent by a gesture that never
 *     mentioned it. The Lens's measured width after every press is what
 *     holds that.
 *
 * Widths are read off the painted frame rather than the store, which is what
 * makes this an app-test rather than a unit test: slim (675) and comfy (800)
 * both fit any canvas the harness launches at, and wide (1230) is asserted
 * against the same rect so a canvas too narrow to hold it would fail loudly
 * rather than silently proving nothing. `gallery-accordion` carries no size
 * policy tighter than the presets, so no clamp is in play here — the clamp
 * itself is at0357's fixture and the store's own tests.
 *
 * The chords are pressed natively, so this exercises the whole four-layer
 * resolution: AppKit's key-equivalent scan on the Window items the sweep
 * wrote, the round-trip back through `set-pane-width`, the parameterized
 * command, and the canvas handler. It deliberately does NOT claim
 * `AppDelegate.swift` — that file is already at its accepted fan-out, and
 * the Swift half of this gesture (the item, its identifier, the swept key
 * equivalent) is pinned by `at0181-keymap-chord-sweep` rather than here.
 *
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/components/tugways/action-vocabulary.ts
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/lib/host-menu-state.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

/** The presets, as `lib/layout-imposer.ts` fixes them. */
const SLIM = 675;
const COMFY = 800;
const WIDE = 1230;

/** Seeded widths chosen so no preset resolves to them: a pane that moved
 *  because something reached every pane is unmistakable from one that did
 *  not move at all. */
const SEEDED_WIDTH = 511;
const LENS_WIDTH = 412;

/** The settle window (`IMPOSITION_SETTLE_MS`), with room for the tween. */
const AFTER_LAND_MS = 900;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

function deckShape(): Record<string, unknown> {
  const pane = (id: string, slot: number, cardId: string) => ({
    id,
    position: { x: 40, y: 40 },
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
      { id: "L", componentId: "lens", title: "Lens", closable: true },
    ],
    panes: [
      pane("p1", 0, "A"),
      pane("p2", 2, "B"),
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
    imposition: { kind: "three-up", sidebars: { lens: { side: "right" } } },
    hasFocus: true,
  };
}

const PANE_WIDTH_JS = (paneId: string): string =>
  `Math.round(document.querySelector('.tug-pane[data-pane-id="${paneId}"]').getBoundingClientRect().width)`;

async function paneWidth(app: App, paneId: string): Promise<number> {
  return app.evalJS<number>(PANE_WIDTH_JS(paneId));
}

/** Press ⌃⌘<digit> and wait for the pane to land on the width, so a slow
 *  settle reads as a timeout at the assertion rather than as a wrong number. */
async function widthChord(
  app: App,
  digit: number,
  paneId: string,
  expected: number,
): Promise<void> {
  await app.nativeKey(String(digit), ["ctrl", "cmd"]);
  await app.waitForCondition<boolean>(
    `(${PANE_WIDTH_JS(paneId)}) === ${expected}`,
    { timeoutMs: 8_000 },
  );
}

async function focusCard(app: App, cardId: string): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.dispatchControlAction("focus-session-card", { cardId: ${JSON.stringify(cardId)} }), null)`,
  );
  await wait(AFTER_LAND_MS);
}

describe.skipIf(!SHOULD_RUN)(
  "at0371 — ⌃⌘1/2/3 sets the focused card's width",
  () => {
    test(
      "each digit lands its own preset, on the focused pane only, and a rail is inert",
      async () => {
        const app = await launchTugApp({ testName: "at0371-card-width-chords" });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll('.tug-pane[data-pane-id]').length === 3`,
            { timeoutMs: 8_000 },
          );
          await wait(AFTER_LAND_MS);

          expect(await paneWidth(app, "p1")).toBe(SEEDED_WIDTH);
          expect(await paneWidth(app, "p2")).toBe(SEEDED_WIDTH);

          // --- Each digit is its own preset, in picker order. ---------------
          // Pressed in an order that is not the digits' order, so a handler
          // that ignored the payload and cycled would land on the wrong one.
          await widthChord(app, 2, "p1", COMFY);
          await widthChord(app, 1, "p1", SLIM);
          await widthChord(app, 3, "p1", WIDE);

          // --- Per-card, not deck-wide. -------------------------------------
          // The deck's Card Width default reaches every content pane at once
          // (at0357). Three presses later, the unfocused pane has not moved.
          expect(await paneWidth(app, "p2")).toBe(SEEDED_WIDTH);
          expect(await paneWidth(app, "pLens")).toBe(LENS_WIDTH);

          // --- It moves with the selection. ---------------------------------
          await focusCard(app, "B");
          await widthChord(app, 1, "p2", SLIM);
          // ...and the pane that was focused a moment ago kept its width.
          expect(await paneWidth(app, "p1")).toBe(WIDE);

          // --- A rail is inert, and does not swallow the chord. -------------
          // Fronting the Lens makes a RAIL the first responder. The command
          // does not apply to a sidebar, so the Lens itself never takes a
          // width — but the chord is not therefore dead: it resolves through
          // the layout selection, which still names the card the user was
          // last in, and lands there. That is the whole point of the resolver
          // (at0451): a chord typed with the keyboard in the Lens is typed at
          // the moment the user is most likely to type one.
          await focusCard(app, "L");
          await app.nativeKey("2", ["ctrl", "cmd"]);
          await wait(AFTER_LAND_MS);
          expect(
            await paneWidth(app, "pLens"),
            "a rail never takes a preset, whoever is focused",
          ).toBe(LENS_WIDTH);
          expect(
            await paneWidth(app, "p2"),
            "the chord travels to the layout selection instead of dying",
          ).toBe(COMFY);
          expect(await paneWidth(app, "p1")).toBe(WIDE);

          // --- Empty the selection and the caret still answers. -------------
          // The next rung down is the row the Lens's Cards list has its cursor
          // on, which is where the keyboard is standing and therefore what the
          // user plainly means. The Lens is still the first responder and still
          // takes no width; the caret's row takes it instead.
          //
          // Which row that is belongs to the Lens's own seeding rules, so this
          // asserts the SHAPE of the answer — the rail is untouched, exactly one
          // content pane moved, and it is not the one the previous chord left at
          // comfy. The ladder itself is at0451's subject.
          await app.evalJS<null>(
            `(window.__tug.setLayoutSelection([]), null)`,
          );
          await app.nativeKey("1", ["ctrl", "cmd"]);
          await wait(AFTER_LAND_MS);
          expect(
            await paneWidth(app, "pLens"),
            "the rail still takes no preset, whatever the chord resolved to",
          ).toBe(LENS_WIDTH);
          expect(
            await paneWidth(app, "p1"),
            "the caret's row takes the width — a chord in the Lens is not dead",
          ).toBe(SLIM);
          expect(
            await paneWidth(app, "p2"),
            "and nothing else moves",
          ).toBe(COMFY);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

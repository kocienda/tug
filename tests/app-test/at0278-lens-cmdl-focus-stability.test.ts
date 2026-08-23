/**
 * at0278-lens-cmdl-focus-stability.test.ts — ⌘L always lands the keyboard
 * VISIBLY in the Lens, exactly where it was left.
 *
 * ## What this gates
 *
 * ⌘L is a keyboard gesture, so its activation asserts keyboard modality
 * through the one focus channel (`transferFocusForActivation` →
 * `applyBagFocus` → `adoptKeyCard`): the Lens's retained key view comes back
 * RINGED and revealed rather than replayed with whatever modality the last
 * interaction left it. Before this, a pointer click on a Layouts tile left
 * the key view pointer-flavored, and every subsequent ⌘L return was an
 * invisible focus mark — the Lens activated, nothing lit, and a Tab was
 * needed to see where the keyboard was. An invisible mark reads as drift.
 *
 * Four boundaries, in one drive:
 *
 *  - **Exact restore.** A keyboard-placed cursor row survives a ⌘L
 *    out-and-back untouched — same row, ring visible, no Tab. The row is
 *    chosen to be one the Cards list's own gain-seed would *not* pick (the
 *    group header, which the seed steps past), so "restored" cannot be
 *    confused with "re-seeded".
 *  - **Pointer interactions stay visible.** After a pointer click on a
 *    Layouts tile, the ⌘L return re-asserts the tile group as a KEYBOARD
 *    destination: `data-key-view-kbd` paints without any key press.
 *  - **Slot assignment is a first-class exit.** Space on a row's slot
 *    assigns AND activates the slotted card through
 *    `transferFocusForActivation` (a raw `activateCard` skipped the focus
 *    claim); the ⌘L return restores the descend exactly — ring on the slot,
 *    and a descend that still WORKS. Those are two claims: a bag carries a
 *    focus key and nothing else, so the ring can come back in the right place
 *    over a mode stack that no longer holds the row's scope, and the first
 *    arrow after such a restore throws the keyboard out of the Lens.
 *  - **Stale state heals, and ⌘L is never a no-op.** Closing the slotted
 *    card unmounts the descended row under the backgrounded Lens. The next
 *    ⌘L (with no live prior to toggle out to) ascends the dead scope
 *    (`assertKeyboardDestination`) and lands the keyboard somewhere live and
 *    ringed — never parked invisibly on a ghost.
 *
 * @covers tugdeck/src/focus-transfer.ts
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/components/lens/lens-content.tsx
 * @covers tugdeck/src/components/lens/sections/cards-section.tsx
 * @covers tugdeck/src/components/lens/slot-picker.tsx
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARDS_LIST = ".lens-cards-list";
const CARDS_KBD = `${CARDS_LIST}[data-key-view-kbd]`;
const CURSOR_ROW = `${CARDS_LIST} [data-key-cursor]`;
const KIND_GROUP = '[data-testid="lens-layouts-kind"]';
const LENS_KBD = ".lens-content [data-key-view-kbd]";

function priorCardDeck() {
  return {
    // A Text card: the prior card ⌘L stashes, and the Cards row whose
    // slot picker the drive assigns from.
    cards: [{ id: "A", componentId: "text", title: "File", closable: true }],
    panes: [
      {
        id: "pA",
        position: { x: 60, y: 60 },
        size: { width: 520, height: 420 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pA",
    hasFocus: true,
  };
}

/** Whether anything inside the Lens wears the visible keyboard mark. */
async function lensKbdVisible(app: App): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(LENS_KBD)}) !== null`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0278 — ⌘L lands the keyboard visibly, where it was left", () => {
  test(
    "exact restore, pointer-left modality, slot-assign exit, stale-descend heal",
    async () => {
      const tugbankPath = mkTempTugbank();
      const filesDir = mkdtempSync(join(tmpdir(), "tug-at0278-"));
      const filePath = join(filesDir, "fixture.txt");
      writeFileSync(filePath, "alpha meridian\n");
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0278-lens-cmdl-focus-stability",
          env: { TUGBANK_PATH: tugbankPath },
        });
        try {
          await app.seedDeckState({
            state: priorCardDeck(),
            cardStates: {
              A: { content: { path: filePath, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
            },
            focusCardId: "A",
          });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          // ---- A. Exact restore: a keyboard cursor row survives ⌘L
          // out-and-back with its ring, no Tab needed.
          await app.dispatchControlAction("focus-lens");
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-key-view-kbd]") !== null`,
            { timeoutMs: 5_000 },
          );
          // The band leads its section, and everything on it (filter field,
          // `+`, fold chevron) is a stop of its own, so the walk crosses the
          // whole band before it reaches the rows. Walked, not counted: what
          // this pins is where the keyboard ENDS.
          for (let i = 0; i < 8; i += 1) {
            if (
              await app.evalJS<boolean>(
                `document.querySelector(${JSON.stringify(CARDS_KBD)}) !== null`,
              )
            ) {
              break;
            }
            await app.nativeKey("Tab");
          }
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CARDS_KBD)}) !== null`,
            { timeoutMs: 5_000 },
          );
          // The Cards list is pane-first and two-level, and its gain seeds the
          // cursor onto a CARD row rather than the group header above it
          // (at0312 §D). So the keyboard is moved UP onto the header: a
          // position the seed would never produce, which is what makes the
          // restore below a statement about memory rather than about seeding.
          await app.nativeKey("ArrowUp");
          await app.waitForCondition<boolean>(
            `(function(){ var c = document.querySelector(${JSON.stringify(CURSOR_ROW)}); return c !== null && (c.matches('.lens-cards-header') || c.querySelector('.lens-cards-header') !== null); })()`,
            { timeoutMs: 3_000 },
          );
          await app.dispatchControlAction("focus-lens"); // out
          await app.waitForCondition<boolean>(
            `window.__tug.getActiveCardId() === "A"`,
            { timeoutMs: 3_000 },
          );
          await app.dispatchControlAction("focus-lens"); // back in
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CARDS_KBD)}) !== null`,
            { timeoutMs: 3_000 },
          );
          // Same row, ring on, without a single key press since the return —
          // the header the arrow chose, not the card row a fresh seed prefers.
          expect(
            await app.evalJS<boolean>(
              `(function(){ var c = document.querySelector(${JSON.stringify(CURSOR_ROW)}); return c !== null && (c.matches('.lens-cards-header') || c.querySelector('.lens-cards-header') !== null); })()`,
            ),
          ).toBe(true);

          // ---- B. A pointer click on a Layouts tile leaves the key view on
          // the tile group with pointer modality; the ⌘L return must re-assert
          // it as a KEYBOARD destination — ring visible with no Tab.
          await app.click(`${KIND_GROUP}`);
          await app.waitForCondition<boolean>(
            `(function(){ var kv = document.querySelector('.lens-content [data-key-view]'); return kv !== null && kv.closest(${JSON.stringify(KIND_GROUP)}) !== null; })()`,
            { timeoutMs: 3_000 },
          );
          await app.dispatchControlAction("focus-lens"); // out
          await app.waitForCondition<boolean>(
            `window.__tug.getActiveCardId() === "A"`,
            { timeoutMs: 3_000 },
          );
          await app.dispatchControlAction("focus-lens"); // back in
          await app.waitForCondition<boolean>(
            `(function(){ var el = document.querySelector(${JSON.stringify(LENS_KBD)}); return el !== null && el.closest(${JSON.stringify(KIND_GROUP)}) !== null; })()`,
            { timeoutMs: 3_000 },
          );
          expect(await lensKbdVisible(app)).toBe(true);

          // ---- C. Slot assignment by keyboard: descend onto the text-file
          // row's slots, Space assigns AND activates the slotted card (the
          // first-class exit). The ⌘L return restores the descend exactly.
          await app.dispatchControlAction("set-imposition", { kind: "two-up" });
          await app.waitForCondition<boolean>(
            `document.querySelector('.lens-cards-list [data-slot="tug-slot"]') !== null`,
            { timeoutMs: 3_000 },
          );
          // Walked, not counted, exactly as A's walk is — and the budget has
          // to span the whole Layouts section, whose per-shared-side
          // Stack|Split rows sit between B's tile and the Cards list.
          for (let i = 0; i < 24; i += 1) {
            const on = await app.evalJS<boolean>(
              `document.querySelector('.lens-cards-list[data-key-view-kbd]') !== null`,
            );
            if (on) break;
            await app.nativeKey("Tab");
            await new Promise<void>((r) => setTimeout(r, 200));
          }
          await app.waitForCondition<boolean>(
            `document.querySelector('.lens-cards-list[data-key-view-kbd]') !== null`,
            { timeoutMs: 3_000 },
          );
          // Regaining the list restores the cursor boundary A left on the
          // header, and a header has no accessories to descend into — so step
          // back down onto the card row this section descends from. Stated as
          // a step rather than assumed, because the descend below is only
          // meaningful over a row that has slots.
          await app.nativeKey("ArrowDown");
          await app.waitForCondition<boolean>(
            `(function(){ var c = document.querySelector(${JSON.stringify(CURSOR_ROW)}); return c !== null && (c.matches('.lens-cards-row') || c.querySelector('.lens-cards-row') !== null); })()`,
            { timeoutMs: 3_000 },
          );
          // Right descends onto the row's FIRST accessory — the leading close
          // box — and the next Right walks on to the slots.
          await app.nativeKey("ArrowRight");
          await app.waitForCondition<boolean>(
            `(function(){ var el = document.querySelector(${JSON.stringify(LENS_KBD)}); return el !== null && (el.getAttribute('aria-label') || '').indexOf('Close ') === 0; })()`,
            { timeoutMs: 3_000 },
          );
          // The row draws a WINDOW of the arrangement, and its middle chip is
          // the DOOR to the whole run rather than a destination — pressing
          // where a card already stands is not a move, so the press spends
          // itself on the run instead. The move is the neighbour, so the walk
          // goes one further. (The first chip is matched as a slot naming
          // place 1 rather than by its exact label: what the door says depends
          // on whether the row's card stands anywhere yet.)
          await app.nativeKey("ArrowRight");
          await app.waitForCondition<boolean>(
            `(function(){ var el = document.querySelector(${JSON.stringify(LENS_KBD)}); return el !== null && el.getAttribute('data-slot') === 'tug-slot' && el.textContent.trim() === '1'; })()`,
            { timeoutMs: 3_000 },
          );
          await app.nativeKey("ArrowRight");
          await app.waitForCondition<boolean>(
            `(function(){ var el = document.querySelector(${JSON.stringify(LENS_KBD)}); return el !== null && el.getAttribute('data-slot') === 'tug-slot' && el.textContent.trim() === '2'; })()`,
            { timeoutMs: 3_000 },
          );
          await app.nativeKey(" "); // assign slot 2 → raises card A
          await app.waitForCondition<boolean>(
            `window.__tug.getActiveCardId() === "A"`,
            { timeoutMs: 3_000 },
          );
          await app.dispatchControlAction("focus-lens"); // back in
          // The restore lands on the SLOT the reader was standing on, which is
          // the sharp claim now that the run is a window: assigning re-centres
          // the window under them, so the chip that was second from the left is
          // a different chip afterwards. A focus order keyed by drawn position
          // would have handed the restore a stub — not a control, nothing to
          // land on. Keyed by slot, they are still on place 2, which is now
          // the card's own.
          await app.waitForCondition<boolean>(
            `(function(){ var el = document.querySelector(${JSON.stringify(LENS_KBD)}); return el !== null && (el.getAttribute('aria-label') || '').indexOf('In position 2 of ') === 0; })()`,
            { timeoutMs: 3_000 },
          );

          // ...and the restored descend WORKS, which is a separate claim from
          // the ring being in the right place. A bag carries a focus key and
          // nothing else, so a restore lands the keyboard inside a row with no
          // row scope on the mode stack: the DOM says descended and the engine
          // says it is not, every arrow the row scope owns is skipped, and the
          // first press throws the keyboard out of the Lens. All three of the
          // row scope's answers are checked, because a mode can be on the
          // stack and still be wrong: the vertical arrow is swallowed at the
          // list's edge (this deck has one card, so nothing below to step to)
          // rather than falling through, the horizontal one walks back to the
          // accessory before the slots, and one more ascends to the container.
          await app.nativeKey("ArrowDown");
          await new Promise<void>((r) => setTimeout(r, 250));
          expect(
            await app.evalJS<string | null>(
              `(function(){ var el = document.querySelector(${JSON.stringify(LENS_KBD)}); return el === null ? null : el.getAttribute('aria-label'); })()`,
            ),
          ).toMatch(/^In position 2 of /);
          // Two Lefts to reach the accessory now, because the card sits at the
          // far end of the run: the walk crosses the place it is NOT in first.
          await app.nativeKey("ArrowLeft");
          await app.waitForCondition<boolean>(
            `(function(){ var el = document.querySelector(${JSON.stringify(LENS_KBD)}); return el !== null && el.getAttribute('aria-label') === 'Move to position 1'; })()`,
            { timeoutMs: 3_000 },
          );
          await app.nativeKey("ArrowLeft");
          await app.waitForCondition<boolean>(
            `(function(){ var el = document.querySelector(${JSON.stringify(LENS_KBD)}); return el !== null && (el.getAttribute('aria-label') || '').indexOf('Close ') === 0; })()`,
            { timeoutMs: 3_000 },
          );
          // ...and one more ArrowLeft ASCENDS to the container. This is the
          // sharpest assertion in the section, because ascending reads the
          // `restoreKeyView` the scope captured when it was pushed. A restored
          // descend that pushed its scope while the accessory already held the
          // key view records the ACCESSORY as what to restore, so the ascend
          // lands back where it started and the row is a jail — a mode is on
          // the stack and it points at the wrong thing.
          await app.nativeKey("ArrowLeft");
          await app.waitForCondition<boolean>(
            `document.querySelector('.lens-cards-list[data-key-view-kbd]') !== null`,
            { timeoutMs: 3_000 },
          );
          // Back onto the slot, so section D starts from the descend it
          // describes.
          await app.nativeKey("ArrowRight");
          await app.nativeKey("ArrowRight");
          await app.waitForCondition<boolean>(
            `(function(){ var el = document.querySelector(${JSON.stringify(LENS_KBD)}); return el !== null && el.getAttribute('aria-label') === 'Move to position 1'; })()`,
            { timeoutMs: 3_000 },
          );

          // ---- D. Stale-descend heal, and ⌘L is never a no-op. Close the
          // slotted card while the Lens is descended into its row: the row
          // unmounts under the backgrounded Lens. ⌘L (already inside the
          // Lens after the close hands focus to the last pane standing — the
          // Lens rail — and with no live prior card) must still land the
          // keyboard somewhere live and ringed.
          await app.dispatchControlAction("focus-lens"); // out to A first
          await app.waitForCondition<boolean>(
            `window.__tug.getActiveCardId() === "A"`,
            { timeoutMs: 3_000 },
          );
          await app.evalJS<void>(`window.__tug.closePane("pA")`);
          await app.waitForCondition<boolean>(
            `window.__tug.getActiveCardId() !== "A"`,
            { timeoutMs: 3_000 },
          );
          await app.dispatchControlAction("focus-lens");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(LENS_KBD)}) !== null`,
            { timeoutMs: 3_000 },
          );
          // The healed landing is live — the ring is on a connected element
          // with real geometry, not a ghost of the closed card's row.
          const healed = await app.evalJS<{ label: string | null; width: number }>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(LENS_KBD)});
              return {
                label: el.getAttribute('aria-label'),
                width: Math.round(el.getBoundingClientRect().width),
              };
            })()`,
          );
          expect(healed.width).toBeGreaterThan(0);
          expect(healed.label).not.toBe("Move to position 1");
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
        rmSync(filesDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * at0492-compaction-card-modality.test.ts — a card covered by a `/compact` run
 * refuses every door but the run's own ([AT0492]).
 *
 * ## Why this exists
 *
 * The compaction sheet is pane-modal, but modality alone left three ways out,
 * and each of them lost the user's sight of a run that was still going:
 *
 *  1. Escape and ⌘. dismissed it directly.
 *  2. The pane's control cluster sits above the modal scrim by design, so the
 *     `⋯` rollup, the badges, and the ✕ stayed pressable throughout — and the
 *     rollup's `⋮` menu is how a second sheet got opened on a card that hosts
 *     only one, which REPLACED the compaction sheet rather than stacking over
 *     it, so dismissing that second sheet left the card looking as though the
 *     compaction had been dismissed too, while it compacted on.
 *  3. ⌘W and the other close routes closed the card out from under the run.
 *
 * This drives the real card: submit `/compact` through the composer, then press
 * each of those doors and assert the sheet is still standing and the refusal
 * was spoken. Cancel — the one door that belongs to the run — is pressed last
 * and does take it down.
 *
 * The mechanism under all of it is generic (`cardModalHoldStore` plus the
 * sheet's `exclusive` option); its state machine is unit-tested. What only the
 * real app can show is that the doors are actually closed, which is this.
 *
 * **Why nothing here opens a second sheet directly.** The supersede half is
 * covered by closing the door that reached it: the rollup row is asserted
 * `display: none`, which is where the `⋮` menu lives. Driving `/usage` itself
 * is not available to this harness — its doors are the ⌃⌘U key equivalent and
 * the native Session menu, both of which need a foreground app, and every
 * in-page dispatch of it (`run-card-command`, `run-slash-command`) is routed
 * key-card and does not arrive while a modal sheet holds the card. An
 * assertion driven that way would pass without testing anything.
 *
 * Stub mode: no backend answers the `/compact` turn, so the run stays in flight
 * for the length of the test — exactly the window the modality covers.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/card-modal-hold-store.ts
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/components/tugways/cards/compaction-progress-sheet.tsx
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0492-session";

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = '[data-slot="tug-sheet"]';
const COMPACTION = '[data-slot="compaction-progress"]';
const CANCEL = `${COMPACTION} [data-testid="compaction-cancel"]`;
const TITLE_BAR = '[data-testid="tug-pane-title-bar"]';
const CLOSE_BUTTON = '[data-testid="tug-pane-close-button"]';
const ROLLUP_ROW = '[data-testid="tug-pane-title-bar-rollup-row"]';

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

const sheetCount = `document.querySelectorAll(${JSON.stringify(COMPACTION)}).length`;

describe.skipIf(!SHOULD_RUN)(
  "AT0492: a compacting card refuses every door but its own",
  () => {
    test(
      "Escape, the title-bar controls, and the close route are all refused; Cancel closes it",
      async () => {
        const app = await launchTugApp({
          testName: "at0492-compaction-card-modality",
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            // Generous: a cold single-file run pays the tugdeck Vite
            // first-compile cost, which exceeds the 10s default.
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { tugSessionId: SID });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          // Open the run through the real submit path — the composer, not a
          // store poke, because the sheet's exclusivity is declared at the
          // `showSheet` call the command handler makes.
          await app.nativeClickAtElement(PROMPT_INPUT);
          await app.nativeType("/compact");
          await new Promise((r) => setTimeout(r, 200));
          await app.nativeKey("Escape"); // dismiss the completion popup
          await new Promise((r) => setTimeout(r, 200));
          await app.nativeKey("Return", ["cmd"]);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(COMPACTION)}) !== null`,
            { timeoutMs: 8000 },
          );

          // (1) Escape. The engine's Escape ladder reaches the sheet's own
          // cancel path, which now answers instead of dismissing — and the
          // answer is the sheet's own refusal line, where the user is looking.
          await app.nativeKey("Escape");
          await new Promise((r) => setTimeout(r, 400));
          expect(await app.evalJS<number>(sheetCount)).toBe(1);
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(COMPACTION)}).hasAttribute("data-refused")`,
            ),
          ).toBe(true);

          // One sheet on the card throughout, which is the shape the whole
          // exclusivity rests on: this host is single-slot, so a second sheet
          // would be a replacement rather than a layer.
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(SHEET)}).length`,
            ),
          ).toBe(1);

          // (2) The pane's controls. The close box is disabled outright, and
          // the rollup — the `⋯`, the `⋮` card menu behind it, and every verb
          // in the row — does not unfurl for a pointer or a keyboard walk.
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(TITLE_BAR)}).hasAttribute("data-modal-hold")`,
            ),
          ).toBe(true);
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(CLOSE_BUTTON)}).disabled`,
            ),
          ).toBe(true);
          expect(
            await app.getComputedStyleValue(ROLLUP_ROW, "display"),
          ).toBe("none");

          // (3) The close ROUTE — where ⌘W, Close All, and the Lens's remote
          // close box all end up, and the one door with no on-screen control
          // to dim. Dispatched rather than chorded because ⌘W is a native menu
          // key equivalent, which a background app-test cannot deliver: the
          // chord would be swallowed by the harness and the assertion below
          // would pass without ever testing anything.
          await app.dispatchControlAction("close");
          await new Promise((r) => setTimeout(r, 600));
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(CARD)}).length`,
            ),
          ).toBe(1);
          expect(await app.evalJS<number>(sheetCount)).toBe(1);

          // Cancel — the run's own door. It settles the store, which raises the
          // closing bulletin and clears, and the sheet dismisses with it.
          await app.nativeClickAtElement(CANCEL);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(COMPACTION)}) === null`,
            { timeoutMs: 8000 },
          );

          // The hold went with the sheet: the chrome is live again.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(TITLE_BAR)}).hasAttribute("data-modal-hold") === false`,
            { timeoutMs: 4000 },
          );
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(CLOSE_BUTTON)}).disabled`,
            ),
          ).toBe(false);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0492] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

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
 *     rollup's verbs are how a second sheet got opened on a card that hosts
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
 * **The fold is the exception, and it is pressed here too.** The hold belongs
 * to the RUN rather than to its cover, so folding a compacting card does not
 * leave the run: it swaps the face the run is shown on, from the cover panel to
 * the card's Z2 row, and the card stays held throughout. The unfold brings the
 * cover back, because the cover is derived from the run and the fold rather
 * than raised once when the run opened. Both halves are read below, between the
 * refused doors and Cancel.
 *
 * The mechanism under all of it is generic (`cardModalHoldStore` plus the
 * sheet's `exclusive` option); its state machine is unit-tested. What only the
 * real app can show is that the doors are actually closed, which is this.
 *
 * **Why nothing here opens a second sheet directly.** The supersede half is
 * covered by closing the door that reached it: the rollup row is asserted
 * `display: none`, which is where every card verb lives. Driving `/usage` itself
 * is not available to this harness — its doors are the ⌃⌘U key equivalent and
 * the native Session menu, both of which need a foreground app, and every
 * in-page dispatch of it (`run-card-command`, `run-slash-command`) is routed
 * key-card and does not arrive while a modal sheet holds the card. An
 * assertion driven that way would pass without testing anything.
 *
 * Stub mode: no backend answers the `/compact` turn, so the run stays in flight
 * for the length of the test — exactly the window the modality covers.
 *
 * ## The wheel sends one too
 *
 * An arc compacting a seated stage prompts that session itself: a `tug_notice`
 * carrying `origin: "wheel"`, dispatched by tugcast, which opens its turn
 * inside the store without passing the composer or the local command handler.
 * The run is the same run and earns the same cover, so the second test drives
 * that frame and asserts the sheet and the hold arrive from it.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/card-modal-hold-store.ts
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/components/tugways/cards/compaction-progress-sheet.tsx
 * @covers tugdeck/src/components/tugways/cards/session-compaction-run.tsx
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/lib/compaction-progress-store.ts
 * @covers tugdeck/src/lib/card-fold.ts
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
const WHEEL_ROW = '.tug-transcript-entry[data-participant="wheel"]';

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT

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
          // the rollup — the `⋯` and every verb in the row behind it — does
          // not unfurl for a pointer or a keyboard walk.
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

          // (3) The close ROUTE — where ⌘W, Close All, and the Cards row's remote
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

          // (4) The FOLD — the one door the hold admits, and the reason the
          // hold is the run's rather than the cover's. Every door above is
          // refused because taking it would leave the user without sight of a
          // run that is still going; folding does not do that. It swaps the
          // face the run is shown on, from this cover to the card's Z2 row,
          // which carries the same reading and the same Cancel — so the run is
          // still in front of the user, in one row instead of a panel.
          //
          // The card is made first responder first so the gesture is
          // DELIVERED: the cover autofocuses its own panel, and a fold that
          // never reached the card's handler would read here exactly like one
          // the hold turned away.
          await app.evalJS<null>(`(window.__tug.setFirstResponder("A"), null)`);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("toggle-session-fold"), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.__tug.getPaneRecord("p1").folded === true`,
            { timeoutMs: 8000 },
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(COMPACTION)}) === null`,
            { timeoutMs: 8000 },
          );
          // The cover is down and the card is STILL held: the run took the
          // hold, not the panel, so a folded compaction refuses every other
          // door exactly as an open one does. This is the assertion the old
          // shape could not make — with the hold on the sheet, folding the
          // card dropped it and left the run unguarded.
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(TITLE_BAR)}).hasAttribute("data-modal-hold")`,
            ),
            "the hold outlives the cover",
          ).toBe(true);
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(CLOSE_BUTTON)}).disabled`,
            ),
          ).toBe(true);

          // And the UNFOLD brings the cover back, because the cover is derived
          // from the run and the fold rather than raised once at the moment
          // the run opened. A panel nobody re-raises is what made the fold
          // look like a dismissal.
          await app.evalJS<null>(`(window.__tug.setFirstResponder("A"), null)`);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("toggle-session-fold"), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.__tug.getPaneRecord("p1").folded === false`,
            { timeoutMs: 8000 },
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(COMPACTION)}) !== null`,
            { timeoutMs: 12000 },
          );
          expect(await app.evalJS<number>(sheetCount), "one cover, not two").toBe(1);

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

    test(
      "a `/compact` the wheel sent covers the card the same way",
      async () => {
        // The arc compacts a seated stage by prompting the session it already
        // seated — a `tug_notice` carrying `origin: "wheel"`, which tugcast has
        // already put on the wire. That prompt opens its turn inside the store
        // and never touches the composer or the local command handler, so the
        // run has to be recognized from the turn itself. Before it was, an arc
        // compacting mid-stage left the card looking like an ordinary busy
        // turn: no sheet, no hold, every door open, and nothing on screen
        // saying the minutes ahead belonged to a compaction.
        const app = await launchTugApp({
          testName: "at0492-wheel-compaction-modality",
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { tugSessionId: SID });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          // Exactly the frame tugcast announces the wheel's prompt with.
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "tug_notice",
              tug_session_id: SID,
              origin: "wheel",
              text: "/compact",
            },
          });

          // The turn is the wheel's, and the run is the user's `/compact` run.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(WHEEL_ROW)}) !== null`,
            { timeoutMs: 8000 },
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(COMPACTION)}) !== null`,
            { timeoutMs: 8000 },
          );

          // And the hold rides with it: same closed doors as the typed path.
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
          expect(await app.evalJS<number>(sheetCount)).toBe(1);

          // Cancel still belongs to the user, whoever sent the compaction.
          await app.nativeClickAtElement(CANCEL);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(COMPACTION)}) === null`,
            { timeoutMs: 8000 },
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(TITLE_BAR)}).hasAttribute("data-modal-hold") === false`,
            { timeoutMs: 4000 },
          );

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

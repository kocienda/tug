/**
 * at0397-kbf-paint-route.test.ts — the mode's paint keys on the keyboard route:
 * a blinking caret and a focus ring are mutually exclusive.
 *
 * ## What this gates
 *
 * `data-kbf` (and with it the ring trigger `data-key-view-kbd`) projects only
 * while the keyboard route is `engine-routed`. The mode itself — the derivation
 * `kbfEngaged()` — does not move: inside a trapped sheet it is on the whole
 * time, and the paint stands down exactly while a caret is granted. The rename
 * sheet is the worked example because it is the canonical caret-first seeded
 * surface: `useSeedKeyView` lands the key view on the name FIELD, and a seeded
 * text stop GRANTS (a seed is a placement, not a movement — [P12]).
 *
 * The walk this drives, one route flip per scene:
 *
 *   1. **Open (seeded grant).** Caret in the field; the mode is ENGAGED (the
 *      sheet's trap, Class A) but paints nothing: no `data-kbf`, no ringed
 *      stop anywhere. Save's `data-default-ring` stays up — the default ring
 *      is a promise about Return, deliberately outside the mode's paint
 *      (`focus-ring.css` excludes it by name).
 *   2. **Tab (park on a button).** The walk moves to Cancel: the caret leaves,
 *      `data-kbf` comes up, and exactly one stop rings.
 *   3. **⇧Tab (park on the field).** Back on the field by MOVEMENT, so it
 *      parks: ring on the field, no caret, paint still up.
 *   4. **Enter (grant at the parked stop).** The caret comes back and the
 *      paint stands down — while `kbfEngaged()` stays TRUE, because the trap
 *      never moved. This is the divergence the whole feature is: attribute
 *      answers *painting*, the derivation answers *on*.
 *   5. **Escape (dismiss).** The sheet closes, the trap pops, and both
 *      answers go false together.
 *
 * Regression pins: `data-kbf` present with a live caret (scene 1/4 failing
 * `toBe(false)`) is the pre-(B) coexistence bug; `data-kbf` absent at a park
 * (scene 2/3) means a route flip escaped its repaint — the same defect the
 * dev-mode `kbf-caret-divergence` probe reports from the caret layer.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/components/tugways/cards/rename-session-sheet.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_COMPACT } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = ".rename-session-sheet";
const FIELD = '[data-testid="rename-session-input"]';
const CANCEL = '[data-testid="rename-cancel"]';
const SAVE = '[data-testid="rename-save"]';

const KBF_UP = `document.documentElement.hasAttribute("data-kbf")`;
const ENGAGED = `window.__tug.kbfEngaged() === true`;
const RINGED_COUNT = `document.querySelectorAll("[data-key-view-kbd]").length`;
const CARET_IN_FIELD = `(function(){
  var el = document.querySelector(${JSON.stringify(FIELD)});
  return el !== null && document.activeElement === el;
})()`;

describe.skipIf(!SHOULD_RUN)(
  "AT0397: KBF paint keys on the keyboard route",
  () => {
    test(
      "a granted caret stands the paint down; a park brings it back; the mode never moves",
      async () => {
        const app = await launchTugApp({ testName: "at0397-kbf-paint-route" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await app.bindSession("A", {
            tugSessionId: "a7c40397-0000-4000-8000-000000000397",
            projectDir: "/tmp",
          });
          await app.awaitEngineReady("A");

          // Open the rename sheet via the real submit path (the at0090 drive):
          // type the bare command, Escape the completion popup off, force-submit.
          await app.nativeClickAtElement(PROMPT_INPUT);
          await app.nativeType("/rename");
          await new Promise((r) => setTimeout(r, 200));
          await app.nativeKey("Escape");
          await new Promise((r) => setTimeout(r, 200));
          await app.nativeKey("Return", ["cmd"]);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
            { timeoutMs: 8000 },
          );

          // --- 1. Seeded open: engaged, granted, paint DOWN. ---
          await app.waitForCondition<boolean>(CARET_IN_FIELD, { timeoutMs: 8000 });
          expect(
            await app.evalJS<boolean>(ENGAGED),
            "the sheet's trap engages the mode (Class A)",
          ).toBe(true);
          expect(
            await app.evalJS<boolean>(KBF_UP),
            "a seeded caret opens with the mode's paint standing down",
          ).toBe(false);
          expect(
            await app.evalJS<number>(RINGED_COUNT),
            "no stop rings while the caret is granted",
          ).toBe(0);
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(SAVE)}).hasAttribute("data-default-ring")`,
            ),
            "the default ring is a Return promise, not mode paint — it stays",
          ).toBe(true);

          // --- 2. Tab parks on Cancel: paint UP, exactly one ring. ---
          await app.nativeKey("Tab");
          await app.waitForCondition<boolean>(
            `${KBF_UP} && !(${CARET_IN_FIELD})`,
            { timeoutMs: 6000 },
          );
          expect(await app.evalJS<number>(RINGED_COUNT)).toBe(1);
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(CANCEL)}).hasAttribute("data-key-view-kbd")`,
            ),
            "the walk landed on Cancel, ringed",
          ).toBe(true);

          // --- 3. ⇧Tab back parks the FIELD: ring, no caret, paint still up. ---
          await app.nativeKey("Tab", ["shift"]);
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(FIELD)});
              return el !== null && el.hasAttribute("data-key-view-kbd");
            })()`,
            { timeoutMs: 6000 },
          );
          expect(
            await app.evalJS<boolean>(CARET_IN_FIELD),
            "a text stop reached by movement parks — no caret",
          ).toBe(false);
          expect(await app.evalJS<boolean>(KBF_UP)).toBe(true);

          // --- 4. Enter grants: caret back, paint DOWN, mode still ON. ---
          await app.nativeKey("Return");
          await app.waitForCondition<boolean>(CARET_IN_FIELD, { timeoutMs: 6000 });
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
            ),
            "the grant consumed the Return — the sheet survives it",
          ).toBe(true);
          expect(
            await app.evalJS<boolean>(KBF_UP),
            "the grant stands the paint down",
          ).toBe(false);
          expect(await app.evalJS<number>(RINGED_COUNT)).toBe(0);
          expect(
            await app.evalJS<boolean>(ENGAGED),
            "the paint stood down but the trap holds — the MODE never moved",
          ).toBe(true);

          // --- 5. Escape dismisses: trap pops, both answers fall together. ---
          await app.nativeKey("Escape");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SHEET)}) === null`,
            { timeoutMs: 6000 },
          );
          await app.waitForCondition<boolean>(
            `!(${KBF_UP}) && window.__tug.kbfEngaged() === false`,
            { timeoutMs: 6000 },
          );
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0397-kbf-paint-route] log tail:\n${tail}\n`);
          }
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

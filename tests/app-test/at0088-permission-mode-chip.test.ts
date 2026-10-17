/**
 * at0088-permission-mode-chip.test.ts — the session's permission mode cycles
 * with `⌃⌥⌘P` and is set from the AI mixer's MODE row ([AT0088]).
 *
 * ## Why this exists
 *
 * Mode is one of the three settings the composite AI chip shows (its last
 * token) and the AI mixer sets. There is no `system_metadata` round-trip on a
 * `set_permission_mode` (claude answers with a control_response only), so the
 * chip reflects the change optimistically via
 * `SessionMetadataStore.applyPermissionMode`. Two user paths drive it:
 *
 *   1. **`⌃⌥⌘P`** — the `CYCLE_PERMISSION_MODE` key-card binding →
 *      the session card's card-content responder → `cycle()`. The chip's value
 *      line must advance through default → acceptEdits → plan → auto.
 *   2. **The mixer's MODE row** — clicking the chip opens the sheet; choosing a
 *      segment and pressing OK calls the session card's `setMode`. Nothing is
 *      sent before OK: the sheet is a transaction.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/permission-mode.ts
 * @covers tugdeck/src/lib/use-permission-mode.ts
 * @covers tugdeck/src/lib/default-permission-mode-store.ts
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/cards/ai-chip.tsx
 * @covers tugdeck/src/components/tugways/cards/ai-config-sheet.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const CHIP = `${CARD} [data-slot="ai-chip"]`;
// The shown value only. The value is a `TugStableOverlay`: the visible label
// lives in the `active` variant, while hidden width-sizer `alternate` variants
// (the widest composition) share the `ai-chip-value` wrapper to reserve the
// widest label. Read the active variant so `textContent` is the shown label
// alone, not the wrapper's value+sizers concatenation.
const CHIP_CONTENT = `${CHIP} [data-slot="ai-chip-value"]`;
// The mixer sheet + its MODE row (rendered into the pane frame portal).
const SHEET = '[data-slot="tug-sheet"]';
const MODE_ROW = `${SHEET} [data-testid="ai-config-mode"]`;
const MODE_SEGMENT = (value: string): string =>
  `${MODE_ROW} [data-choice-value="${value}"]`;
const AUTO_OPTION = MODE_SEGMENT("auto");
// The sheet commits on OK, not on segment click — it is a transaction.
const SHEET_OK = `${SHEET} [data-slot="ai-config-ok"]`;
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;

/**
 * The MODE the chip is showing — the last token of its composite value line.
 * `null` if the chip is absent. Mode is always final: an unsupported effort is
 * omitted rather than dashed, so the mode never shifts position.
 */
async function chipMode(app: App): Promise<string | null> {
  return await app.body("A").evalJS<string | null>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(CHIP_CONTENT)});
      if (el === null) return null;
      var parts = el.textContent.trim().split(" \\u00b7 ");
      return parts[parts.length - 1];
    })()`,
  );
}

/** The same read, as a JS expression for `waitForCondition`. */
const CHIP_MODE_EXPR = `(function(){
  var el = document.querySelector(${JSON.stringify(CHIP_CONTENT)});
  if (el === null) return null;
  var parts = el.textContent.trim().split(" \\u00b7 ");
  return parts[parts.length - 1];
})()`;

const KNOWN_MODE_LABELS = ["Default", "Accept Edits", "Plan", "Auto", "Bypass"];

describe.skipIf(!SHOULD_RUN)(
  "AT0088: the permission mode cycles via ⌃⌥⌘P and is set from the AI mixer",
  () => {
    test(
      "⌃⌥⌘P advances the mode; the mixer's MODE row sets it explicitly",
      async () => {
        const app = await launchTugApp({ testName: "at0088-permission-mode-chip" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: sessionCardShape({ width: 760, height: 560 }), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await app.bindSession("A");
          await app.awaitEngineReady("A");

          // The chip mounts as a two-line button with a value line. (We do not
          // wait for live claude metadata: the optimistic cycle works from the
          // unknown state too, and headless claude is slow / may never emit a
          // `system_metadata` — the chip's behavior under test is the
          // client-side cycle + sheet, not the live mode value.)
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CHIP_CONTENT)}) !== null`,
            { timeoutMs: 8000 },
          );

          const initialMode = await chipMode(app);

          // 1. ⌃⌥⌘P advances the mode (focus the editor first so the session card
          //    is the key card the binding routes to). From an unknown ("…")
          //    state the cycle resets to Default; from a known mode it steps to
          //    the next. Tug deliberately departs from the Claude Code TUI: the
          //    terminal cycles on Shift+Tab, but in a GUI Shift+Tab must move
          //    focus, so the cycle lives on a ⌘ chord — ⌃⌥⌘P, the advanced
          //    form of a Tug-tier command (tuglaws/chord-tiers.md), since the
          //    composer's Prompt route claimed ⌃⌘P.
          //
          //    The chord is dispatched as a synthetic capture-phase keydown
          //    rather than a native CGEvent: a posted ⌘ chord can be intercepted
          //    by macOS before it reaches the WebView, whereas a real user's
          //    keystroke reaches the document listener normally. The synthetic
          //    event drives the exact same capture-phase pipeline
          //    (`matchKeybinding` → key-card dispatch).
          await app.body("A").nativeClickAtElement(PROMPT_INPUT);
          await app.evalJS<void>(
            `document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyP", key: "p", metaKey: true, ctrlKey: true, altKey: true, bubbles: true, cancelable: true }))`,
          );
          await app.body("A").waitForCondition<boolean>(
            `(function(){
              var t = ${CHIP_MODE_EXPR};
              return t !== null && t !== ${JSON.stringify(initialMode)} &&
                ${JSON.stringify(KNOWN_MODE_LABELS)}.indexOf(t) !== -1;
            })()`,
            { timeoutMs: 4000 },
          );
          const afterCycle = await chipMode(app);
          expect(afterCycle, "Shift+Tab must change the mode").not.toBe(initialMode);
          expect(KNOWN_MODE_LABELS).toContain(afterCycle!);

          // 2. The mixer's MODE row sets the mode explicitly. Click the chip to
          //    open the sheet, choose the Auto segment (which moves the pending
          //    selection only), and commit with OK — so the full segment →
          //    selectValue → computeAiConfigCommit → setMode path runs.
          await app.body("A").nativeClickAtElement(CHIP);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(AUTO_OPTION)}) !== null`,
            { timeoutMs: 4000 },
          );
          // The row offers every mode, and exactly the current one is active.
          const sheetState = await app.evalJS<{ total: number; active: string[] }>(
            `(function(){
              var segs = document.querySelectorAll(${JSON.stringify(`${MODE_ROW} [data-choice-value]`)});
              var active = [];
              for (var i = 0; i < segs.length; i++) {
                if (segs[i].getAttribute('data-state') === 'active') {
                  active.push(segs[i].textContent.trim());
                }
              }
              return { total: segs.length, active: active };
            })()`,
          );
          expect(sheetState.total, "the MODE row offers every mode").toBe(5);
          expect(sheetState.active, "exactly the current mode is active").toEqual([
            afterCycle!,
          ]);

          // Choosing a segment moves the PENDING selection only — the chip must
          // not move until OK. This is the whole point of the transaction.
          await app.nativeClickAtElement(AUTO_OPTION);
          await app.waitForCondition<boolean>(
            `(function(){
              var s = document.querySelector(${JSON.stringify(AUTO_OPTION)});
              return s !== null && s.getAttribute('data-state') === 'active';
            })()`,
            { timeoutMs: 4000 },
          );
          expect(
            await chipMode(app),
            "the chip must not move before OK — the sheet is a transaction",
          ).toBe(afterCycle);

          await app.nativeClickAtElement(SHEET_OK);
          await app.body("A").waitForCondition<boolean>(
            `${CHIP_MODE_EXPR} === "Auto"`,
            { timeoutMs: 4000 },
          );
          expect(await chipMode(app), "OK must set the chip mode").toBe("Auto");
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0088-permission-mode-chip] log tail:\n${tail}\n`);
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

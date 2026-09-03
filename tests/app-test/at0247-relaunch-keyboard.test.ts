/**
 * at0247-relaunch-keyboard.test.ts — the TRUE quit-and-relaunch
 * sidebar keyboard pin.
 *
 * Pins the relaunch-with-sidebar-focus case (#57/#51): quit the app with
 * keyboard focus on the Jots list, relaunch, and the restored
 * ring must be a keyboard the user can actually drive — zero invariant
 * violations, and a NATIVE ArrowDown moves `data-key-cursor`.
 *
 * ## Why this file exists next to at0246
 *
 * at0246 pins the same invariant on the ACTIVATION channel: it seeds
 * the deck post-mount via `seedDeckState` with a `gallery-prompt-entry`
 * editor stand-in. The real relaunch path — constructor deck restore
 * from tugbank, CardHost mount-time `applyBagFocus` under the
 * `isActiveCardOfActivePane` gate, tugcast connect, late feeds-gated
 * session-card mount — was never driven by any test. This file drives
 * it for real:
 *
 * | Phase | Tugbank state at launch | Action                        | Assertion                     |
 * |-------|-------------------------|-------------------------------|-------------------------------|
 * | A     | empty (fresh temp DB)   | seed session deck → bind real | tugbank disk holds the Jots   |
 * |       |                         | session → ⌘L + Tab to the     | card's `bag.focus` with       |
 * |       |                         | jots list → quitGracefully| `keyboard: true`              |
 * | B     | populated (from A)      | relaunch with                 | ring on the jots list,    |
 * |       |                         | `restoreInTestMode` — NO      | zero invariant violations,    |
 * |       |                         | seeding, NO clicks — then a   | native ArrowDown moves        |
 * |       |                         | LATE session bind (the thief) | `data-key-cursor`             |
 *
 * Phase B launches with `restoreInTestMode: true`, the harness escape
 * hatch that lets the `DeckManager` constructor honor the persisted
 * layout/bags/focused-card exactly as a production cold boot does.
 * Under that flag the test-mode `feedsReady` bypass is also disabled
 * (see `card-host.tsx`), so the restored session card's editor mounts
 * LATE — only when its session binds — reproducing the production
 * mount ordering. The post-restore `bindSession` stands in for the
 * production re-resume that fires when tugcast feeds land.
 *
 * ## Reproduction attempt receipt (main @ 5de3693e0, pre-rework)
 *
 * The plan for this pin (`arc/keyboard-as-engine-state.md` [P11])
 * expected it to FAIL against the shipped focus-by-construction
 * engine. It does not: driven exactly as above, Phase B settles with
 * the ring on the jots list, `violations: 0`, ArrowDown moving the
 * cursor, and the late-bound editor NOT holding `document.activeElement`
 * (post-bind probe: `activeElement` = the jots list itself — the
 * bind-path focus claim is gated on card activation, so no steal fires
 * while the Jots card is the active card). The user-reported failure
 * evidently needs an ingredient the harness cannot recreate (real OS
 * window-focus timing during restore, or a raw substrate `view.focus()`
 * on the real re-resume path). The pin therefore lands LIVE from the
 * start: it guards the cold-boot restore channel through the
 * keyboard-as-engine-state rework rather than reproducing its trigger.
 *
 * @covers tugdeck/src/components/jots/
 * @covers tugdeck/src/components/cards/cards-store/
 * @covers tugdeck/src/serialization.ts
 * @covers tugdeck/src/components/tugways/focus-manager.ts
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
  tugbankRead,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const JOTS_LIST = ".jots-card .jots-list";
const JOTS_KBD = `${JOTS_LIST}[data-key-view-kbd]`;

const SESSION_DECK_STATE = {
  cards: [
    { id: "A", componentId: "session", title: "Session A", closable: true },
  ],
  panes: [
    {
      id: "p1",
      position: { x: 40, y: 40 },
      size: { width: 720, height: 540 },
      cardIds: ["A"],
      activeCardId: "A",
      title: "",
      acceptsFamilies: ["maker"],
    },
  ],
  activePaneId: "p1",
  hasFocus: true,
};

async function dispatch(app: App, action: string): Promise<void> {
  await app.dispatchControlAction(action);
}

/** Text of the row currently carrying `data-key-cursor`, or null. */
async function cursorRowText(app: App): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(`${JOTS_LIST} [data-key-cursor]`)});
      return el === null ? null : (el.textContent || "");
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0247 — true relaunch sidebar keyboard pin", () => {
  test(
    "quit with sidebar keyboard focus; relaunch restores a ring the keyboard actually reaches",
    async () => {
      const tugbankPath = mkTempTugbank();
      const filesDir = mkdtempSync(join(tmpdir(), "tug-at0247-"));
      const jotsPath = join(filesDir, "jots.json");
      const jots = Array.from({ length: 8 }, (_, i) => ({
        id: `s${i}`,
        text: `jot number ${i} — a one-line handle`,
      }));
      writeFileSync(
        jotsPath,
        `${JSON.stringify({ version: 1, jots: jots }, null, 2)}\n`,
      );

      let jotsCardId: string | null = null;

      try {
        seedTugbankForLaunch(tugbankPath);

        // ── Phase A: real session card, real ⌘L + Tab, graceful quit. ──
        {
          const app = await launchTugApp({
            testName: "at0247-relaunch-keyboard-A",
            env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
            persistInTestMode: true,
          });
          try {
            await app.seedDeckState({
              state: SESSION_DECK_STATE,
              focusCardId: "A",
            });
            await app.waitForCondition<boolean>(
              `window.__tug.assertHostRootRegistered("A")`,
              { timeoutMs: 5_000 },
            );
            // Bind a REAL session through the real bind path — the
            // session card's CM6 editor mounts and claims focus, the
            // same surface whose late bind is the relaunch thief.
            await new Promise<void>((r) => setTimeout(r, 1500));
            await app.bindSession("A");
            await app.waitForCondition<boolean>(
              `document.querySelector('[data-card-id="A"] .cm-content') !== null`,
              { timeoutMs: 6_000 },
            );
            // The product path: open the Jots card and walk into its rows.
            // The card's chrome (the filter field, the `+`) leads its focus
            // group, so the walk crosses it before it reaches the rows —
            // walked rather than counted, since what is pinned here is where
            // it ENDS.
            await dispatch(app, "toggle-jots");
            await app.waitForCondition<boolean>(
              `window.__tug.getActiveCardId() !== "A"`,
              { timeoutMs: 5_000 },
            );
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(JOTS_LIST)}) !== null`,
              { timeoutMs: 5_000 },
            );
            await app.waitForCondition<boolean>(
              `document.querySelector("[data-key-view-kbd]") !== null`,
              { timeoutMs: 8_000 },
            );
            for (let i = 0; i < 8; i += 1) {
              if (
                await app.evalJS<boolean>(
                  `document.querySelector(${JSON.stringify(JOTS_KBD)}) !== null`,
                )
              ) {
                break;
              }
              await app.nativeKey("Tab");
            }
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(JOTS_KBD)}) !== null`,
              { timeoutMs: 5_000 },
            );
            jotsCardId = await app.getActiveCardId();
            expect(jotsCardId).not.toBeNull();
            expect(jotsCardId).not.toBe("A");

            // Let the focus write settle into the bag, then quit
            // through the real termination path (saveAndFlushSync →
            // tugbank WAL).
            await new Promise<void>((r) => setTimeout(r, 500));
            await app.quitGracefully();
          } catch (e) {
            await app.close().catch(() => undefined);
            throw e;
          }
        }

        // ── Phase A disk assertion: the Jots card's bag persisted a keyboard
        //    focus on the jots section. ──
        const onDisk = tugbankRead<{
          focus?: { kind?: string; focusKey?: string; keyboard?: boolean } | null;
        }>(tugbankPath, "dev.tugtool.deck.cardstate", jotsCardId!);
        expect(onDisk).not.toBeNull();
        const savedFocus = onDisk?.value?.focus;
        expect(savedFocus?.keyboard).toBe(true);
        expect(savedFocus?.focusKey ?? "").toStartWith("jots-card");

        // ── Phase B: relaunch against the same tugbank. NO seeding,
        //    NO clicks — the constructor restore is the code under
        //    test. ──
        {
          const app = await launchTugApp({
            testName: "at0247-relaunch-keyboard-B",
            env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
            persistInTestMode: true,
            restoreInTestMode: true,
          });
          try {
            // The restored deck mounts on its own: the jots list
            // arrives when the jots feed lands.
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(JOTS_LIST)}) !== null`,
              { timeoutMs: 10_000 },
            );
            // 1. The ring restored onto the jots list.
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(JOTS_KBD)}) !== null`,
              { timeoutMs: 8_000 },
            );

            // The session card's late bind — in production the session
            // re-resumes when tugcast feeds land, AFTER the Jots ring
            // has restored, and its editor mounts behind the (now
            // un-bypassed) `feedsReady` gate. The harness bind stands
            // in for that re-resume: same card, same editor, same
            // late-mount ordering.
            await app.bindSession("A");
            await new Promise<void>((r) => setTimeout(r, 1_000));
            const postBind = await app.evalJS<unknown>(
              `(function(){
                var a = document.activeElement;
                return {
                  editorMounted: document.querySelector('[data-card-id="A"] .cm-content') !== null,
                  active: a === null ? "null" : (a.tagName + "." + String(a.className)),
                  report: window.__tug.getFocusInvariantReport(),
                };
              })()`,
            );
            console.log("[at0247] PHASE_B post-bind:", JSON.stringify(postBind));

            // 2. The ring survived the late bind.
            expect(
              await app.evalJS<boolean>(
                `document.querySelector(${JSON.stringify(JOTS_KBD)}) !== null`,
              ),
            ).toBe(true);

            // 3. Zero invariant violations — the engine never lied.
            const report = await app.evalJS<{ violations: number } | null>(
              `window.__tug.getFocusInvariantReport()`,
            );
            expect(report).not.toBeNull();
            expect(report!.violations).toBe(0);

            // 4. A NATIVE ArrowDown moves the cursor — the ring is a
            //    keyboard the user can actually drive.
            const before = await cursorRowText(app);
            await app.nativeKey("ArrowDown");
            await app.waitForCondition<boolean>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(`${JOTS_LIST} [data-key-cursor]`)});
                return el !== null && (el.textContent || "") !== ${JSON.stringify(before ?? "")};
              })()`,
              { timeoutMs: 4_000 },
            );
            const after = await cursorRowText(app);
            expect(after).not.toBeNull();
            expect(after).not.toBe(before);
          } finally {
            await app.quitGracefully();
          }
        }
      } finally {
        rmSync(filesDir, { recursive: true, force: true });
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

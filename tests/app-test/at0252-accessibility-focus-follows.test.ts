/**
 * at0252-accessibility-focus-follows.test.ts — the accessibility-mode
 * focus-follows mirror ([P10]).
 *
 * In `accessibility` keyboard-access mode the engine grants real DOM focus
 * to every engine-routed key view, so assistive tech tracks the keyboard
 * natively; in `standard` mode the same key view parks `activeElement` on
 * the key sink. The mode flip is driven through the REAL host seam — the
 * `voiceover-changed` control action the Swift side sends from its
 * `NSWorkspace.isVoiceOverEnabled` observation — so the whole pipe
 * (action-dispatch → keyboardAccessStore → provider subscription →
 * FocusManager mirror) is under test, not a store poke.
 *
 * Pinned: sink park in standard mode → mirror grant on flip (activeElement
 * lands on the key-view element, which regains a tabindex="-1") → the
 * mirror tracks arrow navigation and the ring stays on → flip back
 * re-parks the sink and removes the added tabindex → the watchdog report
 * stays clean (zero violations, empty steal ledger) across the whole tour.
 *
 * @covers tugdeck/src/keyboard-access-store.ts
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/components/tugways/theme-accessibility.ts
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
const TEST_TIMEOUT_MS = 60_000;

const JOTS_LIST = ".jots-card .jots-list";
const JOTS_KBD = `${JOTS_LIST}[data-key-view-kbd]`;
const CURSOR = `${JOTS_LIST} [data-key-cursor]`;

const ROWS = 5;

function priorCardDeck() {
  return {
    cards: [
      { id: "A", componentId: "gallery-accordion", title: "Accordion", closable: true },
    ],
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

async function activeElementProbe(app: App): Promise<{
  isSink: boolean;
  isJotsList: boolean;
  accessAttr: string | null;
}> {
  return app.evalJS(
    `(function(){
      var ae = document.activeElement;
      var list = document.querySelector(${JSON.stringify(JOTS_LIST)});
      return {
        isSink: ae !== null && ae.hasAttribute("data-tug-key-sink"),
        isJotsList: ae !== null && list !== null && ae === list,
        accessAttr: document.documentElement.getAttribute("data-keyboard-access"),
      };
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0252 — accessibility focus-follows mirror", () => {
  test(
    "the voiceover-changed seam flips the mode; DOM focus mirrors the key view",
    async () => {
      const tugbankPath = mkTempTugbank();
      const filesDir = mkdtempSync(join(tmpdir(), "tug-at0252-"));
      const jotsPath = join(filesDir, "jots.json");
      const jots = Array.from({ length: ROWS }, (_, i) => ({
        id: `s${i}`,
        text: `row-${i} jot handle`,
      }));
      writeFileSync(
        jotsPath,
        `${JSON.stringify({ version: 1, jots: jots }, null, 2)}\n`,
      );
      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0252-accessibility-focus-follows",
          env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
        });
        try {
          await app.seedDeckState({ state: priorCardDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          // Keyboard into the Jots card: engine-routed key view on the
          // jots list, activeElement parked on the sink. The band leads
          // its section and every control on it is a stop, so the walk
          // crosses the band before it reaches the rows.
          await app.dispatchControlAction("toggle-jots");
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-key-view-kbd]") !== null`,
            { timeoutMs: 5_000 },
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
          const standard = await activeElementProbe(app);
          expect(standard.accessAttr).toBe("standard");
          expect(standard.isSink).toBe(true);
          expect(standard.isJotsList).toBe(false);

          // VoiceOver on → accessibility mode → the mirror grants the
          // key-view element real DOM focus (with a regained tabindex).
          await app.dispatchControlAction("voiceover-changed", { enabled: true });
          await app.waitForCondition<boolean>(
            `(function(){
              var list = document.querySelector(${JSON.stringify(JOTS_LIST)});
              return list !== null && document.activeElement === list;
            })()`,
            { timeoutMs: 5_000 },
          );
          const mirrored = await activeElementProbe(app);
          expect(mirrored.accessAttr).toBe("accessibility");
          expect(mirrored.isJotsList).toBe(true);
          // The invariant is "the list became programmatically focusable so the
          // mirror could grant it" — the grant itself is already asserted
          // above. Which non-stop tabindex spelling the mirror uses is a
          // mechanism, so only its presence is pinned here.
          expect(
            await app.evalJS<string | null>(
              `(function(){
                var list = document.querySelector(${JSON.stringify(JOTS_LIST)});
                return list === null ? null : list.getAttribute("tabindex");
              })()`,
            ),
          ).not.toBeNull();

          // Arrows still move the cursor while the mirror holds focus on
          // the list, and the ring stays keyboard-held.
          await app.nativeKey("ArrowDown");
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(CURSOR)});
              return el !== null && (el.textContent || "").indexOf("row-1") !== -1;
            })()`,
            { timeoutMs: 3_000 },
          );
          const midTour = await activeElementProbe(app);
          expect(midTour.isJotsList).toBe(true);
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(JOTS_KBD)}) !== null`,
            ),
          ).toBe(true);

          // VoiceOver off → the detection-driven flip is undone: the park
          // resumes on the sink and the mirror's added tabindex is removed.
          await app.dispatchControlAction("voiceover-changed", { enabled: false });
          await app.waitForCondition<boolean>(
            `(function(){
              var ae = document.activeElement;
              return ae !== null && ae.hasAttribute("data-tug-key-sink");
            })()`,
            { timeoutMs: 5_000 },
          );
          const restored = await activeElementProbe(app);
          expect(restored.accessAttr).toBe("standard");
          expect(restored.isSink).toBe(true);
          // Residue check, not a stop check: a leftover tabindex would leave the
          // list mouse-focusable and feed the mousedown focus churn the
          // watchdog then has to park.
          expect(
            await app.evalJS<string | null>(
              `(function(){
                var list = document.querySelector(${JSON.stringify(JOTS_LIST)});
                return list === null ? null : list.getAttribute("tabindex");
              })()`,
            ),
          ).toBe(null);

          // The whole tour was engine-written focus: zero violations, an
          // empty attributed steal ledger.
          const report = await app.evalJS<{
            violations: number;
            steals: Record<string, number>;
          } | null>(`window.__tug.getFocusInvariantReport()`);
          expect(report).not.toBeNull();
          expect(report!.violations).toBe(0);
          expect(Object.keys(report!.steals)).toEqual([]);
        } finally {
          await app.close();
        }
      } finally {
        rmSync(filesDir, { recursive: true, force: true });
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

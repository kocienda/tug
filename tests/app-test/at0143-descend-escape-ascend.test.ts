/**
 * at0143-descend-escape-ascend.test.ts — Escape ascends out of a descended
 * scope INSIDE a sheet; it dismisses the sheet only at the sheet's top level.
 *
 * ## Why this exists
 *
 * at0120 proves Enter-descend + Escape-ascend on a gallery accordion whose inner
 * control is a BUTTON, with no enclosing modal. The `/permissions` sheet is the
 * untested combination: a descendable accordion whose inner control is a TEXT
 * INPUT, inside a Radix dialog that dismisses on Escape (a bubble-phase React
 * `onKeyDown`). The engine's ascend is a capture-phase document listener that
 * must win — so a single Escape from inside the add-rule form must ascend back
 * to the "Add a rule" header and leave the sheet OPEN, not dismiss it.
 *
 * This test reproduces / guards that boundary: descend into the add-rule form,
 * press Escape ONCE, and assert the sheet is still open with the key view back
 * on the accordion (not the input). A second Escape, at the sheet's trapped top,
 * is then allowed to dismiss.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/components/tugways/focus-act.ts
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/components/tugways/tug-accordion.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = '[data-slot="tug-sheet"]';
const ACC = `${SHEET} [data-slot="tug-accordion"]`;
const ADD_INPUT = `${SHEET} .permission-rules-add-input`;

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0143-perms-"));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

/** Does `selector` currently carry the keyboard key-view marker? */
function hasKbd(app: App, selector: string): Promise<boolean> {
  return app.evalJS<boolean>(
    `(function(){var el=document.querySelector(${JSON.stringify(selector)});return el!==null && el.hasAttribute("data-key-view-kbd");})()`,
  );
}

const SHEET_OPEN = `document.querySelector(${JSON.stringify(SHEET)}) !== null`;

describe.skipIf(!SHOULD_RUN)(
  "AT0143: Escape ascends out of a descended sheet scope before dismissing the sheet",
  () => {
    test(
      "descend into the add-rule form, Escape ascends to the header (sheet stays), second Escape dismisses",
      async () => {
        const app = await launchTugApp({ testName: "at0143-descend-escape-ascend" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: sessionCardShape({ width: 820, height: 680 }), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A");

          // Open /permissions via the real submit path.
          await app.nativeClickAtElement(PROMPT_INPUT);
          await app.nativeType("/permissions");
          await new Promise((r) => setTimeout(r, 200));
          await app.nativeKey("Escape");
          await new Promise((r) => setTimeout(r, 200));
          await app.nativeKey("Return", ["cmd"]);
          await app.waitForCondition<boolean>(SHEET_OPEN, { timeoutMs: 6000 });

          // Move the keyboard key view from the seeded Done button onto the
          // add-rule accordion (Tab walks tab bar → accordion → filter → list →
          // Done → wrap). Loop defensively rather than hard-coding the count.
          let onAccordion = false;
          for (let i = 0; i < 8 && !onAccordion; i += 1) {
            await app.nativeKey("Tab");
            await new Promise((r) => setTimeout(r, 150));
            onAccordion = await hasKbd(app, ACC);
          }
          expect(onAccordion, "the accordion can hold the keyboard key view").toBe(true);

          // Expand the section (Space) so it has navigable content, then descend
          // (Enter): the key view leaves the accordion and lands on the matcher
          // input inside the form.
          await app.nativeKey(" ");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(ADD_INPUT)}) !== null`,
            { timeoutMs: 4000 },
          );
          // An Enter-descend onto a text input is a GRANT: the caret lands in
          // the field and the mode's paint stands down ([#kbf-paint-route]),
          // so the landing mark is the caret plus the UNFLAVORED
          // `data-key-view` — asserting the ring flavor here would demand
          // paint the engine correctly is not showing.
          await app.nativeKey("Enter");
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(ADD_INPUT)});
              return el !== null && el.hasAttribute("data-key-view") &&
                document.activeElement === el;
            })()`,
            { timeoutMs: 4000 },
          );

          // THE BOUNDARY: one Escape from inside the descended form must ascend
          // back to the accordion header — the sheet stays open, and the key
          // view returns to the accordion (not the input).
          await app.nativeKey("Escape");
          await new Promise((r) => setTimeout(r, 300));

          expect(
            await app.evalJS<boolean>(SHEET_OPEN),
            "one Escape from inside the form must NOT dismiss the sheet",
          ).toBe(true);
          expect(
            await hasKbd(app, ACC),
            "one Escape ascends the key view back to the accordion",
          ).toBe(true);
          expect(
            await hasKbd(app, ADD_INPUT),
            "the input no longer holds the key view after ascend",
          ).toBe(false);

          // At the sheet's trapped top, a second Escape dismisses the sheet.
          await app.nativeKey("Escape");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SHEET)}) === null`,
            { timeoutMs: 4000 },
          );

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0143-descend-escape-ascend] log tail:\n${tail}\n`);
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

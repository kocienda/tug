/**
 * at0399-shade-focus.test.ts — an open shade shows exactly one ring, and every
 * Tab stop under it is a place you can see.
 *
 * ## Why this exists
 *
 * Two defects, one theme — a mark or a stop that exists in the engine and
 * nowhere on screen.
 *
 * **History painted two rings.** The scrolling commit list held the shade's key
 * view, and because that key view was a non-button the engine ALSO projected
 * the persistent default ring onto Done beneath it. Both painted at once: a
 * keyboard-focus ring on the list and a Return promise on Done. The list was
 * never worth landing on — it is a reading surface with no act of its own — so
 * it leaves the walk entirely, Done becomes the shade's seeded key view, and
 * its one ring says both things at once.
 *
 * **The Changes shade had five ghost tabs.** That shade is passive, so the walk
 * is not trapped into it the way History's is; the Z2 status cells stayed
 * registered while sitting BEHIND the shade. Five Tabs in a row moved the ring
 * onto covered elements — a stop that looks like nothing at all. They leave the
 * cycle for as long as a shade is open.
 *
 * Alongside them, the Changes Z5. `data-shade-open` used to be a bare boolean
 * that stood the composer's default ring down, on the premise that "the shade
 * owns the default" — true of History, which has a Done, and false of Changes,
 * which has none and whose act is performed by the composer's own Commit
 * button. The attribute now carries the shade's NAME, and the commit button
 * declares itself the entry default with its Shift+Return chord
 * ([#chord-ring]) exactly as the prompt route's submit does.
 *
 * **And the History ring promised a key it never got.** The stand-down above
 * settled who WEARS the default ring while History is up — Done — but only in
 * paint. The shade's carve-out leaves the composer live beneath it, and the
 * composer's shipped Return action is `newline`: the editor's default-button
 * defer ran on the `submit` branch alone, so a Return with the caret back in
 * the composer broke a line while the only ring on screen promised dismissal.
 * The yield now carries the key as well as the mark — a plain Return presses
 * the chordless default, and takes its newline back the moment the shade goes.
 *
 * Not asserted here: the commit button's ring RESOLVING dashed→solid. That
 * needs a landable changeset, which an app-test's transient workspace cannot
 * hold still; the button is disabled without one and a disabled default rightly
 * promises nothing. The resolution itself is the same two CSS rules at0398
 * pins on the prompt Z5 — what this suite adds is that the commit button is
 * the wearer, and that nothing stands its ring down any more.
 *
 * @covers tugdeck/src/components/tugways/cards/session-history/session-history-view.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.css
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/keymap.ts
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The worktree — the real repo tugcast serves as its bootstrap tree. */
const REPO = resolve(import.meta.dir, "..", "..");

const CARD = '[data-card-id="D"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const DONE = '[data-testid="session-history-done"]';
const LIST = '[data-slot="session-history-view"]';
const COMMIT = ".tug-prompt-entry-commit-button";

const settle = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** How a DOM node is named in this suite's diagnostics. */
const IDENT = `function(el){
  if (el === null || el === undefined) return "none";
  return el.getAttribute("data-testid") || el.getAttribute("data-slot") ||
    el.getAttribute("aria-label") || el.tagName.toLowerCase();
}`;

/** Everything painting a visible outline right now, by name. */
function ringWearers(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `(function(){
      var ident = ${IDENT};
      var out = [];
      var all = document.querySelectorAll("*");
      for (var i = 0; i < all.length; i++) {
        var cs = getComputedStyle(all[i]);
        if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) {
          out.push(ident(all[i]));
        }
      }
      return out;
    })()`,
  );
}

/**
 * The stop the keyboard rests on, and whether that stop is VISIBLY marked.
 *
 * "Visibly" means somewhere in the stop's own subtree: a composite stop paints
 * its ring on the part that reads as the control — the choice group on its live
 * segment, the editor stop on the CM6 view inside it — so a test that looked
 * only at the registered element would call those ghosts when they are not.
 */
function keyView(app: App): Promise<{ name: string; ringed: boolean }> {
  return app.evalJS<{ name: string; ringed: boolean }>(
    `(function(){
      var ident = ${IDENT};
      var el = document.querySelector("[data-key-view-kbd]");
      if (el === null) return { name: "none", ringed: false };
      function rings(node){
        var cs = getComputedStyle(node);
        return cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
      }
      var ringed = rings(el);
      if (!ringed) {
        var kids = el.querySelectorAll("*");
        for (var i = 0; i < kids.length && !ringed; i++) ringed = rings(kids[i]);
      }
      return { name: ident(el), ringed: ringed };
    })()`,
  );
}

/**
 * How many lines the composer's document holds. Counted rather than read as
 * text: an empty CM6 document renders its placeholder INSIDE the one line, so
 * text is "" for nobody and the line count is the only thing that says whether
 * a Return broke the line.
 */
function lineCount(app: App): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(`${EDITOR} .cm-line`)}).length`,
  );
}

function deckShape() {
  return {
    cards: [
      { id: "D", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: "pD",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 720 },
        cardIds: ["D"],
        activeCardId: "D",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pD",
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)(
  "AT0399: an open shade rings one control and stops only where you can see",
  () => {
    test(
      "History: Done alone rings and alone stops; Changes: no ghost stops, and the commit button is the default",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath, { sourceTreePath: REPO });
        const app = await launchTugApp({
          testName: "at0399-shade-focus",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `typeof window.__tug !== "undefined"`,
            { timeoutMs: 15_000 },
          );
          await app.seedDeckState({ state: deckShape(), focusCardId: "D" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("D")`,
            { timeoutMs: 15_000 },
          );
          await app.bindSession("D", { projectDir: REPO });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
            { timeoutMs: 15_000 },
          );

          // The caret starts where a user puts it.
          await app.nativeClickAtElement(EDITOR);
          await settle(300);

          // ---- History: one ring, one stop ----
          await app.nativeKey("h", ["ctrl", "cmd"]);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DONE)}) !== null`,
            { timeoutMs: 12_000 },
          );
          await settle(500);

          const opened = await keyView(app);
          note("history opened", opened);
          expect(opened.name, "the shade seeds its key view on Done").toBe(
            "session-history-done",
          );

          const historyRings = await ringWearers(app);
          note("history rings", historyRings);
          expect(
            historyRings,
            "one keyboard, one mark — Done's ring is the whole of it",
          ).toEqual(["session-history-done"]);

          // The list is not a stop and takes no DOM focus of its own.
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(LIST)})?.hasAttribute("tabindex") === true`,
            ),
            "the commit list is a reading surface, not a tab stop",
          ).toBe(false);

          // Tabbing does not find a second place to be.
          for (let i = 0; i < 3; i++) {
            await app.nativeKey("Tab", []);
            await settle(200);
            const after = await keyView(app);
            expect(
              after.name,
              `Tab ${i + 1} has nowhere else to go — Done is the shade's only stop`,
            ).toBe("session-history-done");
            expect(await ringWearers(app), `Tab ${i + 1} still rings once`).toEqual([
              "session-history-done",
            ]);
          }

          // ---- The ring's promise holds from the composer too ----
          //
          // The shade's modal carve-out leaves the prompt entry live, so the
          // caret can go back to it while Done still wears the only default
          // ring on screen. A ring that says "Return lands here" has to be
          // true from wherever the keyboard is: the composer's own Return is
          // the `newline` setting, and a newline written under a promise of
          // dismissal is the promise broken.
          await app.nativeClickAtElement(EDITOR);
          await settle(300);
          expect(
            await ringWearers(app),
            "the composer's own default stands down — Done is still the only ring",
          ).toEqual(["session-history-done"]);

          await app.nativeKey("Return", []);
          await settle(500);

          expect(
            await lineCount(app),
            "Return went to Done, not into the document",
          ).toBe(1);
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(DONE)}) === null`,
            ),
            "and the shade it promised to dismiss is gone",
          ).toBe(true);

          await settle(400);

          // With no shade above it the composer's Return is its own again —
          // the yield is the shade's, and it leaves with the shade.
          await app.nativeClickAtElement(EDITOR);
          await settle(250);
          await app.nativeKey("Return", []);
          await settle(300);
          expect(
            await lineCount(app),
            "a shade-less Return is the editor's newline, exactly as the setting says",
          ).toBe(2);
          await app.nativeKey("Backspace", []);
          await settle(200);

          // ---- Changes: no ghost stops, and a default that exists ----
          await app.nativeClickAtElement(EDITOR);
          await settle(250);
          await app.nativeKey("c", ["ctrl", "cmd"]);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(COMMIT)}) !== null`,
            { timeoutMs: 12_000 },
          );
          await settle(500);

          const shadeName = await app.evalJS<string | null>(
            `document.querySelector('${CARD} .session-card')?.getAttribute("data-shade-open") ?? null`,
          );
          expect(
            shadeName,
            "the card names the open shade, so the stand-down can be History's alone",
          ).toBe("changes");

          const commitDefault = await app.evalJS<{
            entryDefault: boolean;
            chord: string | null;
            inLitShell: boolean;
          }>(
            `(function(){
              var b = document.querySelector(${JSON.stringify(COMMIT)});
              return {
                entryDefault: b.hasAttribute("data-tug-entry-default"),
                chord: b.getAttribute("data-default-chord"),
                inLitShell: b.closest(".tug-entry-shell[data-entry-keyboard]") !== null
              };
            })()`,
          );
          note("commit button", commitDefault);
          expect(
            commitDefault.entryDefault,
            "commit mode's Z5 IS Return's home there",
          ).toBe(true);
          expect(
            commitDefault.chord,
            "and a plain Return writes a newline, so the promise is a chord",
          ).toBe("shift");
          expect(
            commitDefault.inLitShell,
            "with the caret in the composer its shell holds the keyboard",
          ).toBe(true);

          // The cancel gesture is the shade header's X, not a Z5 button. Both
          // halves are asserted together: a header X that appeared while the
          // Z5 one stayed would double the control rather than move it.
          const cancelSite = await app.evalJS<{
            header: number;
            headerLabel: string | null;
            z5: number;
          }>(
            `(function(){
              var card = document.querySelector(${JSON.stringify(CARD)});
              var x = card.querySelector('[data-testid="session-changes-dismiss"]');
              return {
                header: x === null ? 0 : 1,
                headerLabel: x === null ? null : x.getAttribute("aria-label"),
                z5: card.querySelectorAll(".tug-prompt-entry-commit-cancel").length
              };
            })()`,
          );
          note("cancel lives in the header", cancelSite);
          expect(cancelSite.header, "the shade header carries the dismiss X").toBe(1);
          expect(
            cancelSite.headerLabel,
            "and in commit mode it says what it cancels",
          ).toBe("Cancel commit");
          expect(cancelSite.z5, "the Z5 rail no longer carries one").toBe(0);

          // ⌥Tab engages KBF, then walk the cycle the shade leaves live.
          await app.nativeKey("Tab", ["alt"]);
          await settle(350);

          const walk: Array<{ name: string; ringed: boolean }> = [];
          for (let i = 0; i < 8; i++) {
            await app.nativeKey("Tab", []);
            await settle(200);
            walk.push(await keyView(app));
          }
          note("changes walk", walk);

          expect(
            walk.filter((s) => s.name === "tug-status-cell").length,
            "the Z2 cells are behind the shade — five stops that looked like nothing",
          ).toBe(0);
          expect(
            walk.filter((s) => !s.ringed).length,
            "every stop the walk lands on paints its own ring",
          ).toBe(0);
          expect(
            new Set(walk.map((s) => s.name)).size,
            "the live cycle is small and closes on itself within eight steps",
          ).toBeLessThan(8);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0399-shade-focus] log tail:\n${tail}\n`);
          }
          throw err;
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

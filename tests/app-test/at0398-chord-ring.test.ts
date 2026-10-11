/**
 * at0398-chord-ring.test.ts — the double ring means "Return fires this", and a
 * default whose activation is a CHORD says so by going dotted.
 *
 * ## Why this exists
 *
 * The composer's Z5 submit is the app's most prominent default button, and at
 * the shipped `returnKeyAction` (`newline`) a plain Return inserts a line —
 * SHIFT+Return is what submits. It wore a solid ring anyway, which is the ring
 * language's one promise stated falsely on its most visible wearer.
 *
 * The fix is not to drop the mark but to qualify it ([#chord-ring]): the
 * chord wearer paints the same double ring in
 * `--tugx-focus-ring-chord-style`, and the moment the chord's modifier goes
 * down — the moment a Return really would fire it — the ring resolves to
 * solid. So the ring is never false at any instant, and holding Shift is the
 * gesture that shows the user what Return is about to do.
 *
 * This suite pins all three claims against the real app:
 *
 *   1. **Dotted at rest.** The Z5 declares `data-default-chord="shift"` and
 *      computes a dotted outline while its shell holds the keyboard.
 *   2. **Solid while held.** With Shift physically down (`withModifiersHeld`,
 *      which unlike `holdModifier` lets the test look at the app mid-hold),
 *      `data-mods` lands on `<html>` and the same outline computes solid —
 *      then goes back to dotted on release.
 *   2b. **Exclusively.** Shift+Return is an exclusive chord — Cmd+Shift+Return
 *      submits nothing — so Shift held WITH Cmd leaves the ring dotted. The
 *      latch carries the whole held set for exactly this read.
 *   3. **The honest wearer is untouched, and only one wearer lights.** ⌘F
 *      moves the keyboard to the find bar, whose default IS fired by a plain
 *      Return: it paints solid, carries no chord attribute, and does not
 *      flinch when Shift goes down. The composer's Z5 goes dark in the same
 *      move, so the deck never shows two Return promises at once. This suite
 *      counts the wearers directly: the engine's `return-promise-collision`
 *      probe is dev-only and compiled out of the bundle app-tests serve.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/modifier-latch.ts
 * @covers tugdeck/src/components/tugways/tug-entry-shell.css
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/components/tugways/internal/tug-button.css
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/components/tugways/responder-chain-provider.tsx
 * @covers tugdeck/styles/focus-ring.css
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SUBMIT = `${CARD} .tug-prompt-entry-submit-button`;
const FIND_BAR = `${CARD} [data-slot="session-card-find-bar"]`;
const FIND_NEXT = `${FIND_BAR} [aria-label="Find next"]`;

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0398-chord-"));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

interface RingRead {
  /** The wearer's declared chord, or null when a plain Return fires it. */
  chord: string | null;
  /** `outline-style` as computed — `none` when the ring is not lit at all. */
  style: string;
  /** Whether the wearer's shell currently holds the keyboard. */
  lit: boolean;
}

/** Read one wearer's chord declaration and its computed outline. */
function readRing(app: App, selector: string): Promise<RingRead | null> {
  return app.evalJS<RingRead | null>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      var shell = el.closest(".tug-entry-shell");
      return {
        chord: el.getAttribute("data-default-chord"),
        style: getComputedStyle(el).outlineStyle,
        lit: shell !== null && shell.hasAttribute("data-entry-keyboard"),
      };
    })()`,
  );
}

/** Is the held-modifier latch reporting Shift and nothing else? */
function shiftLatchedAlone(app: App): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.documentElement.getAttribute("data-mods") === "shift"`,
  );
}

/** The whole held set the latch is reporting, `""` when the attribute is absent. */
function heldMods(app: App): Promise<string> {
  return app.evalJS<string>(
    `document.documentElement.getAttribute("data-mods") || ""`,
  );
}

/**
 * Every control currently promising Return — the same query the engine's dev
 * invariant runs. More than one is the collision.
 */
function returnPromiseCount(app: App): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll(
      "[data-default-ring]:not(:disabled):not([aria-disabled='true'])," +
      ".tug-entry-shell[data-entry-keyboard] [data-tug-entry-default]:not(:disabled):not([aria-disabled='true'])"
    ).length`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "AT0398: a chord-activated default wears the ring dotted, solid while the chord is held",
  () => {
    test(
      "Z5 dotted at rest → solid under held Shift → dotted again; the find bar's honest default stays solid and alone",
      async () => {
        const app = await launchTugApp({ testName: "at0398-chord-ring" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: sessionCardShape({ width: 860, height: 700 }), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 15_000 },
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A");

          // --- 1. Dotted at rest. ---
          // A draft first: the Z5 is disabled on an empty composer, and a
          // disabled default is no Return target on either paint path.
          await app.nativeClickAtElement(EDITOR);
          await app.nativeType("hello");
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(SUBMIT)});
              return el !== null && !el.disabled &&
                el.closest(".tug-entry-shell")?.hasAttribute("data-entry-keyboard") === true;
            })()`,
            { timeoutMs: 8000 },
          );

          const atRest = await readRing(app, SUBMIT);
          note("z5 at rest", atRest);
          expect(atRest?.chord, "the Z5 declares its chord").toBe("shift");
          expect(
            atRest?.style,
            "a chord default paints the ring dotted — plain Return inserts a newline",
          ).toBe("dotted");

          // --- 2. Solid while Shift is held. ---
          // `withModifiersHeld` is the introspectable hold: the press and the
          // release are separate RPCs, so the app repaints and can be read
          // between them.
          let heldStyle = "";
          let heldLatch = false;
          await app.withModifiersHeld(["shift"], async () => {
            await app.waitForCondition<boolean>(
              `document.documentElement.getAttribute("data-mods") === "shift"`,
              { timeoutMs: 4000 },
            );
            heldLatch = await shiftLatchedAlone(app);
            heldStyle = (await readRing(app, SUBMIT))?.style ?? "";
          });
          note("z5 under held shift", { latch: heldLatch, style: heldStyle });
          expect(heldLatch, "the latch projects the held Shift onto <html>").toBe(true);
          expect(
            heldStyle,
            "with Shift down a Return WOULD submit, so the ring resolves to solid",
          ).toBe("solid");

          // --- 2b. Shift is not enough — Shift ALONE is. ---
          // Cmd+Shift+Return submits nothing (every keystroke path matches
          // modifiers exactly), so the ring must stay dotted under the pair.
          let pairMods = "";
          let pairStyle = "";
          await app.withModifiersHeld(["shift", "cmd"], async () => {
            await app.waitForCondition<boolean>(
              `(document.documentElement.getAttribute("data-mods") || "").indexOf("meta") >= 0`,
              { timeoutMs: 4000 },
            );
            pairMods = await heldMods(app);
            pairStyle = (await readRing(app, SUBMIT))?.style ?? "";
          });
          note("z5 under held shift+cmd", { mods: pairMods, style: pairStyle });
          expect(
            pairMods.split(" ").sort().join(" "),
            "the latch carries the WHOLE held set, not just the painted-on bit",
          ).toBe("meta shift");
          expect(
            pairStyle,
            "Cmd+Shift+Return fires nothing, so the conditional promise stays conditional",
          ).toBe("dotted");

          // --- 3. Dotted again on release. ---
          await app.waitForCondition<boolean>(
            `!document.documentElement.hasAttribute("data-mods")`,
            { timeoutMs: 4000 },
          );
          expect(
            (await readRing(app, SUBMIT))?.style,
            "releasing Shift takes the promise back",
          ).toBe("dotted");
          expect(
            await returnPromiseCount(app),
            "exactly one control promises Return with the composer focused",
          ).toBe(1);

          // --- 4. The find bar's default is honest and stands alone. ---
          await app.nativeKey("f", ["cmd"]);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(FIND_NEXT)}) !== null`,
            { timeoutMs: 8000 },
          );
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(FIND_NEXT)});
              return el !== null &&
                el.closest(".tug-entry-shell")?.hasAttribute("data-entry-keyboard") === true;
            })()`,
            { timeoutMs: 8000 },
          );

          const findRing = await readRing(app, FIND_NEXT);
          const z5Dark = await readRing(app, SUBMIT);
          note("find-next lit / z5 dark", { findRing, z5Dark });
          expect(
            findRing?.chord,
            "Return in the query field really does fire Find Next — no chord",
          ).toBeNull();
          expect(findRing?.style, "so its ring is plain solid").toBe("solid");
          expect(
            z5Dark?.lit,
            "the composer's shell gave up the keyboard, so its default goes dark",
          ).toBe(false);
          expect(
            await returnPromiseCount(app),
            "two shells are mounted but only one may promise Return",
          ).toBe(1);

          // --- 5. An honest ring does not flinch under Shift. ---
          let findHeldStyle = "";
          await app.withModifiersHeld(["shift"], async () => {
            await app.waitForCondition<boolean>(
              `(document.documentElement.getAttribute("data-mods") || "").indexOf("shift") >= 0`,
              { timeoutMs: 4000 },
            );
            findHeldStyle = (await readRing(app, FIND_NEXT))?.style ?? "";
          });
          expect(
            findHeldStyle,
            "a ring that was already telling the truth has nothing to resolve",
          ).toBe("solid");

          // Belt-and-braces, not the cover: app-tests serve the PROD bundle,
          // where the engine's dev-only invariant is compiled out entirely.
          // The counting assertions above are what actually pins uniqueness;
          // this only catches a build that shipped the probe by accident.
          const collisions = await app.evalJS<number>(
            `(window.__deckTrace?.dump() || []).filter(function(e){
              return e.kind === "return-promise-collision";
            }).length`,
          );
          expect(collisions, "no two controls promised Return at once").toBe(0);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0398-chord-ring] log tail:\n${tail}\n`);
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

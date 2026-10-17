/**
 * at0372-ai-config-mixer.test.ts — the AI mixer is a transaction, and its rows
 * are coupled ([AT0372]).
 *
 * ## Why this exists
 *
 * Model, reasoning effort, and permission mode used to be three chips over
 * three confirm-style pickers. They are one chip over one mixer sheet now, and
 * the collapse is only worth having if two properties hold in the real app:
 *
 *   1. **Nothing reaches the wire until OK.** Browsing the channels must not
 *      bounce the claude process — an effort change costs a respawn. So a run
 *      of changes followed by **Cancel** must leave the chip exactly where it
 *      was, and the same run followed by **OK** must land all of it at once.
 *   2. **The channels are coupled.** Effort is per-model, so choosing a model
 *      that does not offer the pending level clamps it DOWNWARD rather than
 *      promoting the user to a bigger thinking budget than they asked for. This
 *      is the coupling that used to be discoverable only by crossing two
 *      dialogs.
 *
 * It asserts BEHAVIOR, never the shape of the controls: which widget a channel
 * happens to use, how many options it renders, and which of them paints active
 * are that widget's own business (and its own tests'). This file cares only
 * about what the session ends up configured to — read off the sheet's readout
 * and the chip's face — so a redesign of the sheet costs nothing here.
 *
 * Also pinned: the three deep-link slash commands (`/model`, `/effort`,
 * `/mode`) open the ONE sheet, and `/ai` opens it too — the muscle memory
 * survives the collapse. And ⌃⌘I is a toggle, not a re-open: pressed again
 * while the sheet is up it puts the sheet away rather than swapping it for a
 * fresh instance that replays the enter animation.
 *
 * Capabilities are injected through the `ingestSessionMetadata` surface seam
 * (the chip reads its own `SESSION_METADATA` FeedStore, unreachable by the
 * `driveSession` path); no live claude handshake is needed. The respawn itself
 * is a tugcode concern, covered at that layer.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/ai-chip.tsx
 * @covers tugdeck/src/components/tugways/cards/ai-config-sheet.tsx
 * @covers tugdeck/src/components/tugways/cards/ai-config-sheet.css
 * @covers tugdeck/src/lib/ai-config.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const CHIP = `${CARD} [data-slot="ai-chip"]`;
/** The chip's composite face. */
const CHIP_VALUE = `${CHIP} [data-slot="ai-chip-value"]`;
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;

const SHEET = '[data-slot="ai-config-sheet"]';
/** The readout — the sheet's own statement of what OK would commit. */
const READOUT = `${SHEET} [data-slot="ai-config-summary"]`;
/** The model channel is an option list; each row carries its selector. */
const MODEL_LIST = `${SHEET} [data-testid="ai-config-model"]`;
const MODEL_ROW = (value: string): string =>
  `${MODEL_LIST} [data-model="${value}"]`;
/** The effort channel is a stepped `TugSlider`. */
const EFFORT_TRACK = `${SHEET} [data-testid="ai-config-effort"]`;
const EFFORT_THUMB = `${EFFORT_TRACK} .tug-slider-thumb`;
/** The mode channel is still a segmented group. */
const MODE_ROW = `${SHEET} [data-testid="ai-config-mode"]`;
const SEGMENT = (row: string, value: string): string =>
  `${row} [data-choice-value="${value}"]`;
const OK = `${SHEET} [data-slot="ai-config-ok"]`;
const CANCEL = `${SHEET} [data-slot="ai-config-cancel"]`;

/**
 * Capabilities with two effort shapes: the account default (opus) supports all
 * five levels; sonnet supports four (no `xhigh`); haiku none. Exactly the
 * shape claude's own `initialize` reports.
 */
function capabilities() {
  return {
    type: "session_capabilities",
    models: [
      {
        value: "default",
        displayName: "Default (recommended)",
        description: "Opus 5 · Best for everyday, complex tasks",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        value: "sonnet",
        displayName: "Sonnet",
        description: "Sonnet 4.6 · Fast for most tasks",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "max"],
      },
      {
        value: "haiku",
        displayName: "Haiku",
        description: "Haiku 4.5 · Fastest",
      },
    ],
    commands: [],
    agents: [],
    available_output_styles: [],
    output_style: "default",
    account: null,
    effort: null,
    ipc_version: 2,
  };
}

/** The chip's whole composite face. */
async function chipValue(app: App): Promise<string | null> {
  return await app.body("A").evalJS<string | null>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(CHIP_VALUE)});
      return el ? el.textContent.trim() : null;
    })()`,
  );
}

/** The sheet's readout, whitespace-normalized (it is several spans). */
async function readout(app: App): Promise<string | null> {
  // The sheet is card-hosted, so it stands in the card's body.
  return await app.body("A").evalJS<string | null>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(READOUT)});
      return el ? el.textContent.replace(/\\s+/g, " ").trim() : null;
    })()`,
  );
}

const SHEET_OPEN = `document.querySelector(${JSON.stringify(SHEET)}) !== null`;
const SHEET_CLOSED = `document.querySelector(${JSON.stringify(SHEET)}) === null`;

describe.skipIf(!SHOULD_RUN)("AT0372: the AI mixer's transaction and row coupling", () => {
  test(
    "Cancel sends nothing; OK lands the whole diff; the effort track spans and clamps to the pending model",
    async () => {
      const app = await launchTugApp({ testName: "at0372-ai-config-mixer" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape({ width: 820, height: 560 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A");
        await app.awaitEngineReady("A");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP_VALUE)}) !== null`,
          { timeoutMs: 8000 },
        );

        // The account default supports all five levels and no override is set,
        // so the composite is the full triple.
        await app.ingestSessionMetadata("A", capabilities());
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(CHIP_VALUE)});
            return el !== null && el.textContent.trim() === "Opus 5 · High · Default";
          })()`,
          { timeoutMs: 6000 },
        );
        const before = await chipValue(app);

        // ---- 1. Cancel is free ------------------------------------------
        await app.body("A").click(CHIP);
        await app.body("A").waitForCondition<boolean>(SHEET_OPEN, { timeoutMs: 4000 });

        // Move two channels, then abandon the transaction.
        await app.body("A").click(MODEL_ROW("sonnet"));
        await app.body("A").click(SEGMENT(MODE_ROW, "plan"));
        expect(
          await chipValue(app),
          "the chip must not move while the sheet is open",
        ).toBe(before);

        await app.body("A").click(CANCEL);
        await app.body("A").waitForCondition<boolean>(SHEET_CLOSED, { timeoutMs: 4000 });
        expect(
          await chipValue(app),
          "Cancel commits nothing — two moved channels, zero frames",
        ).toBe(before);

        // ---- 2. The channels are coupled --------------------------------
        await app.body("A").click(CHIP);
        await app.body("A").waitForCondition<boolean>(SHEET_OPEN, { timeoutMs: 4000 });

        // Take the pending effort UP one notch, to a level sonnet does not
        // offer. The track is the sheet's second focus stop, so Tab off the
        // model list rings it and ArrowRight steps the thumb.
        await app.nativeKey("Tab");
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(EFFORT_THUMB)});
            return el !== null && el.hasAttribute("data-key-view-kbd");
          })()`,
          { timeoutMs: 4000 },
        );
        await app.nativeKey("ArrowRight");
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(READOUT)});
            return el !== null && el.textContent.indexOf("Extra-High") >= 0;
          })()`,
          { timeoutMs: 4000 },
        );

        // Pick sonnet, which does not offer Extra-High: the stranded pending
        // level clamps DOWN to the nearest level sonnet does offer rather than
        // being promoted to a bigger thinking budget than was asked for.
        await app.body("A").click(MODEL_ROW("sonnet"));
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(READOUT)});
            return el !== null && el.textContent.indexOf("Sonnet") >= 0;
          })()`,
          { timeoutMs: 4000 },
        );
        expect(
          await readout(app),
          "a stranded level clamps DOWN, never up",
        ).toBe("Sonnet 4.6 · High · Default");

        // ---- 3. OK lands the whole diff at once -------------------------
        await app.body("A").click(SEGMENT(MODE_ROW, "plan"));
        await app.body("A").click(OK);
        await app.body("A").waitForCondition<boolean>(SHEET_CLOSED, { timeoutMs: 4000 });
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(CHIP_VALUE)});
            return el !== null && el.textContent.trim() === "Sonnet 4.6 · High · Plan";
          })()`,
          { timeoutMs: 6000 },
        );

        // ---- 4. A model with no effort at all disables the channel ------
        await app.body("A").click(CHIP);
        await app.body("A").waitForCondition<boolean>(SHEET_OPEN, { timeoutMs: 4000 });
        await app.body("A").click(MODEL_ROW("haiku"));
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(EFFORT_TRACK)});
            return el !== null && el.getAttribute("aria-disabled") === "true";
          })()`,
          { timeoutMs: 4000 },
        );
        expect(
          await readout(app),
          "with no level to report the readout drops the effort token entirely",
        ).toBe("Haiku 4.5 · Plan");
        await app.body("A").click(CANCEL);
        await app.body("A").waitForCondition<boolean>(SHEET_CLOSED, { timeoutMs: 4000 });
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0372-ai-config-mixer] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "/ai and the three attribute names all open the one sheet",
    async () => {
      const app = await launchTugApp({ testName: "at0372-ai-config-deep-links" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape({ width: 820, height: 560 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A");
        await app.awaitEngineReady("A");
        await app.ingestSessionMetadata("A", capabilities());
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP_VALUE)}) !== null`,
          { timeoutMs: 8000 },
        );

        // Every one of the four names opens the SAME sheet — three rows, one
        // OK. The retired `/model` and `/effort` pickers were two more sheets;
        // typing their names now lands here.
        for (const name of ["ai", "model", "effort", "mode"]) {
          await app.body("A").nativeClickAtElement(PROMPT_INPUT);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("run-card-command", { name: ${JSON.stringify(name)} }), null)`,
          );
          await app.body("A").waitForCondition<boolean>(SHEET_OPEN, { timeoutMs: 4000 });
          const channels = await app.body("A").evalJS<number>(
            `[${JSON.stringify(MODEL_LIST)}, ${JSON.stringify(EFFORT_TRACK)}, ${JSON.stringify(MODE_ROW)}]
              .filter(function(s){ return document.querySelector(s) !== null; }).length`,
          );
          expect(channels, `/${name} opens the three-channel mixer`).toBe(3);
          await app.body("A").click(CANCEL);
          await app.body("A").waitForCondition<boolean>(SHEET_CLOSED, { timeoutMs: 4000 });
        }
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0372-ai-config-deep-links] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "⌃⌘I toggles the mixer — a second press puts it away, and it re-opens fresh",
    async () => {
      const app = await launchTugApp({ testName: "at0372-ai-config-toggle" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape({ width: 820, height: 560 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A");
        await app.awaitEngineReady("A");
        await app.ingestSessionMetadata("A", capabilities());
        await app.body("A").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(CHIP_VALUE)});
            return el !== null && el.textContent.trim() === "Opus 5 · High · Default";
          })()`,
          { timeoutMs: 8000 },
        );
        const before = await chipValue(app);

        await app.nativeKey("i", ["ctrl", "cmd"]);
        await app.body("A").waitForCondition<boolean>(SHEET_OPEN, { timeoutMs: 6000 });

        // Move a channel first: the toggle-off is a DISMISSAL, so the pending
        // change must die with the sheet exactly as Cancel would kill it.
        await app.body("A").click(SEGMENT(MODE_ROW, "plan"));

        // Same chord again — the door closes the way it opened.
        await app.nativeKey("i", ["ctrl", "cmd"]);
        await app.body("A").waitForCondition<boolean>(SHEET_CLOSED, { timeoutMs: 6000 });
        expect(
          await chipValue(app),
          "a toggle-off commits nothing, the same as Cancel",
        ).toBe(before);

        // And it re-opens, so a full cycle leaves nothing latched — and opens
        // on the session's own values, not the abandoned pending ones.
        await app.nativeKey("i", ["ctrl", "cmd"]);
        await app.body("A").waitForCondition<boolean>(SHEET_OPEN, { timeoutMs: 6000 });
        expect(
          await readout(app),
          "the re-opened sheet reads the session, not the dismissed transaction",
        ).toBe("Opus 5 · High · Default");
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0372-ai-config-toggle] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

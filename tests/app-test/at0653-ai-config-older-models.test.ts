/**
 * at0653-ai-config-older-models.test.ts — the AI mixer folds superseded model
 * versions behind a toggle ([AT0653]).
 *
 * ## Why this exists
 *
 * From Claude Code 2.1.285 the `initialize` model list carries every version
 * of a family claude still serves — Opus 5.5 beside Opus 5, 4.8, 4.7, 4.6 —
 * and twelve rows of near-identical wording made the mixer sheet overwhelming.
 * The sheet now shows the front rank (the default and the newest of each
 * family) and folds the rest behind "Show older models". Two properties have
 * to hold in the real app:
 *
 *   1. **The fold is real.** Collapsed, an older version is not in the list;
 *      the toggle brings it in and takes it back out.
 *   2. **The pick is never folded away.** Choose an older version and collapse
 *      the list: that row stays, so the checkmark is always on something the
 *      reader can see.
 *
 * Capabilities are injected through the `ingestSessionMetadata` surface seam,
 * shaped as 2.1.285 reports them; no live claude handshake is needed.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/ai-config-editor.tsx
 * @covers tugdeck/src/components/tugways/cards/ai-config-editor.css
 * @covers tugdeck/src/lib/model-picker-data.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const CHIP = `${CARD} [data-slot="ai-chip"]`;
const CHIP_VALUE = `${CHIP} [data-slot="ai-chip-value"]`;

const SHEET = '[data-slot="ai-config-sheet"]';
const READOUT = `${SHEET} [data-slot="ai-config-summary"]`;
const MODEL_LIST = `${SHEET} [data-testid="ai-config-model"]`;
const MODEL_ROW = (value: string): string =>
  `${MODEL_LIST} [data-model="${value}"]`;
const OLDER_TOGGLE = `${SHEET} [data-slot="ai-config-older-models"]`;
const CANCEL = `${SHEET} [data-slot="ai-config-cancel"]`;

const SHEET_OPEN = `document.querySelector(${JSON.stringify(SHEET)}) !== null`;
const SHEET_CLOSED = `document.querySelector(${JSON.stringify(SHEET)}) === null`;

const ALL_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** A trimmed 2.1.285 model list: a front rank plus three older versions. */
function capabilities() {
  const row = (value: string, displayName: string, description: string) => ({
    value,
    displayName,
    description,
    supportsEffort: true,
    supportedEffortLevels: ALL_LEVELS,
  });
  return {
    type: "session_capabilities",
    models: [
      row("default", "Default (recommended)", "Opus 5.5 · Best for everyday, complex tasks"),
      row("opus", "Opus 5.5", "For complex work and everyday tasks"),
      row("sonnet", "Sonnet 5.5", "Most efficient for simpler tasks"),
      { value: "haiku", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
      row("claude-sonnet-5", "Sonnet 5", "Efficient for routine tasks"),
      row("claude-opus-5", "Opus 5", "Best for everyday, complex tasks"),
      row("claude-opus-4-8", "Opus 4.8", "Best for everyday, complex tasks"),
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

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 820, height: 560 },
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

/** The selectors of the model rows the list currently renders, in order. */
async function shownRows(app: App): Promise<string[]> {
  return await app.evalJS<string[]>(
    `Array.prototype.map.call(
      document.querySelectorAll(${JSON.stringify(`${MODEL_LIST} [data-model]`)}),
      function(el){ return el.getAttribute("data-model"); })`,
  );
}

async function toggleText(app: App): Promise<string | null> {
  return await app.evalJS<string | null>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(OLDER_TOGGLE)});
      return el ? el.textContent.trim() : null;
    })()`,
  );
}

const rowPresent = (value: string): string =>
  `document.querySelector(${JSON.stringify(MODEL_ROW(value))}) !== null`;
const rowAbsent = (value: string): string =>
  `document.querySelector(${JSON.stringify(MODEL_ROW(value))}) === null`;

describe.skipIf(!SHOULD_RUN)("AT0653: the AI mixer folds older model versions", () => {
  test(
    "older versions fold behind a toggle, and the pick is never folded away",
    async () => {
      const app = await launchTugApp({ testName: "at0653-ai-config-older-models" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A");
        await app.awaitEngineReady("A");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP_VALUE)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.ingestSessionMetadata("A", capabilities());
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(CHIP_VALUE)});
            return el !== null && el.textContent.indexOf("Opus 5.5") === 0;
          })()`,
          { timeoutMs: 6000 },
        );

        await app.click(CHIP);
        await app.waitForCondition<boolean>(SHEET_OPEN, { timeoutMs: 4000 });

        // ---- 1. Collapsed: the front rank only ---------------------------
        expect(await shownRows(app), "collapsed, the list is the front rank").toEqual([
          "default",
          "opus",
          "sonnet",
          "haiku",
        ]);
        expect(await toggleText(app)).toBe("Show older models");

        // ---- 2. The toggle brings the older versions in -----------------
        await app.click(OLDER_TOGGLE);
        await app.waitForCondition<boolean>(rowPresent("claude-opus-5"), { timeoutMs: 4000 });
        expect(await shownRows(app), "expanded, every row in catalog order").toEqual([
          "default",
          "opus",
          "sonnet",
          "haiku",
          "claude-sonnet-5",
          "claude-opus-5",
          "claude-opus-4-8",
        ]);
        expect(await toggleText(app)).toBe("Hide older models");

        // ---- 3. An older pick survives the collapse ---------------------
        await app.click(MODEL_ROW("claude-opus-5"));
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(READOUT)});
            return el !== null && el.textContent.indexOf("Opus 5 ") === 0;
          })()`,
          { timeoutMs: 4000 },
        );
        await app.click(OLDER_TOGGLE);
        await app.waitForCondition<boolean>(rowAbsent("claude-opus-4-8"), { timeoutMs: 4000 });
        expect(
          await shownRows(app),
          "collapsed, the picked older version keeps its row",
        ).toEqual(["default", "opus", "sonnet", "haiku", "claude-opus-5"]);

        await app.click(CANCEL);
        await app.waitForCondition<boolean>(SHEET_CLOSED, { timeoutMs: 4000 });
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0653-ai-config-older-models] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

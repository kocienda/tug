/**
 * at0226-usage-sheet.test.ts — `/usage` opens the subscription-limits +
 * contribution + session-cost sheet, at parity with the terminal `/usage`.
 *
 * The panel is sourced by shelling `claude -p "/usage"` in tugcast (the same
 * way tugtool already shells `claude auth status`); the text is parsed into
 * gauges (the session window is the `TugArcGauge` hero, weekly windows are
 * `TugLinearGauge`s), the "What's contributing" periods (Last 24h / Last 7d)
 * with their top skills/subagents/plugins tables, and a Session cost grid folded
 * from this card's transcript.
 *
 * Here we drive the app-level `UsageStore` directly (`ingestUsage`) with a
 * verbatim sample of `claude -p "/usage"` output, so the text→graphical mapping
 * is deterministic without a live `claude` invocation.
 *
 * Has teeth: before the parser + sheet render the windows there'd be no arc/
 * linear gauges; before the contributing parse there'd be no skills table.
 *
 * @covers tugdeck/src/lib/usage-store.ts
 * @covers tugdeck/src/lib/usage-parse.ts
 * @covers tugdeck/src/lib/usage-context.tsx
 * @covers tugrust/crates/tugcast/src/feeds/claude_usage.rs
 * @covers tugdeck/src/components/tugways/cards/usage-sheet.tsx
 * @covers tugdeck/src/components/tugways/tug-arc-gauge.css
 * @covers tugdeck/src/components/tugways/tug-arc-gauge.tsx
 * @covers tugdeck/src/components/tugways/tug-linear-gauge.css
 * @covers tugdeck/src/components/tugways/tug-linear-gauge.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0226-session";

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SUBMIT_BTN = `${CARD} .tug-prompt-entry-submit-button`;
const SHEET = '[data-slot="tug-sheet"]';
const SHEET_TITLE = `${SHEET} .tug-sheet-title`;
const ARC_GAUGE = `${SHEET} [data-slot="tug-arc-gauge"]`;
const WINDOW_GAUGE = `${SHEET} .usage-sheet-window [data-slot="tug-linear-gauge"]`;
const CHAR_GAUGE = `${SHEET} .usage-sheet-char-gauge`;
const WINDOW_LABEL = `${SHEET} .usage-sheet-window-label`;
const TABLE_NAME = `${SHEET} .usage-sheet-table-name`;
const PERIOD_LABEL = `${SHEET} .usage-sheet-period-label`;
const STAT_VALUE = `${SHEET} .usage-sheet-stat-value`;
const DONE_BTN = `${SHEET} [data-testid="usage-done"]`;

const USAGE_TEXT = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 69% used · resets Jul 13 at 11:20am (America/Los_Angeles)",
  "Current week (all models): 8% used · resets Jul 20 at 3am (America/Los_Angeles)",
  "Current week (Fable): 9% used · resets Jul 20 at 3am (America/Los_Angeles)",
  "",
  "What's contributing to your limits usage?",
  "Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.",
  "",
  "Last 24h · 1922 requests · 23 sessions",
  "  91% of your usage was at >150k context",
  "  27% of your usage came from subagent-heavy sessions",
  "  Top skills: /tugplug:implement 41%, /tugplug:devise 2%, /tugplug:commit 1%",
  "  Top subagents: Explore 2%, general-purpose 1%",
  "  Top plugins: tugplug 45%",
  "",
  "Last 7d · 14784 requests · 211 sessions",
  "  86% of your usage was at >150k context",
  "  58% of your usage came from subagent-heavy sessions",
  "  Top skills: /tugplug:implement 27%, /tugplug:commit 2%",
  "  Top subagents: Explore 2%, general-purpose 1%",
  "  Top plugins: tugplug 32%",
].join("\n");

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 675, height: 680 },
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

async function runUsage(app: App): Promise<void> {
  await app.nativeClickAtElement(PROMPT_INPUT);
  await app.nativeType("/usage");
  await app.nativeClickAtElement(SUBMIT_BTN);
}

describe.skipIf(!SHOULD_RUN)("AT0226: /usage sheet", () => {
  test(
    "/usage renders gauges, contributing tables, and the session grid from the panel text",
    async () => {
      const app = await launchTugApp({ testName: "at0226-usage-sheet" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");

        // Seed the account-global usage store as if `claude -p "/usage"` replied.
        await app.evalJS<null>(
          `(window.__tug.ingestUsage(${JSON.stringify({ request_id: "usage-seed", ok: true, text: USAGE_TEXT })}), null)`,
        );

        await runUsage(app);
        await app.waitForCondition<boolean>(
          `(function(){ var e = document.querySelector(${JSON.stringify(SHEET_TITLE)}); return e !== null && e.textContent === "Usage"; })()`,
          { timeoutMs: 6000 },
        );

        // Session window → arc hero; the two weekly windows → linear gauges;
        // each period's two characteristics → linear gauges (2 periods → 4).
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(ARC_GAUGE)}).length === 1`,
          { timeoutMs: 6000 },
        );
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(WINDOW_GAUGE)}).length`,
          ),
        ).toBe(2);
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(CHAR_GAUGE)}).length`,
          ),
        ).toBe(4);

        const sheetText = await app.evalJS<string>(
          `(function(){ var e = document.querySelector(${JSON.stringify(SHEET)}); return e ? (e.textContent || "") : ""; })()`,
        );
        expect(sheetText).toContain("69%"); // session hero
        expect(sheetText).toContain("Current session");
        expect(sheetText).toContain(">150k context");

        const windowLabels = await app.evalJS<string[]>(
          `Array.from(document.querySelectorAll(${JSON.stringify(WINDOW_LABEL)})).map(function(e){ return e.textContent; })`,
        );
        expect(windowLabels).toContain("Current week (all models)");
        expect(windowLabels).toContain("Current week (Fable)");

        // Both contribution periods render.
        const periodLabels = await app.evalJS<string[]>(
          `Array.from(document.querySelectorAll(${JSON.stringify(PERIOD_LABEL)})).map(function(e){ return e.textContent; })`,
        );
        expect(periodLabels).toContain("Last 24h");
        expect(periodLabels).toContain("Last 7d");

        // The top-skills table parsed its entries.
        const tableNames = await app.evalJS<string[]>(
          `Array.from(document.querySelectorAll(${JSON.stringify(TABLE_NAME)})).map(function(e){ return e.textContent; })`,
        );
        expect(tableNames).toContain("/tugplug:implement");
        expect(tableNames).toContain("general-purpose");
        expect(tableNames).toContain("tugplug");

        // Session cost grid renders (fresh session — real zero totals).
        const statValues = await app.evalJS<string[]>(
          `Array.from(document.querySelectorAll(${JSON.stringify(STAT_VALUE)})).map(function(e){ return e.textContent; })`,
        );
        expect(statValues).toContain("$0.00");
        expect(statValues.length).toBe(8);

        // The panel is a sheet, not a wall: it keeps a real gutter on both
        // sides of the card rather than running out to the pane's edges.
        const gutters = await app.evalJS<{ left: number; right: number }>(
          `(function(){
            var c = document.querySelector(${JSON.stringify(SHEET)}).getBoundingClientRect();
            var k = document.querySelector(${JSON.stringify(SHEET)}).closest(".tug-sheet-clip").getBoundingClientRect();
            return { left: c.left - k.left, right: k.right - c.right };
          })()`,
        );
        expect(gutters.left).toBeGreaterThan(40);
        expect(gutters.right).toBeGreaterThan(40);

        await app.nativeClickAtElement(DONE_BTN);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) === null`,
          { timeoutMs: 6000 },
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "⌃⌘U toggles the panel — a second press puts it away",
    async () => {
      const app = await launchTugApp({ testName: "at0226-usage-toggle" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");
        await app.evalJS<null>(
          `(window.__tug.ingestUsage(${JSON.stringify({ request_id: "usage-seed", ok: true, text: USAGE_TEXT })}), null)`,
        );

        await app.nativeKey("u", ["ctrl", "cmd"]);
        await app.waitForCondition<boolean>(
          `(function(){ var e = document.querySelector(${JSON.stringify(SHEET_TITLE)}); return e !== null && e.textContent === "Usage"; })()`,
          { timeoutMs: 6000 },
        );

        // Same chord again — the door closes the way it opened.
        await app.nativeKey("u", ["ctrl", "cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) === null`,
          { timeoutMs: 6000 },
        );

        // And it re-opens, so a full cycle leaves nothing latched.
        await app.nativeKey("u", ["ctrl", "cmd"]);
        await app.waitForCondition<boolean>(
          `(function(){ var e = document.querySelector(${JSON.stringify(SHEET_TITLE)}); return e !== null && e.textContent === "Usage"; })()`,
          { timeoutMs: 6000 },
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

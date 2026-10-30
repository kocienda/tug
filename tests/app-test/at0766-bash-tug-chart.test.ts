/**
 * at0766-bash-tug-chart.test.ts — a `TUG-CHART:` line in a Bash call's
 * stdout leaves the terminal text and renders as a chart beneath the body,
 * and transcript Find counts the chart's labels.
 *
 * The drive: a Bash `tool_use` and its result, as `at0707` does, with stdout
 * carrying a line of prose and one `TUG-CHART:` line. The block mounts
 * collapsed, and the chart stands beneath it anyway: a chart is the answer
 * the command was run for, and folding it away hides the answer. Then:
 *
 *  - exactly one chart reaches `rendered` with the block still collapsed,
 *  - a Find query on one of the chart's category labels — a word nowhere
 *    else in the transcript — counts one match while collapsed, so the index
 *    projects the chart's table the way the painter walks it,
 *  - expanding the block keeps the one chart beneath the body, and the
 *    terminal's text holds the prose and not the chart line.
 *
 * @covers tugdeck/src/components/tugways/cards/blocks/bash-tool-block.tsx
 * @covers tugdeck/src/lib/chart/chart-lines.ts
 * @covers tugdeck/src/lib/chart/chart-find-text.ts
 * @covers tugdeck/src/components/tugways/body-kinds/chart-block.tsx
 * @covers tugdeck/src/components/tugways/cards/transcript-search-index.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import { openFindBar, sessionSelectors } from "./find-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const FEED_CODE_OUTPUT = 0x40;

const SID = "at0766-A";
const USE_ID = `${SID}-tc1`;
const SEL = sessionSelectors("A");
const BLOCK = `[data-slot="bash-tool-block"][data-tool-use-id="${USE_ID}"]`;
const TERMINAL = `${BLOCK} [data-slot="terminal-content"]`;
const CHART = `${BLOCK} [data-slot="bash-tool-block-charts"] .tugx-chart`;

/** A category found nowhere else in the transcript. */
const LABEL = "quokka";

const SPEC = {
  tugchart: 1,
  form: "bar",
  title: "Runs per animal",
  categories: ["wombat", LABEL, "numbat"],
  series: [{ name: "runs", values: [3, 5, 2] }],
};
const PROSE = "measured the week";
const STDOUT = `${PROSE}\nTUG-CHART: ${JSON.stringify(SPEC)}\n`;

function frame(app: App, decoded: Record<string, unknown>): Promise<unknown> {
  return app.driveSession("A", {
    op: "ingestFrame",
    feedId: FEED_CODE_OUTPUT,
    decoded: { tug_session_id: SID, ...decoded },
  });
}

describe.skipIf(!SHOULD_RUN)("AT0766: a TUG-CHART line renders beneath the Bash block", () => {
  test(
    "the line leaves the terminal, one chart stands beneath it, and Find counts its label",
    async () => {
      const app = await launchTugApp({ testName: "at0766-bash-tug-chart" });
      try {
        await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 700 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        const card = app.body("A");

        await app.driveSession("A", { op: "send", text: "chart the week" });
        await frame(app, { type: "prompt_anchor", promptUuid: `${SID}-u1` });
        await frame(app, {
          type: "tool_use",
          msg_id: `${SID}-m1`,
          tool_use_id: USE_ID,
          tool_name: "Bash",
          input: { command: "tugtool log --chart" },
          seq: 1,
        });
        await frame(app, {
          type: "tool_result",
          tool_use_id: USE_ID,
          is_error: false,
          output: STDOUT,
        });
        await frame(app, { type: "turn_complete", seq: 0, msg_id: `${SID}-m1`, result: "success" });

        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(BLOCK)})`, {
          timeoutMs: 15_000,
        });
        // The block mounts collapsed, and the chart is there without an expand.
        expect(
          await card.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(BLOCK)}).getAttribute("data-block-collapsed") === "true"`,
          ),
          "the block is collapsed",
        ).toBe(true);
        await card.waitForCondition<boolean>(
          `(function(){ var charts = document.querySelectorAll(${JSON.stringify(CHART)}); return charts.length === 1 && charts[0].getAttribute("data-tugx-chart-state") === "rendered"; })()`,
          { timeoutMs: 20_000 },
        );

        const facts = await card.evalJS<{ charts: number; findable: boolean; svg: boolean; height: number }>(
          `(function(){
            var charts = document.querySelectorAll(${JSON.stringify(CHART)});
            return {
              charts: charts.length,
              findable: charts.length === 1 && charts[0].hasAttribute("data-tugx-findable"),
              svg: charts.length === 1 && charts[0].querySelector("svg.tugx-chart-svg") !== null,
              height: charts.length === 1 ? charts[0].getBoundingClientRect().height : 0,
            };
          })()`,
        );
        note(`at0766 collapsed chart height: ${facts.height}`);
        expect(facts.charts, "one chart beneath the collapsed header").toBe(1);
        expect(facts.findable, "the chart is a Find unit").toBe(true);
        expect(facts.svg, "the chart drew").toBe(true);
        expect(facts.height, "the chart takes its box on screen").toBeGreaterThan(100);

        // Find, still collapsed: the label is in the chart's table and nowhere else.
        await openFindBar(app);
        await app.nativeType(LABEL);
        await card.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(SEL.chip)})?.textContent || "").trim() === "1 of 1"`,
          { timeoutMs: 15_000 },
        );
        const chip = await card.evalJS<string>(
          `(document.querySelector(${JSON.stringify(SEL.chip)})?.textContent || "").trim()`,
        );
        note(`at0766 find chip for ${JSON.stringify(LABEL)}: ${JSON.stringify(chip)}`);
        expect(chip).toBe("1 of 1");

        // Expanded: the body opens above the chart, which stays.
        await card.click(`${BLOCK} [data-slot="tool-call-header-disclosure"]`);
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(TERMINAL)})`, {
          timeoutMs: 15_000,
        });
        const expanded = await card.evalJS<{ terminal: string; charts: number; chartBelowBody: boolean }>(
          `(function(){
            var term = document.querySelector(${JSON.stringify(TERMINAL)});
            var charts = document.querySelectorAll(${JSON.stringify(CHART)});
            return {
              terminal: term.textContent || "",
              charts: charts.length,
              chartBelowBody: charts.length === 1 && charts[0].getBoundingClientRect().top >= term.getBoundingClientRect().bottom,
            };
          })()`,
        );
        note(`at0766 terminal text: ${JSON.stringify(expanded.terminal)}`);
        expect(expanded.terminal, "the prose stays").toContain(PROSE);
        expect(expanded.terminal, "the chart line leaves the terminal").not.toContain("TUG-CHART");
        expect(expanded.charts, "one chart, the same one").toBe(1);
        expect(expanded.chartBelowBody, "the chart stands beneath the body").toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

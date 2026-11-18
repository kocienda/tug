/**
 * at0854-share-tool-block-figures.test.ts — a shared turn whose tool blocks
 * draw late is photographed after they have drawn.
 *
 * Two tool blocks finish their body after the commit that mounts them, each
 * behind an engine that loads lazily: a Bash block whose output carried a
 * `TUG-CHART:` line mounts a `ChartBlock`, and an Edit block with no
 * structured patch computes its diff from the two texts. A live card has
 * both engines warm, so neither wait shows there. The share page is a fresh
 * page on every render, so it has to wait for both, or the picture holds
 * "Drawing chart…" and "Computing diff…" where the figure and the diff
 * belong. This holds, on a PDF render with tool calls in full and an image:
 *
 *  - The render answers `ok`.
 *  - The page's HTML carries the chart's title and no "Drawing chart…", and
 *    the spec's source is not what was drawn.
 *  - The same turns as an image show the chart's bars at their full height.
 *    A figure that played its entrance on the share page is photographed at
 *    whichever frame the snapshot met, with almost no bar.
 *  - The page's HTML carries the diff's new text and no "Computing diff…".
 *
 * @covers tugdeck/src/lib/chart/render-chart.ts
 * @covers tugdeck/src/components/tugways/body-kinds/chart-block.tsx
 * @covers tugdeck/src/components/tugways/body-kinds/diff-block.tsx
 * @covers tugdeck/src/lib/markdown/pending-enhancements.ts
 * @covers tugdeck/src/share/share-main.ts
 */

import { describe, expect, test } from "bun:test";
import { copyFileSync, rmSync } from "node:fs";

import { launchTugApp, note } from "./_harness";
import { decodePngFile } from "./_harness/png";
import { openSeededCard, type SeedTurn } from "./share-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0854-session";

const CHART_TITLE = "Commits fell after the at0854 freeze";
const SPEC = {
  tugchart: 1,
  form: "bar",
  title: CHART_TITLE,
  unit: "commits",
  format: "int",
  categories: ["Mon", "Tue", "Wed"],
  // Three bars at the axis's top, so a still chart is mostly bar.
  series: [{ name: "commits", values: [8, 8, 8] }],
};

/**
 * The name the edit's new text introduces, found nowhere else on the page.
 * The diff is syntax-coloured, so a whole line is split across spans and
 * only a single token reads as one string in the HTML.
 */
const AFTER_NAME = "at0854After";
const EDIT_AFTER = `const ${AFTER_NAME} = 2;`;

const TURNS: SeedTurn[] = [
  {
    prompt: "chart the commits",
    reply: "Here is the chart.",
    tool: {
      name: "Bash",
      input: { command: "tugtool chart commits", description: "Draw the commits chart" },
      output: `3 commit days\nTUG-CHART: ${JSON.stringify(SPEC)}\n`,
    },
  },
  {
    prompt: "bump the constant",
    reply: "Bumped.",
    tool: {
      name: "Edit",
      input: { file_path: "/tmp/at0854/config.ts", old_string: "const at0854Before = 1;", new_string: EDIT_AFTER },
      output: "The file /tmp/at0854/config.ts has been updated.",
    },
  },
];

/** Two channels within this of each other read as one colour. */
const NEAR = 12;
/**
 * The least share of the image's pixels the three full bars cover. Read
 * 2026-11-17: 0.094 with the bars still, 0.032 caught part-way up an entrance.
 */
const MIN_BAR_SHARE = 0.08;

interface Rendered {
  result: "ok" | "failed";
  path: string;
  height: number;
  pages: number;
  html: string;
}

describe.skipIf(!SHOULD_RUN)("AT0854: shared tool blocks are photographed after they draw", () => {
  test(
    "a Bash block's chart and an Edit block's two-text diff have drawn when the share page is read",
    async () => {
      const app = await launchTugApp({ testName: "at0854-share-tool-block-figures" });
      let projectDir = "";
      try {
        projectDir = await openSeededCard(app, SID, TURNS);
        const card = app.body("A");
        // `evalJS` cannot return a promise: start the render, park its answer, poll.
        await card.evalJS<null>(
          `(window.__at0854 = undefined,
            window.__tug.shareRender("A", "pdf", "full").then(function (r) {
              window.__at0854 = JSON.stringify(r);
            }),
            null)`,
        );
        await card.waitForCondition<boolean>("window.__at0854 !== undefined", { timeoutMs: 15_000 });
        const pdf = JSON.parse(await card.evalJS<string>("window.__at0854")) as Rendered;
        note(`at0854 pdf: ${JSON.stringify({ ...pdf, html: pdf.html.length })}`);

        expect(pdf.result, "the render answers ok").toBe("ok");
        expect(pdf.html, "the chart is not still pending").not.toContain("Drawing chart");
        expect(pdf.html, "the chart's title is on the page").toContain(CHART_TITLE);
        expect(pdf.html, "and the spec's source is not what was drawn").not.toContain('"tugchart"');
        expect(pdf.html, "the diff is not still pending").not.toContain("Computing diff");
        expect(pdf.html, "the diff's new text is on the page").toContain(AFTER_NAME);
        rmSync(pdf.path, { force: true });

        // The picture itself, as an image with tool calls as summaries: the
        // bars stand at their full height. A chart that played its entrance
        // on the share page is photographed part-way up, with almost no bar.
        const series = await card.evalJS<number[]>(`(function () {
          var probe = document.createElement("div");
          probe.style.backgroundColor = "var(--tug7-element-chart-fill-normal-series1-rest)";
          document.body.appendChild(probe);
          var bg = getComputedStyle(probe).backgroundColor;
          probe.remove();
          var c = document.createElement("canvas").getContext("2d");
          c.fillStyle = bg; c.fillRect(0, 0, 1, 1);
          var d = c.getImageData(0, 0, 1, 1).data;
          return [d[0], d[1], d[2]];
        })()`);
        await card.evalJS<null>(
          `(window.__at0854 = undefined,
            window.__tug.shareRender("A", "png", "summaries").then(function (r) {
              window.__at0854 = JSON.stringify(r);
            }),
            null)`,
        );
        await card.waitForCondition<boolean>("window.__at0854 !== undefined", { timeoutMs: 15_000 });
        const image = JSON.parse(await card.evalJS<string>("window.__at0854")) as Rendered;
        expect(image.result, "the image render answers ok").toBe("ok");
        const png = decodePngFile(image.path);
        let bar = 0;
        for (let i = 0; i < png.rgba.length; i += 4) {
          if (
            Math.abs(png.rgba[i]! - series[0]!) <= NEAR &&
            Math.abs(png.rgba[i + 1]! - series[1]!) <= NEAR &&
            Math.abs(png.rgba[i + 2]! - series[2]!) <= NEAR
          ) {
            bar += 1;
          }
        }
        const share = bar / (png.width * png.height);
        note(`at0854 image: ${png.width}x${png.height}, series ${JSON.stringify(series)}, bar share ${share.toFixed(4)}`);
        expect(share, "the bars are drawn at their full height").toBeGreaterThan(MIN_BAR_SHARE);
        if (process.env.AT0854_KEEP !== undefined) copyFileSync(image.path, process.env.AT0854_KEEP);
        rmSync(image.path, { force: true });
      } catch (err) {
        const lines = app
          .tugappLog()
          .split("\n")
          .filter((line) => /share|pageFault|fault/i.test(line));
        note(`at0854 tugapp.log share lines:\n${lines.slice(-40).join("\n")}`);
        throw err;
      } finally {
        await app.close();
        if (projectDir !== "") rmSync(projectDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

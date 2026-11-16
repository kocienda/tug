/**
 * at0844-chart-refs-light.test.ts — a prose mention and a chart mark naming
 * one file light together.
 *
 * One streamed assistant turn: a line of prose naming a file written to a
 * temp directory, in backticks, and a ` ```tugchart ` fence whose first row
 * carries a `file:` ref to the same file. Both resolve through the one
 * resolver, so both are stamped as the file. Then, inside that one message:
 *
 *  - a pointer over the prose run sets `data-tugx-ref-lit` on the row's
 *    mark (its `.tgh` hit path) and reveals the row's label rule;
 *  - a pointer over the mark sets it on the prose run, which takes the
 *    link's hover colour without the pointer;
 *  - leaving either clears every light.
 *
 * The second row names a file never written; it has no annotation and never
 * lights, which pins that the light keys on the resolver's verdict and not
 * on the text.
 *
 * @covers tugdeck/src/lib/chart/chart-ref-light.ts
 * @covers tugdeck/src/lib/annotator/entity-key.ts
 * @covers tugdeck/src/components/tugways/body-kinds/chart-block.css
 * @covers tugdeck/styles/tug-annotation.css
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { SHOULD_RUN } from "./settle-frames-fixture";
import { CARD, CHART, launchWithCharts } from "./tugchart-fixture";

const TEST_NAME = "at0844-chart-refs-light";

/** This repository, the card's binding; the file itself is under a temp dir. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** How long the refs and the prose may take to resolve: `fs/stat` round trips. */
const RESOLVE_MS = 20_000;

const REAL = "kookaburra.rs";
const MISSING = "never-written.rs";

/** The prose run: the file annotation in the card that is not a chart mark or a table atom. */
const PROSE = `[data-card-id="${CARD}"] .tugx-annotation[data-tug-annotation="file-path"]:not(.tgh):not(.tugx-chart-ref)`;
const MARK = `${CHART} .tgh[data-row="0"]`;
const OTHER_MARK = `${CHART} .tgh[data-row="1"]`;
const RULE = `${CHART} .tgl[data-row="0"]`;

let dir = "";
let realPath = "";
let missingPath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "at0844-")));
  realPath = join(dir, REAL);
  missingPath = join(dir, MISSING);
  writeFileSync(realPath, "fn kookaburra() {}\n", "utf8");
});
afterAll(() => {
  if (dir !== "" && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function spec(): unknown {
  return {
    tugchart: 1,
    form: "bar",
    title: "Lines changed by file",
    categories: [REAL, MISSING],
    series: [{ name: "lines", values: [12, 4] }],
    refs: [`file:${realPath}`, `file:${missingPath}`],
  };
}

/** The message: prose naming the real file in backticks, then the fence. */
function message(chart: unknown): string {
  return [
    `Most of the churn is in \`${realPath}\`, and the rest is noise.`,
    "",
    "```tugchart",
    JSON.stringify(chart, null, 2),
    "```",
    "",
  ].join("\n");
}

interface LightFacts {
  prose: { found: boolean; lit: boolean; color: string };
  mark: { annotation: string; lit: boolean };
  other: { annotation: string; lit: boolean };
  rule: { lit: boolean; visibility: string };
  litCount: number;
}

const FACTS_JS = `(function(){
  var prose = document.querySelector(${JSON.stringify(PROSE)});
  var mark = document.querySelector(${JSON.stringify(MARK)});
  var other = document.querySelector(${JSON.stringify(OTHER_MARK)});
  var rule = document.querySelector(${JSON.stringify(RULE)});
  var cell = mark === null ? null : mark.closest(".tug-list-view-cell");
  return {
    prose: {
      found: prose !== null,
      lit: prose !== null && prose.hasAttribute("data-tugx-ref-lit"),
      color: prose === null ? "" : getComputedStyle(prose).color
    },
    mark: {
      annotation: mark === null ? "(no hit)" : (mark.getAttribute("data-tug-annotation") || ""),
      lit: mark !== null && mark.hasAttribute("data-tugx-ref-lit")
    },
    other: {
      annotation: other === null ? "(no hit)" : (other.getAttribute("data-tug-annotation") || ""),
      lit: other !== null && other.hasAttribute("data-tugx-ref-lit")
    },
    rule: {
      lit: rule !== null && rule.hasAttribute("data-tugx-ref-lit"),
      visibility: rule === null ? "(no rule)" : getComputedStyle(rule).visibility
    },
    litCount: cell === null ? -1 : cell.querySelectorAll("[data-tugx-ref-lit]").length
  };
})()`;

const SETTLED_JS = `(function(){
  var f = ${FACTS_JS};
  return f.prose.found && f.mark.annotation === "file-path";
})()`;

/** Move the pointer onto `selector`, from outside it. */
function enter(selector: string): string {
  return `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    var rect = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerover", {
      bubbles: true, relatedTarget: document.body,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    }));
  })()`;
}

/** Move the pointer off `selector`, to the page body. */
function leave(selector: string): string {
  return `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    el.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
  })()`;
}

describe.skipIf(!SHOULD_RUN)("at0844 — a prose mention and a chart mark naming one file light together", () => {
  test(
    "hovering either lights the other, and leaving clears both",
    async () => {
      const { app, tugbankPath } = await launchWithCharts(TEST_NAME, [spec()], "tugchart", REPO_ROOT, message);
      const page = app.body(CARD);
      try {
        await page.waitForCondition<boolean>(SETTLED_JS, { timeoutMs: RESOLVE_MS });
        const rest = await page.evalJS<LightFacts>(FACTS_JS);
        note(`at0844 at rest: ${JSON.stringify(rest)}`);
        expect(rest.litCount, "nothing is lit at rest").toBe(0);
        expect(rest.other.annotation, "the missing file's mark is never a reference").toBe("");

        // The prose run lights the mark and its row's rule.
        await page.evalJS(enter(PROSE));
        await page.waitForCondition<boolean>(`${FACTS_JS}.mark.lit`, { timeoutMs: 4_000 });
        const fromProse = await page.evalJS<LightFacts>(FACTS_JS);
        note(`at0844 over the prose: ${JSON.stringify(fromProse)}`);
        expect(fromProse.mark.lit, "the mark is lit").toBe(true);
        expect(fromProse.rule.lit, "its row's rule is lit").toBe(true);
        expect(fromProse.rule.visibility, "and shown").toBe("visible");
        expect(fromProse.other.lit, "the other row is untouched").toBe(false);

        await page.evalJS(leave(PROSE));
        await page.waitForCondition<boolean>(`${FACTS_JS}.litCount === 0`, { timeoutMs: 4_000 });

        // The mark lights the prose run, which takes the hover colour.
        await page.evalJS(enter(MARK));
        await page.waitForCondition<boolean>(`${FACTS_JS}.prose.lit`, { timeoutMs: 4_000 });
        const fromMark = await page.evalJS<LightFacts>(FACTS_JS);
        note(`at0844 over the mark: ${JSON.stringify(fromMark)}`);
        expect(fromMark.prose.lit, "the prose run is lit").toBe(true);
        expect(fromMark.prose.color, "and wears the hover colour").not.toBe(rest.prose.color);
        expect(fromMark.other.lit, "the other row is untouched").toBe(false);

        await page.evalJS(leave(MARK));
        await page.waitForCondition<boolean>(`${FACTS_JS}.litCount === 0`, { timeoutMs: 4_000 });
        const cleared = await page.evalJS<LightFacts>(FACTS_JS);
        expect(cleared.prose.color, "the prose run is back at rest").toBe(rest.prose.color);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    300_000,
  );
});

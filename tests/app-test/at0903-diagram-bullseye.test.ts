/**
 * at0903-diagram-bullseye.test.ts — a diagram's target shows it alone over
 * the deck, at full size and never scrolled sideways.
 *
 * A diagram wider than its card shrinks to a floor and then scrolls sideways
 * in the card. The target at the right end of its header bullseyes it: the
 * shell is asked, and the overlay page above every card draws the figure
 * again from its spec, at its natural width, with its keyed table. This holds:
 *
 *  - The diagram's header carries the target, last in its cluster.
 *  - Pressed, the overlay shows the figure `rendered` as a presented diagram,
 *    in a dialog, with the same keyed rows the card's table has.
 *  - The bullseyed figure never scrolls sideways, and it is drawn at its
 *    natural width unless the window is narrower, and only then scaled down.
 *  - Escape takes it down, and the overlay gives the window back.
 *  - Raised again, the pressed target in its own header takes it down too.
 *
 * @covers tugdeck/src/lib/figure-bullseye-store.ts
 * @covers tugdeck/src/components/chrome/figure-bullseye-overlay.tsx
 * @covers tugdeck/src/components/chrome/figure-bullseye-overlay.css
 * @covers tugdeck/src/lib/chart/render-chart.ts
 * @covers tugdeck/src/lib/overlay-shell.ts
 * @covers tugdeck/src/overlay/overlay-main.ts
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { overlayReady } from "./overlay-fixture";
import { SHOULD_RUN } from "./settle-frames-fixture";
import { CARD, CHART, launchWithCharts, waitForCharts } from "./tugchart-fixture";

const TEST_NAME = "at0903-diagram-bullseye";

const TITLE = "Five columns lay out wider than a card holds them";

/** Five columns of ordinary boxes: wider than the card, which then shrinks and scrolls it. */
const WIDE_SPEC = {
  tugdiagram: 1,
  form: "flow",
  title: TITLE,
  columns: [
    [{ id: "a", name: "The first column", sub: "where the request starts" }],
    [{ id: "b", name: "The second column", rows: [{ key: 1, name: "keyed row", what: "The first keyed part." }] }],
    [{ id: "c", name: "The third column", sub: "in the middle of it all" }],
    [{ id: "d", name: "The fourth column", rows: [{ key: 2, name: "another row", what: "The second keyed part." }] }],
    [{ id: "e", name: "The fifth column", sub: "where it ends" }],
  ],
  edges: [
    { from: "a", to: "b" },
    { from: "b.1", to: "c" },
    { from: "c", to: "d" },
    { from: "d.1", to: "e", tone: "good", label: "done" },
  ],
};

const TARGET = `${CHART} .tugx-md-chrome-actions > .tugx-chart-bullseye`;
const PRESENTED = `.tugx-chart[data-tugx-chart-presented]`;
const PRESENTED_TARGET = `${PRESENTED} .tugx-chart-bullseye`;

interface PresentedFacts {
  state: string;
  kind: string;
  dialog: boolean;
  pressed: string;
  naturalWidth: number;
  drawnWidth: number;
  bodyClient: number;
  bodyScroll: number;
  panelClient: number;
  panelScroll: number;
  windowWidth: number;
  rows: string[];
}

const READ_PRESENTED = `(function(){
  var fig = document.querySelector(${JSON.stringify(PRESENTED)});
  var body = fig.querySelector(".tugx-chart-body");
  var svg = body.querySelector("svg.tugx-chart-svg");
  var panel = fig.closest(".tug-figure-bullseye-panel");
  var target = fig.querySelector(".tugx-chart-bullseye");
  var table = fig.querySelector("table.tugx-diagram-table");
  return {
    state: fig.getAttribute("data-tugx-chart-state") || "",
    kind: fig.getAttribute("data-tugx-chart-kind") || "",
    dialog: panel !== null && panel.getAttribute("role") === "dialog",
    pressed: target === null ? "" : (target.getAttribute("aria-pressed") || ""),
    naturalWidth: Number(svg.getAttribute("width")),
    drawnWidth: svg.getBoundingClientRect().width,
    bodyClient: body.clientWidth,
    bodyScroll: body.scrollWidth,
    panelClient: panel === null ? 0 : panel.clientWidth,
    panelScroll: panel === null ? 0 : panel.scrollWidth,
    windowWidth: window.innerWidth,
    rows: table === null ? [] : Array.from(table.querySelectorAll("tbody tr")).map(function (tr) {
      return Array.from(tr.querySelectorAll("td")).slice(0, 2).map(function (td) { return (td.textContent || "").trim(); }).join(" ");
    })
  };
})()`;

const PRESENTED_DRAWN = `(function(){
  var fig = document.querySelector(${JSON.stringify(PRESENTED)});
  return fig !== null && fig.getAttribute("data-tugx-chart-state") === "rendered";
})()`;

const PRESENTED_GONE = `document.querySelector(${JSON.stringify(PRESENTED)}) === null && document.documentElement.getAttribute("data-overlay-claim-state") !== "all"`;

describe.skipIf(!SHOULD_RUN)("at0903 — a diagram's target shows it at full size over the deck", () => {
  test(
    "the target raises the figure in the overlay, unscrolled, and Escape and the target take it down",
    async () => {
      const { app, tugbankPath } = await launchWithCharts(TEST_NAME, [WIDE_SPEC], "tugdiagram");
      const page = app.body(CARD);
      try {
        await waitForCharts(page, 1);
        const overlay = await overlayReady(app);

        const last = await page.evalJS<boolean>(
          `(function(){ var t = document.querySelector(${JSON.stringify(TARGET)}); return t !== null && t.nextElementSibling === null; })()`,
        );
        expect(last, "the target stands last in the diagram header's cluster").toBe(true);

        await page.nativeClickAtElement(TARGET);
        await overlay.waitForCondition<boolean>(PRESENTED_DRAWN, { timeoutMs: 15_000 });
        const facts = await overlay.evalJS<PresentedFacts>(READ_PRESENTED);
        const scale = facts.naturalWidth > 0 ? facts.drawnWidth / facts.naturalWidth : 0;
        note(
          `at0903 presented: ${JSON.stringify({
            natural: facts.naturalWidth,
            drawn: Math.round(facts.drawnWidth),
            scale: Number(scale.toFixed(3)),
            window: facts.windowWidth,
            body: [facts.bodyClient, facts.bodyScroll],
            panel: [facts.panelClient, facts.panelScroll],
          })}`,
        );

        expect(facts.state).toBe("rendered");
        expect(facts.kind).toBe("diagram");
        expect(facts.dialog, "the figure stands in a dialog, which claims the window").toBe(true);
        expect(facts.pressed, "its own target is pressed").toBe("true");
        expect(facts.rows, "its keyed table has the card's rows").toEqual(["1 keyed row", "2 another row"]);
        expect(facts.bodyScroll, "the figure never scrolls sideways").toBeLessThanOrEqual(facts.bodyClient + 1);
        expect(facts.panelScroll, "nor does the panel").toBeLessThanOrEqual(facts.panelClient + 1);
        expect(scale, "never enlarged").toBeLessThanOrEqual(1.005);
        if (facts.naturalWidth + 120 < facts.windowWidth) {
          expect(scale, "a window wider than the figure shows it at its natural width").toBeGreaterThan(0.995);
        }

        await app.nativeKey("Escape");
        await overlay.waitForCondition<boolean>(PRESENTED_GONE, { timeoutMs: 10_000 });

        await page.nativeClickAtElement(TARGET);
        await overlay.waitForCondition<boolean>(PRESENTED_DRAWN, { timeoutMs: 15_000 });
        await overlay.nativeClickAtElement(PRESENTED_TARGET);
        await overlay.waitForCondition<boolean>(PRESENTED_GONE, { timeoutMs: 10_000 });
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    300_000,
  );
});

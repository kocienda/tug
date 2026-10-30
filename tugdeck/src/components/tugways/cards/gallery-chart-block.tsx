/**
 * gallery-chart-block.tsx — visual fixture for `ChartBlock`, the instrument
 * door's exemplar.
 *
 * One static spec per form through the one renderer:
 *  1. **Bar** — a single series with a gap and a zero, integer format.
 *  2. **Line** — two series with null gaps, duration format.
 *  3. **Sparkline** — values alone, no text, the last point highlighted.
 *  4. **Horizontal bar** — rows with a label column, a rule annotation.
 *  5. **Stacked bar** — segments in series order, totals labelled.
 *  6. **Area** — translucent overlapping fills, and a stacked variant.
 *  7. **Dots** — a row per file, an outcome per dot, oldest left.
 *  8. **Histogram** — samples binned by Freedman–Diaconis.
 *  9. **Spans** — durations on one axis, a status per bar.
 * 10. **Heat** — one row of cells at five opacity steps by quantile.
 * 11. **Bullet** — value, range band, target tick and a faint history.
 * 12. **Scatter** — two series, one measure against another.
 *
 * Switch themes to watch the figures restyle in place; press Table on any
 * figure to see the alternative the Find index reads.
 *
 * @module components/tugways/cards/gallery-chart-block
 */

import React from "react";

import { ChartBlock } from "@/components/tugways/body-kinds/chart-block";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";

const BAR_SPEC = JSON.stringify(
  {
    tugchart: 1,
    form: "bar",
    title: "Commits per day",
    subtitle: "main, last week",
    unit: "commits",
    format: "int",
    categories: ["10-21", "10-22", "10-23", "10-24", "10-25", "10-26", "10-27"],
    series: [{ name: "commits", values: [4, 7, 0, 12, 3, null, 9] }],
  },
  null,
  2,
);

const LINE_SPEC = JSON.stringify(
  {
    tugchart: 1,
    form: "line",
    title: "Wall time per run",
    format: "secs",
    x: ["5", "4", "3", "2", "1", "0"],
    series: [
      { name: "rust", values: [70, 72, null, 69, 80, 75] },
      { name: "deck", values: [30, 31, 33, 32, null, 34] },
    ],
  },
  null,
  2,
);

const SPARKLINE_SPEC = JSON.stringify({ tugchart: 1, form: "sparkline", values: [3, 5, 4, 8, 6, 7, 9, 5] });

const HORIZONTAL_BAR_SPEC = JSON.stringify({
  tugchart: 1,
  form: "bar",
  orient: "horizontal",
  title: "Report gaps by command",
  subtitle: "calls over 20 s that reported nothing",
  unit: "calls",
  format: "int",
  categories: ["just app-test", "cargo nextest", "bun test", "just build-app", "git log"],
  series: [{ name: "calls", values: [14, 9, 6, 2, 1] }],
  annotations: [{ kind: "rule", value: 10, label: "budget" }],
});

const STACKED_BAR_SPEC = JSON.stringify({
  tugchart: 1,
  form: "bar",
  layout: "stacked",
  title: "Lines changed per day",
  format: "int",
  categories: ["Mon", "Tue", "Wed", "Thu"],
  series: [
    { name: "added", values: [120, 80, null, 40], role: "good" },
    { name: "removed", values: [-30, -60, -10, 0], role: "bad" },
    { name: "moved", values: [20, 15, 25, 5] },
  ],
});

const AREA_SPEC = JSON.stringify({
  tugchart: 1,
  form: "area",
  title: "Open files by card",
  x: ["1", "2", "3", "4", "5", "6"],
  series: [
    { name: "session", values: [3, 5, 4, null, 6, 7] },
    { name: "changes", values: [1, 2, 2, 3, 2, 1] },
  ],
});

const AREA_STACKED_SPEC = JSON.stringify({
  tugchart: 1,
  form: "area",
  layout: "stacked",
  title: "Tests by suite",
  format: "count",
  x: [2021, 2022, 2023, 2024],
  series: [
    { name: "rust", values: [400, 650, 900, 1200] },
    { name: "deck", values: [100, 300, 500, 700] },
    { name: "app", values: [0, 20, 60, 120] },
  ],
});

const DOTS_SPEC = JSON.stringify({
  tugchart: 1,
  form: "dots",
  title: "App-test history",
  subtitle: "newest 20 runs, oldest left",
  rows: [
    { label: "at0602-find-fidelity-sweep.test.ts", items: ["good", "good", "bad", "good", "good", "neutral", "good"] },
    { label: "at0765-tugchart-fence.test.ts", items: ["good", "good", "good"] },
    { label: "at0766-bash-tug-chart.test.ts", items: ["bad", "bad", "good", "good", "good", "good", "good"] },
  ],
});

const HISTOGRAM_SPEC = JSON.stringify({
  tugchart: 1,
  form: "histogram",
  title: "File wall times",
  unit: "s",
  format: "secs",
  values: [3, 4, 4, 5, 5, 5, 6, 6, 7, 8, 9, 12, 14, 19, 3.5, 4.2, 5.8, 6.1, 20, 2],
});

const SPANS_SPEC = JSON.stringify({
  tugchart: 1,
  form: "spans",
  title: "Arc steps",
  unit: "minutes from start",
  items: [
    { label: "Spec and validator", start: 0, end: 18, status: "good" },
    { label: "Forms", start: 18, end: 55 },
    { label: "Find", start: 55, end: 72, status: "bad" },
    { label: "Verdict", start: 72, end: 80, status: "accent" },
  ],
});

const HEAT_SPEC = JSON.stringify({
  tugchart: 1,
  form: "heat",
  title: "Commits per day",
  format: "int",
  categories: ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14"],
  values: [0, 2, 5, 1, null, 8, 3, 3, 12, 0, 1, 6, 4, 9],
});

const BULLET_SPEC = JSON.stringify({
  tugchart: 1,
  form: "bullet",
  title: "Suite wall time against budget",
  format: "secs",
  items: [
    { label: "rust", value: 72, range: [60, 90], target: 80, history: [70, 72, 69, 80, 75, 72] },
    { label: "deck", value: 31, range: [25, 40], target: 30 },
    { label: "app-tests", value: 310, target: 240, history: [200, 220, null, 260, 310] },
  ],
});

const SCATTER_SPEC = JSON.stringify({
  tugchart: 1,
  form: "scatter",
  title: "Wall time follows the size of the change",
  unit: "wall time",
  format: "secs",
  xunit: "lines changed",
  xformat: "count",
  series: [
    { name: "unit", points: [{ x: 120, y: 4.2 }, { x: 340, y: 6.1 }, { x: 900, y: 11.5 }, { x: 1600, y: 19 }] },
    { name: "integration", points: [{ x: 80, y: 21 }, { x: 410, y: 34 }, { x: 760, y: 58 }, { x: 1400, y: 92 }] },
  ],
});

const SECTIONS: ReadonlyArray<{ title: string; source: string }> = [
  { title: "Bar — one series, a gap and a zero, `int` format", source: BAR_SPEC },
  { title: "Line — two series with null gaps, `secs` format", source: LINE_SPEC },
  { title: "Sparkline — values alone, last point highlighted", source: SPARKLINE_SPEC },
  { title: "Horizontal bar — a label column, a rule at the budget", source: HORIZONTAL_BAR_SPEC },
  { title: "Stacked bar — segments in series order, totals labelled", source: STACKED_BAR_SPEC },
  { title: "Area — translucent fills that overlap", source: AREA_SPEC },
  { title: "Area, stacked — opaque fills, each on the one below", source: AREA_STACKED_SPEC },
  { title: "Dots — a row per file, an outcome per dot, oldest left", source: DOTS_SPEC },
  { title: "Histogram — samples binned by Freedman–Diaconis, `secs` edges", source: HISTOGRAM_SPEC },
  { title: "Spans — durations on one axis, a status per bar", source: SPANS_SPEC },
  { title: "Heat — one row of cells at five opacity steps by quantile", source: HEAT_SPEC },
  { title: "Bullet — value bar, range band, target tick, faint history", source: BULLET_SPEC },
  { title: "Scatter — two series, named at the plot's right, `count` against `secs`", source: SCATTER_SPEC },
];

export function GalleryChartBlock(): React.ReactElement {
  return (
    <div className="cg-content" data-testid="gallery-chart-block">
      {SECTIONS.map((section, i) => (
        <React.Fragment key={section.title}>
          {i > 0 ? <TugSeparator /> : null}
          <div className="cg-section">
            <TugLabel className="cg-section-title">{section.title}</TugLabel>
            <ChartBlock source={section.source} />
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

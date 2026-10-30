/**
 * `splitChartLines` — the `TUG-CHART:` stdout door: a line is matched by
 * its trimmed head, stripped from the text, kept as a source up to the
 * limit, and counted past it; a marker in mid-line is prose.
 */

import { describe, expect, test } from "bun:test";

import { CHART_LINE_LIMIT, splitChartLines } from "../chart-lines";

const SPEC = '{"tugchart":1,"form":"bar","categories":["a"],"series":[{"name":"n","values":[1]}]}';

describe("splitChartLines", () => {
  test("no marker: the text comes back byte-identical", () => {
    const out = splitChartLines("plain\noutput\n");
    expect(out).toEqual({ text: "plain\noutput\n", charts: [], dropped: 0 });
  });

  test("one line is stripped and kept as a source", () => {
    const out = splitChartLines(`before\nTUG-CHART: ${SPEC}\nafter`);
    expect(out.text).toBe("before\nafter");
    expect(out.charts).toEqual([SPEC]);
    expect(out.dropped).toBe(0);
  });

  test("two lines keep stdout order", () => {
    const out = splitChartLines(`TUG-CHART: {"a":1}\nmid\nTUG-CHART: {"b":2}\n`);
    expect(out.text).toBe("mid\n");
    expect(out.charts).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("an indented marker matches by its trimmed head", () => {
    const out = splitChartLines(`   TUG-CHART: {"a":1}  \nrest`);
    expect(out.text).toBe("rest");
    expect(out.charts).toEqual(['{"a":1}']);
  });

  test("broken JSON is still a chart, for the renderer to refuse", () => {
    const out = splitChartLines("TUG-CHART: {not json\nok");
    expect(out.text).toBe("ok");
    expect(out.charts).toEqual(["{not json"]);
  });

  test("past the limit: stripped and counted, not kept", () => {
    const lines = Array.from({ length: CHART_LINE_LIMIT + 1 }, (_, i) => `TUG-CHART: {"i":${i}}`);
    const out = splitChartLines(["head", ...lines, "tail"].join("\n"));
    expect(out.text).toBe("head\ntail");
    expect(out.charts.length).toBe(CHART_LINE_LIMIT);
    expect(out.charts[CHART_LINE_LIMIT - 1]).toBe(`{"i":${CHART_LINE_LIMIT - 1}}`);
    expect(out.dropped).toBe(1);
  });

  test("a marker in mid-line is prose", () => {
    const line = 'echo TUG-CHART: {"a":1} is how a command emits one';
    const out = splitChartLines(line);
    expect(out).toEqual({ text: line, charts: [], dropped: 0 });
  });
});

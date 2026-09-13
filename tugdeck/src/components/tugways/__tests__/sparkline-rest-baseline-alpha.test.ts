/**
 * The rest baseline's CSS and the canvas's zero stroke are ONE line.
 *
 * `tug-sparkline.css` draws a 1px bar where the geometry paints zero, so that
 * a quiet session's instrument survives anything the paint protocol can lose.
 * For the two to read as one line rather than as two, three numbers have to
 * agree, and none of them can be shared by an import: the canvas has no
 * cascade and the cascade has no modules.
 *
 *  - the alpha the bar is drawn at, against `SPARKLINE_LINE_ALPHA`;
 *  - the bar's thickness, against `SPARKLINE_LINE_WIDTH`;
 *  - the row it occupies, against the `FLOOR` the component reserves — the
 *    geometry's `baselineY` is `height - FLOOR - 0.5`, the centre of a 1px
 *    stroke, so the bar's own `bottom` must be that `FLOOR`.
 *
 * Reading the stylesheet's text is the only way to check a number the cascade
 * owns without a browser, and it is what the token-coverage tests in this
 * directory already do.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SPARKLINE_LINE_ALPHA,
  SPARKLINE_LINE_WIDTH,
} from "@/lib/sparkline-geometry";

/**
 * The `FLOOR` reserved in `tug-sparkline.tsx`: a 1px gutter under the
 * baseline so the stroke is never rounded away against the clip.
 */
const FLOOR_PX = 1;

const CSS = readFileSync(
  fileURLToPath(new URL("../tug-sparkline.css", import.meta.url)),
  "utf8",
);

/** The body of the first rule whose selector matches, comments stripped. */
function ruleBody(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `${selector} is declared`).toBeGreaterThanOrEqual(0);
  const open = CSS.indexOf("{", at);
  const close = CSS.indexOf("}", open);
  return CSS.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
}

/** One declaration's value out of a rule body. */
function decl(body: string, property: string): string {
  const m = new RegExp(`(?:^|;|\\n)\\s*${property}\\s*:\\s*([^;}]+)`).exec(body);
  expect(m, `${property} is declared`).not.toBeNull();
  return m![1]!.trim();
}

describe("the sparkline's rest baseline matches the canvas's zero stroke", () => {
  test("the bar is drawn at SPARKLINE_LINE_ALPHA", () => {
    const alpha = decl(ruleBody(".tug-sparkline"), "--sparkline-line-alpha");
    expect(Number(alpha)).toBe(SPARKLINE_LINE_ALPHA);
  });

  test("the bar reads the consumer's alpha knob before that default", () => {
    const body = ruleBody(".tug-sparkline::before");
    // The canvas resolves `--tugx-sparkline-line-alpha` and falls back to
    // `SPARKLINE_LINE_ALPHA`; the bar has to walk the same two steps, or the
    // activity card's brighter line has a dimmer bar under it ([B02]).
    expect(decl(body, "opacity")).toBe(
      "var(--tugx-sparkline-line-alpha, var(--sparkline-line-alpha))",
    );
  });

  test("the bar rides the same ink the canvas resolves its colour from", () => {
    // [B02]: `currentColor`, so the baseline inherits every path the canvas
    // colour does — the channel tints below it and the masthead's pin to the
    // chrome foreground alike.
    expect(decl(ruleBody(".tug-sparkline::before"), "background")).toBe(
      "currentColor",
    );
  });

  test("the bar is one stroke thick and sits on the geometry's zero row", () => {
    const body = ruleBody(".tug-sparkline::before");
    expect(decl(body, "height")).toBe(`${SPARKLINE_LINE_WIDTH}px`);
    // `baselineY = height - FLOOR - 0.5` is the centre of that stroke, so the
    // row it covers ends exactly FLOOR px above the box's bottom edge.
    expect(decl(body, "bottom")).toBe(`${FLOOR_PX}px`);
  });
});

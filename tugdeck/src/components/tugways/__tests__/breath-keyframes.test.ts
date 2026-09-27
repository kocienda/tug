/**
 * The pulsing dot's keyframe generator, and the stylesheet it is the source of.
 *
 * Two rules govern the shape of these blocks, and the second is the one this
 * file exists to hold.
 *
 * QUALIFICATION says the easing must be a form Core Animation can express —
 * a `cubic-bezier()`, never a multi-stop `linear()` or a `steps()` — or WebKit
 * declines to accelerate the animation at all. `audit-motion.ts` enforces that
 * across the whole stylesheet corpus, so it is not re-litigated here beyond a
 * direct assertion that neither banned form appears in these three blocks.
 *
 * PRICE PER KEYFRAME is the second, and nothing else enforces it. WebKit
 * re-derives a layer's reachable box on every compositing update by sampling
 * each running transform animation ONCE PER KEYFRAME, with no cache across
 * updates — so an accelerated 21-stop loop is still billed 21 samples per dot
 * per update. Cutting the breath to three stops and the ring's radius to two
 * is what took `computeExtentOfTransformAnimation` on the release deck from a
 * mean of 22.0 samples per three-second process sample to 5.7, at a fixed
 * population of 23 dots. A future edit that "just adds a stop or two" to
 * smooth something walks that number back, so the stop counts are asserted.
 *
 * The other half is that the shape must SURVIVE the cut. Three stops with a
 * bezier per leg is only the same envelope if the bezier really is the cosine
 * the sampled form encoded, so the curve-agreement cases evaluate both beziers
 * numerically and compare them against `breathAt` and against the cubic
 * ease-out, rather than taking the plan's word for it.
 *
 * And the drift guard is what makes the generator the source rather than a
 * comment claiming to be: the stylesheet's three blocks are read from disk and
 * compared byte for byte against what the generator emits.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  breathAt,
  breathKeyframes,
  DEFAULT_BREATH_TURN,
} from "../internal/tug-progress-pulsing-dot";

const PREFIX = "tugx-progress-pulsing-dot";
const SHIPPED = breathKeyframes(DEFAULT_BREATH_TURN, PREFIX);

const CSS_PATH = join(
  import.meta.dir,
  "..",
  "internal",
  "tug-progress-pulsing-dot.css",
);

/**
 * One `@keyframes <prefix>-<suffix> { … }` block out of a larger text, brace
 * to matching brace.
 *
 * A regex over `[^}]*` cannot do this — the blocks contain inner braces — and
 * the drift guard's whole value is byte equality, so the extraction has to be
 * exact rather than approximately right.
 */
function keyframeBlock(source: string, name: string): string {
  const head = `@keyframes ${name} {`;
  const start = source.indexOf(head);
  expect(start, `no @keyframes ${name} in the source`).toBeGreaterThanOrEqual(
    0,
  );
  let depth = 0;
  for (let i = start + head.length - 1; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated @keyframes ${name}`);
}

/**
 * Every stop selector declared in one block, in order.
 *
 * Both spellings count: a selector alone on its line (`  0%,`) and the one
 * that opens the group (`  30% {`). A group with two selectors contributes
 * both, which is what makes the expand block read as `0, 27, 100`.
 */
function stopSelectors(block: string): string[] {
  return [...block.matchAll(/^\s*(-?[\d.]+)%\s*(?:,|\{)\s*$/gm)].map(
    (m) => m[1],
  );
}

/** Every top-level `{ … }` group in one block, in order. */
function stopGroups(block: string): string[] {
  const body = block.slice(block.indexOf("{") + 1, block.lastIndexOf("}"));
  return [...body.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
}

/**
 * `cubic-bezier(x1, y1, x2, y2)` as a function of x, by bisection on the
 * x-polynomial to 2**-40.
 *
 * Newton would converge faster and is what a browser uses; bisection is
 * chosen here because it cannot fail to converge on a monotone x-polynomial
 * and this is a test, where being obviously right beats being quick.
 */
function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (x: number) => number {
  const coord = (t: number, a: number, b: number): number =>
    3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  return (x: number): number => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (coord(mid, x1, x2) < x) lo = mid;
      else hi = mid;
    }
    return coord((lo + hi) / 2, y1, y2);
  };
}

describe("breathKeyframes emits as few stops as the shape needs", () => {
  test("the breath is three stops", () => {
    const block = keyframeBlock(SHIPPED, `${PREFIX}-breathe`);
    expect(stopSelectors(block)).toEqual(["0", "30", "100"]);
    expect(stopGroups(block)).toHaveLength(3);
  });

  test("the ring's radius is two distinct transform values", () => {
    const block = keyframeBlock(SHIPPED, `${PREFIX}-emit-expand`);
    const transforms = [...block.matchAll(/transform: (.+);/g)].map(
      (m) => m[1],
    );
    expect(transforms).toEqual([
      "scale(var(--tugx-progress-pulsing-dot-birth-resolved))",
      "scale(var(--tugx-progress-pulsing-dot-reach-resolved))",
    ]);
    expect(new Set(transforms).size).toBe(2);
  });

  test("the fade block is unchanged from the shipped one", () => {
    // The fade was already two stops and a hairline; this arc did not touch
    // it, and a diff here would mean the generator's shared helpers moved
    // something nobody meant to move.
    expect(keyframeBlock(SHIPPED, `${PREFIX}-emit-fade`)).toBe(
      [
        `@keyframes ${PREFIX}-emit-fade {`,
        "  0%,",
        "  26.99% {",
        "    opacity: 0;",
        "  }",
        "  27% {",
        "    opacity: var(--tugx-progress-pulsing-dot-emit-opacity, 0.95);",
        "  }",
        "  100% {",
        "    opacity: 0;",
        "  }",
        "}",
      ].join("\n"),
    );
  });
});

describe("the easing is a form Core Animation can accelerate", () => {
  test("no multi-stop linear() and no steps() anywhere in the three blocks", () => {
    expect(SHIPPED).not.toContain("linear(");
    expect(SHIPPED).not.toContain("steps(");
  });

  test("every non-final stop declares exactly one cubic-bezier()", () => {
    for (const name of [`${PREFIX}-breathe`, `${PREFIX}-emit-expand`]) {
      const groups = stopGroups(keyframeBlock(SHIPPED, name));
      const nonFinal = groups.slice(0, -1);
      expect(nonFinal.length, `${name} has no interior stop`).toBeGreaterThan(
        0,
      );
      for (const group of nonFinal) {
        expect(
          [...group.matchAll(/cubic-bezier\(/g)],
          `${name}: an interior stop declares no single easing`,
        ).toHaveLength(1);
      }
      // The last stop begins no segment, so an easing on it would be inert
      // and would read as if it meant something.
      expect(groups[groups.length - 1]).not.toContain("cubic-bezier(");
    }
  });
});

describe("the bezier really is the curve the sampled form encoded", () => {
  const SAMPLES = 101;
  const TOLERANCE = 0.005;

  test("cubic-bezier(0.37, 0, 0.63, 1) matches breathAt on both legs", () => {
    const turn = DEFAULT_BREATH_TURN;
    const ease = cubicBezier(0.37, 0, 0.63, 1);
    let worstRise = 0;
    let worstFall = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const u = i / (SAMPLES - 1);
      worstRise = Math.max(worstRise, Math.abs(ease(u) - breathAt(turn, u * turn)));
      // The fall's keyframe interpolates peak -> trough, so the same
      // symmetric bezier delivers `1 - ease(u)` for free. That is the whole
      // reason one constant serves both legs.
      worstFall = Math.max(
        worstFall,
        Math.abs(1 - ease(u) - breathAt(turn, turn + u * (1 - turn))),
      );
    }
    console.log(
      `breath legs: max |bezier - breathAt| = ${worstRise.toFixed(5)} (rise), ${worstFall.toFixed(5)} (fall)`,
    );
    expect(worstRise).toBeLessThan(TOLERANCE);
    expect(worstFall).toBeLessThan(TOLERANCE);
  });

  test("cubic-bezier(0.33, 1, 0.68, 1) matches the cubic ease-out", () => {
    const ease = cubicBezier(0.33, 1, 0.68, 1);
    let worst = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const u = i / (SAMPLES - 1);
      worst = Math.max(worst, Math.abs(ease(u) - (1 - (1 - u) ** 3)));
    }
    console.log(
      `expand: max |bezier - (1 - (1-u)^3)| = ${worst.toFixed(5)}`,
    );
    expect(worst).toBeLessThan(TOLERANCE);
  });
});

describe("the generator is the stylesheet's source", () => {
  test("the three blocks on disk are byte-identical to what it emits", () => {
    const css = readFileSync(CSS_PATH, "utf8");
    for (const suffix of ["breathe", "emit-expand", "emit-fade"]) {
      const name = `${PREFIX}-${suffix}`;
      expect(
        keyframeBlock(css, name),
        `${name} has drifted from breathKeyframes(${DEFAULT_BREATH_TURN}, "${PREFIX}") — regenerate the block rather than hand-editing it`,
      ).toBe(keyframeBlock(SHIPPED, name));
    }
  });
});

describe("the turn is still a knob", () => {
  test("a symmetric turn moves the peak and the ignition together", () => {
    const symmetric = breathKeyframes(0.5, "gpi-symmetric");
    expect(stopSelectors(keyframeBlock(symmetric, "gpi-symmetric-breathe"))).toEqual([
      "0",
      "50",
      "100",
    ]);
    // Ignition stays EMIT_ADVANCE (3%) ahead of the turn, so the gallery's
    // bench still shows a ring shed before the peak rather than at it.
    expect(
      stopSelectors(keyframeBlock(symmetric, "gpi-symmetric-emit-expand")),
    ).toEqual(["0", "47", "100"]);
  });
});

/**
 * No forced layout in the dot component.
 *
 * The poses this file writes are transforms, which layout does not inform, so
 * a layout-forcing read here buys nothing and costs a full layout pass per
 * crossing per dot. `flushStyle` — `el.getAnimations()` — resolves style
 * without one, and is the only flush the file should hold.
 *
 * A text assertion is the only kind available for a rule of this form, and it
 * is the right shape for it: the rule is about which API names appear, and
 * nothing at runtime can be asked "did you force layout?".
 *
 * **Comments are stripped before the assertion**, because `flushStyle`'s own
 * docblock explains at length why it is not `offsetWidth` — and a rule about
 * code that a correct explanation of the rule can violate is a rule that
 * teaches people to delete the explanation.
 */
describe("the dot component forces no layout", () => {
  const FORCING = [
    "offsetWidth",
    "offsetHeight",
    "clientWidth",
    "clientHeight",
    "getBoundingClientRect",
  ] as const;

  /** Source with block and line comments removed. */
  function code(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
  }

  test("nothing in the component forces layout", () => {
    const source = code(
      readFileSync(
        join(import.meta.dir, "..", "internal", "tug-progress-pulsing-dot.tsx"),
        "utf8",
      ),
    );
    const hits = FORCING.flatMap((name) =>
      [...source.matchAll(new RegExp(`\\b${name}\\b`, "g"))].map(() => name),
    );
    // The last survivor was `void root.offsetWidth` inside `startLoops`,
    // serving the gate dance the shared `startTime` replaced. There is
    // nothing left.
    expect(hits).toEqual([]);
    expect(source).toContain("flushStyle(well)");
  });
});

/**
 * Phase is read from the clock, never from a style variable.
 *
 * The loops used to be phase-shifted by writing a negative
 * `animation-delay` through two custom properties, one per loop, and the
 * phase to write was read back out of `getComputedTiming().progress` a frame
 * later. Both halves are gone: `startLoops` assigns every loop one identical
 * `startTime` and phase is read as `currentTime`.
 *
 * **Not a blanket ban on `getComputedTiming`.** `releaseEmitter` calls it to
 * find where a pulse in flight is, which is a reading of the effect and not a
 * phase source, and that call stays. So the count below is pinned at exactly
 * the five `progress` reads that function makes — a sixth is a new phase
 * source and goes red, which a ban on the API name could not tell apart from
 * the five that belong.
 */
describe("the phase source is the clock", () => {
  function code(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
  }

  test("no `progress` read outside releaseEmitter, and no delay variables in the CSS", () => {
    const source = code(
      readFileSync(
        join(import.meta.dir, "..", "internal", "tug-progress-pulsing-dot.tsx"),
        "utf8",
      ),
    );
    expect(source).not.toContain("getComputedTiming().progress");
    // The five are `const progress = timing?.progress` (which is two), the
    // type guard, the ignition comparison and the remaining-time arithmetic,
    // all inside `releaseEmitter`. `\b` is no use here: a hyphen is a word
    // boundary, so it matches inside every `tug-progress-pulsing-dot` in the
    // file.
    expect(
      [...source.matchAll(/(?<![-\w])progress(?![-\w])/g)],
    ).toHaveLength(5);
    // And the weld is what replaced them: one `startTime` for every loop.
    expect(source).toContain("loop.startTime = shared");

    const css = readFileSync(
      join(import.meta.dir, "..", "internal", "tug-progress-pulsing-dot.css"),
      "utf8",
    );
    expect(css).not.toContain("animation-delay");
    expect(css).not.toContain("--tugx-progress-pulsing-dot-phase");
    expect(css).not.toContain("--tugx-progress-pulsing-dot-emit-phase");
  });
});

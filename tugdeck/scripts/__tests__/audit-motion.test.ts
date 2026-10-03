/**
 * audit-motion.test.ts — the motion audit's own calibration.
 *
 * A guard that silently does nothing and a corpus that is genuinely clean
 * produce the same green, and `audit:motion` is green over the corpus as of
 * this arc — so the corpus cannot be what proves it works. Every clause below
 * is fed a fixture that must fire and a fixture that must not, because the
 * false-positive half is what decides whether the rule survives contact with
 * the next person who trips it. A guard that convicts a correct stylesheet is
 * a guard somebody turns off, and the rule dies with it.
 *
 * Rules 1 and 2 are here too, on two short fixtures each. They are older than
 * this file and were carried across a rename; the tests are what say the
 * rename dropped nothing. Rule 2's keyframe fixture is more than a carry: the
 * scan used to read blocks with a single-level regex, which never saw a
 * `@keyframes` wrapper's name at all, so the keyframe half of rule 2 resolved
 * nothing for as long as it existed. It resolves now, and this is what says so.
 *
 * Rule 5 reads different text — calls and `@keyframes` names rather than
 * declarations — so its fixtures go through its own two scanners, and the
 * carve-out list is checked against the files it names.
 *
 * Run: `cd tugdeck && bun test ./scripts/__tests__` — the path is explicit
 * because `bunfig.toml` pins `[test] root = "src"`, so a bare `bun test` never
 * discovers a file outside it.
 */

import fs from "fs";
import path from "path";

import { describe, expect, test } from "bun:test";

import {
  collectMotionContext,
  MOTION_CARVE_OUTS,
  scanCss,
  scanEntranceKeyframes,
  scanRawAnimate,
  scanTs,
  type Hit,
  type Source,
} from "../audit-motion";

/**
 * The hold owner every fixture below declares, so a fixture about rules 1
 * to 3 varies one thing at a time and rule 4 stays out of its reading. Rule
 * 4's own fixtures build their corpus by hand.
 */
const OWNER: Source = {
  path: "owner.tsx",
  text: `import { useMotionHold } from "@/lib/motion-guard";\nuseMotionHold(true);\n`,
  kind: "ts",
};

/** Scan one stylesheet fixture, with any further files as its corpus. */
function scan(css: string, ...rest: readonly Source[]): Hit[] {
  const text = `${css}\n/* @tug-motion-hold owner.tsx */\n`;
  const self: Source = { path: "fixture.css", text, kind: "css" };
  return scanCss(
    text,
    "fixture.css",
    collectMotionContext([self, OWNER, ...rest]),
  );
}

/** Scan one TypeScript fixture, with any further files as its corpus. */
function scanTypeScript(ts: string, ...rest: readonly Source[]): Hit[] {
  const text = `${ts}\n// @tug-motion-hold owner.tsx\n`;
  const self: Source = { path: "fixture.ts", text, kind: "ts" };
  return scanTs(text, "fixture.ts", collectMotionContext([self, OWNER, ...rest]));
}

/** Scan a stylesheet with exactly the corpus given — no owner is implied. */
function scanBare(css: string, rel: string, ...rest: readonly Source[]): Hit[] {
  const self: Source = { path: rel, text: css, kind: "css" };
  return scanCss(css, rel, collectMotionContext([self, ...rest]));
}

/** The rule numbers a fixture fires, in order. */
function rules(hits: readonly Hit[]): number[] {
  return hits.map((hit) => hit.rule);
}

/** One `:root` corpus file, for the fixtures that resolve a token. */
function theme(declarations: string): Source {
  return {
    path: "theme.css",
    text: `:root {\n${declarations}\n}\n`,
    kind: "css",
  };
}

/** A loop in the qualifying form, so a fixture varies one thing at a time. */
const COMPLIANT = `
@keyframes fx {
  from { transform: scale(1); }
  to   { transform: scale(1.2); }
}
.glyph {
  animation: fx 1s ease-in-out var(--tug-loop-iterations, infinite);
}
`;

describe("the baseline a clause varies from", () => {
  test("a compliant loop fires nothing", () => {
    expect(scan(COMPLIANT)).toEqual([]);
  });
});

describe("rule 3 clause 1 — what the keyframes animate", () => {
  test("a `background-color` stop is a loop the compositor never holds", () => {
    const hits = scan(`
      @keyframes fx {
        from { background-color: red; }
        to   { background-color: blue; }
      }
      .glyph {
        animation: fx 1s linear var(--tug-loop-iterations, infinite);
      }
    `);
    expect(rules(hits)).toEqual([3]);
    expect(hits[0].detail).toContain("`background-color`");
    expect(hits[0].detail).toContain("via `fx`");
  });

  test("the individual transform properties are accelerated, and pass", () => {
    // `@keyframes tug-petals-scale` animates `scale`, not `transform`, and is
    // compositor-resident — rule 2's narrower [D9] set would have convicted it.
    expect(
      scan(`
        @keyframes fx {
          from { scale: 1; rotate: 0deg; translate: 0 0; opacity: 0.4; }
          to   { scale: 1.2; rotate: 8deg; translate: 1px 0; opacity: 1; }
        }
        .glyph {
          animation: fx 1s ease-in-out var(--tug-loop-iterations, infinite);
        }
      `),
    ).toEqual([]);
  });

  test("a name declared on the same selector in another block still resolves", () => {
    // The pulsing dot's shape: the iteration count on one block, the name
    // further down the file on the same selector.
    const hits = scan(`
      @keyframes fx {
        from { filter: blur(0); }
        to   { filter: blur(2px); }
      }
      .glyph {
        animation-duration: 1s;
        animation-iteration-count: var(--tug-loop-iterations, infinite);
      }
      .glyph {
        animation-name: fx;
        animation-timing-function: linear;
      }
    `);
    expect(rules(hits)).toEqual([3]);
    expect(hits[0].detail).toContain("`filter`");
  });

  test("a name written through a variable's fallback resolves too", () => {
    const hits = scan(`
      @keyframes fx {
        from { height: 0; }
        to   { height: 10px; }
      }
      .glyph {
        animation-name: var(--glyph-name, fx);
        animation-iteration-count: var(--tug-loop-iterations, infinite);
      }
    `);
    expect(rules(hits)).toEqual([3]);
    expect(hits[0].detail).toContain("`height`");
  });
});

describe("rule 3 clause 2 — the loop's own effect stack", () => {
  test("a transition on the loop's subject demotes the loop", () => {
    const hits = scan(`
      ${COMPLIANT}
      .frame .glyph {
        transition: background-color 200ms linear;
      }
    `);
    expect(rules(hits)).toEqual([3]);
    expect(hits[0].detail).toContain("whole effect stack");
  });

  test("the transition and the loop need not share a file", () => {
    const elsewhere: Source = {
      path: "elsewhere.css",
      text: ".glyph { transition: color 200ms linear; }",
      kind: "css",
    };
    expect(rules(scan(COMPLIANT, elsewhere))).toEqual([3]);
  });

  test("a transition on a different subject class is not the loop's", () => {
    expect(
      scan(`
        ${COMPLIANT}
        .glyph-label {
          transition: color 200ms linear;
        }
        .glyph .caption {
          transition: opacity 200ms linear;
        }
      `),
    ).toEqual([]);
  });

  test("a transition on the element is not on its `::after`'s stack", () => {
    // The skeleton's shape: the shimmer runs on `::after`, which is a
    // different box from the element the transition is declared on.
    expect(
      scan(`
        @keyframes fx {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        .glyph::after {
          animation: fx 1s linear var(--tug-loop-iterations, infinite);
        }
        .glyph {
          transition: background-color 200ms linear;
        }
      `),
    ).toEqual([]);
  });

  test("`transition: none` is not a transition", () => {
    expect(
      scan(`
        ${COMPLIANT}
        .glyph[data-static] {
          transition: none;
        }
      `),
    ).toEqual([]);
  });
});

describe("rule 3 clause 3 — one Core Animation segment", () => {
  test("`steps()` is not a bezier", () => {
    const hits = scan(`
      @keyframes fx {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      .glyph {
        animation: fx 1s steps(4) var(--tug-loop-iterations, infinite);
      }
    `);
    expect(rules(hits)).toEqual([3]);
    expect(hits[0].detail).toContain("steps(4)");
  });

  test("a `linear()` with more than two stops is not one segment", () => {
    const hits = scan(`
      @keyframes fx {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      .glyph {
        animation-name: fx;
        animation-timing-function: linear(0, 0.3, 1);
        animation-iteration-count: var(--tug-loop-iterations, infinite);
      }
    `);
    expect(rules(hits)).toEqual([3]);
    expect(hits[0].detail).toContain("linear(0, 0.3, 1)");
  });

  test("a single `cubic-bezier()` is exactly one segment", () => {
    expect(
      scan(`
        @keyframes fx {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        .glyph {
          animation: fx 1s cubic-bezier(0.4, 0, 0.6, 1)
            var(--tug-loop-iterations, infinite);
        }
      `),
    ).toEqual([]);
  });

  test("a keyframe step's own easing is read as well as the block's", () => {
    const hits = scan(`
      @keyframes fx {
        from { opacity: 0; animation-timing-function: steps(3); }
        to   { opacity: 1; }
      }
      .glyph {
        animation: fx 1s linear var(--tug-loop-iterations, infinite);
      }
    `);
    expect(rules(hits)).toEqual([3]);
    expect(hits[0].detail).toContain("steps(3)");
  });

  test("a `cubic-bezier()` per keyframe segment is the permitted form", () => {
    // The doctrine's easing bullet permits a Bézier declared per segment, in
    // the steps themselves, because Core Animation expresses a SEGMENT's
    // easing as one Bézier and that is one per segment. The lint already
    // reads it that way — `easingIsAccelerable` accepts any bare
    // `cubic-bezier(…)` wherever it is declared — and the correction to the
    // doctrine therefore changes no code. This case is what says so, rather
    // than a grep somebody has to re-run.
    //
    // It is exactly the shape the pulsing dot's breath now carries: a curve
    // per leg, the final stop declaring none so it inherits the rule's
    // `linear`, and three stops instead of the twenty-one the old "sample it
    // into offsets" advice produced.
    expect(
      scan(`
        @keyframes fx {
          0% {
            animation-timing-function: cubic-bezier(0.37, 0, 0.63, 1);
            transform: scale(0.8);
          }
          30% {
            animation-timing-function: cubic-bezier(0.37, 0, 0.63, 1);
            transform: scale(1.2);
          }
          100% { transform: scale(0.8); }
        }
        .glyph {
          animation: fx 1s linear var(--tug-loop-iterations, infinite);
        }
      `),
    ).toEqual([]);
  });

  test("the same shape with `steps()` or a multi-stop `linear()` is not", () => {
    // The other half, on the same fixture, so the case above is a reading of
    // the easing rather than of the block's shape. A clause that passed
    // everything in this position would pass the Bézier too.
    const stepped = scan(`
      @keyframes fx {
        0% {
          animation-timing-function: steps(4);
          transform: scale(0.8);
        }
        100% { transform: scale(1.2); }
      }
      .glyph {
        animation: fx 1s linear var(--tug-loop-iterations, infinite);
      }
    `);
    expect(rules(stepped)).toEqual([3]);
    expect(stepped[0].detail).toContain("steps(4)");

    const sampled = scan(`
      @keyframes fx {
        0% {
          animation-timing-function: linear(0, 0.3, 1);
          transform: scale(0.8);
        }
        100% { transform: scale(1.2); }
      }
      .glyph {
        animation: fx 1s linear var(--tug-loop-iterations, infinite);
      }
    `);
    expect(rules(sampled)).toEqual([3]);
    expect(sampled[0].detail).toContain("linear(0, 0.3, 1)");
  });

  test("an easing token resolves one level through the corpus's `:root`", () => {
    expect(
      scan(
        `
        @keyframes fx {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        .glyph {
          animation: fx 1s var(--tug-motion-easing-standard)
            var(--tug-loop-iterations, infinite);
        }
      `,
        theme("  --tug-motion-easing-standard: ease-in-out;"),
      ),
    ).toEqual([]);
  });

  test("an easing token nobody declares is an easing nobody can vouch for", () => {
    const hits = scan(`
      @keyframes fx {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      .glyph {
        animation-name: fx;
        animation-timing-function: var(--nobody-declares-this);
        animation-iteration-count: var(--tug-loop-iterations, infinite);
      }
    `);
    expect(rules(hits)).toEqual([3]);
    expect(hits[0].detail).toContain("resolves to nothing");
  });

  test("a duration carried through a variable is not read as an easing", () => {
    // The arc track's shape. Convicting `var(--breath-ms, 2000ms)` of being a
    // bad easing would be a guard reporting on the wrong token.
    expect(
      scan(`
        @keyframes fx {
          from { opacity: 0.4; }
          to   { opacity: 1; }
        }
        .glyph {
          animation: fx var(--breath-ms, 2000ms) ease-in-out
            var(--tug-loop-iterations, infinite);
        }
      `),
    ).toEqual([]);
  });
});

describe("rule 3 clause 4 — no blending with what is already there", () => {
  test("`animation-composition: add` is a hit", () => {
    const hits = scan(`
      ${COMPLIANT}
      .glyph {
        animation-composition: add;
      }
    `);
    // The `add` block carries no iteration count of its own, so the hit is on
    // the loop block it shares a selector with — which is where it reads.
    expect(rules(hits)).toEqual([]);
    expect(
      rules(
        scan(`
          @keyframes fx {
            from { transform: scale(1); }
            to   { transform: scale(1.2); }
          }
          .glyph {
            animation: fx 1s ease-in-out var(--tug-loop-iterations, infinite);
            animation-composition: add;
          }
        `),
      ),
    ).toEqual([3]);
  });

  test("`replace` is the default said out loud", () => {
    expect(
      scan(`
        @keyframes fx {
          from { transform: scale(1); }
          to   { transform: scale(1.2); }
        }
        .glyph {
          animation: fx 1s ease-in-out var(--tug-loop-iterations, infinite);
          animation-composition: replace;
        }
      `),
    ).toEqual([]);
  });
});

describe("rule 3 clause 5 — the breaker's contract", () => {
  test("a bare `infinite` is a loop the breaker cannot still", () => {
    const hits = scan(`
      @keyframes fx {
        from { transform: scale(1); }
        to   { transform: scale(1.2); }
      }
      .glyph {
        animation: fx 1s ease-in-out infinite;
      }
    `);
    expect(rules(hits)).toEqual([3]);
    expect(hits[0].detail).toContain("bare `infinite`");
  });

  test("a bare `animation-iteration-count: infinite` is the same hit", () => {
    const hits = scan(`
      @keyframes fx {
        from { transform: scale(1); }
        to   { transform: scale(1.2); }
      }
      .glyph {
        animation-name: fx;
        animation-timing-function: linear;
        animation-iteration-count: infinite;
      }
    `);
    expect(rules(hits)).toEqual([3]);
    expect(hits[0].detail).toContain("bare `infinite`");
  });

  test("the variable with no fallback is still a long-running loop", () => {
    // `var(--tug-loop-iterations)` alone contains no `infinite`, runs forever
    // whenever the root is not demoting, and must not escape the other clauses.
    const hits = scan(`
      @keyframes fx {
        from { background-color: red; }
        to   { background-color: blue; }
      }
      .glyph {
        animation: fx 1s linear var(--tug-loop-iterations);
      }
    `);
    expect(rules(hits)).toEqual([3]);
    expect(hits[0].detail).toContain("`background-color`");
  });

  test("a finite loop is not this rule's subject at all", () => {
    expect(
      scan(`
        @keyframes fx {
          from { background-color: red; }
          to   { background-color: blue; }
        }
        .glyph {
          animation: fx 1s linear 3;
        }
      `),
    ).toEqual([]);
  });
});

describe("rule 4 — every long-running loop has a hold owner", () => {
  test("a loop that names an owner that takes a hold fires nothing", () => {
    expect(scan(COMPLIANT)).toEqual([]);
  });

  test("a loop that declares no owner is a hit", () => {
    const hits = scanBare(COMPLIANT, "fixture.css", OWNER);
    expect(rules(hits)).toEqual([4]);
    expect(hits[0].detail).toContain("declares no hold owner");
    expect(hits[0].selector).toBe(".glyph");
  });

  test("an owner nobody has is a hit that names the path", () => {
    const hits = scanBare(
      `${COMPLIANT}\n/* @tug-motion-hold missing.tsx */\n`,
      "fixture.css",
      OWNER,
    );
    expect(rules(hits)).toEqual([4]);
    expect(hits[0].detail).toContain("`missing.tsx`");
  });

  test("an owner that takes no hold is the same hit", () => {
    // The file exists and mounts the glyph; nothing in it calls the
    // registry. That is exactly the caret blink's shape before it was
    // registered, and the rule exists to refuse it.
    const idle: Source = {
      path: "idle.tsx",
      text: `export function Idle() { return null; }\n`,
      kind: "ts",
    };
    const hits = scanBare(
      `${COMPLIANT}\n/* @tug-motion-hold idle.tsx */\n`,
      "fixture.css",
      idle,
    );
    expect(rules(hits)).toEqual([4]);
    expect(hits[0].detail).toContain("`idle.tsx`");
  });

  test("a relative path resolves against the annotated file's directory", () => {
    const owner: Source = {
      path: "src/components/tugways/tug-progress-indicator.tsx",
      text: `useMotionHold(running);\n`,
      kind: "ts",
    };
    expect(
      scanBare(
        `${COMPLIANT}\n/* @tug-motion-hold ../tug-progress-indicator.tsx */\n`,
        "src/components/tugways/internal/tug-progress-ring.css",
        owner,
      ),
    ).toEqual([]);
    // The same annotation from a directory it does not resolve from.
    expect(
      rules(
        scanBare(
          `${COMPLIANT}\n/* @tug-motion-hold ../tug-progress-indicator.tsx */\n`,
          "src/components/tugways/tug-progress-ring.css",
          owner,
        ),
      ),
    ).toEqual([4]);
  });

  test("the registry's own definition is not an owner", () => {
    // `export function acquireMotionHold(` declares the hold; a loop that
    // named the registry as its owner would be registered by nobody.
    const registry: Source = {
      path: "registry.ts",
      text: `export function acquireMotionHold(): () => void { return () => {}; }\n`,
      kind: "ts",
    };
    expect(
      rules(
        scanBare(
          `${COMPLIANT}\n/* @tug-motion-hold registry.ts */\n`,
          "fixture.css",
          registry,
        ),
      ),
    ).toEqual([4]);
  });

  test("a finite animation needs no owner", () => {
    expect(
      scanBare(
        `
@keyframes fx {
  from { transform: scale(1); }
  to   { transform: scale(1.2); }
}
.glyph {
  animation: fx 1s ease-in-out 1;
}
`,
        "fixture.css",
      ),
    ).toEqual([]);
  });

  test("a JS-authored loop may own itself", () => {
    // `atom-decoration.ts` declares the pending pulse and takes its hold in
    // the same file, which is the shape the annotation has to admit.
    const text = `
import { acquireMotionHold } from "@/lib/motion-guard";
const release = acquireMotionHold();
// @tug-motion-hold ./self.ts
export const theme = EditorView.baseTheme({
  "img[data-pending]": {
    animation: "pulse 1s ease-in-out var(--tug-loop-iterations, infinite)",
  },
  "@keyframes pulse": {
    "0%, 100%": { opacity: "0.4" },
    "50%": { opacity: "1" },
  },
});
`;
    const self: Source = { path: "self.ts", text, kind: "ts" };
    expect(scanTs(text, "self.ts", collectMotionContext([self]))).toEqual([]);
  });
});

describe("the TypeScript read", () => {
  /** `atom-decoration.ts`'s `pendingAtomTheme`, in the qualifying form. */
  const PENDING_ATOM = `
import { EditorView } from "@codemirror/view";

export const pendingAtomTheme = EditorView.baseTheme({
  "img[data-pending]": {
    animation:
      "tug-atom-pending-pulse 1s ease-in-out var(--tug-loop-iterations, infinite)",
  },
  "@keyframes tug-atom-pending-pulse": {
    "0%, 100%": {
      opacity: "0.4",
    },
    "50%": {
      opacity: "1",
    },
  },
});
`;

  test("a compliant CodeMirror theme fires nothing", () => {
    expect(scanTypeScript(PENDING_ATOM)).toEqual([]);
  });

  test("a `filter` stop in the same theme is caught", () => {
    // The cut that really existed: `filter: saturate()` co-animated with the
    // opacity dip, which demoted the loop to main-thread blending.
    const hits = scanTypeScript(
      PENDING_ATOM.replace(
        `      opacity: "0.4",`,
        `      opacity: "0.4",\n      filter: "saturate(0.4)",`,
      ),
    );
    expect(rules(hits)).toEqual([3]);
    expect(hits[0].detail).toContain("`filter`");
    expect(hits[0].selector).toBe("img[data-pending]");
  });

  test("a bare `infinite` in a JS-authored loop is caught", () => {
    const hits = scanTypeScript(
      PENDING_ATOM.replace(
        `"tug-atom-pending-pulse 1s ease-in-out var(--tug-loop-iterations, infinite)"`,
        `"tug-atom-pending-pulse 1s ease-in-out infinite"`,
      ),
    );
    expect(rules(hits)).toEqual([3]);
    expect(hits[0].detail).toContain("bare `infinite`");
  });

  test("the reported line is the declaration's, not the file's first", () => {
    const hits = scanTypeScript(
      PENDING_ATOM.replace(
        `"tug-atom-pending-pulse 1s ease-in-out var(--tug-loop-iterations, infinite)"`,
        `"tug-atom-pending-pulse 1s steps(2) var(--tug-loop-iterations, infinite)"`,
      ),
    );
    expect(rules(hits)).toEqual([3]);
    expect(hits[0].line).toBeGreaterThan(4);
  });

  test("a template literal is not read, and says so by finding nothing", () => {
    expect(
      scanTypeScript(`
        const css = \`
          .glyph { animation: fx 1s linear infinite; }
        \`;
      `),
    ).toEqual([]);
  });
});

describe("rule 1 — `position: fixed` under a pane frame", () => {
  test("a selector naming a frame as an ancestor is a hit", () => {
    const hits = scan(".tug-pane .tug-thing { position: fixed; top: 0; }");
    expect(rules(hits)).toEqual([1]);
    expect(hits[0].selector).toBe(".tug-pane .tug-thing");
  });

  test("a frame declared fixed is a different claim, and not this one", () => {
    expect(scan(".tug-pane-exit-ghost { position: fixed; }")).toEqual([]);
  });
});

describe("rule 2 — nothing but transform and opacity animates on a frame", () => {
  test("a `transition: height` on a frame is a hit", () => {
    const hits = scan(".tug-pane { transition: height 200ms ease; }");
    expect(rules(hits)).toEqual([2]);
    expect(hits[0].detail).toContain("`height`");
  });

  test("the same declaration stood down for the settle is excused", () => {
    expect(
      scan(`
        .tug-pane { transition: height 200ms ease; }
        [data-imposer-settling] .tug-pane { transition: none; }
      `),
    ).toEqual([]);
  });

  test("the compound form of the stand-down is excused too", () => {
    // The form the stylesheet actually carries: an attribute on the element it
    // styles invalidates that element alone, where the descendant form makes
    // the engine walk the canvas on every toggle of the mark.
    expect(
      scan(`
        .tug-pane { transition: height 200ms ease; }
        .tug-pane[data-imposer-settling] { transition: none; }
      `),
    ).toEqual([]);
  });

  test("a near-miss stand-down excuses nothing", () => {
    const hits = scan(`
      .tug-pane { transition: height 200ms ease; }
      .tug-pane-chrome[data-imposer-settling] { transition: none; }
    `);
    expect(rules(hits)).toEqual([2]);
    expect(hits[0].selector).toBe(".tug-pane");
  });

  test("an animation is resolved through its `@keyframes`", () => {
    // The hole [F05] fell into, and the one the single-level block regex kept
    // open by never reading a `@keyframes` wrapper's name.
    const hits = scan(`
      @keyframes tug-pane-border-flash {
        from { border-color: red; }
        to   { border-color: blue; }
      }
      .tug-pane-content .flasher {
        animation: tug-pane-border-flash 1s ease-out;
      }
    `);
    expect(rules(hits)).toEqual([2]);
    expect(hits[0].detail).toContain("border-color (via tug-pane-border-flash)");
  });

  test("a transform animation on a frame is what [D9] asks for", () => {
    expect(
      scan(`
        @keyframes tug-pane-slide {
          from { transform: translateX(0); }
          to   { transform: translateX(10px); }
        }
        .tug-pane { animation: tug-pane-slide 200ms ease-out; }
      `),
    ).toEqual([]);
  });
});

describe("rule 5 — motion goes through the animator", () => {
  /** Rule 5's stylesheet half over one fixture, with the fixture as corpus. */
  function entrances(css: string, rel = "fixture.css"): Hit[] {
    const self: Source = { path: rel, text: css, kind: "css" };
    return scanEntranceKeyframes(css, rel, collectMotionContext([self]));
  }

  test("an element's own `.animate(` is a hit, on its line", () => {
    const hits = scanRawAnimate(
      `const x = 1;\nconst a = panel.animate([{ opacity: 0 }], 200);\n`,
      "fixture.ts",
    );
    expect(rules(hits)).toEqual([5]);
    expect(hits[0].line).toBe(2);
    expect(hits[0].selector).toBe("panel.animate(");
  });

  test("an empty effect used as a clock is still a raw call", () => {
    // The settle's beat marker was this shape before `timelineMark()`.
    expect(
      rules(scanRawAnimate(`const m = el.animate(null, { duration: 10 });`, "fixture.ts")),
    ).toEqual([5]);
  });

  test("a call through a ref or a chain names its last receiver", () => {
    const hits = scanRawAnimate(`ref.current?.animate(frames, 100);`, "fixture.ts");
    expect(hits.map((hit) => hit.selector)).toEqual(["current.animate("]);
  });

  test("a group's `.animate(` is the animator's own API", () => {
    expect(
      scanRawAnimate(
        `const g = group({ duration: 100 });\ng.animate(el, [{ opacity: 0 }], {});\n`,
        "fixture.ts",
      ),
    ).toEqual([]);
  });

  test("a receiver is a group only where this file binds it", () => {
    // `g` is a group in some other file; here it could be anything.
    expect(rules(scanRawAnimate(`g.animate(el, [], {});`, "fixture.ts"))).toEqual([5]);
  });

  test("a call in a comment or a string is not a call", () => {
    expect(
      scanRawAnimate(
        `// el.animate(null, {})\n/* panel.animate( */\nconst js = "el.animate(k)";\nconst t = \`x.animate(\${y})\`;\n`,
        "fixture.ts",
      ),
    ).toEqual([]);
  });

  test("the animator's own verbs are not raw calls", () => {
    expect(
      scanRawAnimate(
        `animate(el, [{ opacity: 0 }], {});\nconst m = timelineMark(el, 120);\n`,
        "fixture.ts",
      ),
    ).toEqual([]);
  });

  test("a carved-out file is not read", () => {
    const carveOuts = new Map([["fixture.ts", "the fixture's reason"]]);
    expect(scanRawAnimate(`el.animate(null, {});`, "fixture.ts", carveOuts)).toEqual([]);
  });

  test("an `@keyframes` named for an entrance is a hit", () => {
    for (const name of ["x-enter", "x-fade-in", "x-arrive", "x-appear-down"]) {
      const hits = entrances(
        `@keyframes ${name} {\n  from { transform: scale(0.9); }\n  to { transform: none; }\n}\n`,
      );
      expect(hits.map((hit) => hit.selector)).toEqual([`@keyframes ${name}`]);
    }
  });

  test("a fade up from nothing is an entrance whatever its name", () => {
    const hits = entrances(`
      @keyframes x-show {
        from { opacity: 0; }
        to { opacity: 1; }
      }
    `);
    expect(rules(hits)).toEqual([5]);
    expect(hits[0].line).toBe(2);
  });

  test("a flash opens and closes invisible, and is not an entrance", () => {
    expect(
      entrances(`
        @keyframes x-refusal-flash {
          0% { opacity: 0; }
          8% { opacity: 1; }
          100% { opacity: 0; }
        }
      `),
    ).toEqual([]);
  });

  test("a word that merely contains `in` is not the word", () => {
    expect(
      entrances(`
        @keyframes x-inner-spin {
          from { transform: rotate(0); }
          to { transform: rotate(360deg); }
        }
      `),
    ).toEqual([]);
  });

  test("a loop's keyframes are exempt by name, and the file's others are not", () => {
    const hits = entrances(`
      @keyframes x-breathe-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .glyph { animation: x-breathe-in 1s ease-in-out var(--tug-loop-iterations, infinite); }
      @keyframes x-badge-enter {
        from { transform: scale(0.8); }
        to { transform: none; }
      }
    `);
    expect(hits.map((hit) => hit.selector)).toEqual(["@keyframes x-badge-enter"]);
  });

  test("a carved-out stylesheet is not read", () => {
    const css = `@keyframes x-enter { from { opacity: 0; } to { opacity: 1; } }`;
    const self: Source = { path: "radix.css", text: css, kind: "css" };
    expect(
      scanEntranceKeyframes(
        css,
        "radix.css",
        collectMotionContext([self]),
        new Map([["radix.css", "[L14]"]]),
      ),
    ).toEqual([]);
  });

  test("every carve-out names a file that exists, and says why", () => {
    const repoRoot = path.resolve(import.meta.dir, "../../..");
    for (const [rel, reason] of MOTION_CARVE_OUTS) {
      expect(fs.existsSync(path.join(repoRoot, rel)), rel).toBe(true);
      expect(reason.trim().length, rel).toBeGreaterThan(0);
    }
  });
});

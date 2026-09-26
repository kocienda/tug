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
 * Run: `cd tugdeck && bun test ./scripts/__tests__` — the path is explicit
 * because `bunfig.toml` pins `[test] root = "src"`, so a bare `bun test` never
 * discovers a file outside it.
 */

import { describe, expect, test } from "bun:test";

import {
  collectMotionContext,
  scanCss,
  scanTs,
  type Hit,
  type Source,
} from "../audit-motion";

/** Scan one stylesheet fixture, with any further files as its corpus. */
function scan(css: string, ...rest: readonly Source[]): Hit[] {
  const self: Source = { path: "fixture.css", text: css, kind: "css" };
  return scanCss(css, "fixture.css", collectMotionContext([self, ...rest]));
}

/** Scan one TypeScript fixture, with any further files as its corpus. */
function scanTypeScript(ts: string, ...rest: readonly Source[]): Hit[] {
  const self: Source = { path: "fixture.ts", text: ts, kind: "ts" };
  return scanTs(ts, "fixture.ts", collectMotionContext([self, ...rest]));
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

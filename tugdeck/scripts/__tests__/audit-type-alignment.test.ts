/**
 * audit-type-alignment.test.ts — the guard's own calibration.
 *
 * A guard that silently does nothing and a corpus that is genuinely clean
 * produce the same green, so the corpus cannot be what proves the guard
 * works. This feeds {@link scanCss} fixture strings instead: the nudge
 * corpus as it stood before the sweep (every one must be caught), and the
 * set of declarations that match the same greps and are *not* the law's
 * subject (none may be caught).
 *
 * That second set is the whole reason this file exists. A guard that fires
 * on resize-handle hit areas is a guard somebody turns off, and the rule it
 * was enforcing dies with it — so the false-positive set is tested as
 * deliberately as the true-positive one, and four fixtures below are here
 * because they are the cases a review caught before production did: a
 * tracked legend that declares no `text-align` at all, a line box declared
 * with `block-size` on a rule that cannot wear the class, a sanctioned
 * `vertical-align` reading one named token, and a `translateY` on a rule
 * that carries no text.
 *
 * Run: `cd tugdeck && bun test ./scripts/__tests__` — the path is explicit
 * because `bunfig.toml` pins `[test] root = "src"`, so a bare `bun test`
 * never discovers a file outside it. `just test-ts` names it for that reason;
 * a self-check nobody runs is no check at all.
 */

import { describe, expect, test } from "bun:test";
import { scanCss, type Hit } from "../audit-type-alignment";

/** Scan one fixture, naming it after the file it stands in for. */
function scan(css: string, file = "fixture.css"): Hit[] {
  return scanCss(css, file);
}

/** The rule numbers a fixture fires, in order. */
function rules(css: string, file?: string): number[] {
  return scan(css, file).map((hit) => hit.rule);
}

describe("rule 1 — a micro offset on a rule that carries text", () => {
  test("catches the header family's `position: relative; top: 1px`", () => {
    // Table T01, and the arc's headline case: two adjacent rules in one file
    // carried this, each claiming the OTHER run was the one riding high.
    expect(
      rules(`
        .tool-call-header-dot, .tool-call-header-name {
          position: relative;
          top: 1px;
          font-weight: var(--tug-font-weight-semibold);
        }
      `),
    ).toEqual([1]);
  });

  test("catches a sub-pixel `top` on a rule declaring only `color`", () => {
    expect(
      rules(`
        .task-tool-block-description {
          position: relative;
          top: 0.5px;
          color: var(--tug7-element-global-text-normal-muted-rest);
        }
      `),
    ).toEqual([1]);
  });

  test("catches a small `translateY` beside a type property", () => {
    expect(
      rules(`
        .session-telemetry-endcap-label {
          font-size: 0.5625rem;
          transform: translateY(0.5px);
        }
      `),
    ).toEqual([1]);
  });

  test("catches a length `vertical-align`", () => {
    expect(
      rules(`
        .tug-atom-ref-icon {
          vertical-align: -0.15em;
          color: inherit;
        }
      `),
    ).toEqual([1]);
  });

  test("counts each offending declaration in a rule carrying two", () => {
    // `top` and `translateY` in one rule are two corrections, and a report
    // naming one of them sends the reader back for the other.
    expect(
      rules(`
        .two-nudges {
          font-size: 11px;
          position: relative;
          top: 1px;
          transform: translateY(-1px);
        }
      `),
    ).toEqual([1, 1]);
  });

  // ---- the false positives, which are the point ----------------------

  test("ignores `vertical-align: var(--tug-glyph-cap-offset)`", () => {
    // Rule (iv)'s one sanctioned form: the offset comes from one declared
    // token rather than a length hand-tuned at the use site.
    expect(
      rules(`
        .tug-atom-ref-icon {
          vertical-align: var(--tug-glyph-cap-offset);
          color: inherit;
        }
      `),
    ).toEqual([]);
  });

  test("ignores a `translateY` on a rule that declares no type property", () => {
    // `.usage-sheet-leader` — a dotted leader, a `border-bottom` box with no
    // text in it, lifted to sit on the label's line. Deleting it would drop
    // the leader to the bottom of its flex row.
    expect(
      rules(`
        .usage-sheet-leader {
          flex: 1;
          border-bottom: 1px dotted var(--tug7-element-global-border-normal-default-rest);
          transform: translateY(-0.28em);
        }
      `),
    ).toEqual([]);
  });

  test("ignores an absolutely-positioned hit area", () => {
    // `tug-sheet.css`'s resize handles: real `top` values, no text anywhere.
    expect(
      rules(`
        .tug-sheet-resize-ne {
          position: absolute;
          top: -2px;
          right: -2px;
          width: 12px;
          height: 12px;
        }
      `),
    ).toEqual([]);
  });

  test("ignores an offset too large to be an optical correction", () => {
    expect(
      rules(`
        .tug-popover-anchor {
          position: absolute;
          top: 24px;
          color: inherit;
        }
      `),
    ).toEqual([]);
  });

  test("ignores keyword `vertical-align`", () => {
    // The rule bans lengths only: a keyword selects a box's alignment MODE,
    // which is a mechanism rather than a correction layered over one.
    for (const keyword of ["top", "middle", "baseline", "text-bottom", "bottom"]) {
      expect(
        rules(`.tug-marquee-run { vertical-align: ${keyword}; color: inherit; }`),
      ).toEqual([]);
    }
  });

  test("ignores an offset zeroed out", () => {
    // Zeroing an offset is removing a nudge, not adding one.
    expect(rules(`.x { top: 0; font-size: 11px; }`)).toEqual([]);
    expect(rules(`.x { transform: translateY(0px); font-size: 11px; }`)).toEqual([]);
  });

  test("ignores `line-height: 0`, which is a collapse and not an offset", () => {
    // `sup` / `sub`, and the separator ornament's own inline-flex line box.
    expect(
      rules(`.tugx-md-block sup { line-height: 0; vertical-align: super; }`),
    ).toEqual([]);
  });
});

describe("the escape comment", () => {
  const ORNAMENT = (comment: string) => `
    ${comment}
    .tug-separator-ornament {
      font-size: 0.75rem;
      transform: translateY(-0.05em);
    }
  `;

  test("excuses a rule when the comment sits immediately above it", () => {
    expect(
      rules(ORNAMENT("/* @tug-optical-nudge: the glyph's ink sits low in its em box */")),
    ).toEqual([]);
  });

  test("excuses a rule when the comment sits inside the body", () => {
    expect(
      rules(`
        .tug-separator-ornament {
          font-size: 0.75rem;
          /* @tug-optical-nudge: the glyph's ink sits low in its em box */
          transform: translateY(-0.05em);
        }
      `),
    ).toEqual([]);
  });

  test("does NOT excuse an empty reason", () => {
    // The annotation without the claim is the thing the convention exists to
    // prevent — it would make every nudge excusable by typing a word.
    expect(rules(ORNAMENT("/* @tug-optical-nudge: */"))).toEqual([1]);
    expect(rules(ORNAMENT("/* @tug-optical-nudge:    */"))).toEqual([1]);
  });

  test("does NOT excuse a bare tag with no colon", () => {
    expect(rules(ORNAMENT("/* @tug-optical-nudge */"))).toEqual([1]);
  });

  test("does not reach across an intervening rule", () => {
    // A comment excusing the rule above it must not drift down onto the next
    // one, or one annotation quietly licenses a whole file.
    const css = `
      /* @tug-optical-nudge: the ornament's ink sits low */
      .tug-separator-ornament { font-size: 0.75rem; transform: translateY(-0.05em); }
      .tool-call-header-name { font-weight: 600; position: relative; top: 1px; }
    `;
    expect(scan(css).map((h) => h.selector)).toEqual([".tool-call-header-name"]);
  });
});

describe("rule 2 — the line-box stanza, re-derived", () => {
  test("catches a hand-rolled stanza outside the primitive", () => {
    expect(
      rules(`
        .tool-call-header-detail {
          display: inline-flex;
          align-items: center;
          min-height: var(--tugx-toolheader-line);
        }
      `),
    ).toEqual([2]);
  });

  test("does NOT fire on the primitive's own file", () => {
    expect(
      rules(
        `.tug-line-box {
           display: inline-flex;
           align-items: center;
           min-height: var(--tugx-line-box);
         }`,
        "tug-line-box.css",
      ),
    ).toEqual([]);
  });

  test("does NOT fire on the sanctioned `block-size` form", () => {
    // `.tool-call-header .tug-option-group` is a descendant selector against
    // a foreign component's own class, so it cannot be given `.tug-line-box`
    // ([L20]). It sets the token and re-declares the stanza instead — and it
    // uses `block-size`, so a `min-height`-only matcher would never have had
    // to honour the exemption it is supposed to have.
    expect(
      rules(`
        .tool-call-header .tug-option-group {
          --tugx-line-box: var(--tugx-toolheader-line);
          display: inline-flex;
          align-items: center;
          block-size: var(--tugx-line-box);
          box-sizing: border-box;
        }
      `),
    ).toEqual([]);
  });

  test("ignores an inline-flex row that is not a line box", () => {
    expect(
      rules(`
        .tug-badge {
          display: inline-flex;
          align-items: center;
          min-height: 16px;
        }
      `),
    ).toEqual([]);
  });

  test("does NOT fire on a line-HEIGHT token", () => {
    // `.tug-list-row-check` — a fixed-height glyph column pinned with
    // `align-self: flex-start` so it sits on the title's first line rather
    // than floating between title and subtitle on a two-line row. It reads
    // `--tug-line-height-md`, and an unanchored token test matches that
    // mid-string and convicts a rule that re-derives nothing. The guard's
    // first run over the swept corpus is what surfaced this.
    expect(
      rules(`
        .tug-list-row-check {
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          align-self: flex-start;
          height: var(--tug-line-height-md);
        }
      `),
    ).toEqual([]);
  });

  test("ignores a centred row with no declared height", () => {
    expect(
      rules(`.tug-chip { display: inline-flex; align-items: center; gap: 4px; }`),
    ).toEqual([]);
  });
});

describe("rule 3 — a heavy track with nothing handing it back", () => {
  test("catches the instrument legend, which declares no `text-align`", () => {
    // The calibration case. Its centring is the flex container's, so a rule
    // keyed on `text-align: center` would never fire on the one declaration
    // the rule exists for.
    expect(
      rules(`
        .session-telemetry-endcap-label {
          font-size: 0.5625rem;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          padding: 0 4px;
        }
      `),
    ).toEqual([3]);
  });

  test("accepts a trailing negative margin as the compensation", () => {
    expect(
      rules(`
        .session-telemetry-endcap-label {
          --tugx-endcap-label-track: 0.18em;
          font-size: 0.5625rem;
          letter-spacing: var(--tugx-endcap-label-track);
          text-transform: uppercase;
          margin-inline-end: calc(-1 * var(--tugx-endcap-label-track));
        }
      `),
    ).toEqual([]);
  });

  test("does NOT accept a POSITIVE trailing margin as the compensation", () => {
    // A trailing gap read from a spacing token is the house idiom, and its
    // value is full of hyphens because custom-property names are. A
    // compensation test that only looked for a minus sign counted it, and
    // rule 3 then excused any tracked legend that happened to carry one.
    expect(
      rules(`
        .legend {
          font-size: 0.5625rem;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          margin-inline-end: var(--tug-space-xs);
        }
      `),
    ).toEqual([3]);
  });

  test("does NOT accept a block-axis margin as the compensation", () => {
    // The track is horizontal; a block-axis margin cannot hand it back.
    expect(
      rules(`
        .legend {
          font-size: 0.5625rem;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          margin-block: calc(-1 * 0.18em);
        }
      `),
    ).toEqual([3]);
  });

  test("accepts a bare negative trailing margin", () => {
    expect(
      rules(`
        .legend {
          font-size: 0.5625rem;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          margin-right: -0.18em;
        }
      `),
    ).toEqual([]);
  });

  test("accepts `@tug-track-uncompensated:` with a reason", () => {
    // The two left-aligned copies of the same legend: the trailing track
    // falls into slack and displaces nothing, which is a claim worth
    // recording rather than a correction worth making.
    expect(
      rules(`
        /* @tug-track-uncompensated: left-aligned in a column, so the track
           falls at the end of the line with nothing beyond it to displace */
        .session-activity-card-title {
          font-size: 0.5625rem;
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }
      `),
    ).toEqual([]);
  });

  test("ignores a light track, where half a track is a fifth of a pixel", () => {
    for (const track of ["0.04em", "0.06em", "0.08em", "0.12em"]) {
      expect(
        rules(`.tug-section-label {
           font-size: var(--tug-font-size-2xs);
           letter-spacing: ${track};
           text-transform: uppercase;
         }`),
      ).toEqual([]);
    }
  });

  test("ignores a heavy track that is not uppercase", () => {
    expect(
      rules(`.x { font-size: 11px; letter-spacing: 0.2em; }`),
    ).toEqual([]);
  });

  test("ignores a negative track", () => {
    // Tightening adds no trailing space to hand back.
    expect(
      rules(`.x { letter-spacing: -0.02em; text-transform: uppercase; font-size: 11px; }`),
    ).toEqual([]);
  });
});

describe("the report a hit carries", () => {
  test("names the file, the rule, the selector and the offending value", () => {
    const [hit] = scan(
      `\n\n.tool-call-header-name {\n  font-weight: 600;\n  top: 1px;\n}\n`,
      "tugdeck/src/components/tugways/blocks/block-header.css",
    );
    expect(hit.path).toBe("tugdeck/src/components/tugways/blocks/block-header.css");
    expect(hit.rule).toBe(1);
    expect(hit.selector).toBe(".tool-call-header-name");
    expect(hit.detail).toContain("top: 1px");
    // The line of the DECLARATION, not of the rule — a reader following the
    // report should land on the thing to delete.
    expect(hit.line).toBe(5);
  });
});

/**
 * at0490-atom-register-parity.test.ts — the live pill and the baked chip beside
 * it must be the same atom.
 *
 * ## The regression this pins
 *
 * An atom is drawn three ways, and for a long time each one derived its own box
 * from whatever host it landed in: the live CSS pill a session citation is took
 * the leading it was dropped into, and the two baked paths — the inline `<svg>`
 * and the Canvas → PNG the editor mounts — took `font-size × host line-height`.
 * The same session atom therefore stood 18px tall in the composer, 20px in the
 * transcript it was sent to, 21px cited in an Overview post, and 25px in the
 * Changes shade. Nothing could notice, because no two of those numbers were
 * written down in the same place and no surface showed two renderers together.
 *
 * `lib/atom-register.ts` is now the one place, and this is the check that it
 * stays the one place. Both renderers read it — the DOM path as published
 * custom properties, the pixel path as numbers — so a divergence can only come
 * back if someone re-authors a height somewhere, which is exactly what a
 * measurement can catch and a type cannot.
 *
 * ## Why a real app and not a unit test
 *
 * The pill's box is CSS: `block-size`, a border, a `line-height`, a flex
 * centring, all resolved against a cascade and a font. Nothing short of a
 * browser laying it out can say what it MEASURES, and the whole defect was that
 * a number in a stylesheet and a number in a module disagreed. So the assertion
 * is `getBoundingClientRect` on the real elements, in the real app.
 *
 * ## Shape
 *
 *   1. Open the atom gallery card, whose Registers section renders every atom
 *      kind at every register with the live session pill last in each row —
 *      the one surface where the two renderers stand side by side.
 *   2. For each register row, measure the baked `<svg>` chips and the pill.
 *   3. Require: every chip in a row is the register's declared height; the pill
 *      is that same height; and the two registers are not the same height as
 *      each other (or the table has collapsed and the test is vacuous).
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/atom-register.ts
 * @covers tugdeck/src/lib/tug-atom-chip.tsx
 * @covers tugdeck/src/lib/tug-atom-img.ts
 * @covers tugdeck/src/components/tugways/tug-session-identity.css
 * @covers tugdeck/src/components/tugways/tug-session-identity.tsx
 * @covers tugdeck/src/components/tugways/cards/gallery-atom.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-testid="gallery-atom"]';
const ROW = `${CARD} .gallery-atom-register`;

interface RegisterRow {
  register: string;
  /** What the table says, read back off the published custom property. */
  declaredHeight: number;
  /** Every baked `<svg>` chip's measured height, rounded. */
  chipHeights: number[];
  /** The live pill's measured height, rounded. */
  pillHeight: number | null;
  /** The pill's resolved type size, in px. */
  pillFontSize: number | null;
  /** The chips' baked type size, in px — the geometry's own answer. */
  chipFontSize: number | null;
}

/** Measure every register row the gallery drew. */
const ROWS_JS = `(function () {
  var rows = Array.from(document.querySelectorAll(${JSON.stringify(ROW)}));
  return rows.map(function (row) {
    var host = row.querySelector(".gallery-atom-row");
    var declared = getComputedStyle(host).getPropertyValue("--tugx-atom-height");
    var chips = Array.from(host.querySelectorAll("svg[data-atom-type]"));
    var pill = host.querySelector('[data-slot="tug-session-identity"]');
    return {
      register: row.getAttribute("data-register"),
      declaredHeight: parseFloat(declared),
      chipHeights: chips.map(function (c) {
        return Math.round(c.getBoundingClientRect().height);
      }),
      pillHeight: pill === null
        ? null
        : Math.round(pill.getBoundingClientRect().height),
      pillFontSize: pill === null
        ? null
        : parseFloat(getComputedStyle(pill).fontSize),
      chipFontSize: chips.length === 0
        ? null
        : parseFloat(chips[0].querySelector("text").getAttribute("font-size")),
    };
  });
})()`;

describe.skipIf(!SHOULD_RUN)("atom registers — one table, two renderers", () => {
  test(
    "the live pill measures the same box as the baked chips at every register",
    async () => {
      const app = await launchTugApp({ testName: "at0490-atom-register-parity" });
      try {
        await app.dispatchControlAction("show-card", { component: "gallery-atom" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(ROW)}).length >= 2`,
          { timeoutMs: 15_000 },
        );
        // The chips are `<svg>` with a `<text>` the browser must have measured
        // — a row read before the font settles reports a width but the wrong
        // one, and the height assertion below would pass vacuously.
        await app.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(ROW)} + " svg[data-atom-type]"))
             .every(function (c) { return c.getBoundingClientRect().height > 0; })`,
          { timeoutMs: 15_000 },
        );

        const rows = await app.evalJS<RegisterRow[]>(ROWS_JS);
        note(`at0490 registers: ${JSON.stringify(rows)}`);

        expect(rows.length).toBeGreaterThanOrEqual(2);

        for (const row of rows) {
          // The baked chips are the register's box, exactly. This is the
          // renderer that reads the table as numbers.
          for (const height of row.chipHeights) {
            expect(height).toBe(row.declaredHeight);
          }
          // And the live pill — the renderer that reads the table as CSS — is
          // the same box. This is the whole assertion: two renderers, one
          // height, on one surface, measured rather than asserted.
          expect(row.pillHeight).toBe(row.declaredHeight);
          // Type size travels with the box or the marks read as two families
          // however well their boxes agree.
          expect(row.pillFontSize).toBe(row.chipFontSize);
        }

        // A table whose registers had collapsed to one number would pass every
        // check above and prove nothing, so the difference is pinned too.
        const heights = rows.map((r) => r.declaredHeight);
        expect(new Set(heights).size).toBe(rows.length);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

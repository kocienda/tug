/**
 * at0625-type-baseline-glyph.test.ts — the inline glyph rides one declared
 * token, and its host row keeps one baseline.
 *
 * One of the at0625-type-baseline split, a test to a file so each launch
 * fits its own budget. Why the header is measured this way, the mounts, the
 * readers and the before-figures are `type-baseline-fixture.ts`.
 *
 * @covers tugdeck/src/components/tugways/blocks/block-header.css
 * @covers tugdeck/src/components/tugways/blocks/block-header.tsx
 * @covers tugdeck/src/components/tugways/blocks/block-strip.tsx
 * @covers tugdeck/styles/tug-line-box.css
 * @covers tugdeck/src/components/tugways/cards/blocks/skill-tool-block.tsx
 * @covers tugdeck/src/components/tugways/blocks/block-chrome.css
 * @covers tugdeck/src/components/tugways/cards/blocks/bash-tool-block.tsx
 * @covers tugdeck/src/components/tugways/cards/blocks/task-tool-block.css
 * @covers tugdeck/src/components/tugways/tug-quiet-line.css
 * @covers tugdeck/src/components/tugways/cards/session-telemetry-cell.css
 * @covers tugdeck/src/components/tugways/tug-atom-ref.css
 * @covers tugdeck/src/components/tugways/tug-separator.css
 * @family at0625-type-baseline
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import {
  CARD,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  blockHeader,
  mountCensusSurfaces,
  offSizeNote,
  readRow,
  spreadAtRowSize,
  summarize,
} from "./type-baseline-fixture";

describe.skipIf(!SHOULD_RUN)("AT0624: the tool-call header's type baseline", () => {
  // --- rule (iv): the inline glyph ------------------------------------
  // A length `vertical-align` on an inline glyph is the one correction the
  // law sanctions, and only through one declared token. Two things have to
  // hold, and neither is visible in a spread alone: the token must actually
  // resolve — a misspelled custom property makes `vertical-align` invalid
  // and silently falls back to `baseline`, which looks like a working
  // stylesheet and is a dropped glyph — and the offset must not disturb the
  // baseline of the text it sits beside, which is what a length
  // `vertical-align` can do by growing the line box.
  test(
    "the inline glyph rides one declared token, and its host row keeps one baseline",
    async () => {
      const app = await launchTugApp({ testName: "at0625-type-baseline-glyph" });
      try {
        await mountCensusSurfaces(app);

        const ICON = `${CARD} [data-tool-use-id="tc-read"] .tug-atom-ref-icon`;
        const glyph = JSON.parse(
          await app.body("A").evalJS<string>(`JSON.stringify((function(){
            var el = document.querySelector(${JSON.stringify(ICON)});
            if (el === null) return { found: false };
            var root = getComputedStyle(document.documentElement);
            return {
              found: true,
              verticalAlign: getComputedStyle(el).verticalAlign,
              token: root.getPropertyValue("--tug-glyph-cap-offset").trim(),
            };
          })())`),
        ) as { found: boolean; verticalAlign?: string; token?: string };
        note(
          `at0625 glyph offset: --tug-glyph-cap-offset = "${glyph.token ?? ""}", ` +
            `computed vertical-align = "${glyph.verticalAlign ?? ""}"`,
        );

        expect(
          glyph.found,
          "the Read header renders its file ref as an atom ref",
        ).toBe(true);
        // The token is read back through `getPropertyValue`, which returns the
        // browser's normalised text — `-.15em` for the `-0.15em` the stylesheet
        // writes — so the assertion is on the number, not on the spelling.
        expect(
          parseFloat(glyph.token ?? ""),
          "the token is declared in :root at the adopted calibration",
        ).toBeCloseTo(-0.15, 5);
        // Then the RESOLVED value, which is the thing that matters: an
        // unresolved `var()` makes `vertical-align` invalid and it silently
        // falls back to `baseline`. That reads as a working stylesheet and is
        // a dropped glyph, so the used length is what gets asserted — 13px of
        // host type times −0.15.
        expect(
          glyph.verticalAlign,
          "the token resolved — an unresolved var() computes to `baseline`",
        ).not.toBe("baseline");
        expect(
          parseFloat(glyph.verticalAlign ?? ""),
          "the used offset is the token applied to the row's own type size",
        ).toBeCloseTo(-1.95, 2);

        // And the row it sits in still agrees with itself.
        const row = await readRow(app, blockHeader("tc-read"));
        note(summarize("at0625 glyph host row", row));
        expect(row.found, row.why ?? "").toBe(true);
        const atSize = spreadAtRowSize(row.runs ?? []);
        note(offSizeNote("at0625 glyph host row by size", atSize));
        expect(
          atSize.spread,
          "the glyph's offset does not move the text beside it off the line",
        ).toBeLessThanOrEqual(0.5);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0625] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

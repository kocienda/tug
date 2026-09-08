/**
 * The glyph a mark wears, per tone.
 *
 * The lifecycle line stops painting an arc's trouble as a sentence it cannot
 * shrink and paints a fixed-width mark instead, so what the mark *says* is
 * this one table — and a table is a table test rather than a DOM one.
 *
 * The claims:
 *
 *   - the two alerting tones are told apart: a conflict somebody has to
 *     resolve is a circle, a warning is a triangle;
 *   - every quieter tone is a receipt rather than an interruption, so the
 *     verified fit and the muted tone alike take the check;
 *   - the mapping is total over `ArcMetaTone`, because the slot is occupied
 *     whenever `arcMetaFacts` returns anything at all and a tone with no
 *     glyph would draw nothing where the reading is.
 */

import { describe, test, expect } from "bun:test";

import { arcMetaGlyph } from "@/lib/arc-meta-facts";
import type { ArcMetaGlyph, ArcMetaTone } from "@/lib/arc-meta-facts";

const ALL_TONES: ArcMetaTone[] = ["danger", "caution", "muted", "subtle"];

describe("arcMetaGlyph", () => {
  test("the alerting tones take their own glyphs", () => {
    expect(arcMetaGlyph("danger")).toBe("circle-alert");
    expect(arcMetaGlyph("caution")).toBe("triangle-alert");
  });

  test("everything quieter than a warning is a receipt", () => {
    expect(arcMetaGlyph("muted")).toBe("circle-check");
    expect(arcMetaGlyph("subtle")).toBe("circle-check");
  });

  test("every tone has a glyph", () => {
    const glyphs: ArcMetaGlyph[] = ["circle-alert", "triangle-alert", "circle-check"];
    for (const tone of ALL_TONES) {
      expect(glyphs).toContain(arcMetaGlyph(tone));
    }
  });
});

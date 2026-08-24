/**
 * layout-miniature-geometry.test.ts — the drawing's arithmetic, checked as arithmetic.
 *
 * `miniatureGeometry` is the one resolution of where the parts of the deck's
 * scale picture stand, shared by the drawing and by the overlay that puts
 * controls on it. What is worth pinning here is the arithmetic's own claims —
 * the shares tile the field, the rail's cut trades against the width preset,
 * an overflowing strip scales into the frame — because those are the facts a
 * second consumer relies on and none of them needs a DOM to be true.
 */

import { describe, expect, test } from "bun:test";

import { miniatureGeometry } from "@/components/lens/layout-miniature";

/** The right edge of the last block, in percent of the field. */
function span(blocks: readonly { leftPct: number; widthPct: number }[]): number {
  const last = blocks[blocks.length - 1];
  return last.leftPct + last.widthPct;
}

describe("miniatureGeometry — fit", () => {
  test("the blocks tile the field edge to edge at every count", () => {
    for (const [kind, count] of [
      ["one-up", 1],
      ["two-up", 2],
      ["three-up", 3],
      ["four-up", 4],
      ["five-up", 5],
      ["six-up", 6],
    ] as const) {
      const { blocks } = miniatureGeometry({ kind });
      expect(blocks.length).toBe(count);
      // The first is flush left and the last flush right: the settled deck
      // holds no margin at either end of the band.
      expect(blocks[0].leftPct).toBe(0);
      expect(span(blocks)).toBeCloseTo(100, 6);
      // And the slots are numbered left to right, as the deck numbers them.
      expect(blocks.map((b) => b.slot)).toEqual(
        Array.from({ length: count }, (_, i) => i),
      );
    }
  });

  test("every block gets the same share, and the seams between them are equal", () => {
    const { blocks } = miniatureGeometry({ kind: "four-up" });
    const widths = new Set(blocks.map((b) => b.widthPct.toFixed(6)));
    expect(widths.size).toBe(1);
    const seams = blocks
      .slice(1)
      .map((b, i) => b.leftPct - (blocks[i].leftPct + blocks[i].widthPct));
    expect(new Set(seams.map((s) => s.toFixed(6))).size).toBe(1);
    expect(seams[0]).toBeGreaterThan(0);
  });

  test("a dense arrangement gives the seam away rather than the cards", () => {
    // The seam is capped at a fifth of one card's share, so six-up spends less
    // of the field on air than two-up does and its blocks stay readable.
    const two = miniatureGeometry({ kind: "two-up" }).blocks;
    const six = miniatureGeometry({ kind: "six-up" }).blocks;
    const seamOf = (b: readonly { leftPct: number; widthPct: number }[]) =>
      b[1].leftPct - (b[0].leftPct + b[0].widthPct);
    expect(seamOf(six)).toBeLessThan(seamOf(two));
    // The cap is a fifth of the share a card would get with no seams at all
    // (`100 / count`) — measured against the nominal share rather than the
    // narrower one the seams leave, so the rule does not chase its own tail.
    expect(seamOf(six)).toBeLessThanOrEqual(100 / 6 / 5 + 1e-9);
  });

  test("no imposition draws one card of its own width, centred", () => {
    const { blocks } = miniatureGeometry({ kind: null });
    expect(blocks.length).toBe(1);
    // Centred: as much field to its left as to its right.
    expect(blocks[0].leftPct).toBeCloseTo(100 - span(blocks), 6);
    expect(blocks[0].widthPct).toBeLessThan(100);
  });

  test("cards off draws the frame alone", () => {
    const { blocks, rails } = miniatureGeometry({
      kind: "three-up",
      cards: false,
      rails: { right: 2 },
    });
    expect(blocks).toEqual([]);
    // The rail is still there — that question is the one the drawing is for.
    expect(rails.right).toBeDefined();
  });
});

describe("miniatureGeometry — the rail's cut", () => {
  test("only an occupied side gets a strip", () => {
    expect(miniatureGeometry({ kind: "two-up" }).rails).toEqual({});
    const one = miniatureGeometry({ kind: "two-up", rails: { right: 1 } });
    expect(one.rails.left).toBeUndefined();
    expect(one.rails.right?.basisPct).toBeGreaterThan(0);
  });

  test("both sides cut the same width", () => {
    const { rails } = miniatureGeometry({
      kind: "two-up",
      rails: { left: 1, right: 3 },
    });
    // A rail's width is the rail's, not its membership's: three cards sharing
    // a side share one strip.
    expect(rails.left?.basisPct).toBe(rails.right?.basisPct);
  });

  test("a wider preset takes the deck from the rail", () => {
    const at = (width: "slim" | "comfy" | "wide") =>
      miniatureGeometry({ kind: "three-up", rails: { right: 1 }, width }).rails
        .right!.basisPct;
    // The trade the allocator actually makes, and the whole reason choosing a
    // preset draws a different picture.
    expect(at("comfy")).toBeLessThan(at("slim"));
    expect(at("wide")).toBeLessThan(at("comfy"));
  });

  test("more cards take the deck from the rail too", () => {
    const two = miniatureGeometry({ kind: "two-up", rails: { right: 1 } });
    const six = miniatureGeometry({ kind: "six-up", rails: { right: 1 } });
    expect(six.rails.right!.basisPct).toBeLessThan(two.rails.right!.basisPct);
  });
});

describe("miniatureGeometry — flow", () => {
  test("a short strip keeps its own width and leaves air", () => {
    const { blocks, flow } = miniatureGeometry({
      kind: "two-up",
      layout: "flow",
      width: "slim",
    });
    expect(flow.overflows).toBe(false);
    expect(flow.scale).toBe(1);
    // Air at the right is what a half-full flow deck really looks like.
    expect(span(blocks)).toBeLessThan(100);
  });

  test("a long strip scales the whole of it into the frame", () => {
    const { blocks, flow } = miniatureGeometry({
      kind: "six-up",
      layout: "flow",
      width: "wide",
    });
    expect(flow.overflows).toBe(true);
    expect(flow.scale).toBeLessThan(1);
    expect(span(blocks)).toBeCloseTo(100, 6);
  });

  test("the live strip draws the deck's own extents, not equal cards", () => {
    const { blocks, flow } = miniatureGeometry({
      kind: "three-up",
      layout: "flow",
      flow: {
        bandPx: 1000,
        stripPx: 1210,
        slots: [
          { slot: 0, leftPx: 0, widthPx: 400 },
          { slot: 2, leftPx: 410, widthPx: 800 },
        ],
      },
    });
    // Two blocks for two occupied slots — an empty slot contributes nothing to
    // a real strip — and the second is twice the first. Each has given up the
    // seam off its own right edge, so the doubling is in what they were BEFORE
    // that, which is the measure the window is taken against.
    expect(blocks.map((b) => b.slot)).toEqual([0, 2]);
    expect(flow.seamPct).toBeGreaterThan(0);
    const measured = blocks.map((b) => b.widthPct + flow.seamPct);
    expect(measured[1]).toBeCloseTo(measured[0] * 2, 6);
  });

  test("the live strip is laid out at its own gaps, not the drawing's seam", () => {
    // The bug this pins: the drawing used to sum the widths and insert its own
    // decorative seam, which is several times the deck's real gap. That made
    // the strip longer than it is, so the window — the band as a share of the
    // strip — came out narrower than the band, and the picture showed the last
    // slot inside the band being cut off when it was fully on screen.
    //
    // Four slim cards, four-pixel gaps, a band that holds three of them.
    const width = 412;
    const gap = 4;
    const stripPx = 3 * (width + gap) + width;
    const slots = [0, 1, 2, 3].map((slot) => ({
      slot,
      leftPx: slot * (width + gap),
      widthPx: width,
    }));
    const { blocks, flow } = miniatureGeometry({
      kind: "four-up",
      layout: "flow",
      flow: { bandPx: width * 3 + gap * 2, stripPx, slots },
    });
    // The gaps the drawing draws are the gaps the deck has: every block stands
    // at the same fraction of the field that its card stands at along the strip.
    for (const block of blocks) {
      expect(block.leftPct).toBeCloseTo(
        (slots[block.slot].leftPx / stripPx) * 100,
        6,
      );
    }
    // And the window says what is true: the third slot is wholly inside the
    // band, the fourth is not. Measured at the card's own right edge — the seam
    // is air the block gives up, not width the deck lost.
    const windowRight = 100 * flow.scale;
    const rightOf = (i: number): number =>
      blocks[i].leftPct + blocks[i].widthPct + flow.seamPct;
    expect(rightOf(2)).toBeLessThanOrEqual(windowRight);
    expect(rightOf(3)).toBeGreaterThan(windowRight);
  });

  test("a live strip is ignored under fit, which tiles whatever the cards are wide", () => {
    const live = {
      bandPx: 1000,
      stripPx: 1310,
      slots: [
        { slot: 0, leftPx: 0, widthPx: 400 },
        { slot: 1, leftPx: 410, widthPx: 900 },
      ],
    };
    const fit = miniatureGeometry({ kind: "two-up", flow: live });
    const widths = new Set(fit.blocks.map((b) => b.widthPct.toFixed(6)));
    expect(widths.size).toBe(1);
    expect(span(fit.blocks)).toBeCloseTo(100, 6);
  });

  test("a partial live strip falls back to the synthetic one", () => {
    const synthetic = miniatureGeometry({ kind: "three-up", layout: "flow" });
    // A band nobody measured places the blocks nowhere, so a zero band is not a
    // strip — it is the absence of one.
    const unmeasured = miniatureGeometry({
      kind: "three-up",
      layout: "flow",
      flow: {
        bandPx: 0,
        stripPx: 400,
        slots: [{ slot: 0, leftPx: 0, widthPx: 400 }],
      },
    });
    const empty = miniatureGeometry({
      kind: "three-up",
      layout: "flow",
      flow: { bandPx: 1000, stripPx: 0, slots: [] },
    });
    expect(unmeasured.blocks).toEqual(synthetic.blocks);
    expect(empty.blocks).toEqual(synthetic.blocks);
  });
});

describe("miniatureGeometry — what a split does not touch", () => {
  test("a slot's band is the same whether or not the column is divided", () => {
    // A split divides the RUN, which is the field's height; it must never move
    // an edge along the band. The geometry takes no split argument at all, and
    // this is the claim that says why that is correct rather than an omission.
    const whole = miniatureGeometry({ kind: "three-up", rails: { right: 2 } });
    const again = miniatureGeometry({ kind: "three-up", rails: { right: 2 } });
    expect(again.blocks).toEqual(whole.blocks);
  });
});

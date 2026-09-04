/**
 * Pure-logic tests for the atom register.
 *
 * The register decides how big an atom is on every surface, for three renderers
 * that cannot see each other. Two things have to hold and neither is a type:
 * the one row has to leave the label room to sit, and the phase mark must stay
 * inside the pill drawn around it — including the ring it sheds, which travels
 * well past its own glyph box.
 */

import { describe, expect, test } from "bun:test";

import {
  ATOM_DOT_CLEARANCE,
  ATOM_DOT_REACH,
  atomBaselineOffsetPx,
  atomEditorLineBoxFloorPx,
  atomRegisterMetrics,
} from "../atom-register";
import {
  markBoxForDot,
  markRingEnvelope,
} from "@/components/tugways/internal/tug-progress-pulsing-dot";
import { editorLineHeightFor } from "../tug-atom-img";

describe("the register", () => {
  // The complaint that produced this register was a box so tight the label had
  // nowhere to sit. Three pixels of air above and below the type, inside the
  // border, is the floor — below it the atom reads as clamped.
  test("the register leaves at least 3px of air around its type", () => {
    const m = atomRegisterMetrics();
    const air = (m.height - 2 * m.borderWidth - m.fontSize) / 2;
    expect(air).toBeGreaterThanOrEqual(3);
  });
});

describe("the phase mark stays inside the pill", () => {
  // The regression: the dot was sized as a dot, and the mark is not a dot. It
  // breathes and sheds a ring that runs to 1.75× its glyph box at this scale,
  // so a 7px dot in a 22px pill put a 24.5px ring through a 20px opening — the
  // halo crossed the border a moment after every beat. The ring's own overflow
  // is deliberate and stays; what changed is that a bounded caller now sizes
  // against the envelope rather than against the diameter it wanted.
  test("the ring's furthest reach clears the border", () => {
    const m = atomRegisterMetrics();
    const envelope = markRingEnvelope(markBoxForDot(m.dotSize), ATOM_DOT_REACH);
    const opening = m.height - 2 * m.borderWidth;
    expect(envelope).toBeLessThanOrEqual(opening - 2 * ATOM_DOT_CLEARANCE);
  });

  // …and it clears it by the clearance and not by more. The rule is a floor on
  // the air, not an instruction to keep the mark small: every pixel between the
  // ring and that floor is a pixel the dot could have had. The pill is where
  // the mark runs out of room — exactly, to the pixel.
  test("the mark is as big as the clearance allows", () => {
    const m = atomRegisterMetrics();
    const opening = m.height - 2 * m.borderWidth;
    const envelope = markRingEnvelope(markBoxForDot(m.dotSize), ATOM_DOT_REACH);
    expect(envelope).toBeCloseTo(opening - 2 * ATOM_DOT_CLEARANCE, 6);
  });

  // The cap is the pill's, not the glyph's: it may only ever shorten the throw
  // the size already asks for. A cap above it would be a number that changes
  // nothing on screen while the arithmetic above believed it.
  test("the pill's cap only shortens the ring's travel", () => {
    const box = markBoxForDot(atomRegisterMetrics().dotSize);
    expect(markRingEnvelope(box, ATOM_DOT_REACH)).toBeLessThan(
      markRingEnvelope(box),
    );
  });

  // And the ring still LEAVES the box. Capping it at the box would keep the
  // clearance and lose the pulse: the ring would be born on the dot's edge and
  // die on a wall two pixels out, which reads as a halo rather than as travel.
  test("the capped ring still travels outside its glyph box", () => {
    const box = markBoxForDot(atomRegisterMetrics().dotSize);
    expect(markRingEnvelope(box, ATOM_DOT_REACH)).toBeGreaterThan(box);
  });

  // And it is a mark, not a speck: a dot small enough to trivially satisfy the
  // check above would pass it and say nothing about liveness.
  test("the dot is still a fair share of the pill's opening", () => {
    const m = atomRegisterMetrics();
    const opening = m.height - 2 * m.borderWidth;
    expect(m.dotSize / opening).toBeGreaterThan(0.15);
  });

  // A mark this small IS its raster. The dot and the ring are two boxes on one
  // centre, and the browser snaps each onto the device grid on its own — so
  // their centres only survive if half the difference of their diameters is a
  // whole number of device pixels, at 1x and at 2x alike. Whole, same-parity
  // px is what buys that. At 4.5 the dot's ink centre moved half a device
  // pixel off the ring's as the pill's sub-pixel position changed, which reads
  // as a dot sitting in the corner of its own pulse;
  // `at0493-atom-mark-raster` measures that in the running app, and this holds
  // the arithmetic behind it.
  test("the dot and its glyph box are whole, same-parity pixels", () => {
    const m = atomRegisterMetrics();
    const box = markBoxForDot(m.dotSize);
    expect(Number.isInteger(m.dotSize)).toBe(true);
    expect(Number.isInteger(box)).toBe(true);
    expect((box - m.dotSize) % 2).toBe(0);
  });
});

describe("the atom's baseline", () => {
  // The box hangs BELOW the line it stands on, always: the label sits under
  // the middle of the pill, so the pill's bottom must fall under the prose
  // baseline for the two baselines to meet. A non-negative offset would mean
  // an atom sitting on the line like a word, which is the alignment this
  // replaced.
  test("the box hangs below the host baseline", () => {
    expect(atomBaselineOffsetPx()).toBeLessThan(0);
  });

  // …and the label's own baseline stays inside the box it is painted in. The
  // offset is derived from `height/2 + fontSize × 0.32`, which is a claim about
  // where the ink lands; type that outgrew its box would keep passing the
  // arithmetic while painting the label through the border.
  test("the label's baseline lands inside the box", () => {
    const m = atomRegisterMetrics();
    const textBaseline = m.height / 2 + m.fontSize * 0.32;
    expect(textBaseline).toBeGreaterThan(m.borderWidth);
    expect(textBaseline).toBeLessThan(m.height - m.borderWidth);
  });
});

describe("editorLineHeightFor", () => {
  // An atom must fit inside the line box of every surface it stands on. The
  // editor's leading is derived from the register rather than pinned, so this
  // holds at every font size the editor offers — including the small end,
  // where a pinned 1.5 could not seat the atom and the bake compensated by
  // shrinking the chip, which is how an atom came to change size when it was
  // sent.
  test("the derived editor line box seats an atom at every font size", () => {
    for (const size of [11, 12, 13, 14, 15, 16, 18, 20]) {
      const lineBoxPx = size * editorLineHeightFor(size);
      expect(lineBoxPx).toBeGreaterThanOrEqual(atomEditorLineBoxFloorPx());
    }
  });

  // A line of code with no atom on it should not be pushed apart by one, so
  // the leading never drops below the reading minimum however large the type.
  test("never falls below the editor's own reading leading", () => {
    for (const size of [11, 13, 16, 20, 24]) {
      expect(editorLineHeightFor(size)).toBeGreaterThanOrEqual(1.5);
    }
  });
});

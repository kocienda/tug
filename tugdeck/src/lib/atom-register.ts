/**
 * atom-register.ts — how big an atom is, decided once, for every renderer.
 *
 * An atom is drawn four ways: the live CSS pill (`tug-session-identity.css`'s
 * chip tier), the inline `<svg>` chip ({@link TugAtomChip}), the Canvas → PNG
 * bake the editor's CM6 widget mounts, and the read-only ref that draws no box
 * at all. The first three each used to derive their own box from whatever host
 * they landed in — a CSS line-height for the pill, `size × line-height` for the
 * two baked paths — so one session atom stood 18px tall in the composer, 20px
 * in the transcript it was sent to, 21px cited in an Overview post, and 25px in
 * the Changes shade. Four boxes, one mark, and nothing that could notice.
 *
 * **A register is what a surface IS, not how big it wants its atoms.** That is
 * the whole of why this replaced a `sm` / `2xs` size prop: a size is a value a
 * call site invents and no reviewer can check, while a register is a fact about
 * the surface that either matches the surface or does not. `prose` is an atom
 * standing in a line of running text — a transcript row, a composer line, a
 * list row's hint, a rail's ink — where the line box must hold the atom rather
 * than the atom shrink to fit the line. `reading` is an atom in a block at
 * reading scale, where there is no line to disturb and the mark can breathe.
 *
 * **The two registers differ in one number.** Type size, dot, inline padding,
 * corner radius and border are identical, because a citation in the transcript
 * and a citation in the Changes shade are the same mark seen at two densities —
 * not two marks. Only {@link AtomRegisterMetrics.height} moves, and it moves by
 * two pixels.
 *
 * **Both renderers read this table, in the units each of them speaks.** The DOM
 * paths take {@link atomRegisterVars} — custom properties a host publishes,
 * which is what lets a CSS pill be sized by the same numbers a Canvas bake
 * measures with; the pixel paths take {@link atomRegisterMetrics} directly.
 * There is no third place a number can be authored, which is the property that
 * was missing.
 *
 * The surface constants a chip's *shape* is made of — corner radius, inline
 * padding, icon gap, the session pill's own variants of those — stay in
 * `command-atom.ts` beside the color tokens they ship with. This module owns
 * the vertical: how tall the box is and how big the type inside it is.
 *
 * Laws: [L06] appearance travels as CSS custom properties and pixel geometry,
 *       never React state; [L20] the vars are published by the host at the
 *       point of use with fallbacks, so a surface that publishes nothing still
 *       renders a whole atom.
 *
 * @module lib/atom-register
 */

/**
 * Which kind of surface an atom is standing on.
 *
 * - `prose` — inline in a line of running text. The host's line box is floored
 *   to hold the atom ({@link atomLineBoxFloorPx}), so the atom never changes
 *   the leading of the lines around it by being present.
 * - `reading` — in a block at reading scale, with no line box to disturb.
 */
export type AtomRegister = "prose" | "reading";

/** The vertical metrics a register decides. */
export interface AtomRegisterMetrics {
  /** Label type size, in px. The same at every register. */
  fontSize: number;
  /** The atom's whole box height, borders included, in px. */
  height: number;
  /**
   * The resting painted diameter of the session atom's phase dot, in px.
   *
   * Painted, not boxed: the live dot is a ring glyph that paints at half its
   * declared box and lets the ring overhang, while the bake paints a plain
   * circle. Publishing the painted size is what lets the two agree — before
   * this the live pill's dot painted at 6px beside a bake's at 7.8px.
   *
   * **It is bounded by the pill, not chosen for the dot.** The live mark
   * breathes and sheds a ring that travels well past its own glyph box, and
   * that overflow is free only where nothing encloses the mark. Inside a pill
   * it is not free: sized for the dot alone, the ring crossed the border a
   * moment later. So the ceiling is {@link ATOM_DOT_CLEARANCE} inside the
   * pill's inner height, and the diameter is what fits under it — which is why
   * this is a smaller number than the mark's rest diameter would suggest.
   * `atom-register.test` holds the containment.
   *
   * **And it is a WHOLE, EVEN number of pixels, which is not a rounding of the
   * number that fits — it is the number.** A mark this small is its raster: the
   * dot and the ring are two boxes centred on one point, and the browser snaps
   * each of them onto the device grid on its own. Their centres only survive
   * that if the offset between the boxes — half the difference of their
   * diameters — is a whole number of device pixels, which needs both diameters
   * whole and of the same parity. At 4.5 it was neither: the dot's box began on
   * a half device pixel, so a pill landing on a fractional layout position
   * (an ordinary Overview row does) painted the dot half a pixel off the ring
   * it sits in, and shed a pixel of its own width doing it. Measured, not
   * reasoned: at 4.5 the dot's ink centre moved ±0.5 device px as the host's
   * sub-pixel offset changed while the ring's never moved at all.
   */
  dotSize: number;
  /** The pill's border, in px. Part of {@link height}. */
  borderWidth: number;
}

/**
 * The table.
 *
 * The numbers are the settled ones, not derived at runtime: an atom's box is a
 * design decision about how much air sits around 13px of type, and a formula
 * over some host's line-height is exactly the indirection that let four
 * surfaces disagree. 13px is the app's `sm` type size — the size the Changes
 * shade, the Overview and every list hint already drew their atoms at, and one
 * step under the transcript's 14px prose, which is what makes a chip read as an
 * object in the sentence rather than as a word of it.
 *
 * 22px around 13px type leaves ~3.5px of air above and below the label inside
 * the border — the proportion the Overview's citation already had and that the
 * transcript's did not.
 *
 * The dot is one number for both registers, and it is the number the SMALLER
 * pill can hold: a mark that fit `reading` and crossed `prose`'s border would
 * be the same defect at one remove.
 *
 * 6px is a 12px glyph box, and it is the LARGEST the rule allows. The steps
 * are 2px wide, not 1px — the raster rule below wants the dot and its box the
 * same parity, and the box is twice the dot at this scale, so only an even dot
 * survives it. 4px left two pixels of the opening unused and read as a speck
 * in the pill; 8px would need a 16px box, which has no runway left to let a
 * ring out of at all. What 6px does need is {@link ATOM_DOT_REACH} — at the
 * automatic reach a 12px box throws its ring to 21px, straight through a 20px
 * opening — and under that cap the mark paints to exactly the clearance the
 * rule asks for and no further.
 */
export const ATOM_REGISTERS: Readonly<Record<AtomRegister, AtomRegisterMetrics>> = {
  prose: { fontSize: 13, height: 22, dotSize: 6, borderWidth: 1 },
  reading: { fontSize: 13, height: 24, dotSize: 6, borderWidth: 1 },
};

/**
 * Px of air between the furthest the phase mark ever paints and the inside of
 * the pill's border.
 *
 * Not zero: the requirement is not that the ring fit but that it read as a mark
 * standing inside an enclosure. A ring that stops exactly on the border reads
 * as touching it, and a mark touching its own pill reads as an error in the
 * pill rather than as liveness.
 */
export const ATOM_DOT_CLEARANCE = 2;

/**
 * How far the phase mark's ring travels inside a pill, as a multiple of its
 * glyph box — the pill's cap on the mark's own {@link markRingEnvelope}.
 *
 * **The enclosure caps the pulse; the glyph does not shrink to fit.** Left to
 * itself the mark throws its ring to 1.75× its box at this scale, which is the
 * reason it reads at all in a row of type — and which nothing bounds when the
 * atom is drawn without a pill (the `line` tier publishes no cap and keeps the
 * full throw). Inside the pill the wall is 10px from the centre, so the choice
 * is a big dot with a shorter pulse or a small dot with a long one. The dot is
 * the reading — it carries the phase colour and it is what a glance lands on —
 * so the dot takes the pixels and the ring takes the cap.
 *
 * 4/3 is not a taste: it is `(prose opening − 2 × clearance) ÷ box`, the
 * largest throw a 12px box can make and still leave
 * {@link ATOM_DOT_CLEARANCE} inside a 22px pill. The ring still leaves the
 * box — it ends 2px outside it, which is what keeps the pulse a pulse rather
 * than a halo pinned to the dot's own edge. `atom-register.test` holds the
 * arithmetic and `at0493-atom-mark-raster` holds the pixels.
 */
export const ATOM_DOT_REACH = 4 / 3;

/** The default register — an atom with nothing said about it is in prose. */
export const DEFAULT_ATOM_REGISTER: AtomRegister = "prose";

/** The metrics for a register. */
export function atomRegisterMetrics(
  register: AtomRegister = DEFAULT_ATOM_REGISTER,
): AtomRegisterMetrics {
  return ATOM_REGISTERS[register];
}

/**
 * Px a host must floor its line box to so an atom in it never moves the
 * leading of the lines around it.
 *
 * Two floors, because the two prose surfaces clip differently. A transcript
 * body clips at its box, and a baseline-aligned atom's box reaches above the
 * prose cap line — on a message's first line there is no line above to overflow
 * into, so the room for that overhang has to be inside the line
 * ({@link ATOM_LINE_BOX_CUSHION}). An editor line does not clip; what it needs
 * is only that two atoms on adjacent wrapped rows of one long line keep air
 * between them, which is a single pixel.
 */
export function atomLineBoxFloorPx(
  register: AtomRegister = DEFAULT_ATOM_REGISTER,
): number {
  return atomRegisterMetrics(register).height + ATOM_LINE_BOX_CUSHION;
}

/** The editor's floor — see {@link atomLineBoxFloorPx}. */
export function atomEditorLineBoxFloorPx(
  register: AtomRegister = DEFAULT_ATOM_REGISTER,
): number {
  return atomRegisterMetrics(register).height + ATOM_ROW_SLACK;
}

/** The room a baseline-aligned atom's overhang needs above the cap line. */
const ATOM_LINE_BOX_CUSHION = 4;

/** Air between atoms on adjacent wrapped rows of one editor line. */
const ATOM_ROW_SLACK = 1;

/**
 * The register as custom properties, for a host to publish on the element its
 * atoms live inside.
 *
 * The CSS pill reads these; so does the transcript's line-height floor. Every
 * use site pairs them with a fallback ([L20]), so an atom mounted on a surface
 * that publishes nothing is still a whole atom at the default register.
 */
export function atomRegisterVars(
  register: AtomRegister = DEFAULT_ATOM_REGISTER,
): Record<string, string> {
  const m = atomRegisterMetrics(register);
  return {
    "--tugx-atom-font-size": `${m.fontSize}px`,
    "--tugx-atom-height": `${m.height}px`,
    "--tugx-atom-dot-size": `${m.dotSize}px`,
    "--tugx-atom-border-width": `${m.borderWidth}px`,
    "--tugx-atom-line-box-floor": `${atomLineBoxFloorPx(register)}px`,
  };
}

/**
 * The cap the PILL publishes on the mark inside it — {@link ATOM_DOT_REACH} in
 * the pulsing dot's own variable.
 *
 * Separate from {@link atomRegisterVars} on purpose, and mounted only by the
 * chip tier. The register vars are published by whole hosts — a transcript
 * body, an editor line — and this one is not a fact about a surface's density
 * but about a single enclosure two pixels from the mark. Published up there it
 * would inherit down onto every other pulsing dot on the surface and quietly
 * shorten pulses that nothing was bounding.
 */
export function atomPillMarkVars(): Record<string, string> {
  return { "--tugx-progress-pulsing-dot-emit-reach": `${ATOM_DOT_REACH}` };
}

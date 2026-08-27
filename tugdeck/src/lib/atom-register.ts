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
   * The painted diameter of the session atom's phase dot, in px.
   *
   * Painted, not boxed: the live dot is a ring glyph that paints at half its
   * declared box and lets the ring overhang, while the bake paints a plain
   * circle. Publishing the painted size is what lets the two agree — before
   * this the live pill's dot painted at 6px beside a bake's at 7.8px.
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
 */
export const ATOM_REGISTERS: Readonly<Record<AtomRegister, AtomRegisterMetrics>> = {
  prose: { fontSize: 13, height: 22, dotSize: 7, borderWidth: 1 },
  reading: { fontSize: 13, height: 24, dotSize: 7, borderWidth: 1 },
};

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

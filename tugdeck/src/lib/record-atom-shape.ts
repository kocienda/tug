/**
 * record-atom-shape.ts — what an arc atom's and a sketch atom's `type` and
 * `value` are made of.
 *
 * A leaf, as `session-atom-shape.ts` is: no imports, so the chip renderers,
 * the clipboard writers, the wire markers and the transcript walkers read the
 * same rules without importing each other.
 *
 * | Kind   | `value`                  | `label`        | `text/plain`    |
 * |--------|--------------------------|----------------|-----------------|
 * | arc    | `<project leaf>/<name>`  | `<name>`       | `arc:<name>`    |
 * | sketch | `<id>`                   | `sketch:<id>`  | `sketch:<id>`   |
 *
 * An arc name is unique only within one checkout's log, so the project travels
 * in the value. A sketch id is unique on the machine, so its value is the id
 * alone.
 *
 * @module lib/record-atom-shape
 */

/** The atom `type` an arc reference wears. */
export const ARC_ATOM_TYPE = "arc";

/** The atom `type` a sketch reference wears. */
export const SKETCH_ATOM_TYPE = "sketch";

/** Whether an atom segment's `type` names an arc. */
export function isArcAtomType(type: string): boolean {
  return type === ARC_ATOM_TYPE;
}

/** Whether an atom segment's `type` names a sketch. */
export function isSketchAtomType(type: string): boolean {
  return type === SKETCH_ATOM_TYPE;
}

/**
 * The arc name inside an arc atom's value — `parser` out of `tug/parser`.
 * Pure. A value with no `/` is already a name and returns unchanged.
 */
export function arcAtomName(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

/**
 * The project leaf inside an arc atom's value — `tug` out of `tug/parser`,
 * or null for a bare-name value.
 */
export function arcAtomProject(value: string): string | null {
  const slash = value.lastIndexOf("/");
  if (slash <= 0) return null;
  return value.slice(0, slash);
}

/** The label a sketch atom wears: `sketch:<id>`, as a commit wears its sha. */
export function sketchAtomLabel(id: string): string {
  return `sketch:${id}`;
}

/** The last path segment of a directory — the project leaf an arc value carries. */
export function projectLeafOf(dir: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

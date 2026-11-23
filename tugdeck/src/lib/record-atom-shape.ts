/**
 * record-atom-shape.ts — what an arc, a sketch, a docket and an idea atom's `type` and
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
 * | docket | `<id>`                   | `<name>`       | `docket:<id>`   |
 * | idea   | `<id>`                   | `<text>`       | `idea:<id>`     |
 *
 * An arc name is unique only within one checkout's log, so the project travels
 * in the value. A sketch id and a docket id are unique on the machine, so the
 * value is the id alone. A docket is labelled by its name, which is what the
 * user gave it; the name is not unique, so the plain text is the id.
 * An idea is labelled by its one line, cut to {@link IDEA_LABEL_LIMIT}
 * characters, for the same reason and with the same plain text.
 *
 * @module lib/record-atom-shape
 */

/** The atom `type` an arc reference wears. */
export const ARC_ATOM_TYPE = "arc";

/** The atom `type` a sketch reference wears. */
export const SKETCH_ATOM_TYPE = "sketch";

/** The atom `type` a docket reference wears. */
export const DOCKET_ATOM_TYPE = "docket";

/** The atom `type` an idea reference wears. */
export const IDEA_ATOM_TYPE = "idea";

/** The most characters of an idea's line its chip shows. */
export const IDEA_LABEL_LIMIT = 40;

/** Whether an atom segment's `type` names an arc. */
export function isArcAtomType(type: string): boolean {
  return type === ARC_ATOM_TYPE;
}

/** Whether an atom segment's `type` names a sketch. */
export function isSketchAtomType(type: string): boolean {
  return type === SKETCH_ATOM_TYPE;
}

/** Whether an atom segment's `type` names a docket. */
export function isDocketAtomType(type: string): boolean {
  return type === DOCKET_ATOM_TYPE;
}

/** Whether an atom segment's `type` names an idea. */
export function isIdeaAtomType(type: string): boolean {
  return type === IDEA_ATOM_TYPE;
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

/**
 * The label a docket atom wears: its name, which is what the user gave it, or
 * `docket:<id>` when no name is known (a marker replayed with no block).
 */
export function docketAtomLabel(id: string, name?: string): string {
  return name !== undefined && name !== "" ? name : `docket:${id}`;
}

/** The plain text a docket atom copies as: `docket:<id>`, the one spelling that is unique. */
export function docketPlainText(id: string): string {
  return `docket:${id}`;
}

/**
 * The label an idea atom wears: its line, cut to {@link IDEA_LABEL_LIMIT}
 * characters with an ellipsis, or `idea:<id>` when no line is known (a marker
 * replayed with no block).
 */
export function ideaAtomLabel(id: string, text?: string): string {
  const line = text?.trim() ?? "";
  if (line === "") return `idea:${id}`;
  const chars = Array.from(line);
  return chars.length > IDEA_LABEL_LIMIT
    ? `${chars.slice(0, IDEA_LABEL_LIMIT - 1).join("").trimEnd()}…`
    : line;
}

/** The plain text an idea atom copies as: `idea:<id>`, the one spelling that is unique. */
export function ideaPlainText(id: string): string {
  return `idea:${id}`;
}

/** The last path segment of a directory — the project leaf an arc value carries. */
export function projectLeafOf(dir: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

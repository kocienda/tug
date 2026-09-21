/**
 * session-atom-shape.ts — what a session atom's `type` and `value` are made of.
 *
 * A leaf: no imports, so the two chip renderers, the clipboard writer, and the
 * transcript walkers can all read the same rules without any of them importing
 * each other. `session-atom.ts` re-exports the whole surface, so a caller that
 * already speaks to that module keeps its one import.
 *
 * @module lib/session-atom-shape
 */

/** The atom `type` a session reference wears. */
export const SESSION_ATOM_TYPE = "session";

/** Whether an atom segment's `type` names a session. */
export function isSessionAtomType(type: string): boolean {
  return type === SESSION_ATOM_TYPE;
}

/**
 * The callsign inside a session atom's value — `quirky-hull` out of
 * `tugtool/quirky-hull`.
 *
 * The callsign is what the atom **resolves through**: the ledger answers a
 * callsign on `resolve_sessions`, which is how a chip holding no id reaches one
 * and so shows a live dot. It is a resolution key and never a display form:
 * what a chip SHOWS is the identity's display title ([D141]), which the
 * resolved session supplies and which is the user's own name whenever they
 * have set one. An unresolvable atom falls back to its stored label, and that
 * label is the whole `<project>/<callsign>` run rather than this half of it.
 *
 * Pure. A value with no `/` is already a callsign and returns unchanged.
 */
export function sessionAtomCallsign(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

/**
 * The project leaf-name inside a session atom's value — `tugtool` out of
 * `tugtool/quirky-hull`, or null for a bare-callsign value.
 *
 * This is what a transcript chip hands the identity resolver as
 * `recordedProject`: an unresolvable atom still shows the project its value
 * recorded, without claiming the ledger can find the session.
 */
export function sessionAtomProject(value: string): string | null {
  const slash = value.lastIndexOf("/");
  if (slash <= 0) return null;
  return value.slice(0, slash);
}

/**
 * The key a session atom's verdict is asked and answered under.
 *
 * `sessionCitationStore` keys every answer by **the spelling that was asked**,
 * so a reader that spells the key differently from the asker looks under a
 * key nobody filled and gets `pending` forever. One function, exported once,
 * is what keeps the askers and the readers on the same string: everything
 * that touches that map calls this rather than restating the rule.
 *
 * The uuid when the atom carries one, because it is the spelling that cannot
 * be ambiguous; otherwise the WHOLE `<project>/<callsign>` value, never the
 * callsign half — the project half is a filter the resolver applies for
 * itself, and dropping it would ask about every session on the machine
 * wearing that callsign.
 *
 * Takes the two fields it reads rather than an `AtomSegment`, so this module
 * stays a leaf and a caller holding the pair loose — the chip baker, which is
 * handed `(type, label, value)` and no segment — asks under the same rule
 * instead of restating it. A segment satisfies the shape structurally.
 */
export function sessionVerdictAskKey(atom: {
  value: string;
  session?: { id: string };
}): string {
  return atom.session?.id ?? atom.value;
}

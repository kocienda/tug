/**
 * session-atom.ts — the session reference as a real Tug atom.
 *
 * A session atom is not a look-alike of the atoms Tug already speaks; it IS
 * one. Copying a session writes the same clipboard flavors a file or command
 * atom writes, through the same `writeClipboardViaNative` bridge; pasting into
 * a Tug surface re-materializes the chip through the same sidecar parser;
 * submitting carries it on the wire through the same backtick-`@` marker. The
 * session joins the system — there is no parallel mechanism.
 *
 * What each flavor carries:
 *
 * | Flavor                    | Payload                                    |
 * |---------------------------|--------------------------------------------|
 * | `text/plain`              | the citation, `<project>/<tag> (<shortId>)` |
 * | `dev.tugapp.prompt-atoms`    | a one-atom sidecar with a `session` segment |
 * | wire marker (at submit)   | `` `@<project>/<tag>` ``                    |
 *
 * The `text/plain` flavor is the CITATION rather than the bare callsign,
 * because plain text is what leaves Tug — a pasted reference that a reader
 * cannot resolve back to a session is a name, not a reference.
 *
 * @module lib/session-atom
 */

import type { TugAtomsClipboardPayload } from "@/components/tugways/tug-text-editor/clipboard-filters";
import {
  sessionCitation,
  sessionIdentityLine,
  resolveSessionIdentity,
  type SessionIdentity,
} from "@/lib/session-identity";
import { writeClipboardViaNative } from "@/lib/tug-native-clipboard";
import { TUG_ATOM_CHAR, type AtomSegment } from "@/lib/tug-atom-img";
import { SESSION_ATOM_TYPE } from "@/lib/session-atom-shape";

export {
  SESSION_ATOM_TYPE,
  isSessionAtomType,
  sessionAtomCallsign,
  sessionAtomProject,
} from "@/lib/session-atom-shape";

/**
 * The atom segment for a session — `<project>/<callsign>` as both label and
 * value, so the chip reads what the wire marker carries.
 */
export function sessionAtomSegment(identity: SessionIdentity): AtomSegment {
  const run = sessionIdentityLine(identity);
  return {
    kind: "atom",
    type: SESSION_ATOM_TYPE,
    label: run,
    value: run,
  };
}

/**
 * The atom segment for a session named only by its id — resolve, then mint.
 *
 * A session annotation carries an id and nothing else, while the atom is
 * written from the identity RECORD: the project and the callsign the chip
 * reads and the wire marker carries. Where the ledger cannot answer, this
 * answers `null`, and the menu falls back to the plain text insert with no
 * atom copy — [L31] doing its usual job, an item offered only where it can be
 * performed.
 *
 * **It lives here rather than beside the menu on purpose.**
 * `resolveSessionIdentity` is the imperative snapshot, and a grep gate forbids
 * it under `components/` so no render body can read the identity stores
 * without subscribing. A menu handler that resolved for itself would be that
 * gate's next offender; a `lib/` helper it calls is not.
 */
export function sessionAtomSegmentFor(sessionId: string): AtomSegment | null {
  const identity = resolveSessionIdentity(sessionId);
  if (!identity.resolved) return null;
  const segment = sessionAtomSegment(identity);
  // A resolved identity with nothing to call itself would mint a chip with an
  // empty label, which reads as a rendering bug rather than as a reference.
  return segment.value === "" ? null : segment;
}

/**
 * The `text/plain` flavor that rides beside a session's atom — the citation,
 * never the bare callsign.
 *
 * Plain text is what LEAVES Tug, and a callsign alone is a name rather than a
 * reference: nothing outside the app can resolve it back to a session. The
 * citation carries the project and the short id, so it can be. This is the
 * same string {@link writeSessionAtomToClipboard} has always written, and it
 * lives here so the annotation menu's `Copy as Atom` and a session row's put
 * the same thing on the clipboard under the same name.
 */
export function sessionAtomPlainTextFor(sessionId: string): string | null {
  const identity = resolveSessionIdentity(sessionId);
  return identity.resolved ? sessionCitation(identity, { project: true }) : null;
}

/**
 * The `dev.tugapp.prompt-atoms` sidecar for a single session atom: one atom at
 * position 0 of a one-character text (the object-replacement char the editor
 * places an atom at). Exactly the shape `parseClipboardSidecar` reads, which
 * is why a paste into any Tug editor re-materializes the chip with no
 * session-specific code on the paste side.
 */
export function sessionAtomClipboardPayload(
  identity: SessionIdentity,
): TugAtomsClipboardPayload {
  return {
    version: 1,
    text: TUG_ATOM_CHAR,
    atoms: [{ position: 0, segment: sessionAtomSegment(identity) }],
  };
}

/**
 * Copy a session atom: the citation as plain text, the atom sidecar beside it.
 *
 * Returns `false` when the native bridge is unavailable (a browser-mode run),
 * which is the caller's signal to fall back to a plain-text write.
 */
export function writeSessionAtomToClipboard(identity: SessionIdentity): boolean {
  return writeClipboardViaNative(
    sessionCitation(identity, { project: true }),
    JSON.stringify(sessionAtomClipboardPayload(identity)),
  );
}

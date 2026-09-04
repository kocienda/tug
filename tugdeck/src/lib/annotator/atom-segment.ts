/**
 * The atom an annotation inserts as — the whole of the rule, in one function.
 *
 * An entity whose insert mints an atom names it in both directions: the menu
 * offers `Insert Atom into Prompt` to send it and `Copy as Atom` to take it.
 * An entity that inserts as text keeps the plain `Insert into Prompt` and
 * offers no atom copy. Both items read {@link atomSegmentFor}, and its `null`
 * is the predicate they are gated on — so a kind promoted to atom-insert later
 * inherits both items with no menu edit, and the two gestures cannot drift
 * apart the way two builders would.
 *
 * The inverse is `payloadForAtom` in `lib/annotator/payloads`: a placed atom
 * becoming an annotation again. Where both answer, they are meant to be each
 * other's inverse, and the unit tests pin that round trip per kind.
 *
 * @module lib/annotator/atom-segment
 */

import type { AnnotationPayload } from "./payloads";
import { formatAtomLabel, type AtomSegment } from "@/lib/tug-atom-img";
import {
  sessionAtomPlainTextFor,
  sessionAtomSegmentFor,
} from "@/lib/session-atom";

/**
 * A link atom's label: the host, plus the last path segment when the URL has
 * one, with an ellipsis standing in for anything between them. The full URL
 * is always the VALUE, so nothing is lost — the label is what has to fit on a
 * prompt line, and the chip's own `maxLabelWidth` does the final truncating.
 *
 * `www.` is dropped because it is never the part of a host a reader is
 * distinguishing by. A URL that will not parse falls back to itself, which is
 * honest rather than clever.
 */
function linkAtomLabel(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  const segments = parsed.pathname.split("/").filter((s) => s !== "");
  if (segments.length === 0) return host;
  const last = segments[segments.length - 1];
  return segments.length === 1 ? `${host}/${last}` : `${host}/…/${last}`;
}

/**
 * The atom segment `payload` inserts as, or `null` when its kind inserts as
 * text. A caller holding a segment mints a chip; a caller holding `null`
 * offers the plain jot insert and no atom copy.
 */
export function atomSegmentFor(payload: AnnotationPayload): AtomSegment | null {
  if (payload.kind === "file-path") {
    return {
      kind: "atom",
      type: "file",
      // The chip reads as a filename and carries the whole path underneath —
      // the same split every other file chip in the app makes, and the
      // reason one fits on a prompt line at all.
      label: formatAtomLabel(payload.path, "filename"),
      // A cited line is dropped: an atom names a file, and `path:line` is not
      // one. It is also what makes the round trip through `payloadForAtom`
      // the identity function on the path.
      value: payload.path,
    };
  }
  if (payload.kind === "directory") {
    return {
      kind: "atom",
      type: "directory",
      label: formatAtomLabel(payload.path, "filename"),
      // No trailing separator, which is what makes the round trip through
      // `payloadForAtom` the identity function: the file index's directory
      // form carries one and that function strips it on the way back in.
      value: payload.path.replace(/\/+$/, ""),
    };
  }
  if (payload.kind === "url") {
    return {
      kind: "atom",
      type: "link",
      label: linkAtomLabel(payload.url),
      value: payload.url,
    };
  }
  if (payload.kind === "session") {
    // The one kind whose atom cannot be built from the payload alone: a
    // session annotation carries an id, and the atom is written from the
    // identity record. Unresolved sessions answer `null` there, and this
    // whole function's `null` is what withholds both menu items.
    return sessionAtomSegmentFor(payload.target);
  }
  return null;
}

/**
 * The `text/plain` flavor to write beside `segment` on the clipboard.
 *
 * For a path, a directory and a URL the atom's own value IS the plain form —
 * which is where the atom copy differs from `Copy Path` on a cited file:
 * `foo.ts:14` copies as written there, and an atom names a file.
 *
 * A session is the exception, and the rule stays here rather than in the menu
 * handler so both surfaces that offer `Copy as Atom` write one string. Its
 * plain form is the CITATION: plain text is what leaves Tug, and a bare
 * callsign is a name nothing outside the app can resolve back to a session.
 */
export function atomPlainTextFor(
  payload: AnnotationPayload,
  segment: AtomSegment,
): string {
  if (payload.kind === "session") {
    return sessionAtomPlainTextFor(payload.target) ?? segment.value;
  }
  return segment.value;
}

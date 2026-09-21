/**
 * atom-identity-attrs — the one place that authors an atom's identity in the DOM.
 *
 * A copy that crosses a chip recognises it by four attributes and nothing else:
 * `data-atom-type`, `data-atom-label`, `data-atom-value`, and `data-atom-id`
 * where the atom has an id. `selectionToTranscriptSubstrate` reads exactly
 * those, which is what lets one serializer read every surface's chips without
 * knowing which component drew them.
 *
 * That contract used to be a spread each renderer remembered, and the renderers
 * that did not remember it are the reports this module answers: a confirmed
 * commit mention wore a pill with no `data-atom-*` at all, so a selection
 * across it walked *into* the pill and read its two inner spans as prose, and
 * the transcript's chips wrote no id, so an image chip pasted back as a chip
 * with no bytes behind it.
 *
 * So the four attributes are computed here and spread by every renderer —
 * `TugCommitAtom`, `TugAtomChip`, `TugSessionCitation` and the editor's baked
 * `<img>`. A fifth renderer spreads this or emits nothing; there is no third
 * option where it emits three of the four, or spells one of them differently.
 * [L20] — one place authors the contract that one reader consumes.
 *
 * The module holds no DOM. `data-atom-*` is a record of strings either way, and
 * a pure function is one a unit test can read as data — which is the whole of
 * how the contract is pinned, since two of the four renderers cannot be
 * rendered without a `document` at all.
 *
 * @module lib/atom-identity-attrs
 */

/**
 * The session an atom names, by the two facts a reader on another machine
 * needs to find it: the full uuid and the directory the session ran in.
 *
 * The `<project>/<callsign>` the chip reads is a NAME — it resolves only
 * against a ledger that happens to hold that callsign — so an atom carrying
 * the name alone is a reference nothing outside this instance can follow. The
 * uuid is the thing that survives the trip.
 */
export interface AtomSessionRef {
  /** The full tug session uuid. */
  id: string;
  /** The absolute directory the session ran in. */
  projectDir: string;
}

/** The identity an atom publishes — the shape `AtomSegment` already carries. */
export interface AtomIdentity {
  type: string;
  label: string;
  value: string;
  /** UUID minted at drop / paste; pairs the atom with its byte payload. */
  id?: string;
  /** The session a session atom names, where the mint knew both halves. */
  session?: AtomSessionRef;
}

/**
 * The `data-atom-*` attributes an atom's DOM element carries.
 *
 * `data-atom-id` is optional in the same sense the atom's id is: an atom with
 * no byte payload has none, and an EMPTY one would be worse than absent — the
 * serializer would write a sidecar entry pointing at a store row that is not
 * there.
 */
export interface AtomIdentityAttrs {
  "data-atom-type": string;
  "data-atom-label": string;
  "data-atom-value": string;
  "data-atom-id"?: string;
  "data-atom-session-id"?: string;
  "data-atom-session-project-dir"?: string;
}

/**
 * The attributes for one atom.
 *
 * The `value` is the atom's own, never the label's abbreviation: a commit
 * reference stays as short or as full as it was written, because git resolves
 * either and the round trip through `payloadForAtom` is the identity function
 * on that field.
 */
export function atomIdentityAttrs(atom: AtomIdentity): AtomIdentityAttrs {
  const attrs: AtomIdentityAttrs = {
    "data-atom-type": atom.type,
    "data-atom-label": atom.label,
    "data-atom-value": atom.value,
  };
  // Absent rather than empty, and absent rather than `undefined` under a key
  // that exists: `setAttribute` would write the string "undefined", and React
  // drops an `undefined` value but a DOM caller does not.
  if (atom.id !== undefined && atom.id !== "") attrs["data-atom-id"] = atom.id;
  // Both halves or neither: a uuid with no project dir cannot be read back as
  // an `AtomSessionRef` without inventing the missing half, and the reader on
  // the other side would have to guess which absence meant what.
  if (
    atom.session !== undefined
    && atom.session.id !== ""
    && atom.session.projectDir !== ""
  ) {
    attrs["data-atom-session-id"] = atom.session.id;
    attrs["data-atom-session-project-dir"] = atom.session.projectDir;
  }
  return attrs;
}

/**
 * The same four attributes, set on an element the caller built by hand.
 *
 * For the editor's baked `<img>`, which is DOM rather than JSX and so has no
 * spread to take. It reads the one record above rather than assigning three
 * `dataset` keys of its own, so the `<img>` and the three components cannot
 * drift in spelling.
 */
export function applyAtomIdentityAttrs(el: Element, atom: AtomIdentity): void {
  for (const [name, value] of Object.entries(atomIdentityAttrs(atom))) {
    el.setAttribute(name, value);
  }
}

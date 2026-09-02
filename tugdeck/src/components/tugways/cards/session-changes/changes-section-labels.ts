/**
 * The Changes shade's section labels — every one of them, in one place.
 *
 * The shade names six buckets, and until now each string was spelled at its own
 * call site: three in `session-changes-view.tsx`, two composed inside
 * `session-changes-arc-lane.tsx`. A gallery fixture claiming to hold the full
 * inventory would have been a seventh spelling, free to drift from all six.
 *
 * **A label is a name and an optional qualifier**, not one string with an em
 * dash in it. The eyebrow treatment paints the two differently — the bucket
 * name at full strength, the qualifier dimmer, so "unattributed" reads before
 * "no session claims these" — and a renderer cannot do that to a string
 * without splitting on punctuation, which is a parser standing where a data
 * shape belongs. The em dash between them is the renderer's, not the data's.
 *
 * **No possessives.** A bucket is named by where its files live, not by what
 * owns them: "changes in this session", never "this session's changes"; "the
 * arc on this card", never "this card's arc". The apostrophe-s reads as
 * ownership language in a surface whose whole subject is contested ownership,
 * where "claimed", "unattributed", and "orphaned" already carry that meaning
 * precisely.
 *
 * @module components/tugways/cards/session-changes/changes-section-labels
 */

import type { SectionLabel } from "@/components/tugways/tug-section-label";

/** Files this session is the proven owner of. */
export const SESSION_LABEL: SectionLabel = {
  name: "changes in this session",
};

/** Dirty files no owner claims. */
export const UNATTRIBUTED_LABEL: SectionLabel = {
  name: "unattributed",
  qualifier: "no session claims these",
};

/** The same bucket when the attribution ledger cannot answer at all. */
export const UNATTRIBUTED_DEGRADED_LABEL: SectionLabel = {
  name: "unattributed",
  qualifier: "ledger damaged, claims unavailable",
};

/** Files owned only by sessions that have closed ([D120]). */
export const ORPHANED_LABEL: SectionLabel = {
  name: "orphaned",
  qualifier: "claim to bring into this session",
};

/**
 * The fronted row's header, which is two headers because fronting is two
 * situations.
 *
 * Usually the fronted arc is the one this session is mated to, and the label
 * says so: the binding is the fact a reader acts on — it is what Unbind ends
 * and what the card is working.
 *
 * But a join aimed by name (`/arc-join <name>`) fronts its target so the
 * landing face has somewhere to mount, and that arc may be one this card never
 * bound. Fronting is about what is being landed; the binding is about what the
 * card works. One label covering both would claim a binding that does not exist
 * — on precisely the row that offers **Adopt** to create it.
 */
export function arcFrontedLabel(bound: boolean): SectionLabel {
  return bound
    ? { name: "arc bound to this session" }
    : { name: "arc this landing is aimed at" };
}

/**
 * The rest of the project's arcs. The count is the qualifier, because it is
 * the part that changes — "arcs" is what the reader is scanning for.
 */
export function arcRestLabel(count: number, hasFronted: boolean): SectionLabel {
  const noun = count === 1 ? "arc" : "arcs";
  return hasFronted
    ? { name: "also on this project", qualifier: `${count} ${noun}` }
    : { name: `${noun} on this project`, qualifier: String(count) };
}

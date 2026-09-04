/**
 * arc-sigil-text.ts — the arc sigil as characters, for the surfaces that have
 * no elements to put it in.
 *
 * `arc-sigil.tsx` is the markup: a run, its sigil, its name, rendered once so
 * that every React surface naming an arc names it the same way. Its own header
 * says why — two hand-rolled spellings of `^` + name is exactly how a rule
 * like that drifts. But one surface cannot use that component at all: the
 * composer's atom chip is a Canvas bake inside an `<img>` ([P14]), and what it
 * needs is a STRING. So the spelling lives here, in a leaf with no imports,
 * and the component and the bake both read it.
 *
 * Flat text, deliberately not the citation. `sessionCitation` is the durable
 * form a reader pastes outside Tug, and a citation carrying an arc would rot
 * the moment that arc landed (at0423 A). This is for what a chip DISPLAYS,
 * which is resolved live every time it is drawn.
 *
 * @module lib/arc-sigil-text
 */

/** The arc sigil — the one `^` in the grammar. */
export const ARC_SIGIL = "^";

/**
 * A display run with its arc appended — `tug/salty-basin^arc-unification`.
 *
 * `null` for the arc means the session is on none, and the run is returned
 * untouched; that is the common case, so callers hand the lookup's answer
 * straight in rather than branching around this.
 */
export function withArcSigil(run: string, arcName: string | null): string {
  return arcName === null || arcName.length === 0
    ? run
    : `${run}${ARC_SIGIL}${arcName}`;
}

/**
 * lens-section-presence.ts — a tiny module store tracking which Lens sections
 * exist on screen at all.
 *
 * Presence is a different question from the two facts in
 * `lens-section-content.ts`, and it cannot be answered by either of them.
 * `navigable` and `populated` are published by a section's **body**; a section
 * that is absent renders no body, so the sequence would be: hide ⇒ body
 * unmounts ⇒ its cleanup publishes `false` ⇒ presence recomputes as false ⇒ the
 * section stays hidden forever. That is not a bug to be careful around, it is
 * the shape. So presence lives here, published by a probe that stays mounted
 * whether or not the thing it describes is rendered.
 *
 * Keyed by section `kind` rather than by focus group: a section with no body
 * has no focusables, so its group is not a name anything else would know it by.
 *
 * An unpublished kind reads as **present**. A section is never hidden because
 * nothing has said anything about it yet.
 *
 * [L02] external store; React reads via `useSyncExternalStore`.
 *
 * @module components/lens/lens-section-presence
 */

const presentByKind = new Map<string, boolean>();
const listeners = new Set<() => void>();
let version = 0;

/** Subscribe to presence changes across all sections. */
export function subscribeSectionPresence(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A monotonic token that bumps on every change — a `useSyncExternalStore`
 *  snapshot paired with {@link subscribeSectionPresence}. */
export function getSectionPresenceVersion(): number {
  return version;
}

/** Whether the section registered as `kind` renders at all. Defaults to `true`
 *  for a kind nothing has published, so missing information never hides a
 *  section. */
export function sectionIsPresent(kind: string): boolean {
  return presentByKind.get(kind) ?? true;
}

/** Publish whether `kind` renders. Written only by the always-mounted probe. */
export function setSectionPresent(kind: string, present: boolean): void {
  if ((presentByKind.get(kind) ?? true) === present) return;
  presentByKind.set(kind, present);
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * Test seam — forget every published presence so a test starts from the
 * default (everything present).
 * @internal
 */
export function _clearSectionPresenceForTest(): void {
  presentByKind.clear();
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * `stages` — the transcript divider's text for an arc stage boundary.
 *
 * A stage rotation is a fresh claude session started by the server on the
 * same card. It becomes a `system_note` with `source: "stage"`, rendered as
 * a soft separator in the same family as the compaction divider — so an arc
 * that spans three sessions reads as one scroll with named boundaries rather
 * than as a card that silently lost its history.
 *
 * The text is composed here and nowhere else: the reducer folds the event,
 * the transcript renders the string. Sibling of `compaction.ts` by design —
 * that module's docstring is about compaction, and a divider that has
 * nothing to do with token counts does not belong under it.
 */

/**
 * Divider text for a stage `system_note`.
 *
 * A first stage names what it is and what it opened on (`devise · opus ·
 * arc/foo-brief.md`). A *continued* implement stage — one the runner
 * rotated at a step boundary because the session's context ran down — names
 * the step range instead, because the document has not changed and the range
 * is the only new fact (`implement, continued · opus · steps 4–9`).
 *
 * `steps` arrives from the wire as `N-M`; the hyphen is rendered as an en
 * arc, which is what a range is set in.
 *
 * An empty `model` (the account default) and an empty `document` are each
 * simply left out rather than rendered as a gap.
 */
export function stageNoteText(
  stage: string,
  model: string,
  document: string,
  steps?: string,
): string {
  const parts: string[] = [steps ? `${stage}, continued` : stage];
  if (model) parts.push(model);
  if (steps) {
    parts.push(`steps ${steps.replace("-", "–")}`);
  } else if (document) {
    parts.push(document);
  }
  return parts.join(" · ");
}

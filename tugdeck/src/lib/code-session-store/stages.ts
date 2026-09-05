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
 * The stage boundary's EVENT — the bold head of its inline run, beside the
 * `Milestone` glyph, with {@link stageNoteText} following it as the detail.
 *
 * It lives here rather than at the render site because it is projected as
 * well as painted: the boundary marks the event span `data-tugx-findable`,
 * and the transcript's search index pairs marked containers with projected
 * parts POSITIONALLY, so the two readings of this string have to be the same
 * string. One home, and changing the word changes both.
 *
 * This is the FLOOR — what a stage note with no facts behind it reads. A note
 * that carries {@link StageBoundaryFacts} says which stage and which model
 * instead; see {@link stageBoundaryParts}.
 */
export const STAGE_BOUNDARY_EVENT = "Stage";

/**
 * What the `session_stage` event knew, carried through to the render site.
 *
 * The note's `text` is a display string and stays one — it is the row's copy
 * text and what a reader selects. The boundary needs the same facts SPLIT, so
 * they ride the note beside the text rather than being parsed back out of it:
 * a stage name, a model and a repo-relative path are not separable from one
 * ` · `-joined line without guessing which segment is which, and a renderer
 * that guesses is a renderer that is wrong on the day a model selector
 * contains a slash.
 */
export interface StageBoundaryFacts {
  /** Which stage of the arc the fresh session runs. */
  stage: string;
  /** The model selector the rotation set; empty for the account default. */
  model: string;
  /** The document the arc opened on, repo-relative; may be empty. */
  document: string;
  /** The inclusive step range (`N-M`) a continued implement stage walks. */
  steps?: string;
}

/** The three slots a stage boundary fills. */
export interface StageBoundaryParts {
  /** The bold event at the head of the run. */
  event: string;
  /** The muted detail continuing it; empty when there is nothing to say. */
  detail: string;
  /** The trailing badge — the model the card is now on, or none. */
  badge?: string;
}

/** `4-9` → `4 of 9`. Anything else is not a range and answers `null`. */
function stepRange(steps: string | undefined): string | null {
  if (steps === undefined) return null;
  const match = /^(\d+)-(\d+)$/.exec(steps.trim());
  return match === null ? null : `${match[1]} of ${match[2]}`;
}

/**
 * The stage boundary's three slots, from the facts the rotation carried.
 *
 * The event names the stage, which is the whole point of the change: the bar
 * used to say `Stage` and leave `devise · opus · <path>` to the detail, so a
 * reader had to parse a joined line to learn which stage they had crossed
 * into. Now the stage is the event, the path is the detail, and the model is
 * the trailing badge — three facts in three slots.
 *
 * **The count is the step range, and it is the only count there is.** A
 * continued implement stage is one the runner rotated at a step boundary, and
 * `steps` is the inclusive range it walks — so `4-9` reads `Stage 4 of 9 ·
 * implement`, naming where in the walk the reader has landed. Every other
 * stage carries no range and reads `Stage · <stage>`. There is deliberately
 * no stage-ordinal-of-total here: an arc's stage count is not fixed and
 * `session_stage` carries none, so a denominator would have to be invented.
 *
 * A continued stage's name drops the `, continued` suffix {@link
 * stageNoteText} gives it — the range already says the stage is a
 * continuation, and saying it twice in one run reads as a stutter.
 */
export function stageBoundaryParts(facts: StageBoundaryFacts): StageBoundaryParts {
  const range = stepRange(facts.steps);
  const stage = facts.stage.replace(/, continued$/, "");
  const event =
    range === null
      ? `${STAGE_BOUNDARY_EVENT} · ${stage}`
      : `${STAGE_BOUNDARY_EVENT} ${range} · ${stage}`;
  return {
    event: stage === "" ? STAGE_BOUNDARY_EVENT : event,
    detail: facts.document,
    badge: facts.model === "" ? undefined : facts.model,
  };
}

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

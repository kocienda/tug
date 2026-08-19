/**
 * list-multi-select.ts — what a modifier means to a multi-select list.
 *
 * `TugListView`'s opt-in multi-select mode routes three intents, and the rule
 * that picks between them is here rather than inline in the pointer handler so
 * it can be tested as what it is: a pure reading of the gesture record.
 *
 * The record — never the raw event. `gesture-interpreter.ts` classifies the
 * pointerdown once and publishes the modifiers it was held with; a surface that
 * re-read them off its own React event would be a second source for the same
 * fact, and the two disagree the moment a gesture is synthesized (the host's
 * activation click has modifiers by definition absent).
 *
 * ⌘ wins over ⇧ when both are held, matching Finder: the toggle is the more
 * specific gesture, and a ⌘⇧-click that silently ranged would be a destructive
 * surprise on a set the user was building one row at a time.
 *
 * @module components/tugways/list-multi-select
 */

/** What a click on a row means for the selection. */
export type MultiSelectIntent = "pick" | "toggle" | "extend";

/** The modifier half of a gesture record — all this rule needs. */
export interface MultiSelectModifiers {
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * The intent a click carries. A gesture the interpreter never classified
 * (`null` — a synthetic click, a test harness press) reads as a plain pick,
 * which is the gesture with no modifiers and the safe default.
 */
export function multiSelectIntentFor(
  gesture: MultiSelectModifiers | null | undefined,
): MultiSelectIntent {
  if (gesture === null || gesture === undefined) return "pick";
  if (gesture.metaKey) return "toggle";
  if (gesture.shiftKey) return "extend";
  return "pick";
}

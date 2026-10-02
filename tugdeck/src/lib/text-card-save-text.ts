/**
 * text-card-save-text.ts — the one wording for a Text card's save state.
 *
 * This used to live inside the card's bottom status bar, which was the only
 * surface that said it. It now rides the card's document masthead instead —
 * the third line under the filename and the path — and it lives here so the
 * string is a pure function of the store's facts rather than a detail of
 * whichever surface happens to render it.
 *
 * @module lib/text-card-save-text
 */

import type { FileConflict, FileSaveState, SaveMode } from "./text-card-store";

/** The buffer facts the wording is a function of. */
export interface SaveTextFacts {
  readonly saveMode: SaveMode;
  readonly saveState: FileSaveState;
  readonly conflict: FileConflict | null;
  /** When this buffer was last written, or `null` if it has not been. */
  readonly lastSavedAt: number | null;
  /**
   * Whether the buffer is bound to a file the USER named — false for a draft,
   * which lives under the Tug drafts directory until Move To… gives it a home.
   * It is what separates a clean buffer that has a file from one that is not
   * a file yet; see the "Draft" rung below.
   */
  readonly bound: boolean;
  /**
   * Whether the card's pane is folded. A folded card holds its conflict
   * banner until it opens, so in automatic mode too the masthead is where an
   * external change is said meanwhile ([B10] of the every-card-folds brief).
   * Omitted, the card is open.
   */
  readonly folded?: boolean;
}

/**
 * Save-state copy. Automatic mode is the saveless live-autosave wording
 * ("Saving…" / "Unsaved" / "Saved"); manual mode is the classic document
 * wording ("Saving…" / "Edited" / "Saved"), and an unresolved external
 * change displaces both — a buffer whose file changed under it has nothing
 * useful to say about when it was last written. Automatic mode says it here
 * only while the card is folded; open, its banner says it.
 */
export function saveText(facts: SaveTextFacts): string {
  const { saveMode, saveState, conflict, lastSavedAt, bound, folded = false } = facts;
  if (conflict !== null && (saveMode === "manual" || folded)) {
    return conflict.reason === "missing" ? "File deleted" : "File changed";
  }
  if (saveState === "writing") return "Saving…";
  if (saveState === "editing") return saveMode === "manual" ? "Edited" : "Unsaved";
  // Clean, and nothing has been written yet. For a file on disk that is the
  // truth — it is saved, there is simply no event to time. For an unnamed
  // draft it would be a claim about an act that never happened: the buffer
  // has never been a file. It says what it IS instead, and starts saying
  // "Saved: <time>" the moment autosave gives it something to time.
  if (lastSavedAt === null) return bound ? "Saved" : "Draft";
  return `Saved: ${new Date(lastSavedAt).toLocaleTimeString()}`;
}

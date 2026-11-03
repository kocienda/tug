/**
 * editor-stats-store.ts — the live document/selection stats one File
 * card's editor publishes for its status bar: caret position, and the
 * line / word / character counts.
 *
 * A tiny subscribable store per card. `TugTextCardEditor` writes it from its
 * CM6 update listener (caret on every selection change; counts on every
 * doc change, and on every selection change while a range is selected);
 * `TextCardStatusBar` reads it via `useSyncExternalStore`, so
 * keystroke-rate updates repaint only the status bar — not the editor.
 * Pure UI state, never persisted.
 *
 * **Laws:** [L02] useSyncExternalStore-compatible subscribe/getSnapshot.
 *
 * @module lib/editor-stats-store
 */

import { Subscribable } from "./subscribable";

export interface EditorStats {
  /** 1-based line of the caret (or the start of a ranged selection). */
  caretLine: number;
  /** 1-based column of the caret (or the start of a ranged selection). */
  caretCol: number;
  /**
   * Lines, words and characters of the ranged selection when there is one
   * (`ofSelection`), else of the whole document.
   */
  lines: number;
  /** Whitespace-delimited word count. */
  words: number;
  /** Character count. */
  chars: number;
  /** Whether the counts are the selection's rather than the document's. */
  ofSelection: boolean;
}

export const EMPTY_EDITOR_STATS: EditorStats = {
  caretLine: 1,
  caretCol: 1,
  lines: 1,
  words: 0,
  chars: 0,
  ofSelection: false,
};

export class EditorStatsStore extends Subscribable {
  private _stats: EditorStats = EMPTY_EDITOR_STATS;

  getSnapshot = (): EditorStats => this._stats;

  /** Publish a fresh stats snapshot (called from the CM6 update listener). */
  set = (stats: EditorStats): void => {
    this._stats = stats;
    this.notify();
  };
}

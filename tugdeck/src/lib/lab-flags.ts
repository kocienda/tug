/**
 * lab-flags.ts — harness-settable runtime flags for measurement cells.
 *
 * A lab flag is diagnostic-only: no user-facing surface reads or writes one.
 * Writers are `window.__tug` methods (test-surface.ts); readers subscribe
 * through `useSyncExternalStore`, so a flip lands as an ordinary React
 * commit ([L02]).
 */

import { createSubscribable } from "./subscribable";

export type LabFlags = {
  /**
   * Render session transcripts with `evictOffscreen` withheld — the full
   * inline DOM at full layer height. The tile-ledger cell's A/B arm
   * (arc/scrolling-memory-diet.md §G2).
   */
  readonly transcriptEvictionDisabled: boolean;
};

let flags: LabFlags = { transcriptEvictionDisabled: false };

const listeners = createSubscribable();

export const labFlags = {
  subscribe(listener: () => void): () => void {
    return listeners.subscribe(listener);
  },

  getSnapshot(): LabFlags {
    return flags;
  },

  setTranscriptEvictionDisabled(disabled: boolean): void {
    if (flags.transcriptEvictionDisabled === disabled) return;
    flags = { ...flags, transcriptEvictionDisabled: disabled };
    listeners.notify();
  },
};

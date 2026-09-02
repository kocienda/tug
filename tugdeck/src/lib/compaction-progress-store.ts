/**
 * `compactionProgressStore` — drives the `/compact` progress sheet.
 *
 * Native `/compact` dispatches as a stream-json user message and compacts in
 * place (same session, same JSONL). It is an opaque run — minutes on a full
 * context — with no streamed volume to meter, so the sheet is pane-modal and
 * **indeterminate**: the run is either in flight or settled. This singleton is
 * the seam between the session-card handler that opens the run (`begin`) and
 * drives it off `codeSessionStore` snapshots (`succeed` / `cancel` / `fail`),
 * and the sheet that renders off the same store. The card watches the terminal
 * `outcome` to raise the closing bulletin and `clear`.
 *
 * Every mutator is keyed by `cardId`, and the snapshot is a map of the runs
 * currently open. Each card owns its own `codeSessionStore`, so any number of
 * cards can be compacting at once; a per-card key is what keeps a second
 * `/compact` from overwriting the first's run, and keeps one card's `clear`
 * from dropping another card's sheet.
 *
 * The run's lifetime is this store's, NOT the sheet's: the card's watcher is
 * subscribed here, so a sheet dismissed early (Escape, a host unmount) leaves
 * the compaction running and still settling into the transcript.
 *
 * No entry for a card = idle (no compaction, no sheet). An entry with
 * `outcome === null` is a run in flight; an entry with a terminal `outcome` is
 * a just-settled run awaiting that card's bulletin + `clear`.
 *
 * Both manual `/compact` and native auto-compaction stream a `compact_boundary`,
 * but only a manual `/compact` opens this run — the progress sheet and closing
 * bulletin are scoped to the explicit command.
 *
 * Module-level singleton, matching the other per-session helper stores
 * ([L02] external state reaches React through `useSyncExternalStore`).
 */

import { useCallback, useSyncExternalStore } from "react";

/** How a compaction run settled. */
export type CompactionOutcome = "succeeded" | "canceled" | "failed";

export interface CompactionProgress {
  /** Terminal outcome, or `null` while the run is still in flight. */
  readonly outcome: CompactionOutcome | null;
  /** Human-readable reason when `outcome === "failed"`, else `null`. */
  readonly failureReason: string | null;
}

/** Every open run, keyed by the card that started it. */
export type CompactionRuns = ReadonlyMap<string, CompactionProgress>;

const NO_RUNS: CompactionRuns = new Map();

/**
 * What every pulse surface says for the length of a `/compact` run — the
 * card's `session-masthead` and the Cards card **Sessions** row read the same
 * string, so a compacting session says one thing wherever it is shown.
 */
export const COMPACTING_PULSE_TEXT = "Compacting context…";

/** Whether `runs` holds a still-in-flight run for `cardId`. */
export function isCompactingCard(
  runs: CompactionRuns,
  cardId: string | undefined,
): boolean {
  if (cardId === undefined) return false;
  const run = runs.get(cardId);
  return run !== undefined && run.outcome === null;
}

class CompactionProgressStore {
  private state: CompactionRuns = NO_RUNS;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable between notifications — safe for `useSyncExternalStore`. */
  getSnapshot = (): CompactionRuns => this.state;

  /**
   * This card's run, or `null` when it has none. Stable between notifications
   * (entries are replaced, never mutated), so it is safe to read directly as a
   * `useSyncExternalStore` snapshot.
   */
  getFor = (cardId: string): CompactionProgress | null =>
    this.state.get(cardId) ?? null;

  /** Open an in-flight run for `cardId`. */
  begin(cardId: string): void {
    this.write(cardId, { outcome: null, failureReason: null });
  }

  /** Mark the card's run succeeded (compaction ink observed in place). */
  succeed(cardId: string): void {
    this.settle(cardId, "succeeded", null);
  }

  /** Mark the card's run canceled (user interrupted the compaction). */
  cancel(cardId: string): void {
    this.settle(cardId, "canceled", null);
  }

  /** Mark the card's run failed, carrying a reason for the closing bulletin. */
  fail(cardId: string, reason: string): void {
    this.settle(cardId, "failed", reason);
  }

  /** Drop this card's run — dismisses its sheet and ends the run. */
  clear(cardId: string): void {
    if (!this.state.has(cardId)) return;
    const next = new Map(this.state);
    next.delete(cardId);
    this.state = next;
    this.emit();
  }

  private settle(
    cardId: string,
    outcome: CompactionOutcome,
    failureReason: string | null,
  ): void {
    // Settle only an in-flight run; a second terminal call is a no-op so
    // racing paths (Cancel button vs. the turn settling) can't double-fire.
    const run = this.state.get(cardId);
    if (run === undefined || run.outcome !== null) return;
    this.write(cardId, { outcome, failureReason });
  }

  private write(cardId: string, run: CompactionProgress): void {
    const next = new Map(this.state);
    next.set(cardId, run);
    this.state = next;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const compactionProgressStore = new CompactionProgressStore();

/** Stable no-op subscribe for a row that has no card to be compacting. */
const NOOP_SUBSCRIBE = (): (() => void) => () => {};

/** Stable `false` for the same. */
const NEVER_COMPACTING = (): boolean => false;

/**
 * Whether THIS card has a compaction in flight — the card-scoped door onto the
 * store, and the one every rendering surface should use.
 *
 * Two things it does that reading {@link CompactionProgressStore.getSnapshot}
 * directly does not, both of which matter because the caller is a session row
 * and session rows come by the listful:
 *
 *  - **The snapshot is this card's boolean, not the whole runs map.** A map read
 *    changes identity on every write to any card, so one card compacting
 *    re-rendered every session row in the app — the masthead, all of the Cards card's
 *    monitor rows, and every row in an open picker. A boolean compares equal
 *    across an unrelated card's run and React bails out.
 *  - **No `cardId`, no subscription.** A row for a session no card holds can
 *    never be compacting ({@link isCompactingCard} answers `false` for
 *    `undefined` before it reads anything), so it registers no listener at all
 *    rather than one that wakes it to compute `false` again.
 */
export function useIsCompactingCard(cardId: string | undefined): boolean {
  return useSyncExternalStore(
    cardId === undefined ? NOOP_SUBSCRIBE : compactionProgressStore.subscribe,
    useCallback(
      () =>
        cardId === undefined
          ? false
          : isCompactingCard(compactionProgressStore.getSnapshot(), cardId),
      [cardId],
    ),
    NEVER_COMPACTING,
  );
}

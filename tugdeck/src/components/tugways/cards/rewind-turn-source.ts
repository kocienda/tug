/**
 * rewind-turn-source.ts — the `/rewind` message list projection.
 *
 * Projects the committed `code-session-store` transcript into the rows the
 * `RewindSheet` lists: **one row per user message, as it was typed**, oldest
 * first. Every targetable turn (opened with a real user submission AND
 * carrying the `promptUuid` anchor, [#step-7-1]) becomes a row displaying its
 * own text and its own submission time — no offset, no synthetic present.
 *
 * The rewind gesture is a *cut*: the user places a line between two messages,
 * splitting the list into a **kept** prefix and a **pruned** suffix. The last
 * kept message is the rewind point; the first pruned message is the
 * `session_rewind` anchor (tugcode chops that turn and everything past it,
 * [#step-7-2]). So a cut below row `i` sends `rows[i + 1].promptUuid` — which
 * is why the projection carries each message's own anchor and lets the sheet
 * do the pairing.
 *
 * The line can rest below the last message (nothing pruned — the sheet's
 * opening state, where Rewind is disabled), but never above the first: the
 * retained prefix must hold at least one earlier submission or claude refuses
 * the resume (`no_retained_turns` in `tugcode/src/session.ts`). Hence
 * {@link canOfferRewind} needs two messages, not one.
 *
 * This is NOT a `SessionPickerSheet` data source ([D05]): that lists *distinct
 * sessions* for `/resume`; this lists *messages within the current session*.
 * The projection is pure (no diff-stat) — the cut's diff-stat is fetched
 * lazily from the store snapshot's `rewindPreviews`, keyed by `promptUuid`
 * (the N+1-avoiding lazy/cached discipline lives in the sheet).
 *
 * @module components/tugways/cards/rewind-turn-source
 */

import type {
  TugListViewDataSource,
} from "@/components/tugways/tug-list-view";
import type { TurnEntry } from "@/lib/code-session-store/types";
import type { AtomSegment } from "@/lib/tug-atom-img";

/** The single cell kind — every row is a user message. */
export const REWIND_MESSAGE_KIND = "rewind-message";

/**
 * One user message, as typed.
 *
 * - `promptUuid` — this message's own rewind anchor ([#step-7-1]). Passed to
 *   `session_rewind` / `rewind_preview` when this message is the FIRST pruned
 *   one (i.e. when the line sits directly above it).
 * - `turnKey` — the turn's committed React-key seed (a stable row id).
 * - `text` / `submitAt` — what the user typed and when they sent it.
 * - `atoms` — the submission's attachments, carried so a rewind can seed the
 *   composer with the full original prompt (text + attachments) for re-edit.
 */
export interface RewindMessageRow {
  promptUuid: string;
  turnKey: string;
  text: string;
  submitAt: number;
  atoms: ReadonlyArray<AtomSegment>;
}

/**
 * Pure projection of the committed transcript into the sheet's message rows,
 * in conversation order (oldest first) — one row per targetable turn.
 *
 * Wake turns (no user message) and pre-anchor turns (older sessions) are
 * skipped: they carry no submission to show and cannot be `session_rewind`
 * anchors.
 */
export function projectRewindTurns(
  transcript: ReadonlyArray<TurnEntry>,
): RewindMessageRow[] {
  const rows: RewindMessageRow[] = [];
  transcript.forEach((turn) => {
    if (!isTargetable(turn)) return;
    const opener = turn.messages[0];
    if (opener.kind !== "user_message") return;
    rows.push({
      promptUuid: turn.promptUuid as string,
      turnKey: turn.turnKey,
      text: opener.text,
      submitAt: opener.submitAt,
      atoms: opener.attachments,
    });
  });
  return rows;
}

/** A turn is rewind-targetable iff it opened with a user submission + anchor. */
function isTargetable(turn: TurnEntry): boolean {
  return (
    typeof turn.promptUuid === "string" &&
    turn.promptUuid.length > 0 &&
    turn.messages.length > 0 &&
    turn.messages[0].kind === "user_message"
  );
}

/**
 * Whether `/rewind` should be offered for this transcript (the empty-state
 * gate). True iff there are ≥2 messages — a cut needs something to keep and
 * something to prune, and the retained prefix must hold at least one earlier
 * submission.
 */
export function canOfferRewind(
  transcript: ReadonlyArray<TurnEntry>,
): boolean {
  return projectRewindTurns(transcript).length >= 2;
}

/**
 * Static, single-section data source over the projected messages. The row set
 * is resolved at sheet-open time and fixed for the sheet's lifetime, so the
 * only thing that moves underneath is *enablement*: a message the line cannot
 * rest above (its cut would cross a `/compact` boundary) becomes unpickable as
 * previews resolve. That arrives through {@link setBlockedCuts}, which ticks
 * `subscribe` — so the row set, and therefore the data-source identity, never
 * changes and the list never re-seeds its selection underneath the user.
 *
 * Diff-stats update via the store snapshot the cell reads, not via this data
 * source.
 */
export class RewindTurnDataSource implements TugListViewDataSource {
  private readonly rows: readonly RewindMessageRow[];
  /** Row indices that cannot be the rewind point (cut blocked below them). */
  private blockedCuts: ReadonlySet<number> = new Set();
  private version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(rows: readonly RewindMessageRow[]) {
    this.rows = rows;
  }

  numberOfItems(): number {
    return this.rows.length;
  }

  idForIndex(index: number): string {
    // `promptUuid` is intrinsically unique per turn — a stable row id.
    return this.rows[index].promptUuid;
  }

  kindForIndex(): string {
    return REWIND_MESSAGE_KIND;
  }

  /** Unpickable while its cut is blocked — visible for context, inert. */
  enabledForIndex(index: number): boolean {
    return !this.blockedCuts.has(index);
  }

  /** Cell-renderer accessor — the message at `index`. */
  rowAt(index: number): RewindMessageRow {
    return this.rows[index];
  }

  /**
   * Replace the set of rows the line may not rest below, ticking the list.
   * Called from an effect (never during render) as `rewind_preview_result`
   * frames resolve.
   */
  setBlockedCuts(blocked: ReadonlySet<number>): void {
    this.blockedCuts = blocked;
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getVersion(): unknown {
    return this.version;
  }
}

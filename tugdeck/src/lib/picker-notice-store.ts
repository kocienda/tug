/**
 * picker-notice-store — one-shot per-card notices that survive the
 * unbind→remount cycle when the Dev picker re-presents itself.
 *
 * On resume-failed, the card observer unbinds so the picker
 * re-presents instead of silently rebranding the session under a
 * fresh claude id. The reason lives here for the picker to read
 * once and clear; nothing else persists across the remount.
 *
 * In-memory, module-scoped, single source of truth across the tab.
 * Not persisted — a reload should not surface a stale notice.
 */

/**
 * Notice categories surfaced by the Dev picker when it re-presents
 * itself after a failed, canceled, or timed-out restore.
 *
 * - `resume_failed` — tugcast emitted `SESSION_STATE: errored` for a
 *   restoring session, or the post-binding observer tripped on a
 *   resume failure.
 * - `restore_canceled` — user clicked Cancel in `SessionRestoring`.
 * - `restore_timed_out` — restore-registry timeout elapsed without
 *   either a binding or an errored response.
 * - `signed_out` — the per-session auth gate found the CLI logged out
 *   (or missing) at spawn: the card unbinds so the app-modal ConfigureTug
 *   owns re-login and the picker owns per-card resume.
 * - `spawn_failed` — tugcast rejected the `spawn_session` outright (e.g.
 *   the project directory no longer exists). The picker is itself the
 *   recovery surface — the user re-picks a directory — so this category
 *   carries no retry context; it renders an inline alert inside the
 *   re-presented picker rather than a separate banner.
 *
 * The retryable categories render a Retry button when `staleTugSessionId`
 * + `staleProjectDir` are populated; each surfaces different copy.
 */
export type PickerNoticeCategory =
  | "resume_failed"
  | "restore_canceled"
  | "restore_timed_out"
  | "signed_out"
  | "spawn_failed"
  // A spawn refused by the supervisor's own budget rather than by anything
  // wrong with the request. Split from `spawn_failed` because the remedy is
  // the opposite: `spawn_failed` means the project directory cannot be
  // opened and the picker is the recovery, whereas a budget refusal means
  // the directory was never in question and re-picking it changes nothing.
  | "spawn_budget";

export interface PickerNotice {
  category: PickerNoticeCategory;
  /** Human-readable reason from the underlying cause. */
  message: string;
  /**
   * The tug-session-id we were trying to restore, carried through so
   * the Retry button can re-fire `spawn_session(mode=resume)` against
   * the same session.
   */
  staleTugSessionId?: string;
  /** The project path associated with the stale session, for Retry. */
  staleProjectDir?: string;
}

class PickerNoticeStore {
  private map = new Map<string, PickerNotice>();

  set(cardId: string, notice: PickerNotice): void {
    this.map.set(cardId, notice);
  }

  /**
   * Read and remove the notice for `cardId`. Single-shot — the picker
   * mounts, calls `consume`, renders the banner, and the next mount
   * starts clean.
   */
  consume(cardId: string): PickerNotice | null {
    const notice = this.map.get(cardId);
    if (notice) this.map.delete(cardId);
    return notice ?? null;
  }
}

export const pickerNoticeStore = new PickerNoticeStore();

/**
 * Whether the picker should render its notice directly on the card rather
 * than waiting for the sheet to carry it.
 *
 * The picker has two ways to show a notice and must never use both at once.
 * The sheet is the richer one — it carries the path form and the notice's
 * actions — but it presents only when the card becomes first responder, so
 * that an inactive tab cannot drop a sheet over the sibling in view. That
 * left a real gap: a card whose spawn was refused while it sat inactive, and
 * which had therefore never presented, rendered an empty backdrop and gave
 * no reason at all.
 *
 * So the standing surface fills exactly the window before the sheet's first
 * presentation, and retires permanently once it has presented — from then on
 * the sheet owns the notice, including re-presenting for a rejection that
 * lands after a dismissal. `sheetEverShown` must therefore never be reset by
 * the caller; a flag that flipped back would let both surfaces mount.
 */
export function shouldShowStandingNotice(
  notice: PickerNotice | null,
  sheetEverShown: boolean,
): boolean {
  return notice !== null && !sheetEverShown;
}

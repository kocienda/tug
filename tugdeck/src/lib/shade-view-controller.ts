/**
 * shade-view-controller — per-card visibility of the transcript-slot Shades.
 *
 * The Session card's view slot holds three mutually-exclusive panes: the
 * transcript, the Changes Shade and the History Shade.
 * Which one is showing is card chrome state — a deliberate view choice — not
 * session data and not a submission target. `ShadeViewController` holds that
 * choice as a subscribable store.
 *
 * One instance per Session card body, owned via a lazy `useRef` (never in
 * `services` — it is chrome, not session data). Readers:
 *
 *   - the view-slot render, via `useSyncExternalStore` ([L02]);
 *   - `useMenuStatePublication`, via a direct subscription ([L22]);
 *   - the slash-command surfaces, which call `show` imperatively;
 *   - the toggle action handlers, which call `toggle`;
 *   - the Shade close affordances, which call `hide`.
 *
 * `"none"` is the resting state (every Shade closed). `show` is
 * mutually-exclusive: showing one Shade while another is up swaps them,
 * exactly like the old view-route flip — all three panes stay mounted and
 * only CSS visibility changes ([L26]/[L06]).
 *
 * @module lib/shade-view-controller
 */

/** Which Shade the view slot is showing; `"none"` is the transcript. */
export type ShadeView = "none" | "changes" | "history";

/** The Shades a caller can ask for by name — every `ShadeView` but `"none"`. */
export type NamedShadeView = Exclude<ShadeView, "none">;

/**
 * Per-card Shade visibility store (Spec S01). `subscribe` and
 * `getSnapshot` are stable, pre-bound references — safe to hand straight
 * to `useSyncExternalStore`; a `ShadeView` snapshot is referentially
 * stable by value.
 */
export class ShadeViewController {
  private view: ShadeView = "none";
  private readonly listeners = new Set<() => void>();

  /**
   * Subscribe to visibility commits. Returns an unsubscribe function.
   * Paired with {@link getSnapshot} this is the `useSyncExternalStore`
   * store surface.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The current Shade view — a referentially stable string snapshot. */
  getSnapshot = (): ShadeView => this.view;

  /**
   * Show a Shade. Idempotent; showing one while the other is up swaps to
   * it. A no-op (no listener fire) when that Shade is already showing.
   */
  show(view: NamedShadeView): void {
    this.commit(view);
  }

  /** Hide every Shade — the view slot returns to the transcript. */
  hide(): void {
    this.commit("none");
  }

  /** `getSnapshot() === view ? hide() : show(view)`. */
  toggle(view: NamedShadeView): void {
    this.commit(this.view === view ? "none" : view);
  }

  private commit(next: ShadeView): void {
    if (next === this.view) return;
    this.view = next;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        console.error("ShadeViewController listener threw:", err);
      }
    }
  }
}

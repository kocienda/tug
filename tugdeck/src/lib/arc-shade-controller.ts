/**
 * arc-shade-controller — whether a Session card's arc shade is raised.
 *
 * The arc shade rises from the bottom of the transcript and stands over most
 * of it. Whether it is up is card chrome state, like the Changes and History
 * shades' view choice, so it is held the same way: one subscribable store per
 * Session card body, owned through a lazy `useRef`.
 *
 * It is a store of its own rather than a fourth `ShadeView` because the two
 * differ on what they cover. A `ShadeView` shade stands over the status row
 * too, and the card takes the row's cells out of the Tab walk while one is
 * up; the arc shade leaves the row in view, because the row's ARC cell is the
 * control that lowers it. The card keeps the two mutually exclusive.
 *
 * Readers: the shade itself, through `useSyncExternalStore` ([L02]), and the
 * card's subscriptions that lower one surface when another rises ([L22]).
 *
 * @module lib/arc-shade-controller
 */

import { Subscribable } from "./subscribable";

/**
 * Per-card arc shade store. `subscribe` and `getSnapshot` are stable,
 * pre-bound references, safe to hand straight to `useSyncExternalStore`; the
 * snapshot is a boolean, so it is referentially stable by value.
 */
export class ArcShadeController extends Subscribable {
  private raised = false;

  /** Whether the shade is raised. */
  getSnapshot = (): boolean => this.raised;

  /** Raise the shade. A no-op, with no listener fire, when it is already up. */
  raise(): void {
    this.commit(true);
  }

  /** Lower the shade. A no-op, with no listener fire, when it is already down. */
  lower(): void {
    this.commit(false);
  }

  /** Raise a lowered shade, lower a raised one. */
  toggle(): void {
    this.commit(!this.raised);
  }

  private commit(next: boolean): void {
    if (next === this.raised) return;
    this.raised = next;
    this.notifyCatching((err) => {
      console.error("ArcShadeController listener threw:", err);
    });
  }
}

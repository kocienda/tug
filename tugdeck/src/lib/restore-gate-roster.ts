/**
 * restore-gate-roster — the cards a restore pass is resuming, for the
 * restore gate's count.
 *
 * `TugRestoreGate` counts sessions over a total fixed when its round opens
 * (`restore-gate-round.ts`). The restore pass (`restoreSessions`,
 * `restoreSpaceSessions` in `session-restore.ts`) knows its shown resumed
 * cards before any of their pages exists, which is what keeps that total
 * from growing as staged pages arrive. The pass writes their ids here and
 * `restore-gate-store.ts` drains them on its next fold.
 *
 * It is a leaf on purpose: `session-restore.ts` and `restore-gate-store.ts`
 * both depend on it and on nothing between them, so neither has to import
 * the other.
 *
 * Tuglaws: [L02] — a `Subscribable`; the gate store subscribes and keeps
 * the release ([L27]).
 *
 * @module lib/restore-gate-roster
 */

import { Subscribable } from "./subscribable";

class RestoreGateRoster extends Subscribable {
  private _pending: string[] = [];

  /** Name cards a restore pass is resuming. An empty list notifies nothing. */
  expect(ids: Iterable<string>): void {
    const before = this._pending.length;
    for (const id of ids) this._pending.push(id);
    if (this._pending.length > before) this.notify();
  }

  /** Every card named since the last take, in order; the inbox is left empty. */
  take(): string[] {
    const taken = this._pending;
    this._pending = [];
    return taken;
  }
}

export const restoreGateRoster = new RestoreGateRoster();

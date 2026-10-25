/**
 * spaceBindingsLedgerStore — the client-side cache of the server's card
 * bindings, held so a workspace switch can restore its sessions SYNCHRONOUSLY
 * (Spec S03, [P08]).
 *
 * The problem it solves is a race, not a performance one. `restorePassGate` is
 * one-shot and settles after boot, so a session card that mounts unbound with
 * no `sessionRestoreRegistry` expectation falls straight through to the project
 * picker. A workspace activated later mounts exactly such cards — and asking
 * the server for their bindings takes a round trip, which is several frames
 * after React has drawn the picker (Risk R02). So the answer has to already be
 * in hand at the moment of the switch, and this is where it is kept.
 *
 * The cache is filled by the boot `list_card_bindings_ok` frame, which lists
 * EVERY card id the ledger knows rather than only the active deck's — that is
 * what makes it able to answer for a workspace nobody has opened yet. A later
 * frame replaces the whole map: the server's answer is authoritative, and a
 * merge would keep rows the ledger has since dropped.
 *
 * It is kept current by asking again, never by guessing ({@link
 * SpaceBindingsLedgerStore.refreshOnPushes}). A card's session rotates mid-run
 * — every arc stage is a new segment — and a cache filled once at boot then
 * names a segment three rotations back: a workspace the user had not opened
 * would resume it, and its parked row would read its stale identity.
 *
 * React readers go through `useSyncExternalStore` ([L02]); `getSnapshot` is
 * stable by identity until a frame lands.
 */

import { Subscribable } from "./subscribable";
import type { CardBinding, SessionUpdatedPush } from "../protocol";
import {
  subscribeToListCardBindingsErr,
  subscribeToListCardBindingsOk,
  subscribeToSessionUpdated,
} from "./session-ledger-events";

class SpaceBindingsLedgerStore extends Subscribable {
  private rows: ReadonlyMap<string, CardBinding> = new Map();

  /** Whether a frame has landed, so a card with no row is one the ledger does not bind. */
  private hasLoaded = false;

  private installed = false;

  /**
   * The bus unsubscribe from {@link installOnce}. Held only so
   * {@link _resetForTest} can drop it: in production this store lives as long
   * as the page does and never unsubscribes.
   */
  private uninstall: (() => void) | null = null;

  /** The newest ledger row per card id. Stable until a frame replaces it. */
  getSnapshot = (): ReadonlyMap<string, CardBinding> => this.rows;

  /** The newest ledger row for `cardId`, or `undefined` when there is none. */
  get = (cardId: string): CardBinding | undefined => this.rows.get(cardId);

  /**
   * Whether the ledger has answered at all. Before its first frame a card
   * with no row is merely unasked about; after it, it is a card the ledger
   * binds to nothing.
   */
  loaded = (): boolean => this.hasLoaded;

  /**
   * Subscribe to `list_card_bindings_ok` exactly once. Called from
   * `installRegistrySubscriptions` in `session-restore.ts`, which is itself
   * idempotent — so this guard is belt to that braces, and is here because the
   * store is a module singleton that outlives any one restore pass.
   */
  installOnce = (): void => {
    if (this.installed) return;
    this.installed = true;
    this.uninstall = subscribeToListCardBindingsOk(({ bindings }) => {
      const next = new Map<string, CardBinding>();
      for (const binding of bindings) {
        if (!isCardBindingRow(binding)) continue;
        // Rows arrive newest-first by `last_used_at`, so the FIRST row per
        // card id is the newest — the same rule `restoreSessions` reads them
        // by, and the two must not disagree about which session a card's
        // restore targets.
        if (next.has(binding.card_id)) continue;
        next.set(binding.card_id, binding);
      }
      this.rows = next;
      this.hasLoaded = true;
      this.notify();
    });
  };

  /**
   * Re-ask the server (`ask` sends `list_card_bindings`) whenever a ledger push
   * says a card's row has moved past what this cache holds: a live segment on a
   * card the cache seats elsewhere or not at all — a rotation, a rewind, a
   * fresh spawn — or the removal of a segment it seats a card on.
   *
   * The push is the event, so this watches rather than polls, and the server
   * still chooses which segment a line resumes ([P06]); the cache never derives
   * one from a push. One request is in flight at a time, and pushes that land
   * while it is out ask once more after the answer, so a burst costs two.
   * Returns the release.
   */
  refreshOnPushes = (ask: () => void): (() => void) => {
    let inFlight = false;
    let again = false;
    const send = (): void => {
      inFlight = true;
      again = false;
      ask();
    };
    const settle = (): void => {
      if (!inFlight) return;
      inFlight = false;
      if (again) send();
    };
    const releases = [
      subscribeToListCardBindingsOk(settle),
      subscribeToListCardBindingsErr(settle),
      subscribeToSessionUpdated((push) => {
        if (!this.hasLoaded || !this.isPassedBy(push)) return;
        if (inFlight) again = true;
        else send();
      }),
    ];
    return () => {
      for (const release of releases) release();
    };
  };

  /** Whether `push` names a seat this cache does not hold ({@link refreshOnPushes}). */
  private isPassedBy(push: SessionUpdatedPush): boolean {
    if (push.removed === true) {
      for (const row of this.rows.values()) if (row.session_id === push.session_id) return true;
      return false;
    }
    const fields = push.fields;
    // A background owner's id is no deck card's, and a closed or failed
    // segment is never the one a line resumes over a live one.
    if (fields === undefined || fields.card_id === null || fields.background) return false;
    if (fields.state !== "live") return false;
    return this.rows.get(fields.card_id)?.session_id !== push.session_id;
  }

  /** Test seam: drop every row and the install guard. */
  _resetForTest = (): void => {
    // The bus subscription too — leaving it behind would make the next
    // `installOnce` a SECOND subscriber, and every later frame would be
    // folded once per test that had run before it.
    this.uninstall?.();
    this.uninstall = null;
    this.rows = new Map();
    this.hasLoaded = false;
    this.installed = false;
    this.clearListeners();
  };
}

function isCardBindingRow(value: unknown): value is CardBinding {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.card_id === "string" &&
    obj.card_id.length > 0 &&
    typeof obj.session_id === "string" &&
    obj.session_id.length > 0 &&
    typeof obj.project_dir === "string" &&
    obj.project_dir.length > 0 &&
    typeof obj.turn_count === "number"
  );
}

export const spaceBindingsLedgerStore = new SpaceBindingsLedgerStore();

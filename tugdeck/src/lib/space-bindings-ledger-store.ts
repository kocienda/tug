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
 * React readers go through `useSyncExternalStore` ([L02]); `getSnapshot` is
 * stable by identity until a frame lands.
 */

import type { CardBinding } from "../protocol";
import { subscribeToListCardBindingsOk } from "./session-ledger-events";

class SpaceBindingsLedgerStore {
  private rows: ReadonlyMap<string, CardBinding> = new Map();

  private subscribers: Set<() => void> = new Set();

  private installed = false;

  /**
   * The bus unsubscribe from {@link installOnce}. Held only so
   * {@link _resetForTest} can drop it: in production this store lives as long
   * as the page does and never unsubscribes.
   */
  private uninstall: (() => void) | null = null;

  subscribe = (callback: () => void): (() => void) => {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  };

  /** The newest ledger row per card id. Stable until a frame replaces it. */
  getSnapshot = (): ReadonlyMap<string, CardBinding> => this.rows;

  /** The newest ledger row for `cardId`, or `undefined` when there is none. */
  get = (cardId: string): CardBinding | undefined => this.rows.get(cardId);

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
      for (const callback of this.subscribers) callback();
    });
  };

  /** Test seam: drop every row and the install guard. */
  _resetForTest = (): void => {
    // The bus subscription too — leaving it behind would make the next
    // `installOnce` a SECOND subscriber, and every later frame would be
    // folded once per test that had run before it.
    this.uninstall?.();
    this.uninstall = null;
    this.rows = new Map();
    this.installed = false;
    this.subscribers.clear();
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

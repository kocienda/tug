/**
 * `CardsStore` — module-scope owner of the Cards card's persisted presentation
 * state: the order of the rows within each group, the order of the groups, and
 * which groups are collapsed.
 *
 * The store is constructed lazily on first read so tests that never touch the
 * Cards card pay zero cost. It:
 *   1. Hydrates from tugbank (`dev.tugapp.cards`, falling back to the legacy
 *      `dev.tugapp.lens` per key) once the cache is available.
 *   2. Listens for live tugbank pushes on either domain so external writes
 *      take effect immediately.
 *   3. Persists every mutation back to tugbank via PUT — to the new domain
 *      only.
 *   4. Notifies subscribers ([L02]) — React reads via `useSyncExternalStore`.
 *
 * None of the card's geometry is here. Whether the rail stands and how wide it
 * is live in the deck layout blob; the width it REOPENS at lives in
 * `sidebarWidthStore`, on this same domain and key, which owns every read and
 * write of it. The one thing this store does with that key is seed it once
 * from the legacy domain, so a width the user chose by hand is not silently
 * replaced by the registration's default.
 *
 * Conformance:
 *   - [L02] `useSyncExternalStore`-compatible `subscribe` + `getSnapshot`;
 *     references stay stable when state is unchanged.
 *   - [L23] state survives HMR / reloads via tugbank persistence.
 *   - `feedback_no_localstorage`: no localStorage / sessionStorage.
 *
 * @module components/cards/cards-store/cards-store
 */

import { getTugbankClient } from "@/lib/tugbank-singleton";
import type { TaggedValue } from "@/lib/tugbank-client";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import {
  createInitialState,
  reduce,
  toSnapshot,
  type CardsEvent,
  type CardsState,
} from "./reducer";
import type { CardsGroup } from "@/components/cards/cards-groups";
import { GROUP_ORDER } from "@/components/cards/cards-groups";
import {
  CARDS_DOMAIN,
  CARDS_KEYS,
  LEGACY_CARDS_DOMAIN,
  WIDTH_PX_KEY,
  type CardsRowOrder,
  type CardsSnapshot,
} from "./types";

class CardsStore {
  private _state: CardsState = createInitialState();
  private readonly _listeners = new Set<() => void>();
  private _tugbankUnsub: (() => void) | null = null;
  private _initialized = false;
  private _widthSeeded = false;

  private _ensureInitialized(): void {
    if (this._initialized) return;
    this._initialized = true;

    const client = getTugbankClient();
    if (!client) return;

    this._seedLegacyWidth();
    this._hydrateFromTugbank();

    this._tugbankUnsub = client.onDomainChanged((domain) => {
      if (domain === CARDS_DOMAIN || domain === LEGACY_CARDS_DOMAIN) {
        this._seedLegacyWidth();
        this._hydrateFromTugbank();
      }
    });
  }

  /**
   * Carry a hand-chosen reopen width across the domain move, once.
   *
   * `sidebarWidthStore` reads `dev.tugapp.cards` / `widthPx` and knows
   * nothing about the legacy address; a user whose width lives only at the old
   * one would find their rail silently back at the registration's default. So
   * the value is copied — a write rather than a read fallback, because the
   * reader is another module and a second fallback there would be a second
   * answer to one question.
   *
   * Guarded on the new address being empty, so it can never overwrite a width
   * the user has since chosen, and latched so a domain push cannot re-run it.
   */
  private _seedLegacyWidth(): void {
    if (this._widthSeeded) return;
    const client = getTugbankClient();
    if (!client) return;
    if (client.get(CARDS_DOMAIN, WIDTH_PX_KEY) !== undefined) {
      this._widthSeeded = true;
      return;
    }
    const legacy = client.get(LEGACY_CARDS_DOMAIN, WIDTH_PX_KEY);
    if (legacy === undefined) return;
    const width = readNumber(legacy);
    if (width === undefined) {
      this._widthSeeded = true;
      return;
    }
    this._widthSeeded = true;
    putRaw(WIDTH_PX_KEY, { kind: "i64", value: Math.round(width) });
  }

  /**
   * Read a key from the new domain, falling back to the legacy one.
   *
   * The fallback is per key rather than per domain: a user may have written
   * one of the three since the move and none of the others, and a whole-record
   * fallback would drop the two that had not moved yet.
   */
  private _read(key: string): TaggedValue | undefined {
    const client = getTugbankClient();
    if (!client) return undefined;
    return (
      client.get(CARDS_DOMAIN, key) ?? client.get(LEGACY_CARDS_DOMAIN, key)
    );
  }

  private _hydrateFromTugbank(): void {
    const client = getTugbankClient();
    if (!client) return;
    // Group names are a closed set, but the collapsed list is read with the
    // same tolerant reader as every other list — an unknown entry is inert,
    // and rejecting the whole value over one would lose real state.
    const collapsedCardGroups = readStringArray(
      this._read(CARDS_KEYS.CARDS_COLLAPSED_GROUPS),
    );
    // Same tolerance for the group ORDER: the projection filters it against
    // the live group set on every build, so an unknown name costs nothing and
    // a missing one falls back to its built-in position.
    const cardsGroupOrder = readStringArray(
      this._read(CARDS_KEYS.CARDS_GROUP_ORDER),
    );
    const cardsRowOrder = readCardsRowOrder(
      this._read(CARDS_KEYS.CARDS_ROW_ORDER),
    );
    this._dispatch(
      {
        type: "hydrate",
        ...(cardsRowOrder !== undefined ? { cardsRowOrder } : {}),
        ...(cardsGroupOrder !== undefined ? { cardsGroupOrder } : {}),
        ...(collapsedCardGroups !== undefined ? { collapsedCardGroups } : {}),
      },
      { persist: false },
    );
  }

  private _dispatch(
    event: CardsEvent,
    options: { persist: boolean } = { persist: true },
  ): void {
    const prev = this._state;
    const next = reduce(prev, event);
    if (next === prev) return;
    this._state = next;
    if (options.persist) {
      this._persistDiff(prev, next);
    }
    for (const listener of this._listeners) {
      try {
        listener();
      } catch (err) {
        console.warn("[CardsStore] listener error:", err);
      }
    }
  }

  private _persistDiff(prev: CardsState, next: CardsState): void {
    if (prev.cardsRowOrder !== next.cardsRowOrder) {
      putJson(CARDS_KEYS.CARDS_ROW_ORDER, next.cardsRowOrder);
    }
    if (prev.cardsGroupOrder !== next.cardsGroupOrder) {
      putJson(CARDS_KEYS.CARDS_GROUP_ORDER, next.cardsGroupOrder);
    }
    if (prev.collapsedCardGroups !== next.collapsedCardGroups) {
      putJson(CARDS_KEYS.CARDS_COLLAPSED_GROUPS, next.collapsedCardGroups);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this._ensureInitialized();
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  getSnapshot = (): CardsSnapshot => {
    this._ensureInitialized();
    return toSnapshot(this._state);
  };

  /**
   * Replace one group's pane-row order, by order key. Other groups keep their
   * lists and their references. Persists.
   */
  setCardsRowOrder = (group: CardsGroup, order: readonly string[]): void => {
    this._ensureInitialized();
    this._dispatch({ type: "set_cards_row_order", group, order });
  };

  /**
   * Replace the group order — the runs themselves, as carried by a group
   * header. Persists.
   */
  setCardsGroupOrder = (order: readonly string[]): void => {
    this._ensureInitialized();
    this._dispatch({ type: "set_cards_group_order", order });
  };

  /** Expand/collapse one group. Persists. */
  setCardGroupCollapsed = (group: CardsGroup, collapsed: boolean): void => {
    this._ensureInitialized();
    this._dispatch({ type: "set_cards_group_collapsed", group, collapsed });
  };

  /**
   * Test seam — dispose tugbank subscription and reset. Production never
   * tears the store down (it lives for the app's lifetime).
   * @internal
   */
  _disposeForTest(): void {
    if (this._tugbankUnsub) {
      this._tugbankUnsub();
      this._tugbankUnsub = null;
    }
    this._listeners.clear();
    this._state = createInitialState();
    this._initialized = false;
    this._widthSeeded = false;
  }
}

export const cardsStore = new CardsStore();

// ---------------------------------------------------------------------------
// Internal — tugbank value helpers
// ---------------------------------------------------------------------------

function readNumber(entry: TaggedValue | undefined): number | undefined {
  if (!entry) return undefined;
  if (
    (entry.kind === "i64" || entry.kind === "f64") &&
    typeof entry.value === "number" &&
    Number.isFinite(entry.value)
  ) {
    return entry.value;
  }
  return undefined;
}

/**
 * Read a persisted `string[]`. A malformed entry (wrong kind, non-array,
 * or a non-string element) is rejected as `undefined` so the reducer
 * keeps the existing value — the reject-and-keep hydrate discipline.
 * A well-formed empty array is meaningful and preserved.
 */
function readStringArray(
  entry: TaggedValue | undefined,
): readonly string[] | undefined {
  if (!entry || entry.kind !== "json") return undefined;
  const v = entry.value;
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") return undefined;
    out.push(x);
  }
  return out;
}

/**
 * Read the persisted per-group row order. Same reject-and-keep discipline as
 * {@link readStringArray}, applied per group: a malformed group list rejects
 * the whole record rather than half-hydrating one group's arrangement from a
 * value the writer never produced. A group missing from the record reads as
 * empty, so a record written before a group existed still hydrates.
 */
function readCardsRowOrder(
  entry: TaggedValue | undefined,
): CardsRowOrder | undefined {
  if (!entry || entry.kind !== "json") return undefined;
  const v = entry.value;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const record = v as Record<string, unknown>;
  const out: Record<string, readonly string[]> = {};
  for (const group of GROUP_ORDER) {
    const raw = record[group];
    if (raw === undefined) {
      out[group] = [];
      continue;
    }
    const list = readStringArray({ kind: "json", value: raw } as TaggedValue);
    if (list === undefined) return undefined;
    out[group] = list;
  }
  return out as CardsRowOrder;
}

function putJson(key: string, value: unknown): void {
  putRaw(key, { kind: "json", value });
}

interface RawTaggedBody {
  kind: string;
  value: unknown;
}

function putRaw(key: string, body: RawTaggedBody): void {
  const client = getTugbankClient();
  if (client && typeof client.setLocalValue === "function") {
    client.setLocalValue(CARDS_DOMAIN, key, body as TaggedValue);
  }
  fetch(`/api/defaults/${CARDS_DOMAIN}/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => {
    tugDevLogStore.warn("cards-store", `_persistDiff PUT ${key} failed`, {
      error: String(err),
    });
  });
}

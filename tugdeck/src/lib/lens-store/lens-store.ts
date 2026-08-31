/**
 * `LensStore` — module-scope owner of the Lens panel's persisted
 * arrangement state (section order, per-section collapse, and the
 * preferred reopen width).
 *
 * The store is constructed lazily on first read so tests that never
 * touch the Lens pay zero cost. It:
 *   1. Hydrates from tugbank (`dev.tugtool.lens`) once the cache is
 *      available.
 *   2. Listens for live tugbank pushes on the same domain so external
 *      writes take effect immediately.
 *   3. Persists every mutation back to tugbank via PUT.
 *   4. Notifies subscribers ([L02]) — React reads via
 *      `useSyncExternalStore`.
 *
 * The Lens's live open/width geometry is NOT here — it lives in the deck
 * layout blob as anchored-pane presence + `size.width`. This store holds
 * only the section arrangement and the *reopen* width.
 *
 * Conformance:
 *   - [L02] `useSyncExternalStore`-compatible `subscribe` +
 *     `getSnapshot`; references stay stable when state is unchanged.
 *   - [L23] state survives HMR / reloads via tugbank persistence.
 *   - `feedback_no_localstorage`: no localStorage / sessionStorage.
 *
 * @module lib/lens-store/lens-store
 */

import { getTugbankClient } from "../tugbank-singleton";
import type { TaggedValue } from "../tugbank-client";
import { tugDevLogStore } from "../tug-dev-log-store/tug-dev-log-store";
import {
  createInitialState,
  reduce,
  toSnapshot,
  type LensEvent,
  type LensState,
} from "./reducer";
import type { CardsGroup } from "@/components/cards/cards-groups";
import { GROUP_ORDER } from "@/components/cards/cards-groups";
import {
  LENS_DOMAIN,
  LENS_KEYS,
  type LensCardsRowOrder,
  type LensSnapshot,
} from "./types";

class LensStore {
  private _state: LensState = createInitialState();
  private readonly _listeners = new Set<() => void>();
  private _tugbankUnsub: (() => void) | null = null;
  private _initialized = false;

  private _ensureInitialized(): void {
    if (this._initialized) return;
    this._initialized = true;

    const client = getTugbankClient();
    if (!client) return;

    this._hydrateFromTugbank();

    this._tugbankUnsub = client.onDomainChanged((domain) => {
      if (domain === LENS_DOMAIN) {
        this._hydrateFromTugbank();
      }
    });
  }

  private _hydrateFromTugbank(): void {
    const client = getTugbankClient();
    if (!client) return;
    const widthPx = readNumber(client.get(LENS_DOMAIN, LENS_KEYS.WIDTH_PX));
    const sectionOrder = migrateKinds(
      readStringArray(client.get(LENS_DOMAIN, LENS_KEYS.SECTION_ORDER)),
    );
    // Session ids are opaque — no `KIND_MIGRATIONS` remap (that maps renamed
    // section kinds, not session ids).
    const sessionOrder = readStringArray(
      client.get(LENS_DOMAIN, LENS_KEYS.SESSION_ORDER),
    );
    // Card ids are opaque, like session ids — no `KIND_MIGRATIONS` remap.
    const textFileOrder = readStringArray(
      client.get(LENS_DOMAIN, LENS_KEYS.TEXT_FILE_ORDER),
    );
    const collapsedSections = migrateKinds(
      readStringArray(client.get(LENS_DOMAIN, LENS_KEYS.COLLAPSED_SECTIONS)),
    );
    // Group names are a closed set, but the collapsed list is read with the
    // same tolerant reader as every other kind list — an unknown entry is
    // inert, and rejecting the whole value over one would lose real state.
    const collapsedCardGroups = readStringArray(
      client.get(LENS_DOMAIN, LENS_KEYS.CARDS_COLLAPSED_GROUPS),
    );
    // Same tolerance for the group ORDER: the projection filters it against
    // the live group set on every build, so an unknown name costs nothing and
    // a missing one falls back to its built-in position.
    const cardsGroupOrder = readStringArray(
      client.get(LENS_DOMAIN, LENS_KEYS.CARDS_GROUP_ORDER),
    );
    // A user arriving from the Sessions/Files era has no `cardsRowOrder` yet
    // but does have the two lists it supersedes, and those lists are exactly
    // the two groups' orders. Seeding from them carries the arrangement
    // through the swap instead of resetting it. Once `cardsRowOrder` exists
    // the legacy keys are never consulted again.
    const storedRowOrder = readCardsRowOrder(
      client.get(LENS_DOMAIN, LENS_KEYS.CARDS_ROW_ORDER),
    );
    const cardsRowOrder =
      storedRowOrder ??
      (sessionOrder !== undefined || textFileOrder !== undefined
        ? {
            sessions: sessionOrder ?? [],
            files: textFileOrder ?? [],
            tools: [],
          }
        : undefined);
    this._dispatch(
      {
        type: "hydrate",
        ...(widthPx !== undefined ? { widthPx } : {}),
        ...(sectionOrder !== undefined ? { sectionOrder } : {}),
        ...(cardsRowOrder !== undefined ? { cardsRowOrder } : {}),
        ...(cardsGroupOrder !== undefined ? { cardsGroupOrder } : {}),
        ...(collapsedCardGroups !== undefined ? { collapsedCardGroups } : {}),
        ...(collapsedSections !== undefined ? { collapsedSections } : {}),
      },
      { persist: false },
    );
  }

  private _dispatch(
    event: LensEvent,
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
        console.warn("[LensStore] listener error:", err);
      }
    }
  }

  private _persistDiff(prev: LensState, next: LensState): void {
    if (prev.widthPx !== next.widthPx) {
      putNumber(LENS_KEYS.WIDTH_PX, next.widthPx);
    }
    if (prev.sectionOrder !== next.sectionOrder) {
      putJson(LENS_KEYS.SECTION_ORDER, next.sectionOrder);
    }
    if (prev.cardsRowOrder !== next.cardsRowOrder) {
      putJson(LENS_KEYS.CARDS_ROW_ORDER, next.cardsRowOrder);
    }
    if (prev.cardsGroupOrder !== next.cardsGroupOrder) {
      putJson(LENS_KEYS.CARDS_GROUP_ORDER, next.cardsGroupOrder);
    }
    if (prev.collapsedCardGroups !== next.collapsedCardGroups) {
      putJson(LENS_KEYS.CARDS_COLLAPSED_GROUPS, next.collapsedCardGroups);
    }
    if (prev.collapsedSections !== next.collapsedSections) {
      putJson(LENS_KEYS.COLLAPSED_SECTIONS, next.collapsedSections);
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

  getSnapshot = (): LensSnapshot => {
    this._ensureInitialized();
    return toSnapshot(this._state);
  };

  /**
   * Set the preferred reopen width in pixels. Clamped to the floor in
   * the reducer; the component-side viewport ceiling is enforced before
   * this is called. Persists so a hide→show cycle restores the size.
   */
  setWidth = (widthPx: number): void => {
    this._ensureInitialized();
    this._dispatch({ type: "set_width", widthPx });
  };

  /** Replace the persisted section order. Persists. */
  setSectionOrder = (order: readonly string[]): void => {
    this._ensureInitialized();
    this._dispatch({ type: "set_section_order", order });
  };

  /**
   * Replace one Cards-section group's pane-row order, by order key. Other
   * groups keep their lists and their references. Persists.
   */
  setCardsRowOrder = (
    group: CardsGroup,
    order: readonly string[],
  ): void => {
    this._ensureInitialized();
    this._dispatch({ type: "set_cards_row_order", group, order });
  };

  /**
   * Replace the Cards section's group order — the runs themselves, as carried
   * by a group header. Persists.
   */
  setCardsGroupOrder = (order: readonly string[]): void => {
    this._ensureInitialized();
    this._dispatch({ type: "set_cards_group_order", order });
  };

  /** Expand/collapse one Cards-section group. Persists. */
  setCardGroupCollapsed = (
    group: CardsGroup,
    collapsed: boolean,
  ): void => {
    this._ensureInitialized();
    this._dispatch({ type: "set_cards_group_collapsed", group, collapsed });
  };

  /** Expand/collapse a section by kind. Persists. */
  setCollapsed = (kind: string, collapsed: boolean): void => {
    this._ensureInitialized();
    this._dispatch({ type: "set_collapsed", kind, collapsed });
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
  }
}

export const lensStore = new LensStore();

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
 * Section-`kind` renames applied on hydrate so a user's persisted
 * arrangement state (order / collapsed) survives a section
 * being renamed. Maps old kind → new kind; unknown kinds pass through.
 * The remapped state re-persists on the next mutation, self-healing the
 * stored value.
 */
const KIND_MIGRATIONS: Readonly<Record<string, string>> = {
  // Every retired kind maps to its TERMINAL successor, never to an
  // intermediate one: the remap is a single pass, so a chain would strand a
  // user whose persisted state predates the second rename. `"changeset"` and
  // `"text-files"` both pass through kinds that are themselves now retired,
  // and both must therefore name `"cards"` directly.
  //
  // The Sessions and Files sections folded into the one Cards section, so a
  // user who had both persisted lands two `"cards"` entries in each list;
  // `resolveSectionRenderOrder`'s `seen` set dedupes the order, and
  // `withMembership` tolerates the doubled collapse entry.
  changeset: "cards",
  "text-files": "cards",
  sessions: "cards",
  files: "cards",
};

function migrateKinds(
  kinds: readonly string[] | undefined,
): readonly string[] | undefined {
  if (kinds === undefined) return undefined;
  let changed = false;
  const out = kinds.map((kind) => {
    const to = KIND_MIGRATIONS[kind];
    if (to !== undefined && to !== kind) {
      changed = true;
      return to;
    }
    return kind;
  });
  return changed ? out : kinds;
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
): LensCardsRowOrder | undefined {
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
  return out as LensCardsRowOrder;
}

/**
 * Read the persisted anchor side. A missing or malformed entry returns
 * `undefined` so the reducer keeps the default; any present string is
 * coerced to a valid side.
 */
function putNumber(key: string, value: number): void {
  putRaw(key, { kind: "i64", value: Math.round(value) });
}

function putString(key: string, value: string): void {
  putRaw(key, { kind: "string", value });
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
    client.setLocalValue(LENS_DOMAIN, key, body as TaggedValue);
  }
  fetch(`/api/defaults/${LENS_DOMAIN}/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => {
    tugDevLogStore.warn("lens-store", `_persistDiff PUT ${key} failed`, {
      error: String(err),
    });
  });
}

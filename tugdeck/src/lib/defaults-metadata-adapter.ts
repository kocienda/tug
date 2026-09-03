/**
 * DefaultsMetadataAdapter — a read-only `SessionMetadataStore` stand-in over
 * the deck-default stores + the persisted model catalog.
 *
 * The Settings card edits the deck-wide default Model / Permission Mode /
 * Effort through the *same* chips + sheets the Session card's Z4B row uses. Those
 * components consume a {@link ReadableMetadataStore} (`subscribe` +
 * `getSnapshot → SessionMetadataSnapshot`); this adapter satisfies that shape
 * by composing `DefaultModelStore` / `DefaultPermissionModeStore` /
 * `DefaultEffortStore` with `readModelCatalog()`, so the chips render rich,
 * byte-identical labels with no live session behind them.
 *
 * Snapshot mapping: `model` is the deck-default SELECTOR, verbatim — the
 * adapter does NOT pre-compute a label. Every chip resolves its model string
 * (id, selector, or optimistic label) through the single
 * `resolveModelLabel` path in [model-label.ts], so the Settings chip and the
 * Z4B chip render byte-identical titles for the same state by construction —
 * there is no adapter-side label to drift. `models` is the persisted catalog
 * (empty when none exists yet), which gives the sheets their options and
 * lets the effort chip resolve per-model support. The remaining session
 * fields are inert (`sessionId` / `cwd` / `version` `null`, `slashCommands`
 * empty).
 *
 * The snapshot is memoized: `getSnapshot` returns a cached object, rebuilt
 * only when a composed source actually changed — `useSyncExternalStore`
 * requires that reference stability, or the chips would re-render every read.
 * The catalog is re-read only on a `dev.tugapp.models` domain change, and an
 * equal-content re-read keeps the prior array reference.
 *
 * The adapter owns the three default stores (it constructs them) and exposes
 * them so the Settings pickers can target their `set` writes; `dispose()`
 * tears everything down.
 *
 * **Laws:** [L02] useSyncExternalStore-compatible subscribe/getSnapshot.
 *
 * @module lib/defaults-metadata-adapter
 */

import { getTugbankClient } from "./tugbank-singleton";
import type {
  CapabilityModel,
  SessionMetadataSnapshot,
} from "./session-metadata-store";
import { DefaultModelStore } from "./default-model-store";
import { DefaultEffortStore } from "./default-effort-store";
import { DefaultPermissionModeStore } from "./default-permission-mode-store";
import { MODEL_CATALOG_DOMAIN, readModelCatalog } from "./model-catalog";

/**
 * Build the defaults-shaped metadata snapshot. Pure — every input is a
 * parameter — and memoized on its last invocation: calling it again with
 * identical inputs (selector / mode / effort by value, catalog by reference)
 * returns the same object, which is what keeps `useSyncExternalStore`
 * consumers from re-rendering on a no-op rebuild.
 */
export function buildDefaultsSnapshot(
  modelSelector: string,
  permissionMode: string,
  effort: string,
  catalog: CapabilityModel[] | null,
): SessionMetadataSnapshot {
  const last = lastBuild;
  if (
    last !== null &&
    last.modelSelector === modelSelector &&
    last.permissionMode === permissionMode &&
    last.effort === effort &&
    last.catalog === catalog
  ) {
    return last.snapshot;
  }
  const snapshot: SessionMetadataSnapshot = {
    sessionId: null,
    model: modelSelector,
    permissionMode,
    cwd: null,
    version: null,
    slashCommands: [],
    models: catalog ?? [],
    effort,
  };
  lastBuild = { modelSelector, permissionMode, effort, catalog, snapshot };
  return snapshot;
}

let lastBuild: {
  modelSelector: string;
  permissionMode: string;
  effort: string;
  catalog: CapabilityModel[] | null;
  snapshot: SessionMetadataSnapshot;
} | null = null;

export class DefaultsMetadataAdapter {
  /** The deck-default model selector store — the model picker's write target. */
  readonly modelStore: DefaultModelStore;
  /** The deck-default effort store — the effort picker's write target. */
  readonly effortStore: DefaultEffortStore;
  /** The deck-default permission-mode store — the mode sheet's write target. */
  readonly permissionModeStore: DefaultPermissionModeStore;

  private _catalog: CapabilityModel[] | null;
  private _snapshot: SessionMetadataSnapshot;
  private _listeners: Set<() => void> = new Set();
  private _unsubscribes: Array<() => void> = [];

  constructor() {
    this.modelStore = new DefaultModelStore();
    this.effortStore = new DefaultEffortStore();
    this.permissionModeStore = new DefaultPermissionModeStore();
    this._catalog = readModelCatalog();
    this._snapshot = this._build();

    this._unsubscribes.push(
      this.modelStore.subscribe(this._recompute),
      this.effortStore.subscribe(this._recompute),
      this.permissionModeStore.subscribe(this._recompute),
    );

    const client = getTugbankClient();
    if (client) {
      this._unsubscribes.push(
        client.onDomainChanged((domain) => {
          if (domain !== MODEL_CATALOG_DOMAIN) return;
          const fresh = readModelCatalog();
          // An equal-content re-read keeps the prior array reference so the
          // memoized snapshot survives a no-op catalog write.
          if (JSON.stringify(fresh) !== JSON.stringify(this._catalog)) {
            this._catalog = fresh;
          }
          this._recompute();
        }),
      );
    }
  }

  private _build(): SessionMetadataSnapshot {
    return buildDefaultsSnapshot(
      this.modelStore.getSnapshot(),
      this.permissionModeStore.getSnapshot(),
      this.effortStore.getSnapshot(),
      this._catalog,
    );
  }

  private _recompute = (): void => {
    const next = this._build();
    if (next === this._snapshot) return;
    this._snapshot = next;
    for (const listener of this._listeners) listener();
  };

  /** Current defaults-shaped snapshot. (L02 — useSyncExternalStore) */
  getSnapshot = (): SessionMetadataSnapshot => this._snapshot;

  /** Subscribe to changes in any composed source. Returns unsubscribe. (L02) */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  };

  /** Tear down all source subscriptions and the stores the adapter owns. */
  dispose(): void {
    for (const unsubscribe of this._unsubscribes) unsubscribe();
    this._unsubscribes = [];
    this._listeners.clear();
    this.modelStore.dispose();
    this.effortStore.dispose();
    this.permissionModeStore.dispose();
  }
}

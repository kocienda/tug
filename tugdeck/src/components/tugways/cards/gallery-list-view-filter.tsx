/**
 * GalleryListViewFilter — visual showcase + smoke test for
 * `useFilteredDataSource`, and the living contract for `TugFilterField`'s
 * wrapper-style wiring.
 *
 * Mounts a `TugFilterField` above a `TugListView`; the field's delegate
 * writes the host's `query` state, which drives a predicate the list view
 * consumes via `useFilteredDataSource`. The card demonstrates the
 * UISearchController-style split landed in Phase 1 [D01]: the host
 * owns the search field; the primitive consumes a derived data
 * source. The `TugFilterField` is OUTSIDE the list view's DOM tree.
 *
 * **Two sanctioned filter mechanisms, and why this one is here.** The
 * product surfaces (session picker, `/resume`, the rail cards) filter
 * *inside* their own data source's `recompute()`, because their cell
 * renderers are typed against a concrete data source and would otherwise
 * have to translate every index through `baseIndexFor` — an index-confusion
 * hazard. This card keeps the generic **wrapper** path, which is the right
 * choice when cells do not depend on a concrete data-source type (and the
 * composition point for a future `useSortedDataSource` / grouping wrapper).
 * Wrapper for untyped composition, in-source for typed cells; this card is
 * the wrapper path's living contract.
 *
 * Matching uses the shared `filterQueryMatch` / `renderFilterHighlight`
 * pair — the same fuzzy, multi-term, membership-only semantics every
 * filtered list in the app uses, painting the same `<mark>` spans in the
 * one find-paint color.
 *
 * The synthetic data is 50 fictional project paths with diverse
 * owners, roots, and project names so filtering produces
 * visually distinct narrowings — typing `tugtool` collapses to a
 * handful of matches; typing `/Users/Alex/` collapses to ten. Path-
 * shaped data also previews the eventual picker UX (Phase 2): the
 * picker's `path-recent` rows match this rough shape.
 *
 * Manual smoke (this card's reason for existing):
 *   - Type characters into the field — the list narrows to items whose
 *     path fuzzily matches; the matched spans are highlighted in each row.
 *   - Type `TUGTOOL` (uppercase) — the same rows match as `tugtool`,
 *     and the highlight covers the original-case span in each path.
 *   - Type two terms (`alex tug`) — both must match, in either order.
 *   - Backspace — the list widens. Scroll position should be stable
 *     across filter changes (no jumps to top, no flicker).
 *   - Click into a non-empty field — its contents come up fully selected;
 *     the ✕ clears it; Escape clears it without dismissing anything.
 *   - The "X of Y" diagnostic above the list reflects the live
 *     filtered count vs. the base count.
 *   - The cell renderer shows each row's filtered index AND its base
 *     index, so the `baseIndexFor` mapping is visible.
 *
 * Laws:
 *  - [L02] data source enters React via `useSyncExternalStore` (the
 *    list view's contract; the filter wrapper is itself such a store
 *    via `getVersion` / `subscribe`).
 *  - [L19] gallery-card authoring (module docstring, exported
 *    component, registered in `gallery-registrations.tsx`).
 *  - [L20] visual treatment via inline styles scoped to this card's
 *    cell renderer; no reach into `--tugx-list-view-*`.
 *
 * Decisions:
 *  - tugplan-session-picker-redesign [D01] uitableview-search-split —
 *    the host owns the input.
 *  - [Spec S06] — `useFilteredDataSource(base, predicate, filterToken)`
 *    contract; `query` (a useState string) drives both the predicate
 *    closure's capture AND the `filterToken`.
 *
 * Cell-renderer / base-binding pattern:
 *  - The wrapper exposes `baseIndexFor(filteredIndex)` for index
 *    translation, but typed extension methods (`itemAt`, `rowAt`)
 *    live on the BASE data source, not the wrapper. The canonical
 *    pattern is to build cell renderers inside the host so the
 *    closure captures the base reference; renderers route through
 *    `baseIndexFor` to translate the wrapper index, then read the
 *    typed extension on the captured base. That's what this card
 *    does — see the `useMemo` block below.
 */

import "./gallery.css";

import React from "react";

import { renderFilterHighlight } from "@/components/tugways/filter-highlight";
import {
  TugFilterField,
  type TugFilterFieldDelegate,
} from "@/components/tugways/tug-filter-field";
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewDataSource,
} from "@/components/tugways/tug-list-view";
import {
  useFilteredDataSource,
  type FilteredTugListViewDataSource,
} from "@/components/tugways/use-filtered-data-source";
import { filterQueryMatch } from "@/lib/text-match";

// ---------------------------------------------------------------------------
// Synthetic data source
// ---------------------------------------------------------------------------

interface PathItem {
  readonly id: string;
  readonly kind: string;
  readonly path: string;
}

/**
 * Build 50 fictional project paths. Five owners × five roots × two
 * projects per (owner, root) cell — yields a list with multiple
 * overlapping prefixes and suffixes so substring filtering produces
 * visually distinct narrowings.
 */
function buildItems(): PathItem[] {
  const owners = ["Alex", "Ben", "Cory", "Dana", "Ellie"];
  const roots = ["projects", "src", "Mounts/u", "Documents", "code"];
  const projects = [
    "tugtool",
    "wisdom",
    "atlas",
    "horizon",
    "echo",
    "mosaic",
    "summit",
    "harbor",
    "delta",
    "axiom",
  ];
  const items: PathItem[] = [];
  let i = 0;
  for (const owner of owners) {
    for (const root of roots) {
      for (let p = 0; p < 2; p += 1) {
        const project = projects[(i + p) % projects.length];
        items.push({
          id: `id-${i}`,
          kind: "path",
          path: `/Users/${owner}/${root}/${project}`,
        });
        i += 1;
      }
    }
  }
  return items;
}

class GalleryListViewFilterDataSource implements TugListViewDataSource {
  private readonly items: ReadonlyArray<PathItem>;
  private readonly listeners = new Set<() => void>();

  constructor(items: ReadonlyArray<PathItem>) {
    this.items = items;
  }

  numberOfItems(): number {
    return this.items.length;
  }

  idForIndex(index: number): string {
    return this.items[index].id;
  }

  kindForIndex(index: number): string {
    return this.items[index].kind;
  }

  /** Cell-renderer accessor — reads the full path item at `index`. */
  itemAt(index: number): PathItem {
    return this.items[index];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Static data — version is constant. `useSyncExternalStore` compares
   * with `Object.is`; a constant satisfies the "no spurious re-render"
   * contract because identity never changes.
   */
  getVersion(): unknown {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Cell-renderer styles
// ---------------------------------------------------------------------------

const PATH_CELL_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "var(--tug-space-sm)",
  padding: "var(--tug-space-xs) var(--tug-space-sm)",
  fontFamily: "var(--tug-font-family-mono)",
  fontSize: "var(--tug-font-size-sm)",
  borderRadius: "var(--tug-radius-sm)",
  background: "var(--tug7-surface-global-primary-normal-default-rest)",
  color: "var(--tug7-element-global-text-normal-default-rest)",
};

const INDEX_LABEL_STYLE: React.CSSProperties = {
  fontFamily: "var(--tug-font-family-mono)",
  fontSize: "var(--tug-font-size-xs)",
  color: "var(--tug7-element-global-text-normal-muted-rest)",
  flexShrink: 0,
  minWidth: "8em",
};

// ---------------------------------------------------------------------------
// Gallery card
// ---------------------------------------------------------------------------

const HEADER_BAR_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--tug-space-sm)",
  padding: "var(--tug-space-sm) var(--tug-space-md)",
  borderBottom:
    "1px solid var(--tug7-element-global-border-normal-default-rest)",
  flexShrink: 0,
};

const INPUT_HOST_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const DIAGNOSTIC_STYLE: React.CSSProperties = {
  fontSize: "var(--tug-font-size-xs)",
  fontFamily: "var(--tug-font-family-mono)",
  color: "var(--tug7-element-global-text-normal-muted-rest)",
  flexShrink: 0,
};

const LIST_VIEW_HOST_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: "relative",
};

export function GalleryListViewFilter(): React.ReactElement {
  // Static base data source — instantiated once per mount.
  const baseRef = React.useRef<GalleryListViewFilterDataSource | null>(null);
  if (baseRef.current === null) {
    baseRef.current = new GalleryListViewFilterDataSource(buildItems());
  }
  const base = baseRef.current;

  // Query state owned by the host. The same `query` value is captured
  // by the predicate closure AND passed as the `filterToken` — the
  // canonical [Spec S06] pattern.
  const [query, setQuery] = React.useState("");

  // The React-state delegate adapter: the field reports each keystroke, the
  // host stores it, and the stored value drives both the predicate and the
  // filter token.
  const delegate = React.useMemo<TugFilterFieldDelegate>(
    () => ({
      filterFieldDidChangeQuery: setQuery,
    }),
    [],
  );

  // Predicate built fresh per render; the latest closure captures the
  // current `query`. The hook's `setLatestPredicate` write picks it
  // up; recompute fires when `filterToken` (also `query`) changes
  // identity per `Object.is`.
  //
  // The shared list-filter matcher: fuzzy, multi-term AND, membership only —
  // identical semantics to every filtered list in the app.
  const predicate = React.useCallback(
    (i: number, ds: TugListViewDataSource): boolean => {
      const item = (ds as GalleryListViewFilterDataSource).itemAt(i);
      return filterQueryMatch(query, [item.path]);
    },
    [query],
  );

  const filtered = useFilteredDataSource(base, predicate, query);

  // Live `query` mirror so the cell renderer (memoized against
  // `base`) can read the latest query without rebuilding the
  // renderer identity on every keystroke. The renderer fires fresh
  // matchers per cell render — the wrapper's version-bump on each
  // token change re-renders every visible cell, which then reads the
  // current `queryRef.current` and computes its highlight ranges.
  const queryRef = React.useRef(query);
  queryRef.current = query;

  // Cell renderer built inside the host so the closure captures
  // `base`. The renderer routes the wrapper's filtered `index`
  // through `baseIndexFor` to read the typed extension (`itemAt`)
  // off the base — this is the canonical pattern for typed cell
  // renderers consuming a `FilteredTugListViewDataSource`.
  //
  // Memoized against `base`; the base is stable for the host's
  // lifetime, so the renderer identity stays stable across re-renders
  // and React reconciler doesn't churn on filter changes.
  const cellRenderers = React.useMemo<
    Record<string, TugListViewCellRenderer<TugListViewDataSource>>
  >(() => {
    const PathCell: TugListViewCellRenderer<TugListViewDataSource> = ({
      index,
      dataSource,
    }: TugListViewCellProps<TugListViewDataSource>) => {
      const wrapper = dataSource as FilteredTugListViewDataSource;
      const baseIndex = wrapper.baseIndexFor(index);
      const item = base.itemAt(baseIndex);
      // Recompute the highlight against the live query; the matcher is
      // cheap and the renderer only runs for cells in the rendered window.
      return (
        <div style={PATH_CELL_STYLE} data-testid="gallery-list-view-filter-path">
          <span style={INDEX_LABEL_STYLE}>{`#${index} (base ${baseIndex})`}</span>
          <span>{renderFilterHighlight(item.path, queryRef.current)}</span>
        </div>
      );
    };
    return { path: PathCell };
  }, [base]);

  const baseCount = base.numberOfItems();
  const filteredCount = filtered.numberOfItems();
  const diagnostic = `${filteredCount} of ${baseCount} matches`;

  return (
    <div
      className="cg-content"
      data-testid="gallery-list-view-filter"
      style={{ padding: 0, gap: 0, overflow: "hidden", height: "100%" }}
    >
      <div style={HEADER_BAR_STYLE}>
        <div style={INPUT_HOST_STYLE}>
          <TugFilterField
            delegate={delegate}
            placeholder="Filter paths"
            data-testid="gallery-list-view-filter-field"
          />
        </div>
        <span style={DIAGNOSTIC_STYLE}>{diagnostic}</span>
      </div>
      <div style={LIST_VIEW_HOST_STYLE}>
        <TugListView
          dataSource={filtered}
          cellRenderers={cellRenderers}
          scrollKey="gallery-list-view-filter"
        />
      </div>
    </div>
  );
}

/**
 * GalleryListViewHeaders — visual showcase + smoke test for
 * `TugListView`'s row-role feature.
 *
 * Mounts a `TugListView` whose data source emits three kinds across
 * four section permutations:
 *
 *   1. [header, cell, cell, cell, footer]
 *   2. [header, cell, cell, cell]            (no footer)
 *   3. [cell, cell, cell, footer]            (no header)
 *   4. [header, footer]                       (empty section — header
 *                                              above a footer)
 *
 * Each kind renders with a per-role visual treatment. The primitive
 * sets `data-list-cell-role="header"` / `"footer"` on non-default
 * wrappers (visible in DevTools), gives them `tabIndex={-1}` so Tab
 * walking the list skips them, and short-circuits the wrapper-level
 * `delegate.onSelect` dispatch on click and Space/Enter keydown.
 *
 * Manual smoke (the card's reason for existing — there is no live
 * test runner for this):
 *   - Tab into the list, then Tab repeatedly: focus visits only
 *     `cell` rows. Headers and footers are skipped.
 *   - Click any row: only `cell` clicks update the diagnostic
 *     readout above the list. Header / footer clicks are silent at
 *     the wrapper level (a cell renderer could still attach its own
 *     `onClick` for an action-bearing footer; this card does not, so
 *     header/footer clicks produce no observable effect).
 *   - Inspect any header or footer wrapper in DevTools:
 *     `data-list-cell-role` is set to its role; `tabindex` is `-1`.
 *
 * The data is static — this card does not exercise mutation. The
 * `gallery-list-view` card already covers data-source mutation,
 * streaming, and windowing; this card scopes itself to the role
 * contract.
 *
 * Laws:
 *  - [L02] data source enters React via `useSyncExternalStore`
 *    (`TugListView`'s contract).
 *  - [L19] gallery-card authoring (module docstring, exported
 *    component, registered in `gallery-registrations.tsx`).
 *  - [L20] visual treatment uses inline styles scoped to this card's
 *    cell renderers; no reach into `--tugx-list-view-*` from here.
 *
 * Decisions:
 *  - tugplan-session-picker-redesign [D02] role-flat-list — Phase 0
 *    Step 1 landed `roleForIndex` on `TugListViewDataSource`; this
 *    card is the visual smoke for that primitive change.
 *  - The `kind` and `role` axes are intentionally distinct: kinds
 *    drive `cellRenderers` dispatch (`section-label` /
 *    `list-item` / `section-action`); roles drive primitive
 *    behavior (`header` / `cell` / `footer`). A consumer could
 *    register the same kind under multiple roles, or vice versa —
 *    this card uses a one-kind-per-role mapping for clarity, but the
 *    contract is orthogonal.
 */

import "./gallery.css";

import React from "react";

import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewCellRole,
  type TugListViewDataSource,
  type TugListViewDelegate,
} from "@/components/tugways/tug-list-view";

// ---------------------------------------------------------------------------
// Synthetic data source
// ---------------------------------------------------------------------------

type RoledKind = "section-label" | "list-item" | "section-action";

interface RoledItem {
  readonly id: string;
  readonly kind: RoledKind;
  readonly role: TugListViewCellRole;
  readonly label: string;
}

/** Hand-laid section permutations. See the module docstring. */
const ITEMS: ReadonlyArray<RoledItem> = [
  // Section 1 — full shape: header + cells + footer.
  { id: "s1-h",  kind: "section-label",  role: "header", label: "Section A — header + cells + footer" },
  { id: "s1-c1", kind: "list-item",      role: "cell",   label: "Cell A1 (selectable)" },
  { id: "s1-c2", kind: "list-item",      role: "cell",   label: "Cell A2 (selectable)" },
  { id: "s1-c3", kind: "list-item",      role: "cell",   label: "Cell A3 (selectable)" },
  { id: "s1-f",  kind: "section-action", role: "footer", label: "Footer A — quiet action row" },

  // Section 2 — header above cells, no footer.
  { id: "s2-h",  kind: "section-label", role: "header", label: "Section B — header + cells" },
  { id: "s2-c1", kind: "list-item",     role: "cell",   label: "Cell B1 (selectable)" },
  { id: "s2-c2", kind: "list-item",     role: "cell",   label: "Cell B2 (selectable)" },
  { id: "s2-c3", kind: "list-item",     role: "cell",   label: "Cell B3 (selectable)" },

  // Section 3 — cells above footer, no header.
  { id: "s3-c1", kind: "list-item",      role: "cell",   label: "Cell C1 (selectable)" },
  { id: "s3-c2", kind: "list-item",      role: "cell",   label: "Cell C2 (selectable)" },
  { id: "s3-c3", kind: "list-item",      role: "cell",   label: "Cell C3 (selectable)" },
  { id: "s3-f",  kind: "section-action", role: "footer", label: "Footer C — quiet action row" },

  // Section 4 — header above footer, no cells (empty section).
  { id: "s4-h",  kind: "section-label",  role: "header", label: "Section D — empty section (header + footer only)" },
  { id: "s4-f",  kind: "section-action", role: "footer", label: "Footer D — quiet action row" },
];

class GalleryListViewHeadersDataSource implements TugListViewDataSource {
  private readonly items: ReadonlyArray<RoledItem>;
  private readonly listeners = new Set<() => void>();

  constructor(items: ReadonlyArray<RoledItem>) {
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

  roleForIndex(index: number): TugListViewCellRole {
    return this.items[index].role;
  }

  /** Cell-renderer accessor — reads the full item at `index`. */
  rowAt(index: number): RoledItem {
    return this.items[index];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Static data — version is constant. `useSyncExternalStore`
   * compares versions with `Object.is`; a constant satisfies the
   * "no spurious re-render" contract because identity never changes.
   */
  getVersion(): unknown {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Cell renderers
// ---------------------------------------------------------------------------

const SECTION_LABEL_STYLE: React.CSSProperties = {
  padding: "var(--tug-space-xs) var(--tug-space-sm)",
  fontFamily: "var(--tug-font-family-sans)",
  fontSize: "var(--tug-font-size-xs)",
  fontWeight: 600,
  color: "var(--tug7-element-global-text-normal-muted-rest)",
  // No `text-transform: uppercase` — Phase 0 [D02] keeps user-facing
  // section headers in sentence case for parity with content rendered
  // through the picker (and case-sensitive content in general).
  borderBottom:
    "1px solid var(--tug7-element-global-border-normal-default-rest)",
};

const LIST_ITEM_STYLE: React.CSSProperties = {
  padding: "var(--tug-space-xs) var(--tug-space-sm)",
  fontFamily: "var(--tug-font-family-mono)",
  fontSize: "var(--tug-font-size-sm)",
  borderRadius: "var(--tug-radius-sm)",
  background: "var(--tug7-surface-global-primary-normal-default-rest)",
  color: "var(--tug7-element-global-text-normal-default-rest)",
};

const SECTION_ACTION_STYLE: React.CSSProperties = {
  padding: "var(--tug-space-xs) var(--tug-space-sm)",
  fontFamily: "var(--tug-font-family-sans)",
  fontSize: "var(--tug-font-size-xs)",
  fontStyle: "italic",
  color: "var(--tug7-element-global-text-normal-muted-rest)",
};

const SectionLabelCell: TugListViewCellRenderer<GalleryListViewHeadersDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<GalleryListViewHeadersDataSource>) => (
  <div style={SECTION_LABEL_STYLE} data-testid="gallery-list-view-headers-header">
    {dataSource.rowAt(index).label}
  </div>
);

const ListItemCell: TugListViewCellRenderer<GalleryListViewHeadersDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<GalleryListViewHeadersDataSource>) => (
  <div style={LIST_ITEM_STYLE} data-testid="gallery-list-view-headers-cell">
    {dataSource.rowAt(index).label}
  </div>
);

const SectionActionCell: TugListViewCellRenderer<GalleryListViewHeadersDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<GalleryListViewHeadersDataSource>) => (
  <div style={SECTION_ACTION_STYLE} data-testid="gallery-list-view-headers-footer">
    {dataSource.rowAt(index).label}
  </div>
);

const CELL_RENDERERS: Record<
  string,
  TugListViewCellRenderer<GalleryListViewHeadersDataSource>
> = {
  "section-label":  SectionLabelCell,
  "list-item":      ListItemCell,
  "section-action": SectionActionCell,
};

// ---------------------------------------------------------------------------
// GalleryListViewHeaders
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

const LIST_VIEW_HOST_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: "relative",
};

const INSTRUCTIONS_STYLE: React.CSSProperties = {
  fontSize: "var(--tug-font-size-xs)",
  color: "var(--tug7-element-global-text-normal-muted-rest)",
};

const DIAGNOSTIC_STYLE: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: "var(--tug-font-size-xs)",
  fontFamily: "var(--tug-font-family-mono)",
  color: "var(--tug7-element-global-text-normal-muted-rest)",
};

export function GalleryListViewHeaders(): React.ReactElement {
  // Static data source — instantiated once per mount. The card does
  // not mutate, so a single immutable instance is fine for the demo's
  // lifetime. Held in a ref so the same instance survives re-renders.
  const dataSourceRef = React.useRef<GalleryListViewHeadersDataSource | null>(
    null,
  );
  if (dataSourceRef.current === null) {
    dataSourceRef.current = new GalleryListViewHeadersDataSource(ITEMS);
  }
  const dataSource = dataSourceRef.current;

  // Diagnostic readout — last `onSelect`-fired index. Header / footer
  // wrappers are role-gated and never reach this state.
  const [lastSelectedIndex, setLastSelectedIndex] = React.useState<number | null>(
    null,
  );

  const delegate = React.useMemo<TugListViewDelegate>(
    () => ({
      onSelect: (index) => {
        setLastSelectedIndex(index);
        console.log(`[gallery-list-view-headers] onSelect(${index})`);
      },
    }),
    [],
  );

  const lastSelectedReadout =
    lastSelectedIndex === null
      ? "No selection yet"
      : `Last onSelect: index ${lastSelectedIndex} (kind=${ITEMS[lastSelectedIndex].kind}, role=${ITEMS[lastSelectedIndex].role})`;

  return (
    <div
      className="cg-content"
      data-testid="gallery-list-view-headers"
      style={{ padding: 0, gap: 0, overflow: "hidden", height: "100%" }}
    >
      <div style={HEADER_BAR_STYLE}>
        <span style={INSTRUCTIONS_STYLE}>
          Tab walks the list — focus skips header / footer rows. Only
          `cell` rows fire `onSelect` on click or Space/Enter.
        </span>
        <span style={DIAGNOSTIC_STYLE}>{lastSelectedReadout}</span>
      </div>
      <div style={LIST_VIEW_HOST_STYLE}>
        <TugListView<GalleryListViewHeadersDataSource>
          dataSource={dataSource}
          delegate={delegate}
          cellRenderers={CELL_RENDERERS}
          // `inline` — the demo content is small and bounded; rendering
          // every cell up front keeps the role-attribute / focus
          // behavior visible in DevTools without windowing math
          // hiding any rows behind a spacer. The picker (Phase 2) also
          // uses `inline` for the same reason.
          inline
          scrollKey="gallery-list-view-headers"
        />
      </div>
    </div>
  );
}

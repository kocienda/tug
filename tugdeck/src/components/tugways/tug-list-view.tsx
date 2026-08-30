/**
 * TugListView — windowed list primitive modeled on UIKit's `UITableView`.
 *
 * A framework-level primitive for any surface in tugdeck that renders a
 * list of items: the Dev multi-turn transcript (the first consumer), the
 * session picker (deferred migration), an eventual history panel, a
 * permission/audit log, and so on. The shape borrows directly from
 * UIKit's table-view decomposition — a *data source* enumerates items
 * and their kinds; a *delegate* opinionates on heights, lifecycle, and
 * selection; an imperative handle exposes scroll-into-view; cell
 * renderers are registered per kind so the same data source can mix
 * heterogeneous row shapes through one call site.
 *
 * **Step 2 boundary — types only.** This commit ships the public API
 * surface as TypeScript types plus a no-op stub component. The full
 * implementation (windowing, height index, cell reuse, lifecycle,
 * SmartScroll integration) lands in subsequent steps. Consumers can
 * write data sources and cell renderers against the contract today.
 *
 * Laws:
 * - [L02] external state enters React via `useSyncExternalStore` — the
 *   list view subscribes to the data source through that contract.
 * - [L03] registrations events depend on (SmartScroll, ResizeObserver,
 *   lifecycle delegate) land in `useLayoutEffect` so they're in place
 *   before paint.
 * - [L06] appearance changes via CSS / DOM — spacer heights and scroll
 *   position writes go directly to the DOM, not through React state.
 * - [L11] the list view holds no chain handlers in v1; no scroll-action
 *   vocabulary exists yet for it to register against. Cell renderers
 *   may be controls or responders depending on their content.
 *   `delegate.onSelect` is a control-style action emitted on cell click;
 *   selection state lives with the consumer ([Q06] / [D03]) — except
 *   in opt-in `selectionRequired` mode, where the list view owns a
 *   never-null selected index (local-data zone [L24]; React state is
 *   sanctioned for "selected item in a list") and mirrors it to the
 *   consumer through the `onSelectionChange` state-mirror callback.
 * - [L19] component authoring guide — file pair, module docstring,
 *   exported props interface, `data-slot="tug-list-view"`.
 * - [L20] component-token sovereignty — `--tugx-list-view-*` only;
 *   consumers customize via cascade-scoped overrides.
 * - [L22] store observers may write DOM directly. Streaming-bound cells
 *   observe their stream sources from inside their renderers; the
 *   list view does not push deltas through its own subscribe path.
 * - [L23] scroll position survives DOM-down transitions via the
 *   consumer-supplied `scrollKey` written to `data-tug-scroll-key`.
 * Decisions:
 * - [D01] UITableView lineage; [D02] single-section flat list in v1;
 *   [D03] imperative handle with `scrollToIndex` + `getElementForIndex`;
 *   [D04] cell reuse is a conceptual API — v1 implementation is React
 *   item-keyed mount/unmount; [D07] SmartScroll owns scroll-position
 *   writes; [D08] no chain-driven scroll commands in v1.
 *
 * Row roles:
 * - The data source may classify each item as a `"cell"` (the
 *   default), a `"header"`, or a `"footer"` via the optional
 *   `TugListViewDataSource.roleForIndex` method. Cells with a non-
 *   default role render with `data-list-cell-role` set on the wrapper,
 *   are NOT focusable (`tabIndex={-1}`), and do NOT fire
 *   `delegate.onSelect` on click or Space/Enter — they are inert
 *   section dividers. Visibility lifecycle (`willDisplay` /
 *   `didEndDisplaying`) and ResizeObserver measurement still apply,
 *   so headers and footers participate in windowing math identically
 *   to ordinary cells. Cell renderers may attach their own click
 *   handlers if a header/footer needs an action; the primitive's
 *   gating is purely about wrapper-level selection dispatch. See
 *   `tugplan-session-picker-redesign.md` [D02] for the rationale and the
 *   relationship to a future `numberOfSections` migration.
 *
 * Filtering:
 * - `TugListView` itself does NOT host a search field or own a
 *   filter predicate. UIKit's `UITableView` doesn't either —
 *   `UISearchController` projects a filtered data source the table
 *   consumes. The same split applies here: a host component owns the
 *   search input (a `TugInput` or any other text surface) and
 *   composes a `FilteredTugListViewDataSource` via
 *   `useFilteredDataSource` (in `./use-filtered-data-source.ts`). The
 *   wrapper's filtered enumeration is fed to `<TugListView
 *   dataSource={...} />` in place of the base — the primitive doesn't
 *   know it's filtered, and the consumer doesn't have to teach it.
 *   See `gallery-list-view-filter` for the canonical pattern (host-
 *   owned `TugInput` + `useFilteredDataSource` + `baseIndexFor`-aware
 *   cell renderer) and `tugplan-session-picker-redesign.md` [D01] /
 *   [Spec S06] for the rationale.
 */

import "./tug-list-view.css";

import React from "react";

import { currentGesture, targetRefusesFocus } from "@/gesture-interpreter";
import {
  multiSelectIntentFor,
  type MultiSelectIntent,
} from "./list-multi-select";
import {
  RESIZE_PRESERVE_BEGIN,
  RESIZE_SETTLE_TAIL_MS,
  trackElementAnchor,
  RESIZE_PRESERVE_END,
} from "@/lib/resize-episode";
import { SmartScroll } from "@/lib/smart-scroll";
import {
  anchorDepthFromEnd,
  anchorRowIndexInWindow,
} from "@/lib/session-restore-window";

import { HeightIndex } from "./internal/list-view-height-index";
import {
  detectPrepend,
  prependScrollAdjustment,
} from "./internal/list-view-prepend";
import { computePageNavigation } from "./internal/list-view-page-navigation";
import { computeWindow } from "./internal/list-view-window";
import { OuterScrollportProvider } from "./internal/outer-scrollport-context";
import {
  ScrollerProvider,
  attachScrollerElement,
  type Scroller,
} from "./internal/scroller-context";
import { useSavedRegionScroll } from "./use-component-state-preservation";
import {
  TugListRowLayoutProvider,
  type TugListRowDensity,
  type TugListRowSelectionSurface,
  type TugListRowVariant,
} from "./tug-list-row";
import {
  resolveRowSeparator,
  type TugListViewRowSeparator,
} from "./internal/list-view-separator";
import {
  resolveRowStriping,
  type TugListViewRowStriping,
  type TugListViewStripeParity,
} from "./internal/list-view-striping";
import { useFocusable, useFocusManager } from "./use-focusable";
import {
  ATTACHED_CURSOR_ATTRIBUTE,
  FocusModeContext,
  KEY_WITHIN_ATTRIBUTE,
} from "./focus-manager";
import type {
  FocusPolicy,
  KeyViewBehavior,
  SpatialCursorHandle,
} from "./focus-manager";
import type { FocusKey } from "./focus-act";
import type { AttachedFilterBinding } from "./attached-filter";
import { CardIdContext } from "@/lib/card-id-context";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import { deckTrace } from "@/deck-trace";
import { KEY_CURSOR_ATTRIBUTE } from "./use-focus-cursor";

// Re-export the `rowSeparator` prop types so consumers import them
// alongside `TugListView` rather than reaching into the internal path.
export type {
  TugListViewRowSeparator,
  TugListViewRowSeparatorConfig,
  TugListViewSeparatorThickness,
} from "./internal/list-view-separator";

// Same for `rowStriping`.
export type {
  TugListViewRowStriping,
  TugListViewRowStripingConfig,
  TugListViewStripeParity,
  TugListViewStripeStrength,
} from "./internal/list-view-striping";

// ---------------------------------------------------------------------------
// Row roles — structural classification of an item in the list
// ---------------------------------------------------------------------------

/**
 * Structural role of a row.
 *
 * - `"cell"` (default) — an interactive list item. Focusable
 *   (`tabIndex={0}`); click and Space/Enter dispatch
 *   `delegate.onSelect(index)`.
 * - `"header"` / `"footer"` — an inert section divider. The cell
 *   wrapper renders `data-list-cell-role="header"` (or `"footer"`),
 *   `tabIndex={-1}`, and ignores wrapper-level click / Space / Enter
 *   for the purposes of `delegate.onSelect`. Cell renderers may still
 *   attach their own `onClick` handlers if a header/footer needs to
 *   trigger an action — the primitive's gating is wrapper-level only.
 *
 * Headers and footers participate in windowing, ResizeObserver
 * measurement, and visibility lifecycle (`willDisplay` /
 * `didEndDisplaying`) identically to ordinary cells. The role only
 * affects focusability and the `onSelect` dispatch contract.
 */
export type TugListViewCellRole = "cell" | "header" | "footer";

// ---------------------------------------------------------------------------
// Data source — what consumers implement
// ---------------------------------------------------------------------------

/**
 * The contract a `TugListView` consumer fulfills to enumerate items and
 * notify the list view of changes. Modeled on `UITableViewDataSource`
 * with two adaptations for the web: index-keyed rather than
 * `IndexPath`-keyed (single-section v1, [D02]), and a `getVersion`
 * shape for `useSyncExternalStore` consumption ([L02]).
 *
 * @see [TugListViewDelegate] for optional behavioral hooks.
 */
export interface TugListViewDataSource {
  /**
   * Total item count. The list view re-windows whenever this value
   * changes (a tick from `subscribe` is the trigger).
   */
  numberOfItems(): number;

  /**
   * Stable identity for the item at `index`. Used as the React key for
   * the cell wrapper.
   *
   * **Contract — item-stable, not slot-stable.** When the data source
   * mutates (insert, remove, reorder), the same logical item retains
   * the same id at its new index. React's reconciler uses this to match
   * cells across data-source updates so a cell at position 5 that
   * becomes position 7 (because two items were inserted before it)
   * keeps its component instance and its DOM. Returning slot-positional
   * ids (`"row-0"`, `"row-1"`) defeats reconciliation and is incorrect.
   */
  idForIndex(index: number): string;

  /**
   * Cell-renderer kind for the item at `index`. Drives renderer
   * dispatch via `cellRenderers[kind]` (and, in a future
   * imperative-pool implementation, reuse-pool routing).
   *
   * **Kind changes are a remount in disguise** ([L26]). When
   * `kindForIndex` returns a different value across renders for the
   * same `id`, the list view picks a different lambda from the
   * `cellRenderers` map. Even if both lambdas wrap the same inner
   * component, React sees two distinct component types for the same
   * React key and unmounts the wrapper subtree — collapsing scroll
   * geometry, tearing down effects, breaking streaming subscriptions.
   * If a data source has one logical row whose appearance evolves
   * over time, prefer a single kind whose renderer branches on the
   * row payload rather than two kinds with two renderers. (See the
   * assistant row in `SessionTranscriptDataSource` for the canonical
   * example.)
   */
  kindForIndex(index: number): string;

  /**
   * Structural role of the item at `index`. See `TugListViewCellRole`
   * for the role contract. Optional — when omitted, every index is
   * treated as `"cell"`, preserving the v1 single-role flat-list
   * shape. Implementing this method is purely additive: existing
   * consumers and tests are unaffected.
   *
   * Role may change across data-source updates (e.g. a header that
   * collapses into a regular cell when its section is empty). The
   * list view re-reads `roleForIndex` on every render, so a tick that
   * promotes a cell to a header or vice versa updates the wrapper's
   * focusability and `onSelect`-gating on the next commit.
   *
   * Click and keydown handlers also re-read `roleForIndex` at call
   * time (via the live data source reference), so a role transition
   * between render and click is reflected — a cell that has just
   * become a header will not fire `onSelect` even if the click
   * handler closure was created when the role was `"cell"`.
   */
  roleForIndex?(index: number): TugListViewCellRole;

  /**
   * Whether the `"cell"`-role row at `index` is *enabled* — pickable.
   * Optional; when omitted (or returning `true`), every cell is
   * enabled, preserving the v1 all-pickable shape. Implementing it is
   * purely additive.
   *
   * A disabled cell is still rendered and still occupies its slot in
   * the windowing math — it is NOT hidden. What it loses is
   * *engagement*: the movement cursor skips over it (Up/Down/Home/End/
   * Page and the key-view gain seed all land on the nearest *enabled*
   * cell instead), it is not a native Tab stop (`tabIndex={-1}`), and a
   * click or Space/Enter on it does not fire `delegate.onSelect` nor
   * move the list's owned selection. The wrapper carries
   * `data-disabled="true"` and `aria-disabled="true"` so CSS and
   * assistive tech can reflect the state. The session picker's
   * "Live in another card" / "In use in a terminal" rows are the
   * canonical consumers — visible for context, but unpickable.
   *
   * Only consulted for `"cell"`-role rows; headers / footers are
   * already inert via {@link roleForIndex} regardless. Re-read on
   * every render and at click / keydown time (via the live data source
   * reference), mirroring `roleForIndex`, so an enabled→disabled
   * transition between render and activation is honored.
   */
  enabledForIndex?(index: number): boolean;

  /**
   * Subscribe to data-source changes. Listener fires on every change
   * that should re-window. Returns an unsubscribe callback.
   */
  subscribe(listener: () => void): () => void;

  /**
   * Stable version token. The list view's `useSyncExternalStore` uses
   * this to detect updates.
   *
   * **Contract — `Object.is` equality.** React's `useSyncExternalStore`
   * compares snapshots with `Object.is`. Returning `===`-identical
   * values means "no update"; any change in identity means "re-render."
   * Acceptable shapes:
   *  - a monotonically incrementing version number,
   *  - an object reference that the data source replaces on each change
   *    (e.g. the underlying store's snapshot reference),
   *  - a string token whose identity is stable.
   *
   * NOT acceptable: a string concatenation re-built on each call —
   * `Object.is` is reference-based, so two equal-content strings minted
   * fresh per call compare unequal and force re-renders every tick.
   */
  getVersion(): unknown;

  /**
   * Optional turn-aware anchor depth, for data sources whose content is
   * windowed in **turns** (the transcript). Given the flat row index of the
   * topmost visible row, return its distance from the end measured in turns
   * — the count of turns from the anchored turn (inclusive) down to the
   * newest loaded turn. The list view persists this in the saved anchor bag
   * so a cold resume can both size the replay window and re-find the anchored
   * turn in a single turn quantity ([P06]).
   *
   * Return `undefined` when the row does not map to a committed turn (an
   * in-flight or ghost row), or when the source has no turn concept. The list
   * view then falls back to the row-depth path ({@link anchorDepthFromEnd}),
   * which suits genuinely rowful, non-windowed lists.
   */
  turnDepthFromEnd?(rowIndex: number): number | undefined;

  /**
   * Optional inverse of {@link turnDepthFromEnd}: given a saved turn depth,
   * return the flat row index of that turn's **first** row in the
   * freshly-loaded window, or `null` when the window has not yet paged in
   * enough turns to include it (the anchored turn is older than everything
   * loaded). The list view waits — leaving the restore target unresolved —
   * until a later commit pages the turn in, then relocates exactly.
   */
  rowIndexForTurnDepthFromEnd?(turnDepth: number): number | null;
}

// ---------------------------------------------------------------------------
// Delegate — what consumers optionally implement
// ---------------------------------------------------------------------------

/**
 * Optional behavioral hooks a consumer may implement on top of the data
 * source. All members are optional; omitted methods fall back to
 * sensible defaults built into the list view. Modeled on
 * `UITableViewDelegate`.
 */
export interface TugListViewDelegate {
  /**
   * Estimated height (in CSS pixels) for unmeasured cells of this
   * kind. Used by the height index to compute spacer geometry before a
   * cell has been measured by `ResizeObserver`. Default: 60.
   */
  estimatedHeightForKind?(kind: string): number;

  /**
   * Which band this row takes under `rowStriping`, when the row's own index
   * parity is not the answer.
   *
   * The default — `index % 2` — is right for a flat list and wrong for a
   * sectioned one: a section whose predecessor held an odd number of rows
   * starts on the opposite foot from the one above it, so the banding reads
   * as continuous stripes running under the headings rather than as each
   * section counting from its own top. A consumer that groups its items
   * knows where those sections start and answers here; `"none"` takes no
   * band at all, which is what a heading row wants.
   *
   * Ignored entirely when the list is not striped.
   */
  stripeParityForIndex?(index: number): TugListViewStripeParity;

  /**
   * Fires when a cell becomes part of the rendered window. Useful for
   * attaching cell-scoped resources (a streaming subscription, a fetch,
   * a focus seed) on first display.
   */
  willDisplay?(index: number): void;

  /**
   * Fires when a cell leaves the rendered window. Useful for tearing
   * down the resources `willDisplay` attached.
   */
  didEndDisplaying?(index: number): void;

  /**
   * Fires when the user selects a cell (click / Space, and Enter unless
   * {@link TugListViewProps.commitOnEnter} is `"act"`). Selection ownership
   * lives with the consumer by default — the list view stores no selected-index
   * state. The exception is opt-in `selectionRequired` mode (see
   * `TugListViewProps`), where the list view owns a never-null selected index
   * and mirrors it out through `onSelectionChange`; `onSelect` still fires
   * alongside on every selection.
   */
  onSelect?(index: number): void;

  /**
   * Fires on the **Enter/act** of the cursor row, when the list opts into
   * {@link TugListViewProps.commitOnEnter} `"act"`. The act-on-Enter path that
   * is DISTINCT from {@link onSelect} (click / Space): a container whose Space
   * (e.g. a toggle) and Enter (e.g. commit-and-advance) are different actions
   * routes them to separate callbacks. The list still commits its own selection
   * (`data-selected`) on the cursor row before invoking this. Omit it (or omit
   * `commitOnEnter`) and Enter falls back to the [P24] bubble-to-default rule.
   */
  onActivate?(index: number): void;
}

// ---------------------------------------------------------------------------
// Cell renderer — what consumers register per kind
// ---------------------------------------------------------------------------

/**
 * Props passed to a cell renderer. The `dataSource` is the active data
 * source (typed by `DS` if the consumer narrows); renderers query it
 * for the content they need rather than receiving it as a prop. This
 * mirrors UIKit's `cellForRowAtIndexPath` shape, where the cell is
 * given the index path and queries the data source for the row.
 *
 * The generic `DS` defaults to the base `TugListViewDataSource`. A
 * consumer with a typed adapter (e.g. `SessionTranscriptDataSource`)
 * narrows `DS` so its cell renderers can call adapter-specific methods
 * such as `rowAt(index)` without casting.
 */
export interface TugListViewCellProps<
  DS extends TugListViewDataSource = TugListViewDataSource,
> {
  index: number;
  id: string;
  kind: string;
  /** The active data source. Cell renderers query it for content. */
  dataSource: DS;
  /**
   * `true` when this row is selected — the `selectionRequired`-owned
   * selected row, or a member of a {@link TugListViewProps.multiSelect}
   * set. The list view computes it and passes it alongside the wrapper's
   * `data-selected` attribute, so a cell renderer can forward selection
   * into a presentational child (e.g. `TugListRow`'s `selected` prop)
   * without re-deriving it.
   *
   * Always `false` when the list holds no selection of either kind — the
   * consumer owns it then (typically through its own context, read inside
   * the cell renderer).
   */
  selected: boolean;
}

/**
 * The component shape a consumer registers under a kind in
 * `TugListViewProps.cellRenderers`. A `React.ComponentType` (rather
 * than a render function) so cell internals can use hooks naturally —
 * a streaming cell can call `useLayoutEffect` to attach a store
 * observer per [L22].
 */
export type TugListViewCellRenderer<
  DS extends TugListViewDataSource = TugListViewDataSource,
> = React.ComponentType<TugListViewCellProps<DS>>;

// ---------------------------------------------------------------------------
// Imperative handle — exposed via forwardRef
// ---------------------------------------------------------------------------

/**
 * Imperative API the list view exposes to its parent via `forwardRef`.
 * v1 surface is deliberately small ([D03]): scroll-into-view and
 * direct DOM access for the rendered window. Animations, batched
 * inserts/removes, and selection-state mutators are deferred follow-
 * ons.
 */
export interface TugListViewHandle {
  /**
   * Scroll the row at `index` into view.
   *
   * Implementation contract (lands in Step 6, gated by [D03]):
   * - If the row is already mounted, delegates to
   *   `SmartScroll.scrollToElement`.
   * - If not, computes the target offset from the height index and
   *   uses `SmartScroll.scrollTo({ top: estimatedOffset })` to jump
   *   first; the row mounts on the next windowing pass; on the next
   *   `ResizeObserver` flush, the offset is recomputed against the
   *   measured height and corrected if it has drifted by more than a
   *   small threshold (~4px).
   *
   * Out-of-range indices clamp to first / last rather than throwing,
   * matching `UITableView`'s tolerance for stale index paths during
   * update transitions. `NaN` is a no-op.
   */
  scrollToIndex(
    index: number,
    options?: {
      block?: ScrollLogicalPosition;
      animated?: boolean;
    },
  ): void;

  /**
   * The DOM element for the rendered row at `index`, or `null` if the
   * row is not currently in the rendered window. Consumers that need
   * to address an unrendered row should call `scrollToIndex` first to
   * bring it into view.
   */
  getElementForIndex(index: number): HTMLElement | null;

  /**
   * Scroll to the bottom of real content and engage follow-bottom, so
   * subsequent content growth stays pinned. The deliberate inverse of
   * a user scroll-up (which disengages follow-bottom): consumers call
   * this for a "jump to latest" gesture — e.g. a session-card submitting
   * a new prompt while the transcript is scrolled up. Delegates to
   * `SmartScroll.scrollToBottom`, which excludes the `inert` tail
   * spacer so the scroll lands at the bottom of *content*, not the
   * spacer. No-op before the scroll instance exists.
   *
   * Also arms the post-commit pin so the bottom is re-asserted once
   * React commits any pending state changes that grow `scrollHeight`
   * after this synchronous call (the canonical case: a user submit
   * dispatches into a store inside the same event handler, then calls
   * this method; `scrollHeight` is the pre-commit value at the
   * moment of the clamp, so without the post-commit re-pin the new
   * row can land below the viewport). The post-commit pin reads the
   * live `scrollHeight` after commit and slams to the new bottom,
   * making the "jump to latest" reliable regardless of dispatch
   * order between this method and the store growth.
   */
  scrollToBottom(options?: { animated?: boolean }): void;

  /**
   * Scroll to the very top of content (Home). Disengages follow-bottom
   * (the scroller is leaving the live edge), then lands `scrollTop` at
   * 0. The inverse of `scrollToBottom`. No-op before the scroll instance
   * exists.
   */
  scrollToTop(): void;

  /**
   * Break auto-follow-bottom on behalf of a named `source` (deck-trace
   * attribution tag). For programmatic reveals that must own the scroll
   * position against streaming growth — e.g. a find reveal — where
   * `scrollToIndex` alone leaves follow-bottom engaged and the next
   * content-growth pin would slam the view back to the live edge.
   * No-op before the scroll instance exists.
   */
  disengageFollowBottom(source: string): void;

  /**
   * Step the scroller one entry (one transcript turn-half) up or down,
   * pinning the target entry's top flush to the viewport top — the same
   * motion PageUp / PageDown perform inside the scroll container, but
   * callable from anywhere. A consumer binds this to a key that should
   * drive turn navigation regardless of where focus sits within its
   * surface (e.g. the Session card binds Opt-Cmd-Up / Opt-Cmd-Down at the
   * card root). Requires `inline` rendering (every entry mounted); a
   * no-op if the scroll instance or a target entry element is absent.
   */
  pageByEntry(direction: "up" | "down"): void;

  /**
   * Move the movement cursor to the row at `index` and **descend** into its
   * first inner focusable — the imperative twin of the Enter/ArrowRight
   * descend gesture, for a consumer whose row content becomes descendable
   * only *after* an activation mounts it (an in-place row editor: the row is
   * a plain display row until Enter opens its editor, which mounts on the
   * next commit). The consumer calls this from the layout effect that reacts
   * to the editor mounting, so the row's `[data-tug-focusable]` exists by the
   * time the descend runs.
   *
   * No-op when the list is not engine-authored, when `index` is out of range,
   * or when the row carries no inner focusable (nothing to descend into).
   * Requires `inline` rendering in practice, so the target row is mounted.
   */
  descendIntoRow(index: number): void;

  /**
   * Park the movement cursor on the nearest cursorable row to `index`
   * (preferring `index` itself, then earlier rows, then later ones) and
   * scroll it into view — for a consumer whose action removed the cursor
   * row out from under the keyboard (a Delete verb): the cursor lands on a
   * surviving neighbor instead of vanishing. The bar paints only while the
   * container holds the keyboard key view (the standard cursor gating).
   * No-op when the list is not engine-authored or the list is empty.
   */
  moveCursorTo(index: number): void;

  /**
   * Step the **attached-list cursor** one row, for a text field that has
   * declared this list as its attached list ([P08], Spec S02). The caret stays
   * in the field; only this list's highlight moves.
   *
   * Distinct from the movement cursor in both gating and mark: it paints
   * `data-attached-cursor` (see {@link ATTACHED_CURSOR_ATTRIBUTE}) regardless
   * of whether the keyboard is in this list — it never is — and regardless of
   * KBF mode. Skips non-cursorable rows and does not wrap: an arrow at the end
   * of a list is a no-op, so the key can fall back to the caret.
   *
   * The first call seeds rather than moving — ↓ lands on the surface-supplied
   * active row (`initialSelectedIndex`), else the list's own selection, else
   * the first cursorable row — so ↓ into a fresh list highlights the row a
   * commit would act on instead of the second row. Returns whether the
   * highlight moved.
   */
  attachedCursorMove(direction: "up" | "down"): boolean;

  /**
   * The row index the attached-list cursor is on, or `-1` when it has none.
   * A field's commit gesture reads it to know what its Return means ([Q01]).
   */
  attachedCursorIndex(): number;

  /**
   * Drop the attached-list cursor and its mark — the field's caret has left,
   * or the list has taken the keyboard itself. Idempotent.
   */
  attachedCursorRelease(): void;
}

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

/**
 * Props for the `TugListView` component. Generic over the data-source
 * type so consumers with typed adapters get matched cell-renderer
 * props without manual casts.
 */
/**
 * The contiguous slice of rows currently mounted in the DOM — the windowed
 * range plus overscan — reported by {@link TugListViewProps.onRenderedRangeChange}.
 *
 * `firstIndex`/`lastIndex` are **inclusive** data-source indices; both are `-1`
 * when nothing is rendered (empty list). `itemCount` is the data source's size
 * at the moment of notification, so `firstIndex === 0 && lastIndex ===
 * itemCount - 1` means the whole list is mounted.
 */
export interface TugListRenderedRange {
  firstIndex: number;
  lastIndex: number;
  itemCount: number;
}

export interface TugListViewProps<
  DS extends TugListViewDataSource = TugListViewDataSource,
> {
  /** The data source that drives the list. */
  dataSource: DS;

  /** Optional behavioral hooks. */
  delegate?: TugListViewDelegate;

  /**
   * Map of kind → cell renderer component. The list view dispatches
   * each rendered index through `cellRenderers[dataSource.kindForIndex(index)]`.
   * A kind returned by `kindForIndex` that has no entry here is a
   * runtime error in v1 — the cell renders nothing and a console
   * warning fires.
   */
  cellRenderers: Record<string, TugListViewCellRenderer<DS>>;

  /**
   * Scroll-region key for the [A9] state-preservation protocol
   * ([L23]). Written to `data-tug-scroll-key` on the scroll container
   * so cold-boot / cross-pane move restores scroll position into
   * `bag.regionScroll[scrollKey]`.
   *
   * Must be unique within the enclosing card subtree; cards mounting
   * two `TugListView` instances pass distinct keys (e.g.
   * `"session-card-transcript"` vs `"session-card-history"`).
   *
   * @default "tug-list-view"
   */
  scrollKey?: string;

  /**
   * Forwarded class name for cascade-scoped customization. Consumers
   * tune list-view tokens for their instance via a wrapping selector,
   * not by reaching into the primitive's CSS ([L20]).
   *
   * @example
   * <div className="session-card-transcript">
   *   <TugListView ... className="session-card-transcript-list" />
   * </div>
   */
  className?: string;

  /**
   * Optional content rendered INSIDE the scroll container, above the first
   * row — a permanent leading element that scrolls with the content (it is
   * off-screen when scrolled down, and the first thing reached at the top).
   * Unlike a `"header"`-role data-source row, it is NOT indexed: it takes no
   * row slot, so it never perturbs `numberOfItems`, the row keys, or the
   * turn-addressing / anchor-depth math. Constant-height by contract — the
   * scroll-anchor measures rows, and a constant element above row 0 shifts
   * every row uniformly, so save/restore stays exact as long as it is always
   * present. Used by the dev transcript for its permanent Z0 strip.
   */
  leadingContent?: React.ReactNode;

  /**
   * A permanent, un-indexed element rendered AFTER the last row, inside the
   * scroller (so a consumer that reads `useScroller()` resolves the list's
   * scroll façade) and after the cells so it rides the live edge. Un-indexed
   * like {@link leadingContent}, so it never perturbs `numberOfItems` or the
   * anchor math. A permanent tail slot for a consumer's live-edge chrome.
   */
  trailingContent?: React.ReactNode;

  /**
   * Initial auto-follow-bottom intent. When `true`, the list view
   * pins to the bottom on mount and on every data-source growth /
   * height-index update while the last item is in the rendered
   * window — until the user scrolls up, at which point SmartScroll
   * disengages and the user owns the scroll position. Idle-at-bottom
   * re-engagement is also SmartScroll's job ([D07]).
   *
   * Default `false` — matches `UITableView`'s natural "start at top"
   * behavior. Streaming/transcript consumers (where the user is
   * meant to read the latest content) opt in by passing `true`.
   *
   * **Inert on a keyboard-selection list.** When the list is a selection
   * container — authored into a `focusGroup`, made `keyboardSubordinate` to
   * a filter, or `singleSelect` — `followBottom` is forced off regardless of
   * what is passed. The movement cursor owns the scroll position there, so
   * follow-bottom would yank every ArrowUp back to the live edge (scrolling
   * the selected row out of view). Passing both logs a dev warning. Only a
   * scroll-only stream (no cursor) may follow the bottom.
   *
   * @default false
   */
  followBottom?: boolean;

  /**
   * Freeze the per-commit scroll-geometry battery while a batch load is
   * in flight or still settling. While `true`, the growth pin and the
   * anchor-state writer stand down — neither reads `scrollTop` /
   * `scrollHeight`, so a batch that commits many turns and then settles
   * every cell's measured height does not force a synchronous
   * full-transcript layout on each of those commits. Placement during
   * the batch is owned by the restore path; on the falling edge the list
   * does one pin + one anchor write.
   *
   * Set across the transcript's restore replay, every "load previous"
   * bracket, *and* the post-reveal height settle that follows — see
   * `onFirstSettle`, which marks the end of that settle so the consumer
   * can release this. Leave `false` for live streaming, where new turns
   * follow the bottom normally.
   *
   * @default false
   */
  batchLoading?: boolean;

  /**
   * Child-driven ready callback ([L04], [D78]). Fired once after the
   * list has mounted a batch and its `ResizeObserver` has delivered the
   * cells' measured heights — i.e. the batch's layout has settled. The
   * consumer that raised `batchLoading` for a restore/load-previous
   * batch uses this edge to release it (and, e.g., drop the load
   * affordance), so the freeze spans exactly the load *and* its settle.
   * Re-armed on each `batchLoading` rising edge, so a later load-previous
   * batch fires it again.
   */
  onFirstSettle?: () => void;

  /**
   * Observe auto-follow-bottom intent. Invoked once on mount with the
   * initial state, then on every SmartScroll follow-bottom transition
   * — user scroll-up disengages; idle / gesture-end / explicit jump
   * re-engage. `following === false` means the user has scrolled away
   * from the live edge — the signal a "jump to latest" affordance keys
   * its visibility on.
   *
   * [L06] consumers drive appearance from this callback through DOM
   * attributes, never React state — follow-bottom intent must not
   * round-trip through render.
   */
  onFollowBottomChange?: (following: boolean) => void;

  /**
   * Fires on the transition in/out of the top edge — `atTop === true`
   * when the scroll position reaches the very top of the content. The
   * "load previous" affordance keys its visibility on this so it shows
   * only when the user has scrolled up to the oldest loaded message,
   * never pinned.
   *
   * [L06] consumers drive appearance from this callback through DOM
   * attributes, never React state — same discipline as
   * `onFollowBottomChange`.
   */
  onAtTopChange?: (atTop: boolean) => void;

  /**
   * Fires whenever the set of mounted rows changes — on scroll re-window, on
   * measured-height shifts that move the window, and on data-source updates
   * that change membership. This is the general seam for work that decorates
   * the LIVE DOM of the currently-mounted cells and therefore must re-run every
   * time the window turns over: find/search highlighting, media autoplay,
   * viewport telemetry, lazy media. None of that can act on windowed-out rows,
   * so a one-shot pass is never enough — this callback is the "re-run now"
   * signal.
   *
   * Contract:
   * - Reports the contiguous mounted range as {@link TugListRenderedRange}
   *   (inclusive `firstIndex`/`lastIndex`, `-1`/`-1` when empty) plus the live
   *   `itemCount`, so a consumer can tell a partial window from "the whole list
   *   fits" without a second read.
   * - Fires in a **layout effect after the new window has committed**, so
   *   `getElementForIndex(i)` resolves for every `i` in `[firstIndex,
   *   lastIndex]` by the time it runs — decorate synchronously, no flash of
   *   undecorated content ([L03]).
   * - **Deduped**: does not fire when the rendered range is unchanged between
   *   renders. Fires once on mount with the initial window.
   * - [L06] consumers drive appearance from this callback through the DOM /
   *   Custom Highlight registry, never React state.
   */
  onRenderedRangeChange?: (range: TugListRenderedRange) => void;

  /**
   * Skip windowing — render every cell in document order with no
   * spacers, no overscan, no `computeWindow` math. Use for lists
   * where rendering every cell is acceptable (transcripts, settings
   * groups, small fixed inventories) and the windowing-induced layout
   * instability is not.
   *
   * Why this exists: windowed rendering relies on
   * `estimatedHeightForKind` for cells outside the rendered range,
   * then corrects to the true measured height the first time each
   * cell enters the window (`ResizeObserver` populates `heightIndex`
   * on observation). Each first-time-measured event shifts
   * `scrollHeight` by `(measured − estimate)` pixels. The cumulative
   * effect — visible as a "bounce" on relaunch and as scroll-position
   * jitter when wheeling near the bottom of a freshly-loaded
   * transcript — disappears entirely when every cell is rendered
   * from mount, because `heightIndex` is fully populated before the
   * user can interact and never reverts to estimates.
   *
   * Default `false` — windowing is the right choice for unbounded
   * lists (gallery feeds, large logs). Dev's transcript opts in
   * with `inline` because turn counts are small and visual stability
   * matters more than DOM weight. The choice is per-instance, not
   * per-itemCount: a consumer that knows its data is bounded picks
   * `inline`; a consumer that may grow unboundedly stays windowed.
   *
   * @default false
   */
  inline?: boolean;

  /**
   * Inline-mode rendering relief: let the engine skip STYLE/LAYOUT/PAINT
   * for cells far outside the viewport via `content-visibility: auto`,
   * while every cell stays mounted at its REAL measured height.
   *
   * The no-estimates contract holds: a cell becomes skippable only
   * AFTER its true height lands in the `HeightIndex` (the same
   * `ResizeObserver` delivery that has always measured cells), and that
   * exact measurement is written as the cell's
   * `contain-intrinsic-size: auto <measured>px` — so a skipped cell
   * occupies precisely the pixels it last rendered at, `scrollHeight`
   * is still the true sum of row heights, and the scrollbar never
   * shifts. A container WIDTH change invalidates the stamps (heights
   * reflow with width): every cell drops back to full rendering,
   * re-measures, and re-arms.
   *
   * Why this exists: `inline` mounts thousands of transcript rows, and
   * each row's sticky chrome participates in WebKit's per-update
   * compositing-overlap recompute whether or not the row is anywhere
   * near the viewport. Skipped subtrees drop out of style, layout, AND
   * that compositing walk — bounding the per-frame cost by the
   * viewport, not the transcript length — while find-in-page,
   * `scrollIntoView`, selection, and accessibility still see the full
   * DOM (the `content-visibility: auto` contract).
   *
   * @default false
   */
  offscreenSkip?: boolean;

  /**
   * Inline-mode footprint relief: once every row has been measured,
   * UNMOUNT the rows outside the scrollport ± a pixel margin and stand
   * exact-height spacers in their place. Requires `inline`; ignored
   * (with a dev warning) without it.
   *
   * `offscreenSkip` stops an offscreen row from being styled, laid out,
   * and painted, but the row still exists: a WebCore element, a render
   * object, a computed style, and a React fiber per node. On a restored
   * transcript that mounted representation is the dominant heap term —
   * a session whose visible text is under a megabyte can hold tens of
   * thousands of nodes, and the resident footprint that produces is what
   * drives WebKit's periodic memory purge (and the style-recalc stall
   * that follows it). Eviction releases all four.
   *
   * The no-estimates contract is stronger here than anywhere else,
   * because spacer geometry SUMS the heights of rows that are not in
   * the DOM. Eviction therefore activates only when every row outside
   * the window has a real measured height in the `HeightIndex`
   * (`coversRange`); if any is missing — mid-batch-load, after a width
   * change wipes the ledger, or via any future path that adds rows out
   * of view — the mode SUSPENDS for that commit and renders every row,
   * exactly as plain `inline` does. The failure mode is "temporarily
   * mounts everything", never "wrong scroll geometry".
   *
   * Rows leave the window at a wider margin than they enter it, so a
   * row hovering at the boundary cannot churn; rows holding the user's
   * selection or focus are pinned into the window and never evicted.
   *
   * Every other inline-mode subsystem stays live: follow-bottom,
   * batch-load freeze, front-insert compensation, and `offscreenSkip`
   * stamping on the rows that remain mounted.
   *
   * @default false
   */
  evictOffscreen?: boolean;

  /**
   * Whether cells are interactive. `true` (default) is the picker shape —
   * `cell`-role rows are focusable (`tabIndex={0}`) and show the row hover
   * affordance. Set `false` for a **read-only listing** (e.g. `/skills`,
   * `/agents`): every row becomes inert — not in the tab order
   * (`tabIndex={-1}`) and no hover highlight — so the surface doesn't imply a
   * click that does nothing. Publishes `data-interactive="false"` on the root
   * for the CSS that suppresses the hover fill. `delegate.onSelect` is
   * independent of this flag (a read-only list simply omits the delegate).
   * @default true
   */
  interactive?: boolean;

  /**
   * Row presentation for descendant `TugListRow`s. One prop that
   * picks a coherent row treatment and publishes it two ways:
   *
   *  - **CSS** — writes `data-row-layout` on the scroll container so
   *    `tug-list-view.css` can scope the inter-row gap and the
   *    divider. `"flush"` collapses the row gap to zero and draws a
   *    1px hairline below every cell but the last — the edge-to-edge
   *    iOS-`UITableView.plain` treatment. `"pill"` sets a small
   *    inter-row gap and draws no dividers, since each `TugListRow`
   *    paints its own border.
   *  - **Context** — publishes the variant through
   *    `TugListRowLayoutContext`, so a `TugListRow` rendered by a
   *    cell renderer inherits it without every cell repeating
   *    `variant`.
   *
   * Omitted ⇒ no `data-row-layout` attribute and no context: the list
   * keeps its default comfortable row gap with no dividers, and a
   * descendant `TugListRow` falls back to its own `variant` prop.
   * Omitting the prop is therefore byte-identical to the
   * pre-`rowLayout` behavior — every existing consumer is unaffected.
   *
   * @selector [data-row-layout="flush"] | [data-row-layout="pill"]
   */
  rowLayout?: TugListRowVariant;

  /**
   * Row density published to descendant `TugListRow`s through
   * `TugListRowLayoutContext` — `compact` collapses the block padding
   * to a hairline for long enumerations (a commit's file list). A row
   * may still override with its own `density` prop. Omitted ⇒ no
   * context density; rows fall back to `cozy`.
   *
   * @selector .tug-list-row[data-density="compact"]
   */
  rowDensity?: TugListRowDensity;

  /**
   * Row-divider control. Lifts the hardcoded `flush` hairline into a
   * tunable prop:
   *
   *  - omitted ⇒ today's behavior exactly — the `flush` layout draws a
   *    hairline below each cell but the last; other layouts draw none.
   *  - `{ thickness?, color? }` ⇒ draw a divider below each cell but
   *    the last (in any layout) at the named thickness (`"hairline"` =
   *    1px, `"thin"` = 1.5px, `"medium"` = 2px) and optional color
   *    override. Publishes `data-row-separator="on"`.
   *  - `"none"` ⇒ no divider, even under `rowLayout="flush"`. Publishes
   *    `data-row-separator="none"`.
   *
   * The resolved thickness / color are written to the
   * `--tugx-list-view-divider-*` tokens on the scroll container ([L06]).
   *
   * @selector [data-row-separator="on"] | [data-row-separator="none"]
   */
  rowSeparator?: TugListViewRowSeparator;

  /**
   * Alternating row tint — the other way to separate rows in a dense list.
   * A divider spends a line BETWEEN rows; a stripe tints every other row, so
   * the eye tracks across a one-line row by its band instead of by counting
   * hairlines. The two are independent: a list may carry both, either, or
   * neither, and a list that stripes usually wants `rowSeparator="none"`.
   *
   *  - omitted / `"none"` ⇒ no striping; every row sits on the host surface.
   *  - `"faint"` | `"subtle"` | `"medium"` | `"strong"` ⇒ band every other row
   *    at 2% / 4% / 7% / 11% of the surface's own text color.
   *  - `{ strength: 5.5 }` ⇒ any wash alpha as a percent, for landing between
   *    the named rungs.
   *  - `{ color, baseColor }` ⇒ skip the washes and paint explicit colors.
   *
   * BOTH parities are painted — odd rows wash toward the surface's foreground,
   * even rows toward its content surface. Washing only one parity and leaving
   * the other on the host surface is the obvious construction and it is wrong:
   * it puts one step between neighbours, which the eye can only resolve when
   * it repeats, so a long list looks banded while a two-row list looks like
   * two identical rows. Parity comes from the row's ABSOLUTE data-source index
   * (`data-row-parity` on the cell wrapper), never from `:nth-child`, which
   * under windowing would flip the bands as the rendered range slides. A
   * sectioned list overrides that default through
   * `TugListViewDelegate.stripeParityForIndex`, so each section counts its
   * bands from its own top and its heading takes none.
   *
   * A selected row drops its band: the selection fill is a translucent wash,
   * and letting the stripe tint through it would make the same selection paint
   * two different colors depending on which row it landed on.
   *
   * @selector [data-row-striping="on"] .tug-list-view-cell[data-row-parity="odd"]
   */
  rowStriping?: TugListViewRowStriping;

  /**
   * Text size for every row in the list — one number for the title, the
   * subtitle, and any label a cell renderer puts in the content column.
   *
   * A number is taken as px; a string is used verbatim, so a token reference
   * (`"var(--tug-font-size-xs)"`) works. Written to
   * `--tugx-list-row-font-size` on the container, which the rule below
   * consumes at a specificity that outranks `TugLabel`'s own `size` prop —
   * that is the point of the prop: a dense list sets its measure once rather
   * than every cell renderer choosing a label size and hoping they agree.
   *
   * Omitted ⇒ no attribute and no token: every label keeps the size its own
   * `size` prop asked for, so existing lists are unchanged.
   *
   * @selector [data-row-text-size] .tug-list-row-content
   */
  rowTextSize?: number | string;

  /**
   * Draw an accent-colored border around the selected row(s). Published
   * to descendant `TugListRow`s through `TugListRowLayoutContext`, so a
   * cell renderer's row picks it up without repeating it. A row may
   * still override with its own `selectedAccent` prop. Default `false`.
   *
   * `flush` rows paint an inset `box-shadow` (no box-model change, so
   * moving the selection never reflows the list); `pill` rows swap their
   * border color.
   *
   * @default false
   * @selector .tug-list-row[data-selected="true"][data-selected-accent="true"]
   */
  selectedAccent?: boolean;

  /**
   * Which surface carries row selection in this list. Published to descendant
   * `TugListRow`s through `TugListRowLayoutContext` (a row may still override
   * with its own prop), and stamped on the list root so the list's own chrome
   * can account for it.
   *
   *  - `"fill"` (default) — the picker idiom: the selected row wears the
   *    selection fill, and the hairline dividers touching it drop so the fill
   *    reads as one clean block.
   *  - `"control"` — selection rides each row's leading radio / checkbox and
   *    no row is filled (see `TugListRow`'s `selectionSurface`). With no fill
   *    there is no block for a divider to interrupt, so **every** divider
   *    stays drawn — including around the list's own selected index, whose
   *    suppression otherwise reads as randomly missing separators.
   *
   * @default "fill"
   * @selector .tug-list-view[data-selection-surface="control"]
   */
  selectionSurface?: TugListRowSelectionSurface;

  /**
   * Opt into PageUp / PageDown keyboard navigation by *entry*, where
   * each cell is one entry. When `true`, the list view installs a
   * keyboard handler so PageUp / PageDown — and the macOS
   * Opt+ArrowUp / Opt+ArrowDown aliases — step the scroller exactly
   * one entry at a time:
   *
   *  - PageDown advances to the next entry and pins its top flush to
   *    the top of the viewport — even when that entry is already
   *    partly or fully on screen (an *entry* pager, not an
   *    *entry-in-view* pager). On the last entry it jumps to the live
   *    bottom and re-engages follow-bottom.
   *  - PageUp steps back one entry, pinning its top flush to the top.
   *    From mid-entry the first PageUp snaps the current entry's top
   *    up.
   *
   * The Dev transcript opts in so the user can step through every
   * row — both halves of each turn (the prompt and the response) are
   * separate cells, so navigation visits all of them. Omitted /
   * `false` ⇒ no handler is installed and PageUp / PageDown fall
   * through to the browser default. The selection math is pure and
   * lives in `internal/list-view-page-navigation.ts`.
   *
   * @default false
   */
  pageByEntry?: boolean;

  /**
   * Opt the list view into UITableView-style mandatory selection:
   * the list **always** has exactly one selected row. On mount (and
   * whenever the data source changes) the list seeds selection to the
   * first selectable row — the first index whose `roleForIndex` is
   * `"cell"`, headers/footers skipped — and it never lets selection
   * fall back to "nothing." A click / Space / Enter on a cell moves
   * the selection; if the currently-selected row leaves the data
   * source (or its role changes), selection re-seeds to the first
   * selectable row rather than clearing.
   *
   * Selection is then list-view-owned state (local-data zone [L24]),
   * surfaced to the consumer through `onSelectionChange`. The
   * selected row's wrapper carries `data-selected="true"` for
   * cascade-scoped styling.
   *
   * Default `false` — the list view owns no selection and behaves
   * exactly as before: `delegate.onSelect` is a fire-and-forget
   * control action and the consumer holds whatever selection model
   * it wants.
   *
   * @default false
   * @selector .tug-list-view-cell[data-selected="true"]
   */
  selectionRequired?: boolean;

  /**
   * State-mirror callback for `selectionRequired` mode — fires with
   * the owned selected index whenever it changes (the initial seed,
   * a click, or a re-seed after the prior row left the data source).
   * Modeled on Radix's `onOpenChange`: it reports list-view-owned
   * state outward, it is not a user-interaction callback (those route
   * through the chain / `delegate.onSelect`). No-op when
   * `selectionRequired` is `false`.
   */
  onSelectionChange?: (index: number) => void;

  // ---- Focus participation — the listbox model ([P01]/[P03]) ----
  //
  // When authored into a `focusGroup`, the list is ONE item-container stop in the
  // engine Tab walk (like TugAccordion / TugRadioGroup): Tab lands the ring on
  // the scroll container, Up/Down/Home/End/Page move a **movement cursor**
  // (`data-key-cursor`) over the cell rows — scrolling each into view — Space
  // **selects** the cursor row (`data-selected`), and Enter **descends** into a
  // row whose content has navigable focusables (a non-trapped scope; Escape
  // ascends) or else **activates** it (`delegate.onSelect`). The ring stays on
  // the list and never moves onto a row; the cursor is appearance-only, projected
  // straight to the DOM ([L06]/[L22]). When omitted, the list is a plain scroll
  // container with native per-row focus stops (today's un-authored behavior).

  /**
   * Focus group this list is authored into ([P02]). When set, the list registers
   * the scroll container as a single item-container stop and engages the cursor /
   * Space-select / Enter-descend model above. Supplied by the surface that owns
   * the Tab order. Mutually exclusive with {@link keyboardSubordinate} (which
   * wins — a subordinate list never self-registers).
   */
  focusGroup?: string;
  /** Order within {@link focusGroup}. Defaults to 0 (registration order breaks ties). */
  focusOrder?: number;
  /**
   * Walk policy when registered: `accept` (default) is an ordinary Tab stop;
   * `skip` is reachable only in accessibility mode.
   */
  focusPolicy?: FocusPolicy;
  /**
   * Make the list **subordinate** to an external focus owner (a filter input that
   * owns the key view + ring). The list contributes ZERO Tab stops — the scroll
   * container and every cell wrapper are `tabIndex=-1` and the container registers
   * no engine focusable — while selection still lives on the row
   * (`selectionRequired` / `data-selected`). The picker shape. Wins over
   * {@link focusGroup} if both are set.
   * @default false
   */
  keyboardSubordinate?: boolean;

  /**
   * Single-select keyboard model — the picker shape ([P01]/[P12]). When set
   * (and the list is authored into a {@link focusGroup}), the list is a
   * single-selected-row container: the **arrow / Home / End / Page** keys move
   * the cursor *and* commit selection on the landed row (selection follows the
   * cursor — no separate Space step), and the container does **not** consume
   * `Enter` — it declares the engine's single-select flag so Return falls through
   * to the surface's default action ([P12], the `persistentDefaultRing` button).
   * On gaining the key view the list seeds the cursor + selection onto
   * {@link initialSelectedIndex} (the currently-active row) when given, else the
   * first selectable row, so there is always exactly one selected row and the
   * arrows start from the right place.
   *
   * Omitted leaves the default multi-select / descend cursor model
   * (arrows move a distinct cursor, Space selects, Enter acts/descends).
   *
   * @default false
   */
  singleSelect?: boolean;

  /**
   * Opt into **consumer-owned multi-select**: the host holds the selected-id
   * set and receives selection intents, and the list renders the set.
   *
   * The set is the host's because it outlives the list — the Cards section's
   * selection is what the deck's layout verbs act on, and it must survive the
   * section collapsing away. The list is a view of it, per [L02]; every member
   * row is stamped `data-selected`, and the paint is CSS's ([L06]).
   *
   * Three intents, and the list never decides between them twice: a ⌘-click
   * toggles membership, a ⇧-click (or ⇧+Arrow / Home / End) extends from the
   * anchor, and a plain click picks. The modifiers come off the gesture record,
   * and the rule is `multiSelectIntentFor`.
   *
   * `onPick` is deliberately NOT `delegate.onSelect`: a plain click means both
   * things (pick this row AND front its card) while a modifier click means only
   * the first, so the two callbacks fire on different gestures.
   *
   * Each intent returns whether it TOOK the row. A list may hold rows that are
   * not selection material — this data source files its group headers as
   * `"cell"` on purpose, so the arrow walk reaches them — and only the consumer
   * knows which those are. Answering `false` puts the gesture back on the
   * ordinary `delegate.onSelect` path, so Space on a group header still folds
   * the group instead of quietly selecting nothing.
   *
   * `onClear` is Escape's, and it is why the set can be taken back the same way
   * no matter how it was built: while the list holds the keyboard and the set is
   * non-empty, the list CAPTURES Escape ahead of every rung of the engine's
   * Escape ladder, so "leave the keyboard mode" can never spend the press the
   * user meant for the selection. Return `true` if the press cleared something.
   */
  multiSelect?: {
    readonly selectedIds: ReadonlySet<string>;
    readonly onPick: (id: string) => boolean;
    readonly onToggle: (id: string) => boolean;
    readonly onExtendTo: (id: string) => boolean;
    readonly onClear: () => boolean;
    /**
     * Whether a set stands at all, when `selectedIds` cannot answer that.
     *
     * `selectedIds` is a projection over the rows this list is currently
     * showing, so a consumer whose set outlives its rows — filtered out,
     * inside a folded group — reports an empty projection over a set that is
     * very much still there. Escape must clear it anyway: what the user is
     * taking back is the set, not the part of it they can see.
     *
     * Consulted only by the Escape gates (the `captures` claim and
     * `handleListKey`). Painting stays on `selectedIds`, which is the right
     * answer for "which visible rows are filled". Omit it and the size of
     * `selectedIds` answers, which is correct for a list whose set is its rows.
     */
    readonly hasSelection?: () => boolean;
  };

  /**
   * The movement cursor moved, or stopped being anywhere.
   *
   * Fires with the cursor row's id while this list holds the keyboard, and with
   * `null` the moment it does not — the same gate the cursor's own paint runs
   * (`projectCursor`), so the callback and what the user can see never
   * disagree. A consumer that wants to answer "which row is the keyboard on
   * right now" reads it from here rather than querying the DOM for
   * `data-key-cursor`.
   *
   * The cursor is engine state and moves on every arrow, so this is a DOM-rate
   * notification: do not set React state from it. Publish it somewhere
   * imperative and read it when a gesture asks.
   */
  onCursorChange?(id: string | null): void;

  /**
   * Carry the selection with the movement cursor on a `selectionRequired` list
   * — the arrow / Home / End / Page keys commit the landed row exactly as they
   * do under {@link singleSelect}, so the fill and the cursor bar are never on
   * two different rows.
   *
   * The two modes differ in what the list does with Enter and Space, not in how
   * selection moves: a `singleSelect` list is a picker whose cursor IS its
   * selection, while a `selectionRequired` list keeps its own Enter (open) and
   * Space (the consumer's reserved key) and merely wants its one owned selected
   * row to follow the keyboard. Without this the cursor roves ahead of a fill
   * left behind on the last clicked row, and the section verbs — which act on
   * the CURSOR — read as acting on some other row than the one lit.
   *
   * Ignored unless {@link selectionRequired} is set; a `singleSelect` list
   * already behaves this way.
   *
   * @default false
   */
  selectionFollowsCursor?: boolean;

  /**
   * The row the movement cursor seeds onto when the list first gains the key view
   * — the currently-active choice. Honored for ANY authored list (not only
   * `singleSelect`): a consumer whose selection lives outside the list points the
   * opening cursor at the chosen row instead of the top. A value that is not a
   * selectable (`"cell"`-role) row falls back to the first selectable row. The
   * seed is cursor-only; only a `singleSelect` + `seedSelection` list also commits
   * the seeded row.
   */
  initialSelectedIndex?: number;

  /**
   * Commit the seeded row's selection when the {@link singleSelect} list first
   * gains the key view — for a surface whose list IS the opening default and
   * needs its default action enabled on open (a pick-first picker: the rewind
   * turn list auto-selects its first turn so Rewind enables and its ring lights).
   * Ignored unless `singleSelect` is set.
   *
   * Default `false` — the gain-seed only *lands the cursor*; selection then
   * follows explicit arrow movement. Leave it off when merely cycling the key
   * view onto the list must not commit a row (a recents list that would
   * otherwise overwrite a typed path the instant it gains focus).
   *
   * @default false
   */
  seedSelection?: boolean;

  /**
   * How **Enter** on the cursor row behaves when the list is authored into a
   * {@link focusGroup} (the multi-select item-group shape, [P24]). By default an
   * item container does not consume Enter — it bubbles to the scope's default
   * button. Opt in here when the list IS the surface's commit-advance control:
   *
   *  - `"act"` — Enter performs a DISTINCT act, routed to
   *    {@link TugListViewDelegate.onActivate}, separate from Space's
   *    {@link TugListViewDelegate.onSelect}. The list still commits its own
   *    selection on the cursor row first. For a list whose Space (toggle) and
   *    Enter (commit-and-advance) differ — the question wizard's multi-select
   *    options.
   *
   * Ignored unless the list is registered into a `focusGroup` and not
   * `singleSelect` (a single-select list never consumes Enter; Right is its
   * descend gesture).
   *
   * @default undefined (Enter bubbles to the scope default)
   */
  commitOnEnter?: "act";

  /**
   * Activate a row on **double-click** — fire {@link TugListViewDelegate.onActivate}
   * on the cell's second click. The Things model: a single click SELECTS (and
   * focuses) the row via `onSelect`, and a double-click OPENS it via `onActivate`
   * — the pointer equivalent of Enter. Opt in only where `onSelect` and
   * `onActivate` are DISTINCT and a single click must not activate; a list whose
   * click already activates (`onSelect === onActivate`) has no need for it.
   *
   * @default false (a double-click is just two selects)
   */
  activateOnDoubleClick?: boolean;

  /**
   * Keys the consumer reserves for its own handling ([P04] captures). Each is a
   * `KeyboardEvent.key` value (e.g. `" "` for Space). While the container holds
   * the key view, the engine's act-dispatch treats a listed key as captured —
   * it does NOT resolve it to select/act, so the key bubbles to the consumer's
   * own keydown handler. Use for a list that repurposes a normally-committing
   * key: the Jots list reserves Space to mean "new jot below the
   * cursor" instead of the default item-container select.
   *
   * @default undefined (no keys reserved)
   */
  captureKeys?: readonly string[];

  /**
   * Consumer key delegate on the engine's key-view channel ([P05] of
   * keyboard-as-engine-state). Invoked while this list holds the key view,
   * AFTER the list's own movement keys decline the event — the delegated
   * replacement for a bubble-phase container `onKeyDown` around the list,
   * which never fires in engine-routed mode (keydown lands on the key
   * sink, not in this subtree). Return `true` = handled (the engine
   * consumes the event). Pair with {@link captureKeys} for keys the act
   * dispatch would otherwise resolve first (e.g. reserve Space so a
   * section-verb delegate sees it instead of the item-container select).
   */
  onKeyViewKey?: (event: KeyboardEvent) => boolean;

  /**
   * The pairing with the `TugFilterField` that trims this list ([P08]) — the
   * same binding the field receives as `attachment`.
   *
   * Passing it declares the UPWARD half of the attached-list contract: while
   * this list holds the key view, a printable character the list itself does
   * not claim grants the caret to that field and lands there, so the user can
   * start filtering without tabbing away from the list first. The downward half
   * (↑/↓ from the caret drive this list's cursor) is the field's, via the
   * delegate. See `attached-filter.ts`.
   *
   * `captureKeys` / {@link onKeyViewKey} still win: the forward is only offered
   * a key this list declined, so a list with single-key verbs keeps them.
   */
  attachedFilter?: AttachedFilterBinding;

  /**
   * ARIA role for the scroll container. Defaults to `"list"`. Override for a
   * list that is semantically a selection group — e.g. `"radiogroup"` (a
   * single-select option list) or `"group"` (a multi-select one). The cell
   * renderer then stamps the matching item role (`role="radio"` / `"checkbox"`)
   * + `aria-checked` on its row, and {@link itemRole} flattens the wrapper.
   * @default "list"
   */
  listRole?: string;

  /**
   * ARIA role for each cell wrapper. Defaults to `"listitem"`. Set to
   * `"presentation"` when the row itself carries the semantic role (e.g. a
   * `radiogroup` whose rows are `role="radio"`), so the wrapper doesn't insert a
   * spurious `listitem` between the group and its items.
   * @default "listitem"
   */
  itemRole?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// The inner type a generic `forwardRef` collapses into — exported so
// consumers that want a typed ref can write
// `useRef<TugListViewHandle>()` without re-declaring the component
// shape.
type TugListViewComponent = <DS extends TugListViewDataSource>(
  props: TugListViewProps<DS> & { ref?: React.Ref<TugListViewHandle> },
) => React.ReactElement | null;

/**
 * Default per-kind estimated height used when the consumer's delegate
 * omits `estimatedHeightForKind`. Matches the JSDoc on
 * `TugListViewDelegate.estimatedHeightForKind`.
 */
const DEFAULT_ESTIMATED_HEIGHT = 60;

/**
 * Number of cells rendered above and below the visible viewport.
 * Trades DOM weight for scroll smoothness — three cells of overscan
 * is enough to absorb a frame of fast scrolling at typical row
 * heights without keeping a giant subtree in memory.
 *
 * Step 4 may surface this as a delegate option; for v1 it's a
 * primitive-internal constant.
 */
const OVERSCAN_COUNT = 3;

/**
 * Cold-fill chunk size, in rows. A list that mounts with a full
 * transcript already in its data source (the cold-restore reveal) does
 * not mount it in one commit: every card in the app shares one main
 * thread, and a single commit rendering, laying out, and measuring a
 * hundred markdown-heavy rows is a multi-second task during which no
 * card — not this one, not its neighbours — can take a keystroke.
 * Instead the reveal mounts the LAST chunk first (the screenful the
 * user will actually see, pinned to the bottom) and extends the
 * mounted range upward one chunk per macrotask, yielding to the event
 * loop between chunks so input, paint, and the other restoring cards'
 * socket traffic interleave. The settle handshake fires only once the
 * fill reaches the top, so every consumer downstream of
 * `onFirstSettle` sees exactly the state a monolithic mount would
 * have produced: all rows measured, ledger covered, bottom placed.
 *
 * While the fill is in flight the top spacer stands on ESTIMATED
 * heights for the not-yet-mounted rows — the one deliberate exception
 * to the no-estimates invariant, bounded by the fill itself: the
 * scroll battery is frozen, the view is pinned to the bottom edge (so
 * spacer error above cannot displace visible content), and the last
 * chunk replaces the final estimate before the settle releases.
 */
const COLD_FILL_CHUNK = 8;

/**
 * Eviction margins, in viewport heights (see the `evictOffscreen`
 * prop). A row mounts once it is within one viewport of the scrollport
 * and is not released until it is two viewports away — the gap is the
 * hysteresis band, and it is also the budget for a fast flick: at a
 * viewport of scroll per frame, a row is already mounted a frame
 * before it could be seen.
 *
 * Cell counts cannot express this: transcript rows range from one line
 * to thousands, so "three cells" is a screenful in one place and a
 * sliver in another.
 */
const EVICT_MOUNT_MARGIN_VIEWPORTS = 1;
const EVICT_RETAIN_MARGIN_VIEWPORTS = 2;

/** Top-edge tolerance (CSS px) for the `onAtTopChange` signal — a few
 *  pixels of slop so a sub-pixel resting `scrollTop` still reads "at top." */
const AT_TOP_EPSILON = 4;

/**
 * `scrollToIndex` two-pass correction threshold (CSS pixels). If the
 * measured offset for the target row differs from the estimated
 * offset used in pass 1 by more than this amount, pass 2 issues a
 * corrective `scrollTo`. Below the threshold, sub-pixel rounding
 * noise shouldn't trigger a second scroll write that the user might
 * perceive as a small jump. Sourced from [D03].
 */
const SCROLL_CORRECTION_THRESHOLD_PX = 4;

/**
 * Drift beyond which a pending two-pass correction concedes the
 * scroll position to whoever moved it. Pass 1 records the post-write
 * `scrollTop` read-back (browser clamping folded in); if the
 * correction effect later finds the scroller more than this far from
 * that baseline, some actor the list view cannot see moved it — a
 * user gesture, above all the event-silent native scrollbar — and
 * issuing the deferred correction would snap them to a stale target.
 * Matches SmartScroll's `RESTORE_SUPERSEDE_DRIFT_PX`.
 */
const SCROLL_CORRECTION_SUPERSEDE_DRIFT_PX = 8;

/**
 * Trailing settle interval for width invalidation (ms). A live
 * splitter drag fires the width observer every frame; wiping the
 * measured-height ledger per fire forces a full remount + re-measure
 * cycle per tick. Instead each qualifying fire restarts this timer
 * and the invalidation body runs once, at rest. Long enough that a
 * continuous drag coalesces to one wipe; short enough that a discrete
 * resize (window snap, pane preset) re-measures promptly. A plain
 * `setTimeout` — never rAF, which background windows suspend.
 */
const WIDTH_INVALIDATION_SETTLE_MS = 200;

/**
 * Role assigned to a cell when the data source omits `roleForIndex`
 * or returns `undefined` for an index. Single source of truth for the
 * "cell" default so the inline reads in render, click, and keydown
 * paths agree on the fallback identity.
 */
const DEFAULT_CELL_ROLE: TugListViewCellRole = "cell";

/**
 * Movement below which a `scrollTop` difference across a commit is
 * noise rather than displacement. Sub-pixel layout rounding and the
 * fractional heights the ledger carries can shift the position by a
 * fraction; two pixels sits above that and far below any real clamp
 * (the field captures were thousands of pixels).
 */
const DISPLACEMENT_EPSILON_PX = 2;

/**
 * Height the clamp simulation shortens the top spacer by. Large
 * enough to pull the scroll maximum below `scrollTop` from a position
 * near the bottom of an evicting transcript, small enough to stay
 * inside a realistic window's spacer.
 */
const SIMULATED_CLAMP_SHRINK_PX = 2000;

/**
 * What the displacement bracket remembers from one commit to the next.
 *
 * `scrollTop` is the position that commit observed, so the next
 * bracket's unchanged-position suppressor compares against it.
 * `following` is the follow-bottom state as of the commit, recorded in
 * any displacement record so the trace shows what the defect landed on.
 */
interface CommitGeometry {
  userActivitySeq: number;
  programmaticWriteSeq: number;
  scrollTop: number;
  following: boolean;
}

/**
 * Out-of-tree control handles for a list view, keyed by its scroll
 * container.
 *
 * Same problem the `SmartScroll` registry solves, one level up: the
 * test surface can resolve a scroll element by its
 * `data-tug-scroll-key` selector, but the list view's own state lives
 * in refs inside a closure with no route in. The `Scroller` façade the
 * component publishes is a React context value, reachable only by
 * descendants.
 */
/**
 * One departed row whose ledger charge disagreed with its last live
 * rendered extent — the per-row term of a conservation violation.
 */
interface ConservationRowDiff {
  index: number;
  kind: string;
  /** What the spacer charges for the row (ledger outer extent). */
  ledger: number;
  /** What the row actually occupied while mounted (border-box + gap). */
  live: number;
}

/**
 * One eviction's height accounting. `delta = sumLedger - sumLive` is
 * the document height error the swap introduced: negative means the
 * document SHRANK by that many pixels — the quantity a browser clamp
 * then acts on.
 */
interface ConservationEvent {
  departed: number;
  sumLedger: number;
  sumLive: number;
  delta: number;
  first: number;
  last: number;
  itemCount: number;
  scrollHeight: number;
  rows: ConservationRowDiff[];
}

/** Ledger-vs-live audit row for a currently mounted cell. */
interface LedgerAuditRow {
  index: number;
  kind: string;
  ledger: number | null;
  live: number;
  delta: number;
}

interface LedgerAudit {
  gap: number;
  mounted: number;
  /** Largest |ledger − live| across mounted cells. */
  worst: number;
  /** Mismatching cells only (|delta| ≥ 0.5px or no ledger entry). */
  rows: LedgerAuditRow[];
}

/**
 * One commit's post-layout geometry, as the commit bracket saw it.
 * A dip in `h` between consecutive entries is an inter-commit document
 * shrink; a displaced `top` with `h` steady on both sides means the
 * shrink-and-recover happened entirely inside one commit's layout
 * passes, where only the clamped position survives as evidence.
 */
interface CommitGeometryRecord {
  top: number;
  h: number;
  ts: number;
  bs: number;
  first: number;
  last: number;
  n: number;
}

interface ListViewProbe {
  /** Arm the one-shot clamp simulation — see `forceCommitClamp`. */
  forceCommitClamp(): void;
  /** Displacements recorded since mount. */
  displacementCount(): number;
  /** Eviction conservation records since mount, oldest first. */
  conservationEvents(): ConservationEvent[];
  /** Ledger-vs-live audit of every currently mounted cell. */
  auditLedger(): LedgerAudit;
  /** Per-commit geometry, most recent last, capped. */
  geometryRing(): CommitGeometryRecord[];
  /** The extent floor's current height and the trailing pad below it. */
  extentFloor(): { height: number; inset: number };
}

const listViewProbeRegistry = new Map<Element, ListViewProbe>();

/**
 * The scroller's block-end pseudo-padding in pixels — the one piece of
 * scrollable extent that lies BELOW the bottom spacer and still counts
 * as content.
 *
 * The block-axis breathing room is a pair of pseudo-elements rather than
 * container padding, so sticky descendants pin flush to the scrollport
 * (see the `::before` / `::after` rules). That puts `::after` after every
 * real child in flow, which is why the last element edge the commit
 * bracket can reach through a ref falls short of the true extent by
 * exactly this much.
 *
 * Returns 0 for a scroller with no pad, and for any reading that is not
 * a finite positive length — the pad is an addition to a measured edge,
 * and guessing one is strictly worse than adding nothing.
 */
function trailingPadOf(el: HTMLElement): number {
  const raw = window.getComputedStyle(el, "::after").height;
  const px = Number.parseFloat(raw);
  return Number.isFinite(px) && px > 0 ? px : 0;
}

/**
 * The probe handle for the list view whose scroll container is `el`,
 * or `null` when `el` is not one.
 *
 * The test surface's route to the displacement bracket. Deliberately
 * not part of the `TugListViewHandle` imperative API: nothing in the
 * app drives these, and putting a clamp simulator on the public handle
 * would invite it.
 */
export function listViewProbeForScroller(el: Element | null): ListViewProbe | null {
  if (el === null) return null;
  return listViewProbeRegistry.get(el) ?? null;
}

/**
 * Resolve the effective selected index for `selectionRequired` mode.
 *
 * Keeps `current` when it still points at a selectable row (in range,
 * `roleForIndex === "cell"`, and `enabledForIndex !== false`);
 * otherwise falls to the first selectable row. Returns `null` only
 * when the data source has no selectable rows at all — the transient
 * empty-list state. Pure: no DOM, no side effects, just a read of the
 * data source.
 */
/**
 * Whether the keyboard is inside this list at all — holding the key view on the
 * container, or descended into one of its rows (which the engine marks on the
 * container as `data-key-within`, since the container it descended FROM is
 * still an ancestor of the active accessory).
 *
 * The list's focus language is keyed off this rather than off the key view
 * alone: a descend goes deeper into the list, so the container keeps its ring
 * and the cursor row keeps its bar. Only leaving the list entirely puts them
 * out.
 */
function keyboardIsInList(el: HTMLElement | null): boolean {
  return (
    el !== null &&
    (el.hasAttribute("data-key-view-kbd") || el.hasAttribute(KEY_WITHIN_ATTRIBUTE))
  );
}

function resolveSelectionIndex(
  current: number | null,
  dataSource: TugListViewDataSource,
): number | null {
  const count = dataSource.numberOfItems();
  const isSelectable = (i: number): boolean =>
    i >= 0 &&
    i < count &&
    (dataSource.roleForIndex?.(i) ?? DEFAULT_CELL_ROLE) === "cell" &&
    (dataSource.enabledForIndex?.(i) ?? true);
  if (current !== null && isSelectable(current)) return current;
  for (let i = 0; i < count; i += 1) {
    if (isSelectable(i)) return i;
  }
  return null;
}

/**
 * `TugListView` implementation — windowing + cell reuse + delegate
 * lifecycle + SmartScroll-driven scroll-position writes, layered on
 * a sparse height index.
 *
 * The list view subscribes to the data source via
 * `useSyncExternalStore` ([L02]). A `SmartScroll` instance bound to
 * the scroll container owns every programmatic scroll-position
 * write per [D07]; its `onScroll` callback drives the re-window
 * tick. Cell heights flow through a `HeightIndex`: a single
 * `ResizeObserver` instance observes every rendered cell wrapper;
 * observer callbacks update the index, queue a single rAF flush,
 * and force a re-window on flush. Unmeasured indices fall back to
 * `delegate.estimatedHeightForKind`. Cell-lifecycle delegate
 * dispatch (`willDisplay` / `didEndDisplaying` / `onSelect`) sits on
 * top: a per-commit layout effect diffs the rendered index set
 * against the previous commit and notifies the delegate of
 * transitions; the cell wrapper's `onClick` handler fires
 * `onSelect`. Auto-follow-bottom is handled by a post-commit pin
 * effect plus the per-cell / container `ResizeObserver` callbacks,
 * all of which route through `SmartScroll.maybePinToBottom` — the
 * single owner of the `isFollowingBottom && !isUserScrolling` gate.
 *
 * What's stable today:
 * - DOM shape per the plan's [#dom-shape]: scroll container,
 *   top spacer, window div with one wrapper per rendered cell, bottom
 *   spacer.
 * - Cell wrapper carries `data-tug-list-cell-index` and
 *   `data-tug-list-cell-kind` for test addressability, observer
 *   index lookup, and (later) reuse-pool routing, plus
 *   `data-row-parity` — the band the row takes, which alternating row
 *   tint reads instead of `:nth-child` (windowing slides the rendered
 *   range, so child order is not row order). It is the row's index
 *   parity unless the delegate's `stripeParityForIndex` says
 *   otherwise, which is how a sectioned list restarts its banding at
 *   each heading. Wrappers for cells
 *   whose `roleForIndex` is `"header"` or `"footer"` additionally
 *   carry `data-list-cell-role` set to that value, render with
 *   `tabIndex={-1}`, and short-circuit the wrapper-level `onSelect`
 *   dispatch on click and Space/Enter keydown — see the top-of-file
 *   "Row roles" docstring for the full contract.
 * - Spacer heights write directly to the DOM via `style.height`
 *   ([L06], mirroring `TugMarkdownView`).
 * - Imperative handle: `scrollToIndex` routes through SmartScroll
 *   ([D07]). Rendered target → `scrollToElement`. Unrendered
 *   target → two-pass precision protocol per [D03]: pass 1 is an
 *   estimated `scrollTo` jump; pass 2 (post-commit correction
 *   effect, threshold 4px) reconciles after the target row mounts
 *   and is measured. Out-of-range indices clamp to first/last; NaN
 *   and empty data sources are no-ops. `getElementForIndex` reads
 *   from a ref map populated by cell wrapper refs.
 * - `ResizeObserver` callbacks coalesce via `requestAnimationFrame`
 *   ([R01] mitigation): rapid sequential resize events from the
 *   browser fold into one rerender per paint frame. [L05] forbids
 *   RAF for state-commit-dependent ops; this RAF is callback-
 *   coalescing, not commit-waiting.
 * - Delegate lifecycle: `willDisplay` fires before
 *   `didEndDisplaying` for transitions in the same commit; both
 *   fire in numeric-ascending order; `onSelect` fires on cell click.
 *   Lifecycle dispatch is purely about visibility transitions inside
 *   a live list view — list-view unmount does not synthesise
 *   `didEndDisplaying`.
 * - Auto-follow-bottom: pinning is gated by
 *   `smartScroll.isFollowingBottom` and `!smartScroll.isUserScrolling`,
 *   read from the live instance per [L07]. User scroll-up disengages
 *   via SmartScroll's own scroll-event handling; idle-at-bottom
 *   re-engagement is also SmartScroll's job.
 */
const TugListViewInner = React.forwardRef<TugListViewHandle, TugListViewProps>(
  function TugListView(
    {
      dataSource,
      delegate,
      cellRenderers,
      scrollKey,
      className,
      leadingContent,
      trailingContent,
      followBottom,
      batchLoading = false,
      onFirstSettle,
      inline,
      offscreenSkip = false,
      evictOffscreen = false,
      interactive = true,
      rowLayout,
      rowDensity,
      rowSeparator,
      rowStriping,
      rowTextSize,
      selectedAccent = false,
      selectionSurface,
      pageByEntry,
      selectionRequired = false,
      onSelectionChange,
      onFollowBottomChange,
      onAtTopChange,
      onRenderedRangeChange,
      focusGroup,
      focusOrder = 0,
      focusPolicy,
      keyboardSubordinate = false,
      singleSelect = false,
      multiSelect,
      onCursorChange,
      selectionFollowsCursor = false,
      initialSelectedIndex,
      seedSelection = false,
      commitOnEnter,
      activateOnDoubleClick = false,
      captureKeys,
      onKeyViewKey,
      attachedFilter,
      listRole = "list",
      itemRole = "listitem",
    },
    ref,
  ) {
    // The listbox model engages only when the surface authored a `focusGroup`
    // and the list is not subordinate to an external focus owner ([P01]/[P03]).
    // A subordinate list (picker filter input owns focus) never self-registers.
    const focusEngineActive = focusGroup !== undefined && !keyboardSubordinate;

    // Follow-bottom is for a GROWING, scroll-only stream (the transcript): it
    // re-pins the scroll to the live bottom on every commit while the last row
    // is in the window. That is fundamentally incompatible with a keyboard
    // selection list — the movement cursor owns the scroll position, so every
    // ArrowUp would be yanked straight back to the bottom (the selected row
    // scrolls out of view and, when windowed, unmounts). A selection list —
    // authored into a `focusGroup`, `keyboardSubordinate` to a filter, or
    // `singleSelect` — therefore can NEVER follow-bottom: the prop is forced
    // off here regardless of what the consumer passed, and a dev warning flags
    // the contradiction at the call site.
    const isSelectionList =
      focusGroup !== undefined || keyboardSubordinate || singleSelect;
    const followBottomEffective = followBottom === true && !isSelectionList;
    if (
      process.env.NODE_ENV !== "production" &&
      followBottom === true &&
      isSelectionList
    ) {
      console.warn(
        "[TugListView] `followBottom` is ignored on a keyboard-selection list " +
          "(focusGroup / keyboardSubordinate / singleSelect): the movement " +
          "cursor owns the scroll position. Drop the prop.",
      );
    }

    const scrollContainerRef = React.useRef<HTMLDivElement | null>(null);
    // Live gate for the ResizeObserver's offscreen-skip stamping — a ref
    // so the long-lived observer callback reads the current prop value
    // without re-installing the observer.
    const offscreenSkipRef = React.useRef(false);
    offscreenSkipRef.current = inline === true && offscreenSkip;
    const topSpacerRef = React.useRef<HTMLDivElement | null>(null);
    const bottomSpacerRef = React.useRef<HTMLDivElement | null>(null);
    // The commit bracket's memory of the previous commit — see the
    // displacement effect below for what each field is for.
    const commitGeometryRef = React.useRef<CommitGeometry | null>(null);
    const displacementCountRef = React.useRef(0);
    // Conservation probe state: every mounted cell's live outer extent
    // as of the previous commit, and the per-eviction accounting
    // records. See the conservation block in the commit bracket.
    const liveExtentsRef = React.useRef<Map<number, { live: number; kind: string }>>(
      new Map(),
    );
    const conservationEventsRef = React.useRef<ConservationEvent[]>([]);
    const geometryRingRef = React.useRef<CommitGeometryRecord[]>([]);
    // The extent floor — the element that pins the scrollable extent so
    // it cannot dip mid-mutation, and the commit bracket's record of
    // what it last wrote there. `height` is the floor's current pixel
    // height (owned exclusively by the bracket, as a DOM write [L06] —
    // React renders the element with no height so there is no second
    // writer to go stale against). `inset` is the block-end
    // pseudo-padding that sits below the bottom spacer, re-measured
    // from the DOM every commit rather than carried — it is reported to
    // the probe, and never read back as an input.
    const extentFloorRef = React.useRef<HTMLDivElement | null>(null);
    const extentFloorStateRef = React.useRef({ height: 0, inset: 0 });
    // One-shot arming flag for the clamp simulation the test surface
    // drives. See the displacement effect.
    const forceClampRef = React.useRef(false);
    // Eviction mode is an `inline` sub-mode — it reuses every inline
    // subsystem and only changes which rows reach the DOM.
    const evictModeEnabled = inline === true && evictOffscreen;
    if (
      process.env.NODE_ENV !== "production" &&
      evictOffscreen &&
      inline !== true
    ) {
      console.warn(
        "[TugListView] `evictOffscreen` requires `inline` — it evicts rows " +
          "the inline path measured. Ignored on a windowed list, which " +
          "already renders a window.",
      );
    }
    // The leading-content wrapper. Rows live in a coordinate space whose
    // origin is row 0's top, but leading content sits ABOVE row 0, so
    // every `scrollTop` computed from row offsets has to add the leading
    // element's height to land where the caller meant. Read live: the
    // element's height changes with its content.
    const leadingElRef = React.useRef<HTMLDivElement | null>(null);
    const leadingOffsetPx = React.useCallback(
      (): number => leadingElRef.current?.offsetHeight ?? 0,
      [],
    );
    // The rendered window is a flex column with a `row-gap`, so the space a
    // row occupies in the flow is its measured height PLUS the gap that
    // follows it. Rows that are not rendered are represented by the spacers,
    // which sit outside that flex box and get no gaps of their own — so
    // unless the gap travels with the height, every unrendered row silently
    // loses its share of it and the document changes size as the window
    // moves. The ledger therefore stores each row's OUTER extent
    // (height + gap); `contain-intrinsic-size` keeps the raw measured height,
    // which is what it means.
    //
    // The arithmetic works out exactly. A top spacer covering rows [0, f)
    // carries f gaps — one after each, the last being the f-1↔f separation.
    // A bottom spacer covering [l, n) carries n-l gaps — one BEFORE each,
    // the first being the l-1↔l separation. Sum: the true (n-1) gaps.
    //
    // Read from the live DOM rather than the token, so a theme or layout
    // that changes the gap is picked up without a parallel source of truth.
    const listWindowElRef = React.useRef<HTMLDivElement | null>(null);
    const rowGapPxRef = React.useRef<number | null>(null);
    // Read the live flex row-gap and FOLD ANY CHANGE INTO THE LEDGER.
    // The gap is part of every ledger entry (outer extent = height +
    // gap), and it is not a constant: a host resolves it from a custom
    // property that can land AFTER the list mounts, and a theme or
    // density change can move it any time. A one-shot mount read left
    // every entry short by the
    // difference between the mount-time gap and the settled one — a
    // uniform per-row deficit that collapses `scrollHeight` under
    // eviction and misplaces every spacer. Rebasing (`adjustAll` by
    // the delta) restores exactness without re-measuring: the rows'
    // own heights didn't change, only the folded gap term. Returns
    // `true` when a change was folded, so callers re-window.
    const syncRowGap = React.useCallback((): boolean => {
      const el = listWindowElRef.current;
      if (el === null) return false;
      const raw = Number.parseFloat(getComputedStyle(el).rowGap);
      const gap = Number.isFinite(raw) ? raw : 0;
      const prev = rowGapPxRef.current;
      if (prev === null) {
        rowGapPxRef.current = gap;
        return false;
      }
      if (Math.abs(gap - prev) < 0.5) return false;
      rowGapPxRef.current = gap;
      heightIndexRef.current.adjustAll(gap - prev);
      return true;
    }, []);

    // Previous commit's rendered range, fed back to `computeWindow` as
    // the retention input so the mount/retain hysteresis has a memory.
    const prevWindowRangeRef = React.useRef<{ first: number; last: number } | null>(
      null,
    );
    // Diagnostics ([P08] of the eviction plan): how many commits fell
    // back to rendering everything because the ledger was incomplete,
    // and whether the current commit is actually evicting. Published as
    // DOM attributes post-commit, never React state.
    const evictFallbackCountRef = React.useRef(0);
    const evictActiveRef = React.useRef(false);

    // Scrollport state for descendants — `OuterScrollportContext` publishes
    // this element so body-kind affordances can compensate `scrollTop` when
    // their click triggers a layout change in or around the chrome header.
    // Tracking the same node in React state (alongside the ref) lets the
    // context re-publish the moment the scroll container mounts. The
    // composed ref callback below updates both atomically. Same shape as
    // `BlockChrome` uses for its actions target — and for the same
    // reason: descendants need a non-null value on their first render-
    // after-mount, not "a ref that fires later." See
    // `internal/outer-scrollport-context.tsx` for the consumer hook.
    const [scrollportEl, setScrollportEl] =
      React.useState<HTMLDivElement | null>(null);
    // The engine's `focusableRef` from `useFocusable` (declared below, since it
    // depends on the cursor/behavior helpers). Held in a ref so the container
    // ref callback — created earlier in render order — can call the latest one
    // without re-creating itself. The `useFocusable` ref is itself stable, so
    // this indirection never churns the attachment.
    const engineFocusableRef = React.useRef<
      ((el: Element | null) => void) | null
    >(null);
    const setScrollContainerRef = React.useCallback(
      (el: HTMLDivElement | null) => {
        scrollContainerRef.current = el;
        setScrollportEl(el);
        // Stamp the engine focusable onto the scroll container when the list is
        // authored into a focus group ([P01]). A no-op (no `data-tug-focusable`)
        // for un-authored / subordinate lists, since `useFocusable` only stamps
        // when `register` is true.
        engineFocusableRef.current?.(el);
      },
      [],
    );

    // Map<index, HTMLElement> populated by cell-wrapper ref callbacks.
    // Used by `getElementForIndex` for direct DOM addressing without a
    // querySelector roundtrip. Cleaned up by the ref callback when a
    // cell unmounts.
    const cellElementMapRef = React.useRef<Map<number, HTMLDivElement>>(
      new Map(),
    );

    // `selectionRequired` mode — list-view-owned selected index
    // (local-data zone [L24]; React state is sanctioned for "selected
    // item in a list"). `null` only transiently, before the first
    // selectable row exists; the reconcile effect below drives it to a
    // concrete index and never lets it fall back to `null` while a
    // selectable row is present. Dead weight when `selectionRequired`
    // is `false` — the resolve + effect short-circuit on the flag.
    const [selectedIndex, setSelectedIndex] = React.useState<number | null>(
      null,
    );
    // Live refs so the per-index cached click / keydown closures read
    // current values at fire time [L07].
    const selectionRequiredRef = React.useRef(selectionRequired);
    selectionRequiredRef.current = selectionRequired;
    const multiSelectRef = React.useRef(multiSelect);
    multiSelectRef.current = multiSelect;
    /** Does a set stand? The consumer answers when its set outlives its rows
     *  (`multiSelect.hasSelection`); otherwise the visible projection does. */
    const multiSelectSetStands = (): boolean => {
      const ms = multiSelectRef.current;
      if (ms === undefined) return false;
      return ms.hasSelection?.() ?? ms.selectedIds.size > 0;
    };
    const onCursorChangeRef = React.useRef(onCursorChange);
    onCursorChangeRef.current = onCursorChange;
    // The id last published, so the callback fires on a real move rather than
    // on every re-projection — the cursor is re-projected after every commit.
    const reportedCursorIdRef = React.useRef<string | null>(null);
    // `commitMultiSelect` is defined further down, beside the cell callbacks it
    // was written for; the keyboard paths above it reach it through this ref
    // ([L07], the same shape the cursor handle uses).
    const commitMultiSelectRef = React.useRef<
      (index: number, intent: MultiSelectIntent) => MultiSelectIntent | null
    >(() => null);
    const activateOnDoubleClickRef = React.useRef(activateOnDoubleClick);
    activateOnDoubleClickRef.current = activateOnDoubleClick;
    const onSelectionChangeRef = React.useRef(onSelectionChange);
    onSelectionChangeRef.current = onSelectionChange;
    // Last index handed to `onSelectionChange` — dedupes the mirror
    // callback so it fires once per genuine selection change, not on
    // every re-render that happens to keep the same selection.
    const lastReportedSelectionRef = React.useRef<number | null>(null);

    // Sparse height index — measured cells override the estimate.
    // Held in a ref so the same instance survives every render; the
    // measurements are not React state ([L06] — appearance derived
    // from data, not React's render cycle).
    const heightIndexRef = React.useRef<HeightIndex>(new HeightIndex());

    // Single `ResizeObserver` per list-view instance — created in
    // `useLayoutEffect` so the constructor runs after the global
    // (potentially test-overridden) `ResizeObserver` is in place. Cell
    // wrapper refs observe / unobserve via this instance.
    const observerRef = React.useRef<ResizeObserver | null>(null);

    // Previous `dataSource` seen by the ResizeObserver-install effect,
    // used to distinguish a genuine data-source swap (clear the height
    // index) from a mere effect re-run / mount (keep it — it may carry
    // hydrated geometry). `null` until the first run.
    const prevDataSourceForClearRef =
      React.useRef<TugListViewDataSource | null>(null);

    // Pending rAF id for height-flush coalescing, or `null` when no
    // flush is queued. The first observer callback in a burst
    // schedules the rAF; subsequent callbacks within the same burst
    // see the queued id and skip the schedule. The rAF clears the id
    // and forces a rerender, which reads the now-updated height
    // index.
    const pendingFlushRef = React.useRef<number | null>(null);

    // The set of indices the list view rendered on the previous
    // commit. Diffed against the current rendered set in a layout
    // effect to compute `entered` (currently-rendered minus
    // previous) and `left` (previous minus currently-rendered),
    // which drive `delegate.willDisplay` / `didEndDisplaying`. Held
    // in a ref because lifecycle bookkeeping is not React state —
    // the list view derives the rendered set from windowing math
    // every render, then notifies the delegate on transitions.
    const prevRenderedIndicesRef = React.useRef<Set<number>>(new Set());

    // The `SmartScroll` instance bound to the scroll container.
    // Owns every programmatic scroll-position write per [D07] and
    // tracks the user's auto-follow-bottom intent through pointer /
    // wheel / keyboard / scroll-event signals. Created in a layout
    // effect on mount, disposed on unmount. Held in a ref because
    // the instance is a long-lived imperative object — not React
    // state — and is read from refs at use time per [L07] so each
    // call sees the live `isFollowingBottom` flag rather than a
    // closed-over snapshot.
    const smartScrollRef = React.useRef<SmartScroll | null>(null);
    /** Pending release of a resize episode's restore target — see `onPreserveEnd`. */
    const preserveReleaseRef = React.useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );

    // Latest `onFollowBottomChange` — read from the SmartScroll
    // callback (installed once on mount) so a consumer that passes a
    // fresh callback each render is still observed. [L07]
    const onFollowBottomChangeRef = React.useRef(onFollowBottomChange);
    onFollowBottomChangeRef.current = onFollowBottomChange;

    // Latest `onAtTopChange` + the last-fired edge state, so the scroll
    // callback (installed once) fires only on a top-edge transition.
    const onAtTopChangeRef = React.useRef(onAtTopChange);
    onAtTopChangeRef.current = onAtTopChange;
    const prevAtTopRef = React.useRef<boolean | null>(null);

    // Follow-bottom façade published to descendants via
    // `ScrollerProvider`. Its methods delegate to the live
    // `SmartScroll` instance and no-op while it is `null` (pre-mount /
    // post-dispose). `useRef` keeps the first object, so the façade
    // identity is stable for the component's lifetime — the context
    // value never churns, and a body-kind affordance reading
    // `useScroller()` does not re-render on a scroll event. The
    // object literal is re-evaluated each render and discarded by
    // `useRef`, matching the `heightIndexRef` pattern above. [L02] [L07]
    const scrollerFacadeRef = React.useRef<Scroller>({
      engage: (source) => smartScrollRef.current?.engage(source),
      disengage: (source) => smartScrollRef.current?.disengage(source),
      isSettledAtBottom: () =>
        smartScrollRef.current?.isSettledAtBottom ?? false,
    });

    // Mount-in-saved-state for the outer scroller. Read the bag
    // synchronously at render time via `useSavedRegionScroll`; the
    // SmartScroll-install effect reads the same `savedRegionScroll`
    // to install the saved **anchor** (`meta.anchor`) as a restore
    // target. The anchor is a turn-depth-from-bottom + a sub-row
    // offset within the anchored turn — independent of any per-cell
    // height geometry. (The former `meta.cellHeights` geometry-
    // hydration bag is gone: cells render at their real, measured
    // height, so there is no estimate to pre-seed and nothing to
    // pixel-lock.) [L02] saved state via `useSavedRegionScroll`;
    // [L23] anchor restore — see `tuglaws/state-preservation.md`.
    const savedRegionScroll = useSavedRegionScroll(scrollKey);

    // Previous-commit `numberOfItems()` snapshot used to detect
    // data-source growth. Any `itemCount > prev` qualifies as a
    // "grow" and triggers the auto-follow-bottom pin (gated by
    // `smartScroll.isFollowingBottom`). Initial value `0` so the
    // first commit's "grew from 0 to N" classifies as growth — a
    // freshly-mounted following-bottom list view that already has
    // items pins itself to the bottom on first paint.
    const prevItemCountRef = React.useRef<number>(0);

    // Front-insert (prepend) scroll-hold ([L23]). When older turns page
    // in above the view, the data source grows at the FRONT: the row id
    // at index 0 changes. These trackers hold the previously-committed
    // first-row id + count so a commit can be classified as a prepend
    // (vs the common append, where the first id is unchanged and the
    // whole path stays dormant). A detected prepend captures pre-commit
    // scroll geometry in render; the compensation layout effect below
    // holds the viewport by the `scrollHeight` delta after commit.
    const prevFirstIdRef = React.useRef<string | null>(null);
    const prevPrependCountRef = React.useRef<number>(0);
    const pendingPrependRef = React.useRef<{
      added: number;
      oldScrollHeight: number;
      oldScrollTop: number;
    } | null>(null);

    // Set to `true` by signals that legitimately request an auto-pin
    // (mount with `followBottom`, item-count growth, cell ResizeObserver
    // flush, container ResizeObserver). The post-commit pin effect
    // bails out unless this ref is set, then clears it. This breaks
    // the previous "post-commit pin runs every commit" feedback loop
    // where `pinToBottom`'s own scroll event would re-trigger the pin
    // via `onScroll → scrollTick → re-render → pin`. Pin is a DOM
    // appearance update ([L06]) and its true triggers are layout /
    // growth signals; coupling it to React's commit cycle is the
    // L22-spirit violation that produced the relaunch bounce.
    const pinRequestedRef = React.useRef<boolean>(false);

    // Batch-load freeze ([L04] settle handshake). The per-commit scroll
    // battery (the two ResizeObserver sync pins, the post-commit pin effect,
    // and the anchor-state writer) reads geometry that forces a synchronous
    // full-transcript layout. During a batch load + its height settle it
    // stands down. Two independent sources drive the freeze:
    //
    //  - `batchLoadingRef` — the `batchLoading` prop, set by the consumer
    //    for a load-previous bracket (the list is already mounted; the store
    //    flag is the only way it learns a prepend batch is in flight).
    //  - `initialSettlePendingRef` — list-internal: a cold-restore reveal
    //    drops the whole transcript into the data source *before* the list
    //    mounts, so a list that mounts with content is mounting a batch.
    //    This needs no store signal (the restore lifecycle flags drop before
    //    the list even mounts), so the freeze is robust regardless of phase /
    //    session mode. Seeded once below, where `itemCount` is known.
    //
    // `isScrollBatteryFrozen()` is the union both the battery and the settle
    // handshake read. `firstSettleFiredRef` makes `onFirstSettle` one-shot
    // per batch (re-armed on each `batchLoading` rising edge). `pinFrozenPrev
    // Ref` lets the pin effect place once on the falling (settled) edge.
    const batchLoadingRef = React.useRef<boolean>(batchLoading);
    batchLoadingRef.current = batchLoading;
    const initialSettlePendingRef = React.useRef<boolean | null>(null);
    // Cold-fill cursor (see COLD_FILL_CHUNK): the first index of the
    // mounted tail while the initial reveal is filling upward, or
    // `null` when no fill is in flight. Seeded with the settle freeze
    // below; advanced one chunk per macrotask by the post-commit fill
    // effect; `null` again once the mounted range reaches the top.
    const coldFillFirstRef = React.useRef<number | null>(null);
    const coldFillTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );
    const isScrollBatteryFrozen = React.useCallback(
      () => batchLoadingRef.current || initialSettlePendingRef.current === true,
      [],
    );
    const onFirstSettleRef = React.useRef<(() => void) | undefined>(
      onFirstSettle,
    );
    onFirstSettleRef.current = onFirstSettle;
    const prevBatchLoadingRef = React.useRef<boolean>(batchLoading);
    const firstSettleFiredRef = React.useRef<boolean>(false);
    const pinFrozenPrevRef = React.useRef<boolean>(batchLoading);
    React.useLayoutEffect(() => {
      // Rising edge of a load-previous batch: re-arm the one-shot settle
      // signal so this batch's settle fires `onFirstSettle` afresh.
      if (batchLoading && !prevBatchLoadingRef.current) {
        firstSettleFiredRef.current = false;
      }
      prevBatchLoadingRef.current = batchLoading;
    }, [batchLoading]);

    // Pending two-pass `scrollToIndex` correction state, or `null`
    // when no correction is queued. When `scrollToIndex` is called
    // for an unrendered target ([D03]):
    //   1. Pass 1 — the list view jumps to the estimated offset and
    //      records the index, estimated top, the caller's `block`,
    //      and the post-write `scrollTop` read-back (`armedTop`,
    //      clamping folded in) here.
    //   2. The target row mounts on the next windowing pass and
    //      `ResizeObserver` measures it.
    //   3. Pass 2 — the post-commit correction effect (below) first
    //      voids the correction when `scrollTop` has drifted from
    //      `armedTop` (someone — a user gesture, attributable or
    //      not — moved the scroller since pass 1; they own the
    //      position). Otherwise it corrects against the mounted
    //      row's real rect when available, or recomputes the offset
    //      against the now-measured heights and corrects if the
    //      difference exceeds the threshold. Clearing the ref ends
    //      the protocol; subsequent commits do nothing until the
    //      next `scrollToIndex` call.
    const pendingScrollCorrectionRef = React.useRef<{
      index: number;
      estimatedTop: number;
      block: ScrollLogicalPosition;
      armedTop: number;
    } | null>(null);

    // Subscribe to the data source. The returned `version` token is a
    // by-product — we don't use it directly. The hook's job is to
    // re-run this component whenever the data source ticks per its
    // `getVersion` contract ([L02], [#public-api]).
    //
    // Wrap each call so consumers can write `subscribe` / `getVersion`
    // as regular methods (with `this` bindings) rather than arrow
    // class-fields. `useSyncExternalStore` passes the callables around
    // detached from any instance, which would break regular methods
    // without these wrappers.
    const subscribeWrapper = React.useCallback(
      (listener: () => void) => dataSource.subscribe(listener),
      [dataSource],
    );
    const versionWrapper = React.useCallback(
      () => dataSource.getVersion(),
      [dataSource],
    );
    React.useSyncExternalStore(subscribeWrapper, versionWrapper, versionWrapper);

    // `selectionRequired` — resolve the effective selected index from
    // the owned state + the live data source, then reconcile. The
    // resolve runs every render (the `useSyncExternalStore` above
    // re-runs the body on every data-source tick), so a row leaving
    // the data source or changing role is caught here. `null` when the
    // feature is off or no selectable row exists.
    // `selectionRequired` seeds the first selectable row and never goes null;
    // a `focusGroup` listbox starts unselected and commits on Space/Enter, so
    // its `data-selected` tracks the raw owned index. Both surface through the
    // same `data-selected` / `selected` cell-prop path below.
    const effectiveSelectedIndex = selectionRequired
      ? resolveSelectionIndex(selectedIndex, dataSource)
      : focusEngineActive
        ? selectedIndex
        : null;
    // Reconcile owned state to the resolved value and mirror genuine
    // changes out through `onSelectionChange`. `useLayoutEffect` keeps
    // the seed in the same paint as mount so the first frame already
    // shows a selected row. Converges in at most one extra render:
    // once `selectedIndex === effectiveSelectedIndex`, the `setState`
    // branch is skipped.
    React.useLayoutEffect(() => {
      if (!selectionRequired) return;
      if (effectiveSelectedIndex !== selectedIndex) {
        setSelectedIndex(effectiveSelectedIndex);
      }
      if (
        effectiveSelectedIndex !== null &&
        effectiveSelectedIndex !== lastReportedSelectionRef.current
      ) {
        lastReportedSelectionRef.current = effectiveSelectedIndex;
        onSelectionChangeRef.current?.(effectiveSelectedIndex);
      }
    }, [selectionRequired, effectiveSelectedIndex, selectedIndex]);

    // Force-rerender tick called from SmartScroll's `onScroll`
    // callback (re-window on user scroll), the `ResizeObserver` rAF
    // flush (re-window after height updates), and the post-mount
    // tick (so the second render reads a real `clientHeight`).
    // Triggers a reducer increment which forces React to re-execute
    // the component body and recompute the windowed slice.
    const [, scrollTick] = React.useReducer((x: number) => x + 1, 0);

    // [L04] settle-handshake release, shared by the two cell-observer
    // sites that can witness a batch settle: the normal post-measurement
    // path, and the zero-box early return (a hidden scroller). Armed
    // means a batch freeze is up and this batch's one-shot hasn't fired.
    // Firing clears the list-internal initial freeze, raises the
    // consumer's one-shot ready callback (which releases `batchLoading`
    // — and with it the card's save gate), and forces a commit so the
    // pin effect sees the freeze's falling edge and places the bottom
    // once (the settle itself may schedule no flush of its own).
    const releaseSettleIfArmed = React.useCallback((): void => {
      // A cold fill still placing rows is not settled: the deliveries
      // arriving now are per-chunk measurements, and releasing on one
      // would drop `batchLoading` with the ledger only partially
      // covered — sending the next commit through the eviction
      // coverage check straight into the full-range suspension, the
      // very commit the fill exists to avoid. The fill's final chunk
      // clears the cursor; the delivery that measures it releases here.
      if (coldFillFirstRef.current !== null) return;
      if (!isScrollBatteryFrozen() || firstSettleFiredRef.current) return;
      firstSettleFiredRef.current = true;
      initialSettlePendingRef.current = false;
      onFirstSettleRef.current?.();
      scrollTick();
    }, [isScrollBatteryFrozen]);

    // Selection/focus pin ([L23] under windowed mounting): rows whose
    // DOM holds the user's selection endpoints or keyboard focus must
    // not unmount when the visible window moves elsewhere. Tracked
    // imperatively (document `selectionchange` + container
    // `focusin`/`focusout` — direct DOM observation per [L22]) into a
    // ref; a change pokes `scrollTick` so the next window computation
    // reads the new pin. The window CLAMPS outward to cover the pin
    // (one contiguous range — see `computeWindow.pinnedRange`), so a
    // selection far from the viewport widens the window instead of
    // splitting it. Plain inline mode mounts everything and skips the
    // machinery entirely; `evictOffscreen` needs it back, because under
    // eviction an inline list can once again unmount the row the user
    // is selecting in or typing into.
    const pinnedRangeRef = React.useRef<{ first: number; last: number } | null>(
      null,
    );
    React.useLayoutEffect(() => {
      if (inline === true && !evictModeEnabled) return;
      const container = scrollContainerRef.current;
      if (container === null) return;

      const recomputePin = (): void => {
        let first = Infinity;
        let last = -Infinity;
        const addNode = (node: Node | null): void => {
          if (node === null) return;
          const el = node instanceof Element ? node : node.parentElement;
          if (el === null || !container.contains(el)) return;
          const cell = el.closest("[data-tug-list-cell-index]");
          if (cell === null) return;
          const idx = Number(cell.getAttribute("data-tug-list-cell-index"));
          if (!Number.isFinite(idx)) return;
          if (idx < first) first = idx;
          if (idx > last) last = idx;
        };
        const sel = document.getSelection();
        if (sel !== null && sel.rangeCount > 0 && !sel.isCollapsed) {
          addNode(sel.anchorNode);
          addNode(sel.focusNode);
        }
        addNode(document.activeElement);
        const next = first <= last ? { first, last } : null;
        const prev = pinnedRangeRef.current;
        const changed =
          (next === null) !== (prev === null) ||
          (next !== null &&
            prev !== null &&
            (next.first !== prev.first || next.last !== prev.last));
        if (changed) {
          pinnedRangeRef.current = next;
          scrollTick();
        }
      };

      document.addEventListener("selectionchange", recomputePin);
      container.addEventListener("focusin", recomputePin);
      container.addEventListener("focusout", recomputePin);
      return () => {
        document.removeEventListener("selectionchange", recomputePin);
        container.removeEventListener("focusin", recomputePin);
        container.removeEventListener("focusout", recomputePin);
        pinnedRangeRef.current = null;
      };
      // `scrollTick` is a stable reducer dispatch; the mode flags are
      // the only real dependencies.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inline, evictModeEnabled]);

    // Read scroll geometry from the live DOM at render time. On the
    // first render `scrollContainerRef.current` is null (the ref
    // attaches in the same commit), producing a degenerate window
    // until the post-mount tick. The mount-tick effect below pokes
    // `scrollTick` so the second render sees a real viewport height.
    const scrollEl = scrollContainerRef.current;
    const scrollTop = scrollEl?.scrollTop ?? 0;
    const viewportHeight = scrollEl?.clientHeight ?? 0;

    // Resolve the per-index height closure. Measured heights from
    // the `HeightIndex` win; unmeasured indices fall back to
    // `delegate.estimatedHeightForKind`. The composed accessor flows
    // through to `computeWindow`, the height-index lookup helpers,
    // and the imperative-handle `scrollToIndex` so every height read
    // sees the same fallback chain.
    const itemCount = dataSource.numberOfItems();

    // Seed the list-internal batch-freeze once: a list that mounts with
    // content is rendering a batch (cold-restore reveal), so freeze the
    // scroll battery until its first settle. A list that mounts empty (a
    // live session that grows turn-by-turn) never freezes here.
    if (initialSettlePendingRef.current === null) {
      initialSettlePendingRef.current = itemCount > 0;
      // Chunk the reveal (COLD_FILL_CHUNK) when the mounting batch is
      // big enough to be felt as a stall. Gated to eviction mode: the
      // fill borrows eviction's spacer geometry, and the mode's
      // absence is the test seam that asks for the monolithic mount.
      if (evictModeEnabled && itemCount > COLD_FILL_CHUNK) {
        coldFillFirstRef.current = itemCount - COLD_FILL_CHUNK;
      }
    }

    // Front-insert detection ([L23], inline transcript). The first row's
    // stable id changes only when rows are inserted ahead of it (a
    // prepend); an append leaves it unchanged. Capture pre-commit scroll
    // geometry NOW — the compensation layout effect runs after the new
    // rows are in the DOM, too late to read the old `scrollHeight`. The
    // ref-write-in-render is the function-component scroll-anchoring
    // escape hatch (a read of the live DOM + a ref stash, no React
    // state); the `pending === null` guard makes a StrictMode double
    // render capture once. Gated to `inline` (the transcript's mode);
    // the windowed path keeps its own spacer-based scroll machinery.
    const firstRowId =
      inline === true && itemCount > 0 ? dataSource.idForIndex(0) : null;
    if (inline === true && scrollEl !== null && pendingPrependRef.current === null) {
      const prepend = detectPrepend(
        prevFirstIdRef.current,
        prevPrependCountRef.current,
        firstRowId,
        itemCount,
      );
      if (prepend !== null) {
        pendingPrependRef.current = {
          added: prepend.added,
          oldScrollHeight: scrollEl.scrollHeight,
          oldScrollTop: scrollEl.scrollTop,
        };
      }
    }

    // The band a row takes. The delegate answers for a sectioned list, whose
    // sections each count from their own top; a flat list has nothing to say
    // and gets the row's index parity.
    const stripeParityForIndex = delegate?.stripeParityForIndex;
    const parityForIndex = React.useCallback(
      (index: number): TugListViewStripeParity =>
        stripeParityForIndex?.(index) ?? (index % 2 === 0 ? "even" : "odd"),
      [stripeParityForIndex],
    );

    const estimatedHeightForKind = delegate?.estimatedHeightForKind;
    const estimatedHeightForKindOnly = React.useCallback(
      (index: number): number => {
        const kind = dataSource.kindForIndex(index);
        return estimatedHeightForKind?.(kind) ?? DEFAULT_ESTIMATED_HEIGHT;
      },
      [dataSource, estimatedHeightForKind],
    );
    const heightForIndex = React.useCallback(
      (index: number): number => {
        const measured = heightIndexRef.current.get(index);
        if (measured !== undefined) return measured;
        return estimatedHeightForKindOnly(index);
      },
      [estimatedHeightForKindOnly],
    );

    /**
     * What the user is looking at right now, in the coordinates that
     * survive a relayout: which row sits at the viewport top, and how far
     * into it the top edge falls.
     *
     * Two callers, one derivation. The `data-tug-scroll-state` writer
     * serializes it for the cross-mount bag, and the resize-episode
     * handler feeds it straight back to `makeAnchorResolver` — the two
     * must agree about what "the anchor" means or a width change and a
     * reload would put the user in two different places.
     *
     * Returns `null` when there is nothing to anchor to: an empty source,
     * or a hidden scroller (`display: none` reads `scrollTop` as 0, which
     * is the absence of a position rather than a position).
     */
    const deriveLiveAnchor = React.useCallback((): {
      index: number;
      offset: number;
      /** The same top edge measured from the ANCHOR ROW rather than from the turn it belongs to. */
      rowOffset: number;
      turnDepth: number | undefined;
      rowDepth: number | undefined;
    } | null => {
      const el = scrollContainerRef.current;
      if (el === null || el.clientHeight === 0) return null;
      const total = dataSource.numberOfItems();
      if (total <= 0) return null;
      const scrollTop = el.scrollTop;
      // Convert to the row coordinate space (origin = row 0's top) by
      // discounting any leading content above row 0.
      const leadingTop = leadingOffsetPx();
      const rowSpaceScrollTop = Math.max(0, scrollTop - leadingTop);
      const anchorIndex = heightIndexRef.current.indexForOffset(
        rowSpaceScrollTop,
        total,
        estimatedHeightForKindOnly,
      );
      // Anchor depth, invariant across a reload because the loaded window is
      // always bottom-contiguous. A turn-windowed source (the transcript)
      // reports a **turn** depth ([P06]): one quantity sizes the resume
      // window and re-finds the anchored turn, with no row↔turn unit to
      // bridge. A non-turn source reports a row depth. Either is robust where
      // the raw `index` is not: a save with older content paged in (a deep
      // window) reloads against the default window, which `index` would
      // over-run.
      const turnDepth = dataSource.turnDepthFromEnd?.(anchorIndex);
      // Offset basis: for the turn path, the anchored turn's first row, so the
      // persisted pixel offset is measured within the anchored turn and the
      // restore relocates to the same row via the same resolver. Otherwise the
      // anchor row itself.
      let basisRow = anchorIndex;
      if (typeof turnDepth === "number") {
        const tr = dataSource.rowIndexForTurnDepthFromEnd?.(turnDepth);
        if (typeof tr === "number") basisRow = tr;
      }
      const basisTop =
        heightIndexRef.current.offsetForIndex(
          basisRow,
          estimatedHeightForKindOnly,
        ) + leadingTop;
      const rowTop =
        heightIndexRef.current.offsetForIndex(
          anchorIndex,
          estimatedHeightForKindOnly,
        ) + leadingTop;
      return {
        index: anchorIndex,
        offset: Math.max(0, scrollTop - basisTop),
        rowOffset: Math.max(0, scrollTop - rowTop),
        turnDepth: typeof turnDepth === "number" ? turnDepth : undefined,
        rowDepth:
          typeof turnDepth === "number"
            ? undefined
            : anchorDepthFromEnd(total, anchorIndex),
      };
    }, [dataSource, estimatedHeightForKindOnly, leadingOffsetPx]);

    // Windowing decision: when the consumer opts into `inline`,
    // render every cell — no spacers, no overscan math. This collapses
    // the class of "first-time-measured cell shifts scrollHeight"
    // bugs because every cell is observed from mount, so `heightIndex`
    // is fully populated before the user can scroll and never reverts
    // to estimates. Otherwise the windowed path runs as before.
    const fullRangeResult = {
      firstIndex: 0,
      lastIndex: itemCount,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
      // `totalHeight` is only consumed by `scrollToIndex`'s
      // estimated-jump path, which is itself a no-op when every
      // cell is rendered (the imperative handle's
      // `scrollToElement` branch fires instead). Reporting 0 here
      // is harmless.
      totalHeight: 0,
    };

    // Eviction ([L24]: the window slice is derived structure, not
    // state). Inline mode's full mount is what MEASURES every row;
    // eviction mode then keeps only the rows near the scrollport,
    // standing the exact measured heights of the rest in the spacers.
    //
    // The activation predicate is the whole safety argument: the
    // spacers sum the heights of rows that are NOT in the DOM, so a
    // single unmeasured row out there would put an estimate into the
    // scroll geometry — the precise failure `inline` was introduced to
    // eliminate. `coversRange` asks whether that can happen; when the
    // answer is "maybe", this commit renders everything (the plain
    // inline output) and the suspension is counted.
    //
    // A batch load is not a suspension: it is the loading state, during
    // which the rows are being placed and measured in the first place.
    let windowResult = fullRangeResult;
    let evictingThisCommit = false;
    let evictSuspendedThisCommit = false;
    if (inline === true && coldFillFirstRef.current !== null) {
      // Cold fill in flight: render the tail `[first..itemCount)` and
      // stand the estimate-summed spacer over the rows above. The
      // mounted range only grows (chunks already placed stay mounted
      // and measured), so by the commit after the cursor clears this
      // is the full range with every height real — the same end state
      // the monolithic mount produced, reached across yielding tasks.
      const first = Math.min(coldFillFirstRef.current, itemCount);
      let topSpacerHeight = 0;
      for (let i = 0; i < first; i += 1) {
        topSpacerHeight += Math.max(0, heightForIndex(i));
      }
      windowResult = {
        firstIndex: first,
        lastIndex: itemCount,
        topSpacerHeight,
        bottomSpacerHeight: 0,
        totalHeight: 0,
      };
      evictingThisCommit = true;
    } else if (inline !== true) {
      windowResult = computeWindow({
        itemCount,
        scrollTop,
        viewportHeight,
        overscanCount: OVERSCAN_COUNT,
        estimatedHeightForIndex: heightForIndex,
        pinnedRange: pinnedRangeRef.current,
      });
    } else if (
      evictModeEnabled &&
      !batchLoading &&
      itemCount > 0 &&
      viewportHeight > 0
    ) {
      const candidate = computeWindow({
        itemCount,
        scrollTop,
        viewportHeight,
        overscanCount: OVERSCAN_COUNT,
        estimatedHeightForIndex: heightForIndex,
        pinnedRange: pinnedRangeRef.current,
        mountMarginPx: viewportHeight * EVICT_MOUNT_MARGIN_VIEWPORTS,
        retainMarginPx: viewportHeight * EVICT_RETAIN_MARGIN_VIEWPORTS,
        prevRange: prevWindowRangeRef.current,
      });
      const ledger = heightIndexRef.current;
      if (
        ledger.coversRange(0, candidate.firstIndex) &&
        ledger.coversRange(candidate.lastIndex, itemCount)
      ) {
        windowResult = candidate;
        evictingThisCommit = true;
      } else {
        // Surgical widening before wholesale suspension. The common way
        // coverage fails in steady state is a row APPENDED outside the
        // window — a streaming turn landing while the user reads older
        // content. Suspending for that mounts the entire transcript for
        // one commit, per appended row: a mass mount/unmount cycle that
        // the user feels as a hitch mid-scroll. Instead, widen the
        // window just far enough to mount every unmeasured row (they
        // measure this commit; the next window releases them), keeping
        // the spacers over measured rows only — the no-estimates
        // invariant holds by construction. Only when widening degenerates
        // to the full range (a cold or wiped ledger) is the commit a
        // true suspension, and counted as one.
        let widenedFirst = candidate.firstIndex;
        for (let i = 0; i < widenedFirst; i += 1) {
          if (!ledger.has(i)) {
            widenedFirst = i;
            break;
          }
        }
        let widenedLast = candidate.lastIndex;
        for (let i = itemCount - 1; i >= widenedLast; i -= 1) {
          if (!ledger.has(i)) {
            widenedLast = i + 1;
            break;
          }
        }
        if (widenedFirst === 0 && widenedLast === itemCount) {
          evictSuspendedThisCommit = true;
        } else {
          let topSpacerHeight = 0;
          for (let i = 0; i < widenedFirst; i += 1) {
            topSpacerHeight += Math.max(0, heightForIndex(i));
          }
          let bottomSpacerHeight = 0;
          for (let i = widenedLast; i < itemCount; i += 1) {
            bottomSpacerHeight += Math.max(0, heightForIndex(i));
          }
          windowResult = {
            firstIndex: widenedFirst,
            lastIndex: widenedLast,
            topSpacerHeight,
            bottomSpacerHeight,
            totalHeight: candidate.totalHeight,
          };
          evictingThisCommit = true;
        }
      }
    } else if (
      evictModeEnabled &&
      !batchLoading &&
      itemCount > 0 &&
      prevWindowRangeRef.current !== null
    ) {
      // Hidden scroller (`display: none` — an inactive card tab), or a
      // zero-height allotment: `viewportHeight` is 0, so there is no
      // geometry to window against. Falling through to the full-range
      // result here would re-mount the entire transcript on every commit
      // a background streaming session produces — the exact DOM weight
      // eviction exists to shed. Hold the previously committed range
      // instead; the spacers keep their ledger-derived heights (nothing
      // lays out while hidden, so the values are inert), and the
      // scroll-container ResizeObserver's tick re-windows against real
      // geometry the moment the card is shown again. Rows appended while
      // hidden accumulate outside the held range unmeasured; the reveal
      // commit's coverage check then suspends once, measures them, and
      // re-arms — the suspension path doing its job.
      const prev = prevWindowRangeRef.current;
      const heldFirst = Math.max(0, Math.min(prev.first, itemCount));
      const heldLast = Math.max(heldFirst, Math.min(prev.last, itemCount));
      if (heldLast > heldFirst) {
        let topSpacerHeight = 0;
        for (let i = 0; i < heldFirst; i += 1) {
          topSpacerHeight += Math.max(0, heightForIndex(i));
        }
        let bottomSpacerHeight = 0;
        for (let i = heldLast; i < itemCount; i += 1) {
          bottomSpacerHeight += Math.max(0, heightForIndex(i));
        }
        windowResult = {
          firstIndex: heldFirst,
          lastIndex: heldLast,
          topSpacerHeight,
          bottomSpacerHeight,
          totalHeight: 0,
        };
        evictingThisCommit = true;
      }
    }

    // Mount-tick: after the first commit attaches the scroll-container
    // ref, force a rerender so the window math reads a real
    // `clientHeight`. Without this, `viewportHeight` stays 0 until
    // some other event (scroll, data source tick) triggers a render.
    //
    // Also seeds the initial pin request when `followBottom === true`
    // so a freshly-mounted list view with items already in the data
    // source pins to the bottom on first paint without waiting for a
    // ResizeObserver fire (which is critical for tests, where
    // `ResizeObserver` is a no-op stub, and useful in production where
    // it tightens the cold-mount paint to a single committed pin).
    React.useLayoutEffect(() => {
      if (followBottomEffective) {
        pinRequestedRef.current = true;
      }
      // Resolve the row gap once the window element exists — every ledger
      // entry is measured against it.
      syncRowGap();
      scrollTick();
      // `followBottom` is read once at mount; runtime changes are not
      // tracked (matches the SmartScroll-install effect's pattern).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Front-insert scroll-hold ([L23], [L06], [L22]). Runs after every
    // commit; updates the prepend trackers and, when render captured a
    // pending prepend, applies the compensation now that the older rows
    // are in the DOM:
    //   1. shift the height index by the inserted count so each existing
    //      row keeps its measured height at its new index ([L22]);
    //   2. hold the viewport by the real `scrollHeight` delta so the
    //      content the user was reading stays under the same Y — a DOM
    //      `scrollTop` write, not React state ([L06]).
    // `scrollTick` re-windows against the shifted heights. Dormant on an
    // append (no pending capture), so steady-state growth is untouched.
    React.useLayoutEffect(() => {
      const pending = pendingPrependRef.current;
      prevFirstIdRef.current = firstRowId;
      prevPrependCountRef.current = itemCount;
      if (pending === null) return;
      pendingPrependRef.current = null;
      const el = scrollContainerRef.current;
      if (el === null) return;
      heightIndexRef.current.shift(pending.added);
      // The conservation probe's live-extent map is keyed by index and
      // just went stale by `added`. Clearing skips one commit's
      // comparison rather than diffing rows against the wrong indices.
      liveExtentsRef.current.clear();
      el.scrollTop = prependScrollAdjustment(
        pending.oldScrollHeight,
        el.scrollHeight,
        pending.oldScrollTop,
      );
      // Declare the direct write. This bypasses SmartScroll, so
      // without this the displacement bracket below — which runs later
      // in the same commit — would find the scroller somewhere its
      // baseline does not explain and read a legitimate compensation
      // as a clamp.
      smartScrollRef.current?.noteExternalWrite();
      scrollTick();
    });

    // Install the `ResizeObserver` once per list-view instance.
    // Created in `useLayoutEffect` ([L03]) so the constructor runs
    // synchronously after commit, and any cell ref callback that
    // fires during the same commit sees `observerRef.current`
    // populated and observes itself.
    //
    // Re-runs when `dataSource` identity changes (rare). On a genuine
    // SWAP the height index is cleared first — the old source's
    // per-index measurements are invalid for the new source (a cell
    // at index 5 in the new source would otherwise inherit the old
    // index-5 measurement until `ResizeObserver` reported the real
    // height).
    //
    // The clear is gated on an ACTUAL dataSource change, NOT on every
    // effect run. Clearing on a mere effect re-run would drop the
    // measured geometry the live `HeightIndex` accumulated for the
    // current source. Gating on `prev !== dataSource` (rather than a
    // run-counter) is also correct under React StrictMode's
    // mount/unmount/mount double-invoke — the second invoke sees an
    // unchanged dataSource and skips the clear.
    // True while a width change awaits its settle-debounced
    // invalidation (the width observer below). While up, the cell
    // ResizeObserver writes nothing — no ledger entries, no
    // `contain-intrinsic-size` stamps. Without the freeze the pending
    // window is stale and *drifting*: mounted rows re-measure at the
    // new width while unmounted rows keep old-width entries, so the
    // spacer sums — and `scrollHeight` — move continuously under the
    // user for the whole drag. Frozen, the geometry is uniformly
    // old-width and motionless until the settle wipe re-measures
    // everything; nothing is lost, because that wipe discards those
    // writes anyway.
    const widthSettlePendingRef = React.useRef(false);

    React.useLayoutEffect(() => {
      if (
        prevDataSourceForClearRef.current !== null &&
        prevDataSourceForClearRef.current !== dataSource
      ) {
        heightIndexRef.current.clear();
        liveExtentsRef.current.clear();
      }
      prevDataSourceForClearRef.current = dataSource;
      const observer = new ResizeObserver((entries) => {
        // A scroller with no rendered box — `display: none`, the state
        // every inactive card tab sits in — reports EVERY observed cell
        // at 0×0. Writing those zeros into the ledger poisons eviction's
        // spacer geometry: spacer sums collapse by the true height of
        // every "measured-at-zero" row, `scrollHeight` lies, and the
        // scroll position snaps and judders until each poisoned row
        // happens to remount and re-measure. No measurement taken while
        // the scroller has no box is meaningful, so skip the delivery
        // wholesale; re-showing the card resizes every cell 0 → real,
        // which re-fires this observer with honest values.
        const scroller = scrollContainerRef.current;
        if (scroller === null || scroller.offsetWidth === 0) {
          // Hidden settle release. The freeze exists to protect the
          // scroll battery's forced layouts during a batch settle — but
          // a scroller with no box has no layouts to protect, and
          // without a release here a restore that completes behind a
          // hidden tab would hold `batchLoading` (and the card's save
          // gate) up until the tab is next shown. These zero-box
          // deliveries ARE the batch's settle as far as a hidden card
          // can have one, so release the handshake and let the consumer
          // stand down. Nothing is measured from this delivery — the
          // zeros stay out of the ledger — and reveal follows the held-
          // range path below: the 0→real resize refires this observer
          // with honest values, the reveal commit's coverage check
          // suspends once over rows left unmeasured, measures them, and
          // re-arms.
          releaseSettleIfArmed();
          return;
        }
        // Width-settle freeze: a width change is mid-debounce, so
        // these deliveries are new-width measurements the settle wipe
        // will discard — writing them now would mix widths in the
        // ledger and drift the spacer sums under the user. Skip the
        // delivery wholesale, same shape as the zero-box guard above.
        if (widthSettlePendingRef.current) return;
        // Fold any row-gap change into the ledger before this burst's
        // entries are written against it; a fold also re-windows below.
        const gapChanged = syncRowGap();
        const total = dataSource.numberOfItems();
        let anyChanged = gapChanged;
        const heightIndex = heightIndexRef.current;
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          const indexAttr = target.getAttribute("data-tug-list-cell-index");
          if (indexAttr === null) continue;
          const index = Number.parseInt(indexAttr, 10);
          if (Number.isNaN(index) || index < 0 || index >= total) {
            // Stale entry — the cell unmounted or the data source
            // shrank below this index between observation and
            // callback. Drop quietly; the height index doesn't carry
            // entries for indices that don't exist.
            continue;
          }
          const newHeight = entry.contentRect.height;
          // Ledger entries are outer extents (height + row gap); the cv
          // stamp below is the raw measured height.
          const newOuterHeight = newHeight + (rowGapPxRef.current ?? 0);
          const currentHeight = heightIndex.get(index);
          const heightChanged =
            currentHeight === undefined ||
            Math.abs(currentHeight - newOuterHeight) >= 0.5;

          // Offscreen-skip stamping: the exact measured height just
          // delivered becomes the cell's `contain-intrinsic-size`, and
          // the `data-cv-ready` mark lets the CSS apply
          // `content-visibility: auto`. Stamped only from a REAL
          // measurement — never an estimate — so a skipped cell
          // occupies precisely its last rendered pixels. Style writes
          // here don't change the cell's current layout size (the
          // intrinsic size only applies while skipped), so this cannot
          // re-trigger the observer.
          //
          // Stamping runs BEFORE the no-op height gate below: after a
          // width invalidation strips every stamp, cells whose height
          // is unchanged at the new width (short one-line rows) still
          // fire this observer and must re-earn their stamp, or they'd
          // silently drop out of offscreen-skip forever.
          if (
            offscreenSkipRef.current &&
            (heightChanged || !target.hasAttribute("data-cv-ready"))
          ) {
            target.style.setProperty(
              "contain-intrinsic-size",
              `auto ${newHeight}px`,
            );
            if (!target.hasAttribute("data-cv-ready")) {
              target.setAttribute("data-cv-ready", "");
            }
          }

          // Skip no-op updates — sub-pixel ResizeObserver noise
          // shouldn't force a re-window.
          if (!heightChanged) {
            continue;
          }
          heightIndex.set(index, newOuterHeight);
          anyChanged = true;
        }
        if (anyChanged) {
          // **Synchronous bottom-pin.** The `ResizeObserver` callback
          // fires after layout but BEFORE the browser's next paint
          // (it is part of the same animation frame's "deliver
          // resize-observer notifications" step). Pinning here lands
          // in the SAME paint that shows the new cell heights, so the
          // user never sees the bottom region drift upward as
          // `scrollHeight` grows.
          //
          // Without this write, the rAF deferral below scheduled
          // the pin one or two frames later — long enough for the
          // browser to paint with the stale `scrollTop` (cells at
          // new heights, scrollbar at old position → bottom region
          // visibly slides out of view), then paint again with the
          // pin applied (scrollbar snaps back). That drift-and-snap
          // was the "flashing" of the bottom region.
          //
          // `maybePinToBottom` owns the follow-bottom + not-user-
          // scrolling gate and is idempotent, so a call that passes
          // the gate but finds scrollTop already at the bottom is a
          // cheap no-op.
          //
          // Frozen during a batch load + settle: the batch settles many
          // cells at once, so pinning per ResizeObserver delivery would
          // force a full-transcript layout repeatedly. Placement lands
          // once on the freeze's falling edge (the pin effect below).
          if (!isScrollBatteryFrozen()) {
            smartScrollRef.current?.maybePinToBottom();
          }

          // Still schedule the rAF flush so the list-view re-windows
          // against the updated height index. The post-commit pin
          // re-asserts the bottom on commit; the synchronous write
          // above already eliminated the visible drift — the
          // post-commit pin is the canonical pin write (and a no-op
          // on the steady-state case where the sync write already
          // landed scrollTop at the bottom).
          if (pendingFlushRef.current === null) {
            pendingFlushRef.current = requestAnimationFrame(() => {
              pendingFlushRef.current = null;
              // A measured cell height changed → request a pin so
              // the post-commit pin effect re-asserts the bottom on
              // the next commit. Without this, the signal-gated pin
              // effect would bail out (no request) and a streaming
              // cell that grew its content would leave the user
              // above the bottom.
              pinRequestedRef.current = true;
              scrollTick();
            });
          }
        }

        // [L04] settle handshake. This ResizeObserver delivery means the
        // batch's cells have been measured — the post-load layout has
        // settled. Release the freeze so the consumer that raised
        // `batchLoading` can stand down; the pin + anchor-writer then
        // resume and place the bottom / serialize the anchor once.
        // One-shot per batch (re-armed on each rising edge); only while
        // a batch is actually frozen, so live streaming never fires it.
        releaseSettleIfArmed();
      });
      observerRef.current = observer;
      // Observe any cells already in the cellElementMap (mounted
      // before the observer was created on this same commit). React
      // ref callbacks ran during commit, populating the map; this
      // effect runs after them, so we sweep up to ensure observation.
      for (const el of cellElementMapRef.current.values()) {
        observer.observe(el);
      }
      return () => {
        if (pendingFlushRef.current !== null) {
          cancelAnimationFrame(pendingFlushRef.current);
          pendingFlushRef.current = null;
        }
        observer.disconnect();
        observerRef.current = null;
      };
      // dataSource is referenced inside the callback for itemCount
      // bounds — re-running the effect on dataSource identity change
      // installs a fresh observer that sees the new bound. This is
      // rare (dataSource is usually stable for a card's lifetime).
    }, [dataSource, releaseSettleIfArmed]);

    // Offscreen-skip width invalidation: a remembered
    // `contain-intrinsic-size` is exact only for the width it was
    // measured at — text reflows when the container narrows or widens.
    // On a real width change every cell drops its stamp (falling back
    // to full rendering, one heavyweight relayout on a rare user
    // gesture), re-measures through the cell ResizeObserver above, and
    // re-arms with fresh exact heights. Height-only changes (content
    // growth, other cards resizing the deck vertically) don't touch
    // the stamps.
    //
    // Under `evictOffscreen` the same width change invalidates the
    // measured-height ledger, for the same reason and with more at
    // stake: those heights are standing in for rows that are not in the
    // DOM, so a stale one is a wrong scroll position rather than a
    // wrong skip size. Clearing the ledger makes the coverage predicate
    // fail on the next commit, which renders every row (plain inline),
    // re-measures at the new width, and re-arms eviction once the
    // ledger is whole again — the suspension path doing exactly the job
    // it exists for. A page-zoom or font-scale change reaches here the
    // same way, since both change the scroller's effective width.
    //
    // The reader's place is held across all of that by the resize
    // episode's restore target (`onPreserveBegin`), which is a resolver
    // rather than a pixel for exactly this reason: it re-reads the height
    // index every heartbeat, so it waits while the wipe leaves rows
    // unresolvable and then tracks the anchor row as fresh measurements
    // land. The two are halves of one gesture — this effect makes the
    // geometry right, that one keeps the user where they were while it
    // happens.
    React.useLayoutEffect(() => {
      if (!(inline === true && (offscreenSkip || evictModeEnabled))) return;
      const scroller = scrollContainerRef.current;
      if (scroller === null) return;
      let lastWidth = scroller.clientWidth;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;
      // The invalidation body runs once, at settle — not per observer
      // fire. During the pending window the cell observer is frozen
      // (see `widthSettlePendingRef`), so the ledger holds uniformly
      // old-width geometry throughout a drag, coverage stays true,
      // eviction keeps running, and the one wipe here restores
      // exactness: coverage fails on the next commit, every row
      // renders, re-measures at the settled width, and eviction
      // re-arms — one suspension per resize gesture instead of one
      // per tick.
      const runInvalidation = (): void => {
        settleTimer = null;
        widthSettlePendingRef.current = false;
        const width = scroller.clientWidth;
        // Hidden mid-settle (`display: none` landed during the
        // debounce): no meaningful layout to wipe against, and
        // `lastWidth` must survive so a re-show at the old width
        // stays a no-op. The re-show at a *changed* width
        // re-qualifies against the old baseline below.
        if (width === 0) return;
        lastWidth = width;
        // A width change can carry a layout/density change with it; re-read
        // the gap before the re-measure repopulates the ledger against it.
        syncRowGap();
        if (offscreenSkip) {
          for (const el of cellElementMapRef.current.values()) {
            el.removeAttribute("data-cv-ready");
            el.style.removeProperty("contain-intrinsic-size");
          }
        }
        if (evictModeEnabled) {
          heightIndexRef.current.clear();
          liveExtentsRef.current.clear();
          scrollTick();
        }
      };
      const widthObserver = new ResizeObserver(() => {
        const width = scroller.clientWidth;
        // Width 0 is a hidden scroller (`display: none` — an inactive
        // card tab), not a width change. Skip WITHOUT updating
        // `lastWidth`: re-showing the card at its old width is then a
        // no-op and the measured ledger survives the tab switch intact.
        // A pane resized while the card was hidden re-shows at a width
        // that differs from `lastWidth`, which invalidates below as a
        // real width change should.
        if (width === 0) return;
        // The mirror case: a list that MOUNTED hidden baselines at 0.
        // Its first box is a reveal, not a resize — every ledger entry
        // that exists was measured at this width (the zero-box guard
        // kept boxless deliveries out), so adopt the baseline silently.
        // Invalidating here would wipe heights the reveal burst just
        // measured, and with no cell box changing afterwards nothing
        // would re-measure them: coverage would fail on every commit
        // and eviction could never arm.
        if (lastWidth === 0) {
          lastWidth = width;
          return;
        }
        // Compared against the settled baseline, not the previous
        // fire — intermediate widths keep restarting the timer until
        // the gesture rests.
        if (Math.abs(width - lastWidth) < 0.5) return;
        widthSettlePendingRef.current = true;
        if (settleTimer !== null) clearTimeout(settleTimer);
        settleTimer = setTimeout(
          runInvalidation,
          WIDTH_INVALIDATION_SETTLE_MS,
        );
      });
      widthObserver.observe(scroller);
      return () => {
        widthObserver.disconnect();
        if (settleTimer !== null) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }
        widthSettlePendingRef.current = false;
      };
      // `scrollTick` is a stable reducer dispatch.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inline, offscreenSkip, evictModeEnabled]);

    // Row-gap watch. The ledger folds the flex row-gap into every entry,
    // and the gap can change without any cell resizing — the session
    // card's per-card response settings land as an inline custom
    // property after mount, a density or theme change can move it any
    // time. No cell ResizeObserver fires for that (cell boxes are
    // unchanged), but the WINDOW element's height moves by n·delta, so
    // observing it catches the change; `syncRowGap` rebases the ledger
    // by the delta and the tick re-windows the spacers against it.
    React.useLayoutEffect(() => {
      const winEl = listWindowElRef.current;
      if (winEl === null) return;
      const gapObserver = new ResizeObserver(() => {
        // Hidden (display:none tab): no meaningful layout to sync against.
        if (winEl.offsetWidth === 0) return;
        if (syncRowGap()) scrollTick();
      });
      gapObserver.observe(winEl);
      return () => gapObserver.disconnect();
      // `syncRowGap` and `scrollTick` are stable.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Instantiate `SmartScroll` against the scroll container ([D07]).
    // SmartScroll owns every programmatic scroll-position write the
    // list view ever issues, attaches the scroll/pointer/wheel/key
    // listeners that drive auto-follow-bottom intent, and exposes
    // `isFollowingBottom` for the growth-pin gates below. Created in
    // `useLayoutEffect` ([L03]) so the listeners are in place before
    // paint; disposed on unmount.
    //
    // The `onScroll` callback drives the same `scrollTick` reducer
    // the previous direct scroll listener did — re-windowing on each
    // scroll event. Step 4's rAF-coalescing rides on the
    // `ResizeObserver` flush; SmartScroll's own internal coalescing
    // (phase machine + scrollend handling) takes care of the
    // gesture-state tracking.
    React.useLayoutEffect(() => {
      const el = scrollContainerRef.current;
      if (el === null) return;
      const smartScroll = new SmartScroll({
        scrollContainer: el,
        followBottom: followBottomEffective,
        callbacks: {
          onScroll: () => {
            scrollTick();
            // Top-edge transition for the "load previous" affordance.
            // `scrollTop <= AT_TOP_EPSILON` is "at the top"; fire only on
            // a change so the consumer's DOM toggle isn't churned each
            // frame ([L06] — the consumer drives a data-attribute).
            const atTop = el.scrollTop <= AT_TOP_EPSILON;
            if (atTop !== prevAtTopRef.current) {
              prevAtTopRef.current = atTop;
              onAtTopChangeRef.current?.(atTop);
            }
          },
          onFollowBottomChanged: (_ss, following) => {
            onFollowBottomChangeRef.current?.(following);
          },
        },
      });
      smartScrollRef.current = smartScroll;
      // Surface the initial follow-bottom intent: `onFollowBottomChanged`
      // fires only on transitions, so a consumer's observer would
      // otherwise miss the mount-time state.
      onFollowBottomChangeRef.current?.(smartScroll.isFollowingBottom);
      // Same for the top edge — seed from the live scrollTop so a list
      // that mounts already at the top reports it. Deferred to the next
      // frame: reading `scrollTop` here (in the mount layout effect) forces
      // a synchronous reflow of the just-built container before paint; on a
      // cold transcript load that single read dominated load time. Post-paint
      // the layout is already settled, so the read is free. A list rarely
      // mounts at the very top (it restores to bottom/anchor), so a one-frame
      // delay before the top-edge affordance settles is imperceptible.
      let atTopSeedRaf: number | null = requestAnimationFrame(() => {
        atTopSeedRaf = null;
        const atTop0 = el.scrollTop <= AT_TOP_EPSILON;
        prevAtTopRef.current = atTop0;
        onAtTopChangeRef.current?.(atTop0);
      });

      // Cold-boot scroll restore is owned by `SmartScroll` (its
      // `setRestoreTarget` / `applyRestoreTarget` API). The list
      // view's only jobs are: (1) install the saved anchor as a
      // restore target — here for the mount-time seed and in the
      // `tug-region-scroll-set` listener for CardHost's retry
      // dispatches; (2) forward a layout heartbeat via the
      // `applyRestoreTarget` effect below. SmartScroll holds the
      // restore state and the supersede rules (engage / user
      // gesture clear it) — the list view holds none.
      //
      // `makeAnchorResolver` builds the resolver for a saved
      // `{index, offset}` anchor. It reads the LIVE `heightIndex`
      // each call, so as virtualized cells settle their measured
      // heights the resolved `scrollTop` tracks the anchor cell's
      // true position [L07] / [L23]. It returns `null` while the
      // anchor cell is outside the data source (content not yet
      // populated) — `applyRestoreTarget` waits for a later commit.
      const makeAnchorResolver =
        (
          anchorIndex: number,
          anchorOffset: number,
          turnDepth: number | undefined,
          rowDepth: number | undefined,
        ): (() => number | null) =>
        () => {
          const total = dataSource.numberOfItems();
          if (total <= 0) return null;
          // Faithful restore ([recency P05], #step-6/#step-13). Relocate the
          // anchor against the freshly-loaded window, preferring the
          // canonical **turn** path: a turn-windowed source re-finds the
          // anchored turn's first row by depth ([P06]); when the turn is not
          // yet paged in it returns null and we wait for a later commit. A
          // non-turn source uses a row depth (`total - rowDepth`); legacy
          // bags with neither fall back to the raw saved index.
          let rowIndex: number;
          if (
            turnDepth !== undefined &&
            dataSource.rowIndexForTurnDepthFromEnd !== undefined
          ) {
            const r = dataSource.rowIndexForTurnDepthFromEnd(turnDepth);
            if (r === null) return null;
            rowIndex = r;
          } else if (rowDepth !== undefined) {
            if (total < rowDepth) return null;
            rowIndex = anchorRowIndexInWindow(total, rowDepth);
          } else {
            if (anchorIndex < 0 || anchorIndex >= total) return null;
            rowIndex = anchorIndex;
          }
          // Row offsets are relative to row 0's top; leading content
          // sits above it, so its height is part of the target.
          const cellTop =
            heightIndexRef.current.offsetForIndex(
              rowIndex,
              estimatedHeightForKindOnly,
            ) + leadingOffsetPx();
          return Math.max(0, cellTop + anchorOffset);
        };

      // Parse a `meta.anchor` payload to an `{index, offset}` pair,
      // or `null` when absent / malformed.
      const parseAnchor = (
        meta: unknown,
      ): {
        index: number;
        offset: number;
        turnDepth: number | undefined;
        rowDepth: number | undefined;
      } | null => {
        if (meta === null || typeof meta !== "object" || !("anchor" in meta)) {
          return null;
        }
        const a = (meta as { anchor: unknown }).anchor;
        if (
          a === null ||
          typeof a !== "object" ||
          !("index" in a) ||
          !("offset" in a)
        ) {
          return null;
        }
        const ax = a as {
          index: unknown;
          offset: unknown;
          turnDepthFromEnd?: unknown;
          depthFromEnd?: unknown;
        };
        if (typeof ax.index !== "number" || typeof ax.offset !== "number") {
          return null;
        }
        // A turn-windowed source persists `turnDepthFromEnd` ([P06]); a
        // non-turn source persists a row `depthFromEnd`. Either rides newer
        // bags; older/legacy bags carry neither → both undefined → resolver
        // falls back to the raw index.
        const turnDepth =
          typeof ax.turnDepthFromEnd === "number"
            ? ax.turnDepthFromEnd
            : undefined;
        const rowDepth =
          typeof ax.depthFromEnd === "number" ? ax.depthFromEnd : undefined;
        return { index: ax.index, offset: ax.offset, turnDepth, rowDepth };
      };

      // `meta.atBottom` — true when the list was following the bottom
      // at save time. Such a list restores by re-engaging follow-bottom
      // and pinning (exact: `scrollHeight - clientHeight`), NOT by an
      // `{index, offset}` anchor. The anchor path disengages
      // follow-bottom on restore, which leaves the jump-to-bottom
      // affordance showing over a list that is in fact at the bottom,
      // and resolves a near-bottom offset that can land short of the
      // true bottom against not-yet-measured cell heights. Absent on
      // pre-`atBottom` bags → falls back to the anchor path.
      const parseAtBottom = (meta: unknown): boolean =>
        meta !== null &&
        typeof meta === "object" &&
        (meta as { atBottom?: unknown }).atBottom === true;

      // Mount-time seed. The geometry hydration effect ran earlier
      // this commit, so `heightIndex` is already populated; the
      // restore-target heartbeat effect (below) applies the target
      // before paint, so the first paint reflects the saved anchor.
      //
      // A list saved at the bottom installs no anchor target: an
      // anchor resolver disengages follow-bottom (leaving the
      // jump-to-bottom affordance showing over a list that is at the
      // bottom) and resolves a near-bottom offset that can land short
      // of the true bottom. Such a list is constructed following the
      // bottom, so the mount pin lands it exactly; `onRegionScrollSet`
      // re-pins on the cold-boot restore beat.
      const seedAnchor = parseAtBottom(savedRegionScroll?.meta)
        ? null
        : parseAnchor(savedRegionScroll?.meta);
      if (seedAnchor !== null) {
        smartScroll.setRestoreTarget(
          makeAnchorResolver(
            seedAnchor.index,
            seedAnchor.offset,
            seedAnchor.turnDepth,
            seedAnchor.rowDepth,
          ),
        );
      }

      // Listen for `tug-region-scroll-set` — dispatched by CardHost's
      // `applyRegionScrolls` during cold-boot region-scroll restore
      // (Maker > Reload, cross-pane mount, HMR reload), AND
      // re-dispatched by CardHost's `MutationObserver`-driven retry
      // loop on every cardRoot subtree mutation until `el.scrollTop`
      // is within tolerance of `pos.y`.
      //
      //  - **Anchor case** (`meta.anchor` present): install the
      //    anchor as a `SmartScroll` restore target. SmartScroll
      //    re-applies it on every `applyRestoreTarget` heartbeat
      //    (the effect below) until the user gestures or
      //    follow-bottom engages — robust to cell-height drift as
      //    sub-content settles. CardHost's retry loop terminates on
      //    its own settle gate (`Math.abs(scrollTop - pos.y) <=
      //    tolerance`) once the resolved offset converges.
      //  - **Raw case** (no `meta.anchor`): write `pos.y` directly.
      //    Mirrors `tug-markdown-view`'s listener.
      //  - **At-bottom case** (`meta.atBottom`): re-engage follow-bottom
      //    and pin — exact (`scrollHeight - clientHeight`), and it
      //    keeps follow-bottom engaged so the jump-to-bottom affordance
      //    stays hidden. Wins over the anchor / raw cases, and must run
      //    before `disengageFollowBottom`.
      //
      // `preventDefault()` signals the dispatcher that we owned the
      // apply — `applyRegionScrolls` skips its fallback direct
      // `scrollTop` assignment. `disengageFollowBottom` defends the
      // raw-pixel branch against an intervening post-commit pin; the
      // anchor branch's `setRestoreTarget` disengages on its own.
      const onRegionScrollSet = (event: Event): void => {
        const ce = event as CustomEvent<{
          top?: number;
          left?: number;
          meta?: unknown;
        }>;
        event.preventDefault();

        if (parseAtBottom(ce.detail.meta)) {
          // `scrollToBottom` re-engages follow-bottom and pins.
          smartScroll.scrollToBottom(false);
          return;
        }

        smartScroll.disengageFollowBottom("region-scroll-restore");

        if (typeof ce.detail.left === "number") {
          el.scrollLeft = ce.detail.left;
        }

        const anchor = parseAnchor(ce.detail.meta);
        if (anchor !== null) {
          smartScroll.setRestoreTarget(
            makeAnchorResolver(
              anchor.index,
              anchor.offset,
              anchor.turnDepth,
              anchor.rowDepth,
            ),
          );
          return;
        }

        // Raw-pixel fallback.
        if (typeof ce.detail.top === "number") {
          smartScroll.scrollTo({ top: ce.detail.top, animated: false });
        }
      };
      el.addEventListener("tug-region-scroll-set", onRegionScrollSet);

      // Resize episodes. A card width change re-wraps every row, so the
      // `scrollTop` the user left behind names a different place afterwards.
      // `preventDefault()` claims the scroller and this list resolves its own
      // anchor, in two units, tried in that order:
      //
      //  1. **The element under the top edge.** A row here is a whole TURN,
      //     routinely several screens tall, so "row 4 plus 1191px" is a pixel
      //     offset into re-wrapping content — the very quantity the reflow
      //     invalidates. Measured against the box the reader is actually
      //     looking at, the anchor survives the re-wrap.
      //  2. **The row, when that element goes.** The width settle wipes the
      //     measured-height ledger and re-renders every row, so the anchored
      //     node can leave the document mid-gesture. Falling back to the row
      //     keeps the reader within a turn of their place instead of losing
      //     it entirely.
      //
      // The row fallback anchors on the ANCHOR ROW, not on the turn the
      // cross-mount bag uses as its basis, and resolves by raw index: no
      // re-windowing happens inside a resize, so the depth relocation the
      // reload path needs would only add a way to be wrong.
      //
      // A list following the bottom installs nothing: the container
      // ResizeObserver's synchronous `maybePinToBottom` already holds the
      // bottom exactly, and a restore target would disengage
      // follow-bottom to chase a near-bottom anchor that lands short.
      //
      // The target waives the drift supersede, because the reflow it
      // exists to absorb is itself what moves `scrollTop` — see
      // `restoreSupersede`. A real gesture still supersedes.
      const onPreserveBegin = (event: Event): void => {
        event.preventDefault();
        const ss = smartScrollRef.current;
        if (ss === null || ss.isFollowingBottom) return;
        if (preserveReleaseRef.current !== null) {
          clearTimeout(preserveReleaseRef.current);
          preserveReleaseRef.current = null;
        }
        const byElement = trackElementAnchor(el);
        const anchor = deriveLiveAnchor();
        const byRow =
          anchor === null
            ? null
            : makeAnchorResolver(anchor.index, anchor.rowOffset, undefined, undefined);
        if (byElement === null && byRow === null) return;
        ss.setRestoreTarget(
          () => byElement?.() ?? byRow?.() ?? null,
          { suspendDriftSupersede: true },
        );
      };
      const onPreserveEnd = (): void => {
        const ss = smartScrollRef.current;
        if (ss === null) return;
        ss.applyRestoreTarget();
        // The GESTURE is over; the content settle is not. Rows keep
        // re-measuring for several frames after the frame stops moving —
        // markdown re-layout, per-cell observers landing — and each one moves
        // the anchored block again. Releasing here would land the anchor
        // against half-measured geometry and then walk away from the rest,
        // which reads as the position drifting a few hundred pixels *after*
        // the card visibly stopped. So the target rides a trailing window and
        // the per-commit heartbeat keeps re-landing it. Then it lets go: a
        // restore that never releases would fight the next thing to move the
        // scroller.
        if (preserveReleaseRef.current !== null) {
          clearTimeout(preserveReleaseRef.current);
        }
        preserveReleaseRef.current = setTimeout(() => {
          preserveReleaseRef.current = null;
          smartScrollRef.current?.clearRestoreTarget();
        }, RESIZE_SETTLE_TAIL_MS);
      };
      el.addEventListener(RESIZE_PRESERVE_BEGIN, onPreserveBegin);
      el.addEventListener(RESIZE_PRESERVE_END, onPreserveEnd);

      // Publish the same façade `ScrollerProvider` gives descendants under
      // the scroll container itself, so a DOM-side caller that never sees the
      // React tree — the focus engine's reveal — can release follow-bottom
      // before it writes `scrollTop`.
      const detachScroller = attachScrollerElement(el, scrollerFacadeRef.current);

      return () => {
        if (atTopSeedRaf !== null) {
          cancelAnimationFrame(atTopSeedRaf);
          atTopSeedRaf = null;
        }
        if (preserveReleaseRef.current !== null) {
          clearTimeout(preserveReleaseRef.current);
          preserveReleaseRef.current = null;
        }
        detachScroller();
        el.removeEventListener("tug-region-scroll-set", onRegionScrollSet);
        el.removeEventListener(RESIZE_PRESERVE_BEGIN, onPreserveBegin);
        el.removeEventListener(RESIZE_PRESERVE_END, onPreserveEnd);
        smartScroll.dispose();
        smartScrollRef.current = null;
      };
      // `followBottom` is read once on mount — runtime changes to
      // the prop don't tear down + recreate SmartScroll. Consumers
      // that need to flip mid-life can do so via the imperative
      // handle (a follow-on if the need arises) or by remounting.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ResizeObserver on the scroll container itself. Without this,
    // `viewportHeight` (read inline from `clientHeight` at render
    // time) only updates when something else triggers a re-render —
    // a card resize that grows the container leaves a too-tall
    // bottom spacer and an under-populated rendered window because
    // nothing notices the new viewport. Mirrors the
    // `TugMarkdownView` pattern that observes its own scroll
    // container.
    //
    // ResizeObserver coalesces multiple layout shifts in a frame
    // into one delivery, so calling `scrollTick` per fire is enough
    // — no extra rAF coalescing needed.
    React.useLayoutEffect(() => {
      const el = scrollContainerRef.current;
      if (el === null) return;
      const observer = new ResizeObserver(() => {
        // **Synchronous bottom-pin.** Container resize changes the
        // absolute bottom position; pin synchronously so the bottom
        // region doesn't visibly drift mid-resize. Per-cell observers
        // fire AFTER this for cells whose intrinsic height changed
        // (text re-wrap, etc.), and the per-cell sync pin there snaps
        // to the updated bottom as each cell settles — together the
        // two paths keep the bottom region glued across the full
        // resize cascade. `maybePinToBottom` owns the gate.
        // Frozen during a batch load + settle (placement is the restore
        // path's; the falling edge pins once).
        if (!isScrollBatteryFrozen()) {
          smartScrollRef.current?.maybePinToBottom();
        }
        // Re-land a pending anchor against the geometry this delivery
        // reports. During a resize episode that is the whole point: the
        // frame's width tweens over several hundred milliseconds, content
        // re-wraps on every frame of it, and re-resolving here is what
        // keeps the anchored row visually still instead of snapping once
        // at the end. A no-op when no target is installed, which is the
        // steady state — and mutually exclusive with the pin above, since
        // a list following the bottom installs no episode target.
        smartScrollRef.current?.applyRestoreTarget();
        // Still request the async pin + re-window so the rendered
        // window catches any cells that newly fit / no longer fit
        // at the new container width. The post-commit pin write
        // is a no-op when the sync pin already landed scrollTop
        // at the bottom (pinToBottom is idempotent).
        pinRequestedRef.current = true;
        scrollTick();
      });
      observer.observe(el);
      return () => {
        observer.disconnect();
      };
    }, []);

    // Register the out-of-tree probe handle for this scroller, and
    // publish the displacement counter's floor. The attribute exists
    // from mount so `"0"` is a positive assertion — an absent
    // attribute would read the same as a clean run ([L06]).
    React.useLayoutEffect(() => {
      const el = scrollContainerRef.current;
      if (el === null) return;
      el.setAttribute(
        "data-scroll-displacements",
        String(displacementCountRef.current),
      );
      const probe: ListViewProbe = {
        forceCommitClamp: () => {
          forceClampRef.current = true;
          scrollTick();
        },
        displacementCount: () => displacementCountRef.current,
        conservationEvents: () => conservationEventsRef.current.slice(),
        geometryRing: () => geometryRingRef.current.slice(),
        extentFloor: () => ({ ...extentFloorStateRef.current }),
        // Same-moment read: ledger charge vs live rendered extent for
        // every mounted cell, right now. Complements the evict-time
        // records above, whose live figures are one commit old.
        auditLedger: (): LedgerAudit => {
          const scroller = scrollContainerRef.current;
          const gap = rowGapPxRef.current ?? 0;
          const rows: LedgerAuditRow[] = [];
          let mounted = 0;
          let worst = 0;
          if (scroller !== null) {
            const cells = scroller.querySelectorAll<HTMLElement>(
              "[data-tug-list-cell-index]",
            );
            for (const cell of cells) {
              const index = Number.parseInt(
                cell.getAttribute("data-tug-list-cell-index") ?? "",
                10,
              );
              if (Number.isNaN(index)) continue;
              mounted += 1;
              const live = cell.offsetHeight + gap;
              const ledger = heightIndexRef.current.get(index);
              const delta = ledger === undefined ? Number.NaN : ledger - live;
              if (ledger === undefined || Math.abs(delta) >= 0.5) {
                rows.push({
                  index,
                  kind: cell.getAttribute("data-tug-list-cell-kind") ?? "",
                  ledger: ledger ?? null,
                  live,
                  delta: Number.isFinite(delta) ? delta : 0,
                });
              }
              if (Number.isFinite(delta)) {
                worst = Math.max(worst, Math.abs(delta));
              }
            }
          }
          return { gap, mounted, worst, rows };
        },
      };
      listViewProbeRegistry.set(el, probe);
      return () => {
        if (listViewProbeRegistry.get(el) === probe) {
          listViewProbeRegistry.delete(el);
        }
      };
      // `scrollTick` is a stable reducer dispatch.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // **The commit bracket.** Detects a `scrollTop` the machine cannot
    // account for, attributes it, and records it loudly as a defect.
    // It never counter-writes: the extent floor makes the clamp
    // impossible by construction, so the bracket's job is to witness a
    // hole in the floor, not to paper over one.
    //
    // The premise: a person cannot scroll during synchronous
    // JavaScript. The commit phase is synchronous — the event loop is
    // not turning, no input is being processed — so a position change
    // observed across it was caused by the machine, with certainty
    // rather than confidence. That is the one interval where "the
    // scroller moved and nobody asked it to" is a safe conclusion; a
    // general across-frames version of this rule would fight the native
    // scrollbar, whose drag is silent in pointer and wheel events.
    //
    // The baseline is `SmartScroll.lastScrollEventTop`, NOT this
    // component's previous reading. The previous reading spans the
    // whole inter-commit interval — real wall time, in which a thumb
    // drag is indistinguishable from a clamp. The last-scroll-event
    // position discriminates by event timing instead: a drag delivers
    // scroll events that refresh it before any commit can run, while a
    // clamp moves `scrollTop` synchronously at forced layout and its
    // scroll event cannot dispatch until the layout phase has ended.
    // So at this point the baseline reflects every drag and no clamp.
    //
    // **Ordering is load-bearing, in both directions.**
    //
    // After the front-insert prepend effect, which writes `scrollTop`
    // directly (it calls `noteExternalWrite` so this bracket can see
    // it).
    //
    // Before the auto-follow-bottom pin effect below, and that half is
    // the sharper one. `maybePinToBottom` re-engages follow-bottom for
    // an idle scroller sitting inside the at-bottom band — and during
    // a clamp the document is transiently short, so
    // `scrollTop == scrollHeight - clientHeight` and `isAtBottom`
    // reads TRUE even for a user parked deep in history. A pin call in
    // that window would re-engage them and yank them to the live edge:
    // the same class of user-fighting behavior this whole bracket
    // exists to end, in the opposite direction. Witnessing first —
    // which restores the floor from a simulated clamp and re-syncs the
    // baseline via `noteExternalWrite` — closes that window. Do not
    // move either effect past the other.
    React.useLayoutEffect(() => {
      const el = scrollContainerRef.current;
      const ss = smartScrollRef.current;
      if (el === null || ss === null) return;

      // A hidden scroller (`display: none` — an inactive card tab)
      // reports every geometry read as 0. That is the absence of a
      // position, not a position; classifying against it would
      // manufacture a displacement on every background commit.
      if (el.clientHeight === 0) return;

      // The clamp simulation. After window geometry became atomic a
      // real commit-scoped clamp is impossible by construction, which
      // leaves this detector with no natural trigger to be tested
      // against — so the test surface can arm a genuine one here.
      // Shortening the spacer and then reading `scrollHeight` forces
      // layout while the document is short, and the browser clamps
      // `scrollTop` exactly as the original tear did. The height is
      // restored in the same synchronous block, so the commit ends
      // with correct geometry and a displaced position: the real
      // article, reproduced from inside the commit where `evalJS`
      // cannot reach.
      //
      // This is the ONE sanctioned exception to "spacer height is
      // written in the render pass and nowhere else" (see the spacer
      // elements). It deliberately re-creates the tear the render-pass
      // rule exists to prevent, and restores the exact string React
      // put there before the block ends, so React's own record of the
      // style stays accurate.
      if (forceClampRef.current) {
        forceClampRef.current = false;
        const spacer = topSpacerRef.current;
        if (spacer !== null) {
          const restore = spacer.style.height;
          const shortened = Math.max(
            0,
            spacer.offsetHeight - SIMULATED_CLAMP_SHRINK_PX,
          );
          // The extent floor holds the document up against exactly this
          // kind of transient dip, so the simulation must take it down
          // for the duration or there is no clamp to simulate. Restored
          // to the bracket's own recorded value before the block ends —
          // the bracket is the floor's only writer, so its record IS
          // the correct restoration target.
          const floorEl = extentFloorRef.current;
          if (floorEl !== null) floorEl.style.height = "0px";
          spacer.style.height = `${shortened}px`;
          void el.scrollHeight;
          spacer.style.height = restore;
          if (floorEl !== null) {
            floorEl.style.height = `${extentFloorStateRef.current.height}px`;
          }
          void el.scrollHeight;
        }
      }

      const prev = commitGeometryRef.current;
      // Read together, so position and geometry describe one moment.
      // Layout is flushed once for the three of them. `scrollTop` is
      // reassigned in one place only: when lowering the extent floor
      // clamps the position, the classification below must reason
      // about the post-rebase moment.
      let scrollTop = el.scrollTop;
      const scrollHeight = el.scrollHeight;
      const clientHeight = el.clientHeight;

      // ---- Conservation probe ----
      //
      // Eviction is height-neutral only when the extent the spacer
      // charges for a departing row equals the extent the row actually
      // occupied in the flow. This block measures that equality
      // directly rather than inferring it from `scrollTop` symptoms:
      // each commit records every mounted cell's live outer extent
      // (border-box height + gap), and on the commit where rows depart
      // into a spacer, diffs the ledger's charge for each departed row
      // against that row's last live extent. The per-swap `delta` IS
      // the document height error the swap introduced — the quantity
      // a browser clamp then acts on. Reads happen on the layout the
      // geometry reads above already flushed, so no extra layout pass.
      //
      // Boundary convention: the last row of the list carries a `gap`
      // term in both ledger and live figures though no gap renders
      // after it, so per-row diffs stay convention-consistent; a swap
      // touching the final row can misstate the sum by at most one gap.
      {
        const gap = rowGapPxRef.current ?? 0;
        const prevLive = liveExtentsRef.current;
        const first = windowResult.firstIndex;
        const last = windowResult.lastIndex;
        const ring = geometryRingRef.current;
        ring.push({
          top: scrollTop,
          h: scrollHeight,
          ts: topSpacerRef.current?.offsetHeight ?? -1,
          bs: bottomSpacerRef.current?.offsetHeight ?? -1,
          first,
          last,
          n: itemCount,
        });
        if (ring.length > 400) ring.splice(0, ring.length - 400);
        if (prevLive.size > 0) {
          let departed = 0;
          let sumLedger = 0;
          let sumLive = 0;
          const rows: ConservationRowDiff[] = [];
          for (const [index, entry] of prevLive) {
            if (index >= first && index < last) continue;
            const ledgerVal = heightIndexRef.current.get(index);
            if (ledgerVal === undefined) continue;
            departed += 1;
            sumLedger += ledgerVal;
            sumLive += entry.live;
            if (Math.abs(ledgerVal - entry.live) >= 0.5 && rows.length < 12) {
              rows.push({
                index,
                kind: entry.kind,
                ledger: ledgerVal,
                live: entry.live,
              });
            }
          }
          if (departed > 0) {
            const event: ConservationEvent = {
              departed,
              sumLedger,
              sumLive,
              delta: sumLedger - sumLive,
              first,
              last,
              itemCount,
              scrollHeight,
              rows,
            };
            conservationEventsRef.current.push(event);
            if (Math.abs(event.delta) >= 0.5) {
              tugDevLogStore.debug("list-view", "conservation", {
                departed: event.departed,
                delta: event.delta,
                sumLedger: event.sumLedger,
                sumLive: event.sumLive,
                first: event.first,
                last: event.last,
                rows: event.rows,
              });
            }
          }
        }
        const next = new Map<number, { live: number; kind: string }>();
        const cells = el.querySelectorAll<HTMLElement>(
          "[data-tug-list-cell-index]",
        );
        for (const cell of cells) {
          const index = Number.parseInt(
            cell.getAttribute("data-tug-list-cell-index") ?? "",
            10,
          );
          if (Number.isNaN(index)) continue;
          next.set(index, {
            live: cell.offsetHeight + gap,
            kind: cell.getAttribute("data-tug-list-cell-kind") ?? "",
          });
        }
        liveExtentsRef.current = next;
      }

      // ---- The extent floor ----
      //
      // The one mechanism behind every observed displacement: WebKit
      // clamps the scroll offset synchronously at renderer removal,
      // INSIDE React's mutation phase. Deletions land before sibling
      // style updates, so for one unobservable instant the removed
      // cells are gone while the spacers still hold their old heights;
      // the browser clamps against that transient extent and nothing
      // restores the position when the spacers grow microseconds
      // later. No scroll API can witness the moment, so the defense is
      // constructive: the floor element pins the scrollable extent at
      // the last settled value, making the dip impossible regardless
      // of mutation order.
      //
      // The floor is set to `extent − 1` every bracket, up or down.
      // The `− 1` keeps the floor from ever DEFINING `scrollHeight`,
      // so `scrollHeight` stays a truthful content measurement (and
      // the worst residual mid-mutation clamp is one pixel, only for a
      // scroller parked at its absolute maximum). Between brackets the
      // floor holds the previous commit's extent — that standing value
      // is what spans the mutation gap.
      //
      // Lowering is the declared rebase: the extent only shrinks for
      // attributable reasons (a collapsed block, a pane re-wrap, a
      // density change, a cleared session, a data-source swap), each
      // of which lands here as a commit whose settled extent is
      // smaller. The lowering itself may clamp `scrollTop` — that is
      // the browser following the shorter document, machine-authored
      // and legitimate — so it is pinned with `noteExternalWrite` and
      // recorded as an `extent-rebase` trace event, never repaired.
      // Setting-to-extent rather than ratcheting with enumerated
      // shrink paths makes the floor self-healing: a shrink path
      // nobody anticipated lowers the floor one commit later instead
      // of leaving permanent phantom scroll space.
      //
      // The extent is MEASURED, never remembered. `scrollHeight` cannot
      // be the source: the floor contributes to it, so on any commit
      // where the floor stands above the content the scroller reports
      // the floor back and the floor would hold itself up. The bottom
      // spacer's bottom edge is the last in-flow content edge — the
      // floor is out of flow and cannot reach it — and the only extent
      // below it is the block-end pseudo-padding, read from the element
      // it belongs to ({@link trailingPadOf}).
      //
      // This used to carry the pad as a self-calibrating `inset`,
      // refreshed on content-defined commits and added back on
      // floor-defined ones. A calibration is a second copy of a
      // measurable fact, and a copy that is only ever refreshed on SOME
      // commits is a copy that can be wrong on the rest: an inset larger
      // than the true pad turns this branch into a RAISE, the floor
      // settles at `content + inset` and stays there — permanent phantom
      // scroll space under a list that fits, which is exactly what the
      // floor's `− 1` was chosen to make impossible. Measuring costs one
      // computed-style read on a layout the geometry reads above have
      // already flushed, and it cannot go stale.
      {
        const floorEl = extentFloorRef.current;
        if (floorEl !== null) {
          const floorState = extentFloorStateRef.current;
          const bottom = bottomSpacerRef.current;
          const bottomEdge =
            bottom === null ? null : bottom.offsetTop + bottom.offsetHeight;
          floorState.inset = trailingPadOf(el);
          const extent =
            bottomEdge === null ? scrollHeight : bottomEdge + floorState.inset;
          const nextFloor = Math.max(0, Math.round(extent) - 1);
          if (nextFloor > floorState.height) {
            floorState.height = nextFloor;
            floorEl.style.height = `${nextFloor}px`;
          } else if (nextFloor < floorState.height) {
            const fromFloor = floorState.height;
            floorState.height = nextFloor;
            floorEl.style.height = `${nextFloor}px`;
            // Flush now so the clamp (if any) happens here, inside the
            // declared write, instead of at whatever read forces
            // layout next.
            void el.scrollHeight;
            const topAfter = el.scrollTop;
            const clamped =
              Math.abs(topAfter - scrollTop) > DISPLACEMENT_EPSILON_PX;
            if (clamped) {
              ss.noteExternalWrite();
              scrollTop = topAfter;
            }
            deckTrace.record({
              kind: "extent-rebase",
              from: fromFloor,
              to: nextFloor,
              scrollTop: topAfter,
              clientHeight,
              clamped,
              following: ss.isFollowingBottom,
            });
            tugDevLogStore.debug("list-view", "extent-rebase", {
              from: fromFloor,
              to: nextFloor,
              scrollTop: topAfter,
              clientHeight,
              clamped,
            });
          }
        }
      }

      const userActivitySeq = ss.userActivitySeq;
      const programmaticWriteSeq = ss.programmaticWriteSeq;
      const following = ss.isFollowingBottom;

      // Counters are re-read here rather than reused from above:
      // attributing a witnessed displacement (`noteExternalWrite`)
      // advances the write counter, and the next bracket must see that
      // advance so it exempts the displacement's still-undelivered
      // scroll event instead of classifying it a second time.
      const snapshot = (top: number): void => {
        commitGeometryRef.current = {
          userActivitySeq: ss.userActivitySeq,
          programmaticWriteSeq: ss.programmaticWriteSeq,
          scrollTop: top,
          following,
        };
      };

      // First bracket since mount — nothing to compare against.
      if (prev === null) {
        snapshot(scrollTop);
        return;
      }

      // A gesture is in flight: the user owns the position outright.
      if (
        ss.phase === "dragging" ||
        ss.phase === "settling" ||
        ss.phase === "decelerating"
      ) {
        snapshot(scrollTop);
        return;
      }

      // Input arrived since the last bracket. A belt — any activity
      // that delivered a scroll event already refreshed the baseline —
      // but it also covers input whose scroll event is still queued.
      if (userActivitySeq !== prev.userActivitySeq) {
        snapshot(scrollTop);
        return;
      }

      // A deliberate machine move (restore heartbeat, correction,
      // reveal, growth pin) whose scroll event may not have delivered
      // yet, so the baseline cannot know about it.
      if (programmaticWriteSeq !== prev.programmaticWriteSeq) {
        snapshot(scrollTop);
        return;
      }

      // The baseline must actually describe the present.
      //
      // The counter check above is one-shot per advance, which is
      // enough for a single write but not for streaming growth: pins
      // land continuously, each one moving the scroller and each one
      // separated from its `scroll` event by at least a task. Without
      // this the bracket reads the transcript's own growth as
      // displacement and pollutes the record with phantom defects.
      // Measured on a 60-turn seed: 37 spurious displacements, every
      // one of them a pin.
      //
      // A real clamp involves no JavaScript write at all, so on a
      // scroller the machine is not actively writing to, the baseline
      // is fresh and the clamp still stands out.
      if (!ss.isScrollBaselineFresh) {
        snapshot(scrollTop);
        return;
      }

      // The position has not moved since the previous bracket already
      // classified it.
      //
      // This is what closes the same-task commit cascade. The list
      // view dispatches `scrollTick()` from inside layout effects, so
      // React re-renders synchronously, before paint: two or three
      // commits can run this bracket in one task with no scroll event
      // delivered between them. Walk a growth pin through that without
      // this check — commit A's pin advances the write counter; commit
      // B takes the exemption above and *consumes* it by refreshing
      // the snapshot; commit C then sees unchanged counters, an idle
      // phase, and a baseline still holding the pre-pin position,
      // because the pin's scroll event is queued rather than
      // delivered. It would classify the pin as displacement and
      // record a phantom defect against the machine's own write.
      //
      // Note this compares against the previous *bracket*, not the
      // baseline — a span of real wall time. That is only safe because
      // it can suppress a record and never cause one, and it never
      // supplies a position of its own.
      if (Math.abs(scrollTop - prev.scrollTop) <= DISPLACEMENT_EPSILON_PX) {
        snapshot(scrollTop);
        return;
      }

      const baseline = ss.lastScrollEventTop;
      const positionDelta = scrollTop - baseline;
      if (Math.abs(positionDelta) <= DISPLACEMENT_EPSILON_PX) {
        snapshot(scrollTop);
        return;
      }

      // **A browser-authored move is not automatically a clamp.**
      //
      // The browser has a second reason to move this scroller, and
      // the transcript depends on it: **scroll anchoring**. When
      // content above the viewport changes height, the browser shifts
      // `scrollTop` by the same amount to keep what the user is
      // reading in place. No JavaScript write, no height shrink — the
      // same signature a clamp leaves. `tug-markdown-block.css` opts
      // into it (`overflow-anchor: auto`) and `render-incremental.ts`
      // is built around it, so classifying it as displacement would
      // indict a feature as a defect.
      //
      // The two separate on whether the document explains the move.
      // Anchoring shifts the position by exactly what changed above
      // the viewport, so the position delta and the height delta
      // match. A clamp is the position moving while the document does
      // not: the field capture recorded `scrollTop` dropping 2,660px
      // with `scrollHeight` identical — 44,262 — on both sides.
      //
      // Hence two conditions. Downward moves are never clamps at all
      // (a clamp pulls toward a shrunken maximum, which is always a
      // SMALLER `scrollTop`), and an upward move whose magnitude the
      // height change accounts for is anchoring compensating for
      // content that shrank above the viewport — a collapsed tool
      // block, say.
      const heightDelta = scrollHeight - ss.lastScrollEventHeight;
      if (positionDelta > 0) {
        snapshot(scrollTop);
        return;
      }
      if (Math.abs(positionDelta - heightDelta) <= DISPLACEMENT_EPSILON_PX) {
        snapshot(scrollTop);
        return;
      }

      // Unexplained. This is the defect the extent floor exists to
      // make impossible, so a record here means the floor itself has a
      // hole. Assert, never repair: the record is loud (deck-trace
      // ring bypasses the enable gate; dev log at warn) and the
      // position is left exactly where the browser put it — a
      // counter-write would hide the evidence behind a fight with the
      // browser, and the diagnosis that produced the floor came from
      // refusing that fight.
      //
      // The move IS attributed, though. `noteExternalWrite` syncs
      // SmartScroll's baseline to the clamped position and advances
      // the write counter, so the displacement's still-undelivered
      // scroll event arrives with no unexplained delta: the intent
      // rules never mistake the browser's move for the user scrolling
      // up, and follow-bottom keeps whatever state the user gave it.
      displacementCountRef.current += 1;
      ss.noteExternalWrite();

      deckTrace.record({
        kind: "scroll-displacement",
        from: baseline,
        to: scrollTop,
        scrollHeight,
        clientHeight,
        following,
        evicting: evictingThisCommit,
      });
      tugDevLogStore.warn("list-view", "scroll-displacement", {
        from: baseline,
        to: scrollTop,
        delta: scrollTop - baseline,
        scrollHeight,
        clientHeight,
        following,
        evicting: evictingThisCommit,
      });
      el.setAttribute(
        "data-scroll-displacements",
        String(displacementCountRef.current),
      );
      snapshot(scrollTop);
    });

    // Cold-fill advance, post-commit. Two jobs while a fill is in
    // flight, both bounded to one write and one timer per commit:
    //
    //   1. Pin the scrollport to the bottom edge so this chunk's paint
    //      shows the transcript tail, held steady as chunks land above
    //      it (content inserted above a bottom-pinned viewport moves
    //      nothing the user can see). The battery's own pins are
    //      frozen through the settle, deliberately — this direct write
    //      is the fill's substitute, one per chunk, on geometry the
    //      commit just laid out anyway. Skipped while the scroller has
    //      no box (a hidden card lays nothing out; the zero-box settle
    //      path owns that case).
    //   2. Yield, then extend the range: a `setTimeout(0)` macrotask
    //      lowers the cursor one chunk and ticks a re-window. The
    //      yield is the entire point — between chunks the event loop
    //      services input, paint, and every other card's traffic.
    //
    // Effect-without-deps: the guard makes the steady state (no fill)
    // a single ref read per commit.
    React.useLayoutEffect(() => {
      if (coldFillFirstRef.current === null) return;
      const el = scrollContainerRef.current;
      if (el !== null && el.offsetWidth > 0) {
        el.scrollTop = el.scrollHeight;
        // Declare the direct write, as every bypassing write here
        // does: without it the intent rules would read the pin's
        // scroll event as the user scrolling and the displacement
        // bracket would find the scroller somewhere its baseline
        // does not explain.
        smartScrollRef.current?.noteExternalWrite();
      }
      if (coldFillTimerRef.current !== null) return;
      coldFillTimerRef.current = setTimeout(() => {
        coldFillTimerRef.current = null;
        const cur = coldFillFirstRef.current;
        if (cur === null) return;
        const next = cur - COLD_FILL_CHUNK;
        coldFillFirstRef.current = next > 0 ? next : null;
        scrollTick();
      }, 0);
    });

    // Cold-fill teardown: a list unmounted mid-fill (card closed
    // during its own reveal) must not fire a tick into a disposed
    // component.
    React.useLayoutEffect(() => {
      return () => {
        if (coldFillTimerRef.current !== null) {
          clearTimeout(coldFillTimerRef.current);
          coldFillTimerRef.current = null;
        }
      };
    }, []);

    // Eviction bookkeeping, post-commit. Two jobs, both outside React
    // state ([L06] for the attributes, a ref for the retention memory):
    //
    //   1. Remember the committed range so the next window computation
    //      can honour the retain margin. Cleared whenever this commit
    //      did NOT evict, so a suspension can't resurrect a stale range.
    //   2. Publish the diagnostics the eviction lab and `/api/eval`
    //      probes read: whether eviction is live right now, and how many
    //      commits have had to fall back to rendering everything. A
    //      non-zero fallback count on a settled deck means the ledger is
    //      not covering what the mode assumes it covers.
    //
    // These attributes are instrumentation, not styling hooks — nothing
    // in CSS may key off them.
    React.useLayoutEffect(() => {
      prevWindowRangeRef.current = evictingThisCommit
        ? { first: windowResult.firstIndex, last: windowResult.lastIndex }
        : null;
      evictActiveRef.current = evictingThisCommit;
      if (evictSuspendedThisCommit) {
        evictFallbackCountRef.current += 1;
      }
      const el = scrollContainerRef.current;
      if (el === null) return;
      if (!evictModeEnabled) {
        el.removeAttribute("data-evict-active");
        el.removeAttribute("data-evict-fallbacks");
        return;
      }
      if (evictingThisCommit) {
        el.setAttribute("data-evict-active", "");
      } else {
        el.removeAttribute("data-evict-active");
      }
      el.setAttribute(
        "data-evict-fallbacks",
        String(evictFallbackCountRef.current),
      );
    });

    // Prime the height-index Fenwick cache so the post-commit
    // correction effect and the imperative handle's `scrollToIndex`
    // read in O(log n) rather than walking linearly. Re-runs when
    // either input changes — `itemCount` after a data-source grow,
    // or `estimatedHeightForKindOnly` identity after a delegate /
    // dataSource swap. ResizeObserver-driven `set()` calls patch the
    // cache incrementally per the height index's contract.
    React.useLayoutEffect(() => {
      heightIndexRef.current.prepare(itemCount, estimatedHeightForKindOnly);
    }, [itemCount, estimatedHeightForKindOnly]);

    // Detect data-source growth and request a pin. Runs only when
    // `itemCount` actually changes — the deps array is the contract.
    // First run on mount sees `prev=0, current=initial`; if items are
    // already present, that classifies as growth and a pin is
    // requested even before any ResizeObserver fires.
    React.useLayoutEffect(() => {
      if (itemCount > prevItemCountRef.current) {
        pinRequestedRef.current = true;
      }
      prevItemCountRef.current = itemCount;
    }, [itemCount]);

    // Auto-follow-bottom pin per [D07]. Signal-driven: bails out
    // unless `pinRequestedRef` was set by an upstream signal (mount,
    // item-count growth, cell ResizeObserver flush, container
    // ResizeObserver). Commits not driven by such a signal — including
    // the scroll-event-induced commit triggered by `pinToBottom`'s own
    // `scrollTop` write — hit the no-request bail at the top, breaking
    // the previous post-commit-on-every-render feedback loop.
    //
    // [L22] alignment: `pinToBottom` is a DOM-appearance update whose
    // legitimate triggers are layout / growth signals, not React's
    // commit cycle. Coupling it to every commit (the previous no-deps
    // `useLayoutEffect`) is the spirit-violation that produced the
    // relaunch bounce — pin's own scroll event re-fed the commit
    // cycle, sustaining a tight pin → scroll → re-render → pin loop.
    //
    // The follow-bottom gate itself lives in `SmartScroll.maybePin
    // ToBottom` ([L07] reads `isFollowingBottom` live); this effect
    // owns only the `pinRequestedRef` lifecycle.
    //
    // **Must stay declared after the displacement bracket above.**
    // `maybePinToBottom` re-engages follow-bottom when the scroller is
    // idle inside the at-bottom band, and a clamp makes `isAtBottom`
    // read true even for a user parked in history — the document is
    // transiently short, so the position is trivially "at the bottom"
    // of it. The bracket restores the floor from a simulated clamp and
    // settles its witness before this effect reads any geometry.
    // Reorder the two and a clamp silently pins a reader to the live
    // edge.
    //
    // Ref-clearing semantics: HOLD the request (don't clear) on
    // `no-ss` (rare; the SmartScroll-install effect runs before this
    // one in registration order — the request survives to a commit
    // where SmartScroll exists) and on `user-scrolling` (the pin must
    // re-fire once the gesture ends). CONSUME the request on every
    // other path: once SmartScroll exists and the user is idle, this
    // commit is the request's terminal outcome — `maybePinToBottom`
    // either pins or correctly drops the request when follow-bottom
    // is disengaged.
    React.useLayoutEffect(() => {
      const frozen = isScrollBatteryFrozen();
      const wasFrozen = pinFrozenPrevRef.current;
      pinFrozenPrevRef.current = frozen;

      // Frozen during a batch load + settle: drop any pin request so
      // `pinToBottom`'s `scrollHeight` read never forces a layout while
      // the batch commits and settles. Placement is the restore path's.
      if (frozen) {
        pinRequestedRef.current = false;
        return;
      }
      // Falling edge (the batch settled): place the bottom once, so a
      // list that was following the bottom lands at the now-settled
      // bottom. A list the user scrolled away from is not following the
      // bottom, so `maybePinToBottom` bails — no yank.
      if (wasFrozen) {
        pinRequestedRef.current = true;
      }

      if (!pinRequestedRef.current) return;
      const ss = smartScrollRef.current;
      if (ss === null) return;
      // Hold the request while the user is scrolling AWAY (mid-gesture and
      // off the bottom) so the pin re-fires once the gesture ends. But a
      // user still sitting AT the live edge during a downward gesture is
      // not scrolling away — follow-bottom stays engaged (only an
      // upward/away gesture disengages it), so growth must keep pinning
      // rather than open a gap beneath them. `maybePinToBottom`'s
      // `shouldAutoPin` gate carries the same `isAtBottom` allowance, so
      // the two stay consistent; this guard only governs whether the
      // request survives to a later commit.
      if (ss.isUserScrolling && !ss.isAtBottom) return;
      pinRequestedRef.current = false;
      if (itemCount <= 0) return;
      ss.maybePinToBottom();
    });

    // Anchor-state writer. Runs every commit; reads the live
    // `scrollTop`, derives the topmost visible cell via
    // `heightIndex.indexForOffset`, and serializes the resulting
    // `{anchor: {index, offset}}` payload onto `data-tug-scroll-state`.
    // CardHost's `captureRegionScrolls` reads the attribute at every
    // capture moment ([A9] save) so the bag's `regionScroll[key].meta`
    // carries a live anchor that survives reload.
    //
    // Anchor invariant: the attribute reflects the position the user
    // is looking at *right now*. Scroll events trigger a React commit
    // via the scroll-tick state setter, which fires this effect, which
    // refreshes the attribute. Cell measurement growth that shifts the
    // heightIndex also triggers a commit (the index-prepare and post-
    // commit effects re-render the rendered range) — the attribute
    // refresh keeps pace.
    //
    // No write when the list is empty: `indexForOffset(0, 0, ...)`
    // returns 0 trivially, and the meta would be `{anchor:{0,0}}`
    // which is semantically "top of an empty list" — harmless, but
    // we skip the attribute write to keep empty-card DOM clean.
    //
    // [L06] DOM-attribute write, never React state. [L07] reads
    // from the live `scrollContainerRef.current` and `heightIndexRef`.
    React.useLayoutEffect(() => {
      // Frozen during a batch load + settle: this reads `scrollTop` /
      // `scrollHeight`, each forcing a full-transcript layout, and would
      // run on every settle commit. The anchor it could write mid-batch
      // is meaningless (content is being placed, not read by the user) —
      // the restore path owns the position. Resumes on the falling edge,
      // where the next commit writes the live anchor.
      if (isScrollBatteryFrozen()) return;
      const el = scrollContainerRef.current;
      if (el === null) return;
      // A hidden scroller (`display: none` — an inactive card tab) has no
      // scrollport: `scrollTop` reads 0 there, which is the absence of a
      // position, not a position. Writing it would overwrite the attribute
      // with a top-of-list anchor that the [A9] debounced save can persist
      // while the card sits in a background tab. Freeze the attribute at
      // its last visible value instead.
      if (el.clientHeight === 0) return;
      const total = dataSource.numberOfItems();
      if (total <= 0) {
        el.removeAttribute("data-tug-scroll-state");
        return;
      }
      const live = deriveLiveAnchor();
      if (live === null) return;
      const anchor: {
        index: number;
        offset: number;
        turnDepthFromEnd?: number;
        depthFromEnd?: number;
      } = { index: live.index, offset: live.offset };
      if (typeof live.turnDepth === "number") {
        anchor.turnDepthFromEnd = live.turnDepth;
      } else {
        anchor.depthFromEnd = live.rowDepth;
      }
      const meta: {
        anchor: typeof anchor;
        scrollHeight?: number;
        atBottom?: boolean;
      } = { anchor };
      // Validation field — total content height at save time. Not
      // consumed at restore today; documented in the schema so
      // future cross-version layout checks have a hook.
      meta.scrollHeight = el.scrollHeight;
      // `atBottom` — true when the list is following the bottom. The
      // restore path keys off this to re-engage follow-bottom and pin
      // (exact, jump-to-bottom affordance hidden) instead of resolving
      // the near-bottom anchor. Omitted when false to keep the bag
      // clean; a non-follow-bottom list never sets it.
      const ss = smartScrollRef.current;
      if (ss !== null && ss.isFollowingBottom) meta.atBottom = true;
      el.setAttribute("data-tug-scroll-state", JSON.stringify(meta));
    });

    // Restore-target heartbeat. `SmartScroll` owns the cold-boot
    // scroll-restore policy (the resolver, the supersede rules);
    // this effect only forwards the per-commit layout signal it
    // needs. `applyRestoreTarget` re-resolves the installed target
    // and writes `scrollTop` when it has drifted — so as virtualized
    // cells settle their heights across commits (markdown loads,
    // file-viewer substrates measure, terminal lines re-render) the
    // restore tracks the anchor cell's true position. It is a cheap
    // null-check no-op once no target is installed (the steady state
    // after the first user gesture / follow-bottom engage).
    //
    // [L03] `useLayoutEffect` — the write lands before paint, so the
    // first paint after a heightIndex update reflects the restored
    // `scrollTop`.
    // [L06] the write is a direct DOM `scrollTop` set inside
    // `SmartScroll`; no React state crossed.
    // [L23] preserves the user-visible saved viewport position
    // across the indefinite content-settle window.
    React.useLayoutEffect(() => {
      smartScrollRef.current?.applyRestoreTarget();
    });

    // Two-pass `scrollToIndex` correction per [D03]. Pass 1 lives in
    // the imperative handle (estimated jump); this effect implements
    // pass 2. Runs after every commit; no-ops when no correction is
    // pending.
    //
    // Supersede first: a correction is a deferred scroll write, and
    // no deferred write survives the user moving the scroller. The
    // drift check against `armedTop` (the pass-1 post-write
    // read-back, clamping folded in) catches every mover the list
    // view cannot see — chiefly the event-silent native scrollbar —
    // as well as ordinary gestures; either way the correction is
    // voided rather than snapping them to a stale target.
    //
    // Correction source: when the target row is mounted, its real
    // rect is the truth — `scrollToElement` places it per the armed
    // `block`, repairing what ledger arithmetic cannot (the
    // breathing-room pseudo-elements and window chrome belong to no
    // cell, so `offsetForIndex + leadingOffsetPx()` is systematically
    // short by that constant). When the row is measured but was
    // re-evicted before this effect ran, the ledger recompute (with
    // the rebase folded into `estimatedTop` at arm time) is the
    // fallback. Sub-threshold drifts skip the corrective write so a
    // stable target produces exactly one `scrollTo` (the pass-1
    // jump).
    //
    // The pending state is cleared in the mounted, corrected, and
    // sub-threshold branches — pass 2 is finished regardless of
    // whether a correction was issued. Until measurement arrives,
    // the ref stays set and a later commit completes the protocol.
    React.useLayoutEffect(() => {
      const pending = pendingScrollCorrectionRef.current;
      if (pending === null) return;
      const ss = smartScrollRef.current;
      if (ss === null) return;
      const scrollEl = scrollContainerRef.current;
      if (scrollEl === null) return;
      if (
        Math.abs(scrollEl.scrollTop - pending.armedTop) >
        SCROLL_CORRECTION_SUPERSEDE_DRIFT_PX
      ) {
        pendingScrollCorrectionRef.current = null;
        return;
      }
      const targetEl = cellElementMapRef.current.get(pending.index);
      if (targetEl !== undefined) {
        ss.scrollToElement(targetEl, {
          block: pending.block,
          animated: false,
        });
        pendingScrollCorrectionRef.current = null;
        return;
      }
      if (!heightIndexRef.current.has(pending.index)) return;

      const correctedTop =
        heightIndexRef.current.offsetForIndex(
          pending.index,
          estimatedHeightForKindOnly,
        ) + leadingOffsetPx();
      if (Math.abs(correctedTop - pending.estimatedTop) > SCROLL_CORRECTION_THRESHOLD_PX) {
        ss.scrollTo({ top: correctedTop, animated: false });
      }
      pendingScrollCorrectionRef.current = null;
    });

    // Cell-lifecycle delegate dispatch. Runs every commit ([L03] —
    // synchronous after commit, before paint) and diffs the rendered
    // index set against the previous commit's set. Indices that just
    // entered the rendered window fire `delegate.willDisplay`;
    // indices that just left fire `delegate.didEndDisplaying`. Empty
    // diffs (the steady-state case where the window didn't move) cost
    // two empty Set walks and no callback invocations.
    //
    // Order pinning: `willDisplay` fires for every entered index
    // (ascending), THEN `didEndDisplaying` fires for every left index
    // (ascending). This matches UIKit's effective order during a
    // scroll/reuse pass — new cells are dequeued and configured
    // (`willDisplay`) before old cells are signalled gone
    // (`didEndDisplaying`). Documenting it here lets consumers depend
    // on the order; the test "fires willDisplay before didEndDisplaying"
    // pins it.
    //
    // Each entered/left list is built by iterating its source set in
    // numeric-ascending order — both `currentSet` and `prev` are
    // populated by `for (let i = first; i < last; ...)`, so their
    // iteration order is already ascending.
    //
    // The closure captures the current render's `delegate`
    // identity, which is the freshest reference available — a
    // consumer that recreates `delegate` on every render gets fresh
    // closures every commit, with no missed transitions and no
    // re-fires (the diff is empty when the rendered set didn't
    // move). No deps array is correct here: every commit must run
    // the diff so that data-source ticks, scrolls, and viewport
    // changes are all captured.
    //
    // Unmount: the layout-effect's lifecycle does not call
    // `didEndDisplaying` on unmount in v1. Consumers that need
    // teardown signals beyond cell-level scroll-out should attach
    // them to the cell-renderer's own `useEffect` cleanup, which is
    // what UIKit-style imperative-pool reuse would surface
    // identically (cells stay mounted across the pool's lifetime;
    // only the table-view destruction would tear them down). This
    // keeps the lifecycle delegate purely about *visibility
    // transitions inside a live list view*, not list-view teardown.
    React.useLayoutEffect(() => {
      const currentSet = new Set<number>();
      for (let i = windowResult.firstIndex; i < windowResult.lastIndex; i += 1) {
        if (i >= itemCount) break;
        currentSet.add(i);
      }

      const prev = prevRenderedIndicesRef.current;
      const willDisplayCb = delegate?.willDisplay;
      const didEndDisplayingCb = delegate?.didEndDisplaying;

      if (willDisplayCb !== undefined) {
        for (const i of currentSet) {
          if (!prev.has(i)) willDisplayCb(i);
        }
      }
      if (didEndDisplayingCb !== undefined) {
        for (const i of prev) {
          if (!currentSet.has(i)) didEndDisplayingCb(i);
        }
      }

      prevRenderedIndicesRef.current = currentSet;
    });

    // Rect-space rebase: the constant by which `offsetForIndex +
    // leadingOffsetPx()` falls short of a row's true document offset.
    // Ledger entries are outer cell extents and `leadingOffsetPx()`
    // covers the leading strip, but the scroll container's
    // breathing-room pseudo-elements and window chrome belong to no
    // cell and no tracked element — so ledger arithmetic is short by
    // their combined height. Any mounted cell captures the whole
    // constant without naming its parts: its real rect vs its ledger
    // offset. Returns `null` when no cell is mounted (under
    // `evictOffscreen` one always is). Anchor save/restore never
    // needs this (the constant folds into the saved offset because
    // save and restore use the same formula); *flush placement* —
    // estimated pass-1 jumps — does. Reads live DOM, so callers are
    // explicit gesture paths, not per-commit hot paths.
    const rectSpaceRebasePx = React.useCallback((): number | null => {
      const scrollEl = scrollContainerRef.current;
      if (scrollEl === null) return null;
      const viewTop = scrollEl.getBoundingClientRect().top;
      for (const [j, el] of cellElementMapRef.current) {
        return (
          el.getBoundingClientRect().top -
          viewTop +
          scrollEl.scrollTop -
          (heightIndexRef.current.offsetForIndex(
            j,
            estimatedHeightForKindOnly,
          ) +
            leadingOffsetPx())
        );
      }
      return null;
    }, [estimatedHeightForKindOnly, leadingOffsetPx]);

    // Step the scroller one entry up / down — the shared core behind
    // both the PageUp/PageDown key handler below and the imperative
    // `pageByEntry` method on the handle (which lets a consumer drive
    // turn-by-turn navigation from a key bound anywhere, not only when
    // focus sits inside this scroll container). Geometry comes from real
    // DOM rects where a cell is mounted, and from the measured-height
    // ledger re-based into rect space where it is not (the
    // `evictOffscreen` case) — so `row-gap` and the breathing-room
    // pseudo-elements can't drift the target. Returns `true` when
    // it performed a scroll, `false` when there was nothing to do (so a
    // key handler can fall through to the browser default). The scroll
    // write routes through `SmartScroll` to keep the [D07] follow-bottom
    // intent coherent: an up-step disengages, a down-step past the last
    // entry re-engages at the live bottom.
    const pageByEntryStep = React.useCallback(
      (direction: "up" | "down"): boolean => {
        const ss = smartScrollRef.current;
        const scrollEl = scrollContainerRef.current;
        if (ss === null || scrollEl === null) return false;
        const itemCount = dataSource.numberOfItems();
        if (itemCount === 0) return false;
        const viewTop = scrollEl.getBoundingClientRect().top;
        // Under `evictOffscreen` most rows are unmounted, so their tops
        // come from the ledger (exact — eviction only engages when every
        // out-of-window row is measured), re-based into rect space via a
        // mounted cell so both sources describe the same axis. Mounted
        // cells keep their real rects. The rebase constant is the same
        // in viewport and document space (the `scrollTop` terms
        // cancel), so `rectSpaceRebasePx` serves both the selection
        // math here and the document-space jump below.
        const ledgerTopFor = (i: number): number =>
          heightIndexRef.current.offsetForIndex(
            i,
            estimatedHeightForKindOnly,
          ) +
          leadingOffsetPx() -
          scrollEl.scrollTop;
        const rebase = rectSpaceRebasePx();
        const cellEls: Array<HTMLElement | undefined> = [];
        const cellTops: number[] = [];
        for (let i = 0; i < itemCount; i += 1) {
          const el = cellElementMapRef.current.get(i);
          cellEls.push(el);
          if (el !== undefined) {
            cellTops.push(el.getBoundingClientRect().top - viewTop);
          } else if (rebase !== null) {
            cellTops.push(ledgerTopFor(i) + rebase);
          } else {
            return false;
          }
        }
        const result = computePageNavigation({ direction, cellTops });
        if (result.kind === "none") return false;
        if (result.kind === "bottom") {
          ss.scrollToBottom(false);
          return true;
        }
        if (direction === "up") ss.disengage("page-up-key");
        const targetEl = cellEls[result.index];
        if (targetEl !== undefined) {
          ss.scrollToElement(targetEl, {
            animated: false,
            block: "start",
          });
          return true;
        }
        // Unmounted target: the [D03] two-pass protocol, same as
        // `scrollToIndex` — estimated jump now, post-commit correction
        // once the row mounts and measures. The jump carries the same
        // rebase the selection math used — without it the entry lands
        // `rebase` px shy of flush and the ledger-fallback correction
        // recomputes the identical shortfall. An unmounted target
        // implies a mounted sibling supplied a non-null rebase above.
        const estimatedTop =
          heightIndexRef.current.offsetForIndex(
            result.index,
            estimatedHeightForKindOnly,
          ) +
          leadingOffsetPx() +
          (rebase ?? 0);
        ss.scrollTo({ top: estimatedTop, animated: false });
        pendingScrollCorrectionRef.current = {
          index: result.index,
          estimatedTop,
          block: "start",
          armedTop: scrollEl.scrollTop,
        };
        return true;
      },
      [
        dataSource,
        estimatedHeightForKindOnly,
        leadingOffsetPx,
        rectSpaceRebasePx,
      ],
    );

    // Imperative handle. `scrollToIndex` routes every scroll write
    // through `SmartScroll` per [D07] and implements the [D03]
    // two-pass precision protocol:
    //
    //   - Rendered target → `SmartScroll.scrollToElement(el, options)`.
    //     The DOM rect is exact, no follow-up needed; `block` and
    //     `animated` flow through to the scrollport write.
    //   - Unrendered target → pass 1: compute the estimated offset
    //     from the height index (measured heights win, estimates
    //     fill gaps) and call `SmartScroll.scrollTo({ top })`. The
    //     re-windowing the scroll triggers mounts the target row;
    //     `ResizeObserver` measures it; pass 2 (the post-commit
    //     correction effect above) reconciles the offset.
    //
    // Out-of-range indices clamp to first/last per [D03]; `NaN` and
    // empty data sources are no-ops with no scroll write.
    // `descendIntoRow` routes through this ref because the cursor / descend
    // callbacks it needs (`moveCursorTo`, `descendCursorRow`) are declared
    // below this handle; the ref lets the handle read the live closure at call
    // time without pulling later-declared consts into its dependency array.
    const descendIntoRowRef = React.useRef<(index: number) => void>(() => {});
    const moveCursorToRef = React.useRef<(index: number) => void>(() => {});
    // The attached-list cursor's three verbs, late-bound like their neighbors:
    // the handle is built above the callbacks that implement them.
    const attachedCursorMoveRef = React.useRef<
      (direction: "up" | "down") => boolean
    >(() => false);
    const attachedCursorIndexReadRef = React.useRef<() => number>(() => -1);
    const attachedCursorReleaseRef = React.useRef<() => void>(() => {});
    React.useImperativeHandle(
      ref,
      () => ({
        scrollToIndex(
          index: number,
          options?: { block?: ScrollLogicalPosition; animated?: boolean },
        ): void {
          if (Number.isNaN(index)) return;
          const total = dataSource.numberOfItems();
          if (total === 0) return;
          const ss = smartScrollRef.current;
          if (ss === null) return;
          const clamped = Math.max(0, Math.min(total - 1, Math.floor(index)));

          const renderedEl = cellElementMapRef.current.get(clamped);
          if (renderedEl !== undefined) {
            // Pass-1-only path: the rect is already exact.
            // Default `block: "start"` aligns the row to the top of
            // the viewport — matches `UITableView.scrollToRow(at:at
            // ScrollPosition: .top)` and is the more useful default
            // for "scroll this specific row into focus" use cases
            // than `"nearest"` (which leaves an already-partially-
            // visible row where it is). Consumers that want minimum
            // disturbance pass `block: "nearest"` explicitly.
            ss.scrollToElement(renderedEl, {
              animated: options?.animated ?? false,
              block: options?.block ?? "start",
            });
            // A pending correction from a prior call is invalidated
            // by an exact-rect scroll — clear it so the post-commit
            // effect doesn't issue a stale corrective write.
            pendingScrollCorrectionRef.current = null;
            return;
          }

          // Pass 1 — estimated jump, carrying the rect-space rebase
          // so ledger arithmetic lands at the row's true document
          // offset. Pass 2 fires from the post-commit correction
          // effect above once the target row mounts and is measured.
          // Under `evictOffscreen` this branch is the normal path
          // (the target really is unmounted) and the offset is
          // exact, since every out-of-window row is measured.
          const estimatedTop =
            heightIndexRef.current.offsetForIndex(
              clamped,
              estimatedHeightForKindOnly,
            ) +
            leadingOffsetPx() +
            (rectSpaceRebasePx() ?? 0);
          ss.scrollTo({
            top: estimatedTop,
            animated: options?.animated ?? false,
          });
          // `armedTop` is the post-write read-back, so browser
          // clamping is folded in and only another actor's movement
          // can register as drift. An animated jump reads back its
          // starting position instead — its own tween then registers
          // as drift and voids the correction, which is the safe
          // outcome for a path whose target was estimated anyway.
          pendingScrollCorrectionRef.current = {
            index: clamped,
            estimatedTop,
            block: options?.block ?? "start",
            armedTop:
              scrollContainerRef.current?.scrollTop ?? estimatedTop,
          };
        },
        getElementForIndex(index: number): HTMLElement | null {
          return cellElementMapRef.current.get(index) ?? null;
        },
        scrollToBottom(options?: { animated?: boolean }): void {
          smartScrollRef.current?.scrollToBottom(options?.animated ?? false);
          // Belt-and-suspenders: the synchronous clamp above lands at
          // the pre-commit `scrollHeight - clientHeight`. If the
          // caller dispatched a state change in the same event that
          // grows the list (e.g. user-submit adds an in-flight row
          // before calling this), the new row is in the data source
          // but not yet in the DOM at the moment of the clamp.
          // Arming `pinRequestedRef` guarantees the post-commit pin
          // effect re-asserts the bottom against the post-commit
          // `scrollHeight`, so the new content lands fully in the
          // viewport on the same paint as it appears. `pinToBottom`
          // is idempotent — a no-op when scrollTop is already at the
          // bottom — so the steady-state cost is zero.
          pinRequestedRef.current = true;
        },
        scrollToTop(): void {
          const ss = smartScrollRef.current;
          if (ss === null) return;
          // Leaving the live edge — break follow-bottom so content
          // growth can't slam the view back down, then land at the top.
          ss.disengage("scroll-home-key");
          ss.scrollToTop(false);
        },
        disengageFollowBottom(source: string): void {
          smartScrollRef.current?.disengage(source);
        },
        pageByEntry(direction: "up" | "down"): void {
          pageByEntryStep(direction);
        },
        descendIntoRow(index: number): void {
          descendIntoRowRef.current(index);
        },
        moveCursorTo(index: number): void {
          moveCursorToRef.current(index);
        },
        attachedCursorMove(direction: "up" | "down"): boolean {
          return attachedCursorMoveRef.current(direction);
        },
        attachedCursorIndex(): number {
          return attachedCursorIndexReadRef.current();
        },
        attachedCursorRelease(): void {
          attachedCursorReleaseRef.current();
        },
      }),
      [
        dataSource,
        estimatedHeightForKindOnly,
        pageByEntryStep,
        rectSpaceRebasePx,
      ],
    );

    // Render the windowed slice. Cells are keyed by
    // `dataSource.idForIndex(i)` per the [D04] item-stable contract so
    // React reconciler matches identity across data-source updates.
    //
    // Each entry also carries the cell's role (see "Row roles" in the
    // top-of-file docstring): captured here at render time so the JSX
    // below sets `tabIndex` and `data-list-cell-role` consistently for
    // both the registered-renderer branch and the unknown-kind
    // placeholder branch.
    const renderedRange: Array<{
      index: number;
      id: string;
      kind: string;
      role: TugListViewCellRole;
      enabled: boolean;
    }> = [];
    // Defensive against a data-source shrink mid-render: if itemCount
    // dropped below the previously-computed window, skip indices that
    // are out of range now.
    for (let i = windowResult.firstIndex; i < windowResult.lastIndex; i += 1) {
      if (i >= itemCount) break;
      renderedRange.push({
        index: i,
        id: dataSource.idForIndex(i),
        kind: dataSource.kindForIndex(i),
        role: dataSource.roleForIndex?.(i) ?? DEFAULT_CELL_ROLE,
        enabled: dataSource.enabledForIndex?.(i) ?? true,
      });
    }

    // Rendered-window notification ([L03] / `onRenderedRangeChange`). The
    // mounted rows are the contiguous `renderedRange`; report its inclusive
    // bounds. The layout effect fires post-commit — after the cell ref
    // callbacks have populated `cellElementMapRef` — so a consumer's
    // `getElementForIndex` resolves for the whole reported range and it can
    // decorate synchronously before the browser paints. Deduped against the
    // last reported range so a re-render with an unchanged window is silent.
    const renderedFirstIndex =
      renderedRange.length > 0 ? renderedRange[0].index : -1;
    const renderedLastIndex =
      renderedRange.length > 0
        ? renderedRange[renderedRange.length - 1].index
        : -1;
    const lastReportedRangeRef = React.useRef<TugListRenderedRange | null>(null);
    React.useLayoutEffect(() => {
      if (onRenderedRangeChange === undefined) return;
      const prev = lastReportedRangeRef.current;
      if (
        prev !== null &&
        prev.firstIndex === renderedFirstIndex &&
        prev.lastIndex === renderedLastIndex &&
        prev.itemCount === itemCount
      ) {
        return;
      }
      const next: TugListRenderedRange = {
        firstIndex: renderedFirstIndex,
        lastIndex: renderedLastIndex,
        itemCount,
      };
      lastReportedRangeRef.current = next;
      onRenderedRangeChange(next);
    }, [onRenderedRangeChange, renderedFirstIndex, renderedLastIndex, itemCount]);

    // Per-index ref + click callback registry. React's ref protocol
    // fires the OLD callback with `null` and the NEW callback with
    // the element whenever the callback identity changes between
    // renders, even if the element is the same DOM node. Inline
    // arrow functions (`ref={(el) => ...}`) create fresh identities
    // every render and force an unobserve+observe churn cycle on
    // every cell. Caching one stable callback per index keeps
    // identity stable across re-renders so a steady-state window
    // produces zero observer churn.
    //
    // The Map grows with the largest index ever rendered; entries
    // for indices that scroll out are kept (and reused on scroll-
    // back) since the closure cost is small and memoization is the
    // simpler path. A future data-source-shrink-aware pruner can be
    // added if list cardinality ever crosses a threshold where the
    // bookkeeping matters.
    //
    // The click handler reads `delegate?.onSelect` from a ref so
    // consumers swapping delegates between renders don't see lost
    // clicks during the swap, and so the cached closure stays
    // identity-stable while still routing to the current delegate.
    const delegateRef = React.useRef(delegate);
    delegateRef.current = delegate;

    // The click and keydown handlers also read `dataSource.roleForIndex`
    // from a ref so a role transition between render and click is
    // reflected — e.g. a cell that ticks to `"header"` between mount
    // and the user's click does NOT fire `onSelect`, even though the
    // cached click-callback was minted when the role was still
    // `"cell"`. Reading from the live ref also keeps the cached
    // callback identity-stable across data-source identity swaps,
    // mirroring the `delegateRef` pattern above.
    const dataSourceRef = React.useRef(dataSource);
    dataSourceRef.current = dataSource;

    // -----------------------------------------------------------------------
    // Focus engine — the listbox model ([P01]/[P03])
    //
    // When authored into a `focusGroup`, the list is ONE item-container stop:
    // the scroll container registers as the engine focusable (the ring lands on
    // it, never on a row), a movement cursor (`data-key-cursor`) traverses the
    // cell rows under Up/Down/Home/End/Page — scrolling each into view — Space
    // **selects** the cursor row, and Enter **descends** into a row whose content
    // holds navigable focusables (a non-trapped scope; Escape ascends) or else
    // **activates** it. The cursor is appearance-only, projected straight to the
    // DOM with no re-render ([L06]/[L22]); the committed selection is the
    // existing `selectedIndex` / `data-selected` path. Inert (no registration,
    // no cursor) for un-authored / subordinate lists.
    // -----------------------------------------------------------------------
    const manager = useFocusManager();
    const cardId = React.useContext(CardIdContext);
    const focusableId = React.useId();
    const focusEngineActiveRef = React.useRef(focusEngineActive);
    focusEngineActiveRef.current = focusEngineActive;
    // Live `selectedIndex` for the key-view-gain seed (read at subscription
    // fire time, not closure-capture time) [L07].
    const selectedIndexRef = React.useRef<number | null>(null);
    selectedIndexRef.current = selectedIndex;
    // Live single-select props for the gain-seed / movement closures ([L07]).
    const singleSelectRef = React.useRef(singleSelect);
    singleSelectRef.current = singleSelect;
    // Whether a cursor move commits the row it lands on. True for a
    // single-select list by definition, and for a `selectionRequired` list that
    // asked its selection to follow ([L07] live ref, same as the props above).
    const commitOnMoveRef = React.useRef(false);
    commitOnMoveRef.current =
      singleSelect || (selectionRequired && selectionFollowsCursor);
    const initialSelectedIndexRef = React.useRef(initialSelectedIndex);
    initialSelectedIndexRef.current = initialSelectedIndex;
    const seedSelectionRef = React.useRef(seedSelection);
    seedSelectionRef.current = seedSelection;

    // The movement cursor's data index (`-1` = unlanded). A ref, not React
    // state — moving it must not re-render ([L06]).
    const cursorIndexRef = React.useRef<number>(-1);

    // Cursorable-row helpers — the cursor lands only on *enabled* `"cell"`-
    // role rows. Headers / footers are inert dividers (skipped by role);
    // disabled cells are visible-but-unpickable (skipped by enablement). Both
    // exclusions funnel through `isCursorableRow`, so every movement path
    // (Up/Down/Home/End/Page, the key-view gain seed, single-select seeding)
    // inherits the skip without each needing its own filter.
    const roleOfRow = React.useCallback(
      (i: number): TugListViewCellRole =>
        dataSourceRef.current.roleForIndex?.(i) ?? DEFAULT_CELL_ROLE,
      [],
    );
    const isRowEnabled = React.useCallback(
      (i: number): boolean => dataSourceRef.current.enabledForIndex?.(i) ?? true,
      [],
    );
    const isCursorableRow = React.useCallback(
      (i: number): boolean => {
        const total = dataSourceRef.current.numberOfItems();
        return (
          i >= 0 && i < total && roleOfRow(i) === "cell" && isRowEnabled(i)
        );
      },
      [roleOfRow, isRowEnabled],
    );
    const firstCursorableRow = React.useCallback((): number => {
      const total = dataSourceRef.current.numberOfItems();
      for (let i = 0; i < total; i += 1) if (isCursorableRow(i)) return i;
      return -1;
    }, [isCursorableRow]);
    const lastCursorableRow = React.useCallback((): number => {
      const total = dataSourceRef.current.numberOfItems();
      for (let i = total - 1; i >= 0; i -= 1) if (isCursorableRow(i)) return i;
      return -1;
    }, [isCursorableRow]);
    // Step from `from` toward `dir` to the next cursorable row; clamp (no wrap).
    const stepCursorableRow = React.useCallback(
      (from: number, dir: 1 | -1): number => {
        const total = dataSourceRef.current.numberOfItems();
        let i = from + dir;
        while (i >= 0 && i < total) {
          if (isCursorableRow(i)) return i;
          i += dir;
        }
        return isCursorableRow(from) ? from : -1;
      },
      [isCursorableRow],
    );
    // Resolve `target` to the nearest cursorable row, preferring `dir` then the
    // opposite — the snap a Page step lands on.
    const cursorableNear = React.useCallback(
      (target: number, dir: 1 | -1): number => {
        const total = dataSourceRef.current.numberOfItems();
        if (total === 0) return -1;
        const clamped = Math.max(0, Math.min(total - 1, target));
        if (isCursorableRow(clamped)) return clamped;
        const forward = stepCursorableRow(clamped, dir);
        if (forward >= 0) return forward;
        return stepCursorableRow(clamped, dir === 1 ? -1 : 1);
      },
      [isCursorableRow, stepCursorableRow],
    );

    // Project / clear `data-key-cursor` directly onto the rendered cell wrappers
    // ([L06]/[L22]) — mirrors `useFocusCursor`'s projection, but index-keyed off
    // `cellElementMapRef` so it composes with windowing (a cursor row scrolled
    // into view mounts, then the per-commit re-projection effect below stamps it).
    // The bar is a KEYBOARD mark: it paints only while the keyboard is IN this
    // list — holding the key view (`data-key-view-kbd`), or descended into one
    // of its rows, which the engine marks on the container as `data-key-within`.
    // Descending is going deeper into the cursor row, not leaving it, so the bar
    // stays: it is what says which row the accessory under the cursor belongs
    // to. A pointer click parks the cursor index without painting either mark —
    // otherwise a clicked list keeps a bar the kbd-loss clear can never reach
    // (it never held the key view), and a later keyboard entry into a sibling
    // list shows two bars at once.
    /**
     * Tell the consumer where the cursor is, deduped against the last answer.
     * Called from both projection paths so "the cursor is on this row" and
     * "the cursor is painted on this row" are the same statement — including
     * the `null` a list that no longer holds the keyboard must publish, which
     * is what keeps a stale cursor from answering for a list nobody is in.
     */
    const reportCursor = React.useCallback((index: number): void => {
      const id =
        index < 0 ? null : (dataSourceRef.current.idForIndex(index) ?? null);
      if (id === reportedCursorIdRef.current) return;
      reportedCursorIdRef.current = id;
      onCursorChangeRef.current?.(id);
    }, []);
    const projectCursor = React.useCallback((): void => {
      const target = keyboardIsInList(scrollContainerRef.current)
        ? cursorIndexRef.current
        : -1;
      for (const [i, el] of cellElementMapRef.current) {
        if (i === target) el.setAttribute(KEY_CURSOR_ATTRIBUTE, "");
        else el.removeAttribute(KEY_CURSOR_ATTRIBUTE);
      }
      reportCursor(target);
    }, [reportCursor]);
    const clearCursorVisual = React.useCallback((): void => {
      for (const el of cellElementMapRef.current.values()) {
        el.removeAttribute(KEY_CURSOR_ATTRIBUTE);
      }
      reportCursor(-1);
    }, [reportCursor]);

    // ---- The attached-list cursor ([P08]) ----
    // A second, independent highlight for the case where a text field drives
    // this list from its own caret. It has its own index (the movement cursor's
    // belongs to the keyboard, which is elsewhere), its own mark, and none of
    // the movement cursor's gating: `-1` means "no attached cursor", which is
    // the resting state and what a release returns to.
    const attachedCursorIndexRef = React.useRef(-1);
    const projectAttachedCursor = React.useCallback((): void => {
      const target = attachedCursorIndexRef.current;
      for (const [i, el] of cellElementMapRef.current) {
        if (i === target) el.setAttribute(ATTACHED_CURSOR_ATTRIBUTE, "");
        else el.removeAttribute(ATTACHED_CURSOR_ATTRIBUTE);
      }
    }, []);
    const attachedCursorRelease = React.useCallback((): void => {
      if (attachedCursorIndexRef.current === -1) return;
      attachedCursorIndexRef.current = -1;
      projectAttachedCursor();
    }, [projectAttachedCursor]);

    // Bring row `index` into view, reusing the imperative handle's
    // rendered-vs-estimated two-pass logic ([D03]). `nearest` for cursor moves
    // so an already-visible row doesn't jump to the viewport top.
    const scrollIndexIntoView = React.useCallback(
      (index: number, block: ScrollLogicalPosition): void => {
        const total = dataSourceRef.current.numberOfItems();
        if (total === 0) return;
        const ss = smartScrollRef.current;
        if (ss === null) return;
        const clamped = Math.max(0, Math.min(total - 1, Math.floor(index)));
        const renderedEl = cellElementMapRef.current.get(clamped);
        if (renderedEl !== undefined) {
          ss.scrollToElement(renderedEl, { animated: false, block });
          pendingScrollCorrectionRef.current = null;
          return;
        }
        const estimatedTop =
          heightIndexRef.current.offsetForIndex(
            clamped,
            estimatedHeightForKindOnly,
          ) +
          leadingOffsetPx() +
          (rectSpaceRebasePx() ?? 0);
        ss.scrollTo({ top: estimatedTop, animated: false });
        pendingScrollCorrectionRef.current = {
          index: clamped,
          estimatedTop,
          block,
          armedTop: scrollContainerRef.current?.scrollTop ?? estimatedTop,
        };
      },
      [estimatedHeightForKindOnly, leadingOffsetPx, rectSpaceRebasePx],
    );

    // Move the cursor to `index`, project it, and optionally scroll it in.
    const moveCursorTo = React.useCallback(
      (index: number, scroll: boolean): void => {
        if (index < 0) return;
        cursorIndexRef.current = index;
        projectCursor();
        if (scroll) scrollIndexIntoView(index, "nearest");
      },
      [projectCursor, scrollIndexIntoView],
    );

    const attachedCursorMove = React.useCallback(
      (direction: "up" | "down"): boolean => {
        const dir = direction === "down" ? 1 : -1;
        const from = attachedCursorIndexRef.current;
        // A fresh attached cursor SEEDS rather than steps, and a ↓ seed runs
        // the same preference ladder the movement cursor's key-view seed does:
        // the surface-supplied active row (`initialSelectedIndex`), then the
        // list's own selection, then the first cursorable row. The picker is
        // why the ladder matters here too — arrowing out of a non-empty filter
        // must highlight the first MATCH, not whatever row happens to render
        // first ("New session").
        let next: number;
        if (from === -1) {
          if (dir === 1) {
            const preferred = isCursorableRow(
              initialSelectedIndexRef.current ?? -1,
            )
              ? (initialSelectedIndexRef.current as number)
              : (selectedIndexRef.current ?? -1);
            next = isCursorableRow(preferred)
              ? preferred
              : cursorableNear(0, 1);
          } else {
            next = cursorableNear(
              dataSourceRef.current.numberOfItems() - 1,
              -1,
            );
          }
        } else {
          next = stepCursorableRow(from, dir);
        }
        if (next < 0 || next === from) return false;
        attachedCursorIndexRef.current = next;
        projectAttachedCursor();
        scrollIndexIntoView(next, "nearest");
        return true;
      },
      [
        cursorableNear,
        stepCursorableRow,
        isCursorableRow,
        projectAttachedCursor,
        scrollIndexIntoView,
      ],
    );

    // The engine focusable id carried by the cursor row's first inner focusable,
    // or `null` when the row holds none — Enter descends only when present.
    const rowFirstFocusableId = React.useCallback((i: number): string | null => {
      const el = cellElementMapRef.current.get(i);
      const inner = el?.querySelector("[data-tug-focusable]") ?? null;
      return inner?.getAttribute("data-tug-focusable") ?? null;
    }, []);
    // Every engine focusable the row holds, in DOM order — the run the
    // horizontal arrows walk once the key view has descended into the row.
    const rowFocusableIds = React.useCallback((i: number): string[] => {
      const el = cellElementMapRef.current.get(i);
      if (el === undefined) return [];
      return Array.from(el.querySelectorAll("[data-tug-focusable]"))
        .map((n) => n.getAttribute("data-tug-focusable"))
        .filter((id): id is string => id !== null);
    }, []);
    const rowScopeId = React.useCallback(
      (i: number): string => `${focusableId}-row-${i}`,
      [focusableId],
    );

    // The active descend record: which row (by stable data-source id) the
    // key view is descended into, and the scope it pushed. Written by
    // `descendCursorRow`, consumed and cleared by the deletion-landing
    // reconciliation below.
    const descendedRowRef = React.useRef<{
      id: string;
      scopeId: string;
      index: number;
    } | null>(null);

    // Space / Enter-act: commit selection on the cursor row (`data-selected`)
    // and fire `delegate.onSelect`. Enter-descend: push the row's non-trapped
    // scope and land the key view on its first inner focusable.
    const selectCursorRow = React.useCallback((): void => {
      const i = cursorIndexRef.current;
      if (!isCursorableRow(i)) return;
      setSelectedIndex(i);
      delegateRef.current?.onSelect?.(i);
      scrollIndexIntoView(i, "nearest");
    }, [isCursorableRow, scrollIndexIntoView]);

    /**
     * What SPACE does — which is not what a click does, on a multi-select list.
     *
     * Space TOGGLES the cursor row's membership and stops there. It does not
     * reach `delegate.onSelect`, which is the click's callback and means
     * "select this and open it": a list where Space and Return both act has no
     * key that names a row without also opening it, and naming rows a verb will
     * act on later is the whole purpose of a selection.
     *
     * Toggle rather than replace, because replace would leave the keyboard
     * unable to build a set at all — ⌘+arrow walks the cursor past rows without
     * disturbing the selection precisely so Space can pick up the ones the walk
     * stops on. With nothing selected the two readings coincide, which is the
     * common case and reads simply as "select this row".
     *
     * A row the consumer declines (a group header) falls through to the
     * ordinary commit path, so Space there still folds its group.
     */
    const spaceCursorRow = React.useCallback((): void => {
      const i = cursorIndexRef.current;
      if (!isCursorableRow(i)) return;
      if (commitMultiSelectRef.current(i, "toggle") !== null) {
        scrollIndexIntoView(i, "nearest");
        return;
      }
      selectCursorRow();
    }, [isCursorableRow, scrollIndexIntoView, selectCursorRow]);
    // The attached filter ([L07] live ref): the binding is read at keystroke
    // time, so a field mounting after this list (a sheet's lead control, a
    // collapsed section's band) is reachable the moment it arrives.
    const attachedFilterRef = React.useRef<AttachedFilterBinding | undefined>(
      undefined,
    );
    attachedFilterRef.current = attachedFilter;

    // ---- Type-select: the shadowed half of the attached-list contract ([P08]) ----
    //
    // A printable key nothing else claimed is a request to FILTER, so it is
    // shadowed into the attached field — and the list keeps the keyboard. That
    // is the whole point of the gesture: typing is how the user finds a row,
    // so `Return` must still reach the cursored row and ↑/↓ must still move it.
    // Handing the caret to the field instead narrows correctly and then
    // strands the user behind a Tab, which is the bug this replaced.
    //
    // After the query changes the row set is different, so the cursor is
    // re-seeded onto the first match — the same preference ladder the attached
    // cursor's seed runs (`initialSelectedIndex`, else the first cursorable
    // row), which for the picker is what skips "New session" and lands on a
    // real result. The re-seed waits for the render the query causes: the rows
    // this reads do not exist yet at keystroke time.
    //
    // It re-commits even when the index did not move, and that is the whole
    // subtlety: an index is not a row. Narrowing "g" to "ga" can leave the
    // first match at index 1 while the SESSION at index 1 changes underneath
    // it, so an identity check on the number alone skips the commit and leaves
    // the surface's selection naming a row the query just hid. In the picker
    // that row is then invalidated and the selection snaps back to "New
    // session" — the cursor bar sitting on the match while `Return` opens an
    // empty session, which is exactly the bug type-select exists to prevent.
    // Re-committing the CURRENT row at the cursor is cheap and always true.
    const pendingReseedRef = React.useRef(false);
    const reseedCursorToFirstMatch = React.useCallback((): void => {
      const preferred = isCursorableRow(initialSelectedIndexRef.current ?? -1)
        ? (initialSelectedIndexRef.current as number)
        : cursorableNear(0, 1);
      if (preferred < 0) return;
      moveCursorTo(preferred, true);
      if (commitOnMoveRef.current) selectCursorRowRef.current();
    }, [isCursorableRow, cursorableNear, moveCursorTo]);
    // `selectCursorRow` is declared above but the reseed runs from an effect a
    // render later, so it reads through a ref rather than closing over the
    // identity this render happened to have ([L07]).
    const selectCursorRowRef = React.useRef(selectCursorRow);
    selectCursorRowRef.current = selectCursorRow;
    React.useEffect(() => {
      if (!pendingReseedRef.current) return;
      pendingReseedRef.current = false;
      reseedCursorToFirstMatch();
    });

    /**
     * Shadow `event` into the attached filter. Returns whether it was consumed.
     *
     * Chained LAST in the key-view behavior — after the list's own movement
     * keys and after the consumer's `onKeyViewKey` — so a list's single-key
     * verbs win by construction rather than by an exclusion list here (Jots
     * keeps Space for *new jot* and Backspace for *delete jot*), and any verb a
     * list grows later is safe for free.
     */
    const shadowKeyIntoFilter = React.useCallback(
      (event: KeyboardEvent): boolean => {
        const field = attachedFilterRef.current?.field() ?? null;
        if (field === null) return false;
        if (event.metaKey || event.ctrlKey || event.altKey) return false;
        if (event.isComposing) return false;
        // Space is the list's commit, and a query cannot usefully OPEN with
        // one — but once a query exists a space is an ordinary character in it,
        // which is what lets a multi-word title be typed straight through.
        // (`Spacebar` is the legacy key name the act dispatch also honors.)
        const key = event.key === "Spacebar" ? " " : event.key;
        const printable = key.length === 1 && (key !== " " || field.hasQuery());
        if (printable) {
          field.appendChar(key);
        } else if (key === "Backspace") {
          if (!field.deleteBackward()) return false;
        } else if (key === "Escape") {
          // Escape drops the query and the list keeps the keyboard, so the
          // ladder above it (dismiss the sheet, collapse the section) is only
          // reached once there is no query left to clear — the same courtesy
          // the field extends when the caret is inside it.
          if (!field.clearQuery()) return false;
        } else {
          return false;
        }
        pendingReseedRef.current = true;
        return true;
      },
      [],
    );

    // Enter/act on the cursor row, the `commitOnEnter: "act"` path. Commits the
    // list's own selection (so `data-selected` lands before the consumer reads
    // it) then fires `delegate.onActivate` — the DISTINCT Enter callback, not
    // Space's `onSelect`. A list that opts in but supplies no `onActivate` still
    // commits its selection (the no-op fallback).
    const actCursorRow = React.useCallback((): void => {
      const i = cursorIndexRef.current;
      if (!isCursorableRow(i)) return;
      setSelectedIndex(i);
      delegateRef.current?.onActivate?.(i);
      scrollIndexIntoView(i, "nearest");
    }, [isCursorableRow, scrollIndexIntoView]);
    /**
     * Descend into row `index` and land on its `ordinal`-th accessory, clamped
     * to what that row actually holds. The ordinal is what lets the vertical
     * arrows carry the keyboard DOWN a column of accessories — row 3's close
     * box from row 2's — instead of ejecting it back to the container on every
     * step. A row with no focusable accessory is not descendable and this is a
     * no-op.
     */
    const descendRowAt = React.useCallback(
      (index: number, ordinal: number): void => {
        if (manager === null) return;
        const ids = rowFocusableIds(index);
        if (ids.length === 0) return;
        const pick = ids[Math.min(Math.max(ordinal, 0), ids.length - 1)];
        // Record the descend by the row's STABLE data-source id (not its
        // index), so the reconciliation below can tell "this row was
        // deleted" apart from "this row scrolled out of the render
        // window" — only deletion may ascend the scope out from under
        // the user.
        descendedRowRef.current = {
          id: dataSourceRef.current.idForIndex(index),
          scopeId: rowScopeId(index),
          index,
        };
        manager.pushFocusMode(rowScopeId(index), { trapped: false });
        manager.place(null, { kind: "focusable", id: pick }, {
          modality: "keyboard",
        });
      },
      [manager, rowFocusableIds, rowScopeId],
    );
    const descendCursorRow = React.useCallback((): void => {
      const i = cursorIndexRef.current;
      if (rowFirstFocusableId(i) === null) {
        selectCursorRow();
        return;
      }
      descendRowAt(i, 0);
    }, [rowFirstFocusableId, selectCursorRow, descendRowAt]);

    // Populate the imperative `descendIntoRow` entry now that the cursor /
    // descend callbacks exist. Refreshed every render (like `cursorNavRef`
    // below) so the handle always runs the current closures. A row with no
    // inner focusable is a pure no-op — nothing to descend into.
    descendIntoRowRef.current = (index: number): void => {
      if (rowFirstFocusableId(index) === null) return;
      // Descending into a row to edit it MAKES it the selection: in
      // `selectionRequired` mode the owned selected row moves to the edited
      // row, so a create-and-open path (the header +, Space, ⌘Return chain)
      // can't leave the previous selection painting its fill while a
      // different row is open — exactly one row ever wears the picker green.
      if (selectionRequiredRef.current) setSelectedIndex(index);
      moveCursorTo(index, true);
      descendCursorRow();
    };
    moveCursorToRef.current = (index: number): void => {
      if (!focusEngineActiveRef.current) return;
      const landing = cursorableNear(index, -1);
      if (landing >= 0) moveCursorTo(landing, true);
    };
    attachedCursorMoveRef.current = attachedCursorMove;
    attachedCursorIndexReadRef.current = (): number =>
      attachedCursorIndexRef.current;
    attachedCursorReleaseRef.current = attachedCursorRelease;

    // ---- Descended-row deletion landing ----
    //
    // While the key view is descended into a row scope, the row's own
    // action can delete the row (the picker's trash → confirm flow).
    // That unmounts the descended focusable and would strand the
    // keyboard on a dead scope. The reconciliation here ascends the
    // scope and lands the cursor on the nearest surviving cursorable
    // row (committing it in single-select, where selection follows the
    // cursor).
    //
    // It runs on BOTH triggers — every commit (data-source ticks
    // re-render the list) and engine mode-stack changes — and acts only
    // when the recorded row scope is the TOP mode. With a surface (the
    // confirm popover) still above the row scope it defers; the
    // mode-stack subscription re-runs it after that surface pops, so
    // the landing is the final focus writer in every pop ordering.
    const reconcileDescendedRow = React.useCallback((): void => {
      const rec = descendedRowRef.current;
      if (rec === null || manager === null) return;
      if (manager.currentFocusMode() !== rec.scopeId) {
        // Not ours on top. Fully popped (a normal Escape/Left ascend)
        // → the descend is over, drop the record. Still pushed but
        // buried (popover above) → keep it and wait for the next
        // mode-stack change.
        if (!manager.isFocusModePushed(rec.scopeId)) {
          descendedRowRef.current = null;
        }
        return;
      }
      const ds = dataSourceRef.current;
      const total = ds.numberOfItems();
      let alive = false;
      for (let i = 0; i < total; i += 1) {
        if (ds.idForIndex(i) === rec.id) {
          alive = true;
          break;
        }
      }
      if (alive) return;
      // The descended row was deleted: ascend back to the container
      // (restores key view + ring) and land the cursor on the nearest
      // surviving cursorable row. An emptied list keeps the container
      // key view with no cursor.
      descendedRowRef.current = null;
      manager.ascend();
      const landing = total > 0 ? cursorableNear(rec.index, -1) : -1;
      if (landing >= 0) {
        moveCursorTo(landing, true);
        if (commitOnMoveRef.current) selectCursorRow();
      } else {
        cursorIndexRef.current = -1;
        clearCursorVisual();
      }
    }, [
      manager,
      cursorableNear,
      moveCursorTo,
      selectCursorRow,
      clearCursorVisual,
    ]);
    // ---- The descend record is DERIVED from the mode stack ----
    //
    // A descend is held in two places: the engine's focus-mode stack, and
    // `descendedRowRef` — which row, by stable id, and at what index. Every
    // arrow the row scope owns reads the REF (`rowFocusableIds(rec.index)`,
    // `stepCursorableRow(rec.index, …)`), so the two disagreeing is not a
    // cosmetic drift: with the mode pushed and the ref null, ArrowLeft reads an
    // empty accessory list, computes `next < 0`, and ASCENDS out of the row,
    // while Right and the vertical pair find nothing to step from and die
    // quietly. The keyboard looks right and answers wrong.
    //
    // They come apart because `reconcileDescendedRow` decides the descend is
    // over by asking `currentFocusMode()` / `isFocusModePushed()`, and both
    // delegate to the manager's ACTIVE context. Assigning a slot hands
    // activation to the slotted card, so for as long as the Lens is in the
    // background those two answer about a different card's stack entirely —
    // base mode, nothing pushed — and the record is dropped as though the user
    // had escaped out of the row. The Lens's own stack still holds the scope,
    // which is exactly the state ⌘L comes back to.
    //
    // So the ref is treated as derived rather than authoritative: whenever our
    // row scope is the current mode and the record does not match it, the
    // record is rebuilt from the mode. That makes the split self-healing
    // whatever caused it — a context switch, a reload, a bag restore — instead
    // of enumerating the ways it can happen.
    //
    // The second branch is for the other direction, where the mode is gone but
    // the keyboard is sitting on one of our row's accessories. That one has to
    // replay the descend properly rather than just push a mode, because a
    // pushed mode records `restoreKeyView` — the key view AT THE MOMENT of the
    // push — and both `ascend()` and `dispatchKeyToKeyView`'s descended-scope
    // fallback (the only reason an arrow reaches this list while an accessory
    // holds the key view; it runs `top.restoreKeyView !== keyViewId` first)
    // read it. Pushing while the accessory already holds the key view points
    // both records at the accessory and the fallback stops delegating.
    const syncDescendRecordToMode = React.useCallback((): void => {
      if (manager === null) return;
      const prefix = `${focusableId}-row-`;
      const mode = manager.currentFocusMode();

      if (mode.startsWith(prefix)) {
        if (descendedRowRef.current?.scopeId === mode) return;
        const index = Number(mode.slice(prefix.length));
        if (!Number.isInteger(index)) return;
        descendedRowRef.current = {
          id: dataSourceRef.current.idForIndex(index),
          scopeId: mode,
          index,
        };
        // The cursor bar is the row's half of saying where the keyboard is, and
        // it is cleared by the same context switch. No reveal: this is
        // bookkeeping about where the keyboard already is, and a scroll is a
        // change nobody asked for.
        moveCursorTo(index, false);
        return;
      }

      if (descendedRowRef.current !== null) return;
      // Only adopt a key view that is in OUR scope. A surface rendered inside a
      // row can push its own mode and seed its own key view — a card-modal
      // inline dialog (the PermissionDialog seeding Allow). That keyboard
      // belongs to the surface, and adopting it would push a row scope OVER the
      // surface's trap, taking the top of the mode stack away from it: its
      // declared arrow plane and its Tab walk both key off the top mode, so
      // both would go dead. The list being a member of the current mode is what
      // "the keyboard is in our scope" means — true at base and true for a list
      // inside a sheet (it registered into that trap), false when a nested
      // surface owns the mode.
      if (!manager.currentModeMember(focusableId)) return;
      const keyView = manager.keyView();
      if (keyView === null) return;
      const scrollEl = scrollContainerRef.current;
      if (scrollEl === null) return;
      const el = scrollEl.querySelector<HTMLElement>(
        `[data-tug-focusable="${CSS.escape(keyView)}"]`,
      );
      if (el === null) return;
      const cell = el.closest<HTMLElement>(".tug-list-view-cell");
      const attr = cell?.getAttribute("data-tug-list-cell-index");
      if (attr === null || attr === undefined) return;
      const index = Number(attr);
      if (!Number.isInteger(index)) return;
      // The row has to be OURS. A list rendered inside another list's row
      // answers the DOM query above with its own cell and its own index.
      // `rowFocusableIds` reads this list's own cell map, so agreeing with it
      // is the ownership check.
      const ordinal = rowFocusableIds(index).indexOf(keyView);
      if (ordinal < 0) return;
      moveCursorTo(index, false);
      manager.place(null, { kind: "focusable", id: focusableId }, {
        modality: "keyboard",
      });
      descendRowAt(index, ordinal);
    }, [manager, focusableId, rowFocusableIds, moveCursorTo, descendRowAt]);

    React.useLayoutEffect(() => {
      if (manager === null || !focusEngineActive) return;
      return manager.subscribe(() => {
        reconcileDescendedRow();
        syncDescendRecordToMode();
      });
    }, [
      manager,
      focusEngineActive,
      reconcileDescendedRow,
      syncDescendRecordToMode,
    ]);
    React.useLayoutEffect(() => {
      // Per-commit pass: a data-source tick that removed the descended
      // row re-renders the list, and this catches it. Near-zero cost
      // when nothing is descended.
      reconcileDescendedRow();
      // ...and re-derive the record from the mode in the same pass. A
      // reactivation arrives with the card's own commit, which is often before
      // any engine notification this list is subscribed to.
      syncDescendRecordToMode();
    });

    // The thin declaration the engine's act dispatch reads at Space/Enter/Escape
    // ([P01]) — `currentItemDescendable` is evaluated live against the cursor row.
    // `commitOnEnter: "act"` only applies to a non-single-select, authored list
    // (the multi-select item-group shape); a single-select list owns Enter as
    // passthrough (Right descends), so the opt-in is suppressed there.
    const enterActs = commitOnEnter === "act" && !singleSelect;
    // Keys the consumer reserves for its own handling ([P04] captures). While
    // the container holds the key view, the engine's act-dispatch yields these
    // to the DOM (they bubble to the consumer's own keydown) instead of
    // resolving them to select/act. The Jots list reserves Space so it can
    // mean "new jot below the cursor" (a Things-style gesture) rather than
    // the default item-container select.
    const captureKeySet = React.useMemo(
      () => (captureKeys !== undefined ? new Set(captureKeys) : null),
      [captureKeys],
    );
    // Live ref for the movement-key delegate defined below ([L07]): the
    // behavior thunk must be stable while the delegate always runs current
    // closures. Assigned every render where `handleListKey` is defined.
    const handleListKeyRef = React.useRef<(e: KeyboardEvent) => boolean>(
      () => false,
    );
    // Consumer key delegate ([L07] live ref): tried after the list's own
    // movement keys decline. See the `onKeyViewKey` prop.
    const onKeyViewKeyRef = React.useRef<
      ((e: KeyboardEvent) => boolean) | undefined
    >(undefined);
    onKeyViewKeyRef.current = onKeyViewKey;
    // Type-select delegate ([L07] live ref), tried after both of the above.
    const shadowKeyIntoFilterRef = React.useRef(shadowKeyIntoFilter);
    shadowKeyIntoFilterRef.current = shadowKeyIntoFilter;
    const behavior = React.useCallback(
      (): KeyViewBehavior => ({
        container: "item",
        commit:
          singleSelect || (selectionRequired && selectionFollowsCursor)
            ? "live"
            : "deferred",
        // Escape and Space are claimed only while the attached filter holds a
        // query ([P08] type-select) — otherwise the act dispatch resolves them
        // first and this delegate never sees them.
        //
        // **Escape**: the ladder above it (dismiss the sheet, fold the section)
        // must stay reachable the moment there is nothing left to clear, which
        // is the same courtesy the field extends when the caret is inside it.
        // **Space**: mid-query it is a character, so a multi-word title types
        // straight through; with no query it keeps its commit meaning, which is
        // why a query can never OPEN with one. A list that reserves Space for a
        // verb of its own (`captureKeys`, Jots' *new jot*) still wins — its
        // `onKeyViewKey` runs ahead of the shadow.
        //
        // An empty or absent filter claims neither, so a list without one
        // behaves exactly as it always did.
        //
        // **Escape, again**: a standing multi-selection claims it too, on the
        // same terms. The ladder's rungs are all reasons to spend Escape on
        // something the user cannot see going away — leaving the keyboard mode,
        // popping a cycle — and every one of them sits ABOVE the chain's
        // `CANCEL_DIALOG` dispatch, which is the only rung a consumer can reach.
        // So a selection made with the keyboard was cleared by Escape and one
        // made with the mouse was not, for no reason the user could name. The
        // capture is the fix: while there is a set, Escape is the list's.
        captures: (k: FocusKey) =>
          (captureKeySet?.has(k.key) ?? false) ||
          (k.key === "Escape" && multiSelectSetStands()) ||
          ((k.key === "Escape" || k.key === " " || k.key === "Spacebar") &&
            (attachedFilterRef.current?.field()?.hasQuery() ?? false)),
        // A single-select list keeps select-on-arrow (the cursor IS the selection —
        // a 7.5 picker idiom, intentionally excluded from the [P24] reversion):
        // `commit: "live"` moves the selection with the cursor, and a single-select
        // list never descends on ENTER (Right is its descend gesture, handled in
        // the movement-key listener), so Enter resolves to passthrough and reaches
        // the surface default. A multi/descendable list moves a cursor only; Enter
        // descends a navigable row, else (when `commitOnEnter: "act"`) acts on the
        // cursor row via `onAct`, else bubbles to the scope default ([P24]).
        // `commitOnEnter: "act"` is the author saying what Enter means on THIS
        // list, so it outranks the descend default: the Jotss list opens
        // the jot on Enter, and adding a focusable accessory to its rows
        // must not quietly turn Enter into "descend onto the copy button".
        // Right still descends (the movement-key listener and the cursor
        // handle's `tryDescendRight` read the row's focusables directly), so the
        // accessory stays reachable.
        currentItemDescendable:
          !singleSelect &&
          !enterActs &&
          rowFirstFocusableId(cursorIndexRef.current) !== null,
        commitOnEnter: enterActs ? "act" : undefined,
        onSelect: spaceCursorRow,
        onAct: enterActs ? actCursorRow : selectCursorRow,
        onDescend: descendCursorRow,
        // Chained last on purpose: the list's movement keys, then the
        // consumer's verbs, then type-select. Only a key nothing else wanted
        // reaches the filter ([P08]).
        onKey: (e: KeyboardEvent) =>
          handleListKeyRef.current(e) ||
          (onKeyViewKeyRef.current?.(e) ?? false) ||
          shadowKeyIntoFilterRef.current(e),
      }),
      [
        singleSelect,
        selectionRequired,
        selectionFollowsCursor,
        enterActs,
        captureKeySet,
        rowFirstFocusableId,
        selectCursorRow,
        spaceCursorRow,
        actCursorRow,
        descendCursorRow,
      ],
    );

    // Register the scroll container as the single item-container stop. The
    // returned ref is stamped onto the container by `setScrollContainerRef`
    // (above) via `engineFocusableRef`. `register: false` for un-authored /
    // subordinate lists leaves the container a plain native stop.
    const { focusableRef: engineFocusable } = useFocusable({
      id: focusableId,
      group: focusGroup ?? "",
      order: focusOrder,
      policy: focusPolicy,
      register: focusEngineActive,
      behavior,
    });
    engineFocusableRef.current = engineFocusable;

    // Spatial-cursor handle ([P22] / [Q12]). When this list is authored into a
    // `focusGroup`, the spatial navigator drives in-group arrows through this
    // handle — roving the movement cursor over the rows — instead of moving the
    // ring off to an adjacent grid node. Without it, a list that is also a node in
    // a declared spatial order would lose its arrows to ring movement (the bug the
    // radio group avoids via `use-item-group-keyboard`). The navigator reads
    // `length` / `cursorIndex` to detect the group's edges (where Up/Down then
    // cross a seam) and calls `moveCursor` for an interior step. Both indices are
    // expressed over the *cursorable* rows so a header/footer between cells doesn't
    // skew the edge math. The handle reads its callbacks through a live ref so it
    // can register once yet always run the current closures ([L07]).
    const cursorNavRef = React.useRef({
      isCursorableRow,
      firstCursorableRow,
      lastCursorableRow,
      stepCursorableRow,
      moveCursorTo,
      selectCursorRow,
      rowFirstFocusableId,
      descendCursorRow,
    });
    cursorNavRef.current = {
      isCursorableRow,
      firstCursorableRow,
      lastCursorableRow,
      stepCursorableRow,
      moveCursorTo,
      selectCursorRow,
      rowFirstFocusableId,
      descendCursorRow,
    };
    // The spatial navigator's view of this list ([P22] / [Q12]): the ring rests on
    // the list as ONE node while an in-group arrow roves the movement cursor over
    // the rows, and only an arrow off the cursor's edge crosses onward — to a
    // declared seam where the author drew one, else to the liveliness net, which
    // carries the ring into whatever the walk order puts after this list ([P01]).
    // That is why the handle is unconditional: the edges are what make the list
    // traversable at all, and every engine-authored list wants them.
    //
    // Vertical axis only ([P12]). A list is one column, which the resolver would
    // otherwise read as a 1-D run where ANY arrow steps the cursor — making
    // ArrowLeft mean "cursor up" on every full-width list in the app. Horizontal
    // arrows instead fall through to seam / ring / net. (ArrowRight still descends
    // into a row's accessories first: `tryDescendRight` is consulted ahead of any
    // movement.)
    const cursorHandleRef = React.useRef<SpatialCursorHandle | null>(null);
    if (cursorHandleRef.current === null) {
      cursorHandleRef.current = {
        axis: "vertical",
        length: () => {
          const total = dataSourceRef.current.numberOfItems();
          const { isCursorableRow: cursorable } = cursorNavRef.current;
          let n = 0;
          for (let i = 0; i < total; i += 1) if (cursorable(i)) n += 1;
          return n;
        },
        cursorIndex: () => {
          const cur = cursorIndexRef.current;
          if (cur < 0) return -1;
          const total = dataSourceRef.current.numberOfItems();
          const { isCursorableRow: cursorable } = cursorNavRef.current;
          let pos = -1;
          for (let i = 0; i <= cur && i < total; i += 1) if (cursorable(i)) pos += 1;
          return pos;
        },
        moveCursor: (delta) => {
          const nav = cursorNavRef.current;
          const cur = cursorIndexRef.current;
          // A list is one column, so it declares no `columns` and the resolver
          // only ever hands it a single step — the sign is all there is to read.
          const dir: 1 | -1 = delta > 0 ? 1 : -1;
          const next =
            cur < 0
              ? dir > 0
                ? nav.firstCursorableRow()
                : nav.lastCursorableRow()
              : nav.stepCursorableRow(cur, dir);
          if (next >= 0 && next !== cur) {
            nav.moveCursorTo(next, true);
            // Selection follows the cursor (the picker shape).
            if (commitOnMoveRef.current) nav.selectCursorRow();
          }
        },
        tryDescendRight: () => {
          const nav = cursorNavRef.current;
          if (nav.rowFirstFocusableId(cursorIndexRef.current) !== null) {
            nav.descendCursorRow();
            return true;
          }
          return false;
        },
      };
    }
    React.useLayoutEffect(() => {
      if (manager === null || !focusEngineActive) return;
      const ctx = manager.contextFor(cardId);
      ctx.registerCursorHandle(focusableId, cursorHandleRef.current!);
      return () => ctx.unregisterCursorHandle(focusableId);
    }, [manager, cardId, focusableId, focusEngineActive]);

    // Land / clear the cursor as the container gains or loses the keyboard key
    // view. On gain, seed the cursor on the selected row (else the first
    // cursorable row) only when unlanded — so a descend → ascend round-trip
    // preserves the cursor position. On loss, drop the visual but keep the index.
    const wasKbdRef = React.useRef(false);
    React.useLayoutEffect(() => {
      if (manager === null || !focusEngineActive) return;
      const onChange = (): void => {
        const el = scrollContainerRef.current;
        if (el === null) return;
        // "In the list" rather than "holds the key view", so a descend into a
        // row is not a loss: the cursor keeps its place AND its bar, and the
        // ascend back out is not a re-entry that re-seeds it.
        const kbd = keyboardIsInList(el);
        if (kbd && !wasKbdRef.current) {
          if (cursorIndexRef.current < 0) {
            // Seed the cursor on the active row. The surface-supplied active row
            // (`initialSelectedIndex`) wins when given — for ANY list, not just
            // single-select — so a consumer whose selection lives outside the list
            // (the question wizard, whose options carry consumer-owned selection)
            // can land the cursor on the chosen row; the list then falls back to
            // its own selection, then the first cursorable row. The seed is
            // cursor-only by default — selection follows explicit arrow movement,
            // so merely cycling the key view onto a list never commits a row (a
            // recents list must not clobber a typed path on focus). A surface whose
            // list IS the opening default (`seedSelection`, single-select only)
            // commits the seeded row so it opens with exactly one selected row (a
            // pick-first picker that enables its default action on open).
            const preferred = isCursorableRow(initialSelectedIndexRef.current ?? -1)
              ? (initialSelectedIndexRef.current as number)
              : (selectedIndexRef.current ?? -1);
            const seed = isCursorableRow(preferred) ? preferred : firstCursorableRow();
            if (seed >= 0) {
              moveCursorTo(seed, true);
              if (singleSelectRef.current && seedSelectionRef.current) {
                selectCursorRow();
              }
            }
          } else {
            projectCursor();
          }
        } else if (!kbd && wasKbdRef.current) {
          clearCursorVisual();
        }
        wasKbdRef.current = kbd;
      };
      const unsubscribe = manager.subscribe(onChange);
      onChange();
      return unsubscribe;
    }, [
      manager,
      focusEngineActive,
      isCursorableRow,
      firstCursorableRow,
      moveCursorTo,
      projectCursor,
      clearCursorVisual,
      selectCursorRow,
    ]);

    // Re-project the cursor every commit while the container holds the key view,
    // so a row that mounts as the cursor scrolls into view picks up
    // `data-key-cursor` on the next paint — and clear any stale bar when it
    // does not (the projection is keyboard-gated; a bar left behind by a state
    // the clear paths missed self-heals on the next commit).
    React.useLayoutEffect(() => {
      if (!focusEngineActive) return;
      const el = scrollContainerRef.current;
      if (el === null) return;
      // A data-source mutation can shift rows under the cursor so its index now
      // points at a header / footer / disabled row (e.g. opening a recent file
      // removes it, sliding the "Recent" divider under the caret). Snap the
      // cursor back onto the nearest cursorable cell before projecting, so the
      // bar never lands on an inert divider.
      const cur = cursorIndexRef.current;
      if (cur >= 0 && !isCursorableRow(cur)) {
        cursorIndexRef.current = cursorableNear(cur, -1);
      }
      if (keyboardIsInList(el) && cursorIndexRef.current >= 0) {
        projectCursor();
      } else {
        clearCursorVisual();
      }
      // The attached-list cursor rides the same per-commit re-projection, so a
      // row that windows in (or shifts index as the filter narrows) keeps its
      // highlight. Its own gate is only "is there one" — the keyboard is in the
      // field, never in this list ([P08]).
      if (attachedCursorIndexRef.current >= 0) projectAttachedCursor();
    });

    // Movement keys — delivered through the engine's key-view delegation
    // channel (behavior `onKey`, [P05]/Spec S04) instead of an element
    // keydown listener: in engine-routed mode keydown never enters this
    // subtree, so element delivery is structurally dead. The engine invokes
    // `onKey` when this list is the key view — and, via the descended-scope
    // fallback, when the key view is an in-row focusable of one of THIS
    // list's row scopes (the ArrowLeft-ascend case). Arrows / Home / End
    // move one row; Page moves a viewport of rows and snaps to the nearest
    // cursorable row. Space / Enter / Escape are NOT handled here — the
    // engine's act dispatch owns them. Read through a live ref so the
    // behavior thunk stays stable while always running current closures
    // ([L07], same pattern as the cursor handle).
    const handleListKey = (e: KeyboardEvent): boolean => {
      // ⌘ + a movement key is a SELECTION gesture on a multi-select list —
      // walk the cursor without disturbing the set, the discontiguous half of
      // the model whose other half is Space. Everywhere else ⌘ still means a
      // chord and the list keeps its hands off it. (⌃ always does.)
      const metaSelects =
        e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        multiSelectRef.current !== undefined &&
        (e.key === "ArrowUp" ||
          e.key === "ArrowDown" ||
          e.key === "Home" ||
          e.key === "End");
      if ((e.metaKey && !metaSelects) || e.ctrlKey) return false;
      // Escape drops the selection before anything above it on the ladder gets
      // a turn. A standing selection is the nearest thing a list has to an open
      // modal state, and the answer to "how do I take it back" must not depend
      // on how it was made — the `captures` predicate claims Escape for exactly
      // as long as there is a set to clear, so the rungs beyond it (leave the
      // keyboard mode, fold the section, dismiss the sheet) are reached the
      // moment there is not. An attached filter's query is more local still and
      // keeps its own first Escape.
      if (e.key === "Escape") {
        const ms = multiSelectRef.current;
        if (ms === undefined || !multiSelectSetStands()) return false;
        if (attachedFilterRef.current?.field()?.hasQuery() === true) {
          return false;
        }
        return ms.onClear();
      }
      const scrollEl = scrollContainerRef.current;
      if (scrollEl === null) return false;
      if (e.key.startsWith("Arrow")) {
        tugDevLogStore.debug("list-view", "onKey reached the list", {
          list: focusableId,
          key: e.key,
          mode: manager?.currentFocusMode() ?? null,
          keyView: manager?.keyView() ?? null,
          containerIsKeyView: scrollEl.hasAttribute("data-key-view-kbd"),
          descendedIndex: descendedRowRef.current?.index ?? null,
        });
      }
      // While descended into one of THIS list's row scopes (the container is no
      // longer the key view; the key view is an in-row focusable), the
      // horizontal arrows walk the row itself: Right steps to the next
      // accessory, Left to the previous, and Left off the first ASCENDS — the
      // symmetric exit to Right's descend. A row is a run of buttons laid out
      // left to right, so the arrow that entered it is the arrow that walks it;
      // Tab walks the same run (the row scope is the walk's bound), and either
      // plane reaches every accessory. The spatial navigator provably yields
      // these arrows in a row scope (no declared order, no cursor handle), so
      // this delegate is their owner. Gated on the TOP mode being one of our row
      // scopes: with a popover or other surface above it, the arrows belong to
      // that surface, not the list.
      const inRowScope =
        manager !== null &&
        !scrollEl.hasAttribute("data-key-view-kbd") &&
        manager.currentFocusMode().startsWith(`${focusableId}-row-`);
      if (
        inRowScope &&
        manager !== null &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        const ids = rowFocusableIds(descendedRowRef.current?.index ?? -1);
        const at = ids.indexOf(manager.keyView() ?? "");
        const next = at + (e.key === "ArrowRight" ? 1 : -1);
        if (next < 0) {
          manager.ascend();
        } else if (at >= 0 && next < ids.length) {
          manager.place(null, { kind: "focusable", id: ids[next] }, {
            modality: "keyboard",
          });
        }
        // Off the last accessory the key view stays where it is: there is
        // nothing further right in the row, and the list's own cursor is not
        // what Right means from inside a row.
        return true;
      }
      // The vertical arrows while descended: step to the SAME accessory in the
      // adjacent row. A row is a position in a list, not a room the keyboard
      // gets shut into — running down a column of close boxes is the gesture a
      // user reaches for, and dead-ending an arrow here is what makes the app
      // beep at someone who did nothing wrong. The key is swallowed either way:
      // at the list's edge nothing moves, quietly. Rows are ragged (one may
      // hold two accessories where its neighbour holds one), so the ordinal
      // clamps rather than refusing the move.
      if (
        inRowScope &&
        manager !== null &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === "ArrowDown" || e.key === "ArrowUp")
      ) {
        const from = descendedRowRef.current?.index ?? -1;
        const ordinal = rowFocusableIds(from).indexOf(manager.keyView() ?? "");
        const next =
          from < 0 ? -1 : stepCursorableRow(from, e.key === "ArrowDown" ? 1 : -1);
        if (next >= 0 && next !== from) {
          // Ascend first so the outgoing row's scope is popped, then move the
          // cursor (which reveals the landing row) and descend afresh. A row
          // that turns out to hold no accessory — or one still outside the
          // render window — leaves the keyboard on the container with the
          // cursor moved, which is the graceful half-step, never a dead end.
          manager.ascend();
          descendedRowRef.current = null;
          moveCursorTo(next, true);
          if (commitOnMoveRef.current) selectCursorRow();
          descendRowAt(next, Math.max(ordinal, 0));
        }
        return true;
      }
      // Home / End / Page from inside a row are LIST gestures — jump to the
      // top, the bottom, a screenful on — so they ascend out of the row and
      // then mean what they mean on the list. Refusing them because the
      // keyboard happens to be on an accessory is the row-as-jail behavior
      // again.
      const listJumpFromRow =
        inRowScope &&
        manager !== null &&
        (e.key === "Home" ||
          e.key === "End" ||
          e.key === "PageUp" ||
          e.key === "PageDown");
      if (listJumpFromRow && manager !== null) {
        manager.ascend();
        descendedRowRef.current = null;
      }
      // Move the cursor only while the container itself holds the keyboard key
      // view. After Enter descends onto an inner focusable the container is no
      // longer the key view — arrows then belong to the descended component,
      // not the list cursor. (The ascend just above has handed it back, which
      // the projection may not have written yet.)
      if (!listJumpFromRow && !scrollEl.hasAttribute("data-key-view-kbd")) {
        return false;
      }
      const total = dataSourceRef.current.numberOfItems();
      if (total === 0) return false;
      const cur = cursorIndexRef.current;
      // Tree-style descend ([P02] disclosure model): Right enters a row whose
      // content has navigable focusables, mirroring Enter — in BOTH selection
      // models. A single-select row stays a pick on Enter (never descends —
      // Return falls through to the surface default); Right is its one way
      // in to a focusable accessory. Ascend is Escape or Left. Other rows
      // ignore Right (no horizontal movement in a vertical list).
      if (e.key === "ArrowRight" && rowFirstFocusableId(cur) !== null) {
        descendCursorRow();
        return true;
      }
      const pageStep = (): number =>
        Math.max(
          1,
          Math.floor(
            (scrollEl.clientHeight || 0) /
              Math.max(1, heightForIndex(Math.max(0, cur))),
          ) - 1,
        );
      // Container-cursor arrows now reach the list through its spatial cursor
      // handle instead, which the navigator consumes before this delegate ever
      // runs ([P02]) — and whose edges hand on to the liveliness net rather than
      // clamping here. The arrow cases below stay as the delegate's backstop for
      // any path that bypasses the spatial plane; Home / End / Page have no
      // spatial counterpart and are only ever served here.
      // A modifier-arrow with NOTHING selected picks up the row it starts on
      // before it goes anywhere. Without this the origin row is the one row a
      // ⇧-walk can never reach: extension names where the cursor LANDS, so a
      // ⇧↓ from an empty selection would select the row below and silently
      // leave behind the row the user was looking at when they pressed it.
      //
      // Gated on the MOVEMENT key, not on the modifier being down: a bare ⇧
      // keydown is `shiftKey: true` and would otherwise select the cursor row
      // just for resting a finger on the key, with no gesture behind it.
      const seedsMovement =
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "Home" ||
        e.key === "End";
      const seedsSelection =
        seedsMovement &&
        (e.shiftKey || metaSelects) &&
        multiSelectRef.current !== undefined &&
        multiSelectRef.current.selectedIds.size === 0 &&
        isCursorableRow(cur);
      if (seedsSelection) {
        commitMultiSelect(cur, "pick");
        // ⇧ spends the whole press on the seed and the cursor stays put: a
        // press that seeded AND moved would select two rows at once, which is
        // never what the first ⇧↓ of a walk means. ⌘ does move — it extends
        // nothing, so the seeded row is still the only one selected when it
        // lands somewhere else.
        if (e.shiftKey) return true;
      }

      let next = -1;
      switch (e.key) {
        case "ArrowDown":
          next = cur < 0 ? firstCursorableRow() : stepCursorableRow(cur, 1);
          break;
        case "ArrowUp":
          next = cur < 0 ? lastCursorableRow() : stepCursorableRow(cur, -1);
          break;
        case "Home":
          next = firstCursorableRow();
          break;
        case "End":
          next = lastCursorableRow();
          break;
        case "PageDown":
          next = cursorableNear((cur < 0 ? firstCursorableRow() : cur) + pageStep(), 1);
          break;
        case "PageUp":
          next = cursorableNear((cur < 0 ? lastCursorableRow() : cur) - pageStep(), -1);
          break;
        default:
          return false;
      }
      if (next >= 0 && next !== cur) {
        moveCursorTo(next, true);
        // Selection follows the cursor — commit the landed row so there is no
        // separate Space step ([P12] picker shape).
        if (commitOnMoveRef.current) selectCursorRow();
      } else if (next >= 0) scrollIndexIntoView(next, "nearest");
      // ⇧ + a movement key EXTENDS the multi-selection to the row the cursor
      // landed on. `focus-language.md`: a bare arrow never selects; a
      // modifier-extended arrow is a selection gesture.
      //
      // This rides the backstop and only the backstop. Bare arrows are taken by
      // the spatial cursor handle before the delegate ever runs, but both the
      // navigator and the liveliness net bail on `shiftKey`, so a ⇧-arrow
      // arrives here and nowhere else. Home / End have no spatial counterpart
      // and are always served here. Page keys move the cursor without
      // extending: a screenful is a scroll gesture, not a range the user
      // picked out.
      //
      // ⌘ deliberately does NOT extend. It walks the cursor over a selection it
      // leaves standing, so the user can step past rows they do not want and
      // pick up the ones they do with Space — which is the gesture ⇧ cannot
      // make, and the reason both modifiers are here.
      if (
        e.shiftKey &&
        next >= 0 &&
        multiSelectRef.current !== undefined &&
        e.key !== "PageUp" &&
        e.key !== "PageDown"
      ) {
        commitMultiSelect(next, "extend");
      }
      return true;
    };
    handleListKeyRef.current = handleListKey;

    interface CellCallbacks {
      readonly ref: (el: HTMLDivElement | null) => void;
      readonly pointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
      readonly click: (e: React.MouseEvent<HTMLDivElement>) => void;
      readonly doubleClick: () => void;
      readonly keyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
    }
    const cellCallbacksRef = React.useRef<Map<number, CellCallbacks>>(
      new Map(),
    );

    // A pointerdown a finer gesture affordance claimed (`defaultPrevented` —
    // a Lens row arming its carry). Selection does not commit on that press,
    // because the press may be about to become a drag; it commits on the
    // CLICK instead, which only arrives if the gesture stayed a click. A drag
    // swallows its own trailing click, so it selects nothing.
    const deferredSelectIndexRef = React.useRef<number | null>(null);
    // The intent that deferred press carried. Classified at pointerdown, where
    // the gesture record is live, and replayed on the click — by then the
    // gesture is over and the modifiers are gone, so a click that re-asked
    // would read every deferred ⌘-click as a plain pick.
    const deferredSelectIntentRef = React.useRef<MultiSelectIntent>("pick");

    // Commit a row's selection under the multi-select contract. Returns the
    // intent it committed, or `null` when the list is not in multi-select mode
    // and the caller should run the ordinary `onSelect` path instead.
    //
    // What the caller does NEXT is the caller's, because the three gestures
    // that reach here mean different things about activation: a plain click
    // selects AND fronts, a modifier click only selects ([P06] — building a
    // selection by clicking would raise every card it touched), and Space only
    // selects (Enter is the activating key, and a list that acts on both has
    // no way to say "this one" without opening it).
    const commitMultiSelect = (
      index: number,
      intent: MultiSelectIntent,
    ): MultiSelectIntent | null => {
      const ms = multiSelectRef.current;
      if (ms === undefined) return null;
      const id = dataSourceRef.current.idForIndex(index);
      const took =
        intent === "toggle"
          ? ms.onToggle(id)
          : intent === "extend"
            ? ms.onExtendTo(id)
            : ms.onPick(id);
      return took ? intent : null;
    };
    commitMultiSelectRef.current = commitMultiSelect;

    function getCellCallbacks(index: number): CellCallbacks {
      const registry = cellCallbacksRef.current;
      const cached = registry.get(index);
      if (cached !== undefined) return cached;
      const refCb = (el: HTMLDivElement | null): void => {
        if (el !== null) {
          cellElementMapRef.current.set(index, el);
          observerRef.current?.observe(el);
        } else {
          const old = cellElementMapRef.current.get(index);
          if (old !== undefined) {
            observerRef.current?.unobserve(old);
            cellElementMapRef.current.delete(index);
          }
        }
      };
      // A cell is inertly clickable (role/enablement) — the gate shared by the
      // pointerdown promotion and the click selection.
      const cellIsPickable = (): boolean => {
        const role =
          dataSourceRef.current.roleForIndex?.(index) ?? DEFAULT_CELL_ROLE;
        if (role !== "cell") return false;
        // Disabled cells are visible-but-unpickable: a click must not promote
        // them to selection nor park the cursor on them. Re-read from the live
        // data source so an enabled→disabled tick between mount and click is
        // honored.
        return dataSourceRef.current.enabledForIndex?.(index) !== false;
      };
      // The clicked cell holds an OPEN in-row editor — a contenteditable (CM's
      // `.cm-content`), `input`, or `textarea` anywhere in its subtree. A
      // pointer gesture anywhere in such a cell (the text, the well padding, the
      // scroller below the last line, the card header) belongs to the editor,
      // not to row selection: promoting the container would ascend the row's
      // descend scope, blur the editor, and close it. Read from the cell
      // (`currentTarget`) rather than the exact target so a click on the well
      // chrome — not just on the text — keeps the editor open, and rather than
      // the async descend state so the guard is reliable the instant the editor
      // mounts, before its scope has settled.
      const cellHasOpenEditor = (
        e: { currentTarget: EventTarget | null },
      ): boolean =>
        e.currentTarget instanceof Element &&
        e.currentTarget.querySelector('[contenteditable="true"], input, textarea') !==
          null;
      // The gesture landed on an in-row ACTION rather than on the row — a
      // close box, a trash button, any `data-tug-focus="refuse"` control. Such
      // a control acts on the row it names, which is not the same as picking
      // that row: a close box that first selects fronts the very card it is
      // about to close, stealing activation from whatever the user was working
      // in and leaving it nowhere to go. `stopPropagation` on the control's
      // CLICK cannot prevent this — selection commits at pointerdown, which has
      // already bubbled by then — so the row's own handlers ask the question.
      const targetIsRowAction = (e: { target: EventTarget | null }): boolean =>
        targetRefusesFocus(e.target);
      const pointerDownCb = (e: React.PointerEvent<HTMLDivElement>): void => {
        if (e.button !== 0) return;
        if (!cellIsPickable()) return;
        if (targetIsRowAction(e)) return;
        // A pointerdown anywhere in the open editor's cell stays with the
        // editor: the editor's own focusable (found by the capture-phase pointer
        // placement) keeps the caret, so the click lands as expected.
        if (cellHasOpenEditor(e)) return;
        // Selection commits HERE, not on click (focus-language.md § Drag and
        // the keyboard): mousedown on a row selects it and a drag then carries
        // what it selected, as `NSTableView` does. Click-gated selection is
        // unreachable from any gesture that becomes a drag (a drag fires no
        // click) and from a first-click-activates gesture (the activation
        // mousedown `preventDefault` eats the click).
        //
        // A `defaultPrevented` pointerdown belongs to a finer gesture
        // affordance that claimed the pointer before it bubbled here — a Lens
        // row arming its own reorder carry — and cannot be read as a
        // row-selection gesture YET, because it does not know which it is: a
        // carry must reorder without selecting (for a session row, `onSelect`
        // fronts the bound card mid-drag), while a press that never travels
        // is an ordinary click and must select as one. So the selection is
        // deferred to the click rather than dropped, and the drag's swallowed
        // click is what makes a real carry select nothing.
        //
        // Selection is list state and commits whether or not the focus engine
        // is running; only the cursor / key-view half below is engine state.
        const intent = multiSelectIntentFor(currentGesture());
        if (!e.defaultPrevented) {
          deferredSelectIndexRef.current = null;
          // A modifier gesture is a selection edit and stops there: no
          // `onSelect` (which fronts the card), no owned-index move. A PLAIN
          // click is both halves — it moves the selection onto this row and
          // fronts it — so it falls through to `onSelect` as well.
          const committed = commitMultiSelect(index, intent);
          if (committed === null || committed === "pick") {
            delegateRef.current?.onSelect?.(index);
            if (selectionRequiredRef.current || focusEngineActiveRef.current) {
              setSelectedIndex(index);
            }
          }
        } else {
          deferredSelectIndexRef.current = index;
          deferredSelectIntentRef.current = intent;
        }
        if (!focusEngineActiveRef.current) return;
        // The gesture's own placement decision governs the engine half. The
        // list does not re-derive it: the interpreter is what knows this
        // gesture is a cross-card activation click (which realizes the card's
        // recorded destination rather than the clicked row) or landed on a
        // surface that declared its chrome placement-suppressing. Selection
        // above is list state and commits either way.
        if (currentGesture()?.placement === "suppressed") return;
        // Promote the keyboard-navigable listbox to the KEYBOARD key view on
        // POINTERDOWN — the same event dispatch as the capture-phase pointer
        // placement (`responder-chain-provider`), which parks the container as
        // a *pointer* key view (ring off) and clears the cursor visual. Doing
        // the keyboard re-place here coalesces the two synchronous key-view
        // writes into one paint, so the ring never blinks off-then-on when a
        // click re-lands in an already-focused list. Cursor FIRST, then place:
        // the key-view-GAIN projection paints `data-key-cursor` from
        // `cursorIndexRef`, so seeding the index first lands the bar on the
        // clicked row rather than re-projecting the pre-click position.
        moveCursorTo(index, false);
        if (manager !== null && cardId !== null) {
          manager.place(
            cardId,
            { kind: "focusable", id: focusableId },
            { modality: "keyboard" },
          );
        }
      };
      // The click path is the fallback for clicks with no pointer gesture
      // behind them — a focusable child inside a cell activated by Space fires
      // a synthetic click that bubbles to this wrapper (the `keyDownCb`
      // double-fire guard below documents consumers relying on it). Every real
      // pointer click already committed its selection at pointerdown, so
      // `detail === 0` (no click count — the keyboard-synthesized shape) is
      // what distinguishes the two and keeps a consumer's `onSelect` from
      // firing twice for one pointer gesture.
      const clickCb = (e: React.MouseEvent<HTMLDivElement>): void => {
        // A pointer click whose pointerdown was claimed (and therefore did not
        // select) is this row's selection arriving late — the gesture turned
        // out to be a click after all. One-shot.
        const deferred = deferredSelectIndexRef.current === index;
        if (deferred) deferredSelectIndexRef.current = null;
        if (e.detail !== 0 && !deferred) return;
        if (!cellIsPickable()) return;
        // A click in the open editor's cell is the editor's, not a re-selection
        // of the container's row (mirrors the pointerdown guard).
        if (cellHasOpenEditor(e)) return;
        // Space on a descended-onto close box synthesizes a click that bubbles
        // here; it is still the action's gesture, not the row's.
        if (targetIsRowAction(e)) return;
        // A deferred press replays the intent it was classified with; a
        // keyboard-synthesized click carries no gesture and reads as a pick.
        const intent = deferred ? deferredSelectIntentRef.current : "pick";
        const committed = commitMultiSelect(index, intent);
        if (committed !== null && committed !== "pick") return;
        delegateRef.current?.onSelect?.(index);
        // `selectionRequired` mode — the list view owns the selected index; a
        // cell activation moves it. `delegate.onSelect` above still fires, so
        // consumers that want both keep both. (The keyboard key-view promotion
        // + movement cursor ride the pointerdown handler above.)
        if (selectionRequiredRef.current || focusEngineActiveRef.current) {
          setSelectedIndex(index);
        }
      };
      // Keyboard activation per [Q06] — cell wrappers are
      // `tabIndex={0}` and `role="listitem"` (see render below), so
      // a focused cell receives keydowns directly. Enter and Space
      // fire `delegate.onSelect(index)` and stop propagation so
      // SmartScroll's keydown handler does not also see Space (which
      // it interprets as a scroll key).
      //
      // The `event.target === event.currentTarget` guard prevents
      // double-fire when a cell renderer holds a focusable child.
      // A button inside a cell, focused, then activated by Space:
      // the browser fires a synthetic click on the button which
      // bubbles up to the wrapper's `onClick` (which already routes
      // to `onSelect`). Without the guard, the keydown ALSO fires
      // before the synthetic click, and the consumer sees two
      // selections per activation.
      //
      // The role gate runs BEFORE `preventDefault`/`stopPropagation`:
      // a header/footer with a programmatically-focused descendant
      // that received Enter should not have its event suppressed by
      // the list view; the descendant's own handler (if any) gets
      // the unmodified event.
      const keyDownCb = (e: React.KeyboardEvent<HTMLDivElement>): void => {
        if (e.target !== e.currentTarget) return;
        if (e.key !== "Enter" && e.key !== " ") return;
        const role =
          dataSourceRef.current.roleForIndex?.(index) ?? DEFAULT_CELL_ROLE;
        if (role !== "cell") return;
        // Disabled cells swallow neither the key nor the activation: a
        // Space/Enter on one is a no-op (the row is unpickable). Leave the
        // event unmodified so any focused descendant's own handler still
        // sees it (mirrors the header/footer role gate).
        if (dataSourceRef.current.enabledForIndex?.(index) === false) return;
        e.preventDefault();
        e.stopPropagation();
        delegateRef.current?.onSelect?.(index);
        if (selectionRequiredRef.current) setSelectedIndex(index);
      };
      // Double-click activates the row (the Things model's OPEN gesture), the
      // pointer equivalent of Enter — routed to `onActivate`, distinct from the
      // first click's `onSelect`. Opt-in via `activateOnDoubleClick`; role- and
      // enablement-gated exactly like the single click.
      const dblClickCb = (): void => {
        if (!activateOnDoubleClickRef.current) return;
        const role =
          dataSourceRef.current.roleForIndex?.(index) ?? DEFAULT_CELL_ROLE;
        if (role !== "cell") return;
        if (dataSourceRef.current.enabledForIndex?.(index) === false) return;
        delegateRef.current?.onActivate?.(index);
      };
      const callbacks: CellCallbacks = {
        ref: refCb,
        pointerDown: pointerDownCb,
        click: clickCb,
        doubleClick: dblClickCb,
        keyDown: keyDownCb,
      };
      registry.set(index, callbacks);
      return callbacks;
    }

    // Row-layout context payload published to descendant `TugListRow`s.
    // Memoized on its fields so the object identity is stable across
    // scroll-tick re-renders — the context value churning would re-render
    // every row needlessly.
    const rowLayoutValue = React.useMemo(
      () => ({
        variant: rowLayout ?? null,
        selectedAccent,
        density: rowDensity ?? null,
        selectionSurface: selectionSurface ?? null,
      }),
      [rowLayout, selectedAccent, rowDensity, selectionSurface],
    );

    // Resolve `rowSeparator` into the divider's CSS custom-property
    // values + the `data-row-separator` mode. Omitting the prop leaves
    // both unset, so the flush divider renders exactly as before ([L06]).
    const resolvedSeparator = resolveRowSeparator(rowSeparator);
    const rowSeparatorMode =
      rowSeparator === undefined
        ? undefined
        : resolvedSeparator === null
          ? "none"
          : "on";
    const separatorStyle: React.CSSProperties | undefined =
      resolvedSeparator !== null && rowSeparator !== undefined
        ? ({
            "--tugx-list-view-divider-thickness": resolvedSeparator.thickness,
            ...(resolvedSeparator.color !== null
              ? { "--tugx-list-view-divider-color": resolvedSeparator.color }
              : {}),
          } as React.CSSProperties)
        : undefined;

    // The two presentation props that write a token and a gating attribute:
    // alternating row tint and the list's text measure. Both are absent
    // entirely when the prop is omitted, so a list that asks for neither has
    // the DOM it always had.
    const resolvedStriping = resolveRowStriping(rowStriping);
    const rowTextSizeValue =
      rowTextSize === undefined
        ? undefined
        : typeof rowTextSize === "number"
          ? `${rowTextSize}px`
          : rowTextSize;
    const containerStyle: React.CSSProperties | undefined =
      separatorStyle === undefined &&
      resolvedStriping === null &&
      rowTextSizeValue === undefined
        ? undefined
        : ({
            ...separatorStyle,
            ...(resolvedStriping !== null
              ? {
                  "--tugx-list-view-stripe-color": resolvedStriping.color,
                  "--tugx-list-view-stripe-base-color":
                    resolvedStriping.baseColor,
                }
              : {}),
            ...(rowTextSizeValue !== undefined
              ? { "--tugx-list-row-font-size": rowTextSizeValue }
              : {}),
          } as React.CSSProperties);

    // Rows are native per-row Tab stops only for an un-authored, non-subordinate
    // list (today's default). A `focusGroup` listbox is one container stop with a
    // movement cursor; a subordinate list contributes no stops.
    const rowsAreNativeStops = !focusEngineActive && !keyboardSubordinate;

    return (
      <div
        ref={setScrollContainerRef}
        data-slot="tug-list-view"
        data-tug-scroll-key={scrollKey ?? "tug-list-view"}
        data-row-layout={rowLayout}
        data-row-separator={rowSeparatorMode}
        data-row-striping={resolvedStriping !== null ? "on" : undefined}
        data-row-text-size={rowTextSizeValue !== undefined ? "" : undefined}
        data-selection-surface={
          selectionSurface === "control" ? "control" : undefined
        }
        data-interactive={interactive ? undefined : "false"}
        data-offscreen-skip={
          inline === true && offscreenSkip ? "" : undefined
        }
        className={
          className === undefined ? "tug-list-view" : `tug-list-view ${className}`
        }
        style={containerStyle}
        role={listRole}
        // A subordinate list adds no Tab stop of its own (the filter input owns
        // focus); an un-authored interactive list is a native focus stop at
        // `0`. An ENGINE-authored list renders NO tabindex ([P08] of the
        // keyboard-as-engine-state plan): the walk owns Tab and the ring is
        // engine-projected, so DOM focusability buys nothing — and any
        // tabindex'd container is still mouse-focusable, inviting mousedown
        // focus churn the watchdog then has to park. The same no-tabindex
        // rule covers subordinate lists (zero stops by contract) and
        // read-only listings (`interactive={false}`, e.g. the dev
        // transcript), where a focusable container would steal the caret
        // from the surface that owns it.
        tabIndex={
          focusEngineActive || keyboardSubordinate || !interactive
            ? undefined
            : 0
        }
      >
        {/* The top breathing spacer — a sticky, zero-interaction first child.
            First in flow, so a `::before` pseudo could never take its place;
            sticky so the block-axis breathing room does not push the scrollport
            top away from sticky group headers. */}
        <div className="tug-list-view-top-spacer" aria-hidden="true" />
        {/* Leading content — a permanent, un-indexed element above row 0 that
            scrolls with the content (see `leadingContent` prop). Sits ABOVE
            the top spacer, because the spacer stands in for evicted rows:
            were the leading element below it, a grown spacer would push this
            permanent header down into the middle of the list. With the
            spacer at zero (plain inline, and the windowed path at the top of
            its range) the two orderings are visually identical, which is why
            this went unnoticed until eviction gave the spacer a height. */}
        {leadingContent !== undefined ? (
          <div
            ref={leadingElRef}
            className="tug-list-view-leading"
            data-slot="tug-list-view-leading"
          >
            {leadingContent}
          </div>
        ) : null}
        {/* **Spacer height belongs in the render pass.** It stands in for
            the rows the window left out, so it is the other half of the row
            set React is rendering right beside it — one piece of geometry,
            and it must land in ONE mutation batch.

            Writing it from a `useLayoutEffect` instead splits that geometry
            across React's commit boundary. The mutation phase removes the
            evicted rows and their combined extent — thousands of pixels on
            a transcript — leaves the document; the layout phase puts it
            back. In between, the document is short by exactly that amount,
            and layout is lazy, so this is harmless right up until something
            forces layout in that window. Then the browser clamps `scrollTop`
            to the short maximum and does NOT restore it when the spacer
            grows back microseconds later — the user's position is simply
            gone. Plenty of readers sit in that window: every child layout
            effect (children run before parents), the front-insert
            scroll-hold's `scrollHeight` read, the ring-height effect's
            `clientHeight` read.

            Rendering the height closes the window by construction rather
            than by hunting readers, so a sixth reader added later cannot
            reopen it. `windowResult` is already computed in the render body
            and already decides which rows are rendered, so nothing new is
            calculated and no new render is scheduled.

            Do not re-add a DOM-side writer alongside this one: React skips
            re-applying a `style` value it believes unchanged, so the two
            would go stale against each other. `TugMarkdownView` reaches the
            same atomicity imperatively — `applySpacers` runs in the same
            synchronous task as its block add/remove loops. */}
        <div
          ref={topSpacerRef}
          className="tug-list-view-spacer tug-list-view-spacer--top"
          style={{ height: `${windowResult.topSpacerHeight}px` }}
          aria-hidden="true"
        />
        <OuterScrollportProvider scrollport={scrollportEl}>
        <ScrollerProvider scroller={scrollerFacadeRef.current}>
        <TugListRowLayoutProvider value={rowLayoutValue}>
        <div className="tug-list-view-window" ref={listWindowElRef}>
          {renderedRange.map(({ index, id, kind, role, enabled }) => {
            // Role-aware wrapper attributes:
            //  - `tabIndex` is `0` for cells (focusable, in tab order)
            //    and `-1` for headers/footers (not focusable). See
            //    "Row roles" in the top-of-file docstring.
            //  - Rows are individual native Tab stops ONLY for an
            //    un-authored, non-subordinate list. A `focusGroup` listbox
            //    is one stop with a movement cursor; a subordinate list adds
            //    no stops — both make rows `-1`, with the active row shown by
            //    the cursor / selection, not Tab focus.
            //  - `data-list-cell-role` is set only for non-default
            //    roles, keeping the existing default-cell DOM shape
            //    byte-identical for backwards-compatible CSS
            //    selectors that don't yet know about roles.
            //  - A disabled cell is visible but unpickable: it drops out
            //    of the native Tab order (`tabIndex={-1}`) and carries
            //    `data-disabled` / `aria-disabled` so CSS and assistive
            //    tech reflect the state. The movement cursor already skips
            //    it via `isCursorableRow`.
            //  - An engine-authored or subordinate list renders NO tabindex
            //    on its wrappers ([P08]): the movement cursor is the row
            //    affordance, and `-1` wrappers are still mouse-focusable —
            //    pointless focus churn for the watchdog to park. The same
            //    applies to a read-only, un-authored listing
            //    (`interactive={false}`), where a focusable wrapper would
            //    steal the caret from the surface that owns it.
            const wrapperTabIndex = !rowsAreNativeStops
              ? undefined
              : !interactive
                ? undefined
                : role === "cell" && enabled
                  ? 0
                  : -1;
            const wrapperRoleAttr = role === "cell" ? undefined : role;
            const wrapperDisabledAttr = enabled ? undefined : "true";
            // `selectionRequired` mode — the owned selected row.
            // Surfaced two ways from the one source: `data-selected`
            // on the wrapper (the CSS-cascade hook,
            // `.tug-list-view-cell[data-selected="true"]`) and the
            // `selected` cell prop (the render-logic hook a cell
            // renderer forwards into a presentational child). The
            // wrapper attribute is absent entirely when the feature
            // is off, keeping the default-cell DOM shape unchanged.
            // Multi-select membership paints through the same attribute as the
            // owned single selection: one row-selected look, whichever mode put
            // the row there. A list in multi-select mode is normally not also
            // `selectionRequired`, so the two rarely meet — and where they do,
            // either being true means "this row is in the selection".
            const cellSelected =
              effectiveSelectedIndex === index ||
              multiSelect?.selectedIds.has(id) === true;
            const wrapperSelectedAttr = cellSelected ? "true" : undefined;
            // No per-cell height styling FROM RENDER. `inline` mode mounts
            // every cell at its real, measured height — no estimates, no
            // saved-height min-height. The scroll height is the true sum
            // of row heights, so the scrollbar never shifts. With
            // `offscreenSkip`, the cell ResizeObserver later stamps each
            // cell's EXACT measured height as `contain-intrinsic-size`
            // (a DOM write, [L06]) so far-offscreen cells can skip
            // style/layout/paint at precisely their true size.
            const Renderer = cellRenderers[kind];
            if (Renderer === undefined) {
              // Unknown kind — no renderer registered. Render an
              // empty placeholder so the windowing math still
              // accounts for the slot, and warn in dev.
              if (process.env.NODE_ENV !== "production") {
                console.warn(
                  `[TugListView] no cell renderer registered for kind "${kind}" at index ${index}`,
                );
              }
              return (
                <div
                  key={id}
                  className="tug-list-view-cell"
                  data-tug-list-cell-index={index}
                  data-tug-list-cell-kind={kind}
                  data-row-parity={parityForIndex(index)}
                  data-list-cell-role={wrapperRoleAttr}
                  data-selected={wrapperSelectedAttr}
                  data-disabled={wrapperDisabledAttr}
                  aria-disabled={enabled ? undefined : true}
                  role="listitem"
                  tabIndex={wrapperTabIndex}
                  ref={getCellCallbacks(index).ref}
                  onPointerDown={getCellCallbacks(index).pointerDown}
                  onClick={getCellCallbacks(index).click}
                  onDoubleClick={getCellCallbacks(index).doubleClick}
                  onKeyDown={getCellCallbacks(index).keyDown}
                />
              );
            }
            return (
              <div
                key={id}
                className="tug-list-view-cell"
                data-tug-list-cell-index={index}
                data-tug-list-cell-kind={kind}
                data-row-parity={parityForIndex(index)}
                data-list-cell-role={wrapperRoleAttr}
                data-selected={wrapperSelectedAttr}
                data-disabled={wrapperDisabledAttr}
                aria-disabled={enabled ? undefined : true}
                role={itemRole}
                tabIndex={wrapperTabIndex}
                ref={getCellCallbacks(index).ref}
                onPointerDown={getCellCallbacks(index).pointerDown}
                onClick={getCellCallbacks(index).click}
                onDoubleClick={getCellCallbacks(index).doubleClick}
                onKeyDown={getCellCallbacks(index).keyDown}
              >
                {focusEngineActive ? (
                  // The row's content joins the row's own focus mode, so its
                  // inner focusables become the walk once Enter descends ([P02]).
                  <FocusModeContext.Provider value={`${focusableId}-row-${index}`}>
                    <Renderer
                      index={index}
                      id={id}
                      kind={kind}
                      dataSource={dataSource}
                      selected={cellSelected}
                    />
                  </FocusModeContext.Provider>
                ) : (
                  <Renderer
                    index={index}
                    id={id}
                    kind={kind}
                    dataSource={dataSource}
                    selected={cellSelected}
                  />
                )}
              </div>
            );
          })}
        </div>
        {/* Trailing content — a permanent, un-indexed element after the last
            row, inside the scroll façade providers so a hosted dialog reads
            `useScroller()` (see `trailingContent` prop). */}
        {trailingContent !== undefined ? (
          <div className="tug-list-view-trailing" data-slot="tug-list-view-trailing">
            {trailingContent}
          </div>
        ) : null}
        </TugListRowLayoutProvider>
        </ScrollerProvider>
        </OuterScrollportProvider>
        {/* Rendered, not written from an effect — see the top spacer for
            why splitting window geometry across the commit boundary costs
            the user their scroll position. */}
        <div
          ref={bottomSpacerRef}
          className="tug-list-view-spacer tug-list-view-spacer--bottom"
          style={{ height: `${windowResult.bottomSpacerHeight}px` }}
          aria-hidden="true"
        />
        {/* The extent floor. Pins the scrollable extent at the last
            settled value so it cannot dip mid-mutation — WebKit clamps
            the scroll offset synchronously at renderer removal, before
            the sibling spacer styles land, and no scroll API can
            witness that moment (see the commit bracket). Out of flow,
            one pixel wide, no pointer target, no paint: it exists only
            as scroll overflow. Rendered with NO height — the commit
            bracket is its single writer ([L06]), so React never goes
            stale against it. */}
        <div
          ref={extentFloorRef}
          className="tug-list-view-floor"
          aria-hidden="true"
        />
      </div>
    );
  },
);

// `forwardRef` collapses generics; cast back to the generic shape so
// consumers see typed cell-renderer props when they narrow the data-
// source generic. The runtime value is the same `forwardRef` object.
export const TugListView = TugListViewInner as unknown as TugListViewComponent;

/**
 * `PathListBlock` — Layer-1 body kind for a list of file paths.
 *
 * The first *list-shaped* body kind ([#bk-conformance] item 9): it is
 * built on `TugListView` rather than rendering rows by hand, so it
 * inherits the data-source contract and consistent cell wrappers (and
 * can opt into windowing later if a consumer ever needs it).
 * `GlobToolBlock` ([#step-15]) composes it `embedded`; `GrepToolBlock`
 * ([#step-16]) reuses it for its files-only mode.
 *
 * Composition (mirrors `FileBlock` / `JsonTreeBlock`):
 *  - Header (standalone only) — an optional identity `label`, the
 *    path count, an optional "truncated at N" indicator, and a
 *    trailing actions cluster (Copy + a sort toggle). In `embedded`
 *    mode the header is suppressed and the cluster portals into the
 *    host `BlockChrome`'s actions slot.
 *  - Body — a `TugListView` in `inline` mode (every row rendered, no
 *    windowing). The block grows to its natural height and the *outer*
 *    transcript scrolls; it is not boxed into an inner scroller. Rows
 *    are compact single-line `[icon] [path]` cells.
 *
 * Path rendering:
 *  - Each row composes the shared `MiddleEllipsisPath` ([#bk-conformance]
 *    item 8) — the same CSS-driven middle-ellipsis `ReadToolBlock` /
 *    `EditToolBlock` use. The full path shows whenever it fits; only a
 *    genuinely too-wide path collapses in the middle, and never the
 *    filename. No JS-side, width-blind segment trimming.
 *
 * Sort:
 *  - Two modes — `"found"` (producer order) and `"name"` (alphabetical
 *    by full path). The toggle surfaces only when the list is long
 *    enough to warrant it (`> SORT_TOGGLE_MIN_COUNT`). Sort is logical
 *    UI state (it changes row *order*, [L06]) so it lives in React
 *    state and is persisted through the [A9] component-state axis.
 *
 * What this body kind does NOT do:
 *  - Render a text-entry / filter field. A card has at most one
 *    text-entry surface ([#bk-conformance] item 2); path *filtering*
 *    is deferred to the future Find redesign. PathListBlock renders
 *    zero `<input>` / `<textarea>` elements.
 *  - Own row interaction. A row stamps the annotator's file-path
 *    annotation and the transcript's delegated layer supplies the click
 *    and the context menu, so a Glob result opens exactly the way a path
 *    written in assistant prose does. No handler, and no responder, is
 *    added here.
 *  - Box itself into a fixed-height inner scroller. A glob / grep
 *    result is bounded (Glob caps at 100); rendering it inline and
 *    letting the transcript scroll keeps the layout honest. A fold
 *    affordance for very long lists is a clean follow-on if needed.
 *
 * Laws:
 *  - [L06] sort mode is logical state (row order) → React state;
 *    row hover is pure CSS.
 *  - [L11] PathListBlock owns no responder. Copy is a `BlockCopyButton`
 *    (self-contained control); the sort toggle is a focus-refusing
 *    `TugIconButton` in direct-action mode.
 *  - [L19] file pair (`.tsx` + `.css`), exported props interface,
 *    `data-slot="path-list-body"` on the root, this docstring.
 *  - [L20] component-token sovereignty — owns `--tugx-paths-*`;
 *    consumes `--tugx-block-*` for the shared block scaffold and
 *    cascade-tunes `--tugx-list-view-*` for its instance.
 *  - [L23] sort mode survives reload via `useComponentStatePreservation`.
 *
 * Decisions:
 *  - [D05] two-layer split: this body kind owns the list rendering;
 *    the tool block (`GlobToolBlock`) owns chrome.
 *
 * @module components/tugways/body-kinds/path-list-block
 */

import "./path-list-block.css";

import React from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownAZ,
  File as FileIcon,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  ListOrdered,
} from "lucide-react";

import { MiddleEllipsisPath } from "@/components/tugways/blocks/middle-ellipsis-path";
import { ANNOTATION_CLASS } from "@/lib/annotator/types";
import { pathRelativeTo } from "@/lib/relative-path";
import { useChromeActionsTarget } from "@/components/tugways/blocks/block-chrome";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import { TugListRow } from "@/components/tugways/tug-list-row";
import {
  TugListView,
  type TugListViewCellProps,
  type TugListViewCellRenderer,
  type TugListViewDataSource,
} from "@/components/tugways/tug-list-view";
import {
  useComponentStatePreservation,
  useSavedComponentState,
} from "@/components/tugways/use-component-state-preservation";
import { BlockActionsCluster, BlockCopyButton } from "./affordances";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Structured path-list data — the body's render input. */
export interface PathListData {
  /** The file paths to list, in producer order. */
  paths: readonly string[];

  /**
   * The producer's own number for each path, parallel to `paths`, shown in
   * each row's leading gutter. A numbered list is one the user can act on by
   * number — the refs block sets it so `/ref 5` names the row that reads `5`.
   * A producer with no such handle (Glob) leaves it out and the column never
   * appears. Numbers follow their path across a sort.
   */
  numbers?: readonly number[];

  /**
   * When the producer truncated the result, the total count it would
   * otherwise have returned — drives the "truncated at N" indicator.
   * Undefined → the list is complete.
   */
  truncatedAt?: number;
}

export interface PathListBlockProps {
  /**
   * The path-list data. When undefined (or `paths` is empty) the block
   * renders an empty `data-slot="path-list-body"` marker for layout
   * consistency.
   */
  data?: PathListData;

  /**
   * Optional identity label shown at the leading edge of the
   * standalone header (e.g. "matches", "files"). Ignored in
   * `embedded` mode — the host owns identity there.
   */
  label?: string;

  /**
   * "Embedded" mode — composed inside a host that already paints a
   * container and a header (e.g. `BlockChrome` in
   * `GlobToolBlock`). When `true` the standalone frame + header are
   * dropped and the actions cluster portals into the host chrome's
   * actions slot. MUST be used under a `BlockChrome`.
   *
   * @default false
   */
  embedded?: boolean;

  /** Forwarded class name for cascade-scoped customization. */
  className?: string;

  /**
   * Draw each row's path RELATIVE to this root — display only. Every row of a
   * workspace search repeats the workspace's own prefix, which says nothing
   * and costs the width the filename needs. The annotation payload keeps the
   * absolute path ([P15]), the tooltip still shows it whole, and a path from
   * outside the root is drawn unchanged.
   *
   * A host that sets this and also PROJECTS these rows into a search index
   * must project the same shortened strings — the DOM and the index have to
   * agree on the text ([L20] is about tokens; this is the same discipline for
   * content).
   */
  relativeTo?: string;

  /**
   * Opt each row's path into transcript Find (`data-tugx-findable`).
   * Default off, and it must stay a deliberate opt-in: a marked unit that
   * the host surface does not also PROJECT into its search index desyncs
   * the match count from the paint. A host sets this only alongside its own
   * projection — the refs block does both.
   *
   * @default false
   */
  findable?: boolean;

  /**
   * Whether the list may be re-ordered. `false` pins it to producer order
   * and withholds the sort toggle entirely — for a host whose list is
   * NUMBERED by position, where alphabetizing would put the fifth result
   * somewhere other than fifth and break the number the user reads off it.
   * The refs block is exactly that host: `/ref 5` resolves by emission order
   * ([P12]).
   *
   * @default true
   */
  sortable?: boolean;

  /**
   * Opt-in key for the [A9] Component State Preservation Protocol.
   * When set, PathListBlock persists its sort mode into
   * `bag.components` so a Maker > Reload restores it. Undefined
   * opts out (gallery, standalone).
   */
  componentStatePreservationKey?: string;
}

/** Base sort mode — producer order, or alphabetical by full path. */
export type PathSortMode = "found" | "name";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The sort toggle surfaces only once the list is long enough that
 * re-ordering is genuinely useful — a handful of paths is faster to
 * scan than to re-sort.
 */
export const SORT_TOGGLE_MIN_COUNT = 20;

/** Cell-renderer kind — PathListBlock has exactly one row shape. */
const PATH_CELL_KIND = "path";

const DATA_SLOT_ROOT = "path-list-body";
const DATA_SLOT_HEADER = "path-list-header";
const DATA_SLOT_ACTIONS = "path-list-actions";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Sort paths for display. `"found"` returns the producer order
 * unchanged (a fresh array copy so callers never alias the input);
 * `"name"` sorts case-insensitively by the full path with a
 * locale-aware, numeric-aware compare.
 */
export function sortPaths(
  paths: readonly string[],
  mode: PathSortMode,
): string[] {
  if (mode === "found") return [...paths];
  return [...paths].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
  );
}

/** Last segment of a path. Trailing slashes are ignored; "" → "". */
function pathBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return "";
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

/** Icon family for a path, keyed off its extension. */
export type PathIconKind = "code" | "data" | "doc" | "image" | "file";

/** Extensions that render with the code-file icon. */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "pyi", "rb",
  "rs", "go", "java", "kt", "kts", "swift", "c", "h", "cpp", "cxx", "cc",
  "hpp", "hxx", "cs", "fs", "ml", "hs", "ex", "exs", "erl", "clj", "cljs",
  "scala", "groovy", "lua", "php", "pl", "pm", "r", "jl", "zig", "v",
  "dart", "vue", "svelte", "astro", "sh", "bash", "zsh", "fish", "css", "scss",
  "sass", "less", "html", "htm", "xml", "sql", "graphql", "gql",
]);
/** Extensions that render with the structured-data icon. */
const DATA_EXTENSIONS: ReadonlySet<string> = new Set([
  "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "csv", "tsv",
]);
/** Extensions that render with the document icon. */
const DOC_EXTENSIONS: ReadonlySet<string> = new Set([
  "md", "markdown", "mdx", "txt", "rst", "tex", "adoc",
]);
/** Extensions that render with the image icon. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif",
]);

/**
 * Classify a path into an icon family by its extension. Bare names
 * with no extension fall through to `"file"`.
 */
export function iconKindForPath(path: string): PathIconKind {
  const base = pathBasename(path).toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "file";
  const ext = base.slice(dot + 1);
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (DATA_EXTENSIONS.has(ext)) return "data";
  if (DOC_EXTENSIONS.has(ext)) return "doc";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "file";
}

/** Compose the standalone-header path count, e.g. "1 path" / "100 paths". */
export function composePathCountLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "path" : "paths"}`;
}

/**
 * Compose the "truncated at N" indicator, or `undefined` when the list
 * is complete. `truncatedAt` is the producer's pre-truncation total.
 */
export function composeTruncationLabel(
  truncatedAt: number | undefined,
): string | undefined {
  if (truncatedAt === undefined) return undefined;
  return `truncated at ${truncatedAt.toLocaleString()}`;
}

// ---------------------------------------------------------------------------
// Data source — TugListView-backed, immutable per instance
// ---------------------------------------------------------------------------

const NOOP_UNSUBSCRIBE = (): void => {};

/**
 * A `TugListView` data source over an immutable, already-sorted path
 * array. Each PathListBlock render that changes the displayed order
 * (a sort toggle, new data) builds a fresh instance — the array never
 * mutates in place, so `subscribe` is a no-op and `getVersion` returns
 * the array reference (stable per instance, distinct across instances).
 */
class PathListDataSource implements TugListViewDataSource {
  constructor(
    private readonly paths: readonly string[],
    /** Whether each row's path is marked for transcript Find (opt-in). */
    readonly findable: boolean,
    /**
     * The producer's number per path, keyed by path so a number follows its
     * row across a sort rather than staying with the position it started in.
     * Empty when the producer numbered nothing; the column is then absent.
     */
    private readonly numberByPath: ReadonlyMap<string, number>,
    /** Root to draw rows relative to — display only; empty means absolute. */
    readonly relativeTo: string,
  ) {}

  /** Whether this list is numbered at all — the column's width is shared. */
  get numbered(): boolean {
    return this.numberByPath.size > 0;
  }

  /** Cell-renderer accessor — the producer's number for the row at `index`. */
  numberAt(index: number): number | undefined {
    return this.numberByPath.get(this.paths[index]);
  }

  numberOfItems(): number {
    return this.paths.length;
  }

  idForIndex(index: number): string {
    // Glob / grep results are unique paths, so the path is a stable,
    // item-stable id — it follows the logical row across a sort.
    return this.paths[index];
  }

  kindForIndex(): string {
    return PATH_CELL_KIND;
  }

  subscribe(): () => void {
    return NOOP_UNSUBSCRIBE;
  }

  getVersion(): unknown {
    return this.paths;
  }

  /** Cell-renderer accessor — the path at `index`. */
  pathAt(index: number): string {
    return this.paths[index];
  }
}

// ---------------------------------------------------------------------------
// Cell renderer
// ---------------------------------------------------------------------------

/** Icon component per path family. */
const ICON_BY_KIND: Readonly<
  Record<PathIconKind, React.ComponentType<{ size?: number }>>
> = {
  code: FileCode,
  data: FileJson,
  doc: FileText,
  image: FileImage,
  file: FileIcon,
};

/**
 * One path row — `[icon] [path] [ref]`.
 *
 * The same `TugListRow` the commit receipt's file list is built from
 * (`TugChangesList`'s compact row: `variant="flush" density="compact" mono`,
 * a fixed-cell glyph leading, the path as content, an annotation trailing).
 * A `/match` result and a commit's file list are the same kind of line, so
 * they are the same row — the icon simply stands where the git status mark
 * stands. Geometry, typeface, and density therefore cannot drift apart,
 * because neither surface owns them.
 *
 * The path composes the shared `MiddleEllipsisPath`: it fills the row, shows
 * whole when it fits, and collapses in the middle (filename pinned) only
 * when genuinely too wide.
 */
const PathCell: TugListViewCellRenderer<PathListDataSource> = ({
  index,
  dataSource,
}: TugListViewCellProps<PathListDataSource>) => {
  const path = dataSource.pathAt(index);
  const Icon = ICON_BY_KIND[iconKindForPath(path)];
  // Born confirmed: the tool that produced this list just found the file.
  // A relative path is left un-annotated rather than guessed at — the
  // annotation's contract is a path that opens.
  const annotated = path.startsWith("/");
  const refNumber = dataSource.numbered ? dataSource.numberAt(index) : null;

  return (
    <TugListRow
      variant="flush"
      density="compact"
      mono
      className={
        annotated ? `tugx-paths-row ${ANNOTATION_CLASS}` : "tugx-paths-row"
      }
      data-slot="path-list-row"
      data-tug-annotation={annotated ? "file-path" : undefined}
      data-path={annotated ? path : undefined}
      data-tug-focus={annotated ? "refuse" : undefined}
      data-no-activate={annotated ? "" : undefined}
      leading={
        <span className="tugx-paths-icon" aria-hidden="true">
          <Icon size={12} />
        </span>
      }
      trailing={
        refNumber !== null ? (
          <span className="tugx-paths-ref" data-slot="path-list-ref">
            {refNumber}
          </span>
        ) : undefined
      }
    >
      <MiddleEllipsisPath
        path={pathRelativeTo(path, dataSource.relativeTo)}
        fullPath={path}
        findable={dataSource.findable}
        tip="file"
      />
    </TugListRow>
  );
};

/** Cell-renderer dispatch map — module-scope, one entry. */
const CELL_RENDERERS: Record<
  string,
  TugListViewCellRenderer<PathListDataSource>
> = {
  [PATH_CELL_KIND]: PathCell,
};

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

/** Serialized state for the [A9] component-state axis. */
interface PathListPersistedState {
  sortMode?: PathSortMode;
}

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------

export const PathListBlock: React.FC<PathListBlockProps> = ({
  data,
  label,
  embedded = false,
  className,
  findable = false,
  relativeTo = "",
  sortable = true,
  componentStatePreservationKey,
}) => {
  // ---- Sort state — logical UI state, React-owned per [L06] ----------
  const savedState = useSavedComponentState<PathListPersistedState>(
    componentStatePreservationKey,
  );
  const [sortMode, setSortMode] = React.useState<PathSortMode>(
    () => savedState?.sortMode ?? "found",
  );
  useComponentStatePreservation<PathListPersistedState>({
    componentStatePreservationKey,
    captureState: () => ({ sortMode }),
  });

  const handleSortToggle = React.useCallback((): void => {
    setSortMode((prev) => (prev === "found" ? "name" : "found"));
  }, []);

  // ---- Display paths + data source -----------------------------------
  const rawPaths = data?.paths;
  const displayPaths = React.useMemo(
    () =>
      rawPaths === undefined
        ? []
        : sortPaths(rawPaths, sortable ? sortMode : "found"),
    [rawPaths, sortMode, sortable],
  );
  // Numbers are keyed to the path they arrived with, not to a position, so a
  // sort re-orders the rows and their numbers together.
  const rawNumbers = data?.numbers;
  const numberByPath = React.useMemo(() => {
    const map = new Map<string, number>();
    if (rawPaths === undefined || rawNumbers === undefined) return map;
    rawPaths.forEach((path, i) => {
      const number = rawNumbers[i];
      if (number !== undefined) map.set(path, number);
    });
    return map;
  }, [rawPaths, rawNumbers]);
  const dataSource = React.useMemo(
    () =>
      new PathListDataSource(displayPaths, findable, numberByPath, relativeTo),
    [displayPaths, findable, numberByPath, relativeTo],
  );

  // ---- Copy source ---------------------------------------------------
  //
  // `pathsRef` carries the live display order so `BlockCopyButton`'s
  // `getText` closure reads the freshest list at fire time ([L07]).
  const pathsRef = React.useRef<readonly string[]>(displayPaths);
  React.useLayoutEffect(() => {
    pathsRef.current = displayPaths;
  }, [displayPaths]);
  const getPathsText = React.useCallback(
    () => pathsRef.current.join("\n"),
    [],
  );

  // ---- Chrome actions target (embedded composition) ------------------
  const chromeActionsTarget = useChromeActionsTarget();

  // Dev-mode misconfiguration check — `embedded={true}` requires a
  // parent `BlockChrome` or the actions cluster has nowhere to
  // portal. Mirrors `FileBlock`'s deferred-warn pattern: the chrome
  // publishes its actions target via a `useState`-tracked ref callback,
  // so the target is `null` on the body kind's first render under a
  // legal chrome — the `setTimeout` defers past reconciliation and the
  // cleanup cancels the warn if the target becomes non-null.
  React.useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (!embedded) return;
    if (chromeActionsTarget !== null) return;
    const handle = window.setTimeout(() => {
      console.warn(
        "PathListBlock: `embedded={true}` requires a parent " +
          "`BlockChrome`. Without one the actions cluster (Copy, " +
          "sort toggle) has nowhere to portal and the user loses access " +
          "to it silently. Either compose under a chrome or set " +
          "`embedded={false}`.",
      );
    }, 0);
    return () => {
      window.clearTimeout(handle);
    };
  }, [embedded, chromeActionsTarget]);

  // ---- Empty data: layout-consistent marker --------------------------
  if (data === undefined || displayPaths.length === 0) {
    return (
      <div
        data-slot={DATA_SLOT_ROOT}
        data-empty="true"
        data-embedded={embedded ? "true" : undefined}
        className={
          className === undefined ? "tugx-paths" : `tugx-paths ${className}`
        }
      />
    );
  }

  const rootClass =
    "tugx-paths" + (className === undefined ? "" : ` ${className}`);

  // The sort toggle earns its place only on a list long enough to make
  // re-ordering worthwhile.
  const showSortToggle = sortable && displayPaths.length > SORT_TOGGLE_MIN_COUNT;
  const sortByName = sortMode === "name";

  // The actions cluster — Copy + (when long enough) the sort toggle.
  // Composed once; rendered inline in `.tugx-paths-header` (standalone)
  // or portaled into the host chrome's actions slot (embedded).
  // The sort toggle is the path list's body-specific control — kept in
  // both compositions. Copy is owned by the chrome header, so it renders
  // only in the standalone header.
  const sortToggle = showSortToggle ? (
    <TugIconButton
      className="tugx-paths-sort"
      icon={sortByName ? <ArrowDownAZ /> : <ListOrdered />}
      aria-label={
        sortByName
          ? "Sorted by name — click to restore found order"
          : "Sorted as found — click to sort by name"
      }
      title={sortByName ? "Sorted A–Z" : "Sorted as found"}
      onClick={handleSortToggle}
    />
  ) : null;
  const actions = (
    <>
      {sortToggle}
      <BlockCopyButton
        data-slot="path-list-copy"
        aria-label="Copy paths"
        getText={getPathsText}
      />
    </>
  );

  // Embedded: portal only the body-specific sort toggle (when shown).
  const portaledActions =
    embedded && chromeActionsTarget !== null && sortToggle !== null
      ? createPortal(
          <BlockActionsCluster data-slot={DATA_SLOT_ACTIONS}>
            {sortToggle}
          </BlockActionsCluster>,
          chromeActionsTarget,
        )
      : null;

  const truncationLabel = composeTruncationLabel(data.truncatedAt);

  return (
    <div
      data-slot={DATA_SLOT_ROOT}
      data-empty="false"
      data-embedded={embedded ? "true" : undefined}
      className={rootClass}
    >
      {embedded ? null : (
        <div className="tugx-paths-header" data-slot={DATA_SLOT_HEADER}>
          {label !== undefined ? (
            <span className="tugx-paths-label" data-slot="path-list-label">
              {label}
            </span>
          ) : null}
          <span className="tugx-paths-count" data-slot="path-list-count">
            {composePathCountLabel(displayPaths.length)}
          </span>
          {truncationLabel !== undefined ? (
            <span
              className="tugx-paths-truncation"
              data-slot="path-list-truncation"
            >
              {truncationLabel}
            </span>
          ) : null}
          <span className="tugx-paths-header-spacer" />
          <BlockActionsCluster data-slot={DATA_SLOT_ACTIONS}>
            {actions}
          </BlockActionsCluster>
        </div>
      )}
      {portaledActions}

      {/* `inline` — every row in document order, no windowing. The
       * block grows to its natural height; the outer transcript owns
       * the scroll. */}
      <TugListView<PathListDataSource>
        dataSource={dataSource}
        cellRenderers={CELL_RENDERERS}
        className="tugx-paths-list"
        inline
      />
    </div>
  );
};

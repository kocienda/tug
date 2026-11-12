/**
 * `JsonTreeBlock` — Layer-1 body kind for collapsible JSON viewing.
 *
 * Renders an arbitrary JSON value (object / array / string / number /
 * boolean / null) as a collapsible, type-coloured tree. It is a
 * *permanent* body kind, not just a fallback: per [D04] / [D11] it is
 * also the default body for unknown tool inputs in
 * `DefaultToolBlock` (#step-13) and the drift-fallback body for
 * unrecognized `structured_result` shapes.
 *
 * Composition (mirrors `FileBlock` / `DiffBlock` / `TerminalBlock`):
 *  - Header (standalone only) — an optional identity `label` + a
 *    trailing `BlockActionsCluster` carrying Expand-all /
 *    Collapse-all (`TugIconButton`) and Copy (`BlockCopyButton`).
 *    Unlike `FileBlock`, the header is rendered even without a label
 *    because it is the only host for the expand controls a tree
 *    needs; in `embedded` mode it is suppressed and the cluster
 *    portals into the host `BlockChrome`'s actions slot.
 *  - Tree — one row per node. Container rows (object / array) carry a
 *    twist chevron and toggle expand/collapse on click; leaf rows are
 *    inert. Every non-root row reveals a hover `TugIconButton` that
 *    copies that node's path (`response.data[0].id`).
 *
 * Expand model:
 *  - `defaultDepth` (default 3): nodes at depth `< defaultDepth` are
 *    expanded by default, deeper nodes are collapsed. This *is* the
 *    perf strategy — a deep tree renders only its shallow expanded
 *    region, the same "render the visible region" bound `DiffBlock`
 *    relies on. No virtualization in v1.
 *  - Expand-all / Collapse-all flip a base `expandMode`; per-node
 *    toggles record explicit `overrides` on top. `resolveJsonExpanded`
 *    is the single resolver: override → base mode → depth default.
 *  - The whole expand state (`expandMode` + `overrides`) is logical UI
 *    state — the *number* of rendered rows changes — so it lives in
 *    React state per [L06], and is persisted through the [A9]
 *    Component State Preservation Protocol so a Maker > Reload
 *    restores the user's expand shape.
 *
 * What this body kind does NOT do (and never will):
 *  - Ship an in-block search input. A card has at most one text-entry
 *    surface ([Phase E.12], the single-text-entry rule); body kinds
 *    render no text-entry UI of their own. Text-search over a JSON
 *    tree is deferred to the future Find redesign alongside per-block
 *    Find. JsonTreeBlock renders zero `<input>` / `<textarea>` /
 *    contenteditable elements — navigation is expand/collapse only.
 *
 * Laws:
 *  - [L06] all JsonTreeBlock-visible state is *logical* (which rows
 *    exist) — it controls *what* is rendered, not *how* a rendered
 *    element looks — so it lives in React state. Pure appearance
 *    (hover reveal of the copy button, type colours) is CSS.
 *  - [L11] JsonTreeBlock owns no responder. The header Copy is a
 *    `BlockCopyButton` (a self-contained control); the per-node copy
 *    is a focus-refusing `TugIconButton` in direct-action mode. No
 *    chain handlers, no first-responder dependency.
 *  - [L19] file pair (`.tsx` + `.css`), exported props interface,
 *    `data-slot="json-body"` on the root, this docstring.
 *  - [L20] component-token sovereignty — owns the `--tugx-json-*`
 *    slot family; consumes `--tugx-block-*` for the shared
 *    block-surface scaffold. Position-coordination tokens
 *    (`--tugx-pin-stack-top`, `--tugx-block-header-height`) are
 *    read but never overridden.
 *
 * Decisions:
 *  - [D04] / [D11] JsonTreeBlock is the permanent drift / default
 *    body kind.
 *  - [D05] two-layer split: this body kind owns tree rendering; the
 *    tool block (`DefaultToolBlock`) owns chrome.
 *
 * @module components/tugways/body-kinds/json-tree-block
 */

import "./json-tree-block.css";

import React from "react";
import { createPortal } from "react-dom";
import { Copy, FoldVertical, UnfoldVertical } from "lucide-react";

import { TugDisclosure } from "@/components/tugways/tug-disclosure";

import { useChromeActionsTarget } from "@/components/tugways/blocks/block-chrome";
import { TugIconButton } from "@/components/tugways/tug-icon-button";
import {
  useComponentStatePreservation,
  useSavedComponentState,
} from "@/components/tugways/use-component-state-preservation";
import { BlockActionsCluster, BlockCopyButton } from "./affordances";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface JsonTreeBlockProps {
  /**
   * The JSON value to render — object, array, string, number,
   * boolean, or null. `undefined` is "no data": the block renders an
   * empty `data-slot="json-body"` marker for layout consistency.
   * (JSON `null` is distinct — it renders as a `null` leaf.)
   */
  data?: unknown;

  /**
   * Optional identity label shown at the leading edge of the
   * standalone header (e.g. "input", "structured_result"). Omitted →
   * the header still renders (it hosts the expand controls) but
   * carries no label. Ignored in `embedded` mode.
   */
  label?: string;

  /**
   * Depth below which nodes collapse by default. Nodes at depth
   * `< defaultDepth` are expanded; depth `>= defaultDepth` collapsed.
   * The root is depth 0. Default {@link DEFAULT_JSON_DEPTH} (3).
   */
  defaultDepth?: number;

  /**
   * "Embedded" mode — composed inside a host that already paints a
   * container and a header (e.g. `BlockChrome` in
   * `DefaultToolBlock`). When `true`:
   *
   *   - The standalone frame (background / border / radius / margin)
   *     is dropped so the tree sits flush with the host.
   *   - The body kind's own header is suppressed — the host owns
   *     identity in its own header.
   *   - The actions cluster (Expand-all / Collapse-all / Copy) portals
   *     into the host's chrome actions slot via
   *     `ChromeActionsTargetContext`. As with the other body kinds,
   *     `embedded={true}` MUST be used under a `BlockChrome`.
   *
   * @default false
   */
  embedded?: boolean;

  /** Forwarded class name for cascade-scoped customization. */
  className?: string;

  /**
   * Opt-in key for the [A9] Component State Preservation Protocol.
   * When set, JsonTreeBlock persists its expand state (`expandMode` +
   * per-node `overrides`) into `bag.components` so a Maker >
   * Reload restores the user's expand shape. Undefined opts out
   * (gallery, standalone).
   */
  componentStatePreservationKey?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default depth threshold for the collapse-by-default behaviour.
 * Nodes shallower than this render expanded; deeper nodes fold. 3 is
 * deep enough to show a tool input's shape at a glance, shallow
 * enough that a large nested payload doesn't paint thousands of rows.
 */
export const DEFAULT_JSON_DEPTH = 3;

const DATA_SLOT_ROOT = "json-body";
const DATA_SLOT_HEADER = "json-header";
const DATA_SLOT_TREE = "json-tree";
const DATA_SLOT_ACTIONS = "json-actions";
const DATA_SLOT_NODE = "json-node";

// ---------------------------------------------------------------------------
// JSON value model — pure helpers (exported because tests pin them)
// ---------------------------------------------------------------------------

/** The six JSON value classes, plus the renderer's display vocabulary. */
export type JsonValueType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "boolean"
  | "null";

/**
 * Classify a JSON value. Wire JSON only produces the six classes; a
 * non-JSON `unknown` (`undefined`, `bigint`, `function`, `symbol`)
 * nested inside falls back to `"string"` so the renderer degrades to
 * `String(v)` rather than crashing.
 */
export function jsonValueType(value: unknown): JsonValueType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "object") return "object";
  if (t === "string") return "string";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  return "string";
}

/** Object and array are the collapsible container types. */
export function isJsonContainer(value: unknown): boolean {
  const t = jsonValueType(value);
  return t === "object" || t === "array";
}

/** One child entry of a container, in render order. */
export interface JsonEntry {
  /** Object key (string) or array index (number). */
  key: string | number;
  value: unknown;
}

/**
 * Child entries of a container, in render order. Arrays yield
 * `{ key: <index>, value }`; objects yield `{ key: <propName>, value }`
 * in own-enumerable order. Non-containers yield `[]`.
 */
export function jsonEntries(value: unknown): JsonEntry[] {
  if (Array.isArray(value)) {
    return value.map((v, i) => ({ key: i, value: v }));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).map(
      ([key, v]) => ({ key, value: v }),
    );
  }
  return [];
}

/**
 * Format a leaf value for display. Strings keep their JSON quotes and
 * escaping (so `"a\nb"` reads unambiguously); numbers / booleans /
 * null render bare. Containers never reach this — the renderer shows
 * their bracket summary instead.
 */
export function formatJsonLeaf(value: unknown): string {
  switch (jsonValueType(value)) {
    case "string":
      // `JSON.stringify` of a string yields the quoted, escaped form.
      // For a non-JSON `unknown` that classified as "string", fall
      // back to `String(value)`.
      return typeof value === "string" ? JSON.stringify(value) : String(value);
    case "null":
      return "null";
    default:
      // number / boolean — bare. (Containers don't reach here.)
      return String(value);
  }
}

/** A key is identifier-safe when it needs no bracket-quoting in a path. */
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Build the path of a child node from its parent's path and its key.
 * Array indices use `[n]`; identifier-safe object keys use `.key`
 * (bare at the root); other keys use bracket-quoted `["key"]`. Yields
 * paths like `data[0].id` or `headers["content-type"]`.
 */
export function childJsonPath(
  parentPath: string,
  key: string | number,
): string {
  if (typeof key === "number") return `${parentPath}[${key}]`;
  if (IDENTIFIER_RE.test(key)) {
    return parentPath === "" ? key : `${parentPath}.${key}`;
  }
  return `${parentPath}[${JSON.stringify(key)}]`;
}

/** Base expand mode — depth-default, or a global all-expand / all-collapse. */
export type JsonExpandMode = "depth" | "all-expanded" | "all-collapsed";

/**
 * The single resolver for "is this node expanded?". Precedence:
 *  1. an explicit per-node `override` wins;
 *  2. else the base `expandMode` — `all-expanded` → always, `all-collapsed`
 *     → only the root (depth 0), so collapse-all still leaves the
 *     top-level keys visible;
 *  3. else the depth default — expanded while `depth < defaultDepth`.
 */
export function resolveJsonExpanded(
  path: string,
  depth: number,
  defaultDepth: number,
  expandMode: JsonExpandMode,
  overrides: ReadonlyMap<string, boolean>,
): boolean {
  const override = overrides.get(path);
  if (override !== undefined) return override;
  if (expandMode === "all-expanded") return true;
  if (expandMode === "all-collapsed") return depth === 0;
  return depth < defaultDepth;
}

/**
 * Serialize a JSON value to pretty-printed text for the Copy
 * affordance. Returns `""` on failure (a cyclic value, or
 * `JSON.stringify` yielding `undefined`) so the copy is a clean no-op
 * rather than a thrown error — wire JSON is acyclic, this guard is
 * defensive insurance for non-wire callers.
 */
export function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

/**
 * Serialized expand state for the [A9] protocol. `overrides` is the
 * `Map` flattened to a plain record so it survives the bag's
 * JSON round-trip.
 */
interface JsonTreePersistedState {
  expandMode?: JsonExpandMode;
  overrides?: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// Recursive node renderer
// ---------------------------------------------------------------------------

interface JsonNodeProps {
  value: unknown;
  /** Object key / array index of this node; `undefined` at the root. */
  nodeKey: string | number | undefined;
  /** Full path of this node; `""` at the root. */
  path: string;
  depth: number;
  isExpanded: (path: string, depth: number) => boolean;
  onToggle: (path: string, depth: number) => void;
  onCopyPath: (path: string) => void;
}

/**
 * One node of the tree. Container nodes render a twist chevron and a
 * clickable line that toggles expansion; expanded containers recurse
 * into their entries. Leaf nodes render a typed value. Every non-root
 * node carries a hover-revealed copy-path `TugIconButton`.
 */
const JsonNode: React.FC<JsonNodeProps> = ({
  value,
  nodeKey,
  path,
  depth,
  isExpanded,
  onToggle,
  onCopyPath,
}) => {
  const type = jsonValueType(value);
  const container = type === "object" || type === "array";
  const expanded = container && isExpanded(path, depth);

  const open = type === "array" ? "[" : "{";
  const close = type === "array" ? "]" : "}";

  // Entries are walked once: the count drives the collapsed summary,
  // the array drives the expanded children.
  const allEntries = container ? jsonEntries(value) : [];
  const childCount = allEntries.length;
  const entries = expanded ? allEntries : [];
  const countWord =
    type === "array"
      ? childCount === 1
        ? "item"
        : "items"
      : childCount === 1
        ? "key"
        : "keys";

  const handleLineClick = container
    ? () => onToggle(path, depth)
    : undefined;

  // The root path is `""` — copying it is meaningless, so the root
  // row carries no copy-path button (the header `BlockCopyButton`
  // covers "copy the whole tree").
  const showCopyPath = path !== "";

  return (
    <div
      className="tugx-json-node"
      data-slot={DATA_SLOT_NODE}
      data-json-kind={type}
      data-json-depth={depth}
      data-json-path={path === "" ? undefined : path}
    >
      <div
        className="tugx-json-line"
        data-container={container ? "true" : undefined}
        data-expanded={container ? (expanded ? "true" : "false") : undefined}
        onClick={handleLineClick}
      >
        {container ? (
          <TugDisclosure className="tugx-json-twist" expanded={expanded} size={12} />
        ) : (
          <span className="tugx-json-twist-spacer" aria-hidden="true" />
        )}

        {nodeKey !== undefined ? (
          <>
            <span
              className="tugx-json-key"
              data-slot="json-key"
              data-json-key-kind={typeof nodeKey === "number" ? "index" : "prop"}
            >
              {nodeKey}
            </span>
            <span className="tugx-json-colon">:</span>
          </>
        ) : null}

        {container ? (
          expanded ? (
            <span className="tugx-json-bracket">{open}</span>
          ) : (
            <span className="tugx-json-summary">
              <span className="tugx-json-bracket">{open}…{close}</span>
              <span className="tugx-json-count">
                {childCount} {countWord}
              </span>
            </span>
          )
        ) : (
          <span
            className={`tugx-json-value tugx-json-value--${type}`}
            data-slot="json-value"
          >
            {formatJsonLeaf(value)}
          </span>
        )}

        {showCopyPath ? (
          <TugIconButton size="sm"
            className="tugx-json-copy-path"
            icon={<Copy />}
            aria-label={`Copy path ${path}`}
            title="Copy path"
            onClick={() => onCopyPath(path)}
          />
        ) : null}
      </div>

      {expanded ? (
        <div className="tugx-json-children">
          {entries.map((entry) => (
            <JsonNode
              key={String(entry.key)}
              value={entry.value}
              nodeKey={entry.key}
              path={childJsonPath(path, entry.key)}
              depth={depth + 1}
              isExpanded={isExpanded}
              onToggle={onToggle}
              onCopyPath={onCopyPath}
            />
          ))}
          <div className="tugx-json-bracket tugx-json-bracket--close">
            {close}
          </div>
        </div>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------

export const JsonTreeBlock: React.FC<JsonTreeBlockProps> = ({
  data,
  label,
  defaultDepth = DEFAULT_JSON_DEPTH,
  embedded = false,
  className,
  componentStatePreservationKey,
}) => {
  // ---- Expand state — logical UI state, React-owned per [L06] -------
  //
  // Mount-in-saved-state: the saved expand shape (if any) seeds the
  // `useState` initializers so the first paint reflects the user's
  // last-saved state.
  const savedState = useSavedComponentState<JsonTreePersistedState>(
    componentStatePreservationKey,
  );
  const [expandMode, setExpandMode] = React.useState<JsonExpandMode>(
    () => savedState?.expandMode ?? "depth",
  );
  const [overrides, setOverrides] = React.useState<Map<string, boolean>>(
    () =>
      savedState?.overrides !== undefined
        ? new Map(Object.entries(savedState.overrides))
        : new Map(),
  );

  // Persist the expand state through the [A9] axis so Maker >
  // Reload restores it. `overrides` flattens to a plain record for
  // the bag's JSON round-trip.
  useComponentStatePreservation<JsonTreePersistedState>({
    componentStatePreservationKey,
    captureState: () => ({
      expandMode,
      overrides: Object.fromEntries(overrides),
    }),
  });

  const isExpanded = React.useCallback(
    (path: string, depth: number): boolean =>
      resolveJsonExpanded(path, depth, defaultDepth, expandMode, overrides),
    [defaultDepth, expandMode, overrides],
  );

  const handleToggle = React.useCallback(
    (path: string, depth: number): void => {
      const next = !resolveJsonExpanded(
        path,
        depth,
        defaultDepth,
        expandMode,
        overrides,
      );
      setOverrides((prev) => {
        const map = new Map(prev);
        map.set(path, next);
        return map;
      });
    },
    [defaultDepth, expandMode, overrides],
  );

  const handleExpandAll = React.useCallback((): void => {
    setExpandMode("all-expanded");
    setOverrides(new Map());
  }, []);

  const handleCollapseAll = React.useCallback((): void => {
    setExpandMode("all-collapsed");
    setOverrides(new Map());
  }, []);

  // ---- Copy ----------------------------------------------------------
  //
  // `dataRef` carries the live value so the header `BlockCopyButton`'s
  // `getText` closure and the per-node copy-path handler read the
  // freshest value at fire time ([L07]).
  const dataRef = React.useRef<unknown>(data);
  React.useLayoutEffect(() => {
    dataRef.current = data;
  }, [data]);
  const getJsonText = React.useCallback(
    () => stringifyJson(dataRef.current),
    [],
  );
  const handleCopyPath = React.useCallback((path: string): void => {
    const writeText = navigator.clipboard?.writeText.bind(navigator.clipboard);
    if (writeText === undefined) return;
    if (path.length === 0) return;
    void writeText(path).catch(() => undefined);
  }, []);

  // ---- Chrome actions target (embedded composition) ------------------
  const chromeActionsTarget = useChromeActionsTarget();

  // ---- Empty data: layout-consistent marker --------------------------
  if (data === undefined) {
    return (
      <div
        data-slot={DATA_SLOT_ROOT}
        data-empty="true"
        data-embedded={embedded ? "true" : undefined}
        className={
          className === undefined ? "tugx-json" : `tugx-json ${className}`
        }
      />
    );
  }

  const rootClass =
    "tugx-json" + (className === undefined ? "" : ` ${className}`);

  // The actions cluster — Expand-all / Collapse-all / Copy. Composed
  // once; rendered inline in `.tugx-json-header` (standalone) or
  // portaled into the host chrome's actions slot (embedded).
  // Expand-all / Collapse-all are the tree's body-specific controls —
  // kept in both compositions. Copy is owned by the chrome header, so it
  // renders only in the standalone header.
  const treeControls = (
    <>
      <TugIconButton size="sm"
        className="tugx-json-expand-all"
        icon={<UnfoldVertical />}
        aria-label="Expand all"
        title="Expand all"
        onClick={handleExpandAll}
      />
      <TugIconButton size="sm"
        className="tugx-json-collapse-all"
        icon={<FoldVertical />}
        aria-label="Collapse all"
        title="Collapse all"
        onClick={handleCollapseAll}
      />
    </>
  );
  const actions = (
    <>
      {treeControls}
      <BlockCopyButton
        data-slot="json-copy"
        aria-label="Copy JSON"
        getText={getJsonText}
      />
    </>
  );

  // Embedded: portal only the body-specific tree controls.
  const portaledActions =
    embedded && chromeActionsTarget !== null
      ? createPortal(
          <BlockActionsCluster data-slot={DATA_SLOT_ACTIONS}>
            {treeControls}
          </BlockActionsCluster>,
          chromeActionsTarget,
        )
      : null;

  return (
    <div
      data-slot={DATA_SLOT_ROOT}
      data-empty="false"
      data-embedded={embedded ? "true" : undefined}
      className={rootClass}
    >
      {embedded ? null : (
        <div className="tugx-json-header tugx-block-strip" data-slot={DATA_SLOT_HEADER}>
          {label !== undefined ? (
            <span className="tugx-json-label" data-slot="json-label">
              {label}
            </span>
          ) : null}
          <span className="tugx-json-header-spacer" />
          <BlockActionsCluster data-slot={DATA_SLOT_ACTIONS}>
            {actions}
          </BlockActionsCluster>
        </div>
      )}
      {portaledActions}

      <div className="tugx-json-tree" data-slot={DATA_SLOT_TREE}>
        <JsonNode
          value={data}
          nodeKey={undefined}
          path=""
          depth={0}
          isExpanded={isExpanded}
          onToggle={handleToggle}
          onCopyPath={handleCopyPath}
        />
      </div>
    </div>
  );
};

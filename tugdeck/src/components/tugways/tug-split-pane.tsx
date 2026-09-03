/**
 * TugSplitPane — Split-pane layout primitive with draggable sashes.
 *
 * Wraps react-resizable-panels' `Group` / `Panel` / `Separator` primitives
 * with tugways chrome. Divides a region into two or more resizable children
 * stacked along one axis, separated by draggable sashes. Panels declare
 * their own size constraints via TugSplitPanel.
 *
 * Supports both horizontal and vertical orientations via the `orientation`
 * prop. Two-or-more panel children are supported in the same call (Sashes
 * are auto-interleaved). Nesting is supported — a TugSplitPanel may
 * contain another TugSplitPane.
 *
 * ## Orientation inversion
 *
 * react-resizable-panels v4 names `orientation` after the axis along which
 * panels are laid out: `"vertical"` = vertical stack with a horizontal sash
 * between them; `"horizontal"` = horizontal row with a vertical sash. The
 * TugSplitPane API names orientation after the *dividing line* — matching
 * NSSplitView, VS Code, and the user's mental model ("horizontally-split
 * card"). The two conventions are inverses, so TugSplitPane's horizontal
 * becomes the library's `"vertical"` in the call below.
 *
 * ## Host-agnostic contract
 *
 * TugSplitPane has zero knowledge of any particular mount site. Its
 * contract is the standard flexbox one: the parent must have a concrete
 * height (for a horizontal split) or width (for a vertical one); the
 * component fills the parent. Any host-specific layout plumbing lives at
 * the mount site, never inside this component.
 *
 * ## Persistence model
 *
 * When `storageKey` is set, the Group's `onLayoutChanged` callback writes
 * the layout to tugbank under the key. A single sync flag (shared via
 * `TugSplitPaneWriteContext`) distinguishes consumer-driven imperative
 * writes (via `TugSplitPanelHandle.requestSize`) from user drags: the
 * flag is set around `panel.resize()` calls and checked in
 * `onLayoutChanged`. The library fires `onLayoutChanged` synchronously
 * from its store subscription, so the flag's window reliably covers the
 * persistence decision.
 *
 * The stored layout is wired into the library's `defaultLayout` prop via
 * `useSyncExternalStore` + tugbank's `onDomainChanged` feed. This is the
 * only path into React state [L02]. `main.tsx` awaits `tugbankClient.ready()`
 * before mounting React, so the cache is guaranteed warm at mount and
 * `defaultLayout` alone is sufficient to restore.
 *
 * ## Pixel-pinned panels
 *
 * Panels with `groupResizeBehavior="preserve-pixel-size"` opt out of
 * proportional scaling on container resize: the library holds their
 * pixel size constant and reflows the relative-size siblings to absorb
 * the delta. To preserve the pixel size across reloads and card
 * switches (where container size may differ), the persistence schema
 * stores both flex-grow ratios (in `layout`) and pixel sizes (in
 * `pixels`). Pinned panels register with the pane via
 * `TugSplitPaneWriteContext.registerPanel` in a `useLayoutEffect` [L03];
 * the pane reads the registry at `onLayoutChanged` time to compute
 * pixel sizes, and at mount applies the stored pixel sizes via
 * `panel.resize("Npx")` — an imperative library call, not React state
 * [L22]. The sync flag gates this restore so the write does not echo
 * back through the user-drag path.
 *
 * ## Content-driven sizing is a consumer concern
 *
 * This primitive does not observe content to grow/shrink panels. A
 * consumer that genuinely needs a content-driven *split* would wire up its
 * own observers and call `panelRef.current.requestSize(px)`. (Note: the
 * session-card / gallery prompt entries do NOT use this primitive — they are
 * plain content-sized flex columns; an auto-height editor sizes them
 * natively, no JS.)
 *
 * Laws: [L02] external state enters React through useSyncExternalStore,
 *       [L03] registrations in useLayoutEffect, [L06] appearance via CSS,
 *       [L07] event handlers read refs, [L15] token-driven states,
 *       [L16] pairings declared, [L19] component authoring guide,
 *       [L20] token sovereignty, [L22] DOM-only updates from store
 *       observers, not React state.
 */

import "./tug-split-pane.css";

import React from "react";
import {
  Group,
  type GroupImperativeHandle,
  type Layout,
  Panel,
  type PanelImperativeHandle,
  type PanelSize,
  Separator,
} from "react-resizable-panels";
import { GripHorizontal, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import {
  putSplitPaneLayout,
  readSplitPaneLayout,
  type SplitPaneLayout,
} from "@/settings-api";
import { useTugBoxDisabled } from "./internal/tug-box-context";
import { animate as tugAnimate } from "./tug-animator";

// ---- Persistence ----

const SPLIT_PANE_DOMAIN = "dev.tugapp.tugways.split-pane";

function subscribeSplitPaneDomain(notify: () => void): () => void {
  const client = getTugbankClient();
  if (!client) return () => {};
  return client.onDomainChanged((domain) => {
    if (domain === SPLIT_PANE_DOMAIN) notify();
  });
}

// ---- Write coordination ----

/**
 * Context exposing the two-path coordination primitives from
 * `TugSplitPane` to its descendant `TugSplitPanel` instances.
 *
 * The split-pane has TWO distinct concepts that must never be
 * conflated:
 *
 * 1. **User size** — the percentage the user set by dragging. Persisted
 *    in tugbank. Written only by the user-drag path
 *    (`onLayoutChanged` with sync flag clear). Read via
 *    `getUserSize(panelId)`.
 *
 * 2. **Transient size** — whatever the library is currently displaying.
 *    Written by content-driven auto-resize via
 *    `TugSplitPanelHandle.setTransientSize`. Never persisted. Never
 *    modifies the user size.
 *
 * The sync flag gates the two paths so they never cross:
 * - `setTransientSize` and `restoreUserSize` call `panel.resize()` with
 *   the flag set → the user-drag path bails out, so no userSize update
 *   and no tugbank write happens.
 * - User drag (library pointer handling) fires `onLayoutChanged` with
 *   the flag clear → userSize is updated and tugbank is written.
 *
 * No listener machinery, no echo detection. The flag is set only inside
 * the synchronous window of a `panel.resize()` call; the library's
 * synchronous `onLayoutChanged` dispatch happens inside that window.
 */
interface RegisteredPanelEntry {
  panelRef: React.RefObject<PanelImperativeHandle | null>;
  pinned: boolean;
}

interface TugSplitPaneWriteContextValue {
  syncFlagRef: React.MutableRefObject<boolean>;
  /**
   * The user's persisted size for a given panel, as a percentage
   * (0..100). Returns 0 when the panel has no stored user size (e.g.
   * the pane has no `storageKey`, or the id is unknown).
   */
  getUserSize(panelId: string | number): number;
  /**
   * Register a panel with its enclosing TugSplitPane. Returns an
   * unregister function for use as a `useLayoutEffect` cleanup. The
   * pane reads the registry at `onLayoutChanged` to compute pixel
   * sizes for `pinned` panels, and at mount to drive the pixel-pin
   * restore.
   */
  registerPanel(id: string, entry: RegisteredPanelEntry): () => void;
  /**
   * Persist the group's current layout through the user-drag path —
   * the same code `onLayoutChanged` runs at the end of a native sash
   * drag. An external drag handle (a grip that lives outside the
   * sash — e.g. the Session card's Z2 status-bar grips) applies live
   * sizes through `TugSplitPanelHandle.dragResizePixels` with the
   * gate held, so nothing is written mid-drag, then calls this once
   * on pointer release so the settled layout — flex-grow ratios and
   * pinned pixel sizes — lands in tugbank exactly as a sash drag
   * would. No-ops when the pane has no `storageKey`.
   */
  commitLayout(): void;
}
const TugSplitPaneWriteContext =
  React.createContext<TugSplitPaneWriteContextValue | null>(null);

// Stable fallback for `getUserSize` when a TugSplitPanel is mounted
// outside a TugSplitPane (tests, isolated harnesses). Module-scoped so
// its identity never changes — keeps `useImperativeHandle` stable
// across renders in the standalone case.
const FALLBACK_GET_USER_SIZE = (): number => 0;
const FALLBACK_REGISTER_PANEL = (): (() => void) => () => {};
const FALLBACK_COMMIT_LAYOUT = (): void => {};

// ---- Types ----

/**
 * TugSplitPane orientation. Named after the *dividing line* (matching
 * NSSplitView / VS Code convention), not the axis along which panels
 * are arranged. `horizontal` = horizontal sash, panels stacked
 * top-to-bottom; `vertical` = vertical sash, panels side-by-side.
 *
 * This is the inverse of `react-resizable-panels`' own `orientation`
 * value, which names the axis instead of the divider. The wrapper
 * inverts internally when calling the library.
 */
export type TugSplitPaneOrientation = "horizontal" | "vertical";

/**
 * Size specification for TugSplitPanel's defaultSize / minSize / maxSize.
 *
 * Accepts either a number or a string:
 * - **number** → pixels (e.g. `200` = 200px). Matches the library's v4
 *   convention.
 * - **string with unit suffix** → `"50%"`, `"200px"`, `"4rem"`, `"1.5em"`,
 *   `"30vh"`, `"20vw"`. Supported units: `%`, `px`, `em`, `rem`, `vh`, `vw`.
 * - **string without unit** → percent. `"50"` is equivalent to `"50%"`.
 *
 * Prefer explicit percentage strings (`"60%"`) for proportional layouts
 * so the intent is clear at the call site.
 */
export type TugSplitSize = number | string;

// ---------------------------------------------------------------------------
// TugSplitPane
// ---------------------------------------------------------------------------

/** TugSplitPane props. */
export interface TugSplitPaneProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /**
   * Orientation of the dividing line between panels.
   * - `"horizontal"` (default): horizontal sash, panels stacked top-to-bottom.
   * - `"vertical"`: vertical sash, panels arranged side-by-side.
   * @selector .tug-split-pane-horizontal | .tug-split-pane-vertical
   * @default "horizontal"
   */
  orientation?: TugSplitPaneOrientation;
  /**
   * Disables drag-to-resize on all sashes in this group. Cascades from an
   * enclosing TugBox via TugBoxContext.
   * @selector [data-disabled="true"]
   * @default false
   */
  disabled?: boolean;
  /**
   * Whether to show the grip pill on each sash. Set to `false` to suppress
   * the decorative pill while keeping the sash line visible and fully
   * draggable.
   * @selector [data-show-handle="false"]
   * @default true
   */
  showHandle?: boolean;
  /**
   * Persist the sash layout across reloads under this key in tugbank
   * (domain: `dev.tugapp.tugways.split-pane`). When set, the layout is
   * read on mount via `defaultLayout` and re-saved on layout changes
   * that originate from user drags (not consumer imperative writes).
   *
   * ⚠️ When set, every child TugSplitPanel MUST declare a stable `id` —
   * the stored layout is keyed by panel id.
   *
   * ⚠️ Nested TugSplitPane instances each need their own distinct
   * storageKey. Reusing one key across nested panes would collide.
   */
  storageKey?: string;
  /** TugSplitPanel children. Each child must be a TugSplitPanel element. */
  children: React.ReactNode;
}

export const TugSplitPane = React.forwardRef<HTMLDivElement, TugSplitPaneProps>(
  function TugSplitPane(
    {
      orientation = "horizontal",
      disabled = false,
      showHandle = true,
      storageKey,
      className,
      children,
      ...rest
    },
    ref,
  ) {
    const boxDisabled = useTugBoxDisabled();
    const effectiveDisabled = disabled || boxDisabled;

    // [L02] External state enters React exclusively through
    // `useSyncExternalStore`. `main.tsx` awaits `tugbankClient.ready()`
    // before mount, so the cache is warm and the first snapshot already
    // reflects the stored layout.
    const getSnapshot = React.useCallback((): SplitPaneLayout | null => {
      if (!storageKey) return null;
      const client = getTugbankClient();
      if (!client) return null;
      return readSplitPaneLayout(client, storageKey);
    }, [storageKey]);
    const storedLayout = React.useSyncExternalStore(
      subscribeSplitPaneDomain,
      getSnapshot,
    );
    const storedFlexGrow = storedLayout?.layout;
    const storedPixels = storedLayout?.pixels;

    // Sync flag shared with descendant panels via context. Descendants
    // set it `true` around `panel.resize()` calls from
    // `setTransientSize` / `restoreUserSize`; our `onLayoutChanged`
    // handler checks it to decide which path to take.
    const syncFlagRef = React.useRef(false);

    // --- Group element ref (merged with forwarded outer ref) ---
    //
    // Internal ref used to measure the group's size for pixel
    // computation in `handleLayoutChanged`. Bridges the forwarded
    // outer `ref` with the library's `elementRef` so the same DOM node
    // satisfies both.
    const groupElRef = React.useRef<HTMLDivElement | null>(null);
    const setGroupElRef = React.useCallback(
      (el: HTMLDivElement | null) => {
        groupElRef.current = el;
        if (typeof ref === "function") {
          ref(el);
        } else if (ref) {
          ref.current = el;
        }
      },
      [ref],
    );

    // --- Library group handle ---
    //
    // The imperative `GroupImperativeHandle` (distinct from the DOM
    // `groupElRef` above). `commitLayout` reads `getLayout()` from it
    // to fetch the group's live layout for the external-drag-handle
    // persistence path.
    const groupRef = React.useRef<GroupImperativeHandle | null>(null);

    // --- Panel registry (populated by descendant TugSplitPanels) ---
    //
    // Descendants register themselves in `useLayoutEffect` so the
    // registry is complete before any drag handler fires [L03]. Read
    // by `handleLayoutChanged` (to compute pixel sizes for pinned
    // panels) and by the pixel-pin restore effect (to apply stored
    // pixel sizes via `panel.resize`).
    const registryRef = React.useRef<Map<string, RegisteredPanelEntry>>(
      new Map(),
    );
    const registerPanel = React.useCallback(
      (id: string, entry: RegisteredPanelEntry): (() => void) => {
        registryRef.current.set(id, entry);
        return () => {
          registryRef.current.delete(id);
        };
      },
      [],
    );

    // --- User-size map (the persisted, authoritative dimension) ---
    //
    // Seeded from `storedLayout` at mount and on any external update
    // (tugbank broadcast). Updated synchronously from
    // `handleLayoutChanged` at the end of a user drag. This is the
    // value that `TugSplitPanelHandle.restoreUserSize` snaps back to.
    const userSizeMapRef = React.useRef<Layout>({});
    React.useLayoutEffect(() => {
      if (storedFlexGrow) {
        userSizeMapRef.current = { ...storedFlexGrow };
      }
    }, [storedFlexGrow]);

    const getUserSize = React.useCallback(
      (panelId: string | number): number => {
        return userSizeMapRef.current[String(panelId)] ?? 0;
      },
      [],
    );

    // --- Path A: user drag and library-driven container resize ---
    //
    // The library fires `onLayoutChanged` at pointerup for drags AND
    // when its group ResizeObserver recomputes layout for
    // `preserve-pixel-size` panels. When the sync flag is clear, we're
    // on a user-/library-driven path: update userSize and persist.
    // When the flag is set, we're inside a transient write from
    // `setTransientSize` / `restoreUserSize` / `dragResizePixels` /
    // pixel-pin restore — bail out so neither userSize nor tugbank
    // gets clobbered. (`dragResizePixels`'s commit call re-enters
    // this handler deliberately, with the flag clear, via
    // `commitLayout` below.)
    //
    // For pinned panels (registered with `pinned: true`), we additionally
    // read their pixel size from the layout map and the group's
    // measured size and persist it under `pixels` so the pixel
    // dimension survives reloads and card switches at different
    // container sizes.
    //
    // This is the ONLY place that writes userSize or tugbank. By
    // construction, it cannot run for auto-resize writes.
    const handleLayoutChanged = React.useCallback(
      (layout: Layout) => {
        if (syncFlagRef.current) return;
        userSizeMapRef.current = { ...layout };
        if (!storageKey) return;

        let pixels: Record<string, number> | undefined;
        const groupEl = groupElRef.current;
        if (groupEl) {
          const groupSize =
            orientation === "horizontal"
              ? groupEl.offsetHeight
              : groupEl.offsetWidth;
          if (groupSize > 0) {
            for (const [id, entry] of registryRef.current) {
              if (!entry.pinned) continue;
              const flex = layout[id];
              if (typeof flex !== "number") continue;
              const px = (flex / 100) * groupSize;
              if (!Number.isFinite(px) || px <= 0) continue;
              if (!pixels) pixels = {};
              pixels[id] = px;
            }
          }
        }

        putSplitPaneLayout(storageKey, { layout, pixels });
      },
      [storageKey, orientation],
    );

    // --- Path A, invoked imperatively: external-drag-handle commit ---
    //
    // `commitLayout` routes the group's *current* layout through
    // `handleLayoutChanged` — the one writer of userSize + tugbank.
    // An external drag handle gates its mid-drag resizes (no write)
    // and calls this once on pointer release. The sync flag is clear
    // here (we are outside any `writeGated` window), so the write
    // proceeds. The library's `getLayout()` is the live layout the
    // gated resizes already applied; persisting it mirrors the
    // pointer-up write of a native sash drag.
    const commitLayout = React.useCallback((): void => {
      const group = groupRef.current;
      if (group) handleLayoutChanged(group.getLayout());
    }, [handleLayoutChanged]);

    const contextValue = React.useMemo<TugSplitPaneWriteContextValue>(
      () => ({ syncFlagRef, getUserSize, registerPanel, commitLayout }),
      [getUserSize, registerPanel, commitLayout],
    );

    // --- Pixel-pin restore ---
    //
    // Stored pixel sizes are reapplied imperatively via `panel.resize`
    // [L22] — this is a DOM/library write, not React state. The sync
    // flag gates the resize so it does not echo back through
    // `handleLayoutChanged` and re-persist the same data. Runs after
    // descendant `useLayoutEffect`s (so the registry is populated)
    // and any time `storedPixels` changes (cross-card persistence
    // updates).
    React.useLayoutEffect(() => {
      if (!storedPixels) return;
      for (const [id, entry] of registryRef.current) {
        if (!entry.pinned) continue;
        const px = storedPixels[id];
        if (typeof px !== "number" || px <= 0) continue;
        const panel = entry.panelRef.current;
        if (!panel) continue;
        const currentPx = panel.getSize().inPixels;
        if (Math.abs(currentPx - px) < 0.5) continue;
        syncFlagRef.current = true;
        try {
          panel.resize(`${px}px`);
        } finally {
          syncFlagRef.current = false;
        }
      }
    }, [storedPixels]);

    const GripIcon = orientation === "vertical" ? GripVertical : GripHorizontal;
    const libraryOrientation = orientation === "horizontal" ? "vertical" : "horizontal";

    // Interleave a Separator between each pair of consecutive children.
    // react-resizable-panels requires Separator elements to be direct DOM
    // children of Group — we can't wrap them in a fragment or helper
    // component.
    const childArray = React.Children.toArray(children);
    const interleaved: React.ReactNode[] = [];
    childArray.forEach((child, i) => {
      if (i > 0) {
        interleaved.push(
          <Separator
            key={`tug-split-sash-${i}`}
            className={cn("tug-split-sash", `tug-split-sash-${orientation}`)}
            data-slot="tug-split-sash"
            disabled={effectiveDisabled}
          >
            <span className="tug-split-sash-handle">
              <GripIcon
                className="tug-split-sash-grip"
                aria-hidden="true"
                strokeWidth={2}
              />
            </span>
          </Separator>,
        );
      }
      interleaved.push(child);
    });

    return (
      <TugSplitPaneWriteContext.Provider value={contextValue}>
        <Group
          orientation={libraryOrientation}
          defaultLayout={storedFlexGrow ?? undefined}
          elementRef={setGroupElRef}
          groupRef={groupRef}
          onLayoutChanged={handleLayoutChanged}
          className={cn("tug-split-pane", `tug-split-pane-${orientation}`, className)}
          data-slot="tug-split-pane"
          data-disabled={effectiveDisabled || undefined}
          data-show-handle={showHandle ? undefined : "false"}
          {...rest}
        >
          {interleaved}
        </Group>
      </TugSplitPaneWriteContext.Provider>
    );
  },
);

// ---------------------------------------------------------------------------
// TugSplitPanel
// ---------------------------------------------------------------------------

/**
 * Options for size-change imperatives on `TugSplitPanelHandle`.
 *
 * `animated` is strictly opt-in. Defaults to `false`, meaning the size
 * change applies instantly. Automatic callers (the content-driven hook)
 * leave the option off; explicit user actions (e.g. a submit handler, a
 * grow/shrink button) pass `{ animated: true }` to get a short WAAPI
 * tween on flex-grow.
 *
 * Animation uses `tug-animator` with a per-panel keyed slot so a fresh
 * animation cancels any previous one on the same panel (snap-to-end).
 */
export interface TugSplitPanelSizeChangeOptions {
  /**
   * When `true`, animate the size change via `tug-animator` / WAAPI.
   * The animation is a visual overlay — the library's store and the
   * DOM inline `flex-grow` are both set to the target synchronously,
   * then WAAPI tweens from the previous visual value to the target.
   * When `false` (default), the change applies instantly.
   */
  animated?: boolean;
}

/**
 * Imperative handle exposed by `TugSplitPanel` via `forwardRef`.
 *
 * All sizes are expressed as a percentage of the parent group (0..100).
 * This matches the library's internal representation, the on-wire
 * format stored in tugbank, and the `Layout` type emitted by the
 * library's `onLayoutChanged` callback. No pixel conversions happen at
 * this API — consumers that observe content in pixels (e.g.
 * `scrollHeight`) must translate to percentages themselves at the
 * boundary.
 *
 * The handle distinguishes TWO separate concerns:
 *
 * - `setTransientSize(pct, options?)` — write a transient display
 *   size. Used for content-driven auto-resize. Never persisted. Never
 *   modifies the user's saved dimension.
 * - `restoreUserSize(options?)` — snap back to the user's saved
 *   dimension (as last set by a drag, read from `TugSplitPane`'s
 *   userSize map).
 *
 * Both methods accept `{ animated: true }` to opt into a short visual
 * tween; default behavior is instant. User drags take a separate path
 * entirely (via `TugSplitPane`'s `onLayoutChanged`) and never go
 * through this handle.
 */
export interface TugSplitPanelHandle {
  /**
   * Current library-displayed size as a percentage (0..100). Reads
   * the library's store synchronously.
   */
  getSize(): number;
  /**
   * Current library-displayed size in CSS pixels. Companion to
   * `getSize()` for callers that work in pixels — e.g. an external
   * drag handle tracking pointer deltas.
   */
  getSizePixels(): number;
  /**
   * Resize the panel to a pixel size as part of an external drag
   * gesture — a drag handle that lives outside the sash (the Dev
   * card's Z2 status-bar grips).
   *
   * While `commit` is false (the default) the resize is visual-only:
   * gated exactly like `setTransientSize`, so neither the user-size
   * map nor tugbank is touched — the right behavior for the stream of
   * pointer-move updates during a drag. Pass `commit: true` on the
   * final call of the gesture (pointer release) to additionally route
   * the settled layout through the persistence path, the same write a
   * native sash drag performs at pointer-up.
   *
   * The library clamps the request to the panel's `minSize` /
   * `maxSize`; the return value is the pixel size actually applied.
   */
  dragResizePixels(px: number, options?: { commit?: boolean }): number;
  /**
   * Write a transient display size (0..100, percentage). Used for
   * content-driven auto-resize.
   *
   * NEVER persisted. NEVER modifies the user's saved dimension. The
   * write is gated by a sync flag so the surrounding `TugSplitPane`'s
   * user-drag path bails out — there is no code path from this method
   * to `putSplitPaneLayout` or to userSize-map updates. Returns the
   * clamped percentage the library actually applied.
   */
  setTransientSize(pct: number, options?: TugSplitPanelSizeChangeOptions): number;
  /**
   * Snap the panel back to the user's saved dimension — the value the
   * user last set by dragging (or the library's resolved default, if
   * they've never dragged). Reads from `TugSplitPane`'s userSize map.
   *
   * NEVER persisted. NEVER modifies the user's saved dimension. The
   * write is gated by the same sync flag as `setTransientSize` so no
   * cross-talk with the user-drag path is possible. Returns the
   * percentage actually applied (0 if no user size is available).
   */
  restoreUserSize(options?: TugSplitPanelSizeChangeOptions): number;
}

/** TugSplitPanel props. */
export interface TugSplitPanelProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /**
   * Initial size. Default: auto-assigned equally across siblings by the
   * library. See {@link TugSplitSize} for accepted value formats.
   */
  defaultSize?: TugSplitSize;
  /**
   * Minimum size. Enforced during drag and on container resize.
   * Default: 0. See {@link TugSplitSize} for accepted value formats.
   */
  minSize?: TugSplitSize;
  /**
   * Maximum size. Enforced during drag and on container resize.
   * Default: 100%. See {@link TugSplitSize} for accepted value formats.
   */
  maxSize?: TugSplitSize;
  /**
   * How this panel behaves when the parent group is resized.
   *
   * - `"preserve-relative-size"` (default): the panel's percentage of
   *   the group is preserved, so it scales proportionally with the
   *   group.
   * - `"preserve-pixel-size"`: the panel's pixel size is held constant
   *   on group resize; relative-size siblings absorb the delta.
   *
   * When set to `"preserve-pixel-size"`, the enclosing TugSplitPane
   * also persists this panel's pixel size in tugbank (under `pixels`
   * within the layout entry) so the dimension is preserved across
   * card switches and reloads at different container sizes. The
   * library requires at least one sibling with the default
   * `"preserve-relative-size"` behavior.
   */
  groupResizeBehavior?: "preserve-relative-size" | "preserve-pixel-size";
  /**
   * Panel can snap closed when the user drags its neighboring sash past
   * this panel's `minSize`. Default: false.
   */
  collapsible?: boolean;
  /**
   * Size this panel takes when collapsed. Default: 0. Only meaningful
   * when `collapsible` is true.
   */
  collapsedSize?: TugSplitSize;
  /**
   * Fires when the panel's collapsed state toggles. State-mirror callback.
   */
  onCollapsedChange?: (collapsed: boolean) => void;
  /** Panel content. */
  children?: React.ReactNode;
}

export const TugSplitPanel = React.forwardRef<TugSplitPanelHandle, TugSplitPanelProps>(
  function TugSplitPanel(
    {
      id,
      defaultSize,
      minSize,
      maxSize,
      groupResizeBehavior,
      collapsible,
      collapsedSize,
      onCollapsedChange,
      className,
      children,
      ...rest
    },
    ref,
  ) {
    const panelRef = React.useRef<PanelImperativeHandle | null>(null);
    const panelElementRef = React.useRef<HTMLDivElement | null>(null);
    const wasCollapsedRef = React.useRef(false);

    // Stable id. Explicit `id` wins (required for `storageKey`
    // round-trip); falls back to `useId` otherwise. The same value is
    // passed to the library `Panel` and used as the key into
    // `TugSplitPane`'s userSize map.
    const fallbackId = React.useId();
    const resolvedId = id ?? fallbackId;

    // Shared primitives from the enclosing `TugSplitPane`. Fallback to
    // a local no-op context when this panel is mounted standalone
    // (tests, isolated harnesses) — no persistence happens outside a
    // TugSplitPane so the flag and user-size lookups are moot, but the
    // imperative API still works.
    const writeContext = React.useContext(TugSplitPaneWriteContext);
    const localSyncFlagRef = React.useRef(false);
    const syncFlagRef = writeContext?.syncFlagRef ?? localSyncFlagRef;
    const getUserSize = writeContext?.getUserSize ?? FALLBACK_GET_USER_SIZE;
    const registerPanel = writeContext?.registerPanel ?? FALLBACK_REGISTER_PANEL;
    const commitLayout = writeContext?.commitLayout ?? FALLBACK_COMMIT_LAYOUT;

    // Register with the enclosing TugSplitPane so it can read this
    // panel's imperative handle for pixel-aware persistence and pixel-
    // pin restore. [L03] useLayoutEffect — must complete before any
    // pointer-driven `onLayoutChanged` fires.
    const pinned = groupResizeBehavior === "preserve-pixel-size";
    React.useLayoutEffect(() => {
      const resolvedIdStr = String(resolvedId);
      return registerPanel(resolvedIdStr, { panelRef, pinned });
    }, [registerPanel, resolvedId, pinned]);

    // onResize drives the (synthesized) collapse-change callback.
    const handleResize = React.useCallback(
      (_size: PanelSize, _id: string | number | undefined, _prev: PanelSize | undefined) => {
        const panel = panelRef.current;
        if (!panel || !onCollapsedChange) return;
        const isCollapsed = panel.isCollapsed();
        if (isCollapsed !== wasCollapsedRef.current) {
          wasCollapsedRef.current = isCollapsed;
          onCollapsedChange(isCollapsed);
        }
      },
      [onCollapsedChange],
    );

    // Helper: apply a percentage with the sync flag set so the
    // user-drag path in `TugSplitPane` bails out. Shared by
    // `setTransientSize` and `restoreUserSize` — they have different
    // callers and intents, but the underlying mechanism (gated library
    // write) is identical.
    const writeGated = React.useCallback((pct: number): number => {
      const panel = panelRef.current;
      if (!panel) return 0;
      syncFlagRef.current = true;
      try {
        panel.resize(`${pct}%`);
      } finally {
        syncFlagRef.current = false;
      }
      return panel.getSize().asPercentage;
    }, [syncFlagRef]);

    // Pixel-valued sibling of `writeGated` — same gated mechanism,
    // pixel input/output instead of percentage. Used by the external-
    // drag-handle path (`dragResizePixels`), which tracks the sash in
    // pixels because the pinned entry panel is pixel-sized.
    const writeGatedPixels = React.useCallback((px: number): number => {
      const panel = panelRef.current;
      if (!panel) return 0;
      syncFlagRef.current = true;
      try {
        panel.resize(`${px}px`);
      } finally {
        syncFlagRef.current = false;
      }
      return panel.getSize().inPixels;
    }, [syncFlagRef]);

    // Helper: run a short flex-grow tween via TugAnimator / WAAPI.
    // The library store + inline style are already at the target
    // (writeGated ran before this); WAAPI overlays the visual tween
    // from the previous value to the target. `fill: "none"` means the
    // animation leaves no residue — inline style (at target) shows
    // through after the tween completes.
    //
    // Slot key is per-panel so a repeated animation on the same panel
    // cancels the previous via snap-to-end; different panels animate
    // independently.
    const animateFlexGrow = React.useCallback(
      (fromPct: number, toPct: number): void => {
        const panelEl = panelElementRef.current;
        if (!panelEl) return;
        if (Math.abs(fromPct - toPct) < 0.5) return;
        tugAnimate(
          panelEl,
          [{ flexGrow: String(fromPct) }, { flexGrow: String(toPct) }],
          {
            duration: "--tug-motion-duration-moderate",
            easing: "cubic-bezier(0.2, 0, 0, 1)",
            key: `tug-split-panel-resize-${resolvedId}`,
            fill: "none",
          },
        );
      },
      [resolvedId],
    );

    React.useImperativeHandle(
      ref,
      (): TugSplitPanelHandle => ({
        getSize() {
          return panelRef.current?.getSize().asPercentage ?? 0;
        },
        getSizePixels() {
          return panelRef.current?.getSize().inPixels ?? 0;
        },
        dragResizePixels(px, options) {
          // Gated resize — visual only — for the mid-drag stream. On
          // the final call (`commit`), `commitLayout` then persists
          // the settled layout exactly as a native sash drag's
          // pointer-up does. Gating the resize even on the commit
          // call keeps persistence to a single deterministic write.
          const applied = writeGatedPixels(px);
          if (options?.commit) commitLayout();
          return applied;
        },
        setTransientSize(pct, options) {
          const fromPct = panelRef.current?.getSize().asPercentage ?? 0;
          const applied = writeGated(pct);
          if (options?.animated) animateFlexGrow(fromPct, applied);
          return applied;
        },
        restoreUserSize(options) {
          const userPct = getUserSize(resolvedId);
          if (userPct <= 0) return panelRef.current?.getSize().asPercentage ?? 0;
          const fromPct = panelRef.current?.getSize().asPercentage ?? 0;
          const applied = writeGated(userPct);
          if (options?.animated) animateFlexGrow(fromPct, applied);
          return applied;
        },
      }),
      [
        writeGated,
        writeGatedPixels,
        commitLayout,
        animateFlexGrow,
        getUserSize,
        resolvedId,
      ],
    );

    return (
      <Panel
        id={resolvedId}
        defaultSize={defaultSize}
        minSize={minSize}
        maxSize={maxSize}
        groupResizeBehavior={groupResizeBehavior}
        collapsible={collapsible}
        collapsedSize={collapsedSize}
        panelRef={panelRef}
        onResize={onCollapsedChange ? handleResize : undefined}
        elementRef={panelElementRef}
        className={cn("tug-split-panel", className)}
        data-slot="tug-split-panel"
        {...rest}
      >
        {children}
      </Panel>
    );
  },
);

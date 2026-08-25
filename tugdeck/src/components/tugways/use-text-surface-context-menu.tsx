/**
 * useTextSurfaceContextMenu — single source of truth for right-click
 * context menus on text-bearing surfaces.
 *
 * Consolidates the menu-state, the secondary-click guard, the contextmenu
 * pipeline, and the `TugEditorContextMenu` render across four surfaces: the
 * editor host (`tug-text-editor`), the markdown view (`tug-markdown-view`), the
 * native-input responder (`use-text-input-responder`), and the transcript cells
 * (`session-card-transcript`). The consumer's `TextSelectionAdapter` is query-only
 * (`hasRangedSelection` / `getSelectedText` / `selectAll`); this hook owns the
 * React-side wiring that's identical across them.
 *
 * Each consumer:
 *   - Constructs an adapter for its surface and passes it by ref.
 *   - Calls `useTextSurfaceContextMenu({ adapterRef, capabilities, ... })`.
 *   - Attaches the returned `onMouseDown` / `onContextMenu` to its surface
 *     element (React event props or a native listener).
 *   - Renders the returned `menu` somewhere in its tree (it portals).
 *   - Registers its own COPY/CUT/PASTE/SELECT_ALL handlers on the responder
 *     chain (surface-specific: CodeMirror's clipboardExt, native execCommand,
 *     virtualized select-all CSS visual, etc.).
 *
 * Right-click pipeline:
 *
 *   1. `onMouseDown(event)` — **stop the secondary-click selection clobber at
 *      the source.** For a secondary-click (right-click or macOS Control-click =
 *      button 0 + ctrlKey) over a *ranged* selection it calls `preventDefault`,
 *      so the surface never moves the caret to the click point on mousedown
 *      (which would collapse the selection). No snapshot, no restore — the
 *      selection simply isn't disturbed. (The CM6 editor stops its own pointer
 *      selection with an equivalent guard in its `domEventHandlers.mousedown`.)
 *      When the optional `suppressSelectionChange` predicate claims the
 *      target is one indivisible entity — a transcript command span, whose
 *      menu items all act on the whole command — this step also *snapshots*
 *      the selection. `preventDefault` is no help there: WebKit picks the
 *      closest word inside `sendContextMenuEvent` itself, ahead of the event
 *      it dispatches to us, so the sub-word is already painted by the time
 *      any handler runs and the only honest remedy is to put back what was
 *      there.
 *
 *   2. `onContextMenu(event)` — `preventDefault` (suppress the system menu),
 *      restore the step-1 snapshot when there is one (clearing the
 *      smart-select, or handing back a range the user had), sample
 *      `hasSelection` from the live selection
 *      (`adapterRef.current.hasRangedSelection()`), open the menu at the click
 *      point. The selection is otherwise already intact from step 1.
 *
 *   3. `hasSelection` drives `buildTextEditingMenuItems({ hasSelection, canEdit
 *      })` so Cut / Copy / Paste / Select All enablement is consistent across
 *      every surface. The same step samples what Look Up in Dictionary would
 *      define — the selected text and the point its panel anchors to — and
 *      carries it on the item, because a menu dismissal can retire the
 *      selection before the action's handler runs.
 *
 * Optional `hasSelectionOverride`: a consumer can provide a function
 * that the hook calls *instead of* sampling from the adapter. The
 * markdown view uses this to fold its "logical select-all" CSS-visual
 * flag into Copy enablement — its virtualized select-all paints a CSS
 * class instead of holding a DOM Selection, so the menu's Cut / Copy
 * gates need to reflect the flag, not just the DOM range.
 *
 * Tuglaws cross-check:
 *   - [L02] no external store enters via this hook; menu open/close
 *     is `useState` (data the menu owns).
 *   - [L06] menu visibility (open / closed) is React state because the
 *     menu's lifecycle is structural — the portal mounts and
 *     unmounts based on it. Selection mutations stay in the DOM
 *     via the adapter; we never mirror selection into React state.
 *   - [L07] handlers register via the consumer's `useResponder` and
 *     are reached via the menu's `useControlDispatch` (targeted to
 *     `parentId`) inside `TugEditorContextMenu`; this hook never
 *     closes over stale handler closures — it doesn't own handlers.
 *   - [L11] the menu items dispatch typed `TugAction`s to the parent
 *     responder via `useControlDispatch` (`sendToTarget(parentId)`),
 *     the canonical "control dispatches to its parent responder"
 *     shape used by every other tugway control. The consumer must
 *     render the returned `menu` inside its own `<ResponderScope>`
 *     so `parentId` resolves to the consumer's responder; the
 *     editor, the markdown view, and the transcript cells already
 *     do this, and `useTextInputResponder` wraps the menu inside
 *     the input's scope before returning it.
 *   - [L12] selection mutations route through the adapter, which
 *     respects whatever boundary discipline `SelectionGuard` enforces
 *     for the surface's card.
 *   - [L19] component-authoring conventions: file pair (.tsx + this
 *     module docstring), exported props interface, no `data-slot`
 *     since the hook renders no DOM of its own (the menu's slot is
 *     `tug-editor-context-menu`).
 *   - [L23] adapters JS-commit selection so user-visible state
 *     survives the `preventDefault` that suppresses the system menu.
 *   - [L24] zone discipline: menuState (data) → React state, menu
 *     visibility (structure) → React render, menu hover paint
 *     (appearance) → CSS in tug-menu.css.
 */

import React, { useCallback, useMemo, useRef, useState } from "react";

import {
  TugEditorContextMenu,
  type TugEditorContextMenuEntry,
} from "./tug-editor-context-menu";
import {
  buildTextEditingMenuItems,
  type TextEditingMenuCapabilities,
} from "./text-editing-menu";
import type { TextSelectionAdapter } from "./text-selection-adapter";
import type { DictionaryLookupRequest } from "@/lib/dictionary-lookup";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UseTextSurfaceContextMenuOptions {
  /**
   * **Ref** to the surface's selection adapter, dereferenced live at event time
   * ([L07]) — the adapter is created in a layout effect after the surface mounts,
   * so a render-time snapshot can be stale in the event handlers. The hook reads
   * `adapterRef.current.hasRangedSelection()` to (a) decide whether a
   * secondary-click `mousedown` should `preventDefault` (so the surface never
   * collapses a ranged selection — the menu acts on the live selection), and (b)
   * gate the menu's Cut / Copy. `null` for surfaces with no selection model (the
   * markdown view), which rely on `hasSelectionOverride`.
   */
  adapterRef: React.RefObject<TextSelectionAdapter | null> | null;

  /**
   * Optional override of the `hasSelection` sample. When supplied, the hook
   * calls this instead of `adapterRef.current.hasRangedSelection()` for menu
   * enablement. Used by `tug-markdown-view` to fold its `selectAllActiveRef`
   * (CSS-visual select-all flag) into Copy enablement.
   */
  hasSelectionOverride?: () => boolean;

  /**
   * Optional target-dependent entries, sampled from the `contextmenu`
   * event at open time and prepended above the standard editing items
   * (with a separator). Lets a surface offer context-specific actions —
   * e.g. the prompt editor's "Open in Editor" when the right-click
   * landed on a path-bearing file atom. Return `[]` for no extras.
   */
  extraEntries?: (event: MouseEvent) => TugEditorContextMenuEntry[];

  /**
   * Optional per-open predicate: when it returns `true`, the standard
   * editing block (Cut / Copy / Paste / … / Select All) is omitted and
   * the menu shows ONLY the {@link extraEntries}. Sampled from the same
   * `contextmenu` event. The transcript uses this so a right-click on a
   * command span shows a single, unambiguous command Copy / Copy as Plain
   * Text — never a second, selection-scoped Copy that would copy WebKit's
   * smart-selected sub-word instead of the whole command.
   */
  hideStandardItems?: (event: MouseEvent) => boolean;

  /**
   * Optional per-click predicate: when it returns `true`, the
   * secondary-click `mousedown` is `preventDefault`ed even with no ranged
   * selection, so the browser's smart-select never runs. The transcript
   * uses it for the kinds the annotator marks as whole entities — a
   * right-click on a command opens a menu whose every item acts on the
   * whole command, so highlighting one word inside it is a lie about what
   * the gesture is about to do.
   */
  suppressSelectionChange?: (event: MouseEvent) => boolean;
}

export interface UseTextSurfaceContextMenuResult {
  /**
   * Mousedown handler. Attach to the surface element (native listener or React
   * prop). For a secondary-click (right-click or macOS Control-click) over a
   * ranged selection it calls `preventDefault`, which stops the surface from
   * collapsing the selection on the click — the context menu then acts on the
   * live selection. A no-op for ordinary clicks and for collapsed-caret clicks
   * (so a plain secondary-click still positions the caret for Paste).
   */
  onMouseDown: (event: MouseEvent) => void;

  /**
   * Contextmenu handler. Attach to the surface element. Calls `preventDefault`
   * (suppress the system menu), computes `hasSelection`, opens the menu at the
   * click point.
   */
  onContextMenu: (event: MouseEvent) => void;

  /**
   * Render this in the consumer's tree. The menu portals to the
   * canvas overlay, so its DOM position doesn't matter — but its
   * React-tree position does control parent-context lookups for any
   * child responders inside the menu (currently none, but kept
   * consistent with the rest of the chain pattern).
   */
  menu: React.ReactNode;

  /**
   * Imperative close. Useful for consumer-driven dismissal (e.g.,
   * a programmatic action that should also close any open menu).
   */
  closeMenu: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface MenuState {
  x: number;
  y: number;
  hasSelection: boolean;
  /** Target-dependent entries sampled at open time (may be empty). */
  extra: TugEditorContextMenuEntry[];
  /** When true, show only `extra` — omit the standard editing block. */
  hideStandard: boolean;
  /**
   * What Look Up in Dictionary would define, sampled at open time, or `null`
   * when the selection yields no text. Sampled here rather than read at
   * dispatch time because the menu's own dismissal can retire the selection
   * before the handler runs.
   */
  lookup: DictionaryLookupRequest | null;
}

/**
 * What the selection would hand the system dictionary: its text, and the
 * point the definition panel anchors to.
 *
 * The anchor is the bottom-left of the selection's bounding rect, which
 * approximates the baseline origin of its first character — what AppKit's
 * `showDefinition(for:at:)` asks for, so the panel points at the word rather
 * than at wherever the cursor happened to be. A selection with no measurable
 * rect falls back to the click point.
 */
function sampleDictionaryLookup(
  adapter: TextSelectionAdapter | null,
  event: MouseEvent,
): DictionaryLookupRequest | null {
  const sel = window.getSelection();
  const text =
    adapter !== null ? adapter.getSelectedText() : (sel?.toString() ?? "");
  if (text.trim() === "") return null;
  if (sel !== null && sel.rangeCount > 0) {
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      return { text, x: rect.left, y: rect.bottom };
    }
  }
  return { text, x: event.clientX, y: event.clientY };
}

/**
 * The live selection as detached clones, or `null` when there is none.
 * Cloning matters: the live `Range` objects mutate as the selection moves,
 * so holding them would remember the smart-select rather than what preceded
 * it.
 */
function snapshotSelection(): Range[] | null {
  const sel = window.getSelection();
  if (sel === null || sel.rangeCount === 0) return null;
  const ranges: Range[] = [];
  for (let i = 0; i < sel.rangeCount; i += 1) {
    ranges.push(sel.getRangeAt(i).cloneRange());
  }
  return ranges;
}

/** Put a {@link snapshotSelection} result back, or clear when it was empty. */
function restoreSelection(ranges: Range[] | null): void {
  const sel = window.getSelection();
  if (sel === null) return;
  sel.removeAllRanges();
  if (ranges === null) return;
  for (const range of ranges) sel.addRange(range);
}

export function useTextSurfaceContextMenu(
  options: UseTextSurfaceContextMenuOptions,
): UseTextSurfaceContextMenuResult {
  const {
    adapterRef,
    hasSelectionOverride,
    extraEntries,
    hideStandardItems,
    suppressSelectionChange,
  } = options;

  // The single piece of React state the hook owns: open/closed +
  // anchor + hasSelection sample. `null` means closed. Open is
  // structural (the portal mounts / unmounts based on it) so it
  // belongs in React state per [L24].
  const [menuState, setMenuState] = useState<MenuState | null>(null);

  // The selection as it stood before a whole-entity secondary click, parked
  // by `onMouseDown` and consumed by `onContextMenu`. `null` means the last
  // secondary click was not on a whole-entity target and the selection is
  // the browser's business as usual; a set `ranges: null` means there was
  // no selection to keep, which is itself what gets restored.
  const preClickRangesRef = useRef<{ ranges: Range[] | null } | null>(null);

  const closeMenu = useCallback(() => {
    setMenuState(null);
  }, []);

  // Mousedown — stop the secondary-click selection clobber at the source. A
  // secondary-click (right-click or macOS Control-click = button 0 + ctrlKey)
  // over a ranged selection otherwise lets the surface move the caret to the
  // click point on mousedown, collapsing the selection before the menu's
  // Cut / Copy can act. preventDefault keeps the selection intact; the OS
  // contextmenu still fires, so the menu opens. Guarded on a live ranged
  // selection so a plain-caret secondary-click still positions the caret.
  const onMouseDown = useCallback(
    (event: MouseEvent) => {
      const adapter = adapterRef?.current ?? null;
      const isSecondaryClick =
        event.button === 2 || (event.button === 0 && event.ctrlKey);
      if (!isSecondaryClick) return;
      // A whole-entity target: remember the selection as it stands BEFORE
      // WebKit's contextual smart-select gets to it, so `onContextMenu` can
      // put it back. `preventDefault` cannot help here — WebKit selects the
      // closest word inside `sendContextMenuEvent` itself, ahead of the
      // event it dispatches to us — so the only honest fix is to restore.
      preClickRangesRef.current =
        suppressSelectionChange?.(event) === true
          ? { ranges: snapshotSelection() }
          : null;
      if (adapter?.hasRangedSelection() ?? false) {
        event.preventDefault();
      }
    },
    [adapterRef, suppressSelectionChange],
  );

  // Contextmenu — suppress the system menu, sample hasSelection from the live
  // selection, open the menu. No snapshot/restore: the mousedown above already
  // kept the selection from collapsing.
  const onContextMenu = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      // Undo the browser's contextual word-select on a whole-entity target:
      // the click's job was to name the entity, not to carve a word out of
      // it, and whatever the user had selected before is still theirs.
      const preClick = preClickRangesRef.current;
      preClickRangesRef.current = null;
      if (preClick !== null) restoreSelection(preClick.ranges);
      let hasSelection = adapterRef?.current?.hasRangedSelection() ?? false;
      if (hasSelectionOverride !== undefined) {
        hasSelection = hasSelectionOverride();
      }
      setMenuState({
        x: event.clientX,
        y: event.clientY,
        hasSelection,
        extra: extraEntries?.(event) ?? [],
        hideStandard: hideStandardItems?.(event) ?? false,
        lookup: sampleDictionaryLookup(adapterRef?.current ?? null, event),
      });
    },
    [adapterRef, hasSelectionOverride, extraEntries, hideStandardItems],
  );

  // Build the menu items via the shared builder so every surface
  // shows the same labels, shortcuts, and order. Disabled state
  // follows from capabilities + hasSelection. Target-dependent
  // extras (sampled at open time) sit above the standard block.
  const items = useMemo<TugEditorContextMenuEntry[]>(() => {
    const extra = menuState?.extra ?? [];
    // Command right-click ([hideStandard]): show only the target-dependent
    // entries, never the standard editing block.
    if (menuState?.hideStandard === true) return extra;
    // Editability is no longer the caller's to assert: it comes from the
    // command table's validity over the chain, which is the same answer the
    // native Edit menu is gated on. Only the selection is sampled here,
    // because only a menu built at open time can read it accurately.
    const standard = buildTextEditingMenuItems({
      hasSelection: menuState?.hasSelection ?? false,
      lookup: menuState?.lookup ?? null,
    }) as TugEditorContextMenuEntry[];
    return extra.length > 0
      ? [...extra, { type: "separator" }, ...standard]
      : standard;
  }, [
    menuState?.hasSelection,
    menuState?.extra,
    menuState?.hideStandard,
    menuState?.lookup,
  ]);

  // Only mount the menu component when there's an open state.
  // `TugEditorContextMenu` calls `useRequiredResponderChain` at the
  // top of its body — mounting it outside a chain provider throws,
  // even with `open: false`. Conditional mount mirrors the legacy
  // pattern (`{menuState !== null && <TugEditorContextMenu />}`) so
  // unit tests and standalone harnesses that never open the menu
  // don't need a chain provider just to instantiate the consumer.
  const menu =
    menuState !== null ? (
      <TugEditorContextMenu
        open
        x={menuState.x}
        y={menuState.y}
        items={items}
        onClose={closeMenu}
      />
    ) : null;

  return {
    onMouseDown,
    onContextMenu,
    menu,
    closeMenu,
  };
}

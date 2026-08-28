/**
 * TugTextEditor — CodeMirror 6-backed text editing substrate.
 *
 * The lower-level editing primitive that backs higher-level tug
 * components. Built on an `EditorView` from CodeMirror 6: the
 * React shell owns mount and dispose, observes via
 * `EditorView.updateListener`, and exposes an imperative delegate
 * via `ref`.
 *
 * Owns the document, caret, selection, and embedded atoms — the state
 * that editing actions (cut, copy, paste, selectAll, undo, redo,
 * insertAtom, submit) mutate. Per [L11], `TugTextEditor` is the responder
 * that registers handlers for those actions on its owned state. The
 * responder registration is what binds Cmd-A / Cmd-C / Cmd-X / Cmd-V
 * / Cmd-Z / Cmd-Shift-Z to the editor: those keystrokes are routed
 * through the document-level capture-phase pipeline in
 * `responder-chain-provider.tsx`, which calls `preventDefault` for
 * every match (`preventDefaultOnMatch`) so the browser's native
 * handling is suppressed and the responder chain owns the semantics.
 * Without responder registration the suppressed default leaves the
 * keystrokes inert — CM6's own keymap never sees them because
 * `event.defaultPrevented` is already true by the time the event
 * reaches `contentDOM`.
 *
 * Laws: [L01] one root.render() at mount; CM6 manages its own DOM
 *        tree internally and is never re-rendered through React,
 *        [L02] atom segments, decoration set, keymap policy, and
 *        typeahead state live in CM6 (StateField + closure-captured
 *        refs), never in React state, [L03] mount, dispose, the
 *        keymap-config mirror, the completion-providers mirror,
 *        and the typeahead state subscription run in
 *        `useLayoutEffect`, [L04] popup position is read from CM6
 *        via `coordsAtPos`, never via React-state-driven layout,
 *        [L06] all editor appearance — including the typeahead
 *        popup body — flows through CSS and direct DOM, never
 *        React state, [L07] delegate methods, keymap handlers, the
 *        completion provider thunk, and the typeahead-change
 *        observer ref read their state at call time, [L11]
 *        responder for editing actions (including atom insert /
 *        clipboard / submit / history-nav) on the owned document,
 *        selection, atom set, and typeahead session — popup items
 *        dispatch directly into the substrate's accept helper
 *        because the popup is a substrate-internal UI surface,
 *        [L15] token-driven control states, [L19] component
 *        authoring guide, [L20] popup uses
 *        `tug-completion-menu`'s own tokens — no token-slot
 *        violations, [L21] CodeMirror 6 (MIT) — see
 *        `THIRD_PARTY_NOTICES.md`, [L22] theme-change subscription,
 *        typeahead state observer, and async completion-provider
 *        results all stream through CM6 transactions and direct
 *        DOM updates — never through React state, [L24] `viewRef`,
 *        `hostRef`, `popupRef`, `keymapConfigRef`,
 *        `completionProvidersRef` are local-data refs; CM6 owns
 *        document, selection, atom-decoration, and typeahead
 *        state; appearance via CSS / DOM.
 *
 * StrictMode lifecycle: the `EditorView` is constructed inside a
 * `useLayoutEffect` with empty deps, stored on `viewRef`, and
 * disposed in the cleanup. React 19 StrictMode runs mount →
 * cleanup → mount in dev; each pass constructs a fresh view, the
 * prior cleanup destroys the prior view, and `viewRef.current`
 * is `null` between passes so callers see `view() === null`
 * rather than a destroyed view. Pattern matches the standard CM6
 * + React integration used by `@uiw/react-codemirror` and similar
 * wrappers.
 */

import "./tug-text-editor.css";
// The substrate uses tug-completion-menu's CSS classes for the
// typeahead popup so the surface matches `tug-prompt-input`.
import "./tug-completion-menu.css";

import React, {
  useCallback,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Compartment, EditorSelection, EditorState, Transaction } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLineGutter,
  keymap,
  placeholder as cmPlaceholder,
  ViewPlugin,
} from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import {
  cursorGroupBackward,
  cursorGroupForward,
  defaultKeymap,
  deleteGroupBackward,
  deleteLineBoundaryBackward,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  redoDepth,
  selectAll,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { cn } from "@/lib/utils";
import { quoteMarkdown, stripMarkdown } from "@/lib/paste-transforms";
import { useCanvasOverlay } from "@/lib/use-canvas-overlay";
import { undoMenuStatePlugin } from "./tug-text-editor/undo-menu-state-plugin";
import { loadMarkdownTextStyling } from "./tug-text-editor/markdown-text-styling";
import { sessionNameStore } from "@/lib/session-name-store";
import { subscribeThemeChange, unsubscribeThemeChange } from "@/theme-tokens";
import type { AtomSegment } from "@/lib/tug-atom-img";
import type { AtomBytesStore } from "@/lib/atom-bytes-store";
import type { AtomPathRoots } from "@/lib/atom-file-path";
import type { HistoryProvider, InputAction } from "@/lib/tug-text-types";
import {
  hasNativeClipboardBridge,
  readClipboardViaNative,
  writeClipboardViaNative,
} from "@/lib/tug-native-clipboard";
import { tugTheme } from "./tug-text-editor/theme";
import { hostFocusMirror } from "./tug-text-editor/host-state";
import { hostClickToCaret } from "./tug-text-editor/host-click";
import {
  atomBytesStoreFacet,
  atomPathRootsFacet,
  atomDecorationField,
  atomInvertedEffects,
  getAtomsInRange,
  insertAtomAtSelection,
  pendingAtomSyncPlugin,
  pendingAtomTheme,
  regenerateAtomsEffect,
  selectedAtomSyncPlugin,
} from "./tug-text-editor/atom-decoration";
import {
  argumentHintPlugin,
  argumentHintRefreshFacet,
  argumentHintResolverFacet,
  argumentHintTheme,
  type ArgumentHintRefreshSource,
  type ArgumentHintResolver,
} from "./tug-text-editor/argument-hint-extension";
import {
  inlineCommandGhostKeymap,
  inlineCommandGhostPlugin,
  inlineCommandGhostTheme,
  inlineCommandMatcherFacet,
} from "./tug-text-editor/inline-command-completion";
import type { InlineCommandMatcher } from "@/lib/inline-command-ghost";
import { atomicRangesExt } from "./tug-text-editor/atomic-ranges";
import { commandAtomDemotionFilter } from "./tug-text-editor/atom-integrity";
import { atomTypeOverExt } from "./tug-text-editor/atom-type-over";
import { atomBindExt } from "./tug-text-editor/atom-bind";
import {
  clipboardExtension,
  insertSidecar,
  parseClipboardSidecar,
  serializeClipboard,
  tryInsertLeadingCommandPaste,
  type PastedCommandResolver,
} from "./tug-text-editor/clipboard-filters";
import { tugDropExtension } from "./tug-text-editor/drop-extension";
import { createCMSelectionAdapter } from "./tug-text-editor/selection-adapter";
import type { TextSelectionAdapter } from "./text-selection-adapter";
import {
  revealCaret,
  tugCaretInteractionPlugin,
  tugCaretLayer,
} from "./tug-text-editor/caret-layer";
import { tugLineNumbersGutter } from "./tug-text-editor/line-numbers-gutter";
import { pressCollapsesSelection } from "./press-collapses-selection";
import { tugSelectionLayer } from "./tug-text-editor/selection-layer";
import { captureEditState, tugTextEditorKeymap } from "./tug-text-editor/keymap";
import type { TugTextEditorKeymapConfig } from "./tug-text-editor/keymap";
import {
  acceptCompletionAt,
  cancelCompletion,
  completionPopupIsInteractive,
  getCompletionState,
  navigateCompletion,
  subscribeCompletionState,
  tugCompletionExt,
} from "./tug-text-editor/completion-extension";
import {
  paintMirrorAsActive as paintMirrorAsActiveImpl,
  paintMirrorAsInactive as paintMirrorAsInactiveImpl,
  restoreEditState,
  TugTextEditorStatePreservation,
} from "./tug-text-editor/state-preservation";
import type { PendingEditRestore } from "./tug-text-editor/state-preservation";
import { deckTrace } from "@/deck-trace";
import { tugDevLogStore } from "@/lib/tug-dev-log-store/tug-dev-log-store";
import { getDeckStore } from "@/lib/deck-store-registry";
import { selectionGuard } from "./selection-guard";
import { useTextSurfaceContextMenu } from "./use-text-surface-context-menu";
import { useAnnotationMenu } from "./use-annotation-menu";
import { useCardId } from "./use-card-state-preservation";
import { useCompanionPopupBinding } from "./use-companion-popup-binding";
import { useOptionalResponder } from "./use-responder";
import { useResponderChain } from "./responder-chain-provider";
import { TAB_CONSUME_ATTRIBUTE, TAB_RELEASE_ATTRIBUTE } from "./focus-manager";
import type { FocusPolicy } from "./focus-manager";
import { useFocusable } from "./use-focusable";
import type { ActionHandler, ActionHandlerResult } from "./responder-chain";
import { TUG_ACTIONS, type TugAction } from "./action-vocabulary";
import type {
  CompletionItem,
  CompletionProvider,
  DropHandler,
  TugTextEditingState,
} from "@/lib/tug-text-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default focus indication when `focusStyle` is not supplied. */
const DEFAULT_FOCUS_STYLE = "background" as const;

/** Default Enter-key action. Matches `tug-prompt-input`'s historical default. */
const DEFAULT_RETURN_ACTION: InputAction = "submit";

/** Default numpad-Enter action. Matches `tug-prompt-input`'s default. */
const DEFAULT_NUMPAD_ENTER_ACTION: InputAction = "submit";

/**
 * Default maxRows when `maxRows` is not supplied. Matches
 * `tug-prompt-input`'s historical maximum visible rows.
 */
const DEFAULT_MAX_ROWS = 8;

/** No-op submit handler used when the host omits `onSubmit`. */
const noopSubmit = (): void => {};

// ---------------------------------------------------------------------------
// Compartments
// ---------------------------------------------------------------------------
//
// Compartments let the React shell reconfigure individual extensions
// (placeholder text, soft-wrap toggle, gutter toggle, read-only toggle)
// without rebuilding the EditorView. Each Compartment is module-scoped
// because CM6 identifies a Compartment by reference — the shell
// dispatches `compartment.reconfigure(newExt)` whenever the
// corresponding prop changes, and CM6 swaps the Compartment's contents
// in place. The view, the document, the selection, the history, and
// every other extension are untouched.
//
// Why module-scope, not per-instance: a Compartment's identity is the
// reference itself; dispatching `reconfigure(...)` on a Compartment
// the view doesn't carry is a no-op. Module-scope means every
// `TugTextEditor` mount uses the same Compartment identities — the
// `buildExtensions` call wraps each one for that particular view
// when the view is constructed, and subsequent `useLayoutEffect`
// passes can reach into the live view and reconfigure.
//
// `Compartment.of(initial)` returns the wrapped extension; we feed
// the initial prop values at view-construction time inside
// `buildExtensions`, then use `compartment.reconfigure(next)` from
// effects on prop change.

/** Reconfigurable placeholder text. Empty extension when no placeholder. */
const placeholderCompartment = new Compartment();

/** Reconfigurable soft-wrap (`EditorView.lineWrapping` or empty). */
const lineWrapCompartment = new Compartment();

/** Reconfigurable line-number gutter (`lineNumbers()` or empty). */
const lineNumbersCompartment = new Compartment();

/**
 * Reconfigurable active-line gutter highlight
 * (`highlightActiveLineGutter()` from `@codemirror/view`, or
 * empty). Toggling this on adds a `cm-activeLineGutter` class to
 * the gutter cell of the line containing the cursor. Has no
 * visible effect when no gutter is rendered (i.e. when
 * `lineNumbers` is false), but the two props are independent
 * because future custom gutters may be added separately.
 */
const activeLineGutterCompartment = new Compartment();

/** Reconfigurable read-only state (`EditorState.readOnly.of(true|false)`). */
const readOnlyCompartment = new Compartment();

/**
 * Reconfigurable markdown text styling (the lazily-loaded
 * `loadMarkdownTextStyling()` bundle, or empty). Unlike the other view
 * compartments this one carries NO synchronous `initial` seed — its enable
 * is async (the grammar chunk loads on demand), so it always starts empty
 * (`.of([])`) and a single post-mount effect fills or clears it. See the
 * `markdownTextStyling` prop and its effect below.
 */
const markdownStylingCompartment = new Compartment();

/**
 * The initial revision marker, shared by every editor instance. Only a
 * *reconfigure* needs a freshly-minted prefix (the facet comparison is
 * what flips `mustMeasureContent`); the value the view is BORN with
 * carries no such signal, so all views can share one module. Sharing it
 * keeps a new editor's construction from registering a new style module
 * with style-mod, whose document-mode mount rewrites its whole
 * `<style>` tag — a full-document style invalidation per editor mount.
 */
const initialTypographyRevTheme: Extension = EditorView.theme({});

/**
 * Reconfigurable geometry-revision marker.
 *
 * Holds an empty `EditorView.theme({})` extension whose contributed
 * style-module identity changes every time a prop-response
 * `useLayoutEffect` reconfigures it. The compartment exists solely
 * to bridge the gap between two state systems:
 *
 *   1. Geometry-affecting props change rendered metrics through
 *      paths CM6 doesn't observe natively:
 *        - **Typography props** (`fontFamily`, `fontSize`,
 *          `lineHeight`, `letterSpacing`) flow through CSS custom
 *          properties on the host wrapper and propagate via
 *          inheritance into `.cm-content`. The browser re-flows
 *          on its own when these change.
 *        - **`lineNumbers`** toggling adds or removes the
 *          line-number gutter, changing the scroller's
 *          clientWidth (and through it the contentDOM's
 *          available width) — affecting per-line wrap counts.
 *        - **`lineWrap`** toggling changes whether `.cm-content`
 *          wraps overflow at all, directly altering per-line
 *          heights for any line that previously overflowed.
 *   2. CodeMirror 6 maintains a private `heightOracle` cache of
 *      the editor's default line-height (read once via
 *      `getComputedStyle` of `.cm-content`) plus per-line height
 *      measurements in its `heightMap`. Gutter row heights,
 *      scroll geometry, and viewport calculations all read from
 *      these caches. CM6 does NOT observe CSS-variable changes
 *      or geometry shifts induced by sibling-extension toggling;
 *      its private `mustMeasureContent` flag is what tells the
 *      next measure pass to re-read computed styles and
 *      per-line rects into the oracle and heightMap.
 *
 * The decisive trigger for that flag — confirmed empirically and
 * by reading CM6's source (`view.update` ~ line 7962 of
 * `@codemirror/view/dist/index.js`) — is:
 *
 *     if (update.startState.facet(theme) != update.state.facet(theme))
 *       this.viewState.mustMeasureContent = true;
 *
 * Each call to `EditorView.theme(spec)` mints a fresh prefix via
 * `StyleModule.newName()` and contributes that prefix string to
 * the `theme` facet. Reconfiguring this compartment with a
 * freshly-built (even empty) `EditorView.theme({})` produces a
 * new prefix → the `theme` facet's resolved value differs by
 * reference → `mustMeasureContent` flips → the next measure
 * pass calls `heightOracle.refresh(...)` against the
 * now-current computed line-height → the heightMap rebuilds
 * with the new oracle values → the gutter plugin picks up the
 * fresh row heights on the post-measure update.
 *
 * No CSS rules go through this theme — its `spec` is `{}`. We
 * don't want it to influence visual rendering; the marker's
 * identity (the per-call prefix) is what CM6 compares, not its
 * stylistic content. The real theme rules live in `tugTheme`
 * from `theme.ts`, which stays as a static extension.
 *
 * Other paths considered and rejected by the trace in
 * `typography-diag.ts`:
 *
 *   - Empty `view.dispatch({})` and `selection: state.selection`:
 *     produce transactions with no facet diff. `mustMeasureContent`
 *     stays false; the measure pass skips the refresh branch.
 *   - `lineNumbersCompartment.reconfigure(tugLineNumbersGutter)`: same
 *     shape — touches the gutter facet but not the theme facet.
 *   - `EditorView.contentAttributes.of({})` reconfigure: CM6
 *     compares `contentAttributes` between updates inside
 *     `viewState.update` (different code path), but
 *     `mustMeasureContent` is set only on the `theme` facet diff.
 *     Confirmed via the trace: the contentAttributes-reconfigure
 *     dispatch fired but produced `heightChanged: false`.
 *
 * Without this bridge, CSS-variable typography changes are
 * invisible to CM6 until the next "real" trigger (the user types
 * a character, scrolls, or the window resizes) — which is the
 * latency the user reported as "I have to click+type to see the
 * gutter update."
 */
const typographyRevCompartment = new Compartment();

// ---------------------------------------------------------------------------
// TugTextEditorDelegate
// ---------------------------------------------------------------------------

/**
 * Imperative handle exposed via `ref`.
 *
 * Exposes the underlying `EditorView`. Consumers that need to
 * dispatch transactions, query state, or reach into extension
 * data hold this handle and call `view()` at use time.
 *
 * `view()` returns `null` between unmount and re-mount — for
 * example during React 19 StrictMode's dev double-mount, or after
 * the component has been disposed. See the lifecycle note in the
 * module docstring.
 */
export interface TugTextEditorDelegate {
  /**
   * Return the live `EditorView`, or `null` if no view is
   * currently mounted.
   */
  view(): EditorView | null;
  /**
   * If the completion popup is currently open and interactive (active
   * with at least one item), accept the highlighted item — inserting
   * its atom — and return `true`. Otherwise no-op and return `false`.
   *
   * Submit flows (the Z5 button, Shift+Return) call this BEFORE reading
   * the draft so a submit made while the popup is open commits the
   * *completed* command / mention, not the typed fragment. The keyboard
   * accept (plain Enter / Tab) lives in the completion keymap; this is
   * the seam for submit paths that bypass it. No-op when not mounted.
   */
  acceptActiveCompletion(): boolean;
  /**
   * If the completion popup is currently open and interactive (active
   * with at least one item), dismiss it and return `true`. Otherwise
   * no-op and return `false`.
   *
   * The CodeMirror keymap already dismisses the popup on a bare Escape
   * that reaches the editor. This is the seam for the chain-level
   * CANCEL_DIALOG path: when a turn is in flight, the capture-phase
   * keybinding routes Escape to the prompt entry's interrupt handler
   * BEFORE the editor's bubble-phase keymap runs, so the handler must
   * consult and dismiss the popup itself rather than let Escape fall
   * through to interrupt the turn. No-op when not mounted.
   */
  cancelActiveCompletion(): boolean;
  /**
   * Insert an atom at the current selection head, replacing any
   * non-empty selection. The transaction inserts the U+FFFC text
   * marker and the matching decoration in a single step, so the
   * editor never observes a partially-applied atom. After the
   * insertion the caret lands immediately after the new atom.
   *
   * No-op when the editor is not mounted.
   */
  insertAtom(segment: AtomSegment): void;
  /**
   * Clear the editor: empty document, no selection range, no atoms.
   * Used by submit flows that want a fresh draft after the current
   * one has been committed. No-op when the editor is not mounted.
   */
  clear(): void;
  /**
   * Move keyboard focus to the editor and place a caret. No-op when
   * the editor is not mounted. The caret lands at the current
   * selection's anchor; if the document is empty, the caret is at
   * offset 0.
   */
  focus(): void;
  /**
   * Bring the caret into view in every scroller that encloses it, including
   * scrollers OUTSIDE the editor. An editor that grows uncapped inside an
   * outer list (the Lens jot editor) makes that LIST scroll, and nothing
   * there follows the caret — such a consumer calls this on each edit.
   *
   * Scheduled on CM6's measure cycle, so it runs once the caret layer has
   * repainted; insets each scrollport by the sticky chrome parked over it, so
   * the caret never lands under a pinned header. Self-gating (an already
   * visible caret writes no scroll) and a no-op while unfocused or unmounted.
   */
  revealCaret(): void;
  /**
   * Remove keyboard focus from the editor so the caret stops rendering.
   * Used when a modal surface deactivates the editor (e.g. an inline
   * Permission/Question dialog takes over the keyboard): pairing a
   * `disabled` (read-only) editor with a blur removes both the input
   * path and the blinking caret. No-op when the editor is not mounted
   * or does not currently hold focus.
   */
  blur(): void;
  /**
   * Snapshot the editor's text + atoms + selection + scrollTop into
   * a `TugTextEditingState`. Used by save callbacks (state
   * preservation) and history-nav consumers that want the same
   * shape. Returns the empty seed `{ text: "", atoms: [],
   * selection: null }` when no view is mounted.
   */
  captureState(): TugTextEditingState;
  /**
   * Restore a previously-captured editing state without claiming
   * focus. Replaces doc + atoms + selection in one transaction;
   * writes saved `scrollTop` directly. The consumer is responsible
   * for choosing the paint channel afterward via
   * `paintMirrorAsActive` (active card) or `paintMirrorAsInactive`
   * (inactive card). No-op when the editor is not mounted.
   *
   * Distinct from history-nav restore (which focuses + scrolls the
   * cursor into view); used by state preservation. [L23]
   *
   * `opts.addToHistory: false` marks the swap ephemeral — CM6 applies
   * the doc change but records no undo event (the Auto-Message stream
   * uses this so the whole generation collapses to one undo step).
   */
  restoreState(
    state: TugTextEditingState,
    opts?: { addToHistory?: boolean },
  ): void;
  /**
   * Paint the editor as the deck-level first responder. Claims focus
   * and (when `state` is supplied) asserts selection + scrollTop
   * verbatim from the bag. The single legitimate call site for
   * mutating the global Selection + claiming document focus from a
   * `tug-text-editor` instance. [L23]
   *
   * No-op when the editor is not mounted.
   */
  paintMirrorAsActive(state?: TugTextEditingState): void;
  /**
   * Paint the editor as a non-first-responder card. Builds a `Range`
   * from the (saved or live) selection over `view.contentDOM` and
   * routes it through `publish` (typically
   * `range => selectionGuard.updateCardDomSelection(cardId, range)`).
   * No focus claim; no `window.getSelection()` mutation; no
   * dispatch to CM6 itself. [L23], [L12].
   *
   * No-op when the editor is not mounted.
   */
  paintMirrorAsInactive(
    publish: (range: Range | null) => void,
    state?: TugTextEditingState,
  ): void;
}

// ---------------------------------------------------------------------------
// TugTextEditorProps
// ---------------------------------------------------------------------------

/**
 * Focus indication variants for the host wrapper.
 *
 *   `"background"` — focused state shifts the editor surface to a
 *                    subtle focus tint and the host border to the
 *                    field's active border color.
 *   `"ring"`        — focused state draws an accent-colored ring
 *                    around the host wrapper.
 */
export type TugTextEditorFocusStyle = "background" | "ring";

/**
 * Props for `TugTextEditor`. The component renders a host `<div>`
 * around the live `EditorView`; standard `<div>` props
 * (`className`, `style`, `data-*`, etc.) flow through to the
 * host.
 */
export interface TugTextEditorProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "onChange"> {
  /**
   * Optional className applied to the host wrapper. Composed with
   * the component's own `tug-text-editor` base class.
   */
  className?: string;
  /**
   * Focus indication style for the host wrapper.
   * @default "background"
   * @selector .tug-text-editor[data-focus-style]
   */
  focusStyle?: TugTextEditorFocusStyle;
  /**
   * Suppress the host wrapper's border. For embedding in compound
   * components where the parent owns the border treatment.
   * @default false
   * @selector .tug-text-editor[data-borderless]
   */
  borderless?: boolean;
  /**
   * Do NOT register this editor's `paintMirrorAsActive` engine hooks with the
   * enclosing card. Set for a TRANSIENT, in-list editor (e.g. the Lens jot
   * editor) that is not the card's primary text surface: registering /
   * unregistering card engine hooks as such an editor mounts and unmounts
   * churns the card's engine-hooks set, which re-fires the card's
   * `applyBagFocus` restore and yanks the keyboard key view back to the card's
   * default focus target — stealing focus from the list the editor lives in.
   * The card's primary editor (a session card, a text-file card) leaves this
   * `false` so its activation focus mirror still works.
   * @default false
   */
  suppressCardEngineHooks?: boolean;
  /**
   * Action triggered by the main-row Enter key.
   *   `"submit"`  — fire `onSubmit`. Shift-Enter then inserts a newline.
   *   `"newline"` — insert a newline. Shift-Enter then fires `onSubmit`.
   * @default "submit"
   */
  returnAction?: InputAction;
  /**
   * Action triggered by the numpad Enter key. Distinct from
   * `returnAction` because some workflows (numeric data entry)
   * benefit from a different policy on the numpad.
   * @default "submit"
   */
  numpadEnterAction?: InputAction;
  /**
   * Submit handler. Invoked when the resolved Enter / numpad-Enter
   * action is `"submit"`, or on Cmd-Enter regardless of the
   * configured action.
   */
  onSubmit?: () => void;
  /**
   * Whether a `submit` Enter defers to a default button registered on the
   * responder chain in this editor's pane (a dialog's primary action), firing
   * that button instead of `onSubmit`. Set `false` when the field's own
   * `onSubmit` is a distinct step the default button would skip past — e.g. a
   * wizard field whose submit advances to the next question, where deferring
   * would send the whole dialog on the user's first Return.
   * @default true
   */
  deferToDefaultButton?: boolean;
  /**
   * Whether a surface above this editor has taken Return for its own ([P14]).
   * When `true`, a plain Return defers to the pane's default button even under
   * `returnAction: "newline"` — the case the `submit` defer above cannot cover.
   *
   * Set it wherever a host paints another surface's control as the one default
   * ring on screen while this editor stays live beneath it: the Session card's
   * History shade owns Return through its Done, and the composer's Return would
   * otherwise break a line under a ring promising dismissal. The button's own
   * chord still governs ([#chord-ring]) — a plain Return only presses a button
   * that declares none.
   * @default false
   */
  defaultButtonOwnsReturn?: boolean;
  /**
   * History provider for Up / Down + Opt-Up / Opt-Down navigation. The substrate
   * captures the current editing state on each `back()` call so the
   * provider can stash it as the in-progress draft and restore it
   * when the user reaches the forward end of the stack.
   */
  historyProvider?: HistoryProvider;
  /**
   * Map of trigger character → `CompletionProvider`. When the user
   * types a key in the map (e.g. `@` or `/`), the substrate opens a
   * typeahead popup of items returned by the provider, lets the user
   * navigate with arrow keys, and on Enter or Tab inserts the chosen
   * item as a tug atom.
   *
   * Providers may be sync (a plain function) or async (with a
   * `.subscribe` method that the substrate uses to refresh results
   * as they stream in — `[L22]`).
   */
  completionProviders?: Record<string, CompletionProvider>;
  /**
   * Resolver mapping an accepted command atom's value (e.g.
   * `"tugplug:devise"`) to the argument placeholder shown after it
   * (`/devise ┆ type arguments…`), or `null` for a no-arg command. The host
   * builds this from its command catalog + local registry; read live, so a
   * hint that lands after the `initialize` handshake takes effect on the next
   * edit. Omitted (gallery / standalone) ⇒ no placeholder is ever painted.
   */
  argumentHintResolver?: ArgumentHintResolver;
  /**
   * Store-like source the argument-hint plugin subscribes to so a slot
   * recomputes when its backing catalog lands *after* the command was accepted
   * (the catalog arrives asynchronously; without this the generic slot would
   * freeze instead of upgrading to the explicit hint). The host passes its
   * `SessionMetadataStore`. Omitted (gallery / standalone, static catalog) ⇒
   * the plugin never subscribes and only reacts to edits.
   */
  argumentHintRefresh?: ArgumentHintRefreshSource;
  /**
   * Resolver that recognizes a slash command at the start of pasted text and
   * returns the atom segment to chip it as (e.g. pasting `/tugplug:implement
   * dash/foo.md` at offset 0 chips the command and keeps the path as its
   * argument). Matches a full name or its unqualified leaf, like the typed
   * `/command ` accept. Omitted (gallery / standalone) ⇒ paste stays plain text.
   */
  pastedCommandResolver?: PastedCommandResolver;
  /**
   * Resolver mapping a mid-text `/query` to the full command name it should
   * complete to (the muted inline ghost), or `null` for no completion. The
   * host builds this from its live command catalog; read live so the catalog
   * growing after the handshake takes effect on the next edit. Omitted
   * (gallery / standalone) ⇒ no inline ghost is ever painted.
   */
  inlineCommandMatcher?: InlineCommandMatcher;
  /**
   * The roots a relative atom value is addressed against, read live at the
   * moment an atom is mounted. An `@` mention carries the path the file index
   * handed it — relative to the project root, not to `/` — and every gesture
   * on the atom (its menu's Open in Editor, its Show in Finder, its Copy
   * Path) speaks absolute only, so a host that knows the roots supplies them
   * here and the atom is stamped with an openable target. Omitted (gallery /
   * standalone) ⇒ a relative atom carries no annotation and offers no menu,
   * which is the honest reading of a path nothing can address.
   */
  atomPathRoots?: () => AtomPathRoots | null;
  /**
   * Preferred direction for the completion popup relative to the
   * trigger character. `"down"` (default) places the popup below the
   * trigger when there's room; `"up"` places it above. The substrate
   * auto-flips when the preferred direction would clip against the
   * editor's scroll-clipping ancestor.
   * @default "down"
   */
  completionDirection?: "up" | "down";
  /**
   * Optional observer of typeahead state changes. Fires after every
   * activate / update / navigate / cancel — useful for hosts that
   * want to coordinate other UI (e.g. dim a sibling control while
   * typeahead is active). The substrate already drives the popup
   * itself; consumers do not need to render anything in response.
   */
  onTypeaheadChange?: (
    active: boolean,
    filtered: readonly CompletionItem[],
    selectedIndex: number,
  ) => void;
  /**
   * File-drop handler. When the user drags a file from Finder onto
   * the editor, the substrate's drop extension calls this with the
   * dropped `FileList` and inserts each returned `AtomSegment` at
   * the drop point as one transaction. Omit to fall back to a
   * default mapping that classifies files as `image` or `file`
   * by extension and uses the bare filename as both `label` and
   * `value`. Hosts that need richer mapping (real paths, content
   * hashes, server URLs) supply their own.
   */
  dropHandler?: DropHandler;
  /**
   * Per-card byte-payload store for inline image attachments. When
   * provided, the drop and paste pipelines route image files through
   * the async `downsampleImage` → bytes-store path: each image atom
   * comes back with a UUID `id` paired with bytes in this store, and
   * the wire-flattening at submit (Step 3) packs them as Attachments.
   *
   * Defaults to `undefined`, in which case drops use the synchronous
   * `defaultFilesToMixedItems` path (image atoms with no bytes,
   * non-image filenames as plain text) and image clipboard items fall
   * through to the substrate's text-paste path. Gallery cards and
   * stand-alone harnesses leave this absent;
   * session-card prompt-entry instances wire it through from their
   * `CodeSessionStore`. Per [D03](dash/dev-atoms.md#d03-atom-bytes-store).
   *
   * The prop is a controlled reference — pass the same store
   * instance on every render. A late-arriving store (mounted as
   * `undefined`, then re-rendered with a value) is picked up via
   * ref-mirroring; the next drop / paste uses the latest reference.
   */
  attachmentBytesStore?: AtomBytesStore;
  /**
   * Callback invoked when the drop / paste downsample pipeline
   * rejects a file (oversize image, unsupported source format,
   * decode failure). The string is a calm, user-facing message.
   *
   * Defaults to a no-op. The prompt entry forwards this to its own
   * `onAttachmentError` host handler, which surfaces the message as a
   * card-scoped bulletin (never the session-error banner). Per
   * [Table T01](dash/dev-atoms.md#t01-failure-modes).
   */
  onAttachmentError?: (message: string) => void;
  /**
   * Called when a paste carried its source project's roots — the sidecar's
   * `origins`, written by whichever Tug surface the text was copied from.
   *
   * Reported rather than applied, because what to do with a root is the
   * HOST's question. A jot records them, so a relative path in the pasted
   * prose still names a file long after the session it came from is closed; the
   * prompt entry has a project of its own and ignores them. Defaults to a
   * no-op, which is every surface that has no use for provenance.
   */
  onPastedOrigins?: (origins: readonly string[]) => void;
  /**
   * Opt in to tugdeck card state preservation. When `true`, the
   * editor registers `onSave` / `onRestore` / `onCardActivated` /
   * `onCardWillDeactivate` callbacks with the enclosing `CardHost`
   * via `useCardStatePreservation`, so doc + atoms + selection +
   * scrollTop survive cmd-tab cycles, tab deactivation, and a
   * cold-mount restore from tugbank. The active / inactive paint
   * channel decisions follow [L23] — the active card claims focus
   * + global Selection; inactive cards publish their selection
   * through `selectionGuard`'s inactive highlight.
   *
   * Default `true`. Set to `false` for stand-alone harnesses
   * (storybook, unit tests) that mount `TugTextEditor` outside a deck;
   * the registration is silently a no-op when the
   * `CardStatePreservationContext` is null, but the
   * `preserveState=false` opt-out skips the hook entirely.
   *
   * @default true
   */
  preserveState?: boolean;
  /**
   * Empty-state hint rendered inside the editor when the document is
   * empty. Wired through `@codemirror/view`'s `placeholder` extension
   * via a Compartment so changes take effect without remounting.
   * @default ""
   */
  placeholder?: string;
  /**
   * Maximum visible rows before vertical scrolling kicks in. Caps the
   * height of `.cm-scroller` via CSS:
   * `max-height: calc(var(--tug-text-editor-max-rows) * 1lh + padding)`.
   * @default 8
   * @selector .tug-text-editor (CSS variable `--tug-text-editor-max-rows`)
   */
  maxRows?: number;
  /**
   * Direction the editor grows as lines are added.
   * `"down"` — top edge fixed, bottom extends (default).
   * `"up"` — bottom edge fixed, top extends. The host wrapper sets
   * `data-grow-direction="up"`; layout consumers anchor the editor to
   * the bottom of a flex parent (`align-self: flex-end` /
   * `margin-top: auto` patterns).
   * @default "down"
   * @selector .tug-text-editor[data-grow-direction]
   */
  growDirection?: "up" | "down";
  /**
   * Whether the editor is disabled. Sets `EditorState.readOnly` so
   * CM6 rejects content edits at the transaction level, drops
   * `EditorView.editable` so the content DOM loses contenteditable —
   * no caret can render while disabled, even if focus lands on the
   * editor afterwards — and toggles `data-disabled` on the host
   * wrapper for visual state.
   * @default false
   * @selector .tug-text-editor[data-disabled]
   */
  disabled?: boolean;
  /**
   * Let Tab move keyboard focus out of the editor instead of indenting. By
   * default a focused multi-line editor owns Tab (it advertises
   * `data-tug-tab-consume`, and the higher-prec keymaps insert an indent unit);
   * when this is set the marker is suppressed, so the document-level focus walk
   * advances focus on Tab — the right behavior for a short single-purpose field
   * (a commit message) sitting in a dialog whose action buttons must stay
   * keyboard-reachable. Mount-time only. [L06]
   * @default false
   */
  tabMovesFocus?: boolean;

  // ---- Focus engine ([P01], [P02]) ----

  /**
   * Focus group this editor is authored into ([P02]). When set, the editor
   * registers as a stop in the engine's Tab / arrow walk under the SAME id as
   * its responder, so the key view resolves to the responder's focus contract
   * (`view.focus()`) and the route classifies as `dom-granted` — the caret
   * lands in the document and the editor owns its keys. When omitted the
   * editor stays outside the walk and is reached by click / an explicit
   * `focusResponder` (the prompt entry's path). Supplied by the surface that
   * owns the Tab order.
   */
  focusGroup?: string;
  /** Order within {@link focusGroup}. Defaults to 0 (registration order breaks ties). */
  focusOrder?: number;
  /**
   * Walk policy when registered: `accept` (default) is an ordinary stop;
   * `skip` is reachable only in accessibility mode.
   */
  focusPolicy?: FocusPolicy;
  /**
   * Soft-wrap long lines at the editor's width. When true, adds
   * `EditorView.lineWrapping` (sets `white-space: break-spaces` on
   * `.cm-content`); when false, long lines scroll horizontally.
   * @default false
   */
  lineWrap?: boolean;
  /**
   * Show line numbers in a left gutter. When true, adds the
   * substrate's `tugLineNumbersGutter` (a custom variant of
   * `@codemirror/view`'s `lineNumbers()` that wraps each
   * line-number value in a `<span>` for theme-driven sizing).
   * The gutter sits inside `.cm-scroller` and does not shift
   * the caret-column origin.
   * @default false
   */
  lineNumbers?: boolean;
  /**
   * Highlight the gutter cell of the line containing the cursor.
   * When true, adds `highlightActiveLineGutter()` from
   * `@codemirror/view`, which sets a `cm-activeLineGutter` class
   * on the gutter cell whose line block contains the cursor.
   * The class is theme-styled to a subtle background tint that
   * tracks the cursor as it moves.
   *
   * Independent of `lineNumbers`: the highlight only has a
   * visible effect when a gutter is rendered, but consumers can
   * toggle the two props independently in case future gutters
   * (folding markers, breakpoint markers) are added.
   * @default false
   */
  highlightActiveLineGutter?: boolean;
  /**
   * Light markdown formatting: subtly style markdown tokens (heading /
   * emphasis / strong / inline code / link colors and weights) and
   * hang-indent wrapped list-item continuations, WITHOUT ever removing or
   * hiding the raw markdown syntax. Backed by a lazily-loaded, styling-only
   * grammar bundle (`loadMarkdownTextStyling`) — no markdown editing keymap,
   * no URL-paste rewriting.
   *
   * Reactive: flipping it reconfigures the live view (the grammar chunk
   * loads on first enable). Off by default; a plain-text editor stays plain.
   * @default false
   */
  markdownTextStyling?: boolean;
  /**
   * CSS `font-family` for the editor surface. Sets the
   * `--tug-font-family-editor` custom property on the host wrapper;
   * the theme reads it via `var(--tug-font-family-editor, …)` so
   * undefined falls back to the existing token.
   */
  fontFamily?: string;
  /**
   * CSS `font-size` for the editor surface (e.g. `"14px"`,
   * `"1rem"`). Sets `--tug-font-size-editor` on the host wrapper.
   */
  fontSize?: string;
  /**
   * CSS `line-height` for the editor surface. Accepts either a
   * unitless number (e.g. `1.6`, treated as a multiplier of
   * `font-size`) or a CSS length string (e.g. `"22px"`). Sets
   * `--tug-line-height-editor` on the host wrapper. The
   * `.cm-line::before` ghost uses `1lh` so any change propagates to
   * line-box height regardless of unit.
   *
   * Default (when the prop is undefined): `1.6` via the theme's
   * `var(--tug-line-height-editor, 1.6)` CSS fallback.
   */
  lineHeight?: string | number;
  /**
   * CSS `letter-spacing` for the editor surface (e.g. `"0.01em"`,
   * `"normal"`). Sets `--tug-letter-spacing-editor` on the host
   * wrapper.
   */
  letterSpacing?: string;
  /**
   * Additional CM6 extensions installed at mount time alongside the
   * substrate's built-in extension set. Use this seam for compound
   * components that need a host-supplied extension (e.g.
   * `tug-prompt-entry`'s find-query mirror).
   *
   * Read once at mount: changes after the view is constructed do
   * NOT propagate. Host-supplied extensions are expected to be
   * stable for the life of the editor view; per-prop reactivity
   * should be threaded through refs read by the extension at fire
   * time per [L07].
   */
  extensions?: Extension | readonly Extension[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Build the CM6 extension set used at mount. The host element is
 * captured so the focus-mirror extension can reach it directly. The
 * `getKeymapConfig` thunk is captured by the high-precedence tug
 * keymap; the React shell mutates the underlying ref on prop change
 * so the latest `returnAction` / `onSubmit` / `historyProvider` are
 * read at every keystroke without rebuilding any extension [L07].
 *
 * Kept as a free function so the extension list is easy to grow
 * without disturbing the lifecycle code.
 */
/**
 * Keep the caret visible after every user edit. CM6's own
 * `scrollIntoView` runs during the edit transaction, but when the editor
 * is auto-height the scroller's height is still settling (CSS `max-height`
 * clamp + the measure cycle), so a large paste can leave the caret below
 * the fold. This listener re-checks AFTER the measure settles and nudges
 * `scrollDOM` directly to reveal the caret line — a plain measure-phase
 * scroll, no re-entrant dispatch, no `requestAnimationFrame` (this is
 * CM6's own measure cycle, not React's). Guarded so it no-ops when the
 * caret is already in view (the common case for ordinary typing).
 */
const keepCaretVisible: Extension = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  const isUserEdit = update.transactions.some(
    (t) => t.isUserEvent("input") || t.isUserEvent("delete"),
  );
  if (!isUserEdit) return;
  const view = update.view;
  view.requestMeasure({
    read() {
      const head = view.state.selection.main.head;
      const block = view.lineBlockAt(head);
      const scroller = view.scrollDOM;
      return {
        blockTop: block.top,
        blockBottom: block.bottom,
        scrollTop: scroller.scrollTop,
        clientHeight: scroller.clientHeight,
      };
    },
    write(m) {
      const scroller = view.scrollDOM;
      const margin = 6;
      const viewBottom = m.scrollTop + m.clientHeight;
      if (m.blockBottom > viewBottom - margin) {
        scroller.scrollTop = m.blockBottom - m.clientHeight + margin;
      } else if (m.blockTop < m.scrollTop + margin) {
        scroller.scrollTop = Math.max(0, m.blockTop - margin);
      }
    },
  });
});

/**
 * Marks `.cm-scroller` as overflowing its `max-height` cap, gating the CSS
 * that switches it from `overflow-y: hidden` back to `auto` (see
 * `tug-text-editor.css`). Written by {@link scrollbarAtCap}.
 */
const OVERFLOWING_ATTRIBUTE = "data-tug-overflowing";

/**
 * Show the vertical scrollbar only once the auto-height editor has actually
 * hit its `max-height` cap — never during the transient relayout as it grows
 * to fit a new line.
 *
 * CM6's own default is `overflow-y: auto` on `.cm-scroller`, which paints a
 * scrollbar *reactively* the instant `scrollHeight` exceeds `clientHeight`.
 * While the editor is auto-growing, the content height jumps a row ahead of
 * the scroller box for one layout pass, so that default flashes a scrollbar
 * that vanishes the moment the box catches up — visible jitter on every line
 * break below the cap.
 *
 * So the CSS pins `.cm-scroller` to `overflow-y: hidden`, and this listener
 * flips it to `auto` (via `data-tug-overflowing`) only when content genuinely
 * exceeds the box. With overflow hidden, `clientHeight` is `min(content,
 * max-height)`: so `scrollHeight > clientHeight` is true *only* once the
 * `max-height` clamp engages — the stable at-cap state where a scrollbar is
 * wanted — and never during the sub-cap grow, where the box always fits its
 * content in a single layout. [L06] appearance-zone DOM write, never React.
 */
const scrollbarAtCap: Extension = EditorView.updateListener.of((update) => {
  if (!update.docChanged && !update.geometryChanged) return;
  const view = update.view;
  view.requestMeasure({
    read() {
      const scroller = view.scrollDOM;
      return scroller.scrollHeight > scroller.clientHeight;
    },
    write(overflowing) {
      const scroller = view.scrollDOM;
      if (overflowing) {
        scroller.setAttribute(OVERFLOWING_ATTRIBUTE, "true");
      } else {
        scroller.removeAttribute(OVERFLOWING_ATTRIBUTE);
      }
    },
  });
});

/**
 * The CSS variable carrying one rendered row's height, written by
 * {@link rowHeightVar} and consumed by hosts that want a height in rows (see
 * `tug-text-editor.css`).
 */
const ROW_HEIGHT_VARIABLE = "--tug-text-editor-row-height";

/**
 * Publish the height of one rendered row as a CSS variable on the host wrapper.
 *
 * A row is not `1lh`. The line box a `.cm-line` actually occupies is its
 * `line-height` plus the leading the baseline-aligned `.cm-line::before` ghost
 * contributes under it, so a field sized at `rows × 1lh` is short of `rows`
 * real rows and grows one line early. CM6 measures the true figure —
 * `view.defaultLineHeight` — so that is what goes out.
 *
 * It lands on the HOST, not on `.cm-editor`: a host states its floor as
 * `--tug-text-editor-min-height` on itself, and the `var()`s inside a custom
 * property's value are substituted at the element that DECLARES it. Published
 * any deeper, the row height would be invisible to the one declaration that
 * wants it.
 *
 * [L06] appearance-zone DOM write, never React state.
 */
function writeRowHeight(view: EditorView): void {
  const target = view.dom.parentElement ?? view.dom;
  const next = `${view.defaultLineHeight}px`;
  if (target.style.getPropertyValue(ROW_HEIGHT_VARIABLE) === next) return;
  target.style.setProperty(ROW_HEIGHT_VARIABLE, next);
}

const rowHeightVar: Extension = EditorView.updateListener.of((update) => {
  if (!update.docChanged && !update.geometryChanged && !update.viewportChanged)
    return;
  writeRowHeight(update.view);
});

function buildExtensions(
  host: HTMLElement,
  getKeymapConfig: () => TugTextEditorKeymapConfig,
  getCompletionProviders: () => Record<string, CompletionProvider>,
  getDropHandler: () => DropHandler | null,
  getBytesStore: () => AtomBytesStore | null,
  getAtomPathRoots: () => AtomPathRoots | null,
  getArgumentHintResolver: () => ArgumentHintResolver,
  getArgumentHintRefresh: () => ArgumentHintRefreshSource | null,
  getInlineCommandMatcher: () => InlineCommandMatcher,
  getPastedCommandResolver: () => PastedCommandResolver | null,
  onAttachmentError: (message: string) => void,
  onPastedOrigins: (origins: readonly string[]) => void,
  initial: {
    placeholder: string;
    lineWrap: boolean;
    lineNumbers: boolean;
    highlightActiveLineGutter: boolean;
    disabled: boolean;
    tabMovesFocus: boolean;
  },
  hostExtensions: readonly Extension[],
): readonly Extension[] {
  return [
    history(),
    // [P02] A secondary-click (right-click or macOS Control-click) over a ranged
    // selection must NOT move the caret — it opens the context menu, which acts on
    // the existing selection. CodeMirror's built-in pointer selection otherwise
    // dispatches a `select.pointer` transaction on mouseup that collapses the
    // selection to the click point. This handler runs before CM6's built-in mouse
    // handling; returning `true` suppresses CM6's pointer selection for this
    // click. The OS-level `contextmenu` still fires, so the menu opens. Only
    // guards when a range exists — a plain-caret secondary-click still positions
    // the caret (Paste-at-click).
    EditorView.domEventHandlers({
      mousedown(event, view) {
        const sel = view.state.selection.main;
        const hasRange = sel.from !== sel.to;
        const isSecondaryClick =
          event.button === 2 || (event.button === 0 && event.ctrlKey);
        return hasRange && isSecondaryClick;
      },
    }),
    // A primary press inside a ranged selection collapses it now rather
    // than on release — otherwise the whole range stays painted for as
    // long as the button is held. See `press-collapses-selection.ts`.
    pressCollapsesSelection,
    // Host-supplied extensions are layered first so they sit BELOW the
    // substrate's keymap / theme precedence. A compound component that
    // wants its own keymap or `Prec.highest` rules can wrap them in
    // `Prec.highest(...)` itself; lining them up under the substrate's
    // base keeps `tugTextEditorKeymap` and `tugTheme` authoritative
    // for the substrate's own contracts.
    ...hostExtensions,
    // Compartment-wrapped extensions go first so their initial values
    // are layered before precedence-sensitive extensions (keymap, theme).
    // Each compartment is reconfigured from the React shell on prop
    // change without rebuilding the view.
    placeholderCompartment.of(
      initial.placeholder !== "" ? cmPlaceholder(initial.placeholder) : [],
    ),
    lineWrapCompartment.of(initial.lineWrap ? EditorView.lineWrapping : []),
    lineNumbersCompartment.of(initial.lineNumbers ? tugLineNumbersGutter : []),
    activeLineGutterCompartment.of(
      initial.highlightActiveLineGutter ? highlightActiveLineGutter() : [],
    ),
    // `readOnly` blocks input transactions; `editable(false)` drops
    // contenteditable so a disabled editor cannot render a caret even
    // if something focuses it later (the host's transition-time blur
    // can't guard against focus arrivals WHILE disabled — e.g. a
    // card's mount-time focus restore landing on a stood-down entry).
    readOnlyCompartment.of([
      EditorState.readOnly.of(initial.disabled),
      EditorView.editable.of(!initial.disabled),
    ]),
    // Markdown text styling starts empty and is filled by its post-mount
    // effect once the grammar chunk loads (no synchronous seed — the enable
    // is async). Placed with the compartments so it sits below the keymap /
    // theme precedence; it never contributes a keymap of its own by design.
    markdownStylingCompartment.of([]),
    // Initial revision marker — the shared instance, deliberately not a
    // fresh `EditorView.theme({})`. Reconfigures mint fresh prefixes; the
    // birth value never needs to. See `initialTypographyRevTheme`.
    typographyRevCompartment.of(initialTypographyRevTheme),
    // Typeahead first so its `Prec.highest` keymap sees Enter / Tab /
    // Arrows / Escape before the Step 4 keymap when a session is
    // active. When inactive, every branch returns `false` and the
    // keystroke falls through to `tugTextEditorKeymap` and beyond.
    tugCompletionExt(getCompletionProviders),
    // tug-specific keymap runs before defaultKeymap / historyKeymap
    // (Prec.high inside `tugTextEditorKeymap`) so Enter / numpad Enter /
    // Cmd-Enter and history nav (Up / Down / Opt-Up / Opt-Down) get
    // tug semantics. Falling through (returning false) lets the default
    // bindings handle newline insertion, undo/redo, selectAll, Cmd-Up /
    // Cmd-Down (cursorDocStart / cursorDocEnd), and the rest.
    tugTextEditorKeymap(getKeymapConfig),
    // `indentWithTab` last so Tab is a tab while editing: the higher-prec
    // inline-ghost keymap and the typeahead popup each claim Tab only while
    // they are on screen (they yield otherwise), so a plain Tab with neither
    // showing falls through to here and inserts the indent unit (Shift-Tab
    // dedents) instead of doing nothing. Pairs with the focus-engine
    // `data-tug-tab-consume` marker below — without that marker the
    // document-level focus walk swallows Tab in capture phase before CM6
    // ever sees it.
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    // Selection + caret painted by custom layers. We deliberately
    // do NOT use `drawSelection`: drawSelection bundles a styled
    // `.cm-cursor` (which sizes itself from `coordsAtPos`'s glyph
    // rect and wobbles between text and atom positions) and a
    // `Prec.highest` theme that forces `caret-color: transparent
    // !important` and `::selection: transparent !important` (which
    // collide with the substrate's existing glyph-recolor rule).
    // The two own-layer extensions cover the same surface without
    // the precedence battle:
    //   - `tugSelectionLayer` paints `.cm-selectionBackground` divs
    //     for non-empty ranges; survives editor blur and covers
    //     atom widgets cleanly.
    //   - `tugCaretLayer` paints a single `.tug-text-editor-caret` div at
    //     the head of a focused, collapsed selection. The native
    //     WebKit caret is suppressed by `caret-color: transparent`
    //     on `.cm-content` (in `tugTheme`); the layer paints the
    //     visible caret with height taken from
    //     `lineBlockAt(head).height` so it stays uniform across
    //     text-only, atom-only, and mixed lines. Replaces three
    //     prior cache-flush hacks (history-nav, typeahead-deactivate,
    //     atom-removal) that worked around WebKit's contentEditable
    //     caret-cache staleness.
    tugSelectionLayer,
    tugCaretLayer,
    tugCaretInteractionPlugin,
    tugTheme,
    hostFocusMirror(host),
    // The host is the text surface: a click in the blank band below short
    // content (host taller than contentDOM) lands the caret instead of
    // letting WebKit's mousedown default blur the editor.
    hostClickToCaret(host),
    // Atom support: the decoration field is the data layer; the
    // atomic-ranges provider lifts that data into CM6's motion /
    // deletion machinery; clipboard filters round-trip the atoms
    // through copy / cut / paste; the drop extension lifts dragged
    // files from Finder into atoms at the drop point;
    // `atomInvertedEffects` registers history-aware undo so a cut
    // atom's widget reappears on Cmd-Z.
    atomDecorationField,
    atomInvertedEffects,
    atomicRangesExt,
    // A command atom is a command only while it leads the document —
    // an edit that pushes it off position 0 demotes the chip to its
    // literal `/name` text in the same transaction.
    commandAtomDemotionFilter,
    // Typing a character over a selection that covers an atom replaces it —
    // CM stamps the atom widget `contentEditable="false"`, so WebKit drops
    // the keystroke; this dispatches the replacement itself.
    atomTypeOverExt,
    // Bind each atom to its abutting punctuation so a wrap can't strand
    // a comma (etc.) on the next row — atoms are replaced elements, which
    // would otherwise carry a break opportunity on both edges.
    atomBindExt,
    // Bytes-store facet — read by `AtomWidget.toDOM` and the
    // pending-sync `ViewPlugin` to derive the pending appearance
    // for skeleton atoms (drop / paste inserted them synchronously
    // before the async byte-fill completed).
    atomBytesStoreFacet.of(getBytesStore),
    // Path-roots facet — read by `AtomWidget.toDOM` so the chip it mounts
    // can be stamped with an annotation payload naming a real target.
    atomPathRootsFacet.of(getAtomPathRoots),
    // Subscribes to the bytes-store; on bytes-arrival, walks atom
    // widgets in `view.contentDOM` and toggles `data-pending` via
    // direct DOM mutation ([L06]). No-op when no bytes-store is
    // registered (facet default thunk returns `null`).
    pendingAtomSyncPlugin,
    pendingAtomTheme,
    // Swaps each atom chip between its resting and selected-variant
    // bake to match the text selection — a chip the selection covers
    // paints with the `-selected-rest` tokens so it reads forward of
    // the blue selection wash instead of dissolving into it. Pure DOM
    // `src` mutation ([L06]), no widget rebuild.
    selectedAtomSyncPlugin,
    // Argument-hint ghost slot — reads the resolver thunk (live catalog +
    // local registry) and paints a muted placeholder after a lone accepted
    // command atom (`/devise ┆ type arguments…`). No-op when no resolver is
    // registered (gallery / standalone). [L06] appearance-only widget.
    argumentHintResolverFacet.of(getArgumentHintResolver),
    argumentHintRefreshFacet.of(getArgumentHintRefresh),
    argumentHintPlugin,
    argumentHintTheme,
    // Mid-text slash-command inline ghost completion — paints the muted
    // remainder of the best-matching command after the caret when a `/cmd`
    // run sits anywhere but offset 0 (offset 0 is the descriptive popup's
    // territory). Tab / → accept it as plain text. No-op when no matcher is
    // registered (gallery / standalone). [L06] appearance-only widget.
    inlineCommandMatcherFacet.of(getInlineCommandMatcher),
    inlineCommandGhostPlugin,
    inlineCommandGhostKeymap,
    inlineCommandGhostTheme,
    clipboardExtension(
      getBytesStore,
      onAttachmentError,
      getPastedCommandResolver,
      onPastedOrigins,
    ),
    tugDropExtension(host, getDropHandler, getBytesStore, onAttachmentError),
    keepCaretVisible,
    scrollbarAtCap,
    rowHeightVar,
    undoMenuStatePlugin,
    // `tabMovesFocus` fields swap the "Tab is mine" marker for its opposite:
    // the walk's yield test is structural (any contentEditable owns Tab), so
    // dropping the consume marker alone left the field swallowing Tab into an
    // indent. The release marker is the field saying so out loud.
    initial.tabMovesFocus ? tabReleaseMarker : tabConsumeMarker,
  ];
}

/**
 * Tell the document-level focus walk (`responder-chain-provider`'s capture-phase
 * `focusWalkListener`) that this editing surface owns Tab while it is the active
 * editor. The walk reads `data-tug-tab-consume="true"` on the focused element in
 * capture phase — *before* CM6's own keymaps — and yields Tab to the surface when
 * the marker is present; without it, the walk advances focus and swallows the key.
 *
 * A multi-line editor owns Tab whenever it is focused and editable (Tab indents;
 * the inline ghost / typeahead popup accept it when they are showing) — so the
 * marker tracks focus, not completion state. The single-line `tug-input` /
 * `tug-textarea` deliberately never set it, so Tab tabs out of those as forms
 * expect. [L06] appearance-zone DOM write — never React state.
 */
const tabConsumeMarker = EditorView.updateListener.of((update) => {
  if (!update.focusChanged) return;
  const owns = update.view.hasFocus && !update.state.readOnly;
  if (owns) {
    update.view.contentDOM.setAttribute(TAB_CONSUME_ATTRIBUTE, "true");
  } else {
    update.view.contentDOM.removeAttribute(TAB_CONSUME_ATTRIBUTE);
  }
});

/**
 * The `tabMovesFocus` counterpart ([P04]): tell the walk this surface RELEASES
 * Tab, overruling the structural "a contentEditable owns Tab" default.
 *
 * A `contentAttributes` facet rather than an update listener, because this is a
 * standing property of the surface and not a state it enters — the attribute
 * has to be on `contentDOM` from the first paint, and an update listener does
 * not run until something updates.
 */
const tabReleaseMarker = EditorView.contentAttributes.of({
  [TAB_RELEASE_ATTRIBUTE]: "true",
});

export const TugTextEditor = React.forwardRef<TugTextEditorDelegate, TugTextEditorProps>(
  function TugTextEditor(
    {
      className,
      focusStyle = DEFAULT_FOCUS_STYLE,
      borderless = false,
      suppressCardEngineHooks = false,
      returnAction = DEFAULT_RETURN_ACTION,
      numpadEnterAction = DEFAULT_NUMPAD_ENTER_ACTION,
      onSubmit,
      deferToDefaultButton = true,
      defaultButtonOwnsReturn = false,
      historyProvider,
      completionProviders,
      argumentHintResolver,
      argumentHintRefresh,
      pastedCommandResolver,
      inlineCommandMatcher,
      atomPathRoots,
      completionDirection = "down",
      onTypeaheadChange,
      dropHandler,
      attachmentBytesStore,
      onAttachmentError,
      onPastedOrigins,
      preserveState = true,
      placeholder = "",
      maxRows = DEFAULT_MAX_ROWS,
      growDirection = "down",
      disabled = false,
      tabMovesFocus = false,
      focusGroup,
      focusOrder = 0,
      focusPolicy,
      lineWrap = false,
      lineNumbers: lineNumbersProp = false,
      highlightActiveLineGutter: highlightActiveLineGutterProp = false,
      markdownTextStyling = false,
      fontFamily,
      fontSize,
      lineHeight,
      letterSpacing,
      extensions: extensionsProp,
      style: styleProp,
      ...rest
    }: TugTextEditorProps,
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    // Stable id for this editor's responder, declared up here so
    // `useImperativeHandle`'s focus closure can address the chain via
    // `manager.focusResponder(responderId)`. The actual responder
    // registration happens later (`useOptionalResponder` below) using
    // this same id. `useResponderChain()` returns null outside a
    // chain provider — TugTextEditor uses `useOptionalResponder` so
    // it can render in chain-less harness contexts; the focus
    // delegate falls back to `view.focus()` in that case.
    const responderId = useId();
    const responderChainManager = useResponderChain();
    // Render-flow signal: child <CompletionOverlay /> mounts only when
    // a non-null view is available. The view itself is canonical in
    // `viewRef` (used by every imperative consumer); this state is a
    // structure-zone signal for the child to subscribe to typeahead
    // events on the live view. [L02 — child observes view via this
    // state plus the completion-extension's own subscriber set.]
    const [view, setView] = useState<EditorView | null>(null);
    // Buffered onRestore payload for the rare case where onRestore
    // fires before the EditorView's mount effect creates the view.
    // React fires child effects before parent effects, so a sibling
    // state-preservation registration that lives "above" the editor's
    // mount in the tree can dispatch onRestore one tick earlier than
    // the view is born. The mount effect inspects this ref and
    // replays the buffered restore through the same paint channel
    // (active / inactive) the original onRestore call would have
    // chosen. [L23], [L07].
    const pendingRestoreRef = useRef<PendingEditRestore | null>(null);

    // Snapshot survival across React Fast Refresh's same-instance
    // effect re-run.
    //
    // When Vite hot-replaces a module whose source contains a hook
    // call (e.g. an edit to `tug-text-editor.tsx` itself, or to anything
    // it transitively imports like `tug-text-editor/theme.ts`), Fast
    // Refresh re-runs every effect *defined in that module's
    // source*. The component instance is preserved — `useRef`
    // values survive — but the mount effect's cleanup runs (which
    // destroys the CM6 view) and the body runs again (which
    // creates a fresh empty view). This destroys the user's
    // typed state without going through any framework transition:
    // `useCardStatePreservation`'s effect lives in a *different*
    // source module, so it does NOT re-run, no `register` call
    // happens, and CardHost's remount-detection (which keys off
    // register-twice) doesn't fire. The framework bag is captured
    // by the HMR bridge but no restore replay is triggered.
    //
    // This ref bridges that gap. The mount-effect cleanup writes
    // `captureEditState(view)` here just before destroying the
    // view. The new mount-effect body reads from here and replays
    // through `restoreEditState`, then clears it. On a true
    // remount (cardId changes, cross-pane move) the component
    // instance is gone and so is this ref — the framework bag is
    // the source of truth on those paths, as it should be.
    //
    // This is NOT a sidecar cache competing with the framework bag.
    // It's strictly a substrate-local mechanism for "the substrate
    // remembers across its own effect re-run." The framework bag
    // pipeline (`useCardStatePreservation` ↔ CardHost ↔
    // deck-manager) remains the load-bearing path for every other
    // transition (cold-boot, cross-pane, beforeunload, hard
    // remount); both layers are complementary, with this ref
    // covering the one case the framework can't observe (because
    // its hooks live in a different source module than the one
    // Fast Refresh hot-replaced).
    const fastRefreshSnapshotRef = useRef<TugTextEditingState | null>(null);

    // Enclosing card's id from `CardStatePreservationContext`. Null
    // when this editor is rendered outside a `CardHost` (storybook,
    // unit test). Held in a ref so the mount effect's buffered-
    // restore branch can publish through `selectionGuard` with the
    // card's identity at fire time per [L07] (cross-pane moves
    // preserve cardId in practice, but the ref keeps the contract
    // safe under any future identity-semantics change).
    const cardId = useCardId();
    const cardIdRef = useRef(cardId);
    useLayoutEffect(() => {
      cardIdRef.current = cardId;
    }, [cardId]);

    // Phase E.11 Step 2 — engine-hook registration channel (additive).
    //
    // Register `paintMirrorAsActive` / `paintMirrorAsInactive` hooks
    // with the deck-manager-store so Step 3's `applyBagFocus`
    // dispatcher can invoke them when `bag.focus.kind === "engine"`.
    // The hooks read `viewRef.current` live at fire time per [L07] —
    // identity-stable across re-renders and across CodeMirror's
    // StrictMode mount/cleanup/mount cycle.
    //
    // Registration runs in `useLayoutEffect` keyed on `[cardId]` so
    // it's complete before any framework event that could invoke
    // the hook fires ([L03]). When no `cardId` is present
    // (standalone use outside a `CardStatePreservationContext`), we
    // skip — the imperative-API surface above still allows ad-hoc
    // callers to drive `paintMirrorAsActive` directly.
    //
    // The store registration notifies Phase E.11 Step 4's late-mount
    // subscriber chain (`subscribeEngineHooksChange`) so CardHost's
    // cold-boot RESTORE effect re-fires when a late-mounting engine
    // (dev's editor after `feedsReady`) registers. This wiring
    // exists today but is dead at Step 2 (no consumer); Step 3 wires
    // the dispatcher to invoke through this channel.
    useLayoutEffect(() => {
      if (cardId === null || suppressCardEngineHooks) return;
      const store = getDeckStore();
      if (store === null) return;
      const unregister = store.registerEngineHooks(cardId, {
        paintMirrorAsActive: () => {
          const view = viewRef.current;
          if (view === null) return;
          deckTrace.record({
            kind: "engine-paint-mirror-active",
            cardId,
            caller: "via-engine-hook",
          });
          paintMirrorAsActiveImpl(view);
        },
        paintMirrorAsInactive: () => {
          const view = viewRef.current;
          if (view === null) return;
          deckTrace.record({
            kind: "engine-paint-mirror-inactive",
            cardId,
          });
          paintMirrorAsInactiveImpl(view, (range) => {
            selectionGuard.updateCardDomSelection(cardId, range);
          });
        },
      });
      return unregister;
    }, [cardId, suppressCardEngineHooks]);

    // Preserve caret / selection across an app deactivate → reactivate
    // (cmd-tab away and back). When the OS returns key focus to the
    // window, WebKit re-focuses the still-active `cm-content` and places
    // its own caret — collapsing the user's selection BEFORE the
    // framework's reactivation focus claim (`paintMirrorAsActive`) runs.
    // That claim passes no saved selection on the cmd-tab path (it trusts
    // the live `view.state.selection`, which is now collapsed), so the
    // selection is lost.
    //
    // This is the one transition the card-level deactivate/activate
    // cascade does not cover: on cmd-tab the card never hides and never
    // relinquishes DOM focus, so no `paintMirrorAsInactive` snapshot is
    // taken. We bridge it at the window level — snapshot the live
    // selection on `blur` (the editor is still `document.activeElement`
    // then) and re-assert it on `focus`, after the framework's focus
    // claim and the browser's focus-caret have both landed. The rAF
    // backstop covers an async `selectionchange` that re-collapses after
    // the synchronous pass. [L24] selection lives in CM's
    // `EditorState.selection`; we read and re-write it there, never in
    // React state. [L23] no `scrollIntoView`, so the scroll offset
    // survives the round trip.
    useLayoutEffect(() => {
      if (typeof window === "undefined") return;
      let saved: { from: number; to: number } | null = null;
      const restore = (target: { from: number; to: number }): void => {
        const view = viewRef.current;
        // Only restore into the editor that actually regained focus —
        // a window-focus that lands elsewhere must not pull the caret
        // back here or steal focus.
        if (view === null || !view.hasFocus) return;
        const len = view.state.doc.length;
        const from = Math.min(target.from, len);
        const to = Math.min(target.to, len);
        const live = view.state.selection.main;
        if (live.from === from && live.to === to) return;
        view.dispatch({ selection: EditorSelection.range(from, to) });
      };
      const onWindowBlur = (): void => {
        const view = viewRef.current;
        // Only the focused editor owns a selection worth preserving.
        if (view === null || !view.hasFocus) {
          saved = null;
          return;
        }
        const sel = view.state.selection.main;
        saved = { from: sel.from, to: sel.to };
      };
      const onWindowFocus = (): void => {
        const target = saved;
        saved = null;
        if (target === null) return;
        // Synchronous pass (the framework's window-`focus` listener is
        // registered first, so its `view.focus()` has already run by
        // now) avoids a visible collapse; the rAF pass is the backstop.
        restore(target);
        requestAnimationFrame(() => restore(target));
      };
      window.addEventListener("blur", onWindowBlur);
      window.addEventListener("focus", onWindowFocus);
      return () => {
        window.removeEventListener("blur", onWindowBlur);
        window.removeEventListener("focus", onWindowFocus);
      };
    }, []);

    // Live providers ref. The typeahead extension reads this via a
    // thunk on every transaction, so swapping providers across
    // renders takes effect without rebuilding the editor [L07].
    const completionProvidersRef = useRef<Record<string, CompletionProvider>>(
      completionProviders ?? {},
    );
    useLayoutEffect(() => {
      completionProvidersRef.current = completionProviders ?? {};
    }, [completionProviders]);

    // Live argument-hint resolver ref — read through a thunk by the
    // placeholder plugin, so a resolver swapped across renders (the catalog
    // growing after the handshake) takes effect without rebuilding the
    // editor [L07]. Default no-op when the host supplies none.
    const argumentHintResolverRef = useRef<ArgumentHintResolver>(
      argumentHintResolver ?? (() => null),
    );
    useLayoutEffect(() => {
      argumentHintResolverRef.current = argumentHintResolver ?? (() => null);
    }, [argumentHintResolver]);

    // Same [L07] live-ref pattern for the hint-refresh source, so the plugin
    // re-subscribes to a fresh metadata store (e.g. after `/compact` + resume)
    // without rebuilding the editor. Default null ⇒ the plugin never subscribes.
    const argumentHintRefreshRef = useRef<ArgumentHintRefreshSource | null>(
      argumentHintRefresh ?? null,
    );
    useLayoutEffect(() => {
      argumentHintRefreshRef.current = argumentHintRefresh ?? null;
    }, [argumentHintRefresh]);

    // [L07] live ref: the host handler can arrive or change after mount, and
    // the extension below is built once.
    const onPastedOriginsRef = useRef(onPastedOrigins);
    onPastedOriginsRef.current = onPastedOrigins;

    // Same [L07] live-ref pattern for the pasted-command resolver, so paste
    // recognition reads the current catalog without rebuilding the editor.
    const pastedCommandResolverRef = useRef<PastedCommandResolver | null>(
      pastedCommandResolver ?? null,
    );
    useLayoutEffect(() => {
      pastedCommandResolverRef.current = pastedCommandResolver ?? null;
    }, [pastedCommandResolver]);

    // Same [L07] live-ref pattern for the inline-ghost matcher, so a catalog
    // that grows after the handshake takes effect without rebuilding the editor.
    const inlineCommandMatcherRef = useRef<InlineCommandMatcher>(
      inlineCommandMatcher ?? (() => null),
    );
    useLayoutEffect(() => {
      inlineCommandMatcherRef.current = inlineCommandMatcher ?? (() => null);
    }, [inlineCommandMatcher]);

    // Live observer ref for the optional `onTypeaheadChange` callback
    // — same [L07] pattern: the field-listener captured below reads
    // the current callback so a re-render with a new callback
    // identity doesn't require re-subscribing.
    const onTypeaheadChangeRef = useRef(onTypeaheadChange);
    useLayoutEffect(() => {
      onTypeaheadChangeRef.current = onTypeaheadChange;
    }, [onTypeaheadChange]);

    // Live preferred-direction ref read by the popup positioner.
    const completionDirectionRef = useRef(completionDirection);
    useLayoutEffect(() => {
      completionDirectionRef.current = completionDirection;
    }, [completionDirection]);

    // Live drop-handler ref. The drop extension reads this thunk on
    // every drop so the latest host-supplied handler runs without
    // rebuilding the editor [L07].
    const dropHandlerRef = useRef<DropHandler | null>(dropHandler ?? null);
    useLayoutEffect(() => {
      dropHandlerRef.current = dropHandler ?? null;
    }, [dropHandler]);

    // Live attachment-store ref + error-callback ref. Drop and paste
    // extensions read these thunks at fire time so a late-arriving
    // store (or a host that swaps stores between cards) is picked up
    // without rebuilding the editor [L07]. The default `null` /
    // no-op keeps stand-alone harnesses, gallery cards, and other
    // non-bytes-store consumers running unchanged.
    const attachmentBytesStoreRef = useRef<AtomBytesStore | null>(
      attachmentBytesStore ?? null,
    );
    useLayoutEffect(() => {
      attachmentBytesStoreRef.current = attachmentBytesStore ?? null;
    }, [attachmentBytesStore]);

    // Live path-roots ref, on the same terms and for the same reason: the
    // card's project binding and the session's cwd both land after mount,
    // and an atom mounted before them still has to be stamped with an
    // openable target when they arrive ([L07]).
    const atomPathRootsRef = useRef<(() => AtomPathRoots | null) | undefined>(
      atomPathRoots,
    );
    useLayoutEffect(() => {
      atomPathRootsRef.current = atomPathRoots;
    }, [atomPathRoots]);

    const onAttachmentErrorRef = useRef<(message: string) => void>(
      onAttachmentError ?? (() => undefined),
    );
    useLayoutEffect(() => {
      onAttachmentErrorRef.current = onAttachmentError ?? (() => undefined);
    }, [onAttachmentError]);

    // Snapshot of host-supplied extensions captured at mount only;
    // reactivity inside the host extension itself must come through
    // refs read at fire time per [L07]. Stored in a ref so the StrictMode
    // re-mount path reads the same value even though the closure
    // would otherwise be stale.
    const extensionsRef = useRef<readonly Extension[]>(
      extensionsProp === undefined
        ? []
        : Array.isArray(extensionsProp)
          ? (extensionsProp as readonly Extension[])
          : [extensionsProp as Extension],
    );

    // Snapshot refs for Compartment-wrapped extensions. The mount
    // effect (empty-deps) reads these refs to seed initial values into
    // `buildExtensions`. Subsequent prop changes flow through the
    // matching reconfigure effects below — the refs aren't read again
    // after mount, but they're convenient for the mount path because
    // React 19 StrictMode runs mount → cleanup → mount in dev and the
    // re-mount needs the latest values, not the values from the
    // closure that was captured at first mount [L07].
    const placeholderRef = useRef(placeholder);
    const lineWrapRef = useRef(lineWrap);
    const lineNumbersRef = useRef(lineNumbersProp);
    const highlightActiveLineGutterRef = useRef(highlightActiveLineGutterProp);
    // Read at async-load fire time so a grammar load that resolves after the
    // prop has flipped back off doesn't strand styling on (the flip-during-
    // load race — e.g. the prompt entry switching to the `$` route while the
    // markdown chunk is still downloading) [L07].
    const markdownTextStylingRef = useRef(markdownTextStyling);
    const disabledRef = useRef(disabled);
    // Mount-time only (no compartment) — the value never changes at runtime.
    const tabMovesFocusRef = useRef(tabMovesFocus);
    useLayoutEffect(() => {
      placeholderRef.current = placeholder;
    }, [placeholder]);
    useLayoutEffect(() => {
      lineWrapRef.current = lineWrap;
    }, [lineWrap]);
    useLayoutEffect(() => {
      lineNumbersRef.current = lineNumbersProp;
    }, [lineNumbersProp]);
    useLayoutEffect(() => {
      highlightActiveLineGutterRef.current = highlightActiveLineGutterProp;
    }, [highlightActiveLineGutterProp]);
    useLayoutEffect(() => {
      markdownTextStylingRef.current = markdownTextStyling;
    }, [markdownTextStyling]);
    useLayoutEffect(() => {
      disabledRef.current = disabled;
    }, [disabled]);

    // Reconfigure each Compartment-wrapped extension on prop change.
    // CM6's `compartment.reconfigure(next)` swaps the extension in
    // place — no view rebuild, no document loss, no selection loss.
    // Each effect is independent so a placeholder change doesn't
    // touch the line-wrap state and vice-versa.
    useLayoutEffect(() => {
      const view = viewRef.current;
      if (view === null) return;
      view.dispatch({
        effects: placeholderCompartment.reconfigure(
          placeholder !== "" ? cmPlaceholder(placeholder) : [],
        ),
      });
    }, [placeholder]);
    // `lineWrap` and `lineNumbers` are *structural* prop changes
    // that move the rendered geometry: turning either on or off
    // changes per-line wrap counts (lineWrap) or contentDOM
    // width (lineNumbers, because the gutter takes space from
    // the scroller). Reconfiguring the compartment alone isn't
    // enough — CM6's heightMap caches per-line measurements
    // against the *previous* geometry, so the freshly-built
    // gutter (or the next render after a wrap toggle) reads
    // stale row heights until the next user-input transaction
    // refreshes the cache.
    //
    // Bundling the typography-rev reconfigure into the same
    // dispatch piggybacks the bridge ([typographyRevCompartment])
    // so CM6's `mustMeasureContent` flag flips as part of the
    // same update cycle. The measure pass on the next animation
    // frame refreshes the heightOracle from the now-current
    // computed styles → heightMap rebuilds → the new gutter
    // plugin (or the post-wrap-toggle layout) renders against
    // the fresh metrics. Same RAF, no stale frame.
    useLayoutEffect(() => {
      const view = viewRef.current;
      if (view === null) return;
      view.dispatch({
        effects: [
          lineWrapCompartment.reconfigure(
            lineWrap ? EditorView.lineWrapping : [],
          ),
          typographyRevCompartment.reconfigure(EditorView.theme({})),
        ],
      });
    }, [lineWrap]);
    useLayoutEffect(() => {
      const view = viewRef.current;
      if (view === null) return;
      view.dispatch({
        effects: [
          lineNumbersCompartment.reconfigure(
            lineNumbersProp ? tugLineNumbersGutter : [],
          ),
          typographyRevCompartment.reconfigure(EditorView.theme({})),
        ],
      });
    }, [lineNumbersProp]);
    // Active-line gutter highlight is a pure-appearance toggle
    // (CM6 adds / removes the `cm-activeLineGutter` class on the
    // gutter cell whose line block contains the cursor). It
    // doesn't affect geometry, so no typography-rev piggyback is
    // needed — a plain compartment reconfigure is sufficient.
    useLayoutEffect(() => {
      const view = viewRef.current;
      if (view === null) return;
      view.dispatch({
        effects: activeLineGutterCompartment.reconfigure(
          highlightActiveLineGutterProp ? highlightActiveLineGutter() : [],
        ),
      });
    }, [highlightActiveLineGutterProp]);
    useLayoutEffect(() => {
      const view = viewRef.current;
      if (view === null) return;
      view.dispatch({
        effects: readOnlyCompartment.reconfigure([
          EditorState.readOnly.of(disabled),
          EditorView.editable.of(!disabled),
        ]),
      });
    }, [disabled]);

    // Typography prop changes flow through inline CSS variables on
    // the host wrapper (see `hostStyle` below) — the new values
    // cascade into `.cm-content` and `.cm-gutters` immediately. CM6
    // doesn't observe CSS-variable changes, though: its
    // `heightOracle` caches the measured `font-size` /
    // `line-height` / `char-width` from the last layout pass, and
    // the line-number gutter's per-row heights are part of an
    // internal `RangeSet` that's rebuilt only when an extension
    // reconfigure or a non-empty transaction lands. A
    // CSS-variable-only change leaves both stale — the content
    // re-flows (because plain CSS) but the gutter rows hold their
    // pre-change heights until a transaction fires.
    //
    // Empirically, neither `view.requestMeasure()` nor
    // `view.dispatch({})` (an empty no-op transaction) triggers
    // the gutter's `RangeSet` rebuild — both leave the gutter
    // visibly stale. The reliable hammer is reconfiguring the
    // `lineNumbersCompartment` with its current value: passing
    // the *same* extension instance still forces a compartment
    // swap, which CM6 treats as a structural reconfigure and runs
    // the full update cycle including gutter regeneration. We
    // pair it with `requestMeasure` so any geometry not covered
    // by the reconfigure (e.g. the scroller's height cache) also
    // refreshes on the same frame.
    //
    // The reconfigure is harmless when `lineNumbersProp` is false
    // — it swaps `[]` for `[]` — but it always forces the cycle
    // we need. Heavier than the no-op transaction but the
    // correctness benefit is decisive: gutter rebuilds within one
    // animation frame of the prop change, with no click-to-type
    // required (verified by `at0050`).
    useLayoutEffect(() => {
      const view = viewRef.current;
      if (view === null) return;
      // Bridge typography prop changes (CSS-variable-driven —
      // the browser re-flows automatically) into CM6's
      // `mustMeasureContent` flag — its invalidation primitive,
      // the only thing that tells the next measure pass to
      // re-read computed styles into the `heightOracle`. Without
      // this dispatch, CM6 holds its pre-change cached
      // line-height (and the gutter row heights derived from
      // it) until the next "real" trigger lands — typing,
      // scroll, ResizeObserver. Symptom: the user changes the
      // `lineHeight` prop, the content re-flows immediately,
      // the gutter waits.
      //
      // Mechanism: reconfigure `typographyRevCompartment` to
      // contribute a freshly-built `EditorView.theme({})`. Each
      // call mints a new style-module prefix via
      // `StyleModule.newName()` so the `theme` facet's resolved
      // value differs by reference between transactions. CM6's
      // `view.update` flips the flag in exactly that case:
      //
      //     if (update.startState.facet(theme) != update.state.facet(theme))
      //       this.viewState.mustMeasureContent = true;
      //
      // (`@codemirror/view/dist/index.js`, ~line 7962). The flag
      // flips → next measure pass enters `oracle.refresh(...)`
      // against the now-current computed line-height → the
      // heightMap rebuilds → the gutter plugin picks up the
      // fresh row heights on the post-measure update. End-to-end
      // within one animation frame of the prop change.
      view.dispatch({
        effects: typographyRevCompartment.reconfigure(
          EditorView.theme({}),
        ),
      });
    }, [fontFamily, fontSize, lineHeight, letterSpacing]);

    // Live keymap config. The extension's keydown handler reads
    // `keymapConfigRef.current` via the thunk passed to
    // `tugTextEditorKeymap`, so prop changes take effect on the next
    // keystroke without rebuilding any extension. Initialised with
    // a no-op submit; the layout-effect below installs the real
    // values before any user input can land [L03, L07].
    // Default-button defer: when the responder chain has a button
    // pushed (typically a dialog's primary action), a `submit` Enter
    // inside the editor activates that button instead of the
    // editor's own onSubmit. Reads through a closure over the live
    // manager so a dialog mounted later than the editor still wins.
    const peekDefaultButton = useCallback((): HTMLButtonElement | null => {
      if (!deferToDefaultButton) return null;
      const manager = responderChainManager;
      if (!manager) return null;
      // Pane-scope the defer. The default-button stack is process-global,
      // but a `Return` in THIS editor must only defer to a default button
      // in THIS editor's own pane — never one registered by a sheet in
      // another pane (e.g. an unbound card's picker Open button). Otherwise
      // a `Return` here would press that other pane's button, dismissing
      // its sheet ([D15] pane modality). Resolve the editor's `.tug-pane`
      // and scope the peek to it; with no pane context (gallery /
      // standalone) fall back to the global top.
      const pane = viewRef.current?.dom.closest(".tug-pane") ?? null;
      return pane !== null
        ? manager.peekDefaultButtonInScope(pane)
        : manager.peekDefaultButton();
    }, [responderChainManager, deferToDefaultButton]);
    // Whether a surface above this editor holds Return ([P14]). A thunk over
    // the live prop, read at keystroke time through the config ref below, so a
    // shade that opens after this editor mounted is seen by the very next key.
    const ownsReturn = useCallback(
      (): boolean => defaultButtonOwnsReturn,
      [defaultButtonOwnsReturn],
    );
    const keymapConfigRef = useRef<TugTextEditorKeymapConfig>({
      returnAction,
      numpadEnterAction,
      onSubmit: noopSubmit,
      historyProvider: null,
      peekDefaultButton,
      defaultButtonOwnsReturn: ownsReturn,
    });

    // Mirror the live policy props into the keymap config ref. Runs
    // synchronously in `useLayoutEffect` so the ref is up-to-date
    // before any subsequent keystroke can fire [L03].
    useLayoutEffect(() => {
      keymapConfigRef.current = {
        returnAction,
        numpadEnterAction,
        onSubmit: onSubmit ?? noopSubmit,
        historyProvider: historyProvider ?? null,
        peekDefaultButton,
        defaultButtonOwnsReturn: ownsReturn,
      };
    }, [
      returnAction,
      numpadEnterAction,
      onSubmit,
      historyProvider,
      peekDefaultButton,
      ownsReturn,
    ]);

    // Expose the imperative delegate. The closure reads `viewRef.current`
    // at call time so consumers see the live view across StrictMode's
    // mount/unmount/mount cycle [L07].
    useImperativeHandle(ref, () => ({
      view() {
        return viewRef.current;
      },
      acceptActiveCompletion(): boolean {
        const view = viewRef.current;
        if (view === null) return false;
        const state = getCompletionState(view);
        if (
          !completionPopupIsInteractive({
            active: state.active,
            itemCount: state.filtered.length,
          })
        ) {
          return false;
        }
        acceptCompletionAt(view);
        return true;
      },
      cancelActiveCompletion(): boolean {
        const view = viewRef.current;
        if (view === null) return false;
        const state = getCompletionState(view);
        if (
          !completionPopupIsInteractive({
            active: state.active,
            itemCount: state.filtered.length,
          })
        ) {
          return false;
        }
        cancelCompletion(view);
        return true;
      },
      insertAtom(segment: AtomSegment) {
        const view = viewRef.current;
        if (view === null) return;
        insertAtomAtSelection(view, segment);
      },
      clear() {
        const view = viewRef.current;
        if (view === null) return;
        clearEditor(view);
      },
      focus() {
        // Route focus through the chain primitive when available:
        // `manager.focusResponder(responderId)` promotes the editor
        // to first responder AND invokes the responder's registered
        // `focus` callback (line below in `useOptionalResponder`),
        // which lands DOM focus on `viewRef.current?.focus()`. Going
        // through the chain keeps first-responder state in sync with
        // DOM focus, runs the focus-theft gate, and emits a chain
        // log for the transition — none of which a direct
        // `view.focus()` call would do. [L11]
        //
        // Fallback to direct `view.focus()` outside a
        // `ResponderChainProvider` (standalone harness, unit tests)
        // where the manager is null — same behavior the editor had
        // before this delegate routed through the chain.
        if (responderChainManager !== null) {
          responderChainManager.focusResponder(responderId);
          return;
        }
        const view = viewRef.current;
        if (view === null) return;
        view.focus();
      },
      revealCaret() {
        const view = viewRef.current;
        if (view === null) return;
        revealCaret(view);
      },
      blur() {
        const view = viewRef.current;
        if (view === null) return;
        if (view.hasFocus) view.contentDOM.blur();
      },
      captureState(): TugTextEditingState {
        const view = viewRef.current;
        if (view === null) return { text: "", atoms: [], selection: null };
        return captureEditState(view);
      },
      restoreState(state: TugTextEditingState, opts?: { addToHistory?: boolean }) {
        const view = viewRef.current;
        if (view === null) return;
        restoreEditState(view, state, opts);
      },
      paintMirrorAsActive(state?: TugTextEditingState) {
        const view = viewRef.current;
        if (view === null) return;
        const id = cardIdRef.current;
        if (id !== null) {
          deckTrace.record({
            kind: "engine-paint-mirror-active",
            cardId: id,
            caller: "imperative-api",
          });
        }
        paintMirrorAsActiveImpl(view, state);
      },
      paintMirrorAsInactive(
        publish: (range: Range | null) => void,
        state?: TugTextEditingState,
      ) {
        const view = viewRef.current;
        if (view === null) return;
        const id = cardIdRef.current;
        if (id !== null) {
          deckTrace.record({
            kind: "engine-paint-mirror-inactive",
            cardId: id,
          });
        }
        paintMirrorAsInactiveImpl(view, publish, state);
      },
    }), []);

    // ---------------------------------------------------------------
    // Right-click context menu
    // ---------------------------------------------------------------
    //
    // Mirrors `tug-prompt-input`'s context-menu wiring so the two
    // substrates produce identical UX. The menu itself
    // (`TugEditorContextMenu`) is portaled — its only React state is
    // mount/unmount via the `open` prop. We carry the open lifecycle
    // here as `menuState | null` (component-scoped local data per
    // L06's zone partition), the menu's own internal positioning runs
    // via `useLayoutEffect` + DOM writes inside the menu, and item
    // disabled flags flow through render as data.
    //
    // Pre-right-click selection capture:
    // CM6 wraps a contentEditable; WebKit's "smart click" expands the
    // selection at right-click before our `contextmenu` handler runs.
    // CM6 observes the resulting DOM `selectionchange` and dispatches
    // a transaction, so reading `view.state.selection` in the
    // contextmenu handler would observe the post-expansion state and
    // misreport `hasSelection`. We capture the live selection at
    // pointerdown (button === 2) — which fires before the browser's
    // mousedown default — and dispatch a CM6 transaction in the
    // contextmenu handler to restore it. Whatever WebKit did between
    // pointerdown and contextmenu is undone via the same chain CM6
    // uses for any other selection mutation.

    // The CM6 adapter is held in a ref so the surface listeners and
    // the responder-action handlers all read the same instance. The
    // adapter closes over `viewRef.current` at construction; we
    // refresh it whenever the view identity changes (substrate
    // remount, view recreation).
    const cmAdapterRef = useRef<TextSelectionAdapter | null>(null);
    useLayoutEffect(() => {
      cmAdapterRef.current = view !== null ? createCMSelectionAdapter(view) : null;
    }, [view]);

    // The entity half of this editor's menu. No `codeSessionStore`, and that
    // is the honest answer rather than an omission: this editor IS the
    // prompt, so an Insert into Prompt over an atom already sitting in it
    // would offer to put a thing where it already is. The hook drops the
    // item when no store is given.
    const annotation = useAnnotationMenu({ originRef: hostRef });

    const {
      onContextMenu: onContextMenuOpen,
      menu: contextMenu,
    } = useTextSurfaceContextMenu({
      adapterRef: cmAdapterRef,
      // The entity items come from the registry, keyed off the annotation
      // `AtomWidget.toDOM` stamped on the chip — so a right-click on a file
      // atom in the composer offers what a right-click on a file path in the
      // transcript offers, and neither surface states the list.
      extraEntries: annotation.extraEntries,
      hideStandardItems: annotation.hideStandardItems,
      suppressSelectionChange: annotation.suppressSelectionChange,
    });

    // Attach the contextmenu listener only when the click lands inside the
    // editor's own contentDOM — clicks on host padding fall through to the
    // browser's native menu. The selection clobber itself is stopped by the CM6
    // `domEventHandlers.mousedown` in buildExtensions (CM6's own pointer
    // selection), so no mousedown wiring is needed here.
    useLayoutEffect(() => {
      const host = hostRef.current;
      if (host === null) return;
      const handleContextMenu = (e: MouseEvent) => {
        const v = viewRef.current;
        if (v === null) return;
        if (!v.dom.contains(e.target as Node)) return;
        onContextMenuOpen(e);
      };
      host.addEventListener("contextmenu", handleContextMenu);
      return () => {
        host.removeEventListener("contextmenu", handleContextMenu);
      };
    }, [onContextMenuOpen]);

    // ---------------------------------------------------------------
    // Responder-chain action handlers
    // ---------------------------------------------------------------
    //
    // The app installs a document-level capture-phase keydown listener
    // (`responder-chain-provider.tsx`) that maps Cmd-A / Cmd-C / Cmd-X
    // / Cmd-V / Cmd-Z / Cmd-Shift-Z to action names and dispatches them
    // through the responder chain. Every matched binding calls
    // `event.preventDefault()` BEFORE dispatching, so the editor MUST
    // register handlers — otherwise the suppressed default leaves the
    // keystrokes inert (CM6's own keymap never runs because
    // `event.defaultPrevented` is already true at runHandlers time).
    //
    // All handlers are read live by `useOptionalResponder` through an
    // options ref proxy, so the closures here can capture `viewRef`
    // safely; the handlers run with the latest view at dispatch time
    // [L07]. Each handler returns either `void` (sync-only) or a
    // `() => void` continuation. The keyboard-shortcut path runs
    // continuations immediately; the context-menu path defers them
    // past the activation blink. Mirrors `tug-prompt-input`'s pattern
    // exactly so the two substrates produce identical UX from the
    // chain's perspective.

    const handleSelectAll = useCallback((): ActionHandlerResult => {
      return () => {
        const view = viewRef.current;
        if (view === null) return;
        view.focus();
        selectAll(view);
      };
    }, []);

    const handleUndo = useCallback((): ActionHandlerResult => {
      return () => {
        const view = viewRef.current;
        if (view === null) return;
        view.focus();
        undo(view);
      };
    }, []);

    const handleRedo = useCallback((): ActionHandlerResult => {
      return () => {
        const view = viewRef.current;
        if (view === null) return;
        view.focus();
        redo(view);
      };
    }, []);

    // Write the current selection to the system clipboard through the
    // native bridge: the plain-text fallback on `.string` (for external
    // apps) plus the atom sidecar — including any image bytes — on the
    // Tug-private `dev.tug.prompt-atoms` pasteboard type. This is the
    // robust Tug-to-Tug copy path; it never touches the DOM copy event,
    // so WebKit's pasteboard normalization (which swallows custom MIME
    // types and sanitizes HTML) can't strip the atom data. Returns true
    // when the write was handled natively (including an empty-selection
    // no-op), false when the bridge is unavailable so the caller falls
    // back to `execCommand("copy")`.
    const writeSelectionToNativeClipboard = useCallback((): boolean => {
      const view = viewRef.current;
      if (view === null) return false;
      const { from, to } = view.state.selection.main;
      if (from === to) return true; // nothing selected — handled (no-op)
      const text = view.state.doc.sliceString(from, to);
      const atoms = getAtomsInRange(view.state, from, to);
      const store = attachmentBytesStoreRef.current;
      const getBytes = store !== null ? (id: string) => store.get(id) : undefined;
      const payload = serializeClipboard(text, atoms, from, getBytes);
      return writeClipboardViaNative(
        payload.sidecar !== null ? payload.fallback : payload.text,
        payload.sidecar !== null ? JSON.stringify(payload.sidecar) : "",
      );
    }, []);

    // Copy: inside Tug.app, write the whole selection natively (above).
    // Outside it, focus + execCommand("copy") fires a copy event on the
    // contentDOM that `clipboardExt` (registered in `buildExtensions`)
    // intercepts, writing the plain-text + atom-sidecar payload and
    // calling preventDefault. Sync-only — nothing to defer past the menu
    // blink.
    const handleCopy = useCallback((): ActionHandlerResult => {
      const view = viewRef.current;
      if (view === null) return;
      view.focus();
      if (hasNativeClipboardBridge() && writeSelectionToNativeClipboard()) {
        return;
      }
      document.execCommand("copy");
    }, [writeSelectionToNativeClipboard]);

    // Cut: write the selection (native bridge, or sync `execCommand`
    // fallback so the selection stays painted during a context-menu
    // activation blink — matches `tug-prompt-input`'s split). The
    // continuation deletes the selection through a CM6 transaction so
    // undo / redo see one atomic edit.
    const handleCut = useCallback((): ActionHandlerResult => {
      const view = viewRef.current;
      if (view === null) return;
      view.focus();
      if (!(hasNativeClipboardBridge() && writeSelectionToNativeClipboard())) {
        document.execCommand("copy");
      }
      return () => {
        const live = viewRef.current;
        if (live === null) return;
        const { from, to } = live.state.selection.main;
        if (from === to) return;
        live.dispatch({
          changes: { from, to, insert: "" },
          selection: { anchor: from },
          userEvent: "delete.cut",
        });
      };
    }, [writeSelectionToNativeClipboard]);

    // Delete: remove the selection without touching the clipboard. Same
    // transaction shape as cut's continuation, minus the copy, so undo sees
    // one atomic edit. A collapsed selection is a no-op — Delete acts on a
    // selection, and `validateAction` dims the menu item when there isn't
    // one. Deferred into a continuation like cut's, so a context-menu
    // activation keeps the selection painted through the blink.
    const handleDelete = useCallback((): ActionHandlerResult => {
      const view = viewRef.current;
      if (view === null) return;
      view.focus();
      return () => {
        const live = viewRef.current;
        if (live === null) return;
        const { from, to } = live.state.selection.main;
        if (from === to) return;
        live.dispatch({
          changes: { from, to, insert: "" },
          selection: { anchor: from },
          userEvent: "delete.selection",
        });
      };
    }, []);

    // Paste: prefer the native bridge (Tug.app WKWebView) — Safari's
    // permission popup fires for both `navigator.clipboard.*` and
    // `document.execCommand("paste")`, so the only popup-free read
    // path is to delegate to Swift. Outside Tug.app, fall back to
    // execCommand("paste") which fires a paste event on contentDOM
    // that our `clipboardExt` decodes (atom sidecar or plain text).
    //
    // Bridge-paste atom round-trip: the bridge returns the Tug-private
    // atom sidecar JSON directly on its `atoms` field, read from the
    // `dev.tug.prompt-atoms` pasteboard type our native copy wrote.
    // `parseClipboardSidecar` validates it and `insertSidecar` places it —
    // rehydrating any carried image bytes into this card's store so pasted
    // image chips reconstitute fully, and chipping a leading slash command.
    // When `atoms` is empty (an external clipboard carries no sidecar at
    // all), fall through to the plain-text path below.
    const handlePaste = useCallback((): ActionHandlerResult => {
      const view = viewRef.current;
      if (view === null) return;
      view.focus();
      if (hasNativeClipboardBridge()) {
        const readPromise = readClipboardViaNative();
        return () => {
          void readPromise.then(({ text, atoms }) => {
            const live = viewRef.current;
            if (live === null) return;
            const { from, to } = live.state.selection.main;
            const sidecar = atoms !== "" ? parseClipboardSidecar(atoms) : null;
            if (sidecar !== null) {
              // One insert for both routes into an atom paste — this one and
              // the DOM event's — so a leading slash command chips whichever
              // way the paste arrived.
              insertSidecar(
                live,
                sidecar,
                attachmentBytesStoreRef.current,
                pastedCommandResolverRef.current,
              );
              // Same report the DOM paste path makes: the roots this text was
              // written against, for a host that keeps the text.
              if (sidecar.origins !== undefined) {
                onPastedOriginsRef.current?.(sidecar.origins);
              }
              return;
            }
            if (text === "") return;
            // A slash command at the start of the pasted text chips into a
            // command atom (the rest stays as its argument); same path as the
            // browser-mode paste handler. Falls through to plain text when the
            // text has no recognized leading command.
            const resolve = pastedCommandResolverRef.current;
            if (
              resolve !== null &&
              tryInsertLeadingCommandPaste(live, text, resolve)
            ) {
              return;
            }
            live.dispatch({
              changes: { from, to, insert: text },
              selection: { anchor: from + text.length },
              userEvent: "input.paste",
            });
          });
        };
      }
      document.execCommand("paste");
    }, []);

    // Paste-as-quote / paste-as-plain-text: read the clipboard's plain
    // text and run a transform before inserting. Unlike `handlePaste`,
    // these are plain-text-only — atom sidecars are deliberately ignored
    // because a quoted / de-formatted paste is a text rewrite, not a
    // round-trip of rich content. The native bridge is preferred (the
    // popup-free read path in Tug.app); outside Tug.app we fall back to
    // the async Clipboard API. Both paths defer insertion into the
    // returned continuation so the edit lands after any menu blink.
    const pasteWithTransform = useCallback(
      (transform: (text: string) => string): ActionHandlerResult => {
        const view = viewRef.current;
        if (view === null) return;
        view.focus();
        const insert = (raw: string) => {
          const live = viewRef.current;
          if (live === null) return;
          const text = transform(raw);
          if (text === "") return;
          const { from, to } = live.state.selection.main;
          live.dispatch({
            changes: { from, to, insert: text },
            selection: { anchor: from + text.length },
            userEvent: "input.paste",
            scrollIntoView: true,
          });
        };
        if (hasNativeClipboardBridge()) {
          const readPromise = readClipboardViaNative();
          return () => {
            void readPromise.then(({ text }) => insert(text));
          };
        }
        if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
          const readPromise = navigator.clipboard.readText().catch(() => "");
          return () => {
            void readPromise.then(insert);
          };
        }
        return;
      },
      [],
    );

    const handlePasteAsQuote = useCallback(
      (): ActionHandlerResult => pasteWithTransform(quoteMarkdown),
      [pasteWithTransform],
    );

    const handlePasteAsPlainText = useCallback(
      (): ActionHandlerResult => pasteWithTransform(stripMarkdown),
      [pasteWithTransform],
    );

    // Case transforms: rewrite the selection in one transaction, so undo
    // reverts the whole run rather than a character at a time, and restore
    // the selection over the replacement so a second press acts on the same
    // text. A collapsed selection is a no-op — the verb acts on a selection,
    // the way Delete does. Deferred into a continuation like cut's, so a
    // context-menu activation keeps the selection painted through the blink.
    const transformSelectionCase = useCallback(
      (transform: (text: string) => string): ActionHandlerResult => {
        const view = viewRef.current;
        if (view === null) return;
        view.focus();
        return () => {
          const live = viewRef.current;
          if (live === null || live.state.readOnly) return;
          const { from, to } = live.state.selection.main;
          if (from === to) return;
          const text = transform(live.state.sliceDoc(from, to));
          live.dispatch({
            changes: { from, to, insert: text },
            selection: { anchor: from, head: from + text.length },
            userEvent: "input",
            scrollIntoView: true,
          });
        };
      },
      [],
    );

    const handleMakeUppercase = useCallback(
      (): ActionHandlerResult =>
        transformSelectionCase((text) => text.toUpperCase()),
      [transformSelectionCase],
    );

    const handleMakeLowercase = useCallback(
      (): ActionHandlerResult =>
        transformSelectionCase((text) => text.toLowerCase()),
      [transformSelectionCase],
    );

    // Submit: substrate-level handler so a "Submit" button somewhere
    // up the chain (e.g. in a wrapper compound) reaches the same
    // policy as the keymap's Enter handler. Reads `onSubmit` through
    // the keymap-config ref so the latest closure runs at dispatch
    // time [L07].
    const handleSubmit = useCallback((): ActionHandlerResult => {
      return () => {
        keymapConfigRef.current.onSubmit();
      };
    }, []);

    // ---- Editing motion / deletion ----
    //
    // The four gap-fill actions (Ctrl-U / Ctrl-W / Alt-F / Alt-B)
    // are handled at the keymap layer in `tug-text-editor/keymap.ts`
    // for the keyboard path, where Shift extends selection idiomatically
    // via CM6's `shift:` slot. These responder handlers cover the chain
    // dispatch path — a future settings UI / menu invokes the same CM6
    // commands programmatically. Chain dispatch carries no native event,
    // so motion never extends selection from this path (per [DM05]; the
    // collapsed `cursorGroupForward` / `cursorGroupBackward` are used).
    // The CM6 commands push onto the editor's own `history()` stack, so
    // Cmd-Z reverts the deletions naturally per [DM04].
    const handleDeleteToLineStart = useCallback((): ActionHandlerResult => {
      const view = viewRef.current;
      if (view === null) return;
      view.focus();
      deleteLineBoundaryBackward(view);
    }, []);

    const handleDeleteWordBackward = useCallback((): ActionHandlerResult => {
      const view = viewRef.current;
      if (view === null) return;
      view.focus();
      deleteGroupBackward(view);
    }, []);

    const handleMoveWordForward = useCallback((): ActionHandlerResult => {
      const view = viewRef.current;
      if (view === null) return;
      view.focus();
      cursorGroupForward(view);
    }, []);

    const handleMoveWordBackward = useCallback((): ActionHandlerResult => {
      const view = viewRef.current;
      if (view === null) return;
      view.focus();
      cursorGroupBackward(view);
    }, []);

    // `responderId` is declared near the top of the component
    // (next to `viewRef`) so `useImperativeHandle`'s focus closure
    // can reference it; the registration here uses the same id.
    const actions: Partial<Record<TugAction, ActionHandler>> = {
      // The entity half — Copy Path, Show in Finder, Open Diff, Open Image —
      // acting on the atom the right-click landed on rather than on the
      // selection. First in the literal, so a surface verb below can never be
      // shadowed by one of these silently.
      ...annotation.actions,
      [TUG_ACTIONS.SELECT_ALL]: handleSelectAll,
      [TUG_ACTIONS.UNDO]: handleUndo,
      [TUG_ACTIONS.REDO]: handleRedo,
      [TUG_ACTIONS.COPY]: handleCopy,
      [TUG_ACTIONS.CUT]: handleCut,
      [TUG_ACTIONS.DELETE]: handleDelete,
      [TUG_ACTIONS.PASTE]: handlePaste,
      [TUG_ACTIONS.PASTE_AS_QUOTE]: handlePasteAsQuote,
      [TUG_ACTIONS.PASTE_AS_PLAIN_TEXT]: handlePasteAsPlainText,
      [TUG_ACTIONS.MAKE_UPPERCASE]: handleMakeUppercase,
      [TUG_ACTIONS.MAKE_LOWERCASE]: handleMakeLowercase,
      [TUG_ACTIONS.SUBMIT]: handleSubmit,
      // ---- Editing motion / deletion ----
      [TUG_ACTIONS.DELETE_TO_LINE_START]: handleDeleteToLineStart,
      [TUG_ACTIONS.DELETE_WORD_BACKWARD]: handleDeleteWordBackward,
      [TUG_ACTIONS.MOVE_WORD_FORWARD]: handleMoveWordForward,
      [TUG_ACTIONS.MOVE_WORD_BACKWARD]: handleMoveWordBackward,
      // No OPEN_FILE handler: `open-file` is a chain-routed command the
      // deck implements, and an entry here would intercept every dispatch
      // that walks through this editor — including a click on a file
      // reference elsewhere in the card, which would die on an editor
      // that has no right-clicked atom to open. The "Open in Editor" menu
      // item carries its path as the dispatch's own value instead.
    };
    const { responderRef, ResponderScope } = useOptionalResponder({
      id: responderId,
      actions,
      // Depth-accurate undo/redo enablement for the native Edit menu.
      // The chain consults `validateAction` only for actions this node
      // handles (it's in the actions map), so UNDO/REDO report the live
      // history depth of THIS editor instance — card-specific by
      // construction — and every other handled action stays `true`.
      // Reads `viewRef.current` at query time, never a captured view
      // [L07]; before the EditorView mounts, depth reads as 0 and the
      // items validate disabled, the correct cold posture.
      validateAction: (action) => {
        if (action === TUG_ACTIONS.UNDO) {
          const view = viewRef.current;
          return view !== null && undoDepth(view.state) > 0;
        }
        if (action === TUG_ACTIONS.REDO) {
          const view = viewRef.current;
          return view !== null && redoDepth(view.state) > 0;
        }
        // Delete and the two case transforms write, so they need a writable
        // document — the same gate Cut carries, and the same granularity:
        // selection is not part of it. The pushed edit block is
        // republished on focus and registration changes, not on caret moves,
        // so a selection-granular answer here would be stale by the time the
        // menu opened. The handlers no-op on a collapsed selection. Read from
        // the live view at query time [L07].
        if (
          action === TUG_ACTIONS.DELETE ||
          action === TUG_ACTIONS.MAKE_UPPERCASE ||
          action === TUG_ACTIONS.MAKE_LOWERCASE
        ) {
          const view = viewRef.current;
          return view !== null && !view.state.readOnly;
        }
        return true;
      },
      // Substrate-supplied focus callback per
      // `tugplan-session-popup-bindings.md` [D03] (#focus-contract).
      // `manager.focusResponder(responderId)` invokes this AFTER
      // promoting us to first responder; we land DOM focus on the
      // CodeMirror view's contentDOM via `view.focus()`. The DOM-walk
      // fallback inside `focusResponder` cannot do this correctly:
      // CM6's contenteditable host is not a standard tabbable element
      // and the responder element (the wrapper host div carrying
      // `data-responder-id`) is not the focus target — querying for
      // tabbable descendants would land on a child input or button
      // depending on what's mounted, not on the contentDOM.
      //
      // Reading `viewRef.current` (not the `view` state) means we
      // always invoke `focus()` on the live view, even if the
      // EditorView was rebuilt between registration and invocation
      // (Fast Refresh re-mount, StrictMode double-mount). The captured
      // closure holds the stable ref object [L07]; the live view is
      // read at invocation time. The `?.` no-ops cleanly if the view
      // hasn't mounted yet (registration runs before the EditorView's
      // mount effect on the first render); subsequent invocations
      // observe the view that the mount effect installs.
      focus: () => viewRef.current?.focus(),
    });

    // Focus-engine stop ([P02]), opt-in via `focusGroup`. Registered under the
    // SAME id as the responder above, so the engine's key-view placement
    // resolves this editor's focus CONTRACT (`view.focus()`) rather than
    // walking the host for a tabbable child — and `classifyRoute` reads the
    // contract to route the keyboard `dom-granted`, i.e. straight to the
    // caret. The focusable element is the host wrapper (which also carries
    // `data-responder-id`), so the engine's ring paints on the field.
    const { focusableRef } = useFocusable({
      id: responderId,
      group: focusGroup ?? "",
      order: focusOrder,
      policy: focusPolicy,
      register: focusGroup !== undefined,
    });

// Compose the host ref so a single ref callback writes the local
    // `hostRef`, the `responderRef` (which writes `data-responder-id`
    // for first-responder promotion on click), the focusable
    // registration attribute, and the standard `useRef` slot. Mirrors
    // the `composedRef` pattern in `useTextInputResponder`.
    const composedHostRef = useCallback(
      (el: HTMLDivElement | null) => {
        hostRef.current = el;
        responderRef(el);
        focusableRef(el);
      },
      [responderRef, focusableRef],
    );

    // Mount the EditorView. Cleanup destroys it; re-mount creates
    // a fresh one. See module docstring for the StrictMode rationale [L03].
    useLayoutEffect(() => {
      const host = hostRef.current;
      if (host === null) return;

      // Read the latest prop snapshot for the Compartment-wrapped
      // extensions. The mount effect runs once per StrictMode pass and
      // captures these values; subsequent prop changes flow through
      // the dedicated `useLayoutEffect` reconfigure passes below.
      const initialPlaceholder = placeholderRef.current;
      const initialLineWrap = lineWrapRef.current;
      const initialLineNumbers = lineNumbersRef.current;
      const initialHighlightActiveLineGutter = highlightActiveLineGutterRef.current;
      const initialDisabled = disabledRef.current;
      const initialTabMovesFocus = tabMovesFocusRef.current;

      const state = EditorState.create({
        doc: "",
        extensions: buildExtensions(
          host,
          () => keymapConfigRef.current,
          () => completionProvidersRef.current,
          () => dropHandlerRef.current,
          () => attachmentBytesStoreRef.current,
          () => atomPathRootsRef.current?.() ?? null,
          () => (value: string) => argumentHintResolverRef.current(value),
          () => argumentHintRefreshRef.current,
          () => (query: string) => inlineCommandMatcherRef.current(query),
          () => pastedCommandResolverRef.current,
          (message) => onAttachmentErrorRef.current(message),
          (origins) => onPastedOriginsRef.current?.(origins),
          {
            placeholder: initialPlaceholder,
            lineWrap: initialLineWrap,
            lineNumbers: initialLineNumbers,
            highlightActiveLineGutter: initialHighlightActiveLineGutter,
            disabled: initialDisabled,
            tabMovesFocus: initialTabMovesFocus,
          },
          extensionsRef.current,
        ),
      });
      const view = new EditorView({
        state,
        parent: host,
      });
      viewRef.current = view;
      // Seed the row-height variable from the first measure. `rowHeightVar`
      // keeps it current from there, but a field with a min-height in rows
      // needs the figure at mount — before any update has run — or it opens
      // against the CSS fallback.
      view.requestMeasure({
        read: (v) => v,
        write: (_measured, v) => {
          writeRowHeight(v);
        },
      });
      // Promote the view to React state so the sibling
      // <CompletionOverlay /> can mount and subscribe. The state
      // change runs in the same commit as the mount effect; the
      // overlay's own useLayoutEffect runs on the subsequent commit
      // with the live view.
      setView(view);

      // Atom chips bake their colors at construction time (`tug-atom-img.ts`
      // resolves token values via `getTokenValue` at the moment the
      // `<img>` is built). When the application theme changes, those
      // colors are stale, so we dispatch a `regenerateAtomsEffect` to
      // force every widget to be reconstructed [D05]. Subscription is
      // direct DOM observation per [L22] — no React state round-trip.
      const onThemeChange = (): void => {
        view.dispatch({ effects: regenerateAtomsEffect.of(null) });
      };
      subscribeThemeChange(onThemeChange);

      // A session chip draws the session's DISPLAY title ([D141]), which is the
      // user's own name once they have set one — and a bake cannot subscribe to
      // the store that holds it ([P14]). So a `/rename` comes in the same door
      // a theme switch does: regenerate, and every chip re-bakes against the
      // name the store now holds. Without this an editor holding a session atom
      // would sit showing the callsign of a session that has since been named,
      // which is a resting lie about what the session is called.
      //
      // The name store only. A callsign is minted before any atom of it can
      // exist, so the tag store cannot change a chip's text out from under it —
      // and subscribing to it would regenerate every chip in every editor on
      // every session spawn.
      const unsubscribeNames = sessionNameStore.subscribe(() => {
        view.dispatch({ effects: regenerateAtomsEffect.of(null) });
      });

      // Typeahead popup wiring lives in <CompletionOverlay /> below.
      // The overlay subscribes to subscribeCompletionState(view, ...)
      // in its own useLayoutEffect once `view` (this state) becomes
      // non-null, and owns the popup DOM under a portal into
      // <CanvasOverlayRoot />. The host element here no longer
      // contains the popup div.

      // Emit `engine-ready` for harness tests that gate on the
      // EditorView being constructed inside this card. Mirrors the
      // matching emit site in `tug-prompt-input.tsx`. The cardId is
      // read from the ref so a stand-alone TugTextEditor (no enclosing
      // CardHost) is silent — there's no card to associate the
      // event with.
      const readyCardId = cardIdRef.current;
      if (readyCardId !== null) {
        deckTrace.record({
          kind: "engine-ready",
          cardId: readyCardId,
          engine: "tug-text-editor",
        });
      }

      // Replay any onRestore payload that fired before this mount
      // effect ran. React fires child effects before parent
      // effects, so the `TugTextEditorStatePreservation` child's
      // registration may have dispatched onRestore one tick before
      // the EditorView was constructed. The hook stashed the
      // payload on `pendingRestoreRef`; we apply it now through
      // the appropriate channel, then clear the ref. [L23].
      //
      // Phase E.11 Step 4h — for the `isActive` branch, the replay
      // is `restoreEditState` ONLY. The framework's `applyBagFocus`
      // dispatcher (via CardHost's late-mount retry on
      // `subscribeEngineHooksChange`) owns the focus claim; the
      // engine no longer auto-paints itself active in replay.
      // `restoreEditState` is engine-internal state restore
      // (document content, atoms, selection, scroll) — a different
      // axis from the focus claim — and stays. For the inactive
      // branch, `paintMirrorAsInactive` continues to publish the
      // selection range through `selectionGuard`, which is also a
      // non-focus axis.
      const pending = pendingRestoreRef.current;
      if (pending !== null) {
        const { state: bufferedState, isActive } = pending;
        restoreEditState(view, bufferedState);
        const replayId = cardIdRef.current;
        if (isActive) {
          // Engine focus claim deferred to the framework's
          // `applyBagFocus` retry path. No autonomous paint here.
          void replayId;
        } else {
          if (replayId !== null) {
            deckTrace.record({
              kind: "engine-paint-mirror-inactive",
              cardId: replayId,
            });
          }
          paintMirrorAsInactiveImpl(view, (range) => {
            const id = cardIdRef.current;
            if (id !== null) {
              selectionGuard.updateCardDomSelection(id, range);
            }
          }, bufferedState);
        }
        pendingRestoreRef.current = null;
      } else if (fastRefreshSnapshotRef.current !== null) {
        // No framework-driven restore is pending, but our own
        // mount-effect cleanup just ran (Fast Refresh same-instance
        // effect re-run pattern) and stashed the live state. Replay
        // it through `restoreEditState` — same path the framework's
        // `onRestore` would use, just sourced from our local ref
        // instead of `bag.content`.
        //
        // The cardId-stable framework path skips this branch
        // because `pendingRestoreRef` would have been populated by
        // CardHost's onRestore dispatch on a true remount; it isn't
        // populated here precisely BECAUSE the framework couldn't
        // see this transition (Fast Refresh's effect re-run within
        // a preserved component instance).
        const snapshot = fastRefreshSnapshotRef.current;
        restoreEditState(view, snapshot);
        fastRefreshSnapshotRef.current = null;
      }

      return () => {
        // Capture the live state before destroying the view, so a
        // Fast Refresh same-instance effect re-run can replay it on
        // the next mount-effect body fire. See the
        // `fastRefreshSnapshotRef` declaration above for why this
        // path exists.
        //
        // Guarded on `view.contentDOM.isConnected` so we only
        // capture when there is actually a live DOM-attached view
        // (StrictMode mount → unmount → mount in dev, for example,
        // tears down the view between the two mounts; the second
        // mount would observe the snapshot from the first cleanup
        // and replay an empty-document state, which is a no-op).
        if (view.contentDOM.isConnected) {
          try {
            fastRefreshSnapshotRef.current = captureEditState(view);
          } catch {
            // Capture is best-effort; if anything goes wrong, fall
            // through to the framework bag path on the next true
            // remount.
            fastRefreshSnapshotRef.current = null;
          }
        }
        // Drop the card's last-published Range from selectionGuard
        // so the inactive-selection highlight doesn't linger over
        // DOM nodes that are about to unmount. Mirrors the
        // `tug-prompt-input` cleanup. [L23].
        const id = cardIdRef.current;
        if (id !== null) {
          selectionGuard.updateCardDomSelection(id, null);
        }
        unsubscribeThemeChange(onThemeChange);
        unsubscribeNames();
        view.destroy();
        viewRef.current = null;
        // Clear the React state so <CompletionOverlay /> unmounts
        // its portal in the next commit and any internal subscription
        // is torn down via its effect cleanup.
        setView(null);
      };
    }, []);

    // Markdown text styling — one effect owns every transition (mount
    // included), declared AFTER the mount effect so `viewRef.current` is
    // already live on its first run. There is deliberately no separate
    // mount-kick path: two async paths would race, and a load resolving
    // after the prop flipped off would strand styling on.
    //
    // Enable resolves a promise, so the resolve handler guards against three
    // ways the request can be stale by the time it runs: the effect was
    // cleaned up (`alive`), the view is gone (`viewRef.current`), or the prop
    // already flipped back off (`markdownTextStylingRef.current` — the
    // flip-during-load race, read live per [L07]). Disable is synchronous.
    // [L06] appearance via a compartment swap — no React state, no
    // document/selection loss.
    useLayoutEffect(() => {
      const view = viewRef.current;
      if (view === null) return;
      if (!markdownTextStyling) {
        view.dispatch({
          effects: markdownStylingCompartment.reconfigure([]),
        });
        return;
      }
      let alive = true;
      // The grammar is a static import, so this bundle is built by the time
      // the promise is created and resolves on the next microtask — async in
      // signature, synchronous in practice. The guards below still matter:
      // even one microtask is enough for the prop to flip or the view to go.
      void loadMarkdownTextStyling().then((bundle) => {
        if (!alive) return;
        const live = viewRef.current;
        if (live === null) return;
        if (!markdownTextStylingRef.current) return;
        live.dispatch({
          effects: markdownStylingCompartment.reconfigure(bundle),
        });
      });
      return () => {
        alive = false;
      };
    }, [markdownTextStyling]);

    // Host inline style: caller-supplied `style` flows through first,
    // then we layer the substrate-managed CSS variables on top so prop
    // values win over a generic `style` object. `--tug-text-editor-max-rows`
    // is unitless (consumed by `calc(... * 1lh)` in the CSS); the
    // typography variables fall through verbatim so callers can pass
    // any valid CSS value. Each variable is conditionally set so an
    // omitted prop leaves the existing token cascade intact.
    const hostStyle = useMemo<React.CSSProperties>(() => {
      const next: Record<string, string | number> = {};
      if (styleProp !== undefined) {
        Object.assign(next, styleProp);
      }
      next["--tug-text-editor-max-rows"] = maxRows;
      if (fontFamily !== undefined) {
        next["--tug-font-family-editor"] = fontFamily;
      }
      if (fontSize !== undefined) {
        next["--tug-font-size-editor"] = fontSize;
      }
      if (lineHeight !== undefined) {
        next["--tug-line-height-editor"] =
          typeof lineHeight === "number" ? String(lineHeight) : lineHeight;
      }
      if (letterSpacing !== undefined) {
        next["--tug-letter-spacing-editor"] = letterSpacing;
      }
      return next as React.CSSProperties;
    }, [styleProp, maxRows, fontFamily, fontSize, lineHeight, letterSpacing]);

    return (
      <ResponderScope>
        <div
          ref={composedHostRef}
          data-slot="tug-text-editor"
          data-focus-style={focusStyle}
          // Authored into a focus group ([P02]) — i.e. this editor is a stop in
          // the engine's walk and can become a ringed key view. Gates the
          // key-view ring treatment in the CSS, so an editor that is NOT a stop
          // (the prompt entry, a text card) keeps its own focus language
          // untouched.
          data-focus-stop={focusGroup !== undefined ? "true" : undefined}
          data-borderless={borderless ? "" : undefined}
          data-disabled={disabled ? "" : undefined}
          // Reflect soft-wrap onto the host so the CSS can pin the
          // scroller's horizontal overflow in wrap mode (hung trailing
          // spaces must not scroll the view) without touching the
          // non-wrapping case, which still needs horizontal scroll for
          // long lines.
          data-wrap={lineWrap ? "" : undefined}
          data-grow-direction={growDirection}
          aria-disabled={disabled || undefined}
          className={cn("tug-text-editor", className)}
          style={hostStyle}
          {...rest}
        >
          {/* Right-click context menu. Conditionally rendered so the
              menu component only enters the React tree when actually
              open — keeping its `useRequiredResponderChain` hook off
              the path for stand-alone harnesses (storybook, unit
              tests) that mount `TugTextEditor` outside a
              `ResponderChainProvider` and never open the menu. The
              menu's own internal positioning runs via
              `useLayoutEffect` + DOM writes inside the menu, so the
              only React state involved here is the open lifecycle
              ([L06]). Items dispatch through the responder chain
              ([L11]); the substrate's responder is registered on
              this host so item activations land in the same
              handlers as the keyboard shortcuts. */}
          {contextMenu}
        </div>
        {/* Typeahead overlay. Renders `null` until the view is born;
            once `view` is non-null, mounts a portal into
            <CanvasOverlayRoot /> via `useCanvasOverlay` (or
            document.body fallback if no overlay root is registered
            — e.g., standalone harness). Owns the popup DOM, the
            paint subscription, the `onTypeaheadChange` host-callback
            relay, and a ResizeObserver that re-anchors on host
            bounds change (sash drags). [D01, D02, D03, D07]. */}
        {view !== null && (
          <CompletionOverlay
            view={view}
            hostRef={hostRef}
            onTypeaheadChangeRef={onTypeaheadChangeRef}
            completionDirectionRef={completionDirectionRef}
          />
        )}
        {/* State-preservation registration. Conditional on
            `preserveState` so stand-alone harnesses (storybook,
            unit tests) can opt out. Renders `null` (no DOM); the
            hook is the work — registers `onSave` / `onRestore` /
            `onCardActivated` / `onCardWillDeactivate` with the
            enclosing `CardHost` via `useCardStatePreservation`.
            [L23], [L03]. */}
        {preserveState && (
          <TugTextEditorStatePreservation
            viewRef={viewRef}
            pendingRestoreRef={pendingRestoreRef}
          />
        )}
      </ResponderScope>
    );
  },
);

/**
 * Replace the entire document with the empty string and collapse the
 * caret to offset 0. Atom decorations track document changes (the
 * range mapping in the StateField drops widgets whose covering
 * character is deleted), so the U+FFFC characters and their
 * decorations vanish in the same transaction.
 */
function clearEditor(view: EditorView): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: "" },
    selection: EditorSelection.cursor(0),
    userEvent: "delete.tug-clear",
  });
}

// ---------------------------------------------------------------------------
// Completion overlay (portaled popup shell)
// ---------------------------------------------------------------------------

interface CompletionOverlayProps {
  /** Live `EditorView`. Pre-conditioned on non-null at the call site. */
  view: EditorView;
  /** The editor's host `<div>` ref. Observed by ResizeObserver to re-anchor on host bounds change (sash drag, pane resize). */
  hostRef: React.RefObject<HTMLDivElement | null>;
  /** Live ref to the optional `onTypeaheadChange` callback prop. */
  onTypeaheadChangeRef: React.RefObject<TugTextEditorProps["onTypeaheadChange"]>;
  /** Live ref to the preferred-direction prop. */
  completionDirectionRef: React.RefObject<"up" | "down">;
}

/**
 * `CompletionOverlay` — portaled shell for the typeahead popup.
 *
 * Renders one `<div data-slot="tug-completion-menu">` into
 * `<CanvasOverlayRoot />` via `createPortal` (or `document.body` as
 * fallback when no root is registered, per [D02]). The popup `<div>`
 * is `position: fixed` and `z-index: var(--tug-z-overlay-popup)` so
 * it escapes every pane's `overflow: hidden` and sits visually above
 * the entire pane tree.
 *
 * The popup `<div>` exists in the DOM whenever this component is
 * mounted (i.e., whenever the parent editor has a live view). The
 * painter writes `display: none` when typeahead is inactive and
 * `display: block` when active. We do not conditionally mount the
 * portal on the active boolean because:
 *   - The popup div is DOM-cheap (one empty element).
 *   - Always-mounted means a stable popup ref for the painter; no
 *     gap between "view ready" and "popup div ready" the painter has
 *     to coordinate around.
 *   - Toggling display is what the today's painter already does on
 *     state change; the migration preserves that semantics rather
 *     than introducing a new mount/unmount path.
 *
 * ## Subscriptions
 *
 * Three subscribers, all wired in this component's `useLayoutEffect`:
 *
 *   1. **Paint subscriber** — direct `subscribeCompletionState(view, …)`
 *      callback that runs `paintCompletionPopup(view, popup, direction)`
 *      and forwards to `onTypeaheadChangeRef.current`. Appearance-zone
 *      writes; per [L22] this is direct-DOM, never round-tripped
 *      through React state.
 *
 *   2. **ResizeObserver re-anchor + pane-collapse cancel** — observes
 *      the editor host element. On every observed resize:
 *        - if the host has collapsed to zero size (`offsetHeight === 0`
 *          or `offsetWidth === 0`), the holding pane has collapsed —
 *          dispatch `cancelCompletion(view)` and skip the re-anchor
 *          (no anchor exists when the editor is unrendered);
 *        - otherwise, fire the painter so the popup re-anchors.
 *      Catches sash-drag / pane-resize cases that don't fire window
 *      events and the pane-collapse path that would otherwise leave
 *      the popup orphaned. ([D06] pane-collapse fold-in.)
 *
 *   3. **Companion focus binding** — `useCompanionPopupBinding({
 *      ownerEl: view.contentDOM, onShouldDismiss: () =>
 *      cancelCompletion(view) })`. Observes DOM focus on the editor's
 *      contentDOM. When focus leaves the contentDOM subtree (Radix
 *      mounts a sibling popup and `FocusScope.onMountAutoFocus`
 *      grabs focus into it; the user clicks outside the editor; a
 *      peer card is activated and focus moves to it), dispatches
 *      `cancelCompletion(view)`. Per `tugplan-session-popup-bindings.md`
 *      [D05] (#companion-binding), this signal strict-supersets the
 *      former `cardDidDeactivate` subscription: every dismissal the
 *      old signal triggered, the focus signal also triggers, AND the
 *      focus signal additionally catches the in-card service-popup
 *      case (the "image 5" font-picker bug) that the old signal
 *      missed. The previous deck-manager / `cardDidDeactivate` /
 *      `useCardId` plumbing for this concern is gone.
 *
 * The component itself reads no React state and renders no React
 * children apart from the portaled wrapper — it is structure-zone
 * housekeeping (which DOM exists where) plus the appearance-zone
 * subscribers.
 *
 * Laws: [L02] state observation goes through the per-view subscriber
 *        set the completion-extension already exposes (no React state
 *        copy), [L03] subscriptions and observers register in
 *        `useLayoutEffect` before any user gesture can fire, [L06]
 *        popup body and position are direct DOM writes, [L07] the
 *        `onTypeaheadChange` prop and `direction` prop are read via
 *        refs so a re-render with new identities doesn't re-subscribe,
 *        [L11] `pointerdown` + `acceptCompletionAt` is substrate-internal
 *        (verified across portal detachment in tests/app-test/at0051,
 *        recorded in [D08]), [L22] high-frequency repaints are
 *        direct-DOM not React-state, [L23] typeahead state lives in
 *        CM6's `StateField` and survives this migration trivially.
 */
function CompletionOverlay({
  view,
  hostRef,
  onTypeaheadChangeRef,
  completionDirectionRef,
}: CompletionOverlayProps): React.ReactElement {
  const overlayRoot = useCanvasOverlay();
  const popupRef = useRef<HTMLDivElement | null>(null);

  // Companion focus binding per `tugplan-session-popup-bindings.md` [D05]
  // (#companion-binding). The hook observes DOM focus on the editor's
  // contentDOM and dispatches `cancelCompletion(view)` when focus
  // leaves the subtree — strict-supersets the former
  // `observeCardDidDeactivate` subscription per [L23] and additionally
  // catches the in-card service-popup case (image 5 bug). The hook is
  // tolerant of `view.contentDOM` not being attached yet (no-op until
  // a non-null element is supplied). Listeners install at the document
  // level in `useLayoutEffect` per [L03], ride past in-subtree focus
  // transitions via a microtask defer, and tear down on unmount.
  useCompanionPopupBinding({
    ownerEl: view.contentDOM,
    onShouldDismiss: () => cancelCompletion(view),
  });

  useLayoutEffect(() => {
    const popup = popupRef.current;
    if (popup === null) return;

    // Initial paint: covers the case where the typeahead state was
    // already active when this overlay mounted (e.g., a state
    // restoration that landed an active session in the field).
    paintCompletionPopup(view, popup, completionDirectionRef.current);

    // Paint subscriber — fires on every typeahead-state change.
    // The completion-extension's per-view subscriber set is exactly
    // the right granularity: state changes only flip the snapshot
    // identity on real changes (the field's `update` reducer
    // returns `value` unchanged for non-events), so we only repaint
    // when something actually changed.
    //
    // Tab-consumption is advertised to the focus engine by the
    // focus-driven `tabConsumeMarker` extension (see `buildExtensions`),
    // not here: a focused editor owns Tab whether the popup is open, the
    // inline ghost is showing, or neither (a plain Tab indents). Gating
    // the marker on popup state — as this effect used to — stole Tab from
    // the inline ghost and from plain editing.
    const unsubscribe = subscribeCompletionState(view, () => {
      paintCompletionPopup(view, popup, completionDirectionRef.current);
      const snap = getCompletionState(view);
      onTypeaheadChangeRef.current?.(
        snap.active,
        snap.filtered,
        snap.selectedIndex,
      );
    });

    // ResizeObserver re-anchor + pane-collapse cancel. Pane sash drags
    // do NOT fire window resize/scroll, but they DO change the editor
    // host's bounding rect. Without this, the popup goes stale at its
    // last computed viewport coords. The observer also handles full
    // window resize (the host's rect changes when the viewport does).
    // Coalescing is built into ResizeObserver — no manual rAF/throttle
    // needed unless profiling shows jank.
    //
    // Pane-collapse branch ([D06] fold-in): when the holding pane
    // collapses, the host's `offsetHeight` (or `offsetWidth`) drops to
    // zero. Re-anchoring would dereference a null `coordsAtPos` against
    // an unrendered editor; cancel instead so the popup vanishes
    // alongside the editor. `cancelCompletion` is a no-op when the
    // typeahead session is inactive, so the cancel is safe to fire
    // on the initial observer notification.
    let resizeObserver: ResizeObserver | null = null;
    const host = hostRef.current;
    if (host !== null && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        if (host.offsetHeight === 0 || host.offsetWidth === 0) {
          cancelCompletion(view);
          return;
        }
        // Re-paint goes through the painter's own
        // `view.requestMeasure` so the read happens in the legal
        // layout-read phase. We do not re-paint if the popup is
        // hidden — the painter early-returns on inactive state.
        paintCompletionPopup(view, popup, completionDirectionRef.current);
      });
      resizeObserver.observe(host);
    }

    // Hide-during-gesture / re-pop-after. A pane MOVE rewrites the frame's
    // left/top each frame but leaves the host size unchanged, so the
    // ResizeObserver above never fires and the popup would strand at stale
    // viewport coords (a resize does change the size, so that path already
    // re-anchors). Observe the holding pane's `data-gesture` attribute — set
    // for the duration of a move/resize drag — and repaint on every change:
    // the painter hides the popup while the attribute is present and
    // re-anchors it the instant the gesture ends, with the session intact.
    // DOM-contract coupling only; no import from the pane module.
    let gestureObserver: MutationObserver | null = null;
    const pane = view.dom.closest(".tug-pane");
    if (pane !== null && typeof MutationObserver !== "undefined") {
      gestureObserver = new MutationObserver(() => {
        paintCompletionPopup(view, popup, completionDirectionRef.current);
      });
      gestureObserver.observe(pane, {
        attributes: true,
        attributeFilter: ["data-gesture"],
      });
    }

    return () => {
      unsubscribe();
      resizeObserver?.disconnect();
      gestureObserver?.disconnect();
    };
    // `view` is the externally-changing input; the refs are stable
    // for the component's lifetime by construction. Re-running on
    // view change is correct (a new view means we must re-subscribe
    // against its plugin instance). The companion-focus binding is
    // hoisted into its own `useCompanionPopupBinding` call above and
    // owns its listener lifecycle independently of this effect.
  }, [view, hostRef, onTypeaheadChangeRef, completionDirectionRef]);

  // Render the popup div via portal. Always rendered while the
  // overlay is mounted; visibility is controlled by the painter.
  return createPortal(
    <div
      ref={popupRef}
      data-slot="tug-completion-menu"
      className="tug-completion-menu"
      // Refuse focus-chain promotion: a pointerdown on a completion item
      // must NOT promote the enclosing `deck-canvas` responder, or
      // click-to-accept would steal first-responder from the editor and
      // the accepted atom would land nowhere. The canvas overlay root the
      // menu portals into no longer carries a blanket refuse (it was
      // disambiguated away in `f9a1b5714`), so the menu marks itself —
      // `isFocusRefusing` matches via `.closest()`, covering every item.
      // Pointer events still fire (the accept handler runs); only the
      // capture-phase responder promotion is short-circuited.
      data-tug-focus="refuse"
      style={{
        position: "fixed",
        // `pointer-events: auto` re-enables clicks on this child of
        // the canvas overlay root (which has `pointer-events: none`).
        pointerEvents: "auto",
        // Hidden by default; the painter writes `display: block` on
        // active typeahead state.
        display: "none",
      }}
    />,
    overlayRoot,
  );
}

// ---------------------------------------------------------------------------
// Completion popup painter
// ---------------------------------------------------------------------------

/** Padding between the trigger anchor and the popup. */
const POPUP_GAP = 4;

/** Inset from each viewport edge, so the popup never sits flush. */
const POPUP_VIEWPORT_MARGIN = 8;

/**
 * Pure position-math function. Inputs are viewport-relative; outputs
 * are viewport-relative `top` / `left` for `position: fixed`. Exported
 * for unit tests; the painter inlines the call inside CM6's measure
 * phase.
 *
 * Auto-flip rule:
 *   - `direction = "down"`: open downward iff the space below the
 *     anchor is at least the popup's height OR is at least as much
 *     as the space above.
 *   - `direction = "up"`: open upward iff the space above is at
 *     least the popup's height; otherwise fall back to whichever
 *     side has more room.
 *
 * Horizontal: clamp `anchorCoords.left` so the popup never spills off
 * the viewport. The popup's natural left edge is the trigger char's
 * left edge; the clamp bounds it to `[POPUP_VIEWPORT_MARGIN,
 * viewportWidth - popupWidth - POPUP_VIEWPORT_MARGIN]`.
 *
 * Returns `null` for `top`/`left` when the popup should hide
 * (`anchorCoords` is null — caller maps off-screen).
 */
export interface ComputeCompletionPositionInput {
  anchorCoords: { left: number; top: number; bottom: number } | null;
  popupWidth: number;
  popupHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  direction: "up" | "down";
}

export interface ComputeCompletionPositionOutput {
  /** Top edge in viewport coords, or `null` if anchorCoords was null. */
  top: number | null;
  /** Left edge in viewport coords, or `null` if anchorCoords was null. */
  left: number | null;
  /** Whether the popup opens downward (`true`) or upward (`false`). */
  opensDown: boolean;
}

export function computeCompletionPosition(
  input: ComputeCompletionPositionInput,
): ComputeCompletionPositionOutput {
  const {
    anchorCoords,
    popupWidth,
    popupHeight,
    viewportWidth,
    viewportHeight,
    direction,
  } = input;
  if (anchorCoords === null) {
    return { top: null, left: null, opensDown: direction === "down" };
  }
  // Horizontal clamp. If popup is wider than the viewport (degenerate
  // case), `min` will be greater than `max` after the subtraction;
  // clamp to `POPUP_VIEWPORT_MARGIN` in that case so the popup at
  // least starts at the safe-margin edge rather than off-screen.
  const minLeft = POPUP_VIEWPORT_MARGIN;
  const maxLeft = Math.max(
    POPUP_VIEWPORT_MARGIN,
    viewportWidth - popupWidth - POPUP_VIEWPORT_MARGIN,
  );
  const left = Math.max(minLeft, Math.min(anchorCoords.left, maxLeft));

  // Vertical: pick down vs. up based on the requested `direction`
  // hint plus available viewport space. `direction === "down"` is
  // the default for an editor whose prompt sits in the page's
  // bottom area (typeahead floats above the line); `direction ===
  // "up"` is for editors near the top.
  const spaceAbove = anchorCoords.top - POPUP_VIEWPORT_MARGIN;
  const spaceBelow = viewportHeight - anchorCoords.bottom - POPUP_VIEWPORT_MARGIN;
  const useDown =
    direction === "down"
      ? spaceBelow >= popupHeight || spaceBelow >= spaceAbove
      : spaceAbove < popupHeight && spaceBelow > spaceAbove;

  let top: number;
  if (useDown) {
    top = anchorCoords.bottom + POPUP_GAP;
  } else {
    top = anchorCoords.top - POPUP_GAP - popupHeight;
  }
  return { top, left, opensDown: useDown };
}

/**
 * Repaint the typeahead popup against `popup` (a `<div>` portaled to
 * the canvas overlay root). Called whenever the typeahead state
 * changes via the per-view subscription installed in
 * `CompletionOverlay`.
 *
 * Hides the popup when typeahead is inactive or the filtered list
 * is empty. Otherwise rebuilds the popup body if the items changed,
 * reuses existing DOM nodes when only the selected index moved, and
 * — via a deferred `view.requestMeasure` — positions the popup at
 * the trigger character using viewport-relative coords (the popup
 * is `position: fixed` inside the canvas overlay root).
 *
 * Why the deferred positioning: the painter may be called from a CM6
 * `ViewPlugin.update` listener, which fires DURING CM6's update
 * cycle. Calling `view.coordsAtPos` synchronously from there throws
 * "Reading the editor layout isn't allowed during an update" — CM6
 * catches the throw, logs it, and deactivates the plugin. Once the
 * plugin is deactivated, no further state changes are observed:
 * the popup gets stuck at its last position and stops responding to
 * keyboard navigation. Routing the read+write through
 * `requestMeasure` schedules them in CM6's regular measure phase
 * where layout reads are legal.
 */
function paintCompletionPopup(
  view: EditorView,
  popup: HTMLDivElement | null,
  direction: "up" | "down",
): void {
  if (popup === null) return;
  // While the holding pane is mid move/resize, keep the popup hidden rather
  // than stranded at stale viewport coords: the gesture rewrites the pane's
  // left/top each frame but never re-anchors this portaled (`position: fixed`)
  // popup. The typeahead session stays active throughout; the gesture-end
  // observer in `CompletionOverlay` repaints once `data-gesture` clears,
  // re-anchoring the popup in place. Loose DOM-contract coupling to `tug-pane`
  // (which sets `data-gesture` on its `.tug-pane` frame for the gesture's
  // duration) — no cross-module import.
  if (view.dom.closest(".tug-pane[data-gesture]") !== null) {
    popup.style.display = "none";
    return;
  }
  const state = getCompletionState(view);
  if (!state.active || state.filtered.length === 0) {
    popup.style.display = "none";
    return;
  }
  // ---- Item rendering (synchronous, no DOM measurement needed) ----
  const items = popup.querySelectorAll(".tug-completion-menu-item");
  let same = items.length === state.filtered.length;
  if (same) {
    for (let k = 0; k < state.filtered.length; k++) {
      const label = items[k]?.querySelector(".tug-completion-menu-label");
      if (label?.textContent !== state.filtered[k]!.label) {
        same = false;
        break;
      }
    }
  }
  if (same) {
    items.forEach((el, k) => {
      el.className = "tug-completion-menu-item"
        + (k === state.selectedIndex ? " tug-completion-menu-item-selected" : "");
    });
    popup.style.display = "block";
    (items[state.selectedIndex] as HTMLElement | undefined)?.scrollIntoView({
      block: "nearest",
    });
  } else {
    popup.style.display = "block";
    popup.innerHTML = "";
    state.filtered.forEach((item, i) => {
      const div = document.createElement("div");
      div.className = "tug-completion-menu-item"
        + (i === state.selectedIndex ? " tug-completion-menu-item-selected" : "");
      const label = document.createElement("span");
      label.className = "tug-completion-menu-label";
      if (item.matches && item.matches.length > 0) {
        let pos = 0;
        for (const [start, end] of item.matches) {
          if (start > pos) {
            label.appendChild(document.createTextNode(item.label.slice(pos, start)));
          }
          const mark = document.createElement("span");
          mark.className = "tug-completion-match";
          mark.textContent = item.label.slice(start, end);
          label.appendChild(mark);
          pos = end;
        }
        if (pos < item.label.length) {
          label.appendChild(document.createTextNode(item.label.slice(pos)));
        }
      } else {
        label.textContent = item.label;
      }
      div.appendChild(label);
      // Second column: the command's one-line description, muted and capped
      // at two lines (see tug-completion-menu.css). Omitted when the item
      // carries none, so the row stays label-only.
      if (item.description) {
        const desc = document.createElement("span");
        desc.className = "tug-completion-menu-desc";
        desc.textContent = item.description;
        div.appendChild(desc);
      }
      div.addEventListener("pointermove", (e) => {
        // Move the keyboard selection to the hovered item — but only on a
        // REAL mouse move. Arrow-key navigation scrolls the list (to keep the
        // selected row visible), and scrolling content under a stationary
        // cursor fires `pointermove` with no actual movement; acting on those
        // would let the mouse position hijack the keyboard selection (the
        // selection jumping "with a mind of its own", worst under key-repeat).
        // Compare client coords against the last real move, stored on the
        // popup so every item shares one cursor history.
        const px = String(e.clientX);
        const py = String(e.clientY);
        if (popup.dataset.lastPx === px && popup.dataset.lastPy === py) return;
        popup.dataset.lastPx = px;
        popup.dataset.lastPy = py;
        navigateCompletionByIndex(view, i);
      });
      div.addEventListener("pointerdown", (e) => {
        // Don't let the click steal focus from the editor — the
        // accept transaction below moves the caret deliberately.
        // Confirmed cross-portal-detachment in tests/app-test/at0051.
        e.preventDefault();
        acceptCompletionAt(view, i);
      });
      popup.appendChild(div);
    });
    const selectedEl = popup.children[state.selectedIndex] as HTMLElement | undefined;
    selectedEl?.scrollIntoView({ block: "nearest" });
  }

  // ---- Deferred positioning ----
  // Read coordsAtPos + popup width/height in the measure phase
  // (where layout reads are legal), then write the position styles
  // in the same phase's write step. The `key` field coalesces
  // multiple repaints in the same frame down to a single measurement.
  view.requestMeasure({
    key: "tug-text-editor-completion-position",
    read(): {
      anchorCoords: { left: number; top: number; bottom: number } | null;
      popupWidth: number;
      popupHeight: number;
    } | null {
      if (popup === null) return null;
      const anchorCoords = view.coordsAtPos(state.anchorOffset);
      return {
        anchorCoords,
        popupWidth: popup.offsetWidth,
        popupHeight: popup.offsetHeight,
      };
    },
    write(measured) {
      if (measured === null || popup === null) return;
      const { anchorCoords, popupWidth, popupHeight } = measured;
      const result = computeCompletionPosition({
        anchorCoords,
        popupWidth,
        popupHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        direction,
      });
      if (result.top === null || result.left === null) {
        popup.style.display = "none";
        return;
      }
      popup.style.left = `${result.left}px`;
      popup.style.top = `${result.top}px`;
      // `bottom` is unused in the viewport-relative model — clear any
      // stale value left from a prior in-host-positioned mount, even
      // though that path no longer exists.
      popup.style.right = "";
      popup.style.bottom = "";
    },
  });
}

/** Navigate to a specific item by index — used by the popup's hover handler. */
function navigateCompletionByIndex(view: EditorView, index: number): void {
  const state = getCompletionState(view);
  if (!state.active) return;
  if (index === state.selectedIndex) return;
  navigateCompletion(view, { to: index });
}

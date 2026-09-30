/**
 * TugCodeView — CodeMirror 6-backed read-only code/text viewer.
 *
 * The read-only sibling to `tug-text-editor`. Both are React shells
 * around a CM6 `EditorView`, but their responsibilities are disjoint:
 *
 *  - `TugTextEditor` is sized for *typing* — owns the document, the
 *    caret, selection ranges, an embedded-atom decoration field, a
 *    history, clipboard filters that round-trip atoms, drop handling,
 *    typeahead completion providers, a substrate-specific keymap
 *    (Enter / Cmd-Enter / Cmd-Up / Cmd-Down semantics), and the
 *    responder handlers for the full editing-action vocabulary.
 *  - `TugCodeView` is sized for *displaying file content* — owns the
 *    document only as a way to render bytes the host hands it, exposes
 *    no editing actions, registers only the responder handlers that
 *    a reader needs (SELECT_ALL, COPY, FIND), and ships nothing for
 *    caret / atoms / drop / typeahead / history.
 *
 * Why a peer primitive, not a flag on `tug-text-editor`:
 *  the editor's lifecycle — fast-refresh snapshot ref, state-preservation
 *  bag, responder for cut/paste/undo/redo, atom-decoration field,
 *  drop extension — is sized for an editing surface. Adding a
 *  "read-only" branch that disables half of it pollutes both call
 *  sites. The two primitives share CM6 plumbing (CodeMirror itself,
 *  the `Compartment`-based reconfiguration pattern, the line-numbers
 *  gutter shape) but their React shells stay independent.
 *
 * What this component does:
 *
 *  1. Mounts an `EditorView` in `useLayoutEffect` with empty deps and
 *     disposes it on cleanup, mirroring the StrictMode-safe pattern
 *     from `tug-text-editor` ([L03] before paint; the React 19 dev
 *     mount → cleanup → mount cycle constructs a fresh view each pass).
 *  2. Seeds the document from `value` at mount. On subsequent `value`
 *     changes, dispatches a single replace transaction so the host
 *     can swap displayed content without remounting the view.
 *  3. Three `Compartment`-wrapped extensions reconfigure live without
 *     view rebuilds: soft-wrap (`EditorView.lineWrapping`), line-number
 *     gutter (`lineNumbers()` from `@codemirror/view`), and the
 *     `@codemirror/search` extension that backs the find panel.
 *  4. Registers as a responder for SELECT_ALL, COPY, and FIND. CUT /
 *     PASTE / UNDO / REDO are intentionally NOT registered — a viewer
 *     is read-only by contract; those keystrokes walk past us in the
 *     responder chain to whatever editor or document responder is
 *     above us.
 *
 * Reading the public-API contract:
 *
 *  - `value`: the source text. Required. Updates dispatch a doc
 *    replacement; selection collapses to position 0 on update.
 *  - `wrap`: soft-wrap toggle. Defaults to `true` for file viewing
 *    (long lines wrap rather than horizontally scrolling).
 *  - `lineNumbers`: gutter toggle. Defaults to `true` — file viewers
 *    show line numbers by convention.
 *  - `language`: resolved through `languageForLangId` to a Lezer
 *    grammar + `tugHighlightStyle` (the same highlighting the Text card
 *    editor uses), swapped into a live compartment when the grammar
 *    chunk settles. Unknown/omitted ids stay plain text.
 *  - `className`: composed onto the host `<div class="tug-code-view">`.
 *
 *  Imperative handle (via `ref`):
 *  - `view()`: returns the live `EditorView`, or `null` between
 *    unmount and re-mount. Consumers that need to dispatch
 *    transactions or query state hold this handle.
 *  - `openSearch()`: opens CM6's search panel for find-in-content.
 *    No-op when no view is mounted.
 *
 * Laws:
 *  - [L02] external state (the document) enters via a controlled
 *    `value` prop; CM6 is the runtime store, not React state, but the
 *    flow is one-way (host → view). No `useSyncExternalStore`
 *    machinery is needed because the viewer doesn't expose data
 *    upstream.
 *  - [L03] mount, dispose, and the Compartment reconfigures run in
 *    `useLayoutEffect`, so the responder registration and the view
 *    construction land before paint.
 *  - [L06] all appearance (selection painting, scroll, gutter,
 *    wrap, search panel) flows through CM6's DOM, not React state.
 *  - [L19] component authoring guide — file pair, module docstring,
 *    exported props interface, `data-slot="tug-code-view"` on the
 *    host, a single `body {}` declaring `--tugx-codeview-*` slots.
 *  - [L20] component-token sovereignty — owns the `--tugx-codeview-*`
 *    slot family; consumes `--tugx-block-*` directly for the shared
 *    code-typography pattern.
 *  - [L21] CodeMirror 6 (MIT). See `THIRD_PARTY_NOTICES.md` — the
 *    notice already covers the substrate.
 *
 * @module components/tugways/tug-code-view
 */

import "./tug-code-view.css";

import React, {
  useCallback,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { Compartment, EditorState } from "@codemirror/state";
import type { Extension, SelectionRange } from "@codemirror/state";
import {
  EditorView,
  lineNumbers as cmLineNumbers,
} from "@codemirror/view";
import { selectAll as cmSelectAll } from "@codemirror/commands";
import {
  search,
  SearchQuery,
  setSearchQuery,
  getSearchQuery,
  searchPanelOpen,
  openSearchPanel,
  closeSearchPanel,
  findNext as cmFindNext,
  findPrevious as cmFindPrevious,
  selectMatches as cmSelectMatches,
} from "@codemirror/search";
import { cn } from "@/lib/utils";
import { cm6ScrollAnchor } from "@/lib/cm6-scroll-anchor";
import { copyTextFrom } from "@/lib/copy-text";
import { languageForLangId, tugHighlightStyle } from "@/lib/language-registry";
import { loadMarkdownTextStyling } from "@/components/tugways/tug-text-editor/markdown-text-styling";
import { gutterLineSelectionHandlers } from "@/components/tugways/gutter-line-selection";
import { pressCollapsesSelection } from "@/components/tugways/press-collapses-selection";
import { useOptionalResponder } from "./use-responder";
import { TUG_ACTIONS, type TugAction } from "./action-vocabulary";
import type { ActionHandler } from "./responder-chain";

// ---------------------------------------------------------------------------
// Compartments
// ---------------------------------------------------------------------------
//
// Module-scoped so every TugCodeView mount uses the same Compartment
// identities — the reconfigure path inside the React shell calls
// `compartment.reconfigure(newExt)` on the live view and CM6 swaps the
// contents in place. Mirrors the pattern documented in
// `tug-text-editor.tsx` (see its Compartments section for the full
// rationale).

/** Reconfigurable soft-wrap (`EditorView.lineWrapping` or empty). */
const lineWrapCompartment = new Compartment();

/** Reconfigurable line-number gutter (`lineNumbers()` or empty). */
const lineNumbersCompartment = new Compartment();

/**
 * Reconfigurable syntax highlighting. Starts empty (plain text) and is
 * filled by the language effect once the grammar chunk resolves — the
 * same Lezer grammar + `tugHighlightStyle` the Text card editor uses, so
 * a Read/Write file snippet colors identically to the file open in a
 * Text card.
 */
const languageCompartment = new Compartment();

/**
 * Build the line-number gutter extension for a given starting offset.
 *
 * CM6's `lineNumbers()` numbers the document from 1 — it has no notion
 * of where the buffer sits inside a larger file. When the host hands us
 * a windowed region (a Read with `offset`, say lines 192-213), the
 * document still starts at internal line 1, so the stock gutter would
 * label that first line "1" instead of "192". We close the gap with
 * `formatNumber`: CM6 passes the 1-based document line number and we
 * shift it by `startLine - 1` so the gutter reads as the real file line.
 *
 * `startLine` is 1-based and defaults to 1 (whole-file reads, pastes —
 * any content that already begins at the top of the file), for which
 * the offset is zero and the gutter is unchanged.
 */
function buildLineNumbers(enabled: boolean, startLine: number): Extension {
  if (!enabled) return [];
  // Press a number to select its line, drag to extend by lines — the same
  // handlers the Text card editor's custom gutter carries, so the gesture is
  // one gesture wherever a gutter appears.
  if (startLine <= 1) {
    return cmLineNumbers({ domEventHandlers: gutterLineSelectionHandlers });
  }
  const offset = startLine - 1;
  return cmLineNumbers({
    formatNumber: (lineNo) => String(lineNo + offset),
    domEventHandlers: gutterLineSelectionHandlers,
  });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Viewer theme. Paints the CM6 internals against the shared
 * `--tugx-block-*` family for code typography and `--tugx-codeview-*`
 * for viewer-local concerns (gutter colors, selection tint).
 *
 * Reads CSS variables directly so ironclad ↔ sloop theme switches
 * propagate without remount.
 */
const tugCodeViewTheme: Extension = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--tugx-block-text-color)",
    fontFamily: "var(--tugx-block-code-font)",
    fontSize: "var(--tugx-block-code-font-size)",
    lineHeight: "var(--tugx-block-code-line-height)",
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily: "var(--tugx-block-code-font)",
    lineHeight: "var(--tugx-block-code-line-height)",
    // Reserve scrollbar space in layout even when no scrollbar is
    // visible so growing content doesn't induce horizontal jitter.
    scrollbarGutter: "stable",
  },
  ".cm-content": {
    caretColor: "transparent",
    color: "var(--tugx-block-text-color)",
    padding: "var(--tugx-codeview-content-padding)",
  },
  ".cm-line": {
    padding: "0 var(--tugx-codeview-line-padding-x)",
    // See the Text card theme: the markdown hanging-indent decoration adds
    // to this knob so its inline `padding-left` keeps the line inset.
    "--tugx-cm-line-pad-x": "var(--tugx-codeview-line-padding-x)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--tugx-codeview-gutter-bg)",
    borderRight: "1px solid var(--tugx-codeview-gutter-border)",
    color: "var(--tugx-codeview-gutter-text)",
    fontFamily: "var(--tugx-block-code-font)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 var(--tugx-codeview-gutter-padding-x)",
    minWidth: "var(--tugx-codeview-gutter-min-width)",
  },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "var(--tugx-codeview-selection-bg)",
  },
  // CM6's bundled search panel — hidden from view but still mounted
  // in the DOM. Mounting initializes the search-state `panel` field
  // (which CM6's `searchHighlighter` requires to be non-null before
  // painting match decorations — see `@codemirror/search/dist/index.js`
  // `highlight({query, panel})`). The `@codemirror/search` plumbing
  // and the delegate's search methods stay dormant — no UI drives
  // them today; they remain as latent capability for a future Find
  // redesign.
  ".cm-panels": {
    display: "none",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--tugx-codeview-match-bg)",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "var(--tugx-codeview-match-active-bg)",
    outline: "1px solid var(--tugx-codeview-match-active-outline)",
    // Brief "ping" each time a new match becomes the active one.
    // Keyframes live in `tug-code-view.css` so the host CSS file
    // owns `@keyframes` / theme-token resolution (CM6's `EditorView
    // .theme` only emits property declarations, not @-rules).
    // CM6's search highlighter swaps this class onto the new match's
    // span each navigation step, which (re)triggers the animation.
    animation:
      "var(--tugx-codeview-match-flash-name) var(--tugx-codeview-match-flash-duration) var(--tugx-codeview-match-flash-easing) 1",
  },
});

// ---------------------------------------------------------------------------
// Imperative handle
// ---------------------------------------------------------------------------

/**
 * Search-query configuration passed to `TugCodeViewDelegate.setSearchQuery`.
 *
 * Maps 1-1 to `@codemirror/search`'s `SearchQuery` constructor — kept
 * as a stand-alone interface so consumers don't import CM6 types.
 */
export interface TugCodeViewSearchQuery {
  /** Search string (literal substring unless `regexp` is set). */
  search: string;
  /** Case-sensitive match. Default `false`. */
  caseSensitive?: boolean;
  /** Interpret `search` as a regular expression. Default `false`. */
  regexp?: boolean;
  /** Match whole-word only. Default `false`. */
  wholeWord?: boolean;
}

/**
 * Imperative handle exposed via `ref`.
 *
 * Consumers that need to reach into the live CM6 view hold this handle
 * and call methods at use time. `view()` returns `null` between unmount
 * and re-mount — for example during React 19 StrictMode's dev
 * double-mount, or after the component has been disposed.
 *
 * The Find UI is owned by the COMPOSING component (e.g. `FileBlock`),
 * not by CM6's bundled panel. TugCodeView exposes the programmatic
 * search controls below; the host composes them with its own chrome
 * (`<TugInput>`, `<TugIconButton>`, `<TugCheckbox>`) so the Find UI is
 * consistent with the rest of the Tug component vocabulary.
 */
export interface TugCodeViewDelegate {
  /** Return the live `EditorView`, or `null` if not mounted. */
  view(): EditorView | null;
  /**
   * Set / replace the active search query. The substrate paints
   * match highlights for the resulting query — pass an empty
   * `search` if you want to update options without showing matches.
   */
  setSearchQuery(query: TugCodeViewSearchQuery): void;
  /**
   * Tear down the active search. Drops the query and clears all match
   * highlights from the substrate. Call when the host's Find UI closes.
   */
  clearSearch(): void;
  /** Find next match against the current query. */
  findNext(): void;
  /** Find previous match against the current query. */
  findPrevious(): void;
  /** Select all matches for the current query. */
  selectAllMatches(): void;
  /**
   * Count matches in the current document for the active query.
   * Returns 0 when there is no query (or the query is invalid — e.g.
   * an empty regex). Reads the live `EditorState` synchronously, so
   * call after the most recent `setSearchQuery` dispatch to read the
   * count for the new query.
   */
  getMatchCount(): number;
  /**
   * Select (and reveal) the `ordinal`-th match of the active query —
   * 0-based, in document order. The selected match wears the
   * `.cm-searchMatch-selected` styling; CM6 search works off the
   * document, so an off-viewport ordinal reveals correctly. Returns
   * `false` when there is no such match (no/invalid query, or ordinal
   * out of range).
   */
  selectMatch(ordinal: number): boolean;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/**
 * Props for `TugCodeView`. The component renders a host `<div>` around
 * the live `EditorView`; standard `<div>` props (`className`, `style`,
 * `data-*`) flow through to the host.
 */
export interface TugCodeViewProps {
  /**
   * Source text. Required. Changes after mount dispatch a single
   * replace transaction that swaps the document in place; selection
   * collapses to position 0.
   */
  value: string;
  /**
   * Language identifier (e.g. `"typescript"`, `"python"`). Resolved
   * through `languageForLangId` to the same Lezer grammar +
   * `tugHighlightStyle` the Text card editor uses, so a snippet colors
   * identically to the file open in a Text card. Unknown/omitted ids
   * render as plain text.
   */
  language?: string;
  /**
   * Render with the shared markdown **text styling** bundle instead of a
   * `language` grammar: the markdown grammar + `tugEditingHighlightStyle` +
   * the list hanging-indent plugin (`loadMarkdownTextStyling`, the same
   * styling the Text-card editor applies). Raw markdown syntax stays visible;
   * wrapped list continuations hang-indent under their content. Takes
   * precedence over `language`. Pair with `wrap` (the default) so the hang is
   * visible. @default false
   */
  markdownTextStyling?: boolean;
  /**
   * Soft-wrap. Adds `EditorView.lineWrapping` to the compartment when
   * `true`; removes it when `false`.
   * @default true
   */
  wrap?: boolean;
  /**
   * Line-number gutter. Adds `lineNumbers()` from `@codemirror/view`
   * to the compartment when `true`; removes it when `false`.
   * @default true
   */
  lineNumbers?: boolean;
  /**
   * 1-based file line number of the first line of `value`. The gutter
   * offsets its labels by `startLine - 1` so a windowed read (Read with
   * `offset`) shows real file line numbers rather than counting from 1.
   * @default 1
   */
  startLine?: number;
  /** Forwarded class name for cascade-scoped customization. */
  className?: string;
  /**
   * Called when the responder chain receives `FIND` (e.g. user presses
   * Cmd-F inside the editor). Composing components wire this to their
   * own Find-UI toggle. When unset, FIND inside the editor is a no-op.
   */
  onFindRequested?: () => void;
  /**
   * Called whenever CM6 would scroll a range into view (search next /
   * previous, selection updates, etc.). The viewer ALWAYS consumes
   * CM6's internal scroll request — `TugCodeView` is read-only and
   * sized to fit its content, so the inner `.cm-scroller` should never
   * scroll. The composing host typically lives inside an outer
   * scrollport (e.g. the transcript scrollport, a card body, …) and
   * is the right surface to scroll. Implementations should compute
   * the target position via `view.coordsAtPos(range.head)` and adjust
   * their outer scrollport's `scrollTop`. When unset, the request is
   * silently dropped.
   *
   * Scroll handlers must not initiate editor updates (per CM6's
   * `scrollHandler` facet contract).
   */
  onScrollIntoView?: (view: EditorView, range: SelectionRange) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Read-only CM6-backed code/text viewer. See the module docstring
 * for the lifecycle, API contract, and the responder vocabulary.
 */
export const TugCodeView = React.forwardRef<
  TugCodeViewDelegate,
  TugCodeViewProps
>(function TugCodeView(
  {
    value,
    language,
    markdownTextStyling = false,
    wrap = true,
    lineNumbers = true,
    startLine = 1,
    className,
    onFindRequested,
    onScrollIntoView,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Stable id for this viewer's responder. Captured up here so the
  // imperative-handle focus closure can address the chain.
  const responderId = useId();

  // Live prop refs read at mount-effect time. React 19 StrictMode runs
  // mount → cleanup → mount in dev; the re-mount pass needs the latest
  // values, not the values from the closure that was captured at first
  // mount [L07].
  const wrapRef = useRef(wrap);
  const lineNumbersRef = useRef(lineNumbers);
  const startLineRef = useRef(startLine);
  // Latest `onFindRequested` callback. The responder-chain `FIND`
  // handler reads this so it picks up prop changes without recomposing
  // the actions object on every render.
  const onFindRequestedRef = useRef<(() => void) | undefined>(onFindRequested);
  // Latest `onScrollIntoView` callback. The scroll-handler extension
  // is wired ONCE at mount and reads the freshest callback through
  // this ref so the host can swap closures without re-mounting CM6.
  const onScrollIntoViewRef = useRef<
    ((view: EditorView, range: SelectionRange) => void) | undefined
  >(onScrollIntoView);
  useLayoutEffect(() => {
    wrapRef.current = wrap;
  }, [wrap]);
  useLayoutEffect(() => {
    lineNumbersRef.current = lineNumbers;
  }, [lineNumbers]);
  useLayoutEffect(() => {
    startLineRef.current = startLine;
  }, [startLine]);
  useLayoutEffect(() => {
    onFindRequestedRef.current = onFindRequested;
  }, [onFindRequested]);
  useLayoutEffect(() => {
    onScrollIntoViewRef.current = onScrollIntoView;
  }, [onScrollIntoView]);

  // ---- Imperative handle (delegate) ----

  const setSearchQueryFn = useCallback((spec: TugCodeViewSearchQuery) => {
    const view = viewRef.current;
    if (view === null) return;
    // CM6's `searchHighlighter` ViewPlugin only paints decorations when
    // `panel != null` in the search state field (see
    // `@codemirror/search/dist/index.js`: `highlight({query, panel})`
    // returns `Decoration.none` if panel is null). The bundled panel
    // is hidden via the editor theme below — keeping it open is the
    // mechanism that activates the highlighter; the composing
    // component still owns the user-facing Find chrome (its own
    // `<TugInput>` / `<TugCheckbox>` / `<TugIconButton>` row).
    if (!searchPanelOpen(view.state)) {
      openSearchPanel(view);
    }
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: spec.search,
          caseSensitive: spec.caseSensitive ?? false,
          regexp: spec.regexp ?? false,
          wholeWord: spec.wholeWord ?? false,
        }),
      ),
    });
  }, []);

  const clearSearchFn = useCallback(() => {
    const view = viewRef.current;
    if (view === null) return;
    // Drop the query and close the bundled panel so the highlighter
    // returns to `Decoration.none` and the search state is fully
    // released until the user opens find again.
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: "" })),
    });
    if (searchPanelOpen(view.state)) {
      closeSearchPanel(view);
    }
  }, []);

  const findNextFn = useCallback(() => {
    const view = viewRef.current;
    if (view === null) return;
    cmFindNext(view);
  }, []);

  const findPreviousFn = useCallback(() => {
    const view = viewRef.current;
    if (view === null) return;
    cmFindPrevious(view);
  }, []);

  const selectAllMatchesFn = useCallback(() => {
    const view = viewRef.current;
    if (view === null) return;
    cmSelectMatches(view);
  }, []);

  const getMatchCountFn = useCallback((): number => {
    const view = viewRef.current;
    if (view === null) return 0;
    const query = getSearchQuery(view.state);
    // Empty / invalid queries (e.g. empty regex) yield zero matches.
    // The `valid` flag covers both cases per the @codemirror/search
    // SearchQuery contract.
    if (!query.valid) return 0;
    const cursor = query.getCursor(view.state);
    let count = 0;
    let next = cursor.next();
    while (!next.done) {
      count += 1;
      next = cursor.next();
    }
    return count;
  }, []);

  const selectMatchFn = useCallback((ordinal: number): boolean => {
    const view = viewRef.current;
    if (view === null || ordinal < 0) return false;
    const query = getSearchQuery(view.state);
    if (!query.valid) return false;
    const cursor = query.getCursor(view.state);
    let i = 0;
    let next = cursor.next();
    while (!next.done) {
      if (i === ordinal) {
        const { from, to } = next.value;
        view.dispatch({
          selection: { anchor: from, head: to },
          effects: EditorView.scrollIntoView(from, { y: "center" }),
        });
        return true;
      }
      i += 1;
      next = cursor.next();
    }
    return false;
  }, []);

  useImperativeHandle(
    ref,
    (): TugCodeViewDelegate => ({
      view: () => viewRef.current,
      setSearchQuery: setSearchQueryFn,
      clearSearch: clearSearchFn,
      findNext: findNextFn,
      findPrevious: findPreviousFn,
      selectAllMatches: selectAllMatchesFn,
      getMatchCount: getMatchCountFn,
      selectMatch: selectMatchFn,
    }),
    [
      setSearchQueryFn,
      clearSearchFn,
      findNextFn,
      findPreviousFn,
      selectAllMatchesFn,
      getMatchCountFn,
      selectMatchFn,
    ],
  );

  // ---- Responder registration ----

  const handleSelectAll = useCallback((): void => {
    const view = viewRef.current;
    if (view === null) return;
    cmSelectAll(view);
  }, []);

  const handleCopy = useCallback((): void => {
    const view = viewRef.current;
    if (view === null) return;
    // CM6 doesn't expose a "copy" command directly because the
    // browser's clipboard copy handler runs against the focused
    // contenteditable. With our content focused, the browser's
    // native copy works on the current selection. Selection-empty
    // fallback: copy the whole document.
    const { from, to } = view.state.selection.main;
    const text =
      from === to
        ? view.state.doc.toString()
        : view.state.sliceDoc(from, to);
    // Code and diffs name files; the copy carries the project it was read
    // against so those names still resolve wherever it lands.
    void copyTextFrom(view.dom, text);
  }, []);

  // FIND comes in via the responder chain (e.g. user presses Cmd-F).
  // TugCodeView no longer hosts a panel itself; the action surfaces to
  // the composing component via the `onFindRequested` prop so the host
  // can toggle its own Tug-styled find UI.
  const handleFind = useCallback((): void => {
    onFindRequestedRef.current?.();
  }, []);

  const actions: Partial<Record<TugAction, ActionHandler>> = {
    [TUG_ACTIONS.SELECT_ALL]: handleSelectAll,
    [TUG_ACTIONS.COPY]: handleCopy,
    [TUG_ACTIONS.FIND]: handleFind,
  };

  const { responderRef, ResponderScope } = useOptionalResponder({
    id: responderId,
    actions,
    // Substrate-supplied focus callback. `manager.focusResponder(id)`
    // promotes us to first responder, then invokes this to land DOM
    // focus on CM6's contentDOM. Reading `viewRef.current` (not a
    // closure-captured view) means we always invoke `focus()` on the
    // live view, even after a StrictMode re-mount.
    focus: () => viewRef.current?.focus(),
  });

  // Compose host ref so a single callback writes both the local
  // `hostRef` and the chain's `responderRef` (which sets
  // `data-responder-id` on the host for click-driven promotion).
  const composedHostRef = useCallback(
    (el: HTMLDivElement | null) => {
      hostRef.current = el;
      responderRef(el);
    },
    [responderRef],
  );

  // ---- Mount the EditorView ----

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const initialWrap = wrapRef.current;
    const initialLineNumbers = lineNumbersRef.current;
    const initialStartLine = startLineRef.current;

    const state = EditorState.create({
      doc: value,
      extensions: [
        EditorState.readOnly.of(true),
        lineWrapCompartment.of(
          initialWrap ? EditorView.lineWrapping : [],
        ),
        lineNumbersCompartment.of(
          buildLineNumbers(initialLineNumbers, initialStartLine),
        ),
        // Empty until the language effect resolves the grammar chunk.
        languageCompartment.of([]),
        // A primary press inside a ranged selection collapses it now rather
        // than on release — otherwise the whole range stays painted for as
        // long as the button is held. See `press-collapses-selection.ts`.
        pressCollapsesSelection,
        // The search extension is always present so `setSearchQuery`
        // effects work; the bundled panel is NOT used (we don't bind
        // its keymap). The composing component owns the Find UI via
        // the delegate's `setSearchQuery`/`findNext`/`findPrevious`
        // methods. The responder chain exposes FIND so Cmd-F surfaces
        // to the host via `onFindRequested`.
        search({ top: true }),
        // Universal scroll intercept. `TugCodeView` is sized to fit
        // its content (no inner scroller), so CM6's default
        // `scrollIntoView` would only adjust the `.cm-scroller`
        // scrollTop — which scrolls nothing visually because the
        // viewport equals the content. The composing host owns the
        // surrounding scrollport and is the right surface to scroll.
        // Returning `true` consumes the request; CM6 skips its
        // internal `scrollRectIntoView` walk. The host callback is
        // read through a ref so a host swap doesn't require a CM6
        // remount.
        EditorView.scrollHandler.of((view, range) => {
          onScrollIntoViewRef.current?.(view, range);
          return true;
        }),
        // Keeps the viewport-top LINE across a card width change, and
        // publishes it for the cross-mount save path. A pixel offset means
        // nothing after a re-wrap; a line does.
        cm6ScrollAnchor(),
        tugCodeViewTheme,
      ],
    });

    const view = new EditorView({
      state,
      parent: host,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Empty deps — mount once per StrictMode pass. Value swaps and
    // compartment reconfigures happen in dedicated effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Value swap ----

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    if (view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      // Collapse selection to 0 on doc swap; the prior selection is
      // not meaningful against a new document.
      selection: { anchor: 0 },
    });
  }, [value]);

  // ---- Wrap reconfigure ----

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({
      effects: lineWrapCompartment.reconfigure(
        wrap ? EditorView.lineWrapping : [],
      ),
    });
  }, [wrap]);

  // ---- Line-numbers reconfigure ----
  //
  // Tracks both the gutter toggle and the starting offset: a `value`
  // swap to a region with a different `startLine` (e.g. re-reading the
  // same file at a new offset) must re-derive the gutter's `formatNumber`.

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({
      effects: lineNumbersCompartment.reconfigure(
        buildLineNumbers(lineNumbers, startLine),
      ),
    });
  }, [lineNumbers, startLine]);

  // ---- Language / syntax highlighting ----
  //
  // Resolved asynchronously (the grammar chunk lazy-loads); the
  // compartment swap lands whenever the import settles. The `alive`
  // guard drops a late-resolving grammar after the language prop changed.
  // Same grammar + `tugHighlightStyle` the Text card editor uses.
  useLayoutEffect(() => {
    let alive = true;
    // The markdown text-styling bundle takes precedence over a `language`
    // grammar: it carries its own markdown grammar + editing highlight + list
    // hanging-indent. Unlike the language chunks below it is a static import,
    // so it settles on the next microtask; the `alive` guard still applies.
    if (markdownTextStyling) {
      void loadMarkdownTextStyling().then((bundle) => {
        if (!alive) return;
        viewRef.current?.dispatch({
          effects: languageCompartment.reconfigure(bundle),
        });
      });
      return () => {
        alive = false;
      };
    }
    const lang = language ?? null;
    if (lang === null) {
      viewRef.current?.dispatch({
        effects: languageCompartment.reconfigure([]),
      });
      return;
    }
    void languageForLangId(lang).then((resolved) => {
      if (!alive) return;
      const view = viewRef.current;
      if (view === null) return;
      view.dispatch({
        effects: languageCompartment.reconfigure(
          resolved !== null ? [resolved, tugHighlightStyle] : [],
        ),
      });
    });
    return () => {
      alive = false;
    };
  }, [language, markdownTextStyling]);

  return (
    <ResponderScope>
      <div
        ref={composedHostRef}
        data-slot="tug-code-view"
        className={cn("tug-code-view", className)}
      />
    </ResponderScope>
  );
});

/**
 * TugTextCardEditor — CodeMirror 6-backed read-write file editing surface.
 *
 * The third CM6 primitive, peer to `tug-text-editor` (the prompt
 * composer) and `tug-code-view` (the read-only viewer). Forked from
 * `TugCodeView`'s shell — same StrictMode-safe mount, Compartment
 * reconfiguration, host-owned Find UI — with the write side grafted
 * from `TugTextEditor`'s responder shape: full editing-action
 * registration, plain-text clipboard through the native bridge (no
 * atom sidecar — files are plain text), CM6 `history()` with the
 * shared undo-menu-state plugin, and a right-click context menu via
 * `useTextSurfaceContextMenu`.
 *
 * File drops ARE here, but only as file drops: bytes are copied into an
 * `assets/` folder beside the document and a standard markdown link is
 * inserted at the drop caret (`tug-text-card-editor/file-drop`). The
 * composer's caret affordance is reused; none of its atom or attachment
 * machinery is.
 *
 * What is deliberately NOT here (prompt-only concerns): atoms,
 * completion/typeahead, inline attachment payloads, submit/history
 * navigation, the custom caret/selection layers (native caret and
 * `::selection` work fine without atom widgets in the document).
 *
 * Document ownership: CM6 is the runtime store for the text — the
 * document never enters React state. The component binds to a
 * `TextCardStore` (the card's autosave engine) through the
 * `TextCardBridge` contract:
 *
 *   - mount seeds the document from `snapshot.seedContent`;
 *   - every user edit calls `store.noteEdit()` (arming the autosave
 *     debounce); the store reads the buffer back via `getText()` at
 *     flush time;
 *   - external-change reverts arrive via `replaceText()`, a single
 *     transaction of MINIMAL changes annotated so the update listener
 *     does NOT re-arm autosave; CM6 maps caret, selection, and the
 *     scroll anchor through it, so the view holds its place;
 *   - `getPositions()`/`applyPositions()` carry cursor + scroll for
 *     the card bag (positions-only persistence).
 *
 * Full height: the host fills the card body and CM6's `.cm-scroller`
 * owns scrolling (unlike both siblings — the composer is auto-height,
 * the viewer content-sized). CM6's viewport virtualization handles
 * large documents from this configuration.
 *
 * Laws:
 *  - [L02] document lives in CM6; React renders only from props.
 *  - [L03] mount, bridge attach, and responder registration in
 *    `useLayoutEffect`.
 *  - [L06] all appearance through CM6's DOM and the theme extension.
 *  - [L07] every handler reads `viewRef.current` / prop refs at
 *    dispatch time, never captured closures.
 *  - [L11] this component owns the caret, selection, undo stack, and
 *    disk binding — it registers as the responder for the actions
 *    that mutate them (cut/copy/paste/selectAll/undo/redo/save).
 *  - [L12] `data-tug-select="custom"` exempts the CM6 surface from
 *    SelectionGuard clipping (the editor owns selection autonomously).
 *  - [L19]/[L20] file pair, `data-slot`, `--tugx-textcard-*` slots.
 *  - [L21] CodeMirror 6 (MIT) — covered in `THIRD_PARTY_NOTICES.md`.
 *
 * @module components/tugways/tug-text-card-editor
 */

import "./tug-text-card-editor.css";
// The find landing-flash ring class + keyframes — the SAME one-shot accent
// ring the Session card's transcript find draws ([L14] reduced-motion aware).
import "./transcript-find.css";
import { placeFindFlash, type FindFlashHandle } from "./find-flash";

import React, {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightWhitespace,
  lineNumbers as cmLineNumbers,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { foldGutter as cmFoldGutter, indentUnit } from "@codemirror/language";
import {
  defaultKeymap,
  history,
  historyKeymap,
  redo,
  redoDepth,
  selectAll as cmSelectAll,
  undo,
  undoDepth,
} from "@codemirror/commands";
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
} from "@codemirror/search";

import { cn } from "@/lib/utils";
import { cm6ScrollAnchor } from "@/lib/cm6-scroll-anchor";
import { minimalTextChanges } from "@/lib/minimal-text-changes";
import {
  clipboardOriginFor,
  stampClipboardOrigin,
} from "@/lib/clipboard-origin";
import {
  hasNativeClipboardBridge,
  readClipboardViaNative,
  writeClipboardViaNative,
} from "@/lib/tug-native-clipboard";
import { quoteMarkdown, stripMarkdown } from "@/lib/paste-transforms";
import type {
  TextCardStore,
  FilePositions,
} from "@/lib/text-card-store";
import {
  DEFAULT_TEXT_CARD_SETTINGS,
  type TextCardSettings,
} from "@/lib/text-card-settings";
import { FONT_STACKS } from "@/lib/editor-settings-store";
import type { EditorStats } from "@/lib/editor-stats-store";
import { countWords, wordCountDelta } from "@/lib/word-count";
import { languageForExtension, tugEditingHighlightStyle } from "@/lib/language-registry";

import { mdListHangingIndent } from "./tug-text-editor/list-hanging-indent";
import { tugTabKeyBinding } from "./editor-tab-key";
import { anchorLinkExtension } from "./tug-text-card-editor/anchor-links";
import {
  fileDropExtension,
  linksForFiles,
} from "./tug-text-card-editor/file-drop";
import {
  extractImageFiles,
  parseClipboardSidecar,
  withClipboardOrigins,
} from "./tug-text-editor/clipboard-filters";
import {
  assetMarkdownForPaste,
  buildAssetSidecar,
  insertPastedText,
} from "./tug-text-card-editor/asset-clipboard";
import {
  assetTrashEffectHandler,
  assetTrashInvertedEffects,
} from "./tug-text-card-editor/asset-trash";
import { directoryOf, resolveRelativePath } from "@/lib/asset-links";
import type { AssetProjection } from "@/lib/asset-projection";
import {
  fetchAttachBase,
  type AssetBaseDescriptor,
} from "@/lib/attachment-upload";
import { useOptionalResponder } from "./use-responder";
import { useFocusable } from "./use-focusable";
import { useCardId } from "./use-card-state-preservation";
import { getDeckStore } from "@/lib/deck-store-registry";
import { TUG_ACTIONS, type TugAction } from "./action-vocabulary";
import type { ActionHandler, ActionHandlerResult } from "./responder-chain";
import { useTextSurfaceContextMenu } from "./use-text-surface-context-menu";
import { createCMSelectionAdapter } from "./tug-text-editor/selection-adapter";
import { gutterLineSelectionHandlers } from "./gutter-line-selection";
import { pressCollapsesSelection } from "./press-collapses-selection";
import type { TextSelectionAdapter } from "./text-selection-adapter";
import { undoMenuStatePlugin } from "./tug-text-editor/undo-menu-state-plugin";
import { tugTextCardEditorTheme } from "./tug-text-card-editor/theme";

// ---------------------------------------------------------------------------
// Compartments and annotations
// ---------------------------------------------------------------------------

/** Reconfigurable soft-wrap (`EditorView.lineWrapping` or empty). */
/** How a paste reshapes the clipboard's text before it is inserted. */
type PasteTransform = (text: string) => string;

/**
 * A plain paste, as opposed to Paste as Quote or Paste as Plain Text.
 *
 * Hoisted to a constant so it has a stable identity the paste path can compare
 * against: only a *plain* paste turns a clipboard attachment into a file and a
 * link. The transforming pastes are explicitly asking for text, and quoting a
 * markdown image link is a perfectly reasonable thing to want.
 */
const IDENTITY_TRANSFORM: PasteTransform = (text) => text;

const lineWrapCompartment = new Compartment();

/** Reconfigurable line-number gutter. */
const lineNumbersCompartment = new Compartment();

/**
 * The gutter, when it is shown: the stock line numbers wearing the substrate's
 * press-and-drag line selection, so a number selects the line it names here as
 * it does in every other gutter-bearing surface.
 */
const lineNumbersGutter = cmLineNumbers({
  domEventHandlers: gutterLineSelectionHandlers,
});

/** Reconfigurable read-only state (permission-refused files). */
const readOnlyCompartment = new Compartment();

/** Reconfigurable language/highlighting slot (installed per file type). */
const languageCompartment = new Compartment();

/** Reconfigurable code-folding gutter. */
const foldGutterCompartment = new Compartment();

/** Reconfigurable whitespace rendering (`highlightWhitespace` or empty). */
const whitespaceCompartment = new Compartment();

/** Reconfigurable indent unit + tab width (soft tabs / spaces per tab). */
const tabConfigCompartment = new Compartment();

/** Reconfigurable active-line highlight (line + gutter cell). */
const activeLineCompartment = new Compartment();

/**
 * The `[tabSize, indentUnit]` pair for a given settings snapshot. Soft
 * tabs make the Tab key (via {@link tugTabKeyBinding}) advance to the next
 * tab stop in spaces; hard tabs insert a literal `\t`. `tabSize` also
 * sets how a literal tab already in the file is rendered/measured.
 */
function tabConfigFor(settings: TextCardSettings): Extension {
  const unit = settings.softTabs ? " ".repeat(settings.tabSize) : "\t";
  return [EditorState.tabSize.of(settings.tabSize), indentUnit.of(unit)];
}

/** Doc-derived stats (recomputed only when the document changes). */
interface DocStats {
  lines: number;
  words: number;
  chars: number;
}

/**
 * Soft-wrap extensions for a settings snapshot. When wrap is on we also
 * install the markdown list hanging indent, so a wrapped list item's
 * continuation aligns under its content instead of the marker.
 */
function lineWrapFor(settings: TextCardSettings): Extension {
  return settings.lineWrap
    ? [EditorView.lineWrapping, mdListHangingIndent]
    : [];
}

/** The active-line-highlight extensions for a settings snapshot. */
function activeLineFor(settings: TextCardSettings): Extension {
  return settings.highlightActiveLine
    ? [highlightActiveLine(), highlightActiveLineGutter()]
    : [];
}

/**
 * Whitespace rendering. `highlightWhitespace()` marks both spaces
 * (`.cm-highlightSpace`) and tabs (`.cm-highlightTab`); which glyphs
 * actually paint is narrowed by the host's `data-show-spaces` /
 * `data-show-tabs` attributes in CSS, so the two toggles are
 * independent without a custom decoration.
 */
function whitespaceFor(settings: TextCardSettings): Extension {
  return settings.showSpaces || settings.showTabs ? highlightWhitespace() : [];
}

/**
 * Reflect the two invisibles toggles onto the host as data attributes
 * the CSS reads to narrow `highlightWhitespace`'s glyphs per kind.
 * DOM-only ([L06]) — no React state.
 */
function applyWhitespaceAttrs(host: HTMLElement, settings: TextCardSettings): void {
  host.dataset.showSpaces = String(settings.showSpaces);
  host.dataset.showTabs = String(settings.showTabs);
}

/**
 * Publish the chosen face and size onto the host as the editor-local
 * typography slots. The CM6 theme reads `--tugx-textcard-font` /
 * `--tugx-textcard-font-size` (see `tug-text-card-editor.css`), which
 * default to the shared `--tugx-block-code-*` pair — so a card that has
 * never been tuned looks exactly as it did. DOM-only ([L06], [L22]) —
 * typography is appearance, never React state.
 */
function applyTypographyVars(host: HTMLElement, settings: TextCardSettings): void {
  const stack = FONT_STACKS[settings.fontId];
  if (stack) host.style.setProperty("--tugx-textcard-font", stack);
  host.style.setProperty("--tugx-textcard-font-size", `${settings.fontSize}px`);
}

/**
 * Marks a store-driven document replacement (external-change revert).
 * The update listener skips `noteEdit` for annotated transactions so a
 * revert never re-arms the autosave debounce.
 */
const externalReplace = Annotation.define<boolean>();

/**
 * Map a persisted `{ line, ch }` pair to a clamped document offset in
 * `state`. Line/ch (not a raw offset) is the currency for both the card
 * bag and in-place reloads so a restore survives content that shifted.
 */
function offsetForLineCh(
  state: EditorState,
  p: { line: number; ch: number },
): number {
  const lineNumber = Math.max(1, Math.min(p.line, state.doc.lines));
  const line = state.doc.line(lineNumber);
  return line.from + Math.min(p.ch, line.length);
}

// ---------------------------------------------------------------------------
// Reveal flash — a momentary accent highlight over jumped-to lines
// ---------------------------------------------------------------------------
//
// When the editor reveals a passage (a tool-call file-ref click landing
// on the touched line(s)), a transient LINE decoration washes those
// lines in the theme accent and fades out — a momentary "look here" that
// leaves no persistent selection (the reveal places a plain caret, so
// the Active-line highlight settles on the target once the flash ends).
// Appearance only: a CM6 line decoration + a CSS `@keyframes` in
// `tug-text-card-editor.css`, never React state ([L06]). Cleared after the
// animation window so it neither lingers nor re-fires on later edits.

/** Set the flashed line span (doc positions), or `null` to clear it. */
const setRevealFlash = StateEffect.define<{ from: number; to: number } | null>();

/** The per-line flash decoration (washes the whole `.cm-line`). */
const revealFlashLine = Decoration.line({ class: "tug-textcard-reveal-flash" });

/** How long the flash decoration lives before it is cleared (ms). Must
 *  outlast the CSS animation so the wash completes its single fade. */
const REVEAL_FLASH_MS = 900;

const revealFlashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setRevealFlash)) {
        if (effect.value === null) {
          deco = Decoration.none;
        } else {
          const { doc } = tr.state;
          const lines: ReturnType<typeof revealFlashLine.range>[] = [];
          let pos = effect.value.from;
          const end = Math.min(effect.value.to, doc.length);
          while (pos <= end) {
            const line = doc.lineAt(pos);
            lines.push(revealFlashLine.range(line.from));
            if (line.to + 1 <= pos) break; // guard against zero-advance
            pos = line.to + 1;
          }
          deco = Decoration.set(lines);
        }
      }
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// ---------------------------------------------------------------------------
// Delegate
// ---------------------------------------------------------------------------

/** Search-query configuration (mirrors `TugCodeViewSearchQuery`). */
export interface TugTextCardEditorSearchQuery {
  search: string;
  caseSensitive?: boolean;
  regexp?: boolean;
  wholeWord?: boolean;
}

/** Imperative handle exposed via `ref`. */
/**
 * Enumeration cap for `getMatchInfo` — mirrors the transcript engine's
 * `DEFAULT_MATCH_LIMIT` so a degenerate query over a huge file cannot stall
 * the chip's per-keystroke recount. A capped count renders as `N+`.
 */
const MATCH_INFO_CAP = 5000;

export interface TugTextCardEditorDelegate {
  /** The live `EditorView`, or `null` if not mounted. */
  view(): EditorView | null;
  /** Land DOM focus on the editing surface. */
  focus(): void;
  /**
   * The editor's responder id. A caller that needs the editor to become
   * the chain FIRST RESPONDER — not merely DOM-focused — uses this with
   * `manager.focusResponder(id)`: a bare `focus()` is a no-op when the
   * editor already holds DOM focus, so it can't repair a DOM-focus /
   * first-responder divergence (e.g. after a title-bar drag promoted the
   * pane). See responder-chain.md § "Bringing DOM focus in sync".
   */
  responderId(): string;
  /**
   * Reveal line(s) and momentarily flash them in the theme accent. Places
   * a plain caret at the start of `line` (1-based, clamped), centers it,
   * and washes `line`..`endLine` (or just `line`) with a fading accent
   * highlight — no persistent selection. The transcript's tool-call
   * file-ref links land here: a Read jumps to its window start, an Edit
   * flashes its first changed line(s).
   *
   * A `columns` pair narrows the flash to a character range within `line`
   * — 0-based, half-open, as the wire carries a search ref's match span.
   */
  revealLine(
    line: number,
    endLine?: number,
    columns?: readonly [number, number],
  ): void;
  /**
   * The same reveal, addressed by document offsets rather than lines. The
   * attachment strip knows where a link *is* — it parsed it — and converting
   * to a line number and back would be a round trip through information the
   * caller already has and the editor is about to re-derive.
   */
  revealOffsets(from: number, to: number): void;
  /** Set / replace the active search query (paints match highlights). */
  setSearchQuery(query: TugTextCardEditorSearchQuery): void;
  /**
   * Record where the reader is, so the next search lands there rather than
   * at the top of the file. `"viewport"` takes the first position of the
   * line block at the scrollport's top edge; `"selection"` takes the main
   * selection's `from` — which is what makes ⌘E land on the very text the
   * user selected rather than on the next occurrence after it.
   *
   * The card calls this as find OPENS, and only then: a bar already open
   * has an anchor that its own navigation keeps up to date.
   */
  captureFindAnchor(source: "viewport" | "selection"): void;
  /**
   * Select the first match at or after the anchor and reveal it, wrapping
   * to the document's first match when there is none. Selection + scroll
   * only; no focus claim, so a find field driving this keeps its caret.
   * No-op when the query has no match.
   *
   * It scrolls only when the match is not already fully inside the
   * scrollport: a search whose answer is already on screen should not move
   * the page out from under the reader to re-centre it.
   */
  selectMatchFromAnchor(): void;
  /** Tear down the active search and clear match highlights. */
  clearSearch(): void;
  findNext(): void;
  findPrevious(): void;
  /** Count matches for the active query (0 when none / invalid). */
  getMatchCount(): number;
  /**
   * Count + active ordinal for the shared find cluster. The walk is capped
   * (a huge file's enumeration must not stall typing): `capped` is `true`
   * when the cap was hit, and the chip renders `N+`. The active ordinal is
   * the match whose range equals the current main selection (the
   * `findNext`/`findPrevious` landing), or `null` when the selection sits
   * elsewhere.
   */
  getMatchInfo(): { count: number; activeOrdinal: number | null; capped: boolean };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TugTextCardEditorProps {
  /**
   * The card's autosave engine. The editor seeds its document from the
   * store's snapshot at mount, reports edits via `noteEdit`, and
   * attaches the `TextCardBridge` so the store can read the buffer
   * at flush time and replace it on external-change reverts.
   */
  store: TextCardStore;
  /**
   * Refuse edits (permission-refused files). Reconfigures
   * `EditorState.readOnly` live; the store separately refuses to arm
   * autosave while read-only.
   * @default false
   */
  readOnly?: boolean;
  /**
   * CM6 view settings (line numbers, soft wrap, soft tabs, tab width,
   * fold gutter, active-line highlight, invisibles). Seeded from the
   * deck-wide Text Card defaults and overridden per card by the gear
   * popup; each field reconfigures its compartment live.
   * @default DEFAULT_TEXT_CARD_SETTINGS
   */
  settings?: TextCardSettings;
  /**
   * File extension (no dot) whose grammar to load for syntax
   * highlighting, or null for plain text. The Text card derives this
   * from the file's path, overridable by the status-bar file-type
   * popup. Plain text while the grammar chunk loads.
   */
  languageExt?: string | null;
  /** Forwarded class name. */
  className?: string;
  /**
   * Called when the responder chain receives `FIND` (Cmd-F inside the
   * editor). The Text card wires this to its find-bar toggle.
   */
  onFindRequested?: () => void;
  /**
   * Called when the responder chain receives `FIND_SELECTION` (⌘E) over a
   * ranged selection, carrying the selected text. The Text card opens its
   * find bar seeded with it — the editor supplies the query because the
   * editor owns the selection model; the card owns the bar.
   */
  onFindSelectionRequested?: (query: string) => void;
  /**
   * Invoked after this editor's OWN find-navigation handlers run (⌘G /
   * ⇧⌘G handled here because the walk from the focused document reaches
   * this responder first). The host forwards it to the find bar so the
   * count badge tracks navigations made outside the bar.
   */
  onFindNavigated?: () => void;
  /**
   * Route a save-verb chain action (⌘S and the File menu items) up to the
   * card, which owns the save panels and confirm sheets. In manual mode
   * `SAVE` routes here too (the card's `save()` + needs-path panel flow);
   * in automatic mode `SAVE` stays the in-editor `saveNow()` flush.
   */
  onSaveCommand?: (
    command: "save" | "save-as" | "save-a-copy" | "revert-to-saved" | "reload-from-disk",
  ) => void;
  /**
   * Publish live document/selection stats (caret line/col, line/word/
   * char counts) for the card's status bar. Fires once at mount, then
   * on every selection or document change.
   */
  onStats?: (stats: EditorStats) => void;
  /**
   * Register the editor as a focus-engine stop in this group ([P02]).
   * Omit and the editor registers nothing — it is then reachable only by
   * click and by the card's own focus reclaim, never by Tab or by a ring.
   */
  focusGroup?: string;
  /** Order within {@link focusGroup}. Defaults to 0 (registration order breaks ties). */
  focusOrder?: number;
  /**
   * The card's attachment strip ([P01]). The editor feeds it the buffer's text
   * source and the document's asset base — the two things only the editor
   * knows — and the card renders the tiles it publishes. Omit and no strip is
   * derived.
   */
  assetProjection?: AssetProjection;
  /**
   * Open an absolute path a ⌘-clicked relative link resolved to. Omit and
   * relative links are inert. The card wires this to `openFileInCard`, the
   * one implementation behind every "open this path" entry point.
   */
  onOpenPath?: (path: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const TugTextCardEditor = React.forwardRef<
  TugTextCardEditorDelegate,
  TugTextCardEditorProps
>(function TugTextCardEditor(
  {
    store,
    readOnly = false,
    settings = DEFAULT_TEXT_CARD_SETTINGS,
    languageExt,
    className,
    onFindRequested,
    onFindSelectionRequested,
    onFindNavigated,
    onSaveCommand,
    onStats,
    focusGroup,
    focusOrder = 0,
    assetProjection,
    onOpenPath,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // View identity as React state — structural: the selection adapter
  // (context menu) must be rebuilt when the view is recreated.
  const [view, setView] = useState<EditorView | null>(null);

  const responderId = useId();

  // Live prop/store refs read at event time [L07].
  const storeRef = useRef(store);
  const settingsRef = useRef(settings);
  const readOnlyRef = useRef(readOnly);
  const onFindRequestedRef = useRef<(() => void) | undefined>(onFindRequested);
  const onFindSelectionRequestedRef = useRef<((query: string) => void) | undefined>(
    onFindSelectionRequested,
  );
  const onFindNavigatedRef = useRef<(() => void) | undefined>(onFindNavigated);
  const onSaveCommandRef = useRef<TugTextCardEditorProps["onSaveCommand"]>(onSaveCommand);
  const onStatsRef = useRef<((stats: EditorStats) => void) | undefined>(onStats);
  useLayoutEffect(() => {
    onSaveCommandRef.current = onSaveCommand;
  }, [onSaveCommand]);
  // ⌘-click anchor navigation jumps through this ref so the mount-time
  // extension always calls the latest `revealLine` closure [L07].
  const anchorNavigateRef = useRef<(line: number) => void>(() => {});
  const openRelativeRef = useRef<(path: string) => void>(() => {});
  openRelativeRef.current = onOpenPath ?? (() => {});
  // The document's asset base ([P02]): the draft home when the buffer carries a
  // `draftId`, else the directory holding its path. It is resolved
  // asynchronously because a draft home lives under `data_dir()`, which is
  // per-instance and only the host can compute — and it is read through a ref
  // at dispatch time, never captured at extension-construction time ([L07]).
  const assetBaseRef = useRef<string | null>(null);
  // Read at dispatch time by the editor's update listener, which is built once
  // at mount ([L07]).
  const assetProjectionRef = useRef<AssetProjection | undefined>(assetProjection);
  assetProjectionRef.current = assetProjection;
  // The CM6 paste handler is built once at mount, so it reaches the shared
  // attachment routine through a ref rather than closing over it ([L07]).
  const pasteAttachmentsRef = useRef<() => Promise<boolean>>(async () => false);
  /**
   * Write the selection to the clipboard with its attachment sidecar, and on a
   * cut, remove it. Returns `true` when it claimed the event.
   *
   * Owning the whole write is what the prompt entry does, for the same reason:
   * WebKit's pasteboard normalization swallows custom types, so a sidecar left
   * to the default `copy` would simply not arrive. The plain-text flavor stays
   * the literal markdown, so an external app pastes what the document says.
   */
  const writeSelectionSidecar = useCallback(
    (view: EditorView, event: ClipboardEvent, isCut: boolean): boolean => {
      if (isCut && readOnlyRef.current) return false;
      const { from, to } = view.state.selection.main;
      if (from === to) return false;
      const text = view.state.sliceDoc(from, to);
      // Provenance rides beside the attachments: a plan document's prose cites
      // repo paths the same way a transcript's does, and the sidecar is the
      // only flavor that can carry the root either of them means.
      const sidecar = withClipboardOrigins(
        buildAssetSidecar(text, assetBaseRef.current),
        text,
        clipboardOriginFor(view.dom),
      );
      if (sidecar === null) return false; // Nothing to carry — let the default run.
      if (!hasNativeClipboardBridge()) return false;
      if (!writeClipboardViaNative(text, JSON.stringify(sidecar))) return false;
      event.preventDefault();
      if (isCut) {
        view.dispatch({
          changes: { from, to, insert: "" },
          selection: { anchor: from },
          userEvent: "delete.cut",
        });
      }
      return true;
    },
    [],
  );
  /**
   * Which document an attachment belongs to, read at gesture time ([L07]).
   * A draft id when the buffer has one, else its path — every document has one
   * or the other from its first keystroke, which is what removes the untitled
   * precondition entirely ([P02]).
   */
  const assetBaseDescriptor = useCallback((): AssetBaseDescriptor | null => {
    const snapshot = storeRef.current.getSnapshot();
    if (snapshot.draftId !== null) return { draft: snapshot.draftId };
    if (snapshot.path !== null) return { doc: snapshot.path };
    return null;
  }, []);
  /**
   * Report one file's failure where the user is already looking — the tile
   * that stands for it ([P06]). There is no error vocabulary above this: a
   * modal banner could only ever say *something* failed, while a tile names
   * the file and offers the retry.
   */
  const reportAttachmentFailure = useCallback(
    (name: string, message: string): void => {
      assetProjectionRef.current?.noteFailure(name, message);
    },
    [],
  );
  useEffect(() => {
    let cancelled = false;
    // Re-resolve only when the *binding* changes. The store notifies on every
    // dirty-state transition, and refetching a draft home per keystroke would
    // be exactly the kind of writer the typing-lag campaign has been removing.
    let lastBinding: string | null = null;
    const resolve = (): void => {
      const snapshot = storeRef.current.getSnapshot();
      const binding =
        snapshot.draftId !== null
          ? `draft:${snapshot.draftId}`
          : `path:${snapshot.path ?? ""}`;
      if (binding === lastBinding) return;
      lastBinding = binding;
      if (snapshot.draftId === null) {
        const base = snapshot.path === null ? null : directoryOf(snapshot.path);
        assetBaseRef.current = base;
        stampClipboardOrigin(hostRef.current, base);
        assetProjectionRef.current?.setBase(base);
        return;
      }
      const draftId = snapshot.draftId;
      void fetchAttachBase(draftId).then((base) => {
        if (cancelled || lastBinding !== `draft:${draftId}`) return;
        assetBaseRef.current = base;
        stampClipboardOrigin(hostRef.current, base);
        assetProjectionRef.current?.setBase(base);
      });
    };
    resolve();
    const unsubscribe = store.subscribe(resolve);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [store]);
  // Doc-derived counts, recomputed only on document change; caret is
  // recomputed on every selection change from the live state.
  const docStatsRef = useRef<DocStats>({ lines: 1, words: 0, chars: 0 });
  useLayoutEffect(() => {
    onStatsRef.current = onStats;
  }, [onStats]);
  useLayoutEffect(() => {
    storeRef.current = store;
  }, [store]);
  useLayoutEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useLayoutEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);
  useLayoutEffect(() => {
    onFindRequestedRef.current = onFindRequested;
  }, [onFindRequested]);
  useLayoutEffect(() => {
    onFindSelectionRequestedRef.current = onFindSelectionRequested;
  }, [onFindSelectionRequested]);
  useLayoutEffect(() => {
    onFindNavigatedRef.current = onFindNavigated;
  }, [onFindNavigated]);

  // Engine-hook registration — the Text card is an engine-managed card
  // (`engineKind: "em"`), so the activation focus channel resolves through
  // `store.invokeEnginePaintMirrorAsActive`. Without this registration a
  // FRESH text card's activation claim resolves `deferred-engine` forever
  // (nothing ever registers), leaving `document.activeElement` — and every
  // content accelerator (⌘F, ⌘G, clipboard) — stranded on the previous
  // card. The active hook claims real DOM focus on the CM6 view; the
  // resulting `focusin` promotes this editor's responder ([P21] closes the
  // loop). The inactive hook is deliberately a no-op: the text card's
  // deactivated-selection paint is unchanged from its long-standing
  // behavior, and the focus channel only needs the active half.
  const engineCardId = useCardId();
  useLayoutEffect(() => {
    if (engineCardId === null) return;
    const store = getDeckStore();
    if (store === null) return;
    return store.registerEngineHooks(engineCardId, {
      paintMirrorAsActive: () => {
        // Idempotent grant (focus-language.md § One writer): WebKit
        // blurs an already-focused contenteditable to `<body>` on a
        // redundant re-`focus()`.
        const view = viewRef.current;
        if (view !== null && !view.hasFocus) view.focus();
      },
      paintMirrorAsInactive: () => {},
    });
  }, [engineCardId]);

  // ---- Bridge helpers ----

  const getPositions = useCallback((): FilePositions => {
    const live = viewRef.current;
    if (live === null) {
      return { anchor: { line: 1, ch: 0 }, scrollTop: 0 };
    }
    // Capture BOTH selection ends — the anchor (fixed) and the head
    // (caret). Collapsing to the head here would silently drop a real
    // selection, which [L23] forbids.
    const sel = live.state.selection.main;
    const toLineCh = (offset: number): { line: number; ch: number } => {
      const line = live.state.doc.lineAt(offset);
      return { line: line.number, ch: offset - line.from };
    };
    return {
      anchor: toLineCh(sel.anchor),
      head: toLineCh(sel.head),
      scrollTop: live.scrollDOM.scrollTop,
    };
  }, []);

  // Restore BOTH selection ends and the EXACT scroll offset, deferring the
  // scroll write into `requestMeasure` so it lands AFTER CM6 has measured
  // the current document. A synchronous `scrollTop =` runs before CM6 knows
  // the new line heights, so it re-measures, clamps, and the viewport jumps
  // (the [L23] regression). This is the core of the card-bag restore
  // (`applyPositions`) only — an in-place reload (`replaceText`) has nothing
  // to restore, because it never discards positions in the first place. The
  // view-identity guard drops the restore if the card re-anchors before the
  // measure fires.
  const restoreSelectionAndScroll = useCallback(
    (positions: FilePositions): void => {
      const live = viewRef.current;
      if (live === null) return;
      const anchor = offsetForLineCh(live.state, positions.anchor);
      // A missing `head` (an older bag) restores a collapsed caret at the
      // anchor — never flattens a real selection ([L23]).
      const head =
        positions.head === undefined
          ? anchor
          : offsetForLineCh(live.state, positions.head);
      const target = positions.scrollTop;
      live.dispatch({ selection: { anchor, head } });
      live.requestMeasure({
        read: () => null,
        write: (_measured, view) => {
          if (view !== viewRef.current) return;
          view.scrollDOM.scrollTop = target;
        },
      });
    },
    [],
  );

  const applyPositions = useCallback(
    (positions: FilePositions): void => {
      const live = viewRef.current;
      if (live === null) return;
      // A saved viewport restores selection + exact scroll, measure-first.
      if (positions.scrollTop > 0) {
        restoreSelectionAndScroll(positions);
        return;
      }
      // No saved viewport (a fresh open-at-line): center the target so a
      // deep-link into a long file lands with the line visible.
      const anchor = offsetForLineCh(live.state, positions.anchor);
      const head =
        positions.head === undefined
          ? anchor
          : offsetForLineCh(live.state, positions.head);
      live.dispatch({
        selection: { anchor, head },
        effects: EditorView.scrollIntoView(head, { y: "center" }),
      });
    },
    [restoreSelectionAndScroll],
  );

  // Publish caret + counts to the status bar. Caret is read live from
  // `state`; the line/word/char counts come from `docStatsRef` (kept
  // fresh by the update listener on document change).
  const publishStats = useCallback((state: EditorState): void => {
    const cb = onStatsRef.current;
    if (cb === undefined) return;
    const pos = state.selection.main.from;
    const line = state.doc.lineAt(pos);
    const doc = docStatsRef.current;
    cb({
      caretLine: line.number,
      caretCol: pos - line.from + 1,
      lines: doc.lines,
      words: doc.words,
      chars: doc.chars,
    });
  }, []);

  const replaceText = useCallback(
    (next: string): void => {
      const live = viewRef.current;
      if (live === null) return;
      // CM6 holds `\n`-only text; compare and diff in that currency, or a
      // CRLF file would read as changed on every line.
      const target = next.replace(/\r\n?/g, "\n");
      const changes = minimalTextChanges(live.state.doc.toString(), target);
      if (changes.length === 0) return;
      // An in-place disk reload — external out-of-process edit, Revert to
      // Saved, Reload from Disk, conflict "Reload" — is dispatched as the
      // MINIMAL change set, never a whole-document replace. A whole-document
      // replace tells CM6 every old position is gone, and then the caret,
      // the selection, and the viewport all have to be put back by hand from
      // line/ch and pixel guesses that are wrong the moment a line was added
      // above them — which is the jump. With only the changed lines
      // replaced, CM6 maps the selection through the change itself, keeps
      // the measured heights of every untouched line, and holds the line at
      // the viewport top where it was (its own scroll anchor, corrected in
      // the same measure pass, before paint). Folds, search matches, and the
      // undo history's positions survive the same way. There is nothing to
      // restore afterwards, so nothing races a click or a drag in progress.
      //
      // The reload is also kept OUT of the undo history: ⌘Z must never
      // resurrect the pre-reload text, because in automatic mode the buffer
      // that comes back is written straight to disk, silently overwriting
      // whatever the external editor just put there. Undo stays the user's
      // own typing, one step at a time, with the reloaded lines untouched.
      live.dispatch({
        changes,
        annotations: [externalReplace.of(true), Transaction.addToHistory.of(false)],
      });
    },
    [],
  );

  // ---- Mount the EditorView ----

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const snapshot = storeRef.current.getSnapshot();
    const s = settingsRef.current;
    applyWhitespaceAttrs(host, s);
    applyTypographyVars(host, s);
    const state = EditorState.create({
      doc: snapshot.seedContent ?? "",
      extensions: [
        history(),
        readOnlyCompartment.of(EditorState.readOnly.of(readOnlyRef.current)),
        lineWrapCompartment.of(lineWrapFor(s)),
        lineNumbersCompartment.of(s.lineNumbers ? lineNumbersGutter : []),
        foldGutterCompartment.of(s.foldGutter ? cmFoldGutter() : []),
        tabConfigCompartment.of(tabConfigFor(s)),
        whitespaceCompartment.of(whitespaceFor(s)),
        activeLineCompartment.of(activeLineFor(s)),
        languageCompartment.of([]),
        // A primary press inside a ranged selection collapses it now rather
        // than on release — otherwise the whole range stays painted for as
        // long as the button is held. See `press-collapses-selection.ts`.
        pressCollapsesSelection,
        // Keeps the viewport-top LINE across a card width change, and
        // publishes it for the cross-mount save path. A pixel offset means
        // nothing after a re-wrap; a line does.
        cm6ScrollAnchor(),
        revealFlashField,
        // ⌘-click intra-document link/anchor navigation (plain click still
        // edits). Jumps via the live `revealLine` through a ref so the
        // mount-time closure never goes stale.
        anchorLinkExtension({
          navigate: (line) => anchorNavigateRef.current(line),
          // A relative destination resolves against the document's own
          // directory. The resolved path is handed straight to the same
          // guarded open path everything else uses — nothing assembled here
          // is persisted or compared ([L29]).
          // Every link that resolves lights up. What the click DOES is decided
          // from the file's own bytes at click time (`openAttachmentPath`) —
          // viewer card, Text card, or the Finder for something with no in-app
          // answer. This used to be gated on `isViewableFile`, which left a
          // `.md` attachment sitting dead beside a `.png` that opened; and the
          // gate could not be widened here anyway, because the name does not
          // say whether a file is text (`classifyFileKind` returns `"text"` as
          // its *default*, so a `.zip` and a `.md` look identical to it).
          //
          // Resolved against the document's asset base rather than its path,
          // so a link in a not-yet-saved buffer opens like any other — an
          // untitled manual buffer has `path === null`, which used to make
          // ⌘-click dead there. `resolveRelativePath`, not `resolveAssetPath`:
          // ⌘-click follows *any* in-tree relative link, and narrowing it to
          // `assets/` would silently kill a hand-written `images/diagram.png`.
          canOpenRelative: (destination) =>
            resolveRelativePath(assetBaseRef.current, destination) !== null,
          openRelative: (destination) => {
            const resolved = resolveRelativePath(
              assetBaseRef.current,
              destination,
            );
            if (resolved !== null) openRelativeRef.current(resolved);
          },
        }),
        // File drops write into a sibling `assets/` folder and insert a
        // standard markdown link. Everything is read through getters at
        // drop time — the store's path changes with Save As, and the error
        // sink is a prop ([L07]).
        fileDropExtension({
          host,
          getAssetBase: () => assetBaseDescriptor(),
          onError: (name, message) => reportAttachmentFailure(name, message),
        }),
        // ⌘V with image data. The native clipboard bridge's read result
        // carries no image bytes at all, so the DOM `paste` event is the only
        // channel a screenshot can arrive through — which is why this is a CM6
        // dom handler rather than a responder action.
        EditorView.domEventHandlers({
          // ⌘C / ⌘X are `routing: "native"` commands, so AppKit performs the
          // copy against the WKWebView and what actually runs is this DOM
          // event — not the responder action. The sidecar has to be written
          // here or a keyboard copy carries plain text only, and the
          // attachment does not survive the hop.
          copy: (event, view) => writeSelectionSidecar(view, event, false),
          cut: (event, view) => writeSelectionSidecar(view, event, true),
          paste: (event, view) => {
            const files = extractImageFiles(event.clipboardData?.items ?? null);
            if (files === null || files.length === 0) {
              // No image data. The clipboard may still carry a Tug sidecar —
              // an attachment copied from the prompt entry or another document
              // — but this event cannot see the private pasteboard type, so
              // the shared routine asks the host. It reports whether it
              // handled the paste; if not, CM6's default text paste runs.
              if (!hasNativeClipboardBridge()) return false;
              event.preventDefault();
              void (async () => {
                if (await pasteAttachmentsRef.current()) return;
                const { text } = await readClipboardViaNative();
                if (text.length > 0 && view.dom.isConnected) {
                  insertPastedText(view, text);
                }
              })();
              return true;
            }
            const base = assetBaseDescriptor();
            if (base === null) return false;
            event.preventDefault();
            const at = view.state.selection.main.from;
            void (async () => {
              // No names: pasted image data has none, so the server mints a
              // timestamped one where the write happens ([P11]).
              const links = await linksForFiles(
                base,
                files,
                reportAttachmentFailure,
                false,
              );
              if (!view.dom.isConnected || links.length === 0) return;
              const pos = Math.min(at, view.state.doc.length);
              const insert = links.join(" ");
              // One transaction, so one undo removes the whole paste.
              view.dispatch({
                changes: { from: pos, insert },
                selection: { anchor: pos + insert.length },
                userEvent: "input.paste",
              });
            })();
            return true;
          },
        }),
        // Removing an attachment moves its file to the Trash, and the undo
        // brings both halves back — coupled through the history itself rather
        // than through bookkeeping beside it.
        assetTrashInvertedEffects,
        assetTrashEffectHandler((name, message) =>
          reportAttachmentFailure(name, message),
        ),
        search({ top: true }),
        // Every user edit arms the autosave debounce. Store-driven
        // replacements (external-change reverts) carry the
        // `externalReplace` annotation and must NOT re-arm it.
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const doc = update.state.doc;
            // Lines/chars are O(1) off CM6's rope; the word count is
            // maintained incrementally in O(change size) from the
            // changeset — never a full re-scan (see `word-count.ts`).
            docStatsRef.current = {
              lines: doc.lines,
              chars: doc.length,
              words:
                docStatsRef.current.words +
                wordCountDelta(update.changes, update.startState.doc, doc),
            };
            const isExternal = update.transactions.some(
              (t) => t.annotation(externalReplace) === true,
            );
            // Store-driven reverts must NOT re-arm autosave; the stats
            // above still refresh for them.
            if (!isExternal) storeRef.current.noteEdit();
            // The attachment strip is a projection of this text ([P01]). The
            // call is a string compare and an idle-timer reset; the parse
            // itself never runs on the edit path.
            assetProjectionRef.current?.noteChanged();
          }
          if (update.docChanged || update.selectionSet) {
            publishStats(update.state);
          }
        }),
        // Editing keymaps. The responder chain owns the Cmd-chords
        // (capture-phase preventDefault before CM6 sees them); these
        // cover everything else — cursor motion, Home/End, indent,
        // and history chords in browser contexts without the chain.
        keymap.of([...defaultKeymap, ...historyKeymap, tugTabKeyBinding]),
        undoMenuStatePlugin,
        tugTextCardEditorTheme,
      ],
    });

    const cmView = new EditorView({ state, parent: host });
    viewRef.current = cmView;
    setView(cmView);
    storeRef.current.attachEditor({
      getText: () => cmView.state.doc.toString(),
      replaceText,
      getPositions,
      applyPositions,
    });

    // The strip derives from this buffer. Handing over a getter rather than a
    // string is what keeps the rope out of the edit path — the projection
    // reads it once per idle window, in the parse that needed it anyway.
    assetProjectionRef.current?.setTextSource(() => cmView.state.doc.toString());

    // Seed the status bar with the mounted document's stats.
    docStatsRef.current = {
      lines: cmView.state.doc.lines,
      chars: cmView.state.doc.length,
      words: countWords(cmView.state.doc.toString()),
    };
    publishStats(cmView.state);

    return () => {
      // Flush BEFORE detaching: child cleanups run before the parent
      // card's, so this is the last moment the store can read the
      // buffer — without it, the final debounce window of edits would
      // be lost on unmount. `flush` snapshots the text synchronously;
      // keepalive carries the write through teardown.
      void storeRef.current.flush({ keepalive: true });
      storeRef.current.detachEditor();
      cmView.destroy();
      viewRef.current = null;
      setView(null);
    };
    // Empty deps — mount once per StrictMode pass; reconfigures below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Compartment reconfigures ----

  useLayoutEffect(() => {
    viewRef.current?.dispatch({
      effects: lineWrapCompartment.reconfigure(lineWrapFor(settings)),
    });
  }, [settings.lineWrap]);

  useLayoutEffect(() => {
    viewRef.current?.dispatch({
      effects: lineNumbersCompartment.reconfigure(
        settings.lineNumbers ? lineNumbersGutter : [],
      ),
    });
  }, [settings.lineNumbers]);

  useLayoutEffect(() => {
    viewRef.current?.dispatch({
      effects: foldGutterCompartment.reconfigure(
        settings.foldGutter ? cmFoldGutter() : [],
      ),
    });
  }, [settings.foldGutter]);

  useLayoutEffect(() => {
    viewRef.current?.dispatch({
      effects: tabConfigCompartment.reconfigure(tabConfigFor(settings)),
    });
  }, [settings.softTabs, settings.tabSize]);

  // Typography rides CSS variables on the host, so the text re-flows on its
  // own. CM6 does not observe variable changes, though: its `heightOracle`
  // caches the measured font metrics and the line-number gutter's per-row
  // heights live in a `RangeSet` rebuilt only on a reconfigure or a non-empty
  // transaction. Swapping the gutter compartment with its CURRENT value is
  // still a structural reconfigure, which runs the full update cycle; the
  // paired `requestMeasure` refreshes what the reconfigure doesn't. Same
  // hammer the prompt substrate uses for the same reason.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host !== null) applyTypographyVars(host, settings);
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({
      effects: lineNumbersCompartment.reconfigure(
        settings.lineNumbers ? lineNumbersGutter : [],
      ),
    });
    view.requestMeasure();
    // `settings.lineNumbers` is deliberately not a dep — its own effect above
    // owns the toggle; this pass only re-runs when the typography moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.fontId, settings.fontSize]);

  useLayoutEffect(() => {
    viewRef.current?.dispatch({
      effects: activeLineCompartment.reconfigure(activeLineFor(settings)),
    });
  }, [settings.highlightActiveLine]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host !== null) applyWhitespaceAttrs(host, settings);
    viewRef.current?.dispatch({
      effects: whitespaceCompartment.reconfigure(whitespaceFor(settings)),
    });
  }, [settings.showSpaces, settings.showTabs]);

  useLayoutEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.reconfigure(
        EditorState.readOnly.of(readOnly),
      ),
    });
  }, [readOnly]);

  // ---- Language / syntax highlighting ----
  //
  // Resolved asynchronously (the grammar chunk lazy-loads); the
  // compartment swap lands whenever the import settles. The stale-path
  // guard drops a late-resolving grammar after the card re-anchored to
  // a different file.
  useLayoutEffect(() => {
    const ext = languageExt ?? null;
    if (ext === null) {
      viewRef.current?.dispatch({
        effects: languageCompartment.reconfigure([]),
      });
      return;
    }
    let alive = true;
    void languageForExtension(ext).then((language) => {
      if (!alive) return;
      const live = viewRef.current;
      if (live === null) return;
      live.dispatch({
        effects: languageCompartment.reconfigure(
          language !== null ? [language, tugEditingHighlightStyle] : [],
        ),
      });
    });
    return () => {
      alive = false;
    };
  }, [languageExt]);

  // ---- Search (host-owned Find UI, delegate-driven) ----

  const setSearchQueryFn = useCallback((spec: TugTextCardEditorSearchQuery) => {
    const live = viewRef.current;
    if (live === null) return;
    // Mounting the (hidden) bundled panel initializes the search
    // state's `panel` field, which the match highlighter requires
    // before painting decorations — same mechanism as `TugCodeView`.
    if (!searchPanelOpen(live.state)) {
      openSearchPanel(live);
    }
    live.dispatch({
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

  // Find landing-flash ring + horizontal settle. After every find
  // navigation (typed landing, next, previous):
  //  - if the selected match is fully visible with the scroller panned all
  //    the way LEFT, snap `scrollLeft` to 0 — zero horizontal scroll is
  //    favored over the minimal pan CM6's scrollIntoView leaves behind;
  //  - draw the one-shot accent ring over the match (the Session card's
  //    landing flash), absolutely positioned in the scroller's content
  //    coordinates so it scrolls with the text and clips at the editor.
  const findFlashRef = useRef<FindFlashHandle | null>(null);
  const removeFindFlash = useCallback((): void => {
    findFlashRef.current?.remove();
    findFlashRef.current = null;
  }, []);
  useLayoutEffect(() => removeFindFlash, [removeFindFlash]);

  const settleFindNavigation = useCallback((): void => {
    const live = viewRef.current;
    if (live === null) return;
    const sel = live.state.selection.main;
    if (sel.empty) return;
    live.requestMeasure({
      read: (view) => {
        const scroller = view.scrollDOM;
        const start = view.coordsAtPos(sel.from, 1);
        const end = view.coordsAtPos(sel.to, -1);
        if (start === null || end === null) return null;
        const rect = scroller.getBoundingClientRect();
        const contentLeft = start.left - rect.left + scroller.scrollLeft;
        const contentRight = end.right - rect.left + scroller.scrollLeft;
        const contentTop = start.top - rect.top + scroller.scrollTop;
        return {
          scroller,
          contentLeft,
          contentTop,
          width: Math.max(contentRight - contentLeft, 8),
          height: Math.max(start.bottom - start.top, 12),
          snapZero:
            scroller.scrollLeft > 0 &&
            contentRight <= scroller.clientWidth - 8,
        };
      },
      write: (m) => {
        if (m === null) return;
        if (m.snapZero) m.scroller.scrollLeft = 0;
        removeFindFlash();
        // Shared placement helper takes VIEWPORT coordinates; convert the
        // measured content-space rect back through the live scroller box.
        const box = m.scroller.getBoundingClientRect();
        findFlashRef.current = placeFindFlash(m.scroller, {
          left: m.contentLeft + box.left + m.scroller.clientLeft - m.scroller.scrollLeft,
          top: m.contentTop + box.top + m.scroller.clientTop - m.scroller.scrollTop,
          width: m.width,
          height: m.height,
        });
      },
    });
  }, [removeFindFlash]);

  /**
   * Where the reader is, for the landing rule below. `null` until find
   * opens — and a landing with no anchor is the document's first match,
   * which is what a search over a file nobody has scrolled means anyway.
   */
  const findAnchorRef = useRef<number | null>(null);

  const captureFindAnchorFn = useCallback(
    (source: "viewport" | "selection"): void => {
      const live = viewRef.current;
      if (live === null) return;
      if (source === "selection") {
        findAnchorRef.current = live.state.selection.main.from;
        return;
      }
      // The top of the scrollport, snapped to a line boundary: the first
      // line the reader can see is the first line a search should consider.
      findAnchorRef.current = live.lineBlockAtHeight(
        live.scrollDOM.scrollTop,
      ).from;
    },
    [],
  );

  const selectMatchFromAnchorFn = useCallback((): void => {
    const live = viewRef.current;
    if (live === null) return;
    const query = getSearchQuery(live.state);
    if (!query.valid) return;
    const anchor = findAnchorRef.current;
    // The cursor starts AT the anchor, never at `anchor + 1`: a selection's
    // own `from` is the anchor, so ⌘E must be able to land on the text the
    // user selected rather than skip past it to the next occurrence.
    let hit =
      anchor === null
        ? query.getCursor(live.state).next()
        : query.getCursor(live.state, anchor).next();
    if (hit.done) hit = query.getCursor(live.state).next();
    if (hit.done) return;
    const { from, to } = hit.value;
    // Already on screen? Then select it and leave the page alone. Scrolling
    // a visible match to the vertical centre is motion the user did not ask
    // for and cannot distinguish from the view losing its place.
    const box = live.scrollDOM.getBoundingClientRect();
    const start = live.coordsAtPos(from, 1);
    const end = live.coordsAtPos(to, -1);
    const visible =
      start !== null &&
      end !== null &&
      start.top >= box.top &&
      end.bottom <= box.bottom &&
      start.left >= box.left &&
      end.right <= box.right;
    live.dispatch({
      selection: EditorSelection.single(from, to),
      ...(visible
        ? {}
        : {
            effects: EditorView.scrollIntoView(
              EditorSelection.range(from, to),
              // `x: "nearest"` pans a long unwrapped line to the match; the
              // vertical centre matches the findNext/findPrevious landing.
              { y: "center", x: "nearest" },
            ),
          }),
      userEvent: "select.search",
    });
    settleFindNavigation();
  }, [settleFindNavigation]);

  const clearSearchFn = useCallback(() => {
    const live = viewRef.current;
    if (live === null) return;
    live.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search: "" })),
    });
    if (searchPanelOpen(live.state)) {
      closeSearchPanel(live);
    }
  }, []);

  const getMatchCountFn = useCallback((): number => {
    const live = viewRef.current;
    if (live === null) return 0;
    const query = getSearchQuery(live.state);
    if (!query.valid) return 0;
    const cursor = query.getCursor(live.state);
    let count = 0;
    let next = cursor.next();
    while (!next.done) {
      count += 1;
      next = cursor.next();
    }
    return count;
  }, []);

  const getMatchInfoFn = useCallback((): {
    count: number;
    activeOrdinal: number | null;
    capped: boolean;
  } => {
    const live = viewRef.current;
    if (live === null) return { count: 0, activeOrdinal: null, capped: false };
    const query = getSearchQuery(live.state);
    if (!query.valid) return { count: 0, activeOrdinal: null, capped: false };
    const sel = live.state.selection.main;
    const cursor = query.getCursor(live.state);
    let count = 0;
    let activeOrdinal: number | null = null;
    let capped = false;
    let next = cursor.next();
    while (!next.done) {
      if (next.value.from === sel.from && next.value.to === sel.to) {
        activeOrdinal = count;
      }
      count += 1;
      if (count >= MATCH_INFO_CAP) {
        // The cap probe CONSUMES match number `count`, so it is the first
        // candidate of the continuation below rather than something to skip
        // — resuming with a fresh `cursor.next()` would make every past-cap
        // ordinal one too low.
        const probe = cursor.next();
        capped = !probe.done;
        // `count` and `capped` keep their meaning (the chip still reads
        // `5000+`); only the ORDINAL is uncapped, because a chip that can
        // count to 5000 and not say which one you are on is no answer. The
        // walk is bounded by the selection, not the document: it stops at
        // the first match at or past it.
        if (activeOrdinal === null && !sel.empty) {
          let ordinal = count;
          let candidate = probe;
          while (!candidate.done) {
            if (
              candidate.value.from === sel.from &&
              candidate.value.to === sel.to
            ) {
              activeOrdinal = ordinal;
              break;
            }
            if (candidate.value.from >= sel.from) break;
            ordinal += 1;
            candidate = cursor.next();
          }
        }
        break;
      }
      next = cursor.next();
    }
    return { count, activeOrdinal, capped };
  }, []);

  const revealLineFn = useCallback(
    (startLine: number, endLine?: number, columns?: readonly [number, number]): void => {
      const live = viewRef.current;
      if (live === null) return;
      const doc = live.state.doc;
      const sLine = Math.max(1, Math.min(startLine, doc.lines));
      const eLine =
        endLine === undefined
          ? sLine
          : Math.max(sLine, Math.min(endLine, doc.lines));
      const line = doc.line(sLine);
      // A column range is the only place a reference is narrower than a line:
      // a search ref knows exactly which characters matched. The wire's
      // offsets are 0-based and half-open WITHIN the line, so this is the one
      // boundary that converts them to document positions ([P14]) — clamped,
      // because the file on disk may have moved on since the run.
      if (columns !== undefined && columns[1] > columns[0]) {
        const from = Math.min(line.from + Math.max(0, columns[0]), line.to);
        const to = Math.min(line.from + columns[1], line.to);
        if (to > from) {
          live.dispatch({
            selection: { anchor: from },
            effects: [
              EditorView.scrollIntoView(from, { y: "center" }),
              setRevealFlash.of({ from, to }),
            ],
          });
          live.focus();
          window.setTimeout(() => {
            viewRef.current?.dispatch({ effects: setRevealFlash.of(null) });
          }, REVEAL_FLASH_MS);
          return;
        }
      }
      const from = line.from;
      const flashTo = doc.line(eLine).from;
      // Place a PLAIN caret at the first changed line — no persistent
      // selection. The momentary accent flash draws the eye; once it
      // fades, the Active-line highlight (if enabled) settles on the
      // caret's line. Flash spans the changed line(s) start..end.
      live.dispatch({
        selection: { anchor: from },
        effects: [
          EditorView.scrollIntoView(from, { y: "center" }),
          setRevealFlash.of({ from, to: flashTo }),
        ],
      });
      live.focus();
      // Clear the flash after its animation window so it neither lingers
      // nor re-fires on later edits. Guarded against a destroyed view.
      window.setTimeout(() => {
        viewRef.current?.dispatch({ effects: setRevealFlash.of(null) });
      }, REVEAL_FLASH_MS);
    },
    [],
  );
  anchorNavigateRef.current = revealLineFn;

  const revealOffsetsFn = useCallback((from: number, to: number): void => {
    const live = viewRef.current;
    if (live === null) return;
    const length = live.state.doc.length;
    const start = Math.max(0, Math.min(from, length));
    const end = Math.max(start, Math.min(to, length));
    live.dispatch({
      selection: { anchor: start },
      effects: [
        EditorView.scrollIntoView(start, { y: "center" }),
        setRevealFlash.of({ from: start, to: end }),
      ],
    });
    live.focus();
    window.setTimeout(() => {
      viewRef.current?.dispatch({ effects: setRevealFlash.of(null) });
    }, REVEAL_FLASH_MS);
  }, []);

  useImperativeHandle(
    ref,
    (): TugTextCardEditorDelegate => ({
      view: () => viewRef.current,
      focus: () => viewRef.current?.focus(),
      responderId: () => responderId,
      revealLine: revealLineFn,
      revealOffsets: revealOffsetsFn,
      setSearchQuery: setSearchQueryFn,
      captureFindAnchor: captureFindAnchorFn,
      selectMatchFromAnchor: selectMatchFromAnchorFn,
      clearSearch: clearSearchFn,
      findNext: () => {
        const live = viewRef.current;
        if (live !== null) cmFindNext(live);
        // Stepping IS the reader moving: the next query edit starts from
        // the match they stepped to, not from where find opened.
        findAnchorRef.current =
          viewRef.current?.state.selection.main.from ?? null;
        settleFindNavigation();
      },
      findPrevious: () => {
        const live = viewRef.current;
        if (live !== null) cmFindPrevious(live);
        findAnchorRef.current =
          viewRef.current?.state.selection.main.from ?? null;
        settleFindNavigation();
      },
      getMatchCount: getMatchCountFn,
      getMatchInfo: getMatchInfoFn,
    }),
    [
      revealLineFn,
      revealOffsetsFn,
      setSearchQueryFn,
      captureFindAnchorFn,
      selectMatchFromAnchorFn,
      clearSearchFn,
      getMatchCountFn,
      getMatchInfoFn,
      settleFindNavigation,
      responderId,
    ],
  );

  // ---- Context menu ----

  const cmAdapterRef = useRef<TextSelectionAdapter | null>(null);
  useLayoutEffect(() => {
    cmAdapterRef.current =
      view !== null ? createCMSelectionAdapter(view) : null;
  }, [view]);

  const {
    onMouseDown: onContextMenuMouseDown,
    onContextMenu: onContextMenuOpen,
    menu: contextMenu,
  } = useTextSurfaceContextMenu({
    adapterRef: cmAdapterRef,
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const handleContextMenu = (e: MouseEvent) => {
      const live = viewRef.current;
      if (live === null) return;
      if (!live.dom.contains(e.target as Node)) return;
      onContextMenuOpen(e);
    };
    const handleMouseDown = (e: MouseEvent) => {
      const live = viewRef.current;
      if (live === null) return;
      if (!live.dom.contains(e.target as Node)) return;
      onContextMenuMouseDown(e);
    };
    host.addEventListener("contextmenu", handleContextMenu);
    host.addEventListener("mousedown", handleMouseDown);
    return () => {
      host.removeEventListener("contextmenu", handleContextMenu);
      host.removeEventListener("mousedown", handleMouseDown);
    };
  }, [onContextMenuOpen, onContextMenuMouseDown]);

  // ---- Responder-chain action handlers ----
  //
  // The chain's capture-phase keydown pipeline maps Cmd-A/C/X/V/Z/⇧Z/S
  // to actions and calls `preventDefault` before dispatch, so the
  // editor MUST register handlers — the suppressed default leaves the
  // keystrokes inert otherwise. Plain-text clipboard only: files carry
  // no atom sidecar, so the write path is text-only and the read path
  // inserts the clipboard's text verbatim.

  const handleSelectAll = useCallback((): ActionHandlerResult => {
    return () => {
      const live = viewRef.current;
      if (live === null) return;
      live.focus();
      cmSelectAll(live);
    };
  }, []);

  const handleUndo = useCallback((): ActionHandlerResult => {
    return () => {
      const live = viewRef.current;
      if (live === null) return;
      live.focus();
      undo(live);
    };
  }, []);

  const handleRedo = useCallback((): ActionHandlerResult => {
    return () => {
      const live = viewRef.current;
      if (live === null) return;
      live.focus();
      redo(live);
    };
  }, []);

  /** Write the current selection as plain text; true when handled. */
  const writeSelectionToClipboard = useCallback((): boolean => {
    const live = viewRef.current;
    if (live === null) return false;
    const { from, to } = live.state.selection.main;
    if (from === to) return true; // nothing selected — handled no-op
    const text = live.state.sliceDoc(from, to);
    if (hasNativeClipboardBridge()) {
      // The plain-text flavor is always the literal markdown, so an external
      // app pastes exactly what the document says. The sidecar rides beside
      // it, carrying the absolute path of every attachment in the selection —
      // a relative link means nothing in a surface with a different base.
      const sidecar = withClipboardOrigins(
        buildAssetSidecar(text, assetBaseRef.current),
        text,
        clipboardOriginFor(live.dom),
      );
      return writeClipboardViaNative(
        text,
        sidecar === null ? "" : JSON.stringify(sidecar),
      );
    }
    void navigator.clipboard?.writeText(text);
    return true;
  }, []);

  const handleCopy = useCallback((): ActionHandlerResult => {
    const live = viewRef.current;
    if (live === null) return;
    live.focus();
    if (!writeSelectionToClipboard()) {
      document.execCommand("copy");
    }
  }, [writeSelectionToClipboard]);

  const handleCut = useCallback((): ActionHandlerResult => {
    const live = viewRef.current;
    if (live === null || readOnlyRef.current) return;
    live.focus();
    if (!writeSelectionToClipboard()) {
      document.execCommand("copy");
    }
    return () => {
      const inner = viewRef.current;
      if (inner === null) return;
      const { from, to } = inner.state.selection.main;
      if (from === to) return;
      inner.dispatch({
        changes: { from, to, insert: "" },
        selection: { anchor: from },
        userEvent: "delete.cut",
      });
    };
  }, [writeSelectionToClipboard]);

  /** Remove the selection without touching the clipboard — cut's
   *  continuation without the copy. No-ops on a collapsed selection;
   *  `validateAction` dims the menu item in that state. */
  const handleDelete = useCallback((): ActionHandlerResult => {
    const live = viewRef.current;
    if (live === null || readOnlyRef.current) return;
    live.focus();
    return () => {
      const inner = viewRef.current;
      if (inner === null) return;
      const { from, to } = inner.state.selection.main;
      if (from === to) return;
      inner.dispatch({
        changes: { from, to, insert: "" },
        selection: { anchor: from },
        userEvent: "delete.selection",
      });
    };
  }, []);

  /**
   * The attachment half of a paste, shared by **both** entry points a ⌘V on
   * this card actually has: the responder route below, and the CM6 DOM
   * handler. Two implementations of one gesture is how the surfaces drifted
   * apart the first time.
   *
   * Resolves `true` when it handled the paste — an attachment landed and the
   * markdown was inserted — and `false` when the clipboard carried no
   * attachments, in which case the caller does its ordinary text paste.
   *
   * The sidecar always comes from the native bridge. The DOM `paste` event
   * cannot see the Tug-private `dev.tugapp.prompt-atoms` pasteboard type in its
   * `clipboardData` at all, so asking the host is the only way either route
   * can find it — the same reason `clipboard-filters.ts` asks in its own
   * DOM-mode fallback.
   */
  const pasteAttachments = useCallback(async (): Promise<boolean> => {
    if (!hasNativeClipboardBridge()) return false;
    const base = assetBaseDescriptor();
    if (base === null) return false;
    const { atoms } = await readClipboardViaNative();
    if (atoms.length === 0) return false;
    const payload = parseClipboardSidecar(atoms);
    if (payload === null) return false;
    const markdown = await assetMarkdownForPaste(
      payload,
      base,
      assetBaseRef.current,
    );
    if (markdown === null) return false;
    const live = viewRef.current;
    if (live === null || !live.dom.isConnected) return false;
    insertPastedText(live, markdown);
    return true;
  }, [assetBaseDescriptor]);
  pasteAttachmentsRef.current = pasteAttachments;

  /** Insert clipboard text at the selection, via a transform. */
  const pasteWithTransform = useCallback(
    (transform: PasteTransform): ActionHandlerResult => {
      const live = viewRef.current;
      if (live === null || readOnlyRef.current) return;
      live.focus();
      const insert = (raw: string) => {
        const inner = viewRef.current;
        if (inner === null) return;
        const text = transform(raw);
        if (text === "") return;
        const { from, to } = inner.state.selection.main;
        inner.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
          userEvent: "input.paste",
          scrollIntoView: true,
        });
      };
      if (hasNativeClipboardBridge()) {
        const readPromise = readClipboardViaNative();
        return () => {
          void (async () => {
            // Attachments first: a clipboard carrying an image from the prompt
            // entry should become a file and a link here, not the label text
            // the plain-text flavor holds. A transforming paste (Paste as
            // Quote / as Plain Text) is asking for text, so it skips this.
            if (transform === IDENTITY_TRANSFORM && (await pasteAttachments())) {
              return;
            }
            const { text } = await readPromise;
            insert(text);
          })();
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
    [pasteAttachments],
  );

  const handlePaste = useCallback(
    (): ActionHandlerResult => pasteWithTransform(IDENTITY_TRANSFORM),
    [pasteWithTransform],
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
  // reverts the whole run rather than a character at a time, and restore the
  // selection over the replacement so a second press acts on the same text.
  // A collapsed selection is a no-op — the verb acts on a selection, the way
  // Delete does.
  const transformSelectionCase = useCallback(
    (transform: (text: string) => string): ActionHandlerResult => {
      const live = viewRef.current;
      if (live === null || readOnlyRef.current) return;
      live.focus();
      return () => {
        const inner = viewRef.current;
        if (inner === null || readOnlyRef.current) return;
        const { from, to } = inner.state.selection.main;
        if (from === to) return;
        const text = transform(inner.state.sliceDoc(from, to));
        inner.dispatch({
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

  // SAVE — automatic mode: flush pending edits now (⌘S forces the debounce
  // to fire). Manual mode: route to the card's save() + needs-path panel
  // flow, since ⌘S must write the REAL file, not the aside.
  //
  // The work runs INLINE (not as a returned continuation): the `save`
  // control action dispatches via `sendToFirstResponder`, which DISCARDS
  // the continuation — a returned `() => …` would silently never run, so
  // File ▸ Save would do nothing.
  const handleSave = useCallback((): ActionHandlerResult => {
    if (storeRef.current.getSnapshot().saveMode === "manual") {
      onSaveCommandRef.current?.("save");
    } else {
      void storeRef.current.saveNow();
    }
  }, []);

  const handleSaveAs = useCallback((): ActionHandlerResult => {
    onSaveCommandRef.current?.("save-as");
  }, []);
  const handleSaveACopy = useCallback((): ActionHandlerResult => {
    onSaveCommandRef.current?.("save-a-copy");
  }, []);
  const handleRevertToSaved = useCallback((): ActionHandlerResult => {
    onSaveCommandRef.current?.("revert-to-saved");
  }, []);
  const handleReloadFromDisk = useCallback((): ActionHandlerResult => {
    onSaveCommandRef.current?.("reload-from-disk");
  }, []);

  const handleFind = useCallback((): ActionHandlerResult => {
    onFindRequestedRef.current?.();
  }, []);

  /** The document text under a ranged selection, trimmed; empty on a bare
   *  caret — ⌘E's query, and a no-op when there is none. Deliberately NOT a
   *  `validateAction` branch: a gate is computed when the menuState is
   *  pushed, and selecting text pushes nothing, so a selection-granular
   *  answer would leave the item reading disabled with the text right there
   *  and AppKit eating ⌘E at the menu bar. Focus granularity — the editor
   *  handles the action, so the item is live — is the same answer Delete
   *  gives, for the same reason. Read-only makes no difference: finding is
   *  reading. */
  const selectedQuery = useCallback((): string => {
    const live = viewRef.current;
    if (live === null) return "";
    const { from, to } = live.state.selection.main;
    return from === to ? "" : live.state.sliceDoc(from, to).trim();
  }, []);

  const handleFindSelection = useCallback((): ActionHandlerResult => {
    const query = selectedQuery();
    if (query === "") return;
    onFindSelectionRequestedRef.current?.(query);
  }, [selectedQuery]);

  const handleFindNext = useCallback((): ActionHandlerResult => {
    const live = viewRef.current;
    if (live !== null) cmFindNext(live);
    onFindNavigatedRef.current?.();
  }, []);

  const handleFindPrevious = useCallback((): ActionHandlerResult => {
    const live = viewRef.current;
    if (live !== null) cmFindPrevious(live);
    onFindNavigatedRef.current?.();
  }, []);

  const actions: Partial<Record<TugAction, ActionHandler>> = {
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
    [TUG_ACTIONS.SAVE]: handleSave,
    [TUG_ACTIONS.SAVE_AS]: handleSaveAs,
    [TUG_ACTIONS.SAVE_A_COPY]: handleSaveACopy,
    [TUG_ACTIONS.REVERT_TO_SAVED]: handleRevertToSaved,
    [TUG_ACTIONS.RELOAD_FROM_DISK]: handleReloadFromDisk,
    [TUG_ACTIONS.FIND]: handleFind,
    [TUG_ACTIONS.FIND_SELECTION]: handleFindSelection,
    [TUG_ACTIONS.FIND_NEXT]: handleFindNext,
    [TUG_ACTIONS.FIND_PREVIOUS]: handleFindPrevious,
  };

  const { responderRef, ResponderScope } = useOptionalResponder({
    id: responderId,
    actions,
    validateAction: (action) => {
      if (action === TUG_ACTIONS.UNDO) {
        const live = viewRef.current;
        return live !== null && undoDepth(live.state) > 0;
      }
      if (action === TUG_ACTIONS.REDO) {
        const live = viewRef.current;
        return live !== null && redoDepth(live.state) > 0;
      }
      if (
        action === TUG_ACTIONS.CUT ||
        action === TUG_ACTIONS.DELETE ||
        action === TUG_ACTIONS.PASTE ||
        action === TUG_ACTIONS.PASTE_AS_QUOTE ||
        action === TUG_ACTIONS.PASTE_AS_PLAIN_TEXT ||
        action === TUG_ACTIONS.MAKE_UPPERCASE ||
        action === TUG_ACTIONS.MAKE_LOWERCASE ||
        action === TUG_ACTIONS.SAVE
      ) {
        return !readOnlyRef.current;
      }
      return true;
    },
    focus: () => viewRef.current?.focus(),
  });

  // Focus-engine stop ([P02]), opt-in via `focusGroup` — the same wiring the
  // prompt entry's editor uses. Registered under the SAME id as the responder
  // above, so the engine resolves this editor's focus CONTRACT
  // (`view.focus()`) instead of walking the host for a tabbable child, and
  // `classifyRoute` reads that contract to route the keyboard `dom-granted`
  // when the stop takes a caret. The focusable element is the host wrapper, so
  // the ring paints on the editor's own box.
  const { focusableRef } = useFocusable({
    id: responderId,
    group: focusGroup ?? "",
    order: focusOrder,
    register: focusGroup !== undefined,
  });

  const composedHostRef = useCallback(
    (el: HTMLDivElement | null) => {
      hostRef.current = el;
      responderRef(el);
      focusableRef(el);
    },
    [responderRef, focusableRef],
  );

  return (
    <ResponderScope>
      <div
        ref={composedHostRef}
        data-slot="tug-text-card-editor"
        data-tug-select="custom"
        data-focus-stop={focusGroup !== undefined ? "true" : undefined}
        className={cn("tug-text-card-editor", className)}
      />
      {contextMenu}
    </ResponderScope>
  );
});

/**
 * tug-text-types — shared type surface for the tug-text-editor substrate.
 *
 * Lives in `@/lib/` rather than under the substrate directory because
 * non-substrate consumers (gallery cards, completion providers, the
 * session-card) reference these types without taking a hard dependency
 * on CodeMirror or any view code.
 *
 * Only types live here — no runtime helpers and no React. Everything
 * is JSON-serializable where it needs to be (notably {@link
 * TugTextEditingState}, used by the [L23] state-preservation pipeline).
 */

import type { AtomSegment } from "./tug-atom-img";

export type { AtomSegment };

// ---------------------------------------------------------------------------
// InputAction
// ---------------------------------------------------------------------------

/**
 * Resolved action for the main-row Enter (and numpad Enter) key.
 *
 *   `"submit"`  — fire the editor's `onSubmit` callback. Shift-Enter
 *                 inserts a newline.
 *   `"newline"` — insert a newline. Shift-Enter fires `onSubmit`.
 */
export type InputAction = "submit" | "newline";

// ---------------------------------------------------------------------------
// CompletionItem / CompletionProvider
// ---------------------------------------------------------------------------

/** Item returned by a completion provider. */
export interface CompletionItem {
  label: string;
  atom: AtomSegment;
  /** Byte-offset ranges [start, end) of matched characters for highlighting. */
  matches?: [number, number][];
  /**
   * One-line human description rendered in a muted second column of the
   * popup row (e.g. a slash command's purpose). Optional — items without
   * one render label-only. Wraps to at most two lines before truncating.
   */
  description?: string;
}

/**
 * Completion provider: given a query string, return matching items.
 *
 * Async providers (e.g., file completion) attach a `subscribe` method so the
 * substrate can observe result changes via [L22] (direct store
 * observation, no React round-trip). Synchronous providers (command
 * completion) omit it.
 */
export type CompletionProvider = ((query: string) => CompletionItem[]) & {
  subscribe?: (listener: () => void) => () => void;
};

// ---------------------------------------------------------------------------
// DropHandler
// ---------------------------------------------------------------------------

/** Drop handler: given a `FileList` from a drag-and-drop, return atoms to insert. */
export type DropHandler = (files: FileList) => AtomSegment[];

// ---------------------------------------------------------------------------
// HistoryProvider
// ---------------------------------------------------------------------------

/**
 * History provider: navigates through previously submitted entries.
 * The provider manages the stack, cursor, and draft state internally.
 */
export interface HistoryProvider {
  /** Navigate backward. Receives the current editor state (saved as draft on first call). */
  back(current: TugTextEditingState): TugTextEditingState | null;
  /** Navigate forward. Returns the next entry, or the draft when reaching the end. */
  forward(): TugTextEditingState | null;
  /**
   * Reset the cursor to the draft slot (the end of the list) and
   * replace the saved draft with `draft`. Called from the submit flow
   * so the next backward navigation starts from the most recent entry
   * — including the just-submitted one — rather than continuing from
   * wherever the user had browsed to before submitting.
   */
  resetToDraft(draft: TugTextEditingState): void;
}

// ---------------------------------------------------------------------------
// TugTextEditingState
// ---------------------------------------------------------------------------

/**
 * One atom occurrence in a serializable substrate: its identity plus the
 * index of the `TUG_ATOM_CHAR` it stands at.
 *
 * `id` is the optional bytes-store key: image atoms keep their payload
 * (bytes/thumbnail) out-of-band in the per-card `AtomBytesStore` keyed by this
 * id, so a restore that drops it severs the image from its bytes — the chip
 * renders as a placeholder and a re-submit ships no image. Self-contained
 * atoms (text/file/command/doc, whose `value` IS the payload) leave it
 * `undefined`.
 */
export interface TugSubstrateAtom {
  /** Position of the `TUG_ATOM_CHAR` this atom stands at. */
  position: number;
  type: string;
  label: string;
  value: string;
  id?: string;
}

/**
 * The `(text, atoms)` substrate itself, without the editing state's caret and
 * scroll: text with a `TUG_ATOM_CHAR` at each atom position, and the parallel
 * positioned list naming what stands there.
 *
 * This is what an editing surface REPORTS. A field that mirrors out
 * `doc.toString()` alone has already dropped every chip in it to a placeholder
 * character, so the pair travels together wherever a document leaves the
 * editor and is held for as long as the field lives.
 */
export interface TugTextSubstrate {
  text: string;
  atoms: readonly TugSubstrateAtom[];
}

/**
 * Serializable snapshot of editing state.
 *
 * Used for persistence via tugbank (survives reload, app quit) [L23].
 * Plain object — no DOM, no methods. JSON round-trips cleanly.
 */
export interface TugTextEditingState {
  /** Plain text with TUG_ATOM_CHAR at atom positions. */
  text: string;
  /**
   * Atom identity and position — see {@link TugSubstrateAtom}.
   */
  atoms: TugSubstrateAtom[];
  /** Cursor/selection as flat offsets. Null if editor was not focused. */
  selection: { start: number; end: number } | null;
  /**
   * Editor's contenteditable `scrollTop` at capture time. Null or omitted
   * means "no asserted scroll position" — restore leaves the editor's
   * scroll at whatever bake-in default the new mount lands on. A number
   * means "set `root.scrollTop` to this value after the text + atoms +
   * selection have been applied" ([L23]).
   *
   * Optional in the type so existing literal constructions (empty seeds,
   * legacy fixtures, on-disk payloads written before this field existed)
   * compile and decode without churn — `undefined` and `null` are
   * semantically identical at the restore site.
   */
  scrollTop?: number | null;
  /**
   * Editor's contenteditable `scrollLeft` at capture time. Same
   * semantics as {@link scrollTop} but for the horizontal axis: a
   * number means "restore `root.scrollLeft` to this value after the
   * doc + selection are applied", `null`/`undefined` means "no
   * asserted horizontal scroll position".
   *
   * Editors that wrap lines never accumulate non-zero horizontal
   * scroll, so this stays at 0 in practice for them. Editors with
   * line-wrap off (e.g. the `tug-text-editor` substrate's default) need
   * this axis to round-trip whenever the user has scrolled
   * horizontally. Optional for the same forward-compat reason as
   * {@link scrollTop}.
   */
  scrollLeft?: number | null;
  /**
   * Layout-invariant anchor for vertical scroll restoration.
   *
   * `topPos` is the document offset of the line that sat at the top
   * of the viewport at capture time; `topOffsetPx` is the pixel
   * offset of the viewport top within that line (typically 0 for
   * line-aligned scrolling, non-zero for sub-line precision).
   *
   * Why this is needed: the bare {@link scrollTop} pixel value is
   * NOT layout-invariant. The editor's container can grow / shrink
   * between save and restore (font load, panel-size hooks, parent
   * flex changes, viewport resize). When it does, CM6's built-in
   * scroll-anchoring (`@codemirror/view#measure` — the diff branch
   * that maintains the apparent content position across layout
   * changes) shifts `scrollDOM.scrollTop` to keep the same content
   * visible at the same screen position. Restoring the bag's pixel
   * `scrollTop` directly lands at the wrong content position.
   *
   * Restoration: when this field is present, the restore site
   * computes the target scroll as `view.lineBlockAt(topPos).top +
   * topOffsetPx` against the live CM6 height map (which reflects
   * the current post-mount layout). That target is fed through
   * `EditorView.scrollIntoView(topPos, { y: "start", yMargin })`
   * — CM6's native scroll effect — so the eventual measure pass
   * lands the editor at the saved content position regardless of
   * intermediate layout changes.
   *
   * Optional: legacy bags (saved before this field shipped) carry
   * only `scrollTop`, and the restore path falls back to the pixel
   * value. New bags carry both; readers prefer the anchor when
   * present.
   */
  scrollAnchor?: { topPos: number; topOffsetPx: number } | null;
}

/**
 * tug-text-editor/drop-extension.ts — file-drop atom insertion + live drop
 * caret indicator.
 *
 * Wires three concerns into one extension:
 *
 *   1. **Drop caret indicator.** A live thin-vertical-line caret
 *      tracks the resolved drop position in real time as the user
 *      drags a file over the editor. Without this the user has no
 *      idea where their drop will land — a critical UX gap. The
 *      caret position carries a vertical bias (`DROP_Y_OFFSET_RATIO`):
 *      the hit-test point is shifted upward so the resolved position
 *      sits above the drag ghost rather than behind it.
 *
 *   2. **`dragover` accept.** `preventDefault()` on `dragover` is
 *      required to indicate the editor accepts drops; without it
 *      the OS refuses the drag and no `drop` event ever fires.
 *      We further set `dataTransfer.dropEffect = "copy"` so the
 *      cursor shows the copy-cursor variant. The editor accepts
 *      every file drag — there is no cursor-level rejection — so
 *      we don't need to look at per-file MIME information at this
 *      stage.
 *
 *   3. **`drop` insertion.** `preventDefault()` to suppress the
 *      WebView's default navigate-to-file-URL behavior, then a
 *      single transaction inserts each dropped file into the
 *      editor. Files with image extensions (png / jpg / jpeg /
 *      gif / svg / webp) become atoms (image chips routed through
 *      the downsample pipeline when a bytes-store is available);
 *      every other file inserts its basename as plain text. Mixed
 *      drops interleave the two with single-space separators, all
 *      in one CM6 transaction.
 *
 * The caret is implemented with CM6's standard StateField +
 * ViewPlugin + `requestMeasure` pattern — same shape as CM6's
 * built-in `dropCursor` extension. We don't compose `dropCursor`
 * directly because its `dragover` observer doesn't apply the Y
 * bias and runs as `eventObservers` (which cannot
 * `preventDefault`); we need the bias and we need to claim the
 * dragover event so the `drop` event ever fires.
 *
 * The whole drop is one CM6 transaction: a single `changes` insert
 * of `N × U+FFFC` followed by `addAtomsEffect.of([…])` carrying
 * every atom's segment + position. CM6 only ever observes the
 * post-drop state — there's no intermediate frame where the
 * placeholder characters render without their widgets.
 *
 * Laws: [L06] appearance via DOM (the drop caret is an
 *        absolutely-positioned `<div>` in `view.scrollDOM`, not
 *        React state; atom widgets render as images), [L07] the
 *        dropHandler thunk reads the latest host-supplied handler
 *        at fire time, [L13] no rAF — the caret position is
 *        committed via `view.requestMeasure` (CM6's measure-phase
 *        scheduler), the drop is one transaction dispatched
 *        directly from the DOM event handler, [L19] file structure
 *        (`tug-text-editor/drop-extension.ts` paired with
 *        `tug-text-editor-drop.test.ts`).
 *
 * Third-party notice: CodeMirror 6 (MIT) — see
 * `THIRD_PARTY_NOTICES.md`. The drop caret pattern (StateField
 * tracking a position + ViewPlugin painting it via
 * `requestMeasure`) is adapted from CM6's `dropCursor`
 * implementation.
 */

import { StateEffect, StateField } from "@codemirror/state";
import type {
  EditorState,
  Extension,
  Transaction,
  TransactionSpec,
} from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { PluginValue, ViewUpdate } from "@codemirror/view";
import {
  TUG_ATOM_CHAR,
  type AtomSegment,
} from "@/lib/tug-atom-img";
import {
  addAtomsEffect,
  getAtomsInState,
} from "./atom-decoration";
import { padInsert } from "./smart-insert";
import { CARET_HEIGHT_FACTOR, readRowHeightFromGhost } from "./caret-layer";
import type { DropHandler } from "@/lib/tug-text-types";
import {
  downsampleImage,
  type DownsampleError,
  type DownsampleResult,
} from "@/lib/image-downsample";
import type { AtomBytesStore } from "@/lib/atom-bytes-store";
import { uploadDraftAttachment } from "@/lib/attachment-upload";
import { hasJotDrag, readJotDrag } from "@/lib/jot-drag";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fraction of line-height to shift the drop hit-point upward.
 *
 * The drag ghost rendered by the OS sits centered on the cursor;
 * without the bias, `posAtCoords` resolves to the position *under*
 * the ghost, which is hidden from the user. Shifting the hit-test
 * point upward puts the resolved drop position — and the drop caret
 * painted at it — above the ghost where the eye is looking.
 *
 * The bias is scaled by `view.defaultLineHeight` so it stays
 * proportional to the line metric. A larger lift pushes the caret so
 * far above the cursor that a drop over the attachment strip can no
 * longer reach the last row of text; `-0.8` keeps the caret clear of
 * the ghost while still resolving to the row the cursor is over.
 *
 * The negative value subtracts from `clientY`.
 */
const DROP_Y_OFFSET_RATIO = -0.8;

/** File extensions classified as images for the default file→atom map. */
const IMG_EXTS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
]);

/**
 * Drags the editor claims: a file drag (images → atoms, everything else →
 * filename text) and a Jots card jot drag ([P05]), which lands its text at the
 * drop point. Both paint the same ring + drop caret. Keyboard-driven or
 * application-specific drags pass through untouched.
 */
/**
 * Filename → absolute path for the files in a drag, read from its
 * `text/uri-list` flavor.
 *
 * A `File` object carries no path — only a name — so this is the only place a
 * Finder drag's real location is legible. The OS writes one `file://` URL per
 * line, and the browser hands the matching `File` objects in the same order,
 * but keying by basename rather than by index keeps the two independent.
 *
 * Empty for a drag that carries no URLs (a synthesized drop in a test, a drag
 * out of another web page), in which case callers keep the bare filename.
 */
function droppedFilePaths(
  dataTransfer: DataTransfer | null,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (dataTransfer === null) return out;
  let list = "";
  try {
    list = dataTransfer.getData("text/uri-list");
  } catch {
    return out;
  }
  for (const line of list.split(/\r?\n/)) {
    const url = line.trim();
    if (url.length === 0 || url.startsWith("#")) continue;
    if (!url.startsWith("file://")) continue;
    let path: string;
    try {
      path = decodeURIComponent(new URL(url).pathname);
    } catch {
      continue;
    }
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (name.length > 0) out.set(name, path);
  }
  return out;
}

function acceptsDrag(dataTransfer: DataTransfer | null): boolean {
  if (dataTransfer === null) return false;
  return dataTransfer.types.includes("Files") || hasJotDrag(dataTransfer);
}

/** CSS class applied to the drop caret indicator element. */
const DROP_CARET_CLASS = "cm-tug-drop-caret";

/**
 * Attribute mirrored onto the `.tug-text-editor` host whenever a drop
 * caret is painted, regardless of which surface drove it (the editor
 * itself or the sibling attachment strip). The CSS in `tug-text-editor.css`
 * keys the regular-caret hide off this so the text caret and the drop
 * caret are never visible at once — even for a drag over the strip, which
 * never sets `data-drop-active` on the editor host.
 */
const DROP_CARET_HOST_ATTR = "data-drop-caret";

// ---------------------------------------------------------------------------
// Drop classification — image vs filename text
// ---------------------------------------------------------------------------

/**
 * Decide whether a file should render as an image atom (chip) or
 * insert its basename as plain text. Extension-based: anything with
 * a recognized image extension (png / jpg / jpeg / gif / svg / webp)
 * becomes an atom; everything else becomes filename text.
 *
 * Extension-based on purpose. Inline atom-chip support is images-only
 * (the downsample pipeline only handles raster + svg). Non-image
 * basenames as plain text fall through to the regular text channel
 * without any chip machinery — the model just reads the literal name
 * in the user's message.
 */
function isImageFile(file: File): boolean {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return IMG_EXTS.has(ext);
}

/**
 * One item in the mixed-drop insertion plan. An `atom` item carries
 * an `AtomSegment` that lands at a `U+FFFC` placeholder in the doc;
 * a `text` item inserts a literal substring (currently used for the
 * basename of non-image dropped files).
 */
export type DropMixedItem =
  | { kind: "atom"; segment: AtomSegment }
  | { kind: "text"; text: string };

/**
 * Default no-bytes-store path: convert a `FileList` into a flat list
 * of mixed items, one per file in order. Image-extension files
 * become atom items (no `id`, no bytes — the downsample pipeline
 * only runs in the bytes-store-aware path); everything else becomes
 * a text item carrying the basename.
 *
 * Used by gallery cards / standalone harness where no
 * `AtomBytesStore` is wired. The bytes-store-aware path (the live
 * editor) routes through `processAttachmentFiles`, which preflights
 * (decodes) each image and builds the same item shape with real bytes.
 */
function defaultFilesToMixedItems(files: FileList): DropMixedItem[] {
  const out: DropMixedItem[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    if (isImageFile(f)) {
      out.push({
        kind: "atom",
        segment: { kind: "atom", type: "image", label: f.name, value: f.name },
      });
    } else {
      out.push({ kind: "text", text: f.name });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Position resolution
// ---------------------------------------------------------------------------

/**
 * Resolve `(clientX, clientY)` to a document offset, applying the
 * DROP_Y_OFFSET_RATIO bias so the result sits above the drag ghost
 * rather than behind it.
 *
 * Returns `null` when the resolver can't anchor the bias-adjusted
 * point (typical for drops landing above the first line). Exported
 * for test-side coverage of the bias math without having to
 * synthesize a `DragEvent`.
 */
export function dropOffsetAtCoords(
  view: EditorView,
  clientX: number,
  clientY: number,
): number | null {
  const lh = view.defaultLineHeight;
  const adjustedY = clientY + lh * DROP_Y_OFFSET_RATIO;
  // `posAtCoords` reads measured layout state; on pre-measure mounts
  // it can throw "Reading the editor layout isn't allowed during an
  // update" or a related InvalidStateError. Treat any throw as
  // "couldn't resolve the point" so the caller falls back to
  // end-of-doc rather than the whole drop pipeline failing.
  try {
    return view.posAtCoords({ x: clientX, y: adjustedY });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Drop-caret state field + effect
// ---------------------------------------------------------------------------

/**
 * Effect carrying the new drop-caret document position (or `null`
 * to hide the caret). Read by the StateField below; produced by
 * the DOM event handlers.
 */
const setTugDropCaretPos = StateEffect.define<number | null>();

/**
 * StateField holding the live drop-caret document position, or
 * `null` when no drag is in progress. Maps through document
 * changes so a long-running drag over a doc-changing editor
 * (rare, but possible) doesn't lock the caret to a stale offset.
 */
const tugDropCaretField = StateField.define<number | null>({
  create(): number | null {
    return null;
  },
  update(pos: number | null, tr: Transaction): number | null {
    let next = pos === null ? null : tr.changes.mapPos(pos);
    for (const effect of tr.effects) {
      if (effect.is(setTugDropCaretPos)) {
        next = effect.value;
      }
    }
    return next;
  },
});

/**
 * Paint the drop caret at the bias-adjusted position for `(clientX,
 * clientY)`. Exported so a sibling drop surface (the prompt-entry
 * attachment strip) can drive the *editor's* caret while the cursor
 * is over it — the strip sits below the document, so the caret resolves
 * to the bottom row, pushed up clear of the drag ghost. No-ops if the
 * position is unchanged.
 */
export function paintDropCaret(
  view: EditorView,
  clientX: number,
  clientY: number,
): void {
  paintDropCaretAt(view, dropOffsetAtCoords(view, clientX, clientY));
}

/**
 * Paint the drop caret at a document position the caller already knows —
 * the coordinate-free half of {@link paintDropCaret}.
 *
 * A drag over the *card* around this editor has no document under the
 * pointer at all: the transcript is not the composer, and there is no
 * position for a coordinate to resolve to. The honest thing the cue can say
 * there is where the files will actually land, which is the composer's live
 * selection — so the caret points at the insertion point rather than
 * tracking the cursor. No-ops if the position is unchanged; `null` hides the
 * caret, same as {@link clearDropCaret}.
 */
export function paintDropCaretAt(view: EditorView, pos: number | null): void {
  if (view.state.field(tugDropCaretField) !== pos) {
    view.dispatch({ effects: setTugDropCaretPos.of(pos) });
  }
}

/**
 * Hide the drop caret. Exported alongside {@link paintDropCaret} so the
 * strip can clear it on drag-leave / drag-end / drop — the drag-end and
 * drag-leave clears are what make a native Escape-cancel visibly remove
 * the caret.
 */
export function clearDropCaret(view: EditorView): void {
  if (view.state.field(tugDropCaretField) !== null) {
    view.dispatch({ effects: setTugDropCaretPos.of(null) });
  }
}

/**
 * Mark/clear the editor host's `data-drop-active` drop ring from OUTSIDE
 * the extension — for a sibling drop surface (the prompt entry's
 * whole-entry surface) that routes its drop into this editor. Pairs with
 * {@link paintDropCaret} / {@link clearDropCaret} so an entry-level drag
 * paints the same two cues (ring + caret) as a drag over the editor
 * itself. Resolves the host from the view, same as the caret plugin.
 */
export function markEditorDropActive(view: EditorView, active: boolean): void {
  const host = view.dom.closest<HTMLElement>(".tug-text-editor");
  setDropActive(host, active ? "accept" : null);
}

/**
 * Quiet window after the last `dragover` before the watchdog calls a
 * drag dead. Must comfortably exceed WebKit's steady `dragover` cadence
 * (which keeps firing while a drag is live, even stationary) so a
 * held-still drag is never mistaken for a cancel. A false positive only
 * costs a caret repaint on the next move, so erring slightly long is
 * cheap; erring short would flicker mid-drag.
 */
const DROP_CANCEL_QUIET_MS = 250;

/**
 * Window-level drag-cancel watchdog.
 *
 * When an OS-originated (Finder) file drag is cancelled with Escape,
 * WebKit dispatches NO terminal DOM event — no `dragend`, and the
 * cancel `dragleave` lands on the document rather than the element
 * under the cursor. So neither the editor's nor the strip's
 * element-level `dragleave`/`dragend` reliably fires, and the drop
 * caret + ring would hang until the next drag. The one signal that
 * survives a cancel is the *absence* of further `dragover`: WebKit
 * fires `dragover` on a steady cadence while a drag is live and stops
 * the instant it ends. This plugin arms a timer on each window
 * `dragover` and tears the caret + ring down if the stream goes quiet —
 * covering Escape, drag-off-window, and any other silent cancel for
 * every surface that paints into the shared caret state. A real drop /
 * dragend disarms it first, so the normal path is untouched.
 */
function tugDropCancelWatchdog(host: HTMLElement | null): Extension {
  return ViewPlugin.define((view) => {
    let timer: number | null = null;
    const disarm = (): void => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    const onDragOver = (event: DragEvent): void => {
      if (!acceptsDrag(event.dataTransfer)) return;
      disarm();
      timer = window.setTimeout(() => {
        timer = null;
        setDropActive(host, null);
        clearDropCaret(view);
      }, DROP_CANCEL_QUIET_MS);
    };
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("drop", disarm, true);
    window.addEventListener("dragend", disarm, true);
    return {
      destroy(): void {
        disarm();
        window.removeEventListener("dragover", onDragOver, true);
        window.removeEventListener("drop", disarm, true);
        window.removeEventListener("dragend", disarm, true);
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Drop-caret painter (ViewPlugin)
// ---------------------------------------------------------------------------

interface DropCaretMeasure {
  left: number;
  top: number;
  height: number;
}

/**
 * ViewPlugin that owns the drop-caret `<div>` and reconciles its
 * position with the StateField on every update. Uses
 * `view.requestMeasure` for layout reads + writes — same pattern
 * as CM6's built-in `dropCursor`.
 *
 * Plugin lifecycle:
 *   - Construct: lazy — the caret element is created on first
 *     non-null position so editors that never see a drop pay no
 *     DOM cost.
 *   - Update: when the StateField position changes, schedule a
 *     measure read + write.
 *   - Destroy: remove the caret element.
 */
class TugDropCaretPlugin implements PluginValue {
  caret: HTMLDivElement | null = null;
  private readonly measureReq = {
    read: this.readPos.bind(this),
    write: this.writePos.bind(this),
  };

  constructor(private readonly view: EditorView) {}

  update(update: ViewUpdate): void {
    const pos = update.state.field(tugDropCaretField);
    if (pos === null) {
      // No active drag — drop the caret element so a stale stub
      // doesn't survive subsequent layout changes.
      if (this.caret !== null) {
        this.caret.remove();
        this.caret = null;
      }
      this.setHostDropCaret(false);
      return;
    }
    this.setHostDropCaret(true);
    if (this.caret === null) {
      this.caret = this.view.scrollDOM.appendChild(
        document.createElement("div"),
      );
      this.caret.className = DROP_CARET_CLASS;
    }
    // Re-measure when the position changed, the doc changed (CM6
    // re-laid out lines), or geometry changed (window resize, font
    // load, etc.).
    if (
      update.startState.field(tugDropCaretField) !== pos
      || update.docChanged
      || update.geometryChanged
    ) {
      this.view.requestMeasure(this.measureReq);
    }
  }

  /**
   * Measure-phase read: convert the StateField position into
   * scrollDOM-relative coords so the caret sits at the resolved
   * drop point and scrolls with the content.
   *
   * Caret height matches the text-editing caret exactly: the
   * `.cm-line::before` ghost row height (read via
   * `readRowHeightFromGhost`, the same source `caret-layer.ts`
   * uses) scaled by `CARET_HEIGHT_FACTOR`. The two carets are the
   * same kind of position indicator, so they read as the same
   * height — a full line-box-tall drop caret looked oversized next
   * to the slimmer editing caret.
   * The caret is centered vertically on the glyph rect so a
   * mid-line atom (24px) and adjacent text (~18px) both produce
   * the same drop-caret position.
   *
   * Returns `null` when the position cannot be resolved (typical
   * for drops above the first line); the writer then hides the
   * caret by sliding it off-screen.
   */
  private readPos(): DropCaretMeasure | null {
    const pos = this.view.state.field(tugDropCaretField);
    if (pos === null) return null;
    const rect = this.view.coordsAtPos(pos);
    if (rect === null) return null;
    const outer = this.view.scrollDOM.getBoundingClientRect();
    const rowHeight = readRowHeightFromGhost(this.view, pos);
    const caretHeight = rowHeight * CARET_HEIGHT_FACTOR;
    const center = (rect.top + rect.bottom) / 2;
    return {
      left: rect.left - outer.left + this.view.scrollDOM.scrollLeft,
      top: center - caretHeight / 2 - outer.top + this.view.scrollDOM.scrollTop,
      height: caretHeight,
    };
  }

  /**
   * Measure-phase write: position the caret element. When the
   * read returned `null`, slide the caret off-screen rather than
   * removing it (the StateField is still non-null, so the
   * destroy path isn't appropriate; off-screen positioning is
   * the same trick CM6's built-in dropCursor uses).
   */
  private writePos(measured: DropCaretMeasure | null): void {
    if (this.caret === null) return;
    if (measured === null) {
      this.caret.style.left = "-100000px";
      return;
    }
    this.caret.style.left = `${measured.left}px`;
    this.caret.style.top = `${measured.top}px`;
    this.caret.style.height = `${measured.height}px`;
  }

  /**
   * Mirror the drop-caret presence onto the `.tug-text-editor` host so
   * the CSS hides the regular caret while a drop caret is up. Keyed off
   * the caret field (not `data-drop-active`) so the strip's drag — which
   * paints the editor's drop caret without claiming the editor as a drop
   * target — still hides the text caret. The drop ring and inactive-
   * selection paint stay on `data-drop-active` and are untouched here.
   */
  private setHostDropCaret(active: boolean): void {
    const host = this.view.dom.closest<HTMLElement>(".tug-text-editor");
    if (host === null) return;
    if (active) {
      if (!host.hasAttribute(DROP_CARET_HOST_ATTR)) {
        host.setAttribute(DROP_CARET_HOST_ATTR, "");
      }
    } else if (host.hasAttribute(DROP_CARET_HOST_ATTR)) {
      host.removeAttribute(DROP_CARET_HOST_ATTR);
    }
  }

  destroy(): void {
    if (this.caret !== null) {
      this.caret.remove();
      this.caret = null;
    }
    this.setHostDropCaret(false);
  }
}

const tugDropCaretPlugin = ViewPlugin.fromClass(TugDropCaretPlugin);

// ---------------------------------------------------------------------------
// Insertion helper
// ---------------------------------------------------------------------------

/**
 * Dispatch a single transaction inserting `atoms` at `pos`.
 *
 * Each atom takes one document character (the U+FFFC sentinel),
 * matched by an `addAtomsEffect` entry whose `position` falls inside
 * the just-inserted run. The selection lands immediately after the
 * last inserted atom — same convention as `insertAtomAt` /
 * `insertAtomAtSelection`. No `scrollIntoView`: the user's eye is
 * already on the drop site, so an automatic scroll would be jarring.
 *
 * Thin wrapper over {@link insertMixedAt} for the custom-host-handler
 * path, whose `DropHandler` contract returns `AtomSegment[]` directly.
 * Exported so tests can drive the insertion without a `DragEvent`.
 */
export function insertAtomsAt(
  view: EditorView,
  pos: number,
  atoms: readonly AtomSegment[],
): void {
  insertMixedAt(
    view,
    pos,
    atoms.map((segment) => ({ kind: "atom", segment })),
  );
}

/**
 * Insert a `(text, atoms)` substrate at `pos`, its interior verbatim.
 *
 * The sibling {@link insertMixedAt} joins its items with a single space,
 * which is right for a multi-file drop (several chips, no text of their own)
 * and wrong for a substrate: the text already says where everything goes, and
 * a separator would rewrite the document being carried. So this one writes the
 * text as it stands and hangs each atom on the `U+FFFC` it was recorded at.
 *
 * The pair is zipped by ORDER, not by a recorded index: an `AtomSegment` is
 * the positionless form, and document order is the order the placeholders
 * appear in — which is the same correspondence `walkAtomText` and the
 * clipboard sidecar already read the pair under. So the placeholders in `text`
 * are what decide, and the two ends of a disagreement are both safe: a
 * placeholder past the end of `atoms` stays a bare character rather than
 * taking a chip that belongs to another spot, and an atom past the last
 * placeholder is dropped rather than hung where nothing stands.
 *
 * Smart insert ([B04], [B07]) pads the two OUTER edges only — the warning
 * above is honoured rather than overridden, because nothing interior to the
 * carried text is touched. A substrate that already begins with a newline
 * (the jot append rule) gets no leading space, because `padForInsert` reads
 * the run's own edges.
 */
export function substrateInsertSpec(
  state: EditorState,
  pos: number,
  text: string,
  atoms: ReadonlyArray<AtomSegment>,
): TransactionSpec | null {
  if (text.length === 0) return null;
  const padded = padInsert(state, pos, pos, text);
  const positioned: Array<{ position: number; segment: AtomSegment }> = [];
  let index = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charAt(i) !== TUG_ATOM_CHAR) continue;
    const segment = atoms[index];
    index += 1;
    if (segment === undefined) continue;
    positioned.push({ position: padded.start + i, segment });
  }
  return {
    changes: { from: pos, insert: padded.insert },
    effects: [addAtomsEffect.of(positioned), setTugDropCaretPos.of(null)],
    selection: { anchor: padded.caret },
    userEvent: "input.tug-atom-drop",
  };
}

/** Dispatch {@link substrateInsertSpec}'s one transaction. */
export function insertSubstrateAt(
  view: EditorView,
  pos: number,
  text: string,
  atoms: ReadonlyArray<AtomSegment>,
): void {
  const spec = substrateInsertSpec(view.state, pos, text, atoms);
  if (spec !== null) view.dispatch(spec);
}

/**
 * Dispatch a single transaction inserting a mix of atom + text items
 * at `pos`. Items are joined with a single space; each atom takes
 * one `U+FFFC` placeholder paired with an `addAtomsEffect` entry at
 * the corresponding position, and each text item inserts its literal
 * substring verbatim.
 *
 * Selection lands immediately after the last inserted character — the
 * same end-of-insert convention `insertAtomsAt` used in the
 * atoms-only era. Hides the drop caret in the same transaction.
 *
 * Used by the bytes-store-aware path (`processAttachmentFiles`) and
 * the no-bytes-store default path. The atoms-only `insertAtomsAt`
 * wrapper feeds through here too, so multi-image drops also pick up
 * single-space separators between chips.
 *
 * The run's two outer edges are padded by smart insert ([B04]); the interior
 * single-space join is untouched, because it is already right for a
 * multi-file drop.
 */
export function mixedInsertSpec(
  state: EditorState,
  pos: number,
  items: readonly DropMixedItem[],
): TransactionSpec | null {
  if (items.length === 0) return null;
  let insert = "";
  const offsets: Array<{ offset: number; segment: AtomSegment }> = [];
  for (let i = 0; i < items.length; i += 1) {
    if (i > 0) insert += " ";
    const item = items[i]!;
    if (item.kind === "atom") {
      offsets.push({ offset: insert.length, segment: item.segment });
      insert += TUG_ATOM_CHAR;
    } else {
      insert += item.text;
    }
  }
  const padded = padInsert(state, pos, pos, insert);
  return {
    changes: { from: pos, insert: padded.insert },
    effects: [
      addAtomsEffect.of(
        offsets.map(({ offset, segment }) => ({
          position: padded.start + offset,
          segment,
        })),
      ),
      // Hide the drop caret in the same transaction as the
      // insertion — atomic from the user's perspective.
      setTugDropCaretPos.of(null),
    ],
    selection: { anchor: padded.caret },
    userEvent: "input.tug-atom-drop",
  };
}

/** Dispatch {@link mixedInsertSpec}'s one transaction. */
function insertMixedAt(
  view: EditorView,
  pos: number,
  items: readonly DropMixedItem[],
): void {
  const spec = mixedInsertSpec(view.state, pos, items);
  if (spec !== null) view.dispatch(spec);
}

// ---------------------------------------------------------------------------
// Theme — drop-caret styling
// ---------------------------------------------------------------------------

/**
 * Drop-caret styling. Width / position / pointer-events are
 * structural; color is the drop *accent* — the same token the
 * `[data-drop-active]` ring uses
 * (`--tug7-element-highlight-stroke-normal-drop-rest`), so the caret
 * reads as part of the drop affordance rather than as the regular
 * text-editing caret (which is the cobalt
 * `--tug7-element-field-border-normal-plain-active`). Pairing the
 * caret with the ring's accent keeps the two drop cues visually
 * unified across brio and harmony.
 */
const tugDropCaretTheme = EditorView.baseTheme({
  [`.${DROP_CARET_CLASS}`]: {
    position: "absolute",
    width: "2px",
    borderRadius: "1px",
    pointerEvents: "none",
    backgroundColor: "var(--tug7-element-highlight-stroke-normal-drop-rest)",
  },
});

/**
 * The drop caret on its own — state field, layer plugin, and styling — with
 * none of the composer's atom, jot, or attachment machinery attached.
 *
 * {@link paintDropCaret} and {@link clearDropCaret} require this field to be
 * in the editor's state; a surface that wants the same "here is where these
 * bytes will land" affordance for its own drop handling installs this and
 * drives it with those two calls. The Text card's file drop is the second
 * such surface, and it deliberately takes only this much.
 */
export const tugDropCaretExtension: Extension = [
  tugDropCaretField,
  tugDropCaretPlugin,
  tugDropCaretTheme,
];

// ---------------------------------------------------------------------------
// Image-attachment async pipeline
// ---------------------------------------------------------------------------

/**
 * Convert a `DownsampleError` into a calm, user-facing string for the
 * host's attachment-error notice (the Session card raises a pane bulletin).
 * The discriminated shape lets us tailor copy per failure mode; each
 * message names the file so the user knows exactly what didn't attach.
 *
 * Exported for the paste handler (in `clipboard-filters.ts`) which
 * uses the same convention.
 */
export function describeDownsampleError(
  err: DownsampleError,
  filename: string,
): string {
  switch (err.kind) {
    case "unsupported-format":
      return `Can't attach ${filename}: ${err.mediaType}: unsupported image type`;
    case "too-large-after-fallback": {
      const mb = (err.byteSize / 1024 / 1024).toFixed(1);
      return `Can't attach ${filename}: image too large (${mb} MB)`;
    }
    case "decode-failed":
      return `Can't attach ${filename}: unsupported image type`;
  }
}

/**
 * Mint a stable atom id for a freshly-dropped or freshly-pasted
 * file. UUIDs are the right shape (large keyspace, no coordination,
 * no collisions across cards or sessions). Defensive `??` covers
 * vanishingly unlikely future engines without `crypto.randomUUID`.
 */
function mintAtomId(): string {
  return typeof crypto !== "undefined"
    && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `atom-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Preflight outcome for one dropped / pasted file. Every file resolves
 * to exactly one of these BEFORE the document is touched:
 *  - `atom`  — a valid image; its bytes are already downsampled and
 *    ready to land in the store, so the inserted atom is never pending.
 *  - `text`  — a non-image file (basename verbatim), or a rejected
 *    image degraded to its filename; `error` carries the reason to
 *    surface when present.
 */
type ResolvedDrop =
  | { kind: "atom"; result: DownsampleResult }
  | { kind: "text"; text: string; error?: string };

/**
 * Preflight one file. Non-image extensions resolve straight to filename
 * text with no decode. Image extensions are downsampled here — success
 * becomes an `atom` (bytes in hand), and any rejection (unsupported /
 * oversize / undecodable) or thrown error degrades to filename text
 * carrying the reason, so a bad image lands exactly like a `.zip` drop
 * rather than vanishing.
 */
async function resolveDroppedFile(
  file: File,
  // The absolute path the drag reported for this file, when the OS supplied
  // one. A `File` carries no path, so this comes from the drag's own
  // `text/uri-list` flavor.
  absolutePath?: string,
): Promise<ResolvedDrop> {
  if (!isImageFile(file)) {
    // A path is actionable — the model can read the file — where a bare
    // filename names nothing anyone can open ([P13]). The prompt holds
    // references to non-image files as text, never as atoms ([P05]).
    return { kind: "text", text: absolutePath ?? file.name };
  }
  try {
    const outcome = await downsampleImage(file);
    if (outcome.ok) {
      return { kind: "atom", result: outcome.result };
    }
    return {
      kind: "text",
      text: file.name,
      error: describeDownsampleError(outcome.error, file.name),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    return {
      kind: "text",
      text: file.name,
      error: `Attachment processing failed: ${file.name} (${reason})`,
    };
  }
}

/**
 * Convert user-dropped or user-pasted files into atoms + filename text
 * in a SINGLE document mutation.
 *
 * Preflight first, mutate once: every file is resolved to its final
 * form — a valid image (bytes decoded and ready), a non-image filename,
 * or a rejected image degraded to filename text — BEFORE anything is
 * inserted. Only then do we mint `image-N` labels, stage the bytes, and
 * dispatch one `insertMixedAt` transaction. There is no optimistic
 * skeleton and no async repair pass, so:
 *  - the insertion is a single history entry — one undo removes the
 *    whole drop cleanly, with no skeleton or tofu resurrected (the
 *    repair-transaction undo hazard is gone by construction), and
 *  - a rejected image never flashes a pending chip; it simply lands as
 *    its filename, with the reason surfaced via `onError`.
 *
 * The image atoms carry the unified `image-N` name (numbered after the
 * image atoms already in the doc), not the original filename: the name
 * can't cross the wire (the image content block carries none), so the
 * editor speaks the same `image-N` the transcript synthesizer mints.
 * Only surviving images consume an ordinal; a rejected image degrades
 * to text and takes none.
 *
 * Bytes are put into the store BEFORE insertion so each atom renders
 * fully on first paint. `view.dom.isConnected` is re-checked after the
 * decode await — if the editor unmounted while we were decoding, the
 * insertion is skipped (the doc is gone anyway).
 *
 * Each surviving image's ORIGINAL file is then sent up in the background
 * (`/api/attachments`) and its stored path merged into the entry when it
 * lands. That path is what lets the attachment survive a relaunch: the
 * downsampled bytes in the store are far too large to persist, a path is not.
 * The chip never waits on the upload and never renders pending for it.
 *
 * Returns a `Promise` (the decode is awaited); callers fire-and-forget
 * with `void`. Exported so the paste handler in `clipboard-filters.ts`
 * shares the same pipeline.
 */
export async function processAttachmentFiles(
  view: EditorView,
  files: readonly File[],
  insertPos: number,
  bytesStore: AtomBytesStore,
  onError: (message: string) => void,
  /** Filename → absolute path, from the drag's `text/uri-list` ([P13]). */
  paths?: ReadonlyMap<string, string>,
): Promise<void> {
  if (files.length === 0) return;

  // Count existing image atoms up front so `image-N` numbering picks up
  // after them. Read before the await — positions can't have shifted
  // since the drop, and we only need the count.
  const existingImageCount = getAtomsInState(view.state).filter(
    (p) => p.segment.type === "image",
  ).length;

  // Preflight — resolve every file (decoding images) before touching the
  // document. Order is preserved.
  const resolved = await Promise.all(
    files.map((file) => resolveDroppedFile(file, paths?.get(file.name))),
  );

  // The editor may have unmounted while we were decoding.
  if (!view.dom.isConnected) return;

  // Build the insertion plan: valid images become atoms with a freshly
  // minted id + `image-N` label and stage their bytes; everything else
  // is filename text. Ordinals advance only for surviving images.
  let imageOrdinal = existingImageCount;
  const bytesToPut: Array<{ id: string; result: DownsampleResult }> = [];
  // The originals to upload, paired with the atom that will reference them.
  // Pairing is by the `resolved` index rather than `bytesToPut`'s: the two
  // diverge the moment any file degrades to text.
  const originalsToUpload: Array<{ id: string; file: File }> = [];
  const items: DropMixedItem[] = resolved.map((entry, index) => {
    if (entry.kind === "atom") {
      imageOrdinal += 1;
      const id = mintAtomId();
      const name = `image-${imageOrdinal}`;
      bytesToPut.push({ id, result: entry.result });
      const original = files[index];
      if (original !== undefined) {
        originalsToUpload.push({ id, file: original });
      }
      return {
        kind: "atom" as const,
        segment: { kind: "atom", type: "image", label: name, value: name, id },
      };
    }
    return { kind: "text" as const, text: entry.text };
  });

  // Stage bytes BEFORE the insertion so each atom widget reads a
  // fully-populated store entry at its first `toDOM` — never a pending
  // chip. `thumbnailDataUrl` rides along so the post-submit synthesizer
  // doesn't re-bake (Step 6's strip renderer reads it unconditionally).
  for (const b of bytesToPut) {
    bytesStore.put(b.id, {
      content: b.result.content,
      mediaType: b.result.mediaType,
      thumbnailDataUrl: b.result.thumbnailDataUrl,
    });
  }

  // Send each original up in the background so the entry can carry a durable
  // reference to it. The chip never waits on this — its bytes are already in
  // the store — and an upload that fails or is refused simply leaves the
  // entry pathless, which is the behavior that shipped before paths existed.
  for (const { id, file } of originalsToUpload) {
    void uploadDraftAttachment(file).then((path) => {
      if (path === null) return;
      // Re-read rather than reconstruct: if the user removed the chip while
      // the upload was in flight, `delete(id)` has already run, and putting
      // an entry back would both resurrect a row for an atom that no longer
      // exists and hand the sweep a live-looking reference to bytes nobody
      // can reach.
      const live = bytesStore.get(id);
      if (live === null) return;
      // The name rides with the path: the stored file is a UUID, and the name
      // the user knows this attachment by is only recoverable here.
      const next = { ...live, path };
      if (file.name.length > 0) next.name = file.name;
      bytesStore.put(id, next);
    });
  }

  // Single transaction: atoms + text interleaved in input order.
  if (items.length > 0) {
    // Clamp against the live doc — defensive, in case the doc shrank
    // during the decode await.
    const pos = Math.min(insertPos, view.state.doc.length);
    insertMixedAt(view, pos, items);

    // Empty-editor drop fix: when a file is dropped before the editor
    // has been focused/measured, CM6 mints the widget but may not paint
    // it. `focus()` makes the editor the active responder; the measure
    // pass flushes the widget's `toDOM`. Both are no-ops once the editor
    // is focused + measured.
    view.focus();
    view.requestMeasure({ read: () => null });
  }

  // Surface any rejection reasons (coalesced by the host's bulletin id).
  for (const entry of resolved) {
    if (entry.kind === "text" && entry.error !== undefined) {
      onError(entry.error);
    }
  }
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

/**
 * Drop-active state. Two-valued, written to `data-drop-active` on
 * the host wrapper:
 *
 *  - `null`     — no drag in progress; attribute absent.
 *  - `"accept"` — drag is over the editor; the drop will be accepted.
 *                Border ring paints in the standard drop color.
 *
 * The editor accepts every file drag — there is no cursor-level
 * rejection. Image-extension files become atoms; everything else
 * inserts as filename text. So the only state distinction during
 * drag is "drag in progress" vs not, and `null` / `"accept"` is
 * enough.
 */
type DropActiveState = "accept" | null;

/**
 * Mark/clear the host's `data-drop-active` attribute. The CSS in
 * `tug-text-editor.css` keys the drop ring, caret-hide, and inactive-
 * selection-paint rules off this attribute presence.
 *
 * Idempotent — checking before mutating avoids redundant attribute
 * writes that would re-trigger MutationObservers (none today, but
 * cheap insurance).
 */
function setDropActive(host: HTMLElement | null, state: DropActiveState): void {
  if (host === null) return;
  const current = host.getAttribute("data-drop-active");
  if (state === null) {
    if (current !== null) host.removeAttribute("data-drop-active");
    return;
  }
  if (current !== state) {
    host.setAttribute("data-drop-active", state);
  }
}

/**
 * Build the drop-handling extension.
 *
 * `host` is the `tug-text-editor` wrapper `<div>` rendered by `TugTextEditor`.
 * The drop pipeline writes the `data-drop-active` attribute on
 * this element so the CSS rules in `tug-text-editor.css` can paint the
 * drop ring, hide the regular caret, and switch the selection
 * overlay to the inactive variant — all while a drag is in
 * progress, restored to the pre-drag appearance the moment the
 * drag ends (drop / dragleave-out / dragend).
 *
 * `getDropHandler` is a thunk so the React shell can mirror its
 * `dropHandler` prop into a ref and pass a closure that reads the
 * ref at fire time — same [L07] pattern the keymap and completion
 * extensions use. Returns `null` to opt into the default
 * extension-based file→atom conversion.
 *
 * `getBytesStore` and `onAttachmentError` are the bytes-store-aware
 * additions (Step 2 of `arc/dev-atoms.md`). When `getBytesStore`
 * returns a live `AtomBytesStore`, the drop pipeline runs through
 * the `processAttachmentFiles` path: each image is preflighted
 * (downsampled) before insertion — valid images are given a stable
 * UUID and stashed in the store, rejected images degrade to filename
 * text — then the final atoms + text land in one transaction.
 * Non-image files insert their basename as plain text. When
 * `getBytesStore` returns `null` (gallery cards, prompt-entry
 * instances unrelated to a dev session), the synchronous
 * `defaultFilesToMixedItems` path runs — image atoms come back with
 * `value: filename` and no bytes; non-image entries ride as filename
 * text.
 *
 * `onAttachmentError(message)` hands a downsample-rejection message
 * to the host, which surfaces it as a calm card-scoped notice (the
 * Session card raises a pane bulletin); tests can pass a spy.
 *
 * A host-supplied `getDropHandler()` still wins over the default —
 * the gallery card uses that escape hatch to inject deterministic
 * test atoms. When both `getBytesStore()` and `getDropHandler()` are
 * non-null, the custom handler takes precedence and no async
 * processing happens.
 *
 * The DOM event handlers attach to the HOST wrapper (native
 * listeners installed by a ViewPlugin), NOT to `view.contentDOM`
 * via `EditorView.domEventHandlers`. The content DOM is
 * content-sized: a host taller than its content (the Dev prompt's
 * min-height) has a blank band below the last line where a drag
 * targets the scroller and never reaches a contentDOM handler — the
 * OS would refuse the drop over the editor's own empty space. The
 * host is the text surface (same rule as `host-click.ts`), so the
 * drag surface is the host: events over content bubble up to it,
 * and events over the blank band land on it directly.
 *
 * Returns an array of extensions (StateField + ViewPlugin + theme +
 * event handlers) so the consumer doesn't have to know the
 * internal pieces.
 */
export function tugDropExtension(
  host: HTMLElement | null,
  getDropHandler: () => DropHandler | null,
  getBytesStore: () => AtomBytesStore | null = () => null,
  onAttachmentError: (message: string) => void = () => undefined,
): Extension {
  return [
    tugDropCaretField,
    tugDropCaretPlugin,
    tugDropCaretTheme,
    tugDropCancelWatchdog(host),
    ViewPlugin.define((view) => {
      const onDragEnter = (event: DragEvent): void => {
        if (!acceptsDrag(event.dataTransfer)) return;
        // Claim the event so CM6's internal drag handler doesn't
        // also try to accept it with `dropEffect = "copy"` (which
        // would be redundant but defensive in case CM6's behavior
        // changes).
        event.preventDefault();
        setDropActive(host, "accept");
      };
      const onDragOver = (event: DragEvent): void => {
        const transfer = event.dataTransfer;
        if (!acceptsDrag(transfer) || transfer === null) return;
        event.preventDefault();
        setDropActive(host, "accept");
        try {
          // `"copy"` is the standard accept cursor. The editor accepts
          // every file drag — images become atoms, everything else
          // inserts as filename text — so there is no reject branch
          // here.
          transfer.dropEffect = "copy";
        } catch {
          // `dropEffect` is read-only in some environments.
        }
        paintDropCaret(view, event.clientX, event.clientY);
      };
      const onDragLeave = (event: DragEvent): void => {
        // Only hide when the cursor truly exits the editor — a
        // dragleave fires for every internal element-to-element
        // crossing too. `relatedTarget` names the element being
        // entered; if it's inside the host, the drag is still over
        // the editor.
        const related = event.relatedTarget as Node | null;
        if (related !== null && host !== null && host.contains(related)) {
          return;
        }
        setDropActive(host, null);
        clearDropCaret(view);
      };
      const onDragEnd = (_event: DragEvent): void => {
        setDropActive(host, null);
        clearDropCaret(view);
      };
      /**
       * Jot drops ([P05]) are claimed in the CAPTURE phase, before
       * CM6's own text-drop handler on `contentDOM` can take them. CM6
       * would insert at its unbiased `posAtCoords`, which is the position
       * hidden under the drag image — a line off from where the drop caret
       * promised the text would land. Claiming first (and stopping the
       * event) makes the painted caret and the insertion the same position.
       *
       * The handler inserts and stops. It claims no focus and does not
       * activate the card: a drop is a content gesture on both ends
       * (focus-language.md § Drag and the keyboard). `insertMixedAt`
       * records the insertion point in `view.state.selection`, which
       * becomes the visible caret if and when the editor is next
       * granted focus legitimately.
       */
      const onDropCapture = (event: DragEvent): void => {
        const jot = readJotDrag(event.dataTransfer);
        if (jot === null) return;
        event.preventDefault();
        event.stopPropagation();
        setDropActive(host, null);
        const at = dropOffsetAtCoords(view, event.clientX, event.clientY);
        // The substrate verbatim: the chips a jot holds arrive as chips.
        insertSubstrateAt(view, at ?? view.state.doc.length, jot.text, jot.atoms);
      };
      const onDrop = (event: DragEvent): void => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) {
          // No files — clear the caret if a previous dragover
          // left one up, then bail without preventDefault so the
          // browser handles the (non-file) drop natively.
          setDropActive(host, null);
          clearDropCaret(view);
          return;
        }

        // Suppress the WebView's default file-URL navigation. Done
        // first so even an early `return` below leaves the page
        // intact.
        event.preventDefault();
        setDropActive(host, null);

        const pos = dropOffsetAtCoords(view, event.clientX, event.clientY);
        const insertPos = pos !== null ? pos : view.state.doc.length;

        // Custom host-supplied handler wins — gallery cards use this
        // to inject deterministic test atoms without going through
        // the downsample path.
        const handler = getDropHandler();
        if (handler !== null) {
          const atoms = handler(files);
          if (atoms.length === 0) {
            clearDropCaret(view);
            return;
          }
          insertAtomsAt(view, insertPos, atoms);
          return;
        }

        // Hide the drop caret synchronously — the async pipeline
        // will dispatch its own insertion transaction once
        // processing completes, but the user already let go of the
        // drag and the caret should track that.
        clearDropCaret(view);

        const bytesStore = getBytesStore();
        if (bytesStore === null) {
          // No bytes-store — fall back to the synchronous default.
          // Image atoms come back with no bytes; non-image files
          // ride as plain filename text. Used by gallery cards and
          // future detached prompt-entries that don't participate
          // in attachment bytes.
          const items = defaultFilesToMixedItems(files);
          if (items.length === 0) return;
          insertMixedAt(view, insertPos, items);
          return;
        }

        // Bytes-store-aware path: preflights every file (decoding
        // images) and then inserts the final atoms + filename text at
        // the drop point in one transaction. Fire-and-forget — the
        // decode is awaited inside, the drop handler returns now.
        void processAttachmentFiles(
          view,
          Array.from(files),
          insertPos,
          bytesStore,
          onAttachmentError,
          droppedFilePaths(event.dataTransfer),
        );
      };

      // The host is the drag surface (see the factory docstring); fall
      // back to the editor's own DOM if a host was never supplied.
      const surface: HTMLElement = host ?? view.dom;
      surface.addEventListener("dragenter", onDragEnter);
      surface.addEventListener("dragover", onDragOver);
      surface.addEventListener("dragleave", onDragLeave);
      surface.addEventListener("dragend", onDragEnd);
      surface.addEventListener("drop", onDropCapture, true);
      surface.addEventListener("drop", onDrop);
      return {
        destroy(): void {
          surface.removeEventListener("drop", onDropCapture, true);
          surface.removeEventListener("dragenter", onDragEnter);
          surface.removeEventListener("dragover", onDragOver);
          surface.removeEventListener("dragleave", onDragLeave);
          surface.removeEventListener("dragend", onDragEnd);
          surface.removeEventListener("drop", onDrop);
        },
      };
    }),
  ];
}

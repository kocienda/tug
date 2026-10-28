/**
 * selection-extension.ts — base/extent selection extension for read-only
 * text surfaces.
 *
 * A selection has two ends that are not interchangeable: the **base** (the
 * end the gesture started from, which stays put) and the **extent** (the end
 * that moves). A shift-click or shift-drag re-places the extent and leaves
 * the base where it was; an unshifted press re-places both.
 *
 * The controller also carries a **granularity** — character, word, or
 * paragraph — set by the click count of the press that established the base.
 * Extension re-expands BOTH ends at that granularity, so extending a
 * double-click selection keeps whole words selected at each end, and
 * extending a triple-click selection keeps whole paragraphs.
 *
 * ## Division of labour with the browser
 *
 * Unshifted gestures stay native: WebKit's own hit-testing, word/paragraph
 * expansion, and drag-tracking run untouched, and the controller only
 * *records* the base and granularity they established. Shifted gestures are
 * the controller's: the `mousedown` default is prevented and the selection is
 * set outright via `setBaseAndExtent`.
 *
 * The recorded base is what an extension pivots on. The live selection's
 * anchor is only the fallback, for a selection this controller did not
 * originate — one restored from a saved bag, or a select-all.
 *
 * ## Relationship to selection-guard
 *
 * `SelectionGuard` keeps its pointer-clamping and autoscroll: this controller
 * prevents the `mousedown` default only, so the guard's capture-phase
 * `pointerdown` tracking still arms, and its clamp path (`Selection.extend`)
 * moves the extent while leaving the base pinned. Points that do not resolve
 * inside the root are left to the guard to clamp.
 *
 * ## Keyboard extension
 *
 * The selection-extending chords (⇧ with an arrow, ⇧⌥ and ⇧⌘ with an arrow,
 * ⇧Home/End, ⇧Page Up/Down) move the extent of a ranged selection inside the
 * root, whatever holds DOM focus, and only the extent: the base stays where
 * the selection began, and the extent may cross it — a selection shrinks
 * onto its base, collapses there, and grows out the other side, as in a
 * Cocoa text view. `Selection.modify("extend", …)` cannot be trusted with
 * that: WebKit treats a mouse-made selection as having no direction and
 * moves whichever end faces the arrow, so the first ⇧← after a forward drag
 * grew the selection from its base. So the extender steps a caret from the
 * extent with `modify("move", …)` and sets base-to-extent itself.
 * Nothing in a read-only surface is focusable, so after a drag there DOM
 * focus is on `<body>` or in an editor elsewhere, and the deck's key-view
 * delegate would hand the key to that editor — the composer, in a Session
 * card — which moves its own caret and the reader's selection is lost. The
 * listener is on `window` in the capture phase, ahead of every document-level
 * key stage, and it consumes only a chord it acted on. DOM focus is never
 * moved, so an unshifted key or a printable still reaches the editor exactly
 * as before.
 */

import { caretPositionFromPointCompat } from "./selection-guard";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Expansion unit applied to both ends of the selection. */
export type SelectionGranularity = "character" | "word" | "paragraph";

/** A DOM position: a container node plus an offset within it. */
export interface SelectionPoint {
  readonly node: Node;
  readonly offset: number;
}

/** Which way a point is expanded away from the opposite end. */
export type ExpandDirection = "backward" | "forward";

// ---------------------------------------------------------------------------
// Point comparison
// ---------------------------------------------------------------------------

/**
 * Compare two DOM positions in document order.
 *
 * Returns a negative number when `a` precedes `b`, zero when they are the
 * same position, and a positive number when `a` follows `b`. Returns `0` when
 * the two positions are not comparable (different trees), which makes callers
 * treat the pair as collapsed rather than guess a direction.
 */
export function comparePoints(a: SelectionPoint, b: SelectionPoint): number {
  try {
    const ra = document.createRange();
    ra.setStart(a.node, a.offset);
    ra.collapse(true);
    const rb = document.createRange();
    rb.setStart(b.node, b.offset);
    rb.collapse(true);
    return ra.compareBoundaryPoints(Range.START_TO_START, rb);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Granularity expansion
// ---------------------------------------------------------------------------

/** Word boundary: whitespace or ASCII punctuation. */
const WORD_BOUNDARY = /[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/**
 * Scan `text` from `offset` to the far edge of the word it touches.
 *
 * Backward scanning walks left over word characters, so an offset sitting
 * just past the end of a word returns that word's start. Forward scanning
 * walks right over word characters. An offset surrounded by boundary
 * characters does not move in either direction.
 */
export function wordEdgeOffset(
  text: string,
  offset: number,
  direction: ExpandDirection,
): number {
  let i = Math.max(0, Math.min(offset, text.length));
  if (direction === "backward") {
    while (i > 0 && !WORD_BOUNDARY.test(text[i - 1]!)) i--;
    return i;
  }
  while (i < text.length && !WORD_BOUNDARY.test(text[i]!)) i++;
  return i;
}

/**
 * Nearest block-level ancestor of `node` inside `root`, or `null` when the
 * walk reaches `root` without finding one.
 *
 * Paragraph granularity treats that element's content as the unit, which
 * spans the inline markup (`<em>`, `<code>`, atom chips) a text-node-level
 * scan would clip at.
 */
export function nearestBlockElement(
  node: Node,
  root: HTMLElement,
): HTMLElement | null {
  let el: Element | null = node instanceof Element ? node : node.parentElement;
  while (el !== null && el !== root) {
    if (el instanceof HTMLElement) {
      const display = window.getComputedStyle(el).display;
      if (!display.startsWith("inline") && display !== "contents") return el;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * Move `point` to the `direction` edge of the unit named by `granularity`.
 *
 * Character granularity returns the point unchanged. Word granularity scans
 * within the point's text node. Paragraph granularity resolves to the start
 * or end of the nearest block element, falling back to the word edge when the
 * point has no block ancestor inside `root`.
 */
export function expandPoint(
  point: SelectionPoint,
  granularity: SelectionGranularity,
  direction: ExpandDirection,
  root: HTMLElement,
): SelectionPoint {
  if (granularity === "character") return point;

  if (granularity === "paragraph") {
    const block = nearestBlockElement(point.node, root);
    if (block !== null) {
      return direction === "backward"
        ? { node: block, offset: 0 }
        : { node: block, offset: block.childNodes.length };
    }
  }

  if (point.node.nodeType === Node.TEXT_NODE) {
    const text = point.node.textContent ?? "";
    return { node: point.node, offset: wordEdgeOffset(text, point.offset, direction) };
  }

  return point;
}

/**
 * Expand a base/extent pair at `granularity`, growing each end away from the
 * other. A collapsed pair grows outward in both directions, which is what
 * makes a granular press select the whole word or paragraph under it.
 */
export function expandPair(
  base: SelectionPoint,
  extent: SelectionPoint,
  granularity: SelectionGranularity,
  root: HTMLElement,
): { base: SelectionPoint; extent: SelectionPoint } {
  const order = comparePoints(base, extent);
  const baseDirection: ExpandDirection = order > 0 ? "forward" : "backward";
  const extentDirection: ExpandDirection = order > 0 ? "backward" : "forward";
  return {
    base: expandPoint(base, granularity, baseDirection, root),
    extent: expandPoint(extent, granularity, extentDirection, root),
  };
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

/** Click count → the granularity that press establishes. */
export function granularityForClickCount(count: number): SelectionGranularity {
  if (count >= 3) return "paragraph";
  if (count === 2) return "word";
  return "character";
}

// ---------------------------------------------------------------------------
// Keyboard extension
// ---------------------------------------------------------------------------

/** The `Selection.modify` granularities a keyboard extension uses. */
export type ModifyGranularity =
  | "character"
  | "word"
  | "line"
  | "lineboundary"
  | "paragraphboundary"
  | "documentboundary";

/**
 * How a selection-extending chord moves the extent: one `Selection.modify`
 * step, or a page, which `modify` has no granularity for.
 */
export type KeyboardExtension =
  | { readonly kind: "modify"; readonly direction: ExpandDirection; readonly granularity: ModifyGranularity }
  | { readonly kind: "page"; readonly direction: ExpandDirection };

/** The modifier state of a keydown, as a chord reads it. */
export interface ChordKeys {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

/**
 * The extension a chord asks for, by the macOS text-system's reading of it,
 * or `null` when the chord extends nothing: no ⇧, a ⌃, or a key that is not
 * an arrow, Home/End or Page Up/Down.
 *
 * ⌥ widens a horizontal step to a word and a vertical one to a paragraph's
 * edge; ⌘ widens a horizontal step to the line's edge and a vertical one to
 * the document's. ⇧Home and ⇧End reach the document's edges, as they do in a
 * Cocoa text view. ⌘ wins over ⌥ when both are held.
 */
export function keyboardExtensionFor(chord: ChordKeys): KeyboardExtension | null {
  if (!chord.shiftKey || chord.ctrlKey) return null;
  const { altKey, metaKey } = chord;
  switch (chord.key) {
    case "ArrowLeft":
    case "ArrowRight":
      return {
        kind: "modify",
        direction: chord.key === "ArrowLeft" ? "backward" : "forward",
        granularity: metaKey ? "lineboundary" : altKey ? "word" : "character",
      };
    case "ArrowUp":
    case "ArrowDown":
      return {
        kind: "modify",
        direction: chord.key === "ArrowUp" ? "backward" : "forward",
        granularity: metaKey ? "documentboundary" : altKey ? "paragraphboundary" : "line",
      };
    case "Home":
    case "End":
      if (altKey || metaKey) return null;
      return {
        kind: "modify",
        direction: chord.key === "Home" ? "backward" : "forward",
        granularity: "documentboundary",
      };
    case "PageUp":
    case "PageDown":
      if (altKey || metaKey) return null;
      return { kind: "page", direction: chord.key === "PageUp" ? "backward" : "forward" };
    default:
      return null;
  }
}

/** What a keyboard extension leaves for the next chord to continue from. */
interface KeyedSelection {
  readonly base: SelectionPoint;
  readonly extent: SelectionPoint;
  /** The column a run of vertical steps holds to, or `null` outside one. */
  readonly goalX: number | null;
}

/** The caret rectangle at `point`, or `null` where it lays out nothing. */
function caretRect(point: SelectionPoint): DOMRect | null {
  const range = document.createRange();
  try {
    range.setStart(point.node, point.offset);
  } catch {
    return null;
  }
  range.collapse(true);
  const rects = range.getClientRects();
  if (rects.length > 0) return rects[0];
  const box = range.getBoundingClientRect();
  return box.width === 0 && box.height === 0 && box.top === 0 && box.left === 0 ? null : box;
}

/** Granularity ordering, so a shift-double-click can only raise the unit. */
const GRANULARITY_RANK: Record<SelectionGranularity, number> = {
  character: 0,
  word: 1,
  paragraph: 2,
};

function coarser(
  a: SelectionGranularity,
  b: SelectionGranularity,
): SelectionGranularity {
  return GRANULARITY_RANK[a] >= GRANULARITY_RANK[b] ? a : b;
}

/**
 * Elements whose press belongs to the control, not to text selection.
 * Extension declines these so a shift-click on a disclosure chevron or a
 * file-ref button behaves as that control's click.
 */
const NON_SELECTABLE_TARGET =
  'button, a, input, textarea, select, [contenteditable="true"], ' +
  '[data-tug-select="none"], [data-tug-select="custom"]';

function isSelectableTarget(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (el === null) return true;
  return el.closest(NON_SELECTABLE_TARGET) === null;
}

/** First or last text position inside `node`'s subtree, or `null`. */
function edgeTextPosition(node: Node, edge: "first" | "last"): SelectionPoint | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return {
      node,
      offset: edge === "first" ? 0 : (node.textContent ?? "").length,
    };
  }
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let found: Node | null = null;
  while (walker.nextNode() !== null) {
    found = walker.currentNode;
    if (edge === "first") break;
  }
  if (found === null) return null;
  return {
    node: found,
    offset: edge === "first" ? 0 : (found.textContent ?? "").length,
  };
}

/**
 * Move an element-container position down to the equivalent text position.
 *
 * Hit-testing a point that falls in a container's own box — inter-line
 * leading, block padding, the gap between two rows — resolves to
 * `{element, childIndex}` rather than to a character. Such a position is a
 * poor base: it sits at a child boundary, so a later extension starts from
 * the edge of a block instead of from where the user pressed. Descending to
 * the nearest text position is what makes the base a character position, the
 * way a caret is.
 *
 * Text positions and containers with no text inside are returned unchanged.
 */
export function normalizeToTextPosition(point: SelectionPoint): SelectionPoint {
  if (point.node.nodeType === Node.TEXT_NODE) return point;
  const children = point.node.childNodes;
  if (children.length === 0) return point;
  if (point.offset < children.length) {
    const at = edgeTextPosition(children[point.offset]!, "first");
    if (at !== null) return at;
  }
  const before = children[Math.min(point.offset, children.length) - 1];
  if (before !== undefined) {
    const at = edgeTextPosition(before, "last");
    if (at !== null) return at;
  }
  return point;
}

/**
 * Resolve a viewport point to a text position inside `root`, or `null` when
 * the point misses the root or lands in a region that refuses selection.
 */
export function pointInRoot(
  x: number,
  y: number,
  root: HTMLElement,
): SelectionPoint | null {
  const pos = caretPositionFromPointCompat(x, y);
  if (pos === null) return null;
  if (!root.contains(pos.node)) return null;
  if (!isSelectableTarget(pos.node instanceof Element ? pos.node : pos.node.parentElement)) {
    return null;
  }
  const normalized = normalizeToTextPosition({ node: pos.node, offset: pos.offset });
  if (!root.contains(normalized.node)) return null;
  return normalized;
}

// ---------------------------------------------------------------------------
// SelectionExtender
// ---------------------------------------------------------------------------

/**
 * Owns the base / extent / granularity triple for one read-only text root and
 * services the shifted gestures that extend a selection.
 *
 * Attach with {@link attachSelectionExtension}, which returns a disposer.
 */
export class SelectionExtender {
  private readonly root: HTMLElement;

  /** The fixed end of the selection, as last established by a press. */
  private base: SelectionPoint | null = null;

  /** Expansion unit inherited by every extension until a plain press resets it. */
  private granularity: SelectionGranularity = "character";

  /** True between a shifted press and its mouseup. */
  private extending = false;

  /**
   * The selection the last chord set: its base, its extent, and the column a
   * run of vertical steps holds to. The next chord continues from it while
   * the live selection is still the one it set — including when the extent
   * has come back onto the base and the selection is a caret.
   */
  private keyed: KeyedSelection | null = null;

  private readonly onMouseDown: (e: MouseEvent) => void;
  private readonly onMouseMove: (e: MouseEvent) => void;
  private readonly onMouseUp: () => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;

  constructor(root: HTMLElement) {
    this.root = root;
    this.onMouseDown = this.handleMouseDown.bind(this);
    this.onMouseMove = this.handleMouseMove.bind(this);
    this.onMouseUp = this.handleMouseUp.bind(this);
    this.onKeyDown = this.handleKeyDown.bind(this);
  }

  attach(): void {
    // Capture phase: an unshifted press must record its base before any other
    // handler moves the live selection, and a shifted press must claim the
    // gesture before the browser's own extension runs against it.
    document.addEventListener("mousedown", this.onMouseDown, { capture: true });
    document.addEventListener("mousemove", this.onMouseMove, { capture: true });
    document.addEventListener("mouseup", this.onMouseUp, { capture: true });
    // `window`, not `document`: the deck's key stages are document-level
    // capture listeners, and every one of them — the key funnel, the
    // key-view delegate that hands a key to the composer — must come after
    // a chord this extender takes.
    window.addEventListener("keydown", this.onKeyDown, { capture: true });
  }

  detach(): void {
    document.removeEventListener("mousedown", this.onMouseDown, { capture: true });
    document.removeEventListener("mousemove", this.onMouseMove, { capture: true });
    document.removeEventListener("mouseup", this.onMouseUp, { capture: true });
    window.removeEventListener("keydown", this.onKeyDown, { capture: true });
    this.extending = false;
    this.base = null;
    this.keyed = null;
  }

  /**
   * The base the next extension will pivot on.
   *
   * The recorded base wins. It is the position the user's last unshifted
   * press named, and granularity re-expansion from it is idempotent, so it
   * reproduces the same edge the live selection carries — without trusting a
   * live anchor that a restore may have normalized to the range start, or
   * that another handler may have moved out from under this gesture.
   *
   * The live anchor is the fallback for a selection this controller did not
   * originate: one restored from a saved bag, or a select-all.
   */
  private resolveBase(): SelectionPoint | null {
    if (this.base !== null && this.root.contains(this.base.node)) return this.base;
    const sel = window.getSelection();
    if (
      sel !== null &&
      sel.rangeCount > 0 &&
      !sel.isCollapsed &&
      sel.anchorNode !== null &&
      this.root.contains(sel.anchorNode)
    ) {
      return { node: sel.anchorNode, offset: sel.anchorOffset };
    }
    return null;
  }

  /**
   * Set the live selection from the current base out to `extent`, expanding
   * both ends at the current granularity. The base is passed to
   * `setBaseAndExtent` as the anchor, so the selection's direction reflects
   * which side of the base the extent landed on.
   */
  private applyExtent(extent: SelectionPoint): void {
    const base = this.resolveBase();
    if (base === null) return;
    const sel = window.getSelection();
    if (sel === null) return;

    const pair = expandPair(base, extent, this.granularity, this.root);
    try {
      sel.setBaseAndExtent(
        pair.base.node,
        pair.base.offset,
        pair.extent.node,
        pair.extent.offset,
      );
    } catch {
      // Offsets can fall out of range when content re-renders between the
      // hit test and the apply. The next gesture re-reads the live DOM.
    }
  }

  private handleMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Node) || !this.root.contains(target)) return;
    if (!isSelectableTarget(target)) return;

    const hit = pointInRoot(event.clientX, event.clientY, this.root);
    if (hit === null) return;

    // Any press in the root starts a selection the keyboard did not make.
    this.keyed = null;
    if (!event.shiftKey) {
      // Unshifted press: the browser places the selection. Record what it
      // established so a later shifted press can pivot on it.
      this.base = hit;
      this.granularity = granularityForClickCount(event.detail);
      this.extending = false;
      return;
    }

    // Shifted press: the base and granularity persist, only the extent moves.
    // A shift-double-click may raise the granularity but never lower it.
    if (event.detail > 1) {
      this.granularity = coarser(
        this.granularity,
        granularityForClickCount(event.detail),
      );
    }
    if (this.resolveBase() === null) {
      // Nothing to extend from — behave as an unshifted press.
      this.base = hit;
      this.granularity = granularityForClickCount(event.detail);
      return;
    }

    // Own the gesture: the browser's own shift handling would re-derive the
    // base from the normalized range and ignore the granularity.
    event.preventDefault();
    this.extending = true;
    this.applyExtent(hit);
  }

  private handleMouseMove(event: MouseEvent): void {
    if (!this.extending) return;
    if ((event.buttons & 1) === 0) {
      this.extending = false;
      return;
    }
    // Points outside the root are the guard's to clamp; intervening here
    // would fight its boundary pin and its autoscroll re-extend.
    const hit = pointInRoot(event.clientX, event.clientY, this.root);
    if (hit === null) return;
    event.preventDefault();
    this.applyExtent(hit);
  }

  private handleMouseUp(): void {
    this.extending = false;
  }

  /**
   * Move the extent of a read-only selection by a selection-extending chord.
   *
   * Declines — leaving the key to whoever would have had it — unless the
   * selection lies in the root (a range with both ends there, or the one the
   * last chord set, which may have collapsed onto its base) and DOM focus is
   * not inside the root (a focused control there owns its own keys).
   *
   * The base is the selection's anchor, which a drag, a press and a chord all
   * leave at the fixed end, and it is never moved: a caret takes the step
   * from the extent, and the selection is set from the base to wherever the
   * caret landed, on either side of the base. An extent the step carried out
   * of the root is pinned to the root's edge on that side: past the
   * transcript's last row is the composer, which is not part of the reader's
   * selection.
   */
  private handleKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) return;
    const extension = keyboardExtensionFor(event);
    if (extension === null) return;
    const sel = window.getSelection();
    if (sel === null || sel.rangeCount === 0) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && this.root.contains(active)) return;
    const ends = this.keyboardEnds(sel);
    if (ends === null) return;

    // A run of vertical steps holds the column it started in, as a text view
    // does; any other step lets it go.
    const vertical = extension.kind === "page" || extension.granularity === "line";
    const goalX = vertical ? (ends.goalX ?? caretRect(ends.extent)?.left ?? null) : null;

    const stepped =
      extension.kind === "modify"
        ? this.stepByModify(sel, ends.extent, extension.direction, extension.granularity, goalX)
        : this.stepByPage(ends.extent, extension.direction, goalX);
    const extent =
      stepped !== null && this.root.contains(stepped.node)
        ? stepped
        : edgeTextPosition(this.root, extension.direction === "forward" ? "last" : "first");
    try {
      const to = extent ?? ends.extent;
      sel.setBaseAndExtent(ends.base.node, ends.base.offset, to.node, to.offset);
    } catch {
      // Offsets can fall out of range when content re-renders between
      // chords. The next press re-reads the live DOM.
      this.keyed = null;
      return;
    }
    // Kept as WebKit reports it back, so the next chord recognizes it.
    this.keyed =
      sel.anchorNode !== null && sel.focusNode !== null
        ? {
            base: { node: sel.anchorNode, offset: sel.anchorOffset },
            extent: { node: sel.focusNode, offset: sel.focusOffset },
            goalX,
          }
        : null;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  /**
   * The base and extent a chord works from: the selection the last chord
   * set, while the live selection is still exactly that one — a caret
   * included, which is what a selection is when its extent has come back
   * onto its base — and otherwise a range in the root, anchor and focus.
   */
  private keyboardEnds(sel: Selection): KeyedSelection | null {
    const { anchorNode, focusNode } = sel;
    if (anchorNode === null || focusNode === null) return null;
    if (!this.root.contains(anchorNode) || !this.root.contains(focusNode)) return null;
    const keyed = this.keyed;
    if (
      keyed !== null &&
      keyed.base.node === anchorNode &&
      keyed.base.offset === sel.anchorOffset &&
      keyed.extent.node === focusNode &&
      keyed.extent.offset === sel.focusOffset
    ) {
      return keyed;
    }
    this.keyed = null;
    if (sel.isCollapsed) return null;
    return {
      base: { node: anchorNode, offset: sel.anchorOffset },
      extent: { node: focusNode, offset: sel.focusOffset },
      goalX: null,
    };
  }

  /**
   * Where one `Selection.modify` step takes a caret placed at `from`. A
   * vertical step is put back on the run's column, which `modify` loses: it
   * starts each step from the caret's own column, and a short line pulls
   * that in.
   */
  private stepByModify(
    sel: Selection,
    from: SelectionPoint,
    direction: ExpandDirection,
    granularity: ModifyGranularity,
    goalX: number | null,
  ): SelectionPoint | null {
    try {
      sel.collapse(from.node, from.offset);
    } catch {
      return null;
    }
    sel.modify("move", direction, granularity);
    if (sel.focusNode === null) return null;
    const moved: SelectionPoint = { node: sel.focusNode, offset: sel.focusOffset };
    if (granularity !== "line" || goalX === null || !this.root.contains(moved.node)) return moved;
    const rect = caretRect(moved);
    if (rect === null) return moved;
    return pointInRoot(goalX, rect.top + rect.height / 2, this.root) ?? moved;
  }

  /**
   * Where a page step takes the extent: the position a page height above or
   * below it, at the run's column, hit-tested inside the root — or `null`
   * when that point falls outside the root, which pins the extent to the
   * root's edge.
   */
  private stepByPage(
    from: SelectionPoint,
    direction: ExpandDirection,
    goalX: number | null,
  ): SelectionPoint | null {
    const at = caretRect(from);
    if (at === null) return null;
    const bounds = this.root.getBoundingClientRect();
    const page = Math.min(bounds.height, window.innerHeight);
    const y = direction === "forward" ? at.top + page : at.top - page;
    const inView = y > Math.max(bounds.top, 0) && y < Math.min(bounds.bottom, window.innerHeight);
    return inView ? pointInRoot(goalX ?? at.left, y, this.root) : null;
  }
}

/**
 * Attach base/extent selection extension to a read-only text root.
 * Returns a disposer that removes every listener.
 */
export function attachSelectionExtension(root: HTMLElement): () => void {
  const extender = new SelectionExtender(root);
  extender.attach();
  return () => extender.detach();
}

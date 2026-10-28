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
 * root, through `Selection.modify("extend", …)`, whatever holds DOM focus.
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
   * Extend a ranged selection inside the root by a selection-extending chord.
   *
   * Declines — leaving the key to whoever would have had it — unless the
   * selection is a range with both ends in the root and DOM focus is not
   * inside the root (a focused control there owns its own keys). The base is
   * the selection's anchor, which every gesture this controller or the
   * browser made leaves at the fixed end, so `modify("extend", …)` moves only
   * the extent. An extent the step carried out of the root is pinned to the
   * root's edge on that side: past the transcript's last row is the
   * composer, which is not part of the reader's selection.
   */
  private handleKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) return;
    const extension = keyboardExtensionFor(event);
    if (extension === null) return;
    const sel = window.getSelection();
    if (
      sel === null ||
      sel.rangeCount === 0 ||
      sel.isCollapsed ||
      sel.anchorNode === null ||
      sel.focusNode === null ||
      !this.root.contains(sel.anchorNode) ||
      !this.root.contains(sel.focusNode)
    ) {
      return;
    }
    const active = document.activeElement;
    if (active !== null && active !== document.body && this.root.contains(active)) return;

    if (extension.kind === "modify") {
      sel.modify("extend", extension.direction, extension.granularity);
    } else {
      this.extendByPage(sel, extension.direction);
    }
    if (sel.focusNode === null || !this.root.contains(sel.focusNode)) {
      const edge = edgeTextPosition(
        this.root,
        extension.direction === "forward" ? "last" : "first",
      );
      if (edge !== null) sel.extend(edge.node, edge.offset);
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  /**
   * Move the extent one visible page: the position a page height above or
   * below the extent's caret, hit-tested inside the root, or the root's edge
   * when that point falls outside it.
   */
  private extendByPage(sel: Selection, direction: ExpandDirection): void {
    const focus = sel.focusNode;
    if (focus === null) return;
    const caret = document.createRange();
    caret.setStart(focus, sel.focusOffset);
    caret.collapse(true);
    const at = caret.getBoundingClientRect();
    const bounds = this.root.getBoundingClientRect();
    const page = Math.min(bounds.height, window.innerHeight);
    const y = direction === "forward" ? at.top + page : at.top - page;
    const hit =
      y > Math.max(bounds.top, 0) && y < Math.min(bounds.bottom, window.innerHeight)
        ? pointInRoot(at.left, y, this.root)
        : null;
    const target = hit ?? edgeTextPosition(this.root, direction === "forward" ? "last" : "first");
    if (target !== null) sel.extend(target.node, target.offset);
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

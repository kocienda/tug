/**
 * transcript-find-highlighter — the imperative Custom-Highlight painter for the
 * Session card's Find route.
 *
 * The authoritative match set lives in the `FindSession` + `TranscriptFind
 * Engine` (computed over the whole-transcript index). This painter is the
 * *appearance* half ([L06]): it
 * resolves DOM Ranges for the handful of currently-mounted rows and paints them
 * via the CSS Custom Highlight API — the same mechanism `selection-guard` uses
 * for inactive selection — which is the only way to tint ranges uniformly
 * across the transcript's markdown DOM (a virtualized custom list, not one
 * editor). No React state drives any of this.
 *
 * Two registered highlights: `transcript-find-match` (every mounted match) and
 * `transcript-find-active` (the active one, painted with the stronger
 * find-active surface). `CSS.highlights` is a document-global registry, so the
 * two names are registered ONCE — one `Highlight` object each, shared by every
 * card in the document — and never deleted. A painter owns only the ranges it
 * added and retracts exactly those; it never clears a shared object. That is
 * what lets two Session cards hold find paint at the same time, and what stops
 * a repaint in one card from erasing the other's.
 *
 * **Searchability is opt-in and symmetric.** The painter walks ONLY subtrees
 * marked `data-tugx-findable` — the same containers the index projects, one
 * search unit per container, in DOM order. Within a marked container,
 * `.tugx-katex` (math renders the LaTeX source as hidden text),
 * `.tug-atom-chip-host` (atom chips render their label inside an SVG) and
 * `.tugx-md-chrome-header` (the header the markdown enhancers build over a
 * fenced code block or a table — a language badge and two buttons, none of
 * it in the parsed HTML) subtrees are excluded, as is anything under
 * `data-tugx-find-hidden` (mounted but not visible). A collapsed tool block
 * needs no guard: its body is unmounted, so the only marked containers left
 * in it are its header's name and target — exactly what the index projects
 * for it. Unmarked text — badges, result summaries, the live timing clock —
 * can never paint, so a future body kind is unsearchable until it is
 * deliberately marked AND projected.
 * **Adding a searchable kind is a three-sided checklist:** stamp the marker
 * on the content container, project the same text (same order) in
 * `transcript-search-index.ts`, and add a row carrying that kind to
 * `tests/app-test/find-fidelity-fixture.ts`, which `at0602` sweeps.
 *
 * **A match is an ADDRESS, and this paints it ([P02]).** The painter does
 * not search: it takes each match's `(row, segment, start, end)` and builds
 * the Range at exactly those offsets, over exactly the node list the index
 * counted. Re-running the matcher here and pairing hits off by ordinal was
 * the old way, and it was a second opinion pretending to be a lookup — when
 * the two texts disagreed, the k-th DOM hit was simply not the k-th index
 * hit, and the highlight landed somewhere nobody could explain.
 *
 * What makes the offsets trustworthy is the step before the paint: every
 * mounted row's live text is compared against its projection, and where
 * they disagree **the DOM wins** ([P03]) — the host heals the engine's
 * index from the DOM's own text, the engine re-searches synchronously, and
 * the paint proceeds over addresses the DOM agrees with. A row's `dom`
 * segments correspond one-to-one, in order, with its findable containers,
 * which is what lets a match's segment index name a container.
 *
 * The landing flash is a one-shot **accent ring drawn over the active match's
 * rect only** (an absolutely-positioned child of the transcript scroller, in
 * content coordinates — clipped by the card and scrolling with the content),
 * never the whole row — a large response must not wash the transcript.
 * `paint` and `flashActive` are separate because the ring is drawn in
 * content coordinates and the reveal is still moving them: the host paints
 * as each row mounts, and draws the ring only from `TugListView.revealRange`'s
 * `onSettle`, once that reveal has landed ([P07]).
 *
 * @module components/tugways/transcript-find-highlighter
 */

import {
  type FindOptions,
  type RowSegment,
  type SegmentedFindMatch,
} from "@/lib/transcript-search";
import { findTrace, sampleAround } from "@/lib/find-trace";
import type { EditorView } from "@codemirror/view";
import type { FindTargetRegistry } from "@/components/tugways/blocks/find-target-registry";
import { placeFindFlash, type FindFlashHandle } from "@/components/tugways/find-flash";

/** The opt-in searchable-content marker attribute (present/absent, no value). */
export const FINDABLE_ATTR = "data-tugx-findable";

/**
 * The "mounted but not visible" marker. A marked container under an
 * element carrying it is skipped entirely — the same way a collapsed tool
 * block's unmounted body contributes nothing. It exists for the surfaces
 * that keep hidden content in the DOM: the thinking block's clipped body
 * while collapsed, and its one-line preview while expanded. Find must
 * never count or paint text the reader cannot see.
 */
export const FIND_HIDDEN_ATTR = "data-tugx-find-hidden";

const MATCH_HIGHLIGHT = "transcript-find-match";
const ACTIVE_HIGHLIGHT = "transcript-find-active";

/**
 * Stamped on the collapsed-header clamp that holds the ACTIVE match, and
 * nowhere else. A collapsed tool header clamps its command to a few lines
 * (`tool-call-header-clamp`), but the text past the clamp is still in the
 * DOM and still projected, so a match there is counted, addressed and
 * ranged — over glyphs the reader cannot see, at a rect that overlaps the
 * rows below. `block-header.css` lifts the clamp while this attribute is
 * present, so the header grows to show the match and shrinks back when the
 * active match moves on. Appearance through the DOM only ([L06]).
 */
const FIND_UNCLAMP_ATTR = "data-tugx-find-unclamp";
const HEADER_CLAMP_SELECTOR = ".tool-call-header-clamp";

/** What the painter needs each paint — supplied by the transcript host. */
export interface FindPaintInput {
  matches: readonly SegmentedFindMatch[];
  activeIndex: number;
  query: string;
  options: FindOptions;
  /** Resolve a row's mounted DOM element, or `null` when windowed out. */
  getElementForIndex: (index: number) => HTMLElement | null;
  /**
   * The card's find-target registry — resolves `editor`-segment keys to
   * their embedded CodeMirror delegates (and fold openers). Optional so
   * hosts without embedded editors can omit it.
   */
  findTargets?: FindTargetRegistry | null;
  /**
   * The transcript's scroll container. The flash ring is appended HERE,
   * absolutely positioned in content coordinates — so it scrolls with the
   * content, is clipped by the card's overflow, and can never paint over
   * chrome outside the scroller (the prompt entry, the status bar) or
   * detach from streaming content the way a fixed body-level overlay does.
   * Optional; without it `flashActive` is a no-op.
   */
  scroller?: HTMLElement | null;
  /**
   * The index the matches were searched over — the projection half of the
   * index/DOM comparison. The painter reads a row's segments from here and
   * checks them against the row's live DOM before painting, which is the
   * only moment both texts exist in one place.
   */
  index: readonly (readonly RowSegment[])[];
  /**
   * The list's currently-mounted contiguous row range, or `null` when the
   * host does not know one yet. The comparison sweeps exactly these rows:
   * an unmounted row has no DOM to compare against.
   */
  renderedRange: { firstIndex: number; lastIndex: number } | null;
  /** Stable row identity, for de-duplicating a divergence across paints. */
  getRowId: (index: number) => string;
  /**
   * Heal the rows whose live DOM disagreed with their projection, and hand
   * back a FRESH paint input built from the engine's new snapshot ([P03]).
   * The painter cannot heal — the index is the engine's — so this is the
   * one seam where the comparison's finding becomes a correction.
   *
   * Optional: a host that supplies none gets the compare-only behaviour,
   * and the divergences are recorded `healed: false`.
   */
  onDiverged?: (
    entries: { row: number; rowId: string; domTexts: string[] }[],
  ) => FindPaintInput;
  /** Owning card id, so a trace read can tell two searching cards apart. */
  cardId: string | null;
}

/** One place a row's projected text and its live DOM text disagree. */
export interface RowUnitDivergence {
  /** The unit's ordinal within the row, or `-1` for a `unit-count` cause. */
  unit: number;
  cause: "unit-count" | "text";
  indexUnits: number;
  domUnits: number;
  /** First differing character offset; `-1` for `unit-count`. */
  firstDiffAt: number;
  indexSample: string;
  domSample: string;
  /** Every DOM unit's text, in order — what a heal would write. */
  domTexts: string[];
}

/**
 * One side of a unit-count divergence, as a readable list: each unit's head,
 * quoted, in order, so the reader can see which unit one side has and the
 * other does not. Quoted because the interesting units are very often the
 * empty and the whitespace-only ones, which bare text renders as nothing.
 */
function unitListSample(texts: readonly string[], head = 24): string {
  return texts.map((t) => JSON.stringify(t.slice(0, head))).join(" | ");
}

/**
 * Compare one mounted row's live DOM against the segments the index
 * projected for it, and return every place they disagree (empty when they
 * agree exactly).
 *
 * The row's findable units map one-to-one onto its `dom` segments, in order
 * — `editor` segments are skipped, because an embedded CodeMirror
 * virtualizes its own DOM and this walk cannot reach it. A count mismatch is
 * reported once for the row and stops there: with the units out of
 * correspondence, per-unit texts are no longer comparable, and pairing them
 * off anyway would report a cascade of differences that are all one defect.
 *
 * **This only ever runs under a query with at least one match.** Both of the
 * host's call sites return early with `clear()` when `matches.length === 0
 * || query === ""`, so `paint()` is never reached with an empty match set,
 * and the sweep can therefore never see a row whose projection found
 * *nothing* where the DOM has something. A fixture meant to sweep every row
 * must use a query that matches in every row — a one-letter probe — or it
 * quietly narrows the sweep to the rows that happened to hit.
 */
export function compareRowUnits(
  rowEl: HTMLElement,
  segments: readonly RowSegment[],
): RowUnitDivergence[] {
  const units = collectFindableUnits(rowEl);
  const domSegments = segments.filter((s) => s.kind === "dom");
  const domTexts = units.map((unit) =>
    collectSearchableTextNodes(unit)
      .map((n) => n.data)
      .join(""),
  );
  if (units.length !== domSegments.length) {
    return [
      {
        unit: -1,
        cause: "unit-count",
        indexUnits: domSegments.length,
        domUnits: units.length,
        firstDiffAt: -1,
        // A count mismatch has no offset to sample around, so each side is
        // sampled as its LIST of units instead. Without it the report says
        // only "2 units against 3" and names neither, which is a finding
        // nobody can act on — the first `at0602` unit-count divergence cost
        // a whole run to identify for exactly that reason.
        indexSample: unitListSample(domSegments.map((s) => s.text)),
        domSample: unitListSample(domTexts),
        domTexts,
      },
    ];
  }
  const out: RowUnitDivergence[] = [];
  for (let u = 0; u < units.length; u++) {
    const domText = domTexts[u];
    const indexText = domSegments[u].text;
    if (domText === indexText) continue;
    let firstDiffAt = 0;
    const shared = Math.min(domText.length, indexText.length);
    while (firstDiffAt < shared && domText[firstDiffAt] === indexText[firstDiffAt]) {
      firstDiffAt += 1;
    }
    out.push({
      unit: u,
      cause: "text",
      indexUnits: domSegments.length,
      domUnits: units.length,
      firstDiffAt,
      indexSample: sampleAround(indexText, firstDiffAt),
      domSample: sampleAround(domText, firstDiffAt),
      domTexts,
    });
  }
  return out;
}

/**
 * True when `node` sits inside an excluded subtree WITHIN a marked container:
 *
 *  - `.tugx-katex` — math renders the LaTeX source (e.g. `\varepsilon`,
 *    which contains "are") as hidden, non-prose text.
 *  - `.tug-atom-chip-host` — atom chips render their label inside an inline
 *    SVG; the index projects atoms as no-text.
 *  - `.tugx-md-chrome-header` — the header the markdown enhancers BUILD over
 *    a fenced code block, a table, a diagram: its language badge ("ts"), its
 *    Copy and its fold cue. None of it is in `block.html`, so the projection
 *    cannot hold it; and none of it is the author's text, which is the same
 *    reason a tool header's result summary is neither marked nor projected.
 *
 * Excluding these mirrors the index so count ↔ paint stay aligned.
 */
function isInExcludedSubtree(node: Node): boolean {
  let el: HTMLElement | null = node.parentElement;
  while (el !== null) {
    if (
      el.classList.contains("tugx-katex") ||
      el.classList.contains("tug-atom-chip-host") ||
      el.classList.contains("tugx-md-chrome-header")
    ) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

/**
 * The row's searchable containers — its OUTERMOST `data-tugx-findable`
 * elements, in DOM order, minus anything hidden (`data-tugx-find-hidden`
 * on the element or an ancestor). Each is one search unit, mirroring one
 * projected part on the index side. Nested marked containers are folded
 * into their outermost ancestor so no text is walked twice.
 *
 * Exported for the other surface that paints a mark over DOM a markdown
 * pipeline built — the session row's filter mark (`filter-mark-painter.ts`).
 * It is the same walk answering the same question, and a second copy of it
 * is how the two marks would come to disagree about what "searchable" means.
 *
 * `rowEl` ITSELF counts when it carries the marker. A transcript row never
 * does — its marked containers are always inside it — but a caller whose
 * subject is one container hands that container in, and a walk that could
 * only see descendants would answer "nothing searchable here" about an
 * element whose whole point is that it is.
 */
export function collectFindableUnits(rowEl: HTMLElement): HTMLElement[] {
  if (rowEl.hasAttribute(FINDABLE_ATTR)) {
    return rowEl.closest(`[${FIND_HIDDEN_ATTR}]`) === null ? [rowEl] : [];
  }
  const marked = rowEl.querySelectorAll<HTMLElement>(`[${FINDABLE_ATTR}]`);
  const units: HTMLElement[] = [];
  for (const el of marked) {
    const parent = el.parentElement;
    if (parent !== null && parent.closest(`[${FINDABLE_ATTR}]`) !== null) continue;
    if (el.closest(`[${FIND_HIDDEN_ATTR}]`) !== null) continue;
    units.push(el);
  }
  return units;
}

/** The searchable text nodes of one unit, in order, skipping excluded subtrees. */
export function collectSearchableTextNodes(el: HTMLElement): Text[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      isInExcludedSubtree(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  let node = walker.nextNode() as Text | null;
  while (node !== null) {
    nodes.push(node);
    node = walker.nextNode() as Text | null;
  }
  return nodes;
}

/**
 * The dom ORDINAL of `segment` within its row — the position of the
 * findable container it names among the row's containers, which is what a
 * DOM walk can address. `-1` when the segment is an `editor` one (painted
 * by CodeMirror's own search) or out of range.
 */
function domOrdinalOf(
  segments: readonly RowSegment[] | undefined,
  segment: number,
): number {
  if (segments === undefined || segments[segment] === undefined) return -1;
  if (segments[segment].kind !== "dom") return -1;
  let ordinal = 0;
  for (let i = 0; i < segment; i++) {
    if (segments[i].kind === "dom") ordinal += 1;
  }
  return ordinal;
}

/**
 * Build a DOM `Range` spanning `[start, end)` over the concatenation of
 * `nodes` — the same node list (and therefore the same text) the search ran
 * over, so offsets map back exactly.
 */
export function rangeFromNodes(
  nodes: readonly Text[],
  start: number,
  end: number,
): Range | null {
  let offset = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;
  for (const node of nodes) {
    const len = node.data.length;
    if (startNode === null && start < offset + len) {
      startNode = node;
      startOffset = start - offset;
    }
    if (end <= offset + len) {
      endNode = node;
      endOffset = end - offset;
      break;
    }
    offset += len;
  }
  if (startNode === null || endNode === null) return null;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

/**
 * The document's one pair of `Highlight` objects, created and registered on
 * first use. They are never removed from `CSS.highlights`: an empty highlight
 * paints nothing, so there is nothing to clean up, and a name that outlives a
 * card is a name the next card does not have to reclaim.
 */
let sharedPair: { match: Highlight; active: Highlight } | null = null;

function sharedHighlights(): { match: Highlight; active: Highlight } | null {
  if (typeof CSS === "undefined" || CSS.highlights === undefined) return null;
  if (sharedPair === null) {
    sharedPair = { match: new Highlight(), active: new Highlight() };
    CSS.highlights.set(MATCH_HIGHLIGHT, sharedPair.match);
    CSS.highlights.set(ACTIVE_HIGHLIGHT, sharedPair.active);
  }
  return sharedPair;
}

export class TranscriptFindHighlighter {
  // The ranges THIS card contributed to each shared highlight. The objects
  // themselves belong to the document, so a card's paint and its clear both
  // go through `retract()`, which removes these and nothing else.
  private readonly ownMatch = new Set<Range>();
  private readonly ownActive = new Set<Range>();
  private activeRange: Range | null = null;
  // The registry key of the active EDITOR match, when the active match
  // lives inside an embedded CodeMirror rather than the DOM walk. Its
  // reveal geometry comes from the editor's own selection, not a Range.
  private activeEditorKey: string | null = null;
  private flash: FindFlashHandle | null = null;
  // The header clamp currently lifted for the active match, if any.
  private unclamped: HTMLElement | null = null;
  // Editor delegates driven by the LAST paint, so a later paint (or clear)
  // can retract the in-editor highlights of editors that dropped out.
  private touchedEditors = new Set<string>();
  private lastFindTargets: FindTargetRegistry | null = null;
  // The scroll container from the last paint — the flash ring's parent.
  private scroller: HTMLElement | null = null;
  // Divergences already recorded, keyed by `(rowId, unit, DOM text length,
  // index text length)`. A diverging row that stays mounted is painted on
  // every windowing commit and every keystroke; without this the ring would
  // fill with one row's single defect and drop the evidence of every other.
  // The key carries the two lengths so a row whose text CHANGES — a
  // streaming response re-projecting on each token — still records the new
  // disagreement rather than being silenced by the old one.
  private readonly recordedDivergences = new Set<string>();

  /** Remove every range this card added from the shared highlights. */
  private retract(): void {
    const pair = sharedHighlights();
    if (pair !== null) {
      for (const range of this.ownMatch) pair.match.delete(range);
      for (const range of this.ownActive) pair.active.delete(range);
    }
    this.ownMatch.clear();
    this.ownActive.clear();
  }

  /**
   * Lift the collapsed-header clamp around the active match, and restore
   * the one lifted for the previous active match. Runs inside `paint`, so
   * the reveal that measures the rect next measures the unclamped layout.
   */
  private liftClampFor(range: Range | null): void {
    const clamp =
      range?.startContainer.parentElement?.closest<HTMLElement>(
        HEADER_CLAMP_SELECTOR,
      ) ?? null;
    if (clamp === this.unclamped) {
      // A re-render may have replaced the attribute's element wholesale.
      if (clamp !== null && !clamp.hasAttribute(FIND_UNCLAMP_ATTR)) {
        clamp.setAttribute(FIND_UNCLAMP_ATTR, "");
      }
      return;
    }
    this.unclamped?.removeAttribute(FIND_UNCLAMP_ATTR);
    clamp?.setAttribute(FIND_UNCLAMP_ATTR, "");
    this.unclamped = clamp;
  }

  /** Repaint every mounted match and mark the active one. Does not flash. */
  paint(given: FindPaintInput): void {
    const pair = sharedHighlights();
    if (pair === null) return;
    const matchHL = pair.match;
    const activeHL = pair.active;

    this.retract();
    this.activeRange = null;
    this.activeEditorKey = null;
    this.scroller = given.scroller ?? null;

    // Compare first, heal second, paint third. The comparison is the only
    // moment both texts exist in one place, and a paint that ran before it
    // would be painting the addresses the heal is about to correct.
    let input = given;
    if (input.query !== "") {
      const diverged = this.recordDivergences(input);
      if (diverged.length > 0 && input.onDiverged !== undefined) {
        input = input.onDiverged(diverged);
        this.scroller = input.scroller ?? null;
      }
    }
    const { matches, activeIndex, query, options, getElementForIndex } = input;
    if (matches.length === 0 || query === "") return;

    const activeMatch = activeIndex >= 0 ? matches[activeIndex] : undefined;

    // Each row's findable containers and their text nodes, resolved once
    // and shared by every match addressed into them.
    const unitsByRow = new Map<number, HTMLElement[]>();
    const nodesByUnit = new Map<string, Text[]>();
    for (const m of matches) {
      if (m.segmentKind !== "dom") continue;
      const el = getElementForIndex(m.row);
      if (el === null) continue;
      let units = unitsByRow.get(m.row);
      if (units === undefined) {
        units = collectFindableUnits(el);
        unitsByRow.set(m.row, units);
      }
      // A match's `segment` indexes the row's FULL segment list, editor
      // segments included; the walk only ever saw the `dom` ones, so the
      // container is at the segment's dom ORDINAL.
      const ordinal = domOrdinalOf(input.index[m.row], m.segment);
      const unit = ordinal < 0 ? undefined : units[ordinal];
      if (unit === undefined) continue;
      const cacheKey = `${m.row}:${ordinal}`;
      let nodes = nodesByUnit.get(cacheKey);
      if (nodes === undefined) {
        nodes = collectSearchableTextNodes(unit);
        nodesByUnit.set(cacheKey, nodes);
      }
      const range = rangeFromNodes(nodes, m.start, m.end);
      if (range === null) {
        // After a clean comparison this cannot happen: the offsets came
        // from text the DOM agreed with. Record it rather than dropping
        // it, so an address the DOM cannot hold is never silent.
        this.recordUnrangeable(input, m.row, ordinal);
        continue;
      }
      // Each match lands in exactly ONE highlight — the active match in
      // the active highlight only, never both, so its colour doesn't
      // composite the match + active tints into a muddier blend.
      if (m === activeMatch) {
        activeHL.add(range);
        this.ownActive.add(range);
        this.activeRange = range;
        this.liftClampFor(range);
      } else {
        matchHL.add(range);
        this.ownMatch.add(range);
      }
    }

    // No DOM-walk active match this paint (unmounted, or an editor match):
    // whatever clamp the last one lifted goes back.
    if (this.activeRange === null) this.liftClampFor(null);

    // Editor segments: matches inside embedded CodeMirror editors are
    // painted by the editor's OWN search (CM6 virtualizes its DOM, so the
    // walk above cannot reach them). Drive each mounted editor's delegate
    // with the same query/options; the active editor match is selected so
    // it wears `.cm-searchMatch-selected` and reveals — the transcript-level
    // ring flash is not used inside editors.
    const findTargets = input.findTargets ?? null;
    this.lastFindTargets = findTargets;
    const nowTouched = new Set<string>();
    if (findTargets !== null) {
      const editorKeys = new Set<string>();
      for (const m of matches) {
        if (m.segmentKind === "editor" && m.segmentKey !== undefined) {
          editorKeys.add(m.segmentKey);
        }
      }
      for (const key of editorKeys) {
        const delegate = findTargets.resolve(key)?.codeView?.() ?? null;
        if (delegate === null) continue;
        delegate.setSearchQuery({
          search: query,
          caseSensitive: options.caseSensitive,
          regexp: options.grep,
          wholeWord: options.wholeWord,
        });
        nowTouched.add(key);
        if (
          activeMatch !== undefined &&
          activeMatch.segmentKind === "editor" &&
          activeMatch.segmentKey === key
        ) {
          const ordinal = matches
            .filter(
              (m) => m.segmentKind === "editor" && m.segmentKey === key,
            )
            .indexOf(activeMatch);
          delegate.selectMatch(ordinal);
          this.activeEditorKey = key;
        }
      }
      // Retract highlights from editors that no longer hold matches.
      for (const key of this.touchedEditors) {
        if (!nowTouched.has(key)) {
          findTargets.resolve(key)?.codeView?.()?.clearSearch();
        }
      }
    }
    this.touchedEditors = nowTouched;
  }

  /**
   * Compare every mounted row's projection against its live DOM and record
   * each disagreement to the find trace, returning one entry per diverging
   * row — the DOM's own text for every unit, which is what a heal writes.
   *
   * The trace record is de-duplicated per `(rowId, unit, both lengths)` so
   * one stubborn row cannot fill the ring; the RETURN is not, because the
   * heal has to see a row the trace has already mentioned. In practice it
   * only happens once anyway: the healed row's text is its DOM text, so
   * the next comparison finds them equal.
   */
  private recordDivergences(
    input: FindPaintInput,
  ): { row: number; rowId: string; domTexts: string[] }[] {
    const { renderedRange, index, getRowId, cardId, getElementForIndex } = input;
    const healing = input.onDiverged !== undefined;
    const out: { row: number; rowId: string; domTexts: string[] }[] = [];
    if (renderedRange === null) return out;
    const last = Math.min(renderedRange.lastIndex, index.length - 1);
    for (let row = renderedRange.firstIndex; row <= last; row++) {
      if (row < 0) continue;
      const el = getElementForIndex(row);
      if (el === null) continue;
      const segments = index[row];
      if (segments === undefined) continue;
      const divergences = compareRowUnits(el, segments);
      if (divergences.length === 0) continue;
      const rowId = getRowId(row);
      out.push({ row, rowId, domTexts: divergences[0].domTexts });
      const domSegments = segments.filter((s) => s.kind === "dom");
      for (const d of divergences) {
        const domLen = d.unit >= 0 ? (d.domTexts[d.unit]?.length ?? -1) : d.domUnits;
        const indexLen =
          d.unit >= 0 ? (domSegments[d.unit]?.text.length ?? -1) : d.indexUnits;
        const key = `${rowId}|${d.unit}|${domLen}|${indexLen}`;
        if (this.recordedDivergences.has(key)) continue;
        this.recordedDivergences.add(key);
        findTrace.record({
          kind: "divergence",
          cardId,
          row,
          unit: d.unit,
          cause: d.cause,
          indexUnits: d.indexUnits,
          domUnits: d.domUnits,
          firstDiffAt: d.firstDiffAt,
          indexSample: d.indexSample,
          domSample: d.domSample,
          healed: healing,
        });
      }
    }
    return out;
  }

  /**
   * An address the DOM could not hold. Recorded as a `text` divergence
   * with no offset, because the row compared clean and then refused the
   * offsets anyway — which is a defect in the correspondence, not in the
   * text, and must not be swallowed by a `continue`.
   */
  private recordUnrangeable(
    input: FindPaintInput,
    row: number,
    unit: number,
  ): void {
    const key = `${input.getRowId(row)}|${unit}|unrangeable`;
    if (this.recordedDivergences.has(key)) return;
    this.recordedDivergences.add(key);
    findTrace.record({
      kind: "divergence",
      cardId: input.cardId,
      row,
      unit,
      cause: "text",
      indexUnits: -1,
      domUnits: -1,
      firstDiffAt: -1,
      indexSample: "",
      domSample: "",
      healed: false,
    });
  }

  /**
   * Viewport rect of the active match's range, or `null` when there is none /
   * it is not currently mounted. Used by the host to reveal the active match
   * clear of sticky chrome before flashing.
   */
  activeRangeRect(): DOMRect | null {
    if (this.activeRange === null) return null;
    let rect = this.activeRange.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      // A mounted row that is off-screen is `content-visibility: auto`
      // skipped, and a skipped subtree whose style has been touched — the
      // unclamp attribute above is such a touch — measures as empty until it
      // is next rendered. But it is rendered only once it is scrolled to,
      // and the reveal scrolls only to a rect: measure with skipping off for
      // the length of this one read. Synchronous and restored before any
      // paint, so nothing is shown and no observer sees a size change.
      const cell =
        this.activeRange.startContainer.parentElement?.closest<HTMLElement>(
          "[data-tug-list-cell-index]",
        ) ?? null;
      if (cell !== null && this.activeRange.startContainer.isConnected) {
        const prior = cell.style.contentVisibility;
        cell.style.contentVisibility = "visible";
        rect = this.activeRange.getBoundingClientRect();
        cell.style.contentVisibility = prior;
      }
    }
    if (rect.width === 0 && rect.height === 0) return null;
    // A rect is only an answer if its glyphs can be seen. Text clipped away
    // by an ancestor between the match and the scroller (a clamp, a folded
    // box) still ranges to a real rect — one that overlaps whatever is laid
    // out below the clip. Reporting it would let the reveal "land" on, and
    // the ring be drawn over, a spot that holds none of the match.
    //
    // The walk stops at the row's own cell. Above it sits the list's
    // scrolling box, and a mounted row that is merely off-screen is outside
    // THAT by definition — which is the reveal's job to fix, not a reason
    // to withhold the rect it needs to fix it.
    let el = this.activeRange.startContainer.parentElement;
    while (
      el !== null &&
      el !== this.scroller &&
      !el.hasAttribute("data-tug-list-cell-index")
    ) {
      const style = getComputedStyle(el);
      // Vertical only: a long line panned out of a horizontally scrolling
      // code block is a different question, and one the reveal has no
      // answer for yet.
      // Only a box can clip: `overflow` does not apply to an inline or a
      // `display: contents` element, whatever its computed value says, and
      // such an element reports an empty rect that would fail every match.
      if (
        style.overflowY !== "visible" &&
        style.display !== "inline" &&
        style.display !== "contents"
      ) {
        const box = el.getBoundingClientRect();
        if (
          box.height > 0 &&
          (rect.bottom <= box.top || rect.top >= box.bottom)
        ) {
          return null;
        }
      }
      el = el.parentElement;
    }
    return rect;
  }

  /**
   * The element containing the active match's range start, or `null` when
   * there is none. The host reads the entry-scoped `--tugx-pin-stack-top`
   * from here — the pin stack is written per transcript ENTRY (live header
   * height), so only an element inside the entry computes the real value.
   */
  activeRangeElement(): HTMLElement | null {
    return this.activeRange?.startContainer.parentElement ?? null;
  }

  /**
   * Viewport rect of the active match WHEREVER it lives — the DOM-walk
   * Range, or, when the active match is an `editor` segment, the embedded
   * editor's own selection. CM6 reveals the selected match inside its own
   * scroller, which says nothing about where that scroller sits in the
   * transcript; the host still owes the match a place in the visible band,
   * and cannot compute one without this rect.
   *
   * The editor rect is reported only once the editor's inner reveal has
   * actually put the selection inside its scrollport — before that the
   * coordinates describe a line the user cannot see, and revealing to them
   * would settle the transcript on the wrong place. `null` then means
   * "not yet", which is what the caller's retry is for.
   */
  activeMatchRect(): DOMRect | null {
    return this.activeRangeRect() ?? this.activeEditorRect();
  }

  /** The element the reveal reads the entry-scoped pin stack from. */
  activeMatchElement(): HTMLElement | null {
    return this.activeRangeElement() ?? this.activeEditorView()?.dom ?? null;
  }

  /**
   * Run `cb` once the active `editor` match's embedded view has finished
   * its own measure pass — the moment CM6's inner scroll has landed and
   * {@link activeMatchRect} can finally answer. The transcript's reveal is
   * waiting on geometry the list view cannot observe, and this is how it
   * learns to ask again. Returns `false` when there is no active editor
   * view (no embedded match, or the editor is not mounted), so the caller
   * knows no callback is coming.
   */
  afterActiveEditorMeasure(cb: () => void): boolean {
    const view = this.activeEditorView();
    if (view === null) return false;
    view.requestMeasure({ read: () => cb() });
    return true;
  }

  private activeEditorView(): EditorView | null {
    const key = this.activeEditorKey;
    if (key === null || this.lastFindTargets === null) return null;
    return this.lastFindTargets.resolve(key)?.codeView?.()?.view() ?? null;
  }

  private activeEditorRect(): DOMRect | null {
    const view = this.activeEditorView();
    if (view === null) return null;
    const { from, to } = view.state.selection.main;
    const start = view.coordsAtPos(from);
    if (start === null) return null;
    const end = view.coordsAtPos(to, -1) ?? start;
    const top = Math.min(start.top, end.top);
    const bottom = Math.max(start.bottom, end.bottom);
    const left = Math.min(start.left, end.left);
    const right = Math.max(start.right, end.right);
    // Clipped to the editor's own scrollport: a selection CM6 has not
    // finished revealing resolves to coordinates outside it.
    const port = view.scrollDOM.getBoundingClientRect();
    if (bottom <= port.top || top >= port.bottom) return null;
    return new DOMRect(left, top, right - left, bottom - top);
  }

  /**
   * One-shot accent-ring flash over the active match's rect only — an
   * absolutely-positioned child of the transcript scroller, placed in
   * content coordinates so it scrolls with the content and is clipped by
   * the card's overflow. Call after the host has settled any reveal scroll.
   * Skipped entirely when the rect lies outside the scroller's visible box
   * (a match that could not be revealed must not ring over chrome).
   */
  flashActive(): void {
    const scroller = this.scroller;
    if (scroller === null) return;
    const rect = this.activeRangeRect();
    if (rect === null) return;
    this.removeFlashOverlay();
    this.flash = placeFindFlash(scroller, rect);
  }

  private removeFlashOverlay(): void {
    this.flash?.remove();
    this.flash = null;
  }

  /** Drop all paint (empty query / leaving Find). */
  clear(): void {
    this.retract();
    this.activeRange = null;
    this.activeEditorKey = null;
    this.liftClampFor(null);
    if (this.lastFindTargets !== null) {
      for (const key of this.touchedEditors) {
        this.lastFindTargets.resolve(key)?.codeView?.()?.clearSearch();
      }
    }
    this.touchedEditors = new Set();
    // Leaving find ends the sweep's memory with it: the next search is a
    // fresh question, and a row that diverged under the last query should
    // say so again under this one.
    this.recordedDivergences.clear();
    this.removeFlashOverlay();
  }

  dispose(): void {
    this.clear();
  }
}

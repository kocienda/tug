/**
 * `render-incremental.ts` — incremental streaming-markdown reconciler.
 *
 * Replaces the rebuild-everything pattern in `tug-markdown-block.tsx`'s
 * streaming path with a per-block diff that mutates only what changed.
 * The driving requirement is preservation of *DOM element identity* for
 * blocks that did not change between renders: browser scroll anchoring
 * (`overflow-anchor: auto`) anchors on a specific element near the top
 * of the viewport, and any rebuild that destroys that element causes
 * the browser to pick a fresh anchor — visible as the transcript
 * snapping back to the top on every streaming delta. By keeping the
 * `.tugx-md-block` wrappers for the stable prefix unchanged across
 * renders, the anchor candidate persists and the scroll position holds.
 *
 * **Two layers, separately testable.**
 *
 *  1. `planReconcile` — pure logic. Given the previous render's
 *     per-block content hashes and the new render's hashes, returns a
 *     `ReconcilePlan` describing the four index ranges (stable,
 *     update-in-place, append, remove). No DOM. No state. Exhaustively
 *     unit-tested.
 *
 *  2. `renderIncremental` — DOM-mutating wrapper. Parses the new text,
 *     recovers the previous render's hashes from the container's own
 *     children (`data-content-hash`), calls `planReconcile`, then
 *     applies the plan in place. The DOM is the diff's sole source of
 *     truth: there is no carried-over state for a module reload or a
 *     strict-mode remount to desynchronize, so a wiped module-level
 *     cache can never cause a duplicate-append on top of children that
 *     are already on screen. HMR-vetted (no fake-DOM render tests per
 *     project policy).
 *
 * **Hash source.** Per-block FNV-1a 64-bit hashes computed in Rust
 * during the `lex_blocks` pass and surfaced on
 * `SanitizedMarkdownBlock.contentHash` (see [#step-18-8] commit 1/3).
 * Hashing the source byte range (not the rendered HTML) is correct
 * because `pulldown-cmark` is deterministic — same source range, same
 * parser options, same HTML output.
 *
 * **Cross-block features (footnotes, reference links).** A footnote
 * definition added later in the document changes the rendered HTML of
 * an earlier reference, but the reference's source byte range is
 * unchanged. Source-range hashing therefore classifies the earlier
 * block as stable and the reconciler skips it, leaving stale HTML in
 * place until the user interacts. Acceptable trade-off for the
 * streaming-markdown case (footnotes are rare in tool-generated
 * output); a future enhancement could hash the rendered HTML for
 * stronger correctness at a small Rust-side cost.
 *
 * Laws:
 *  - [L02] no React state; the reconciler is invoked from the same
 *    `useLayoutEffect` that owns the streaming subscription.
 *  - [L06] DOM mutations only; no React rerender per delta.
 *  - [L19] file pair (this `.ts` + a sibling test file), module
 *    docstring, exported types.
 *  - [L22] streaming subscription writes DOM imperatively via this
 *    helper; React's render cycle is bypassed for per-delta updates.
 *  - [L23] preserves user-visible scroll position by preserving the
 *    DOM element identity that browser scroll anchoring depends on.
 *
 * @module lib/markdown/render-incremental
 */

import { annotateContent } from "@/lib/annotator/annotate-content";
import type { AnnotationContext } from "@/lib/annotator/types";
import { DEFAULT_BLOCK_TRANSFORMERS } from "./block-transformers";
import { enhanceFencedCode, type FenceHighlightOptions } from "./enhance-fenced-code";
import { enhanceImg } from "./enhance-img";
import { enhanceMath } from "./enhance-math";
import { enhanceMermaid } from "./enhance-mermaid";
import { enhanceTable } from "./enhance-table";
import {
  parseMarkdownToSanitizedBlocks,
  type ParseMarkdownOptions,
  type SanitizedMarkdownBlock,
} from "./parse-markdown-to-sanitized-blocks";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * State the reconciler caches between renders. The consumer should
 * keep one `RenderState` per container — typically via a
 * `WeakMap<HTMLElement, RenderState>` — and pass the previous result
 * back to {@link renderIncremental} on the next call.
 */
export interface RenderState {
  /** Per-block content hashes from the most recent render, in document order. */
  readonly hashes: ReadonlyArray<bigint>;
  /**
   * Per-block kinds from the most recent render. Carried for
   * debuggability and as a forward-looking heuristic surface; not
   * used by the reconciler today.
   */
  readonly kinds: ReadonlyArray<string>;
}

/**
 * Index-range plan for one reconciliation pass. Indexes refer to the
 * **new** block list (so `stableCount + updateCount` is the count of
 * positions covered by both lists, and `appendCount` extends beyond
 * the previous length).
 *
 * Invariants the reconciler preserves:
 *   - `stableCount + updateCount === min(prev.length, new.length)`
 *   - `appendCount === max(0, new.length - prev.length)`
 *   - `removeCount === max(0, prev.length - new.length)`
 *   - At least one of `appendCount` and `removeCount` is zero.
 */
export interface ReconcilePlan {
  /** Leading blocks whose hash matched at every index — DOM untouched. */
  stableCount: number;
  /** Following blocks at matching indices whose hashes diverged — innerHTML rewrite. */
  updateCount: number;
  /** Blocks beyond the previous length — append fresh wrappers. */
  appendCount: number;
  /** Trailing blocks past the new length — remove existing wrappers. */
  removeCount: number;
}

/**
 * Options for {@link renderIncremental}: the markdown parse options plus
 * the optional annotation context. Every render is annotated for the
 * state-free entity kinds (URLs, email addresses); supplying a context
 * opts this consumer into the kinds that need live session state, such as
 * the transcript's clickable command spans (see `lib/annotator`).
 */
export interface RenderIncrementalOptions extends ParseMarkdownOptions {
  annotation?: AnnotationContext;
}

/** Outcome of one {@link renderIncremental} call. */
export interface RenderResult {
  /** New state — pass this back on the next call to {@link renderIncremental}. */
  state: RenderState;
  /** Plan that was applied. Useful for instrumentation / tests. */
  plan: ReconcilePlan;
}

// ---------------------------------------------------------------------------
// Pure-logic core — exported for the test suite.
// ---------------------------------------------------------------------------

/**
 * Compute the {@link ReconcilePlan} that turns `prevHashes` into
 * `newHashes` with minimal DOM mutation. Pure; exhaustively tested.
 *
 * Algorithm:
 *   1. Walk both arrays from index 0 in lockstep, counting positions
 *      where the hashes match. That run is the *stable prefix* — its
 *      DOM wrappers stay byte-identical across renders, the browser's
 *      scroll-anchor element persists, and the user's scroll position
 *      is preserved.
 *   2. From the divergence point through `min(prev, new)`, the
 *      reconciler will rewrite each existing wrapper's `innerHTML`
 *      in place — same DOM node, new content. The wrapper element
 *      itself is preserved; only its children and `dataset.blockType`
 *      change.
 *   3. Beyond `prev.length`, the reconciler appends new wrappers.
 *   4. Beyond `new.length`, the reconciler removes trailing wrappers.
 */
export function planReconcile(
  prevHashes: ReadonlyArray<bigint>,
  newHashes: ReadonlyArray<bigint>,
): ReconcilePlan {
  let stableCount = 0;
  const minLen = Math.min(prevHashes.length, newHashes.length);
  while (
    stableCount < minLen &&
    prevHashes[stableCount] === newHashes[stableCount]
  ) {
    stableCount += 1;
  }
  return {
    stableCount,
    updateCount: minLen - stableCount,
    appendCount: Math.max(0, newHashes.length - prevHashes.length),
    removeCount: Math.max(0, prevHashes.length - newHashes.length),
  };
}

// ---------------------------------------------------------------------------
// DOM-mutating wrapper
// ---------------------------------------------------------------------------

/**
 * The CSS class every block wrapper carries. Shared with the static
 * `renderBlocks` path in `tug-markdown-block.tsx` so a container can
 * be migrated from one renderer to the other without restyling.
 */
const BLOCK_CLASS = "tugx-md-block";

/**
 * `data-content-hash` carries each wrapper's source-range content hash
 * on the DOM node itself, so the rendered children ARE the record of
 * the previous render. See {@link domHashes} for why the DOM, not a
 * module-level cache, is the diff's source of truth.
 */
function buildBlockElement(
  block: SanitizedMarkdownBlock,
  annotation?: AnnotationContext,
  fence?: FenceHighlightOptions,
): HTMLDivElement {
  const el = document.createElement("div");
  el.className = BLOCK_CLASS;
  el.dataset.blockType = block.type;
  el.dataset.contentHash = block.contentHash.toString();
  el.innerHTML = block.html;
  enhanceFencedCode(el, fence);
  enhanceImg(el);
  annotateContent(el, annotation);
  enhanceTable(el);
  void enhanceMath(el);
  void enhanceMermaid(el);
  return el;
}

function updateBlockElement(
  el: HTMLElement,
  block: SanitizedMarkdownBlock,
  annotation?: AnnotationContext,
  fence?: FenceHighlightOptions,
): void {
  el.dataset.blockType = block.type;
  el.dataset.contentHash = block.contentHash.toString();
  el.innerHTML = block.html;
  enhanceFencedCode(el, fence);
  enhanceImg(el);
  annotateContent(el, annotation);
  enhanceTable(el);
  void enhanceMath(el);
  void enhanceMermaid(el);
}

/**
 * Recover the previous render's per-block hashes from the DOM itself.
 * Each `.tugx-md-block` wrapper carries its source-range content hash
 * in `data-content-hash`, so the children actually on screen are the
 * authoritative record of what was last rendered — no module-level
 * cache required.
 *
 * This is the load-bearing invariant that makes the reconciler survive
 * a Vite Fast Refresh module re-evaluation (which wipes any
 * module-level `WeakMap` while React preserves the container and its
 * children) and a React strict-mode `mount → cleanup → mount` (same
 * container, children intact). In both cases the prev hashes come from
 * the children that are genuinely present, so an empty cache can no
 * longer make the diff mistake live children for nonexistent ones and
 * append a duplicate set on top of them.
 *
 * A wrapper with a missing or unparseable `data-content-hash` — e.g. a
 * block painted by an older build still on screen the instant this code
 * hot-swaps in — yields a unique negative sentinel. Real content hashes
 * are unsigned 64-bit values (always ≥ 0), so a sentinel never matches
 * a new block's hash: that block is rewritten in place, never
 * duplicated, and the count still equals the child count so the plan's
 * append/remove math stays anchored to the real DOM.
 */
function domHashes(children: ReadonlyArray<Element>): bigint[] {
  const out: bigint[] = new Array(children.length);
  for (let i = 0; i < children.length; i += 1) {
    const raw = (children[i] as HTMLElement).dataset?.contentHash;
    if (raw === undefined) {
      out[i] = -1n - BigInt(i);
      continue;
    }
    try {
      out[i] = BigInt(raw);
    } catch {
      out[i] = -1n - BigInt(i);
    }
  }
  return out;
}

/**
 * Reconcile `container`'s children against `text`'s parsed blocks,
 * mutating only what changed. The previous render's per-block hashes
 * are recovered from the container's own children ({@link domHashes}),
 * so the reconciler is stateless across calls — there is nothing for a
 * module reload or a strict-mode remount to desynchronize. Returns the
 * new {@link RenderState} for instrumentation / tests.
 *
 * Empty input clears the container and returns an empty state.
 */
export function renderIncremental(
  container: HTMLElement,
  text: string,
  options?: RenderIncrementalOptions,
): RenderResult {
  if (text === "") {
    const removeCount = container.children.length;
    container.replaceChildren();
    return {
      state: { hashes: [], kinds: [] },
      plan: { stableCount: 0, updateCount: 0, appendCount: 0, removeCount },
    };
  }

  // Default the block-transformer pass to the populated transformers
  // (math, etc.) when the caller doesn't override. A consumer that
  // wants a different list (or an empty one for raw markdown) can
  // pass `options.transformers` explicitly.
  const mergedOptions: ParseMarkdownOptions = {
    isComplete: options?.isComplete,
    transformers: options?.transformers ?? DEFAULT_BLOCK_TRANSFORMERS,
  };
  const blocks = parseMarkdownToSanitizedBlocks(text, mergedOptions);
  return renderIncrementalFromBlocks(container, blocks, options?.annotation);
}

/**
 * Apply already-parsed blocks against `container`'s children —
 * the DOM half of {@link renderIncremental}, split out so a caller
 * holding a cached parse (the render-once cache) can skip the
 * lex/parse/sanitize pass entirely and still flow through exactly
 * the same reconcile/apply machinery. Cached and uncached renders
 * therefore cannot diverge in output: they share this one apply
 * path.
 *
 * An empty `blocks` array clears the container (the parse of
 * non-empty text never yields zero blocks, but a defensive caller
 * gets the same semantics `renderIncremental` gives empty text).
 *
 * `fence` says how a fence tugcast did not highlight is highlighted; a
 * row drawn from tugcast's render passes `"idle-unless-streaming"`.
 */
export function renderIncrementalFromBlocks(
  container: HTMLElement,
  blocks: ReadonlyArray<SanitizedMarkdownBlock>,
  annotation?: AnnotationContext,
  fence?: FenceHighlightOptions,
): RenderResult {
  // Snapshot existing children once. The reconciler's contract is
  // that it owns every child of `container` (no foreign nodes); the
  // consumer (the streaming `useLayoutEffect`) is the only writer.
  const existing = Array.from(container.children) as HTMLElement[];

  if (blocks.length === 0) {
    const removeCount = existing.length;
    container.replaceChildren();
    return {
      state: { hashes: [], kinds: [] },
      plan: { stableCount: 0, updateCount: 0, appendCount: 0, removeCount },
    };
  }
  const newHashes = blocks.map((b) => b.contentHash);
  const newKinds = blocks.map((b) => b.type);
  // Previous render's hashes come from the DOM children themselves, not
  // a carried-in state object — so the diff is anchored to what is
  // actually on screen and cannot append duplicates after an HMR reload
  // or strict-mode remount wiped a module-level cache ({@link domHashes}).
  const prevHashes = domHashes(existing);
  const plan = planReconcile(prevHashes, newHashes);

  // Phase 1 — in-place updates over the divergent matching range.
  // Preserves wrapper element identity (browser scroll anchor stays
  // valid), only the wrapper's inner subtree is replaced.
  for (
    let i = plan.stableCount;
    i < plan.stableCount + plan.updateCount;
    i += 1
  ) {
    const child = existing[i];
    if (child === undefined) {
      // Defensive: state and DOM disagreed (unexpected). Treat the
      // missing slot as an append so the new content still lands.
      container.appendChild(buildBlockElement(blocks[i], annotation, fence));
      continue;
    }
    updateBlockElement(child, blocks[i], annotation, fence);
  }

  // Phase 2 — append new wrappers beyond the previous length.
  for (
    let i = prevHashes.length;
    i < prevHashes.length + plan.appendCount;
    i += 1
  ) {
    container.appendChild(buildBlockElement(blocks[i], annotation, fence));
  }

  // Phase 3 — remove trailing wrappers past the new length. Walked
  // tail-to-head so each removal doesn't shift the indices of the
  // wrappers we still need to remove.
  if (plan.removeCount > 0) {
    for (let i = existing.length - 1; i >= newHashes.length; i -= 1) {
      existing[i].remove();
    }
  }

  return {
    state: { hashes: newHashes, kinds: newKinds },
    plan,
  };
}

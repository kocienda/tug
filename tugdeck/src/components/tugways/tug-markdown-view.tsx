/**
 * TugMarkdownView — virtualized markdown rendering component.
 *
 * Renders multi-MB markdown content at 60fps by composing BlockHeightIndex
 * and RenderedBlockWindow into a React component. Only the blocks visible in
 * the viewport (plus overscan) are present in the DOM at any time.
 *
 * Lexing and parsing use pulldown-cmark compiled to WASM (tugmark-wasm).
 * All blocks are lexed and parsed synchronously on content load (~29ms for 1MB).
 * Scroll handling is pure DOM window management — zero WASM calls during scroll.
 *
 * API: imperative handle (forwardRef). Callers obtain a ref and call:
 *   ref.current.setRegion(key, text)   — insert or update a named region
 *   ref.current.removeRegion(key)      — remove a named region
 *   ref.current.clear()                — clear all regions and reset DOM
 *
 * The streaming path (streamingStore + streamingPath) calls setRegion internally
 * with the key 'stream', so streaming and imperative usage are mutually exclusive.
 *
 * Laws compliance:
 * - [L03] useLayoutEffect for static and streaming paths — block DOM and height
 *   index must be ready before scroll events fire.
 * - [L05] RAF is used ONLY for scroll coalescing (onScroll DOM event, not React
 *   state commit). Never used to commit React state.
 * - [L06] Appearance changes via CSS and DOM, never React state. Spacer heights
 *   and block visibility are managed by direct DOM writes, not React state.
 *   Every programmatic scroll-position write routes through the single
 *   `SmartScroll` instance (`scrollTo` / `pinToBottom` / `maybePinToBottom`);
 *   the component never assigns `scrollContainer.scrollTop` directly.
 * - [L07] Handlers access current state through refs, never stale closures.
 * - [L19] Component authoring guide: module docstring, exported props interface,
 *   data-slot="tug-markdown-view", file pair (tsx + css).
 * - [L22] Streaming DOM updates observe the PropertyStore directly via
 *   useLayoutEffect — no React round-trip between data change and DOM write.
 * - [D93] SmartScroll six-phase state machine (idle/tracking/dragging/settling/
 *   decelerating/programmatic). Controller-driven: doSetRegion calls
 *   pinToBottom() (idle phase) after content settles, not SmartScroll
 *   reacting to ResizeObserver.
 * - [L23] Internal operations never lose user-visible state. Scroll position
 *   is preserved across region edits. Content shrink adjusts to nearest
 *   surviving block. No DOM nuke on non-cold-start paths.
 *
 * Design decisions:
 * - [D03] HTML cache (Map<number, string>, never evicted, all blocks pre-parsed)
 * - [D04] DOMPurify at render time only
 *
 * @module components/tugways/tug-markdown-view
 */

import "./tug-markdown-block.css";
import "./tug-markdown-view.css";

import React, { useCallback, useId, useImperativeHandle, useLayoutEffect, useRef } from "react";
import {
  getDOMPurify,
  SANITIZE_CONFIG,
} from "@/lib/markdown/dompurify-instance";
import { DEFAULT_BLOCK_TRANSFORMERS } from "@/lib/markdown/block-transformers";
import { enhanceFencedCode } from "@/lib/markdown/enhance-fenced-code";
import { enhanceTable } from "@/lib/markdown/enhance-table";
import { enhanceMath } from "@/lib/markdown/enhance-math";
import { enhanceMermaid } from "@/lib/markdown/enhance-mermaid";
import {
  buildByteToCharMap,
  decodeBlocks,
  parseMarkdownToSanitizedBlocks,
} from "@/lib/markdown/parse-markdown-to-sanitized-blocks";
import { cn } from "@/lib/utils";
import { BlockHeightIndex } from "@/lib/block-height-index";
import { RenderedBlockWindow } from "@/lib/rendered-block-window";
import { RegionMap } from "@/lib/region-map";
import { SmartScroll } from "@/lib/smart-scroll";
import type { PropertyStore } from "@/components/tugways/property-store";
import { useTextSurfaceContextMenu } from "@/components/tugways/use-text-surface-context-menu";
import { useOptionalResponder } from "@/components/tugways/use-responder";
import type { ActionHandlerResult } from "@/components/tugways/responder-chain";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import {
  domSelectionDirection,
  selectionGuard,
} from "@/components/tugways/selection-guard";
import { useCardId, useCardStatePreservation } from "@/components/tugways/use-card-state-preservation";
import { copyTextFrom } from "@/lib/copy-text";
import { lex_blocks, parse_to_html } from "../../../crates/tugmark-wasm/pkg/tugmark_wasm.js";

// ---------------------------------------------------------------------------
// DOMPurify + lex/parse pipeline
// ---------------------------------------------------------------------------
//
// `getDOMPurify` and `SANITIZE_CONFIG` are imported from
// `@/lib/markdown/dompurify-instance` so the same allowlist /
// blocklist governs every markdown render path in tugdeck. The full
// lex/parse/sanitize pipeline lives in
// `parseMarkdownToSanitizedBlocks` per [D09]; this module's
// `lexParseAndRender` (the full-rebuild path) consumes that helper
// directly. The incremental update paths still call `parse_to_html`
// + `getDOMPurify().sanitize(...)` per-block since they don't re-lex
// the whole document — they patch in already-known block boundaries.
//
// Sanitization is now eager (cache stores SANITIZED HTML), reversing
// the prior "DOMPurify at render time only" pattern. The shared
// helper sanitizes during parse so `TugMarkdownBlock` (which has no
// render-time hook) sees safe HTML as it does, and so the cache
// contract is uniform between full-rebuild and incremental paths.

const LINE_HEIGHT = 24;
const CODE_LINE_HEIGHT = 20;
const CODE_HEADER_HEIGHT = 36;
const HR_HEIGHT = 33;

/**
 * Heuristic block height for the windowing engine. Accepts both the
 * char-indexed `SanitizedMarkdownBlock` produced by the full-pass
 * helper and the byte-indexed `BlockMeta` produced by the incremental
 * path's region-scoped re-lex; the discriminator picks the right
 * `rawLen` source. For ASCII content the two are identical; for
 * multi-byte text the byte length is slightly larger, which shifts
 * height estimates by a few pixels — well within the
 * `ResizeObserver`-driven correction we apply on first measure.
 */
type EstimateBlockShape =
  | { type: string; depth: number; itemCount: number; rowCount: number; startChar: number; endChar: number }
  | { type: string; depth: number; itemCount: number; rowCount: number; startByte: number; endByte: number };

function estimateBlockHeight(block: EstimateBlockShape): number {
  const rawLen = "endChar" in block
    ? block.endChar - block.startChar
    : block.endByte - block.startByte;
  switch (block.type) {
    case 'heading': return [0, 56, 48, 40, 36, 32, 28][block.depth] ?? LINE_HEIGHT * 2;
    case 'code': {
      const lineCount = Math.max(1, Math.round(rawLen / 40));
      return CODE_HEADER_HEIGHT + lineCount * CODE_LINE_HEIGHT;
    }
    case 'hr': return HR_HEIGHT;
    case 'list': return Math.max(1, block.itemCount) * LINE_HEIGHT * 1.5;
    case 'table': return (Math.max(1, block.rowCount) + 1) * LINE_HEIGHT * 1.5;
    case 'blockquote': return Math.max(1, Math.ceil(rawLen / 70)) * LINE_HEIGHT;
    default: return Math.max(1, Math.ceil(rawLen / 80)) * LINE_HEIGHT;
  }
}

// ---------------------------------------------------------------------------
// TugMarkdownViewHandle
// ---------------------------------------------------------------------------

/** Imperative handle exposed via forwardRef. */
export interface TugMarkdownViewHandle {
  /** Insert or update a named region. Appends at end if key is new. */
  setRegion(key: string, text: string): void;
  /** Remove a named region. Triggers full rebuild or clear as appropriate. */
  removeRegion(key: string): void;
  /** Clear all regions and reset the DOM. */
  clear(): void;
}

// ---------------------------------------------------------------------------
// TugMarkdownViewProps
// ---------------------------------------------------------------------------

/** Timing metrics emitted after each lex+parse pass. */
export interface TugMarkdownTimingMetrics {
  /** Time in milliseconds for the lex_blocks() WASM call. */
  lexMs: number;
  /** Time in milliseconds for all parse_to_html() WASM calls. */
  parseMs: number;
  /** Total number of blocks in the document. */
  blockCount: number;
}

export interface TugMarkdownViewProps {
  /** PropertyStore for streaming text. When set, component enters streaming mode. */
  streamingStore?: PropertyStore;
  /** PropertyStore path key for the streaming text value. Default: "text". */
  streamingPath?: string;
  /** Callback when a block enters the viewport and is measured. */
  onBlockMeasured?: (index: number, measuredHeight: number) => void;
  /** Callback with WASM timing metrics after each lex+parse pass. */
  onTiming?: (metrics: TugMarkdownTimingMetrics) => void;
  /** CSS class for the scroll container. */
  className?: string;
  /**
   * When set, opts the view into card-level selection publish.
   *
   * Subscribes to `document.selectionchange` and publishes any range
   * whose `commonAncestorContainer` is within the scroll container to
   * `selectionGuard.updateCardDomSelection(cardId, range)` (cardId is
   * read from the enclosing `CardStatePreservationContext`). The
   * card-level paint authority then carries the range through tab
   * switches, app resign/become-active, and cold-boot mount-restore
   * via `selectionGuard.restoreCardDomSelection`.
   *
   * No-op when the component is rendered outside a `CardHost`
   * (`useCardId` returns null) or when `selectionPublishKey` is
   * `undefined`.
   *
   * Implements [A5] (markdown-view selection publish) per [L23]
   * (user-visible state must round-trip).
   */
  selectionPublishKey?: string;

  /**
   * Initial value for SmartScroll's follow-bottom intent. When `true`
   * (the default), the view pins the scroll to the bottom while content
   * arrives — appropriate for streaming transcript-style consumers. When
   * `false`, the view stays at the top while content renders and only
   * follows user gestures — appropriate for static-content consumers
   * (e.g. baked-in gallery fixtures) where pinning to the bottom would
   * leave the head of the document offscreen and confuse a virtualized
   * `nodeToPath` capture (the saved path indices depend on the rendered
   * window, which is bottom-anchored under followBottom).
   */
  followBottom?: boolean;
}

// ---------------------------------------------------------------------------
// Internal state shape (non-React, lives in refs)
// ---------------------------------------------------------------------------

interface MarkdownEngineState {
  /** Ordered, keyed content regions. The source of truth for document text. */
  regionMap: RegionMap;
  /** Char-mapped start offsets per block. blockStarts[i] = JS char index. */
  blockStarts: number[];
  /** Char-mapped end offsets per block. blockEnds[i] = JS char index. */
  blockEnds: number[];
  /** The BlockHeightIndex driving the virtual layout. */
  heightIndex: BlockHeightIndex;
  /** The sliding window manager. */
  blockWindow: RenderedBlockWindow;
  /** Map from block index to the rendered DOM node. */
  blockNodes: Map<number, HTMLElement>;
  /**
   * HTML cache: block index → unsanitized HTML string.
   * DOMPurify runs at render time in addBlockNode() [D04].
   * Never evicted (content is append-only) [D03].
   * All blocks are parsed upfront on content load, so this cache is always
   * fully populated before any scroll event fires.
   */
  htmlCache: Map<number, string>;
  /** Total block count from last lex response. */
  blockCount: number;
  /**
   * Maps each region key to the block index range it produced.
   * `start` is the first block index for that region; `count` is the number
   * of blocks; `types` is the block type sequence (e.g. ['paragraph','code']).
   * The `types` array enables fence propagation to detect block type changes
   * (step 4: lazy fence propagation via D02). Populated after every full rebuild
   * in lexParseAndRender and updated incrementally by incrementalTailUpdate.
   * Cleared by doClear and at the start of every lexParseAndRender reset.
   * [D04-region-block-ranges]
   */
  regionBlockRanges: Map<string, { start: number; count: number; types: string[] }>;
}

const DEFAULT_VIEWPORT_HEIGHT = 600;

// ---------------------------------------------------------------------------
// TugMarkdownView component
// ---------------------------------------------------------------------------

/**
 * TugMarkdownView — virtualized markdown rendering component.
 *
 * Renders large markdown content with bounded DOM node count by keeping only
 * the visible viewport (plus overscan) in the DOM.
 *
 * @example
 * // Imperative rendering via ref handle:
 * const ref = useRef<TugMarkdownViewHandle>(null);
 * <TugMarkdownView ref={ref} />
 * ref.current?.setRegion('msg-1', markdownString);
 * ref.current?.removeRegion('msg-1');
 * ref.current?.clear();
 *
 * // Streaming rendering:
 * <TugMarkdownView
 *   streamingStore={store}
 *   streamingPath="text"
 * />
 */
export const TugMarkdownView = React.forwardRef<TugMarkdownViewHandle, TugMarkdownViewProps>(
  function TugMarkdownView({
    streamingStore,
    streamingPath = "text",
    onBlockMeasured,
    onTiming,
    className,
    selectionPublishKey,
    followBottom = true,
  }, ref) {
  // ---- DOM refs ----
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const topSpacerRef = useRef<HTMLDivElement>(null);
  const bottomSpacerRef = useRef<HTMLDivElement>(null);
  const blockContainerRef = useRef<HTMLDivElement>(null);

  // ---- Prop refs for stable closure access [L07] ----
  const onTimingRef = useRef(onTiming);
  onTimingRef.current = onTiming;

  // ---- SmartScroll instance ref ----
  const smartScrollRef = useRef<SmartScroll | null>(null);

  // ---- RAF coalescing refs for scroll handler [L05] ----
  const scrollDirtyRef = useRef(false);
  const scrollRafRef = useRef<number | null>(null);

  // ---- ResizeObserver for measuring rendered blocks ----
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  // ---- Engine state (mutable, lives outside React state per L06) ----
  const engineRef = useRef<MarkdownEngineState | null>(null);

  /** Initialize or get the engine state. */
  function getEngine(): MarkdownEngineState {
    if (!engineRef.current) {
      const heightIndex = new BlockHeightIndex(1024);
      const blockWindow = new RenderedBlockWindow(heightIndex, DEFAULT_VIEWPORT_HEIGHT, 2);
      engineRef.current = {
        regionMap: new RegionMap(),
        blockStarts: [],
        blockEnds: [],
        heightIndex,
        blockWindow,
        blockNodes: new Map(),
        htmlCache: new Map(),
        blockCount: 0,
        regionBlockRanges: new Map(),
      };
    }
    return engineRef.current;
  }

  // Streaming DOM updates go through the L22 store observer (useLayoutEffect below).
  // No useSyncExternalStore — the store is observed directly, not through React.

  // ---- Apply spacer heights to DOM ----
  function applySpacers(topHeight: number, bottomHeight: number) {
    if (topSpacerRef.current) {
      topSpacerRef.current.style.height = `${topHeight}px`;
    }
    if (bottomSpacerRef.current) {
      bottomSpacerRef.current.style.height = `${bottomHeight}px`;
    }
  }

  // ---- Add a single block DOM node ----
  // Cache stores SANITIZED HTML (Step 7 refactor — `parseMarkdownTo
  // SanitizedBlocks` and the incremental sanitize call sites both
  // hand DOMPurify-clean HTML to the cache). `addBlockNode` writes
  // it straight to `el.innerHTML` with no additional sanitize pass.
  // If the block is not yet in the HTML cache, skip it (no placeholder).
  //
  // Blocks are always inserted in ascending block index order so the document
  // order matches the logical block order. When a block re-enters the viewport
  // on scroll-up, we must not use appendChild (which would place it after any
  // already-present higher-index blocks). Instead, find the first existing child
  // with a higher data-block-index and insertBefore it. If none exists, pass
  // null to insertBefore which is equivalent to appendChild [Bug 1 fix].
  function addBlockNode(engine: MarkdownEngineState, index: number) {
    if (!blockContainerRef.current) return;
    if (engine.blockNodes.has(index)) return;

    const cachedHtml = engine.htmlCache.get(index);
    if (cachedHtml === undefined) {
      console.warn(`[TugMarkdownView] cache miss for block ${index} — all blocks should be pre-parsed`);
      return;
    }

    const el = document.createElement("div");
    el.className = "tugx-md-block";
    el.dataset.blockIndex = String(index);
    el.innerHTML = cachedHtml;
    enhanceFencedCode(el);
    enhanceTable(el);
    void enhanceMath(el);
    void enhanceMermaid(el);

    // Find the first child with a higher block index to insert before it.
    // This preserves ascending document order regardless of insertion sequence.
    const container = blockContainerRef.current;
    let referenceNode: ChildNode | null = null;
    for (let i = 0; i < container.childNodes.length; i++) {
      const child = container.childNodes[i] as HTMLElement;
      const childIndex = parseInt(child.dataset?.blockIndex ?? "", 10);
      if (!isNaN(childIndex) && childIndex > index) {
        referenceNode = child;
        break;
      }
    }
    container.insertBefore(el, referenceNode);
    engine.blockNodes.set(index, el);

    // Observe for height measurement.
    resizeObserverRef.current?.observe(el);
  }

  // ---- Remove a single block DOM node ----
  // NOTE: htmlCache is intentionally NOT evicted here. The content model is
  // append-only, so cached HTML is always valid. Retaining the cache means
  // scrolling back to a previously-rendered block is a cache hit [D03].
  function removeBlockNode(engine: MarkdownEngineState, index: number) {
    const el = engine.blockNodes.get(index);
    if (!el) return;
    resizeObserverRef.current?.unobserve(el);
    el.remove();
    engine.blockNodes.delete(index);
  }

  // ---- Apply a WindowUpdate to the DOM ----
  function applyWindowUpdate(
    engine: MarkdownEngineState,
    topSpacer: number,
    bottomSpacer: number,
    enter: { startIndex: number; endIndex: number }[],
    exit: { startIndex: number; endIndex: number }[],
  ) {
    // Remove exiting blocks
    for (const range of exit) {
      for (let i = range.startIndex; i < range.endIndex; i++) {
        removeBlockNode(engine, i);
      }
    }
    // Add entering blocks (cache hits only)
    for (const range of enter) {
      for (let i = range.startIndex; i < range.endIndex; i++) {
        addBlockNode(engine, i);
      }
    }
    applySpacers(topSpacer, bottomSpacer);
  }

  // ---- Rebuild the entire visible window from scratch ----
  function rebuildWindow(engine: MarkdownEngineState) {
    const scrollTop = scrollContainerRef.current?.scrollTop ?? 0;
    const update = engine.blockWindow.update(scrollTop);
    applyWindowUpdate(engine, update.topSpacerHeight, update.bottomSpacerHeight, update.enter, update.exit);
  }

  // ---- Cleanup component-scoped resources on unmount ----
  useLayoutEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

  // ---- Setup ResizeObserver for block height measurement ----
  useLayoutEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const engine = engineRef.current;
      if (!engine) return;
      let anyChanged = false;
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const indexStr = el.dataset.blockIndex;
        if (indexStr === undefined) continue;
        const index = parseInt(indexStr, 10);
        if (isNaN(index)) continue;
        const measured = entry.contentRect.height;
        const current = engine.heightIndex.getHeight(index);
        if (Math.abs(measured - current) > 0.5) {
          engine.heightIndex.setHeight(index, measured);
          onBlockMeasured?.(index, measured);
          anyChanged = true;
        }
      }
      if (anyChanged) {
        // Recompute spacers after height updates [L06: DOM write, not React state]
        const scrollTop = scrollContainerRef.current?.scrollTop ?? 0;
        const update = engine.blockWindow.update(scrollTop);
        applySpacers(update.topSpacerHeight, update.bottomSpacerHeight);
        // Safety net: if following bottom, re-pin so any height
        // corrections from ResizeObserver don't leave us short of the
        // bottom [D03]. `maybePinToBottom` owns the follow-bottom +
        // not-user-scrolling gate — a height correction that arrives
        // mid user-gesture no longer yanks the user to the bottom.
        smartScrollRef.current?.maybePinToBottom();
      }
    });
    resizeObserverRef.current = observer;
    return () => {
      observer.disconnect();
      resizeObserverRef.current = null;
    };
  }, [onBlockMeasured]);

  // ---- Update viewport height on container resize ----
  useLayoutEffect(() => {
    if (!scrollContainerRef.current) return;
    const engine = getEngine();
    const resizeObs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect.height;
        if (h > 0) {
          engine.blockWindow.setViewportHeight(h);
          rebuildWindow(engine);
        }
      }
    });
    resizeObs.observe(scrollContainerRef.current);
    return () => resizeObs.disconnect();
    // Intentionally empty: this effect only accesses refs at call time (scrollContainerRef, engineRef).
    // Re-running on ref changes would disconnect/reconnect the observer unnecessarily.
  }, []);

  // ---- SmartScroll instance [D93] ----
  useLayoutEffect(() => {
    if (!scrollContainerRef.current || !blockContainerRef.current) return;
    const smartScroll = new SmartScroll({
      scrollContainer: scrollContainerRef.current,
      followBottom,
      callbacks: {
        onScroll: () => {
          scrollDirtyRef.current = true;
          if (scrollRafRef.current === null) {
            scrollRafRef.current = requestAnimationFrame(() => {
              scrollRafRef.current = null;
              if (!scrollDirtyRef.current) return;
              scrollDirtyRef.current = false;
              const engine = engineRef.current;
              if (!engine) return;
              const scrollTop = scrollContainerRef.current?.scrollTop ?? 0;
              const update = engine.blockWindow.update(scrollTop);
              applyWindowUpdate(engine, update.topSpacerHeight, update.bottomSpacerHeight, update.enter, update.exit);
              // If following bottom, re-pin after spacer changes so
              // scrollTop stays at the true bottom. Without this, the
              // spacer shift leaves scrollTop short of the new max for
              // one paint frame. `maybePinToBottom` owns the gate.
              smartScrollRef.current?.maybePinToBottom();
            });
          }
        },
      },
    });
    smartScrollRef.current = smartScroll;

    // Listen for the `tug-region-scroll-set` event dispatched by
    // CardHost's `applyRegionScrolls` during cold-boot / cross-mount
    // region-scroll restore. The event carries the saved
    // `{ top, left }` position; we apply it via SmartScroll's
    // `scrollTo` (so the programmatic phase is recorded) and call
    // `disengageFollowBottom` so the next ResizeObserver-driven
    // height refinement does NOT re-slam scrollTop to the bottom.
    //
    // `preventDefault()` signals to the dispatcher that we owned
    // the apply — `applyRegionScrolls` skips its fallback direct
    // `scrollTop` assignment when this happens. Generic scroll
    // regions without a SmartScroll listener don't preventDefault,
    // and the dispatcher falls back to the direct assignment.
    const onRegionScrollSet = (event: Event) => {
      const ce = event as CustomEvent<{ top?: number; left?: number }>;
      const container = scrollContainerRef.current;
      const ss = smartScrollRef.current;
      if (!container || !ss) return;
      event.preventDefault();
      if (typeof ce.detail.left === "number") {
        container.scrollLeft = ce.detail.left;
      }
      if (typeof ce.detail.top === "number") {
        ss.scrollTo({ top: ce.detail.top, animated: false });
      }
      ss.disengageFollowBottom("region-scroll-restore");
    };
    const scrollContainer = scrollContainerRef.current;
    scrollContainer.addEventListener(
      "tug-region-scroll-set",
      onRegionScrollSet,
    );

    return () => {
      scrollContainer.removeEventListener(
        "tug-region-scroll-set",
        onRegionScrollSet,
      );
      smartScroll.dispose();
      smartScrollRef.current = null;
    };
    // Intentionally empty: SmartScroll is created once on mount and disposed on
    // unmount. It accesses refs at call time (scrollContainerRef,
    // blockContainerRef, scrollDirtyRef, scrollRafRef, engineRef), and
    // `followBottom` is its initial mode. Re-running would dispose and recreate
    // it unnecessarily.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once on mount, per the note above
  }, []);

  // ---- Shared lex+parse+render helper ----
  // Full rebuild: re-lexes the entire text, clears and repopulates htmlCache and
  // heightIndex, then rebuilds the visible window. Called for first region,
  // middle-region updates, or any change that invalidates the entire block order.
  function lexParseAndRender(engine: MarkdownEngineState, text: string) {
    // Capture scroll position BEFORE clearing the DOM. Once block nodes and
    // spacers are removed, the browser clamps scrollTop to 0 because the
    // content height drops to zero. We restore it after rebuilding.
    const savedScrollTop = scrollContainerRef.current?.scrollTop ?? 0;

    // Reset block window while height index is empty — forces exit of stale range.
    engine.heightIndex.clear();
    engine.blockWindow.update(0);
    engine.blockWindow.setViewportHeight(scrollContainerRef.current?.clientHeight ?? DEFAULT_VIEWPORT_HEIGHT);
    for (const [, el] of engine.blockNodes) {
      resizeObserverRef.current?.unobserve(el);
      el.remove();
    }
    engine.blockNodes.clear();
    engine.htmlCache.clear();
    engine.blockStarts = [];
    engine.blockEnds = [];
    engine.blockCount = 0;
    engine.regionBlockRanges.clear();
    applySpacers(0, 0);

    // Lex + parse + sanitize via the shared pipeline ([D09]).
    // Timing for the full pass — `parseMarkdownToSanitizedBlocks`
    // does lex + per-block parse + per-block DOMPurify sanitize in
    // one call, so we report it as a single `parseMs`. `lexMs` keeps
    // the legacy field name; the lex sub-step is now embedded in the
    // helper and not separately observable. Setting `lexMs = 0`
    // keeps the timing struct shape stable for any consumer
    // depending on the field; the more meaningful `parseMs` covers
    // the wall-clock cost of the whole pipeline.
    const lexMs = 0;
    const parseStart = performance.now();
    // The default transformer list runs the math (and future)
    // promotions; if no fence matches, every transformer flat-maps
    // a single block back unchanged.
    const blocks = parseMarkdownToSanitizedBlocks(text, {
      transformers: DEFAULT_BLOCK_TRANSFORMERS,
    });
    const parseMs = performance.now() - parseStart;

    engine.blockCount = blocks.length;
    engine.blockStarts = blocks.map(b => b.startChar);
    engine.blockEnds = blocks.map(b => b.endChar);

    for (const block of blocks) {
      engine.heightIndex.appendBlock(estimateBlockHeight(block));
    }
    for (let i = 0; i < blocks.length; i++) {
      engine.htmlCache.set(i, blocks[i].html);
    }

    // Populate regionBlockRanges by mapping each block to its region via char offset.
    // Iterate blocks in order; for each block, look up its region and accumulate.
    // Also record the type sequence for each region so fence propagation can detect
    // block type changes (D02 lazy fence propagation).
    {
      let currentKey: string | undefined = undefined;
      let rangeStart = 0;
      let rangeTypes: string[] = [];
      for (let i = 0; i < engine.blockStarts.length; i++) {
        const key = engine.regionMap.regionKeyAtOffset(engine.blockStarts[i]);
        if (key !== currentKey) {
          if (currentKey !== undefined) {
            engine.regionBlockRanges.set(currentKey, { start: rangeStart, count: rangeTypes.length, types: rangeTypes });
          }
          currentKey = key;
          rangeStart = i;
          rangeTypes = [blocks[i].type];
        } else {
          rangeTypes.push(blocks[i].type);
        }
      }
      if (currentKey !== undefined) {
        engine.regionBlockRanges.set(currentKey, { start: rangeStart, count: rangeTypes.length, types: rangeTypes });
      }
    }

    onTimingRef.current?.({ lexMs, parseMs, blockCount: engine.blockCount });

    // Restore scroll position, clamped to new content height.
    // Routed through SmartScroll [L06] — it is the sole owner of
    // every programmatic scroll-position write in this view. The
    // write enters the programmatic phase, so the deferred scroll
    // event this DOM rebuild emits is not misread as a user gesture.
    const maxScrollTop = engine.heightIndex.getTotalHeight() - (scrollContainerRef.current?.clientHeight ?? DEFAULT_VIEWPORT_HEIGHT);
    const scrollTop = Math.max(0, Math.min(savedScrollTop, maxScrollTop));
    smartScrollRef.current?.scrollTo({ top: scrollTop });

    // Enter visible blocks into DOM
    engine.blockWindow.setViewportHeight(scrollContainerRef.current?.clientHeight ?? DEFAULT_VIEWPORT_HEIGHT);
    const update = engine.blockWindow.update(scrollTop);
    applyWindowUpdate(engine, update.topSpacerHeight, update.bottomSpacerHeight, update.enter, update.exit);
  }

  // ---- Region-scoped incremental tail update ----
  // Lexes only the updated region's text, then splices the resulting blocks into
  // the engine arrays. For the tail region the prefix of blocks is stable; for
  // non-tail regions shiftFrom() is used to shift surviving blocks in place.
  // Implements (incrementalTailUpdate procedure) and (on-the-fly
  // byte offset computation).
  function incrementalTailUpdate(engine: MarkdownEngineState, key: string, _fullText: string) {
    const range = engine.regionBlockRanges.get(key);
    // range === undefined means this is a NEW region being appended (RegionMap.setRegion
    // adds keys at the end before incrementalTailUpdate is called). Treat it as an
    // empty existing region at the tail of the block array.

    const regionText = engine.regionMap.getRegionText(key) ?? "";
    const regionRange = engine.regionMap.regionRange(key);
    if (!regionRange) {
      // No regionRange — engine state is inconsistent (programming error). Bail out.
      console.warn(`incrementalTailUpdate: no regionRange for key "${key}"; skipping update`);
      return;
    }
    const regionCharStart = regionRange.start;

    // Lex only the region text, prepending \n\n for block boundary context (D01).
    // Subtract 2 from each byte offset to undo the prefix.
    const lexStart = performance.now();
    const packed = lex_blocks("\n\n" + regionText);
    const lexMs = performance.now() - lexStart;

    const rawBlocks = decodeBlocks(packed);
    // Filter out blocks that belong to the 2-byte prefix (startByte < 2)
    const newRegionBlocks = rawBlocks
      .filter(b => b.startByte >= 2)
      .map(b => ({ ...b, startByte: b.startByte - 2, endByte: b.endByte - 2 }));

    // Build byte-to-char map for the region slice.
    const byteToChar = buildByteToCharMap(regionText);

    // Translate WASM byte offsets (region-local) to document-global char offsets.
    const newStarts = newRegionBlocks.map(b => regionCharStart + (byteToChar[b.startByte] ?? b.startByte));
    const newEnds = newRegionBlocks.map(b => regionCharStart + (byteToChar[b.endByte] ?? b.endByte));

    // For a new region (range === undefined): S = blockCount (append after all existing
    // blocks), P = 0 (no prior blocks for this region), oldTypes = [] (no prior types).
    const S = range !== undefined ? range.start : engine.blockCount;
    const P = range !== undefined ? range.count : 0;
    const Q = newRegionBlocks.length;
    let parseMs = 0;

    // Capture old block types before mutating, for fence propagation comparison.
    // We use the stored types array from regionBlockRanges (D02 lazy fence propagation).
    const oldTypes: string[] = range !== undefined ? range.types.slice() : [];

    // Determine if this is the last region (tail). Non-tail regions require
    // shiftFrom() and key remapping when block count changes.
    const regionKeys = engine.regionMap.keys;
    const isLast = regionKeys[regionKeys.length - 1] === key;

    // Capture old region end (char offset) before any mutations, for Bug 2 char offset shifting.
    // For P > 0, the old region spans up to blockEnds[S + P - 1]. For P = 0 (new region),
    // there are no prior blocks so no subsequent offsets need shifting.
    const oldRegionEnd: number = P > 0 ? engine.blockEnds[S + P - 1] : regionCharStart;

    // Update changed existing blocks (S..S+min(P,Q)-1)
    for (let i = 0; i < Math.min(P, Q); i++) {
      const globalIdx = S + i;
      if (newStarts[i] !== engine.blockStarts[globalIdx] || newEnds[i] !== engine.blockEnds[globalIdx]) {
        const raw = engine.regionMap.text.slice(newStarts[i], newEnds[i]);
        const parseStart = performance.now();
        // Sanitize before caching — Step 7 made the cache contract
        // store DOMPurify-clean HTML uniformly across full-rebuild
        // and incremental paths.
        const sanitized = getDOMPurify().sanitize(parse_to_html(raw), SANITIZE_CONFIG);
        parseMs += performance.now() - parseStart;
        engine.htmlCache.set(globalIdx, sanitized);
        const existingEl = engine.blockNodes.get(globalIdx);
        if (existingEl) {
          existingEl.innerHTML = sanitized;
          enhanceFencedCode(existingEl);
          enhanceTable(existingEl);
          void enhanceMath(existingEl);
          void enhanceMermaid(existingEl);
          // Store estimate here; real measurement happens in doSetRegion's
          // consolidated measurement pass (one forced layout for all blocks).
          engine.heightIndex.setHeight(globalIdx, estimateBlockHeight(newRegionBlocks[i]));
        } else {
          // Not in the DOM — estimate is the best we can do.
          engine.heightIndex.setHeight(globalIdx, estimateBlockHeight(newRegionBlocks[i]));
        }
        engine.blockStarts[globalIdx] = newStarts[i];
        engine.blockEnds[globalIdx] = newEnds[i];
      }
    }

    // Handle block count change (Q != P)
    if (Q < P) {
      if (isLast) {
        // Tail shrink: remove excess tail blocks using truncate (no remapping needed).
        for (let i = Q; i < P; i++) {
          const globalIdx = S + i;
          removeBlockNode(engine, globalIdx);
          engine.htmlCache.delete(globalIdx);
        }
        engine.blockStarts.splice(S + Q, P - Q);
        engine.blockEnds.splice(S + Q, P - Q);
        engine.heightIndex.truncate(S + Q);
      } else {
        // Non-tail shrink: capture scroll position for recovery, remove excess DOM
        // nodes and cache entries, then shift surviving blocks left via shiftFrom.
        const oldScrollTop = scrollContainerRef.current?.scrollTop ?? 0;

        // (1) Remove excess DOM nodes and htmlCache entries for [S+Q, S+P).
        for (let i = Q; i < P; i++) {
          const globalIdx = S + i;
          removeBlockNode(engine, globalIdx);
          engine.htmlCache.delete(globalIdx);
        }
        engine.blockStarts.splice(S + Q, P - Q);
        engine.blockEnds.splice(S + Q, P - Q);

        // (2) shiftFrom with negative delta to compact the height array.
        engine.heightIndex.shiftFrom(S + P, Q - P);

        // (3) Remap surviving htmlCache keys >= S+P: shift left by (P - Q).
        const delta = Q - P; // negative
        const htmlEntriesToRemap: [number, string][] = [];
        for (const [k, v] of engine.htmlCache) {
          if (k >= S + P) htmlEntriesToRemap.push([k, v]);
        }
        for (const [k] of htmlEntriesToRemap) engine.htmlCache.delete(k);
        for (const [k, v] of htmlEntriesToRemap) engine.htmlCache.set(k + delta, v);

        // (4) Remap surviving blockNodes keys >= S+P: shift left by (P - Q).
        const nodeEntriesToRemap: [number, HTMLElement][] = [];
        for (const [k, el] of engine.blockNodes) {
          if (k >= S + P) nodeEntriesToRemap.push([k, el]);
        }
        for (const [k] of nodeEntriesToRemap) engine.blockNodes.delete(k);
        for (const [k, el] of nodeEntriesToRemap) {
          const newKey = k + delta;
          engine.blockNodes.set(newKey, el);
          el.dataset.blockIndex = String(newKey);
        }

        // (5) Update regionBlockRanges start for all subsequent regions.
        const keyIndex = regionKeys.indexOf(key);
        for (let ri = keyIndex + 1; ri < regionKeys.length; ri++) {
          const rkey = regionKeys[ri];
          const rrange = engine.regionBlockRanges.get(rkey);
          if (rrange) {
            engine.regionBlockRanges.set(rkey, { ...rrange, start: rrange.start + delta });
          }
        }

        // (6) Shift char offsets (blockStarts/blockEnds) for all subsequent blocks.
        // The region's char content changed, so all block char offsets after this
        // region are now stale. Compute charDelta from old vs new last-block-end.
        if (P > 0) {
          const newRegionEnd = Q > 0 ? newEnds[Q - 1] : regionCharStart;
          const charDelta = newRegionEnd - oldRegionEnd;
          if (charDelta !== 0) {
            for (let i = S + Q; i < engine.blockStarts.length; i++) {
              engine.blockStarts[i] += charDelta;
              engine.blockEnds[i] += charDelta;
            }
          }
        }

        // Content shrink scroll recovery: if scrollTop is now past the new bottom,
        // snap to the nearest surviving block offset above the old scroll position.
        // The snap write is routed through SmartScroll [L06]; the
        // `clientHeight` read stays a direct container access.
        if (scrollContainerRef.current) {
          const totalHeight = engine.heightIndex.getTotalHeight();
          const clientHeight = scrollContainerRef.current.clientHeight;
          if (oldScrollTop > totalHeight - clientHeight) {
            const blockIndex = engine.heightIndex.getBlockAtOffset(oldScrollTop);
            const newScrollTop = engine.heightIndex.getBlockOffset(blockIndex);
            smartScrollRef.current?.scrollTo({ top: newScrollTop });
          }
        }
      }
    } else if (Q > P) {
      if (isLast) {
        // Tail growth: append new blocks beyond the old count.
        const newStartsSlice = newStarts.slice(P);
        const newEndsSlice = newEnds.slice(P);
        engine.blockStarts.splice(S + P, 0, ...newStartsSlice);
        engine.blockEnds.splice(S + P, 0, ...newEndsSlice);
        for (let i = P; i < Q; i++) {
          engine.heightIndex.appendBlock(estimateBlockHeight(newRegionBlocks[i]));
          const globalIdx = S + i;
          const raw = engine.regionMap.text.slice(newStarts[i], newEnds[i]);
          const parseStart = performance.now();
          engine.htmlCache.set(
            globalIdx,
            getDOMPurify().sanitize(parse_to_html(raw), SANITIZE_CONFIG),
          );
          parseMs += performance.now() - parseStart;
        }
      } else {
        // Non-tail growth: shift surviving blocks right via shiftFrom, then remap.
        const delta = Q - P; // positive

        // (1) shiftFrom with positive delta to open a gap.
        engine.heightIndex.shiftFrom(S + P, delta);

        // (2) Remap surviving htmlCache keys >= S+P: shift right by (Q - P).
        const htmlEntriesToRemap: [number, string][] = [];
        for (const [k, v] of engine.htmlCache) {
          if (k >= S + P) htmlEntriesToRemap.push([k, v]);
        }
        for (const [k] of htmlEntriesToRemap) engine.htmlCache.delete(k);
        for (const [k, v] of htmlEntriesToRemap) engine.htmlCache.set(k + delta, v);

        // (3) Remap surviving blockNodes keys >= S+P: shift right by (Q - P).
        const nodeEntriesToRemap: [number, HTMLElement][] = [];
        for (const [k, el] of engine.blockNodes) {
          if (k >= S + P) nodeEntriesToRemap.push([k, el]);
        }
        for (const [k] of nodeEntriesToRemap) engine.blockNodes.delete(k);
        for (const [k, el] of nodeEntriesToRemap) {
          const newKey = k + delta;
          engine.blockNodes.set(newKey, el);
          el.dataset.blockIndex = String(newKey);
        }

        // (4) Update regionBlockRanges start for all subsequent regions.
        const keyIndex = regionKeys.indexOf(key);
        for (let ri = keyIndex + 1; ri < regionKeys.length; ri++) {
          const rkey = regionKeys[ri];
          const rrange = engine.regionBlockRanges.get(rkey);
          if (rrange) {
            engine.regionBlockRanges.set(rkey, { ...rrange, start: rrange.start + delta });
          }
        }

        // (5) Splice blockStarts/blockEnds for the new gap entries.
        const newStartsSlice = newStarts.slice(P);
        const newEndsSlice = newEnds.slice(P);
        engine.blockStarts.splice(S + P, 0, ...newStartsSlice);
        engine.blockEnds.splice(S + P, 0, ...newEndsSlice);

        // (6) Shift char offsets (blockStarts/blockEnds) for all subsequent blocks.
        // The region's char content changed, so all block char offsets after this
        // region are now stale. Compute charDelta from old vs new last-block-end.
        if (P > 0) {
          const newRegionEnd = Q > 0 ? newEnds[Q - 1] : regionCharStart;
          const charDelta = newRegionEnd - oldRegionEnd;
          if (charDelta !== 0) {
            for (let i = S + Q; i < engine.blockStarts.length; i++) {
              engine.blockStarts[i] += charDelta;
              engine.blockEnds[i] += charDelta;
            }
          }
        }

        // Parse and cache the new blocks in the gap [S+P, S+Q).
        for (let i = P; i < Q; i++) {
          const globalIdx = S + i;
          const raw = engine.regionMap.text.slice(newStarts[i], newEnds[i]);
          const parseStart = performance.now();
          engine.htmlCache.set(
            globalIdx,
            getDOMPurify().sanitize(parse_to_html(raw), SANITIZE_CONFIG),
          );
          parseMs += performance.now() - parseStart;
          engine.heightIndex.setHeight(globalIdx, estimateBlockHeight(newRegionBlocks[i]));
        }
      }
    }

    // When Q == P (block count unchanged) in a non-tail region, subsequent block char
    // offsets may still be stale if the region's text length changed. Apply charDelta.
    if (Q === P && !isLast && P > 0) {
      const newRegionEnd = Q > 0 ? newEnds[Q - 1] : regionCharStart;
      const charDelta = newRegionEnd - oldRegionEnd;
      if (charDelta !== 0) {
        for (let i = S + Q; i < engine.blockStarts.length; i++) {
          engine.blockStarts[i] += charDelta;
          engine.blockEnds[i] += charDelta;
        }
      }
    }

    // Update engine block count accounting for the delta.
    engine.blockCount += (Q - P);
    const newTypes = newRegionBlocks.map(b => b.type);
    engine.regionBlockRanges.set(key, { start: S, count: Q, types: newTypes });

    // Lazy fence propagation: if block type sequence changed and a next region exists,
    // re-lex that next region. Stop when blocks stabilize. In the common streaming
    // path the tail region is always last, so this is a no-op (D02).
    //
    // A fence imbalance necessarily changes the block types of subsequent regions
    // (e.g. paragraph text becomes code inside an unbalanced fence). Comparing type
    // sequences is a reliable proxy for fence balance change and avoids the need to
    // track fence depth explicitly.
    const keyIndex = regionKeys.indexOf(key);
    if (keyIndex >= 0 && keyIndex < regionKeys.length - 1) {
      // Compare old vs new block type sequences.
      // Count change or any type mismatch indicates structural change.
      const typeSequenceChanged = oldTypes.length !== newTypes.length ||
        oldTypes.some((t, i) => t !== newTypes[i]);
      if (typeSequenceChanged) {
        const nextKey = regionKeys[keyIndex + 1];
        incrementalTailUpdate(engine, nextKey, engine.regionMap.text);
        return; // next region's call handles timing and window update
      }
    }

    onTimingRef.current?.({ lexMs, parseMs, blockCount: engine.blockCount });

    // Render the block window. When following bottom AND the user is not
    // actively scrolling, render at the predicted bottom (totalHeight) so the
    // tail blocks are in the DOM before the measurement pass in doSetRegion.
    // During active gestures, render at the user's current scroll position —
    // their fingers own the viewport.
    const clientHeight = scrollContainerRef.current?.clientHeight ?? DEFAULT_VIEWPORT_HEIGHT;
    engine.blockWindow.setViewportHeight(clientHeight);
    const willPin = smartScrollRef.current?.shouldAutoPin ?? false;
    const renderScrollTop = willPin
      ? Math.max(0, engine.heightIndex.getTotalHeight() - clientHeight)
      : (scrollContainerRef.current?.scrollTop ?? 0);
    const update = engine.blockWindow.update(renderScrollTop);
    applyWindowUpdate(engine, update.topSpacerHeight, update.bottomSpacerHeight, update.enter, update.exit);
  }

  // ---- Core region update logic ----
  // Called by both the imperative handle and the streaming observer.
  // Uses incrementalTailUpdate for all non-cold-start updates (any region).
  // Cold start (wasEmpty) always goes through lexParseAndRender to establish the
  // initial block structure.
  function doSetRegion(key: string, text: string): void {
    const engine = getEngine();
    const wasEmpty = engine.regionMap.regionCount === 0;

    engine.regionMap.setRegion(key, text);
    const fullText = engine.regionMap.text;

    if (wasEmpty) {
      lexParseAndRender(engine, fullText);
    } else {
      incrementalTailUpdate(engine, key, fullText);
    }

    // When `shouldAutoPin` (following bottom AND the user is not actively
    // scrolling): measure all rendered blocks, correct heights, recompute
    // spacers, pin to bottom. `shouldAutoPin` separates INTENT from ACTION
    // — following-bottom is the intent, not-user-scrolling is the "safe to
    // take the scroll position" action gate. During active gestures the
    // intent may be set but we don't slam; when the gesture ends (idle),
    // the next chunk pins to the real bottom.
    const ss = smartScrollRef.current;
    if (ss?.shouldAutoPin) {
      const engine2 = engineRef.current;
      if (engine2 && scrollContainerRef.current) {
        // Single measurement pass: read offsetHeight for every rendered block.
        // This is the ONLY forced layout in the streaming hot path.
        let anyMeasured = false;
        for (const [idx, el] of engine2.blockNodes) {
          const stored = engine2.heightIndex.getHeight(idx);
          const real = el.offsetHeight;
          if (Math.abs(real - stored) > 0.5) {
            engine2.heightIndex.setHeight(idx, real);
            anyMeasured = true;
          }
        }
        if (anyMeasured) {
          // Recompute window with real heights — blocks may need to enter/exit
          // if the corrected heights shifted the visible range significantly
          // (common after cold start where most blocks have estimated heights).
          const correctedScrollTop = Math.max(0,
            engine2.heightIndex.getTotalHeight() - scrollContainerRef.current.clientHeight);
          const update = engine2.blockWindow.update(correctedScrollTop);
          applyWindowUpdate(engine2, update.topSpacerHeight, update.bottomSpacerHeight, update.enter, update.exit);
        }
      }
      // Pin to real bottom — heights are now real, spacers correct.
      ss.pinToBottom();
    }
  }

  // ---- Clear all regions and reset DOM ----
  function doClear(): void {
    const engine = getEngine();
    engine.regionMap.clear();
    engine.heightIndex.clear();
    engine.blockWindow.update(0);
    for (const [, el] of engine.blockNodes) {
      resizeObserverRef.current?.unobserve(el);
      el.remove();
    }
    engine.blockNodes.clear();
    engine.htmlCache.clear();
    engine.blockStarts = [];
    engine.blockEnds = [];
    engine.blockCount = 0;
    engine.regionBlockRanges.clear();
    applySpacers(0, 0);
  }

  // ---- Imperative handle [L03: useLayoutEffect so handle is ready before events] ----
  useImperativeHandle(ref, () => ({
    setRegion: doSetRegion,
    removeRegion(key: string) {
      const engine = getEngine();
      engine.regionMap.removeRegion(key);
      if (engine.regionMap.regionCount === 0) {
        doClear();
      } else {
        lexParseAndRender(engine, engine.regionMap.text);
      }
    },
    clear: doClear,
    // Intentionally empty: doSetRegion, doRemoveRegion (via removeRegion closure), and doClear only
    // access refs (engineRef, scrollContainerRef, smartScrollRef, resizeObserverRef)
    // at call time. The handle is stable for the component lifetime.
  }), []);

  // ---- Streaming rendering path [L22: direct store observer, no React round-trip] ----
  useLayoutEffect(() => {
    if (!streamingStore) return;
    const unsubscribe = streamingStore.observe(streamingPath, () => {
      const text = (streamingStore.get(streamingPath) as string) ?? '';
      if (!text) return;
      doSetRegion('stream', text);
    });
    return unsubscribe;
    // Deps are correct: streamingStore and streamingPath are the only values that should trigger
    // re-subscription. doSetRegion accesses refs at call time and does not need
    // to be listed as a dependency.
  }, [streamingStore, streamingPath]);

  // ---- Virtualized select-all ----
  //
  // A logical flag that means "the entire document is selected," even
  // though only a viewport window of blocks is in the DOM. When active:
  //   - Visual: a data-select-all attribute on the scroll container
  //     paints all block content with the selection color via CSS.
  //     A CSS rule suppresses ::selection to prevent double painting.
  //   - Copy: reads from regionMap.text (the full document) instead of
  //     the DOM Selection.
  //   - Cleared on the next pointerdown (bubble phase).
  const selectAllActiveRef = useRef(false);

  /** Set or clear the select-all visual state via data attribute [L06]. */
  function setSelectAllVisual(active: boolean) {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (active) {
      el.setAttribute("data-select-all", "");
    } else {
      el.removeAttribute("data-select-all");
    }
  }

  // ---- Action handlers ----

  const handleCut = useCallback((): ActionHandlerResult => {
    // Read-only component — cut is a no-op.
  }, []);

  const handleCopy = useCallback((): ActionHandlerResult => {
    if (selectAllActiveRef.current) {
      // Virtualized select-all: copy full text from the data model.
      const engine = engineRef.current;
      if (engine) {
        const text = engine.regionMap.text;
        // The whole document, so it carries the project it was read against —
        // a rendered document is exactly the surface whose prose cites files
        // by a root the text never spells out.
        void copyTextFrom(scrollContainerRef.current, text);
      }
    } else {
      // Normal selection: use execCommand("copy") which copies the
      // current DOM Selection. Runs synchronously in the user gesture.
      document.execCommand("copy");
    }
  }, []);

  const handlePaste = useCallback((): ActionHandlerResult => {
    // Read-only component — paste is a no-op.
  }, []);

  const handleSelectAll = useCallback((): ActionHandlerResult => {
    // Return a continuation so the select-all visual applies AFTER
    // the menu activation blink, matching the two-phase pattern used
    // by all TugEditorContextMenu dispatches [L11].
    return () => {
      selectAllActiveRef.current = true;
      setSelectAllVisual(true);
      // Clear the DOM Selection so native ::selection doesn't paint
      // alongside the data-select-all CSS visual.
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
    };
  }, []);

  // ---- Responder registration [L11] ----

  const responderId = useId();

  const { ResponderScope, responderRef } = useOptionalResponder({
    id: responderId,
    actions: {
      [TUG_ACTIONS.CUT]: handleCut,
      [TUG_ACTIONS.COPY]: handleCopy,
      [TUG_ACTIONS.PASTE]: handlePaste,
      [TUG_ACTIONS.SELECT_ALL]: handleSelectAll,
    },
    // The mutating verbs are absorbed here so they stop at a read-only
    // surface instead of walking up to something that would perform them —
    // but absorbing is not handling, and every surface that shows these
    // commands asks this hook. Without it the native Edit menu lights Cut
    // and Paste over a view that will never do either.
    validateAction: (action) =>
      action !== TUG_ACTIONS.CUT && action !== TUG_ACTIONS.PASTE,
  });

  // ---- Right-click menu via shared hook ----
  //
  // Markdown view doesn't use a `TextSelectionAdapter`: SelectionGuard
  // owns the selection lifecycle and the existing UX is "right-click
  // reflects whatever's already selected — no smart-click word
  // expansion in a paragraph". Pass `adapter: null` to skip the
  // hook's restore/classify/expand pipeline. Supply
  // `hasSelectionOverride` to fold the virtualized select-all flag
  // (`selectAllActiveRef`) into Copy enablement: when select-all is
  // logically active, the DOM Selection is empty (we removed the
  // ranges to avoid double-painting alongside the CSS visual), but
  // Copy must still be enabled because the COPY handler reads the
  // full document text from `regionMap.text`.
  const {
    onContextMenu: hookContextMenu,
    menu: contextMenuNode,
  } = useTextSurfaceContextMenu({
    adapterRef: null,
    hasSelectionOverride: () => {
      if (selectAllActiveRef.current) return true;
      const blockContainer = blockContainerRef.current;
      if (blockContainer === null) return false;
      const sel = window.getSelection();
      if (sel === null || sel.isCollapsed || sel.rangeCount === 0) return false;
      return (
        (sel.anchorNode !== null && blockContainer.contains(sel.anchorNode)) ||
        (sel.focusNode !== null && blockContainer.contains(sel.focusNode))
      );
    },
  });

  // ---- Event listeners ----
  //
  // Minimal set — SelectionGuard owns the selection lifecycle. These
  // listeners handle only:
  //   1. contextmenu: defer to the hook handler when the click lands
  //      inside the block container.
  //   2. pointerdown (bubble): clear selectAllActive flag on any
  //      non-right-click, after SelectionGuard's capture-phase work.
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const onContextMenu = (e: MouseEvent) => {
      const blockContainer = blockContainerRef.current;
      if (!blockContainer) return;
      if (!blockContainer.contains(e.target as Node) && e.target !== blockContainer) return;
      hookContextMenu(e);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 2 && selectAllActiveRef.current) {
        selectAllActiveRef.current = false;
        setSelectAllVisual(false);
      }
    };

    container.addEventListener("contextmenu", onContextMenu);
    container.addEventListener("pointerdown", onPointerDown);
    return () => {
      container.removeEventListener("contextmenu", onContextMenu);
      container.removeEventListener("pointerdown", onPointerDown);
    };
  }, [hookContextMenu]);

  // ---- Selection publish [A5] ----
  //
  // When `selectionPublishKey` is set and the view is mounted inside a
  // `CardHost`, publish the user's `Range` to `selectionGuard` so the
  // card-level paint authority can carry it across tab switches, app
  // resign/become-active, and (via the `CardHost` mount-restore path)
  // cold-boot. The `selectionchange` listener is the only intervention
  // — paint, dim/restore, and the inactive-selection custom highlight
  // are all owned downstream by `selectionGuard`.
  //
  // Filtering: any `Range` whose `commonAncestorContainer` is not a
  // descendant of the scroll container is ignored. This keeps a drag
  // that began in another card from registering this card's id, which
  // would corrupt `cardRanges` (the framework treats each entry as
  // "this card's selection").
  //
  // L03 — `useLayoutEffect` so the listener is installed before any
  // user gesture that could fire `selectionchange`. L23 — the publish
  // ensures `bag.domSelection` capture / restore round-trips the
  // user's selection across save/restore boundaries.
  const cardId = useCardId();
  useLayoutEffect(() => {
    if (selectionPublishKey === undefined) return;
    if (cardId === null) return;
    const root = scrollContainerRef.current;
    if (!root) return;

    const onSelectionChange = () => {
      // Only PUBLISH new ranges that originate inside this view.
      // Never clear via this listener: a focus shift away from the
      // card collapses native selection but the user's selection in
      // THIS card is still the published-truth (paint authority dims
      // it through the `inactive-selection` highlight on every
      // deck-store notify). Clearing belongs to the unmount cleanup
      // below, where the entry is genuinely going away.
      const sel = root.ownerDocument.getSelection();
      if (sel === null || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const ca = range.commonAncestorContainer;
      if (ca !== root && !root.contains(ca)) return;
      selectionGuard.updateCardDomSelection(
        cardId,
        range,
        domSelectionDirection(sel),
      );
    };

    root.ownerDocument.addEventListener("selectionchange", onSelectionChange);
    return () => {
      root.ownerDocument.removeEventListener("selectionchange", onSelectionChange);
      selectionGuard.updateCardDomSelection(cardId, null);
    };
  }, [selectionPublishKey, cardId]);

  // Card-state-preservation registration. `onSave` returns `undefined` so
  // `bag.content` stays absent and `CardHost`'s `captureCardState`
  // takes the `!ownsSelectionAndFocus` branch — `bag.domSelection` is
  // captured automatically from `selectionGuard.cardRanges` (seeded
  // by the listener above) and restored via
  // `selectionGuard.restoreCardDomSelection`. `onRestore` is a no-op
  // ([D07] / 25B plan). The hook also registers an
  // `onCardActivated` channel so future focus-transfer needs land
  // here without a second `register` call.
  useCardStatePreservation<undefined>({
    onSave: () => undefined,
    onRestore: () => {},
  });

  // Compose scrollContainerRef with responderRef so one DOM element gets
  // both: the scroll container ref for windowing logic and the responder
  // ref for data-responder-id so the chain's first-responder resolution
  // can find this node.
  const composedScrollRef = useCallback((el: HTMLDivElement | null) => {
    (scrollContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    responderRef(el);
  }, [responderRef]);

  return (
    <ResponderScope>
      {/* The scroll key puts this scroller on the region-preservation seam,
          which is also how a resize episode finds it. It claims nothing: the
          episode's own anchor descends past the aria-hidden spacers to the
          block under the top edge, which is the block-and-offset anchor this
          view would otherwise compute for itself out of the height index. */}
      <div
        ref={composedScrollRef}
        data-slot="tug-markdown-view"
        data-tug-scroll-key="markdown-view"
        className={cn("tugx-md-scroll-container", className)}
        tabIndex={0}
      >
        <div ref={topSpacerRef} className="tugx-md-spacer tugx-md-spacer--top" aria-hidden="true" />
        <div ref={blockContainerRef} className="tugx-md-block-container" />
        <div ref={bottomSpacerRef} className="tugx-md-spacer tugx-md-spacer--bottom" aria-hidden="true" />
        <div className="tugx-md-bottom-buffer" aria-hidden="true" />
        {contextMenuNode}
      </div>
    </ResponderScope>
  );
});

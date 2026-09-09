/**
 * `TugMarkdownBlock` — non-virtualizing markdown renderer.
 *
 * The natural-flow sibling primitive to `TugMarkdownView`. Both share
 * the WASM lex/parse + DOMPurify sanitize pipeline via
 * `parseMarkdownToSanitizedBlocks`; only their layout surfaces
 * differ:
 *
 *   - `TugMarkdownView` owns its own scroll container + windowing
 *     engine, suitable for whole-document logs (1 MB+ content,
 *     thousands of blocks).
 *   - `TugMarkdownBlock` renders every block in document flow with
 *     no scroll container, no spacers, no virtualization — the host
 *     (a list cell, a card body, etc.) owns scroll and layout. It is
 *     designed for per-cell or per-message markdown content where
 *     the content size is bounded.
 *
 * Two modes, mutually exclusive at mount:
 *
 *   1. **Static `initialText` mode** — `<TugMarkdownBlock initialText="..." />`.
 *      Parses + renders the supplied text in `useLayoutEffect` so
 *      the content is painted before the first browser frame.
 *      Subsequent `initialText` prop changes are ignored. Routes
 *      through `renderIncremental(el, text)` for code-path uniformity
 *      with streaming mode — against an empty container the reconciler
 *      appends every block fresh, so the output is identical to a
 *      one-shot bulk render. The returned `RenderState` is discarded
 *      since initial-text mode is mount-once and never re-renders.
 *
 *   2. **Streaming `streamingStore` mode** —
 *      `<TugMarkdownBlock streamingStore={store} streamingPath="text" />`.
 *      On mount, reads `store.get(streamingPath)` synchronously and
 *      renders that current value (the [#md-block-api] G1
 *      contract — `PropertyStore.observe` does NOT fire on subscribe,
 *      so a cell that mounts while the store already holds content
 *      would otherwise render empty until the next emission). Then
 *      subscribes via `store.observe(streamingPath, listener)` and
 *      reconciles on each emission via `renderIncremental` — the
 *      reconciler walks per-block content hashes against the
 *      previous render's hashes and mutates only what changed
 *      (in-place `innerHTML` rewrites preserve wrapper-element
 *      identity, which preserves the browser's scroll anchor).
 *      The previous render's hashes are recovered from the
 *      container's own children (`data-content-hash`), so the diff
 *      is stateless across calls: a Fast Refresh module reload or a
 *      strict-mode remount that would wipe a module-level cache
 *      cannot make the reconciler duplicate (or blank) blocks that
 *      are already on screen. Bursts are coalesced via
 *      `requestAnimationFrame`.
 *
 * Both modes write sanitized HTML directly to the DOM — there is no
 * React state for the rendered content per [L06]. The only React
 * state is the container element ref.
 *
 * Laws:
 *  - [L03] `useLayoutEffect` for the mount-render and the streaming
 *    subscription so DOM is in place before paint.
 *  - [L06] appearance changes go through CSS / DOM, never React
 *    state.
 *  - [L19] component authoring guide — file pair (`.tsx` + `.css`),
 *    module docstring, exported props interface,
 *    `data-slot="tug-markdown-block"`.
 *  - [L20] component-token sovereignty — reuses `--tugx-md-*` tokens
 *    only; no new tokens introduced.
 *  - [L22] streaming-binding observes the `PropertyStore` directly
 *    and writes DOM imperatively, bypassing the React render cycle
 *    for per-delta updates.
 *    The annotation pass's portal hosts are the one thing a delta
 *    cannot finish in DOM alone — a portal is a React render by
 *    construction — so that render is forced into the delta's own
 *    frame ({@link announceAnnotated}) rather than left to the
 *    scheduler. Same law, read the same way: no React scheduling
 *    between the store's change and what the reader sees.
 *  - [L23] streaming mode preserves user scroll position by routing
 *    every delta through the incremental reconciler ([#step-18-8]),
 *    which preserves the DOM element identity that browser scroll
 *    anchoring depends on.
 *
 * Decisions:
 *  - [D09] `TugMarkdownBlock` is a sibling primitive, not a flow
 *    mode on `TugMarkdownView`.
 *  - [D06] streaming cells observe the streaming source directly via
 *    this primitive's `streamingStore` mode.
 */

import "./tug-markdown-block.css";

import React from "react";
import { flushSync } from "react-dom";

import type { PropertyStore } from "@/components/tugways/property-store";
import { ensureParsed } from "@/lib/markdown/parse-cache";
import { recordRowParse } from "@/lib/markdown/parse-counters";
import {
  annotateElement,
  containerDependsOnVerdicts,
} from "@/lib/annotator/annotate-content";
import type { AnnotationContext } from "@/lib/annotator/types";
import { useAnnotationScope } from "@/components/tugways/annotation-scope";
import {
  renderIncremental,
  renderIncrementalFromBlocks,
} from "@/lib/markdown/render-incremental";

/**
 * Hand a freshly annotated container to `onAnnotated`, and — unless React is
 * already committing — make the portals it schedules mount in *this* frame.
 *
 * The portal hooks (`useAnnotationPortals`) do two things when they meet a
 * marked run: they EMPTY the host span, and they `setState` so a portal fills
 * it. Emptying is a DOM write and lands at once; the fill is a React render.
 * Called from a layout effect those are one frame — React flushes an update
 * scheduled during the commit phase before the browser paints. Called from
 * the streaming rAF they are not: the scheduler's task cannot run until after
 * this turn's rendering step, so the frame that empties the host is a frame
 * the reader sees empty, and the portal arrives in the next one.
 *
 * That is a flicker per delta, and a streaming paragraph is dozens of deltas.
 * It is worst on the commit pill, which is the widest of the marks and takes
 * the sentence's width with it as it goes — `( )` collapsing and re-opening
 * around a hole while the rest of the paragraph streams in.
 *
 * So the empty host is an intermediate state of one frame's work, and this is
 * where that is enforced: the pass writes the DOM, the portals fill it, and
 * only then is there a paint. Cheap by construction — the state lives in the
 * leaf that owns the portals (`AssistantTextBody`), so the synchronous render
 * is that component and its portal list, not the transcript.
 */
function announceAnnotated(
  el: HTMLElement,
  onAnnotated: ((container: HTMLElement) => void) | undefined,
  /** True when the caller is React's own commit phase, which already
   *  guarantees the pre-paint flush — and where `flushSync` is a no-op that
   *  warns. */
  duringCommit: boolean,
): void {
  if (onAnnotated === undefined) return;
  if (duringCommit) {
    onAnnotated(el);
    return;
  }
  flushSync(() => {
    onAnnotated(el);
  });
}

const DEFAULT_STREAMING_PATH = "text";

/**
 * Props for `TugMarkdownBlock`. `initialText` and `streamingStore`
 * are mutually exclusive at mount; if both are supplied, the
 * streaming mode takes precedence (the `initialText` prop is
 * effectively ignored). Consumers should set one xor the other.
 */
export interface TugMarkdownBlockProps {
  /**
   * Static initial text. Parsed + rendered once on mount before
   * paint; subsequent prop changes are ignored. Consumers that need
   * to update content remount (typically via a fresh React key) or
   * switch to streaming mode.
   */
  initialText?: string;

  /**
   * `PropertyStore` for streaming text. When set, the component
   * enters streaming mode: reads the current value on mount,
   * subscribes for updates, and re-renders on each emission with
   * rAF coalescing.
   */
  streamingStore?: PropertyStore;

  /**
   * `PropertyStore` path key for the streaming text value. Default
   * `"text"`. Only consulted in streaming mode.
   *
   * @default "text"
   */
  streamingPath?: string;

  /**
   * Forwarded class name. Cascade-scoped customization happens here
   * — consumers tune `--tugx-md-*` tokens for their instance via a
   * wrapping selector, not by reaching into the primitive's CSS
   * ([L20]).
   */
  className?: string;

  /**
   * Opt this block's rendered text into transcript Find: stamps
   * `data-tugx-findable` on the root so the find painter walks it
   * (`transcript-find-highlighter.ts`). Set ONLY by transcript content
   * surfaces whose text the search index projects — marking without a
   * matching index projection breaks the count↔paint alignment. Default
   * `false`: gallery, tool-result, and other non-indexed hosts stay
   * unsearchable.
   */
  findable?: boolean;

  /**
   * Live inputs for the entity kinds the annotator can only mark with
   * session state — commands, verified paths, commits. Every render
   * annotates the state-free kinds (URLs, email addresses) regardless.
   *
   * Usually omitted: a block rendered anywhere inside an
   * {@link AnnotationScope} picks the context up from there, so nested
   * markdown does not depend on every intervening component agreeing to
   * forward a prop. Pass it explicitly only to override the scope. A
   * block outside any scope, with no prop, marks the state-free kinds
   * only — the gallery and non-transcript hosts.
   *
   * Delivered to the imperative render closures via a ref, NOT closed
   * over directly: the streaming render effect's deps are
   * `[streamingStore, streamingPath]`, so a captured prop would be stale
   * — the ref keeps the context current at the mount build (which marks
   * finalized blocks) and at every streaming delta.
   */
  annotation?: AnnotationContext;

  /**
   * Called after every annotation pass this block performs, with the
   * container that was just marked — the mount render, the context-identity
   * re-mark, and each gated verdict re-mark.
   *
   * The seam exists because a consumer that has to act on what a pass
   * produced (collecting `[data-tug-annotation="session"]` spans to portal
   * live chips into, say) has **no ordering guarantee** without it. A sibling
   * hook subscribing to the same `VerdictBatcher` would appear to work — child
   * effects subscribe before parent effects, so this block's listener happens
   * to run first — and that is an accident of tree shape, not a contract: one
   * refactor moving the hook up a level starts collecting spans before they
   * exist. This fires exactly once per pass, from inside the pass's own
   * effect, where the ordering is not a coincidence.
   *
   * Identity-stable is not required; the callback is read from a ref, so a
   * fresh closure per render costs nothing and never re-runs an effect.
   */
  onAnnotated?: (container: HTMLElement) => void;
}

export const TugMarkdownBlock: React.FC<TugMarkdownBlockProps> = ({
  initialText,
  streamingStore,
  streamingPath = DEFAULT_STREAMING_PATH,
  className,
  findable = false,
  annotation: annotationProp,
  onAnnotated,
}) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  // Live-ref'd so a consumer may pass a fresh closure every render without
  // re-running the annotation effect below ([L07]).
  const onAnnotatedRef = React.useRef(onAnnotated);
  onAnnotatedRef.current = onAnnotated;

  // A markdown block inside an annotation scope is annotated whether or
  // not whoever rendered it passed the context down. That fallback is the
  // point: a subagent's prose is markdown nested several components below
  // the transcript cell, and every intermediate renderer would have had to
  // agree to forward a prop it does not otherwise care about. It did not,
  // so subagent output was skipped wholesale. Outside a scope this is
  // `null` and nothing changes for the gallery and non-transcript hosts.
  const scopedAnnotation = useAnnotationScope();
  const annotation = annotationProp ?? scopedAnnotation ?? undefined;

  // The annotation context is read from a ref inside the render closures
  // below, never closed over directly: the streaming effect's deps are
  // `[streamingStore, streamingPath]`, so a captured prop would be stale.
  // Reassigned every render so the closures see the live context (see the
  // `annotation` prop doc).
  const annotationRef = React.useRef(annotation);
  annotationRef.current = annotation;

  // Static `initialText` mode — runs once at mount, never again.
  // Skipped entirely when `streamingStore` is set; the streaming
  // effect below owns the render in that case so this effect's
  // initialText pass would only race with it.
  //
  // Reuses the streaming-mode reconciler with `prev = null` so the
  // block-element construction recipe (.tugx-md-block wrapper +
  // data-blockType + sanitized innerHTML + enhanceFencedCode) lives
  // in exactly one place — `renderIncremental` / `buildBlockElement`.
  // The reconciler's full-reset path produces identical DOM to a
  // bulk one-shot render, so the visible behaviour is unchanged.
  // Returned state is discarded: initial-text mode is mount-once.
  React.useLayoutEffect(() => {
    if (streamingStore !== undefined) return;
    const el = containerRef.current;
    if (el === null) return;
    const text = initialText ?? "";
    // Parse-economy counter: `renderIncremental` skips the parse
    // entirely for empty text, so only non-empty renders count.
    if (text !== "") recordRowParse("static");
    renderIncremental(el, text, { annotation: annotationRef.current });
    // Empty deps — `initialText` changes after mount are intentionally
    // ignored per the [#md-block-api] mount-once contract. A consumer
    // that wants to swap content remounts via a fresh React key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Streaming `streamingStore` mode — reads the current value
  // synchronously on mount (G1) and subscribes for updates. Each
  // emission flows through the incremental reconciler
  // ([#step-18-8]), which mutates only the blocks whose source byte
  // ranges changed. Wrapper elements for stable blocks keep their
  // identity across deltas, which keeps the browser's scroll anchor
  // valid and the user's reading position intact.
  //
  // `PropertyStore.observe` does NOT fire on subscribe, so the
  // initial pre-paint render here is essential when a streaming cell
  // mounts while the store already holds content (e.g.
  // scroll-out-and-back). Updates are rAF-coalesced so a burst of
  // deltas produces at most one render per paint frame.
  React.useLayoutEffect(() => {
    if (streamingStore === undefined) return;
    const el = containerRef.current;
    if (el === null) return;

    // Every render is an annotation pass — `renderIncremental*` marks the
    // DOM it builds — so every render has to ANNOUNCE itself. The late-arrival
    // effect below cannot cover this: its verdict-batch re-mark fires only
    // when a batch names a key this container consulted, and a delta that
    // re-renders after a verdict settles marks the run with nothing
    // listening — which is exactly the state a confirmed commit sha was
    // found in: wrapped and underlined in the transcript, but never replaced
    // by its `commit:<8ch>` label, because the tip portal was never told the
    // host existed.
    //
    // The pass and the portals it earns are one frame — see
    // {@link announceAnnotated}. `inCommit` is true only for the G1 render
    // below, which runs in this effect's own body.
    let inCommit = true;
    const announce = (): void => {
      announceAnnotated(el, onAnnotatedRef.current, inCommit);
    };

    const reconcile = (text: string): void => {
      if (text === "") {
        renderIncremental(el, "");
        announce();
        return;
      }
      // Render-once cache, scoped to the session's streaming store and
      // keyed by the row's stable streaming-path identity
      // (`turn.${turnKey}.message.${messageKey}.text`). A finalized
      // row's text never changes, so after its last parse every
      // subsequent render — re-mounts included — skips the WASM
      // lex/parse/sanitize pass and goes straight to the shared DOM
      // apply. A streaming row's text changes per delta, so it misses
      // and parses exactly as before; its final delta's parse IS the
      // finalized cache entry, so a later remount of the same row is
      // a pure cache hit through the `ensureParsed` chokepoint.
      //
      // The reconciler recovers the previous render from the container's
      // own children (`data-content-hash`), so there is no per-container
      // diff state to thread here and nothing a module reload can wipe —
      // an emptied parse cache costs at most one extra parse, never a
      // duplicate-append.
      const blocks = ensureParsed(streamingStore, streamingPath, text);
      renderIncrementalFromBlocks(el, blocks, annotationRef.current);
      announce();
    };

    // G1 — render the store's current value before paint. The
    // reconciler diffs against whatever children the container already
    // holds (none on a fresh mount → full append; the prior render's
    // blocks on a remount → all stable, a no-op).
    const initial = (streamingStore.get(streamingPath) as string | undefined) ?? "";
    reconcile(initial);
    inCommit = false;

    let pendingRaf: number | null = null;
    const flush = () => {
      pendingRaf = null;
      const target = containerRef.current;
      if (target === null) return;
      const text = (streamingStore.get(streamingPath) as string | undefined) ?? "";
      reconcile(text);
    };

    const unsubscribe = streamingStore.observe(streamingPath, () => {
      // First emission in a burst schedules the flush; subsequent
      // emissions see the queued id and skip the schedule. The rAF
      // clears the id and reconciles, picking up the cumulative
      // store value at the time it fires.
      if (pendingRaf !== null) return;
      pendingRaf = requestAnimationFrame(flush);
    });

    return () => {
      if (pendingRaf !== null) {
        cancelAnimationFrame(pendingRaf);
        pendingRaf = null;
      }
      unsubscribe();
      // Cleanup tears down the subscription and any pending rAF but
      // deliberately leaves the container's DOM children in place.
      // React 18 dev strict mode (and Vite Fast Refresh) re-run this
      // effect as `cleanup → setup` against the SAME container; on the
      // re-setup the reconciler reads the previous render's hashes back
      // off those surviving children (`data-content-hash`), sees them
      // unchanged, and does nothing. There is no module-level diff state
      // to lose, so a reload can neither duplicate the blocks nor blank
      // them — the worst case is a wasted re-parse on a cache miss.
    };
  }, [streamingStore, streamingPath]);

  // Re-mark already-rendered DOM when an annotation input arrives late.
  // The render effects above mark at block *build* time (the full
  // `annotateContent` pass, link detection included); this effect owns the
  // two late-arrival cases, both entity-only re-marks over unchanged DOM —
  // never a second link-detection or `normalize()` walk:
  //
  //  1. Context identity change — the on-resume catalog race, a cwd or
  //     binding arriving. Rare, and legitimately global: every block
  //     re-marks, which is exactly this effect re-running per instance.
  //  2. A resolver verdict batch. Frequent while answers drain, so it is
  //     *gated*: the pass files the verdict keys it consulted against the
  //     container, the batch names the keys whose answer moved, and only
  //     the containers depending on one of them re-mark. A block none of
  //     the moved keys touch costs nothing per batch, and a batch nobody
  //     depends on costs nothing at all.
  //
  // Runs after the render effects so the container is populated. [L06]
  // DOM-only; [L03] layout effect so the marks precede any gesture.
  React.useLayoutEffect(() => {
    const el = containerRef.current;
    if (el === null || annotation === undefined) return;
    annotateElement(el, annotation);
    onAnnotatedRef.current?.(el);
    const subscribe = annotation.subscribe;
    if (subscribe === undefined) return;
    return subscribe((changed) => {
      const target = containerRef.current;
      if (target === null || !containerDependsOnVerdicts(target, changed)) {
        return;
      }
      annotateElement(target, annotation);
      // A verdict batch arrives on a timer, outside React — so the host this
      // pass empties has to be filled before the paint, exactly as a delta's
      // does.
      announceAnnotated(target, onAnnotatedRef.current, false);
    });
  }, [annotation]);

  return (
    <div
      ref={containerRef}
      data-slot="tug-markdown-block"
      data-tugx-findable={findable ? "" : undefined}
      className={
        className === undefined
          ? "tug-markdown-block"
          : `tug-markdown-block ${className}`
      }
    />
  );
};

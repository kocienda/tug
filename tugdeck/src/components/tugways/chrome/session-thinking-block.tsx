/**
 * `SessionThinkingBlock` — inline collapsible chrome for the assistant's
 * "thinking" stream within a Dev code row.
 *
 * This is the `note` variant of the block contract ([BlockVariant], [P07]):
 * it stamps `data-variant="note"`, adopts the shared `--tugx-block-*` chrome
 * surface, and wears the shared affordance cluster — the same `BlockCopyButton`
 * + `BlockFoldCue` the tool header uses, on the trailing edge. It keeps its own
 * identity (the "Thinking" label + collapsed preview + height-animated body)
 * and `--tugx-thinking-*` tones ([P08]) rather than rendering through
 * `BlockHeader` (note has no dot/verb/detail and a different body-collapse), so
 * it shares the contract and the affordances, not the whole component.
 *
 * Two modes (mutually exclusive):
 *
 *   1. **Streaming** — `<SessionThinkingBlock streamingStore={…}
 *      streamingPath="inflight.thinking" />`. Subscribes to a
 *      `PropertyStore` path and renders deltas live. Default-expanded
 *      so the user can watch reasoning as it arrives. The block self-
 *      hides when the path holds no content yet (no thinking →
 *      no chrome).
 *
 *   2. **Static** — `<SessionThinkingBlock initialText={turn.thinking} />`.
 *      Renders a finished turn's thinking. Default-**collapsed** per
 *      [D14] — once the answer is in, the reasoning trail is
 *      supplementary; the user opts in to expand. Renders nothing
 *      when `initialText` is empty (parent is welcome to skip the
 *      mount altogether — both work).
 *
 * Once the user toggles the block, that state holds until the cell
 * unmounts (per row lifetime [D14]). Re-mount (scroll-out → scroll-in
 * across the virtualized list view, or row swap from streaming →
 * committed on `turn_complete`) starts from the mode default again.
 *
 * Composition:
 * - The body delegates to `TugMarkdownBlock` so thinking prose
 *   inherits the typography pass from #step-2 / #step-3 (footnotes,
 *   smart-punct, inline emphasis, etc.). The wrapping chrome is the
 *   only piece this component owns.
 *
 * Laws:
 * - [L03] `useLayoutEffect` for the initial-render and streaming
 *   subscription so DOM is in place before paint.
 * - [L06] appearance changes go through CSS / DOM. The collapse
 *   toggle flips `data-collapsed` on the root; CSS animates the
 *   body height. No React rerender per delta.
 * - [L19] `.tsx` + `.css` pair, exported props interface,
 *   `data-slot="session-thinking-block"`.
 * - [L20] component-token sovereignty — owns the `--tugx-thinking-*`
 *   slot family ([Table T07]), declared in `ironclad.css` and
 *   `sloop.css`.
 * - [L22] streaming binding in streaming mode subscribes the body's
 *   `TugMarkdownBlock` directly to the `PropertyStore`; deltas write
 *   the DOM imperatively without a React render cycle. The chrome
 *   side (visibility + preview) reads the same store via
 *   `observe()` and updates two attributes / one text node — also
 *   imperatively, no React state per delta.
 *
 * Decisions:
 * - [D14] default-collapsed-on-complete is the static-mode default.
 *
 * @module components/tugways/chrome/session-thinking-block
 */

import "./session-thinking-block.css";

import React from "react";

import { BlockCopyButton } from "@/components/tugways/body-kinds/affordances/block-copy-button";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";

import type { PropertyStore } from "@/components/tugways/property-store";
import { TugMarkdownBlock } from "@/components/tugways/tug-markdown-block";
import { ToolBlockExpansionContext } from "@/components/tugways/blocks/collapse-context";

/**
 * The card-scoped expansion key for the thinking block of one transcript
 * message, derived from the streaming path the transcript already threads.
 * A transcript-mounted block routes its collapse boolean through the
 * card's `ToolBlockExpansionState` under this key, which is what lets the
 * whole-transcript search index know — for an UNMOUNTED row — whether this
 * block's prose is on screen or hidden behind the fold.
 */
export function thinkingCollapseKey(streamingPath: string): string {
  return `thinking:${streamingPath}`;
}

/**
 * Maximum length of the collapsed-state preview line before truncation.
 * Picked to fit the typical Session card width without wrapping at
 * 14-16 px label sizes. Exported for the test that asserts truncation.
 */
export const PREVIEW_MAX_LENGTH = 80;

/**
 * The block's identity word — the note variant's analog of a tool header's
 * name. Shared with the transcript search index, which projects it as this
 * block's first search unit (it is on screen in both collapse states).
 */
export const THINKING_LABEL = "Thinking";

/**
 * Compute a one-line preview from a multiline thinking string. Takes
 * the first non-empty line, collapses interior whitespace, and
 * truncates with a trailing ellipsis above `PREVIEW_MAX_LENGTH`.
 *
 * Exported for unit tests; production callers route through the
 * component itself.
 */
export function computePreview(text: string): string {
  if (text === "") return "";
  // First non-empty line — Claude sometimes opens thinking with a
  // blank line, and a leading "" preview would collapse the chrome's
  // spatial cue.
  const lines = text.split("\n");
  let firstLine = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      firstLine = trimmed;
      break;
    }
  }
  if (firstLine === "") return "";
  // Collapse interior whitespace runs (tabs, multiple spaces) so the
  // preview reads as a single sentence-style fragment.
  const collapsed = firstLine.replace(/\s+/g, " ");
  if (collapsed.length <= PREVIEW_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, PREVIEW_MAX_LENGTH - 1)}…`;
}

/**
 * Props for `SessionThinkingBlock`. `initialText` and `streamingStore`
 * are mutually exclusive at mount; if both are supplied, streaming
 * mode wins (mirrors `TugMarkdownBlock`).
 */
export interface SessionThinkingBlockProps {
  /**
   * Static thinking text from a completed turn (`TurnEntry.thinking`).
   * The block mounts default-**collapsed** per [D14].
   */
  initialText?: string;

  /**
   * `PropertyStore` for in-flight thinking. The block subscribes on
   * mount, renders deltas live, and self-hides while the path's
   * value is empty.
   */
  streamingStore?: PropertyStore;

  /**
   * `PropertyStore` path the block subscribes to in streaming mode.
   * Required when `streamingStore` is set — consumers thread the
   * appropriate path (e.g. the transcript constructs
   * `turn.${turnKey}.thinking` per the per-turn-paths architecture
   * documented in `code-session-store.ts`'s write-inflight processor).
   */
  streamingPath?: string;

  /**
   * Card-scoped expansion key ({@link thinkingCollapseKey}). When set AND
   * a `ToolBlockExpansionContext` is above, the collapse boolean lives in
   * the card's `ToolBlockExpansionState` instead of local state: it then
   * survives the row's windowed remount, and — the reason it matters for
   * Find — the search index can read it for a row that isn't mounted at
   * all. Omitted by standalone / gallery mounts, which keep local state.
   */
  collapseKey?: string;

  /**
   * Forwarded class name. Cascade-scoped customization happens here —
   * consumers tune `--tugx-thinking-*` tokens via a wrapping selector
   * per [L20].
   */
  className?: string;
}

export const SessionThinkingBlock: React.FC<SessionThinkingBlockProps> = ({
  initialText,
  streamingStore,
  streamingPath,
  collapseKey,
  className,
}) => {
  const isStreaming = streamingStore !== undefined;
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const previewRef = React.useRef<HTMLSpanElement | null>(null);

  // Collapse default per [D14]: streaming → expanded; static → collapsed.
  const defaultCollapsed = !isStreaming;
  // The card's expansion overrides when a key is supplied — the same store
  // tool blocks write through, so one instance holds every fold on the card
  // and the search index resolves them without mounting anything.
  const expansion = React.useContext(ToolBlockExpansionContext);
  const shared = collapseKey !== undefined ? expansion : null;
  const [collapsed, setCollapsed] = React.useState(() =>
    shared !== null ? shared.resolve(collapseKey!, defaultCollapsed) : defaultCollapsed,
  );

  // One writer for both affordances (the label region toggles, the fold cue
  // reports the next value) so the shared state and the local mirror can't
  // drift apart.
  const applyCollapsed = React.useCallback(
    (next: boolean) => {
      if (shared !== null && collapseKey !== undefined) {
        shared.set(collapseKey, next, defaultCollapsed);
      }
      setCollapsed(next);
    },
    [shared, collapseKey, defaultCollapsed],
  );

  const handleToggle = React.useCallback(() => {
    applyCollapsed(!collapsed);
  }, [applyCollapsed, collapsed]);

  const handleFold = applyCollapsed;

  // Copy payload — the thinking text itself, read live from the streaming
  // store or the static prop, so the header's Copy matches the visible body
  // in both modes.
  const getThinkingText = React.useCallback((): string => {
    if (isStreaming) {
      if (streamingStore === undefined || streamingPath === undefined) return "";
      return (streamingStore.get(streamingPath) as string | undefined) ?? "";
    }
    return initialText ?? "";
  }, [isStreaming, streamingStore, streamingPath, initialText]);

  // ---------- Streaming mode: subscribe for content + preview state.
  //
  // Two reads from the same path: TugMarkdownBlock subscribes for the
  // body content, this effect subscribes for the chrome (`data-empty`
  // attribute + collapsed-state preview text). Both unsubscribe on
  // unmount — keeping the chrome's read separate avoids passing a
  // ref/callback through TugMarkdownBlock's props.
  React.useLayoutEffect(() => {
    if (!isStreaming) return;
    const root = rootRef.current;
    const preview = previewRef.current;
    if (root === null || preview === null) return;
    const store = streamingStore;
    if (store === undefined) return;
    if (streamingPath === undefined) return;

    function applyChromeFor(text: string): void {
      const r = rootRef.current;
      const p = previewRef.current;
      if (r === null || p === null) return;
      const empty = text.length === 0;
      r.dataset.empty = empty ? "true" : "false";
      // An empty block is `display: none` — nothing in it is on screen, so
      // nothing in it is findable (the index projects nothing for it either).
      if (empty) {
        r.dataset.tugxFindHidden = "true";
      } else {
        delete r.dataset.tugxFindHidden;
      }
      p.textContent = computePreview(text);
    }

    applyChromeFor((store.get(streamingPath) as string | undefined) ?? "");

    let pending: number | null = null;
    const flush = () => {
      pending = null;
      const text = (store.get(streamingPath) as string | undefined) ?? "";
      applyChromeFor(text);
    };
    const unsubscribe = store.observe(streamingPath, () => {
      if (pending !== null) return;
      pending = requestAnimationFrame(flush);
    });

    return () => {
      if (pending !== null) {
        cancelAnimationFrame(pending);
        pending = null;
      }
      unsubscribe();
    };
  }, [isStreaming, streamingStore, streamingPath]);

  // ---------- Static mode: one-shot chrome state at mount.
  React.useLayoutEffect(() => {
    if (isStreaming) return;
    const root = rootRef.current;
    const preview = previewRef.current;
    if (root === null || preview === null) return;
    const text = initialText ?? "";
    const empty = text.length === 0;
    root.dataset.empty = empty ? "true" : "false";
    if (empty) {
      root.dataset.tugxFindHidden = "true";
    } else {
      delete root.dataset.tugxFindHidden;
    }
    preview.textContent = computePreview(text);
    // Mount-once contract — initialText changes after mount are
    // ignored; consumers remount via a fresh React key when the
    // committed thinking text would change. This matches
    // `TugMarkdownBlock`'s static-mode contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={rootRef}
      data-slot="session-thinking-block"
      data-variant="note"
      data-mode={isStreaming ? "streaming" : "static"}
      data-collapsed={collapsed ? "true" : "false"}
      data-empty="true"
      className={
        className === undefined
          ? "session-thinking-block"
          : `session-thinking-block ${className}`
      }
    >
      {/* Header adopts the shared block affordance pattern (refines [P07]):
          the identity (label + collapsed preview) sits on the left and stays
          click-to-toggle; the trailing cluster carries the same `BlockCopyButton`
          + `BlockFoldCue` the tool header uses, on the RIGHT, at the `xs` scale.
          So note now reads and acts like every other block (Copy present, fold
          on the right) while keeping its label/preview identity. */}
      <div className="session-thinking-block-header">
        <button
          type="button"
          className="session-thinking-block-toggle"
          aria-expanded={collapsed ? "false" : "true"}
          aria-controls="session-thinking-block-body"
          onClick={handleToggle}
        >
          {/* The label is this variant's identity — the note analog of a
              tool header's name — visible in both states, so it is
              searchable in both. The preview is visible ONLY while
              collapsed (`visibility: hidden` otherwise), so it carries the
              hidden marker when the body is showing: Find must never count
              or paint the same prose twice. */}
          <span className="session-thinking-block-label" data-tugx-findable="">
            {THINKING_LABEL}
          </span>
          <span
            ref={previewRef}
            className="session-thinking-block-preview"
            data-tugx-findable=""
            data-tugx-find-hidden={collapsed ? undefined : "true"}
          />
        </button>
        <span className="session-thinking-block-actions">
          <BlockCopyButton
            subtype="icon"
            size="xs"
            getText={getThinkingText}
            aria-label="Copy thinking"
            data-slot="session-thinking-block-copy"
          />
          <BlockFoldCue
            collapsed={collapsed}
            onToggle={handleFold}
            collapsedLabel="Expand"
            expandedLabel="Collapse"
            ariaLabelExpand="Expand thinking"
            ariaLabelCollapse="Collapse thinking"
            size="xs"
            subtype="icon"
            data-slot="session-thinking-block-fold"
          />
        </span>
      </div>
      <div
        id="session-thinking-block-body"
        className="session-thinking-block-body"
        // The viewport row is the grid track that animates between
        // 0fr (collapsed) and 1fr (expanded). The inner content
        // overflow:hidden prevents the body from spilling out during
        // the height interpolation.
        //
        // Unlike a tool block, the collapsed body stays MOUNTED (the
        // height animation needs it), so it is clipped rather than gone.
        // The hidden marker keeps the find painter out of it, matching the
        // index, which projects the preview instead while collapsed.
        data-tugx-find-hidden={collapsed ? "true" : undefined}
      >
        <div className="session-thinking-block-viewport">
          <div className="session-thinking-block-content">
            {isStreaming ? (
              <TugMarkdownBlock
                streamingStore={streamingStore}
                streamingPath={streamingPath}
                findable
              />
            ) : (
              <TugMarkdownBlock initialText={initialText ?? ""} findable />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

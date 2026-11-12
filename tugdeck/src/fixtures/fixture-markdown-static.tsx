/**
 * fixture-markdown-static.tsx — app-test fixture: a fixed markdown document
 * in a plain scroll region.
 *
 * Renders a generated 1 KB or 50 KB document through `TugMarkdownBlock`
 * inside one scroller carrying `data-tug-scroll-key="markdown-view"`. The
 * cold-boot tests seed it to prove two guarantees of card state preservation
 * across a process restart, neither of which belongs to the renderer:
 *
 *   - **Region scroll.** `CardHost` snapshots every `[data-tug-scroll-key]`
 *     element's offset into `bag.regionScroll`, and on restore assigns it
 *     back to the element with the same key (`at0014-cold-boot-scroll`).
 *   - **DOM selection.** The scroller publishes the user's `Range` to
 *     `selectionGuard`, so `CardHost` captures it as `bag.domSelection` and
 *     re-anchors it at the next mount (`at0010-cold-boot-selection`). The
 *     document is regenerated identically on every mount, so the saved
 *     child-index paths resolve to the same nodes.
 *
 * The payload is built at module scope, once, so a re-render never changes it.
 *
 * Laws:
 *  - [L03] the `selectionchange` listener is installed in `useLayoutEffect`,
 *    before any gesture that could fire it.
 *  - [L23] the publish is what lets `bag.domSelection` round-trip.
 *
 * @module fixtures/fixture-markdown-static
 */

import React, { useLayoutEffect, useRef } from "react";

import "./fixture.css";

import { TugMarkdownBlock } from "@/components/tugways/tug-markdown-block";
import {
  domSelectionDirection,
  selectionGuard,
} from "@/components/tugways/selection-guard";
import {
  useCardId,
  useCardStatePreservation,
} from "@/components/tugways/use-card-state-preservation";

/**
 * A markdown document of about `targetBytes`: one heading line, then a unit of
 * headings, prose, a fenced code block, a list and a blockquote, repeated.
 */
function generateMarkdown(targetBytes: number): string {
  const UNIT = `## Section Heading

This is a paragraph of realistic prose content. It discusses the implementation details of a virtualized rendering engine. The engine uses a BlockHeightIndex data structure backed by a Float64Array prefix sum to achieve O(log n) scroll offset lookups. This paragraph is roughly 300 characters long including spaces and punctuation, which is typical for real conversation content.

Another paragraph follows immediately. It continues the discussion of the sliding window algorithm. The RenderedBlockWindow maintains a contiguous range of blocks with DOM nodes, diffing the viewport on each scroll event to add entering blocks and remove exiting blocks. Overscan of two screens prevents flicker during fast scrolling.

### Code Example

\`\`\`typescript
class BlockHeightIndex {
  private heights: Float64Array;
  private prefixSum: Float64Array;
  private watermark: number;
  private _count: number;

  constructor(initialCapacity = 1024) {
    this.heights = new Float64Array(initialCapacity);
    this.prefixSum = new Float64Array(initialCapacity + 1);
    this.watermark = 0;
    this._count = 0;
  }

  appendBlock(estimatedHeight: number): number {
    const index = this._count;
    this.heights[index] = estimatedHeight;
    this._count++;
    if (index < this.watermark) this.watermark = index;
    return index;
  }
}
\`\`\`

### List of Features

- Virtualized rendering: only viewport-visible blocks are in the DOM
- Float64Array prefix sum for O(log n) offset lookups
- Lazy recomputation from the dirty watermark forward
- Binary search for scroll offset to block index mapping
- Overscan of 2 screens above and below the viewport
- ResizeObserver-based height measurement and refinement
- Streaming path: incremental tail lexing, auto-scroll to tail
- Finalization pass on turn_complete for streaming consistency

> **Note:** The height estimation uses hardcoded constants per block type. A paragraph is estimated as lineCount × LINE_HEIGHT, where LINE_HEIGHT is 24px. Headings use per-level constants. Code blocks add a header height plus lineCount × CODE_LINE_HEIGHT.

---

`;

  const parts: string[] = [
    "# Virtualized Markdown Rendering Engine\n\n",
    `Target: ${(targetBytes / 1024).toFixed(0)}KB\n\n`,
  ];
  const repeats = Math.ceil(targetBytes / UNIT.length);
  for (let i = 0; i < repeats; i++) {
    parts.push(UNIT.replace("## Section Heading", `## Section ${i + 1}`));
  }
  return parts.join("");
}

const CONTENT = {
  "1kb": generateMarkdown(1024),
  "50kb": generateMarkdown(50 * 1024),
} as const;

export interface FixtureMarkdownStaticProps {
  size: keyof typeof CONTENT;
}

export function FixtureMarkdownStatic({ size }: FixtureMarkdownStaticProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const cardId = useCardId();

  // Publish a range that starts inside this scroller; never clear from the
  // listener, because a focus move away collapses the native selection while
  // the card's published selection is still the one to keep. The entry is
  // cleared on unmount, where it is genuinely going away.
  useLayoutEffect(() => {
    if (cardId === null) return;
    const root = scrollerRef.current;
    if (!root) return;
    const onSelectionChange = () => {
      const sel = root.ownerDocument.getSelection();
      if (sel === null || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const ca = range.commonAncestorContainer;
      if (ca !== root && !root.contains(ca)) return;
      selectionGuard.updateCardDomSelection(cardId, range, domSelectionDirection(sel));
    };
    root.ownerDocument.addEventListener("selectionchange", onSelectionChange);
    return () => {
      root.ownerDocument.removeEventListener("selectionchange", onSelectionChange);
      selectionGuard.updateCardDomSelection(cardId, null);
    };
  }, [cardId]);

  // Registering with no content keeps `bag.content` absent, which is what
  // tells `CardHost` to capture and restore `bag.domSelection` itself ([D07]).
  useCardStatePreservation<undefined>({
    onSave: () => undefined,
    onRestore: () => {},
  });

  return (
    <div
      ref={scrollerRef}
      className="fx-markdown-scroller"
      data-tug-scroll-key="markdown-view"
      tabIndex={0}
    >
      <TugMarkdownBlock initialText={CONTENT[size]} />
    </div>
  );
}

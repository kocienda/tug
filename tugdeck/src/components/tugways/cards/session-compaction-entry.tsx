/**
 * `SessionCompactionEntry` — the in-transcript marker for a `/compact`
 * point — one of the three rows where the ground moves under the transcript,
 * so it wears {@link SessionBoundary}'s anatomy rather than chrome of its own.
 * A compaction swaps the model's context: above the row the session ran on one
 * context and below it on another, which is the same kind of event as a stage
 * rotation or a join. What this module still owns is the compaction's own
 * content — the `Layers` glyph, the label and token count read out of the
 * note, and the recap markdown behind the fold.
 *
 * The recap lives on `compactionSeed.summary` (the single source of truth
 * for the deferred seed); the label + token count come from the compact
 * `system_note` text passed in as `noteText` (per-compaction correct even
 * though the latest-wins seed carries only the most recent summary). With
 * no summary yet the bar is a bare marker with no fold and no chevron, per
 * the boundary's anatomy: a chevron appears only where something folds.
 *
 * Laws:
 * - [L02] `compactionSeed` enters React via `useSyncExternalStore`.
 * - [L19] composes `SessionBoundary`, which composes the shared Tug block
 *   components — no hand-rolled chrome, no borrowed `--tugx-block-*` markup
 *   (the "use existing Tug components" rule).
 *
 * @module components/tugways/cards/session-compaction-entry
 */

import React from "react";
import { Layers } from "lucide-react";

import { SessionBoundary } from "@/components/tugways/cards/session-boundary";
import { TugMarkdownBlock } from "@/components/tugways/tug-markdown-block";
import type { CodeSessionStore } from "@/lib/code-session-store";

/** Stable collapse key — one compaction summary per card (latest-wins seed). */
const COLLAPSE_KEY = "session-compaction";

export function SessionCompactionEntry({
  codeSessionStore,
  noteText,
  inTurn,
}: {
  codeSessionStore: CodeSessionStore;
  /** The compact `system_note` text — "Session compacted · ~Nk tokens". */
  noteText: string;
  /**
   * True when the compaction landed alongside other assistant content and so
   * renders inside the turn's body column, which the boundary pulls back to
   * the transcript's edge. A compaction-only turn is hoisted and omits it.
   */
  inTurn?: boolean;
}): React.ReactElement {
  const compactionSeed = React.useSyncExternalStore(
    codeSessionStore.subscribe,
    () => codeSessionStore.getSnapshot().compactionSeed,
  );

  const summary = compactionSeed?.summary ?? "";
  const hasSummary = summary.length > 0;

  // "Session compacted · ~647k tokens" → label + trailing token count. The
  // count reads as the header's quiet trailing summary, present in both the
  // collapsed and expanded states.
  const [label, ...rest] = noteText.split(" · ");
  const tokensLabel = rest.length > 0 ? rest.join(" · ") : undefined;

  return (
    <SessionBoundary
      kind="compaction"
      glyph={<Layers size={16} aria-hidden="true" />}
      event={label}
      summary={
        tokensLabel !== undefined
          ? { kind: "text", text: tokensLabel }
          : undefined
      }
      fold={hasSummary ? <TugMarkdownBlock initialText={summary} /> : undefined}
      collapseKey={COLLAPSE_KEY}
      copyText={hasSummary ? summary : undefined}
      inTurn={inTurn}
    />
  );
}

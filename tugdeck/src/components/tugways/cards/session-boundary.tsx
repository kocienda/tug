/**
 * `SessionBoundary` — the one row the transcript draws whenever the ground
 * moves under it.
 *
 * Three events change what is UNDERNEATH the conversation rather than saying
 * something in it: a compaction swaps the model's context, an arc's stage
 * rotation swaps the claude session (and usually the model), a join swaps the
 * base the card sits on. Above such a row the transcript ran in one world and
 * below it in another. That is a boundary, and all three wear this shape.
 *
 * What is NOT a boundary: an arc-note ("Step 2/5 closed") or a Tug notice —
 * events that happened ON the ground, which keep their quiet-line seat and the
 * notice's accent rule. The line matters; do not route them here.
 *
 * The anatomy is one thing, three times: a hairline rule across the row, a
 * sunken bar below it, and inside the bar a leading glyph, the bold event, the
 * muted detail, a trailing summary of badges, and a chevron only when
 * something folds behind it.
 *
 * Two shapes in it are deliberate and easy to undo by accident:
 *
 * - **The event and its detail are ONE inline run**, seated together in the
 *   header's detail slot rather than split across the strip's name column and
 *   the detail column beside it. The split version gives the detail a left
 *   edge of its own, so a long join subject's second line hangs under wherever
 *   the detail began instead of returning flush under the event. The slot is
 *   switched to `display: block` in CSS to get normal flow wrapping.
 * - **The name slot is therefore empty, and the accessible name rides
 *   `ariaName`** — the additive prop on `BlockHeader`/`BlockChrome`. Without
 *   it the header's copy and fold buttons would label themselves "block".
 *
 * The seat is always the transcript's full width: a boundary belongs to the
 * transcript, not to a speaker's column. The hoisted seats are already at the
 * edge; the in-turn seat (a boundary that caught a turn open) renders in
 * document order inside the body column and pulls to the edge with a negative
 * inline-start margin equal to `--tugx-transcript-body-inset`. That pull sets
 * no `z-index` and no non-static `position`, so the entry's sticky attribution
 * pin keeps winning the icon column during scroll.
 *
 * Laws:
 * - [L06] the seat, the rule, the pull and the tone are CSS-only — no React
 *   state renders appearance.
 * - [L19] composes the shared Tug block components; no hand-rolled chrome and
 *   no borrowed `--tugx-block-*` markup.
 * - [L20] the `--tugx-block-*` re-tone is a cascade override on this one
 *   marker's class; the token scope stays the chrome's.
 *
 * @module components/tugways/cards/session-boundary
 */

import React from "react";

import { BlockChrome } from "@/components/tugways/blocks/block-chrome";
import { ToolBlockHistoryCollapse } from "@/components/tugways/blocks/collapse-context";
import type { ToolResultSummary } from "@/components/tugways/blocks/tool-result-summary";
import { cn } from "@/lib/utils";

import "./session-boundary.css";

/** Which ground moved. Rides `data-boundary` for tests and per-kind CSS. */
export type SessionBoundaryKind = "compaction" | "stage" | "join";

export interface SessionBoundaryProps {
  /** Which of the three boundaries this is. */
  kind: SessionBoundaryKind;
  /** The leading glyph — `Layers`, `Milestone`, `GitMerge`. */
  glyph: React.ReactNode;
  /**
   * The bold event at the head of the run — "Session compacted",
   * "Stage 3 of 5 · review", "Joined arc-resolve into main". Also the row's
   * accessible name, so it is a string rather than a node.
   */
  event: string;
  /** The muted detail continuing the same inline run. */
  detail?: React.ReactNode;
  /** Numbers ride the trailing summary: tokens, the model, files, rounds. */
  summary?: ToolResultSummary | readonly ToolResultSummary[];
  /**
   * What folds behind the bar. `undefined` means no fold and no chevron —
   * the header is the whole of the row.
   */
  fold?: React.ReactNode;
  /**
   * Collapse key for the fold's history state. Required when `fold` is
   * passed and ignored otherwise.
   */
  collapseKey?: string;
  /** What the header's Copy writes. Defaults to the event. */
  copyText?: string;
  /**
   * True when the boundary is seated inside an open turn's body column, so
   * the wrapper pulls itself back to the transcript's edge.
   */
  inTurn?: boolean;
  /** Forwarded class name on the wrapper. */
  className?: string;
}

export function SessionBoundary({
  kind,
  glyph,
  event,
  detail,
  summary,
  fold,
  collapseKey,
  copyText,
  inTurn = false,
  className,
}: SessionBoundaryProps): React.ReactElement {
  // The event and its detail as one inline run — see the module docstring for
  // why this is not the strip's name slot plus the detail column beside it.
  const line = (
    <span className="session-boundary-line">
      {/* The event is its own findable unit, and the transcript's search index
          projects it as the boundary's first part. Units pair POSITIONALLY
          with projected parts, so a boundary that marks this span must be
          projected with its event first — see `transcript-search-index.ts`. */}
      <span className="session-boundary-event" data-tugx-findable="">
        {event}
      </span>
      {detail !== undefined ? <> {detail}</> : null}
    </span>
  );

  const bar = (
    <BlockChrome
      rootSlot="session-boundary-bar"
      className="session-boundary-bar"
      leading={glyph}
      ariaName={event}
      identity={line}
      resultSummary={summary}
      copyText={copyText ?? event}
    >
      {fold ?? null}
    </BlockChrome>
  );

  return (
    <div
      className={cn("session-boundary", className)}
      data-slot="session-boundary"
      data-boundary={kind}
      data-in-turn={inTurn ? "" : undefined}
    >
      {fold !== undefined && collapseKey !== undefined ? (
        <ToolBlockHistoryCollapse
          toolUseId={collapseKey}
          defaultCollapsed
          copyText={copyText}
        >
          {bar}
        </ToolBlockHistoryCollapse>
      ) : (
        bar
      )}
    </div>
  );
}

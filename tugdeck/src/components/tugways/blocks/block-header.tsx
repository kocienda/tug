/**
 * `BlockHeader` — the one header every tool-call block wears, in every
 * state (the vetted Quiet Line).
 *
 * It has a second tenant outside the transcript: the arc join register
 * wears this header on three surfaces, so that an arc's run reads in the
 * same lifecycle vocabulary a tool call does — pulsing while work is in
 * flight, waiting when a person is being waited on, resting green or red
 * ([D142]). That makes {@link BlockHeaderProps.altitude} a contract with
 * callers outside `blocks/`.
 *
 * One calm row carries tool + target + a trailing result + lifecycle
 * status:
 *
 *   [dot] Name  target …  <result>  | [actions] [⌄]
 *
 * The SAME component renders whether the block is collapsed (header is
 * the whole block), expanded (header above a mounted body), or a tool
 * that never collapses (no chevron). There is no second header component
 * and no fork in the chrome — so the collapsed and expanded presentations
 * cannot drift apart. A long target wraps to more rows while the dot,
 * trailing result, and actions stay on the first row; color comes
 * only from the lifecycle dot (no left-edge status stripe).
 *
 * The trailing result is one quiet one-line `summary`, rendered the same
 * way in both states, so collapsed and expanded read identically.
 *
 * State differences, all driven by `disclosure` (absent ⇒ not
 * collapsible, always expanded):
 *  - **Actions**: the header owns Copy (the call's command + result, from
 *    `copyText`) and the whole-block chevron, both visible in BOTH states
 *    so the affordance cluster reads identically collapsed or expanded.
 *    When expanded it also exposes the actions-slot DOM node via
 *    `actionsSlotRef` so a body kind can `createPortal` its body-specific,
 *    expanded-only controls (Find, view-mode, expand-all) into the slot,
 *    where they sit LEFT of Copy. Body kinds no longer portal their own
 *    Copy or block-level fold — the header owns those.
 *  - **Chevron**: present when collapsible; DOWN to expand (collapsed),
 *    UP to collapse (expanded).
 *
 * Laws:
 *  - [L02] `phase` arrives via props from the consumer's store read.
 *  - [L06] visible state lives on `data-phase` / `data-collapsed` / the
 *    dot's own DOM; no React state drives appearance here.
 *  - [L13] the dot's motion runs through the indicator's TugAnimator path.
 *  - [L19] file pair (`.tsx` + `.css`), docstring, `data-slot`.
 *  - [L20] owns the `--tugx-toolheader-*` token family; reuses the shared
 *    `--tugx-block-*` surface/text tones for chrome-consistent framing.
 *
 * @module components/tugways/blocks/block-header
 */

import "./block-header.css";

import React from "react";

import { cn } from "@/lib/utils";
import { SessionCautionBadge } from "@/components/tugways/chrome/session-caution-badge";
import { TugBadge } from "@/components/tugways/tug-badge";
import { TugProgressIndicator } from "@/components/tugways/tug-progress-indicator";
import {
  useLiveTick,
  formatTimeMinutesSeconds,
} from "@/components/tugways/cards/session-card-telemetry-renderers";
import { useToolCallMeta } from "./collapse-context";

/**
 * Live elapsed clock for an in-flight tool call. Reads the call's start
 * from the ambient {@link useToolCallMeta} (provided once by the
 * transcript renderer — no per-block plumbing) and ticks via the shared
 * 1 Hz {@link useLiveTick}. Mounted by the header ONLY while the call is
 * in flight, so a resting/committed block pays no clock; renders nothing
 * outside a provider (standalone / gallery mounts).
 *
 * Formatting mirrors the Z2 status row's TIME cell exactly
 * ({@link formatTimeMinutesSeconds}): whole seconds only — the 1 Hz tick
 * can't honestly render sub-second — `0m 00s` from the start, zero-padded
 * seconds for a width-stable read under ten minutes. Tabular figures and
 * the `sm` badge size come from the wrapping badge / CSS.
 */
function ToolElapsedClock(): React.ReactElement | null {
  const meta = useToolCallMeta();
  const now = useLiveTick();
  if (meta === null) return null;
  return <>{formatTimeMinutesSeconds(Math.max(0, now - meta.startedAtMs))}</>;
}

/**
 * Format a completed call's recorded wall time. Sub-second calls read in
 * milliseconds (`750ms`) — the only honest resolution at that scale, and
 * finer than the live clock's 1 Hz whole-second tick can offer. Once the
 * call crosses a full second the readout switches to the `Mm SSs` shape
 * ({@link formatTimeMinutesSeconds}) and never shows milliseconds again,
 * matching the in-flight clock's format so a call reads consistently
 * whether it finished in 300ms or three minutes.
 */
function formatToolWallTime(ms: number): string {
  return ms < 1_000
    ? `${Math.round(Math.max(0, ms))}ms`
    : formatTimeMinutesSeconds(ms);
}

/**
 * The header's timing section — its own pipe-delimited slot at the
 * trailing edge, right of the result summary. While the call is in flight
 * it shows the LIVE {@link ToolElapsedClock}; once it lands the clock
 * freezes to the recorded wall time ({@link ToolCallMeta.toolWallMs}), so
 * a resting block still reports how long the call took — the same `0m 20s`
 * shape either way ({@link formatTimeMinutesSeconds}), so the value never
 * changes format when it freezes.
 *
 * The live tick lives inside {@link ToolElapsedClock}, mounted ONLY on the
 * in-flight branch, so a committed/replayed block pays no 1 Hz re-render.
 * Renders nothing outside a provider (standalone / gallery) or when a call
 * has no recorded wall time (its turn ended before the result landed).
 */
function HeaderTiming({
  phase,
}: {
  phase: ToolCallPhase;
}): React.ReactElement | null {
  const meta = useToolCallMeta();
  if (meta === null) return null;
  if (phase === "in_flight") {
    return (
      <span
        className="tool-call-header-timing tug-line-box"
        data-slot="tool-call-header-elapsed"
      >
        <TugBadge
          emphasis="ghost"
          role="inherit"
          size="sm"
          className="tool-call-header-timing-badge"
        >
          <ToolElapsedClock />
        </TugBadge>
      </span>
    );
  }
  if (meta.toolWallMs === null) return null;
  return (
    <span
      className="tool-call-header-timing tug-line-box"
      data-slot="tool-call-header-duration"
    >
      <TugBadge
        emphasis="ghost"
        role="inherit"
        size="sm"
        className="tool-call-header-timing-badge"
      >
        {formatToolWallTime(meta.toolWallMs)}
      </TugBadge>
    </span>
  );
}
import { BlockCopyButton } from "@/components/tugways/body-kinds/affordances/block-copy-button";
import { BlockFoldCue } from "@/components/tugways/body-kinds/affordances/block-fold-cue";
import { BlockStrip, type BlockAltitude } from "./block-strip";
import {
  TOOL_CALL_PHASE_LABELS,
  toolCallPhaseVisual,
  type ToolCallPhase,
} from "@/lib/code-session-store/tool-call-phase-visual";

import { DiffSummaryBadges } from "./diff-summary-badges";
import {
  formatToolResultSummary,
  toolResultSummaryRole,
  type ToolResultSummary,
} from "./tool-result-summary";
import type { CautionFlag } from "./types";

/** Glyph-box diameter of the lifecycle dot, in CSS px (matches the icon). */
const DOT_SIZE = 14;

/** Neutral verb-less label for aria strings when a block has no `toolName`. */
const NEUTRAL_BLOCK_LABEL = "block";


export interface BlockHeaderProps {
  /**
   * Lifecycle phase the leftmost dot paints. Defaults to `idle` (the
   * quiet resting pose) so a standalone/gallery mount that doesn't
   * compute a phase still renders a sane dot.
   */
  phase?: ToolCallPhase;
  /**
   * Canonical tool name (e.g. "Bash"). Optional: a verb-less block (a
   * changeset file row) omits it, so the `.tool-call-header-name` span is
   * not rendered and the identity (`target`) leads the row. The aria-labels
   * that interpolate the name fall back to a neutral "block".
   */
  toolName?: string;
  /**
   * Accessible name for the row when the visible name slot is deliberately
   * empty. `ariaSubject` — what the copy button and the fold cue interpolate
   * into their `aria-label`s — resolves `toolName ?? ariaName ?? "block"`, so
   * a block that seats its name elsewhere in the header (the session
   * boundary puts the event at the head of the detail run, so the run wraps
   * flush) keeps its accessible identity instead of falling back to the
   * neutral label.
   *
   * Purely additive: every caller that passes `toolName` is unaffected. The
   * two alternatives are both worse — a visually hidden span inside the run
   * would be picked up by the transcript's find projection and count matches
   * the painter cannot flash, and an `aria-label` on the header root would be
   * overridden by the labels its own descendant buttons compute from
   * `ariaSubject`.
   */
  ariaName?: string;
  /**
   * Leading glyph rendered in the leftmost slot IN PLACE of the lifecycle
   * dot when provided (a changeset file row puts its commit checkbox here).
   * When absent, the lifecycle `TugProgressIndicator` dot renders as usual —
   * the two are mutually exclusive so the identity row's left edge aligns
   * identically either way.
   */
  leading?: React.ReactNode;
  /**
   * The call's target — a path atom-chip (file tools) or the command text
   * (command tools). Chips size themselves; command text wraps to more
   * rows when long. Wrappers pass `command ?? identity`.
   */
  target?: React.ReactNode;
  /**
   * One-line result summary as DATA — the trailing-info element, rendered
   * quietly (plain muted text) in BOTH states. Tools supply it via
   * `resultSummary` on the chrome. A list renders one pipe-section per entry
   * (a commit reports `5 files │ +39 −17`); the pipe-section rule gives each
   * its own left rule, so any run composes without adjacency cases.
   */
  summary?: ToolResultSummary | readonly ToolResultSummary[];
  /** Drift caution surfaced as an inline badge. */
  caution?: CautionFlag;
  /**
   * Markdown for the whole call (command + result) — what the built-in
   * Copy writes in the COLLAPSED state, where the body isn't mounted to
   * supply its own. When absent/empty, no built-in Copy renders.
   * A `() => string` thunk defers the (potentially large) serialization
   * to the moment Copy is actually pressed.
   */
  copyText?: string | (() => string);
  /**
   * History-collapse chevron + state. When set, the chevron renders at the
   * trailing edge (DOWN to expand when collapsed, UP to collapse when
   * expanded) and `collapsed` selects the built-in Copy (collapsed) vs the
   * body-specific actions slot (expanded). Omit for tools that never
   * collapse — they render no chevron and are always expanded.
   *
   * `disabled` renders the chevron visible but non-interactive — set when the
   * block has no expandable body (expanding would reveal nothing), so the
   * affordance stays in place without offering a dead toggle.
   */
  disclosure?: {
    collapsed: boolean;
    onToggle: (next: boolean) => void;
    disabled?: boolean;
  };
  /**
   * Content rendered inside the actions slot in the EXPANDED state — the
   * chrome's copy / fold cluster for body-bits wrappers. Embedded body
   * kinds portal into the slot node instead (see `actionsSlotRef`).
   */
  actions?: React.ReactNode;
  /**
   * Content rendered on the header's trailing edge, AFTER the standard Copy
   * affordance — a block's own disclosure control, where the whole-block
   * chevron would sit. Visible in both states (unlike `actions`), because a
   * block that discloses part of its own body must be able to say so while
   * the rest of the header is quiet.
   */
  actionsTrailing?: React.ReactNode;
  /**
   * Callback receiving the actions-slot DOM node (EXPANDED state). The
   * chrome captures it and republishes it through
   * `ChromeActionsTargetContext` so embedded body kinds can `createPortal`
   * their affordances into the header.
   */
  actionsSlotRef?: (node: HTMLDivElement | null) => void;
  /**
   * Altitude tier forwarded to {@link BlockStrip} as `data-altitude`
   * ([P03]). `leaf` (default) is today's tool header, pixel-unchanged;
   * `entry` scales a session-entry card, `section` a rail band.
   *
   * The arc join register is the second tenant and uses all three
   * ([D142]): `section` in the rail's Arcs band, `entry` on the Changes
   * shade's arc row, `leaf` in the composer's status row. So a change to
   * a tier's metrics is felt outside the transcript now, and the register
   * is a caller to check.
   */
  altitude?: BlockAltitude;
  /**
   * Forwarded to {@link BlockStrip}: seat the trailing cluster inside the
   * detail column, floated, so a wrapped detail line runs the block's full
   * width instead of stopping at the badges' column. For a header whose
   * detail is prose — a receipt, a boundary — rather than a command.
   */
  flowTrailing?: boolean;
  /** Forwarded class name. */
  className?: string;
}

/**
 * The tool-call header — one quiet row. `ref` targets the root strip; the
 * chrome measures it with a `ResizeObserver` for telescoping-pin height.
 */
export const BlockHeader = React.forwardRef<
  HTMLDivElement,
  BlockHeaderProps
>(function BlockHeader(
  {
    phase = "idle",
    toolName,
    ariaName,
    leading,
    target,
    summary,
    caution,
    copyText,
    disclosure,
    actions,
    actionsTrailing,
    actionsSlotRef,
    altitude = "leaf",
    flowTrailing = false,
    className,
  },
  ref,
) {
  const collapsible = disclosure !== undefined;
  const collapsed = disclosure?.collapsed === true;
  const hasCopy =
    copyText !== undefined &&
    (typeof copyText === "function" || copyText.length > 0);
  // The verb the aria-labels name — the tool when present, else an explicit
  // `ariaName` from a block that seats its name outside the strip's name
  // slot, else a neutral "block" for a verb-less row (a changeset file block).
  const ariaSubject = toolName ?? ariaName ?? NEUTRAL_BLOCK_LABEL;

  // Leftmost slot: a caller-supplied `leading` glyph (a file row's commit
  // checkbox) IN PLACE of the lifecycle dot, or the dot itself. The two are
  // mutually exclusive and share the same box width (`DOT_SIZE`), so the
  // identity row's left edge aligns identically. Composed here and passed to
  // the strip verbatim.
  const leadingNode =
    leading !== undefined ? (
      <span
        className="tool-call-header-leading tug-line-box"
        data-slot="tool-call-header-leading"
      >
        {leading}
      </span>
    ) : (
      <TugProgressIndicator
        variant="pulsing-dot"
        size={DOT_SIZE}
        phase={phase}
        phaseVisual={toolCallPhaseVisual}
        aria-label={TOOL_CALL_PHASE_LABELS[phase]}
        className="tool-call-header-dot tug-line-box"
      />
    );

  // Trailing pipe-sections — the result summary, the live/frozen timing, and
  // the caution badge. Each carries its own `tool-call-header-*` class so the
  // pipe-separator CSS keeps matching. Shown in BOTH states so a streaming
  // Write's growing line count reads LEFT of the live clock rather than
  // waiting for the call to land; the summary's role still carries pass/fail
  // signal (nonzero exit danger, exit 0 success, else neutral `inherit`).
  const summaries =
    summary === undefined ? [] : Array.isArray(summary) ? summary : [summary];
  const trailingNode = (
    <>
      {summaries.map((entry, i) => (
        <span
          // Summaries are a fixed, order-stable list per block kind (never
          // reordered or filtered), so the index is a sound key.
          key={i}
          className="tool-call-header-summary tug-line-box"
          data-slot="tool-call-header-summary"
        >
          {entry.kind === "diff" ? (
            // Diff stat — two ghost badges that take the header's own text
            // color, no green/red tint, so the pair reads as plain metadata
            // (the house monochrome +N −M doctrine, [P27]). Each badge copies
            // its own value on right-click.
            <DiffSummaryBadges added={entry.added} removed={entry.removed} />
          ) : (
            <TugBadge
              emphasis="ghost"
              role={toolResultSummaryRole(entry)}
              size="sm"
            >
              {formatToolResultSummary(entry)}
            </TugBadge>
          )}
        </span>
      ))}
      {/* A LIVE elapsed clock while in flight (the only honest "still working"
          signal for a long silent tool), frozen to the recorded wall time
          once it lands. See {@link HeaderTiming}. */}
      <HeaderTiming phase={phase} />
      {caution !== undefined ? <SessionCautionBadge caution={caution} /> : null}
    </>
  );

  // The trailing actions cluster contents — the strip owns the wrapping
  // `tool-call-header-actions` span; this is what sits inside it.
  const actionsNode = (
    <>
      {/* Body-specific, expanded-only controls (Find, view-mode, expand-all)
          portal into this slot, sitting LEFT of the header-owned Copy +
          chevron. Present only when expanded (the body is mounted); the
          published node lets a body kind's `createPortal` find a target on
          its first render. The header owns Copy + whole-block fold, so body
          kinds no longer portal those. */}
      {!collapsed ? (
        <div
          ref={actionsSlotRef}
          className="tool-call-header-actions-slot"
          data-slot="tool-block-actions"
        >
          {actions}
        </div>
      ) : null}
      {/* Copy + Expand are the two standard header affordances — icon-only
          (the `icon` subtype of the shared `BlockCopyButton` / `BlockFoldCue`)
          and both at the `xs` scale so they read as a matched pair and stay
          quiet across a run of blocks. */}
      {hasCopy ? (
        <BlockCopyButton
          subtype="icon"
          size="xs"
          getText={
            typeof copyText === "function" ? copyText : () => copyText ?? ""
          }
          aria-label={`Copy ${ariaSubject} command and result`}
          data-slot="tool-call-header-copy"
        />
      ) : null}
      {actionsTrailing}
      {collapsible ? (
        <BlockFoldCue
          collapsed={collapsed}
          onToggle={(next) => disclosure?.onToggle(next)}
          collapsedLabel="Expand"
          expandedLabel="Collapse"
          ariaLabelExpand={`Expand ${ariaSubject} tool call`}
          ariaLabelCollapse={`Collapse ${ariaSubject} tool call`}
          size="xs"
          subtype="icon"
          disabled={disclosure?.disabled === true}
          // Whole-block collapse uses the same scroll machinery as every
          // body-fold cue (the default `stabilizeScroll`): release the host's
          // follow-bottom lock before the toggle so the cell-height
          // ResizeObserver flush finds `shouldAutoPin` false and does not slam
          // to the bottom, and position-stabilize the clicked header so it
          // holds its viewport position across the height change.
          data-slot="tool-call-header-disclosure"
        />
      ) : null}
    </>
  );

  return (
    <BlockStrip
      ref={ref}
      altitude={altitude}
      dataSlot="tool-call-header"
      dataPhase={phase}
      dataCollapsed={collapsed}
      className={cn("tool-call-header", className)}
      leading={leadingNode}
      // The verb — omitted for a verb-less row (a changeset file block), where
      // the identity leads instead; the strip renders no name span. The name
      // is searchable in both collapse states: it is header text, always on
      // screen, and `tool-header-projection` projects it for every block.
      name={toolName}
      // An EMPTY verb is marked findable by nobody. A shell exchange passes
      // `toolName=""` — the row identity already frames it — and the strip
      // still renders the span for its layout box, so marking it would put a
      // text-less unit in the row's findable list that no projection can
      // ever match. The units then fall out of correspondence and every
      // match in the row addresses the wrong container ([P02]).
      nameFindable={toolName !== undefined && toolName !== ""}
      // The detail column — the target (chip or wrapping command); the strip's
      // flexible spacer when empty.
      detail={target}
      flowTrailing={flowTrailing}
      trailing={trailingNode}
      actions={actionsNode}
    />
  );
});

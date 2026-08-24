/**
 * TugPopupList — shared frame, row, and footer primitives for the
 * list-shaped popup surfaces anchored to status cells and similar
 * compact triggers.
 *
 * A popup list is a titled panel over the popover surface: a centered
 * uppercase title above a 1px rule, then a body in one of two row
 * vocabularies, then an optional footer (summary text + an action
 * cluster) below a second rule. The two row vocabularies are:
 *
 *  - **Log rows** ({@link TugPopupListGrid} + {@link TugPopupListRow})
 *    — a four-column tabular log (label / preview / annotation /
 *    value). The row list and the summary rows share ONE grid via CSS
 *    subgrid, so column edges align vertically across the scroller and
 *    the always-visible summary block.
 *  - **Item rows** ({@link TugPopupListItem}) — a three-column grid
 *    (leading indicator / text block / trailing action). The trailing
 *    action is a structural column that top-aligns to the row's first
 *    line, so a control beside a two-line item never floats to the
 *    vertical center.
 *
 * Scrolling is owned by {@link TugPopupListScroller}: every list caps
 * its visible height at `--tugx-popup-list-visible-rows` ×
 * `--tugx-popup-list-row-h` (both settable per `data-kind` in CSS) and
 * scrolls the remainder. The scroller optionally sticks to the bottom
 * for append-only logs.
 *
 * Laws: [L06] appearance via CSS/DOM, never React state (tones are
 *       `data-tone` attributes; stick-to-bottom lives in refs);
 *       [L16] pairings declared; [L19] component authoring guide;
 *       [L20] token sovereignty — composed children (TugPushButton,
 *       TugProgressIndicator, TugBadge) keep their own tokens.
 * Decisions: [D02] emphasis × role for footer actions.
 */

import "./tug-popup-list.css";

import React, { useLayoutEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------------------
 * TugPopupListFrame
 * ---------------------------------------------------------------------------*/

/** Width / rhythm variant for a popup list. @selector [data-kind="<kind>"] */
export type TugPopupListKind = "log" | "state" | "item" | "wide";

export interface TugPopupListFrameProps
  extends React.ComponentPropsWithoutRef<"div"> {
  /**
   * Optional panel title — rendered in the titlebar header (left-aligned,
   * medium weight), modeled on the pane title bar. Omit it entirely for a
   * headerless frame: composed inside a {@link TugPlacard}, the placard's own
   * centered header carries the title, so the frame contributes no title chrome.
   */
  title?: string;
  /**
   * Optional leading glyph for the titlebar header (a lucide icon
   * element), mirroring the pane title bar's icon. Ignored when {@link title}
   * is omitted (no header renders at all).
   */
  icon?: React.ReactNode;
  /**
   * Width / rhythm variant. `log` is the narrow tabular default;
   * `state` is the denser state-log; `item` fits leading-dot item
   * rows; `wide` fits gauge + legend bodies.
   * @selector [data-kind="log"] | [data-kind="state"] | [data-kind="item"] | [data-kind="wide"]
   * @default "log"
   */
  kind?: TugPopupListKind;
  /**
   * Footer content rendered below the body, above nothing — supply a
   * {@link TugPopupListFooter}. Omitted, no footer chrome renders.
   */
  footer?: React.ReactNode;
}

/**
 * Popup-list panel: optional title header, body, optional footer. The
 * frame owns the popup's typography (mono, tabular numerals) and its
 * per-kind width caps; it renders no background — the popover surface
 * underneath owns that. Omit `title` for a headerless frame (the
 * composing {@link TugPlacard} supplies the header instead).
 */
export const TugPopupListFrame = React.forwardRef<
  HTMLDivElement,
  TugPopupListFrameProps
>(function TugPopupListFrame(
  { title, icon, kind = "log", footer, className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="tug-popup-list"
      data-kind={kind}
      className={cn("tug-popup-list", className)}
      {...rest}
    >
      {title !== undefined ? (
        <div className="tug-popup-list-title">
          {icon !== undefined ? (
            <span className="tug-popup-list-title-icon" aria-hidden>
              {icon}
            </span>
          ) : null}
          <span className="tug-popup-list-title-text">{title}</span>
        </div>
      ) : null}
      {children}
      {footer !== undefined ? footer : null}
    </div>
  );
});

/* ---------------------------------------------------------------------------
 * TugPopupListScroller
 * ---------------------------------------------------------------------------*/

/**
 * Distance from the bottom (px) within which a stick-to-bottom
 * scroller still counts as "pinned"; scrolling up further than this
 * stops the auto-follow until the user returns to the bottom.
 */
const STICK_THRESHOLD_PX = 8;

export interface TugPopupListScrollerProps
  extends React.ComponentPropsWithoutRef<"div"> {
  /**
   * Keep the newest row in view as rows append, unless the user has
   * scrolled away from the bottom. For append-only logs.
   * @default false
   */
  stickToBottom?: boolean;
}

/**
 * The shared scroll surface for a popup-list body. Caps visible
 * height at `--tugx-popup-list-visible-rows` × `--tugx-popup-list-row-h`
 * (set per `data-kind` on the frame) and scrolls the remainder;
 * horizontal overflow is pinned shut so long content ellipsizes
 * instead of widening the popup. Carries the shared right-edge
 * scrollbar gutter.
 */
export const TugPopupListScroller = React.forwardRef<
  HTMLDivElement,
  TugPopupListScrollerProps
>(function TugPopupListScroller(
  { stickToBottom = false, className, children, onScroll, ...rest },
  ref,
) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef<boolean>(true);

  useLayoutEffect(() => {
    if (!stickToBottom) return;
    const el = innerRef.current;
    if (el === null) return;
    if (!pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  });

  const handleScroll = (ev: React.UIEvent<HTMLDivElement>): void => {
    if (stickToBottom) {
      const el = ev.currentTarget;
      const distanceFromBottom =
        el.scrollHeight - (el.scrollTop + el.clientHeight);
      pinnedRef.current = distanceFromBottom <= STICK_THRESHOLD_PX;
    }
    onScroll?.(ev);
  };

  return (
    <div
      ref={(el) => {
        innerRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref !== null) ref.current = el;
      }}
      data-slot="tug-popup-list-scroller"
      className={cn("tug-popup-list-scroller", className)}
      onScroll={handleScroll}
      {...rest}
    >
      {children}
    </div>
  );
});

/* ---------------------------------------------------------------------------
 * TugPopupListGrid + TugPopupListRow — the tabular log vocabulary
 * ---------------------------------------------------------------------------*/

export interface TugPopupListGridProps {
  /** The scrolling per-entry rows ({@link TugPopupListRow} elements). */
  rows: ReadonlyArray<React.ReactElement>;
  /** Always-visible summary rows below the divider, sharing the grid. */
  summary?: ReadonlyArray<React.ReactElement>;
  /** Rendered when both `rows` and `summary` are empty. */
  empty?: React.ReactNode;
}

/**
 * Four-column log grid (label / preview / annotation / value) shared —
 * via CSS subgrid — between the scrolling row list and the summary
 * footer rows, so every column edge lines up vertically end-to-end.
 * Columns size to the widest content across BOTH blocks.
 */
export function TugPopupListGrid({
  rows,
  summary,
  empty,
}: TugPopupListGridProps): React.ReactElement {
  const summaryRows = summary ?? [];
  const hasRows = rows.length > 0;
  const hasSummary = summaryRows.length > 0;
  if (!hasRows && !hasSummary) {
    return <>{empty ?? null}</>;
  }
  return (
    <div className="tug-popup-list-grid" data-slot="tug-popup-list-grid">
      {hasRows ? (
        <TugPopupListScroller className="tug-popup-list-grid-scroller">
          {rows}
        </TugPopupListScroller>
      ) : (
        <div className="tug-popup-list-grid-empty">{empty ?? null}</div>
      )}
      {hasSummary ? (
        <>
          <div className="tug-popup-list-grid-divider" aria-hidden />
          <div
            className="tug-popup-list-grid-summary"
            data-slot="tug-popup-list-grid-summary"
          >
            {summaryRows}
          </div>
        </>
      ) : null}
    </div>
  );
}

export interface TugPopupListRowProps {
  /** Muted left-aligned label (col 1) — an address pair, "total", etc. */
  label: React.ReactNode;
  /** Optional preview cell (col 2); empty on summary rows. */
  preview?: React.ReactNode;
  /** Right-aligned annotation (col 3): a badge, or a muted hint. */
  badge?: React.ReactNode;
  /** Muted hint text for col 3 when no `badge` is supplied. */
  hint?: string;
  /** Right-aligned emphasized value (col 4). */
  value: string;
}

/**
 * One four-cell row of a {@link TugPopupListGrid}. Cells project into
 * the surrounding grid via subgrid; a missing `preview`/annotation
 * still renders its (empty) cell so the row stays column-aligned.
 */
export function TugPopupListRow({
  label,
  preview,
  badge,
  hint,
  value,
}: TugPopupListRowProps): React.ReactElement {
  return (
    <div className="tug-popup-list-row" data-slot="tug-popup-list-row">
      <span className="tug-popup-list-row-label">{label}</span>
      <span className="tug-popup-list-row-preview">{preview ?? null}</span>
      <span className="tug-popup-list-row-annotation">
        {badge !== undefined ? badge : hint !== undefined ? hint : null}
      </span>
      <span className="tug-popup-list-row-value">{value}</span>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * TugPopupListItem — the leading-indicator item vocabulary
 * ---------------------------------------------------------------------------*/

export interface TugPopupListItemProps
  extends React.ComponentPropsWithoutRef<"div"> {
  /**
   * Leading status indicator (a `TugProgressIndicator`, a
   * {@link TugPopupListToneDot}, …). Top-aligned to the first text
   * line. Omitted, the leading column renders empty and the text
   * block starts flush.
   */
  indicator?: React.ReactNode;
  /**
   * Trailing action control (stop / cancel button). A structural
   * column, top-aligned to the row's first line — never centered
   * across a two-line item, never crushed by long text. Rows without
   * an action reserve no trailing space.
   */
  action?: React.ReactNode;
  /** The item's text — one line, or a {@link TugPopupListItemText}. */
  children: React.ReactNode;
}

/**
 * One item row: `[indicator] [text] [action]` on a three-column grid.
 * `align-items: start` plus the row's own first-line cap alignment
 * make the indicator and action sit on the first line structurally —
 * no margin nudges at callsites.
 */
export const TugPopupListItem = React.forwardRef<
  HTMLDivElement,
  TugPopupListItemProps
>(function TugPopupListItem(
  { indicator, action, className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="tug-popup-list-item"
      className={cn("tug-popup-list-item", className)}
      {...rest}
    >
      <span className="tug-popup-list-item-lead">{indicator ?? null}</span>
      <div className="tug-popup-list-item-body">{children}</div>
      {action !== undefined && action !== null ? (
        <span className="tug-popup-list-item-action">{action}</span>
      ) : null}
    </div>
  );
});

export interface TugPopupListItemTextProps {
  /** Line 1 — the item's description; ellipsized at the row width. */
  primary: React.ReactNode;
  /** Line 2 — muted meta line (addresses, kind, elapsed); optional. */
  meta?: React.ReactNode;
}

/**
 * Two-line item text block: an ellipsized primary line over an
 * optional muted meta line. Lives in an item row's middle column.
 */
export function TugPopupListItemText({
  primary,
  meta,
}: TugPopupListItemTextProps): React.ReactElement {
  return (
    <div
      className="tug-popup-list-item-text"
      data-slot="tug-popup-list-item-text"
    >
      <span className="tug-popup-list-item-primary">{primary}</span>
      {meta !== undefined ? (
        <span className="tug-popup-list-item-meta">{meta}</span>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * TugPopupListGroup
 * ---------------------------------------------------------------------------*/

export interface TugPopupListGroupProps {
  /** Quiet uppercase group heading (e.g. "Running" / "Finished"). */
  label: string;
  children: React.ReactNode;
}

/** A labeled section of item rows. */
export function TugPopupListGroup({
  label,
  children,
}: TugPopupListGroupProps): React.ReactElement {
  return (
    <div className="tug-popup-list-group" data-slot="tug-popup-list-group">
      <div className="tug-popup-list-group-label" aria-hidden>
        {label}
      </div>
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * TugPopupListFooter
 * ---------------------------------------------------------------------------*/

export interface TugPopupListFooterProps {
  /**
   * Muted summary text on the leading edge ("3 done, 1 pending").
   * Omitted (a log whose summary already lives in its grid), the
   * action cluster keeps the trailing edge alone.
   */
  summary?: React.ReactNode;
  /**
   * Action cluster on the trailing edge. Convention: every action is a
   * 2xs push-button-shaped control — `BlockCopyButton` for Copy,
   * `TugPushButton size="2xs" emphasis="outlined"` for the rest — so
   * COPY / CLEAR read identically across every popup list.
   */
  children?: React.ReactNode;
}

/**
 * Popup-list footer: summary left, actions right, above-rule chrome
 * owned here. The action cluster keeps the UI (sans) face against the
 * frame's mono body — the buttons are chrome, not telemetry data.
 */
export function TugPopupListFooter({
  summary,
  children,
}: TugPopupListFooterProps): React.ReactElement {
  return (
    <div className="tug-popup-list-footer" data-slot="tug-popup-list-footer">
      {summary !== undefined && summary !== null ? (
        <span className="tug-popup-list-footer-summary">{summary}</span>
      ) : null}
      {children !== undefined && children !== null ? (
        <span className="tug-popup-list-footer-actions">{children}</span>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * TugPopupListEmpty + TugPopupListToneDot
 * ---------------------------------------------------------------------------*/

/**
 * How an empty body reads. `prose` is a muted italic remark ("No
 * committed turns yet."); `word` is the bare reading for "nothing
 * here" — centered and plain on a row-height box, the same treatment
 * the Lens gives its own empty sections.
 *
 * The split is not decoration. A single word is a *reading*, so it
 * belongs on the axis a value would occupy and italics make it read as
 * an aside; a sentence is a remark, and centering one turns it into a
 * caption. The Lens settled the same distinction from the other side —
 * its `lens-dashes-empty` un-centers itself precisely because that
 * empty is a sentence naming a command.
 *
 * @selector [data-form="<form>"]
 */
export type TugPopupListEmptyForm = "prose" | "word";

/** Empty-state body shared by every popup list. */
export function TugPopupListEmpty({
  className,
  form = "prose",
  children,
  ...rest
}: React.ComponentPropsWithoutRef<"div"> & {
  form?: TugPopupListEmptyForm;
}): React.ReactElement {
  return (
    <div
      className={cn("tug-popup-list-empty", className)}
      data-slot="tug-popup-list-empty"
      data-form={form}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Tone key for a {@link TugPopupListToneDot}. @selector [data-tone="<tone>"] */
export type TugPopupListTone = "default" | "success" | "caution" | "danger";

/**
 * Small status dot colored by semantic tone — the tone rides a
 * `data-tone` attribute into CSS ([L06]); no inline style.
 */
export function TugPopupListToneDot({
  tone,
}: {
  tone: TugPopupListTone;
}): React.ReactElement {
  return (
    <span
      className="tug-popup-list-tone-dot"
      data-slot="tug-popup-list-tone-dot"
      data-tone={tone}
      aria-hidden
    />
  );
}

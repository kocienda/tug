/**
 * `BlockStrip` — the one header shell every Block altitude wears.
 *
 * The shared layout skeleton behind the tool-call header (`BlockHeader`,
 * altitude `leaf`), the session-entry cards (`BlockChrome`, altitude
 * `entry`), and the rail section bands (`LensSection`, altitude
 * `section`). One calm row of slots:
 *
 *   leading  name?  detail …  trailing…  | actions
 *
 * The strip owns only the row STRUCTURE and the three span wrappers it is
 * the sole author of — the name span, the detail span, and the actions
 * span (all stamped with their `tool-call-header-*` class names so the
 * proven `block-header.css` layout — flex, one-line boxes, pipe
 * separators, clamp — keeps matching untouched). Every other slot node
 * (the lifecycle dot or leading glyph, the trailing pipe-sections, the
 * actions cluster contents) is composed by the caller and passed through
 * verbatim, so a caller keeps full control of the tool-specific bits while
 * the family shares one skeleton.
 *
 * Altitude is a token scale keyed on `data-altitude` ([P03]): `leaf`
 * inherits `block-header.css`'s values unchanged; `entry` / `section`
 * override the `--tugx-toolheader-*` family in `block-strip.css`. The
 * structure is shared; the sizes are declarative per altitude ([L17]/[L20]).
 *
 * Laws:
 *  - [L06] appearance via `data-altitude` / `data-phase` / `data-collapsed`
 *    attributes + CSS; no React state drives the strip's look.
 *  - [L19] file pair (`.tsx` + `.css`), docstring, `data-slot`.
 *  - [L20] owns the `--tugx-toolheader-*` token family via the altitude
 *    scale; reuses the shared `--tugx-block-*` tones from `block-header.css`.
 *
 * @module components/tugways/blocks/block-strip
 */

import "./block-strip.css";

import React from "react";

/**
 * The four altitudes of the Block header family.
 *
 * `row` is the newest and the smallest: a band mounted INSIDE a rail list
 * row — under a rail row's two-line block, say — where the row's own type is
 * the 12px rail measure and a child reading a step larger than its parent is
 * the wart. It keeps the section's roomier padding and sans detail face,
 * and takes its sizes from the `xs` scale.
 */
export type BlockAltitude = "leaf" | "entry" | "section" | "row";

export interface BlockStripProps {
  /**
   * Altitude token tier, stamped as `data-altitude` on the root. `leaf`
   * (default) inherits `block-header.css` unchanged; `entry` / `section` /
   * `row` pick up the `block-strip.css` overrides.
   */
  altitude?: BlockAltitude;
  /**
   * The pre-composed leading node — the lifecycle dot
   * (`tool-call-header-dot`) or a caller-wrapped leading glyph span
   * (`tool-call-header-leading`). Passed through verbatim so the two forms
   * stay mutually exclusive and share the dot's box width.
   */
  leading: React.ReactNode;
  /**
   * The bold identity text. When provided the strip wraps it in the
   * `tool-call-header-name` span; when absent (a verb-less file row) no
   * name span renders and the identity leads via `detail`.
   */
  name?: React.ReactNode;
  /**
   * Stamps `data-tugx-findable` on the name span, opting the verb into
   * transcript Find. Set by {@link BlockHeader} for the tool-call header —
   * whose name the search index projects for every block, collapsed or
   * expanded. Off by default so a strip outside the transcript (a rail
   * section band, a changeset file row) contributes no unprojected unit.
   */
  nameFindable?: boolean;
  /**
   * The detail column — the target (a chip, a command, a section's live
   * summary) and, when empty, the flexible spacer that pushes the trailing
   * cluster to the right edge. Always wrapped in the `tool-call-header-detail`
   * span.
   */
  detail?: React.ReactNode;
  /**
   * Seat the trailing cluster INSIDE the detail column, floated, instead of
   * beside it as its own flex item.
   *
   * A row of cells wants the default: the detail is a column, and it ends
   * where the badges begin. A header whose detail is a paragraph does not —
   * a wrapped line has no reason to stop where the badges on the first line
   * stopped, and one that does reads as a tab stop nothing set. Floated, the
   * cluster shortens exactly the line it sits on and every line beneath runs
   * to the block's own right edge.
   *
   * Off by default, so a strip that has not asked for it is laid out
   * identically to before.
   */
  flowTrailing?: boolean;
  /**
   * The trailing pipe-sections — the result summary, timing, caution —
   * pre-composed by the caller with their own `tool-call-header-summary` /
   * `tool-call-header-timing` classes so the pipe-separator CSS keeps
   * matching. Rendered between `detail` and `actions`.
   */
  trailing?: React.ReactNode;
  /**
   * The contents of the trailing actions cluster (a body-kind portal slot,
   * Copy, the fold cue, a section's header actions). The strip wraps these
   * in the `tool-call-header-actions` span so the cluster carries the same
   * pipe rule + gap discipline at every altitude.
   */
  actions?: React.ReactNode;
  /**
   * Root `className`. The caller supplies the base class the layout CSS
   * keys on — `tool-call-header` for the tool header and the section band —
   * so `block-header.css` matches without the strip stamping its own class.
   */
  className?: string;
  /** `data-slot` on the root (e.g. `"tool-call-header"`). Omitted when unset. */
  dataSlot?: string;
  /** `data-testid` on the root (e.g. a section band's `"cards-section-band"`). */
  dataTestid?: string;
  /** Value for `data-phase` on the root (the lifecycle dot's phase). */
  dataPhase?: string;
  /** When `true`, stamps `data-collapsed="true"` on the root. */
  dataCollapsed?: boolean;
  /**
   * Click handler on the strip root. A caller that treats the whole band
   * as an affordance (the rail section bands focus their section's list)
   * wires it here; slot contents that own their own clicks (buttons) stop
   * propagation or are filtered by the caller.
   */
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  /**
   * Pointerdown handler on the strip root. A caller that makes the whole
   * strip draggable (the rail section bands are carried to reorder) wires it
   * here and does its own filtering of presses that landed on a control.
   */
  onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  /**
   * Keydown handler on the strip root. A strip that is itself a keyboard stop
   * reads its own keys here — the rail section bands take Space as the fold,
   * ahead of the synthesized press the engine would otherwise complete as a
   * click ([P02]).
   */
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}

/**
 * The Block header shell — one row of slots. `ref` targets the root strip
 * so a chrome can measure it with a `ResizeObserver` for telescoping-pin
 * height.
 */
export const BlockStrip = React.forwardRef<HTMLDivElement, BlockStripProps>(
  function BlockStrip(
    {
      altitude = "leaf",
      leading,
      name,
      nameFindable = false,
      detail,
      trailing,
      actions,
      flowTrailing = false,
      className,
      dataSlot,
      dataTestid,
      dataPhase,
      dataCollapsed,
      onClick,
      onPointerDown,
      onKeyDown,
    },
    ref,
  ) {
    return (
      <div
        ref={ref}
        data-slot={dataSlot}
        data-testid={dataTestid}
        data-altitude={altitude}
        data-phase={dataPhase}
        data-collapsed={dataCollapsed ? "true" : undefined}
        className={className}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      >
        {/* The lifecycle dot or a caller-wrapped leading glyph. */}
        {leading}
        {/* The bold identity — omitted for a verb-less row. */}
        {name !== undefined ? (
          <span
            className="tool-call-header-name"
            data-tugx-findable={nameFindable ? "" : undefined}
          >
            {name}
          </span>
        ) : null}
        {/* The detail column / flexible spacer — always present. */}
        {/* In flow mode the cluster is the detail's FIRST child, because a
            float only shortens the lines that come after it in the flow. */}
        <span
          className="tool-call-header-detail"
          data-flow={flowTrailing ? "" : undefined}
        >
          {flowTrailing ? (
            <span className="tool-call-header-trailing">
              {trailing}
              <span className="tool-call-header-actions">{actions}</span>
            </span>
          ) : null}
          {detail}
        </span>
        {flowTrailing ? null : (
          <>
            {/* Trailing pipe-sections (summary · timing · caution), composed
                by the caller with their own classes. */}
            {trailing}
            {/* Trailing actions cluster — the strip owns the span so the pipe
                rule + gap discipline is shared at every altitude. */}
            <span className="tool-call-header-actions">{actions}</span>
          </>
        )}
      </div>
    );
  },
);

/**
 * TugBadge — compact status/category label.
 *
 * Pill-shaped, display-only badge for surfacing status, role, or category.
 * Shares the emphasis x role axis system with TugButton.
 * Supports four emphases (filled, outlined, ghost, tinted) and seven roles.
 *
 * A badge is a fancy, colourful *label* — never a button or menu. It carries
 * no interactive affordance of its own (the lone exception is the intrinsic
 * right-click → Copy, which acts on the badge's own text, not on app state).
 * Controls that need to act live in TugButton / TugPushButton / TugPopupButton.
 *
 * Laws: [L06] appearance via CSS, [L16] pairings declared, [L18] tokens from the
 *       seven-slot system, [L19] component authoring guide, [L20] tokens scoped
 *       to the component slot
 * Decisions: [D02] emphasis x role system
 */

import "./tug-badge.css";

import React, { useRef } from "react";
import { cn } from "@/lib/utils";
import { useCopyableText } from "./use-copyable-text";
import { TugStableOverlay } from "./internal/tug-stable-overlay";

// ---- Types ----

/** TugBadge emphasis values — controls visual weight */
export type TugBadgeEmphasis = "filled" | "outlined" | "ghost" | "tinted";

/**
 * TugBadge role values — controls color domain.
 *
 * Seven semantic roles (accent / action / agent / data / danger /
 * success / caution) drive theme-mapped colour pairings (see the
 * `@tug-pairings` table in `tug-badge.css`).
 *
 * The eighth role, `"inherit"`, is the deliberate exception: instead
 * of a theme palette, the badge's text / icon / border resolve to
 * `currentColor`, dropping back to whatever the surrounding text
 * colour is. Use it when a badge should blend into the row it sits
 * in rather than read as a separate signal — the Z1B end-state
 * "OK" tone is the motivating callsite (committed success rows
 * stack a green column otherwise). The four `inherit` × emphasis
 * cells in CSS are all painted in `currentColor`; the primary
 * variant is `ghost-inherit` (transparent bg, currentColor text/
 * icon, no border). See the `tug-badge.css` rules for the full
 * emphasis matrix and notes on which combinations are anti-
 * patterns.
 */
export type TugBadgeRole =
  | "accent"
  | "action"
  | "agent"
  | "data"
  | "danger"
  | "success"
  | "caution"
  | "inherit";

/** TugBadge size names. `2xs` is the most compact — for count or
 * status chips tucked into dense rows — through to the prominent `2xl`. */
export type TugBadgeSize = "2xs" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl";

/**
 * TugBadge layout — single-line pill vs two-line label/content chip.
 *
 * - `single` — the default pill: one row, `children` only (icon + text inline).
 * - `label-top` — two stacked rows with the letter-spaced `label` caption above
 *   the `children` content line. Mirrors the session-card status-bar legend
 *   discipline so ambient chrome reads with one visual vocabulary.
 * - `content-top` — the same two rows in reverse vertical order (content above
 *   label) for the rarer case where the value reads first and the label is a
 *   small caption beneath it.
 *
 * Both two-line layouts keep a stable DOM order (label first, content second);
 * the visual stacking is driven entirely by CSS column direction, never by
 * reordered children. The chip's width resolves to the wider of the two rows.
 */
export type TugBadgeLayout = "single" | "label-top" | "content-top";

/**
 * TugBadge props interface.
 */
export interface TugBadgeProps extends Omit<React.ComponentPropsWithoutRef<"span">, "role"> {
  /**
   * Visual weight.
   * @selector .tug-badge-{emphasis}-{role}
   * @default "tinted"
   */
  emphasis?: TugBadgeEmphasis;
  /**
   * Color domain.
   * @selector .tug-badge-{emphasis}-{role}
   * @default "action"
   */
  role?: TugBadgeRole;
  /**
   * Badge size.
   * @selector .tug-badge-size-2xs | .tug-badge-size-xs | .tug-badge-size-sm | .tug-badge-size-md | .tug-badge-size-lg | .tug-badge-size-xl | .tug-badge-size-2xl
   * @default "sm"
   */
  size?: TugBadgeSize;
  /**
   * Layout arrangement. `single` is the one-row pill (default, non-breaking
   * for every existing call site). `label-top` / `content-top` render the
   * `label` caption and `children` content as two stacked rows.
   * @selector .tug-badge-layout-single | .tug-badge-layout-label-top | .tug-badge-layout-content-top
   * @default "single"
   */
  layout?: TugBadgeLayout;
  /**
   * Letter-spaced uppercase caption line for the two-line layouts. Only
   * meaningful when `layout !== "single"`; ignored in single layout. The
   * content line is always `children`.
   */
  label?: string;
  /** Badge label content (required). */
  children: React.ReactNode;
  /** Lucide icon node rendered before the label. */
  icon?: React.ReactNode;
  /**
   * Override for the gap between the leading icon and the label
   * text, in CSS pixels. Defaults vary by size (3-4 px); pass an
   * explicit value when a callsite needs a tighter or looser
   * spacing than the size's natural gap. Applied as inline style
   * on the badge root (via `style.gap`); takes effect only when
   * an `icon` is supplied.
   */
  iconGap?: number;
  /**
   * Disabled appearance. Dims the badge to the shared control
   * disabled-opacity and makes it non-interactive (`pointer-events: none`,
   * `aria-disabled`). Use when the badge's subject is inapplicable in the
   * current context — e.g. a Code-session chip on the Shell route.
   * @selector .tug-badge-disabled
   * @default false
   */
  disabled?: boolean;
  /**
   * Width-stabilization. When the badge swaps its face in place (e.g. a
   * route indicator toggling between two captions/values), pass the
   * *other* face here so the badge reserves the wider of the two and its
   * neighbors never reflow on the swap. The active face still grows past
   * the reserved width if it must (no clipping). `alternateLabel` /
   * `alternateContent` default to the live `label` / `children` when only
   * one half differs. Composes the shared {@link TugStableOverlay}.
   */
  widthStabilize?: {
    alternateLabel?: React.ReactNode;
    alternateContent?: React.ReactNode;
  };
  /**
   * Explicit text for the right-click → Copy action. When set, Copy writes
   * this string instead of the badge's `textContent`. Two-line chips pass
   * `"Label: value"` so the copied text reads `Session: 96ebc055` rather than
   * the run-together `Session96ebc055`; width-stabilized chips pass only the
   * active face's value so the hidden alternate face is never copied.
   */
  copyText?: string;
}

// ---- TugBadge ----

export const TugBadge = React.forwardRef<HTMLSpanElement, TugBadgeProps>(
  function TugBadge({
    emphasis = "tinted",
    role = "action",
    size = "sm",
    layout = "single",
    label,
    children,
    icon,
    iconGap,
    disabled = false,
    widthStabilize,
    copyText,
    className,
    style,
    ...rest
  }: TugBadgeProps, ref) {
    const emphasisRoleClass = `tug-badge-${emphasis}-${role}`;
    const sizeClass = `tug-badge-size-${size}`;
    const layoutClass = `tug-badge-layout-${layout}`;
    const twoLine = layout !== "single";
    // `iconGap` overrides the size's natural gap (set by the
    // `.tug-badge-size-{sm,md,lg}` CSS rules). Inline style takes
    // precedence per CSS specificity. Caller's `style` wins last
    // if the consumer wants the final say. In a two-line layout the
    // root's `gap` is the row gap between label and content, so the
    // icon-gap override only applies to the single-line layout where
    // the icon sits beside the text on the badge root.
    const mergedStyle: React.CSSProperties | undefined =
      iconGap !== undefined && !twoLine
        ? { gap: `${iconGap}px`, ...style }
        : style;

    // Badges are copyable — right-click → Copy copies the badge's
    // text content. Intrinsic, not opt-in, and a single Copy — the menu
    // every copyable object answers.
    const badgeRef = useRef<HTMLSpanElement | null>(null);
    const copyable = useCopyableText({
      ref: badgeRef as React.MutableRefObject<HTMLElement | null>,
      forwardedRef: ref as React.Ref<HTMLElement>,
      getText: copyText !== undefined ? () => copyText : undefined,
    });

    // Inner content: two-line layouts wrap the caption + value in a
    // `.tug-badge-stack` column; single layout keeps the icon + children
    // inline. DOM order is stable (caption first); `content-top` reverses
    // only the visual order.
    //
    // The text always rides its own `.tug-badge-text` span. The badge root
    // and the two-line content row are flex containers, and `text-overflow`
    // is inert on a flex container — its text is an anonymous flex item with
    // no box to elide, so a constrained badge clips instead of ellipsizing
    // (and a centred one clips off both ends). The span gives the text an
    // elidable box wherever a mount site constrains the badge.
    const buildFace = (
      faceLabel: React.ReactNode,
      faceContent: React.ReactNode,
    ): React.ReactNode =>
      twoLine ? (
        <span className="tug-badge-stack">
          <span className="tug-badge-label">{faceLabel}</span>
          <span className="tug-badge-content">
            {icon && <span className="tug-badge-icon">{icon}</span>}
            <span className="tug-badge-text">{faceContent}</span>
          </span>
        </span>
      ) : (
        <>
          {icon && <span className="tug-badge-icon">{icon}</span>}
          <span className="tug-badge-text">{faceContent}</span>
        </>
      );

    const activeFace = buildFace(label, children);
    // Width-stabilize: overlay the active face over the alternate face in a
    // single grid cell (shared `TugStableOverlay`), so the badge reserves the
    // wider of the two and a face swap never reflows neighbors.
    const inner =
      widthStabilize === undefined ? (
        activeFace
      ) : (
        <TugStableOverlay
          data-slot="tug-badge-stable"
          active={activeFace}
          alternates={[
            buildFace(
              widthStabilize.alternateLabel ?? label,
              widthStabilize.alternateContent ?? children,
            ),
          ]}
        />
      );

    return (
      <>
        <span
          ref={copyable.composedRef as React.Ref<HTMLSpanElement>}
          data-slot="tug-badge"
          // `data-emphasis` lets CSS dispatch on the emphasis
          // axis without parsing the role half of the class name.
          // The "ghost" variant uses it to zero out padding +
          // border (see `tug-badge.css`) so a badge with no
          // visible chrome doesn't reserve layout space for box
          // it never paints.
          data-emphasis={emphasis}
          className={cn(
            "tug-badge",
            sizeClass,
            layoutClass,
            emphasisRoleClass,
            disabled && "tug-badge-disabled",
            className,
          )}
          aria-disabled={disabled || undefined}
          style={mergedStyle}
          onContextMenu={copyable.handleContextMenu}
          {...rest}
        >
          {inner}
        </span>
        {copyable.contextMenu}
      </>
    );
  }
);

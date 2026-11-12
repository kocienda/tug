/**
 * TugLabel — label for form controls.
 *
 * Wraps @radix-ui/react-label for click-to-focus behavior. Supports size
 * variants, multiline with ellipsis truncation (end/start/middle), leading
 * icon, required indicator, and disabled state. All colors via --tug7-* tokens.
 *
 * Laws: [L06] appearance via CSS, [L16] pairings declared, [L19] component authoring guide
 * Decisions: [D04] token-driven control states, [D05] component token naming
 */

import "./tug-label.css";
import type { TugRole, TugTone } from "./tug-vocabulary";

import React, { useRef, useLayoutEffect, useCallback } from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";
import { useCopyableText } from "./use-copyable-text";
import { composeEventHandlers } from "./internal/compose-event-handlers";

// ---- Types ----

/** TugLabel size names — matches --tug-font-size-* theme tokens. */
export type TugLabelSize =
  | "8xs" | "7xs" | "6xs" | "5xs" | "4xs" | "3xs" | "2xs"
  | "xs" | "sm" | "md" | "lg" | "xl"
  | "2xl" | "3xl" | "4xl" | "5xl" | "6xl" | "7xl" | "8xl";

/**
 * TugLabel role — paints the label text in a standard role tone
 * (`--tug7-element-tone-text-normal-<role>-rest`). Use for labels
 * that need to mirror a role-driven accent in a surrounding
 * surface (e.g. a task list row whose dot is
 * `TugProgressIndicator role="action"`). The role suffix follows
 * the same "action → active" alias TugProgressIndicator uses, so the same role name
 * lights up the same color family across both primitives.
 */
export type TugLabelRole = Extract<TugRole, "accent" | "action" | "agent" | "caution" | "danger" | "data" | "success">;

/** Tone for {@link TugLabelProps.iconTone}. */
export type TugLabelIconTone = Extract<TugTone, "accent" | "action" | "agent" | "caution" | "danger" | "data" | "success">;

/** TugLabel text alignment. */
export type TugLabelAlign = "start" | "center" | "end";

/**
 * TugLabel emphasis — a volume scale for how loud the label speaks.
 *
 * - `shout`: bold + ALL CAPS.
 * - `strong`: bold.
 * - `normal` (default): inherits the base weight/style.
 * - `proposal`: muted small caps — true `font-variant-caps` small caps
 *   (≈x-height, so compact) + letter-spacing at the muted `calm` color,
 *   reading as a quiet caption. For descriptive captions paired with an action.
 * - `calm`: muted gray, upright — quieter than normal.
 * - `whisper`: muted gray + italic — like a whisper, the quietest tier.
 *
 * `proposal`, `calm`, and `whisper` paint
 * `--tug7-element-global-text-normal-muted-rest`; `whisper` adds italic and
 * `proposal` adds small caps + letter-spacing on top. When `role` is also set,
 * the emphasis color wins (source order in the cascade), so reach for `role`
 * when a role-driven accent should show through.
 */
export type TugLabelEmphasis = "calm" | "normal" | "proposal" | "shout" | "strong" | "whisper";

/** TugLabel props. */
export interface TugLabelProps extends Omit<React.ComponentPropsWithoutRef<"label">, "children"> {
  /**
   * Label content. A plain string is the common case and the only one
   * the measured `start` / `middle` ellipsis modes can truncate.
   *
   * A node is accepted for inline-decorated text — a title carrying
   * filter-match `<mark>` spans — which clamps through CSS
   * (`ellipsis="end"`, the default) and copies as its flattened text.
   */
  children: React.ReactNode;
  /**
   * Size variant.
   * @selector .tug-label-size-xs | .tug-label-size-sm | .tug-label-size-md | .tug-label-size-lg
   * @default "md"
   */
  size?: TugLabelSize;
  /**
   * Role tone — paints the label with the standard
   * `--tug7-element-tone-text-normal-<role>-rest` token. Use for
   * labels paired with role-driven accents (e.g. an in-progress
   * task row whose ring is `TugProgressIndicator role="action"`).
   * @selector .tug-label-role-action | .tug-label-role-success | …
   */
  role?: TugLabelRole;
  /**
   * Emphasis variant — a volume scale from `shout` (loudest) to
   * `whisper` (quietest). `proposal`, `calm`, and `whisper` all paint
   * the muted text token; `whisper` adds italic and `proposal` adds
   * small caps + letter-spacing (compact caption look).
   * @selector .tug-label-emphasis-calm | .tug-label-emphasis-whisper | .tug-label-emphasis-strong | .tug-label-emphasis-shout | .tug-label-emphasis-proposal
   * @default "normal"
   */
  emphasis?: TugLabelEmphasis;
  /**
   * Use monospace font.
   * @selector .tug-label-mono
   * @default false
   */
  mono?: boolean;
  /**
   * Text alignment.
   * @selector .tug-label-align-center | .tug-label-align-end
   * @default "start"
   */
  align?: TugLabelAlign;
  /**
   * Maximum number of lines before truncation.
   * @default unlimited
   */
  maxLines?: number;
  /**
   * Ellipsis mode when maxLines is exceeded.
   * @selector .tug-label-clamp-none | .tug-label-ellipsis-end | .tug-label-ellipsis-start | .tug-label-ellipsis-middle
   * @default "end"
   */
  ellipsis?: "none" | "end" | "start" | "middle";
  /**
   * Show required indicator (asterisk).
   * @default false
   */
  required?: boolean;
  /**
   * Disabled appearance.
   * @selector .tug-label-disabled
   * @default false
   */
  disabled?: boolean;
  /** Leading icon (React node, typically a Lucide icon). */
  icon?: React.ReactNode;
  /**
   * The leading icon's tone, painted from the `tone-icon` token family.
   * Omit for the label's own text colour.
   * @selector .tug-label-icon[data-tone="<tone>"]
   */
  iconTone?: TugLabelIconTone;
}

// ---- Truncation helpers ----

/**
 * Truncate text from the start: "…bcdef"
 * Used when ellipsis="start" and text overflows maxLines.
 */
function truncateStart(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return "…" + text.slice(text.length - maxLen + 1);
}

/**
 * Truncate text from the middle: "ab…ef"
 * Used when ellipsis="middle" and text overflows maxLines.
 */
function truncateMiddle(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const half = Math.floor((maxLen - 1) / 2);
  const endLen = maxLen - 1 - half;
  return text.slice(0, half) + "…" + text.slice(text.length - endLen);
}

/**
 * Flatten a label's content to plain text — what a copy gesture yields and
 * what the measured truncator counts. Walks strings, numbers, arrays, and
 * element children; anything else (a component, a portal) contributes
 * nothing.
 */
function labelText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(labelText).join("");
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return labelText(props.children);
  }
  return "";
}

// ---- TugLabel ----

export const TugLabel = React.forwardRef<HTMLLabelElement, TugLabelProps>(
  function TugLabel(
    {
      children,
      htmlFor,
      size = "md",
      role,
      emphasis = "normal",
      mono = false,
      align = "start",
      maxLines,
      ellipsis = "end",
      required = false,
      disabled = false,
      icon,
      iconTone,
      className,
      onContextMenu: callerOnContextMenu,
      ...rest
    },
    ref,
  ) {
    const textRef = useRef<HTMLSpanElement>(null);
    const labelRef = useRef<HTMLLabelElement | null>(null);

    // The measured ellipsis modes rewrite `textContent`, so they only apply
    // to string content; a node clamps through CSS instead.
    const text = typeof children === "string" ? children : null;

    // Labels are copyable — right-click → Copy copies the label's text
    // content. This is intrinsic to the component, not opt-in.
    const copyable = useCopyableText({
      ref: labelRef as React.MutableRefObject<HTMLElement | null>,
      getText: () => text ?? labelText(children),
      disabled: false,
      forwardedRef: ref as React.Ref<HTMLElement>,
    });
    // For start/middle ellipsis, we need to measure whether the text overflows
    // and iteratively truncate until it fits. The truncated text is appearance:
    // it is written into its own span (`measuredRef`), which React renders
    // empty, and measured on the clamped text span around it ([L06]).
    const measuredRef = useRef<HTMLSpanElement>(null);
    const needsJSTruncation =
      maxLines !== undefined &&
      maxLines > 0 &&
      text !== null &&
      (ellipsis === "start" || ellipsis === "middle");

    const computeTruncation = useCallback(() => {
      const el = textRef.current;
      const target = measuredRef.current;
      if (!el || !target || !needsJSTruncation || !maxLines || text === null) return;

      // Reset to full text to measure
      target.textContent = text;

      // Check if text actually overflows
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 16;
      const maxHeight = lineHeight * maxLines;

      if (el.scrollHeight <= maxHeight + 1) {
        // No overflow — show full text
        return;
      }

      // Binary search for the right truncation length
      const truncator = ellipsis === "start" ? truncateStart : truncateMiddle;
      let lo = 1;
      let hi = text.length;
      let bestLen = 1;

      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        target.textContent = truncator(text, mid);

        if (el.scrollHeight <= maxHeight + 1) {
          bestLen = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      target.textContent = truncator(text, bestLen);
    }, [text, maxLines, ellipsis, needsJSTruncation]);

    useLayoutEffect(() => {
      computeTruncation();
    }, [computeTruncation]);

    // Observe resize to recompute truncation when container width changes.
    // Debounce via rAF to avoid "ResizeObserver loop completed with
    // undelivered notifications".
    useLayoutEffect(() => {
      if (!needsJSTruncation || !textRef.current) return;

      let rafId = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          computeTruncation();
        });
      });
      observer.observe(textRef.current);
      return () => {
        cancelAnimationFrame(rafId);
        observer.disconnect();
      };
    }, [needsJSTruncation, computeTruncation]);

    // The measured modes draw their text into an empty span the truncation
    // fills; the key gives each mode its own element, so React never
    // reconciles children into a span the measurement wrote.
    const displayText = needsJSTruncation
      ? <span ref={measuredRef} key="measured" />
      : children;

    const hasMaxLines = maxLines !== undefined && maxLines > 0;

    const textClassName = cn(
      "tug-label-text",
      hasMaxLines && ellipsis === "none" && "tug-label-clamp-none",
      hasMaxLines && ellipsis === "end" && "tug-label-ellipsis-end",
      needsJSTruncation && (
        ellipsis === "start" ? "tug-label-ellipsis-start" :
        ellipsis === "middle" ? "tug-label-ellipsis-middle" : undefined
      ),
    );

    const labelClassName = cn(
      "tug-label",
      `tug-label-size-${size}`,
      role !== undefined && `tug-label-role-${role}`,
      emphasis !== "normal" && `tug-label-emphasis-${emphasis}`,
      mono && "tug-label-mono",
      align !== "start" && `tug-label-align-${align}`,
      disabled && "tug-label-disabled",
      className,
    );

    const textStyle = hasMaxLines
      ? { "--tug-label-max-lines": maxLines } as React.CSSProperties
      : undefined;

    return (
      <>
        <LabelPrimitive.Root
          ref={copyable.composedRef as React.Ref<HTMLLabelElement>}
          data-slot="tug-label"
          htmlFor={htmlFor}
          className={labelClassName}
          {...rest}
          onContextMenu={composeEventHandlers(callerOnContextMenu, copyable.handleContextMenu)}
        >
          {icon && (
            <span
              className="tug-label-icon"
              data-tone={iconTone}
              aria-hidden="true"
            >
              {icon}
            </span>
          )}
          <span
            ref={textRef}
            className={textClassName}
            style={textStyle}
          >
            {displayText}
            {required && <span className="tug-label-required" aria-hidden="true"> *</span>}
          </span>
        </LabelPrimitive.Root>
        {copyable.contextMenu}
      </>
    );
  },
);

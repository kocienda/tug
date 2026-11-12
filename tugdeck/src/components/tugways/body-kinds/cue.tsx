/**
 * Cue — banner-shaped inline click target for body-kinds.
 *
 * Fills a gap between `TugPushButton` (uppercase CTA), `TugIconButton`
 * (icon-only trailing action), and `TugBanner` (app-modal status strip):
 * a soft, full-width *banner-shaped click target*. The canonical use case
 * is the collapsed-hint affordance at the bottom of a folded `FileBlock` or
 * `DiffBlock` — *"1,230 lines folded — click to expand."* The cue **is** the
 * button; there's no separate Expand control.
 *
 * Why this primitive exists. Body-kinds (FileBlock, DiffBlock, future
 * siblings) repeatedly need a "soft inline banner that is also a click
 * target." Before Cue, the codebase had bare `<div className="…hint">`
 * elements at the call sites — visually banner-like but not actually
 * clickable, leaving the user with the "click to expand" text and no
 * affordance. None of the existing public Tug components fit:
 *
 *  - `TugPushButton` adds uppercase + letter-spacing (CTA look). Wrong tone
 *    for a soft hint, wrong shape for a full-width banner.
 *  - `TugIconButton` is icon-only and focus-refusing. Wrong shape, wrong
 *    focus discipline.
 *  - `TugBanner` is an app-modal status/error strip with a scrim. Wrong
 *    layer.
 *
 * The Phase 1 design gallery
 * (`tugdeck/src/components/tugways/cards/gallery-tug-cue.tsx`) explored
 * seven candidate shapes; the user picked variant G — *roman text · leading
 * `ChevronsUpDown` icon · subtle accent bg · hairline borders top/bottom*.
 * That is now the OOTB shape of `<Cue>`.
 *
 * ## Two dispatch modes
 *
 * Mirrors `TugButton`'s API: mutually-exclusive `onClick` (direct) and
 * `action` (chain-routable). The chain path is the canonical [L11] shape:
 *
 *  - **Chain-action mode** (`action` prop): on click, dispatch
 *    `{ action, phase: "discrete" }` via the responder chain. When
 *    `target` is set, route via `manager.sendToTarget(target, …)`;
 *    otherwise, fall through to `useControlDispatch().dispatch`. Future
 *    callers wanting chain dispatch (e.g. a SessionThinkingBlock cue
 *    dispatching `revealThinking` to the card) get it without a custom
 *    handler.
 *  - **Direct-action mode** (`onClick` prop): callback fires on click.
 *    The existing FileBlock / DiffBlock call sites use this since their
 *    expanded/collapsed state is local React state, not a chain action.
 *
 * The two are mutually exclusive; passing both produces a dev-mode warning
 * and `action` wins at runtime.
 *
 * ## Keyboard contract
 *
 * The cue is a real `<button>`, so Tab places focus on it and Enter / Space
 * activate it — handled natively by the browser. `aria-expanded` is
 * passed through verbatim so screen readers describe the cue accurately
 * when it gates an expand/collapse interaction. `aria-controls` is passed
 * through for the same reason.
 *
 * ## Visual model
 *
 * Variant G shape, parameterized:
 *
 *  - `role` selects the surface tint. Values match the canonical role
 *    slot in `tuglaws/token-naming.md` and map 1:1 to the
 *    `--tug7-surface-tone-primary-normal-{role}-rest` token family:
 *    `"active"` (default, blue) · `"accent"` (orange) · `"agent"` (violet)
 *    · `"caution"` (yellow) · `"danger"` (red) · `"data"` (teal) ·
 *    `"success"` (green).
 *  - `density` toggles padding:
 *    - `"compact"` (default) — `6px 12px`, matches FileBlock's existing
 *      collapsed-hint dimensions.
 *    - `"regular"` — `10px 16px`, useful for standalone hosts where
 *      the cue isn't compressed into a code-row stack.
 *  - `icon` optionally renders a leading icon node. The Phase 1 design
 *    picked `ChevronsUpDown` for expand/collapse cues; callers pass it
 *    explicitly so the cue stays icon-agnostic at the type level.
 *
 * Laws:
 *  - [L11] controls emit actions; chain-action mode is the canonical L11 shape.
 *  - [L15] hover, focus-visible, active, disabled all defined.
 *  - [L17] component-tier `--tugx-cue-*` aliases resolve to base-tier
 *    `--tug7-*` tokens in one hop.
 *  - [L19] component-authoring guide: file pair, module docstring,
 *    `data-slot="tug-cue"`, exported props interface.
 *  - [L20] every visible declaration in the .css file consumes a
 *    `--tugx-cue-*` token.
 *
 * @module components/tugways/body-kinds/cue
 */

import "./cue.css";
import type { TugDensity, TugRole } from "@/components/tugways/tug-vocabulary";

import React, { useEffect, useId } from "react";
import { cn } from "@/lib/utils";
import { useControlDispatch } from "@/components/tugways/use-control-dispatch";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import type { TugAction } from "@/components/tugways/action-vocabulary";

/* ---------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------------*/

/**
 * Visual role. Determines surface tint, text color, and icon color via the
 * `--tug7-surface-tone-primary-normal-{role}-rest` family for tone roles,
 * or via the inset surface for `"muted"`. The names match the role slot
 * vocabulary in `tuglaws/token-naming.md`.
 *
 *  - `"active"`  (default) — blue tint, for generic informational cues like
 *    "click to expand" (variant G in the Phase 1 design gallery).
 *  - `"accent"`  — orange tint, for highlighted cues.
 *  - `"agent"`   — violet tint, for AI-agent cues.
 *  - `"caution"` — yellow tint, for caution-level cues.
 *  - `"danger"`  — red tint + danger text color, for destructive cues.
 *  - `"data"`    — teal tint, for data-related cues.
 *  - `"success"` — green tint + success text color, for confirmation cues.
 *  - `"muted"`   — neutral gray inset surface (no tone tint), for code-context
 *    cues like diff hunk headers where the host already has its own emphatic
 *    coloring and the cue should sit subdued.
 */
export type CueRole = Extract<TugRole, "active" | "accent" | "agent" | "caution" | "danger" | "data" | "success" | "muted">;

/** Padding density — toggles vertical and horizontal padding. */
export type CueDensity = TugDensity;

/** Label alignment within the cue. Defaults to `"center"`. */
export type CueAlign = "center" | "start";

/** Cue props. */
export interface CueProps {
  /** Banner text content. Required. */
  children: React.ReactNode;

  /**
   * Optional leading icon node. The Phase 1 design uses `ChevronsUpDown`
   * for expand/collapse cues; callers pass it explicitly so this component
   * stays icon-agnostic.
   */
  icon?: React.ReactNode;

  /** Direct-action mode click handler. Mutually exclusive with `action`. */
  onClick?: (e?: React.MouseEvent<HTMLButtonElement>) => void;

  /**
   * Chain-action mode: action name to dispatch on click via the responder
   * chain. Mutually exclusive with `onClick`. Phase: `"discrete"`.
   */
  action?: TugAction;

  /**
   * Explicit-target dispatch: ID of the responder node that should receive
   * the action directly. Overrides the default parent-responder target.
   * Requires `action` to be set; otherwise a dev-mode warning fires and the
   * prop is ignored.
   */
  target?: string;

  /**
   * Visual role. Default: `"active"` (blue tint — variant G's shape).
   * Per `tuglaws/token-naming.md`, `role` is the canonical slot-5 term;
   * each value maps to a `--tug7-surface-tone-primary-normal-{role}-rest`
   * token.
   */
  role?: CueRole;

  /** Padding density. Default: `"compact"`. */
  density?: CueDensity;

  /**
   * Label alignment within the cue. Default: `"center"`. Use `"start"`
   * when the cue hosts code-shaped content that needs a stable left
   * gutter (e.g. diff hunk headers that read down a column of `@@`).
   */
  align?: CueAlign;

  /**
   * Render the label in monospace. Default: `false`. Use for cues whose
   * children are code-shaped (e.g. `@@ -217,21 +217,21 @@`) where the
   * sans default would mangle alignment.
   */
  mono?: boolean;

  /** Disable interaction. Renders as HTML-disabled (`<button disabled>`). */
  disabled?: boolean;

  /**
   * `aria-expanded` passthrough. Set when the cue gates an expand/collapse
   * interaction so screen readers can describe state.
   */
  "aria-expanded"?: boolean;

  /** `aria-controls` passthrough — id of the region the cue controls. */
  "aria-controls"?: string;

  /** `aria-label` passthrough — overrides the visible text when needed. */
  "aria-label"?: string;

  /**
   * Stable sender id for chain-action dispatch. Auto-derived via `useId()`
   * if omitted. Override in tests for deterministic chain logs.
   */
  senderId?: string;

  /** Additional CSS class names. */
  className?: string;
}

/* ---------------------------------------------------------------------------
 * Cue
 * ---------------------------------------------------------------------------*/

/**
 * Banner-shaped inline click target. See module docstring for the dispatch
 * contract, keyboard contract, and visual model.
 */
export const Cue = React.forwardRef<HTMLButtonElement, CueProps>(
  function Cue(
    {
      children,
      icon,
      onClick,
      action,
      target,
      role = "active",
      density = "compact",
      align = "center",
      mono = false,
      disabled = false,
      "aria-expanded": ariaExpanded,
      "aria-controls": ariaControls,
      "aria-label": ariaLabel,
      senderId: senderIdProp,
      className,
    },
    ref,
  ) {
    const fallbackSenderId = useId();
    const senderId = senderIdProp ?? fallbackSenderId;

    const manager = useResponderChain();
    const { dispatch: controlDispatch } = useControlDispatch();

    // Mutual-exclusivity dev warnings — same vocabulary as TugButton /
    // TugIconButton so the rules feel uniform to consumers.
    useEffect(() => {
      if (
        action !== undefined &&
        onClick !== undefined &&
        process.env.NODE_ENV !== "production"
      ) {
        console.warn(
          "Cue: `action` and `onClick` are mutually exclusive. " +
            "When `action` is set, the chain dispatches on click; `onClick` is ignored.",
        );
      }
    }, [action, onClick]);

    useEffect(() => {
      if (
        target !== undefined &&
        action === undefined &&
        process.env.NODE_ENV !== "production"
      ) {
        console.warn(
          "Cue: `target` requires `action` to be set; ignoring `target`.",
        );
      }
    }, [target, action]);

    function handleClick(e?: React.MouseEvent<HTMLButtonElement>) {
      if (disabled) return;
      if (action !== undefined) {
        const event = { action, sender: senderId, phase: "discrete" as const };
        if (target !== undefined && manager !== null) {
          manager.sendToTarget(target, event);
        } else {
          controlDispatch(event);
        }
        return;
      }
      onClick?.(e);
    }

    return (
      <button
        ref={ref}
        type="button"
        data-slot="tug-cue"
        data-tug-cue-role={role}
        data-tug-cue-density={density}
        data-tug-cue-align={align}
        data-tug-cue-mono={mono ? "true" : undefined}
        className={cn("tug-cue", className)}
        disabled={disabled}
        aria-expanded={ariaExpanded}
        aria-controls={ariaControls}
        aria-label={ariaLabel}
        onClick={handleClick}
      >
        {icon !== undefined ? (
          <span className="tug-cue-icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className="tug-cue-label">{children}</span>
      </button>
    );
  },
);

/**
 * `TugInlineDialog` — inline header-bar dialog primitive.
 *
 * The inline counterpart to `TugAlert`: same icon + title + description
 * vocabulary, but rendered inline in transcript flow (or any other
 * ambient layout) rather than as an app-modal overlay. Used as the
 * visual primitive for `PermissionDialog` and `QuestionDialog`, and
 * any future inline-CTA need.
 *
 * Public surface (see `TugInlineDialogProps` for the full contract):
 *
 *   - `icon` — any React node; the consumer chooses the shape. The
 *     primitive sizes the visible icon column to 20 px and tints the
 *     glyph via `iconRole`. The icon's vertical center sits on the
 *     title's first-line center (via `height: calc(font-size ×
 *     line-height)`), so it stays correctly aligned whether or not a
 *     description follows.
 *   - `iconRole` — tone for the icon's `color` (one of five named
 *     roles).
 *   - `title` — strong CTA, plain string.
 *   - `description` — optional rich ReactNode rendered on its own
 *     row directly below the header bar (between the header and the
 *     body slot). Can carry inline icons and `<code>`.
 *   - `leadingActions` — optional cluster rendered on the leading
 *     edge of the header row, right after the icon. Use for wizard
 *     navigation (`Back` / `Next`) or any secondary controls that
 *     belong on the same row as the title.
 *   - `actions` — optional cluster rendered on the trailing edge of
 *     the header row. Use for the dialog's primary controls (`Allow`
 *     / `Deny`, `Cancel` / `Submit`). Callers own the buttons and
 *     therefore own focus management — pass a `ref` through if you
 *     want focus-on-mount.
 *   - `children` — free-form body region rendered between the header
 *     row and the options block. The per-tool body (`DiffBlock`,
 *     `JsonTreeBlock`, transcript-wrapper preview) goes here.
 *   - `options` + `selectedOption` + `onSelectOption` — optional
 *     radio-group of `TugDialogButton`s. Centered, capped at 450 px
 *     wide regardless of frame width. Mandatory single-select.
 *
 * Layout:
 *
 *   +------------------------------------------------------------+
 *   | [icon] [leadingActions] [title]            [actions]       |  ← fixed-height header
 *   | description                                                |
 *   |        {children — inset under the title, equal margins}   |
 *   |               [options — 450 px centered]                  |
 *   +------------------------------------------------------------+
 *
 * Body content is inset by the icon column + its gap so it aligns under
 * the title text, with the trailing edge mirrored for an equal margin on
 * each side (the "sheets" margin model — the icon sets the inset).
 *
 * The header row uses a single fixed-height flex container with the
 * title set to `flex: 1 1 auto`, which absorbs the available space
 * between `leadingActions` and `actions`. When `leadingActions` is
 * omitted (the PermissionDialog shape), the title grows from right
 * after the icon up to the trailing `actions` cluster. All header
 * elements are vertically centered. Description, body, and options
 * stack as their own rows below.
 *
 * Laws:
 *  - [L06] appearance via DOM attributes (`data-icon-role`) + CSS,
 *    not React state. The `iconRole` flips a CSS selector; the icon's
 *    `color` is owned by the rule, not by inline `style`. `data-layout`
 *    is the same shape: `"header"` when the dialog is a header row and
 *    nothing else — no description, no body, no options — and `"full"`
 *    otherwise. The root padding rule reads it, so a header-only frame
 *    pads evenly instead of carrying the bottom inset that exists to
 *    separate the header from rows that are not there.
 *  - [L17] every `--tugx-idialog-*` slot resolves to a `--tug7-*` /
 *    `--tug-*` base token in one hop.
 *  - [L19] component authoring guide — file pair, module docstring,
 *    exported props interface, `data-slot="tug-inline-dialog"` on the
 *    root.
 *  - [L20] component-token sovereignty — owns the `--tugx-idialog-*`
 *    slot family; composes no other component's tokens.
 *  - [L24] state zoning — no React state inside the primitive (it is
 *    a stateless presentation surface; consumers own the open/close
 *    lifecycle, the `selectedOption` value when options are used, and
 *    focus management for whatever buttons they pass in `actions`).
 *
 * @module components/tugways/tug-inline-dialog
 */

import "./tug-inline-dialog.css";

import React from "react";

import { cn } from "@/lib/utils";
import { TugDialogButton } from "./tug-dialog-button";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Tone for the icon's foreground tint. Maps to a `--tugx-idialog-icon-{role}-color` slot. */
export type TugInlineDialogIconRole =
  | "default"
  | "caution"
  | "danger"
  | "success"
  | "info";

/**
 * Descriptor for a single option in the dialog's radio group. Options
 * are mandatory-single-select: one is always chosen, and the only
 * path out of the choice is whatever button the consumer renders in
 * `actions`.
 */
export interface TugInlineDialogOption {
  /** Stable identifier; matched against {@link TugInlineDialogProps.selectedOption}. */
  value: string;
  /** Sentence-case label shown on the option's row (NOT uppercased). */
  label: string;
  /**
   * Optional rich description rendered below the label, muted. ReactNode
   * so consumers can embed inline `<code>`, links, small icons.
   */
  description?: React.ReactNode;
  /**
   * Color domain for the row. `action` (default) paints the standard
   * outline; `danger` paints the destructive variant.
   *
   * @default "action"
   */
  role?: "action" | "danger";
  /** Accessibility label override (defaults to {@link label}). */
  ariaLabel?: string;
}

export interface TugInlineDialogProps {
  /**
   * Icon node — typically a Lucide component. The primitive sizes the
   * column to 20 px and tints the rendered icon's `color` via
   * `iconRole`. The icon's vertical center is pinned to the title's
   * first-line center.
   */
  icon: React.ReactNode;
  /**
   * Tone for the icon's foreground tint. Maps to the
   * `--tugx-idialog-icon-{role}-color` token slots, which resolve to
   * `--tug7-*` icon / text colors in one hop.
   *
   * @default "default"
   */
  iconRole?: TugInlineDialogIconRole;
  /** Strong call-to-action title. Plain string. */
  title: string;
  /**
   * Optional rich description — ReactNode so consumers can embed
   * inline icons and `<code>`. The cohesive sentence belongs here;
   * do not fragment the same idea across multiple slots.
   */
  description?: React.ReactNode;
  /**
   * Optional cluster of controls rendered on the leading edge of the
   * header row, immediately after the icon. Use for wizard navigation
   * (`Back` / `Next`) or any secondary controls that belong on the
   * same row as the title. When omitted, the text column extends from
   * right after the icon up to the trailing `actions` cluster.
   */
  leadingActions?: React.ReactNode;
  /**
   * Optional cluster of controls rendered on the trailing edge of the
   * header row. Use for the dialog's primary controls (`Allow` /
   * `Deny`, `Cancel` / `Submit`). Callers own the buttons and
   * therefore own focus management.
   */
  actions?: React.ReactNode;
  /**
   * Free-form body region inside the dialog between the header row
   * and the options block. For an Edit confirm: a `DiffBlock`. For a
   * Bash request: nothing (the command sits in the description).
   * For a question wizard: the question accordion.
   *
   * Body content is inset on both sides to align under the title (the
   * icon-column margin model); it fills that inset column by default.
   */
  children?: React.ReactNode;
  /**
   * Optional radio-group of choices. Rendered below the body, one row
   * per choice, centered and capped at 450 px wide. When set,
   * consumers MUST also provide {@link selectedOption} +
   * {@link onSelectOption}; the group is mandatory-single-select.
   */
  options?: ReadonlyArray<TugInlineDialogOption>;
  /**
   * The currently selected option's `value`. Required when
   * {@link options} is set; ignored otherwise. The primitive is fully
   * controlled — it never tracks the selection internally.
   */
  selectedOption?: string;
  /**
   * Fired when the user picks a different option. Required when
   * {@link options} is set. The handler should set the consumer's
   * state to the new `value`; do not implement a toggle-off path here
   * — radio semantics mean exactly one option is always chosen.
   */
  onSelectOption?: (value: string) => void;
  /**
   * Optional ARIA label for the radio-group container. Defaults to
   * the dialog's title when omitted.
   */
  optionsAriaLabel?: string;
  /** Forwarded class name for cascade-scoped customization. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for the test suite.
// ---------------------------------------------------------------------------

/** Every {@link TugInlineDialogIconRole}, in declaration order. Pinned for tests. */
export const TUG_INLINE_DIALOG_ICON_ROLES: ReadonlyArray<TugInlineDialogIconRole> =
  ["default", "caution", "danger", "success", "info"];

/**
 * Map an icon role to its `--tugx-idialog-icon-{role}-color` slot
 * name. Pure; exported so tests can pin the contract that every
 * declared role has a matching token slot.
 */
export function iconRoleSlot(role: TugInlineDialogIconRole): string {
  return `--tugx-idialog-icon-${role}-color`;
}

/**
 * Whether the options block should render. False when the array is
 * absent or empty. Pure; exported for tests.
 */
export function shouldRenderOptions(
  options: ReadonlyArray<TugInlineDialogOption> | undefined,
): boolean {
  return options !== undefined && options.length > 0;
}

/**
 * Which layout shape the frame is, from the presence of the three rows that
 * can follow the header. `"header"` when none of them render — the frame is a
 * header bar and nothing else — and `"full"` otherwise. Pure; exported for
 * tests.
 *
 * Taken as resolved booleans rather than as the props themselves so it reads
 * the same values the rows are gated on. A `description={false}` renders no
 * description row, and a layout derived from the raw prop would call that
 * frame `"full"` while the markup showed a bare header.
 */
export function inlineDialogLayout(rows: {
  hasDescription: boolean;
  hasChildren: boolean;
  hasOptions: boolean;
}): "header" | "full" {
  return !rows.hasDescription && !rows.hasChildren && !rows.hasOptions
    ? "header"
    : "full";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Inline header-bar dialog primitive. See module docstring for the
 * layout, prop contract, and law cross-check.
 */
export const TugInlineDialog: React.FC<TugInlineDialogProps> = ({
  icon,
  iconRole = "default",
  title,
  description,
  leadingActions,
  actions,
  children,
  options,
  selectedOption,
  onSelectOption,
  optionsAriaLabel,
  className,
}) => {
  const hasDescription =
    description !== undefined && description !== null && description !== false;
  const hasLeadingActions =
    leadingActions !== undefined &&
    leadingActions !== null &&
    leadingActions !== false;
  const hasActions =
    actions !== undefined && actions !== null && actions !== false;
  const hasChildren =
    children !== undefined && children !== null && children !== false;
  const renderOptions = shouldRenderOptions(options);
  // Derived from the same three predicates the rows below are gated on, so
  // the layout and the markup cannot disagree about which shape this is.
  const layout = inlineDialogLayout({
    hasDescription,
    hasChildren,
    hasOptions: renderOptions,
  });

  return (
    <div
      data-slot="tug-inline-dialog"
      data-icon-role={iconRole}
      data-layout={layout}
      className={cn("tug-inline-dialog", className)}
    >
      <div
        className="tug-inline-dialog-row"
        data-slot="tug-inline-dialog-row"
      >
        <span className="tug-inline-dialog-icon" aria-hidden="true">
          {icon}
        </span>
        {hasLeadingActions ? (
          <div
            className="tug-inline-dialog-leading-actions"
            data-slot="tug-inline-dialog-leading-actions"
          >
            {leadingActions}
          </div>
        ) : null}
        <h3 className="tug-inline-dialog-title">{title}</h3>
        {hasActions ? (
          <div
            className="tug-inline-dialog-actions"
            data-slot="tug-inline-dialog-actions"
          >
            {actions}
          </div>
        ) : null}
      </div>
      {hasDescription ? (
        <div className="tug-inline-dialog-description">{description}</div>
      ) : null}
      {hasChildren ? (
        <div
          className="tug-inline-dialog-body"
          data-slot="tug-inline-dialog-body"
        >
          {children}
        </div>
      ) : null}
      {renderOptions ? (
        <div
          className="tug-inline-dialog-options"
          data-slot="tug-inline-dialog-options"
          role="radiogroup"
          aria-label={optionsAriaLabel ?? title}
        >
          {options!.map((option) => (
            <TugDialogButton
              key={option.value}
              label={option.label}
              description={option.description}
              role={option.role}
              selected={selectedOption === option.value}
              selectionStyle="radio"
              ariaLabel={option.ariaLabel}
              onClick={() => onSelectOption?.(option.value)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

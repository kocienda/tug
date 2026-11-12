/**
 * tug-group-utils — Shared infrastructure for the tug-*-group family of components.
 *
 * Provides common types, constants, and helpers used across tug-radio-group,
 * tug-choice-group, and tug-option-group. Extracts duplicated ROLE_TOKEN_MAP,
 * role type unions, role style injection, keyboard navigation, and icon+label
 * layout rendering so each component can focus on its own visual identity.
 *
 * Laws: [L19] component authoring guide
 */

import "./tug-group-utils.css";
import type { TugRole } from "../tug-vocabulary";

import React from "react";

// ---- Role types and token mapping ----

/**
 * Semantic role for group component on-state color.
 *
 * Omit the role prop (or leave undefined) for the selection axis (blue) — the
 * chosen-item color, independent of the accent/action roles.
 * Explicit roles override with a semantic signal color.
 */
export type TugGroupRole = Extract<TugRole, "option" | "action" | "agent" | "data" | "success" | "caution" | "danger">;

/**
 * Maps role prop values to toggle-primary token suffixes.
 * The prop API uses "action" but the token system uses "active"
 * (e.g., --tug7-surface-toggle-primary-normal-active-rest).
 * "on" is not in this map — it's the implicit default when no role is provided
 * (the selection axis; see below).
 *
 * NOTE: the `action` key here is a role-prop value, not a chain-action
 * name from `TUG_ACTIONS`. The two `action` namespaces are unrelated;
 * audit greps for `action:\s*"…"` will surface this line as a false
 * positive — it is not a dispatch site.
 */
export const ROLE_TOKEN_MAP: Record<string, string> = {
  option:  "option",
  action:  "active",
  agent:   "agent",
  data:    "data",
  success: "success",
  caution: "caution",
  danger:  "danger",
};

/**
 * Returns the token suffix for a given role.
 *
 * Falls back to the `on` role when no role is given — the **selection axis**,
 * a fixed theme color (blue) independent of the accent/action roles. This is
 * the disentanglement: a group's chosen-item indicator is "selected," not the
 * accent brand color, so swapping the accent role never recolors it.
 */
export function getRoleTokenSuffix(role?: TugGroupRole): string {
  if (!role) return "on";
  return ROLE_TOKEN_MAP[role] ?? role;
}

/**
 * Builds the CSS custom property object for role color injection.
 *
 * @param prefix - Component-specific CSS variable prefix (e.g., "radio", "segment", "option")
 * @param role - Optional semantic role; omit for the selection axis (blue)
 *
 * @example
 * buildRoleStyle("radio", "success")
 * // → { "--tugx-radio-on-color": "var(--tug7-surface-toggle-primary-normal-success-rest)", ... }
 *
 * Focus-language role resolution ([P01]/[P02]/[P03] of the focus-language plan):
 * when an explicit role is given, the focus marks of the item-group follow it
 * too — the cursor-item ring (`--tugx-focus-ring`) and the group behind-tint
 * (`--tugx-focus-tint`) are injected from the same role token. With NO role the
 * keys are omitted, so the group rides the global `action` default ([P03]) for
 * its focus marks while its *selection* fill rides the disentangled "on"
 * selection axis (blue) — the two axes stay independent. The CSS that paints
 * the ring/tint lives in `focus-ring.css` (global cursor ring) and each group's
 * own CSS (the container override → behind-tint); this just resolves the color.
 */
export function buildRoleStyle(
  prefix: string,
  role?: TugGroupRole,
): React.CSSProperties {
  const suffix = getRoleTokenSuffix(role);
  const style: Record<string, string> = {
    [`--tugx-${prefix}-on-color`]: `var(--tug7-surface-toggle-primary-normal-${suffix}-rest)`,
    [`--tugx-${prefix}-on-hover-color`]: `var(--tug7-surface-toggle-primary-normal-${suffix}-hover)`,
    [`--tugx-${prefix}-disabled-color`]: `var(--tug7-surface-toggle-primary-normal-${suffix}-disabled)`,
  };
  if (role) {
    // Role-resolved focus marks (cursor ring sits OUTSIDE the item, so the role
    // color reads against the gap; the behind-tint is a faint wash of it).
    style["--tugx-focus-ring"] = `var(--tug7-surface-toggle-primary-normal-${suffix}-rest)`;
    style["--tugx-focus-tint"] = `color-mix(in srgb, var(--tug7-surface-toggle-primary-normal-${suffix}-rest) 18%, transparent)`;
  }
  return style as React.CSSProperties;
}

// ---- Item icon/label rendering ----

/** Props for rendering an icon + label layout inside a group item. */
export interface GroupItemContentProps {
  label?: string;
  icon?: React.ReactNode;
  iconPosition?: "left" | "right" | "both";
}

/**
 * Renders the icon + label layout for group item content.
 *
 * Used by tug-choice-group and tug-option-group. tug-radio-group uses TugButton's
 * own icon rendering instead.
 *
 * Layout rules:
 * - icon only (no label): icon span with className "tug-group-item-icon"
 * - label only (no icon): label span with className "tug-group-item-label"
 * - icon + label (default left): icon span + label span
 * - icon + label (right): label span + icon span
 * - iconPosition="both": icon span + label span + icon span
 */
export function renderGroupItemContent(
  props: GroupItemContentProps,
): React.ReactNode {
  const { label, icon, iconPosition = "left" } = props;

  const iconEl = icon ? (
    <span className="tug-group-item-icon" aria-hidden="true">
      {icon}
    </span>
  ) : null;

  const labelEl = label ? (
    <span className="tug-group-item-label">{label}</span>
  ) : null;

  if (iconEl && !labelEl) {
    return iconEl;
  }
  if (labelEl && !iconEl) {
    return labelEl;
  }
  if (iconEl && labelEl) {
    if (iconPosition === "right") {
      return (
        <>
          {labelEl}
          {iconEl}
        </>
      );
    }
    if (iconPosition === "both") {
      return (
        <>
          {iconEl}
          {labelEl}
          {iconEl}
        </>
      );
    }
    // Default: "left"
    return (
      <>
        {iconEl}
        {labelEl}
      </>
    );
  }
  return null;
}

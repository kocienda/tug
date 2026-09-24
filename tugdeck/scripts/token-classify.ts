#!/usr/bin/env bun
/**
 * token-classify.ts — Shared token classifier for the four-prefix system.
 *
 * Classifies a CSS custom property short name (the part after `--tug-`) into
 * one of the four prefix categories defined in design doc:
 *
 *   tug7  — Seven-slot semantic tokens (element-*, surface-*, effect-*)
 *   tugc  — Color palette tokens (hue constants, named grays, global anchors,
 *            achromatic endpoints)
 *   tugx  — Extension tokens (component aliases, shared utilities)
 *   tug   — Scale/dimension tokens (spacing, radius, font, motion, etc.)
 *
 * Both generate-rename-maps.ts and verify-pairings.ts import from here.
 * No classification logic is duplicated.
 */

import {
  HUE_FAMILIES,
  NAMED_GRAYS,
} from "../src/components/tugways/tugcolor";

// ---------------------------------------------------------------------------
// Constants derived from tugcolor
// ---------------------------------------------------------------------------

/** Set of all hue family names, e.g. "red", "blue", "amber", … */
const HUE_NAMES = new Set(Object.keys(HUE_FAMILIES));

/** Set of all named gray names, e.g. "pitch", "ink", "graphite", … */
const NAMED_GRAY_NAMES = new Set(NAMED_GRAYS);

// ---------------------------------------------------------------------------
// tugx extension allowlist
//
// This is the complete list of known extension/component-alias short names
// discovered by scanning component CSS files for `body {}` block declarations
// and other component-tier utilities that do not fit into tug7, tugc, or tug.
// ---------------------------------------------------------------------------

const TUGX_SHORT_NAMES = new Set<string>([
  // pane chrome aliases (tug-pane.css)
  "pane-accessory-bg",
  "pane-accessory-border",
  "pane-content-dim-desat-amount",
  "pane-content-dim-desat-color",
  "pane-content-dim-wash-amount",
  "pane-content-dim-wash-blend",
  "pane-content-dim-wash-color",
  "pane-control-off-bg-active",
  "pane-control-off-bg-hover",
  "pane-control-off-bg-rest",
  "pane-control-off-border-active",
  "pane-control-off-border-hover",
  "pane-control-off-border-rest",
  "pane-control-off-fg-active",
  "pane-control-off-fg-hover",
  "pane-control-off-fg-rest",
  "pane-control-on-bg-active",
  "pane-control-on-bg-hover",
  "pane-control-on-bg-rest",
  "pane-control-on-border-active",
  "pane-control-on-border-hover",
  "pane-control-on-border-rest",
  "pane-control-on-fg-active",
  "pane-control-on-fg-hover",
  "pane-control-on-fg-rest",
  "pane-findbar-bg",
  "pane-findbar-border",
  "pane-findbar-match",
  "pane-findbar-match-active",
  "pane-banner-backdrop-bg",
  "pane-banner-detail-bg",
  "pane-banner-detail-border",
  "pane-banner-detail-fg",
  "pane-banner-strip-bg",
  "pane-banner-strip-border",
  "pane-banner-strip-fg",
  "pane-bg",
  "pane-border",
  "pane-dim-overlay",
  "pane-shadow-active",
  "pane-shadow-inactive",
  "pane-title-bar-bg-active",
  "pane-title-bar-bg-collapsed",
  "pane-title-bar-bg-inactive",
  "pane-title-bar-divider",
  "pane-title-bar-icon-active",
  "pane-title-bar-icon-hover",
  "pane-title-bar-icon-inactive",
  "pane-title-fg-active",
  "pane-title-fg-inactive",
  // tab
  "tab-add-bg-hover",
  "tab-add-fg",
  "tab-badge-bg",
  "tab-badge-fg",
  "tab-bar-bg",
  "tab-bg-active",
  "tab-bg-compact",
  "tab-bg-hover",
  "tab-bg-rest",
  "tab-close-bg-hover",
  "tab-close-fg-hover",
  "tab-dropTarget-bg",
  "tab-dropTarget-border",
  "tab-fg-active",
  "tab-fg-compact",
  "tab-fg-hover",
  "tab-fg-rest",
  "tab-ghost-bg",
  "tab-ghost-border",
  "tab-insertIndicator",
  "tab-overflow-trigger-bg",
  "tab-overflow-trigger-fg",
  "tab-typePicker-bg",
  "tab-typePicker-fg",
  "tab-underline-active",
  // menu / dropdown
  "menu-bg",
  "menu-border",
  "menu-fg",
  "menu-item-bg-hover",
  "menu-item-bg-selected",
  "menu-item-chevron",
  "menu-item-fg",
  "menu-item-fg-danger",
  "menu-item-fg-disabled",
  "menu-item-icon",
  "menu-item-icon-danger",
  "menu-item-meta",
  "menu-item-shortcut",
  "menu-shadow",
  "dropdown-bg",
  "dropdown-border",
  "dropdown-fg",
  "dropdown-item-bg-hover",
  "dropdown-item-bg-selected",
  "dropdown-item-chevron",
  "dropdown-item-fg",
  "dropdown-item-fg-danger",
  "dropdown-item-fg-disabled",
  "dropdown-item-icon",
  "dropdown-item-icon-danger",
  "dropdown-item-meta",
  "dropdown-item-shortcut",
  "dropdown-shadow",
  // badge
  "badge-accent-bg",
  "badge-accent-fg",
  "badge-neutral-bg",
  "badge-neutral-fg",
  // dialog / sheet / popover
  "dialog-bg",
  "dialog-border",
  "dialog-fg",
  "popover-bg",
  "popover-border",
  "popover-fg",
  "sheet-bg",
  "sheet-border",
  "sheet-fg",
  // dock
  "dock-bg",
  "dock-border",
  "dock-button-badge-bg",
  "dock-button-badge-fg",
  "dock-button-fg",
  "dock-button-fg-active",
  "dock-button-fg-attention",
  "dock-button-insertIndicator",
  "dock-indicator",
  "dock-menu-caret",
  // inspector
  "inspector-bg",
  "inspector-border",
  "inspector-emptyState-fg",
  "inspector-emptyState-icon",
  "inspector-field-bg",
  "inspector-field-border",
  "inspector-field-cancelled",
  "inspector-field-default",
  "inspector-field-inherited",
  "inspector-field-preview",
  "inspector-field-readOnly",
  "inspector-label",
  "inspector-panel-bg",
  "inspector-panel-bg-pinned",
  "inspector-panel-border",
  "inspector-preview-outline",
  "inspector-scrub-active",
  "inspector-scrub-thumb",
  "inspector-scrub-track",
  "inspector-section-bg",
  "inspector-source-class",
  "inspector-source-inline",
  "inspector-source-preview",
  "inspector-source-token",
  "inspector-swatch-border",
  "inspector-target-outline",
  // toggle
  "toggle-on-color",
  "toggle-on-hover-color",
  "toggle-disabled-color",
  // control
  "control-disabled-opacity",
  // host canvas (Swift bridge contract)
  "host-canvas-color",
  // alert
  "alert-bg",
  "alert-fg",
  // chart
  "chart-axis",
  "chart-grid",
  "chart-series-cool",
  "chart-series-coral",
  "chart-series-golden",
  "chart-series-orchid",
  "chart-series-rose",
  "chart-series-verdant",
  "chart-series-violet",
  "chart-series-warm",
  "chart-threshold-danger",
  "chart-threshold-warning",
  "chart-tick",
  "chart-title",
  // chat
  "chat-attachment-bg",
  "chat-attachment-border",
  "chat-attachment-fg",
  "chat-composer-bg",
  "chat-composer-border",
  "chat-message-assistant-bg",
  "chat-message-border",
  "chat-message-user-bg",
  "chat-transcript-bg",
  // code block
  "codeBlock-bg",
  "codeBlock-border",
  "codeBlock-header-bg",
  "codeBlock-header-fg",
  // dev overlay
  "dev-overlay-bg",
  "dev-overlay-border",
  "dev-overlay-fg",
  "dev-overlay-targetDim",
  "dev-overlay-targetHighlight",
  // diff
  "diff-addition-fg",
  "diff-deletion-fg",
  // empty state
  "emptyState-fg",
  "emptyState-icon",
  // feed
  "feed-bg",
  "feed-border",
  "feed-handoff",
  "feed-step-active",
  "feed-step-bg",
  "feed-step-complete",
  "feed-step-error",
  "feed-step-fg",
  "feed-stream-cursor",
  // file status
  "file-status-added",
  "file-status-deleted",
  "file-status-modified",
  "file-status-renamed",
  // gauge
  "gauge-annotation",
  "gauge-fill",
  "gauge-needle",
  "gauge-readout",
  "gauge-threshold-danger",
  "gauge-threshold-warning",
  "gauge-tick-major",
  "gauge-tick-minor",
  "gauge-track",
  "gauge-unit",
  // kbd
  "kbd-bg",
  "kbd-border",
  "kbd-fg",
  // list
  "list-row-hover",
  "list-row-selected",
  // progress
  "progress-fill",
  "progress-track",
  // skeleton
  "skeleton-base",
  "skeleton-highlight",
  // spinner
  "spinner",
  // stat
  "stat-label",
  "stat-trend-negative",
  "stat-trend-neutral",
  "stat-trend-positive",
  "stat-value",
  // syntax
  "syntax-comment",
  "syntax-operator",
  "syntax-punctuation",
  // table
  "table-cell-divider",
  "table-header-bg",
  "table-header-fg",
  "table-row-bg",
  "table-row-bg-hover",
  "table-row-bg-selected",
  "table-row-bg-striped",
  "table-row-border",
  "table-sortIndicator",
  // terminal
  "terminal-bg",
  "terminal-border",
  "terminal-cursor",
  "terminal-fg",
  "terminal-fg-muted",
  // toast
  "toast-info-bg",
  "toast-info-fg",
  // tooltip
  "tooltip-bg",
  "tooltip-border",
  "tooltip-fg",
  // tree
  "tree-chevron",
  "tree-row-bg-selected",
  "tree-row-fg",
]);

// ---------------------------------------------------------------------------
// Public classifier
// ---------------------------------------------------------------------------

export type TugPrefixCategory = "tug7" | "tugc" | "tugx" | "tug";

/**
 * Classify a CSS custom property short name (the part after `--tug-`) into
 * one of the four prefix categories.
 *
 * Classification is deterministic and total: every short name maps to exactly
 * one category. If none of the specific rules match, the fallback is `"tug"`.
 *
 * Rules (applied in priority order):
 *
 * 1. **tug7**: starts with `element-`, `surface-`, or `effect-`
 * 2. **tugc**: matches hue constants, named grays, global anchors, or
 *              achromatic endpoints (black/white)
 * 3. **tugx**: appears in the TUGX_SHORT_NAMES allowlist
 * 4. **tug**: everything else (scales, dimensions, timing, …)
 */
export function classifyTokenShortName(shortName: string): TugPrefixCategory {
  // --- Rule 1: tug7 (seven-slot semantic tokens) ---
  if (
    shortName.startsWith("element-") ||
    shortName.startsWith("surface-") ||
    shortName.startsWith("effect-")
  ) {
    return "tug7";
  }

  // --- Rule 2: tugc (palette tokens) ---
  // Hue constants: {hue}-h, {hue}-canonical-l, {hue}-peak-c
  const HUE_SUFFIXES = ["-h", "-canonical-l", "-peak-c"];
  for (const suffix of HUE_SUFFIXES) {
    if (shortName.endsWith(suffix)) {
      const hueName = shortName.slice(0, shortName.length - suffix.length);
      if (HUE_NAMES.has(hueName)) {
        return "tugc";
      }
    }
  }

  // Named grays: gray-{name}
  if (shortName.startsWith("gray-")) {
    const grayName = shortName.slice("gray-".length);
    if (NAMED_GRAY_NAMES.has(grayName)) {
      return "tugc";
    }
  }

  // Global anchors: l-dark, l-light
  if (shortName === "l-dark" || shortName === "l-light") {
    return "tugc";
  }

  // Achromatic endpoints
  if (shortName === "black" || shortName === "white") {
    return "tugc";
  }

  // --- Rule 3: tugx (extension/component aliases) ---
  if (TUGX_SHORT_NAMES.has(shortName)) {
    return "tugx";
  }

  // --- Rule 4: tug (scale/dimension tokens — default) ---
  return "tug";
}

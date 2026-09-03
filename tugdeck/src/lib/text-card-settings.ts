/**
 * text-card-settings.ts — pure helpers for the Text card editor's
 * settings: the deck-wide defaults a new Text card adopts on first
 * open, and the per-card values that override them thereafter.
 *
 * No React, no DOM, no I/O — every export is a pure function or a
 * constant, so the parse/resolve logic is unit-testable without a
 * store or a rendered component. Tugbank persistence lives in the
 * store / hook that consume these (`default-text-card-store.ts`,
 * `use-text-card-settings.ts`). Mirrors `model.ts`.
 *
 * Two tugbank surfaces, mirroring the model default/per-card split:
 *
 *   - Deck-wide defaults at `dev.tugapp.text-card/settings` — edited in
 *     the Settings card's "Text Card" section.
 *   - Per-card values at `dev.text-card/<cardId>` — the card-local view
 *     settings the gear popup writes. Seeded from the defaults on first
 *     open, then card-local: changing the defaults never disturbs an
 *     open card.
 *
 * Both surfaces hold the same shape ({@link TextCardSettings}): every
 * deck-wide default is a per-card value too.
 *
 * Every field maps to a CodeMirror 6 extension; there is no setting
 * here CM6 cannot back live.
 *
 * @module lib/text-card-settings
 */

import type { TaggedValue } from "@/lib/tugbank-client";
import type { SaveMode } from "@/lib/text-card-store";

/** The per-card, CM6-backed view settings for one Text card editor. */
export interface TextCardSettings {
  /** Line-number gutter. */
  lineNumbers: boolean;
  /** Soft-wrap long lines to the viewport width. */
  lineWrap: boolean;
  /** Auto-expand tabs: the Tab key inserts `tabSize` spaces. */
  softTabs: boolean;
  /** Spaces per tab (indent unit width; also the tab render width). */
  tabSize: number;
  /** Code-folding gutter. */
  foldGutter: boolean;
  /** Highlight the line (and gutter cell) containing the cursor. */
  highlightActiveLine: boolean;
  /** Render space characters as visible dots. */
  showSpaces: boolean;
  /** Render tab characters as visible arrows. */
  showTabs: boolean;
}

/** tugbank domain for per-card Text Card settings (keyed by cardId). */
export const TEXT_CARD_DOMAIN = "dev.text-card";

/**
 * tugbank domain/key for the deck-wide Text Card defaults — the
 * values a brand-new Text card (one with nothing persisted under
 * {@link TEXT_CARD_DOMAIN}) adopts on first open. Set from the
 * Settings card's "Text Card" section; distinct from the per-card domain
 * so changing the defaults never disturbs an open card.
 */
export const TEXT_CARD_DEFAULTS_DOMAIN = "dev.tugapp.text-card";
export const TEXT_CARD_DEFAULTS_KEY = "settings";

/**
 * tugbank key (under {@link TEXT_CARD_DEFAULTS_DOMAIN}) for the deck-wide
 * save-mode default. A separate key from the view `settings` blob;
 * deliberately unexposed in the Settings UI. Values: `"manual"` |
 * `"automatic"`, missing → {@link DEFAULT_TEXT_CARD_SAVE_MODE}.
 */
export const TEXT_CARD_SAVE_MODE_KEY = "save-mode";

/** The save contract a Text card adopts when nothing is configured. */
export const DEFAULT_TEXT_CARD_SAVE_MODE: SaveMode = "manual";

/** Coerce an untrusted stored save-mode value to a {@link SaveMode}. */
export function parseSaveMode(entry: TaggedValue | undefined): SaveMode {
  const value = entry?.value;
  if (value === "manual" || value === "automatic") return value;
  return DEFAULT_TEXT_CARD_SAVE_MODE;
}

/** The view settings a Text card uses when nothing else is configured. */
export const DEFAULT_TEXT_CARD_SETTINGS: TextCardSettings = {
  lineNumbers: true,
  // A card is a column of text in a window the user sizes, not a terminal —
  // reading it should never mean scrolling sideways. A markdown link to an
  // attachment is routinely wider than the card, so with wrap off the very
  // first thing an attachment does is push the document off the right edge.
  lineWrap: true,
  softTabs: true,
  tabSize: 4,
  foldGutter: false,
  highlightActiveLine: true,
  showSpaces: false,
  showTabs: false,
};

/** Clamp an arbitrary number to a sane spaces-per-tab range. */
export function clampTabSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TEXT_CARD_SETTINGS.tabSize;
  return Math.max(1, Math.min(16, Math.round(value)));
}

/** Read a boolean field off an untrusted stored blob, else the fallback. */
function readBool(
  obj: Record<string, unknown>,
  key: keyof TextCardSettings,
  fallback: boolean,
): boolean {
  const v = obj[key];
  return typeof v === "boolean" ? v : fallback;
}

/**
 * Parse the per-card settings out of a tugbank tagged value. Missing or
 * malformed fields fall back to {@link DEFAULT_TEXT_CARD_SETTINGS};
 * a wholly absent / non-json entry yields `null` (no per-card value).
 */
export function parseTextCardSettings(
  entry: TaggedValue | undefined,
): TextCardSettings | null {
  if (entry?.kind !== "json" || entry.value === undefined || entry.value === null) {
    return null;
  }
  const obj = entry.value as Record<string, unknown>;
  const d = DEFAULT_TEXT_CARD_SETTINGS;
  return {
    lineNumbers: readBool(obj, "lineNumbers", d.lineNumbers),
    lineWrap: readBool(obj, "lineWrap", d.lineWrap),
    softTabs: readBool(obj, "softTabs", d.softTabs),
    tabSize: typeof obj.tabSize === "number" ? clampTabSize(obj.tabSize) : d.tabSize,
    foldGutter: readBool(obj, "foldGutter", d.foldGutter),
    highlightActiveLine: readBool(obj, "highlightActiveLine", d.highlightActiveLine),
    showSpaces: readBool(obj, "showSpaces", d.showSpaces),
    showTabs: readBool(obj, "showTabs", d.showTabs),
  };
}

/**
 * The view settings a freshly-mounted Text card should use: its own
 * per-card values when present, otherwise the deck-wide defaults,
 * otherwise the hardcoded defaults. The per-card value always wins, so
 * a card that has been tuned keeps its settings regardless of the
 * deck default. Mirrors `resolveSeedModel`.
 */
export function resolveTextCardSettings(
  persisted: TextCardSettings | null,
  defaults: TextCardSettings | null,
): TextCardSettings {
  if (persisted !== null) return persisted;
  if (defaults !== null) return defaults;
  return { ...DEFAULT_TEXT_CARD_SETTINGS };
}

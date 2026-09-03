/**
 * settings-sections-pref.ts — which Settings section the reader is on.
 *
 * The Settings card is a master/detail tab view: a sidebar of sections on the
 * left, one panel on the right. What is persisted is the **selected section**,
 * so reopening Settings lands the reader where they last were. An absent key
 * (never set) reads as `null` and the card falls back to the first section.
 *
 * Ids outside {@link SETTINGS_SECTION_IDS} read as never-set, which is how a
 * stored id retired by a later build stops steering the card. (Profiles
 * written by the accordion era may still hold a `collapsedSections` entry in
 * this domain; nothing reads it anymore.)
 *
 * Persisted deck-wide through tugbank defaults
 * (`/api/defaults/dev.tugapp.settings-card/selectedSection`, [D07],
 * `feedback_no_localstorage`), not per card: there is at most one Settings
 * card, and where a reader left it is about the reader.
 *
 * Laws: [L02] the tugbank cache enters React through `useTugbankValue`.
 *
 * @module lib/settings-sections-pref
 */

import { useCallback } from "react";

import { getTugbankClient } from "@/lib/tugbank-singleton";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import type { TaggedValue } from "@/lib/tugbank-client";

/** One section of the Settings card. */
export type SettingsSectionId =
  | "general"
  | "sessionCard"
  | "textCard"
  | "viewerCard";

export const SETTINGS_SECTIONS_DOMAIN = "dev.tugapp.settings-card";
export const SETTINGS_SELECTED_KEY = "selectedSection";

/** Every section, in the order the card presents them. */
export const SETTINGS_SECTION_IDS: readonly SettingsSectionId[] = [
  "general",
  "sessionCard",
  "textCard",
  "viewerCard",
];

/** Where a profile that has never chosen lands: the first section. */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "general";

/**
 * Parse a persisted selected section; `null` when nothing valid has ever been
 * stored. An unknown id reads as never-set rather than as a choice.
 */
export function parseSettingsSelectedSection(
  entry: TaggedValue | undefined,
): SettingsSectionId | null {
  if (entry === undefined || typeof entry.value !== "string") return null;
  const stored = entry.value;
  return SETTINGS_SECTION_IDS.includes(stored as SettingsSectionId)
    ? (stored as SettingsSectionId)
    : null;
}

/**
 * Persist the selected section: optimistic local-cache write (so
 * `useTugbankValue` readers re-render instantly) plus the HTTP PUT. A failed
 * PUT logs and otherwise vanishes — the cache holds for the session.
 */
export function writeSettingsSelectedSection(section: SettingsSectionId): void {
  const client = getTugbankClient();
  if (client !== null) {
    client.setLocalValue(SETTINGS_SECTIONS_DOMAIN, SETTINGS_SELECTED_KEY, {
      kind: "string",
      value: section,
    });
  }
  fetch(`/api/defaults/${SETTINGS_SECTIONS_DOMAIN}/${SETTINGS_SELECTED_KEY}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value: section }),
  }).catch((err) => {
    console.warn("[settings-sections-pref] PUT failed:", err);
  });
}

/** The persisted selection plus its setter — the tab view's state. */
export function useSettingsSelectedSection(): {
  selected: SettingsSectionId;
  setSelected: (next: SettingsSectionId) => void;
} {
  const stored = useTugbankValue<SettingsSectionId | null>(
    SETTINGS_SECTIONS_DOMAIN,
    SETTINGS_SELECTED_KEY,
    parseSettingsSelectedSection,
    null,
  );
  const setSelected = useCallback((next: SettingsSectionId) => {
    writeSettingsSelectedSection(next);
  }, []);
  return { selected: stored ?? DEFAULT_SETTINGS_SECTION, setSelected };
}

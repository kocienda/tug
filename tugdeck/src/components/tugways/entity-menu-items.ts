/**
 * entity-menu-items — the registry's item list, as the menu component renders it.
 *
 * `lib/annotator/registry` states what an entity offers in the vocabulary of
 * the entity: an action, a label, whether it is dim right now, and whether a
 * rule sits above it. `TugEditorContextMenu` renders a flat array in which a
 * rule is a row of its own. This module is that translation and nothing else,
 * so the registry never has to know what draws its menu and no surface has to
 * hand-expand a separator into the right position.
 *
 * A leading `separatorBefore` is dropped rather than emitted. Whether an item
 * leads its menu depends on which earlier items the surface's facts turned on,
 * which the registry cannot know when it marks the rule — so the rule is
 * declared where it belongs and suppressed where it would open the menu with a
 * line.
 *
 * @module components/tugways/entity-menu-items
 */

import type { AnnotationMenuEntry } from "@/lib/annotator/registry";
import type { TugEditorContextMenuEntry } from "./tug-editor-context-menu";

/**
 * Expand the registry's entries into the menu component's rows.
 *
 * `drop` removes items a surface cannot service at all — the annotation path
 * uses it for Insert into Prompt where no prompt exists. It is applied before
 * separators are placed, so removing the first item never leaves its rule
 * behind.
 */
export function entityMenuItems(
  entries: readonly AnnotationMenuEntry[],
  drop?: (entry: AnnotationMenuEntry) => boolean,
): TugEditorContextMenuEntry[] {
  const kept = drop === undefined ? [...entries] : entries.filter((e) => !drop(e));
  const rows: TugEditorContextMenuEntry[] = [];
  for (const entry of kept) {
    if (entry.separatorBefore === true && rows.length > 0) {
      rows.push({ type: "separator" });
    }
    rows.push({
      action: entry.action,
      label: entry.label,
      ...(entry.value !== undefined ? { value: entry.value } : {}),
      ...(entry.disabled === true ? { disabled: true } : {}),
    } as TugEditorContextMenuEntry);
  }
  return rows;
}

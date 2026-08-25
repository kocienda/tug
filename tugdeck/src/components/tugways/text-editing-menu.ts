/**
 * text-editing-menu — single source of truth for the standard
 * look-up-in-dictionary / cut / copy / copy-as-plain-text / paste /
 * paste-as-quote / paste-as-plain-text /
 * select-all context menu.
 *
 * The items appear in the same order with the same labels and the
 * same shortcut hints across every text-bearing surface in the
 * suite — the prompt-entry editor, the transcript view, and any
 * future read-only or editable text surface that needs a context
 * menu. The disabled rules are the only thing that varies, and they
 * vary by capability:
 *
 *   - Look Up in Dictionary requires a selection the caller could read as
 *     text (its `lookup` payload).
 *   - Cut requires a selection AND an editable surface.
 *   - Copy requires a selection.
 *   - Copy as Plain Text requires a selection.
 *   - Paste requires an editable surface.
 *   - Paste as Quote / Paste as Plain Text require an editable surface.
 *   - Select All is always enabled.
 *
 * Consumers pass the sampled selection and
 * receive an items array shaped like both `TugContextMenu`'s and
 * `TugEditorContextMenu`'s entry types. The two component types are
 * structurally identical for the fields used here, so consumers
 * pass the result through with a single TypeScript cast at the
 * call site.
 *
 * Why a shared builder rather than a shared item type:
 *   - The two menu components (`TugContextMenu`, `TugEditorContextMenu`)
 *     have slightly different generic and field expectations beyond
 *     the four-item universe, and unifying their entry types is a
 *     larger refactor than this layer needs.
 *   - Capabilities are the part that legitimately varies; the labels,
 *     shortcuts, order, and disabled-rule shape are universal. A
 *     builder gates the variable part and pins the universal part.
 *
 * No icons. The standard text-editing menu is text-only across the
 * suite; the four labels read cleanly as a list and adding icons
 * would crowd the menu without informational gain. Consumer-specific
 * additions (e.g. a custom action above the separator) can pick
 * their own iconography in a follow-up shape — the builder doesn't
 * police that, it just owns the universal set.
 */

import { TUG_ACTIONS } from "./action-vocabulary";
import type { TugAction } from "./action-vocabulary";
import { validateCommandId } from "./command-registry";
import type { CommandValidationSource } from "./command-registry";
import { commandShortcut } from "./keymap-registry";
import { commandValidationSource } from "@/lib/host-menu-state";
import type { DictionaryLookupRequest } from "@/lib/dictionary-lookup";

/**
 * What `buildTextEditingMenuItems` reads to decide which items are enabled.
 *
 * Two inputs, and the split is the point. **Editability comes from the
 * chain** — the same `validateAction` the native Edit menu is gated on, so
 * the context menu and the menu bar cannot disagree about whether a surface
 * accepts a paste. **Selection comes from the caller**, sampled when the
 * menu opens, because it is the one fact the chain deliberately does not
 * carry: the menu-state mirror republishes on focus and registration
 * changes, not on caret moves, so a selection-granular answer from the
 * chain would be stale by the time a menu opened. A context menu is built
 * at the instant it opens and can read the live selection; the menu bar is
 * validated from a snapshot and cannot.
 */
export interface TextEditingMenuCapabilities {
  /**
   * True iff a non-collapsed selection exists and is in scope for
   * the menu's host (e.g. inside the cell that opened the menu).
   * When false: Cut and Copy are disabled — they would be no-ops.
   */
  hasSelection: boolean;
  /**
   * Where editability comes from: the command table's validity, asked of
   * the chain. Defaults to the live source, which is what every in-app
   * surface wants; a caller passes its own only to build a menu for a
   * surface other than the focused one.
   */
  source?: CommandValidationSource;
  /**
   * The selection's text and the point the definition panel should anchor
   * to, sampled when the menu opened — the payload Look Up in Dictionary
   * carries. Omitted (or `null`) when there is nothing selected, in which
   * case the item is present and dim like every other selection verb.
   */
  lookup?: DictionaryLookupRequest | null;
}

/**
 * Shape of one entry in the universal text-editing menu. Only the
 * fields shared by `TugContextMenuEntry` and `TugEditorContextMenuEntry`
 * are described here; consumers cast at the use site.
 */
export interface TextEditingMenuEntry {
  /** Discriminator — `"item"` (default) or `"separator"`. */
  type?: "item" | "separator";
  /** Action to dispatch when the item activates. Omit on separators. */
  action?: TugAction;
  /**
   * The `ActionEvent.value` the dispatch carries, for the rows that name
   * what they act on rather than acting on "whatever is focused". Omit on
   * separators and on the rows that need no argument.
   */
  value?: unknown;
  /** Visible label. Omit on separators. */
  label?: string;
  /** Keyboard-shortcut hint rendered after the label. Display only. */
  shortcut?: string;
  /** Disabled flag — non-interactive when true. */
  disabled?: boolean;
}

/**
 * Build the universal text-editing menu. Order and labels are fixed;
 * disabled state is the command's own validity, narrowed by the sampled
 * selection for the items that need one; the shortcut hint is whatever the
 * command is actually bound to.
 *
 * The hints used to be authored here and matched against the bindings by
 * hand, which is why two of them named the wrong chords for as long as they
 * did — an authored string has nothing to disagree with until someone reads
 * it, and once chords are the user's to rebind it is wrong for anyone who
 * does. Reading the binding is what makes the two unable to differ ([P11]).
 */
export function buildTextEditingMenuItems(
  caps: TextEditingMenuCapabilities,
): TextEditingMenuEntry[] {
  const { hasSelection } = caps;
  const source = caps.source ?? commandValidationSource();
  /** The command's own validity, and a selection where one is required. */
  const off = (command: string, needsSelection: boolean): boolean =>
    (validateCommandId(command, source) ?? true) === false ||
    (needsSelection && !hasSelection);

  /**
   * One row: the label, the live chord, and the validity. A command with no
   * binding shows no hint, and one with several shows the first — the same
   * rule the host's menu sweep applies, so the two surfaces name the same
   * gesture.
   */
  const row = (
    action: TugAction,
    label: string,
    needsSelection: boolean,
  ): TextEditingMenuEntry => {
    const shortcut = commandShortcut(action);
    return {
      action,
      label,
      ...(shortcut !== undefined ? { shortcut } : {}),
      disabled: off(action, needsSelection),
    };
  };

  return [
    // Look Up in Dictionary leads, above its own separator, the way it does
    // in every native text view: it is the one row that reads the selection
    // without touching it, so it sits apart from the verbs that move text.
    // It carries the sampled selection as its value — the chain has no
    // selection-granular answer to fall back on.
    {
      ...row(TUG_ACTIONS.LOOK_UP_IN_DICTIONARY, "Look Up in Dictionary", true),
      // Dim unless there is something to define. A selection the caller
      // cannot read as text — the markdown view's CSS-visual select-all
      // holds no DOM range — is a selection with no word in it, and an
      // enabled row over it would be a press that does nothing.
      disabled: off(TUG_ACTIONS.LOOK_UP_IN_DICTIONARY, true) || caps.lookup == null,
      ...(caps.lookup != null ? { value: caps.lookup } : {}),
    },
    { type: "separator" },
    row(TUG_ACTIONS.CUT, "Cut", true),
    row(TUG_ACTIONS.COPY, "Copy", true),
    row(TUG_ACTIONS.COPY_AS_PLAIN_TEXT, "Copy as Plain Text", true),
    row(TUG_ACTIONS.PASTE, "Paste", false),
    row(TUG_ACTIONS.PASTE_AS_QUOTE, "Paste as Quote", false),
    row(TUG_ACTIONS.PASTE_AS_PLAIN_TEXT, "Paste as Plain Text", false),
    { type: "separator" },
    row(TUG_ACTIONS.SELECT_ALL, "Select All", false),
  ];
}

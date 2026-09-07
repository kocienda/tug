/**
 * settings-keymap-rows.ts — the Keyboard pane's row model.
 *
 * A pure projection from the command registry, the keymap registry, and the
 * override store into the rows the pane renders. Pure on purpose: every
 * interesting question the pane answers — which chord is live, which one is
 * shadowed and by what, which rows the user may change — is a question about
 * data, and keeping it out of the component is what lets those answers be
 * tested without mounting anything.
 *
 * Grouping is by the menu a command's item lives in, read off the item
 * identifier's namespace (`file.save` → File). The frontend does not hold the
 * host's menu tree, but the identifier prefix is the same fact spelled where
 * this side can see it, and a command with no menu item groups under "Other
 * Commands" — which is the honest name for it, since those are exactly the
 * commands the menu bar does not show.
 *
 * @module components/tugways/cards/settings-keymap-rows
 */

import type { CommandBinding, CommandEntry } from "../command-registry";
import { COMMANDS, isCommandLocked } from "../command-registry";
import { formatChord } from "../chord-format";
import type { KeymapRegistry, ResolutionLayer } from "../keymap-registry";
import { keymapRegistry } from "../keymap-registry";

/** One of a command's chords, with whether pressing it reaches the command. */
export interface KeymapRowBinding {
  readonly binding: CommandBinding;
  /** The rendered chord — the one renderer, never a second spelling. */
  readonly label: string;
  /** Pressing this fires this command. */
  readonly active: boolean;
  /** What takes the chord instead. Absent on a live binding. */
  readonly shadowedBy?: {
    readonly commandId: string;
    readonly layer: ResolutionLayer;
  };
  /**
   * The binding is live only inside a responder or a focus mode — shown with
   * its scope named, and rebindable like any other. The scope is the surface's
   * fact, not the user's: the surfaces that register scoped chords read them
   * out of the registry and re-register on its version, so a rebind reaches
   * them the same way a global one reaches the key pipeline. What the pane
   * writes for such a row is the new chord *at the row's existing scope*.
   */
  readonly scoped: boolean;
}

export interface KeymapRow {
  readonly commandId: string;
  readonly title: string;
  /** The menu this command lives in, or `"Other Commands"`. */
  readonly group: string;
  readonly menuItemId?: string;
  /** Policy says this one is not the user's to change ([P12]). */
  readonly locked: boolean;
  /** The user has given this command a keyboard of its own. */
  readonly overridden: boolean;
  /** Every binding, in the order the command declares them. */
  readonly bindings: readonly KeymapRowBinding[];
}

/** Menu-identifier namespace → the menu's name, as the menu bar spells it. */
const GROUP_TITLES: Readonly<Record<string, string>> = {
  app: "Tug",
  file: "File",
  edit: "Edit",
  session: "Session",
  view: "View",
  window: "Window",
  maker: "Maker",
  help: "Help",
};

/** The catch-all: commands that are real and reachable, but not on a menu. */
export const UNGROUPED = "Other Commands";

/** Which group a command's row belongs to. */
export function groupForEntry(entry: CommandEntry): string {
  if (entry.menuItemId === undefined) return UNGROUPED;
  const namespace = entry.menuItemId.split(".")[0];
  return GROUP_TITLES[namespace] ?? UNGROUPED;
}

/** Group ordering — the menu bar's, then the commands that are on no menu. */
export const GROUP_ORDER: readonly string[] = [
  ...Object.values(GROUP_TITLES),
  UNGROUPED,
];

/**
 * Whether a row belongs in the pane at all.
 *
 * Parameterized families are out ([P05]): their payloads are discovered at
 * runtime, so there is no fixed row to rebind — "Theme" is not a command, it
 * is however many themes are on disk. `internal` entries are out too: they
 * exist so the command has a name, but their own comments say no door leads
 * anywhere yet, and a pane that offered a chord for a command nothing
 * performs would be recording dead keystrokes. Everything else is in,
 * including the `native` rows: Quit and Hide are commands the user can look
 * up even though the mechanism will refuse to move them, and a keyboard pane
 * that hid them would be answering "what does ⌘Q do" with silence.
 */
function isListedEntry(entry: CommandEntry): boolean {
  return entry.parameterized !== true && entry.internal !== true;
}

/**
 * How the list is narrowed — one dimension at a time, never two.
 *
 * A person arrives at this pane from either end: "what is Save As bound to"
 * (they type) and "what has ⌘K" (they probe). Those are one narrowing with
 * two entry points, so the filter is a sum rather than two independent
 * predicates ANDed together — a list narrowed by a query AND a chord at once
 * could be empty for a reason neither control shows.
 *
 * The chord case carries command ids rather than a chord to match, because
 * the question was already answered: `probeChord` resolved the chord through
 * the whole layer stack, and matching the rendered label instead would make
 * `⌘K` narrow to `⌃⌘K` as well.
 */
export type KeymapFilter =
  | { readonly kind: "text"; readonly query: string }
  | {
      readonly kind: "chord";
      /** The chord as the pane renders it, for the dismissible pill. */
      readonly label: string;
      readonly commandIds: ReadonlySet<string>;
    };

/** The unnarrowed list — an empty query, which every row matches. */
export const NO_KEYMAP_FILTER: KeymapFilter = { kind: "text", query: "" };

/**
 * Does this row survive the filter? Title, command id, and chord label for a
 * typed query; membership for a probed chord.
 */
export function rowMatches(row: KeymapRow, filter: KeymapFilter): boolean {
  if (filter.kind === "chord") return filter.commandIds.has(row.commandId);
  const q = filter.query.trim().toLowerCase();
  if (q === "") return true;
  if (row.title.toLowerCase().includes(q)) return true;
  if (row.commandId.toLowerCase().includes(q)) return true;
  return row.bindings.some((b) => b.label.toLowerCase().includes(q));
}

/**
 * Build every row, grouped and ordered the way the pane shows them.
 *
 * `overridden` names the commands carrying a user override; it is passed in
 * rather than read, so this stays a function of its arguments and the pane's
 * store subscription stays the pane's business.
 */
export function buildKeymapRows(
  overridden: ReadonlySet<string>,
  registry: KeymapRegistry = keymapRegistry,
  entries: readonly CommandEntry[] = COMMANDS,
): KeymapRow[] {
  const rows: KeymapRow[] = [];
  for (const entry of entries) {
    if (!isListedEntry(entry)) continue;
    const resolved = registry.bindingsFor(entry.id);
    rows.push({
      commandId: entry.id,
      title: entry.title,
      group: groupForEntry(entry),
      ...(entry.menuItemId !== undefined
        ? { menuItemId: entry.menuItemId }
        : {}),
      locked: isCommandLocked(entry.id),
      overridden: overridden.has(entry.id),
      bindings: resolved.map((r) => ({
        binding: r.binding,
        label: formatChord(r.binding.chord),
        active: r.active,
        ...(r.shadowedBy !== undefined ? { shadowedBy: r.shadowedBy } : {}),
        scoped: r.binding.scope.kind !== "global",
      })),
    });
  }
  const groupRank = new Map(GROUP_ORDER.map((g, i) => [g, i]));
  rows.sort((a, b) => {
    const ga = groupRank.get(a.group) ?? GROUP_ORDER.length;
    const gb = groupRank.get(b.group) ?? GROUP_ORDER.length;
    if (ga !== gb) return ga - gb;
    return a.title.localeCompare(b.title);
  });
  return rows;
}

/**
 * The id of the chord-probe row.
 *
 * A sentinel in the same namespace command ids live in, because the pane's
 * arming slot holds one or the other and exclusivity is worth getting from
 * the type rather than from two booleans that have to agree. No command may
 * be called this; the leading `__` is what makes that true.
 */
export const PROBE_ROW_ID = "__probe__";

/** A row in the pane's flat list: a group heading, a command, or the probe. */
export type KeymapListItem =
  | {
      readonly kind: "group";
      readonly id: string;
      readonly title: string;
      /**
       * The first heading in the list. Sections are separated by space above
       * the heading, and the first one has nothing to be separated from — a
       * windowed list cannot ask CSS for `:first-child`, since that reads
       * against the rendered window rather than the data.
       */
      readonly first: boolean;
    }
  /**
   * The chord probe. A row like any other — same title column, same accessory
   * band, same capture strip underneath — because it asks the same kind of
   * question a command row asks and inventing a second layout for it would
   * make the pane read as two panes.
   */
  | { readonly kind: "probe"; readonly id: typeof PROBE_ROW_ID }
  | {
      readonly kind: "command";
      readonly id: string;
      readonly row: KeymapRow;
      /**
       * Which band the row takes, counted from the top of ITS SECTION rather
       * than from the top of the list. A section following one with an odd
       * number of rows would otherwise start on the opposite foot, and the
       * banding would read as stripes running continuously under the
       * headings instead of each menu counting from its own first command.
       */
      readonly parity: "even" | "odd";
    };

/**
 * Flatten rows into the list's items, dropping any group the filter emptied.
 *
 * A heading over nothing is a lie about what the list holds, and under a
 * narrow query most of them are empty — so the headings follow the filter
 * rather than standing over it.
 *
 * The Test section is the exception, and stands whatever the filter says: it
 * is a control rather than a result, and a filter that hid the thing you
 * narrow the list WITH would take the tool away at the moment it worked. It
 * also keeps the verdict on screen above the rows a probed chord narrowed to,
 * which is where the answer wants to be read.
 */
export function buildKeymapListItems(
  rows: readonly KeymapRow[],
  filter: KeymapFilter,
): KeymapListItem[] {
  const items: KeymapListItem[] = [
    { kind: "group", id: "group:Test", title: "Test", first: true },
    { kind: "probe", id: PROBE_ROW_ID },
  ];
  let group: string | null = null;
  let withinGroup = 0;
  for (const row of rows) {
    if (!rowMatches(row, filter)) continue;
    if (row.group !== group) {
      group = row.group;
      withinGroup = 0;
      items.push({
        kind: "group",
        id: `group:${group}`,
        title: group,
        first: false,
      });
    }
    items.push({
      kind: "command",
      id: row.commandId,
      row,
      parity: withinGroup % 2 === 0 ? "even" : "odd",
    });
    withinGroup += 1;
  }
  return items;
}

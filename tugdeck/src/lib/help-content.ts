/**
 * help-content.ts — pure content + command projection for the `/help` sheet
 * ([#step-13b2]).
 *
 * The `/help` sheet ([D16]) mirrors the Claude Code terminal's tabbed help:
 * a **General** tab (what the Session card is + key shortcuts + a pointer to the
 * unsupported-commands doc), a **Commands** tab (the built-in slash commands),
 * and a **Custom commands** tab (plugin / user skills + agents). This module is
 * the pure, testable core: the static General-tab copy and a projection of the
 * session command catalog into the two browsable lists.
 *
 * The command projection is the same allowlist policy the slash popup applies
 * ([D14]): hidden commands ([#step-13a]) never appear, and the [D23]
 * local-command registry is always present (with its curated descriptions) so
 * the list is useful even before the `initialize` handshake catalog lands. The
 * result is "exactly what the popup offers," grouped built-in vs custom and
 * sorted alphabetically — matching the terminal's two browse sections.
 *
 * Pure data + a pure projection — no React, no DOM, no store dependency.
 *
 * @module lib/help-content
 */

import { TUG_ACTIONS } from "@/lib/action-vocabulary";
import { commandShortcuts } from "../components/tugways/keymap-registry";
import { LOCAL_SLASH_COMMANDS } from "./slash-commands";
import { isHiddenSlashCommand } from "./slash-supported";
import type { SlashCommandInfo } from "./session-metadata-store";

// ---------------------------------------------------------------------------
// General-tab copy — what the Session card is, and the useful shortcuts
// ---------------------------------------------------------------------------

/** Lead paragraph at the top of the General tab. */
export const HELP_INTRO =
  "The Session card unifies shell commands and AI conversations in one command surface — " +
  "talk to Claude, run shell commands, and inspect your project without leaving the prompt.";

/** One keyboard shortcut row on the General tab. */
export interface HelpShortcut {
  /** Rendered key combo, e.g. `"⌃⌘C"`. */
  readonly keys: string;
  /** What it does. */
  readonly label: string;
}

/**
 * Which commands the help sheet is worth spending a row on — a tight, true
 * set, not the full binding table. `/` is the one typed command namespace and
 * has no chord to read; every other row names a command and takes its keys
 * from whatever that command is actually bound to.
 *
 * Reading rather than authoring is the whole point: a help sheet is read by
 * someone who does not yet know the chord, so it is the last place that can
 * afford to carry its own copy of one — and once chords are the user's to
 * rebind, an authored string is wrong for anyone who rebinds ([P11]).
 */
const HELP_SHORTCUT_ROWS: ReadonlyArray<{
  readonly commandId?: string;
  readonly keys?: string;
  readonly label: string;
}> = [
  { keys: "/", label: "Slash commands" },
  { commandId: TUG_ACTIONS.OPEN_COMMAND_PICKER, label: "Open the slash-command popup" },
  { commandId: `${TUG_ACTIONS.SELECT_COMPOSER_ROUTE}:prompt`, label: "Prompt route" },
  { commandId: TUG_ACTIONS.TOGGLE_CHANGES_VIEW, label: "Changes route — show or hide Changes" },
  { commandId: TUG_ACTIONS.FIND, label: "Show / hide the find bar" },
  { commandId: TUG_ACTIONS.FIND_NEXT, label: "Next match" },
  { commandId: TUG_ACTIONS.FIND_PREVIOUS, label: "Previous match" },
  { commandId: TUG_ACTIONS.TOGGLE_HISTORY_VIEW, label: "Show or hide the History Shade" },
  { commandId: TUG_ACTIONS.CYCLE_PERMISSION_MODE, label: "Cycle the permission mode" },
  { commandId: TUG_ACTIONS.NEXT_TAB, label: "Next card" },
  { commandId: TUG_ACTIONS.CANCEL_DIALOG, label: "Dismiss a sheet, or interrupt Claude" },
];

/**
 * The rendered shortcut rows. A row whose command has lost its binding drops
 * out rather than showing a blank key — a help sheet that names a gesture the
 * reader cannot perform is worse than one row shorter.
 */
export const HELP_SHORTCUTS: readonly HelpShortcut[] = HELP_SHORTCUT_ROWS.flatMap(
  (row) => {
    const keys = row.keys ?? (row.commandId === undefined
      ? undefined
      : commandShortcuts(row.commandId));
    return keys === undefined ? [] : [{ keys, label: row.label }];
  },
);

/**
 * Path (relative to the project root) of the user-facing list of slash
 * commands that have no useful behavior over the bridge. The General tab links
 * to it; the session card resolves it against the bound project dir to open it.
 */
export const UNSUPPORTED_COMMANDS_DOC_PATH =
  "tuglaws/session-card-unsupported-slash-commands.md";

// ---------------------------------------------------------------------------
// Command projection — the Commands + Custom-commands tab lists
// ---------------------------------------------------------------------------

/** One command row in the help command list. */
export interface HelpCommandEntry {
  /** Command name without the leading slash. */
  readonly name: string;
  /** One-line description; `""` when the catalog reports none. */
  readonly description: string;
}

/**
 * Project a session command catalog into the help sheet's Commands list: the
 * **built-in** commands, applying the same allowlist the slash popup does
 * ([D14]).
 *
 * - **Hidden** commands ([#step-13a]) are dropped.
 * - The [D23] **local-command registry** seeds the list with its curated
 *   descriptions, so it is useful before the handshake catalog lands and the
 *   Tug-authored copy wins over claude's terminal-flavored text.
 * - Only `category: "local"` catalog entries join — claude's built-in commands.
 *   `skill` and `agent` entries are dropped: plugin / bundled-marketplace skills
 *   aren't this project's own commands, and an agent is not a slash command (the
 *   `/agents` sheet lists those).
 * - Only commands we **have help text for** are listed — an entry with no
 *   description is dropped. The [D23] registry always carries curated copy, so
 *   in practice this is the set of commands the session card actually implements;
 *   claude's description-less catalog built-ins (`/clear`, `/init`, `/compact`,
 *   …) are left to the slash popup rather than listed here blank.
 *
 * Each name appears once (the registry's curated copy wins over a catalog
 * duplicate) and the list is sorted alphabetically.
 *
 * Pure: no side effects.
 */
export function projectHelpCommands(
  catalog: readonly SlashCommandInfo[],
): HelpCommandEntry[] {
  const builtin = new Map<string, HelpCommandEntry>();

  for (const cmd of LOCAL_SLASH_COMMANDS) {
    builtin.set(cmd.name, { name: cmd.name, description: cmd.description });
  }

  for (const cmd of catalog) {
    if (cmd.category !== "local") continue; // skills / agents aren't built-in commands
    if (isHiddenSlashCommand(cmd.name)) continue;
    // A curated registry description outranks a (possibly empty) catalog one.
    if (builtin.has(cmd.name)) continue;
    builtin.set(cmd.name, { name: cmd.name, description: cmd.description ?? "" });
  }

  return [...builtin.values()]
    .filter((e) => e.description !== "") // only commands we have help text for
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

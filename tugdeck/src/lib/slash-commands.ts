/**
 * slash-commands.ts — registry + matcher for locally-handled slash
 * commands.
 *
 * Some slash commands are *claude's* (`/commit`, skills, agents): typing
 * one sends it to claude, which runs it and streams a
 * real turn. Others are *terminal-rendered-locally* (`/permissions`,
 * `/model`, `/rewind`, …): the terminal handles them itself and claude
 * never sees them. In stream-json / print mode claude has no interactive
 * UI, so a locally-rendered command sent to it bounces with "isn't
 * available in this environment." The session-card reimplements those
 * commands as graphical surfaces — and this module is the single source
 * of truth for which commands are local and how a typed command line is
 * recognized.
 *
 * This is pure data + a pure lookup — no React, no DOM, no store
 * dependency. The completion layer reads {@link LOCAL_SLASH_COMMANDS} to
 * offer the commands in the slash popup ([#step-1c] session-card composition
 * layer); the prompt entry's submit path reads {@link
 * matchLocalSlashCommand} to decide whether a draft is a local command
 * to dispatch or text to send to claude; later command steps ([#step-2b]
 * `/model`, [#step-7]+ etc.) extend the registry; [D14]'s allowlist
 * ([#step-13]) reads the same set.
 *
 * Dispatch + surface ownership live elsewhere: a matched command is
 * dispatched key-card-scoped as `RUN_SLASH_COMMAND` and the session card's
 * card-content responder opens the surface (see [D23] and
 * `session-card.tsx`). Keeping this module surface-agnostic is what lets the
 * matcher run inside the generic `TugPromptEntry` without coupling it to
 * session-card concepts.
 *
 * @module lib/slash-commands
 */

import { TUG_ATOM_CHAR, type AtomSegment } from "./tug-atom-img";

/** One locally-handled slash command's static descriptor. */
export interface LocalSlashCommandSpec {
  /** Command name without the leading slash, e.g. `"permissions"`. */
  readonly name: string;
  /** One-line description (popup / docs); not rendered today. */
  readonly description: string;
  /**
   * Whether the command accepts trailing arguments after its name.
   * A no-arg command matches only a bare `/name`; an arg-accepting
   * command matches `/name` optionally followed by whitespace + args.
   * Defaults to `false`.
   */
  readonly takesArgs?: boolean;
}

/**
 * Every command the session-card handles locally, in popup order. The seed
 * is `/permissions` ([#step-1c]); each later command step appends its
 * entry. The `as const satisfies` shape both validates the descriptors
 * and narrows {@link LocalCommandName} to the literal union — which the
 * session card's `RUN_SLASH_COMMAND` handler keys an exhaustive map on, so a
 * registry entry without a wired surface is a compile error rather than
 * a silently-swallowed command.
 */
// `/permissions` is the first live consumer: the tool-permission **rules**
// editor ([#step-1.6]) — distinct from the permission *mode* chip, which is a
// click + `Shift+Tab` control with no slash command. `/model` ([#step-2b]) is
// the next consumer. `as const satisfies` both validates each descriptor and
// narrows {@link LocalCommandName} to the literal union, so the session card's
// `RUN_SLASH_COMMAND` handler keys an exhaustive `Record<LocalCommandName, …>`
// on it — a registry entry without a wired surface is a compile error.
export const LOCAL_SLASH_COMMANDS = [
  {
    name: "permissions",
    description: "Edit tool-permission rules (allow / ask / deny / workspace)",
  },
  {
    name: "ai",
    description: "Configure the AI — model, reasoning effort, permission mode",
  },
  // The three attribute names survive as deep links into the one sheet, so the
  // muscle memory keeps working: each opens the mixer focused on its own row.
  {
    name: "model",
    description: "Switch the active model for this session",
  },
  {
    name: "effort",
    description: "Set the reasoning effort for this session",
  },
  {
    name: "mode",
    description: "Set the permission mode for this session",
  },
  {
    name: "rewind",
    description: "Rewind the conversation (and optionally code) to an earlier turn",
  },
  {
    name: "resume",
    description: "Resume a different session for this project in this card",
    // Bare `/resume` opens the picker; `/resume <callsign>` names the session
    // and skips it ([P12] — the tag is addressable). Without this the argument
    // form does not match the registry at all and falls through as prose.
    takesArgs: true,
  },
  {
    name: "diff",
    description: "Open the Project Diff card — uncommitted changes (git diff HEAD) for this project",
  },
  {
    name: "context",
    description: "Show the context-window breakdown in the status-bar popover",
  },
  {
    name: "tasks",
    description: "Show the session's numbered task list in the TASKS popover",
  },
  {
    name: "bashes",
    description: "Show the session's background work — goal, jobs, scheduled — in the JOBS popover",
  },
  {
    name: "skills",
    description: "List the project's plugin + user skills",
  },
  {
    name: "agents",
    description: "List the subagents Claude can delegate to",
  },
  {
    name: "memory",
    description: "Open this project's memory files in your editor",
  },
  {
    name: "hooks",
    description: "View the configured hooks for this session",
  },
  {
    name: "usage",
    description: "Show subscription usage limits and this session's cost",
  },
  {
    name: "copy",
    description: "Copy the most recent assistant message to the clipboard",
  },
  {
    name: "shell",
    description: "Run one shell command from here",
    takesArgs: true,
  },
  {
    name: "match",
    description: "Find files whose names match — results are clickable, numbered refs",
    takesArgs: true,
  },
  {
    name: "search",
    description: "Search file contents — results are clickable, numbered refs",
    takesArgs: true,
  },
  // `/rewind`, `/resume`, and `/rename` already share the `/r` prefix, so
  // inline completion resolves `/ref` by the registry's existing rules —
  // nothing here is special-cased for it.
  {
    name: "ref",
    description: "Open refs by number from the last /match or /search (3, 3-5, 3 7 9)",
    takesArgs: true,
  },
  {
    name: "btw",
    description:
      "Ask a quick side question, answered from the conversation with no tools",
    takesArgs: true,
  },
  {
    name: "help",
    description: "Show available commands, shortcuts, and help",
  },
  {
    name: "clear",
    description: "Start a fresh session in this card (the current one stays resumable)",
  },
  {
    name: "export",
    description: "Export the session transcript to a file (Markdown or JSON Lines)",
  },
  {
    name: "add-dir",
    description: "Add a working directory to this session",
  },
  {
    name: "rename",
    description: "Name this session (shown in the chip and session chooser)",
    takesArgs: true,
  },
  {
    name: "unname",
    description: "Clear this session's name (the callsign comes back)",
  },
  {
    name: "private",
    description: "Keep this session out of the Overview (toggle; from now on)",
  },
  {
    name: "compact",
    description: "Compact the conversation in place to free up context",
    takesArgs: true,
  },
  // Neither route has a typeable name. A slash command is a one-shot verb that
  // returns you where you were; a route is a mode you stay in, and the two do
  // not belong in one namespace. `/prompt` could not work at all — in the
  // Changes route the composer IS the commit-message editor, so submit lands
  // the message verbatim and no typed line is ever read as a command there —
  // and a lone `/changes` with no twin is a half-namespace nobody can predict.
  // The route gestures are the Z4A tabs, ⌃⌘P / ⌃⌘C, and Escape.
  {
    name: "commit",
    description: "Open the commit dialog to author a message and land this session's changes",
    takesArgs: true,
  },
  // The other half of landing: `/commit` writes the commit, `/push` sends it.
  // No arguments — a push sends the branch the checkout is on, and there is
  // nothing for the user to elect.
  {
    name: "push",
    description: "Push this project's branch to its upstream and leave a receipt",
  },
  // The fourth act, and the last: `/release` opens the Release shade, where the
  // project's own check runs, the dispatch is gated on it, and the queued run
  // is watched to an end. No arguments — what a release *is* here is the
  // `[tugtool.release]` table's to say, not a typed line's.
  //
  // The registry is static, so a project that declares no table cannot have the
  // verb hidden from its completion popup; the surface answers it with a
  // bulletin instead, because silence is the one outcome nobody can diagnose
  // ([L31]).
  {
    name: "release",
    description: "Open the Release sheet — check, dispatch and watch this project's release",
  },
  // An operation is spelled the same on every surface a user can see it, and
  // that spelling is its `tugtool` verb path ([P08]): `tugtool arc bind` ⇒
  // `/arc-bind`, `tugtool arc join` ⇒ `/arc-join`. `/commit` above keeps its
  // bare name because it rides `tugtool commit` — and `/arc-commit` is
  // reserved for `tugtool arc commit`, the round verb, which ships no card
  // verb yet. The bare `/arc` is not a local command at all: it belongs to the
  // `tugplug:arc` door skill, and reaches it as a pass-through.
  {
    name: "arc-bind",
    description: "Work on an arc — bind this card to it, creating it if needed",
    takesArgs: true,
  },
  {
    name: "arc-join",
    description: "Land an arc — opens the join editor over a previewed merge",
    takesArgs: true,
  },
  {
    name: "arc-review",
    description: "Review a plan on the review model — bare resolves to the last one reviewed",
    takesArgs: true,
  },
  {
    name: "logout",
    description: "Log out of Claude and return to setup",
  },
] as const satisfies readonly LocalSlashCommandSpec[];

/** A registered local-command name. */
export type LocalCommandName = (typeof LOCAL_SLASH_COMMANDS)[number]["name"];

/** A recognized local command: its name plus any trailing args (`""` if none). */
export interface LocalSlashCommandMatch {
  readonly name: LocalCommandName;
  readonly args: string;
}

const SPEC_BY_NAME: ReadonlyMap<string, LocalSlashCommandSpec> = new Map(
  LOCAL_SLASH_COMMANDS.map((cmd) => [cmd.name, cmd]),
);

// `/name` optionally followed by whitespace + the rest of the line.
// The name is a leading word (letters, then word chars / hyphens) — the
// shape of every local command. Claude's namespaced commands (e.g.
// `tugplug:plan`) are not local and simply miss the registry lookup.
const COMMAND_LINE = /^\/([a-zA-Z][a-zA-Z0-9-]*)(?:\s+([\s\S]*))?$/;

/**
 * Recognize a draft as a local slash command, or return `null`.
 *
 * The whole trimmed draft must be a single `/command` line. A no-arg
 * command matches only when nothing follows the name (`/permissions`,
 * not `/permissions foo`); an arg-accepting command (`takesArgs`)
 * captures the trimmed remainder as `args`. Anything else — a name not
 * in the registry, args on a no-arg command, or text that isn't a
 * command line — returns `null`, and the caller sends it to claude
 * verbatim.
 *
 * Pure: no side effects, no allocation beyond the result. The caller is
 * responsible for excluding drafts that carry atoms (a command line is
 * plain text) — this matcher only inspects the string.
 */
export function matchLocalSlashCommand(text: string): LocalSlashCommandMatch | null {
  const m = COMMAND_LINE.exec(text.trim());
  if (m === null) return null;
  const name = m[1];
  const args = (m[2] ?? "").trim();
  const spec = SPEC_BY_NAME.get(name);
  if (spec === undefined) return null;
  if (args.length > 0 && spec.takesArgs !== true) return null;
  return { name: name as LocalCommandName, args };
}

/**
 * One atom in an editor draft, reduced to what command-line reconstruction
 * needs: its document position (where its {@link TUG_ATOM_CHAR} placeholder
 * sits in the draft text) and its segment `type` / `value`. `PositionedAtom`
 * from the editor structurally satisfies this.
 */
export interface CommandLineAtom {
  readonly position: number;
  readonly segment: { readonly type: string; readonly value: string };
}

/**
 * Reconstruct a plain `/command …` line from an editor draft that may carry
 * atoms, so a slash command is recognized even when its argument contains
 * `@`/file mentions. Each atom placeholder ({@link TUG_ATOM_CHAR}) in `text`
 * is expanded in place by its segment type: a `command` atom → `/<value>`;
 * `image` atoms are dropped (not
 * meaningful as a command argument); every other atom (file / doc / link /
 * …) contributes its `value` — the path or reference. Plain text passes
 * through unchanged, so a draft with no atoms returns verbatim.
 *
 * The caller runs {@link matchLocalSlashCommand} / {@link slashCommandName}
 * on the result: a draft that doesn't lead with a slash command simply
 * doesn't match, so non-command drafts are unaffected. Pure.
 */
export function buildSlashCommandLine(
  text: string,
  atoms: readonly CommandLineAtom[],
): string {
  if (atoms.length === 0) return text;
  const segByPos = new Map(atoms.map((a) => [a.position, a.segment]));
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== TUG_ATOM_CHAR) {
      out += ch;
      continue;
    }
    const seg = segByPos.get(i);
    if (seg === undefined) continue; // defensive: orphan placeholder
    if (seg.type === "command")
      out += `/${seg.value}`;
    else if (seg.type === "image") continue; // drop — not a focus argument
    else out += seg.value;
  }
  return out;
}

/**
 * A draft as the prompt entry held it at submit: the substrate text plus its
 * positioned atoms. Carried on the `RUN_SLASH_COMMAND` payload so a surface
 * that echoes its command into the transcript can reconstruct the chips the
 * user typed, instead of only the flattened line
 * ({@link buildSlashCommandLine}) the matchers run on. `PositionedAtom` from
 * the editor structurally satisfies the atom entries.
 */
export interface SlashCommandDraft {
  readonly text: string;
  readonly atoms: readonly DraftAtom[];
}

/** One positioned atom in a {@link SlashCommandDraft}. */
export interface DraftAtom {
  readonly position: number;
  readonly segment: AtomSegment;
}

/** An editor substrate ready for `CodeSessionStore.send`. */
export interface CommandSubmission {
  readonly text: string;
  readonly atoms: AtomSegment[];
}

/** Offset just past the leading `/command` token in `text`, or `null` when
 *  the text doesn't lead with one. Both shapes count: an accepted command
 *  atom (a `U+FFFC` placeholder backed by a `command` segment) and a bare
 *  typed `/name`. */
function commandHeadEnd(
  name: string,
  text: string,
  atoms: readonly DraftAtom[],
): number | null {
  let i = 0;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  if (text[i] === TUG_ATOM_CHAR) {
    const lead = atoms.find((atom) => atom.position === i);
    return lead?.segment.type === "command" ? i + 1 : null;
  }
  const typed = /^\/([a-zA-Z][a-zA-Z0-9-]*)/.exec(text.slice(i));
  if (typed === null || typed[1] !== name) return null;
  return i + typed[0].length;
}

/**
 * Build the editor substrate for a local command that echoes itself into the
 * transcript as a real user submission (`/compact`). The command becomes a
 * leading `command` atom and every argument atom the user typed — an
 * `@`-completed file, a dropped doc — is carried through in order, so the
 * transcript row renders the same chips the composer showed.
 *
 * `draft` is the composer's substrate when the command was typed; omit it
 * (a menu dispatch, which carries only `args`) and the argument becomes
 * plain text after the chip. A draft that doesn't lead with the command
 * falls back to the same `args`-only shape.
 *
 * The leading command atom is also what `send` reads to keep the wire clean
 * (`/compact …`, no mention marker on the command itself — see
 * `hasLeadingCommandAtom`) and what `isCompactionSubmission` recognizes.
 * Pure.
 */
export function buildCommandSubmission(
  name: string,
  args: string,
  draft?: SlashCommandDraft,
): CommandSubmission {
  const commandAtom: AtomSegment = {
    kind: "atom",
    type: "command",
    label: name,
    value: name,
  };
  const head =
    draft === undefined ? null : commandHeadEnd(name, draft.text, draft.atoms);
  if (draft === undefined || head === null) {
    const tail = args.trim();
    return {
      text: TUG_ATOM_CHAR + (tail === "" ? "" : ` ${tail}`),
      atoms: [commandAtom],
    };
  }
  // Whitespace-only trims on both ends: an atom's placeholder is never
  // whitespace, so no atom is dropped and the surviving ones stay in
  // document order — which is the order `send` pairs them with the
  // `U+FFFC` placeholders in the text.
  const afterHead = draft.text.slice(head).replace(/^\s+/, "");
  const tailStart = draft.text.length - afterHead.length;
  const tailText = afterHead.replace(/\s+$/, "");
  const tailAtoms = draft.atoms
    .filter((atom) => atom.position >= tailStart)
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((atom) => atom.segment);
  return {
    text: TUG_ATOM_CHAR + (tailText === "" ? "" : ` ${tailText}`),
    atoms: [commandAtom, ...tailAtoms],
  };
}

/**
 * Extract the command name (without the leading slash) from a draft that is
 * a single `/command` line, ignoring any trailing args; `null` for anything
 * that isn't a command line. Unlike {@link matchLocalSlashCommand} this does
 * not consult the registry — it answers "what `/name` did the user type?",
 * which the [D14] allowlist ([#step-13a]) reads to classify a typed command
 * that is *not* a local one (a known-unsupported name to swallow, a
 * pass-through to send to claude).
 *
 * Pure: no side effects.
 */
export function slashCommandName(text: string): string | null {
  const m = COMMAND_LINE.exec(text.trim());
  return m === null ? null : m[1];
}


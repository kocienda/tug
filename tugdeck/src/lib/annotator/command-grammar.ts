/**
 * Command-line grammars — the pure matchers that decide whether a piece
 * of transcript ink is a command a gesture can act on.
 *
 * Two command families are recognized:
 *
 *  - **Slash commands** — `/tugplug:implement dash/x.md`. The grammar
 *    is necessary but not sufficient: the caller's known-command
 *    predicate is the authoritative gate. Matching the grammar first
 *    rejects the overwhelming majority of candidates cheaply, and splits
 *    `name` from `args`.
 *  - **Shell commands** — a line beginning with a known project CLI tool
 *    followed by a subcommand. There is no runtime catalog to gate
 *    against; the leading tool name is the whole gate.
 *
 * Pure — no DOM, no store — so the annotator's DOM pass and its tests
 * share exactly one definition of what a command line is.
 *
 * @module lib/annotator/command-grammar
 */

/** A parsed slash-command line: bare name plus trailing argument text. */
export interface ParsedSlashCommand {
  /** Bare command name, no leading slash — `tugplug:implement`, `diff`. */
  name: string;
  /** Trimmed argument text after the name, or `""` when there is none. */
  args: string;
}

/**
 * The slash-command-line grammar. `/` then a command token —
 * `plugin:command` or bare `command`, each segment lowercase alnum with
 * interior `_`/`-` (no leading/trailing separator, at most one `:`) and
 * **no interior `/`** — then optional whitespace + argument remainder.
 *
 * The lowercase-led, no-interior-`/` shape rejects path-like text
 * (`/Users/…` fails on the uppercase, `/usr/bin` on the second `/`) so
 * the grammar alone already excludes the common false positives; the
 * known-command predicate is the strict backstop.
 */
const COMMAND_NAME_PATTERN =
  "[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?::[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)?";

const SLASH_COMMAND_RE = new RegExp(
  `^\\/(${COMMAND_NAME_PATTERN})(?:\\s+([\\s\\S]+))?$`,
);

/**
 * The same command token, anchored at the very start of a string and
 * terminated by whitespace or end-of-string. Where {@link SLASH_COMMAND_RE}
 * asks "is this whole string a command line", this asks "does this string
 * *open* with a command", which is the question a submitted prompt poses:
 * the argument remainder may be several paragraphs of prose.
 */
const LEADING_SLASH_COMMAND_RE = new RegExp(
  `^\\/(${COMMAND_NAME_PATTERN})(?=\\s|$)`,
);

/**
 * The project CLI tools whose transcript command lines are annotated.
 * A span whose text is one of these followed by a subcommand is treated
 * as a shell command; there is no per-subcommand catalog — the leading
 * tool name is the whole gate.
 */
const SHELL_COMMAND_TOOLS = ["just", "tugtool"] as const;

/**
 * The shell-command grammar: a known tool name, then whitespace, then at
 * least one more non-whitespace token (the subcommand / target / flag),
 * on a single line. `.` does not match a newline, so a multi-line code
 * span never matches — inline command hints are single-line. A bare tool
 * name with no subcommand (`just` alone) is deliberately rejected: it is
 * not an actionable command line and the word could be prose.
 */
const SHELL_COMMAND_RE = new RegExp(
  `^(?:${SHELL_COMMAND_TOOLS.join("|")})\\s+\\S.*$`,
);

/**
 * Parse text as a slash-command line. Returns the `{ name, args }` pair,
 * or `null` when the text is not a well-formed command line.
 */
export function parseSlashCommandLine(text: string): ParsedSlashCommand | null {
  const match = SLASH_COMMAND_RE.exec(text.trim());
  if (match === null) return null;
  return { name: match[1], args: (match[2] ?? "").trim() };
}

/**
 * Parse text as a project shell-command line. Returns the trimmed command
 * line (`just launch-debug`, `tugtool dash join --preview`) when it begins
 * with a known tool + subcommand, or `null` otherwise. The returned string
 * is what a click seeds into the Code route as `/shell <command>`.
 */
export function parseShellCommandLine(text: string): string | null {
  const trimmed = text.trim();
  return SHELL_COMMAND_RE.test(trimmed) ? trimmed : null;
}

/**
 * Match a slash-command token at the very start of `text`, returning the
 * bare `name` and the offset just past it — the split point a caller
 * needs to lift the command out of the prompt and leave the argument
 * remainder as written.
 *
 * Not the same question as {@link parseSlashCommandLine}, which asks
 * whether the *whole* string is one command line and hands back the args
 * trimmed. A submitted prompt can open with a command and continue for
 * paragraphs, and the characters after the name are the author's, so
 * this returns an offset rather than a re-spelled remainder.
 */
export function matchLeadingSlashCommand(
  text: string,
): { name: string; end: number } | null {
  const match = LEADING_SLASH_COMMAND_RE.exec(text);
  if (match === null) return null;
  return { name: match[1], end: match[0].length };
}

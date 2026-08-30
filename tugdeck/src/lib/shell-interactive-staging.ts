/**
 * Interactive-staging detection for the `$` route ([P13]).
 *
 * `git add -p` and its relatives are prompting UIs over patch surgery. The
 * block shell has no TTY — a command's stdin is `/dev/null` — so they read EOF
 * immediately and stage nothing while exiting 0. That is the worst possible
 * outcome: a no-op that looks like success. Rather than run one, the route
 * answers with a steering notice.
 *
 * This is not a step toward a terminal emulator ([D111] stands). The graphical
 * surface *is* the answer to `git add -p`: the Changes shade picks hunks, and
 * `tugtool file stage --patch` is the non-interactive verb for a script or an
 * agent.
 *
 * Detection is a literal-token scan — no grammar, no execution, no shelling
 * out. It is quote-aware only so far as it must be: `git commit -m "add -p
 * support"` names no flag, and treating the quoted `-p` as one would refuse a
 * perfectly ordinary commit.
 *
 * @module lib/shell-interactive-staging
 */

import { TUG_ACTIONS } from "../components/tugways/action-vocabulary";
import { commandShortcut } from "../components/tugways/keymap-registry";

/** Git subcommands whose `-p` form prompts hunk by hunk. */
const PATCH_SUBCOMMANDS = new Set([
  "add",
  "commit",
  "stash",
  "checkout",
  "restore",
  "reset",
]);

/** Flags that put those subcommands into their prompting mode. */
const INTERACTIVE_FLAGS = new Set(["-p", "--patch", "--interactive"]);

/**
 * `-i` is `--interactive` for `git add` and `--include` for `git commit`, so
 * it is only a prompting flag where it means the former.
 */
const SHORT_INTERACTIVE_SUBCOMMANDS = new Set(["add"]);

/**
 * Ways to give `git commit` its message up front. Without one of these it
 * opens `$EDITOR`, which in a block shell means an editor on a dead terminal.
 */
const COMMIT_MESSAGE_FLAGS = new Set([
  "-m",
  "--message",
  "-F",
  "--file",
  "-C",
  "--reuse-message",
  "--no-edit",
  "--fixup",
  "--squash",
]);

interface Token {
  text: string;
  /** True when any part of the token came from inside quotes. */
  quoted: boolean;
}

/**
 * Split a command line on unquoted whitespace, remembering which tokens were
 * quoted. Deliberately minimal: it resolves the one ambiguity this detector
 * has (a flag-looking word inside a message), and nothing else.
 */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let text = "";
  let quoted = false;
  let started = false;
  let quote: '"' | "'" | null = null;

  const flush = (): void => {
    if (started) tokens.push({ text, quoted });
    text = "";
    quoted = false;
    started = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        text += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      flush();
      continue;
    }
    started = true;
    text += ch;
  }
  flush();
  return tokens;
}

/** A flag is an unquoted token starting with `-` — see {@link tokenize}. */
function flagsOf(tokens: Token[]): string[] {
  const flags: string[] = [];
  for (const token of tokens) {
    // A bare `--` ends the options; everything after it is a pathspec.
    if (!token.quoted && token.text === "--") break;
    if (!token.quoted && token.text.startsWith("-") && token.text.length > 1) {
      // `--message=x` names `--message`.
      const eq = token.text.indexOf("=");
      flags.push(eq === -1 ? token.text : token.text.slice(0, eq));
    }
  }
  return flags;
}

/**
 * The steering notice for an interactive-staging invocation, or `null` when
 * the command should just run.
 *
 * Fires on `git <add|commit|stash|checkout|restore|reset>` carrying
 * `-p` / `--patch` / `--interactive`, and on a bare `git commit` with no way
 * to supply its message (which would open an editor on a dead terminal).
 */
export function interactiveStagingSteer(command: string): string | null {
  const tokens = tokenize(command.trim());
  if (tokens.length < 2) return null;
  if (tokens[0].quoted || tokens[0].text !== "git") return null;

  // The subcommand is the first non-flag word after `git` (skipping `git -C
  // <dir>`-style global options and their values is more than this needs —
  // a global option before the subcommand simply means no match, which errs
  // toward running the command, the safe direction for a detector that
  // refuses).
  const sub = tokens[1];
  if (sub.quoted || !PATCH_SUBCOMMANDS.has(sub.text)) return null;

  const flags = flagsOf(tokens.slice(2));
  const interactive = flags.some(
    (flag) =>
      INTERACTIVE_FLAGS.has(flag) ||
      (flag === "-i" && SHORT_INTERACTIVE_SUBCOMMANDS.has(sub.text)),
  );
  const editorCommit =
    sub.text === "commit" && !flags.some((flag) => COMMIT_MESSAGE_FLAGS.has(flag));
  if (!interactive && !editorCommit) return null;

  // The chord is read, not spelled: this copy tells the user which keys to
  // press, so it is exactly the kind of string that goes wrong the moment
  // somebody rebinds ([P11]). A command with no chord names no chord.
  const shadeChord = commandShortcut(TUG_ACTIONS.TOGGLE_CHANGES_VIEW);
  const shade = shadeChord === undefined ? "Changes shade" : `Changes shade (${shadeChord})`;
  if (interactive) {
    return (
      "Interactive staging can't run here: the block shell gives a command no " +
      "terminal, so its stdin is /dev/null and the prompt reads EOF — it would " +
      "stage nothing and exit as though it had worked.\n\n" +
      `Pick hunks in the ${shade}, or stage a patch without ` +
      "prompting:\n" +
      "  tugtool file stage --patch <file|->"
    );
  }
  return (
    "`git commit` with no message would open an editor, and the block shell " +
    "gives a command no terminal to open one on.\n\n" +
    "Pass the message inline (`git commit -m …`), or land from the " +
    `${shade}, which writes the message and the Tug-Session trailer for you.`
  );
}

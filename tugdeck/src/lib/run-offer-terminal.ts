/**
 * `run-offer-terminal` — whether an offered command needs a terminal.
 *
 * The block shell runs a command with no controlling terminal and its stdin
 * at `/dev/null`. A command that asks for a password has nothing to ask, so
 * it declines at once and fails. An offer for such a command is certain to
 * fail when played, and an offer that is certain to fail is worse than one
 * that can only be copied: so the offer draws no Play and says why.
 *
 * Detection is a literal-token scan — no grammar, no execution. The command
 * is cut into segments at the unquoted operators that start a new command
 * (`;`, `&&`, `||`, `|`, `&`, a newline), and each segment's head is
 * compared against a short list. It is quote-aware only so far as it must
 * be: `echo "sudo make install"` names no `sudo`, and neither does
 * `git commit -m 'drop sudo; use doas'`. A head that was quoted, or that
 * arrives through a wrapper (`env sudo …`, `$(sudo …)`), is not matched,
 * which errs toward offering Play: the run then fails with the command's own
 * message, which is the outcome before this check existed.
 *
 * @module lib/run-offer-terminal
 */

/** Commands that prompt on a terminal and decline without one. */
const TERMINAL_HEADS = new Set(["sudo", "su", "ssh", "passwd", "login"]);

/** `NAME=value` in front of a command is an assignment, not its head. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The heads of a command's segments: for each simple command in the line,
 * its first word that is not an assignment, or `null` when that word was
 * quoted in whole or in part.
 */
function segmentHeads(command: string): Array<string | null> {
  const heads: Array<string | null> = [];
  let word = "";
  let wordQuoted = false;
  let wordStarted = false;
  // What the word held when its first quote opened: `NAME="a b"` is still an
  // assignment, and `"NAME=a"` is not.
  let beforeQuote: string | null = null;
  let headFound = false;
  let quote: '"' | "'" | null = null;

  const endWord = (): void => {
    if (wordStarted && !headFound) {
      const assignment = ASSIGNMENT.test(beforeQuote ?? word);
      if (!assignment) {
        heads.push(wordQuoted ? null : word);
        headFound = true;
      }
    }
    word = "";
    wordQuoted = false;
    wordStarted = false;
    beforeQuote = null;
  };
  const endSegment = (): void => {
    endWord();
    headFound = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        i += 1;
        word += command[i];
      } else word += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      // An escaped character is part of the word and never an operator. An
      // escaped newline joins two lines into one.
      i += 1;
      if (command[i] !== "\n") {
        beforeQuote ??= word;
        word += command[i];
        wordStarted = true;
        wordQuoted = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      beforeQuote ??= word;
      wordQuoted = true;
      wordStarted = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      endSegment();
      continue;
    }
    if (ch === "#" && !wordStarted) {
      // A comment runs to the end of its line.
      while (i + 1 < command.length && command[i + 1] !== "\n") i += 1;
      continue;
    }
    word += ch;
    wordStarted = true;
  }
  endSegment();
  return heads;
}

/**
 * The command that makes an offer need a terminal — `sudo`, `ssh` and the
 * like, as the head of one of its segments — or `null` when the offer can be
 * played. A head given by path (`/usr/bin/sudo`) is named by its last part.
 */
export function terminalNeed(command: string): string | null {
  for (const head of segmentHeads(command)) {
    if (head === null) continue;
    const name = head.slice(head.lastIndexOf("/") + 1);
    if (TERMINAL_HEADS.has(name)) return name;
  }
  return null;
}

/** The note an offer that needs a terminal carries in place of Play. */
export function terminalNeedNote(name: string): string {
  return `${name} needs a terminal, which commands run here do not have. Copy it and run it in one.`;
}

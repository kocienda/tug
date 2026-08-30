/**
 * shell-line-classifier — the precondition half of deciding whether an
 * unprefixed, atom-free, one-logical-line draft means the shell or means Claude
 * (Spec S03, [P09]).
 *
 * This module does not decide anything about intent. It brackets the model's
 * judgement from both sides with facts, and the model decides between them.
 *
 * Before: {@link isShellCandidate} asks *will this session's shell resolve the
 * first word?* That is checkable — the shell itself is asked what it holds, and
 * its answer, unioned with the login-PATH set, is what the caller supplies here.
 * When the answer is no the line cannot be a command, so no inference is spent
 * on it.
 * Everything past that point — whether the person meant to RUN that program or
 * was writing a sentence that happens to start with its name — is a judgement
 * about English, and the model makes it.
 *
 * Between: tugcast's grammar grader (the `tuggram` crate, reached over the
 * `shell_grammar` verb) asks *does the whole line name things that exist, and do
 * its tokens fit what the program can be shown to accept?* It refines within the
 * candidates {@link isShellCandidate} admits, doing what the deck cannot: lexing
 * past the first token, resolving every segment head of a pipeline, and stating
 * a `stat` on a path-shaped opener — and on a path argument — that the deck can
 * only take on faith. {@link modelCallForBand} is what its four bands mean here.
 * A `yes` runs the line outright: the grader recognized every token against the
 * program's own grammar, so there is no position left for English to occupy and
 * nothing for the model to weigh. Everything short of that is a `maybe` and
 * reaches the model with the program's documentation attached.
 *
 * After: {@link vetoesShellVerdict} asks *is this line shaped like English?* and
 * can refuse to honor a `shell` verdict. It can only refuse; see its own doc for
 * why that makes it a different instrument from the rules described next.
 *
 * An earlier revision tried to make that judgement here, with a stopword list,
 * a list of "ambiguous" openers, and a token-count rule. Those were guesses
 * about English dressed as syntax, and they pre-empted the model on most lines
 * it should have seen: the classifier decided `which bun` and `open .` by
 * itself and delegated only the leftovers. They are gone. The rule now is that
 * anything opening on a real program name is the model's question.
 *
 * The wrong-way costs are asymmetric and that asymmetry sets the whole design.
 * A line sent to Claude that meant the shell costs one keystroke to retype with
 * `!shell`. A line sent to the shell that meant Claude has **already executed**
 * — the auto-routed row offers "send to Claude instead", but nothing un-runs
 * the command. So every degraded path here resolves to Claude: no model, no
 * PATH set, no verdict, a timeout, a malformed answer, no grammar store. The
 * shell is reached two ways only: a `yes` from the grader, which is a statement
 * of fact about the line's tokens rather than a judgement about its meaning, or
 * an explicit `shell` verdict from the model that survives the veto.
 *
 * Outside all of it: {@link unendingProgram} is a short list of programs that
 * never end. A `yes` or a `top` can satisfy every gate above and still be the
 * wrong thing to start, because the cost is not a wrong answer but a session
 * that stops answering. It refuses both roads to the shell.
 *
 * Routing is decided once, at submit, over the **whole line**. There is no
 * opener-only judgement while the user types: the set of English words that are
 * also PATH executables is large (`write`, `say`, `who`, `last`, `join`,
 * `split`, `yes`, `top`, `sleep`, …) and varies by machine, so a first-word
 * test cannot tell `write me a haiku` from `write kocienda ttys001` and has no
 * line context yet to help it.
 *
 * Pure — no side effects, no store reads. The caller enforces the rest of the
 * precondition (the draft has no atoms; `text` is trimmed, and is the one
 * logical line {@link spliceContinuations} returned),
 * supplies the command set — the login-PATH names unioned with the session
 * shell's aliases, functions and builtins (null until it loads, which answers
 * Claude — the safety net, not the steady state) — and supplies its own
 * readiness.
 *
 * @module lib/shell-line-classifier
 */

/**
 * How strong tugcast's grammar grader found the evidence that a line is a shell
 * command (`tuggram`, served over the `shell_grammar` verb).
 *
 * The bands measure **evidence, not validity**. `no` requires evidence of
 * absence — the line lexed cleanly and something in it names nothing that
 * exists — and nothing else produces one. A stale catalog, a wrapper script, a
 * flag from a newer release all degrade `yes` toward `maybe`, never toward
 * `no`, so grammar drift costs one band of caution and can never swallow a real
 * command.
 */
export type GrammarBand = "yes" | "maybe" | "no" | "unknown";

/**
 * What the grader's band means for the model call — the third fact source in
 * this module's bracket, and the only one that can spend or save inference.
 *
 * `yes` is the one band that decides, and it decides toward the shell: the line
 * runs with no model call and no veto. That is not an exception to this
 * module's asymmetry, it is what the band is defined to mean. A `yes` requires
 * the grammar to have *recognized* every token — a known flag, a known
 * subcommand, an enumerated value, a path that exists — so there is no position
 * left in the line for English to occupy. `make the watch loop resilient` does
 * not reach here: `make`'s positionals are free, the grammar recognizes none of
 * those four words, and the line grades `maybe`. Any line the grader cannot
 * account for token by token is a `maybe`, which is the model's question with
 * the program's documentation attached.
 *
 * The other unilateral decision is `no` → Claude. Both fall in the direction
 * doubt is supposed to fall, because a `yes` is not doubt.
 */
export function modelCallForBand(
  band: GrammarBand,
): "skip" | "run" | "ask" | "ask-with-grammar" {
  switch (band) {
    // Something in the line names nothing on this machine. Asking the model
    // would spend a round trip on a question already answered.
    case "no":
      return "skip";
    // Every token accounted for by the program's own grammar. Nothing the
    // model could add, and a round trip that would only delay the command.
    case "yes":
      return "run";
    // A real command the grammar can't confirm. The model decides, holding the
    // program's own documentation.
    case "maybe":
      return "ask-with-grammar";
    // A resolving command nothing knows the grammar of: the pre-grader
    // question, asked the pre-grader way.
    case "unknown":
      return "ask";
  }
}

/** A leading `NAME=value` environment-assignment token (skipped to find the command). */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A backslash-newline line continuation, with the CRLF a paste can carry. */
const CONTINUATION = /\\\r?\n/g;

/**
 * The one logical command line a draft holds, or `null` if it holds more (or
 * less) than one.
 *
 * A command long enough to be worth typing is routinely written across several
 * physical lines joined by trailing backslashes — which is what a person pastes
 * back out of their shell history, and what a multi-file `git commit` looks
 * like written legibly. Reading the raw draft for a newline and stopping there
 * would send every one of those to Claude, because "does this text contain a
 * newline" is not the same question as "is this more than one command".
 *
 * Splicing answers the second question the way the shell does: a backslash
 * immediately before a newline joins the two lines and contributes no character
 * of its own — inside quotes as much as outside, which is why this needs no
 * quote tracking to be right. What is left is either one line, which is the
 * caller's candidate, or text with a newline still standing in it, which is two
 * statements or a paragraph of prose and is `null` either way.
 *
 * The spliced form is what must then be graded, classified, cached and run.
 * Routing has to execute the line it judged, not the bytes that suggested it.
 *
 * `tuggram`'s lexer splices identically (`lex.rs`), so a draft admitted here
 * tokenizes on the grader's side into exactly the command read here.
 */
export function spliceContinuations(text: string): string | null {
  const joined = text.replace(CONTINUATION, "");
  return joined.includes("\n") || joined.includes("\r") ? null : joined;
}

/**
 * The longest draft worth putting to the model. Past this the line is prose by
 * volume, and the classify prompt is tuned on command-length input.
 */
const MAX_CANDIDATE_LENGTH = 400;

/**
 * Whether a trimmed, single-line, atom-free draft could be a shell command at
 * all — the factual precondition the model's verdict is conditioned on.
 *
 * True means "the first word names a real program on this machine", which is
 * exactly what the classify prompt tells the model it may assume. It does
 * **not** mean the line is a command; only the model's verdict means that.
 *
 * A null command set (still loading) answers false: a line whose first word
 * can't be checked doesn't satisfy the precondition, so asking would put the
 * model a question it was told the answer to.
 */
export function isShellCandidate(
  text: string,
  commands: ReadonlySet<string> | null,
): boolean {
  if (commands === null) return false;

  // `#` leads a comment or a prose aside. (Slash commands are handled below,
  // where they are told apart from absolute paths.)
  if (text.length === 0 || text.length > MAX_CANDIDATE_LENGTH) return false;
  if (text.startsWith("#")) return false;

  const tokens = text.split(/\s+/).filter((t) => t.length > 0);

  // Skip a leading `NAME=value` env-assignment prefix (`FOO=1 make test`) so the
  // real command token is the one examined.
  let cmdStart = 0;
  while (cmdStart < tokens.length && ENV_ASSIGN.test(tokens[cmdStart]!)) cmdStart += 1;
  const first = tokens[cmdStart];
  if (first === undefined) return false;

  // Either a known PATH executable, or a program named by path — a script at
  // `./build.sh` is as real as one on the PATH, and tokens never contain
  // spaces. An absolute path needs an interior slash (`/usr/bin/true`), which
  // is what separates it from a slash command (`/shell`, `/tugplug:draft`);
  // those are intercepted upstream and must not be read as programs here.
  if (commands.has(first)) return true;
  return (
    first.startsWith("./") || first.startsWith("~/") || /^\/[^/]+\//.test(first)
  );
}

/** A quoted span — the message of `git commit -m "fix the thing for me"`. */
const QUOTED_SPAN = /'[^']*'|"[^"]*"/g;

/**
 * Words a command line has essentially no use for and prose can hardly avoid.
 * One of these, standing as its own token outside quotes and outside a flag, is
 * enough on its own.
 */
const PROSE_MARKERS = new Set([
  "the", "a", "an",
  "i", "it", "me", "my", "you", "this", "that", "these", "those", "them",
  "we", "us", "our",
]);

/**
 * Weaker prose signals. Each is plausible enough as a command argument that
 * length has to corroborate it before it counts.
 */
const PROSE_HINTS = new Set([
  "of", "for", "about", "into", "with", "from", "and", "or", "but",
  "is", "are", "was", "do", "does", "should", "please",
  "why", "what", "how", "when",
]);

/**
 * Tokens past which a line is longer than any command in the routing corpus,
 * whose longest case is three. Well clear of it, because real commands run
 * longer than the corpus does: `rg -n --hidden --glob '!target' TODO src tests`
 * is seven tokens and is a command.
 */
const COMMAND_TOKEN_CEILING = 6;

/**
 * Whether a `shell` verdict for this line must not be honored — the line is
 * shaped like English, whatever the model called it.
 *
 * This can only ever decline to execute. It never produces a `shell` verdict and
 * is never consulted on a `prompt` one, and that is what separates it from the
 * stopword, ambiguous-opener, and token-count rules this module used to carry.
 * Those decided *toward* shell: they let the classifier answer `which bun` and
 * `open .` by itself and hand the model only the leftovers, taking the
 * irreversible decision away from the model without adding any safety. A veto is
 * the opposite instrument. It cannot pre-empt anything toward shell because it
 * has no power to route there; it only adds one more degraded path to the list
 * this module already keeps, all of which resolve to Claude. The asymmetry is
 * unchanged — the shell is still reached only by an explicit `shell` verdict,
 * and now that verdict also has to survive this.
 *
 * Quoted spans are removed before anything else, so a command carrying prose as
 * an argument survives: `git commit -m "fix the thing for me"` is a command.
 *
 * Two signals cost a real command a keystroke. A trailing `?` on a glob
 * (`ls file?`) reads as a question, and an unquoted English word as a literal
 * argument (`rg the src`) reads as prose. Both resolve to Claude, which is the
 * direction doubt is supposed to fall here.
 *
 * The population this reads has shifted. Membership is now what the session's
 * shell resolves, not what is on the login PATH, and where PATH names are
 * tool-nouns, alias and function names are imperative verbs — `add`, `pull`,
 * `pick`, `amend` — which is exactly how a person opens a request to an AI.
 * More short prose lines therefore reach this point than used to. Note what
 * that does *not* change: the veto is the last line of defense, never the
 * first. The model is asked before this, and a line with no marker in it at all
 * (`add error handling here`) is the model's to read, not this function's.
 */
export function vetoesShellVerdict(text: string): boolean {
  const bare = text.replace(QUOTED_SPAN, " ");

  // A question mark closing the line, or a period closing a sentence inside it.
  // The period must follow a word character, which is what tells a sentence
  // break (`calculator. set it up`) from a path (`./setup.sh`, `notes.txt`) and
  // from a bare `.` argument (`find . -name x`).
  if (/[A-Za-z]\?\s*$/.test(bare)) return true;
  if (/[A-Za-z0-9]\.\s+[a-z]/.test(bare)) return true;

  const tokens = bare.split(/\s+/).filter((t) => t.length > 0);

  let hint = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    // Neither a flag nor a flag's value is prose, whatever it spells. This is
    // also what keeps `awk -F, file` clear of the comma test below.
    if (token.startsWith("-")) continue;
    if (i > 0 && tokens[i - 1]!.startsWith("-")) continue;

    // A comma joining two multi-word clauses. Interior commas that punctuate an
    // argument rather than a sentence (`sort -k1,3`) are not followed by space.
    if (token.endsWith(",") && i >= 2 && tokens.length - i >= 3) return true;

    const word = token.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
    if (PROSE_MARKERS.has(word)) return true;
    if (PROSE_HINTS.has(word)) hint = true;
  }

  return hint && tokens.length > COMMAND_TOKEN_CEILING;
}

/**
 * Programs that never end on their own.
 *
 * `yes` is the one this list was written for: typed alone it writes to the pipe
 * as fast as the pipe will take it, and the exchange it opens cannot be closed
 * from a route with no terminal in it — there is no ⌃C to send. The rest wedge
 * the same exchange more quietly, a monitor repainting or an editor waiting on
 * a keystroke that cannot arrive.
 *
 * A list, not a rule: every name here fails to end whatever arguments follow
 * it, so nothing past the first word needs reading. That is also the bar for
 * adding one. `node` and `tail` are absent because `node index.js` and `tail
 * -30 log` finish perfectly well, and a list that refused those would cost more
 * than it saved.
 */
const NEVER_ENDS = new Set([
  "yes",
  "top", "htop", "btop", "atop", "watch",
  "vi", "vim", "nvim", "view", "nano", "pico", "emacs",
  "telnet", "ftp", "tmux", "screen", "tcpdump",
]);

/** A wrapper that runs the real program, and so is stepped over to find it. */
const WRAPPERS = new Set(["sudo", "doas", "command", "env", "nohup", "exec", "time"]);

/**
 * The program this line names if it is one that never ends, `null` otherwise.
 *
 * Every other gate in this module weighs whether a line *means* the shell. This
 * one assumes it does and asks what happens next, because for these programs
 * the answer is the same either way: an exchange that produces no result and
 * cannot be taken back. It is read before anything routes and however
 * confidently the line graded, and the shell store reads it again before
 * anything runs — the `$` route is typed, not inferred, and locks the app just
 * as hard.
 *
 * Naming the program rather than answering yes or no is what lets a refusal say
 * which word in the line it read.
 */
export function unendingProgram(text: string): string | null {
  const tokens = text.trim().split(/\s+/).filter((t) => t.length > 0);

  let i = 0;
  while (
    i < tokens.length &&
    (ENV_ASSIGN.test(tokens[i]!) || WRAPPERS.has(tokens[i]!))
  ) {
    i += 1;
  }
  const head = tokens[i];
  if (head === undefined) return null;

  // `/usr/bin/yes` is `yes`. A program name holds no slash, so the last path
  // segment is always the name.
  const name = head.split("/").pop() ?? head;
  return NEVER_ENDS.has(name) ? name : null;
}


/** Where a submitted line ends up once every fact about it is in hand. */
export type SubmitDestination = "shell" | "claude" | "withdrawn";

/**
 * The whole routing decision as one table, applied after the grade and (when
 * the band asked for one) the model's verdict have landed.
 *
 * Gathering it here rather than leaving it as branches around the awaits is
 * what makes the asymmetry checkable in one place: exactly two rows reach the
 * shell — a `run` band, and an explicit `shell` verdict that survives the veto
 * — and every other row, including every degraded one, resolves to Claude.
 * Both rows are further conditioned on {@link unendingProgram}, which asks not
 * what the line means but whether the exchange it opens would ever close.
 *
 * `withdrawn` outranks all of it. A submit parked on the model's answer has
 * executed nothing and sent nothing; it is a decision in flight and nothing
 * more, so Escape can take the whole submission back and leave the draft where
 * the user left it. That is only true *because* nothing happens until this
 * function answers — which is the property the ordering here protects.
 */
export function resolveSubmitDestination(params: {
  /** The submitted line, verbatim — what the veto reads. */
  line: string;
  modelCall: ReturnType<typeof modelCallForBand>;
  /** The model's answer, or `null` for unasked, unanswered, and refused alike. */
  verdict: "shell" | "prompt" | null;
  /** Escape arrived while the submit was parked. */
  withdrawn: boolean;
}): SubmitDestination {
  if (params.withdrawn) return "withdrawn";
  // A program that never ends is refused before any of it: a `run` band states
  // a fact about the line's tokens, not about whether the exchange it opens can
  // ever close.
  if (unendingProgram(params.line) !== null) return "claude";
  // Every token accounted for by the program's own grammar: no question left
  // to ask, and no English left in the line for the veto to find.
  if (params.modelCall === "run") return "shell";
  if (params.modelCall === "skip") return "claude";
  if (params.verdict !== "shell") return "claude";
  return vetoesShellVerdict(params.line) ? "claude" : "shell";
}

/**
 * Verdicts already obtained from the model, keyed by the exact draft text.
 *
 * A model round trip costs hundreds of milliseconds, and a user editing the tail
 * of a line re-presents earlier prefixes constantly — so the same question would
 * otherwise be asked over and over. Bounded because a draft's history is
 * unbounded; cleared on submit/clear because verdicts belong to the draft being
 * composed, not to the session.
 */
export class ShellVerdictCache {
  /** Distinct drafts remembered before the oldest is dropped. */
  static readonly capacity = 32;

  private readonly entries = new Map<string, "shell" | "prompt">();

  /**
   * A verdict formed while reading the program's documentation is not the same
   * answer as one formed without it, so the two are remembered separately for
   * the same draft.
   */
  private static key(text: string, withGrammar: boolean): string {
    return withGrammar ? `\x00grammar\x00${text}` : text;
  }

  get(text: string, withGrammar = false): "shell" | "prompt" | undefined {
    return this.entries.get(ShellVerdictCache.key(text, withGrammar));
  }

  set(text: string, verdict: "shell" | "prompt", withGrammar = false): void {
    const key = ShellVerdictCache.key(text, withGrammar);
    // Re-insert so a repeatedly-consulted draft stays hot rather than aging out
    // behind drafts that were asked about once.
    this.entries.delete(key);
    this.entries.set(key, verdict);
    while (this.entries.size > ShellVerdictCache.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

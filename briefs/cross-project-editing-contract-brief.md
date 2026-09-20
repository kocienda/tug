# The editing contract reaches every project, not only this checkout

**Purpose:** A session Tug opens on any project other than its own checkout is never told how to edit files so that change tracking can see the edit. The knowledge lives in this repository's `CLAUDE.md`, which no other project has, and the gate that was meant to catch the rest has two holes wide enough for a whole day's work to pass through.

---

## Purpose {#purpose}

Tug is an IDE for AI coding projects. **Every** project opened in it must get the same support the `tug` project gets when it edits itself, with no per-project setup and no "special steps".

That is not what happened. In `/u/projects/eucit` — a genealogy project, one Markdown master document plus scans — the user asked:

> Why are you constantly editing the `@Kocienda_Polish_Citizenship_Research_Master.md` document in a way that the change-tracking code can't see it?

The session's first answer was to offer a per-project standing rule. The user's reply is the requirement this brief serves:

> There should be *explicit directions* for editing files. Look in the `/u/src/tug` project. How does it know to edit files with `tugtool`? … ***ALL PROJECTS*** run inside Tug, regardless of their project directory *must* get the same support for facilities like this that the `tug` project gets when it is *editing itself*.

The essential question is how Tug plugs that gap itself, from inside the bundle.

---

## Evidence {#evidence}

Established on 2026-09-20 from the `eucit` transcripts (`9365d6b9…`, the working session; `354e7078…`, the diagnosing one), a copy of `changes.db` read through `just db-inspect`, and this checkout's code.

**[F01] The enforcement channel is already universal.** `buildClaudeArgs` (`tugcode/src/session.ts:991`) passes `--plugin-dir` on every spawn; `tugplug/hooks/hooks.json` matches `Skill`, `Bash`, and `Edit|Write|MultiEdit|NotebookEdit`; `tugplug/hooks/pre-tool-use.sh` finds `tugtool` on the PATH the app seeds. In `eucit`, `tugtool changes --json` answered with a real session id, and a literal-target `python3` write was denied with the right steer. The gate is not what is missing. **(verified)**

**[F02] The instruction channel is not.** The whole editing contract — edit programs, the three body rules, `patch` hunks, `<<` bodies as addresses, `--preview`, `probe`, `run`, which `sed -i`/formatter shapes are readable — exists only in this checkout's `CLAUDE.md`, under "Editing repo files from the shell". `eucit` has no `CLAUDE.md`. Nothing in `tugplug/` mentions `tugtool file edit`. **(verified)**

**[F03] The seam to carry it already exists, with a precedent.** `readWorkGrammar` and `WORK_GRAMMAR_FILE` (`tugcode/src/session.ts:907–929`) read `tugplug/work-grammar.md` at every (re)spawn, and `buildClaudeArgs` joins it after `SESSION_SYSTEM_PROMPT_NUDGE` into the one `--append-system-prompt` value (`session.ts:1010–1023`; one value because a repeated flag is not documented to concatenate). Its doc comment says why: "the system prompt is the one channel that reaches every project the app opens." `tugplug/CLAUDE.md`'s "Plan Mode Policy" section records the same move having been made once already — a policy lifted out of a `CLAUDE.md` into that file so it holds everywhere. **(verified)**

**[F04] What the model actually did without the instruction.** In session `9365d6b9`, writes to the master document were: 1 `Write`, 7 `Edit`, 4 inline `python3 - <<'EOF'` heredoc rewrites, and **42** edits of the shape "`cat > /tmp/eucit/upd.py <<'EOF' … EOF` then `python3 /tmp/eucit/upd.py`". It discovered `tugtool file rm|mv|cp` unaided (18 uses, starting from `tugtool file --help`) and used them faithfully — and never once used `tugtool file edit`, because nothing told it the verb exists and no refusal ever pointed at it (see [F06], [F07]). A model that adopts the lifecycle verbs the moment it learns of them is a model that lacked information, not willingness. **(verified)**

**[F05] What that cost in the ledger.** `file_events` for the master document: 8 `exact` rows (the `Write` and `Edit` calls), then about 55 `origin = bash` bracket-correlation `modified` rows, interleaved with **17 `claim` rows** — the user hand-claiming the same file seventeen times in one day. Project-wide: 49 `bash`/`modified`, 78 `bash`/`created`, 78 `bash`/`deleted`. The ledger was not blind — the working-tree bracket saw every change — but correlation was the ceiling for nearly all of them, which is exactly the state the edit verbs exist to end. **(verified)**

**[F06] Gate bug: a variable-target `open(p, "w", …)` passes.** Bisected against `tugrust/target/debug/tugtool hook pre-tool-use` with `cwd` set to `eucit`: `open("X.md","w").write(…)` is denied; `p="X.md"` … `open(p,"w",encoding="utf-8").write(s)` yields no opinion. In `write_targets` (`tugrust/crates/tugchanges-core/src/shell_ops.rs`, the `open(` loop near line 1268) the mode test is `quoted_pieces(args).into_iter().skip(1)` — it assumes the first quoted piece is the path. When the path is a variable, the first quoted piece *is* the mode, and it is skipped, so the call is read as a non-write. The function's own doc comment names the variable-target shape as "the corpus's dominant shape"; this is that shape, unguarded. All 4 inline heredoc writes in [F04] ran because of it. **(verified)**

**[F07] Gate hole: the temp-script round trip.** `cat > /tmp/x.py <<'EOF' … EOF` followed by `python3 /tmp/x.py` — in one command — is unsteered. `program_steer` reads a heredoc body only when the segment that opened it has a watched interpreter as its head; here the head is `cat`. The second segment is "an interpreter running a script file", which `an_interpreter_running_a_script_file_is_never_steered` pins as never steered, on the sound ground that the program is not in the command. But in this shape it *is* in the command: the body is present, it is redirected to a temp path, and a later segment runs a watched interpreter on that same path. The module already reasons across segments this way for the `/tmp` → `mv` rule (`temp_writes`). This one shape carried 42 of the day's edits. **(verified)**

**[F08] The refusal text is written from inside this checkout.** `steering()` (`tugrust/crates/tugtool/src/commands/file.rs:343`) hardcodes `file tugdeck/src/main.tsx`, `attachDigestStore(connection);`, `tugtool file run -- cargo fmt -p tugedit-core`, and `--scope tugdeck/src … 'tugdeck/src/**/*.ts'` — shown verbatim to someone editing Polish parish records. `program_steer` already knows the offending path and puts it in `reason`; the example beside it ignores it. "The model copies the shape it is shown" is the comment on that arm, and the shape shown names files that do not exist. **(verified)**

**[F09] The steer fails open outside a git checkout.** `checkout_root` walks ancestors for a `.git` entry and `program_steer` returns `None` without one. `eucit` is a repository so this did not bite, but a standalone user's project need not be. **(verified by reading; not reproduced)**

**[F10] Constraints on the fix.** `scripts/tugplug-lint.ts` refuses `just`, `tugdeck/`, `tugrust/`, `/Users/`, and commit hashes anywhere under `tugplug/` except `tugplug/CLAUDE.md`, so any text moved into the plugin must be project-neutral. `tugplug/__tests__/standalone.test.ts` is the existing scratch-project, empty-PATH guard. `buildClaudeArgs` is exported for unit tests. **(verified)**

**[F11] A competing instruction exists upstream.** Session `354e7078` reported that its system prompt carries a block telling the model to do its work through Bash — read with `cat`/`sed -n`, edit with `sed`, heredocs, or short scripts — and that a grep of this checkout does not find that text, so it is Claude Code's, not Tug's. The behaviour in [F04] is consistent with it. **Not independently verified** — transcripts do not record system prompts. Confirming it needs a spawn with the prompt dumped; nothing below depends on the confirmation, only on the behaviour, which is measured.

**[F12] The editing contract is not the only project-neutral rule stranded in `CLAUDE.md`.** Read against the question "is this true of any project Tug opens?": "Writing prose the Session card renders" (backtick every path, bare shas) is about the Session card's renderer, and "AskUserQuestion — shape and affordances" is about Claude Code's schema and the Session card's dialog. Both are project-neutral. Git Policy's arc/brief/draft exceptions are already restated by the skills that own them. The rest — app-tests, ledger databases, host tools, theme tokens, Tuglaws, build policy — is true of this checkout alone. **(verified by reading)**

---

## Decisions {#decisions}

**[B01] The editing contract ships in the plugin and rides the system prompt on every spawn.** A new `tugplug/file-editing.md`, read at (re)spawn and joined into the same single `--append-system-prompt` value as the nudge and the work grammar. This is the only channel that reaches a project with nothing of ours in it ([F03]), and it is where the last policy with this problem went. A `CLAUDE.md` written into the user's project, a per-project setting, a standing rule the user must ask for — each is the "special step" the requirement forbids.

**[B02] A separate file, and the reader becomes a list.** The work grammar is about what passes between user and model; this is about tools. They change for different reasons and should not share a file. `readWorkGrammar`/`WORK_GRAMMAR_FILE` generalize to an ordered list of plugin prompt files, each read independently; an absent file stays what it is today — a logged state, not an error — and the appended prompt with none present is still the nudge alone, byte for byte. Order: nudge, work grammar, file editing, then anything [B08] adds.

**[B03] The full contract ships, not a short core.** About forty lines. The argument for a ten-line core was that the deny message carries the detail on demand; [F04] shows the shapes that matter never reach a deny message at all, so on-demand detail is detail never delivered. First-try success on every edit in every project is worth the tokens. Revisit only if the append is shown to crowd something out.

**[B04] The text opens with an explicit order of preference, stated as overriding.** `Edit`/`Write`/`MultiEdit` first for a single-file edit; `tugtool file edit` for anything that does not fit them; `tugtool file rm|mv|cp` for lifecycle; `tugtool file run` for a rewriter; and **never** `sed`, a heredoc redirect, an inline interpreter, or a script written to a temp directory and then run, to write a project file — *whatever other guidance in this prompt says about preferring the shell*. It says why in one sentence (the edit lands unattributed and the user has to claim it by hand), because a rule with its reason survives a competing rule better than a bare one ([F11]). We outrank the upstream nudge; we do not try to remove it.

**[B05] The plugin text is project-neutral and the checkout keeps only its residue.** Examples use paths like `src/app.ts` and `docs/notes.md`, and `tugtool file run -- <your formatter>`. `CLAUDE.md`'s section shrinks to what is true here alone — the crate that holds the grammar, the cargo-mtime corollary of `probe`, the `just app-test` probe example — plus a pointer to the plugin file as the source. One contract, one home; the checkout does not carry a second copy to drift.

**[B06] Fix the `open(` mode test.** When the leading argument is not a quoted literal, every quoted piece is a candidate mode; when it is, keep skipping it. Pinned with the verbatim `eucit` shape from [F06].

**[B07] Steer the same-command temp-script round trip.** When a heredoc body is redirected to a path under an excluded temp prefix, the body carries a write-shaped call and a repo-shaped path, and a later segment of the same command runs a watched interpreter on that temp path, refuse with `Suggestion::Program`. This extends the existing cross-segment evidence rule rather than inventing one, and it stays inside the steer's charter: a denial with a suggestion, never a minted row. `an_interpreter_running_a_script_file_is_never_steered` stays true for a script the command did not write. The cross-*call* case — script written in one Bash call, run in the next — is genuinely unreadable and is left to [B04] and the bracket.

**[B08] No Tug path appears in any refusal.** The `Program` example names the path `program_steer` already found (`steering` takes it, or the reason is composed where the path is known); the `Run` example becomes `tugtool file run -- <command>` with a neutral `--scope`. The model copies the shape it is shown, so the shape shown must be one that exists where it is shown.

**[B09] The other two stranded rules move in the same arc.** "Backtick every path" and the `AskUserQuestion` shape ([F12]) go into the plugin as their own file or files under [B02]'s list, trimmed of checkout pointers (`tuglaws/…`, `chrome/session-question-dialog.tsx`), and `CLAUDE.md` keeps a pointer. Doing the audit once, now, is cheaper than rediscovering each one from a confused user in another project.

**[B10] Write the rule down as doctrine.** In `tuglaws/` (beside the standalone contract, which it extends from *files the plugin may depend on* to *knowledge a session may depend on*): anything the model must know to drive Tug correctly ships in the bundle and reaches the session through the system prompt or a skill; this checkout's `CLAUDE.md` holds only what is true of this checkout. The test for any new `CLAUDE.md` paragraph is one question — *would this be true in a project that is not Tug?* — and a yes means it is in the wrong file.

**[B11] Guards, so this cannot regress quietly.** A unit test on `buildClaudeArgs` that the append carries nudge, grammar, and editing contract in order, and the nudge alone when the files are absent. A `standalone.test.ts` case that `file-editing.md` ships and that a scratch-project spawn's arguments carry it. `shell_ops` tests for [B06] and [B07] using the `eucit` commands verbatim. A test over every `steering()` arm asserting it contains no `tugdeck/`, `tugrust/`, or `cargo`. The plugin lint already covers the new files by location.

---

## Open Questions {#open-questions}

- **Does the appended contract actually win against the upstream Bash-first block ([F11])?** It cannot be settled by reading; it needs one real session on a scratch project in the same permission mode, asked to make a multi-site edit to a Markdown file, with the ledger read afterwards. If `tugtool file edit` or `Edit` is not what it reaches for, [B04]'s wording is what changes — not the channel.

---

## Non-goals {#non-goals}

- **A per-project rule, memory, or generated `CLAUDE.md`.** Rejected by the requirement itself: it is the special step.
- **Turning off or rewriting upstream's auto-mode text.** Not ours to edit, and Bash-first is right for the reading and searching that make up most of a session. We override it for writes only.
- **Denying every unreadable write at the gate.** The gate denies what the grammar can *prove* it cannot resolve, and fails open otherwise; that stance stays. The instruction is the primary fix and the gate is the backstop, not the other way round.
- **Non-git projects ([F09]).** Real, but the ledger itself is git-shaped, so it is a larger question than the steer's root walk. A follow-up brief.
- **Back-promoting `eucit`'s existing `bash` rows to proof.** History stays as recorded.
- **Moving the genuinely checkout-only sections of `CLAUDE.md`.** App-tests, ledger databases, host tools, theme tokens, build policy, and Tuglaws stay where they are.

---

## Exit {#exit}

**An arc.** Its natural order:

- The plugin text first — `tugplug/file-editing.md` written project-neutral and lint-clean, opening with [B04]'s order of preference — since everything else points at it.
- The reader generalized in `tugcode/src/session.ts` ([B02]) with its `buildClaudeArgs` tests, then the standalone guard.
- The two gate fixes in `tugchanges-core::shell_ops` ([B06], [B07]), each landing with its verbatim `eucit` test, and the neutral refusal text in `tugtool`'s `steering()` ([B08]) with its no-Tug-paths test. These are independent of the prompt work and of each other.
- The other two stranded rules moved ([B09]), `CLAUDE.md` shrunk to residue and pointers ([B05]), and the doctrine paragraph written ([B10]).
- Last, the Open Question's live check on a scratch project, with the ledger's `origin` column as the measure: `exact` and `cmd` rows, no `bash` rows, no claims.

# Shell classifier improvements — design brief

*Input for `/tugplug:devise`. This is a specification, not a tugplan: every finding below was verified against the running machine and the real code during the 2026-08-07 session, and is recorded here so the plan author never has to re-derive it.*

## What this is for

Shell arbitration decides whether a line typed into the Session card composer means *run a program* or means *write a sentence to Claude*. The decision runs through a bracket of fact sources — a candidate precondition in the deck, a grammar grade in tugcast (`tuggram`), a model verdict from the SharedAgent, and a veto — and every degraded path resolves to Claude, because a wrongly-run command cannot be un-run.

The bracket's first fact source is currently wrong about what a command *is*. It asks whether the first word names a binary on the login PATH. The thing that will actually execute the line is the session's shell, which resolves aliases and functions and builtins first, and PATH last. So the classifier and the executor consult two different realities. This work makes the shell the authority on membership, and makes an expansion's grammar available to grade the tokens the user typed.

**The effect for the person using it:** the shortcuts they actually type get recognized. `gs` runs `git status` because their shell says `gs` is a thing, not because ghostscript happens to be installed. A binary added by `brew install` a minute ago is routable now. A shell builtin like `setopt` is recognized at all, which today it is not. And sentences stay sentences — `add error handling here` goes to Claude, because it reads as English, not because `add` was invisible.

## The load-bearing principle

**Three questions, three sources, none borrowing the others' authority.**

1. **Membership** — "will this session's shell resolve this word?" Answered by the shell itself (aliases, functions, builtins, PATH), never by a PATH sweep alone.
2. **Grammar** — "what shape should this word's arguments take?" Answered by the catalog, reached through the expansion when the word is an alias or a simple function.
3. **Subject** — "what is being judged?" Always **the line the user typed**, never the expansion.

Point 3 is the one that must not bend. The question the feature asks is about *intent*, and intent lives in the keystrokes. The expansion is never executed by us either — we hand the shell `gs` and the shell expands it with the table live at that instant, not the one we cached. The expansion is a string that exists at no point in the pipeline.

Held to, this gives the plain right answer every time: a sentence goes to Claude, a command runs, and neither has to be spelled a special way. [P03] states it as a decision; [P04] gives the rule that keeps a band honest when the typed line and the expansion carry different arguments.

## Verified findings

Everything in this section was measured, not assumed. Reproduce with the commands shown.

### The executor's reality is already correct

`tugrust/crates/tugcast/src/feeds/shell.rs` spawns the session shell as `$SHELL -il` (`spawn_shell_child`, `login: true`), so rc files are in force and alias expansion is enabled — `-i` is what enables it. The test `login_shell_sources_user_rc` in the same file already pins that an rc-defined alias expands. `resolve_exec_shell()` returns `$SHELL` when it is bash or zsh, else `/bin/zsh`.

The child is **lazy**: it spawns on the first `exec`, not at card mount. `SessionShared.cwd` is `None` until then. This is a timing constraint on where the word table comes from (see [S01]).

### The motivating case is a function, not an alias

```
$ /bin/zsh -ilc 'whence -w gs'
gs: function
$ /bin/zsh -ilc 'functions gs'
gs () { git status $* }
```

An alias-only layer would not have fixed it. This user's environment is functions: **2 aliases** (both zsh built-ins) and **1072 functions**.

### The function surface is 72, not 1072

**1000 of the 1072** function names are `_`-prefixed zsh completion functions, which are not user-invocable. The real surface is **72**.

Of those 72, 18 are entries in `/usr/share/dict/words`: 8 single letters (`b c h m o p r s`) and 10 genuine words — `add amend kop pick prof pull push site stuff tup`. **All 10 are new**: none is on PATH today, so all 10 become newly candidate-eligible.

### The population shift is the real change, not the count

PATH binaries are tool-nouns (`git`, `curl`, `rg`, `ls`) — words that essentially never open an English sentence. Function names are imperative verbs (`add`, `pull`, `push`, `pick`, `amend`) — exactly how a developer opens a request to an AI. The veto in `tugdeck/src/lib/shell-line-classifier.ts` was calibrated against the first population and will now see the second.

Measured against 24 realistic prose lines opening on those words: **8 leaked past the veto (33%)**, with **0 false vetoes** across 14 real command lines. Leaks:

```
add error handling here          pick whichever approach seems cleaner
add support for nested cards     pull request review please
amend last commit please         stuff we should revisit later
pick up where we left off        site navigation feels sluggish
```

Every leak is short imperative prose carrying no article and no pronoun.

Two concrete gaps found in `vetoesShellVerdict`:

- `PROSE_MARKERS` contains `i, it, me, my, you, this, that, these, those, them` but **not `we`, `us`, `our`**. The pronoun set is simply incomplete.
- `COMMAND_TOKEN_CEILING` is 6 and the test is `tokens.length > COMMAND_TOKEN_CEILING`, so a 6-token line with a hint never vetoes. `pick up where we left off` is exactly 6.

### Pipelines already grade correctly — no work needed

`grade_with_catalog` lexes into segments and takes the weakest band across them (`band = band.min(segment_band)`). Verified with `cargo build -p tuggram --bin grade`:

```
ls -la | less             → yes
ls -la | frobnicate       → no
git status && echo done   → maybe
```

An expansion that is a pipeline or an `&&` chain is therefore handled by the existing grader, and needs no work.

### A body that names no parameter discards the arguments typed after it

```
amend () { git commit --amend }     ← no $*, so `amend x y z` runs `git commit --amend`
```

This is why [P04] turns on whether the body can absorb what the user typed, and why `Band::Yes` is reachable from a parameterless body only when the typed line is bare. `git commit --amend` on its own grades `yes`, which is the one band that routes with no model call and no veto — so the band a parameterless body contributes is correct only when there is nothing after the word.

### What expansion is worth, precisely

```
git status        → yes      git status $*    → maybe
git status -sb    → yes      git status "$@"  → maybe
gs                → unknown  (no synopsis — ghostscript is not in the catalog)
```

Two consequences. First, the win is real: reaching git-status's grammar turns `gs` and `gs -sb` into `yes`, routed with no model call. Second, **parameter tokens must never be graded literally** — `$*` and `"$@"` read as unrecognized positionals and knock `yes` down to `maybe`, so the substitution in [P04] is what the band depends on.

Today `gs` grades `unknown` and carries no synopsis: ghostscript resolves on PATH but has no catalog entry. So the word is a candidate by coincidence of a same-named binary, which is exactly what [P01] replaces with the shell's own answer.

### Expandability distribution on a real machine

| Function | Body | Classification |
|---|---|---|
| `gs` | `git status $*` | Simple, takes args |
| `pick` | `git cherry-pick $*` | Simple, takes args |
| `amend` | `git commit --amend` | Simple, **no** params |
| `stuff` | `bbedit /Users/…/how-to-do-stuff.txt` | Simple, **no** params |
| `site` | `ssh deploy@…` | Simple, **no** params |
| `add` | `git add $*` **then** `git status` | Opaque (two statements) |
| `pull` / `push` | assignment + backtick substitution + 3 statements | Opaque |

"Single simple command" is a real filter: it keeps 3 of these 7 out of expansion entirely.

### Cost

```
1072 function names   → 9,704 bytes, 44 ms
one function body     → 43 ms
```

The 44 ms is almost entirely shell spawn — a single body costs the same. So: enumerate names once for membership; read a body only for a word the user actually typed. Never pay for 1072 bodies.

### Plumbing gotcha

`bash -i` writes `bash: no job control in this shell` to **stderr**. The dump must read stdout only, or the table parses garbage.

## Current code shapes the plan must change

**`tugrust/crates/tuggram/src/lib.rs`**

- `pub fn grade(line, commands: &CommandSet, cwd: Option<&Path>) -> Graded` → `grade_with_catalog(...)`.
- `enum Resolution { Resolved, Absent, Unchecked }` (private).
- `fn resolve_head(head, commands, cwd) -> Resolution` — handles `$` (Unchecked), `~/`, `~user` (Unchecked), absolute, relative-with-`/` (needs cwd), then `commands.contains(head) || is_builtin(head)`.
- `pub struct CommandSet<'a> { names: &'a [String] }` with `new_sorted`, `contains` (binary search).
- `pub const SHELL_BUILTINS`, `pub fn is_builtin`.
- `fn catalog_key(head)` — strips a leading path so `/usr/bin/git` keys as `git`.
- Grading arm: `Absent → No`, `Unchecked → Unknown`, `Resolved → catalog.get(catalog_key(head))` then `None → Unknown` / `Some(entry) → grade_tokens(&entry.grammar, segment.args(), cwd)`; a `Maybe` contributes `entry.synopsis`.
- `src/bin/grade.rs` — the eval harness's CLI onto the real grader; its signature must follow.

**`tugrust/crates/tugcast/src/feeds/shell.rs`**

- `static PATH_COMMANDS: OnceLock<Arc<Vec<String>>>` — swept **once per tugcast process**, never revalidated (the "PATH effectively never changes within a tugcast run" comment).
- `async fn path_command_set() -> Arc<Vec<String>>` — `spawn_blocking(tuggram::compute_path_commands)`.
- `ShellInput::PathCommands` → `emit_path_commands` (`type: "path_commands"`, `commands: [...]`, capped at `PATH_COMMANDS_SERIALIZED_CAP` = 512 KB).
- `ShellInput::ShellGrammar` → `emit_shell_grammar` → `tuggram::grade(&line, &CommandSet::new_sorted(&commands), cwd.as_deref())`; emits `type: "shell_grammar"` with `band` and, on `maybe` only, `synopsis`.
- `warm_classify_lane(&agent)` is already called on both `PathCommands` and `ShellGrammar`.

**`tugdeck/src/lib/`**

- `path-commands-store.ts` — `getSnapshot(): ReadonlySet<string> | null`.
- `shell-line-classifier.ts` — `isShellCandidate(text, commands: ReadonlySet<string> | null)`, `modelCallForBand`, `vetoesShellVerdict`, `resolveSubmitDestination`, `ShellVerdictCache`.
- `shell-grammar-store.ts`, `shell-classify-store.ts` — request/reply stores over `SHELL_OUTPUT`.

## Design decisions

**[P01] The shell is the authority on membership.** A word is a candidate when the session's shell will resolve it — alias, function, builtin, or PATH binary. This *closes* an existing gap unrelated to aliases: builtins like `setopt`, `fg`, `bindkey` are not on PATH and are invisible to the current candidate test, while `cd` sneaks through only because macOS ships `/usr/bin/cd`.

**[P02] Ask the shell; never parse rc files.** `.zshrc` has conditionals, plugin managers, and machine-specific branches. The only ground truth for what a word means in this session is the shell that will execute it. Enumerate with a NUL-delimited dump (not `alias`'s quoted output, whose escaping has real edge cases).

**[P03] Grade what the user typed; let the expansion supply only the grammar.** The subject of grading is always the typed line. The expansion contributes the *grammar to consult* and the *position within it*.

The user effect is the whole point: type a sentence and Claude answers it; type a command and it runs. `amend last commit please` does not look like a command, so it grades `Unknown`, the model reads it as English, and it goes to Claude. Bare `amend` does look like a command, so it runs. Both times, what the person meant.

**[P04] Expansion is faithful only when the body's parameters can absorb the typed arguments.** Three cases:
- Body references `$*`/`$@`/`$1`… and the user typed arguments → splice them in. `gs -sb` grades as git's grammar entered at `status`, then `-sb` → `yes`.
- Body has no parameter reference and the user typed **nothing** → the expansion *is* the line. `amend` bare → `git commit --amend` → `yes`, routed. Correct: they typed it bare, meaning to run it.
- Body has no parameter reference and the user typed arguments → **the arguments vanish on execution**. The expansion is not what the line means, so it must not supply a band. Grade `Unknown`. A person who knows `amend` takes no arguments would not type `amend last commit please` as a command, so surplus arguments on an argument-ignoring word are themselves evidence of prose.

**[P05] Anything but a single simple command is opaque.** Multiple statements, control flow, command substitution, assignments, pipelines *inside the body* → membership yes, grammar no → `Unknown` → the model decides. The body parser must be conservative: when in doubt, `Opaque`. It is the one genuinely new piece of logic in this work, and the component every band derived from an expansion depends on, so it carries the heaviest test burden.

**[P06] An opaque word must skip the catalog entirely.** It must not fall through to `catalog.get(catalog_key(head))` — a user function named `git` would otherwise be graded against real git's grammar. This is why `Opaque` is its own `Resolution` variant rather than folding into `Resolved`.

**[P07] Resolution order follows the shell: alias → function → builtin → PATH.** This machine proves it matters: `gs` is a function *and* ghostscript is on PATH, and the shell picks the function. Path-shaped words (`/usr/bin/gs`, `./x`) are never aliases or functions, so those branches stay first and unchanged.

**[P08] Staleness is asymmetric in the safe direction, so no watcher is needed.** A missing entry costs only coverage — the line goes to Claude, the designed degraded path. A stale-present entry routes to a shell that says "command not found", visibly and recoverably. Nothing about freshness failure can run a *wrong* command. Probe-at-use plus cheap revalidation is therefore sufficient; a filesystem watcher or coherence daemon is out of scope.

## Specification

### [S01] The shell word table

Source: a throwaway `$SHELL -ilc '<dump>'` spawned from the session's project directory, at the same moment the card asks for `path_commands` (card mount) — the moment that already warms the classify lane. A throwaway is chosen over interrogating the live exec child (serialized behind the user's commands; probe exchanges would interleave with their work) and over eager-spawning the session shell (changes when rc side effects happen). Read **stdout only**.

Dump content, NUL-delimited, shell-specific:

- zsh: alias name/value pairs from `${(kv)aliases}`; function names from `${(k)functions}`.
- bash: `alias` output; function names from `declare -F`.

Filter `_`-prefixed names out of the function list — 93% of the surface on a real machine, and none of it user-invocable.

Bodies are **not** dumped in bulk. A body is fetched on demand (`functions <name>` / `declare -f <name>`) for a word the user actually typed, and memoized.

Shape:

```rust
pub enum ShellWord {
    /// Expands to one simple command. `head` is the program that runs;
    /// `prefix` the literal arguments the expansion already supplies;
    /// `takes_args` whether the body references $*/$@/$N.
    Simple { head: String, prefix: Vec<String>, takes_args: bool },
    /// Resolves, but its shape cannot be read. Membership yes, grammar no.
    Opaque,
}
pub struct ShellWords { /* name → ShellWord */ }
```

Scope: **per session**, because a user can type `alias foo=bar` into the session at any time. Refresh trigger: re-dump after any `exec` whose line begins `alias`, `unalias`, `source`, or `.` — no timer, no watcher.

### [S02] `Resolution` gains what it resolved to

```rust
enum Resolution<'a> {
    Resolved,                                                    // PATH, builtin, or a path that stats
    Expands { head: &'a str, prefix: &'a [String], takes_args: bool },
    Opaque,                                                      // resolves; grammar unreadable
    Absent,                                                      // the only route to Band::No
    Unchecked,                                                   // the check could not run
}
```

`resolve_head` keeps its `$`/`~`/absolute/relative branches unchanged and first, then consults the word table before `commands.contains(head) || is_builtin(head)` per [P07].

### [S03] The grading arm

```
Absent               → Band::No
Unchecked | Opaque   → Band::Unknown          (no catalog lookup — see [P06])
Resolved             → unchanged: catalog.get(catalog_key(head)), None → Unknown
Expands { head, prefix, takes_args } →
    catalog.get(catalog_key(head)):
      None                                        → Unknown
      Some(entry) if takes_args || args.is_empty() → grade_tokens(entry.grammar,
                                                       prefix ++ typed_args, cwd)
      Some(_)                                      → Unknown        (per [P04] case 3)
```

Expected outcomes on this machine's functions: `gs` → `yes`; `gs -sb` → `yes`; `amend` → `yes`; `amend last commit please` → `Unknown`; `add …`, `pull …`, `push …` → `Unknown`.

### [S04] Plumbing

`grade`'s three fact sources become a struct rather than a fourth positional parameter — this also states the architecture:

```rust
pub struct ShellContext<'a> {
    pub commands: CommandSet<'a>,    // membership: PATH
    pub words: &'a ShellWords,       // membership + grammar source: the session's shell
    pub cwd: Option<&'a Path>,       // path resolution
}
pub fn grade(line: &str, ctx: &ShellContext) -> Graded
```

`src/bin/grade.rs` follows. Deck side: the `path_commands` reply grows a companion carrying the word **names only** — `isShellCandidate` needs membership and nothing else, so no bodies cross the wire. `PathCommandsStore.getSnapshot()` returns the union.

### [S05] PATH freshness

Independent of the word table, and the reason `gs` was ever a candidate by coincidence:

- **Per-word probe at grade time.** When a bare word is checked, verify with a direct stat sweep across PATH directories for that specific word (~20 syscalls). A `brew install` becomes routable on the next keystroke; a deleted binary stops grading `yes` immediately. The cached set stays as the negative fast path and the deck's precondition.
- **mtime-revalidated bulk sweep.** On `path_commands` / `shell_grammar`, stat the PATH directories' mtimes (throttled to ~once per few seconds) and re-readdir only those that changed. Replaces the current never-revalidated `OnceLock`.

### [S06] Veto recalibration

The veto now faces imperative verbs (see the 33% leak measurement). Two changes are directly supported by the data:

- Add `we`, `us`, `our` to `PROSE_MARKERS`. The pronoun set is incomplete; `i`/`it`/`me`/`my`/`you` are already there. Cost: a bare `us`/`we`/`our` token in a real command now vetoes to Claude — the same accepted trade the existing pronouns already make ("two signals cost a real command a keystroke").
- Re-examine `COMMAND_TOKEN_CEILING`'s `>` boundary against the leak set.

The remaining leaks are short prose with no article and no pronoun (`site navigation feels sluggish`). The veto is the **last** line of defense, not the only one — the model is asked first and should answer PROMPT for all of these. Whether to widen the hint vocabulary further is [Q02].

## Non-goals

- No filesystem watcher, inotify/FSEvents layer, or coherence daemon ([P08]).
- No rc-file parsing ([P02]).
- No change to the 2 s classify triad (`CLASSIFY_TIMEOUT`, `CLASSIFY_REQUEST_TIMEOUT_MS`, `VERDICT_SUBMIT_WAIT_MS`) — settled as staying at 2 s.
- No change to pipeline/`&&` segmentation — already correct.
- No execution of function bodies to discover their behavior, ever.
- No support for zsh global (`alias -g`) or suffix (`alias -s`) aliases in this pass — they substitute anywhere in the line, not just at position 0, and the head-oriented model does not contemplate them. Note as a known limitation.

## Open questions

**[Q01]** Should a routed line whose head expanded show the expansion in its `→ shell` attribution? The user typed `gs`; the row would read more honestly as `gs → git status`. Argues for: the same honesty principle that drove the arbitration-tell work. Argues against: added chrome on every aliased command.

**[Q02]** How far to widen the veto's hint vocabulary beyond the `we`/`us`/`our` fix. The measured leaks suggest `here`, `later`, `whichever`, `seems`, `feels`. Each widening costs real commands a keystroke, and the model already catches these.

**[Q03]** `Band::No` is unreachable through a function head in [S03] — an `Opaque` function name that is really a typo can never grade `no`, so it costs a model call it might not need. Safe direction, not free. Accept, or probe further?

**[Q04]** Nested aliases (`alias g=git; alias gs='g status'`) need transitive expansion with cycle detection. Include in this pass or defer? No instance exists in the observed environment.

## Test plan concepts

- **Body parser corpus** (heaviest burden, per [P05]): the seven real bodies in the table above, plus control flow, `if`/`for`, `&&` chains, command substitution, assignments, nested quotes, empty bodies. Every non-single-simple-command case must yield `Opaque`.
- **`[P04]`, all three cases, against a parameterless body**: bare `amend` grades `Yes` and routes; `amend last commit please` grades `Unknown` and reaches the model. The pair pins that the parser keeps distinguishing a body that absorbs arguments from one that discards them.
- **Shadowing**: a function named `ls` must resolve as the function, not `/bin/ls` ([P07]).
- **Opaque skips the catalog** ([P06]): a function named `git` must not be graded against git's grammar.
- **Parameter tokens are never graded literally**: a body of `git status $*` must not produce a band computed from a literal `$*`.
- **Veto**: the 24-line prose corpus and the 14-line command corpus from the measurement above, as a fixture.
- **Existing app-test posture is unchanged**: `at0280-shared-agent-absent.test.ts` must still pass — with no agent, nothing about the composer changes. App-tests cannot cover the positive path (no token spend), so band outcomes are covered as pure logic in Rust and in `shell-line-classifier.test.ts`.
- Reproduce the measurements: `cargo build -p tuggram --bin grade`, then pipe lines to `./target/debug/grade --cwd <repo>`.

## Deliverables

1. `ShellWords` table + shell dump + body-on-demand + refresh trigger ([S01]).
2. `Resolution` / `resolve_head` / grading arm changes in `tuggram` ([S02], [S03]).
3. `ShellContext` and the `grade` signature change, including `src/bin/grade.rs` ([S04]).
4. tugcast wiring: word table per session, plumbed into `emit_shell_grammar`; word names added to the `path_commands` reply ([S04]).
5. PATH freshness: per-word probe + mtime revalidation replacing the permanent `OnceLock` ([S05]).
6. Deck: `PathCommandsStore` and `isShellCandidate` consume the union ([S04]).
7. Veto recalibration ([S06]).
8. Tests per the concepts above.

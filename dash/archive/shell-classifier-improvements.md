## Shell Classifier Improvements {#shell-classifier-improvements}

**Purpose:** Make the session's shell — not a login-PATH sweep — the authority on what counts as a command word, so aliases, functions, and builtins the user actually types (`gs`, `amend`, `setopt`) are recognized; let an alias/function expansion supply its grammar so the typed line can grade definitively; keep the PATH set fresh; and recalibrate the veto for the imperative-verb population this admits.

This plan implements the brief at [dash/shell-classifer-improvements-brief.md](shell-classifer-improvements-brief.md). Every measurement cited here was verified on the running machine during the 2026-08-07 session and is recorded in that brief.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-07 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Shell arbitration decides whether a line typed into the Session card composer means *run a program* or *write a sentence to Claude*. The bracket of fact sources — `isShellCandidate` in the deck, the `tuggram` grammar grade in tugcast, a SharedAgent verdict, and `vetoesShellVerdict` — resolves every degraded path to Claude, because a wrongly-run command cannot be un-run.

The bracket's first fact source is currently wrong about what a command *is*. It asks whether the first word names a binary on the login PATH (`tugrust/crates/tuggram/src/lib.rs::resolve_head`, consulting a `CommandSet` swept once per tugcast process into a `OnceLock`). The thing that will actually execute the line is the session's shell, spawned `$SHELL -il` (`spawn_shell_child` in `tugrust/crates/tugcast/src/feeds/shell.rs`), which resolves aliases → functions → builtins → PATH. On the reference machine, `gs` is a shell function (`gs () { git status $* }`) that is a candidate today only because ghostscript happens to install a same-named binary; `setopt` is invisible entirely; a binary added by `brew install` after tugcast started is invisible until restart.

The user effect this ships: the shortcuts they actually type get recognized (`gs` runs because their shell says `gs` is a thing), a just-installed binary is routable, builtins are recognized at all, and sentences stay sentences — `add error handling here` goes to Claude because it reads as English, not because `add` was invisible.

#### Strategy {#strategy}

- **Three questions, three sources, none borrowing the others' authority.** Membership is answered by the shell itself; grammar is answered by the catalog, reached through the expansion when the head is an alias or simple function; the subject of grading is always **the line the user typed**, never the expansion. The expansion is a string that exists at no point in the pipeline — we hand the shell `gs` and it expands with the table live at that instant.
- Build bottom-up: pure data structures and the body parser first (in `tuggram`, hermetically testable), then shell interrogation (blocking helpers in `tuggram`, next to the existing `probe_login_path`), then the grading-arm changes, then tugcast wiring, then the deck.
- The body parser is the one genuinely new piece of logic and the component every expansion-derived band depends on, so it defaults to `Opaque` on anything it cannot fully read and carries the heaviest test burden.
- Every new degraded path (dump failure, fetch timeout, unparsed body, stale table) resolves to `Unknown` → the model → the veto, i.e. exactly today's pre-grader behavior. Nothing about freshness or parsing failure can run a wrong command.
- The 2s classify triad, the pipeline segmentation, and the SharedAgent are untouched.

#### Success Criteria (Measurable) {#success-criteria}

- On a machine where the shell defines `gs () { git status $* }`: `gs` and `gs -sb` grade `yes` (routed, no model call); `amend` (body `git commit --amend`, no params) grades `yes` bare; `amend last commit please` grades `unknown` (reaches the model). Verified by `tuggram` unit tests with an injected word table, and reproducible live via `./target/debug/grade`.
- A function named `git` never grades against real git's catalog grammar (pinned by a unit test).
- A function named `ls` resolves as the function, not `/bin/ls` (shadowing test).
- A body of `git status $*` never produces a band computed from a literal `$*` token (pinned).
- The seven real bodies from the brief's expandability table parse to their stated classifications; every multi-statement / control-flow / substitution / assignment body parses `Opaque` (corpus test).
- Deleting a binary from a PATH directory stops it grading `yes` on the next grade after the revalidation throttle passes; adding one makes it a candidate after the next revalidation-triggering event (tugcast test with a temp PATH dir).
- A committed veto corpus fixture whose load-bearing lines are the 8 measured leaks (recorded verbatim in this plan), surrounded by implementer-authored prose and command lines; adding `we`/`us`/`our` to `PROSE_MARKERS` vetoes the pronoun-carrying leaks with zero false vetoes on the command lines (deck test).
- `at0280-shared-agent-absent.test.ts` still passes; `cd tugrust && cargo nextest run` green; `bun test` green in tugdeck; `bunx vite build` clean.

#### Scope {#scope}

1. `tuggram`: `ShellWord`/`ShellWords` types, the conservative body parser, shell interrogation helpers (dump + on-demand body fetch), `ShellContext`, the extended `Resolution`, the new grading arm, the per-word PATH probe, and the `grade` signature change (including `src/bin/grade.rs`).
2. `tugcast` (`feeds/shell.rs` + one new module): mtime-revalidated PATH cache replacing the permanent `OnceLock`, per-session word table with dump-at-mount and refresh triggers, body fetch-on-demand ahead of grading, the `shell_words` reply frame, and re-emission on change.
3. `tugdeck`: `PathCommandsStore` folds the union (PATH names ∪ shell word names); `path_commands` request carries the project dir; veto recalibration in `shell-line-classifier.ts`.
4. Tests per the concepts below.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No filesystem watcher, inotify/FSEvents layer, or coherence daemon ([P08]).
- No rc-file parsing ([P02]).
- No change to the 2s classify triad (`CLASSIFY_TIMEOUT` in `shared_agent.rs`, `CLASSIFY_REQUEST_TIMEOUT_MS` in `shell-classify-store.ts`, `VERDICT_SUBMIT_WAIT_MS` in `tug-prompt-entry.tsx`) — settled as staying at 2s.
- No change to pipeline/`&&` segmentation — `grade_with_catalog` already takes the weakest band across segments and this is verified correct.
- No execution of function bodies to discover their behavior, ever. (Dumping names and printing definitions is reading; running them is not done.)
- No support for zsh global (`alias -g`) or suffix (`alias -s`) aliases — they substitute anywhere in the line, not just at position 0, and the head-oriented model does not contemplate them. Known limitation, documented in the `words` module doc.
- No expansion display in the routed row's attribution ([Q01], deferred).

#### Dependencies / Prerequisites {#dependencies}

- The arbitration-tell work (Escape withdrawal, `resolveSubmitDestination`, the Z5 wave) is already on main; this plan builds on `resolveSubmitDestination` unchanged.
- `tuggram::lex` is reused by the body parser; no lexer changes are needed.
- No tugcode changes: all wire traffic is `SHELL_INPUT`/`SHELL_OUTPUT` through tugcast, which does not go through tugcode's inbound-message allowlist.

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** (`-D warnings` via `tugrust/.cargo/config.toml`).
- `grade()` stays pure over the filesystem-only hot path: table lookups plus `stat`. Shell interrogation (spawning `$SHELL`) happens only in the explicit dump/fetch helpers, never inside grading.
- `bash -i` writes `bash: no job control in this shell` to **stderr**; every dump/fetch must read stdout only or the table parses garbage.
- The dump is NUL-delimited and iterates shell variables (`${(@kv)aliases}`, `${!BASH_ALIASES[@]}`) — never `alias`'s quoted display output, whose escaping has real edge cases ([P02]).
- App-tests cannot cover the positive classification path (`TUGAPP_APP_TEST=1` gates the SharedAgent pool off; no token spend), so band outcomes are covered as pure logic in Rust and in `shell-line-classifier.test.ts`.
- Deck edits follow the tuglaws; the only deck state change is inside an existing [L02] store (see [State Zone Mapping](#state-zone-mapping)).

#### Assumptions {#assumptions}

- `$SHELL` is bash or zsh for interrogation purposes; anything else gets an empty word table and today's behavior (mirrors `resolve_exec_shell()`'s fallback posture, but the *word table* must reflect the login shell that defined the user's habits, so a non-bash/zsh `$SHELL` means no table rather than a `/bin/zsh` guess).
- Alias and function names never contain a tab or NUL (the dump's field/record separators). A name that does is pathological and simply fails to parse into the table — coverage lost, nothing misrouted.
- The measured costs hold: full name dump ≈ 44 ms (almost all shell spawn), one body fetch ≈ 43 ms. Both are paid off the submit path (dump at card mount, fetch behind the typing debounce).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Show the expansion in the routed row's attribution? (DEFERRED) {#q01-expansion-attribution}

**Question:** Should a routed line whose head expanded show `gs → git status` in its `→ shell` attribution?

**Why it matters:** Honesty of the transcript record — the same principle that drove the arbitration-tell work. Against: added chrome on every aliased command.

**Resolution:** DEFERRED. Pure UI chrome, separable from correctness, and it touches transcript-row rendering this plan otherwise never enters. Revisit as a follow-on once the routing behavior has been lived with (listed under [Roadmap](#roadmap)).

#### [Q02] How far to widen the veto's hint vocabulary? (DECIDED — see [P12]) {#q02-veto-vocabulary}

**Question:** Beyond `we`/`us`/`our`, should `here`, `later`, `whichever`, `seems`, `feels` become hints?

**Resolution:** DECIDED as the minimal change ([P12]): add the three pronouns, keep `COMMAND_TOKEN_CEILING` and its `>` boundary unchanged. With the pronouns added, the remaining measured leaks (`add error handling here`, `site navigation feels sluggish`) carry no marker and are 4 tokens — no ceiling ≤ 6 catches them without also endangering real commands, and each hint widening costs real commands a keystroke. The veto is the *last* line of defense; the model is asked first and should answer PROMPT for all of these. The corpus fixture ([S07](#s07-veto-corpus)) makes any future widening measurable instead of speculative.

#### [Q03] `Band::No` is unreachable through a function head. (DECIDED — accepted) {#q03-no-unreachable}

**Question:** An `Opaque` function name that is really a typo can never grade `no`, so it costs a model call it might not need. Accept?

**Resolution:** DECIDED: accept. `No` requires evidence of absence, and a word the shell resolves is not absent — it is a member whose grammar cannot be read. The cost is one model round trip on a path that already existed for every uncataloged command; the alternative (guessing `no` from an unreadable body) violates the band doctrine that failed validation is never evidence of absence.

#### [Q04] Nested aliases (`alias g=git; alias gs='g status'`). (DECIDED — see [P10]) {#q04-nested-aliases}

**Resolution:** DECIDED: include transitive resolution with a depth cap and cycle detection ([P10]). It is ~15 lines in a pure function over the table, closes a real hole (a chain would otherwise grade against the *intermediate* name's absent catalog entry), and a cycle or over-deep chain degrades to `Opaque` — the safe band.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Body parser reads a body as `Simple` that isn't | high | low | conservative default ([P05]), pre-scan before lex, corpus test over real bodies + adversarial shapes | any misparse found in the wild |
| Shell dump hangs or pollutes on a heavy rc profile | med | med | hard timeout → empty table → today's behavior; stdout-only read | dump timeouts observed in logs |
| New `shell_words` frame confuses an existing SHELL_OUTPUT consumer | med | low | verify `ShellSessionStore` and both request/reply stores ignore unknown `type`s (they all filter on exact `type` today); pinned by a deck test | — |
| `we`/`us`/`our` veto a real command | low | low | same accepted trade the existing pronouns make; 0 false vetoes on the 14-command corpus | corpus fixture regressions |

**Risk R01: A `Simple` misparse routes a wrong command** {#r01-simple-misparse}

- **Risk:** If the parser calls a body `Simple` whose real execution differs (hidden second statement, substitution, redirect), a spliced `yes` could route a line whose effect the grade never saw.
- **Mitigation:** The parser pre-scans the raw body for `;`, `<`, `>`, newlines-after-normalization, and any `$` outside the parameter set before ever lexing; `lex` itself refuses backticks, `$(`, heredocs, and process substitution; segment count ≠ 1 → `Opaque`; env-assignment prefixes → `Opaque`. The corpus test enumerates every construct class.
- **Residual risk:** A shell feature none of the scans name (e.g. zsh-specific glob qualifiers in the body) — but those survive only as literal prefix tokens handed to `grade_tokens`, which degrades unrecognized tokens to `Maybe` (model + veto), never silently to `yes`.

**Risk R02: Per-session dumps multiply shell spawns** {#r02-dump-cost}

- **Risk:** Every card mount spawns a throwaway `$SHELL -ilc`; refresh triggers spawn more.
- **Mitigation:** ≈44 ms each, off any latency path; refresh only fires on `alias`/`unalias`/`source`/`.` execs (rare, human-initiated); the dump is one spawn, not one per name.
- **Residual risk:** A pathologically slow rc profile pays its cost per card mount — bounded by the timeout, degrading to coverage loss only.

---

### Design Decisions {#design-decisions}

> [P01]–[P08] restate the brief's decisions so this plan stands alone; [P09]–[P13] are new here, resolving what the brief left to the plan.

#### [P01] The shell is the authority on membership (DECIDED) {#p01-shell-authority}

**Decision:** A word is a candidate when the session's shell will resolve it — alias, function, builtin, or PATH binary.

**Rationale:** The executor is `$SHELL -il` with rc files in force; the classifier must consult the same reality. This also closes a gap unrelated to aliases: builtins like `setopt` and `bindkey` are not on PATH and are invisible to the current candidate test, while `cd` sneaks through only because macOS ships `/usr/bin/cd`.

**Implications:** The deck's precondition set becomes a union (PATH names ∪ shell word names); `resolve_head` consults the word table before the PATH set.

#### [P02] Ask the shell; never parse rc files (DECIDED) {#p02-ask-the-shell}

**Decision:** Membership and bodies come from interrogating a live shell (NUL-delimited variable iteration), never from reading `.zshrc`.

**Rationale:** rc files have conditionals, plugin managers, and machine-specific branches; the only ground truth for what a word means in this session is the shell that will execute it. `alias`'s quoted display output has real escaping edge cases; `${(@kv)aliases}` / `${!BASH_ALIASES[@]}` iteration avoids them.

#### [P03] Grade what the user typed; the expansion supplies only the grammar (DECIDED) {#p03-grade-the-typed-line}

**Decision:** The subject of grading is always the typed line. The expansion contributes the *grammar to consult* and the *position within it* — nothing else.

**Rationale:** The question is about *intent*, and intent lives in the keystrokes. We never execute the expansion either — the shell expands `gs` itself, with the table live at that instant. The user effect: type a sentence and Claude answers it; type a command and it runs. `amend last commit please` does not look like a command, so it grades `Unknown` and the model reads it as English; bare `amend` does look like a command, so it runs. Both times, what the person meant.

#### [P04] Expansion is faithful only when the body's parameters absorb the typed arguments (DECIDED) {#p04-argument-absorption}

**Decision:** Three cases, exactly:
- Body references `$*`/`$@`/`$N` **and** the user typed arguments → splice: grade `prefix ++ typed_args` against the expanded head's grammar. `gs -sb` grades as git's grammar entered at `status`, then `-sb` → `yes`.
- Body has no parameter reference and the user typed **nothing** → the expansion *is* the line. Bare `amend` → `git commit --amend` → `yes`, routed. Correct: they typed it bare, meaning to run it.
- Body has no parameter reference and the user typed arguments → the arguments vanish on execution (`amend x y z` runs `git commit --amend`), so the expansion is not what the line means and must not supply a band. Grade `Unknown`. Surplus arguments on an argument-ignoring word are themselves evidence of prose.

**Implications:** Parameter tokens are **never graded literally** — `$*` and `"$@"` read as unrecognized positionals and would knock `yes` down to `maybe`; the parser strips them into `takes_args` instead.

#### [P05] Anything but a single simple command is opaque (DECIDED) {#p05-opaque-default}

**Decision:** Multiple statements, control flow, command substitution, assignments, redirections, pipelines *inside the body* → membership yes, grammar no → `Unknown` → the model decides. When in doubt, `Opaque`.

**Rationale:** This parser is the component every expansion-derived band depends on; measured on the reference machine, "single simple command" is a real filter (it keeps `add`, `pull`, `push` — multi-statement bodies — out of expansion entirely, 3 of the 7 real bodies).

#### [P06] An opaque word skips the catalog entirely (DECIDED) {#p06-opaque-skips-catalog}

**Decision:** `Opaque` is its own `Resolution` variant; it never falls through to `catalog.get(catalog_key(head))`.

**Rationale:** A user function named `git` would otherwise be graded against real git's grammar — a band derived from a program that will not run.

#### [P07] Resolution order follows the shell: alias → function → builtin → PATH (DECIDED) {#p07-resolution-order}

**Decision:** The word table is consulted in shell precedence order before `commands.contains(head) || is_builtin(head)`. Path-shaped words (`/usr/bin/gs`, `./x`, `~/bin/x`, `$VAR`) are never aliases or functions, so those branches in `resolve_head` stay first and unchanged.

**Rationale:** The reference machine proves it matters: `gs` is a function *and* ghostscript is on PATH, and the shell picks the function.

#### [P08] Staleness is asymmetric in the safe direction; no watcher (DECIDED) {#p08-safe-staleness}

**Decision:** Probe-at-use plus cheap revalidation; no filesystem watcher or coherence daemon.

**Rationale:** A missing entry costs only coverage — the line goes to Claude, the designed degraded path. A stale-present entry routes to a shell that says "command not found", visibly and recoverably. Nothing about freshness failure can run a *wrong* command.

#### [P09] Builtins come from the dump, kind-tagged, and keep the catalog path (DECIDED) {#p09-builtins-from-dump}

**Decision:** The dump enumerates builtins (`${(k)builtins}` / `compgen -b`) alongside aliases and functions. Each member carries its kind. A builtin member resolves as `Resolved` (the catalog lookup stays available, matching today's `is_builtin` path), while an alias/function member with no parsed body resolves `Opaque`.

**Rationale:** [P01] names builtins as part of the shell's authority, and the static `SHELL_BUILTINS` list (28 names) misses `setopt`, `bindkey`, `unfunction`, and every other zsh-ism. The kind tag matters because a builtin named `echo` must keep grading against the catalog's `echo` entry exactly as `is_builtin` gives it today, while an unfetched function named `echo` must not ([P06]). `SHELL_BUILTINS` stays as the fallback for an empty table.

#### [P10] Alias/function chains resolve transitively, capped and cycle-checked (DECIDED) {#p10-transitive-resolution}

**Decision:** `ShellWords::resolve(name)` follows `Simple` heads through the table: resolving `gs` → `Simple{head: "g", …}` where `g` → `Simple{head: "git"}` yields head `git` with prefixes concatenated inner-first and `takes_args` taken from the outermost entry. Depth cap 8; a cycle or an unparsed member anywhere in the chain → `Opaque`.

**Rationale:** Resolves [Q04]. Without it a chain grades against the intermediate name's (absent) catalog entry; with it the chain reaches the real program's grammar. Pure table walking — no shell involvement at resolve time.

#### [P11] PATH revalidation is event-driven and pushes on change (DECIDED) {#p11-revalidation-push}

**Decision:** The process-wide `OnceLock` PATH cache is replaced by a cache that re-stats the PATH directories' mtimes — throttled to one check per 3 seconds — on three triggers: a `path_commands` request, a `shell_grammar` request, and an `exec` exchange settling. Only directories whose mtime changed are re-readdir'd. When the set changes, tugcast re-emits a `path_commands` frame to every session that has requested one, so the deck's precondition set follows.

**Rationale:** The deck gates both the typing-debounce grammar request and the submit path on `isShellCandidate` (`tug-prompt-entry.tsx`), so a freshly installed binary can *only* become routable if the deck's set refreshes — revalidation that never reaches the deck would satisfy the letter of the brief's [S05] and miss its point ("a `brew install` becomes routable"). The exec-settle trigger is the moment installs actually happen in this UI (`brew install x` typed into the `$` route). The login PATH *string* stays probed once per process (`probe_login_path`); only the directories' *contents* revalidate.

**Implications:** The dispatcher tracks which sessions have requested `path_commands` (a `HashSet<String>`); the deck's `PathCommandsStore` already folds every matching frame, so re-emission needs no deck change beyond what Step 8 ships.

#### [P12] Veto recalibration is the minimal measured change (DECIDED) {#p12-veto-minimal}

**Decision:** Add `we`, `us`, `our` to `PROSE_MARKERS` in `tugdeck/src/lib/shell-line-classifier.ts`. `COMMAND_TOKEN_CEILING` (6) and its `>` boundary stay.

**Rationale:** The veto now faces imperative verbs (`add`, `pull`, `pick`, `amend` — function names are verbs, PATH names are tool-nouns), and the measured leak set shows the pronoun gap is simply an incomplete set (`i`/`it`/`me`/`my`/`you` are already there). Of the 8 measured leaks, the pronoun fix catches `pick up where we left off` and `stuff we should revisit later`; the remainder carry no marker at all and belong to the model, which is asked first. Cost: a bare `we`/`us`/`our` token in a real command vetoes to Claude — the same accepted trade the existing pronouns make. See [Q02] for why the ceiling stays.

#### [P13] Shell interrogation lives in `tuggram`; orchestration lives in tugcast (DECIDED) {#p13-interrogation-placement}

**Decision:** The blocking dump and body-fetch helpers go in a new `tuggram::words` module, beside `probe_login_path` (which already spawns `$SHELL` from this crate). tugcast wraps them in `spawn_blocking` and owns all caching, per-session state, refresh triggers, and frames. `grade()` itself never spawns anything.

**Rationale:** Keeps the grader's "never executes anything at grading time" doctrine intact while giving `src/bin/grade.rs` (the eval harness's seam onto reality) the same interrogation code the app uses — no second expression of the dump that drifts.

---

### Deep Dives {#deep-dives}

#### The verified findings this plan is built on {#verified-findings}

All measured on the reference machine (2026-08-07); reproduce with the commands shown.

- **The executor's reality is already correct.** `spawn_shell_child` spawns `$SHELL -il` (`login: true`); `-i` is what enables alias expansion; the test `login_shell_sources_user_rc` pins that an rc-defined alias expands. `resolve_exec_shell()` returns `$SHELL` when bash/zsh, else `/bin/zsh`. The child is **lazy** — it spawns on the first `exec`, and `SessionShared.cwd` is `None` until then.
- **The motivating case is a function, not an alias.** `/bin/zsh -ilc 'whence -w gs'` → `gs: function`; body `gs () { git status $* }`. The environment holds 2 aliases and 1072 functions.
- **The function surface is 72, not 1072.** 1000 of the names are `_`-prefixed completion functions, not user-invocable. Of the 72, 10 are genuine dictionary words — `add amend kop pick prof pull push site stuff tup` — and all 10 are newly candidate-eligible (none is on PATH today).
- **The population shift is the real change.** PATH names are tool-nouns; function names are imperative verbs — exactly how a developer opens a request to an AI. Against 24 realistic prose lines opening on those words, 8 leaked past the veto (33%), with 0 false vetoes across 14 real command lines. Every leak is short imperative prose with no article and no pronoun.
- **Pipelines already grade correctly.** `grade_with_catalog` takes `band.min(segment_band)` across segments: `ls -la | less` → yes, `ls -la | frobnicate` → no, `git status && echo done` → maybe. No work needed.
- **A parameterless body discards typed arguments.** `amend () { git commit --amend }` — no `$*`, so `amend x y z` runs `git commit --amend`. This is why [P04] turns on absorption.
- **What expansion is worth, precisely.** `git status` → yes; `git status $*` graded literally → maybe (the parameter token reads as an unrecognized positional — hence the parser strips it); `gs` today → unknown with no synopsis (ghostscript resolves on PATH but has no catalog entry — candidacy by coincidence, which [P01] replaces).
- **Expandability distribution:** of 7 real bodies — `gs`/`pick` Simple-takes-args, `amend`/`stuff`/`site` Simple-no-params, `add`/`pull`/`push` Opaque (multi-statement).
- **Cost:** 1072 names dump = 9,704 bytes in 44 ms; one body fetch = 43 ms. Both ≈ pure shell-spawn cost. So: enumerate names once for membership; fetch a body only for a word the user actually typed; never pay for 1072 bodies.
- **Plumbing gotcha:** `bash -i` writes `bash: no job control in this shell` to stderr. Read stdout only.

#### The end-to-end flow after this plan {#end-to-end-flow}

1. **Card mount.** `card-services-store.ts` constructs `PathCommandsStore` and calls `request()`, now carrying `binding.projectDir` as `cwd`. tugcast replies with `path_commands` (PATH names, from the revalidating cache) **and** a companion `shell_words` frame (member names only — no bodies cross the wire; `isShellCandidate` needs membership and nothing else). The dump's throwaway `$SHELL -ilc` spawns from the project dir. `warm_classify_lane` fires exactly as today.
2. **Typing.** The debounce in `tug-prompt-entry.tsx` checks `isShellCandidate(text, union)`. `gs` is now in the union, so `shell_grammar` and `shell_classify` fire concurrently, exactly as today.
3. **Grading (tugcast).** `emit_shell_grammar` lexes the line's segment heads; for any head that is an alias/function member with no parsed body, it fetches the body (`spawn_blocking`, ≈43 ms, memoized), then grades with `ShellContext { commands, words, path_dirs, cwd }`. The reply frame is unchanged in shape (`band` + `synopsis` on maybe).
4. **Submit.** `performSubmit` → `modelCallForBand` → `resolveSubmitDestination`, all unchanged. `gs` arrives as a cached `yes` and routes with no model call.
5. **Refresh.** An `exec` whose command's first token is `alias`, `unalias`, `source`, or `.` re-dumps the table after the exchange settles and re-emits `shell_words`. Any exec settle also pokes the (throttled) PATH revalidation; a changed PATH set re-emits `path_commands` to requesting sessions.

#### Body-print normalization across shells {#body-print-normalization}

The fetchers read *printed definitions*, and the two shells print differently — this is a correctness trap for the single-statement check:

- zsh `functions gs` prints `gs () {\n\tgit status $*\n}` — one statement, three lines.
- bash `declare -f gs` pretty-prints as `gs () \n{ \n    git status $*\n}` — one statement, **four** lines, and multi-statement bodies print one statement per line *without* semicolons.

So a raw newline scan would call every bash function `Opaque`. The parser therefore normalizes first: drop the `name ()` header line, strip the outer brace pair, trim each remaining line, drop empties, and strip one trailing `;` from a line. **Then**: more than one non-empty line → `Opaque`; otherwise the single statement line proceeds to the pre-scan and lex. The corpus test includes captured print-forms from both shells.

#### Why the deck ships names-only and null-until-loaded {#deck-names-only}

`isShellCandidate` is a membership test; bodies would be dead weight on the wire and a second copy of truth to keep coherent. The store's existing contract — `getSnapshot()` returns `null` until the `path_commands` reply lands, and the classifier answers Claude on `null` — is unchanged: `shell_words` arriving first is held aside and unioned in when `path_commands` lands, so the "still loading → Claude" safety net keeps one trigger.

---

### Specification {#specification}

**Spec S01: The word table types (`tuggram`)** {#s01-word-table}

New module `tugrust/crates/tuggram/src/words.rs`, re-exported from `lib.rs`:

```rust
/// What one shell word expands to, as read from its printed definition.
pub enum ShellWord {
    /// Expands to one simple command. `head` is the program that runs;
    /// `prefix` the literal arguments the expansion already supplies;
    /// `takes_args` whether the body references $*/$@/$N (always true
    /// for an alias — the shell appends the remaining typed tokens).
    Simple { head: String, prefix: Vec<String>, takes_args: bool },
    /// Resolves, but its shape cannot be read. Membership yes, grammar no.
    Opaque,
}

/// What kind of thing the shell said a member is.
pub enum WordKind { Alias, Function, Builtin }

/// The session shell's word table: every name the shell will resolve ahead
/// of PATH, with parsed expansions for the words whose bodies have been read.
pub struct ShellWords { /* name → (WordKind, Option<ShellWord>) */ }

impl ShellWords {
    pub fn empty() -> Self;
    pub fn insert(&mut self, name: String, kind: WordKind);          // member, body unread
    pub fn insert_parsed(&mut self, name: String, kind: WordKind, word: ShellWord);
    pub fn kind(&self, name: &str) -> Option<WordKind>;
    pub fn needs_body(&self, name: &str) -> bool;   // alias/function member with no parsed word
    pub fn member_names(&self) -> Vec<&str>;        // sorted, for the shell_words frame
    /// Transitive resolution per [P10]: follow Simple heads through the
    /// table, depth-capped at 8, cycle → Opaque, unparsed link → Opaque.
    pub fn resolve(&self, name: &str) -> Option<ResolvedWord>;
}
```

Alias entries override function entries of the same name (shell precedence, [P07]). `ShellWords::empty()` is the degraded table: everything falls through to PATH/builtins exactly as today.

**Spec S02: The body parser (`tuggram::words`)** {#s02-body-parser}

```rust
pub fn parse_alias_value(value: &str) -> ShellWord;
pub fn parse_function_body(printed: &str) -> ShellWord;
```

`parse_function_body` takes the *printed definition* (the full `functions <name>` / `declare -f <name>` output) and applies, in order:

1. **Normalize** per [#body-print-normalization](#body-print-normalization): drop the header line, strip the outer braces, trim lines, drop empties, strip one trailing `;`. More than one non-empty line remaining → `Opaque`.
2. **Pre-scan** the statement for `;`, `<`, `>` anywhere (quoted or not — conservative) → `Opaque`. (`` ` ``, `$(`, `<(`, heredocs are refused by `lex` in the next step; `|`, `&&`, `||`, `&` produce a second segment, caught below.)
3. **Lex** the statement with `tuggram::lex`. `None` → `Opaque`. Segment count ≠ 1 → `Opaque`. A leading env-assignment token (`Segment::head()` not at token 0) → `Opaque`.
4. **Parameter extraction, on the lexed token stream:** tokens of the single segment exactly equal to `$*`, `$@`, or `$1`…`$9` are removed and set `takes_args = true`. This runs **after** lex deliberately: quote resolution has already collapsed `"$@"`/`"$*"` to the tokens `$@`/`$*`, and — critically — a parameter *inside* a larger quoted span (`echo "a $* b"`) survives as part of its containing token, where the next step catches it. Extracting on a whitespace split of the raw statement would strip that `$*` and misparse the body as `Simple`.
5. Head or any remaining token containing `$` → `Opaque`. Otherwise → `Simple { head, prefix: remaining args, takes_args }`.

*Known residual:* `lex` does not expose per-token quoting, so a single-quoted literal `'$*'` also lexes to the token `$*` and is stripped as a parameter — a misparse, but in a bounded direction: the grade splices the typed arguments into a real program's grammar, and nothing routes that the shell would not run exactly as typed.

`parse_alias_value` is the same pipeline minus the header/brace normalization, with two differences: `takes_args` is always `true` (alias expansion appends the remaining typed tokens), and *any* `$` in the value → `Opaque` (aliases have no positional parameters; a `$` is a live expansion the grade cannot honor).

**Spec S03: Shell interrogation (`tuggram::words`, blocking)** {#s03-interrogation}

```rust
/// One throwaway `$SHELL -ilc <dump-script>` from `cwd`; stdout only; hard timeout.
pub fn dump_shell_words(cwd: Option<&Path>) -> Option<ShellWords>;
/// Print one function's definition: zsh `functions <name>` / bash `declare -f <name>`.
pub fn fetch_function_body(name: &str) -> Option<String>;
```

Same spawn/timeout pattern as the existing `run_path_probe` (background thread + `recv_timeout`); timeout `Duration::from_secs(10)` (heavy profiles; cf. `WARMUP_TIMEOUT`). Returns `None` on non-bash/zsh `$SHELL`, spawn failure, timeout, or non-zero exit — callers treat `None` as the empty table.

Dump scripts (NUL-delimited records, tab-separated fields `kind \t name [\t value]`):

- zsh: `for k v in "${(@kv)aliases}"; do printf 'a\t%s\t%s\0' "$k" "$v"; done; for k in ${(k)functions}; do printf 'f\t%s\0' "$k"; done; for k in ${(k)builtins}; do printf 'b\t%s\0' "$k"; done`
- bash: `for k in "${!BASH_ALIASES[@]}"; do printf 'a\t%s\t%s\0' "$k" "${BASH_ALIASES[$k]}"; done` + `compgen -A function` and `compgen -b` (newline output, folded into records).

Parsing filters `_`-prefixed function names (93% of the surface, none user-invocable), parses alias values immediately via `parse_alias_value` (they are already in hand), and inserts functions/builtins as body-unread members. `fetch_function_body`'s name argument is validated `[A-Za-z0-9_.:@+-]+` before interpolation — a name outside that alphabet stays an unread member (degrades to `Opaque`), closing the injection surface.

**Spec S04: Resolution and the grading arm (`tuggram/src/lib.rs`)** {#s04-grading-arm}

```rust
enum Resolution<'a> {
    Resolved,                                                     // PATH, builtin, or a path that stats
    Expands { head: &'a str, prefix: &'a [String], takes_args: bool },
    Opaque,                                                       // resolves; grammar unreadable
    Absent,                                                       // the only route to Band::No
    Unchecked,                                                    // the check could not run
}
```

`resolve_head(head, ctx)` keeps its `$` / `~/` / `~user` / absolute / relative branches **first and unchanged**, then for a bare word:

1. `ctx.words.resolve(head)` — a `Simple` resolution → `Expands`; `Opaque` (or unread alias/function member) → `Resolution::Opaque`; a `Builtin` member → `Resolved` ([P09]).
2. PATH: with non-empty `ctx.path_dirs`, a per-word stat sweep (`<dir>/<head>` executable-regular-file check across the dirs, ~20 syscalls) is authoritative — hit → `Resolved`, miss → `Absent` even if the cached set still lists the word (the deleted-binary case). With empty `path_dirs` (tests, no probe context): `ctx.commands.contains(head)` decides, as today.
3. `is_builtin(head)` stays as the static fallback → `Resolved`.

Grading arm (replaces the `match` in `grade_with_catalog`):

```text
Absent               → Band::No
Unchecked | Opaque   → Band::Unknown          (no catalog lookup — [P06])
Resolved             → unchanged: catalog.get(catalog_key(head)), None → Unknown
Expands { head, prefix, takes_args } →
    catalog.get(catalog_key(head)):
      None                                         → Unknown
      Some(entry) if takes_args || args.is_empty() → grade_tokens(&entry.grammar,
                                                       &[prefix, segment.args()].concat(), cwd)
      Some(_)                                      → Unknown        ([P04] case 3)
```

A `Maybe` from an `Expands` arm contributes `entry.synopsis` exactly as `Resolved` does. Expected outcomes with the reference table: `gs` → yes; `gs -sb` → yes; `amend` → yes; `amend last commit please` → unknown; `add …` / `pull …` / `push …` → unknown.

**Spec S05: `ShellContext` and the public signature** {#s05-shell-context}

```rust
pub struct ShellContext<'a> {
    pub commands: CommandSet<'a>,     // membership: the cached PATH set (negative fast path / test seam)
    pub words: &'a ShellWords,        // membership + grammar source: the session's shell
    pub path_dirs: &'a [PathBuf],     // per-word probe surface; empty = no probing
    pub cwd: Option<&'a Path>,        // relative-path resolution (unchanged semantics)
}
pub fn grade(line: &str, ctx: &ShellContext) -> Graded
pub fn grade_with_catalog(line: &str, ctx: &ShellContext, catalog: &Catalog) -> Graded
```

Every existing call site and test migrates (the old three-argument shape maps to `ShellContext { commands, words: &ShellWords::empty(), path_dirs: &[], cwd }`). `src/bin/grade.rs` builds the real thing: `dump_shell_words(cwd)` at startup, `fetch_function_body` + `insert_parsed` for each stdin line's segment heads that `needs_body`, `path_dirs` parsed from `probe_login_path()` — so the harness reads the same reality the app does.

**Spec S06: tugcast wiring** {#s06-tugcast-wiring}

*PATH cache* (replaces `static PATH_COMMANDS: OnceLock` in `feeds/shell.rs`):

```rust
struct PathCache {
    path: String,                       // probe_login_path(), resolved once
    dirs: Vec<(PathBuf, Option<SystemTime>)>,   // dir → last seen mtime
    names: Arc<Vec<String>>,
    last_check: Instant,
}
```

behind a `Mutex`, with `revalidated() -> (Arc<Vec<String>>, bool /*changed*/)`: throttle 3 s; stat each dir's mtime; re-readdir only changed dirs (reuse `tuggram::command_names_in_path` per-dir logic); rebuild the sorted set when anything moved. All filesystem work on `spawn_blocking`. The dispatcher gains `path_requesters: HashSet<String>`; when `changed`, it emits `path_commands` to each ([P11]).

*Per-session word table* (new module `tugrust/crates/tugcast/src/feeds/shell_words.rs`):

```rust
pub struct SessionWords(Arc<tokio::sync::Mutex<tuggram::ShellWords>>);
impl SessionWords {
    /// Dump (spawn_blocking) from `cwd`, replace the table, return sorted member names.
    pub async fn refresh(&self, cwd: Option<&Path>) -> Vec<String>;
    /// Fetch + parse + memoize bodies for every `needs_body` head in `heads`,
    /// walking [P10] chains (each link fetched, cap 8). Fetch failure memoizes Opaque.
    pub async fn ensure_bodies(&self, heads: &[String]);
    pub async fn snapshot(&self) -> tuggram::ShellWords;   // clone for the grading task
}
```

Dispatcher holds `words: HashMap<String, SessionWords>` keyed by `tug_session_id` (created on `path_commands`, since that precedes any exec; also created lazily on `shell_grammar`/`exec` so ordering can't strand a session tableless).

*Frame changes:*

- `ShellInput::PathCommands` gains `#[serde(default)] cwd: Option<String>` — the deck's project dir, the dump's spawn directory ([S01] of the brief: rc side effects like direnv can branch on cwd). Handling: register the requester, revalidate + emit `path_commands`, then `refresh` the session's words and emit a companion frame `{type: "shell_words", tug_session_id, names: [...]}` (same `PATH_COMMANDS_SERIALIZED_CAP` truncation discipline).
- `ShellInput::ShellGrammar`: before grading, `lex` the line, collect segment heads, `ensure_bodies(heads)`, then grade with `ShellContext { commands: revalidated set, words: &snapshot, path_dirs, cwd }`. Reply frame shape unchanged. (The added fetch ≈43 ms sits inside `GRADE_REQUEST_TIMEOUT_MS` = 2000 ms and is normally paid behind the typing debounce, not at submit.)
- Refresh trigger: `shell_session_task` gets the session's `SessionWords` + a flag check — after an exchange settles whose command's first token (trimmed) is `alias`, `unalias`, `source`, or `.`, it re-runs `refresh` and emits a fresh `shell_words` frame. Exec settle also pokes the PATH revalidation ([P11]).

**Spec S07: Deck changes** {#s07-veto-corpus}

- `PathCommandsStore` (`tugdeck/src/lib/path-commands-store.ts`): holds `_pathCommands` and `_shellWords` separately; folds `type: "shell_words"` frames (`names` array) alongside `type: "path_commands"`; `getSnapshot()` returns the union, still `null` until `path_commands` lands ([#deck-names-only](#deck-names-only)). `request()` gains the project dir: constructor takes `projectDir: string` (from `binding.projectDir`, already in scope at the construction site in `card-services-store.ts`), and the sent frame carries `cwd`.
- Verify-and-pin: `ShellSessionStore`, `ShellGrammarStore`, `ShellClassifyStore` ignore `shell_words` frames (each already early-returns on `p.type !==` its own type; add a folding test that feeds a `shell_words` payload through and asserts nothing changes).
- `shell-line-classifier.ts`: add `"we", "us", "our"` to `PROSE_MARKERS` ([P12]). Update the module docblock's membership language ("the first word names a program that exists on this machine" → names something this session's shell will resolve).
- New corpus fixture (inline in `shell-line-classifier.test.ts` per that suite's convention, or a sibling module). The **load-bearing lines are the 8 measured leaks, verbatim**: `add error handling here`, `add support for nested cards`, `amend last commit please`, `pick up where we left off`, `pick whichever approach seems cleaner`, `pull request review please`, `stuff we should revisit later`, `site navigation feels sluggish`. The brief's full 24/14 corpus was not recorded, so the implementer authors the surrounding coverage: prose lines opening on the newly eligible verbs (`add`, `amend`, `pick`, `pull`, `push`, `stuff`, `site`), and command lines including flag-heavy and quoted-argument shapes (e.g. `git commit -m "fix the thing for me"`, `rg -n --hidden --glob '!target' TODO src tests`). Assert 0 false vetoes on the command lines and that the pronoun-carrying leaks now veto.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Shell word-name set (union with PATH set) | external data | existing `PathCommandsStore` + `useSyncExternalStore` consumers (read via `pathCommandsStoreRef` in `tug-prompt-entry.tsx`, unchanged) | [L02], [L22] |

No new React state, no new DOM state; every other change in this plan is Rust-side or pure-function TypeScript.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tuggram/src/words.rs` | `ShellWord`/`WordKind`/`ShellWords`, body parser, dump/fetch helpers |
| `tugrust/crates/tugcast/src/feeds/shell_words.rs` | `SessionWords`: per-session async table, refresh, ensure_bodies |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `ShellWord`, `WordKind`, `ShellWords`, `ResolvedWord` | enum/struct | `tuggram/src/words.rs` | Spec S01 |
| `parse_alias_value`, `parse_function_body` | fn | `tuggram/src/words.rs` | Spec S02 |
| `dump_shell_words`, `fetch_function_body` | fn | `tuggram/src/words.rs` | Spec S03, blocking |
| `ShellContext` | struct | `tuggram/src/lib.rs` | Spec S05 |
| `Resolution` | enum | `tuggram/src/lib.rs` | gains lifetime + `Expands`/`Opaque` |
| `resolve_head`, `grade`, `grade_with_catalog` | fn | `tuggram/src/lib.rs` | signature/arm changes, Spec S04/S05 |
| `main` | fn | `tuggram/src/bin/grade.rs` | real dump + per-line body fetch |
| `PathCache` (replaces `PATH_COMMANDS` OnceLock), `path_command_set` | struct/fn | `tugcast/src/feeds/shell.rs` | Spec S06, [P11] |
| `SessionWords` | struct | `tugcast/src/feeds/shell_words.rs` | Spec S06 |
| `ShellInput::PathCommands.cwd` | field | `tugcast/src/feeds/shell.rs` | `#[serde(default)]` |
| `emit_shell_words` | fn | `tugcast/src/feeds/shell.rs` | companion frame, cap-truncated |
| `emit_shell_grammar` | fn | `tugcast/src/feeds/shell.rs` | takes words snapshot + path_dirs |
| `shell_session_task` | fn | `tugcast/src/feeds/shell.rs` | refresh trigger + revalidation poke |
| `PathCommandsStore` | class | `tugdeck/src/lib/path-commands-store.ts` | union fold, `projectDir` ctor param |
| `PROSE_MARKERS` | const | `tugdeck/src/lib/shell-line-classifier.ts` | + `we`, `us`, `our` |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | Body parser corpus, resolution order, splice arms, probe semantics | every `tuggram` change; hermetic (injected tables, tempdirs) |
| **Integration (Rust)** | Frame round trips through `run_dispatcher`; ZDOTDIR-controlled real-shell dumps | `tugcast` wiring, interrogation |
| **Unit (TS)** | Veto corpus fixture, union folding, unknown-frame immunity | deck changes |
| **App-test** | Posture unchanged with no agent | `at0280-shared-agent-absent.test.ts` must still pass, unmodified |

The body-parser corpus (heaviest burden, [P05]): the seven real bodies from [#verified-findings](#verified-findings) with both shells' printed forms, plus `if`/`for`/`while`, `&&`/`||` chains, pipelines, command substitution (`` ` `` and `$(`), assignments (leading and lone), redirections, nested quotes, empty bodies, `$`-carrying heads, and alias values with `$`. Every non-single-simple-command case must yield `Opaque`.

Interrogation tests follow the `login_shell_sources_user_rc` pattern (set `SHELL=/bin/zsh` + `ZDOTDIR` to a tempdir whose `.zshrc` defines a known alias and function), so assertions are deterministic across machines.

#### What stays out of tests {#test-non-goals}

- The positive classify path (model verdicts) in app-tests — `TUGAPP_APP_TEST=1` gates the pool off by design (no token spend); band outcomes are pure logic covered in Rust and `shell-line-classifier.test.ts`.
- The user's real login environment — every Rust test injects its table or controls ZDOTDIR; only `src/bin/grade.rs` (the offline eval harness) reads reality, and it is not a test.
- Mock-store render tests and fake-DOM tests — banned patterns; the deck coverage is pure-function tests plus store folding through the real `_ingestForTest` seam.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Run `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p <crate>` for Rust checkpoints (warnings are errors, so a clean build is part of every checkpoint).

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Word table types + body parser | done | `e3b4d7d03` |
| #step-2 | Shell interrogation helpers | done | `00ed0b81d` |
| #step-3 | ShellContext, Resolution, grading arm | done | `a1e6b0713` |
| #step-4 | Per-word PATH probe | done | `209d16e12` |
| #step-5 | tugcast PATH cache revalidation | done | `7165b2241` |
| #step-6 | tugcast per-session word table + frames | done | `a4c8cf864` (folded with #step-7) |
| #step-7 | tugcast grading wiring + refresh triggers | done | `a4c8cf864` |
| #step-8 | Deck union store + request cwd | done | `4fe1f6e6e` |
| #step-9 | Veto recalibration + corpus fixture | done | `70952a186` |
| #step-10 | Integration checkpoint | done | verification only |

#### Step 1: Word table types + body parser {#step-1}

**Commit:** `tuggram(words): add the shell word table and the conservative body parser`

**References:** [P04] argument absorption, [P05] opaque default, [P07] resolution order, [P09] kind tags, [P10] transitive resolution, Spec S01, Spec S02, Risk R01, (#body-print-normalization)

**Artifacts:**
- `tugrust/crates/tuggram/src/words.rs` with `ShellWord`, `WordKind`, `ShellWords` (incl. `resolve` per [P10]), `parse_alias_value`, `parse_function_body`; `pub mod words;` + re-exports in `lib.rs`.

**Tasks:**
- [ ] Implement Spec S01 types; alias-over-function precedence on insert.
- [ ] Implement Spec S02 parsing in its stated order — normalization ([#body-print-normalization](#body-print-normalization)), pre-scan, `lex`, **then** parameter extraction on the lexed token stream, then the `$`-rejection rule; alias variant with `takes_args: true` always.
- [ ] Implement transitive `resolve` (depth 8, cycle → `Opaque`, unparsed link → `Opaque`, prefix concatenation inner-first, `takes_args` from the outermost entry).

**Tests:**
- [ ] Corpus per [#test-plan-concepts](#test-plan-concepts): the 7 real bodies (both shells' printed forms), every Opaque construct class, empty body, `$`-head, alias values with/without `$`.
- [ ] A parameter inside a quoted span (`echo "a $* b"`) parses `Opaque`, never `Simple` — the pin for Spec S02's parse order.
- [ ] `resolve` chain, cycle, depth-cap, and unparsed-link cases; alias-shadows-function precedence.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tuggram`

---

#### Step 2: Shell interrogation helpers {#step-2}

**Depends on:** #step-1

**Commit:** `tuggram(words): interrogate the shell for its word table and bodies`

**References:** [P02] ask the shell, [P09] builtins from the dump, [P13] placement, Spec S03, Risk R02, (#verified-findings)

**Artifacts:**
- `dump_shell_words(cwd)` and `fetch_function_body(name)` in `words.rs`, blocking, timeout-bounded, stdout-only.

**Tasks:**
- [ ] Implement the zsh and bash dump scripts and NUL/tab record parsing per Spec S03; filter `_`-prefixed functions; parse alias values inline; insert functions/builtins as unread members.
- [ ] Implement `fetch_function_body` with the name-alphabet validation; reuse the thread + `recv_timeout` pattern from `run_path_probe`.
- [ ] Return `None` for non-bash/zsh `$SHELL`.

**Tests:**
- [ ] ZDOTDIR-controlled zsh dump: a tempdir `.zshrc` defining `alias tugalias='git status'` and `tugfn () { git status $* }`; assert the alias parses `Simple` at dump time, the function is a `needs_body` member, builtins include `setopt`, and `_`-names are absent.
- [ ] `fetch_function_body("tugfn")` under the same ZDOTDIR round-trips through `parse_function_body` to `Simple { head: "git", prefix: ["status"], takes_args: true }`.
- [ ] A bogus `$SHELL` yields `None`; an invalid name is refused before spawning.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tuggram`

---

#### Step 3: ShellContext, Resolution, grading arm {#step-3}

**Depends on:** #step-1

**Commit:** `tuggram: grade the typed line through the shell word table`

**References:** [P03] grade the typed line, [P04] absorption, [P06] opaque skips catalog, [P07] order, [Q03] accepted, Spec S04, Spec S05, (#end-to-end-flow)

**Artifacts:**
- `ShellContext`, the five-variant `Resolution<'a>`, the new `resolve_head` and grading arm; `grade`/`grade_with_catalog` signatures; all existing tests migrated; `src/bin/grade.rs` rebuilt on the new signature with real dump + per-line `ensure`-style body fetching.

**Tasks:**
- [ ] Implement Spec S04/S05 exactly, leaving the path-shaped branches of `resolve_head` untouched (PATH-probe integration is #step-4; this step keeps `commands.contains(head)` for bare words after the word table).
- [ ] Splice = `[prefix, segment.args()].concat()`; synopsis contribution on an `Expands` Maybe mirrors `Resolved`.
- [ ] Migrate every test/call site via `ShellWords::empty()` contexts; update `grade.rs` per Spec S05's last paragraph.

**Tests:**
- [ ] With an injected table `gs → Simple{git, [status], true}`, `amend → Simple{git, [commit, --amend], false}`, `add → Opaque`: `gs`→yes, `gs -sb`→yes, `amend`→yes, `amend last commit please`→unknown, `add error handling`→unknown.
- [ ] Shadowing: `ls → Simple{…}` in the table wins over `/bin/ls`-style `commands` membership ([P07]).
- [ ] `git → Opaque` in the table never reaches the catalog ([P06]).
- [ ] A body-derived prefix containing `$*` cannot occur (type-level: parser strips it) — pinned instead by: an `Expands` grade never sees a literal `$*` token for the reference table.
- [ ] An `Expands` head absent from the catalog → unknown; an `Expands` Maybe carries the synopsis.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tuggram`

---

#### Step 4: Per-word PATH probe {#step-4}

**Depends on:** #step-3

**Commit:** `tuggram: probe the PATH directories for the word being graded`

**References:** [P08] safe staleness, Spec S04 (bare-word rules), Spec S05 (`path_dirs`), (#verified-findings)

**Artifacts:**
- The bare-word probe in `resolve_head`: with non-empty `ctx.path_dirs`, a stat sweep decides `Resolved`/`Absent` for PATH membership, overriding the cached set in both directions.

**Tasks:**
- [ ] Probe = executable-regular-file stat of `<dir>/<head>` per dir (reuse the `stat_resolution` predicate); word-table and builtin branches still run first.
- [ ] Empty `path_dirs` preserves today's `commands.contains` behavior byte-for-byte (the test seam).

**Tests:**
- [ ] Tempdir as the sole path dir: a word present only on disk (not in `commands`) grades past `Absent` (the brew-install case); a word in `commands` but absent on disk grades `No` (the deleted-binary case); empty `path_dirs` falls back to the set.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tuggram`

---

#### Step 5: tugcast PATH cache revalidation {#step-5}

**Depends on:** #step-4

**Commit:** `tugcast(shell): revalidate the PATH set by directory mtime and push changes`

**References:** [P11] revalidation push, Spec S06 (PathCache), (#end-to-end-flow)

**Artifacts:**
- `PathCache` replacing the `PATH_COMMANDS` `OnceLock` in `feeds/shell.rs`; `path_requesters: HashSet<String>` in `run_dispatcher`; re-emission on change; `path_dirs` exposed for grading.

**Tasks:**
- [ ] Implement Spec S06's `PathCache` (3 s throttle, mtime-gated per-dir re-readdir, `spawn_blocking`); `path_command_set()` becomes `revalidated()`.
- [ ] Register requesters on `PathCommands`; on any trigger that reports `changed`, emit `path_commands` to each registered session.
- [ ] Triggers: `PathCommands`, `ShellGrammar`, and exec settle (the session task pokes a shared handle; throttling makes the poke cheap).

**Tests:**
- [ ] With a temp dir injected into the cache: add an executable, advance past the throttle, trigger → the emitted set contains it; remove it → the set drops it; two sessions registered both receive the re-emission.
- [ ] The existing `path_commands_round_trip_over_the_feed` and `path_commands_cache_hit_serves_identical_sets` tests still pass (identical sets when nothing changed).

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast`

---

#### Step 6: tugcast per-session word table + frames {#step-6}

**Depends on:** #step-2, #step-5

**Commit:** `tugcast(shell): per-session shell word table with a shell_words reply`

**References:** [P01] shell authority, [P13] placement, Spec S03, Spec S06, Risk R02, (#deck-names-only)

**Artifacts:**
- `feeds/shell_words.rs` (`SessionWords`); `ShellInput::PathCommands.cwd`; `emit_shell_words`; dispatcher `words` map; dump-on-mount.

**Tasks:**
- [ ] Implement `SessionWords` per Spec S06 (`refresh` via `spawn_blocking(dump_shell_words)`, `ensure_bodies` walking [P10] chains with fetch-failure → memoized `Opaque`, `snapshot`).
- [ ] `PathCommands` handling: register requester → revalidate/emit `path_commands` → `refresh(cwd)` → `emit_shell_words` (names only, `PATH_COMMANDS_SERIALIZED_CAP` truncation discipline).
- [ ] Create the session's `SessionWords` lazily from `ShellGrammar`/`Exec` too, so ordering can't strand a session tableless.

**Tests:**
- [ ] Round trip: a `path_commands` frame with `cwd` yields both a `path_commands` and a `shell_words` reply for that session; under a ZDOTDIR tempdir rc, `names` includes the rc alias/function and `setopt`, excludes `_`-names.
- [ ] A dump failure (bogus `$SHELL`) still answers `path_commands` and emits an empty/absent `shell_words` without wedging the dispatcher.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast`

---

#### Step 7: tugcast grading wiring + refresh triggers {#step-7}

**Depends on:** #step-6

**Commit:** `tugcast(shell): grade through the word table and refresh it on rc-touching execs`

**References:** [P03], [P04], [P11], Spec S04, Spec S06, (#end-to-end-flow)

**Artifacts:**
- `emit_shell_grammar` grading with `ShellContext` (words snapshot + `path_dirs` + cwd); body fetch-on-demand for segment heads; the `alias`/`unalias`/`source`/`.` refresh trigger in `shell_session_task`.

**Tasks:**
- [ ] In the `ShellGrammar` arm: lex heads, `ensure_bodies`, `snapshot`, grade with the full context.
- [ ] In `shell_session_task`: after settle, if the command's first trimmed token ∈ {`alias`, `unalias`, `source`, `.`}, `refresh` + `emit_shell_words`; every settle pokes PATH revalidation ([P11]).

**Tests:**
- [ ] Under a ZDOTDIR rc defining `tugfn () { git status $* }`: `shell_grammar` for `tugfn` answers `yes` (dump + fetch + splice, end to end through the dispatcher).
- [ ] An exec of `alias tugnew='git log'` followed by settle produces a fresh `shell_words` frame containing `tugnew`, and a subsequent `shell_grammar` for `tugnew` answers `yes`.
- [ ] Existing `shell_grammar_round_trips_every_band_over_the_feed` and cwd tests still pass unchanged.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run -p tugcast`

---

#### Step 8: Deck union store + request cwd {#step-8}

**Depends on:** #step-6

**Commit:** `tugdeck: fold shell word names into the shell-candidate set`

**References:** [P01], Spec S07, (#deck-names-only, #state-zone-mapping)

**Artifacts:**
- `PathCommandsStore` union fold + `projectDir` ctor param + `cwd` on the request; `card-services-store.ts` passes `binding.projectDir`; docblock updates in `path-commands-store.ts` and `shell-line-classifier.ts`; unknown-frame immunity pins.

**Tasks:**
- [ ] Implement Spec S07's store changes; `getSnapshot()` stays referentially stable per fold ([L02] — rebuild the union set only when a frame folds).
- [ ] Add the `shell_words`-immunity folding tests for `ShellSessionStore`, `ShellGrammarStore`, `ShellClassifyStore`.
- [ ] Update the two docblocks' membership language.

**Tests:**
- [ ] Union folding via `_ingestForTest`: words-first-then-commands (null until commands land, then union), commands-then-words (set grows), malformed `names` ignored.
- [ ] A `shell_words` payload folded into the three other stores changes nothing.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bun test src/lib`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bunx tsc --noEmit`

---

#### Step 9: Veto recalibration + corpus fixture {#step-9}

**Depends on:** #step-8

**Commit:** `tugdeck: complete the veto's pronoun set against the imperative-verb population`

**References:** [P12] veto minimal, [Q02] decided, Spec S07, (#verified-findings)

**Artifacts:**
- `we`/`us`/`our` in `PROSE_MARKERS`; the veto corpus fixture in `shell-line-classifier.test.ts` per Spec S07.

**Tasks:**
- [ ] Add the pronouns; leave `COMMAND_TOKEN_CEILING` and its `>` boundary unchanged, updating the `vetoesShellVerdict` doc to note the population it now faces.
- [ ] Author and commit the corpus per Spec S07: the 8 measured leak lines verbatim (the load-bearing assertions), plus implementer-authored prose lines opening on the newly eligible verbs and command lines including flag-heavy and quoted-argument shapes. Assert the pronoun-carrying leaks veto and no command line does.

**Tests:**
- [ ] The corpus assertions above; the existing veto tests unchanged.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bun test src/lib/shell-line-classifier.test.ts`

---

#### Step 10: Integration checkpoint {#step-10}

**Depends on:** #step-3, #step-4, #step-5, #step-7, #step-8, #step-9

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), Spec S04–S07

**Tasks:**
- [ ] Verify the whole workspace and both frontends together; confirm the app-test posture is unchanged with no agent.

**Tests:**
- [ ] `at0280-shared-agent-absent.test.ts` passes unmodified.

**Checkpoint:**
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo nextest run`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool/tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `cd /Users/kocienda/Mounts/u/src/tugtool && just app-test-changed` (run bare — never piped)
- [ ] Live spot-check via the eval seam: `cd /Users/kocienda/Mounts/u/src/tugtool/tugrust && cargo build -p tuggram --bin grade && printf 'gs\ngs -sb\namend\namend last commit please\n' | ./target/debug/grade --cwd /Users/kocienda/Mounts/u/src/tugtool` — expect yes / yes / yes / unknown on the reference machine.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Shell arbitration whose membership authority is the session's shell, whose grammar reach extends through alias/simple-function expansions to grade the typed line, whose PATH set stays fresh without a watcher, and whose veto knows the pronoun set — with every degraded path still resolving to Claude.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All [Success Criteria](#success-criteria) hold (each names its verification).
- [ ] `cargo nextest run` (workspace), `bun test`, `bunx tsc --noEmit`, `bunx vite build` all green.
- [ ] `just app-test-changed` green, including `at0280-shared-agent-absent.test.ts` unmodified.

**Acceptance tests:**
- [ ] The Step 10 `grade`-binary spot-check answers yes / yes / yes / unknown.
- [ ] The Step 7 end-to-end dispatcher tests (dump → fetch → splice → `yes`) pass.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] [Q01] `gs → git status` expansion display in the routed row's attribution.
- [ ] zsh global/suffix alias support, if ever warranted (documented limitation).
- [ ] Further veto-hint widening, now measurable against the committed corpus fixture.

| Checkpoint | Verification |
|------------|--------------|
| Rust green | `cd tugrust && cargo nextest run` |
| Deck green | `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build` |
| App posture | `just app-test-changed` (bare) |
| Reality check | `printf 'gs\n…' \| ./target/debug/grade --cwd <repo>` |

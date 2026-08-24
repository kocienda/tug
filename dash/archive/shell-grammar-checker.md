<!-- devise-skeleton v4 -->

## Shell Grammar Checker {#shell-grammar-checker}

**Purpose:** Put a deterministic Rust grammar grader in front of the local model's shell-vs-prompt judgement: it grades every candidate line **Yes | Maybe | No | Unknown** against a baked catalog of command grammars plus the live login PATH, spends zero inference on lines that cannot be commands, and hands the model the program's own documentation on the lines where grammar alone cannot tell.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | kocienda |
| Status | draft |
| Target branch | main (via a dash worktree) |
| Last updated | 2026-07-30 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Shell routing today is: the deck checks that a line's first word names a real program (`isShellCandidate` in `tugdeck/src/lib/shell-line-classifier.ts`, fed by `PathCommandsStore` which asks tugcast for the login-PATH executable set), the local model answers SHELL or PROMPT over `LocalModelPrompts.classify`, and a PROMPT-only shape veto (`vetoesShellVerdict`) can refuse to honor a SHELL verdict. That stack reached zero *executed* false SHELL on the 71-case corpus, but only because the veto cleans up after the model — the packs' own false SHELL counts range from 1 (qwen) to 17 (lfm25), and the model is asked about every candidate line, spending inference and latency on questions a grammar could answer.

The insight this plan builds on: nearly every command has a grammar we can know (or harvest from its own `--help`/man page), and a small deterministic checker can vet the typed line against what the program *can be shown to accept*. The vexing cases — English-word commands with free-form arguments (`make the watch loop resilient` is a syntactically valid `make` invocation) — are vexing precisely because they pass the grammar, and they stay with the model. But the checker changes what the model is asked and armed with: a **No** never reaches the model, a **Maybe** reaches it *with the program's own condensed documentation in the prompt*, and grading becomes testable in `cargo nextest` with no inference at all. This also lowers the stakes of pack choice on the routing job: the model only ever sees the pre-filtered residual.

#### Strategy {#strategy}

- Build the grader as a new library crate (`tuggram`) that is pure over its inputs: a line, a command set, a builtin list, and a baked catalog. All judgement mechanics live where `cargo nextest` can pin them.
- Bake the catalog in: a batch harvester (a bin in the same crate) sweeps the login PATH once, distills each command's man page (and, behind an explicit flag, its `--help`) into a compact grammar + synopsis, and writes a committed JSON data file the crate embeds. Size is not a constraint — thousands of entries are fine; the data is tiny.
- Serve grading from tugcast over the shell feed, exactly like `path_commands` already works: a `shell_grammar` request verb, a reply frame with band + synopsis. The grader shares the same login-PATH resolution the deck's command set already comes from, so the two views can never disagree.
- Wire the four bands into the deck's submit path: No skips the model; Yes asks the model as today; Maybe asks the model with the synopsis riding the classify request; Unknown is byte-for-byte today's path. Every degraded path (no grade in time, no transport, malformed reply) resolves to Unknown, which resolves to today's path, which resolves to Claude on any failure — the asymmetry doctrine is preserved by construction.
- The veto stays. The model stays the decider for every line it sees. The grader can only *withhold* the model (No) or *arm* it (Maybe); it never routes to the shell by its own authority.
- Rework the eval harness to score the composed pipeline (grade → model → veto), band by band, and extend the corpus with cases the grader alone decides.

#### Success Criteria (Measurable) {#success-criteria}

- Composed pipeline on the routing corpus: **zero executed false SHELL** (`just model-classify` exit code, which already applies the veto; after this plan it also applies the grade) — measured with the shipping pack.
- Shell recall does not collapse: corpus lines labeled `shell` that route to the shell ≥ the pre-grader post-veto baseline for the same pack (qwen baseline: 30/35 shell, 35/36 prompt).
- The No band spends zero inference: `classify.py` reports how many corpus cases were decided without a model call, and every No-band case labeled `prompt` scores correct with no inference spent. The report must separate cases `isShellCandidate` would have filtered anyway from the two populations the grader genuinely adds (#no-band-real-scope), or the number overstates what production gains.
- The two new No populations are closed: an unresolving pipeline-tail segment (`git status | frobnicate`) and a non-existent path-shaped opener (`./nonexistent.sh`, session cwd known) both route to Claude with no model call — verified live in Step 9, since neither is reachable through the corpus's single-command cases.
- No corpus line labeled `shell` grades **No**, measured two ways: hermetically against the injected command set in `cargo nextest` (Step 7), and against this machine's real login PATH in the Step 8 harness run. The first is the regression gate; the second is the reality check.
- Grading is fast: the `grade()` call itself completes in well under a millisecond on corpus-length lines (asserted informally; no benchmark harness — the function is table lookups and one lex pass).
- The Maybe prompt is bounded: every baked synopsis ≤ `SYNOPSIS_CHAR_CAP` (Spec S03), asserted by a catalog integrity test, so classify prefill stays within the latency budget the 2s submit wait allows.
- The submit-time cost of grading is bounded: `GRADE_SUBMIT_WAIT_MS = 150` ([P06]), and it is normally zero because the debounce prefetches — verified in Step 9 against the live app.
- All grading behavior is pinned by `cargo nextest run -p tuggram` with no app, no model, and no network — provable by running the built test binary under `env -i` with an empty PATH and HOME (see #step-7 for why the check cannot go through `cargo` itself).

#### Scope {#scope}

1. New crate `tugrust/crates/tuggram`: lexer, band grader, catalog schema + embedded data, harvester bin, grade bin (for the eval harness).
2. tugcast: `shell_grammar` verb on the shell feed (`tugrust/crates/tugcast/src/feeds/shell.rs`), sharing the crate's PATH resolution.
3. Deck: `ShellGrammarStore`, band handling in `tug-prompt-entry.tsx`'s debounce + submit path, `grammar` field on the classify bridge request.
4. Swift: `MainWindow.swift` classify decode gains optional `grammar`; `LocalModelService.swift` composes the grammar-bearing classify prompt.
5. tugcast `local_model.rs`: the `local_model_classify` tell gains an optional `grammar` param so the harness can drive the Maybe band.
6. Eval: `tests/model-eval/classify.py` scores the composed pipeline band by band; corpus gains band labels and No-band cases.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Runtime version matching. The catalog records the version each grammar was harvested from, but the grader does not probe installed versions (probing runs binaries; see [P04]). Version drift is absorbed by the Yes→Maybe degradation rule ([P02]), which is what makes version matching non-load-bearing.
- The rescue-or-rule-LFM2.5 experiment (run and settled in `dash/local-model-flow.md`, which absorbed the brief this line used to cite). This plan is pack-agnostic; it changes what any selected pack is asked. The two compose but neither depends on the other's outcome.
- Any change to the PULSE/summarize half of the local model's work. `ground_headline`, the summarize prompt, and `run.py` are untouched.
- Removing or weakening `vetoesShellVerdict`. The veto remains the last gate on every SHELL verdict.
- Letting a Yes grade execute without the model. Considered and rejected ([Q02]).
- A tugutil user-facing verb for the grader. The harvest and grade bins are dev tools inside the crate; promoting them is a follow-on.

#### Dependencies / Prerequisites {#dependencies}

- **SATISFIED** — the `model-trust` dash landed on main as `25ab4714d` (2026-07-30). This plan builds directly on what it carried: `vetoesShellVerdict` and its single call site in `performSubmit`, the exact-token `verdict(from:labels:)` parse, `tests/model-eval/veto-filter.ts`, and the classify harness's veto-aware scoring. All present on main; verify with `grep -c vetoesShellVerdict tugdeck/src/lib/shell-line-classifier.ts` (expect 2) before starting.
- A dash worktree for this plan (created by `/tugplug:implement`, named by the user's gesture — never on the implementer's initiative on main).

#### Constraints {#constraints}

- Warnings are errors (`-D warnings` via `tugrust/.cargo/config.toml`).
- `classifyMaxTokens = 8` and the 2s classify deadline are load-bearing and unchanged; the Maybe band adds *input* tokens only, and bounded ones (Spec S03).
- Deck work obeys the tuglaws; new state is mapped in [#state-zone-mapping]. `bunx vite build` before declaring tugdeck changes done.
- No fake-DOM/RTL tests, no mock-store assertion tests. Real-app behavior in `tests/app-test/` with `@covers` lines; grading logic in `cargo nextest`; deck logic in pure `bun:test`.
- The harvester must never execute a binary by default ([P04]). `--help`/`--version` probing is opt-in, allowlisted, timed out, and runs with a stripped environment.
- App-test selection stays within the 20-file budget; the integration step names its files explicitly.

#### Assumptions {#assumptions}

- The classify prompt freeze rule (documented at the top of `LocalModelService.swift`) protects bake-off comparability, not immutability; adding a *second, additive* prompt constant for the grammar-bearing variant is legal under it, provided the base `classify` string is untouched and the plan states the comparability consequences ([P05]).
- macOS ships `/usr/bin/cd` and friends, but builtins must still be carried as an explicit list ([S02]) because zsh builtins like `export`, `source`, `alias` have no PATH presence.
- The corpus's construction bias is real and acknowledged: every existing corpus case was recovered from lines that *reached* the model, so every existing opener resolves on PATH. The No band's production value shows on lines the corpus excludes by construction; Step 7 adds No-band cases so the harness exercises the band at all.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses the devise-skeleton v4 anchor and label conventions: explicit `{#anchor}` on every cited heading, `[P##]`/`[Q##]`/`S##`/`T##`/`R##` stable labels, `**Depends on:**` lines with `#step-N` anchors, and `**References:**` lines citing labels and anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Where does the grader answer from — tugcast or the Swift host? (DECIDED) {#q01-grader-placement}

**Question:** The deck talks to two backends: tugcast over the WebSocket feeds, and the Swift host over `WKScriptMessageHandler`. Which one grades?

**Why it matters:** The grader needs filesystem access (PATH sweep, stat on `./script` openers) that the deck lacks, and it must share the exact PATH view the deck's command set already comes from.

**Resolution:** DECIDED (see [P01]). tugcast. The login-PATH set the deck already consults is computed *in tugcast* (`compute_path_commands` in `feeds/shell.rs`) and served over the `path_commands` verb — grading in the same process from the same cached set means the deck's precondition and the grader's resolution can never disagree, and the request/reply pattern to copy already exists on the same feed.

#### [Q02] Does a Yes grade ever skip the model? (DECIDED) {#q02-yes-still-asks}

**Question:** If the line validates completely against a known grammar (`git status`, `cargo build -p tugcast`), may the deck route to the shell without asking the model?

**Why it matters:** Skipping the model on Yes would erase classify latency on the most common commands — but it would also route to the shell on the grader's sole authority.

**Resolution:** DECIDED — no. `make the watch loop resilient` grades Yes (`make` accepts arbitrary targets); grammar validity is not intent. The module docstring in `shell-line-classifier.ts` records why shape-rules that decide *toward* shell were removed; a Yes-executes rule would be the same instrument with better evidence, and the evidence is not good enough on exactly the English-word openers where it matters. The shell is reached only by an explicit model verdict that survives the veto — unchanged. Revisit only with live data showing the Yes band's model agreement is at ceiling ([#roadmap]).

#### [Q03] How do Maybe synopses reach the model in production and in the harness? (DECIDED) {#q03-synopsis-plumbing}

**Question:** The production classify call is deck → `WKScriptMessageHandler "localModel"` → `LocalModelService`; the harness call is `tugutil host tell local_model_classify` → tugcast `local_model.rs` → requester → app. Where does the synopsis ride?

**Resolution:** DECIDED (see [P05], Spec S04). An optional `grammar` string on both envelopes, end to end: the deck's bridge request body, `MainWindow.swift`'s classify decode, the `LocalModelService` request kind, and the tell's `-p grammar=` param. Absent means the base classify prompt; present means the grammar-bearing variant. One field, same name, both routes.

#### [Q04] Does the grader replace `isShellCandidate`? (DECIDED) {#q04-candidate-check-stays}

**Question:** The grader's No band subsumes the deck's first-word PATH check. Keep both?

**Resolution:** DECIDED — keep both, layered. `isShellCandidate` is a synchronous, zero-round-trip prefilter over a set the deck already holds; it answers most prose (`fix the bug in auth.ts`) without any request at all. The grader refines *within* candidates, adding what the deck cannot do: lex the whole line, stat path-shaped openers (`./build.sh` — the deck currently takes any `./x` on faith), resolve every segment head of a pipeline, and discriminate Yes/Maybe/Unknown. A line that fails `isShellCandidate` is never graded; a line that passes is.

#### [Q05] Per-version grammar matching at runtime (DEFERRED) {#q05-version-matching}

**Question:** The catalog schema records the harvested version per entry. Should the grader select among versions at runtime by probing `cmd --version`?

**Why it matters:** A flag added in a newer installed version than the harvested one would grade Maybe instead of Yes.

**Resolution:** DEFERRED. Runtime probing executes binaries on the routing hot path, and the cost of version drift is one band of degradation (Yes→Maybe still asks the model, now with documentation — strictly more careful, never wrong-direction). The schema keeps the version slot so a future harvest can carry multiple versions; matching is revisited only if live Maybe rates show drift is common ([#roadmap]).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Catalog staleness misgrades a valid flag | low | med | R01: mismatch degrades Yes→Maybe, never →No | Maybe rate high on live `model-stats` |
| Synopsis prefill slows Maybe classify past the submit wait | med | low | R02: `SYNOPSIS_CHAR_CAP`, measured in the integration step | classify slow-log lines rise |
| Harvester probing executes something harmful | high | low | R03: no execution by default; opt-in, allowlist, timeout, stripped env | never — policy is permanent |
| Grader lexer disagrees with real shell parsing | med | med | R04: unlexable → Unknown, never No; corpus tests | a real shell line graded No in the wild |
| tug-prompt-entry churn re-fails the focus app-test cluster | med | med | R05: band logic isolated in the pure classifier module; explicit small app-test selection | at0201/at0216 failures in the integration step |

**Risk R01: Catalog staleness** {#r01-catalog-staleness}

- **Risk:** The user's installed command accepts flags the baked grammar doesn't know (version drift, wrapper scripts, aliases materialized as functions).
- **Mitigation:** The band rules make staleness self-limiting: an unknown flag or subcommand on a known command degrades to Maybe (model decides, with documentation), and No is reserved for evidence of absence — an opener that resolves to nothing. Table mismatch can never confidently swallow a real command.
- **Residual risk:** A stale synopsis could mislead the model on a Maybe. The synopsis states its harvested version, so the model sees dated evidence as dated.

**Risk R02: Maybe-band latency** {#r02-maybe-latency}

- **Risk:** Prefill on a synopsis-bearing prompt pushes classify past `CLASSIFY_TIMEOUT` (2s) on slower packs.
- **Mitigation:** `SYNOPSIS_CHAR_CAP` bounds the addition (Spec S03); the integration step measures Maybe-band classify latency against the shipping pack and the cap is tuned down if the p95 approaches the deadline.
- **Residual risk:** A cold model plus a synopsis is slower than a cold model alone; the existing `not_resident` fast-fail already covers the cold case by refusing rather than stalling.

**Risk R03: Harvest safety** {#r03-harvest-safety}

- **Risk:** Running `--help`/`--version` on an arbitrary PATH binary executes arbitrary code (a user's own script may do anything on any invocation).
- **Mitigation:** The default harvest reads man pages only, which executes nothing but `man`. Probing is opt-in (`--probe-help`), restricted to an allowlist of directories (`/bin`, `/usr/bin`, `/opt/homebrew/bin` by default, extendable by flag), wrapped in a kill-timeout, and run with a stripped environment and closed stdin.
- **Residual risk:** Even allowlisted binaries could misbehave on `--help`; the timeout and the batch (non-runtime) context bound the blast radius.

**Risk R04: Lexer divergence** {#r04-lexer-divergence}

- **Risk:** The crate's tokenizer is not a shell; a construct it can't lex (process substitution, heredocs, unbalanced quotes mid-thought) must not be read as evidence of prose.
- **Mitigation:** Anything the lexer cannot confidently segment grades Unknown — today's path, model + veto. No is only reachable through a *successful* lex whose segment head resolves to nothing.
- **Residual risk:** Unknown-band lines get no grammar assistance; that is the status quo, not a regression.

**Risk R05: Prompt-entry churn** {#r05-prompt-entry-churn}

- **Risk:** `tug-prompt-entry.tsx` is covered by a large app-test cluster (focus, submit, history); edits there have previously destabilized it.
- **Mitigation:** All band logic lands in `shell-line-classifier.ts` (pure) and the new store; the prompt-entry diff is confined to the existing shell-routing block in `performSubmit` and the existing debounce. The integration step runs a named selection of the affected tests, within budget.
- **Residual risk:** The submit path gains one awaited race (the grade), bounded by the same pattern as the verdict wait.

---

### Design Decisions {#design-decisions}

#### [P01] The grader lives in a new library crate and answers from tugcast (DECIDED) {#p01-grader-in-tugcast}

**Decision:** Grading logic, catalog, and harvester live in a new crate `tugrust/crates/tuggram`; tugcast consumes the crate and serves grading over the shell feed's existing request/reply pattern.

**Rationale:**
- The grader needs the filesystem (PATH sweep, stat) — native side, per the user's directive; tugcast already computes and caches the exact login-PATH set the deck's precondition consults, so grading beside it removes any possibility of two PATH views drifting.
- A crate (not a tugcast module) because three consumers need it: the tugcast verb, the harness's `grade` bin, and pure `cargo nextest` corpus tests — and because the harvester is a bin target that doesn't belong inside tugcast.
- The `path_commands` verb on `SHELL_INPUT`/`SHELL_OUTPUT` (`feeds/shell.rs`) is the placement precedent: session-scoped request frame in, typed reply frame out, no new feed.

**Implications:**
- `feeds/shell.rs`'s `probe_login_path` / `command_names_in_path` move into `tuggram` and are re-exported or re-used by tugcast, so the command-set computation is stated once.
- The deck gains one round trip per graded line, debounce-amortized like the classify request already is.

#### [P02] Band semantics: No is evidence of absence; mismatch degrades toward Maybe (DECIDED) {#p02-band-semantics}

**Decision:** The four bands are defined by evidence strength, per Spec S01: **No** requires the lex to succeed and a segment head to resolve to nothing (not on PATH, not a builtin, not an existing path-shaped file); **Yes** requires a known command whose every token fits its baked grammar; **Maybe** is a known command with tokens the grammar can't confirm; **Unknown** is a resolving command with no baked grammar, or a line the lexer can't confidently segment.

**Rationale:**
- The wrong-way costs are asymmetric (the classifier module's founding doctrine): a No that's wrong silently swallows a real command, so No must never rest on failed *validation* — only on failed *resolution*. Version drift, wrappers, and catalog gaps all land in Maybe/Unknown, where the model still decides.
- This is what keeps the grader on the right side of the removed-heuristics history: it never decides toward shell, and its only unilateral decision (No → Claude) falls in the direction doubt is supposed to fall.

**Implications:**
- The grader can be aggressive about catalog coverage without safety review per entry — a wrong grammar costs one band, not an execution.
- Corpus tests can assert band floors: no `shell`-labeled line grades No on the machine that harvested the catalog.

#### [P03] The catalog is baked, harvested in batch, committed to the repo (DECIDED) {#p03-baked-catalog}

**Decision:** Command grammars live in a committed data file (`tugrust/crates/tuggram/data/commands.json`), embedded via `include_str!` and parsed once into a `OnceLock`. A harvester bin regenerates it; nothing is harvested or probed at runtime.

**Rationale:**
- Size is a non-issue — thousands of entries of flags + synopsis is small data — and baking removes every runtime failure mode: no probing, no caching policy, no first-use latency.
- A committed file makes catalog changes reviewable diffs and keeps `cargo nextest` hermetic.

**Implications:**
- The catalog reflects the harvest machine. Commands present on a user's machine but absent from the catalog grade Unknown, which is today's behavior — the catalog only ever adds discrimination.
- Deterministic output ordering in the harvester, so regeneration produces minimal diffs.

#### [P04] The harvester executes nothing by default (DECIDED) {#p04-harvest-no-exec}

**Decision:** The default harvest derives grammars from man pages (`man -w` + render + SYNOPSIS/OPTIONS distillation). Probing a binary (`--help`, `--version`) is behind `--probe-help`, restricted to an allowlist of system/package directories, kill-timed, stripped-env, stdin-closed.

**Rationale:**
- `--help` is an execution; on an arbitrary user script it is *any* execution. A batch tool that runs everything on PATH is a footgun regardless of intent.
- Man pages cover the classic Unix surface (which is where the English-word-opener problem lives: `make`, `find`, `open`, `sort`, `head`, `touch`, `write`, `say`, …) without executing anything.

**Implications:**
- Modern man-less CLIs (bun, just, many Rust tools) need the probe flag or a curated seed to get grammar entries; until then they grade Unknown, which is safe.
- The harvest run that produces the committed catalog documents which sources it used, per entry (`"source": "man" | "help" | "curated"`).

#### [P05] Maybe arms the model: one optional `grammar` field, one additive prompt constant (DECIDED) {#p05-grammar-field}

**Decision:** A Maybe grade attaches the command's baked synopsis; it rides an optional `grammar: String` field on both classify routes (bridge envelope and tell param, Spec S04), and `LocalModelService` composes `LocalModelPrompts.classifyWithGrammar` — a new constant that embeds the base classify rules plus a `PROGRAM DOCUMENTATION:` section — when the field is present. The base `classify` string is byte-for-byte untouched.

**Rationale:**
- Reading a synopsis and checking a line against it is evidence-checking, not judgement — the task shape small local packs are demonstrably better at (the entire grounding-gate investigation is the record of this).
- The freeze rule in `LocalModelService.swift`'s docstring protects bake-off comparability: every pack in one bake-off scores on identical wording. An *additive* constant preserves that for the base prompt; the grammar-bearing variant starts its own comparability lineage from this plan forward, and any future pack bake-off must score both variants.

**Implications:**
- `MainWindow.swift`'s `"classify"` decode, the `LocalModelService` request kind, tugcast's `local_model_classify` action, and the harness `ask_classify` all gain the optional field.
- `classifyMaxTokens` (8, output) is unchanged; the addition is bounded input (Spec S03).

#### [P06] Band handling in the deck: only No changes who is asked; nothing changes who decides (DECIDED) {#p06-deck-band-handling}

**Decision:** In the submit path (and the typing debounce), after `isShellCandidate` passes: grade the line (cached, bounded wait). **No** → route to Claude with no model call. **Yes** → `requestClassify(text)` exactly as today. **Maybe** → `requestClassify(text, grammar)` with the synopsis. **Unknown**, a grade timeout, or any grade failure → `requestClassify(text)` exactly as today. A SHELL verdict still must survive `vetoesShellVerdict` regardless of band.

**Rationale:**
- Every path that could be wrong resolves toward Claude; the shell remains reachable only through an explicit model verdict plus the veto — the module's founding asymmetry, restated with the grader in place.
- Caching the grade beside the verdict cache keeps the submit path's added latency to one debounce-amortized round trip.

**The wait is bounded small, because it is in series ahead of the verdict wait.** `GRADE_SUBMIT_WAIT_MS = 150`. The existing typing debounce already fires the classify request; it must fire the grade request *first and concurrently*, so by the time Return is pressed the grade is normally cached and the submit-time wait is zero. The 150ms is only for the case where Return beats the debounce. It must stay far below `VERDICT_SUBMIT_WAIT_MS` (2s) because the two waits **add**: a grade wait as generous as the verdict wait would double the worst-case pause between Return and the line going somewhere, which is the one user-visible cost this whole feature is supposed to reduce. An expired grade wait resolves to Unknown, which is today's path.

**Implications:**
- The verdict cache key must incorporate whether a grammar rode along (a verdict formed with documentation is not the same answer as one formed without); simplest is to cache by exact text as today and also cache the band per text, invalidating together.
- The debounce must issue the grade request alongside the classify request, not after it — a serial debounce would put the grade's latency in front of the classify's on every keystroke.
- State zone mapping in [#state-zone-mapping].

---

### Deep Dives {#deep-dives}

#### The current flow, end to end (what this plan modifies) {#current-flow}

Production routing as it stands on main today (the `model-trust` work landed as `25ab4714d`):

1. Session bind: `PathCommandsStore.request()` (`tugdeck/src/lib/path-commands-store.ts`) sends `{type:"path_commands", tug_session_id}` on `SHELL_INPUT`; tugcast (`feeds/shell.rs`) resolves the login PATH once per process (`probe_login_path` → `command_names_in_path`, cached in a `OnceLock`, capped by `PATH_COMMANDS_SERIALIZED_CAP`) and replies with a `path_commands` frame on `SHELL_OUTPUT`.
2. Typing (debounced) and submit: `isShellCandidate(text, commands)` — env-assign prefix skipped, first token in the set or path-shaped (`./`, `~/`, absolute-with-interior-slash). Null set → false (safety net).
3. Candidate lines: `requestClassify(text)` (`tugdeck/src/lib/local-model-bridge.ts`) posts `{v, requestId, task:"classify", text, labels:["shell","prompt"]}` to the `localModel` `WKScriptMessageHandler`; `MainWindow.swift` decodes (`case "classify"`) into `LocalModelService`'s `.classify(text:labels:)`; the service runs `LocalModelPrompts.classify` with `classifyMaxTokens = 8` and parses via the exact-token `verdict(from:labels:)`. 2s deadline on both sides (`LOCAL_MODEL_TIMEOUT_MS`, `CLASSIFY_TIMEOUT`); `not_resident` fast-fail on a cold pack.
4. Submit gate (`performSubmit` in `tug-prompt-entry.tsx`): verdict from `ShellVerdictCache` or an awaited request raced against `VERDICT_SUBMIT_WAIT_MS`; `verdict === "shell" && !vetoesShellVerdict(submitText)` → `shellStore.exec(...)`; everything else → Claude.
5. Eval: `classify.py` drives `tugutil host tell local_model_classify --instance <i> -p text=...` → tugcast `local_model.rs` (`pub async fn classify`, `CLASSIFY_TIMEOUT`) → requester → app; the verdict is read back out of the tugcast log; the veto is applied by importing the real `vetoesShellVerdict` through bun (`veto-filter.ts`).

The grader inserts between 2 and 3, and its Maybe output threads through 3, 4, and 5.

#### Why the corpus can't see the No band today {#corpus-no-band-blindness}

`classify-corpus.json`'s cases were recovered from `local model classify answered` log lines — every one of them *reached* the model, which means every opener resolved on PATH at recording time. The band the grader decides alone (No) is therefore invisible to the current corpus by construction. Step 7 adds explicitly-labeled No-band cases (prose with non-resolving openers, the population `isShellCandidate` already filters in production) so the composed harness exercises all four bands, and the report separates "correct with zero inference" from "correct via the model."

#### What the No band actually buys in production (narrower than it looks) {#no-band-real-scope}

Read this before writing Step 5 or judging the harness numbers, because the harness and production see completely different No-band populations.

`isShellCandidate` runs **first** and passes a line only when the first token is in the login-PATH command set **or** is path-shaped (`./x`, `~/x`, `/a/b`). So ordinary prose — `fix the flaky reconnect test`, `explain this error` — is already refused by the deck without any round trip, and the grader never sees it. The grader cannot be what saves that inference; the deck has saved it since the feature shipped.

The No band therefore fires on exactly two populations in production, and both are genuinely new:

1. **A non-head segment that doesn't resolve.** `git status | frobnicate`, `cargo build && deploy-it`. `isShellCandidate` only ever examined the *first* token; the grader lexes the whole line and resolves every segment head. This is a real false-SHELL vector the current stack cannot see at all.
2. **A path-shaped opener that doesn't exist.** `./build.sh` when there is no `build.sh`. The deck accepts every `./x` on faith because it cannot stat; the grader stats (Spec S07) and refuses. Note the interaction with S07's cwd rule — with no session cwd yet, this grades Unknown rather than No, so this population is only reachable once the session has a shell.

The harness (`classify.py`) deliberately sends every corpus case regardless of `isShellCandidate`, so its No-band count will be much larger than production's and must not be read as inference saved in the real app. Step 8's report should say which No-band cases would have been filtered by `isShellCandidate` anyway, so the number means something.

None of this weakens the plan — the Maybe band (arming the model with the program's own documentation) was always the larger prize, and these two No populations close a real gap. But a reader who expects No to be the headline saving will misread every number in Step 8.

#### The harvest sources, in preference order {#harvest-sources}

1. **Curated seeds** — hand-written grammar entries for the commands that matter most and resist automated distillation: `git`, `cargo`, `bun`, `bunx`, `just`, `docker`, `brew`, `npm`, `rg`, `fd`, `tugutil`, plus every English-word opener in the corpus (`make`, `find`, `open`, `sort`, `head`, `touch`, `which`, `kill`, `write`, `say`, `look`, `cut`, `split`, `join`, `yes`, `top`, `sleep`, `last`, `who`). Curated entries may include one level of subcommand grammar (`git commit` takes `-m <msg>`, …).
2. **Man pages** — `man -w <cmd>` to locate, render, and distill SYNOPSIS + OPTIONS into flags and a synopsis. Executes nothing but `man`.
3. **`--help` probe** — opt-in per [P04], for man-less modern CLIs.

Each catalog entry records its `source` and harvested `version` (when determinable without execution: man page headers often carry it; probed entries record probed versions).

---

### Specification {#specification}

**Spec S01: The band grading algorithm** {#s01-grading-algorithm}

Input: the trimmed single-line text, the login-PATH command set, the builtin list (S02), the catalog, and `cwd: Option<&Path>` — the shell session's tracked working directory (see Spec S07). Output: `Graded { band, synopsis: Option<String>, command: Option<String> }`.

1. **Lex.** Strip a leading `NAME=value` env-assign prefix per segment. Tokenize with shell-aware quoting (single, double, backslash). Split into simple-command segments on `|`, `&&`, `||`, `;`. A line the lexer cannot confidently segment (unbalanced quote, heredoc `<<`, process substitution, backtick/`$(` substitution) → **Unknown**. Substitutions are Unknown, not an attempt to lex inside them.
2. **Resolve each segment head.** A head resolves if it is in the command set, in the builtin list, or is path-shaped and stats to an existing executable file. Path-shaped heads split by what they are relative to (Spec S07): `/a/b` and `~/x` are position-independent and stat directly; `./x` and any bare-relative path are relative to the **shell session's** cwd, not tugcast's process cwd, and stat only when a `cwd` was supplied. **A relative head with no `cwd` available grades Unknown, never No** — an un-checkable path is absence of validation, not evidence of absence, which is the [P02] rule applied to the one input the grader may be missing. Any head that resolves to nothing (with the check actually performed) → the whole line is **No**.
3. **Grade each resolved segment.** No catalog entry for the head → **Unknown**. With an entry: walk the tokens — known subcommand descends into its sub-grammar; a token matching a known flag (or a flag's declared value) is consumed; a positional token is checked against the entry's positional policy (`free` = anything allowed, `files` = anything allowed, `none` = positional tokens are a mismatch, `enum:[…]` = must match). Every token accounted for → **Yes**. Any unaccounted token (unknown flag, unknown subcommand, positional where `none`) → **Maybe**.
4. **Combine.** The line's band is the weakest segment's: No < Unknown < Maybe < Yes. A Maybe line's synopsis is the first Maybe segment's entry synopsis.

Note what the algorithm never does: it never reads English. `make the watch loop resilient` — `make` has positional policy `free` — grades **Yes**, and the model decides, exactly as intended.

**Spec S02: The builtin list** {#s02-builtins}

A `const` slice in the crate: `cd`, `export`, `source`, `.`, `alias`, `unalias`, `set`, `unset`, `echo`, `printf`, `read`, `eval`, `exec`, `exit`, `pwd`, `true`, `false`, `test`, `[`, `type`, `hash`, `jobs`, `fg`, `bg`, `wait`, `command`, `builtin`, `history`. Builtins resolve (step 2) but carry no catalog grammar unless curated → Unknown by default, which sends them down today's path.

**Spec S03: The synopsis format and cap** {#s03-synopsis-format}

`SYNOPSIS_CHAR_CAP = 1200` characters (roughly 300 tokens). Structure, in order, truncating from the bottom: one-line description; usage line(s); subcommand list (names + one-line each, if any); the most common flags with one-line descriptions; `(<cmd> as of <version>, via <source>)` provenance trailer. The harvester enforces the cap at build time; a catalog integrity test asserts it (`cargo nextest run -p tuggram`), so the runtime never truncates.

**Spec S04: Wire and envelope changes** {#s04-wire-changes}

- New `SHELL_INPUT` verb: `{"type":"shell_grammar","tug_session_id":"…","line":"…"}`. Reply on `SHELL_OUTPUT`: `{"type":"shell_grammar","tug_session_id":"…","line":"…","band":"yes"|"maybe"|"no"|"unknown","synopsis":"…"?}`. The reply echoes `line` verbatim so the deck can key responses; `synopsis` present only on `maybe`.
- Bridge classify body gains optional `grammar: string`; `MainWindow.swift` `case "classify"` reads `body["grammar"] as? String`; the `LocalModelService` classify kind gains the optional string; when present the service uses `LocalModelPrompts.classifyWithGrammar` with the synopsis substituted, and logs that the grammar variant ran (so eval can tell the variants apart).
- tugcast `local_model_classify` action gains optional param `grammar`; the requester threads it through; the `local model classify answered` log line gains a `grammar=true|false` field.

**Spec S05: `classifyWithGrammar` prompt shape** {#s05-grammar-prompt}

The base classify rules verbatim, then:

```
The program's own documentation, from this machine:

<synopsis>

Judge the line against this documentation. If what follows the first word
reads as arguments this documentation accepts, answer SHELL. If it reads
as an English request the documentation gives no meaning to, answer PROMPT.
When in doubt, answer PROMPT.
```

The final tie-break sentence repeats the base prompt's doubt rule on purpose — it is the load-bearing sentence and it must survive any truncated reading. Exact wording is fixed at implementation and then frozen under the same comparability rule as its siblings ([P05]).

**Spec S06: Catalog entry schema** {#s06-catalog-schema}

```json
{
  "name": "git",
  "source": "curated",
  "version": "2.50.1",
  "synopsis": "…(≤1200 chars)…",
  "flags": ["-C", "-c", "--version", "--help"],
  "value_flags": ["-C", "-c"],
  "positionals": "none",
  "subcommands": {
    "commit": { "flags": ["-m", "-a", "--amend"], "value_flags": ["-m"], "positionals": "files" },
    "status": { "flags": ["-s", "-b"], "positionals": "none" }
  }
}
```

`positionals` ∈ `"free" | "files" | "none" | {"enum":[…]}`. `files` and `free` are graded identically (anything allowed) but recorded distinctly for future tightening. A name with no grammar payload is not written to the catalog at all (absence = Unknown).

**Spec S07: Which working directory a relative path resolves against** {#s07-cwd-contract}

`grade()` takes `cwd: Option<&Path>` and never consults the process's own working directory — tugcast's cwd is wherever the host launched it and has nothing to do with where the user's shell is standing.

The cwd comes from the shell session state `feeds/shell.rs` already maintains: each exec's trailing `<marker>\t<code>\t<cwd>` line yields `cwd_after`, which is stored on the session and reported to the deck. Because the `shell_grammar` request carries `tug_session_id` (Spec S04), the handler looks the session up and passes its current cwd.

Three cases, and the third is the one that matters:

- **Absolute (`/usr/bin/true`) and tilde (`~/bin/x`)** — position-independent. Stat directly; `cwd` is not consulted.
- **Relative (`./build.sh`, `bin/tool`) with a cwd known** — stat against the session cwd.
- **Relative with no cwd known** — no shell child has spawned yet in this session, so there is no cwd to resolve against. Grade **Unknown**. This is [P02] applied to a missing input: the grader could not perform the check, which is not the same as performing it and finding nothing. Grading No here would silently swallow `./build.sh` as prose in exactly the situation where a user is most likely to type it — the first command of a fresh session.

This is strictly more capability than the deck has today: `isShellCandidate` accepts any `./x` on faith because the deck cannot stat. The grader can, so it should — but only when it actually holds the cwd.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Grammar band + synopsis per line (session-scoped, request/reply) | local-data | `ShellGrammarStore` class beside `PathCommandsStore`, subscribed to the card's `SHELL_OUTPUT` `FeedStore`; consulted imperatively in submit/debounce (no render dependency) | [L02] store surface, [L22] direct feed read |
| Band cache (per draft text) | local-data | plain `Map` beside `ShellVerdictCache` in the prompt-entry ref, cleared with it | [L22] |

No React render reads either — routing is a submit-time act, so nothing here enters React state at all.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New crates {#new-crates}

| Crate | Purpose |
|-------|---------|
| `tugrust/crates/tuggram` | The baby grammar checker: lexer, band grader, embedded catalog, harvester bin, grade bin |

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tuggram/src/lib.rs` | `grade()`, `Band`, `Graded`, catalog load, PATH resolution (moved from `feeds/shell.rs`) |
| `tugrust/crates/tuggram/src/lex.rs` | The shell-aware tokenizer/segmenter (Spec S01 step 1) |
| `tugrust/crates/tuggram/src/catalog.rs` | Schema types (Spec S06), embedded parse, integrity checks |
| `tugrust/crates/tuggram/src/bin/harvest.rs` | The batch harvester ([P03], [P04]) |
| `tugrust/crates/tuggram/src/bin/grade.rs` | Stdin lines → JSON bands; the harness's deterministic seam (mirror of `veto-filter.ts`) |
| `tugrust/crates/tuggram/data/commands.json` | The committed catalog |
| `tugdeck/src/lib/shell-grammar-store.ts` | `ShellGrammarStore` (state-zone table above) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `Band`, `Graded`, `grade` | enum/struct/fn | `tuggram/src/lib.rs` | pure over (line, command set, builtins, catalog, `cwd: Option<&Path>`) — never reads the process cwd (Spec S07) |
| `GRADE_SUBMIT_WAIT_MS` | const | `tugdeck/src/lib/shell-grammar-store.ts` | 150ms; in series ahead of `VERDICT_SUBMIT_WAIT_MS`, so deliberately far below it ([P06]) |
| `probe_login_path`, `command_names_in_path` | fn (moved) | `tuggram/src/lib.rs` | tugcast re-uses; single statement of PATH resolution |
| `shell_grammar` verb handling | match arm | `tugcast/src/feeds/shell.rs` | mirrors `path_commands` request/reply |
| `requestClassify(text, grammar?)` | fn (widened) | `tugdeck/src/lib/local-model-bridge.ts` | optional `grammar` in the posted body |
| `"grammar"` decode | Swift | `tugapp/Sources/MainWindow.swift` | `case "classify"` |
| `.classify(text:labels:grammar:)` | enum case (widened) | `tugapp/Sources/LocalModelService.swift` | optional String |
| `LocalModelPrompts.classifyWithGrammar` | static let | `tugapp/Sources/LocalModelService.swift` | Spec S05; base `classify` untouched |
| `local_model_classify` `grammar` param | action param | `tugcast/src/local_model.rs` | harness parity; log field `grammar=` |
| band handling in `performSubmit` + debounce | logic | `tugdeck/src/components/tugways/tug-prompt-entry.tsx` | [P06]; confined to the existing shell-routing block |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuggram` crate-level doc: the band doctrine ([P02]) and the no-exec harvest policy ([P04]) stated where the code lives.
- [ ] `shell-line-classifier.ts` module docstring: the grader joins the bracket (Step 5).
- [ ] `LocalModelService.swift` freeze docstring: the additive-variant clause (Step 6).
- [ ] `tests/model-eval/classify.py` docstring: the composed-pipeline scoring model (Step 8).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | Lexer, band rules, catalog integrity, corpus band floors | the crate; the bulk of this plan's coverage, inference-free |
| **Unit (bun)** | `ShellGrammarStore` folding, bridge body shape, band-handling decision table as pure logic | deck modules |
| **Integration (harness)** | Composed pipeline scoring against a live instance | `just model-classify` after Step 8 |
| **Real-app** | The submit path still routes/degrades correctly in the real card | named `tests/app-test` selection in Step 9 |

#### What stays out of tests {#test-non-goals}

- Model quality on Yes/Maybe bands per pack — that is bake-off territory (`tests/model-eval`), a rate to measure, not a unit test to pin.
- Harvester output fidelity per command — the committed catalog is reviewed as a diff; the integrity test pins schema and caps, not per-command truth.
- Fake-DOM/RTL or mock-store tests — banned; the deck's band decision table is pure logic and is tested as such.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Applies to every step.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The tuggram crate: lexer and resolution bands | done | `71c9ac3f8` |
| #step-2 | Catalog schema, embedded load, Yes/Maybe grading | done | `a2f579836` |
| #step-3 | The harvester and the committed catalog | done | `1508a9f40` |
| #step-4 | tugcast serves shell_grammar | done | `1508a9f40` |
| #step-5 | Deck: grammar store and band handling | done | `1508a9f40` |
| #step-6 | Swift: the grammar-bearing classify | done | `1508a9f40` |
| #step-7 | Corpus: band labels and No-band cases | done | `d618e67fc` |
| #step-8 | Harness: score the composed pipeline | done | `99eb9fd0d` |
| #step-9 | Integration checkpoint — live routing | done | verification only |

#### Step 1: The tuggram crate: lexer and resolution bands {#step-1}

**Commit:** `tuggram(new): lex a line and grade its command heads against the PATH`

**References:** [P01] grader in tugcast, [P02] band semantics, Spec S01, Spec S02, (#current-flow, #r04-lexer-divergence)

**Artifacts:**
- New crate `tugrust/crates/tuggram` in the workspace: `lib.rs`, `lex.rs`; `Band`, `Graded`, `grade()` with resolution-only grading (no catalog yet: every resolved head grades Unknown, every unresolved head No, unlexable Unknown).
- `probe_login_path` / `command_names_in_path` moved here from `tugcast/src/feeds/shell.rs`; tugcast imports them (behavior identical, one statement of truth).

**Tasks:**
- [ ] Workspace member + crate scaffolding; move the PATH-resolution functions; keep tugcast green against the re-export.
- [ ] Implement the lexer per Spec S01 step 1 (quoting, env-assign prefixes, segment split, Unknown on substitutions/heredocs/unbalanced quotes).
- [ ] Implement head resolution per Spec S01 step 2 and the cwd contract in Spec S07: `grade()` takes `cwd: Option<&Path>` and never reads the process cwd; absolute and `~/` heads stat directly; relative heads stat against the supplied cwd; a relative head with `cwd: None` grades Unknown, not No. Builtin list per Spec S02.

**Tests:**
- [ ] Lexer table tests: quoting, pipes, `&&`/`;`, env prefixes, the Unknown constructs.
- [ ] Resolution tests over an injected command set (no real PATH in unit tests): No on unresolved heads, No on a pipeline with one bad head, Unknown on resolved-no-catalog.
- [ ] Cwd tests (Spec S07) over a tempdir: `./x` with a cwd that holds an executable `x` resolves; the same line with a cwd that doesn't grades No; the same line with `cwd: None` grades **Unknown**; an absolute path is unaffected by cwd.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tuggram -p tugcast`

---

#### Step 2: Catalog schema, embedded load, Yes/Maybe grading {#step-2}

**Depends on:** #step-1

**Commit:** `tuggram(catalog): grade tokens against a baked command grammar`

**References:** [P02] band semantics, [P03] baked catalog, Spec S01, Spec S03, Spec S06, (#r01-catalog-staleness)

**Artifacts:**
- `catalog.rs`: schema types, `include_str!` + `OnceLock` load, integrity checks (synopsis cap, no empty grammars, sorted names).
- Full grading per Spec S01 steps 3–4. A starter `data/commands.json` of ~20 curated entries covering the corpus's English-word openers and the big compound CLIs (List in #harvest-sources).

**Tasks:**
- [ ] Schema + loader + integrity test.
- [ ] Token walk: subcommand descent, flags, value flags, positional policies; band combination across segments.
- [ ] Author the curated starter entries, each with a capped synopsis.

**Tests:**
- [ ] Grading table tests: `git status` Yes; `git stauts` Maybe; `git commit -m "fix crash"` Yes; `make the watch loop resilient` Yes (positional `free` — the documented non-goal of reading English); `rg --no-such-flag x` Maybe; builtin `cd tugrust` Unknown; catalog integrity (every synopsis ≤ cap).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tuggram`

---

#### Step 3: The harvester and the committed catalog {#step-3}

**Depends on:** #step-2

**Commit:** `tuggram(harvest): distill man pages into the command catalog, batch, executing nothing`

**References:** [P03] baked catalog, [P04] no exec by default, Spec S03, Spec S06, (#harvest-sources, #r03-harvest-safety)

**Artifacts:**
- `src/bin/harvest.rs`: PATH sweep → man-page distillation → merged with curated seeds → deterministic `data/commands.json`. `--probe-help` (allowlisted dirs, kill-timeout, stripped env, closed stdin) off by default.
- The regenerated committed catalog from this machine's PATH — the "complete local listing": every PATH command appears in the harvest report; those yielding a grammar enter the catalog, the rest are counted and named in the report (absence = Unknown at runtime).

**Tasks:**
- [ ] `man -w` location, render, SYNOPSIS/OPTIONS distillation into flags + synopsis with the cap enforced at build.
- [ ] Curated-seed merge (curated wins on collision); deterministic ordering; per-entry `source`/`version` provenance.
- [ ] Probe mode per [P04]; run the default harvest, review the diff, commit the catalog.

**Tests:**
- [ ] Distiller unit tests over checked-in man-page fixtures (no `man` execution in tests).
- [ ] Harvest determinism: two runs over the same fixtures byte-identical.
- [ ] Integrity test passes over the real committed catalog.

**Checkpoint:**
- [ ] `cd tugrust && cargo run -p tuggram --bin harvest -- --check` — regeneration is a no-op against the committed file. **This holds only on the harvest machine**, since the sweep reads the local PATH and local man pages; it is a reproducibility check for whoever regenerates the catalog, not a portable gate, and it must never run in a suite that another machine is expected to pass.
- [ ] `cd tugrust && cargo nextest run -p tuggram`

---

#### Step 4: tugcast serves shell_grammar {#step-4}

**Depends on:** #step-2

**Commit:** `tugcast(shell): answer a shell_grammar request with a band and a synopsis`

**References:** [P01] grader in tugcast, Spec S04, Spec S07, (#current-flow, #s07-cwd-contract)

**Artifacts:**
- `feeds/shell.rs`: `shell_grammar` verb → `grade()` over the cached PATH set and the session's tracked cwd → reply frame per Spec S04.

**Tasks:**
- [ ] Verb parse + dispatch beside `path_commands`; reply echoes `line`.
- [ ] Supply the cwd per Spec S07: look the session up by `tug_session_id` and pass its current working directory — the value `feeds/shell.rs` already maintains from each exec's trailing `<marker>\t<code>\t<cwd>` line (`cwd_after`). Pass `None` when no shell child has spawned yet; never substitute the process cwd.
- [ ] Grade on `spawn_blocking`, since head resolution can stat.

**Tests:**
- [ ] Feed round-trip tests mirroring `path_commands_round_trip_over_the_feed`: one per band, synopsis only on maybe, session scoping respected.
- [ ] A session with no shell child yet grades `./x` **Unknown**; after an exec establishes a cwd, the same line grades against that directory (Spec S07's three cases, at the feed layer).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`

---

#### Step 5: Deck: grammar store and band handling {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(routing): grade before asking — No skips the model, Maybe arms it`

**References:** [P06] deck band handling, [Q04] candidate check stays, Spec S04, (#state-zone-mapping, #r05-prompt-entry-churn)

**Artifacts:**
- `tugdeck/src/lib/shell-grammar-store.ts` (`ShellGrammarStore`: request/reply over the card's `SHELL_OUTPUT` FeedStore, promise-per-line with a bounded wait, band+synopsis cache).
- `local-model-bridge.ts`: `requestClassify(text, grammar?)`.
- `tug-prompt-entry.tsx`: the debounce and `performSubmit` shell-routing block consult the grade per [P06]; veto unchanged; every degraded path unchanged.
- The `shell-line-classifier.ts` module docstring gains the grader's place in the bracket (a third fact source, still deciding nothing about intent).

**Tasks:**
- [ ] Store + wiring through `use-session-card-services` beside `PathCommandsStore`. **Optional exactly as `PathCommandsStore` is** — hosts without a shell (the gallery) omit it, and an absent store must grade every line Unknown, which is today's path. This is the same null-until-loaded safety posture the command set already has; do it deliberately rather than inheriting it by accident.
- [ ] Band decision table as a pure exported function in `shell-line-classifier.ts` (`modelCallForBand(band): "skip" | "ask" | "ask-with-grammar"`), so the prompt-entry diff stays confined.
- [ ] Fire the grade request in the debounce **alongside** the classify request, not after it ([P06]) — a serial debounce would stack grade latency in front of classify latency on every keystroke.
- [ ] Bridge widening; cache the band beside the verdict cache, cleared together.

**Tests:**
- [ ] `bun:test`: store folding (`_ingestForTest` seam like `PathCommandsStore`), decision table, bridge body shape with/without grammar.
- [ ] `bun:test`: an absent/unloaded grammar store yields Unknown (so the gallery and the pre-load window behave exactly as today).

**Checkpoint:**
- [ ] `bunx tsc --noEmit && bun test tugdeck/src/lib`
- [ ] `bunx vite build`

---

#### Step 6: Swift: the grammar-bearing classify {#step-6}

**Depends on:** #step-5

**Commit:** `tugapp(local-model): read the program's own documentation into a Maybe-band classify`

**References:** [P05] grammar field, [Q03] synopsis plumbing, Spec S04, Spec S05, (#r02-maybe-latency)

**Artifacts:**
- `MainWindow.swift`: `case "classify"` decodes optional `body["grammar"]`.
- `LocalModelService.swift`: classify kind carries the optional grammar; `LocalModelPrompts.classifyWithGrammar` per Spec S05; the freeze docstring gains the additive-variant clause from [P05]; the answered log line distinguishes the variants.
- tugcast `local_model.rs`: optional `grammar` param on the `local_model_classify` action, threaded to the requester; `grammar=` field on the answered log line.

**Tasks:**
- [ ] Decode + kind + prompt composition; `classifyMaxTokens` untouched.
- [ ] Tell param + requester threading + log field.

**Tests:**
- [ ] Rust: action-param parse and log-field tests in `local_model.rs`'s existing test style.
- [ ] Swift behavior is exercised end to end by Step 8's harness (the service has no unit-test seam for prompt text; the log line is the observable).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `just app-debug` builds and launches

---

#### Step 7: Corpus: band labels and No-band cases {#step-7}

**Depends on:** #step-3

**Commit:** `model-eval(corpus): label the band a line should grade, add the lines the model never sees`

**References:** [P02] band semantics, (#corpus-no-band-blindness)

**Artifacts:**
- `tests/model-eval/classify-corpus.json`: optional `"band"` field on cases where the expected band is stable; ~10 new No-band cases (prose with non-resolving openers — the population the deck filters before the model today) and 2–3 Unknown-band cases (real commands with no catalog grammar); `_doc` updated.
- `tugrust/crates/tuggram/data/corpus-commands.txt`: the **injected** command set the corpus test grades against — the union of the committed catalog's names and every opener the corpus uses. Committed, small, hand-reviewable.
- A `tuggram` corpus test: read the corpus file, grade every case against the committed catalog and that injected set (never a live PATH sweep, never a real stat), assert every present `band` label, and assert the floor — **no `shell`-labeled line grades No**.

**The corpus test must be hermetic, and this is the whole point of the injected set.** Everything else in `cargo nextest` here runs with no app, no model, and no network; a live login-PATH sweep inside the unit suite would break that and make the result depend on what Homebrew installed this week. The same reasoning covers the stat in Spec S07: the corpus test passes `cwd: None`, so relative openers grade Unknown deterministically rather than touching the filesystem. The live-PATH reading — does the floor still hold against this machine's real command set — belongs to Step 8's harness run, which is machine-bound by nature and already reports per band.

**Tasks:**
- [ ] Label existing cases where stable (openers with curated grammars); leave genuinely PATH-dependent ones unlabeled.
- [ ] Author the new cases; keep the pairing doctrine (`_doc`) intact.
- [ ] Author `corpus-commands.txt` and assert in the same test that it covers every corpus opener (so a new case can't silently grade No for want of a set entry).

**Tests:**
- [ ] The corpus band test above (`cargo nextest run -p tuggram corpus`), hermetic — no PATH sweep, no stat, `cwd: None`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tuggram`
- [ ] The suite passes with the environment stripped, proving hermeticity rather than asserting it. Not through `cargo`, which needs `rustc` on the PATH to run at all — build first, then run the test binary with nothing: `cargo build --tests -p tuggram && env -i PATH=/nonexistent HOME=/nonexistent target/debug/deps/tuggram-*`

---

#### Step 8: Harness: score the composed pipeline {#step-8}

**Depends on:** #step-6, #step-7

**Commit:** `model-eval(classify): score grade, model, veto as the one pipeline production runs`

**References:** [P05] grammar field, [P06] deck band handling, Spec S04, (#success-criteria, #corpus-no-band-blindness)

**Artifacts:**
- `src/bin/grade.rs`: corpus lines on stdin → `{"line": {"band": …, "synopsis": …}}` JSON on stdout — the deterministic seam `classify.py` shells, mirroring `veto-filter.ts`. It grades against the **live** login PATH (unlike Step 7's hermetic test), because the harness's job is to read reality. `classify.py` builds it once (`cargo build -p tuggram --bin grade`) and invokes the built binary, never `cargo run` per call — a cold rebuild inside the scoring loop would dominate the run's wall time and be mistaken for model latency.
- `classify.py`: grade every case first; No-band cases are scored without a model call; Yes/Unknown cases drive the tell as today; Maybe cases drive it with `-p grammar=<synopsis>`; the veto applies to every SHELL verdict as today. Report per band: case counts, accuracy, inference spent; the gate (exit code) is composed zero-executed-false-SHELL; the pack's own unfiltered false SHELL is still reported alongside.

**Tasks:**
- [ ] The grade bin; wire into `classify.py` with the same fail-loudly posture as `veto_map()`.
- [ ] Band-aware scoring + report; `--json` output carries the band per case for downstream analysis.

**Tests:**
- [ ] `classify.py` self-consistency: a case graded No must never appear in the tell log for the run (asserted in the runner).

**Checkpoint:**
- [ ] `just model-classify` against the dash's debug instance: composed false SHELL = 0; shell recall ≥ 30/35; report shows all four bands populated

---

#### Step 9: Integration checkpoint — live routing {#step-9}

**Depends on:** #step-5, #step-8

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #r02-maybe-latency, #r05-prompt-entry-churn)

**Tasks:**
- [ ] `just app-debug`; in the live card, exercise each band with a line that actually reaches the grader (see #no-band-real-scope — plain prose is filtered by `isShellCandidate` before grading, so it does **not** test the No band):
  - **No** — `git status | frobnicate` (head resolves so the deck asks; the pipeline tail does not, so the grader refuses). Expect: routes to Claude, and **no** `local model classify answered` line in the tugcast log for it.
  - **No, second population** — `./nonexistent-script.sh` in a session that has already run one shell command (so a cwd is tracked). Same expectation.
  - **Yes** — `git status` routes to the shell, with a classify log line carrying `grammar=false`.
  - **Maybe** — `git stauts` produces a classify log line carrying `grammar=true`.
  - **Unknown** — a resolving command with no catalog entry behaves exactly as it does today.
- [ ] Read Maybe-band classify latency from the answered log lines; confirm p95 comfortably inside the 2s deadline, else tune `SYNOPSIS_CHAR_CAP` down.
- [ ] Run the named app-test selection (within the 20-file budget, chosen here, not at run time): `at0216-shell-exchange.test.ts`, `at0280-local-model-absent.test.ts`, `at0000-smoke.test.ts`, `at0204-prompt-entry-text-surface.test.ts` via `just app-test <files>`.

**Tests:**
- [ ] The four app-tests above pass.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `bunx vite build`
- [ ] `just app-test tests/app-test/at0216-shell-exchange.test.ts tests/app-test/at0280-local-model-absent.test.ts tests/app-test/at0000-smoke.test.ts tests/app-test/at0204-prompt-entry-text-surface.test.ts` → `VERDICT: PASS`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Shell routing runs grade → model → veto as one pipeline: a deterministic, catalog-backed Rust grader that spends no inference on impossible commands, hands the model the program's own documentation on ambiguous ones, and leaves the model and the veto as the only path to execution.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `just model-classify` composed gate passes: zero executed false SHELL, shell recall ≥ 30/35, all four bands exercised (Step 8 report).
- [ ] `cargo nextest run -p tuggram` pins lexing, grading, catalog integrity, and the corpus band floor with no inference.
- [ ] The committed catalog regenerates as a no-op on the harvest machine (`harvest -- --check`; see #step-3 for why this is not portable).
- [ ] Live behavior verified per Step 9, including Maybe-band latency inside the deadline.
- [ ] The `shell-line-classifier.ts` docstring and the `LocalModelService.swift` freeze docstring both state the grader's place accurately.

**Acceptance tests:**
- [ ] Step 8's harness run (the composed gate).
- [ ] Step 9's named app-test selection.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Runtime version matching if live Maybe rates show drift ([Q05]).
- [ ] Yes-band model-agreement telemetry, the only evidence that could reopen [Q02].
- [ ] `--probe-help` harvest pass over man-less CLIs, expanding Unknown → graded coverage.
- [ ] `model-stats` surfacing of band rates from the new log fields.
- [ ] Re-weighing the pack bake-off's routing criterion now that the model sees only the residual (interacts with the rescue-or-rule-LFM2.5 work).

| Checkpoint | Verification |
|------------|--------------|
| Composed routing gate | `just model-classify` exit 0 with the Step 8 report shape |
| Grader hermeticity | `cargo nextest run -p tuggram` green offline |
| Catalog reproducibility (harvest machine only) | `cargo run -p tuggram --bin harvest -- --check` |
| Live pipeline | Step 9 walkthrough + named app-tests `VERDICT: PASS` |

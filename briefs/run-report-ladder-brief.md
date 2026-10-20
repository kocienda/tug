<!-- brief-skeleton v1 -->

# The run-report ladder: one run panel for any project's tests, builds and loops

**Purpose:** The Bash block's run panel is drawn from one generic wire message, but the only commands that reach it are three hardcoded test runners and this checkout's own recipes. Any other project's testing, building or item-by-item command should land on the same panel without the project, or the model driving it, having to learn Tug.

---

## Purpose {#purpose}

The user, after a session of refining the panel: "I really love how this interface has turned out. My concern now is to make it more and more like an API that the model would know how to use for *any* item-based or count-based interface in a transcript, rather than just for building this app and the app-tests we have in this project — which other projects may not have. How can we modify and extend this interface so that some other project's testing, building, incremental-item interface will *just work* with this UI model we've set up."

Tug ships to projects that have no `justfile`, no `tests/app-test/`, and runners we have never parsed. On those projects today a `pytest` or `go test` call is a silent Bash block for its whole length, and the model has no way to know how to make it otherwise.

---

## Evidence {#evidence}

**[F01] The wire message is already generic** — `run_progress` on `/api/session` carries `label`, `text`, `done`, `total`, `failures`, `unit`, `jobs`, an opaque `units` array, and `needles` (`tugrust/crates/tugcast/src/server.rs`, `RunProgressReport` in `feeds/agent_supervisor/mod.rs`). A report with a `unit` draws the panel; one without it draws the one-line band. Nothing in the message or in the deck's `RunPanelModel` names a runner, a recipe, or this project. **(verified)**

**[F02] The unit-row schema is the public contract, undocumented** — a row is `name`, `status`, `index`, and optionally `passed`, `total`, `secs`, `median`, `started_at_ms`, `title`, `message`, `history` (`tests/app-test/scripts/run-units.ts` `UnitRow`; the deck's `RunUnit` in `tugdeck/src/lib/run-progress-store.ts`). The status vocabulary is seven words: `pending running pass fail error wedged skipped`. It is written down only as a TypeScript type in each end, with no prose a model or a project could read. **(verified)**

**[F03] Three layers hold all the Tug-specific knowledge** — (a) the PreToolUse hook's runner table is a hardcoded list of three heads: `cargo nextest run`, `cargo test`, `bun test` (`TEST_RUNNERS` in `tugrust/crates/tugtool/src/commands/hook.rs`); (b) `tugtool test run --kind` has exactly those three parsers (`RunKind` in `tugrust/crates/tugtool/src/test_run.rs`); (c) the app-test recipe reports its rows through a bespoke script that reads its run directory (`run-units.ts`, called from `post_units` in `tests/app-test/scripts/app-test.sh`) and the build recipe reports phases through `tugrust/scripts/report-phase.sh`. Everything beneath those — `tugtool progress`, `progress phase`, attachment by `TUG_TOOL_USE_ID`, the needle fallback, the deck — is project-neutral. **(verified)**

**[F04] `progress phase` is the shape that works** — it keeps the run's state between calls, keyed by label and session, so a recipe writes one line per phase and builds no JSON (`tugtool progress phase --help`). The app-test rows are the same idea done by hand: the recipe keeps `.start`/`.row`/`.fails` files and a script assembles them into the array on every report. **(verified)**

**[F05] `wedged` is this project's word** — it is the app-test recipe's name for a file killed at its wedge cap (`wedge-cap.ts`). The same string also names an unrelated session state in `tugdeck/src/lib/code-session-store/` (`end-state.ts`, `reducer.ts`, `events.ts`, `session-phase-visual.ts`), which is not the run-unit vocabulary and is untouched by this work. **(verified)**

**[F06] Attachment is exact when the call id is in the environment and a needle match otherwise** — the hook prepends `TUG_TOOL_USE_ID=<id>` only to the commands it wraps; a recipe reached through an unwrapped head (`just app-test`) attaches by `--needle "just app-test"` against the open calls' command text (`attach_run`). The `run_gaps` ledger shows the needle path working: `just app-test` is the top gap head only because the arc card's reports were dropped by the rotation bug fixed in `c5df24ac66`, not because the match failed. **(verified)**

**[F07] A line the hook cannot read is never wrapped** — a here-document, a `$(…)` or a backtick anywhere in the Bash command makes `simple_commands` return `None`, and the runner inside runs unreported. The prompt section added to `tugplug/tool-calls.md` on 2026-10-19 tells the model to give a test run its own call; it is the first prose about this interface that reaches every project. **(verified)**

**[F08] `tugtool progress gaps` is the adoption loop** — it ranks long foreground calls that ended with no unit report by command head (`tugcore::run_gaps`). It is project-neutral already and is how the next adapter is chosen on any project. **(verified)**

---

## Decisions {#decisions}

**[B01] The panel is reached by a ladder of four rungs, and a project climbs to whichever it can.** Rung 0: the command is a known or declared runner and the hook wraps it — the project does nothing. Rung 1: a script that iterates items reports each one with `tugtool progress unit …`. Rung 2: an unknown runner is wrapped by the model with `tugtool test run --kind tap|junit|lines`. Rung 3: a command with only a count reports `tugtool progress --done --total`. Each rung is a complete, working interface on its own; a project on rung 3 gets the band, on rung 1 the full panel. The ladder is also the order of work (Exit), because each rung is the one the next is built on.

**[B02] The wire message does not change.** `run_progress` and the unit-row schema are the contract every rung reports through, and the deck is not touched except for [B06]. A generalization that changed the message would re-open the panel the user just finished.

**[B03] The hook's runner table becomes built-ins plus a per-project declaration.** The built-ins grow from three to the common runners and the streaming format each already speaks: `go test -json`, `pytest` (verbose lines, junit for the record), `jest`/`vitest`, `mocha`, `node --test` (TAP natively), `swift test`, `dotnet test`, `ctest`, `rspec`, `phpunit`. A project names its own in `.tugtool/config.toml` as `[[tugtool.run.runner]]` entries — `match` (the command head), and either `kind` (how to read its output) or `unit` alone (the recipe reports itself, as `just app-test` does). The hook reads that table the way `tugtool arc config` reads `[tugtool.arc]`, from the same file, so a project that has already declared its arc surfaces has the place to declare its runners. The shape mirrors `[[tugtool.arc.surface]]` so there is one way to spell a per-project table.

**[B04] `tugtool progress unit` is `progress phase`'s sibling for items.** `unit plan <label> --of <names…> [--jobs n]` declares the set so pending rows are drawn; `unit start <label> <name>`; `unit done <label> <name> pass|fail|error|skipped|stalled [--secs] [--title] [--message]`; `unit finish <label>`. State is kept by label and session exactly as phases are, every call posts the whole run, and a shell loop writes one line per item and never builds JSON. The row thinning past 64 units that `run-units.ts` does moves into the verb, so a long run's reports stay small on any project.

**[B05] App-test is ported onto `progress unit`, and `run-units.ts` is deleted.** The hardest existing case rides the public rung, which is the proof that the rung carries real weight; `report-phase.sh` stays, since `progress phase` is already the public verb. Anything app-test still needs that the verb lacks is a gap in the verb, not a reason for the script to survive.

**[B06] `wedged` is renamed `stalled` in the run-unit vocabulary; `wedged` is read as an alias.** The public word has to make sense to a project that has never heard of a wedge cap: a unit that was stopped for taking too long is stalled. The deck's `RunUnitStatus`, `RunPanelModel`, the panel's `WORD`/`DOT` tables, the `run-units.ts` map (until [B05] deletes it) and the app-test recipe's `WEDGED` row word all move; the store accepts `wedged` on the wire and reads it as `stalled` so an older reporter is not refused. The session-state `wedged` in `code-session-store` is a different word and is not touched ([F05]).

**[B07] `test run` grows three universal kinds beside the three parsers.** `--kind tap` reads TAP from stdout, which a long tail of runners can emit. `--kind junit` draws nothing live but records the exact tally and the failures from the document at exit. `--kind lines --item <regex>` is the escape hatch: named groups `name` and `status` make the rows, `--total <regex>` with a `total` group reads the count up front, and the status group's words are mapped onto the vocabulary. The model can write this for anything that prints one line per item.

**[B08] Needles stay the fallback, not the path.** `TUG_TOOL_USE_ID` in the environment is exact attachment and remains the primary; a recipe reached through an unwrapped head still matches by needle. Putting the call id into the environment of every Bash call was considered and is not decided here — it would change the command text the user sees on every block, and that cost has not been looked at. Nothing in this work depends on it.

**[B09] The model learns the ladder from a prompt section, not from this checkout.** A section in `tugplug/tool-calls.md` (or a ninth prompt file if it outgrows that one) says, in order: a known or declared runner needs nothing; a loop over items emits `progress unit` lines; an unknown runner is wrapped with `test run --kind tap|junit|lines`; a bare count is `progress --done --total`. It publishes the row vocabulary and points at `tugtool progress gaps` as the list of what to adopt next. The plugin lint's standalone rules apply: no checkout paths, no `just`.

**[B10] `tugtool run runners` lists what rung 0 knows.** Built-ins and the project's declarations, in one listing, so the model and the user can see why a command was or was not wrapped without reading the hook.

---

## Open Questions {#open-questions}

- **Which built-in runners stream, and in what form, needs confirming per runner before its table entry is written.** `go test -json` and TAP are known; `pytest -v`'s line shape under `-q`/`-x`/plugins, `jest`'s default reporter versus `--json` (which is final-only), and `swift test`'s output are each a read of the real tool. A built-in that misreads its runner is worse than none, since the block then draws a wrong count rather than nothing. Settled by running each runner once on a small fixture and keeping the parse that works.

---

## Non-goals {#non-goals}

- **Changing the panel's look or the wire message.** The UI is the thing being generalized, not revised.
- **A plugin or scripting hook inside tugtool for custom parsers.** `--kind lines --item <regex>` plus the declared-runner table covers the long tail without a second language to learn.
- **Putting the call id into every Bash call's environment.** Considered as the way to make needles unnecessary; deferred, because its effect on the visible command text has not been assessed ([B08]).
- **Renaming the session-state `wedged`.** A different word in a different store ([F05]).
- **Live progress from `--kind junit`.** The document is written at exit; the kind is for the exact record, and a runner that can only emit junit sits on the band until a line parser exists for it.

---

## Exit {#exit}

An arc, walked in rung order, each rung landing as a working interface before the next starts:

1. **Rung 0** — the `[[tugtool.run.runner]]` table in `.tugtool/config.toml`, read by the hook beside the built-ins; the built-in list extended runner by runner, each against a fixture run; `tugtool run runners`.
2. **Rung 1** — `tugtool progress unit plan|start|done|finish`, with the thinning past 64 rows; the `stalled` rename and `wedged` alias across deck, verb and recipe; app-test ported onto the verb and `run-units.ts` deleted.
3. **Rung 2** — `test run --kind tap`, `--kind junit`, `--kind lines --item`.
4. **Rung 3 and the prompt** — nothing to build for bare counts; the prompt section in `tugplug/tool-calls.md` naming all four rungs and the row vocabulary, and `tugplug/CLAUDE.md`'s index line updated.

The verdict for the whole is a project that is not Tug: a scratch directory with a `pytest` or `go test` suite, no config, driven from a Session card, showing the panel on rung 0; then the same suite under an unknown runner shape, wrapped by hand on rung 2.

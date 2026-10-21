# The report interface

**Purpose:** A long Bash call draws a live panel when its command reports, and sits silent when it does not. The thing works and is loved; it now needs one name, a wider reach, a funnel that holds without the model remembering a rule, and a panel that says more with what it already knows.

---

## Purpose {#purpose}

The `run-report-ladder` arc (joined as `8c9cd29a18`) gave any project four ways to reach the panel: a known or declared runner, a loop reporting each item, a wrapped unknown runner, and a bare count. The user's words on seeing it: "I really love this work. I think it's great. I want to dig some more on specific areas to continue improving how this works."

Four areas were named:

1. Fix on a consistent name. The name is the **report**, and the rename is a real cutover with no aliases.
2. Find the other situations where a report belongs.
3. Expand and harden the guidance, the processing and the funneling, so that transcript content uses the report more completely and consistently.
4. Improve the interface itself, to make it more useful and legible.

The sketch that settled these is the conversation this brief is written from.

---

## Evidence {#evidence}

**[F01] One thing wears four names.** The deck calls it the run panel (`tugdeck/src/components/tugways/tug-run-panel.tsx`, `run-panel-model.ts`, `run-progress-store.ts`, CSS tokens `--tugx-run-*`). The CLI calls it progress (`tugtool progress`, `progress phase`, `progress unit`, `progress gaps`, state under `$TMP/tug-progress-unit`). The wire calls it `run_progress`. The config and the runner list call it run (`[[tugtool.run.runner]]`, `tugtool run runners`). The silence record is `run_gaps.db` with `TUG_RUN_GAPS_DB`. Only the recipe script, `tugrust/scripts/report-phase.sh`, already says report. Twenty-six files carry one of these names outside the briefs. **(verified)**

**[F02] The gaps record names where the silence is.** `tugtool progress gaps` on this machine, 2026-10-21:

| runs | total | head |
|---|---|---|
| 49 | 39m 03s | `tugtool file` |
| 41 | 72m 51s | `just app-test` |
| 10 | 6m 37s | `bunx tsc` |
| 8 | 32m 22s | `until grep` |
| 8 | 8m 10s | `bun test` |
| 8 | 5m 35s | `cargo clippy` |
| 3 | 20m 00s | `grep -rn` |
| 3 | 1m 55s | `cargo nextest` |

The threshold is `GAP_THRESHOLD_MS = 20_000` in `tugrust/crates/tugcore/src/run_gaps.rs`. **(verified)**

**[F03] A probe's inner command runs dark.** The hook classifies `tugtool file probe …` as a write (`tugrust/crates/tugtool/src/commands/hook.rs`, the `gesture_of` match on `file probe`), and the runner rewrite matches the heads of the line's simple commands, so the command after `probe … --` is an argument it never reads. A probe around `just app-test` therefore reports nothing for the test's whole length. Read from the code; the `tugtool file` row in [F02] is the corroboration, though that row also holds slow `file edit` calls, so not all of its 39 minutes are probes. **(verified by reading)**

**[F04] A heredoc on the line silences the whole call.** `simple_commands` returns `None` on a here-document, a `$(…)` or a backtick, and then nothing on the line is wrapped. The edit program is a heredoc, so "edit, then test, in one call" is the common shape that goes dark. The prompt already says to split them, and the `just app-test` and `bun test` rows in [F02] say the rule alone has not held. **(verified)**

**[F05] The tugproto decoder is stale.** `RunProgressFrame` in `tugproto/src/outbound-decoders.ts` declares `label`, `text`, `done`, `total`, `failures`, `at_ms` and `tug_session_id`, and neither `unit`, `jobs`, `units` nor `needles`. The deck's store reads those off the raw frame (`run-progress-store.ts`, `narrowRunUnits`), so the panel works and the shared type lies. **(verified)**

**[F06] A recipe lint already exists.** `scripts/recipe-lint.ts`, run by `just lint`, refuses a listed long recipe that neither reports nor delegates to something that does, with named exemptions. The sketch proposed inventing this; it is there, and its list is hand-kept rather than derived from recorded medians. **(verified)**

**[F07] `item` and `total` are validated on every runner row and used only on `lines` rows.** `RunConfig::validate` in `tugrust/crates/tugtool-core/src/config.rs` compiles the regexes for any row; `declared()` in `tugrust/crates/tugtool/src/runners.rs` keeps them only for `kind = "lines"`. A `kind = "junit"` row with an `item` is accepted and silently ignored. **(verified in the audit)**

**[F08] The `wedged` alias landed with the `stalled` rename.** The deck's `narrowRunUnits` reads `wedged` as `stalled`, and `LandedStatus` in `progress_unit.rs` carries `#[value(alias = "wedged")]`. The app-test ledger excludes `SKIP`, `WEDGED` and `STALLED`. Nothing writes `wedged` any more. **(verified in the audit)**

**[F09] The live hook is the app's own `tugtool`.** A Session card runs Tug.app's Release binary, so a hook change reaches a card only after `just app-debug`. The arc's verification ran the Rust function and a scratch project through the hook script, and no app-test drives a bare `pytest` or `node --test` through a Session card to the panel. **(verified)**

**[F10] Two kinds of silence sit in one table.** `until grep` is eight hand-written wait loops, 32 minutes of blank block. `grep -rn` is three calls totalling 20 minutes, a command whose honest median is under a second. The first wants a report; the second is a wedged call. The gaps table does not tell them apart. **(verified from [F02]; the medians are inference)**

**[F11] The recipe's text and the panel use two vocabularies.** The app-test summary prints `[PASS]`, `[FAIL]`, `OVERTIME` in capitals; the panel's rows say `pass`, `fail`, `error`, `stalled`, `skipped`. The same run is read in both places. **(verified)**

**[F12] The verdict band names the result and not the next act.** `verdictSentence` in `run-panel-model.ts` produces "2 of 25 files failed, 1 stalled · 1 skipped". The command that names the reds, `tugtool test last --failures`, lives only in the prose rule, and a model that has not read it re-runs the suite to see them. **(verified)**

**[F13] A nextest call is dark through its compile.** The runner wrapper reads test items; it reads nothing from cargo's `Compiling` lines, and the compile is often the longer half of the call. The `cargo clippy` and `bunx tsc` rows are the same shape: a check with no items and a known duration. **(verified by reading; durations from [F02])**

**[F14] The arc verbs report nothing.** `tugtool arc verify` runs the checks of several surfaces and prints a table at the end; `arc replay` has phases. The audit stage's verify was a silent two-minute block. **(verified)**

**[F15] Attachment is invisible.** A report with no exact id attaches to the single open run, else to the one run whose command contains a needle, else at card level. A report that lands at card level shows no reason, so a mis-attached report reads as a missing one. **(verified by reading `attach_run` in `ledger_entry.rs`)**

---

## Decisions {#decisions}

### The name

**[B01] The noun is the report, and the cutover is real: no aliases, no deprecation window.** A long call *reports*; what the block draws is the *report panel*; the four ways to reach it are the *report ladder*; the record of silence is *report gaps*. There are no installs in the wild and the recipes are ours, so every old spelling is removed in the same arc that adds the new one. An alias would be a second name for a thing this brief exists to give one name.

**[B02] The CLI verb is `tugtool report`, with four subverbs.** `tugtool report count` (today's bare `tugtool progress --done --total`), `tugtool report phase`, `tugtool report unit`, `tugtool report gaps`, and `tugtool report runners` (today's `tugtool run runners`). `tugtool progress` and `tugtool run` are deleted. The bare count moves under a subverb so the verb's shape is one noun and four verbs, with nothing special-cased at the top.

**[B03] `tugtool test run` keeps its name.** It wraps a test runner and records its result for `tugtool test last`; it is a thing that reports, not the report. Its `--label` and `--needle` flags stay.

**[B04] The config table is `[[tugtool.report.runner]]`.** `[[tugtool.run.runner]]` is refused with a `ConfigRefusal` naming the new table, not ignored, so a project that spelled it the old way learns at once.

**[B05] The wire frame is `report`.** `run_progress` becomes `report` in tugcast's writer, tugproto's decoder and the deck's store, the one place the three can be made to agree ([F05]). The decoder declares every field the frame carries, and a decoder test round-trips a unit frame so the type cannot drift again. Implementing: `needles` is a field of the request, read for attachment and never written to the frame, so the decoder declares `unit`, `jobs` and `units` and not `needles`; declaring a field the writer never writes would be the drift the test guards against, and the deck's store now derives its frame type from the decoder's.

**[B06] The deck files and tokens follow.** `tug-run-panel.tsx` and `.css` become `tug-report-panel.*`, `run-panel-model.ts` becomes `report-panel-model.ts`, `run-progress-store.ts` becomes `report-store.ts`, `--tugx-run-*` tokens become `--tugx-report-*`, and the `data-status` attributes keep their values. `tug-meta-run.*` is the session's meta-run card and is not this thing; it stays. Implementing: the same old name rode `run-progress-context.tsx`, the Bash block's `bash-run-panel` and `bash-run-strip` slots, and the `RunProgress*`, `TugRun*` and `runPanelModel` identifiers, so under [B01] they follow to `report-context.tsx`, `bash-report-*`, `Report*`, `TugReport*` and `reportPanelModel`; `RunUnit` and `narrowRunUnits` keep their names, a unit of a run being what they are.

**[B07] The records follow.** `run_gaps.rs` becomes `report_gaps.rs`, the file `report_gaps.db`, the env `TUG_REPORT_GAPS_DB`; the unit state dir becomes `tug-report-unit`, and the janitor sweeps both the new dir and the old. The old `run_gaps.db` is removed by the janitor rather than migrated: it is telemetry, and its rows are days old.

**[B08] The `wedged` alias goes with the cutover.** The deck reads only `stalled`, `LandedStatus` accepts only `stalled`, and the app-test ledger's exclusion keeps `WEDGED` only because old rows carry it. Nothing writes the word ([F08]), and [B01] says there are no aliases.

**[B09] The prompt section is "Every long call reports".** The section in `tugplug/tool-calls.md` is retitled to state the rule, and it opens with the test the model applies before a Bash call: *could this run twenty seconds? then which rung is it on?* The twenty seconds is the gaps threshold ([F02]), so the rule and the record agree. The earlier paragraph that names runners by hand is replaced with "a known or declared runner, which `tugtool report runners` lists".

### Where else a report belongs

**[B10] A probe reports its inner command.** The hook reads past `tugtool file probe … --` to the command it will run and applies the ladder to that command, in place, so a probe around `just app-test` or `cargo nextest run` draws as the bare call would. `probe` itself passes the call's id to its child. This erases the top row of [F02] and is one change.

**[B11] A wait is a report with no total.** `tugtool report wait --label <l> --until '<cmd>' [--every <secs>] [--for <secs>]` runs the loop itself, posts elapsed and the last probe's output as the text line, and exits 0 when the probe does and non-zero at the deadline. The prose rule's "one loop that checks the condition" points at this verb instead of a hand-written `until`.

Implementing: each probe posts with unit `probe` and `done` the probes run, so the wait draws on its block and the gaps record does not count the call as silent, which a report with no unit would; the probe runs through `sh -c`, and with no calling session the verb still waits and exits by the probe.

**[B12] cargo gets a built-in line reader for its compile.** `cargo build`, `cargo clippy`, `cargo check` are built-in runners of a new `cargo` kind that reads `Compiling <crate>` lines as units under a `compiling` phase, with the crate count as the total where cargo prints one. `cargo nextest run` and `cargo test` read the same lines before the first test, so a nextest call shows "compiling 1m 12s · running 14/312" instead of a blank first half ([F13]). `bunx tsc` and `bunx vite build` report a count when the tool prints one and a phase otherwise; they are added as built-ins of kind `lines` with the tool's own progress lines.

Implementing: `tsc` and `vite` are named kinds with their rules in the binary, tested against recorded output, rather than `lines` rows, because a built-in `lines` row would carry its regex on every rewritten command and nowhere a fixture could pin it; the purpose, reading the tool's own lines, is the same. cargo prints no crate count off a terminal, so a build's crates are counted as they start with no total; a crate that does not compile is the red, carrying the first error before it. Builds and checks record under their own suites, `cargo`, `tsc` and `vite`, so a check never stands as a directory's last test run.

**[B13] The arc verbs report.** `arc verify` posts one unit row per surface as it runs each, with the surface's check count; `arc replay` posts phases. Both use the report library in-process rather than shelling out to themselves.

Implementing: the engine runs under a watcher rather than knowing about reports — `verify_watched` tells it each surface as it is planned, starts and lands, and `replay_watched` each of its phases, `check`, `replay` and `land` — and `tugtool` turns those into `surface` rows (passed of checks carried, the failing check as a red row's title, a surface with no checks skipped as claimed and unchecked) and phase rows. A replay that conflicts lands its running phase red and skips the rest; one that defers lands it green and skips the rest.

**[B14] Samplers report a count.** The motion probes and frame recorders that run for a fixed count of frames or seconds call `report count` from their scripts. This is rung 4 and is one line each; the arc that walks this brief adds it to the ones that live under `tests/` and `tugrust/scripts/`.

Implementing: the samplers that run for a fixed time as a call of their own are the two that shell out to `/usr/bin/sample` — `app-inspect.sh sample` under `tugrust/scripts/` and `scripts/perf-resize-profile.sh`, which sits outside the two directories named but is the same sampler — and each now runs it through `tugrust/scripts/sample-reported.sh`, one line, which reports its seconds as a count with unit `second`. The frame recorders under `tests/` run inside an app-test file, whose run already reports that file as a row, so a count from inside one would be a second report for a span the file's row already covers; they are left as they are.

**[B15] A wedged call is not a gap.** `report gaps` keeps a median per head from its own rows and lists a head whose median is under the threshold and whose max is minutes under a separate heading, "stalled calls", not in the adoption list ([F10]). The adoption list is where the next runner pays; the stalled list is where a hang is.

Implementing: the gap rows alone cannot carry a median under the threshold — every one of them is a call that ran past it — so the record now keeps every foreground call's head and wall time in a second table, `call_times` (schema v2, a registered migration from v1), and a head's median is read from those, falling back to its gap rows when it has none. "Minutes" is a call of a minute or more (`STALLED_MAX_MS`). `--json` carries `gaps` and `stalled`, each line with `medianMs`, `maxMs`, `calls` and `declared`.

### The funnel

**[B16] The hook refuses a known runner behind a heredoc.** When the line holds a heredoc, a `$(…)` or a backtick *and* a known or declared runner head appears in it, the hook denies the call with a refusal that names the split: the edit in one call, the run in the next. A refusal is the correction mechanism the file-editing gate already uses and the model already follows ([F04]); a warning the model may not read is weaker. A line with a heredoc and no runner in it is untouched.

Implementing: the head is read where a shell would run it — at a command position, past assignments and a probe's `--`, outside any here-document body — because the rule is for a run that goes dark, and a body is data: an edit program whose body mentions `cargo test` is not refused, while `tugtool file edit <<'EOF' … EOF` followed by `cargo test` on the next line is. The refusal names the runner, whether it is built in or the project's, the construct that hides it, and the split; it outranks the prefix approval, so `tugtool` at the line's head does not let the run through.

**[B17] Every Bash call carries its id.** The hook prefixes every readable Bash call with `export TUG_TOOL_USE_ID=<id>; `, so a rung-2 script, a nested `just`, a probe's child, and the `report wait` verb all attach exactly. The single-open-run and needle fallbacks stay for a call that was not readable or a command typed by hand. The command-head reader in the gaps record and the attribution grammar skip the prefix, and the deck's Bash block elides its own id's prefix from the command it displays, so the header shows what the model wrote. This is the deferred [B08] of the ladder brief, taken.

**[B18] A runner row that cannot be honoured is refused.** `item`, `total` or `stream` on a row whose kind is not `lines` is a `ConfigRefusal` ([F07]). A `unit` row and a `kind` row with the same `match` is a refusal. The refusal text says which flag belongs to which kind.

Implementing: any two rows with the same `match` are refused, not only a `unit` and a `kind` pair, because the hook honours one row per head whichever kinds they carry; `match` is compared with its whitespace collapsed. The loader's refusal is what `tugtool report runners` shows, and the hook falls back to the built-ins for a project whose config is refused, as it always did.

**[B19] A declared runner that still runs dark is named.** `report gaps` cross-reads the merged runner list and marks a gap row whose head matches a declared or built-in runner as "declared, still silent", which is either a heredoc call ([B16] will have refused it) or a row that lies. The app-test row in [F02] is this case today.

Implementing: a two-word head cannot be matched against a three-word runner (`cargo nextest run`), so the match reads the head's latest command, past the call-id export, `cd … &&` and assignments, against the runner table of the project that command ran in.

**[B20] The recipe lint derives its list.** `scripts/recipe-lint.ts` keeps its named exemptions and adds, to its hand list, every recipe head the gaps record shows with a median over the threshold, read through `tugtool report gaps --json` ([F06]). A recipe that grew slow is caught without anyone adding it.

Implementing: only the gaps list is read, not the stalled calls; a head whose recipe this Justfile does not have is another project's and is skipped; and a machine with no `tugtool` or no record, or a `tugtool` that reports no medians, derives nothing, so the lint never fails for want of telemetry.

**[B21] One app-test drives the live hook.** A Session card runs a bare `node --test` over a two-test fixture and the test asserts the report panel appears on the block with two rows. It runs under the app-test recipe and so against the app's own `tugtool` ([F09]); it is the test that would have found "needs `just app-debug`".

Implementing: a Bash block exists only for a model's call, and a real claude turn is gated off any derived selection, so the call comes from a stub tugcode playing one turn through the real feed: tugcast sees the `tool_use` open a run exactly as a model's would. The bundle's own `hooks/pre-tool-use.sh` is then handed Claude Code's payload, and its rewritten command runs with the session's id, so the bundle's `tugtool test run` reports to the instance under test and attaches by the call's id. Claude applying `updatedInput` is the one link not driven, and it is Claude Code's contract. A test run lists only its reds, so a green two-test run has no rows to count: the check is the settled strip's PASS over `2/2 tests` and the finished panel on expand. The app under test is the app-test bundle, rebuilt by `just app-test-build`, which is the recipe's own stand-in for `just app-debug`.

### The panel

**[B22] The verdict band names the next act.** A red verdict carries the one command that names the reds: `tugtool test last --failures` for a unit suite, "see the Failures section" for an app-test run. The model reads it off the block instead of re-running ([F12]).

Implementing: the act is chosen by the run, not guessed per block — the `app-test` label points at its Failures section, any other run counting tests or files (which went through `tugtool test run` and was recorded) at `tugtool test last --failures`, and a run counting anything else (phases, crates, surfaces) shows its reds inline and names no act.

**[B23] A green row carries its history too.** A row that was red in a recent recorded run and is green now says "recovered" beside its time, with the same history line a red row gets. A flake is as interesting as a failure.

Implementing: "red in a recent recorded run" is the history verb's `red-streak` answer — the file's recorded runs end red — asked of the green files in one more `apptest history` call, only when the run has a block to draw on. The recipe amends only those rows, so the panel reads any green row carrying a history line as recovered; it stands open under the verdict like a red card, edged green, and the verdict counts it.

**[B24] Expected time is drawn.** The bar carries a tick at the projected end from the rows' medians, and the panel's line says "~2m left · 3 unknown" while it runs. The app-test recipe already computes this; the panel gets it from `median` on the rows it holds.

Implementing: the bar counts units, so its end is always the last unit; the tick is drawn where the run would stand had it kept to its medians — the share of its expected wall time (spent, from the earliest row start, plus the projection) already spent — so a fill behind the tick is a run slower than its record. "Unknown" counts the units still to land that carry no median, which the projection takes at the typical one.

**[B25] Phases and units share one panel.** A run may carry phase rows above its unit rows: cargo's compile ([B12]) and the app-test build before its files. The panel draws the phase band first, then the unit rows, one block.

Implementing: the two arrive as two reports on one call under two labels — a `report phase` run and a unit run — so the store keeps the unit run as the entry and the phase rows beside it, whichever came first; a phase still marked running is drawn landed once the first unit has begun. cargo's compile is a line, not phase rows ([B12]'s reading), so the build-before-files case is the one this draws today.

**[B26] A finished report folds on green and holds on red.** A green run collapses to one line, count and time, which opens on click. A red run stays open with the red rows pinned above the rest and the first failure's title and message inline, so the block reads top to bottom.

Implementing: the fold is the shell block's own collapse, which is how a Bash block mounts, and its collapsed face is the report strip. A green strip is now the masthead alone — verdict word, label, count, tally, wall time on one line — and the block's disclosure opens the full panel. A red strip keeps the track and the most recent red open with its first failure, the earlier reds folded under it; expanded, the reds lead the body under the verdict, as they already did.

**[B27] Attachment is visible.** A report that lands at card level shows a faint "unattached" tag with its label; in a debug build the tag's title gives the reason the attachment rules produced ("no open run", "two candidates") ([F15]).

Implementing: tugcast puts the reason on the card-level frame as `unattached` — "no open run", "N candidates, no needle matched", or "N candidates matched its needles" — read off the open runs after the attach rule answers none. The tag stands before the card's report line on the JOBS placard, and its title carries the reason on a Vite or test-mode deck, the same gate the test surface uses, since a debug Tug.app serves the deck that way.

**[B28] Gaps are in the card.** The Session card's diagnostics popover lists this session's dark calls, head and time, read from the gaps record, so the adoption loop is visible to the user and not only to a model that remembers to ask.

Implementing: the Session card has no diagnostics popover; the JOBS placard is where the card's run reports already live, so the dark calls are a "Dark calls" group there. tugcast serves them at `GET /api/report-gaps?session=<id>` (loopback, read-only, newest 20, keyed by the card's session id, which is what the record stores), and the deck reads the route each time the placard opens.

**[B29] One vocabulary, one case.** The app-test summary's text report prints `pass`, `fail`, `error`, `stalled`, `skipped` in the per-file table and the progress lines, the panel's words. `OVERTIME` stays as the recorded reason on a row's message ("stopped at 20 s") and stops being a status word ([F11]).

Implementing: the row codes in the run directory, the results ledger and `TUG_APPTEST_JSON` keep their capitals; only the printed word changes. An OVERTIME file prints `fail`, its table row says `stopped at 20s` or `over the 20s budget`, and its progress line keeps the reason it already gave.

---

## Open Questions {#open-questions}

- **Whether the hook can carry a message to the model without denying.** [B16] chooses a refusal because the gate's refusal path is proven. If the capabilities capture shows a PreToolUse hook can attach context to an allowed call, the same detection could warn once and allow, and the choice is worth revisiting then. It does not change what is built first.

---

## Non-goals {#non-goals}

- **No aliases, no deprecation period.** Considered and rejected by the user: "cut the names over for real". Old spellings are removed or refused, never accepted quietly.
- **Not a rename of `tugtool test run`.** It is a runner wrapper and keeps its name ([B03]).
- **Not a rename of the session's meta-run card.** `tug-meta-run.*` is a different thing.
- **Not a migration of old telemetry.** `run_gaps.db` is dropped, not carried ([B07]).
- **Not dotnet, rspec or phpunit built-ins.** Still follow-ons; nothing in [F02] asks for them.
- **Not a change to the wire's transport.** The frame is renamed; how it travels on `/api/session` is untouched.

---

## Exit {#exit}

An arc. The order that matters:

1. The rename, whole, in one round: CLI verb and subverbs, config table, wire frame and decoder, deck files and tokens, records and env, the `wedged` alias, the prompt section, `CLAUDE.md`'s ledger paragraph and the recipe lint's strings. Every check green before anything else moves, because everything after it spells the new names.
2. The id in every call and the probe's inner command ([B17], [B10]), which share the hook's rewrite path.
3. The heredoc refusal and the runner-row refusals ([B16], [B18]).
4. The new reporters: wait, cargo and the checks, the arc verbs, the samplers ([B11]–[B14]).
5. The gaps record's two lists, the declared-still-silent mark, the derived recipe list ([B15], [B19], [B20]).
6. The panel ([B22]–[B29]), each a small deck change over the store the rename settled.
7. The live-hook app-test ([B21]) last, after `just app-debug`, since it is the one check that needs the rebuilt app.

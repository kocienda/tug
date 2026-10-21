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

**[B05] The wire frame is `report`.** `run_progress` becomes `report` in tugcast's writer, tugproto's decoder and the deck's store, the one place the three can be made to agree ([F05]). The decoder declares every field the frame carries, and a decoder test round-trips a unit frame so the type cannot drift again.

**[B06] The deck files and tokens follow.** `tug-run-panel.tsx` and `.css` become `tug-report-panel.*`, `run-panel-model.ts` becomes `report-panel-model.ts`, `run-progress-store.ts` becomes `report-store.ts`, `--tugx-run-*` tokens become `--tugx-report-*`, and the `data-status` attributes keep their values. `tug-meta-run.*` is the session's meta-run card and is not this thing; it stays.

**[B07] The records follow.** `run_gaps.rs` becomes `report_gaps.rs`, the file `report_gaps.db`, the env `TUG_REPORT_GAPS_DB`; the unit state dir becomes `tug-report-unit`, and the janitor sweeps both the new dir and the old. The old `run_gaps.db` is removed by the janitor rather than migrated: it is telemetry, and its rows are days old.

**[B08] The `wedged` alias goes with the cutover.** The deck reads only `stalled`, `LandedStatus` accepts only `stalled`, and the app-test ledger's exclusion keeps `WEDGED` only because old rows carry it. Nothing writes the word ([F08]), and [B01] says there are no aliases.

**[B09] The prompt section is "Every long call reports".** The section in `tugplug/tool-calls.md` is retitled to state the rule, and it opens with the test the model applies before a Bash call: *could this run twenty seconds? then which rung is it on?* The twenty seconds is the gaps threshold ([F02]), so the rule and the record agree. The earlier paragraph that names runners by hand is replaced with "a known or declared runner, which `tugtool report runners` lists".

### Where else a report belongs

**[B10] A probe reports its inner command.** The hook reads past `tugtool file probe … --` to the command it will run and applies the ladder to that command, in place, so a probe around `just app-test` or `cargo nextest run` draws as the bare call would. `probe` itself passes the call's id to its child. This erases the top row of [F02] and is one change.

**[B11] A wait is a report with no total.** `tugtool report wait --label <l> --until '<cmd>' [--every <secs>] [--for <secs>]` runs the loop itself, posts elapsed and the last probe's output as the text line, and exits 0 when the probe does and non-zero at the deadline. The prose rule's "one loop that checks the condition" points at this verb instead of a hand-written `until`.

**[B12] cargo gets a built-in line reader for its compile.** `cargo build`, `cargo clippy`, `cargo check` are built-in runners of a new `cargo` kind that reads `Compiling <crate>` lines as units under a `compiling` phase, with the crate count as the total where cargo prints one. `cargo nextest run` and `cargo test` read the same lines before the first test, so a nextest call shows "compiling 1m 12s · running 14/312" instead of a blank first half ([F13]). `bunx tsc` and `bunx vite build` report a count when the tool prints one and a phase otherwise; they are added as built-ins of kind `lines` with the tool's own progress lines.

**[B13] The arc verbs report.** `arc verify` posts one unit row per surface as it runs each, with the surface's check count; `arc replay` posts phases. Both use the report library in-process rather than shelling out to themselves.

**[B14] Samplers report a count.** The motion probes and frame recorders that run for a fixed count of frames or seconds call `report count` from their scripts. This is rung 4 and is one line each; the arc that walks this brief adds it to the ones that live under `tests/` and `tugrust/scripts/`.

**[B15] A wedged call is not a gap.** `report gaps` keeps a median per head from its own rows and lists a head whose median is under the threshold and whose max is minutes under a separate heading, "stalled calls", not in the adoption list ([F10]). The adoption list is where the next runner pays; the stalled list is where a hang is.

### The funnel

**[B16] The hook refuses a known runner behind a heredoc.** When the line holds a heredoc, a `$(…)` or a backtick *and* a known or declared runner head appears in it, the hook denies the call with a refusal that names the split: the edit in one call, the run in the next. A refusal is the correction mechanism the file-editing gate already uses and the model already follows ([F04]); a warning the model may not read is weaker. A line with a heredoc and no runner in it is untouched.

**[B17] Every Bash call carries its id.** The hook prefixes every readable Bash call with `export TUG_TOOL_USE_ID=<id>; `, so a rung-2 script, a nested `just`, a probe's child, and the `report wait` verb all attach exactly. The single-open-run and needle fallbacks stay for a call that was not readable or a command typed by hand. The command-head reader in the gaps record and the attribution grammar skip the prefix, and the deck's Bash block elides its own id's prefix from the command it displays, so the header shows what the model wrote. This is the deferred [B08] of the ladder brief, taken.

**[B18] A runner row that cannot be honoured is refused.** `item`, `total` or `stream` on a row whose kind is not `lines` is a `ConfigRefusal` ([F07]). A `unit` row and a `kind` row with the same `match` is a refusal. The refusal text says which flag belongs to which kind.

**[B19] A declared runner that still runs dark is named.** `report gaps` cross-reads the merged runner list and marks a gap row whose head matches a declared or built-in runner as "declared, still silent", which is either a heredoc call ([B16] will have refused it) or a row that lies. The app-test row in [F02] is this case today.

**[B20] The recipe lint derives its list.** `scripts/recipe-lint.ts` keeps its named exemptions and adds, to its hand list, every recipe head the gaps record shows with a median over the threshold, read through `tugtool report gaps --json` ([F06]). A recipe that grew slow is caught without anyone adding it.

**[B21] One app-test drives the live hook.** A Session card runs a bare `node --test` over a two-test fixture and the test asserts the report panel appears on the block with two rows. It runs under the app-test recipe and so against the app's own `tugtool` ([F09]); it is the test that would have found "needs `just app-debug`".

### The panel

**[B22] The verdict band names the next act.** A red verdict carries the one command that names the reds: `tugtool test last --failures` for a unit suite, "see the Failures section" for an app-test run. The model reads it off the block instead of re-running ([F12]).

**[B23] A green row carries its history too.** A row that was red in a recent recorded run and is green now says "recovered" beside its time, with the same history line a red row gets. A flake is as interesting as a failure.

**[B24] Expected time is drawn.** The bar carries a tick at the projected end from the rows' medians, and the panel's line says "~2m left · 3 unknown" while it runs. The app-test recipe already computes this; the panel gets it from `median` on the rows it holds.

**[B25] Phases and units share one panel.** A run may carry phase rows above its unit rows: cargo's compile ([B12]) and the app-test build before its files. The panel draws the phase band first, then the unit rows, one block.

**[B26] A finished report folds on green and holds on red.** A green run collapses to one line, count and time, which opens on click. A red run stays open with the red rows pinned above the rest and the first failure's title and message inline, so the block reads top to bottom.

**[B27] Attachment is visible.** A report that lands at card level shows a faint "unattached" tag with its label; in a debug build the tag's title gives the reason the attachment rules produced ("no open run", "two candidates") ([F15]).

**[B28] Gaps are in the card.** The Session card's diagnostics popover lists this session's dark calls, head and time, read from the gaps record, so the adoption loop is visible to the user and not only to a model that remembers to ask.

**[B29] One vocabulary, one case.** The app-test summary's text report prints `pass`, `fail`, `error`, `stalled`, `skipped` in the per-file table and the progress lines, the panel's words. `OVERTIME` stays as the recorded reason on a row's message ("stopped at 20 s") and stops being a status word ([F11]).

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

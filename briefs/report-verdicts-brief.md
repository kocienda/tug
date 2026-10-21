# Long calls report their verdict, in the foreground, with nothing to recover

**Purpose:** The report interface landed in `report-interface`, but three habits still leave the user watching a dark block and the model saying it cannot see what it ran. `arc verify` runs its checks with no report, the model backgrounds builds and test runs, and it tails the output it needed and then calls the result unavailable.

---

## Purpose {#purpose}

The user's notes, after auditing the `report-interface` arc:

- "Tests run via `tugtool arc verify` are not being included in the report interface and it must be."
- "Tests and builds really shouldn't be run in the background, as this frustrates the ability for the report interface to keep the user apprised on the progress of the work."
- "Many times I see comments in the transcript about how: 'report data is unavailable', and 'I truncated the results so I can't see what I need'. This is *ludicrous*. We are in full control of the commands that we run. We must *know* when we're beginning a time-consuming process that we need to glean salient data from the work."

The report ladder in `tugplug/tool-calls.md` already says every long call reports. What it does not yet say, and what the tree does not yet enforce, is that the call is written so its data is where a cheap read finds it afterwards, that a build or a test run stays in the foreground where its block can draw, and that a verb which runs other runners reports for them.

---

## Evidence {#evidence}

**[F01] `arc verify` reports at the surface grain and no finer** — `run_verify` in `tugrust/crates/tugtool/src/arc.rs` posts one row per surface under label `arc verify`, unit `surface`, as each surface starts and lands (`SurfaceReport` in `report_unit.rs`). Each surface's checks run through `Command::new("sh").arg("-c")` in `tugarc_core::surfaces::run_plans` (`surfaces.rs:366`), inside tugtool, where no PreToolUse hook sees them. So `cargo clippy`, `cargo nextest run`, `bunx tsc`, `bunx vite build` and the 5½-minute `bun test` each run dark under a single `running` row with no count, no bar and no reds as they land. **(verified)**

**[F02] A child that does report replaces the verify report whole** — `just app-test-changed {paths}` runs the recipe, which posts `report unit` rows under label `app-test`, unit `file`, with the inherited `TUG_TOOL_USE_ID`. The deck store (`tugdeck/src/lib/report-store.ts`) treats a report under another label as a whole replacement unless one side is a `phase` run, so the block flips between the surface table and the app-test rows and shows whichever posted last. **(verified)**

**[F03] A red surface says "red" and nothing else** — `SurfaceResult` carries `exit_code` per command and no count, no failing test and no first failure. The child's output goes to the block's stdout and is the only place the detail lives. **(verified)**

**[F04] The harness moves a foreground call to the background at 120 s** — a foreground Bash call has a default 120 s budget; past it Claude Code moves the call to the background on its own and says "Command did not complete within its 120s timeout and was moved to the background … Output is being written to: …". That happened in this project's recent sessions, including a `grep` in this one. The foreground `timeout` argument caps at 600000 ms. **(verified, from the harness's own message and tool description)**

**[F05] The model chooses the background for builds and test runs** — across the last 25 sessions in this project, 62 Bash calls carried `run_in_background: true`, nearly all `cargo nextest run`, `cargo build`, `bun test` and `tugtool arc verify`, and nearly all piped to `tail`. **(verified, counted over the transcripts)**

**[F06] The model tails the verdict** — in the same sessions almost every `cargo nextest run` and `bun test` ended in `| tail -N`, and `cargo build` was piped to `grep -E '^(error|warning)' -A 6 | head -80`. When a failure's detail lies above the window, or the error takes a shape the filter did not guess, the model has thrown away the thing it ran the call for, and the transcript says the data is unavailable. **(verified)**

**[F07] The record already exists for tests and not for builds** — `tugtool test run` records the result so `tugtool test last --failures` can name the reds after a tailed run. The hook wraps a known runner where it stands, including one piped into `tail`. A wrapped `cargo build` reports crates and the first error on the block, but nothing records it, so a tailed red build has no `last` to read. **(verified)**

**[F08] The hook ignores `run_in_background` and `timeout`** — `hook.rs` copies both fields through unchanged in `updatedInput` and decides nothing on them. **(verified)**

**[F09] Why the model backgrounds** — the reasons, as the model reports them: the 120 s cliff in [F04] teaches it to pre-empt the move; the foreground ceiling of ten minutes cannot be known to fit before launch; the Bash tool's own text sells a background call as one that "keeps running across turns and re-invokes you"; the arc doctrine's "do the work you can do" and "the user is not watching in real time" make waiting read as wasted turns; and a long foreground call's whole output lands in context. In Tug every one of these is backwards: a background call draws no live block, the report frames have no open call to attach to, and the output file is read after the fact, which is where [F06]'s complaints come from. **(inference, from the harness text and the model's own account)**

---

## Decisions {#decisions}

**[B01] `arc verify` wraps its own children, in-process, as the hook would.** `run_plans` knows each command's text before it spawns it. It resolves the command against the same runner table the hook reads, built-ins and `[[tugtool.report.runner]]` rows, and wraps it the same way: a known kind gets `tugtool test run` with that kind, a declared `unit` runner gets the call id it already inherits, a bare `cargo build` gets the crate reader. The resolver moves from `tugtool`'s hook into a place `tugarc-core` can reach, or verify takes a wrapping closure from `tugtool`, whichever keeps `tugarc-core` free of hook knowledge. This rules out a second runner table and rules out verify reporting less than a hand-typed call would.

**[B02] Reports nest: a run opened under another label while a parent run holds the block becomes the parent's child rows.** The store gains a third relation beside "replace" and "phases beside units". A parent is any unit run that declares itself one (verify does; a loop of runners may), and a child report under a different label attaches to the parent's running row. The panel draws the parent band with the active child's rows beneath it. This generalizes past verify to `just test` and any `report unit` loop whose items are themselves runners.

**[B03] The surface row carries its child's verdict.** `SurfaceResult` and the `surface` unit row gain `passed`, `total` and the first failure's `title` and `message` from the wrapped child, so a red verify names the test on the block and in `print_verify`'s table, not just "red".

**[B04] Every wrapped child of a verify records under the call, and `tugtool test last --failures` reads them all.** `test last` keyed on the call id lists every red across every surface of one verify, in surface order. The record is the retrieval path after a tailed or truncated verify, never a rerun.

**[B05] A build or a test run never runs in the background, and the hook enforces it.** `tugplug/tool-calls.md` states the rule beside the twenty-second test: the answer to "could this run twenty seconds?" is a report and a foreground `timeout`, never `run_in_background`. The PreToolUse hook denies `run_in_background: true` on a call whose line holds a known or declared runner, naming the `timeout` to pass instead, in the same place it refuses a dark runner. The exception is narrow and stated: a server, watcher or sampler meant to outlive the call is background work.

**[B06] The hook supplies the foreground timeout for a known runner.** For a wrapped runner the hook sets `updatedInput.timeout` from the suite's recorded median with a margin, clamped to the harness ceiling, when the call passed none or passed less. This removes the 120 s cliff from every runner the hook knows, so the model never has to guess and the harness never moves a reporting call out from under its block.

**[B07] A red build is recorded like a red test run.** The cargo reader records the first error per crate, and `tugtool test last --failures` names a red build's errors after the fact. The same retrieval path serves `tsc` and `vite build`.

**[B08] A wrapped run ends with its verdict line, and that is the contract a tail relies on.** Every `tugtool test run` already prints a closing `[test] …` line with the count and a pointer at `test last`. The doctrine says it: a long call's last line is its summary, so `tail -3` is always enough, and anything the tail hid is in the record. Tail the screen, never the record.

**[B09] The hook refuses a guessing filter on a runner.** A known or declared runner piped into `grep` or `head` before its exit is a filter that can hide a red and flip the exit status. The hook denies it with the `tail` form as the correction, the same way it corrects a dark runner.

**[B10] The doctrine gains one sentence that the rest rests on.** In `tugplug/tool-calls.md`: the model should never need to recover data after a long call, because the call was written to put the data where a cheap read finds it. The ladder, the foreground rule and the record are the three pieces of that sentence.

---

## Open Questions {#open-questions}

- Whether a PreToolUse hook can attach a warning without denying, so [B05] and [B09] can warn-and-allow once instead of refusing. Carried from the `report-interface` brief; refuse until it is answered.
- Whether `test last` should default to the current session's latest verify when one exists, or need the call id. Settle by reading how `test last` resolves a suite today.

---

## Non-goals {#non-goals}

- **Making verify spawn the hook.** The hook is a PreToolUse protocol over JSON; running it in-process for every child is the wrong shape. The resolver is shared, the protocol is not.
- **A new runner table for verify.** One table, read by both.
- **Changing the Bash tool's 120 s default or ten-minute ceiling.** Those are the harness's. [B06] works inside them.
- **Backgrounding servers and watchers.** They stay background; the rule is about builds and test runs.
- **Teaching the model to read output files after a background move.** The move is what [B05] and [B06] prevent.

---

## Exit {#exit}

An arc. The rough order:

1. Record red builds and extend `test last` to read them, and settle the call-id keying ([B04], [B07]).
2. Share the runner resolver between the hook and verify, and wrap verify's children ([B01]).
3. Nest child reports under a parent run in the store and panel, and carry the child's verdict onto the surface row ([B02], [B03]).
4. Hook refusals for background runners and guessing filters, and the supplied timeout ([B05], [B06], [B09]).
5. The doctrine in `tugplug/tool-calls.md` ([B08], [B10]), landed with the hook changes so the rule and the gate say the same thing.

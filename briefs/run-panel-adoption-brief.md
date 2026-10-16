# Run panel adoption

**Purpose:** The Bash block's run panel (`c2db8d010`) draws only for runs that report with `--unit`. Today that means two recipes and a wrapper. The most common long run, a test runner the model types itself, never reports, and nothing makes a new long run report.

---

## Purpose {#purpose}

After the run panel rolled out, the user asked: "how can we *ensure* this new progress interface is employed and called for the topics/circumstances that it covers?"

The panel exists, but using it is opt-in and hand-wired. A run shows the panel only because someone remembered to wire the report in. The work here is to make reporting the default for every long run Tug can recognise, to make a missing report visible, and to make it cheap where hand-wiring is still needed.

---

## Evidence {#evidence}

**[F01] Coverage today is three hand-wired producers.**
- `just app-test` (via `tests/app-test/scripts/app-test.sh` and `run-units.ts`) reports with `--unit file`.
- `just build-app` (the `report_phase` function in `Justfile`) reports with `--unit phase`.
- `just test-rust` and `just test-ts` go through `tugtool test run`, which reports with `unit: "test"`, carrying only the reds.

Found by grepping `Justfile`, `tests/app-test/scripts`, `tugrust/scripts`, `tugplug` and `tuglaws` for `progress --` and `test run`. **(verified)**

**[F02] Two recipes report the old way, with no unit.** `just test-swift` and `just test-standalone` each send one `progress … -- running` line before they start. They show the old band, never the panel. **(verified)**

**[F03] Most long recipes report nothing.** `build`, `app-debug`, `app-release`, `wasm`, `release`, `dmg`, `notarize`, `golden` and `tugmark-fuzz` never call `tugtool progress`. **(verified)**

**[F04] The commonest long run never reports.**
- `CLAUDE.md` ("Run Rust tests with: `cd tugrust && cargo nextest run`") and `tuglaws/arc-supplement.md` both tell sessions to run `cargo nextest run` directly.
- Nothing wraps that call, so the block shows only its raw stream.
- The same holds for a bare `bun test`.

**(verified)** for the instructions and the missing wrapper. That this is the most frequent long call is inference; [B04]'s record would confirm it.

**[F05] Every Bash call in every project already passes a hook Tug ships.**
- `tugplug/hooks/hooks.json` routes `Bash` through `pre-tool-use.sh` into `tugtool hook pre-tool-use` (`tugrust/crates/tugtool/src/commands/hook.rs`).
- Today the hook only allows or denies. `Decision::render` emits `permissionDecision` and a reason, and nothing else.

**(verified)**

**[F06] Claude Code's PreToolUse output can carry an `updatedInput`, and the hook payload carries the call's `tool_use_id`.**
- `updatedInput` would let the hook rewrite the command it approves.
- From Claude Code's hook contract, **not verified in this checkout**. Confirm both with one capture of a real payload and output before building on them.

**[F07] Attaching a report to its block is a guess unless the run knows its call.**
- `progress.rs::tool_use_id()` reads `TUG_TOOL_USE_ID` or `CLAUDE_CODE_TOOL_USE_ID`. The comment says this is "the day one is exported".
- Neither is set today, so tugcast attaches a report to the right Bash block by matching needles (`attach_run` in `agent_supervisor/ledger_entry.rs`) against the command text.

**(verified)**

**[F08] `tugtool test run --kind nextest` refuses to start without `--junit`.** Its tally comes from the junit document. So wrapping an arbitrary `cargo nextest run` has to supply a junit path the user's nextest config may not have. **(verified, in `test_run.rs`)**

**[F09] Bun runs get no track, even though their total is known from history.**
- `recorded_total` fetches the last recorded test count for a bun suite.
- `report_of` uses that count only in the line's text, never as `total`.
- So the panel model has `total` unknown and draws no track.

**(verified)**

**[F10] Nothing records a long call that went unreported.**
- tugcast sees every Bash `tool_use` and `tool_result`, and every `run_progress` report and the block it attaches to.
- So whether a long call got a report is decidable there, but nothing records it.

**(verified that the facts flow through tugcast; no record exists)**

**[F11] `build-app` builds its phase rows as JSON by hand in bash.** About 25 lines, including timing state. That shape is too costly to copy into seven more recipes. **(verified)**

---

## Decisions {#decisions}

**[B01] Reporting is made automatic where Tug can recognise the run, and required where it can't.** Writing down "please report" is the weakest lever. It needs every session and every recipe author to remember, which is how [F02]–[F04] came about. The layers below go strongest first. Documentation is the last resort, not the mechanism.

**[B02] The PreToolUse hook rewrites recognised test runners to run inside `tugtool test run`.**
- **Which calls:** `cargo nextest run`, `cargo test` and `bun test`, at the head of a command, possibly after a `cd … &&` prefix.
- **How:** through `updatedInput` ([F05], [F06]).
- **Where it applies:** every project, standalone ones included, with no model attention.
- **Exit status and output:**
  - The wrap keeps the call's exit status and passes stdout and stderr through unchanged, as `test run` already does for the recipes.
  - A wrap that would change either is a defect, not a trade-off.
- **What it leaves alone:** a command that already goes through `tugtool test run` (or `just test-*`), so nothing is wrapped twice.
- **Pipelines:** a command where the runner sits mid-pipeline is left alone. The wrap doesn't attempt shell parsing beyond the head of the command.

**[B03] A wrapped run attaches by the call's id, not by needles.**
- The hook knows the `tool_use_id` ([F06]) and puts it in the rewritten command, as `TUG_TOOL_USE_ID=<id>` or a `--tool-use-id` flag.
- So the report lands on its own block exactly ([F07]).
- Needles stay as the fallback for runs the hook didn't rewrite.

**[B04] tugcast records every long Bash call that ended without a unit report, and `tugtool progress gaps` lists them.**
- **What counts:** a call over a threshold, initially 20 s, that ends with no `run_progress` carrying `unit` attached.
- **What is recorded:** one row, with the command head (first two words, or the recipe name after `just`), the project and the wall time.
- **What the verb shows:** the heads ranked by count and total time.
- **Why:** this is the feedback loop that says where adoption is due next, instead of guessing ([F10]).
- **Write rules:** recording is telemetry. A failed write is logged, never surfaced, and never touches the call. The record follows the ledger rules: it lives under the shared directory, goes through `tugcore::ledger_db`, has bounded retention, and has a redirect env var for test isolation.

**[B05] Recipes report phases through one verb, and the phase rows are tugtool's to build.**
- **The verb:** something like `tugtool progress phase <label> <n> <name> [--of <names…>]`.
- **What it keeps:** the run's phase state (names, start times, landed times) in a small file keyed by the label and the calling session. It builds and posts the rows itself.
- **What a recipe writes:** one line per phase.
- **Migration:** `build-app`'s hand-rolled `report_phase` ([F11]) moves to the verb first, and it is the proof that the verb covers the shape.

**[B06] `just lint` refuses a long recipe that doesn't report with a unit.**
- **The check:** a recipe check, alongside `tugplug-lint`, that reads `Justfile`.
- **What each listed recipe must do:** call `tugtool progress` with `--unit`, `tugtool progress phase`, or `tugtool test run`, or else delegate to a recipe that does.
- **What is listed:** the long recipes of [F03] plus `test-swift` and `test-standalone` ([F02]).
- **Exemptions:** a named list in the check. Each entry carries a one-line reason, because a bare exemption is how the coverage decays again.

**[B07] Projects declare runners the hook can't recognise in `.tugtool/config.toml` under `[tugtool.runs]`.**
- **What a declaration is:** a command prefix mapped to how it reports: a `test run` kind, or "phase" with named phases.
- **Who reads it:** the hook, so the wrap of [B02] extends to `npm test`, `pytest` or `xcodebuild` without a code change.
- **Docs:** a short `tugplug/` doc covers the rest, for a script that wants to report its own units through `tugtool progress --unit`. The doc ships in the bundle per the standalone contract.

**[B08] Bun runs use their recorded total as the track's total, marked as an estimate.** [F09] already fetches the number. Using it as `total` gives bun runs a band track, which the panel already draws for partial unit lists. If the live count passes the recorded total, the total follows the count. That counts as an estimate drifting, not an error.

**[B09] The order is [B02]+[B03] and [B04] first, then [B05]+[B06], then [B07].**
- **First:** [B02]+[B03] covers the largest gap ([F04]) everywhere at once, and [B04] measures what it misses.
- **Second:** [B05]+[B06] tidies this checkout's recipes.
- **Last:** [B07] waits until a standalone project needs it, so its config is shaped by a real runner rather than imagined ones.
- **[B08]** is small and independent, so it can land wherever it fits.

---

## Open Questions {#open-questions}

- **The junit path a wrapped nextest call should use ([F08]).**
  - Options:
    - Inject a `--profile` that names a junit output under a temp path. This needs a profile the user's `.config/nextest.toml` may not define.
    - Teach `test run --kind nextest` to tally from nextest's own line output when there's no junit, as it already does for bun.
  - The second keeps the wrap free of any project config. Settle it by reading how much of the tally the line stream actually carries.
- **Whether `updatedInput` shows the rewritten command in the transcript.** If the block displays the rewritten command, the header shows the wrapper instead of what the model typed. The fix then is to wrap invisibly, for example by exporting through the environment rather than prefixing. One captured round trip ([F06]) answers this.
- **The threshold and heads in [B04].** 20 s and "first two words" are starting values. The first week of the record will say whether they group runs usefully.

---

## Non-goals {#non-goals}

- **Making settled run panels survive a reload.** Finished panels live in page memory only. Keeping them across a reload is a separate piece of work about storage, not about adoption.
- **Telling the model in the system prompt to wrap its own test runs.** Rejected as the primary mechanism ([B01]). It costs attention on every call, decays like any reminder, and still misses recipes. The `tugplug/` doc of [B07] covers only the leftover case of a script reporting its own units.
- **Rewriting `CLAUDE.md`'s and `arc-supplement.md`'s `cargo nextest run` instructions to `just test-rust`.** With [B02] in place, the instruction as written already gets the panel. Changing the text would fix this checkout and leave every other project where it was.
- **Wrapping arbitrary long commands (builds, `xcodebuild`, `cargo build`) by default.** A build has no unit the hook can count without knowing its phases. A builder project declares its phases through [B07].

---

## Exit {#exit}

An arc. First steps, in order:

1. **Capture a real PreToolUse round trip.** Confirm `tool_use_id` in the payload and that `updatedInput` is honoured, and see how the rewritten command displays. This settles [F06] and the second open question.
2. **Settle the junit question** (first open question).
3. **Teach the hook to wrap** `cargo nextest run`, `cargo test` and `bun test`, with the call id carried ([B02], [B03]). Add hook unit tests, and a `test-standalone` case driving the real hook script on a scratch project.
4. **Add the unreported-long-call record and `tugtool progress gaps`** ([B04]).
5. **Add `tugtool progress phase`, move `build-app` onto it, then the lint check and the recipes it flags** ([B05], [B06]).
6. **Use the bun recorded total as the track's total** ([B08]).

`[tugtool.runs]` ([B07]) is left for a later arc, once [B04]'s record names a standalone runner worth declaring.

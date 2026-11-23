# Verify skips a surface already green on record over identical input

**Purpose:** An arc re-runs whole test suites over code that has not changed since they last went green. `tugtool arc verify` should rely on a recorded green run when the bytes a surface's checks read are the same, and run only what moved.

---

## Purpose {#purpose}

The user's report, 2026-11-23: "Why does the Auditing step of arcs *redo all the tests that are almost always done as the last step of the actual arc*? I get it if the audit step made any changes, but if it hasn't, we're wasting a lot of time re-testing code we just tested. Can we see in the ledger that tests were done?"

The one whole-surface verify an audit runs is deliberate and stays. What is wanted is an end to the repeats around it: a second and third whole verify after a small fix, each re-running every surface the arc touched.

---

## Evidence {#evidence}

**[F01] The audit runs one whole verify by design, and the implement stage runs none.** `tugplug/skills/arc-audit/SKILL.md` §5 tells the audit to run `tugtool arc verify <name>` once even when the replay is `Current` and it changed nothing, because step checkpoints are named files run one at a time and a surface's declared checks are the only one-process run. `tugplug/skills/arc-implement/SKILL.md` says of its last step "no replay here, no verify, no build". **(verified, read)**

**[F02] Every whole verify re-runs every surface the arc touched, and audits run several.** From `test_results.db`, grouping clean-tree runs by Bash call id: `speech-engine-integration` ran three whole verifies (277 s, 222 s, 176 s of recorded suite time, at heads `c51e78300`, `bc46d6ace`, `0595a8799`) and `docket-one-card` three (216 s, 206 s, 198 s). Between the second and third speech verify the only change was 11 lines in `tugapp/Sources/SpeechCommand.swift`, and the third still ran nextest (66 s), clippy, the deck suite (40 s), the vite build and tsc. These sums leave out `just build-app` and the app-tests, which record elsewhere. **(verified, measured)**

**[F03] The first speech verify was red, so the scoped re-verify would not have helped the second.** A red verify records no `verified` line, so there is no green head to scope from. The scoped re-verify added to the audit skill in `7f731fdf7` covers a fix after a green verify only. **(verified, read)**

**[F04] The test ledger cannot say "green over these bytes".** `tugrust/crates/tugtool-core/src/test_ledger.rs` keeps, per run, `command`, `verdict`, `exit_code`, `head_sha`, `dirty` and `tool_use_id`. A check run before its round is committed is recorded `dirty=1` at the previous head, and no column is a content key. **(verified, read)**

**[F05] A check is not a run.** Verify runs each declared check as one `sh -c` (`run_plans` in `tugrust/crates/tugarc-core/src/surfaces.rs`), wrapped as the hook would wrap it (`verify_wrapper` in `tugrust/crates/tugtool/src/arc.rs`). The ledger rows come from the runners inside: `cd tugrust && cargo nextest run` leaves one row, `just test-ts` leaves six (`tugdeck`, `tugdeck-scripts`, `tugcode`, `tugproto`, `tugembed`, `app-test-logic`), and `just build-app`, `just wasm` and `just app-test-changed {paths}` leave none in this ledger. So a lookup of "this command, green" has no row to find for about half the declared checks. **(verified, read and from the ledger)**

**[F06] Verify already skips within one run, and only there.** `PlannedCommand.already_run_for` marks an identical expanded command a second surface would run, and the report says `already-run`. Nothing looks across runs. **(verified, read)**

**[F07] A step's own run rarely matches a declared check.** The whole-suite run inside a `docket-briefs-in-order` step was `cargo nextest run --workspace --no-fail-fast -E 'not (package…'`, not the declared `cd tugrust && cargo nextest run`. Verify matches the expanded check string, so step runs would earn a skip only when typed verbatim. **(verified, from the ledger)**

**[F08] The key is cheap to compute without writing anything.** `git ls-files -s` over the paths gives the tracked blobs; `git status --porcelain` names what is modified or untracked, and `git hash-object` without `-w` hashes those working bytes. On this checkout the listing and status took about 20 ms. Reading every file, as `fingerprint_universe` in `tugrust/crates/tugtool/src/commands/file_run.rs` does, took about 0.7 s over 7,822 files. **(verified, measured; the exact command sequence was timed in pieces, not as one implementation)**

**[F09] Checks read far outside their own surface's paths.** A grep for literal paths found Rust `include_str!`/`include_bytes!` reaching `tests/` (17), `docs/` (6) and `tugdeck/` (4), and deck code reading `tugrust/crates`, `tugproto/src`, `tests/app-test`, `tests/model-eval`, `tugcode/src`, `tugapp/Sources` and two `tuglaws/` documents. Every `just` check reads the `Justfile`. **(verified for the literal paths found.)** Rust files also mention `.tugtool` (24 files), `tugplug` (7) and `CLAUDE.md` (7); which of those are real reads and which are fixture strings was **not** confirmed, and a grep cannot find a path built at run time.

**[F10] Some checks exist for their side effect.** In the `app` surface, `just build-app` produces the bundle that `just app-test-changed {paths}` then drives; `just wasm` produces an artifact the deck build consumes. Skipping the first and running the second would test a stale artifact. **(verified, read from `.tugtool/config.toml`)**

**[F11] `{paths}` is already in the expanded string.** `expand` in `surfaces.rs` substitutes the surface's touched paths before the command is compared or run, so two verifies over different ranges produce different strings for a `{paths}` check. **(verified, read)**

---

## Decisions {#decisions}

**[B01] The one whole verify stays.** The audit still runs `tugtool arc verify <name>` and that run is still the arc's only whole-surface, one-process check ([F01]). This work changes what a verify does when the record already answers, not when a verify is run.

**[B02] The memo is a table of its own, one row per check, written by verify.** A row holds the expanded command, the content key, the exit, the wall time, the head and the Bash call id, in `test_results.db` beside `runs`. A check is the unit verify plans and judges, and a run row cannot stand for one ([F05]). Verify is the writer because it alone knows each check's exit.

**[B03] Run rows carry the key too.** `tugtool test run` records the key verify computed for the check it ran under, so a run can be traced to the check and the bytes it was part of. Verify never reads it to decide a skip; the check table is the one source for that.

**[B04] The key is a hash of the input paths' content as the working tree holds it.** Tracked blobs from the index, working bytes for anything modified or untracked, sorted and hashed ([F08]). It describes what the check actually read, so a dirty tree and the commit made from it share a key, and it writes no object and touches neither index nor worktree. It is computed before the check and again after, and a check is recorded as reusable only when the two agree.

**[B05] A surface's inputs are the whole tree unless it declares a narrower `inputs` list.** The default first proposed, a surface's own paths plus its `checked_by` borrowers, is wrong for this checkout ([F09]), and a wrong list is the one way this feature fails silently: verify skips a check that would have gone red. With the whole tree as the default nothing is skipped wrongly on day one, and each narrowing is a deliberate, reviewable line in `.tugtool/config.toml`.

**[B06] This arc declares `inputs` for `rust` and `deck`, from a read of what their checks open.** Without that the feature saves nothing beyond a verify repeated on an unchanged tree. The lists include the cross-surface reads [F09] found, the `Justfile` for any check that calls `just`, and whatever the unconfirmed mentions turn out to be once read.

**[B07] A surface skips whole or not at all.** Verify relies on the record for a surface only when every one of its checks, own and borrowed, has a green row with the same expanded command and the same key. Checks in a surface can depend on each other's side effects ([F10]), so skipping some and running others is unsound. This also settles `{paths}` checks with no special case ([F11]): a different range is a different string, which is a miss, which runs the surface.

**[B08] Only a green, completed check satisfies a skip.** A red, timed-out, not-started or not-reached check never does, and neither does one whose key moved while it ran ([B04]).

**[B09] A skip relies only on a row from the last 24 hours, and `--fresh` runs everything.** The key covers what is in the tree, including lock files and `.bun-version`, but not a compiler, Xcode or OS update. The age limit bounds that, `--fresh` is the hand override, and the push gate still runs every suite, so a wrong skip is caught before it lands on the remote.

**[B10] A skipped surface is reported as one, and the verify still records its head.** The report names each surface relied on from the record and the row it relied on (when it ran, at which head), the receipt counts them apart from surfaces checked, and a verify whose surfaces were all skipped still writes the `verified` line so the audit's mark goes through.

**[B11] The hook is left out of this cut.** A hand-typed command equal to a declared check is not stamped as a check. Step runs rarely match a declared string ([F07]), and the measured waste is verify after verify ([F02]), which needs no hook work.

**[B12] The schema change is a registered migration with a `TEST_RESULTS_SCHEMA_VERSION` bump,** as the ledger's own rule requires. The check table gets its own retention at record time.

**[B13] The scoped re-verify comes out of the audit skill once this lands.** The paragraph added to `tugplug/skills/arc-audit/SKILL.md` §5 in `7f731fdf7`, and the `--base <audited_at.head>` rung of the fold in §1b, are replaced by a plain `tugtool arc verify <name>`. The memo is the sounder of the two: a scoped verify runs the surfaces a round touched, and the memo runs the surfaces whose inputs changed. `--base` stays as a verb option. `tugplug/doctrine/arc-work-doctrine.md` and `tuglaws/arc-supplement.md` each get the sentence that says a verify may rely on the record.

---

## Calls you have not seen {#unseen-calls}

- The brief is named `verify-memo`; rename the file to change the arc name `/arc` derives.
- The config key for a surface's narrowed inputs is `inputs`, a list of repo-relative paths with the same prefix rule as `paths`; say another name to change it.
- The 24-hour limit in [B09] is a constant in the code, not a setting in `.tugtool/config.toml`; say so if it should be a declared number.
- The override flag is `--fresh`; say another name to change it.
- Untracked files that git does not ignore count toward the key, so a stray scratch file in the worktree is a miss, never a wrong hit.
- The check table's retention is not sized here; the arc picks a number in the spirit of `MAX_RUNS_PER_ROOT`.

---

## Open Questions {#open-questions}

- **What exactly do the `rust` and `deck` checks read?** [F09] is a floor, not a list. The arc has to read the Rust mentions of `.tugtool`, `tugplug` and `CLAUDE.md`, and find paths built at run time, before it writes the two `inputs` lists. If that read cannot reach confidence for a surface, the answer is to leave that surface on the whole-tree default, which is safe.
- **Is there a guard that keeps an `inputs` list honest as tests change?** A new test that reads a file outside the list silently widens the hole. A lint over literal up-tree paths would catch the common shape and miss computed ones. Whether that is worth building in this arc, or whether [B09]'s limit and the push gate are enough, is not settled.

---

## Non-goals {#non-goals}

- **Removing the audit's whole verify.** It is the only one-process run an arc gets ([B01]).
- **Skipping individual checks inside a surface.** Rejected for [F10]: a skipped build with a run test drives a stale artifact.
- **Own paths plus `checked_by` borrowers as the default inputs.** Rejected for [F09]: it would skip wrongly on day one.
- **Giving steps credit through the hook.** Left out ([B11]); it can be a later change if step runs start matching declared checks.
- **Memoising app-test results in `apptest_results.db`.** The `app` surface is covered only by the whole-surface rule in [B07].
- **Any change to what `just ci` or the nightly lane runs.** They stay complete, which is what makes a rare wrong skip recoverable.

---

## Exit {#exit}

**An arc.** Its shape, in the order the pieces depend on each other:

- The key: one function over a worktree and a list of input paths, with tests that a dirty tree and its commit agree and that a changed, added or deleted file under the inputs moves it.
- The ledger: the check table, its migration and version bump, the key column on `runs`, and the read that answers "green, same command, same key, inside the limit".
- Config: `inputs` on a surface, defaulting to the whole tree.
- Verify: plan each surface, compute its key, skip it whole when every check hits, run and record it otherwise, report and receipt the skips, record the head either way, and take `--fresh`.
- The declarations: `inputs` for `rust` and `deck` in `.tugtool/config.toml`, from the read the first open question names.
- The documents: the audit skill, the arc doctrine and the supplement, per [B13].

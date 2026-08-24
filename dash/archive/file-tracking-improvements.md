<!-- devise-skeleton v4 -->

## File-Tracking Improvements: close the shell-edit attribution gap {#file-tracking-improvements}

**Purpose:** Convert the dominant source of `unattributed` files — model-authored shell edits (`perl -i`, `python3` heredocs) that the attribution grammar cannot read — into proof-class capture, by widening the grammar where it can already prove, shipping receipt-emitting edit and probe verbs, and removing the reason those shell pipelines are written in the first place: an app-test harness whose output has to be grepped.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-02 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Files land in the Changes card's `UNATTRIBUTED — NO SESSION CLAIMS THESE` bucket on most sessions, and the manual `CLAIM ALL` gesture is absorbing the defect at an accelerating rate: `origin='claim'` rows in `changes.db` went 1–3/day through late July to **11 (Jul 31) → 30 (Aug 1) → 62 (Aug 2)**. Nothing is broken — [tracking-changes.md](../tuglaws/tracking-changes.md) is behaving exactly as specified. Only *proof*-class evidence attributes (`exact`, `replay`, `claim`, `cmd`); the Bash and turn brackets are *correlation* and can only hint (`likely`). Over the last seven days the ledger holds 1,114 correlation rows against 2,521 proof rows — **31% of all capture is hint-grade**.

A corpus study of the last 24 session transcripts for this project (`~/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/*.jsonl`) located the cause precisely. Of 8,473 Bash calls, **393 write repo files**: 324 via `python3 - <<'PY'` heredocs, 44 via `perl -i -pe`, 22 via `sed -i`, 12 via `python3 -c`. Only `sed -i` is covered by the grammar today, so **380 of 393 are invisible**. What those commands *do* is mundane — 154 single string→string substitutions, 78 two-substitution edits, 79 three-or-more, 80 regex substitutions, 2 line-range deletions: **~98% is plain string replacement that `Edit`/`MultiEdit` already do with full attribution.** The reason the shell wins anyway is economic, not capability: **284 of 393 (72%) chain the edit with verification or reversion in the same call** (edit → `just app-test …` → grep the result; or patch → run → `git checkout --` to revert), and 97 name two or more files. Measured attribution loss in that corpus: of 196 (session, file) shell-edit pairs, 116 were also `Edit`ed by the same session so proof survived; **80 pairs across ~69 distinct files had no proof row from any source.**

The second half of that economics is the app-test harness. **2,660 `app-test` invocations, 1,987 of them (75%) piped through `grep`/`rg`/`sed`/`head`.** The `APP-TEST SUMMARY` block the recipe already prints is good — the problem is that `Justfile`'s per-file loop also streams every file's complete raw `bun test` output to stdout, so a failure appears two or three times, a green run's stream is pure noise, and the single most-grepped payload (316 of 2,118 pipeline segments hunt `VERDICT|PROBE|DBG` — the tests' own `console.log` diagnostics) has no home in the summary at all. Roughly 800 more segments are bare `head -20` / `tail -30`: not information-seeking, just context rationing against an output whose size cannot be predicted.

So the fix is two-sided and in one plan: make provable shell edits provable, and make the tool that made shell edits worth writing unnecessary.

#### Strategy {#strategy}

- **Widen the grammar before inventing anything.** `perl -i` and `ruby -i` name their file with exactly the standing `sed -i` already has. Adding them is a `match` arm and a shared helper — 11% of the corpus converts to proof with zero new architecture and zero behavior change.
- **Fix the harness output next, because it is the reason the pipelines exist.** Quiet by default, promote test diagnostics and per-failure assertion detail into the summary, add a JSON channel. This removes the "read the answer" half of the edit-run-grep round trip.
- **Then ship `tugutil file probe`** — atomic patch → run → restore. This is what 72% of the shell-edit corpus is actually reaching for and no tool provides. It emits *no* attribution rows, which is strictly better than today, where a probe's transient churn lands as a spurious `bash` hint.
- **Then ship `tugutil file edit`** — receipt-emitting substitution, `--patch` primary. The receipt path is already built end-to-end; this is a new verb, not a new mechanism.
- **Gate last, and only where the grammar can prove.** Deny `perl -i`/`ruby -i`/`sed -i` with unreadable operands; steer python heredocs by documentation only. A gate that guesses is worse than no gate.
- **Every capture change degrades toward `unattributed`, never toward a wrong claim.** This is the standing invariant of [tracking-changes.md](../tuglaws/tracking-changes.md#the-five-identities-soundness-axioms); no step in this plan may relax it.

#### Success Criteria (Measurable) {#success-criteria}

- `parse_shell_ops("perl -i -pe 's/a/b/' src/x.ts", root)` returns `ParseOutcome::Ops` with one `DeclaredKind::EditInPlace` on `src/x.ts`; the same command with a glob or `$VAR` operand returns `Unparseable`. (Unit tests in `tugchanges-core/src/shell_ops.rs`.)
- `just app-test <one green file>` produces **no** raw `bun test` body on stdout — output is the summary block plus any `Diagnostics:` section. Verify by `just app-test harness-smoke/smoke.test.ts | grep -c '^bun test v'` returning `0`, and the same command under `TUG_APPTEST_STREAM=1` returning `1`. (Use bun's own banner as the falsifier, not `^(pass)` — bun prints a line per *failing* test only, so a green file has no `(pass)` lines to suppress in the first place.)
- A test that calls `note("VERDICT", "…")` has that value printed under `Diagnostics:` in the summary of a **passing** run, with no pipe. (Verified by the smoke test.)
- A failing app-test's summary carries the first assertion message / error and a `file:line` locator under the failure title, not just the `(fail) …` line. (Verified against a deliberately-failing fixture.)
- `TUG_APPTEST_JSON=/tmp/r.json just app-test …` writes a JSON document validating against Spec S03, and stdout is unchanged.
- `tugutil file probe --patch p.diff -- <cmd>` applies, runs, restores byte-identical content (`git status --porcelain` output before == after for the named paths), and writes **zero** rows to `changes.db`. (Integration test in `tugrust/crates/tugutil/tests/`.)
- `tugutil file edit --patch p.diff` prints a `TUG-FILE-RECEIPT` line whose ops are `modified` for each named path, and a live relay turns those into `origin='cmd'` rows. (Unit test on the receipt shape; relay side already covered by `attribution.rs`'s receipt tests.)
- `tugutil file gate --command "perl -i -pe 's/a/b/' src/*.ts"` returns `decision: "deny"`; `--command "perl -i -pe 's/a/b/' src/x.ts"` returns `allow`; `--command "python3 - <<'PY'…"` returns `allow`.
- The Changes card's unattributed bucket shrinks in practice: after this plan lands, a working week's `origin='claim'` row count is materially below the 30–62/day observed on 2026-08-01/02. (Measure with `just db-inspect changes "SELECT date(at/1000,'unixepoch') d, COUNT(*) FROM file_events WHERE origin='claim' GROUP BY d"`.)

#### Scope {#scope}

1. `perl -i` / `ruby -i` support in `tugchanges-core::shell_ops` (proposal **A**).
2. App-test harness output: quiet by default, `Diagnostics:` channel, per-failure detail, JSON output (proposal **E**).
3. `tugutil file probe` — atomic patch/run/restore, no attribution rows (proposal **C**).
4. `tugutil file edit` — receipt-emitting substitution and patch application (proposal **B**).
5. PreToolUse gate extension for provable in-place editors, plus `CLAUDE.md` steering for the unprovable ones (proposal **D**).
6. Doc updates: `tuglaws/tracking-changes.md`, `tests/app-test/README.md`, `CLAUDE.md`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Changing `Edit`/`MultiEdit`.** Those are Claude Code's tools; Tug cannot alter them. Every fix here is Tug-side.
- **Parsing Python.** No step attempts to read what a `python3` heredoc does to the filesystem. Heredoc bodies are already stripped by `strip_heredoc_bodies` and stay stripped.
- **Reconstructing historical Bash deltas** (gap G1). Unchanged.
- **Capturing the `$` shell route** (gap G4). Unchanged — deliberately uncaptured per [D111].
- **Any change to the read side** (`tugchanges-core::changes::resolve_changes`, the three buckets, the liveness rule, contention). This plan only adds proof-class *capture*; classification is untouched.
- **Retiring `CLAIM ALL`.** It stays as the backstop for the residue.
- **Windowing, throttling, or restructuring `bun test` itself.** Step 2 suppresses and reformats bun's output; it does not replace the runner.

#### Dependencies / Prerequisites {#dependencies}

- `tugchanges-core::shell_ops` grammar and its two consumers: tugcast's relay (`tugrust/crates/tugcast/src/feeds/attribution.rs`) and `tugutil file gate` (`tugrust/crates/tugutil/src/commands/file.rs::run_gate`).
- The receipt path, already complete end-to-end: `RECEIPT_PREFIX` in `commands/file.rs`, `RECEIPT_MARKER` / `parse_receipt_line` / `op_for_receipt` in `attribution.rs`. **`op_for_receipt` already accepts `"modified"`**, so Steps 4 and 5 need no relay change whatsoever.
- **`op_for_row` already maps `DeclaredKind::EditInPlace` → `"modified"`** in `attribution.rs`, so Step 1 needs no relay change either.
- The `app-test` recipe in `Justfile` (recipe head `app-test *FILES:`), its per-file loop, and its summary block.
- `tests/app-test/_harness/index.ts` (the `App` class and `launchTugApp` are exported from here; test authors import from `_harness`).
- `scripts/select-tests.ts` (`--core`, `--foreground` modes) — unchanged by this plan but invoked by the recipe.
- `tugplug/hooks/gate-file-ops.sh` — the PreToolUse hook; requires `jq` and `tugutil` on PATH and fails open.

#### Constraints {#constraints}

- **Warnings are errors.** `tugrust/.cargo/config.toml` enforces `-D warnings`; `cargo nextest run` fails on any warning.
- **`changes.db` is opened read-only by readers and only through `tugcore::ledger_db` for writers** (guarded by the `no_ad_hoc_ledger_opens` test). No step in this plan opens a ledger; the probe verb must not touch `changes.db` at all.
- **Refusal is free, a wrong proof row is not.** Any grammar extension must refuse on variables, substitutions, globs, and brace expansions, matching the existing `operands()` contract.
- **The app-test recipe is `set -uo pipefail`, deliberately not `set -e`** — it must keep iterating past per-file failures so the summary captures every file's status. Step 2 must preserve that.
- **App-tests are expensive and serialized** behind a machine-wide gate; verification steps here name specific files, never `just app-test-all`.
- `just app-test` re-execs itself under the host gate (`exec tugrust/target/debug/tugutil host gate run --name apptest … -- just app-test {{FILES}}`), which is why `error: Recipe \`app-test\` failed with exit code 1` currently prints twice.

#### Assumptions {#assumptions}

- Every file whose attribution matters lives inside a git repository (worktree-aware), so `git apply` is available as the patch applier for Steps 4 and 5.
- Test authors will adopt a `note()` helper if it is the shortest path to a value they currently `console.log`; the existing `VERDICT`/`PROBE`/`DBG` string conventions are ad-hoc and unowned, so replacing them breaks nothing.
- `bun test`'s per-file output ends with lines matching `^[ \t]*[0-9]+ pass$` / `^[ \t]*[0-9]+ fail$` (the recipe already depends on this) and emits per-test failures as `^(fail) …` lines.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit and kebab-case. Plan-local decisions are `[P01]`… (never `[D##]`, which belongs to [design-decisions.md](../tuglaws/design-decisions.md) and is cited here by reference only). Steps cite decisions, specs, and anchors — never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does a silent run need a progress heartbeat? (OPEN) {#q01-quiet-heartbeat}

**Question:** With the raw `bun test` stream suppressed ([P04]), a 22-file core-tier run prints nothing between the header and the summary for roughly two minutes. Is that tolerable in a human terminal, or does the recipe need a per-file progress line?

**Why it matters:** If it is intolerable the recipe needs a one-line-per-file progress emission, which then has to be excluded from the JSON channel and must not reintroduce the noise the quiet mode exists to remove. Getting this wrong makes the feature annoying enough to be disabled, which loses the whole benefit.

**Options (if known):**
- Fully silent between header and summary (what [P04] ships).
- Keep the existing `---- <file> ----` header line and add a `[PASS] <file> (n/m)` line as each file completes — the summary's per-file table then becomes a repeat.
- Emit progress only when stdout is a TTY, so the model's capture stays clean and the human sees motion.

**Plan to resolve:** Ship [P04] fully silent in #step-2, then run `just app-test` (core tier) once by hand and judge. If it needs motion, the TTY-conditional variant is the follow-up — it is a three-line change to the loop and costs the model nothing.

**Resolution:** RESOLVED in #step-2 — **the TTY-conditional variant**. Observed: a silent core tier is 2m07s with nothing on screen after the two `==>` header lines, which reads as a hang to a person. The loop now prints one `  [PASS] <file> (n/m)` line per file as it completes, gated on `[ -t 1 ]` and on quiet mode. A captured run — a pipe, a redirect, a model's context — is never a TTY and stays fully silent; an interactive terminal shows motion at file cadence and accepts that the summary repeats the table.

#### [Q02] Should `tugutil file probe` refuse a target that is already dirty? (DEFERRED) {#q02-probe-on-dirty}

**Question:** A probe snapshots and restores the files its patch names ([P09]). If one of those files already carries uncommitted work, a crash between apply and restore risks that work.

**Why it matters:** Silent loss of the user's inflight edits is the one failure this whole area exists to prevent.

**Options (if known):**
- Refuse when any target path is dirty (safe, but the common case in this repo is a dirty tree, which would make the verb useless).
- Allow, snapshot to a temp dir, restore on every exit path including signals, and leave a named breadcrumb if restore fails.

**Plan to resolve:** Ship the second option in #step-4 with the breadcrumb, and revisit only if a real loss occurs.

**Resolution:** DEFERRED — allow-with-snapshot ships ([P09]); revisit if `Risk R02` ever fires.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| A widened grammar mints a wrong proof row | high | low | Reuse the existing `operands()` refusal contract verbatim; unit-test the glob/variable cases alongside the literal ones | Any file attributed to a session that did not edit it |
| Probe loses uncommitted work on a crash | high | low | Byte-snapshot to temp, restore on all exit paths, breadcrumb on failure ([P09]) | One report of lost work |
| Quiet harness hides information someone needed | medium | medium | `TUG_APPTEST_STREAM=1` restores today's output exactly; failure detail is promoted into the summary rather than dropped | A debugging session that has to set the env var more than occasionally |
| Gate denies a legitimate command | medium | low | Deny only what the grammar proves is unreadable, and only for in-place editors; fail open on any error ([P07]) | Any deny the user has to work around |

**Risk R01: The grammar widening becomes a false-proof source** {#r01-false-proof}

- **Risk:** `perl -i` accepts flag forms `sed` does not (`-0`, `-p`, `-e`, combined clusters like `-0pi`), so a naive operand scan could mistake a flag argument or a `-e` expression for a filename and attribute a file the command never touched.
- **Mitigation:**
  - Model the flag/operand split on `sed_ops`, which already handles the combined-cluster case (`w.text.starts_with("-i")`) and the `-e`/`-f` takes-an-argument case.
  - `perl`'s script is supplied by `-e`/`-E` (consumed as an argument) or, absent those, as the **first** non-flag operand — exactly `sed`'s `have_expr` rule; reuse it.
  - Unit-test `-0pi -e`, `-pi -e`, `-i -pe`, and `-i.bak` forms, all of which appear in the corpus.
- **Residual risk:** An exotic `perl` invocation (`-s`, `-a -F`, `-M`) could still confuse the operand scan. Acceptable: the failure direction is a *missing* row (flag read as expression) far more often than a spurious one, and any operand that is non-literal already refuses.

**Risk R02: Probe restore fails and leaves the tree patched** {#r02-probe-restore}

- **Risk:** A signal or panic between apply and restore leaves the working tree carrying the probe's patch, which the user then commits by accident.
- **Mitigation:**
  - Restore runs from a guard that fires on normal return, error return, and `SIGINT`/`SIGTERM`.
  - If restore fails, print a loud line naming the snapshot directory and exit non-zero — never exit 0 with the tree modified.
- **Residual risk:** `SIGKILL` cannot be trapped. The snapshot directory survives and the breadcrumb path is deterministic, so recovery is manual but possible.

**Risk R03: The JSON channel drifts from the human summary** {#r03-json-drift}

- **Risk:** Two renderings of the same run computed by two code paths diverge.
- **Mitigation:** Both are computed from the same `RESULT_ROWS` / `FAILURE_BLOCKS` / notes arrays in one pass; the JSON is serialized from those arrays, not re-parsed from the printed text.
- **Residual risk:** None material — a single source array makes drift a code-review question, not a runtime one.

---

### Design Decisions {#design-decisions}

#### [P01] `perl -i` and `ruby -i` join the grammar as `EditInPlace` (DECIDED) {#p01-perl-in-grammar}

**Decision:** `tugchanges-core::shell_ops::parse_segment` gains `"perl" | "ruby"` arms that produce `DeclaredKind::EditInPlace` ops under the same literal-operand rules `sed` uses, via a shared `in_place_editor_ops` helper.

**Rationale:**
- `perl -i -pe 's/a/b/' src/x.tsx` names its file in the tool input with exactly the epistemic standing of `sed -i` — proof class per the *What* axiom in [tracking-changes.md](../tuglaws/tracking-changes.md#the-five-identities-soundness-axioms).
- 44 of 393 repo-mutating shell commands in the measured corpus are `perl -i`; `ruby -i` is free once the helper exists.
- **No downstream change is required**: `attribution.rs::op_for_row` already maps `DeclaredKind::EditInPlace` to the `"modified"` row op, and both the live (parse ∩ delta) and replay (parse + success) mint paths are origin-agnostic.

**Implications:**
- `sed_ops` is generalized rather than copied, so the three verbs cannot drift.
- The gate ([P07]) inherits the widening for free, since it calls the same `parse_shell_ops`.
- A `perl -i` with a glob operand now *refuses* the whole simple command, which is a behavior change for the gate: see [P07] for why that is the intended outcome.

#### [P02] `tugutil file edit` reports `modified` receipts; the relay is untouched (DECIDED) {#p02-edit-receipt}

**Decision:** The new `edit` verb emits the existing `TUG-FILE-RECEIPT` line with `op: "modified"` for every path it changed. No change to tugcast.

**Rationale:**
- `attribution.rs::op_for_receipt` already returns `Some("modified")` for the `"modified"` op, and the relay already scans **every** successful Bash `tool_result` output for `RECEIPT_MARKER`.
- Forgery is a non-risk for the same reason it is for `rm`/`mv`: rows are relay-local (the *Who* axiom), so a session emitting the sentinel can only attribute files to itself.

**Implications:**
- Step 5 is a `tugutil`-only change plus tests.
- The receipt's `ops` array grows a new op value, not a new shape — additive, and `parse_receipt_line` already ignores unknown fields.

#### [P03] `tugutil file probe` writes no receipt and produces no attribution rows (DECIDED) {#p03-probe-no-rows}

**Decision:** `probe` emits no `TUG-FILE-RECEIPT`. Its restore is byte-exact, so the correct record of a probe is *no record*.

**Rationale:**
- A probe that restores changed nothing; a row saying otherwise would be a lie in the ledger.
- Today a patch-run-revert cycle done in the shell *does* leave a spurious `origin='bash'` hint on the probed file, because the bracket sees mtime move. Routing probes through this verb therefore **removes** a class of false hints — the verb is a net reduction in unattributed noise, independent of the convenience win.

**Implications:**
- The Bash bracket around the probe's own `tool_use` will still see the file's mtime change and back, producing at most an unchanged-status/changed-mtime delta. Step 4 must restore **content and mtime** so `snapshot_worktree`'s status+mtime fingerprint reads identical pre and post, and the bracket mints nothing at all.

#### [P04] `just app-test` is quiet by default (DECIDED) {#p04-quiet-default}

**Decision:** The per-file `bun test` body is suppressed from stdout. `TUG_APPTEST_STREAM=1` — an environment variable, deliberately **not** a recipe flag — restores today's full output verbatim.

**Rationale:**
- 75% of app-test invocations in the corpus are piped, and ~800 of 2,118 pipeline segments are bare `head`/`tail` truncation — the model rationing context against an unpredictable output size. A bounded, complete summary removes the reason to truncate.
- On a green run the stream is read by nobody; on a red run it duplicates the failure two or three times.
- The env-var escape hatch matches the recipe's existing conventions (`TUG_APPTEST_ASSUME`, `TUG_APPTEST_ASK_OUT`).
- **A flag is not viable, which is why this is env-var-only.** The `app-test` recipe runs in two phases around a self re-exec (`exec … tugutil host gate run … -- just app-test {{FILES}}`). In the *pre-gate* phase `{{FILES}}` is consumed verbatim by the foreground-approval machinery — `ASK_FILES="$(printf '%s\n' {{FILES}})"` feeding `select-tests.ts --foreground` — so a `--stream` pseudo-file would reach the selector as a filename before any post-gate stripping could run. An exported environment variable survives the `exec` untouched and is read once, in one place.

**Implications:**
- The recipe's existing `tee "$TMPOUT"` becomes a plain redirect to `$TMPOUT` in quiet mode; `$TMPOUT` is already the parse source, so no parsing changes.
- No argument parsing is added to either phase of the recipe; `{{FILES}}` remains files-only.
- `just app-test-changed` and `just app-test-all` delegate to this recipe and inherit both the default and the env var.
- Whether a progress heartbeat is needed is [Q01] (resolved in #step-2: TTY-conditional).
- The dist-refresh step (`cd tugdeck && bun run build`) is quieted the same way and for the same reason: its stdout was already discarded, but a green build's rollup chunking advisories were several screens of stderr ahead of the summary. Its output is held in a temp file and printed only when the build fails.

#### [P05] Test diagnostics travel as a stdout sentinel, not a new RPC (DECIDED) {#p05-note-sentinel}

**Decision:** A `note(label, value)` helper exported from `tests/app-test/_harness` prints one line `TUG-NOTE: {"label":…,"value":…}` to stdout. The recipe collects those lines out of `$TMPOUT` and prints them under a `Diagnostics:` section in the summary, for passing and failing files alike.

**Rationale:**
- Same house pattern as `TUG-FILE-RECEIPT` — a sentinel-prefixed stdout line parsed by a shell consumer — so there is one idiom to learn, and it needs no change to the harness RPC or to `App`.
- Tests already `console.log` these values; the 316 grep segments hunting `VERDICT|PROBE|DBG` are the proof that the payload is wanted and has nowhere to live.
- Printing notes on **passing** runs is the whole point: probe values are most often read from a green run.

**Implications:**
- The `_harness` export surface grows one function; `EXPECTED_SURFACE_VERSION` in `tests/app-test/_harness/index.ts` is bumped if the harness's version contract covers exports.
- Notes are suppressed from the raw-stream path only in the sense that they also appear inline there — no special casing.
- Existing `console.log("VERDICT", …)` call sites keep working; migration is opportunistic, not required.

#### [P06] The JSON channel writes to a file named by env var, never to stdout (DECIDED) {#p06-json-to-file}

**Decision:** `TUG_APPTEST_JSON=<path>` makes the recipe write a JSON document (Spec S03) to `<path>`. Stdout is byte-identical with and without it.

**Rationale:**
- Mixing a JSON document into the human summary would recreate the parsing problem in a new form.
- A file path is what `tugutil file probe` ([P08]) needs anyway — it runs the command and reads the result rather than scraping the command's stdout.

**Implications:**
- The recipe accumulates notes and failure details into shell arrays during the loop and serializes once at the end, from the same arrays the human summary renders ([R03]).

#### [P07] The gate denies only in-place editors the grammar can prove unreadable (DECIDED) {#p07-gate-scope}

**Decision:** `LIFECYCLE_WORDS` gains no members. Instead, `parse_segment`'s in-place-editor arms refuse (rather than silently produce nothing) when their operands are non-literal, which makes `parse_shell_ops` return `Unparseable` and the existing gate deny. Python and awk heredocs are never denied — only steered by `CLAUDE.md`.

**Rationale:**
- A `perl -i -pe '…' src/*.tsx` is exactly the case the gate was built for: a mutation the grammar can see happening but cannot resolve to files. Steering it to `tugutil file edit` costs one round trip and buys proof.
- A `python3` heredoc cannot be judged without parsing Python. Two-thirds of `python3` invocations in the corpus are read-only analysis; a heuristic deny would block legitimate work and could still be fooled.
- The hook already fails open on any error, so the blast radius of a wrong deny is bounded but nonzero — which is exactly why it is confined to what the grammar proves.

**Implications:**
- The hook script `tugplug/hooks/gate-file-ops.sh` needs **no change** — its decision comes from `tugutil file gate`, which calls the same `parse_shell_ops`.
- **`run_gate` in `tugrust/crates/tugutil/src/commands/file.rs` does need a change.** Today it appends one hardcoded steering sentence to *every* `Unparseable` reason — "Use `tugutil file rm|mv|cp` instead — it expands the operands itself and reports exactly which files it touched, so the change stays attributed." Once an in-place editor can refuse, that suffix would steer a denied `perl -i … src/*.ts` at the wrong verb. The steering sentence must become refusal-aware: either carry the suggested verb on the refusal itself (preferred — the grammar knows what refused) or branch in `run_gate`. Whichever is chosen, the generic suffix stops being unconditional.

#### [P08] `probe` runs the command and passes its output through unchanged (DECIDED) {#p08-probe-passthrough}

**Decision:** `tugutil file probe --patch <p> -- <cmd…>` prints the child's stdout/stderr as-is, then restores, then exits with the child's exit code.

**Rationale:**
- Anything cleverer (capturing, re-rendering) makes the verb a second output format to learn, and the app-test side is already being fixed properly in Steps 2–3.
- Exit-code fidelity lets `probe` compose in `&&` chains the way the shell forms it replaces do.

**Implications:**
- Restore happens **after** the child exits, so a long-running command holds the patch for its duration — correct, and the same window the shell form has.

#### [P09] Probe restores from a byte snapshot, not from git (DECIDED) {#p09-snapshot-restore}

**Decision:** Before applying, `probe` copies each path the patch names into a temp directory and records its mtime; restore writes the bytes back and resets the mtime. Git is not consulted.

**Rationale:**
- Git-based restore (`git checkout --`) would destroy any pre-existing uncommitted work on those paths — the common case in this repo — and cannot restore untracked files at all.
- Resetting mtime is what makes [P03] true: `snapshot_worktree` fingerprints status **and** mtime, so a restored-but-touched file would still mint a bracket row.

**Implications:**
- The snapshot directory path is deterministic and printed on restore failure ([R02]).
- Files the patch *creates* are removed on restore rather than restored.

#### [P10] `--patch` is the primary edit surface; `--replace/--with` is the convenience form (DECIDED) {#p10-patch-primary}

**Decision:** `tugutil file edit` accepts `--patch <file|->` (unified diff, multi-file, applied with `git apply`) and, for the single-substitution case, `--path/--replace/--with [--count N] [--regex]`.

**Rationale:**
- A unified diff covers all five observed edit shapes (single, 2, 3+, regex, line-range) and the multi-file case (97 of 393 commands name 2+ files) in one surface, and is a format models emit accurately.
- The `--replace/--with` form matches the single most common shape (154 of 393) with the least ceremony, so the cheap case stays cheap.
- `git apply` gives `--check` for free (validate before mutating) and is present by construction.

**Implications:**
- `--patch -` reads the diff from stdin, which is how a heredoc-shaped call site translates most directly.
- `--replace` without `--regex` is a literal substring replace; with `--regex` it is a Rust `regex` crate pattern. Default `--count` is *all* occurrences, matching `s///g` and `str::replace`.
- Both forms emit one receipt covering every path touched.

---

### Deep Dives {#deep-dives}

#### Why the corpus says convenience, not capability {#corpus-findings}

The measurement that drove this plan's ordering, so an implementer does not re-derive it:

**Table T01: Repo-mutating shell commands, last 24 sessions** {#t01-mutators}

| Mutator | Calls | Grammar coverage today |
|---|---:|---|
| `python3 - <<'PY'` heredoc | 324 | invisible |
| `perl -i -pe` | 44 | invisible — Step 1 fixes |
| `sed -i` | 22 | proof (`sed_ops`, BSD `-i ''` handled) |
| `python3 -c` | 12 | invisible |

**Table T02: What those edits do** {#t02-shapes}

| Shape | Calls | Equivalent tool |
|---|---:|---|
| single string→string substitution | 154 | `Edit` |
| two substitutions | 78 | `MultiEdit` |
| three or more substitutions | 79 | `MultiEdit` |
| regex substitution (`s///`) | 80 | `Edit` (regex) |
| line-range deletion | 2 | patch |

**Table T03: Why the shell wins anyway** {#t03-why-shell}

| Property | Count | Share |
|---|---:|---:|
| edit chained with verify/revert in the same call | 284 / 393 | 72% |
| edit only | 109 / 393 | 28% |
| names 2+ repo files | 97 / 393 | 25% |

The conclusion an implementer should carry: **the plan's value is concentrated in Steps 2–4, not Step 5.** Step 5 (`file edit`) is the tool that *should* be used; Steps 2–4 are what make using it cheaper than the shell. A `file edit` shipped without the harness fix and the probe verb would lose on round-trip economics 72% of the time.

#### What the app-test greps are reaching for {#apptest-grep-analysis}

Of 2,118 app-test pipeline segments (a segment may hit several categories):

**Table T04: Extraction targets** {#t04-grep-targets}

| What the grep extracts | Segments | Where Step 2/3 puts it |
|---|---:|---|
| test-authored `VERDICT` / `PROBE` / `DBG` prints | 316 | `Diagnostics:` section ([P05]) |
| error / exception text | 287 | per-failure detail under the failure title |
| pass/fail tally | 192 | already in the summary |
| assertion diff (`Expected`/`Received`) | 110 | per-failure detail |
| `file:line` locator | 55 | per-failure detail |
| bare `head -N` / `tail -N` truncation | ~800 | removed by bounded output ([P04]) |

The current recipe's `Failures:` block greps `^\(fail\)` out of the captured block and discards everything else, which is why the assertion diff and the `TimeoutError` script are stranded in the raw stream. Step 2 extracts the first non-`(fail)` error/assertion lines associated with each failing test and prints them under the title.

#### The receipt path is already complete {#receipt-path}

An implementer should not build anything on the tugcast side for Steps 4 and 5. The chain that already exists:

1. `tugutil` prints `TUG-FILE-RECEIPT: {"ops":[…]}` (`RECEIPT_PREFIX`, `commands/file.rs`).
2. The relay scans every successful Bash `tool_result` output (`parse_receipt_line`, `attribution.rs`) — malformed JSON sets `ReceiptScan::malformed` and warns rather than dropping silently (invariant 12).
3. `op_for_receipt` maps the op string to a row op. **`"modified"` is already in that map.**
4. Rows mint with `origin='cmd'`, proof class.

Likewise for Step 1: `op_for_row` already maps `DeclaredKind::EditInPlace | WriteTarget | Touch` to `"modified"`. The grammar is the only thing that needs to change.

---

### Specification {#specification}

**Spec S01: `tugutil file edit`** {#s01-file-edit}

```
tugutil file edit --patch <FILE|->
tugutil file edit --path <PATH> --replace <OLD> --with <NEW> [--count <N>] [--regex]
```

- `--patch` applies a unified diff via `git apply --check` then `git apply`. Multi-file diffs are supported. A diff that does not apply cleanly exits non-zero having changed nothing, and emits no receipt.
- `--replace` is a literal substring replacement unless `--regex` is given, in which case the pattern is a `regex` crate pattern and `--with` may contain `$1`-style captures.
- `--count` bounds the number of replacements; default is all.
- If `--replace` matches nothing, the verb exits non-zero with `no match` and emits no receipt — silence about a no-op edit is how a stale substitution hides.
- On success the verb prints one receipt line whose ops are `{"op":"modified","path":"<abs>"}` for each path whose bytes changed. A file the patch names but leaves byte-identical is not in the receipt.

**Spec S02: `tugutil file probe`** {#s02-file-probe}

```
tugutil file probe --patch <FILE|-> [--path <PATH>…] -- <COMMAND> [ARGS…]
```

- Snapshots every path the patch names (plus any extra `--path` targets) into a temp directory, recording bytes and mtime.
- Applies the patch, runs `<COMMAND>` with stdout/stderr passed through unchanged ([P08]), then restores bytes and mtime and removes any files the patch created ([P09]).
- Exits with the command's exit code. If restore fails, prints a line naming the snapshot directory and exits non-zero regardless of the command's code ([R02]).
- Emits **no** receipt ([P03]).

**Spec S03: App-test JSON output** {#s03-apptest-json}

Written to `$TUG_APPTEST_JSON` when set. Stdout unaffected ([P06]).

```json
{
  "sweep": "core | explicit-files | changed",
  "wallSeconds": 115,
  "verdict": "PASS | FAIL",
  "totals": { "filesRun": 22, "filesPassed": 20, "filesFailed": 2,
              "filesErrored": 0, "filesSkipped": 0,
              "testsPassed": 23, "testsTotal": 25 },
  "files": [
    { "file": "at0245-lens-snippet-click-scroll.test.ts",
      "status": "PASS | FAIL | ERR | SKIP",
      "passed": 0, "total": 1,
      "failures": [ { "title": "…", "message": "…", "location": "at0245-….test.ts:412" } ],
      "notes":    [ { "label": "VERDICT", "value": "…" } ] }
  ]
}
```

**Spec S04: The `note()` helper** {#s04-note-helper}

```ts
export function note(label: string, value: unknown): void
```

Exported from `tests/app-test/_harness`. Prints exactly one line:

```
TUG-NOTE: {"label":"VERDICT","value":"3 rows, 2 visible"}
```

`value` is JSON-serialized; a value that fails to serialize is stringified. The recipe parses these out of `$TMPOUT` per file and both prints them under `Diagnostics:` and carries them into the JSON `notes` array.

**Spec S05: Human summary shape after Step 2** {#s05-summary-shape}

```
========================================================
APP-TEST SUMMARY
========================================================
Sweep:          explicit-files
Files run:      2
Files passed:   1
Files failed:   1
Wall time:      41s

Per-file results:
  [PASS] at0287-lens-row-action-not-a-pick.test.ts        (1/1)
  [FAIL] at0257-lens-session-reorder.test.ts              (0/3)

Diagnostics:
  at0287-lens-row-action-not-a-pick.test.ts
    VERDICT: banding reads from the CARD rows, not the header
    ROWHEIGHT: 28

Failures:
  at0257-lens-session-reorder.test.ts
    > dragging a session above another persists the new order
      TimeoutError: waitForCondition exceeded 5000ms
      script: "document.querySelectorAll(…).length === 3"
      at0257-lens-session-reorder.test.ts:118
========================================================
VERDICT: FAIL  (1/2 files green; 1 file(s) failed; 1/4 tests passed)
```

Rules: the `Diagnostics:` section is omitted entirely when no notes were emitted; each failure carries at most the first error/assertion block plus one locator, so a file with ten identical timeouts does not reprint them.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugutil/src/commands/file_edit.rs` | `tugutil file edit` implementation (Spec S01) |
| `tugrust/crates/tugutil/src/commands/file_probe.rs` | `tugutil file probe` implementation (Spec S02) |

(If `commands/file.rs` stays comfortably under ~900 lines with both folded in, keeping them in `file.rs` beside `run_rm`/`run_mv`/`run_cp` is acceptable — the `Receipt` type they share lives there. Prefer whichever keeps the receipt type private to one module.)

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `in_place_editor_ops` | fn | `tugchanges-core/src/shell_ops.rs` | Generalized from `sed_ops`; takes the verb so `perl`'s `-e`/`-E` and `sed`'s `-e`/`-f` argument-consuming flags are both handled |
| `sed_ops` | fn | `tugchanges-core/src/shell_ops.rs` | Becomes a thin caller of `in_place_editor_ops`, or is replaced by it |
| `parse_segment` | fn | `tugchanges-core/src/shell_ops.rs` | New `"perl" \| "ruby"` match arm beside `"sed"`; refuses on non-literal operands ([P07]) |
| `FileCommands::Edit` | enum variant | `tugrust/crates/tugutil/src/cli.rs` | `--patch`, `--path`, `--replace`, `--with`, `--count`, `--regex` |
| `FileCommands::Probe` | enum variant | `tugrust/crates/tugutil/src/cli.rs` | `--patch`, `--path` (repeatable), trailing `-- <cmd…>` |
| `run_file` | fn | `tugrust/crates/tugutil/src/commands/file.rs` | Two new match arms |
| `Receipt::modified` | method | `tugrust/crates/tugutil/src/commands/file.rs` | Beside `deleted`/`renamed`/`created` |
| `run_gate` | fn | `tugrust/crates/tugutil/src/commands/file.rs` | Step 6: its unconditional "Use `tugutil file rm\|mv\|cp` instead…" suffix must become refusal-aware, or an in-place-editor deny steers at the wrong verb ([P07]) |
| `note` | fn | `tests/app-test/_harness/index.ts` | Spec S04 |
| `app-test` | just recipe | `Justfile` | Quiet default, `Diagnostics:`, per-failure detail, JSON channel |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/tracking-changes.md` — add `perl -i`/`ruby -i` to the `cmd`-origin grammar list beside `sed -i`; add `tugutil file edit` to the verb-receipts section; state that `tugutil file probe` deliberately records nothing and why ([P03]).
- [ ] `tests/app-test/README.md` — document quiet-by-default, `TUG_APPTEST_STREAM`, `TUG_APPTEST_JSON`, and `note()`.
- [ ] `CLAUDE.md` — a short subsection steering shell edits to `tugutil file edit` / `probe`, naming the attribution consequence of a `python3` heredoc explicitly (this is the only lever on the 324-call heredoc bucket, per [P07]).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | Grammar arms, operand refusal, receipt shape | `shell_ops.rs` and `commands/file*.rs` inline `#[cfg(test)]` modules, matching the existing convention |
| **Integration (Rust)** | Verbs against a real temp git repo | `tugrust/crates/tugutil/tests/`, alongside `changes_cli.rs`; `commands/file.rs`'s existing tests already build repos with `init_repo`/`commit_all` — reuse those helpers |
| **App-test** | The harness change is verified by running the harness | `harness-smoke/smoke.test.ts` gains a `note()` call; the summary is asserted from the recipe's own output |
| **Contract** | JSON output validates against Spec S03 | A shell assertion in the checkpoint, not a new test file |

#### What stays out of tests {#test-non-goals}

- **No mock relay.** The receipt→row path is already covered by `attribution.rs`'s tests (`a_receipt_is_read_out_of_the_surrounding_output`, `receipt_scanning_tolerates_absence_and_growth_but_flags_malformed_json`); Steps 4–5 add no tugcast code, so re-testing it with a fake would test nothing real.
- **No end-to-end app-test for `file edit` attribution.** App-test instances run against a transient workspace whose changeset entries live ~2s, so a full UI round trip is not observable there; the Rust integration layer is the right home.
- **No test asserting the exact byte layout of the human summary.** It is prose for people; the JSON channel (Spec S03) is the contract, and that is what gets asserted.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | `perl -i` / `ruby -i` join the shell-ops grammar | done | `4c1ba8785` |
| #step-2 | App-test: quiet by default, diagnostics, per-failure detail | done | `b32b441b2` |
| #step-3 | App-test: JSON output channel | done | `0b0cf3452` |
| #step-4 | `tugutil file probe` — atomic patch, run, restore | done | `1efe37b15` |
| #step-5 | `tugutil file edit` — receipt-emitting substitution | done | `a245ffb9c` |
| #step-6 | Gate the provable in-place editors; steer the rest | done | `ddcd0860e` |
| #step-7 | Doctrine and docs | done | `4c4ac5d94` |
| #step-8 | Integration checkpoint | done | `de6a71124` |

---

#### Step 1: `perl -i` / `ruby -i` join the shell-ops grammar {#step-1}

**Commit:** `tugdash(tracking-changes): read perl -i and ruby -i as proof-class in-place edits`

**References:** [P01] perl in the grammar, Risk R01, Table T01, (#corpus-findings, #receipt-path)

**Artifacts:**
- Generalized in-place-editor parsing in `tugchanges-core/src/shell_ops.rs`
- Unit tests for the flag forms observed in the corpus

**Tasks:**
- [ ] Generalize `sed_ops` into `in_place_editor_ops(verb, words, cwd)`: it must handle the combined-cluster in-place flag (`-i`, `-pi`, `-0pi`, `-i.bak`), the BSD `-i ''` separate-suffix form already implemented, and the argument-consuming expression flags (`-e`/`-f` for `sed`; `-e`/`-E` for `perl` and `ruby`).
- [ ] Keep the `have_expr` rule: absent an `-e`/`-E`/`-f`, the **first** non-flag operand is the script, and everything after it is a file operand. This is what prevents `perl -pi -e 's/a/b/' x.ts` and `perl -pi 's/a/b/' x.ts` from both being read as one-file commands with the wrong file.
- [ ] Add `"perl" | "ruby"` arms to `parse_segment` beside `"sed"`, all three routing through the new helper.
- [ ] Make the arms **refuse** (`SegmentOutcome::Refuse`) when in-place is set and any file operand is non-literal, so `parse_shell_ops` returns `Unparseable` and the gate denies ([P07]). `sed`'s current behavior silently filters non-literal operands — change it to refuse for consistency, and note this makes `sed -i … *.ts` a gate deny where it previously passed.
- [ ] Confirm no change is needed in `tugcast/src/feeds/attribution.rs`: `op_for_row` already maps `DeclaredKind::EditInPlace` to `"modified"`.
- [ ] Expect a wrong steering *reason* between this step and #step-6: `run_gate` appends "Use `tugutil file rm|mv|cp` instead…" to every refusal, so a denied `perl -i … *.ts` will suggest the wrong verb until #step-6 makes the suffix refusal-aware. The *decision* is correct from this step on; only the wording lags. Do not fix it here — the corrected wording needs `tugutil file edit` (#step-5) to exist first.

**Tests:**
- [ ] `perl -i -pe 's/a/b/' src/x.ts` → one `EditInPlace` op on the resolved absolute path.
- [ ] `perl -0pi -e 's/a/b/' src/x.ts` and `perl -pi -e '…' a.ts b.ts` → correct op count and paths.
- [ ] `perl -i.bak -pe '…' src/x.ts` → the suffix is not read as a file.
- [ ] `perl -i -pe '…' src/*.ts` and `perl -i -pe '…' "$F"` → `Unparseable`.
- [ ] `ruby -i -pe '…' src/x.ts` → one op.
- [ ] The existing `sed` tests still pass; add `sed -i '' 's/a/b/' src/*.ts` → `Unparseable`.
- [ ] A `perl` invocation with no in-place flag (`perl -e 'print 1'`) → `NoFileOps`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugchanges-core`
- [ ] `cd tugrust && cargo build` (warnings are errors)
- [ ] `tugutil file gate --command "perl -i -pe 's/a/b/' src/x.ts"` prints `"decision":"allow"`; the same with `src/*.ts` prints `"decision":"deny"`.

---

#### Step 2: App-test — quiet by default, diagnostics, per-failure detail {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(app-test-output): quiet by default; surface test notes and per-failure detail in the summary`

**References:** [P04] quiet default, [P05] note sentinel, Spec S04, Spec S05, Table T04, [Q01] progress heartbeat, (#apptest-grep-analysis)

**Artifacts:**
- `note()` exported from `tests/app-test/_harness/index.ts`
- Rewritten output handling in the `app-test` recipe in `Justfile`
- A `note()` call in `harness-smoke/smoke.test.ts` so the channel is exercised on every core-tier run

**Tasks:**
- [ ] Add `note(label, value)` to `tests/app-test/_harness/index.ts` per Spec S04 and export it. Bump `EXPECTED_SURFACE_VERSION` if the harness's version contract covers the export surface.
- [ ] In the `app-test` recipe's per-file loop, replace `bun test "$f" 2>&1 | tee "$TMPOUT"` with a quiet redirect to `$TMPOUT`, gated so `TUG_APPTEST_STREAM=1` restores the `tee`. Preserve `PIPESTATUS`-equivalent exit-code capture and the deliberate absence of `set -e`.
- [ ] Read the stream decision from the environment only — **do not add a `--stream` flag**. `{{FILES}}` is consumed verbatim by the pre-gate approval phase (`select-tests.ts --foreground $ASK_FILES`) before any post-gate stripping could run, so a pseudo-file argument would be handed to the selector as a filename ([P04]).
- [ ] After each file, extract `TUG-NOTE:` lines from `$TMPOUT` into a per-file notes array.
- [ ] After each **failing** file, extract per-failing-test detail from `$TMPOUT`: the `(fail) …` title, the first associated error/assertion block (the `Expected:`/`Received:`/`TimeoutError:`/`script:` lines), and a `file:line` locator. Cap at the first block per test so repeated identical timeouts do not reprint (Spec S05).
- [ ] Render a `Diagnostics:` section between `Per-file results:` and `Failures:`, omitted entirely when no notes exist. Notes print for passing files too ([P05]).
- [ ] Render the enriched `Failures:` block per Spec S05.
- [ ] Suppress the duplicated `error: Recipe \`app-test\` failed with exit code 1`. Cause: the recipe re-execs itself under the host gate (`exec … tugutil host gate run … -- just app-test {{FILES}}`), so both the inner and outer `just` report the failure. Fix by having the outer invocation exit with the child's status without `just` re-reporting — e.g. run the gate as a child and `exit "$?"` rather than `exec`, or silence the inner `just`'s error line.
- [ ] Verify `just app-test-changed`, `just app-test-all`, and `just app-test-smoke` still work — all delegate to this recipe.

**Tests:**
- [ ] `harness-smoke/smoke.test.ts` emits a `note()` and the value appears under `Diagnostics:`.
- [ ] A deliberately-failing scratch test (`tests/app-test/zz-probe.test.ts` or equivalent, deleted before commit) shows its assertion detail and locator under `Failures:`.

**Checkpoint:**
- [ ] `just app-test harness-smoke/smoke.test.ts` — summary only; `| grep -c '^(pass)'` returns `0`; the note appears under `Diagnostics:`.
- [ ] `TUG_APPTEST_STREAM=1 just app-test harness-smoke/smoke.test.ts` — the same command's `grep -c '^(pass)'` returns non-zero (today's output restored).
- [ ] `just app-test` (core tier) — 20/20 green, one summary, no duplicated `error: Recipe` line. Judge [Q01] here and record the answer in this plan.
- [ ] `cd tests/app-test && bunx tsc --noEmit` clean.

---

#### Step 3: App-test — JSON output channel {#step-3}

**Depends on:** #step-2

**Commit:** `tugdash(app-test-output): add a TUG_APPTEST_JSON result document`

**References:** [P06] JSON to file, Spec S03, Risk R03, (#apptest-grep-analysis)

**Artifacts:**
- JSON document emission from the `app-test` recipe

**Tasks:**
- [ ] Serialize the JSON per Spec S03 from the **same** `RESULT_ROWS` / failure-detail / notes arrays the human summary renders, in one pass ([R03]) — never by re-parsing printed text.
- [ ] Write only when `TUG_APPTEST_JSON` is set; leave stdout byte-identical either way.
- [ ] Use `jq -n` (already a hook dependency and present) or a small `bun` one-liner for serialization; whichever is chosen, escape test titles and error messages correctly — they contain quotes, newlines, and backslashes.
- [ ] Carry `sweep`, `wallSeconds`, `verdict`, `totals`, and per-file `status`/`passed`/`total`/`failures`/`notes`.

**Tests:**
- [ ] The document from a mixed pass/fail run parses with `jq` and its `totals` match the printed summary's numbers.

**Checkpoint:**
- [ ] `TUG_APPTEST_JSON=/tmp/at.json just app-test harness-smoke/smoke.test.ts && jq -e '.verdict == "PASS" and (.files | length) == 1 and (.files[0].notes | length) > 0' /tmp/at.json`
- [ ] `just app-test harness-smoke/smoke.test.ts > /tmp/a.txt; TUG_APPTEST_JSON=/tmp/at.json just app-test harness-smoke/smoke.test.ts > /tmp/b.txt; diff /tmp/a.txt /tmp/b.txt` — identical but for wall time.

---

#### Step 4: `tugutil file probe` — atomic patch, run, restore {#step-4}

**Depends on:** #step-3

**Commit:** `tugdash(tracking-changes): add tugutil file probe — patch, run, restore, record nothing`

**References:** [P03] probe records nothing, [P08] passthrough, [P09] snapshot restore, Spec S02, Risk R02, [Q02] probe on dirty files, Table T03, (#corpus-findings)

**Artifacts:**
- `FileCommands::Probe` in `tugrust/crates/tugutil/src/cli.rs`
- `run_probe` in `tugrust/crates/tugutil/src/commands/file.rs` (or `file_probe.rs`)
- Integration tests against a real temp git repo

**Tasks:**
- [ ] Add the `Probe` variant per Spec S02, with a trailing `-- <cmd…>` captured via clap's `trailing_var_arg` / `allow_hyphen_values`.
- [ ] Parse the patch's target paths (the `+++ b/<path>` headers) to learn what to snapshot; union with any `--path` operands.
- [ ] Snapshot bytes and mtime for each existing target into a temp directory; record which targets did **not** exist (those get removed on restore, [P09]).
- [ ] Apply with `git apply --check` then `git apply`; on `--check` failure exit non-zero having changed nothing.
- [ ] Run the command with stdout/stderr inherited ([P08]).
- [ ] Restore bytes **and mtime**, and remove created files, from a guard that runs on normal return, error return, and `SIGINT`/`SIGTERM` ([R02]). Resetting mtime is what makes [P03] true against `snapshot_worktree`'s status+mtime fingerprint.
- [ ] On restore failure, print a line naming the snapshot directory and exit non-zero regardless of the child's exit code.
- [ ] Emit no receipt ([P03]).
- [ ] Exit with the child's exit code on success.

**Tests:**
- [ ] Probe over a tracked file: content and mtime byte-identical after; the child's stdout reached the caller; exit code propagated.
- [ ] Probe over a file with **pre-existing uncommitted edits**: those edits survive intact ([Q02]).
- [ ] Probe whose patch creates a new file: the file is gone afterwards.
- [ ] Probe whose command exits non-zero: restore still happened, exit code is the child's.
- [ ] A patch that fails `--check`: nothing changed, non-zero exit, no receipt.
- [ ] No `TUG-FILE-RECEIPT` line appears in any probe's output.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil`
- [ ] `cd tugrust && cargo build`
- [ ] Manual: in a scratch clone, `tugutil file probe --patch /tmp/p.diff -- cat <target>` shows the patched content, and `git status --porcelain` is identical before and after.

---

#### Step 5: `tugutil file edit` — receipt-emitting substitution {#step-5}

**Depends on:** #step-4

**Commit:** `tugdash(tracking-changes): add tugutil file edit — attributable substitution and patch application`

**References:** [P02] modified receipts, [P10] patch primary, Spec S01, Table T02, (#receipt-path)

**Artifacts:**
- `FileCommands::Edit` in `tugrust/crates/tugutil/src/cli.rs`
- `run_edit` and `Receipt::modified` in `tugrust/crates/tugutil/src/commands/file.rs` (or `file_edit.rs`)

**Tasks:**
- [ ] Add `Receipt::modified(path)` beside `deleted`/`renamed`/`created`.
- [ ] Implement `--patch <FILE|->`: read the diff (stdin when `-`), `git apply --check`, then `git apply`; receipt one `modified` op per path whose bytes actually changed.
- [ ] Implement `--path/--replace/--with [--count N] [--regex]` per Spec S01. Literal substring by default; `regex` crate pattern with `--regex`, `$1` captures supported in `--with`.
- [ ] Exit non-zero with `no match` when `--replace` matches nothing, and emit no receipt — a silently-successful no-op edit is how a stale substitution hides.
- [ ] Emit exactly one receipt line covering all paths touched.
- [ ] Confirm no tugcast change is needed: `op_for_receipt` already maps `"modified"` (#receipt-path).

**Tests:**
- [ ] Single literal substitution changes the file and emits one `modified` op with an absolute path.
- [ ] `--regex` with a capture group in `--with`.
- [ ] `--count 1` replaces only the first occurrence.
- [ ] No-match exits non-zero and emits no receipt.
- [ ] A multi-file unified diff emits one receipt with one op per changed file.
- [ ] A patch naming a file it leaves byte-identical produces no op for that file.
- [ ] A patch that fails `--check` changes nothing and emits no receipt.
- [ ] Receipt JSON parses under `attribution.rs::parse_receipt_line` shape expectations (assert the serialized shape in the tugutil test; the relay side is already covered).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil`
- [ ] `cd tugrust && cargo build`
- [ ] Manual, in this repo from a live session: `tugutil file edit --path <some scratch file> --replace foo --with bar`, then confirm the file appears **attributed** (not unattributed) in the Changes card.

---

#### Step 6: Gate the provable in-place editors; steer the rest {#step-6}

**Depends on:** #step-5

**Commit:** `tugdash(tracking-changes): steer unreadable in-place edits to tugutil file edit`

**References:** [P07] gate scope, [P01] perl in the grammar, Risk R01, (#corpus-findings)

**Artifacts:**
- Refusal-reason wording in `tugchanges-core/src/shell_ops.rs`
- Refusal-aware steering in `run_gate` (`tugrust/crates/tugutil/src/commands/file.rs`)
- `CLAUDE.md` steering subsection

**Tasks:**
- [ ] Make the refusal reason produced by the in-place-editor arms name what refused and why, the way the rm/mv refusals do — e.g. ``"`perl -i` edits files this grammar cannot resolve"``.
- [ ] **Fix the steering suffix in `run_gate`.** It currently appends one hardcoded sentence to *every* `Unparseable` reason — "Use `tugutil file rm|mv|cp` instead — it expands the operands itself and reports exactly which files it touched, so the change stays attributed." After Step 1 that would steer a denied `perl -i … src/*.ts` at the wrong verb. Make the suggestion refusal-aware: preferred shape is to carry the suggested verb on the refusal itself (the grammar knows what refused — an in-place editor suggests `tugutil file edit`, an rm/mv-class refusal suggests `tugutil file rm|mv|cp`), with `run_gate` composing rather than hardcoding. A branch inside `run_gate` is acceptable if it keeps the two reasons from drifting.
- [ ] Verify `tugplug/hooks/gate-file-ops.sh` needs **no** edit: it only reads `.decision` and `.reason` out of `tugutil file gate`'s JSON, and both keys keep their shape. Confirm by running the hook's own path.
- [ ] Add a `CLAUDE.md` subsection: shell edits to repo files should go through `tugutil file edit` (or `probe` for patch-run-revert); a `python3` heredoc that writes a repo file is invisible to attribution and will land the file in `UNATTRIBUTED`. State the consequence, not just the rule — this is the only lever on the 324-call heredoc bucket ([P07]).
- [ ] Confirm the hook still fails open: with `tugutil` absent from PATH the hook exits 0.

**Tests:**
- [ ] Gate decisions for the matrix in #success-criteria: `perl -i` literal → allow; `perl -i` glob → deny; `sed -i` glob → deny; `python3 - <<'PY'` → allow.
- [ ] A denied `perl -i` command's reason string names `tugutil file edit` and does **not** name `rm|mv|cp`.
- [ ] A denied `rm` command's reason string still names `tugutil file rm|mv|cp` — the existing `the_gate_denies_only_what_the_grammar_cannot_read` test in `commands/file.rs` must keep passing, extended to assert the verb suggestion.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugchanges-core -p tugutil`
- [ ] `tugutil file gate --command "perl -i -pe 's/a/b/' src/*.ts" | jq -r .reason` names `tugutil file edit`.
- [ ] `tugutil file gate --command "rm \$F" | jq -r .reason` names `tugutil file rm|mv|cp`.
- [ ] `echo '{"tool_name":"Bash","tool_input":{"command":"perl -i -pe \"s/a/b/\" src/*.ts"}}' | bash tugplug/hooks/gate-file-ops.sh | jq -e '.hookSpecificOutput.permissionDecision == "deny"'`
- [ ] The same with a literal path produces no output (allow / fall through).

---

#### Step 7: Doctrine and docs {#step-7}

**Depends on:** #step-6

**Commit:** `tuglaws(tracking-changes): record the in-place-editor grammar, the edit verb, and the silent probe`

**References:** [P01], [P02], [P03], [P04], [P07], (#documentation-plan)

**Artifacts:**
- `tuglaws/tracking-changes.md`
- `tests/app-test/README.md`

**Tasks:**
- [ ] In `tuglaws/tracking-changes.md`, extend the `cmd`-origin grammar sentence that lists `sed -i` to include `perl -i` and `ruby -i`, and note the refusal-on-non-literal-operands behavior now applies to all three.
- [ ] In the verb-receipts subsection, add `tugutil file edit` and its `modified` op to the receipt example.
- [ ] Add a short paragraph stating that `tugutil file probe` deliberately records **nothing** — a restored probe changed nothing, and routing probes through it removes a class of false `bash` hints ([P03]).
- [ ] In `tests/app-test/README.md`, document quiet-by-default, `TUG_APPTEST_STREAM=1`, `TUG_APPTEST_JSON`, and `note()`.
- [ ] Do not hard-wrap prose in either document — one logical line per paragraph or bullet, matching the existing files.

**Tests:**
- [ ] None (documentation).

**Checkpoint:**
- [ ] `just app-test-covers-check` still passes (no `@covers` drift from Step 2's harness edit).
- [ ] Re-read `tuglaws/tracking-changes.md`'s capture-gap inventory and confirm no gap description became stale.

---

#### Step 8: Integration Checkpoint {#step-8}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P01]–[P10], Spec S01, Spec S02, Spec S03, (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk every criterion in #success-criteria and record the actual observed value.
- [ ] Confirm the whole edit-run-revert loop now composes without a shell pipeline: `tugutil file probe --patch /tmp/p.diff -- just app-test <one file>` prints a bounded summary, restores the tree, and leaves no ledger rows.
- [ ] Query the ledger for `origin='cmd'` rows minted by the new paths and confirm they are proof-class and correctly pathed: `just db-inspect changes "SELECT origin, tool_name, op, file_path FROM file_events WHERE origin='cmd' ORDER BY at DESC LIMIT 20;"`.

**Tests:**
- [ ] `cd tugrust && cargo nextest run` — whole workspace green, no warnings.
- [ ] `just app-test` (core tier) — green. This is warranted here rather than a selective run because Step 2 changes the recipe that runs before every test's first assertion, which is exactly the CORE TIER ADVISED case.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `just app-test`
- [ ] `just app-test-covers-check`
- [ ] `just db-inspect changes "SELECT origin, COUNT(*) FROM file_events WHERE at > (strftime('%s','now')-86400)*1000 GROUP BY origin;"` — `cmd` rows present, and the `bash`:`cmd` ratio improved against the 771:457 seven-day baseline recorded in #context.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Shell-authored file edits are attributable — provable in-place editors mint proof rows, receipt-emitting `edit` and silent `probe` verbs cover what the grammar cannot read, and the app-test harness reports its results without needing to be grepped, removing the economic reason those shell pipelines were written.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `perl -i` / `ruby -i` with literal operands produce proof-class `cmd` rows; with globs or variables they are denied by the gate and steered to `tugutil file edit`. (`cargo nextest run -p tugchanges-core`, plus the `tugutil file gate` matrix.)
- [ ] `just app-test <file>` prints only the summary; `Diagnostics:` carries `note()` values from passing runs; failures carry assertion detail and a locator. (`just app-test harness-smoke/smoke.test.ts`.)
- [ ] `TUG_APPTEST_STREAM=1` restores today's output exactly. (Diff against a pre-change capture.)
- [ ] `TUG_APPTEST_JSON=<path>` writes a Spec S03 document and leaves stdout unchanged. (`jq -e` assertion plus a stdout diff.)
- [ ] `tugutil file probe` restores byte- and mtime-identical content and writes zero ledger rows. (`cargo nextest run -p tugutil`, plus a `db-inspect` check.)
- [ ] `tugutil file edit` produces a `modified` receipt that the live relay turns into an `origin='cmd'` row, visible as an **attributed** file in the Changes card. (Manual verification in a live session.)
- [ ] `tuglaws/tracking-changes.md`, `tests/app-test/README.md`, and `CLAUDE.md` describe the new surfaces.
- [ ] Whole workspace green with no warnings, core tier green. (`cargo nextest run`, `just app-test`.)

**Acceptance tests:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `just app-test`
- [ ] `TUG_APPTEST_JSON=/tmp/at.json just app-test harness-smoke/smoke.test.ts && jq -e '.verdict == "PASS"' /tmp/at.json`

#### Observed at close {#observed-at-close}

Every criterion in #success-criteria, with what was actually measured at #step-8.

| Criterion | Observed |
|---|---|
| `perl -i` literal → `Ops(EditInPlace)`; glob → `Unparseable` | Both, plus `-0pi`, `-pi … a.ts b.ts`, `-i.bak`, `ruby -i`, and `sed -i '' … *.ts` → refuse. `tugchanges-core` 84/84 |
| `just app-test <green file>` prints no raw bun body | 21 lines total for the smoke file, `grep -c '^bun test v'` = **0** (was several hundred lines including the dist build's stderr). Under `TUG_APPTEST_STREAM=1`, **1** |
| A `note()` value appears under `Diagnostics:` on a **passing** run | `SURFACE: 1.8.0` from `harness-smoke/smoke.test.ts`, on every green core-tier run |
| A failing summary carries the assertion/error text and a locator | Both: an `expect` failure shows `Expected:`/`Received:` + `zz-probe.test.ts:14:49`; a thrown `TimeoutError` shows the message and the failing script text. (`^error:`-prefixed *and* bare `SomeError:` forms are read — the second was found and fixed by observation, having produced an empty message on the first core-tier run) |
| `TUG_APPTEST_JSON` writes Spec S03; stdout unchanged | `jq -e '.verdict == "PASS" and (.files\|length) == 1 and (.files[0].notes\|length) > 0'` passes; stdout diffs identical but for wall time; a mixed run's `totals` match the printed summary exactly |
| `probe` restores byte-identical and writes **zero** rows | 7 integration tests (bytes, mtime, `git status --porcelain=v2` identical, pre-existing dirt survives, created file removed, exit code propagates, failed `--check` changes nothing). Live: `probe --patch … -- just app-test …` left `git status` unchanged and the ledger shows **no** rows for the probed file |
| `edit` mints `origin='cmd'` through the live relay | Ran the verb from a live session; ledger shows `cmd\|Bash\|modified\|tugdeck/scratch-edit-check.txt` — proof class |
| Gate matrix | `perl -i` literal → allow; `perl -i` glob → deny; `sed -i` glob → deny; `python3` heredoc → allow. The denied `perl -i` reason names `tugutil file edit` and `probe`; a denied `rm $F` still names `rm\|mv\|cp`. Hook denies, allows, and fails open with `tugutil` off `PATH` |
| Whole system green | `cargo nextest run` **1847/1847**; `just app-test` (core tier) 19/20 — `at0145-permission-dialog-keyboard` fails **identically on the unmodified base checkout**, a screen-taker running without focus approval, pre-existing and unrelated |
| Unattributed bucket shrinks in practice | **Not yet measurable** — needs a working week against the 30–62/day `origin='claim'` baseline. 24h distribution at close, for comparison: `exact` 659, `bash` 243, `turn` 127, `cmd` 117, `claim` 62, `replay` 57 |

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Resolve [Q01] — add a TTY-conditional progress heartbeat if the silent core-tier run proves annoying in practice.
- [ ] Migrate existing `console.log("VERDICT", …)` / `PROBE` / `DBG` call sites in `tests/app-test/*.test.ts` to `note()` opportunistically, as each test is next touched.
- [ ] Consider a `tugutil file edit --multi` taking a JSON array of substitutions, if the `--patch` form proves too heavy for the 78 + 79 two-and-three-substitution shapes (Table T02).
- [ ] Re-measure the corpus after a working week and compare `origin='claim'` rows/day against the 30–62/day baseline; if the heredoc bucket has not moved, revisit the [P07] decision to steer rather than gate.
- [ ] **A quoted receipt mints rows** — found at #step-8, pre-existing and out of scope here. The relay scans every successful Bash `tool_result` for `TUG-FILE-RECEIPT: `, so a command that merely *prints* the sentinel mints rows from it: reading this repo's own doc surfaced `cmd` rows for `/abs/a.ts`, `/abs/new.ts`, `/abs/old.ts` — the example paths in `tuglaws/tracking-changes.md`'s receipt block. Harmless as observed (a path that does not exist can never join `git status`, so it never reaches a bucket), but the shape is not sound: a session that `cat`s a log or transcript carrying another session's real receipt would mint proof-class rows for *those* files under its own id, which the Who axiom is supposed to make impossible. Worth a corroboration rule — the relay could require a receipt's paths to intersect the call's own bracket delta, which is exactly the live `cmd` mint rule already applied to parsed operands, and would cost the verbs nothing since they really do touch what they name.

| Checkpoint | Verification |
|------------|--------------|
| Grammar widened | `cargo nextest run -p tugchanges-core`; `tugutil file gate` matrix |
| Harness quiet and complete | `just app-test harness-smoke/smoke.test.ts`; `grep -c '^(pass)'` returns 0 |
| JSON contract | `jq -e` against Spec S03 |
| Probe leaves no trace | `git status --porcelain` identical before/after; zero new `file_events` rows |
| Edit is attributable | `tugutil file edit …` then the file reads attributed in the Changes card |
| Whole system green | `cargo nextest run`; `just app-test` |

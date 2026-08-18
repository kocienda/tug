## Close the Dash Backend Campaign {#close-backend-campaign}

**Purpose:** Finish the three bounded pieces of work left by [`closing-dash-backend-issues-brief.md`](closing-dash-backend-issues-brief.md) — a truthful resolution review, deterministic and legible lane fixtures, and a refreshed release instance — and declare the dash backend campaign closed.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-16 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-16, opus.** Reviewed `plan:a2f9b14a6797ddf9`. Lint: 0 errors, 0 warnings (clean on arrival and after every fixup).
Oriented on: the whole document — a first round, `rounds: 0`.
Applied: three findings, each grounded in code read this round rather than in the plan's own prose. **Technical choice ([P01])** — the plan proposed a second `git diff --numstat` subprocess per resolved path beside the existing one; `git diff --numstat --patch` returns both from a single invocation (verified on a scratch repo: `"<added>\t<removed>\t<path>"`, blank line, then the patch; binary reports `-\t-\t<path>`). Rewrote [P01] and Spec S01 around one call, dropped the `resolution_numstat` symbol, and added the parsing hazard the merge creates — `resolution_diff`'s emptiness check must run against the patch body after the numstat line is split off, or the "no diff ⇒ `None`" contract breaks and `resolutionDiffPayload`'s filter starts admitting empty rows. Also corrected "audit construction sites" to the one site that exists. **Hole ([P04])** — the leftover-dash sweep would have written fixture garbage into the developer's checkout: `ops::release_in` runs `working_set_hand_back`/`apply_hand_back`, which copies a dash worktree's *uncommitted* files back to the base so a teardown cannot destroy typed work; a fixture stranded between at0426's `writeFileSync` and its `commitRound` would deposit its placeholder body over a real source file. Added a hard-reset + clean of the fixture worktree before the release, noted that deletions were already safe (`HandBack.deletions` is never handed back, so at0425 was never exposed), and that best-effort must stay because `release_in` legitimately refuses on a base-side conflict. **Pitfall ([P02])** — pinning the conflict subject *introduces* a flake it does not have today: with the base side stable and at0426's dash-side body a fixed string, the conflict recurs identically, so an `rr-cache` entry surviving a killed run (its `afterAll` is skipped when `beforeAll` throws) replays at rung 2, ahead of the driver at rung 4, and `expect(reviewText).toContain("driver")` fails. Added a per-run nonce in the dash-side body only, since `DRIVER_BODY` is asserted verbatim. Also: distinguished at0425's reason for adopting the shared helper (determinism — its delete/modify conflict short-circuits before any diff, so the cap never bit it) from at0426's (the truncation defect itself), so nobody hunts a truncation bug in at0425; added two risk rows; extended the Step 5 gate to check `git status --porcelain` and `rr-cache` between runs, which is what would catch the two hazards above if a mitigation regressed; and named the tuglaws cross-check explicitly — [L02] honored via the store's existing `useSyncExternalStore` face, [L06] honored by its own data carve-out rather than by accident, [L19] untouched since the review still renders through the shared `TugDiffDocument`.
Deferred: nothing. The plan arrived with no Open Questions and none were raised — the three questions the brief left open were settled by investigation before authoring, and this round's findings were all settleable from the code.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The eleven-step backend program landed on `main` as `5ba5ce400`. Its own verification left three findings, recorded in the brief: `at0426-dash-resolution-review` red on `main`, an apparent ladder defect behind it (the face reporting "1 file resolved by driver" over a `+0 −395` candidate), and the five dash-lane app-test files failing 3-of-5 when run in one invocation with a blank `tugutil dash create … failed:` message. Separately, the live release Tug.app instance predates the landed clock and route fixes, so its dash-log lines still stamp `2025` and record route-less terminals.

The pre-plan investigation for this document re-diagnosed all three, and two of the brief's mechanism claims turned out wrong. This plan bakes in the corrected diagnoses (see [Deep Dives](#deep-dives)) so no implementer re-litigates them:

- **There is no ladder correctness defect.** The driver rung genuinely resolved `Justfile`; the `+0 −395` is a presentation lie. `resolve.rs` caps each review diff at `DIFF_LINE_CAP = 400` lines, and the frontend computes its stat by counting `+`/`−` lines in the *truncated* text ([#the-0-395-mechanism](#the-0-395-mechanism)).
- **The lane files did not fail from concurrency.** The `justfile` `app-test` recipe runs files sequentially — one `bun test <file>` per loop iteration, the whole invocation behind a machine-wide port gate. The brief's "serialization marker" fix would change nothing and is dropped ([#the-lane-run-was-sequential](#the-lane-run-was-sequential)).
- **The fixture does capture stderr.** `Bun.spawnSync` pipes stderr by default (verified empirically), and `tugutil` prints `error: <e>` to stderr on every `Err` exit. A blank failure therefore means the process died without reaching its own error path — a signal or an abort — and the fix is a throw message that carries exit code, signal, and both streams ([#the-blank-failure](#the-blank-failure)).

#### Strategy {#strategy}

- Fix legibility first: make a lane-fixture failure name its exit code, signal, and output before chasing the transient that produced one. Evidence before theory.
- Make a red run self-healing: the `app-test` recipe sweeps leftover `tugdash/at04*` fixture dashes so one failed `beforeAll` cannot poison the next invocation.
- Make the review stat the truth: real `git diff --numstat` counts ride `FileResolution`; the frontend renders them and the count-the-truncated-text path is deleted.
- Make the lane fixtures deterministic: at0425 and at0426 pin their conflict subject to a *small* file via one shared helper, so the suite's outcome stops depending on what `main` last touched.
- Verify at the end the way the campaign will be judged: the five lane files, one invocation, three consecutive green runs.
- The release-instance refresh is the closing gesture, run last and from `main`, because it restarts the live app — including the Session card this work is likely being driven from.

#### Success Criteria (Measurable) {#success-criteria}

- One `just app-test` invocation naming all five lane files (`at0405`, `at0417`, `at0418`, `at0425`, `at0426`) reports 5/5 files passed, on three consecutive runs. (Read the recipe's own summary table; never pipe it.)
- `cargo nextest run` is green workspace-wide, including a new tugdash-core test proving a resolution larger than `DIFF_LINE_CAP` reports its full added/removed counts alongside a truncated diff body.
- An induced `tugutil` fixture failure throws a message containing the exit code and both streams — verified once by hand during implementation, then by reading any real failure that occurs.
- A deliberately leftover `tugdash/at0499-*` branch is gone after the next `just app-test` invocation completes.
- After `just app-release`, `just instances` lists a release instance with a fresh start time, and the next dash-log line written stamps year `2026` and carries a route suffix (`via cli` / `via card`).

#### Scope {#scope}

1. `tests/app-test/dash-fixture.ts` — failure legibility, retry breadth, a shared retrying `git` helper, and a shared small-conflict-subject helper.
2. `tests/app-test/at0425-dash-conflicted-landing.test.ts` and `at0426-dash-resolution-review.test.ts` — adopt the shared helpers; pin the conflict subject.
3. `justfile` — the `app-test` recipe sweeps leftover fixture dashes.
4. `tugrust/crates/tugdash-core/src/resolve.rs` — real numstat counts on `FileResolution`.
5. `tugdeck/src/lib/changeset-join-store.ts` and `tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-landing.tsx` — render the server's counts; delete `countStat`.
6. The release-instance refresh and the brief's closing status update.

#### Non-goals (Explicitly out of scope) {#non-goals}

- The Join sheet caught live (brief item 5). It stays a tripwire; its capture protocol is in the brief and nothing here pre-builds a fix.
- The deferred lifecycle items (brief item 7): queue-a-landing-for-turn-end, the replay affordance, post-rebase checkpoint runs. Pull-driven by the UI campaign.
- Raising or redesigning `DIFF_LINE_CAP` semantics (head+tail elision so a huge resolution still shows its additions). Listed as a follow-on ([#roadmap](#roadmap)); the truthful stat plus the pinned small fixture covers both the live UX and the test.
- Any change to the resolution ladder's rungs or ordering in `resolve.rs`. The investigation cleared them.

#### Dependencies / Prerequisites {#dependencies}

- `main` at or after `5ba5ce400` (the eleven-step program landed).
- A built app-test bundle; `just build-app` after any Rust change, because the app-test recipe refreshes dist but never rebuilds binaries.

#### Constraints {#constraints}

- **This plan executes directly on `main`, not on a dash.** The prior campaign made the `app-test` recipe refuse to run from a dash worktree — for the structural reason that every `tugutil dash` verb resolves the *main* repo root, so lane-fixture dashes created from a worktree are invisible to the app under test. The lane files are this plan's checkpoint, so a dash worktree cannot verify this work; `TUG_APPTEST_ALLOW_WORKTREE=1` does not help because the refusal's root cause is exactly the lane fixtures. The prior program hit this and had to defer its lane verification until after its join. Steps here land as ordinary `main` commits via the user's landing gestures, and every checkpoint is runnable in place.
- Warnings are errors (`-D warnings` via `tugrust/.cargo/config.toml`).
- App-test output is the report: run recipes bare; `TUG_APPTEST_JSON=<path>` for machine-readable results; never pipe the run into a filter.
- Unattended lane runs use `TUG_APPTEST_ASSUME=background` (none of the five lane files takes the screen).
- Only the user commits, unless autonomous execution is explicitly authorized.

#### Assumptions {#assumptions}

- The transient that broke `dash create` mid-run (blank stderr, at0418's `beforeAll`) is rare and retry-or-report is the right posture; if it recurs after this plan, the failure message will finally say what it is.
- tugdeck and tugcast ship together, so `FileResolution`'s new fields need no cross-version fallback in the store.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None. The three questions the brief left open — is the ladder lying, why is the failure blank, what makes the lane files interfere — were settled by the pre-plan investigation and are recorded as [Deep Dives](#deep-dives).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| The blank-failure transient recurs and is *not* a retryable git collision | med | low | Retries stay bounded; the throw now names exit code, signal, and both streams, so the next occurrence is a diagnosis, not a mystery | Any lane run red on a fixture verb after this plan lands |
| A pinned conflict lets a stale `rr-cache` entry replay ahead of the driver rung | med | med | Per-run nonce in at0426's dash-side body ([P02]); `afterAll` cleanup stays | at0426 red with `resolved by rerere` on the review line |
| The leftover sweep hands fixture dirt back into the developer's checkout | high | low | Hard-reset + clean the fixture worktree before releasing ([P04]) | Any unexplained working-tree modification after an app-test run |
| `just app-release` restarts the live instance mid-session | med | certain | It is the last step, explicitly the user's gesture, run when nothing else is in flight | — |
| A binary or rename resolution has no numstat counts | low | low | `added`/`removed` are optional; absent counts render as no stat rather than a wrong one | A review face showing a blank stat over a text file |

**Risk R01: The transient was a crash, not a lock** {#r01-transient-is-a-crash}

- **Risk:** The at0418 `dash create` death (non-zero exit, empty stderr) may be a `tugutil` crash or an external kill, which retrying cannot fix.
- **Mitigation:** The widened retry only retries *recognized* transient git failures; everything else throws immediately with full evidence. The leftover-dash sweep makes the blast radius one red file, not a poisoned next run.
- **Residual risk:** The root cause stays unknown until it recurs — accepted, because it is now cheap to catch.

---

### Design Decisions {#design-decisions}

#### [P01] The resolution stat comes from git, not from the truncated diff text (DECIDED) {#p01-stat-from-numstat}

**Decision:** `FileResolution` gains optional `added`/`removed` counts, obtained from the **same** `git diff` invocation that already produces the diff text by adding `--numstat --patch`; the review face renders those counts, and the frontend's `countStat` (counting `+`/`−` lines in the capped unified text) is deleted.

**Rationale:**
- The `+0 −395` incident: the capped text is a *view*, and deriving the stat from a view makes the stat lie exactly when the diff is big enough to matter.
- `git diff --numstat --patch` emits the numstat line, a blank line, then the patch — verified against a scratch repo. One subprocess yields both answers, so this costs nothing over today's single `git diff` per path, and the count can never disagree with the text it describes (a second invocation could, if the candidate moved between them).
- git's own counts are the canonical answer: binary paths report `-\t-\t<path>` (verified) rather than a fabricated line count, and renames come out in git's form rather than a hand-rolled one.

**Implications:**
- `resolution_diff` changes shape: it returns the diff text plus the two optional counts (a small struct, not a bare `String`). Its emptiness check must run against the **patch body after the numstat line is split off**, or the "a resolution with no diff is dropped" behavior breaks — and the frontend depends on it (`resolutionDiffPayload` filters `file.diff !== null`).
- `FileResolution` serializes two new optional fields. `agent_supervisor` sends the whole outcome through `serde_json::to_value(&outcome)`, so the wire carries them with no new code there.
- There is exactly **one** `FileResolution` construction site (in `resolution_report`) — no audit sweep is needed.
- `changeset-join-store.ts`'s `ResolvedFile` reads them; `resolutionDiffPayload` in `session-changes-dash-landing.tsx` uses them for `GitDiffFile.added/removed` and the payload totals.
- The `DIFF_LINE_CAP` head-only truncation and its `… N more lines` marker stay as-is; they are now harmless to the stat.

#### [P02] The lane fixtures pin a small conflict subject via one shared helper (DECIDED) {#p02-small-conflict-subject}

**Decision:** `dash-fixture.ts` exports a helper that walks `main`'s recent first-parent history and returns the newest `(commit, file)` pair where the commit modified a text file whose blob at that commit is at most 120 lines; at0425 and at0426 both use it in place of their private newest-modified-commit derivation.

**Rationale:**
- at0426's premise is a *content* conflict whose resolution is reviewable on screen; against a 2050-line subject the capped diff cannot show the resolution, so the suite's outcome flips with whatever `main` last touched — fixture drift, proven by probe (pinning a small file made at0426 pass, unmodified).
- at0425 is a **delete/modify** conflict, which `raw.load` short-circuits to unresolved before any rung or diff runs, so the cap never bit it. It adopts the helper for determinism and one derivation instead of two copies — not because it has a truncation defect. An implementer should not go looking for one there.
- Deriving-with-a-size-bound keeps the property the original derivation was chosen for: the rewind stays shallow (minimal divergence, cheap `merge-tree`, small archaeology), and nothing is hardcoded to a sha that ages.

**Implications:**
- Both files rewind to the *returned* commit's parent, which may be a few commits older than tip when recent commits only touched large files. The helper caps its walk (25 commits) and throws a named error if nothing qualifies, so an exotic history fails loudly.
- at0425's `baseSubject` archaeology assertion reads the returned commit's subject, exactly as it reads the derived one today.
- **Pinning makes at0426's conflict text stable across runs, which arms a stale-rerere flake** — so at0426's dash-side body must carry a per-run nonce. Today the base side moves with `main`, so a leftover `rr-cache` entry rarely matches; a pinned subject plus at0426's fixed dash-side string (`"at0426 dash side — the whole file, rewritten"`) makes the same conflict recur exactly. rerere is **rung 2** and the driver is **rung 4**, so a surviving entry short-circuits ahead of the driver, `resolved_by` comes back `rerere`, and the test's `expect(reviewText).toContain("driver")` fails. at0426's `afterAll` removes only the entries its run added — and `afterAll` is skipped when `beforeAll` throws or the run is killed, which is exactly the situation this plan is hardening against. A nonce in the dash-side body (not in `DRIVER_BODY`, which is asserted verbatim) makes the conflict key unique per run, so no stale entry can ever match.

#### [P03] Fixture failures carry the whole corpse (DECIDED) {#p03-legible-failures}

**Decision:** `dash-fixture.ts`'s `tugutil()` throw message includes the exit code, the signal code when present, stderr, and the tail of stdout; the retry predicate widens from `index.lock` / `Another git process` to a named set of transient git lock messages; and the per-file `git()` retry helpers privately duplicated in at0425/at0426 are replaced by one exported `gitRetry()` with the same predicate.

**Rationale:**
- The at0418 failure arrived as `… failed:` with nothing after the colon — not because stderr was unpiped (it is piped; verified) but because the message only quoted stderr and the process died without writing any. Exit code and signal were in hand and discarded.
- `--json` verbs put refusals on stdout inside the JSON envelope; a message that omits stdout hides exactly the refusals the verbs work hardest to phrase.

**Implications:**
- The transient set is a literal list in one place: `index.lock`, `Another git process`, `could not lock`, `Unable to create` + `.lock`, `cannot lock ref`. Anything else fails fast with evidence.
- Three copies of retry logic become one.

#### [P04] A red run heals on the next invocation (DECIDED) {#p04-leftover-sweep}

**Decision:** The `justfile` `app-test` recipe's clean-slate preamble releases any leftover `tugdash/at04??-*` fixture dash, best-effort — **first hard-resetting and cleaning that dash's own worktree**, so the release has no uncommitted work to hand back.

**Rationale:**
- A failed `beforeAll` can strand its dash; the stranded branch then breaks the *next* run differently, which is how one transient became "the lane files cannot run together".
- The `at04` prefix is the lane fixtures' own namespace; a user dash can never match it, and every lane file already begins with `releaseDash` for its own name — this is the same idea at recipe scope, covering names the current selection does not include.
- **The reset is not optional.** `ops::release_in` calls `working_set_hand_back` / `apply_hand_back`, which **copies the dash worktree's uncommitted files back into the base checkout** so a teardown cannot destroy work typed in a worktree. That is right for a real dash and wrong for a fixture: a dash stranded between at0426's `writeFileSync` and its `commitRound` would deposit `"at0426 dash side — the whole file, rewritten"` over a real source file in the developer's checkout, as an uncommitted modification. Resetting the fixture worktree first makes the hand-back a no-op. The reset is scoped to `.tug/worktrees/<name>`, which by construction holds only fixture state.

**Implications:**
- The sweep runs only where the recipe already runs (the main checkout — the worktree guard precedes it) and only when `tugrust/target/debug/tugutil` exists, which the gate already ensures.
- Best-effort is the right posture and must stay: `release_in` legitimately **refuses** when the base checkout holds its own uncommitted edit to a path the dash also changed, and a refused sweep must never fail the run.
- Deletions are already safe without the reset (`HandBack.deletions` is deliberately never handed back, so at0425's deleted file cannot be resurrected onto the base) — the reset is for the write case.

#### [P05] The release refresh is the closing gesture, run last (DECIDED) {#p05-refresh-last}

**Decision:** `just app-release` runs as the final step, from the main checkout, after everything else has landed — explicitly framed as the act that closes the campaign.

**Rationale:**
- The recipe quits the prior release instance first by design; run mid-plan it would kill the live Session card the work is being driven from.
- Run last, one refresh picks up both the already-landed clock/route fixes *and* this plan's tugcast/tugdeck changes, instead of refreshing twice.

**Implications:**
- Until this step runs, the live instance keeps stamping `2025` — expected, not a regression.

---

### Deep Dives (Optional) {#deep-dives}

#### The `+0 −395` mechanism {#the-0-395-mechanism}

The at0426 failure text captured the whole chain. The stub driver resolved `Justfile` (2050 lines on the base side) to its one-line body, so the true diff is `−2050 +1` in a single hunk, deletions first. `resolve.rs::resolution_diff` keeps the first `DIFF_LINE_CAP = 400` lines: 4 file-header lines + 1 hunk header + **395 deletion lines**, then appends `… N more lines`. The single `+` line — the driver's actual decision — falls past the cap. `session-changes-dash-landing.tsx::countStat` then counts `+`/`−` over that truncated text and reports `+0 −395`, and the test's `toContain("at0426 resolved by the stub driver")` fails because the decision is not in the rendered text. The ladder's candidate was correct throughout; `patch_tree`/`commit_tree` and the rung report were never wrong. Two fixes fall out: the stat must come from the real diff ([P01]), and the fixture must not pick a subject the cap swallows ([P02]).

#### The lane run was sequential {#the-lane-run-was-sequential}

The 2/5 run the brief describes was one invocation: `just app-test <five files>`. The recipe's runner is a `for` loop — one `bun test "$f"` per file, serialized machine-wide behind a localhost port gate (`tugutil host gate --name apptest`). There was no process concurrency to serialize away. What actually happened, per the run's own report: at0405 and at0417 passed; at0418's `beforeAll` died on the blank `dash create` failure; at0425 went 1/2 with an unnamed assertion failure; at0426 failed on the truncation mechanism above. The real cross-file hazards are (a) stranded fixture state from a failed `beforeAll` ([P04]) and (b) whatever transient killed that `dash create` — which stays undiagnosable until failures are legible ([P03]). Git-lock collisions with *live tugcast instances* watching the repo (every instance runs a base-motion engine that shells git) remain the plausible source of transients, which is why the retry predicate widens rather than disappears.

#### The blank failure {#the-blank-failure}

`Bun.spawnSync` captures both streams by default (`out.stderr` was an empty buffer, not undefined — a `sh -c 'echo ERR >&2'` probe confirms stderr arrives without asking). `tugutil`'s dash dispatcher prints `error: {e}` to stderr on every `Err` return before exiting 1 (`tugrust/crates/tugutil/src/dash.rs::dispatch`). So a non-zero exit with empty stderr means the process never reached its own error path: a signal death or a pre-main failure. The wrapper had the exit code and `signalCode` in hand and threw away everything but stderr. [P03] makes the next occurrence self-describing.

---

### Specification {#specification}

**Spec S01: `FileResolution` counts** {#s01-fileresolution-counts}

- `FileResolution` (in `tugrust/crates/tugdash-core/src/resolve.rs`) gains `added: Option<u32>` and `removed: Option<u32>`, serialized with `skip_serializing_if = "Option::is_none"`, populated in `resolution_report` alongside `diff`.
- `resolution_diff` runs `git diff --no-color --numstat --patch <base_head> <candidate> -- <path>` and returns text plus counts together. Output shape, verified against a scratch repo: `"<added>\t<removed>\t<path>\n\n<patch…>"` for a text file, and `"-\t-\t<path>\n\n<patch…>"` for a binary one. Parse: split the first line, map `-` to `None`, drop the following blank line, and treat the remainder as the patch body — the `DIFF_LINE_CAP` truncation applies to that body alone.
- The existing "no diff ⇒ `None`" contract is preserved by testing the **patch body** for emptiness, not the raw output (which always carries a numstat line). The frontend relies on this: `resolutionDiffPayload` drops files whose `diff` is `null`.
- Counts are best-effort, exactly like the text: any git failure or unparsable first line yields `None` for both and never fails the resolve.
- Wire: rides `body["resolved"]` in `agent_supervisor`'s join frames unchanged — it serializes the whole `ResolveOutcome` with `serde_json::to_value(&outcome)`, so serde carries the new fields.
- Store: `changeset-join-store.ts`'s `ResolvedFile` gains `added: number | null` and `removed: number | null`, read defensively like its sibling fields (`typeof … === "number" ? … : null`).
- Face: `resolutionDiffPayload` uses the server counts for `GitDiffFile.added/removed` and the payload totals; a `null` count renders as `0` with the diff body still shown. `countStat` is deleted.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `ResolvedFile.added/removed` | store data (existing `JoinState`, new fields only) | store + `useSyncExternalStore`, already in place | [L02] |

No new state zones; the fields extend an existing store shape that already flows through `useSyncExternalStore`.

**Tuglaws cross-check.** [L02] is honored and needs no new entry point: `ChangesetJoinStore` already exposes itself via `useSyncExternalStore` (its own hook, and `session-changes-view.tsx` reads three such subscriptions), so `added`/`removed` arrive by the same subscription that carries `diff` today. [L06] is honored rather than merely avoided: the counts are *semantic data* — git's answer about what would land, which the review gate acts on — and tuglaws' own carve-out at [#l06](../tuglaws/tuglaws.md#l06) puts data with a visual representation in the render path, not in the appearance zone. [L19] is untouched: no component is authored or hand-rolled here; the review keeps rendering through the shared `TugDiffDocument`, and this plan only changes the numbers in the payload handed to it.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `transientGitFailure` | fn (renames `heldLock`) | `tests/app-test/dash-fixture.ts` | The named transient set from [P03] |
| `tugutil` | fn (modify) | `tests/app-test/dash-fixture.ts` | Throw message: exit code, signal, stderr, stdout tail |
| `gitRetry` | fn (new export) | `tests/app-test/dash-fixture.ts` | Replaces the private `git()` copies in at0425/at0426 |
| `smallConflictSubject` | fn (new export) | `tests/app-test/dash-fixture.ts` | Returns `{ commit, path, subject }` per [P02] |
| `FileResolution.added` / `.removed` | fields | `tugrust/crates/tugdash-core/src/resolve.rs` | Spec S01 |
| `resolution_diff` | fn (modify) | `tugrust/crates/tugdash-core/src/resolve.rs` | `--numstat --patch`: returns text + counts from one call, no second subprocess |
| `ResolvedFile.added` / `.removed` | fields | `tugdeck/src/lib/changeset-join-store.ts` | Spec S01 |
| `resolutionDiffPayload` | fn (modify) | `.../session-changes/session-changes-dash-landing.tsx` | Server counts in; `countStat` deleted |
| leftover-dash sweep | recipe block | `justfile` (`app-test` preamble) | [P04] |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | Pin the numstat counts and the cap interaction on a real scratch repo | The large-resolution case, binary/absent counts |
| **Unit (bun, pure)** | `resolutionDiffPayload` over server counts, including `null` | Extends the existing pure-function tests for the landing module |
| **App-test (lane files)** | The five lane files are the integration proof, run by the recipe | Every step's end state; the closing three-run gate |

#### What stays out of tests {#test-non-goals}

- No test for the recipe's leftover-dash sweep beyond the one-time hand verification in its step checkpoint — a bash recipe assertion would be a test of `just` itself.
- No mock-store or fake-DOM render tests (banned); the face changes are covered by the pure payload functions and the real lane files.
- No test that *induces* the blank transient — it is not reproducible on demand; legibility is the deliverable, verified once by hand against a forced failing verb.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Fixture failures become legible | done | c9969269 |
| #step-2 | The recipe sweeps stranded fixture dashes | done | 5e493d0b |
| #step-3 | The resolution stat tells the truth | done | 5e1014d4 |
| #step-4 | The lane fixtures pin a small conflict subject | done | ca8139a4 |
| #step-5 | Integration checkpoint: the lane suite, three green runs | done | N/A |
| #step-6 | Refresh the release instance and close the campaign | done | N/A |

#### Step 1: Fixture failures become legible {#step-1}

**Commit:** `test(app-test): dash fixture failures name their exit code, signal, and both streams`

**References:** [P03] Fixture failures carry the whole corpse, (#the-blank-failure, #symbols)

**Artifacts:**
- `dash-fixture.ts`: `transientGitFailure`, the enriched `tugutil()` throw, exported `gitRetry`.
- `at0425-dash-conflicted-landing.test.ts` / `at0426-dash-resolution-review.test.ts`: private `git()` helpers replaced by `gitRetry` imports.

**Tasks:**
- [ ] Rename `heldLock` to `transientGitFailure` and extend it to the [P03] literal set.
- [ ] In `tugutil()`, build the failure message from `exitCode`, `signalCode` (when set), full stderr, and the last ~20 lines of stdout; keep the `required: false` swallow path unchanged.
- [ ] Export `gitRetry(cwd, ...args)` with the same predicate and backoff; delete the two private `git()` copies and import it.
- [ ] Apply the same predicate to `gitConfig`'s retry.

**Tests:**
- [ ] Hand-verify once: run a deliberately failing verb (e.g. `tugutil dash commit no-such-dash …` through the wrapper in a scratch bun script) and confirm the thrown message carries code and streams.

**Checkpoint:**
- [ ] `TUG_APPTEST_ASSUME=background just app-test tests/app-test/at0425-dash-conflicted-landing.test.ts tests/app-test/at0426-dash-resolution-review.test.ts` — both files run (at0426 may still be red on the drift this step does not fix; the gate here is that the fixtures drive and any failure message is legible).

---

#### Step 2: The recipe sweeps stranded fixture dashes {#step-2}

**Depends on:** #step-1

**Commit:** `build(app-test): sweep leftover at04 fixture dashes in the clean-slate preamble`

**References:** [P04] A red run heals on the next invocation, (#the-lane-run-was-sequential)

**Artifacts:**
- `justfile`: a release loop over `git branch --list 'tugdash/at04??-*'` names in the `app-test` recipe's clean-slate block (alongside the existing instance/socket sweeps, after `tugutil host sweep`), best-effort.

**Tasks:**
- [ ] Add the sweep: for each matching branch, derive the dash name, then — **before releasing** — `git -C .tug/worktrees/<name> reset --hard` and `git -C .tug/worktrees/<name> clean -fd` (both ignoring failure, e.g. a branch whose worktree is already gone), so `release`'s hand-back has nothing to copy into the base checkout ([P04]).
- [ ] Then run `tugrust/target/debug/tugutil dash release <name> --json`, ignoring failures; print one line naming what was swept.

**Tests:**
- [ ] Covered by the checkpoint's hand verification (see [#test-non-goals](#test-non-goals)).

**Checkpoint:**
- [ ] `tugrust/target/debug/tugutil dash create at0499-leftover --description "sweep probe" --json`, then `TUG_APPTEST_ASSUME=background just app-test tests/app-test/at0000-smoke.test.ts`, then `git branch --list 'tugdash/at0499*'` prints nothing.

---

#### Step 3: The resolution stat tells the truth {#step-3}

**Depends on:** #step-1

**Commit:** `tugdash(resolve): real numstat counts on FileResolution; the review face stops counting truncated text`

**References:** [P01] Stat from numstat, Spec S01, (#the-0-395-mechanism, #state-zone-mapping)

**Artifacts:**
- `resolve.rs`: `added`/`removed` on `FileResolution`, `resolution_numstat`, wiring in `resolution_report`.
- `changeset-join-store.ts`: fields on `ResolvedFile` and its reader.
- `session-changes-dash-landing.tsx`: `resolutionDiffPayload` uses server counts; `countStat` deleted.

**Tasks:**
- [ ] Change `resolution_diff` to run `--numstat --patch` and return the patch body plus `Option<u32>` counts (Spec S01), keeping truncation on the body and emptiness detection on the body.
- [ ] Populate the fields at the single `FileResolution` construction site in `resolution_report`.
- [ ] Read the fields in the store; render them in the payload; delete `countStat` (its one call site is `resolutionDiffPayload`) and update the landing module's existing pure tests.

**Tests:**
- [ ] Rust: on a scratch repo, a driver-resolved conflict whose base side exceeds `DIFF_LINE_CAP` lines reports `removed` greater than the capped line count, `added` equal to the driver body's line count, and a `diff` ending in the `more line` marker — the `+0 −395` shape, pinned so it cannot return.
- [ ] Rust: the existing `a_resolution_carries_the_diff_it_would_land` test extended to assert exact counts on the small-file case, and that a partial outcome still carries no diff and no counts.
- [ ] bun: `resolutionDiffPayload` uses server counts, totals sum them, and `null` counts render as zero with the body intact.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugcast`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test`

---

#### Step 4: The lane fixtures pin a small conflict subject {#step-4}

**Depends on:** #step-1, #step-3

**Commit:** `test(app-test): at0425/at0426 pin a small conflict subject via a shared fixture helper`

**References:** [P02] Small conflict subject, (#the-0-395-mechanism, #symbols)

**Artifacts:**
- `dash-fixture.ts`: `smallConflictSubject(projectDir, { maxLines: 120, maxCommits: 25 })`.
- at0425 and at0426 use it for `conflictFile` (and at0425's `baseSubject`).

**Tasks:**
- [ ] Implement the helper: walk `git log --first-parent --diff-filter=M --pretty=%H --name-only -<maxCommits> main`; for each commit newest-first, for each modified file, accept the first whose blob at that commit (line count via `git show <sha>:<path>`) is ≤ maxLines and not binary; throw a named error when nothing qualifies.
- [ ] Replace both files' private derivations; keep every downstream assertion (archaeology subject, review body, refusal texts) unchanged.
- [ ] Give at0426's dash-side body a per-run nonce so the conflict key is unique and no stale `rr-cache` entry can replay ahead of the driver rung ([P02]). `DRIVER_BODY` is asserted verbatim and must **not** carry the nonce.

**Tests:**
- [ ] The two lane files themselves are the test; no new test file.

**Checkpoint:**
- [ ] `just build-app` (Step 3 changed Rust — the bundle must carry it), then `TUG_APPTEST_ASSUME=background just app-test tests/app-test/at0425-dash-conflicted-landing.test.ts tests/app-test/at0426-dash-resolution-review.test.ts` — 2/2 files green.

---

#### Step 5: Integration checkpoint — the lane suite, three green runs {#step-5}

**Depends on:** #step-2, #step-4

**Commit:** `N/A (verification only)`

**References:** [P02], [P03], [P04], (#success-criteria)

**Tasks:**
- [ ] Run the five lane files in one invocation, three consecutive times; between runs, confirm `git branch --list 'tugdash/*'` shows only user dashes, the projects dir count is unchanged, and `git status --porcelain` gained no modification the developer did not make (the hand-back hazard [P04] guards against), plus no new `rr-cache` entries.
- [ ] If any run is red: the failure message is now the diagnosis — record it, fix or file it, and restart the three-run count.

**Tests:**
- [ ] `TUG_APPTEST_ASSUME=background just app-test tests/app-test/at0405-changes-dash-lane.test.ts tests/app-test/at0417-join-mode.test.ts tests/app-test/at0418-join-outcomes.test.ts tests/app-test/at0425-dash-conflicted-landing.test.ts tests/app-test/at0426-dash-resolution-review.test.ts` × 3 — 5/5 each time.

**Checkpoint:**
- [ ] Three consecutive 5/5 summaries, read from the recipe's own report.
- [ ] `cd tugrust && cargo nextest run` green workspace-wide.

---

#### Step 6: Refresh the release instance and close the campaign {#step-6}

**Depends on:** #step-5

**Commit:** `N/A (verification only)`

**References:** [P05] Refresh last, (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] From the main checkout, with all prior steps landed: `just app-release`. (This quits the live release instance first — run it when nothing else is in flight; it is the campaign's closing gesture.)
- [ ] `just instances` — confirm the release instance restarted.
- [ ] Probe the clock and route from the CLI: `tugutil dash create closeout-probe --description "campaign close probe" --json`, then `tugutil dash release closeout-probe --json`; read the tail of the project's dash-log (`~/Library/Application Support/Tug/projects/<slug>/dash-log.md`) — the released line stamps `2026` and reads `released  via cli`. The `via card` route self-verifies at the next organic card landing. (The probe name is deliberately outside the `at04` namespace so the Step 2 sweep cannot claim it. A hand-made dash does **not** opt out of base motion the way the fixtures do, so the refreshed instance's engine may replay it — harmless here, since the probe asserts on the dash-log line and never on a tip sha.)
- [ ] Update `roadmap/closing-dash-backend-issues-brief.md`: mark the three findings closed with one line each naming the mechanism, and state that the campaign is closed — items 5 and 7 remain, as tripwire and pull-driven work respectively.

**Tests:**
- [ ] The dash-log probe above is the test.

**Checkpoint:**
- [ ] `just instances` shows the fresh release instance; the probe's dash-log line carries year and route.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The dash backend campaign is closed: a truthful, deterministic, self-healing lane suite green three runs straight; a review face whose numbers come from git; and a live release instance running the code the campaign landed.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Five lane files, one invocation, three consecutive 5/5 runs (Step 5 checkpoint).
- [ ] `cargo nextest run` and tugdeck `tsc` / `vite build` / `bun test` green (Steps 3 and 5 checkpoints).
- [ ] The release instance restarted and stamping `2026` with routes (Step 6 checkpoint).
- [ ] The brief updated to say the campaign is closed, with items 5 and 7 explicitly carried as tripwire and pull-driven work.

**Acceptance tests:**
- [ ] The Step 5 three-run gate.
- [ ] The Step 3 large-resolution Rust test.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Head+tail elision for capped review diffs, so a huge resolution still shows its additions on screen (the stat is already truthful without it).
- [ ] Brief item 5: the Join sheet at its next live occurrence, per the brief's capture protocol.
- [ ] Brief item 7: the deferred lifecycle items, when the UI campaign pulls them.
- [ ] The join squash-message double-prefix (`tugdash(close-backend): tugdash(backend): …`) noted in the brief's small things.

| Checkpoint | Verification |
|------------|--------------|
| Lane suite stable | Three consecutive 5/5 invocations |
| Stat truthful | Large-resolution numstat test + review face on server counts |
| Instance current | `just instances` + dash-log year/route probe |

---

## Addendum — handoff state, 2026-08-16 {#addendum}

*Written after the plan closed, for a session picking this up cold with no conversation history. Everything below is state, not narrative: what landed, where it lives, what is still open, and what cost time to learn. Read this section first and the rest of the document only if you need a decision's rationale.*

**Note on the stamp.** This addendum edits hashed content, so `tugutil plan status` now reports `stale` against round 1's `plan:a2f9b14a6797ddf9`. That is expected and harmless — the plan is finished and its ledger rows (which live outside the hash) are the record. Do not read `stale` here as "unreviewed": round 1 was a real review and its findings are in the [Review Record](#review-record).

### Status: closed {#addendum-status}

All six steps `done`. The dash backend campaign is **closed**. The gate that closed it: the five dash-lane app-test files green in one invocation, three consecutive runs, leaving no branch, worktree, `rr-cache` entry, or working-tree modification behind.

### The commit trail {#addendum-commits}

| Commit | What it did |
|---|---|
| `5ba5ce400` | The prior eleven-step program (clock, NUL bytes, projects dir, route-attributed landings, engine opt-out, worktree refusal, turn gate, refusal legibility, disabled look, conflict archaeology) |
| `5280c8c3b` | This plan, drafted |
| `c99692691` | Step 1 — fixture failures carry exit code, signal, and both streams; `gitRetry` shared |
| `5e493d0b9` | Step 2 — the `app-test` recipe sweeps stranded `tugdash/at04??-*` fixture dashes |
| `5e1014d4f` | Step 3 — real numstat counts on `FileResolution`; `countStat` deleted |
| `ca8139a4b` | Step 4 — at0425/at0426 pin a small conflict subject; at0426 gets a per-run nonce |
| `84b8d9982` | Step 6 — the brief rewritten to declare the campaign closed |

Steps 5 and 6 carried no code commit of their own; step 5 was pure verification and step 6's only artifact was the brief.

### The document map {#addendum-documents}

What each surviving document is *for*, so nobody re-reads the wrong one:

| Document | Role now |
|---|---|
| [`closing-dash-backend-issues-brief.md`](closing-dash-backend-issues-brief.md) | **The closure record, and the one to read first.** Carries the corrected mechanisms, the verification numbers for both programs, item 5's capture protocol, and the landmines |
| [`closing-dash-backend-issues.md`](closing-dash-backend-issues.md) | The eleven-step program plan. Landed as `5ba5ce400`; historical |
| `close-backend-campaign.md` (this) | The closing program. Landed across the four commits above; historical |
| [`join-assessment.md`](join-assessment.md) | The origin post-mortem of the first real landing, since grown into the working brief for landing dashes. Still live — its doctrine section is the program the UI work inherits |
| [`dash-ui-report.md`](dash-ui-report.md) | **The next round's jumping-off point.** Inventories where dash identity surfaces today, names two badge defects, and proposes folding dash identity into the session identity grammar the way [D123] settled session names |
| [`base-motion-replay-plan.md`](base-motion-replay-plan.md) | Base-motion replay. 10/10 steps `done`; stamp reads `stale` because it finished, not because it drifted |
| `archive/dash-integration-*.md` | The five-phase dash integration program plus its brief and plan. Complete and archived |
| [`dash-notes.md`](dash-notes.md) | **Superseded.** It proposes folding `/vet` into `/devise`; that shipped as `plan-devise` + `plan-review`, with the review auto-running on Opus. Nothing to do here |

### What changed in the code {#addendum-code}

The durable surface a next session will touch:

- **`tugrust/crates/tugdash-core/src/resolve.rs`** — `FileResolution` carries `added`/`removed` (`Option<u32>`, `skip_serializing_if`). `resolution_diff` runs `git diff --no-color --numstat --patch` and returns `ResolutionDiff { text, added, removed }` from **one** subprocess, so the counts and the text cannot disagree. `parse_numstat` maps `-` to `None` for binary paths and refuses a non-numstat first line. **The emptiness check runs on the patch body, after the numstat line is split off** — the raw output always carries a numstat line, and the frontend drops resolutions whose `diff` is `null`. Ladder rungs and their order are untouched.
- **`tugdeck/src/lib/changeset-join-store.ts`** — `ResolvedFile` gained `added`/`removed` (`number | null`), read defensively. No new store, no new subscription: they ride the existing `useSyncExternalStore` face ([L02]).
- **`.../session-changes/session-changes-dash-landing.tsx`** — `resolutionDiffPayload` uses the server counts; `countStat` is **deleted**. Do not reintroduce a client-side count over `unified` — that text is capped.
- **`tests/app-test/dash-fixture.ts`** — `transientGitFailure` (closed literal set), `gitRetry` (exported, replaced three private copies), `smallConflictSubject`, and a `tugutil()` throw that names exit code, signal, stderr, and the stdout tail.
- **`justfile`** — the `app-test` clean-slate preamble releases leftover `tugdash/at04??-*` dashes, hard-resetting each fixture worktree first.

### Facts that cost time, and would cost it again {#addendum-hard-won}

- **`dash release` hands a worktree's uncommitted files back into the base checkout.** `ops::release_in` → `working_set_hand_back` / `apply_hand_back`. Deliberate — a teardown must not destroy work typed in a dash — but it means releasing a dirty fixture worktree writes fixture bytes into the developer's checkout as a modification nobody made. Confirmed by deliberate probe, not inferred. Reset before releasing anything you did not intend to keep. `HandBack.deletions` is never handed back, so deletions were always safe.
- **A stat derived from a capped view lies exactly when it matters.** The `+0 −395` incident: the diff was never wrong, only the number printed beside it. The ladder was correct throughout.
- **rerere is rung 2; the merge driver is rung 4.** A cached resolution short-circuits ahead of the driver. Any fixture that pins its conflict text must carry a per-run nonce, or a stale `rr-cache` entry from a killed run replays and the rung assertion fails. at0426 does; `DRIVER_BODY` deliberately does not, because it is asserted verbatim.
- **The app-test runner is sequential**, behind a machine-wide port gate. There is no test concurrency to serialize. Cross-file interference comes from *stranded state*, not races.
- **`Bun.spawnSync` pipes both streams by default.** A blank failure means the process died before reaching its own error path.
- **This plan ran on `main`, not on a dash** — the `app-test` recipe refuses to run from a linked worktree because every `tugutil dash` verb resolves the *main* repo root, so lane-fixture dashes made from a worktree are invisible to the app under test. `TUG_APPTEST_ALLOW_WORKTREE=1` does not help; the lane fixtures *are* the refusal's cause. Any future work whose checkpoint is a dash-lane app-test has the same constraint.

### What is open {#addendum-open}

Nothing blocks the UI campaign. In rough order of when it will matter:

1. **Item 5 — the Join sheet, caught live.** A tripwire, not a task. The capture protocol is in the brief's `#join-sheet`. Resist building a fix before it is caught: the three candidate shapes (refusing / stale / covered lane) have three different fixes and the evidence still cannot pick one.
2. **Item 7 — the deferred lifecycle work.** Queue-a-landing-for-turn-end; a click affordance for `dash replay`; post-rebase checkpoint runs. Pull-driven.
3. **Head+tail elision for capped review diffs**, so a huge resolution still shows its additions on screen. The stat is truthful without it and the pinned fixture no longer depends on it, so this is now cosmetic.
4. **The join's doubled subject prefix** — `5ba5ce400`'s message reads `tugdash(close-backend): tugdash(backend): …`. Whoever composes the squash message prefixes a draft subject that already has a scope.
5. **at0405's click noise.** Every lane run logs `click on … dash-lane-fold did not land (attempt 1)`, twice in some runs. The file's own retry covers it and it has never failed — but a real click is missing its target, and if that retry ever stops covering it the diagnostic will already have been normalized as background noise.

### Verifying from cold {#addendum-verify}

```
TUG_APPTEST_ASSUME=background just app-test \
  tests/app-test/at0405-changes-dash-lane.test.ts \
  tests/app-test/at0417-join-mode.test.ts \
  tests/app-test/at0418-join-outcomes.test.ts \
  tests/app-test/at0425-dash-conflicted-landing.test.ts \
  tests/app-test/at0426-dash-resolution-review.test.ts
```

Expect 5/5 files, 6/6 tests. Run the recipe **bare** — never pipe it into a filter; the pipeline's exit status becomes the filter's, so a green run reads as a silent failure. Use `TUG_APPTEST_JSON=<path>` if you need a result to compute over. A Rust change needs `just build-app` before any app-test can see it.

Between runs, the hygiene that matters (all four were stable across the closing gate): no `tugdash/*` branch, `rr-cache` entry count unchanged, projects dir at 1 entry, and no working-tree modification the run introduced.

Also green at close: `cargo nextest run` workspace-wide (2816 passed, 6 skipped), and tugdeck `tsc --noEmit` / `bun test` (6864 passed) / `vite build`.

# Closing the dash backend: status and what is left

**The dash backend campaign is closed as of 2026-08-16.**

Two programs landed it. The eleven-step program in [`closing-dash-backend-issues.md`](closing-dash-backend-issues.md) landed as `5ba5ce400`; the three findings its own verification turned up were closed by [`close-backend-campaign.md`](close-backend-campaign.md), landing as `c9969269`, `5e493d0b`, `5e1014d4`, `ca8139a4`. The closing gate: **the five dash-lane app-test files green in one invocation, three consecutive runs**, with no branch, worktree, `rr-cache` entry, or working-tree modification left behind by any of them.

Two things stay open by design, neither blocking: item 5 (the Join sheet, which can only be closed at a live occurrence — its capture protocol is [below](#join-sheet)) and item 7 (the deferred lifecycle work, pull-driven by the UI campaign).

This document is written to be picked up cold, after a compaction. It supersedes the pre-implementation brief; the investigation narrative that is still load-bearing is preserved below, and everything settled has been folded into [What landed](#what-landed).

The goal was the owner's own: **wrap up the backend and make it a solid, robust foundation**, because a long list of UI and design work builds on it and the functionality has to come first. That foundation is now in place.

## Where we stand {#where-we-stand}

| Original work item | State |
|---|---|
| 1. The hygiene round (timestamps, NUL byte, projects dir) | **Done**, all three, each pinned |
| 2. Landing observability | **Done** — route-attributed dash-log notes + tugcast receipts |
| 3. The engine/instance race | **Done** — per-dash opt-out, honored by the engine, set by every fixture |
| 4. App-tests refuse the wrong environment | **Done** — and the root cause is now known, not hypothesised |
| 5. The Join sheet, caught live | **Open by design** — needs a live occurrence; the diagnostics it needs now exist |
| 6. The tactical layer (turn gate, refusal legibility, disabled look, archaeology) | **Done**, all four |
| 7. The deferred lifecycle items | **Open by design**, pull-driven |

And the three findings the first program's verification turned up:

| Finding | State |
|---|---|
| at0426 red — fixture drift | **Done** — both lane fixtures pin a small conflict subject via one shared helper |
| The resolution stat lied (`+0 −395`) | **Done** — and it was a presentation defect, not a ladder defect |
| The lane files could not run together | **Done** — legible failures + a leftover-dash sweep; there was no concurrency to fix |

## What landed {#what-landed}

Eleven rounds, squashed onto `main` as `5ba5ce400`.

**The clock.** `tugutil-core::session::now_iso8601` computed civil dates from a `DAYS_TO_EPOCH` constant that disagreed with its own `year_to_days` helper by exactly 365 days, so every dash-log line stamped a year early — epoch zero rendered `1969-01-01`. Replaced with Howard Hinnant's `civil_from_days` behind a pure `iso8601_from_unix(secs, nanos)` seam, pinned at eight known epochs including both sides of a leap day (where the old error read as a year *and a day*, not a clean year). Confirmed live: new lines stamp `2026`.

**NUL-free sources.** Four raw `0x00` bytes in tracked source, spelled as `\x00` escapes: `changeset-verb-store.ts` (the one the investigation found), plus `tug-combo-box.tsx` and `shell-line-classifier.ts` — and, found during the final sweep, the plan and the brief themselves, which described the bug and then committed it. A file with a raw NUL is binary to `grep` and `git diff`, which is how 34KB of landing code stayed invisible to search. Note that the sweep command the plan named (`rg -uu`) also walks `tugrust/target` and legitimately-binary artifacts; `git grep -laP '\x00' -- <tracked source>` is the one to use.

**The projects directory.** `append_dash_log` now refuses, in debug builds, to write dash state for a repo under the OS temp directory when `TUG_DATA_DIR` is unset. The diagnosis in the pre-implementation brief was wrong in an instructive way: the Rust suite was **not** the leaker — `tugrust/.cargo/config.toml` has force-set `TUG_DATA_DIR` since `9f772204b` (2026-08-03). 703 of the 720 stale slugs predate that fix, and the only live leaker was **at0353**, which drives `tugutil dash` verbs through the app's shell route and so inherits the *app's* environment rather than cargo's. at0353 now prefixes its shell lines with a redirect. The one-time sweep is done: **721 entries → 1**, 3.0M → 240K, and the count has held at 1 across every subsequent Rust and app-test run.

**Attributable landings.** `JoinOptions` gained an `origin`, `release` takes one, and the dash-log's terminal notes now read `joined via card` / `joined via cli` and `released  via cli`. This required widening `dash.rs::is_terminal` to a **prefix** match on the note — the review caught that an exact `note == "joined"` comparison would have silently made every future join non-terminal, so a reused dash name would inherit the prior generation's declarations. `agent_supervisor` emits a `tracing::info!` receipt for join completed/refused, ladder ran/refused, and release completed.

**The engine keeps its hands off.** `branch.tugdash/<name>.tugautoreplay=false` is checked before every other input in `decide_for_dash`, and `dash-fixture.ts` writes it the moment it creates a dash. The engine's per-decision skip logging already existed; no new call site was needed.

**The corpus refuses the wrong environment — and now we know why it had to.** The `app-test` recipe refuses before any build or launch when the invoking root is a linked worktree or HEAD is a `tugdash/*` branch, with `TUG_APPTEST_ALLOW_WORKTREE=1` as the escape. The root cause is not the `~/.local/bin` symlink hypothesis the old brief offered. It is this: **every `tugutil dash` verb resolves the *main* repo root first** (`tugdash-core::ops::main_repo_root`, via `find_repo_root_from`). So a fixture dash created from a linked worktree is created against the base checkout, while the app under test has the *worktree* open as its project — the lane can never list the dash its own fixture just made, and the selector times out. Worse, a corpus run from a worktree leaves branches, worktrees and dash-log lines in the developer's main checkout. That mechanism is written into the refusal text.

**The turn gate narrowed.** `Resolve`, `Adopt` and `Leave` work mid-turn; `Join`, `Release` and `Resume teardown` stay gated because they move the base branch or destroy the dash. `Resume teardown` was the control the old brief never named — it completes an interrupted join and is the most base-mutating act on the face.

**Refusals speak.** Every refused control states its reason as visible face text, one line per control, and every dead `title` on a disabled control is gone. `.tug-button:disabled` sets `pointer-events: none`, so a tooltip on a disabled button was never readable by anyone — that was the defect, not the fix. This closes the "a correctly-refusing lane is indistinguishable from a dead one" seam that motivated item 5.

**Disabled looks disabled.** All five filled variants drop their fill when disabled, falling back to their own role's outlined treatment (in brio: solid cobalt → `transparent`), icons included. Scoped to `tug-button.css`; no theme token moved, so the light-theme accent/danger CVD floor is untouched. `bun run audit:theme-contrast` stays within the brio budget.

**A conflict names its history.** A conflicted `--preview` now carries, per conflicted path, the base commits since the merge-base that touched it — short SHA + subject, newest first, capped at five with a `+N earlier` remainder. Computed in `tugdash-core` on the preview path only; rides `JoinOutcome` as an additive field with the same absent-when-empty shape `blockers` uses. Any git failure yields no history rather than costing the caller the conflict report.

## What the closing program found {#closing-findings}

Its three findings were re-diagnosed before any of them was fixed, and **two of the three mechanisms this brief originally proposed were wrong.** They are corrected here rather than quietly dropped, because the wrong mechanism is the more instructive half.

**There was no ladder defect. The `+0 −395` was a presentation lie.** The driver rung genuinely resolved `Justfile`; `patch_tree`, `commit_tree` and the rung report were correct throughout. `resolve.rs` caps each review diff at `DIFF_LINE_CAP = 400` lines, and git emits deletions before additions — so a 2050-line base-side file resolved to a one-line body truncates to 4 header lines, 1 hunk header, and 395 deletions, and the driver's single `+` line falls past the cap. The frontend then counted `+`/`−` over that *truncated* text. The fix is that `FileResolution` now carries `added`/`removed` from `git diff --numstat --patch` — one subprocess, so the count and the text it describes can never disagree — and the frontend's `countStat` is deleted. Pinned by a tugdash-core test that asserts both halves: the addition is genuinely absent from the capped text, and the counts still read `(Some(1), Some(2050))`.

**There was no concurrency.** The `app-test` recipe's runner is a sequential `for` loop — one `bun test <file>` per iteration — and the whole invocation sits behind a machine-wide port gate. The proposed "serialization marker" would have changed nothing and was dropped. The real cross-file hazard was **stranded fixture state**: a failed `beforeAll` skips its own `afterAll`, leaving a dash whose branch breaks the *next* run differently. The recipe's clean-slate preamble now releases any leftover `tugdash/at04??-*` dash.

That sweep needed a guard the brief never anticipated. `ops::release_in` runs `apply_hand_back`, which copies a dash worktree's **uncommitted** files back into the base checkout, so that tearing down a dash cannot destroy work typed in it. Correct for a real dash, wrong for a fixture: one stranded between at0426's `writeFileSync` and its `commitRound` deposits a placeholder body over a real source file. Confirmed by deliberate probe — releasing an unreset fixture worktree really does leave ` M tuglaws/dash-work-doctrine.md` in the checkout. The sweep hard-resets and cleans each fixture worktree first.

**stderr was never unpiped.** `Bun.spawnSync` captures both streams by default. The blank `tugutil dash create … failed:` meant the process died *before reaching its own error path* — `tugutil`'s dash dispatcher prints `error: {e}` to stderr on every `Err` — so a signal or a pre-main failure. The wrapper had `exitCode` and `signalCode` in hand and threw away everything but stderr. Failures now carry exit code, signal, stderr, and the tail of stdout; stdout matters because the `--json` verbs put their refusals inside the JSON envelope there. The transient still has no root cause, and that is accepted: the next occurrence will describe itself.

**at0426's drift was real, and pinning it armed a second flake.** Both lane fixtures now take their subject from `smallConflictSubject`, which walks up to 25 first-parent commits for one that modified a text file of ≤120 lines. But a pinned subject makes at0426's conflict recur byte for byte, and rerere is **rung 2** while the driver is **rung 4** — so an `rr-cache` entry surviving a killed run would replay ahead of the driver and fail the assertion looking for it. at0426's dash-side body therefore carries a per-run nonce; `DRIVER_BODY` is asserted verbatim and deliberately does not. at0425 adopts the same helper for determinism only: its delete/modify conflict short-circuits to unresolved before any rung runs, so no diff is produced and the cap never bit it. Nobody should go hunting a truncation bug there.

## Verification state {#verification-state}

The closing program's gate, on `main` at `ca8139a4`, after `just build-app`:

- **The five dash-lane files, one invocation, three consecutive runs:** 5/5 files, 6/6 tests, every time. Between runs: no `tugdash/*` branch, `rr-cache` steady at 13 entries, projects dir steady at 1, and no working-tree modification the runs introduced. (The campaign's starting state was 2/5 with a blank failure message.)
- **Rust:** `cargo nextest run` workspace-wide — 2816 passed, 6 skipped.
- **tugdeck:** `tsc --noEmit` and `vite build` clean; `bun test` 6864 passed, 0 failed.
- **The live release instance carries the landed code** — verified from the binary rather than from a timestamp: the running `tugcast` contains the `--numstat` literal, which did not exist in the tree before `5e1014d4`.

The first program's gate, on `main` at `5ba5ce400`, after `just build-app`.

- **Rust:** `cargo nextest run` workspace-wide — 2755 passed, 6 skipped.
- **tugdeck:** `tsc --noEmit` and `vite build` clean; `bun test` 6840 passed, 0 failed. (The `layout-imposer-solutions` golden the plan expected to be red is green.)
- **Theme:** `bun run audit:theme-contrast` — no theme exceeds the brio budget.
- **App-test core tier:** 16/20 files, 30/30 tests green (4 screen-takers skipped on an unattended background run).
- **The five dash-lane files, run one at a time:** `at0405` ✅ `at0417` ✅ `at0418` ✅ `at0425` ✅ `at0426` ❌ (the drift, closed by the second program). Every new assertion from this program passes live — the archaeology names the base commit, the disabled Join carries an empty `title`, and Resolve's click registers **mid-turn** with Release simultaneously disabled, which is the turn-gate narrowing read straight off the face.
- **The projects directory held at 1 entry** across all of it.

## What is still open {#still-open}

### The Join sheet, caught live — item 5, unchanged and still the big one {#join-sheet}

The report that started this: the Changes shade's join surface reads as **completely non-functional** in real use. It was never reproduced. What is eliminated: build vintage, the landing machinery (`join_in` demonstrably lands), and the test layer (all five lane files drive the same lane against the same binary).

What changed in this program's favour: the ambiguity is gone. A refusing lane now *says* why, in the face, and a disabled control now *looks* disabled. So a dead click from here means one of exactly three things, and the diagnostics to tell them apart now exist.

**The protocol for the next occurrence:**

1. Reproduce with a real dash and the shade open, in the release instance.
2. Enable diag/eval on the instance's bank; read `__deckTrace.dump()` (there is no `__tug` on a release build).
3. Capture the join store's snapshot (`joinSnapshot.active` / `.outcome` / `.dash`), `evaluateJoinLandGate`'s inputs and its reason, and `document.elementFromPoint` at the refused control's center — the at0425 work proved a "dead click" can be a `DIV.cm-line` stealing the point when the lane sits under the composer.
4. Distinguish the three shapes: a *refusing* lane (the face now states the reason — read it), a *stale* lane (store never received the entry — transport/store defect), a *covered* lane (hit-testing — layout defect).

Do not build speculative fixes before then; the three shapes have three different fixes and the evidence still cannot pick one.

### The deferred lifecycle items — item 7, untouched {#deferred}

Queue-a-landing-for-turn-end; a lane affordance to trigger `dash replay` by click for a deferred or conflicted dash with no bound session; teaching the injected conflict turn to run the plan's own checkpoints after the rebase. Real, but none of them blocks the UI campaign.

### Small things noticed, not fixed {#small-things}

- **The plan's review stamp reads `stale`.** The final round edited the plan's prose (removing the raw NUL it carried), which is outside what ledger progress may touch. The plan is finished, so the stamp costs nothing — but do not read `stale` as "unreviewed".
- **The join doubled its own subject prefix.** `5ba5ce400`'s message begins `tugdash(close-backend): tugdash(backend): …` — the landing prefixed the draft's subject, which already had a scope. Worth a look at whoever composes the squash message.
- ~~**The live release instance predates these fixes.**~~ Closed. The instance now runs the campaign's code, and dash-log lines stamp `2026` with a route suffix — `at0426-review  released  via cli`, written live by the lane suite.

## What is left {#next-steps}

The backend is closed. Two items remain, and neither blocks the UI campaign:

1. **Item 5 — the Join sheet**, at its next live occurrence, using the [protocol above](#join-sheet). The instrumentation to catch it now exists; the thing to resist is fixing it before it is caught. It stays a tripwire, not a task.
2. **Item 7 — the deferred lifecycle work**, when the UI campaign pulls it.

Two follow-ons were deliberately left undone, both noted rather than scheduled:

- **Head+tail elision for capped review diffs**, so a huge resolution still shows its additions on screen. The stat is truthful without it, and the pinned fixture no longer depends on it.
- **The join's doubled subject prefix** (below).

## Landmines, carried forward {#landmines}

Every one of these was paid for. `tugutil dash join <name> --resolve` **lands** — `--preview` is the only safe CLI probe. Only the user commits, and never hand over a `git reset` without re-reading `HEAD` first. A Rust change needs `just build-app` before any app-test can see it; a tugdeck change needs `bunx vite build` before it is done. The app-tests build real dashes in the live repository — leave no worktrees, `tugdash/*` branches, `tugdash.mergedriver` config, or `rr-cache` entries behind, and check `git branch --list 'tugdash/*'` after a red run, because a failed `beforeAll` skips its own cleanup. Never point a foreign `sqlite3` at the live ledgers; `just db-inspect` copies first.

New from this round, and now enforced rather than remembered: **the app-test corpus does not run from a dash worktree** — the recipe refuses, because every dash verb resolves the main repo root and a fixture dash would be created in the base checkout. **The base-motion engine is live in every instance watching this repo**, so any dash you create by hand is subject to replay the moment `main` moves; fixtures opt out, hand-made probe dashes do not. And **dash-log lines written before `5ba5ce400` are one year early** — do not let the `2025` era confuse an incident timeline.

New from the closing round, and the sharpest of the set: **`dash release` hands a worktree's uncommitted files back to the base checkout.** That is deliberate — a teardown must not destroy work someone typed in a dash — but it means releasing a dirty fixture worktree writes fixture bytes into the developer's checkout as a modification nobody made. Reset before you release anything you did not intend to keep. And **a stat derived from a capped view is a lie exactly when it matters**: the `+0 −395` incident cost a day and the diff was never wrong, only the number printed beside it.

# A Join That Cannot Strand the Base

**Purpose:** On 2026-09-21 a join of `still-height-crossing` failed and left the arc's files staged on `main`, every retry failed a different way, the verb built to clear the block failed too, and the join that finally landed carries the message "continue". Four independent defects lined up; each one alone would have been survivable.

---

## Purpose {#purpose}

The report, in the user's words: "It appears that you let some files leak onto main, which is now blocking the join. WHAT HAPPENED?" And then: "There is an *obvious* problem in the way we run arcs, as is evidenced by this session … This *MUST NOT HAPPEN AGAIN* if we can avoid it. Let's fully understand the git issue and make *robust changes* so that we don't trip over this issue again."

What the user saw: `git status` on `main` showing ten of the arc's eleven files staged, a join that refused, and a refusal that did not go away on retry. No session wrote those files. The join did, and then could not take them back.

---

## Evidence {#evidence}

Read out of `release-main`'s `tugcast.log.2026-09-21`, the oplog payloads `oplog-000276.json` through `oplog-000278.json`, and `tugrust/crates/tugarc-core/src/ops.rs`. Times are UTC as logged; local is −7h.

**[F01] The strand was the join itself.** Log, 14:21:56.72: `arc-join: refused … git commit failed: fatal: Unable to create '/u/src/tug/.git/index.lock': File exists.` By then `integrate_join`'s candidate/`Squash` arm (`ops.rs` ~5090) had already run `git merge --squash <candidate>` successfully, which staged all eleven files and wrote `.git/SQUASH_MSG` (mtime 07:21 local). The commit that would have consumed that staging lost the index lock. **(verified)**

**[F02] The rollback discards its own result, and lost the same lock.** The failure path is `let _ = git_output(repo_root, &["reset", "--hard"]);` — at four sites (`ops.rs` 5092, 5100, 5168, 5173). It ran milliseconds after the commit failed, against the same held lock, and its failure went nowhere. The join then returned `Err`, and `oplog::abandon` deleted the operation's record under the rule "a join which lands nothing records nothing". The rule's premise — the caller's comment says "the integrate left the base as it found it" — was false, and nothing checks it. The system's own account was that nothing had happened. **(verified by reading; that the reset failed on the lock is inferred from the staging surviving it — no log line records the reset at all, which is the defect)**

**[F03] `reset --hard` is the wrong tool even when it works.** `main` carried an unrelated uncommitted edit to `briefs/find-reliability-brief.md`. The join's intersection preflight deliberately admits disjoint base dirt ("the squash-merge only writes the arc's files"), and then the failure path would wipe it. The user's edit survived only because the reset failed. **(verified by reading; the edit is still in the tree)**

**[F04] The index-lock retry exists, and guards the wrong sites.** Spec S02's machinery — `INDEX_LOCK_ATTEMPTS = 10`, `INDEX_LOCK_BACKOFF = 150ms`, `index_lock_blocked` — wraps exactly two commit paths, both in the **arc worktree**: the round commit (~3117) and `commit_worktree_dirt` (~3712). The integrate on the **base** — the one place where losing the lock strands state rather than merely failing — has none. **(verified)**

**[F05] Tug competes with itself for the base's index lock.** Only tugcast's git feed passes `--no-optional-locks` (`feeds/git.rs:99`). Every other `git status` — `base_motion.rs:1593`, `draft_engine.rs:595`, the changeset feed, `tugchanges-core`, `tugarc-core`'s own — runs through runners that do not set `GIT_OPTIONAL_LOCKS=0`: the two shared sync runners (`tugchanges-core/src/git.rs` `git_output`, `tugarc-core/src/ops.rs:428` `git_output`) and tugcast's async ones. A plain `git status` opportunistically refreshes the index and takes `index.lock` to do it. A squash that writes eleven files wakes the watchers; a watcher-driven status takes the lock; the join's own `git commit` arrives half a second later. **(the missing flag is verified; which process held the lock at 14:21:56 is inferred — a second arc, `find-reliability`, was also mid-turn that second. The race is systematic either way.)**

**[F06] The retries hit a second, independent bug.** Log 14:22:02, 14:22:10, 14:26:25: `failed to drop the base's copy of tests/app-test/at0604-session-still-anchor.test.ts: git checkout HEAD -- … pathspec … did not match any file(s) known to git`. `drop_identical_base_copies` (`ops.rs` 4017) runs `git checkout HEAD -- <path>` for every entry in its `tracked` bucket, and that bucket includes files **staged as new** — in the index, absent from `HEAD` — for which the command cannot succeed. `carry_working_set_in` (~2950) already handles this exact state with a `"staged-new"` arm (`git rm --force --quiet --ignore-unmatch`); the drop never got one. Any arc that adds a file meets this the moment the base holds an identical staged copy. **(verified; reproduced by hand with `tugtool arc resolve-base`)**

**[F07] The drop is neither atomic nor recorded.** It restored `at0563-…test.ts` (first in order), failed on `at0604`, and returned — leaving `main` in a third partial state. On the join path the drop runs **before** `record_begin`, so there is no operation record at all. On the `resolve-base` path the record is begun and never closed: `oplog-000276.json` has a `before` and no `after`, and nothing abandoned it. Neither is something `arc undo` can read. **(verified)**

**[F08] The recovery door shares the broken hinge.** `resolve-base` exists to clear base-side work blocking a join, and it calls the same `drop_identical_base_copies`. It succeeded (`oplog-000277.json`, seven paths dropped) only after the three added files had been removed by hand. **(verified)**

**[F09] The landed commit's message is "continue".** `1b1a9d2cb` has the subject `tugarc(still-height-crossing): continue` and no body. The landing gate logged `messageLen: 3449` on every earlier press and `messageLen: 8` on the one that landed. In join mode the composer *is* the message editor, and an edit persists over the arc's draft (`join-mode-controller.ts`, `persistMessage(… edited: true)`). The authored message survives only in the candidate commit `bca083222`, pinned by `oplog-000278.json`'s keepalive. **(the lengths and the landed subject are verified; that "continue" was meant as a prompt to the session rather than as a message is inferred)**

**[F10] Nothing upstream could have seen it.** Every audit-stage command ran in the arc worktree; `arc replay` said `Current`; `arc doctor` said "The records agree" — and said so again with `main` stranded, because none of the five records it compares is the base checkout's index. **(verified)**

---

## Decisions {#decisions}

**[B01] The integrate leaves the base as it found it, and proves it.** The four discarded `reset --hard` calls become one restore routine that retries past `index.lock`, restores **only the paths the integrate touched**, removes `SQUASH_MSG`, and then verifies that the index and those paths match `HEAD`. Never `reset --hard`: a path-scoped restore cannot touch disjoint user work by construction, which closes [F03] rather than relying on luck. Revisit only if a strategy is added whose failure state is not expressible as a path set.

**[B02] A restore that cannot be proven is a recorded state, never an abandoned one.** If [B01]'s verification fails, the join operation is kept, marked as having stranded the base and naming the paths; the error says so in one sentence; and the next `join`, `resolve-base`, `arc undo` and `arc doctor` all read it. "Lands nothing records nothing" is a good rule with an unchecked premise ([F02]); it holds only when the premise is checked.

**[B03] Every git write the integrate makes on the base retries past `index.lock`,** through one helper shared with the two worktree sites, under Spec S02's existing constants and predicate. One helper so the sites cannot disagree about what is transient ([F04]). The bound stays: a lock held past ~1.5s is a crashed process, and that wants the error.

**[B04] Prefer never staging on the base at all.** The candidate path already holds the resolved tree. Building the squash commit off to the side (`git commit-tree` on that tree with `HEAD` as parent) and landing it in one ref-and-checkout step removes the window in which the base's index holds a half-landed squash — there is nothing to roll back because nothing was staged. This is the robust form; [B01]–[B03] are what make the present form safe. The arc evaluates it as its own step, and if it cannot honour disjoint base dirt safely, [B01]–[B03] stand alone.

**[B05] Every git runner Tug owns sets `GIT_OPTIONAL_LOCKS=0`.** Both shared sync runners and tugcast's async ones (`changeset.rs`, `draft_engine.rs`, `operator.rs`, `base_motion.rs`). It affects only *optional* locks — status's opportunistic index refresh — and leaves the mandatory locks of commit, merge and checkout alone, so it is safe on every invocation. At the runner rather than per call site, because [F05] is what per-call-site discipline produced: one feed remembered and the rest did not.

**[B06] `drop_identical_base_copies` handles every index state, all or nothing.** Modelled on `carry_working_set_in`'s arms: tracked-dirty restores from `HEAD`; staged-new is removed from the index with its file; untracked is removed. Every path is classified before any is touched. A failure part-way puts back what was dropped — the bytes are on the arc branch, which is the guarantee the drop already rests on — or is recorded under [B02].

**[B07] The drop happens inside the recorded operation.** On the join path it moves after `record_begin`, so a drop that half-completes is on the record an undo reads ([F07]). `resolve-base`'s failure path completes or abandons its payload; a bare `before` is never left behind.

**[B08] `arc doctor` reads the base checkout.** A sixth reading beside the five: a standing `SQUASH_MSG`, staged paths byte-identical to an arc's tip, an operation payload with no `after`. It names the strand and the verb that clears it. A state the user can see in `git status` must not read as "The records agree" ([F10]).

**[B09] An authored join message cannot be replaced by accident.** The defect is recorded here and the shape of the fix is the user's: the constraint is that editing the message must not get harder. See Open Questions.

**[B10] Tests at the layer that sees it: real git, temp repos.** The existing `hold_index_lock` fixture (`ops.rs` ~6402) is the instrument. A join whose commit loses the lock retries and lands. A lock held past the window leaves the base byte-identical to before, **including a disjoint dirty file**. An arc that adds a file joins over an identical staged-new base copy. `resolve-base` clears a stranded squash in one call. A failed restore leaves a readable record, and `doctor` names it.

---

## Open Questions {#open-questions}

- **What should join mode do with a press that replaces a long authored draft with a few characters ([F09], [B09])?** Refuse, confirm, or keep the draft recoverable behind the edit — and whether a typed prompt in join mode should ever persist over the draft. A product call about the composer's two jobs; it cannot be settled by reading code.
- **Does `1b1a9d2cb`'s message get repaired?** The text is intact in `bca083222`. Amending `main` rewrites history, which is the user's act and not an arc's.
- **Is [B04]'s side-built commit Squash-only?** `Merge` wants a true two-parent commit and `Rebase` wants the rounds themselves on the base. Reading `integrate_join`'s three arms against `commit-tree` settles it, and the evaluating step should.

---

## Non-goals {#non-goals}

- **Changing the audit stage.** It was not the cause and could not have been the guard ([F10]). The first theory — that the audit leaked files onto `main` — was wrong, and a fix aimed there would have left all four defects standing.
- **A global lock or daemon serializing Tug's git.** The oplog's own doctrine is "no daemon and no lock file", and git's index lock already is the lock. The fix is to stop competing for it ([B05]) and to survive losing it ([B03]).
- **Forbidding concurrent arcs.** Two arcs mid-turn is the product working. The base's index is contended only at a join, and the join is what gets hardened.
- **Widening `reset --hard` with a stash around it.** It would make [F03] survivable by adding a second thing that can fail in the failure path. A path-scoped restore needs no stash.

---

## Exit {#exit}

**An arc.** The raw material, in the order it has to land:

1. The drop: every index state, classify-then-act, all or nothing, inside the recorded operation; `resolve-base` never leaves a bare `before` ([B06], [B07]). Smallest, and it reopens the recovery door first.
2. The runners: `GIT_OPTIONAL_LOCKS=0` everywhere Tug spawns git ([B05]).
3. The integrate: the shared lock-retry helper on the base's writes, the path-scoped verified restore in place of the four `reset --hard` calls, and the stranded-base record ([B03], [B01], [B02]).
4. `arc doctor`'s reading of the base checkout ([B08]).
5. Evaluate building the squash commit off the base, and adopt it if it holds ([B04]).
6. The join-message guard, once the product call is made ([B09]).

[B10]'s tests land with the step each one pins, not at the end.

# Join crossings: reconcile live arcs against each other, and land only what was built against the head it lands on

**Purpose:** The `app-help` join landed a candidate that reverted a commit on `main` and replaced two source files with a model's refusal prose, and every guard in the pipeline said yes. The pipeline reconciles an arc against a moving `main` continuously but never against a sibling arc, so two arcs editing the same files meet for the first time as one whole-arc smash at the join — exactly the shape the join ladder exists to avoid.

---

## Purpose {#purpose}

On 2026-10-27 two arcs ran side by side on this checkout: `overview-historical-reach` and `app-help`. Both added fields to `OperatorContext`, verbs to the Operator's dispatch, and lines to the same prompt strings in `tugrust/crates/tugcast/src/feeds/operator.rs` and `overview_agent.rs`. The first landed as `01858c601`. The second's join, `5fd264fd2`, landed forty-seven seconds after the user's own commit `36c6d58b7`, carried an 11-line `operator.rs` and a 16-line `overview_agent.rs` whose contents were a model saying *"I can't produce a safe merge, so I'm outputting no merged file"*, and silently reverted `36c6d58b7`'s changes to `arc_runner.rs` and `agent_bridge.rs`. tugcast did not compile on `main`. The repair was landed by hand as `f0dba09e44`.

The user's framing, which this brief adopts: *"The whole idea of join resolution is that we don't wait until the end of the work and then try to smash divergent changes together all in one shot. Why don't we track concurrent changes across all active arcs and do the same kind of pre-merge work we do between arcs and main?"*

The git three-way merge of `36c6d58b7` and the arc tip `dd7a54de2` had seven conflict hunks, every one of them "keep both sides". Nothing about the merge was hard. The pipeline made it hard by letting it grow, and then accepted a non-answer.

---

## Evidence {#evidence}

**[F01] The failure is a chain of five guards, each satisfied for the wrong reason** — read from `release-main`'s tugcast log and the git objects. 23:00:41 the pilot reconciled `app-help` against `main` = `01858c601`; 23:01:27 `36c6d58b7` landed on `main` while the ladder ran; 23:02:40 the ladder ended `resolved=4 unresolved=0` with candidate `73b7376` parented on `01858c601`; 23:03:20 the resolver's audit committed `6934bd19e`, the identical tree re-parented on `36c6d58b7`; 23:03:46 the join press passed the stale guard and landed `5fd264fd2`. **(verified)**

**[F02] The scribe was handed a fifth of the file** — `tugrust/crates/tugcast/src/scribe.rs:335` caps each of BASE, OURS and THEIRS at 60 000 characters and appends `[truncated]`; `operator.rs` at `36c6d58b7` is 7 445 lines, roughly 300 KB. The prompt (`scribe.rs:353`) asks for the whole merged file or nothing. The model did the honest third thing and explained in prose why it could not. **(verified)**

**[F03] The ladder accepts any marker-free reply as a merge** — `tugrust/crates/tugarc-core/src/resolve.rs:1833` `is_clean_merge` tests only for conflict markers, and `tugrust/crates/tugcast/src/feeds/join_resolve.rs:80` says that is the whole validation. Prose carries no `<<<<<<<`, so both refusals were recorded as `ResolvedBy::Ai`, "merged clean". **(verified)**

**[F04] The resolver's audit checks coverage, not content** — `validate_report` (`tugrust/crates/tugcast/src/feeds/join_resolver.rs:154`) requires every path in the resolution set to be *mentioned*; the charter asks the model to read each machine resolution against intent. The resolver reported both prose files as `"audit": "kept"`. No mechanical check compares an AI-resolved blob to its inputs. **(verified)**

**[F05] The workshop re-parents a stale tree onto the moved base, which satisfies the stale guard by construction** — `Workshop::ensure` reads `base_head` fresh at open (`tugrust/crates/tugarc-core/src/workshop.rs:385`); `open_candidate` (`:142`) resets the checkout to the stale candidate; `commit` (`:223`) writes that tree with the fresh parent. Both stale guards, `candidate_status` (`resolve.rs:2701`) and `integrate_join` (`tugrust/crates/tugarc-core/src/ops/join.rs:2435`), test ancestry, which is now true. `6934bd19e` has `73b7376`'s exact tree `e3594957…` and parent `36c6d58b7`; that commit is the lost update. **(verified)**

**[F06] The base moving mid-run is detected by nobody** — the ladder reads `base_head` once at `resolve.rs:378`; the join board deliberately pins a stale candidate while a run holds the arc (`tugrust/crates/tugcast/src/feeds/join_board.rs:194`) and relies on it still *looking* stale afterwards, which [F05] erases. The pilot keys its mark on the head pair (`join_pilot.rs:238`) but only before a run, never after. **(verified)**

**[F07] Nothing builds a candidate before it is offered or landed** — the resolver's build loop was removed (`join_resolver.rs:1053`: *"the run's ending is where the joined tree is built now"*), and no run's ending builds anything; `join_resolve.rs:6` records the checks module once ran them. The log shows no build between 23:03:20 and 23:03:46. `.tugtool/config.toml` already declares surfaces and their checks (the `app-help` arc added `docs/` to it). **(verified)**

**[F08] Arc ↔ main is continuous; arc ↔ arc is nothing** — base-motion (`tugrust/crates/tugcast/src/feeds/base_motion.rs`) replays every live arc's rounds onto `main` whenever `main` moves and notifies the arc's session (`Decision::ReplayThenNotify`); the log shows it doing so for `app-help` at 23:00:40 and 23:01:28 and standing down on conflict (`paths=4`). No code path compares two live arcs' tips. The first of two overlapping arcs becomes visible to the second only by landing, at which point the whole divergence arrives at once. **(verified)**

**[F09] The ladder already has the rung that replays small recorded resolutions** — rung 2 is rerere (`resolve.rs:1141`): a scratch detached worktree merges the branch into the base head and harvests paths rerere resolved from the shared `rr-cache`; the ladder *teaches* the cache after each resolve (`resolve.rs:673`, `record_rerere`). Today the cache learns only at the end of an arc. **(verified)**

**[F10] The merge itself was trivial** — `git merge-tree --write-tree 36c6d58b7 dd7a54de2` yields seven conflict hunks across four files: two `OperatorContext` field groups, one import pair, two test-fixture field groups, and two verb-list paragraphs in the answer prompt. Resolved by keeping both sides in each, the result builds and passes the full tugcast suite (2 971 tests). **(verified)**

---

## Decisions {#decisions}

**[B01] Live arcs on the same base are reconciled against each other continuously, and the resolutions live in the rerere cache only.** For every pair of live arcs on one base, on every round commit of either, a `merge-tree` of the two tips against their merge-base is run. Overlapping paths are a *crossing*; conflicting hunks are a *crossing conflict*, resolved at once by the same ladder that resolves arc-onto-main, in a scratch worktree, and written **only** to the shared `rr-cache` ([F09]). Neither branch is touched: arcs cannot merge into each other, because a discarded arc would otherwise leave its code in its sibling. When the second arc joins, rung 2 replays the recorded hunks, so the join is the sum of resolutions each settled when it was one round old ([F10] shows what those look like). This is the user's call: *"Go with #1 rerere."* A visible per-pair crossing candidate was considered and set aside; the cache is the whole of the record.

**[B02] A crossing conflict the ladder cannot settle goes to the pilot's resolver against the pair, automatically.** The multi-turn resolver already works in a real checkout with `Read`/`Edit` and reports per path; running it on a one-round hunk is the cheap case it is good at. Handing the conflict back to a session was considered and rejected for the first pass: it makes a join's readiness depend on an agent's attention. Revisit if crossings prove to need intent questions often.

**[B03] Crossing work is paid only where overlap conflicts.** The `merge-tree` probe runs per round per sibling and is cheap. A ladder run, which may spawn a model, runs only on a crossing *conflict*; a clean crossing is recorded as a fact and costs nothing more. Pairs with no overlapping paths are skipped before the probe.

**[B04] Both sessions hear about a crossing.** The notification base-motion sends on a replay goes to both arcs' sessions when a crossing first appears on a path: which sibling, which file, which region. The cheapest resolution is the one an agent never has to make. Clean crossings notify too; a conflict is already too late to avoid.

**[B05] A candidate records the base it was built on, and the landing is a compare-and-swap on that base.** `anchor_candidate` stores the `(base_head, arc_head)` pair the pilot already computes; `candidate_status` compares the recorded base to the current head rather than asking ancestry; `integrate_join` refuses unless the recorded base is the head it is landing on. Joins into one base serialize behind a host gate and the comparison runs inside it. [F05] is the reason ancestry is not enough: a re-parented tree is an ancestor of anything.

**[B06] The workshop parents its commit on the base the ladder ran against, never a fresh `rev-parse`.** `Workshop::open_candidate` takes the ladder's `base_head` and `commit` uses it ([F05]). A tree built against an older base then stays visibly stale, and the ordinary demotion ([F06]) does its job.

**[B07] A run whose head pair changed mid-run anchors nothing; the pilot reconciles the new pair.** At the ladder's end and at the resolver's end the pair is re-read; on a mismatch the result is dropped with a logged reason and the pilot's ordinary path, keyed on the new pair, runs again. This is what makes a sibling's landing *automatic* for the arc that is still live: no refusal is shown to anyone. The pilot mark bounds it, so it cannot spin.

**[B08] The scribe never sees a truncated file.** Over the cap, the AI rung declines with "too large for a one-shot merge" and the path stays unresolved for the multi-turn resolver, which can finish the hunks in a checkout ([F02]). `[truncated]` never reaches a model that has been asked to emit a whole file. With [B01] in place a crossing conflict is one round's hunk and this arm is rarely reached; it must still exist.

**[B09] An AI merge may rewrite only the conflicted regions.** Before `ResolvedBy::Ai` is recorded, `merge-file`'s marker output is split at its markers and every clean segment must appear verbatim and in order in the reply ([F03]). The same check applies to a file the resolver finished. Prose fails instantly; so does a model that reformats what it was not asked to touch.

**[B10] The candidate is built before it is offered.** At the run's ending the project's declared checks for the surfaces the candidate touches are run over the workshop tree ([F07]). Green, and the offer stands; red, and it is withheld with a stuck line naming the failure. One verdict, no repair loop: the loop that was removed sent the resolver back on a red, and that is what cost it. Surface-scoped rather than the full fast lane, so a join stays within a couple of minutes.

---

## Open Questions {#open-questions}

- Whether rerere's preimage matching is stable enough across a round's later edits that a hunk resolved at round *n* still replays at the join after rounds *n+1…m* touched nearby lines. The ladder's rung 2 is best-effort by design and the per-file rungs still run, so a miss degrades to today's behaviour rather than failing; the arc should measure the hit rate on this checkout's two arcs replayed from their round commits before relying on it.

---

## Non-goals {#non-goals}

- **Merging one live arc into another.** Rejected: a discarded arc would leave its code in its sibling, and the sibling would carry it to `main`. The cache is the only shared record ([B01]).
- **A visible per-pair crossing candidate in the Changes shade.** Set aside by the user in favour of the cache alone. A crossing *fact* in the arc feed is in scope; a reviewable merged tree per pair is not.
- **Raising the scribe's 60 000-character cap.** A bigger cap is a bigger truncation on the next file; the rung declines instead ([B08]).
- **A repair loop on a red exam.** The removed loop spent the resolver's budget and stuck joins; [B10] is one verdict.
- **The full fast lane as the exam.** It would have caught this incident, and it would also put `just ci` on every join. The surface-scoped checks are the bet; widen only if a surface-scoped green lands red.

---

## Exit {#exit}

An arc. The floor lands first, because it is what stops the next incident regardless of crossings: the candidate's recorded base and compare-and-swap landing ([B05], [B06], [B07]), then the two content guards on the AI rung ([B08], [B09]), then the exam ([B10]). Each of those has a reproduction in this checkout: the three-way merge of `36c6d58b7` and `dd7a54de2` is a fixture, and a stub scribe that returns prose is the regression test for [B09]. Crossings follow ([B01], [B03]), then the resolver fallback ([B02]) and the session notice ([B04]). The open question is answered by replaying the two incident arcs' round commits through the crossing probe and counting rung-2 hits at the join.

# A partial commit orphans the hunks it left behind

**Purpose:** Committing some hunks of a file strips attribution from every hunk still dirty in it, for the committing session and for any session sharing the file. A commit must spend only the content it absorbed.

---

## Purpose {#purpose}

The report, 2026-11-15, from the `vids` project with two live sessions:

> Committing a file with shared hunks, *orphans that file* in the second session! The shared tracking is lost!

Two sessions, `vids/modish-kiosk` and `vids/vast-disc`, both edited `tools/short.py`. The Changes card showed it correctly in each: SHARED, "1 of 3 hunks" in one, "2 of 3 hunks" in the other, each naming the other as co-owner. `vids/modish-kiosk` committed its one hunk. In `vids/vast-disc` the file then left "Changes in this session" and reappeared under "Unattributed — no session claims these" at +63 −4, with a Claim button, as though nobody had written it.

The user asked for a comprehensive fix, covering every way a partial commit can strand work, not only the two-session case in the screenshots.

---

## Evidence {#evidence}

Every finding below was read out of the code. **The fault has not been reproduced in a scratch repository**; the first test of the arc is that reproduction ([B07]).

**[F01] Row liveness is a path-wide cut at the last commit touching the path.** `min_live_at_ms` in `tugrust/crates/tugchanges-core/src/changes.rs:654` runs `git log -1 --format=%ct -- <path>` and returns `(commit_secs + 1) * 1000`; a row is live iff `row.at >= cut`. The module doc states the premise: "a commit *spends* the rows it absorbs". The rule spends every row on the path, with no reading of what the commit absorbed. **(verified)**

**[F02] Two readers apply the cut independently, and both must change together.** The sync engine applies it in `resolve_changes` (`changes.rs:492`–`510`, including the rename join's second cut for the old name) and in `ledger::foreign_proof_sessions_for_path` (`ledger.rs:170`). The async feed applies it in `tugrust/crates/tugcast/src/feeds/changeset.rs:376`–`388` through `cached_min_live_at_ms` (`:1311`, cached by HEAD oid) and its own `min_live_at_ms` (`:1340`). **(verified)**

**[F03] The span reader drops the per-hunk evidence with the same cut.** `contention_verdict` skips any span with `row.at < min_live` (`feeds/changeset.rs:1062`), commented "a spent span is evidence about committed content, not about this dirty file". After a partial commit that comment is false for every span of an unelected hunk. **(verified)**

**[F04] Hunk elections are what broke the premise.** `stage_partial_and_commit` (`tugchanges-core/src/commit.rs:432`) stages a filtered patch through `git apply --cached` and commits with no pathspec, so the path gains a commit while part of it stays dirty. The liveness rule predates this mode and was not revisited when it landed. **(verified)**

**[F05] Nothing at commit time compensates.** `do_changeset_commit` (`tugcast/src/feeds/agent_supervisor/control/changeset.rs`, around `:1145`) runs the commit, bumps the changeset feed, records a landing receipt and a commit fact, and writes no file-event rows for what it left behind. **(verified)**

**[F06] The fault is wider than the report.** By [F01] the same cut orphans three cases: a co-owner's hunks when another session lands its own (the report); a single session's own leftover when the user unchecks a hunk and commits the rest; and any leftover after a partial commit made outside Tug (`git add -p`, `git commit <other paths>` after partial staging). The existing test `elected_hunk_lands_alone_and_the_rest_stays_dirty` (`commit.rs:1036`) asserts the git state only, never the attribution of the remainder. **(verified by reading; the second and third cases are inference from [F01], not observed)**

**[F07] The evidence needed to decide survival already exists.** Span rows decode to `Anchor` (`tugchanges-core/src/contention.rs:71`): `AddedLines` (per-line hashes plus a head), legacy `Content`, `Hunk { id }`, `WholeFile` (a file hash plus line hashes), and bare `Whole`. `claim_for` (`contention.rs:397`) already places anchors against the current hunks, and already has a strict reading for dead owners in which an anchor that fails to place contributes nothing. The report's rows were origin `cmd` and the card counted their hunks, so those rows carried placeable spans. **(verified)**

**[F08] Bare `Whole` anchors are unfalsifiable.** A claim row, an edit past `ANCHOR_LINE_HASH_CAP`, a legacy row, and an unreadable span all decode to `Anchor::Whole`, which records no content. No read-time test can show such a row's content survived a commit. **(verified)**

**[F09] Hunk elections enter through one door, and that door can write the ledger.** Only tugcast's `changeset_commit` control action carries a `hunks` map (`control/changeset.rs:23`, `:107`); the `tugtool commit` CLI has no election. tugcast is the single writer of `changes.db` (`tugcast/src/changes_writer.rs`), and the claim handler in the same file already writes proof rows with spans through `record_file_events_with_spans` (`session_ledger.rs:7006`). **(verified)**

**[F10] A settled decision sits next to this change.** `spent_rows_never_reclaim_a_redirtied_file` (`changes.rs:865`) and `foreign_exact_query_drops_spent_rows_behind_the_liveness_cut` (`ledger.rs:599`) pin that a row absorbed by a commit never attributes or contends when the file goes dirty again. **(verified)**

---

## Decisions {#decisions}

**[B01] A commit spends the content it absorbs, not the path.** A row at or after the cut is live, as today. A row behind the cut is live when its content demonstrably survived: it still places in the current diff, and no commit since the row took it ([B02]). This replaces "postdates the last commit on the path" as the liveness rule everywhere it is read. It is a read-time rule on purpose: commits arrive from doors Tug does not own ([F06]), and a rule that depends on Tug having made the commit would leave those orphaned.

**[B02] Survival needs two tests, and both must pass.** First, one of the row's anchors places in a hunk of the current HEAD-to-worktree diff under the strict matchers: a line-hash match, a single-hunk containment match, or a `Hunk` id match, the same reading `claim_for` gives a dead owner. Second, no commit to the path after the row's timestamp added that content. The second test is what keeps [F10] true: without it, a block committed long ago and later moved or re-added by hand would revive its original author's row and claim an edit that session never made. Its cost is one `git log -p` over the path since the oldest candidate row, paid only for dirty paths holding pre-cut rows with placeable spans, and cacheable by HEAD oid as the cut already is.

**[B03] The rule is one pure function in `tugchanges-core`, and both readers call it.** It takes the row's anchors, the current hunks, and the added text of the commits since the row, and answers live or spent. Each reader gathers the git inputs its own way, sync or async, exactly as `classify_contention` is shared today. Two hand-written copies of the cut are how [F02] came to need a two-site fix; the survival rule must not repeat that.

**[B04] A surviving row keeps only its surviving evidence.** Spans are filtered by the same test per span, not per row, so a row whose edit reached two hunks, one landed and one not, claims only the one still dirty. This replaces the blanket `row.at < min_live` skip of [F03]. Without it a survivor would carry anchors for committed content, which fail to place and widen a live owner's claim to the whole file, turning a fixed orphan into a false SHARED badge.

**[B05] A bare `Whole` row behind the cut stays spent at read time.** By [F08] it cannot prove survival, and reading it as live would reverse [F10] for every claim row and legacy row on the machine. `WholeFile` is falsifiable and takes the strict reading: live when the file's bytes still hash to what it wrote, otherwise judged by its line hashes under [B02].

**[B06] A Tug partial landing carries forward what it left.** [B05] leaves one gap: an owner whose only evidence is a bare `Whole` row loses the remainder when anyone lands part of the file. The landing door knows better than any reader can, so it closes the gap. When `do_changeset_commit` lands a hunk election on a path, it reads the contention verdict before the commit, and after the commit writes one fresh proof row per owner whose claim covered a hunk still dirty, the committing session included. The row carries `hunk` spans naming the remaining hunk ids that owner claimed, read from the post-commit diff, and is stamped at or after the new cut so the tie rule cannot spend it. An owner whose remaining hunks cannot be named by id gets a bare whole span, the blessed widening. A whole-file landing writes nothing. A failed carry write is logged and never fails the commit, the same standing the landing receipt has ([F05]). By [F09] this needs no new writer and no new door.

**[B07] The tests pin every case of [F06] and guard [F10].** The arc opens with a failing test of the report: two owners, three hunks, one owner lands its one, and the other's file stays attributed with its two hunks, names no co-owner, and is not SHARED. Beside it: one owner lands two of three and the leftover stays attributed with its one hunk; a partial commit made by plain `git` leaves the remainder attributed; a re-added identical line does not revive a spent row; a claim row survives a Tug partial landing through its carry row; a row spanning a landed hunk and an unlanded one claims only the unlanded one. `spent_rows_never_reclaim_a_redirtied_file` and `foreign_exact_query_drops_spent_rows_behind_the_liveness_cut` stay green with their assertions untouched. The cases run against both readers, since [F02] is two implementations of one rule.

**[B08] No schema change.** Carry rows are ordinary file-event rows with ordinary spans under a new origin string, and the survival rule reads columns that already exist. `CHANGES_SCHEMA_VERSION` stays at 4. The new origin must be added to the proof-origin set in both places `the_proof_origin_set_is_the_same_at_the_row_and_query_levels` compares, or carry rows will not attribute.

---

## Open Questions {#open-questions}

- **Whether hunk ids are stable across a partial landing in every case.** A hunk id hashes the hunk's body, context lines included. Separate hunks share no lines, so landing one should not move another's id, but two hunks whose context windows nearly touch may re-split after the landing. [B06] already degrades to a whole span when an id cannot be found, so this decides how often the degradation fires, not whether the design holds. A test over adjacent hunks settles it.

---

## Non-goals {#non-goals}

- **Carry-forward alone, without the read-time rule.** Rejected: it fixes only commits Tug makes. A `git add -p` commit would orphan exactly as today ([F06]).
- **The read-time rule alone, without carry-forward.** Rejected by the user ("Build both"): a claimed file followed by a partial commit is a plausible gesture, and [B05] would orphan its remainder.
- **Reading bare `Whole` rows as live behind the cut.** Rejected in [B05]: it reverses [F10].
- **Moving the cut itself**, for example to the last whole-file commit. Rejected: git cannot say cheaply whether a commit took a whole file's dirt, and the cut would still be path-wide, so a row for content landed by a partial commit would stay live.
- **Recording each commit's absorbed hunks in the ledger and judging liveness from that.** Rejected: it needs a schema change and covers only Tug's own commits, where [B02]'s second test reads the same fact from git for every commit.
- **Repairing rows already orphaned on users' machines.** The read-time rule revives any orphaned row whose spans still place, with no migration. Rows it cannot revive are claimable by hand, as they are today.
- **Changing the hunk election, the SHARED badge's meaning, or the Changes card's layout.** This work changes which rows are live and nothing about how live rows are shown.

---

## Exit {#exit}

**An arc.** A shape for its first steps, in the order they must land:

1. The failing tests of [B07] for the report's case, in both readers, so the fault is reproduced before anything changes.
2. The pure survival function of [B03] in `tugchanges-core`, with unit tests over anchors, hunks and commit text, including the re-added-line guard of [B02].
3. The sync reader: `resolve_changes` and `foreign_proof_sessions_for_path` judge pre-cut rows through the function, including the rename join's old-name cut.
4. The async reader: the owner fold and `contention_verdict` in `feeds/changeset.rs` do the same, with the per-span filter of [B04] and a HEAD-keyed cache for the commit text.
5. The carry rows of [B06] in `do_changeset_commit`, with the new origin registered per [B08].
6. The remaining cases of [B07], and the module docs in `changes.rs`, `ledger.rs` and `contention.rs` rewritten to state the new rule.

Steps 3 and 4 must both land before the rule is true anywhere a user can see it: the Changes card reads the async feed, and `tugtool changes` and the app-test selector read the sync engine.

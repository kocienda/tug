# Partial file claims — why they never fire, and the fix

This brief covers the hunk-aware SHARED feature landed in `a889ff720` (changes-rework M03) and hardened in `0d95ab38d`. The mechanism is wired end to end and correct in the lab. In the field it almost never fires: on a contended file the sub-file evidence fails to place either owner inside a hunk, both widen to a whole-file claim, and a commit of a file badged **SHARED** lands the co-owner's work under this session's message. The feature is silently degraded, not broken — which is why nothing looked wrong.

The visible tell is a SHARED row with **no `N of M hunks` badge**. `defaultElection` (`tugdeck/src/lib/hunk-election.ts`) renders that badge only when `own_hunks` is a strict subset of the file's hunks. SHARED with no badge means the session is claiming the whole file, and `ChangesRouteController.commit` faithfully sends exactly that.

## What the measurement found

Replaying 400 real span rows out of the live `changes.db` against the commits that landed them, reimplementing `parse_hunks` + `content_matches` outside the app:

| outcome | spans |
|---|---|
| no match → **Whole** | 182 |
| placed by head | 51 |
| placed by hash | 17 |
| ambiguous (>1 match) → **Whole** | 1 |
| `whole` kind (Write / claim) → Whole | 31 |
| not evaluable (no correlatable commit, or `hunk` kind) | 118 |

**78 of 82 owner/path pairs widened to a whole-file claim.**

One caveat on the rate: the comparison used commit diffs, which aggregate successive edits to one region and so destroy some anchors that would have placed against the live dirty diff. Treat 73% as an upper bound on the span-level failure rate. It does not soften the diagnosis — the causes below are structural, independent of that caveat, and each is fatal on its own.

## Why the evidence cannot place an edit

`spans_for_tool_input` (`tugcast/src/feeds/attribution.rs`) records the anchor as the raw `Edit.new_string`: `content_hash` of the whole string, its first 200 bytes as `new_head`, its full byte length as `new_len`. `content_matches` (`tugchanges-core/src/contention.rs`) then places it against `added_text(hunk)` — the hunk's `+` lines only, with the `+` stripped. Three independent reasons that comparison fails for a real Edit:

**C1 — `new_string` carries unchanged context.** An Edit's old/new strings include surrounding lines for uniqueness. Those lines are *context* in the diff, not added, so neither `content_hash(added_text) == new_hash` nor `added_text.contains(new_head)` can hold. Real example out of the ledger: head `'            glyphPosition="both"\n            size={12}'` against added text `'            size={12}'` — one of the two lines changed, so the anchor's text is not in the hunk's added text.

**C2 — the length floor compares the wrong two quantities.** `added_text.len() >= new_len` measures the hunk's added bytes against the entire replacement's bytes. A 1166-byte `new_string` that rewrites 60 bytes of a comment fails the floor even when the head does match. The floor's stated purpose — keep a short head from matching a hunk too small to hold it — is sound; its units are wrong.

**C3 — one edit legitimately spans several hunks.** An import plus its call site is one Edit and two hunks, and the anchor's text is in neither alone. Where it does match two, `claim_for` treats that as ambiguity and returns `Whole`.

Compounding all three: `claim_for` is all-or-nothing. A single unplaceable anchor widens its owner to the whole file. A session that touched a file ten times gets ten chances to fail, and needs only one.

## Why the tests are green

Every fixture mints the anchor *from the added text*. `contention.rs`'s `content(text)` helper hashes exactly the added line; `changeset.rs`'s `compose_reads_disjoint_regions_of_one_file_as_uncontended` writes `new_head: written` where `written` is a single added line with no context. That is the one shape production never produces. The tests prove the algebra over ideal evidence and say nothing about the evidence format the relay actually writes — no test in the corpus constructs its anchors by calling `spans_for_tool_input`.

## The fix

### F1 — record the changed lines, not the whole replacement

Fix the evidence at the source rather than teaching the matcher to tolerate it. At record time, diff `old_string` against `new_string` line-wise and store the *added* lines' content: their hashes plus a capped head, and a line count in place of `new_len`. The anchor then has the same shape as the thing it is compared against, matching becomes exact rather than heuristic, and C1 and C2 disappear together. `insert` anchors (no `old_string`) are already this shape and are unaffected.

This is the load-bearing change. The remaining three are what make its answer usable.

### F2 — let one anchor claim several hunks

Replace "exactly one match, or widen" with "claim every hunk this anchor matches." Multi-match is the normal case for a real edit (C3), not ambiguity. Claiming both hunks is still the conservative direction — conservative *within* the file, instead of jumping to all of it. Genuine ambiguity (identical text added in two unrelated regions) then costs one extra claimed hunk rather than the entire file.

### F3 — split the widening rule in two

One policy currently serves both the badge and the default election, and it widens both. The two want opposite failure directions:

- **`shared` (the badge) widens.** An owner with an unplaceable anchor wrote *something* somewhere in this file, so the file stays SHARED and the warning is honest.
- **`own_hunks` (the default election) narrows.** It carries only the hunks actually placed.

Leaving some of my own work behind is a cheap, visible error — the row stays dirty and says so. Taking the co-owner's work into my commit is the expensive, invisible one. The conservative direction for a *claim* is not the conservative direction for a *landing*, and `ContentionVerdict` should stop pretending otherwise. This is the change that makes a SHARED file useful even when the evidence is partial: "shared, and here are the regions I can prove are mine."

### F4 — one test whose anchors are real

Add a contention test whose fixture is built by calling `spans_for_tool_input` on an Edit-shaped input — `old_string`/`new_string` both carrying unchanged context lines — instead of by hashing the added text. That is the regression gate this feature never had, and the one that would have caught all of C1–C3 on the day they shipped.

## Secondary consequence worth noting

Because `own_hunks` currently equals every hunk, the deck sends a full election for SHARED files, so the commit routes through `stage_partial_and_commit` — `require_clean_index` plus `git apply --cached` — to achieve exactly what `git add` would have done. SHARED landings already pay the partial path's cost and its clean-index precondition for no benefit. Fixing placement is what makes that route earn what it costs.

## Out of scope

`hunk`-kind anchors (verb receipts, `hunk_spans`) match by id and widen the moment a later edit moves the hunk body. A content-matching fallback after id drift is the obvious repair, but it is a separate question from the Edit-anchor failure above and should not ride along with it.

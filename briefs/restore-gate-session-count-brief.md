# Restore gate counts sessions

**Purpose:** The app-modal that holds the deck while sessions restore reports progress in turns, and turns never visibly advance: the readout sits at "10 of 10 turns" on a full bar while the wait goes on. The modal should count the thing that does advance — sessions.

---

## Purpose {#purpose}

In the user's words: the modal "always gets stuck displaying '10 of 10' with a full progress bar. This is an inaccurate lie." And, after the first round of findings: "I *never* see '1 of 10'… '2 of 10'… '6 of 10'… The numbers bury themselves at their end point."

The ask is about how progress is communicated, not about how restore works. The modal stays — it is wanted, and the gate's hold, its horizons and its precedence are unchanged. What changes is what it counts and how it says so.

---

## Evidence {#evidence}

**[F01] The readout counts replay turns summed across held cards.** `restore-gate-store.ts` folds `transcript.length` against `restoreWindowTurns` for every card `deriveRestoreGateHold` holds, plus each body card's `cardRestoreHold`; `TugRestoreGate` renders it as `<n> of <m> turns`. Read from the code. **(verified)**

**[F02] Turns reach the transcript in one or two jumps at the very end, so the count cannot climb.** `tugcode` ships replay frames in `replay_batch` lines of 256 (`REPLAY_BATCH_SIZE`, `tugcode/src/replay-runner.ts`), and the deck's engine defers them until 250 events or `replay_complete` (`REPLAY_FOLD_FLUSH_THRESHOLD`, `session-engine.ts`). A throwaway app-test (`tests/app-test/zz-probe-restore-timing.test.ts`, untracked) resuming copies of real transcripts logged `commits=2`–`3` per restore, with the visible count appearing at its final or near-final value — "10 of 10", or "8 of 10" then "10 of 10". **(verified)**

**[F03] Most of the wait happens before any turn exists.** For the 181 MB `tug-site` session `b75d5dce`, the release deck's `tugcast` log shows 0.96 s of read, parse and compaction dedupe before the replay bracket opens, 1.04 s translating 20,101 frames for its 10-turn window, and 1.44 s more before the bracket closes — about 3.5 s, on at least six launches on 2026-10-28. In the harness the same session held the gate for 2.0 s with no count shown for the first 1.66 s. **(verified)** That the 1.44 s tail is the card taking in frames is inference; a timer around the card's intake would confirm it.

**[F04] The reveal is not where the time goes, and the 10 s bound was never reached.** Every harness restore — one at a time and four at once, sizes 0.4–181 MB — ended on a real `perf.transcript_settle` of 40–170 ms, and the full bar stood for at most ~120 ms before the gate closed. **(verified)** The live "stuck at 10 of 10" was not reproduced: the harness drives each card's resume directly rather than through the shell's cold-launch restore pass, and the release instance logs neither the gate's open and close nor the deck's per-card timings.

**[F05] The summed readout runs backwards across several cards.** Four cards restoring together read, in order: "40 of 40" → "30 of 30" → "20 of 30" → "Restoring 2 sessions, 10 of 20" → "Restoring 1 session, 8 of 10". A finished card leaves the fold, so the total, the count and the title's session count all shrink. It also showed "N of N" before any turn had arrived. **(verified)**

**[F06] Cards join the gate over time on a real launch.** Staged bodies make at most two pages at once (`BodyLane.width`, `tuglaws/shell-and-bodies.md`), and a card counts toward the gate only once its page reports a hold — so a total read off the current holders would grow mid-restore as well as shrink. Read from the code and doctrine; not measured on a live launch.

---

## Decisions {#decisions}

**[B01] The modal shows exactly one count, and it counts sessions.** Turns leave the modal entirely. A session is a unit the user cares about, and each one finishing is a real event, so "2 of 5 sessions" is honest and so is a bar over it — it fills in steps, which is the truth about the work. Turns fail on both counts ([F02], [F03]); internal units such as bytes or frames were considered and rejected as plumbing (see Non-goals).

**[B02] The title carries no number.** "Restoring sessions", with the count beside the bar. "Restoring 5 sessions" over "2 of 5" states the total twice — the user asked for one number, not two.

**[B03] The total is fixed when the gate opens and comes from the shell's restore pass, never from the current holders.** The total is the shown session cards the restore pass is resuming on this launch — known before any page exists. Cards in inactive tabs and parked workspaces are not in it, since they do not restore until shown. This is what keeps the count from shrinking ([F05]) or growing ([F06]). A card shown and resumed while the gate is up starts a new restore; it does not change this one's total.

**[B04] A session counts as done when its hold ends, by any of the gate's existing exits.** Its reveal settles, it hits the settle bound or the replay silence deadline, or it raises an error. A failed session still ends its wait; the failure shows on its card, as today. The count only ever rises.

**[B05] A one-session restore shows the title and an activity spinner, with no count and no bar.** "0 of 1" → "1 of 1" says nothing.

**[B06] Each card's hold stops carrying turns.** `cardRestoreHold`'s `turnsLoaded`/`turnsTarget` and the store's turn sums go, since nothing reads them once the modal counts sessions. The gate's open/close predicate (`deriveRestoreGateHold`) is unchanged.

---

## Open Questions {#open-questions}

- **Should the panel wait about 500 ms before it appears?** Most restores finish well under a second ([F04]), so the panel often flashes. The scrim and the input block would still go up at once; only the words would wait. Raised, not answered.
- **What actually held the live gate at a full bar?** [F04] could not reproduce it. Reading the release deck's trace after a launch would answer it, but that needs the `diag/eval` setting on `release-main`, which is the user's call. The session count does not depend on the answer, but a hold that really sits for seconds after its card has drawn would be a separate bug.

---

## Non-goals {#non-goals}

- **Changing how restore works.** Replay batching, the fold threshold, staged bodies and the gate's horizons stay as they are. The batching is right for load time; this is about what the modal says.
- **Dropping or narrowing the app-modal.** Considered on the ground that bodies now run in their own processes ([D214]) and rejected by the user: the modal stays app-wide.
- **Counting turns more finely.** Even with finer commits, a 10-turn window counted in turns says nothing about the second or more spent before the first turn exists ([F03]).
- **A staged bar over internal units** (bytes read, lines scanned, frames translated or delivered, via a new `replay_progress` frame). Rejected as the wrong metaphor: honest, but measured in units the user does not care about.
- **A per-session checklist under the count.** Considered, and rejected for the single number ([B01], [B02]).
- **A bar over estimated time** from past restores. A guess drawn to look like a measurement.

---

## Exit {#exit}

An arc. Its shape, roughly in this order:

- The shell's restore pass (`tugdeck/src/lib/session-restore.ts`) names the sessions it is resuming on this launch, giving the fixed total ([B03]).
- `restore-gate-store.ts` publishes `sessionsDone`/`sessionsTotal` in place of the turn sums, marking a session done when its hold ends ([B04]); the shell-to-overlay bus value `overlay.restoreGate` (`bus/declarations/overlay.ts`) carries the same, and `cardRestoreHold` drops its turn fields ([B06]).
- `TugRestoreGate` renders the title, the session bar and count, and the one-session spinner ([B02], [B05]), keeping the last frame steady on the way out as it does today.
- `at0720-restore-gate-holds-through-reveal` and `at0600-restore-gate-silence-deadline` still hold; the new assertions are a count that never falls, a total that does not move after the gate opens, and no count for one session. The probe in `tests/app-test/zz-probe-restore-timing.test.ts` is a reference for driving several real transcripts at once, and is deleted once the arc's own tests stand.

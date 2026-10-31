# Closing a Session card stops all of its work

**Purpose:** Closing a Session card must end every piece of work running on that session's behalf — the claude process and every subprocess under it, the bridge, and every agent call keyed to the session — and nothing the Observer shows afterwards may suggest otherwise. Today the close reaps tugcode with a SIGKILL that skips the one ladder that reaches claude's own process group, and the Overview column displayed three-hour-old posts under fresh ones, which read as a closed session still working.

---

## Purpose {#purpose}

On 2026-10-30 the user closed `tug/henna-colt` and then saw a column of Observer posts under its name in the Overview — "running the sheet's app-test", "the app rebuilt" — at the bottom of the column, among the newest posts. Their words: "This session's card is *closed*. Why is it doing work???? It makes me think that we are not in control of terminating work when I close a session card." And the rule they stated: "All work related to a session *must stop* when I close its card."

Two things are in play, and the brief keeps them apart. The posts the user saw were old (2:24–2:40 PM, shown at 5:35 PM), so in this instance no work ran after the close — the Overview misordered them. But the question the sighting raised is real: the close path as built does not provably stop a session that is mid-tool, and the Observer makes a model call on a session's behalf after its card is gone.

---

## Evidence {#evidence}

**[F01] henna-colt did no work after its close.** Its transcript's last turn and its last Observer post (`overview_posts` row 4742) are both 2:54 PM. The ledger shows it resumed at 5:31:31 PM (`request_replay.dispatched`, `reload_reason="restore-open"`) and closed at 5:31:42 PM (`relay cancelled` → `bridge.relay_outcome cancelled` → `ledger.mark_closed`, same millisecond). No claude process with that session was present in `ps` at 5:33 PM. **(verified)** — `tugtool session show`, `just db-inspect` over the release-main `sessions.db`, and `~/Library/Application Support/Tug/instances/release-main/Logs/tugcast.log.2026-10-31`.

**[F02] The Overview column was out of ledger order.** Read through the eval door on the live Overview card: rows ran `4769…4786, 4733–4736, 4728–4732, 4787, 4788`. The nine displaced rows are henna-colt's posts from 2:24–2:40 PM, shown beneath posts from 5:30 PM. **(verified)**

**[F03] The cause was the store's tail merge.** `list_overview_posts_ok` is broadcast with no request correlation; every body page that opens requests its own tail of 50, and every store hears every reply. `OverviewStore.onTail` in `tugdeck/src/lib/overview-store.ts` committed `dedupe([...incoming, ...held])`, which put the whole incoming tail in front and left any held post older than that tail's window behind it. The two displacements match card openings at 5:19 PM and 5:30–5:31 PM. A unit test reproduces the exact shape (`5,6,7,8,3,4,1,2`). **(verified)** — the test is in `tugdeck/src/__tests__/overview-store.test.ts`, red before the fix and green after.

**[F04] The order fix is in the working tree, uncommitted.** `onTail` now keeps held posts older than the incoming tail's first id in front of it; `tsc` is clean, the three Overview store suites pass (45 tests), and `at0570-topline-currency` is green. The change is not yet on `main`. **(verified)**

**[F05] What a close does today.** `do_close_session` (`tugrust/crates/tugcast/src/feeds/agent_supervisor/control/session.rs`) removes the ledger entry, cancels the entry's `CancellationToken`, publishes `SESSION_STATE closed`, and marks the row closed. The bridge's relay returns `Cancelled` on that token and drops its `SessionChild`, whose tokio `Child` is `kill_on_drop(true)` — a **SIGKILL to tugcode**, which `test_session_child_drop_kills_subprocess` pins as "the mechanism the supervisor relies on". No SIGTERM is sent first. **(verified)** — `agent_bridge.rs` lines ~1867 and ~473, and the test at ~6960.

**[F06] The ladder that reaches claude's tree lives in tugcode, below the SIGKILL.** `tugcode/src/claude-process.ts` spawns claude with `detached: true` (setsid: own session, own process group, pgid == pid) so `process.kill(-pid, …)` in `terminate()` reaps claude *and* every tool subprocess — "the backgrounded `sleep`, the test sweep, the build". That `kill(-pid)` runs from tugcode's `quiesce` on SIGTERM/SIGHUP/SIGINT or stdin EOF. A SIGKILLed tugcode runs none of it. **(verified from the code)**

**[F07] So a close mid-tool is not shown to stop the tool.** Inference from F05+F06: after the SIGKILL, claude's stdin pipe closes. What claude does on EOF while a Bash tool (a `cargo build`, a `just app-test`) is running — exit at once, finish the tool call, or finish the turn — is Claude Code's behaviour, not Tug's, and nothing in Tug signals the group. henna-colt (F01) was idle when closed, so that sighting does not settle it. **(not verified)** — what would: close a card whose session is inside a long `sleep 300` Bash call and read `ps` for the sleep, under the harness.

**[F08] The Observer calls a model on behalf of a closed session.** `observer.rs` watches `SESSION_STATE` and on `closed` or `errored` fires `WakeReason::SessionEnd` — a shared-agent (Sonnet) call that may post a wrap-up under the session's name after the card is gone. The session's `SessionWindow` entry is never removed from the map; its buffer is taken and `armed_at` cleared, so no further timer wake fires unless frames arrive, which a dead session cannot send. **(verified from the code)**

**[F09] Other per-session machinery already follows the token or the state.** The arc runner's engine runs under the instance's cancel token and a stage card's close takes its arc out of the sweep (`do_close_session`, "a card seated by a stage takes its arc out of the sweep when it closes"). The facts library records `session.closed`. The deck's `cardServicesStore` sends `close_session` on `observeCardWillBeginDestruction` for every bound card, and `closeUnboundCard` for cached-row cards in a deleted workspace; a workspace *switch* deliberately sends nothing. **(verified from the code)**

---

## Decisions {#decisions}

**[B01] A close signals claude's process group before anything is dropped.** The order becomes: cancel → tell tugcode to quiesce (SIGTERM, which its `quiesce` already handles) → tugcode's `terminate({escalate: true})` sends `kill(-pid, SIGINT)` to claude's group, waits its 1.5 s grace, then `SIGKILL`s the group → tugcast's `kill_on_drop` remains the backstop for a tugcode that does not exit. Why: the only code that can reach a build or a test sweep started by the session is the `kill(-pid)` in tugcode, and a SIGKILL to tugcode skips it (F05, F06). What it rules out: relying on claude's own EOF behaviour for anything.

**[B02] The close is verified by a harness test that closes a card mid-tool.** A session inside a long-running Bash call is closed; the test reads `ps` for the tool's subprocess and for claude and asserts both are gone within the ladder's grace. Why: F07 is the one thing this brief could not establish by reading, and a close that is not measured will be believed rather than known. The test's budget stays under the app-test corpus cap.

**[B03] The Observer makes no model call for a closed session.** The `SessionEnd` wake is removed, and the session's window is evicted on `closed`/`errored` rather than left in the map. The close itself is already a fact (`session.closed`, F09) and stays one. Why: the user's rule is that *all* work stops, and a Sonnet call that writes a post under the session's name after its card is gone is work in exactly the sense that alarmed them — a post arriving minutes after a close is the sighting this brief exists over, whether or not its content is a wrap-up. What would reopen it: a decision that the Overview should narrate the end of a session, in which case the line is written from the fact, not from a wake.

**[B04] The Overview column holds ledger order, always.** The `onTail` fix (F04) is the rule made concrete: a post is placed by its ledger id, and no broadcast reply — tail or page — may move a held post. Why: the Overview is the surface the user reads to know what is running, and an out-of-order column reads as a lie about time (F02). The fix lands on `main` before the arc opens, so the arc's worktree has it.

**[B05] A close that stops work is still a "stop the subprocess, keep the history" close.** Nothing here changes `reset_session`, the ledger row, or the rebind-on-restart path; the session can still be reopened with its history. Why: the user's complaint is about work continuing, not about history persisting, and the existing ledger contract (`do_close_session`'s comment) is right.

---

## Open Questions {#open-questions}

- Whether claude, on a closed stdin, finishes an in-flight tool call before exiting (F07). B02's test answers it empirically; the answer decides whether B01's SIGINT rung is a nicety or the whole fix.
- Whether tugcast should wait for tugcode's exit (bounded) before publishing `closed`, so the `closed` frame means "stopped" rather than "asked to stop". Today the frame goes out before the drop. If B02's test shows the grace is reliably under a second, publishing after the wait is cheap and makes the deck's state honest; otherwise `closed` stays as it is and a later `SESSION_STATE` carries the exit.

---

## Non-goals {#non-goals}

- **Keeping the Observer wrap-up as a non-model post.** Considered: write "session closed" into the Overview from the fact instead of the wake. Not done here — the Overview already has the session's state dot, and adding a post per close is a product choice the user has not asked for. Recorded so it is not re-proposed as a substitute for B03.
- **Changing what a workspace switch does.** A switch parks cards and keeps their sessions alive by design (`deck-manager.ts`, [B05]/[B06] of that work); this brief is about the close gesture only.
- **A second Overview tail fix for pages.** Paging (`before_id`) already correlates and drops foreign replies; the order rule in B04 is the tail's, and `at0367`'s reading-line drift is a separate open defect, red with and without F04's fix (see memory `at0367-red-on-main`).

---

## Exit {#exit}

**An arc.** The first steps, in the order they must land:

1. Land F04's Overview order fix on `main` (the user's `/commit`), so the arc forks with it.
2. The harness test of B02: close a card whose session is inside a long Bash `sleep`; assert claude and the sleep are gone. It lands red first and names what today's close leaves running.
3. B01: the close path signals tugcode to quiesce and lets tugcode's `kill(-pid)` ladder run before `kill_on_drop` fires; the test from step 2 goes green.
4. B03: remove the Observer's `SessionEnd` wake and evict the session's window on close; adjust the Observer tests that pin the wake.
5. Settle the second open question from the measurement step 2 produced, and write the answer into the close path's doc comment.

# The dash lifecycle

*What a dash **is**, what its states mean, and what a binding is. The companion file [dash-work-doctrine.md](dash-work-doctrine.md) covers the other half — how an **agent** behaves once it is working on one. Two audiences, two files: a person asking "why does this dash read as unbound" and an agent asking "may I write here" are not asking the same question.*

## What a dash is

A dash is four things and no more:

1. **A git branch**, `tugdash/<name>`.
2. **A worktree**, conventionally `.tug/worktrees/<name>` under the main repository root.
3. **Branch config** — `branch.tugdash/<name>.{tugbase,description,tugid}`. Each key is spelled in exactly one place (`base_config_key`, `description_config_key`, `tugid_config_key` in `tugdash-core/src/ops.rs`); they hang off the **raw** dash name, not the sanitized spelling worktree directories use.
4. **A dash-log**, the append-only record of rounds and declarations.

There is no dash database. Every fact any surface renders about a dash is read from one of those four on demand, which is why `tugtool dash list` and the Changes card cannot disagree: both call `dash_detail_entries_in` (`tugdash-core/src/ops.rs`), which is the one composition.

**Every dash op resolves the main repository root first.** `main_repo_root` normalizes whatever root it was asked from, because a dash's branch and worktree live in the *main* repository whichever checkout the question came from — and a card's project directory may itself be a linked worktree (`just app-debug` produces exactly that). A path handed outward is therefore **absolute**, resolved where the main root is known ([D138]); nothing downstream composes one, because nothing downstream can.

## Identity

The owner key is `tugdash/<name>#<tugid>` (`dash_owner_key`). It is **opaque** — never a git ref, never displayed. Draft rows, session-binding rows, and the deck's `(workspace_key, owner_kind, owner_id)` draft-overlay key are all this same string, so entry, row, and overlay agree by construction.

What the key buys is that two incarnations of a reused name are distinct: discard `fix-join` and create it again and the second one is a different dash, so the first one's draft cannot surface under it.

- Anything that needs a **ref** reads the `branch` field. Never the owner key.
- Anything that needs a **name** for a human reads `display_name`.
- A dash created before ids existed keys under its bare branch ref. `legacy_owner_key` strips a key to that form, and `tugtool draft` reads through it and supersedes — the first resolution through the legacy key rewrites the row under the current key, so the population it serves shrinks to zero on its own.
- **Read paths never mint.** `dash_owner_key` returns the bare ref when there is no `tugid`; only write-path verbs (`create`, `commit`, the `/api/dash` bind handler) call `ensure_dash_id`. A read that wrote git config would be a side-effecting read and a multi-process race on every feed recompute.

**The sigil is `^` (U+005E).** Everywhere a dash is named to a person it wears one, with no opt-out, rendered by the single `DashSigil` component both surfaces compose — `tugtool/juicy-roach^dash-steps`. It was `#` until the collision became untenable: the transcript already numbers messages `#0001` and marks turns `#u12`, and markdown headings are hashes. `◊` replaced it and lasted a day; the lozenge measured well and read badly, which is the whole argument against picking a glyph on metrics. The caret is ASCII, present in every bundled face, and unclaimed by any other Tug grammar. The `#` inside the **owner key** is a different `#` and does not move: that grammar is opaque and never displayed.

## The stages, and derive vs declare

`derive_stage(rounds, worktree_dirty, has_draft, joining, declared)` returns one of seven words, in this precedence:

| Stage | When | Kind |
|---|---|---|
| `joining` | an incomplete join op — an interrupted teardown | derived |
| `implementing` | a `dash step` declaration is the latest | declared |
| `built` | `dash mark built` | declared |
| `audited` | `dash mark audited` | declared |
| `draft-ready` | a maintained join draft exists | derived |
| `working` | rounds past base, or a dirty worktree | derived |
| `created` | none of the above | derived |

`joining` outranks everything, including a declaration, because an interrupted teardown is the one state that actively needs a person.

**The rule: anything git can see is derived on every read and never stored; anything it cannot is declared once, in the dash-log, by a verb** ([D138]). Rounds and dirt are visible to git, so they are recomputed every time and cannot go stale; an interrupted teardown is not, and is declared on the operation record the same verb already writes. "This build succeeded" and "I am on step 4 of 9" are not visible to git at all, so a verb writes them down. **A stage is never written to a config key** — that would make the derived half stale-able and the declared half duplicated.

## Arcs and stages

An arc is a dash's **course**: a schedule of rotations that carries one dash from a plan through review, implement, and audit without anybody clicking between them — and from a brief through a devising stage first, when a brief is all it was handed. A *stage* there is a rotation of the card's claude session — a fresh session seated under the same card, on a chosen model, opening on a composed prompt — and it is **not** one of the seven derived words above. The two senses share a spelling and nothing else: a dash is `implementing` because a `dash step` declaration says so, and an arc is in its `review` stage because that is the session currently seated.

What a rotation is, what it cannot change, and when it is allowed to happen live in [wheel.md](wheel.md).

**The words, once.** A **dash** is work that leaves the base on a worktree and comes back through a **join**. An **arc** is the staged sequence the **wheel** drives a dash through — `devise`, `review`, `implement`, `audit` — and a dash has one arc or none; `tugtool dash run` opens or resumes it, `dash stop` stops it, `dash arc` reads its record. A **course** is the wheel's word for whatever is driving a card's rotations; today the only course is a dash arc. A dash is **direct** when no arc is driving it — the plain `/dash`, worked in the user's own conversation against a task list the working session writes; it is **planned** when one is, which `/dash-plan` opens. Direct is the absence of an arc and nothing more: there is no third state and no flag, because `arc == null` already says it. "Arc" never names the join: the join has its own word, and it arms, offers, and lands under it.

## Interruptions

**Every interruption to a running arc leaves the dash in a state that is both sayable and resumable, and the user is told which one.** Sayable means the record says what happened in a word the receipt can explain; resumable means there is a gesture that picks the work back up. An arc that quietly stopped advancing is the silent early return [L31] exists to forbid.

Two things hold across every row, so they are said once rather than per row. **The resume is `tugtool dash run <name>`**, and it lands at the end of the turn that asks for it: the verb runs from inside the asking session's own turn, and rotating on receipt would kill the claude that asked. And **a stop hands the card back on the deck's own model** — the last selector the user picked, never the one the last stage ran on — through the one path every stopper shares.

| Interruption | What the arc does | What the user sees | How the work resumes |
|---|---|---|---|
| Cancel during **devise** | stops as `card taken`; the half-written plan is never judged on `lint` | `arc stopped · <dash> · in devise — you took the card back` | `tugtool dash run <name>` re-rotates devise — `a_cancelled_devise_or_review_turn_stops_the_arc_as_card_taken` |
| Cancel during **review** | stops as `card taken`; the cancelled round does not burn against the review cap | `arc stopped · <dash> · in review — you took the card back` | `tugtool dash run <name>` re-rotates review — `a_cancelled_devise_or_review_turn_stops_the_arc_as_card_taken` |
| Cancel during **audit** | stops as `card taken`; the mark is the stage's product and a cancelled turn leaves none | `arc stopped · <dash> · in audit — you took the card back` | `tugtool dash run <name>` re-rotates audit |
| Cancel during **implement** | nothing — the stage sits and the next turn decides | nothing; the card is yours to redirect and the stage is still on it | type the redirect into the same stage — `a_cancelled_implement_turn_sits` |
| A machine **wedge recovery** mid-stage | nothing — tugcode marks its own cancel `is_recovery`, and the stage it recovered is alive and working | nothing | the stage carries on — `only_an_unmarked_cancel_reads_as_the_user_taking_the_card_back` |
| A **fresh session** on the card (`/new`, a reset, a rewind fork) | stops as `card taken` **at the card's next spawn**, not at the gesture: a reset parks the entry `Idle`, and a card parked `Idle` is indistinguishable from one whose tugcast just restarted | `arc stopped · <dash> · in <stage> — you took the card back`, at the next prompt | `tugtool dash run <name>` — `a_session_no_rotation_seated_is_a_card_taken_back` |
| A **model switch** mid-stage | records `model → <selector> in <stage>` and carries on; the transcript's stage divider is not rewritten | the note in `tugtool dash arc` and on the Lens row | nothing to resume — `a_model_switch_on_an_on_course_card_lands_in_the_dash_log` |
| A second **`/dash`** naming another dash | nothing — the bind is refused, and the running course is untouched | `card runs <dash> — stop it before binding <other>` | stop the first arc, then bind — `a_card_running_a_score_refuses_a_bind_to_another_dash` |
| **`dash discard`** | the seated stage is retired at its turn's end; **no dash-log line is written**, because the discard's own terminal line already closed the arc's generation | `arc discarded · <dash> · the stage's turn will end and the card returns to <model>` | nothing to resume: the dash is gone — `an_ending_writes_no_arc_line_after_the_terminal_one` |
| **`dash join`** | the same retirement, worded as the join it was | `arc joined · <dash> · the stage's turn will end and the card returns to <model>` | nothing to resume: the work landed — `a_joined_dash_says_joined_and_a_discarded_one_says_discarded` |
| **`tugtool dash stop <name>`** | stops as `stopped by user` and hands the card back | `arc stopped · <dash> · in <stage> — you stopped it` | `tugtool dash run <name>` — `a_user_stop_writes_the_record_the_receipt_and_the_hand_back` |
| **Closing the card** | records `card closed` before the row goes closed, while the binding still names the dash | nothing on the card, because there is no card; the record, `tugtool dash arc`, and the Lens all say it | `tugtool dash run <name>` from any card — `closing_a_card_seated_by_a_stage_stops_its_arc` |
| **`dash unbind`** on a card on a course | the same act with the same reason: `card closed` | as above | `tugtool dash run <name>` — `unbinding_an_on_course_card_stops_the_arc_as_card_closed` |
| A **tugcast relaunch** mid-stage | waits; the startup rebind seeds the recorded claude id, so the stage reads as current and nothing stops | nothing | the arc picks up on the card's first idle after it spawns — `a_card_that_has_not_spawned_since_startup_is_a_wait_not_a_stop` |
| A **pending rotation** lost to a relaunch | the promise is dropped on purpose; a restart ended the turn it was a promise about | nothing | the next tick decides afresh; the rule is in [wheel.md](wheel.md) — `a_card_that_has_not_spawned_since_startup_is_a_wait_not_a_stop` |
| A **side question** inside a stage (`/btw`, an `AskUserQuestion`) | nothing at all: the documents are untouched, so the predicate sees no edge | nothing beyond the question itself | the stage carries on — no test of its own; every "no document changed" predicate test asserts it |
| A **`/compact` the arc sent** ending in an API error | stops as `compact failed`; the arc never walks on with a context the compaction did not reduce | `arc stopped · <dash> · in implement — its /compact turn ended in an API error, so the context was never reduced` | `tugtool dash run <name>` — `a_compact_turn_that_ended_in_an_api_error_stops_as_compact_failed` |
| An **implement stage ending two turns closing no step** | stops as `implement idle`; a stage that has twice declined to close a step is handed back, not asked a third time | `arc stopped · <dash> · in implement — the implement stage ended two turns without closing a step` | `tugtool dash run <name>` — `one_quiet_implement_turn_waits_and_the_horizon_stops` |
| A **stage that goes silent** — one quiet turn then nothing, or a turn that never ends | stops as `stalled` once the arc's idle deadline (`[tugtool.dash].arc_stall_secs`, half an hour by default) runs out. The only stop measured against a wall clock, because these are the only two shapes that produce no edge to decide on | `arc stopped · <dash> · in <stage> — it went silent — no turn ended and no step closed before the arc's clock ran out` | `tugtool dash run <name>` — `a_hung_turn_stops_when_the_clock_runs_out`, `the_clock_runs_out_on_a_stamp_that_stops_moving` |

The side-question row is the **only** one whose middle cell is not a receipt, and that is what the row is for: nothing happens, and the table says so rather than leaving a reader to wonder whether it was forgotten.

### What a stop can say

The vocabulary is closed, and the compiler enforces it: `ArcStopReason` in `tugdash-core/src/arc.rs` carries every reason an arc can stop for, `append_arc_stop` takes it, and the receipt formatter matches it exhaustively with no fallback arm. A reason the receipt cannot explain is a reason the arc must not write.

`lint` · `api error` · `compact failed` · `implement idle` · `stalled` · `review did not stamp` · `audit did not mark` · `document missing` · `plan missing` · `session gone` · `card taken` · `card closed` · `stopped by user` · `discarded` · `joined` · `prompt unavailable` · `session idle` · `session errored` · `session closed` · `spawn queue full` · `no stdin` · `stdin closed` · `arc running`

The last seven are the wheel's own refusals, mapped through `Refusal::stop_reason`. `discarded` and `joined` exist for their sentence alone — nothing writes them to the dash-log, because the ending's own terminal line has already closed the arc's generation.

## Binding

A **bind** mates a live session to a dash. It is a UI concept: git has no idea it happened.

- It lives in the per-instance `sessions.db` and is read back **live-sessions-only** (`bound_sessions_for`). That is exactly why a dash whose cards have all closed reads as *unbound* — unbound is not a stage, it is the absence of workers.
- It is **per-card**. A session has at most one dash, which is why `unbind_dash`'s whole payload is the session id.
- It **follows the seat**. The binding is written against the tug session id — the segment a card is seated on — and a rotation never moves that id while the process lives, so the stage segments a rotation mints carry no binding of their own. A relaunch seats the card on its line's tip ([P06]), so tugcast moves each seated line's binding onto the resumed segment at startup, right after the demote and before any client asks (`seat_line_bindings`): moved, never copied, so exactly one row reports bound — `at0485-dash-binding-relaunch`.
- It **mints**: `bind_dash` naming a dash that does not exist succeeds anyway. Every sender therefore builds its frame from a snapshot row rather than from user text; the one place that accepts a typed name (`/dash-bind <name>`) matches the snapshot first and routes an unknown name to `dash create` through the shell, where the receipt says what was made.
- Two cards on one dash is **legal**, not a race: `bound_sessions` is a list and the Lens renders one jump chip per bound session. A bind displaces only *this* card's previous binding — **unless that binding is a live course**, in which case the bind is refused by name. A card runs at most one arc, and a bind that displaced one left its record reading live forever with no stop and no receipt. See [Interruptions](#interruptions).
- A bind is **never a join authority**. It says who is working; it does not say who may join.
- The store moves on the **broadcast**, never on the gesture: `bind_dash_ok` / `unbind_dash_ok` are the only movers of `cardSessionBindingStore`, which is what leaves a card correctly bound to what it was when a bind is refused.

## The dash's documents

A dash's brief and its plan live at `<main-repo>/.tug/dashes/<name>/` — `brief.md` and `plan.md` — and the **name** is their address on every verb ([D139]). `.tug/` is gitignored, so the documents are never tracked, never on a diff, and never in a worktree.

- **One copy because one home.** There is no residence to choose and therefore nothing to record: "this dash has a plan" is `plan.md` existing, read fresh on every composition ([D138]). Nothing transplants a document, restores one, archives one, or detects divergence between copies, because there is only ever one.
- **The name is the address.** `tugtool dash run|step|documents <name>` take names only; `tugtool plan lint|status|stamp` take a name *or* a path, and the argument's shape decides — a separator, a leading `.`, or a trailing `.md` is a path, anything else is a dash. `tugtool dash documents <name>` reports the directory and both files, and `--ensure` creates the directory so a skill can write into it after one call.
- **The main root, from any checkout.** Every document path normalizes through the main repository root, so a verb run from inside a dash worktree resolves the same file the base checkout would. Without that a run would write a second ledger nothing reads.
- **The ledger is written in place.** `dash step start|done|withdraw` and the replay's reconciliation rewrite `plan.md` where it lies; none of it is a commit, so a run's whole walk leaves the dash worktree byte-for-byte clean. A replay's undo and redo move the ledger's commit cells along the recorded mapping, because moving the branch no longer moves them.
- **The join removes them; the discard keeps them.** A joined dash's record is its squash commit, and the documents have nothing to add to it, so `finish_join_teardown` removes the directory and names the removal in the receipt. A discarded dash's documents are the only trace of decisions the user may return to, so discard leaves them and says where — `tugtool dash run <name>` reopens on them, and a later `dash create` of the same name starts from what it finds ([L23]).
- **`.tug/` stays out of git without anyone declaring it.** `ensure_tug_excluded` writes an anchored `/.tug/` into the repository's shared `info/exclude`, inside its own marked block, the first time a verb needs it — so a project with no `.gitignore` at all still has a clean `git status` after a dash writes a document.

## The operation log, and undoing

A dash verb that lands, moves, or deletes a branch used to be a one-way door. `tugtool dash undo` is the way back, and it rests on a log every mutating verb writes **before** it acts.

An operation has two halves, which store different facts and never the same one:

- **A keepalive ref**, `refs/tug/oplog/<seq>`, on a synthetic commit whose parents are every tip the verb is about to move or delete — the dash head, the base tip, a standing candidate, and the conflict chain. This is what makes recovery possible at all: once it exists, `branch -D` and `reset` cannot strand the dash's rounds, so they are reachable from a ref rather than from a reflog on a clock. The conflict chain is in that list because a teardown deletes its ref along with the candidate's, and the chain holds the resolver's checkpoints — the most expensive commits in the system, and the ones nothing else would keep. It is read **without** the validity gate: validity answers *may this chain be opened*, the keepalive answers *may this work be collected*, and the second question has the broader yes.
- **A payload**, `oplog-<seq>.json` in the project state dir, holding the verb, the dash, and the before/after values. It is a file rather than the keepalive's commit message because it is written twice — once before the verb acts and once when it completes — and a commit message is immutable.

Three verbs record: `join`, `replay`, and `discard`. `create` does not, because a half-made create already rolls itself back. Retention is 50 operations per repository, pruned oldest-first by the writer — no daemon and no lock file. Pruning drops both halves, and dropping the keepalive is what finally lets `git gc` collect the commits, which is the honest meaning of *no longer undoable*.

**A join's forward state lives on the same record as its reverse state.** The payload carries the teardown's phase from the moment the integrate lands, which is what `join --continue` resumes from and what every reader consults to answer *is a join in flight*; the operation it hangs on is the one an undo would reverse. There is no second file for the two to disagree about, and no second retention regime that could drop one and keep the other. The rule that keeps the meaning honest is that **a join which lands nothing records nothing**: a conflict, a stale candidate, or a failed integrate leaves the base as it found it, so the record opened for it is dropped — jj's rule that a transaction which is not committed writes no operation, which undo and replay already kept and the join now does too. An operation left incomplete therefore *means* a teardown to resume, and `undo` refuses it by name until `--continue` finishes it.

Three rules govern the undo itself:

- **It is a compare-and-swap, never a force.** It verifies the world still matches what the operation left — the base tip unmoved, the branch not since rebuilt, the worktree clean where it must be — and refuses by name otherwise: `tip-moved`, `base-dirty`, `branch-exists`, `already-undone`, `incomplete-op`, `nothing-to-undo`. `reset --keep` rather than `--hard` is the mover, so git itself refuses over changes that would be lost. An operation that later work has made un-undoable stays that way, and the refusal names the newer tip so a person can decide by hand.
- **It restores git state only.** Bindings live in a per-instance ledger and are live-sessions-only by design, so a restored dash reads as **unbound** and rebinding is the user's gesture. The report says so rather than letting it be discovered.
- **An undo is recorded but never undoable.** It belongs in the log — it moved refs — but offering to reverse it would make the verb a redo on alternate presses. So undo records are skipped when selecting what to reverse, which is what makes a second press report `already-undone` about the real operation rather than complaining about the undo.

A discard's handed-back files are the one half no undo reverses: they were *copied* into the base checkout, and pulling files back out of a user's checkout is what this engine never does. The undo names them and leaves them. When the teardown also cleared a conflict chain, `undo` puts that ref back — unless a ref already stands there, in which case it says so and leaves it: restoring older work over newer is the one thing worse than not restoring at all, and the recorded chain stays reachable through the keepalive regardless.

`tugtool dash redo` is undo's partner and reverses an undo, under the same compare-and-swap discipline and with its own refusals: `nothing-to-redo`, `already-redone`, `superseded`, plus the shared `tip-moved` and `worktree-dirty`. Two things about it are load-bearing.

**Redoing an undo — never undoing one — is what keeps the stack flat.** A redo re-applies the original operation and *clears the original's `undone_by`*, making it undoable again, so `undo, redo, undo` toggles one operation and repeated `undo` walks progressively deeper. No linked list of undo-of-undo ever forms, because the original's candidacy flag is the single source of truth for what the next press means.

**A redo is always materially possible while the undo's record stands.** An undo records itself before it acts, so its own keepalive parents the operation's *after*-tips: the landed join commit survives its own undo because the undo recorded it. Every refusal is therefore about consent rather than capability. That is why `worktree-dirty` refuses rather than sweeping: a redo of a join or discard deletes the worktree the undo gave back, and work started there in the meantime is the user's. `discard` hands such work to the base instead of refusing, but that is a teardown the user asked for while looking at it; a redo is bookkeeping, and moving somebody's files as its side effect is what this engine does not do.

Undo and redo of a replay are each a compare-and-swap on the branch **plus** a walk of the plan ledger's commit cells along the replay's own recorded mapping — reversed for the undo, forward for the redo. The mapping is exact, so neither falls back on subject matching. The ledger needs the second half because it lives outside every tree git watches: moving the branch does not move its cells with it, and a cell naming a commit the undo just made unreachable would be a wrong sha in the record rather than a stale one.

## Occupancy — the lease

A workshop has one worker. Inside tugcast that is exact: a process-global registry takes the dash before any run touches it, and a second one is refused by name — "a resolve is already running for this dash". The registry is in memory on purpose, because a tugcast restart is both the only event that orphans a run and the event that releases every hold.

What it cannot see is a **second process**. `tugtool dash join`, `tugtool dash discard`, and `tugtool dash join --resolve` run the same core from a CLI, and each of them tears a workshop down. A resolver mid-turn in that workshop loses its checkout.

So liveness is derived from git, where both processes can read it, and the thing it is derived from is the conflict chain the resolve already writes. The chain becomes the resolve's own operation log:

```
tugresolve(<dash>): end          ← the resolve exited; the lease is released
tugresolve(<dash>): checkpoint   ← one per turn that changed the tree
tugresolve(<dash>): begin        ← the resolver opened the workshop
tugconflict(<dash>): …           ← the root the ladder parked, record in its body
```

The markers are empty-delta commits carrying the tip's own tree and the tip as their only parent, so every existing reader — `read_conflict`'s first-parent walk, `open_conflict`'s reset, the salvage rung's blob reads — sees exactly what it saw before. What changes is the subject, which is the whole point.

`resolve_lease` is then a pure function of the tip, and it holds only when all four are true: a chain stands, its tip is a `tugresolve(` commit that is not the end marker, no candidate is anchored, and the tip is younger than `RESOLVE_LEASE`. Each of the four answers a case the others cannot. A bare `tugconflict(` root is a conflict the ladder parked with nobody on it — the join pilot does that unattended — so the root's age is never a lease. A standing candidate is the resolver's own receipt of completion, because anchoring one is its last act and the ladder clears any candidate before parking a new root; without it, a resolve that missed its end marker would refuse for the whole window. And the chain is read **without** the validity gate, for the same reason the keepalive is: a round landing on the dash mid-resolve invalidates the chain without stopping the resolver.

**The window is not a new number.** `RESOLVE_LEASE` is tugcast's `RESOLVE_DEADLINE` — the ceiling the resolver already enforces on itself — and the two are one constant by definition. A resolve that has not advanced its chain in that long has either died at its own deadline or lost the process running it. Nothing writes on a timer, and nothing needs to: checkpoints are per turn, and the begin marker is what carries a resolve through a slow one or a resume onto a tip that is days old.

The refusal is an ordinary named blocker, `live-resolve`, in the same vocabulary as `stale-journal`, `off-base`, `base-dirt`, and `empty` — so it reaches the card with no client change, and the preview lists it where the execute path returns it as its `Err`. Its sentence states the tip's age, the window, and **both** ways out: `--break-lease` for the CLI, and resolving again for the card, whose Resolve arm runs the ladder and starts a fresh chain. Naming only the flag would be a control that does nothing for half the people who read it.

`--break-lease` is consent, not capability. The teardown it permits is the one the verb always performed; the op log's keepalive already parents the chain tip, so `tugtool dash undo` puts the resolver's checkpoints back either way. What the flag adds is a recorded decision — `broke_lease` in the operation's `before`, printed in `dash undo --list` — and a warning naming the op number that restores what was torn down. Never a silent destruction.

The in-process registry stays as the fast path and is not weakened: every tugcast path takes it first, and a run it holds suppresses the lease blocker, because the exact answer beats the derived one wherever it exists. The lease is the backstop for the process that has no registry to ask. The model is jj's op-heads lock, which exists only to avoid duplicated work and never carries correctness — here too, a lease that is wrong costs one turn, and the op log is what makes that turn recoverable.

The CLI's `join --resolve` is guarded at the CLI rather than inside the ladder. The ladder clears the chain on both its arms, so a check in `join` would fire long after the checkpoints were gone; and a check in the ladder's core would also refuse the join pilot for the whole window after any resolver crash, wedging the one actor whose job is to clear the wreckage.

## Joining — by reference

A dash joins by `/dash-join <name>` into its base: a preview runs on entry, the squash message is edited in the composer, and the join is the human’s act. Skills draft; humans join.

The doctrine — the two beats, the one-slot `LandingMode`, and the five outcomes a join can reach — is held in [tracking-changes.md](tracking-changes.md#the-landing-workflow), where the capture and commit layer beneath it already lives. It is law where it stands and is deliberately not restated here.

## Naming

An operation is spelled the same everywhere, and that spelling is its `tugtool` verb path, hyphenated: the card verbs are **`/dash-bind`** and **`/dash-join`**.

There are no alias spellings. `dash` belongs to the `tugplug:dash` orchestrator skill, and `join` is not registered at all: the registry carries the names an operation has, and only those. A typed `/join` is submitted to Claude as a prompt, which spends a turn — the one-time cost of the rename, paid by whoever's fingers remember.

## The faces

A dash wears one grammar in two registers. Where the dash is the **subject** — Lens · Dashes, the Changes shade's dash lane, the DASH placard — it draws as the constant-width lifecycle track inside `DashLifecycleLine` / `DashLifecycleBlock`; where it is one **fact about a session** — the card's masthead title run and the Lens's session rows, both `SessionIdentityRow` — it draws as `DashLifecycleMark`: one pill, the phase glyph, and the count of the declared run. The Z2 DASH cell is neither: it is an instrument wearing STATE's construction, two dots around a reading that gives numbers whenever there are numbers and the lifecycle phase in a word otherwise, and it takes STATE's width while JOBS gives exactly that back, so the row never moves.

**The block's eyebrow says WHO, its line says WHAT.** Line one is the dash atom, the hairline, and the workers — identities, nothing else, no verbs and no state. Line two carries the whole reading: track, phase glyph, fraction, the phase in a word, the divergence facts. The step's **title** is not a run anywhere: it rode the note during implement, where it was a sentence in a slot sized for a word, and it is the fraction's hover sentence now — the placard's step list is where a reader reads titles. The phase every face keys on is the **lifecycle** phase, never the git stage above — a dash has no stage until `dash create`, which is most of the life this document describes, and the same rule now governs the Z2 dots: an arc under way pulses whether or not a branch has been cut. [D168] holds the rules.

## See also

- [wheel.md](wheel.md) — what a rotation is, when it may happen, and the other meaning of *stage*. The [Interruptions](#interruptions) table above is what happens when something gets in one's way.
- [dash-work-doctrine.md](dash-work-doctrine.md) — how an agent behaves on a dash worktree.
- [tracking-changes.md](tracking-changes.md) — the capture and commit layer beneath a dash, and the landing doctrine.
- [D112] (scope axiom), [D113], [D116] (the landing workflow), [D138] (derive vs declare), [D139] (one plan home), [D168] (one grammar, two registers).

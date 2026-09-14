# The arc lifecycle

*What an arc **is**, what its states mean, and what a binding is. The companion file [arc-work-doctrine.md](arc-work-doctrine.md) covers the other half — how **the model** behaves once it is working on one. Two audiences, two files: a person asking "why does this arc read as unbound" and a model asking "may I write here" are not asking the same question.*

## What an arc is

An arc is four things and no more:

1. **A git branch**, `tugarc/<name>`.
2. **A worktree**, conventionally `.tug/worktrees/<name>` under the main repository root.
3. **Branch config** — `branch.tugarc/<name>.{tugbase,description,laidby,tugid}`. Each key is spelled in exactly one place (`base_config_key`, `description_config_key`, `laid_by_config_key`, `tugid_config_key` in `tugarc-core/src/ops.rs`); they hang off the **raw** arc name, not the sanitized spelling worktree directories use.
4. **An arc log**, the append-only record of rounds and declarations.

The first three spellings — the branch prefix, its four config keys, and the log's file name — are **durable state rather than prose**, so they moved under the arc rename as *migrations* rather than as edits. The prefix and its keys go `tugdash/` → `tugarc/` at the top of every arc verb, one-shot and idempotent, leaving an orphaned `tugdash/<name>` alone by name when `tugarc/<name>` already exists; `dash-log.md` is renamed to `arc-log.md` on first read by the one path resolver every reader and the log watcher call. Both old spellings are read for life.

There is no arc database. Every fact any surface renders about an arc is read from one of those four on demand, which is why `tugtool arc list` and the Changes card cannot disagree: both call `arc_detail_entries_in` (`tugarc-core/src/ops.rs`), which is the one composition.

**An arc's front half has none of those four, and a surface that lists arcs must list it anyway.** Between the `/arc` door and the worktree the implement stage takes, an arc is a directory of documents under `.tug/arcs/<name>/` and nothing more — no branch, so no config and no log — which is where every plain arc begins and where a brief awaiting a plan sits. The Arcs card has always drawn those as rows; `tugtool arc list` reported only the branched half, and a name on screen with no answer from the CLI reads as two surfaces out of sync when it is one surface reporting a subset nothing declared. So `list` enumerates **both populations** in one call, told apart by `status`: `active` for a branch, `paperwork` for documents only, the latter carrying its `documents` and no base, worktree, or rounds. Membership is one rule on both sides — an arc-named directory holding at least one document, with no `tugarc/<name>` branch — and the branch clause is load-bearing: adoption leaves the base copy of the documents exactly where it was, so an arc mid-implement has a directory for its whole life and would otherwise be listed twice.

**Every arc op resolves the main repository root first.** `main_repo_root` normalizes whatever root it was asked from, because an arc's branch and worktree live in the *main* repository whichever checkout the question came from — and a card's project directory may itself be a linked worktree (`just app-debug` produces exactly that). A path handed outward is therefore **absolute**, resolved where the main root is known ([D138]); nothing downstream composes one, because nothing downstream can.

## Identity

The owner key is `tugarc/<name>#<tugid>` (`dash_owner_key`). It is **opaque** — never a git ref, never displayed. Draft rows, session-binding rows, and the deck's `(workspace_key, owner_kind, owner_id)` draft-overlay key are all this same string, so entry, row, and overlay agree by construction.

What the key buys is that two incarnations of a reused name are distinct: discard `fix-join` and create it again and the second one is a different arc, so the first one's draft cannot surface under it.

- Anything that needs a **ref** reads the `branch` field. Never the owner key.
- Anything that needs a **name** for a human reads `display_name`.
- An arc created before ids existed keys under its bare branch ref. `legacy_owner_key` strips a key to that form, and `tugtool draft` reads through it and supersedes — the first resolution through the legacy key rewrites the row under the current key, so the population it serves shrinks to zero on its own.
- **Read paths never mint.** `arc_owner_key` returns the bare ref when there is no `tugid`; only write-path verbs (`create`, `commit`, the `/api/arc` bind handler) call `ensure_arc_id`. A read that wrote git config would be a side-effecting read and a multi-process race on every feed recompute.

**The sigil is `^` (U+005E), and a caret is the arc's own shape.** Everywhere an arc is named to a person it wears one, with no opt-out, rendered by the single `ArcSigil` component every surface composes — `tugtool/juicy-roach^arc-steps`. It was `#` until the collision became untenable: the transcript already numbers messages `#0001` and marks turns `#u12`, and markdown headings are hashes. `◊` replaced it and lasted a day; the lozenge measured well and read badly, which is the whole argument against picking a glyph on metrics. The caret is ASCII, present in every bundled face, unclaimed by any other Tug grammar — and it draws the departure and return the word names, which is why it reads as the arc's mark rather than as a glyph somebody settled for. The `#` inside the **owner key** is a different `#` and does not move: that grammar is opaque and never displayed.

## The stages, and derive vs declare

`derive_stage(rounds, worktree_dirty, has_draft, joining, declared)` returns one of seven words, in this precedence:

| Stage | When | Kind |
|---|---|---|
| `joining` | an incomplete join op — an interrupted teardown | derived |
| `implementing` | an `arc step` declaration is the latest | declared |
| `built` | `arc mark built` | declared |
| `audited` | `arc mark audited` | declared |
| `draft-ready` | a maintained join draft exists | derived |
| `working` | rounds past base, or a dirty worktree | derived |
| `created` | none of the above | derived |

`joining` outranks everything, including a declaration, because an interrupted teardown is the one state that actively needs a person.

**The rule: anything git can see is derived on every read and never stored; anything it cannot is declared once, in the arc log, by a verb** ([D138]). Rounds and dirt are visible to git, so they are recomputed every time and cannot go stale; an interrupted teardown is not, and is declared on the operation record the same verb already writes. "This build succeeded" and "I am on step 4 of 9" are not visible to git at all, so a verb writes them down. **A stage is never written to a config key** — that would make the derived half stale-able and the declared half duplicated.

### The card's quiet lines are the same rule, one layer up

Every manipulation of the step list draws one line on the card bound to the arc — created, run declared, step started, closed, withdrawn, parked, reopened, `mark`, each round. **That line is a derived view of the arc log, not an act any caller performs.** `tugcast` watches each project's log and paints what it reads (`feeds/arc_notes.rs`), through the same server-authored channel the arc's own receipt uses. Watches, not polls: the log lives under the data dir where no workspace watcher reaches it, so the observer arms one of its own, and a watch that cannot be armed logs loudly rather than falling back to a timer.

The alternative — each verb posting its own announcement — was tried and is wrong twice. A post is a **second fallible write**, which is exactly the shape of Part II's "verbs succeed while achieving nothing": a row that moved and an announcement that did not is a gesture nothing anywhere knows was missed. And a post is an **act a caller performs**, so a caller can omit it — every new call site and every hand-run verb another chance to forget, which is the shape of the incident these lines exist because of.

Deriving inverts both. The announcement is skippable only by not writing the record, at which point the mutation did not happen; and a verb run by hand in a bare terminal draws the line identically, because nothing about the caller is an input. The generalization worth carrying: **a fact that must be seen is derived from the record that must be written, never announced beside it.**

## Stages

The **wheel** drives every arc through a schedule of rotations, carrying it from a plan through review, implement, and audit without anybody clicking between them — and from a brief through a devising stage first, when a brief is all it was handed. A *stage* is a rotation of the card's claude session — a fresh session seated under the same card, on a chosen model, opening on a composed prompt — and it is **not** one of the seven derived words above. The two senses share a spelling and nothing else: an arc is `implementing` because an `arc step` declaration says so, and it is in its `review` stage because that is the session currently seated.

What a rotation is, what it cannot change, and when it is allowed to happen live in [wheel.md](wheel.md).

**The dispatch makes the seat before it names it.** An implement or audit stage is handed its worktree on the `where` line as a fact, so the dispatch makes the worktree first — through `tugarc_core::ops::create_in`, idempotent on a present branch and worktree — and composes the line from what that call returned, never from a path it only computed. A creation that fails stops the arc as `seat unavailable`, with `create_in`'s own sentence as the note — and so does a creation that would *succeed destructively*: `create_in`'s repair for a branch whose worktree has gone is to delete the branch and cut a fresh one from the base, so a branch carrying rounds with no worktree is refused before the call and the note says how to re-attach the tree by hand. The doctor reads the seat as a record: `arc doctor` raises `seat-missing` when an arc past devise has no branch or worktree, or a worktree on the wrong branch, and `--repair` makes the seat where doing so cannot lose a round. A stage repairs it only as a fallback it says out loud — the idempotent `tugtool arc create <name> --json`, run once when the path on the line is not a directory, and named in the transcript when it was. Devise and review make nothing: they write documents at `.tug/arcs/<name>/`, which is not in the worktree.

**The words, once**, and [work-grammar.md](work-grammar.md) is their authority. An **arc** is work that leaves the base on a worktree and comes back through a **join**. It comes in two **kinds**, which differ only in settling time: a **plain** arc runs implement → audit, a **planned** one devise → review → implement → audit. The **wheel** drives every arc through its stages; `tugtool arc run` opens or resumes it, `arc stop` stops it, `arc record` reads its record. "Arc" never names the join: the join has its own word, and it arms, offers, and lands under it.

## Interruptions

**Every interruption to a running arc leaves the arc in a state that is both sayable and resumable, and the user is told which one.** Sayable means the record says what happened in a word the receipt can explain; resumable means there is a gesture that picks the work back up. An arc that quietly stopped advancing is the silent early return [L31] exists to forbid.

Two things hold across every row, so they are said once rather than per row. **The user's resume is the Resume button on the stop's own receipt**, and `tugtool arc run <name>` — the verb the fourth column names, because it is the verb each row's test drives — is the same act for the machine: the record is read, the stop is cleared by naming the stage to pick up in, and the calling card is bound. Either way it lands at the end of the turn that asks for it, because the resume runs from inside the asking session's own turn and rotating on receipt would kill the claude that asked. And **a stop hands the card back on the deck's own model** — the last selector the user picked, never the one the last stage ran on — through the one path every stopper shares.

**And the wheel judges a stage only at a *settled* idle edge.** Idleness is a claim about an instant, and every row below spends one on something irreversible — a rotation, a prompt, a stop. A turn ending and the wake that answers it are milliseconds apart and the session is genuinely idle in between, so an idle reading is worth nothing until it is *still* idle `[tugtool.arc].idle_settle_secs` later, with no turn, no wake, and no job opening in the window. **And a turn the harness opened is never a turn the stage was asked**: a backgrounded command completing re-invokes the model in a wake turn, and a wake is not an answer. An arc was stopped as `implement idle` six wakes into work that was going fine, because one count served both questions and one idle instant was spent as though it were a state.

| Interruption | What the arc does | What the user sees | How the work resumes |
|---|---|---|---|
| Cancel during **devise** | stops as `card taken`; the half-written plan is never judged on `lint` | `arc stopped · <arc> · in devise — you took the card back` | `tugtool arc run <name>` re-rotates devise — `a_cancelled_devise_or_review_turn_stops_the_arc_as_card_taken` |
| Cancel during **review** | stops as `card taken`; the cancelled round does not burn against the review cap | `arc stopped · <arc> · in review — you took the card back` | `tugtool arc run <name>` re-rotates review — `a_cancelled_devise_or_review_turn_stops_the_arc_as_card_taken` |
| Cancel during **audit** | stops as `card taken`; the mark is the stage's product and a cancelled turn leaves none | `arc stopped · <arc> · in audit — you took the card back` | `tugtool arc run <name>` re-rotates audit |
| Cancel during **implement** | nothing — the stage sits and the next turn decides | nothing; the card is yours to redirect and the stage is still on it | type the redirect into the same stage — `a_cancelled_implement_turn_sits` |
| A machine **wedge recovery** mid-stage | nothing — tugcode marks its own cancel `is_recovery`, and the stage it recovered is alive and working | nothing | the stage carries on — `only_an_unmarked_cancel_reads_as_the_user_taking_the_card_back` |
| A **fresh session** on the card (`/new`, a reset, a rewind fork) | stops as `card taken` **at the card's next spawn**, not at the gesture: a reset parks the entry `Idle`, and a card parked `Idle` is indistinguishable from one whose tugcast just restarted | `arc stopped · <arc> · in <stage> — you took the card back`, at the next prompt | `tugtool arc run <name>` — `a_session_no_rotation_seated_is_a_card_taken_back` |
| A **model switch** mid-stage | records `model → <selector> in <stage>` and carries on; the transcript's stage divider is not rewritten | the note in `tugtool arc record` and on the Arcs card row | nothing to resume — `a_model_switch_on_an_on_arc_card_lands_in_the_arc_log` |
| A second **`/arc`** naming another arc | nothing — the bind is refused, and the running arc is untouched | `card runs <arc> — stop it before binding <other>` | stop the first arc, then bind — `a_card_running_a_score_refuses_a_bind_to_another_arc` |
| **`arc discard`** | the seated stage is retired at its turn's end; **no arc-log line is written**, because the discard's own terminal line already closed the arc's generation | `arc discarded · <arc> · the stage's turn will end and the card returns to <model>` | nothing to resume: the arc is gone — `an_ending_writes_no_arc_line_after_the_terminal_one` |
| **`arc join`** | the same retirement, worded as the join it was | `arc joined · <arc> · the stage's turn will end and the card returns to <model>` | nothing to resume: the work landed — `a_joined_arc_says_joined_and_a_discarded_one_says_discarded` |
| **`tugtool arc stop <name>`** | stops as `stopped by user` and hands the card back | `arc stopped · <arc> · in <stage> — you stopped it` | `tugtool arc run <name>` — `a_user_stop_writes_the_record_the_receipt_and_the_hand_back` |
| **Closing the card** | records `card closed` before the row goes closed, while the binding still names the arc | nothing on the card, because there is no card; the record, `tugtool arc record`, and the Arcs card all say it | `tugtool arc run <name>` from any card — `closing_a_card_seated_by_a_stage_stops_its_arc` |
| **`arc unbind`** on a card on an arc | the same act with the same reason: `card closed` | as above | `tugtool arc run <name>` — `unbinding_an_on_arc_card_stops_the_arc_as_card_closed` |
| A **tugcast relaunch** mid-stage | waits; the startup rebind seeds the recorded claude id, so the stage reads as current and nothing stops | nothing | the arc picks up on the card's first idle after it spawns — `a_card_that_has_not_spawned_since_startup_is_a_wait_not_a_stop` |
| A **pending rotation** lost to a relaunch | the promise is dropped on purpose; a restart ended the turn it was a promise about | nothing | the next tick decides afresh; the rule is in [wheel.md](wheel.md) — `a_card_that_has_not_spawned_since_startup_is_a_wait_not_a_stop` |
| A **side question** inside a stage (a `/btw`) | nothing at all: the documents are untouched, so the predicate sees no edge | nothing beyond the question itself | the stage carries on — no test of its own; every "no document changed" predicate test asserts it |
| A stage meeting a **decision that is the user's** | stops as `needs a decision`, and the question it stopped over is written as the arc's last `arc-note` | `arc stopped · <arc> · in <stage> — it met a decision that is yours to make, so it stopped rather than asking`, with the question on the line beneath | answer it, then `tugtool arc run <name>` — the stage rotates again knowing what you said |
| A **seat that cannot be made** — `create_in` fails at an implement or audit dispatch, or the seat could only be made by rebuilding a branch that carries rounds | stops as `seat unavailable`, with the sentence written as the arc's last `arc-note`; no stage is seated and no `where` line is composed | `arc stopped · <arc> · in <stage> — its worktree could not be made`, with the sentence on the line beneath | fix what the note names, then `tugtool arc run <name>` — `a_seat_that_cannot_be_made_stops_the_arc_as_seat_unavailable`, `a_branch_carrying_rounds_with_no_worktree_stops_instead_of_being_rebuilt`, `the_implement_dispatch_makes_the_seat_and_the_where_line_names_it` |
| A **`/compact` the arc sent** ending in an API error | stops as `compact failed`; the arc never walks on with a context the compaction did not reduce | `arc stopped · <arc> · in implement — its /compact turn ended in an API error, so the context was never reduced` | `tugtool arc run <name>` — `a_compact_turn_that_ended_in_an_api_error_stops_as_compact_failed` |
| An **implement stage ending an asked turn closing no step** | is re-asked once, naming the open step; the second asked turn ending with no close stops as `implement idle`. The horizon counts *asks*, and before the re-ask nothing prompted the stage after its first quiet turn, so the second count had no legitimate path to it at all | `arc stopped · <arc> · in implement — the implement stage was asked twice and closed no step` | `tugtool arc run <name>` — `an_asked_turn_that_closes_nothing_is_re_asked_once_and_then_stopped` |
| A **turn that never ends**, and an arc whose seat hands back no snapshot at all | stops as `stalled` once the arc's idle deadline (`[tugtool.arc].arc_stall_secs`, half an hour by default) runs out. The only stop measured against a wall clock, and its one job: a hung turn never goes idle, so no edge below the clock is reachable for it. An *idle* session is never the clock's — it has an edge, and the horizon answers it in one turn rather than in half an hour. **The clock runs only for the instance that owns the seat** — see [Ownership](#ownership--whose-arc-is-this-to-judge) | `arc stopped · <arc> · in <stage> — it went silent — no turn ended and no step closed before the arc's clock ran out` | `tugtool arc run <name>` — `a_hung_turn_stops_when_the_clock_runs_out`, `an_arc_with_no_snapshot_is_clocked_and_eventually_stops_as_stalled`, `a_foreign_live_owner_is_never_clocked` |
| A **stopped stage that wakes** — a wake, a prompt-less turn, or a step closing on the stopped stage's own session after a silence-judged stop | reverses the stop: `arc-resume`, `arc-continue`, and the stage's model back on the card. A stop for silence is a claim, and the session it was made about is the one thing entitled to contradict it; a stop recording a *person's* act is never reversed | `arc picked back up · <arc> · in <stage> · <what moved>` | nothing to resume — it already did — `a_step_closing_on_a_stopped_arc_picks_it_back_up` |

The side-question row is the **only** one whose middle cell is not a receipt, and that is what the row is for: nothing happens, and the table says so rather than leaving a reader to wonder whether it was forgotten. It used to name an `AskUserQuestion` beside the `/btw`, and that was the row hiding the defect: a dialog inside a stage is not "nothing happens", it is an arc paused where no record can see it. The row after it is where that case went.

### What a stop can say

The vocabulary is closed, and the compiler enforces it: `ArcStopReason` in `tugarc-core/src/arc.rs` carries every reason an arc can stop for, `append_arc_stop` takes it, and the receipt formatter matches it exhaustively with no fallback arm. A reason the receipt cannot explain is a reason the arc must not write.

`lint` · `api error` · `compact failed` · `implement idle` · `stalled` · `needs a decision` · `records disagree` · `seat unavailable` · `review did not stamp` · `audit did not mark` · `document missing` · `plan missing` · `session gone` · `card taken` · `card closed` · `stopped by user` · `discarded` · `joined` · `prompt unavailable` · `session idle` · `session errored` · `session closed` · `spawn queue full` · `no stdin` · `stdin closed` · `arc running`

The last seven are the wheel's own refusals, mapped through `Refusal::stop_reason`. `discarded` and `joined` exist for their sentence alone — nothing writes them to the arc log, because the ending's own terminal line has already closed the arc's generation.

Five are **judged silence** — `implement idle`, `stalled`, `lint`, `review did not stamp`, `audit did not mark` — and only those five reverse when the stopped stage turns out to be working. `implement idle` in particular means exactly what its sentence says: the stage was **asked twice** and closed no step either time, the first ask being the wheel's own and the second the re-ask that answers a quiet turn. Every other reason records a person's act or a refusal to guess, and reversing one would be guessing.

## Binding

A **bind** mates a live session to an arc. It is a UI concept: git has no idea it happened.

- It lives in the per-instance `sessions.db` and is read back **live-sessions-only** (`bound_session_for`). That is exactly why an arc whose card has closed reads as *unbound* — unbound is not a stage, it is the absence of a worker.
- It is **per-card**. A session has at most one arc, which is why `unbind_arc`'s whole payload is the session id.
- It **follows the seat**. The binding is written against the tug session id — the segment a card is seated on — and a rotation never moves that id while the process lives, so the stage segments a rotation mints carry no binding of their own. A relaunch seats the card on its line's tip ([P06]), so tugcast moves each seated line's binding onto the resumed segment at startup, right after the demote and before any client asks (`seat_line_bindings`): moved, never copied, so exactly one row reports bound — `at0485-arc-binding-relaunch`.
- It **mints**: `bind_arc` naming an arc that does not exist succeeds anyway. Every sender therefore builds its frame from a snapshot row rather than from user text; the one place that accepts a typed name (`/arc-bind <name>`) matches the snapshot first and routes an unknown name to `arc create` through the shell, where the receipt says what was made.
- **An arc is bound to at most one live card**, and the server refuses a second: a bind naming an arc another live session holds is refused by name — `<holder> is running <arc>` — before anything is written, on the bind and on the resume alike. `bound_session` is a scalar because the machine drives one card: the wheel rotates one, the stop hands back one, the receipt lands on one. A bind displaces only *this* card's previous binding — unless that binding is a live arc, in which case it is refused by name. See [Interruptions](#interruptions).
- A bind is **never a join authority**. It says who is working; it does not say who may join.
- The store moves on the **broadcast**, never on the gesture: `bind_arc_ok` / `unbind_arc_ok` are the only movers of `cardSessionBindingStore`, which is what leaves a card correctly bound to what it was when a bind is refused.

## The arc's documents

An arc's brief and its plan live at `<main-repo>/.tug/arcs/<name>/` — `brief.md` and `plan.md` — and the **name** is their address on every verb ([D139]). `.tug/` is gitignored, so the documents are never tracked, never on a diff, and never in a worktree.

- **One copy because one home.** There is no residence to choose and therefore nothing to record: "this arc has a plan" is `plan.md` existing, read fresh on every composition ([D138]). Nothing transplants a document, restores one, archives one, or detects divergence between copies, because there is only ever one.
- **The name is the address.** `tugtool arc run|step|documents <name>` take names only; `tugtool plan lint|status|stamp` take a name *or* a path, and the argument's shape decides — a separator, a leading `.`, or a trailing `.md` is a path, anything else is an arc. `tugtool arc documents <name>` reports the directory and both files, and `--ensure` creates the directory so a skill can write into it after one call.
- **The main root, from any checkout.** Every document path normalizes through the main repository root, so a verb run from inside an arc worktree resolves the same file the base checkout would. Without that a run would write a second ledger nothing reads.
- **The ledger is written in place.** `arc step start|done|withdraw` and the replay's reconciliation rewrite `plan.md` where it lies; none of it is a commit, so a run's whole walk leaves the arc worktree byte-for-byte clean. A replay's undo and redo move the ledger's commit cells along the recorded mapping, because moving the branch no longer moves them.
- **The join removes them; the discard keeps them.** A joined arc's record is its squash commit, and the documents have nothing to add to it, so `finish_join_teardown` removes the directory and names the removal in the receipt. A discarded arc's documents are the only trace of decisions the user may return to, so discard leaves them and says where — `tugtool arc run <name>` reopens on them, and a later `arc create` of the same name starts from what it finds ([L23]).
- **`.tug/` stays out of git without anyone declaring it.** `ensure_tug_excluded` writes an anchored `/.tug/` into the repository's shared `info/exclude`, inside its own marked block, the first time a verb needs it — so a project with no `.gitignore` at all still has a clean `git status` after an arc writes a document.

## The operation log, and undoing

An arc verb that lands, moves, or deletes a branch used to be a one-way door. `tugtool arc undo` is the way back, and it rests on a log every mutating verb writes **before** it acts.

An operation has two halves, which store different facts and never the same one:

- **A keepalive ref**, `refs/tug/oplog/<seq>`, on a synthetic commit whose parents are every tip the verb is about to move or delete — the arc head, the base tip, a standing candidate, and the conflict chain. This is what makes recovery possible at all: once it exists, `branch -D` and `reset` cannot strand the arc's rounds, so they are reachable from a ref rather than from a reflog on a clock. The conflict chain is in that list because a teardown deletes its ref along with the candidate's, and the chain holds the resolver's checkpoints — the most expensive commits in the system, and the ones nothing else would keep. It is read **without** the validity gate: validity answers *may this chain be opened*, the keepalive answers *may this work be collected*, and the second question has the broader yes.
- **A payload**, `oplog-<seq>.json` in the project state dir, holding the verb, the arc, and the before/after values. It is a file rather than the keepalive's commit message because it is written twice — once before the verb acts and once when it completes — and a commit message is immutable.

Three verbs record: `join`, `replay`, and `discard`. `create` does not, because a half-made create already rolls itself back. Retention is 50 operations per repository, pruned oldest-first by the writer — no daemon and no lock file. Pruning drops both halves, and dropping the keepalive is what finally lets `git gc` collect the commits, which is the honest meaning of *no longer undoable*.

**A join's forward state lives on the same record as its reverse state.** The payload carries the teardown's phase from the moment the integrate lands, which is what `join --continue` resumes from and what every reader consults to answer *is a join in flight*; the operation it hangs on is the one an undo would reverse. There is no second file for the two to disagree about, and no second retention regime that could drop one and keep the other. The rule that keeps the meaning honest is that **a join which lands nothing records nothing**: a conflict, a stale candidate, or a failed integrate leaves the base as it found it, so the record opened for it is dropped — jj's rule that a transaction which is not committed writes no operation, which undo and replay already kept and the join now does too. An operation left incomplete therefore *means* a teardown to resume, and `undo` refuses it by name until `--continue` finishes it.

Three rules govern the undo itself:

- **It is a compare-and-swap, never a force.** It verifies the world still matches what the operation left — the base tip unmoved, the branch not since rebuilt, the worktree clean where it must be — and refuses by name otherwise: `tip-moved`, `base-dirty`, `branch-exists`, `already-undone`, `incomplete-op`, `nothing-to-undo`. `reset --keep` rather than `--hard` is the mover, so git itself refuses over changes that would be lost. An operation that later work has made un-undoable stays that way, and the refusal names the newer tip so a person can decide by hand.
- **It restores git state only.** Bindings live in a per-instance ledger and are live-sessions-only by design, so a restored arc reads as **unbound** and rebinding is the user's gesture. The report says so rather than letting it be discovered.
- **An undo is recorded but never undoable.** It belongs in the log — it moved refs — but offering to reverse it would make the verb a redo on alternate presses. So undo records are skipped when selecting what to reverse, which is what makes a second press report `already-undone` about the real operation rather than complaining about the undo.

A discard's handed-back files are the one half no undo reverses: they were *copied* into the base checkout, and pulling files back out of a user's checkout is what this engine never does. The undo names them and leaves them. When the teardown also cleared a conflict chain, `undo` puts that ref back — unless a ref already stands there, in which case it says so and leaves it: restoring older work over newer is the one thing worse than not restoring at all, and the recorded chain stays reachable through the keepalive regardless.

`tugtool arc redo` is undo's partner and reverses an undo, under the same compare-and-swap discipline and with its own refusals: `nothing-to-redo`, `already-redone`, `superseded`, plus the shared `tip-moved` and `worktree-dirty`. Two things about it are load-bearing.

**Redoing an undo — never undoing one — is what keeps the stack flat.** A redo re-applies the original operation and *clears the original's `undone_by`*, making it undoable again, so `undo, redo, undo` toggles one operation and repeated `undo` walks progressively deeper. No linked list of undo-of-undo ever forms, because the original's candidacy flag is the single source of truth for what the next press means.

**A redo is always materially possible while the undo's record stands.** An undo records itself before it acts, so its own keepalive parents the operation's *after*-tips: the landed join commit survives its own undo because the undo recorded it. Every refusal is therefore about consent rather than capability. That is why `worktree-dirty` refuses rather than sweeping: a redo of a join or discard deletes the worktree the undo gave back, and work started there in the meantime is the user's. `discard` hands such work to the base instead of refusing, but that is a teardown the user asked for while looking at it; a redo is bookkeeping, and moving somebody's files as its side effect is what this engine does not do.

Undo and redo of a replay are each a compare-and-swap on the branch **plus** a walk of the plan ledger's commit cells along the replay's own recorded mapping — reversed for the undo, forward for the redo. The mapping is exact, so neither falls back on subject matching. The ledger needs the second half because it lives outside every tree git watches: moving the branch does not move its cells with it, and a cell naming a commit the undo just made unreachable would be a wrong sha in the record rather than a stale one.

## Occupancy — the lease

A workshop has one worker. Inside tugcast that is exact: a process-global registry takes the arc before any run touches it, and a second one is refused by name — "a resolve is already running for this arc". The registry is in memory on purpose, because a tugcast restart is both the only event that orphans a run and the event that releases every hold.

What it cannot see is a **second process**. `tugtool arc join`, `tugtool arc discard`, and `tugtool arc join --resolve` run the same core from a CLI, and each of them tears a workshop down. A resolver mid-turn in that workshop loses its checkout.

So liveness is derived from git, where both processes can read it, and the thing it is derived from is the conflict chain the resolve already writes. The chain becomes the resolve's own operation log:

```
tugresolve(<arc>): end          ← the resolve exited; the lease is released
tugresolve(<arc>): checkpoint   ← one per turn that changed the tree
tugresolve(<arc>): begin        ← the resolver opened the workshop
tugconflict(<arc>): …           ← the root the ladder parked, record in its body
```

The markers are empty-delta commits carrying the tip's own tree and the tip as their only parent, so every existing reader — `read_conflict`'s first-parent walk, `open_conflict`'s reset, the salvage rung's blob reads — sees exactly what it saw before. What changes is the subject, which is the whole point.

`resolve_lease` is then a pure function of the tip, and it holds only when all four are true: a chain stands, its tip is a `tugresolve(` commit that is not the end marker, no candidate is anchored, and the tip is younger than `RESOLVE_LEASE`. Each of the four answers a case the others cannot. A bare `tugconflict(` root is a conflict the ladder parked with nobody on it — the join pilot does that unattended — so the root's age is never a lease. A standing candidate is the resolver's own receipt of completion, because anchoring one is its last act and the ladder clears any candidate before parking a new root; without it, a resolve that missed its end marker would refuse for the whole window. And the chain is read **without** the validity gate, for the same reason the keepalive is: a round landing on the arc mid-resolve invalidates the chain without stopping the resolver.

**The window is not a new number.** `RESOLVE_LEASE` is tugcast's `RESOLVE_DEADLINE` — the ceiling the resolver already enforces on itself — and the two are one constant by definition. A resolve that has not advanced its chain in that long has either died at its own deadline or lost the process running it. Nothing writes on a timer, and nothing needs to: checkpoints are per turn, and the begin marker is what carries a resolve through a slow one or a resume onto a tip that is days old.

The refusal is an ordinary named blocker, `live-resolve`, in the same vocabulary as `stale-journal`, `off-base`, `base-dirt`, and `empty` — so it reaches the card with no client change, and the preview lists it where the execute path returns it as its `Err`. Its sentence states the tip's age, the window, and **both** ways out: `--break-lease` for the CLI, and resolving again for the card, whose Resolve arm runs the ladder and starts a fresh chain. Naming only the flag would be a control that does nothing for half the people who read it.

`--break-lease` is consent, not capability. The teardown it permits is the one the verb always performed; the op log's keepalive already parents the chain tip, so `tugtool arc undo` puts the resolver's checkpoints back either way. What the flag adds is a recorded decision — `broke_lease` in the operation's `before`, printed in `arc undo --list` — and a warning naming the op number that restores what was torn down. Never a silent destruction.

The in-process registry stays as the fast path and is not weakened: every tugcast path takes it first, and a run it holds suppresses the lease blocker, because the exact answer beats the derived one wherever it exists. The lease is the backstop for the process that has no registry to ask. The model is jj's op-heads lock, which exists only to avoid duplicated work and never carries correctness — here too, a lease that is wrong costs one turn, and the op log is what makes that turn recoverable.

The CLI's `join --resolve` is guarded at the CLI rather than inside the ladder. The ladder clears the chain on both its arms, so a check in `join` would fire long after the checkpoints were gone; and a check in the ladder's core would also refuse the join pilot for the whole window after any resolver crash, wedging the one actor whose job is to clear the wreckage.

## Ownership — whose arc is this to judge?

The lease above is about one actor at a time inside a workshop. This is the same shape one level up: **an arc's clock belongs to the instance that seated the stage, and to nobody else.**

The arc log is a per-project file that every instance over one checkout reads. A second `Tug.app` therefore sees a first one's arcs — but it cannot get a session snapshot for a seat that lives in the other tugcast's process, and before ownership existed that blindness had exactly one reading: *the stage went silent*. On 2026-09-02 a debug instance launched by an unrelated acceptance test spent thirty minutes on that reading and then wrote a healthy arc a durable `Stalled` stop receipt, twenty-seven minutes into an audit that was working.

So the seat is named. `arc-owner <instance-id>` goes into the arc log immediately before each act it describes — before the dispatch, and before the `arc-stage` line the bridge writes — and `ArcRecord::owner` reads it back, last one winning within the generation. The identity is the raw `TUG_INSTANCE_ID`, opaque to every reader; a launch with no instance id writes no line at all rather than a placeholder.

**Liveness is probed, not leased.** `instance_tmux_live` asks the owner's own `tug-<token>` tmux server whether its session exists — the same question already trusted to decide whether it is safe to touch a worktree an instance's app might hold. A lease here would need a heartbeat, because an arc mid-stage legitimately writes nothing for minutes, and a heartbeat in an append-only per-project file grows that file forever. That is precisely the cost `resolve_lease` avoids by riding checkpoints the resolve already writes; there is no equivalent write to ride here, so the question is asked of the process instead of inferred from the file.

The verdict has four values and only one of them gates:

| verdict | what the runner does |
|---|---|
| `mine` | proceeds — it is this runner's work |
| `unowned` | proceeds — no owner line in this generation |
| `foreign-live` | **stands down**: no clock, no stop, no receipt |
| `foreign-dead` | proceeds — the owner is gone, and somebody must be able to clock it |

`unowned` meaning *proceed* is load-bearing. Every arc opened by a build predating the marker, every standalone launch, and every `cargo`-driven test reads as unowned, and turning those into un-judgeable arcs would be a far worse regression than the false stop this closes. `foreign-dead` proceeding is the other half: a crashed tugcast must not orphan an arc forever, and the only instance that could clock it is the one that died.

The stand-down happens **before** the state map is touched. Seeding a motion stamp and then returning would start a clock this runner must never read, and would backdate the deadline if the arc later became its own — so the first tick after an ownership change could stop it outright. Leaving the stamp unset is what makes the stand-down total rather than merely quiet.

**Display is untouched: a foreign arc is visible, never judged.** `DashArcState` is composed from `read_arc` alone — stage, stopped, stopped stage, done, and the last note all come off the record, and no session snapshot is consulted — so a foreign-owned arc keeps its stage in the Changes shade and on the Arcs card. Hiding it would make a shared checkout look like it has fewer arcs than it does, which is a worse lie than showing one nobody local is driving.

The gate sits in the runner's own two clock paths and **not** inside `stop_arc_for_session`. That function is shared with the explicit gestures — `tugtool arc stop`, a closing card, an unbind, a user taking the card — and a user pressing Stop on a card bound to a foreign-owned arc is making a decision, not a judgment. Gating it would refuse the one actor whose authority is not in question.

## Joining — by reference

An arc joins by `/arc-join <name>` into its base: a preview runs on entry, the squash message is edited in the composer, and the join is the human’s act. Skills draft; humans join.

**A stopped audit never arms the join.** The stop means the audit did not mark, whoever stopped it and for whatever reason, so `join_ready` stays shut over it on the server and the shade reads `unaudited` rather than ready; what the shade offers is to resume the audit or to land it unaudited, and the join stays the user's to take either way. A stop in any earlier stage releases the offer as it always did, because the join never needed a wheel.

**The audit is the author of record for the join message.** The implement stage writes a provisional draft before its final step closes — the message an arc carries if it stops short of its audit — and the audit rewrites it unconditionally after reading the whole diff cold, whether or not it changed a byte, because it is the last stage to touch the tree. The join lands whatever draft stands when the user presses; the audit's is the one that describes what lands.

The doctrine — the two beats, the one-slot `LandingMode`, and the five outcomes a join can reach — is held in [tracking-changes.md](tracking-changes.md#the-landing-workflow), where the capture and commit layer beneath it already lives. It is law where it stands and is deliberately not restated here.

## Naming

An operation is spelled the same everywhere, and that spelling is its `tugtool` verb path, hyphenated: the card verbs are **`/arc-bind`** and **`/arc-join`**.

There are no alias spellings. `join` is not registered at all: the registry carries the names an operation has, and only those. A typed `/join` is submitted to Claude as a prompt, which spends a turn — the one-time cost of the rename, paid by whoever's fingers remember.

## The faces

An arc wears one grammar in two registers. Where the arc is the **subject** — the Arcs card, the Changes shade's arc lane, the ARC placard — it draws as the constant-width lifecycle track inside `ArcLifecycleLine` / `ArcLifecycleBlock`; where it is one **fact about a session** — the card's masthead title run and the Cards card's session rows, both `SessionIdentityRow` — it draws as `ArcLifecycleMark`: one pill, the phase glyph, and the count of the declared run. The Z2 ARC cell is neither: it is an instrument wearing STATE's construction, two dots around a reading that gives numbers whenever there are numbers and the lifecycle phase in a word otherwise, and it takes STATE's width while JOBS gives exactly that back, so the row never moves.

**The block's eyebrow says WHO, its line says WHAT.** Line one is the arc atom, the hairline, and the workers — identities, nothing else, no verbs and no state. Line two carries the whole reading, in one order: `[track] [glyph] <Doing> [i/N] · <what is in the way>`. The step's **title** is not a run anywhere: it rode the note during implement, where it was a sentence in a slot sized for a word, and it is the fraction's hover sentence now — the placard's step list is where a reader reads titles. The phase every face keys on is the **lifecycle** phase, never the git stage above — an arc has no stage until `arc create`, which is most of the life this document describes, and the same rule now governs the Z2 dots: an arc under way pulses whether or not a branch has been cut. [D168] holds the rules.

**The line is a sentence, and one derivation writes it.** `arcReading(model)` in `tug-arc-track.tsx` returns the word and the fraction, and every face reads it rather than spelling its own — the mark, the Z2 cell and the strip cannot disagree about an arc because there is nothing left for them to disagree with. The word is a **verb in the reader's tense**: what is happening, or what is being waited for. The fraction follows the verb, where it reads as the verb's object, and only while a step is actually in hand — so a walked ledger under audit reads `Auditing`, never `Auditing 6/6`.

| Phase | While somebody is working it | At rest |
|---|---|---|
| `brief` | Briefed | Briefed |
| `devise` | Devising | Devising |
| `review` | Reviewing | Awaiting review |
| `implement` | Implementing | Implementing |
| `audit` | Auditing | Awaiting audit |
| `join` | Finished | Finished |

The two phases that read differently at rest are the two done *to* an arc rather than *by* it: a plan nobody is reading is awaiting a review, not being reviewed. What tells the columns apart is one bit — `live`, true when a stage is in flight or a holder is mid-turn — and it is derived once, beside the phase, from facts the feed already carries.

**A stop outranks every phase word.** The line reads `Stopped · <reason>`, where the reason is the log's own word from the closed vocabulary above, left exactly as written. Its **sentence** rides the wire beside it as `stopped_why`, composed server-side from `ArcStopReason::sentence`, so no face keeps a second table of a vocabulary the compiler already owns — the hovers say the sentence, the line says the word.

**One clause of trouble, never a run of them.** The divergence facts are ranked and only the loudest is painted; every applicable sentence stacks into that clause's hover. Four survive — conflicts with the base, files also edited on the base, a stale fit, a current one — and a face that showed all of them showed a reader four things to rank for themselves.

**The cells hover in three forms**, so a reader learns the pattern once and reads every cell with it: `Not yet <past participle>` · `<present participle>` · `<past participle>`.

| Cell | Reading |
|---|---|
| pending | `Not yet implemented` |
| active | `Implementing · 3 of 6 steps closed` |
| done | `Implemented · 6 steps` |
| stopped | `Reviewing — stopped: the plan does not lint` |

**The other registers say the same words in the room they have.** The compact mark's one tooltip reads `<arc> · Implementing step 3 of 6`, and a stop there names the phase the glyph gave up when it became the stop's octagon: `<arc> · Stopped in review · needs a decision`. The Z2 cell has 18ch and no room for a clause, so it says the word alone — `Awaiting review`, `Briefed`, `Stopped`, or `Cut` for an arc with a branch and no ledger — and leaves the reason to the placard one press away. The arc receipt's row is the one face with an override, because a receipt is a frozen record with no live model to ask: `Finished · 3 stages`, `Picked back up`, `Stopped · <why>`.

## See also

- [wheel.md](wheel.md) — what a rotation is, when it may happen, and the other meaning of *stage*. The [Interruptions](#interruptions) table above is what happens when something gets in one's way.
- [arc-work-doctrine.md](arc-work-doctrine.md) — how an agent behaves on an arc worktree.
- [tracking-changes.md](tracking-changes.md) — the capture and commit layer beneath an arc, and the landing doctrine.
- [D112] (scope axiom), [D113], [D116] (the landing workflow), [D138] (derive vs declare), [D139] (one plan home), [D168] (one grammar, two registers).

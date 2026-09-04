# The arc reads as one thing from the first keystroke to the audit's mark

**Purpose:** An arc is a single thing the wheel drives from the door to the audit's mark, but the Z2 cell and the stage skills still describe it as a series of separate sessions, each of which has to find out what it belongs to. Five faces of that, seen on 2026-09-03, are traced and settled here.

---

## Purpose {#purpose}

The user's notes, watching arcs run:

- *As soon as* `/arc` or `/arc-plan` is kicked off, Z2 should switch to `ARC` with a pulsing progress indicator. It must not sit in the idle state. (Seen: `ARC` · `Brief` between two idle rings.)
- With the steps done and the audit underway, Z2 should say *Audit*, not keep showing the `N/M` step count. (Seen: `3/3` under the audit stage.)
- `0/4` should never be shown; there is a different state to display, and the question is what.
- The model's arc commentary shows there is insufficient guidance on how to run an arc: it re-discovers how the machinery works, narrates the discovery as a kind of self-encouragement, and at the end of the steps believes the Changes shade will show *before* the audit has run. The guidance must be better.
- The wheel's ask (`implement Step 4 and end your turn; Steps 4-8 remain on this run`) should not say *run*; the word is *arc*. And `end your turn` should be `end the turn`.

---

## Evidence {#evidence}

**[F01] Z2 reads `ARC` only once the session is in an arc's `bound_sessions`, and the door binds last.** `buildArcSessionIndex` in `tugdeck/src/lib/arc-session-index.ts` maps sessions to arcs from `bound_sessions` on the wire entry; `useArcForSession` feeds the cell's label in `session-card-telemetry-renderers.tsx` (`label={arcFact === null ? "TASKS" : "ARC"}`). The binding is written by `tugtool arc run` (`tugrust/crates/tugtool/src/arc.rs`, `run_arc_run` → `arc_run` op), which is phase 5 of `tugplug/skills/arc/SKILL.md`, the door's last command. Until then the cell reads `TASKS`. **(verified)**

**[F02] The Z2 dots demote to idle at every turn end under the wheel, which is exactly when the wheel acts.** `arcCellPose` in `tugdeck/src/lib/code-session-store/select-work.ts` ends `return isIdle ? "stopped" : "running"`, carried over from the TASKS pose on the reasoning that an arc does not advance between turns. `tuglaws/wheel.md` (the turn-end rule) says a rotation, a compaction, and every stage seat happen *at* the idle edge, never inside a turn. So the door's turn end, every step boundary, and every rotation gap paint the arc as stopped while the wheel is doing its work. **(verified)**

**[F03] The aggregate already lists an arc directory that holds no documents.** `tugarc_core::document_arcs` (`ops.rs` ~478) lists every directory under the arcs root, and `feeds/changeset.rs` emits it under `document_arcs` with the three documents `None`. `bind_arc` mints (`tuglaws/arc-lifecycle.md`, Binding). So a bind at the door's first act needs nothing new on the wire. **(verified)**

**[F04] Z2 prefers numerals whenever any pair exists, and two stages have a pair that says the wrong thing.** `arcReading` in `session-card-telemetry-renderers.tsx` takes `arcGlance ?? arcMarkFraction(model)` before the phase word. After the walk, `run_fraction` (`tugarc-core/src/log.rs`) pins a complete selection to `(length, length)`, so the audit stage reads `3/3`. Before the first `step start` there is no `run-through` line, `run_fraction` is `None`, and `arcMarkFraction`'s `current ?? done` is `0` — the `0/4`. The same `0/N` appears during review on a stamped plan. The track beneath the cell already disagrees: `arcPhase` in `tug-arc-track.tsx` maps the `audit` stage to the `check` cell. **(verified)**

**[F05] Every stage skill's §0 makes the model probe for facts the wheel held when it composed the ask.** `arc-implement`, `arc-review`, `arc-audit` (and `arc-devise` by the same shape) open with `printenv TUG_ARC`, `tugtool arc bind --dry-run`, `tugtool arc status --json`, a paragraph on rotated ids, and `tugtool arc doctor`; §1 then calls `tugtool arc create --json` to learn the worktree path. `wheel/prompt.rs` composes four clauses — ask, citations, what moved, resume — and none of them is the stage's own coordinates. The transcript shows the cost: *"I'll start by confirming the arc that runs me"*, *"Bound cleanly, no issues"*, *"The arc record exists and the doctor's only complaint is the missing plan"*, and one preflight compound that exited 1 and was scrolled past. **(verified from the skills and the screenshots)**

**[F06] `arc-implement` contradicts itself about the join inside forty lines.** §3 ends *"At most add 'the Changes shade will reveal itself momentarily.'"* and then *"Offer a build … Say the word and I'll run it"*; §4b says the audit is next and the shade comes after it; §5 describes the shade as the door. §3 predates the wheel. The model printed the permitted sentence (screenshot: *"The draft is written. The Changes shade will reveal itself momentarily."*) and asked the build question of an empty room. Both doors (`/arc` §6, `/arc-plan` §6) already say the shade reveals itself *when the audit marks the arc*. **(verified)**

**[F07] The ask's wording is composed in one function and pinned in two files.** `implement_ask` in `tugrust/crates/tugcast/src/wheel/prompt.rs` produces `… and end your turn; Steps N-M remain on this run` / `…; it is the run's last step`. `run` is the crate's name for the declared `--through` selection ([D148], `run_fraction`, `run_position`) and leaked into the one sentence the user reads at every seat. Pins: the `prompt.rs` test module and `arc_runner.rs` tests near lines 2019, 2192, 3610, 3643. The lexicon settled on 2026-09-02 makes arc the only user-facing term. `run` as a noun appears ~30 times in `tuglaws/arc-work-doctrine.md` and ~46 in `arc-implement/SKILL.md`. **(verified)**

**[F08] Z2 pins today cover only the mid-walk reading.** `at0473-arc-cockpit` asserts `ARC` with no plan and `1/3` mid-walk; nothing pins the label before the door's turn ends, the word before step 1, or the word during audit. **(verified)**

---

## Decisions {#decisions}

**[B01] An arc the wheel is driving is running from the door's first act until the audit's mark, whatever the seated session is doing.** `arcCellPose` returns `running` when the wheel record is live (`arcFact.arc` present, `done !== true`, `stopped === undefined`) regardless of `isIdle`. Three things and only three change the pulse: a recorded stop (`aborted`, danger), a settled stage (`ready`/`built`/`audited`/`draft-ready`, `completed`), and an arc with no wheel record, which keeps the session-idle demotion because nothing else is acting on it. The argument is [F02]: under the wheel the idle edge is the arc's busiest moment. Revisit only if the wheel ever stops acting at turn ends.

**[B02] Binding moves to the door's first act, and submit-time binding follows as a second step.** The door's opening command binds the session to the named arc right after `tugtool arc documents <name> --ensure` — a `--bind` flag on `--ensure`, or an immediate `tugtool arc bind <name>`; `bind_arc` mints and the aggregate already lists the empty directory ([F03]), so Z2 reads `ARC` · `Brief` with running dots from the door's first tool call. Then the supervisor's `user_message` intercept, which already reads every prompt to write `turn_active`, binds on a prompt whose first token is `/arc`, `/arc-plan`, `/tugplug:arc`, or `/tugplug:arc-plan` followed by a well-formed name, so the label flips with the keystroke. Door first because a hand-typed `/arc` in a bare tugcode session still needs the door-side bind. **(approved 2026-09-03)**

**[B03] Z2's numerals are the implement stage's reading and no other stage's.** The cell shows `i/N` only while the wheel's stage is `implement` and `current > 0`; every other moment says the seated stage's word — `Brief`, `Devise`, `Review`, `Implement`, `Audit` — and a stop says `Stopped`. The answer to `0/4` is **`Implement`** (or `Review`, wherever the arc actually is): before the first step opens the honest fact is which stage is seated, and a zero numerator counts work that has not started. The `4` is not lost; the placard's list and the track's ticks carry it. The accessible label follows the same gate (`arc foo, in audit`, not `step 3 of 3`). The masthead's `ArcLifecycleMark` keeps its fraction — [D148] gave a title mark the declared selection's `i/N`, and `3/3` on a title is right; this rule is the state cell's.

**[B04] `Audit` replaces `Check` on the track.** `ARC_PHASE_LABELS.check` becomes `Audit`; the `ArcPhase` union keeps the `check` key, because the label is the reading and the key is the code. The check cell was named when only a planned arc was audited and a plain one verified itself; every arc ends in an audit stage now (`arc-implement` §4b), and the `arcPhase` comment already calls the check cell the audit stage. One word on one stage, in Z2 and on the strip. **(approved 2026-09-03)**

**[B05] A stage is handed its coordinates and reads them; it never derives them.** `prompt::compose` gains a fifth clause, mechanical and one line — `where: worktree <abs path> · session <id> bound · stage implement · Step 4 in hand, through 8` — from records the runner already holds (the arc record, the seat it just made, `plan status`). Verifying the binding against the ledger moves from the stage's §0 into the runner's dispatch, where `arc doctor`'s four-record comparison runs once, by the process that owns the records, before a prompt is sent; a disagreement stops the arc with a named reason instead of seating a stage to find it. §0 of every stage skill shrinks to one paragraph: read the `where` line; absent, stop and name the doors. `bind --dry-run`, `status --json`, `doctor`, and §1's `arc create --json` leave the skills. The doctrine gains *What never gets said* beside *What never gets asked*: a stage does not report that it found its arc, worktree, binding, or ledger; the three sentences in [F05] are the banned shape, verbatim. A stage's first words are about the work.

**[B06] Only the audit speaks of the join, because only the audit's mark arms it.** `arc-implement` §3 is cut to the draft and the stop: the join draft is still written before the final step closes, the shade sentence and the build offer and `arc mark built` are deleted from this skill, `arc replay`/`verify` move to the audit (already there, and it is the stage reading the tree that lands), and §5 *Join* with its two escapes moves to `arc-audit`, the one place a chip is ever printed. The implement ending under the wheel is one sentence — *Step N closed: what it built* — stated as such. The doors' §6 already say it right and are untouched.

**[B07] The ask is user-facing prose and uses the user's words.** `implement_ask` produces `implement Step {n} and end the turn; Steps {span} remain on this arc` and `…; it is the arc's last step`. `run` survives only as an identifier in code and on the wire (`run_position`, `run_length`, `run-through`) and as the imperative verb `tugtool arc run`. The skills and `arc-work-doctrine.md` are swept: "the run" becomes "the arc" where it means the whole and "the selection" where it means the `--through` span; the heading *Step work runs to completion* is the verb and stays.

---

## Open Questions {#open-questions}

- **Whether `arc doctor`'s comparison is callable from the runner's dispatch without the CLI's session resolution in the way.** It reads four records the runner already has handles to, so it should be a library call in `tugarc-core`; the first step touching [B05] reads `tugtool`'s `doctor` and says which part is CLI plumbing.

---

## Non-goals {#non-goals}

- **Changing what the Arcs card or the Changes shade show.** [D141], [D143], [D153] stand; this work touches Z2, the track's one label, the wheel's prompt, and the skills.
- **A pending-rotation note on the card.** `wheel.md` already rejected it ("four surfaces to render a sentence whose subject arrives seconds later"); [B01]'s pulse is the whole of what the gap needs to say.
- **Keeping `Check` on the strip and saying `Audit` only in Z2.** Rejected: two words on one stage.
- **Submit-time binding alone.** Rejected: a hand-typed `/arc` in a bare tugcode session would read `TASKS` until the wheel ran.
- **Renaming the wire fields or the `run-through` log line.** The lexicon rules prose, not identifiers; a wire rename buys nothing a reader sees and costs every pin.
- **Linting the skills for the banned preflight.** Worth a `just tugplug-lint` rule once the shape has settled; not part of this arc.

---

## Exit {#exit}

A plain **`/arc`**, with its task list written from this brief. Every decision is made above and the parts order themselves: the pose rule and its table test ([B01]); the door-side bind, then the intercept ([B02]); the Z2 gate and the label rename with `at0473` gaining the three readings it lacks ([B03], [B04], [F08]); the ask's wording and its pins ([B07]); the `where` clause and the dispatch-time verification ([B05]); the skill and doctrine rewrite ([B05], [B06], [B07]). The one open question is answered by reading `doctor`, not by devising.

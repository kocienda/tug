# Arc crossing lab: torture-test the join and crossing code against the live app

**Purpose:** The crossing and join-resolution code that landed in `70554cc7a` has one deterministic bench and one hand-driven live run behind it. The live run found a real design gap and five smaller defects, but it was driven by hand: sessions created and arcs bound in the debug app, waits written as log greps, and no record left but the transcript. The user wants a tool that runs the live torture test against the `release-main` instance with no manual session creation or arc binding, so the code can be torture-tested repeatedly to find and fix bugs and deficiencies.

---

## Purpose {#purpose}

The user's words: "I want to do a better job at tool-ifying this arc testing and take another run up at it. We should also use *this app* (the release-main instance of Tug) for testing. I do not want to be compelled to do any session creation or arc binding manually. The overall goal is to *torture test* this arc-join-resolution code to find and fix bugs and deficiencies."

Two things are wanted. A driver that sets up a lab project, cuts arcs, seats sessions on them, drives rounds and base motion, and reads the outcome from structured records, all against the running release instance. And a list of scenarios to throw at the code with that driver, each paired with a fix when it falls.

---

## Evidence {#evidence}

**[F01] The deterministic bench exists and is green, uncommitted.** `tugrust/crates/tugarc-core/tests/torture/crossing.rs` holds a scenario grammar (`Bench`, `Edit`, `Scribe` stand-ins, `scenarios()`) with 29 scenarios; `tests/crossing_torture.rs` asserts each one under nextest and `examples/crossing_torture.rs` prints them as a table. It runs in seconds in a tempdir and never touches tugcast. **(verified)**

**[F02] Base-motion's replay does not consult rerere.** In the live run, after arc `ra` landed, base-motion replayed `rb` onto the moved base through `replay_onto`/`walk_rounds` (merge-tree), met the hunk the crossing settle had already taught to `rr-cache`, stood down, and injected a `[base-motion replay]` turn. With perms on auto the session's model ran `git rebase main`, and rerere auto-resolved the same hunk ("Git's recorded resolution already combined both sides"). The cache was right; only the engine skipped it. The whole injected turn was spent on a hunk the machine already knew. **(verified, live, 2026-10-28)**

**[F03] Five smaller defects observed in the same run.** (a) `ra` reconciled twice on one head pair. (b) A crossing settle runs with `recorder: None`, so a scribe decline leaves no record. (c) `PairCheckout::teach` returns `Ok` when rerere recorded nothing, as on a delete-versus-modify conflict. (d) Pair caches do not compose across three arcs. (e) While a conflict stands, the settle re-runs on every round and opens a scratch worktree each time. **(verified by reading the tugcast log and the code; none yet pinned by a test)**

**[F04] The probe was blind to renames; fixed, uncommitted.** `changed_since` now parses the `-z` door's records itself so `R` and `C` records add both paths, and `probe_pair` reports conflicts unfiltered, because a rename puts the conflict at the new name while the overlap holds the old one. Test `a_rename_crosses_an_edit_of_the_old_name` in `crossing.rs`. **(verified)**

**[F05] The Changes shade drew a withheld candidate as anchored; fixed, uncommitted.** `tugdeck/src/lib/resolve-ledger.ts` now marks a candidate draft withdrawn when a later `ended` event is `stuck` or `superseded`, and `ledgerBlocks` draws it in the error phase. Test in `resolve-ledger.test.ts`. **(verified)**

**[F06] The hand-driven procedure's own faults.** Sessions were created and arcs bound by hand in the debug app; one session went `failed` when the app stuck and had to be noticed and re-bound around. Waits were log greps keyed on guessed timestamp windows, and two timed out on the probe rather than the product. `tugtool arc status` run from the shell reports "unbound" for an arc the ledger shows bound. Nothing was recorded but the transcript. **(verified, from the run)**

**[F07] tugcast already has a headless session spawner, unshipped.** `AgentSupervisor::spawn_headless_session` (`feeds/agent_supervisor/mod.rs`) under [P11] spawns a session no card owns, with card id `background:<owner>`, a fresh line, a ledger row, the spawn budget, an eager subprocess, a permission mode and a tag. It is marked `allow(dead_code)` with "no background spawner ships yet". Downstream it is an ordinary session: it can be bound to an arc, notified by the pilot, and injected into by base-motion. **(verified, read from the code)**

**[F08] The external doors that exist.** `POST /api/session` (loopback only, `SessionApiRequest` with an `op`) handles `resolve` and rotation. `POST /api/arc` applies `ArcApiRequest` to the ledger. Session creation and user messages otherwise travel only as CONTROL frames (`spawn_session`, `user_message`) over the deck's WebSocket. `/api/eval` is gated on dev mode or the `diag/eval` opt-in, and `window.__tug` is installed only under the DEBUG harness user script, so the release deck cannot be driven that way. base-motion hands a session a turn through `insert_pending_turn` on the session ledger. **(verified, read from the code)**

**[F09] The model side of the loop works.** With perms on auto, the arc's session answered the `[base-motion replay]` turn by rebasing, continuing, running `tugtool arc replay` and `tugtool arc verify`, and reporting the planted red `docs` surface. The pilot then reconciled and the exam withheld the candidate as designed. The crossing notices, the one-per-path rule, the exam, and the join's teardown of its crossings all behaved. **(verified, live)**

---

## Decisions {#decisions}

**[B01] One scenario grammar, two executors.** The bench's grammar (arcs, rounds of edits, base motion, join, discard, an expectation) is the lab's grammar. The scenario types move out of `tests/torture/crossing.rs` into a `tugarc-core` module that both the bench and the lab import. The bench executes a scenario in a tempdir against `tugarc-core` alone; the lab executes the same scenario against the running `release-main` instance. A defect found live is then pinned as a bench row in the same vocabulary, and a bench row can be promoted to a live run.

**[B02] The lab is a dev crate, not a tugtool verb.** It lives at `tugrust/crates/tugarclab/` as a binary run by `just arc-lab <scenario>` (and `--list`), targeting `release-main` by default. It is not shipped and not a `tugtool` subcommand, so the standalone contract is untouched and nothing lab-shaped rides the bundle.

**[B03] Sessions are headless, spawned by the lab, and never created by hand.** The lab exposes `spawn_headless_session` through `POST /api/session` as a new `op`, with owner `arc-lab`, the permission mode `auto`, and a per-run tag. Each session is then bound to its arc through `tugtool arc bind --session`. The user accepted the cost: a lab session is not on a card until opened from the session chooser. Placing cards into the user's deck from a script was considered and set aside as a later door.

**[B04] The lab may hand a session a turn from outside.** A `say(arc, prompt)` act inserts a pending turn on the session through the same `insert_pending_turn` path base-motion uses, labelled as a lab turn, through the same loopback-only `/api/session` door. The user approved this door explicitly. It is what lets the real model make a round, react to a `[crossing]` or `[base-motion replay]` turn, and run the skills and the hook, which the bench cannot do.

**[B05] Two executors per act: scripted and modelled.** A scripted round is made by the lab itself in the arc's worktree and committed through `tugtool arc commit`; only the pilot's settle and the exam are real model work. A modelled round is a `say` and the arc's own session makes the change. A scenario names which acts are modelled, so most stay cheap and the expensive shape is chosen on purpose.

**[B06] Readings are named probes over structured records, never log greps by timestamp.** Each expectation reads one of: the `tugcrossing.<pair>.state` and `tugjoinbase` config keys, the arc log's marker lines, `rr-cache` entries, the session transcript through `tugtool session show --grep`, the pending-turn table, or the candidate ledger. The tugcast log is read only for events with no other record, and then keyed by the run's tag. Each probe waits with one `tugtool report wait` so the block shows what is waited on. A wait that times out names the probe.

**[B07] The output is a timeline and a verdict.** Per scenario: a table of time, actor, event, and a verdict per expectation, in the bench table's column shape, written under the run directory. A red scenario names its first failed probe. The lab exits non-zero on any red, the way the bench example does.

**[B08] Lab state is tagged, isolated per run, and trashed by default.** The lab project lives at `/tmp/arc-lab/<run-id>/`, one directory per run, never reused. Lab sessions are real rows in the user's `release-main` ledger; at the end of a run they are trashed through the existing `trash_session` path unless `--keep` is passed. The user accepted trash-by-default. Nothing deletes an instance data directory.

**[B09] The findings of the live run are the first scenarios, and each is fixed, not carried.** [F02] and [F03] each become a lab scenario and a bench row with a red expectation, then the fix lands beside them. For [F02]: land the first arc, replay the second, expect `Replayed` with no conflict turn, which means base-motion's replay runs the rerere rung on a conflicted round before standing down. A red the lab finds is fixed in the arc that finds it; "known failure" is not an ending.

**[B10] Scenario zero is last night's run.** The first scenario the lab must pass is the one driven by hand on 2026-10-28: two arcs on one base, a shared hunk, a settle, a join of the first, a replay of the second with the `docs` surface planted red. It reproduces [F02] as a red before the fix, which is how the lab proves it reads the product and not its own probes.

**[B11] The torture list beyond the findings.** A round that lands mid-settle, then two. A join started while a settle runs on the same pair. A notice arriving while the session is mid-turn. A base that moves twice before the arc replays. An arc discarded while its crossing stands, then a new arc of the same name cut. A file over the one-shot cap, which only the resolver can teach. A tugcast restart mid-settle, with the pair state and the candidate recovering or retracted cleanly. Then the modelled executor over the whole list, with perms on auto.

**[B12] The uncommitted work from the run lands with this arc.** The bench ([F01]), the rename fix ([F04]) and the ledger-face fix ([F05]) are verified and belong to the same subject. They are committed as the arc's first round rather than left in the tree.

---

## Open Questions {#open-questions}

- **Whether the lab can wait on the pilot and base-motion by record rather than by log.** [B06] names the records that exist. If a settle's start and end, or a replay's stand-down, have no record outside the tugcast log, the fix is to give them one that the lab reads, not to grep by tag forever. Which events lack a record is settled by reading `crossing_settle` and the base-motion engine when the probes are written.

---

## Non-goals {#non-goals}

- **Driving the user's deck.** No synthesized keys, no menu clicks, no `/api/eval` against the release deck, no script placing cards into the user's workspace. Headless sessions are the door; a card door is a later decision.
- **A tugtool verb.** The lab does not ship. It is a workspace dev crate and a `just` recipe.
- **Replacing the bench.** The bench stays the fast layer and the unit verdict. The lab is the slow layer, run once per scenario as a verdict, never as the loop to iterate in.
- **An app-test.** The app-test harness drives a `Tug-debug.app` subprocess behind the machine-wide gate; this work targets the user's release instance by design.
- **Narrowing the exam.** The exam runs the touched surfaces' declared checks. A faster exam table is separate work. *(Moot since [D224]: the join-time exam is removed, not narrowed — the join gate is reconcile-clean alone, and the lab's surfaces are there for `tugtool arc verify`.)*
- **Keeping sessions by default.** A run's sessions are trashed unless `--keep` is passed.

---

## Exit {#exit}

An arc. The order the pieces must land in:

1. The two tugcast doors: `spawn_headless_session` exposed as a `/api/session` op with owner, permission mode and tag, and a lab-labelled pending-turn insert on the same door, plus trash-by-tag. Nothing else runs without them.
2. The grammar moved into a `tugarc-core` module; the bench and its tests re-pointed at it and still green; the uncommitted bench, rename fix and ledger-face fix committed as the first round ([B12]).
3. The `tugarclab` crate: lab project builder with configurable surfaces, arc creation and binding, the scripted and modelled executors, the probes, the timeline, cleanup, and the `just arc-lab` recipe.
4. Scenario zero ([B10]), red on [F02], then the replay-consults-rerere fix with its bench row and lab row.
5. The [F03] scenarios and fixes, then the torture list ([B11]), fixing each red as it falls.

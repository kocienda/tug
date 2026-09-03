# Resolve at the join: one voice, a real answer, and a receipt

**Purpose:** The Changes shade's **Resolve** button — the act that clears base-side work refusing an arc's join — does its work on the server and then leaves the user looking at a spinner that never stops, two status lines that disagree, and a message in another session that reads as though the model said it. The user's words (2026-09-03): "The arc *Resolve* feature at join-time basically does not work … It never exited after many minutes. A horrible user experience." This brief charters the rework: Resolve says what it will do, does it, reports that it did, and tells the holder of the folded work in a voice that is Tug's own.

---

## Purpose {#purpose}

The join of `arc-resume` was refused because five files the arc changed were also dirty in the base checkout — held by a second live session. The shade showed the `Base work in the way` dialog with its Resolve button, exactly as designed. The press produced, in order:

- the register line **Reconciling with main · reconciling**, which is not what was happening;
- a **Resolving arc-resume…** spinner in the report section, which never cleared;
- in the *other* session's transcript, under the model's own name and avatar, a bulletin beginning "Your in-progress edit to `tugdeck/src/action-dispatch.ts`, … was committed onto the base as its own commit … `tugtool arc undo` puts the edit back uncommitted."

Meanwhile the fold had already succeeded: main carries `70da73b5b` ("Commit base work in progress to unblock the join of arc-resume"), and the join the user later performed landed on top of it. The act worked. Everything the user could see said otherwise.

The user set the frame for the fix: it works; it communicates *clearly* what it is going to do; then it does it; it does not spin forever; it does not pollute other sessions with weird messages. Two calls were made in the same conversation and are recorded as decisions below: the holder of the folded work **is** told, provided the voice is proper ([B08]), and the button **stays the single word Resolve** ([B06]).

---

## Evidence {#evidence}

**[F01] The server did the work.** `tugcast.log.2026-09-03` at 18:54:23Z: `arc-resolve-base: cleared arc=arc-resume folded=5 dropped=0`. Main's history carries the fold commit `70da73b5b`, and the arc's join (`ef54b4cf9`) landed after it. **(verified — log and `git log`)**

**[F02] The success frame cannot be read by the client.** `do_changeset_join_resolve_base` in `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` builds `changeset_join_resolve_base_ok` by serializing `ResolveBaseOutcome` (`tugarc-core/src/ops.rs:3845`) and inserting `action` and `project_dir`. The struct names the arc as `name`. The client's `_onControl` in `tugdeck/src/lib/changeset-join-store.ts` requires `body.arc` to be a string and returns silently otherwise. So the store never left `resolving`. The error frame, by contrast, is built field by field and carries `arc`. **(verified — read both sides)**

**[F03] Nothing else can end a resolving overlay.** `ResolvePhase` moves off `resolving` only on a recognised frame or on `_failInFlight`, which fires when the wire drops. There is no deadline, and the feed recompute that *does* arrive after the fold — the one that removes the blocker — is not consulted by the overlay at all. **(verified)**

**[F04] The seam is untested end to end.** `tests/app-test/at0486-join-base-resolve.test.ts` asserts the dialog, the sentence, and a live button, then deliberately stops before the press; its comment says the press cannot be driven because `refuse_unredirected_temp_repo` (`tugarc-core/src/log.rs:249`) refuses in the app process, which does not inherit the fixture's `TUG_DATA_DIR` the way the CLI it drives does. No test under `tugdeck/src` feeds the store a `changeset_join_resolve_base_ok` frame, and no Rust test asserts that frame's shape. The one unit that is pinned, `resolve_base_folds_the_users_own_edit_onto_the_base`, tests the fold, which is the part that worked. **(verified — grep and read)**

**[F05] Two surfaces narrate the same act with two vocabularies, and neither knows the act is running.** The register line comes from `arcJoinRegister` (`tugdeck/src/lib/arc-join-register.ts`): with a joinable, bound arc and no candidate it falls through to `Reconciling with <base>`, a sentence about the pilot's *next* recompute, not about the press. The spinner comes from `deriveResolveFace` reading the client overlay. The fold takes no `join_occupancy` hold — `JoinRunKind` has only `Resolve` (the conflict ladder) and `Join` — so the feed's `join.run` stays null, a reload forgets the press, and a second deck watching the same arc sees nothing. **(verified)**

**[F06] The holder's notice renders as the model speaking.** The supervisor publishes `notice_payload(session, "arc-resolve", text)` on `CODE_OUTPUT` as a `tug_notice`. In `tugdeck/src/lib/code-session-store/reducer.ts` (`handleTugNotice`), every origin other than the wheel opens an `origin: assistant` turn seeded with one `notice` system note — so the row wears the model's name and avatar and reads as something it said. The code comment beside the publish calls it "a quiet system row, no turn"; the render is neither. The text names `tugtool arc undo`, the same class of leak the `arc-resume` arc just removed from the stop receipt, and lists five full paths in a sentence. **(verified — read reducer and supervisor)**

**[F07] The pre-press sentence does not say what will happen.** The remedy's `explain` (`ops.rs:4066`, and `:4087` for another session's edit) is one sentence: "Resolve commits that work onto the base as its own commit, so the join can reconcile the two versions. Undo puts it back uncommitted." It names no files, no count, and no commit subject. The first blocker's `detail` is lifted onto the register line (`reportedBlockers`, `session-changes-arc-join.tsx:210`), so the dialog itself shows only the explain. "Undo" names no control anywhere on the surface. **(verified)**

**[F08] The doctrine already asks for most of the right thing.** `tuglaws/tracking-changes.md` (the landing table and the paragraph after it) says every remedy is a live act, that the fold preserves the holder's work, that "tugcast sends the holder's session a quiet `tug_notice`", and that `tugtool arc undo` returns the content uncommitted. [L31] says every refusal and every act is on screen. What is missing is a rule that the *outcome* of a press is on screen too, and a definition of what "quiet" looks like in a transcript. **(verified — read)**

**[F09] Undo exists in core and nowhere on a surface.** `OpVerb::ResolveBase` has `undo_resolve_base` and `redo_resolve_base` in `tugarc-core/src/oplog.rs`, reached by `tugtool arc undo`. I found no CONTROL verb or deck control that reaches it. **(grep only — the absence on the deck is believed, not proven; a devise round should confirm)**

---

## Decisions {#decisions}

**[B01] The success frame is built by hand and carries `arc`.** Same shape as `send_changeset_join_resolve_err`: `action`, `project_dir`, `arc`, then the outcome's fields (`committed`, `folded`, `dropped`, `folded_from`, `warnings`). An internal struct never goes on the wire by serialization alone; the wire is a contract and is written as one. A Rust test asserts the frame's keys, and the deck's store test consumes a fixture serialized by that Rust test, the way the changeset golden files already tie the two sides together.

**[B02] The feed is the terminal fact; the frame is a hint.** The overlay settles when the arc's next feed entry shows no `base-dirt` blocker (or shows a candidate), whether or not an ok frame arrived. This is the rule `changeset_join_land_delta` already follows ([P03]): a beat that never arrives costs a progress line, never the outcome. The frame's only job is to deliver the receipt's detail sooner.

**[B03] A press has a deadline of 60 seconds.** The user's number (2026-09-03). One timer armed at press and cleared on settle — not polling, and not a timer in a feed. If nothing has settled the overlay by the deadline it becomes a stated error: the press got no answer, the fold may still have run, and the row will update when the feed does. A spinner with no end is the one state this surface may never show. The fold is a few git commands, so a minute is generous; it is deliberately not derived from the ladder's `RESOLVE_DEADLINE`, which bounds a multi-turn agent and is hours long.

**[B04] The fold takes an occupancy hold, and the feed says so.** A new `JoinRunKind` for the fold (spelled distinctly from the ladder's `resolve`, since the register gives that word its own sentence) so `join.run` carries it through the feed. A reload, a second deck, and the register all then read the same fact from the same bytes ([L02]), and the in-process registry refuses a second press by name while the first runs.

**[B05] One voice, the register's.** While the fold runs, the register line is the sentence — `Committing base work · N files` — and the report section shows detail only: the file list, then the receipt. `Reconciling with <base>` is never painted over a fold in progress; the fall-through that produces it yields to the held run from [B04]. Two lines with two words for one act is the defect the register was created to prevent.

**[B06] The button stays "Resolve", one word, and the sentence carries the fact sheet.** The user's call. The description becomes what the discard preflight already is: the files, by count and by name; whose they are (yours, or the named session's); what will happen (one commit on `<base>`, with its subject shown); that nothing changes on disk; and that it is reversible *here*. The remedy is still never in the button ([L31] and the `JoinRemedy` docstring); it is in the sentence, and the sentence now says enough to be weighed.

**[B07] The sentence may promise only an undo the surface offers.** After the fold, the report section carries a receipt — the commit sha, the file count, the holder if any — with an **Undo** control beside it that reaches `undo_resolve_base` through a CONTROL verb. Until that control exists the sentence must not say "Undo"; a promise of a control that is not there is the dead button this whole lane refuses to render. No CLI verb appears in any of this prose.

**[B08] The holder is told, in Tug's own voice.** The user's call, with the condition stated. A notice from tugcast is a *system* row: it wears Tug's mark rather than the model's name and avatar, it names its origin as the arc lane, and it says who did what — "Resolve on arc `arc-resume` committed your uncommitted edits to N files onto main as `70da73b5b`. Nothing changed on disk. Undo is in your Changes shade." The reducer's rendering of non-wheel `tug_notice` origins changes to make that voice possible, and **every non-wheel origin renders the same way** — `base-motion`, the only other origin today, adopts the system row too (the user's call, 2026-09-03: one rendering is simpler and right). Its existing text gets a read against the new row as part of the work, not a separate arc.

**[B09] The press is driven by a test.** `at0486` presses Resolve and asserts the settle, the receipt, and the register's sentence. That needs the fixture's `TUG_DATA_DIR` to reach the app process the harness launches, or the refusal in `log.rs` to accept the fixture's redirect — whichever the harness can do honestly. A comment explaining why the press is not tested is not a substitute for the test.

**[B10] The receipt must survive a reload.** The user's word is *must* (2026-09-03). A resolve is durable in git and in the op log, and a receipt that lived only in the deck's memory would vanish on the first reload after the act — which, given that a join is minutes long and often finished from a different deck, is the ordinary case rather than the edge. Whether the receipt rides the feed entry (which already carries `join.report` for the ladder) or is read from the op log is the devise round's to settle; that it is read from something durable is not.

**[B11] The ladder's resolve is untouched in behaviour and shares the overlay's phase.** The conflict ladder (`changeset_join_resolve`) already has its own occupancy, deltas, and terminal frames. This work changes only the fold's path and the surfaces that narrate it; where the two share code — the store's phase, the deadline, the feed-derived settle — the ladder gains the same guarantees for free and is not otherwise redesigned.

---

## Open Questions {#open-questions}

- **How the harness gets `TUG_DATA_DIR` into the app process.** `arc-fixture.ts:967` sets it for something already; the devise round should establish whether the refusal is on the app's path or the CLI's, and fix the true gap rather than widen the refusal.
- **Where the durable receipt is read from.** [B10] settles that it survives a reload; the feed entry's `join.report` and the op log are the two candidates, and the devise round picks one.

---

## Non-goals {#non-goals}

- **Renaming the button.** Considered "Commit and resolve" once the description carries the fact sheet; rejected by the user. The single word stays, and the sentence does the explaining.
- **Joining after the fold.** Resolve clears the block and stops. Landing is the user's gesture; nothing here calls the join.
- **Changing what the fold does.** Committing divergent base work onto the base as its own commit is the design that makes a fold ordinary git history, and it worked. This brief is about the seam and the surfaces, not the operation.
- **Redesigning the conflict ladder's resolve.** It shares the store's phase and gains the deadline and the feed-derived settle; its rungs, deltas, and workshop are out of scope.
- **Not telling the holder.** Considered: drop the transcript notice and rely on the holder's Changes shade alone. Rejected by the user, on the condition in [B08].

---

## Exit {#exit}

**A plan.** The work spans five places that have to agree with each other — `tugarc-core` (op log reach, outcome), `tugcast` (frame, occupancy kind, notice, a new undo verb), the deck's store, register, and report surfaces, the reducer's notice rendering, and the app-test harness — plus a paragraph in `tuglaws/tracking-changes.md` stating that a press's outcome is on screen and what a quiet notice looks like. The first steps are the ones that make it work with no new design: the frame ([B01]), the feed-derived settle and deadline ([B02], [B03]), and the test that presses ([B09]). The phase boundary is between those and the voice work — the occupancy kind and register sentence ([B04], [B05]), the fact sheet and the durable receipt with Undo ([B06], [B07], [B10]), and the system-row notice ([B08]) — which touch surfaces a cold review should read before they are built.

<!-- brief-skeleton v1 -->

# Tripwires, top to bottom: the phases that bring the feature on line

**Purpose:** Tripwires were rebuilt once as a post-commit inspector and then set aside while other features settled. The engine has never finished a landing-fired trip, the card polls and cannot reach the session it shows a dot for, and the machinery hand-rolls what the arc runner already has. This brief looks at the whole feature from the trigger to the card, records what was found, makes the calls that cut across every phase, and lays out the phases so that each can be written up as its own single-phase brief and walked as its own arc.

---

## Purpose {#purpose}

> "It's been a good several days since we added an initial implementation of this feature, but then backed off working on it in order to settle down some other features. Time to get back to it. As we do so, I think we should look at it from top to bottom."

> "We now have more experience with arcs and running sessions via the Wheel. I think we might want to consider using the Wheel to drive Tripwire actions. I also wonder if we should run these actions as full-on sessions and whether those sessions should show up as arcs, or whether we just model tripwires when they run by borrowing some of the arcs machinery, and not actually displaying these things as arcs."

> "Also, we *certainly* need to take another full pass over the Tripwires card. It's a bit of a mess in terms of its UI and controls."

The ask is a survey and a shape: bring the feature fully on line, vet how it works, build a great UI for it, give it an API and controls, and make everything about it rock solid. The prior documents are `briefs/tripwire-notes.md` (the original model) and `briefs/tripwire-simplification-brief.md` (the post-commit-inspector rebuild); this brief supersedes neither but reads the code as it stands after both.

---

## Evidence {#evidence}

**[F01] The one tripwire on this machine has never completed a landing-fired trip.** `tugtool tripwire list` shows a single tripwire, `edits`, paused, watching `fact:edit_failed` on `main` scoped to this checkout with no probe and `acceptEdits` for authoring. Its log holds fourteen rows: four `failed` at "did not finish inside its twenty minutes", two `failed` with "instance restarted", five `swallowed` as `no-match`, two `swallowed` as `busy`, and one `settled`, which was the hand-fired `manual:` trip. Every landing that got as far as a session ended by ceiling or by restart. **(verified — `tugtool tripwire log edits` and `just db-inspect tripwires`)**

**[F02] The trigger is the landing gesture and nothing else.** Two call sites send a `LandingEvent`: the `/commit` path in `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` with the requesting session as lineage, and the `/arc-join` path with the arc's bound sessions read before bindings clear. Both are fire-and-forget on a 64-deep channel, and a full channel drops the landing with no trip row, which contradicts the doctrine that every refusal is written down. The git watcher fires nothing. A third door, `tugtool tripwire trip`, writes a queued row and nudges the instance with a synthetic landing that bypasses every guard by construction. **(verified — `tripwire.rs` `landed` and `serve_manual`)**

**[F03] Evaluation order is guards first, predicate last.** Branch column, scope prefix, `INSERT OR IGNORE` claim on `(wire_id, event_key)`, own-arc skip, busy skip, then the fact predicate over each lineage session's facts past a per-session high-water mark in `wire_marks`. The mark advances past everything looked at, matched or not. The tripwire table is re-read per landing, so pause and edit take effect on the next landing without invalidation plumbing. **(verified — `tripwire.rs` `consider` and `lineage_facts`)**

**[F04] The run already rides the Wheel and the supervisor, not a bespoke spawner.** Diagnosis spawns through `AgentSupervisor::spawn_headless_session` with a synthetic card id `tripwire:<name>`, cwd in a detached inspection worktree cut per landing, and permission mode hard-coded to `plan`. The prompt is delivered through `wheel::rotate` with stage label `tripwire`, which is the second Wheel client `tuglaws/wheel.md` anticipated. No tool allowlist is set; only the permission mode constrains the session. Authoring, when diagnosis resolves with `--author`, creates an arc lazily via `tugarc_core::ops::create_in` named `tripwire-<name>-<key8>` with `laid_by = tripwire/<name>`, and spawns a second session in that worktree under the tripwire's own permission mode. **(verified — `tripwire.rs` `run_pending`, `tripwire_session.rs`, `agent_supervisor.rs:5380`)**

**[F05] The engine hand-rolls a second concurrency regime and a second turn watcher.** `watch_turn` scrapes the `CODE_OUTPUT` feed for `turn_complete` or `turn_cancelled` with its own 20-minute `TRIPWIRE_RUN_TIMEOUT`, separate from the supervisor's turn tracking and from the arc runner's `settle_gate`. Claim, queue, supersede, `max_concurrent_trips` (default 2), a 15-minute probe ceiling, a 30-minute `SETTLE_CEILING` polled every two seconds, and a 90-minute orphan sweep all live in the trip engine, while the session it spawns also counts against the supervisor's `max_concurrent_sessions`. The two ceilings can disagree silently and no test pins the ordering of the four timeouts. **(verified — constants and paths read out of `tripwire.rs` and `tripwire_session.rs`)**

**[F06] The four ceiling failures are most likely the watcher, not the model.** This is inference. A read-only diagnosis of one `edit_failed` fact should not need twenty minutes; the arc runner's settle discipline exists precisely because "turn ended" read off a stream is unreliable when tugcast did not open the turn. Phase one confirms this by running one trip with the code-output stream open. **(not verified)**

**[F07] A crashed `claimed` row poisons its commit forever.** `TripStatus::Claimed` is transient on every normal path, but both `sweep_stale_running` and `sweep_orphaned_running` filter on `status='running'`, so a row left `claimed` by a crash is never swept, and the unique constraint refuses any later claim of the same `(wire, sha)`. **(verified — `tripwire.rs` sweeps and `claim_trip`)**

**[F08] The ledger is machine-global and still spells the old name.** `tripwires.db` sits beside `changes.db` and opens through `tugcore::ledger_db`, schema version 5 with registered migrations. Its tables are `wires`, `trips`, `settings`, and `wire_marks`; the trips column is `wire_id`. The vocabulary "wire" also survives across `tripwire.rs`, `tripwire_session.rs` (whose header still describes a verdict tier, a work tier, pooled workers, and the deleted envelope), `tripwire-presentation.ts`, `tripwires-card.tsx`, and the app-test prose, and collides with the deck's protocol sense of "wire" in `action-dispatch.ts`. `dash` survives in `landing_from_payload` and test fixtures. **(verified — `.schema` on a copy of the db and grep)**

**[F09] The deck reaches tripwires by polling, over loopback HTTP only.** `tugdeck/src/lib/tripwires-store.ts` fetches `GET /api/tripwires` every five seconds while retained, `GET /api/tripwires/<name>/trips` on open, and `POST /api/tripwires/<name>` for knobs, which accept only `paused` and `model`. The one feed use is the Overview feed filtered to `author === "tripwire"` as a refresh trigger. No tripwire feed frame exists, and the only broadcast is an Overview post, emitted only on `awaiting`. The deck can dispatch no tripwire action; `tripwire_trip` and `tripwire_tell` exist only as `tugtool tell` nudges. **(verified — `tripwires-store.ts`, `server.rs:1853`, `actions.rs:387,407`)**

**[F10] The card has one working control and several dead surfaces.** Pause is the only writable knob; `setKnobs` accepts `model` and nothing in the deck passes it. Two `TugAtomRef` arc atoms are mounted with no gesture and go nowhere. Trip rows are focus stops with no delegate, so Enter is a no-op. The running session id keys a dot and nothing else; there is no way to open the session from the card. `awaiting` holds the tripwire's one-run slot and offers no act to clear it. `probe_tail`, `refs`, `event_key`, `instance`, and `settled_at_ms` arrive in `TripRow` and are never shown, so `probe N` is displayed without the output that explains it. `TripMark` computes a state class in React, against both [L06] and the card's own CSS header. The error strip paints one tripwire's failed log fetch over the whole card. **(verified — `tripwires-card.tsx`, `tripwires-store.ts`)**

**[F11] The card diverges from the arcs card's conventions on every axis.** Arcs spreads `RAIL_LIST_PRESENTATION`, marks with `data-slot`, puts verbs on `onContextMenu`, states reachability with `data-activatable`, carries a register band per row, and activates a row onto the bound session's card. Tripwires passes `rowDensity="compact"` only, uses ad-hoc `data-tripwire*` attributes, has no context menu, no band, no collapsed band with a live count, and hand-rolls its own empty state. Its definition grid pays its inset by summing two list tokens by hand and the app-test pins the resulting x. **(verified — `arcs-card.tsx:757,1073,1145` against `tripwires-card.tsx`)**

**[F12] Card adoption of a background session is not built.** `briefs/background-session-card-adoption-brief.md` names the gesture; the only thing resembling it is the ordinary resume of a closed headless id through `spawn_session`, pinned by `a_card_can_adopt_a_headless_sessions_id_afterwards`. The load-bearing case, attaching a card to a mid-turn live session and reconciling replay against the live stream, does not exist. **(verified — `agent_supervisor.rs:16146` and grep for adoption ops)**

**[F13] The arc runner is arc-shaped in ways a trip is not.** `bound_arcs` enumerates arcs only through the ledger's arc binding to a live card, so a cardless session is invisible to it. `ArcFacts` is document-shaped (`plan_path`, `lint_ok`, `review`, a step ledger). `ArcStage` is the hardwired four. The opening prompt composes from `brief.md` and `plan.md`. The "course" generalisation, a progression as data rather than one hardwired stage list, is still open from `briefs/dash-wheel-retrenchment.md` [W05]. **(verified — `arc_runner.rs:349,1586,1665`, `arc.rs:63-130`)**

**[F14] What the app-test pins and what it misses.** `tests/app-test/at0492-tripwires-card.test.ts` pins roster order, the paused attribute, branch text, zero dots at rest, chevron and back, the definition rows, the gist as first sentence, head-title alignment, and the absence of "tier", "cooldown", and "post policy". It covers no control through the UI, no populated trip log, no error state, no dot meaning, no keyboard activation, no arc atom, and no poll or feed refresh. `tugrust/crates/tugtool/tests/tripwire_cli.rs` pins the CLI surface only. **(verified)**

**[F15] Inspection trees clean up.** `~/Library/Application Support/Tug/tripwire-trees/` is empty after fourteen trips including six failures, so the refcounted per-landing worktree and its removal hold. **(verified — `ls`)**

---

## Decisions {#decisions}

**[B01] A trip stays a session and never becomes an arc.** An arc is a walk over a plan ledger with four stages and document-shaped facts [F13]; a trip has no plan, no steps, and ends in a resolution verb. Forcing trips onto the arc runner means the course generalisation [W05] first and buys nothing for a probe-diagnose-maybe-author progression. The arc enters only when diagnosis asks for authoring, and that arc is a real arc, badged by its `laid_by` provenance, shown in the Arcs card like any other, joined or discarded by the user. Trips are shown in the Tripwires card, never in the Arcs card. Revisit only if a trip acquires steps worth pacing.

**[B02] The trip engine stops reimplementing what the supervisor and arc runner already have.** It already rides the Wheel and the supervisor's headless spawn [F04]; what it hand-rolls is the turn watcher, the settle ceilings, and a parallel concurrency budget [F05]. The turn-end reading moves onto the supervisor's own turn tracking and the arc runner's settle gate, extracted so both clients read one implementation. The trip queue folds into the supervisor's spawn budget rather than sitting beside it. This is the "use the Wheel" ask answered precisely: not moving trips onto the Wheel, which is done, but sharing the discipline the arc runner built on top of it.

**[B03] The vocabulary is tripwire, lay, trip, trip log, pause, resume, and nothing shorter.** A firing is a trip; there is no "action", which would collide with the deck's action dispatch. `wire` and `dash` leave the schema, the code, the comments, and the test prose [F08], with a registered migration for the tables and a guard that fails on the retired words so they cannot return.

**[B04] Authoring is a slash command in the Session card, and the terminal is never required.** The user's call: "Users will not need the terminal, but they will need to type in a prompt-entry field in a session to create a tripwire." The door is `/tripwire`, which exists today as the tugplug skill and drives `tugtool tripwire` underneath. The card never grows a lay form; it carries the small knobs. The skill is re-read against the engine as it actually behaves once the engine settles, and its shake-down flow must work from a standalone `Tug.app` on a scratch project.

**[B05] Nothing in the feature does what it does forever; how an awaiting trip is released is a design question, not a default.** The user's call: "I don't like the sound of anything doing what it does *forever*." The skill's current promise that an awaiting trip holds its slot with no timeout is withdrawn as a promise. The card's phase owns the answer, because release is a gesture the user makes from the surface where the trip is shown, and the arc's own fate (joined, discarded) already answers part of it. See the open question.

**[B06] Timeouts are not a product concept yet; visibility and control are.** The user's call: twenty minutes sounds too long, tripwires are not for long-running jobs, but what people will use them for is unknown, so building in a notion of timeouts is premature. The four hand-tuned ceilings [F05] are engineering guards against a runaway process, not limits the user sees or sets. Once the watcher is right [B02] and the card lets the user see a running trip and take it over [B07], the guards shrink to whatever protects the machine and are never surfaced as a knob. A ceiling that remains must be pinned by a test that states why.

**[B07] Opening a card on a background session is a general capability and a tripwire's first caller.** This restates the adoption brief's split and makes it a phase here [F12]. The Tripwires row holds a session id and dispatches adoption; anything beyond that is the card's own presentation. Adoption must handle the mid-turn live case, or it has not built the capability.

**[B08] Tripwire state rides a feed frame; the HTTP surface becomes the API.** Polling every five seconds [F09] violates the no-polling rule the rest of the product keeps. The roster and trip log arrive as frames like every other live surface, and the loopback HTTP endpoints become the deliberate API: roster, trip log with every field the row carries, knobs, and the verbs the card and the skill both need (trip, pause, resume, model, resolve, dismiss, and whatever release [B05] turns out to be). The skill and the card read one surface and cannot disagree.

**[B09] The card adopts the arcs card's conventions wholesale, and every dead thing goes live or goes.** Shared rail presentation, `data-slot` marks, register band per row, context-menu verbs, `data-activatable` reachability, a collapsed band with the live count [F11]. The arc atoms open the Join sheet, trip rows activate, the model knob works, awaiting has an act, probe output sits beside its exit code, the trip mark takes its state from a `data-` attribute, and an error is scoped to what failed [F10].

**[B10] The whole feature gets a durable doctrine document and design-decision entries.** Tripwires have two working papers and no `tuglaws/` file. The lifecycle, the two provenance guards, the session-not-arc rule [B01], and the slash-command door [B04] are written to `tuglaws/tripwires.md` and registered as decisions once the engine and card settle.

**[B11] Each phase below is its own brief and its own arc, and this document is their table of contents.** The user's call. The phases are ordered by dependency, not by size. A single-phase brief cites this document's findings and decisions by label and adds only what its phase discovers.

---

## The phases {#phases}

> Each phase is the seed of a single-phase brief. Each names what it covers, what it rests on, and what proves it done. None carries steps.

### Phase 1 — Prove one trip, then fix the watcher

**Covers:** Resume `edits`, land a commit carrying an `edit_failed` fact, and watch the trip with the code-output stream open until it resolves, confirming or refuting [F06]. Move turn-end onto the supervisor's tracking and the arc runner's settle gate [B02]. Close the known holes: the poisoned `claimed` row [F07], the dropped landing with no row [F02], the unpinned ordering of the ceilings [F05]. Shrink the guards per [B06].

**Rests on:** [F01] [F02] [F05] [F06] [F07] [B02] [B06].

**Done when:** a landing-fired trip resolves quiet and a hand-fired trip resolves awaiting, each in a test that runs the real verbs against a real headless session, and no trip in a week of this checkout's landings ends `failed`.

### Phase 2 — One scheduler, one vocabulary

**Covers:** Fold claim, queue, supersede, and the concurrency ceiling into the supervisor's spawn budget [B02]. Rename `wires` and `wire_marks` with a registered migration and bump; purge `wire`, `dash`, `envelope`, `tier`, `post` from code, comments, and test prose [F08] [B03]; rewrite the stale module headers in `tripwire_session.rs` and `tripwire.rs`. Add a guard that fails on the retired words.

**Rests on:** [F05] [F08] [B02] [B03].

**Done when:** the trip engine owns no ceiling or budget of its own, the schema and the code agree on the noun, and the guard is green.

### Phase 3 — Open a card on a background session

**Covers:** The adoption brief [B07]: adoption by session id, running or settled, history replayed, live stream attached, idempotent single-seating, working composer, with the Tripwires row as first caller. Settles where adoption lives, which replay path it reuses, the live-attach boundary, and the source of truth for sessions without cards.

**Rests on:** [F04] [F12] [B01] [B07].

**Done when:** an app-test adopts a running trip mid-turn and sees the boundary frame exactly once, and a settled trip opens onto its full transcript.

### Phase 4 — Feed frame and API

**Covers:** Retire the poll [B08]. Design the tripwire feed frame and the frames' relation to the Overview post. Make the HTTP surface the API, with every trip field and every verb, and give the deck actions for each. Decide the release gesture for awaiting [B05] here or in Phase 5, whichever the design settles first, since the verb has to exist before the card can offer it.

**Rests on:** [F09] [B05] [B08].

**Done when:** the deck holds tripwire state through `useSyncExternalStore` over frames with no timer, every verb is dispatchable, and the skill and the card read the same endpoint.

### Phase 5 — The card

**Covers:** The full pass [B09]. Conventions from the arcs card, collapsed band with live count, activation of rows and atoms, the model knob, the awaiting act and release [B05], probe output, the L06 fix, scoped errors. Grow `at0492` to cover pause through the UI, a populated log, keyboard activation, the three dot meanings, and the arc atoms [F14].

**Rests on:** [F10] [F11] [F14] [B05] [B07] [B08] [B09].

**Done when:** the card passes the arcs card's conventions check by inspection, no control on it is dead, and the app-test covers every control and every state.

### Phase 6 — Skill and doctrine

**Covers:** Re-read `tugplug/skills/tripwire/SKILL.md` against the engine as it now behaves and cut what drifted, including the "no timeout, on purpose" promise [B05] and the twenty-minute language. Write `tuglaws/tripwires.md` and register decisions [B10]. Confirm the slash-command door works from a standalone `Tug.app` on a scratch project under `just test-standalone` [B04].

**Rests on:** [B01] [B03] [B04] [B05] [B06] [B10].

**Done when:** the skill lays and shakes down a tripwire from a scratch project with an empty `PATH`, and the doctrine file is cited from the code it governs.

### Phase 7 — A second tripwire and hardening

**Covers:** Lay the CI-confidence tripwire the notes always wanted, with a probe, so the free green path is exercised alongside `edits`. Run both for several days of real landings and read the logs. Fix what the logs show.

**Rests on:** everything above.

**Done when:** a week of landings across two tripwires produces no `failed` row and the awaiting trips it raised were each worth reading.

---

## Open Questions {#open-questions}

- **What releases an awaiting trip?** [B05] withdraws "forever" without naming the replacement. Candidates: the card's own acknowledge act; the arc's disappearance, which already resolves the arc-bearing case; a later landing on the same branch that supersedes the question; or a combination. What settles it is Phase 4 or 5 designing the verb against the card, with the rule that the trip log records the release and its reason.
- **Does a tripwire session get a tool allowlist, or is permission mode enough?** Diagnosis runs under `plan` with the full tool surface [F04]. The simplification brief said read-only "enforced by the runtime". Whether `plan` is that enforcement or an allowlist is needed is settled by Phase 1 reading what the SDK actually refuses under `plan`.
- **Where does a hand-typed `git commit` stand?** Both prior briefs accepted that only Tug's landing gestures fire a tripwire. This brief keeps that, but the second tripwire in Phase 7 is the first time a user will feel it. If it reads as a gap then, it is a new brief, not a quiet widening.

---

## Non-goals {#non-goals}

- **Running trips through the arc runner.** Rejected per [B01]; it needs the course generalisation first and a trip has nothing for the runner to pace.
- **Showing trips in the Arcs card.** A trip is a session; only the arc it may author is an arc, and that one is already shown there.
- **A lay form on the card.** Authoring is the slash command [B04]. The card carries knobs and verbs.
- **A user-facing timeout knob.** Per [B06], timeouts are engineering guards until usage says otherwise.
- **Firing on commits made outside Tug's landing gestures.** Kept out, as both prior briefs decided; an open question notes when to revisit.
- **A pending `QuestionDialog` held across adoption.** Deferred by the adoption brief; still deferred.
- **A general background-agent registry.** Adoption names an adoptable session; nothing wider is built until a second caller exists.

---

## Exit {#exit}

**An arc per phase, and this brief is not one of them.** The next gesture is a single-phase brief for Phase 1, written against this document and citing its labels, then `/arc` on that brief. Phases 1 and 2 must land before 3 through 5 are worth opening, because a card built over a watcher that times out shows the wrong thing beautifully. Phases 3 and 4 can be written in either order; Phase 5 needs both. Phases 6 and 7 close the feature.

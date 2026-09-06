# Start and Stop are buttons on the arc

**Purpose:** An arc can be stopped only from a terminal and started only from a door, and the one Resume button lives in a receipt that scrolls away. The two surfaces that show an arc — the Arcs card and the Z2 `ARC` popup — should carry one control that starts, resumes, or stops it.

---

## Purpose {#purpose}

The user's ask, verbatim:

> We need start/stop buttons on arcs. These buttons should be visible in the Arcs card, as well as in the Z2 Arc popup.

And the guidance on the sketch's five questions, verbatim in its load-bearing parts:

> 1. Start on document rows … I go with your recommendation [include it]
> 2. Halt now, or stop at the seam? … halt now
> 3. Icon-only on the row … ok
> 4. One verb for Start and Resume, retiring `arc_resume`? … go with two
> 5. Which sessions' consent does Stop need on a multi-holder arc? … There is no such thing as this! it's impossible for an arc to be bound to more than one session! Are we accounting for this now? We shouldn't be!

The fifth is the one that changes doctrine rather than code. Shown the law line that says two cards on one arc is legal, the user reaffirmed:

> This is *completely bonkers wrong*. I never ever intended this. Seriously. This must be fixed. It makes no sense for two sessions to be working on a single arc.

So the invariant is one arc, one card, and the list that let the machine say otherwise goes with the sentence ([F11], [B10]).

---

## Evidence {#evidence}

**[F01] Stopping is a CLI verb and nothing else.** `tugtool arc stop <name>` posts `arc_stop` to `POST /api/arc` (`tugrust/crates/tugcast/src/server.rs:815`). The blocking half (`arc_api.rs:348`) resolves the calling card's live segment, requires that card to be bound to *this* arc, refuses an arc already done or already stopped, and names the stage. The async half (`server.rs:668`) runs the shared stop path `stop_arc_for_session` with `ArcStopReason::StoppedByUser` and `HandBack::Send`; the card gets the receipt `arc stopped · <arc> · in <stage> — you stopped it` (`tuglaws/arc-lifecycle.md:89`). **(verified)**

**[F02] No deck surface sends a stop.** The supervisor's CONTROL dispatch (`agent_supervisor.rs:4123–4150`) accepts `bind_arc`, `arc_resume`, `unbind_arc`, `resolve_sessions` — no `arc_stop`. `grep sendControlFrame("arc_` over `tugdeck/src` finds only `arc_resume`, in the stop receipt. The only user gestures that stop an arc from the UI today are cancelling the turn (`card taken`) and closing the card (`card closed`). **(verified)**

**[F03] Resume is already a button, in one place.** `ArcResumeOffer` (`session-arc-receipt-block.tsx:373`) sends `arc_resume` with `{tug_session_id, project_dir, arc}` — the `bind_arc` payload, deliberately ("a resume *is* a bind with the stop cleared first", `agent_supervisor.rs:4130`). `arc_api::arc_resume` (`arc_api.rs:240`) appends `arc-resume <stage>` when the record carries a stop, then binds; an arc with no stop is bound and left alone, so a second press is a no-op. The press is held in `arcResumeStore` until `arc_resume_ok`/`_err`; a refusal speaks through `ArcResumeNoticeController` as a pane bulletin. The rotation is the card's next idle, never the call ([P05]). **(verified)**

**[F04] Starting a fresh arc happens client-side, in the CLI.** `tugtool arc run <name> [--plan]` runs `open_arc` inside the tugtool process (`tugtool/src/arc.rs:1251`): `validate_arc_name`, find `brief.md` / `plan.md` / `tasks.md` under `.tug/arcs/<name>/`, `append_arc_start`, `append_arc_kind` — and only then posts `arc_run`, which on the server is `bind` and nothing more (`server.rs:763–777`). The server has no verb that opens an arc. **(verified)**

**[F05] The doors decide the kind, and both doors already want the gestures to be buttons.** `/arc` writes a brief and a task list and runs `arc run` (plain); `/arc-plan` writes a brief and runs `arc run --plan` (planned). Both skills carry the same sentence: *"Never offer the resume by naming a command. A stopped arc's receipt carries its own Resume button, and a CLI verb typed into the transcript beside it is the implementation the button exists to hide."* (`tugplug/skills/arc/SKILL.md:53`, `arc-plan/SKILL.md:59`). **(verified)**

**[F06] The doctrine already imagines a Stop button.** `arc-lifecycle.md:220`: the ownership gate sits in the runner's clock paths and not in `stop_arc_for_session`, because "a user pressing Stop on a card bound to a foreign-owned arc is making a decision, not a judgment." **(verified)**

**[F07] The Arcs card once had buttons on plan rows and took them off, for three reasons.** The `PlanCell` docblock (`arcs-card.tsx`, "A plan row carries no button"): a Devise / Review / Implement control "composed a `/tugplug:…` line and submitted it into the followed card. It read as a label rather than as a control, it made a row about the followed card when the card is about every project, and the gesture it offered is one sentence to type." Two objections are about that button (a word; a typed prompt). The third — a row about every project carrying a button about one card — is structural and is answered in [B05]. **(verified)**

**[F08] Both surfaces have the slot.** `ArcLifecycleBlock` reserves `trailing` for "the surface's own — a row menu, a fold cue" (`arc-lifecycle-block.tsx`); the Arcs card fills it with `BlockFoldCue` (`arcs-card.tsx`, `ArcCell`). The Z2 `ARC` popover (`ArcPopoverContent`, `session-card-telemetry-popovers.tsx:1371`) ends in a `TugPopupListFooter` whose action cluster holds one `2xs` ghost `Show in Changes`; the footer's stated convention is "every action is a 2xs push-button-shaped control" (`tug-popup-list.tsx:~400`). **(verified)**

**[F09] The row menu is for rare verbs.** `arc-row-menu.tsx` header: Bind, Discard, Replay moved behind `⋯` / right-click because "a card binds an arc once and discards one almost never, and the row's whole job in between is to be read." Start and Stop are the opposite population. **(verified)**

**[F10] A stop keeps the binding.** `stop_arc_for_session` (`arc_runner.rs:2544`) never calls `set_arc_binding`; the one production caller that clears a binding is `arc_api::unbind` (`arc_api.rs:281`). So a stopped arc's row still names the card that was running it, and `bound_sessions` on the wire is live-sessions-only (`session_ledger.rs:5398`, `bound_sessions_by_arc`). **(verified)**

**[F11] The law says two cards on one arc is legal, and nothing in the server refuses it.** `arc-lifecycle.md:122`: "Two cards on one arc is **legal**, not a race: `bound_sessions` is a list and the Arcs card renders one jump chip per bound session." `arc_api::bind` (`arc_api.rs:160–200`) refuses a bind in another project and a bind that would displace *this card's* live arc ("card runs X — stop it before binding Y"); it never asks whether another live session already holds the arc. The ledger stores the binding as a column on the session row, so uniqueness per arc is not a constraint anywhere. On the deck `ArcChangesetEntry.bound_sessions?: string[]`, and `ArcLifecycleBlock` renders `workers` as a list of mini atoms. `tuglaws/list-surface-grammar.md:53` restates it as doctrine: "`bound_sessions` is a **list**, and two cards on one arc is doctrine rather than a race. Every bound session gets an atom." The list is carried in 8 deck source files, 10 app-tests, 9 Rust files across `tugcast-core`, `tugcast`, `tugarc-core` and `tugtool`, and 3 law documents. **(verified)**

**[F12] The wheel holds the other direction as law.** `wheel.md:75`, "One arc per card": a rotation for a card already running a live arc is refused as `arc running`; `arc-lifecycle.md:119`: "A session has at most one arc, which is why `unbind_arc`'s whole payload is the session id." Card→arc is one; arc→card is unconstrained. **(verified)**

**[F13] The CLI's `HandBack::Send` assumes the stop is asked from between turns.** `HandBack::Arm` exists for "the stage is mid-turn, and nothing retires a claude mid-sentence" (`arc_runner.rs:~2515`). The `arc_stop` async half passes `Send` unconditionally (`server.rs:708`) because the CLI is typically typed inside the stage's own turn. A button is pressed from outside the turn, at any moment. **(verified)**

**[F14] A user's cancel already stops an arc as `card taken`,** through the same stop path, reading `turn_ended_in_user_cancel` (`agent_supervisor.rs:3161`; `arc-lifecycle.md:79–81`). So "interrupt the turn, then stop" is a composition of two acts the server already performs, not a new one. **(verified in code; the composed path is not yet exercised)**

**[F15] The pending sketches do not overlap.** `notes/arcs-card-steps-fold-sketch.md` [S02] put the fold cue in the trailing slot and [S03] excluded plan rows from the fold; `notes/arc-line-words-sketch.md` is about the lifecycle line's words. Neither touches verbs. **(verified)**

**[F16] [D153] admits a verb on an arc surface exactly when the act has no other door.** "A surface that shows an arc lets you act on one — by routing to the room where the act already lives, never by growing a new one … Replay is the one act with no other door." Stop has no door in the UI at all ([F02]); Start has only a typed command; Resume has a receipt that scrolls away. The control is three acts under Replay's own exception, and activation stays navigation ([D142]): the control is a button in the trailing slot, never the row's click. **(verified)**

---

## Decisions {#decisions}

**[B01] One transport control per arc, on every surface that shows the arc.** It wears ▶ when the arc is not running and ■ when it is. Pressing it performs the one verb the arc's state admits — Start, Resume, or Stop — through the server path the CLI takes, never by composing a prompt ([F05], [F07]). When the press cannot land, the control stays and says why ([L31]).

**[B02] Three faces, derived from the entry the row already renders.** A document with no arc record → ▶ *Start*. An arc record carrying a non-terminal stop → ▶ *Resume*. A live arc, not done, with a bound card → ■ *Stop*. A done arc shows no control: the join register is its affordance. The face reads `entry.arc.stopped`, `entry.arc.done`, and `entry.bound_sessions`; the only local bit is the pending press.

**[B03] Icon-only `xs` on the Arcs card row, a `2xs` outlined word in the Z2 footer.** On the row it sits in the `trailing` slot before the fold cue ([F08]), same shape as the cue, so the column stays one edge. In the popover it joins `Show in Changes` in the footer's action cluster and wears the word — `Start` / `Resume` / `Stop` — because that cluster is words. Same component, two sizes, one state machine. The word on the row was the "read as a label" defect ([F07]); the icon is not a label.

**[B04] Two verbs: `arc_run` for Start, `arc_resume` as it stands for Resume.** The receipt block and its store are untouched by the resume half. `arc_run` becomes a CONTROL verb carrying `{tug_session_id, project_dir, arc, kind}` and, on the server, learns to open: `open_arc` moves from the tugtool crate into `tugarc_core::ops`, and `arc_api::arc_run` calls it when `read_arc` finds no record — validate, find the document, `append_arc_start`, `append_arc_kind`, then `bind` ([F04]). `tugtool arc run` keeps opening client-side first, so it reaches the server with a record already written and the server's open is a no-op for it; nothing about the CLI changes.

**[B05] Stop and Resume act as the card that has the arc; Start acts as the followed card.** Stop needs no choice: the row's one bound card ([B10]) is the caller, and an unbound live arc shows ■ disabled with `no card is running it` — Discard in the menu remains the way to end it. Resume seats the arc on its bound card when one is still open ([F10]), which is the receipt's own behaviour; only an unbound stopped arc falls through. Start, and that fall-through, take the followed card — the rule Bind already uses on this card — with the refusals on the control itself: `no Session card to run it on`, `<card> is running <arc>`, `<card> works another project`. This answers [F07]'s third objection: the card is not about the followed card; the *press* is, and the control says which card it means before it is pressed. In the Z2 popover there is no question: it exists only for the arc this card is bound to.

**[B06] Stop halts now.** The `arc_stop` async half is lifted out of `server.rs:668` into a supervisor method the HTTP route and the new CONTROL verb both call. It reads the seated session's live turn state: with a turn running it interrupts the turn through the path a user's cancel takes ([F14]) and then stops with `HandBack::Send`; with no turn running it stops with `Send` as today. The reason is `stopped by user` either way, and the receipt says `you stopped it`. A step in flight leaves whatever it wrote uncommitted in the worktree — the state a `card taken` stop already leaves, and one Resume, Discard, and Replay already reason about. The alternative, arming the stop and letting the turn finish, was rejected: a stop control that lets the thing run for up to a whole turn is the dead button the arc verbs have paid for twice.

**[B07] `arc_stop` becomes a CONTROL verb** beside `arc_resume`, same `parse_bind_arc_payload`, answering `arc_stop_ok` / `arc_stop_err` on the same shape as the resume pair. The blocking half is `arc_api::arc_stop` unchanged.

**[B08] The kind of a started document is read off its documents.** `tasks.md` present and no `plan.md` → plain (what `/arc` leaves); `brief.md` or `plan.md` present → planned (what `/arc-plan` leaves; a reviewed plan derives straight to implement under the existing stage derivation, so "planned" costs no extra stage). A brief and a task list with no plan → plain, the task list being the ledger implement walks. The deck sends the kind it derived; the server records it.

**[B09] One press store, two notice surfaces.** `arcResumeStore` generalizes to hold a pending press per `(arc, verb)` and a refusal per session, under a name that is no longer one verb's; the receipt, the Arcs card, and the popover read it. A refusal from the Z2 popover speaks through the card's existing pane bulletin ([F03]); a refusal from the Arcs card lands on the card-level surface Bind's refusals already use.

**[B10] An arc is bound to at most one live card, the server enforces it, and the list that said otherwise is removed.** Three parts, none optional. **The refusal:** `arc_api::bind` gains the mirror of its own displacement check — a bind naming an arc that another live session already holds is refused by name, `<card> is running <arc>`, the same sentence [B05] puts on the control. **The shape:** `bound_sessions: Vec<String>` becomes `bound_session: Option<String>` on `ArcChangesetEntry` and `DocumentArcEntry` in `tugcast-core` and on the deck's `changeset-types.ts`; the ledger's `bound_sessions_by_arc` answers one session per arc; `base_motion`'s notify set is one card; `ArcLifecycleBlock.workers` becomes `worker`, one mini atom or none; the arc picker, the shade's lane, the Z2 popover and the Arcs card read the scalar; the app-tests that assert a list assert the one. **The law:** `arc-lifecycle.md:122` and `list-surface-grammar.md:53` are rewritten to the invariant, and a design decision records it. What would revisit this is a designed reason for two cards to drive one arc, and there is none: the wheel rotates one card ([F12]), the stop hands back one card, the receipt lands on one card. Multi-holder is not a state the machine can drive, so no surface may account for it — no list, no "first bound card", no consent question. The breadth ([F11]) is the cost of a list nobody intended having been written into four layers; it is one rename campaign, and leaving the list in place would leave the type saying what the law now forbids.

---

## Open Questions {#open-questions}

None. The five the sketch raised are decided above; the fifth turned out to be a law correction rather than a design choice ([F11], [B10]).

---

## Non-goals {#non-goals}

- The Changes shade's arc row. It is the join's room; a control there is a follow-on once the two surfaces named here have settled.
- Any change to what a stop *records*, how the wheel judges one, or the stop vocabulary — `notes/arc-never-stops-brief.md` owns that.
- The stop receipt's Resume offer, beyond reading the generalized store ([B09]).
- Join, Discard, Bind, Unbind, Replay: the join stays the composer's and the shade's; the rest stay behind `⋯` / right-click ([F09]).
- The doors. The control never composes a `/tugplug:…` line; writing a *new* document is still the composer's act.
- A Stop that lets the turn finish ([B06]).

---

## Exit {#exit}

One phase, five steps, in this order because each later step stands on the one before.

1. **One arc, one card.** [B10] whole: the refusal in `arc_api::bind` with its test (`a_bind_naming_an_arc_another_live_card_holds_is_refused_by_name`); `bound_sessions` → `bound_session` through `tugcast-core`, the ledger, `changeset`, `base_motion`, `arc_runner`, `doctor`, `ops` and `tugtool`; the deck's types, `ArcLifecycleBlock`, the arc picker, the lane, the popover and the Arcs card; the ten app-tests that read the list; `arc-lifecycle.md:122` and `list-surface-grammar.md:53` rewritten, and the design decision recorded. First, because every later step's face derivation reads the scalar.
2. **Server verbs.** `open_arc` moved to `tugarc_core::ops` and called from `arc_api::arc_run` when no record exists, with `kind`; `arc_run` and `arc_stop` as CONTROL verbs answering `_ok`/`_err`; the stop's async half lifted into the supervisor and reading turn state ([B06]) with tests for both branches — a running turn is interrupted then stopped with `Send`; an idle session stops with `Send` — and a pin that `tugtool arc stop` still records `stopped by user` and leaves the receipt (`a_user_stop_writes_the_record_the_receipt_and_the_hand_back` stays green).
3. **The control.** One `ArcTransportControl` component (`.tsx`/`.css`, `data-slot`) deriving its face per [B02], with both sizes, disabled reasons per [B05] in the [L31] grammar, and a pending state read from the generalized store ([B09]). A pure test over the face derivation: every combination of `stopped` / `done` / `bound_session` / document-only maps to exactly one of Start, Resume, Stop, none, and the disabled reason for each refusal.
4. **The two surfaces.** The Arcs card's `ArcCell` and `PlanCell` put the control in the trailing slot before the fold cue (`PlanCell` gains a trailing slot for it, which [F15]'s fold sketch deliberately left empty); the Z2 popover's footer gains the word button. App-tests: one drives Stop on a live arc from the Arcs card and asserts the `you stopped it` receipt on the bound card and the row's face flipping to ▶; one drives Start on a brief-only document row and asserts the arc opens on the followed card with the derived kind; one drives Resume from the Z2 popover and asserts the stop clears. Each carries `@covers`.
5. **The kind.** The derivation ([B08]) has a pure test over the four document combinations, and a server test that `arc_run` records the kind the frame carried.

Phase boundary is the join. Every step verifies with `cargo nextest run` for the crates it moved and `just app-test-changed` for the deck.

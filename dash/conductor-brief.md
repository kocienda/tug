# The conductor: name and expose the session-rotation primitive

**Purpose:** Tug already mediates every claude session through tugcast and tugcode, and the dash arc proved that layer can retire one claude session and seat another under the same card, on a chosen model, with a chosen prompt. That capability has no name and no door: it lives inside `dash_arc_runner.rs` as a private detail of one feature, so nothing else in Tug can reach for it.

---

## Purpose {#purpose}

In the user's words: *"The indirection-by-construction aspect of Tug sessions, whereby we mediate the flow of content and data through tugcode/tugcast as a supervening/supervisory layer on top of claude sessions, gives them a power and flexibility that Claude Code sessions in the terminal simply cannot achieve. This feature has been in the codebase for months, but tapping into this potential to create, control, and manage multiple claude sessions in the pursuit of a higher-level user goal — like a dash — feels like a capability we should be using more to better advantage."*

The motivating example: `plan-devise` finishes a plan and, if it is not running on the review model, stops and prints a `/tugplug:plan-review` chip for the user to click after switching models by hand. The arc rotates models without anyone clicking anything. The same machinery could have carried the review turn automatically; it did not because no skill can ask for a rotation.

The work is to give the layer a name, extract the operation from the arc into something any client can call, and document it so the model knows it is there.

---

## Evidence {#evidence}

**[F01] Rotation exists only as a private function of the arc runner.** `rotate` in `tugrust/crates/tugcast/src/feeds/dash_arc_runner.rs` builds a `StageSpec { stage, document, plan, arc, model, steps, prompt }` and hands it to `drive_stage`, which sends the card's tugcode a stage request. Nothing outside that module constructs a `StageSpec`; the only server op that touches the arc is `arc_run` in `tugrust/crates/tugcast/src/server.rs`, and it binds a dash rather than rotating anything. **(verified)**

**[F02] tugcode already implements the receiving half generically.** `tugcode/src/session.ts` respawns claude on a stage request via `handleNewSession(stage?)`, emits `session_stage` before the synthetic `session_init`, threads `TUG_DASH_ARC` into every spawn while an arc is current and clears it on a plain `/new`, and replays the lineage prefix on restore (`collectLineagePrefix`). None of that code knows what a dash is beyond the environment variable's name. **(verified)**

**[F03] The identity model already treats a stage as a session fork with no fork point.** `set_fork_provenance(… Option<&str>)` in `tugrust/crates/tugcast/src/session_ledger.rs` writes `fork_point: NULL` for a rotation, which is what lets `lineage_chain` walk a rotated card as one chain and what distinguishes a rotation from a rewind. Callsign, ink, and the lineage head all follow from this without arc-specific code. **(verified)**

**[F04] The plan-devise gate is the pre-conductor workaround.** `tugplug/skills/plan-devise/SKILL.md` §5 branches on the running model: on Opus it reviews inline, otherwise it stops and prints the chip, and its guardrail reads "Never switch the user's model, in either direction." That guardrail was written when nothing could switch a model safely; the arc's [P15] — stages pick their model and the card returns to the user's — is the answer it lacked. **(verified)**

**[F05] The vocabulary is half there.** `stage`, `rotate`, `lineage`, and `ArcStage` are established in code and in `tuglaws/dash-lifecycle.md`; `arc` names the dash's document-driven schedule. There is no noun for the layer that performs a rotation, so its doctrine has nowhere to live and its callers have nothing to name. "Supervisor" is taken by `agent_supervisor.rs`, which owns process liveness rather than scheduling; "pilot" is taken by `join_pilot`. **(verified)**

**[F06] The four defects the streamline-dash-workflow audit found were all in the seam between the arc and the layer** — the resume that wrote nothing, the lineage lookup on the wrong row, the startup sweep reading "not spawned yet" as "gone", and the done-count edge consumed by a mid-turn waker. Each was a place where the arc reached into tugcast's session state directly. This is inference from the audit rather than a measurement, but it is the argument that a defined boundary would have made those bugs either impossible or test-visible.

---

## Decisions {#decisions}

**[B01] The layer is called the conductor.** A conductor does not play; it decides who plays next, on what cue, and holds the whole piece in view while any one player sees only their part. That is the relationship exactly: the conductor never writes a line of code, it decides which claude session is seated and hands it the score. The name is unused anywhere in the tree, it does not collide with `agent_supervisor` (liveness) or `join_pilot` (the join arc), and it sits comfortably beside the musical register of the theme names. It rules out "supervisor", "pilot", "helm", "warden", and "steward" (see Non-goals).

**[B02] The conductor's verbs are the ones the code already has: it seats a session, rotates to the next stage, and holds the lineage.** No new vocabulary for the operation. `stage` remains a fork with no fork point [F03]; `rotate` remains the act; `lineage` remains the chain. `arc` stays the name of the *dash's* score — the document-driven schedule — and is not the name of the layer, so a future score that is not a dash does not inherit the word.

**[B03] The CLI verb is `tugutil session rotate`, not `tugutil conductor rotate`.** It is the session that rotates; the conductor is who does it. The verb runs from inside a turn and asks for a rotation at that turn's end, exactly as the arc's first rotation lands at the requesting turn's end ([P05] of the streamline plan) — a rotation mid-turn would kill the claude that asked for it.

**[B04] A skill may choose the model.** The user's call, made 2026-08-25. The `plan-devise` guardrail "never switch the user's model" is retired by this decision; what replaces it is [P15]'s invariant — a rotation names the model for *its* stage, and the card returns to the user's own model when the score ends or the user takes the card back. A skill that picks a model is not switching the user's model; it is asking the conductor to seat a stage on one.

**[B05] What a rotation carries is three kinds of thing, and only one kind is a parameter.** *Invariants*, never parameters, because they are what makes it a rotation rather than a new card: the card, the tug session id, the transcript and its ink, the lineage chain, and the user's model to return to. *Parameters*, which a score legitimately varies per stage and which the verb takes flags for: model, prompt, stage label, effort, and the score that is driving (today `TUG_DASH_ARC`, more generally "the document the conductor answers to"). *Always dropped*: context — a fresh claude session is the point, and a caller who wants context carried is asking for `/compact`, not a rotation. The parameter set is open to growth; the invariant floor is written down so nobody parameterizes it later.

**[B06] The arc becomes the conductor's first client, not its owner.** `rotate` and `drive_stage` move out of `dash_arc_runner.rs` into a conductor module; the runner constructs a rotation request and hands it over. The arc keeps everything that is about *deciding* — the pure predicate in `dash_arc.rs`, the document facts, the in-flight guard — and gives up everything that is about *doing*. The boundary the audit found bugs across [F06] becomes a typed interface with its own tests.

**[B07] The conductor has three faces, all landing together.** A tugcast op (`session_rotate`, beside `arc_run`) so the deck or any in-process client can request one; the `tugutil session rotate` verb so a skill can request one from inside a turn; and `tuglaws/conductor.md` stating what the conductor is, the three kinds of carried thing [B05], and the turn-end placement [B03]. A primitive with a verb and no doctrine is one the model will misuse; one with doctrine and no verb is one it cannot use.

**[B08] `plan-devise` is the first non-arc score.** Its §5 fork becomes: finish the plan, then `tugutil session rotate --model <review model> --stage review --prompt "/tugplug:plan-review <path>"`. The review lands as its own visible turn on its own model with no click. This is the acceptance test for the whole brief: if the conductor cannot carry that one hand-off cleanly, it has not been extracted.

---

## Open Questions {#open-questions}

- **Where does the review model come from when a skill asks for "the review model"?** The arc reads per-stage models from dash config (`stage_model(&reading.config, …)`). A non-arc score has no dash. Either the verb always takes an explicit `--model`, or `.tugtool/config.toml` grows a small roles table (`review = "opus"`) the skill resolves through. The devise round settles this by reading `DashConfig` and deciding whether roles belong beside the stage models or are the same table.
- **What does the verb print, and what does the user see on the card at the moment of the ask?** A rotation requested mid-turn is a promise about the turn's end. The card should say so — a rotation that silently happens when the turn ends is a [L31] silence. Settle whether the receipt is a `TUG-…-RECEIPT` line only, or also a divider-shaped note the deck renders ahead of the `session_stage` frame.
- **Should a rotation request be cancellable before the turn ends?** The user might see "will rotate to opus at turn end" and want to stop it. Probably a second verb or a `--cancel`; the devise round decides after reading how the arc's `stop` path works.

---

## Non-goals {#non-goals}

- **Renaming `tugutil` to `tug`.** It collides with Tug.app's `Tug` executable on the case-insensitive macOS filesystem; it was tried and rolled back. Cohesion comes from grouping under `tugutil`, never from a new top-level name.
- **"Supervisor", "pilot", "helm", "warden", "steward" as the layer's name.** The first two are taken by modules with narrower meanings and reusing them would blur those; the rest read as custodial or as the user steering, when the point is that the layer steers between the user's gestures.
- **Carrying context across a rotation.** A rotation is a fresh claude session by definition [B05]. Context continuity is `/compact`'s job.
- **Rotating mid-turn.** Never; the requesting claude would be killed by its own request [B03].
- **A general multi-card orchestrator.** The conductor seats sessions under *one* card. Fanning work across cards is a different feature and a different brief.
- **Rewriting the arc's decision logic.** `dash_arc.rs` stays as it is; only the act moves [B06].

---

## Exit {#exit}

**A plan**, at `dash/conductor.md`. Its shape:

1. Extract the act: move `rotate`, `drive_stage`, `StageSpec`, and the identity-transfer plumbing into `tugcast/src/conductor/`, behind a `RotationRequest` type carrying exactly [B05]'s parameters; the arc runner becomes a caller. Every existing arc test still passes unchanged — that is the checkpoint that proves nothing but the seam moved.
2. Add the `session_rotate` op and the `tugutil session rotate` verb, with the turn-end placement and a visible receipt.
3. Write `tuglaws/conductor.md` and register it in `tuglaws/INDEX.md`; update `dash-lifecycle.md` to cite the conductor for what a stage is.
4. Convert `plan-devise` §5 to the verb [B08], retire the model guardrail [B04], and update `plan-review`'s hand-off text to match.
5. Cover it: a Rust test that a `RotationRequest` cannot be built without the invariant floor; an app-test that `tugutil session rotate` from a turn produces the `session_stage` divider at that turn's end on the named model.

The phase boundary is the plan-devise conversion: once one non-arc score works, the second brief in this series (interruption doctrine) can assume the conductor exists.

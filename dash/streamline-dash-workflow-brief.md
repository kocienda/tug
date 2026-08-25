# Streamline the dash workflow: one gesture from conversation to "all done"

**Purpose:** Starting a dash is six hand-driven steps after the conversation ends — devise, compact, review, compact, commit the plan, implement — and the user is the pipeline runner. Collapse that to one gesture, `/dash`, with the whole arc unfolding in the one Session card it was typed into.

---

## Purpose {#purpose}

In the user's words:

> I still drive a multi-step process to start dashes, and it remains a serious burden to understand all the steps: conversation/proposal round or rounds inline in a session; brief or spike (sometimes); often a compact; `/tugplug:plan-devise`; usually a compact; `/tugplug:plan-review`; usually a compact; commit the plan; `/tugplug:dash-implement`. I want to know how we can make this simpler, and automated once I get to the plan-devise step. If the workflow needs my involvement, the model can ask me a question, but once I say make a plan, the next thing I must hear back from the system is: "all done!"

And the gesture it must become:

> The slash command must become `dash` all by itself. My vision: I have a conversation, we work out some details, maybe write a brief or a spike, and then I say: `/dash` on this.

And the constraint on where it happens:

> It really is not a maybe/awesome proposition here — we **must** make all this dash arc happen in a single card.

The conversation stays where it is. The burden starts at "make a plan," and that is where the automation starts.

---

## Evidence {#evidence}

**[F01] Each of the six steps exists for one of three reasons, and only one of the three is load-bearing.** The three compacts exist because devise, review, and implement each fill a context and one session cannot hold all three (context pressure). The review chip exists because the review is meant to run on a different model than the deviser and nothing may switch the user's model for them — `tugdeck/src/lib/plan-review.ts` documents that an earlier auto-chain was retired for exactly this reason (model choice). Committing the plan on `main` exists out of habit from before adoption: `tugutil dash create --plan` commits the plan on the dash branch and cleans the base copy ([D139]), so the join brings the plan back to `main` regardless (historical). **(verified)** — read out of `plan-review.ts`, `tugplug/skills/dash-implement/SKILL.md` §1.2, and `tugutil dash adopt-plan --help`.

**[F02] The two load-bearing reasons share one root: the running model cannot drive its own arc.** A model cannot survive its own compaction cleanly, cannot switch itself to the review model, and cannot start the fresh session the next stage needs. Every skill therefore ends on a chip for the user to click — `plan-devise` §5, `plan-review` §7 — which is the burden in [Purpose](#purpose). **(verified)** — the skill texts say so in as many words.

**[F03] The plan doctrine already demands the property a stage-per-session runner needs.** `plan-devise` §"The plan must stand alone": *"assume the session that implements the plan is not this one — a fresh session with none of your investigation context."* `dash-implement` resumes from the Step Status Ledger at the first row not `done`, and takes a `Steps N-M` selector. A runner that starts a fresh session per stage — and, on a long implement, per step range — is taking a rule the documents already obey and making it the mechanism. **(verified)**

**[F04] Every stage boundary is already a machine-readable fact in a document, never a judgment about prose.** `tugutil plan lint` exits 0/1/2; `tugutil plan status --json` reports `review: reviewed | stale | never-reviewed` plus the last round's date and model; the ledger's rows carry `pending | in progress | done`; `DashDetail.join_ready` is derived by `tugdash_core` from the declared step selection reaching its final step ([D147]). A runner can decide "review is clean → implement" and "final step done → arm the join" without reading a word the model wrote. **(verified)** — `tugrust/crates/tugcast/src/feeds/join_pilot.rs` header, `tugutil plan status`.

**[F05] The server already runs a multi-turn model session on a dash and escalates questions to the user.** The join resolver (`tugcast/src/feeds/join_resolver.rs`) spawns a headless multi-turn `claude` under the Spec S04 turn protocol, with a tool allowlist, a `const` charter, and a `ResolverAsk` (2–4 options, raised as a question frame on the bound card's join face). The join pilot dispatches it from the changeset recompute under an occupancy guard, with an attempt mark to stop a re-kick. That is a server-driven stage with user escalation, already shipped. **(verified)**

**[F06] A Session card is bound to a tugcode process, and claude sessions rotate underneath it as first-class commands.** `tugcode/src/session.ts` `handleSessionCommand` takes `new` (kill claude, mint a fresh id, spawn with empty history, announce `session_init`), `continue` (respawn with `--continue`), and `fork` (write a truncated copy under a new id, announce `session_fork {parent, new, forkPoint}`, respawn). `handleModelChange` sends a live `set_model` control request into the running claude; a prompt is a CODE_INPUT frame. Across every rotation the card stays bound to the same tug session — `agent_supervisor.rs`'s `resolve_to_lineage_head` exists because "the deck stays bound to the superseded parent", and tugcast names forks `<root>-<Letter><Number>` in the session ledger. So "one card, several claude sessions in sequence" is what the card does today on `/new`; nothing rebinds. **(verified)**

**[F07] Every session command and prompt tugcode receives today originates at the deck; tugcast only relays.** The runner needs to *originate* three frames on the card's CODE_INPUT path — a session command, a `set_model`, a prompt — rather than relay them from a WebSocket client. That is the whole of the new primitive: no server-initiated spawn, no headless worker, no card rebinding. The join resolver's headless spawn ([F05]) is the precedent for a server-driven stage with escalation, but not the substrate — a stage is an ordinary, visible tugcode session. **(verified)** — `agent_supervisor.rs` `handle_control` / `CODE_INPUT` dispatcher, `tugcode/src/session.ts:7977`.

**[F08] `SharedAgent` is not the substrate.** It is a pool of workers operated against a fixed job table with no API accepting an arbitrary prompt ([P01] in `shared_agent.rs`), recycled every 40 turns, and its turns are self-contained by design. A devise or implement stage is the opposite on every axis: one long conversation, tool-rich, transcript-visible. **(verified)**

**[F09] `/dash` is today a pass-through to the `tugplug:dash` orchestrator skill, whose first stage is Orient.** `slash-commands.ts` deliberately lists no local `/dash`; the skill's Orient reads `docs-dir`, `dash status`, `dash list`, globs the docs dir for a reviewed-but-unadopted plan, and treats a lone argument naming an existing dash as a continuation. Its Sharpen stage is the conversation. So the entry point the user wants already has the right first act; what it lacks is a way to *hand off* rather than *carry on*. **(verified)** — `tugplug/skills/dash/SKILL.md`.

**[F10] What a person sees of a dash is already the arc's position.** The Z2 DASH cell shows the stage glyph and `i/N`; its placard shows the plan's ledger (shipped this week); the Lens Dashes row shows the same meta line; the Changes shade shows the bound dash and its join register; the join arms itself and the shade summons itself ([D147], [D152]). A runner adds no new "progress UI" — it advances the facts those surfaces already read. **(verified)**

**[F11] The config surface for per-project machine declarations exists.** `[tugtool.dash]` in `.tugtool/config.toml` already carries `post_create`, `verify`, `build`, and the docs dir, parsed by `tugutil-core/src/config.rs` and reported by `tugutil dash config --json`. Per-stage model declarations belong beside them. **(verified)**

---

## Decisions {#decisions}

**[B01] The gesture is bare `/dash`, typed in the conversation session, and it means "take this from here."** The conversation — proposal rounds, a brief, a spike — stays in the user's ordinary session on the user's model. `/dash` is the hand-off. With an argument it still works as today (an idea, a name, a plan path); bare, it reads the conversation's product — the brief or plan the session just wrote, else the idea under discussion — and starts the arc on it. Orient stays the first act ([F09]): a reviewed-but-unadopted plan or an existing dash named in the conversation is a continuation, not a new arc.

**[B02] The arc is driven by the server, not by any model.** `tugcast` owns an **arc record** per dash — which stage it is in, which session is working it, what it is waiting on — and advances it by reading documents ([F04]), never by parsing a stage's prose. The model that types `/dash` does one thing to start it: a `tugutil dash run` verb that writes the arc record (or the deck's `/dash` route sends the equivalent control frame); after that the running model's session is done with the arc and the server is the runner. This is the only place the two walls in [F02] do not exist.

**[B03] Every stage is a fresh claude session, rotated under the card's own tugcode.** Devise, review, and implement each start an empty claude session with the stage's skill as its opening prompt and the arc's inputs (brief path, plan path, step range) in that prompt. No compacts, because no session carries two stages. The devise→review hop is fresh by decision: the review is meant to be a cold read, and a cold session is the honest way to get one. Devise and review run in the base checkout, where a plan is written today; implement runs in the dash worktree the plan is adopted into. On a long implement the runner rotates per step range (`dash-implement <plan> Steps N-M`, [F03], [B15]) — the ledger is the resume point either way.

**[B04] Stage models are project config, and the user's card model is never touched.** `[tugtool.dash]` gains `devise_model`, `review_model`, `implement_model` ([F11]), each a model selector; unset falls back to the account default. The rule that nothing switches the user's model stays exactly true — the runner chooses models for sessions it started, which were never the user's. `dev.plan-review-last` and the "review on whatever is selected" contract survive for the hand-driven `/plan-review`, which stays independently invocable.

**[B05] The whole arc happens in the one card `/dash` was typed into, because each stage is a claude session rotated under that card's own tugcode.** A stage is three frames tugcast sends to the card's tugcode ([F06], [F07]): a session command that starts an empty claude session, `set_model` to the stage's declared model, and the stage's opening prompt. The card never rebinds and nothing is headless: the user sees what they see today after typing `/new` and a slash command, except that tugcast typed it. Stages are announced as **lineage**, not strangers — a `session_stage` announcement (the `session_fork` shape with no fork point and no copied history) so tugcast names them `<root>-A1/A2/A3` against the arc's parent and the session ledger, the Lens Sessions list, and the ink store all know the stages are one line of work. The card's own `/new`, `/continue`, and model picker are untouched; the Z-cell shows the stage's model because it reads back what claude reports, and after the arc the next `/new` is the user's again.

**[B13] The arc is one transcript in one card, with a divider at each stage — never a switch, never a truncation, never "look in the Lens for the rest."** The magic is the indirection tugcast already provides: the card holds one tug session, claude sessions rotate beneath it, and the card smooshes them into one scroll. Live, this is already true: `handleSessionInit` in `code-session-store/reducer.ts` does not clear the transcript (its one mutation is stale-marking the jobs ledger), so a stage started under the card's tugcode appends to the scroll the conversation was already in **(verified)**. What has to be built is the other two-thirds: a **stage divider row** synthesized from the `session_stage` announcement (stage name, model, plan path) so the seam is a heading rather than a silent join; and a **lineage-aware restore** — `tugcode/src/replay.ts` replays one JSONL, the `resumeSessionId`'s, so a relaunched card must replay the arc's lineage in order (conversation → devise → review → implement) with the dividers re-synthesized at each boundary. Durable ink is already keyed to the lineage head (`resolve_ink_session`), so receipts written during any stage restore into the same scroll. The minimum form — transcript switches on each stage, earlier stages a click away in the Lens — was considered and rejected: it breaks the conversational flow the gesture exists to preserve.

**[B06] The user is asked only at real decision points, and always on the card.** A stage's `AskUserQuestion` is a native control-request on the arc's card, exactly as today; the arc pauses on it and resumes on the answer. The never-ask boundary in `tuglaws/dash-work-doctrine.md` §"What never gets asked" governs every stage. The runner itself never asks — it has no judgment to exercise, only facts to read ([F04]).

**[B07] Stage transitions are document facts.** Devise → review when `plan lint` exits 0 and the plan file exists. Review → implement when `plan status` reports `reviewed`. Review → review again when the round left the plan `stale` (its fixups changed the document) — **capped at one further round**; on the cap the arc proceeds to implement with a note, since a plan a second review could not settle is a plan the implement gate ([`dash-implement` §1.3]) will ask about anyway. Implement → done when the run's final declared step is `done` — the same fact that arms the join ([F04]).

**[B08] Committing the plan on `main` is retired from the sequence.** Adoption is the commit ([F01]). Nothing in the arc commits to `main`; landing stays the user's act.

**[B09] "All done" is the join offer, plus one receipt.** The arc's terminal state is the fact the join pilot already reads: final step done → join armed → Changes shade summoned on the card with the draft. The runner adds one visible receipt on the card — the arc's summary (stages, sessions, where the plan is, what to look at) — and stops. It does not print a `/join` chip ([D147], [D152]). A build is offered where the project declares one, as `dash-implement` §3 already does.

**[B10] A stage that fails stops the arc visibly, in place.** A stage session that exits red — lint that will not go clean, a checkpoint that will not pass, a rotation tugcode refuses — leaves the arc record in a `stopped` state naming the stage and the reason, on the card and in the Lens row. The user resumes it with `/dash` (Orient finds the stopped arc and continues it from the stage it stopped at — decided, not optional: a stopped arc is a resumable one). The arc never silently retries a stage and never restarts from the top: the documents hold the progress.

**[B11] The existing skills stay the stage contracts; only their endings change.** `plan-devise`, `plan-review`, `dash-implement` remain independently invocable, and each is the opening prompt of its stage unchanged. Under an arc (one env var on the stage's claude, set at rotation), each stops at its natural end — a written plan, a stamped review, a closed ledger — instead of printing a chip or reviewing inline on Opus. No skill learns to sequence; the server does.

**[B12] The Lens Dashes cleanup lands as its own work.** The section's fate — no verbs, no `+`, no sheet, no ⋯, no third line, no age, plan rows that open their document — is decided and is the previous proposal's; it is not folded in here. Its one dependency on this brief is that the start sheet's removal leaves `/dash` as the only kick-off, which [B01] makes true.

**[B14] The arc always starts from a document, and `/dash` stays interactive until there is one.** On a bare `/dash`, Orient looks for the conversation's product — a brief or plan this session wrote, found through the docs dir and the session's own attribution in `tugutil changes` — and hands the arc that path. When the session wrote nothing, `tugplug:dash`'s Sharpen stage writes the brief *in the conversation session*, on the user's model, as an ordinary interactive turn the user can still shape; only then does the hand-off happen. The devise stage therefore never starts from an idea string or from a transcript it cannot read — it starts from a document the user saw. Intent to dash is the start of a conversation that ends in a document, not a trigger that skips one.

**[B15] The implement stage rotates only at step boundaries, on a measured context reading, never mid-step.** tugcode already emits `context_breakdown` frames and tugcast records the latest per session (`record_context_breakdown` in `agent_supervisor.rs`), so the runner has a measurement rather than a guess. When a step goes `done` — the ledger fact the runner already reads ([B07]) — it checks the session's latest context reading; above `[tugtool.dash].implement_rotate_at` (default `0.6` of the window) it rotates: the same three frames as any stage, opening prompt `/tugplug:dash-implement <plan> Steps N-M` from the ledger's first non-`done` row, and a divider reading "implement, continued · steps N–M" ([B13]). A step that blows the window mid-flight is the model's to survive by auto-compact, exactly as today; the runner never interrupts a step. One-session-per-step (maximal cold re-reading) and a fixed steps-per-session count (a number standing in for a measurement that exists) were both rejected.

**[B16] The arc record is dash-log lines, keyed by the dash's name from the moment `/dash` hands off — before any branch exists.** The dash-log (`tugdash-core/src/dash.rs`, `dash-log.md` under `project_state_dir`) is per-project state outside git, append-only, keyed by dash name, and already the one reader tugcast's recompute walks for `mark`, steps, and replays; a git-scoped record was rejected because the devise and review stages run before there is a branch to hang it on. The name is chosen at hand-off (Orient/Sharpen already settle it; `dash-implement` derives the same slug from the plan and `create` is idempotent on it), so the arc's `stage` lines and the dash's later `step` lines are one record under one key. The devise and review stages run in the base checkout, where the plan is written to the docs dir today; the dash comes into being at implement, exactly as now, and adopts the plan ([B08]). A restart of tugcast re-reads the log and resumes the arc from its last recorded stage ([B10]).

---

## Open Questions {#open-questions}

None. Every question this brief opened was settled in conversation and recorded as a decision above.

---

## Non-goals {#non-goals}

- **A graphical kick-off on the Session card or the Lens.** Decided against for now: too much of dash is still moving. `/dash` in the composer is the door; when things settle, a UI location may be found. The Lens start sheet is removed under [B12], not replaced.
- **A one-liner form.** The "Start a dash" sheet's `Name / What is the work?` shape is exactly what the user does not want; a dash starts from a conversation, and the conversation is not a field.
- **Sub-agents, swarms, or the Workflow tool as the runner.** The lane is agentless by charter (`dash-work-doctrine.md` §"No sub-agents"); a stage is one thread holding the context, and the runner is not a model at all ([B02]).
- **`SharedAgent` as the stage substrate.** Wrong on every axis ([F08]).
- **Headless stages.** The join resolver runs headless because its job is small and its output is a report; a devise or implement stage is hours of work the user must be able to read and interrupt. Every stage is a real card-visible session ([B05]).
- **Automating the join.** Landing stays the user's act, unchanged.
- **Retiring the hand-driven skills.** `/tugplug:plan-devise`, `/plan-review`, `/tugplug:dash-implement` stay as the expert path ([B11]).

---

## Exit {#exit}

**A plan.** Its phase boundary is the server-side runner, and its first steps are the ones nothing else can proceed without:

1. The arc record as dash-log lines and the `tugutil dash run` verb — what a stage is, what advances it ([B07], [B15]), keyed by name from the hand-off ([B16]).
2. tugcast originating a stage on a card's own tugcode — session command, `set_model`, opening prompt — plus the `session_stage` lineage announcement ([B05]); the one genuinely new primitive ([F07]).
3. `[tugtool.dash]` stage models ([B04]) and the under-arc env var the skills read ([B11]).
4. The stage drivers: devise → review (one further round at most) → implement (rotating at step boundaries, [B15]), each a rotation plus a document read.
5. The stage divider row and the lineage-aware restore — one transcript in one card ([B13]) — plus the arc's card receipt and stopped-state faces ([B09], [B10]) on the Z2 cell, the placard, the Lens row.
6. `tugplug:dash`'s hand-off: bare `/dash` reads the conversation's product and runs the verb ([B01]).

The Lens Dashes cleanup ([B12]) is a sibling plan that can run first or in parallel; it shares no code with this one.

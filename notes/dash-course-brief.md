<!-- brief-skeleton v1 -->

# Two courses on one wheel

**Purpose:** `/dash` and `/dash-plan` were built on the wrong axis — wheel-driven vs. worked in-thread — and the in-thread half produced a 660k-token unsupervised turn. The real axis is settling time: every dash runs under the Wheel, both doors open on a brief, and `/dash-plan` differs from `/dash` only by spending extra time up front — devising and cold-reviewing a plan before any step is walked.

---

## Purpose {#purpose}

The two dash doors were interpreted as a routing between *who drives*: `/dash-plan` hands to the arc, `/dash` works in the invoking conversation with no wheel, no compaction, no rotation, and no cold reader. The user's intended model, restated and confirmed on 2026-08-31:

- **`/dash`** runs under the Wheel. A conforming brief (per `tuglaws/brief-skeleton.md`) is used if provided; otherwise the dash generates one from a prompt, the session conversation, or other documents including source files. The Wheel generates steps from the brief — the task list every dash face counts from — then implements each step in turn, compacting as necessary after each step completes. A review after the work checks the code actually written against the steps, the brief, and the user's stated intent; fixups are applied; the dash is written up and offered as a join.
- **`/dash-plan`** is the same course with extra settling: from the brief the Wheel *devises a plan* conforming to `tuglaws/devise-skeleton.md`, the plan is *reviewed cold* for correctness and completeness with fixups applied, and the task list comes from the plan's own ledger. Implement, review-after-work, fixups, write-up, and the join offer are identical to `/dash`.

The full survey of what the wrong axis produced is `notes/dash-wheel-retrenchment.md`; the settled shape is `notes/dash-course-proposal.md`. This brief carries what a devise round needs from both.

---

## Evidence {#evidence}

**[F01] The wrong axis is written down in five places across four documents, each as a deliberate design with a reason attached.** `tuglaws/dash-work-doctrine.md:112`–`:114` (the two-mode split: turn-per-step under an arc, walk-everything-in-one-turn without one) and `:229` (*No sub-agents* forbids the wheel's model outright); `tugplug/skills/dash/SKILL.md` frontmatter, `:12`, `:96` (the skill describes itself as the in-thread worker, "no arc"); `tugplug/skills/dash-implement/SKILL.md:72` and `tugplug/skills/dash-review/SKILL.md:110`–`:128` (off-arc branches keyed on `printenv TUG_DASH_ARC`); `tuglaws/wheel.md:120` (the course generalization explicitly deferred). **(verified — read from the tree)**

**[F02] One run under the current rules produced the failure the retrenchment records.** `/tugplug:dash lens-breakout` walked steps 1–3 as one unbroken ~660k-token turn with no compaction available to it, executed an arc-sized implement round as step 3 alone (twelve files, six symbol renames, nineteen rewritten app-tests, nine app-test runs to converge), introduced a 4px trailing-padding regression caught only because two app-tests measured it, and had no cold reader at any point. Nothing deviated from the rules; all of it was the rules working. **(verified — recorded in `notes/dash-wheel-retrenchment.md` from the live run)**

**[F03] `tugplug/skills/dash-devise/SKILL.md` already has the correct stage shape.** It refuses to run outside an arc, on the grounds that a plan is ready only when a fresh session has read it cold. It is the model the other stage skills should take. **(verified)**

**[F04] The current `/dash-plan` retired the brief and authors the plan inline.** `tugplug/skills/dash-plan/SKILL.md` has the invoking conversation write the plan itself ("The plan is written here, and there is no brief"), lint it, and hand over so the arc opens at review. The brief-only path — devise → review → implement → audit — survives in the runner as "the older route" for dashes that arrive with only a `brief.md`. The inline-authored plan never gets a cold devise read of the settling. **(verified)**

**[F05] The machinery is smaller than the prose.** `ArcStage` (`tugrust/crates/tugdash-core/src/arc.rs`) already enumerates devise/review/implement/audit with stop reasons including `ReviewDidNotStamp` and `AuditDidNotMark`; the runner is `tugrust/crates/tugcast/src/feeds/dash_arc_runner.rs` (~2.9k lines with tests); the wheel (`tugrust/crates/tugcast/src/wheel/`) carries a course on `RotationRequest` and puts `TUG_DASH_ARC` on the stage wire; the one compaction threshold is `[tugtool.dash].implement_compact_tokens`, default 300000, and applies wherever the implement stage runs. `tugtool dash run <name>` opens at review for a document that lints as a plan and at devise for one that does not. **(verified — read from the crates)**

**[F06] The lens-breakout midpoint landed as `14e9b6b48`; the remainder is owed.** Three of four sidebar cards stand; the Layout card, the persisted-state and factory-deck migrations, the Lens deletion, and the doc/test move were withdrawn from that dash's ledger and await a fresh dash — the natural first passenger for the retrofitted `/dash-plan`. **(verified — joined 2026-08-31)**

---

## Decisions {#decisions}

**[B01] Every dash is run by the Wheel; the doors differ in workflow progression, never in who drives.** There is no such thing as a dash the main conversation works in-thread. Both courses get the wheel's turn-end acts — compaction above the threshold, rotation when compaction cannot bring the context back under it — for free, because those acts are what a course is for. This is the retrenchment's imperative, confirmed by the user.

**[B02] Both doors open on a brief, and the door session's whole job is to produce or accept one.** A document conforming to `tuglaws/brief-skeleton.md` handed in with the invocation is used as-is; otherwise the door generates one from the prompt, the session conversation, or other documents including source files — the sharpening conversation's settled calls land as the brief's `[B##]` decisions and `[F##]` findings, so nothing is lost to the fresh session that reads it cold. The brief is written (or copied) to `.tug/dashes/<name>/brief.md`, the door hands over and ends the turn, and the door never creates a worktree, never writes a plan, never implements. The inline plan authoring in the current `/dash-plan` is deleted, not generalized.

**[B03] The plan course is today's brief-only arc, unchanged: devise → review → implement → audit.** The devise stage authors the plan from the brief against `tuglaws/devise-skeleton.md` and lints it clean; the review stage reads it cold, applies fixups, and stamps. What the current skill calls "the older route" becomes the only route.

**[B04] The dash course is implement → audit, and the task list is the first act of the implement stage's first turn.** Not a separate stage: `/dash`'s economy is its point, the task list is bookkeeping rather than a design artifact wanting a cold read, and `/dash`'s cold read is the audit at the end. The task list keeps its current minimal shape — an `{#execution-steps}` section over a `{#step-status-ledger}`, parsing for `tugtool dash step`, never linted as a plan. The runner distinguishes the courses by the recorded kind, never by sniffing the document.

**[B05] The stage names `review` (of the plan) and `audit` (of the code) stay distinct.** User-confirmed. Renaming audit to match the user-facing description ("a review after the work") would collide with the plan review and ripple through `ArcStage`, the stop reasons, and every transcript divider for no behavioral gain.

**[B06] The audit is the shared review-after-work for both courses.** It reads the branch's whole diff cold against the steps, the plan when one exists, the brief, and the user's stated intent; fixes what does not match as ordinary rounds; refreshes the join draft; and marks — after which the arc's arming offers the join through the Changes shade exactly as today.

**[B07] `TUG_DASH_ARC` becomes `TUG_DASH_COURSE`; the value stays the dash name; the course kind stays out of the environment.** The stage skills read the variable as "the wheel is driving this dash." The one behavioral fork — does implement author the task list first? — is answered by the documents and the course record (a dash with a plan walks it; a dash-course dash with only a brief writes the task list), which is more robust than an environment flag. The kind lives in the course's durable record, where the runner reads it. This is the generalization `tuglaws/wheel.md:120` deferred, now due.

**[B08] `tugtool dash run <name>` grows `--course dash|plan`, defaulting to `plan`.** The default reproduces today's derivation (plan document → open at review, brief only → open at devise), so every existing dash resumes unchanged and the dash course is reachable only by asking for it.

**[B09] Implement closes one step per turn under both courses, and the off-arc second discipline is deleted.** `tuglaws/dash-work-doctrine.md:112`'s turn-end reasoning survives — the wheel acts only between turns, so a step boundary must be a turn boundary, and `--through` names the run's declared end throughout. The second paragraph (`:114`, the walk-everything-in-one-turn rule for wheelless runs) goes, because its premise — a dash with no wheel — no longer exists. *No sub-agents* (`:229`) is rewritten to preserve its intent: the user stays in a tight loop with one thread holding the context, and under the wheel that intent is served by rotation onto sessions that read the documents cold, not by refusing to rotate.

**[B10] The ten-step guardrail survives only as a door-time advisory.** Under the wheel, step count is no longer a proxy for "too big for one turn." A `/dash` door whose brief reads plan-shaped — many interdependent parts, order itself a problem — says so in a sentence and offers `/dash-plan`, then does what the user says. Nothing asks mid-run; the doctrine's never-ask list stands.

**[B11] All four stage skills take `dash-devise`'s shape: stages of a course that refuse to run outside one.** The off-arc branches in `dash-implement` and `dash-review` are dropped, and the hand-typed spellings stop being supported doors — user's call, 2026-08-31: they are internal machinery, parts of a larger workflow. A user can still dig in and invoke a skill manually; nothing prevents that, and nothing goes out of its way to support it. The refusal each stage prints when run outside a course — saying what it is a stage of and which door starts one — is the whole of the accommodation.

**[B12] No new configuration.** `implement_compact_tokens` and the per-stage model declarations apply to both courses as-is: a dash course's implement stage runs on the implement model, its audit on the audit model.

---

## Open Questions {#open-questions}

None. The last one — what the hand-typed stage spellings become — was settled by the user as [B11]: they stop being supported doors.

---

## Non-goals {#non-goals}

- **Supporting hand-typed `/tugplug:dash-implement` and `/tugplug:dash-review` as standalone tools.** Rejected by the user: they are internal machinery. No one-stage course is built for them, and their doctrine mentions as "the expert path" (`tuglaws/dash-work-doctrine.md:5`, `tugplug/CLAUDE.md`) come out with the rewrite ([B11]).

- **A separate `steps` stage for the dash course.** Rejected: it buys a cold read of the brief at the cost of a rotation, and if the brief is subtle enough for that to matter, the work wanted `/dash-plan`. The task list is the implement stage's first act ([B04]).
- **Renaming the `audit` stage to `review`.** Rejected: collides with the plan review and ripples through the enum, the stop reasons, and the dividers ([B05]).
- **A course-kind environment variable.** Rejected: the documents and the course record answer the fork more robustly ([B07]).
- **Resuming lens-breakout's remainder under the old rules.** Rejected: the midpoint landed as `14e9b6b48`; the remainder waits for the retrofit and runs as a fresh `/dash-plan` course — its first real passenger.
- **Preserving the inline-plan-authoring route as an option.** Rejected: it is the misinterpretation this work exists to remove, and keeping it as a third path would keep the second discipline alive under a new name.

---

## Exit {#exit}

**A plan**, devised from this brief under the current machinery (`tugtool dash run` on a brief-only dash opens at devise — the existing route carries its own retrofit). The phase boundary is machinery before prose, because the skills describe what the machinery does: first the core — the course kind in `tugrust/crates/tugdash-core/src/arc.rs`, the per-kind progression in `tugrust/crates/tugcast/src/feeds/dash_arc_runner.rs`, the `--course` flag, the `TUG_DASH_COURSE` rename through `tugrust/crates/tugcast/src/wheel/` and the stage wire — then the documents: full rewrites of `tugplug/skills/dash/SKILL.md` and `tugplug/skills/dash-plan/SKILL.md` as doors, the off-arc branches out of `tugplug/skills/dash-implement/SKILL.md` and `tugplug/skills/dash-review/SKILL.md`, and the corrections to `tuglaws/dash-work-doctrine.md`, `tuglaws/wheel.md`, and `tugplug/CLAUDE.md`. The standalone contract holds throughout: nothing Tug-specific enters the plugin, and `just tugplug-lint` and `just test-standalone` are the guards.

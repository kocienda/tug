# Two courses on one wheel: the `/dash` and `/dash-plan` retrofit

**Status:** proposal, the "next conversation" that `notes/dash-wheel-retrenchment.md` promised. It answers that note's five questions and lays out the change. Not yet a brief or a plan — the shape wants agreement first.

---

## The corrected model {#model}

Both doors run under the Wheel. Both open on a **brief**. They differ only in how much settling happens between the brief and the first line of implementation:

- **`/dash`** — brief → steps → implement → review-after-work → fixups → write-up, join offered.
- **`/dash-plan`** — brief → devise a plan (`tuglaws/devise-skeleton.md`) → plan review, cold, fixups applied → steps from the plan's ledger → implement → review-after-work → fixups → write-up, join offered.

`/dash-plan` is `/dash` plus extra time up front: the devise stage and the cold plan review. Everything downstream of the ledger — one step per turn, compaction between steps, the post-work review of the code against the steps, the brief, and the user's stated intent — is identical in the two courses.

**The brief is the shared entry artifact.** The invoking conversation's job, at either door, is to produce or accept one:

- A document conforming to `tuglaws/brief-skeleton.md` handed in with the invocation is used as-is.
- Otherwise the door session generates one — from the prompt, from the session conversation, or from other documents including source files — and this is where the sharpening conversation's richness lands: the settled calls become `[B##]` decisions, the observations become `[F##]` findings, so nothing the conversation decided is lost to the fresh session that reads the brief cold.

Either way the brief is written (or copied) to the dash's own address, `.tug/dashes/<name>/brief.md`, because the name is the address on every verb. Then the door hands over — `tugtool dash run <name> --course …` — and ends the turn, which is the hand-off. The door session never creates a worktree, never writes a plan, never implements.

This reverses one decision now standing in `tugplug/skills/dash-plan/SKILL.md` ("The plan is written here, and there is no brief"). That design had the invoking conversation author the plan inline so the arc could open at review. Under this proposal the plan course is exactly today's *brief-only* arc — devise → review → implement → audit — which the current skill calls "the older route". The older route was the right one; the brief carries the conversation's settling forward, and the devise stage reads it cold, which the inline-authored plan never got.

---

## The retrenchment questions, answered {#answers}

**1. What is `/dash`'s progression?** Steps → implement → review-after-work. The task list is the **first act of the implement stage's first turn**, not a stage of its own: `/dash`'s economy is its point, the task list is bookkeeping rather than a design artifact wanting a cold read, and `/dash`'s cold read is the review-after-work at the end. (The alternative — a separate `steps` stage on its own rotation — buys a cold read of the brief at the cost of one more session; if the brief is subtle enough for that to matter, the work wanted `/dash-plan`.)

**2. Does a `/dash` course get a cold review at all?** Yes — the review-after-work, on a fresh session, for both courses. What distinguishes `/dash-plan` is the cold review of the *plan*, before any code exists. `/dash` skips settling-time review, never landed-code review.

**3. What does the environment variable become?** `TUG_DASH_COURSE`, value the dash name — the rename `tuglaws/wheel.md:120` deferred. The stage skills read it as "the wheel is driving this dash"; none needs the course *kind* in the environment, because the one behavioral fork (does implement author the task list first?) is answered more robustly by the documents themselves: a dash with a plan walks it, a dash with only a brief and a `--course dash` record writes the task list. The kind lives in the course's durable record, where the runner reads it.

**4. The lens-breakout dash mid-run** — the user's call; see [below](#lens-breakout).

**5. Does the ten-step guardrail survive?** Not as a veto. Under the wheel, step count stops being a proxy for "too big for one turn" — no run is one turn. It survives as a door-time advisory only: a `/dash` door session whose generated brief reads plan-shaped (many interdependent parts, order itself a problem) says so in a sentence and offers `/dash-plan`, then does what the user says. Nothing asks mid-run; the never-ask list stands.

---

## The stage roster after the change {#stages}

| Stage | Course | What it does | Skill |
|---|---|---|---|
| devise | plan only | Author the plan from the brief, against the devise skeleton, lint clean | `dash-devise` (already correct — the model for the others) |
| review | plan only | Read the plan cold, judge against rubric and real code, apply fixups, stamp | `dash-review`, off-arc branch dropped |
| implement | both | Walk the ledger, one step per turn, compaction between steps; **first turn of a dash course authors the task list from the brief** | `dash-implement`, off-arc branch dropped |
| audit | both | Read the branch's whole diff cold against the steps, the plan (when one exists), the brief, and the stated intent; fix as rounds; refresh the draft; mark | `dash-audit` |

The names `review` (of the plan) and `audit` (of the code) stay distinct even though the user-facing description of audit is "a review after the work" — renaming the stage would collide with the plan review and ripple through `ArcStage`, the stop reasons, and every divider. The write-up is the audit's existing ending: refresh the join draft, `tugtool dash mark <name> audited`, and the arc's arming offers the join through the Changes shade as it does today.

The **task list** a dash course authors keeps its current minimal shape — an `{#execution-steps}` section over a `{#step-status-ledger}`, parsing for `tugtool dash step`, never linted as a plan. The runner distinguishes the courses by the recorded kind, never by sniffing the document, so a task list that happens to lint proves nothing and a plan with a diagnostic sends nobody to the wrong stage.

---

## What the change touches {#work-list}

The retrenchment note's survey, now with decisions attached:

- **`tugrust/crates/tugdash-core/src/arc.rs`** and **`tugrust/crates/tugcast/src/feeds/dash_arc_runner.rs`.** The arc record gains a course kind (`dash` | `plan`); the runner's progression is per-kind. The plan course is today's brief path unchanged. The dash course is new and small: open implement directly (its first prompt says the task list is its first act), then audit. `tugtool dash run <name>` grows `--course`, defaulting to `plan` — today's derivation (plan → review, brief → devise) is the plan course, so existing dashes resume unchanged.
- **`tugrust/crates/tugcast/src/wheel/mod.rs`** and the stage-object wire. `TUG_DASH_ARC` → `TUG_DASH_COURSE`; the `arc` field on the stage object follows. Mechanical, but it is the widening `tuglaws/wheel.md:120` reserved, so that paragraph is rewritten in the same round.
- **`tuglaws/dash-work-doctrine.md`.** The lane preamble at `:5` rewritten — two doors, both handing to the wheel, differing in settling. `:112`–`:114`: keep the turn-end reasoning, delete the off-arc second discipline; the rule becomes simply *a step boundary is a turn boundary, and `--through` names the run's declared end throughout*. `:229` *No sub-agents* rewritten: the intent (one thread holding context, tight user loop) survives; under the wheel it is served by rotation onto sessions that read the documents cold, not by refusing to rotate.
- **`tugplug/skills/dash/SKILL.md`.** Rewritten whole: from "you do the work yourself, in this thread" to a door — orient, accept or generate the brief, write it to the dash address, `tugtool dash run <name> --course dash`, say what happens next, end the turn. The frontmatter description ("no arc") is user-visible and goes first.
- **`tugplug/skills/dash-plan/SKILL.md`.** The inline plan authoring comes out; sharpening ends in a **brief**, not a plan. Orient and Sharpen survive nearly as written; Size-it's advisory inverts (one clear change → offer `/dash`); Hand off writes the brief and runs `--course plan`.
- **`tugplug/skills/dash-implement/SKILL.md`, `dash-review/SKILL.md`.** Off-arc branches dropped; each takes `dash-devise`'s shape — a stage of a course, refusing to run outside one. Whether `/tugplug:dash-implement` typed by hand becomes a course of one stage or stops being a door is the one open sub-question; recommend the former, since the expert path is cheap to keep once a one-stage course exists (`wheel.md` already defines one).
- **`tugplug/CLAUDE.md`.** The dash-family roster paragraph re-stated in the corrected model.
- **`.tugtool/config.toml`.** No new knobs required: `implement_compact_tokens` and the per-stage models apply to both courses as-is. A dash course's implement stage runs on `implement_model`, its audit on the audit model, same as the plan course.

---

## The lens-breakout dash {#lens-breakout}

Steps 1–3 are landed and green; step 4 is open and empty, blocked on the retrenchment. Two honest options:

- **Land the midpoint now** (three cards out, the Lens reduced to one section — the join draft already describes exactly this) and run steps 4–7 as a fresh dash under the new machinery once it exists. Cleanest, and nothing about the midpoint is incoherent.
- **Resume 4–7 by hand first** — `/tugplug:dash-review` then `/tugplug:dash-implement` under today's rules — if waiting on the retrofit is worse than one more old-rules run.

Recommend the first: the retrofit is itself dash-sized work, and lens-breakout's remainder is a natural first passenger for the new `/dash-plan` course.

---

## Provenance {#provenance}

Written to the base checkout, untracked, beside `notes/dash-wheel-retrenchment.md`, for the same reason that note gives: this is about the dash system, not about any dash. Committing it is the user's.

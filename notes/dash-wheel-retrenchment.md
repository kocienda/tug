# Dashes are always run by the Wheel

**Status:** retrenchment note, written mid-run against the `lens-breakout` dash. Records what the rules say today, what that produced, and what has to change. Not a plan — the plan is the next conversation.

---

## The imperative {#imperative}

**Every dash is run by the Wheel.** There is no such thing as a dash the main conversation works in-thread.

`/dash` and `/dash-plan` differ in **workflow progression** — which stages run, in what order, and what each one is handed. They do not differ in *who drives*. Both are courses on the wheel; both seat their stages in sessions the wheel rotates; both get the wheel's turn-end acts (compaction, rotation) for free, because those acts are what a course is for.

The distinction that exists in the tree today — arc-driven vs. "direct", wheel vs. in-thread — is the wrong axis. It was written into the doctrine and into four skills, and it is load-bearing in each of them.

---

## What the rules say today {#today}

The wrong rule is stated in five places, in four documents. Each states it as a *deliberate* design with a reason attached, which is why it survived review.

**[W01] The doctrine splits the lane in two by whether the wheel is driving.** `tuglaws/dash-work-doctrine.md:112` and `:114`:

> **Under an arc, and only under an arc, a step boundary is also a turn boundary.** … the wheel can only act between turns: every act it takes on the seated session — a compaction above `implement_compact_tokens`, and the rotation that follows one the compaction could not bring back under it — is sent at a turn's end …
>
> **With no `TUG_DASH_ARC` in the environment there is no wheel, and nothing will prompt the next step.** That is every direct `/dash` and every `/tugplug:dash-implement` typed by hand. Ending the turn at a step boundary there is not pacing, it is abandonment … **Walk the whole declared range in the one turn.**

The reasoning in the first paragraph is correct and should survive: the wheel acts between turns, so a step boundary must be a turn boundary. The second paragraph is the defect — it takes "no wheel" as a possible state of a dash and writes a whole second discipline for it.

**[W02] The doctrine forbids the wheel's own model outright.** `tuglaws/dash-work-doctrine.md:229`, under the heading *No sub-agents*:

> The worker is the main conversation. Do the work in-thread. The whole point of the agentless model is that the user stays in a tight feedback loop with one thread that holds the context, rather than reviewing the output of a swarm that does not.

This is the passage that most directly contradicts the imperative. It is also the one whose *intent* is worth keeping: the user should stay in a tight loop with a thread that holds context. Under the wheel that intent is served by rotation onto the same or a fresh seated session with the plan as the carried context — not by refusing to rotate.

**[W03] The `/dash` skill describes itself as the worker.** `tugplug/skills/dash/SKILL.md:3` (frontmatter description), `:12`, `:96`:

> This skill runs one **directly**: **you — the main conversation — do the work yourself**, in this thread …
>
> **Walk the whole list in this turn, and do not end the turn before the step named by `--through` is `done` or `withdrawn`.** A direct dash has no arc behind it: nothing prompts the next step …

**[W04] The stage skills each carry an off-arc branch.** `tugplug/skills/dash-implement/SKILL.md:72` states the same two-mode rule; `tugplug/skills/dash-review/SKILL.md:110`–`:128` branches its ending on `printenv TUG_DASH_ARC`. Only `tugplug/skills/dash-devise/SKILL.md:92` gets it right already — it *refuses* to run off-arc, on the grounds that "the plan is not ready when you finish writing it — it is ready when a fresh session has read it cold, and only the arc opens that session." That refusal is the shape every stage should have.

**[W05] The wheel has one course and no way to name a second.** `tuglaws/wheel.md:120`:

> **The course has no CLI flag yet, and that is deliberate.** `RotationRequest` carries a course and the arc runner fills it, but the verb exposes none. `TUG_DASH_ARC` is read by three skills as "a dash arc is driving you" … Generalizing it is a rename of the environment variable and a widening of what the stage skills read, with its own blast radius. The next course to need one adds the flag together with that widening.

**`/dash` is that next course.** The generalization deferred here is the precondition for the fix, not a follow-on to it.

---

## What the current rules produced, in one run {#what-happened}

`/tugplug:dash lens-breakout` was invoked on `notes/lens-breakout-brief.md` — a brief whose own Exit section says "A direct `/dash`". Following the rules above:

- The task list came out at **seven steps**. The `/dash` skill's guardrail fires at ten ("the work wanted `/dash-plan`"), so seven read as in-range.
- Steps 1–3 ran as one unbroken turn, as `[W01]`/`[W03]` require. No compaction, no rotation, no cold read of anything — by design, because there was no wheel.
- **Step 3 alone** moved twelve source files, renamed six symbols across the deck (`lensSelectionStore`, `LensCardsGroup`, `LensCardsDataSource`, `resolveLensGroup`, `CardRegistration.lensGroup`, the `lens-cards-*` class and `data-lens-*` attribute families), rewrote nineteen app-tests, retired two, and required nine app-test runs to converge. That is an arc's implement stage executed as a single round in a conversation that had already been running for two other steps.
- A **4px trailing-padding regression** was introduced by the port and caught only because two app-tests measured it. Finding it took a `tugtool file probe` against the pre-step tree to establish the old value. A cold reviewer reading the step's diff would have seen `.lens-cards-list` → `.cards-list` and had the same question in front of them without a live app; a cold *auditor* reading the branch entire is exactly the reader the arc supplies and this run did not have.
- The turn ran to ~660k tokens of context with no checkpoint available to it, because compaction is the wheel's act and is only sent at a turn's end.

Nothing here was a deviation from the rules. All of it was the rules working.

---

## Where the `lens-breakout` dash stands {#dash-state}

Branch `tugdash/lens-breakout`, worktree `/Users/kocienda/Mounts/u/src/tug/.tug/worktrees/lens-breakout`, base `main`. The worktree is clean and every commit is green.

| Step | Title | Status | Commit |
|---|---|---|---|
| 1 | Tripwires becomes a sidebar card | done | `46ce7de88` |
| 2 | Dashes becomes a sidebar card | done | `22c158737` |
| 3 | Cards becomes a sidebar card | done | `5a63181a7` |
| 4 | Layout becomes a sidebar card | **in progress — blocked, no work done** | — |
| 5 | Migrate the persisted state and the factory deck | pending | — |
| 6 | Delete the Lens card and the section machinery | pending | — |
| 7 | Move the docs and the tests | pending | — |

**Step 4 is open and empty.** It was opened with `tugtool dash step … start 4` immediately before the run was halted; not a byte of its work exists. It is left `in progress` rather than withdrawn because `withdraw` means "the work turned out to be unnecessary", which is false — the Layout card is still owed. The named blocker is this document: the run is halted pending the retrenchment, not pending anything in the code.

**What has landed.** Three of the four cards stand as ordinary registered sidebar cards (`tripwires`, `dashes`, `cards`), each with its own componentId, focus group, `toggle-*` wire, Maker menu row and empty state. Three shared modules came out of `lens/` with them: `tugdeck/src/components/tugways/rail-list-presentation.ts`, `tugdeck/src/components/tugways/followed-card.ts`, and `tugdeck/src/components/cards/cards-selection-store.ts`. `CardRegistration.lensGroup` is now `cardsGroup`. The Lens still exists and still hosts the Layout section.

**What is not done.** Steps 4–7: the Layout card, the two migrations of `[B06]`, the factory deck of `[B04]`, deleting the Lens and the section machinery of `[B07]`, and the doc/test move of `[B09]`. A join today would land a coherent midpoint — three cards out, the Lens reduced to one section — but not the brief.

**Verification standing.** Each round: `bunx tsc --noEmit` clean, `bun test` 7808 pass / 0 fail, `bunx vite build`, `bun run scripts/audit-tokens.ts verify`, `just app-test-covers-check`, and the app-tests each round touched. `tests/app-test/at0387-session-identity-menu.test.ts` and `tests/app-test/at0424-lens-dash-line.test.ts` fail identically at the dash base (a session-shell wait, unrelated to this work) and were left as found.

**The join draft is written** and describes the three landed rounds only.

---

## What the fix has to touch {#work-list}

Not a plan — a survey of the blast radius, so the next conversation starts from a known surface.

- **`tuglaws/dash-work-doctrine.md`.** Delete the two-mode split at `:112`–`:114`, keeping the turn-end reasoning and dropping the off-arc discipline. Rewrite *No sub-agents* at `:229` — the intent (one thread holding context, tight user loop) survives; the prohibition does not.
- **`tugplug/skills/dash/SKILL.md`.** Rewritten from "the main conversation does the work" to "this is a course; here is its progression". Its frontmatter `description` is user-visible and says "no arc".
- **`tugplug/skills/dash-implement/SKILL.md`, `dash-review/SKILL.md`.** Drop the off-arc branches; the `/tugplug:dash-implement`-typed-by-hand path either becomes a course of one stage or stops being a door.
- **`tugplug/skills/dash-devise/SKILL.md`.** Already correct — the model for the others.
- **`tuglaws/wheel.md:120`.** The deferred course generalization is now due: `TUG_DASH_ARC` names a *course*, not an arc, and the stage skills read it as such.
- **`tugrust/crates/tugcast/src/wheel/`.** The runner takes a course with a progression rather than the one hard-wired arc.
- **`.tugtool/config.toml`.** `implement_compact_tokens` and the per-stage model knobs are currently arc-shaped; a second progression may want its own.

---

## Questions the next conversation settles {#questions}

1. **What is `/dash`'s progression?** The obvious candidate is task-list → implement → audit — the arc minus brief, devise and cold review. Whether the task list is a stage of its own or the first act of implement is the real question.
2. **Does a `/dash` course get a cold review at all?** `[W04]`'s devise argument ("ready when a fresh session has read it cold") applies to a task list as much as to a plan, but a cold review is most of what distinguishes `/dash-plan`.
3. **What does the environment variable become,** and do the stage skills read a course name or a course *kind*?
4. **What happens to a dash mid-run under the old rules** — this one. Resume steps 4–7 as a `/dash` course, re-plan the remainder under `/dash-plan`, or land the midpoint and open a second dash.
5. **Does the ten-step guardrail survive?** Under the wheel, step count stops being a proxy for "too big for one turn", because no run is one turn any more.

---

## Provenance {#provenance}

Written to the base checkout rather than the dash worktree deliberately: this document is about the dash system, not about `lens-breakout`, and putting it on that branch would land it with that join. It is untracked and intersects none of the dash's paths, so it does not affect the join preflight. Committing it is the user's.

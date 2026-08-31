# One wheel, two doors: the document is the course

**Status:** proposal, second round. The first round of this note proposed a recorded course kind — a `CourseKind` enum on the arc record, a `--course` flag on `tugtool dash run`, a per-kind branch in the progression predicate, a changed implement ask, a new stop reason, and an environment-variable rename. That design was rejected 2026-08-31, and the `dash-courses` plan built on it is discarded with it. This round replaces it. Not yet a brief or a plan — the shape wants agreement first.

---

## What is wanted {#want}

`/dash-plan` already does everything wanted: sharpen, hand to the Wheel, devise → review → implement → audit, one step per turn, compaction between steps, a cold audit at the end, the join offered through the Changes shade. `/dash` needs to use that same machinery in simplified form — the same wheel, minus the settling stages. Nothing else.

---

## The corrected model {#model}

The first round's mistake was one sentence: *"the runner distinguishes the courses by the recorded kind, never by sniffing the document."* Telling the machinery which course it is running is what cost five layers — every layer needed a slot to carry the telling. But the wheel **already** derives its progression from documents: `start_action` in `tugrust/crates/tugcast/src/feeds/dash_arc.rs` rotates to review when the input lints as a plan and to devise when it is a brief. The corrected model extends that derivation by one arm instead of adding a parallel channel of state:

**The documents the door writes are the course.** Both doors sharpen in the invoking conversation, write documents to the dash's own address, run `tugtool dash run <name>`, and end the turn. They differ only in what they write:

- **`/dash-plan`** writes `brief.md`. The wheel sees a brief → **devise → review → implement → audit**. This is today's brief-only arc, verbatim — the plan course changes *zero machinery*.
- **`/dash`** writes `brief.md` **and `tasks.md`** — the task list, in the minimal ledger shape. The wheel sees a task list → **implement → audit**, walking `tasks.md` exactly as the plan course walks a plan's ledger.

No recorded kind, no `--course` flag, no wire change, no new stop reason, no environment rename. Two distinct filenames make the discrimination *addressing*, not sniffing — the same mechanism `start_action` already uses, with one more case.

**Why the door writes the task list.** The first round had the implement stage's first cold turn author it, which is what required the `TaskListMissing` stop reason, a `ledger_parsed` fact, and a special first ask — a whole gate apparatus policing a document's existence. All of it evaporates when the document exists before the arc opens. And the door conversation is the *better* author anyway: it holds the sharpening context, and the task list is (round one's own words) bookkeeping rather than a design artifact wanting a cold read. `/dash`'s cold read is the audit at the end.

---

## The two documents {#documents}

**`brief.md`** — the six beats of `tuglaws/brief-skeleton.md`, carrying the sharpening conversation's settled calls as `[B##]` decisions and `[F##]` findings, so the fresh sessions downstream lose nothing. Shared entry artifact of both courses; a conforming brief handed in with the invocation is used as-is.

**`tasks.md`** — an `{#execution-steps}` section over a `{#step-status-ledger}`, the same rows `tugtool dash step` drives today. It is never linted as a plan: `plan lint` on it errors, and that is correct — it has no metadata, no specs, no review record, because it is not a plan. The ledger *parser* is indifferent to what surrounds the rows, which is why the implement machinery can walk it unchanged.

**Precedence: `plan.md` outranks `tasks.md`.** A dash with both is a plan-course dash. The escape hatch when a `/dash` turns out to need real settling is therefore not a mode switch: discard `tasks.md`, rerun, and the derivation routes through devise as if the task list had never existed. No machinery knows about "upgrading" because there is nothing to upgrade — only documents present or absent.

---

## What the change touches {#work-list}

1. **`tugrust/crates/tugdash-core/src/ops.rs`** — `tasks_file()` beside `brief_file()` / `plan_file()`; the `dash documents` verb learns the address.
2. **`tugrust/crates/tugcast/src/feeds/dash_arc_runner.rs`** — `read()` resolves one *ledger source*: `plan.md` when present, else `tasks.md`, through the same base-until-adoption path resolution the plan already gets. `start_action` gains the arm: no plan, task list present → rotate to implement. `implement_action` and `audit_action` are untouched — they read `StepLedgerFacts` and never knew where the rows came from.
3. **`tugtool dash step`** — resolves the same ledger source, so marking rows works identically on either document.
4. **`tugplug/skills/dash/SKILL.md`** — rewritten whole as a door: orient, accept or generate the brief, author the task list from it, write both, `tugtool dash run <name>`, say what happens next, end the turn. The frontmatter description ("no brief, no plan review, no arc") is user-visible and is the most wrong sentence in the file. No worktree, no implementation, no in-thread audit.
5. **`tugplug/skills/dash-plan/SKILL.md`** — the inline plan authoring comes out; sharpening ends in a **brief**; the hand-off writes it and runs `tugtool dash run <name>`. This reverses "The plan is written here, and there is no brief": the brief carries the conversation's settling forward, and the devise stage reads it cold, which the inline-authored plan never got.
6. **Doctrine** — the lane preamble of `tuglaws/dash-work-doctrine.md` (two doors, both handing to the wheel, differing in settling) and the dash-family roster paragraph of `tugplug/CLAUDE.md`. `tuglaws/wheel.md`'s course section gets the one-arm derivation described, nothing more.
7. **The implement ask** — verify the wording in `tugrust/crates/tugcast/src/wheel/prompt.rs` reads correctly when the ledger is a task list; expected nil or a word.

**Explicitly not in this change:** the `TUG_DASH_ARC` → `TUG_DASH_COURSE` rename (a follow-up, purely mechanical, wanted by nothing above), stage skills refusing to run outside a course (hardening, later), and every other step of the discarded nine-step plan.

---

## Answers that survive from round one {#kept}

- **Cold review.** Both courses get one — the audit, on a fresh session, of the landed code. `/dash` skips settling-time review only, never landed-code review.
- **The stage roster** — devise and review are plan-course-only; implement and audit serve both; `review` (of the plan) and `audit` (of the code) keep their distinct names.
- **The ten-step guardrail** becomes a door-time advisory: a `/dash` brief that reads plan-shaped earns one sentence offering `/dash-plan`, and the door then does what the user says. One clear change at the `/dash-plan` door earns the inverse sentence. Never an `AskUserQuestion`; nothing asks mid-run.
- **`.tugtool/config.toml`** — no new knobs; the per-stage models and `implement_compact_tokens` apply to both courses as-is.
- **Lens-breakout** — the midpoint is joined (`14e9b6b48`); the remainder waits and runs as an early passenger of the corrected machinery.

---

## How this lands {#landing}

Dashes are broken mid-retrofit, so this work does not ride a dash. The sequence is: the discarded `dash-courses` dash and its plan are torn down; the user commits this proposal; on the user's go-ahead the work is implemented **directly on `main`**, in review-sized commits, the user landing each. Only after it lands do the doors reopen.

---

## Provenance {#provenance}

Written to the base checkout, untracked, beside `notes/dash-wheel-retrenchment.md`, for the same reason that note gives: this is about the dash system, not about any dash. Committing it is the user's.

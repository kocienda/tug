---
name: arc-review
description: A trek's review stage — read a devised plan cold against the real code, fix what it finds, append a Review Record, and stamp it
argument-hint: "[plan-path]"
disable-model-invocation: true
allowed-tools: Bash, Read, Edit, Glob, Grep, WebFetch, WebSearch
disallowed-tools: Task, Write, AskUserQuestion
---

## What this is

`arc-review` is the **review stage** of a trek, and the pre-implementation pass: read the plan the devise stage wrote, judge it against the real code, and **fix what you find**. It is not a report — the old `vet` skill was read-only by construction, so the only thing it could do with a finding was hand it back, and the answer was invariably "do the fixups". This does the fixups.

**It is a stage of an arc, not a standalone command.** The wheel seats it on a fresh session, on the model the project declared for the review, reading the plan cold — and that coldness is the whole of what the stage buys. The devise stage before it ends by asking the wheel to seat this one rather than by handing the user a chip, and the stamp this stage writes is what rotates the arc onward. So [the arc check](#0-confirm-the-arc-that-runs-you) is the first thing this skill does.

**You are the reviewer, in-thread.** Do not spawn sub-agents (`Task`).

**You edit exactly one file: the plan.** Not the code the plan describes. A plan review that starts implementing is not a review.

## Input

`/tugplug:arc-review <name-or-path>` — an **arc name** or an explicit path, and the argument's shape decides which: anything carrying a separator, starting with `.`, or ending in `.md` is a path; anything else is an arc, and resolves to its own `plan.md`. Every `tugtool plan` verb takes the argument verbatim, so pass it through rather than resolving it yourself. There is no default and no search: a name is an exact address, not a guess.

## The pass

### 0. Confirm the arc that runs you

```bash
printenv TUG_ARC
```

It names the arc you are the review stage of.

**With it absent from the environment, stop and say so.** This skill is a stage of a trek rather than a standalone command, and `/trek` is the door into it: it sharpens the idea with the user, writes the brief, and opens the arc that devises the plan and hands it here. (The other door, `/dash`, settles its steps as a task list and opens an arc with no devise stage and no review stage at all.) There is no path from here that ends anywhere else — the stamp this stage writes is read by a runner, and with no runner watching it there is nothing behind the gesture.

**Then confirm the arc can still find you.**

```bash
tugtool arc bind <name> --dry-run
tugtool arc status <name> --json
```

The dry run writes nothing; it resolves which session this shell actually belongs to and says `(this shell holds …, which has rotated)` when the shell's own id has gone stale — which is ordinary under an arc and is not a problem. What is a problem is a resolved session missing from `arc status --json`'s `bound_sessions`: the binding did not ride the rotation, and nothing downstream will find this run.

**The repair is `tugtool arc doctor <name>`**, which compares all four of an arc's records and names each disagreement in a sentence. Not `/dash-bind`, which writes one of the four and answers nothing about the other three.

### 1. Read the plan's review state, then lint it

```bash
tugtool plan status <name-or-path> --json
tugtool plan lint <name-or-path>
```

`status` tells you what kind of round this is before you read a line. `rounds: 0` (or `review: "never-reviewed"` with no stamped round) is a first pass — review the whole document. Anything else is a **re-review**, and re-review has its own rules, held in [`tuglaws/plan-review-rubric.md`](../../../tuglaws/plan-review-rubric.md#re-review-what-a-second-round-may-touch): *edits are decisions* and *done rows are frozen*. Read that section before touching a plan that has been reviewed before; do not restate it here. When the rubric is absent, those two rules — *edits are decisions*, *`done` rows are frozen* — are the whole of re-review discipline; hold them as stated and say so.

**Orient on what moved.** On a second or later round, read the git diff since the previous round when the plan is tracked and dirty; otherwise read the Review Record and orient on that. Name which one you used in the round's `Oriented on:` line — it tells the next reader how much of the document this round actually looked at.

Then the linter. Every diagnostic is yours to fix, warnings included.

They are mechanical by design — missing sections, duplicate anchors, `[D##]` where `[P##]` belongs, a step with no checkpoint, a `**Depends on:**` naming a step that does not exist or comes later, a ledger row with no step. Fix them in the plan and re-run until it is clean.

Exit 2 means the document is not a plan (or cannot be read). Say so and stop — do not review a brief as if it were a plan.

Fix the linter's findings *first*, so the reading below is spent on judgment rather than bookkeeping.

### 2. Read the code the plan touches

Read the actual components, data flow, and conventions the plan builds on — not the plan's description of them. Use Glob/Grep/Read freely; pull external references with WebFetch/WebSearch only when the plan leans on them.

This is the step that makes the review worth its cost. A finding you could have written from the plan alone is not a finding.

### 3. Apply the rubric

Read [`tuglaws/plan-review-rubric.md`](../../../tuglaws/plan-review-rubric.md) and work down it: plan quality and coherence, technical choices, strategy and sequencing, holes and pitfalls, test-plan sanity, the tuglaws cross-check (name the specific laws; for frontend work in a project whose laws define state zones, verify the State Zone Mapping), the does-this-leave-the-architecture-better test, and the cold-reader test.

If the rubric is absent — a project without `tuglaws/` — proceed on the criteria above and **say so** in the Review Record. A missing rubric degrades the review; it does not cancel it.

### 4. Apply the fixups

Edit the plan directly. Rewrite the step that was out of order, replace the banned test with the right one at the right layer, add the failure path the plan skipped, correct the decision that contradicts the code you just read.

What to fix versus what to raise:

- **Fix** anything you can settle from the code, the laws, or the plan's own decisions.
- **Stop** on anything that needs the user's judgment — a scope call, a product decision, a trade-off with no technically correct answer. `tugtool arc ask <name> "<the question>"` stops the arc under the reason `needs a decision`, writes the question as the arc's last `arc-note`, and hands the card back with a receipt that reads the question out. The user answers in their own conversation and `tugtool arc run <name>` rotates review again. Outside an arc — the user typed `/arc-review` and is sitting here — say it in prose and wait, then write the answer into the plan as a decided item.
- **Leave alone** anything you merely would have done differently. A plan is not wrong for not being yours.

**A judgment call is raised first and an Open Question second.** A call you could have put in front of somebody and instead deferred costs them a round trip they never agreed to. Only a call the user *declines to settle* becomes `[Q##]` — with its rationale and its plan to resolve. That makes the notation mean something precise: **a `[Q##]` in a finished plan was raised and deferred, never never-raised.**

**No dialog, and the tools say so rather than only the prose.** `AskUserQuestion` is refused in this skill: under an arc there is nobody in front of the stage, and a stage parked on a dialog is an arc that has stopped without saying so — nothing in the dash-log, no receipt on the card, and the question lost the moment the wheel rotates the card, which it may do because a dialog is not a turn.

Raise the design, never the process. Never raise whether to apply a fixup, whether to keep going, or anything else with a conventional default — the never-ask boundary is in [`tuglaws/arc-work-doctrine.md`](../../../tuglaws/arc-work-doctrine.md#what-never-gets-asked). Where that document is absent, the preceding sentence is the boundary, and say so. Stopping an arc over something the code could have settled is the same cost, spent by the machine instead of the user.

Keep the plan lint-clean as you go — re-run the linter after substantive edits.

### 5. Append the Review Record

Add one paragraph to `### Review Record {#review-record}` (immediately after Plan Metadata; add the section if the plan predates it). One round per pass, appended — never rewritten, since the point is the history.

```markdown
**Round 2 — 2026-08-13, opus.** Lint: 0 errors, 3 warnings (2 fixed).
Oriented on: the git diff since round 1.
Applied: sequencing — Step 4 depended on a later step, reordered; test plan — Step 2
proposed an RTL render test, rewritten as an app-test; law [L02] — the new store read
bypassed `useSyncExternalStore`, corrected in Spec S01.
Deferred: the migration-window question — asked, and the user chose to settle it during
implementation; now [Q03].
```

Prose, not a table — a table invites one-word entries, and the value is the specificity. Name what you changed and why, and what you deliberately did not.

**Write no hash.** The round paragraph carries no `plan:<…>` token when you write it — the stamp is step 6, and it is computed, not authored.

### 6. Stamp it — the last edit of the review

```bash
tugtool plan stamp <name-or-path>
```

This computes the plan's content stamp and inserts `Reviewed \`plan:<hash>\`.` into the round you just wrote. From then on `tugtool plan status` can say whether the review still covers the document, which is what `arc-implement`'s setup gate reads.

Two things follow, and both are absolute:

- **Never type a hash yourself.** You cannot compute SHA-256, so any hash you write is fabricated — and a fabricated stamp is worse than none, because it reads as `stale` forever rather than as missing. The verb writes it; you never see one to copy.
- **Stamp last.** Any edit after the stamp invalidates it. That includes bumping `Last updated` in Plan Metadata, which is inside the hashed content. Finish every edit, then stamp.

A second `plan stamp` on the same round exits 1 rather than rewriting — two stamps on one round cannot both be true. If you edited after stamping, append a new round and stamp that.

Progress does **not** invalidate a stamp: ledger status cells, commit cells, and task checkboxes are outside the hashed content, so a plan does not go stale as its own steps land.

### 7. Hand off

**The stamp is the hand-off.** You wrote it in stage 6, and nothing else here does anything: the runner reads `tugtool plan status` and rotates the arc to implement on the strength of it. So report what changed, in a few lines, and end the turn. **Ending the turn is the hand-off.**

**Print no chip and name no next command.** Nobody is going to press it — the arc is already running and the next stage opens by itself at this turn's end. A `/tugplug:arc-implement` chip beside a stage that is about to be seated teaches the user that nothing happens until they type, which is the belief the wheel exists to retire.

**Ask for no rotation either.** The card is already running an arc, and a second request on it is refused by name. Say what you changed and where, and stop.

A review that ends **without a stamp** has answered nothing, exactly as an audit that ends without a mark has. The wheel sees that and stops, saying the review did not stamp; `tugtool arc run <name>` resumes it. So if you cannot stamp — an edit landed after one, the document will not lint — say why in the turn rather than ending quietly, and let the arc's stop carry it.

## Guardrails

- **No sub-agents.** Read, judge, and fix in-thread.
- **Edit only the plan file.** Never the code it describes.
- **Never report "looks good" without having read the code the plan touches.** A review that could have been written from the plan alone has not happened.
- **Ground every claim in the real code or the tuglaws.** Name the file, the symbol, the law.
- **Fix what you can; ask what you cannot.** A judgment call is a dialog, never a silent decision — and only a deferral becomes an Open Question.
- **Respect what moved.** Edits are decisions; `done` rows are frozen. The rules are in the rubric's re-review section, and they outrank your sense of how the plan should have been shaped.
- **Always append the Review Record**, even on a clean pass — a round that found nothing is a fact worth recording, and a vacuous round is supposed to be visible in the artifact.
- **The stamp is the last thing you do, and you never type it.** `tugtool plan stamp` computes it; an edit after it makes it a lie.
- **Print no chip and name no next command.** The runner reads the stamp and rotates to implement itself; a command line here is a button nobody will press.
- **Run only under an arc.** With no arc in the environment, say what this is a stage of and which door starts one, and stop.

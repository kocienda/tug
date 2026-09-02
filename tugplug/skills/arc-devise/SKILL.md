---
name: arc-devise
description: The devise stage of a trek — write the plan against the devise skeleton, validate it, and hand it to the review stage — ready for /tugplug:arc-implement
argument-hint: "[idea] [→ output-path]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch
disallowed-tools: Task, AskUserQuestion
---

## What this is

`arc-devise` turns an idea into a concrete, implementable **plan** — a plan document **written by you, the main conversation, directly**. No agent swarm, no clarifier/author/critic/conformance/overviewer hand-offs. You investigate the codebase, ask the few questions that genuinely change the design, write the plan, and validate it. The result is a plan document — written to a path **you specify** — that `/tugplug:arc-implement` can carry to a build.

(The skill is named `arc-devise`, not `plan`, to avoid colliding with Claude Code's built-in. The document it produces is a standard tugplan in the devise-skeleton format, so `/tugplug:arc-implement` consumes it unchanged.)

**You are the author.** Do not spawn sub-agents (`Task`). Do the research and the writing in-thread.

**The plan must stand alone.** Assume the session that implements the plan is **not** this one — a fresh session with none of your investigation context, file reads, or conversation history. Everything the implementer needs must be *in the document*: the file paths and symbol names you found, the behaviors and conventions you discovered, the reasoning behind each decision. Never write a plan that only works because the author is about to implement it.

## Input

`/tugplug:arc-devise <idea> [🢂 <name-or-path>]` — a free-text description of what to build, and **which arc the plan belongs to** (or an explicit path).

## Where the plan goes

A plan is a markdown file, and its address is the arc. **An explicit path in the invocation always wins** — write it exactly there, report the path you wrote, and skip the rest of this section.

Otherwise the target is a **arc name**, and one verb resolves it:

```bash
tugtool arc documents <name> --ensure --json
```

`--ensure` creates `.tug/arcs/<name>/` (and keeps `.tug/` out of git) so the write needs no second call; the `plan` field it prints is where the plan goes. Nothing is declared, nothing is asked, and there is no directory name to choose — an arc's documents live at its own address or nowhere.

With neither a path nor a name, ask once for the name. That is the only question this section can raise, and it is a question about *which arc*, never about *where*.

The documents are **not tracked**. `.tug/` is gitignored, so a plan lands on no diff, needs no commit, and is never something the user has to clean up.

## The flow

### 1. Understand

Read the relevant code before designing. Use Glob/Grep/Read to map the territory: the components, the data flow, the existing conventions, the laws that apply (a project's `tuglaws/`, where it has one). Pull external references with WebFetch/WebSearch only when the idea needs them. The plan must be grounded in how the code actually works, not how you imagine it works.

### 2. Clarify (only what matters)

Settle what you can from the code, the laws, and the conventional default — which is nearly everything. A question is worth raising **only when the answer changes the design** and nothing you can read decides it.

**Raising one is not a dialog**, and `AskUserQuestion` is refused in this skill's tools rather than only in its prose. Under an arc there is no user in front of the stage, and a stage parked on a dialog is an arc that has stopped without saying so: nothing in the dash-log, no receipt on the card, `tugtool arc record` still reading mid-stage, and the question itself lost the moment the wheel rotates the card — which it may do, because a dialog is not a turn. So the stage **stops and says what it wanted**:

```bash
tugtool arc ask <name> "Should the retry back off per-host or per-request?"
```

That is `arc stop`'s twin: the same hand-back and the same receipt path, under the reason `needs a decision`, with the question written as the arc's last `arc-note` so the record carries it and the receipt reads it back. The user answers in their own conversation and `tugtool arc run <name>` picks the work back up. Outside an arc — the user typed `/arc-devise` and is sitting here — there is no arc to stop: say the question in prose, in one sentence, and wait for the answer like any other turn.

Either way the bar is the doctrine's [never-ask list](../../../tuglaws/arc-work-doctrine.md#what-never-gets-asked): design questions, never process ones, and nothing with a conventional default. On a project with no `tuglaws/`, that one sentence *is* the boundary — apply it as stated here and say so. Stopping an arc over a question the code could have answered costs a person a round trip they never agreed to.

### 3. Write against the skeleton

Author the plan at the output path you were given (or asked for) following the **devise skeleton**, [`tuglaws/devise-skeleton.md`](../../../tuglaws/devise-skeleton.md) — this is the mandatory format. Conform to it exactly:

**When the project has no `tuglaws/devise-skeleton.md`,** the format contract is the summary carried below plus `tugtool plan lint`, which ships with the product and is project-agnostic — write against the summary, lint until it exits 0, and say so. Do not reconstruct the skeleton document from memory; the linter is what the format actually means.

**Writing a brief rather than a plan?** A brief records what was found and what was decided *before* an implementable document exists — no steps, no ledger, no checkpoints. Its format is [`tuglaws/brief-skeleton.md`](../../../tuglaws/brief-skeleton.md): Purpose, Evidence (findings labelled `[F01]…`), Decisions (`[B01]…`, so the plan that follows can cite them), Open Questions, Non-goals, and Exit. It is deliberately unlinted, so nothing checks it and every section may be omitted when it has nothing to say. **When the project has no `tuglaws/brief-skeleton.md`,** there is no format to conform to and no linter standing in for one: write the brief in those six beats, say that the project declares no brief format, and move on. Note that `tugtool plan lint` exits 2 on a brief — that is correct, not a failure.

- The skeleton's section order: Purpose, Plan Metadata, Phase Overview (Context / Strategy / Success Criteria / Scope / Non-goals / Dependencies / Constraints / Assumptions), then Open Questions, Risks, Design Decisions, optional Deep Dives / Specification / Rollout / Symbol Inventory, Test Plan Concepts, **Execution Steps** (with a **Step Status Ledger**), Deliverables.
- Explicit `{#anchor}` headings; kebab-case; no phase numbers in anchors.
- Stable labels: plan-local Design Decisions `[P01]` (use `P`, **never** `D` — `[D##]` is reserved for the global `tuglaws/design-decisions.md`, which a plan may cite by reference), Open Questions `[Q01]`, Specs `S01`, Tables `T01`, Lists `L01`, Risks `R01`, Milestones `M01` — always two digits, never reused.
- **Execution Steps** each carry a `**Commit:**` message, `**References:**` (cite decisions/specs/anchors — never line numbers), `**Depends on:**` where applicable (anchor refs like `#step-1`), Tasks, Tests, and a falsifiable Checkpoint. This is the part `/tugplug:arc-implement` walks. Seed the **Step Status Ledger** with every step marked `pending`.
- For frontend work in a project whose laws define state zones, fill the **State Zone Mapping** table — map each new piece of state to its zone before writing steps.
- Resolve open questions where you can (spike them in-thread — read the code, check a fixture). **Raise the rest before you declare the plan ready** — a design question you cannot settle stops the arc with `tugtool arc ask` (or, outside an arc, is said in prose and waited on), and the answer lands in the plan as a decided item. Only a question the user *declines to settle* stays `[Q##]`, with its rationale and its plan to resolve. That is what makes the notation mean something: **a `[Q##]` in a finished plan was raised and deferred, never never-raised.**

Prefer a tight, real plan over an exhaustive one. Every step should be executable with a clear commit boundary and a falsifiable checkpoint.

**Write for a cold reader.** Transcribe your investigation into the plan rather than alluding to it: name the exact files, functions, types, and messages a step touches; state the current behavior a change replaces; record non-obvious findings (gotchas, ordering constraints, existing conventions) in Deep Dives or the step itself. If a step's Tasks would make an implementer go re-derive something you already learned this session, the plan is incomplete — put the finding in the document.

### 4. Self-check

Run the checker over what you wrote:

```bash
tugtool plan lint <plan-path>
```

It answers the mechanical half — required sections, unique anchors, `[P##]` vs `[D##]`, per-step field presence, `**Depends on:**` resolution and direction, ledger integrity, banned test shapes. Fix every diagnostic it names, warnings included, and re-run until it is clean. Exit 0 is the bar before you hand off.

Then run the **cold-reader test**: could a fresh session, given only this document and the repository, implement every step without asking you anything? Hunt for references that lean on session context — "as discovered above", "the function we looked at", steps that name a change but not its location — and replace each with the concrete paths, symbols, and findings.

### 5. Hand the review to the wheel

**This stage runs under an arc.** `printenv TUG_ARC` names the arc you are the **devise stage** of, and the wheel handles the hand-off itself:

- Finish at the natural end — a written plan, lint-clean, at the path you were given — and stop there.
- **Do not review it, on any model, including Opus.** The review is the arc's *next stage*: its own fresh session, on the model the project declared for it, reading the plan cold. That cold read is the point, and reviewing inline destroys it by handing the review the author's context.
- **Print no chip and name no next command.** Nobody is going to click it. The runner is watching the documents — it reads `tugtool plan lint` and `tugtool plan status` on the plan you just wrote and rotates the stage itself.
- **Ask for no rotation either.** The card is already running an arc, and a second request on it is refused by name. Say what you wrote and where, and end the turn. Ending the turn *is* the hand-off.

**With it absent from the environment, stop and say so.** This skill is a stage of an arc rather than a standalone command, and `/trek` is the door into it: it sharpens the idea with the user, writes the brief you would be devising from, and opens the arc that carries the plan to its review. (The other door, `/dash`, settles its steps as a task list and opens an arc with no devise stage at all.) There is no path from here that ends anywhere else, because the plan is not ready when you finish writing it — it is ready when a fresh session has read it cold, and only the arc opens that session.

**Confirm the arc can still find you**, once, before you write:

```bash
tugtool arc bind <name> --dry-run
tugtool arc status <name> --json
```

The dry run writes nothing; it resolves which session this shell actually belongs to and says `(this shell holds …, which has rotated)` when the shell's own id has gone stale — ordinary under an arc, and not a problem. What is a problem is a resolved session missing from `arc status --json`'s `bound_sessions`: the binding did not ride the rotation, and nothing downstream will find this run. **The repair is `tugtool arc doctor <name>`**, which reads all four of an arc's records and names which disagrees — not `/dash-bind`, which writes one of them and answers nothing about the rest.

### 6. Hand off

Tell the user the plan is written and name the exact path, and say the plan is **unreviewed** — it is, until the review turn lands. Then say what happens next: the review opens by itself at this turn's end. Do not tell them to implement yet — an unreviewed plan is not ready, and a reviewed one may have just changed.

Don't start implementing from the devise skill — authoring and implementing are separate turns, as is committing the plan to git, which the user owns. Reviewing is a separate turn too, and it is the arc's to open: this turn ends at the written plan, whichever model you happen to be running on.

## Guardrails

- **No sub-agents.** Research and write in-thread.
- **Explicit path wins; otherwise the name answers.** The plan goes exactly where the user says, or at the named arc's own address. Never hardcode a directory and never invent one — `tugtool arc documents <name> --ensure` is the resolver, and the only thing worth asking about is which arc.
- **Conform to the skeleton.** `tuglaws/devise-skeleton.md` is the format contract, upheld by authorship and review.
- **Ground the plan in the real code.** Read before you design.
- **Standalone always.** The plan must be implementable from any session with zero conversation context — bake every investigation finding into the document.
- **Don't over-ask.** Clarify only design-changing unknowns.
- **Lint before handing off.** `tugtool plan lint` exit 0 is the bar.
- **Never review the plan yourself, on any model** — the review is a fresh session's cold read, and never declare a plan ready that nothing has reviewed.
- **Never print a chip and never name a next command.** The review is the arc's next stage and the runner is reading the documents; the turn ends at the written plan.
- **Don't auto-implement.** `arc-devise` produces the document; the review turn improves it; `arc-implement` runs it.
- **Don't auto-enter Plan mode** (`EnterPlanMode`) — just write the plan document.

---
name: plan-devise
description: Devise an implementation plan in-thread — clarify the idea, write it against the devise skeleton, validate it, and hand it to the review turn — ready for /tugplug:dash-implement
argument-hint: "[idea] [→ output-path]"
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, AskUserQuestion
disallowed-tools: Task
---

## What this is

`plan-devise` turns an idea into a concrete, implementable **plan** — a plan document **written by you, the main conversation, directly**. No agent swarm, no clarifier/author/critic/conformance/overviewer hand-offs. You investigate the codebase, ask the few questions that genuinely change the design, write the plan, and validate it. The result is a plan document — written to a path **you specify** — that `/tugplug:dash-implement` can carry to a build.

(The skill is named `plan-devise`, not `plan`, to avoid colliding with Claude Code's built-in. The document it produces is a standard tugplan in the devise-skeleton format, so `/tugplug:dash-implement` consumes it unchanged.)

**You are the author.** Do not spawn sub-agents (`Task`). Do the research and the writing in-thread.

**The plan must stand alone.** Assume the session that implements the plan is **not** this one — a fresh session with none of your investigation context, file reads, or conversation history. Everything the implementer needs must be *in the document*: the file paths and symbol names you found, the behaviors and conventions you discovered, the reasoning behind each decision. Never write a plan that only works because the author is about to implement it.

## Input

`/tugplug:plan-devise <idea> [→ <output-path>]` — a free-text description of what to build, and **where to write the plan**.

## Where the plan goes (declared, never assumed)

A plan is just a markdown file at an **explicit path**, and **an explicit path in the invocation always wins** — write it exactly there, report the path you wrote, and skip the rest of this section.

When the invocation names none, the project's own config answers:

```bash
tugutil dash docs-dir --json
```

- **Declared** (`declared: true`) — propose `<docs>/<slug>.md` and proceed. **Do not ask.** The project already said where its paperwork lives.
- **Undeclared** (`declared: false`, exit 0 — a state, not an error) — ask the user **once** where dash paperwork should live, proposing a name, then record the answer:

  ```bash
  tugutil dash docs-dir --set <answer>
  ```

  The verb writes the key into `.tugtool/config.toml` (preserving the file's comments) and creates the directory. Then write the plan there.

The question is asked **once per project, ever** — the answer is committed config from then on, so no later run pays the toll. Never hand-edit the config to record it; the verb prints a receipt and validates the value, and a skill editing TOML by hand is a shell-edit-discipline violation waiting to happen.

There is still **no blessed directory name**. `roadmap/`, `docs/`, `.tugtool/` — none of them is assumed, and the machinery no longer treats any name specially. Whether and where the plan is committed to git remains the user's call.

## The flow

### 1. Understand

Read the relevant code before designing. Use Glob/Grep/Read to map the territory: the components, the data flow, the existing conventions, the laws that apply (tuglaws for tugdeck work). Pull external references with WebFetch/WebSearch only when the idea needs them. The plan must be grounded in how the code actually works, not how you imagine it works.

### 2. Clarify (only what matters)

Ask clarifying questions **only when the answer changes the design** and you can't resolve it from the code or a sensible default. Use `AskUserQuestion` (≤4 options each). Don't interrogate — a couple of sharp questions beat a checklist. If the idea is already specific, skip straight to writing.

The boundary on what is worth asking is in the doctrine's [never-ask list](../../../tuglaws/dash-work-doctrine.md#what-never-gets-asked): design questions, never process ones, and nothing with a conventional default. On a project with no `tuglaws/`, that one sentence *is* the boundary — apply it as stated here and say so.

### 3. Write against the skeleton

Author the plan at the output path you were given (or asked for) following the **devise skeleton**, [`tuglaws/devise-skeleton.md`](../../../tuglaws/devise-skeleton.md) — this is the mandatory format. Conform to it exactly:

**When the project has no `tuglaws/devise-skeleton.md`,** the format contract is the summary carried below plus `tugutil plan lint`, which ships with the product and is project-agnostic — write against the summary, lint until it exits 0, and say so. Do not reconstruct the skeleton document from memory; the linter is what the format actually means.

- The skeleton's section order: Purpose, Plan Metadata, Phase Overview (Context / Strategy / Success Criteria / Scope / Non-goals / Dependencies / Constraints / Assumptions), then Open Questions, Risks, Design Decisions, optional Deep Dives / Specification / Rollout / Symbol Inventory, Test Plan Concepts, **Execution Steps** (with a **Step Status Ledger**), Deliverables.
- Explicit `{#anchor}` headings; kebab-case; no phase numbers in anchors.
- Stable labels: plan-local Design Decisions `[P01]` (use `P`, **never** `D` — `[D##]` is reserved for the global `tuglaws/design-decisions.md`, which a plan may cite by reference), Open Questions `[Q01]`, Specs `S01`, Tables `T01`, Lists `L01`, Risks `R01`, Milestones `M01` — always two digits, never reused.
- **Execution Steps** each carry a `**Commit:**` message, `**References:**` (cite decisions/specs/anchors — never line numbers), `**Depends on:**` where applicable (anchor refs like `#step-1`), Tasks, Tests, and a falsifiable Checkpoint. This is the part `/tugplug:dash-implement` walks. Seed the **Step Status Ledger** with every step marked `pending`.
- For tugdeck/tugways work, fill the **State Zone Mapping** table — map each new piece of state to its tuglaws zone before writing steps.
- Resolve open questions where you can (spike them in-thread — read the code, check a fixture). **Ask the rest before you declare the plan ready** — a design question you cannot settle is an `AskUserQuestion` with the candidate answers as its options, raised while the user is still here, and the answer lands in the plan as a decided item. Only a question the user *declines to settle* stays `[Q##]`, with its rationale and its plan to resolve. That is what makes the notation mean something: **a `[Q##]` in a finished plan was asked and deferred, never never-asked.**

Prefer a tight, real plan over an exhaustive one. Every step should be executable with a clear commit boundary and a falsifiable checkpoint.

**Write for a cold reader.** Transcribe your investigation into the plan rather than alluding to it: name the exact files, functions, types, and messages a step touches; state the current behavior a change replaces; record non-obvious findings (gotchas, ordering constraints, existing conventions) in Deep Dives or the step itself. If a step's Tasks would make an implementer go re-derive something you already learned this session, the plan is incomplete — put the finding in the document.

### 4. Self-check

Run the checker over what you wrote:

```bash
tugutil plan lint <plan-path>
```

It answers the mechanical half — required sections, unique anchors, `[P##]` vs `[D##]`, per-step field presence, `**Depends on:**` resolution and direction, ledger integrity, banned test shapes. Fix every diagnostic it names, warnings included, and re-run until it is clean. Exit 0 is the bar before you hand off.

Then run the **cold-reader test**: could a fresh session, given only this document and the repository, implement every step without asking you anything? Hunt for references that lean on session context — "as discovered above", "the function we looked at", steps that name a change but not its location — and replace each with the concrete paths, symbols, and findings.

### 5. Review it, or hand the review over

The plan is not ready when you finish writing it; it is ready when it has been reviewed. Which of those two you do next depends on one thing, and only one: **the model you are running on right now.**

**If you are running on Opus, review it yourself, immediately, in this same turn.** Do not stop, do not ask, do not print a command. Read [`tuglaws/plan-review-rubric.md`](../../../tuglaws/plan-review-rubric.md) and `plan-review`'s own skill text and carry the review out: lint the plan, judge it against the rubric and the real code, apply the fixups in the document, append the Review Record, and stamp it with `tugutil plan stamp` as the last edit. You are the review model; there is nothing to hand off to and nothing to wait for.

**If you are running on anything else, stop.** Do not review — the review is where judgment lands, and it is worth the better model. Say the plan is written and unreviewed, and print the review command on its own line and inside backticks so it arrives as a clickable chip:

`` `/tugplug:plan-review dash/my-plan.md` ``

Then say plainly that clicking it reviews the plan **on whatever model is selected at that moment**, so switching models first is the user's call and their opportunity to make it. Nothing switches models on their behalf, before or after.

That is the whole rule. There is no signal to fire, no request to queue, and no turn scheduled on the user's behalf — a review either happens now because you are already the right model, or it happens when the user asks for it.

### 6. Hand off

Tell the user the plan is written and name the exact path. If you reviewed it, say so and summarize what the review changed. If you handed the review over, say the plan is **unreviewed** and leave the chip as the next gesture. Either way, do not tell them to implement yet — an unreviewed plan is not ready, and a reviewed one may have just changed.

The command after the review lands is `` `/tugplug:dash-implement <plan-path>` ``, and `plan-review` prints it. Write any command you do print on its own line **inside backticks**, command and path together in one span, with the real path substituted in — the Session card only turns a command line into a clickable chip when it arrives as its own inline code span; written as bare prose it is dead text.

Don't start implementing from the devise skill — authoring and implementing are separate turns, as is committing the plan to git, which the user owns. Reviewing is the one exception, and only on Opus: there the review is the same turn's second half, because the model that would be handed the job is already the one holding it.

## Guardrails

- **No sub-agents.** Research and write in-thread.
- **Explicit path wins; otherwise the declaration answers.** The plan goes exactly where the user says. Never hardcode or default to a directory name — resolve through `tugutil dash docs-dir`, and ask only when the project has declared nothing yet, recording the answer with `--set` so nobody is asked twice.
- **Conform to the skeleton.** `tuglaws/devise-skeleton.md` is the format contract, upheld by authorship and review.
- **Ground the plan in the real code.** Read before you design.
- **Standalone always.** The plan must be implementable from any session with zero conversation context — bake every investigation finding into the document.
- **Don't over-ask.** Clarify only design-changing unknowns.
- **Lint before handing off.** `tugutil plan lint` exit 0 is the bar.
- **Review it on Opus, hand it over otherwise** — and never declare a plan ready that nothing has reviewed. Never switch the user's model, in either direction.
- **Don't auto-implement.** `plan-devise` produces the document; the review turn improves it; `dash-implement` runs it.
- **Don't auto-enter Plan mode** (`EnterPlanMode`) — just write the plan document.

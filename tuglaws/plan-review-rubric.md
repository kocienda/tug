# Plan Review Rubric

What a reviewer judges when reading an implementation plan, and what a reviewer deliberately does not.

This is doctrine, not skill prose. `/tugplug:plan-review` reads it before reviewing a plan, `/tugplug:dash-audit` applies the same axes to built code, and a human reading a plan by hand can work down it. One copy, three readers.

## What this rubric does not cover

Everything mechanical belongs to `tugutil plan lint`, not to a reader. Section order and presence, anchor uniqueness and spelling, `[P##]` vs `[D##]` label discipline, per-step field presence (`**Commit:**`, `**References:**`, Tasks, Tests, Checkpoint), `**Depends on:**` resolution and direction, Step Status Ledger integrity, and banned test shapes named in a Tests block are all checked deterministically. Run the linter first and fix what it names.

A reviewer who spends attention on anchor spelling is spending the expensive pass on the cheap problem. Read for the things only a reader can catch.

## The five axes

### 1. Plan quality and coherence

Is the design sound, internally consistent, and complete? Do the parts agree with each other — does a decision in one section survive contact with a spec in another? Are the steps executable, with real commit boundaries and falsifiable checkpoints, or are they aspirations with a checkbox?

A step whose checkpoint is "it works" has no checkpoint.

### 2. Technical choices

Are the chosen mechanisms right — or is there a simpler, more robust, or more idiomatic option the plan missed? Does the plan build on machinery that already ships, or does it grow a parallel one beside it?

This is the axis that most rewards reading the actual code. A plan that proposes a new store for state an existing store already publishes is plausible on paper and wrong in the tree.

### 3. Implementation strategy and sequencing

Does the step order make sense? Are the dependencies real and minimal, or has the plan serialized work that could land independently? Is anything mis-scoped — a step that is three steps, or three steps that are one?

Watch for a step that cannot be verified until a later step lands. That is a sequencing defect even when the dependency graph is legal.

### 4. Holes, pitfalls, weaknesses, limitations

What will bite during implementation? Name the edge cases, failure modes, migration hazards, and partial-failure paths the plan does not address. A plan that only describes the happy path has not been finished.

Ask specifically: what happens on error, on interrupt, on unmount, on a crash mid-operation? What does a second invocation do? What does the user come back to?

**A plan that projects repository files must trace the file's whole lifecycle, and must be verified once over the real repository's data.** A surface built for the state a file is in on the day it is written will be wrong about every later state — and the plan's own description of those states is not evidence, because the misreading that produced the surface is usually the misreading the plan repeats. Walk the file from written to adopted to landed to archived, and say what the surface shows at each; then read the code that moves it, not the decision that describes it. Fixtures alone cannot catch this: a fixture is written by whoever holds the wrong model, so it agrees with them. One render over what the repository actually contains is what disagrees ([D159]).

### 5. Test plan sanity

Does each step's Tests block name a test that could actually fail for the right reason, at the right layer?

Real-app behavior — focus, selection, event ordering, caret, portal timing, gestures — belongs in `tests/app-test/` and runs via `just app-test`. Everything else is pure-logic `bun:test` over data. Rust logic is `cargo nextest`.

**Banned outright.** Flag any step proposing one:

- fake-DOM / RTL tests — `happy-dom`, `jsdom` render tests, `@testing-library/react`. There is no in-process DOM substrate; happy-dom was deleted.
- mock-store assertion tests — hand-rolling a core interface to assert mock method-call counts. `tsc --noEmit` already catches interface drift.
- reflexive per-mutator "pin" tests, even against the real engine. Write an integration test in response to a real bug, at the real layer.

The linter catches these when they are named in a Tests block. It cannot catch a test described in prose that amounts to the same thing — that one is yours.

## The tuglaws cross-check

Confirm the proposed changes adhere to the laws in [`tuglaws.md`](tuglaws.md), cross-checking [`design-decisions.md`](design-decisions.md) where relevant. **Name the specific laws** the plan touches — `[L02]`, `[L22]`, `[L27]`, `[L28]`, … — and state, for each, whether the plan honors it or risks violating it. "Follows the laws" is not a cross-check.

For tugdeck / tugways work this is mandatory, and so is the **State Zone Mapping**: every piece of state the plan introduces must name its zone (structure / local-data / appearance / lifecycle) and the mechanism that carries it there. A plan that moves appearance through React state, or reads external state without `useSyncExternalStore`, is wrong regardless of how well it reads.

Also read [`component-authoring.md`](component-authoring.md) and [`pane-model.md`](pane-model.md) before judging tugdeck work.

## The two tests that decide it

**Does this leave the architecture better?** Not just locally correct — a foundation the next feature can build on without having to undo it. A plan that solves its problem by growing a special case the next plan has to work around has failed this test even if every step is executable.

**The cold-reader test.** Could someone who has not been in this conversation read the plan and build the thing? A plan that only makes sense to its author is a plan that will be rebuilt from scratch the next time anyone touches it. Where the plan carries context that lives only in a transcript, say so.

## Re-review: what a second round may touch

A plan is a living artifact between devise and implement. The user reads it, edits it, argues with it, and starts building from it — so a later round is reviewing a document that has *moved*, and two things that moved are not the review's to undo.

**Edits are decisions.** A change the user made since the last round is a decision they made on purpose, whatever it did to the plan's shape. Fix what it broke, name a consequence it missed, raise a trade-off it forces — but never revert its intent. A round that quietly restores round 1's wording has spent the user's time twice and thrown away the answer.

**Done rows are frozen.** A Step Status Ledger row marked `done` describes work that is already in the tree. Rewriting that step produces a document that lies about the code — the plan would say one thing was built and the commits another. When a landed step turns out to be wrong, that is an Open Question or a new step, never a rewrite of the old one.

Orient on what moved: read the diff since the previous round when the plan is tracked and dirty, and the Review Record when it is not. Both are legitimate; which one you used belongs in the round paragraph, because it tells the next reader how much of the document this round actually looked at.

## How a reviewer works

Ground every claim in the real code or in the tuglaws. Read the components, the data flow, and the conventions the plan builds on before judging whether it fits them. No abstract hand-waving; no "consider whether" without having considered it.

Never report "looks good" without having read the code the plan touches. A review that could have been written from the plan alone is not a review.

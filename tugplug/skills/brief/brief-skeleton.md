<!-- brief-skeleton v1 -->

<!--
  This is the format for **briefs** — the document that captures what was found and
  what was decided *before* an implementable plan exists. Its sibling is
  the plan format, which the devise stage of a planned arc writes against.

  A brief is NOT a small plan. It carries no execution steps, no Step Status Ledger,
  no checkpoints, no commit boundaries, and no Review Record. The test of a brief is
  whether an arc can be opened on it — a task list written at the door, or a devise
  round run from it — not whether an implementer can work from it. If you find
  yourself writing steps, you are writing a ledger, and the door or the devise stage
  is where a ledger is made.

  A brief does not say whether the work wants a plan. That is the `/arc` door's
  decision, made from this document's content and the code it names when the brief
  is handed to it — so nothing here is read as an instruction about the arc's shape,
  and the Exit section below names an arc, not a plan.

  **This format is deliberately not linted, and the omission is a decision.** There is
  no `tugtool brief lint`, no parser, and no rules engine. A format written down for
  the first time has not earned a checker: premature linting calcifies exactly the
  thing that should stay soft while it is still being learned. The boundary holds
  mechanically rather than by convention — `tugtool plan lint` detects a plan
  *positively*, by the presence of an `{#execution-steps}` section, so pointing it at
  a brief exits 2 with "not a plan document" and no accidental linting is possible.

  So: every section below may be omitted when it has nothing to say. Where the plan
  format is mandatory, this one is permissive. Say the true thing briefly; do not
  fill a heading to have filled it.

  Two label families make a brief citable from the plan it spawns:

    [F01], [F02], …  findings, under Evidence — what was observed or measured
    [B01], [B02], …  decisions, under Decisions — the calls this brief makes

  Both are safe to cite from a plan: the plan linter's label namespace is
  `P Q S T L R M` (plus `D` for the global decisions), so `[F01]` and `[B01]` pass
  through a plan's `**References:**` line without raising a diagnostic, and such a
  line still counts as carrying a citation.

  A brief opens at `#` (H1) where a plan opens at `##` (H2). That is deliberate: the
  two document kinds should be distinguishable at a glance and in any listing.
-->

# <Brief Title>

**Purpose:** <1–2 sentences. What is wrong, or what is wanted — before any solution is named.>

---

## Purpose {#purpose}

> The problem in the user's words. What was asked for, or what went wrong, stated
> before any solution is proposed. Quote the report where quoting it is clearer than
> paraphrasing — a brief that opens by restating the complaint in the language of a
> fix has already skipped the step it exists for.

<The problem, plainly. What prompted this.>

---

## Evidence {#evidence}

> What was observed or measured. Each finding gets a label so a plan can cite it.
>
> Mark a finding **(verified)** when it was measured, reproduced, or read out of the
> code — and say plainly when it was not, because a brief whose inferences are dressed
> as observations is worse than one with fewer findings. "I believe" and "I measured"
> are different claims and the reader cannot tell them apart unless you say.

**[F01] <What was found>** — <the observation, and how it was established. Name the file, the command, the measurement, or the reproduction.> **(verified)**

**[F02] <What was found>** — <as above. Where this is inference rather than measurement, say so and say what would confirm it.>

---

## Decisions {#decisions}

> The calls this brief makes. A decision states what was chosen **and** the argument
> it rests on, so a later reader can tell a considered choice from an arbitrary one —
> and so a plan citing `[B01]` inherits the reasoning rather than just the conclusion.
>
> Record decisions, not options. Options that were considered and rejected belong in
> Non-goals, where they are protected from being re-proposed.

**[B01] <The decision, as a sentence.>** <Why. What it rules in, what it rules out, and what would have to change for it to be revisited.>

**[B02] <The decision, as a sentence.>** <As above.>

---

## Open Questions {#open-questions}

> What is genuinely still open — not what nobody got around to asking. If you can
> answer it by reading the code, read the code and write a `[B##]` instead; if it
> needs the user's judgment, ask them.
>
> This section is also the one the `/arc` door weighs most when it decides the
> arc's shape: an open question that would change what gets written is a decision
> not yet made, and enough of those is what earns a plan. A brief that hands the
> next reader a pile of unasked questions has moved work rather than done it.

- <The question, and why it cannot be settled here. What would settle it.>

---

## Non-goals {#non-goals}

> What this work is explicitly not — including approaches considered and rejected, and
> why. This section is how a rejected idea stays rejected: an alternative recorded
> here with its reasoning does not have to be re-argued in six weeks.

- **<The thing this is not.>** <Why it is out of scope, or why it was rejected.>

---

## Exit {#exit}

> What this brief expects to spawn, named concretely. A brief is a document with an
> intended successor; saying which one it is turns "we should look at this" into a
> next gesture.
>
> One of:
>
> - **An arc** — the usual exit. Sketch what the first steps look like and any order
>   they must land in, so whoever walks the work starts from a shape rather than a
>   blank page. **Do not say whether the arc wants a plan.** Whether the work earns a
>   written, cold-reviewed plan before a step is walked is the `/arc` door's decision,
>   made from this brief's content and the code when the brief is handed to it. A line
>   here naming "a plan" as the successor is not read as an instruction by anything,
>   and it misleads the next reader about what was decided — the usual arc walks a
>   task list, and a sketch of first steps here is that task list's raw material.
> - **A design spike** — when the question is what something should *look* or *feel*
>   like, and prose cannot settle it.
> - **A wontfix** — when the finding is real and the answer is to do nothing. Say why,
>   so the same investigation is not run again.

<Which of the three, and what it looks like.>

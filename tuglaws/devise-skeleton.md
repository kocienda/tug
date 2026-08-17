<!-- devise-skeleton v5 -->

<!--
  This is the format contract for plans authored by `/tugplug:plan-devise` and walked
  by `/tugplug:dash-implement`. Its mechanical half is checked by `tugutil plan lint`;
  its judgment half is `/tugplug:plan-review`'s, against
  `tuglaws/plan-review-rubric.md`.
  The devise skill's output is a plan written against this skeleton.

  Prefix reservation: plan-local design decisions use `[P01]` (NOT `[D01]`).
  `[D##]` is reserved for the global design decisions in `design-decisions.md`,
  which a plan may also cite by reference — keeping the two namespaces distinct.
-->

## <Plan Title> {#phase-slug}

**Purpose:** <1–2 sentences. What capability ships at the end of this phase?>

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | <name> |
| Status | draft |
| Target branch | <branch> |
| Last updated | <YYYY-MM-DD> |

---

### Review Record {#review-record}

<!--
  One paragraph per review round, appended by `/tugplug:plan-review` — never
  rewritten, since the point is the history. It sits here, before the body, so a
  cold reader learns whether this plan has been reviewed and what the review
  found before investing in the rest.

  Prose, not a table: a table invites one-word entries, and the value is the
  specificity. A round that found nothing still gets a paragraph — a vacuous
  review should be visible in the artifact rather than invisible in a transcript.

  Absent until the first review; `plan lint` warns (PL023) rather than failing.

  The `plan:<hash>` token is the round's **content stamp** — the identity of the
  document the round actually read. `tugutil plan stamp` computes and inserts it
  as the review's last edit; it is never text a model types, because a hash a
  model types is a fabricated one. `tugutil plan status` compares it against the
  document on disk to report `reviewed` / `stale` / `never-reviewed`, and a round
  carrying none warns (PL025).
-->

**Round 1 — <YYYY-MM-DD>, <model>.** Reviewed `plan:<hash>`. Lint: <N> errors, <N> warnings (<N> fixed).
Oriented on: <the git diff since round <n-1> | the Review Record>.
Applied: <what changed, and why — name the axis and the specific fix>.
Deferred: <what was raised as an Open Question instead of decided>.

---

### Phase Overview {#phase-overview}

#### Context {#context}

<1–2 paragraphs. What problem are we solving, and why now?>

#### Strategy {#strategy}

<3–7 bullets. The approach and sequencing philosophy for this phase.>

#### Success Criteria (Measurable) {#success-criteria}

> Make these falsifiable. Avoid "works well".

- <criterion> (how to measure / verify)
- <criterion> (how to measure / verify)

#### Scope {#scope}

1. <Scope item>
2. <Scope item>
3. <Scope item>

#### Non-goals (Explicitly out of scope) {#non-goals}

- <Non-goal>
- <Non-goal>

#### Dependencies / Prerequisites {#dependencies}

- <Dependency>
- <Prerequisite>

#### Constraints {#constraints}

- <platform/tooling/perf/security constraints>

#### Assumptions {#assumptions}

- <assumption>
- <assumption>

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan format relies on **explicit, named anchors** and **rich `References:` lines** in execution steps.

#### 1) Use explicit anchors everywhere you will cite later

- **Technique**: append an explicit anchor to the end of a heading using `{#anchor-name}`.
  - Example (append anchor to any heading):
    - `### Design Decisions {#my-design-decisions}`
    - `#### [P01] Workspace snapshots are immutable (DECIDED) {#p01-snapshots-immutable}`
- **Why**: do not rely on auto-generated heading slugs; explicit anchors are stable when titles change.

#### 2) Anchor naming rules (lock these in)

- **Allowed characters**: lowercase `a–z`, digits `0–9`, and hyphen `-` only.
- **Style**: short, semantic, **kebab-case**, no phase numbers (anchors should survive renumbering).
- **Prefix conventions (use these consistently)**:
  - **`step-N`**: execution step anchors (e.g. `step-1`, `step-2`, `step-3`)
  - **`pNN-...`**: plan-local design decisions (`[P01]`) anchors, e.g. `{#p01-sandbox-copy}`.
    Use `P`, never `D` — `[D##]` is reserved for the global decisions in
    `design-decisions.md`, which this plan may also cite by reference.
  - **`qNN-...`**: open questions (`[Q01]`) anchors, e.g. `{#q01-import-resolution}`
  - **`rNN-...`**: risk notes (`Risk R01`) anchors, e.g. `{#r01-perf-regression}`
  - **`lNN-...`**: lists (`List L01`) anchors, e.g. `{#l01-supported-ops}`
  - **`mNN-...`**: milestones (`Milestone M01`) anchors, e.g. `{#m01-first-ship}`
  - **`sNN-...`**: specs (`Spec S01`) anchors, e.g. `{#s01-command-response}`
  - **Domain anchors**: for major concepts/sections, use a clear noun phrase, e.g. `{#cross-platform}`, `{#config-schema}`, `{#error-scenarios}`

#### 3) Stable label conventions (for non-heading artifacts)

Use stable labels so steps can cite exact plan artifacts even when prose moves around:

- **Design decisions**: `#### [P01] <Title> (DECIDED) {#p01-...}`
- **Open questions**: `#### [Q01] <Title> (OPEN) {#q01-...}`
- **Specs**: `**Spec S01: <Title>** {#s01-slug}` (or make it a `####` heading if you prefer)
- **Tables**: `**Table T01: <Title>** {#t01-slug}`
- **Lists**: `**List L01: <Title>** {#l01-slug}`
- **Risks**: `**Risk R01: <Title>** {#r01-slug}`
- **Milestones**: `**Milestone M01: <Title>** {#m01-slug}`

Numbering rules:
- Always use **two digits**: `P01`, `Q01`, `S01`, `T01`, `L01`, `R01`, `M01`.
- Never reuse an ID within a plan. If you delete one, leave the gap.
- `P##` (plan-local decisions) is distinct from `[D##]` (global decisions in
  `design-decisions.md`). A `References:` line may cite both — `[P05]` for a
  decision made *in this plan*, `[D40]` for one it inherits from the global set.

#### 4) `**Depends on:**` lines for execution step dependencies

Steps that depend on other steps must include a `**Depends on:**` line that references step anchors.

**Format:**
```markdown
**Depends on:** #step-1, #step-2
```

**Rules:**
- Use **anchor references** (`#step-N`), not step titles or numbers
- Omit the line entirely for steps with no dependencies (typically Step 1)
- Multiple dependencies are comma-separated
- Dependencies must reference valid step anchors within the document

---

#### 5) `**References:**` lines are required for every execution step

Every step must include a `**References:**` line that cites the plan artifacts it implements.

Rules:
- Cite **plan-local decisions** by ID: `[P05] ...` (global decisions, if relevant, as `[D40] ...`)
- Cite **open questions** by ID when the step resolves/de-risks them: `[Q03] ...`
- Cite **specs/lists/tables/risks/milestones** by label: `Spec S15`, `List L03`, `Tables T27-T28`, `Risk R02`, `Milestone M01`, etc.
- Cite **anchors** for deep links in parentheses using `#anchor` tokens (keep them stable).
- **Do not cite line numbers.** If you find yourself writing "lines 5–10", add an anchor and cite that instead.
- Prefer **rich, exhaustive citations**. Avoid `N/A` unless the step is truly refactor-only.

**Good References examples:**

```
**References:** [P05] Sandbox verification, [P12] Git-based undo, Spec S15, Tables T21-T25,
(#session-lifecycle, #worker-process-mgmt, #config-precedence)
```

```
**References:** [P01] Refactoring kernel, [P06] Python analyzer, List L04,
Table T05, (#op-rename, #fundamental-wall)
```

**Bad References examples (avoid these):**

```
**References:** Strategy section (lines 5–10)     ← uses line numbers
**References:** See design decisions above        ← vague, no specific citations
**References:** N/A                               ← only acceptable for pure refactor steps
```

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

> Open questions are tracked work. If a question remains open at phase-end, explicitly defer it with a rationale and a follow-up plan.

#### [Q01] <Question title> (OPEN) {#q01-question-slug}

**Question:** <what is unknown / undecided?>

**Why it matters:** <what breaks or becomes expensive if we guess wrong?>

**Options (if known):**
- <option>
- <option>

**Plan to resolve:** <prototype / benchmark / spike / research / decision meeting>

**Resolution:** OPEN / DECIDED (see [PNN]) / DEFERRED (why, and where it will be revisited)

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| <risk> | low/med/high | low/med/high | <mitigation> | <trigger> |

**Risk R01: <Title>** {#r01-risk-slug}

- **Risk:** <1 sentence>
- **Mitigation:** <1–3 bullets>
- **Residual risk:** <what remains true even after mitigation>

---

### Design Decisions {#design-decisions}

> Record *decisions* (not options). Each decision includes the "why" so later phases don't reopen it accidentally.
>
> These are **plan-local** decisions, labelled `[P01]`, `[P02]`, … Do not use `[D##]`
> — that prefix belongs to the global [design-decisions.md](design-decisions.md). When a
> plan-local decision restates or depends on a global one, cite the global by ID in the
> rationale (e.g. "follows [D40]").

#### [P01] <Decision Name> (DECIDED) {#p01-decision-slug}

**Decision:** <One sentence decision statement>

**Rationale:**
- <Why>
- <Why>

**Implications:**
- <What this forces in APIs / storage / tests>

---

### Deep Dives (Optional) {#deep-dives}

> Use this section for structured analysis that is not quite "decision" or "spec", but is critical for implementation alignment.
>
> Examples: operation analysis, end-to-end flows, protocols, schemas, sequence diagrams, CI/CD shape, cross-platform strategy, perf notes, rejection rationale.

#### <Topic Title> {#topic-slug}

<Write-up, diagrams, tables, and any referenced specs/lists/tables.>

---

### Specification {#specification}

> This section is the contract. Pick the subsections that apply to your plan; omit the rest.

- **Inputs and Outputs**: data model, invariants, supported formats
- **Terminology and Naming**: key terms and their definitions
- **Supported Features**: exhaustive list; include what is explicitly not supported
- **Modes / Policies**: behavioral variants, flags, policies
- **Semantics**: normative rules, traversal order, edge cases
- **Error and Warning Model**: error fields, warning fields, path formats
- **Public API Surface**: Rust/Python/language signatures
- **Internal Architecture**: component relationships, pipeline, ownership
- **Output Schemas**: CLI output, API responses, wire formats (contract)
- **Configuration Schema**: config file format, precedence, CLI flag mapping

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

> For frontend work, map every new piece of state to a tuglaws zone *before*
> writing code — the zone dictates the mechanism, and getting it wrong is the most
> common law violation. Omit this subsection for non-frontend plans.

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `<state>` | <zone> | CSS+DOM / useState+useRef / store + useSyncExternalStore / useLayoutEffect | [L24], [L06], [L02], [L22] |

---

### Compatibility / Migration / Rollout (Optional) {#rollout}

> Use this section when you are changing public APIs, config formats, CLI contracts, or anything that affects adopters.

- **Compatibility policy**: <semver? schema versioning?>
- **Migration plan**:
  - <what changes>
  - <who is impacted>
  - <how to migrate, and how to detect breakage>
- **Rollout plan**:
  - <opt-in flag / staged rollout / canary / feature gate>
  - <rollback strategy>

---

### Definitive Symbol Inventory {#symbol-inventory}

> A concrete list of new crates/files/symbols to add. This is what keeps implementation crisp.

#### New crates (if any) {#new-crates}

| Crate | Purpose |
|-------|---------|
| `<crate>` | <purpose> |

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| `<path>` | <purpose> |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `<Name>` | enum/struct/fn | `<path>` | <notes> |

---

### Documentation Plan {#documentation-plan}

- [ ] <Docs update>
- [ ] <Examples / schema examples / API docs>

---

### Test Plan Concepts {#test-plan-concepts}

> Describe the kinds of tests that prove the spec. Leave the actual enumeration of tests to the Execution Steps below.

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Test individual functions/methods in isolation | Core logic, edge cases, error paths |
| **Integration** | Test components working together | End-to-end operations, CLI commands |
| **Golden / Contract** | Compare output against known-good snapshots | Schemas, APIs, parsers, serialization |
| **Drift Prevention** | Detect unintended behavior changes | Regression testing, API stability |

#### What stays out of tests {#test-non-goals}

> Name what you are deliberately *not* testing, and why. This keeps reviewers from
> reading a coverage gap as an oversight, and steers authors away from low-value tests
> the project bans (e.g. mock-store assertion tests, fake-DOM render tests).

- <area not tested> — <why (covered elsewhere / not worth the brittleness / banned pattern)>

---

### Execution Steps {#execution-steps}

> Execution comes last. Each step should be executable, with a clear commit boundary and a checkpoint.
>
> **Commit after all checkpoints pass.** This rule applies to every step below.
>
> **Patterns:**
> - If a step is large, split the work into multiple **flat steps** (`Step N`, `Step N+1`, …) with separate commits and checkpoints, each with explicit `**Depends on:**` lines.
> - After completing a group of related flat steps, add a lightweight **Integration Checkpoint step** that depends on all constituent steps and verifies they work together. Integration checkpoint steps use `Commit: N/A (verification only)` to signal no separate commit.
>
> **References are mandatory:** Every step must cite specific plan artifacts ([P01], Spec S01, Table T01, etc.) and anchors (#section-name). Never cite line numbers—add an anchor instead.
>
> **Step numbers are identity, not decoration.** Every step heading must read `Step N: <Title>` with an integer `N` — the anchor, the ledger row, the step verbs, and every display key the run's progress by it. An unnumbered step heading fails lint (PL026), and a plan with execution steps but no Step Status Ledger fails lint (PL027): both describe a plan the machinery cannot drive.

#### Step Status Ledger {#step-status-ledger}

> A single at-a-glance table of every step and its current state. `/tugplug:dash-implement`
> reads this to know where to resume (which step is the first `pending`), to scope a
> step range, and to mark progress. Keep it in sync as steps land — flip `pending` →
> `in progress` → `done` (record the commit). It is the plan's source of truth for "where are we?".

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | <title> | pending | — |
| #step-2 | <title> | pending | — |

#### Step 1: <Prep Step Title> {#step-1}

<!-- Step 1 typically has no dependencies (it is the root) -->

**Commit:** `<conventional-commit message>`

**References:** [P01] <decision name>, (#strategy, #context)

**Artifacts:** (what this step produces/changes)
- <new files / new commands / new schema fields / new docs>

**Tasks:**
- [ ] <task>
- [ ] <task>

**Tests:**
- [ ] <T test>
- [ ] <T test>

**Checkpoint:**
- [ ] <command>
- [ ] <command>

---

#### Step 2: <Step Title> {#step-2}

**Depends on:** #step-1

**Commit:** `<conventional-commit message>`

**References:** [P02] <decision>, [P03] <decision>, Spec S01, List L01, (#terminology, #semantics)

**Artifacts:** (what this step produces/changes)
- <new files / new commands / new schema fields / new docs>

**Tasks:**
- [ ] <task>
- [ ] <task>

**Tests:**
- [ ] <T test>
- [ ] <T test>

**Checkpoint:**
- [ ] <command>
- [ ] <command>

---

#### Step 3: <First Part of Big Work Title> {#step-3}

**Depends on:** #step-2

**Commit:** `<conventional-commit message>`

**References:** [P04] <decision>, Spec S02, Table T01, (#inputs-outputs)

**Artifacts:** (what this step produces/changes)
- <artifact>

**Tasks:**
- [ ] <task>

**Tests:**
- [ ] <test>

**Checkpoint:**
- [ ] <command>

---

#### Step 4: <Second Part of Big Work Title> {#step-4}

**Depends on:** #step-3

**Commit:** `<conventional-commit message>`

**References:** [P05] <decision>, (#public-api)

**Artifacts:** (what this step produces/changes)
- <artifact>

**Tasks:**
- [ ] <task>

**Tests:**
- [ ] <test>

**Checkpoint:**
- [ ] <command>

---

#### Step 5: Integration Checkpoint {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `N/A (verification only)`

**References:** [P04] <decision>, [P05] <decision>, (#success-criteria)

**Tasks:**
- [ ] Verify all artifacts from Steps 3 and 4 are complete and work together

**Tests:**
- [ ] <aggregate test verifying end-to-end behavior>

**Checkpoint:**
- [ ] `<aggregate verification command covering all related steps>`

---

### Deliverables and Checkpoints {#deliverables}

> This is the single place we define "done" for the phase. Keep it crisp and testable.

**Deliverable:** <One sentence deliverable>

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] <criterion> (verification)
- [ ] <criterion> (verification)

**Acceptance tests:**
- [ ] <T test>
- [ ] <T test>

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] <follow-on item>
- [ ] <follow-on item>

| Checkpoint | Verification |
|------------|--------------|
| <checkpoint> | <command/test/proof> |

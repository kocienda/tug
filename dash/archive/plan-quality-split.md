# Plan Quality Split: Separate Conformance from Criticism

## Problem

The `critic-agent` currently has two distinct responsibilities:

1. **Plan conformance** — Verifying that the plan follows the `tugplan-skeleton.md` format: correct headings, anchors, required sections, decision formatting, step structure, etc. This is largely mechanical. The critic already delegates the heaviest part to `tugcode validate --json --level strict`, then checks the output.

2. **Plan quality** — Assessing whether the plan is actually *good*: internally consistent, technically sound, practically implementable, free of holes and pitfalls. This requires deep reasoning, codebase exploration, and domain understanding.

These responsibilities pull in opposite directions. Conformance is a deterministic gate — pass or fail. Quality is a judgment call that benefits from depth, nuance, and iteration. By combining them in one agent, the critic's context window fills with structural minutiae (anchor format, heading order, missing `**References:**` lines) before it even gets to the hard questions: *Will this actually work? Are the technical choices sound? What will go wrong during implementation?*

The result is plans that pass structural validation but still need significant revision for implementation readiness. The gap is filled manually — by submitting the plan to another coding assistant for the deep quality review the critic should have done.

## Proposal

Split the `critic-agent` into two agents with clearly separated concerns:

| Agent | Responsibility | Character |
|-------|---------------|-----------|
| **conformance-agent** (new) | Skeleton compliance, structural validation, format correctness | Mechanical, deterministic, fast |
| **critic-agent** (revised) | Plan quality, technical soundness, internal consistency, implementability | Deep, analytical, adversarial |

The `tugplug:plan` skill runs both agents **in parallel** after the author produces a plan. Both must APPROVE for the plan to pass. If either recommends REVISE or ESCALATE, their full feedback payloads flow back to the author — intact, unmodified, no data munging.

---

## Full Data Flow

This is the authoritative specification of how data moves between agents. Every payload is passed as-is. The skill never summarizes, reformats, or combines agent outputs.

### Pass 0 (First Draft)

```
                                    ┌─────────────────────┐
 user idea + clarifier output ─────►│    author-agent     │
                                    │  (FRESH spawn)      │
                                    └──────────┬──────────┘
                                               │
                                      author_output JSON
                                               │
                              ┌────────────────┼────────────────┐
                              │                                 │
                              ▼                                 ▼
                   ┌──────────────────┐              ┌──────────────────┐
                   │ conformance-agent│              │   critic-agent   │
                   │  (FRESH spawn)   │              │  (FRESH spawn)   │
                   └────────┬─────────┘              └────────┬─────────┘
                            │                                 │
                  conformance_output                   critic_output
                            │                                 │
                            └────────────┬────────────────────┘
                                         │
                                         ▼
                                    ┌──────────┐
                                    │   skill  │  (evaluates both recommendations)
                                    └──────────┘
```

### Revision Loop

```
                                     ┌─────────────────────────────────┐
 conformance_output (full JSON) ────►│                                 │
 critic_output (full JSON) ─────────►│        author-agent             │
 critic_question_answers (if any) ──►│        (RESUME)                 │
                                     └──────────────┬──────────────────┘
                                                    │
                                           author_output JSON
                                                    │
                              ┌─────────────────────┼─────────────────────┐
                              │                                           │
                              ▼                                           ▼
                   ┌──────────────────┐                        ┌──────────────────┐
                   │ conformance-agent│                        │   critic-agent   │
                   │  (RESUME)        │                        │  (RESUME)        │
                   │  receives:       │                        │  receives:       │
                   │  author_output   │                        │  author_output   │
                   └────────┬─────────┘                        └────────┬─────────┘
                            │                                           │
                  conformance_output                             critic_output
                            │                                           │
                            └──────────────────┬────────────────────────┘
                                               │
                                               ▼
                                          ┌──────────┐
                                          │   skill  │
                                          └──────────┘
```

### Key Principle: No Data Munging

The skill passes agent outputs as complete JSON objects. It does not:
- Summarize or excerpt agent outputs
- Combine two outputs into one merged object
- Extract fields from one agent's output to construct a different shape
- Paraphrase or reformat findings

Each agent receives the full, unmodified output of the agents it depends on, under distinct named fields.

---

## Agent Contracts

### Conformance Agent

#### Input Contract (Fresh Spawn)

```json
{
  "plan_path": ".tugtool/tugplan-<slug>.md",
  "skeleton_path": ".tugtool/tugplan-skeleton.md"
}
```

#### Input Contract (Resume)

The skill resumes the conformance-agent with the author's full output so it knows what changed:

```
Author has revised the plan. Author output: <author_output JSON>.
Re-check conformance focusing on whether prior violations were fixed.
```

The `author_output` is the complete author output JSON (see Author Output Contract below). The conformance-agent uses `plan_path` from it to re-read the plan, and `sections_written` to focus on what changed.

#### Output Contract

```json
{
  "skeleton_compliant": true,
  "validation_result": {
    "passed": true,
    "error_count": 0,
    "warning_count": 0,
    "diagnostic_count": 0,
    "issues": [],
    "diagnostics": []
  },
  "structural_issues": [
    {
      "rule": "steps-have-depends-on",
      "location": "Step 3 {#step-3}",
      "description": "Missing **Depends on:** line (required for all steps except Step 0)",
      "suggestion": "Add **Depends on:** #step-2 based on artifact dependencies"
    }
  ],
  "recommendation": "APPROVE"
}
```

| Field | Description |
|-------|-------------|
| `skeleton_compliant` | True only if `tugcode validate --level strict` passes AND no structural issues found |
| `validation_result.passed` | True if `tugcode validate` returned valid with no diagnostics |
| `validation_result.error_count` | Errors from `tugcode validate` |
| `validation_result.warning_count` | Warnings from `tugcode validate` |
| `validation_result.diagnostic_count` | P-code diagnostics from `tugcode validate` |
| `validation_result.issues` | Error/warning messages from `tugcode validate` (verbatim) |
| `validation_result.diagnostics` | P-code diagnostic messages from `tugcode validate` (verbatim) |
| `structural_issues` | Issues the conformance-agent found beyond what `tugcode validate` checks |
| `structural_issues[].rule` | Which structural rule was violated |
| `structural_issues[].location` | Where in the plan (step, section, heading) |
| `structural_issues[].description` | What's wrong |
| `structural_issues[].suggestion` | How to fix it |
| `recommendation` | `APPROVE` / `REVISE` / `ESCALATE` |

#### Recommendation Logic

```
if tugcode validate reports errors → ESCALATE
if tugcode validate reports diagnostics (P-codes) → ESCALATE
if any structural_issues found → REVISE
else → APPROVE
```

#### Model and Tools

- **Model:** Sonnet (conformance is mechanical)
- **Tools:** Read, Grep, Glob, Bash (Bash restricted to `tugcode validate` only)

---

### Revised Critic Agent

#### Input Contract (Fresh Spawn)

```json
{
  "plan_path": ".tugtool/tugplan-<slug>.md"
}
```

No `skeleton_path` — the critic does not check conformance.

#### Input Contract (Resume)

The skill resumes the critic-agent with the author's full output AND any answers to the critic's prior clarifying questions:

```
Author has revised the plan. Author output: <author_output JSON>.
User answered your clarifying questions: <critic_question_answers JSON>.
Re-review focusing on whether prior findings were addressed and questions resolved.
```

If there were no clarifying questions, the `critic_question_answers` field is `null`.

#### Output Contract

```json
{
  "findings": [
    {
      "severity": "HIGH",
      "area": "internal_consistency",
      "title": "Round/audit trail model is internally inconsistent",
      "description": "The design says each agent run should be a recorded round, but [D06] decides to skip round creation when commit is skipped. This weakens traceability and makes dash_rounds semantically ambiguous.",
      "references": ["[D06]", "Spec S03", "(#s03-dash-commit)"],
      "suggestion": "Always record a round row; make commit_hash nullable instead of skipping the row entirely"
    }
  ],
  "assessment": {
    "quality": "Strong overall. The proposal is detailed, test-minded, and implementation-oriented.",
    "coherence": "Mostly coherent, with spec-level contradictions that should be resolved before coding.",
    "technical_choices": "Good reuse of existing infrastructure and clean separation from plan/implement.",
    "implementation_strategy": "Sensible order. Biggest risk is lifecycle correctness under failure."
  },
  "clarifying_questions": [
    {
      "question": "Should a dash round represent every agent invocation, or only invocations that produce a commit?",
      "context": "D06 says skip silently, but the round table implies full audit trail. These are contradictory.",
      "impact": "Affects dash_rounds schema, commit subcommand behavior, and show display"
    }
  ],
  "area_ratings": {
    "internal_consistency": "WARN",
    "technical_soundness": "PASS",
    "implementability": "PASS",
    "completeness": "WARN",
    "risk_feasibility": "PASS"
  },
  "recommendation": "REVISE"
}
```

| Field | Description |
|-------|-------------|
| `findings` | Prioritized list of issues found |
| `findings[].severity` | `CRITICAL` / `HIGH` / `MEDIUM` / `LOW` |
| `findings[].area` | Which review area: `internal_consistency`, `technical_soundness`, `implementability`, `completeness`, `risk_feasibility` |
| `findings[].title` | Short title for the finding |
| `findings[].description` | Detailed explanation with specific references to plan sections |
| `findings[].references` | Plan anchors, decision IDs, spec labels cited |
| `findings[].suggestion` | Concrete suggestion for how to fix |
| `clarifying_questions` | Questions the critic cannot answer from the plan + codebase alone |
| `clarifying_questions[].question` | The question itself |
| `clarifying_questions[].context` | Why this question matters — what contradiction or gap prompted it |
| `clarifying_questions[].impact` | What parts of the plan are affected by the answer |
| `assessment` | Narrative assessment of overall plan quality |
| `assessment.quality` | Overall quality judgment |
| `assessment.coherence` | Internal consistency and contradictions |
| `assessment.technical_choices` | Appropriateness of technical decisions |
| `assessment.implementation_strategy` | Soundness of step ordering and strategy |
| `area_ratings` | Per-area rating: `PASS` / `WARN` / `FAIL` |
| `recommendation` | `APPROVE` / `REVISE` / `ESCALATE` |

#### Review Areas

**1. Internal Consistency**
- Do design decisions contradict each other?
- Do execution steps implement what the spec says?
- Do success criteria match what the steps actually deliver?
- Are terms used consistently (terminology section vs. usage in steps)?
- Do cross-references resolve correctly (a step cites [D05] but D05 says something different)?

**2. Technical Soundness**
- Are the technical choices appropriate for the problem?
- Are there better alternatives the plan should have considered?
- Will the chosen approach scale / perform / integrate correctly?
- Are error handling and failure modes adequately addressed?
- Are there concurrency, ordering, or state-consistency risks?

**3. Implementability**
- Can each step be executed by a coding agent without inventing requirements?
- Are the artifacts, tasks, and tests specific enough to be unambiguous?
- Are dependencies between steps correct and complete?
- Will checkpoint commands actually pass given the planned changes?
- **Source code verification (V1-V5):**
  - V1: Read every file listed in Artifacts; verify referenced functions/structs exist with correct signatures
  - V2: Verify type cascades — when a function signature changes, grep all call sites and verify every caller is updated in the same step
  - V3: Verify struct/type field compatibility — when switching types, ensure equivalent fields exist or derivation is planned
  - V4: Verify symbol coverage — grep all usages of modified/removed symbols across the whole codebase
  - V5: Verify checkpoint feasibility — will the build/test commands actually pass?

**4. Completeness and Gaps**
- Are there missing steps that the plan assumes but doesn't specify?
- Are edge cases and error paths covered?
- Are rollback procedures realistic?
- Are non-goals actually non-goals, or are some of them implicit requirements?
- Does the plan account for existing code patterns and conventions in the codebase?

**5. Risk and Feasibility**
- What are the highest-risk steps and why?
- Are there implicit ordering constraints that the dependency graph doesn't capture?
- Are there assumptions that might not hold?
- Is the overall scope realistic for the strategy described?

#### Severity Levels

| Level | Meaning | Effect |
|-------|---------|--------|
| **CRITICAL** | Will cause implementation failure | Blocks — ESCALATE |
| **HIGH** | Significant gap, likely to cause rework | Blocks — REVISE |
| **MEDIUM** | Quality concern, suboptimal but workable | Warns, does not block alone |
| **LOW** | Suggestion or minor improvement | Informational |

#### Recommendation Logic

```
if any CRITICAL finding → ESCALATE
else if any HIGH finding → REVISE
else if any area_rating is FAIL → REVISE
else if clarifying_questions is non-empty → REVISE
else → APPROVE
```

Clarifying questions are blocking. If the critic can't determine plan correctness without answers, the plan isn't ready.

#### Model and Tools

- **Model:** Opus (quality review requires deep reasoning and codebase exploration)
- **Tools:** Read, Grep, Glob, Bash (Bash only for build/test feasibility checks, NOT for `tugcode validate`)

---

### Updated Author Agent

The author's input and revision behavior must change to handle two feedback sources with different schemas.

#### Input Contract (Fresh Spawn) — CHANGED

```json
{
  "idea": "string | null",
  "plan_path": "string | null",
  "user_answers": { ... },
  "clarifier_assumptions": ["string"],
  "conformance_feedback": null,
  "critic_feedback": null,
  "critic_question_answers": null
}
```

New fields (all null on first spawn):

| Field | Type | Description |
|-------|------|-------------|
| `conformance_feedback` | conformance output JSON or null | Full conformance-agent output (see Conformance Output Contract) |
| `critic_feedback` | critic output JSON or null | Full critic-agent output (see Critic Output Contract) |
| `critic_question_answers` | object or null | User's answers to the critic's clarifying questions, keyed by question text |

Removed field:
- ~~`critic_feedback`~~ (old shape: `{ skeleton_compliant, skeleton_check, areas, issues, recommendation }`) — replaced by the two new fields above

#### Input Contract (Resume) — CHANGED

On resume, the skill sends:

```
Revise the plan based on review feedback.

Conformance feedback: <conformance_feedback JSON>
Critic feedback: <critic_feedback JSON>
User answers to critic questions: <critic_question_answers JSON>
```

Each JSON payload is the complete, unmodified output from the respective agent. The author parses each one according to its schema.

#### Output Contract — UNCHANGED

```json
{
  "plan_path": ".tugtool/tugplan-<slug>.md",
  "created": true,
  "sections_written": ["plan-metadata", "phase-overview", "design-decisions", "execution-steps", "deliverables"],
  "skeleton_compliance": {
    "read_skeleton": true,
    "has_explicit_anchors": true,
    "has_required_sections": true,
    "steps_have_references": true
  },
  "validation_status": "valid"
}
```

No changes needed to the output shape. The author's output is consumed by the skill and passed through to the conformance-agent and critic-agent on resume.

#### Revision Behavior — CHANGED

When revision feedback is present, the author handles each source independently:

**From `conformance_feedback`** (when non-null and recommendation is not APPROVE):
1. Read `conformance_feedback.validation_result.issues` and `conformance_feedback.validation_result.diagnostics` — fix any format errors flagged by `tugcode validate`
2. Read `conformance_feedback.structural_issues` array — each issue has `rule`, `location`, `description`, `suggestion`. Fix the specific structural problems at the indicated locations.
3. These are mechanical fixes: add missing `**Depends on:**` lines, fix anchor format, add missing `**References:**` citations, etc.

**From `critic_feedback`** (when non-null and recommendation is not APPROVE):
1. Read `critic_feedback.findings` array — each finding has `severity`, `area`, `title`, `description`, `references`, `suggestion`.
2. Prioritize by severity: address CRITICAL and HIGH findings first.
3. For `implementability` findings (especially source verification V1-V5): **read the source files referenced in the finding first** to understand the actual codebase state, then adjust the plan's artifacts, tasks, or step boundaries.
4. For `internal_consistency` findings: resolve the contradiction described, choosing one side or rewriting both to be consistent.
5. For `technical_soundness` findings: evaluate the suggestion, read relevant codebase code if needed, and either adopt the suggestion or document why the current approach is preferred (add to design decisions or assumptions).
6. For `completeness` findings: add the missing coverage — edge cases, error paths, steps, etc.
7. For `risk_feasibility` findings: add mitigations, adjust step ordering, or add constraints/assumptions.
8. Read `critic_feedback.assessment` for overall context on what the critic thinks of the plan's quality and strategy.

**From `critic_question_answers`** (when non-null):
1. Each key is a question text from `critic_feedback.clarifying_questions[].question`; the value is the user's answer.
2. For each answered question: find the plan sections affected (use `critic_feedback.clarifying_questions[].impact` to locate them) and incorporate the user's answer. This may mean:
   - Adding or modifying a design decision
   - Changing a spec or step behavior
   - Adding an assumption or constraint
   - Adjusting success criteria
3. The answer is authoritative — it resolves the ambiguity the critic identified.

**Ordering:** Fix conformance issues first (they're mechanical and quick), then address critic findings (they require thought and may involve codebase exploration).

---

## Updated Plan Skill Orchestration

### Current Flow

```
clarifier → author → critic → (loop if REVISE/ESCALATE)
```

### Proposed Flow

```
clarifier → author → [conformance + critic in parallel] → (loop if either REVISE/ESCALATE)
```

### State Variables

```
clarifier_id = null
author_id = null
conformance_id = null
critic_id = null
conformance_feedback = null
critic_feedback = null
critic_question_answers = null
revision_count = 0
```

### Step 1: Clarifier (unchanged)

Runs once on first pass. Same as current.

### Step 2: Author (first pass)

```
Task(
  subagent_type: "tugplug:author-agent",
  prompt: '{
    "idea": "<idea>",
    "plan_path": null,
    "user_answers": <user_answers>,
    "clarifier_assumptions": <assumptions>,
    "conformance_feedback": null,
    "critic_feedback": null,
    "critic_question_answers": null
  }',
  description: "Create plan document"
)
```

Save `agentId` as `author_id`. Store `author_output`.

### Step 3: Conformance + Critic (parallel)

Both agents are spawned/resumed in a single message with two Task calls:

**First pass — FRESH spawn both:**

```
// These two Task calls go in ONE message (parallel)

Task(
  subagent_type: "tugplug:conformance-agent",
  prompt: '{"plan_path": "<plan_path>", "skeleton_path": ".tugtool/tugplan-skeleton.md"}',
  description: "Check plan conformance"
)

Task(
  subagent_type: "tugplug:critic-agent",
  prompt: '{"plan_path": "<plan_path>"}',
  description: "Review plan quality"
)
```

Save `agentId`s as `conformance_id` and `critic_id`. Store both outputs.

**Revision loop — RESUME both:**

```
// These two Task calls go in ONE message (parallel)

Task(
  resume: "<conformance_id>",
  prompt: 'Author has revised the plan. Author output: <author_output JSON>. Re-check conformance focusing on whether prior violations were fixed.',
  description: "Re-check plan conformance"
)

Task(
  resume: "<critic_id>",
  prompt: 'Author has revised the plan. Author output: <author_output JSON>. User answered your clarifying questions: <critic_question_answers JSON>. Re-review focusing on whether prior findings were addressed and questions resolved.',
  description: "Re-review plan quality"
)
```

Both agents receive the author's full, unmodified output JSON. The critic also receives the user's answers to its prior clarifying questions (or null if there were none).

### Step 4: Handle Results

After both agents complete:

```
conformance_feedback = conformance_output  // stored as-is
critic_feedback = critic_output            // stored as-is
```

**If critic has clarifying questions AND recommendation is REVISE:**

```
AskUserQuestion(
  questions: [
    // Map each critic clarifying question to an AskUserQuestion question.
    // Use the question's `context` and `impact` fields to build the description.
    {
      question: "<critic_question.question>",
      header: "<short label derived from question>",
      options: [
        // The skill must derive reasonable options from the question context,
        // or use open-ended options if the question doesn't have obvious choices.
        { label: "Option A", description: "<based on context>" },
        { label: "Option B", description: "<based on context>" }
      ],
      multiSelect: false
    }
  ]
)
```

Store user answers as `critic_question_answers` — keyed by question text.

**Evaluate combined recommendation:**

```
if conformance.recommendation == ESCALATE or critic.recommendation == ESCALATE:
    AskUserQuestion: "Start over / Accept as-is / Abort"
    if Start over → go to Step 5 (resume author)
    if Accept → done
    if Abort → halt

else if conformance.recommendation == REVISE or critic.recommendation == REVISE:
    AskUserQuestion: "Revise / Accept as-is / Abort"
    if Revise → go to Step 5 (resume author)
    if Accept → done
    if Abort → halt

else:  // both APPROVE
    → done
```

### Step 5: Resume Author with Combined Feedback

```
Task(
  resume: "<author_id>",
  prompt: 'Revise the plan based on review feedback.

Conformance feedback: <conformance_feedback JSON>
Critic feedback: <critic_feedback JSON>
User answers to critic questions: <critic_question_answers JSON>',
  description: "Revise plan from review feedback"
)
```

All three payloads are passed as complete JSON. The author knows each schema.

After author completes: increment `revision_count`, go to Step 3 (parallel review again).

### Progress Reporting

**conformance-agent:**
```
**tugplug:conformance-agent**(Complete)
  Recommendation: {recommendation}
  Skeleton: {skeleton_compliant ? "compliant" : "non-compliant"}
  Validation: {validation_result.error_count} errors, {validation_result.diagnostic_count} diagnostics
  Structural issues: {structural_issues.length}
```

**critic-agent:**
```
**tugplug:critic-agent**(Complete)
  Recommendation: {recommendation}
  Areas: consistency {area_ratings.internal_consistency} | soundness {area_ratings.technical_soundness} | implementability {area_ratings.implementability} | completeness {area_ratings.completeness} | risk {area_ratings.risk_feasibility}
  Findings: {findings.length} ({count by severity: N CRITICAL, N HIGH, N MEDIUM, N LOW — omit zeros})
  Clarifying questions: {clarifying_questions.length}
  Assessment: {assessment.quality} (first sentence only)
```

On revision loops, use `(Complete, revision {N})`.

### Persistent Agent Pattern (updated)

| Agent | Spawned | Resumed For | Accumulated Knowledge |
|-------|---------|-------------|----------------------|
| **clarifier** | First pass | Not resumed | Codebase patterns, user answers |
| **author** | First pass | Revision loops | Skeleton format, plan structure, what it wrote, both feedback schemas |
| **conformance** | First pass | Revision loops | Skeleton rules, validation patterns, prior violations |
| **critic** | First pass | Revision loops | Codebase state, prior findings, quality standards, answered questions |

---

## What Changes

| Artifact | Change |
|----------|--------|
| `tugplug/agents/critic-agent.md` | **Rewrite:** Remove all conformance logic (skeleton check, `tugcode validate` call, `skeleton_compliant`, `skeleton_check` output fields). Add five review areas, findings with rich structure, assessment narrative, clarifying questions. New output contract. New input contract (no `skeleton_path`). |
| `tugplug/agents/conformance-agent.md` | **New file:** Extracted from critic-agent's "Phase 1". Runs `tugcode validate`, checks structural rules. Sonnet model. Own input/output contracts. |
| `tugplug/agents/author-agent.md` | **Modify:** Input contract gains `conformance_feedback` and `critic_question_answers` fields, replaces old `critic_feedback` shape. "Handling Critic Feedback" section rewritten to handle both feedback sources independently. Revision ordering specified (conformance fixes first, then critic findings). Critic question answer incorporation behavior added. |
| `tugplug/skills/plan/SKILL.md` | **Modify:** State variables add `conformance_id`, `conformance_feedback`, `critic_question_answers`. Parallel dispatch of conformance + critic. Combined recommendation evaluation. Critic question → `AskUserQuestion` → `critic_question_answers` flow. Updated resume prompts to carry both payloads. Updated progress reporting format. Updated agent table. |

## What Stays the Same

- `tugplug/agents/clarifier-agent.md` — no changes
- `tugcode validate` command — no changes (conformance-agent calls it the same way)
- `.tugtool/tugplan-skeleton.md` — no changes
- Author output contract — no changes (same shape consumed by skill and passed through to reviewers)
- Overall loop shape (clarifier → author → review → revise loop) — preserved; the review step is parallelized

---

## Design Rationale

**Why split rather than improve the existing critic?** Conformance is mechanical; quality review is analytical. Splitting lets each agent use the right model (Sonnet vs Opus) and keeps context windows focused. The conformance-agent doesn't waste Opus tokens on format checks. The critic doesn't waste context on anchor validation.

**Why run in parallel rather than sequentially?** The conformance-agent (Sonnet, mechanical) finishes fast. The critic (Opus, deep analysis) is slow. Parallel execution means total review time is max(conformance, critic) rather than the sum.

**Why are clarifying questions blocking?** If the critic can't determine plan correctness without answers, approving the plan is premature. The questions represent genuine ambiguity that will surface during implementation as confusion, wasted effort, or wrong decisions. Better to resolve them in the planning loop.

**Why does the author need contract changes?** Because the author now receives two structurally different feedback payloads. The old `critic_feedback` field carried conformance AND quality in one shape (`skeleton_check` + `areas` + `issues`). The new design separates these into `conformance_feedback` (with `validation_result` + `structural_issues`) and `critic_feedback` (with `findings` + `assessment` + `clarifying_questions` + `area_ratings`). The author must know both schemas to address them correctly. Pretending the author can handle this without changes would mean the skill has to munge the two outputs into the old shape — which defeats the purpose.

**Why not run conformance as a hard gate before the critic?** The author already self-validates with `tugcode validate` before returning, so structural failures on first pass should be rare. Parallel is faster in the common case. The skill can short-circuit if conformance returns ESCALATE (plan unparseable), but this is the exception, not the rule.

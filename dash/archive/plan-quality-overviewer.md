# Plan Quality Overviewer: Fresh-Eyes Terminal Gate

## Problem

The `tugplug:plan` skill produces plans that pass its internal review process but still have real, significant issues visible to any fresh reader. Taking a "final approved" plan and giving it to another LLM with a simple investigative prompt consistently produces HIGH-severity findings that the critic-author loop missed.

This happened with `tugplan-checklist-reconciliation.md` (revision 4, approved by critic and conformance). A simple "investigate the proposal, find holes" prompt found:

- **3 HIGH findings:** internal contradiction in Step-0 task list, string-fragile recovery failure classification, manual recovery guidance conflicting with deferred semantics
- **3 MEDIUM findings:** muddled `state show --checklist --json` expectation, philosophical inconsistency between "agents should not count" and required ordinal contract, recovery loop retrying non-retryable errors
- **1 LOW finding:** docs-only mitigation for multi-line Bash may be insufficient
- **8 clarifying questions** the plan left unresolved

The plan-quality-split (separating conformance from criticism, giving the critic V1-V5 source verification and 5 quality areas) was supposed to close this gap. It didn't. The critic's *instructions* are thorough. The problem is execution depth.

## Root Cause Analysis

The missed findings fall into three categories:

### 1. Plan-text contradictions the critic should catch by reading carefully

The plan says to "pass the new `complete_remaining` flag through" but also says to "update the existing caller to pass `false` for backward compatibility." These can't both be true. Similarly, the plan's strategy says "agents should not count" but the coder-agent contract still REQUIRES ordinals. These are pure reading-comprehension issues — no source code needed.

### 2. Source-code mismatches the critic should catch with V1-V5

The plan proposes recovery logic that keys off warning text strings, but commit.rs emits freeform strings — any wording change breaks detection. The plan recommends `state reconcile` in escalations, but reconcile force-completes all items, erasing deferred state. The plan references `state show --checklist --json`, but JSON mode returns `plan` regardless of the `--checklist` flag. The critic is told to verify these claims against source code (V1-V5). It didn't.

### 3. Completeness/risk gaps the critic should catch in areas 4-5

Only drift gets early exit in the recovery loop; ownership mismatch, DB errors, etc. need escalation buckets too. Docs-only mitigation for multi-line Bash is insufficient without enforcement.

### Why the critic misses these despite good instructions

**Accumulated context bias.** By revision 4, the critic has 4 rounds of findings, author outputs, and clarifying question answers in its context. It focuses on "were my prior findings addressed?" not "is this plan actually ready?" Each revision round narrows attention to previously-flagged issues.

**Author-critic convergence.** The author and critic negotiate toward mutual agreement through the revision loop. The author makes targeted fixes for specific findings; the critic checks those fixes. Neither steps back to see the whole picture. This is a closed system that converges on local optima.

**Context window exhaustion.** After multiple revision rounds, the critic's context is dominated by process metadata (prior findings, author outputs, revision history) rather than the plan and source code. Less context remains for deep V1-V5 investigation.

**Checklist-induced shallowness.** The structured V1-V5 + 5-area framework pushes toward systematic breadth at the expense of investigative depth. The critic checks boxes rather than deeply investigating any single concern. The GPT reviewer had no checklist — just "find everything wrong" — and went deeper.

These are not fixable by improving the critic's prompt. The critic's prompt is already thorough. The problem is structural: **a reviewer who has been iterating on a document through multiple revision rounds cannot see it with fresh eyes.** This is true for humans and true for LLMs.

## Proposal: Add an Overviewer Agent

Add a new `overviewer-agent` that runs as a terminal quality gate after both conformance-agent and critic-agent approve. Its distinguishing properties:

| Property | Critic | Overviewer |
|----------|--------|----------|
| **Context** | Accumulated across revision rounds | Fresh spawn every time |
| **Framing** | Systematic (5 areas + V1-V5 checklist) | Investigative ("find everything wrong") |
| **Prior knowledge** | Remembers its own findings and author responses | Sees only the plan and codebase — no review history |
| **When it runs** | Every revision round | Only after critic + conformance approve |
| **Focus** | Verification of specific claims | Holistic "would this actually work?" |

### Why a new agent instead of improving the critic

The critic-author loop is a closed system. Making the critic's checklist longer or more detailed won't help — the fundamental issue is accumulated context bias and convergence. The same reviewer, no matter how skilled, loses perspective after multiple rounds of back-and-forth on the same document. You need a fresh reader.

This is analogous to code review: the reviewer you've been pair-programming with will miss things that a fresh reviewer catches instantly.

### Overviewer Agent Design

**Model:** Opus (deep reasoning required, same as critic)

**Tools:** Read, Grep, Glob, Bash (Bash only for build/test feasibility checks)

**Input:** Plan path only — no critic findings, no conformance results, no revision history.

```json
{
  "plan_path": ".tugtool/tugplan-<slug>.md"
}
```

**Prompt framing (the core of the agent):**

The overviewer does NOT use the critic's structured 5-area + V1-V5 framework. Instead, it uses the investigative prompt that works in practice:

> Read the plan. Read the source code it references. Investigate the proposal thoroughly. Ask clarifying questions. Give your assessment on its quality, coherence, the technical choices, and the implementation strategies. Do you see holes, pitfalls, weaknesses, or limitations? Could a coder follow this plan literally, step by step, and produce a working result?

The freedom from structured output categories enables deeper investigation. The overviewer follows its nose rather than checking boxes.

**Output contract:**

```json
{
  "findings": [
    {
      "id": "OF1",
      "severity": "HIGH",
      "title": "Step-0 task list has internal contradiction",
      "description": "Plan says to pass the new flag through, but also says to pass false for backward compatibility. These cannot both be true for the main batch path.",
      "code_evidence": "commit.rs:1-35 shows freeform warning strings, not structured codes",
      "suggestion": "Resolve the contradiction: always pass complete_remaining=true after reviewer APPROVE"
    }
  ],
  "clarifying_questions": [
    {
      "id": "OQ1",
      "question": "Should state_update_failed return a structured reason code?",
      "context": "Recovery logic currently would key off warning text strings",
      "impact": "Affects recovery loop reliability and future-proofing",
      "options": [
        {"label": "Structured enum", "description": "Add state_failure_reason enum to CommitData"},
        {"label": "Keep freeform", "description": "Accept string-matching fragility"}
      ]
    }
  ],
  "assessment": "Overall assessment paragraph — holistic, not area-by-area",
  "recommendation": "APPROVE | REVISE"
}
```

Key differences from the critic's output:
- No `area_ratings` — the overviewer doesn't categorize findings into 5 areas
- `code_evidence` field — the overviewer MUST cite source code for implementability claims
- No ESCALATE — the overviewer either approves or requests revision. Escalation is handled by the skill when revisions exceed the cap.
- Simpler structure — fewer fields, more depth per finding

**Recommendation logic:**

```
if any HIGH or CRITICAL finding → REVISE
else if clarifying_questions is non-empty → REVISE
else → APPROVE
```

MEDIUM and LOW findings are informational only — they don't block approval. The plan already passed the critic's systematic review. The overviewer is a final sanity check, not a second systematic review.

### Updated Orchestration Flow

```
Phase 1 (existing, unchanged):
  clarifier → author → [conformance + critic] → revision loop → both APPROVE

Phase 2 (new):
  overviewer (fresh spawn) → APPROVE → DONE
                         → REVISE → author revises → overviewer (resume) → APPROVE → DONE
                                                                       → still REVISE → escalate to user
```

**Phase 2 detail:**

1. **Overviewer Round 1:** Fresh-spawn overviewer reads plan + codebase. No access to critic findings, conformance results, or revision history.
   - APPROVE → plan ships
   - REVISE → collect findings + clarifying questions

2. If REVISE: present clarifying questions to user via AskUserQuestion. Then resume author with overviewer findings + user answers. Author revises.

3. **Overviewer Round 2:** Resume overviewer with author output. Overviewer re-reads plan, checks if its prior findings were addressed.
   - APPROVE → plan ships
   - Still REVISE → escalate to user ("Overviewer still has concerns after revision. Accept as-is or abort?")

**Conformance and critic do NOT re-run during Phase 2.** The overviewer revision is targeted (fixing specific findings, not restructuring the plan). The author's self-validation (`tugcode validate`) catches structural regressions. If the overviewer-driven revision introduces deeper issues, the user can manually trigger a full re-review.

**Maximum cost of Phase 2:** 1 overviewer review + (optionally) 1 author revision + 1 overviewer re-review. Bounded and predictable.

### Updated Plan Skill State

```
# Add to existing state variables
overviewer_id = null
overviewer_feedback = null
overviewer_question_answers = null
overviewer_round = 0
max_overviewer_rounds = 2
```

### Skill Logic After Phase 1 Approval

```
# Phase 2: Overviewer gate
overviewer_round = 1

Task(
  subagent_type: "tugplug:overviewer-agent",
  prompt: '{"plan_path": "<plan_path>"}',
  description: "Final quality review"
)
→ save agentId as overviewer_id, store overviewer_feedback

if overviewer_feedback.recommendation == "APPROVE":
  → output session end message, DONE

# Overviewer wants revision
if overviewer_feedback.clarifying_questions is non-empty:
  AskUserQuestion for each question
  → store answers as overviewer_question_answers

AskUserQuestion: "Overviewer found issues. Revise / Accept as-is / Abort"

if "Revise":
  Task(
    resume: "<author_id>",
    prompt: 'Overviewer review found issues. Revise the plan.
    overviewer_feedback: <overviewer_feedback JSON>
    overviewer_question_answers: <overviewer_question_answers JSON or null>',
    description: "Revise plan from overviewer feedback"
  )

  overviewer_round = 2
  Task(
    resume: "<overviewer_id>",
    prompt: 'Author has revised the plan. Author output: <author_output JSON>.
    User answered your questions: <overviewer_question_answers JSON or null>.
    Re-review focusing on whether your findings were addressed.',
    description: "Overviewer re-review"
  )

  if overviewer_feedback.recommendation == "APPROVE":
    → output session end message, DONE
  else:
    AskUserQuestion: "Overviewer still has concerns. Accept as-is / Abort"
```

### Author Agent Changes

The author needs to handle `overviewer_feedback` as a new feedback source. On resume from overviewer:

```
Overviewer review found issues. Revise the plan.
overviewer_feedback: <overviewer_feedback JSON>
overviewer_question_answers: <overviewer_question_answers JSON or null>
```

The author treats overviewer findings like critic findings: read each finding, understand the issue, apply the suggestion. The `code_evidence` field gives the author specific source locations to verify before making changes.

### Progress Reporting

```
**tugplug:overviewer-agent**(Complete)
  Recommendation: {recommendation}
  Findings: {findings.length} ({count by severity})
  Clarifying questions: {clarifying_questions.length}
  Assessment: {assessment} (first sentence only)
```

## What Changes

| Artifact | Change |
|----------|--------|
| `tugplug/agents/overviewer-agent.md` | **New file.** Investigative agent with fresh-eyes framing. Opus model. Input: plan path only. Output: findings with code evidence, clarifying questions, holistic assessment. |
| `tugplug/agents/author-agent.md` | **Modify.** Add handling for `overviewer_feedback` and `overviewer_question_answers` payloads. Same pattern as critic feedback handling. |
| `tugplug/skills/plan/SKILL.md` | **Modify.** Add Phase 2 after existing Phase 1. New state variables (overviewer_id, overviewer_feedback, etc.). Overviewer dispatch, revision, and escalation logic. Updated progress reporting. |

## What Stays the Same

- `tugplug/agents/critic-agent.md` — no changes (the critic's systematic review is still valuable)
- `tugplug/agents/conformance-agent.md` — no changes
- `tugplug/agents/clarifier-agent.md` — no changes
- Phase 1 loop (clarifier → author → conformance + critic → revision) — unchanged
- All existing contracts — unchanged

## Design Rationale

**Why not just make the critic better?** We tried. The plan-quality-split already gave the critic deep instructions (V1-V5, 5 quality areas, source code verification). The instructions are good; the execution environment is the problem. Accumulated context bias and author-critic convergence are structural issues, not prompt issues.

**Why a separate agent instead of a second critic pass?** A second pass within the same critic context inherits all the same biases. The critic has already decided the plan is good (it recommended APPROVE). Asking it to "look again harder" in the same context won't produce genuinely fresh perspective.

**Why not run the overviewer earlier (in parallel with critic)?** The overviewer's value comes from reviewing a plan that has already been refined through the critic loop. Running it on the first draft would overlap heavily with the critic and produce redundant findings. The overviewer catches what survives the systematic review.

**Why cap overviewer rounds at 2?** The overviewer is a sanity check, not a second review loop. If the author can't address the overviewer's findings in one revision, the issues are likely fundamental enough to require user intervention. Unbounded overviewer rounds would negate the benefit of bounded critic rounds.

**Why no ESCALATE in overviewer output?** The plan already survived conformance and critic review. Any issues the overviewer finds should be fixable (REVISE) or need user judgment (handled by the skill's escalation prompt after round 2). There's no scenario where the overviewer should abort the entire process — the plan is structurally sound and systematically reviewed.

**Cost concern:** The overviewer adds 1-2 Opus agent runs to every plan. In the common case (overviewer approves), it adds one agent run. This is the price of not shipping plans with real issues. The alternative — user doing out-of-band review with another LLM — costs more in time and context-switching.

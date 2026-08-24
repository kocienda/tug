# Skeleton Modernization Proposal

## Motivation

The `tugplan-skeleton.md` has accumulated features over many iterations. Some reflect systems that no longer exist (Beads), some impose structure that every plan ignores (multi-phase numbering), and some add bulk without helping the author-agent write better plans or the coder-agent implement them. This proposal audits the skeleton against the current `tugplug:plan` and `tugplug:implement` workflows and recommends specific cuts and changes.

---

## Change 1: Steps start at 1, not 0

**Current:** Steps are numbered starting at 0. Step 0 is described as "prep/bootstrapping."

**Problem:** The 0-based convention is a programmer affectation. Step 1 is the natural first step. The "prep/bootstrapping" concept is a planning concern, not a numbering concern -- if a step is prep work, the step title should say so.

**Proposed:** Steps start at 1. Anchors become `{#step-1}`, `{#step-2}`, etc. Substeps follow: `{#step-2-1}`, `{#step-2-2}`.

**Downstream impacts:**

| Location | Change |
|----------|--------|
| `validator.rs` line 850 | `step.number != "0"` becomes `step.number != "1"` (the first step is allowed to have no dependencies) |
| `worktree.rs` line 625 | Artifact directory naming uses enumerate index (`step-0/`, `step-1/`...) independent of plan numbering; should switch to use the step's actual anchor |
| `parser.rs` | No change needed -- regex accepts any digit |
| `state.rs` | No change needed -- entirely anchor-string-based |
| `commit.rs` | No change needed -- opaque string passthrough |
| Skeleton | Update all step examples from Step 0/1/2 to Step 1/2/3 |
| Agent docs | Update `conformance-agent.md` ("except Step 1"), `author-agent.md`, `architect-agent.md`, `coder-agent.md`, `reviewer-agent.md` examples |
| `implement/SKILL.md` | Update all `step-0` references to `step-1` |
| Test fixtures | Mass update `step-0` -> `step-1` in test plans and assertions |

---

## Change 2: Retire multi-phase numbering

**Current:** The skeleton uses `X.Y` placeholders (e.g., "Phase 1.0") and maps them to section numbers (`X.Y.0` = Design Decisions, `X.Y.1` = Specification, etc.). A "Section Numbering Convention" table explains the system.

**Problem:** Every plan in the repository is "Phase 1.0". The external numbering system never materialized. The section numbering it drives (`1.0.0 Design Decisions`, `1.0.1 Specification`, `1.0.4 Execution Steps`) is inconsistent across plans anyway -- authors assign different numbers depending on which optional sections they include. Sections are identified by their anchors (`{#design-decisions}`, `{#execution-steps}`), not by their numbers.

**Proposed:**
- Remove the "Section Numbering Convention" table and all `X.Y` references
- Drop the `Phase X.Y:` prefix from the document title heading -- it becomes just `## <Plan Title> {#phase-slug}`
- Section headings lose their numbers: `### Design Decisions {#design-decisions}` instead of `### 1.0.0 Design Decisions {#design-decisions}`
- The author-agent and conformance-agent already identify sections by anchor, not by number, so no functional impact

---

## Change 3: Remove all Beads content

**Current:** The skeleton has three sections on Beads: "Beads linkage: root and step beads" (section 5), "Optional Beads hints block" (section 5b), and Beads-related content in the step template (`**Bead:**` line, bead ID format validation). The Plan Metadata table includes a "Beads Root" row.

**Problem:** Beads has been removed from the codebase. A `tugplan-remove-beads.md` plan exists. Only 7 legacy plans reference Beads, all predating the removal.

**Proposed:** Delete sections 5, 5b, all `**Bead:**` comments in step templates, and the "Beads Root" row from Plan Metadata. Remove "Bead ID format (validation)" content. Remove the `**Beads:**` hints block documentation.

---

## Change 4: Remove the Document Size Guidance section

**Current:** A section on splitting plans over 100KB/2000 lines, with guidance on cross-file references, table of contents, and collapsible sections.

**Problem:** No plan has ever needed splitting. Plans that are too long are a quality problem for the critic-agent to flag, not a structural concern for the skeleton. This section adds 25+ lines of guidance that has never been applied.

**Proposed:** Delete the entire "Document Size Guidance" section.

---

## Change 5: Remove the Audit / Improvement Round step pattern

**Current:** A detailed step template for audit steps, including priority-based issue tracking tables (P0-P3), test coverage gaps, architectural concerns, and dependency concerns. Takes ~60 lines of skeleton space.

**Problem:** This is a very specific step *type* embedded in a general skeleton. Plans that need an audit step can describe it in their own step -- they don't need a template for it. The auditor-agent in the implement workflow handles post-implementation audit independently. This section adds complexity without guiding typical plan authoring.

**Proposed:** Delete the entire "Audit / Improvement Round" step pattern. If the concept is useful, it can be a brief note in the step template saying "Steps can be used for audit/cleanup work."

---

## Change 6: Trim the Test Plan Concepts section

**Current:** Includes a test categories table, detailed fixture directory structure, fixture manifest format (with JSON schema), fixture requirements, and golden test workflow. Takes ~80 lines.

**Problem:** The fixture structure and manifest format are prescriptive boilerplate that plans never follow. Real plans put their test strategy in a simple list or table. The golden test workflow with `UPDATE_ENV_VAR` is project-specific. Test *concepts* are useful; fixture *schemas* are noise.

**Proposed:** Keep the section heading and test categories table. Remove the fixture directory structure, fixture manifest format, fixture requirements, and golden test workflow subsections. The section becomes a prompt to describe test strategy, not a fixture schema.

---

## Change 7: Trim the Specification section

**Current:** 10 subsections (Inputs/Outputs, Terminology, Supported Features, Modes/Policies, Semantics, Error/Warning Model, Public API, Internal Architecture, Output Schemas, Config Schema), many with detailed templates including JSON schemas, exit code tables, and config file examples. This section alone is ~200 lines.

**Problem:** Most of these subsections are relevant to specific kinds of plans (CLI tools, APIs) but not to general plans. Plans routinely include only 1-3 of these subsections and ignore the rest. The skeleton presents all 10 as if they're equally likely to be needed, forcing authors to mentally skip past irrelevant templates.

**Proposed:** Keep the section heading and a brief note that the specification should be complete enough for implementation. List the possible subsection topics (Inputs/Outputs, Terminology, API Surface, etc.) as a menu of options with one-line descriptions, not as fully-expanded templates. The author-agent picks what's relevant.

---

## Change 8: Remove "Commit after all checkpoints pass." from step templates

**Current:** Every step template ends with `**Commit after all checkpoints pass.**`

**Problem:** This is a universal rule enforced mechanically by the implement skill's orchestration loop (reviewer approves -> committer commits). Repeating it in every step wastes tokens and adds nothing the implement workflow doesn't already enforce.

**Proposed:** State this once in the Execution Steps preamble, not per step.

---

## Change 9: Drop the Rollback line from step templates

**Current:** Every step has a `**Rollback:**` section.

**Problem:** For virtually every step, the rollback is "revert the commit." This is obvious and adds noise. The implement skill doesn't use rollback instructions -- if a step fails, the reviewer sends it back to the coder for retry. Genuine rollback concerns (database migrations, external service changes) are rare enough to handle in the step's Tasks section when they arise.

**Proposed:** Remove `**Rollback:**` from the step template. Plans with genuinely complex rollback needs can document them in their step's Tasks section.

---

## Change 10: Remove Stakeholders section

**Current:** `#### Stakeholders / Primary Customers {#stakeholders}` is a required subsection of Phase Overview with a numbered list template.

**Problem:** In practice, every plan fills this in with formulaic entries like "Implementer agent" or "Plan users." For an internal project with a single user, this is pure noise that adds nothing to plan quality or implementability.

**Proposed:** Delete the Stakeholders section from the skeleton entirely.

---

## Change 11: Simplify the Compatibility / Migration / Rollout section

**Current:** A full section with compatibility policy, migration plan, and rollout plan subsections.

**Problem:** Only 8 of 44 plans use this, and most of those are brief. It's useful when applicable but shouldn't be a first-class skeleton section.

**Proposed:** Keep it but move it to an "Optional Sections" area with a one-sentence description. The author-agent includes it when the plan involves breaking changes.

---

## Change 12: Consolidate the reference conventions

**Current:** The "Reference and Anchor Conventions" section has 6 major subsections across ~140 lines. Much of this is Beads-related (sections 4, 5, 5b -- covered by Change 3). But even the non-Beads content (anchor naming rules, label conventions, Depends-on format, References format) is verbose.

**Problem:** The anchor naming rules table lists 15+ prefix conventions (step-N, dNN, qNN, rNN, cNN, diagNN, op-, cmd-, type-, seq-, fixture-, plus domain anchors). Many of these are aspirational -- plans rarely use more than step-N, dNN, and a few domain anchors. The extensive prefix table creates the illusion that all these conventions are expected.

**Proposed:** Keep the core rules (explicit anchors, kebab-case, no phase numbers, stable labels for decisions/questions). Trim the prefix conventions table based on empirical usage across all 44 plans in `.tugtool/`:

**Keep (actively used):**
- `step-N` -- 44/44 plans, 293 occurrences
- `dNN-` (decisions) -- 44/44 plans, 343 occurrences
- `tNN-` (tables) -- 29/44 plans, 91 occurrences
- `sNN-` (specs) -- 28/44 plans, 120 occurrences
- `rNN-` (risks) -- 24/44 plans, 53 occurrences
- `lNN-` (lists) -- 9/44 plans, 15 occurrences
- `mNN-` (milestones) -- 5/44 plans, 18 occurrences
- `qNN-` (questions) -- 3/44 plans, 6 occurrences
- Domain anchors (e.g., `{#config-schema}`) -- universal

**Drop (never used outside the skeleton itself):**
- `cNN-` (concepts) -- 1 plan, 2 occurrences
- `diagNN-` (diagrams) -- 1 plan, 3 occurrences
- `op-` (refactor operations) -- 0 plans
- `cmd-` (CLI commands) -- 0 plans
- `type-` (schema types) -- 0 plans
- `seq-` (sequence diagrams) -- 0 plans
- `fixture-` (fixtures) -- 0 plans

Keep the Depends-on and References format rules since the conformance-agent enforces them.

---

## Assessment: The surviving prefix system is sound

An empirical audit of all 44 plans in `.tugtool/` confirms that the 8 surviving prefixes serve distinct, well-understood purposes with no significant overloading, gaps, or ambiguity. No new prefixes are needed and no existing ones need splitting or merging.

### Why each prefix earns its place

**Spec (S)** is the broadest category (120 occurrences, 28 plans). It covers function signatures, protocol formats, CLI specs, data schemas, and recommendation logic. It's doing triple duty, but the title always disambiguates: "Spec S03: dash commit" vs. "Spec S01: Control Socket Protocol" are both normative specifications. The `S` label means "this is the contract, implement exactly this." Splitting into sub-categories (function specs, protocol specs, schema specs) would add prefix overhead without clarity gain.

**Table (T)** is similarly broad (91 occurrences, 29 plans) -- symbol inventories, migration maps, error scenarios, token mappings. The table/non-table distinction with **List (L)** is clean: tables have columns, lists are sequential. No confusion in practice.

**Decision (D)** and **Risk (R)** are tight, well-scoped categories with no overlap.

**Question (Q)** is rarely used (3 plans, 6 occurrences), but that's correct -- questions resolve during the clarifier phase and rarely survive to the final plan. When they do, the label is valuable.

**Milestone (M)** is niche (5 plans, 18 occurrences) but serves its purpose for larger plans with multiple internal checkpoints.

### The two-tier format split is intentional and works

Decisions and Questions get `####` heading treatment with `[D01]`/`[Q01]` bracket notation. Everything else uses `**bold text**` inline (e.g., `**Spec S01: Title** {#s01-slug}`). This reflects a real distinction: D and Q are major plan artifacts that structure the document, while S/T/L/R/M are reference artifacts within sections.

### No meaningful gaps exist

Possible new prefixes were considered and rejected based on lack of demand across 44 plans:

- **Algorithms/flows** described in prose -- rare enough to not warrant a prefix
- **Invariants** -- only one explicit use across all plans
- **Examples** -- always inline, never need stable citation targets
- **Constraints** -- listed in the overview section but never cited in step References lines

### Conclusion

The pruning of 7 dead prefixes (Change 12 above) is the right move. The surviving 8 have found their natural equilibrium through real usage and need no changes.

---

## Summary of net effect

| Metric | Before | After (est.) |
|--------|--------|-------------|
| Skeleton lines | ~900 | ~400-450 |
| Sections about removed features (Beads) | 3 sections, ~50 lines | 0 |
| Step template lines per step | ~25 (including Rollback, Commit footer) | ~18 |
| Specification subsection templates | 10 fully expanded | Menu of ~10 one-liners |
| Phase numbering references | Pervasive | None |

The reduced skeleton means less context window consumption for the author-agent (which must read the skeleton), the conformance-agent (which reads it for comparison), and every future plan document. No functional capabilities are lost -- every removed element is either dead (Beads), universally ignored (multi-phase numbering), or mechanically enforced elsewhere (commit-after-checkpoint).

---

## Downstream impact analysis

A complete audit of what each skeleton change touches beyond the skeleton file itself. Organized by change, then by layer.

### Change 1: Steps start at 1

**Rust code (tugcode):**

| File | Location | Change |
|------|----------|--------|
| `tugtool-core/src/validator.rs` | `check_step_dependencies`, line 850 | `step.number != "0"` -> `step.number != "1"` (W007: first step allowed to have no dependencies) |
| `tugcode/src/commands/worktree.rs` | `run_worktree_setup`, line 625 | Artifact dirs use `format!("step-{}", idx)` (enumerate index, always 0-based). Should use the step's actual anchor instead, to avoid mismatch with 1-based plan steps |
| `tugtool-core/src/parser.rs` | `STEP_HEADER` regex, line 27 | No change needed -- `(\d+(?:\.\d+)?)` accepts any digit |
| `tugtool-core/src/state.rs` | All methods | No change needed -- entirely anchor-string-based |
| `tugcode/src/commands/commit.rs` | `run_commit` | No change needed -- opaque string passthrough |

**Test fixtures (mass update):**

| Location | Scope |
|----------|-------|
| `tugtool-core/src/parser.rs` tests | ~15 test cases referencing `step-0` |
| `tugtool-core/src/validator.rs` tests | ~30 test cases, including `test_w007_step_no_dependencies` |
| `tugtool-core/src/state.rs` tests | ~50+ references to `step-0` |
| `tugcode/src/commands/commit.rs` tests | ~5 test cases |
| `tugcode/tests/state_integration_tests.rs` | ~100+ references |
| `tugcode/tests/worktree_integration_tests.rs` | ~5 test cases |
| `tugcode/tests/cli_integration_tests.rs` | ~5 test cases |
| `tugcode/tests/fixtures/valid/*.md` | 5 fixture plan files |
| `tugcode/tests/fixtures/invalid/*.md` | 5 fixture plan files |
| `tugcode/tests/fixtures/golden/status_fallback.json` | 5 references |
| `tugcode/tests/bin/claude-mock-plan` | 3 references |

**Agent docs:**

| File | Lines | Change |
|------|-------|--------|
| `conformance-agent.md` | 149, 154, 326 | "except Step 0" -> "except Step 1"; example `Step 3 {#step-3}` -> renumber examples |
| `author-agent.md` | 135 | "except Step 0" -> "except Step 1" |
| `architect-agent.md` | 57-58, 132 | Example `step-0` -> `step-1`; `all_steps` example updated |
| `coder-agent.md` | 54 | Example `step_anchor: "step-0"` -> `"step-1"` |

**Skill docs:**

| File | Lines | Change |
|------|-------|--------|
| `implement/SKILL.md` | 308, 336, 403-406, 447-449, 527-529, 666, 724, 980-994 | All `step-0` references updated to `step-1`; `all_steps` examples updated; "spawned during step 0" -> "spawned during step 1" |

**Tugstate/DB:** No change. Step anchors are stored as opaque strings. Old plans with `step-0` and new plans with `step-1` coexist without conflict.

---

### Change 2: Retire multi-phase numbering

**Downstream: skeleton only.** No code, agents, skills, or validator reference the `X.Y` numbering system. The validator checks for required sections by anchor name (`plan-metadata`, `design-decisions`, etc.), not by section number.

---

### Change 3: Remove all Beads content

**Downstream: skeleton only.** The Beads content is documentation in the skeleton. However, two related items in the codebase:

| File | Item | Action |
|------|------|--------|
| `tugtool-core/src/parser.rs` | `KNOWN_METADATA_FIELDS` (line 89) | Does NOT include "Beads Root" -- already emits P004 diagnostic for it. No change needed. |
| `tugtool-core/src/parser.rs` | `test_historical_bead_lines_parse_without_error` (line 736) | **Keep this test.** It verifies that historical plans with Bead/Beads lines parse without error. Removing Beads from the skeleton doesn't mean the parser should choke on old plans. |

---

### Change 4: Remove Document Size Guidance

**Downstream: skeleton only.** The validator's I001 check (`check_document_size`, 2000+ lines info warning) is independent of the skeleton guidance section and should remain -- it's a useful signal regardless of whether the skeleton offers splitting advice.

---

### Change 5: Remove Audit step pattern

**Downstream: none.** No code or agent references the audit step template.

---

### Change 6: Trim Test Plan Concepts

**Downstream: none.** The fixture schema/manifest/golden-workflow subsections are not referenced by any validator rule, agent, or skill. The test categories table (which is kept) is not programmatically consumed either.

---

### Change 7: Trim Specification section

**Downstream: none.** The specification section is not a required section in the validator (`check_required_sections` checks: plan-metadata, phase-overview, design-decisions, execution-steps, deliverables). No agent or skill checks for specific specification subsections.

---

### Change 8: Remove "Commit after all checkpoints pass."

**Downstream: none.** No code or agent references this text. The implement skill enforces the pattern mechanically: reviewer approves -> committer commits.

---

### Change 9: Drop Rollback from step template

**Parser:**

| File | Location | Impact |
|------|----------|--------|
| `tugtool-core/src/parser.rs` | Line 582 | `header_lower.contains("rollback")` sets `current_section = CurrentSection::Other`. This is how the parser stops collecting checklist items when it encounters the Rollback heading. Without Rollback sections, this code is harmless dead code. **Recommend: keep for backward compatibility with old plans.** |

**Validator:** No validation rule checks for Rollback. No change needed.

**Agent docs:**

| File | Lines | Change |
|------|-------|--------|
| `conformance-agent.md` | 218 | Remove "Rollback" from the list of required step fields: `(Depends on, References, Artifacts, Tasks, Tests, Checkpoint, Rollback)` -> `(Depends on, References, Artifacts, Tasks, Tests, Checkpoint)` |
| `critic-agent.md` | 211, 347 | Remove "Are rollback procedures realistic?" from completeness checklist and review process |
| `author-agent.md` | 256 | Remove "strengthen rollback procedures" from completeness fix guidance |

---

### Change 10: Remove Stakeholders

**Downstream: none.** Not checked by the validator. Not referenced by conformance-agent or author-agent. Not a required section.

---

### Change 11: Simplify Compatibility/Migration

**Downstream: none.** Not checked by the validator. Not referenced by any agent.

---

### Change 12: Consolidate reference conventions

**Downstream: none.** The dropped prefixes (`cNN-`, `diagNN-`, `op-`, `cmd-`, `type-`, `seq-`, `fixture-`) have no code or agent references. The validator's anchor format check (E005) uses a generic regex (`^[a-z0-9][a-z0-9-]*$`) that doesn't know about specific prefixes.

---

## Impact summary by layer

| Layer | Changes needed | Changes |
|-------|---------------|---------|
| **Skeleton** | 12 changes | All changes touch the skeleton |
| **Rust code** | 2 code changes | W007 first-step check, artifact dir naming |
| **Rust tests** | ~220+ reference updates | Mass `step-0` -> `step-1` across all test files and fixtures |
| **Agent docs** | 6 files | conformance, author, critic, architect, coder, reviewer |
| **Skill docs** | 1 file | `implement/SKILL.md` |
| **Tugstate/DB** | 0 | Anchor-string-agnostic; old and new plans coexist |
| **Parser** | 0 code changes | Regex already accepts any digit; Rollback sentinel kept for compat |
| **Validator** | 1 code change | W007 only; I001 kept independently |

## Migration

No migration is needed for existing plans. They are historical documents that keep their current format. The parser and state system are anchor-string-agnostic, so old plans (`step-0`) and new plans (`step-1`) coexist without conflict. The W007 validator change means old plans with `step-0` that lack a dependency on "Step 0" will now get a spurious warning -- but old plans are not re-validated in practice.

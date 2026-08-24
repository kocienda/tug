<!-- tugplan-skeleton v2 -->

## Tuglaws Tidy-Up — Consolidation, New Coverage, and Cross-Reference Repair {#phase-slug}

**Purpose:** Bring the `tuglaws/` documentation set up to date with the
last two weeks of architectural change (app-test harness, code-signing
pipeline, lifecycle-delegate refinements, portal refactoring,
component state preservation system). Add three new docs for
under-documented areas, absorb selection content into a renamed
`card-state-model.md`, strip duplicated law text from
`framework-architecture.md`, and add an index so a reader can navigate
the set without having to read every file. Mostly prose; code changes
are mechanical (path/anchor updates only — no behavior changes).

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-04-27 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Over the past two weeks, several substantial systems have landed in
the codebase: the `app-test` harness (trusted-event integration tests
driving `Tug.app`), the macOS code-signing pipeline (`Tug Dev`
identity, AX-stable signatures, fingerprint sentinel), app/pane/card
design refinements (portal refactoring of `CardHost`, lifecycle
methods with delegate callouts), and the recently-renamed component
state preservation system (`useComponentStatePreservation`,
`useCardStatePreservation`, `data-tug-state-key`, `FocusSnapshot`,
`bag.{components,formControls,focus,regionScroll}`).

The `tuglaws/` documentation set has not kept up. The
state-preservation system is described nowhere as a single coherent
narrative — its identifiers and mechanisms appear scattered across
`selection-model.md`, `pane-model.md`, `app-test-inventory.md`, and
`design-decisions.md`, requiring four documents to reconstruct
end-to-end behavior. The lifecycle-delegate model (`onCardActivated`,
`cardWillBeginDestruction`, `CardPersistenceCallbacks` and successors)
is referenced obliquely in AT-tag entries but has no architectural
home. Portal refactoring of `CardHost` is mentioned in
`pane-model.md` ("portals into the host Pane's DOM; it is never
remounted") without any explanation of *why* (cross-Pane move
preservation per L23). The app-test harness and signing pipeline have
isolated docs that don't tie back to `tuglaws.md`/`design-decisions.md`.

The framework-architecture narrative duplicates law text in a 70-line
appendix (drift risk), `selection-model.md`'s "ResponderChainProvider
Document-Level Infrastructure" section duplicates content from
`responder-chain.md`, and there is no top-level reading guide telling
new contributors which doc to start with for which question.

#### Strategy {#strategy}

- **Additive over consolidating.** Three of the four docs we lack
  (state-preservation, lifecycle-delegates, app-test-harness)
  describe systems that don't fit cleanly into existing files. Add
  new docs rather than swelling existing ones.
- **One absorption.** `selection-model.md` is genuinely the right
  home for the state-preservation narrative — selection is one axis
  of preserved state, alongside scroll, focus, and form-control
  values. Promote it to `card-state-model.md` and absorb the
  state-preservation content. This avoids creating two adjacent docs
  that have to cross-reference each other for every concept.
- **Strip cross-doc duplication.** `framework-architecture.md`'s
  appendix re-prints law text → replace with anchored cross-refs
  to `tuglaws.md`. `card-state-model.md`'s ResponderChainProvider
  section → cross-ref to `responder-chain.md`.
- **One INDEX.md, kept short.** A reading guide; not a re-stating
  of every doc's contents. ≤ 150 lines.
- **Tie new docs into the L## / D## convention.** Every new doc
  opens with the same cross-reference banner (`[D##]` →
  design-decisions; `[L##]` → tuglaws). Where new architectural
  invariants emerge that are worth treating as laws, add new entries
  to `tuglaws.md` / `design-decisions.md` rather than burying them in
  the deep dive.
- **No behavior changes.** Code changes are limited to: (a) updating
  identifier-table cells in `pane-model.md` and Files tables across
  docs to point at `card-state-model.md` instead of
  `selection-model.md`; (b) updating any `selection-model.md` link in
  source comments / test files. No runtime, test, or build behavior
  changes.
- **Mechanical, grep-gated commits.** Each step has a grep-based
  acceptance criterion before commit. Mirrors the `tugplan-state-
  preservation-rename.md` pattern that just shipped.

#### Success Criteria (Measurable) {#success-criteria}

> Every criterion is a grep, exit-code, or "file exists" check.

- **SC01.** `tuglaws/INDEX.md` exists, ≤ 150 lines, lists every other
  doc in `tuglaws/` exactly once, with a one-line description per doc.
  Verify: `wc -l tuglaws/INDEX.md` ≤ 150 AND
  `ls tuglaws/*.md | grep -v INDEX.md | wc -l` matches the bullet
  count in INDEX.md (manual visual check).
- **SC02.** `tuglaws/card-state-model.md` exists and
  `tuglaws/selection-model.md` does not. Verify:
  `test -f tuglaws/card-state-model.md && ! test -f tuglaws/selection-model.md`.
- **SC03.** `tuglaws/state-preservation.md` exists and contains a
  section listing every public identifier of the preservation system
  (`useComponentStatePreservation`, `useCardStatePreservation`,
  `ComponentStatePreservationRegistry`, `CardStatePreservationContext`,
  `FocusSnapshot`, `CardStateBag`, `data-tug-state-key`,
  `data-tug-focus-key`, `data-tug-scroll-key`,
  `data-tug-prompt-input-root`). Verify: `grep -c '^- \`' tuglaws/state-preservation.md`
  ≥ 10 in the identifier section, and a single `grep -F` across all
  ten identifiers returns 10 matches.
- **SC04.** `tuglaws/lifecycle-delegates.md` exists and documents
  `onCardActivated`, `cardWillBeginDestruction`, the
  `useCardStatePreservation` callbacks (`onSave`/`onRestore`), and
  the `CardHost` portal lifecycle. Verify: a single `grep -F` for
  these four identifiers returns 4+ matches.
- **SC05.** `tuglaws/app-test-harness.md` exists and absorbs the
  overview-level content from `tests/app-test/README.md`
  (running, env vars, lifecycle model, fidelity envelope, smoke vs.
  scenario classification). The `tests/app-test/README.md` continues
  to exist but its narrative content is reduced to a one-paragraph
  pointer at `tuglaws/app-test-harness.md` followed by the
  test-author-specific procedural sections (Running, Adding a new
  test, Lint, Directory layout).
- **SC06.** `tuglaws/framework-architecture.md` no longer contains a
  duplicated "Appendix: Laws referenced" section. The block is
  replaced with a cross-reference list pointing to
  `tuglaws.md#l02`, `tuglaws.md#l03`, etc. Verify:
  `grep -c '^### L0' tuglaws/framework-architecture.md` returns `0`
  (the appendix's "### L02. ..." headings are gone).
- **SC07.** Every new doc opens with the canonical
  `[D##] / [L##]` cross-reference banner (matching the existing
  pattern in `responder-chain.md`, `action-naming.md`,
  `component-authoring.md`). Verify: `grep -l 'Cross-references:' tuglaws/*.md`
  includes every new file.
- **SC08.** `tuglaws.md` cross-references at least one of the new
  docs from at least one law (e.g., L23 should cross-reference
  `state-preservation.md`; the existing list of cross-refs at L09
  should mention `lifecycle-delegates.md`). Verify by reading the
  cited law lines.
- **SC09.** `pane-model.md`'s "Files" table cell currently pointing at
  `tugdeck/src/components/tugways/use-card-state-preservation.tsx`
  remains correct, AND its "Cross-Links" section adds entries for
  `state-preservation.md` and `lifecycle-delegates.md`. Verify: a
  grep for both new doc names finds them in the Cross-Links block.
- **SC10.** `app-test-inventory.md` cross-references
  `state-preservation.md` for the [A9] protocol mentions (currently
  it cites the protocol with no link). Verify: every paragraph that
  uses the literal string "[A9]" in `app-test-inventory.md` is
  followed somewhere in the surrounding section by a link to
  `state-preservation.md`. (At minimum: the `[AT0024]` paragraph and
  the `### Component-roster tags` section preamble should link.)
- **SC11.** No grep hit for the now-absorbed content path:
  `grep -r 'tuglaws/selection-model' tuglaws/ tugdeck/src/ tests/` returns 0 lines.
  (Source-code mentions of the old filename in comments are caught here.)
- **SC12.** `bun x tsc --noEmit` exits 0 in `tugdeck/`. (Sanity:
  this plan does not change TypeScript behavior, but the path-comment
  edits in source files should not break the build. Run before commit
  on every step that touches `.tsx` / `.ts`.)
- **SC13.** `bun test` passes in `tugdeck/` (full suite). (Same sanity
  rationale.)

#### Scope {#scope}

1. Add `tuglaws/INDEX.md` — one-page reading guide. (Step 1)
2. Promote `selection-model.md` → `card-state-model.md`; absorb
   the state-preservation narrative. Update internal cross-refs and
   any source-code comments referencing the old path. (Step 2)
3. Add `tuglaws/state-preservation.md` — the full [A9] protocol
   end-to-end. (Step 3)
4. Add `tuglaws/lifecycle-delegates.md` — `CardLifecycle`
   callbacks, `onCardActivated`, `cardWillBeginDestruction`,
   `CardHost` portal lifecycle. (Step 4)
5. Add `tuglaws/app-test-harness.md` — overview lifted from
   `tests/app-test/README.md`; the README is reduced to procedural
   test-author content + a pointer up to the new doc. (Step 5)
6. Strip the law-text appendix from `framework-architecture.md`;
   replace with anchored cross-refs to `tuglaws.md`. (Step 6)
7. Repair cross-references — add missing links across the docs
   surfaced by SC08, SC09, SC10. (Step 7)
8. Final audit + verification. (Step 8)

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Token-system consolidation.** `color-palette.md`,
  `theme-engine.md`, `token-naming.md`, and `tuglaws.md` L15-L20 do
  overlap, but each is scoped narrowly and the overlap is hierarchical
  (palette feeds tokens feed components). Collapsing them risks
  losing specificity. Defer.
- **Moving `tugplan-skeleton.md`.** User confirmed it stays in
  `tuglaws/` as architecture for plan documents.
- **Behavior changes.** No code refactors, no test refactors, no
  identifier renames. Pure docs work plus path-comment updates.
- **Adding new laws or design decisions for newly-identified
  architectural invariants.** If, while writing `state-preservation.md`,
  it becomes obvious that a new law is needed (e.g., "every
  component owning state opts into preservation via opt-in keys"),
  *flag it in [Q01]* and defer the new law to a follow-up plan. We
  document what exists; we don't legislate during a tidy-up.
- **Renaming `app-test-inventory.md`.** Recently renamed from
  `m-series-inventory.md` (per the 2026-04-27 cleanup); do not
  re-name.
- **Documenting the responder-chain or chain-related additions.**
  `responder-chain.md` is the most thorough doc in the set; it does
  not need updating in this pass.

#### Dependencies / Prerequisites {#dependencies}

- The state-preservation rename plan is complete (commit `f0b35b91`,
  status `complete (2026-04-27)`). All identifiers used in
  `state-preservation.md` reference the post-rename names.
- The signing pipeline plan is complete (Phase 2 close-out, commit
  `72d23678`). `code-signing-mac.md` is the durable reference; the
  new `app-test-harness.md` will cross-reference it for the
  signing-related grant flow.

#### Constraints {#constraints}

- All new docs must follow the existing tuglaws style: title sentence
  + tagline, `[D##]` / `[L##]` cross-reference banner, body sections
  with H2 headers, "Files" table where applicable, "Cross-Links" or
  "Cross-References" closing block. (See `responder-chain.md` and
  `action-naming.md` for canonical reference patterns.)
- The `tugdeck/` build (`bun x tsc --noEmit`) and tests (`bun test`)
  must remain green at every step boundary.
- Commits follow the project's `<type>(<scope>): <subject>` form
  matching recent history (e.g., `docs(tuglaws): ...`).
- No grep-detectable references to the old `selection-model.md`
  filename anywhere in `tuglaws/`, `tugdeck/src/`, or `tests/` after
  Step 2.

#### Assumptions {#assumptions}

- The current `selection-model.md` content is structurally sound and
  needs absorption (not rewriting). Its "ResponderChainProvider
  Document-Level Infrastructure" section is the only chunk we should
  consider trimming as duplicative.
- `tests/app-test/README.md` is the right source for the harness
  overview; lifting from it means the new `app-test-harness.md`
  starts with already-authored, accurate content.
- The lifecycle-delegate model has stabilized enough that documenting
  it now will not invalidate the doc next sprint. (Surfaced in
  `dash/tugplan-lifecycle-delegates.md` and the related
  `lifecycle-delegate-reliability.md`; their close-outs are the
  authoritative source for the doc.)
- Portal-refactoring details are recoverable from `card-host.tsx` +
  `pane-model.md` ("portals into the host Pane's DOM"); a fresh
  read of the file plus the tugplan history is sufficient to
  document.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Standard tugplan-skeleton conventions apply (see
`tuglaws/tugplan-skeleton.md`). All execution-step anchors use
`#step-N` form; design-decision anchors use `#dNN-slug`; question
anchors use `#qNN-slug`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Should new laws be added during this tidy-up? (DEFERRED) {#q01-new-laws}

**Question:** While writing `state-preservation.md` and
`lifecycle-delegates.md`, will architectural invariants emerge that
deserve new entries in `tuglaws.md` (e.g., "every preservation key
must be unique within its card subtree") or `design-decisions.md`?

**Why it matters:** A tidy-up that doubles as a law-authoring exercise
is no longer mechanical. Scope creep risk.

**Resolution:** **DEFERRED.** Document existing behavior; flag any
candidate new laws inline as `<!-- TODO: candidate law? -->` HTML
comments in the new docs. A follow-up plan can promote the candidates
into `tuglaws.md` after this phase ships. This phase does NOT modify
`tuglaws.md` except for cross-reference additions per SC08.

---

#### [Q02] Where should `framework-architecture.md` link readers for the law text? (DECIDED) {#q02-fa-appendix-replacement}

**Question:** When stripping the duplicated law-text appendix, what
should replace it?

**Resolution:** **DECIDED.** A short "Laws referenced in this
document" list with each law as `[L02](tuglaws.md#l02) — one-line
purpose`. Anchors already exist in the appendix (it uses
`<a id="l02">` markers); those move into `tuglaws.md` as the canonical
anchors. Verify the stripped appendix's `<a id>` IDs are present at
the corresponding L## entries in `tuglaws.md` (currently they aren't —
add them in Step 6).

---

#### [Q03] Should app-test scenario examples live in `app-test-harness.md` or stay in the README? (DECIDED) {#q03-test-examples}

**Question:** The README has worked examples (`launchTugApp`, scenario
shape, `holdModifier` pattern, `markDeckTrace` example). Do these go
in the new architecture doc, or stay in the README?

**Resolution:** **DECIDED.** Examples that explain **architecture**
(why a fresh app per file, why CGEvent vs. synthesized, fidelity
envelope) move to `app-test-harness.md`. Examples that explain
**procedure** (how to write a new test, the `describe.skipIf`
pattern, the `_harness/index.ts` import alias, the lint command)
stay in the README. The README becomes "test author's procedural
guide"; the new doc becomes "harness architecture reference."

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Drift between `card-state-model.md` and `state-preservation.md` after the absorption | Medium — readers re-confused | Medium | Each doc has a clear scope sentence in its opening; cross-ref each other once at the top, not throughout | If a future PR adds the same content to both docs |
| New docs go stale faster than `tuglaws.md` does | Medium | High | Cite `[L##]` and `[D##]` anchors throughout; keep narrative claims minimal — each new doc cites the law/decision it's elaborating, not redefining | Routine: any time `tuglaws.md` changes, sweep the new docs for cited laws |
| `app-test-harness.md` overlaps `tests/app-test/README.md` | Low | Medium | Q03 resolution — split by audience (architecture vs. procedure) | If a contributor reports finding the same content in both places |
| Source-code comments referencing `selection-model.md` slip through | Low | Low | SC11 grep gates the commit boundary | If post-merge the grep finds residuals |
| `framework-architecture.md` reads worse without the inline appendix | Low — reader has to click through | Medium | Replace with a *list* of laws + one-liners + anchored links — readable inline, full text one click away | If a reader complains the doc no longer stands alone |

---

### Design Decisions {#design-decisions}

#### [D01] Promote `selection-model.md` rather than create a sibling (DECIDED) {#d01-promote-selection-model}

**Decision:** Rename `selection-model.md` → `card-state-model.md`.
Absorb the state-preservation narrative into the renamed file.

**Rationale:**
- Selection is one axis of card state; scroll, focus, and form-control
  values are others. A doc named "selection-model" can't grow to
  cover the others without misnaming itself.
- Two adjacent docs ("selection-model" and "state-preservation")
  would have to cross-ref each other for every concept. One doc
  with internal sections is cleaner.
- The user explicitly chose this path in clarification #2.

**Implications:**
- `card-state-model.md` becomes the canonical doc for: selection
  containment (boundary, dimming, restore), focus state preservation
  (the `data-tug-focus-key` and `data-tug-state-key` attributes,
  `FocusSnapshot`), scroll preservation (`bag.scroll`,
  `bag.regionScroll`, `data-tug-scroll-key`), and form-control value
  preservation.
- `state-preservation.md` covers the protocol *implementation* (the
  hooks, the registry class, the bag shape, the lifecycle of a
  save/restore cycle) without re-stating the per-axis specifications.
- Cross-link: `card-state-model.md` → `state-preservation.md` once
  at the top of each axis; `state-preservation.md` →
  `card-state-model.md` for "what each axis means semantically."

---

#### [D02] `state-preservation.md` is implementation-centric; `card-state-model.md` is contract-centric (DECIDED) {#d02-doc-split}

**Decision:** The two docs split by *what* they describe, not *which
audience* reads them.

**Rationale:**
- A reader who wants to know "what does the framework guarantee
  about my selection across a tab switch?" reads `card-state-model.md`.
- A reader who wants to know "how does my component opt into having
  its state preserved?" reads `state-preservation.md`.
- The first answer is a behavioral contract (selection survives X, Y,
  Z); the second is an API guide (call `useComponentStatePreservation`
  with a key).

**Implications:**
- `card-state-model.md` cites `state-preservation.md` for "the
  underlying mechanism is described in [...]"; `state-preservation.md`
  cites `card-state-model.md` for "the contract this protocol
  satisfies is documented in [...]." Single backlink each direction.
- AT-tag entries in `app-test-inventory.md` cite *both* — the
  behavioral contract that's being tested + the protocol that
  produces it.

---

#### [D03] `app-test-harness.md` is "architecture"; `tests/app-test/README.md` is "test author procedure" (DECIDED) {#d03-harness-doc-split}

**Decision:** Lift architecture-flavored content (lifecycle model,
fidelity envelope, native-gesture rationale, accessibility-grant
mechanics) into `tuglaws/app-test-harness.md`. Reduce the
`tests/app-test/README.md` to: pointer up to the new doc, Running,
Environment variables (mostly), Adding a new test, Lint, Directory
layout. Remove the duplicated "Accessibility grant failure modes"
section from the README — it's already in `code-signing-mac.md` and
will be cross-referenced from the new `app-test-harness.md`.

**Rationale:** Q03 resolution. Keeps each doc scoped to one audience.

**Implications:**
- The README's current ~445 lines drop to roughly ~150–180.
- Test authors editing scenario tests rarely need to read the
  architecture doc.
- Architecture readers (someone proposing a harness change) read the
  new doc first and consult the README only for the procedural shape.

---

#### [D04] Strip the law-text appendix from `framework-architecture.md` (DECIDED) {#d04-strip-fa-appendix}

**Decision:** Replace `framework-architecture.md`'s "Appendix: Laws
referenced" block (currently re-prints L02/L03/L04/L05/L06/L07/L08/L11/L24)
with a list of the same laws each as `[L02] — one-line purpose
([full text](tuglaws.md#l02))`.

**Rationale:**
- Drift risk. The appendix is already slightly out of sync with
  `tuglaws.md` (e.g., L24 is the most-recently-added law and the
  appendix copy might lag).
- The full text exists in `tuglaws.md` — the appendix is a
  reading-convenience optimization that costs maintenance.

**Implications:**
- `tuglaws.md` must contain anchors `#l02` through `#l11` (and `#l24`)
  on every law referenced from the new list. Audit and add any
  missing anchors in Step 6.
- Readers click one link to read full law text. Acceptable trade.

---

#### [D05] One INDEX, one read; no per-section preambles (DECIDED) {#d05-index-shape}

**Decision:** `tuglaws/INDEX.md` is a single flat list. Each entry
is one line: `- [doc-name.md](doc-name.md) — one-sentence
description with link to most-relevant section if applicable`. ≤ 150
lines total.

**Rationale:**
- An INDEX that grows section preambles becomes another doc to read
  before reading the actual doc. Defeats the purpose.
- One-line entries fit in a single screen for a typical viewport.

**Implications:**
- The descriptions must distinguish overlapping docs. E.g., for
  `card-state-model.md` and `state-preservation.md` the descriptions
  must explicitly answer "when do I read which?"

---

#### [D06] Existing source-code comments referencing `selection-model.md` get updated; production code does not (DECIDED) {#d06-comment-only-source-edits}

**Decision:** The only source-code change in this plan is updating
inline comments / JSDoc that reference the old `selection-model.md`
filename. No type signatures, exports, or runtime behavior change.

**Rationale:**
- Mechanical scope. Prevents the plan from creeping into refactor.
- SC11 enforces no surviving references to the old filename
  anywhere in `tugdeck/src/` or `tests/`.

**Implications:**
- After Step 2, `grep -r 'selection-model.md' tugdeck/ tests/` must
  return 0 lines.
- If the grep finds non-comment matches (e.g., a test that
  programmatically reads the file), that's a different problem and
  requires a follow-up. Halt the step and ask before proceeding.

---

### Specification {#specification}

> The contract for each new/renamed doc.

#### `tuglaws/INDEX.md` {#spec-index}

**Shape:**

```
# Tuglaws — Reading Guide

*Where to look for what. Each entry below is a single source of truth
for its topic; cross-references take you between docs without
duplicating content.*

## Start here

- [framework-architecture.md] — Narrative overview ...
- [tuglaws.md] — The numbered laws ...
- [design-decisions.md] — The numbered decisions ...

## Component & UI architecture

- [pane-model.md] — Deck → Pane → Card hierarchy ...
- [card-state-model.md] — Selection, focus, scroll ... [DECIDED D01]
- [state-preservation.md] — The [A9] protocol ...
- [lifecycle-delegates.md] — `CardLifecycle` callbacks ...
- [responder-chain.md] — Action routing ...
- [action-naming.md] — Action vocabulary ...
- [component-authoring.md] — Component author's checklist ...

## Theming, palette, tokens

- [token-naming.md] — Seven-slot CSS custom-property naming ...
- [color-palette.md] — OKLCH palette ...
- [theme-engine.md] — Theme runtime ...

## Testing & build infrastructure

- [app-test-harness.md] — `Tug.app` integration tests ...
- [app-test-inventory.md] — AT-tag catalog ...
- [code-signing-mac.md] — `Tug Dev` signing pipeline ...

## Templates

- [tugplan-skeleton.md] — Template for `dash/` plan documents
```

**Constraints:**
- ≤ 150 lines.
- Every `tuglaws/*.md` file (except INDEX itself) appears exactly
  once.
- Each entry is one line.
- Section headers use H2 only — no H3 nesting.

---

#### `tuglaws/card-state-model.md` (renamed from `selection-model.md`) {#spec-card-state-model}

**Sections (top to bottom):**

1. *Title sentence + cross-ref banner* — `Selection, focus, scroll, and
   form-control values across tabs, pane activation, and reload.`
2. *Three Selection Categories* — kept verbatim from `selection-model.md`.
3. *Rules* — kept verbatim.
4. *`data-tug-select` Attribute* — kept verbatim.
5. *Focus Acceptance Model* — kept verbatim.
6. *Focus State Preservation Attributes* — kept; cross-ref
   `state-preservation.md` for the underlying mechanism.
7. *Scroll Preservation Attributes* — kept; same cross-ref.
8. *Form-control Value Preservation* — **NEW**, brief — points at
   `state-preservation.md` for the protocol; documents the contract
   ("`data-tug-state-key` doubles as the focus key").
9. *Context Menu Hierarchy* — kept verbatim.
10. *SelectionGuard (Boundary Enforcer)* — kept verbatim.
11. *Relationship to Editing Components* — kept verbatim.
12. *ResponderChainProvider Document-Level Infrastructure* — **REMOVED**;
    cross-ref `responder-chain.md`.
13. *Files* — updated to include `state-preservation.md` /
    `lifecycle-delegates.md` references where applicable.

---

#### `tuglaws/state-preservation.md` (NEW) {#spec-state-preservation}

**Sections:**

1. *Title + banner.* `The component- and card-level state
   preservation protocol — capture, persist, restore.`
2. *Why.* The L23 motivation: "save and restore is destruction with
   attempted recovery; we preserve user-visible state across
   bookkeeping operations."
3. *Two layers.*
   - **Component-level** (`useComponentStatePreservation`): an
     individual control opts in via `componentStatePreservationKey`.
     The framework captures `.value`, selection, scroll at save;
     reapplies on restore.
   - **Card-level** (`useCardStatePreservation`): a card's content
     factory registers `onSave` / `onRestore` callbacks. The card
     manages a richer payload (`bag.content`, often a domain-specific
     shape).
4. *Public identifiers.* The 10+ identifiers listed in SC03,
   one bullet per identifier with a one-line purpose. (This is the
   greppable section.)
5. *Save/restore lifecycle.* When the framework calls onSave; what's
   in `bag` at that moment; what's in `bag` at restore time; the
   capture-phase invariant gate ([A9] tested by
   `smoke-capture-phase-save.test.ts`).
6. *DOM attributes.* Table — `data-tug-state-key`,
   `data-tug-focus-key`, `data-tug-scroll-key`,
   `data-tug-prompt-input-root`. (Repeats some of `card-state-model.md`'s
   table; that doc cross-refs here for "the protocol" while this
   doc cross-refs there for "the per-axis contract.")
7. *FocusSnapshot.* The discriminated-union shape; the four kinds.
8. *CardStateBag.* The flat object shape; how axes compose.
9. *Authoring rules.* When to opt in (uncontrolled inputs, native
   form controls); when not to (controlled inputs where React owns
   `value`); how to pick keys (uniqueness within card subtree).
10. *Relationship to AT-tags.* Cross-ref `app-test-inventory.md` for
    every AT-tag that gates this protocol.
11. *Files.* Source-of-truth file list.
12. *Cross-Links.* L23, [D49]–[D50], `card-state-model.md`,
    `lifecycle-delegates.md`.

---

#### `tuglaws/lifecycle-delegates.md` (NEW) {#spec-lifecycle-delegates}

**Sections:**

1. *Title + banner.* `Card lifecycle: when content factories load,
   activate, save, and tear down — and the delegate callbacks that
   surround each transition.`
2. *Why a delegate model.* The card-content factory pattern: the
   framework owns the timing; content owns the semantics. Delegates
   are how content responds to framework-driven transitions.
3. *The four lifecycle moments.* Mount, activate, save, destroy.
4. *Per-moment delegate.*
   - `onCardActivated()` — when a card transitions from inactive to
     active. AT0008. Cross-ref `app-test-inventory.md` AT0002 /
     AT0004 / AT0005 / AT0006 / AT0007 / AT0009.
   - `onSave(bag)` / `onRestore(bag)` — preservation hooks. Cross-ref
     `state-preservation.md`.
   - `cardWillBeginDestruction()` — final flush before unmount.
     AT0019.
5. *Portal-refactoring relationship.* `CardHost` portals into the
   pane's DOM rather than remounting on cross-Pane move; this is
   what makes the lifecycle observable in the first place. Without
   the portal, every cross-Pane move would unmount and remount,
   firing destruction + mount instead of activation. L23 is the law
   this enables.
6. *When delegates fire vs. when React effects fire.* The interplay
   with `useLayoutEffect`/`useEffect`; why some delegates use the
   capture-phase save guarantee.
7. *Authoring rules.* When to register (factories that own state
   spanning a card lifecycle); when to skip (chrome-only content).
8. *Files.* Source-of-truth file list.
9. *Cross-Links.* L23, L09, L10, [D49]–[D52], `pane-model.md`,
   `state-preservation.md`.

---

#### `tuglaws/app-test-harness.md` (NEW) {#spec-app-test-harness}

**Content lifted from `tests/app-test/README.md`:**

1. *Title + banner.*
2. *What the harness is.* (~current README ¶1.) Subprocess driving
   `Tug.app` via the `TestHarness` Unix-socket bridge. WKWebView,
   not happy-dom.
3. *The trusted-event problem.* Why `CGEvent.post`; why WKWebView's
   `isTrusted` paths matter; why a test posting a synthesized event
   doesn't reach the same code-paths as a real click.
4. *Lifecycle model.* One App per file; explicit reset; rationale
   from current README.
5. *Fidelity envelope.* What the harness can and cannot assert;
   visual rendering, perceived snappiness — out of envelope.
6. *Phase A surface.* Native gestures, native keyboard, introspection
   table.
7. *Accessibility-grant relationship.* Cross-ref
   `code-signing-mac.md` for the deep dive; one-paragraph summary
   here. Mentions `APP_TEST_SKIP_RESIGN` escape hatch.
8. *Smoke vs. scenario classification.* Cross-ref
   `app-test-inventory.md`.
9. *Files.* Source-of-truth file list.
10. *Cross-Links.* `app-test-inventory.md`, `code-signing-mac.md`,
    `dash/tugplan-in-app-bridge.md`,
    `dash/tugplan-harness-extensions.md`.

**Removed from `tests/app-test/README.md`:**

- "What the harness is" / "The trusted-event problem" /
  "Lifecycle model" / "Fidelity envelope" / "Phase A surface" /
  "Accessibility grant failure modes" sections (these move to the
  new doc).

**Retained in `tests/app-test/README.md`:**

- "Related docs" pointer (updated).
- "Running" — `just app-test` invocations and `VERDICT: ` summary
  format.
- "Environment variables" — table.
- "Live-mode tugcode smoke" — opt-in.
- "Adding a new test" — procedural.
- "Lint: no raw timers" — procedural.
- "Directory layout" — file tree.
- "TUGAPP_APP_TEST naming note" — historical.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tuglaws/INDEX.md` | One-page reading guide. SC01. |
| `tuglaws/state-preservation.md` | [A9] protocol end-to-end. SC03. |
| `tuglaws/lifecycle-delegates.md` | Card lifecycle delegates + portal. SC04. |
| `tuglaws/app-test-harness.md` | Harness architecture overview. SC05. |

#### Renamed files {#renamed-files}

| From | To |
|------|----|
| `tuglaws/selection-model.md` | `tuglaws/card-state-model.md` |

#### Modified files {#modified-files}

| File | Change |
|------|--------|
| `tuglaws/tuglaws.md` | Add anchors `#l02` … `#l24` per Q02. Add cross-ref to `state-preservation.md` and `lifecycle-delegates.md` from L23 (and L09 for lifecycle). |
| `tuglaws/framework-architecture.md` | Strip law-text appendix; replace with cross-ref list. SC06. |
| `tuglaws/pane-model.md` | Update Files-table cell; add `state-preservation.md` and `lifecycle-delegates.md` to Cross-Links. SC09. |
| `tuglaws/app-test-inventory.md` | Add cross-ref links to `state-preservation.md` per SC10. |
| `tuglaws/responder-chain.md` | One-line cross-ref note: "for the focus-refusal mechanism, see `card-state-model.md`." |
| `tuglaws/component-authoring.md` | Update Selection-and-Focus section's link target from `selection-model.md` → `card-state-model.md`. |
| `tests/app-test/README.md` | Reduce to procedural sections per [D03]. |
| `tugdeck/src/**/*.{ts,tsx}` (comments only) | Path comment updates if any reference `selection-model.md`. |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/INDEX.md` — created (Step 1).
- [ ] `tuglaws/card-state-model.md` — content absorbed (Step 2).
- [ ] `tuglaws/state-preservation.md` — created (Step 3).
- [ ] `tuglaws/lifecycle-delegates.md` — created (Step 4).
- [ ] `tuglaws/app-test-harness.md` — created (Step 5).
- [ ] `tuglaws/framework-architecture.md` — appendix replaced (Step 6).
- [ ] Cross-references repaired across docs (Step 7).
- [ ] Final audit (Step 8).

---

### Test Plan Concepts {#test-plan-concepts}

> This is a docs plan; the "tests" below are grep contracts and
> exit-code checks, not Bun test files.

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Grep contract** | Verify a doc references / doesn't reference a string | Every step boundary; SC01, SC02, SC03, SC06, SC07, SC11 |
| **`bun x tsc --noEmit`** | Sanity: no source-code edits broke types | Steps 2 (path comment update), 7 (cross-ref repairs), 8 (final) |
| **`bun test` (tugdeck)** | Sanity: no source-code edits broke tests | Same as above |
| **Manual visual** | Read-through of new docs by author | Each new-doc step (3, 4, 5) and Step 8 |

The plan does **not** require running `just app-test` — no production
behavior changes.

---

### Execution Steps {#execution-steps}

#### Step 1: Add `tuglaws/INDEX.md` reading guide {#step-1}

**Commit:** `docs(tuglaws): add INDEX reading guide`

**References:** [D05] One-page index, Spec `#spec-index`, (#strategy)

**Artifacts:**
- New file `tuglaws/INDEX.md` per Spec `#spec-index`.

**Tasks:**
- [ ] Write `tuglaws/INDEX.md` listing every existing
      `tuglaws/*.md` file plus the four new files (which won't
      exist yet — entries point to the future paths intentionally;
      Steps 2–5 create them).
- [ ] Verify ≤ 150 lines: `wc -l tuglaws/INDEX.md`.
- [ ] Visual readthrough: section headers are H2, no nested H3, no
      line wraps mid-link.

**Tests:**
- [ ] `wc -l tuglaws/INDEX.md` shows ≤ 150.
- [ ] `grep -c '^## ' tuglaws/INDEX.md` ≥ 4 (at least 4 section
      headers).
- [ ] Every `tuglaws/*.md` file has a matching `(filename.md)` link
      in INDEX.md (manual eyeball; ≤ 14 entries).

**Checkpoint:**
- [ ] `wc -l tuglaws/INDEX.md` shows ≤ 150.
- [ ] Visual review.

---

#### Step 2: Promote `selection-model.md` → `card-state-model.md` and absorb state-preservation content {#step-2}

**Depends on:** #step-1

**Commit:** `docs(tuglaws): rename selection-model → card-state-model and absorb preservation content`

**References:** [D01] Promote, [D02] Doc split, [D06] Comment-only source edits, Spec `#spec-card-state-model`, (#scope)

**Artifacts:**
- `git mv tuglaws/selection-model.md tuglaws/card-state-model.md`.
- Content edits per Spec `#spec-card-state-model`:
  - Title sentence updated.
  - "Form-control Value Preservation" section added (NEW; brief).
  - "ResponderChainProvider Document-Level Infrastructure" section
    REMOVED (replaced with one-line cross-ref to
    `responder-chain.md`).
  - "Files" table updated.
- Cross-ref updates in:
  - `tuglaws/pane-model.md` (Cross-Links + Files where the old name
    appears).
  - `tuglaws/component-authoring.md` ("Selection and Focus" section's
    inline link).
  - `tuglaws/responder-chain.md` (any incoming reference to the old
    name).
  - Source-code comments under `tugdeck/src/` and `tests/` that
    reference `selection-model.md`. (Comment-only per [D06].)

**Tasks:**
- [ ] `git mv tuglaws/selection-model.md tuglaws/card-state-model.md`.
- [ ] Edit title sentence in the new file.
- [ ] Add "Form-control Value Preservation" section (≤ 30 lines).
- [ ] Strip "ResponderChainProvider Document-Level Infrastructure"
      section; replace with one-line cross-ref.
- [ ] Update Files table.
- [ ] `grep -rln 'selection-model.md' tuglaws/` — update each hit.
- [ ] `grep -rln 'selection-model.md' tugdeck/src/ tests/` — update each
      hit (comment-only per SC11; halt if the grep finds
      production code references and ask).

**Tests:**
- [ ] `test -f tuglaws/card-state-model.md && ! test -f tuglaws/selection-model.md` (SC02).
- [ ] `grep -rln 'selection-model.md' tuglaws/ tugdeck/src/ tests/`
      returns 0 lines (SC11).
- [ ] `bun x tsc --noEmit` exits 0 (SC12).
- [ ] `bun test` passes in `tugdeck/` (SC13).

**Checkpoint:**
- [ ] All four tests above pass.

---

#### Step 3: Add `tuglaws/state-preservation.md` {#step-3}

**Depends on:** #step-2

**Commit:** `docs(tuglaws): add state-preservation protocol reference`

**References:** [D02] Doc split, Spec `#spec-state-preservation`, [Q01] New laws deferred, (#scope)

**Artifacts:**
- New file `tuglaws/state-preservation.md` per Spec
  `#spec-state-preservation`.
- Backlinks added from `card-state-model.md` to
  `state-preservation.md` at the top of each axis section (Focus,
  Scroll, Form-control Value).

**Tasks:**
- [ ] Author `state-preservation.md`. Cross-reference banner at top.
- [ ] Identifier section lists ≥ 10 public identifiers (SC03).
- [ ] Link to `app-test-inventory.md` AT-tags that gate this
      protocol.
- [ ] Add "for the underlying protocol mechanism, see
      [state-preservation.md]" lines at the head of
      `card-state-model.md`'s Focus / Scroll / Form-control sections.

**Tests:**
- [ ] `test -f tuglaws/state-preservation.md` (SC03).
- [ ] `grep -F -e 'useComponentStatePreservation' -e 'useCardStatePreservation' -e 'ComponentStatePreservationRegistry' -e 'CardStatePreservationContext' -e 'FocusSnapshot' -e 'CardStateBag' -e 'data-tug-state-key' -e 'data-tug-focus-key' -e 'data-tug-scroll-key' -e 'data-tug-prompt-input-root' tuglaws/state-preservation.md | wc -l` returns ≥ 10 (SC03).
- [ ] `grep -c 'Cross-references:' tuglaws/state-preservation.md`
      ≥ 1 (SC07 banner present).

**Checkpoint:**
- [ ] All three tests pass.
- [ ] Visual readthrough of the new doc.

---

#### Step 4: Add `tuglaws/lifecycle-delegates.md` {#step-4}

**Depends on:** #step-3

**Commit:** `docs(tuglaws): add lifecycle-delegates reference`

**References:** Spec `#spec-lifecycle-delegates`, [Q01] New laws deferred, (#scope)

**Artifacts:**
- New file `tuglaws/lifecycle-delegates.md` per Spec
  `#spec-lifecycle-delegates`.

**Tasks:**
- [ ] Author the doc, sourced from `card-host.tsx`,
      `dash/tugplan-lifecycle-delegates.md`,
      `dash/lifecycle-delegate-reliability.md`, and AT0008 /
      AT0019 entries in the inventory.
- [ ] Cover the four lifecycle moments + the portal relationship.
- [ ] Cross-reference banner at top.

**Tests:**
- [ ] `test -f tuglaws/lifecycle-delegates.md` (SC04).
- [ ] `grep -F -e 'onCardActivated' -e 'cardWillBeginDestruction' -e 'onSave' -e 'onRestore' -e 'CardHost' tuglaws/lifecycle-delegates.md | wc -l` ≥ 5 (SC04).
- [ ] `grep -c 'Cross-references:' tuglaws/lifecycle-delegates.md`
      ≥ 1 (SC07).

**Checkpoint:**
- [ ] All three tests pass.
- [ ] Visual readthrough.

---

#### Step 5: Add `tuglaws/app-test-harness.md` and reduce `tests/app-test/README.md` {#step-5}

**Depends on:** #step-4

**Commit:** `docs(tuglaws): lift app-test harness architecture to tuglaws/`

**References:** [D03] Harness doc split, [Q03] Test examples, Spec `#spec-app-test-harness`, (#scope)

**Artifacts:**
- New file `tuglaws/app-test-harness.md`.
- Reduced `tests/app-test/README.md` (sections kept: Related docs,
  Running, Environment variables, Live-mode tugcode smoke, Adding a
  new test, Lint, Directory layout, TUGAPP_APP_TEST naming note).

**Tasks:**
- [ ] Author `tuglaws/app-test-harness.md` lifting per
      Spec `#spec-app-test-harness`.
- [ ] Strip the lifted sections from `tests/app-test/README.md`.
- [ ] Add a one-paragraph pointer at the top of the README:
      "For the harness *architecture* — lifecycle model, fidelity
      envelope, native-gesture rationale, accessibility-grant
      relationship — see [tuglaws/app-test-harness.md]. This README
      covers the **procedural** test-author workflow."
- [ ] Update `tests/app-test/README.md`'s "Related docs" block to
      include the new `tuglaws/app-test-harness.md` entry.

**Tests:**
- [ ] `test -f tuglaws/app-test-harness.md` (SC05).
- [ ] `grep -c 'Cross-references:' tuglaws/app-test-harness.md` ≥ 1 (SC07).
- [ ] `wc -l tests/app-test/README.md` < 250 (procedural-only target).
- [ ] `grep -c 'Accessibility grant failure modes' tests/app-test/README.md`
      returns 0 (lifted out).

**Checkpoint:**
- [ ] All four tests pass.
- [ ] Visual readthrough.

---

#### Step 6: Strip law appendix from `framework-architecture.md` {#step-6}

**Depends on:** #step-5

**Commit:** `docs(tuglaws): replace framework-architecture law appendix with cross-refs`

**References:** [D04] Strip FA appendix, [Q02] Law text replacement, SC06, (#scope)

**Artifacts:**
- `tuglaws/framework-architecture.md` — appendix block stripped,
  replaced with one-liner-list pointing to anchors in
  `tuglaws.md`.
- `tuglaws/tuglaws.md` — anchors `#l02`, `#l03`, `#l04`, `#l05`,
  `#l06`, `#l07`, `#l08`, `#l11`, `#l24` added/verified per Q02.

**Tasks:**
- [ ] Add `{#l02}` style anchors (or equivalent
      `<a id="l02"></a>` markers — match existing anchor style in
      `tuglaws.md`) to the L02–L08, L11, L24 headers.
- [ ] Strip the existing appendix block from
      `framework-architecture.md`.
- [ ] Replace with: a single H2 "Laws referenced in this document"
      section containing a list of the same laws each as a one-line
      summary + `[full text](tuglaws.md#l02)` link.

**Tests:**
- [ ] `grep -c '^### L0' tuglaws/framework-architecture.md` returns
      `0` (SC06 — the duplicated appendix headers are gone).
- [ ] `grep -c '^## Laws referenced in this document'
      tuglaws/framework-architecture.md` returns `1`.
- [ ] Every `tuglaws.md#lNN` link target in
      `framework-architecture.md` has a corresponding anchor in
      `tuglaws.md`. Manual verification: open both files, check each
      link.

**Checkpoint:**
- [ ] All three tests pass.
- [ ] Visual readthrough of `framework-architecture.md` confirms the
      doc still reads cleanly without the appendix.

---

#### Step 7: Cross-reference repairs {#step-7}

**Depends on:** #step-6

**Commit:** `docs(tuglaws): repair cross-references across the doc set`

**References:** SC08, SC09, SC10, (#scope)

**Artifacts:**
- `tuglaws/tuglaws.md` — L23 cross-references
  `state-preservation.md`; L09's cross-ref list mentions
  `lifecycle-delegates.md`.
- `tuglaws/pane-model.md` — Cross-Links section adds entries for
  `state-preservation.md` and `lifecycle-delegates.md`.
- `tuglaws/app-test-inventory.md` — every paragraph using `[A9]`
  links to `state-preservation.md` at least once in the surrounding
  section.

**Tasks:**
- [ ] Edit `tuglaws.md` per SC08.
- [ ] Edit `pane-model.md` per SC09.
- [ ] Edit `app-test-inventory.md` per SC10. The linking convention
      is to add `(see [state-preservation.md])` after the `[A9]`
      mention OR to add a paragraph-level cross-link in the
      preamble of the affected section (whichever reads cleaner per
      paragraph).

**Tests:**
- [ ] `grep -c 'state-preservation.md' tuglaws/tuglaws.md` ≥ 1 (SC08).
- [ ] `grep -c 'lifecycle-delegates.md' tuglaws/tuglaws.md` ≥ 1 (SC08).
- [ ] `grep -c 'state-preservation.md\|lifecycle-delegates.md' tuglaws/pane-model.md` ≥ 2 (SC09).
- [ ] `grep -c 'state-preservation.md' tuglaws/app-test-inventory.md` ≥ 1 (SC10).
- [ ] `bun x tsc --noEmit` exits 0 (SC12, sanity).
- [ ] `bun test` passes in `tugdeck/` (SC13, sanity).

**Checkpoint:**
- [ ] All six tests pass.

---

#### Step 8: Final audit + verification {#step-8}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7

**Commit:** `docs(tuglaws): final audit close-out for tidy-up`

**References:** All Success Criteria SC01–SC13, (#success-criteria)

**Artifacts:**
- This plan file's Status flips from `draft` to `complete (YYYY-MM-DD)`.
- A new "Audit close-out" subsection at the bottom of this plan
  recording each SC's verification command + result.

**Tasks:**
- [ ] Run every SC verification command listed in `#success-criteria`
      and record exit code / output one-liner in the close-out.
- [ ] Visual readthrough of every modified or new doc.
- [ ] Verify no doc opens with stale cross-reference banners
      (any banner mentioning the old `selection-model.md` filename
      is a regression).
- [ ] Update the Status field in this plan's Plan Metadata.

**Tests:**
- [ ] All SC01–SC13 pass.
- [ ] `bun x tsc --noEmit` exits 0.
- [ ] `bun test` passes in `tugdeck/`.

**Checkpoint:**
- [ ] All thirteen success criteria green.
- [ ] Audit close-out subsection appended.
- [ ] Plan status flipped.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** `tuglaws/` documentation set, post-tidy, with four
new docs (INDEX, state-preservation, lifecycle-delegates,
app-test-harness), one renamed doc (selection-model →
card-state-model), the law-text appendix stripped from
framework-architecture, and cross-references repaired across the
set. Code changes limited to mechanical comment-path updates;
`tugdeck/` build and tests green throughout.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All SC01–SC13 in `#success-criteria` verified green.
- [ ] All eight steps committed.
- [ ] This plan's Status: `complete (YYYY-MM-DD)`.
- [ ] Audit close-out subsection appended.

**Acceptance tests:**
- [ ] `wc -l tuglaws/INDEX.md` ≤ 150.
- [ ] `test -f tuglaws/card-state-model.md && ! test -f tuglaws/selection-model.md`.
- [ ] `test -f tuglaws/state-preservation.md`.
- [ ] `test -f tuglaws/lifecycle-delegates.md`.
- [ ] `test -f tuglaws/app-test-harness.md`.
- [ ] `grep -c '^### L0' tuglaws/framework-architecture.md` returns 0.
- [ ] `grep -rln 'selection-model.md' tuglaws/ tugdeck/src/ tests/` returns 0.
- [ ] `bun x tsc --noEmit` exits 0 in `tugdeck/`.
- [ ] `bun test` passes in `tugdeck/`.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **Token-system consolidation.** Defer per `#non-goals`.
      Revisit if a contributor asks "where do I learn the token
      system?" and finds the four-doc traversal painful.
- [ ] **Promote any `<!-- TODO: candidate law? -->` comments** added
      during Steps 3–4 to actual entries in `tuglaws.md` /
      `design-decisions.md`. Per [Q01].
- [ ] **Cross-doc anchor inventory.** A future `validate` script
      that walks every `[link](other-doc.md#anchor)` reference and
      asserts the anchor exists. Catches drift the next time a doc
      gets reorganized.

| Checkpoint | Verification |
|------------|--------------|
| INDEX added | `test -f tuglaws/INDEX.md && wc -l tuglaws/INDEX.md` ≤ 150 |
| Selection model renamed | `test -f tuglaws/card-state-model.md && ! test -f tuglaws/selection-model.md` |
| State-preservation doc added | `grep -c 'useComponentStatePreservation' tuglaws/state-preservation.md` ≥ 1 |
| Lifecycle-delegates doc added | `grep -c 'onCardActivated' tuglaws/lifecycle-delegates.md` ≥ 1 |
| App-test-harness doc added | `grep -c 'CGEvent' tuglaws/app-test-harness.md` ≥ 1 |
| FA appendix stripped | `grep -c '^### L0' tuglaws/framework-architecture.md` returns 0 |
| Cross-refs repaired | `grep -c 'state-preservation.md' tuglaws/tuglaws.md` ≥ 1 |
| No stale path | `grep -rln 'selection-model.md' tuglaws/ tugdeck/src/ tests/` returns 0 |
| Code clean | `bun x tsc --noEmit` exits 0 in `tugdeck/` |
| Tests clean | `bun test` passes in `tugdeck/` |

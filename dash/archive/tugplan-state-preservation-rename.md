<!-- tugplan-skeleton v2 -->

## State Preservation Rename — Eliminate "persist"/"persistence" from facility naming {#phase-state-preservation-rename}

**Purpose:** Rename the two state-preservation facilities — the per-component facility (`useComponentPersistence` family) and the per-card facility (`useCardPersistence` family) — so the words `persist` and `persistence` no longer appear in their identifiers, file names, DOM attributes, or human-readable labels. The new noun across the codebase is **state preservation**. Mechanical rename only; no behavior changes, no API shape changes, no file moves outside of the rename targets themselves.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken |
| Status | complete (2026-04-27) |
| Target branch | `state-preservation-rename` |
| Last updated | 2026-04-27 |

### Audit Close-out {#audit-close-out}

All 12 success criteria green at Step 7:

- **SC1–SC5, SC11a–b** (grep contracts on identifiers, DOM attribute, prose): 0 hits.
- **SC6** (no `*persistence*` files under `tugways/`): empty.
- **SC7** (no `*persist*` files under `__tests__/` except grandfathered `selection-persistence-greps.test.ts`): empty.
- **SC8** `bun x tsc --noEmit`: exit 0.
- **SC9** `bun test`: 2414/2414 pass.
- **SC10** `just app-test`: 45/45 files green; 101/101 tests pass; `VERDICT: PASS`.

Steps 1–7 landed across 7 commits (`05507e10` plan → `47d759e2` Steps 1+2 → `48942334` Step 3 → `42d150b0` Step 4 → `6f8feced` Step 5 → `42147b9e` Step 6 → Step 7 audit-only commit pending).

Step 7 also caught and fixed 7 residual `useComponentPersistence` mentions in app-test docstrings (at0026/27/30/31) plus 8 "DOM-authority persistence" / "Component Persistence Protocol" prose holdouts in card-host, tug-input, tug-textarea, gallery-input/textarea/registrations, and `content-ready-spike.test.tsx`. No behavior changes, no regressions.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The selection-plan work ([tugplan-selection.md](tugplan-selection.md)) introduced a per-component opt-in facility — `useComponentPersistence({ persistKey, captureState, restoreState })` plus `ComponentPersistenceRegistry` and `<PersistenceScope prefix>` — sitting alongside the older per-card facility `useCardPersistence({ onSave, onRestore })` and its `CardPersistenceContext` / `CardPersistenceCallbacks`. Both are still actively used: the component-level facility is consumed by 9 stateful tugways components (checkbox, switch, accordion, radio-group, choice-group, option-group, sheet, slider, value-input, plus prompt-entry chrome); the card-level facility is consumed by 5 (prompt-entry, prompt-input, markdown-view, input, textarea) plus the framework (`CardHost`, `card-registry`, `deck-manager`).

The shared name "persistence" is misleading. Neither facility writes to disk on its own — they're capture/restore protocols feeding `bag.components` and `bag.content` axes that the framework later serializes via tugbank. "Persistence" sets the wrong mental model: callers think of long-lived storage, but the load-bearing behavior is in-memory state preservation across tab switches, cmd-tab, app resign, hide/unhide, and cold-boot mount-restore. The unified noun **state preservation** describes what the facilities actually do.

This plan does the rename methodically: identifiers, file paths, DOM attributes, prose labels, and architecture-decision phrasing — all in one branch, mechanical, no design changes.

#### Strategy {#strategy}

- **Two parallel facility renames in one plan.** Component-level and card-level both rename in this branch. Treating them together avoids a halfway state where one is renamed and the other is still "persistence", which would leave consumers visually guessing.
- **`use<X>Persistence` → `use<X>StatePreservation`.** Hook, context, callbacks, scope, registry, and per-component/per-card option types all follow the substitution. The substring `Persistence` is replaced by `StatePreservation`; the substring `Persist` (in identifiers like `TugCheckboxPersistState`) is dropped — the type is just `TugCheckboxState` since "preserved" is implicit from the surrounding facility name.
- **`persistKey` → `componentStatePreservationKey` for the component-level facility.** Verbose, but unambiguous when reading a JSX call site.
- **`tug-markdown-view`'s `persistKey` is *not* part of the component-level facility.** It's an opt-in flag for selection-publish, surfaced through `useCardPersistence`. Rename it to `selectionPublishKey` to match its actual role.
- **DOM attribute `data-tug-persist-value` → `data-tug-state-key`.** The attribute is the form-control's identity in the layout-tree snapshot and the form-control snapshot's selector key. The new name reads cleanly in CSS selectors and matches the prop noun.
- **Architecture-decision tags `[A9]`, `[A9a]`, `[A9b]`, `[A9c]`, `[D13]`, `[D02]`, `[D50]`** stay as identifiers. Only the human-readable phrase that follows the tag changes — "Component Persistence Protocol" → "Component State Preservation Protocol", "persistence hook" → "state preservation hook", etc.
- **Keep the file-rename pass tightly scoped to the facility.** Rename the four hook/registry source files plus their dedicated test files. Do *not* rename scenario test files (`at0014-scroll-persistence.test.ts`, `at0026-overlay-persistence.test.ts`, `at0027-layout-state-persistence.test.ts`) — the "persistence" word in those filenames describes the test scenario, not the facility name.
- **Mechanical pass, audited after.** The rename is large enough (200+ identifier sites, 90+ DOM-attribute sites) that a scripted manifest-driven `sed` pass plus targeted edits is the right tool. After the script runs, audit by grepping for residual `persist` / `Persist` tokens and reviewing each remaining occurrence.

#### Success Criteria (Measurable) {#success-criteria}

> Falsifiable. Each criterion has a verification command or grep pattern.

- **Zero `useComponentPersistence` or `useCardPersistence` identifiers** anywhere outside `dash/`, `tuglaws/` historical references, archived directories, and the rename-plan itself: `rg -n '\b(useComponentPersistence|useCardPersistence)\b' tugdeck/src tests --glob '!**/_archive/**'` returns 0.
- **Zero `ComponentPersistenceRegistry`, `CardPersistenceContext`, `CardPersistenceCallbacks`, `CardPersistenceContextValue`, `UseComponentPersistenceOptions`, `UseCardPersistenceOptions`, `PersistenceScope`, `usePersistenceScopePrefix` identifiers**: `rg -n '\b(ComponentPersistenceRegistry|CardPersistenceContext|CardPersistenceCallbacks|CardPersistenceContextValue|UseComponentPersistenceOptions|UseCardPersistenceOptions|PersistenceScope|usePersistenceScopePrefix)\b' tugdeck/src tests --glob '!**/_archive/**'` returns 0.
- **Zero `persistKey` prop usages** except for the `selectionPublishKey` rename in `tug-markdown-view` (which is the renamed identifier, not the old one): `rg -n '\bpersistKey\b' tugdeck/src --glob '!**/_archive/**'` returns 0.
- **Zero `Tug<X>PersistState` interface declarations or references**: `rg -n '\bTug[A-Za-z]+PersistState\b' tugdeck/src --glob '!**/_archive/**'` returns 0. (`TugPromptEntryPersistedState` likewise renamed to `TugPromptEntryState`.)
- **Zero `data-tug-persist-value` DOM attribute usages** in source, selectors, comments, or tests: `rg -n 'data-tug-persist-value' tugdeck/src tests --glob '!**/_archive/**'` returns 0.
- **No file under `tugdeck/src/components/tugways/` matches `*persistence*.tsx` or `*persistence*.ts`**: `find tugdeck/src/components/tugways -iname '*persistence*'` returns empty.
- **No file under `tugdeck/src/__tests__/` matches `*persistence*` or `*persist*`** (after renames): `find tugdeck/src/__tests__ -iname '*persistence*' -o -iname '*persist*'` returns empty.
- **Type-check clean**: `cd tugdeck && bun x tsc --noEmit` exits 0.
- **All bun tests pass**: `cd tugdeck && bun test` exits 0.
- **All app-tests pass**: `just app-test` ends with `VERDICT: PASS`.
- **No prose occurrence of "Component Persistence Protocol" remains** in tuglaws, roadmap, or source comments: `rg -n 'Component Persistence Protocol' tugdeck tuglaws roadmap --glob '!**/_archive/**' --glob '!dash/tugplan-state-preservation-rename.md' --glob '!dash/tugplan-selection.md'` returns 0. (The selection plan is historical and stays untouched; this plan itself contains the old phrase in its rationale.)

#### Scope {#scope}

1. **Component-level facility rename** (`tugdeck/src/components/tugways/`):
   - File: `use-component-persistence.tsx` → `use-component-state-preservation.tsx`.
   - File: `component-persistence-registry.ts` → `component-state-preservation-registry.ts`.
   - All exported identifiers, types, contexts, and helper functions in those files.
2. **Card-level facility rename** (`tugdeck/src/components/tugways/`):
   - File: `use-card-persistence.tsx` → `use-card-state-preservation.tsx`.
   - All exported identifiers, types, contexts, and callback shapes in that file.
3. **Test file renames**:
   - `tugdeck/src/__tests__/use-component-persistence.test.tsx` → `use-component-state-preservation.test.tsx`.
   - `tugdeck/src/__tests__/use-card-persistence.test.tsx` → `use-card-state-preservation.test.tsx`.
   - `tugdeck/src/components/tugways/__tests__/component-persistence-registry.test.ts` → `component-state-preservation-registry.test.ts`.
   - `tugdeck/src/components/tugways/__tests__/tug-checkbox.persistence.test.tsx` → `tug-checkbox.state-preservation.test.tsx`.
4. **Consumer prop renames** (9 component files): every `persistKey?` prop on a component that calls `useComponentPersistence` becomes `componentStatePreservationKey?`.
5. **Per-component state interface renames**: `TugCheckboxPersistState` → `TugCheckboxState`, and the same drop for radio-group, switch, accordion, option-group, sheet, choice-group, slider, value-input. `TugPromptEntryPersistedState` → `TugPromptEntryState`.
6. **Tug-markdown-view's `persistKey`** is renamed to `selectionPublishKey` (it does not belong to the component-level facility — see [D05]).
7. **DOM attribute `data-tug-persist-value` → `data-tug-state-key`** in `tug-input.tsx`, `tug-textarea.tsx`, all selector strings, `default-focus.ts`, `deck-trace.ts`, `card-host.tsx`, `focus-transfer.ts`, `test-surface.ts`, `layout-tree.ts`, and tests.
8. **Framework-internal field/method renames**:
   - `componentRegistries` (Map field in `deck-manager.ts` and tests) → `componentStatePreservationRegistries`.
   - `getComponentRegistry()` → `getComponentStatePreservationRegistry()`.
   - `persistenceCallbacksRef` (in `card-host.tsx`) → `cardStatePreservationCallbacksRef`.
   - `cardPersistenceContextValue` (in `card-host.tsx`) → `cardStatePreservationContextValue`.
   - `componentRegistryContextValue` (in `card-host.tsx`) → `componentStatePreservationContextValue`.
   - `persistenceCtx` (local in `use-card-state-preservation.tsx`) → `statePreservationCtx`.
9. **Tug-prompt-input internals**:
   - `persistState?: boolean` prop → `preserveState?: boolean`.
   - `TugPromptInputPersistence` internal component → `TugPromptInputStatePreservation`.
10. **Architecture-decision-tag prose updates** (no tag-id changes):
    - `[A9] Component Persistence Protocol` → `[A9] Component State Preservation Protocol` in `tuglaws/app-test-inventory.md`, `tuglaws/design-decisions.md`, `tugdeck/src/**/*` comments, and test docstrings.
    - `D02. persistence hook` / `D50. useCardPersistence hook` prose updates in `tuglaws/design-decisions.md` (tag `[D02]` and `[D50]` keep their identifiers).
    - "persistence registry" / "persistence protocol" / "persistence callbacks" / "card persistence" → corresponding "state preservation" phrasing throughout production-source comments, JSDoc, and the inventory doc.
11. **Update `MEMORY.md` if any memory file references the renamed identifiers.**

#### Non-goals (Explicitly out of scope) {#non-goals}

- **No behavior changes.** Capture/restore semantics, registration order, dev-warn behaviors, scope-prefix concatenation, tree-path iteration, dup-key dev-throw, orphan-key dev-warn, content-ready timing, restore-pending-ref signaling — all preserved byte-for-byte.
- **No API shape changes.** Hook signatures, callback signatures, context-value shapes, and method shapes stay identical except for identifier names.
- **No file moves outside the rename targets.** `card-state-orchestrator.ts`, `card-host.tsx`, `deck-manager.ts`, `layout-tree.ts`, etc. stay in place — only their content (imports, type references, identifier mentions) changes.
- **No scenario-test renames.** `at0014-scroll-persistence.test.ts`, `at0026-overlay-persistence.test.ts`, `at0027-layout-state-persistence.test.ts`, and `selection-persistence-greps.test.ts` keep their filenames — they describe scenarios, not the facility. Their internal docstring references to "Component Persistence Protocol" *do* update.
- **No tag-id changes.** `[A9]`, `[A9a..c]`, `[D02]`, `[D13]`, `[D50]`, `[D78]`, `[D79]` etc. all stay as identifiers. Only the prose label changes.
- **No tugbank wire-format changes.** `bag.components` and `bag.content` axis names are already neutral and stay.
- **No `tugplan-selection.md` content rewrite.** That plan is historical reference; its prose containing "Component Persistence Protocol" is grandfathered. (A small note can be added at the top pointing readers to the new naming, but the body stays.)
- **No cleanup of `_archive/` directories.** `tugdeck/src/_archive/` is excluded from grep contracts.
- **No rename of `restorePendingRef`, `onContentReady`, `onCardActivated`, `onCardWillDeactivate`** — these field names are already neutral and don't contain "persist".
- **No rename of `bag.formControls`, `selectionGuard`, `cardRanges`** — out of scope; these belong to the form-control snapshot and selection-guard subsystems.

#### Dependencies / Prerequisites {#dependencies}

- A green `bun test` run on `main` immediately before this branch starts, captured as the pre-rename baseline.
- A green `just app-test` run on `main` immediately before this branch starts.
- Repo-wide grep results for every cross-reference site (production source, tests, plans, tuglaws docs, README, CLAUDE.md, memory) gathered before the rename pass — the manifest of touch points.
- `bun x tsc --noEmit` clean inside `tugdeck/` immediately before the rename.

#### Constraints {#constraints}

- **Warnings-are-errors policy persists.** Rust workspace's `-D warnings` invariant is not touched, but any new TypeScript warning introduced by the rename must be fixed before commit.
- **The rename must be reviewable as a single coherent diff per facility.** Coder steps are sized so each commit is internally consistent (no half-renamed file at a commit boundary).
- **No mid-flight refactors.** If the rename surfaces an obvious-but-unrelated cleanup opportunity (e.g. a dead import, a misnamed local variable unrelated to persist/persistence), defer it. This plan is a rename, not a cleanup pass.

#### Assumptions {#assumptions}

- The rename is mechanical enough that scripted `sed` over a manifest is the right tool, with manual edits for the few cases where context matters (e.g. preserving comment grammar around the renamed phrase).
- Both facilities are currently exercised by green tests, so the rename's correctness is verifiable by re-running the existing test sweep without writing new tests.
- The user accepts long identifier names (`componentStatePreservationKey`, `cardStatePreservationCallbacksRef`) over short ones — clarity over brevity, per [Q05] resolution.
- `tug-markdown-view`'s `persistKey` is the only component-level prop name that does *not* feed `useComponentPersistence` and therefore needs a different rename target.

---

### Open Questions (resolved) {#open-questions}

#### [Q01] What replaces `persistKey` on the component-level facility? (DECIDED — see [D02]) {#q01-key-name}

**Question:** `persistKey` → ? Candidates: `key` (collides with React's reserved prop), `stateKey` (terse but ambiguous with React state), `componentStatePreservationKey` (verbose but unambiguous), `preservationKey` (medium).

**Resolution:** `componentStatePreservationKey`. Verbose, but every JSX call site reads as exactly what it does, and the verbosity is bounded by the small number of stateful components.

#### [Q02] Should `tug-markdown-view`'s `persistKey` rename to `componentStatePreservationKey` or to a new name? (DECIDED — see [D05]) {#q02-markdown-key}

**Question:** Tug-markdown-view's `persistKey` is an opt-in flag for selection-publish (writes to `selectionGuard.updateCardDomSelection` and registers a no-op `useCardPersistence`). It is *not* keyed into `bag.components`. Renaming it `componentStatePreservationKey` would mislabel its role.

**Resolution:** Rename to `selectionPublishKey`. Reflects its actual role; avoids carrying forward the misnomer.

#### [Q03] Should the DOM attribute `data-tug-persist-value` change? (DECIDED — see [D04]) {#q03-dom-attr}

**Question:** ~91 references across selectors, CSS, tests, comments. Cost of renaming is high but bounded.

**Resolution:** Yes, rename to `data-tug-state-key`. Consistency requires it; the attribute is the form-control's identity hook in the layout-tree and form-control snapshot subsystems, which are part of the broader state-preservation surface. Short attribute name reads cleanly in selectors.

#### [Q04] What happens to `useCardPersistence` and the `CardPersistence*` family? (DECIDED — see [D06]) {#q04-card-facility}

**Question:** Heavily used across tugways and the framework (5 components + `CardHost` + `card-registry` + `deck-manager`). Rename now or defer to a follow-up?

**Resolution:** Rename now in this same plan. Two facilities, one rename branch, one consistent vocabulary. Leaving it for a follow-up would mean a halfway state where readers see "useCardPersistence" next to "useComponentStatePreservation" and have to ask "are these the same era of code?" every time.

#### [Q05] How verbose should internal field/local-var names be? (DECIDED — see [D07]) {#q05-verbosity}

**Question:** Should `componentRegistries` (a private Map field on DeckManager whose value type already says `ComponentPersistenceRegistry`) become `componentStatePreservationRegistries`, or stay short on the grounds that the type carries the noun?

**Resolution:** Verbose. Clear and consistent names take priority over short ones. `componentRegistries` → `componentStatePreservationRegistries`, `getComponentRegistry()` → `getComponentStatePreservationRegistry()`, etc.

#### [Q06] What replaces the `Tug<X>PersistState` interfaces? (DECIDED — see [D03]) {#q06-component-state-types}

**Question:** Drop the `Persist` infix and call them `Tug<X>State`, or keep something carrying the meaning (`Tug<X>PreservedState`)?

**Resolution:** `Tug<X>State`. The "preserved" semantics is implicit from the surrounding hook (`useComponentStatePreservation<TugCheckboxState>`); the type itself is just the shape of the saved value. `TugPromptEntryPersistedState` follows the same rule → `TugPromptEntryState`.

---

### Decisions {#decisions}

#### [D01] Unified noun: "state preservation" {#d01-noun}

The facility noun across all renames is **state preservation**. Variants:
- Hook prefix: `use<X>StatePreservation`.
- Type prefix: `<X>StatePreservation<Suffix>` (e.g. `ComponentStatePreservationRegistry`, `CardStatePreservationContext`).
- Prose: "state preservation protocol", "state preservation hook", "state preservation registry".
- Tag prose: `[A9] Component State Preservation Protocol`.

#### [D02] Component-level prop name: `componentStatePreservationKey` {#d02-prop}

The opt-in key on a stateful component becomes `componentStatePreservationKey?: string`. The dropped substring is `persist`; the substituted noun is `componentStatePreservation`.

#### [D03] Component state types drop the "Persist" infix {#d03-state-types}

| Old | New |
|-----|-----|
| `TugCheckboxPersistState` | `TugCheckboxState` |
| `TugRadioGroupPersistState` | `TugRadioGroupState` |
| `TugSwitchPersistState` | `TugSwitchState` |
| `TugAccordionPersistState` | `TugAccordionState` |
| `TugOptionGroupPersistState` | `TugOptionGroupState` |
| `TugSheetPersistState` | `TugSheetState` |
| `TugChoiceGroupPersistState` | `TugChoiceGroupState` |
| `TugSliderPersistState` | `TugSliderState` |
| `TugValueInputPersistState` | `TugValueInputState` |
| `TugPromptEntryPersistedState` | `TugPromptEntryState` |
| `TugPromptEntryChromeState` | unchanged (already neutral) |

#### [D04] DOM attribute: `data-tug-state-key` {#d04-dom-attr}

`data-tug-persist-value` → `data-tug-state-key`. Updated in JSX, CSS selectors, attribute reads (`getAttribute(...)`), comments, and tests.

#### [D05] Tug-markdown-view's prop: `selectionPublishKey` {#d05-markdown-key}

`tug-markdown-view`'s `persistKey?: string` opts the view into selection-publish (subscribing to `document.selectionchange` and forwarding ranges through `selectionGuard.updateCardDomSelection`). It does *not* feed `useComponentPersistence` and is not a component-state key. New name: `selectionPublishKey?: string`.

#### [D06] Card-level facility renames in the same branch {#d06-card-facility-scope}

The `useCardPersistence` family is renamed in this same plan, not deferred. Identifier map:

| Old | New |
|-----|-----|
| `useCardPersistence` | `useCardStatePreservation` |
| `UseCardPersistenceOptions` | `UseCardStatePreservationOptions` |
| `CardPersistenceContext` | `CardStatePreservationContext` |
| `CardPersistenceContextValue` | `CardStatePreservationContextValue` |
| `CardPersistenceCallbacks` | `CardStatePreservationCallbacks` |
| File `use-card-persistence.tsx` | `use-card-state-preservation.tsx` |
| File `__tests__/use-card-persistence.test.tsx` | `use-card-state-preservation.test.tsx` |

#### [D07] Verbose internal names {#d07-verbosity}

Field, local-var, and method names use the full `componentStatePreservation` / `cardStatePreservation` noun. No abbreviations.

| Old | New | Where |
|-----|-----|-------|
| `componentRegistries` | `componentStatePreservationRegistries` | `deck-manager.ts`, mock stores, test fakes |
| `getComponentRegistry()` | `getComponentStatePreservationRegistry()` | `DeckManager`, `IDeckManagerStore` |
| `persistenceCallbacksRef` | `cardStatePreservationCallbacksRef` | `card-host.tsx` |
| `cardPersistenceContextValue` | `cardStatePreservationContextValue` | `card-host.tsx` |
| `componentRegistryContextValue` | `componentStatePreservationContextValue` | `card-host.tsx` |
| `persistenceCtx` | `statePreservationCtx` | `use-card-state-preservation.tsx` |
| `CardComponentRegistryContext` | `CardComponentStatePreservationContext` | `use-component-state-preservation.tsx` |
| `CardComponentRegistryContextValue` | `CardComponentStatePreservationContextValue` | `use-component-state-preservation.tsx` |

#### [D08] Tug-prompt-input internal renames {#d08-prompt-input}

| Old | New |
|-----|-----|
| `persistState?: boolean` (prop) | `preserveState?: boolean` |
| `TugPromptInputPersistence` (internal component) | `TugPromptInputStatePreservation` |

#### [D09] Architecture-decision tag prose updates {#d09-tag-prose}

Tag identifiers (`[A9]`, `[A9a]`, `[A9b]`, `[A9c]`, `[D02]`, `[D13]`, `[D50]`, etc.) are unchanged. The human-readable phrase that follows each tag changes:

- `[A9] Component Persistence Protocol` → `[A9] Component State Preservation Protocol`.
- `[D02] persistence hook` → `[D02] card state preservation hook`.
- `[D13] component persistence protocol` → `[D13] component state preservation protocol`.
- `[D50] useCardPersistence` → `[D50] useCardStatePreservation`.
- All "persistence registry", "persistence protocol", "persistence callbacks", "card persistence", "component persistence" prose in production-source comments, JSDoc, tuglaws docs, and inventory entries → corresponding "state preservation" phrasing.

#### [D10] File-rename targets {#d10-file-renames}

| Old | New |
|-----|-----|
| `tugdeck/src/components/tugways/use-component-persistence.tsx` | `use-component-state-preservation.tsx` |
| `tugdeck/src/components/tugways/use-card-persistence.tsx` | `use-card-state-preservation.tsx` |
| `tugdeck/src/components/tugways/component-persistence-registry.ts` | `component-state-preservation-registry.ts` |
| `tugdeck/src/components/tugways/__tests__/component-persistence-registry.test.ts` | `component-state-preservation-registry.test.ts` |
| `tugdeck/src/components/tugways/__tests__/tug-checkbox.persistence.test.tsx` | `tug-checkbox.state-preservation.test.tsx` |
| `tugdeck/src/__tests__/use-component-persistence.test.tsx` | `use-component-state-preservation.test.tsx` |
| `tugdeck/src/__tests__/use-card-persistence.test.tsx` | `use-card-state-preservation.test.tsx` |

---

### Rename Manifest — Identifiers {#rename-manifest-identifiers}

#### Component-level facility {#manifest-component}

| Old | New |
|-----|-----|
| `useComponentPersistence` | `useComponentStatePreservation` |
| `UseComponentPersistenceOptions` | `UseComponentStatePreservationOptions` |
| `ComponentPersistenceRegistry` | `ComponentStatePreservationRegistry` |
| `PersistenceScope` | `ComponentStatePreservationScope` |
| `PersistenceScopeProps` | `ComponentStatePreservationScopeProps` |
| `usePersistenceScopePrefix` | `useComponentStatePreservationScopePrefix` |
| `CardComponentRegistryContext` | `CardComponentStatePreservationContext` |
| `CardComponentRegistryContextValue` | `CardComponentStatePreservationContextValue` |
| `ComponentRegistryLookup` (in `card-state-orchestrator.ts`) | `ComponentStatePreservationRegistryLookup` |
| `persistKey` (prop, all 9 stateful components) | `componentStatePreservationKey` |
| `Tug<X>PersistState` (9 interfaces) | `Tug<X>State` |

#### Card-level facility {#manifest-card}

| Old | New |
|-----|-----|
| `useCardPersistence` | `useCardStatePreservation` |
| `UseCardPersistenceOptions` | `UseCardStatePreservationOptions` |
| `CardPersistenceContext` | `CardStatePreservationContext` |
| `CardPersistenceContextValue` | `CardStatePreservationContextValue` |
| `CardPersistenceCallbacks` | `CardStatePreservationCallbacks` |
| `TugPromptEntryPersistedState` | `TugPromptEntryState` |
| `persistState?` (prop, `TugPromptInput`) | `preserveState?` |
| `TugPromptInputPersistence` (internal component) | `TugPromptInputStatePreservation` |

#### Tug-markdown-view (selection-publish, not state preservation) {#manifest-markdown}

| Old | New |
|-----|-----|
| `persistKey?` (prop) | `selectionPublishKey?` |

#### DOM attribute {#manifest-dom-attr}

| Old | New |
|-----|-----|
| `data-tug-persist-value` | `data-tug-state-key` |

---

### Steps {#steps}

#### Step 1: Component-level facility rename — files, identifiers, types {#step-1}

**Owner:** coder
**Commit:** `refactor(tugways): rename Component Persistence Protocol → Component State Preservation Protocol`

**Touch set:**
- Rename file `use-component-persistence.tsx` → `use-component-state-preservation.tsx`.
- Rename file `component-persistence-registry.ts` → `component-state-preservation-registry.ts`.
- Inside the renamed files, apply identifier renames per [Component-level facility](#manifest-component) manifest.
- Update all importers:
  - `tugdeck/src/components/tugways/tug-checkbox.tsx`
  - `tugdeck/src/components/tugways/tug-radio-group.tsx`
  - `tugdeck/src/components/tugways/tug-switch.tsx`
  - `tugdeck/src/components/tugways/tug-accordion.tsx`
  - `tugdeck/src/components/tugways/tug-option-group.tsx`
  - `tugdeck/src/components/tugways/tug-sheet.tsx`
  - `tugdeck/src/components/tugways/tug-choice-group.tsx`
  - `tugdeck/src/components/tugways/tug-slider.tsx`
  - `tugdeck/src/components/tugways/tug-value-input.tsx`
  - `tugdeck/src/components/tugways/tug-prompt-entry.tsx` (component-level call only — the card-level call stays; renamed in Step 2)
  - `tugdeck/src/components/chrome/card-host.tsx`
  - `tugdeck/src/deck-manager.ts`
  - `tugdeck/src/deck-manager-store.ts`
  - `tugdeck/src/card-state-orchestrator.ts`
  - `tugdeck/src/layout-tree.ts`
- For each consumer above: rename `persistKey?` prop → `componentStatePreservationKey?`, drop `Persist` infix from interface names, update JSDoc and comments.
- Update `componentRegistries` field, `getComponentRegistry()` method, and `componentRegistryContextValue` local in `deck-manager.ts` and `card-host.tsx` per [D07].
- Rename gallery file references and update `gallery-state-preservation.tsx` JSDoc.
- Verify: `bun x tsc --noEmit` clean; `bun test` passes the 3 dedicated tests (`tug-checkbox.persistence.test.tsx`, `component-persistence-registry.test.ts`, `use-component-persistence.test.tsx`) — they still run under their old filenames at this point; rename in Step 4.

**Acceptance:**
- `rg -n '\b(useComponentPersistence|ComponentPersistenceRegistry|PersistenceScope|usePersistenceScopePrefix|UseComponentPersistenceOptions|CardComponentRegistryContext|persistKey)\b' tugdeck/src --glob '!**/_archive/**' --glob '!**/tug-markdown-view.tsx'` returns 0 hits.
- `rg -n '\bTug[A-Za-z]+PersistState\b' tugdeck/src --glob '!**/_archive/**'` returns 0 hits.
- `bun x tsc --noEmit` exits 0.
- `bun test` passes.

---

#### Step 2: Card-level facility rename — files, identifiers, types {#step-2}

**Owner:** coder
**Commit:** `refactor(tugways): rename useCardPersistence → useCardStatePreservation`

**Touch set:**
- Rename file `use-card-persistence.tsx` → `use-card-state-preservation.tsx`.
- Inside the renamed file, apply identifier renames per [Card-level facility](#manifest-card) manifest.
- Update all importers:
  - `tugdeck/src/components/tugways/tug-prompt-entry.tsx` — also rename `TugPromptEntryPersistedState` → `TugPromptEntryState`.
  - `tugdeck/src/components/tugways/tug-prompt-input.tsx` — also rename `persistState` prop → `preserveState`, `TugPromptInputPersistence` → `TugPromptInputStatePreservation`.
  - `tugdeck/src/components/tugways/tug-markdown-view.tsx` (consumer of `useCardPersistence` and `useCardId`).
  - `tugdeck/src/components/tugways/tug-input.tsx` (comment-only references).
  - `tugdeck/src/components/tugways/tug-textarea.tsx` (comment-only references).
  - `tugdeck/src/components/chrome/card-host.tsx` — rename `persistenceCallbacksRef` → `cardStatePreservationCallbacksRef`, `cardPersistenceContextValue` → `cardStatePreservationContextValue`.
  - `tugdeck/src/deck-manager.ts`, `tugdeck/src/test-surface.ts`, `tugdeck/src/card-registry.ts`, `tugdeck/src/layout-tree.ts` (comment + identifier references).
- Update gallery files: `gallery-textarea.tsx`, `gallery-markdown-view.tsx`.
- Update `__tests__/use-card-persistence.test.tsx`, `__tests__/react19-commit-timing.test.tsx`, `__tests__/deck-manager.test.ts`, `__tests__/content-ready-spike.test.tsx`, `__tests__/card-host-composition.test.tsx`.
- Update app-tests under `tests/app-test/` that reference `useCardPersistence`: `at0002-tab-switch-em.test.ts`, `at0031-prompt-entry-chrome.test.ts`, `harness-smoke/smoke-em.test.ts`.

**Acceptance:**
- `rg -n '\b(useCardPersistence|UseCardPersistenceOptions|CardPersistenceContext|CardPersistenceCallbacks|CardPersistenceContextValue|TugPromptEntryPersistedState|TugPromptInputPersistence|persistenceCallbacksRef|persistenceCtx|cardPersistenceContextValue)\b' tugdeck/src tests --glob '!**/_archive/**'` returns 0 hits.
- `rg -n '\bpersistState\b' tugdeck/src tests --glob '!**/_archive/**'` returns 0 hits.
- `bun x tsc --noEmit` exits 0.
- `bun test` passes.

---

#### Step 3: DOM attribute rename — `data-tug-persist-value` → `data-tug-state-key` {#step-3}

**Owner:** coder
**Commit:** `refactor(tugways): rename data-tug-persist-value → data-tug-state-key`

**Touch set:**
- `tugdeck/src/components/tugways/tug-input.tsx` (JSX attribute + comment).
- `tugdeck/src/components/tugways/tug-textarea.tsx` (JSX attribute + comment).
- `tugdeck/src/focus-transfer.ts` (selectors, attribute reads).
- `tugdeck/src/test-surface.ts` (selectors, attribute reads, JSDoc).
- `tugdeck/src/default-focus.ts` (selectors).
- `tugdeck/src/deck-trace.ts` (attribute name in trace serializer).
- `tugdeck/src/layout-tree.ts` (JSDoc references).
- `tugdeck/src/components/chrome/card-host.tsx` (selectors, attribute reads).
- All app-test scenarios that read `data-tug-persist-value` from the DOM.
- Update `tuglaws/selection-model.md`, `tuglaws/pane-model.md`, and any other tuglaw doc that names the attribute.

**Acceptance:**
- `rg -n 'data-tug-persist-value' tugdeck/src tests tuglaws --glob '!**/_archive/**'` returns 0 hits.
- `bun x tsc --noEmit` exits 0.
- `bun test` passes.
- `just app-test` ends with `VERDICT: PASS`.

---

#### Step 4: Test-file renames {#step-4}

**Owner:** coder
**Commit:** `test(tugways): rename persistence test files to state-preservation`

**Touch set:**
- Rename files:
  - `tugdeck/src/__tests__/use-component-persistence.test.tsx` → `use-component-state-preservation.test.tsx`.
  - `tugdeck/src/__tests__/use-card-persistence.test.tsx` → `use-card-state-preservation.test.tsx`.
  - `tugdeck/src/components/tugways/__tests__/component-persistence-registry.test.ts` → `component-state-preservation-registry.test.ts`.
  - `tugdeck/src/components/tugways/__tests__/tug-checkbox.persistence.test.tsx` → `tug-checkbox.state-preservation.test.tsx`.
- Update `describe(...)` strings, file-header docstrings, and comment references inside each renamed test file to use the new noun.
- Update any test-file-name references in inventories (`tuglaws/app-test-inventory.md`, README files) that mention the old paths.

**Acceptance:**
- `find tugdeck/src -iname '*persistence*' -o -iname '*persist*'` returns empty (excluding `_archive/`).
- `bun test` passes.

---

#### Step 5: Architecture-decision-tag prose + tuglaws + inventory updates {#step-5}

**Owner:** coder
**Commit:** `docs: rename Component Persistence Protocol → Component State Preservation Protocol in tuglaws and inventories`

**Touch set:**
- `tuglaws/app-test-inventory.md`: every "[A9] persistence protocol", "Component Persistence Protocol", "component-level persistence", "useComponentPersistence", "useCardPersistence", "ComponentPersistenceRegistry", "persistKey", "data-tug-persist-value", `Tug<X>PersistState` reference is updated to the new noun/identifier per [D01]/[D09].
- `tuglaws/design-decisions.md`: update [D02], [D13], [D50] prose; update any other entry that contains "persist" / "persistence" referring to either facility.
- `tuglaws/pane-model.md`: update the "useCard*" hooks table entry and the file-path table entry.
- `tuglaws/selection-model.md`: update "Focus Persistence Attributes" header → "Focus State Preservation Attributes" (header + body), and any selector mentions of `data-tug-persist-value`.
- `tuglaws/framework-architecture.md`: update any prose carrying "persistence" referring to these facilities.
- `tugdeck/src/**/*.tsx` and `tugdeck/src/**/*.ts`: production-source JSDoc and comments — every "persistence protocol", "persistence registry", "persistence callbacks", "card persistence", "component persistence" → corresponding "state preservation" wording.
- `tests/app-test/at0026-overlay-persistence.test.ts`, `at0027-layout-state-persistence.test.ts`, `at0030-virtual-focus.test.ts`, `at0031-prompt-entry-chrome.test.ts`: update *internal* docstring references to "Component Persistence Protocol" (filenames stay).
- `dash/tugplan-selection.md`: leave the body untouched; optionally add a one-line note at the top: "Note (2026-04-XX): the 'Component Persistence Protocol' described below has been renamed to 'Component State Preservation Protocol'. See `tugplan-state-preservation-rename.md`."

**Acceptance:**
- `rg -n 'Component Persistence Protocol' tugdeck tests tuglaws roadmap --glob '!**/_archive/**' --glob '!dash/tugplan-state-preservation-rename.md' --glob '!dash/tugplan-selection.md'` returns 0 hits.
- `rg -n '\bpersistence protocol|persistence registry|persistence callbacks|card persistence\b' tugdeck tuglaws --glob '!**/_archive/**'` returns 0 hits.

---

#### Step 6: Memory + CLAUDE.md sweep {#step-6}

**Owner:** coder
**Commit:** `chore: update memory and project notes for state-preservation rename`

**Touch set:**
- Grep `~/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/memory/` for any memory file naming the renamed identifiers; update or annotate as needed.
- Grep `CLAUDE.md` for references to the renamed identifiers; update.
- Grep `.tugtool/session-memory.md` (if relevant to current session) for renamed identifiers.

**Acceptance:**
- `rg -n '\b(useComponentPersistence|useCardPersistence|persistKey|data-tug-persist-value)\b' ~/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/memory CLAUDE.md` returns 0 hits.

---

#### Step 7: Final audit + verification {#step-7}

**Owner:** auditor
**Commit:** none (read-only audit)

**Touch set:**
- Run all success-criteria grep commands; verify each returns 0 hits.
- Run `bun x tsc --noEmit` from `tugdeck/`.
- Run `bun test` from `tugdeck/`.
- Run `just app-test` to a `VERDICT: PASS` line.
- Walk the diff one more time looking for residual `Persist` / `persist` tokens that should have been renamed but weren't (e.g. variable names embedded in deeply nested helper functions, attribute reads in tests).

**Acceptance:**
- All success criteria from [Success Criteria](#success-criteria) verified green.
- A short audit summary added to the plan as a closing note when the branch merges.

---

### Out-of-scope clarifications {#out-of-scope-clarifications}

- **Scenario test filenames** (`at0014-scroll-persistence.test.ts`, `at0026-overlay-persistence.test.ts`, `at0027-layout-state-persistence.test.ts`, `selection-persistence-greps.test.ts`) keep their filenames. Scenario names describe what the test exercises (a feature scenario named "scroll persistence"), not the facility. Their internal docstring references *do* update.
- **`bag.components` and `bag.content` axis names** keep their current spelling — already neutral.
- **`restorePendingRef`, `onContentReady`, `onCardActivated`, `onCardWillDeactivate`, `restoreState`, `captureState`, `onSave`, `onRestore`** keep their current names — already neutral.
- **`tugplan-selection.md`** body stays untouched (historical reference), with one optional pointer note at the top.

---

### References {#references}

- Per-component facility origin: [tugplan-selection.md](tugplan-selection.md) — Steps 16–19 introduced `useComponentPersistence`, `<PersistenceScope>`, `ComponentPersistenceRegistry`, and `bag.components`.
- Per-card facility origin: framework-architecture rule set in `tuglaws/framework-architecture.md`; design decisions in `tuglaws/design-decisions.md` (especially [D02], [D50]).
- Tag conventions: `[A9]`, `[D02]`, `[D13]`, `[D50]` in `tuglaws/design-decisions.md` and `tuglaws/app-test-inventory.md`.
- Tug-markdown-view's `persistKey` semantics: `tug-markdown-view.tsx` line 230 onward (selection-publish opt-in via `selectionGuard.updateCardDomSelection`).

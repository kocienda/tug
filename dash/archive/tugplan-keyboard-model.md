# The Tug Keyboard Model — Focus / Move / Act over Hierarchical Scopes {#keyboard-model}

Realize the settled Tug keyboard-interaction model across the component library: one rule everywhere — **Tab** picks the component, **arrows** move a cursor within it, **Space** selects / **Enter** acts-or-descends / **Escape** ascends-or-cancels — over a stack of nestable scopes. This plan is the clean, forward-only successor to `tugplan-keyboard-access.md` (now archived): that document built the focus engine and a first, web-convention pass at component keyboard support, then the model was reconceived; this plan keeps the engine substrate and redoes component behavior against the new model.

### Plan Metadata {#plan-metadata}

- **Status:** active
- **Predecessor:** `dash/archive/tugplan-keyboard-access.md` (engine substrate built there; its `[P15]` + Keyboard Behavior Matrix + `[Q04]` are the source of this plan's governing decisions, restated here clean).
- **Surface:** tugdeck / tugways (TypeScript/React); no Rust/Swift except the existing dual-mode host menu.
- **Build/test:** `bunx tsc --noEmit` (warnings are errors); `bun test` (pure logic); `just app-test <file>` for real-app keyboard behavior (greppable `VERDICT: PASS|FAIL`).
- **Laws:** [L02] external state via `useSyncExternalStore`; [L03] registrations in `useLayoutEffect`; [L06] appearance via CSS/DOM, never React state; [L07] live values via refs; [L22] observe/mutate store→DOM without a render round-trip; [L24] state-zone discipline; [L26] mount identity.

### Phase Overview {#phase-overview}

#### Context {#context}

The focus engine exists and works: an app-owned `FocusManager` co-located with the responder chain owns the **key view** (the single keyboard-target element), a focusable **registry**, an authored **Tab walk** (`focus-next`/`focus-previous`), a **scope stack** (`pushFocusMode`/`popFocusMode`, `trapped`, `restoreKeyView`, per-scope default-action), a **keybinding registry**, the **keyboard-access mode**, the **ring-modality** toggle, and a single **focus-ring** painted on `[data-key-view-kbd]`. What was *wrong* was the first pass at component behavior: it followed web conventions piecemeal (roving-tabindex, arrow-selects-radio, ring-moves-onto-the-roved-member, scroll-only lists), which is neither what Tug wants nor internally consistent. The model below replaces that conception; the engine substrate stays.

#### Strategy {#strategy}

- **State the model once, build it once, then declare per component.** The governing model is [P01]; build its missing engine pieces in [#step-1]/[#step-2]; then each component is a *thin declaration* of "what is my move, what is my act, am I a container," not a bespoke keyboard implementation.
- **Keep the engine, redo behavior.** Reuse `registerFocusable`, the Tab walk, and the scope stack verbatim. The new engine work is the **movement cursor**, the **`data-key-within`** visual, **Enter-descend / Escape-ascend** wiring onto the existing scope stack, the **act dispatch** (Space/Enter/Escape → select/act/descend/ascend), and the per-component **key-capture set** (generalizing `consumesTab`).
- **One ring, three states.** The ring marks the *component* (never a sub-item); the immediate container shows a quiet `data-key-within` mark; the current item inside a deferred component wears the *mouse-hover* look. See [P03].
- **Text editors invert the model.** They are leaves that capture most keys for editing; the engine routes only what they don't capture. See [P04].
- **Land deferred groups first, surfaces last.** Redo the simple item-groups (radio/choice/option) to shake out the engine pieces, then live components, then the descend cases (accordion/list), then the never-built floating/trap surfaces and inline dialogs, then the (deferred) `refuse` audit.

#### Success Criteria (Measurable) {#success-criteria}

- Every component in the [Keyboard Behavior Matrix](#keyboard-matrix) behaves per its row, proven by a `just app-test` scenario (`VERDICT: PASS`).
- Tab moves only between *components* (never row-by-row / tab-by-tab); a deferred group/list/accordion is exactly one Tab stop.
- The focus ring is on the component and never moves onto a sub-item; the current item wears the hover look; the immediate container wears `data-key-within`.
- Space selects, Enter acts/descends, Escape ascends/cancels — verified on a nested case (accordion → descend → operate inner component → Escape ascends).
- A text editor captures typing/caret while Tab and Escape still leave it at rest (no trap). While an inline dialog is visible the prompt **deactivates** and the dialog is modal for keys (arrows move its selection, Return activates, Escape cancels) per [P06].
- `bunx tsc --noEmit` clean; `bun test` green; no new lint findings.

#### Scope {#scope}

- The engine foundation for the model ([#step-1], [#step-2]).
- Text-editing key capture ([#step-3]).
- Redo of components built under the old conception: deferred groups (radio/choice/option), live (tab bar/slider), accordion, list view.
- The not-yet-built surfaces: tooltip, popover, context menu (+ editor context menu), popup menu, sheet, alert, inline dialogs.
- `refuse`/first-responder audit against the new model (deferred — see [#step-15]).
- The focus-language modernization spike — settle the new keyboard-focus indicator language in the gallery ([#focus-language-modernization]).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Rebuilding the engine substrate (registry, Tab walk, scope stack, keybinding registry, ring primitive, ring-modality) — kept as-is.
- Re-litigating the kept leaves' *visuals* — `TugButton`/`TugCheckbox`/`TugSwitch`/`TugSlider` keep their look; only act-key consistency is confirmed.
- OS-signal auto-engage of accessibility mode (AT follow-on).
- Nested in-transcript body-kind blocks as keyboard-navigable lists (a follow-on once the list-view model lands).

#### Dependencies / Prerequisites {#dependencies}

All built in the predecessor plan and assumed present (the "Givens"):
- `FocusManager` + `useFocusable` registry; `setKeyView`/`refreshKeyViewProjection`/`keyView`/`focusKeyView`.
- Authored Tab walk: `focusNext`/`focusPrevious`/`walkOrder`, driven by the window-capture Tab listener in `responder-chain-provider`.
- Scope stack: `pushFocusMode`/`popFocusMode` (with `trapped` + `restoreKeyView`), `focusFirstInMode`, `currentFocusMode`, `setDefaultAction`/`resolveDefaultAction`.
- Keybinding registry ([P11] of the predecessor); keyboard-access mode; ring-modality (`setRingFollowsPointer`); focus-ring primitive on `[data-key-view-kbd]`; selection recolored to accent ([P06] of predecessor).
- `keyViewConsumesTab()` (the seed the key-capture set generalizes).

#### Constraints {#constraints}

- tuglaws hold (esp. L06: the ring/cursor/`key-within` are appearance — DOM attributes, never React state; L02 for any store-backed state; L24 zone discipline).
- Warnings are errors; no fake-DOM/RTL or mock-store tests; real keyboard behavior via `just app-test`.
- No plan-step numbers in code/comments/commits.

#### Assumptions {#assumptions}

- The engine's key view is **logical/projected** (not DOM-focus-bound) — required for the inline-dialog modal scope ([P06]: the dialog is the key view while the deactivated prompt holds no DOM focus); already true.
- The scope stack already models trapped vs non-trapped — descend/ascend just drives it; confirmed against `pushFocusMode`/`popFocusMode`.
- The prompt-entry Enter-vs-Shift+Enter submit preference is readable as a shared setting to apply library-wide to multi-line editors ([P04]).

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Cite decisions `[P01]`–`[P0n]`, specs `S01`, the matrix as `[Keyboard Behavior Matrix](#keyboard-matrix)`, and step anchors `#step-n`. Never cite line numbers. Global laws are `[Lnn]`/`[Dnn]` (referenced, not owned here).

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Movement-cursor token vs. mouse-hover token (OPEN) {#q01-cursor-token}

**Question:** Is the keyboard movement cursor the *literal* mouse-hover token (one treatment, two triggers) or a sibling token tuned to read at rest?

**Why it matters:** "Same as mouse hover" was the decision ([P03]); but a hover look tuned for transient pointer presence may read too faintly as a persistent keyboard cursor.

**Plan to resolve:** Spike in [#step-1] against the real components; default to reusing the hover token and only fork if it reads poorly. **Lean:** reuse hover; revisit per component if weak.

#### [Q02] `data-key-within` depth cap (RESOLVED) {#q02-within-depth}

**Resolution:** Render only the **immediate** container of the key view (depth 1), per the model decision. No ancestor chain rendering.

### Risks and Mitigations {#risks}

- **R01 — Redo regresses a shipped consumer.** Components built under the old conception have live consumers (pickers, the dev card, permission editors). *Mitigation:* each redo step runs the relevant consumer app-tests as regression; gate behavior behind the component's declaration so untamed callers are byte-unchanged until adopted.
- **R02 — Editor key capture starves navigation (or vice versa).** *Mitigation:* [P04]'s rule keeps Tab/Escape as navigation at rest; app-test "can always Tab/Escape out of an editor."
- **R03 — Descend/ascend confuses with act/cancel.** *Mitigation:* the five-key split is fixed in [P01]; an app-test exercises a nested accordion (Enter descends, Escape ascends) explicitly.
- **R04 — Two focus systems during the redo.** Sheets/menus are still Radix-trapped until their step lands. *Mitigation:* per-surface steps; don't register a surface's contents into the engine before that surface's scope is engine-owned.

### Design Decisions {#design-decisions}

#### [P01] The keyboard model — Focus / Move / Act over scopes (DECIDED; GOVERNING) {#p01-model}

**Decision.** Five keys, any depth:

| Key | Tier | Meaning |
|---|---|---|
| `Tab` / `⇧Tab` | focus | move the ring between components **at the current scope level** |
| arrows · `Home` · `End` · `PgUp/Dn` · `Opt`+arrows | move | move the cursor **within** the focused component (its primary axis) |
| `Space` | act — select | select / toggle the current item — never changes level |
| `Enter` (Return **and** numpad — identical, no distinction) | act — activate / descend | act; if the current item is a container **with navigable content**, **descend** (push a scope); else a plain act |
| `Escape` | ascend / cancel | pop one scope level (ascend); at a modal scope, cancel it |

Rules: *Live* components (slider, tab bar) commit as you move; *deferred* components (radio, choice, option, list, accordion) move a hover cursor and commit on Space/Enter. Descend is always Enter, never automatic. Tab-into lands the cursor on the component's **selected** item. Space/Enter have split code paths but one mapped "act" for now.

**Rationale.** One rule beats per-component web conventions; every component answers only *move / act / container?*. Separating move from act frees Enter to mean *descend*, which is what makes arbitrary nesting work.

#### [P02] Containers are scopes; descend = push, ascend = pop (DECIDED) {#p02-scopes}

**Decision.** A container is a pushed focus scope on the existing stack. **Enter** descends (push, via `pushFocusMode`); **Escape** ascends (pop, via `popFocusMode`, restoring the parent's key view). `trapped` per container: non-trapped (accordion content, inline dialogs — Escape ascends, Tab can exit) vs trapped (sheets, alerts — Escape cancels, Tab contained). Two container flavors: **item containers** (arrows move items; one is the cursor) and **component containers** (Tab cycles child components; arrows unused; Enter/Escape do depth).

**Rationale.** The scope stack already exists and already restores the key view on pop; descend/ascend is keystroke wiring onto it, not new machinery. Ascend unifies with cancel.

#### [P03] Three visual states; ring on the component, hover for the cursor (DECIDED) {#p03-visuals}

**Decision.** **key view** = the active component, wearing the focus ring ([predecessor P05] token) — the ring marks the *component* and **never** moves onto a sub-item. **`data-key-within`** = the immediate container (depth 1 only), a quiet "contains active" mark (the engine's visible `:focus-within`). **movement cursor** = the current item inside a deferred component, the **mouse-hover** treatment — distinct from the ring and from **selected** (committed `data-selected`, accent). Naming: **key view** / **`data-key-within`** / **key path** (the root→leaf chain; only key view + immediate within render).

#### [P04] Text editors are key-capture leaves (DECIDED; from predecessor [Q04]) {#p04-text-editing}

**Decision.** A text editor is a `none`-container **leaf** (focus it, never descend) that declares a **key-capture set** — the generalization of `consumesTab`. While it is the key view, captured keys are editing; uncaptured keys fall through to the engine as navigation:

| Key | In the editor | Falls through? |
|---|---|---|
| printables, `Space` | type (Space is not "select" here) | no — captured |
| ←→↑↓, Home/End, Opt/⌘+arrows | caret/word/line — **always caret, never escape-at-boundary** | no — captured |
| `Enter` | single-line = submit; **multi-line = the prompt-entry Enter-vs-Shift+Enter preference, library-wide** | editor policy |
| `Tab`/`⇧Tab` | — | **yes → leave**, unless a completion is open → Tab accepts (transient) |
| `Escape` | — | **yes → ascend/blur**, unless a completion is open → close it first; next Escape ascends |

**[P04] inline-dialog interplay — superseded by [P06].** An earlier conception had the prompt keep the caret while a pending dialog borrowed only commit keys + *distinct accelerators* (`1`–`9` / `←`·`→`), with plain arrows staying caret. That accelerator-overlay split is **dropped** — it is wrong for a graphical surface. The settled model is [P06]: while an inline dialog is visible the prompt is **deactivated** and the dialog is **modal for keys** (plain arrows move its selection, Return activates, Escape cancels). There is no key-split to manage in the editor.

#### [P05] Inherited substrate decisions (DECIDED elsewhere) {#p05-inherited}

The predecessor plan's [P01]–[P04] (FocusManager, authored order, CFRunLoop scopes, app-intercepted Tab), [P07]–[P11] (default-action, modes, interactive-only a11y, `refuse` split, keybinding registry), and [P13] (inline dialogs as scopes) **stand** and are dependencies of this plan, not re-decided here. The predecessor [P05]/[P06]/[P12] are superseded/extended/refined by [P01]–[P03] above. The predecessor's CFRunLoop scope notion — `pushFocusMode`/`popFocusMode` ([predecessor P03]) carrying a scope-declared `DEFAULT_ACTION`/`CANCEL_ACTION` ([predecessor P12]) — is the substrate [P06] builds the inline dialogs on.

#### [P06] Inline dialogs are modal-for-keys scopes; the prompt deactivates (DECIDED; GOVERNING for #step-14; corrects the [P04] interplay) {#p06-inline-dialog-modal}

**Decision.** A pending inline Permission/Question dialog pushes a CFRunLoop-style event-handling scope ([predecessor P03] modes + [predecessor P12] scope `DEFAULT_ACTION`/`CANCEL_ACTION` + [predecessor P13] inline-dialog scope) and is **modal for keys** until dismissed:

- The **prompt entry genuinely deactivates** while a dialog is visible — the editor is made non-editable / blurred, with **no blinking caret**. This is *real* deactivation driven off the pending-dialog state (`pendingApproval`/`pendingQuestion`), **never a cosmetic caret hack** ([L06] appearance follows real state, not a paint-over).
- The dialog **takes the key view as an item-container** (its choices are the items): **plain arrows move the selection**, **Return activates the highlight** (Allow / Deny / Next / Submit), **Escape cancels** (`session.n()`). This is the existing move/act machinery from [#step-1]/[#step-2] — **no number keys, no accelerator overlay**.
- On resolve the scope **pops** and the prompt **reactivates** and resumes input.

Per-dialog item sets: **Permission** = the allow-scope options plus Deny/Allow (default highlight = Allow); **Question** = the current question's options plus Back/Next/Submit. DOM focus leaves the deactivated prompt; the document-capture act-dispatch routes nav/commit keys to the dialog's key view, and the dialog's scope declares the default/cancel actions that wrap the existing `respondApproval`/`respondQuestion`/`n` paths.

**Rationale.** A proper graphical modal: the keyboard drives the *visible* dialog and the suspended prompt *visibly* deactivates — recovering the predecessor's CFRunLoop scope notion that was never built, and **dropping the accelerator-overlay scheme** ([P04]'s `1`–`9` / `←`·`→` with plain arrows staying caret) as wrong for a GUI. Modal-for-keys also removes the editor key-split entirely: there is nothing to "fall through" because the prompt is off.

### Specification {#specification}

#### Keyboard Behavior Matrix {#keyboard-matrix}

**S01.** Each component's declaration against [P01]. **Container?** = item / component / none. **Move** = arrows · Home/End · Pg · Opt. **Act** = Space / Enter. **Commit** = live / deferred.

| Component | Container? | Move | Act (Space / Enter) | Commit |
|---|---|---|---|---|
| internal/tug-button · TugPushButton | none | — | press / activate | — |
| TugCheckbox | none | — | toggle checked | — |
| TugSwitch | none | — | toggle on/off | — |
| TugSlider | none | move value; Home/End = min/max; Pg/Opt = larger step | — *(no act; commits live)* | **live** |
| TugTabBar | item | move cursor over tabs; Home/End | *(tab already switched)* | **live** — switches as you move ([P08]) |
| TugRadioGroup | item | move hover over radios; Home/End | check current radio | deferred |
| TugChoiceGroup | item | move hover over segments | select current segment | deferred |
| TugOptionGroup | item | move hover over options | toggle current option | deferred |
| TugAccordion | item **+ descend** | move hover over headers; Home/End | Space toggles expand; **Enter expands + descends** | deferred |
| TugListView | item **+ descend** | move hover over rows; Pg/Home/End; scrolls into view | Space selects row; **Enter descends** into row (else activates) | deferred |
| TugContextMenu · internal/tug-popup-menu | item *(trapped scope)* | move hover over items; Home/End | activate item; Escape closes | deferred |
| TugInput · editor | none *(key-capture leaf, [P04])* | arrows = caret (always); printables + Space type; `consumesTab` while completing | Enter = submit (single) / prompt-pref (multi); Tab/Escape navigate at rest | live (caret) |
| TugTooltip | none *(passive)* | — *(not a focus stop; opens on trigger focus)* | — | — |
| TugPopover | component *(scope)* | — *(Tab cycles inner)* | inner act; Enter = scope default; Escape ascends/closes | per inner |
| TugSheet | component *(trapped scope)* | — *(Tab contained)* | inner act; Enter = default; Escape cancels | per inner |
| TugAlert | component *(trapped scope)* | — *(Tab contained)* | inner act; Enter = default; Escape cancels | per inner |
| TugPermissionDialog · TugQuestionDialog | item *(modal-for-keys scope; prompt deactivates while visible, [P06])* | arrows move the selection over the dialog's items (options + Deny/Allow · Back/Next/Submit); Home/End | Enter activates the highlight (Allow/Deny/Next/Submit); Escape = cancel (`n`) | deferred |

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism |
|---|---|---|
| key view (active component id) | structure/appearance | FocusManager + `data-key-view`/`-kbd` (exists; DOM via manager, [L06]/[L22]) |
| `data-key-within` (immediate container) | appearance | DOM attribute projected by the manager from the scope stack ([L06]) |
| movement cursor (current item per component) | appearance ([L06]/[L22]) | **ref-owned, projected directly to the hover DOM attribute** — same shape as the manager's key-view projection (`refreshKeyViewProjection`: mutate DOM, notify no subscriber). **Not React render state** — moving the cursor must not re-render to change appearance ([L06]). The committed *selection* it may land on is the separate per-component row below. |
| scope stack (descend/ascend) | structure | FocusManager `pushFocusMode`/`popFocusMode` (exists) |
| per-component key-capture set | config / live | predicate held by ref ([L07]); generalizes `keyViewConsumesTab` |
| committed selection (selected/checked/value) | per component (often [L23]/[A9] preserved) | unchanged from each component's existing model |

### Documentation Plan {#documentation-plan}

- This plan + the matrix are the reference. Add a short "Keyboard model" section to `tuglaws/` (component-authoring) once [#step-2] lands, describing the move/act declaration a new component makes. No one-off `docs/*.md`.

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

- **Real-app keyboard behavior** (`just app-test`): per-component matrix scenarios (Tab is one stop; arrows move the cursor with the hover visual; Space selects vs Enter acts/descends; Escape ascends; ring stays on the component). Nesting scenario (accordion descend/ascend). Editor scenarios (caret + always-Tab/Escape-out; prompt+dialog split).
- **Pure logic** (`bun:test`): the act-dispatch resolver (key → select/act/descend/ascend given a component's declaration), the key-capture-set predicate, walk/scope math.
- **Regression**: each redo runs its shipped consumers' app-tests.

#### What stays out of tests {#test-non-goals}

- No fake-DOM/RTL render tests; no mock-store assertion tests. Visual-weight of the hover/within marks is reviewed by eye in the gallery, not asserted pixel-wise.

### Execution Steps {#execution-steps}

#### Implementation Batches {#implementation-batches}

Each batch is one `/tugplug:implement` run — a dependency-clean cut whose steps all rest on earlier batches. Walk them in order; never start a batch whose steps' `Depends on:` are not yet `done`.

| Batch | Steps | Theme | Rests on |
|---|---|---|---|
| **A — Engine + editors** | [#step-1]–[#step-3] | The model's machinery: movement cursor + the three visual states, the Space/Enter/Escape act dispatch + key-capture set, then text editors as capture leaves. Nothing else can be redone until this lands. | substrate (the [#dependencies] Givens) |
| **B — Component redos** | [#step-4]–[#step-7] | Declare the model on the components built under the old conception: deferred groups (radio/choice/option), live (tab bar/slider), accordion, list view. All four rest only on the [#step-2] dispatch. | Batch A |
| **C — Surfaces** | [#step-8]–[#step-14] | The not-yet-built floating/trap surfaces and inline dialogs: tooltip, popover, context menu (+ editor menu), popup-menu, sheet, alert, Permission/Question dialogs. (Internal order: [#step-11] rests on [#step-10]; [#step-13] on [#step-12]; [#step-14] on [#step-3].) | Batch A |
| **D — Audit (deferred)** | [#step-15] | `refuse` / first-responder reclassification against the model. Deferred. | Batches B + C |

Batches are **run** boundaries, not commit boundaries — each step still commits individually on the dash. A long batch may be split across conversations; the ledger is the resume point either way.

**Batch C is split into four sub-runs.** C's surfaces are the worst case for verification in an unattended session — every step's checkpoint is a portal / focus-trap / Escape behavior (`just app-test … VERDICT: PASS`) that can't be observed by a synthetic-key probe the way leaf controls can, so the real verification loop is a hands-on pass over a live `just app-debug` build between sub-runs. Steps 9 / 10 / 12 / 13 are each a Radix `FocusScope` → engine-scope migration (R04: two focus systems coexisting), so the discipline is: land one scope-flavor, confirm it on the live build, then reuse the established pattern for its siblings. Each sub-run is one `/tugplug:implement` invocation on the same dash; the internal `Depends on:` deps (11→10, 13→12, 14→3) already cluster the steps by scope flavor:

| Sub-run | Steps | Scope flavor | Cohesion |
|---|---|---|---|
| **C1** | [#step-8]–[#step-9] | non-trapped floating | Tooltip is trivial (confirm it never takes the key view); Popover is the **first** Radix→engine component-scope migration — establishes the pattern the later sub-runs reuse. |
| **C2** | [#step-10]–[#step-11] | trapped menu scope | **Resolved as no-op:** the menus are already keyboard-complete (Radix native for context + popup; the editor menu owns its own keys as a refuse-focus overlay). A trial engine scope added only cosmetics and broke the editor's text selection, so it was abandoned — see [#step-10]/[#step-11]. |
| **C3** | [#step-12]–[#step-13] | modal trapped scope | **Resolved additive / no-op:** both surfaces keep Radix for DOM-focus plumbing. TugSheet already runs the engine trap (logical key view / ring / Tab walk) *alongside* Radix's auto-focus + restore — that split is the intended resting state, not a way station ([#step-12]). TugAlert is app-modal *through* Radix (overlay block, document-global trap, Enter-to-confirm, restore) and gains nothing from an engine scope — audited no-op like [#step-10]/[#step-11] ([#step-13]). The full Radix→engine removal would relocate initial-DOM-focus + restore-on-close into the engine for zero UX gain and real regression risk on the text-focus paths; deferred, not adopted. |
| **C4** | [#step-14] | inline-dialog modal scope ([P06]) | A pending dialog pushes a CFRunLoop-style modal-for-keys scope and the prompt deactivates; arrows move the dialog selection, Return activates, Escape cancels (no accelerator overlay). Rests on [#step-3] (done) + the predecessor's scope substrate. Stands alone. |

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Engine: movement cursor + the three visual states (ring / `data-key-within` / hover) | done | d51a2227 |
| #step-2 | Engine: act dispatch (Space/Enter/Escape → select/act/descend/ascend) + live-vs-deferred + per-component key-capture set | done | cdf721ea |
| #step-3 | Text editors: key-capture set ([P04]) — TugInput, prompt, code/markdown editors | done | c59c1a79 |
| #step-4 | Redo deferred item-groups — TugRadioGroup, TugChoiceGroup, TugOptionGroup | done | 5cd45d3a |
| #step-5 | Redo live components — TugTabBar (switch-live), TugSlider review | done | 38705e98 |
| #step-6 | Redo TugAccordion — item container + Enter-descend | done | 6e629ef7 |
| #step-7 | Redo TugListView — listbox: hover rows, Space selects, Enter descends/activates | done | 557b8638 |
| #step-8 | Tame TugTooltip — focus-trigger only, no capture | done | b931481e |
| #step-9 | Tame TugPopover — Radix FocusScope → engine component-scope | done | b931481e |
| #step-10 | Tame TugContextMenu (+ editor context menu) — item-in-trapped-scope | done (no change) | — |
| #step-11 | Tame internal/tug-popup-menu | done (no change) | — |
| #step-12 | Tame TugSheet — modal scope + restore | done (additive) | — |
| #step-13 | Tame TugAlert — modal scope | done (no change) | — |
| #step-14 | Inline dialogs (Permission/Question) — modal-for-keys scope ([P06]) | done | 5ca6f4b3 |
| #step-15 | Audit: `refuse` / first-responder reclassification against [P01] | deferred | — |

#### Step 1: Engine — movement cursor + the three visual states {#step-1}

**Commit:** `focus(engine): movement cursor + ring / key-within / hover visuals`

**References:** [P01], [P03], [Q01], [#state-zone-mapping]

**Depends on:** — (substrate exists)

**Tasks:**
- Add the **movement-cursor** concept: a shared hook (`useFocusItems` / extend `useFocusable`) by which an item-container declares its ordered items and current cursor. Hold the cursor **ref-owned** and **project it directly to a DOM attribute** styled with the **mouse-hover** treatment — mirror the manager's key-view projection (mutate DOM, notify no React subscriber). **The cursor is appearance, not render state**: moving it must not trigger a re-render to change the visual ([L06]/[L22]).
- Project **`data-key-within`** onto the immediate container of the key view (depth 1) from the scope stack; author its quiet "contains active" CSS.
- Confirm the ring stays on the component only; remove any residual ring-on-sub-item CSS hooks from the predecessor steps.
- Resolve [Q01] (reuse the hover token unless it reads weak).

**Tests:**
- app-test: a throwaway gallery item-group shows the ring on the component, the hover cursor on the current item, and `data-key-within` on the container — three distinct treatments.

**Checkpoint:** `just app-test` visual-state scenario `VERDICT: PASS`; `bunx tsc --noEmit` clean.

#### Step 2: Engine — act dispatch + key-capture set {#step-2}

**Commit:** `focus(engine): Space/Enter/Escape act dispatch + key-capture set`

**References:** [P01], [P02], [P04], [#state-zone-mapping]

**Depends on:** #step-1

**Tasks:**
- Add the **act dispatch**: a window/scope-level handler resolving `Space`→select, `Enter`→act-or-**descend** (`pushFocusMode` when the current item is a navigable container), `Escape`→**ascend** (`popFocusMode`) / cancel-at-modal — routed by the focused component's declaration. Split Space/Enter code paths, mapped to one "act" for now.
- **Precedence and default-suppression (get this right in the first handler):** site the act dispatch alongside the existing pipeline in `responder-chain-provider` — it runs **after** the capture-phase keybinding listener (a matched global/scope binding wins and the dispatch never sees the key) and **after** a key-capture leaf has consumed the key (editors keep their keys), but **ahead of** native element behavior for the focused component. It must `preventDefault` on `Space` and `PgUp/PgDn` when the key view is a `tabIndex=0` container (otherwise the browser page-scrolls). **Escape coexistence during the redo (R04):** Radix surfaces still own Escape-to-close until their step lands — the engine's Escape=ascend must only fire when the current scope is engine-owned, so it does not double-fire against a still-Radix-trapped surface.
- Add **live-vs-deferred** routing (live components commit on move; deferred on act).
- Add the per-component **key-capture set** (generalize `keyViewConsumesTab`): a predicate the key view declares; captured keys go to the component, the rest to the engine.
- Confirm leaf act consistency: `Space` **and** `Enter` both act on TugButton/Checkbox/Switch.

**Tests:**
- pure-logic: the dispatch resolver (key + declaration → select/act/descend/ascend) and the capture-set predicate.
- app-test: nested gallery container — Enter descends, inner act works, Escape ascends.

**Checkpoint:** `bun test` resolver suite green; `just app-test` descend/ascend scenario `VERDICT: PASS`.

#### Step 3: Text editors — key-capture set {#step-3}

**Commit:** `focus(text): editors are key-capture leaves ([P04])`

**References:** [P04], #step-2

**Depends on:** #step-2

**Tasks:**
- Declare the editor key-capture set on `TugInput`, the prompt editor, and the code/markdown editors: printables + Space + arrows (caret) + completing-`consumesTab` captured; Tab/Escape navigation at rest.
- Wire multi-line `Enter` to the shared prompt-entry Enter-vs-Shift+Enter preference (library-wide); single-line `Enter` = submit.
- **Editor side of the [P04] coexistence split only:** define the prompt editor's fall-through contract so typing/caret stay captured while commit keys (Enter/Escape) and option accelerators fall through to a pending dialog's scope. The dialog-side wiring (default/cancel action, `1`–`9`/`←`·`→` accelerators, the routing that makes the two coexist) is owned by [#step-14] — do not build it here.

**Tests:**
- app-test: focused editor — typing works, arrows are caret, `Tab` leaves, `Escape` blurs; with a completion open, `Tab` accepts and `Escape` closes (then next `Escape` ascends).
- app-test: prompt + pending inline dialog — typing stays in the prompt, `Enter` answers the dialog, `Escape` cancels it.

**Checkpoint:** `just app-test` editor + coexistence scenarios `VERDICT: PASS`.

#### Step 4: Redo deferred item-groups {#step-4}

**Commit:** `focus(groups): radio/choice/option — arrows move hover, Space/Enter act`

**References:** [P01], [P03], #step-1, #step-2

**Depends on:** #step-2

**Tasks:**
- TugRadioGroup, TugChoiceGroup, TugOptionGroup: register as one item-container stop; arrows move the **hover cursor** (not selection); Space/Enter act (check / select / toggle); ring stays on the group; Tab-into lands on the selected item.
- Remove the old roving-ring-onto-member behavior and arrow-selects coupling.

**Tests:**
- app-test per group: Tab = one stop; arrows move the hover; Space/Enter commits; ring on the group throughout.
- regression: at0030 component-state-preservation + each group's consumers.

**Checkpoint:** `just app-test` group scenarios + regressions `VERDICT: PASS`.

#### Step 5: Redo live components {#step-5}

**Commit:** `focus(live): TugTabBar switch-live; TugSlider review`

**References:** [P01], [P03], #step-2

**Depends on:** #step-2

**Tasks:**
- TugTabBar: arrows move the cursor **and switch live** (commit on move); ring on the bar, never on a tab.
- TugSlider: confirm arrows move the value live; ring on the slider component; no act.

**Tests:**
- app-test: tab bar arrows switch the active view live; slider arrows change the value; ring stays on the component.
- regression: tab-bar + slider consumers.

**Checkpoint:** `just app-test` live scenarios `VERDICT: PASS`.

#### Step 6: Redo TugAccordion {#step-6}

**Commit:** `focus(accordion): item container + Enter-descend into content`

**References:** [P01], [P02], #step-2

**Depends on:** #step-2

**Tasks:**
- Arrows move the hover cursor over headers; Space toggles expand; **Enter expands + descends** into the section content (push a non-trapped scope) when it has navigable components; Escape ascends.
- Ring on the accordion; the descended content gets the key view; the accordion gets `data-key-within`.

**Tests:**
- app-test: arrows over headers; Enter expands + descends; operate an inner control; Escape ascends to the headers.

**Checkpoint:** `just app-test` accordion descend/ascend `VERDICT: PASS`.

#### Step 7: Redo TugListView {#step-7}

**Commit:** `focus(list): listbox — hover rows, Space selects, Enter descends`

**References:** [P01], [P02], [P03], #step-2

**Depends on:** #step-2

**Tasks:**
- One item-container stop; arrows / Pg / Home/End move the **hover cursor** over rows, scrolling into view; Space selects the row (`data-selected`); **Enter descends** into row content when present, else activates; ring on the list.
- Replace the dumb-passthrough scroll-only model from the predecessor with this listbox model.

**Tests:**
- app-test: Tab = one stop; arrows move the hover row + scroll; Space selects; Enter descends/activates; ring on the list.
- regression: dev-card recent picker, transcript, a read-only sheet.

**Checkpoint:** `just app-test` list-view scenarios + regressions `VERDICT: PASS`.

#### Step 8: Tame TugTooltip {#step-8}

**Commit:** `focus(tooltip): trigger-focus only, no capture`

**References:** [P01], #step-1

**Depends on:** #step-1

**Tasks:** Confirm the tooltip never takes the key view; it opens on the trigger's focus; the trigger keeps the ring.

**Tests:** app-test: focusing a tooltip trigger shows the tooltip + the trigger's ring; key view stays on the trigger.

**Checkpoint:** `just app-test` tooltip scenario `VERDICT: PASS`.

#### Step 9: Tame TugPopover {#step-9}

**Commit:** `focus(popover): Radix FocusScope → engine component-scope`

**References:** [P01], [P02], #step-2

**Depends on:** #step-2

**Tasks:** Replace Radix `FocusScope` with a pushed component-scope; Tab cycles inner components; Enter = scope default-action; Escape ascends/closes and restores the opener's key view.

**Tests:** app-test: Tab cycles within the open popover; Escape restores the opener's key view.

**Checkpoint:** `just app-test` popover scenario `VERDICT: PASS`.

#### Step 10: Tame TugContextMenu (+ editor context menu) {#step-10}

**Commit:** `focus(menu): TugContextMenu engine scope + item cursor`

**References:** [P01], [P02], #step-2

**Depends on:** #step-2

**RESOLVED — no change needed.** The menus are already keyboard-complete and need no engine scope. `TugContextMenu` is a Radix context menu: arrows / Home·End / Enter / Escape, the focus trap, and restore-to-trigger are all native. `tug-editor-context-menu` is a hand-built **focus-refusing overlay** (`data-tug-focus="refuse"`) with its own window-capture keydown (arrows / typeahead / Enter / Escape) that deliberately leaves DOM focus *and the editor's live text selection* in place so Cut / Copy operate on the right-clicked selection. An engine `useFocusTrap` scope buys only a cosmetic `data-key-within` mark plus a `data-focus-mode` projection that is redundant with Radix's own focus management — and on the editor menu it actively breaks the selection. A trial migration (since abandoned) confirmed both: zero functional gain on the Radix menu, regression on the editor menu. The editor menu's classification as a refuse-focus leaf is recorded for [#step-15]; nothing here changes the menus.

**Tasks:** *(none — menus unchanged.)*

**Checkpoint:** menu files unchanged; right-click → Copy still operates on the live selection.

#### Step 11: Tame internal/tug-popup-menu {#step-11}

**Commit:** `focus(menu): internal/tug-popup-menu engine scope`

**References:** [P01], [P02], #step-2

**Depends on:** #step-10

**RESOLVED — no change needed.** `internal/tug-popup-menu` is a Radix dropdown menu: arrows / Home·End / Enter / typeahead / Escape, the focus trap, and restore-to-trigger are all native (same reasoning as [#step-10]). No engine scope added.

**Tasks:** *(none — menu unchanged.)*

**Checkpoint:** menu file unchanged.

#### Step 12: Tame TugSheet {#step-12}

**Commit:** `focus(sheet): engine modal scope + restore`

**References:** [P01], [P02], #step-2

**Depends on:** #step-2

**RESOLVED — additive, Radix retained.** The sheet already runs the engine trap (`useFocusTrap({ active: open })` + `FocusModeScope`) for the logical key view, ring, and Tab walk over registered focusables, *alongside* a Radix `FocusScope` (`trapped={false}`) that owns the DOM-focus plumbing: auto-focus the first tabbable on open, restore DOM focus to the opener on close, and `loop`-contain Tab. That split is the **intended resting state**, not a way station. The sheet's *modality* is already engine/DOM-native (`inert` on `.tug-pane-body`), never Radix. Fully removing Radix would relocate two behaviors the engine does not do on the sheet's close path today — initial DOM focus on open, and DOM-focus restore on the non-`ascend` close path (the sheet closes via `cancelDialog`, which pops the mode and restores only the *logical* key view) — plus accept a Tab-leak for input-bearing sheets (`TugInput` is a key-capture leaf, not an engine focusable). Net-new engine surface with real regression risk on the text-focus paths (`at0051`, editor refocus via `sheetDidHide`) for zero UX gain; not adopted. The only change here is making the in-code docstring honest about the deliberate division of labor.

**Tasks:** *(none — sheet behavior unchanged; trap docstring corrected to describe the additive split as the resting state.)*

**Checkpoint:** `bunx tsc --noEmit` clean; no behavior change to verify (the engine trap + Radix DOM-focus split is unchanged).

#### Step 13: Tame TugAlert {#step-13}

**Commit:** `focus(alert): engine modal scope`

**References:** [P01], [P02], #step-12

**Depends on:** #step-12

**RESOLVED — no change needed.** TugAlert is app-modal *through* Radix `AlertDialog`: the overlay physically blocks outside clicks, Radix owns the document-global focus trap, initial focus on the action button, Enter-to-confirm, and Escape-to-cancel via DismissableLayer, with focus restored to the opener on close. The keyboard model governs moving the ring between/within components at a scope; a two-button alert gains nothing from an engine scope, and removing Radix would mean re-implementing correct app-modal behavior for zero UX benefit. Opening an alert already does not strand the ring (app-modal + restore-on-close). Audited as Radix-native-is-correct, exactly like [#step-10]/[#step-11]. The alert's classification stands for the [#step-15] `refuse`/first-responder audit; nothing here changes the alert.

**Tasks:** *(none — alert unchanged.)*

**Checkpoint:** alert files unchanged; app-modal confirm/cancel + Escape/Enter still behave per Radix.

#### Step 14: Inline dialogs (Permission/Question) {#step-14}

**Commit:** `focus(dialog): inline dialogs — modal-for-keys scope, prompt deactivates`

**References:** [P06], [P02], #step-3, [predecessor P03]/[P12]/[P13] (CFRunLoop scope + scope default/cancel-action + inline-dialog scope)

**Depends on:** #step-3

**STATUS — done (both dialogs landed; the focus-language generalization spun out to [#focus-language-modernization]).** What landed and verified hands-on: the prompt entry genuinely deactivates while a dialog is pending (read-only + blurred, no caret), and **both PermissionDialog and QuestionDialog** are working modal-for-keys scopes — arrows move the cursor over the dialog's items (Permission: `[Deny, Allow, scope options…]`; Question: per-question options + Back/Next/Submit), Return activates the highlight, Escape/Cmd-. cancel (Deny / `session.n()`), and the prompt re-focuses on resolve. The visual language settled on something better than the orange ring: the keyboard cursor **promotes** the focused action button to its **filled, role-coloured** style + a role-coloured outline and **demotes** the others to outlined (the default-button emphasis follows the cursor); option rows recolour their **own border** to the focus colour. That visual treatment — currently bespoke, dialog-scoped CSS in `dev-permission-dialog.css` / `dev-question-dialog.css` reacting to `[data-key-cursor]` — is the prototype for the engine-wide **[#focus-language-modernization]** below: lifting the "keyboard-promoted" state into TugPushButton as a first-class capability and reconsidering the whole focus-indicator language (filled-promotion + double-border vs. the orange `[data-key-view-kbd]`/`[data-key-cursor]` rings). Both dialogs are joined to `main`.

**Tasks:** Realize [P06] — a pending Permission/Question dialog is a CFRunLoop-style **modal-for-keys** scope:
- **Push a scope** while the dialog is pending and **pop it** on resolve (`useLayoutEffect`, in lockstep with the session's pending state). Register the dialog's choices as an **item-container key view**, seeding the cursor on the default highlight (Allow / first option) so arrows move the selection, Return activates the highlight, Escape cancels.
- Declare the scope's **default-action** (Return → activate the highlighted choice: Allow / Deny / Next / Submit) and **cancel-action** (Escape → `session.n()`) — wrapping the existing `respondApproval` / `respondQuestion` / `n` paths, not reinventing them. **No number keys / accelerator overlay.**
- **Genuinely deactivate the prompt entry** while a dialog is visible — make the editor non-editable / blurred with **no blinking caret**, driven off `pendingApproval`/`pendingQuestion` ([L06] — real deactivation, not a caret paint-over). Reactivate on resolve.
- **Remove the Allow focus-steal** (`allowRef.focus()` in `dev-permission-dialog`) — the engine scope owns the keys; DOM focus does not need to sit on a button.
- Per dialog: Permission's items = allow-scope options + Deny/Allow; Question's items = the current question's options + Back/Next/Submit.

**Tests:** app-test: with a dialog visible — the prompt is deactivated (no caret, not editable); **arrows move the dialog selection, Return activates the highlight, Escape cancels**; on dismiss the prompt reactivates and resumes typing. Permission: arrow to Deny + Return denies; Return on Allow allows. (Verified hands-on on a live `just app-debug` build — the modal/scope behavior is not a synthetic-key probe target.)

**Checkpoint:** `just app-test` inline-dialog scenario `VERDICT: PASS`; hands-on confirmation on the live build that the prompt deactivates and the dialog is keyboard-modal.

#### Step 15: Audit — `refuse` / first-responder reclassification {#step-15}

**Commit:** `focus(audit): reclassify refuse / first-responder against the model`

**References:** [P01], [P05]

**Depends on:** #step-7, #step-14

**DEFERRED.** The component redos and surfaces are all landed; this cleanup audit is real but not blocking, and is deferred while the focus-language modernization ([#focus-language-modernization]) takes priority. Pick it up once the modernization rollout settles, since reclassifying `refuse` sites is cleaner against a finalized focus-indicator language.

**Tasks:** Walk every `data-tug-focus="refuse"` and first-responder site; reclassify against the model (component focus stop vs item vs leaf); remove now-redundant `refuse` hacks the engine supersedes.

**Tests:** app-test: a representative sweep that no control is unreachable and no click steals the key view incorrectly.

**Checkpoint:** `just app-test` audit sweep `VERDICT: PASS`.

### Deliverables and Checkpoints {#deliverables}

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- Every matrix row is implemented and app-tested.
- The engine carries exactly one new model: components declare *move / act / container?* + a key-capture set; behavior follows from the declaration.
- The ring is on components only; the hover cursor and `data-key-within` render per [P03]; Space/Enter/Escape behave per [P01] including nesting.
- Editors capture typing while Tab/Escape always leave at rest; the prompt+dialog split works.
- `tsc`/`bun test`/`just app-test` all green.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- Nested in-transcript body-kind blocks as keyboard-navigable lists.
- OS-signal auto-engage of accessibility mode.
- The accessibility-mode ARIA pass + standard/accessibility dual-mode toggle (was an in-plan step; now a follow-on).
- An end-to-end composed-surface integration checkpoint (was an in-plan step; now a follow-on).
- Splitting Space vs Enter into distinct ops if experience shows it's needed (the code paths are already separate).

---

### Focus-Language Modernization {#focus-language-modernization}

The successor effort that grows out of [#step-14]: replace the engine's focus-visual
**language** — today the orange ring — generalized across the component library.

**STATUS — SPIKE COMPLETE; rolled out under its own plan.** The gallery
language-spike was built and judged by eye across the full archetype taxonomy in both
themes; the card `tugdeck/src/components/tugways/cards/gallery-focus-language.{tsx,css}`
is the settled reference canvas. The original hypothesis recorded below
([#flm-what]/[#flm-proven]: "filled-promotion + double-border, two-branch") was
**revised by the spike** — see the verdict next. The behavior work of this plan is done;
the visual-language rollout is its **own** document: **`dash/tugplan-focus-language.md`**
(authored via `/tugplug:devise`). Nothing further happens in *this* plan.

#### Spike verdict — the settled model {#flm-verdict}

The spike replaced the two-branch fill/double-border hypothesis with one simpler model:

- **One signature for keyboard focus:** the focused component wears a **ring** plus a
  **faint behind-tint**; the committed selection is the component's **native fill** (radio
  dot / segmented pill / option fill / list-row fill — decades-old conventions kept).
- **Leaf controls** (button, input, toggle, slider) *are* the focusable, so the ring
  wraps the whole component; **item-groups** put the behind-tint on the group and a ring
  on the **cursor item**, so the cursor stays visible even atop a selection fill (this is
  what makes multi-select legible without an added checkmark).
- **One role axis, default `action`.** Ring + selection-fill + behind-tint all read a
  single role variable that defaults to action (the neutral interactive blue) and is
  overridden per role; there is **no "role-less" branch** — role-less controls ride the
  default. Buttons keep the fill-promotion treatment from [#step-14].
- **Decisions surfaced for the rollout to carry:** every focusable adopts a role
  (default action); **TugInput** maps its `validation` onto the role axis (invalid →
  danger); **TugTabBar** moves to commit-on-act; brio/harmony filled-accent/danger
  intensities were retuned during the spike.
- **Governance (owned by the new plan):** a new governing `[P0x]` superseding [P03], a
  [Keyboard Behavior Matrix](#keyboard-matrix) visual-column rewrite, and a `tuglaws/`
  focus-language doc.

The subsections below are retained as the **original (now superseded) hypothesis** that
the spike tested — historical context for the new plan, not live guidance.

#### What it is {#flm-what}

Replace the orange `[data-key-view-kbd]` / `[data-key-cursor]` rings with a
**"ringed-fill" / filled-promotion + double-border** language. Crucially this is a
**re-skin over stable DOM attributes, not an engine change**: focus state is already
projected as `[data-key-view-kbd]` (focused component), `[data-key-cursor]` (cursor
item), `[data-key-within]` (immediate container), `data-selected` (committed). So
behavior + most app-tests survive — the work is CSS/tokens + a few resting-style render
tweaks. This is the de-risker: the engine, the scopes, and the app-tests (which assert
attributes/behavior, not pixels) don't move.

#### The proven treatment (shipped in the inline dialogs) {#flm-proven}

The keyboard cursor **promotes** the focused control to its **filled, role-coloured**
style + a role-coloured outline ring, and **demotes** the others to outlined (the
default-button emphasis follows focus: action→filled-blue, danger→filled-red).
Non-button choices (option rows) recolour their **own border** to the focus colour. All
via `[data-key-cursor]` in CSS — appearance-only, no re-render ([L06]).

- **Reference code (currently bespoke, dialog-scoped):** `dev-permission-dialog.css` +
  `dev-question-dialog.css` — rules like
  `.dev-*-dialog-scope .tug-button-outlined-action[data-key-cursor] { background/color/border = filled-action tokens; outline = filled-action border token }`,
  the `-danger` variant, the option-border recolour, and a `box-shadow` ring on
  `.tug-inline-dialog` for the dialog box.
- **Tokens used:** `--tug7-surface-control-primary-filled-{action,danger}-rest`,
  `--tug7-element-control-{text,border,icon}-filled-{action,danger}-rest`,
  `--tugx-focus-ring-color` / `-width`. Core focus system: `styles/focus-ring.css`.

#### Rollout targets {#flm-targets}

- **A.** Lift the treatment into **TugPushButton** as a first-class "keyboard-promoted"
  state (`internal/tug-button.css` reacting to `[data-key-cursor]`).
- **B / C.** PermissionDialog options / QuestionDialog questions (already done bespoke —
  unify onto A).
- **D.** All matrix components (radio/choice/option, tab bar, slider, accordion, list,
  menus, popover, sheet, alert, inputs).
- **Bigger than A–D.** `[data-key-view-kbd]` is a **global** rule (every focusable
  app-wide — title bars, toolbars, prompt, dev panel), so a true language change is
  app-wide, not just matrix components.

#### The central fork + risks (must settle before rolling out) {#flm-risks}

1. **"Filled" is already taken** (= primary/emphasis for mouse users). Overloading it
   for keyboard-focus either makes every primary button outlined-at-rest (mouse users
   lose the primary cue) or creates filled-at-rest vs filled-when-focused ambiguity. **No
   free answer** — this is the fork the spike must resolve by eye.
2. **Two-branch language:** *fill* for promotable leaf/role controls; *double-border
   ring* for the unfillable — text inputs can't be filled (legibility), slider
   (continuous), tiny checkbox/switch, and the component-level key-view.
3. **Role-less controls have no promotion colour** (radio row, list row, slider) → need
   a decided palette (accent? a dedicated keyboard colour?).
4. **Vocabulary collision:** five states share surfaces — hover / keyboard-cursor /
   selected / key-view / key-within. In a *deferred* group the cursor item ≠ the
   selected item simultaneously, so they must stay visually distinct.
5. **Theme × mode × contrast:** tokens are hand-authored in `brio.css` + `harmony.css`;
   filling flips text/bg contrast — verify both themes + accessibility mode.
   (Double-border is colourblind-robust — a point in favour.)
6. **Governance:** supersedes [P03] (ring-on-component / hover-for-cursor) → needs a new
   governing `[P0x]`, a [Keyboard Behavior Matrix](#keyboard-matrix) visual-column
   rewrite, and a `tuglaws/` focus-language doc. Define it as shared tokens/primitives,
   not bespoke per-component CSS (the dialogs are bespoke today — to be unified).

#### Sequence {#flm-sequence}

1. **Gallery language-spike (a spike, NOT a plan — start here).** Build the new
   treatment on ~5 representative cases in the Component Gallery — a **role button**
   (fill branch), a **text input** (double-border branch — can't fill), a **radio group**
   (cursor ≠ selected simultaneously; role-less promotion colour), a **list row**
   (role-less), and a **component-level key-view** — viewable in **both themes**
   (brio/harmony) and **keyboard vs mouse**. Judge by eye; answer the filled-overload
   fork ([#flm-risks] item 1) and the role-less colour (item 3). Cheap, reversible,
   high-information.
2. **Dedicated `/tugplug:devise` plan** for the rollout (its own plan, separate from
   this one — this plan is *behavior*, that one is the *visual language*). Defines the
   tokens + the two-branch rule (fill vs double-border) + the new governing `[P0x]`
   decision superseding [P03]; lifts the dialog-scoped CSS into a first-class
   TugPushButton "keyboard-promoted" state; steps component-by-component as a re-skin
   (A+B+C+D + the app-wide focusables), gallery-verified per theme/mode.
3. A+B+C+D + the app-wide focusables fall out of that plan.

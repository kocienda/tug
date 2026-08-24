<!-- devise-skeleton v4 -->

## Unified Assistant Defaults {#unified-assistant-defaults}

**Purpose:** Give each Dev card its own Model / Permission Mode / Effort, seeded at
creation from **user-level defaults**, where the defaults are edited through the **same
rich chips + sheets** as the Z4B toolbar (no second, lesser UI), backed by an
always-current Claude-sourced model catalog, with a card-level bulletin when a card's
explicitly-chosen model is no longer available.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Base commit | `2da312c84` (`tugdeck(assistant-defaults): always-current model catalog + per-card model scaffolding`) |
| Last updated | 2026-07-06 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Z4B Model/Mode/Effort controls used to **pollute values across all cards** — there
was no clean separation between "the default a new card starts with" and "what this
session chose." The target: a set of **user-level defaults** for new cards, plus
**per-session** overrides that never disturb other cards or the defaults.

The base commit (`2da312c84`) already landed the durable, standalone pieces of that work
(see [#starting-state]): a per-card model, and an **always-current model catalog** sourced
only from Claude's live `session_capabilities` — no hardcoded model list survives as a
maintained source of truth. It also landed the **scaffolding** for the defaults feature
(deck-default stores + deck-default reads in the seed resolvers) but deliberately **not**
a UI — an earlier prototype built bare `TugPopupButton` dropdowns in Settings that
duplicated, badly, the rich Model/Mode/Effort sheets already in the app (the dropdown
renders only a model's terse `displayName` "Fable"/"Opus" and drops the `description`
subtitle "Fable 5 · Most capable…" / "Opus 4.8 with 1M context · …" the real sheet shows).
That prototype UI was reverted before the base commit.

This plan builds the **UI and the fallback** on top of `2da312c84`: bind the **real
chips + sheets** to the deck defaults (one editor, rich labels for free), fold the
existing Permission Mode dropdown into that pattern, and add a card-level bulletin when a
concretely-chosen model is no longer offered.

#### Strategy {#strategy}

- **Reuse, don't reinvent.** The sheet bodies (`ModelPickerSheetBody`, plus the effort /
  permission equivalents) are presentation-only, and the pickers (`useModelPicker`,
  `useEffortPicker`, `usePermissionSheet`) already take a metadata store + an action
  callback + a `showSheet` host. The chips take a metadata store + an `onOpen`. We add
  **one adapter** and swap what those consumers read/write — no forked UI.
- **Bind chips + sheets to defaults via a `SessionMetadataStore`-shaped adapter** over
  the three deck-default stores + the live catalog, so the existing components render
  **unmodified** and produce rich labels for free.
- **Wire the scaffolding.** The deck-default stores + reads exist at HEAD but are not yet
  constructed by any UI; the adapter (Step 2) is what brings them to life.
- **Fold the existing Permission Mode default** into the chip pattern (replace its
  dropdown) so all three read as one system.
- **Fallback bulletin** only when a *concrete* (non-`default`) picked model is absent from
  the current catalog; reset that card to `default` and point the user at Settings.
- Land as flat steps with independent commits: interface widening → adapter → Settings
  chips+sheets → permission fold → bulletin → integration.

#### Success Criteria (Measurable) {#success-criteria}

> Falsifiable.

- Settings → Assistant renders the **actual** `ModelChip` / `PermissionModeChip` /
  `EffortChip`, and their labels are byte-identical to the Z4B chips for the same value
  (set default to Sonnet; the Settings chip and a new card's Z4B chip show the same string).
- Opening any Assistant control opens the **same sheet** as the Z4B chip — rich rows with
  `displayName` title + `description` subtitle — not a dropdown.
- Changing a **card's** Model/Mode/Effort via its Z4B chip leaves the deck default and
  every other open card unchanged (two cards + Settings; drive one, assert the others
  unchanged via the app-test harness).
- The model list is never hardcoded: after any session reports capabilities, the Settings
  sheet and a resumed card's picker show Claude's live list; grep proves no component
  imports `KNOWN_MODELS` as a *display* source except the bootstrap fallback.
- A card seeded with a concrete model absent from the live catalog opens on Claude's
  current default **and** raises the bulletin once for that card (persist a bogus selector,
  spawn a card, assert bulletin + `default`).
- `bunx tsc` clean, `bunx vite build` clean, `bun test` green for the pure-logic suites.

#### Scope {#scope}

1. A `ReadableMetadataStore` interface + widening the chip/picker store prop to it.
2. `DefaultsMetadataAdapter` — a read-only metadata store over the deck-default stores + catalog.
3. Settings → Assistant: render the three default-bound chips + host their sheets wired to
   the deck-default stores; **replace** the existing Permission Mode dropdown and add Model
   + Effort chips.
4. `PermissionModeChip` defaults-mode (bypass the per-card persisted read) + the fold.
5. Card-level unavailable-model bulletin + reset-to-default.
6. Integration: `tsc` / `vite build` / unit tests / real app-test drive.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Re-designing the sheets themselves (visuals, copy, row layout) — reused as-is.
- Changing the per-card persistence, spawn/mount seeding, tugbank domains, or the catalog
  persistence already at HEAD (see [#starting-state]) — this plan builds on them.
- A deck-default effort bulletin for a level a model can't honor — `use-effort` already
  leaves an unsupported level alone; only the *model* gets a bulletin.
- Any Rust / tugcode change. The live catalog already arrives via `session_capabilities`
  (see [#capabilities-flow]); this is tugdeck-only.

#### Dependencies / Prerequisites {#dependencies}

- **Base commit `2da312c84`** — the machinery in [#starting-state] must be present. Verify
  with `git log --oneline -1` before starting; the working tree should otherwise be clean.
- Existing sheets/chips (unchanged at HEAD): `model-picker-sheet.tsx` (`ModelPickerSheetBody`,
  `useModelPicker`), `effort-picker-sheet.tsx` (`useEffortPicker`), `permission-mode-chip.tsx`
  (`usePermissionSheet`, `PermissionModeChip`), `model-chip.tsx`, `effort-chip.tsx`,
  `tug-sheet` (`useTugSheet`).

#### Constraints {#constraints}

- Tuglaws: external state enters React only via `useSyncExternalStore` [L02]; persistence
  goes through tugbank `/api/defaults`, never localStorage (`feedback_no_localstorage`);
  appearance via CSS/DOM, not React state [L06]. Read `tuglaws/tuglaws.md` +
  `pane-model.md` + `component-authoring.md` before touching tugways code, and name the
  laws touched in each commit (`feedback_tuglaws_cross_check`).
- No mock-store or fake-DOM render tests (`feedback_real_not_fake`); prove UI behavior
  through the real app-test harness.
- `useSyncExternalStore` requires `getSnapshot` to return a **stable reference** when
  nothing changed — the adapter must memoize (no fresh object per call).
- The debug app loads the production rollup bundle — run `bunx vite build` before declaring
  a tugdeck change done (`feedback_verify_with_vite_build`). For a native/app-test change to
  take effect, force a fresh bundle with `just app-test-build` (a bare `just app-test` only
  rebuilds `tugdeck/dist`, not the Swift/Rust bundle).

#### Assumptions {#assumptions}

- `useModelPicker` / `useEffortPicker` / `usePermissionSheet` only *read* the metadata store
  (`subscribe` / `getSnapshot`) and invoke an injected action callback — they do not call
  `apply*` mutators on it (confirmed for model + effort at HEAD; verify permission in Step 1).
- The Settings card can host its own `useTugSheet` for the three default sheets, exactly as
  the Dev card hosts `cardPickerSheet` (`dev-card.tsx`).
- Claude's live `session_capabilities.models` carries per-model `displayName` +
  `description`; the sheet already renders both (title + subtitle) — see [#capabilities-flow].

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Explicit `{#anchor}` headings and rich `**References:**` lines. Plan-local decisions are
`[P01]…` (never `[D##]`, reserved for `tuglaws/design-decisions.md`, which may be cited by
reference). Step dependencies cite `#step-N` anchors, never titles or line numbers. Labels
are two-digit and never reused.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Model chip label for the `default` selector in Settings (RESOLVED) {#q01-default-label}

**Question:** When the deck default is the `default` selector, should the Settings model
chip show "Default (recommended)" or the resolved "Opus 4.8 · 1M"?

**Resolution:** DECIDED (see [P02]) — the adapter sets `model = selectorToModelId(defaultSelector)`,
so the chip shows the resolved label ("Opus 4.8 · 1M") while the sheet checkmarks the
"Default (recommended)" row. Byte-identical to how the Z4B chip + sheet already behave for a
session on the account default; no special-casing, and it satisfies the "labels match Z4B"
criterion.

#### [Q02] Bulletin evaluation before any capabilities exist (RESOLVED) {#q02-bulletin-gate}

**Question:** How do we avoid a false "model unavailable" bulletin on a fresh install where
only the `KNOWN_MODELS` bootstrap is present?

**Resolution:** DECIDED (see [P05]) — the bulletin evaluates membership against the
**persisted** catalog only (`dev.tugtool.models/catalog`). If no live catalog has ever been
persisted, the check is skipped. `readModelCatalog()` returns the bootstrap seed in that
case, so the predicate must be given the *raw persisted* catalog (or a "is this the bootstrap
seed" signal), not `readModelCatalog()`.

#### [Q03] Effort level unsupported by the seeded model (DEFERRED) {#q03-effort-unsupported}

**Question:** Should an effort default a resolved model can't honor (e.g. `high` on a haiku
default) get its own bulletin?

**Resolution:** DEFERRED — out of scope per [#non-goals]. `use-effort`'s mount-restore already
leaves an unsupported level alone (no respawn, chip shows `-`). Revisit only on user feedback;
tune the model bulletin's copy first.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Adapter `getSnapshot` returns unstable refs → render loop | high | med | Memoize; rebuild only on a tracked source change | React "Maximum update depth" in dev |
| Widening chip prop type breaks a Z4B call site | med | low | `ReadableMetadataStore = Pick<…>` is a supertype of the concrete store; tsc catches misuse | tsc error |
| Bulletin fires on every new card when the deck default is stale | low | med (accepted) | Accepted per owner; resets to default + points to Settings | Owner asks to throttle |

**Risk R01: Adapter snapshot identity churn** {#r01-adapter-identity}

- **Risk:** If the adapter rebuilds its snapshot object on every `getSnapshot`, the three
  chips re-render every frame and can loop.
- **Mitigation:** Cache the last snapshot; recompute only when a subscribed source (a
  deck-default store or the catalog domain) actually changed, mirroring
  `SessionMetadataStore`'s reconcile memoization.
- **Residual risk:** None once memoized; an app-test opens Settings and asserts no runaway
  re-render.

**Risk R02: Permission chip's per-card read leaking into Settings** {#r02-permission-cardid}

- **Risk:** `PermissionModeChip` reads a per-card persisted mode by `cardId`; in Settings
  there is no card, so it could show a wrong value.
- **Mitigation:** Add an explicit defaults-mode prop that bypasses the per-card read and
  trusts the adapter's `permissionMode` ([P03]).
- **Residual risk:** None; the prop is opt-in and Z4B keeps its current path.

---

### Design Decisions {#design-decisions}

#### [P01] The rich sheets + real chips are the sole editor for these values (DECIDED) {#p01-single-editor}

**Decision:** Exactly one UI for picking Model / Mode / Effort — the existing chips +
sheets. Settings → Assistant renders those same components bound to the deck defaults; no
dropdown editor is introduced (and the existing Permission Mode dropdown is replaced).

**Rationale:** A second, lesser editor is what produced terse labels and a maintenance seam.
The sheet bodies and pickers are already prop-driven, so reuse is cheap.

**Implications:** Settings hosts a `useTugSheet` and three default-targeting picker wirings;
no `TugPopupButton` remains for these three values.

#### [P02] `DefaultsMetadataAdapter` — a read-only `SessionMetadataStore` over defaults + catalog (DECIDED) {#p02-adapter}

**Decision:** A small adapter satisfies the read side of `SessionMetadataStore` (`subscribe`
+ `getSnapshot → SessionMetadataSnapshot`) by composing `DefaultModelStore` /
`DefaultPermissionModeStore` / `DefaultEffortStore` + `readModelCatalog()`. Its snapshot sets
`model = selectorToModelId(defaultModelSelector)`, `permissionMode = defaultMode`, `effort =
defaultEffort`, `models = readModelCatalog()`, and the remaining `SessionMetadataSnapshot`
fields to inert defaults (`sessionId/cwd/version = null`, `slashCommands = []`).

**Rationale:** Lets the existing chips **and** pickers consume it unmodified — one seam, not
three. `models = catalog` means the effort chip resolves support and the sheets have options
with no live session.

**Implications:** Adapter subscribes to the three deck-default stores and the catalog domain
(`dev.tugtool.models`), memoizes the snapshot ([R01]), and exposes `dispose()`. It is the
first (and only) constructor of `DefaultModelStore` / `DefaultEffortStore`, which sit unwired
at HEAD.

#### [P03] Widen chip/picker store prop to `ReadableMetadataStore`; permission chip gains defaults-mode (DECIDED) {#p03-readable-store}

**Decision:** Introduce `type ReadableMetadataStore = Pick<SessionMetadataStore, "subscribe"
| "getSnapshot">`. `ModelChip` / `EffortChip` / `PermissionModeChip` and the picker hooks
accept `ReadableMetadataStore` instead of the concrete class. `PermissionModeChip` gains a
prop that suppresses its per-card persisted read (used in the Settings/defaults context) and
trusts the adapter's `permissionMode`.

**Rationale:** The real store is a subtype of the interface, so Z4B call sites are
unaffected. Only the permission chip has a per-card read to neutralize ([R02]).

**Implications:** Pure type-widening refactor; tsc guards it.

#### [P04] Model list is catalog-driven; `KNOWN_MODELS` is bootstrap-only (DECIDED, at HEAD) {#p04-catalog-only}

**Decision:** The persisted live catalog (`dev.tugtool.models/catalog`, written from
`session_capabilities.models`) is the sole source for the picker fallback, the Settings sheet
options, and selector validation. `KNOWN_MODELS` is only a first-launch seed, overwritten the
instant any session reports capabilities.

**Rationale:** Models change constantly; a maintained constant rots and is exactly the stale
launch/resume/session-less list users kept hitting.

**Implications:** Already implemented at HEAD ([#starting-state]); this plan keeps it and
forbids new hardcoded display sources (enforced by the success-criteria grep). The Settings
sheet options come from `readModelCatalog()`, never a local constant.

#### [P05] Unavailable-model bulletin: concrete pick only, per new card, reset to default (DECIDED) {#p05-bulletin}

**Decision:** At card mount, resolve the seed model (`resolveSeedModel(persisted, default)`).
If the seed is a **concrete** selector (not `default`, not `null`) **and** absent from the
**persisted** catalog, reset the card to `default` and raise a card-level sheet: *"Saved
model 'X' is no longer available — this session is using Default. Review your Assistant
defaults,"* with a button that opens Settings → Assistant. Fires per new card (accepted); the
`default` zero-state never triggers it.

**Rationale:** Surfaces silent breakage instead of quietly falling back. Concrete-pick-only
avoids noise on the common zero-state.

**Implications:** New `use-unavailable-model-bulletin` hook, gated on the persisted catalog
existing ([Q02]); reuses `writePersistedModel(cardId, "default")` (from `use-model.ts`) and
`showSingletonCard("settings")`.

#### [P06] Permission Mode default folds into the chip pattern (DECIDED) {#p06-permission-fold}

**Decision:** Replace the existing Permission Mode `TugPopupButton` in Settings with the
default-bound `PermissionModeChip` + behavior sheet, so all three defaults are one system.

**Rationale:** Consistency; one editor, one look, per the owner's directive.

**Implications:** `DefaultPermissionModeStore` stays as the write target (moved from the
dropdown's construction to the adapter's); only the control changes.

---

### Deep Dives {#deep-dives}

#### Starting State at HEAD — what `2da312c84` already contains {#starting-state}

> The context a fresh session needs. All paths under `tugdeck/src/`.

**Model catalog (always-current, fully wired):**
- `lib/model-catalog.ts` — `MODEL_CATALOG_DOMAIN = "dev.tugtool.models"`,
  `MODEL_CATALOG_KEY = "catalog"`; `persistModelCatalog(models)` (optimistic `setLocalValue`
  + PUT via `putModelCatalog` in `settings-api.ts`), `readModelCatalog()` (sync tugbank read
  → `CapabilityModel[]`, falling back to `KNOWN_MODELS`), `parsePersistedCatalog(entry)`.
- `dev-card.tsx` — an effect persists `sessionMetadataStore.getSnapshot().models` whenever a
  card reports a non-empty list (no-op on empty; dedup via a `useRef` of the serialized list).
- `model-picker-sheet.tsx` — `useModelPicker({ onSelectModel, sessionMetadataStore, showSheet,
  commitDisposition })`; the picker's fallback options are `readModelCatalog()`, and a picked
  row calls the injected `onSelectModel`.
- `model-picker-data.ts` — `resolvePickerModels(models, activeModel, fallback = KNOWN_MODELS)`
  (the picker/effort now pass `readModelCatalog()`).
- `model.ts` — `isModelSelector(value)` validates against `readModelCatalog()` (not a
  constant).

**Per-card model (fully wired):**
- `model.ts` — `MODEL_DOMAIN = "dev.model"` (per-card), `MODEL_DEFAULT_DOMAIN =
  "dev.tugtool.model"` / `MODEL_DEFAULT_KEY = "default"` (deck default),
  `DEFAULT_MODEL_SELECTOR = "default"`, `parsePersistedModel`, `resolveSeedModel(persisted,
  globalDefault)`.
- `use-model.ts` — `useModel({ cardId, codeSessionStore, sessionMetadataStore }) → { setModel }`;
  reads per-card + deck default, mount-restore seeds via `resolveSeedModel` (both new and
  resumed sessions, since model isn't on the spawn frame); `writePersistedModel(cardId,
  selector)`. Wired in `dev-card.tsx` (`const model = useModel(...)`, threaded into
  `useModelPicker`).

**Deck-default scaffolding (present, NOT yet constructed by any UI):**
- `default-model-store.ts` — `DefaultModelStore` (writes `dev.tugtool.model/default`).
- `default-effort-store.ts` — `DefaultEffortStore` (writes `dev.tugtool.effort/default`).
- `default-permission-mode-store.ts` — `DefaultPermissionModeStore` (pre-existing; writes
  `dev.tugtool.permission-mode/default`); **currently** constructed by the original Permission
  Mode dropdown in `settings-general-body.tsx`.
- `effort.ts` — `EFFORT_DEFAULT_DOMAIN = "dev.tugtool.effort"` / `EFFORT_DEFAULT_KEY =
  "default"`, `resolveSeedEffort(persisted, globalDefault)`.
- `use-effort.ts` — reads the deck default and seeds via `resolveSeedEffort`.
- `settings-api.ts` — `putModelCatalog`, `putDefaultModel`, `putDefaultEffort` (+ pre-existing
  `putDefaultPermissionMode`).

> `DefaultModelStore` and `DefaultEffortStore` have **no importer** at HEAD — they are
> scaffolding this plan wires in Step 2. `use-model` / `use-effort` read their deck-default
> domains, which stay unwritten (→ `null`, per-card behavior only) until the adapter + chips
> land. This is expected, not a bug.

**Settings at HEAD:** `settings-general-body.tsx` is the pre-prototype version — Response /
Editor / Assistant, where **Assistant contains only the Permission Mode `TugPopupButton`**
(via `DefaultPermissionModeStore`). There are **no** Model or Effort default controls, and no
bare Model/Effort dropdowns to delete (the prototype's were reverted).

**Tests at HEAD:** `__tests__/model.test.ts`, `__tests__/model-catalog.test.ts`, and the
`resolveSeedEffort` block in `__tests__/effort.test.ts` cover the pure helpers.

#### Capabilities flow — where the live model list comes from {#capabilities-flow}

`tugcode/src/capabilities.ts` parses Claude's `initialize` control-response into a
`session_capabilities` IPC message carrying `models: CapabilityModel[]` (each `{ value,
displayName, description?, supportsEffort?, supportedEffortLevels? }`; `value` is the `/model`
**selector** — `default` / `sonnet` / `haiku` / etc., where `default` = the account default).
That rides the `SESSION_SIDEBAND` feed into `SessionMetadataStore` (`_capabilities` region),
surfacing as `snapshot.models`. New (turn-free) sessions get it "from the drop"; **resumed**
sessions carry none (empty `models`). The HEAD catalog effect persists a non-empty list so
resumed / session-less contexts read the last real list via `readModelCatalog()`. This is why
the defaults UI can show a rich, current list with no live session.

---

### Specification {#specification}

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Deck default model/mode/effort | local-data | `Default*Store` + `useSyncExternalStore`; tugbank `/api/defaults` | [L02], [D07], `feedback_no_localstorage` |
| Live model catalog | local-data | tugbank `dev.tugtool.models/catalog`; `readModelCatalog` | [L02], [D07] |
| Adapter snapshot (defaults → metadata shape) | local-data (derived) | memoized external store; `useSyncExternalStore` | [L02] |
| Settings sheet host + presented sheet | structure/overlay | `useTugSheet` (`showSheet`) card-scoped overlay | [D15] |
| "Should the bulletin show" (per card) | local-data | single-shot `useEffect` + `useRef` gate over catalog vs seed | [L02], [L07] |
| Chip/sheet labels | appearance | CSS/DOM via the existing chip components | [L06] |

**Spec S01: `DefaultsMetadataAdapter` snapshot contract** {#s01-adapter-contract}

- `getSnapshot()` returns a `SessionMetadataSnapshot` with `model =
  selectorToModelId(defaultModelSelector)`, `permissionMode = defaultMode`, `effort =
  defaultEffort`, `models = readModelCatalog()`, `sessionId/cwd/version = null`,
  `slashCommands = []`.
- The returned object is **cached**; a new object is produced only when a subscribed source
  (`DefaultModelStore` / `DefaultPermissionModeStore` / `DefaultEffortStore` or the
  `dev.tugtool.models` domain) changed since the last build.
- `subscribe(listener)` fans out from all four sources, returns a single unsubscribe.
- `dispose()` tears down all source subscriptions and disposes the stores it owns.

**Spec S02: Default picker wirings** {#s02-default-pickers}

- Model: `useModelPicker({ onSelectModel: defaultModelStore.set, sessionMetadataStore:
  adapter, showSheet: settingsSheet.showSheet })`.
- Effort: `useEffortPicker({ onSelectEffort: defaultEffortStore.set, sessionMetadataStore:
  adapter, showSheet })`.
- Mode: `usePermissionSheet({ onSelectMode: defaultModeStore.set, sessionMetadataStore:
  adapter, showSheet, cardId: <defaults sentinel / omitted> })`.
- Each chip receives `sessionMetadataStore = adapter` and `onOpen = the picker's opener`.

**Spec S03: Bulletin trigger** {#s03-bulletin-trigger}

- Inputs: `cardId`, persisted per-card model, deck default model, the **raw persisted**
  catalog (not `readModelCatalog()`, to avoid the bootstrap seed — [Q02]).
- Fire iff: a persisted catalog exists AND `seed = resolveSeedModel(persisted, default)` is a
  concrete selector (`!== "default"`, `!== null`) AND `seed ∉ catalog.value[]`.
- Effect: `writePersistedModel(cardId, "default")`, then `showSheet` the bulletin (title, the
  missing selector, a "Review Assistant defaults" button → `showSingletonCard("settings")`).
- Single-shot per mount (`useRef`), gated so it never races the first capabilities.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/defaults-metadata-adapter.ts` | `DefaultsMetadataAdapter` ([P02], Spec S01) |
| `tugdeck/src/lib/use-unavailable-model-bulletin.ts` | Card-level unavailable-model bulletin ([P05], Spec S03) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `ReadableMetadataStore` | type | `lib/session-metadata-store.ts` | `Pick<SessionMetadataStore,"subscribe"\|"getSnapshot">` ([P03]) |
| `DefaultsMetadataAdapter` | class | `lib/defaults-metadata-adapter.ts` | Spec S01 |
| `ModelChip` / `EffortChip` props | interface | `model-chip.tsx` / `effort-chip.tsx` | store prop → `ReadableMetadataStore` ([P03]) |
| `PermissionModeChip` props | interface | `permission-mode-chip.tsx` | store prop widen + defaults-mode flag ([P03], [R02]) |
| `useModelPicker` / `useEffortPicker` / `usePermissionSheet` args | interface | resp. sheet files | store arg → `ReadableMetadataStore` |
| `SettingsGeneralBody` | component | `settings-general-body.tsx` | host adapter + `useTugSheet`; render 3 default chips; replace mode dropdown ([P01],[P06]) |
| `useUnavailableModelBulletin` | hook | `lib/use-unavailable-model-bulletin.ts` | wired in `dev-card.tsx` ([P05]) |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When |
|----------|---------|------|
| **Unit** (`bun:test`) | Pure logic: adapter snapshot build/memoization inputs; bulletin trigger predicate | Steps 2, 5 |
| **Contract** | Extend the existing `parsePersistedCatalog` / `resolveSeedModel` suites for the bulletin predicate | Step 5 |
| **Integration (app-test)** | Real app: labels match Z4B, per-card isolation, bulletin, no dropdown | Step 6 |

#### What stays out of tests {#test-non-goals}

- No mock-`SessionMetadataStore` render tests and no fake-DOM chip renders
  (`feedback_real_not_fake`) — chip/sheet behavior is proven through the app-test drive.
- The adapter's snapshot *values* are unit-tested as a pure function; its React binding is
  proven in the app-test, not a jsdom mount.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. tugdeck HMR is live; `bunx vite build` gates each UI
> step. Cite the tuglaws touched in each commit body.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Widen chip/picker store prop to `ReadableMetadataStore` | done | `dc4166b09` |
| #step-2 | `DefaultsMetadataAdapter` | done | `66166cfbc` |
| #step-3 | Settings Assistant: Model + Effort default chips + sheets | done | `798ebff8b` |
| #step-4 | Fold Permission Mode default into the chip | done | `fe16920e8` |
| #step-5 | Unavailable-model bulletin | done | `26be4c98d` |
| #step-6 | Integration checkpoint | done | `c5575b90e` |

#### Step 1: Widen chip/picker store prop to `ReadableMetadataStore` {#step-1}

**Commit:** `tugdeck(assistant-defaults): widen chip/picker store prop to a readable interface`

**References:** [P03] (#p03-readable-store), Risk R02 (#r02-permission-cardid), (#assumptions, #starting-state)

**Artifacts:**
- `ReadableMetadataStore` type in `session-metadata-store.ts`.
- Prop-type change on `ModelChip` / `EffortChip` / `PermissionModeChip` and on `useModelPicker`
  / `useEffortPicker` / `usePermissionSheet` args.

**Tasks:**
- [ ] Add `export type ReadableMetadataStore = Pick<SessionMetadataStore, "subscribe" | "getSnapshot">`.
- [ ] Change the three chips' store prop and the three picker hooks' store arg to it.
- [ ] Confirm no picker calls an `apply*`/mutator on the store (grep); route any through the
      injected action callback instead.

**Tests:**
- [ ] `bunx tsc --noEmit` clean (compile is the proof for a pure widening).

**Checkpoint:**
- [ ] `bunx tsc --noEmit` && every existing Z4B call site still typechecks.

---

#### Step 2: `DefaultsMetadataAdapter` {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(assistant-defaults): DefaultsMetadataAdapter over default stores + catalog`

**References:** [P02] (#p02-adapter), Spec S01 (#s01-adapter-contract), Risk R01 (#r01-adapter-identity), (#state-zone-mapping, #starting-state)

**Artifacts:**
- `lib/defaults-metadata-adapter.ts` implementing `ReadableMetadataStore` + `dispose()`,
  constructing `DefaultModelStore` / `DefaultEffortStore` / `DefaultPermissionModeStore`.
- A pure `buildDefaultsSnapshot(modelSelector, mode, effort, catalog)` helper (unit-tested).

**Tasks:**
- [ ] Compose the three deck-default stores + `readModelCatalog()`; memoize the snapshot per
      Spec S01; subscribe to the stores and `client.onDomainChanged` for `dev.tugtool.models`.
- [ ] Factor snapshot construction into a pure function for unit tests.

**Tests:**
- [ ] Unit: `buildDefaultsSnapshot` maps selector→`model` (`selectorToModelId`), passes
      mode/effort, sets `models` from catalog, inert defaults for the rest.
- [ ] Unit: identical inputs return the same cached reference (memoization).

**Checkpoint:**
- [ ] `bun test src/lib/__tests__/defaults-metadata-adapter.test.ts` green; `bunx tsc` clean.

---

#### Step 3: Settings Assistant — Model + Effort default chips + sheets {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(assistant-defaults): render Model + Effort default chips + sheets in Settings`

**References:** [P01] (#p01-single-editor), Spec S02 (#s02-default-pickers), [Q01] (#q01-default-label), (#success-criteria, #starting-state)

**Artifacts:**
- `settings-general-body.tsx`: construct the adapter (dispose on unmount) + a `useTugSheet`
  host; wire `useModelPicker` / `useEffortPicker` targeting `defaultModelStore.set` /
  `defaultEffortStore.set`; render `ModelChip` / `EffortChip` bound to the adapter inside the
  Assistant `TugBox` (the Permission Mode dropdown stays for now — folded in Step 4).

**Tasks:**
- [ ] Instantiate `DefaultsMetadataAdapter`; host `useTugSheet`; wire the model + effort
      default pickers per Spec S02.
- [ ] Render the Model + Effort chips; render the sheet host.

**Tests:**
- [ ] `bunx vite build` (prod bundle) clean.

**Checkpoint:**
- [ ] Settings shows Model + Effort as chips; clicking opens the rich sheet; picking writes
      the deck-default store (chip label updates); labels match a new card's Z4B chip.

---

#### Step 4: Fold Permission Mode default into the chip {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(assistant-defaults): replace Permission Mode dropdown with the default-bound chip`

**References:** [P03] (#p03-readable-store), [P06] (#p06-permission-fold), Risk R02 (#r02-permission-cardid), Spec S02 (#s02-default-pickers)

**Artifacts:**
- `permission-mode-chip.tsx`: defaults-mode prop that bypasses the per-card `useTugbankValue`
  read and trusts the adapter's `permissionMode`.
- `settings-general-body.tsx`: render the default-bound `PermissionModeChip` + behavior sheet
  targeting `DefaultPermissionModeStore` (now owned by the adapter); **remove** the Permission
  Mode `TugPopupButton`, `DEFAULT_PERMISSION_MODE_OPTIONS`, and the standalone
  `DefaultPermissionModeStore` construction in the body.

**Tasks:**
- [ ] Add the defaults-mode prop; guard the `useTugbankValue(cardId)` read behind it.
- [ ] Wire `usePermissionSheet` with `onSelectMode: defaultModeStore.set` + the adapter.
- [ ] Remove the mode `TugPopupButton` + its option constant from the body.

**Tests:**
- [ ] `bunx vite build` clean.

**Checkpoint:**
- [ ] All three Assistant controls are chips opening their sheets; the mode chip shows the
      deck default (not a stale per-card value); no `TugPopupButton` remains for these three.

---

#### Step 5: Unavailable-model bulletin {#step-5}

**Depends on:** #step-2

**Commit:** `tugdeck(assistant-defaults): card bulletin when a saved model is unavailable`

**References:** [P05] (#p05-bulletin), Spec S03 (#s03-bulletin-trigger), [Q02] (#q02-bulletin-gate), (#non-goals, #starting-state)

**Artifacts:**
- `lib/use-unavailable-model-bulletin.ts`: single-shot hook implementing Spec S03.
- `dev-card.tsx`: wire the hook (uses the card's sheet host; opens Settings on action).
- A pure `shouldWarnUnavailableModel(seed, catalog)` predicate (unit-tested).

**Tasks:**
- [ ] Implement the predicate + hook; gate on a *persisted* catalog existing (not the
      bootstrap seed).
- [ ] On trigger: `writePersistedModel(cardId, "default")` + `showSheet` the bulletin with a
      "Review Assistant defaults" → `showSingletonCard("settings")` action.
- [ ] Wire into `dev-card.tsx` alongside `useModel`.

**Tests:**
- [ ] Unit: predicate true for a concrete-absent seed; false for `default` / `null` / a
      present selector; false when no persisted catalog exists.

**Checkpoint:**
- [ ] `bun test` for the predicate green; `bunx tsc` / `bunx vite build` clean.

---

#### Step 6: Integration Checkpoint {#step-6}

**Depends on:** #step-3, #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), [P01] (#p01-single-editor), [P05] (#p05-bulletin)

**Tasks:**
- [ ] Force a fresh native app-test bundle (`just app-test-build`) so tugcast carries current
      capabilities; drive the app.

**Tests:**
- [ ] `bunx tsc` clean · `bunx vite build` clean · `bun test` green (catalog, model, adapter,
      bulletin, effort/picker suites).
- [ ] app-test drive: Settings chips open the rich sheets (no dropdown); Settings chip labels
      equal a new card's Z4B chip labels for the same default; set default = Sonnet → new card
      opens on Sonnet; change one card's model via Z4B → default + other cards unchanged;
      persist a bogus selector → new card shows the bulletin and opens on Default.

**Checkpoint:**
- [ ] `just app-test` green for the touched suites; the five success criteria all hold.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Per-card Model/Mode/Effort seeded from user-level defaults that are edited
only through the existing rich chips + sheets, backed by the always-current Claude-sourced
catalog at HEAD, with a card-level bulletin when an explicitly-chosen model is gone.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] No `TugPopupButton` remains for Model/Mode/Effort in Settings (grep + screenshot).
- [ ] Settings and Z4B render the identical chip/sheet components; labels match.
- [ ] Per-card changes never mutate the defaults or other cards (app-test).
- [ ] Model list is catalog-driven everywhere; `KNOWN_MODELS` is only the bootstrap seed.
- [ ] Concrete-absent seed → bulletin + reset to `default`, once per card.
- [ ] `tsc` / `vite build` / `bun test` all clean.

#### Roadmap / Follow-ons (Not required for phase close) {#roadmap}

- [ ] Effort-unsupported bulletin ([Q03]), if user feedback warrants.
- [ ] Optional throttle of the deck-default-unavailable bulletin to once per app session.

| Checkpoint | Verification |
|------------|--------------|
| One editor | Screenshot: Settings opens the same sheet as Z4B |
| Isolation | app-test: drive one card, assert others + default unchanged |
| Always-current | grep: no non-bootstrap `KNOWN_MODELS` display import |
| Bulletin | app-test: bogus selector → bulletin + `default` |

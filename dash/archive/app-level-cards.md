<!-- devise-skeleton v4 -->

## App-Level Cards: About + Settings Singletons {#app-level-cards}

**Purpose:** Ship two app-level singleton cards — an Apple-style **About** box and a multi-tab **Settings** pane — driven by the Swift menu's existing `show-card` control frames, and retire the per-pane `…` (Ellipsis) settings affordance now that settings have a dedicated home.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-09 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tug.app's application menu already exposes **About Tug** and **Settings…** (⌘,). Both menu items are wired on the Swift side: `AppDelegate.showAbout` / `AppDelegate.showSettings` send a `show-card` control frame with `component: "about"` / `component: "settings"` (`tugapp/Sources/AppDelegate.swift`), and tugdeck already registers a `show-card` action handler (`action-dispatch.ts`) that calls `deckManager.addCard(component)`. But neither card type is registered, so today the handler logs a warning and returns null — the menu items do nothing visible. The handler even carries a comment anticipating this work.

Separately, every pane's title bar carries a `…` (Ellipsis) button that opens the active card's settings sheet via `cardSettingsStore` / `useCardSettings`. Only the Dev card registers a controller, so for every other card the button paints disabled — a dead affordance. Once Settings has a real home, the `…` should be retired, leaving panes with just the window-shade (collapse) and close controls.

A useful discovery during design: the Dev card's `…` settings *look* per-card but persist to **global** tugbank domains (`EditorSettingsStore` → `dev.tugtool.editor`, `ResponseSettingsStore` → `dev.tugtool.dev.response`). Each Dev card holds its own store *instance*, but they all read/write one shared global domain and live-update via `onDomainChanged`. These are effectively app-wide preferences already, so relocating them into a global Settings card is consistent with how they are stored — and any open Dev card stays in sync automatically.

#### Strategy {#strategy}

- Add one small singleton primitive to `DeckManager` (`showSingletonCard`) and point the `show-card` handler at it. No registry flag, no per-card "isSingleton" bookkeeping — the *handler* decides about/settings are singletons by which method it calls.
- Reuse the existing z-order machinery: `activateCard(cardId)` already raises a card's host pane to z-top, so "bring to front" is free.
- Build **Settings as a single card with its own internal tab strip** (Option B), using the existing `TugTabBar` component — not as a multi-card pane. This keeps the singleton key a single `componentId` and avoids contorting the pane tab host (built for user-composed stacks).
- Build **About as a simple, fixed-size singleton card** modeled on the macOS About box. Its version/build identity arrives in the `show-card` payload from Swift and is parked in a small subscribable store the card reads.
- Migrate the Dev card's existing settings UI (`SettingsSheetBody`) into the Settings card's first tab, binding to the same global tugbank-backed stores.
- Only after settings have a new home, retire the `…`: strip the Ellipsis from `CardTitleBar`, drop the Dev card's `useCardSettings` registration, and delete the now-dead `card-settings-store` / `use-card-settings`.

#### Success Criteria (Measurable) {#success-criteria}

- App menu **About Tug** opens an About card; choosing it again with the card already open brings the existing card to front rather than spawning a second (verify: one card with `componentId: "about"` ever exists). 
- App menu **Settings…** (⌘,) opens the Settings card; re-invoking brings the existing one to front (verify: one card with `componentId: "settings"` ever exists).
- The Settings card shows a tab strip whose **first tab reproduces the former Dev `…` settings** (editor typography + response magnification/margin), and edits made there immediately affect open Dev cards (verify: change font size in Settings → open Dev card's editor reflows).
- The About card displays app version, build/commit, and copyright sourced from the Swift `show-card` payload (verify: values match `BuildInfo` / Info.plist).
- No pane title bar renders a `…` button anymore; only window-shade (collapse) and close (X) remain (verify: grep for `Ellipsis` in `tug-pane.tsx` returns nothing; visual check across Dev/Gallery/Git cards).
- `card-settings-store.ts` and `use-card-settings.tsx` are deleted with no remaining importers (verify: grep returns no references; `tsc` clean).

#### Scope {#scope}

1. `DeckManager.showSingletonCard(componentId)` + rewire the `show-card` action handler.
2. About card: subscribable app-info store, card component + registration, Swift payload enrichment.
3. Settings card: card shell with internal `TugTabBar`, singleton registration.
4. Migrate Dev `…` settings content into the Settings "General" tab.
5. Retire the `…`: remove Ellipsis plumbing from chrome, remove Dev card's settings registration, delete the dead store/hook.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Adding new settings beyond what the Dev `…` sheet already exposes (no new preferences in this phase).
- A general "app preferences" persistence framework — settings continue to use the existing tugbank domains.
- Theme selection UI inside Settings (theme stays in the Swift app menu).
- Reworking the pane tab host / type-picker chrome (Settings is a single card, Option B — see [P03]).
- Live-pushing version info on silent reconnect — the About card reads whatever the last `show-card` payload delivered.

#### Dependencies / Prerequisites {#dependencies}

- Existing `show-card` control frame from Swift (`AppDelegate.showAbout` / `showSettings`) — already shipped.
- Existing card registry + `DeckManager.addCard` / `activateCard` z-top behavior.
- Existing `TugTabBar` component (`tugdeck/src/components/tugways/tug-tab-bar.tsx`).
- Existing `EditorSettingsStore` / `ResponseSettingsStore` and their global tugbank domains.
- `BuildInfo.swift` + Info.plist version keys for the About payload.

#### Constraints {#constraints}

- **Tuglaws.** One `root.render()` [L01]; external state via `useSyncExternalStore` only [L02]; `useLayoutEffect` for event-dependent registration [L03]; appearance via CSS/DOM not React state [L06]. Cross-check `tuglaws.md` / `pane-model.md` / `component-authoring.md` before writing pane/card code and name touched laws in each commit message.
- **Persistent state via tugbank only** — no localStorage/sessionStorage/IndexedDB [no-localstorage memory]. Settings already comply; the app-info store is in-memory only.
- **Use existing Tug components** — internal tabs use `TugTabBar`; do not hand-roll a tab strip.
- **Editing/interactive substrates must register as responders** — the Settings card's form controls need a responder scope so Cmd-A/C/V and form bindings work (mirrors the Dev card's existing settings-sheet responder scope).
- HMR is always running for tugdeck; no manual builds. Swift changes require an app rebuild.

#### Assumptions {#assumptions}

- A singleton scan over `deckState.panes` / cards for a matching `componentId` is cheap (single-digit pane counts) and needs no index.
- About/Settings cards persist across restarts like any other card; the singleton scan dedupes on next invocation, so a restored card is reused rather than duplicated. (Tracked as [Q01].)
- Writing settings from the Settings card propagates to open Dev cards through the existing `onDomainChanged` subscription — no shared store *instance* is required.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` names and rich `References:` lines per the skeleton contract. Plan-local decisions are `[P01]`…; global decisions cited as `[D##]`; laws as `[L##]`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Do About/Settings cards persist across app restarts? {#q01-singleton-persistence}

**Question:** Should the singleton cards be saved into deck state and restored on next launch like ordinary cards, or filtered out so each launch starts without them?

**Why it matters:** If they persist, the singleton scan must run on the restore path too (it already will, since `showSingletonCard` scans live state). If they should be ephemeral, the save/restore filter needs a carve-out by `componentId`.

**Options (if known):**
- Persist like any card; rely on the singleton scan to dedupe (simplest, no carve-out).
- Filter `about`/`settings` out of the saved deck so they never auto-restore.

**Plan to resolve:** Default to **persist** (no special-casing) unless the restored Settings/About card feels intrusive in dogfooding; revisit before phase close.

**Resolution:** OPEN — leaning persist (see assumptions).

#### [Q02] About card on silent reconnect / stale version {#q02-about-version-freshness}

**Question:** The About card reads version from the last `show-card` payload. After a tugcast restart + silent re-auth, is a stale value acceptable until the next menu invocation?

**Why it matters:** Version/build only change across app rebuilds, not reconnects, so staleness is effectively impossible within a process lifetime.

**Options (if known):**
- Accept payload-on-open (chosen) — value is constant for the process.
- Push app-info via the initialize handshake instead.

**Resolution:** DECIDED — payload-on-open is sufficient (see [P02]); handshake delivery is a non-goal this phase.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Removing `…` breaks a card that quietly relied on it | med | low | Only the Dev card registers a controller; audit all `registerCard` sites before removal | grep finds a non-Dev `useCardSettings` caller |
| Settings form controls dead (no responder scope) | med | med | Mirror the Dev card's settings-sheet responder scope inside the Settings card | Cmd-A/C/V or popup buttons inert in Settings |
| Duplicate singletons from a race (two rapid menu clicks) | low | low | `showSingletonCard` scans synchronously before committing; single-threaded JS makes interleave impossible | two cards of same componentId observed |

**Risk R01: Migrating settings content loses Dev-card-specific wiring** {#r01-settings-migration}

- **Risk:** `SettingsSheetBody` currently consumes sender ids registered by `DevCardBody`'s `useResponderForm`; lifting it into a standalone card must re-establish that form/responder wiring.
- **Mitigation:** Move the form registration *with* the body into the Settings card; bind to fresh `EditorSettingsStore` / `ResponseSettingsStore` instances (same global domains).
- **Residual risk:** Subtle differences in default focus order inside the new card vs the old sheet; covered by a real-app smoke check.

---

### Design Decisions {#design-decisions}

#### [P01] Singleton-by-callsite, not by registry flag {#p01-singleton-callsite}

**Decision:** Add `DeckManager.showSingletonCard(componentId)` that reuses an existing card of that `componentId` (via `activateCard`, which raises to z-top) or falls back to `addCard`. The `show-card` action handler calls `showSingletonCard` for about/settings; nothing in the card registry marks a card "singleton".

**Rationale:**
- Keeps singleton *policy* at the one call site that wants it, not smeared into card state or registry metadata.
- `activateCard` already moves the host pane to z-top (`deck-manager.ts` — "host pane to z-top, set activePaneId"), so bring-to-front needs no new machinery.
- Matches the user's stated mental model: "if a card of that type exists, bring it to front; else create and bring to front."

**Implications:**
- `showSingletonCard` does a linear scan of `deckState.cards` for the first card whose `componentId` matches, then `activateCard(thatId)`; otherwise `addCard(componentId)`.
- The handler no longer calls `addCard` directly for about/settings.

#### [P02] About version comes from the `show-card` payload {#p02-about-payload}

**Decision:** Swift `showAbout` enriches the `show-card` control frame with app identity (`version`, `build`, `commit`, `branch`, `profile`, `copyright`). The tugdeck `show-card` handler writes these into a subscribable `appInfoStore`; the About card reads via `useSyncExternalStore`.

**Rationale:**
- The action is already Swift-initiated; piggy-backing identity on the same frame avoids a second channel.
- Version/build are constant for a process lifetime, so payload-on-open is fresh enough ([Q02]).
- Keeps tugdeck free of build-time version baking.

**Implications:**
- `AppDelegate.showAbout` reads `BuildInfo.commit` / `branch` / `profile` plus `CFBundleShortVersionString` (version) and `CFBundleVersion` (build) from Info.plist, and copyright.
- New `appInfoStore` module (in-memory, `useSyncExternalStore`-compatible, [L02]).

#### [P03] Settings is one card with an internal tab strip (Option B) {#p03-settings-internal-tabs}

**Decision:** Settings is a single registered card (`componentId: "settings"`) whose content renders a `TugTabBar` of sections. It is **not** a multi-card pane.

**Rationale:**
- Singleton key is trivially one `componentId`.
- Avoids suppressing the pane tab host's `[+]` type-picker and per-tab close (which exist for user-composed stacks).
- Full control over the fixed settings taxonomy; About becomes a parallel single card with no tabs.
- Reuses the existing `TugTabBar` component, honoring the "use existing Tug components" rule.

**Implications:**
- The Settings card owns tab selection as card-local state (`useState`), and establishes a responder scope so its form controls work.
- First tab = "General" (the migrated Dev settings). Additional tabs are future work.

#### [P04] Retire `…` only after settings have a new home {#p04-retire-ellipsis}

**Decision:** Sequence the Ellipsis removal *after* the Settings card hosts the migrated settings, then delete `cardSettingsStore` / `useCardSettings` and strip the `onSettingsClick` / `settingsEnabled` / `settingsActive` props and Ellipsis render from `CardTitleBar`.

**Rationale:**
- Avoids a window where the Dev settings have no UI surface.
- The `…` is a dead affordance for every non-Dev card; once the Dev card stops registering a controller, the whole mechanism is unused.

**Implications:**
- `tug-pane.tsx` loses the Ellipsis import, the three props, and the `hasController` / `getController` wiring (`handleTitleBarSettingsClick`, `settingsEnabledForActive`, `settingsOpenForActive`).
- `card-settings-store.ts` and `use-card-settings.tsx` are deleted.
- Title bar control order becomes: window-shade (Chevron) → close (X).

#### [P05] Settings binds to fresh store instances on the global domain {#p05-settings-store-instances} 

**Decision:** The Settings "General" tab constructs its own `EditorSettingsStore` / `ResponseSettingsStore` instances (same as the Dev card does) rather than sharing a single instance with Dev cards.

**Rationale:**
- Both stores read/write the global tugbank domains and observe `onDomainChanged`, so a write from Settings propagates to every open Dev card with no shared-instance plumbing.
- Matches the established per-surface-instance pattern in `card-services-store.ts`.

**Implications:**
- No change to `card-services-store.ts`; the Settings card creates instances at mount and disposes on unmount.

---

### Deep Dives (Optional) {#deep-dives}

#### Singleton + bring-to-front flow {#singleton-flow}

```
Swift menu (About Tug / Settings…)
   └─ AppDelegate.showAbout/showSettings
        └─ sendControl("show-card", { component, ...appInfo? })
              └─ tugdeck action-dispatch: registerAction("show-card")
                    ├─ if component === "about": appInfoStore.set(payload)   // [P02]
                    └─ deckManager.showSingletonCard(component)              // [P01]
                          ├─ existing card of componentId?  → activateCard(id)  // z-top, free
                          └─ none                           → addCard(componentId)
```

`activateCard` raising the host pane to z-top is the entire "bring to front" — confirmed at `deck-manager.ts` (the `_flipFirstResponder` path moves the host pane to the end of `panes`, which is highest z by render order).

#### Settings card composition {#settings-composition}

```
SettingsCard (componentId: "settings")
  └─ responder scope (form controls participate in the chain)
       └─ TugTabBar  [ General | … future tabs … ]
            └─ General tab → <SettingsGeneralBody>   // migrated SettingsSheetBody
                 ├─ Response section  (magnification, entry margin)  → ResponseSettingsStore
                 └─ Editor section    (font, size, tracking, leading, wrap, gutters, submit keys) → EditorSettingsStore
```

The migrated body is the current `SettingsSheetBody` from `dev-card.tsx`, lifted out of the `useTugSheet` render closure into a card body. Its `useResponderForm` registration moves with it.

#### About card composition {#about-composition}

A fixed-size (`min == max == preferred`), non-resizable card: app icon, "Tug" wordmark, version + build, commit (diagnostic), copyright. Reads `appInfoStore` via `useSyncExternalStore`; renders placeholders if the store is empty (e.g. browser-only dev with no Swift host).

---

### Specification {#specification}

- **`show-card` payload (about):** `{ component: "about", version: string, build: string, commit: string, branch: string, profile: string, copyright: string }`. The `settings` invocation keeps `{ component: "settings" }` (no extra fields).
- **`DeckManager.showSingletonCard(componentId: string): string | null`** — returns the (existing or new) card id; null only if `addCard` fails (unregistered componentId).
- **`appInfoStore`** — module singleton: `set(info)`, `getSnapshot()`, `subscribe(listener)`; in-memory, not persisted.
- **Card registrations:** `about` (closable, fixed size, `confirmClose: false`) and `settings` (closable, `confirmClose: false`). Both `hidden: true` from the type-picker `[+]` menu (they are menu-driven app cards, not user-composable stack tabs).
- **Title bar controls after retirement:** window-shade (collapse/expand Chevron) and close (X) only.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| App identity (version/build/commit) | local-data | `appInfoStore` + `useSyncExternalStore` | [L02] |
| Editor settings (typography/toggles) | local-data | `EditorSettingsStore` (tugbank-backed) + `useSyncExternalStore` | [L02] |
| Response settings (magnification/margin) | local-data | `ResponseSettingsStore` (tugbank-backed) + `useSyncExternalStore` | [L02] |
| Settings active-tab index | local-data (card-local) | `useState` in the card | [L02] |
| Card z-order / bring-to-front | structure | `deckManager.activateCard` (existing) | [L02], [L24] |
| `…` button presence (removed) | appearance/structure | CSS/DOM + chrome props removal | [L06] |
| Settings form-control responder participation | structure | responder scope + `useResponderForm` registration | [L03] |

---

### Compatibility / Migration / Rollout (Optional) {#rollout}

- **Compatibility:** No wire/schema contract changes beyond additive fields on the existing `show-card` frame (older tugdeck ignores unknown payload keys; older Swift simply omits them and the About card shows placeholders).
- **Migration:** The Dev `…` settings move surfaces; persisted tugbank values are untouched (same domains/keys), so existing user preferences carry over with no migration.
- **Rollout:** Single phase, committed directly to `main`. No feature gate.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/app-info-store.ts` | In-memory subscribable store for app identity from the `show-card` payload |
| `tugdeck/src/components/tugways/cards/about-card.tsx` | About card content + registration |
| `tugdeck/src/components/tugways/cards/settings-card.tsx` | Settings card shell (internal `TugTabBar`) + registration |
| `tugdeck/src/components/tugways/cards/settings-general-body.tsx` | Migrated Dev `…` settings body (the "General" tab) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `showSingletonCard` | method | `tugdeck/src/deck-manager.ts` | scan-or-create + `activateCard` ([P01]) |
| `show-card` handler | action | `tugdeck/src/action-dispatch.ts` | call `showSingletonCard`; write `appInfoStore` for about ([P01],[P02]) |
| `appInfoStore` / `AppInfoStore` | store | `tugdeck/src/lib/app-info-store.ts` | new ([P02]) |
| `AboutCard` | component | `about-card.tsx` | new; registered `componentId: "about"` |
| `SettingsCard` | component | `settings-card.tsx` | new; registered `componentId: "settings"`, internal tabs ([P03]) |
| `SettingsGeneralBody` | component | `settings-general-body.tsx` | migrated from `SettingsSheetBody` in `dev-card.tsx` ([R01]) |
| `CardTitleBar` | component | `tugdeck/src/components/chrome/tug-pane.tsx` | remove `onSettingsClick`/`settingsEnabled`/`settingsActive` + Ellipsis render ([P04]) |
| `TugPane` settings wiring | component | `tug-pane.tsx` | remove `handleTitleBarSettingsClick`, `settingsEnabledForActive`, `settingsOpenForActive`, `hasController`/`getController` use ([P04]) |
| `useCardSettings` call | call | `tugdeck/src/components/tugways/cards/dev-card.tsx` | remove; drop `SettingsSheetBody` (migrated) ([P04]) |
| `card-settings-store.ts` | file | `tugdeck/src/lib/card-settings-store.ts` | **delete** ([P04]) |
| `use-card-settings.tsx` | file | `tugdeck/src/components/tugways/use-card-settings.tsx` | **delete** ([P04]) |
| `showAbout` | method | `tugapp/Sources/AppDelegate.swift` | add identity params to `show-card` ([P02]) |

---

### Documentation Plan {#documentation-plan}

- [ ] Note the About/Settings singleton cards and the `showSingletonCard` primitive in the relevant tuglaws/pane-model doc (only if it materially changes the documented pane/card model — otherwise skip per "no freestanding docs" rule).
- [ ] Update any pane-chrome doc that describes the `…` affordance to reflect its removal.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (pure-logic, bun:test)** | `showSingletonCard` scan-or-create logic; `appInfoStore` snapshot/subscribe | Core singleton + store logic |
| **Integration (real-app, `just app-test`)** | Menu → `show-card` → singleton bring-to-front; Settings edit propagates to Dev card; `…` gone | End-to-end behavior |

#### What stays out of tests {#test-non-goals}

- No mock-store assertion / call-count tests and no fake-DOM render tests (banned patterns). The singleton logic is tested against the real `DeckManager` over real deck state; UI behavior is tested in the real app via `just app-test`.
- No standalone mock of `TugTabBar` or the settings stores — exercise the real components/stores.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Each tugdeck commit message names the tuglaws it touches.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Singleton primitive + handler rewire | done | f2f4bd0a |
| #step-2 | About card + app-info store + Swift payload | done | 87ddf012 |
| #step-3 | Settings card shell (internal tabs) | done | 7478359a |
| #step-4 | Migrate Dev `…` settings into General tab | done | 89bf7184 |
| #step-5 | Retire the `…` (chrome + store/hook deletion) | done | e37e227f |
| #step-6 | Integration checkpoint | done | (verification only) |

#### Step 1: Singleton primitive + `show-card` rewire {#step-1}

**Commit:** `tugdeck(deck): add showSingletonCard; route show-card through it [L02,L24]`

**References:** [P01] Singleton-by-callsite (#singleton-flow), Spec (#specification), (#strategy)

**Artifacts:**
- `DeckManager.showSingletonCard(componentId)` in `deck-manager.ts`.
- `show-card` action handler calls `showSingletonCard`.

**Tasks:**
- [ ] Implement `showSingletonCard`: scan `deckState.cards` for the first matching `componentId`; if found, `activateCard(id)` and return it; else `addCard(componentId)`.
- [ ] Rewire `registerAction("show-card")` to call `showSingletonCard` (keep the invalid-component guard).

**Tests:**
- [ ] Unit: two `showSingletonCard("x")` calls (with `x` registered) yield the same id and one card; second call leaves the pane at z-top.

**Checkpoint:**
- [ ] `cd tugdeck && bun test` (singleton unit test passes)
- [ ] `tsc` clean

---

#### Step 2: About card + app-info store + Swift payload {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(cards): About singleton card; Swift show-card carries app identity [L01,L02]`

**References:** [P02] About payload (#about-composition, #p02-about-payload), [Q02], Spec (#specification)

**Artifacts:**
- `app-info-store.ts`; `about-card.tsx` (+ registration); `AppDelegate.showAbout` payload fields.

**Tasks:**
- [ ] Create `appInfoStore` (set/getSnapshot/subscribe; in-memory).
- [ ] `show-card` handler: when `component === "about"`, `appInfoStore.set(payload)` before `showSingletonCard`.
- [ ] Build `AboutCard` (fixed size, `min==max==preferred`, non-resizable; icon, wordmark, version/build, commit, copyright) reading `appInfoStore` via `useSyncExternalStore`; render placeholders when empty.
- [ ] Register `componentId: "about"` (`closable`, `hidden: true`, fixed `sizePolicy`).
- [ ] `AppDelegate.showAbout`: add `version` (`CFBundleShortVersionString`), `build` (`CFBundleVersion`), `commit`/`branch`/`profile` from `BuildInfo`, `copyright`.

**Tests:**
- [ ] Unit: `appInfoStore` snapshot identity + subscribe notify.
- [ ] Real-app: About menu opens a card showing non-placeholder version; re-invoking brings the same card to front (no duplicate).

**Checkpoint:**
- [ ] `just app-test <about-singleton test>` → `VERDICT: PASS`

---

#### Step 3: Settings card shell with internal tabs {#step-3}

**Depends on:** #step-1

**Commit:** `tugdeck(cards): Settings singleton card with internal TugTabBar [L02,L03]`

**References:** [P03] Internal tabs (#settings-composition, #p03-settings-internal-tabs)

**Artifacts:**
- `settings-card.tsx` (+ registration), an empty/placeholder "General" tab.

**Tasks:**
- [ ] Build `SettingsCard`: responder scope + `TugTabBar` with a single "General" tab (placeholder body for now); tab index as `useState`.
- [ ] Register `componentId: "settings"` (`closable`, `hidden: true`, sensible `sizePolicy`).

**Tests:**
- [ ] Real-app: Settings menu (⌘,) opens the card; re-invoking brings the same card to front (no duplicate).

**Checkpoint:**
- [ ] `just app-test <settings-singleton test>` → `VERDICT: PASS`

---

#### Step 4: Migrate Dev `…` settings into the General tab {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(settings): move dev editor/response settings into Settings General tab [L02]`

**References:** [P05] Store instances (#p05-settings-store-instances), Risk R01 (#r01-settings-migration), (#settings-composition)

**Artifacts:**
- `settings-general-body.tsx` (lifted `SettingsSheetBody`); wired into the General tab; bound to fresh `EditorSettingsStore` / `ResponseSettingsStore`.

**Tasks:**
- [ ] Extract `SettingsSheetBody` (+ its `useResponderForm` registration and helper fns `submitKeyLegend`, `letterSpacingLabel`) from `dev-card.tsx` into `settings-general-body.tsx`.
- [ ] Construct store instances at card mount; dispose on unmount.
- [ ] Render the body as the General tab content.

**Tests:**
- [ ] Real-app: change font size / magnification in Settings → open Dev card's editor/transcript reflects it (global-domain propagation).

**Checkpoint:**
- [ ] `just app-test <settings-propagation test>` → `VERDICT: PASS`
- [ ] `tsc` clean

---

#### Step 5: Retire the `…` {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(chrome): retire pane … settings button; delete card-settings store/hook [L06]`

**References:** [P04] Retire after migration (#p04-retire-ellipsis)

**Artifacts:**
- `CardTitleBar` without Ellipsis; `dev-card.tsx` without `useCardSettings`; deleted `card-settings-store.ts` + `use-card-settings.tsx`.

**Tasks:**
- [ ] Remove the Ellipsis button render and the `onSettingsClick`/`settingsEnabled`/`settingsActive` props from `CardTitleBar`; drop the `Ellipsis` import.
- [ ] Remove `handleTitleBarSettingsClick`, `settingsEnabledForActive`, `settingsOpenForActive`, and the `cardSettingsStore.hasController`/`getController` wiring from `TugPane`.
- [ ] Remove the `useCardSettings(...)` call and `SettingsSheetBody` remnants from `dev-card.tsx`.
- [ ] Delete `card-settings-store.ts` and `use-card-settings.tsx`; confirm no importers remain.

**Tests:**
- [ ] Real-app: Dev/Gallery/Git cards show only shade + close in the title bar; no `…`.

**Checkpoint:**
- [ ] `grep -rn "Ellipsis\|cardSettingsStore\|useCardSettings" tugdeck/src` → no results
- [ ] `tsc` clean; `just app-test <title-bar test>` → `VERDICT: PASS`

---

#### Step 6: Integration Checkpoint {#step-6}

**Depends on:** #step-2, #step-3, #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** [P01]–[P05], (#success-criteria)

**Tasks:**
- [ ] Verify About + Settings singletons open, dedupe, and bring-to-front; Settings General edits propagate; `…` fully gone.

**Tests:**
- [ ] Real-app end-to-end covering all success criteria.

**Checkpoint:**
- [ ] `just app-test <app-level-cards e2e>` → `VERDICT: PASS`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** App-menu-driven About and Settings singleton cards (bring-to-front on repeat), Settings hosting the migrated Dev editor/response preferences in its first tab, and the per-pane `…` affordance fully retired.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] About Tug opens/raises a single About card with real version/build (real-app).
- [ ] Settings… (⌘,) opens/raises a single Settings card with a tab strip; General tab edits affect open Dev cards (real-app).
- [ ] No pane shows a `…`; `card-settings-store.ts` / `use-card-settings.tsx` deleted; `tsc` clean; grep clean.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Additional Settings tabs (themes, keybindings, etc.).
- [ ] Resolve [Q01] persistence policy if dogfooding shows restored singletons are intrusive.
- [ ] Push app-info via the initialize handshake if version freshness ever matters beyond a process lifetime.

| Checkpoint | Verification |
|------------|--------------|
| Singletons dedupe + raise | real-app: invoke each menu twice, observe one card brought to front |
| Settings propagation | real-app: edit in Settings, observe Dev card reflow |
| `…` retired | `grep` clean + visual title-bar check |

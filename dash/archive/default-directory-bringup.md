<!-- devise-skeleton v4 -->

## Default Project Directory Bringup {#default-directory-bringup}

**Purpose:** Introduce a user-owned, app-wide *default project directory* (defaulting to `~/tug`), settable at TugSetup time and in the Settings card, and use it to make Open Quickly work unconditionally — current session card's project when one exists, the default directory otherwise — with an in-bar directory switcher so the user can retarget Open Quickly on the fly.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-31 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tug has no user-set notion of "where my projects live." The session picker seeds its Project path field from a derived chain — most-recent project, then a Swift-written launch hint (`dev.tugtool.app` / `initial-project-path`, whose own comment calls it "a derived hint, not user preference"), then the backend home directory. Open Quickly (File ▸ Open Quickly…, ⇧⌘O) is greyed out unless some card carries a live session binding with a `projectDir`, because both its search root and its FILETREE feed scope come from that binding. The result: a fresh deck, or a deck of unbound picker-state cards, has no way to quickly open a file at all, and a fresh install seeds the picker into home-directory soup.

One explicit setting — the default project directory — fills the user-preference tier the Swift hint was standing in for, gives Open Quickly an always-available fallback root, and gives future "need a directory before a session exists" affordances a principled answer.

#### Strategy {#strategy}

- Store the setting in tugbank (`dev.tugtool.app` / `default-project-path`); a read-side resolver falls back to `<home>/tug` when unset, so the concept works for existing users who will never re-run setup — no migration.
- Build frontend-only surfaces first (settings-api helpers, Settings card General tab, picker seed chain), then the small tugcast additions (`POST /api/fs/mkdir`, workspace acquire/release), then the Open Quickly changes that depend on them, then the in-bar switcher that rides on the same workspace machinery.
- Reuse the existing componentry wholesale: `TugFileChooser` for every path field, `TugPopupButton` for the switcher control, the existing `FeedStore`/`FileTreeStore` stack for enumeration. No hand-rolled UI.
- On the backend, take the **full directory-rooted workspace route** (user-confirmed): a directory becomes a real `WorkspaceRegistry` entry (index + FileWatcher + canonical key) via a new acquire endpoint, rather than a one-shot enumeration API. The switcher then treats every directory uniformly.
- Create `~/tug` lazily — at setup-accept and at first real use — never eagerly at boot.
- Verify each tugdeck step with `bunx vite build` (the debug app loads the production rollup bundle; dev-esbuild-only imports hang the app at the splash screen) and scope app-tests with `just app-test-changed`.

#### Success Criteria (Measurable) {#success-criteria}

- With zero cards open, File ▸ Open Quickly… is enabled; invoking it shows "Open Quickly in tug" (or the leaf of the user's chosen default), lists that directory's files, and committing a row opens the file in a card. (app-test)
- With a bound session card frontmost, Open Quickly still searches that card's project — behavior identical to today. (existing app-test `at0213-open-quickly.test.ts` still passes)
- The Settings card has a General tab with a "Default project directory" field; editing it persists across relaunch via `/api/defaults/dev.tugtool.app/default-project-path`. (app-test + manual relaunch)
- First-run TugSetup shows a "Choose your projects folder" step prefilled with `~/tug`; accepting creates the directory and persists the value. (gallery mock + app-test where feasible)
- The session picker with empty recents seeds its Project path from the explicit default when one is set. (app-test)
- From the Open Quickly bar, Tab reaches a directory control; picking another directory (frontmost project, default, or a recent project) live-swaps the search root. (app-test)
- `cd tugrust && cargo nextest run` passes with zero warnings; `bunx vite build` succeeds.

#### Scope {#scope}

1. tugbank-backed setting + read/put/resolve helpers in `tugdeck/src/settings-api.ts`.
2. Settings card General tab with a `TugFileChooser` path field.
3. Session picker seed-chain insertion.
4. tugcast `POST /api/fs/mkdir`.
5. TugSetup "Choose your projects folder" step (first-run and on-demand variants).
6. tugcast `POST /api/workspace/acquire` + `POST /api/workspace/release`.
7. Open Quickly: unconditional menu enablement + default-directory fallback root.
8. Open Quickly in-bar directory switcher (trailing control, keyboard reachable).

#### Non-goals (Explicitly out of scope) {#non-goals}

- No change to what a *bound* card's Open Quickly searches — the frontmost binding still wins.
- No eager creation of `~/tug` at app launch or tugcast boot.
- No removal of the Swift `initial-project-path` hint machinery (`tugapp/Sources/AppDelegate.swift`, `refreshInitialProjectPathHint()`); it stays as the debug-build convenience tier in the picker seed chain. A later cleanup may retire it.
- No per-project or per-card default directories — one app-wide value.
- No changes to the composer's `@`-completion or to `!find`.
- No Text-card save-panel initial-directory adoption (listed as a follow-on).

#### Dependencies / Prerequisites {#dependencies}

- tugbank defaults API (`/api/defaults/<domain>/<key>`) — already live.
- `WorkspaceRegistry::get_or_create` / `release` with refcounting — already implemented in `tugrust/crates/tugcast/src/feeds/workspace_registry.rs`.
- `FileTreeQuery.root` routing (`WorkspaceRegistry::route_filetree_query`) — already implemented.
- `TugFileChooser`, `TugComboBox`, `TugPopupButton`, `TugCompletionPopup` components — already shipped.

#### Constraints {#constraints}

- **Warnings are errors** across the Rust workspace (`-D warnings`).
- Tuglaws apply to all tugdeck work: [L01] one render, [L02] external state via `useSyncExternalStore`, [L03] `useLayoutEffect` for registrations events depend on, [L06] appearance via CSS/DOM. Read `tuglaws/tuglaws.md`, `tuglaws/component-authoring.md`, and `tuglaws/focus-language.md` before the frontend steps; name touched laws in commits.
- No localStorage/sessionStorage/IndexedDB — persistence is tugbank only.
- Never hand-roll UI that exists as a `Tug*` component; compose the real component.
- tugcast HTTP endpoints are loopback-gated (see existing handlers' `addr.ip().is_loopback()` checks).
- App-tests must carry `@covers` headers and run selectively (`just app-test-changed`).

#### Assumptions {#assumptions}

- `hostFacts.home` (from `GET /api/host`, cached in `tugdeck/src/lib/host-facts-store.ts`) is available by the time any consumer resolves the fallback; every consumer already tolerates a null host-facts snapshot by deferring.
- Holding one long-lived refcount on the default directory's workspace entry for the app's lifetime is acceptable (the bootstrap `--source-tree` workspace already lives forever).
- The `AgentSupervisor` (reachable from the axum `State<FeedRouter>` as `router.supervisor`) can expose its `Arc<WorkspaceRegistry>` and a cancellation token suitable for `get_or_create`; it already calls `registry.release` in `do_close_session`.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings, `[P##]` plan-local decisions, `[Q##]` open questions, `Spec S##`, `Risk R##`, and `**Depends on:** #step-N` lines per `tuglaws/devise-skeleton.md`. Global design decisions are cited as `[D##]`; tuglaws as `[L##]`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does recents[0] outrank the default in the picker seed? (DECIDED) {#q01-recents-vs-default}

**Question:** When the session picker seeds an empty Project path field, does the most-recent project or the user's default directory win?

**Resolution:** DECIDED (see [P02]) — recents[0] wins; continuity beats configuration. User-confirmed 2026-07-31.

#### [Q02] Full directory-rooted workspace route vs one-shot enumeration endpoint? (DECIDED) {#q02-full-route}

**Question:** Should Open Quickly's no-binding case get a real `WorkspaceRegistry` entry (live index + watcher) or a lighter one-shot directory-listing endpoint?

**Resolution:** DECIDED (see [P03]) — full route; the in-bar switcher wants any directory to behave identically to a bound project. User-confirmed 2026-07-31.

#### [Q03] Does `openFileInCard` work with zero cards open? (OPEN → resolve in #step-7) {#q03-openfileincard-empty-deck}

**Question:** Open Quickly's commit path calls `openFileInCard(store, absolutePath, line)` (`tugdeck/src/lib/open-file-in-card.ts`). Today the menu gate guarantees at least one bound card exists when it runs. With the gate removed, does it cleanly create a text card on an empty deck?

**Why it matters:** If it assumes an existing pane/stack, the very first unconditional Open Quickly commit on a fresh deck breaks.

**Plan to resolve:** Read `open-file-in-card.ts` and the `DeckManager` card-add path during #step-7; fix whatever assumes a non-empty deck; the #step-8 app-test asserts the empty-deck commit end-to-end.

**Resolution:** DECIDED — no change needed. `openFileInCard`'s docblock states it outright ("When the deck has no Text card yet, `reuse`/`newTab` fall through to `new`"), and the code matches: `findFrontmostTextCard` returns null on an empty deck, the `target !== "new"` branch is guarded on `frontmost !== null`, and the tail runs `store.addCard("text", seed)`. Confirmed end-to-end by the #step-8 app-test.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Acquiring a huge default directory walks it at acquire time | med | low | acquire once per app lifetime ([P05]); walk already capped (`truncated` flag) | user reports of slow first ⇧⌘O |
| Workspace refcount imbalance from frontend acquire/release | med | med | hold-one-ref-forever policy ([P05]); release only on setting change; Rust tests on release semantics | registry map growth in `/api/changesets` dumps |
| Switcher control breaks popup focus contract | med | med | compose `TugPopupButton`; follow `tuglaws/focus-language.md`; the popup is a popover, not a focus trap — keep it that way | ⌘V/Escape regressions in at0213 |
| Default dir deleted after being set | low | med | `probeDirExistence` before use; fall back to `<home>` resolution note in Settings field; mkdir on demand | — |

**Risk R01: Stale capture of the switcher's directory list** {#r01-stale-switcher-list}

- **Risk:** The overlay captures `frontmostProjectBinding()` once in a ref at open; the switcher menu must not re-derive it per keystroke or race deck reordering.
- **Mitigation:** Build the switcher's candidate list once at popup open (same capture discipline as `bindingRef`); the list is small (frontmost + default + ≤5 recents).
- **Residual risk:** A card closed while the popup is open leaves a dead first entry; commit on it falls back to the default root's behavior (existence probe fails → no results), which is acceptable.

---

### Design Decisions {#design-decisions}

#### [P01] Storage: `dev.tugtool.app` / `default-project-path`, with a computed `<home>/tug` fallback (DECIDED) {#p01-storage}

**Decision:** The setting is a tugbank string default at domain `dev.tugtool.app`, key `default-project-path`. A resolver returns the explicit value when set, else `hostFacts.home + "/tug"`. The computed fallback is never written back.

**Rationale:**
- tugbank is the one persistence surface (no localStorage, by law); `dev.tugtool.app` already holds app-wide keys (`theme`, `setup-seen`, `initial-project-path`).
- A read-side fallback means existing users (who have `setup-seen: true` and will never see the new setup step) get the feature with zero migration.
- Distinct from `initial-project-path`, which is a derived per-launch hint rewritten by Swift — user preference must not share that key.

**Implications:**
- Two notions exist and both matter: the **explicit** value (`readDefaultProjectPath` → `string | null`) and the **resolved** value (`resolveDefaultProjectPath` → explicit ?? `<home>/tug`). The picker seed uses explicit only ([P02]); Open Quickly and the switcher use resolved.

#### [P02] Picker seed precedence: recents[0] → explicit default → Swift hint → home (DECIDED) {#p02-seed-precedence}

**Decision:** The session picker's one-shot path seed becomes: most-recent project, else the **explicit** default (only when the tugbank key is set), else the Swift `initial-project-path` hint, else `hostFacts.home`.

**Rationale:**
- Continuity beats configuration (user-confirmed [Q01]): daily use almost always wants the project you were just in.
- Using the *explicit* value (not the resolved fallback) preserves the debug-build convenience where the hint seeds the repo source tree — a resolved `~/tug` would otherwise permanently shadow the hint. Post-setup users always have an explicit value ([P07]), so release users get the default as intended.

**Implications:**
- The seed effect in `SessionProjectPickerForm` (`tugdeck/src/components/tugways/cards/session-card.tsx`) gains one tier; its one-shot `didSeedPathRef` discipline is unchanged.

#### [P03] Directory-rooted workspaces via `POST /api/workspace/acquire` / `release` (DECIDED) {#p03-workspace-acquire}

**Decision:** tugcast gains two loopback-gated endpoints: `POST /api/workspace/acquire {path}` → validates + `WorkspaceRegistry::get_or_create` → `{workspace_key, project_dir}`; `POST /api/workspace/release {workspace_key}` → `WorkspaceRegistry::release`. Open Quickly's no-binding case (and later the switcher's arbitrary directories) run on real workspace entries.

**Rationale:**
- User-confirmed [Q02]: full route. The registry already does everything needed — canonical dedup, refcounting, FILETREE feed + FileWatcher per entry, and `route_filetree_query` already routes by `FileTreeQuery.root` to a registered entry.
- The alternative (retargeting the bootstrap feed via [D09]) steals the bootstrap workspace, unaligns its watcher, and breaks the composer's fallback completion.

**Implications:**
- `AgentSupervisor` (the only current owner of the registry from HTTP-reachable state) needs to expose acquire/release for non-session callers — either an accessor to the `Arc<WorkspaceRegistry>` plus the parent `CancellationToken` used for session spawns, or two thin supervisor methods. Follow whichever the existing `do_spawn_session` wiring makes cheaper; keep the held-mutex semantics untouched.
- Response `workspace_key` is the canonical path string — exactly what the frontend's FILETREE `workspaceFilter` and `FileTreeQuery.root` need.
- The FILETREE broadcast path (`ft_response_tx` → router → all clients, JS filters by `workspace_key`) already carries responses for any registered workspace; no router change.

#### [P04] Lazy creation via `POST /api/fs/mkdir` (DECIDED) {#p04-mkdir}

**Decision:** tugcast gains loopback-gated `POST /api/fs/mkdir {path}` doing `std::fs::create_dir_all`. Callers: TugSetup accept, Settings save when the path doesn't exist, and the frontend default-workspace store before its first acquire. Never called at boot.

**Rationale:**
- `get_or_create` correctly rejects nonexistent paths (`InvalidProjectDir`), so creation must precede acquisition.
- Creation belongs in tugcast, not Swift: the deck can run off-host, and tugcast already owns the fs surface (`/api/fs/complete`, `/api/fs/read`, `/api/fs/stat` in `tugrust/crates/tugcast/src/server.rs`).

**Implications:**
- New handler module `fs_mkdir.rs` modeled on `fs_stat.rs` (POST + JSON body + loopback gate). Absolute paths only; reject relative with 400.

#### [P05] The frontend holds the default workspace for the app's lifetime (DECIDED) {#p05-hold-forever}

**Decision:** A small store (`default-workspace-store.ts`) lazily acquires the resolved default directory's workspace on first need (first no-binding Open Quickly, or first switcher pick of the default), caches `{workspaceKey, projectDir}`, and holds the ref until the setting changes — at which point it releases the old key and re-acquires. No per-popup-open acquire/release.

**Rationale:**
- Per-open acquire/release would re-walk the directory on every ⇧⌘O (release at zero refcount tears the entry down).
- The bootstrap workspace already lives process-long; one more long-lived entry is the established shape.
- Frontend release-on-quit is unreliable anyway; tugcast teardown at process exit cleans up.

**Implications:**
- The store is external state → consumed via `useSyncExternalStore` [L02]. It subscribes to the tugbank domain (via `TugbankClient.onDomainChanged`) to notice setting changes.
- Acquire is async; the overlay renders immediately with `EMPTY_PROVIDER` until the store publishes the acquisition (results appear within the acquire+walk round-trip).

#### [P06] Settings card gains a General tab (DECIDED) {#p06-general-tab}

**Decision:** Add tab `{ id: "general", label: "General", icon: "Settings2" }` **first** in the `TABS` array of `tugdeck/src/components/tugways/cards/settings-card.tsx`, with a new `SettingsGeneralBody` (`settings-general-body.tsx`) holding one `TugBox` section "Default Project Directory" with a `TugFileChooser`. Default selected tab stays `sessionCard`.

**Rationale:**
- The only app-wide tab today ("Maker", `SettingsAppBody`) is explicitly one switch on the Swift `maker-mode-bridge` — the wrong idiom for a tugbank-persisted path, and its self-description says so.
- A General tab gives future app-wide settings a home.

**Implications:**
- `SettingsTabId` union, `TABS`, `TAB_CARDS`, and the body dispatch in `SettingsCardContent` each gain one entry; follow the `SettingsTextCardBody` write pattern (optimistic `client.setLocalValue` + PUT — see `tugdeck/src/lib/default-text-card-store.ts`), or the simpler direct `putDefaultProjectPath` since the field is a single string.

#### [P07] TugSetup step "Choose your projects folder", prefilled and always persisted (DECIDED) {#p07-setup-step}

**Decision:** A new `Step` with `key: "project-dir"` in `tugdeck/src/components/tugways/tug-setup.tsx`, placed after `local-ai` and before `open`, in both the first-run and on-demand variants. The step body is a `TugFileChooser` prefilled with the resolved default (`~/tug` on a fresh machine); its confirm CTA calls `POST /api/fs/mkdir` then `putDefaultProjectPath(value)` — always writing an explicit value, then marks the step `done`.

**Rationale:**
- Placing it before `open` means the "Start a Claude Code session" step lands somewhere sensible.
- Always persisting an explicit value makes [P02]'s explicit-only picker tier deterministic for every post-setup user.

**Implications:**
- The `Step.body` slot already carries arbitrary JSX (the local-AI download bar uses it); `tug-setup.css` needs one rule sizing a wide chooser in `.tug-setup-step-body` (currently sized for a 6px progress bar + cancel button).
- Iterate visuals in the design-spike mock `tugdeck/src/components/tugways/cards/gallery-tug-setup.tsx` under HMR.

#### [P08] Switcher = `TugPopupButton` in a new trailing-accessory slot of `TugCompletionPopup` (DECIDED) {#p08-switcher}

**Decision:** `TugCompletionPopup` (`tugdeck/src/components/tugways/tug-completion-popup.tsx`) gains an optional `accessory?: React.ReactNode` prop rendered at the right end of the search bar. The Open Quickly overlay passes a `TugPopupButton` showing the current root's leaf name; its popup lists the candidate roots (frontmost project when bound, the resolved default, then recent projects from `dev.tugtool.dev` / `recent-projects`). Picking one swaps the search stack.

**Rationale:**
- Never hand-roll: `TugPopupButton` + `TugPopupList` are the shipped popup-menu componentry.
- The popup is a popover, not a focus trap ([`tuglaws/focus-language.md`]); a Tab-reachable accessory inside the panel keeps that contract — the field keeps browser focus semantics, Tab moves to the accessory, Escape still dismisses.

**Implications:**
- The overlay's per-open stack construction (`FeedStore` + `FileTreeStore` built in `OpenQuicklyBody`, disposed on unmount) becomes rebuildable on root change: dispose + rebuild against the picked `{workspaceKey, projectDir}`.
- Recents entries need acquisition too: picking a recent calls `acquire` for it (through a generalized acquisition cache in `default-workspace-store.ts`, keyed by path — the "default" is just the distinguished entry).
- Blur handling: opening the accessory's popup must not read as "focus left the field → dismiss." The dismissal logic must treat focus within the whole panel (field + accessory + popup list) as inside.

---

### Deep Dives {#deep-dives}

#### Current Open Quickly wiring (what changes where) {#dd-open-quickly-wiring}

- **Trigger:** macOS menu item `file.openQuickly` (⇧⌘O) built in `tugapp/Sources/AppDelegate.swift`; its selector sends control `"open-quickly"`; `tugdeck/src/action-dispatch.ts` handles it by calling `openOpenQuicklyStore`'s `openOpenQuickly()` (`tugdeck/src/lib/open-quickly-store.ts`). No Swift change in this plan.
- **Enablement:** `tugdeck/src/lib/host-menu-state.ts` computes `openQuickly: frontmostProjectBinding()?.projectDir ? true : false` and ships it to Swift, which consumes it in `validateMenuItem`. The change is frontend-only: always `true`.
- **Root + scope:** `OpenQuicklyBody` (`tugdeck/src/components/chrome/open-quickly-overlay.tsx`) captures `frontmostProjectBinding()` once in a ref; `projectDir` is the search root and absolute-path base, `workspaceKey` filters the FILETREE `FeedStore`. The stack (`FeedStore` on `FeedId.FILETREE` + `FileTreeStore` + `getFileCompletionProvider()`) is built synchronously at first render and disposed on unmount.
- **Fallback insertion point:** when `frontmostProjectBinding()` is null, the body instead reads the default-workspace store ([P05]) via `useSyncExternalStore`; while acquisition is pending it renders with `EMPTY_PROVIDER` (already the no-connection shape), and builds the stack when `{workspaceKey, projectDir}` arrives.
- **Placeholder:** derived from the root's leaf name (`Open Quickly in ${leaf}`) — works unchanged for any root.
- **Queries** flow as `FileTreeQuery { query, root }` frames; `WorkspaceRegistry::route_filetree_query` routes by canonicalized `root` to the registered entry — which acquisition guarantees exists.

#### tugcast acquire/release endpoint shape {#dd-acquire-shape}

**Spec S01: Workspace acquire/release API** {#s01-acquire-api}

- `POST /api/workspace/acquire`, body `{ "path": "<absolute dir>" }`. Loopback-gated. Behavior: reject relative paths (400); `get_or_create(path, cancel)`; on `InvalidProjectDir` return 400 with `{status:"error", reason}`; on success return 200 `{ "workspace_key": "<canonical>", "project_dir": "<as-sent>" }`. Each successful call bumps the refcount (registry semantics) — the frontend cache ([P05]) is responsible for calling acquire once per held root.
- `POST /api/workspace/release`, body `{ "workspace_key": "<canonical>" }`. Loopback-gated. `WorkspaceRegistry::release(key)`; `UnknownKey` → 200 with `{status:"ok", note:"unknown"}` (double-release is a frontend logic error, not a server error worth a 4xx retry loop).
- Handlers live beside the other API handlers registered in `tugrust/crates/tugcast/src/server.rs` (`Router::new().route(...)` table); reach the registry through `State<FeedRouter>` → `router.supervisor` (mirror how `changesets_handler` reaches `sup`). If the supervisor is absent (`None`), return 503 like `changesets_handler` does.
- The `CancellationToken` passed to `get_or_create` must be the same parent token session spawns use, so process shutdown tears the entry down; find it where `AgentSupervisor::spawn_session_worker` calls `get_or_create`.

**Spec S02: mkdir API** {#s02-mkdir-api}

- `POST /api/fs/mkdir`, body `{ "path": "<absolute dir>" }`. Loopback-gated, new module `tugrust/crates/tugcast/src/fs_mkdir.rs` modeled on `fs_stat.rs`. `std::fs::create_dir_all`; success (including already-exists) → 200 `{status:"ok"}`; io error → 400 with the error kind; relative path → 400.

#### Frontend acquisition cache {#dd-acquisition-cache}

New `tugdeck/src/lib/default-workspace-store.ts`:

- `acquireWorkspace(path: string): void` — idempotent per path: `POST /api/fs/mkdir` (only for the resolved-default path; arbitrary recents are not auto-created), then `POST /api/workspace/acquire`, caches `{workspaceKey, projectDir}`, notifies subscribers.
- `getWorkspace(path: string): { workspaceKey: string; projectDir: string } | null` + `subscribe(listener)` — the `useSyncExternalStore` pair [L02].
- Watches `dev.tugtool.app` changes via the `TugbankClient`'s `onDomainChanged` (see `tugdeck/src/lib/use-tugbank-value.ts` for the subscription idiom): when `default-project-path` changes, release the previously-held default key and drop its cache entry (next open re-acquires).
- Failures (acquire 400 — directory vanished) cache a null-with-error so the overlay can degrade to `EMPTY_PROVIDER` instead of retry-looping; a later `acquireWorkspace` call for the same path after the error retries once.

---

### Specification {#specification}

#### Terminology {#terminology}

- **Explicit default** — the string stored at `dev.tugtool.app` / `default-project-path`; may be unset.
- **Resolved default** — explicit default if set, else `hostFacts.home + "/tug"`.
- **Root candidates** (switcher) — ordered: frontmost binding's project (when present), resolved default (deduped if identical), recent projects (`dev.tugtool.dev` / `recent-projects`, max 5, existence-filtered like the picker does via `probeDirExistence`).

#### settings-api surface {#settings-api-surface}

New helpers in `tugdeck/src/settings-api.ts`, placed beside `readSetupSeen`/`putSetupSeen` and following the `readTheme`/`putTheme` string-kind pattern:

- `readDefaultProjectPath(client: TugbankClient): string | null` — explicit value or null.
- `putDefaultProjectPath(path: string): void` — PUT `{kind:"string", value}`.
- `resolveDefaultProjectPath(client: TugbankClient, home: string | null): string | null` — explicit ?? (`home` ? `home + "/tug"` : null).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `default-project-path` setting | external (tugbank) | `useTugbankValue` / `TugbankClient.get` + PUT | [L02] |
| Acquired workspace map | external (module store) | `default-workspace-store` + `useSyncExternalStore` | [L02] |
| Settings field text while editing | local-data | `TugFileChooser` `value`/`onChange` via `useState` | — |
| Setup step status / chooser value | local-data | existing `Step[]` derivation + `useState` in `TugSetup` | — |
| Open Quickly current root (after switcher pick) | local-data | `useState` in `OpenQuicklyBody`; stack rebuilt on change | [L02] for the store reads |
| Switcher popup open/closed | component-internal | `TugPopupButton`'s own mechanics | [L06] |
| Menu enablement `openQuickly` | external (host-menu-state) | existing pipeline, constant `true` | — |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/cards/settings-general-body.tsx` | General tab body: default-project-directory field |
| `tugdeck/src/lib/default-workspace-store.ts` | Acquisition cache ([P05], #dd-acquisition-cache) |
| `tugrust/crates/tugcast/src/fs_mkdir.rs` | `POST /api/fs/mkdir` handler (Spec S02) |
| `tugrust/crates/tugcast/src/workspace_api.rs` | acquire/release handlers (Spec S01) |
| `tests/app-test/at02xx-open-quickly-default-dir.test.ts` | no-binding Open Quickly + switcher coverage (`@covers` required) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `readDefaultProjectPath` / `putDefaultProjectPath` / `resolveDefaultProjectPath` | fn | `tugdeck/src/settings-api.ts` | #settings-api-surface |
| `TABS`, `SettingsTabId`, `SettingsCardContent` | const/type/fn | `tugdeck/src/components/tugways/cards/settings-card.tsx` | +`general` entry [P06] |
| `SettingsGeneralBody` | fn | `settings-general-body.tsx` | new |
| seed `useLayoutEffect` in `SessionProjectPickerForm` | fn | `tugdeck/src/components/tugways/cards/session-card.tsx` | +explicit-default tier [P02] |
| `Step` array construction in `TugSetup` | fn | `tugdeck/src/components/tugways/tug-setup.tsx` | +`project-dir` step [P07] |
| `hostMenuState.openQuickly` | expr | `tugdeck/src/lib/host-menu-state.ts` | → `true` |
| `OpenQuicklyBody` | fn | `tugdeck/src/components/chrome/open-quickly-overlay.tsx` | fallback root + switcher |
| `TugCompletionPopupProps.accessory` | prop | `tugdeck/src/components/tugways/tug-completion-popup.tsx` | [P08] |
| `get_fs_mkdir`-style handler + route | fn | `tugrust/crates/tugcast/src/server.rs` | route registrations |
| registry/cancel accessor | fn | `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` | [P03] implication |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Rust unit/integration** | endpoint behavior, registry semantics | Spec S01/S02; `cargo nextest run` |
| **bun unit** | pure helpers (`resolveDefaultProjectPath`, root-candidate ordering) | `tugdeck/src/lib/__tests__/` |
| **App-test** | real Tug.app end-to-end: menu, popup, commit, settings persistence | selective via `@covers` + `just app-test-changed` |

#### What stays out of tests {#test-non-goals}

- No jsdom render tests or mock-store assertions — banned; UI behavior is covered by app-tests driving the real app.
- No full-corpus app-test sweeps; selection is derived from the diff.
- Setup-flow first-run UX on a factory-fresh machine — covered manually via the gallery mock and the VM lab, not app-tests (the harness suppresses setup via `suppress-setup`).

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Commits land on the dash worktree / per the session's landing flow — the implement skill's normal rules. Commit messages follow the repo style `area(default-directory-bringup): summary`; never add AI attribution.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | settings-api helpers + resolver | done | `16f17697b` |
| #step-2 | Settings card General tab | done | `72d105c1a` |
| #step-3 | Picker seed-chain insertion | done | `0e50b9d79` |
| #step-4 | tugcast `POST /api/fs/mkdir` | done | `dacc67905` |
| #step-5 | TugSetup project-dir step | done | `9e423c7da` |
| #step-6 | tugcast workspace acquire/release | done | `697c29c99` |
| #step-7 | Open Quickly unconditional + fallback root | done | `ed945c096` |
| #step-8 | Integration checkpoint: empty-deck Open Quickly | done | `53256a6d4` |
| #step-9 | `TugCompletionPopup` accessory slot | done | `924a5ebc1` |
| #step-10 | In-bar directory switcher | done | `64d3a9862` |
| #step-11 | Final integration checkpoint | done | `391f6aee9` (verification only) |

#### Step 1: settings-api helpers + resolver {#step-1}

**Commit:** `tugdeck(default-directory-bringup): default-project-path helpers in settings-api`

**References:** [P01] Storage, (#settings-api-surface)

**Artifacts:**
- `readDefaultProjectPath`, `putDefaultProjectPath`, `resolveDefaultProjectPath` in `tugdeck/src/settings-api.ts`.

**Tasks:**
- [ ] Implement the three helpers per #settings-api-surface, beside `readSetupSeen`/`putSetupSeen`, following the `readTheme`/`putTheme` string-kind idiom (synchronous cache read via `TugbankClient.get`, fire-and-forget PUT).
- [ ] Doc-comment the explicit-vs-resolved distinction ([P01]) so later consumers pick the right one.

**Tests:**
- [ ] bun unit tests for `resolveDefaultProjectPath` (explicit set / unset+home / unset+no-home) in `tugdeck/src/lib/__tests__/` or the settings-api test home if one exists.

**Checkpoint:**
- [ ] `cd tugdeck && bun test` (scoped to the new test file) and `bunx vite build`.

---

#### Step 2: Settings card General tab {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(default-directory-bringup): Settings General tab with default project directory field [L02][L06]`

**References:** [P06] General tab, [P01] Storage, (#state-zone-mapping)

**Artifacts:**
- `settings-general-body.tsx`; `general` entries in `TABS`/`SettingsTabId`/`TAB_CARDS`/body dispatch of `settings-card.tsx`.

**Tasks:**
- [ ] Add the tab per [P06]; body = one `TugBox` section titled "Default Project Directory" containing a `TugFileChooser` (`kind: "directory"`, `showBrowse` default) whose value seeds from `readDefaultProjectPath` (shown resolved as placeholder when unset) and commits via `putDefaultProjectPath`.
- [ ] On commit of a nonexistent path, show a passive "will be created on first use" note (probe with `probeDirExistence` from `tugdeck/src/lib/dir-existence.ts`); never block the save.
- [ ] Read `tuglaws/component-authoring.md` conventions for the body (`data-slot`, tokens); live tugbank read via `useTugbankValue("dev.tugtool.app", "default-project-path", …)`.

**Tests:**
- [ ] App-test: open Settings (⌘,), select General, type a temp path, commit, assert the tugbank default via `GET /api/defaults/dev.tugtool.app/default-project-path`. Carry `@covers` for `settings-card.tsx` + `settings-general-body.tsx` (may fold into the #step-8 test file if one file covering the feature is cleaner).

**Checkpoint:**
- [ ] `bunx vite build`; `just app-test-changed`.

---

#### Step 3: Picker seed-chain insertion {#step-3}

**Depends on:** #step-1

**Commit:** `tugdeck(default-directory-bringup): picker path seed prefers explicit default over launch hint [P02]`

**References:** [P02] Seed precedence, [Q01], (#context)

**Artifacts:**
- Updated one-shot seed `useLayoutEffect` in `SessionProjectPickerForm` (`session-card.tsx`).

**Tasks:**
- [ ] Insert the explicit-default tier between `recents[0]` and `initialProjectPath`: `recents[0]` → `readDefaultProjectPath(client)` → `initialProjectPath` → `hostFacts.home`. Keep the `didSeedPathRef` one-shot discipline and the empty-path guard exactly as-is.
- [ ] Update the effect's comment to name all four tiers.

**Tests:**
- [ ] App-test: with `recent-projects` cleared and `default-project-path` PUT to a temp dir, open a new session card and assert the picker path field shows the default. (`@covers` `session-card.tsx`.)

**Checkpoint:**
- [ ] `bunx vite build`; `just app-test-changed`.

---

#### Step 4: tugcast `POST /api/fs/mkdir` {#step-4}

**Commit:** `tugcast(default-directory-bringup): POST /api/fs/mkdir for lazy default-directory creation`

**References:** [P04] mkdir, Spec S02, (#dd-acquire-shape)

**Artifacts:**
- `tugrust/crates/tugcast/src/fs_mkdir.rs`; route registration in `server.rs`.

**Tasks:**
- [ ] Implement per Spec S02, modeled on `fs_stat.rs` (POST body, loopback gate, error mapping).

**Tests:**
- [ ] Rust integration tests beside the existing `/api/fs/stat` tests: creates nested dirs; already-exists is ok; relative path 400; non-loopback 403.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` (zero warnings).

---

#### Step 5: TugSetup project-dir step {#step-5}

**Depends on:** #step-1, #step-4

**Commit:** `tugdeck(default-directory-bringup): setup step to choose the projects folder [P07]`

**References:** [P07] Setup step, [P01] Storage, [P04] mkdir, (#state-zone-mapping)

**Artifacts:**
- `project-dir` step in `tug-setup.tsx` (+ copy in `tug-setup-copy.ts` if that's where its strings belong); `.tug-setup-step-body` sizing rule in `tug-setup.css`; gallery mock row in `gallery-tug-setup.tsx`.

**Tasks:**
- [ ] Add the step per [P07]: after `local-ai`, before `open`, present in first-run and on-demand variants; body = `TugFileChooser` prefilled with the resolved default; confirm CTA → `POST /api/fs/mkdir` → `putDefaultProjectPath` → step `done`. A failed mkdir surfaces the step's `error` status with Retry, matching the install step's shape.
- [ ] Extend the gallery mock so the row is iterable under HMR.

**Tests:**
- [ ] Manual pass through the on-demand flow (Tug menu ▸ Set Up Tug…) in the debug app; assert the tugbank key and the created directory.

**Checkpoint:**
- [ ] `bunx vite build`; `just app-test-changed` (existing setup-adjacent tests still pass).

---

#### Step 6: tugcast workspace acquire/release {#step-6}

**Commit:** `tugcast(default-directory-bringup): workspace acquire/release HTTP API [P03]`

**References:** [P03] Workspace acquire, [Q02], Spec S01, (#dd-acquire-shape)

**Artifacts:**
- `tugrust/crates/tugcast/src/workspace_api.rs`; routes in `server.rs`; registry/cancel accessor on `AgentSupervisor`.

**Tasks:**
- [ ] Implement per Spec S01. Reach the registry via `State<FeedRouter>` → `router.supervisor` (503 when `None`, mirroring `changesets_handler`); pass the same parent `CancellationToken` the session-spawn path hands to `get_or_create`.
- [ ] Confirm acquired entries appear in `WorkspaceRegistry::project_dirs()` and therefore the changeset aggregate — decide with a test whether that's acceptable (it should be: an open directory is an open project) and note the outcome in the commit message.

**Tests:**
- [ ] Rust integration tests: acquire returns canonical key; double-acquire same dir dedups (same key) and bumps refcount; acquire missing dir 400; release to zero tears down; release unknown key 200-with-note; non-loopback 403.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`.

---

#### Step 7: Open Quickly unconditional + fallback root {#step-7}

**Depends on:** #step-1, #step-4, #step-6

**Commit:** `tugdeck(default-directory-bringup): Open Quickly always available, default-directory fallback [L02]`

**References:** [P05] Hold forever, [P03] Workspace acquire, [Q03], (#dd-open-quickly-wiring, #dd-acquisition-cache)

**Artifacts:**
- `tugdeck/src/lib/default-workspace-store.ts`; updated `host-menu-state.ts` (`openQuickly: true`); updated `OpenQuicklyBody` fallback path.

**Tasks:**
- [ ] Implement `default-workspace-store.ts` per #dd-acquisition-cache (mkdir only for the resolved default; acquire; cache; release + re-acquire on setting change; error caching).
- [ ] `host-menu-state.ts`: `openQuickly: true` unconditionally; update its comment.
- [ ] `OpenQuicklyBody`: when `frontmostProjectBinding()` is null, trigger `acquireWorkspace(resolvedDefault)` and read the store via `useSyncExternalStore`; build the stack when the acquisition lands; `EMPTY_PROVIDER` until then. Placeholder derives from whichever root is active.
- [ ] Resolve [Q03]: read `tugdeck/src/lib/open-file-in-card.ts` and fix any empty-deck assumption so commit creates the card cleanly.

**Tests:**
- [ ] bun unit test for the store's path-keyed idempotence and setting-change release (pure logic around mocked fetch is acceptable here only if it drives the real store code; otherwise cover behavior in the #step-8 app-test and keep this to the pure candidate-ordering helpers).

**Checkpoint:**
- [ ] `bunx vite build`; `just app-test-changed` (at0213 must still pass — bound-card behavior unchanged).

---

#### Step 8: Integration checkpoint — empty-deck Open Quickly {#step-8}

**Depends on:** #step-7

**Commit:** `N/A (verification only — test file lands here if not already committed)` → if the new app-test file lands in this step: `tests(default-directory-bringup): empty-deck Open Quickly app-test`

**References:** [P05], [Q03], (#success-criteria)

**Tasks:**
- [ ] App-test `at02xx-open-quickly-default-dir.test.ts` (`@covers` the overlay, `default-workspace-store.ts`, `host-menu-state.ts`): PUT a temp default dir with known files; with zero cards open, send control `"open-quickly"`; assert placeholder leaf, type a filename, assert results, commit, assert a card opened on the file.
- [ ] Assert menu-state flag: `openQuickly` true with no cards (via the host-menu-state snapshot or dev log, following at0213's technique).

**Checkpoint:**
- [ ] `just app-test tests/app-test/at02xx-open-quickly-default-dir.test.ts tests/app-test/at0213-open-quickly.test.ts`.

---

#### Step 9: `TugCompletionPopup` accessory slot {#step-9}

**Depends on:** #step-8

**Commit:** `tugdeck(default-directory-bringup): trailing accessory slot in TugCompletionPopup [P08][L06]`

**References:** [P08] Switcher, Risk table (focus contract), (#state-zone-mapping)

**Artifacts:**
- `accessory?: React.ReactNode` prop + bar-layout CSS in `tug-completion-popup.tsx` / `.css`.

**Tasks:**
- [ ] Render the accessory at the right end of the search bar; Tab order: field → accessory (natural DOM order — no hand-rolled focus management).
- [ ] Fix dismissal logic so focus moving to the accessory (or its popup list) does not count as leaving the popup; Escape still dismisses from anywhere inside.
- [ ] No behavior change when the prop is absent.

**Tests:**
- [ ] Covered by #step-10's app-test (Tab reach + no-dismiss); at0213 re-run guards the no-accessory path.

**Checkpoint:**
- [ ] `bunx vite build`; `just app-test-changed`.

---

#### Step 10: In-bar directory switcher {#step-10}

**Depends on:** #step-9

**Commit:** `tugdeck(default-directory-bringup): Open Quickly directory switcher [P08][L02]`

**References:** [P08] Switcher, [P05] Hold forever, Risk R01, (#terminology, #dd-acquisition-cache)

**Artifacts:**
- Switcher control + root-candidate assembly + stack-rebuild-on-pick in `open-quickly-overlay.tsx`; acquisition-cache generalization for recent paths.

**Tasks:**
- [ ] Build the candidate list once at popup open per #terminology and Risk R01 (frontmost binding, resolved default deduped, recents from `dev.tugtool.dev` / `recent-projects` existence-filtered via `probeDirExistence`).
- [ ] Accessory = `TugPopupButton` labeled with the active root's leaf; picking a candidate: for the frontmost binding use its existing `workspaceKey`; otherwise `acquireWorkspace(path)` (no mkdir for recents) and swap — dispose the old `FeedStore`/`FileTreeStore`, build the new stack, keep the typed query, refresh the placeholder.
- [ ] Active root is `useState` in `OpenQuicklyBody`; the ref-captured binding remains the initial value.

**Tests:**
- [ ] Extend the #step-8 app-test: open with a bound card, Tab to the switcher, pick the default dir, assert the placeholder and results swap; pick back; assert Escape and outside-click dismissal still work with the switcher popup open.

**Checkpoint:**
- [ ] `bunx vite build`; `just app-test-changed`.

---

#### Step 11: Final integration checkpoint {#step-11}

**Depends on:** #step-2, #step-3, #step-5, #step-10

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk every success criterion in #success-criteria against the built app; run the on-demand setup flow once end-to-end on the dev machine.
- [ ] Confirm the Step Status Ledger is fully `done` with commit hashes recorded.

**Tests:**
- [ ] Full changed-selection run: `just app-test-changed`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`; `bunx vite build`; `just app-test-changed`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A user-owned default project directory, set during setup or in Settings ▸ General, that makes Open Quickly unconditionally available (falling back to it when no card is bound) with an in-bar directory switcher, and that seeds the session picker when recents are empty.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All #success-criteria verified (per-criterion methods listed there).
- [ ] `cargo nextest run` clean; `bunx vite build` clean; changed-selection app-tests green including at0213.
- [ ] No new tuglaws violations; commits name the laws touched.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Text-card save/new-file `NSOpenPanel` initial directory from the resolved default.
- [ ] Picker Browse… (`pickPath`) initial directory from the resolved default when the field is empty.
- [ ] Retire the Swift `initial-project-path` hint (or narrow it to debug builds explicitly) once explicit defaults are ubiquitous.
- [ ] Consider surfacing the default directory in the switcher for other quick affordances (`!find`, future "New…" flows).

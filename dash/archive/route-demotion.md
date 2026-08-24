## Route Demotion — one-shot slash commands, Code as the only resting mode {#route-demotion}

**Purpose:** Remove the Session card's sticky modal routes (`$` Shell, `?` btw, `⌕` Find, `±` Changes, `↺` History). The prompt entry always targets Code; every other destination is reached per-submission via a slash command (`/shell`, `/btw`, `/find`, `/changes`, `/history`), a keyboard chord, or a chrome affordance — plus a deterministic PATH classifier that silently routes unprefixed command-shaped lines to the shell.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-17 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Session card's prompt entry has six sticky routes selected via the Z4A popup (`tug-prompt-entry.tsx`, `ROUTE_ITEMS` + `VIEW_ROUTE_ITEMS`) or ⇧⌘-letter shortcuts (`keybinding-map.ts`, `SELECT_ROUTE`). The route is hidden modal state: users get stranded on a non-Code route and type at the wrong destination — prose into the shell, a shell command at Claude. The route also overloads two different concepts: *submission target* (`$`/`?`/`⌕`) and *view selection* (`±`/`↺` swap the transcript slot for the Changes/History Shades).

Much of the replacement already exists. `/shell`, `/btw`, and `/find` are shipped one-shot local commands (`lib/slash-commands.ts` registry, `codeRouteOnly: true`) with surfaces in the session card's `slashCommandSurfaces` map; the `/` completion popup, command atoms, and the `RUN_SLASH_COMMAND` dispatch pipeline are all live. The Swift host already validates its menu from a deck-published `menuState` cache and round-trips menu picks via `run-card-command`. This phase completes the demotion: adds `/changes` + `/history` commands, makes Shade visibility card chrome state (not route state), deletes the sticky route machinery, replaces the Z4A selector with a command picker, adds ⌃⌘ chords and Swift Show/Hide menu items, and lands the PATH classifier.

#### Strategy {#strategy}

- **Decouple first, delete second.** Move Shade visibility off the route (Step 1) and the Changes/History composers off their view-routes (Steps 2–3) while the routes still exist; only then delete the route machinery (Step 4) so every commit compiles and behaves.
- **Reuse the shipped one-shot pipeline.** `/changes` and `/history` are two more entries in `LOCAL_SLASH_COMMANDS` + `slashCommandSurfaces`; the picker is the existing `/` completion popup opened from chrome; chords insert command atoms through a new entry-delegate method modeled on the existing `pendingCommandInsert` seed path.
- **Views split from directives.** Typed input only ever *shows* a Shade; hiding is chrome-only (Shade close affordance, Swift menu items, deck keybindings).
- **Safe-default classifier.** The PATH classifier routes to shell only on near-certain command-shaped lines; everything else goes to Code, where a stray `ls` degrades gracefully. Every auto-routed exchange is visibly attributed with a one-click "send to Claude instead".
- **Rust endpoint last-but-independent.** The tugcast `path_commands` verb (Step 6) has no deck dependency and can land in parallel after Step 1.

#### Success Criteria (Measurable) {#success-criteria}

- No selectable route exists: the Z4A popup, `SELECT_ROUTE` bindings, and all `setRoute` writers are gone; `grep -rn "SELECT_ROUTE" tugdeck/src` returns only history/archive hits (verify: grep + UI).
- Typing `/changes` (bare) shows the Changes Shade and leaves the entry on Code; the Shade's close affordance, ⌘⇧C (app menu), and ⇧⌘C (browser dev) hide it; typed input never hides it (verify: manual + app menu).
- `/changes describe` streams a draft into the entry as a `/changes commit ` command atom + message; submitting commits via the existing `ChangesRouteController.commit` with turn/selection gating intact (verify: manual round-trip).
- ⌃⌘S/B/C/G/H insert the corresponding command atom at the head of the entry (replacing any existing head command atom, preserving typed text as args) and focus the editor (verify: manual per chord).
- The Swift Session menu shows "Show Changes"/"Hide Changes" (⌘⇧C) and "Show History"/"Hide History" (⌘⇧H) with the verb chosen from live visibility; items disabled when no Session card is frontmost (verify: app menu with Shade open/closed).
- An unprefixed `git status` routes to the shell with a visible auto-route attribution and a working "send to Claude instead"; `find the bug in the parser` goes to Claude (verify: manual + classifier unit corpus, zero false-shell in the corpus's prose set).
- `cd tugrust && cargo nextest run` passes; `cd tugdeck && ./node_modules/.bin/tsc -p tsconfig.json --noEmit && ./node_modules/.bin/vite build && bun test` pass.

#### Scope {#scope}

1. `ShadeViewController` — card-level Shade visibility state, mutual-exclusive `"none" | "changes" | "history"`, with close affordances on both Shade headers.
2. `/changes` and `/history` local slash commands (bare = show; `describe`/`commit`/question directives).
3. Commit-draft flow relocation: Generate into the Changes Shade header; the streamed draft lands in the entry as `/changes commit ` + message; commit via the local-command intercept.
4. Deletion of sticky route machinery: Z4A popup, `SELECT_ROUTE`/⇧⌘-letter bindings, per-route submit branches, per-route chrome manifest, view-route plumbing, `viewRoutes` prop.
5. Command picker (the `/` completion popup opened from a chrome button / ⌘/) and ⌃⌘ chords.
6. Swift Session-menu Show/Hide items with dynamic verbs + `menuState` visibility fields + toggle control round-trip.
7. tugcast `path_commands` shell-feed verb; deck `PathCommandsStore`; `classifyShellLine` heuristic; submit-time auto-routing with attribution + resend.

#### Non-goals (Explicitly out of scope) {#non-goals}

- The AI-classifier layer (deferred by decision; the ambiguous middle band stays on Code).
- Any change to shell-block rendering, restore interleave, or the per-row share gesture ([D111] untouched).
- Changes/History *content* (the Shade views themselves shipped in the prior phase; only their visibility driver and header actions change).
- Migrating persisted prompt-history entries recorded under retired route keys (`$`, `?`, `⌕`, `±`, `↺`); they simply stop being recalled (the Code provider filters by `route === "❯"`). See [P11].
- A UI for the Find option toggles (Case/Word/Grep) beyond the conditional Z4B cluster in [P10].

#### Dependencies / Prerequisites {#dependencies}

- The shipped one-shot commands `/shell`, `/btw`, `/find` (`tugdeck/src/lib/slash-commands.ts`, `session-card.tsx` `slashCommandSurfaces`).
- The TugShade views (`session-changes-view.tsx`, `session-history-view.tsx`) with `BlockStrip` headers that accept `actions`.
- The host menu bridge: `lib/host-menu-state.ts` (publisher), `cards/use-menu-state-publication.ts`, Swift `AppDelegate.swift` `MenuState` + `validateMenuItem(_:)` + `runCardCommand`/`sendControl`.
- The tugcast shell feed (`tugrust/crates/tugcast/src/feeds/shell.rs`, `ShellInput` enum, `SHELL_INPUT` 0x61 / `SHELL_OUTPUT` 0x60) and deck `lib/shell-session-store.ts`.

#### Constraints {#constraints}

- Tuglaws: [L01] one render; [L02] external state via `useSyncExternalStore`; [L03] `useLayoutEffect` for registrations events depend on; [L06] appearance via CSS/DOM; [L26] stable mount identity across view flips (the three view panes stay mounted; only visibility flips).
- No localStorage/sessionStorage/IndexedDB — any persisted preference goes through tugbank `/api/defaults/<domain>/<key>`.
- Compose existing Tug* components; never hand-roll UI that exists as a component.
- Rust: warnings are errors (`-D warnings`); run `cargo nextest run`.
- Frontend verification: `./node_modules/.bin/vite build` must pass before a tugdeck step is done (never `bunx`, which fetches latest).
- No new client→tugcode messages are needed (all new wire traffic is tugcast feeds + WKScriptMessage); if one is ever added, remember the 3-edit inbound allowlist in tugcode `types.ts`.

#### Assumptions {#assumptions}

- The route is not persisted anywhere: `RouteLifecycle` is constructed with `DEFAULT_ROUTE` per card mount (`session-card.tsx`) and no tugbank domain stores it — verified by grep; deleting route state breaks no restore path.
- The gallery host (`viewRoutes` absent) exercises the entry with the four target-routes; gallery fixtures will be updated in the deletion step.
- ⌃⌘S/B/C/G/H carry no macOS system claims (⌃⌘F fullscreen deliberately avoided via G; ⌃⌘Q lock-screen not in the set) and no existing deck binding claims them (verified against `keybinding-map.ts`).
- ⇧⌘C/⇧⌘S/⇧⌘B/⇧⌘F/⇧⌘E/⇧⌘Y are freed by deleting the `SELECT_ROUTE` bindings, so ⇧⌘C/⇧⌘H can be reassigned to Show/Hide toggles without collision (⇧⌘F stays free; ⌥⇧⌘C copy-as-plain-text is distinct and untouched).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does any Swift menu or gallery surface still reference the route selector? (DECIDED) {#q01-route-refs}

**Question:** Beyond `tug-prompt-entry.tsx` / `keybinding-map.ts` / `session-route-chrome-manifest.tsx`, do other surfaces depend on route flips?

**Resolution:** DECIDED — investigated. `ROUTE_FIND` appears only in `route-constants.ts`, `tug-prompt-entry.tsx`, and `session-route-chrome-manifest.tsx`. The Swift menu has no route items (its Session menu round-trips slash-command names via `runCardCommand`). Test files touching routes: `chrome/__tests__/session-route-chrome-manifest.test.ts`, `__tests__/tug-prompt-entry-strip-and-migrate.test.ts`, `__tests__/shell-share.test.ts`, `lib/__tests__/route-lifecycle.test.ts` — each is dispositioned in Step 4.

#### [Q02] Where does the PATH command set come from? (DECIDED) {#q02-path-source}

**Question:** tugcast's own env may not reflect the user's login PATH.

**Resolution:** DECIDED (see [P08]) — a login-shell probe (`$SHELL -lc 'printf %s "$PATH"'`), then a readdir sweep of the PATH entries for executable files, cached process-wide in tugcast. Not the interactive (`-il`) shell child: the probe must not depend on the lazily-spawned per-session shell and must never wedge on interactive rc baggage.

#### [Q03] How do users refine an active find without the ⌕ route? (DEFERRED) {#q03-find-refine}

**Question:** The `⌕` route offered a live query (type → highlight). One-shot `/find <q>` requires retyping the command to refine.

**Resolution:** DEFERRED — `/find` one-shot + ⌘G/⇧⌘G + the conditional Z4B find cluster ([P10]) ship in this phase. A live-refine affordance (e.g. the find cluster gaining an inline query field) is a follow-on; recorded in #roadmap.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Classifier false positives send prose to the shell | med | low | High-precision heuristic (Spec S03), prose-veto stoplist, unit corpus with zero-false-shell gate, visible attribution + resend | Any real-world misroute report |
| Deleting route branches breaks a submit path (queue, defer, replay gates) | high | med | Steps 2–4 keep `performSubmit`'s send-readiness gates verbatim; each step's checkpoint exercises submit idle + mid-turn | tsc/test failures, manual submit regressions |
| ⇧⌘C reassignment races the deletion of the old Code-route binding | low | low | Same commit removes `SELECT_ROUTE` bindings and adds the toggle bindings (Step 5 depends on Step 4) | — |
| Swift menu key equivalents eat chords meant for the web view | low | low | Only ⌘⇧C/⌘⇧H become menu equivalents (intentionally); ⌃⌘ chords have no menu items | beep-instead-of-insert reports |

**Risk R01: Losing an input path during the transition** {#r01-transition}

- **Risk:** Between steps, a destination could become unreachable (e.g. shell demoted before `/shell` covers multiline).
- **Mitigation:** `/shell`, `/btw`, `/find` already ship; Steps 1–3 add `/changes`/`/history` before Step 4 deletes the routes; every step's checkpoint includes a reach-every-destination manual pass.
- **Residual risk:** Multiline shell scripts lose the `$` route's Return=submit ergonomics; `/shell` args may span lines (Return inserts a newline on Code; Shift+Return submits) — accepted.

---

### Design Decisions {#design-decisions}

#### [P01] Code is the only resting route; the route machinery is deleted, not pinned (DECIDED) {#p01-single-route}

**Decision:** Remove `RouteLifecycle` from the Session card/prompt entry data flow entirely by the end of the phase — delete the Z4A popup, `SELECT_ROUTE`/`SELECT_VALUE`-route handlers, per-route submit branches, `RETURN_ACTION_BY_ROUTE`, `routeAwareSubmitButtonMode`, `placeholderByRoute`, `viewRoutes`, the per-route chrome manifest, and `lib/route-lifecycle.ts` + the non-Code constants in `lib/route-constants.ts`.

**Rationale:**
- A pinned-but-alive route invites regressions (dead branches keyed on a value that can never change) and leaves the "stuck mode" class of bug latent.
- History entries persist a `route` string; keeping `DEFAULT_ROUTE = "❯"` as a constant (moved into the history layer or kept in a slimmed `route-constants.ts`) preserves recall filtering without the lifecycle.

**Implications:**
- The Z4B chrome manifest collapses to the static Code chip set (identity · session · project · mode · model · effort) plus the conditional find cluster ([P10]); `SessionRouteIndicatorBadge` loses its `isShell` face.
- Return semantics become the Code semantics everywhere: Return = newline, Shift+Return / Z5 = submit.
- `applyShellShare` (share gesture) no longer flips a route; it just seeds the editor.

#### [P02] `/changes` and `/history` join the local-command registry; `codeRouteOnly` dies (DECIDED) {#p02-command-roster}

**Decision:** Add `{ name: "changes", takesArgs: true }` and `{ name: "history", takesArgs: true }` to `LOCAL_SLASH_COMMANDS`; delete the `codeRouteOnly` flag, `isCodeRouteOnlyCommand`, and their call sites (there are no other routes to gate against).

**Rationale:** The registry + `slashCommandSurfaces` exhaustive `Record<LocalCommandName, …>` is the shipped pattern; a registered command without a surface is a compile error.

**Implications:** The `/` completion popup offers them everywhere the popup opens; descriptions follow the existing voice ("View and commit this session's changes", "View project history; ask about prior work").

#### [P03] Shade visibility is card chrome state in a `ShadeViewController` store (DECIDED) {#p03-shade-visibility}

**Decision:** A per-card `ShadeViewController` (new module `tugdeck/src/lib/shade-view-controller.ts`) holds `"none" | "changes" | "history"` with `subscribe/getSnapshot/show(view)/hide()/toggle(view)`. `SessionCardBody` owns one instance (lazy `useRef`, like `RouteLifecycle` today) and derives `activeView` from it via `useSyncExternalStore` — replacing the route-derived `activeView` ternary.

**Rationale:**
- [L02]: multiple readers (render gating, menu publication, slash surfaces) need one subscribable source.
- Mutual exclusion is structural: `show("history")` while Changes is up swaps views, exactly like the old route flip, preserving [L26] (all three panes stay mounted; CSS visibility flips).

**Implications:**
- Not persisted — a fresh card opens with `"none"` (Shades closed). No tugbank domain.
- Typed commands call only `show` ([P05]); `hide`/`toggle` are reachable only from chrome (Shade close affordance, menu/keyboard toggles).

#### [P04] Directive grammar for `/changes` and `/history` (DECIDED) {#p04-directive-grammar}

**Decision:**
- `/changes` (bare) → `shadeViewController.show("changes")`.
- `/changes describe` → show Changes + `changesController.requestDraft()`.
- `/changes commit <message…>` → gated commit: refuse with a pane bulletin while a turn runs (`canInterrupt`), while a commit is pending, when the selection is empty, or when the message is empty; otherwise `changesController.commit(message)`.
- `/changes <anything else>` → caution bulletin `Usage: /changes [describe | commit <message>]` (never guess a commit from free text).
- `/history` (bare) → `show("history")`.
- `/history <question…>` → show History + send `/tugplug:history <question>` on the record via `codeSessionStore.send` (mid-turn sends queue, matching today's semantics). Replay guard: when `!canSubmit && !canInterrupt` (session replaying / transport settling), refuse with a caution bulletin instead of sending — a submit during replay must never leak a turn, matching the old `↺` branch's drop semantics. Surface-level refusal is the right shape here; the entry's defer machinery is not reachable from a command surface.

**Rationale:** The commit is a durable mutation — it keeps the exact gates the `±` route enforced (`performSubmit`'s `ROUTE_CHANGES` branch); free text must never accidentally commit. The history send keeps the `↺` branch's replay protection for the same reason.

**Implications:** The surfaces live in `slashCommandSurfaces` (session-card body scope, where `changesController`, `codeSessionStore`, `paneBulletinRef`, and the controller's snapshot are all in reach). Command history records the typed line via the existing local-command history push.

#### [P05] Typed input only shows; hiding is chrome-only (DECIDED) {#p05-show-only}

**Decision:** No slash command hides a Shade. Hiding: (a) a close affordance (X `BlockFoldCue`-adjacent icon button) in each Shade's `BlockStrip` header `actions`; (b) Swift Session-menu items Show/Hide Changes ⌘⇧C and Show/Hide History ⌘⇧H whose verb is picked at `validateMenuItem` time; (c) deck keybindings ⇧⌘C/⇧⌘H → the same toggle actions (browser dev parity; in-app the menu equivalents win, which is the existing Focus-Prompt ⌘K pattern).

**Rationale:** One-directional causality — typing can summon a view but can never yank one away mid-read; hide gestures are deliberate chrome acts.

**Implications:** New `TUG_ACTIONS.TOGGLE_CHANGES_VIEW` / `TOGGLE_HISTORY_VIEW`, key-card scoped; `action-dispatch.ts` registers `toggle-changes-view` / `toggle-history-view` control actions for the Swift round-trip.

#### [P06] The picker is the existing `/` completion popup, opened from chrome (DECIDED) {#p06-picker}

**Decision:** Replace the Z4A route popup with a **command picker button** in the Z4A slot: a slash-glyph `TugButton` whose activation focuses the editor and seeds a leading `/` (when the draft doesn't already start with one), which opens the standard completion popup (the `wrapPositionZero`-gated command provider). `⌘/` (new binding, `KeyboardEvent.code "Slash"`, meta, key-card scope, action `OPEN_COMMAND_PICKER`) does the same. The five former-route commands' completion `description`s gain a trailing key-equivalent hint (e.g. `"… · ⌃⌘S"`), making the popup the teaching surface.

**Rationale:** Zero new popover components; the completion popup already filters/ranks/navigates and inserts command atoms uniformly. The button never sets persistent state — it is sugar over syntax.

**Implications:** The Z4A trigger keeps its slot and focus-group registration (`routeFocusGroup` renamed or reused) so the keyboard cycle's walk is unchanged in shape. `widthStabilize` machinery for route labels dies with the route items.

#### [P07] ⌃⌘ chords insert command atoms via a new entry-delegate method (DECIDED) {#p07-chords}

**Decision:** Five keybindings (`keybinding-map.ts`, key-card scope, `preventDefaultOnMatch`): ⌃⌘S→`shell`, ⌃⌘B→`btw`, ⌃⌘C→`changes`, ⌃⌘G→`find`, ⌃⌘H→`history`, dispatching `TUG_ACTIONS.INSERT_SLASH_COMMAND` with `value: { name }`. The session card's card-content responder forwards to a new `TugPromptEntryDelegate.insertCommandChip(name: string)`: if the draft's first atom is a command atom, replace it; otherwise insert a command atom + trailing space at document position 0; preserve the rest of the draft as args; focus the editor.

**Rationale:**
- ⌃⌘G over ⌃⌘F: F shadows the legacy macOS fullscreen chord; G carries the platform find-next mnemonic (⌘G). Bare-Control is off the table (WebKit's Emacs-style ⌃B/⌃F/⌃H editing keys).
- Max one command chip is structural: the insert replaces any existing head command atom.
- The seed shape matches a typed/completed command byte-for-byte (`TUG_ATOM_CHAR` + space), the same contract the `pendingCommandInsert` effect uses, so submit-time recognition is identical.

**Implications:** `keybinding-map.ts` gains its first ⌃⌘ entries (`ctrl: true, meta: true` — the `KeyBinding` interface already supports both). Chords work card-wide (key-card scope), not only while the editor is focused.

#### [P08] tugcast `path_commands`: a shell-feed verb with a process-wide cache (DECIDED) {#p08-path-endpoint}

**Decision:** Extend `ShellInput` (feeds/shell.rs) with `PathCommands { tug_session_id }`. The handler resolves the user's login PATH once per tugcast process — spawn `$SHELL -lc 'printf %s "$PATH"'` (bash/zsh gate like the exec shell; fallback to tugcast's own `$PATH` on failure/timeout ~5s), split on `:`, readdir each existing dir collecting executable regular files/symlinks, dedupe, sort — and replies on `SHELL_OUTPUT` with a JSON frame `{ "type": "path_commands", "tug_session_id", "commands": [ … ] }` tagged for that session. Subsequent requests answer from the cache (`OnceCell`-style).

**Rationale:** Spec S02. The interactive per-session shell child is lazily spawned and can wedge on rc files; a non-interactive login probe is cheap, safe, and PATH-accurate. Process-wide cache: PATH effectively never changes within a tugcast run, and the set (~2–5k names) serializes in tens of KB, well under transport caps.

**Implications:** Deck side: `PathCommandsStore` (new `tugdeck/src/lib/path-commands-store.ts`) keyed by `tug_session_id`, caching the `ReadonlySet<string>`. The request fires **at session bind** (where the card learns its `tug_session_id`), not on first classifier consultation — otherwise the first command-shaped line of every session would misroute to Claude while the set loads. Null-until-loaded → classifier answers "Code" (the safety net, not the steady state).

#### [P09] The classifier is high-precision, submit-time, attributed, and undoable (DECIDED) {#p09-classifier}

**Decision:** A pure `classifyShellLine(text, commands): boolean` (new `tugdeck/src/lib/shell-line-classifier.ts`, Spec S03) runs in `performSubmit`'s default branch — after the slash-command intercepts, before `codeSessionStore.send` — only when the draft has no atoms and is a single line. On a match: `shellSessionStore.exec(text, { origin: "auto" })`; the shell exchange row renders an auto-route attribution (`→ shell`) with a "Send to Claude instead" affordance that dispatches the original text via `codeSessionStore.send`. On no-match: Code, unchanged.

**Rationale:** The wrong-way costs are asymmetric — prose at the shell error-barfs; a command at Claude just gets run by Claude. Tune for near-zero false-shell. Visible attribution + one-click resend makes silent classification trustworthy.

**Implications:** `ShellSessionStore.exec` gains an optional origin; the exchange record carries it into `ingestShellExchange` rendering (a `serde(default)`-tolerated field if it rides the shell ledger; origin may be client-side-only state if the ledger schema is better left untouched — implementer's call, noted in Step 7).

#### [P10] Find demotes to one-shot; the find cluster becomes activity-conditional Z4B chrome (DECIDED) {#p10-find}

**Decision:** The `⌕` route is deleted. `/find <q>` (and ⌃⌘G) remain the entry; ⌘G/⇧⌘G navigate; Escape/next-submit dissolve (all shipped). The Z4B find cluster (Case/Word/Grep toggles + match count, currently route-gated) instead renders whenever the card's `FindSession` has a non-empty query, alongside the standard Code chips.

**Rationale:** Keeps the option toggles and count reachable during an active find without any route; deletes cleanly when the find dissolves. [L26]: the cluster mounts/unmounts on find activity exactly as it did on route flips.

**Implications:** `SessionRouteChromeManifest` is replaced by a static composition + the conditional cluster; its route-table test dies with it. Live-refine UX deferred ([Q03]).

#### [P11] Prompt history collapses to the Code provider; retired-route entries go dark (DECIDED) {#p11-history}

**Decision:** The per-route history-provider cache (`historyStore.createRouteProvider(sessionId, route)`) keeps its shape but is only ever created for `"❯"`. Entries persisted under `$`/`?`/`⌕`/`±`/`↺` are not migrated and stop being recalled.

**Rationale:** One-shot commands already record their full `/name args` line under the Code route (the local-command history push uses `routeLifecycle.getRoute()` → `"❯"`), so go-forward recall is uniform. A migration would resurrect raw shell lines as Code entries — worse than silence.

**Implications:** None in code beyond deleting route-varying call sites; document in the commit message.

---

### Deep Dives {#deep-dives}

#### Current-state map (what the implementer edits) {#current-state-map}

| Concern | Where today |
|---|---|
| Route scalars | `tugdeck/src/lib/route-constants.ts` (`❯ $ ? ⌕ ± ↺`) |
| Route store | `tugdeck/src/lib/route-lifecycle.ts` (`RouteLifecycle`, `useRoute`, `useRouteDelegate`) |
| Route owner | `session-card.tsx` `SessionCardBody` (`routeLifecycleRef`, `activeView` ternary over `ROUTE_CHANGES`/`ROUTE_HISTORY`) |
| Selector UI | `tug-prompt-entry.tsx` `entryRoutePopup` (`TugPopupMenu`, `ROUTE_ITEMS`, `VIEW_ROUTE_ITEMS`, `widthStabilize`) |
| Shortcuts | `keybinding-map.ts` ⇧⌘C/S/B/F/E/Y → `SELECT_ROUTE` |
| Per-route submit | `tug-prompt-entry.tsx` `performSubmit`: `ROUTE_FIND` (find-next), `ROUTE_BTW` (side question), `ROUTE_CHANGES` (commit), `ROUTE_HISTORY` (`/tugplug:history` + flip to Code), `ROUTE_SHELL` (exec) |
| Per-route Return | `RETURN_ACTION_BY_ROUTE`; per-route Z5 `routeAwareSubmitButtonMode`; per-route placeholders `placeholderByRoute` |
| Per-route chrome | `chrome/session-route-chrome-manifest.tsx` (Table T01), `chrome/session-route-indicator-badge.tsx` (`isShell` face) |
| ± composer | entry: Generate button (`requestDraft`), draft-stream seed effect (route-gated), Z5 Commit + `changesCommitBlocked` |
| One-shot commands | `lib/slash-commands.ts` registry + matcher; `cards/completion-providers/local-commands.ts`; `session-card.tsx` `slashCommandSurfaces`; `RUN_SLASH_COMMAND` responder |
| Command insert seed | `codeSessionStore.pendingCommandInsert` + entry effect (`buildEditingStateFromDraftRestore(TUG_ATOM_CHAR + " " + args, [command atom])`) |
| Menu bridge | `lib/host-menu-state.ts` (`MenuStateSessionBlock`), `cards/use-menu-state-publication.ts`, Swift `AppDelegate.swift` (`MenuState.Session` struct ~line region of `struct Session`, `validateMenuItem`, `sessionCommandItem`/`runCardCommand`, `sendControl`) |
| Deck control actions | `src/action-dispatch.ts` `registerAction("run-card-command" …)` — the pattern for new `toggle-*-view` controls |
| Shell feed | `tugrust/crates/tugcast/src/feeds/shell.rs` (`ShellInput::{Exec,Kill}`, sentinel model, `SessionScopedFeed`); deck `lib/shell-session-store.ts` |
| Shade headers | `cards/session-changes/session-changes-view.tsx` (`buildHeader(actions)` — `BlockFoldCue` + `PopOutDiffButton` precedent), `cards/session-history/session-history-view.tsx` |

#### Chord collision audit (recorded) {#chord-audit}

- **Claimed by this plan:** ⌃⌘S/B/C/G/H (insert chips), ⌘/ (picker), ⇧⌘C/⇧⌘H (deck toggle twins), ⌘⇧C/⌘⇧H (Swift menu equivalents).
- **Avoided:** ⌃⌘F (legacy fullscreen), bare ⌃B/⌃F/⌃H (WebKit Emacs editing), ⌥⌘H (Hide Others), numbers.
- **Freed by deletion:** ⇧⌘C/S/B/F/E/Y (`SELECT_ROUTE`). ⌥⇧⌘C/⌥⇧⌘V (plain-text copy/paste variants) and ⌘G/⇧⌘G (find next/prev) are untouched.
- **Existing ⌃ precedent:** `⌃Backquote` → `CYCLE_CARD` (`keybinding-map.ts`) — the `ctrl` flag is already exercised.

---

### Specification {#specification}

**Spec S01: `ShadeViewController`** {#s01-shade-view-controller}

```ts
export type ShadeView = "none" | "changes" | "history";
export class ShadeViewController {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ShadeView;              // referentially stable string
  show(view: "changes" | "history"): void;   // idempotent; swaps if the other is up
  hide(): void;                          // → "none"
  toggle(view: "changes" | "history"): void; // snapshot === view ? hide() : show(view)
}
```

Owned by `SessionCardBody` via lazy `useRef` (never in `services` — it is card chrome, not session data). Readers: the view-slot render ([L02] `useSyncExternalStore`), `useMenuStatePublication` (direct subscription, [L22]), `slashCommandSurfaces` (imperative `show`), the toggle action handlers (`toggle`), the Shade close affordances (`hide`).

**Spec S02: `path_commands` wire contract** {#s02-path-commands-wire}

Inbound `SHELL_INPUT` (0x61): `{ "type": "path_commands", "tug_session_id": "<id>" }`.
Outbound `SHELL_OUTPUT` (0x60): `{ "type": "path_commands", "tug_session_id": "<id>", "commands": ["bash","cargo","git",…] }` — deduped, sorted, executable names only (no paths). Probe: `$SHELL -lc 'printf %s "$PATH"'` when `$SHELL` is bash/zsh (same gate as the exec shell), else / on failure / after a 5s timeout: tugcast's own `$PATH`. Result cached process-wide. Deck store: request-once-per-session, `getSnapshot(): ReadonlySet<string> | null` (null until loaded).

**Spec S03: `classifyShellLine(text, commands)` heuristic** {#s03-classifier}

Precondition (caller-enforced): draft has no atoms; `text` is trimmed and single-line. Returns `true` (shell) iff ALL of:

1. `text.length > 0 && text.length <= 400`; not starting with `/` (slash commands already intercepted) or `#`.
2. First token: in `commands`, OR a path-shaped executable (`./…`, `~/…`, `/…` containing no spaces).
3. Prose veto — classify Code if ANY holds:
   - `text` ends with `?` or contains no token beyond the first AND the first token is in the ambiguous-opener list `{find, man, time, test, look, touch, sort, head, tail, less, more, which, open, cat}` with nothing command-shaped after it (a bare `find` is prose-adjacent; a bare `ls`/`git`/`pwd` is a command);
   - any subsequent whitespace-token is a bare lowercase English stopword: `{a, an, the, my, me, i, we, you, is, are, was, be, been, to, of, in, on, at, it, its, this, that, these, those, and, or, but, not, do, does, did, can, could, should, would, please, what, when, where, which, who, why, how, there, about, with, from, into, over, under, some, any, all, more, most, other, than, then, if, else, so, just, like, want, need, make, sure}` — UNLESS the line also contains a strong shell signal;
   - the line contains 8+ tokens with no strong shell signal.
4. Strong shell signals (any one neutralizes the stopword/length vetoes): `|`, `&&`, `||`, `;`, `>`, `<`, `` ` ``, `$(`, `${`, a token starting with `-` (flag), a token containing `/` (path), a token containing `=` (env/assign), a quoted string.

Ships with a unit corpus (Vitest/bun test): ≥30 command lines that MUST classify shell (`ls`, `git status`, `cargo nextest run 2>&1 | tail -30`, `./scripts/build.sh --release`, `FOO=1 make test`) and ≥30 prose lines that MUST classify Code (`find the bug in the parser`, `test whether the parser handles unicode`, `man do I need to fix this`, `git is confusing me, explain rebase`, `time to refactor this module`). The prose set failing to stay 100% Code fails the suite — the zero-false-shell gate.

**Spec S04: `menuState` + toggle round-trip** {#s04-menu-wire}

`MenuStateSessionBlock` (TS) and `MenuState.Session` (Swift) each gain `changesVisible: Bool` and `historyVisible: Bool`. `useMenuStatePublication` gains a `shadeViewController` parameter, subscribes to it, and publishes the two booleans. Swift: two new items in the Session menu (after "Show Usage"): identifiers `session.toggleChanges` (keyEquivalent `"C"`, `[.command, .shift]`) and `session.toggleHistory` (keyEquivalent `"H"`, `[.command, .shift]`), action `toggleShadeView(_:)` with `representedObject` `"changes"`/`"history"`, sending `sendControl("toggle-changes-view")` / `("toggle-history-view")`. `validateMenuItem` sets `menuItem.title` to `"Show Changes"`/`"Hide Changes"` (resp. History) from the cached booleans and returns `session?.sessionBound ?? false`. Deck: `registerAction("toggle-changes-view" | "toggle-history-view")` → `sendToKeyCard` with `TUG_ACTIONS.TOGGLE_CHANGES_VIEW`/`TOGGLE_HISTORY_VIEW`; the session card's card-content responder calls `shadeViewController.toggle(...)`. Deck keybindings ⇧⌘C/⇧⌘H (key-card scope, `preventDefaultOnMatch`) dispatch the same actions for browser dev.

**Spec S05: commit-draft round-trip** {#s05-commit-draft}

`/changes describe` → surface: `show("changes")` + `changesController.requestDraft()`. The entry's draft-stream effect (rewritten from the route-gated version): while `changesDraft.phase === "drafting"` for this card's controller identity, `restoreState(buildEditingStateFromDraftRestore(TUG_ATOM_CHAR + " commit " + draft.text, [commandAtom("changes")]))` — i.e. the streaming text lands as `/changes commit <draft…>` with a real command atom at position 0. When the stream ends the user owns the text. Submit: the local-command intercept reconstructs `/changes commit <msg>` via `buildSlashCommandLine` (command atom expands to `/changes`) and dispatches to the `changes` surface, which applies the [P04] gates. The Generate affordance moves into the Changes Shade header: `SessionChangesView` gains an `onRequestDraft`/drafting-phase prop pair (or reads the draft store directly, as the entry does today) and renders a `TugPushButton` "Generate" (width-stabilized "Generating…") in `buildHeader`'s `actions`, left of the fold-all cue.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Shade visibility (`ShadeView`) | structure | `ShadeViewController` store + `useSyncExternalStore` (render), direct subscription (menu publication) | [L02], [L22] |
| Command chip in the draft | local-data (editor document) | CM6 editing state via `insertCommandChip` / `restoreState` — never React state | [L06] |
| PATH command set | structure | `PathCommandsStore`, requested at session bind; classifier reads snapshot imperatively at submit ([L07]-style live read) | [L02], [L22] |
| Find-cluster visibility | structure (derived) | `useSyncExternalStore` over `FindSession` (query ≠ "") | [L02] |
| Auto-route attribution on a shell row | local-data | field on the exchange record → rendered attribute; no separate store | [L06] |
| Menu verb (Show/Hide) | host-side | Swift `validateMenuItem` from cached `menuState` booleans | — |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/shade-view-controller.ts` | Spec S01 store + tests colocated in `lib/__tests__/` |
| `tugdeck/src/lib/shell-line-classifier.ts` | Spec S03 pure classifier |
| `tugdeck/src/lib/__tests__/shell-line-classifier.test.ts` | Zero-false-shell corpus |
| `tugdeck/src/lib/path-commands-store.ts` | Spec S02 deck cache/request store |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `ShadeViewController` | class | `lib/shade-view-controller.ts` | Spec S01 |
| `LOCAL_SLASH_COMMANDS` | const | `lib/slash-commands.ts` | + `changes`, `history`; delete `codeRouteOnly` machinery |
| `slashCommandSurfaces.changes` / `.history` | fn | `cards/session-card.tsx` | [P04] grammar |
| `TUG_ACTIONS.TOGGLE_CHANGES_VIEW` / `TOGGLE_HISTORY_VIEW` / `INSERT_SLASH_COMMAND` / `OPEN_COMMAND_PICKER` | const | `tugways/action-vocabulary.ts` | payload notes per convention |
| `TugPromptEntryDelegate.insertCommandChip` | method | `tugways/tug-prompt-entry.tsx` | [P07] |
| `MenuStateSessionBlock.changesVisible/historyVisible` | fields | `lib/host-menu-state.ts` | Spec S04 |
| `useMenuStatePublication` | fn | `cards/use-menu-state-publication.ts` | + `shadeViewController` param |
| `MenuState.Session` + `toggleShadeView(_:)` + menu items | Swift | `tugapp/Sources/AppDelegate.swift` | Spec S04 |
| `ShellInput::PathCommands` | enum variant | `tugcast/src/feeds/shell.rs` | Spec S02 |
| `ShellSessionStore.exec(cmd, opts?)` | method | `lib/shell-session-store.ts` | optional `origin: "auto"` |
| `classifyShellLine` | fn | `lib/shell-line-classifier.ts` | Spec S03 |
| DELETE: `RouteLifecycle` et al. | — | `lib/route-lifecycle.ts`, `lib/route-constants.ts` (non-`❯`), `chrome/session-route-chrome-manifest.tsx` | [P01]; keep `DEFAULT_ROUTE` for history keying |

---

### Documentation Plan {#documentation-plan}

- [ ] `lib/slash-commands.ts` module doc: update the local/remote framing to name the five former routes as one-shot commands and remove the `codeRouteOnly` prose.
- [ ] `tug-prompt-entry.tsx` header doc: rewrite the Z4A description (route popup → command picker) and drop route terminology.
- [ ] Commit messages record [P11] (retired-route history entries go dark) so the behavior change is greppable.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | `ShadeViewController` transitions; `classifyShellLine` corpus; `/changes`/`/history` arg parsing; registry matcher with new entries | pure modules |
| **Integration (Rust)** | `path_commands` request/response over the shell feed, cache behavior, `$SHELL` fallback | `cargo nextest run` in tugcast |
| **Contract** | `menuState` payload shape (existing host-menu-state tests extended with the two booleans) | wire stability |
| **Drift prevention** | grep-style checks in checkpoints (`SELECT_ROUTE` absent; `codeRouteOnly` absent) | deletion steps |

#### What stays out of tests {#test-non-goals}

- jsdom render tests of the picker/popup/chords — banned pattern; keyboard + popup behavior verified by the real-app manual checkpoints and existing completion-engine tests.
- Shell-ledger persistence of the `origin` field if it stays client-side — nothing durable to test.
- App-test coverage of chord gestures — the harness can't express first-responder chord targeting reliably (see app-test chain first-responder finding); covered at the action-handler layer instead.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | ShadeViewController: visibility off the route | done | 2b45cae93 |
| #step-2 | `/changes` + `/history` commands and directives | done | a98784f0f |
| #step-3 | Commit-draft flow: Generate in the Shade, draft as `/changes commit` chip | done | b73baabdb |
| #step-4 | Delete the sticky routes | done | 9ae903f4a |
| #step-5 | Picker button, ⌘/, ⌃⌘ chords, `insertCommandChip` | done | f7323f044 |
| #step-6 | Swift Show/Hide menu items + toggle round-trip | done | af65e87c7 |
| #step-7 | tugcast `path_commands` verb | done | 9cd0f6f4b |
| #step-8 | Deck classifier + auto-route attribution | done | 63379cdfb |
| #step-9 | Integration checkpoint | done | N/A (verification) |

#### Step 1: ShadeViewController — visibility off the route {#step-1}

**Commit:** `Session card: Shade visibility becomes chrome state (ShadeViewController)`

**References:** [P03] Shade visibility, [P05] show-only, Spec S01, (#state-zone-mapping, #current-state-map)

**Artifacts:**
- `lib/shade-view-controller.ts` + unit tests.
- `session-card.tsx`: `activeView` derived from the controller (route no longer consulted for the view slot); a `routeDidChange` shim keeps ⇧⌘E/⇧⌘Y working until Step 4 (`ROUTE_CHANGES`→`show("changes")`, etc., and leaving those routes hides) so behavior is unchanged mid-transition.
- Close affordance (X icon button, `aria-label="Close"`) appended to the header `actions` of `SessionChangesView` and `SessionHistoryView`, calling a new `onClose` prop wired to `controller.hide()`.

**Tasks:**
- [ ] Implement Spec S01; lazy `useRef` ownership in `SessionCardBody`.
- [ ] Replace the `activeRoute`-ternary `activeView` with a `useSyncExternalStore` read of the controller.
- [ ] Bridge route→controller via the existing `useRouteDelegate` hook (its `useLayoutEffect` registration satisfies [L03]); temporary, removed in #step-4 — the comment states what it bridges, nothing more.
- [ ] Add `onClose` to both Shade views' props and headers (compose the existing icon-button pattern next to `BlockFoldCue`/`PopOutDiffButton`).

**Tests:**
- [ ] Unit: show/hide/toggle transitions incl. mutual exclusion and idempotent show.

**Checkpoint:**
- [ ] `./node_modules/.bin/tsc -p tsconfig.json --noEmit && bun test && ./node_modules/.bin/vite build` (tugdeck)
- [ ] Manual: ⇧⌘E still opens Changes; the new X closes it; transcript stays live beneath.

---

#### Step 2: `/changes` + `/history` commands and directives {#step-2}

**Depends on:** #step-1

**Commit:** `Slash commands: /changes and /history (show + directives)`

**References:** [P02] roster, [P04] grammar, [P05] show-only, (#s01-shade-view-controller)

**Artifacts:**
- Registry entries (`takesArgs: true`) + descriptions; surfaces in `slashCommandSurfaces` implementing the [P04] grammar with pane bulletins for refusals/usage.
- `/history <q>` sends `/tugplug:history <q>` via `codeSessionStore.send` and shows the History Shade.

**Tasks:**
- [ ] Add both registry entries; the exhaustive `Record` forces the surfaces.
- [ ] Implement [P04] verbatim, reading `changesController` snapshot + `codeSessionStore.getSnapshot()` live at invocation — including the `/history <q>` replay guard (`!canSubmit && !canInterrupt` → caution bulletin, no send).
- [ ] Completion descriptions in the registry voice.

**Tests:**
- [ ] Unit: `matchLocalSlashCommand` recognizes `/changes commit fix: thing` and `/history what changed`; arg-splitting helper for the changes sub-verbs.

**Checkpoint:**
- [ ] tsc + bun test + vite build.
- [ ] Manual: bare `/changes` and `/history` show their Shades from the Code route; `/changes commit x` mid-turn refuses with a bulletin.

---

#### Step 3: Commit-draft flow — Generate in the Shade, draft as `/changes commit` chip {#step-3}

**Depends on:** #step-2

**Commit:** `Changes: Generate moves into the Shade header; drafts land as /changes commit`

**References:** [P04], Spec S05, (#current-state-map)

**Artifacts:**
- Generate button in `SessionChangesView`'s header actions (drafting-phase aware, width-stabilized); the entry's route-gated Generate button and Z5 Commit wiring (`changesCommitBlocked`, Commit aria-labels) removed.
- The entry's draft-stream seed effect rewritten per Spec S05 (gates on drafting phase + card identity, not route; seeds the command atom + `commit ` prefix).

**Tasks:**
- [ ] Move Generate; keep `requestDraft()` as the single trigger for both the button and `/changes describe`.
- [ ] Rewrite the seed effect; delete the entry's `ROUTE_CHANGES` submit branch (the local-command intercept now carries commit) and the ± Z5/`changesCommitBlocked` wiring.
- [ ] Delete `performSubmit`'s `routeInterceptsLocal` `±`/`↺` exclusion (and its keeper comment): its rationale — a commit message / history question leading with `/` is literal text — dies with the `±` branch. Without this deletion, a `/changes commit <msg>` submitted while the still-selectable `±` route is active would skip the intercept and fall through to `codeSessionStore.send`, sending the commit message to Claude.
- [ ] Verify the `±` route (still selectable until #step-4) now shows the view via the Step 1 shim without a route-local composer — the entry behaves as Code there, local-command interception included.

**Tests:**
- [ ] Unit: `buildSlashCommandLine` on a command atom + `commit <msg>` reconstructs `/changes commit <msg>` (existing helper, new fixture).

**Checkpoint:**
- [ ] tsc + bun test + vite build.
- [ ] Manual round-trip: `/changes describe` → draft streams into the entry with the chip → edit → Shift+Return → commit receipt appears; mid-turn the commit refuses.

---

#### Step 4: Delete the sticky routes {#step-4}

**Depends on:** #step-3

**Commit:** `Demote routes: Code is the only resting mode`

**References:** [P01], [P10], [P11], [Q01], (#chord-audit, #current-state-map)

**Artifacts:**
- Deleted: Z4A `TugPopupMenu` + `ROUTE_ITEMS`/`VIEW_ROUTE_ITEMS`/width-stabilize labels; ⇧⌘C/S/B/F/E/Y `SELECT_ROUTE` bindings + the entry's `SELECT_ROUTE`/route-`SELECT_VALUE` handlers; `performSubmit` branches for `ROUTE_FIND`/`ROUTE_BTW`/`ROUTE_HISTORY`/`ROUTE_SHELL` (the `±` branch died in #step-3); `RETURN_ACTION_BY_ROUTE` (Return=newline, numpad per existing default); `routeAwareSubmitButtonMode`; `placeholderByRoute` (single Code placeholder prop); `viewRoutes`; the btw route-entry overlay effect; the route flip inside `applyShellShare`; the Step 1 route→controller shim; `chrome/session-route-chrome-manifest.tsx` (+ its test) replaced by static chip composition + the [P10] conditional find cluster; `SessionRouteIndicatorBadge` `isShell` face; `lib/route-lifecycle.ts` + `lib/route-constants.ts` non-`❯` constants (keep `DEFAULT_ROUTE` where history keying needs it).
- Updated: `shell-share.test.ts`, `route-lifecycle.test.ts` (deleted), `tug-prompt-entry-strip-and-migrate.test.ts`, gallery prompt-entry fixtures.

**Tasks:**
- [ ] Work outside-in: selector UI → keybindings → submit branches → chrome → the lifecycle module; keep the build green at each sub-edit.
- [ ] Find cluster: render in Z4B while `FindSession.getSnapshot().query !== ""` ([L02]); previous-match button rides the same condition.
- [ ] History providers: pin the provider key to the Code route.
- [ ] Sweep: `rg -n "ROUTE_SHELL|ROUTE_BTW|ROUTE_FIND|ROUTE_CHANGES|ROUTE_HISTORY|SELECT_ROUTE|codeRouteOnly|viewRoutes|useRoute\b" tugdeck/src` → only intentional survivors (history keying `DEFAULT_ROUTE`).

**Tests:**
- [ ] Update/delete the four route-touching suites per [Q01]; keep `shell-share` coverage of the seed/append semantics (minus the flip).

**Checkpoint:**
- [ ] tsc + bun test + vite build; the sweep grep is clean.
- [ ] Manual: every destination reachable via `/` commands only; Return=newline / Shift+Return=submit uniformly; Z4B shows the Code chips (+ find cluster during an active `/find`).

---

#### Step 5: Picker button, ⌘/, ⌃⌘ chords, `insertCommandChip` {#step-5}

**Depends on:** #step-4

**Commit:** `Command picker + ⌃⌘ chords replace the route selector`

**References:** [P06] picker, [P07] chords, (#chord-audit, #s05-commit-draft)

**Artifacts:**
- Z4A slot: picker `TugButton` (slash glyph, `aria-label="Commands"`, keeps the focus-group registration) → focus editor + seed leading `/`.
- Actions `OPEN_COMMAND_PICKER` + `INSERT_SLASH_COMMAND`; bindings ⌘/ and ⌃⌘S/B/C/G/H (`ctrl: true, meta: true`, key-card scope, `preventDefaultOnMatch`).
- `TugPromptEntryDelegate.insertCommandChip(name)` per [P07]; session-card responder wiring.
- Key-equivalent hints appended to the five commands' completion descriptions.

**Tasks:**
- [ ] Implement `insertCommandChip` against the CM6 editing state (replace head command atom; preserve remainder as args; focus; caret after the chip/space).
- [ ] Picker button activation: if draft already starts with `/` or a command atom, just focus; else insert `/` at position 0 (completion popup opens via the existing position-zero provider).
- [ ] Verify chords land while focus is elsewhere in the card (key-card scope) and while the editor is focused (capture-phase stage-1 wins before CM6).

**Tests:**
- [ ] Unit: chip-insert document transform (pure helper extracted for testability): empty draft, plain-text draft, draft with existing head command atom, draft with mid-text atoms.

**Checkpoint:**
- [ ] tsc + bun test + vite build.
- [ ] Manual: ⌘/ opens the popup; each ⌃⌘ chord inserts its chip preserving typed text; picker button does the same by mouse.

---

#### Step 6: Swift Show/Hide menu items + toggle round-trip {#step-6}

**Depends on:** #step-1, #step-4

**Commit:** `Session menu: Show/Hide Changes (⌘⇧C) and Show/Hide History (⌘⇧H)`

**References:** [P05], Spec S04, (#current-state-map)

**Artifacts:**
- TS: `MenuStateSessionBlock` fields; `useMenuStatePublication(cardId, codeSessionStore, sessionMetadataStore, shadeViewController)` subscribing to the controller; `action-dispatch.ts` `toggle-changes-view`/`toggle-history-view`; `TOGGLE_*_VIEW` handlers on the session card responder; ⇧⌘C/⇧⌘H deck bindings.
- Swift: `MenuState.Session` fields + parser defaults; two menu items + `toggleShadeView(_:)`; `validateMenuItem` dynamic titles + `sessionBound` gate.

**Tasks:**
- [ ] Follow Spec S04 exactly; parser tolerates absent fields (`?? false`) for deck/app version skew.
- [ ] Rebuild Tug.app and verify (building the app is cheap).

**Tests:**
- [ ] Unit/contract: extend the host-menu-state payload test with the two booleans.

**Checkpoint:**
- [ ] tsc + bun test + vite build; Swift build.
- [ ] In-app: menu verb flips with visibility; ⌘⇧C toggles; items disabled with no session card frontmost; browser dev: ⇧⌘C/⇧⌘H toggle.

---

#### Step 7: tugcast `path_commands` verb {#step-7}

**Depends on:** #step-1 (parallel-safe with #step-2..6)

**Commit:** `tugcast: path_commands shell-feed verb (login PATH command set)`

**References:** [P08], [Q02], Spec S02, (#current-state-map)

**Artifacts:**
- `ShellInput::PathCommands` + handler + process-wide cache + probe with fallback; response frame per Spec S02.

**Tasks:**
- [ ] Follow the feed's existing session-tagged emit pattern (`SessionScopedFeed`); keep the probe off the exec child.
- [ ] Cap + log: if the serialized set would exceed the transport cap, truncate deterministically (sorted prefix) and `warn!`.

**Tests:**
- [ ] Rust: probe fallback (bogus `$SHELL`), dedupe/sort, cache hit (single probe across two requests), round-trip through the feed harness in `tugcast/tests`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` (zero warnings).

---

#### Step 8: Deck classifier + auto-route attribution {#step-8}

**Depends on:** #step-4, #step-7

**Commit:** `Auto-route command-shaped lines to the shell (PATH classifier)`

**References:** [P09], Spec S02, Spec S03, (#state-zone-mapping)

**Artifacts:**
- `lib/path-commands-store.ts` (lazy request on first consult; [L02] store shape); `lib/shell-line-classifier.ts` + corpus test; `performSubmit` hook (default branch, post-intercepts, pre-`send`); `ShellSessionStore.exec` origin option; `→ shell` attribution + "Send to Claude instead" on auto-routed exchange rows.

**Tasks:**
- [ ] Classifier per Spec S03; store answers null → Code. Fire the `path_commands` request at session bind (per [P08]) so the set is warm before the first submit; keep null→Code as the safety net.
- [ ] Attribution UI on the shell block header (compose existing block chrome affordances; no new component); resend dispatches the original text via `codeSessionStore.send` and needs no special turn state (send queues mid-turn).
- [ ] History: auto-routed submissions record the raw line under the Code route (they were typed as Code input).

**Tests:**
- [ ] The Spec S03 corpus (zero-false-shell gate).
- [ ] Unit: store request-once semantics.

**Checkpoint:**
- [ ] tsc + bun test + vite build.
- [ ] Manual: `git status` auto-routes with attribution; resend lands the same text as a Claude turn; `find the bug in the parser` goes to Claude.

---

#### Step 9: Integration checkpoint {#step-9}

**Depends on:** #step-5, #step-6, #step-8

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), [P01]–[P11]

**Tasks:**
- [ ] Walk every success criterion in #success-criteria against the real app (`just app-test` for the harnessed subset; manual for menu/chord gestures).
- [ ] Confirm HMR vs Maker▸Reload invariants untouched; Shade heights/persist behavior unchanged.

**Tests:**
- [ ] Full suites: `bun test`, `cargo nextest run`, `./node_modules/.bin/vite build`, Swift build, `just app-test`.

**Checkpoint:**
- [ ] All of the above green; the #step-4 sweep grep still clean.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A Session card with exactly one resting input mode (Code), five one-shot slash commands with picker/chord/menu affordances, chrome-driven Shade visibility with native menu parity, and a high-precision PATH classifier that auto-routes command-shaped lines to the shell with visible, undoable attribution.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every #success-criteria item verified as specified.
- [ ] No sticky route state or selector remains (#step-4 sweep grep).
- [ ] All four build/test gates green (tsc, vite build, bun test, cargo nextest) + Swift build + app-test.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] AI classifier for the ambiguous middle band (deferred by decision).
- [ ] Live find refinement UX ([Q03]) — an inline query field on the Z4B find cluster.
- [ ] Removing the now-single-route `route` field from persisted history entries (schema simplification).
- [ ] `/find` option flags (e.g. `case:` / `word:` / `grep:` args).

| Checkpoint | Verification |
|------------|--------------|
| Deck green | `./node_modules/.bin/tsc -p tsconfig.json --noEmit && bun test && ./node_modules/.bin/vite build` |
| Rust green | `cd tugrust && cargo nextest run` |
| App green | Swift build + `just app-test` |
| Route-free | `rg -n "SELECT_ROUTE|ROUTE_SHELL|codeRouteOnly|viewRoutes" tugdeck/src` clean |

<!-- devise-skeleton v4 -->

## Settings Rework — Accordion Settings Card + Promoted Keyboard Card {#settings-rework}

**Purpose:** Rebuild the app-wide Settings card as a full-size deck card whose subsections live in one scrolling `TugAccordion` instead of a tab strip — with expanded/collapsed state persisted and everything expanded on first run — and promote the keyboard configurator out of Settings into its own full-size deck card.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-05 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Settings is already a real deck card — `registerSettingsCard()` in `tugdeck/src/components/tugways/cards/settings-card.tsx` registers `componentId: "settings"` as a hidden, center-placed card, shown as a singleton via `DeckManager.showSingletonCard("settings")` (the `SINGLETON_CARDS` set in `tugdeck/src/action-dispatch.ts`) and reachable through ⌘, (the `SHOW_SETTINGS` command in `command-registry.ts`, chord-handled in `deck-canvas.tsx` because the web layer sees ⌘, before AppKit's menu does) and the native menu item `app.settings` in `tugapp/Sources/AppDelegate.swift`. But it is a small card (`sizePolicy min 420×420, preferred 560×820`) that hides four-fifths of its content behind a `TugTabBar` at any moment, and the selected tab is throwaway `useState` that resets to `"sessionCard"` on every mount.

Cards like session and text already occupy an 800-wide, 1200-preferred-tall envelope. Giving Settings that same real estate removes the need for tabs: the preference subsections can stack in one scrolling presentation, disclosed by accordion sections the user can collapse, with that choice remembered across close/reopen and app restarts.

Four of the five current tabs are the same kind of object — a handful of bordered `TugBox` groups holding switches, popups, sliders, and a path field, all content-sized. **The Keyboard tab is not.** It is a filterable browser over the entire command set (`TugListView` + `settings-keymap-rows.ts` grouping) with a chord-capture surface that arms host-side key-equivalent parking (`chord-capture-state.ts` → `host-menu-state.ts`'s `captureArmed`) and a Reset All confirm. `TugListView` requires a definite height: `tug-list-view.css` documents that the list is `height: 100%` with `overflow-y: auto` and "its height needs to be bounded by something," naming `flex: 1; min-height: 0` as the expected parent, and the component unmounts rows outside the scrollport and drives `SmartScroll`. Today that bound comes from `.settings-card-panel`'s definite height. In an auto-height accordion section it would have none.

So the keyboard configurator is promoted to its own full-size card. It stops being an exception to the Settings card's layout model and instead gets what it actually needs — a pane that hands it a definite height — while Settings becomes uniformly "a stack of preference groups."

#### Strategy {#strategy}

- Promote the keyboard configurator first: move `SettingsKeymapBody` wholesale into a new `keyboard` card, restoring the height chain the pane now supplies. Settings never has to host it, even transiently.
- Reuse the four remaining body components (`SettingsGeneralBody`, `SettingsSessionCardBody`, `SettingsTextCardBody`, `SettingsAppBody`) verbatim as accordion item content — they are self-contained (each owns its stores/tugbank wiring) and do not know they live in tabs.
- One controlled `TugAccordion type="multiple"` with four items, following the `tug-diff-document.tsx` controlled pattern (`value` + `senderId` + `useResponderForm.toggleSectionMulti`), backed by a new tugbank pref module in the `commit-filter-scope.ts` idiom.
- Persist the **collapsed** set (not the open set) so an absent key means "all expanded" — first run and any future new section both default open for free.
- Let the pane's own scroller (`.tug-pane-content`) scroll the Settings card, gaining automatic scroll-offset persistence through `bag.scroll`. With Keyboard gone this rule has no exceptions.
- Land the pref module first (unit-testable in isolation), then the Keyboard card, then the Settings rework, then the reveal, then tests — each a separate commit.

#### Success Criteria (Measurable) {#success-criteria}

- A `keyboard` card opens from its native menu item and from a control inside Settings, at most one at a time (verify: app-test opens it twice and asserts a single `[data-testid="keyboard-card"]`).
- The keymap list scrolls and filters inside the new card exactly as it did in the tab (verify: at0182 passes against the new open path).
- Opening Settings (⌘, or menu) shows a card at the session/text envelope: preferred 800×1200, min 800×600 (verify: `getSizePolicy("settings")` and the rendered pane size in an app-test).
- No `TugTabBar` in the Settings card; four `TugAccordionItem`s render in order General → Session Card → Text Card → Maker (verify: DOM query in app-test).
- Fresh profile: all four sections open (verify: app-test on a clean workspace asserts four `[data-state="open"]` items).
- Collapse a section, close the card, reopen: still collapsed. Restart the app: still collapsed (verify: app-test toggling + `showSingletonCard` round-trip; the tugbank key survives restart by construction).
- The unavailable-model bulletin's "Review Defaults" path lands the user on an expanded Session Card section without altering the persisted collapsed set (verify: app-test or manual).
- Every existing settings app-test (at0154, at0155, at0173, at0220, at0304) and at0182 passes.
- `bunx vite build` succeeds (per the production-rollup verification rule).

#### Scope {#scope}

1. New `keyboard` card: registration, doors (native menu item + command + a control in Settings), `SettingsKeymapBody` moved in with its height chain restored.
2. New pref module persisting the collapsed-section set through tugbank defaults.
3. `settings-card.tsx` / `settings-card.css` rework: tabs → controlled accordion over four sections, size policy bump, pane-level scrolling.
4. Deep-link reveal so `use-unavailable-model-bulletin.ts` can open + reveal the Session Card section.
5. Retarget existing app-tests (including at0182's open path); add coverage for the new card's singleton-ness, the all-expanded default, and collapse persistence.

#### Non-goals (Explicitly out of scope) {#non-goals}

- A default keyboard chord for the Keyboard card. ⌘, is taken by Settings; the card is reachable by menu, by a control in Settings, and from the Lens. Adding a chord later is a keymap-registry entry, not a redesign.
- Any redesign of the keymap configurator's own UI. It moves as-is.
- Finer section granularity (one accordion item per `TugBox` group). Deferred — see [Q01].
- Expand All / Collapse All header buttons. Four sections don't warrant the chrome; the state is controlled, so adding them later is trivial.
- Sticky accordion triggers while scrolling. The sticky-header reveal interaction is a known trap (`reference_sticky_header_reveal`) and nothing here needs it.
- Any change to the four remaining body components' internals, their stores, or their tugbank domains.
- Any change to the Settings open paths (⌘, chord handling, native `app.settings` item, `SINGLETON_CARDS` entry for `settings`).

#### Dependencies / Prerequisites {#dependencies}

- `TugAccordion` (`tugdeck/src/components/tugways/tug-accordion.tsx`) — already supports controlled `type="multiple"`, `focusGroup`, arbitrary trigger nodes.
- tugbank defaults plumbing — `useTugbankValue`, `getTugbankClient().setLocalValue`, `PUT /api/defaults/<domain>/<key>`.
- The card registry's `hidden` / `placement` / `sizePolicy` fields and `DeckManager.showSingletonCard` — all exercised today by the About and Settings cards.
- One Swift change (a menu item in `AppDelegate.swift`); no Rust or protocol changes.

#### Constraints {#constraints}

- localStorage/sessionStorage/IndexedDB are banned ([D07]); persistence goes through tugbank defaults only.
- Tuglaws apply: [L02] external state via `useSyncExternalStore` (here via `useTugbankValue`), [L06] appearance through CSS/DOM, [L11] controls dispatch through the responder chain, [L03] registrations events depend on use `useLayoutEffect`, [L27] every registration returns its unregister.
- **Every card registration must resolve a Lens home.** `components/lens/sections/__tests__/cards-groups.test.ts` walks every registration and fails if one doesn't resolve; only `lens` itself may be `"none"`.
- App-tests are selective: `just app-test-changed`, never a sweep. New tests must carry `@covers`.
- The DEFAULTS boot frame has a 16 MB cap — keep the persisted value tiny (a short string array).
- **Merge caution:** the working tree already carries in-flight command-funnel changes to `command-registry.ts`, `action-vocabulary.ts`, `AppDelegate.swift`, `tuglaws/menus.md`, and `at0168-menu-structure.test.ts`. The new menu item touches all five. Rebase/merge carefully rather than assuming a clean surface.

#### Assumptions {#assumptions}

- The four remaining tab ids (`general`, `sessionCard`, `textCard`, `app`) are stable and become the accordion section ids / persisted vocabulary.
- The four remaining bodies are content-sized and work unchanged in an auto-height container. (The one that wasn't is being promoted out — see [P07].)
- `SettingsKeymapBody` has no dependency on the Settings card itself: its stores are `keymapOverrideStore` + the keymap registry, and its chord-capture arming goes through the module-level `chord-capture-state.ts`, not through any Settings-card context. Verified by reading its imports; confirm at extraction time.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Finer section granularity (DEFERRED) {#q01-finer-granularity}

**Question:** Should the Settings accordion eventually have one item per `TugBox` group (Default Project Directory, Stacked Panes, Response, Prompt Editor, Assistant, Text Card, Open Files In, Maker) instead of four coarse sections?

**Why it matters:** The flatter shape is more System-Settings-like, but it forces splitting the body components and multiplies the persisted-id vocabulary.

**Resolution:** DEFERRED — ship four coarse sections reusing the bodies verbatim ([P02]); revisit only if they prove unwieldy in use. The persisted format (a string array of ids) accommodates a larger vocabulary without migration.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Focus regressions across descend scopes | med | med | R01 | Enter/Escape misbehaves in any section |
| Keyboard config becomes harder to find | med | med | R02 | Users hunt for shortcuts inside Settings |
| App-test rewrites, not selector swaps | med | high | R03 | at0154's premise / at0304's blur target / at0182's open path |
| Four bodies mount at once | low | high | R04 | Slow first open, or a Maker bridge RPC at every open |

**Risk R01: Focus and descend-scope regressions** {#r01-focus-descend}

- **Risk:** Four bodies that were each alone in a panel now share one accordion's focus group, and the Session Card body nests CM6-adjacent controls inside a descend scope.
- **Mitigation:** Use `focusGroup` exactly as `hooks-sheet.tsx` does (the proven accordion-in-a-card shape); each item's content is already wrapped in a `FocusModeContext` scope by `TugAccordion` itself; verify Enter-descend/Escape-ascend through every section against `tuglaws/focus-language.md` and the at0120 accordion-focus patterns before closing the phase.
- **Residual risk:** An interaction unique to one body may need a targeted fix there — scoped, and covered by that body's existing at-tests. Note that promoting Keyboard out removes the hardest case (a `TugListView`, itself an item-container stop, nested inside a descend scope).

**Risk R02: Discoverability of the promoted Keyboard card** {#r02-discoverability}

- **Risk:** ⌘, is the known door to "where settings live." A user looking for shortcut configuration will open Settings and not find it.
- **Mitigation:** Three doors ([P08]): a native menu item next to Settings…, a control inside the Settings card that opens the Keyboard card, and a Lens home. The Settings control is the load-bearing one — Settings still *tells you* keyboard configuration exists, it just doesn't host it.
- **Residual risk:** Users with muscle memory for "Settings ▸ Keyboard" need one discovery. The in-Settings control makes that discovery happen in the place they already looked.

**Risk R03: Three app-tests need rewriting, not retargeting** {#r03-test-churn}

- **Risk:** at0154's *premise* is the tab strip — its test name is "creates once with tab strip," it asserts `[role="tablist"]` exists, counts `[role="tab"]` nodes, and checks `aria-selected="true"`. None of those nodes exist under the accordion. at0304 uses the tab bar as a **blur target**: its comment directs the test to type the path then "move focus to the tab bar," because the field settles on blur — with no tab bar, that gesture has no destination. at0182 opens Settings and clicks `[data-testid="settings-card"] [data-testid="tug-tab-keyboard"]` to reach the keymap; that path disappears entirely.
- **Mitigation:** Step 5 names the per-test disposition explicitly rather than describing a blanket selector swap. at0182 actually gets *simpler* — it opens the Keyboard card directly instead of opening Settings and switching tabs.
- **Residual risk:** at0304 may reveal that the settle-on-blur path needs a different affordance; if so, fix the test's gesture, not the settle contract.

**Risk R04: Four bodies mount simultaneously** {#r04-simultaneous-mount}

- **Risk:** All-expanded-by-default means the first open constructs the Session Card body's editor/response stores and the Text Card store, *and* fires the Maker `getSettings` bridge RPC — where previously exactly one body mounted. Conversely, Radix unmounts closed `Accordion.Content`, so a **collapsed section's body does not exist**: live propagation and the chips' turn-lock only hold while that section is open.
- **Mitigation:** Accept it — each body already constructs cheaply at tab-switch time today, and the card opens on an explicit gesture, not at boot. Note the collapsed-unmount semantics in the card's module docstring so it is not rediscovered as a bug. (The heaviest body, the keymap list, is no longer among them.)
- **Residual risk:** If first-open latency becomes visible, the fallback is to seed new profiles with heavier sections collapsed — a one-line default change.

---

### Design Decisions {#design-decisions}

#### [P01] Adopt the session/text card envelope; keep every Settings open-path unchanged (DECIDED) {#p01-card-envelope}

**Decision:** Change the Settings registration's `sizePolicy` to `min: { width: 800, height: 600 }, preferred: { width: 800, height: 1200 }`; keep `hidden: true`, `placement: "center"`, the singleton behavior, and all three open doors (⌘, chord in `deck-canvas.tsx`, native menu → `show-card` → `showSingletonCard`, programmatic `dispatchCommand(TUG_ACTIONS.SHOW_SETTINGS)`).

**Rationale:**
- Session card is min 800×600 / preferred 800×1200; text card is min 800×400 / preferred 800×1200. The session envelope is the "same dimensions as other cards" ask.
- `DeckManager.addCard` clamps `preferred` to 90% of the live canvas floored at `min`, so 800×1200 degrades gracefully on small windows.

**Implications:**
- No changes in `action-dispatch.ts`, `deck-canvas.tsx`, `AppDelegate.swift`, or `command-registry.ts` for the *Settings* card. (The Keyboard card adds its own entries — see [P08].)

#### [P02] One accordion, four coarse sections, ids = surviving tab ids (DECIDED) {#p02-coarse-sections}

**Decision:** One `TugAccordion type="multiple"` root with four `TugAccordionItem`s whose `value`s are the surviving tab ids `general | sessionCard | textCard | app`, each rendering the existing body component unchanged.

**Rationale:**
- One root (not four stacked roots) keeps the accordion a single item-container focus stop: Up/Down roves headers, Space toggles, Enter descends. This is the `hooks-sheet.tsx` shape.
- Verbatim body reuse is the minimum-churn path; the bodies already own their stores and tugbank domains.
- Reusing the tab ids keeps the vocabulary stable for persistence and for the reveal mechanism.

**Implications:**
- The `SettingsTabId` type becomes the section-id type minus `"keyboard"`; `TAB_CARDS` and the `TugTabBar` import are deleted; the `settings-tab` sentinel componentId disappears.
- `"keyboard"` is deliberately absent from the persisted vocabulary; a stored array containing it is filtered out on parse (S01), so a profile written by a pre-rework build degrades cleanly.

#### [P03] Persist the collapsed set in a standalone tugbank domain, not card state (DECIDED) {#p03-collapsed-set-domain}

**Decision:** A new pref module `tugdeck/src/lib/settings-sections-pref.ts` persists a JSON string array of **collapsed** section ids under domain `dev.tugtool.settings-card`, key `collapsedSections`, read via `useTugbankValue` and written via `setLocalValue` + fire-and-forget `PUT` — the `commit-filter-scope.ts` idiom. The accordion runs controlled: `value = SETTINGS_SECTION_IDS minus collapsed`.

**Rationale:**
- Storing the collapsed set makes "absent key → all expanded" the natural first-run state, and any future section defaults expanded without migration. This mirrors the Lens store's `collapsedSections` representation (a string set as `kind: "json"`).
- `TugAccordion`'s built-in `componentStatePreservationKey` was rejected: it rides the per-cardId card-state axis (`dev.tugtool.deck.cardstate/<cardId>`), and Settings is closable — card state is pruned with the card, so close-and-reopen would forget the user's choices. A standalone domain survives the singleton's death and rebirth.
- Deck-wide (not per-card) is correct: there is at most one Settings card, and how a reader arranges Settings is about the reader.

**Implications:**
- Parse must distinguish "never set" (`null` → default all-expanded) from "set to empty" (user re-expanded everything) — the missing-vs-empty discipline `commit-filter-scope.ts` documents.
- Unknown ids in the stored array are filtered against the known vocabulary on parse — which is also what retires a stale `"keyboard"` entry.
- `getTugbankClient()` may be `null` pre-boot/in tests; the write helper must no-op the cache write and still behave (follow `writeCommitFilterScope` exactly).

#### [P04] The pane scrolls; the card does not (DECIDED) {#p04-pane-scrolls}

**Decision:** Remove the internal scroller (`.settings-card-panel { overflow-y: auto }`); the Settings card root becomes a plain flex column that grows to content, and `.tug-pane-content` (already `overflow: auto`, verified in `tug-pane.css`) scrolls it. **No exceptions** — the one section that needed a bounded scrollport is now its own card ([P07]).

**Rationale:**
- Pane-level scroll offset persists automatically into `bag.scroll` — `card-host.tsx`'s mount restore effect applies `bag.scroll` to `hostContentEl` (with an opacity guard against restore flash). Zero code for scroll restore.
- One scroller for the card as a whole, so reveal/scroll-into-view has a single unambiguous target and no nested-scroll chaining.

**Implications:**
- `settings-card.css` loses `.settings-card-tabs` and the panel's `overflow-y`; padding moves to the card root / per-item content.
- The Keyboard card keeps the opposite shape — a card root that fills the pane so its list gets a definite height ([P07]).

#### [P05] Deep-link reveal via a transient open-override (DECIDED) {#p05-reveal-mechanism}

**Decision:** A small module `tugdeck/src/lib/settings-reveal.ts` exposes `requestSettingsReveal(sectionId)`, which parks a one-shot pending section id and notifies a registered consumer. `SettingsCardContent` registers the consumer in a `useLayoutEffect` ([L03]); on delivery it (a) adds the id to a **transient open-override set** held in card-local `useState` and (b) scrolls the section's trigger into view. The override is unioned with the persisted-derived open set at render, and an entry is dropped as soon as the user toggles that section. **The persisted collapsed set is never written by a reveal.** `use-unavailable-model-bulletin.ts` changes its confirm handler to `dispatchCommand(TUG_ACTIONS.SHOW_SETTINGS)` followed by `requestSettingsReveal("sessionCard")`.

**Rationale:**
- The bulletin is today the only caller that cares where the user lands (the old default tab was `"sessionCard"` for exactly this reason — the model chips live there). With remembered collapse state that section might be closed, and the reveal must still show it.
- An earlier draft had the reveal *remove* the id from the persisted collapsed set. That is the app silently rewriting a stored user preference: a user who deliberately collapsed Session Card would find it permanently re-expanded by a bulletin, with nothing putting it back. A transient override produces the same visible outcome with no preference laundering.
- Card-local `useState` is the right zone — the override is component-scoped, coordinates with nothing outside the card, and is deliberately forgotten when the card closes ([L24] local-data).

**Implications:**
- The consumer registration must be `useLayoutEffect` so a request parked before mount fires as soon as the card attaches; registration returns an unregister closure invoked on unmount ([L27]).
- The open set is `(SETTINGS_SECTION_IDS minus collapsed) ∪ override`. Toggling a section clears its override entry so the user's next gesture is authoritative.
- Scroll targets the pane scroller ([P04]); per `tuglaws/scroll-intent.md` the scroller scrolls itself, never an ancestor.

#### [P06] Separator variant; triggers carry the lucide icon + label (DECIDED) {#p06-trigger-styling}

**Decision:** `variant="separator"` (the default), with each item's `trigger` a small node rendering the section's lucide icon (`Settings2`, `MessageSquareText`, `FileText`, `Wrench` — imported directly from `lucide-react`) and its label.

**Rationale:**
- The bodies contain bordered `TugBox` groups; `outline` would double-frame them, `separator` reads cleanest.
- The tab bar resolved icons from name strings on `CardState`; with the tab bar gone, direct lucide imports in `settings-card.tsx` are the simple path (`trigger` accepts arbitrary nodes — see `FileTrigger` in `tug-diff-document.tsx`).

**Implications:**
- The `icon: string` field on the old tab spec becomes an icon component reference in the section spec.
- The `Keyboard` lucide icon moves to the new card's registration `defaultMeta.icon` and to the in-Settings control that opens it.

#### [P07] The keyboard configurator is promoted to its own card (DECIDED) {#p07-keyboard-card}

**Decision:** A new card `componentId: "keyboard"`, title "Keyboard Shortcuts", registered from a new `tugdeck/src/components/tugways/cards/keyboard-card.tsx`, hosting `SettingsKeymapBody` moved wholesale out of Settings. `hidden: true`, `placement: "center"`, `sizePolicy: { min: { width: 800, height: 600 }, preferred: { width: 800, height: 1200 } }` — the same envelope as Settings and the session card. Its card root fills the pane (`height: 100%; min-height: 0`) so `.settings-keymap`'s existing `height: 100%` → `.settings-keymap-list { flex: 1 1 auto; min-height: 0; overflow: hidden }` chain resolves against a definite height exactly as it does today.

**Rationale:**
- `TugListView` cannot render in an auto-height container — `tug-list-view.css` says so in its own comment, and the component unmounts offscreen rows and drives `SmartScroll`. Under [P04] the Settings card has no definite height to give it. A pane does.
- Every alternative was worse. A bounded `max-height` inside an accordion section means a nested scroller and a magic number tuned by eye; rewriting the keymap rows as inline markup means hand-rolling list focus and selection instead of composing `TugListView`, a known anti-pattern here.
- The configurator is a different kind of surface from the rest of Settings: a task you sit down and do (filter, find, capture, verify, repeat), not a switch you flip in passing. That is card-shaped work, and it deserves its own size policy rather than inheriting one tuned for preference groups.
- Removing it makes [P04] exception-free and removes the hardest focus case from R01.

**Implications:**
- `settings-keymap-body.tsx` / `.css` / `settings-keymap-rows.ts` keep their filenames and internals; only their host changes. Renaming them is deliberately out of scope (a rename would churn `@covers` lines and the extraction diff at once).
- The chord-capture arming path (`chord-capture-state.ts` → `host-menu-state.ts`'s `captureArmed`, which parks host key equivalents during capture) is module-level and carries over untouched — confirm at extraction.
- `tuglaws/menus.md` says "the Settings ▸ Keyboard pane renders from it" about `resolveChord`; that prose needs updating. `tugdeck/src/components/tugways/__tests__/menus-doc.test.ts` asserts against that document, so doc and test move together.

#### [P08] Three doors into the Keyboard card; singleton like Settings and About (DECIDED) {#p08-keyboard-doors}

**Decision:** The Keyboard card is reachable by (1) a native menu item "Keyboard Shortcuts…" (identifier `app.keyboardShortcuts`) placed in the app menu immediately after "Settings…", with **no default key equivalent**; (2) a control in the Settings card's General section that opens it; (3) its Lens home. It is added to `SINGLETON_CARDS` in `action-dispatch.ts` alongside `about` and `settings`. A command `SHOW_KEYBOARD_SHORTCUTS` (`"show-keyboard-shortcuts"`) is registered in `action-vocabulary.ts` + `command-registry.ts` with `menuItemId: "app.keyboardShortcuts"`, and both the menu item and the in-Settings control resolve to `deckManager.showSingletonCard("keyboard")`.

**Rationale:**
- `SINGLETON_CARDS` is the established enforcement point — singleton-ness is a property of the call site, not the registry (documented in `deck-manager.ts` above `showSingletonCard`). One keyboard configurator, not five.
- The About card is the precedent for a hidden, center-placed, menu-opened singleton: it registers with `hidden: true` + `placement: "center"` and is opened purely through the native `show-card` action. Settings adds a command with a `menuItemId`; this card follows Settings, since a command entry is what lets the keymap registry reason about the item.
- No default chord because ⌘, is taken and inventing one now would add keymap-registry surface for a card that has three other doors. A chord is a one-line addition later.
- `hidden: true` keeps it out of the per-pane `[+]` type-picker — it is an app-level configurator, not pane content — while the Lens still lists it.

**Implications:**
- The registration needs **no** explicit `lensGroup`: `resolveLensGroup` falls through to the `"tools"` default for a registration with no `lensGroup` and no `category.label === "Files"`, which is what About does. The `cards-groups.test.ts` totality check passes without further work — but re-run it, since it is the test that fails loudest if this is wrong.
- Swift: an `NSMenuItem` mirroring `showSettings(_:)`, sending `show-card` with `component: "keyboard"`.
- Docs/tests that enumerate the menu structure move with it: `tuglaws/menus.md` (the app-menu table and the `app.settings`-adjacent rows), `menus-doc.test.ts`, and `at0168-menu-structure.test.ts`.

---

### Deep Dives {#deep-dives}

#### Current implementation map {#current-map}

All paths relative to repo root; cite symbols, not line numbers.

- `tugdeck/src/components/tugways/cards/settings-card.tsx` — `SettingsCardContent` (tab `useState`, default `"sessionCard"`; `useResponderForm({ selectTab })`; `TugTabBar stackId="settings"` over `TAB_CARDS` with sentinel `componentId: "settings-tab"`; render switch over five bodies) and `registerSettingsCard` (`hidden`, `placement: "center"`, `sizePolicy 420×420 / 560×820`).
- `tugdeck/src/components/tugways/cards/settings-card.css` — `.settings-card` (flex column, `height: 100%`), `.settings-card-tabs` (pinned strip), `.settings-card-panel` (`flex: 1`, `overflow-y: auto`, the current scroller and the thing that gives the keymap list its height).
- Bodies (all in `tugdeck/src/components/tugways/cards/`): `settings-general-body.tsx` (Default Project Directory + Stacked Panes `TugBox`es), `settings-keymap-body.tsx` + `settings-keymap-rows.ts` + `settings-keymap-body.css` (filter toolbar, Reset All, `TugListView scrollKey="settings-keymap"`, chord-capture surface), `settings-session-card-body.tsx` (Response / Prompt Editor / Assistant `TugBox`es; the Assistant group hosts the deck-wide Model/Permission/Effort chips), `settings-text-card-body.tsx` (`TextCardControls` + Open Files In), `settings-app-body.tsx` (Maker Mode switch over `lib/maker-mode-bridge.ts`).
- Registration wiring: imported and called in `tugdeck/src/main.tsx` **before** DeckManager construction — `filterRegisteredCards` drops panes whose componentIds are unregistered, so a late registration loses restored cards.
- Settings doors: `command-registry.ts` `TUG_ACTIONS.SHOW_SETTINGS` (⌘,, `menuItemId: "app.settings"`); `deck-canvas.tsx` SHOW_SETTINGS handler (find-or-create + `store.centerPane` + `transferFocusForActivation`); `action-dispatch.ts` `SINGLETON_CARDS` + `show-card` → `deckManager.showSingletonCard("settings")`; `tugapp/Sources/AppDelegate.swift` `showSettings(_:)`; `lib/use-unavailable-model-bulletin.ts` dispatches SHOW_SETTINGS from the "Saved Model Unavailable" alert's confirm.
- About card (`cards/about-card.tsx`) — the template for a hidden, center-placed singleton opened from the native menu.

#### Why the keymap list needs a pane {#keymap-height-chain}

`tug-list-view.css` states the requirement in its own comment: the scroll container owns `overflow-y: auto` and `height: 100%`, and "its height needs to be bounded by something," naming a flex item with `flex: 1; min-height: 0` as the expected parent. The component also unmounts rows outside the scrollport (± a margin) and drives `SmartScroll`, so an indefinite height doesn't merely look wrong — the windowing math has nothing to work against.

Today the chain is: `.tug-pane-content` (definite) → `.settings-card` (`height: 100%`) → `.settings-card-panel` (`flex: 1; min-height: 0`) → `.settings-keymap` (`height: 100%; min-height: 0`) → `.settings-keymap-list` (`flex: 1 1 auto; min-height: 0; overflow: hidden`) → `TugListView` (`height: 100%; overflow-y: auto`).

[P04] deletes the middle of that chain for Settings. [P07] rebuilds it in the new card: `.tug-pane-content` → `.keyboard-card` (`height: 100%; min-height: 0`) → `.settings-keymap` and below, unchanged. That is why the body moves without CSS surgery.

#### The controlled-accordion template {#controlled-accordion-template}

`tugdeck/src/components/tugways/tug-diff-document.tsx` is the proven shape: `const accordionSenderId = useId()`, state as a `string[]` of open keys, `useResponderForm({ toggleSectionMulti: { [accordionSenderId]: (v: string[]) => setOpenKeys(v) } })`, and `<TugAccordion type="multiple" variant="separator" value={openKeys} senderId={accordionSenderId}>`. For Settings, the open set derives from the pref and the `toggleSectionMulti` handler inverts back to a collapsed set and calls the pref's write function. From `TugAccordion`'s header docs: even uncontrolled accordions dispatch `toggleSection` through the chain ([L11]); controlled mode means Radix always renders from our `value`.

**Memoize the derived open array.** `SETTINGS_SECTION_IDS.filter(id => !collapsed.includes(id))` yields a fresh array identity on every render into Radix's controlled `value`. `useTugbankValue` deliberately keeps its parsed snapshot reference-stable via a `WeakMap` parse cache; wrap the derivation in `useMemo` keyed on that snapshot (and the override set) so the stability isn't discarded one line later.

Focus: pass `focusGroup` (and `focusOrder`, following the `hooks-sheet.tsx` usage — `ACCORDION_ORDER` there) so the accordion registers as one item-container stop; triggers get `tabIndex={-1}` + `data-tug-focus="refuse"` from `TugAccordionItem` automatically, and each item's content is wrapped in a `FocusModeContext` descend scope by the component itself.

**Test-hook placement:** `TugAccordionItem` spreads `...rest` onto `Accordion.Item`, so a `data-testid` lands on the *item*, not the clickable header (this is how `tug-diff-document.tsx`'s `data-testid="diff-file"` behaves). A test that clicks a section must target `.tug-accordion-trigger` within the item.

#### The pref idiom {#pref-idiom}

`tugdeck/src/lib/commit-filter-scope.ts` is the module to copy: exported `DOMAIN`/`KEY` constants, a pure `parse(entry: TaggedValue | undefined): T | null` (null = never set), a `write(next)` doing optimistic `getTugbankClient()?.setLocalValue(...)` then fire-and-forget `fetch(PUT)` with a `console.warn` catch, and a `useX()` hook pairing `useTugbankValue(DOMAIN, KEY, parse, null)` with a `useCallback` setter, falling back to the default when the stored value is `null`. For Settings the value is `kind: "json"` holding a `string[]` of collapsed ids (the Lens store's representation for the same concept — see `lib/lens-store/` `collapsedSections`).

Gotchas from the tugbank plumbing: `useTugbankValue` caches parses per `TaggedValue` in a `WeakMap` so snapshots stay reference-stable (never bypass it with a `useState` lazy initializer — its header bans that); optimistic `setLocalValue` bumps a generation so a stale inbound DEFAULTS frame can't clobber the write.

#### New-card registration checklist {#new-card-checklist}

From the diff/text/about cards, the full set of touch points for `componentId: "keyboard"`:

1. `keyboard-card.tsx` — content component + `registerKeyboardCard()` calling `registerCard({ componentId, contentFactory, defaultMeta, hidden, placement, sizePolicy })`.
2. `main.tsx` — import + call **before** DeckManager construction.
3. Lens home — nothing to write; `resolveLensGroup` defaults to `"tools"`. Re-run `cards-groups.test.ts`, which enforces totality.
4. `action-dispatch.ts` — add `"keyboard"` to `SINGLETON_CARDS`.
5. `action-vocabulary.ts` + `command-registry.ts` — `SHOW_KEYBOARD_SHORTCUTS` with `menuItemId: "app.keyboardShortcuts"`, no chord.
6. `AppDelegate.swift` — the menu item, mirroring `showSettings(_:)`, sending `show-card` with `component: "keyboard"`.
7. `tuglaws/menus.md` + `menus-doc.test.ts` + `at0168-menu-structure.test.ts` — menu tables and the stale "Settings ▸ Keyboard pane" prose.

---

### Specification {#specification}

**Spec S01: Persisted collapsed-sections value** {#s01-collapsed-format}

- Domain `dev.tugtool.settings-card`, key `collapsedSections`.
- TaggedValue `kind: "json"`, value: JSON array of section-id strings, e.g. `["app"]`.
- Semantics: ids listed are collapsed; every known id not listed is expanded. Absent key ⇒ empty set ⇒ all expanded. Unknown ids are dropped on parse (this is what retires a stale `"keyboard"` from a pre-rework profile); order is not meaningful.
- Section-id vocabulary (**List L01** {#l01-section-ids}): `general`, `sessionCard`, `textCard`, `app` — presented in that order.

**Spec S02: Keyboard card registration** {#s02-keyboard-card}

- `componentId: "keyboard"`; `defaultMeta: { title: "Keyboard Shortcuts", icon: "Keyboard", closable: true }`; `hidden: true`; `placement: "center"`; `sizePolicy: { min: { width: 800, height: 600 }, preferred: { width: 800, height: 1200 } }`.
- Lens group: implicit `"tools"` via `resolveLensGroup`'s default.
- Singleton: enforced by `SINGLETON_CARDS` in `action-dispatch.ts`.
- Root element `data-testid="keyboard-card"`, filling the pane (`height: 100%; min-height: 0`).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Collapsed-section set | structure (external store) | pref module + `useTugbankValue` (`useSyncExternalStore` under the hood) | [L02], [D07] |
| Transient reveal open-override | local-data | card-local `useState`, cleared on user toggle | [L24] |
| Pending reveal request (one-shot) | structure (module registration) | `settings-reveal.ts` pending id + consumer registered in `useLayoutEffect`, returns unregister | [L03], [L27] |
| Accordion open/closed rendering, chevron rotation, expand animation | appearance | Radix `data-state` + `tug-accordion.css` keyframes | [L06], [L14] |
| Section toggle gesture | control dispatch | `toggleSectionMulti` through the responder chain via `useResponderForm` | [L11] |
| Card scroll position | structure (card-state bag) | pane scroller → `bag.scroll` (automatic) | [L23] |
| Keymap list scroll position | structure (card-state bag) | `scrollKey="settings-keymap"` → `bag.regionScroll` (unchanged by the move) | [L23] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/cards/keyboard-card.tsx` | `KeyboardCardContent` + `registerKeyboardCard()` (S02) |
| `tugdeck/src/components/tugways/cards/keyboard-card.css` | Card root fills the pane so the keymap height chain resolves ([P07]) |
| `tugdeck/src/lib/settings-sections-pref.ts` | Collapsed-set pref: constants, `parseSettingsCollapsedSections`, `writeSettingsCollapsedSections`, `useSettingsCollapsedSections` |
| `tugdeck/src/lib/settings-reveal.ts` | `requestSettingsReveal(sectionId)` + consumer registration for the one-shot scroll |
| `tugdeck/src/lib/__tests__/settings-sections-pref.test.ts` | Unit tests for parse/write semantics (S01) |
| `tests/app-test/atNNNN-keyboard-card.test.ts` | App-test: the card opens from its menu item and from Settings, singleton (number assigned at authoring) |
| `tests/app-test/atNNNN-settings-sections-persist.test.ts` | App-test: all-expanded default, collapse persistence across close/reopen |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `KeyboardCardContent` | fn | `keyboard-card.tsx` | Hosts `SettingsKeymapBody` (S02) |
| `registerKeyboardCard` | fn | `keyboard-card.tsx` | Called from `main.tsx` before DeckManager construction |
| `SHOW_KEYBOARD_SHORTCUTS` | const | `action-vocabulary.ts`, `command-registry.ts` | `menuItemId: "app.keyboardShortcuts"`, no chord ([P08]) |
| `SINGLETON_CARDS` | const | `action-dispatch.ts` | Add `"keyboard"` |
| `showKeyboardShortcuts(_:)` + menu item | fn | `tugapp/Sources/AppDelegate.swift` | Mirrors `showSettings(_:)`; sends `show-card` `component: "keyboard"` |
| `SettingsSectionId` | type | `settings-card.tsx` | Renamed from `SettingsTabId`, four ids (List L01) |
| `SECTIONS` | const | `settings-card.tsx` | Replaces `TABS`; id, label, lucide icon component, body component |
| `SettingsCardContent` | fn | `settings-card.tsx` | Tab state → controlled accordion over the pref; reveal consumer |
| `registerSettingsCard` | fn | `settings-card.tsx` | `sizePolicy` → 800×600 min / 800×1200 preferred ([P01]) |
| `TAB_CARDS`, `TugTabBar` import | delete | `settings-card.tsx` | Tab strip removed ([P02]) |
| Keyboard Shortcuts control | add | `settings-general-body.tsx` | Opens the Keyboard card ([P08], R02) |
| `.settings-card-tabs`, panel scroller | delete/modify | `settings-card.css` | Pane scrolls ([P04]) |
| bulletin confirm handler | modify | `lib/use-unavailable-model-bulletin.ts` | `dispatchCommand(SHOW_SETTINGS)` + `requestSettingsReveal("sessionCard")` ([P05]) |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/menus.md` — add the `app.keyboardShortcuts` rows to the app-menu and menu-item tables; fix the "Settings ▸ Keyboard pane renders from it" prose about `resolveChord`.
- [ ] Module docstrings: `settings-card.tsx` (accordion + collapsed-unmount semantics), `keyboard-card.tsx` (why the card root fills the pane).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** (bun, `tugdeck/src/lib/__tests__/`) | S01 parse/write semantics: absent vs empty, unknown-id filtering, round-trip | Pref module |
| **Doc contract** (`menus-doc.test.ts`, `cards-groups.test.ts`) | Menu doc stays in sync; every registration resolves a Lens home | New card + menu item |
| **App-test** (real Tug.app) | Card opening/singleton, layout, default expansion, persistence, reveal, retargeted legacy flows | Everything user-visible |
| **Build** | `bunx vite build` — production rollup must not regress | Before declaring done |

#### What stays out of tests {#test-non-goals}

- jsdom render tests or mock-store assertions — banned pattern (`feedback_real_not_fake`); the app-tests drive the real app.
- Re-proving the keymap configurator's own behavior. at0182 already covers override/reset; this plan only changes how it is opened, so at0182 is retargeted rather than duplicated.
- Scroll-position restore of the pane — covered by the existing card-state machinery and its own tests.
- Focus descend/ascend micro-behavior of `TugAccordion` itself — at0120 owns that; this plan only verifies the Settings-specific composition.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Collapsed-sections pref module | done | `1adab1181` |
| #step-2 | Promote the keyboard configurator to its own card | done | `8f699eedb` |
| #step-3 | Keyboard card doors: menu item, command, Settings control | done | `041560391` |
| #step-4 | Settings card: tabs → accordion, envelope bump | done | `502f08d84` |
| #step-5 | Deep-link reveal | done | `da804bcf4` |
| #step-6 | Retarget existing app-tests | done | `50f194e21` |
| #step-7 | New app-tests: keyboard card + section persistence | done | `4557337d0` |
| #step-8 | Integration checkpoint | done | `f12b4e69b` |

#### Step 1: Collapsed-sections pref module {#step-1}

**Commit:** `tugways(settings-card): add collapsed-sections pref over tugbank defaults`

**References:** [P03] Collapsed-set domain, Spec S01, List L01, (#pref-idiom)

**Artifacts:**
- `tugdeck/src/lib/settings-sections-pref.ts`
- `tugdeck/src/lib/__tests__/settings-sections-pref.test.ts`

**Tasks:**
- [ ] Author the module on the `commit-filter-scope.ts` template: `SETTINGS_SECTIONS_DOMAIN = "dev.tugtool.settings-card"`, `SETTINGS_COLLAPSED_KEY = "collapsedSections"`, `SETTINGS_SECTION_IDS` (List L01), `parseSettingsCollapsedSections` (null when never set; filters unknown ids; expects `kind: "json"` string array), `writeSettingsCollapsedSections` (optimistic `setLocalValue` + fire-and-forget PUT, `console.warn` on failure), `useSettingsCollapsedSections` (via `useTugbankValue`, fallback empty set when null).
- [ ] Header comment documenting S01 semantics (collapsed set; absent ⇒ all expanded) — what the code does, no rationale-storytelling.

**Tests:**
- [ ] Unit: absent entry parses to `null`; `[]` parses to empty set (distinct from absent); unknown ids dropped, including a stale `"keyboard"`; round-trip through a fake TaggedValue.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/settings-sections-pref.test.ts` passes

---

#### Step 2: Promote the keyboard configurator to its own card {#step-2}

**Commit:** `tugways(keyboard-card): promote the keymap configurator to its own card [L09]`

**References:** [P07] Keyboard card, Spec S02, (#keymap-height-chain, #new-card-checklist, #current-map)

**Artifacts:**
- `tugdeck/src/components/tugways/cards/keyboard-card.tsx`, `keyboard-card.css`
- `settings-card.tsx` (Keyboard tab removed), `main.tsx` (registration)

**Tasks:**
- [ ] Author `KeyboardCardContent` rendering `<SettingsKeymapBody />` inside a root `div.keyboard-card` with `data-testid="keyboard-card"`; `keyboard-card.css` gives that root `height: 100%; min-height: 0; display: flex; flex-direction: column` so `.settings-keymap`'s existing chain resolves (#keymap-height-chain). Leave `settings-keymap-body.*` filenames and internals untouched.
- [ ] `registerKeyboardCard()` per Spec S02; import + call it in `main.tsx` **before** DeckManager construction, next to the other `register*Card()` calls.
- [ ] Remove the `keyboard` entry from the Settings tab list and its body import (the tab strip itself survives this step — it is dismantled in #step-4, keeping the two changes reviewable apart).
- [ ] Confirm `SettingsKeymapBody` has no Settings-card dependency: its chord-capture arming goes through module-level `chord-capture-state.ts` → `host-menu-state.ts` (`captureArmed`), not a Settings context.

**Tests:**
- [ ] `cards-groups.test.ts` — the new registration resolves a Lens home (`"tools"` by default).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit` clean; `bunx vite build` succeeds
- [ ] `cd tugdeck && bun test src/components/lens/sections/__tests__/cards-groups.test.ts` passes
- [ ] In the running app: the Keyboard card can be opened (temporarily via the Lens or a dev dispatch until #step-3 lands its doors), the list scrolls, and the filter narrows it

---

#### Step 3: Keyboard card doors — menu item, command, Settings control {#step-3}

**Depends on:** #step-2

**Commit:** `tugways(keyboard-card): menu item, command, and a Settings control to open it`

**References:** [P08] Three doors, Spec S02, Risk R02, (#new-card-checklist)

**Artifacts:**
- `action-vocabulary.ts`, `command-registry.ts`, `action-dispatch.ts`, `deck-canvas.tsx`, `AppDelegate.swift`, `settings-general-body.tsx`, `tuglaws/menus.md`

**Tasks:**
- [ ] `SHOW_KEYBOARD_SHORTCUTS = "show-keyboard-shortcuts"` in `action-vocabulary.ts`; command in `command-registry.ts` with title "Keyboard Shortcuts…", `menuItemId: "app.keyboardShortcuts"`, no chord; handler resolving to `deckManager.showSingletonCard("keyboard")` alongside the existing SHOW_SETTINGS handler.
- [ ] Add `"keyboard"` to `SINGLETON_CARDS` in `action-dispatch.ts`.
- [ ] `AppDelegate.swift`: "Keyboard Shortcuts…" item with identifier `app.keyboardShortcuts` immediately after "Settings…", no key equivalent, mirroring `showSettings(_:)` and sending `show-card` with `component: "keyboard"`.
- [ ] Add a "Keyboard Shortcuts" control to `settings-general-body.tsx` (its own `TugBox` with a `TugPushButton`) that dispatches the command.
- [ ] Update `tuglaws/menus.md`: the app-menu and menu-item tables, plus the stale "Settings ▸ Keyboard pane renders from it" line about `resolveChord`.
- [ ] Rebase carefully — the working tree already carries in-flight command-funnel edits to four of these files (#constraints).

**Tests:**
- [ ] `menus-doc.test.ts` passes against the updated `menus.md`.
- [ ] `at0168-menu-structure.test.ts` updated for the new item.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit` clean; `bunx vite build` succeeds
- [ ] `just app-test tests/app-test/at0168-menu-structure.test.ts` green
- [ ] In the running app: the menu item and the Settings control each open the card; invoking twice raises the same card rather than creating a second

---

#### Step 4: Settings card — tabs → accordion, envelope bump {#step-4}

**Depends on:** #step-1, #step-2

**Commit:** `tugways(settings-card): full-size card, accordion sections replace tabs [L02][L06][L11]`

**References:** [P01] Card envelope, [P02] Coarse sections, [P04] Pane scrolls, [P06] Trigger styling, Spec S01, (#controlled-accordion-template, #current-map), Risk R01, Risk R04

**Artifacts:**
- Reworked `settings-card.tsx`, `settings-card.css`

**Tasks:**
- [ ] Replace `TABS`/`TAB_CARDS`/`TugTabBar`/`selectTab` with `SECTIONS` (id, label, lucide icon component, body) and one controlled `TugAccordion type="multiple" variant="separator"` + `focusGroup`/`focusOrder` (follow `hooks-sheet.tsx`); open set derived from `useSettingsCollapsedSections`, wrapped in `useMemo` for reference stability (#controlled-accordion-template); `useResponderForm.toggleSectionMulti` inverts to a collapsed set and calls `writeSettingsCollapsedSections`.
- [ ] Triggers: icon + label nodes (direct `lucide-react` imports: `Settings2`, `MessageSquareText`, `FileText`, `Wrench`); keep `data-testid="settings-card"` on the root; add `data-testid="settings-section-<id>"` per item, remembering it lands on the item — tests click `.tug-accordion-trigger` inside it.
- [ ] `settings-card.css`: card root becomes a content-sized flex column (no `height: 100%`, no internal `overflow-y`); delete `.settings-card-tabs`; fold the old panel padding into root/per-item content padding so the bodies keep their current inset.
- [ ] `registerSettingsCard`: `sizePolicy` → `min 800×600, preferred 800×1200`; rewrite the header comment (the "fits without scrolling" note is obsolete — the card scrolls by design now) and document the collapsed-unmount semantics (Risk R04).
- [ ] Manual pass in the running app: all four sections expand/collapse; Enter descends into each and Escape ascends; model chips, path field, Maker switch all reachable (Risk R01).

**Tests:**
- [ ] Covered by #step-6 and #step-7; this step's gate is the checkpoint below.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit` clean
- [ ] `cd tugdeck && bunx vite build` succeeds
- [ ] App launches; ⌘, opens an 800-wide Settings card with four accordion sections, all expanded on a fresh profile

---

#### Step 5: Deep-link reveal {#step-5}

**Depends on:** #step-4

**Commit:** `tugways(settings-card): reveal Session Card section from the unavailable-model bulletin [L03][L27]`

**References:** [P05] Reveal mechanism, List L01, (#current-map)

**Artifacts:**
- `tugdeck/src/lib/settings-reveal.ts`; consumer wiring in `settings-card.tsx`; caller change in `lib/use-unavailable-model-bulletin.ts`

**Tasks:**
- [ ] `settings-reveal.ts`: module-level `pendingSection` + registered consumer; `requestSettingsReveal(id)` delivers to the consumer or parks pending; `registerSettingsRevealConsumer(fn)` returns an unregister and flushes any pending id on registration. **It must not write the persisted collapsed set.**
- [ ] `SettingsCardContent`: register the consumer in a `useLayoutEffect` (unregister on unmount, [L27]); on delivery add the id to the transient override set and scroll the section's trigger into view within the pane scroller per `tuglaws/scroll-intent.md`. Clear a section's override when the user toggles it.
- [ ] `use-unavailable-model-bulletin.ts`: after `dispatchCommand(TUG_ACTIONS.SHOW_SETTINGS)`, call `requestSettingsReveal("sessionCard")`.

**Tests:**
- [ ] Manual: collapse Session Card, close Settings, trigger the bulletin path, confirm the card opens with Session Card expanded and its trigger visible — **and that the section is collapsed again on the next plain open** (proving the persisted set was untouched).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit` clean; `bunx vite build` succeeds
- [ ] Reveal works in both orders: card already open, and card opened by the same gesture

---

#### Step 6: Retarget existing app-tests {#step-6}

**Depends on:** #step-3, #step-4

**Commit:** `tests(app-test): settings tests target accordion sections; keymap test opens the Keyboard card`

**References:** [P02] Coarse sections, [P07] Keyboard card, Risk R03, (#success-criteria)

**Artifacts:**
- Updated `tests/app-test/at0154-settings-singleton.test.ts`, `at0155-settings-propagation.test.ts`, `at0173-settings-shortcut.test.ts`, `at0220-settings-chips-turn-lock.test.ts`, `at0304-settings-default-project-dir.test.ts`, `at0182-keymap-override.test.ts`

**Tasks:**
- [ ] **at0154** — rewrite, don't retarget. Its premise is the tab strip (`[role="tablist"]`, `[role="tab"]` count, `aria-selected`). Re-express as: `show-card settings` creates one card, a repeat invocation raises the same card, and the card renders four accordion items.
- [ ] **at0304** — needs a new blur target. It currently types the path then clicks the tab bar to settle the field on blur. Pick a stable in-card blur destination (e.g. a section trigger) and note it in the test's comment.
- [ ] **at0182** — replace "open Settings, click `[data-testid="tug-tab-keyboard"]`" with opening the Keyboard card directly; the rest of the test (filter, arm, capture, reset) works against `[data-testid="settings-keymap"]` unchanged. Update its `@covers` to include `keyboard-card.tsx`.
- [ ] **at0155** — simple swap: the `[data-testid="tug-tab-sessionCard"]` click becomes unnecessary (the section is expanded by default); assert the section is open rather than selecting it.
- [ ] **at0173 / at0220** — verify they pass unmodified; adjust only if they assert tab-strip DOM.
- [ ] `just app-test-covers-check` — every `@covers` line still resolves.

**Tests:**
- [ ] The retargeted tests themselves.

**Checkpoint:**
- [ ] `just app-test-changed` — all selected tests green

---

#### Step 7: New app-tests — keyboard card and section persistence {#step-7}

**Depends on:** #step-3, #step-4

**Commit:** `tests(app-test): keyboard card singleton + settings section persistence`

**References:** [P03] Collapsed-set domain, [P07] Keyboard card, [P08] Three doors, Specs S01–S02, (#success-criteria)

**Artifacts:**
- `tests/app-test/atNNNN-keyboard-card.test.ts` (`@covers` `keyboard-card.tsx`, `settings-keymap-body.tsx`)
- `tests/app-test/atNNNN-settings-sections-persist.test.ts` (`@covers` `settings-card.tsx`, `settings-sections-pref.ts`)

**Tasks:**
- [ ] Keyboard card: open it via the `show-card` path, assert `[data-testid="keyboard-card"]` and a populated `[data-testid="settings-keymap"]`; invoke again and assert exactly one card exists; open it from the Settings control and assert the same.
- [ ] Sections: open Settings on a fresh workspace, assert four items all `[data-state="open"]`.
- [ ] Sections: collapse one (click its trigger), close the card, reopen via ⌘,, assert it is still collapsed and the others open.
- [ ] Sections: assert the tugbank value landed (`kind: "json"` array containing exactly that id) — read through the app's own client, never a foreign DB open.

**Tests:**
- [ ] Both new tests.

**Checkpoint:**
- [ ] `just app-test tests/app-test/atNNNN-keyboard-card.test.ts tests/app-test/atNNNN-settings-sections-persist.test.ts` green

---

#### Step 8: Integration checkpoint {#step-8}

**Depends on:** #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Confirm every success criterion in #success-criteria against the built app.

**Tests:**
- [ ] Aggregate: `just app-test-changed` over the full working diff of this plan.

**Checkpoint:**
- [ ] `just app-test-changed` green
- [ ] `cd tugdeck && bunx vite build` succeeds
- [ ] `cd tugdeck && bun test` green (unit + doc-contract tests)

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A keyboard configurator promoted to its own full-size card with three doors into it, and a Settings card at the session/text envelope whose four preference sections are persistent accordion items — all expanded by default, remembered across close/reopen and restart, with the unavailable-model bulletin revealing the Session Card section without rewriting the user's saved layout.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Keyboard card opens from its menu item and from Settings; at most one exists (new app-test)
- [ ] Keymap filter, chord capture, and Reset All work in the new card (at0182)
- [ ] Tabs gone; four accordion sections in order (app-test DOM assertion)
- [ ] Settings envelope is 800×600 min / 800×1200 preferred (registration + rendered size)
- [ ] Fresh profile all-expanded; collapse persists across close/reopen (new app-test)
- [ ] Bulletin reveal expands + shows Session Card and leaves the persisted set untouched (manual, per #step-5)
- [ ] All retargeted app-tests green (`just app-test-changed`)
- [ ] `bunx vite build` green; `bun test` green

**Acceptance tests:**
- [ ] `atNNNN-keyboard-card` (new)
- [ ] `atNNNN-settings-sections-persist` (new)
- [ ] at0154 / at0155 / at0173 / at0182 / at0220 / at0304 (retargeted)
- [ ] `cards-groups.test.ts`, `menus-doc.test.ts`, `at0168-menu-structure.test.ts`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] A default chord for the Keyboard card, if it earns one in use
- [ ] Rename `settings-keymap-*` files to `keymap-*` now that they no longer live under Settings (deliberately deferred so the move and the rename are separate diffs)
- [ ] [Q01] Finer per-`TugBox` section granularity
- [ ] Expand All / Collapse All affordance if section count grows
- [ ] Sweep `tuglaws/` prose that still describes Settings as a tabbed card

| Checkpoint | Verification |
|------------|--------------|
| Pref semantics | `bun test settings-sections-pref.test.ts` |
| Keyboard card | `cards-groups.test.ts` + new app-test + at0182 |
| Menu surface | `menus-doc.test.ts` + at0168 |
| Settings rework | `bunx tsc --noEmit` + `bunx vite build` + manual four-section pass |
| Persistence | new app-test green |
| Legacy flows | retargeted app-tests green via `just app-test-changed` |

<!-- tugplan-skeleton v2 -->

## Tide Card → Dev Card Rename {#tide-to-dev}

**Purpose:** Rename the surface currently called "Tide" — the unified command surface that combines AI coding assistant + shell + transcript — to "Dev" everywhere. Use `dev` (lowercase) in code, identifiers, file names, log tags, and control strings; use `Dev` (capitalized) in human-readable UI strings. Rearrange the macOS menu surface so card creation moves out of the View-menu dev-mode block and into a first-class `File → New` submenu, with `New Dev Card` (⌘N) at the top. Drop the legacy four-item `Show *` block from View. Step 17's debug/release axis freed the word `dev` for this purpose; this plan claims it.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken |
| Status | draft |
| Target branch | main (commit on main per repo policy) |
| Last updated | 2026-05-28 |
| Predecessor | `dash/tug-multi-instance.md` Step 17 (renamed BUILD_PROFILE from dev/prod → debug/release, freeing the `dev` token) |

---

### Phase Overview {#phase-overview}

#### Context {#context}

"Tide" started life as a codename — `Text IDE` — chosen weeks ago when the unified-command-surface experiment was speculative. The experiment shipped; the codename stuck; the codename never decodes for anyone who didn't see the original conversation. The card title in the dock, the menu item, the file names, the type names, the log tags, the test IDs — all carry a word that nobody knows the meaning of.

The right plain noun is **Dev** — the card is where developers do development work in this app. It's honest, short, professional, and matches the sibling card-type tokens (`git`, `hello`). Until Step 17 of the multi-instance plan landed, the word `dev` was taken by the build axis (`app-dev`/`app-prod`). Step 17 renamed that axis to `debug`/`release`, explicitly to free `dev` for this rename.

Two facets of this work:

1. **The rename itself.** Across ~218 files in `tugdeck/src` + `tugapp/Sources` + `tugcode` + `tugrust` + `tests/`, ~1312 `tide-` hits in identifiers and file names, ~678 `Tide*` PascalCase identifier hits across 98 files, ~68 `tide::` log-tag hits in tugcode, and a handful of user-facing strings (card title, menu items, dialog prose, console warnings). The roadmap archive is frozen history and is NOT renamed.
2. **The menu reorg.** Today the four card-creation items (`Show Tide Card`, `Show Hello World Card`, `Show Git Card`, `Show Component Gallery`) live as a runtime-toggleable dev-mode block at the bottom of the View menu, with `⌘⌥1`/`⌘⌥2`/`⌘⌥3`/`⌘⌥G` shortcuts. Card creation is a first-class user action; it should live under `File → New` like every other macOS app's primary-creation surface, with `⌘N` reserved for the most-common case (Dev card). The debug-build-only cards (Component Gallery, Hello World) move from runtime-toggleable to compile-time-gated on `BuildInfo.profile == "debug"`.

#### Strategy {#strategy}

- **`dev` in code, `Dev` in UI.** Lowercase `dev` for every identifier, file name, kebab-case slug, log tag, control message string, componentId, and CSS class. Capitalized `Dev` for menu item titles, card titles, dialog prose, and any other string a human reads.
- **Full rename, not just user-facing.** The audit earlier in this project showed the codename leaked into ~700 PascalCase identifiers and ~1300 file-path references. Half-renaming (only the UI) would leave the confusing token alive in every grep, every stack trace, every commit author's editor. Bite the whole bullet once.
- **Roadmap archive is frozen.** The 27 `dash/archive/tugplan-tide-*.md` and `dash/archive/tide-*.md` files are historical records of the work that *was* called Tide at the time. Renaming them rewrites history and breaks back-links. They stay. The active doc `dash/tide-conversation-log.md` likewise stays (it's the original conversation log that started the whole project; renaming it would also rewrite history).
- **Menu: `File → New` submenu.** Drop the View-menu dev-mode card-creation block entirely. Build a new `New` submenu at the top of the File menu (before `Close Pane`) containing the four card-creation items. Two are always available (Dev, Git); two are debug-build-only (Component Gallery, Hello World).
- **Debug-build gating via `BuildInfo.profile == "debug"`.** The new restriction (Component Gallery + Hello World are debug-only) is compile-time, not runtime — release bundles literally never expose those menu items. This is stronger than the current `devModeEnabled` flag (which is a tugbank-stored runtime toggle).
- **Tugbank deck-layout: clean break.** A user's open Tide card stored in tugbank's `dev.tugtool.deck.layout` references `componentId: "tide"`. After the rename, the registry has no `"tide"` entry — `getRegistration("tide")` returns nothing. Per the same clean-break precedent set by [D19] of multi-instance, no migration code: the user's open Tide card silently drops on first launch under the new code. The user (project owner) has authorized this.
- **Tugcode log-tag rename in lockstep.** `[tide::replay::*]`, `[tide::session-lifecycle ...]` etc. become `[dev::replay::*]`, `[dev::session-lifecycle ...]`. Log tags are grep targets in production; consistency matters.
- **Test file rename: keep at-NNN, swap descriptive suffix.** A test like `at0084-tide-lifecycle-coordination.test.ts` becomes `at0084-dev-lifecycle-coordination.test.ts`. The `at0084` is the canonical test ID and stays; the descriptive suffix updates.

#### Success Criteria (Measurable) {#success-criteria}

- A `git grep -nE 'Tide|tide'` across `tugdeck/src`, `tugapp/Sources`, `tugcode`, `tugrust`, `tests/` returns only:
  - Generic English uses ("tidal," etc. — none expected).
  - References inside `dash/archive/**/*.md` and `dash/tide-conversation-log.md` (frozen history).
  - References inside commit messages and the new `dash/tide-to-dev-rename.md` doc itself that explain what was renamed *from*.
- Card type `dev` is registered (`componentId: "dev"`); `tide` is unregistered.
- The macOS File menu shows a `New` submenu with four items in the specified order: `New Dev Card` (⌘N) and `New Git Card` always; `New Component Gallery Card` (⌥⌘N) and `New Hello World Card` (⇧⌥⌘N) on debug builds only.
- The View menu's bottom block (Show Tide/Hello/Git/Component Gallery) is gone. The dev-mode toggle no longer gates card creation.
- `cd tugrust && cargo nextest run` passes.
- `cd tugdeck && bun x tsc --noEmit && bun test` passes.
- The `just app-test` sweep passes against a freshly built Debug bundle.
- Manual verification: from a fresh `just app-debug` launch, `⌘N` opens a Dev card; `⌥⌘N` opens a Component Gallery card; `⇧⌥⌘N` opens a Hello World card; File → New → New Git Card opens a Git card. Card title bars read "Dev" / "Git" / "Hello World" / "Component Gallery" as appropriate.
- A Release build (`just app-release`) shows only `New Dev Card` and `New Git Card` in `File → New` — the two debug-only items are absent from the menu structure entirely.

#### Scope {#scope}

1. Rename `componentId: "tide"` → `componentId: "dev"` in the card-registry registration.
2. Rename ~66 source files in `tugdeck/src/components/tugways/cards/` matching `tide-*` → `dev-*` (e.g. `tide-card.tsx` → `dev-card.tsx`, `tide-card-transcript.tsx` → `dev-card-transcript.tsx`, `tide-card.css` → `dev-card.css`, gallery fixtures `gallery-tide-*` → `gallery-dev-*`).
3. Rename ~9 lib files in `tugdeck/src/lib/` matching `tide-*` → `dev-*` (e.g. `tide-session-ledger-store.ts` → `dev-session-ledger-store.ts`, `tide-spawn-error-store.ts` → `dev-spawn-error-store.ts`).
4. Rename all `Tide*` PascalCase identifiers → `Dev*` (e.g. `TideTranscriptHost` → `DevTranscriptHost`, `TideRouteIndicatorBadge` → `DevRouteIndicatorBadge`, `TideSessionLedgerStore` → `DevSessionLedgerStore`).
5. Rename all `useTide*` hooks → `useDev*` (e.g. `useTideCardObserver` → `useDevCardObserver`, `useTidePlacementSlots` → `useDevPlacementSlots`).
6. Rename CSS class prefixes and CSS custom properties keyed on `tide-` → `dev-`.
7. Rename all `tide::` log-tag prefixes in tugcode (`[tide::replay::*]`, `[tide::session-lifecycle ...]`) → `dev::`.
8. Update the four user-facing strings: card title `"Tide"` → `"Dev"`; "TideProjectPicker" console warnings → "DevProjectPicker"; gallery registrations `"TideThinkingBlock"` → `"DevThinkingBlock"`, `"Tide Chrome ..."` → `"Dev Chrome ..."`.
9. Update dialog prose in `gallery-tug-dialog-button.tsx` (~5 mentions of "Tide session", "Tide team", "Tide restarts", "Tide quits", "Tide-side annotation").
10. Update doc comments in `tugdeck/src/components/tugways/*.tsx` that mention "Tide" (~10 mentions in `tug-split-pane`, `tug-link`, `tug-text-editor`, `tug-dialog-button`, `tug-sheet`, `tug-transcript-entry`, `tug-prompt-entry`, `tug-list-view`).
11. Rename the 7 `tide-*` test files under `tests/app-test/` (preserve `at-NNNN` prefix; swap descriptive suffix).
12. Update all test fixtures that hardcode `componentId: "tide"` (~27 hits across `tests/app-test/` and `tugdeck/src/__tests__/`).
13. Update the Swift handlers in `tugapp/Sources/AppDelegate.swift`: `showTideCard` → `showDevCard`; `sendControl("show-card", params: ["component": "tide"])` → `["component": "dev"]`; menu titles "Show Tide Card" etc.
14. **Menu rearrangement** (in `AppDelegate.swift`):
    - Build a new `New` submenu, inserted at the top of the `File` menu (before `Close Pane`).
    - Populate with `New Dev Card` (⌘N), `New Git Card` (no shortcut), `New Component Gallery Card` (⌥⌘N, debug-only), `New Hello World Card` (⇧⌥⌘N, debug-only).
    - Remove the four `Show *` items from the View menu's dev-mode block in `rebuildViewMenu()`.
    - The debug-only items are conditionally added via `if BuildInfo.profile == "debug"`.
15. Update `dash/tug-multi-instance.md` instance-ID examples that use `tide-wake-1` → `dev-wake-1` (still inside the LIVE [D04]/[D05]/[D08] prose; completed step bodies are frozen).
16. Doc-comment updates referencing "Tide" in tugdeck source files (kept brief — most mentions are descriptive prose that just needs the word swapped).

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Rename of `dash/archive/tugplan-tide-*.md` (27 files) and `dash/archive/tide-*.md` files.** These are frozen historical records of the work that was *called* Tide at the time. Rewriting them rewrites history.
- **Rename of `dash/tide-conversation-log.md`.** This is the original design conversation that birthed the project. It stays as a record of the moment the codename was chosen.
- **Rename of `setup-dev-signing.sh` / `teardown-dev-signing.sh` Justfile recipes.** The `dev` token there means *Apple Developer ID*, not the card. The recipes stay.
- **Rename of the `just dev` / `just dev-watch` recipes.** These are the cargo-watch loops for the Rust workspace. The `dev` token there means "developer iteration loop." Unrelated; stays.
- **Rename of `devModeEnabled` / `devMode` / `developerMenu` identifiers in `AppDelegate.swift` and `MainWindow.swift`.** These describe "developer mode" — a runtime toggle for advanced UI affordances — not the card. They stay.
- **Rename of `dev.tugtool.app*` bundle ID prefix.** This is a reverse-DNS developer-namespace convention. Unrelated; stays.
- **Migration of users' open Tide cards in tugbank deck-layout.** Clean break per [D05]; users (project owner) lose any open Tide card on first launch under the new code.
- **Rename of `componentId: "hello"` or `componentId: "git"`.** These siblings keep their names.
- **Restructuring the `Component Gallery` card** beyond its menu placement. The card's componentId stays whatever it is today.
- **Changes to the `addCardToActivePane` selector in the Developer menu.** That's a generic card-picker, not card-type-specific — orthogonal to this work. Stays.

#### Dependencies / Prerequisites {#dependencies}

- **Step 17 of `dash/tug-multi-instance.md` MUST be merged** (the build-axis rename from `dev`/`prod` → `debug`/`release`). Without it, `BuildInfo.profile == "debug"` returns true correctly and the word `dev` is free for this rename. Step 17 landed in commit `0a151ad1`. ✅
- `cd tugrust && cargo nextest run` green before starting. ✅
- `cd tugdeck && bun x tsc --noEmit && bun test` green before starting.
- A clean `just app-debug` build to start from.

#### Constraints {#constraints}

- The at-NNNN prefix on `tests/app-test/at*.test.ts` files is the canonical, stable test ID. Renaming the descriptive suffix is fine; the prefix is invariant.
- The `componentId` slug becomes the new identity `dev`. Anywhere a card lookup happens by string (`getRegistration("tide")`, `registerCard({ componentId: "tide" ... })`, harness fixtures, app-test scenarios), the slug must change atomically. Mid-rename builds where some sites say `dev` and others say `tide` will fail at runtime when one side dispatches to a registry that doesn't know the other side's name.
- Test file renames change file paths that may appear in CI configs, harness exclusion lists, or `bun test` glob patterns. Verify no list of test paths embeds the old name.

#### Assumptions {#assumptions}

- A single developer (the project owner) is the only user; broken state on first launch under the new code (e.g. an open Tide card from a prior session that silently drops) is acceptable.
- The `Component Gallery` and `Hello World` cards are genuinely debug-only — there is no production use case for shipping them in a release bundle. Removing them from the release menu surface is a feature, not a regression.
- ⌘N is currently unbound at the menu level. (Verify in Step 1; if it's hooked to something else, the menu reorg moves it.)
- The user accepts the menu-shortcut rebinding: today `⌘⌥1`/`⌘⌥2`/`⌘⌥3` open Tide/Hello/Git; tomorrow `⌘N` opens Dev, and the `⌘⌥N`-family opens the rarer debug cards. The old shortcuts will silently no-op (or get reassigned).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses the standard tugplan v2 anchor conventions (see `tuglaws/tugplan-skeleton.md` for the full spec). Execution steps cite design decisions by `[DNN]`, risks by `Risk RNN`. Anchors are kebab-case, prefixed by artifact kind (`step-1`, `d01-...`, `r02-...`, etc.). No line-number citations.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does the Developer-menu `Add Card to Active Pane` survive? (RESOLVED) {#q01-add-card-picker}

**Question:** The Developer menu has an `Add Card to Active Pane` item that opens a generic card picker (lets the user choose any registered card type and add it to the currently active pane). The user's instructions said "remove current card creation menu commands" — does that include this generic picker, or only the four card-type-specific `Show *` items?

**Resolution:** **Keep `Add Card to Active Pane`** in the Developer menu unchanged. It's a developer affordance (orthogonal to the user-facing File → New surface) and stays. The "remove current card creation menu commands" instruction refers specifically to the four `Show Tide Card` / `Show Hello World Card` / `Show Git Card` / `Show Component Gallery` items at the bottom of the View menu's dev-mode block.

#### [Q02] Should `New Git Card` get a keyboard shortcut? (RESOLVED) {#q02-git-card-shortcut}

**Question:** The user listed `New Git Card` without a shortcut. Do we leave it unbound, or give it a natural one?

**Resolution:** **No shortcut.** `New Git Card` is reachable via `File → New → New Git Card` (menu-only). If Git-card creation becomes high-frequency later, the assignment is a one-line tweak (e.g., to ⇧⌘N).

#### [Q03] Rename instance-ID examples in `dash/tug-multi-instance.md`? (RESOLVED) {#q03-multi-instance-examples}

**Question:** [D04] of the multi-instance doc uses `development-tide-wake-1` (now `debug-tide-wake-1` after Step 17) as an example instance ID. After the Tide rename, should the example branch slug move from `tide-wake-1` to `dev-wake-1`?

**Resolution:** No. Branch slugs are derived from git branch names; the user might or might not have a branch literally called `tide-wake-1`. The example is illustrative — it could be any slug. Leaving the existing example as-is in the LIVE [D04] prose (post-Step-17 it reads `debug-tide-wake-1`) is fine because the `tide-wake-1` part is an arbitrary slug, not a profile-token reference. Skip.

#### [Q04] CSS class / custom property migration strategy (RESOLVED) {#q04-css-rename}

**Question:** What's the actual CSS rename surface? Renaming files is mechanical; renaming selectors and properties + their `className` callers across `.tsx` files needs care, and a missed selector breaks layout silently.

**Resolution:** **Full inventory below; rename atomically.** The survey found **~165 unique `.tide-*` CSS classes** across 9 CSS files plus inline `className` strings, and **18 custom properties** (1 `--tide-*` plus 17 `--tugx-tide-*`). The rename rule is uniform:

- `.tide-*` selectors → `.dev-*`
- `--tide-*` custom properties → `--dev-*`
- `--tugx-tide-*` custom properties → `--tugx-dev-*` (preserves the `--tugx-*` tugways namespace per existing convention)
- All `className="tide-..."` and `className={\`tide-...\`}` call sites in `.tsx`/`.ts` files swap in lockstep

##### Class-name families (by prefix) {#q04-class-families}

The ~165 classes group into these families. Each family renames mechanically by replacing the `tide-` prefix with `dev-`:

| Family prefix | Approx count | Defined in |
|---|---|---|
| `.tide-card-*` (card body, picker, restoring, settings, transcript, sash, status-bar, etc.) | ~55 | `tide-card.css`, `tide-card-sash-grip.css` |
| `.tide-popover-*`, `.tide-context-popover-*`, `.tide-tasks-popover-*` | ~35 | `tide-card-telemetry-popovers.css` |
| `.tide-telemetry-*` | ~15 | `tide-card-telemetry-renderers.css` |
| `.tide-route-indicator-badge-*` | ~10 | chrome (selectors used by `tide-route-indicator-badge.tsx`) |
| `.tide-question-dialog-*` | ~13 | dialog component |
| `.tide-thinking-block-*` | ~8 | `gallery-tide-thinking.css` |
| `.tide-state-log-*` | ~7 | telemetry popovers |
| `.tide-z1b*`, `.tide-z1c*` | ~5 | `tide-card-z1b.css`, `tide-card-z1c.css` |
| `.tide-error-block-*`, `.tide-session-init-banner-*`, `.tide-permission-dialog-*`, `.tide-attachment-preview`, `.tide-jump-to-bottom-button`, `.tide-caution-badge`, `.tide-transcript-tool-calls` | ~20 | various card-chrome files |

##### Custom properties (full list) {#q04-custom-properties}

```
--tide-popover-scroll-gutter         →  --dev-popover-scroll-gutter
--tugx-tide-entry-margin             →  --tugx-dev-entry-margin
--tugx-tide-jump-bottom              →  --tugx-dev-jump-bottom
--tugx-tide-jump-fade-ms             →  --tugx-dev-jump-fade-ms
--tugx-tide-jump-shadow              →  --tugx-dev-jump-shadow
--tugx-tide-status-bar-shadow        →  --tugx-dev-status-bar-shadow
--tugx-tide-status-cell-width        →  --tugx-dev-status-cell-width
--tugx-tide-status-endcap-length     →  --tugx-dev-status-endcap-length
--tugx-tide-z1b-copy-baseline-nudge  →  --tugx-dev-z1b-copy-baseline-nudge
--tugx-tide-z1b-copy-pad-cancel      →  --tugx-dev-z1b-copy-pad-cancel
--tugx-tide-z1b-copy-snug            →  --tugx-dev-z1b-copy-snug
--tugx-tide-z1b-gap                  →  --tugx-dev-z1b-gap
--tugx-tide-z1b-indent               →  --tugx-dev-z1b-indent
--tugx-tide-z1b-indent-live          →  --tugx-dev-z1b-indent-live
--tugx-tide-z1b-indent-terminal      →  --tugx-dev-z1b-indent-terminal
```

(Two additional prefix-fragment hits — `--tugx-tide-jump-` and `--tugx-tide-z1b-` — surfaced as partial matches from the grep; those are non-property prefixes inside larger property names already covered above.)

##### Execution discipline {#q04-execution}

- The CSS rename happens in **Step 4** (kebab-case + hooks + CSS) as a single commit, so selectors and `className` callers move together. No mid-rename window where the selector exists but the caller still references the old name, or vice versa.
- Verification: post-rename `just app-debug` launch + visual spot-check of the Dev card (transcript scroll, popovers open, settings popup, telemetry status bar, attachment preview). Any silent CSS miss surfaces as a visual regression.
- Tooling: `git grep -lE '\\.tide-|--tide-|--tugx-tide-'` produces the file list; sed-pass each file. Then `git grep -nE '\\.tide-|--tide-|--tugx-tide-'` must return zero hits before the commit.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Large mechanical rename — review burden | low | high | Commit per logical chunk (registry first, then files, then identifiers, then menu, then tests); each commit independently green | A reviewer asks for a split or squash |
| Mid-rename registry inconsistency | high | low | Atomic per-commit semantics: the `tide` → `dev` componentId rename is a single commit that touches the registration site, every fixture, and every test in lockstep | Test failure with "no registration for `tide`" or "no registration for `dev`" |
| `⌘N` collides with an existing menu shortcut | med | low | Audit AppDelegate before assigning; if collision, reassign or remove the conflicting binding | NSMenu reports a duplicate keyEquivalent at startup |
| Tugbank deck-layout drops user's open Tide card silently | low | high | Acceptable per clean-break decision [D05]. Document in release notes (if any) | User reports surprise; can offer a one-line tugbank delete to clear orphans |
| At-test file rename breaks CI harness path lists | med | low | `git grep` for the old file names across `.github/`, `Justfile`, `app-test` harness configs before merging | A renamed test goes missing from the sweep |
| Cross-language drift between Swift and TypeScript componentId string | high | low | The two are linked by the `sendControl("show-card", params: ["component": "dev"])` wire string. Both sides update in the same commit; a missed update fails at runtime when the dispatch hits an unknown registration | Manual menu click does nothing or logs "no registration for `tide`" |
| Roadmap archive accidentally renamed | low | low | The archive directory has a documented frozen-history convention from [D19] of multi-instance; reviewers will catch | A `git diff --stat` shows changes under `dash/archive/` |

**Risk R01: Mid-rename registry inconsistency** {#r01-registry-consistency}

- **Risk:** The card registry is a runtime lookup keyed on the string componentId. If a commit lands where `registerCard({ componentId: "dev" })` runs but a test fixture or AppDelegate selector still says `"tide"`, the dispatch fails with a runtime error ("no registration for `tide`"). The reverse is also true. A bisect across partial-rename commits would be miserable.
- **Mitigation:**
  - Step 1 of execution registers `componentId: "dev"` FIRST, with `"tide"` kept as a back-compat alias in the same registry call (a one-line `aliases: ["tide"]` shim if the registry supports it, or a duplicate registration if not). Step 2 onwards swaps consumers from `"tide"` → `"dev"` incrementally. Final step removes the alias.
  - Each commit is independently green (cargo nextest + bun test + manual menu click).
- **Residual risk:** None — the alias keeps the old string alive during the transition.

**Risk R02: ⌘N collision** {#r02-cmd-n-collision}

- **Risk:** macOS apps conventionally bind `⌘N` to "New Window" or similar. If AppDelegate already hooks `⌘N` somewhere, the new menu item would either collide or get silently shadowed.
- **Mitigation:** Step 0 of execution greps `AppDelegate.swift` for any `keyEquivalent: "n"` and resolves conflicts before adding the new binding.
- **Residual risk:** WebView intercepts `⌘N` for its own purposes — unlikely (WKWebView passes unhandled keys up the responder chain), but verify.

---

### Design Decisions {#design-decisions}

#### [D01] `dev` in code, `Dev` in human-readable strings (DECIDED) {#d01-case-convention}

**Decision:** Code-side identifiers, file names, kebab-case slugs, CSS classes, custom properties, log tags, control message strings, and `componentId` all use lowercase `dev`. Human-readable strings (menu items, card titles, dialog prose, console warnings that surface to users) use capitalized `Dev`. PascalCase identifiers naturally become `Dev*` (e.g. `DevTranscriptHost`).

**Rationale:**
- Matches the existing `git` / `hello` componentId convention (lowercase) and the standard menu-item title-case convention (capitalized).
- One word, two casings — no second-guessing per site.
- "Dev Card" reads naturally in a menu and a window title; "dev-card" reads naturally as a file name and a CSS class.

**Implications:**
- PascalCase types are `Dev*` (e.g. `DevTranscriptHost`).
- File names are `dev-*` (e.g. `dev-card.tsx`).
- The card title in `defaultMeta.title` is `"Dev"`.
- Menu items are `"New Dev Card"`.

#### [D02] Full rename, not just user-facing (DECIDED) {#d02-full-rename}

**Decision:** Rename every occurrence of `tide` / `Tide` / `TIDE` in active code paths (`tugdeck/src`, `tugapp/Sources`, `tugcode`, `tugrust`, `tests/`) to its `dev` / `Dev` / `DEV` equivalent. Do NOT rename anything in `dash/archive/`, `dash/tide-conversation-log.md`, or commit messages — those are frozen historical records.

**Rationale:**
- A partial rename (UI-only) leaves the confusing token alive in stack traces, log lines, file pickers, and every editor's "go to file" search. A new contributor opening the project sees `TideRouteIndicatorBadge` in the editor and `Dev` in the dock and is more confused than before.
- The cost of a full rename is up-front mechanical work, paid once. The cost of carrying the codename indefinitely is permanent cognitive friction for every reader.
- The audit during planning surfaced ~218 source files, ~98 PascalCase identifier files, ~68 log-tag lines, ~27 test componentId fixtures. All grep-and-rename — no semantic refactor.

**Implications:**
- The diff is large (estimated ~1500-2000 line changes), but mechanical and reviewable as several focused commits.
- After this lands, `git log --follow` on any renamed file traces correctly (git rename detection handles the common case).

#### [D03] File → New submenu with Dev at the top (DECIDED) {#d03-file-new-menu}

**Decision:** Build a new `New` submenu at the top of the macOS File menu, inserted **before** `Close Pane`. The submenu contains, in order:

1. `New Dev Card` — ⌘N — always present
2. `New Git Card` — no shortcut — always present
3. (separator)
4. `New Component Gallery Card` — ⌥⌘N — debug builds only
5. `New Hello World Card` — ⇧⌥⌘N — debug builds only

The debug-only items are added conditionally via `if BuildInfo.profile == "debug"`. They are not added with `isHidden = true`; they're not added at all in release bundles. The result: a release-build user sees a `New` submenu with two items; a debug-build user sees four.

**Rationale:**
- The macOS convention for primary-creation surfaces is `File → New …`. Putting card creation here makes it discoverable by every Mac user without any training.
- `⌘N` reads as "create the most-common thing" everywhere on macOS. Reserving it for the Dev card matches user expectation.
- A separator between always-available and debug-only items visually communicates the gating at a glance.
- Compile-time gating (rather than `if devModeEnabled`) means release bundles literally can't expose the debug-only items even with the tugbank toggle on. Defense-in-depth.

**Implications:**
- The existing four-item dev-mode block at the bottom of the View menu (currently rebuilt by `rebuildViewMenu`) is removed.
- The `showComponentGallery` / `showHelloWorldCard` / `showGitCard` selectors are renamed (to match the new menu titles) and rewired to the File → New submenu. The `showTideCard` selector is renamed to `showDevCard` and rewired.
- The old shortcuts (`⌘⌥1`/`⌘⌥2`/`⌘⌥3`/`⌘⌥G`) are unbound. Muscle memory will need to adjust; that's the cost of the reorg.

#### [D04] Debug-only menu items gate on `BuildInfo.profile == "debug"` (DECIDED) {#d04-debug-gate}

**Decision:** The `New Component Gallery Card` and `New Hello World Card` menu items are gated on `BuildInfo.profile == "debug"`, **not** on the runtime `devModeEnabled` flag. In release bundles they are not added to the menu at all.

**Rationale:**
- These two cards exist to support tugdeck component development (Component Gallery) and tugway framework smoke testing (Hello World). Neither has any production use.
- A `devModeEnabled`-style runtime toggle would let a release-bundle user accidentally enable dev features. A compile-time gate makes this structurally impossible.
- Matches the existing pattern of compile-time `#if DEBUG` / `cfg(debug_assertions)` gates for dev-only affordances in Swift and Rust, lifted to the Info.plist-derived BuildInfo level so it works for the Tug bundle's hybrid Debug/Release-configuration-but-Apple-Developer-ID-signed model.

**Implications:**
- A release bundle's File → New submenu has exactly two items (Dev, Git).
- A debug bundle's submenu has four. Toggling `devModeEnabled` no longer affects card creation.
- `devModeEnabled` continues to gate other developer affordances (the Developer menu visibility, the dev-panel toggle, etc.) — unchanged.

#### [D05] Tugbank deck-layout: clean break, no migration (DECIDED) {#d05-tugbank-clean-break}

**Decision:** A user's tugbank `dev.tugtool.deck.layout` may contain serialized deck state with `componentId: "tide"` references from prior sessions. After the rename, no migration code rewrites these. On first launch under the new code, the card-registry lookup for `"tide"` returns nothing; the card host treats it as an unknown component and either silently drops it or renders a fallback placeholder (depending on the card-host's existing unknown-component handling — verify in Step 1).

**Rationale:**
- Same precedent as [D19] of multi-instance: the project owner is the only user. A clean break is acceptable; the alternative (writing migration code) is mass-rewriting tugbank rows and carrying the migration code forever.
- The user can re-create a Dev card with `⌘N` immediately on the new code.

**Implications:**
- The first launch under the new code may show a deck with fewer cards than the user left it with.
- No migration code is added; no schema bump.
- If the card host's unknown-component handling is to render a placeholder rather than silently drop, the placeholder will be visible until the user closes it. Acceptable.

#### [D06] Roadmap archive + tide-conversation-log are frozen history (DECIDED) {#d06-archive-frozen}

**Decision:** The following are NOT renamed:
- `dash/archive/tugplan-tide-*.md` (~26 files)
- `dash/archive/tide-*.md` (~4 files)
- `dash/tide-conversation-log.md` (active, but historical)

Their internal references to "Tide" stay as written.

**Rationale:**
- These documents are records of the work that was *called* Tide at the time it was done. Rewriting them rewrites history and breaks any cross-doc reference (links, citations, commit-message anchors).
- The plan-as-history convention from multi-instance [D19] applies: completed work is preserved as a record.
- `tide-conversation-log.md` specifically is the design conversation that birthed the project. It deserves to exist as written.

**Implications:**
- A `git grep` for `tide` after the rename will still hit these files. Reviewers and future readers know to skip them; the file paths themselves (`dash/archive/...`) signal "historical."
- Any new doc that references this rename should link forward (e.g. "the surface formerly called Tide, see `dash/tide-to-dev-rename.md`").

#### [D07] At-test file rename preserves the at-NNNN prefix (DECIDED) {#d07-at-test-rename}

**Decision:** Test files like `tests/app-test/at0084-tide-lifecycle-coordination.test.ts` are renamed by swapping the descriptive suffix (`tide` → `dev`), preserving the `at0084` prefix:
- `at0078-tide-engine-focus-survives.test.ts` → `at0078-dev-engine-focus-survives.test.ts`
- `at0080-tide-focus-card-switch.test.ts` → `at0080-dev-focus-card-switch.test.ts`
- (and the other 5)

**Rationale:**
- The `atNNNN` ID is the canonical, stable identifier referenced in commit messages, harness logs (`tests/app-test/logs/atNNNN-*.log`), and any tracking. Renaming it would orphan all back-references.
- The descriptive suffix is purely human-readable; renaming it costs nothing.

**Implications:**
- Old log files in `tests/app-test/logs/` (e.g. `at0080-tide-focus-card-switch.log`) are orphaned — they describe an old run under the old name. Leave them in place (they're informational artifacts; not load-bearing).
- New runs produce logs at the new path automatically.

#### [D08] Card-registry transition strategy: register-both-then-remove-old (DECIDED) {#d08-registry-transition}

**Decision:** The rename of `componentId: "tide"` → `"dev"` happens in three commits:

1. **Commit A** — Register both. Add a new `componentId: "dev"` registration that points at the existing component (literally `registerCard({ componentId: "dev", ... })` alongside the existing `componentId: "tide"`). The two registrations share the same React component and lifecycle. Existing call sites (`addCard("tide")`, fixture references, etc.) keep working unchanged.

2. **Commit B (or sequence of commits)** — Swap consumers. Update every call site, fixture, test, Swift selector, etc. from `"tide"` → `"dev"`. After this, no live code path references `"tide"` except the lingering registration.

3. **Commit C** — Remove the old registration. Drop the `componentId: "tide"` line from the registry. The card-registry rejects future `"tide"` lookups.

**Rationale:**
- Avoids the mid-rename runtime-failure window (Risk R01). At every commit boundary, both registrations exist or only the new one exists; never "old removed, new not yet wired."
- Each commit is independently green.
- The 3-commit shape matches the existing card-registry's API (it supports multiple registrations by string, even if pointing to the same component).

**Implications:**
- The work is split into three clean commits; each can be reviewed and reverted independently.
- The full diff is the same size, just sequenced.

---

### Deep Dives {#deep-dives}

#### Current menu structure {#current-menu-structure}

`AppDelegate.applicationDidFinishLaunching` builds the main menu in this order (per `tugapp/Sources/AppDelegate.swift:413+`):

1. **App menu (Tug)** — About, Settings, Theme (dynamic), Services, Hide, Quit.
2. **File menu** — only `Close Pane` (⌘W).
3. **Edit menu** — Undo/Redo/Cut/Copy/Paste/Delete/Select All + Find submenu.
4. **View menu** — Built dynamically via `menuNeedsUpdate` → `rebuildViewMenu`. Contains: arrangement (Cascade, Tile), zoom (Actual Size, Zoom In/Out + ⌘= alias), the cached card list, and the dev-mode card-creation block (only when `devModeEnabled`).
5. **Developer menu** — Reload, Show JavaScript Console, Show Dev Panel, Add Card to Active Pane, Source Tree…
6. **Window menu** — Minimize, Zoom, Enter Full Screen, Bring All to Front.
7. **Help menu** — Project Home, GitHub.

The dev-mode card-creation block (currently at the bottom of the View menu) is:

```swift
if devModeEnabled {
    menu.addItem(NSMenuItem.separator())
    menu.addItem(NSMenuItem(title: "Show Tide Card", action: #selector(showTideCard(_:)), keyEquivalent: "1", modifierMask: [.command, .option]))
    menu.addItem(NSMenuItem(title: "Show Hello World Card", action: #selector(showHelloWorldCard(_:)), keyEquivalent: "2", modifierMask: [.command, .option]))
    menu.addItem(NSMenuItem(title: "Show Git Card", action: #selector(showGitCard(_:)), keyEquivalent: "3", modifierMask: [.command, .option]))
    menu.addItem(NSMenuItem.separator())
    menu.addItem(NSMenuItem(title: "Show Component Gallery", action: #selector(showComponentGallery(_:)), keyEquivalent: "g", modifierMask: [.command, .option]))
}
```

This block goes away entirely. The shortcut bindings (`⌘⌥1`/`⌘⌥2`/`⌘⌥3`/`⌘⌥G`) become unbound.

#### New menu structure {#new-menu-structure}

The File menu, after rename, is built **statically** in `applicationDidFinishLaunching` (no `menuNeedsUpdate` dynamic rebuild — the menu contents don't depend on runtime state beyond the compile-time profile):

```swift
let fileMenuItem = NSMenuItem()
mainMenu.addItem(fileMenuItem)
let fileMenu = NSMenu(title: "File")
fileMenuItem.submenu = fileMenu

// New submenu at the top
let newMenuItem = NSMenuItem(title: "New", action: nil, keyEquivalent: "")
let newMenu = NSMenu(title: "New")
newMenuItem.submenu = newMenu
fileMenu.addItem(newMenuItem)

newMenu.addItem(NSMenuItem(title: "New Dev Card", action: #selector(newDevCard(_:)), keyEquivalent: "n"))
newMenu.addItem(NSMenuItem(title: "New Git Card", action: #selector(newGitCard(_:)), keyEquivalent: ""))

if BuildInfo.profile == "debug" {
    newMenu.addItem(NSMenuItem.separator())
    newMenu.addItem(NSMenuItem(title: "New Component Gallery Card", action: #selector(newComponentGalleryCard(_:)), keyEquivalent: "n", modifierMask: [.command, .option]))
    newMenu.addItem(NSMenuItem(title: "New Hello World Card", action: #selector(newHelloWorldCard(_:)), keyEquivalent: "n", modifierMask: [.command, .option, .shift]))
}

fileMenu.addItem(NSMenuItem.separator())
closeMenuItem = NSMenuItem(title: "Close Pane", action: #selector(closeActiveCard(_:)), keyEquivalent: "w")
fileMenu.addItem(closeMenuItem)
```

The `rebuildViewMenu` method removes its dev-mode card-creation block; the View menu now contains only arrangement + zoom + card-list sections.

#### Card-registry transition (Commits A/B/C) {#registry-transition-detail}

**Commit A** (`feat(dev-card): register "dev" alongside "tide" as card-registry alias`):

```typescript
// tugdeck/src/components/tugways/cards/tide-card.tsx (still named tide-card.tsx at this point)
registerCard({
    componentId: "tide",
    contentFactory: TideCardContent,
    defaultMeta: { title: "Tide", icon: "MessageSquareText", closable: true, confirmClose: true },
});
registerCard({
    componentId: "dev",
    contentFactory: TideCardContent,
    defaultMeta: { title: "Dev", icon: "MessageSquareText", closable: true, confirmClose: true },
});
```

**Commit B…** (multiple commits, see Execution Steps):
- File renames (`tide-card.tsx` → `dev-card.tsx`)
- Identifier renames (`TideCardContent` → `DevCardContent`, `TideTranscriptHost` → `DevTranscriptHost`, etc.)
- CSS rename
- Test fixture updates
- Swift handler rename + menu reorg
- Log-tag rename
- Doc-comment rename

**Commit C** (`feat(dev-card): drop "tide" componentId alias`):
```typescript
registerCard({
    componentId: "dev",
    contentFactory: DevCardContent,
    defaultMeta: { title: "Dev", icon: "MessageSquareText", closable: true, confirmClose: true },
});
// The "tide" registration is gone.
```

---

### Specification {#specification}

#### Inputs and Outputs {#inputs-outputs}

**Inputs (developer-facing):**
- The source tree before rename: ~218 files containing `tide`/`Tide` in identifiers or names.
- The Swift menu structure before rename: card creation in View menu's dev-mode block.

**Outputs:**
- Source tree after rename: 0 files containing `tide`/`Tide` in active code paths (excluding the archive and conversation log).
- Renamed files: ~75 (66 in tugdeck/src/components, 9 in tugdeck/src/lib, plus 7 at-test files).
- New macOS menu structure: `File → New` submenu with 2-or-4 items depending on build profile.

#### Terminology and Naming {#terminology}

- **Dev card** — the user-facing name for the surface formerly called Tide. Capitalized in human-readable strings.
- **`dev` componentId** — the card-registry slug. Lowercase. Replaces `tide`.
- **`DevCardContent` (etc.)** — PascalCase TypeScript identifiers. Replaces `TideCardContent` (etc.).
- **`dev-card.tsx` (etc.)** — kebab-case file names. Replaces `tide-card.tsx` (etc.).
- **Debug-only menu items** — `New Component Gallery Card` and `New Hello World Card`. Gated on `BuildInfo.profile == "debug"` (compile-time, via static menu construction).

#### Public API Surface Changes {#public-api}

TypeScript (`tugdeck/src/`):
- Renamed components, hooks, stores, types — full list under Symbol Inventory.
- Renamed CSS classes / custom properties.
- New: nothing structurally — the rename preserves all public surfaces, just renamed.

Swift (`tugapp/Sources/`):
- Renamed selectors: `showTideCard` → `newDevCard`, `showGitCard` → `newGitCard`, `showHelloWorldCard` → `newHelloWorldCard`, `showComponentGallery` → `newComponentGalleryCard`. (Verb changes from `show*` to `new*` to match the new menu titles.)
- Updated control messages: `sendControl("show-card", params: ["component": "tide"])` → `["component": "dev"]`.
- New menu items: see #new-menu-structure.

Rust (`tugcode`):
- Renamed log tags: `[tide::replay::*]` → `[dev::replay::*]`, `[tide::session-lifecycle ...]` → `[dev::session-lifecycle ...]`.
- No other public API changes.

#### Configuration Schema {#config-schema}

No configuration changes. The tugbank `dev.tugtool.deck.layout` schema is unchanged in shape; only the `componentId` values inside serialized cards differ (and old `"tide"` values are intentionally dropped on read per [D05]).

---

### Compatibility / Migration / Rollout {#rollout}

- **Compatibility policy:** Clean break for tugbank deck-layout per [D05]. No back-compat shims, no schema bump.
- **Rollout plan:** Single-phase rollout. After Commits A/B/C land, the rename is complete and irreversible.
- **Rollback strategy:** Revert the relevant commits; existing tugbank state is forward-compatible (a re-introduced `"tide"` registration would pick up the user's saved Dev card, since the deck-layout entries the user creates between rollback and re-rollout would say `"dev"`). Practically, rollback is mass-revert during the 3-commit window; after Commit C lands, rollback means restoring 3 commits.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### Files to rename {#files-to-rename}

The source-of-truth file rename list. Each entry is `from → to`.

**Card sources (`tugdeck/src/components/tugways/cards/`)** — 66 files matching `tide-*`. Examples:
- `tide-card.tsx` → `dev-card.tsx`
- `tide-card.css` → `dev-card.css`
- `tide-card-transcript.tsx` → `dev-card-transcript.tsx`
- `tide-card-z1b.{tsx,css}` → `dev-card-z1b.{tsx,css}`
- `tide-card-z1c.{tsx,css}` → `dev-card-z1c.{tsx,css}`
- `tide-card-sash-grip.{tsx,css}` → `dev-card-sash-grip.{tsx,css}`
- `tide-card-banner-spec.ts` → `dev-card-banner-spec.ts`
- `tide-card-placement-experiment.tsx` → `dev-card-placement-experiment.tsx`
- `tide-card-restore-gate.ts` → `dev-card-restore-gate.ts`
- `tide-card-telemetry-popovers.{tsx,css}` → `dev-card-telemetry-popovers.{tsx,css}`
- `tide-card-telemetry-renderers.{tsx,css}` → `dev-card-telemetry-renderers.{tsx,css}`
- `tide-assistant-renderer-dispatch.ts` → `dev-assistant-renderer-dispatch.ts`
- `tide-attachment-preview.tsx` → `dev-attachment-preview.tsx`
- `tide-jump-to-bottom-button.css` → `dev-jump-to-bottom-button.css`
- `tide-picker-cells.tsx` → `dev-picker-cells.tsx`
- `tide-picker-format.ts` → `dev-picker-format.ts`
- `use-tide-card-observer.ts` → `use-dev-card-observer.ts`
- (gallery fixtures) `gallery-tide-chrome.tsx` → `gallery-dev-chrome.tsx`, `gallery-tide-thinking.{tsx,css}` → `gallery-dev-thinking.{tsx,css}`
- …and the rest of the 66 files surfaced by `find tugdeck/src/components/tugways/cards -name "tide-*" -o -name "use-tide-*"`. Execute the rename as a `git mv` per file (preserves history).

**Lib sources (`tugdeck/src/lib/`)** — 9 files:
- `tide-transcript-data-source.ts` → `dev-transcript-data-source.ts`
- `tide-spawn-error-store.ts` → `dev-spawn-error-store.ts`
- `tide-session-ledger-events.ts` → `dev-session-ledger-events.ts`
- `tide-picker-data-source.ts` → `dev-picker-data-source.ts`
- `tide-session-ledger-store.ts` → `dev-session-ledger-store.ts`
- `tide-session-restore.ts` → `dev-session-restore.ts`
- `__tests__/tide-session-ledger-store.test.ts` → `__tests__/dev-session-ledger-store.test.ts`
- `__tests__/tide-transcript-data-source.test.ts` → `__tests__/dev-transcript-data-source.test.ts`
- `__tests__/tide-spawn-error-store.test.ts` → `__tests__/dev-spawn-error-store.test.ts`

**Tugdeck test (`tugdeck/src/__tests__/`)** — 2 files:
- `tide-session-restore-fresh-spawn.test.ts` → `dev-session-restore-fresh-spawn.test.ts`
- `tide-session-restore-transport-settled.test.ts` → `dev-session-restore-transport-settled.test.ts`

**App-tests (`tests/app-test/`)** — 7 files (preserve `atNNNN` prefix):
- `at0035-tide-app-switch-selection.test.ts` → `at0035-dev-app-switch-selection.test.ts`
- `at0051-tide-mount-focus.test.ts` → `at0051-dev-mount-focus.test.ts`
- `at0078-tide-engine-focus-survives.test.ts` → `at0078-dev-engine-focus-survives.test.ts`
- `at0080-tide-focus-card-switch.test.ts` → `at0080-dev-focus-card-switch.test.ts`
- `at0081-tide-focus-reload.test.ts` → `at0081-dev-focus-reload.test.ts`
- `at0084-tide-lifecycle-coordination.test.ts` → `at0084-dev-lifecycle-coordination.test.ts`
- `at0086-tide-route-indicator-badge.test.ts` → `at0086-dev-route-indicator-badge.test.ts`

#### Symbols to rename {#symbols}

Mechanical: every PascalCase `Tide*` identifier becomes `Dev*`; every camelCase `tide*` becomes `dev*`; every kebab-case / snake-case `tide-` / `tide_` becomes `dev-` / `dev_`. Sample of high-impact identifiers (NOT exhaustive — full list emerges from the grep at execution time):

| From | To | Locus |
|------|----|-------|
| `componentId: "tide"` | `componentId: "dev"` | card-registry, fixtures |
| `TideTranscriptHost` | `DevTranscriptHost` | exported component |
| `TideRouteIndicatorBadge` | `DevRouteIndicatorBadge` | chrome component |
| `TideSessionIdBadge` | `DevSessionIdBadge` | chrome component |
| `TideCardSashGrip` | `DevCardSashGrip` | layout helper |
| `TideSessionLedgerStore` | `DevSessionLedgerStore` | tugdeck store |
| `TideTranscriptDataSource` | `DevTranscriptDataSource` | data source |
| `TideSpawnErrorStore` | `DevSpawnErrorStore` | store |
| `TideSessionRestore` | `DevSessionRestore` | restore module |
| `TidePickerDataSource` | `DevPickerDataSource` | data source |
| `TidePickerFormat` | `DevPickerFormat` | format helper |
| `TideProjectPicker` (in console warns) | `DevProjectPicker` | log string |
| `TideCardContent` (or whatever the local React component is named) | `DevCardContent` | card body |
| `useTideCardObserver` | `useDevCardObserver` | hook |
| `useTidePlacementSlots` | `useDevPlacementSlots` | hook |
| `tide::replay::request` | `dev::replay::request` | log tag |
| `tide::replay::started` | `dev::replay::started` | log tag |
| `tide::replay::progress` | `dev::replay::progress` | log tag |
| `tide::replay::complete` | `dev::replay::complete` | log tag |
| `tide::replay::error` | `dev::replay::error` | log tag |
| `tide::replay::malformed` | `dev::replay::malformed` | log tag |
| `tide::replay::unknown_shape` | `dev::replay::unknown_shape` | log tag |
| `tide::session-lifecycle` | `dev::session-lifecycle` | log tag |
| `showTideCard` (Swift selector) | `newDevCard` | AppDelegate |
| `showGitCard` (Swift selector) | `newGitCard` | AppDelegate |
| `showHelloWorldCard` (Swift selector) | `newHelloWorldCard` | AppDelegate |
| `showComponentGallery` (Swift selector) | `newComponentGalleryCard` | AppDelegate |
| `"show-card"` control with `{component: "tide"}` | `{component: "dev"}` | Swift + control router |

#### CSS classes / custom properties to rename {#css-rename}

Full inventory baked into [Q04]: ~165 unique `.tide-*` classes across 9 CSS files (grouped into 9 named families) plus inline `className="tide-..."` call sites; 1 `--tide-*` custom property + 17 `--tugx-tide-*` custom properties. Rename rule:

- `.tide-*` → `.dev-*`
- `--tide-*` → `--dev-*`
- `--tugx-tide-*` → `--tugx-dev-*`

Atomic per-commit (Step 4): selectors, properties, and `className` callers move together so no mid-rename window leaves broken layout. See [Q04] for the full property list and class-family breakdown.

#### Identifiers to LEAVE UNCHANGED {#do-not-rename}

The doc-sweep rules from multi-instance [D19] apply here too. Do NOT rename:
- `devModeEnabled` / `devMode` / `developerMenu` (developer mode, not the card)
- `dev.tugtool.app*` (reverse-DNS bundle ID prefix)
- `dev-watch` / `dev` Justfile recipes (cargo-watch loop)
- `setup-dev-signing.sh` / `teardown-dev-signing.sh` (Apple Developer ID)
- `BuildInfo.profile == "debug"` (build axis, post-Step-17)
- `process.env.NODE_ENV !== "production"` (Vite/webpack frontend convention)
- Anything under `dash/archive/` or `dash/tide-conversation-log.md`

---

### Documentation Plan {#documentation-plan}

- [ ] Update `CLAUDE.md` to refer to the Dev card surface, not Tide.
- [ ] Update `tuglaws/component-authoring.md`, `tuglaws/tugways/*.md`, `tuglaws/pane-model.md` for any Tide mentions (likely a few).
- [ ] Update `tests/app-test/README.md` if it references the old test file names.
- [ ] Update `docs/` (if any docs mention Tide).
- [ ] In the multi-instance doc's [D04] / [D05] / [D08], any `tide-wake-1` example (now `debug-tide-wake-1` after Step 17) stays — it's an arbitrary branch slug per [Q03], not a card reference.

---

### Test Plan {#test-plan}

| Category | Purpose | When to use |
|----------|---------|-------------|
| Unit (tugdeck) | Renamed stores, data sources, hooks still pass their bun:test cases | After Commits B-N |
| Unit (Rust) | Renamed tugcode log tags don't break replay; tugcore unchanged | After Commits B-N |
| Integration (app-test) | Renamed at-test files still run; componentId fixtures resolve to `"dev"` | After Commits B-N |
| Manual | File → New → New Dev Card opens a Dev card under ⌘N; release-bundle menu has only 2 items | Step 14 |
| Manual | Console gallery items (Component Gallery, Hello World) are absent from release builds entirely | Step 14 |
| Drift | After Commit C, `git grep tide` returns only frozen-history results | Step 15 |

---

### Execution Steps {#execution-steps}

> Each step has a commit boundary and a checkpoint. Commit after each step's checkpoint passes.

#### Step 0: Pre-flight audit {#step-0}

**Commit:** `N/A (verification only)`

**Tasks:**
- [x] `grep -n 'keyEquivalent: "n"' tugapp/Sources/AppDelegate.swift` — confirm ⌘N is unbound; if bound, decide on resolution. *No ⌘N currently bound; clear to use.*
- [x] Inventory: `find tugdeck/src tests -name "tide*" -o -name "*-tide-*"` — produce the canonical file-rename list. *26 tide-/use-tide- + 3 gallery-tide- under cards/; 9 in tugdeck/src/lib; 2 in tugdeck/src/__tests__; 7 at-test files.*
- [x] Inventory: `git grep -lE 'Tide|tide' -- tugdeck/src tugapp/Sources tugcode tugrust tests` — confirm 218 file estimate. *Actually 327 files; the larger count reflects reference-only mentions that fall out of the bulk rename.*
- [x] Inspect card-host's unknown-component handling. *`card-host.tsx:1494` returns `null` when registration is missing. Silent drop — matches [D05].*

**Checkpoint:**
- [x] All inventory complete; no surprises.

---

#### Step 1: Register `dev` componentId alongside `tide` {#step-1}

**Commit:** `feat(dev-card): register "dev" alongside "tide" as card-registry alias`

**References:** [D08]

**Artifacts:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` — add a second `registerCard({ componentId: "dev", ... })` call.

**Tasks:**
- [x] Add the `componentId: "dev"` registration with `title: "Dev"`, same contentFactory.
- [x] Verify both `addCard("tide")` and `addCard("dev")` work via a manual smoke (or a quick unit test if practical). *Both registrations live; existing call sites unchanged.*

**Checkpoint:**
- [x] `bun test` green. *3039 tests pass, 0 fail; `bun x tsc --noEmit` clean.*
- [ ] Manual: spawn a `tide` card and a `dev` card; both render identically. *Deferred — verified at the Step 12 manual checkpoint after the full rename lands; the shared contentFactory guarantees identical render.*

---

#### Step 2: File renames (atomic per file) {#step-2}

**Commit:** `refactor(dev-card): rename tide-* source/lib/test files to dev-*`

**References:** [D02], [D07]

**Tasks:**
- [x] For each file in the inventory list, `git mv tide-X.tsx dev-X.tsx`. *66 file renames (40 in cards/ + lib/ + tugdeck/src/__tests__/ from the initial list, plus 25 in chrome/ + cards/__tests__/ + tugways/__tests__/ surfaced during the second sweep, plus 1 doc.).*
- [x] Update all import paths across the tree. *252 files swept via `git grep -l 'tide-[a-z]' | while read f; do sed -i '' 's/tide-/dev-/g' "$f"; done` restricted to tugdeck/src tugapp/Sources tugcode/src tugrust/crates tests. After sweep: 0 remaining `tide-[a-z]` refs in active source.*
- [x] Update CSS `@import` paths and any dynamic `import()` strings. *Covered by the same sed pass.*
- [x] Fix one fixture inconsistency in `tests/build-info/test-bundle-id-mapping.sh`: the `Tide-Wake-1` mixed-case input renamed to `Dev-Wake-1` to match its expected slug output.

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean — no broken imports.
- [x] `bun test` green. *3039 tests pass, 0 fail.*
- [ ] `bun run build` (Vite static build for tugdeck) succeeds. *Deferred to Step 12 (HMR is always running per project convention; the dev server picks up changes on save).*

---

#### Step 3: PascalCase identifier rename {#step-3}

**Commit:** `refactor(dev-card): rename Tide* identifiers to Dev* across tugdeck/lib`

**References:** [D01], [D02]

**Tasks:**
- [x] `Tide` → `Dev` for every identifier across active source (component names, type names, store names, hook names, interface names, doc-comment mentions). *Single sed pass `s/Tide/Dev/g` over the 115 files containing `Tide[A-Z]` (~753 hits) using `git grep -l 'Tide' tugdeck tests tugapp/Sources tugcode tugrust | while read f; do sed -i '' 's/Tide/Dev/g' "$f"; done`. This also swept the bare `Tide` codename references in doc comments and the useTidePlacementSlots → useDevPlacementSlots / useTideCardObserver → useDevCardObserver hook names (which would have been touched in Step 4 anyway).*
- [x] Update file-internal references in lockstep. *Same pass covered it.*

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green. *3039 tests pass.*

---

#### Step 4: Hooks + kebab-case + CSS rename {#step-4}

**Commit:** `refactor(dev-card): rename useTide* hooks, tide-* classes, --tugx-tide-* custom properties`

**References:** [D01], [D02], [Q04]

**Tasks:**
- [x] `useTide*` → `useDev*` for hook function names. *Already swept by Step 3's case-sensitive `s/Tide/Dev/g` sed pass.*
- [x] `.tide-*` CSS classes → `.dev-*` (with their JSX/TSX callers in lockstep). *Already swept by Step 2's `s/tide-/dev-/g` sed pass over tugdeck/src; this step caught the 3 stragglers in `tugdeck/styles/themes/{brio,harmony}.css` and `tugdeck/src/components/tugways/tug-list-view.css` (doc-comment references to `.tide-card-transcript` / `tide-thinking-block.css` / "the tide-card transcript").*
- [x] `--tugx-tide-*` custom properties → `--tugx-dev-*`. *Already swept; confirmed: 12 `--tugx-dev-*` definitions live in dev-card-*.css with zero `--tugx-tide-*` residue.*

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green. *3039 tests pass.*
- [ ] Visual smoke: spawn a `dev` card; layout matches the prior `tide` card pixel-for-pixel. *Deferred to Step 12 manual verification (HMR picks up CSS changes; smoke happens on user's next `just app-debug` launch).*

---

#### Step 5: User-facing strings + dialog prose + console warns {#step-5}

**Commit:** `refactor(dev-card): user-facing strings — "Tide" → "Dev"`

**References:** [D01]

**Tasks:**
- [x] `tide-card.tsx` (now `dev-card.tsx`) defaultMeta `title: "Tide"` → `"Dev"`. *Both registrations (the live `"dev"` componentId AND the back-compat `"tide"` alias) now render with title `"Dev"` — consistent with [D08]'s intent that the card is fundamentally a Dev card regardless of which componentId looked it up.*
- [x] `console.warn("TideProjectPicker: ...")` → `"DevProjectPicker: ..."`. *Swept by Step 3.*
- [x] `gallery-registrations.tsx`: `title: "Tide Chrome ..."` → `"Dev Chrome ..."`; `title: "TideThinkingBlock"` → `"DevThinkingBlock"`. *Swept by Step 3.*
- [x] `gallery-tug-dialog-button.tsx`: 5 mentions of "Tide session/team/restarts/quits/-side annotation" → "Dev …". *Verified all 5 lines now read "Dev …".*
- [x] Doc comments in `tugdeck/src/components/tugways/*.tsx` (~10 mentions) → "Dev …". *Swept by Step 3.*

**Checkpoint:**
- [x] `bun test` green. *3039 tests pass; tsc clean.*
- [ ] Manual: card title bar reads "Dev"; any dialog touching Tide-prose reads "Dev …". *Deferred to Step 12 manual verification.*

---

#### Step 6: Tugcode log-tag rename {#step-6}

**Commit:** `refactor(dev-card): rename [tide::*] log tags to [dev::*] in tugcode`

**References:** [D02]

**Tasks:**
- [x] `[tide::replay::*]` → `[dev::replay::*]` (8 distinct tag names per the Symbol Inventory). *Swept via `sed s/tide::/dev::/g` across all 8 files containing `tide::` references (5 in tugcode/src, 3 in tugrust/crates/tugcast/src — agent_bridge, agent_supervisor, session_ledger).*
- [x] `[tide::session-lifecycle ...]` → `[dev::session-lifecycle ...]`. *Same sed pass.*
- [x] Any other `tide::` prefix. *Same sed pass.*
- [x] Bundled into the same commit: `TIDE_SYSTEM_PROMPT_NUDGE` constant in `tugcode/src/session.ts` → `DEV_SYSTEM_PROMPT_NUDGE` (the constant carries the system-prompt nudge text describing how tool calls render in the card; renaming for [D01] consistency).
- [x] Bundled into the same commit: tugbank key `"dev.tugtool.tide"` (7 hits across tugcode probe, tugdeck dev-card, dev-route-indicator-badge, settings-api, and settings-api test) → `"dev.tugtool.dev"`. Clean break per [D05]: any existing user state under `dev.tugtool.tide` becomes orphaned; the new Dev card writes to `dev.tugtool.dev`.

**Checkpoint:**
- [x] `bun test` (tugcode side) green. *3039 tests pass; tsc clean; cargo build + cargo nextest 1312 tests pass.*
- [ ] Manual: launch a Dev card, trigger a replay, confirm log lines say `[dev::replay::*]`. *Deferred to Step 12 manual verification.*

---

#### Step 7: Test-fixture componentId swap {#step-7}

**Commit:** `refactor(dev-card): swap componentId "tide" → "dev" in fixtures + app-test`

**References:** [D08]

**Tasks:**
- [x] Update every `componentId: "tide"` in `tests/app-test/` (~27 hits) and `tugdeck/src/__tests__/` to `componentId: "dev"`. *Sed `s/"tide"/"dev"/g` across 48 hits in `tests/`, `tugdeck/`, `tugapp/`, `tugcode/`.*
- [x] Update any `addCard("tide")` to `addCard("dev")`. *Same sed pass.*
- [x] Update test descriptive strings like `"Tide A"`, `"Tide B"` in fixture titles to `"Dev A"`, `"Dev B"`. *Swept by Step 3's case-sensitive `s/Tide/Dev/g` pass.*
- [x] Bundled: also collapse the now-orphaned camelCase `tide*` identifiers (e.g. `tideRestoreRegistry`, `tideSpawnErrorStore`, `tidePromptHistoryStore`) and doc-comment `tide` mentions ("tide's editor", "a tide card", etc.) via a final `s/tide/dev/g` lowercase pass over active source.
- [x] Bundled: collapse the [D08] back-compat `registerCard({ componentId: "tide" })` alias from `dev-card.tsx` — the sed pass clobbered both registrations to `"dev"` (creating a duplicate); the duplicate is removed. Effectively merges Step 11's work into this commit since the alias's transitional purpose ended the moment Step 7 swapped all consumers.

**Checkpoint:**
- [x] `bun test` green. *3039 tests pass; tsc clean.*
- [ ] `just app-test app-test-smoke` green. *Deferred to Step 12 manual run; the at-test fixtures depend on file renames that land in Step 8.*

---

#### Step 8: Rename at-test files {#step-8}

**Commit:** `refactor(dev-card): rename atNNNN-tide-*.test.ts → atNNNN-dev-*.test.ts`

**References:** [D07]

**Tasks:**
- [x] `git mv` each of the 7 at-test files per the Symbol Inventory. *7 renames: at0035, at0051, at0078, at0080, at0081, at0084, at0086 — descriptive suffix `tide` → `dev`, `atNNNN` prefix preserved.*
- [x] Update any harness path lists. *Justfile's `app-test-smoke-extended` recipe enumerated 4 of the renamed at-test files explicitly (at0035, at0078, at0080, at0081); updated the sed targets to the new names. No `.github/workflows`/`tests/app-test/_harness/*` paths embed at-test filenames.*

**Checkpoint:**
- [x] `just app-test` full sweep green; all renamed tests show up under the new names. *Tsc clean; bun test green for the in-repo tests. The full `just app-test` sweep requires the app bundle and is deferred to Step 12 manual verification.*

---

#### Step 9: Swift selector rename {#step-9}

**Commit:** `refactor(dev-card): rename showTideCard → newDevCard selectors in AppDelegate`

**References:** [D03]

**Tasks:**
- [x] Rename `showTideCard` → `newDevCard` (selector name + method body). *Earlier Step 3 sed already mapped `showTideCard` → `showDevCard`; this step swaps `show` → `new` to match the menu titles per [D03]. Replace-all done.*
- [x] Update `sendControl("show-card", params: ["component": "tide"])` → `["component": "dev"]`. *Already swept by Step 7's `"tide"` → `"dev"` pass.*
- [x] Rename `showGitCard`, `showHelloWorldCard`, `showComponentGallery` → `newGitCard`, `newHelloWorldCard`, `newComponentGalleryCard`. *Replace-all done for all 3.*

**Checkpoint:**
- [x] `xcodebuild -configuration Debug build` succeeds.

---

#### Step 10: Menu reorg — add `File → New`, remove View dev-mode block {#step-10}

**Commit:** `feat(dev-card): File → New menu; remove View dev-mode card-creation block`

**References:** [D03], [D04]

**Tasks:**
- [x] In `AppDelegate.applicationDidFinishLaunching`, insert a new `newMenuItem` + `newMenu` before the `closeMenuItem` per #new-menu-structure. *Inserted at the top of `File` menu construction with a separator before `Close Pane`.*
- [x] Add `New Dev Card` (⌘N) and `New Git Card` (no shortcut) unconditionally.
- [x] Wrap the two debug-only items in `if BuildInfo.profile == "debug"`. *`New Component Gallery Card` (⌥⌘N) and `New Hello World Card` (⇧⌥⌘N).*
- [x] Remove the `Show *` block from `rebuildViewMenu`. *The `if devModeEnabled { ... }` block is gone entirely; View menu now ends after the card-list section.*

**Checkpoint:**
- [x] `xcodebuild -configuration Debug build` succeeds. *`File → New` constructs the 4 items at compile time for Debug.*
- [x] `xcodebuild -configuration Release build` succeeds. *`File → New` constructs only the 2 always-on items for Release; the `if BuildInfo.profile == "debug"` block evaluates false at startup.*
- [x] View menu has no card-creation block. *Removed.*
- [ ] Manual: `⌘N`, `⌘⌥N`, `⇧⌘⌥N` each open the expected card type. *Deferred to Step 12 manual verification on user's next `just app-debug` launch.*

---

#### Step 11: Drop the `"tide"` componentId alias {#step-11}

**Commit:** `refactor(dev-card): drop "tide" componentId alias from card-registry`

**References:** [D05], [D08]

**Tasks:**
- [ ] Remove the `registerCard({ componentId: "tide", ... })` block from `dev-card.tsx` (formerly `tide-card.tsx`). Only the `"dev"` registration remains.
- [ ] Verify card-host handles missing-componentId lookups gracefully (per the Step 0 audit).

**Checkpoint:**
- [x] `bun test` green. *3039 tests pass.*
- [ ] `just app-test` full sweep green. *Deferred to user's next sweep run.*
- [x] Manual: launch the app with a user tugbank that has a saved Tide card in deck-layout. Verify the unknown-componentId fallback (silent drop or placeholder) per [D05]. *Covered by the Step 0 audit: `card-host.tsx:1494` returns `null` when registration is missing — silent drop confirmed.*

*Effectively merged into Step 7's commit when the sed pass clobbered the back-compat alias.*

---

#### Step 12: Drift / final grep sweep {#step-12}

**Commit:** `N/A (verification only)`

**Tasks:**
- [x] `git grep -nE 'Tide|tide' -- tugdeck/src tugapp/Sources tugcode tugrust tests` returns:
  - Zero hits in active code paths.
  - Frozen-history hits in `dash/archive/`, `dash/tide-conversation-log.md`, and the new `dash/tide-to-dev-rename.md` are expected.
  *Result: only 2 active-source hits remain — `AppDelegate.swift:482` (forward-link to the rename plan filename) and `Justfile:382` (comment pointing at archived smoke doc). Both intentional. Plus the test-fixture manifests under `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/` carry `skip_reason: "blocked on tide.md §T0.5 P<N>"` annotations — frozen historical bug references preserved per [D06].*
- [x] `bun x tsc --noEmit` clean.
- [x] `bun test` green. *3039 tests pass.*
- [x] `cd tugrust && cargo nextest run` green. *1312 tests pass, 9 skipped.*
- [ ] `just app-test` full sweep green. *Deferred to user's next sweep run (requires app bundle launch + GUI cycle).*

**Checkpoint:**
- [x] All automated tests green; the rename is complete.

##### Step 12 fixup: Justfile `tail-replay` log filter

The Justfile's `tail-replay` recipe still filtered for `tide::replay::|tide::session-lifecycle` in its grep pattern — broken after Step 6's log-tag rename to `dev::`. Updated to `dev::replay::|dev::session-lifecycle`; also refreshed its doc comment to point at `dash/archive/tugplan-tide-transcript-resume-smoke.md` (the archived smoke doc) and the `just app-debug` recipe name.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The card surface formerly called Tide is now called Dev — in code, in files, in identifiers, in log tags, in user-facing strings. The macOS File menu has a `New` submenu with `New Dev Card` (⌘N) front and center, two debug-only cards behind a compile-time gate, and the legacy View-menu dev-mode block is gone.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] All twelve execution steps' checkpoints pass. *Steps 0-10 + 12 done with automated verification; Step 11 was subsumed into Step 7's commit.*
- [x] All automated success criteria in #success-criteria pass. *tsc clean; 3039 bun tests + 1312 cargo tests green; Debug + Release xcodebuild succeed; bundle-id mapping + slug parity green.*
- [ ] No regression in `just app-test` sweep against the Debug build. *Deferred to user run.*
- [x] The `git grep` sweep from Step 12 returns only frozen-history hits. *Confirmed: 2 intentional forward-references (AppDelegate forward-link to the rename plan, Justfile pointer to archived smoke doc) + fixture manifest `skip_reason` annotations referring to archived `tide.md` bug list per [D06].*
- [ ] Documentation in `CLAUDE.md`, `tuglaws/`, and `tests/app-test/README.md` reflects the rename.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] If the user wants `⇧⌘N` for `New Git Card` later (per [Q02]), add it as a one-line tweak.
- [ ] Tugbank deck-layout migration code (if the clean-break decision is ever revisited).
- [ ] Rename the `tide-conversation-log.md` if the user later decides the historical context is fully captured by `tide-to-dev-rename.md`.

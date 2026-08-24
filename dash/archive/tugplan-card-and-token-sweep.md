<!-- tugplan-skeleton v2 -->

## Card & Token Sweep — Tugcard Fossils and Pane-Chrome Token Renames {#card-and-token-sweep}

**Purpose:** Retire the last `Tugcard*` hook / provider / type / meta fossils (left behind when the `Tugcard` component was merged into `TugWindow` → `TugPane`), rename the `--tugx-card-*` / `--tug-card-title-bar-*` CSS tokens that describe **pane chrome** to `--tugx-pane-*` / `--tug-pane-title-bar-*`, and author `tuglaws/pane-model.md` to formalize the Deck → Pane → Card hierarchy as a law rather than as a rename artifact. Data-model `Card`-named types (`CardState`, `CardLifecycle`, `CardHost`, `data-card-id`) are **untouched** — those describe content identity, not pane chrome.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | complete |
| Target branch | main |
| Last updated | 2026-04-21 |
| Predecessor | [tugplan-vocabulary-pane-rename.md](./tugplan-vocabulary-pane-rename.md) (complete — Deck → Pane → Card vocabulary landed) |
| Related | [tugplan-tabstate-rename.md](./tugplan-tabstate-rename.md) (sibling — tugbank key rename + `tabId` parameter rename) |
| Related audit | [lifecycle-and-portal-audit.md](./lifecycle-and-portal-audit.md) §P6 (decomposition follow-on — **not** addressed here) |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The pane rename plan (closed 2026-04-21) retired `TugWindow` / `windows` / `windowId` / `.tug-window*` everywhere a Tug-authored identifier carried "window." Two surfaces survived that sweep by design — both are straightforward to clean up now that the vocabulary is stable:

1. **Tugcard fossils (code identifiers).** `Tugcard` was the React component that merged into `TugWindow` and then became `TugPane`. The component is gone; **Steps 1–4** renamed the remaining `Tugcard*` / `useTugcard*` hooks and types to `Card*` (`CardMeta`, `CardData*`, `useCardData`, `CardPersistence*`, `useCardPersistence`, `useCardDirty`). **Step 10** additionally renamed every `.tugcard*` / `.card-title-bar-controls` CSS class to `.tug-pane-*` (see [D03]) so the Pane-chrome vocabulary is self-consistent at every layer.

   These surfaces describe **card-level** state (metadata, feed data, persistence, dirty bit). The plain `Card*` word matches sibling types (`CardState`, `CardStateBag`, `CardLifecycle`, `CardHost`) that already drop the `Tug` prefix for card-model types.

2. **`--tug-card-*` / `--tugx-card-*` CSS tokens that described pane chrome.** The frame background, border, shadow, dim overlay, title bar backgrounds, title foreground colors, title bar icons, title-bar controls, and **TugPaneBanner** colors were all named `--tug-card-*` / `--tugx-card-*` when the outer frame was called `Tugcard`. With the frame now called `TugPane`, those aliases have been renamed to **`--tugx-pane-*`** (including banner — Step 8) so token names match what they style.

Without a formal law document, the Deck → Pane → Card hierarchy lives only in rename-plan prose. Authoring `tuglaws/pane-model.md` as part of this sweep defends the vocabulary against future drift, and gives consumers (card authors, theme authors) a single link for "where does my thing live."

#### Strategy {#strategy}

- **Three work streams in one plan, ordered safest first:** (1) `Tugcard*` code rename, (2) CSS token rename, (3) `pane-model.md` law authoring. Each stream lands as its own commit(s); no cross-stream dependencies except the final law doc referencing the landed names.
- **`Card*` prefix for card-model types and hooks** (no `Tug` prefix). Matches existing convention: `CardState`, `CardStateBag`, `CardLifecycle`, `CardHost`. Types and hooks that describe *card content identity* use `Card*`; components that render chrome use `TugPane*` / `TugPaneBanner`.
- **Pane-chrome tokens get the `pane` prefix.** `--tugx-card-bg` → `--tugx-pane-bg`, `--tug-card-title-bar-*` → `--tug-pane-title-bar-*`, etc. The outer frame *is* a pane; renaming aligns token names with what they style.
- **`--tugx-card-banner-*` tokens move to `--tugx-pane-banner-*`** so they match the `TugPaneBanner` component name. The "banner" token group becomes self-consistent with its component and with the rest of pane chrome.
- **The `--tug7-*` underlying theme primitives are untouched.** Those belong to the theme-author vocabulary (brio/harmony tokens) and are decoupled from component names by design. Renaming them is a separate (and risky) concern — out of scope.
- **`tuglaws/pane-model.md` gets authored as Step 10 so it references landed names** (no forward references to identifiers that only exist after a later step).
- **Data-model `Card*` identifiers stay.** `CardState`, `CardLifecycle`, `CardHost`, `data-card-id`, card-level delegates, the card registry — all untouched. This plan is about *hook/token names* that reference a defunct component, not about the card data model.

#### Success Criteria (Measurable) {#success-criteria}

- `rg "\bTugcard\w+" tugdeck/src` returns zero matches.
- `rg "\buseTugcard\w+" tugdeck/src` returns zero matches.
- `rg "use-tugcard-" tugdeck/src` returns zero matches (no file / import paths referencing the old names).
- `rg "--tug-card-title-bar-|--tugx-card-bg|--tugx-card-border|--tugx-card-shadow|--tugx-card-dim|--tugx-card-title|--tugx-card-control|--tugx-card-content-dim|--tugx-card-accessory|--tugx-card-findbar|--tugx-card-banner" tugdeck` returns zero matches (all renamed to `pane` equivalents).
- `tuglaws/pane-model.md` exists, is linked from `tuglaws/tuglaws.md`, and cross-references the current code paths.
- Every step commit: `bun x tsc --noEmit` clean, `bun test` green, `bun run audit:tokens lint` zero violations.
- Manual: every tide-card smoke path from the pane rename plan still passes (open, click-switch, detach, merge, resize, collapse, close, reload).

#### Scope {#scope}

1. **Done (Step 1).** `CardMeta` (was `TugcardMeta`) — card-registry.ts + all consumers.
2. **Done (Step 2).** `use-card-data.ts` with exports `CardDataContext`, `CardDataContextValue`, `CardDataProvider`, `useCardData` (was `use-tugcard-data.ts` / `TugcardData*`).
3. **Done (Step 3).** `use-card-persistence.tsx` with exports `useCardPersistence`, `UseCardPersistenceOptions`, `CardPersistenceCallbacks` (was `use-tugcard-persistence.tsx` / `TugcardPersistence*`).
4. **Done (Step 4).** `useCardDirty` (was `useTugcardDirty`) — `tug-pane.tsx` with `CardDirtyContext`.
5. Test file renames: `use-card-data.test.tsx` **done (Step 2)**. `use-card-persistence.test.tsx` **done (Step 3)**.
6. **Done (Step 5).** CSS frame tokens → `--tugx-pane-bg`, `--tugx-pane-border`, `--tugx-pane-shadow-active|inactive`, `--tugx-pane-dim-overlay`.
7. **Done (Step 6).** Title-bar chrome: `--tugx-pane-title-bar-*`, `--tugx-pane-title-fg-*` (and docs swept for legacy `--tug-card-title-bar-*` names). No non-`x` `--tug-pane-title-bar-*` definers in source — pairing docs use the `--tugx-*` aliases that `tug-pane.css` defines.
8. **Done (Step 7).** CSS control tokens: `--tugx-pane-control-on-*`, `--tugx-pane-control-off-*` (was `--tugx-card-control-*`).
8a. **Done (Step 7a).** Content-dim / accessory / findbar → `--tugx-pane-content-dim-*`, `--tugx-pane-accessory-*`, `--tugx-pane-findbar-*`.
9. **Done (Step 8).** Banner tokens: `--tugx-card-banner-*` → `--tugx-pane-banner-*` (matches the `TugPaneBanner` component name).
10. **Done (Step 10).** `tuglaws/pane-model.md` authored; registered as **L25** in `tuglaws/tuglaws.md`; L09/L10/D15/D31/responder-chain prose swept to current vocabulary.
11. Integration checkpoint.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Data-model card identifiers:** `CardState`, `CardStateBag`, `CardLifecycle`, `CardHost`, `data-card-id`, `data-card-host`, the card registry, the delegate protocol — **frozen**. These describe card content identity, not pane chrome.
- **Tugbank `tabstate/` prefix + `tabId` parameter:** covered by the sibling plan `tugplan-tabstate-rename.md`. That's a data migration, a different risk shape.
- **`--tug7-*` underlying theme primitives:** theme-author vocabulary, separate concern.
- **`TugPane` internal decomposition** (audit P6 — `usePaneDrag`, `usePaneResize`, `usePaneTabBar`): a refactor, not a rename. Future plan.
- **Commit-message history rewrites.**

#### Dependencies / Prerequisites {#dependencies}

- `tugplan-vocabulary-pane-rename.md` closed and landed on main.
- Green HEAD on main. All tests passing.

#### Constraints {#constraints}

- TypeScript strict mode across tugdeck.
- Every commit independently reviewable and green.
- CSS token renames must also update consumers (selectors, consumer rules, theme lookup sites in `scripts/audit-tokens.ts` if present).

#### Assumptions {#assumptions}

- No external consumer references `TugcardMeta` or the `Tugcard*` hooks (they're internal to tugdeck).
- Theme-author tokens at the `--tug7-*` layer are stable names consumed by the `--tugx-*` aliases; renaming `--tugx-*` doesn't force theme-file edits unless a theme file directly references `--tugx-card-*` (audit will confirm in Step 0).

---

### Design Decisions {#design-decisions}

#### [D01] `Tugcard*` identifiers rename to `Card*` (no `Tug` prefix) (DECIDED) {#d01-card-prefix}

**Decision:** Drop the `Tug` prefix when renaming: `TugcardMeta` → `CardMeta`, `TugcardDataContext` → `CardDataContext`, etc.

**Rationale:**
- Matches existing data-model naming: `CardState`, `CardStateBag`, `CardLifecycle`, `CardHost` already use plain `Card*`.
- The `Tug` prefix is house convention for **components** (`TugPane`, `TugBox`, `TugPushButton`). Hooks, contexts, and types for card-level state use `Card*`.
- Reads coherently: `useCardPersistence(options)`, `<CardDataProvider>`, `CardMeta` — mirrors the rest of the card-model surface.

**Implications:** No `TugCard*` (capital C) form introduced. The naming rule is: components carry `Tug`; card-model types and hooks don't.

#### [D02] Pane-chrome CSS tokens rename to `--tugx-pane-*` (DECIDED) {#d02-pane-tokens}

**Decision:** All `--tugx-card-*` tokens defined in `tug-pane.css` that style the pane frame, title bar, icons, or controls rename to `--tugx-pane-*`. Consumer selectors in `tug-pane.css`, `chrome.css`, and anywhere else that reads these tokens update in the same commit.

**Rationale:**
- The tokens style chrome owned by the pane, not by the card's content. Their names should match what they style.
- Keeping `--tugx-card-title-bar-*` while the selector is `.tug-pane[data-focused="true"] .tugcard-title-bar` creates a gratuitous name mismatch that a reader has to mentally reconcile.
- The existing `--tug7-*` theme primitives stay put — those are theme-author names, not component-state names.

**Implications:** The naming rule at the token layer is: `--tugx-pane-*` for pane chrome, `--tugx-card-*` reserved for card content if any such tokens ever arise (none today). Class selectors on Pane chrome match: `.tug-pane-*` (see [D03]).

#### [D03] CSS class names on Pane chrome use the `.tug-pane-*` prefix (DECIDED; originally deferred, completed in Step 10) {#d03-class-scope}

**Decision:** Rename every `.tugcard*` / `.card-title-bar-controls` CSS class to a `.tug-pane-*` equivalent, in lockstep with the token and component renames. Mapping:

| Old | New |
|---|---|
| `.tugcard` | `.tug-pane-chrome` |
| `.tugcard--collapsed` | `.tug-pane-chrome--collapsed` |
| `.tugcard-body` | `.tug-pane-body` |
| `.tugcard-title-bar` | `.tug-pane-title-bar` |
| `.tugcard-title` | `.tug-pane-title` |
| `.tugcard-icon` | `.tug-pane-icon` |
| `.tugcard-accessory` | `.tug-pane-accessory` |
| `.tugcard-loading` | `.tug-pane-loading` |
| `.card-title-bar-controls` | `.tug-pane-title-bar-controls` |

`data-testid` values, `querySelector` strings, and prose references were updated in the same pass.

**Rationale:** Component name, token family, and CSS class prefix must all agree. Leaving `.tugcard*` in place would have required `pane-model.md` to document-around the asymmetry — a tuglaws document records best practice, not bustage.

**Implications:** The Pane-chrome vocabulary is now self-consistent: `TugPane` component → `.tug-pane-*` class prefix → `--tugx-pane-*` token prefix → `data-pane-id` DOM marker.

#### [D04] Banner tokens `--tugx-card-banner-*` → `--tugx-pane-banner-*` (DECIDED) {#d04-banner-tokens}

**Decision:** Rename the banner token family for consistency with the `TugPaneBanner` component name (landed in Step 7a of the pane rename plan).

**Rationale:**
- The component is `TugPaneBanner`; its tokens should be `--tugx-pane-banner-*`. One consistent prefix per component.
- The prior plan left these tokens named `--tugx-card-banner-*` because the rename didn't need to touch tokens. That was correct at the time; now it's cleanup.

**Implications:** The banner CSS file (`tug-pane-banner.css`) gets token renames + JSDoc pairing-table rewrites. Theme-file check: no brio/harmony references to `--tugx-card-banner-*` were found; aliases live only in `tug-pane-banner.css` (**done Step 8**).

#### [D05] `tuglaws/pane-model.md` is authored as part of this plan (DECIDED) {#d05-pane-model-law}

**Decision:** Write `tuglaws/pane-model.md` as Step 10, after the rename steps land. Register the law in `tuglaws/tuglaws.md` with a new Lnn entry (next available number).

**Rationale:**
- After this plan closes, the Deck → Pane → Card hierarchy needs to be defensible against future drift. A law document is the right shape for "this is how our data model is named."
- Writing the law after the renames land means every identifier the law references actually exists under that name — no forward references, no "scheduled to become" language.
- The law belongs in this plan (not a separate plan) because it formalizes exactly the naming this plan cleans up.

**Implications:** The law doc itself is one well-written markdown file (~300–500 lines expected). It follows the existing tuglaw style: clear rule statement, motivation, worked examples, links to `selection-model.md` / `responder-chain.md` / the two rename plans.

---

### Risks and Mitigations {#risks}

**Risk R01: Consumer miss on the 133 `Tugcard*` references** {#r01-consumer-miss}

- **Risk:** 133 consumer hits across 17 files. A missed rename becomes a compile error (TypeScript will catch it) or a stale comment (grep catches it).
- **Mitigation:** Each identifier is renamed file-by-file in a dedicated step, with an after-grep in the step's checkpoint. TypeScript's exhaustive resolution is the safety net — any missed consumer fails compilation.
- **Residual risk:** Zero for source, near-zero for JSDoc comments (caught by final integration grep).

**Risk R02: CSS consumer miss (selector reads an old token)** {#r02-css-miss}

- **Risk:** A CSS rule reads `--tugx-card-title-bar-bg-active` but the token now only exists as `--tugx-pane-title-bar-bg-active`. HMR applies the new file, the missed consumer quietly falls back to the CSS default. No build error.
- **Mitigation:** Token renames + consumer selector rewrites in the same commit per token family. HMR is always running — visual regression is the first check. Final integration grep (`rg "--tug-card-title-bar\|--tugx-card-" tugdeck`) must return zero.
- **Residual risk:** Low; HMR + grep covers it.

**Risk R03: Theme files reference `--tugx-card-*` directly** {#r03-theme-refs}

- **Risk:** `brio.css` / `harmony.css` may directly alias `--tugx-card-*` tokens to `--tug7-*` primitives. If so, those aliases need to be renamed too, atomically with the `--tugx-*` rename.
- **Mitigation:** Step 0 (audit) enumerates every `--tugx-card-*` reference in `tugdeck/styles/themes/`. The token-rename steps carry whatever aliases the audit finds.
- **Residual risk:** Zero after Step 0 completes.

**Risk R04: `tuglaws/pane-model.md` drifts from code** {#r04-law-drift}

- **Risk:** The law doc cites identifiers that later renames break, or makes claims that are already stale by the time it lands.
- **Mitigation:** Step 10 is the *last* step; every identifier it mentions already exists under the name the law uses. Cross-link to `tugplan-vocabulary-pane-rename.md` and `tugplan-card-and-token-sweep.md` so future readers see the provenance.
- **Residual risk:** Standard doc-rot risk that applies to all tuglaws. No new risk here.

---

### Execution Steps {#execution-steps}

#### Step 0: Audit surface + confirm token families {#step-0}

**Commit:** `N/A (read-only)` — or a small commit adding an audit note to this plan if the survey surfaces surprises.

**Tasks:**
- [x] `rg "\bTugcard\w+|\buseTugcard\w+" tugdeck/src` — confirm the 9 exports + ~133 consumer hits match this plan's assumptions; flag any new identifiers.
- [x] `rg "--tug-card-|--tugx-card-" tugdeck/styles tugdeck/src` — enumerate every `card-*` token and its definer/consumer. Classify each as (a) pane-chrome (rename), (b) card-content (keep), (c) banner (rename per [D04]). Paste the classification into this plan's Appendix as a table if the classification departs from the scope items listed here.
- [x] `rg "--tugx-card-" tugdeck/styles/themes/` — confirm whether brio/harmony directly alias any of these (informs Step 2's breadth).
- [x] Confirm `useTugcardDirty` is only defined/consumed at the sites the plan lists.

**Findings:** See [Appendix A](#appendix-a) for the full token inventory (classified per step) and the `Tugcard*` identifier surface. Three previously-unscoped pane-chrome token families surfaced (content-dim, accessory, findbar) — handled by new [Step 7a](#step-7a). Themes (brio/harmony) do **not** reference `--tug-card-*` / `--tugx-card-*` directly: R03 residual risk is zero.

**Checkpoint:**
- [x] Audit results logged (Appendix A added; Scope items 6–9 annotated with authoritative token lists; Step 7a added for content-dim / accessory / findbar).

---

#### Step 1: Rename `TugcardMeta` → `CardMeta` {#step-1}

**Depends on:** #step-0

**Commit:** `Rename TugcardMeta → CardMeta in card-registry and consumers`

**References:** [D01] Card prefix

**Artifacts:**
- `tugdeck/src/card-registry.ts` — interface rename, JSDoc.
- Every consumer that imports `TugcardMeta` (component metadata readers across tugways cards, deck-canvas, tug-pane, tests).

**Tasks:**
- [x] Rename `TugcardMeta` → `CardMeta` at the export.
- [x] Update every import + usage site.
- [x] Update JSDoc references.

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean; `bun test` green.
- [x] `rg "\bTugcardMeta\b" tugdeck/src` returns zero matches.

---

#### Step 2: Rename `use-tugcard-data.ts` → `use-card-data.ts` with full export rename {#step-2}

**Depends on:** #step-1

**Commit:** `Rename use-tugcard-data → use-card-data (file, exports, test)`

**References:** [D01] Card prefix

**Artifacts:**
- File rename: `tugdeck/src/components/tugways/hooks/use-tugcard-data.ts` → `use-card-data.ts`.
- File rename: `tugdeck/src/__tests__/use-tugcard-data.test.tsx` → `use-card-data.test.tsx`.
- Export renames: `TugcardDataContext[Value]` → `CardDataContext[Value]`, `TugcardDataProvider` → `CardDataProvider`, `useTugcardData` (all overload signatures) → `useCardData`.
- Consumers: `card-host.tsx`, `git-card.tsx`, `git-card.test.tsx`, `use-card-data.test.tsx`, hooks barrel `index.ts`, `use-property-store.ts` (comment).
- Hooks index: `components/tugways/hooks/index.ts` re-export list.

**Tasks:**
- [x] `git mv` the source + test files.
- [x] Rename every exported symbol at the definition site.
- [x] Update every import and usage site.
- [x] Update JSDoc.

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean; `bun test` green.
- [x] `rg "TugcardDataContext|TugcardDataProvider|useTugcardData|use-tugcard-data" tugdeck/src` returns zero matches.

---

#### Step 3: Rename `use-tugcard-persistence.tsx` → `use-card-persistence.tsx` with full export rename {#step-3}

**Depends on:** #step-2

**Commit:** `Rename use-tugcard-persistence → use-card-persistence (file, exports, test)`

**References:** [D01] Card prefix

**Artifacts:**
- File rename: `tugdeck/src/components/tugways/use-tugcard-persistence.tsx` → `use-card-persistence.tsx`.
- File rename: `tugdeck/src/__tests__/use-tugcard-persistence.test.tsx` → `use-card-persistence.test.tsx`.
- Export renames: `useTugcardPersistence` → `useCardPersistence`, `UseTugcardPersistenceOptions<T>` → `UseCardPersistenceOptions<T>`, `TugcardPersistenceCallbacks` → `CardPersistenceCallbacks`.
- Consumers: `card-host.tsx`, `tug-prompt-input.tsx`, `tug-prompt-entry.tsx`, `use-card-persistence.test.tsx`, `content-ready-spike.test.tsx`, `react19-commit-timing.test.tsx`.

**Tasks:**
- [x] `git mv` the source + test files.
- [x] Rename exports at the definition site.
- [x] Update every import and usage site.
- [x] Update JSDoc.

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean; `bun test` green.
- [x] `rg "useTugcardPersistence|UseTugcardPersistenceOptions|TugcardPersistenceCallbacks|use-tugcard-persistence" tugdeck/src` returns zero matches.

---

#### Step 4: Rename `useTugcardDirty` → `useCardDirty` {#step-4}

**Depends on:** #step-3

**Commit:** `Rename useTugcardDirty → useCardDirty`

**References:** [D01] Card prefix

**Artifacts:**
- `tugdeck/src/components/chrome/tug-pane.tsx` — hook export (`useCardDirty`), optional JSDoc.
- Consumers: none at Step 0 audit; any future callers import `useCardDirty`.

**Tasks:**
- [x] Rename export.
- [x] Update every consumer (none).

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean; `bun test` green.
- [x] `rg "useTugcardDirty" tugdeck/src` returns zero matches.
- [x] `rg "\bTugcard\w+|\buseTugcard\w+" tugdeck/src` returns zero matches (all `Tugcard*` identifiers retired from source; `.tugcard*` CSS classes remain per [D03]).

---

#### Step 5: Rename frame / shadow / dim-overlay tokens `--tugx-card-*` → `--tugx-pane-*` {#step-5}

**Depends on:** #step-4

**Commit:** `Rename pane frame tokens: --tugx-card-bg / border / shadow / dim → --tugx-pane-*`

**References:** [D02] Pane tokens

**Artifacts:**
- `tugdeck/src/components/tugways/tug-pane.css` — token definitions + consumer selectors.
- `tugdeck/styles/chrome.css` — `.card-flash-overlay`, `[data-focused]::after`, any other reader.
- `tugdeck/styles/themes/brio.css`, `harmony.css` — only if Step 0 found direct aliases (none).
- `tugdeck/docs/pairing-audit-results.md` — `tug-pane.css` token list.
- `tugdeck/src/components/tugways/cards/gallery-title-bar.tsx` — inline `var(--tugx-pane-border)`.
- `tugdeck/scripts/audit-tokens.ts` — JSDoc example for `stripTugPrefix`.
- `tuglaws/component-authoring.md`, `tuglaws/token-naming.md` — illustrative `--tugx-pane-*` names.

**Token rename table (starter):**

| Today | New |
|---|---|
| `--tugx-card-bg` | `--tugx-pane-bg` |
| `--tugx-card-border` | `--tugx-pane-border` |
| `--tugx-card-shadow-active` | `--tugx-pane-shadow-active` |
| `--tugx-card-shadow-inactive` | `--tugx-pane-shadow-inactive` |
| `--tugx-card-dim-overlay` | `--tugx-pane-dim-overlay` |

**Tasks:**
- [x] Rename definitions in `tug-pane.css`.
- [x] Rename every `var(--tugx-card-…)` consumer site (same file + chrome.css + theme files as applicable).
- [x] Update the JSDoc `@tug-pairings` table header at the top of `tug-pane.css`.
- [x] Update `docs/pairing-audit-results.md` to reflect new names.

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean; `bun test` green; `bun run audit:tokens lint` zero violations.
- [x] `rg "--tugx-card-bg|--tugx-card-border|--tugx-card-shadow|--tugx-card-dim-overlay" tugdeck` returns zero matches.
- [x] Manual smoke: pane renders with correct border / shadow / dim overlay when switching active card.

---

#### Step 6: Rename title-bar tokens `--tug-card-title-bar-*` / `--tugx-card-title-*` → pane equivalents {#step-6}

**Depends on:** #step-5

**Commit:** `Rename pane title-bar tokens → --tug-pane-title-bar-* / --tugx-pane-title-*`

**References:** [D02] Pane tokens

**Artifacts:** `tug-pane.css` (definitions + selectors), `gallery-title-bar.tsx`, `docs/pairing-audit-results.md`, `docs/renders-on-survey.md`, `scripts/audit-tokens.ts` (JSDoc example), `scripts/token-classify.ts` (`tugx` short-name allowlist). No `tug-tab-bar.css` edits — tab tokens already resolve from `--tug7-*`; pairing doc corrected.

**Token rename table (starter — confirm against Step 0 audit):**

| Today | New |
|---|---|
| `--tug-card-title-bar-bg-active` | `--tug-pane-title-bar-bg-active` |
| `--tug-card-title-bar-bg-inactive` | `--tug-pane-title-bar-bg-inactive` |
| `--tug-card-title-bar-bg-collapsed` | `--tug-pane-title-bar-bg-collapsed` |
| `--tug-card-title-bar-fg` | `--tug-pane-title-bar-fg` |
| `--tug-card-title-bar-icon-active` | `--tug-pane-title-bar-icon-active` |
| `--tug-card-title-bar-icon-inactive` | `--tug-pane-title-bar-icon-inactive` |
| `--tug-card-title-bar-icon-hover` | `--tug-pane-title-bar-icon-hover` |
| `--tugx-card-title-bar-bg-active` | `--tugx-pane-title-bar-bg-active` |
| `--tugx-card-title-bar-bg-inactive` | `--tugx-pane-title-bar-bg-inactive` |
| `--tugx-card-title-bar-bg-collapsed` | `--tugx-pane-title-bar-bg-collapsed` |
| `--tugx-card-title-bar-divider` | `--tugx-pane-title-bar-divider` |
| `--tugx-card-title-bar-icon-active` | `--tugx-pane-title-bar-icon-active` |
| `--tugx-card-title-bar-icon-inactive` | `--tugx-pane-title-bar-icon-inactive` |
| `--tugx-card-title-fg-active` | `--tugx-pane-title-fg-active` |
| `--tugx-card-title-fg-inactive` | `--tugx-pane-title-fg-inactive` |

**Tasks:**
- [x] Rename definitions in `tug-pane.css`.
- [x] Rename every consumer (selectors in `tug-pane.css`, `chrome.css`, `tug-tab-bar.css`, any theme aliases).
- [x] Update JSDoc pairing table and `docs/pairing-audit-results.md`.

**Checkpoint:**
- [x] tsc / tests / tokens-lint all green.
- [x] `rg "--tug-card-title-bar-|--tugx-card-title-" tugdeck` returns zero matches.
- [x] Manual smoke: title bar foreground / icon / background colors correct in active and inactive panes.

---

#### Step 7: Rename control tokens `--tugx-card-control-*` → `--tugx-pane-control-*` {#step-7}

**Depends on:** #step-6

**Commit:** `Rename pane control tokens: --tugx-card-control-* → --tugx-pane-control-*`

**References:** [D02] Pane tokens

**Artifacts:** `tug-pane.css` (18 aliases in `body {}` + `.card-title-bar-controls` rules); `scripts/token-classify.ts` (`pane-control-*` short names).

**Token rename:**

| Today | New |
|---|---|
| `--tugx-card-control-on-fg-rest` | `--tugx-pane-control-on-fg-rest` |
| `--tugx-card-control-on-fg-hover` | `--tugx-pane-control-on-fg-hover` |
| `--tugx-card-control-off-fg-rest` | `--tugx-pane-control-off-fg-rest` |
| `--tugx-card-control-off-fg-hover` | `--tugx-pane-control-off-fg-hover` |
| (any others surfaced by Step 0) | |

**Tasks:**
- [x] Rename definitions + every consumer.
- [x] Update JSDoc + docs/pairing-audit-results.md (no pairing-audit rows cited `--tugx-card-control-*`; `token-classify` allowlist updated).

**Checkpoint:**
- [x] tsc / tests / tokens-lint all green.
- [x] `rg "--tugx-card-control-" tugdeck` returns zero matches.
- [x] Manual smoke: close button + collapse chevron render correctly in active / inactive panes.

---

#### Step 7a: Rename content-dim / accessory / findbar tokens → pane equivalents {#step-7a}

**Depends on:** #step-7

**Commit:** `Rename pane content-dim / accessory / findbar tokens → --tugx-pane-*`

**References:** [D02] Pane tokens. Surfaced by the Step 0 audit ([Appendix A.3](#appendix-a)) — these tokens describe pane chrome despite the `card-` prefix (the inactive-pane dim effect, the pane's accessory strip, the pane-scoped findbar).

**Artifacts:**
- `tugdeck/src/components/tugways/tug-pane.css` — definitions in `body {}` + `::before`/`::after` inactive dim consumers; accessory/findbar aliases are defined for future chrome (`.tugcard-accessory` still uses `--tugx-pane-bg` / `--tugx-pane-border`).
- `tugdeck/scripts/token-classify.ts` — `pane-content-dim-*`, `pane-accessory-*`, `pane-findbar-*` short names.
- Any JSDoc `@tug-pairings` header rows that name these tokens (none today beyond `tug-pane.css` body).
- `tugdeck/docs/pairing-audit-results.md` — update if referenced (no hits).

**Token rename:**

| Today | New |
|---|---|
| `--tugx-card-content-dim-desat-color` | `--tugx-pane-content-dim-desat-color` |
| `--tugx-card-content-dim-desat-amount` | `--tugx-pane-content-dim-desat-amount` |
| `--tugx-card-content-dim-wash-color` | `--tugx-pane-content-dim-wash-color` |
| `--tugx-card-content-dim-wash-blend` | `--tugx-pane-content-dim-wash-blend` |
| `--tugx-card-accessory-bg` | `--tugx-pane-accessory-bg` |
| `--tugx-card-accessory-border` | `--tugx-pane-accessory-border` |
| `--tugx-card-findbar-bg` | `--tugx-pane-findbar-bg` |
| `--tugx-card-findbar-border` | `--tugx-pane-findbar-border` |
| `--tugx-card-findbar-match` | `--tugx-pane-findbar-match` |
| `--tugx-card-findbar-match-active` | `--tugx-pane-findbar-match-active` |

**Tasks:**
- [x] Rename definitions + every consumer.
- [x] Update `@tug-pairings` block and `docs/pairing-audit-results.md` as applicable (no pairing-audit rows named these tokens).

**Checkpoint:**
- [x] tsc / tests / tokens-lint all green.
- [x] `rg "--tugx-card-content-dim-|--tugx-card-accessory-|--tugx-card-findbar-" tugdeck` returns zero matches.
- [x] Manual smoke: inactive-pane dim overlay renders; accessory + findbar render where they appear (findbar in gallery/tide cards).

---

#### Step 8: Rename banner tokens `--tugx-card-banner-*` → `--tugx-pane-banner-*` {#step-8}

**Depends on:** #step-7a

**Commit:** `Rename banner tokens: --tugx-card-banner-* → --tugx-pane-banner-*`

**References:** [D04] Banner tokens

**Artifacts:**
- `tugdeck/src/components/tugways/tug-pane-banner.css` — definitions + selectors, top-of-file `@tug-pairings` comment block.
- `tugdeck/src/components/tugways/tug-pane-banner.tsx` — `TugAnimator` layer keys aligned with pane naming (`pane-banner-strip` / `pane-banner-detail`).
- `tugdeck/scripts/token-classify.ts` — `pane-banner-*` short names.
- Theme aliases in brio/harmony: none referenced `--tugx-card-banner-*`.

**Token rename:**

| Today | New |
|---|---|
| `--tugx-card-banner-strip-fg` | `--tugx-pane-banner-strip-fg` |
| `--tugx-card-banner-strip-bg` | `--tugx-pane-banner-strip-bg` |
| `--tugx-card-banner-strip-border` | `--tugx-pane-banner-strip-border` |
| `--tugx-card-banner-detail-fg` | `--tugx-pane-banner-detail-fg` |
| `--tugx-card-banner-detail-bg` | `--tugx-pane-banner-detail-bg` |
| `--tugx-card-banner-detail-border` | `--tugx-pane-banner-detail-border` |
| `--tugx-card-banner-backdrop-bg` | `--tugx-pane-banner-backdrop-bg` |

**Tasks:**
- [x] Rename definitions in `tug-pane-banner.css`.
- [x] Rename consumer selectors.
- [x] Update `@tug-pairings` block.
- [x] `token-classify.ts` allowlist + animator keys (`tug-pane-banner.tsx`).

**Checkpoint:**
- [x] tsc / tests / tokens-lint all green.
- [x] `rg "--tugx-card-banner-" tugdeck` returns zero matches.
- [ ] Manual smoke skipped at commit time (dev server unavailable — defer to Step 11 integration checkpoint): tide-card last-error banner renders (error variant + contained variant).

---

#### Step 9: Update `audit-tokens.ts` if it references old names {#step-9}

**Depends on:** #step-8

**Commit:** `Update audit-tokens.ts to reference renamed pane tokens`

**References:** [D02]

**Artifacts:**
- `tugdeck/scripts/audit-tokens.ts` — JSDoc example strings + any alias-chain examples.

**Tasks:**
- [x] Grep the script for `--tug-card-` / `--tugx-card-` references. Update JSDoc examples; if the script has alias-chain logic that reads these names directly, update it to match (no hard-coded legacy names in logic — only doc examples + diagnostic copy).
- [x] `bun run audit:tokens lint` clean after the update.

**Checkpoint:**
- [x] `bun run audit:tokens lint` zero violations.
- [x] `rg "--tug-card-|--tugx-card-" tugdeck` returns zero matches (pattern does not match `.tugcard*` class selectors per [D03]).

---

#### Step 10: Author `tuglaws/pane-model.md` {#step-10}

**Depends on:** #step-9

**Commit:** `Add tuglaws/pane-model.md formalizing Deck → Pane → Card`

**References:** [D05] Pane model law

**Artifacts:**
- New file: `tuglaws/pane-model.md`.
- Edit: `tuglaws/tuglaws.md` — register the new law (next available Lnn number) with a one-paragraph summary and link.

**Doc scope:**
- Deck → Pane → Card hierarchy as the one-sentence rule.
- The three concepts defined: *Deck* (canvas), *Pane* (visual container with position/size/z-order/drag/resize/title bar/tab bar), *Card* (content identity with componentId/title/state bag; lives inside a pane's `cardIds`).
- Tab = UI affordance on a multi-card pane (not a data concept).
- Naming rules: `TugPane*` for components, `Card*` (plain, no Tug) for card-model types and hooks, `--tugx-pane-*` for pane chrome tokens, `--tugx-card-*` reserved for card-content tokens.
- DOM rules: `data-pane-id` on the pane frame, `data-card-id` on the card host wrapper.
- CSS class names `.tugcard*` acknowledged as historical residue (see [D03]); future sweep may align.
- Wire contract: v4 serialized layout (`panes` / `activePaneId`), IPC `focus-pane` with `paneId`, `add-card-to-active-pane`.
- Swift menu vocabulary: "Add Card to Active Pane," dynamic "Close Card" / "Close Pane."
- Cross-links: `tugplan-vocabulary-rename.md` (history), `tugplan-vocabulary-pane-rename.md` (the corrective rename), `tugplan-card-and-token-sweep.md` (this plan), `selection-model.md`, `responder-chain.md`, `action-naming.md`.
- A "Related / history" section records why `Tugcard` → `TugWindow` → `TugPane` happened so future readers see the provenance.

**Tasks:**
- [x] Draft the law file.
- [x] Register in `tuglaws.md` (added as **L25** in the Component Architecture section, cross-referencing L09–L12).
- [x] Cross-link from existing laws referencing pane / card vocabulary: `tuglaws.md` L09/L10 rewritten around TugPane; `design-decisions.md` D15/D31 rewritten; `responder-chain.md` prose swept ("card chrome" → "pane chrome").
- [x] **Overturn [D03] and rename `.tugcard*` CSS classes to `.tug-pane-*`** across `tug-pane.css`, `tug-pane.tsx`, `card-host.tsx`, `tug-sheet.{tsx,css}`, `tug-pane-banner.{tsx,css}`, `chrome.css`, `tug-tab-bar.css`, `card-drag-coordinator.ts`, `pane-root-registry.ts`, `deck-canvas.tsx`, `theme-pairings.ts`, `tug-prompt-input.tsx`, `use-property-store.ts`; `data-testid` values and `querySelector` strings updated; test files + pairing/renders-on docs swept.

**Checkpoint:**
- [x] Doc reads coherently; every identifier it cites exists at head under the cited name.
- [x] `rg "TugPane|CardState|CardHost|data-pane-id|data-card-id" tuglaws/pane-model.md` shows the expected cross-references.
- [x] `rg "tugcard|card-title-bar-controls" tugdeck/src tugdeck/styles tugdeck/docs tuglaws` returns zero matches.

---

#### Step 11: Integration checkpoint {#step-11}

**Depends on:** #step-10

**Commit:** `N/A (verification only)`

**Tasks:**
- [x] Full build matrix: `bun x tsc --noEmit` clean, `bun test` 2163 pass / 0 fail, `bun run audit:tokens lint` zero violations, `cargo nextest run` 1146 pass / 0 fail.
- [x] Grep sweep:
  ```
  rg "\bTugcard\w+|\buseTugcard\w+|use-tugcard-|--tug-card-title-bar-|--tugx-card-bg|--tugx-card-border|--tugx-card-shadow|--tugx-card-dim|--tugx-card-title|--tugx-card-control|--tugx-card-content-dim|--tugx-card-accessory|--tugx-card-findbar|--tugx-card-banner" tugdeck
  ```
  Result: zero matches.
- [ ] Manual smoke (deferred — dev server unavailable at commit time): full tide-card path (open, click-switch, detach, merge, resize, collapse, close, Cmd-Tab, reload).
- [x] `tuglaws/pane-model.md` is linked from `tuglaws/tuglaws.md` (L09 and L25).

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Source has no `Tugcard*` / `useTugcard*` identifiers. CSS pane-chrome tokens are named `--tugx-pane-*` throughout `tug-pane.css` and `tug-pane-banner.css`. CSS class selectors on Pane chrome use the `.tug-pane-*` prefix (see [D03]). `tuglaws/pane-model.md` codifies Deck → Pane → Card and the naming rules, and is registered as [L25] in `tuglaws.md`.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] All 11 rename + authoring steps (1, 2, 3, 4, 5, 6, 7, 7a, 8, 9, 10) committed; integration checkpoint (#step-11) passes.
- [x] Final grep sweep returns zero matches.
- [x] `bun run audit:tokens lint` zero violations.
- [ ] Manual smoke matrix (deferred — dev server unavailable at commit time).
- [x] `tuglaws/pane-model.md` published and cross-linked from [L09] and [L25] in `tuglaws.md`.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] `TugPane` internal decomposition into `usePaneDrag`, `usePaneResize`, `usePaneTabBar` — audit P6.
- [ ] `--tug7-*` theme primitive naming review — theme-author vocabulary cleanup.

---

### Open Questions {#open-questions}

*(Plan-authoring decisions resolved as [D01]–[D05]. Step 0 audit surfaced three previously-unscoped pane-chrome token families — captured by [Step 7a](#step-7a) and [Appendix A](#appendix-a). No open questions.)*

---

### Appendix A: Step 0 audit results {#appendix-a}

**Recorded:** 2026-04-21 (Step 0). Source-of-truth for token lists and identifier counts used by Steps 1–8a.

#### A.1 `Tugcard*` / `useTugcard*` identifier surface

`rg "\bTugcard\w+|\buseTugcard\w+" tugdeck/src` → **133 occurrences across 17 files** (matches plan assumption).

Definitions (9, as enumerated in Context):

| Identifier | Kind | Definer | Renamed in Step |
|---|---|---|---|
| `CardMeta` | type | `tugdeck/src/card-registry.ts:71` | 1 ✓ |
| `CardDataContext` | React context | `tugdeck/src/components/tugways/hooks/use-card-data.ts:58` | 2 ✓ |
| `CardDataContextValue` | type | `tugdeck/src/components/tugways/hooks/use-card-data.ts:50` | 2 ✓ |
| `CardDataProvider` | FC | `tugdeck/src/components/tugways/hooks/use-card-data.ts:69` | 2 ✓ |
| `useCardData` | hook | `tugdeck/src/components/tugways/hooks/use-card-data.ts:86,94,112` | 2 ✓ |
| `CardPersistenceCallbacks` | type | `tugdeck/src/components/tugways/use-card-persistence.tsx:58` | 3 ✓ |
| `UseCardPersistenceOptions` | type | `tugdeck/src/components/tugways/use-card-persistence.tsx:32` | 3 ✓ |
| `useCardPersistence` | hook | `tugdeck/src/components/tugways/use-card-persistence.tsx:123` | 3 ✓ |
| `useCardDirty` | hook | `tugdeck/src/components/chrome/tug-pane.tsx:220` | 4 ✓ |

**Note:** `useCardDirty` had **zero call sites** at Step 0 — only the export in `tug-pane.tsx`. Step 4 renames for a coherent public surface; prose in `tug-tab-bar.tsx` and `hello-world-card.tsx` was swept so `rg "\bTugcard\w+" tugdeck/src` is clean.

**Prose-only references:** Cleared in Step 4 for the code-identifiers sweep. `.tugcard*` CSS **class** names remain (see [D03]).

#### A.2 CSS token inventory (authoritative)

Themes (`tugdeck/styles/themes/brio.css`, `harmony.css`) do **not** reference `--tug-card-*` / `--tugx-card-*`: R03 is fully mitigated.

`--tug-card-title-bar-*` (non-`x` prefix) tokens have **no source definers or consumers** — they appear only in `tugdeck/docs/pairing-audit-results.md`, `tugdeck/docs/renders-on-survey.md`, and `tugdeck/scripts/audit-tokens.ts` JSDoc examples. Step 6's "Today" column in the token-rename table is therefore docs-only for the first seven rows; update those doc surfaces but do not expect source-CSS hits.

All live `--tugx-card-*` token definitions are in two files:
- `tugdeck/src/components/tugways/tug-pane.css` — frame, title-bar, control, content-dim, accessory, findbar (lines 47–102 define; lines 115–384 consume).
- `tugdeck/src/components/tugways/tug-pane-banner.css` — banner (lines 40–50 + 243–259 define; lines 72–198 consume).

Non-CSS-file consumers:
- `tugdeck/styles/chrome.css:51` — reads `--tugx-pane-dim-overlay`.
- `tugdeck/src/components/tugways/cards/gallery-title-bar.tsx:112,115` — inline-style readers of `--tugx-pane-border` and `--tugx-pane-title-bar-bg-inactive`.

Non-CSS informational surfaces (docs + scripts):
- `tugdeck/scripts/audit-tokens.ts:173,197,198,828` — JSDoc examples (Step 9).
- `tugdeck/docs/pairing-audit-results.md` — 15 occurrences (updates ride along with Steps 5–6).
- `tugdeck/docs/renders-on-survey.md` — 6 occurrences (same).

#### A.3 Token families by step

**Step 5 — Frame tokens (5):** ✓ renamed to `--tugx-pane-*`
- `--tugx-pane-bg`
- `--tugx-pane-border`
- `--tugx-pane-shadow-active`
- `--tugx-pane-shadow-inactive`
- `--tugx-pane-dim-overlay`

**Step 6 — Title-bar tokens (9):** ✓ renamed to `--tugx-pane-title-bar-*` / `--tugx-pane-title-fg-*`
- `--tugx-pane-title-bar-bg-active`
- `--tugx-pane-title-bar-bg-inactive`
- `--tugx-pane-title-bar-bg-collapsed`
- `--tugx-pane-title-bar-divider`
- `--tugx-pane-title-bar-icon-active`
- `--tugx-pane-title-bar-icon-inactive`
- `--tugx-pane-title-bar-icon-hover`
- `--tugx-pane-title-fg-active`
- `--tugx-pane-title-fg-inactive`

(Legacy `--tug-card-title-bar-*` names were docs-only; pairing + renders surveys now cite the `--tugx-pane-*` aliases.)

**Step 7 — Control tokens (18):** ✓ `--tugx-pane-control-*` — On/off × fg/bg/border × rest/hover/active.
- `--tugx-pane-control-on-fg-rest` / `-hover` / `-active`
- `--tugx-pane-control-on-bg-rest` / `-hover` / `-active`
- `--tugx-pane-control-on-border-rest` / `-hover` / `-active`
- `--tugx-pane-control-off-fg-rest` / `-hover` / `-active`
- `--tugx-pane-control-off-bg-rest` / `-hover` / `-active`
- `--tugx-pane-control-off-border-rest` / `-hover` / `-active`

**Step 7a — Content-dim / accessory / findbar tokens (10):** ✓ `--tugx-pane-*`
- `--tugx-pane-content-dim-desat-color`
- `--tugx-pane-content-dim-desat-amount`
- `--tugx-pane-content-dim-wash-color`
- `--tugx-pane-content-dim-wash-blend`
- `--tugx-pane-accessory-bg`
- `--tugx-pane-accessory-border`
- `--tugx-pane-findbar-bg`
- `--tugx-pane-findbar-border`
- `--tugx-pane-findbar-match`
- `--tugx-pane-findbar-match-active`

**Step 8 — Banner tokens (7):** ✓ `--tugx-pane-banner-*`
- `--tugx-pane-banner-strip-bg`
- `--tugx-pane-banner-strip-fg`
- `--tugx-pane-banner-strip-border`
- `--tugx-pane-banner-detail-bg`
- `--tugx-pane-banner-detail-fg`
- `--tugx-pane-banner-detail-border`
- `--tugx-pane-banner-backdrop-bg`

**Totals (naming):** Steps 5–8: 5 frame + 9 title-bar + 18 control + 10 content-dim/accessory/findbar + 7 banner = **49** pane-chrome **`--tugx-pane-*`** aliases across `tug-pane.css` and `tug-pane-banner.css`. No `--tugx-card-*` pane-chrome tokens remain in source (Step 9 greps for legacy `--tug-card-*` / `--tugx-card-*` elsewhere).

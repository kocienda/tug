<!-- devise-skeleton v4 -->

## Prompt-Entry Completion Fixes {#completion-fixes}

**Purpose:** Two byte-neutral completion bug fixes for the Dev card prompt editor — pasting a leading `/` or `@` token opens the completion popup (today it doesn't), and a non-whitespace character to the right of the caret no longer drops the mid-text inline ghost. No typography, no smart paste, no toggle — the prompt-entry stays a plain-text surface.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-19 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

This plan is the salvage of `dash/smart-editing.md`. That effort (smart quotes, smart paste, a "Smart editing" toggle) was scrapped: the prompt-entry is the *bytes you send to Claude*, so typographic substitution there fights its own medium — typography is a transcript-rendering concern, not an input concern. What survives are the two items that were never typography at all but plain editing-correctness bugs, both byte-neutral:

- **#3 — paste does not open the completion popup.** The cause (found during vet): the position-zero provider reads DOM `textContent`, which is **stale** inside the detection `transactionExtender`, and the slash command provider is **synchronous** (`local-commands.ts`: "command providers don't carry the async `subscribe` hook"), so its results are never refreshed after the DOM paints. Typing works only because each *subsequent* keystroke re-derives against a now-fresh DOM; a one-shot paste has no next keystroke, so the popup stays empty.
- **#4 — a char to the right of the caret drops the inline ghost.** The mid-text inline ghost requires `isBoundary(text[caret])` (whitespace/atom/EOD). A repositioned caret with a closing quote/bracket/punctuation to its right hides the ghost. The position-0 and `@` popups already ignore right-of-caret (`deriveQueryUpdate` checks only collapsed selection + head ≥ trigger+1 + no newline), so only the ghost needs work.

#### Strategy {#strategy}

- Keep both fixes confined to the completion engine; touch no settings, no facet, no new component.
- #3: fix the activation refresh for **sync** providers, dispatched **outside** the CM6 update cycle (the engine forbids nested dispatch). Spike first to confirm the `@` file provider is async and may already work.
- #4: broaden one pure predicate (`isBoundary`) and verify the popups are already correct.
- Test the pure logic exhaustively in `bun:test`; verify real-view behavior in the app-test harness or manually — never a jsdom `EditorView` (a banned render pattern).

#### Success Criteria (Measurable) {#success-criteria}

- Pasting `/tugplug:commit` into an empty prompt shows the slash popup; pasting `@src/foo` shows the file popup — identical to typing the same text. Verified in-app / app-test.
- Pressing Enter right after such a paste still submits per the editor's Return policy (the popup keymap does not swallow it). Verified in-app.
- With the caret at the end of `hello /rewi` and a `”`/`)`/`"` immediately to its right, the inline ghost still shows and Tab accepts it; `/re|wi` (mid-token) still shows nothing. Verified by `inline-command-ghost` unit tests + in-app.
- No change to typed-character behavior or to the bytes of any prompt. Verified by the existing editor tests staying green.

#### Scope {#scope}

1. Paste opens the slash/`@` completion popups (#3).
2. Inline ghost survives a closing char to the right of the caret (#4).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Smart quotes / curly apostrophes, smart paste space management, and the "Smart editing" toggle — all abandoned (transcript-side typography may be explored separately).
- Any change that alters the bytes a prompt sends to Claude.
- New settings, facets, or persistence.

#### Dependencies / Prerequisites {#dependencies}

- The completion engine: `completion-extension.ts` (`detectRejoin`, `completionExtender`, `completionPlugin`, `installProviderSubscription`), `cards/completion-providers/position-zero.ts`, `cards/completion-providers/local-commands.ts`.
- The pure ghost module `lib/inline-command-ghost.ts` and its existing test.

#### Constraints {#constraints}

- `bun run check` stays clean; warnings are errors.
- [L02] completion snapshots reach React via `useSyncExternalStore`; no React state for appearance [L06].
- CM6 prohibits dispatching from inside `ViewPlugin.update` / `updateListener`; any re-dispatch must be deferred (microtask) — this is exactly why detection lives in a `transactionExtender`.
- Fixes must not regress the existing popup/submit behavior (notably: an active popup's high-precedence keymap must not steal Enter/Shift+Return after a paste).

#### Assumptions {#assumptions}

- `detectRejoin` already activates a session on a paste (it runs on any `docChanged`, scans back, activates) — confirmed in code; the gap is only the empty `filtered` from the stale read.
- `view.dispatch` is synchronous, so a microtask scheduled after activation sees the committed doc and a painted DOM.

---

### Open Questions {#open-questions}

#### [Q01] Is the `@` file provider already async (and thus already working on paste)? (OPEN → resolve in Step 1) {#q01-file-provider-async}

**Question:** Does the `@` file provider carry the `subscribe` hook, so its post-commit refresh already fills the popup on paste — leaving only the **sync** slash provider broken?

**Why it matters:** If yes, the fix can be the general sync-provider refresh and we avoid special-casing.

**Plan to resolve:** Spike in Step 1 (read the provider construction + observe in-app).

**Resolution:** OPEN — to be decided in #step-1.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Re-dispatch inside the update cycle throws | high | med | Defer to a microtask outside `update`; reuse the pattern `installProviderSubscription` already uses (dispatch from a callback, not in `update`) | A nested-update error in dev |
| Post-paste popup steals the next Enter | med | low | Reuse the existing `detectRejoin` activation + `completionPopupIsInteractive` gate (empty `filtered` owns no keys); only fill `filtered`, don't change keymap precedence | Enter-after-paste submits unexpectedly |
| Broadened ghost boundary shows a ghost where it overlaps text | low | low | Only treat *closing* punctuation/quotes/brackets as boundaries; keep the token-start scan unchanged | A ghost paints over following text |

---

### Design Decisions {#design-decisions}

#### [P01] Prompt-entry stays a plain-text surface; this is correctness-only (DECIDED) {#p01-plain-text}

**Decision:** Drop smart quotes, smart paste, and the toggle. Ship only the two byte-neutral completion fixes.

**Rationale:** Typographic substitution in an LLM input box mutates the sent bytes and fights the medium (the abandoned plan needed an `isInsideCode` guard precisely to avoid corrupting code). Formatting belongs to the transcript renderer, not the input.

**Implications:** No settings/facet/persistence changes; `dash/smart-editing.md` is superseded by this plan.

#### [P02] #3: refresh sync providers after activation, deferred outside the update cycle (DECIDED) {#p02-sync-refresh}

**Decision:** When a completion session activates with a **synchronous** provider, re-run the provider against the committed state once, on a microtask after the transaction applies, and dispatch an `updateEffect` if `filtered` changed. Harden `wrapPositionZero` to read the editor **state** doc rather than DOM `textContent`.

**Rationale:** `detectRejoin` already activates on paste; the only defect is the stale-DOM read producing empty `filtered`, with no async `subscribe` to refresh it for sync providers. A deferred re-derive (DOM/state fresh by then) fixes paste *and* the latent bare-`/` case, without changing keymap precedence and without a nested dispatch.

**Implications:** Small additions in `completionPlugin` (mirror `installProviderSubscription`'s out-of-update dispatch) and a one-line source change in `position-zero.ts`.

#### [P03] #4: broaden the inline-ghost right boundary; popups are verified, not changed (DECIDED) {#p03-ghost-boundary}

**Decision:** In `lib/inline-command-ghost.ts`, treat a closing quote/bracket/punctuation (`” ’ ) ] } " '` …) to the right of the caret as a token end, in addition to whitespace/atom/EOD. Leave `deriveQueryUpdate` (the popups) unchanged and add a verification test that it already ignores right-of-caret.

**Rationale:** The repositioning cases place exactly these closing chars to the right; they should not dismiss completion. The popups already survive, so changing them would be churn.

**Implications:** One predicate change in the pure module + a case-table test; a popup verification test.

#### [P04] Tests: pure / EditorState-level in `bun:test`; real-view behavior in app-test or manual (DECIDED) {#p04-test-strategy}

**Decision:** Exhaust the pure ghost logic with a table-driven `bun:test`. Verify paste→popup and Enter-after-paste in the app-test harness (`tests/app-test/`, `just app-test`) or manually. Do **not** stand up a jsdom `EditorView` in `bun:test`.

**Rationale:** `EditorView` needs a DOM; a jsdom `EditorView` is the banned render-test pattern and cuts against the repo's pure-only editor-test convention (`inline-command-ghost.test.ts`: "no DOM, no CodeMirror").

**Implications:** `bun:test` covers `isBoundary`/`computeInlineGhost`; the #3 activation path is verified in the running app.

---

### Specification {#specification}

**Spec S01: sync-provider activation refresh** {#s01-sync-refresh}

In `completionPlugin.update`, when the field transitions to `active` and the active provider has **no** `subscribe` hook: schedule a microtask (`queueMicrotask`) that reads `view.state.field(completionField)`; if still active and same provider, recompute `filtered = provider(live.query)` (DOM/state now committed), clamp `selectedIndex`, and `view.dispatch({ effects: updateEffect.of({ query, filtered, selectedIndex }) })`. Guard: dispatch only if `filtered` differs from the stored value (no-op → no dispatch → no loop). This is the same out-of-update dispatch shape `installProviderSubscription` already uses for async providers.

`wrapPositionZero` reads the editor **state** doc (via a delegate accessor returning `view.state.doc.toString()`) instead of `getEditorElement().textContent`, so the position-0 gate is correct whenever it runs.

**Spec S02: inline-ghost right boundary** {#s02-ghost-boundary}

`isBoundary(ch)` returns true for: `undefined`, the atom char (`U+FFFC`), any whitespace, **and** a closing-context character — closing quotes `” ’ "` `'`, closing brackets `) ] }`, and sentence punctuation `. , ; : ! ?`. The token-*start* scan is unchanged (the `/`-led left token still defines the command). Pure; exported `GHOST_BOUNDARY_CASES` table drives the tests.

#### State Zone Mapping {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Completion session (`filtered`, active) | structure (CM6 field) | `updateEffect` from an out-of-update microtask dispatch | [L02] (snapshot read), engine-internal |
| Inline-ghost visibility | structure (pure compute) | `computeInlineGhost` over doc+caret; no React state | [L06] |

> No new React state, no new persistent state, no settings.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| sync-provider activation refresh | add | `tug-text-editor/completion-extension.ts` (`completionPlugin`) | Spec S01; out-of-update microtask dispatch |
| `wrapPositionZero` | modify | `cards/completion-providers/position-zero.ts` | Read editor state, not DOM `textContent` |
| delegate doc accessor | add (if needed) | `tug-prompt-entry.tsx` (`TugPromptEntryDelegate`) | Returns `view.state.doc.toString()` for position-zero |
| `isBoundary`, `GHOST_BOUNDARY_CASES` | modify + table | `lib/inline-command-ghost.ts` | Spec S02 |

> No new files strictly required; a small `GHOST_BOUNDARY_CASES` export co-locates with the ghost module.

---

### Test Plan Concepts {#test-plan-concepts}

#### Categories {#test-categories}

| Category | Purpose | When |
|----------|---------|------|
| **Unit (table-driven, `bun:test`)** | Pure ghost boundary | `isBoundary`/`computeInlineGhost` via `GHOST_BOUNDARY_CASES` |
| **App-test / manual** | Real-view behavior | paste→popup, Enter-after-paste, caret-reposition keeps ghost |

#### What stays out of tests {#test-non-goals}

- No jsdom `EditorView` render tests, no mock-store assertion tests (banned). The #3 activation path is verified in the running app, not a fake view.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. `implement` runs these on its `tugutil dash` worktree.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Paste opens the completion popup (#3) | done | bc01da55 |
| #step-2 | Inline ghost survives a char to the right (#4) | done | 20ab7717 |
| #step-3 | Integration checkpoint | done | (verification only) |

---

#### Step 1: Paste opens the completion popup {#step-1}

**Commit:** `fix(prompt-entry): open completion popups on paste`

**References:** [P02] sync refresh, [P04] test strategy, [Q01] file-provider async, Spec S01, Risk table, (#context, #s01-sync-refresh)

**Artifacts:**
- Spike notes: is the `@` file provider async (already working) vs the sync slash provider (broken)?
- Sync-provider activation refresh in `completionPlugin` (Spec S01), dispatched on a microtask.
- `wrapPositionZero` reads editor state, not DOM.

**Tasks:**
- [ ] Spike: read the `@`/`/` provider construction and observe in-app which one fails on paste; record in [Q01].
- [ ] Add the out-of-update microtask refresh for sync providers; guard against no-op dispatch loops.
- [ ] Change `wrapPositionZero` to read the state doc (add a delegate accessor if needed).
- [ ] Confirm the popup-active keymap still yields Enter/Shift+Return after a paste (Risk row).

**Tests:**
- [ ] `bun run check` clean; existing completion tests green.

**Checkpoint:**
- [ ] In-app: paste `/tugplug:commit` into an empty prompt → slash popup; paste `@src/` → file popup; Enter right after a paste still submits per the Return policy.

---

#### Step 2: Inline ghost survives a char to the right of the caret {#step-2}

**Commit:** `fix(prompt-entry): keep the inline ghost across caret repositioning`

**References:** [P03] ghost boundary, [P04] test strategy, Spec S02, (#p03-ghost-boundary, #s02-ghost-boundary)

**Artifacts:**
- Broadened `isBoundary` in `lib/inline-command-ghost.ts` + exported `GHOST_BOUNDARY_CASES`.
- A verification test that `deriveQueryUpdate` already keeps the popup active with a non-whitespace char to the caret's right.

**Tasks:**
- [ ] Broaden `isBoundary` (Spec S02); keep the token-start scan unchanged.
- [ ] Add `GHOST_BOUNDARY_CASES` and iterate them in the test.

**Tests:**
- [ ] Table-driven (`inline-command-ghost.test.ts`): caret at end of `hello /rewi` + `”`/`)`/`"` → ghost shows; `/re|wi` → null; existing cases stay green.

**Checkpoint:**
- [ ] In-app: type `/rewr`, reposition so a `"` sits immediately right of the caret → ghost still shows, Tab accepts; the slash/`@` popups stay open with a char to the caret's right.

---

#### Step 3: Integration Checkpoint {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `N/A (verification only)`

**References:** [P01]–[P04], (#success-criteria)

**Tasks:**
- [ ] Walk every [#success-criteria] bullet in the running app; confirm no change to typed-character behavior or prompt bytes.

**Tests:**
- [ ] `cd tugdeck && bun run check` clean; `bun test` (ghost suite + existing completion tests) green.

**Checkpoint:**
- [ ] All success criteria pass in-app.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Pasting a leading `/`/`@` token opens the matching completion popup, and the mid-text inline ghost survives a closing character to the right of the caret — with the prompt-entry unchanged as a plain-text surface.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Paste `/command` / `@path` opens the popup; Enter-after-paste still submits.
- [ ] Inline ghost survives a closing char to the right of the caret; Tab accepts.
- [ ] No new settings/facets; no change to prompt bytes or typed-character behavior.
- [ ] `bun run check` and `bun test` clean.

| Checkpoint | Verification |
|------------|--------------|
| Paste → popup | In-app `/`,`@` paste + Enter-after-paste |
| Caret robustness | `GHOST_BOUNDARY_CASES` green + in-app repositioning |

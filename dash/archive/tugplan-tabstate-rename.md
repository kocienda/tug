<!-- tugplan-skeleton v2 -->

## Tabstate Rename — Tugbank Prefix and `tabId` Parameter {#tabstate-rename}

**Purpose:** Retire the `dev.tugtool.deck.tabstate/` tugbank key prefix and rename it to `dev.tugtool.deck.cardstate/`, rename the `tabId` parameter name to `cardId` throughout `settings-api.ts` and callers, and rename `putTabState` / `readTabStates` → `putCardState` / `readCardStates`. **No migration.** Tug has no production users; any pre-existing `tabstate/` rows on a dev's tugbank are orphaned and ignored. Redo the cards if you miss them.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | complete |
| Target branch | main |
| Last updated | 2026-04-21 |
| Predecessor | [tugplan-vocabulary-pane-rename.md](./tugplan-vocabulary-pane-rename.md) (complete — Deck → Pane → Card vocabulary landed) |
| Sibling | [tugplan-card-and-token-sweep.md](./tugplan-card-and-token-sweep.md) (in-source rename + token work; runs independently of this plan) |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Tug app persists per-card state (scroll, selection, card-specific content like tide's session binding) in tugbank under the domain `dev.tugtool.deck.tabstate`. That domain name, and the `tabId` parameter name on the read/write functions, is the last data-layer fossil from the pre-two-table era when a "tab" was an in-pane content identity. After the two-table rename, the content identity is a *card* — and every other tab-related identifier has already moved to `card*`. The tugbank domain and parameter names are the final stranger in the room.

There are no production users. A dev launching at head after this rename will see per-card state reset because old rows at the `tabstate/` prefix are no longer read. That's acceptable: any pre-existing per-card state (scroll positions, tide session bindings, prompt history) was developer test data. Redoing the cards is cheaper than carrying a migration layer forever.

#### Strategy {#strategy}

- **Rename the domain name in one atomic commit.** `dev.tugtool.deck.tabstate` → `dev.tugtool.deck.cardstate`. URL, `readDomain` call, JSDoc, comments, test URLs — all in one pass.
- **Rename the parameter names in the same commit.** `tabId` → `cardId` across `settings-api.ts` and every test / caller that references the parameter.
- **Function rename carries the name change:** `readTabStates` → `readCardStates`, `putTabState` → `putCardState`. Paired with parameter and URL rename.
- **No migration, no fallback.** Pre-existing `tabstate/` rows on any dev's tugbank become orphaned. No user data is at risk (there are no users).
- **Test fixtures rename to `card-*`** for readability once the vocabulary has flipped.

#### Success Criteria (Measurable) {#success-criteria}

- `rg "tabstate|tabState|TabState" tugdeck/src` returns zero matches.
- `rg "\btabId\b|\btabIds\b" tugdeck/src` returns zero matches.
- `rg "readTabStates|putTabState" tugdeck/src` returns zero matches.
- `rg "dev\\.tugtool\\.deck\\.tabstate" tugdeck/src` returns zero matches.
- A running app launched at head writes per-card state only under `dev.tugtool.deck.cardstate/{cardId}` and reads only from the same prefix.
- Every step commit: `bun x tsc --noEmit` clean, `bun test` green.

#### Scope {#scope}

1. Rename `putTabState` → `putCardState` (parameter `tabId` → `cardId`, URL domain from `.tabstate` → `.cardstate`).
2. Rename `readTabStates` → `readCardStates` (parameter `tabIds` → `cardIds`, `readDomain("…tabstate")` → `readDomain("…cardstate")`).
3. Update every caller of the two functions (`deck-manager.ts`, `main.tsx`).
4. Rename JSDoc / comments across `layout-tree.ts`, `deck-manager.ts`, `serialization.ts`, `main.tsx` that describe the tugbank prefix.
5. Rename test-fixture ids from `tab-*` to `card-*` and URL assertions from `.tabstate/` to `.cardstate/`.
6. Integration checkpoint.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Migration of pre-existing `tabstate/` rows.** Explicitly not supported. No backwards-compat shim, no fallback read, no launch-time migrator. Dev tugbanks that carried pre-rename rows see those rows orphaned and ignored — redo the cards.
- **Data-model identifiers:** `CardState`, `CardStateBag`, `CardHost`, etc. — all frozen.
- **Card vocabulary inside the codebase:** covered by the sibling plan `tugplan-card-and-token-sweep.md`.
- **Client-side tugbank API rework:** `TugbankClient.readDomain` / `put` / `delete` stay as-is.
- **Rust-side (tugbank server) key-layout changes:** the server stores whatever key the client PUTs. No server work required.

#### Dependencies / Prerequisites {#dependencies}

- `tugplan-vocabulary-pane-rename.md` closed. (It is.)
- Green HEAD on main. All tests passing.

#### Constraints {#constraints}

- `bun test` must be green at every step commit.
- No backwards-compat code in the source tree. Clean slate.

#### Assumptions {#assumptions}

- No external consumer reads the `tabstate/` prefix directly. (Swift reads layout + focused-card-id, not per-card state.)
- No production users. Dev per-card state loss is acceptable.

---

### Design Decisions {#design-decisions}

#### [D01] No migration — clean slate (DECIDED) {#d01-no-migration}

**Decision:** No launch-time migration, no legacy fallback read, no backwards-compat shim. Pre-existing `tabstate/` rows in any dev tugbank are orphaned and ignored.

**Rationale:**
- No production users. Nothing to protect.
- Migration code is carried forward forever; every future reader has to understand it. The cost-to-benefit is negative.
- Dev test data is cheap to recreate.

**Implications:** Devs will see their pre-rename per-card state (scroll positions, tide sessions, prompt history) gone on next launch after this plan lands. Saves made after this plan write to `cardstate/` and behave normally going forward. Orphaned `tabstate/` rows persist on disk until tugbank gets cleaned up, but they're invisible to the app.

#### [D02] Functions rename in lockstep with the URL change (DECIDED) {#d02-function-rename}

**Decision:** `putTabState` → `putCardState`, `readTabStates` → `readCardStates`. No backwards-compat aliases.

**Rationale:**
- The function names echo the URL path; changing one without the other is incoherent.
- No external consumer means no deprecation cycle needed.

**Implications:** Every call site + test asserts under the new names. Comments across the tree that reference `putTabState` / `readTabStates` also update.

#### [D03] Test fixture ids rename (`tab-1` → `card-1`) (DECIDED) {#d03-test-fixture-ids}

**Decision:** Test fixture IDs in `settings-api.test.ts` and `deck-manager.test.ts` rename from `tab-*` to `card-*`.

**Rationale:**
- Tests should read coherently under the current vocabulary.

**Implications:** Test body edits are mechanical.

---

### Execution Steps {#execution-steps}

#### Step 1: Rename `putTabState` → `putCardState` {#step-1}

**Commit:** `Rename putTabState → putCardState (wire URL, parameter, callers)`

**References:** [D02] Function rename

**Artifacts:**
- `tugdeck/src/settings-api.ts` — function rename, parameter `tabId` → `cardId`, URL path `dev.tugtool.deck.tabstate` → `dev.tugtool.deck.cardstate`, JSDoc.
- Callers: `deck-manager.ts`.
- Tests: `settings-api.test.ts` — describe block + URL assertions + fixture ids.

**Tasks:**
- [x] Rename the function + parameter + URL in `settings-api.ts`.
- [x] Update JSDoc.
- [x] Update `deck-manager.ts` import + call site.
- [x] Update every test URL assertion and describe label.
- [x] Rename test fixture ids to `card-*` per [D03].

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean; `bun test` green.
- [x] `rg "putTabState" tugdeck/src` returns zero matches.

---

#### Step 2: Rename `readTabStates` → `readCardStates` {#step-2}

**Depends on:** #step-1

**Commit:** `Rename readTabStates → readCardStates (domain, parameter, callers)`

**References:** [D02] Function rename

**Artifacts:**
- `tugdeck/src/settings-api.ts` — function rename, parameter `tabIds` → `cardIds`, `readDomain("…tabstate")` → `readDomain("…cardstate")`.
- Callers: `main.tsx`.
- Tests: `settings-api.test.ts` — describe block + fixture ids + URL assertions.

**Tasks:**
- [x] Rename function + parameter + domain in `settings-api.ts`.
- [x] Update JSDoc.
- [x] Update `main.tsx` local variable (`tabStates` → `cardStates`) and call site.
- [x] Update every test describe + URL + fixture.

**Checkpoint:**
- [x] `bun x tsc --noEmit` clean; `bun test` green.
- [x] `rg "readTabStates" tugdeck/src` returns zero matches.
- [x] `rg "\btabId\b|\btabIds\b|tabState\b|tabStates\b" tugdeck/src` returns zero matches.

---

#### Step 3: Comment + JSDoc cleanup {#step-3}

**Depends on:** #step-2

**Commit:** `Sweep remaining tabstate references in comments and JSDoc`

**Artifacts:**
- `tugdeck/src/layout-tree.ts` — comments describing the tugbank location.
- `tugdeck/src/deck-manager.ts` — comment about the persistence prefix.
- `tugdeck/src/serialization.ts` — JSDoc prose.
- `tugdeck/src/main.tsx` — any remaining grep hits.

**Tasks:**
- [x] Grep-walk every remaining `tabstate` / `tabState` / `TabState` reference in `tugdeck/src`. Rewrite each to the current (cardstate) vocabulary.

**Checkpoint:**
- [x] `rg "tabstate|tabState|TabState" tugdeck/src` returns zero matches.
- [x] `bun test` green.

---

#### Step 4: Integration checkpoint {#step-4}

**Depends on:** #step-3

**Commit:** `N/A (verification only)`

**Tasks:**
- [x] Full build matrix: `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run`.
- [x] Grep sweep:
  ```
  rg "\btabId\b|\btabIds\b|tabState\b|tabStates\b|putTabState|readTabStates|dev\\.tugtool\\.deck\\.tabstate" tugdeck/src
  ```
  Expected: zero matches.
- [x] Launch app; verify card saves write to `cardstate/` (dev console / Network tab).

**Checkpoint:**
- [x] All four build checks green.
- [x] Grep sweep clean.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Tugbank per-card state is stored under `dev.tugtool.deck.cardstate/{cardId}`. The function API reads `readCardStates` / `putCardState` with `cardId` parameters. No migration, no fallback — any pre-existing `tabstate/` rows are orphaned and ignored. No non-current code references `tabstate` / `tabId` / `TabState`.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] All 3 implementation steps committed; integration checkpoint (#step-4) passes.
- [x] Grep sweep clean — zero `tabstate` / `tabId` references remain.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Consider whether other domain names (`dev.tugtool.deck.layout`, `dev.tugtool.app.theme`) need a vocabulary review. They probably don't — `layout` and `theme` describe what they store, not a deprecated data-model concept.

---

### Open Questions {#open-questions}

*(Plan-authoring decisions resolved as [D01]–[D03]. No open questions.)*

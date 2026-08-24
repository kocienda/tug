<!-- plan authored against devise-skeleton v4 -->

## Fast Refresh Boundary Hygiene — Make the Transcript Spine Self-Accepting (Tier 1) {#fast-refresh-hygiene}

**Purpose:** Stop editing the two transcript spine files (`dev-card.tsx`, `dev-card-transcript.tsx`) from triggering a full page reload under HMR, by making each a clean React Fast Refresh boundary — and lock in the invariant that any reload that *does* still happen restores the deck faithfully (cards survive, no orphan sessions). Scope is deliberately limited to safe, mechanical, sweep-gated changes; nothing experimental.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-15 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

`@vitejs/plugin-react` treats a module as a self-accepting Fast Refresh boundary **only when every runtime export is a React component** (types/interfaces are erased and don't count). A "mixed" module (component + a hook/const/helper) or a pure value/util module is non-accepting: when edited, the HMR update propagates to its importers, and if it reaches the entry (`main.tsx`) **without crossing a component-only boundary**, Vite does a full page reload — which re-resumes the transcript from JSONL (a multi-second lock) and violates the project's baked-in invariant that HMR must never reload data/transcript.

A sweep (`tugdeck/scripts/fast-refresh-sweep.ts`) found the transcript host sits on a **boundary-free spine** — `dev-card-transcript.tsx → dev-card.tsx → main.tsx`, all `[mixed]` — so editing either spine file full-reloads. Those two files are edited often during transcript work, so making them self-accept is high-value and low-risk: each fix is the existing `dev-restore-sheet.tsx → dev-restore-sheet-gate.ts` pattern (evict non-component exports to a transparent sibling), verified by the sweep. This phase does **only** that, plus a regression guard for a separate boot bug found during investigation: a recent change rebuilt the deck from an empty tugbank cache on reload, blowing away cards and stranding "live in another card" sessions. Reducing the *frequency* of reloads (the boundary work) and ensuring any reload that still happens is *non-destructive* (the guard) are independent; this phase does both at the safe end of each.

#### Strategy {#strategy}

- **Only safe, mechanical changes.** Every code change is a pure relocation of non-component exports to a transparent sibling, gated by the sweep (`escapes=false`) and `tsc`. No runtime behavior change, no new abstractions, no codebase reorganization, nothing whose efficacy is unproven by inspection.
- **Frequency and severity are separate problems.** The boundary work reduces how often the spine reloads ([P01]); the faithful-restore guard ensures any reload that still happens is non-destructive ([P07]). The guard is the safety net and stands on its own.
- **Land the oracle first.** Make the sweep importable with an assert/exit-code mode and add a pure-logic drift test, so each boundary change has a falsifiable, regenerable checkpoint ([P05]).
- **Fix the spine files themselves.** Make `dev-card.tsx` and `dev-card-transcript.tsx` component-only so they self-accept ([P01], [P02]). This stops the full reload when *those files* are edited — the concrete, deliverable win.
- **Do not chase the transcript leaves.** Editing a tool-block / body-kind still full-reloads after this phase; the leaves live in a dense cyclic cluster that a spine boundary does not shield (see #leaf-cluster), and fixing them is a larger, riskier effort explicitly deferred ([#non-goals], [#roadmap]).

#### Success Criteria (Measurable) {#success-criteria}

- `bun run scripts/fast-refresh-sweep.ts --assert src/components/tugways/cards/dev-card.tsx src/components/tugways/cards/dev-card-transcript.tsx` exits 0 (neither spine file escapes). (sweep `--assert`)
- Dev smoke: editing `dev-card.tsx` or `dev-card-transcript.tsx` refreshes in place — **no full page reload**. (manual dev observation)
- A `bun test` drift test fails if `dev-card.tsx` or `dev-card-transcript.tsx` regains a value export. (test run)
- A `bun test` guard fails if `main.tsx` constructs the `DeckManager` without first awaiting `tugbankClient.ready()` (faithful-restore invariant). (test run)
- `bunx tsc --noEmit` is clean after every step. (tsc)

> Out of scope on purpose: this phase does **not** claim to reduce the gross transcript-graph reload total or to stop leaf edits from reloading. The deliverable is the two spine files refreshing in place.

#### Scope {#scope}

1. Refactor `fast-refresh-sweep.ts` into an importable analyzer with a `--assert <files…>` exit-code mode; add a drift test.
2. Lock in the faithful-restore invariant: a pure-logic guard test that `main.tsx` awaits `tugbankClient.ready()` before `new DeckManager`, plus a documented decision ([P07]).
3. Make `dev-card.tsx` and `dev-card-transcript.tsx` component-only boundaries by evicting their value exports to transparent sibling modules.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **The transcript leaves (tool-blocks, body-kinds, chrome, contexts).** Editing them still full-reloads after this phase. They sit in a cyclic cluster a spine boundary does not shield (#leaf-cluster); fixing them is per-leaf eviction (the former "Tier 2") — larger and riskier — deferred ([#roadmap]).
- **Detaching the gallery graph / any dynamic-import restructuring.** Considered and rejected for this phase: its leaf benefit is unproven by inspection and depends on Vite's runtime dynamic-import behavior — i.e. not a safe change. Recorded as a possible future experiment ([#roadmap]), not done here.
- **Shared tugways primitives** (`tug-sheet`, `tug-popover`, `tug-list-row`, `theme-provider`, …) and **value-only lib modules** (`lib/code-session-store*`, `protocol.ts`, …) — deferred ([#roadmap]).
- Any runtime/visual/state-zone change. This is pure module organization plus a boot-ordering guard; behavior, DOM, and state are unchanged.
- A runtime/fake-DOM HMR integration test — banned; the sweep is the oracle ([P05]).
- Re-fixing the `tugbankClient.ready()` boot race — the await is **already restored** in `main.tsx`. This phase only adds the regression guard.

#### Dependencies / Prerequisites {#dependencies}

- `tugdeck/scripts/fast-refresh-sweep.ts` (already committed) — the analysis oracle this plan extends.
- `tugbankClient.ready()` await already restored in `main.tsx` boot (committed) — [P07] only guards against its regression.
- HMR is always running in dev; no manual builds. Checkpoints use `bunx tsc --noEmit`, `bun test`, and the sweep CLI.

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** (workspace policy); `bunx tsc --noEmit` must stay clean.
- Use `bun`, never `npm`/`npx`.
- Tuglaws apply (tugdeck work): one `root.render()` [L01]; external state via `useSyncExternalStore` [L02]; registrations via `useLayoutEffect` [L03]; appearance via CSS/DOM [L06]. The hook relocation in #step-3 preserves its zone/mechanism unchanged.
- Types/interfaces may remain in a `.tsx` boundary file (erased at runtime — they do not break the boundary).
- No fake-DOM tests (happy-dom is deleted); the faithful-restore guard and the boundary drift test are both **pure-logic** `bun test`.

#### Assumptions {#assumptions}

- The sweep's export classifier is heuristic but the spine result is confirmed by direct reading (`dev-card.tsx`: value exports `useDevCardServices`, `registerDevCard`; `dev-card-transcript.tsx`: value exports `useSessionModelName`, `formatTranscriptTimestamp`, `useTranscriptCellMenu`); per-step checkpoints catch any misclassification.
- `registerDevCard` only needs `dev-card.tsx`'s exported `DevCardContent` (it JSX-renders it via a factory) plus `registerCard`/`FeedId` — no unexported internals (re-confirmed in #step-3, [Q02]).
- Moving a hook/value to a sibling module preserves identity for all consumers (same symbol, new path).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit, kebab-case, and stable. Plan-local decisions use `[P01]` (never `[D01]`). Steps cite decisions/specs/anchors, never line numbers. `[P06]` is intentionally retired (it was a gallery-detach experiment, cut as unsafe) — the gap is left per the skeleton's never-reuse rule.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q02] Does `registerDevCard` reference any non-exported `dev-card.tsx` internal? (OPEN) {#q02-register-internals}

**Question:** Can `registerDevCard` move to a sibling `.tsx` shim using only `dev-card.tsx`'s public exports?

**Why it matters:** If it closes over a module-private helper, that helper must also be exported (or moved), enlarging the change.

**Plan to resolve:** Read the full `registerDevCard` body in #step-3 before moving it. Initial read shows it uses only `registerCard`, `<DevCardContent>`, and `FeedId` — all importable.

**Resolution:** OPEN — confirmed in #step-3.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| A "boundary" still has a missed value export | med | med | sweep `--assert` per step proves `escapes=false` | sweep still lists the file |
| Moved hook/value breaks import paths | med | low | `tsc --noEmit` checkpoint; spine fan-out verified at 1 site each | tsc errors |
| Faithful-restore guard is brittle (source-text match) | low | med | match a stable token (`tugbankClient.ready()` awaited before `new DeckManager`), not whitespace | guard fails on an innocuous edit |

**Risk R01: A boundary that isn't.** {#r01-not-a-boundary}

- **Risk:** A spine file is declared "clean" but retains a value export (or a PascalCase const the eye reads as a component), so it still escapes.
- **Mitigation:** Every step's checkpoint runs the sweep against the touched files; `escapes=false` is the gate; the drift test freezes the cleaned files.
- **Residual risk:** The classifier could mis-call a genuine component as a value; the drift test freezes only files proven clean, so a false alarm is visible, not silent.

**Risk R02: A reload slips through and is destructive.** {#r02-destructive-reload}

- **Risk:** Boundary hygiene cannot remove *every* reload trigger (editing `main.tsx`, `hmr-bridge.ts` self-invalidating, vite config, the deferred leaves/galleries/primitives). If such a reload rebuilds the deck from a pre-DEFAULTS cache, cards vanish and sessions strand — the exact regression that motivated this plan.
- **Mitigation:** [P07] documents the invariant; #step-2 adds a guard test that `main.tsx` awaits `tugbankClient.ready()` before `new DeckManager`.
- **Residual risk:** The guard is a source-text assertion, not a live boot test; a real reload app-test is a deferred follow-on ([#roadmap]).

---

### Design Decisions {#design-decisions}

#### [P01] Make the spine file itself the boundary (DECIDED) {#p01-file-is-boundary}

**Decision:** The fix for each spine target is to make *that module* component-only so it self-accepts; we do not install a boundary above it.

**Rationale:**
- A boundary above only converts a page reload into a remount of whatever it wraps, and only helps modules reachable *only* through it.
- `dev-card-transcript.tsx` is imported by both the spine and the gallery graph; making the file itself a boundary is immune to import path (it self-accepts regardless of which graph reaches it).

**Implications:** `dev-card.tsx` and `dev-card-transcript.tsx` end the phase exporting only components (+ erased types). Their non-component exports relocate.

#### [P02] Evict value exports to transparent sibling modules (DECIDED) {#p02-sibling-eviction}

**Decision:** Non-component exports move to a sibling `*-helpers.ts` / `*-context.ts`, following the existing `dev-restore-sheet.tsx → dev-restore-sheet-gate.ts` precedent. Types/interfaces may stay in the `.tsx`.

**Rationale:** Smallest, idiomatic change; the sibling is transparent (absorbed by the boundary above) and keeps the `.tsx` clean. No new abstractions.

**Implications:** New sibling files per spine target; importers of the moved symbols update their specifier.

#### [P03] `registerDevCard` moves to a registration shim (DECIDED) {#p03-registration-shim}

**Decision:** `registerDevCard` (the only value export `main.tsx` needs from the spine) moves to a new `dev-card-registration.tsx` that imports `DevCardContent` from `dev-card.tsx`; `main.tsx` imports `registerDevCard` from the shim.

**Rationale:** Keeps `dev-card.tsx` component-only while preserving the registration entry point. The shim is `.tsx` (the factory JSX-renders `<DevCardContent>`) and is transparent (no component export).

**Implications:** One import-line change in `main.tsx`; new file `dev-card-registration.tsx`.

#### [P04] `useDevCardServices` moves to its own hook module (DECIDED) {#p04-use-dev-card-services}

**Decision:** `useDevCardServices` moves to a new `use-dev-card-services.ts`, importing `cardServicesStore` from `lib/card-services-store.ts` and the `DevCardServices` type from `dev-card.tsx` (type import — erased). Its consumer (`dev-card-transcript.tsx`) updates its import.

**Rationale:** The hook is a thin `useSyncExternalStore` wrapper over the existing store ([L02]); a dedicated module keeps `dev-card.tsx` clean without entangling the store file.

**Implications:** New file `use-dev-card-services.ts`; one import change in `dev-card-transcript.tsx`. `DevCardServices` interface stays in `dev-card.tsx` (erased; safe).

#### [P05] The sweep is the regression oracle; no fake-DOM HMR test (DECIDED) {#p05-sweep-oracle}

**Decision:** Extend `fast-refresh-sweep.ts` with an importable `analyze()` and a `--assert <files…>` mode (non-zero exit if any named file escapes); add a pure-logic `bun test` drift test over a frozen-clean file set. No runtime/fake-DOM HMR test.

**Rationale:** happy-dom is deleted and fake-DOM render tests are banned; the static reachability analysis is the faithful, fast oracle for "would this edit reload?".

**Implications:** The script gains a small CLI/exported surface; one new test file.

#### [P07] Reloads stay possible and must be non-destructive — faithful restore (DECIDED) {#p07-faithful-restore}

**Decision:** Boundary hygiene reduces reload *frequency* but cannot eliminate it; the invariant is that any reload that still occurs must restore the deck faithfully. Concretely: `main.tsx` must **never construct or persist the deck from a tugbank cache that has not received its first DEFAULTS frame** — i.e. it must `await tugbankClient.ready()` before `new DeckManager`. The await is already restored in code; this phase guards it against regression.

**Rationale:**
- A recent boot change commented out `tugbankClient.ready()`, so a reload raced the DEFAULTS frame; on a cold cache `readLayout` returned null → `buildDefaultLayout()` (empty deck) → the card was blown away, and the still-live server session showed as an orphan "Live in another card" row in the picker.
- The sweep oracle proves "did we avoid a reload"; nothing proves "a reload that slips through is non-destructive." This decision closes that gap.

**Implications:** A pure-logic guard test asserts the await precedes `new DeckManager` in `main.tsx`. A live reload app-test is a deferred follow-on ([#roadmap]).

---

### Deep Dives (Optional) {#deep-dives}

#### Why the transcript leaves are out of scope {#leaf-cluster}

It is tempting to assume that making the spine a boundary also fixes leaf edits (tool-blocks, body-kinds). It does not, and that is why they are deferred rather than quietly attempted here.

Reading the import graph shows the leaves do not hang off the spine on a clean path. They sit in a **dense, cyclic cluster**: `dev-assistant-renderer-dispatch.ts` (`[mixed]`) is imported by the spine **and** by `dev-tool-visibility-policy.ts`, `dev-permission-dialog.tsx`, `dev-route-indicator-badge.tsx`, and the tool-blocks themselves; the tool-blocks import `dispatch` back, and `dispatch ↔ dev-permission-dialog`. A leaf edit full-reloads iff the cluster has *any* boundary-free exit to the entry — and the exits include gallery files (some `[mixed]`) and other modules, not just the spine. Per [P01], a boundary above a module only shields modules reachable *only* through it; the leaves have many importers, so the spine boundary does not shield them.

Sealing every cluster exit (e.g. detaching the galleries, or evicting value exports from each leaf) is real work whose efficacy can only be proven empirically — out of scope for a safe phase. It is recorded as a follow-on ([#roadmap]). What this phase delivers is concrete and certain: editing the two spine files — frequent during transcript work — stops full-reloading.

---

### Specification {#specification}

#### Boundary rule (normative) {#boundary-rule}

- **Boundary (self-accepting):** ≥1 component export, **zero** runtime non-component exports (types/interfaces excluded), or a manual `import.meta.hot.accept()`. Editing it refreshes in place; propagation stops.
- **Mixed:** ≥1 component + ≥1 value export → non-accepting → propagates.
- **Transparent:** zero component exports (value/util/type/css only) → non-accepting → propagates, absorbed by the nearest boundary above.
- **Full page reload** occurs iff an edited module's propagation reaches a no-importer entry along non-accepting modules only.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

> This phase introduces **no new state**. It relocates one existing hook and adds a boot-ordering guard without changing zone or mechanism.

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `cardServicesStore` services (via `useDevCardServices`) | structure / external-data | module store + `useSyncExternalStore` (unchanged; hook only relocates) | [L02] |
| boot deck construction order | structure | `await tugbankClient.ready()` before `new DeckManager` (unchanged; guarded) | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `src/lib/__tests__/fast-refresh-boundary.test.ts` | Pure-logic drift test: frozen-clean files report `escapes=false`. |
| `src/__tests__/boot-faithful-restore.test.ts` | Pure-logic guard: `main.tsx` awaits `tugbankClient.ready()` before `new DeckManager` ([P07]). |
| `src/components/tugways/cards/dev-card-registration.tsx` | Transparent shim exporting `registerDevCard` ([P03]). |
| `src/components/tugways/cards/use-dev-card-services.ts` | Hook module for `useDevCardServices` ([P04]). |
| `src/components/tugways/cards/transcript-host-helpers.ts` | Sibling for `dev-card-transcript.tsx`'s evicted value exports ([P02]). Exact symbol set confirmed by the sweep in #step-4. |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `analyze()` | fn (new export) | `scripts/fast-refresh-sweep.ts` | Exposes graph build + `escapes()` for the drift test/CLI. |
| `--assert` mode | CLI flag | `scripts/fast-refresh-sweep.ts` | Non-zero exit if any named file escapes. |
| `registerDevCard` | fn (relocate) | → `dev-card-registration.tsx` | [P03]; `main.tsx` import updates. |
| `useDevCardServices` | hook (relocate) | → `use-dev-card-services.ts` | [P04]; `dev-card-transcript.tsx` import updates. |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Contract (sweep)** | `--assert` reports `escapes=false` for touched files | Every spine step checkpoint |
| **Drift Prevention** | Frozen-clean spine files stay boundary-clean; `main.tsx` keeps the `ready()` await before deck construction | #step-1, #step-2, and after each spine step |
| **Type check** | `tsc --noEmit` clean after each move | Every step |

#### What stays out of tests {#test-non-goals}

- Runtime/visual HMR behavior — covered by the static sweep oracle + a manual dev smoke; fake-DOM tests are banned ([P05]).
- A live reload app-test for faithful restore — deferred follow-on ([#roadmap]); this phase uses the pure-logic source guard.
- Per-symbol unit tests for relocated hooks/helpers — pure relocation, no logic change; `tsc` + existing tests cover them.
- Mock-store assertion tests — banned project-wide.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. References are mandatory; never cite line numbers.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Sweep oracle: importable analyzer + `--assert` + drift test | done | cfe77f54 |
| #step-2 | Faithful-restore guard: assert `ready()` awaited before deck construction | done | cb9cb80c |
| #step-3 | Make `dev-card.tsx` a boundary | done | 5c6c7faf |
| #step-4 | Make `dev-card-transcript.tsx` a boundary | done | 4fd4101a |
| #step-5 | Integration checkpoint: spine boundaries + guards | done | verify only |

#### Step 1: Sweep oracle — importable analyzer + `--assert` + drift test {#step-1}

**Commit:** `tugdeck(hmr): make fast-refresh-sweep importable with --assert mode + drift test`

**References:** [P05] (#p05-sweep-oracle), (#boundary-rule, #success-criteria)

**Artifacts:**
- `scripts/fast-refresh-sweep.ts` refactored: export `analyze(): { reloaders, census, focusGraph }`; keep the human report under a `main()`; add `--assert <file…>` that exits non-zero if any named file escapes.
- New `src/lib/__tests__/fast-refresh-boundary.test.ts` (pure-logic `bun test`) asserting a frozen set of files report `escapes=false`.

**Tasks:**
- [ ] Extract the graph build + `escapes()` into an exported `analyze()`; preserve current CLI output via `main()`.
- [ ] Add `--assert` mode (accepts file paths; exit 1 + print offenders if any escape).
- [ ] Seed the drift test's frozen list empty (extended per later step); assert the oracle wiring itself.

**Tests:**
- [ ] `bun test src/lib/__tests__/fast-refresh-boundary.test.ts` runs (pre-fix: asserts only oracle wiring, not yet the spine).

**Checkpoint:**
- [ ] `bun run scripts/fast-refresh-sweep.ts --assert src/main.tsx` exits non-zero (entry is an escaper — proves `--assert` detects one).
- [ ] `bunx tsc --noEmit` clean.

---

#### Step 2: Faithful-restore guard — assert `ready()` awaited before deck construction {#step-2}

**Commit:** `tugdeck(hmr): guard that boot awaits tugbankClient.ready() before constructing the deck`

**References:** [P07] (#p07-faithful-restore), Risk R02 (#r02-destructive-reload), (#context)

**Artifacts:**
- New `src/__tests__/boot-faithful-restore.test.ts` (pure-logic `bun test`): reads `src/main.tsx` source and asserts `await tugbankClient.ready()` appears and is **not** commented out, and that it precedes `new DeckManager(`. Match a stable token, tolerant of whitespace/formatting.

**Tasks:**
- [ ] Confirm `main.tsx` currently awaits `tugbankClient.ready()` before `new DeckManager` (already restored — verify).
- [ ] Write the guard test against the source text; fail clearly if the await is removed, commented, or reordered after construction.

**Tests:**
- [ ] `bun test src/__tests__/boot-faithful-restore.test.ts` green on the current (restored) boot.

**Checkpoint:**
- [ ] `bun test src/__tests__/boot-faithful-restore.test.ts` passes; temporarily commenting the await locally makes it fail (sanity-check the guard, then revert).
- [ ] `bunx tsc --noEmit` clean.

---

#### Step 3: Make `dev-card.tsx` a boundary {#step-3}

**Depends on:** #step-1

**Commit:** `tugdeck(hmr): split registerDevCard + useDevCardServices out of dev-card to make it a refresh boundary`

**References:** [P01] (#p01-file-is-boundary), [P03] (#p03-registration-shim), [P04] (#p04-use-dev-card-services), [Q02] (#q02-register-internals)

**Artifacts:**
- New `src/components/tugways/cards/dev-card-registration.tsx` exporting `registerDevCard`.
- New `src/components/tugways/cards/use-dev-card-services.ts` exporting `useDevCardServices`.
- `dev-card.tsx` left exporting only `DevCardContent`, `DevCardBody` (+ erased types).
- Updated importers: `main.tsx` (registerDevCard from shim), `dev-card-transcript.tsx` (useDevCardServices from new hook module).

**Tasks:**
- [ ] Confirm [Q02]: read `registerDevCard`; verify it needs only public exports.
- [ ] Move `registerDevCard` → `dev-card-registration.tsx`; import `DevCardContent` + `registerCard` + `FeedId`.
- [ ] Move `useDevCardServices` → `use-dev-card-services.ts`; import `cardServicesStore` and `type DevCardServices`.
- [ ] Update `main.tsx` and `dev-card-transcript.tsx` import specifiers.

**Tests:**
- [ ] Extend the drift frozen list with `dev-card.tsx`.

**Checkpoint:**
- [ ] `bun run scripts/fast-refresh-sweep.ts --assert src/components/tugways/cards/dev-card.tsx` exits 0.
- [ ] `bunx tsc --noEmit` clean.

---

#### Step 4: Make `dev-card-transcript.tsx` a boundary {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(hmr): split transcript helpers out of dev-card-transcript to make it a refresh boundary`

**References:** [P01] (#p01-file-is-boundary), [P02] (#p02-sibling-eviction), (#state-zone-mapping)

**Artifacts:**
- New sibling `src/components/tugways/cards/transcript-host-helpers.ts` exporting the value exports the sweep flags on `dev-card-transcript.tsx` (e.g. `useSessionModelName`, `formatTranscriptTimestamp`, `useTranscriptCellMenu` — confirm the exact set at step time).
- `dev-card-transcript.tsx` left exporting only `DevTranscriptHost` (+ erased types).
- Updated importer(s): any external consumer (e.g. `gallery-transcript-copy.tsx` consuming `useTranscriptCellMenu`) updates its import.

**Tasks:**
- [ ] Run the sweep to get the authoritative value-export list on `dev-card-transcript.tsx`.
- [ ] Move those hooks/fns to the sibling; keep erased types in place.
- [ ] Update each external consumer's import specifier.
- [ ] Verify no remaining value export on `dev-card-transcript.tsx`.

**Tests:**
- [ ] Add `dev-card-transcript.tsx` to the drift frozen list.

**Checkpoint:**
- [ ] `bun run scripts/fast-refresh-sweep.ts --assert src/components/tugways/cards/dev-card-transcript.tsx` exits 0.
- [ ] `bunx tsc --noEmit` clean.

---

#### Step 5: Integration checkpoint — spine boundaries + guards {#step-5}

**Depends on:** #step-2, #step-3, #step-4

**Commit:** `N/A (verification only)`

**References:** [P01] (#p01-file-is-boundary), [P07] (#p07-faithful-restore), (#success-criteria)

**Tasks:**
- [ ] Confirm both spine files report `escapes=false` via the sweep.

**Tests:**
- [ ] `bun test src/lib/__tests__/fast-refresh-boundary.test.ts` green with both spine files frozen.
- [ ] `bun test src/__tests__/boot-faithful-restore.test.ts` green.

**Checkpoint:**
- [ ] Dev smoke: editing `dev-card.tsx` and editing `dev-card-transcript.tsx` each refresh in place — no full page reload.
- [ ] `bun run scripts/fast-refresh-sweep.ts --assert src/components/tugways/cards/dev-card.tsx src/components/tugways/cards/dev-card-transcript.tsx` exits 0.
- [ ] `bunx tsc --noEmit` clean.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The two transcript spine files (`dev-card.tsx`, `dev-card-transcript.tsx`) are clean, self-accepting Fast Refresh boundaries, so editing them refreshes in place under HMR with no full page reload; any reload that still occurs restores the deck faithfully, enforced by a guard test, a sweep oracle, and a drift test.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `dev-card.tsx` and `dev-card-transcript.tsx` report `escapes=false` (sweep `--assert`).
- [ ] Dev smoke: editing either spine file refreshes in place, no full page reload.
- [ ] `bun test` drift test passes with both spine files frozen.
- [ ] `bun test` faithful-restore guard passes (boot awaits `ready()` before deck construction).
- [ ] `bunx tsc --noEmit` clean on the final tree.

**Acceptance tests:**
- [ ] `bun run scripts/fast-refresh-sweep.ts --assert src/components/tugways/cards/dev-card.tsx src/components/tugways/cards/dev-card-transcript.tsx`.
- [ ] `bun test src/lib/__tests__/fast-refresh-boundary.test.ts`.
- [ ] `bun test src/__tests__/boot-faithful-restore.test.ts`.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **Per-leaf in-place refresh.** Evict value exports from tool-blocks, body-kinds, transcript chrome/cards, and contexts so each becomes its own boundary — stops leaf edits from full-reloading. Larger effort; the leaves are a cyclic cluster (#leaf-cluster), so this must be measured per group, not assumed. Do a group only if its full-reload-on-edit becomes a real annoyance.
- [ ] **Gallery-graph detach experiment.** Deferring `registerGalleryCards()` behind a dynamic `import()` *might* seal the gallery cluster-exits in one move, but its leaf benefit is unproven by inspection and depends on Vite's runtime dynamic-import propagation. If pursued, run it as a measured experiment (sweep + dev smoke) with a fallback (clean the `[mixed]` gallery files), not as an assumed win. Cut from this phase as not-safe.
- [ ] **Live reload app-test for faithful restore.** A `just app-test` that reloads with a card open and asserts the card survives and no orphan "live" session appears — the runtime counterpart to the [P07] source guard.
- [ ] **Shared tugways primitives** (`tug-sheet`, `tug-popover`, `tug-list-row`, `theme-provider`, …) and **value-only lib modules** (`lib/code-session-store*`, `protocol.ts`, …) — deferred; broad consumer fan-out, low transcript-edit frequency.

| Checkpoint | Verification |
|------------|--------------|
| Spine cleaned | `fast-refresh-sweep.ts --assert` on both spine files exits 0 |
| Spine refreshes in place | dev smoke: editing each spine file does not full-reload |
| Faithful restore guarded | `bun test` boot guard green |
| No regressions | `bun test` drift test green; `tsc --noEmit` clean |

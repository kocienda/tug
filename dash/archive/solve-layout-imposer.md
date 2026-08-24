<!-- devise-skeleton v4 -->

## Solve Layout Imposition — the deterministic per-rail allocator {#solve-layout-imposer}

**Purpose:** Replace the space allocator's graded licence and shared-rail-width rule with a deterministic, closed-form, per-rail solver built on lexicographic invariants (floors → no-overlap → greed-ordered fill toward preferences → ceilings), give the Gazette a typographically derived width (56–64ch at a bumped font size), and pin the whole solution space with an exhaustively generated golden table.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | implemented (awaiting user vetting on the debug build) |
| Target branch | main |
| Last updated | 2026-08-12 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The layout imposer has two layers. Layer A — placement — is already solved: a slot is an anchor at a fixed travel fraction of the band, emitted as CSS `calc()`, and nothing in this plan touches it. Layer B — the space allocator (`allocateSidebarWidths` in `tugdeck/src/lib/layout-imposer.ts`) — has a closed-form least-squares core (`solveSidebarWidths`) wrapped in a heuristic acceptance policy: a three-grade licence judged against a 2px `seamPicture` tolerance, a soft floor at 20% under the chosen width (`LENS_FLEX_SHRINK_FRACTION`), an "improvement, not perfection" fallback judged against the standing widths, and an all-or-nothing `null` meaning "leave every rail where it is". On top of that, every standing rail is forced to one shared width — a rule that makes a wide Gazette drag the Lens wide, or get refused because the shared answer fails the picture test.

The immediate pressure is the Gazette (`dash/gazette-plan.md`): its posts are prose, its current 12px body type is too small, and its rail is too narrow for the legibility and interactivity the feature wants. The Gazette should be the *greediest* of the sidebars — the one fed first and drained last — with a width derived from typography (64ch measure by default, fungible down to 56ch) rather than a hand-tuned pixel count. The session discussion that produced this plan concluded that the set of possible layouts, given (canvas width, imposition kind, occupied slots and their widths, rail occupancy, rail policies), is small enough to *solve* rather than guess: for any fixed discrete configuration, the correct rail widths are a piecewise-linear function of canvas width with a handful of computable breakpoints. No search, no measurement, no grading.

#### Strategy {#strategy}

- Keep the closed-form geometry (`solveSidebarWidths` — the least-squares band fit) exactly as it is; it is the part of the current allocator that is already right.
- Replace the acceptance policy with a **lexicographic water-fill**: floors are inviolable, the tiling target (no-overlap / gap-rhythm) outranks preferences, preferences fill in greed order, ceilings cap everything. The solver becomes a total function — it always answers when a rail stands.
- Delete the shared-width rule: each rail gets its own answer, folded from its members. Stacking semantics (wider preference wins) are preserved unchanged.
- Register greed as data: a `greedRank` on the card registration, Gazette 1 (greediest) < Lens 2 < Jots 3, folded to a rail by taking its greediest member.
- Derive the Gazette's floor and preference from its type: bump the body font, then floor = 56ch + measured chrome, preferred = 64ch + measured chrome, with an app-test that measures the real rendered face and pins the derivation against drift.
- Pin the whole solution space: an exhaustive enumeration test asserting the invariants across every configuration axis, plus a regenerable golden table checked into the repo as the drift net.
- Land in compile-clean steps: registry data first (inert), then the solver + plumbing, then the Gazette typography, then the regression nets.

#### Success Criteria (Measurable) {#success-criteria}

- `allocateSidebarWidths` returns a non-null answer for every input with ≥1 standing rail and finite numbers (verified by the enumeration sweep in Step 5).
- Two rails with different policies can stand at different widths (unit test + at0303).
- With Gazette (rank 1) on one side and Lens (rank 2) on the other, shrinking the canvas drains the Lens to its floor before the Gazette gives a pixel under its preference, and growing the canvas feeds the Gazette to its ceiling first (unit test + golden table rows).
- The Gazette's registered `min.width` and `preferred.width` equal `round(56 × ch) + chrome` and `round(64 × ch) + chrome` for the real rendered body face, within ±4px (app-test measure pin in at0365).
- `LENS_FLEX_SHRINK_FRACTION`, `ALLOCATOR_RESIDUAL_TOLERANCE_PX`, the graded licence, and `RailPolicy.currentWidth` no longer exist in `layout-imposer.ts` (grep is the verification).
- Every invariant in List L02 holds over the full enumeration of List L01 (`bun test` on the solutions test).
- `cd tugdeck && bunx tsc --noEmit && bunx vite build` clean; selected app-tests green.

#### Scope {#scope}

1. `tugdeck/src/lib/layout-imposer.ts` — the allocator rewrite (types, solver, deleted constants).
2. `tugdeck/src/card-registry.ts` — `greedRank` registration field and accessor.
3. `tugdeck/src/deck-manager.ts` — rail folding and plumbing for per-rail answers and ranks.
4. `tugdeck/src/components/gazette/` — font bump, 64ch reading measure, derived width constants.
5. Regression nets: rewritten unit tests, new solutions enumeration + golden table, updated at0303, extended at0365.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Layer A (placement): `resolvePlacement`, `travelFraction`, `imposeRect`, `imposeStyle`, `resolveSpan` are untouched.
- The vertical split-rail math (`railSeamFractions` / `railSharesFromFractions`) and `imposeSidebarStyle` are untouched.
- **The moments are unchanged** ([P08]): the allocator still runs only on a Layouts click, `assignCardToSlot`, and a settled canvas resize. This plan changes *what the answer is*, never *when it is asked for*.
- Per-card ceilings: the ceiling stays the single shared `maxRailWidth` = `CONTENT_WIDTH_SLIM_PX` (675). See [Q03].
- Content card widths, the width presets (675/800/1230), and the preset appliers are untouched.
- The Lens's `lensStore.widthPx` plumbing and `sidebarWidthStore` are untouched — preference sourcing stays exactly as it is.
- Gazette-internal presentation work beyond the font bump and reading measure (post layout, interactivity — that is the *next* phase the session discussion deferred).

#### Dependencies / Prerequisites {#dependencies}

- The layouts-rework sidebar taxonomy and the current allocator are landed (they are — this plan edits them in place).
- The Gazette card and at0365 exist (they do).

#### Constraints {#constraints}

- Rust-side untouched; this is a pure tugdeck phase. Frontend verification is `bunx tsc --noEmit` + `bunx vite build` (the debug app loads the prod rollup bundle, so a vite build is mandatory before declaring done).
- bun, never npm. App-tests only via `just` recipes, selective (`just app-test-changed` / named files), never a sweep, output never piped.
- Tuglaws apply: [L02] external state via `useSyncExternalStore` only, [L06] appearance via CSS/DOM. This plan adds **no new runtime state** (see #state-zone-mapping).
- No `localStorage`; durable widths already live on tugbank via `sidebarWidthStore` — unchanged.
- Warnings are errors across the repo.

#### Assumptions {#assumptions}

- `document.fonts` + canvas measurement (`tugdeck/src/lib/font-metrics.ts`) is reliable in the app-test environment — it is already used by atom chips (pinned by at0205).
- Spacing tokens are theme-invariant: `--tug-space-md: 8px`, `--tug-space-sm: 6px` in every `tugdeck/styles/themes/*.css`.
- IBM Plex Sans (`--tug-font-family-sans`) is the Gazette body face on every platform the app ships on, so one authored ch constant is valid everywhere the pin runs.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings, `[P##]` plan-local decisions, `[Q##]` open questions, `Spec S##`, `Table T##`, `List L##`, `Risk R##` labels, and `**Depends on:**` lines citing `#step-N` anchors. Global design decisions are cited as `[D##]`/`[L##]` against `tuglaws/design-decisions.md` and `tuglaws/tuglaws.md`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Exact bumped font sizes (DECIDED) {#q01-font-sizes}

**Question:** "A couple points larger" — what exactly do body and meta become?

**Why it matters:** The ch derivation bakes the body size into the registered widths.

**Resolution:** DECIDED (see [P05]): body 12px → 14px, meta 10px → 11px, empty-state 12px → 14px. Both are named `/* TUNE HERE */` constants in `gazette-card.css`; retuning later is a one-line CSS change plus re-running the derivation (Step 4's pin test fails loudly if the constants and the CSS drift apart, which is the point).

#### [Q02] What does the solver answer when no chain stands? (DECIDED) {#q02-no-chain-answer}

**Question:** With zero or one occupied slot there is no seam and `solveSidebarWidths` has nothing to fit. Today the allocator returns `null` (leave rails standing). Keep that, or answer anyway?

**Why it matters:** "Total function" was the promise; a `null` that means "shrug" is the ambiguity this plan exists to delete.

**Resolution:** DECIDED (see [P06]): the solver answers `clamp(preferred, floor, ceiling)` per rail. This is safe because preference is sourced from the durable stores (`lensStore.widthPx` / `sidebarWidthStore`), which the user's own drag writes — so "snap to preference" is always "snap to the width the user last chose", never a regression of it. `null` survives with exactly two honest meanings: no rail stands, or an input is non-finite.

#### [Q03] Per-card rail ceilings (DEFERRED) {#q03-per-card-ceilings}

**Question:** Should each sidebar card carry its own max width the way it now carries its own floor?

**Why it matters:** Only if some future rail card wants to grow past slim (675) or be capped under it.

**Resolution:** DEFERRED — no current card wants it, and `CardSizePolicy.max` already exists as the natural home if one ever does. The shared `maxRailWidth` ceiling stays. Revisit when a card asks.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Rails move more often than the graded licence allowed | med | med | Moments unchanged; 1px deadband in `_commitImposition`; FLIP settle already animates moves (at0294) | Visible churn on ordinary resizes |
| Font-metric variance breaks the ch pin | low | low | Pin measures the *real rendered face* in-test with ±4px tolerance | at0365 flake on the measure test |
| Golden table brittleness | med | med | Regeneration is one env var; the invariant sweep (not the golden) is the primary net | Golden churn on unrelated commits |
| Preference ratchet returns | high | low | Preference still read only from durable stores; `currentWidth` deleted from `RailPolicy` so the solver *cannot* see its own past answers | Any future edit re-adding live width to the input |

**Risk R01: Retune churn under the total-function solver** {#r01-retune-churn}

- **Risk:** The graded licence refused many moves ("improvement, not perfection"); the new solver always answers, so settled resizes may re-tune rails that previously held still.
- **Mitigation:** The answer is a pure function of (canvas, chain, policies) — repeated retunes at the same inputs are idempotent, so there is no oscillation, only honest tracking of the window; the `≥1px` write threshold in `_commitImposition` and `retuneSidebarAllocation` already suppresses no-op commits.
- **Residual risk:** A user who hand-drags a rail then resizes the window will see the rail re-solve around their dragged width (their drag *is* the preference, so the re-solve anchors on it — this is the designed behavior, not a bug, but it is a behavior change from "rails mostly hold still").

**Risk R02: at0303 rewrite loses a guarded invariant** {#r02-at0303-invariants}

- **Risk:** at0303's six invariants include behaviors this plan deletes (two rails → one width) next to behaviors it must preserve (preference untouched across close/reopen, retune moments); a careless rewrite could drop the preserved ones.
- **Mitigation:** Step 6 enumerates the invariant disposition explicitly (Table T02) — each old invariant is either kept, rewritten, or deleted with the deleting decision cited.
- **Residual risk:** None beyond ordinary test-authoring error.

---

### Design Decisions {#design-decisions}

#### [P01] Lexicographic invariants replace the graded licence (DECIDED) {#p01-lexicographic-invariants}

**Decision:** The allocator's policy is a strict priority order — (1) every rail ≥ its floor; (2) the chain tiles (seams on the gap, no overlap) whenever the canvas permits it with rails inside their bounds; (3) remaining width fills rails toward their preferences in greed order; (4) no rail exceeds the ceiling — solved in closed form, judged by nothing.

**Rationale:**
- The graded licence existed because the objective was never stated as invariants; every grade is a proxy question ("does the picture look better?") that the priority order answers directly.
- All acceptance machinery — `ALLOCATOR_RESIDUAL_TOLERANCE_PX`, `LENS_FLEX_SHRINK_FRACTION` (the soft floor), the standing-picture comparison, `seamPicture`-as-judge — becomes deletable.
- For any fixed discrete configuration the answer is piecewise-linear in canvas width with computable breakpoints, which is what makes the golden table possible (Spec S01).

**Implications:**
- The solver is a **total function**: non-null whenever ≥1 rail stands and inputs are finite ([P06]).
- `seamPicture` survives only as a test-side measurement helper (exported for tests), never as an input to the decision.
- The soft floor is gone: a rail's shrink range is `[minWidth, preferredWidth]`, period. The hard floor is the only floor.

#### [P02] Per-rail answers; the shared-width rule is deleted (DECIDED) {#p02-per-rail-answers}

**Decision:** Each standing rail gets its own solved width. The rule that every rail stands at one shared number (`total / sides.length`, the "sidebars are a uniform class" doctrine in `allocateSidebarWidths`) is deleted.

**Rationale:**
- The rule is why a wide Gazette drags the Lens wide or gets refused; per-card policies are meaningless if the answer is forced uniform across sides.
- Within a side nothing changes: same-side cards share one rail and one width by geometry (one `--tug-sidebar-width-{side}` property per side; `deck-canvas.tsx` already publishes per-side values, so the CSS layer needs zero changes).

**Implications:**
- `RailWidths` (`{left?, right?}`) already carries per-side numbers — the type is unchanged; only the constraint that the two values match is removed.
- `_commitImposition` already writes widths per side from the `RailWidths` record — it needs no change for asymmetry.
- The unit-test block "every standing rail takes one shared width" is rewritten to assert the greed ordering instead (Step 3).

#### [P03] Greed is a registered rank: Gazette 1 < Lens 2 < Jots 3 (DECIDED) {#p03-greed-rank}

**Decision:** `CardRegistration` gains an optional `greedRank?: number` — lower is greedier: fed first in surplus, drained last in deficit. Gazette registers 1, Lens 2, Jots 3; unregistered cards default to `DEFAULT_GREED_RANK = 9`. A rail's rank folds to the **minimum** (greediest member) of its members.

**Rationale:**
- The Gazette is a prose reading surface — the sidebar with the most to lose from narrowness; the Lens is lists; Jots is incipits. The order is a product decision from this plan's originating session.
- Registry-driven, never a `componentId` string comparison in the solver — the solver takes ranks as numbers in its input and knows nothing about cards.
- Min-fold composes with [P04]: a rail carrying the Gazette is greedy wherever the Gazette stands.

**Implications:**
- `RailPolicy` gains `greedRank: number`; `_sidebarRails` folds it with `Math.min`.
- Ties (two rails at equal rank) split evenly — deterministic and order-independent (Spec S01 step 4).

#### [P04] Stacking folds are preserved: wider preference wins (DECIDED) {#p04-stacking-fold}

**Decision:** Same-side cards fold exactly as today — rail preferred = max of member preferences, rail floor = max of member floors — plus the new rank fold (min). No change to `_sidebarRails`'s existing max-folds.

**Rationale:**
- "When sidebars are stacked, the one with the wider preference wins" is already what the max-fold does; this decision pins it as intended behavior rather than incidental.
- Max-fold on floors composes with the Gazette's derived floor: a rail carrying Gazette + Jots takes the Gazette's 56ch floor, so the greedy reader is never crowded by a modest stackmate.

**Implications:**
- The fold rules get their own unit assertions in Step 3 so they can never regress silently.

#### [P05] The Gazette's widths are derived from its type: 56ch floor, 64ch preference, at the bumped size (DECIDED) {#p05-gazette-ch-derivation}

**Decision:** Bump the Gazette body to 14px (meta 11px, empty-state 14px), then compute `MIN_GAZETTE_WIDTH_PX = round(56 × GAZETTE_BODY_CH_PX) + GAZETTE_ROW_CHROME_PX` and `DEFAULT_GAZETTE_WIDTH_PX = round(64 × GAZETTE_BODY_CH_PX) + GAZETTE_ROW_CHROME_PX` in `gazette-card-registration.tsx`, where `GAZETTE_BODY_CH_PX` is the measured advance of "0" in the real rendered body face at 14px and `GAZETTE_ROW_CHROME_PX` is the measured pane-edge-to-body-column chrome (both sides). Both measured constants are authored numbers pinned by an app-test that re-measures the real render ([P07] explains why authored-and-pinned rather than measured-at-runtime).

**Rationale:**
- "64ch by default, fungible down to 56ch" maps exactly onto the two policy inputs the solver reads — the typography *defines* the policy; no new mechanism.
- A future font-size or chrome tune fails the pin test instead of leaving a stale width constant behind.
- The body column also takes `max-inline-size: 64ch` in CSS, so a user-widened rail (up to the 675 ceiling) keeps a comfortable measure instead of stretching lines.

**Implications:**
- The known chrome components are documented in Spec S03; the authored constant is set from a real measurement during Step 4 and pinned thereafter.
- Expected magnitudes (sanity, not spec): 1ch of IBM Plex Sans at 14px ≈ 8px, so preferred ≈ ~555–575px and min ≈ ~490–505px — comfortably under the 675 ceiling.
- **The new preference reaches only users who never sized the Gazette.** `_sidebarPreferredWidth` reads `sidebarWidthStore.widthFor("gazette")` first and falls back to the registered `preferred.width`; a user with a stored 480 keeps 480 as their preference, which Spec S01 step 2 then clamps up to the new floor (~496) — not to the 560 the measure buys. That is correct ([L23]: their drag is their choice, and the stored value is never overwritten), but it means **a tester with a stored width will see the feature "not work"** until that tugbank key (`dev.tugtool.gazette` / `widthPx`) is cleared. Say this in the Step 4 commit message, and clear the key before judging the result by eye.

#### [P06] The solver is total; `null` means only "no rail" or "bad number" (DECIDED) {#p06-total-function}

**Decision:** `allocateSidebarWidths` returns a `RailWidths` answer whenever ≥1 rail stands and all inputs are finite. With no chain (fewer than two occupied slots) each rail answers `clamp(preferred, floor, ceiling)`. `RailPolicy.currentWidth` is deleted — the solver never sees the standing widths.

**Rationale:**
- The all-or-nothing `null` ("leave rails standing") existed to serve the improvement-not-perfection grade; with the grade gone it has no question to answer.
- Deleting `currentWidth` makes the no-ratchet property structural: the solver *cannot* read its own past answers back, rather than being documented not to.
- Resolves [Q02]; preference safety argued there.

**Implications:**
- `retuneSidebarAllocation` and `_commitImposition` keep their `≥1px` change checks — "answer equals standing" is detected by the caller, not encoded as `null`.
- The chain guards in `chainOf` relax: a chain of 0 or 1 is no longer a `null` case for the *allocator* (it is still one for `solveSidebarWidths`, which genuinely has no seam to fit).

#### [P07] Measured constants are authored and pinned, never computed at boot (DECIDED) {#p07-authored-pinned}

**Decision:** `GAZETTE_BODY_CH_PX` and `GAZETTE_ROW_CHROME_PX` are authored numeric constants in the registration module, verified by an app-test that measures the real render — not measured at registration time.

**Rationale:**
- Registration runs at boot, before layout has requested the face — `document.fonts.ready` resolves on an empty queue then, and a canvas measure would report the fallback's metrics with complete confidence (the exact trap `tugdeck/src/lib/font-metrics.ts`'s module doc documents).
- Deterministic registration keeps the solver's inputs stable from the first frame; an async width upgrade arriving mid-session would be a re-tune trigger this plan has no license to add ([P08]).
- The pin test closes the drift loop: the authored number is checked against the truth on every selected run.

**Implications:**
- Step 4 includes a one-time measurement procedure (in-test `note()` output) to set the authored values honestly.

#### [P08] The moments are unchanged (DECIDED) {#p08-moments-unchanged}

**Decision:** The allocator still runs exactly at the three moments documented on `retuneSidebarAllocation` in `deck-manager.ts` — a Layouts-section click, `assignCardToSlot`, a settled canvas resize — and nowhere else.

**Rationale:**
- "A rail's width belongs to the user, spent only when the user asked the deck to arrange itself" is doctrine this plan has no quarrel with; the rework is about what the answer is, not when it is computed.

**Implications:**
- No changes to `deck-canvas.tsx`'s settled-resize observer or `RESIZE_RETUNE_QUIET_MS`.

#### [P09] The regression net is an invariant sweep plus a regenerable golden table (DECIDED) {#p09-golden-table}

**Decision:** A new unit test enumerates the configuration space (List L01), asserts the invariants (List L02) on every point, and additionally compares a representative slice against a checked-in golden JSON (`tugdeck/src/lib/__tests__/golden/imposer-solutions.json`), regenerated by running the same test with `IMPOSER_GOLDEN_UPDATE=1`.

**Rationale:**
- The invariant sweep is the strong net (it checks *properties*, so it survives intentional retunes); the golden is the drift net (it catches *any* behavioral change, intended or not, and makes it reviewable as a diff).
- The solver is pure arithmetic — tens of thousands of calls run in well under a second in bun.

**Implications:**
- Golden regeneration is a deliberate act that shows up in review as a JSON diff; the regeneration command is documented in the test header.

---

### Deep Dives {#deep-dives}

#### The current allocator, and exactly what is deleted {#current-allocator-inventory}

All in `tugdeck/src/lib/layout-imposer.ts` unless noted. **Kept:** `solveSidebarWidths` (the closed-form least-squares band fit — unchanged), `chainOf` (fold duplicates to widest, sort by slot; its `< 2` bail moves from the allocator's concern to `solveSidebarWidths`'s per [P06]), `resolveSpan` (the gap-count authority), `RailWidths`, `railSidesOf`/`railsOf`, `RESIZE_RETUNE_QUIET_MS`, `AllocatorInput.maxRailWidth` and the caller's `CONTENT_WIDTH_SLIM_PX` ceiling. **Rewritten:** `allocateSidebarWidths` (becomes Spec S01), `RailPolicy` (gains `greedRank`, loses `currentWidth` and the soft-floor semantics on `preferredWidth`), its doc comment (the "graded licence" essay is replaced by the invariant order). **Deleted:** `LENS_FLEX_SHRINK_FRACTION`, `ALLOCATOR_RESIDUAL_TOLERANCE_PX`, the three grades, the standing-picture comparison, the one-shared-width distribution. **Demoted:** `seamPicture` — exported as a test-measurement helper (it measures via `imposeRect`'s real clamped rule, which is exactly what the tiling invariant should be checked against), no longer consulted by the solver.

In `tugdeck/src/deck-manager.ts`: `_sidebarRails` keeps its max-folds and adds the min-fold for `greedRank` (resolved per member via the new registry accessor); `_sidebarPreferredWidth` is unchanged (durable stores remain the only preference source); `_allocatedRailWidths` and `_commitImposition` are unchanged in shape (both already speak per-side `RailWidths`); `retuneSidebarAllocation` is unchanged.

#### Why the answer is piecewise-linear, and what the breakpoints are {#piecewise-linear}

**The separation property — distribution is free.** `resolveSpan` insets the canvas by `railWidth + gap` per occupied side, so `band = canvasWidth − Σ rails − (R + 2)·gap`. The band — and therefore every seam in the chain — depends only on the rails' **total**, never on how that total is split between left and right. Distribution shifts `span.x` and nothing else. This is the keystone of the whole decomposition: **the total determines tiling; greed determines only which rail is wide.** Invariant 4 in List L02 is therefore true by construction rather than merely checked, and greed order can never trade away picture quality.

For a fixed discrete configuration (kind, occupied slots and widths, rail policies), the least-squares band `B*` is a constant offset from nothing — the fit depends only on the chain — so the rails' solved total `T* = canvasWidth − (R + 2)·gap − B*` is **linear in canvas width with slope 1**. The water-fill (Spec S01) maps that scalar through a monotone piecewise-linear distribution whose breakpoints are exactly the canvas widths where `T*` crosses: `Σ floors`, each partial-fill boundary in drain order (`Σ preferred −` each rail's give, taken in reverse-greed order), `Σ preferred`, each partial-fill boundary in fill order, and `Σ ceilings`. The golden table samples each breakpoint ±1px plus a coarse sweep, which is what makes "exhaustive" honest rather than aspirational.

#### Worked example {#worked-example}

Three-up, slots 0 and 2 occupied by two comfy (800px) cards; Gazette alone on the right (floor ≈ 496, preferred ≈ 560, rank 1 — illustrative ch-derived values); Lens alone on the left (floor 320, preferred 420, rank 2); gap 5, ceiling 675. `R = 2`. The chain's fit is exact with band `B* = 1605` (two 800s and one 5px seam), so `solveSidebarWidths` returns `T* = canvas − 5·(2 + 2) − 1605 = canvas − 1625`. That return value **is** the target before clamping — Spec S01 step 3's warning in one line. `Σ floor = 816`, `Σ pref = 980`, `Σ ceil = 1350`.

- Canvas 2605: `T* = 980` = `Σ pref` exactly — Gazette 560, Lens 420, every seam on the gap.
- Canvas 2505: `T* = 880`, deficit 100. Lens (less greedy) drains first: Lens 320 (floor, gave 100), Gazette holds 560.
- Canvas 2430: `T* = 805`, which is below `Σ floor = 816`, so `target` clamps **up** to 816 before any rail is touched. Deficit against `Σ pref` is then 164: Lens drains first to its floor (420 → 320, gives 100), Gazette gives the remaining 64 (560 → 496, exactly its floor). Both rails stand on their floors, and the 11px the clamp refused to give is carried by the chain — the band comes out 1594 against the 1605 that would tile, so the single interior seam goes from +5 to **−6, a 6px overlap**. This is the overflow regime, reported honestly rather than repaired.
- Canvas 2805: `T* = 1180`, surplus 200. Gazette (greedier) fills first: Gazette 675 (ceiling, took 115), Lens takes the remaining 85: Lens 505. Note both rails end **above** their preferences — surplus is capped by `target` and `ceil`, never by preference (Spec S01 step 4).
- One-up with a single occupied slot ([Q02]): `solveSidebarWidths` returns `null`, target = `Σ pref` — Gazette 560, Lens 420, the card centers in what remains.

---

### Specification {#specification}

**Spec S01: The per-rail solver** {#s01-solver}

Signature: `allocateSidebarWidths(input: AllocatorInput): RailWidths | null` — name, module, and caller unchanged.

**`R ≤ 2` always.** `railSidesOf` returns at most `left` and `right`, so the "greed order" is a sort of at most two elements and the tie case is exactly "two rails at equal rank". Nothing below needs to scale past that.

1. **Guards.** No standing rail → `null`. Any non-finite `canvasWidth`, occupied entry, or rail policy number — **including `greedRank`**, which is sorted on and would make the order nondeterministic if it were `NaN` — or a non-positive `maxRailWidth` → `null`. These are the only `null`s ([P06]). `chainOf` already validates `preferredWidth`/`minWidth` finiteness per rail; extend that check to `greedRank` rather than adding a second validation site.
2. **Per-rail bounds.** For each standing rail `i`: `floor_i = minWidth`, `ceil_i = max(round(maxRailWidth), floor_i)` (a floor above the ceiling wins, exactly as the current Grade-1 comment argues — a rail that cannot paint under its floor beats a policy about maximum width), `pref_i = clamp(round(preferredWidth), floor_i, ceil_i)`.
3. **Target total.** `solveSidebarWidths(input)` **already returns the rails' total** — read its final line: it computes the band `B*` internally and returns `canvasWidth − gap·(railCount + 2) − B*`. Do **not** subtract the band again; the target is that return value verbatim. Call it `T*`. When `solveSidebarWidths` returns `null` — no seam (fewer than two occupied slots), no rail, or a degenerate fit (`Σa² ≤ 0`) — the target is `Σ pref_i` ([Q02]). Then clamp: `target = clamp(T*, Σ floor_i, Σ ceil_i)`. `chainOf` semantics are unchanged (fold duplicate slots to widest, sort by slot).
4. **Greed-ordered water-fill.** Start every rail at `pref_i`.
   - `Σ pref = target`: done.
   - **Deficit** (`Σ pref > target`): visit rails in *reverse* greed order (largest `greedRank` first — least greedy drains first); shrink each toward `floor_i` until the total meets the target. The greediest rail gives width only after every other rail stands at its floor.
   - **Surplus** (`Σ pref < target`): visit rails in greed order (smallest `greedRank` first); grow each toward `ceil_i` until the total meets the target. The greediest rail reaches its ceiling before any less greedy rail grows a pixel past its preference. **Preference is not a cap in surplus** — growth is bounded by the clamped `target` (itself the least-squares optimum) and then by `ceil_i`. Growing past preference happens only when the geometry actually wants the width, which is what the old Grade 1 already did; the old preference cap lived only in the deleted Grade 3.
   - **Ties:** rails at equal rank split their tier's delta evenly, then any remainder a bounded member could not absorb is redistributed to the members still short of their bound (a one-pass mini water-fill within the tier — with `R ≤ 2` this is at most one redistribution). Deterministic and independent of input order.
5. **Rounding.** Round each width to an integer; the ≤R px rounding residual is absorbed by the band's travel (never redistributed — a pixel of seam slack is invisible; a redistribution loop is complexity with no picture to buy).

Properties (these are List L02's invariants, stated once): total on the guarded domain; every width in `[floor_i, ceil_i]`; monotone non-decreasing in canvas width per rail; greed-sound (a less greedy rail above its preference implies every greedier rail at its ceiling; a greedier rail below its preference implies every less greedy rail at its floor); exact tiling whenever `T* ∈ [Σ floor, Σ ceil]` and the chain is tileable; pure and deterministic.

**Spec S02: Type changes** {#s02-types}

```ts
// layout-imposer.ts
export interface RailPolicy {
  preferredWidth: number;  // the user's durable choice (or the registered preferred)
  minWidth: number;        // the hard floor — the only floor
  greedRank: number;       // lower = greedier: fed first, drained last
}
// AllocatorInput: unchanged shape (canvasWidth, kind, occupied, rails, maxRailWidth)
// RailWidths: unchanged ({ left?: number; right?: number }) — values may now differ

// card-registry.ts
export const DEFAULT_GREED_RANK = 9;
export interface CardRegistration { /* … */ greedRank?: number; }
export function getGreedRank(componentId: string): number;  // registration's rank ?? DEFAULT_GREED_RANK
```

`_sidebarRails` fold (deck-manager.ts): preferred = `Math.max`, min = `Math.max` (both unchanged), greedRank = `Math.min` over members via `getGreedRank(componentId)`; the `currentWidth` fold line is deleted.

**Table T01: Registered greed ranks** {#t01-greed-ranks}

| Card | `greedRank` | Registration file |
|------|-------------|-------------------|
| Gazette | 1 | `tugdeck/src/components/gazette/gazette-card-registration.tsx` |
| Lens | 2 | `tugdeck/src/components/lens/lens-register-card.tsx` |
| Jots | 3 | `tugdeck/src/components/jots/jots-card-registration.tsx` |
| (any other) | 9 (`DEFAULT_GREED_RANK`) | — |

**Spec S03: Gazette typography and the width derivation** {#s03-gazette-derivation}

CSS (`tugdeck/src/components/gazette/gazette-card.css`): `.gazette-post-body` `font-size: 12px → 14px` and gains `max-inline-size: 64ch`; `.gazette-post-meta` `10px → 11px` (its `line-height: 16px` and the glyph gutter's `block-size: 16px` stay — 11px fits the band); `.gazette-empty` `12px → 14px`. Mark the body size with the existing `/* TUNE HERE */` convention.

Registration (`gazette-card-registration.tsx`):

```ts
export const GAZETTE_BODY_FONT_PX = 14;        // must equal .gazette-post-body font-size — pinned by test
export const GAZETTE_BODY_CH_PX = /* measured */;   // advance of "0", IBM Plex Sans @ 14px (≈ 8)
export const GAZETTE_MIN_MEASURE_CH = 56;
export const GAZETTE_MEASURE_CH = 64;
export const GAZETTE_ROW_CHROME_PX = /* measured */; // pane edge → body column, both sides summed
export const MIN_GAZETTE_WIDTH_PX =
  Math.round(GAZETTE_MIN_MEASURE_CH * GAZETTE_BODY_CH_PX) + GAZETTE_ROW_CHROME_PX;
export const DEFAULT_GAZETTE_WIDTH_PX =
  Math.round(GAZETTE_MEASURE_CH * GAZETTE_BODY_CH_PX) + GAZETTE_ROW_CHROME_PX;
```

Known chrome components (documented beside the constant; the authored value is the *measured* total, these are its anatomy): `.gazette-transcript` inline padding 2 × `--tug-space-md` (8px) = 16, glyph gutter `--tugx-gazette-gutter-inline-size` = 18, post grid gap `--tug-space-sm` = 6, plus whatever pane/CardHost chrome stands between the pane's `size.width` and the transcript's content box (borders, host padding — measured, not guessed; macOS overlay scrollbars contribute 0).

The pin (extends `tests/app-test/at0365-gazette-card.test.ts`): open the Gazette; `whenFaceLoaded` + `textMeasurer` (from `tugdeck/src/lib/font-metrics.ts`) against a real `.gazette-post-body` element; assert computed `font-size` = `GAZETTE_BODY_FONT_PX`; assert measured `"0"` advance = `GAZETTE_BODY_CH_PX` ± 0.25; measure chrome = pane width − body content-box width and assert = `GAZETTE_ROW_CHROME_PX` ± 2; assert the two registered widths equal the formula ± 4. `note()` every measured number so a failing run hands the correct constants to whoever retunes.

**List L01: Enumeration axes for the solutions test** {#l01-enumeration-axes}

- Kinds: all six (`one-up` … `six-up`).
- Occupancy: every non-empty subset of the kind's slots (≤ 63 per kind), each at uniform slim/comfy/wide, plus one mixed pattern (alternating slim/wide) per subset size.
- Rail configurations: right-only, left-only, both-sides; policies drawn from a fixture set: Gazette-alone (derived floor/preferred, rank 1), Lens-alone (320/420, rank 2), Jots-alone (320/420, rank 3), Gazette+Jots stacked (max-fold check), Gazette-right + Lens-left, Jots-left + Gazette-right, equal-rank pair (tie split), plus a dragged-preference variant (preferred 600).
- Canvas: every breakpoint of the configuration (#piecewise-linear) ± 1px, plus a sweep from 700 to 3800 in steps of 100.

**List L02: Invariants asserted on every enumerated point** {#l02-invariants}

1. Non-null whenever a rail stands (totality, [P06]).
2. `floor_i ≤ width_i ≤ ceil_i` for every rail.
3. Greed soundness, both directions (Spec S01 properties).
4. Tiling: when `T* ∈ [Σ floor, Σ ceil]` and the chain admits an exact fit, `seamPicture` at the answer reports `worstError ≤ 2 + R` (rounding allowance) and `worstOverlap` ≤ the same.
5. Canvas monotonicity: for fixed config, each rail's width is non-decreasing in canvas width.
6. Stacking fold: a stacked rail's answer never falls below any member's floor.
7. Tie fairness: equal-rank rails with equal bounds receive equal widths.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `greedRank` | none — static registration data, not state | `registerCard` field + accessor | [D04] |
| Solved rail widths | structure (already exists) | deck store `pane.size.width` via `_commitImposition`, read through `useSyncExternalStore` | [L02] |
| Gazette type sizes / 64ch measure | appearance | CSS only (`gazette-card.css`) | [L06] |
| Derived width constants | none — module constants, pinned by test | authored + app-test pin | [P07] |

No new runtime state of any kind is introduced.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/__tests__/layout-imposer-solutions.test.ts` | Enumeration sweep + golden comparison ([P09]) |
| `tugdeck/src/lib/__tests__/golden/imposer-solutions.json` | The checked-in golden table |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `greedRank` | field | `card-registry.ts` `CardRegistration` | optional; lower = greedier |
| `DEFAULT_GREED_RANK` | const (9) | `card-registry.ts` | |
| `getGreedRank` | fn | `card-registry.ts` | `registration?.greedRank ?? DEFAULT_GREED_RANK` |
| `RailPolicy` | interface | `lib/layout-imposer.ts` | + `greedRank`; − `currentWidth`; floor semantics per Spec S02 |
| `allocateSidebarWidths` | fn (rewrite) | `lib/layout-imposer.ts` | Spec S01 |
| `seamPicture` | fn (visibility) | `lib/layout-imposer.ts` | becomes exported, test-only consumer |
| `LENS_FLEX_SHRINK_FRACTION` | **delete** | `lib/layout-imposer.ts` | |
| `ALLOCATOR_RESIDUAL_TOLERANCE_PX` | **delete** | `lib/layout-imposer.ts` | |
| `_sidebarRails` | method (edit) | `deck-manager.ts` | + min-fold of ranks; − currentWidth fold |
| `GAZETTE_BODY_FONT_PX`, `GAZETTE_BODY_CH_PX`, `GAZETTE_MIN_MEASURE_CH`, `GAZETTE_MEASURE_CH`, `GAZETTE_ROW_CHROME_PX` | consts | `components/gazette/gazette-card-registration.tsx` | Spec S03 |
| `MIN_GAZETTE_WIDTH_PX`, `DEFAULT_GAZETTE_WIDTH_PX` | consts (now derived) | same | formula, not literals |

---

### Documentation Plan {#documentation-plan}

- [ ] Rewrite `allocateSidebarWidths`'s doc comment: the invariant order replaces the graded-licence essay; the per-rail rule replaces the "uniform class" doctrine; note the totality contract and the two remaining `null` meanings.
- [ ] Update `_sidebarRails` / `_sidebarPreferredWidth` / `retuneSidebarAllocation` doc comments where they describe deleted behavior (soft floor, standing-picture judging, shared width).
- [ ] Candidate global design-decision entry (the per-rail lexicographic allocator and the greed order) for `tuglaws/design-decisions.md` — drafted as a follow-on for the user to land; plans do not edit tuglaws unilaterally.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** (bun) | Solver arithmetic, folds, regimes, edge guards | Steps 2–3, rewritten `layout-imposer.test.ts` blocks |
| **Golden / Contract** | The full solution space as a reviewable artifact | Step 5, `layout-imposer-solutions.test.ts` |
| **App-test** | The real deck: commit paths, moments, measured typography | Steps 4 and 6 (at0365, at0303) |

#### What stays out of tests {#test-non-goals}

- jsdom/mock render tests — banned; the imposer's unit surface is pure arithmetic and needs no DOM, and everything DOM-real is covered by app-tests on the actual app.
- FLIP animation timing — at0294 owns settle behavior and is unchanged by this plan (rails moving is already an animated path).
- Cross-platform font metrics beyond the shipped face — the pin measures the face the app actually renders; hypothetical fallback stacks are not worth the brittleness.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Run app-tests bare via `just` — never piped.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Greed ranks in the registry | done | `a0b73d4ed` |
| #step-2 | The per-rail solver + unit-suite rewrite | done | `03d4193be` |
| #step-3 | Deck-manager greed fold | done | `dce8073b2` |
| #step-4 | Gazette typography and derived widths | done | `13f5f92ea` |
| #step-5 | The solutions sweep and golden table | done | `47df4681d` |
| #step-6 | at0303 rewrite | done | `f188b6d0a` |
| #step-7 | Integration checkpoint | done | `0d5a5e3f8` |

#### Step 1: Greed ranks in the registry {#step-1}

**Commit:** `tugdeck(card-registry): register sidebar greed ranks (Gazette 1, Lens 2, Jots 3)`

**References:** [P03] Greed rank, Table T01, Spec S02, (#symbols)

**Artifacts:**
- `greedRank?` on `CardRegistration`, `DEFAULT_GREED_RANK`, `getGreedRank()` in `tugdeck/src/card-registry.ts`.
- Ranks registered per Table T01 in the three registration files.

**Tasks:**
- [ ] Add the field, constant, and accessor with doc comments stating the semantics (lower = greedier: fed first in surplus, drained last in deficit; consumed by the space allocator via `deck-manager.ts`).
- [ ] Register 1/2/3 on Gazette/Lens/Jots. This step is inert — nothing reads the ranks yet — so it lands compile-clean without touching the solver.

**Tests:**
- [ ] Unit: `getGreedRank` returns the registered rank, and `DEFAULT_GREED_RANK` for an unregistered id (add to the existing registry coverage in `tugdeck/src/lib/__tests__/` or beside the registry's current tests if a file exists; otherwise a small block in `layout-imposer.test.ts`'s neighbor is fine — keep it a pure-registry test).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test src`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 2: The per-rail solver and the unit-suite rewrite {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(imposer): replace graded licence and shared width with lexicographic per-rail solver`

**References:** [P01] Lexicographic invariants, [P02] Per-rail answers, [P06] Total function, Spec S01, Spec S02, (#current-allocator-inventory, #piecewise-linear, #worked-example)

**Artifacts:**
- Rewritten `allocateSidebarWidths` and `RailPolicy` in `tugdeck/src/lib/layout-imposer.ts`; deleted `LENS_FLEX_SHRINK_FRACTION` and `ALLOCATOR_RESIDUAL_TOLERANCE_PX`; `seamPicture` exported.
- `tugdeck/src/lib/__tests__/layout-imposer.test.ts`: the `"the space allocator"` block rewritten to Spec S01's regimes; the `"every standing rail takes one shared width"` block replaced by a greed-ordering block.

**Tasks:**
- [ ] Implement Spec S01 exactly: guards (including `greedRank` finiteness), per-rail bounds, target total — **`solveSidebarWidths` returns the rails' total already; do not subtract the band again** — `Σ pref` target when it returns `null`, then reverse-greed drain / greed fill, tie split with remainder redistribution, rounding.
- [ ] Update `RailPolicy` per Spec S02; delete the two constants and every grade; rewrite the function's doc comment per #documentation-plan.
- [ ] Make `deck-manager.ts`'s `RailPolicy` construction match the new shape (pass `greedRank: getGreedRank(componentId)`, drop `currentWidth`). The *fold* work and doc updates land in #step-3; this step does the field swap so the build is green.
- [ ] Rewrite the allocator unit blocks in the same commit — the solver and the suite that proves it land together, so this step has a real green boundary: exact tiling; deficit drains reverse-greed (Lens to floor before Gazette gives); surplus fills greed-first (Gazette to ceiling, and **past preference** — the deleted Grade-3 cap must not reappear); per-rail asymmetric answers; floor-beats-ceiling; no-chain → clamped preferences ([Q02]); tie split with remainder; guards return `null` only for no-rail/non-finite.
- [ ] Port the #worked-example numbers as one named test — including the canvas-2430 overflow case (both rails on floors, seam at −6) — so the plan and the suite share an oracle.

**Tests:**
- [ ] The rewritten allocator suite above.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/layout-imposer.test.ts`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`

---

#### Step 3: Deck-manager greed fold {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(imposer): greed-fold sidebar rails in deck-manager`

**References:** [P03] Greed rank, [P04] Stacking fold, [P08] Moments unchanged, Spec S02, Table T01, (#state-zone-mapping)

**Artifacts:**
- `_sidebarRails` min-folds `greedRank`; doc comments updated across `deck-manager.ts` per #documentation-plan.

**Tasks:**
- [ ] Fold ranks (`Math.min`) in `_sidebarRails` via `getGreedRank(componentId)`; delete the `currentWidth` fold; update the method's doc comment (the max-fold preferred/floor language stays — [P04]).
- [ ] Update `_sidebarPreferredWidth` and `retuneSidebarAllocation` doc comments where they describe deleted behavior (soft floor, standing-picture judging, one shared width). `retuneSidebarAllocation`'s "THE MOMENTS" paragraph stays verbatim — [P08].

**Tests:**
- [ ] Unit: the stacking folds, asserted against `allocateSidebarWidths` with rail policies built the way `_sidebarRails` builds them — wider preference wins, tightest (largest) floor binds, greediest (minimum) rank wins.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src && bunx tsc --noEmit && bunx vite build`

---

#### Step 4: Gazette typography and derived widths {#step-4}

**Depends on:** #step-1

**Commit:** `tugdeck(gazette): bump type to 14px and derive rail widths from the 56–64ch measure`

**References:** [P05] ch derivation, [P07] Authored and pinned, [Q01] Font sizes, Spec S03, (#state-zone-mapping)

**Artifacts:**
- `gazette-card.css`: body 14px + `max-inline-size: 64ch`, meta 11px, empty 14px.
- `gazette-card-registration.tsx`: the Spec S03 constants; `MIN_GAZETTE_WIDTH_PX` / `DEFAULT_GAZETTE_WIDTH_PX` become derived.
- at0365 gains the measure-pin test.

**Tasks:**
- [ ] CSS changes per Spec S03.
- [ ] Write the pin test first with placeholder constants and `note()` output; run it once to *obtain* the honest measured values (`GAZETTE_BODY_CH_PX`, `GAZETTE_ROW_CHROME_PX`); author them into the registration; re-run green ([P07]'s one-time measurement procedure).
- [ ] Document the chrome anatomy beside `GAZETTE_ROW_CHROME_PX` per Spec S03.

**Tests:**
- [ ] The at0365 measure-pin test (font-size, ch advance, chrome, derived-width formula — tolerances per Spec S03).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test at0365-gazette-card.test.ts`

---

#### Step 5: The solutions sweep and golden table {#step-5}

**Depends on:** #step-2, #step-4

**Commit:** `tugdeck(imposer): exhaustive solution sweep + golden table as the regression net`

**References:** [P09] Golden table, List L01, List L02, Spec S01, (#piecewise-linear)

**Artifacts:**
- `tugdeck/src/lib/__tests__/layout-imposer-solutions.test.ts` and `…/golden/imposer-solutions.json`.

**Tasks:**
- [ ] Implement the enumeration per List L01 with a per-configuration breakpoint computer (#piecewise-linear); assert every List L02 invariant at every point (use the exported `seamPicture` for invariant 4).
- [ ] Golden slice: a deterministic representative subset (~200 rows: every rail-config fixture × every kind at one occupancy each × breakpoint canvases), serialized as sorted JSON; compare against the checked-in file; regenerate via `IMPOSER_GOLDEN_UPDATE=1 bun test …` (documented in the test header). Fixture widths use the *landed* Gazette constants from #step-4, imported — never re-hardcoded.

**Tests:**
- [ ] The sweep and golden comparison are the tests.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/layout-imposer-solutions.test.ts`
- [ ] `cd tugdeck && bunx tsc --noEmit`

---

#### Step 6: at0303 rewrite {#step-6}

**Depends on:** #step-3

**Commit:** `tests(at0303): per-rail greedy allocator invariants`

**References:** [P02] Per-rail answers, [P03] Greed rank, [P08] Moments unchanged, Risk R02, Table T02 below, (#success-criteria)

**Table T02: at0303 invariant disposition** {#t02-at0303-disposition}

| Old invariant | Disposition |
|---|---|
| Engagement + FLIP settle | keep |
| Preference untouched across close/reopen | keep — the no-ratchet property, now structural ([P06]) |
| Untileable give-back capped at chosen width | **replace** — the chosen-width cap was Grade 3's rule and is deleted with it. Deficit clamps at floors; surplus is capped by the clamped target and then `ceil_i`, **not** by preference ([P01], Spec S01 step 4). Assert the new rule explicitly so the old one cannot creep back. |
| Re-assert re-tunes / assignCardToSlot re-tunes | keep ([P08]) |
| Two rails → one width | **replace** with: two rails answer per-rail; greed order observable (Gazette holds while Lens drains) |

**THE HARNESS CANNOT RESIZE THE WINDOW.** at0303's own header says so ("The harness cannot resize the app's window, so this gesture is what covers that entry end to end"), and the existing test is built around that fact: it computes fixture card widths at runtime from the *measured* canvas and uses the re-assert gesture as the retune trigger. Do not write a step that resizes the canvas — it cannot be done.

The substitution is exact, not a compromise. `T*` is `canvasWidth − gap·(R+2) − B*`, and `B*` is a function of the chain's card widths, so **moving a fixture card's width moves the target exactly as moving the canvas would**. To place the deck on either side of a breakpoint, seed card widths rather than window sizes, then re-assert the layout ([P08]'s moment) to make the solver run.

**Tasks:**
- [ ] Rewrite `tests/app-test/at0303-imposer-space-allocator.test.ts` per Table T02, driving the real app: open Gazette right + Lens left, seed both preferences through tugbank (as the current test seeds `PREFERRED`), compute fixture card widths from the measured canvas so `T*` lands first in the surplus regime and then in the deficit regime, re-assert the layout at each, and assert on real pane widths that (a) the two rails answer with *different* widths and (b) the Lens drains to its floor while the Gazette holds its preference.
- [ ] Keep invariant 2 (preference untouched across close/reopen) reading through the production path exactly as it does today — it is the no-ratchet guard and [P06] only strengthens it.
- [ ] Verify `@covers` still resolves (`just app-test-covers-check`).

**Tests:**
- [ ] at0303 itself.

**Checkpoint:**
- [ ] `just app-test at0303-imposer-space-allocator.test.ts`

---

#### Step 7: Integration Checkpoint {#step-7}

**Depends on:** #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Grep-verify the deletions: `grep -rn "LENS_FLEX_SHRINK_FRACTION\|ALLOCATOR_RESIDUAL_TOLERANCE_PX\|currentWidth" tugdeck/src/lib/layout-imposer.ts tugdeck/src/deck-manager.ts` returns nothing.
- [ ] Full frontend verification and the derived app-test selection.

**Tests:**
- [ ] Aggregate: unit suites + selected app-tests together.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A deterministic, total, per-rail space allocator with registered greed order and typographically derived Gazette widths, pinned by an exhaustive generated solution table.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] Every #success-criteria item verified by its named mechanism.
- [x] Step Status Ledger fully `done` with commit hashes recorded.
- [ ] On a live deck: Gazette right + Lens left, window narrowed — the Lens visibly drains to its floor while the Gazette holds its 64ch measure. *(The user's vetting pass on the debug build. Clear the `dev.tugtool.gazette` / `widthPx` tugbank key first — see [P05]: a stored width is still the user's preference and the new measure only reaches a Gazette nobody has sized.)*

**Landed values.** The measure came out at `GAZETTE_BODY_CH_PX = 8.4` and `GAZETTE_ROW_CHROME_PX = 42`, so the Gazette's preferred width is **580** and its floor **512** — both matching the in-app measurement exactly (at0365). The plan's illustrative 560/496 were estimates; the sweep, the golden table, and at0303 all read the landed constants rather than re-hardcoding them.

**Acceptance tests:**
- [ ] `cd tugdeck && bun test src` (allocator suite + solutions sweep + golden)
- [ ] `just app-test at0303-imposer-space-allocator.test.ts at0365-gazette-card.test.ts`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Gazette internal presentation redesign (the "*many* improvements" phase this plan clears space for).
- [ ] Global design-decision entry for the allocator doctrine in `tuglaws/design-decisions.md` (user lands tuglaws edits).
- [ ] Per-card rail ceilings if a card ever asks ([Q03]).

| Checkpoint | Verification |
|------------|--------------|
| Solver totality + invariants | `layout-imposer-solutions.test.ts` sweep |
| Behavior drift | golden JSON diff in review |
| Typography ↔ width coherence | at0365 measure pin |
| Real-deck greed order | at0303 |

---
---

## Phase 2 Fixup Addendum — the picture-directed total {#phase-2-fixup}

**Purpose:** Phase 1 landed on `main` at `931665ecc` and is **not acceptable in use**. This addendum diagnoses why, from measured evidence, and specifies the repair: a rail total chosen by evaluating the *real painted geometry* rather than by a least-squares fit over a linear model, and a two-level floor that stops a legibility preference from outranking the deck's duty to show the user's cards without overlap. It also repairs the regression net, which was built so that it could not observe the failure.

Phase 2 is a **correction of Phase 1's design**, not new capability. Everything in Phase 1's #non-goals stays out of scope.

---

### Phase 2 Metadata {#phase-2-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | implemented (awaiting the owner's live-deck vetting pass — [P15]) |
| Target branch | main |
| Phase 1 landed at | `931665ecc` (squash-joined from `tugdash/solve-layout-imposer`) |
| Last updated | 2026-08-12 |

---

### Phase 2 Context — what shipped, and what is wrong with it {#phase-2-context}

Phase 1 replaced the allocator's graded acceptance policy with a lexicographic water-fill: hard floors, then the least-squares tiling total as the target, then preferences filled in registered greed order, then the shared ceiling. In use it is worse than what it replaced. The reported symptoms, all four of them real and all four reproduced below:

1. It does a poor job of resolving small overlaps.
2. The Gazette stays stubbornly wide when shrinking it would find a solution.
3. Gaps between cards are sometimes narrower than the imposition gap — not the standard snap rhythm.
4. It behaves as though it does not run on an OS window / canvas resize at all.

#### The measured evidence {#phase-2-evidence}

Reproduced against the landed module (`tugdeck/src/lib/layout-imposer.ts` at `931665ecc`) with a three-up deck, three 800px content cards in slots 0/1/2, Gazette right (preferred 580, floor 512, rank 1) and Lens left (preferred 420, floor 320, rank 2), ceiling 675.

**Table T03: the answer as the canvas grows** {#t03-flat-answer}

| canvas | `T*` (least-squares total) | answer (left / right) | worst overlap |
|---|---|---|---|
| 1400 | −1030 | 320 / 512 | 800 |
| 2000 | −430 | 320 / 512 | 626 |
| 2600 | 170 | 320 / 512 | 326 |
| 3200 | 770 | 320 / 512 | **26** |
| 3300 | 870 | 320 / 550 | 0 |
| 3400 | 970 | 390 / 580 | 0 |

The answer is **identical across an 1800px range of canvas widths**. Symptom 4 is not a wiring bug: the settled-resize observer in `tugdeck/src/components/chrome/deck-canvas.tsx` (the `ResizeObserver` that calls `store.retuneSidebarAllocation()` after `RESIZE_RETUNE_QUIET_MS`) is intact and fires. The allocator runs and returns the same number every time, because `target = clamp(T*, Σfloor, Σceil)` saturates at `Σfloor = 832` for every canvas in that range. **Symptom 4 is a consequence of symptom 2.**

**Table T04: the 26px overlap at canvas 3200 is trivially fixable** {#t04-floor-blocks-solution}

| Gazette floor | answer (left / right) | worst overlap | worst seam error |
|---|---|---|---|
| 512 (shipped) | 320 / 512 | 26 | 31 |
| 480 | 320 / 480 | 10 | 15 |
| **440** | 320 / **450** | **0** | **0** |
| 400 | 320 / 450 | 0 | 0 |

A total of 770 tiles this deck exactly. The rails can reach it. The 512 floor forbids it. Symptom 2 is mechanical, and the user diagnosed it correctly from the outside.

**Least squares spreads error rather than removing it.** Five-up with cards in slots 0, 1 and 4 (an occupancy no band tiles), Gazette alone on the right, at canvas 3200:

```
seams: -372.5 | +482.5        (the imposition gap is 5)
```

One pair of cards occluding by 372px so the next pair can stand 482px apart. Sum-of-squares treats an overlap and a gap as equally costly; on screen they are not remotely equivalent. The rail sits pinned at its 675 ceiling contributing nothing. Phase 1's predecessor recognised this case ("the best band there is, is not a tiled one") and returned `null` — it left the rails alone. Phase 1 always commits the compromise, so the user now always sees it. This is symptom 3, and part of symptom 1.

#### The three root causes {#phase-2-root-causes}

**Cause A — a legibility preference was registered as an inviolable constraint.** `MIN_GAZETTE_WIDTH_PX` (`tugdeck/src/lib/gazette-measure.ts`) is `56ch + chrome = 512`, meaning "the narrowest measure that still reads as prose". That is a *preference*. Phase 1 registered it as `sizePolicy.min.width`, which the solver treats as rank-1 inviolable — above the requirement that the chain not overlap. The deck now prefers a well-measured Gazette to showing the user's own cards un-occluded, which inverts the priority the pre-Phase-1 code stated correctly ("cards crowding or occluding one another is the deck failing to show the user's cards, and that outranks holding a rail's chosen width").

It is worse than an allocator problem: `sizePolicy.min.width` also clamps the user's own resize drag (`tugdeck/src/components/chrome/tug-pane.tsx`, the `Math.max(newSize.width, sizePolicy.min.width)` in the resize commit), and `allocateSidebarWidths` clamps `preferredWidth` up to the floor. **The user cannot drag their way out of it either.**

Phase 1 deleted `LENS_FLEX_SHRINK_FRACTION` — a *soft* floor sitting above the hard `minWidth`, with the hard floor reachable when the picture was suffering — as part of deleting the graded licence. The two-level floor was the load-bearing idea; the three grades were the decoration. Both were demolished together.

**Cause B — the objective is wrong in the crowded regime.** `solveSidebarWidths` minimises the sum of squared seam errors over the *linear* seam model. That model is only valid while every pane still has travel left; `imposeRect` clamps travel at zero, so on a crowded deck the linear form describes a picture the browser never paints. Phase 1's predecessor compensated by judging its own answers through `seamPicture` — the real painted geometry. Phase 1 removed `seamPicture` from the decision path entirely and demoted it to a test helper. **The one component that knew what the screen actually looked like was deleted from the decision.**

**Cause C — the regression net was built with a hole exactly where the failure is.** `tugdeck/src/lib/__tests__/layout-imposer-solutions.test.ts` asserts its tiling invariant only under this guard:

```ts
if (solved !== null && solved >= floorTotal && solved <= ceilingTotal && chainTilesExactly(input, answer)) { … }
```

That condition *is* "the regime that already works". Every failing case is excluded by construction, so 1.46M assertions proved nothing about the failure mode. The golden table then froze the behavior as correct, and at0303 passes because it checks numbers derived from the same wrong model. See #phase-2-net-postmortem.

---

### Phase 2 Strategy {#phase-2-strategy}

- **Keep what was right.** The separation property (#piecewise-linear) is sound and load-bearing: the band, and therefore every seam, depends only on the rails' **total** and never on how that total is split. So the problem decomposes cleanly into *choose the total* (which determines the picture) and *distribute the total* (which cannot affect the picture at all). Phase 1's distribution — greed-ordered fill with tie splitting — is correct and survives unchanged except for the two-level floor. **The bug is entirely in choosing the total.**
- **Choose the total by looking at the real picture.** Replace "least-squares fit, then clamp" with a search over candidate totals scored by `seamPicture` — the actual `imposeRect` geometry. The candidate range is a bounded integer interval, and the scoring is a lexicographic key, so the result is still exact, pure, deterministic and total ([P10], Spec S04).
- **Restore two floors, and state when the softer one is spent.** A hard floor (can't paint below this — also the user's drag floor) and a comfort floor (the 56ch measure). Comfort is given up **if and only if** giving it up removes overlap entirely ([P11]).
- **Fix the net before trusting the fix.** Add invariants that assert on the crowded regime and confirm they fail against the landed solver before implementing ([P14]).
- **Look at it.** Phase 1's only live-deck criterion was left for the user, and it was the one thing that would have caught all of this in thirty seconds. Phase 2 closes with an observed vetting pass on a debug build ([P15]).

---

### Phase 2 Success Criteria (Measurable) {#phase-2-success-criteria}

- For the Table T03 fixture, the answer takes **at least 5 distinct values** as the canvas sweeps 1400 → 3400 in 100px steps (today: three), and **at least 15 distinct values** across 3150 → 3350 in 10px steps — the band where zero-overlap totals are reachable and the answer must track the canvas pixel-for-pixel. Direct pin on symptom 4 — unit-asserted in the solutions sweep. (The 320/512 plateau from ~1700 to ~3100 is *correct*: three 800px cards genuinely cannot tile there, so comfort is rightly held. A simulation of Spec S04 against the landed module confirms exactly five values on the coarse sweep — a criterion demanding eight would fail against the repaired solver.)
- At canvas 3200 for the Table T03 fixture, the answer is `left 320 / right 450`, worst overlap 0, worst seam error 0. Direct pin on symptoms 1 and 2.
- **The no-overlap invariant:** for every enumerated configuration, if any rail total in `[Σ hardFloor, Σ ceiling]` yields zero overlap, the answer has zero overlap. This assertion **fails against `931665ecc`** — that failure is the proof the net has teeth ([P14]).
- **The rhythm invariant:** among totals with zero overlap, no seam is under `IMPOSITION_GAP_PX` unless no reachable total avoids it. Direct pin on symptom 3.
- **The comfort invariant:** a rail is below its comfort floor only when no total at or above `Σ comfortFloor` yields zero overlap *and* some total below it does. Pins that comfort is spent for a reason and never gratuitously.
- The user can drag the Gazette rail down to `MIN_GAZETTE_WIDTH_PX` by hand (at0365 or at0303 gesture assertion) — the Phase 1 512 trap is gone.
- A preference dragged below the comfort floor stays honored on a crowded deck: with the Gazette's stored width at 450, no crowded-regime answer stands the Gazette above 450 ([P17], List L03 item 7). The comfort floor never re-inflates a drag.
- Phase 1's surviving guarantees hold: totality, bounds, greed soundness, stacking folds, tie fairness (List L02), and the no-ratchet property (`RailPolicy` still cannot see a standing width). Canvas monotonicity is **restated per-regime** ([P16]) — the comfort rule's binary spend makes the global form impossible, and the sweep's assertion moves with it.
- `cd tugdeck && bunx tsc --noEmit && bunx vite build` clean; `bun test src` green; the derived app-test selection green.
- The golden table is regenerated in its own commit, so the behavioral diff is reviewable as the repair rather than buried in the solver commit.

---

### Phase 2 Scope {#phase-2-scope}

1. `tugdeck/src/lib/layout-imposer.ts` — total selection rewritten (Spec S04); `RailPolicy` gains `comfortWidth` (Spec S06); two-level drain in distribution (Spec S05); `seamPicture` gains a shortfall reading and returns to the decision path.
2. `tugdeck/src/lib/gazette-measure.ts` — split the single floor into a hard floor and a comfort floor.
3. `tugdeck/src/card-registry.ts` — `comfortWidth?` registration field and accessor; Gazette registers it.
4. `tugdeck/src/deck-manager.ts` — max-fold `comfortWidth` in `_sidebarRails`.
5. Regression nets: crowded-regime invariants in `layout-imposer-solutions.test.ts`, new unit cases, regenerated golden, at0303 additions.

### Phase 2 Non-goals {#phase-2-non-goals}

- Everything in Phase 1's #non-goals remains out of scope — placement (Layer A), the split-rail math, the moments ([P08] still holds: this changes *what the answer is*, never *when it is asked for*), per-card ceilings, content width presets, preference sourcing.
- **Not reverting Phase 1.** Per-rail answers, registered greed order, the ch-derived Gazette measure and the totality contract are all kept. This addendum repairs how the total is chosen and re-introduces the second floor.
- No new runtime state (see #phase-2-state-zone-mapping).
- The Gazette's *comfort* measure stays 56ch — this addendum does not re-tune the typography.

### Phase 2 Constraints {#phase-2-constraints}

- Inherits Phase 1's #constraints in full: pure tugdeck phase, bun never npm, `bunx vite build` mandatory before declaring done, app-tests selective and never piped, warnings are errors, no `localStorage`, tuglaws [L02]/[L06] apply.
- **The solver must stay cheap.** It runs on every settled resize. Spec S04's search must cost no more than a few hundred `seamPicture` evaluations, and the solutions sweep (~50k solves) must still finish in a couple of seconds — see [P13].
- The solver stays **pure**: no DOM, no store, no measurement. `seamPicture` is already pure arithmetic over `imposeRect`.

### Phase 2 Assumptions {#phase-2-assumptions}

- `seamPicture(input, widths)` reads the same picture for any split of a given total. This is the separation property and it is already unit-asserted in `layout-imposer.test.ts` ("moving width between the rails leaves every seam where it was"). **Caveat for the implementer:** the *number of standing sides* does matter, because `resolveSpan` adds one imposition gap per occupied side. A candidate total must therefore be evaluated with a `RailWidths` carrying the same sides the answer will, summing to the candidate.
- Every seam is non-increasing in the rails' total (a bigger total means a smaller band). This holds exactly while all panes have travel; it can flatten where `imposeRect`'s `max(0, …)` clamps. Spec S04 therefore uses a scan rather than a binary search — see [P13].

---

### Phase 2 Open Questions {#phase-2-open-questions}

#### [Q04] What is the Gazette's true hard floor? (DECIDED, one constant) {#q04-gazette-hard-floor}

**Question:** 512 is the comfort floor (56ch + chrome). What is the width below which the Gazette genuinely cannot be painted?

**Why it matters:** It sets how much overlap relief the deck can buy, and it is the width the user's own drag can reach.

**Resolution:** DECIDED — **400**, which is what shipped before Phase 1 and, at the landed `GAZETTE_BODY_CH_PX = 8.4` and `GAZETTE_ROW_CHROME_PX = 42`, is a measure of about 42 characters — narrow, still readable, and enough for the byline and a ref chip. This is a single constant (`MIN_GAZETTE_WIDTH_PX` in `tugdeck/src/lib/gazette-measure.ts`); raising it to ~460 trades overlap relief for a wider guaranteed measure and requires no other change. The owner can overrule the number without touching the design.

#### [Q05] Should `seamPicture` distinguish a too-narrow seam from a too-wide one? (DECIDED) {#q05-shortfall-reading}

**Question:** `seamPicture` reports `worstError = max |seam − gap|`, which scores a seam 10px *under* the gap the same as one 10px *over* it.

**Why it matters:** Symptom 3 is specifically "gaps sometimes too narrow". A chooser minimising `worstError` will happily land on a cramped chain when an airy one scored the same.

**Resolution:** DECIDED — `seamPicture` gains `worstShortfall` (`max(0, gap − seam)`), and Spec S04 ranks it ahead of `worstError`. A chain that is slightly airy reads as arranged; a chain that is slightly cramped reads as broken. `worstOverlap` stays a separate, higher-ranked term because occlusion is a different kind of failure from a tight seam.

#### [Q06] Should the Lens and Jots carry comfort floors too? (DEFERRED) {#q06-other-comfort-floors}

**Question:** Only the Gazette has a typographic comfort width. Should the list rails get one?

**Resolution:** DEFERRED. `comfortWidth` defaults to `minWidth` (no comfort band), which reproduces today's Lens and Jots behavior exactly, and neither was reported as a problem. Revisit if a list rail is ever reported as cramped.

---

### Phase 2 Risks and Mitigations {#phase-2-risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| The scan is too slow for the solutions sweep | med | med | Coarse-to-fine scan ([P13]); sweep timing asserted in the test | Sweep runtime over ~5s |
| The new objective is wrong in some regime nobody enumerated | high | low | The sweep now asserts on the crowded regime, which is where Phase 1 was blind; plus an exhaustive-optimum cross-check on a subset ([P13]) | Any user-visible arrangement complaint |
| Golden churn hides the repair | low | high | Golden regenerated in its OWN commit, after the solver commit ([P14]) | — |
| Rails move more often now | low | med | Unchanged from Phase 1's R01 — the moments are untouched, the answer is idempotent, `_commitImposition`'s 1px deadband still suppresses no-ops | Visible churn on ordinary resizes |

**Risk R03: the comfort floor becomes a second stubbornness** {#r03-comfort-stubbornness}

- **Risk:** If comfort is spent only when it removes overlap *entirely*, a deck that stays overlapped no matter what keeps its rails at comfort width while the cards occlude — visually the same complaint, one level down.
- **Mitigation:** This is deliberate and is the correct reading (see [P11]): on a chain that cannot be repaired, cramping the rails buys occlusion the user still sees, at the cost of a rail they can no longer read. The prototype confirms the behavior is coherent — on a hopeless deck the rails sit at comfort, and on a truly tiny canvas they return to their *preferences* (nothing helps, so nothing is spent).
- **Residual risk:** A user on a permanently-too-small window sees overlap that the old code also could not fix. The honest answer there is fewer cards or a narrower content width, not a cramped rail.

**Risk R04: the hard floor drop changes the drag floor** {#r04-drag-floor-change}

- **Risk:** Lowering the Gazette's registered `sizePolicy.min.width` from 512 to 400 lets the user drag it narrower than the measure it was designed for.
- **Mitigation:** That is the point — Phase 1 trapped them at 512 and [L23] says a width the user chose is theirs. The comfort floor keeps the *allocator* off that range.
- **Residual risk:** None beyond the user choosing a narrow rail deliberately.

**Risk R05: the comfort boundary pop is visible** {#r05-boundary-pop}

- **Risk:** At the first canvas width where a zero-overlap total becomes reachable, the answer jumps discontinuously (Table T03 fixture, measured: Gazette 512 → 400, a 112px move for a ~2px window change at canvas ~3138 → 3140; and 420/580 → 320/512 at 1650 → 1660 where the flat-picture tie releases).
- **Mitigation:** The jump happens only at the three moments ([P08]) and rails animate by the same FLIP settle as every imposed move (at0294). It is the solve made visible: the deck spends comfort at exactly the width where spending it buys a clean picture. [P16] restates the monotonicity invariant so the net expects the jump instead of forbidding it.
- **Residual risk:** A user dragging the window slowly across the boundary sees a pronounced snap. Accepted — the continuous alternative is a graded spend, which is the licence this plan deleted for good reason.

---

### Phase 2 Design Decisions {#phase-2-design-decisions}

#### [P10] The rail total is chosen by scoring the real painted geometry (DECIDED) {#p10-picture-directed-total}

**Decision:** `allocateSidebarWidths` no longer takes `solveSidebarWidths`'s least-squares total as its target. It searches candidate totals over `[Σ hardFloor, Σ ceiling]` and picks the one whose **real** `seamPicture` scores best on a lexicographic key (Spec S04). `solveSidebarWidths` is kept and exported — it is still the honest closed-form band fit, it is still what the golden/breakpoint arithmetic is built on, and it is used to seed the scan — but it is no longer the answer.

**Rationale:**
- The separation property makes this legitimate and cheap: the picture is a function of the *total alone*, so a one-dimensional search over an integer interval is an exhaustive search of the entire picture space.
- Least squares minimises a sum over a linear model. What the user sees is the *worst* seam under `imposeRect`'s real clamped rule. Those are different objectives, and Table T03/T04 is what the difference looks like.
- It restores the pre-Phase-1 insight — judge the result by the picture — without restoring the machinery that was actually wrong (the grades, the tolerance constants, the comparison against the standing widths). The score is an **objective**, not an acceptance test: there is no tolerance to tune and no "refuse" branch.

**Implications:**
- `seamPicture` returns to the decision path and stops being test-only. It gains `worstShortfall` ([Q05]).
- The answer stays a pure, total, deterministic function of `(canvasWidth, kind, occupied, rails, maxRailWidth)`. No ratchet: `RailPolicy` still cannot carry a standing width.
- The `null` contract is unchanged ([P06]): no rail stands, or an input is non-finite.

#### [P11] Two floors, and comfort is spent only to remove overlap (DECIDED) {#p11-two-floors}

**Decision:** A rail carries a **hard floor** (`minWidth` — the width below which the card cannot be painted, and the floor the user's resize drag clamps to) and a **comfort floor** (`comfortWidth` — the narrowest the rail is comfortable at). The chooser runs its search over the comfort domain first; it descends into `[Σ hardFloor, Σ comfortFloor)` **if and only if** some total down there yields zero overlap and nothing in the comfort domain does.

**Rationale:**
- This is the priority the pre-Phase-1 allocator stated correctly and Phase 1 inverted: the deck's duty to show the user's cards un-occluded outranks a rail's preferred measure, but not the rail's ability to paint at all.
- Stated as "if and only if it removes overlap entirely", it is a rule with a yes/no answer rather than a graded judgement — which is what makes it testable and what distinguishes it from the licence Phase 1 deleted for good reason.
- Validated against the failing cases: at canvas 3200 comfort is spent and the chain tiles exactly (320/450, zero overlap, zero seam error); at 3400 comfort is untouched; on an unrepairable deck comfort is held rather than squandered.

**Implications:**
- Gazette: `MIN_GAZETTE_WIDTH_PX` becomes 400 ([Q04]); the 56ch derivation becomes `COMFORT_GAZETTE_WIDTH_PX = 512`.
- `comfortWidth` folds across a rail's stacked members by `Math.max`, exactly as `minWidth` does — a rail must satisfy its most demanding member.
- Cards that register no comfort width take `comfortWidth = minWidth`, which is today's behavior ([Q06]).
- At solve time the comfort floor is clamped under the rail's preference ([P17]) — a rail the user dragged below its comfort measure keeps the drag as its effective comfort floor; comfort constrains the allocator, never the user.

#### [P12] Greed-ordered distribution is unchanged, but drains in two tiers (DECIDED) {#p12-two-tier-drain}

**Decision:** Distribution keeps Phase 1's greed-ordered water-fill with even tie splitting and remainder redistribution (Spec S01 step 4). The only change: a deficit drains every rail to its **comfort** floor in reverse-greed order first, and only if the total is still unmet does it continue draining to **hard** floors, again in reverse-greed order.

**Rationale:**
- Distribution cannot affect the picture (the separation property), so nothing about the reported symptoms lives here. Changing it would be scope creep.
- Two-tier draining keeps the greed order meaningful in the comfort band: the least greedy rail gives up its comfort before the greediest gives up any.

**Implications:** Phase 1's greed-soundness invariants (List L02 item 3) are restated per tier and stay asserted.

#### [P13] The search is a coarse-to-fine scan, cross-checked against exhaustive (DECIDED) {#p13-scan-strategy}

**Decision:** The chooser scans the candidate interval at a coarse stride (16px), then rescans ±16px around the coarse winner at 1px. A test cross-checks the scan's answer against a full 1px exhaustive search over a representative subset of configurations.

**Rationale:**
- A binary search would be tempting — every seam is non-increasing in the total, so overlap is monotone — but `imposeRect`'s `max(0, band − w)` clamp flattens that relationship where a pane runs out of travel, and with unequal card widths the flat regions do not line up. A scan is robust to that; a binary search would be correct almost always, which is the worst kind of correct.
- Cost: an interval of ~630px is ~40 coarse plus ~32 fine evaluations, each `O(chain)` — well under a millisecond, and cheap enough that the ~50k-solve sweep stays in seconds.
- The exhaustive cross-check is what makes the stride a performance decision rather than a correctness gamble.

**Implications:** The stride is a named constant with a doc comment. If the cross-check ever fails, the stride is wrong, not the objective.

#### [P14] The net is repaired before the solver, and proven to fail first (DECIDED) {#p14-net-first}

**Decision:** The crowded-regime invariants (List L03) are written and **run against the landed solver to confirm they fail**, before the fix is implemented. Because a red commit is not allowed, the invariants and the fix land in the same commit (as Phase 1's Step 2 landed its solver and suite together) — but the observed failure is recorded in the step's dash-round summary. The golden table is regenerated in a **separate, later commit** so the behavioral diff is reviewable on its own.

**Rationale:**
- Phase 1's net passed 1.46M assertions against a solver the user rejected on sight. A net that has never been observed to fail has not been shown to test anything.
- Regenerating the golden in the same commit as the solver would bury the repair in ~488 rows of churn; separated, the golden diff *is* the evidence of what changed.

**Implications:** The Step 9 checkpoint includes "the new invariants were observed failing against `931665ecc` before the fix" as a recorded fact.

#### [P15] The phase does not close without an observed live deck (DECIDED) {#p15-observed-close}

**Decision:** Phase 2's final step is a vetting pass on a `just app-debug` build in which the implementer **actually resizes the window** with Gazette and Lens open and reports what was observed — rail widths tracking the canvas, no overlap where a reachable total removes it, seams on the gap.

**Rationale:** Phase 1's automated checkpoints were all green while the feature was unusable. Every symptom was visible in seconds of real use. An automated suite is a regression net, not evidence that a thing is good.

**Implications:** The step's checkpoint is a written observation, not only a green command. It is falsifiable by the specific claims it must make (see #step-11).

#### [P16] Canvas monotonicity is per-regime; the comfort boundary pops (DECIDED) {#p16-per-regime-monotonicity}

**Decision:** List L02 item 5 ("each rail's width is non-decreasing in canvas width") is restated per-regime: within a run of canvases where the comfort rule takes the same branch (comfort-domain answer, hard-domain answer, or comfort-held), each rail is monotone non-decreasing; across a branch change the widths may jump in either direction, and the sweep asserts nothing at the crossing. The solutions sweep's global assertion (`layout-imposer-solutions.test.ts`, "never narrows as the canvas grows") is rewritten to match.

**Rationale:**
- The comfort rule is a binary spend ([P11]), and a binary spend has a boundary. Simulated against the landed module (Table T03 fixture, 1px canvas steps): at canvas ~3138 → 3140 the Gazette drops 512 → 400 — the first width at which a zero-overlap total becomes reachable, bought by spending comfort; and at 1650 → 1660 both rails drop from preferences (420/580) to comfort floors (320/512) as the flat-picture tie releases. Both jumps are the design working as decided, and no assertion that forbids them can pass against Spec S04. A plan that kept the global invariant would strand Step 9 red with no legal fix.
- The alternative — grading the spend so widths move continuously — is the licence Phase 1 deleted for good reason; a rule with a yes/no answer stays testable.

**Implications:**
- The sweep recomputes the branch per canvas (cheap: two oracle evaluations — see List L03's oracle note) and asserts monotonicity only within a run of one branch.
- The pop is user-visible once per crossing and is FLIP-animated like every rail move (at0294); it happens only at the three moments ([P08]). Risk R05 records it.

#### [P17] Comfort never outranks the user's drag: the comfort floor clamps under the preference (DECIDED) {#p17-comfort-under-preference}

**Decision:** A rail's effective comfort floor is `comfortFloor_i = max(floor_i, min(comfort_i, pref_i))` — the registered comfort width, clamped from above by the rail's preference (which is the user's durable drag whenever one exists).

**Rationale:**
- Phase 2 clamps preferences only to the *hard* floor, so a user can stand the Gazette at 450, below its 512 comfort measure. Without this clamp, a crowded deck's target is `comfortBest ≥ Σ comfortFloor`, which exceeds the user's preferred total — the distribution then *grows* the dragged rail back to 512, widening it against the user's explicit choice and increasing the overlap by the same pixels. That is the "stubbornly wide" complaint resurfacing for exactly the user who tried to fix it by hand, and it is the [L23] violation this phase exists to delete.
- The clamp also makes the two-tier drain structurally safe: with `comfortFloor_i ≤ pref_i`, every comfort-tier capacity (`standing − comfortFloor_i`) is non-negative. Without it, Phase 1's capacity arithmetic (which Spec S05 reuses) goes negative on a below-comfort preference and inflates `need` instead of draining it.

**Implications:**
- A user who never dragged the rail sees no difference: the registered preference (580) is above comfort (512), so `min(comfort, pref)` is the comfort width, and every prototype and Table T03/T04 number stands unchanged.
- List L03 gains item 7: in the crowded regime the target never exceeds `Σ pref` — comfort never re-inflates a drag.
- The dragged-below-comfort shape (Gazette preferred 450) joins the enumeration fixtures.

---

### Phase 2 Deep Dives {#phase-2-deep-dives}

#### Why Phase 1's net could not see the failure {#phase-2-net-postmortem}

Worth reading before writing the new assertions, because the failure mode is easy to reproduce.

`layout-imposer-solutions.test.ts` enumerates a genuinely large space — six kinds × every non-empty slot subset × three uniform widths plus a mixed pattern × eight rail fixtures × breakpoints and a sweep — and asserts totality, bounds, greed soundness, monotonicity, stacking folds and tie fairness on every point. All of those are **structural** properties: they constrain the *shape* of the answer relative to the inputs. Every one of them is satisfied by an answer that looks terrible on screen.

The only invariant about the *picture* — tiling — was guarded by `solved >= floorTotal && solved <= ceilingTotal && chainTilesExactly(...)`, i.e. "the target was reachable and the chain admits an exact fit". That is exactly the set of configurations in which the Phase 1 algorithm is correct. The test asked the solver to justify itself only where it already knew the answer.

The lesson to encode in List L03: **a picture invariant must be stated against what was achievable, not against what the algorithm attempted.** "If any reachable total removes the overlap, the answer removes the overlap" makes no reference to the algorithm's internals, cannot be satisfied by a structurally-tidy wrong answer, and fails loudly on `931665ecc`.

#### The prototype that validated Spec S04 {#phase-2-prototype}

The chooser in Spec S04 was prototyped against the real module before this addendum was written. For the Table T03 fixture:

| canvas | chosen total | comfort spent? | worst overlap | worst seam error |
|---|---|---|---|---|
| 1400 | 1000 (= Σ preferred) | no | 800 | 805 |
| 2000 | 832 (= Σ comfort) | no | 626 | 631 |
| 3000 | 832 (= Σ comfort) | no | 126 | 131 |
| **3200** | **770** | **yes** | **0** | **0** |
| 3400 | 970 | no | 0 | 0 |

Three behaviors to preserve, each of which is an assertion in List L03:

1. **Canvas 3200** — comfort is spent, and the chain tiles exactly. This is the repair.
2. **Canvas 2000–3000** — no total removes the overlap (three 800px cards genuinely do not fit), so comfort is *held* and the rails sit at comfort floors having reduced the overlap as far as comfort allows.
3. **Canvas 1400** — the deck is hopeless and every total scores the same overlap, so the tie-break returns the rails to their **preferences** rather than cramping them for nothing.

---

### Phase 2 Specification {#phase-2-specification}

**Spec S04: choosing the rail total** {#s04-choose-total}

Replaces Spec S01 step 3. Signature and module unchanged; this is internal to `allocateSidebarWidths`.

Given the per-rail bounds from Spec S01 step 2, extended per Spec S06:

1. **Domains.** For each rail, `comfortFloor_i = max(floor_i, min(comfort_i, pref_i))` — the comfort width clamped from above by the rail's own preference ([P17]), so a rail the user dragged below its comfort measure is never re-inflated past their choice. `pref_i` is already inside `[floor_i, ceil_i]` (Spec S01 step 2), so `comfortFloor_i` is too. Then `hardTotal = Σ floor_i`, `comfortTotal = Σ comfortFloor_i`, `ceilTotal = Σ ceil_i`, `prefTotal = Σ pref_i`; by construction `hardTotal ≤ comfortTotal ≤ prefTotal ≤ ceilTotal`.
2. **Score.** For a candidate total `T`, build a `RailWidths` carrying **the same sides the answer will carry**, summing to `T` (any split — the picture depends only on the total; see #phase-2-assumptions), and read `seamPicture`. The score is the lexicographic key:

   ```
   key(T) = [ worstOverlap, worstShortfall, worstError, |T − prefTotal| ]
   ```

   `worstOverlap` = deepest occlusion (`max(0, −seam)`); `worstShortfall` = tightest seam under the gap (`max(0, gap − seam)`, [Q05]); `worstError` = `max |seam − gap|`; the last term keeps the rails as close to the user's chosen widths as the picture allows and makes the answer unique.
3. **Search.** `bestIn(lo, hi)` = the `T` in `[lo, hi]` minimising `key(T)`, found by the coarse-to-fine scan of [P13], ties broken toward the smaller `T` so the result is order-independent.
4. **The comfort rule ([P11]).**
   ```
   comfortBest = bestIn(comfortTotal, ceilTotal)
   if worstOverlap(comfortBest) == 0            → target = comfortBest
   else hardBest = bestIn(hardTotal, ceilTotal)
        if worstOverlap(hardBest) == 0          → target = hardBest
        else                                    → target = comfortBest
   ```
   Comfort is surrendered only to *remove* overlap, never merely to reduce it.
5. **No chain.** When the chain has fewer than two occupied slots there is no seam and every score is zero, so the key reduces to `|T − prefTotal|` and the target is `prefTotal` — which is exactly [Q02]/[P06]'s existing answer, now falling out of the objective instead of being a special case. The implementer should keep the explicit early return anyway, to skip the scan.
6. **Guards unchanged** (Spec S01 step 1): `null` only for no standing rail or a non-finite input, `greedRank` included. `comfortWidth` joins the finiteness check in `chainOf`, the single validation site.

**Spec S05: distributing the total across two floor tiers** {#s05-two-tier-drain}

Replaces Spec S01 step 4's deficit branch; the surplus branch is unchanged.

Start every rail at `pref_i`. Let `need = Σ pref_i − target`.

1. **Deficit, comfort tier.** Visit rails in reverse greed order (largest `greedRank` first). Shrink each toward `comfortFloor_i` (Spec S04 step 1 — comfort clamped under the preference, [P17]) until `need` is met. Equal ranks split their tier's delta evenly with one-pass remainder redistribution, exactly as today. Because `comfortFloor_i ≤ pref_i` by construction, every comfort-tier capacity (`standing − comfortFloor_i`) is non-negative — without the [P17] clamp, Phase 1's capacity arithmetic would go negative on a below-comfort preference and inflate `need` instead of draining it.
2. **Deficit, hard tier.** If `need` remains, visit rails again in reverse greed order, shrinking each from its comfort floor toward `floor_i`.
3. **Surplus** — unchanged from Spec S01 step 4: greed order, growth bounded by `target` then `ceil_i`, preference is not a cap.
4. **Rounding** — unchanged: round each width; the ≤R px residual stays with the band's travel.

**Spec S06: type changes** {#s06-types}

```ts
// layout-imposer.ts
export interface RailPolicy {
  preferredWidth: number;  // the user's durable choice (or the registered preferred)
  minWidth: number;        // the HARD floor — the width below which the card cannot paint
  comfortWidth: number;    // the narrowest this rail is comfortable at; ≥ minWidth
  greedRank: number;       // lower = greedier: fed first, drained last
}

// seamPicture gains a shortfall reading ([Q05])
export function seamPicture(
  input: AllocatorInput,
  widths: RailWidths,
): { worstError: number; worstOverlap: number; worstShortfall: number };

// card-registry.ts
export interface CardRegistration { /* … */ comfortWidth?: number }
export function getComfortWidth(componentId: string): number;  // ?? getSizePolicy(id).min.width

// lib/gazette-measure.ts
export const MIN_GAZETTE_WIDTH_PX = 400;                    // hard floor ([Q04]) — ~42ch
export const COMFORT_GAZETTE_WIDTH_PX =                     // 56ch + chrome = 512
  Math.round(GAZETTE_MIN_MEASURE_CH * GAZETTE_BODY_CH_PX) + GAZETTE_ROW_CHROME_PX;
```

`_sidebarRails` (deck-manager.ts) folds `comfortWidth` with `Math.max`, beside the existing max-folds for `preferredWidth` and `minWidth` and the min-fold for `greedRank`.

**Table T05: symptom → cause → the decision that fixes it** {#t05-symptom-map}

| Reported symptom | Root cause | Fixed by |
|---|---|---|
| Poor at resolving small overlaps | A + B — floor blocks the reachable total; objective ignores the real geometry | [P10], [P11] |
| Gazette stubbornly too wide | A — comfort registered as an inviolable floor, trapping the drag too | [P11], [Q04] |
| Gaps too narrow / not the snap gap | B — least squares spreads error and scores cramped == airy | [P10], [Q05] |
| Doesn't seem to run on resize | consequence of A — the answer saturates at `Σ floor` across ~1800px of canvas | [P11] (pinned by the distinct-values criterion) |
| (not reported) the net was blind | C — picture invariant guarded by the algorithm's own success condition | [P14], List L03 |

**List L03: the crowded-regime invariants** {#l03-crowded-invariants}

Added to `layout-imposer-solutions.test.ts` alongside List L02, which is kept in full. Every one of these is asserted over the same enumeration, and items 1–3 **must be observed failing against `931665ecc`** before the fix ([P14]).

1. **No avoidable overlap.** If any `T ∈ [Σ floor, Σ ceiling]` yields `worstOverlap == 0`, the answer's `worstOverlap` is 0.
2. **No avoidable crowding.** Among totals with `worstOverlap == 0`, if any yields `worstShortfall == 0`, the answer's `worstShortfall` is 0.
3. **Comfort is spent for a reason.** A rail is below its comfort floor only if no `T ≥ Σ comfort` yields zero overlap *and* some `T ≥ Σ hard` does.
4. **The answer tracks the canvas.** For the Table T03 fixture across 1400 → 3400 in 100px steps, the answers take ≥ 5 distinct values (the 320/512 plateau from ~1700 to ~3100 is correct — nothing tiles there and comfort is rightly held), and across 3150 → 3350 in 10px steps ≥ 15 distinct values — the band where zero-overlap totals are reachable and the answer must track pixel-for-pixel.
5. **The scan finds the true optimum.** On a representative subset, the coarse-to-fine result equals a full 1px exhaustive search ([P13]).
6. **Everything in List L02 still holds** — totality, bounds, greed soundness (restated per tier, [P12]), tiling where exactly achievable, canvas monotonicity per regime ([P16] — asserted within a run of one comfort-rule branch, nothing asserted at a crossing), stacking folds, tie fairness.
7. **Comfort never re-inflates a drag.** When no reachable total removes overlap, the target never exceeds `Σ pref` — a rail the user dragged below its comfort measure is never grown back by the comfort floor ([P17]). Asserted on the dragged-below-comfort fixture (Gazette preferred 450).

**The oracle note — items 1–3 do not scan.** Every seam is non-increasing in the rails' total (`imposeRect`'s `max(0, …)` clamp only flattens the relationship, never reverses it), so `worstOverlap` and `worstShortfall` are monotone non-decreasing in the total and their minima over any `[lo, hi]` sit at `lo`. "Does any reachable total yield zero overlap" is therefore ONE `seamPicture` evaluation at `Σ hardFloor`, not a 1px scan — which is what keeps List L03 inside the sweep's ~5s budget (#phase-2-constraints). The same two evaluations (at `Σ hardFloor` and `Σ comfortFloor`) tell the sweep which comfort-rule branch fired, which is all [P16]'s per-regime assertion needs.

#### Phase 2 State Zone Mapping {#phase-2-state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `comfortWidth` | none — static registration data | `registerCard` field + accessor, folded into `RailPolicy` | [D04] |
| Solved rail widths | structure (already exists) | deck store `pane.size.width` via `_commitImposition`, read through `useSyncExternalStore` | [L02] |
| Chosen total | none — a local in a pure function | — | — |

No new runtime state. No React, DOM or store surface is touched by this addendum.

---

### Phase 2 Execution Steps {#phase-2-execution-steps}

> **Commit after all checkpoints pass.** Run app-tests bare via `just` — never piped.

#### Phase 2 Step Status Ledger {#phase-2-step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-8 | Two floors in the registry and the Gazette's measure | done | `5ddb05a1e` |
| #step-9 | The picture-directed total, and the net that proves it | done | `bf412d324` |
| #step-10 | Regenerate the golden table | done | `e64a6f9f0` |
| #step-11 | Real-deck coverage, integration, and an observed vetting pass | done (the [P15] live pass is the owner's, still open) | `9cfdfbfb3` |

---

#### Step 8: Two floors in the registry and the Gazette's measure {#step-8}

**Commit:** `tugdeck(imposer): give a rail a comfort floor beneath its preference and above its hard floor`

**References:** [P11] Two floors, [Q04] Gazette hard floor, [Q06] other comfort floors, Spec S06, (#phase-2-root-causes)

**Artifacts:**
- `comfortWidth?` on `CardRegistration`, `getComfortWidth()` in `tugdeck/src/card-registry.ts`.
- `MIN_GAZETTE_WIDTH_PX = 400` and `COMFORT_GAZETTE_WIDTH_PX = 512` in `tugdeck/src/lib/gazette-measure.ts`; the Gazette registers both (`sizePolicy.min.width` = hard, `comfortWidth` = comfort) in `gazette-card-registration.tsx`.
- `RailPolicy.comfortWidth` in `layout-imposer.ts`; `_sidebarRails` max-folds it in `deck-manager.ts`; `chainOf` validates its finiteness.

**Tasks:**
- [ ] Add the field, accessor and fold with doc comments stating the two-floor semantics: the hard floor is where the card stops being paintable *and* is what the user's resize drag clamps to (`tug-pane.tsx`); the comfort floor is what the allocator respects unless surrendering it removes overlap.
- [ ] Split the Gazette's floor. Keep the 56ch derivation intact and rename its result to `COMFORT_GAZETTE_WIDTH_PX`; author `MIN_GAZETTE_WIDTH_PX = 400` beside it with a comment recording that at the landed `GAZETTE_BODY_CH_PX = 8.4` / `GAZETTE_ROW_CHROME_PX = 42` that is a measure of roughly 42 characters.
- [ ] **Keep this step behavior-neutral in the solver:** `allocateSidebarWidths` continues to use a single effective floor of `max(minWidth, comfortWidth)`, so the answer is byte-identical to `931665ecc` and the golden table does not move. The relaxation is Step 9's. **Scope the neutrality claim honestly:** lowering the Gazette's `sizePolicy.min.width` to 400 changes the user-facing drag floor in *this* step (`tug-pane.tsx` clamps the resize commit to it) — that is intended ([Q04], Risk R04) and the commit body says so, rather than claiming full neutrality.
- [ ] Update at0365's measure pin: it asserts the *derived width formula*, which now produces `COMFORT_GAZETTE_WIDTH_PX`. Keep the formula assertion pointed at the comfort constant.

**Tests:**
- [ ] Unit: `getComfortWidth` returns the registered value, and falls back to `getSizePolicy(id).min.width` for a card that registers none and for an unregistered id.
- [ ] Unit: the `_sidebarRails` fold shape — a stacked rail takes the **largest** comfort width among its members, beside the existing preferred/min max-folds and the greed min-fold.
- [ ] Unit: `comfortWidth: NaN` returns `null` from the allocator, at the same guard as the other numbers.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test src` — and the golden table is **unchanged**, which is this step's proof of neutrality.
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test at0365-gazette-card.test.ts`

---

#### Step 9: The picture-directed total, and the net that proves it {#step-9}

**Depends on:** #step-8

**Commit:** `tugdeck(imposer): choose the rail total by the picture it paints, not by a least-squares fit`

**References:** [P10] Picture-directed total, [P11] Two floors, [P12] Two-tier drain, [P13] Scan strategy, [P14] Net first, [Q05] Shortfall, Spec S04, Spec S05, Spec S06, List L03, (#phase-2-evidence, #phase-2-net-postmortem, #phase-2-prototype)

**Artifacts:**
- `seamPicture` gains `worstShortfall` and returns to the decision path in `tugdeck/src/lib/layout-imposer.ts`.
- Total selection rewritten per Spec S04; deficit distribution rewritten per Spec S05; `allocateSidebarWidths`'s doc comment rewritten to state the new objective and the comfort rule.
- List L03 invariants added to `tugdeck/src/lib/__tests__/layout-imposer-solutions.test.ts`; new regime cases in `layout-imposer.test.ts`.

**Tasks:**
- [ ] **First, prove the net has teeth.** Write List L03 items 1–3 and run them against the current solver. They must FAIL. Record the observed failure (which configurations, what overlap was left on the table) in the dash-round summary — this is the artifact Phase 1 never produced ([P14]). Do not implement until they have been seen to fail.
- [ ] Add `worstShortfall` to `seamPicture` and un-demote it: its doc comment currently says it is "a measurement, never a decision", which becomes wrong. State instead that it is the objective the total is chosen against, and that it reads `imposeRect`'s real clamped geometry rather than the linear model — which is precisely why it is the right thing to score.
- [ ] Implement Spec S04: the two domains, the lexicographic key, the coarse-to-fine scan with its named stride constant, and the comfort rule. Keep the no-chain early return.
- [ ] Implement Spec S05's two-tier deficit drain; leave the surplus branch and the tie-splitting exactly as they are.
- [ ] Port the #phase-2-prototype table as one named unit test — canvases 1400 / 2000 / 3000 / 3200 / 3400 with their expected totals, comfort-spent flags, overlaps and errors — so the plan and the suite share an oracle, exactly as Phase 1's worked example does.
- [ ] Add the specific repair case as its own test: the Table T04 fixture at canvas 3200 answers `{ left: 320, right: 450 }` with zero overlap and zero seam error.
- [ ] Add the anti-flatness test (List L03 item 4, both granularities) and the exhaustive cross-check (item 5).
- [ ] Implement List L03 items 1–3 with the monotone oracle, not a scan (the oracle note): one `seamPicture` evaluation at `Σ hardFloor` answers "was zero overlap reachable", one at `Σ comfortFloor` answers it for the comfort domain.
- [ ] Restate the sweep's canvas-monotonicity assertion per [P16]: recompute the comfort-rule branch per canvas from the same two oracle evaluations and assert non-decreasing widths only within a run of one branch — nothing at a crossing.
- [ ] Add the dragged-below-comfort fixture (Gazette preferred 450, below its 512 comfort) to the enumeration fixtures and assert List L03 item 7 on it.
- [ ] Re-check Phase 1's `layout-imposer.test.ts` cases against the new objective and update the ones whose expected numbers legitimately move; each change gets a comment saying why the new number is right. Do not "fix" a test by loosening an assertion.

**Tests:**
- [ ] The rewritten allocator suite and the extended solutions sweep, both green.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/layout-imposer.test.ts src/lib/__tests__/layout-imposer-solutions.test.ts`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] The solutions sweep still completes in under ~5s ([P13] / #phase-2-constraints).
- [ ] The golden comparison is expected to FAIL here — that failure is the repair, and Step 10 records it. Note the failure; do not regenerate in this commit.

---

#### Step 10: Regenerate the golden table {#step-10}

**Depends on:** #step-9

**Commit:** `tugdeck(imposer): regenerate the solution golden after the picture-directed repair`

**References:** [P14] Net first, [P09] Golden table, (#phase-2-evidence)

**Artifacts:**
- `tugdeck/src/lib/__tests__/golden/imposer-solutions.json` regenerated.

**Tasks:**
- [ ] Regenerate: `cd tugdeck && IMPOSER_GOLDEN_UPDATE=1 bun test ./src/lib/__tests__/layout-imposer-solutions.test.ts`.
- [ ] **Read the diff before committing it.** Summarise it in the commit body: how many rows moved, in which direction (rails narrower on crowded decks, unchanged on roomy ones), and confirm no row moved in a direction the repair does not explain. A golden regeneration nobody read is a rubber stamp.

**Tests:**
- [ ] The golden comparison, green again.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src` fully green.

---

#### Step 11: Real-deck coverage, integration, and an observed vetting pass {#step-11}

**Depends on:** #step-9, #step-10

**Commit:** `tests(at0303): cover the crowded deck and the hand-dragged Gazette floor`

**References:** [P15] Observed close, [P11] Two floors, [P08] Moments unchanged, Table T05, (#phase-2-success-criteria)

**Artifacts:**
- at0303 gains a crowded-deck case and a drag-floor case; any fixture in the selected app-tests that baked in Phase 1 behavior is repinned with a comment saying why.

**Tasks:**
- [ ] Add to `tests/app-test/at0303-imposer-space-allocator.test.ts`: seed a deck whose chain overlaps at the comfort floors but tiles below them (the Table T04 shape — compute the card widths from the measured canvas, since **the harness cannot resize the window**; see Phase 1's #step-6 note), re-assert the layout, and assert on real pane rects that **no two chain panes overlap** and the Gazette stands below its comfort width.
- [ ] Add a drag case: with the Gazette open, drive a real edge-resize drag below 512 and assert the pane lands at or near `MIN_GAZETTE_WIDTH_PX`, proving the Phase 1 trap is gone. (If the harness cannot drive that edge reliably, assert the same claim at the store layer through `getSizePolicy("gazette").min.width` and say so in the test's docblock.)
- [ ] Re-run the app-tests the diff derives. Note that Phase 1's selection exceeded the 20-file budget in one go and had to be run in scoped batches — expect the same, and name the batches in the commit body. `at0294-imposer-flip-settle.test.ts` is the fixture most likely to need attention again: it pins its Lens at the 675 ceiling specifically so the allocator's answer equals its standing width, and that assumption must be re-checked under the new chooser.
- [ ] Grep-verify no stale vocabulary survives: `grep -rn "least-squares\|graded" tugdeck/src/lib/layout-imposer.ts` should describe only `solveSidebarWidths`'s own closed form, never the allocator's decision.
- [ ] **Observe it.** `just app-debug` from the worktree, open Gazette and Lens, and *drag the window edge across a wide range*. Record in the commit body: whether rail widths track the canvas continuously, whether any card pair overlaps at any width where the rails had room left, and whether the seams read as the standard gap. Attach the observed numbers, not an impression ([P15]).

**Tests:**
- [ ] at0303, plus the derived app-test selection in scoped batches.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test at0303-imposer-space-allocator.test.ts at0294-imposer-flip-settle.test.ts at0365-gazette-card.test.ts`
- [ ] The written observation from the live deck, in the commit body.

---

### Phase 2 Deliverables {#phase-2-deliverables}

**Deliverable:** A space allocator that chooses the rails' total by the picture it actually paints, gives up the Gazette's comfortable measure precisely when that removes overlap, and is pinned by invariants stated against what was achievable rather than against what the algorithm attempted.

#### Phase 2 Exit Criteria ("Done means…") {#phase-2-exit-criteria}

- [x] Every #phase-2-success-criteria item verified by its named mechanism.
- [x] List L03 items 1–3 were observed FAILING against `931665ecc` before the fix, and pass after ([P14]). Observed failure: `two-up/3:slim/gazette-right@1769` left 108px of occlusion where a reachable total removes it; over the enumeration, 254 of 5990 repairable points were left overlapped, the worst by 190px.
- [x] Phase 2 Step Status Ledger fully `done` with commit hashes recorded.
- [x] The golden diff was read and summarised by a human-readable commit body, not merely regenerated. All 488 old sampled points answer identically; the churn is the new dragged-below-comfort fixture (76 rows) plus 25 configurations whose breakpoint canvases moved 112px with the floor they are derived from.
- [ ] **Observed on a live deck** ([P15]): Gazette + Lens open, window dragged across a wide range — the rails track the canvas, no avoidable overlap appears at any width, and the seams read as the imposition gap. Reported with numbers. *(Open — the owner's pass. The debug instance `debug-tugdash-solve-layout-imposer-p2` is built and running; driving it from the implementer's side means activating a background window and taking the owner's screen.)*

#### Phase 2 Roadmap / Follow-ons {#phase-2-roadmap}

- [ ] Comfort floors for the Lens and Jots if either is ever reported as cramped ([Q06]).
- [ ] A global design-decision entry for the two-floor doctrine and picture-directed selection in `tuglaws/design-decisions.md` — this is now a rule with scars, and worth writing down (user lands tuglaws edits).
- [ ] Revisit whether `solveSidebarWidths` still earns its keep once the scan is the answer, or whether it should be demoted to the breakpoint arithmetic the tests use.

| Checkpoint | Verification |
|------------|--------------|
| The repair itself | the Table T04 case: canvas 3200 → 320/450, zero overlap |
| No avoidable overlap or crowding | List L03 items 1–3 over the full enumeration |
| Resize is visibly alive | List L03 item 4 (≥ 5 across the coarse sweep; ≥ 15 across the 10px tracking band) |
| A drag below comfort is honored | List L03 item 7 on the Gazette-450 fixture |
| Search correctness | List L03 item 5 (scan vs exhaustive) |
| Behavior drift | golden JSON diff, read and summarised (#step-10) |
| It is actually good | the observed live-deck pass ([P15]) |

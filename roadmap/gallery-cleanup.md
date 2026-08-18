<!-- plan authored against devise-skeleton v5 -->

## Gallery Cleanup: Three Kinds of Card, Three Homes {#gallery-cleanup}

**Purpose:** Return the Component Gallery to its only intended job — exemplary demos of established `Tug*` components — by moving app-test fixtures into a dedicated `fixtures/` annex and design spikes into a new `spikes/` sandbox that has its own registry, its own layout CSS, its own door onto the deck, and a `/tugplug:spike-card` skill that makes a new spike a two-minute act.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-18 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-18, Opus.** Reviewed `plan:2896ac3c4fe17a02`. Lint: 0 errors, 0 warnings on the first pass; nothing mechanical to fix. Oriented on the plan as authored plus the tree it targets, reading `tug-pane.tsx`, `card-host.tsx`, `use-responder.tsx`, `deck-manager.ts`, `tug-list-row.tsx`, and every moving card's import block.
Applied: **(technical choices)** verified the plan's one load-bearing assumption rather than asserting it — `.tug-pane-content` is an empty ref'd div, so a card is *not* a React child of the pane's `ResponderScope`, and `add-tab` would not reach `TugPane` were it not for `CardHost` registering with an explicit `parentId: hostStackId`. [P04] and [Spec S02](#s02-spike-home) now cite that mechanism and [#dispatch-from-card-content](#dispatch-from-card-content) records it, since it is the plan's single most re-derivable fact. Also confirmed `showSingletonCard` creates-then-raises, which is what makes [Step 3](#step-3)'s second-invocation checkpoint meaningful. **(holes)** Found the one gap that would have bitten during implementation: three moving spikes import shipping session modules by relative sibling path (`./blocks/bash-tool-block`, `./session-commit-receipt-block`, `./session-changes/…`), all of which break on relocation; added [#sibling-imports](#sibling-imports) with the exact list and a task in each of [Step 4](#step-4) and [Step 5](#step-5). Confirmed the reverse direction is clean — nothing but `gallery-registrations.tsx` imports a moving file. Added the deleted-spike-drops-a-pane note to [Step 8](#step-8), answering "what does the user come back to". **(test plan)** Softened [Spec S03](#s03-taxonomy-drift-test)'s assertion 5: hard counts stay for the two closed sets but the `gallery-*` count was dropped, because taxing every legitimate new demo with a test edit produces a number that gets bumped rather than read; the gallery's count is now a one-time grep at exit. **(laws)** Added [#law-cross-check](#law-cross-check) naming [L01], [L02], [L03], [L06], [L09], [L11], [L16], [L19], [L20], [L25] individually against the design. **(precision)** [Spec S02](#s02-spike-home) now names `TugListRow`'s real `title` / `subtitle` two-line API instead of an invented row shape.
Deferred: [Q01](#q01-prod-bundle) — whether the gallery, spikes, and fixtures should ship in the production bundle — stays open by design; it is a whole-gallery question that fixtures cannot answer alone, since app-tests run the production bundle.

---

### Phase Overview {#phase-overview}

#### Context {#context}

`tugdeck/src/components/tugways/cards/gallery-registrations.tsx` is a single 1670-line file registering **89** card types, every one of them `family: "maker"`, all reachable through one debug-build Maker menu item (⌥⌘G). A census of all 89 (see [Card Census](#card-census)) finds three different kinds of thing wearing the same `gallery-` prefix:

- **69 exemplary component demos** — the `TugBadge` role/size/emphasis matrix, `TugSheet`'s compound and imperative modes, the `TugListView` cell-kind showcase. This is what the gallery was built for, and it is healthy.
- **5 app-test fixtures** — cards whose only consumer is the test harness. Four are `hidden: true` so no human can browse them; `gallery-markdown-50kb` exists solely to give the scroll-persistence suite a fixed 50KB body. The gallery was never intended as a fixture warehouse.
- **15 design spikes and instruments** — exploratory surfaces (`gallery-slot-layout`, self-described as "a spike, not a component demo"), spikes that closed into visual references (`gallery-card-chrome`, `gallery-changes-dashes`), and permanent dev instruments (`gallery-theme-editor`, `gallery-motion-bench`, self-described as "an instrument, not a showcase").

The cost is not just taxonomy. A spike today can only be born by editing the 1670-line registration file, inventing a `CATEGORIES` bucket it does not belong in, and borrowing `gallery.css`'s `cg-*` vocabulary — which makes the cheapest possible act (try a layout idea on the deck) expensive enough to discourage. Meanwhile the `+` type-picker menu, whose purpose is to let a human browse the component library, is padded with diagnostics and fixtures.

Two calls that shape this plan were made by the user and are settled: **the four instruments stay in the gallery** as bucket-1 citizens ([P08]), and **the four closed-spike references move to spikes** ([P07]).

#### Strategy {#strategy}

- **Fix the load-bearing coupling first.** `.tug-petals` — the spinner styling for the *shipping* `TugButton` — currently lives in `gallery.css`. Hoist it into `internal/tug-button.css` before touching anything else, so no later step can leave a production component styled by a demo stylesheet ([P01]).
- **Build the new homes before moving anything in**, so every move step is a pure relocation with a green checkpoint.
- **One commit per bucket, copy-register-delete inside a single commit.** `registerCard` silently overwrites a duplicate componentId rather than failing ([Duplicate registration](#duplicate-registration-hazard)), so a split done across two commits can pass tests while double-registering.
- **Registration and its two test call-sites move together, always.** An unregistered componentId is silently dropped from restored deck layouts by `filterDeckStateByRegistration`, taking its pane with it — so `main.tsx` and `cards-groups.test.ts`'s `beforeAll` are edited in the same commit as every new register function.
- **Reuse the deck plumbing that already exists.** The spike host needs no new action, no new `deck-canvas` handler: the existing `show-card` action opens a card by componentId, and the existing `add-tab` action already routes through `TugPane`'s responder to `addCardToPane` ([P04]).
- **Rename the ids.** `spike-*` and `fixture-*` prefixes make the kind self-evident at every seed site and let a drift test enforce the taxonomy ([P02]).
- **Close with the skill**, so the structure is proven by the moves before it is documented as a recipe.

#### Success Criteria (Measurable) {#success-criteria}

- `grep -c 'registerCard({' tugdeck/src/components/tugways/cards/gallery-registrations.tsx` returns **73** (89 − 11 spikes − 5 fixtures), and every remaining registration is an exemplary demo or an instrument.
- No registration in `gallery-registrations.tsx` carries `hidden: true` — verified by a drift test ([Spec S03](#s03-taxonomy-drift-test)). The gallery is browsable in its entirety.
- Every `fixture-*` registration carries `hidden: true` and `family: "fixture"`; every `spike-*` registration carries `family: "spike"` — same drift test.
- `grep -rn 'cg-' tugdeck/src/spikes tugdeck/src/fixtures` returns nothing: the new structures borrow no gallery CSS.
- `grep -rn 'tug-petals' tugdeck/src/components/tugways/cards/gallery.css` returns nothing.
- Opening Maker ▸ New Spikes Card lists all 11 spikes; activating a row mounts that spike as a tab in the same pane.
- `cd tugdeck && bun run test && bunx vite build` exits 0; `just app-test-changed` is green for the 10 affected app-test files.
- A new spike costs one new file plus two lines in `spike-registry.ts` — demonstrated by [Step 8](#step-8) creating one end-to-end via the skill.

#### Scope {#scope}

1. Hoist `.tug-petals` from `gallery.css` into `internal/tug-button.css`.
2. New `tugdeck/src/spikes/` substructure: `spike-registry.ts`, `spike-home.tsx`/`.css`, `spike.css`, `README.md`; registered in `main.tsx`; opened by a debug-gated Maker menu item.
3. Move 11 spike cards (7 live + 4 closed references) out of the gallery into `spikes/`, renaming ids `gallery-*` → `spike-*`.
4. New `tugdeck/src/fixtures/` substructure: `fixture-registrations.tsx`, `fixture.css`; move 5 fixture registrations, renaming ids `gallery-*` → `fixture-*`; update the 10 app-test files that seed them.
5. Gallery residuals: unhide the two hidden showcases, repair the two registration unit tests, add the taxonomy drift test.
6. New `/tugplug:spike-card` skill plus the `plugin.json` keyword/version bump.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Re-categorizing the instruments.** The user's call was a bucket call: the four instruments stay in the gallery. `gallery-motion-bench` sitting under "Feedback & Status" is a genuine miscategorization, but introducing an `Instruments` `CATEGORIES` entry is a separate cosmetic change ([P08], follow-on in [#roadmap](#roadmap)).
- **Excluding spikes or fixtures from the production bundle.** The gallery ships in `dist/` today; app-tests run the production bundle, so fixtures *must* ship. Deferred as [Q01](#q01-prod-bundle).
- **Any change to the 69 exemplary demos**, their ids, their content, or the `CATEGORIES` taxonomy they use.
- **Deleting `gallery.css`'s demo-specific blocks.** `.tug-pole` is used only by `gallery-scale-timing` (an instrument that stays), so it legitimately remains.
- **Renaming the `show-component-gallery` action** or changing the ⌥⌘G entry point.
- **Retrofitting existing spikes into the skill's skeleton.** Moved spikes keep their current internals; only their location, id, and shared-class names change.

#### Dependencies / Prerequisites {#dependencies}

- A debug Swift build to see the new Maker menu item (`BuildInfo.profile == "debug"` gate) and Maker mode enabled.
- `tugplug` skills load from the **app bundle**, not the repo — the new skill is invocable only after `just build-app`, or immediately with `TUG_PLUGIN_DIR` pointed at the source tree.
- Working tree clean at start. Verified at authoring time: `git status --porcelain` empty at `9437c1605`.

#### Constraints {#constraints}

- **Warnings are errors** in the Rust workspace; this plan touches no Rust, but `bun run test` and `bunx vite build` must both exit 0 per step.
- Tugdeck changes are live via Vite HMR, but the debug app loads the production rollup bundle — `bunx vite build` before declaring a tugdeck change done.
- Swift changes require `just build-app`; app-tests never rebuild the binary.
- App-tests are selective: `just app-test-changed`, derived from `@covers`. Never the full corpus.
- `componentId` strings are the app-test contract — 71 test files seed `gallery-*` ids. Only the 10 files touching the 6 renamed ids may change.
- [L06] appearance through CSS/DOM; [L02] external state through `useSyncExternalStore`; [L11] controls emit actions, responders own state. The spike host obeys all three.

#### Assumptions {#assumptions}

- `spike-*` and `fixture-*` registrations declaring no `lensGroup` resolve to `"tools"` via `resolveLensGroup`'s fallback, keeping the totality test green and `excluded === ["lens"]` true.
- A pane opened by `show-card` for `spike-home` starts single-card; its `+` picker therefore offers only the `"standard"` family until a second card lands. The index card's own rows are the bootstrap out of that state ([P04]).
- Moving a card's registration invalidates any saved deck pane holding it: users lose those panes on next restore with a console warning. Acceptable for spikes and fixtures.
- The four prop-variant fixture registrations reference gallery components (`GalleryListView`, `GalleryMarkdownView`) that stay in the gallery; `fixtures/` importing from `cards/` is the intended direction ([P03]).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton v5 conventions: explicit `{#anchor}` on every cited heading, `[P##]` for plan-local decisions, `[Q##]` for open questions, `S##` specs, `T##` tables, `R##` risks, `**Depends on:**` lines with `#step-N` anchors, and `**References:**` lines citing labels and anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Should spikes and fixtures ship in the production bundle? (DEFERRED) {#q01-prod-bundle}

**Question:** `registerGalleryCards()` is called unconditionally in `main.tsx`, and `dist/assets/index-*.js` contains `"gallery-buttons"` — the entire gallery ships to production users, gated only at the *menu*. Should `registerSpikeCards()` / `registerFixtureCards()` inherit that, or be dev-gated?

**Why it matters:** Bundle size and the principle that exploratory code should not ship. But the gate is not free: app-tests run against the production bundle (`reference_apptest_serves_prod_bundle`), so **fixtures cannot be dev-gated at all** without breaking 10 test files. And a conditionally-registered card whose pane is in a saved layout gets silently dropped by `filterDeckStateByRegistration` on the builds where it is absent.

**Options:**
- Ship both, matching today's gallery behavior (chosen for this phase).
- Dev-gate spikes only, leaving fixtures unconditional — asymmetric, and risks the layout-drop behavior above.
- Dev-gate both and teach the app-test harness to serve a dev bundle — a much larger change to the harness contract.

**Plan to resolve:** Revisit as its own phase if bundle size becomes a real signal, measured against `dist/` before and after. It is a whole-gallery question, not a spikes question — the 69 exemplary demos dominate the payload either way, so solving it for spikes alone buys almost nothing.

**Resolution:** DEFERRED — this phase registers both unconditionally, exactly as the gallery does today. Recorded as a follow-on in [#roadmap](#roadmap).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Silent double registration during a move | med | med | Copy-register-delete inside one commit; drift test asserts the moved id is absent from the gallery | A `[card-registry] Duplicate registration` warning in the console |
| A moved card's pane vanishes from a saved layout | low | high (by design) | Expected for spikes/fixtures; `main.tsx` + test `beforeAll` edited in the same commit as each move | A *gallery* card disappears — that is a bug, not the design |
| Renamed fixture id missed at a seed site | med | med | `grep -rn 'gallery-markdown-50kb' tests/` returns empty as a checkpoint; `just app-test-changed` on the 10 files | An app-test fails with a "no registration found" console warning |
| `.tug-petals` hoist breaks the button spinner | high | low | `tug-button.css` is imported by `tug-button.tsx` directly, so it loads wherever the button does; verify the pending-state spinner visually | The spinner renders unstyled in any theme |
| Spike host `+` picker appears empty | low | med | Bootstrap is the index card's rows, not the picker ([P04]); documented in `spikes/README.md` | A user reports being unable to reach a second spike |

**Risk R01: The load-bearing gallery stylesheet** {#r01-load-bearing-css}

- **Risk:** `gallery.css` defines `.tug-petals`, consumed by `internal/tug-button.tsx` — a shipping component. Any future move that stops a production path from importing `gallery.css` silently removes the button's spinner styling.
- **Mitigation:**
  - Hoist `.tug-petals` and its three `@keyframes` into `internal/tug-button.css` in [Step 1](#step-1), before any card moves.
  - Leave `.tug-pole` in `gallery.css`: its only consumer is `gallery-scale-timing`, an instrument that stays.
- **Residual risk:** `gallery.css` still holds demo-specific blocks for cards that stay; that is correct, not debt.

**Risk R02: The taxonomy re-drifts** {#r02-taxonomy-redrift}

- **Risk:** Nothing stops the next fixture or spike from being born in `gallery-registrations.tsx` again — which is exactly how the current state arose.
- **Mitigation:** [Spec S03](#s03-taxonomy-drift-test) is a unit test, not a convention: no `gallery-*` may be `hidden`, every `fixture-*` must be, and families are pinned per prefix. A fixture added to the gallery fails the suite.
- **Residual risk:** A spike added to the gallery with no `hidden` flag and a plausible category still passes. The skill is the mitigation for that, and `spikes/README.md` is where the rule is written down.

---

### Design Decisions {#design-decisions}

#### [P01] `.tug-petals` belongs to the button, not the gallery (DECIDED) {#p01-petals-hoist}

**Decision:** Move `.tug-petals`, `.tug-petals .petal`, and the `tug-petals-fade` / `tug-petals-scale` / `tug-petals-rotate` keyframes out of `gallery.css` into `components/tugways/internal/tug-button.css`. Leave `.tug-pole` / `.tug-pole-inner` in `gallery.css`.

**Rationale:**
- `internal/tug-button.tsx` renders `<span className="tug-petals">` for its pending state. A shipping component's styling must not be reachable only through a demo stylesheet.
- `tug-button.css` is imported by `tug-button.tsx` directly, so it is present wherever the class is used — including in `gallery-scale-timing`, which also renders `.tug-petals` and will keep working unchanged.
- `.tug-pole` has exactly one consumer, `gallery-scale-timing`, which stays in the gallery. Moving it would invent a home for a demo-only style.

**Implications:**
- A prerequisite step with no dependency on the rest of the plan, landable and verifiable alone.
- `gallery.css`'s `@tug-pairings` header table loses its `.tug-petals` rows and `tug-button.css` gains them.

#### [P02] The prefix is the taxonomy: `spike-*`, `fixture-*`, `gallery-*` (DECIDED) {#p02-prefix-taxonomy}

**Decision:** Renamed componentIds carry their kind: `gallery-slot-layout` → `spike-slot-layout`, `gallery-markdown-50kb` → `fixture-markdown-50kb`. File names follow (`spike-slot-layout.tsx`, and `fixture-*` where a file moves).

**Rationale:**
- The id appears at every seed site in every app-test. `seedDeckState({cards:[{componentId:"fixture-markdown-50kb"}]})` says what it is; `gallery-markdown-50kb` actively misleads.
- A prefix is machine-checkable, so the taxonomy can be enforced by [Spec S03](#s03-taxonomy-drift-test) instead of by reviewer attention.
- The blast radius is small and known: 10 app-test files, one `@covers` line, two unit-test files.

**Implications:**
- `cards-groups.test.ts`'s `"every gallery card lands in tools"` test filters on `componentId.startsWith("gallery-")` and would silently stop covering the renamed cards; it is broadened to all three prefixes in [Step 7](#step-7).
- The `scrollKey="gallery-list-view-scroll"` string in the scroll-keyed fixture renames alongside its id, for coherence; it is a persistence key for a fixture, so invalidating it costs nothing.

#### [P03] Fixtures may import gallery components; the gallery never imports fixtures (DECIDED) {#p03-import-direction}

**Decision:** `fixtures/fixture-registrations.tsx` imports `GalleryListView` and `GalleryMarkdownView` from `components/tugways/cards/` to register their prop-variants. No file under `components/tugways/cards/` may import from `fixtures/` or `spikes/`.

**Rationale:**
- Three of the five fixtures (`fixture-list-view-scroll-keyed`, `fixture-markdown-1kb`, `fixture-markdown-50kb`) are not new components at all — they are prop-variant registrations of exemplary gallery components. Moving the *component* would drag a showcase out of the gallery; moving only the *registration* is the correct, minimal act.
- A one-way dependency keeps the gallery independently deletable-from and keeps `bunx vite build`'s module graph acyclic.

**Implications:**
- Only two fixture `.tsx` files actually move: `gallery-cycle-demo.tsx` and `gallery-transcript-copy.tsx`. The other three are registration-only moves.
- `GalleryListView`'s `scrollKey` / `inline` / `disableStreaming` props and `GalleryMarkdownView`'s `staticContentSize` prop exist to serve these fixtures and stay as they are.

#### [P04] The spike host reuses `show-card` and `add-tab`; no new deck plumbing (DECIDED) {#p04-reuse-plumbing}

**Decision:** A debug-gated Maker menu item sends the existing `show-card` action with `component: "spike-home"`, and `"spike-home"` joins `SINGLETON_CARDS` in `action-dispatch.ts`. The index card's rows dispatch the existing `add-tab` action with `value: <componentId>` through the responder chain.

**Rationale:**
- `show-component-gallery` needed its own action only because it hardcodes `"gallery-buttons"` and re-derives an existing stack. `show-card` already does "open a card by componentId", and `newHelloWorldCard` in `AppDelegate.swift` is the exact precedent: `sendControl("show-card", params: ["component": "hello"])`.
- `add-tab` is already handled by `TugPane`'s responder, which calls `store.addCardToPane(paneId, componentId)`. A control that emits an action and lets the pane own the mutation is [L11] by construction — and it means the index card never needs to know its own paneId.
- The dispatch genuinely reaches the pane from inside card content, which is not obvious from the DOM: `.tug-pane-content` is an empty ref'd div that card content is mounted into, so the card is not a React child of the pane's `ResponderScope`. `CardHost` closes that gap by registering with an explicit `parentId: hostStackId` ([#dispatch-from-card-content](#dispatch-from-card-content)). Verified in the tree before adopting this design, not assumed.
- Singleton semantics are right for an index: a second Spikes home is never useful.
- Net new deck-side code: two lines. No `deck-canvas` handler, no `command-registry` entry, no new action vocabulary term.

**Implications:**
- `addCardToPane` does not consult family filtering, so the index card can mount any spike even while the pane's `+` picker is still offering only `"standard"` — which is what solves the single-card bootstrap.
- Once the index card has added one spike, the pane is multi-card and its `+` picker lists every `family: "spike"` registration, grouped under one category. Two ways in, one of them free.

#### [P05] A spike is one file plus two lines, listed explicitly (DECIDED) {#p05-two-line-registration}

**Decision:** Each spike file exports `export const spike: SpikeDef`. `spike-registry.ts` holds an explicit `SPIKES` array; adding a spike is one `import` and one array entry. `registerSpikeCards()` loops the array calling `registerCard` with a shared default size policy, `family: "spike"`, `acceptsFamilies: ["spike"]`, `closable: true`.

**Rationale:**
- The declarative `SpikeDef` means a spike author writes no `registerCard` call, invents no category, and picks no size policy — the three things that make adding a gallery card a chore.
- Vite's `import.meta.glob` would make discovery zero-touch, but the registry-walking unit tests run under `bun test`, which does not implement that transform. An explicit list is the version that works in both runtimes, and two lines is already cheap enough.
- The index card renders from the same `SPIKES` array, so a new spike appears on the deck with no second edit.

**Implications:**
- `SpikeDef` needs a `blurb` field: the index card's whole value over a bare `+` menu is that each row says what the spike explores.
- One shared `SPIKE_SIZE` policy replaces the gallery's four hand-picked ones. `spike-modal-headers`, whose current policy is a bespoke `800×940`, keeps a per-spike `size` override — hence `size?` on `SpikeDef`.

#### [P06] Spikes get their own layout vocabulary, `sp-*` (DECIDED) {#p06-own-css-vocabulary}

**Decision:** `spikes/spike.css` defines `.sp-content`, `.sp-section`, `.sp-section-title`. `fixtures/fixture.css` defines `.fx-content`, `.fx-section`, `.fx-section-title`, `.fx-variant-row`. Moved files rename their `cg-*` usages of exactly those classes; every other `cg-*` class they use travels with them in their own sibling `.css`.

**Rationale:**
- This is the "detach from the borrowed gallery infrastructure" the cleanup exists to achieve. A spike that still imports `gallery.css` is still a gallery card.
- The audit shows the borrowing is tiny: across all 13 moving `.tsx` files, the only shared classes used are `cg-content`, `cg-section`, `cg-section-title`, and `cg-variant-row` (the last only by `gallery-cycle-demo`). Every card-specific family — `cg-mh-*`, `cg-configure-tug-*`, `cg-spike-*`, `cg-focus-language` — is already defined in that card's own sibling `.css` and needs no change at all.
- Three moved cards import `gallery.css` explicitly (`modal-headers`, `focus-language`, `cycle-demo`); the rest rely on the ambient import from `gallery-registrations.tsx` and would render unstyled after a move without this step. Giving the new homes their own stylesheet makes that failure impossible rather than merely fixed.

**Implications:**
- `.sp-*` and `.fx-*` are copies of three small rules, not an abstraction shared with `gallery.css`. Divergence later is fine and expected — spikes are allowed to look different.
- `grep -rn 'cg-' tugdeck/src/spikes tugdeck/src/fixtures` returning empty is a success criterion.

#### [P07] Closed-spike references move to `spikes/` (DECIDED — user's call) {#p07-closed-refs-to-spikes}

**Decision:** `gallery-card-chrome`, `gallery-changes-dashes`, `gallery-modal-headers`, and `gallery-focus-language` move to `spikes/`, becoming `spike-card-chrome`, `spike-changes-dashes`, `spike-modal-headers`, `spike-focus-language`.

**Rationale:**
- The user's explicit call for this gray zone.
- All four self-describe as spike-origin: `gallery-card-chrome` "began as a proposal, now the reference"; `gallery-changes-dashes` "began as two design spikes and is now the reference"; `gallery-focus-language` calls itself "a permanent gallery card" for the focus visual language; `gallery-modal-headers` is a convention-versus-shipped comparison.
- None is a `Tug*` component API showcase, which is the gallery's only membership test.
- The durable content of a settled spike belongs in `tuglaws/`, not in a card docblock. Housing them in `spikes/` keeps the graduation path visible instead of freezing them as permanent gallery furniture.

**Implications:**
- `spike-focus-language` keeps its `kbfAtRest: true` — its subject *is* the engine's focus stops, so it must read with rings on at rest. `SpikeDef` therefore needs a `kbfAtRest?` passthrough.
- `spike-changes-dashes` is under active iteration (three commits landed on it through `9437c1605`). It moves in its own commit, separate from the live spikes, so the rename diff stays legible against that work.
- `gallery-registrations.test.ts` pins `gallery-pinned-headers` in its `EXTENDED_CARDS` list; that pin is removed when the card moves ([Step 5](#step-5)).

#### [P08] The four instruments stay in the gallery, uncategorized-as-is (DECIDED — user's call) {#p08-instruments-stay}

**Decision:** `gallery-theme-editor`, `gallery-scale-timing`, `gallery-theme-accessibility`, and `gallery-motion-bench` remain registered in `gallery-registrations.tsx` under their current categories, unchanged.

**Rationale:**
- The user's explicit call: instruments are bucket 1.
- The call was about *which bucket*, and re-categorizing is a different change. Introducing an `Instruments` `CATEGORIES` entry would touch four registrations for purely cosmetic gain and widen a cleanup that is otherwise precisely scoped.
- Leaving them put also keeps `gallery-scale-timing`'s `.tug-petals` / `.tug-pole` usage in the same module as the stylesheet that still defines `.tug-pole`, which is what makes [P01] a two-class change instead of a four-class one.

**Implications:**
- `gallery-motion-bench` stays filed under "Feedback & Status", which it does not really belong to. Recorded as a follow-on in [#roadmap](#roadmap), not fixed here.
- The gallery's final count is 73, of which 4 are instruments and 69 are component demos.

#### [P09] The two hidden showcases are unhidden, not deleted (DECIDED) {#p09-unhide-showcases}

**Decision:** `gallery-list-view-filter` and `gallery-list-view-headers` drop their `hidden: true` and stay in the gallery under "Data Views".

**Rationale:**
- They are the only two `hidden` registrations that **no app-test seeds** — hidden *and* unread, so today they serve nobody. That makes them the one place in this cleanup where the answer is genuinely either "expose" or "delete".
- Their docblocks describe component API: `gallery-list-view-filter` is "a visual showcase + living contract for `TugFilterField`", and it is the only browsable demo of that component. Deleting it destroys documentation of a real shipping component's contract; the unchecked-registry principle argues for deleting things nothing reads, but the fix here is to make them read.
- Unhiding is also what the new drift test requires: no `gallery-*` registration may be `hidden`, because a hidden demo is a contradiction in terms.

**Implications:**
- The `+` picker's "Data Views" section gains two entries.
- If the user would rather delete them, that is a two-line change to this step and the drift test still passes.

---

### Deep Dives {#deep-dives}

#### The card census {#card-census}

All 89 registrations in `gallery-registrations.tsx`, sorted into the user's three buckets. Only the 16 that move are enumerated individually; the 73 that stay are summarized, since no step touches them.

**Table T01: The 11 spikes that move to `spikes/`** {#t01-spikes}

| Current componentId | New componentId | Current title | Kind | Sibling `.css`? | Shared `cg-*` used | Notes |
|---|---|---|---|---|---|---|
| `gallery-slot-layout` | `spike-slot-layout` | Layouts Picker | live spike | yes | content, section, section-title | Docblock: "A spike, not a component demo" |
| `gallery-pulse-display` | `spike-pulse-display` | Pulse Display | live spike | yes | none | Open typography question + presets bake-off |
| `gallery-configure-tug` | `spike-configure-tug` | ConfigureTug | live spike | yes | content, section, section-title | Imports `gallery.css` explicitly |
| `gallery-session-identity` | `spike-session-identity` | Session Identity | live spike | yes | none | Seeded by `at0376` — rename its seed site |
| `gallery-transcript-registers` | `spike-transcript-registers` | Transcript Registers | live spike | yes | content, section, section-title | Docblock: "design spike for the Code-route transcript's Voice-3 content register" |
| `gallery-pinned-headers` | `spike-pinned-headers` | Pinned Headers (diagnostic) | live spike | **no** | content, section, section-title | Pinned by `gallery-registrations.test.ts` `EXTENDED_CARDS` — remove that pin |
| `gallery-commit-surfaces` | `spike-commit-surfaces` | Commit Surfaces | live spike | yes | section | |
| `gallery-card-chrome` | `spike-card-chrome` | Card Chrome Tiers | closed ref [P07] | yes | content, section, section-title | Own `cg-spike-*` classes already in its sibling `.css` |
| `gallery-changes-dashes` | `spike-changes-dashes` | Changes and Dashes | closed ref [P07] | yes | none | Under active iteration — own commit |
| `gallery-modal-headers` | `spike-modal-headers` | Modal Headers | closed ref [P07] | yes | content, section, section-title | Imports `gallery.css`; bespoke `800×940` size → `size` override |
| `gallery-focus-language` | `spike-focus-language` | Focus Language | closed ref [P07] | yes | content, section-title | Imports `gallery.css`; carries `kbfAtRest: true` |

**Table T02: The 5 fixtures that move to `fixtures/`** {#t02-fixtures}

| Current componentId | New componentId | `hidden` today | File moves? | app-tests to update |
|---|---|---|---|---|
| `gallery-cycle-demo` | `fixture-cycle-demo` | yes | yes — `.tsx`, no `.css`; imports `gallery.css`; carries `kbfAtRest: true` | `at0140` |
| `gallery-list-view-scroll-keyed` | `fixture-list-view-scroll-keyed` | yes | no — registration only ([P03]); `scrollKey` renames too | `at0061`, `at0083`, `at0331` |
| `gallery-markdown-1kb` | `fixture-markdown-1kb` | yes | no — registration only ([P03]) | `at0010-cold-boot-selection` |
| `gallery-markdown-50kb` | `fixture-markdown-50kb` | yes | no — registration only ([P03]) | `at0010-cold-boot-selection`, `at0010-markdown-selection`, `at0014-cold-boot-scroll`, `at0014-scroll-persistence`, `at0023-cross-card-selection` |
| `gallery-transcript-copy` | `fixture-transcript-copy` | **no** | yes — `.tsx`, no `.css` | `at0188` (also its `@covers` line) |

Ten distinct app-test files total; `at0010-cold-boot-selection` appears twice above and is edited once.

**The 73 that stay:** 69 exemplary component demos, unchanged, plus the four instruments per [P08] — `gallery-theme-editor`, `gallery-scale-timing`, `gallery-theme-accessibility`, `gallery-motion-bench`. Two of the 69 change only by losing a `hidden` flag ([P09]).

#### How a card reaches the deck today {#deck-plumbing}

The only human door to the gallery is a compile-time-gated Maker menu item in `AppDelegate.swift`: `"New Component Gallery Card"`, ⌥⌘G, identified `maker.galleryCard`, inside an `if BuildInfo.profile == "debug"` block, in a menu that is itself hidden unless Maker mode is on. Its selector sends `sendControl("show-component-gallery")`. `DeckCanvas` handles that action by walking `snapshot.cards` for an existing `componentId === "gallery-buttons"` and, failing that, calling `store.addCard("gallery-buttons")` followed by `transferFocusForActivation`. That hardcoded id is the reason the action exists at all.

The generic door is `show-card` in `action-dispatch.ts`: it reads `payload.component`, and for a member of `SINGLETON_CARDS` (`about`, `settings`, `keyboard`) calls `deckManager.showSingletonCard(component)`, otherwise `deckManager.addCard(component)`. `AppDelegate.swift`'s `newHelloWorldCard` uses exactly this shape — `sendControl("show-card", params: ["component": "hello"])` — which is the precedent [P04] follows.

Adding a tab within a pane is a third path: `TugTabBar`'s `+` picker calls `dispatchAddTab(componentId)`, which control-dispatches `{action: "add-tab", value: componentId, phase: "discrete"}`. `TugPane`'s responder handles `ADD_TAB` by calling `store.addCardToPane(paneId, componentId)`. Because the pane owns the mutation, any control anywhere inside the pane can emit `add-tab` and get a new tab without knowing the paneId — which is what the spike index card exploits.

The `+` picker's menu is built from `getAllRegistrations()`, filtered by `effectiveFamilies.includes(reg.family ?? "standard")` and then by `reg.hidden !== true`, grouped by `reg.category.label` into sections sorted with `localeCompare`. `TugTabBar` hardcodes no category ids — categories exist only as label strings on registrations. Crucially, `DeckCanvas` passes `acceptedFamilies={hasMultipleCards ? stackState.acceptsFamilies : undefined}`, and `undefined` resolves to `["standard"]` — so a **single-card** pane's picker never offers maker or spike cards. The gallery works around this with `GALLERY_DEFAULT_CARDS`, seeding four cards so the pane is multi-tab from birth; the spike host instead uses its index rows ([P04]).

#### How app-tests seed a card {#seeding}

Tests never call `addCard`. They replace deck state wholesale through the test surface. The canonical shape, from `at0218`:

```ts
const app = await launchTugApp({ testName: "at0218-alert-chooser-rows" });
await app.seedDeckState({
  state: {
    cards: [{ id: "A", componentId: "gallery-alert", title: "Alert Gallery", closable: true }],
    panes: [{ id: "p1", position: { x: 40, y: 40 }, size: { width: 640, height: 560 },
              cardIds: ["A"], activeCardId: "A", title: "",
              acceptsFamilies: ["maker"] }],
    activePaneId: "p1",
    hasFocus: true,
  },
  focusCardId: "A",
});
await app.waitForCondition(`window.__tug.assertHostRootRegistered("A")`);
```

`seedDeckState` resolves componentIds against the live registry, so a fixture must stay registered — `hidden: true` excludes it from the `+` menu and nothing else. Note the `acceptsFamilies: ["maker"]` in the seeded pane: for renamed fixtures this becomes `["fixture"]`, and for `spike-session-identity` in `at0376` it becomes `["spike"]`.

#### Dispatch from card content reaches the pane {#dispatch-from-card-content}

The index card's whole design rests on an action dispatched from card content being handled by `TugPane`, and the DOM makes that look impossible. `TugPane` renders `<ResponderScope>` around `.tug-pane-accessory` and `.tug-pane-content`, but `.tug-pane-content` is an **empty div with a ref** — card content is mounted into it imperatively, not rendered as a React child. So the card is not inside the pane's `ResponderScope` in the React tree.

`useResponder` resolves a node's parent from `ResponderParentContext` — the React-tree axis, deliberately independent of DOM placement — and chain dispatches walk that `parentId` axis. Left alone, a card's dispatch would therefore never reach the pane. `CardHost` overrides it: it registers with `parentId: hostStackId`, re-parenting the card's responder node onto its host pane. The hook's own docstring names this as the override's purpose — "what makes portaled-content dispatch reach handlers that live *above* the React placement."

Consequence for [Spec S02](#s02-spike-home): the index card emits `add-tab` with no knowledge of its pane, and `TugPane`'s `ADD_TAB` handler receives it. No `parentId` plumbing is needed in `SpikeHome` itself — `CardHost` has already done it for every card.

#### Three spikes import shipping session modules by sibling path {#sibling-imports}

Most moving files import only from `components/tugways/` (absolute-aliased or `../`), which survives relocation. Three import **shipping** modules that happen to live in the `cards/` directory, by relative `./` path — and those paths break on move:

| File | Relative imports that must be rewritten |
|---|---|
| `gallery-transcript-registers.tsx` | `./blocks/bash-tool-block`, `./blocks/task-inline-tool-block` |
| `gallery-commit-surfaces.tsx` | `./session-commit-receipt-block`, `./session-command-block-registry` |
| `gallery-changes-dashes.tsx` | `./session-changes/session-changes-dash-lane`, `./session-changes/changes-section-labels` |

These are production block renderers and session-card internals, not gallery demos — a spike composing real shipping components is exactly right, and none of them moves. Only the import specifiers change, to `@/components/tugways/cards/…`. `bunx vite build` catches a miss immediately, but the list is here so the implementer fixes them deliberately rather than chasing build errors.

No moving file is imported by anything other than `gallery-registrations.tsx`, so the moves create no dangling references in the other direction.

#### The duplicate-registration hazard {#duplicate-registration-hazard}

`registerCard` logs `[card-registry] Duplicate registration … Overwriting.` and proceeds. A move performed as "add to the new file" in one commit and "delete from the gallery" in the next therefore leaves a window where both registrations exist, the second silently wins, and **every test passes** — including the drift test, if the surviving registration is the new one. This is why every move step in this plan is copy-register-delete in a single commit, and why each move step's checkpoint greps the gallery file for the moved id.

#### Why `main.tsx` and the test `beforeAll` move together {#registration-call-sites}

`registerGalleryCards()` is called unconditionally in `main.tsx`, last in the registration block, before `DeckManager` construction — because `filterDeckStateByRegistration` drops any restored card whose componentId is unregistered and then drops panes left empty, with console warnings. A new register function that exists but is never called therefore does not fail loudly; it makes cards vanish from saved layouts.

`cards-groups.test.ts`'s `beforeAll` reproduces `main.tsx`'s registration list by hand (`_resetForTest()` then each register function). A new register function absent from that list means its cards are simply not present during the Lens-taxonomy walk — the totality and mapping assertions pass vacuously for them. So both call sites are edited in the same commit that creates each register function.

---

### Specification {#specification}

**Spec S01: `SpikeDef` and the spike registry** {#s01-spikedef}

```ts
// tugdeck/src/spikes/spike-registry.ts
export interface SpikeDef {
  /** Kebab-case slug. The componentId is `spike-${name}`. */
  name: string;
  /** Card title, shown in the pane title bar and the index row. */
  title: string;
  /** One line: the question this spike explores. Rendered by the index card. */
  blurb: string;
  /** lucide-react icon name. Defaults to "FlaskConical". */
  icon?: string;
  /** Overrides SPIKE_SIZE for a spike that needs unusual room. */
  size?: CardSizePolicy;
  /** True when the spike's subject IS the focus language, so it must read with rings on at rest. */
  kbfAtRest?: boolean;
  /** The card body. Receives the cardId the host assigned. */
  component: (cardId: string) => React.ReactNode;
}
```

`registerSpikeCards()` iterates `SPIKES` and calls `registerCard` per entry with: `componentId: \`spike-${def.name}\``, `contentFactory: def.component`, `defaultMeta: { title: def.title, icon: def.icon ?? "FlaskConical", closable: true }`, `family: "spike"`, `acceptsFamilies: ["spike"]`, `sizePolicy: def.size ?? SPIKE_SIZE`, `category: SPIKE_CATEGORY`, and `kbfAtRest` when set. It also registers `spike-home`. No `lensGroup` is declared — the `"tools"` fallback is the intended answer.

`SPIKE_SIZE` is `{ min: { width: 400, height: 350 }, preferred: { width: 640, height: 520 } }` — the gallery's `GALLERY_COMPLEX_SIZE` values, which is what 8 of the 11 moving spikes already use.

`SPIKE_CATEGORY` is `{ label: "Spikes", icon: "FlaskConical" }`, so a multi-card spike pane's `+` picker groups them all under one section.

**Spec S02: The spike index card** {#s02-spike-home}

`spikes/spike-home.tsx` exports `SpikeHome`, registered as `spike-home` with `defaultMeta.title: "Spikes"`. It renders a `TugListView` over the `SPIKES` array — one row per spike. Each row is a `TugListRow` using its built-in two-line shape: `title` takes `def.title`, `subtitle` takes `def.blurb` (rendered muted, the `UITableViewCellStyle.subtitle` shape the component already provides). Compose `TugListView` / `TugListRow`; do not hand-roll list focus or row markup.

Row activation emits the existing `add-tab` action with `value: \`spike-${def.name}\`` through the responder chain; `TugPane` handles it via `store.addCardToPane`. This works from inside card content because `CardHost` registers the card's responder node with `parentId: hostStackId`, explicitly re-parenting it onto the host pane — see [#dispatch-from-card-content](#dispatch-from-card-content). The card holds **no** state of its own: `SPIKES` is a module constant, selection belongs to `TugListView`, and the mutation belongs to the pane ([L11]).

**Spec S03: The taxonomy drift test** {#s03-taxonomy-drift-test}

A new `tugdeck/src/__tests__/card-taxonomy.test.ts` registers the gallery, spike, and fixture sets, then asserts:

1. No registration whose componentId starts with `gallery-` has `hidden === true` ([P09]) — a hidden demo is a contradiction.
2. Every `fixture-*` registration has `hidden === true` and `family === "fixture"`.
3. Every `spike-*` registration has `family === "spike"` and `acceptsFamilies` equal to `["spike"]`.
4. No `gallery-*` registration exists for any of the 16 moved ids — the anti-double-registration guard from [#duplicate-registration-hazard](#duplicate-registration-hazard), pinned as a literal list.
5. Counts for the two closed sets only: `spike-*` is 12 (11 spikes + `spike-home`) and `fixture-*` is 5.

Assertion 5 deliberately omits a `gallery-*` count. Spikes and fixtures are sets that should grow rarely and deliberately, so a hard number there is a useful tripwire. New exemplary demos, by contrast, are the gallery's normal healthy growth — pinning a count would tax every legitimate addition with a test edit, which is friction that gets bumped mindlessly rather than read. The gallery's real invariant is assertion 1 (nothing hidden), and its count is checked once, by grep, at [#exit-criteria](#exit-criteria).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `SPIKES` — which spikes exist | neither; a module constant | `const` array in `spike-registry.ts`, read at registration and by the index card | — |
| Spike index row selection | local-data | `TugListView`'s own selection model; the index card adds no state | [L11] |
| "Add this spike as a tab" | structure | `add-tab` action → `TugPane` responder → `store.addCardToPane` | [L11], [L02] |
| Spike host singleton identity | structure | `SINGLETON_CARDS` + `deckManager.showSingletonCard` | [L25] |
| Spike card body internals | unchanged by this plan | each moved spike keeps whatever it uses today | [L06] |
| `.sp-*` / `.fx-*` layout | appearance | CSS only, no React state | [L06], [L16] |

#### Law cross-check {#law-cross-check}

| Law | How this plan stands against it |
|---|---|
| [L01] one `root.render()` | Untouched. No new mount point; spikes and fixtures are cards inside the existing deck render. |
| [L02] external state via `useSyncExternalStore` | Honored. The index card reads a module constant, not external state; the only external read is the deck store, already behind the store's own subscription. No new store is introduced. |
| [L03] `useLayoutEffect` for registrations events depend on | Honored by inheritance — `useResponder` already registers in `useLayoutEffect`, and neither new card adds a registration of its own. |
| [L06] appearance through CSS and DOM | Honored, and load-bearing: `.sp-*` / `.fx-*` are pure CSS, and [P01] exists precisely to stop a shipping component's appearance from depending on a demo stylesheet. |
| [L09] `TugPane` owns geometry; cards never set position/size/z-order | Honored. `SpikeDef.size` feeds `registerCard`'s `sizePolicy` — the registry's declared policy, which the pane consumes. No card sets its own geometry. |
| [L11] controls emit actions; responders own state | Honored, and the reason [P04] chose `add-tab`: the index row emits, the pane mutates. Hand-rolling `addCardToPane` inside the card would violate this. |
| [L16] CSS lives in the component's stylesheet | Honored by [P01] and [P06]: styling moves to the component that renders it, and the new homes carry their own sheets. |
| [L19] every component follows the authoring guide | Applies to `SpikeHome`, the one genuinely new component: two files (`.tsx` + `.css`), `data-slot`, docstring naming its laws. Moved spikes are pre-existing and are not being retrofitted ([#non-goals](#non-goals)). |
| [L20] composition over new primitives | Honored: `SpikeHome` composes `TugListView` / `TugListRow` rather than inventing a list. The skill's guardrails carry this rule forward to every future spike. |
| [L25] Deck → Pane → Card canonical hierarchy | Honored. Spikes are ordinary content cards; the host is a singleton content card, not a new layout tier. Nothing declares `layoutRole`. |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/spikes/spike-registry.ts` | `SpikeDef`, `SPIKES`, `SPIKE_SIZE`, `SPIKE_CATEGORY`, `registerSpikeCards()` |
| `tugdeck/src/spikes/spike-home.tsx` | The Spikes index card ([Spec S02](#s02-spike-home)) |
| `tugdeck/src/spikes/spike-home.css` | Index-card row styling |
| `tugdeck/src/spikes/spike.css` | `.sp-content`, `.sp-section`, `.sp-section-title` ([P06]) |
| `tugdeck/src/spikes/README.md` | The spike contract + the copy-paste skeleton the skill cites |
| `tugdeck/src/spikes/spike-*.tsx` (+ `.css`) | 11 moved spikes, per [Table T01](#t01-spikes) |
| `tugdeck/src/fixtures/fixture-registrations.tsx` | `registerFixtureCards()` — all 5 fixture registrations |
| `tugdeck/src/fixtures/fixture.css` | `.fx-content`, `.fx-section`, `.fx-section-title`, `.fx-variant-row` ([P06]) |
| `tugdeck/src/fixtures/fixture-cycle-demo.tsx` | Moved from `cards/gallery-cycle-demo.tsx` |
| `tugdeck/src/fixtures/fixture-transcript-copy.tsx` | Moved from `cards/gallery-transcript-copy.tsx` |
| `tugdeck/src/__tests__/card-taxonomy.test.ts` | [Spec S03](#s03-taxonomy-drift-test) |
| `tugplug/skills/spike-card/SKILL.md` | The spike-creation skill |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `registerSpikeCards` | fn | `tugdeck/src/spikes/spike-registry.ts` | Called from `main.tsx` and two test `beforeAll`s |
| `registerFixtureCards` | fn | `tugdeck/src/fixtures/fixture-registrations.tsx` | Same three call sites |
| `SpikeHome` | component | `tugdeck/src/spikes/spike-home.tsx` | Composes `TugListView` |
| `.tug-petals` + 3 keyframes | CSS | `components/tugways/internal/tug-button.css` | Moved out of `cards/gallery.css` ([P01]) |
| `SINGLETON_CARDS` | const | `tugdeck/src/action-dispatch.ts` | Gains `"spike-home"` |
| `newSpikesCard` | Swift `@objc` fn | `tugapp/Sources/AppDelegate.swift` | `sendControl("show-card", params: ["component": "spike-home"])` |
| `maker.spikesCard` | menu item | `tugapp/Sources/AppDelegate.swift` | Inside the `BuildInfo.profile == "debug"` block, no key equivalent |
| `registerGalleryCards` | fn | `cards/gallery-registrations.tsx` | Loses 16 registrations + their imports; two `hidden` flags dropped |
| `EXTENDED_CARDS` | const | `cards/__tests__/gallery-registrations.test.ts` | Loses `gallery-pinned-headers` |
| `"every gallery card lands in tools"` | test | `lens/sections/__tests__/cards-groups.test.ts` | Broadened to all three prefixes |
| `plugin.json` | manifest | `tugplug/.claude-plugin/plugin.json` | Version bump + `spike-card` keyword |

---

### Documentation Plan {#documentation-plan}

- [ ] `tugdeck/src/spikes/README.md` — what a spike is, the one-file-plus-two-lines contract, the skeleton, the two exits (graduate or delete), and the `+`-picker bootstrap note.
- [ ] `tugplug/skills/spike-card/SKILL.md` — the skill itself.
- [ ] `tugplug/CLAUDE.md` — add `spike-card` to the skill roster.
- [ ] Header docblock of `gallery-registrations.tsx` — state the gallery's single membership test (exemplary demos of established `Tug*` components, plus the four instruments) and point at `spikes/` and `fixtures/` for the other two kinds.
- [ ] `tuglaws/component-authoring.md` — its verification gate already says "Renders correctly in Component Gallery across themes"; add one sentence distinguishing a gallery demo from a spike so the guide does not send spike work into the gallery.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (`bun test`)** | Registry shape, taxonomy invariants, Lens group totality | Every step that adds or moves a registration |
| **Drift Prevention** | Pin the taxonomy so a fixture cannot be born in the gallery | [Spec S03](#s03-taxonomy-drift-test), and the broadened `cards-groups` prefix test |
| **App-test (real app)** | The 10 files seeding renamed ids still drive their fixtures | [Step 6](#step-6) and the integration checkpoint |
| **Build** | `bunx vite build` proves the module graph resolves after each move | Every step touching imports |

#### What stays out of tests {#test-non-goals}

- **Rendering assertions for moved spike bodies.** Their internals are unchanged by this plan; a render test would pin a spike's appearance, which is the one thing a spike is supposed to be free to change. The build plus a visual check is the right bar.
- **A jsdom render test for `SpikeHome`.** Banned pattern in this repo, and the real proof is the app-test-free manual gesture in [Step 3](#step-3)'s checkpoint: open the card, click a row, see a tab.
- **App-test coverage for the spike host.** Spikes are debug-build furniture; an app-test pinning the index card would make the sandbox harder to change, which defeats its purpose.
- **Coverage of the 69 untouched demos.** Not modified; the existing batch-1/batch-2 registration tests already pin the ones that matter.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Hoist `.tug-petals` into `tug-button.css` | pending | — |
| #step-2 | The `spikes/` substructure and its registry | pending | — |
| #step-3 | The spike host's door onto the deck | pending | — |
| #step-4 | Move the seven live spikes | pending | — |
| #step-5 | Move the four closed-spike references | pending | — |
| #step-6 | The `fixtures/` annex and the id renames | pending | — |
| #step-7 | Gallery residuals and the taxonomy drift test | pending | — |
| #step-8 | The `/tugplug:spike-card` skill | pending | — |
| #step-9 | Integration checkpoint | pending | — |

---

#### Step 1: Hoist `.tug-petals` into `tug-button.css` {#step-1}

**Commit:** `tugdeck(tug-button): the pending spinner's styling moves to the button that renders it`

**References:** [P01] petals hoist, Risk R01, (#r01-load-bearing-css)

**Artifacts:**
- `.tug-petals` rules + `tug-petals-fade` / `tug-petals-scale` / `tug-petals-rotate` keyframes relocated from `cards/gallery.css` to `components/tugways/internal/tug-button.css`.

**Tasks:**
- [ ] Move the `.tug-petals`, `.tug-petals .petal`, the eight `:nth-child` transform rules, the eight `:nth-child` animation-delay rules, and the three `@keyframes` blocks into `internal/tug-button.css`. Keep the explanatory comment about `--tug-petals-size` with them.
- [ ] Leave `.tug-pole` / `.tug-pole-inner` and `@keyframes tug-pole-scroll` in `gallery.css`: their only consumer is `gallery-scale-timing`, an instrument that stays ([P08]).
- [ ] Move the `.tug-petals` rows of `gallery.css`'s `@tug-pairings` header table into `tug-button.css`'s equivalent header; leave the `.tug-pole` rows where they are.
- [ ] Confirm no other consumer: `grep -rn 'tug-petals' tugdeck/src` should show only `internal/tug-button.css`, `internal/tug-button.tsx`, and `cards/gallery-scale-timing.tsx`.

**Tests:**
- [ ] No new test. The proof is visual — a `TugButton` in its pending state, and the `gallery-scale-timing` petals row, both still animate.

**Checkpoint:**
- [ ] `cd tugdeck && bun run test` exits 0
- [ ] `cd tugdeck && bunx vite build` exits 0
- [ ] `grep -c 'tug-petals' tugdeck/src/components/tugways/cards/gallery.css` returns 0
- [ ] `cd tugdeck && bun run audit:tokens lint` exits 0

---

#### Step 2: The `spikes/` substructure and its registry {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(spikes): a home for design spikes, with its own registry and layout vocabulary`

**References:** [P05] two-line registration, [P06] own CSS vocabulary, Spec S01, Spec S02, (#registration-call-sites, #deck-plumbing)

**Artifacts:**
- `spikes/spike-registry.ts`, `spikes/spike-home.tsx`, `spikes/spike-home.css`, `spikes/spike.css`, `spikes/README.md`
- `registerSpikeCards()` wired into `main.tsx` and `cards-groups.test.ts`

**Tasks:**
- [ ] Write `spike-registry.ts` per [Spec S01](#s01-spikedef): `SpikeDef`, `SPIKE_SIZE`, `SPIKE_CATEGORY`, an empty-for-now `SPIKES` array, and `registerSpikeCards()` looping it plus registering `spike-home`.
- [ ] Write `spike.css` with `.sp-content`, `.sp-section`, `.sp-section-title` — copy the three rule bodies from `gallery.css`'s equivalents ([P06]). These are copies, not a shared abstraction.
- [ ] Write `SpikeHome` per [Spec S02](#s02-spike-home): a `TugListView` over `SPIKES`, each row showing `title` + `blurb`, activation dispatching `add-tab` with `value: \`spike-${def.name}\``. Compose `TugListView`; do not hand-roll rows or list focus. Render a plain "No spikes yet" line when `SPIKES` is empty, which is its state at this commit.
- [ ] Add `import { registerSpikeCards } from "./spikes/spike-registry";` to `main.tsx` and call `registerSpikeCards();` immediately after `registerGalleryCards();`.
- [ ] Add the same import and call to `cards-groups.test.ts`'s `beforeAll` — omitting it makes the taxonomy walk pass vacuously ([#registration-call-sites](#registration-call-sites)).
- [ ] Write `README.md`: what a spike is, the `SpikeDef` skeleton to copy, the two-line registration, the `sp-*` classes, the graduate-or-delete exits, and the note that the pane's `+` picker only lists spikes once the pane holds two cards.

**Tests:**
- [ ] Unit: `spike-home` is registered with `family: "spike"`, `acceptsFamilies: ["spike"]`, and a `contentFactory` (add to the new `card-taxonomy.test.ts`, or a temporary assertion promoted in [Step 7](#step-7)).
- [ ] Unit: `cards-groups.test.ts` totality still passes with the spike set registered — `resolveLensGroup(spike-home)` is `"tools"` and `excluded` is still `["lens"]`.

**Checkpoint:**
- [ ] `cd tugdeck && bun run test` exits 0
- [ ] `cd tugdeck && bunx vite build` exits 0
- [ ] `grep -rn 'cg-' tugdeck/src/spikes` returns nothing

---

#### Step 3: The spike host's door onto the deck {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(spikes): Maker opens the Spikes card through show-card`

**References:** [P04] reuse plumbing, (#deck-plumbing)

**Artifacts:**
- `"spike-home"` added to `SINGLETON_CARDS` in `action-dispatch.ts`
- `maker.spikesCard` menu item + `newSpikesCard` selector in `AppDelegate.swift`

**Tasks:**
- [ ] Add `"spike-home"` to the `SINGLETON_CARDS` set in `action-dispatch.ts`'s `show-card` handler, and extend that handler's comment to name the Spikes home alongside settings/about/keyboard.
- [ ] In `AppDelegate.swift`, inside the existing `if BuildInfo.profile == "debug"` block in the Maker menu — beside `maker.galleryCard` and `maker.helloCard` — add `NSMenuItem(title: "New Spikes Card", action: #selector(newSpikesCard(_:)), keyEquivalent: "").identified("maker.spikesCard")`. No key equivalent: ⌥⌘G and ⌥⌘⇧N are taken and a spikes chord is not worth a tier.
- [ ] Add `@objc private func newSpikesCard(_ sender: Any) { sendControl("show-card", params: ["component": "spike-home"]) }`, modelled exactly on `newHelloWorldCard`.
- [ ] Confirm no `command-registry` entry is needed: `show-card` is dispatched from Swift, not bound to a web-side chord, so there is no routing to pin.

**Tests:**
- [ ] No automated test. The Swift menu is debug-only and the deck-side change is one set member; the gesture below is the proof.

**Checkpoint:**
- [ ] `just build-app` exits 0
- [ ] Maker ▸ New Spikes Card opens a card titled "Spikes" showing the empty-state line
- [ ] Invoking the item a second time raises the existing card rather than opening a duplicate (singleton semantics)

---

#### Step 4: Move the seven live spikes {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(spikes): the seven live design spikes move out of the gallery`

**References:** [P02] prefix taxonomy, [P05] two-line registration, [P06] own CSS vocabulary, Table T01, (#duplicate-registration-hazard, #t01-spikes)

**Artifacts:**
- 7 spikes relocated to `spikes/spike-*.tsx` (+ sibling `.css` where one exists), registered through `SPIKES`, removed from `gallery-registrations.tsx`

**Tasks:**
- [ ] For each of `slot-layout`, `pulse-display`, `configure-tug`, `session-identity`, `transcript-registers`, `pinned-headers`, `commit-surfaces`: `git mv` `cards/gallery-<id>.tsx` → `spikes/spike-<id>.tsx`, and the sibling `.css` likewise where [Table T01](#t01-spikes) says one exists (`pinned-headers` has none).
- [ ] Rename the exported component `Gallery<X>` → `Spike<X>` and add `export const spike: SpikeDef` with a `blurb` drawn from the file's existing docblock — the docblocks already state each spike's question.
- [ ] Rewrite the shared-class usages named in [Table T01](#t01-spikes): `cg-content` → `sp-content`, `cg-section` → `sp-section`, `cg-section-title` → `sp-section-title`. Leave every card-specific `cg-*` family alone — `cg-configure-tug-*` is defined in that card's own sibling `.css` and travels with it untouched.
- [ ] Replace the `import "../components/tugways/cards/gallery.css"` in `spike-configure-tug.tsx` with `import "./spike.css"`. For the six that relied on the ambient import from `gallery-registrations.tsx`, add `import "./spike.css"` — without it they render unstyled, since nothing in `spikes/` pulls `gallery.css` any more.
- [ ] Rewrite the relative sibling imports in `spike-transcript-registers.tsx` and `spike-commit-surfaces.tsx` to `@/components/tugways/cards/…`, per [#sibling-imports](#sibling-imports). These reach shipping block renderers that do not move; only the specifier changes.
- [ ] Add the seven `import` lines and seven `SPIKES` entries in `spike-registry.ts`. Give `spike-session-identity` the `blurb` note that `at0376` drives it.
- [ ] In the **same commit**, delete the seven `import` lines and seven `registerCard` blocks from `gallery-registrations.tsx` ([#duplicate-registration-hazard](#duplicate-registration-hazard)).
- [ ] Update `at0376-session-atom-clipboard.test.ts`: `componentId: "gallery-session-identity"` → `"spike-session-identity"`, the seeded pane's `acceptsFamilies` → `["spike"]`, and its `@covers` line to the new path.
- [ ] Remove `"gallery-pinned-headers"` from `EXTENDED_CARDS` in `cards/__tests__/gallery-registrations.test.ts`, and while in that file strip the `#step-14-5` plan-step references from its comments — plan-step numbers do not belong in code.

**Tests:**
- [ ] Unit: `cards-groups.test.ts` totality green with seven more spike registrations.
- [ ] Unit: `gallery-registrations.test.ts` green after the `EXTENDED_CARDS` edit.
- [ ] App-test: `at0376-session-atom-clipboard.test.ts` passes against the renamed id.

**Checkpoint:**
- [ ] `cd tugdeck && bun run test` exits 0
- [ ] `cd tugdeck && bunx vite build` exits 0
- [ ] `grep -c 'gallery-slot-layout\|gallery-pulse-display\|gallery-configure-tug\|gallery-session-identity\|gallery-transcript-registers\|gallery-pinned-headers\|gallery-commit-surfaces' tugdeck/src/components/tugways/cards/gallery-registrations.tsx` returns 0
- [ ] `just app-test tests/app-test/at0376-session-atom-clipboard.test.ts` is green
- [ ] Maker ▸ New Spikes Card lists seven rows; clicking one mounts it as a tab in the same pane

---

#### Step 5: Move the four closed-spike references {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(spikes): the four settled design references join the spikes`

**References:** [P07] closed refs to spikes, [P02] prefix taxonomy, Table T01, (#t01-spikes)

**Artifacts:**
- `spike-card-chrome`, `spike-changes-dashes`, `spike-modal-headers`, `spike-focus-language` relocated and registered; removed from the gallery

**Tasks:**
- [ ] `git mv` each of the four `.tsx` files and their sibling `.css` files into `spikes/`, renaming to `spike-*`.
- [ ] Apply the same component rename, `SpikeDef` export, and `sp-*` class rewrites as [Step 4](#step-4), per [Table T01](#t01-spikes).
- [ ] `spike-modal-headers` and `spike-focus-language` import `gallery.css` explicitly — swap both for `./spike.css`. `spike-card-chrome` and `spike-changes-dashes` relied on the ambient import; add `./spike.css` to both (`spike-changes-dashes` uses no shared class but still needs `.sp-content` if its root carries it — check the root element and add the import only if a shared class survives the rewrite).
- [ ] Carry `kbfAtRest: true` onto `spike-focus-language`'s `SpikeDef`, preserving the reason in a comment: this spike's subject *is* the engine's focus stops, so it must read with rings on at rest.
- [ ] Give `spike-modal-headers` a `size` override of `{ min: { width: 480, height: 400 }, preferred: { width: 800, height: 940 } }` — its current bespoke policy, the reason `SpikeDef.size` exists.
- [ ] Add four imports + four `SPIKES` entries; in the same commit delete the four imports + four `registerCard` blocks from `gallery-registrations.tsx`.
- [ ] Rewrite `spike-changes-dashes.tsx`'s relative sibling imports (`./session-changes/session-changes-dash-lane`, `./session-changes/changes-section-labels`) to `@/components/tugways/cards/…`, per [#sibling-imports](#sibling-imports). Both targets are shipping session-card modules that stay put.
- [ ] Keep `spike-changes-dashes` legible against the in-flight dash work: this commit renames and relocates only, with no content edits.

**Tests:**
- [ ] Unit: `cards-groups.test.ts` totality green with eleven spikes registered.
- [ ] Unit: no `gallery-card-chrome` / `-changes-dashes` / `-modal-headers` / `-focus-language` registration resolves (promoted into [Spec S03](#s03-taxonomy-drift-test) in the next step).

**Checkpoint:**
- [ ] `cd tugdeck && bun run test` exits 0
- [ ] `cd tugdeck && bunx vite build` exits 0
- [ ] `grep -c 'gallery-card-chrome\|gallery-changes-dashes\|gallery-modal-headers\|gallery-focus-language' tugdeck/src/components/tugways/cards/gallery-registrations.tsx` returns 0
- [ ] All four render correctly in the Spikes pane across a dark and a light theme — `spike-focus-language` still shows its rings at rest

---

#### Step 6: The `fixtures/` annex and the id renames {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(fixtures): app-test fixture cards get their own annex, out of the gallery`

**References:** [P02] prefix taxonomy, [P03] import direction, [P06] own CSS vocabulary, Table T02, (#seeding, #t02-fixtures)

**Artifacts:**
- `fixtures/fixture-registrations.tsx`, `fixtures/fixture.css`, `fixtures/fixture-cycle-demo.tsx`, `fixtures/fixture-transcript-copy.tsx`
- 5 registrations removed from the gallery; 10 app-test files reseeded

**Tasks:**
- [ ] Create `fixtures/fixture.css` with `.fx-content`, `.fx-section`, `.fx-section-title`, `.fx-variant-row`, copied from `gallery.css`'s equivalents ([P06]).
- [ ] `git mv` `cards/gallery-cycle-demo.tsx` → `fixtures/fixture-cycle-demo.tsx` and `cards/gallery-transcript-copy.tsx` → `fixtures/fixture-transcript-copy.tsx`; neither has a sibling `.css`. Rename their exports, rewrite their shared classes to `fx-*`, and replace `cycle-demo`'s explicit `gallery.css` import with `./fixture.css` (add the import to `transcript-copy`, which relied on the ambient one).
- [ ] Write `fixture-registrations.tsx` with `registerFixtureCards()` registering all five per [Table T02](#t02-fixtures), each with `hidden: true`, `family: "fixture"`, `acceptsFamilies: ["fixture"]`. Import `GalleryListView` and `GalleryMarkdownView` from `components/tugways/cards/` for the three prop-variant registrations — the components themselves do not move ([P03]). Carry `kbfAtRest: true` onto `fixture-cycle-demo`.
- [ ] Open the file with a header docblock stating the annex's contract: a fixture's only door is the test harness; registration exists so `seedDeckState` resolves it; every fixture names the at-tests that seed it; a fixture no test seeds gets deleted.
- [ ] Rename the scroll fixture's `scrollKey` from `"gallery-list-view-scroll"` to `"fixture-list-view-scroll"` alongside its componentId ([P02]).
- [ ] Wire `registerFixtureCards()` into `main.tsx` and into `cards-groups.test.ts`'s `beforeAll`.
- [ ] In the same commit, delete the five imports/registrations from `gallery-registrations.tsx`.
- [ ] Update the 10 app-test files per [Table T02](#t02-fixtures) — componentId, the seeded pane's `acceptsFamilies` → `["fixture"]`, and the `scrollKey` string in `at0061` / `at0083` / `at0331`. Update `at0188`'s `@covers` line to `tugdeck/src/fixtures/fixture-transcript-copy.tsx`.

**Tests:**
- [ ] App-test: the 10 affected files, via `just app-test-changed` (the `@covers` edit makes the selection derive correctly).
- [ ] Unit: `cards-groups.test.ts` totality green with the fixture set registered — all five resolve to `"tools"` and `excluded` is still `["lens"]`.

**Checkpoint:**
- [ ] `cd tugdeck && bun run test` exits 0
- [ ] `cd tugdeck && bunx vite build` exits 0
- [ ] `just app-test-covers-check` exits 0
- [ ] `grep -rn 'gallery-cycle-demo\|gallery-list-view-scroll\|gallery-markdown-1kb\|gallery-markdown-50kb\|gallery-transcript-copy' tests/ tugdeck/src/` returns nothing
- [ ] `just app-test-changed` is green

---

#### Step 7: Gallery residuals and the taxonomy drift test {#step-7}

**Depends on:** #step-6

**Commit:** `tugdeck(gallery): the gallery is exemplary demos only, and a test says so`

**References:** [P09] unhide showcases, [P08] instruments stay, Spec S03, Risk R02, (#s03-taxonomy-drift-test, #r02-taxonomy-redrift)

**Artifacts:**
- `hidden: true` dropped from the two showcase registrations
- `tugdeck/src/__tests__/card-taxonomy.test.ts`
- Broadened prefix test in `cards-groups.test.ts`; refreshed `gallery-registrations.tsx` docblock

**Tasks:**
- [ ] Remove `hidden: true` from `gallery-list-view-filter` and `gallery-list-view-headers` ([P09]). They stay under "Data Views" and become browsable in the `+` picker.
- [ ] Confirm no `hidden: true` remains anywhere in `gallery-registrations.tsx` — all six original ones were either moved to `fixtures/` or unhidden here.
- [ ] Write `card-taxonomy.test.ts` per [Spec S03](#s03-taxonomy-drift-test), registering all three sets and asserting the five invariants including the hard counts (73 / 12 / 5).
- [ ] Broaden `cards-groups.test.ts`'s `"every gallery card lands in tools"` to cover all three prefixes — as written it filters `componentId.startsWith("gallery-")` and would silently stop covering the 16 renamed cards ([P02]).
- [ ] Rewrite `gallery-registrations.tsx`'s header docblock: state the single membership test (an exemplary demo of an established `Tug*` component, plus the four instruments per [P08]), and point at `spikes/` and `fixtures/` for the other two kinds. Drop the stale pointer to `tests/app-test/at0082-gallery-shipped-renderers.test.ts`, which does not exist.
- [ ] Strip the `#step-29-5` plan-step reference from `gallery-registrations-batch-2.test.ts`'s comments and describe block, matching the `#step-14-5` cleanup in [Step 4](#step-4).
- [ ] Add the distinguishing sentence to `tuglaws/component-authoring.md` beside its "Renders correctly in Component Gallery across themes" gate, so the guide stops routing spike work into the gallery.

**Tests:**
- [ ] Unit: `card-taxonomy.test.ts` — all five invariants.
- [ ] Unit: the broadened prefix test fails if a `spike-*` or `fixture-*` card is given a non-`tools` Lens group.
- [ ] Unit: existing batch-1/batch-2 registration tests still green.

**Checkpoint:**
- [ ] `cd tugdeck && bun run test` exits 0
- [ ] `cd tugdeck && bunx vite build` exits 0
- [ ] `grep -c 'hidden: true' tugdeck/src/components/tugways/cards/gallery-registrations.tsx` returns 0
- [ ] `grep -c 'registerCard({' tugdeck/src/components/tugways/cards/gallery-registrations.tsx` returns 73
- [ ] The `+` picker in a multi-card gallery pane shows the two unhidden showcases under "Data Views"

---

#### Step 8: The `/tugplug:spike-card` skill {#step-8}

**Depends on:** #step-7

**Commit:** `tugplug(spike-card): a skill for making a design spike in two minutes`

**References:** [P05] two-line registration, [P06] own CSS vocabulary, Spec S01, (#s01-spikedef)

**Artifacts:**
- `tugplug/skills/spike-card/SKILL.md`; `plugin.json` version + keyword; `tugplug/CLAUDE.md` roster entry

**Tasks:**
- [ ] Write `SKILL.md` with house frontmatter: `name: spike-card`, a one-sentence em-dash `description` naming the deliverable and the negative constraint, `argument-hint: "[what you want to explore]"`, `disable-model-invocation: true`, `allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion`, `disallowed-tools: Task`. Name it `spike-card`, not `spike` — bare lane names are not given to a single skill.
- [ ] Body in house shape: `## What this is` → `## Input` (the literal invocation line) → a numbered flow → `## Guardrails`. The flow: name it (kebab-case slug); scaffold from the skeleton in `tugdeck/src/spikes/README.md`; add the two lines to `spike-registry.ts`; verify with `bunx vite build`; print the opening gesture.
- [ ] Cite the laws the skeleton already obeys — [L01], [L02], [L06], [L11], [L19] — and the non-negotiables: compose existing `Tug*` components rather than hand-rolling, tokens not hex, no `localStorage`, no `cg-*` classes.
- [ ] Guardrails: a spike never imports from `fixtures/`; never registers outside `family: "spike"`; never carries `hidden` (a spike nobody can see is a dead spike); exits by graduating (component work to `tugways/`, durable findings to `tuglaws/`, file deleted) or by deletion. Never commits — landing is the user's act.
- [ ] Document the deletion after-effect in both `README.md` and the skill: deleting a spike that is currently open in a saved layout means that pane is dropped on next launch with a `[DeckManager] filterRegisteredCards: dropping card …` console warning. That is correct behavior, not a bug — but a user who deletes a spike and then sees a pane vanish deserves to have been told.
- [ ] Print the next gesture on its own line in backticks so the Session card renders it as a chip.
- [ ] Bump `version` in `tugplug/.claude-plugin/plugin.json` and add `spike-card` to its `keywords`.
- [ ] Add `spike-card` to `tugplug/CLAUDE.md`'s skill roster.
- [ ] Prove the loop end-to-end: with `TUG_PLUGIN_DIR` pointed at the repo tree, run the skill to create one throwaway spike, confirm it appears in the Spikes index, then delete it and its two registry lines. The deletion is part of this step — the throwaway must not land.

**Tests:**
- [ ] `bash tugplug/hooks/tests/run-gate-tests.sh` still exits 0 (no hook change, but the plugin dir is touched).
- [ ] Manual: the skill is listed by the skills inventory as `tugplug:spike-card` after `just build-app`.

**Checkpoint:**
- [ ] `just hooks-test` exits 0
- [ ] `just build-app` exits 0, and `/tugplug:spike-card` is invocable
- [ ] The throwaway spike appeared on the deck and was removed; `git status --porcelain tugdeck/src/spikes` shows only intended files

---

#### Step 9: Integration checkpoint {#step-9}

**Depends on:** #step-4, #step-5, #step-6, #step-7, #step-8

**Commit:** `N/A (verification only)`

**References:** [P02] prefix taxonomy, Spec S03, (#success-criteria)

**Tasks:**
- [ ] Walk every success criterion in [#success-criteria](#success-criteria) and confirm each mechanically.
- [ ] Open the gallery (⌥⌘G) and page the `+` picker's ten categories: no fixture, no spike, no diagnostic. The four instruments are present per [P08].
- [ ] Open the Spikes card and mount all eleven spikes as tabs; each renders styled, across one dark and one light theme.
- [ ] Confirm the Lens's Cards section shows open spike and fixture panes under Tools with their real titles.
- [ ] Confirm a saved layout holding a moved card degrades as designed: the pane drops with a console warning, and no gallery pane is affected.

**Tests:**
- [ ] `cd tugdeck && bun run test` — full unit suite
- [ ] `just app-test-changed` — the derived selection across all steps' edits
- [ ] `just app-test` — the core tier, since `main.tsx` was edited and no `@covers` line can scope it

**Checkpoint:**
- [ ] `cd tugdeck && bun run test && bunx vite build && bun run audit:tokens lint` all exit 0
- [ ] `just app-test-covers-check` exits 0
- [ ] `just app-test` core tier is green
- [ ] `grep -rn 'cg-' tugdeck/src/spikes tugdeck/src/fixtures` returns nothing

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A gallery that holds only exemplary component demos and the four instruments; a `fixtures/` annex whose cards are reachable only by the test harness; a `spikes/` sandbox with its own registry, layout vocabulary, and deck door; and a `/tugplug:spike-card` skill that makes a new spike one file plus two lines.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `gallery-registrations.tsx` holds exactly 73 registrations, none `hidden` (`grep -c`)
- [ ] `spike-*` is 12 registrations, `fixture-*` is 5, families pinned per prefix ([Spec S03](#s03-taxonomy-drift-test))
- [ ] `grep -rn 'cg-' tugdeck/src/spikes tugdeck/src/fixtures` empty ([P06])
- [ ] `grep -c 'tug-petals' cards/gallery.css` returns 0 ([P01])
- [ ] Maker ▸ New Spikes Card lists all 11 spikes; a row click mounts one as a tab
- [ ] `bun run test`, `bunx vite build`, `audit:tokens lint`, `app-test-covers-check` all exit 0
- [ ] `just app-test-changed` and `just app-test` core tier both green
- [ ] `/tugplug:spike-card` invocable after `just build-app`, and demonstrated once end-to-end

**Acceptance tests:**
- [ ] `card-taxonomy.test.ts` — the five taxonomy invariants
- [ ] `cards-groups.test.ts` — totality plus the broadened three-prefix group test
- [ ] `at0376`, `at0140`, `at0188`, `at0061`, `at0083`, `at0331`, `at0010` ×2, `at0014` ×2, `at0023` — all green against renamed ids

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Give the four instruments their own `Instruments` `CATEGORIES` entry, so `gallery-motion-bench` stops living under "Feedback & Status" ([P08])
- [ ] Resolve [Q01](#q01-prod-bundle) — whether the gallery, spikes, and fixtures should ship in the production bundle at all, measured against `dist/`
- [ ] Graduate the four settled references ([P07]): move their durable content into `tuglaws/` and delete the spike files
- [ ] Reconsider `gallery-state-preservation`, a manual-verification testbed that no test drives — fixture, spike, or delete
- [ ] Revisit `show-component-gallery`: with `show-card` proven as the generic door, the bespoke action and its `DeckCanvas` handler could retire in favour of a `gallery-home` singleton

| Checkpoint | Verification |
|------------|--------------|
| Petals hoisted | `grep -c 'tug-petals' cards/gallery.css` → 0 |
| Spikes reachable | Maker ▸ New Spikes Card lists 11 rows; a click mounts a tab |
| Gallery is demos only | `grep -c 'registerCard({'` → 73; `grep -c 'hidden: true'` → 0 |
| Fixtures sealed | `card-taxonomy.test.ts` invariants 2 and 5 |
| No borrowed CSS | `grep -rn 'cg-' tugdeck/src/spikes tugdeck/src/fixtures` → empty |
| Renames complete | `grep -rn '<the 6 old ids>' tests/ tugdeck/src/` → empty |
| Skill works | `/tugplug:spike-card` creates a spike that appears on the deck |

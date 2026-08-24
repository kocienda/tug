## Bullseye — a temporary reading posture for one card {#bullseye}

**Purpose:** Give any content card a **bullseye** posture — temporarily centered in the content band at the **comfy** width, with every other surface on the deck receded — reachable and reversible by one chord (⌃⌘B) and a Window menu item, without writing a single byte of geometry to the store or the persisted layout blob.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-08 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The deck already lets a user choose a card's width four ways ([D128], [D130]) and place it four ways (free drag, a slot, a rail pin, the Layouts section). What it has no gesture for is the thing a writing app calls a focus mode: *put the thing I am working on in front of me, at a comfortable column, and push everything else back — for now.* iA Writer reaches this with ⌘D; its Focus Mode dims everything but the active sentence and its Typewriter variant keeps the caret centered. The transferable idea for Tug is not the sentence dimming — Tug's cards are not one document — it is the **presentation**: one comfortable column, centered, everything else visually receded, trivially reversible. The name is **bullseye**, deliberately not "focus mode", because *focus* already names the responder-chain concept in this codebase (`focus-language.md`, `transferFocusForActivation`, `data-focused`) and a second meaning for it would be a permanent tax on every reader.

The reason this needs a plan rather than a patch is that the obvious implementation is a trap. "Call `setPaneWidth(comfy)`, call `centerPane()`, remember the old values, restore on exit" routes through `DeckManager.movePane`, which calls `scheduleSave()` unconditionally **and** rewrites the `widthPreset` stamp on any width change. Within one save debounce the bullseye geometry is in the persisted v4 blob, the user's preset stamp (or their hand-dragged width, which is recorded by the *absence* of a stamp) is clobbered, and a crash, quit, or reload mid-bullseye leaves the deck permanently in a posture the user thought was temporary. That is a direct [L23] violation — an internal operation losing user-visible state — and it is silent and durable, the worst combination.

#### Strategy {#strategy}

- **Bullseye is a presentation, not geometry.** It resolves in CSS at render, exactly the way imposed and pinned panes already resolve ([D121]). Stored `position`, `size`, `slot`, and `widthPreset` are never written, so exit is *clearing one field* rather than restoring a snapshot — there is nothing to restore because nothing was disturbed.
- **Reuse `imposeStyle`, do not write new geometry.** A one-up placement is already defined as "centered in the band" (`travelFraction` returns `0.5` for `count < 2`), so bullseye is `imposeStyle({ slot: 0, count: 1 }, comfyWidth)` and nothing else. No fourth number, no second opinion about width ([D130]).
- **Reuse the existing recede, do not build a scrim.** Every pane already carries a two-layer inactive-content dim on `.tug-pane-chrome::before` / `::after`, selected by `:not([data-focused="true"])` and `pointer-events: none`. Bullseye deepens those knobs. It adds no element, blocks no interaction, and is therefore *not modal* — which is what lets "click somewhere else" be an exit door instead of a blocked gesture.
- **Exit is derived, not remembered.** The bullseye field is read through a validating accessor: if the stored pane is gone, or is no longer the pane hosting the first responder, the accessor answers `null`. Focus-follows-ends-bullseye and click-outside-ends-bullseye then hold *by construction*, across every path that moves focus, rather than by an event handler that some future path forgets to call.
- **Sequence store → command → render → recede → host → doctrine → test**, so each step has a checkpoint that can fail on its own, and the chord is exercisable from the keyboard before the Swift menu item exists.

#### Success Criteria (Measurable) {#success-criteria}

- Pressing ⌃⌘B on a focused content pane paints its frame at **800px** wide (comfy, clamped to the stack's `sizePolicy`), horizontally centered in the band between `--tug-imposer-inset-left` and `--tug-imposer-inset-right`, over the full vertical run (top gap to bottom gap). *Verify: app-test reads `getBoundingClientRect()` on `.tug-pane[data-pane-id]`.*
- While bullseyed, `store.getSnapshot()` reports the pane's `position`, `size`, `slot`, and `widthPreset` **byte-identical** to their pre-bullseye values. *Verify: app-test snapshots the pane record before and during.*
- `serialize(state)` output contains no bullseye key under any state. *Verify: unit test in `serialization` tests asserting `Object.keys` of the serialized blob.*
- Each of the four exit doors (⌃⌘B again, focusing another pane, canvas-background deselect, an explicit geometry gesture on the pane) returns the frame to a rect **pixel-identical** to its pre-bullseye rect. *Verify: app-test measures before/after per door.*
- A rail (Lens or Jots) cannot be bullseyed: with the Lens focused, ⌃⌘B moves nothing and the Window ▸ Bullseye item is disabled. *Verify: app-test measures the Lens frame across the press; menu gate asserted via the `bullseye` fact.*
- An **imposed** pane bullseyed and un-bullseyed returns to its slot's anchor, at its own stored width. *Verify: app-test on a `three-up` deck.*

#### Scope {#scope}

1. A session-only `bullseyePaneId` on `DeckState`, its validating accessor, its toggle, and its exclusion from serialization.
2. A `toggle-bullseye` action: vocabulary entry, dispatch registration, deck-canvas handler, registry command on ⌃⌘B, and a `bullseye` menu fact.
3. A bullseye branch in `TugPane`'s geometry ternary, built from `imposeStyle`.
4. A deepened recede on every non-bullseyed pane, via the existing content-dim token pair.
5. Window ▸ Bullseye in `AppDelegate.swift`, with an empty key equivalent.
6. Doctrine: a new global decision, a `pane-model.md` section, a `chord-tiers.md` note.
7. An app-test (`at0372`) covering all four exit doors, the no-write claim, and rail inertness.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Any dimming inside a card's content** (sentence/paragraph highlighting à la iA Writer). Bullseye operates on panes; the composer and transcript are untouched.
- **A typewriter-scroll mode.** Caret centering is an editor concern and belongs to whichever surface would own it, not to the deck.
- **Escape as an exit door.** Cards own Escape internally (descend scopes, editors, the filter field per R5's exclusion), and exiting bullseye should be intentional. ⌃⌘B, a click elsewhere, and a geometry gesture are enough.
- **A title-bar bullseye control.** v1 has two doors (chord and menu). A third, pane-addressed door is a follow-on, and the action split it would need is described in [P07].
- **Bullseye chasing the selection.** Focus moving to another pane *ends* bullseye; it does not transfer.
- **Hiding or collapsing rails.** See [P04]. Still a non-goal. Moving other *content* panes out of the way is no longer one — see the [P04] amendment, which is the correction the built result forced.
- **Persisting bullseye across reload.** The whole point is that it is temporary; see [P01].
- **More than one bullseyed pane at a time.** The field holds one id.

#### Dependencies / Prerequisites {#dependencies}

- The width-preset pipeline as it landed in `706ca677c` ([D130]) — `TUG_ACTIONS.SET_PANE_WIDTH`, `CARD_WIDTH_COMMANDS`, the `cardWidth` menu fact, and the deck-canvas handler. Bullseye copies its shape at every layer.
- `lib/layout-imposer.ts`'s `imposeStyle`, `travelFraction`, `resolveContentWidthPx`, `DEFAULT_CONTENT_WIDTH`, and the `--tug-imposer-inset-left` / `--tug-imposer-inset-right` custom properties written by `deck-canvas.tsx`'s inset layout effect.
- The FLIP settle in `deck-canvas.tsx` (`arrangementSignature`, `data-imposer-settling`, `lib/pane-flip.ts`), which bullseye rides for its motion.
- The two-layer inactive-content dim in `components/tugways/tug-pane.css`.

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS.** The Rust workspace enforces `-D warnings`; this plan touches no Rust, but `bunx tsc --noEmit` and lint must be clean.
- **Never `filter`, `transform`, `perspective`, `backdrop-filter`, `contain`, or `will-change` on `.tug-pane` for the recede.** Those make the frame a containing block for `position: fixed` descendants, and `TugSheet` portals into the frame while completion popups, alerts, and banners position from viewport coordinates. This is written down in `deck-canvas.tsx`'s `clearFlipRef` comment as the reason the settle strips its own inline `transform`. The recede must stay on the existing `.tug-pane-chrome::before` / `::after` pseudo layers, which already carry `mix-blend-mode` and `pointer-events: none` and affect no descendant's containing block.
- **The imposer never touches a pane's width, in any code path** ([D121]). Bullseye hands `imposeStyle` a width; it does not ask the imposer to compute one.
- **Every horizontal pin is emitted as `left`** ([D121]) — `imposeStyle` already does this, which is what lets a bullseye entry/exit cross rather than cut.
- Verify tugdeck changes with `bunx vite build` before declaring done: the debug app loads the prod rollup bundle, not the dev server.
- App-tests are selective. `just app-test-changed` derives the run from `@covers`; do not sweep the corpus.

#### Assumptions {#assumptions}

- The band (canvas minus rails and gaps) is usually wider than 800px. When it is not, `imposeStyle`'s `max(0px, band - width)` pins the pane at the band's left edge and it overlaps the right rail — which is exactly what an over-wide imposed pane already does, and D121 declares overlap "ordinary geometry, not a failure." No z-lift and no clamp are added for it.
- `activePaneId` and "last pane in the `panes` array" name the same pane, because every raise path writes both in one commit. This is the invariant `host-menu-state.ts`'s `stackDepth` already rests on and at0371's docblock already names.
- **The FLIP settle interpolates width as well as position**, so bullseye's entry and exit animate fully with no new motion code — see [#settle](#settle) for the mechanism and its one transient consequence.
- **`data-focused` derives from `activePaneId` alone, not from OS window focus.** `components/chrome/pane-focus-controller.ts` is the sole authority for the attribute and writes `"true"` on the pane matching `activePaneId`, `"false"` on every other — it never reads `DeckState.hasFocus`. This is load-bearing for [P09]: the recede selector stays correct when the app is in the background, which is the state app-test windows run in by default. Verified rather than assumed, because a `hasFocus` term there would have dimmed the bullseyed pane in every app-test screenshot.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors in this document follow the devise skeleton: `step-N` for execution steps, `pNN-…` for plan-local decisions, `qNN-…` for open questions, `rNN-…` for risks, `sNN-…` for specs, `tNN-…` for tables. `[P##]` is plan-local; `[D##]` cites the global [design-decisions.md](../tuglaws/design-decisions.md) and `[L##]` cites [tuglaws.md](../tuglaws/tuglaws.md).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does a `menuEligible` binding still fire from the web view before its menu item exists? (RESOLVED IN SEQUENCING) {#q01-menu-eligible-before-item}

**Question:** `CARD_WIDTH_COMMANDS` mark their bindings `{ menuEligible: true }`, and `applyCommandChords` writes those chords onto the Swift items on the first `menuState` push. Before Step 5 lands the Window ▸ Bullseye item, no native item claims ⌃⌘B — does the registry binding still resolve in the web view's own keydown layer?

**Why it matters:** It decides whether Step 2's checkpoint can press the chord, or whether the chord round-trip can only be exercised after the Swift step.

**Plan to resolve:** Sidestepped rather than spiked. The step order puts the Swift item (#step-5) before the app-test (#step-7), and #step-2's checkpoint asserts at the dispatch layer (`dispatchCommand("toggle-bullseye")` from the dev console / a unit call) rather than through a keypress. Whichever way the layering answers, no step's checkpoint depends on the answer.

**Resolution:** DEFERRED — sequencing removes the dependency. If an implementer wants the answer, `tuglaws/commands.md`'s four-layer resolution section states it; nothing in this plan needs it.

#### [Q02] Should bullseye survive a window resize that shrinks the band below comfy? (DECIDED) {#q02-band-narrower-than-comfy}

**Question:** When the band is narrower than 800px, the bullseyed pane pins at the band's left edge and overlaps the right rail. Should bullseye clamp the width down, or exit, or overlap?

**Why it matters:** A clamp would be a *second opinion about width* ([D130] forbids exactly that), and an auto-exit would be a state change the user did not ask for.

**Resolution:** DECIDED — overlap, per [P02]. It is the same answer the imposer already gives for an over-wide slotted pane, so the deck behaves one way rather than two.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Bullseye geometry leaks into the persisted blob | high | low | `serialize()` lists fields explicitly; a unit test asserts the key set | any change to `serialization.ts` |
| Recede implemented with `filter`/`transform`, breaking portaled surfaces | high | med | Constraint stated; recede confined to the existing pseudo layers | any CSS review touching `.tug-pane` |
| Stale `bullseyePaneId` after a card/pane close | med | med | Validating accessor derives, never trusts, the stored id | any new pane-removal path |
| Motion regression from a new settle term | low | low | Bullseye rides the existing `arrangementSignature`/FLIP path unchanged | perf brief follow-ups |

**Risk R01: The recede becomes a containing block** {#r01-recede-containing-block}

- **Risk:** Implementing the dim with `filter: saturate()` or an opacity-carrying `transform` on `.tug-pane` makes every bullseye-inactive frame a containing block for `position: fixed`, offsetting `TugSheet`, alerts, completion popups, and banners by the pane's origin — and only while bullseye is on, which is the hardest kind of bug to reproduce from a report.
- **Mitigation:**
  - The recede is a change of *token values* on the two existing `.tug-pane-chrome::before` / `::after` layers. No new property lands on `.tug-pane` itself.
  - Those layers already carry `pointer-events: none` and `mix-blend-mode`, and are confined by `.tug-pane-chrome`'s `isolation: isolate`.
- **Residual risk:** A future author adding a third recede layer could reintroduce it. The `pane-model.md` amendment in #step-6 names the constraint so the next reader meets it.

**Risk R02: A pane-removal path leaves bullseye pointing at nothing** {#r02-stale-bullseye-id}

- **Risk:** Closing the bullseyed card, closing its pane, or detaching its last card leaves `bullseyePaneId` naming a pane that no longer exists; a render branch keyed on it would then either throw or silently mis-place a different pane if ids were ever reused.
- **Mitigation:**
  - `getBullseyePaneId()` is a **pure derivation** over the current snapshot ([P05]): it returns `null` unless the pane exists *and* hosts the current first responder. Nothing downstream can read a stale id.
  - `validateDeckState` gains an invariant so a hand-built state that violates it fails loudly in dev/test.
- **Residual risk:** The raw field can linger until the next explicit toggle. It is unreadable and unserialized, so lingering is inert.

---

### Design Decisions {#design-decisions}

#### [P01] Bullseye is session state on `DeckState`, never in the layout blob (DECIDED) {#p01-session-state-not-blob}

**Decision:** Add `bullseyePaneId?: string` to `DeckState` (`tugdeck/src/layout-tree.ts`) and deliberately omit it from `serialize()` (`tugdeck/src/serialization.ts`), following the precedent `hasFocus: boolean` already sets on the same interface ("Not serialized — session state only").

**Rationale:**
- It has to be in `DeckState` because `DeckState` **is** the `useSyncExternalStore` snapshot ([L02]) and the input to `arrangementSignature`. A separate module store would re-render nothing for free and would need the FLIP settle armed by hand from a second subscription.
- It must **not** be in the blob because bullseye is temporary by definition: persisting it means a crash or quit strands the user in a posture they never asked to keep, with no obvious gesture to leave it ([L23]).
- `serialize()` already lists its fields explicitly rather than spreading the state, so the omission is the default rather than an active strip. A unit test pins it anyway, because "the default" is exactly the kind of thing a later refactor to a spread would quietly undo.
- Bullseye is **data, not appearance**, by [L24]/[L06]'s own test — a non-rendering consumer (the Window menu's check mark and enablement gate) reads it. So it cannot be a DOM-only attribute set imperatively.

**Implications:**
- `DeckState`'s doc comment gains the field with the same "not serialized" note `hasFocus` carries.
- `deserialize()` never sets it; a reload always comes back un-bullseyed.
- `validateDeckState` gains invariant 8 (see [P05]).
- `arrangementSignature` gains a term, so entering and leaving bullseye arms the FLIP settle exactly as a slot change does.

#### [P02] Bullseye is a one-up placement at the comfy width — no new geometry (DECIDED) {#p02-one-up-placement}

**Decision:** A bullseyed pane's frame is `imposeStyle({ slot: 0, count: 1 }, bullseyeWidth, pinnedFrame)`, where `bullseyeWidth = resolveContentWidthPx(DEFAULT_CONTENT_WIDTH, sizePolicy.min.width, sizePolicy.max?.width)`.

**Rationale:**
- `travelFraction` already returns `0.5` for `count < 2` — one-up **means** "centered in the band, slack split evenly on both sides", and its docblock says so. Bullseye's centering requirement is one-up's existing definition, so writing new centering math would be writing a second one.
- The vertical run comes free and is the right answer: `imposeStyle` gives top gap to the deeper bottom gap, which is the maximum reading height. A short card centered on both axes in a receded deck reads as a dialog, not a writing surface.
- The width is `comfy` — `DEFAULT_CONTENT_WIDTH` in `layout-imposer.ts`, resolving to `CONTENT_WIDTH_COMFY_PX` (800) — clamped between the stack's `sizePolicy.min.width` and `sizePolicy.max?.width` by the same `resolveContentWidthPx` call `_setPaneWidth` makes. [D130]'s "no second opinion about width" holds: bullseye's width *is* comfy, not a fourth number.
- `pinnedFrame` is passed through unchanged so a size-locked card (About at 320×360) is *placed* by bullseye rather than stretched, exactly as [D121] already has the imposition place it.
- Every horizontal pin stays a `left` calc ([D121]), so entry and exit cross rather than cut.

**Implications:**
- No new function in `layout-imposer.ts`. The module is untouched by this plan.
- The bullseye branch is the **first** branch of `TugPane`'s geometry ternary, taking precedence over pinned and imposed. Precedence over pinned is defensive only (a rail cannot be bullseyed); precedence over imposed is a feature — a slotted card bullseyes to the center and returns to its slot on exit.
- A bullseyed pane renders **no** `data-imposed` attribute: it is not standing in its slot while bullseyed.
- When the band is narrower than the resolved width, `max(0px, band - width)` pins at the band's left edge and the pane overlaps the right rail. That is [D121]'s declared answer for an over-wide pane, and it is left alone ([Q02]).

#### [P03] Bullseye writes no geometry, so exit restores nothing (DECIDED) {#p03-no-geometry-writes}

**Decision:** Entering, holding, and leaving bullseye never call `movePane`, `centerPane`, `setPaneWidth`, or any other store mutation that touches a pane's `position`, `size`, `slot`, or `widthPreset`. The only state change is the `bullseyePaneId` field.

**Rationale:**
- `movePane` calls `notify()` and `scheduleSave()` **unconditionally**, and rewrites the width stamp: `if (opts?.widthPreset !== undefined) moved.widthPreset = opts.widthPreset; else if (s.size.width !== size.width) delete moved.widthPreset;`. So any width write on the way *in* either stamps a preset the user did not choose or deletes the stamp they did — and either way persists it.
- `centerPane` likewise calls `scheduleSave()`, and refuses derived panes outright (it bails on a `slot` or the Lens), so it could not serve a slotted card anyway.
- A snapshot-and-restore design would have to reproduce *four* fields exactly and survive every interleaving (a window resize, an allocator retune, a Layouts click) between entry and exit. Not writing them is strictly stronger than restoring them correctly.
- It is what makes [L23] hold trivially: there is no user-visible state to lose because none was taken.

**Implications:**
- The bullseyed pane's stored `position`/`size` are last-known values while bullseyed — the same status an imposed or pinned pane's already have (`pane-model.md`, "Three geometry modes").
- Anything that needs the truth measures the frame, which is already the rule for derived panes.
- `clampPanesToDeck` in `DeckManager.notify` keeps acting on the stored values, unchanged and harmlessly: those are the values the pane will return to.

#### [P04] Rails stay standing and recede with everything else (DECIDED — AMENDED IN IMPLEMENTATION) {#p04-rails-recede}

**Decision:** Bullseye does not hide, collapse, or unpin any sidebar rail. Rails stay at their pins and take the same deepened recede every other non-bullseyed pane takes.

**AMENDMENT (post-implementation).** The rails half of this held and is unchanged. The part that said *every other pane merely recedes* was wrong, and the built result proved it: a deck where nothing had moved did not read as distraction-free at any dim strength, because a dimmed card is still a card you can read. Every other **content** pane now leaves the canvas and returns on exit; rails alone stay standing and recede in place. The no-write rule is untouched — the displacement is one `left` override at render.

**Which side a pane leaves by took two attempts, and the second is the rule:** it is read **against the bullseyed card**, not against the canvas. Panes left of it go left, panes right of it go right. The first cut used the canvas centre, which let a card cross the bullseyed one — bullseye the leftmost card of a three-up and the middle card, still left of the canvas centre, slid left *through* the card arriving there. Sorting around the bullseyed card's own former place makes a crossing impossible by construction: every pane keeps the side it was already on, and relative order is preserved for the whole move. The reference is that pane's PRE-bullseye centre, which costs nothing to obtain because bullseye writes nothing — the pane still carries the slot and position it will return to. Accepted consequence: travel is no longer a short hop to the nearest edge, so a pane sitting just right of the bullseyed one but near the deck's left edge crosses the whole canvas on its way out.

**Rationale:**
- Collapsing a rail runs `allocateSidebarWidths` / `retuneSidebarAllocation` on both entry and exit — real layout churn on a gesture meant to be instant and repeatable, plus two more things whose exact restoration [L23] would then be on the hook for.
- The effect being borrowed from iA Writer comes from *recession*, not from reclaiming pixels. Comfy is 800px and the band holds that with both rails standing on any reasonable window.
- Because the bullseyed pane centers **in the band** (which is the canvas minus the rails and their gaps, by `resolveSpan` and the `--tug-imposer-inset-*` properties), it never overlaps a rail in the normal case — so no z-lift above `SIDEBAR_PANE_ZINDEX_BASE` (8990) is needed, and the pane keeps its ordinary array-order z. That is one fewer band to reason about against the overlay base at 9000.

**Implications:**
- No change to `sidebarRailsOf`, `allocateSidebarWidths`, or the z-index bands in `deck-canvas.tsx`.
- Rails are panes, so `.tug-pane:not([data-focused="true"])` selects them and the recede reaches them with no extra selector.
- **No free pane can paint over the bullseyed one, without a z-lift being added for it.** Bullseye requires focus ([P05]), and every raise path writes `activePaneId` *and* moves the pane to the end of the `panes` array in one commit — which is the z-order. So the bullseyed pane is by construction the most recently raised, and therefore holds the highest z among free panes for as long as it stays bullseyed. This is worth stating because it is the obvious question a reader asks after "you added no z-lift", and the answer is that the focus requirement already supplies one.

#### [P05] The bullseye id is derived on read, so focus-follows-ends-bullseye holds by construction (DECIDED) {#p05-derived-accessor}

**Decision:** The raw field is private to reads. `DeckManager.getBullseyePaneId()` — and the equivalent selector used by the render path — returns the stored id **only if** (a) a pane with that id exists in the current snapshot, and (b) that pane hosts the current first responder (`getFirstResponderCardId()`'s card is one of its `cardIds`). Otherwise it answers `null`. The accessor is a **pure function of the snapshot**: it never mutates, never notifies.

**Rationale:**
- Three of the four exit doors are "focus went somewhere else": clicking another pane, the ⌘R stack picker, ⌥⌘] depth rotation, a sidebar chord, and the canvas-background deselect (which clears `activePaneId`, making `getFirstResponderCardId()` return `null`). Deriving covers all of them and every path added later, where an event handler covers the ones its author remembered.
- It makes stale ids unreadable rather than merely unlikely, which is the whole of [R02]'s mitigation.
- Purity matters because the accessor runs during render. A lazily-self-clearing getter would be a mutation in the render path, and [L02] wants the snapshot stable across a render pass.

**Implications:**
- ~~The raw field may linger after focus moves. It is inert (nothing reads it) and is overwritten by the next toggle.~~ **CORRECTED IN IMPLEMENTATION.** A lingering raw id is *not* inert: the derivation only hides it while focus is elsewhere, so focusing away and focusing back makes it match again and the posture resurrects — one the user never re-asked for. `at0372`'s third exit door caught this. The fix keeps the derivation and adds one durable clear, `_clearBullseyeOnFocusFlip`, called from `_flipFirstResponder` — the single entry point for first-responder transitions, so it still costs nothing per focus path, which was the whole appeal of deriving. The derivation stays as the guard for the window before a flip commits and for hand-built states that never flip. `toggleBullseye` still compares against the **derived** value.
- **Bullseye survives within a multi-card pane.** The derivation asks whether the pane *hosts* the first responder, not whether one particular card holds it — so switching tabs, and closing one tab of several, both keep the posture. That is the right answer (the user is still working in the card they bullseyed) and it costs nothing, but it falls out of the derivation rather than being decided anywhere, so it is recorded here instead of left for a reader to test for.
- `validateDeckState` gains invariant 8: *when `bullseyePaneId` is set, it references a real pane, and that pane hosts no sidebar card.* It deliberately does **not** assert the first-responder relationship — that one is allowed to go stale, which is the point.
- The Window menu's check mark and the CSS both read the derived value, so they can never disagree with each other or with the geometry.

#### [P06] Any store write to a pane's position, size, or slot ends its bullseye (DECIDED) {#p06-geometry-gesture-exits}

**Decision:** The rule is stated over *what changed*, not over which caller changed it: **every `DeckManager` path that writes a pane's `position`, `size`, or `slot` clears `bullseyePaneId` when it names that pane.** It is implemented as one private helper, `_clearBullseyeFor(paneId)`, called from the three paths that can do so — enumerated in Table T02.

**Rationale:**
- It is the same rule the imposer already states: *any manual move or resize of a derived pane releases it from what was deriving its geometry* ([D121], and `pane-model.md`'s "drag or resize evicts it back to free"). A gesture that says "this pane is exactly this wide, here" and a posture that says "this pane is comfy, centered" cannot both be true, and the explicit gesture wins.
- **Stating it over the mutation rather than over the caller is the whole point.** An earlier draft of this decision named two call sites — `movePane` with `evictSlot: true`, and `_setPaneWidth` — and both halves were wrong. `evictSlot` is passed by the drag and resize commits but *not* by `_setPaneWidth`, so gating on it would have missed every width door; and `_setPaneWidth` reaches `movePane` anyway, so naming it separately was a second rule for one thing. Meanwhile two real mutators bypass `movePane` entirely and went unnamed. A rule written over call sites is a rule that goes stale the next time someone adds a mutator; written over the mutation, the audit question is "does this path write geometry?" and the answer is checkable.
- A single named helper rather than three inline conditions means `grep _clearBullseyeFor` lists every honoring site, which is what makes the rule enforceable at review time.
- Width is included because ⌃⌘1/2/3 during bullseye would otherwise be a chord that appears to do nothing: the store would take the new width while the frame kept painting at comfy.

**Table T02: Every path that writes pane geometry, and how it honors the rule** {#t02-geometry-writers}

| Path | Reached by | How it writes | Clear |
|---|---|---|---|
| `movePane` | Drag and resize commits (via `handlePaneMoved`, which is `this.movePane.bind(this)`), **and** `_setPaneWidth`, which is itself the single door under the title-bar popup, ⌃⌘1/2/3, and Window ▸ Slim/Comfy/Wide | Replaces `position` / `size`; deletes `slot` when `evictSlot` | Gated on the `positionChanged \|\| sizeChanged` locals it **already computes** — not on `evictSlot`, which `_setPaneWidth` never passes |
| `setContentWidth` | Lens ▸ Layouts ▸ Card Width | Builds the whole pane array inline and hands it to `_commitImposition` — deliberately one commit for the whole deck, so the FLIP settle measures once rather than re-arming per pane | Explicit call before the commit |
| `assignCardToSlot` | ⌘1–9 and the Lens slot picker | Detaches from a shared pane, raises, writes `slot` | Explicit call before the commit |

`arrangeCards` (Window ▸ Cascade / Tile) is **not** in this table because it no longer exists — both commands were removed with the Window-menu rework ([D129]). Named here only so a reader who remembers it does not go looking for a fourth site.

**Implications:**
- `movePane`'s `_unpinSidebar` early-return branch needs no clear: a rail can never be bullseyed, by the [P05] invariant and the handler's own gate.
- All three are internal `DeckManager` field writes folded into a state replacement that is about to be notified anyway — no extra `notify()`, no extra `scheduleSave()`.
- A unit test asserts the rule per path, so a fourth mutator arriving without a clear fails rather than shipping.

#### [P07] One selection-relative action now; the pane-addressed sibling is a follow-on (DECIDED) {#p07-one-action}

**Decision:** Ship a single action, `TUG_ACTIONS.TOGGLE_BULLSEYE = "toggle-bullseye"`, carrying no payload, routed `first-responder` and handled on `deck-canvas.tsx`.

**Rationale:**
- [D130] split `set-pane-width` (selection-relative, the chord and menu) from `set-card-width` (pane-addressed, the title-bar popup) because it had **two doors with different ideas of "which pane"**. Bullseye v1 has two doors that share one idea: the chord and the menu item both mean *the pane I am in*. A second action with no second caller is a layer nobody uses.
- The handler belongs on the deck canvas for [D130]'s stated reason, verbatim: it is the one responder that can name which pane the selection is in, and the chord walks past the focused card and its pane to get there.

**Implications:**
- If a title-bar bullseye control is ever added, it should introduce a pane-addressed `set-bullseye` taking `{ paneId }` and have `toggle-bullseye` dispatch to it — the exact shape `set-pane-width` → `set-card-width` has today. The `pane-model.md` amendment notes this so the split is designed rather than improvised.

#### [P08] The chord is ⌃⌘B, promoted to the Window menu with an empty Swift key equivalent (DECIDED) {#p08-chord}

**Decision:** ⌃⌘B, `menuEligible: true`, `mirrored: true`, `menuItemId: "window.bullseye"`, with the Swift `NSMenuItem` constructed with `keyEquivalent: ""`.

**Rationale:**
- **The tier, derived** (`chord-tiers.md`): a card's posture on the deck is Tug's own layout machinery, so it takes the Tug tier ⌃⌘ alongside ⌃⌘L Show Lens, ⌃⌘T Next Theme, and the ⌃⌘1/2/3 width row. Plain ⌘ is out under R3 — bullseye is a deliberate posture change, not a many-times-an-hour verb — and the composed sets are out under R1, because there is no ⌘B base for bullseye to be a variant or counterpart of (⌘B is explicitly *held in reserve* for bold in the free pool, and Tug renders markdown).
- **B is free on the tier.** The registry's current ⌃⌘ letters are A, C, F, G, H, I, J, K, L, M, P, T, U (plus digits 1–3). ⌃⌘B is not in the macOS reserved set either (⌃⌘Q lock screen, ⌃⌘D dictionary, ⌃⌘Space emoji, ⌃⌘F full screen).
- **R6 makes the menu half the grant.** Promoting it preempts every scoped binding on ⌃⌘B, and that is intended — bullseye is a deck-level posture, so no surface should be able to decline it. Nothing in the app claims ⌃⌘ letters outside the registry.
- Empty key equivalents so `applyCommandChords` writes the chord from the table and it stays rebindable — the discipline the sidebar toggles and the width row follow, and the shade toggles' known anomaly does not.

**Implications:**
- `chord-tiers.md` gains a short section. ⌃⌘⟨letter⟩ is currently documented as *the sidebar-toggle grammar*; the amendment states that the tier's letters carry Tug's layout and card-posture vocabulary generally, of which the sidebar toggles are one family — the same widening [D130] performed on the digit row.
- A checkbox-style check mark on the item, gated by the `bullseye` fact.

#### [P09] The recede deepens the existing inactive-content dim; it adds no scrim (DECIDED) {#p09-recede-not-scrim}

**Decision:** While bullseye is on, non-bullseyed panes take a deeper value of the two content-dim token pairs already driving `.tug-pane-chrome::before` (a `mix-blend-mode: saturation` layer) and `::after` (a lightness wash), selected by a `data-bullseye` attribute on the deck canvas's frames container. No new element, no `.tug-pane-scrim`, no pointer-events change.

**Rationale:**
- The bullseyed pane is **always** the focused pane, by [P05]'s derivation. So `.tug-pane:not([data-focused="true"])`, which already selects the dim layers, selects exactly "everything except the bullseyed pane" — the selector needed already exists and needs no new bit per pane.
- Reusing `.tug-pane-scrim` was considered and rejected: it is the **pane-modal** scrim (`pane-scrim-registry.ts`, `useTugPaneScrim()`), and its CSS flips pointer-events to block interaction. Bullseye must not be modal — clicking another pane is one of its exit doors, and a blocked click is a dead gesture instead of an exit.
- It keeps the recede inside the token system, so the six themes tune it the way they already tune the inactive dim, and `bun run audit:theme-contrast` covers it.

**Implications:**
- New token pair for the deeper values, named alongside the existing ones (`--tugx-pane-content-dim-*`), resolving to `--tug7-effect-card-*` primitives per the theme-engine doctrine. Defaults ride as `var(--x, default)` fallbacks at the point of use, never declared on the component's own element.
- The recede transitions, so app-test style assertions must not read a mid-flight interpolated value — assert geometry (which is what this feature is about) rather than the animating color.

---

### Deep Dives {#deep-dives}

#### How the four exit doors resolve {#exit-doors}

**Table T01: Exit doors and the mechanism that serves each** {#t01-exit-doors}

| Door | What the user does | Mechanism |
|---|---|---|
| Toggle | ⌃⌘B again, or Window ▸ Bullseye | `toggleBullseye` sees the derived value already names this pane and clears the field |
| Focus elsewhere | Clicks another pane's title bar or body; ⌘R picker; ⌥⌘]/[ depth pair; a sidebar chord; ⇧⌘]/[ lateral ring | The derived accessor ([P05]) stops matching, because the first responder's pane is no longer the stored one |
| Click outside | Pointerdown on bare canvas | `deselectActiveCard` clears `activePaneId`; `getFirstResponderCardId()` returns `null`; the derivation answers `null` |
| Resize or move | Drags or resizes the pane; presses ⌃⌘1/2/3; picks a width in the title bar | [P06] — `movePane` clears, gated on `positionChanged \|\| sizeChanged` |
| Re-place or re-width the deck | ⌘1–9 or the Lens slot picker; Lens ▸ Layouts ▸ Card Width | [P06] — `assignCardToSlot` and `setContentWidth` clear explicitly, because both bypass `movePane` |

Three doors are *derivations over focus* and two are *writes*. That split is deliberate: the derivations cover an open-ended set of future focus paths at no per-path cost, while the writes cover the mutation sites that would otherwise leave the store and the frame telling different stories. Table T02 in [P06] is the authoritative list of the write sites; this table is the user-facing view of the same rule.

#### Why the settle works without new motion code {#settle}

`deck-canvas.tsx` arms the FLIP settle from a **store subscriber**, not a layout effect, and it arms only when `arrangementSignature(state)` changes — the subscriber runs before the re-render it causes, which is the only place the frames' "First" rects can be measured. Adding `state.bullseyePaneId ?? ""` as a term makes entering and leaving bullseye exactly the kind of moment the settle exists for: the frames' container takes `data-imposer-settling`, session-card notifications are held for the window (the measured 81%-above-sum cost of a commit landing inside a transform animation), each moved frame gets its inverted transform tween from `lib/pane-flip.ts`, and every tween's inline `transform`/`transform-origin` is swept afterwards.

Three things follow, and all three are already true of the width presets, so none of them is new work:

- **Width is interpolated, not snapped.** `flipDelta` returns `{ dx, dy, sx }` and the tween is `springKeyframes(dx, dy, sx)` — a horizontal **scale** alongside the translate, with the skip guard reading `if (dx === 0 && dy === 0 && sx === 1) continue`. So bullseye's 511 → 800 crosses as smoothly as its position does, and this plan adds no motion code to get it. (An earlier draft of this document asserted the opposite. It was wrong, and the correction is recorded rather than silently applied, because "the settle only moves things" is a plausible enough belief to be re-derived by the next reader.)
- **The tween anchors at `transform-origin: 0 0`** — the left edge, which is the edge `dx` was measured between — and the frame therefore wears a `transform` for the length of the window. A transformed frame is transiently a containing block for its `position: fixed` descendants, which is exactly the hazard `clearFlipRef`'s comment documents and exactly why it strips `transform` *and* `transform-origin` afterwards. It is self-clearing and pre-existing, but it means Risk R01's sheet canary must be read **at rest**, after the settle window, not mid-flight.
- Under reduced motion (`isTugMotionEnabled()` false) there is no tween at all — the layout snap *is* the settle — and the arming path skips both the First measurement and the notification hold.

#### What the bullseye branch looks like in `TugPane` {#tug-pane-branch}

`components/chrome/tug-pane.tsx` currently resolves geometry in one ternary inside the frame's `style` prop, with `sidebarSide !== undefined` (pinned) first, `imposed && placement !== undefined` second, and stored `left/top/width/height` last. Bullseye becomes a new **first** branch. Three other sites in the same file move with it:

- `derivedRef` (currently `pinned || imposed`) must include bullseye. It is what tells the drag and resize machines to freeze the live rect at the threshold crossing and to pass `evictSlot: true` on the commit — without it, a drag on a bullseyed pane would jump the frame to its stale stored `position`.
- The `data-imposed` attribute stays gated on `imposed`, and must not be emitted while bullseyed.
- The width popup's `widthPreset` prop keeps reading `stackState.widthPreset` — the store's value, untouched by bullseye — so the popup and the Window menu keep showing the width the geometry will return to. That is [P03] made visible: a settled control shows what the store holds.

---

### Specification {#specification}

**Spec S01: `DeckState.bullseyePaneId`** {#s01-deck-state-field}

```ts
export interface DeckState {
  cards: readonly CardState[];
  panes: readonly TugPaneState[];
  activePaneId?: string;
  imposition: DeckImposition;
  hasFocus: boolean;
  /**
   * The pane standing in bullseye — centered in the band at the comfy
   * width, with every other pane receded. Session state only: deliberately
   * absent from `serialize()`, so a reload always comes back un-bullseyed.
   * Read through `getBullseyePaneId()` / the store selector, never
   * directly: the accessor derives, and a raw id may outlive the focus
   * that justified it.
   */
  bullseyePaneId?: string;
}
```

**Spec S02: the store surface** {#s02-store-surface}

| Symbol | Signature | Behavior |
|---|---|---|
| `DeckManager.toggleBullseye` | `(paneId: string) => void` | No-op if the pane is missing or hosts a sidebar card. Sets `bullseyePaneId` to `paneId`, or clears it when the **derived** value already equals `paneId`. Then `notify()`. **No `scheduleSave()`** — nothing persistable changed. |
| `DeckManager.getBullseyePaneId` | `() => string \| null` | The derivation of [P05]: pure, snapshot-only. |
| `bullseyePaneIdOf` (selector) | `(state: DeckState) => string \| null` | The same derivation as a free function over a snapshot, in `deck-store-selectors.ts`, for the render path. `getBullseyePaneId` delegates to it so there is one rule. |
| `IDeckManagerStore` | adds `toggleBullseye`, `getBullseyePaneId` | Alongside the existing `setPaneWidth` / `setContentWidth` entries. |

**Spec S03: the command entry** {#s03-command-entry}

```ts
{
  id: TUG_ACTIONS.TOGGLE_BULLSEYE,          // "toggle-bullseye"
  title: "Bullseye",
  routing: "first-responder",
  action: TUG_ACTIONS.TOGGLE_BULLSEYE,
  menuItemId: "window.bullseye",
  mirrored: true,
  bindings: [chord({ key: "KeyB", meta: true, ctrl: true }, { menuEligible: true })],
  validate: (chain) => chain.menu.bullseye !== null,
  state:    (chain) => chain.menu.bullseye?.on === true,
}
```

**Spec S04: the `bullseye` menu fact** {#s04-menu-fact}

`CommandMenuFacts` gains `readonly bullseye: { readonly on: boolean } | null`, `null` in `EMPTY_MENU_FACTS`. `lib/host-menu-state.ts` computes it beside `cardWidth`, reusing the **same two gates** the width row and the title-bar popup already share — a pane is selected, and it is not a rail:

```ts
const bullseye =
  state.activePaneId === undefined || focusedStack === null || focusedIsRail
    ? null
    : { on: bullseyePaneIdOf(state) === focusedStack.id };
```

Like `cardWidth`, it is module-internal to the projection and rides the per-command gate mirror rather than the wire.

**Spec S05: the deck-canvas handler** {#s05-canvas-handler}

Registered in the same handler map as `SET_PANE_WIDTH`, and added to `DECK_CANVAS_VALIDATED_ACTIONS`. Every failure is a **silent return**, matching the width handler's discipline — a chord on a deselected deck or a rail should do nothing, not warn and not beep.

```ts
[TUG_ACTIONS.TOGGLE_BULLSEYE]: (_event: ActionEvent) => {
  const deck = store.getSnapshot();
  const cardId = store.getFirstResponderCardId();
  if (cardId === null) return;
  const pane = deck.panes.find((p) => p.cardIds.includes(cardId));
  if (!pane) return;
  if (pane.cardIds.some((cid) => {
        const card = deck.cards.find((c) => c.id === cid);
        return card !== undefined && isSidebarCard(card.componentId);
      })) return;
  store.toggleBullseye(pane.id);
},
```

#### State Zone Mapping {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `bullseyePaneId` | structure (data) | `DeckState` field on the store; React reads it through `useSyncExternalStore` on `DeckManagerContext` | [L02], [L24] — a non-rendering consumer (the menu gate and check mark) reads it, so it is data, not appearance |
| The bullseyed pane's frame rect | appearance (derived) | CSS `left`/`width`/`top`/`bottom` from `imposeStyle`, resolved against `--tug-imposer-inset-*` | [L06], [L09] — geometry is CSS-derived, never observed; TugPane owns the frame |
| `data-bullseye` on the frames container | appearance | React-rendered attribute on the `containerRef` div in `deck-canvas.tsx`, derived from the store value | [L06] — the attribute is the selector hook; the dim itself is pure CSS |
| The deepened recede | appearance | `--tugx-pane-content-dim-*` token values on the existing `::before`/`::after` layers | [L06], [D128]-adjacent theme-engine doctrine |
| The entry/exit motion | appearance | The existing FLIP settle, armed by an `arrangementSignature` term | [L06], [L13] — motion is `TugAnimator`, never a React state machine |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tests/app-test/at0372-bullseye.test.ts` | End-to-end cover: enter, the no-write claim, four exit doors, rail inertness, imposed-pane return |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `DeckState.bullseyePaneId` | field | `tugdeck/src/layout-tree.ts` | Optional; documented "not serialized", per Spec S01 |
| invariant 8 | validation | `tugdeck/src/layout-tree.ts` (`validateDeckState`) | Set id references a real pane hosting no sidebar card |
| `bullseyePaneIdOf` | fn | `tugdeck/src/deck-store-selectors.ts` | The [P05] derivation over a snapshot |
| `DeckManager.toggleBullseye` | method | `tugdeck/src/deck-manager.ts` | Spec S02; notify, no save |
| `DeckManager.getBullseyePaneId` | method | `tugdeck/src/deck-manager.ts` | Delegates to the selector |
| `IDeckManagerStore` | interface | `tugdeck/src/deck-manager-store.ts` | Adds both members |
| `DeckManager._clearBullseyeFor` | method | `tugdeck/src/deck-manager.ts` | [P06]'s one implementation; private |
| `DeckManager.movePane` | method | `tugdeck/src/deck-manager.ts` | [P06] / Table T02: call the helper, gated on `positionChanged \|\| sizeChanged` |
| `DeckManager.setContentWidth` | method | `tugdeck/src/deck-manager.ts` | [P06] / Table T02: call the helper — bypasses `movePane` |
| `DeckManager.assignCardToSlot` | method | `tugdeck/src/deck-manager.ts` | [P06] / Table T02: call the helper — bypasses `movePane` |
| `serialize` | fn | `tugdeck/src/serialization.ts` | Unchanged in behavior; gains a comment naming the omission |
| `TUG_ACTIONS.TOGGLE_BULLSEYE` | const | `tugdeck/src/components/tugways/action-vocabulary.ts` | `"toggle-bullseye"`, with the payload docblock the neighbors carry |
| `registerAction(TOGGLE_BULLSEYE)` | registration | `tugdeck/src/action-dispatch.ts` | Bare `dispatchCommand(TUG_ACTIONS.TOGGLE_BULLSEYE)` round-trip for the host control message |
| `DECK_CANVAS_VALIDATED_ACTIONS` | const | `tugdeck/src/components/chrome/deck-canvas.tsx` | Add `TOGGLE_BULLSEYE` |
| bullseye handler | handler | `tugdeck/src/components/chrome/deck-canvas.tsx` | Spec S05 |
| `arrangementSignature` | fn | `tugdeck/src/components/chrome/deck-canvas.tsx` | Add the bullseye term |
| `BULLSEYE_COMMAND` | entry | `tugdeck/src/components/tugways/command-registry.ts` | Spec S03 |
| `CommandMenuFacts.bullseye` | field | `tugdeck/src/components/tugways/command-registry.ts` | Spec S04, plus `EMPTY_MENU_FACTS` |
| `bullseye` projection | fn | `tugdeck/src/lib/host-menu-state.ts` | Spec S04; beside `cardWidth`, same two gates |
| `TugPaneProps.bullseye` | prop | `tugdeck/src/components/chrome/tug-pane.tsx` | `boolean`; the geometry branch, `derivedRef`, `data-bullseye` |
| `--tugx-pane-content-dim-*-bullseye` | tokens | `tugdeck/src/components/tugways/tug-pane.css` | The deepened pair, per [P09] |
| `toggleBullseye(_:)` | selector | `tugapp/Sources/AppDelegate.swift` | `sendControl("toggle-bullseye")` |
| `window.bullseye` | menu item | `tugapp/Sources/AppDelegate.swift` | Window menu, empty key equivalent |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/design-decisions.md` — **D131**, the bullseye decision: a temporary presentation over any geometry mode, never a fourth stored mode.
- [ ] `tuglaws/pane-model.md` — a section under "Three geometry modes" naming bullseye as a presentation *over* a mode, the no-write rule, the derived-exit rule, and the containing-block constraint from [R01].
- [ ] `tuglaws/chord-tiers.md` — the ⌃⌘B grant and the widening of the ⌃⌘⟨letter⟩ reading from "the sidebar-toggle grammar" to Tug's layout and card-posture vocabulary; update the tier-occupancy note.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** (`bun test`) | The derivation, the toggle, the invariant, the serialization omission | Store-layer steps |
| **App-test** (`just app-test at0372-…`) | The painted frame, the four exit doors, rail inertness, the store's untouched record | The end-to-end claim |
| **Drift prevention** | `command-routing-drift.test.ts` gains the ⌃⌘B row | Chord table stability |

#### What stays out of tests {#test-non-goals}

- **The recede's exact color.** It is a themed, transitioning value; a style assertion mid-flight returns an interpolated `oklab(...)` and would be a flake generator. The app-test asserts geometry; the theme-contrast audit covers the tokens.
- **The FLIP tween's intermediate frames.** Motion is `TugAnimator`'s, background app-test windows run no rAF, and an assertion hung on an animation's mid-state is the pattern the harness doctrine bans. Assert the settled rect after the settle window.
- **A jsdom render test of the geometry branch.** The claim is about a painted frame in the real app; a fake-DOM render proves nothing about `imposeStyle`'s calc resolving against live insets.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Store: the bullseye field, its derivation, and its exits | done | `82f0949b2` |
| #step-2 | Command: action, dispatch, canvas handler, registry, menu fact | done | `be8a9a550` |
| #step-3 | Render: the bullseye geometry branch | done | `f6739b575` |
| #step-4 | Recede: deepen the inactive-content dim | done | `791abf390` |
| #step-5 | Host: Window ▸ Bullseye | done | `f6adbb0ef` |
| #step-6 | Doctrine: D131, pane-model, chord-tiers | done | `122e0a9e9` |
| #step-7 | App-test: at0372 | done | `6df5afd24` |
| #step-8 | Integration Checkpoint | done | `daf315dcd` |

---

#### Step 1: Store — the bullseye field, its derivation, and its exits {#step-1}

**Commit:** `tugdeck(bullseye): session-only bullseyePaneId with a derived accessor`

**References:** [P01] Session state not blob, [P03] No geometry writes, [P05] Derived accessor, [P06] Geometry gestures exit, Spec S01, Spec S02, Risk R02, Table T02, (#p01-session-state-not-blob, #p05-derived-accessor, #t02-geometry-writers, #exit-doors)

**Artifacts:**
- `DeckState.bullseyePaneId` and `validateDeckState` invariant 8 in `tugdeck/src/layout-tree.ts`
- `bullseyePaneIdOf` in `tugdeck/src/deck-store-selectors.ts`
- `toggleBullseye` / `getBullseyePaneId` on `DeckManager` and `IDeckManagerStore`
- `_clearBullseyeFor` and its three call sites (Table T02): `movePane`, `setContentWidth`, `assignCardToSlot`
- A comment on `serialize()` naming the deliberate omission

**Tasks:**
- [ ] Add `bullseyePaneId?: string` to `DeckState` with the Spec S01 docblock. Model the "not serialized — session state only" wording on the `hasFocus` field directly above it.
- [ ] Add invariant 8 to `validateDeckState` and to the numbered list in its docblock: when set, the id references a real pane, and that pane hosts no sidebar card. Do **not** assert the first-responder relationship — [P05] allows the raw id to go stale, and asserting it would throw on the normal path.
- [ ] Add `bullseyePaneIdOf(state: DeckState): string | null` to `deck-store-selectors.ts`, beside `findSidebarPanes` / `slotStackOf`. Pure: returns `state.bullseyePaneId` only when a pane with that id exists **and** its `cardIds` contains the card `activePaneId`'s pane names as active. Reproduce `getFirstResponderCardId`'s rule (`activePaneId` → that pane's `activeCardId`) rather than importing the manager.
- [ ] Add `getBullseyePaneId()` to `DeckManager`, delegating to the selector over `this.deckState`, and `toggleBullseye(paneId)` per Spec S02 — refuse a missing pane and a sidebar-hosting pane, compare against the **derived** value, `notify()` and **not** `scheduleSave()`.
- [ ] Declare both on `IDeckManagerStore` (`deck-manager-store.ts`), near `setPaneWidth` / `setContentWidth`, with doc comments.
- [ ] Add the private helper `_clearBullseyeFor(paneId: string): void` — clears `bullseyePaneId` when it equals `paneId`, and does nothing otherwise. One named site so `grep _clearBullseyeFor` lists every path honoring [P06].
- [ ] Call it from the **three** paths in Table T02, and no others:
      - `movePane`, gated on the `positionChanged || sizeChanged` locals the function **already computes** — *not* on `evictSlot`, which `_setPaneWidth` never passes. This one call covers drag, resize, and all four width doors, because `handlePaneMoved` is `this.movePane.bind(this)` and `_setPaneWidth` delegates here.
      - `setContentWidth`, which builds its pane array inline and hands it to `_commitImposition`, bypassing `movePane` entirely (deliberately — one commit for the whole deck, so the FLIP settle measures once).
      - `assignCardToSlot`, which writes `slot` on its own path.
      Fold each into the state replacement that path already makes; add no second `notify()` and no `scheduleSave()`.
- [ ] Do **not** add a clear to `_setPaneWidth` itself. It reaches `movePane`, so a clear there would be a second rule for one thing — and the one that would go stale first.
- [ ] Add the `arrangementSignature` bullseye term in `deck-canvas.tsx` (`${state.bullseyePaneId ?? ""}`), and extend its docblock with one sentence saying why: bullseye moves and resizes a derived frame, so it is exactly the kind of moment the settle exists for.
- [ ] Add a sentence to `serialize()`'s docblock naming `bullseyePaneId` alongside the existing `focusedCardId` note, so a later refactor to a spread meets the reason first.

**Tests:**

> There is **no dedicated `deck-manager.test.ts` or `serialization.test.ts`** in this repo — a fact worth knowing before hunting for one. `validateDeckState` and `serialize()` are both exercised from `tugdeck/src/__tests__/layout-tree.test.ts`, the selectors from `tugdeck/src/__tests__/deck-store-selectors.test.ts`, and `tugdeck/src/__tests__/boot-faithful-restore.test.ts` is the precedent for constructing a real `DeckManager` inside a bun test (it is the only file that does `new DeckManager`). Put each assertion in the file that already owns its subject rather than opening a new suite.

- [ ] `layout-tree.test.ts`: `validateDeckState` throws for a `bullseyePaneId` naming a missing pane, and for one naming a sidebar-hosting pane; accepts a stale-but-real id whose pane no longer holds focus.
- [ ] `layout-tree.test.ts`: `serialize()`'s output key set is exactly `version`, `cards`, `panes`, `imposition` (plus `activePaneId` when set) even with `bullseyePaneId` set on the input state.
- [ ] `deck-store-selectors.test.ts`: `bullseyePaneIdOf` returns `null` when the pane was removed, when `activePaneId` is undefined, and when focus moved to another pane — and returns the id when focus is on the pane.
- [ ] A `DeckManager` suite following `boot-faithful-restore.test.ts`'s construction pattern: `toggleBullseye` sets, re-toggles off, refuses a rail pane, refuses an unknown id.
- [ ] The same suite, **one case per Table T02 row** — `movePane` (both a drag-shaped call with `evictSlot: true` and a width-shaped call without it, since gating on `evictSlot` is the mistake this test exists to catch), `setContentWidth`, and `assignCardToSlot` each clear bullseye for their target pane and leave it alone for a different one. Also assert that a `movePane` call changing *neither* position nor size (a no-op commit) leaves bullseye standing.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bun test src/__tests__/layout-tree.test.ts src/__tests__/deck-store-selectors.test.ts`

---

#### Step 2: Command — action, dispatch, canvas handler, registry, menu fact {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(bullseye): toggle-bullseye command on ⌃⌘B with the Window menu fact`

**References:** [P07] One action, [P08] The chord, Spec S03, Spec S04, Spec S05, [D130] the width row's shape, [L30] every command is a registry entry, (#s03-command-entry, #s04-menu-fact, #s05-canvas-handler)

**Artifacts:**
- `TUG_ACTIONS.TOGGLE_BULLSEYE` and its payload docblock
- The `action-dispatch.ts` registration
- The deck-canvas handler and its `DECK_CANVAS_VALIDATED_ACTIONS` entry
- The registry command and the `bullseye` menu fact
- The `host-menu-state.ts` projection field

**Tasks:**
- [ ] Add `TOGGLE_BULLSEYE: "toggle-bullseye"` to `TUG_ACTIONS` in `action-vocabulary.ts`, with a payload docblock in the neighbors' style: no payload; deck-level; put the SELECTED card's pane in bullseye, or take it out; the handler lives on the deck canvas because it owns the layout tree.
- [ ] Register the action in `action-dispatch.ts` so the host control message round-trips: `registerAction(TUG_ACTIONS.TOGGLE_BULLSEYE, () => { dispatchCommand(TUG_ACTIONS.TOGGLE_BULLSEYE); })`. Model the comment on the `set-pane-width` registration directly above — the round-trip keeps the "which pane am I in" answer on the canvas, where the chord lands too.
- [ ] Add `TUG_ACTIONS.TOGGLE_BULLSEYE` to `DECK_CANVAS_VALIDATED_ACTIONS`.
- [ ] Add the handler from Spec S05 to the deck-canvas handler map, immediately after `SET_PANE_WIDTH`, with a comment carrying [P07]'s reasoning.
- [ ] Add the registry command from Spec S03 to `COMMANDS` in `command-registry.ts`, in the Window group beside `CARD_WIDTH_COMMANDS`, with a docblock deriving the tier per [P08].
- [ ] Add `bullseye: { on: boolean } | null` to `CommandMenuFacts` and `null` to `EMPTY_MENU_FACTS`.
- [ ] Compute it in `lib/host-menu-state.ts` beside `cardWidth` per Spec S04, reusing the already-computed `focusedIsRail`; add it to the projection interface, the returned object, and the destructure + `facts` literal in the flush.
- [ ] Run the chord-collision lint (`lintChordCollisions` runs in the registry's own test) and confirm ⌃⌘B is clean.

**Tests:**
- [ ] Unit: `command-routing-drift.test.ts` gains the ⌃⌘B row for `toggle-bullseye`, alongside the ⌃⌘1/2/3 rows.
- [ ] Unit: the `bullseye` fact is `null` with nothing selected and with a rail focused, and `{ on: false }` / `{ on: true }` for a content pane out of and in bullseye.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bun test src/components/tugways/__tests__`
- [ ] `dispatchCommand("toggle-bullseye")` from the dev console flips `getBullseyePaneId()` for the focused pane (nothing renders differently yet — that is #step-3)

---

#### Step 3: Render — the bullseye geometry branch {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(bullseye): center the bullseyed pane at comfy via a one-up placement`

**References:** [P02] One-up placement, [P03] No geometry writes, [P04] Rails recede, [D121] the imposer never sizes, [L09] TugPane owns geometry, (#tug-pane-branch, #settle)

**Artifacts:**
- `TugPaneProps.bullseye` and the geometry branch in `tug-pane.tsx`
- `derivedRef` and `data-imposed` adjustments
- `data-bullseye` on the pane frame and on the frames container in `deck-canvas.tsx`

**Tasks:**
- [ ] Add `bullseye?: boolean` to `TugPaneProps` with a docblock: the pane stands in bullseye — centered in the band at comfy, over the full run — and it takes precedence over both derived modes.
- [ ] In `TugPane`, compute `const bullseyeWidth = resolveContentWidthPx(DEFAULT_CONTENT_WIDTH, sizePolicy.min.width, sizePolicy.max?.width)` next to the existing `slotWidth` computation, and make the frame `style` ternary's **first** branch `bullseye ? imposeStyle({ slot: 0, count: 1 }, bullseyeWidth, pinnedFrame) : …`. Extend the existing three-mode comment above the ternary to four, naming bullseye as a presentation over a mode rather than a mode of its own.
- [ ] Change `derivedRef` to `pinned || imposed || bullseye` (both the initializer and the per-render assignment), and note in its comment that a bullseyed pane's stored rect is stale for the same reason the other two are, so the drag freeze and the `evictSlot` commit apply to it.
- [ ] Keep `data-imposed` gated on `imposed && !bullseye`, and emit `data-bullseye` (empty string) on the frame when bullseyed.
- [ ] In `deck-canvas.tsx`, read the bullseye id once per render (`bullseyePaneIdOf(deckState)`), pass `bullseye={bullseyePaneId === stackState.id}` into each `<TugPane>` beside `placement`, and put `data-bullseye` on the `containerRef` div when the id is non-null.
- [ ] Leave the title bar's `widthPreset` prop reading `stackState.widthPreset` — untouched by bullseye on purpose ([P03]).

**Tests:**
- [ ] Deferred to #step-7 — the claim is about a painted frame against live insets, which is an app-test claim and not a render-test one (#test-non-goals).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just build-app` then, by hand in the running app: focus a card, `dispatchCommand("toggle-bullseye")` or ⌃⌘B, and confirm the frame crosses to 800px centered in the band over the full run — and crosses back on a second press, to the pixel

---

#### Step 4: Recede — deepen the inactive-content dim {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(bullseye): recede every other pane while one stands in bullseye`

**References:** [P09] Recede not scrim, [P04] Rails recede, Risk R01, [L06] appearance through CSS, (#p09-recede-not-scrim, #r01-recede-containing-block)

**Artifacts:**
- The deepened token pair and the `[data-bullseye]` selectors in `tug-pane.css`

**Tasks:**
- [ ] Add the deeper values as tokens next to `--tugx-pane-content-dim-desat-amount` and `--tugx-pane-content-dim-wash-color` in the alias block at the head of `tug-pane.css`, resolving to `--tug7-effect-card-*` primitives. Follow the CSS-knob rule: any default rides as a `var(--x, default)` fallback at the point of use.
- [ ] Add the two selectors, scoped under the container attribute, overriding only the two properties the deeper values change:
      `[data-bullseye] .tug-pane:not([data-focused="true"]) .tug-pane-chrome::before { opacity: … }` and the `::after` wash counterpart.
- [ ] Add `transition` on those two properties so the recede fades in and out with the settle rather than cutting, and name `--tugx-imposer-settle-duration` as its timing source so one knob retimes both.
- [ ] Update the `@tug-renders-on` / token-table comment block at the head of the file with the new tokens, matching the existing rows' format.
- [ ] Do **not** add `filter`, `transform`, `will-change`, or `contain` anywhere on `.tug-pane` — Risk R01.

**Tests:**
- [ ] `bun run audit:theme-contrast` — no theme exceeds the `brio` accessibility budget with the new tokens.

**Checkpoint:**
- [ ] `cd tugdeck && bun run audit:theme-contrast`
- [ ] `cd tugdeck && bunx vite build`
- [ ] By hand, the Risk R01 canary, read **at rest**: bullseye a card, wait out the settle window, *then* open a `TugSheet` on it and confirm the sheet is positioned correctly. Mid-settle the frame legitimately wears the FLIP tween's `transform` and is transiently a containing block for `position: fixed` (see #settle) — reading the canary mid-flight would report a pre-existing, self-clearing transient as a regression
- [ ] By hand: confirm every other pane and both rails read as receded while staying clickable

---

#### Step 5: Host — Window ▸ Bullseye {#step-5}

**Depends on:** #step-2

**Commit:** `tugapp(bullseye): Window ▸ Bullseye with an empty key equivalent`

**References:** [P08] The chord, Spec S03, Spec S04, [D130] the width row's Swift shape, (#p08-chord)

**Artifacts:**
- The `window.bullseye` menu item and `toggleBullseye(_:)` selector in `AppDelegate.swift`

**Tasks:**
- [ ] In the Window menu construction, add the item after the Slim/Comfy/Wide group and before the pane-list anchor separator: `NSMenuItem(title: "Bullseye", action: #selector(toggleBullseye(_:)), keyEquivalent: "").identified("window.bullseye")`. Add a separator above it if the width group and the posture item read as different families.
- [ ] Add the selector beside `setCardWidthFromMenu`: `@objc private func toggleBullseye(_ sender: Any) { sendControl("toggle-bullseye") }`, with a doc comment noting that the check mark and enablement ride the registry gate on the `menuState` push.
- [ ] Leave the key equivalent **empty** — `applyCommandChords` writes ⌃⌘B from the registry, which is what keeps it rebindable end to end.

**Tests:**
- [ ] Covered by `at0181-keymap-chord-sweep` for the swept key equivalent, which is where the width row's Swift half is pinned too. #step-7 does not claim `AppDelegate.swift`.

**Checkpoint:**
- [ ] `just build-app`
- [ ] Window ▸ Bullseye shows ⌃⌘B beside it, is checked while a card is bullseyed, and is disabled with the Lens focused or nothing selected

---

#### Step 6: Doctrine — D131, pane-model, chord-tiers {#step-6}

**Depends on:** #step-3, #step-5

**Commit:** `tuglaws(bullseye): D131 — a temporary presentation over any geometry mode`

**References:** [P01]–[P09], [D121] the imposer's geometry, [D128] roles and widths, [D130] the width doors, [L23] state preservation, (#design-decisions, #exit-doors)

**Artifacts:**
- **D131** in `tuglaws/design-decisions.md`
- A bullseye section in `tuglaws/pane-model.md`
- The ⌃⌘B grant in `tuglaws/chord-tiers.md`

**Tasks:**
- [ ] Write **D131** in `design-decisions.md`, in the Cards & Layout group after D130, in the house voice — a full-paragraph decision that states: bullseye is a *presentation* layered over whichever geometry mode a pane already holds, never a fourth stored mode; it writes no geometry, so exit restores nothing ([P03]); its frame is a one-up placement at comfy, which is `imposeStyle`'s existing definition of centered-in-the-band rather than new math ([P02]); rails stand and recede rather than collapsing ([P04]); the focus-shaped exits are a *derivation* over the first responder rather than an event handler, so future focus paths cost nothing ([P05]); the geometry-shaped exits are stated over **what changed rather than which caller changed it**, following the imposer's own "a manual gesture releases a derived pane" rule ([P06], Table T02); and the chord is ⌃⌘B on the Tug tier with the Window menu as R6's half of the grant ([P08]). Close with the file/symbol list and the law cross-refs, matching D130's closing form.
- [ ] Amend `pane-model.md` under "Three geometry modes": a short section stating that the three modes remain mutually exclusive and bullseye is not a fourth — it is a presentation that *supersedes* whichever one a pane holds, for as long as the pane holds focus. Name the no-write rule, the four exit doors, the containing-block constraint from Risk R01, and the pane-addressed follow-on shape from [P07]. Add the new files to the Files table and D131 to the Cross-Links line.
- [ ] Amend `chord-tiers.md`: widen the "The sidebar-toggle grammar" framing so ⌃⌘⟨letter⟩ reads as Tug's layout and card-posture vocabulary, of which the sidebar toggles are one family — the same widening D130 performed on the digit row, and for the same reason (stated narrowly, it made the next honest grant underivable). Add a short "The bullseye chord" section deriving ⌃⌘B per [P08], and update the tier-occupancy note (⌃⌘ letters now include B).

**Tests:**
- [ ] N/A (documentation)

**Checkpoint:**
- [ ] Every `[D131]` / `[P##]` cross-reference in the three files resolves to a real anchor
- [ ] `chord-tiers.md`'s occupancy list matches the registry's actual ⌃⌘ letters (A B C F G H I J K L M P T U)

---

#### Step 7: App-test — at0372 {#step-7}

**Depends on:** #step-4, #step-5

**Commit:** `test(bullseye): at0372 covers entry, the no-write claim, and all four exits`

**References:** [P01] Session state not blob, [P02] One-up placement, [P03] No geometry writes, [P05] Derived accessor, [P06] Geometry gestures exit, Table T01, (#success-criteria, #t01-exit-doors)

**Artifacts:**
- `tests/app-test/at0372-bullseye.test.ts`

**Tasks:**
- [ ] Write the docblock in at0371's style: what the assertions are chosen to catch, and what the fixture deliberately cannot prove. State plainly that the load-bearing claim is **the no-write one** — a probe that centered the pane by writing `position` would pass every geometry assertion and fail only the store-record one.
- [ ] Declare `@covers` for `tugdeck/src/components/chrome/deck-canvas.tsx`, `tugdeck/src/components/chrome/tug-pane.tsx`, `tugdeck/src/deck-manager.ts`, `tugdeck/src/deck-store-selectors.ts`, `tugdeck/src/layout-tree.ts`, `tugdeck/src/components/tugways/command-registry.ts`, `tugdeck/src/components/tugways/action-vocabulary.ts`, `tugdeck/src/action-dispatch.ts`, `tugdeck/src/lib/host-menu-state.ts`.
- [ ] Seed a deck shape in at0371's idiom: two content panes at a width no preset resolves to (at0371 uses 511) plus a Lens at a distinct width (412), so a pane that moved because something reached every pane is unmistakable from one that did not move.
- [ ] Assert entry: press ⌃⌘B natively, wait the settle window (at0371 uses 900ms for `IMPOSITION_SETTLE_MS` plus tween headroom), then read `getBoundingClientRect()` on the frame — width 800, and centre-x equal to the band's centre computed from the container rect and the resolved `--tug-imposer-inset-*` values.
- [ ] Assert the no-write claim **while bullseyed**: read the pane record out of the live store via `evalJS` and confirm `size.width === 511`, `position` unchanged, `slot` unchanged, `widthPreset` unchanged. (Mind the backtick gotcha — a backtick anywhere in an `evalJS` string, comments included, ends the template literal.)
- [ ] Assert **every** exit door in Table T01 — one case per row — returns the frame to a rect pixel-identical to the pre-bullseye one: a second ⌃⌘B; clicking the other pane's title bar; a canvas-background click; a ⌃⌘1 width press (which must land the pane at slim 675 at its **stored** position, not at comfy centered); and a Lens ▸ Layouts ▸ Card Width change (the `setContentWidth` path, which bypasses `movePane` and is the row a call-site-shaped implementation would miss).
- [ ] Assert rail inertness: focus the Lens, press ⌃⌘B, confirm its frame rect is unchanged.
- [ ] Assert the imposed case: on a `three-up` seed, bullseye a slotted pane and confirm the exit rect equals the slot anchor rect it held before.
- [ ] Run `just app-test-covers-check` and fix any unresolvable `@covers` path.

**Tests:**
- [ ] The file itself.

**Checkpoint:**
- [ ] `just app-test-covers-check`
- [ ] `just app-test at0372-bullseye.test.ts` — read the printed report bare; never pipe it into `grep`/`head`/`tail`

---

#### Step 8: Integration Checkpoint {#step-8}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P01]–[P09], (#success-criteria, #exit-doors)

**Tasks:**
- [ ] Verify every success criterion in #success-criteria against the running app, not just the test suite.
- [ ] Confirm the persisted blob is clean after a full bullseye cycle: `just db-inspect` the tugbank defaults row for `dev.tugtool.deck.layout` (never point `sqlite3` at a live ledger) and confirm no bullseye key and no changed pane width.
- [ ] Quit and relaunch while bullseyed; confirm the deck comes back un-bullseyed with every pane at its pre-bullseye geometry.
- [ ] Confirm the width popup and Window ▸ Slim/Comfy/Wide still check the width the **store** holds while a pane is bullseyed at comfy — the [P03] tell.

**Tests:**
- [ ] `just app-test-changed` — the derived selection across everything this plan touched.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun run audit:theme-contrast`
- [ ] `just build-app`
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** ⌃⌘B and Window ▸ Bullseye put the focused content card in a centered, comfy-width reading posture with every other surface receded, and take it back out — writing nothing to the store's geometry and nothing to the persisted layout blob.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Entry paints the frame at comfy, centered in the band, over the full vertical run (`at0372`)
- [ ] The store's `position` / `size` / `slot` / `widthPreset` are untouched throughout (`at0372`, and the serialization unit test)
- [ ] All four exit doors return the frame to its exact prior rect (`at0372`)
- [ ] A rail cannot be bullseyed and the menu item is disabled for one (`at0372`, menu-fact unit test)
- [ ] A reload while bullseyed comes back un-bullseyed with geometry intact (#step-8)
- [ ] D131, the `pane-model.md` section, and the `chord-tiers.md` grant are written (#step-6)
- [ ] `bunx tsc --noEmit`, `bunx vite build`, `audit:theme-contrast`, and `just app-test-changed` all clean

**Acceptance tests:**
- [ ] `just app-test at0372-bullseye.test.ts`
- [ ] `cd tugdeck && bun test src/__tests__/layout-tree.test.ts src/__tests__/deck-store-selectors.test.ts src/components/tugways/__tests__`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] A title-bar bullseye control, which introduces the pane-addressed `set-bullseye` sibling described in [P07]
- [ ] A per-card width override for bullseye (bullseye at slim for a narrow reference card), if comfy proves wrong for some card types
- [ ] Deepening the recede further under an accessibility preference, or offering "recede off" for users who find the dim distracting
- [ ] A caret-centering (typewriter) posture inside the composer, which is an editor concern and would be its own plan

| Checkpoint | Verification |
|------------|--------------|
| Store writes nothing | `serialize()` key-set unit test + `at0372`'s live store read |
| Geometry is the imposer's | `at0372` band-centre assertion against the live `--tug-imposer-inset-*` |
| Exits are complete | `at0372`, one case per Table T01 row; the `DeckManager` suite, one case per Table T02 row |
| The chord is a registry fact | `command-routing-drift.test.ts` row + `at0181-keymap-chord-sweep` |
| No containing-block regression | Sheet-on-a-bullseyed-card canary (#step-4) |

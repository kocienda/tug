# Layout Imposer — Five Features, One Brief

Initial investigation of the five feature ideas in `layout-imposer-notes.md`: **A** multi-select in the Lens Cards section, **B** relative slot moves, **C** always-animated layout changes, **D** a *flow* layout mode alongside *fit*, **E** vertical splits for content cards. Each section records what the code does today, where the friction is, and a sketched approach. An ordering proposal closes the brief.

## The ground today

A one-paragraph orientation, since every feature below leans on it. The imposer (`tugdeck/src/lib/layout-imposer.ts`) is pure geometry: a slot is a **position anchor**, not a rect — `offset = k/(N−1) × max(0, band − width)`, where the band is the space between the rail insets. No width is ever computed by the imposer; when cards are wider than their share they **overlap**, by design. Width presets (675/800/1230) are commands that set `pane.size.width`; the space allocator flexes only the *rail* widths. Geometry reaches the DOM as a single inline `left` calc plus `width`/`top`/`bottom` — window resize is pure CSS reflow, zero per-frame JS. Motion is measured FLIP through TugAnimator: `arrangementSignature` (deliberately z-blind, height-blind, position-blind) arms a First measurement in a store subscriber, and a `useLayoutEffect` plays one spring-keyframed WAAPI effect per moved frame (`deck-canvas.tsx:1611–2126`, `lib/pane-flip.ts`). Sidebar splits are a property of a **rail side** (`imposition.rails[side] = {mode, order, shares}`), rendered as seam custom properties that members pin `calc()` expressions to. The Lens Cards section is a `TugListView` with a single cursor and no selection set at all; ⌘1..9 and ⌃⌘1..3 never consult the Lens — they read the deck's first responder (`getFirstResponderCardId`, `deck-manager.ts:630`).

---

## A — Multi-select in the Cards section

### What exists

Nothing to build on directly. The Cards list is "cursor only" per the inventory in `tuglaws/list-view-usage.md:129`: one scalar cursor index (a ref), one scalar `selectedIndex`, a module-level `lastSelectedRowId` used only to re-seed the cursor. `TugListView` has no multi-select API anywhere — every "multi-select" mention in `tug-list-view.tsx` means the cursor/Space item-group model, not multiple selected rows. No Tug list anywhere reads shift+click or cmd+click; every modifier read in list code is a bail-out guard. The only checkbox-style multi-pick in the product is `TugOptionGroup` and the question dialog — checkbox groups, not row lists.

### Friction — three doctrinal walls, all passable

1. **The selection-ownership matrix** (`list-view-usage.md:100–109`) has exactly four intents and says "do not invent a third path." Multi-select is a fifth intent and needs a deliberate matrix amendment, not a bolt-on. In our favor: `focus-language.md:17–24` already anticipates it — the focus ring is offset *outside* the item precisely so "multi-select works with no extra checkmark."
2. **"Arrows never select"** (`focus-language.md:159–160`). Shift+arrow selection-extension is a new gesture category against that sentence. The honest amendment: a *bare* arrow never selects; a **modifier-extended** arrow is a selection gesture, not a movement gesture. The cursor still moves; the selection follows the anchor→cursor range.
3. **Pointer classification is centralized** (`focus-language.md:365`): `gesture-interpreter.ts` owns modifier facts, and it already records `metaKey`/`shiftKey` into the gesture record (`:564–565`). Shift/cmd-click logic must read that record in the pointerdown path (`tug-list-view.tsx:5972–6035`) — selection commits at pointerdown, never at click.

### The bigger finding: "selected" doesn't reach the commands anyway

Even for a single card, ⌘1 does not act on the Lens selection — it acts on the deck's first responder. And when keyboard focus is *in* the Lens, the first responder is the Lens card itself (a sidebar card), so the `MOVE_TO_SLOT` handler on the deck canvas silently refuses (`deck-canvas.tsx:1000–1011`). Multi-select therefore forces a question feature A must answer regardless of the widget work: **what is "the layout selection"?** Proposed answer: a small explicit store — an ordered set of card ids — owned by the Cards section, published like any external state. Layout verbs (`assign-slot`, width, and B's nudge) resolve against it when it is non-empty and live (Lens has key view or the selection was made recently enough to still be showing), falling back to the first responder card otherwise. That resolver becomes the single seam that A, B, and E all share.

### Batching matters for correctness, not just polish

A multi-card `assign-slot` must land as **one deck-manager commit**. The precedent is explicit: `setContentWidth` was rebuilt as a single commit because per-pane notification re-armed the FLIP settle mid-flight and broke the motion (`deck-manager.ts:3936–3944`). Feature A needs a batched `assignCardsToSlots` / bulk-width path in `DeckManager`, not a loop over the existing single-card actions.

### Sketch

- Selection model: id-set + anchor in a `LensSelectionStore` (ids, not indices — the list filters and reorders under the selection).
- `TugListView` grows an opt-in multi-select capability: `data-selected` on every member row (the fill is already the primitive's per rule 2), anchor/range logic fed by the gesture record's modifiers, shift+arrow in the backstop key handler (which currently returns early on any meta/ctrl — `tug-list-view.tsx:5734` — and would learn shift first).
- Cards delegate decouples "select" from "activate": today a click both selects and fronts the card (`onSelect === activate`). A cmd-click adds to the selection *without* fronting; a plain click keeps today's behavior and collapses the selection to one.
- Amend `list-view-usage.md` (matrix + inventory row) and `focus-language.md` (modifier-arrow carve-out) in the same change.

---

## B — Relative slot nudge, ⌥⇧⌘[ and ⌥⇧⌘]

### The verb is trivial; the chord is the design question

The data path is small: for each card in the layout selection, `slot ± 1` clamped by `clampSlot`, through the same batched commit as A. Multi-card semantics should **clamp as a group**: if any selected card is already at the edge in the direction of travel, the whole nudge refuses (with the standard refusal treatment — never a partial collapse that destroys the selection's relative arrangement). Refusal must be visible per doctrine — reuse `flashPaneBorder` or an equivalent edge bump, never a silent return.

### Chord doctrine check

The bracket keys are a claimed family: ⇧⌘[/] is the lateral card ring (Previous/Next Card) and ⌥⌘[/] is the stack ring (Previous/Next Card in Stack) — the only four bracket chords in the codebase (`command-registry.ts:1239,1250,1266,1277`). Plain ⌘[/] is reserved in the free pool for a future back/forward concept (`chord-tiers.md:90`). ⌥⇧⌘[/] itself is unbound in Tug, unclaimed by macOS and WebKit, and absent from the never-bind list — **mechanically it is free**.

Doctrinally it is contestable under R1. ⌥⇧⌘ is the "both twists at once" set, and its residents compose their two parents (⌥⇧⌘↑/↓ First/Last Turn is the ⇧-extreme of ⌥⌘↑/↓). By that pattern ⌥⇧⌘[/] "should" mean something like first/last card. The case *for* the user's proposal: read it as the ⌥-variant of the lateral ring — ⇧⌘[/] moves *attention* left/right across the cards; ⌥⇧⌘[/] moves *the card itself* left/right. "Same key, same axis, altered object" is exactly what the ⌥ operator means (`chord-tiers.md:31`), and the muscle-memory rhyme (brackets = lateral) is strong. The fallback if we decide R1 forbids it: ⌃⌘[/] — the ⌃⌘ tier is explicitly Tug's layout vocabulary (`chord-tiers.md:128`) and the bracket codes are free there. Recommendation: take ⌥⇧⌘[/] with the "move the card with you" reading, and record the R1 argument in chord-tiers.md's residents table so the reasoning is durable.

Two mechanical notes for the plan: if the command becomes menu-eligible, `codeToKeyEquivalent` folds shift into the character, so the menu renders **⌥⌘{ / ⌥⌘}** (same asymmetry `menus.md:215` already shows); and like ⌘1..9, this chord probably stays deliberately unpromoted so surfaces can decline it ([Q02] pattern, `command-registry.ts:565–584`).

---

## C — Always animate: the hop-and-flash census

The animation research produced a concrete inventory of every geometry path and whether it animates or cuts. The system is doctrinally excellent where the settle runs — the perceived hops come from paths that never enter the settle, plus a handful of timing hazards. The real classes:

### Structural cuts (by design today, each needs a decision)

1. **A newly opened pane snaps into place** — no First rect exists, so the settle skips it (`deck-canvas.tsx:1962–1966`) while its siblings glide. This is likely the single most-seen "hop." Needs a designed enter treatment (e.g. fade+small-rise at its landing slot, played in the same settle window).
2. **A closing pane cuts** — React unmounts it in frame 0 while survivors tween. Needs an exit treatment, which is harder (the frame must outlive its state; [L14] territory).
3. **Signature blind spots**: `arrangementSignature` deliberately omits z-order (correct), but also height and free-pane position — anything moving a frame through an omitted term cuts silently. Worth an audit of which omissions are still correct.
4. **Non-store geometry sources snap**: theme swap, chrome-tier attribute changes (`--tugx-pane-chrome-height`), zoom/font changes. Probably acceptable — but should be a *decision*, recorded.
5. **The settled-resize retune** re-arranges the rails 200ms after the hand leaves the window edge. It animates, but the delayed second movement reads as a hop. Consider folding the retune into the resize's own reflow or shortening/decorating the gap.

### Timing hazards (bugs to fix)

6. **`flushSync` inside the notify chain** can force the DOM to Last geometry before `arm` measures First → zero delta → cut. Sites that mutate geometry under `flushSync`: detach (`deck-manager.ts:3691`), move-card-to-pane (`:3795`), activation focus transfer (`focus-transfer.ts:831`). Prime suspects for "sometimes it hops."
7. **Rapid retarget stale-inline flash**: `snap-to-end` calls `finish()`, whose handler unconditionally `commitStyles()` (`tug-animator.ts:357`); baked inline `width`/`height` can sit against fresh calc geometry for a frame before the restorer runs.
8. **`arm` is a `useEffect` subscription** — a store change in the mount-to-subscribe gap arms nothing.
9. **Occlusion controller flashes**: reveals are synchronous but hides ride a 400ms timer that only checks animations on the frame element itself; fast raise/hide/reveal sequences can flash a whole subtree (`pane-occlusion-controller.ts`).
10. **The session-notification hold flushes at settle release** — a content pop right as the tween lands, on every settle where sessions were busy.

### Approach

Make C empirical before making it surgical. Build a **cut detector**: a debug-gated observer (dev panel / app-test surface, in the spirit of the typing-lag instrumentation) that flags any pane whose rect moved more than N px between consecutive frames with no imposer tween running on it. Drive a scripted gesture battery (open, close, slot move, width change, split flip, resize, tab switch, bullseye, rapid double-gestures) under it in an app-test. The census turns "it still feels like sometimes cards hop" into a ranked defect list; then fix by class, starting with enter/exit (1, 2) and the flushSync sites (6). This lands before D and E, because both multiply the motion paths and should be born onto a surface that already keeps the always-animated promise.

---

## D — *Flow* alongside *fit*

### What the idea means against this code

Today overflow is an accepted outcome: cards overlap, nothing scrolls, and "the deck does not scroll" is load-bearing enough to be cited in `layout-tree.ts:388`. *Flow* replaces overlap with **ordering plus a viewport**: the band between the rail insets becomes the visible bounds of a wider virtual strip; cards sit side by side at their natural widths, never overlapping; and the deck maintains one scroll offset with a single rule — *minimally slide so the active card is fully visible* (the `scrollRectToVisible` contract). Yes — the idea makes sense, and the code has two properties that make it cheaper than it sounds:

- `imposeStyle` already emits exactly **one `left` calc expression** per pane. A flow offset is one more term folded into that expression — `− var(--tug-deck-flow-offset, 0px)` — and window resize stays pure CSS reflow.
- The FLIP settle already tweens `left` deltas. If the flow offset is a term in `arrangementSignature`, every scroll-to-reveal is automatically a settle — the "minimal slide" animates for free through the existing machinery.

### What changes semantically

- **`DeckImposition` grows a mode**: `layout: "fit" | "flow"` (persisted like `kind`). In fit, nothing changes. In flow, the slot's meaning shifts from *travel fraction* to *ordinal position in the strip* — slot k's left edge is the sum of the widths (plus gaps) of slots 0..k−1. `count` stops mattering to geometry (the strip is as wide as its contents) but can survive as the slot vocabulary for ⌘1..9 and the Layouts miniature.
- **The offset is derived, not free-scrolled, at first**: activation is the only writer (`activateCard` gains a geometry consequence for the first time — today it is purely z-order, and the signature is deliberately z-blind, so this needs a new signature term rather than un-blinding z). Trackpad panning of the deck is a natural follow-on but brings scroll-intent arbitration (`tuglaws/scroll-intent.md`) and can be deferred.
- **Interactions to design**: bullseye in flow (probably unchanged — it already supersedes the pane's mode); the space allocator (rails still pin the band's ends; the allocator's overlap tier becomes vacuous in flow, since flow never overlaps); `neighbor-slot.ts` open-beside behavior; what the Layouts miniature draws for an overflowing strip; whether the offset persists across relaunch.

### Sketch

Phase the work: (1) the mode bit + flow geometry in `layout-imposer.ts` (pure functions, golden-testable exactly like the allocator); (2) the offset term + reveal-on-activation through the settle; (3) UI in the Layouts section (a fit/flow control beside the N-up picker); (4) optional trackpad panning later. `pane-model.md` gets a third geometry mode section.

---

## E — Splits for content cards

### The shape of the extension

Sidebar splits are keyed by **side** — `imposition.rails[side] = {mode, order, shares}` — and everything downstream (seam property names, member pins, the seam drag, the Layouts rows, the stack-badge menu) derives from that key. The natural generalization: the same arrangement record keyed by **slot**. `slotStackByPaneId` in `deck-canvas.tsx:759` already treats a rail and a slot as the same kind of "place" — the abstraction E needs already has a name in the code.

- **Data model**: `imposition.columns?: Record<slotIndex, ColumnArrangement>` with the same `{mode, order, shares}` shape (member keys need thought: rails key by componentId because sidebar cards are singletons; content cards are not, so columns likely key by card id, accepting that [L23]-style persistence across close/reopen is weaker).
- **Geometry**: `imposeStyle` grows the `member` option `imposeSidebarStyle` already has — vertical pins as `calc()` over `--tug-slot-<k>-seam-<j>` properties, byte-identical to the unsplit frame when there is one member. The seam writer effect in `deck-canvas.tsx:1527` generalizes from sides to places.
- **Invariant work**: layout-tree invariant 6 (sidebar pane carries no slot) stays; new invariants relate a column's members to panes actually in that slot. The existing "a slot is a stack, z-order decides" model becomes "a slot is a stack *or* a split" — exactly the rail's stack/split duality, which is why the rail machinery ports rather than being rebuilt.
- **UI**: the rail seam component is directly reusable (it is already place-agnostic pointer machinery); the Layouts section grows per-slot rows mirroring the rail rows; the title-bar stack badge menu (split/stack/equalize) extends to content stacks.
- **Motion**: the rail-mode flip choreography (survivor moves, others fade-and-hold) ports as-is — another reason C's census lands first.

### Chords

Two families, both new design work rather than obvious drops:

- **Stack ⇄ split for the current slot**: this is Tug layout vocabulary, so ⌃⌘ tier. ⌃⌘S is free (occupied letters today: A B C F G H I J K L M O P T U) and mnemonic for *split*; needs the usual menu-eligibility decision.
- **Move within a split / promote in a stack** (up/down, top/bottom): the obvious keys are taken — ⌥⇧⌘↑/↓ is First/Last Turn. Candidates worth weighing in the plan: ⌃⌘↑/↓ (arrows are R1-exempt per R2, and ⌃↑/↓ alone is macOS-reserved but ⌃⌘ arrows are not on the never-bind list), or making B's nudge verb axis-complete (the same chord family moving cards along whichever axis the place has). Deliberately left open here — this is a chord-tiers.md conversation once B has settled the bracket question.

### Why E is last

It touches the most: the imposition record, the imposer's content path, invariants, seam plumbing, the Layouts UI, the stack badge, choreography, and two chord families — and its slot semantics depend on what D decides a slot *means* in flow (a split column in a flowing strip must contribute one width to the strip). Designing D and E's record changes together, then implementing D first, avoids reworking E's keys.

---

## Proposed ordering

1. **C — cut census + fixes.** Foundational and independent. Every later feature adds motion paths; they should land on a deck that already keeps the promise. The census instrumentation also becomes the regression harness for D and E's new motion.
2. **A — selection model.** Independent of geometry. Delivers the `LensSelectionStore` + layout-selection resolver + batched deck-manager commits that B needs, and amends the two laws (list-view matrix, modifier-arrow carve-out).
3. **B — relative nudge.** Small once A exists; settles the bracket-chord doctrine question.
4. **D — flow mode.** The mode bit, flow geometry, reveal-on-activation. Design its imposition-record change jointly with E's before implementing.
5. **E — content splits.** The largest lift; ports the rail machinery to slot-keyed columns; brings the second chord family.

Cross-cutting: each step carries its tuglaws edits in the same change (chord-tiers residents, list-view-usage matrix, focus-language, pane-model's geometry modes), per the cross-check doctrine. A and C are parallelizable if desired; B, D, E are sequential behind their dependencies.

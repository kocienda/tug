# Arrow traversal everywhere — design brief

*Superseded by [dash/arrow-traversal.md](arrow-traversal.md), which answered every open question here and carries the implementation. Kept for the reasoning that led to it.*

*Status: brief for discussion, not yet a plan. Grounds in [tuglaws/focus-language.md](../tuglaws/focus-language.md) ("Motion: two planes"), [P22]/[P23] spatial navigation, and the `data-tug-arrow-release` precedent. The goal is one general mechanism, not per-surface patches.*

## The tenet, and where we fall short

When keyboard focus is on any component, an arrow key should move the focus caret ergonomically to the element in that direction. The engine already has the vocabulary — spatial orders, seams, cursor handles, the liveliness net — but the coverage is dialog-shaped: every declared `SpatialOrder` in the tree today lives inside a trapped sheet/dialog scope, and nothing declares one in a card's base mode. Three concrete failures:

- **Lens**: arrows move between a section's filter field and its list, but stop dead at the section boundary. Down from the last Cards row should land in the Snippets section; it doesn't, because the list's `handleListKey` clamps at its edge and consumes the key (`tug-list-view.tsx:5438`), and no cross-section order exists for a seam to fire.
- **Choose Session sheet**: the picker declares no spatial order, so arrows work only inside the sessions list (via the list's own key delegate) plus the filter field's bespoke ArrowDown advance. Up from the list top does not return to the filter; arrows never reach Trash/Cancel/Open.
- **Prompt entry overshoot**: plain Up at the document start fires history navigation, so walking the caret to the start routinely overshoots into a history recall the user didn't want. Weeks of friction.

## What exists today (the parts we build on)

- The arrow pipeline is a ladder of document-capture listeners (`responder-chain-provider.tsx`): `arrowNavListener` (spatial plane) → keybinding map → act dispatch → `keyViewDelegateListener` (key view's `onKey`, where lists handle arrows) → scroll keys.
- `arrowNavListener` yields to any DOM-focused text surface unless the element stamps `data-tug-arrow-release` with that direction. The one live producer is the question dialog's free-text field (`arrowRelease={empty ? "up down" : undefined}`) — exactly the empty-field-is-transparent semantics we want, but wired per-component and only for CM6.
- `FocusContext.moveKeyViewSpatial` (`focus-manager.ts:1725`) resolves declared orders and delegated cursor handles, with a liveliness fallback to the linear `focusNext`/`focusPrevious` walk — but only for nodes *inside* a declared order. No order + no handle → it yields; a group with a handle but no order clamps at its edge and swallows the key.
- `TugListView` has a full `SpatialCursorHandle` implementation but registers it only behind the `spatialCursor` opt-in — used by exactly one consumer (the question dialog). Every other list (Lens sections, session picker) takes arrows through the delegate path and dead-ends at its edges.
- `tug-text-editor/keymap.ts`: plain Up/Down at the doc edges hand off to the `HistoryProvider`; Opt-Up/Down walk history position-independently; Cmd-Up/Down deliberately fall through to `cursorDocStart`/`cursorDocEnd`.

## Design

Five pieces. The first three are the general feature; the fourth is the editor ergonomics fix; the fifth is surface/doctrine cleanup.

### 1. The arrow liveliness net becomes universal

Today the never-beep liveliness net (arrow with no spatial target → linear walk) applies only inside declared spatial scopes. Generalize it: **an arrow that nothing claims, while the engine holds the keyboard, falls back to the linear focus walk** — Down/Right advance, Up/Left retreat, same wrap semantics the existing net has, placed with keyboard modality. Two implementation sites:

- **Group edge with no declared order** (`moveKeyViewSpatial`'s clamp clause at `focus-manager.ts:1809`): instead of holding the cursor and swallowing the key, run the linear walk. This is what carries the ring off the last Cards row into the Snippets section — group order is already authored (`setGroupOrder` in `lens-content.tsx` keeps section order), so the walk lands exactly where the eye expects. Consumption stays guaranteed (never-beep holds).
- **A new final arrow stage after `keyViewDelegateListener`**: a bare arrow that survived every earlier stage unconsumed runs the same linear walk. This is what makes the Choose Session sheet's leaves (path field row, trash, Cancel/Open) arrow-navigable with zero authoring — the walk is mode-bounded, so it cycles the sheet's own stops. Running *after* the delegate stage is what keeps descended row scopes intact: `handleListKey`'s in-row arrow handling (at0277/at0282 behavior) consumes first and is untouched.

The net's gates make it provably safe: bare arrows only (no modifiers); bail unless `document.activeElement` is the key sink, `body`, `null`, or a text surface that released this direction. A Radix menu item, a slider capturing arrows ([P25]), a focused editor mid-document — all fail the gate and keep their keys exactly as today.

Declared orders remain the way to author *better-than-linear* movement (grids, seams, rowGridOrder); the net is the floor under them, now everywhere instead of only inside declared scopes.

### 2. Cursor handles on every engine-authored list

Retire the `spatialCursor` opt-in: `TugListView` registers its `SpatialCursorHandle` whenever it is authored into a focus group and the engine is active. Interior arrows then route through the handle (same moves as today — cursor step, commit-on-move, Right-descends via `tryDescendRight`), and the list's *edges* become visible to the engine, where piece 1 carries the ring onward instead of clamping. `handleListKey`'s container-edge clamp becomes unreachable for arrows (the spatial plane consumes first); its row-scope and Home/End/Page duties are unchanged. The chip groups (`use-item-group-keyboard`) already register handles, so radio/choice/option groups get the same edge fall-through for free — Down off the bottom row of the Lens Layouts grid continues to the next stop.

### 3. Empty-field arrow release, centralized

The question dialog's pattern becomes engine policy instead of per-component wiring: **a single-line text input that is empty (showing only its placeholder) is transparent to arrows.** Implemented once, in the shared yield check that `arrowNavListener` and the new net stage both read: an `<input>` of a textual type, empty, and currently the engine's key view (it carries the projection's key-view mark, so plain non-engine forms are untouched) auto-releases all four directions. An explicit `data-tug-arrow-release` attribute still overrides — that stays the contract for CM6 editors, which need their own emptiness/boundary logic (piece 4). A field with content keeps every arrow for the caret; a field reached by the walk still takes focus and the caret normally.

This makes `TugFilterField` traverse both ways with no new props: Down through an empty filter continues into its list; Up from a list's first row lands in the filter; Down again (still empty) passes through into the section. The filter's existing `filterFieldDidRequestAdvance` (ArrowDown with a non-empty query) keeps working unchanged — it fires from the field's own keydown, which the released path never reaches because release only happens when empty.

### 4. TugTextEditor: history on Cmd-Up/Down, boundary latch for spatial exit

The prompt editor's plain arrows currently overload three meanings (caret motion, history nav at the edges, and — after this work — spatial exit). That's one too many, and history is the one that misfires. Rebalance:

- **History moves to Cmd-Up/Cmd-Down, keeping the at-edge rules.** Cmd-Up with the caret anywhere but the start runs `cursorDocStart` — its editing function, preserved. Cmd-Up with the caret already collapsed at the start hands off to the history provider (`atBackBoundary`), exactly the edge rule plain Up uses today. Cmd-Down symmetric. Repeated presses keep walking, since each recall lands the caret on the boundary being navigated toward (the existing `navHistory` caret placement). Opt-Up/Opt-Down stay as the position-independent walk.
- **Plain Up/Down become caret-only inside the document, with a two-press latch at the boundaries.** Mid-document they pan lines, nothing else. At a boundary (caret collapsed at doc start for Up, doc end for Down), the *first* press consumes and arms the latch — nothing moves, the caret visibly rests at the edge. The *next discrete* press crosses the seam: the editor releases the direction (the existing `data-tug-arrow-release` channel) and the spatial plane / net carries focus to the adjacent component. Key auto-repeat never crosses (`event.repeat` is gated out of both arming-to-exit and exiting), so holding Up slams the caret to the start and stops there — the overshoot class is gone in both its forms. The latch disarms on any selection change off the boundary, on edits, and on blur.

Open sub-question: an *empty* editor. The consistent rule (piece 3) says a placeholder-only surface traverses freely; the conservative rule says the prompt editor is the workspace and should always cost the extra press. Recommendation: empty editors traverse freely like empty inputs — the latch exists to protect a document, and an empty editor has none — but this is cheap to flip and worth a decision.

### 5. Surfaces and doctrine

- **Lens**: needs nothing beyond pieces 1–3. Linear group order already matches the visual column, so the net *is* the correct spatial order for a one-column pane. (If we later want Up from the first Cards row to stop rather than wrap to Layouts, that's a base-mode `SpatialOrder` with open edges — see open questions.)
- **Choose Session sheet**: works via the net alone. Optionally, author a `rowGridOrder` in the sheet's trap scope (the doctrine's stated preference for dialogs, and what gallery-sheet and the question dialog already do) so Cancel/Open behave as a proper horizontal row rather than two linear stops. Recommendation: ship the net first, add the authored order only if the linear feel is wrong in practice.
- **focus-language.md** gets amended: the liveliness net is universal (the floor under every surface, not a property of declared scopes); "An empty text field spends `Tab` on movement" gains its sibling — an empty text field spends *arrows* on movement too; the editor boundary latch and the Cmd-history rules are recorded under Arrow ownership; the list-edge "consumed and nothing moves" sentence (currently stated for descended accessories, and true today for list edges too) is scoped to descended row scopes only.

## Interactions and edge cases

- **Wrap at the extremes.** The linear walk wraps (mod registry), so Down at the very bottom of the Lens returns to the top. This matches the existing in-scope net semantics. If wrap feels wrong at card scale, the alternative is clamping at the registry ends — a one-line policy in the net, worth deciding by feel.
- **Descended row scopes are untouched.** In-row arrows, the ordinal-carrying vertical walk, Left-off-first-ascends, and edge consumption inside a descend all live in the delegate stage, which runs before the net.
- **Radix menus / popovers**: DOM focus sits on a real menu item — the net's active-element gate bails, and Radix keeps its arrows.
- **Fields that always have content** (the picker's project path) keep their arrows for the caret, by the user-stated rule; Tab and the walk still reach past them. No special case.
- **`filterFieldDidRequestAdvance`** becomes redundant for the empty case (the release path lands in the same place) but stays for the non-empty case; no delegate change needed.
- **App-test surface**: at0277/at0282 (row-scope arrows) must stay green; the question dialog's release seam (at0202-family) must survive the centralization; new coverage for section-crossing in the Lens, sheet traversal in the picker, the editor latch, and Cmd-history. All via `@covers` selection.

## Open questions

1. Empty-editor traversal: free (recommended) or latched like a non-empty editor?
2. Net wrap policy at the registry ends: wrap (current net semantics, recommended) or clamp?
3. Does the empty-input auto-release cover Left/Right as well as Up/Down (recommended: yes — an empty field has no caret motion to protect), or vertical only?
4. Choose Session sheet: net-only, or also an authored `rowGridOrder`?
5. Should the armed latch show an affordance (e.g. a brief caret/edge pulse) so the extra press is discoverable, or stay invisible?

# The Workspaces card has one cursor, and its keyboard focus works

**Purpose:** After the shared-list arc (`6a45d5b90`), switching workspaces from the Workspaces card still hops the list by a small amount, rows in inactive workspaces still wear a selection fill, and giving the card keyboard focus — by click or ⌃⌘W — no longer works at all.

---

## Purpose {#purpose}

In the user's words, on the new code: "It's better for sure, but still not quite up to standard. I still get little hops when changing workspaces." And: "as I look at the workspaces in this card, I see *confusing* highlighting on the rows. Cards in the inactive workspace are still selected. That seems wrong."

Then: "putting the keyboard focus onto the workspace card by clicking or with ⌃⌘W has regressed. Doesn't work at all." And the ruling that frames the rest: "the keyboard should show the selection cursor. We simply can't have multiple selections like this. The active workspace is the one that should carry the selection — and I guess we need to save/restore the selection as the workspace changes."

This brief follows `briefs/workspaces-card-one-list-brief.md`, whose [B01] — content is one fact for the deck, the box is per workspace — still holds. What that arc shared was the filter and the scroll anchor; what it left per instance is the cursor, and the three symptoms above are that one omission plus a regression.

---

## Evidence {#evidence}

**[F01] Two marks paint through one look.** The list primitive paints `data-selected` on a cell when it is the owned cursor row *or* a member of the multi-select set (`tugdeck/src/components/tugways/tug-list-view.tsx:8524`, `cellSelected = effectiveSelectedIndex === index || multiSelect?.selectedIds.has(id)`). The multi-select set is the layout selection, `cardsSelectionStore`, already filtered to the active workspace's rows (`tugdeck/src/components/cards/cards-card.tsx:1547`). The cursor is not filtered and not shared. **(verified)**

**[F02] Each instance of the card keeps its own cursor, and it sits on the row the reader used to leave.** The user's two screenshots: Main's card shows a fill on `how-arc-replays-work` (a writing row), writing's card shows a fill on `tug/violet-suit` (a Main row). Each is the row the user clicked in that instance to switch away — a click moves the list cursor onto the row (`onPick`) before `activate-space` runs, and that instance keeps the cursor while it stands parked. The "selected cards in the inactive workspace" are stale cursors of instances the reader is not looking at. `lastSelectedRowId` (`cards-card.tsx:207`) is a module global but only seeds a cursor through `initialSelectedIndex` when membership changes (`cards-card.tsx:851`), so the cursor is half-shared at best. **(verified by reading the code against the screenshots.)**

**[F03] The remaining hop is a constant offset, not a height difference.** Across the two screenshots every row of the list is displaced by the same ≈11 display px (≈14 image px) — `Main` header, `worthy-sisal`, `tug-site` header all move together. A row-height difference above the clicked row would grow down the list; a constant shift is a `scrollTop` the anchor did not ask for. **(verified from the screenshots; not yet measured on the deck.)**

**[F04] The likely writer is the arriving card's own stale cursor, and the arc's anchor code then adopts the hop as the truth.** Inferred, not measured: `initialSelectedIndex` recomputes on a membership change and the primitive reveals the selected row with `block: "nearest"`, which moves nothing when the row is in view and moves by exactly how far the row is past an edge when it is not — a hop of a few to a few dozen pixels, varying by switch. A focus landing on the cell can do the same. `useSharedListAnchor`'s `onScroll` then sees a scroll that is not the one it placed, marks the card `touched`, and proposes the hopped position as `cards.listAnchor` — so the next card inherits it, which is why the offset in the screenshots is steady rather than transient. The arc's log that "no other scroll writer moved the scroller" was taken on a harness whose instances had fresh cursors; the stale-cursor state exists only after real switches. What would confirm it: a switch on a deck whose instances' cursors differ, with every `scrollTop` write in the arriving card logged with its stack.

**[F05] Keyboard focus on the card is broken by click and by ⌃⌘W, and nothing pins it.** Two commits since the last known-good touched the relevant paths: the shared-list arc `6a45d5b90`, the only change to `tugdeck/src/components/cards/` (its diff reads clean for focus — the capture-phase `pointerdown` listener prevents nothing, the filter field took a `query` prop, the list's `scrollKey` was retired), and `d4c32afc6`, "make an open sheet claim first responder so ⌘. cancels it" (`tug-sheet.tsx`), a change to who holds first responder. ⌃⌘W is the sidebar-card chord family in `command-registry.ts` (`SIDEBAR_MENU_CARDS`, `KeyW` for `CARDS_CARD_ID`). No app-test drives ⌃⌘W to focus the Workspaces card, which is how this got through. **(the report is the user's; the two suspects and the test gap are verified.)**

**[F06] The layout selection is one deck-wide, transient set.** `cards-selection-store.ts`: ordered by pick, never persisted, pruned as cards go, and "activation outside the set collapses it". `activateSpace` calls `activateCard` outside the swap batch (`space-layer.ts`), so a switch very likely collapses the departing workspace's selection; a selection that is still there when the reader comes back is new behaviour, not a repair. **(verified from the store's contract; the collapse on switch is inferred from the activation order.)**

---

## Decisions {#decisions}

**[B01] Three facts, three scopes.** The **cursor** — the keyboard's row, the one selection fill — is one for the deck, ever. The **layout selection** — the cards the slot and width verbs act on — is per workspace. The **scroll anchor** is one for the deck, as the prior arc made it. This is the user's ruling: one selection on screen, carried by the active workspace.

**[B02] The cursor is the anchor row.** On a click, the clicked row becomes the deck's cursor as well as its anchor; an arriving card adopts the cursor from the shared store at the moment it places its scroller. Stale per-instance cursors cease to exist, which is the whole of the highlighting fix: after any switch the only fill on screen is the row the reader clicked, in the workspace they are now in. Arrowing the cursor onto an inactive workspace's row paints the fill, and that is right — it is the keyboard's one position and there is no other.

**[B03] The arriving card adopts the cursor without a reveal, and nothing but the placement scrolls it during the switch.** The placement has already put the anchor row where it belongs, so a reveal is redundant when right and a hop when wrong. `initialSelectedIndex` recompute, seed focus, and any `focus()` on a cell run with no reveal and `preventScroll` while the switch epoch (`SPACE_SWITCHING_ATTRIBUTE`) is open.

**[B04] A scroll the reader did not make never becomes the anchor.** `onScroll` proposes only on a scroll with a gesture behind it, and never while the epoch is open. Today one stray programmatic scroll rewrites the shared truth and every later card inherits it ([F04]).

**[B05] The layout selection is saved per workspace and restored on return; only the active workspace's set paints.** Kept transient as it is now — never persisted — keyed by workspace in memory. Where the restored selection and the adopted cursor name different rows, the cursor wins the paint and the selection is still what the verbs act on; that is what happens today when the reader arrows off a selected row without picking.

**[B06] The focus regression is fixed first, and pinned by a test before it is fixed.** Keyboard focus on the Workspaces card by click and by ⌃⌘W is a floor the rest stands on — "if this *did* work properly" is the premise of [B02]. An app-test drives both doors and asserts the card root or its cursor row holds focus; it goes red; then each suspect in [F05] is reversed under `tugtool file probe` to name the culprit, and the fix follows. Blaming either commit before that run is a guess.

**[B07] Measure the hop before changing the anchor code.** [F04] is an inference. The deck state the user has — instances whose cursors differ — is set up on the harness, one switch is made with every `scrollTop` write in the arriving card logged with its stack, and the writer is named. If it is not the cursor reveal, [B03] and [B04] still hold, and the real writer is what stands down.

---

## Open Questions {#open-questions}

- **Which commit broke focus** — settled by the probe in [B06], not here.
- **Which writer hops the list** — settled by the measurement in [B07].

---

## Non-goals {#non-goals}

- **A quieter cursor mark for inactive-workspace rows.** Asked and answered: with one cursor, the fill is the cursor, wherever it stands.
- **Persisting the layout selection.** It stays transient; per-workspace memory is in-process only ([B05]).
- **Reopening [B01]–[B07] of the prior brief.** Content shared, box per workspace, design B shaped for A, no per-workspace scroll memory — all stand. This brief adds the cursor to what is shared and fixes what the first arc left.
- **A single Workspaces card outside the layers (design A).** Still the direction, still too large for this fix; a shared cursor store is one more thing a singleton would simply own.

---

## Exit {#exit}

**An arc.** In the order it has to land:

1. The focus test ([B06]): click and ⌃⌘W onto the Workspaces card, asserting focus. Red first; probe each suspect; fix the culprit.
2. The hop measurement ([B07]): stale-cursor state on the harness, one switch, every `scrollTop` write logged. Name the writer. `at0792` gains this leg — a switch into an instance whose cursor is just past the fold.
3. One cursor ([B02]): the clicked row becomes the deck's cursor; an arriving card adopts it with no reveal ([B03]); `onScroll` proposes only on a gesture and never inside the epoch ([B04]).
4. Per-workspace layout selection ([B05]): saved on departure, restored on return, painted only for the active workspace.
5. A screenshot-shaped assertion: after a switch, exactly one cell in the shown card carries `data-selected` from the cursor, and it is the clicked row.

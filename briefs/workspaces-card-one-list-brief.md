# The Workspaces card is one list

**Purpose:** Clicking a workspace in the Workspaces sidebar card moves the list under the mouse. The row the reader clicked must still be where they clicked it once the switch to the other workspace completes.

---

## Purpose {#purpose}

In the user's words: clicks in the Workspaces sidebar card to change workspaces are "*way too eager* to move the scroll point of the card. It must not. When I click in the Workspaces card, the place I click must remain under my mouse after a transition to another workspace completes."

On hearing the cause — that the list after the switch is a different list — the user's ruling was: "We can't have this. In its way, the Workspaces card's content must be shared across all workspaces." The question the sketch then worked through is how that squares with workspaces being allowed to lay out their sidebars differently.

---

## Evidence {#evidence}

**[F01] The click does not scroll the list; the reader is handed a different list.** `DeckCanvas` renders one layer per mounted workspace, each with its own deck and its own rail (`tugdeck/src/components/chrome/space-layer.ts` header; `LayerArrangement` in `tugdeck/src/components/chrome/deck-canvas.tsx`). So every mounted workspace holds its own instance of the Workspaces card, with its own `.cards-card` scroller and its own scroll offset. Switching from A to B hides A's card and shows B's, at whatever offset B's card last had — or at 0, since a parked layer's pane content is `display: none` (`tugdeck/src/components/chrome/space-layer.css:135`) and a scroller without a box keeps no offset. Nothing in the switch consults where A's card was. **(verified, by reading the code; not yet measured on a live deck.)**

**[F02] The rows are already the same in every instance, with two exceptions.** The data source projects every workspace regardless of which is active (`tugdeck/src/components/cards/cards-data-source.ts`, `spaces` memo), and workspace folds and group folds live in the shared `cardsStore`. The exceptions, both per-instance by accident of their storage: the filter query is a `useState` (`tugdeck/src/components/cards/cards-card.tsx:816`), and the scroll offset lives in each card's own region-scroll bag (`scrollKey="cards-card"`, replayed by `card-host.tsx`'s `regionScroll` machinery). **(verified)**

**[F03] The code already treats "where I was in this list" as one fact.** The keyboard cursor's remembered row, `lastSelectedRowId`, is a module-level variable (`cards-card.tsx:207`) shared by every instance. The scroll offset and the filter are the stragglers, not a different design. **(verified)**

**[F04] The card's box is legitimately per-workspace.** The rail is solved per layer, so the Workspaces card may sit in a different rail, at a different width or height, or be absent, in another workspace. That is a layout freedom the reader has, and it is what makes a same-screen-pixel promise impossible in general. **(verified)**

**[F05] Several writers can move the arriving card's scroller during a switch.** The card-host `regionScroll` replay, the list view's saved-anchor restore (`useSavedRegionScroll` in `tugdeck/src/components/tugways/tug-list-view.tsx:2806`), a cursor reveal, and any `focus()` without `preventScroll`. Any one of them landing a frame after the carried position would undo it. **(inferred from the code paths; which of them actually fire on a switch is for the arc to establish.)**

**[F06] The `[B06]` broadcast guard is this bug's sibling.** `useSpaceLayerShown` exists because several mounted Workspaces cards each answered one Delete Workspace request (`space-layer.ts`, "Whether the workspace a card is mounted in is the one on screen"). Both are consequences of N instances standing in for one card. **(verified)**

**[F07] Unverified: whether the active workspace's block has the same row heights as a parked one.** Active styling moves from A's block to B's at the switch. If it is ink only, a carried offset is pixel-exact; if it adds or grows a row, only the row anchor below holds. The arc should check before claiming pixel-identity.

---

## Decisions {#decisions}

**[B01] The Workspaces card's content is one fact for the deck; its box is per-workspace.** Content — rows, order, folds, filter, scroll position — is shared by every instance. Where the card sits and how big it is stays the reader's to vary per workspace. The "essential conflict" the user raised exists only if the promise is about a screen pixel; stated against the card, the two halves do not collide. This is the ruling the rest of the brief rests on.

**[B02] The guarantee is a row anchor within the card, tiered by how alike the boxes are.** On the click, record the clicked row and its offset from the card's top. After the switch, place the arriving scroller so that row sits at that offset. When the arriving card's box matches the departing one — the common case — the row is under the mouse, pixel for pixel, and no special case is needed to get there. When the box differs, the row is at the same offset in a card that moved, which is what the reader asked for. When the arriving card is shorter, clamp to "nearest" so the row stays visible. When the arriving workspace has no Workspaces card, there is nothing to place, but the position is kept for the next card to show. The user asked whether the guarantee could be "best-effort"; this is the shape of the effort, and the best case is exact.

**[B03] The filter becomes one fact for the deck, stored in `cardsStore` beside the folds.** Without it the anchor row may not exist in the arriving list, and "one list" is false whenever a filter is typed. The user agreed.

**[B04] Per-workspace list memory is retired.** Switching by any door — click, Window menu, chord — shows the list at the shared position. "Each workspace remembers where its Workspaces list was" goes away. This is a behaviour change the user chose: "I'll live with it and see how it goes." A later reader who wants per-workspace memory back is reversing this decision, and should say so.

**[B05] Build it as N instances over one shared position store (design B), shaped so a single shared instance (design A) can absorb it.** The deck-level store holding the anchor and the filter is the artifact both designs share; in A it simply becomes the singleton's own state. B fits the per-layer architecture as it stands and ends the jump now. The user confirmed: "build B, shaped so A can absorb it."

**[B06] The arriving card takes the carried position inside the switch epoch, and every other scroll writer stands down for its length.** `DeckManager` writes `SPACE_SWITCHING_ATTRIBUTE` inside the swap commit, before any layer's effects run, which is the one moment that precedes the first shown frame. The carried anchor is applied in that window, and the writers in [F05] must not move the scroller while the epoch is open. A fix that lands the position and lets a restore undo it a frame later has not fixed it.

**[B07] No separate "same position" special case.** The user floated one. The anchor in [B02] yields exactness whenever the boxes match, for free; a second code path for that case would be a second thing to keep honest and would buy nothing.

---

## Open Questions {#open-questions}

- **Does any part of the active-block styling change a row's height?** ([F07]) Settled by reading the row components and `cards-card.css`; if a height does change, the pixel claim in [B02]'s first tier weakens to the second tier, and the brief's promise should be restated to match.

---

## Non-goals {#non-goals}

- **A single Workspaces card outside the layers (design A), now.** Cleaner semantically — no sync, no stand-down, and the `[B06]` broadcast guard ([F06]) becomes unnecessary — and it is where the per-card-web-views program ends up anyway. But it introduces a pane that belongs to no layer in a system where rails, focus and arrangement are all solved per layer. Too large for this fix; [B05] keeps the door open.
- **Per-workspace scroll memory for the Workspaces list.** Retired by [B04].
- **Promising the same screen pixel in every case.** Impossible while the box is per-workspace ([F04]); the promise is against the card ([B02]).
- **Changing how sidebar layouts vary per workspace.** The reader's freedom to arrange rails differently per workspace is untouched.

---

## Exit {#exit}

**An arc.** The first shape, in the order it has to land:

1. Measure the jump on a live deck or a harness fixture so [F01] stops being a code reading — a red-first test that scrolls the list, clicks a row deep in it, switches, and asserts the row's rect within the card is unchanged after settle; then the same with a filter active.
2. Move the filter query into `cardsStore` ([B03]).
3. Add the deck-level position store — row anchor plus offset — written on the click and on scroll, and have the Workspaces card read it instead of its per-card region-scroll bag ([B04], [B05]).
4. Apply the carried anchor in the arriving card inside the switch epoch, and make the writers in [F05] stand down while it is open ([B06]).
5. Answer [F07] and restate the first tier of [B02] if it weakens.

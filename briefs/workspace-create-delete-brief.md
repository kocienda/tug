<!-- brief-skeleton v1 -->

# Workspace create and delete: show the new one, count the right cards

**Purpose:** Creating a workspace does not show it or offer its name for editing, and the delete confirm names a card count the workspace plainly does not have.

---

## Purpose {#purpose}

The user's report, in two parts:

> When I click `+` to add a workspace (or use the menu), the new workspace should become visible in the Workspaces sidebar card (scrolling if necessary), and the name should be highlighted for editing. If the sidebar card is not visible, make it so.

> When I delete a workspace, the confirm-popover is just wrong. This workspace *obviously* does not have three cards in it.

The screenshot with the second part shows a freshly created "Workspace 1" whose header reads "0 cards", with a confirm over it asking "Delete Workspace 1 and close 3 cards?". The popover sits above the header it asks about, covering the header and rows of the workspace above it (`eucit`).

---

## Evidence {#evidence}

**[F01] New Workspace only creates.** The `+` button (`tugdeck/src/components/cards/cards-card.tsx:1789`) and the Window-menu item both dispatch `TUG_ACTIONS.NEW_SPACE`, answered at the chain root in `tugdeck/src/components/chrome/deck-canvas.tsx:3173` by a bare `store.createSpace()`. `createSpace` (`tugdeck/src/deck-manager.ts:1579`) appends the workspace, activates it, stands a factory rail, and returns the new id — which the handler discards. Nothing reveals the row or opens its name field. **(verified, read from the code)**

**[F02] The reveal-and-rename machinery already exists.** `RENAME_SPACE` with no name (same file, just below) calls `revealSidebarCard(store, CARDS_CARD_ID)` and then `cardsSpaceVerbRequest.request("rename", spaceId)`. The Workspaces card on the visible layer consumes the request in a layout effect (`cards-card.tsx:1391`) and sets `renamingSpaceId`. The field then selects its whole name (`el.select()`, `cards-space-header.tsx:209`) and takes the keyboard through `focusRenameField`. **(verified)**

**[F03] A rename request does not scroll its header into view.** The delete branch of that effect calls `anchorForSpace`, which does `scrollIntoView({ block: "nearest" })` on the header's cell (`cards-card.tsx:1351`). The rename branch at `cards-card.tsx:1400` returns after `setRenamingSpaceId` without it. So a rename fired from the menu on a workspace scrolled out of the list opens a field nobody can see. **(verified)**

**[F04] Escape in the rename field already cancels without writing.** `cards-space-header.tsx:242` calls `onCancel`, which only clears `renamingSpaceId`; the `cancelled` ref keeps the blur from committing. A new workspace already holds its default name from `nextSpaceName` before the field opens. **(verified)**

**[F05] The confirm counts sidebar panes as the workspace's cards.** The confirm reads `store.getSpaceDeck(spaceId)?.panes.length` (`cards-card.tsx:1422`). Every new workspace is given a factory rail of three panes — `CARDS_CARD_ID`, `ARCS_CARD_ID`, `LAYOUT_CARD_ID` (`FACTORY_RAIL_ORDER`, `deck-manager.ts:461`; `_createFactoryRail`, `deck-manager.ts:4097`). That is the "3 cards". **(verified)**

**[F06] The header's count excludes those panes.** The list's projection builds `railPaneIds` from `findSidebarPanes(deck)` and skips them (`cards-data-source.ts:829`), which is why the header says "0 cards". Two counts, two definitions. The header's count is also narrowed by the filter field, which is the stated reason the confirm reads the store instead (`cards-card.tsx:1412`). **(verified)**

**[F07] The confirm opens on the top side.** `TugConfirmPopover` is given `side="top"` (`cards-card.tsx:1862`), so anchored on a workspace's header it covers the preceding workspace's rows, as in the screenshot. **(verified)**

**[F08] Two app-tests pin the current sentence.** `tests/app-test/at0585-workspace-delete-guard.test.ts:211` expects ``Delete ${HOME_NAME} and close 2 cards?`` and `tests/app-test/at0578-workspaces-switch.test.ts:709` expects `Delete Away and close 2 cards (1 session)?`. Whether those fixtures' workspaces carry sidebar panes — and so whether the numbers move — was not checked.

---

## Decisions {#decisions}

**[B01] New Workspace creates, reveals the Workspaces card, and opens the new row's name field.** `NEW_SPACE` keeps the id `createSpace` returns, calls `revealSidebarCard(store, CARDS_CARD_ID)`, then `cardsSpaceVerbRequest.request("rename", id)` — the path Rename already takes ([F02]). One handler serves the `+` and the menu, so both get it. The name arrives selected, so typing replaces the default.

**[B02] Opening a rename field reveals its header.** The rename branch calls `anchorForSpace(spaceId)` as the delete branch does ([F03]). This is what makes the new workspace visible "scrolling if necessary", and it repairs menu Rename on an off-screen workspace in the same stroke.

**[B03] Escape on a new workspace's name keeps the default name; Escape on an existing workspace's name undoes the edit.** The user's call. Both are today's behaviour ([F04]) — Escape never deletes the workspace just created — so this needs a test to pin it and no code.

**[B04] The confirm names the workspace's own cards, never its sidebar's.** The count excludes `findSidebarPanes(deck)`, unfiltered, and is defined once where both the header and the confirm can take the same rule — beside `spaceHoldsLiveSessions`, which is already the one definition of the session count. Sidebar cards are torn down with the workspace but are furniture, not the user's work. With no filter applied, the confirm's number and the header's number must agree.

**[B05] Every delete still confirms, and the sentence keeps its shape.** An empty workspace asks "Delete Workspace 1 and close 0 cards?". The user's call: the sentence was never the fault, the number was. This leaves the existing every-delete-confirms rule (`[P06]` at `cards-card.tsx:1406`) untouched.

**[B06] The confirm opens below the header it asks about.** `side="bottom"`, so it hangs under its own workspace instead of covering the one above ([F07]). The collision boundary and arrow stay.

---

## Non-goals {#non-goals}

- **Undoing the creation on Escape.** Rejected by [B03]: Escape cancels a rename, and the workspace stays.
- **A shorter sentence for an empty workspace** ("Delete Workspace 1?"). Offered and declined ([B05]).
- **Skipping the confirm for an empty workspace.** Declined ([B05]).
- **Highlighting the target header while the confirm is open.** The alternative to [B06]; more work for what the side change already buys.
- **Skipping the activate-and-settle wait when deleting an empty workspace.** `runGuardedDelete` spends up to `ARRIVAL_SETTLE_MS` on a never-mounted workspace even when it holds no cards. Real, but not what was reported and not discussed to a decision.

---

## Exit {#exit}

**An arc.** The raw material for its steps:

- `NEW_SPACE` handler in `deck-canvas.tsx` per [B01]; rename branch in `cards-card.tsx` per [B02].
- One sidebar-excluding card count on the store, read by the confirm ([B04]); `side="bottom"` ([B06]).
- Tests: `+` reveals the new header and opens its field with the name selected, including when the Workspaces card starts closed; Escape per [B03]; a new empty workspace's confirm says 0 cards. Re-check the sentences pinned in `at0585` and `at0578` ([F08]).

The two halves are independent and can land in either order.

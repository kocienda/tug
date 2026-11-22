# Workspaces Card: an Activity View

**Purpose:** The Workspaces card can only show cards grouped by the workspace they live in. The user wants a second view that shows the most recently live sessions and the most recently saved files across every workspace, newest first.

---

## Purpose {#purpose}

In the user's words: "make it possible to sort the workspaces card by sessions and files, with most-recently live session from all workspaces, and the most recently saved files from all workspaces. two groups only: sessions and files."

The card today (the Cards card, `tugdeck/src/components/cards/cards-card.tsx`) is a mirror of the deck. Each workspace has a header, and under it are its Sessions, Files and Tools groups. To answer "what was I just working on?", the user has to unfold every workspace and scan each one. The ask is a second view that puts the things themselves first and the place they live second, with time setting the order.

---

## Evidence {#evidence}

**[F01] The filter field fills the toolbar.** `RailCardToolbar` in `cards-card.tsx` (around line 1633) holds a `TugFilterField` with placeholder "Filter Workspaces", followed by `NewSpaceButton`. The field stretches across all the space between them, so a new control has no room until the field shrinks. **(verified)**, read from the code and the user's screenshot.

**[F02] A popup button primitive already exists.** `tugdeck/src/components/tugways/tug-popup-button.tsx` is used by text-card controls, share parts and gallery sheets. It takes a `label` and an item list. **(verified)**

**[F03] The card's groups are `sessions`, `files` and `tools`.** `CardsGroup` is defined in `cards-groups.ts`. A card type picks its group through `cardsGroup` on its registration (`card-registry.ts:394`). If it doesn't, the type-picker category decides, and anything left over goes to `tools`. **(verified)**

**[F04] Sessions already carry a durable "last live" time.** The session ledger's `SessionRow` has `last_turn_end_at`, which `lib/session-attention.ts` reads. The session cell already shows a "Last …" time. **(verified)** that the field exists. Whether it is the right field for a session whose turn is still running is covered in [B04].

**[F05] A file's in-app save time does not survive a relaunch.** `lastSavedAt` in `lib/text-card-store.ts` only lives in memory. It is set to `null` when a card loads (line 266) and to `Date.now()` on each save. If Activity sorted by it, every file would read as never saved after a relaunch. **(verified)**

**[F06] The deck already has a "Recent" list, and it is ordered by opening.** `lib/recent-documents.ts` is File ▸ Open Recent: a most-recently-used list of paths in tugbank, plus a map of the time each path was last opened. "Recent" in Tug therefore already means "recently opened", which is a different measure from this view's. **(verified)**

**[F07] Fold state already persists per workspace and group.** `collapsedCardGroups` and `collapsedSpaces` in `cards-store/types.ts`. **(verified)**

---

## Decisions {#decisions}

**[B01] The toolbar becomes: filter, `View:` popup, `+`.** The filter field shrinks to just fit its placeholder text, "Filter Workspaces". To its right is a plain `View:` label followed by a `TugPopupButton` ([F02]). The `+` new-workspace button stays at the far right in both views, because making a workspace makes sense whichever view is showing.

**[B02] The two views are named Workspaces and Activity.** Workspaces is the current view, unchanged. The new view is **Activity**, not "Recent". Its order comes from when a session was last live and when a file was last saved, which is activity. It does not come from when the user last opened or looked at either. "Recent" already means "recently opened" in Tug ([F06]), so reusing the word would suggest the wrong measure.

**[B03] Activity has exactly two groups, Sessions and Files, each one flat list across all workspaces, newest first.** It has no workspace headers and no Tools group, so tool cards do not appear in Activity at all. The two groups fold like groups do today.

**[B04] Sessions sort by last live.** A session sorts by the time it was last live, using the ledger's last-turn time ([F04]). A session whose turn is running right now counts as live now and sorts to the top.

**[B05] Files sort by last-modified time on disk.** The in-app save time does not survive a relaunch ([F05]), so files sort by the file's modification time on disk. Disk time survives relaunches, and it also counts saves made outside Tug, which is the activity the user cares about. A card with no file on disk (a draft) uses its in-memory `lastSavedAt` if it has one, and otherwise sorts to the bottom of Files.

**[B06] Activity rows reuse the existing cells and add a workspace chip.** Session rows use `CardsSessionRow` and file rows use the existing file pane row, so a row looks and behaves the same in both views. Without the workspace headers, a row would lose the one thing the Workspaces view gave it for free: where it lives. So each Activity row carries a small chip with the workspace's theme swatch and name.

**[B07] Pressing a row in Activity does what it does in Workspaces.** It switches to that row's workspace and reveals the card. The slot badges (1 2 3 4) and the close box behave the same as well.

**[B08] The filter also matches the workspace name in Activity.** Rows match on their own text as they do now, plus their workspace's name. Typing `vids` narrows Activity to that workspace.

**[B09] Drag-to-reorder is off in Activity.** Time sets the order there, so a drag would have nothing to change. The arrangement the user built in Workspaces is untouched by anything done in Activity.

**[B10] The chosen view persists with the card.** It lives in the cards store next to the fold state ([F07]), so the card reopens in the view it was left in. Activity's two group folds persist separately from the per-workspace group folds.

---

## Non-goals {#non-goals}

- **A history of closed things.** Activity lists only sessions and files that have a card in some workspace, including the unconnected session rows the card already shows. It is not a recent-files or recent-sessions history of things the user has closed. Open Recent ([F06]) already covers that, and the card is a mirror of the deck.
- **A Tools group in Activity.** The user asked for two groups only. Tools have no natural "last live" or "last saved" time.
- **Sorting by last opened or last focused.** Rejected in [B02]. The view is about work being done, not where the user's attention went.
- **Making in-app `lastSavedAt` durable.** Disk modification time ([B05]) gives the right answer without new persisted state.
- **More views.** The popup has two items. A third view would need its own brief.

---

## Exit {#exit}

**An arc.** The work is in tugdeck's Cards card, roughly in this order:

1. The toolbar: shrink the filter field and add the `View:` label and popup, with the choice persisted in the cards store ([B01], [B10]).
2. The data source: an Activity row model with two groups, each flat and sorted across all workspaces. It needs the sessions' last-live time ([B04]) and the files' disk modification times ([B05]). The disk times need a read path from the deck to the files, so check first whether one already exists before adding one.
3. The cells: the workspace chip on Activity rows, filter matching on the workspace name, and reorder turned off ([B06], [B08], [B09]).
4. App-tests for switching views, the order of both groups, a row press crossing workspaces, and the filter matching a workspace name.

# Workspaces, second pass: visible verbs, folding, drop feedback, safe delete, fast switching

**Purpose:** The workspaces arc (`b2174629f`) landed the model — a named-deck level above cards — but the surface a person meets is thin: the verbs are hidden behind a right-click, the one visible control on the header is dead, moving a card is a drag nobody would discover and that gives almost no feedback, deleting a workspace can silently discard unsaved edits, and switching workspaces takes long enough that nobody would switch. This brief decides the second pass.

---

## Purpose {#purpose}

The user's notes, on first use of the landed feature, with one workspace on screen:

> There's no way to add, modify or delete workspaces. There need to be controls in the card and in the Swift menu.

> There's no way to expand/collapse the existing workspace you've given me, despite the visible control on the right. Clicking that control does nothing. … I must be able to expand and collapse all workspaces at will.

> Once I have more than one workspace, I need to be able to move cards between them. … This must give far better feedback, and at the very least follow the basics of the drag and drop conventions we already have, i.e. the drop target must get a highlight. Also, dragging a card to another workspace must not change the active workspace, meaning that we don't follow the card. I should be able to drag anywhere in the workspace indented content, not only on the header.

> What happens when I delete a workspace? Do all its cards close? … Cards can close without confirm (provided that the workspace confirms), but they can't clobber content that needs to be saved.

> There's also a sizable delay when switching workspace. It probably can't work like this. The delay would cause devs not to use the feature. … We need to keep more content live and make switching quicker.

Every one of these is against the landed code, not against the model. The v5 blob, the `space` identifier, the parked-deck record, the lazy session restore and the card move all stay as [workspaces-brief.md](workspaces-brief.md) decided them. What changes is what a person can see, touch, and wait for.

---

## Evidence {#evidence}

**[F01] The four workspace verbs exist only as a right-click menu on the header row.** `useSpaceRowMenu` in `tugdeck/src/components/cards/cards-space-header.tsx` builds New / Rename / Duplicate / Delete as a `TugEditorContextMenu`, opened from the row's `onContextMenu` and from nowhere else. The doc comment argues "a person makes a workspace once and deletes one almost never", which is why the row draws no button. The card's filter bar has no New control, and the Window menu's workspace block (`rebuildWindowSpaceList` in `tugapp/Sources/AppDelegate.swift`) lists names for switching and carries no verb. **(verified)**

**[F02] The fold cue on the active workspace is drawn disabled, so with one workspace the only visible control is dead.** `SpaceHeaderCell` renders `BlockFoldCue` with `disabled={row.active}`, and `buildCardsRows` computes `expanded = space.active || space.expanded` — the active workspace is always expanded by the data source's own rule, and the cue's `onToggle` on it toggles a bit the rule never reads. The `expandedSpacesStore` (`cards-space-expansion.ts`) already holds a per-workspace bit for the inactive ones; only the active override is in the way. **(verified)**

**[F03] Moving a card is a drag onto the header row alone, and the only feedback is a one-pixel outline on that header.** The pane-row `useBlockReorder` in `cards-card.tsx` passes `dropTargets: { selector: ".cards-space-header", attr: "data-cards-space-id", … }`, so the drop zone is the header's own height and nothing below it. The highlight is `.cards-space-header[data-drop-target="true"] { outline: 1px solid … }` in `cards-card.css`. Every row under a header already carries `data-cards-space-id` and `data-cards-space-run` (the workspace reorder's block key), so the whole indented block is addressable as one target today. **(verified)**

**[F04] A card move never changes the active workspace.** `moveCardToSpace` in `tugdeck/src/deck-manager.ts` has three branches — neither space active, source active, destination active — and none calls `activateSpace`. A card dragged out of the active workspace leaves it; a card dragged into it is revealed in place. The user's requirement is already the code's behaviour and is recorded here so the second pass keeps it. **(verified)**

**[F05] `deleteSpace` never consults a card's close guard, so a dirty File card is destroyed silently.** The delete loop calls `notifyCardWillBeginDestruction` for every card in the doomed deck and `closeUnboundCard` for its unbound live sessions; it never reads `getCardCloseGuard` (`tugdeck/src/lib/card-close-guard.ts`). The pane's own close path does — `resolveCloseGuard("pane")` in `tugdeck/src/components/chrome/tug-pane.tsx` visits every guarded card, activates each dirty one, and runs its Save / Don't Save / Cancel sheet, with any Cancel aborting the close. The confirm popover in `cards-card.tsx` only appears when `spaceHoldsLiveSessions` is positive, so a workspace holding files and no session deletes with no question at all. **(verified)**

**[F06] A switch unmounts every outgoing card and mounts every incoming one; the delay is that mount.** `activateSpace` parks the outgoing deck as data and installs the incoming deck as `deckState` in one `_flipFirstResponder` commit; `DeckCanvas` then renders a different set of panes, so React tears down every outgoing card's tree and stands every incoming one up. What does **not** happen on a switch: session bindings and `cardServicesStore` services survive (sessions are never destroyed), so `restoreSpaceSessions` skips every bound card and no `request_replay` is sent. The cost is therefore the DOM: a Session card's transcript body re-rendering its atoms from the in-memory store, its CodeMirror composer being recreated, File cards re-mounting their editors, and the `teardownSave("space-switch")` capture beforehand. **This is read from the code, not measured.** A performance trace bracketing `notify("activateSpace")` to the next paint on a workspace holding a session with a multi-megabyte transcript would confirm the attribution; the "1 turn, 1.5 MB" session in the user's screenshot is the natural subject. **(inferred)**

**[F07] The product already keeps hidden cards mounted rather than re-mounting them.** `CardHost` (`tugdeck/src/components/chrome/card-host.tsx`) keeps every background tab of a pane mounted and hides it with `display: none`, so identity, editor state and scroll survive a tab switch. This is the precedent the switch should follow, and it is also why the close-guard walk in [F05] works for background tabs: their guards are live because they are mounted. **(verified)**

**[F08] The pane title bar is a fixed spine of verb buttons, and one of them is already a popup menu.** `tug-pane.tsx` lays the trailing end out right to left — close box, card width, bullseye — as ghost icon buttons every card kind shares, with the card's own verbs (the Session card's summary `···`, Reveal in Finder) portaled in ahead of them by the masthead. Card width is a `TugPopupMenu` over a ghost `TugButton`, the sanctioned composition for a title-bar control that opens a list. A verb offered by every card kind belongs in the shared spine, at one offset on every pane. **(verified)**

---

## Decisions {#decisions}

**[B01] Every workspace verb gets a visible door in the card, and the Window menu carries the verbs as well as the list.** In the card: a New Workspace button in the filter bar, and a trailing `···` on every header row that opens the same menu the right-click opens (right-click stays). In the Window menu, above the workspace list: New Workspace, Rename Workspace…, Duplicate Workspace, Delete Workspace, each acting on the active workspace. Rename from the menu sends a control frame that reveals the Workspaces card if needed and opens the inline rename on the active workspace's row — the field is the one place a name is typed, and the menu is a door to it rather than a second editor. The "made once, deleted almost never" argument in [F01] was about frequency; discoverability is about the first time, and a verb nobody can find is not there.

**[B02] Every workspace folds, including the active one.** The active override in `buildCardsRows` goes; `expanded` is the `expandedSpacesStore` bit for every workspace, defaulting to expanded, session-only as before. The cue is never disabled. Folding the active workspace hides its rows in the list and nothing else — it says nothing about the deck on screen. This is what the user asked for in so many words, and a control drawn disabled with no state to offer is the thing [F02] shows a person clicking.

**[B03] The drop target for a card move is the whole workspace block, and the whole block wears the highlight.** The pane-row drag's drop targets become every element carrying `data-cards-space-run` whose value is not the dragged card's own workspace — header and every indented row. While the pointer is over any of them, every element of that run wears `data-drop-target="true"`, and the CSS washes the block with the accent tone rather than outlining one row. `useBlockReorder`'s `dropTargets` contract grows from "one element wears the attribute" to "every element sharing the target key wears it"; the single-element case is the degenerate one. The list's own drop conventions (a highlighted target you can see before you release) are the bar, and a one-pixel outline on a row the pointer had to find first does not clear it.

**[B04] A card move never follows the card.** Recorded as a decision so the second pass keeps [F04]: the active workspace is the one the user is working in, and a drag is a filing gesture, not a travel one. The moved card is announced where it landed by the destination header's count changing; nothing else moves.

**[B05] Deleting a workspace confirms once, then honours every close guard, and only then closes.** The order: (1) the confirm popover, always — "Delete *Name* and close *N cards* (*M sessions*)?" — whether or not any session is live; (2) if any card in the workspace has a guard whose `needsDecision()` is true, activate the workspace so the sheets are seen over their content, then walk the guards the way `resolveCloseGuard("pane")` does, one Save / Don't Save / Cancel per dirty card, with any Cancel aborting the delete and leaving the workspace active; (3) `deleteSpace`. Clean cards close without a question of their own; the workspace's confirm is theirs. This is the user's sentence — "cards can close without confirm provided the workspace confirms, but they can't clobber content that needs to be saved" — and it is the same contract the pane close already keeps in [F05]. Live sessions still close, as the first brief decided; the confirm names them.

**[B06] Workspaces stay mounted; a switch hides and shows rather than unmounting and mounting.** The deck canvas renders every workspace's deck, the inactive ones under `display: none`, the same way `CardHost` keeps background tabs alive ([F07]). `DeckManager` keeps the parked-deck *record* — the serialized shape, the `spaces` list, the snapshot contract and every verb are unchanged — but the React tree no longer follows only `deckState`: it follows all of them, and `activeSpaceId` chooses which is displayed. Consequences the arc has to carry: `teardownSave("space-switch")` is no longer needed as a capture (the bags are live) and the capture moment recorded in `tuglaws/state-preservation.md` is retired or narrowed; `parkedDeck`'s stripping of transient marks is no longer what a switch does, since nothing is torn down; and a hidden subtree measures as zero, so any geometry the canvas takes for a workspace (bullseye, flow offsets, rails, sheet reservations) must be taken when it is shown, not while it is hidden. The attribution in [F06] is an inference, so the arc's first act is the trace that confirms it, before any of this is built — if the switch is slow for a different reason, this decision is the wrong remedy.

**[B07] Memory pressure is managed later, not now.** With [B06], every workspace's DOM stays resident. The user's own framing is that some way to minimize pressure will eventually be needed but the landed behaviour is too conservative. So no eviction, no most-recently-used budget, no parked-after-N-minutes policy in this pass; the hook for one is the existing parked-deck record, which is exactly the shape an evicted workspace would take. A policy is a separate brief once there is a measurement to size it against.

**[B08] Move to Workspace is a popup menu in the pane title bar's shared spine, on every pane.** A `TugPopupMenu` over a ghost `TugButton`, composed like card width ([F08]), sitting in the trailing spine so it is at the same offset on a Session card's masthead as on a Text card. Its items are the other workspaces by name; choosing one calls `moveCardToSpace` for the pane's active card, and [B04] holds — the user stays where they are. With one workspace the button dims rather than disappears, the spine's own rule. The user named the session masthead as the surface; the spine is where the masthead's shared verbs already live, and a card of any kind moves, so the control is the pane's rather than the Session card's. Drag ([B03]) remains the fast path; this is the named door.

---

## Non-goals {#non-goals}

- **A chord to switch workspaces.** Still the first brief's non-goal; the Window menu and the card are the doors.
- **Moving live sessions to Main on delete instead of closing them.** Considered as the non-destructive reading of the user's delete note and rejected: a delete that relocates its contents is not a delete, and the confirm names the sessions so the close is chosen. Unsaved *content* is what must not be lost, and [B05] guards that.
- **An eviction or memory budget for mounted workspaces.** Deferred by [B07].
- **Changing the v5 blob, the `space` identifier, or the parked-deck record.** [B06] changes what React renders, not what is stored or parked.
- **A `···` on rows other than the workspace header.** Card rows keep the menus they have.

---

## Exit {#exit}

An arc, `workspaces-refine`. The natural order:

1. The trace that confirms or refutes [F06], since [B06] rests on it.
2. [B02] folding and [B01] the card's doors — small, independent, and what the user hits first.
3. [B03] the block-wide drop target and highlight, with [B04] held by a test.
4. [B08] the title-bar Move to Workspace menu, which shares [B03]'s `moveCardToSpace` path and its test.
5. [B05] the guarded delete, reusing the pane's guard walk rather than writing a second one.
6. [B01] the Window menu verbs, with the control frames they need.
7. [B06] mounted workspaces, last, because it changes the deck canvas and the capture doctrine and wants everything above it green first.

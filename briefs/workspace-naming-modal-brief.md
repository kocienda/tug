<!-- brief-skeleton v1 -->

# Workspace naming modal: New and Duplicate ask for the name first, and a new workspace loads behind the question

**Purpose:** Creating a workspace still flashes: the departing workspace flashes as it leaves and the sidebar cards flash as the new one arrives. The new workspace also lands at the bottom of the list, where the user does not want it.

---

## Purpose {#purpose}

The user's notes, 2026-11-11:

> - The new workspace should be added to the *top*, not the bottom of the list.
> - There's still *flashing* of the departing workspace. The sidebar cards also *flash* when the new workspace comes into view. I think a quick app-modal alert with a scrim over the whole screen would be better.
> - It might makes sense for use to ask for the new *name* of the workspace in that modal, just to break up the movement and flashing (to the extent that we can't ameliorate it elsewise).

And on Duplicate, in the same conversation:

> I think that if we suypport duplicate, we still need to ask for a name, with the name filled in as "Duplicate of <current-workspace-name>"

Three earlier rounds worked on the create (`briefs/workspace-create-flash-brief.md`, `briefs/workspace-switch-finished-picture-brief.md`, `briefs/workspace-skeletons-brief.md`). Each made the cut cleaner and left the gesture answering at once with cards that are still loading. The user still sees flashing. This round stops answering the gesture with the new workspace at all: it answers with a question, and the workspace is shown when it is ready.

---

## Evidence {#evidence}

**[F01] A new workspace is appended to the end of the list.** `createSpace` in `tugdeck/src/deck-manager.ts` calls `spacesStore.insert(record)` with no index, and `insert` in `tugdeck/src/spaces-store.ts` defaults the index to `this.records.length`. `insert` already takes an index. **(verified, read)**

**[F02] New Workspace creates, switches, and then asks for the name inside the Workspaces card.** The `NEW_SPACE` handler in `tugdeck/src/components/chrome/deck-canvas.tsx` calls `store.createSpace()`, reveals the Workspaces card, and hands `"rename"` to `cardsSpaceVerbRequest`. The card opens its inline field with `Workspace N` selected once its page has painted. Escape keeps the default name and the workspace stays. `tests/app-test/at0656-workspace-new-opens-name.test.ts` pins this, and `briefs/workspace-create-flash-brief.md` [B05] decided it. **(verified, read)**

**[F03] The create's cards are all new pages, and they take about 1.6 s.** `createSpace` builds the deck whole with the five factory rail cards and calls `activateSpace`. Each rail card is a new body page. `briefs/workspace-switch-finished-picture-brief.md` [F04] recorded a create's five rail cards painting over about 1.6 s, and `BodyRevealSet.horizonMs` in `tugapp/Sources/BodyHandOver.swift` is 2000, after which painted cards show as they come. **(verified, read; the 1.6 s is the earlier brief's reading, not retaken)**

**[F04] What the user sees flashing has not been recorded on this build.** The report is the user's, 2026-11-11. No frame recording of a create was taken for this brief, so which of the departing hand-over, the faces, or the reveal is the flash is not known. `tests/app-test/body-grounding/row-44-switch-create.test.ts` is the existing frame judge for a create, and it is green on a build the user reports as flashing. **(not verified: no recording taken)**

**[F05] Pages can already be made for a parked workspace, but only on a quiet pass.** `tugdeck/src/lib/body-make-ahead.ts` mounts a parked workspace unshown and asks for its cards' pages hidden. It runs only after `MAKE_AHEAD_QUIET_MS` (1000 ms) with nothing loading, takes one workspace per pass, and orders them most recently shown first. A bound Session card is never made ahead, because the session restore pass decides whether it resumes or spawns. A switch onto a workspace whose pages are made lands at once. **(verified, read)**

**[F06] Duplicate does not switch, so it does not flash.** `duplicateSpace` in `tugdeck/src/deck-manager.ts` copies the source's layout and sidebars, names the copy `<name> copy`, inserts it directly after the source, and does not activate it. Its docblock gives the reason under [P06]: "Duplicate is a gesture about the list, so the user stays where they were working." The sketch in conversation said Duplicate "likely flashes the same way" as New; that was wrong. **(verified, read)**

**[F07] The app-modals live in one tree that covers the card pages.** `tugdeck/src/components/tugways/app-gates.tsx` mounts the version gate, the restore gate, the setup wizard and the update wizard in the host's overlay page, "the one page nothing covers", on the `TugAlert` chrome. `tugdeck/src/components/tugways/tug-modal-input-dialog.tsx` is the existing app-modal with a typed field, built around a search field and a result list. **(verified, read)**

**[F08] A sheet over a workspace's arrival was built once and reverted.** `briefs/workspace-skeletons-brief.md` [F07] records `dc92f4ead`: an opaque sheet with a barber pole that hid the skeletons, appeared and vanished on switches of 100 to 300 ms, and passed only harness checks. That brief lists "a sheet, modal or otherwise, over the arriving canvas or the window" as a non-goal. **(verified, read from the brief)**

---

## Decisions {#decisions}

**[B01] New Workspace and Duplicate Workspace each open an app-modal that asks for the name.** A scrim covers the whole window, card pages included, and a small panel holds one text field with the proposed name filled in and selected, a Cancel button and a commit button. It mounts with the other app-modals ([F07]). Every door to either verb opens it: the Workspaces card's button, the row menus, and the Window menu. It is one component with two callers.

**[B02] The proposed name is `Workspace N` for New and `Duplicate of <source name>` for Duplicate.** `Workspace N` is `nextSpaceName`'s answer, unchanged. `Duplicate of <source name>` is the user's wording and replaces `<name> copy`. A name that is empty after trimming is not committed, which is `renameSpace`'s existing rule.

**[B03] Cancel and Escape create nothing.** The user confirmed this. It reverses today's behaviour, where the workspace exists before the name is asked and Escape keeps the default ([F02]). After a cancel the list, the Window menu, the saved layout and the screen are exactly as they were before the gesture.

**[B04] A new workspace goes in at the top of the list.** The user's ruling. `createSpace` inserts at index 0 ([F01]).

**[B05] A duplicate stays directly after its source and is not activated.** This is [P06] as built ([F06]), and nothing the user said reverses it. In conversation the model offered "top of the list" for a duplicate as its own default, on the false premise that a duplicate switches; that offer is withdrawn. For Duplicate the modal is only a name prompt: commit inserts the named copy and closes, and no workspace changes on screen.

**[B06] For New, nothing changes under the scrim until the new workspace's pages have painted.** At open the new workspace is built whole, as `createSpace` builds it today, but held pending: mounted unshown, absent from the Workspaces list and the Window menu, and never written to the saved layout. Its five rail cards' pages are asked for at once, hidden, by the make-ahead path's own hand-off ([F05]) without waiting for that pass's quiet second or its turn in the order. The departing workspace stands still under the scrim the whole time. Quitting with the modal open leaves no trace, because a pending workspace was never saved.

**[B07] Commit is one cut under the scrim, then the scrim fades.** On Return the name is applied, the workspace joins the list at the top, and the deck cuts to it. If its pages have all painted, the cut is immediate. If not, the panel shows the deck's progress wave in place of its buttons and the cut waits, bounded by the same 2000 ms as the reveal set's horizon ([F03]); at the bound it cuts regardless. The wait is spent on the old, still picture, so the scrim stays translucent and never needs to hide anything but the one cut. Focus lands on the new workspace's row in the Workspaces card.

**[B08] The inline name field on create is retired, and that is a reversal.** `briefs/workspace-create-flash-brief.md` [B05] and `at0656-workspace-new-opens-name.test.ts` hold that a new workspace opens its name field inside the Workspaces card. The name is now asked in the modal, so that decision is reversed, not re-pointed: `at0656` is rewritten to assert the same guarantee in its new place (New Workspace asks for a name with the default selected, and the name typed is the name the workspace wears), and the earlier brief gets a line saying [B05] is superseded here. Rename Workspace is untouched and stays inline.

**[B09] The no-sheet rule is carved out for these two verbs only.** `briefs/workspace-skeletons-brief.md` rejects a sheet over an arriving workspace because it hides the skeletons, which carry the user's own cards ([F08]). A new workspace has no cards of the user's to show, only five factory cards, and this modal has something to say, a question, where the reverted sheet had only a spinner. A switch between existing workspaces keeps its skeletons and gets no modal. The skeletons brief gets a line naming this exception.

**[B10] Loading before showing is allowed here, and that is a reversal too.** Warming a new workspace's pages before showing it was rejected in `briefs/workspace-create-flash-brief.md` and again in `briefs/workspace-switch-finished-picture-brief.md`, because it made the gesture wait with nothing on screen. Here the gesture is answered at once by the modal and the loading happens while the user reads and types. The objection does not apply, and those two briefs' non-goals stand for every other gesture.

**[B11] A frame judge for the modal create lands red first.** One recording across New Workspace, from the gesture to the scrim's last frame: no frame under the scrim differs from the departing picture before the cut; exactly one cut; no rail pane shows a lid, a face or bare canvas after it; no pane rect moves after it. It is run on the current build first so it fails, and it carries `@covers`. `row-44-switch-create` goes on judging the hand-over it already judges.

---

## Open Questions {#open-questions}

- **Which flash the user is seeing.** [F04]: not recorded. [B06] and [B07] are built so the answer does not change the work, because nothing moves under the scrim but one cut onto painted pages. If the cut itself still flashes on the user's deck with every page painted, that is a hand-over defect this brief does not cover, and [B11]'s recording is what would show it.

---

## Non-goals {#non-goals}

- **A modal or scrim on a switch between existing workspaces.** Skeletons are the answer there ([B09]).
- **Activating a duplicate, or moving it to the top.** [P06] stands ([B05]).
- **An opaque sheet.** The reverted shape ([F08]). The scrim is translucent and what it covers is still.
- **Making a duplicate's cards ahead.** A duplicate is not shown at commit, so the ordinary make-ahead pass reaches it like any parked workspace.
- **Changing Rename Workspace.** It stays the inline field in the Workspaces card.
- **Load time, the lane's width, or more spare pages.** As in the earlier briefs, how long a page takes is not the subject.

---

## Exit {#exit}

An arc. The first act is [B11]'s recording on the current build, which gives the judge its red and may answer [F04]. Then the modal itself ([B01], [B02]) wired to Duplicate, which needs nothing new beneath it ([B05]) and proves the component and its cancel ([B03]). Then the pending workspace and its hidden pages ([B06]), the commit and its bounded wait ([B07]), and the top-of-list insert ([B04]). Last, the reversals written into the tests and the two earlier briefs ([B08], [B09], [B10]); `at0582-workspace-doors.test.ts` and `at0586-window-workspace-verbs.test.ts` drive these verbs and will need to answer the modal.

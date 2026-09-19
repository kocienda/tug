# Card Opening Placement

**Purpose:** A new card's slot is chosen by two unrelated rules that never look at the column they land in, so a fresh Session card or a cited file routinely opens into a split column, and the same gesture opens in different places depending on which door it came through. One API should read the deck, name the opening context, and choose the slot, and every opener should go through it.

---

## Purpose {#purpose}

The user's words: "It's not ideal to open a new card as part of a column that's split. It's better to add cards to the right of a split column. Adding a card on top of a stack column is typically fine." And, after the survey: "We need a *complete and consistent* API for gathering the deck/canvas/slot/column information, determining the calling context for opening a card, and then placing the new card in its proper place. No more guessing. Leave no stone unturned and no cases uncovered. Make sure we route *all* the appropriate callers through this new code."

The doors in question are the File menu's New commands, a click on an annotation link, and the rows of the popup menus that open a card (Open in Editor, Open Commit, Open Diff, Resume Session, Run in New Session), plus everything else that reaches `addCard`.

---

## Evidence {#evidence}

**[F01] Every opener converges on one call, and the slot has exactly two inputs.** `DeckManager.addCard(componentId, seed, { slot?, opening? })` in `tugdeck/src/deck-manager.ts` is the one entry. Under one-up nothing is slotted and the card cascades. Under any N-up the pane takes `options.slot` when the caller named one, else the private `_openingSlot()`. Centered dialog registrations (`placement: "center"`) are never slotted. **(verified)**

**[F02] The two placement rules are index arithmetic and never read a column.** `_openingSlot()` answers the arrangement's centermost slot in fit, and in flow the centermost slot the band wholly shows (`centerVisibleFlowSlot`), cheating left on ties. `neighborSlot()` in `tugdeck/src/lib/neighbor-slot.ts` answers the slot immediately left of the origin's slot, or immediately right when the origin is leftmost, and abstains (`undefined`) when the origin holds no slot. Neither calls `columnModeOf`, `deckColumnsOf`, or `columnIsWall`; a grep of the openers and `action-dispatch.ts` finds no column reading anywhere on the path. **(verified)**

**[F03] Seating inside the chosen slot is already a rule and stays one.** A stacked column takes the newcomer on top as the active pane. A split column seats it at the bottom in the same commit (`withMemberSeated`, [D194]) and weights it (`arrivalSharesOf`, [D195]). A Session card arrives hidden and reveals when its picker has measured. All of this runs after the slot is chosen and is indifferent to how it was chosen. **(verified)**

**[F04] A wall is not protected from an arrival.** `panesWithWallFolded` runs only inside `setPaneFolded(false)`. A card arriving through `addCard` into a split column with a folded member does not fold the sitters, so the wall's one-open-card shape ([P06]) is broken by any open that lands there. **(verified)**

**[F05] The doors disagree about the origin.** `resume-session` and `run-command-in-new-session` in `tugdeck/src/action-dispatch.ts` take `payload.originCardId` (the menu's host card) first and the first responder second. `openFileInCard`, `openCommitInCard`, and `openDiffInCard` in `tugdeck/src/lib/` read only `store.getFirstResponderCardId()`. The file and commit identity menus (`file-identity-menu.tsx`, `commit-identity-menu.tsx`) dispatch `OPEN_FILE` / `OPEN_COMMIT` / `OPEN_DIFF` through `dispatchCommand` with no origin in the payload, and the annotator registry's `file-path` primary click does the same. A right-click in an unfocused card therefore opens beside the wrong card. **(verified)**

**[F06] The complete door table, as the code stands.** **(verified)**

| Door | Reaches | Slot rule | Origin |
|---|---|---|---|
| File ▸ New Session (⌘N); Maker ▸ New Hello, New Spikes | `show-card` → `addCard` | deck guess | none |
| File ▸ New Text File (⌥⌘N) | `NEW_TEXT_CARD` in `deck-canvas.tsx` → `addCard("text")` | deck guess | none |
| Settings (⌘,), Keyboard Shortcuts, DevTools, About, Spikes index, color picker | `showSingletonCard` / find-or-`addCard` | deck guess, or centered | none |
| Configure Tug wizard "Open Session" | `configure-tug.tsx` → `addCard("session")` | deck guess | none |
| Maker ▸ New Component Gallery Card | `addCard("gallery-buttons")` | deck guess | none |
| ⌘O, Open Recent, Finder drop, dock drop | host `open-file` frame → `openFileInCard` | neighbor | first responder |
| Open Quickly | `open-quickly-overlay.tsx` → `openFileInCard` | neighbor | first responder |
| Annotation link click on a file path; "Open in Editor" | annotator registry → `OPEN_FILE` → `openFileInCard` | neighbor | first responder |
| `/ref` batch open from a Session card | `session-card.tsx` → `OPEN_FILE { targets }` | neighbor, per card | first responder, which becomes each freshly opened card |
| Changes list row, file block, arc documents list, attachment open | `openFileInCard` | neighbor | first responder |
| Commit pill click; "Open Commit"; "Open Diff" on a sha or a commit row | `OPEN_COMMIT` / `OPEN_DIFF` → `openCommitInCard` / `openDiffInCard` | neighbor | first responder |
| Session identity menu "Resume Session" | `RESUME_SESSION` | neighbor | host card, then first responder |
| Slash-command menu "Run in New Session" | `RUN_COMMAND_IN_NEW_SESSION` | neighbor | host card, then first responder |
| File ▸ New Jot | `showSidebarPane` (rail) | n/a | n/a |
| Maker ▸ New Card in Active Pane | `addCardToPane` (joins a pane as a tab) | n/a | n/a |

**[F07] Three app-tests pin the old behaviour.** `at0369-open-file-neighbor-slot` pins left-first and the leftward compose. `at0571-picker-card-arrival` pins a Session card from ⌘N landing in the split column at slot 0, and its fixture comment says so in words. `at0454-flow-mode` pins that a file link names the slot to the left and the arrival reveals it. **(verified)**

**[F08] The deck already has every reading the new rule needs, in the store's selectors and the imposer.** `deckColumnsOf(state, run)` is the deck's one reading of its columns (slot, members, mode, shares). `columnModeOf` answers stack or split. `columnIsWall(panes, paneId, members)` answers whether a split column holds a folded member. `deckFlowStrip(state)` and `centerVisibleFlowSlot({ strip, band, offset })` answer what the band shows in flow. `slotCount(kind)`, `centerSlot(kind)`, and `clampSlot` answer the arrangement. `findSidebarPanes` separates rail panes from slotted ones. `_flowBandWidth` is private to the manager. Nothing composes these into one answer today. **(verified)**

**[F09] The popup menus can name their host card.** `use-annotation-menu.tsx` holds `cardId` and already passes it as `originCardId` for Run in New Session. `session-identity-menu.tsx` holds `hostCard`. The file and commit identity menus sit on the responder chain (`useResponderChain`, `useOptionalResponder`) and derive a clipboard origin from it, so the host card is reachable there too. Whether the annotator registry's primary click can learn its host card without a new argument is inference from reading `registry.ts`, not verified: the click is dispatched through `dispatchCommand` with a target payload and nothing else.

---

## Decisions {#decisions}

**[B01] One function decides every opening slot, and the two existing rules are retired.** A single manager method, provisionally `openingSlotFor(context)`, replaces `_openingSlot()` and `neighborSlot()`. Both are deleted rather than kept as fallbacks: two rules for one question is the source of the inconsistency ([F02], [F05]), and a fallback that survives is a rule that still runs. The whole reading is a pure function over `DeckState` plus the two measurements the manager owns (the column run and the flow band), so it is unit-testable without a DOM.

**[B02] The deck reading is one composed value, built from the selectors that already exist.** A pure `readOpeningDeck(state, { run, band })` in a new `tugdeck/src/lib/opening-placement.ts` returns: the kind and layout; every slot the kind defines, each classified as `empty`, `stack`, `split`, or `wall`; each slot's members; and, in flow, the set of slots the band wholly shows. It is built on `deckColumnsOf`, `columnModeOf`, `columnIsWall`, `deckFlowStrip`, and `centerVisibleFlowSlot` ([F08]) and adds no second derivation of any of them. Rail panes and centered dialogs are excluded from the reading, as they are from the arrangement.

**[B03] The opening context is explicit, and the manager resolves it, not the caller.** `addCard`'s `slot?: number` option is removed and replaced by `origin?: string | null`: the card the gesture was made in. The manager resolves the anchor in order: the named origin when it holds a slot; else the first responder when it holds a slot; else the deck itself. A caller can no longer name a slot by its own arithmetic, which is what "no more guessing" means in code. The one legitimate way to name a slot remains the verbs that already own it (a drop with a zone index, the Layout card's assignment, the ⌘-digit chord), none of which go through `addCard`.

**[B04] Every opener passes the origin it actually has.** The rule from `resume-session` becomes universal: the menu's host card first, the first responder second. Concretely: `openFileInCard`, `openCommitInCard`, `openDiffInCard`, and `openAttachmentPath` gain an `originCardId` parameter; the `open-file`, `open-commit`, and `open-diff` payloads gain an optional `originCardId`; the annotation-menu, file-identity-menu, commit-identity-menu, and session-identity-menu rows fill it from their host card; the annotator registry's primary click fills it from the card the annotation is mounted in; the `/ref` batch open fills it with the Session card for every target. Doors with no card (⌘N, ⌥⌘N, ⌘O, Open Recent, Finder and dock drops, Open Quickly, the Configure Tug wizard, the singletons, the Maker items) pass nothing and take the first responder or the deck.

**[B05] The rule: nearest qualifying slot, and a split column never qualifies.** From the anchor, every slot of the arrangement is ranked by three keys in order: distance from the anchor; `empty` before `stack`; right before left. A `split` or `wall` slot is not a candidate. For an origin-anchored open the origin's own slot is excluded outright, so a file never covers the card that cited it (at0369's third case, kept). For a deck-anchored open the anchor slot is itself a candidate at distance zero. Distance first because the eye is at the anchor and the nearest place is the least travel; empty before stack because an empty slot was held open on purpose ([pane-model.md], "every slot the kind defines holds its place"); right before left because reading order runs rightward, a cited file belongs after the passage citing it, and repeated opens then walk toward open deck instead of toward slot 0's dead end.

**[B06] When nothing qualifies, the arrival lands at the bottom of the nearest split.** If every candidate is split (or, for an origin open, every slot but the origin's), the same three keys rank the split slots and the winner takes the newcomer at the bottom per [D194]. Nothing new is decided there. A wall is ranked last among splits, and an arrival that does land in a wall folds the sitters in the same commit through `panesWithWallFolded`, closing [F04]. The user's stated preference is that a split is not a good place for an arrival, not that it is forbidden, and a deck of nothing but splits still has to open cards.

**[B07] Flow confines a deck-anchored open to the band; an origin-anchored open is not confined.** A card from nowhere must open where the user can see it, so its candidates are the slots the band wholly shows, falling back to the slots the band touches, then to the whole arrangement, exactly as `centerVisibleFlowSlot` already staggers its answer. An origin-anchored open ranks over the whole arrangement, because the origin is what the user is looking at and the existing two-move reveal takes the deck to the arrival ([pane-model.md], "TWO MOVES, NOT ONE"). Fit is never confined; every slot is on screen.

**[B08] One-up, centered dialogs, rail cards, tab adds, and reuse are outside the rule and stay as they are.** One-up cascades. A `placement: "center"` registration centers. `showSidebarPane` pins to a rail. `addCardToPane` joins a pane. A path-keyed, descriptor-keyed, or singleton reuse activates an existing card and places nothing. Each is a different verb with its own placement already, and the rule governs only a fresh slotted arrival.

**[B09] Seating, weighting, hidden arrival, and bound opening are unchanged.** The slot is chosen first; `_impositionSeating`, `_arrivalShares`, the hidden Session arrival, and `opening: "bound"` run after it exactly as today ([F03]). This brief moves the choice of slot and nothing downstream of it.

**[B10] The three pinning tests are re-pointed as this decision, in the open.** `at0369` becomes the nearest-qualifying test, with a fixture rewritten so each of the three keys is exercised once: a stacked slot 1 and an empty slot 3 beside an origin at slot 2 proves empty beats stack at equal distance; two stacked neighbours proves right beats left; a split right neighbour proves a split is skipped. `at0571`'s fixture gains an empty slot 1 and asserts the Session card opens there rather than in the split, and a second case seals slot 1 to prove the bottom-of-split fallback still rides in on the picker. `at0454` keeps its reveal assertion and follows the new slot. A new unit suite pins `readOpeningDeck` and the ranking over synthetic states, every key and every fallback. The memory rule that re-pointing a pin buries a decision is why this is written here rather than done quietly: [D194] stays, [B05] is the new pin.

**[B11] The rule is recorded in `tuglaws/design-decisions.md` as a D-number and in `pane-model.md`'s column section.** The line "the fallback never decides where a new card goes" gains a sibling: the arrangement, not the caller, decides which slot a new card takes, and a split column is not a landing place.

---

## Open Questions {#open-questions}

- **Whether `dispatchCommand` can carry the host card for a primary click without a new argument to the annotator registry.** [F09] leaves this as inference. If the responder chain already knows the card the click was made in, the `open-file` payload can be filled at the canvas handler; otherwise the registry's `primaryClick` gains the host card id. Reading `command-dispatch.ts` and the chain's event shape settles it; it changes one file either way, not the rule.

---

## Non-goals {#non-goals}

- **Growing the arrangement on an open.** A two-up whose both slots are split does not become a three-up because a card arrived. The kind is the user's stated intent for the whole deck and only the Layout card changes it. Rejected because an arrangement that widens on its own is a deck ignoring what it was told, the same fault [F01]'s slot rule was written to avoid.
- **Choosing the seat inside the column.** Top or bottom of a split, front of a stack, the newcomer's weight: all already decided by [D194] and [D195] and not reopened.
- **Placement for drops, the Layout card, and chords.** Those verbs name a slot by gesture and are correct to. Only unaddressed arrivals through `addCard` are in scope.
- **A user setting for the direction or the ranking.** One rule, no knob; a knob would be a second way to end up with two rules.
- **Keeping `neighborSlot` for callers outside the deck.** Its only callers are the openers this brief reroutes.

---

## Exit {#exit}

**An arc.** The shape, in the order the pieces depend on each other:

1. `opening-placement.ts`: `readOpeningDeck` and the pure ranking, with a unit suite over synthetic states covering every slot class, both anchors, both layouts, the band fallbacks, the all-split fallback, and the wall.
2. `DeckManager.openingSlotFor(context)` over that module, the `origin` option on `addCard`, the wall fold on arrival, and the deletion of `_openingSlot` and `neighbor-slot.ts`.
3. The openers: `open-file-in-card.ts`, `open-commit-in-card.ts`, `open-diff-in-card.ts`, `open-attachment.ts`, the three action handlers in `action-dispatch.ts`, the `NEW_TEXT_CARD` and singleton handlers in `deck-canvas.tsx`, the wizard, and the payload fields.
4. The menus and links: the annotation menu, the file and commit identity menus, the session identity menu, the annotator registry's primary click, and the `/ref` batch.
5. The re-pointed app-tests and the tuglaws entry.

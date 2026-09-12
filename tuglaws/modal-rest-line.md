# The modal rest line — where a card's surfaces rest, and which way they grow

A Session card is a transcript. Content arrives at the bottom, the history scrolls away above it, and every inline thing the card raises — the permission dialog, the question wizard — arrives at the tail because that is where a transcript's present moment is. The card's *overlay* surfaces used to disagree: most of them dropped from the pane title bar and grew downward, at the far end of the card from the chip or menu item that opened them, against the direction everything behind them moves. This doc is the rule that replaced that, and the three exemptions it earns.

## The rule

**A modal surface on a Session card rests on the bottom edge of the view slot, and grows up.**

That edge is `.session-view-slot`'s bottom — the top of the Z2 status bar, or the top of the find bar while the bar is open, since the find bar is a flow sibling between the slot and Z2 and therefore inside neither. It is one line for the whole card, so no call site has to decide where its surface belongs.

The line has a name: `MODAL_REST_LINE` in `tugdeck/src/components/tugways/cards/modal-rest-line.ts`. Pass it, never the literal selector — the constant is what makes this a rule rather than a coincidence that eleven files agree.

## Taking the line

Which mechanism a surface uses depends on what kind of surface it is. All three land on the same edge.

| Surface kind | How it takes the line | Example |
|---|---|---|
| A **shade** filling the view slot | `shadeAnchor="bottom"` on the `TugSheetContent` | History (`session-card.tsx`) |
| A **panel sheet** portaled to the pane frame | `bottomAnchorSelector: MODAL_REST_LINE` plus `presentation: "rise"` | Usage, Help, Rewind, Permissions, and the rest |
| A **pane-modal alert** raised through a card's `showSheet` | the same pair, once, inside `presentAlertSheet` | `tug-alert-sheet.tsx` |
| A **canvas-level alert** | the anchor is captured, not resolved — see below | `TugAlert` |

The `rise` entrance goes with the anchor — and it goes with the anchor the sheet actually **resolved**, not with the pair the call site passed. A surface that rests low should arrive with a short settle onto its line rather than a full-height sweep from the top; the two together are what make the geometry read as intentional instead of as a panel that happens to be positioned oddly. Where there is no line to rest on, there is nothing to rise from either, so a surface that asked for the pair and found no line drops from the masthead instead, and the same surface on the same card rises again the moment the line comes back. Call sites keep passing the pair; the sheet decides what the pair means when the line is absent.

### The alert's anchor is captured, not contextual

There are two alert paths and they take the line by different means. The pane-modal one — `presentAlertSheet`, which composes `TugSheet`'s proven pane-modal substrate rather than Radix's global trap — is an ordinary panel sheet, so it takes the anchor and the `rise` entrance in the one place every caller goes through. The app-modal one cannot.

`TugAlert` portals to the **canvas** overlay root rather than to a pane frame, so it has no `TugPanePortalContext` and `bottomAnchorSelector` — which resolves inside `cardEl` — has nothing to resolve against.

So the alert captures its anchor at the moment the host **raises** it, in `alert()` and `choose()` before `setOpen(true)`: the rest line inside `document.activeElement.closest("[data-card-id]")`. That instant is the only correct one. Radix moves focus on open and the engine's trap captures and restores it, so any later read answers about the alert rather than about the card that raised it.

The alert is centred horizontally on its anchor's box, not on the viewport. Bottom-pinned to one card while centred on the whole window would read as unmoored from the card it belongs to; one rule places both axes on the same card.

## Where a panel that does not fit grows

The line is a **preference**, not a ceiling. A panel needing more height than the band between the title bar and the line — the Session card's prompt entry grown tall leaves the slot a sliver — is not pushed up against the title bar and made to scroll: a sheet is a panel, read at a glance, and the region below the line is exactly what a modal is entitled to paint over.

So it grows **down first, then up**, and both edges are measured against the **visible canvas** rather than against the host pane's own frame.

- Down: the clip's bottom edge slides past the line, and past the frame's own bottom edge if it must, stopping `SHEET_CANVAS_GAP` above the canvas bottom and never below the viewport.
- Up: whatever the downward growth could not absorb comes off the top, so the clip's top goes negative — above the masthead — stopping the same gap short of the canvas top.
- Only a panel taller than the canvas itself scrolls. That is a limit the window imposes, not one the pane does.

Nothing about the ordinary case moves: a panel that fits rests on its line exactly where this doc has always put it. What the growth order rules out is any per-pane cap on a sheet's height — a pane too short to hold the panel is not a reason to cut the panel down, because the frame does not clip and the panel is allowed past it. `tuglaws/pane-model.md` carries the paint-order half of that: the pane holding the panel is lifted above its peers while it is up, so growing past the frame does not mean growing under a neighbour.

## The fallback is not an exemption

A host with no view slot — the settings session card body, a text or image or PDF card — matches nothing, and the surface keeps the sheet's default top anchor. That is the right answer there and needs no exception clause: the rest line is a fact about a transcript's shape, and a card that is not a transcript has none.

**A folded card's sheet is answered by the fold rule, not by the anchor.** This section used to carry a second clause — a slot with no box is no slot — because a folded Session card keeps its view slot in the tree and takes it out of layout (`.session-card[data-fold="settled"] .session-view-slot { display: none }`), so the selector matched a real element whose rect was all zeros, and anchoring to that put the clip's bottom edge at the top of the viewport. The clause was a way of surviving a sheet on a folded card. The folded card's own rule removed the case instead: a folded card is its masthead and its Z2 row, so a sheet the user asks for opens the fold *first* and then rises from a line that is there, a sheet nobody asked for is answered in the Z2 row and raises no panel at all, and the fold gesture stands down whatever sheet was already up before it commits — beside the find bar and the shade it already closed.

So the anchor is the match, resolved once, and nothing here knows what a fold is. Three cases and no fourth: no selector, a selector matching nothing, or a slot with a box. The one thing a reader should carry away is that a boxless rest line is not a state this component is expected to hold up under — if one ever reaches it, the defect is upstream, in whatever raised a panel over a card that is showing one row.

## The exemptions

Each is a decision with a reason, recorded so it does not have to be re-argued. A surface not on this list takes the line.

**The Changes shade** rests on the top of the prompt-entry region instead — it covers Z2 — because it *is* the commit surface. The message editor below it is part of the same gesture, so its bottom edge belongs on the entry region rather than on Z2. Nothing else has that tie-in, so nothing else pays for it. A refusal of that gesture speaks on it — `SessionLandingNoticeStrip`, in the entry region under the shade's bottom edge, outside the scrim by geometry rather than by z-index — so a landing failure never goes to a lane the scrim covers. [D117], [P17]

**Choose Session** and **Compacting** keep the top anchor. Both stand where there is no transcript behind them — the cold-start picker before a session exists, and the cover over a compaction run — so a rise from Z2 would be a motion with nothing to reveal.

**The attachment preview** keeps the top anchor, for a reason that is about its sizing rather than about geometry. It is the only `resizable: true` sheet and the only `aspectLockContent` one, so its height comes from its width and its only cap is the width cap the canvas-clamp effect writes. Anchored, the band above the rest line gives it more height than the canvas clamp did, so that width cap binds where the height term used to — and the cap is a fraction of the *pane frame*, which is a couple of pixels wider than the card box `at0365-overview-card.test.ts` measures. Deciding which box "the card" is for that cap belongs to the attachment preview's sizing contract, not here.

## Resizing a bottom-anchored panel

A resizable sheet renders the handle set its anchor calls for, chosen in `tug-sheet.tsx`: south and the bottom corners when top-anchored, north and the top corners when bottom-anchored. In each case those are the edges that actually move, and dragging the edge a panel does *not* move from is what makes a resize feel like it is growing away from the cursor.

The drag math is a mirror and nothing more — `height = startH - dy` against the top-anchored `startH + dy` — because the bottom-anchored clip already bottom-aligns the panel (`justify-content: flex-end`), so a taller panel extends toward the masthead on its own. Nothing is repositioned.

One coupling is easy to miss and is why this section exists. The canvas-clamp effect stands down for a bottom anchor, on the correct reasoning that a clip bounded on both edges is capped by CSS — but **aspect-locked content is the exception**, because its height comes from its width, so `max-height` caps nothing that matters and its only cap is the width cap that effect writes. The guard is `bottomAnchorEl !== null && !aspectLockContent`, and the aspect-lock branch reads its available height from the clip, which bounded on both edges *is* the band. Standing down clears the inline `max-height` on the way out, because a card dragged to another pane re-runs the effect against a new frame and a panel capped at a number computed for the old one is a cap nobody can account for.

## What is not on the card, and does not move

`TugModalInputDialog` (Open Quickly) is canvas-level rather than card-level. `TugPaneBanner` pins under the title bar deliberately — it is a persistent error strip, not a presentation. Popovers, confirm popovers, context menus and popup lists are trigger-anchored and already flip by available space. The top-right transient-notice host is a corner toast lane, and it carries nothing landing-shaped: a commit or join refusal belongs to a gesture with a grain, and speaks on it. None of these has a card's grain to obey.

## A note on the shared shade `persistKey`

History and Changes share `persistKey="session-card"`, and therefore share one persisted height fraction. Both are `shadeAutoSize`, which ignores the fraction and renders no grabber, so the sharing is inert — nothing writes it and nothing reads it for height. It is worth knowing rather than fixing: the key is a *shared height memory* by design, and two surfaces that now rest on different lines should not keep sharing one if either ever drops `shadeAutoSize`.

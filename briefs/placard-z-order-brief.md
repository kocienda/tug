# One Z2 Placard at a Time, and the Last Raise Wins

**Purpose:** Two folded Session cards running arcs can each hold an open Z2 placard, and when they do, which one paints on top is decided by deck array order rather than by which the user just opened. The overlap should be impossible, and the tie that survives it should be settled by recency.

---

## Purpose {#purpose}

From the report: "When I have two split/folded cards running arcs, clicking the Arc Z2 item in one *overlaps or goes under* the popup in another. There must be a rule that when any Z2 popup overlaps any other Z2 popup, the new one must make the other one hide." The accompanying screenshot shows a wall of three cards — two folded, one open — with the second card's ARC placard hanging down over the third card's body, partly over it and partly under it: "the popup for the top card is *actually showing*, but is being blocked by the card beneath it."

The complaint arrives as a z-ordering complaint and the closing line asks for the z-ordering to be "worked out more completely". It is worth saying plainly at the top that only half of it turned out to be one.

---

## Evidence {#evidence}

**[F01] The Z2 placard already declares the rule the report is asking for, and one line defeats it.** The Session card's telemetry placard is rendered with `dismiss="auto"` (`tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx:1709`), which is the placard family's "closes on an outside pointerdown or Escape" mode. What makes a second placard openable while the first is up is the trigger exemption in `usePlacardAutoDismiss` (`tugdeck/src/components/tugways/tug-placard.tsx:247`):

```ts
if (triggerSelector !== undefined && target.closest(triggerSelector)) return;
```

The caller passes `triggerSelector="[data-placard-trigger]"`, and `TugStatusCell` writes that bare, valueless attribute on **every** Z2 cell in **every** card (`tugdeck/src/components/tugways/tug-status-cell.tsx:170`). So a pointerdown on card B's ARC cell matches card A's trigger selector, and card A's placard declines to dismiss. **(verified — read out of the three files named.)**

**[F02] The exemption is load-bearing, so it must be scoped rather than removed.** Re-clicking the cell a placard was opened from is a toggle-to-close (`togglePlacard`, `session-card-telemetry-renderers.tsx`). Without the exemption the pointerdown would close the placard first, and the ensuing click would then find `placardKeyRef` already null and reopen it — the cell could never close its own placard. The exemption is correct in intent and wrong only in reach: it says *any trigger anywhere* where it means *my trigger*. **(verified by reading the toggle and the watcher together; not reproduced at runtime.)**

**[F03] The pane lift that lets a folded placard escape its frame is flat, so two raised frames tie.** A folded card's placard portals into the pane frame and hangs below it, and `raisePaneAbovePeers` (`tugdeck/src/components/tugways/pane-raise.ts`) marks the frame so `tug-pane.css:1569` lifts it to `--tug-z-pane-sheet-open`. That token is a flat `8900` (`tugdeck/styles/chrome.css:67`), applied `!important` over the deck's inline per-pane z, and its comment states the flatness as a decision: the deck's focus-order z map is deliberately neither consulted nor changed. With exactly one raised surface that is right. With two, both frames carry `8900` and the tie falls to paint order — the card later in the deck array wins, whichever placard the user opened last. **(verified — read out of `pane-raise.ts`, `tug-pane.css`, and `chrome.css`.)**

**[F04] The tie is not confined to Z2, and exists today without two placards.** `raisePaneAbovePeers` is shared by the pane-modal sheet (`tugdeck/src/components/tugways/tug-sheet.tsx:2224`) and the folded Z2 placard (`session-card-telemetry-renderers.tsx:1206`) — one attribute, one rule, one ref-count, by design. A sheet open on one card and a folded placard overhanging from another therefore collide on the same flat `8900` already, with no second placard involved. **(verified — read out of the two call sites.)**

**[F05] The placard's own `z-index: 20` is not part of the problem.** `.tug-placard` carries `z-index: 20` (`tugdeck/src/components/tugways/tug-placard.css`), which orders it inside its host's stacking context — above the status strip's content. The frame is what moves relative to peer panes; the placard's own value never competes across cards. **(verified — read out of the stylesheet.)**

---

## Decisions {#decisions}

**[B01] The trigger exemption is scoped to the placard's own trigger node, not to a selector that matches every card's.** The exemption's whole job is to let the cell that opened a placard close it again ([F02]); everything else matching `[data-placard-trigger]` is, for this placard, an ordinary outside pointerdown. The spelling to prefer is handing the placard its own trigger **element** and testing `contains()`, rather than narrowing the selector with a card id: a selector is a description of a class of nodes, and the thing being described here is one specific node, so naming the node ends the class of bug instead of shrinking it. A card-id-stamped attribute is the acceptable fallback if the element cannot be threaded to the placard without churn.

**[B02] Opening any Z2 placard closes every other one, unconditionally — no overlap test.** The report's literal phrasing is "when any Z2 popup overlaps any other Z2 popup", but the geometric reading buys nothing and costs a rect test, a re-test on every resize and fold, and a rule the user has to model spatially to predict. The unconditional rule is also already the surface's declared one: `dismiss="auto"` means a placard closes when attention moves off it, and [B01] is what restores that meaning rather than adding to it. Revisit only if a deck shape appears where two simultaneously-readable Z2 placards are a thing somebody wants.

**[B03] The pane lift ranks by raise order instead of landing flat.** `pane-raise.ts` already owns the per-frame `WeakMap` ref-count, so it is the natural home for a monotonic counter; the frame publishes its rank and `tug-pane.css` reads it, keeping the `!important` and the `:not([data-sidebar-pane])` rail exclusion exactly as they are. This is a backstop rather than a duplicate of [B02]: with [B01] shipped, two Z2 placards cannot coexist, but sheet-versus-placard still can ([F04]), and today that pair is decided by array order too.

**[B04] Ranking the lift does not contradict the flatness decision recorded in `chrome.css`.** That comment's stated reason is that the deck's *focus-order* z map stays unread and unwritten, so focusing another pane reorders the wall exactly as it does today. Raise order is a different axis: it orders only the frames currently holding an overhanging surface, and the focus-order map is still neither consulted nor changed. The comment should be amended to say so, so the next reader does not read the change as a reversal of it.

---

## Open Questions {#open-questions}

- **Does the screenshot's partial occlusion — the placard over card 3's masthead but apparently under card 3's transcript text near its lower edge — come out whole from [B01] and [B03], or is there a third fact?** The two decisions here explain "two placards up at once" and "the wrong one on top" completely, and a flat-tie loss would explain whole-card occlusion. A *split* result within one card is not obviously the same fact. Settling it wants the shape reproduced live with the fixes in, not more reading; if something remains, it is a separate finding and not a reason to hold these two.

---

## Non-goals {#non-goals}

- **Dropping the trigger exemption entirely.** It would break toggle-to-close on the placard's own cell ([F02]) — the pointerdown closes, the click reopens — which is a worse bug than the one being fixed.
- **An overlap/rect test before dismissing.** Considered and rejected in [B02]: it makes a simple rule geometric and stateful, and has to be re-run on resize and on fold.
- **Consulting or rewriting the deck's focus-order z map.** [B04]; the lift is a separate axis and stays one.
- **Changing `.tug-placard`'s own `z-index: 20`.** [F05]; it is correct and is not what competes across cards.
- **Changing the placard's in-DOM, card-scoped nature, or portaling it to the deck overlay.** The in-place rendering is what makes a placard hide with its card, survive a refront, and own its own position (`tug-placard.tsx` module docstring). The overhang it buys is the thing the lift exists to serve, not a flaw to route around.
- **Touching the rail case.** Sidebar panes are excluded from the lift on purpose, and for the reason spelled out in `tug-pane.css` — on a rail the rule would be a drop, not a lift.

---

## Exit {#exit}

**An arc.** Two edits, independent enough to land in either order, with a verification pass that is the only part wanting the app rather than the editor.

The dismissal scope is the smaller and the one that fixes the reported symptom: thread the trigger element through to `usePlacardAutoDismiss` and replace the selector test with a `contains()` against it ([B01]), keeping `triggerSelector` working for any other caller that still wants a selector, or removing it if the Z2 placard is its only user. The lift is the second: a monotonic rank in `pane-raise.ts` published onto the frame, `tug-pane.css:1569` reading it, and the `chrome.css` comment amended to say which axis moved ([B03], [B04]).

Verification is what closes the open question: two folded cards each running an arc, a Z2 ARC placard opened in each in turn, and the app-test that pins it. `just app-test-select` should be cross-checked against whatever file list the work names rather than trusted to a hand-guessed set, and any new test needs its `@covers` line.

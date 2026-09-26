# A click on a jot must not move the list

**Purpose:** Pressing a jot row in the Jots sidebar card scrolls the card to the top of the list, so a double-click opens the wrong jot or nothing. The click gesture must leave the scroll position alone, and the focus reveal must stop treating a whole list as the thing to bring into view.

---

## Purpose {#purpose}

The user's report: "Clicking on a jot can *move the list* (due to scrolling), which means that if I *double-click* on a jot, I wind up editing the wrong one, or I wind up editing nothing at all. The interaction feels sluggish as well, like there's some delay in processing the second click."

The Jots card is a `TugListView` rendered `inline` under the card root, which is the card's one scroller (`tugdeck/src/components/jots/jots-card.css`). Rows are selected on pointerdown and opened on double-click (`activateOnDoubleClick`). With enough jots to overflow the card, every press moves the card.

---

## Evidence {#evidence}

**[F01] Every press on a row scrolls the card to the top of the list, in the same task as the pointerdown.** Reproduced with a throwaway app-test: 200 short jots, card scrolled to the bottom (scrollTop 3973), native click on jot 190. By the mousedown event the card's scrollTop was 34, which is the list's top parked six pixels below the port top (the reveal's `RING_GAP_PX`). **(verified)**

**[F02] The click and the second press land on the wrong element.** In the same run the click event's target was the list window rather than any row, because the mousedown and mouseup targets differed and the browser delivered the click to their common ancestor. A native double-click on jot 190 then delivered its second pointerdown, click, and dblclick to jot 49, and the editor opened on jot 49. This is the "wrong one" case; the "nothing at all" case is the second press landing on the toolbar or a gap. **(verified)**

**[F03] The scroll is the keyboard reveal of the list container.** The chain, read out of the code: the capture-phase pointer placement in `tugdeck/src/components/tugways/responder-chain-provider.tsx` places the list as a pointer key view; the list's own pointerdown handler in `tugdeck/src/components/tugways/tug-list-view.tsx` re-places it with `modality: "keyboard"` so the ring paints. The modality flip defeats the unchanged-pair early return in `setKeyView` (`tugdeck/src/components/tugways/focus-manager.ts`), which then calls `revealFocusTarget` on the key view element. That element is the list's scroll container, which carries the engine focusable, not the cursor row. **(verified)**

**[F04] The reveal aligns a target taller than the scrollport to its leading edge.** `revealDelta` in `tugdeck/src/components/tugways/focus-reveal.ts` returns `start - low` when the target overflows the band. Under the Jots card the list is `overflow: visible` and stands at its full height, so it is always taller than the port once it overflows, and every reveal parks its top at the port top. **(verified)**

**[F05] The same rule has already been patched at a symptom.** The scroll-hold sampling in `JotEditorRow` (`tugdeck/src/components/jots/jots-card.tsx`), pinned by `tests/app-test/at0593-jot-close-holds-its-place.test.ts`, exists because closing an editor re-revealed the taller-than-port editing cell and the card hopped. Same helper, same leading-edge rule. **(verified)**

**[F06] There is no measurable processing delay.** Event timestamps in the reproduction show a normal double-click cadence and no gap between the second press and the dblclick. The store's `beginEdit` is synchronous. The sluggish feel is inferred to be the feedback arriving on the wrong row or off screen: the pressed row leaves the viewport on the first press, and the 200ms open animation plays on a row thousands of pixels away. A real cost in the editor mount was not ruled out and would need its own measurement. **(inference, timing verified)**

**[F07] The bug needs an overflowing list.** With 40 jots in the test window the card did not overflow and nothing scrolled. The first probe run passed for that reason alone. **(verified)**

---

## Decisions {#decisions}

**[B01] The list's pointer press places the key view with `preventScroll: true`.** A pointer gesture already has its target under the pointer, so nothing needs revealing, and the manager already has this suppression channel for exactly this case ([L23]). This is the one-line fix for the reported bug and lands first, with its test ([B04]).

**[B02] When a roving list is the key view, the reveal targets the projected cursor row, not the container.** The focus manager should resolve the element carrying `data-key-cursor` inside a list key view and reveal that, falling back to the container only when no cursor row exists. This fixes the same family for Tab and Cmd-L arrival into a tall Jots or Cards list, which today also snaps to the list top. It lands with [B03] as the reveal-doctrine change, after [B01].

**[B03] A target taller than the band that already overlaps the band is not revealed.** `revealDelta` returns zero in that case: a thing the user can already see part of needs no scroll. This is what lets the scroll-hold hack in `JotEditorRow` retire, with at0593 kept as the guard for the close hop. It lands with [B02].

**[B04] A new app-test pins the gesture.** Seeded with enough jots to overflow the card and scrolled to the bottom: a single click leaves the card's scrollTop unchanged, and a native double-click opens the clicked jot. The probe used for [F01] and [F02] is this test with the assertions made true.

**[B05] The order is [B01] and [B04] first, then [B02] and [B03] together.** The first pair is local to the list's pointer handler and fixes the report outright. The second pair changes the reveal for every list and every card and wants its own checkpoint.

---

## Non-goals {#non-goals}

- **Fixing the sluggishness as a performance problem.** No delay was measured ([F06]). If the feel persists after [B01], the editor mount is the next thing to measure, not this arc's business.
- **Making the Jots list its own scroller again.** The card root is the one scroller by design ([B01] and [B02] in the card's CSS commentary), so the card's natural height is measurable. The fix is in the reveal, not the layout.
- **Dropping the keyboard re-place on pointerdown.** The re-place is what paints the ring without a blink when a click re-lands in a focused list. It stays; only its reveal is suppressed.
- **Removing the at0593 scroll-hold in the same step as [B01].** It retires only once [B03] makes it redundant, and at0593 must stay green through both.

---

## Exit {#exit}

An arc. First steps in landing order:

1. Pass `preventScroll: true` in the list's pointerdown re-place in `tugdeck/src/components/tugways/tug-list-view.tsx` ([B01]).
2. Add the overflow-and-click app-test with `@covers` lines for the list view and the Jots card ([B04]); run it alongside at0593.
3. Resolve the list key view's reveal element to the `data-key-cursor` row in `tugdeck/src/components/tugways/focus-manager.ts` ([B02]).
4. Return zero from `revealDelta` for an overlapping taller-than-band target in `tugdeck/src/components/tugways/focus-reveal.ts` ([B03]), then retire the scroll-hold in `JotEditorRow` with at0593 still green.

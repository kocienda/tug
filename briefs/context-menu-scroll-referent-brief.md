# A context menu lives as long as its referent is visible

**Purpose:** A right-click menu opened over a scrolling surface stays where it opened while the content it was opened on scrolls away beneath it, leaving a menu armed with verbs about something the user can no longer see. Decide what a context menu should do when the surface under it scrolls.

---

## Purpose {#purpose}

The user's report, with two screenshots of a Session card: a right-click on a `session-card.tsx` path atom in the transcript opened the editor context menu at the click point. Scrolling the transcript slid the atom about 170 px up while the menu stayed put. In their words: "Right-click popups on content in scrolling components can become disconnected as scrolling happens. What can we do here? It would kinda suck if the menu stayed connected and I needed to *chase it* as scrolling happens. Hiding the menu on a scroll would be bad too. Is this disconnected maybe the best behavior?"

The question is which of the three behaviors the user named is right, or whether there is a better fourth. The user has accepted the recommendation recorded below.

---

## Evidence {#evidence}

**[F01] The disconnect is the absence of a decision, not one that was made** — `tugdeck/src/components/tugways/tug-editor-context-menu.tsx` positions the menu once, in a layout effect that writes `left`/`top` in viewport coordinates from the `contextmenu` event's client point and sets a `positionedRef` so it never repositions. The file contains no `scroll` or `wheel` listener. Its dismiss paths are a window-capture `pointerdown`/`mousedown` outside the menu, the keyboard contract (Escape, ⌘., modifier chords, non-character keys), and any responder-chain dispatch observed while open. Scrolling produces none of these. **(verified)**

**[F02] The menu already samples its referent at open time** — `use-text-surface-context-menu.tsx` settles the selection over a whole-entity target on `contextmenu` (the entire path, command, or sha is painted as the selection) and samples `hasSelection` and the Look Up text and point before the menu opens, because a dismissal can retire the selection before an action runs. So the menu's actions are already bound to a sampled referent, not to the click point, and the painted selection scrolls with the content. **(verified)**

**[F03] A bare right-click with no selection has a surface referent, not a point referent** — with no ranged selection and no entity under the click, `buildTextEditingMenuItems` yields only surface-scoped items (Paste, Select All, and dimmed Cut/Copy). Nothing in that menu is about the click point. **(verified)** by reading the hook's `hasSelection` gating and `text-editing-menu.ts`.

**[F04] The house already rules on a stranded floating surface** — `tugdeck/src/components/tugways/tug-popover.tsx` documents "Dismissal on a layout change": when an ancestor resize moves a popover's trigger out from under it, `TugPopoverContentShell` hides and closes the popover from a `ResizeObserver` on the trigger's layout ancestors plus a window `resize` listener, and states that "chasing the trigger with a per-frame reposition loop would be the wrong tool ([L05] / [L13])." A scroll stranding a context menu is the same situation with a different mover. **(verified)**

**[F05] The three named behaviors ranked against the scrolls that actually happen** — inference, not measurement. Three cases cover nearly every scroll while a menu is open. (a) A phantom trackpad delta of a few pixels: chasing jiggles the menu under the pointer and changes the hovered item, dismissing kills the menu for nothing, disconnected is harmless. (b) A deliberate small scroll to peek at something nearby before choosing: chasing makes the menu run from the pointer, dismissing costs a reopen, disconnected just works. (c) A long scroll because the user forgot the menu was open: chasing drags a menu across the card, disconnected leaves a floating list of verbs like Copy Path armed against a thing off screen, dismissing is what the user meant. Disconnected wins (a) and (b) and loses (c) badly; the fix is a boundary on (c), not a fourth mode.

**[F06] macOS native menus are modal to the wheel** — an `NSMenu` tracks the event loop and scroll-wheel events over other content are swallowed while it is open. This is the platform precedent for a fourth option, "the wheel is dead while a menu is open." Stated from platform knowledge, not measured here.

**[F07] A wheel over the menu itself currently falls through** — the menu is a portaled fixed element with no wheel handling. The scroller under the pointer is not an ancestor of the portaled menu, so a wheel over a short menu has nowhere to scroll and reaches the document. Inference from the DOM shape; not measured.

---

## Decisions {#decisions}

**[B01] A context menu is never chased.** No per-frame reposition, no scroll-tethering of the menu to the click point. Chasing moves the menu under a still pointer, changes the hovered item, and is the tool [F04] already rules out for popovers. The menu stays where it opened.

**[B02] A context menu lives as long as its referent is visible, and closes when the referent leaves the visible area of its scroller.** The referent is what the menu is about: the whole-entity highlight for an entity click, or the ranged selection for a selection click [F02]. Both scroll with the content and are the visible tether the menu lacks, so a user who scrolls a little can always find what the menu will act on [F05 (b)]. When the referent scrolls out of the card's visible area the menu is about nothing the user can see, and it closes [F05 (c)]. Small deltas that keep the referent on screen do nothing to the menu [F05 (a)]. This is the popover's stranded-dismissal rule [F04] with scroll as the mover.

**[B03] A menu with only a surface referent stays open as long as the surface does.** A bare right-click with no selection and no entity [F03] has no point to lose; Paste and Select All act on the surface, which is still there after any scroll. That menu keeps its existing dismiss paths and gains no scroll-driven one.

**[B04] The mechanism is event-driven and one-shot, not a loop.** While open, register a window-capture `scroll` listener (scroll does not bubble, but capture reaches it) and compare the referent's rect against its scroller's rect on each event, or observe the entity element with an `IntersectionObserver` rooted at the scroller. On the first "not visible" answer, hide the menu synchronously and close it through the existing close path. This matches [L05] and [L13] and the `ResizeObserver` shape of [F04].

**[B05] A wheel over the menu itself is inert.** The menu swallows wheel events over its own element rather than letting them fall through to the document [F07]. A menu that scrolls the page behind it when the pointer rests on it is a surprise with no upside.

**[B06] Modal-to-the-wheel is not adopted.** The native precedent [F06] is real, but it kills the peek case [F05 (b)], and a dead wheel in a web surface reads as a hang with no cue that a menu is why. It ranks second to [B02] and is recorded under Non-goals so it is not re-proposed without new evidence.

---

## Open Questions {#open-questions}

- Which element stands in for the referent when the click landed on a ranged selection that spans several transcript cells or virtualized rows? The selection's bounding rect from the live DOM range is the obvious answer, but the markdown view's virtualized select-all paints a CSS class rather than holding a DOM range, so that surface may need to answer from its own model. Settled by reading the markdown view's adapter when the step is written; not a user decision.

---

## Non-goals {#non-goals}

- **Chasing the click point on scroll.** Rejected by [B01]: it moves the menu under a still pointer and is the tool [F04] already names as wrong.
- **Dismissing on any scroll.** Rejected: phantom trackpad deltas would kill menus for nothing [F05 (a)], and the user named it as bad.
- **Swallowing the wheel while a menu is open (macOS-native modal behavior).** Rejected by [B06]. Not wrong on the platform, but it forbids the peek and gives a web surface a dead wheel with no cue.
- **A pixel-delta threshold as the dismiss rule.** Rejected in favor of visibility of the referent [B02]: a delta says how far the content moved, not whether the thing the menu is about is still on screen, and the second is the only question that matters.
- **Changing the other floating surfaces.** `TugPopover`, `TugContextMenu`, and the completion menu are not touched. If the same stranding is found on one of them it gets its own finding.

---

## Exit {#exit}

An arc. The first steps look like: add referent tracking to `TugEditorContextMenu`, taking the referent element or rect from `useTextSurfaceContextMenu` at open time and closing on scroll-out per [B02] and [B04], with the surface-only case [B03] passing no referent; make the menu inert to wheel events over itself [B05]; then an app-test that opens the menu over an entity in a transcript, scrolls the card a little and asserts the menu is still open, scrolls the referent out of view and asserts it closed, and repeats with a bare right-click to assert that menu survives both scrolls. The referent-tracking step has to land before the test, and the wheel step is independent of both.

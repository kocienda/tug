<!-- brief-skeleton v1 -->

# Body view grounding: the switch, the bar, and tests that take the app's own path

**Purpose:** The first two stages of the per-card web views program joined and the user's deck is "VERY VERY ROUGH": cards drag apart from their chrome, the canvas peeks through before a new card appears, slides are incoherent, chords and Swift menu commands are substantially broken, the Changes shade is broken, and the tests that called the stage done drove paths the app does not take. This brief gets the product back on ground: the body path goes behind a switch that is off on the shipping build, a written bar of basic behaviours gates turning it on, the harness learns to deliver keys and menu commands the way the user's keyboard and menus do, and no later stage lands on by default.

Between stage 2 and stage 3 of `briefs/per-card-web-views-program-brief.md`.

---

## Purpose {#purpose}

The user, 2026-10-14: "Dragging cards separates the masthead and frame from the content. When new cards appear, the deck canvas peeks/flashes through before the session appears. This must never happen. Slide animations to bring a partially-visible card into view on the deck is a total flub of pieces sliding over other pieces in a graphically incoherent manner. We worked very hard on focus and event routing before this big refactor, and your tear-down and rebuild totally missed the mark. Keyboard shortcuts and Swift menu commands remain substantially broken, and your methodology to poke in events does not test the actual path the app takes to deliver and handle events. The Changes shade is completely broken. … We need to get back to some grounding where basic behaviors work."

---

## Evidence {#evidence}

**[F01] Stage 2 took working behaviour away by design, and the program brief called that a join.** `briefs/body-view-brief.md` Purpose: "during a settle the host moves it to its landing rect at the land. That is a visible regression on motion for one stage, accepted…"; its Non-goals deferred focus arbitration, chords and Tab to stage 4. The program brief's [B08] said "each stage leaves the product whole." On the user's daily deck a stage that snaps bodies at the land and leaves focus minimal is not whole. **(verified, read from the briefs; the ruling that it was unacceptable is the user's)**

**[F02] The stage's own verification read false.** The arc's record (`body-view-shell-paints-over-bodies` memory, 2026-10-13/14): `at0738`'s "ink in the rect" check counted the canvas grid as paint, so Session cards shipped empty; `nativeKey` posted to the app's pid without activating it, so AppKit's menu scan answered chords before any page and the probe looked green while keys never reached a live body; the user's real deck was never run by the arc. **(verified, read from the record)**

**[F03] The spike's premise held.** `at0737-body-view-spike.test.ts`, 2026-10-13: under a 3 s synchronous stall of the shell, a body's own rAF ran 180 of 176 expected ticks with a worst gap of 21 ms; the host display link sampled a Core Animation translate advancing on every tick, 180/180 at 16.67 ms; 89 of 89 composited captures differed; a native click passed through the transparent shell to the body; one WebContent process per body at 53 MB; a body's bind → ready 109–148 ms warm, 112–127 ms cold. The architecture is not what is rough. **(verified, measured; in the program record)**

**[F04] The host decides whether bodies exist.** `tugdeck/src/lib/body-shell.ts:98-99`: the shell's wiring is "a no-op when the host makes no bodies"; `BodyViewController.swift` creates them. The in-document `CardHost`/`CardPortal` path still exists (stage 2 Non-goals; stage 5 [B02] removes it). A switch is therefore one host-side decision, not a second code path. **(verified, read)**

**[F05] Placement runs on deck commits and resizes, not on pointer moves.** `lib/body-placement.ts`: `measurePlacements` after a commit, a `ResizeObserver` (`:279, :379`), a `PlacementPoster` posting `placeBodies` (`:274`); nothing listens to the card-drag coordinator (`card-drag-coordinator.ts`), which moves the pane's DOM frame under the pointer. The body stays where the last commit put it while the chrome follows the pointer, which is the drag separation. **(verified, read)**

**[F06] The arrival fades a container the body may not have painted.** Stage 2 [B07] fades the container in on the body's `ready`, and the record puts `ready` "at the body's first paint" as measured on the harness. On the user's deck the canvas shows through first, so either `ready` precedes the body's first composited frame on a loaded deck, or the placeholder hole opens before the fade starts. **(the symptom is the user's report; which of the two it is has not been read)**

**[F07] The slide and the settle play chrome beats over bodies that do not move.** Stage 3's subject, unbuilt. With bodies snapping at the land, the flow slide is pane chrome translating over bodies standing still until the land, then every body jumping. **(verified by design; the user's description matches it)**

**[F08] The Changes shade is a card sheet rendered inside a body's document.** The Changes sheet mounts in `session-card.tsx:5161` with `tug-changes-list.tsx`; stage 2 left in-card sheets in the body and stage 4 [B06] was to rule which surfaces escape to the shell. The user reports it completely broken, which is more than clipping; it has not been read. **(partly verified; the failure mode is unread)**

**[F09] The keyboard path the app takes.** A key reaches the window, AppKit offers it as a key equivalent to the first-responder view first, a WKWebView forwards it to its page, an unconsumed equivalent goes to the menu, and the menu's `NSMenuItem` action calls `sendControl` over tugcast to the shell (`AppDelegate.swift:1586-1634`, `menu-chords-hit-the-js-funnel-first`). A page that focuses a DOM element makes its view the window's first responder (`body-view-shell-paints-over-bodies`, third round), so which page is first responder is decided by the last page that focused something, unless every page that is not the key card yields (`lib/keyboard-yield.ts`, uncommitted). The harness's `nativeKey` can post a CGEvent to the session tap with the app activated (`NativeEventHandlers.swift:11-23, 389-402`) or to the pid without activating it (`:228-266`); `menuItemState` and `menuSnapshot` read menus but no verb performs an item (`TestHarnessConnection.swift:258-262`). **(verified, read)**

**[F10] The uncommitted fixups in the tree.** `tests/app-test/at0739-body-keys.test.ts`, `tugdeck/src/lib/keyboard-yield.ts`, and edits to `BodyViewController.swift`, `MainWindow.swift`, `body-main.ts`, `body-root.tsx`, `body-page.css`, `command-dispatch.ts`, `focus-manager.ts`, `body-placement.ts`, `body-shell.ts`, `tug-pane.css`, `chrome.css`, `globals.css`, `bus.ts`/`bus.rs` and the bus parity fixture: the even-odd floor clip, in-place body re-stacking, the keyboard yield, and the body-keys probe. They are the start of this work and have no bar yet. **(verified, `git status`)**

---

## Decisions {#decisions}

**[B01] Bodies are a switch, off on the shipping build.** The host reads one setting, `dev.tugapp.deck/bodies` in tugbank (default `false`), and creates no body views when it is off; the shell's wiring is then its existing no-op and every card mounts in the document as it did at stage 6. The harness and the dev instance run with it on. The user's daily deck runs with it off until [B02]'s bar is green on the real app, and the setting is a Layout card row so the user can turn it on to look. This is the first thing landed, before any fix, because it gives the product back today and makes every later stage unable to regress it.

**[B02] The grounding bar.** A written list, each row a behaviour, a test on the app's own path ([B04]), and a reading on the real app ([B05]). The rows:

1. ⌘N: a new card arrives with nothing of the canvas, grid or an older pane showing through the hole at any frame, cold and warm; the body's content is composited before the container's opacity leaves zero.
2. A card drags as one piece: masthead, frame and content move together under the pointer, and land together.
3. A card departs as one piece, and the hole closes with it.
4. A slide (flow, Go to slot, bullseye, sidebar show/hide, fit) moves each card as one coherent piece; until stage 3 lands, the interim is that bodies hide at the beat's start and show at the land with their chrome, never standing still under moving chrome.
5. Every chord in the keyboard files works from a body and from the shell: typing, ⌘K, deck chords (⌘1, fold, slot move), Edit menu chords (undo, redo, cut, copy, paste, select all), find chords, turn navigation, dictation toggle.
6. Every Swift menu command works with a body first responder: File, Edit, View, Go, Window menus, including the ones that validate against the first responder's undo manager.
7. Focus: activating a card by click or chord makes its body first responder; typing goes to it and nowhere else; the shell's own surfaces (pickers, sheets, the command picker) take and return focus; closing the key card hands focus to the next card.
8. The Changes shade opens, lists, scrolls, and closes from a body; the history view and find bar likewise.
9. Fold and unfold with a body; the folded form hides the body and the unfold shows it with no peek.
10. Workspace switch: every body of the arriving space is shown and placed, every body of the departing space hidden, with no frame showing a body in the wrong place.
11. Close, close all, reload (⌘R), quit: no body outlives its card, every page saves and terminates under the deadline.
12. Z2, the composer, paste of text and images, and the picker-to-body handoff.

A row is green when its test passes through the real path and the reading on the real app agrees. The bar lives in the brief and in `tests/app-test/body-grounding/`, one file per row, each `@covers` the body path.

**[B03] The fixes the rows already name.** Drag: the card-drag coordinator posts the dragged card's rect to the host on every pointer move (host-side drag is stage 4's shape; here the shell drives it), and the host places that body without a transaction's animation. Arrival: the container's fade starts only after the body reports its first composited frame of real content (a `painted` message after the body's first `requestAnimationFrame` following content mount, not `ready` at load), and the hole in the floor opens in the same commit as the fade begins, never before. Slide interim: rule 4 above. Changes shade: read on the real app, then either fixed in the body or escalated to the shell as a deck-scope surface by the stage 4 rule, decided from the reading. Keys: the keyboard yield lands under row 5 and row 7's tests, or is replaced by what those tests show is right.

**[B04] Tests take the app's own path.** Three harness changes, landed first and once:
- `nativeKey` activates the app and posts to the session event tap, so the key goes to the window as the user's keyboard does, through AppKit's key-equivalent scan and the first-responder view's page, in that order. The pid mode stays for what it is for and is never used to assert a chord.
- A `performMenuItem(identifier)` verb invokes the real `NSMenuItem` action through `NSApp.sendAction`, after `validateMenuItem` has run, so a menu test exercises validation, the action and `sendControl`.
- A test of a chord or a menu command asserts its effect in the page that should have received it (a body's DOM, the shell's store, the pasteboard), never the delivery of an event. `lab.dispatch`, DOM `keydown` synthesis and `sendControl` from the test are not evidence for a keyboard row.

**[B05] A body step is read on the real app before it is done.** Every row's test ends with a composite window capture compared against the body's own surface colour and the shell's chrome colour (never ink share), and every row is also read on a dev instance running the real binary with the body switch on, through the eval door, by the method the record already has. The arc supplement gains the rule: a change to the shell, a body, the host's placement or the harness's event delivery is not done until it has been looked at in the running app.

**[B06] The uncommitted fixups land under the bar.** The tree's changes ([F10]) are reviewed against the rows they serve, committed as those rows go green, and nothing in them is kept because it was written: the even-odd clip and in-place re-stacking are row 1 and row 7's; the keyboard yield is row 5 and row 7's; `at0739` is rewritten onto [B04]'s delivery.

**[B07] No later stage lands on by default.** Stage 3 (motion), stage 4 (focus, keys, edges) and stage 5 (every card) each land behind the switch, keep the bar green on every row they touch, add their own rows, and flip nothing on. The switch's default becomes `true` only by a decision written into the program brief after the user has run the body deck as their daily deck and said so. The program brief's [B08] is corrected to say this.

---

## Open Questions {#open-questions}

- **What is the Changes shade's failure mode?** Read on the real app first; the fix follows the reading ([B03]).
- **Does `painted` at the body's first content frame close the arrival peek on a loaded deck, or does the hole need to stay closed until a composite confirms it?** Row 1's reading on the real deck; the stricter rule if the first does not hold.
- **Does the keyboard yield hold under every row, or does the host need to own first responder outright now rather than in stage 4?** Rows 5 and 7 decide; if the host must own it, that part of stage 4 is pulled forward into this arc.

---

## Non-goals {#non-goals}

- **Host motion of bodies.** Stage 3, behind the switch; row 4's interim is a hide-and-show, not a motion.
- **Reverting the two joined stages.** The tugcast stage is invisible and sound; the body stage's plumbing passed its spike. The switch retires the regression without losing the work.
- **New card kinds in bodies.** Stage 5.
- **Any rewrite of the keymap, the responder chain or the focus manager.** They worked before; the bar is that they work again from a body, through the same code.

---

## Exit {#exit}

**An arc.** The shape: the switch ([B01]) first and alone, so the user's deck is whole again on the next build; then the harness changes ([B04]) and the real-app reading rule ([B05]), because every row depends on them; then the rows ([B02]) in the order listed, each with its fix ([B03]), the tree's fixups folded in as they are reached ([B06]); the program brief's correction ([B07]) with the first row. It joins when every row is green on the app's own path and read on the real app with the switch on, and the user's deck still ships with it off.

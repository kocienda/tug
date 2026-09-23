<!-- brief-skeleton v1 -->

# Re-anchor the update surface

**Purpose:** The update surface is parked in the window's upper right, which is where the Workspaces sidebar lives, so the badge lands on top of the sidebar's filter row and the expanded panel spills across it onto the canvas. Give the surface one anchor — top centre, both sizes, always the same place — a dismissal that is a real gesture, and a menu door back in.

---

## Purpose {#purpose}

In the user's words: *"The upper right corner plan as it's been implemented now simply isn't working. The UI continues to be inconsistent, despite the spike card we made, and the UI elements just seem to be dropped randomly on top of other content as if the update scheme was a half-baked afterthought. It can't be like this... Perhaps this window should be a macOS style popover/dropdown from the top/center of the deck/canvas instead of floating in the top right. We really need an anchor position and we don't have it."*

Two screenshots came with it. In the first, a `Checking…` badge sits on the Workspaces card's "Filter Workspaces" row, over the control at its right edge. In the second, a `Tug is up to date` dialog stands across the sidebar's boundary and out over a session card, at no position any element on screen explains.

Three further items were raised and are carried here rather than split off: the collapsed badge should read *Ready to install update* and should carry an `x`; the Tug menu item below *About Tug* should always bring the surface back expanded, in the state it was left; and neither *Later* nor *Install and Relaunch* currently does anything.

---

## Evidence {#evidence}

**[F01] The "corner" is the whole window's corner, and it is occupied** — `.tugx-update-overlay` in `tugdeck/src/components/chrome/update-overlay.css` is `position: absolute; top: calc(var(--tug-chrome-height) + var(--tug-space-sm)); right: var(--tug-space-sm)`, portaled by `UpdateOverlay` into `CanvasOverlayRoot`, which renders `position: fixed; inset: 0` over the entire window rather than over the canvas region. The Workspaces sidebar occupies that corner. `.tugx-update-panel` is `width: 600px`, so the expanded form extends leftward from the window's right edge across the full sidebar and onto the canvas. Both screenshots are this one placement. **(verified — read from the CSS and matched against the screenshots)**

**[F02] The corner was chosen on an admission that it had not been checked** — the original non-modal brief's `[F08]` reads: *"The upper right of the deck canvas holds no native overlay. Whether deck-level chrome already occupies the upper right was not surveyed."* It was marked **(first half verified)**, and `[B04]` then took the corner anyway, accepting that "the pill may overlap a card parked in that corner." The overlap is not an occasional card in an unlucky position; it is the sidebar, which is where the sidebar always is. **(verified — quoted from `briefs/non-modal-app-updates-brief.md`)**

**[F03] The tree already has a top-anchored centred overlay, and its centring idiom carries a warning worth inheriting** — `tugdeck/src/components/tugways/tug-modal-input-dialog.css` positions the Open Quickly panel with `position: fixed; top: 22vh; left: 0; right: 0; margin-inline: auto`. Its comment states why it is not centred with a transform: a transform makes the panel a containing block for `position: fixed` descendants, so a dropdown portaled inside it would resolve its coordinates against the panel and be clipped by the panel's own `overflow`. That dialog is modal, scrimmed and focus-taking, none of which the update surface may be — what transfers is the positioning, not the component. **(verified)**

**[F04] `dismiss` is already a Sparkle reply, so it cannot double as "hide this"** — in `tugapp/Sources/TugUpdateDriver.swift`, `perform(.dismiss)` takes whichever of `updateChoice` / `installChoice` / `acknowledgement` the state holds and answers Sparkle with it, which ends the update session and returns the stage to `idle`. A badge `x` wired to the existing action would leave nothing for the menu item to restore. **(verified)**

**[F05] The bridge carries state and never an event, by decision** — the non-modal brief's `[B03]`: the host publishes a whole snapshot on every transition and replays the current one on `bridgeFrontendReady`, and "because what crosses the bridge is *state* and not an *event*, a deck reload is idempotent and needs no queue." A "reveal the surface now" instruction is event-shaped, so it cannot simply be added as a callback without giving up the property that makes reloads free. **(verified)**

**[F06] `onFocusRequested` exists, is wired driver-to-controller, and is never assigned** — `TugUpdateDriver.showUpdateInFocus()` calls it and `UpdateController` forwards it, but `AppDelegate` never sets `UpdateController.onFocusRequested`, so Sparkle's one sanctioned "bring the update into focus" callback lands nowhere. This was recorded in the audit of the non-modal arc as a live seam with no consumer. **(verified)**

**[F07] The menu item is disabled during exactly the stages a user would most want to look at** — `UpdateSnapshot.menuCommand` in `tugapp/Sources/UpdateState.swift` returns `nil` for `checking`, `downloading`, `extracting` and `installing`, and `AppDelegate.validateMenuItem` returns `snapshot.menuCommand != nil` for `app.checkForUpdates`. So while an update is downloading, the menu item is grey. That directly contradicts the ask that the item *always* bring the surface back. **(verified)**

**[F08] The collapsed badge's copy is terse to the point of ambiguity** — `badgeLabel` in `update-overlay.tsx` returns bare strings: `Ready to install`, `Up to date`, `Update failed`, and for an available update the bare version number. Out of context, in a corner, "Ready to install" does not say what is ready or that it concerns Tug at all. **(verified)**

**[F09] Neither *Later* nor *Install and Relaunch* does anything, and the cause is not yet established** — reported from use. The leading hypothesis is that `TugUpdateDriver.perform` falls through to `logIgnored` because the state holds no matching reply closure — the deck is drawing a snapshot whose Sparkle session the host has already torn down, so both buttons are inert *and silent*. This is inference, not measurement: no `tugapp.log` from the affected run was available, and the `TugUpdateDriver: ignoring '<action>' — state <stage>` line the driver already emits is what would confirm or kill it in one reading. **(NOT verified — hypothesis, with the confirming observation named)**

---

## Decisions {#decisions}

**[B01] One anchor: top centre of the window, with both sizes on it.** The badge and the dialog occupy the same anchor point, so collapsing and expanding changes the surface's size around a fixed position rather than moving it. This is the whole of the complaint — an element that appears in a different place depending on its state reads as dropped rather than placed — and one anchor is the only thing that answers it.

**[B02] Reuse the auto-margin centring idiom, and not the modal dialog.** `left: 0; right: 0; margin-inline: auto` over a `width: fit-content` box, never `transform: translateX(-50%)`, for the containing-block reason `[F03]` records. The surface stays non-modal: no scrim, no focus claim, no responder participation. It must remain true that an update interrupts nothing, which is the premise the whole update lane was built on.

**[B03] Centre on the window, not on the canvas region.** A canvas-relative anchor would shift horizontally every time the sidebar opens, closes or resizes — reintroducing the instability this work exists to remove, in a subtler form. The window is the one frame that does not move under the surface. The overlay root is already window-sized `[F01]`, so this is also the reading that needs no new measurement.

**[B04] The deck gains a third state: hidden.** Today the surface is a two-valued `expanded` boolean over a stage-derived visibility. It becomes three — hidden, collapsed, expanded — with the host's stage still deciding whether there is anything to show at all. The size and visibility are the deck's; the stage is the host's; the two do not negotiate.

**[B05] The badge's `x` hides and nothing else.** No Sparkle reply, no state change in the host, no closure consumed `[F04]`. The update stays exactly as live as it was, which is what makes "get back to where they left off" a thing that can be honoured. Deferral by collapsing to a badge remains; this adds deferral by getting it off the screen entirely.

**[B06] Reveal crosses the bridge as a monotonic counter on the snapshot, not as a callback.** A `revealCount` field the host increments when it wants the surface shown, which the deck compares against the last value it acted on. That keeps the payload state-shaped and the replay idempotent — a reload re-reads the same count and does nothing — so `[F05]`'s property survives. This is a deliberate amendment to the non-modal brief's `[B03]`, made because the alternative is a second event-shaped channel with its own queueing question.

**[B07] The Tug menu item always reveals the surface, expanded, and is never disabled while an update is live.** `menuCommand`'s `nil` cases `[F07]` stop meaning "disabled" and start meaning "no Sparkle decision to make" — the item stays enabled throughout and its action becomes reveal-then-decide. This also finally gives `onFocusRequested` `[F06]` a consumer, since Sparkle's own `showUpdateInFocus` wants precisely this behaviour.

**[B08] The copy is revised as part of this work, not after it.** The badge says *Ready to install update* rather than *Ready to install*, and every other label and sentence in the surface is read once as a whole for the same failure: text written for a reader who has the surrounding context, displayed to one who does not. Copy that is wrong in the same way as the anchor is wrong belongs in the same pass.

**[B09] The dead buttons are in scope, and diagnosis precedes any change.** `[F09]` is a hypothesis with a cheap confirming observation, and the first move is to read it out of the log rather than to change code that may not be at fault. A silent no-op is its own defect regardless of the cause: whatever `perform` cannot honour should be visible somewhere the user can see, not only in `NSLog`.

---

## Open Questions {#open-questions}

- **How far down from the window's top edge, and does the surface overlap the title bar?** `[F03]`'s 22vh is a search field's drop, not a notification's; this wants to read as arriving from the top edge. The number is a visual call best made against the running app with the sidebar both open and closed.

- **Does a hidden surface stay hidden across a deck reload?** The store is in-memory, so a reload currently re-shows everything the stage makes visible. Whether an `x` should survive a reload — and if so, what remembers it, given the host is the only thing with continuity — is genuinely open, and the answer may reasonably be "no, and that is fine."

- **Is the `x` offered at every stage, or only where deferral means something?** Hiding an `available` or `readyToInstall` update is the case the user described. Hiding `installing`, where the app is seconds from relaunching, is harmless but pointless; hiding `error` may be how an error is meant to be dismissed already.

---

## Non-goals {#non-goals}

- **A modal presentation.** No scrim, no focus claim, no blocking. Considered only because `[F03]`'s precedent is modal and reusing the component wholesale would be less work than reusing its positioning; rejected because an update that blocks the app is the exact thing the non-modal lane was built to eliminate.

- **Returning to a corner, any corner.** The upper right failed for a reason that generalises: the corners of a deck are where deck chrome and sidebars live, and a surface with no anchor of its own will always be somebody's neighbour.

- **A canvas-relative or sidebar-aware anchor.** `[B03]` — rejected for instability, and it would also make the surface's position depend on state it should know nothing about.

- **Redesigning the dialog's internals.** The step list, the `TugStepRow` sharing with the wizard, the words-not-bars progress treatment and the decision-row layout all landed recently and are not in question. This work moves the surface and fixes its copy; it does not reopen what is inside it.

- **New action names across the bridge.** The seven actions stay seven. `[B06]` adds one field to the snapshot going out and nothing to the vocabulary coming back.

- **A progress bar.** Still no. Progress is words, and that decision stands.

---

## Exit {#exit}

**An arc.** There is a natural order, and the first step is the one the screenshots are about:

1. The anchor — both sizes onto one top-centre position, non-modal, with the transform trap avoided `[B01]` `[B02]` `[B03]`. This alone makes the surface stop landing on the sidebar, and is worth seeing on screen before anything else moves.
2. The hidden state and the badge's `x` `[B04]` `[B05]`, deck-side only, with the host untouched.
3. The reveal counter and the menu door — the snapshot field, the host incrementing it, the deck acting on it once, and the menu item losing its mid-transfer disablement `[B06]` `[B07]`.
4. The copy pass over every label and sentence the surface renders `[B08]`.
5. The dead buttons: read the log first, then fix what it names, and make a refused action visible rather than silent `[B09]`.

Steps 1 and 2 are deck-only. Step 3 is the one that crosses into Swift and amends a standing decision, so it wants the most care. Steps 4 and 5 are independent of the rest and of each other.

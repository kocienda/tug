# Workspace create: one cut onto loading faces

**Purpose:** Creating a new workspace is flashy. Switching between two existing workspaces is smooth. The new-workspace experience should have the same smoothness, and the loading it does should look like loading, the way the launch does.

---

## Purpose {#purpose}

The user's report, 2026-10-23: "creating a new workspace is very flashy. Moving from one existing one to another existing one is done smoothly (which is great). We need that same smoothness in the new-workspace experience."

A first sketch read the problem as load time and proposed warming the new workspace's pages before showing it. The user rejected that reading: "When we launch Tug, we have a *loading* interface that includes progress indication, and that works *just fine*. The issue is with *flashing*, not loading or the time it takes to load." So the work is to remove the pictures nobody arranged, and to make the loading that remains read as loading. How long a new workspace takes to come up is not the subject.

---

## Evidence {#evidence}

**[F01] A switch between visited workspaces is a cut, and nothing is made during it.** `DeckManager.activateSpace` (`tugdeck/src/deck-manager.ts`) swaps the deck inside one first-responder flip and notifies with the landing word `"cut"`, so the canvas takes the arriving arrangement as its baseline and launches no settle. Both layers are already mounted, a visited workspace's bodies stay alive while parked, and the placer hands the departing views over to the arriving ones in one host transaction (`heldForThePaint`, `meetsAFace`, `tugdeck/src/lib/card-placement.ts`; `briefs/switch-hand-over-brief.md` [B02]). **(verified, read from the code)**

**[F02] A create cuts onto an empty layer first.** `createSpace` inserts the new workspace with `buildDefaultLayout()` (`tugdeck/src/serialization.ts`), a deck of zero cards and zero panes, and calls `activateSpace` on it. The arriving placement has no bodies and no faces, so the departing cards' views meet no face: `heldForThePaint` holds them two paints and then hides them over bare canvas. **(verified, read; the resulting frames were not recorded)**

**[F03] The rail arrives as a second commit, after the cut.** Back in `createSpace`, `_createFactoryRail` runs after `activateSpace` returns. It appends the five rail panes of `FACTORY_RAIL_ORDER` (Workspaces, Layout on the right; Arcs, Jots, Overview on the left) and switches the imposition to four-up at the slim content width in one `_flipFirstResponder` commit, notified with the default landing `"cross"`. The switch mark (`data-space-switching`) stands the imposer down for the length of the epoch, so this snaps rather than tweens, but it is a second arrangement after the first: empty canvas, then rails. **(verified, read)**

**[F04] Each rail card lifts its own lid on its own clock, and nothing says loading.** Every rail card is a new body. The host's lane (`tugapp/Sources/BodyLane.swift`) loads two pages at a time, one of them from the spare. The recorded times are 109–148 ms from the spare and 419–463 ms cold (`briefs/body-lifecycle-program-brief.md`). Until a page's content paints, its content box is a lid in the pane's surface (`CONTENT_PAINTED_ATTRIBUTE`, `tugdeck/src/body/body-chrome-frame.tsx`), and the shell's stand-in (`tugdeck/src/components/chrome/body-stand-in.tsx`) draws the same lidded box before the page exists. The lid is plain surface. Five lids lifting in waves of two read as pops, not as a load finishing. **(verified, read; the lane width and timings are the host's own record)**

**[F05] The launch shows one picture per phase.** `MainWindow.swift` stands a splash of the app icon and `WaveProgressView`, a Swift port of the deck's `TugProgressWave` glyph, until the shell is ready; one fade then reveals the shell, and `BodyViewController.shellDidReveal` fades the cards and the overlay in on the same clock, "so the splash gives way to the deck as one picture." Cards still dark after the reveal stand under their chrome and lid. The user reports this as working fine. **(verified, read)**

**[F06] The rename field is already deferred to the card's own page.** `NEW_SPACE` in `tugdeck/src/components/chrome/deck-canvas.tsx` creates, reveals the Workspaces card, and hands `"rename"` to `cardsSpaceVerbRequest`. The shown layer's Workspaces card answers it when its page is up, scrolls the header into view and opens the field with the default name selected (`at0656-workspace-new-opens-name.test.ts`). The field is content, so it is under the lid until the content paints. **(verified, read and pinned by the test)**

**[F07] No frame recording of a create exists.** The `space-switch-frames` sampler and the `space-switch-timing` record are armed on `activateSpace`, which a create goes through, but no reading has been taken of a create, and no app-test judges its frames. [F02]–[F04] are the sequence the code arranges; which of them the eye registers as the flash is not yet measured. **(verified, by absence)**

---

## Decisions {#decisions}

**[B01] The new workspace's deck is built whole, rail included, before it is activated.** The factory rail becomes part of the record `createSpace` inserts, and `_createFactoryRail` no longer runs after the activation. The cut then lands the finished arrangement: five panes, the four-up slim imposition, five stand-in faces. The departing views meet faces and hand over in one host transaction, the path a switch already takes ([F01]). This removes [F02] and [F03] in one move, and makes the `"cut"` landing word true of the gesture. The latch `factoryRailPending` and `claimFactoryRail`, which stand a rail for a boot deck's first card, are untouched.

**[B02] A lidded content box wears the wave indicator.** The lid in `body-chrome-frame.tsx` gets the deck's own `TugProgressWave`, centered, while the card's content has not painted. The stand-in face and the host's drawn face carry the wave's rest frame so the hand-off from face to page changes nothing on screen. A card then loads the way the app loads ([F05]), and a lid lifting is a load finishing rather than a pop. This is every lidded card, not only a new workspace's: every lid is a loading card, and a rule that applied only on create would make the same picture mean two things.

**[B03] The wave waits a short delay before it draws.** A lid that stands one or two frames must not flicker a glyph. The lid draws the wave after a short delay, on the order of two display frames, so a fast card never shows it and a slow one shows it steadily. The number is the arc's to pick and record.

**[B04] The cut is immediate.** The gesture is answered at once with the finished arrangement and five loading faces. Nothing waits on a page to paint, nothing is warmed ahead, and the lane and the spare are untouched. Load time is not the subject ([Purpose]).

**[B05] The rename field stays where it is.** It opens inside the Workspaces card's content once that page paints ([F06]). Under a lid that reads as loading, that is the right moment, and `at0656` keeps pinning it.

**[B06] A frame judge lands red before the fix.** One app-test samples frames across New Workspace, shaped like the row 44 switch judge: no frame of canvas in any rail pane after the cut; no departing card drawn over the new layer; one `store-notify` for the gesture, spelled `"cut"`; no pane rect moving after it. It is run against the current build first so it fails on [F02] and [F03], and the fix is judged by it. It carries `@covers` for the modules it reaches, and is one file under the corpus's 20 s budget.

**[B07] Create gets its own doctrine row.** `tuglaws/animation-doctrine.md` row D2 covers the switch. A row for workspace create names the target "one cut onto loading faces" and cites this brief.

---

## Open Questions {#open-questions}

- **Which of [F02]–[F04] the eye registers.** The recording [B06] takes first will say whether the two-paint hold over canvas, the rail snap, or the lid cascade is the flash the user sees. The decisions above address all three, so the answer changes the report, not the work.

---

## Non-goals {#non-goals}

- **Warming the new workspace's pages before showing it.** The first sketch proposed mounting the new workspace parked, loading its five bodies hidden, and cutting when all had painted. Rejected by the user: the problem is flashing, not load time, and a loading interface with progress indication is fine. It would also have reversed the body program's rule that a never-shown workspace gets no bodies.
- **More spares or a wider lane.** Load time is untouched. A set of rail spares would cost about 146 MB each for a gain this brief does not want.
- **Duplicate Workspace.** It appends without activating, so it has no first show and nothing here touches it.
- **Delete Workspace and the switch itself.** Both already land as cuts onto painted bodies.

---

## Exit {#exit}

An arc. The first act is the recording and the judge of [B06], run red against the current build. Then [B01], which moves the rail into the inserted record and is the half that removes the arrangement flashes. Then [B02] and [B03] together, the lid's wave and its delay, with the stand-in and the drawn face carrying the rest frame. The judge goes green on the way, `at0656` stays green, and [B07]'s doctrine row lands with the fix.

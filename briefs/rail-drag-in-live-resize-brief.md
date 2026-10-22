# The rail width drag in lock step: the rail view carries it, the OS keeps the pages in step

**Purpose:** Dragging a sidebar rail's edge still does not move the rail's cards together: the host moves every member's view in one transaction, but each member's page repaints at its new width on its own clock, so the members are visibly out of step with each other and with the hand. The width readout that rode beside the pointer is gone too. The user's standard is Safari's: a window edge dragged with a page inside keeps the content in lock step with the edge, and that is what AppKit, WebKit and Core Animation offer when they are leaned on rather than worked around.

---

## Purpose {#purpose}

The user's report, after testing `1e62251d5` in a debug build: "The individual sidebar cards *do not* resize at the same time as the rail is sized... and *they must*. I wanted the outer view to handle the dragging, and it seems like you didn't actually do that, and the inner card views can't keep up to notifications. macOS can handle this *perfectly*. You just didn't take advantage of the features that the OS offers. The views must be in *lock step* with each other as they resize. And not only that, the size indicator while dragging has been lost too."

The direction for this brief: "Learn from the Safari model. Lean on the OS. Use the tools and features that AppKit, WebKit and Core Animation give us. Use a fence if needed."

This supersedes the per-member repaint tolerance that `briefs/rail-view-carries-width-drag` ([B05], as resolved in implementation) admitted. That tolerance was the defect, written down as a limit.

---

## Evidence {#evidence}

**[F01] The host already moves every member's frame in one transaction, and that is not what the eye sees.** `moveRail` in `tugapp/Sources/BodyViewController.swift` sets each member container's frame and the rail view's frame inside one `CATransaction` with actions disabled. Each member's `WKWebView` autoresizes with its container (`pageResizing`), and a web view's new size is realised by its own web content process: a layout, a paint, and a layer-tree commit on that process's schedule. Three members are three processes with three clocks, and the compositor shows each at its new width when that process's commit lands. The screenshot the user took mid-drag shows Jots wider than Arcs and Overview. `at0678`'s burst read the same thing as a one-in-eight frame where one member showed the previous 3 pt step. **(verified, from the code and the user's reading on a debug build)**

**[F02] The pages, not the frames, are the thing out of step, so no host-side frame write can fix it.** Nothing the host writes per frame — a frame, a bounds, a transform on the container — reaches the web process before the compositor shows the frame; the container's frame and the page's old-size content are composited together as soon as the host commits, and the page's new-size content arrives one or more display frames later. The only things that are in lock step with the host's commit are the things the compositor moves without asking a web process: layer frames, clips, and layer contents already in hand. **(verified, from how the previous arc's readings behaved)**

**[F03] Safari keeps page content in lock step with a window edge, and WebKit does it through AppKit's live-resize protocol.** A WKWebView inside a window being resized by the user keeps its content synchronized with its frame: WebKit's UI-process view implementation hooks `viewWillStartLiveResize`/`viewDidEndLiveResize` and, during the resize, synchronizes the web process's layer-tree commit for the new geometry with the UI process's own commit, so the new frame and the new content reach the screen in the same display frame. The synchronization uses a Core Animation fence: the UI process hands the web process a fence port for its commit, and the two commits are held to the same frame. This is the Safari behaviour the user is pointing at. **(the behaviour is verified: a WKWebView in a live window resize keeps step; the mechanism is read from WebKit's source as the author remembers it, and [B02] names the spike that confirms which door opens it for a view the window is not resizing)**

**[F04] The body web views are our own subclass, so the live-resize protocol is reachable.** Every body is a `ClickThroughWebView: WKWebView` (`tugapp/Sources/MainWindow.swift`, made in `BodyViewController.make`). `NSView.viewWillStartLiveResize()`, `viewDidEndLiveResize()` and `inLiveResize` are public AppKit API; the window sends the first two and answers the third during its own live resize, and a subclass may call the two and override the third. Whether WebKit's synchronized path keys off the protocol calls (which we can make) or off the window's own resize state (which we cannot) is the one fact the spike settles. **(verified for the API surface; open for WebKit's reading of it)**

**[F05] The host already has a contract for a page held still while its container moves: the crossing.** `crossingReady` pins a body's page at a fixed size with `autoresizingMask = []` while the container's bounds animate and clip it, fills the box the page does not reach with the body's own surface colour (`container.surface`), and `endCrossing` gives the page its real size once, at the land, and tells the page (`bodyCrossing(.land)`). The page side (`body-main.ts`, `onBodyCrossing`) pins its scrollers for the span. This is the shape of the fallback in [B03]: a width crossing driven by the hand rather than by a track. **(verified, read out of the code)**

**[F06] The readout is written every frame and nobody can see it.** `writeReadout` in `tugdeck/src/components/chrome/rail-width-draft.ts` places the `.tug-rail-readout` pill beside the pointer in the shell's canvas on every preview; `at0680` reads its text in the DOM and is green. Since `837c85295` (shell beneath the cards, 2026-10-20) the shell's web view lies under every card view, and the pointer during a rail drag is over a member, so the pill is drawn under the member's view. The snap guides had the same problem and already moved to the overlay (`tugdeck/src/overlay/overlay-indication.ts`, `overlay.indication` with `zone`, `band`, `guides`, `ghost`), the Z2 web view the host places above every card (`createOverlay`, `placeOverCards`). **(verified, read out of the code and the join that moved the shell beneath)**

**[F07] The Option snap, the limits, the give, the chain's travel and the hold list are host-side and stay.** `RailWidthTracker` (`tugapp/Sources/CardGeometry.swift`) ports the width arithmetic; `PlaceCardsGate` (`tugdeck/src/lib/card-placement.ts`) holds the moving cards out of `placeCards`; the report carries the aim and the shell previews at it. None of that is what is out of step, and none of it changes here. **(verified)**

---

## Decisions {#decisions}

**[B01] The rail view carries the drag, and it is the only thing the hand moves.** `RailView` becomes the one view whose geometry the gesture writes per step: its frame follows the hand, and its members are laid out inside it by AppKit — autoresizing masks anchored at the rail's outer edge, so a frame write on the rail view lays out every member in the same layout pass and the same transaction, with no per-member frame arithmetic in the gesture. The content cards beside the rail translate by their travel as now ([F07]). This is the shape the user asked for twice, and it rules out the previous arc's reading of it, where the rail view was a non-clipping union placed *after* each member was moved by hand. The rail view's bounds origin stays equal to its frame origin so every member frame is still a viewport rect.

**[B02] The pages keep step through AppKit's live-resize protocol, and the first thing the arc does is prove which door opens it.** At the press the host puts every member web view into live resize — `viewWillStartLiveResize()` on each, and `inLiveResize` answering true from the `ClickThroughWebView` subclass for the gesture's length — and ends it at the release with `viewDidEndLiveResize()`. Every member then resizes every frame, as a page in a Safari window does, and WebKit's own synchronized commit (the fence, [F03]) is what keeps the content in the same display frame as the frame write. The spike that settles this is a composite burst over the real binary: a three-member rail dragged under the protocol, every member's deck-facing edge read by colour per frame against the host's frame write. The bar is [B06]'s. If it holds, this is the arc's shape and the member pages reflow live, chrome and content alike, with no hold of any kind; the `pause`/`live` reflow policy and `RAIL_REFLOW_PAUSE_MS` go. If it does not hold — WebKit keys the synchronization off the window's own resize state, or the per-frame sync wait across three processes costs more than a frame — the arc builds [B03] instead, and the brief records which door was tried and what it read. The spike is the arc's first step and its reading is written into the arc, not left in a transcript.

**[B03] The fallback is a width crossing: no member page changes size while the hand is down.** If [B02]'s door does not open, the rail view clips (`masksToBounds` on for the gesture's length), each member's page stays at its press size anchored to the outer edge — `autoresizingMask = []`, exactly as `crossingReady` pins a page — a shrink is clipped at the deck-facing edge and a grow shows the container's own surface colour in the strip the page does not reach ([F05]). Nothing waits on a web process per frame, so the lock step is the compositor's by construction. At the release each page is resized once and told, as `endCrossing` does, and the rail view keeps its clip until each member's page has painted at its new size (the crossing's ready handshake), so the release shows no order either. Content does not reflow during the drag in this shape; the chrome's edge still follows the hand, by [B04]. The rest reflow (`RAIL_REFLOW_PAUSE_MS`) is dropped in this shape too: a reflow at a rest is the asynchronous repaint again, mid-drag.

**[B04] The deck-facing edge is the host's to draw, as a layer.** Whether the pages reflow live ([B02]) or stand still ([B03]), the one thing that must be in step with the rail view's frame on every frame is the rail's deck-facing border, and a layer the rail view owns is in step by construction. The rail view draws a one-point edge layer at its deck-facing edge in the border colour its members' pages post beside their surface (`bodySurface` grows a border colour), and the held and limit tints the shell writes on the stand-ins today become that layer's colour, driven by the host's own aim. Under [B02] the pages' own borders follow too and the layer sits over them; under [B03] the layer is the border. Either way the user sees one edge, and it never lags.

**[B05] The readout rides the overlay.** `overlay.indication` gains a `readout` kind — the text, the limit mark, and the viewport point beside the pointer — composed by the shell from the host's aim as the guides are composed from the host's snap, and drawn by the overlay page above every card ([F06]). The shell's own `.tug-rail-readout` element and its CSS leave the canvas. A pill one shell frame behind the pointer is fine; a pill under a card is not.

**[B06] The bar is the brief's original one, read by colour, and then read by a hand.** On every composited frame of a rail width drag, every member's deck-facing edge stands within 1 device px of the rail view's edge and of each other, with no latency window admitted: under [B02] because WebKit fences the commits, under [B03] because the edge is one clip. `at0678` is re-pointed at that bar and the two-frame window the previous arc wrote is removed. The chain's first card keeps its travel assertion. And before the join, the arc brings the debug build up and the user drags it; the supplement's rule that a body change is read in the running app before it is done was not kept last time, and the harness called that work green.

**[B07] The placer, the hold list, the aim in the report, the Option snap and the spring stay as they landed.** [F07]. The spring past a limit runs on the rail view's frame now (one `animator().frame` on the one view that carries the drag, members laid out by AppKit), under the same live-resize or crossing regime as the drag, so the spring is in step too.

---

## Open Questions {#open-questions}

- **Which live-resize door WebKit answers.** [B02]'s spike settles it; nothing here can. The reading to take is whether a member's content lands in the same display frame as its frame write with the protocol called from the host, and what one step costs with three members in live resize.

---

## Non-goals {#non-goals}

- **Per-frame `placeCards`, or any per-frame round trip through the shell.** Already removed by the previous arc; the shell previews at the host's aim.
- **A latency window in the verdict.** The two-display-frame tolerance was the defect described as a measurement. The bar is 1 device px on every frame ([B06]).
- **A snapshot of each member stretched or nine-sliced for the drag's length.** Considered as a way to get a moving border and moving content without a web process: stretched text reads wrong, and the host would be painting a picture of a card over the card. Under [B02] the page follows for real; under [B03] the content stands still and the host draws only the edge.
- **Scaling a member's layer to the moving width.** Same reason, and the brief that preceded this one already decided clipping over scaling.
- **Calling Core Animation fence SPI ourselves.** `CAContext` fence ports are not public API. The fence this brief leans on is WebKit's own, reached through the public live-resize protocol ([B02]); if that door does not open, [B03] needs no fence because nothing in a web process moves per frame.
- **The seam drag between members and the member-out-of-rail drag.** Separate gestures, unchanged.

---

## Exit {#exit}

An arc. The order the work wants:

1. The live-resize spike on the real binary ([B02]): members put into live resize at the press, a composite burst read by colour, the reading written into the arc, and the decision between [B02] and [B03] recorded there.
2. The rail view carries the drag ([B01]): members laid out inside it by AppKit, the gesture writing one frame per step, the edge layer ([B04]), the spring on the rail view ([B07]); the page regime from step 1 ([B02] live, or [B03] the width crossing with the one resize at the release and the clip held until the pages are ready).
3. The readout in the overlay ([B05]) and the shell's canvas pill removed.
4. The verdict ([B06]): `at0678` at 1 device px with no latency window, `at0677`/`at0679`/`at0680` re-read against the new regime (`at0679` loses its hold assertions under [B02], or asserts the crossing's pin under [B03]), then the debug build in the user's hand before the join.

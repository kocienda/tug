<!-- brief-skeleton v1 -->

# The body view: a card in its own WKWebView, placed by the host

**Purpose:** The host owns one web view and the deck mounts every card's content into one document. This brief puts the first card, a Session card, into a WKWebView of its own: the host gains a body view it can create, place, hide and destroy; the deck gains a body page that mounts one card alone; the shell gains a transparent placeholder where the body shows through; and the two talk over the channels stage 1 built. Before any seam is cut, a spike proves the premise: a body view holds display rate while the shell is stalled.

Stage 2 of `briefs/per-card-web-views-program-brief.md`.

---

## Purpose {#purpose}

After this stage a Session card runs in its own process, placed by the host at the rect the shell measures, with no motion of its own yet: during a settle the host moves it to its landing rect at the land. That is a visible regression on motion for one stage, accepted so that the spike, the host plumbing and the body page land with nothing else moving under them.

---

## Evidence {#evidence}

**[F01] The host's view hierarchy is a container, a splash below and overlays above one web view.** `containerView` (`tugapp/Sources/MainWindow.swift:664-668, 722`), the splash `.below` the web view (`:674-720`), the dev-info overlay with a nil `hitTest` (`:82-100`, `:1192-1228`), the reload snapshot overlay (`:1262-1299`), the shutdown snapshot as a child of the web view (`:1234-1252`). The web view is `ClickThroughWebView`, which swallows the activating click and forwards its point (`:269-339`). It is transparent (`:632`). **(verified, read)**

**[F02] Every message handler lives on one content controller and answers into one view.** 22 handlers (`MainWindow.swift:550-572`), dispatched in `extension MainWindow: WKScriptMessageHandler` (`:1952-2447`), with replies by `evaluateJavaScript` into `webView` (`:857-1621`, `replyToBridgeRequest` `:1322-1351`). `PageFaultScript` and the harness user script are injected into that one configuration (`:584`, `:596-598`). `cleanupBridge` removes handlers by name (`:1399-1429`). **(verified, read)**

**[F03] The seam in the deck is `CardHost` and `CardPortal`.** `LayerPanes` renders one `TugPane` per pane and a flat list of `CardHost`s (`deck-canvas.tsx:1829, 1955-2066`); `CardHost` portals the content into `.tug-pane-content` through `CardPortal` (`card-portal.tsx:110-134`; registry `pane-content-registry.ts`; `tug-pane.tsx:2892`, DOM at `:5636-5768`) and wraps it in the frame, portal, card id, responder scope, card data, property, state-preservation and dirty contexts before calling `registration.contentFactory(cardId)` (`card-host.tsx:1808-1849`). **(verified, read)**

**[F04] What the Session body reads from the deck and writes back is a short list.** Reads: `cardFoldedOf`, `cardArrivingOf`, `getFirstResponderCardId` (`session-card.tsx:1354-1375, 1719-1727`), `observeCardDidActivate` (`:1353`), `useCardDelegate` (`:2763`), `useSpaceLayerShownSource` (`:2202`), `cardSessionBindingStore` (`:4583-4602`), the pane frame and portal contexts. Writes: `cardTitleStore` for title and masthead (`:4714-4724`), sheet reservations and opening bids (`:1233, 1389, 1395`), fold guard and close advice (`:651-667`), `useMenuStatePublication` (`:1961`), `useSessionCardObserver` (`:1955`). The masthead itself is pane chrome (`tug-pane.tsx:129, 218-239, 1457`; `session-masthead.tsx:785`). The body's binding comes from the wire, `spawn_session_ok` → `cardSessionBindingStore` → `cardServicesStore` (`action-dispatch.ts:1353`, `lib/card-services-store.ts`). **(verified, read)**

**[F05] The page boots from its origin alone.** `main.tsx` derives `ws://${location.host}/ws` (`:243`), reads one query parameter (`:561`), builds `TugConnection`, waits for DEFAULTS and the WASM, registers card kinds (`:516-541`), constructs `DeckManager`, which mounts the one React root (`deck-manager.ts:2271, 2352-2414`), and posts `frontendReady` (`:1114-1125`). The host reveals the web view on `frontendReady` (`MainWindow.swift:2279`, `:1655-1708`) and makes it first responder 0.3 s later (`:1702-1703`). **(verified, read)**

**[F06] The pane's rect is known only to the browser.** `imposeStyle` writes `left/top/width/height` as `calc()` over custom properties (`lib/layout-imposer.ts:1577-1670`); the only script that knows a pane's pixel rect measures it (`layout-imposition.ts:98-108`). Zoom is a `transform: scale()` on `#deck-container` (`lib/page-zoom-store.ts:103-117`), so a measured rect is in zoomed CSS pixels and `layoutRectOf` corrects it. **(verified, read)**

**[F07] The harness holds one view.** `TestHarnessBridge.swift:46-64`, `TestHarnessConnection.swift:122, 137`: `evalJS`, `waitForCondition` (`:1138-1236`), `getElementScreenBounds` (`:337-420`), `screenshot` by `takeSnapshot` (`:424-461`), `NativeEventHandlers(webView:)` (`:907`), `CoordMapping.viewportToScreen(in:)` (`CoordMapping.swift:108-130`). Keys go to whatever is first responder (`NativeEventHandlers.swift:228-264`). **(verified, read)**

---

## Decisions {#decisions}

**[B01] The spike comes first and its reading gates the stage.** A debug-only command in the host (reachable from the harness) creates one child WKWebView over the deck loading `/?body=spike`, in a container layer, and the harness reads: processes and resident memory per view (`ps`); the window's frames under a Core Animation translate of the container while the shell runs a 3 s synchronous loop through the eval door and while the spike page itself animates and streams text; whether a transparent shell over the child composites without artifacts and whether a pointer event passes through to the child when the host's hit-test says so. The host gains the display-link frame reading this needs (`CVDisplayLink` timestamps per frame, missed frames counted, exposed to the harness and to `tugtool deck motion`). The reading is written into the program brief's record. If the child does not hold display rate under the stalled shell, the stage stops there and the program brief says so.

**[B02] The host gains a `BodyViewController`.** One object owns every body: `create(cardId)` makes a `WKWebView` in its own `WKWebViewConfiguration` with its own `WKUserContentController` (same handler names, the handler reading `message.webView` to find the body), the shared default `WKWebsiteDataStore` for the cookie, the same feature overrides, `drawsBackground` on, loading `/?body=<cardId>`; `place(cardId, rect)`, `show`/`hide`, `destroy`. Each body sits in a container `NSView` (layer-backed, `masksToBounds`, corner radius from the shell's token) beneath the shell view and above the splash. `ClickThroughWebView` becomes the class of every view. `cleanupBridge`, WebContent-termination recovery (`MainWindow.swift:1751-1782`), the shutdown snapshot and the reload snapshot learn to act per view.

**[B03] The host hit-tests the shell and passes through to bodies.** The shell view's `hitTest` returns nil for a point inside a placed body's rect unless the shell has posted `pointerClaim` (a message naming rects or "all"); the shell posts it when a scrim, sheet, popover, drag or dialog is up and clears it after. Scroll-wheel events follow the same rule. The activation click's forwarding (`:843-867`) applies to whichever view took it.

**[B04] The body page is `main.tsx` with a second root.** With `?body=<cardId>` the page boots the same connection, DEFAULTS, WASM and registrations, identifies itself to tugcast as a body for that card (stage 1 [B01]), subscribes to its card's session, and mounts a `BodyRoot` instead of `DeckManager`: the same provider stack the deck mounts (theme, tooltip, responder chain, lifecycle contexts) around one `CardHost` whose pane frame, portal and deck contexts are satisfied by a `BodyDeckBridge` rather than the deck store. The body posts its own `frontendReady`, and the host reveals the view on it. The body's document root is the card's root; its `.tug-pane-content` equivalent is the viewport.

**[B05] The bridge replaces the deck store for a body, item by item.** Reads become bus `deck-facts` and host messages: folded, arriving, first-responder card, shown space layer, app active, theme, zoom, keyboard access. Writes become bus messages the shell applies to its stores: `card-facts` for `cardTitleStore` (the masthead stays pane chrome in the shell and is fed by the bus), `card-advice` for sheet reservations, opening bids, fold guard and close advice, and `menuState` goes to the host from the body as today, merged by the host with the shell's for the key card. `observeCardDidActivate` and `useCardDelegate` are served by the bridge from the shell's first-responder flip. Nothing in `session-card.tsx` learns it is in a body; the bridge satisfies the same contexts.

**[B06] The shell measures and the host places.** `CardHost` for a card that has a body renders a transparent placeholder in `.tug-pane-content` and nothing else. After every deck commit the shell measures each placeholder's rect once, in the Last pass's one read phase (stage 6 [B03]), corrects for zoom with `layoutRectOf`, and posts `placeBodies` with every rect to the host, which sets each container's frame. A body sized by the host pays its layout in its own process. For this stage a settle posts the landing rects when it lands; the bodies snap. Parked workspaces hide their bodies.

**[B07] A Session card's arrival is body-first.** On `show-card session` the shell adds the pane with the picker in the shell as today; when the picker chooses, the shell asks the host to create the body for the card, the body spawns or resumes the session on its own connection (stage 1 [B05]) and posts `frontendReady`, and the arrival's reveal gate (`deck-manager.ts` `_watchArrival`/`_revealArrival`, `ARRIVAL_REVEAL_BOUND_MS` 250) waits on that instead of the in-page quiet. `briefs/session-body-first-frame-brief.md`'s decision, the body's entrance at opacity zero on the frame after its commit paints, is now the host fading the container in on the body's ready.

**[B08] The harness addresses views.** `TestHarnessBridge` attaches every view; `evalJS`, `waitForCondition`, `getElementScreenBounds`, `screenshot` and the native pointer verbs take an optional `card`, defaulting to the shell; `captureWindow` is the composite screenshot. `CoordMapping` maps through the named view. `App` in `tests/app-test/_harness` gains `body(cardId)`, a scoped evaluator with the same surface. The harness user script is injected into every configuration. The `at0084` core-tier file and one new file that streams a stub turn into a body are this stage's gates; the 207 mixed files are stage 5's.

**[B09] The body page keeps the deck's safety.** The same CSP (`tugdeck/index.html:6`), the same sanitizers, the same `PageFaultScript`, the same `__tugTestMode` injection, and `prepareForTermination`/`saveState` fan out from the host to every view with the deck's 12 s deadline shared.

---

## Open Questions {#open-questions}

- **Where does the folded form live?** A folded Session card today is chrome-owned (`ownsFoldedForm`); the body is hidden under it or sized to zero. Decided by the fold's reading in stage 3; for this stage the body hides when folded.
- **Does the body's `TugSheet` history view and Changes sheet clip acceptably to the card?** They are in-card today and stay in-card; looked at on the user's deck.
- **One `WKProcessPool` or the default?** The default; a shared pool is only needed for process grouping, which is ruled out.

---

## Non-goals {#non-goals}

- **Host motion.** Stage 3; here a settle snaps the bodies at the land.
- **Focus arbitration, chords, Tab at the edge.** Stage 4; here the host makes a body first responder when the shell says so, and nothing more.
- **Any card kind but Session.** Stage 5.
- **Removing the in-page `CardHost` path.** Both paths run until stage 5; a card kind without a body still mounts in the shell.

---

## Exit {#exit}

**An arc.** The shape: the spike and the host's frame instrument ([B01]), read before anything else; the `BodyViewController` and hit-testing ([B02], [B03]); the body page and bridge ([B04], [B05]); placement ([B06]); the arrival ([B07]); the harness ([B08]) beside each; safety ([B09]) throughout. It joins when a Session card runs in a body on the user's deck through a whole turn, with the arrival read against `briefs/session-body-first-frame-brief.md`'s bar and the spike's numbers in the program record.

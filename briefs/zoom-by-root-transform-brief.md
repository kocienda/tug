# View › Zoom as a transform on the deck root

**Purpose:** View › Zoom must shrink or grow the whole deck as one picture, with the layout at every factor being the layout at 100 % and nothing else moving. The `WKWebView.pageZoom` zoom cannot do that below 90 %, because WebKit refuses to lay out text under 9 zoomed pixels, so the boxes keep shrinking while the type stops and the Z2 strip breaks out of its bounds.

---

## Purpose {#purpose}

The user, after joining the `view-zoom-performance-and-feedback` arc on 2026-10-07: "The Z2 area does not scale properly, and smashes out of its bounds as I zoom down. At 80 %." And the standing rule, restated when a fit-based collapse was offered: "I *don't want* Z2 to change its layout." When a view-scale route kept Z2 whole but left the deck floating in the window: "This is *clearly* not the same, as it repositions the content in the window, which looks *ridiculous*."

So the ask has three parts, all of which must hold at every factor from 50 % to 200 %:

1. The layout is the 100 % layout, scaled. No row reflows, no cell collapses, no threshold answers differently.
2. The deck fills the window, as it does at 100 %.
3. Type and chrome actually get smaller and larger. A zoom that stops shrinking at 90 % is not a zoom.

The host's part is working and stays: the View menu, the ⌘0 / ⌘+ / ⌘− chords (fixed in `ef81ba684`), the 50–200 % range in 10 % steps, and persistence under `WebViewPageZoom`. What changes is the mechanism the factor drives.

---

## Evidence {#evidence}

**[F01] `pageZoom` floors every face at 9 zoomed pixels, so the deck reflows below 90 %.** WebKit's `Settings::minimumLogicalFontSize` (9) applies to `specifiedSize × effectiveZoom`, and `pageZoom` feeds `effectiveZoom`. A 10 px face lays out at 11.25 px at 80 %, 12.86 at 70 %, 15 at 60 %, 18 at 50 %; 12 px values start growing at 70 %, 11 px legends at 80 %. The Z2 cells, budgeted in `em`, grow with the face while the strip does not, and the row overflows. No host door lifts it: `WKPreferences` carries only `minimumFontSize`, there is no `_minimumLogicalFontSize`, the `WKPreferencesSetMinimumLogicalFontSize` symbol is absent, the testing-only double-preference setter is absent, and the `WebKitMinimumLogicalFontSize` user default does nothing. CSS `zoom` goes through the same `effectiveZoom` and has the same floor. **(verified, by a throwaway WebKit probe binary and by the readings in `briefs/view-zoom-performance-and-feedback-brief.md`)**

**[F02] A `transform: scale(f)` on `#deck-container`, sized to `innerWidth / f` by `innerHeight / f`, keeps Z2 identical at every factor and is not floored.** Measured in the app-test harness on 2026-10-07 with a throwaway test that set the transform by script with `pageZoom` pinned at 1.0, on a 700 px Session card with one committed turn, at a 1659 × 1051 CSS px window:

| factor | root offset width | root rect width | strip offset | strip rect | cells shown | cell widths (state/time/context/tasks/jobs) | overflow | font-size | text rect height |
|---|---|---|---|---|---|---|---|---|---|
| 1.0 | 1659 | 1659 | 698 | 698 | 5 | 137 / 102 / 120 / 114 / 96 | 0 | 10 | 10.8 |
| 0.8 | 2074 | 1659 | 698 | 558.4 | 5 | 137 / 102 / 120 / 114 / 96 | 0 | 10 | 8.64 |
| 0.5 | 3318 | 1659 | 698 | 349 | 5 | 137 / 102 / 120 / 114 / 96 | 0 | 10 | 5.4 |
| 2.0 | 830 | 1659 | 698 | 1396 | 5 | 137 / 102 / 120 / 114 / 96 | 0 | 10 | 21.59 |

Layout px never move; the screen rect is the layout box times the factor; the deck fills the window at every factor. **(verified)**

**[F03] Text is rasterized at the transform's scale, not upscaled from a 100 % raster.** Harness screenshots at 0.5 and 2.0 from the same run, read by eye: at 2.0 the 10 px face renders as crisp 20 px type with no softness, and at 0.5 the 5 px type is sharp and legible. WebKit sets the composited layer's contents scale from the static transform. **(verified by eye on two screenshots; a raster assertion is [B10]'s to write)**

**[F04] The deck root already contains everything that is visible, with four exceptions.** `tugdeck/index.html:22` mounts `<div id="deck-container">`, whose only siblings under `<body>` are scripts. `deck-manager.ts:2604–2610` sets it `position: relative`, observes its size, and calls `createRoot` on it; every Radix portal passes `container={overlayRoot}` from `lib/use-canvas-overlay.ts`, and `CanvasOverlayRoot` (`position: fixed; inset: 0`) is rendered by `DeckCanvas` at `deck-canvas.tsx:5188`, inside the root. A `position: fixed` box inside a transformed ancestor is laid out against that ancestor, which is what makes the overlay root cover the scaled deck exactly. The exceptions, on `document.body`: the fallback context menu (`responder-chain-provider.tsx:1779–1785`), the image lightbox (`lib/markdown/enhance-img.ts:124`), the jot drag-image preview (`lib/jot-drag.ts:89`), the `tug-sheet` standalone fallback (`tug-sheet.tsx:2584`, no-pane case only), and the dot grid itself, painted as `body`'s background (`src/globals.css:32–41`). The 0.5 screenshot of [F02] shows that last one: a 24 px grid at 1× under a deck at 0.5×. No `<dialog>`, `showModal`, or `popover` attribute is used anywhere, so nothing escapes through the top layer. **(verified)**

**[F05] A transform splits the DOM into two coordinate spaces, and 99 deck sites mix them.** Under `scale(f)`, `getBoundingClientRect`, `getClientRects`, `MouseEvent.clientX/Y`, `elementFromPoint`, `IntersectionObserver` rects, `window.innerWidth/innerHeight` and CodeMirror's height map speak viewport px; `clientWidth/Height`, `offsetWidth/Left`, `scrollTop/scrollHeight`, `ResizeObserver` sizes, computed styles, inline `style.left/width`, and the deck's stored pane frames speak layout px. A site that writes a rect-derived number into a style, adds a pointer delta to a layout position, or compares a rect with a client size is wrong by the factor. A read-only audit of the deck found 99 such sites in 37 files; the inventory below lists every one. CSS `zoom`, the pre-arc mechanism at `789fcc828`, adjusted nearly every geometry API consistently in WebKit, which is why only six files (15 sites) ever carried `getTugZoom()` / `layoutPxOf` divisions; a transform adjusts none of them. **(verified by reading each site; the fix shape per site is the audit's inference)**

**[F06] The two libraries that position against the DOM already handle an ancestor scale.** `@floating-ui/dom` 1.7.6 (`getScale`, `floating-ui.dom.mjs:31,93`) corrects the offset parent's scale, and Radix popper (popover, tooltip, context menu, dropdown) sits on it with `strategy: "fixed"`. `@codemirror/view` 6.41.1 computes `scaleX/scaleY` from rect ÷ offset size (`dist/index.js:516–518`), divides its content height by `scaleY` (`:2970`), wraps each `layer()` in `scale(1/scaleX, 1/scaleY)` (`:9393`), and scales its own drop cursor (`:9600–9610`). The deck's own code around CodeMirror does not: 18 sites mix `lineBlockAt*`, `coordsAtPos`, or `defaultLineHeight` (viewport) with `scrollTop` or inline styles (layout). **(verified in `node_modules` and the deck source)**

**[F07] `devicePixelRatio` stops moving on a zoom step, and three mechanisms key on it.** Under `pageZoom`, `devicePixelRatio` is backing scale × zoom; under a transform it is the backing scale alone. `classifyWidthSettle` (`internal/list-view-window.ts:322–359`) classifies a width settle as `rescaled` only when the ratio moved, and a viewport-sized card's layout width *does* move by 1/f when the root is resized, so it would read `reflowed` and wipe the ledger: the 260-mount storm the last arc fixed ([B03] of that brief) returns. The sparkline's backing store (`tug-sparkline.tsx:187–189, 321–338, 374–375`) and the PDF view's (`cards/pdf-view.tsx:221–228`) are sized from the ratio and re-keyed by a `matchMedia(resolution)` listener that never fires. `at0710` and `at0330` wait on the ratio changing. **(verified)**

**[F08] The host's coordinate conversions get simpler, not harder.** `CoordMapping.viewportToScreen` (`tugapp/Sources/TestHarness/CoordMapping.swift:99–115`) multiplies a viewport point by `pageZoom`; `forwardActivationClick` (`MainWindow.swift:775–799`) divides a view point by it; `lookUpInDictionary` (`MainWindow.swift:1904–1938`) multiplies `x`, `y` and `fontSize` by it. Under a transform a DOM rect is already in viewport px, so the multiply and divide on points go away; only the dictionary `fontSize`, read from computed style, still needs the factor. The harness TS side (`tests/app-test/_harness/client.ts:1079–1402`) computes viewport points and does no zoom math of its own, so every native click and drag verb is corrected by the one Swift change. No other host↔web geometry exists: no `NSTextInputClient` rects, no drag destinations, no app-region hit testing, no rect-carrying `WKUIDelegate` callback. **(verified)**

**[F09] Thirteen CSS declarations use viewport units, and all are ceilings on overlays.** Inside a transformed root, `vh`/`vw`/`dvh` still resolve against the real window, so each is wrong by the factor: `tug-sheet.css:93,199`, `tug-modal-input-dialog.css:63,70,71`, `tug-popup-list.css:63`, `tug-banner.css:122`, `cards/text-card-save-sheets.css:42`, `cards/side-question-overlay.css:17`, `chrome/update-pill.css:61`, `cards/gallery-motion-bench.css:50`, plus the dev-only `dev-error-overlay.ts:110,150`, and `tug-split-pane.tsx:214` documents `vh`/`vw` as accepted size props. No `@media` width query exists in the deck. **(verified by grep)**

**[F10] The app-test harness has no wheel verb.** `NativeEventHandlers.swift` dispatches clicks, drags and keys; nothing synthesizes a scroll wheel. So how far a wheel tick scrolls inside the transformed root at 50 % cannot be read in the harness today. **(verified)**

**[F11] The pre-arc base at `789fcc828` carried the old mechanism and its plumbing.** `tug.css:130` had `body { zoom: var(--tug-zoom) }`, `scale-timing.ts:17` had `getTugZoom()`, `fold-crossing.ts:591` had `layoutPxOf`, and `deck-canvas.tsx`, `tug-pane.tsx`, `rail-width-draft.ts`, `deck-manager.ts` divided by the factor at 15 sites. The zoom arc (`bb28f7ade`, `ef81ba684`) deleted all of it under its [B08], replaced the `@container` rungs with a `ResizeObserver` mapping, moved Z2's budgets from `ch` to `em`, fixed the transcript over-mount, added the page-zoom store and readout, and let the zoom chords reach the host. **(verified, `git show`)**

---

## Inventory {#inventory}

> Every site the audit found, by file, with what it mixes and the fix shape. "÷f" means the viewport reading is divided by the factor before it meets a layout value; "×f" the reverse. `scaleX`/`scaleY` are CodeMirror's own readings of the same factor. This is the arc's checklist; a site is done when it reads one space or converts explicitly.

### Deck chrome: panes, canvas, guides, settle

| File | Line(s) | Mixes | Fix |
|---|---|---|---|
| `chrome/tug-pane.tsx` | 2186–2198 `releaseImposedFrame` | rect − canvas rect written to `style.left/top/width/height` and seeded as the gesture's layout frame | ÷f on all four |
| | 3437–3439, 3463 `landZoneDrop` | from/to rect delta written into `translate()` | ÷f on dx, dy |
| | 3641–3646 `pointerOnCanvas` | viewport point vs zone bands and autoscroll `bandStart/End` (layout) | ÷f |
| | 3665–3686 `tabBars` / `startRect` | viewport rects handed to `enumerate()` with store layout | ÷f |
| | 3918–3920 zone-drag transform | pointer delta + `slide` (layout) into `translate` | ÷f on the pointer delta |
| | 3631–3633, 4035–4057 drag snap | `snapshotCardRects` / `measureGuideEdgeOffsets` (viewport) vs `movingRect` (layout) | in `snap-guides.ts` |
| | 4656–4657, 4727 resize snap | same, against layout `r` | in `snap-guides.ts` |
| | 5765–5779 `clampedPosition` (4025, 4428) | layout start + viewport delta; viewport canvas extents vs layout frame | ÷f on delta and extents |
| | 5807–5808, 5838–5839 `resizeDelta` (4652–4655) | layout start + viewport dx/dy; viewport canvas width clamps layout left+width | ÷f on delta and extents |
| | 4771 `keepSlotWidth` | layout edge + viewport delta | ÷f on the delta |
| | 4793 `slotDragHeight` | `offsetHeight` + viewport dy | ÷f on the delta |
| | 4810 `flowKeepSlotWidth` | layout width + viewport dx | ÷f on the delta |
| | 3888–3891 `releaseVelocity` | viewport px/s projected onto a layout travel | ÷f |
| `chrome/deck-canvas.tsx` | 886 `PlaceSeam.computeHeight` | `offsetHeight` start + viewport `clientY` delta | ÷f on the delta |
| | 3589–3594 `toCanvas` in `measureAndEnumerate` | viewport pane/slot/vacancy rects into `enumerateDropZones` with band edges and run heights; `zone.rect` then written to style by `lib/drop-zone-indicator.ts:61–64` | ÷f in `toCanvas` |
| `chrome/snap-guides.ts` | 51–56 `measureGuideEdgeOffsets` | viewport deltas into a guide's `style.left/top` | ÷f |
| | 86–92 `snapshotCardRects` | viewport rects as layout snap targets | ÷f (the old `zoom` parameter's seat) |
| `chrome/settle-engine.ts` (root cause `lib/pane-flip.ts:135 flipDelta`) | 184–187 `railTravelPx` (3723, 4002–4029) | rect travel into `translateX` | ÷f |
| | 2571–2578 flow take | layout `nextFlowOffset` − rect delta | ÷f on the delta |
| | 3203–3208 held tile | `flipDelta` and `firstRect.height` into transform and height hold | ÷f |
| | 3259, 3271–3272, 3450–3452 beats | `flipDelta` plus First/Last widths and heights fed to `planSettleBeats` as px | ÷f in `flipDelta` and on the size terms |
| | 3605, 3610 rail shadow | rect dx into the hold transform | ÷f |
| | 3669–3686 departures | `flipDelta` and `firstRect.width/height` into inline styles | ÷f |
| | 3751–3753 departing strip | rect dx into `translate` | ÷f |
| `chrome/zoom-rects.ts` | 163–169 `stashZoomRect` | viewport rect stored for a layer under the scaled overlay root | ÷f |
| | 308–311 (boxes from `update-pill.tsx:174`, `update-tug.tsx:435`) | viewport box into `style.left/top/width/height` | ÷f on `from`/`to` |
| `card-drag-coordinator.ts` | 519–520 | viewport `dropX − containerRect.left` passed to `store.detachCard` as layout | ÷f |
| | 686–692 | rect delta into the indicator's `style.left` | ÷f |
| | 740–743 (grab offsets 255–256) | ghost appended into `#deck-container` positioned from client px | ÷f |
| `deck-manager.ts` | 6253–6262 `_readPaneFrameRect` (6298–6302) | rect written into stored `position`/`size` | ÷f |
| `lib/rail-width-draft.ts` | 324–326 `pinnedEdge` | viewport value in layout snap math and guides | ÷f |
| | 392, 428 `startWidth`/`shown` = `frameRect.width` | compared with limits, written to `width`, combined with `offsetLeft` (570) | use `frame.offsetWidth` |
| | 711–714 readout | client px into `style.left/top` | ÷f |
| | 746–748 `travel` | viewport delta + layout width | ÷f |
| `lib/rail-fit.ts` | 128–133 | rect heights − `scroller.clientHeight`, vs the layout run | use `offsetHeight` |
| `lib/fold-crossing.ts` | 569 `contentBoxHeight` (read by settle-engine 2150, 3248–3306; deck-canvas 732) | rect height written to the held-height px prop | ÷f |
| | 576 `contentBoxWidth` | rect width into the width hold | ÷f |

### Scroll and reveal

| File | Line(s) | Mixes | Fix |
|---|---|---|---|
| `lib/resize-episode.ts` | 357–365 | `rect.height` vs `scrollHeight − slack` | ÷f |
| | 386 `measureDelta` (190, 397) | rect delta + `scrollTop` | ÷f |
| `lib/smart-scroll.ts` | 879–906 `scrollToElement` | rect top/height with `clientTop/clientHeight` into `scrollTop` | ÷f on the rect terms |
| `tugways/tug-list-view.tsx` | 5225–5235 `rectSpaceRebasePx` | rect top + `scrollTop` − ledger offset | ÷f on the rect |
| | 5364–5372 `rangeRevealGeometry` | rect `portTop` + `clientHeight`; CSS-var inset + viewport | ÷f on the rects |
| | 5471–5478 reveal place | viewport delta via `scrollTo` | ÷f |
| | 5591–5614 page nav | rect `cellTops` vs ledger tops | ÷f on the rect tops |
| `internal/use-position-stable-click.ts` | 199–202 | rect delta + `scrollTop` | ÷f |
| | 223–261 sticky solve | rects with `scrollTop`, computed `top`, `scrollHeight` | ÷f on the rect terms |
| `tugways/focus-reveal.ts` | 81–115 | `port.top/left` + `clientHeight/Width` into `scrollTop/Left` | ÷f on the rect terms |
| `jots/jots-card.tsx` | 524–532 `revealOpeningJot` | rect + `clientHeight` into `scrollTop` | ÷f |
| | 600, 616 | rect target as animated height; `clientHeight −` header rect | ÷f |
| | 691 | rect height as a `height` keyframe | ÷f |
| `overview/overview-card.tsx` | 1236 | rect delta + `scrollTop` | ÷f |
| `body-kinds/file-block.tsx` | 631–653 | CSS-var `stickyTop` + header rect, viewport match/outer rects, into `scrollTop` | ÷f on the rect terms |
| | 748–749 | `block.top + offsetPx` into `scrollTop` | ÷scaleY |
| `cards/session-card-telemetry-popovers.tsx` | 803–804 | rect delta + `clientHeight` into `scrollTop` | ÷f |
| `chrome/session-question-dialog.tsx` | 1974–1983 | rect shortfall + constant into `scrollTop` | ÷f |
| | 2012–2023 | rect height into `minHeight` | ÷f |
| `tug-prompt-entry.tsx` | 1610–1617 | rect height into `minHeight` | ÷f |
| `find-flash.ts` | 52–59 | rect delta + `scrollLeft/Top` into `style` | ÷f on the rect terms |
| `cards/session-history/session-history-view.tsx` | 311 | `IntersectionObserver` `rootMargin` px reads as viewport | ×f, or accept the feel |

### CodeMirror-adjacent

| File | Line(s) | Mixes | Fix |
|---|---|---|---|
| `lib/cm6-scroll-anchor.ts` | 61–65 | `lineBlockAtHeight(scrollTop)` | ×scaleY in, ÷scaleY out |
| | 80–81 | `block.top` + offset returned as `scrollTop` | ÷scaleY |
| | 108–110 (200) | `coordsAtPos` delta + `scrollTop` | ÷scaleY |
| `tug-text-editor.tsx` | 1021–1037 | `lineBlockAt` vs `scrollTop`/`clientHeight`, into `scrollTop` | ÷scaleY on the block |
| | 1115 | `defaultLineHeight` as a CSS px var | ÷scaleY |
| | 3584–3606 completion popup | `coordsAtPos` + `innerWidth/Height` with `offsetWidth/Height` into `style.left/top` in the overlay root | ÷f on coords; `innerWidth/f`, `innerHeight/f` |
| `tug-text-card-editor.tsx` | 1454–1466 | `coordsAtPos − rect + scrollLeft/Top` vs `clientWidth` | ÷scale on the coords delta |
| | 1506 | `lineBlockAtHeight(scrollTop)` | ×scaleY |
| `tug-text-editor/state-preservation.ts` | 142–151, 166–170 | `block.top + topOffsetPx` into `scrollTop` | ÷scaleY |
| | 525–529 | `lineBlockAtHeight(scrollTop)`, `scrollTop − block.top` | ×scaleY / ÷scaleY |
| `tug-text-editor/keymap.ts` | 228–233 | same pattern | ×scaleY / ÷scaleY |
| `tug-text-editor/line-box-metric.ts` | 120 (77, 90) | rect or `defaultLineHeight` as a CSS px var | ÷scaleY |
| `tug-text-editor/caret-layer.ts` | 141–145 `documentBase` | unscaled `scrollLeft/Top` subtracted from a rect | ×scale (as CM's `getBase`) |
| | 347, 355 `caretHeight` | ghost computed height in a viewport-px layer | ×scaleY |
| | 363–368 `visibleRight` | `scrollLeft + clientWidth` vs viewport `rawLeft` | ×scaleX |
| `tug-text-editor/selection-layer.ts` | 97–98 `markerRight` | `scrollLeft + clientWidth` vs viewport `marker.left` | ×scaleX |
| `tug-text-editor/session-dot-layer.tsx` | 247–248 | origin from unscaled `scrollLeft/Top` | ×scale |
| | 243, 274–276 | chip CSS px and dot box vs rects in the layer | ×scale |
| `tug-text-editor/drop-extension.ts` | 535–543 (561–563) | `coordsAtPos − outer + scrollLeft/Top` with ghost `caretHeight` into a scrollDOM child's style | copy CM's drop cursor: `×scaleY` in, ÷scale on write |
| `tug-text-editor/host-click.ts` | 58–60 | `rect.left + clientWidth`, `rect.top + clientHeight` | ×scale on the client sizes |

### Overlays positioned by hand, sheets, tabs, reorder

| File | Line(s) | Mixes | Fix |
|---|---|---|---|
| `tug-editor-context-menu.tsx` | 477–490 (905) | `clientX/Y`, rect, `innerWidth` into `style.left/top` in the overlay root | ÷f on the final left/top |
| `tug-combo-box.tsx` | 332–333, 674–676 | rect into fixed `top/left` | ÷f |
| `tug-alert.tsx` | 428–431 | `innerHeight − rect.bottom`, `rect.left` into style | ÷f |
| `chrome/find-wrap-overlay.tsx` | 62–64 | card rect centre into `style.left/top` | ÷f |
| `tug-placard.tsx` | 181–196 | rect/`innerHeight` into the available-height px var | ÷f |
| | 362–368 | client delta + layout `style.left` | ÷f on the delta |
| `cards/session-card-telemetry-renderers.tsx` | 1167–1187 | `anchorCenter`/`foldedTop` from rects with `clientLeft/clientWidth`, fed to the placard's `style.left` | ÷f |
| `card-slot-badge.tsx` | 307–311 | rect `chipLeft` + `offsetWidth` into `translate` | ÷f |
| `tug-sheet.tsx` | 1532–1585 | frame/anchor/clip rects with `scrollHeight`, margins, `SHEET_CANVAS_GAP` into `clip.style.bottom/top` | ÷f on the rects |
| | 1654–1664 `available` | rect `clipBox` − CSS margins | ÷f on the rects |
| | 1674–1704 aspect cap | rect frame with `offset*` and padding into `maxWidth` | ÷f |
| | 1713–1718 host-fraction cap | rect frame into `maxWidth`/`maxHeight` | ÷f |
| | 1831–1865 resize | rect start + client delta into `style.width/height` | ÷f |
| `tug-tab-bar.tsx` | 235–268 | rect widths with layout constants (30 / 40 / 28) | use `offsetWidth` |
| `tug-block-reorder.ts` (`tugways/block-reorder.ts`) | 330–335 (371) | rect slot into sibling `translateY` | ÷f |
| | 382 | rect delta into the caret's `style.top` | ÷f |
| | 441–448 | client dy clamped by rect deltas into `translateY` | ÷f |
| | 555–557 | FLIP rect delta into `translateY` | ÷f |

### Raster, ratio, and body-level

| File | Line(s) | Today | Under the transform |
|---|---|---|---|
| `tug-sparkline.tsx` | 187–189, 321–338, 374–375 | backing = css × dpr, re-keyed by `matchMedia(resolution)` | backing = css × dpr × f; subscribe to the zoom store |
| `cards/pdf-view.tsx` | 221–228 | backing and render scale from dpr | × f |
| `lib/tug-atom-img.ts` | 404–416 `bakeScale` | `max(2, dpr×2)` capped at 6 | headroom covers f ≤ 2; comment only |
| `internal/list-view-window.ts` | 322–359 `classifyWidthSettle`; `tug-list-view.tsx:3445–3497, 3557–3560` | `rescaled` iff dpr moved | key on the zoom factor or its generation in `WidthSample` ([F07]) |
| `internal/__tests__/list-view-window-zoom.test.ts` | | dpr-based classification | rewrite against the new key |
| `lib/motion-guard/gesture-frame-probe.ts` | 66–72, 229; `MainWindow.swift:950–970 captureFrameBurst` | record dpr | record the factor too (diagnostic) |
| `responder-chain-provider.tsx` | 1779–1785 (86–94) | fallback context menu on `document.body`, clamped by `innerWidth/Height` | portal into the overlay root |
| `lib/markdown/enhance-img.ts` | 124 (`tug-markdown-view.css:946–947`) | lightbox on `document.body`, fixed | append inside the root |
| `lib/jot-drag.ts` | 89 | drag-image preview on `document.body`, sized from a rect | size ÷f, or append inside the root |
| `tug-sheet.tsx` | 2584 | `paneFrameEl ?? document.body` | fallback to the root |
| `src/globals.css` | 32–41 | dot grid on `body` | paint it on `#deck-container` |
| `lib/use-canvas-overlay.ts` | | `getRoot() ?? document.body` before the overlay root registers | fallback to `#deck-container` |

### Viewport units ([F09])

`tug-sheet.css:93` (`height: 100vh`), `:199`; `tug-modal-input-dialog.css:63,70,71`; `tug-popup-list.css:63` (`100dvh` fallback under `--radix-popover-content-available-height`, itself viewport-measured); `tug-banner.css:122`; `cards/text-card-save-sheets.css:42`; `cards/side-question-overlay.css:17`; `chrome/update-pill.css:61`; `cards/gallery-motion-bench.css:50`; `dev-error-overlay.ts:110,150` (dev only, may stay unscaled); `tug-split-pane.tsx:214` (doc: callers may pass `vh`/`vw`).

### Host and harness ([F08])

| File | Line(s) | Today | Under the transform |
|---|---|---|---|
| `MainWindow.swift` | 432–445 | zoom constants and defaults key | unchanged; comment |
| | 570–589 launch restore | writes the clamped default to `webView.pageZoom` before load; harness pins 1.0 | keep as stored `zoomFactor`; never write `pageZoom`; the deck receives it on `frontendReady` while the view is still hidden (568) |
| | 775–799 `forwardActivationClick` | divides the view point by `pageZoom` | drop the divide |
| | 844–848 `currentPageZoom` | `webView.pageZoom` | the stored factor (readers: `AppDelegate.swift:2595–2601`, 917, 922) |
| | 857–896 `applyPageZoom` | will-notice, `pageZoom` write (883), awaited did-apply | one awaited bridge call carrying the factor; the deck applies the transform inside it |
| | 898–908 `bridgePageZoom` | reports `webView.pageZoom` | reports the stored factor; the deck applies, not records |
| | 1904–1938 `lookUpInDictionary` | multiplies x, y, fontSize by `pageZoom` | drop on x, y; keep on fontSize from the stored factor. Deck side `lib/dictionary-lookup.ts:186–211` mixes a rect baseline with unscaled canvas ascent/descent: ×f on the metrics |
| `AppDelegate.swift` | 1809–1836, 2495–2601, 2801–2803, 3030–3068 | menu actions, validator, `frontendReady`, View menu build | unchanged; comment at 3050 |
| `TestHarness/CoordMapping.swift` | 99–115 `viewportToScreen` | `viewport × pageZoom` | drop the multiply; fix the comment |
| `TestHarness/TestHarnessConnection.swift` | 105–110, 251–253, 540–560 | surface `1.11.0 setPageZoom`; fallback `pageZoom` write (556); responds with `webView.pageZoom` | bump the surface; drop the fallback; respond with the stored factor after the deck's apply resolves |
| `tests/app-test/_harness/client.ts` | 1169–1178; `index.ts:172, 871–876` | doc says CoordMapping scales | doc only |
| `tests/app-test/at0710-zoom-same-layout.test.ts` | 165–169, 204–260 | waits on dpr; asserts ratio before/after | wait on the awaited RPC or the store; assert the root's computed transform and factor |
| `tests/app-test/at0330-transcript-eviction.test.ts` | 712–762 | per-frame dpr series; wraps the will-notice | key on the store's factor; this file guards [F07]'s regression |
| `tests/app-test/at0626-sash-drag-sampler.test.ts` | 128–140, 313–325 | `setPageZoom(<1)` to hold 1400 CSS px | works once the root resizes to viewport ÷ f |
| `tugdeck/src/lib/page-zoom-store.ts` | 4–10, 81–141, 204–211 | listener and feedback only; "divides nothing" | owner of the factor, writer of the transform and root size, source of the two conversion helpers |
| `chrome/zoom-readout.tsx` | 1–100 | raised on will, leaves on settle | logic unchanged; it is inside the overlay root so it scales with the deck, which is right for a readout of the deck |
| Comments naming `pageZoom` | `settings-api.ts:938`, `transcript-settings-store.ts:14`, `cards/session-card.css:525,536`, `settings-session-card-body.tsx:9,223`, `tug-atom-markdown-body.tsx:309`, `tug-atom-text-body.tsx:142`, `tug-transcript-entry.tsx:300`, `command-registry.ts:1956–1962`, `host-menu-state.ts:219` | | text only |
| `tuglaws/design-decisions.md:37` D72; `tuglaws/menus.md:94,114` | D72 names `pageZoom` the one zoom; menus.md says the gate reads `window.currentPageZoom` | D72 superseded by a new entry ([B12]); menus.md still true, the property is now stored state |

---

## Decisions {#decisions}

**[B01] View › Zoom is a CSS `transform: scale(f)` with origin `0 0` on `#deck-container`, which is sized to `innerWidth / f` by `innerHeight / f`; `WKWebView.pageZoom` stays at 1.0 forever.** [F01] rules out every mechanism that feeds `effectiveZoom`, which is `pageZoom` and CSS `zoom`. A transform scales the rendered picture, so the font floor never applies ([F02]), text is rasterized at scale ([F03]), and the inverse size keeps the deck filling the window and laying out into the larger room, which is exactly "the layout at 100 %, scaled" and keeps the canvas from floating. Z2, `@container` rungs, `ch` budgets, and every `ResizeObserver` reading are correct by construction, because layout px never move. What would reopen this: a WebKit that lifts the logical font floor from the host, which was searched for and does not exist on this macOS.

**[B02] The host keeps the factor, the menu, the range, persistence, and the harness verb; the deck applies it.** The View menu, chords, validator, `WebViewPageZoom` default and 50–200 % range are working and stay as they are. `applyPageZoom` becomes one awaited bridge call carrying the factor, inside which the deck sets `zooming`, writes the transform and the root size in the same task, waits its settle frames, and resolves. The will/did pair and the IPC-ordering argument of the last brief's [B04] collapse, because the relayout is now the deck's own act. `bridgePageZoom` on `frontendReady` carries the standing factor and the deck applies it before the host shows the view, so there is no 100 % flash at launch. `currentPageZoom` reports stored state; `tuglaws/menus.md` stays true.

**[B03] The work is based on `main` with the two zoom-arc rounds reverted, and the brief commit kept.** The user asked for the work to be done cleanly against a commit before the scaling attempts. `789fcc828` is that commit; `tugtool arc create --base` takes a branch, so the clean route is the user reverting `ef81ba684` and `bb28f7ade` on `main` and opening the arc there, which keeps `main` linear and lets the arc join the ordinary way. The brief at `038e516e2` stays as history: its findings ([F01] here cites them) are true and its decisions are superseded by this document. The reverted base gives back the `getTugZoom` plumbing at 15 sites ([F11]), the `@container` rungs and the `ch` budgets, and takes away four things the new arc redoes on purpose: the chord fix (three `preventDefault` flags in `command-registry.ts`, needed under any mechanism), the transcript over-mount guard (re-keyed per [B07]), the page-zoom store and readout (reshaped per [B02]), and the batched pin-stack registration.

**[B04] The two coordinate spaces are converted explicitly at every site in the inventory, through one pair of helpers the zoom store exports, and nothing patches a DOM prototype.** A geometry shim that wraps `getBoundingClientRect`, the pointer getters, `elementFromPoint`, `innerWidth` and `devicePixelRatio` would make the transform look like `pageZoom` to all 99 sites at once, on the current `main` with no revert. It is rejected: it is hidden global coupling of the kind this project refuses, it would make floating-ui and CodeMirror compute a scale of 1 and so depend on the shim being complete, and any native reader it missed would be wrong silently. Instead `page-zoom-store.ts` exports `layoutPxOf(viewportPx)` and `viewportPxOf(layoutPx)` (and the factor itself for canvas sizing), every site in the inventory names which space it reads, and a future rect reader has a rule to follow: a rect or a pointer is viewport px until it is converted. Where a site can read a layout property instead (`offsetWidth` for a rect width, `offsetHeight` for a rect height), that is the better fix, because it removes the mixing rather than correcting it.

**[B05] Everything visible lives inside the transformed root.** The fallback context menu, the image lightbox, the jot drag preview, and the `tug-sheet` no-pane fallback move off `document.body` into the root ([F04]); the overlay registry's pre-registration fallback becomes the root rather than `body`. The dot grid moves from `body` to `#deck-container`, so it scales with the deck as it did under `pageZoom`. The dev error overlay may stay on `body` at 1×. With this, no element renders at a different scale from the deck, and `position: fixed` means the deck's viewport everywhere.

**[B06] Viewport units are replaced by two custom properties the zoom store writes.** The store sets `--tug-viewport-width: calc(100vw / f)` and `--tug-viewport-height: calc(100vh / f)` on `:root` alongside the transform; the 13 declarations of [F09] read them instead of `vh`/`vw`/`dvh`, and `tug-split-pane`'s size props stop documenting viewport units. The Radix available-height variable is floating-ui's and is corrected by its scale handling ([F06]); the arc confirms that with the popup list open at 0.5 and 2.0.

**[B07] The transcript over-mount guard keys on the zoom factor, not `devicePixelRatio`.** `WidthSample` carries the store's factor (or a generation it bumps per step) in place of `pixelRatio`; `classifyWidthSettle` answers `rescaled` when that moved and the width moved by its ratio. The hold the deck-canvas `ResizeObserver` takes while `isZooming()` stays, because the root does resize. `at0330`'s zoom case keeps asserting the 15-cell ceiling and the quarter-second worst gap, now keyed on the factor, so the regression of [F07] cannot land quietly.

**[B08] Canvas backing stores are sized by `dpr × f` and subscribe to the zoom store.** The sparkline and the PDF view ([F07]) size their backing stores from the product and re-render on a factor change, since `matchMedia(resolution)` never fires. The atom-image bake scale already has headroom to 2.0.

**[B09] The host drops its point conversions and keeps one font-size conversion.** `CoordMapping.viewportToScreen`, `forwardActivationClick`, and the x/y of `lookUpInDictionary` stop multiplying or dividing by zoom ([F08]); the dictionary `fontSize` is multiplied by the stored factor, and the deck's baseline computation scales its canvas font metrics by the factor before mixing them with a rect. The harness surface version is bumped; `dispatchSetPageZoom` drops its fallback `pageZoom` write and responds after the deck's apply resolves, so no test waits on a ratio.

**[B10] The verdict is taken by the harness on five surfaces, each at 0.5, 1.0 and 2.0, before the arc is done.** (1) `at0710`: Z2 shows the same cells at the same widths and zero overflow at every factor from 50 % to 200 %, and the root's rect equals the window. (2) A raster test in the `at0493` shape: a screenshot crop of a known glyph at 2.0 has an edge profile no softer than the same glyph at 1.0, turning [F03]'s read-by-eye into an assertion. (3) A pane dragged by N viewport px with the native drag verb lands at N / f layout px, and a resize and a snap guide agree with it. (4) A Radix popover and the completion popup open anchored to their trigger at every factor, and the sheet clamp lands inside the window. (5) `at0330`'s zoom case holds its mount ceiling and worst gap under the new key. Each is a verdict run once after the step's last edit, not a probe.

**[B11] Wheel scrolling inside the transformed root is read on the release deck by the user, with the harness given a wheel verb if the reading is wrong.** [F10]: the harness cannot synthesize a wheel tick today. WebKit scrolls a transformed scroller by the wheel delta in the scroller's own layout px, which at 0.5 moves half the visual distance a tick moves at 1.0. Whether that is acceptable is a feel question the user answers on their own deck after the join. If it is not, the fix is a compensating `wheel` listener on the scrollers, and the verdict for it needs a native wheel verb in `NativeEventHandlers.swift`; both are the arc's to add in that case, and neither is built in advance of the reading.

**[B12] D72 is superseded in the open, not edited.** A new design-decisions entry records that the one user-facing zoom is a transform the deck applies to its root from a factor the host owns; that a rect or a pointer is viewport px and a layout property is layout px, converted only through the store's helpers; and that `pageZoom`, CSS `zoom`, and a prototype shim are not to be re-proposed, with [F01] and [B04] as the reasons. D72's text is marked superseded by the new entry. `briefs/view-zoom-performance-and-feedback-brief.md` [B08] and its out-of-scope line are the decisions this reverses, and the new entry cites them so the reversal is traceable.

---

## Open Questions {#open-questions}

- **Does a wheel tick at 0.5 feel right?** Only the user's deck can answer, and only after the join ([B11]). The arc does not wait on it.
- **Is there a WebKit reader of geometry the inventory missed?** The audit read every `getBoundingClientRect`, `getClientRects`, pointer-coordinate, `elementFromPoint`, `innerWidth/Height`, and `devicePixelRatio` site in `tugdeck/src`. What it cannot have read is a library's internal reader; `floating-ui` and CodeMirror are accounted for ([F06]), `react-resizable-panels` and `sonner` are not and are checked by the arc's first step with the transform in place.

---

## Non-goals {#non-goals}

- **`pageZoom` and CSS `zoom`.** Both feed `effectiveZoom` and both are floored at 9 zoomed px ([F01]). The floor cannot be lifted from the host. Not to be re-proposed.
- **`WKWebView._viewScale`.** Built and rejected on 2026-10-07: it lays out at unchanged CSS px in a viewport of size ÷ scale, so the fonts are unclamped and Z2 is whole, but the canvas is a fixed scrolling world and zooming out revealed the grid around a deck that no longer filled the window. The user: "repositions the content in the window, which looks ridiculous."
- **Collapsing Z2 by fit below 90 %.** Built, verified, and rejected the same day: "I don't want Z2 to change its layout." A zoom step changes scale and nothing else.
- **Capping Zoom Out at 90 %.** It ships in an afternoon and loses the 50–80 % range the user asked for.
- **A geometry shim on DOM prototypes.** Rejected in [B04] with its reasons.
- **Scaling overlays separately from the deck.** Everything visible is inside the root ([B05]); a second scale for popovers or the readout is a second mechanism.
- **A deck-side zoom slider or a per-card zoom.** The host's menu and chords are the one door. (`--transcript-zoom` in `session-card.css:520–531` is a transcript density setting, not a zoom, and is untouched.)

---

## Exit {#exit}

**An arc**, opened on `main` after the user has reverted `ef81ba684` and `bb28f7ade` ([B03]). The shape the inventory suggests, in the order the pieces depend on each other:

1. **The mechanism and its owner.** The store writes the transform, the root size and the two custom properties; the host's one awaited bridge call; the chord fix; the launch path applying the factor before the view shows; the grid onto the root. From here on every factor renders, and the inventory is walked with the transform live.
2. **The spaces.** The store's two helpers, then the inventory's chrome tables: panes, canvas, guides, settle, drag coordinator, rails, fold crossing. The drag/resize/snap verdict of [B10] closes it.
3. **Scroll, reveal, and the CodeMirror-adjacent sites**, with the editor's own `scaleX/scaleY` as the factor where CodeMirror is the reader.
4. **Overlays and units**: the hand-positioned overlays, the four body-level elements moved inside, the 13 unit declarations, the popover and sheet verdict.
5. **Ratio consumers**: the over-mount guard re-keyed, the canvas backing stores, `at0330`.
6. **Host and harness**: `CoordMapping`, the activation click, the dictionary popover, the surface bump, `at0710`'s rewrite, the raster test.
7. **The record**: the new design-decisions entry superseding D72, and the comments that still name `pageZoom`.

The verdict surfaces of [B10] are the checkpoints; the user's wheel reading ([B11]) follows the join.

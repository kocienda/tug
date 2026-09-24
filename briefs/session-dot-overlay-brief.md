<!-- brief-skeleton v1 -->

# The live session dot in the editor's chip

**Purpose:** The composer's session chip is a Canvas bake inside an `<img>`, so its phase dot is a snapshot taken at paste time and never moves. Every other surface that names a session shows a dot that breathes and changes with the session. The chip should too, without giving up the editing behaviour that only a replaced element gets from WebKit, and without putting any animation on the main thread.

---

## Purpose {#purpose}

The user's framing: "we have the constraint that these atoms need to behave as *replaced elements* in the flow so that the editor treats them as *plain images* for the editing behaviors to work. It just feels absurd that we can't satisfy these two constraints of (1) replaced element and (2) live/animating status of the session pulsing as it exists and changes."

The requirements, in the user's priority: editing correctness, atom liveness, graphical correctness, and performance with the rule that "there must *never* be any juddering." A main-thread animation is "a *complete non-starter*." If no option meets that bar, the chips stay as they are.

The chip today: `tugdeck/src/lib/tug-atom-img.ts` paints the pill, its label and its dot with Canvas 2D and bakes a PNG data URI into the `<img>` that `AtomWidget.toDOM` in `tugdeck/src/components/tugways/tug-text-editor/atom-decoration.ts` returns. The dot's colour comes from `sessionPhaseNow`, a one-time read; the module says so in its own words: "the chip is a Canvas bake inside an `<img>`, which can neither subscribe nor cascade ([P14])". Rename, theme and verdict changes reach a chip only by rebuilding the widget.

---

## Evidence {#evidence}

### What WebKit treats as an editing atom

**[F01] The editing engine has one switch for atomicity, and `<img>` and `<canvas>` share it** — `Node::canContainRangeEndPoint()` returning false is what `editingIgnoresContent`, `isAtomicNode` and `Position::isCandidate` read, and it is overridden to false by `HTMLImageElement`, `HTMLCanvasElement`, `<br>`, `<hr>` without children, `<meter>`, `<progress>`, `<output>`, `<iframe>`, `<embed>`, `<object>` not showing fallback, `<input>`, `<textarea>`, `<select>` and `<attachment>`. `<video>`, `<audio>`, `<picture>`, an inline `<svg>` root and a `contenteditable="false"` span have no override. Read from WebKit `main` (`Source/WebCore/editing/Editing.h`, `dom/Position.cpp`, `html/HTMLCanvasElement.cpp` and the element headers). **(verified by reading source)**

**[F02] A WKWebView probe confirms the table at the keyboard** — a Swift host loading a contenteditable with `ab<X>cd` and driving `Selection.modify`, `execCommand("delete")`, `caretRangeFromPoint` and `execCommand("copy")` for each element kind. `<img>`, `<canvas>`, `<iframe>` and `<object>` produce identical caret walks (one slot each side), identical shift-arrow selection of the atom, identical whole-atom backspace and forward delete, and identical hit-testing. `<video>` lets the caret land inside it. An inline `<svg>` is skipped by the caret and a backspace after it deletes the character before it. A `contenteditable=false` span lets the caret and selection enter its label. **(verified, probe run 2026-09-24 on this machine's WebKit)**

**[F03] `role="img"` does not deliver the atom it promises** — `Element::canContainRangeEndPoint` returns false for any element with `role="img"` (`Element.cpp`, bug 126322), which reads as a way to make live DOM an atom. In the probe, with and without `contenteditable=false`, with children `user-select: none`, and as `inline-block`, the span added a phantom caret stop before itself, a click in its middle landed inside the label, a shift-arrow first selected nothing, and a backspace after it emptied the whole editor. There is also an open WebKit hang, bug 276460, on caret inside a `role="img"` subtree. Rejected on evidence. **(verified)**

**[F04] Copy and drag differ between `<img>` and `<canvas>`** — WebKit's markup serializer copies a canvas as an empty `<canvas>` tag with attributes and no pixels (layout test `copy-paste-content-starting-and-ending-canvas-expected.txt`), and `DragController::draggableElement` promotes only `HTMLImageElement` to an image drag. Tug's own copy path writes `text/plain` plus the private sidecar (`clipboard-filters.ts`), so internal paste would survive, but external paste and native drag would lose the picture. **(verified by reading source and the probe's pasteboard dump)**

### What CSS can do to a replaced `<img>`

**[F05] A background paints beneath the transparent pixels of an `<img>`, and a registered custom property animates inside it** — `RenderReplaced::paint` draws box decorations before the replaced content. In a second WKWebView probe, an `<img>` whose PNG had a transparent region carried a `radial-gradient` background driven by `@property` `<length>` and `<number>` keyframes; the computed values advanced over 0.7s, a pixel sampled at the well read the gradient blended at the animated alpha, a transparent pixel outside the dot read the page background, and an opaque pixel read the PNG. `::before` and `::after` cannot exist on a replaced element (`RenderReplaced::canHaveChildren` is false). **(verified)**

**[F06] That gradient animation is a main-thread animation** — `background-image` is never handed to the compositor in WebKit; each frame restyles and repaints the element on the main thread, so any long main-thread task stalls the breath for its duration. The pulsing dot component was built to avoid exactly this: `tug-progress-pulsing-dot.tsx` animates only transform and opacity from sampled keyframes "which WebKit cannot hand to the compositor" otherwise. **(verified by reading; the stall behaviour is inferred from how WebKit composites, not measured)**

### What CodeMirror does with a live widget

**[F07] Mutations inside a widget's DOM are invisible to the editor; replacing the widget's root is destructive** — in the installed `@codemirror/view` 6.41.1, `DOMObserver.readMutation` discards any record whose nearest tile is a widget, root or descendant, and only schedules a measure. Replacing the node `toDOM` returned makes the DOM reader parse the new node as text. The existing `pendingAtomSyncPlugin` and `syncSelectedAtoms` in `atom-decoration.ts` already mutate the widget root in place, so the pattern is in use. **(verified by reading `dist/index.js`)**

**[F08] `EditorView.layer` places DOM over the content in the frame before paint** — a layer's `markers()` runs in a measure read phase requested by `requestMeasure`, and its `draw()` in the matching write phase, both inside the animation frame that follows the document update, which is how the editor's own cursor and selection never trail the text. Marker `update(dom, old)` returning true keeps the host element's identity. **(verified by reading `LayerView` in `dist/index.js`)**

### The spike, and what it measured

**[F09] The overlay was built as a gated spike and it works** — the bake leaves a session chip's dot unpainted and records the dot's centre on the `<img>` as `data-atom-well-x` and `data-atom-well-y`; a layer measures every such chip in the content DOM and places one 12px host box over the well, positioned as `imgRect + well - (scrollerRect - scroll)`; a MutationObserver on the layer element rebuilds a host list published through `useSyncExternalStore`; and the editor component portals the real `SessionPhaseDot` into each host. The selected-face re-bake omits the dot too, or the static dot would show under the live one. A single constant in a small module switched the whole thing off. The spike's files were discarded after the brief was written; their shape is in Exit. **(verified)**

**[F10] Editing is untouched** — the atom is the exact `<img>` that ships, and the layer sits outside `.cm-content`. In the probe app-test, ArrowLeft crossed the chip as a unit, thirteen characters were typed in front of it, ArrowRight crossed back, and Backspace removed the chip whole and the host with it in the next frame. Seven existing pins stayed green with the spike in place: at0205, at0490, at0603, at0346, at0024, at0042 and at0043. at0423 failed once in a nine-file batch waiting on a shell command's exit and passed alone, the batch-contention pattern. **(verified)**

**[F11] Registration is exact at rest and on every keystroke, as painted** — centre-to-centre offset between the overlay host and the well was 0px in x and y at rest. During typing, a read taken synchronously after a keystroke showed a one-character offset on some samples; that read lands between the DOM mutation and the layer's frame and never reaches the screen. A sampler that arms on each content mutation and reads in a task after the following frame rendered saw 0px on all thirteen keystrokes. Screenshots show the dot seated in the pill at rest and after the chip moved behind the typed text. **(verified)**

**[F12] The breath runs on the compositor** — with the session in a turn, the host held a `tug-progress-pulsing-dot` carrying `data-breathing` and a running `tugx-progress-pulsing-dot-breathe` animation. The probe then froze the page's main thread with a 3000ms busy loop and photographed the app at roughly 0.6s and 1.5s into the freeze. The dot is at visibly different points of its breath in the two shots. Nothing on the main thread runs per frame; the layer's measure runs only when the document, viewport or geometry changes, which is when the cursor layer already runs. **(verified)**

**[F13] One existing pin asks the bitmap for the dot** — at0376 samples the PNG at the mark position and asserts alpha above 200. With the well it reads 0. The behaviour it guards, that the pill is transparent and the dot is its only colour, still holds; the pin now has to read the overlay dot rather than the pixels. **(verified)**

**[F14] The image-side alternatives each fail one of the four requirements** — APNG and animated-SVG data URIs restart their loop on every state change and obey the OS auto-play toggle rather than the app's motion setting; cycling pre-baked frames from JavaScript is per-frame main-thread work and polling; the WebKit-only `-webkit-canvas()` background is non-standard. `<canvas>` as the atom does not solve the breath at all without per-frame painting, and loses copy and drag pixels ([F04]). **(verified by web research; not built)**

---

## Decisions {#decisions}

**[B01] The `<img>` stays the atom, and the live part leaves the bitmap.** Liveness splits into two kinds: the label, verdict face and theme change rarely and already reach a baked chip through regeneration; the phase dot changes often and breathes continuously. Only the dot has to be alive every frame, and nothing requires it to be inside the pixels. Every alternative that changes the element loses the img-grade editing contract ([F02], [F03]) or the clipboard ([F04]).

**[B02] The dot is the real `SessionPhaseDot`, placed by a CodeMirror layer over a well the bake leaves empty.** This is the design the spike proved ([F09] through [F12]). It reuses the one dot component with its own phase subscription and compositor-driven breath, so nothing about the motion or the colour table is authored twice. The layer is the mechanism the editor already uses for its cursor, so its timing is the cursor's timing ([F08]).

**[B03] No animation on the main thread, ever.** The CSS-gradient chip ([F05]) was the simpler design and is rejected on this rule alone ([F06]). If the overlay had failed on evidence, the chips would have stayed as they are.

**[B04] The well is the absence of a painted dot, not a transparent hole.** The pill's surface is transparent already, so leaving the dot unpainted shows the composer background under the live dot, with no halo and nothing to composite through ([F13] confirms the ground reads transparent).

**[B05] The bake reports the well's centre on the `<img>`, and the layer reads it.** The geometry is the bake's to know; `iconX + fontSize / 2` and `height / 2` are written as data attributes at element creation, so the layer positions from a measured rect plus a recorded constant rather than a second copy of the chip's layout.

**[B06] A marker naming the same session updates its host in place.** Keeping the host element's identity keeps the portal and the running animation across every re-measure; only a chip that leaves takes its host with it.

**[B07] Hosts are a function of the layer's live DOM.** The layer creates and removes host elements in its write phase where React cannot see them; a MutationObserver on the layer element rebuilds the host list, the rule `session-citation-portals.tsx` already keeps.

**[B08] Registration is judged as painted, never as read synchronously after a keystroke.** A read between the DOM mutation and the frame is stale by design ([F11]); the pin must sample in a task after the frame renders.

**[B09] at0376 is re-pointed at the overlay dot, not deleted.** What it guards still holds; the pixel it samples moved into the layer ([F13]).

---

## Open Questions {#open-questions}

- Whether a chip whose verdict is `missing` shows phase. The live pill paints the missing dot in ink with no phase colour, and paints no dot at all for `elsewhere`. The spike painted phase regardless. The rule already exists in `tug-session-identity.tsx`; the arc has to make the layer's marker read the same verdict and either mount nothing or pass the inert state through. This is a decision the arc can take from the pill's existing behaviour rather than one the user has to make.
- Whether the overlay dot takes the selected tint when the selection covers the chip. The selected re-bake swaps the chip's face; the dot in the layer does not change. Probably a `data-selected` on the host from the same `syncSelectedAtoms` pass.
- Whether the chip's breath should be locked to the masthead's clock. No two surfaces are locked to each other today, and the user said timing is the least of the concerns.

---

## Non-goals {#non-goals}

- **A `contenteditable="false"` span with live children.** The caret and selection enter it ([F02]) and WebKit's bug list for non-editable inline islands is long. This is the original reason the chip is an `<img>` and nothing here reopens it.
- **`role="img"` as an atom-maker.** Reads well in source, fails at the keyboard, and has an open hang ([F03]).
- **`<canvas>` as the atom.** Truly atomic ([F01], [F02]) but it does not give the breath without per-frame painting, and it copies and drags without its pixels ([F04]). Worth knowing; not worth building.
- **A CSS-animated gradient painted under a transparent well.** Works ([F05]), and is a main-thread animation ([F06], [B03]).
- **Animated image formats in the `src`, frame cycling from JavaScript, `<video>` with a captured canvas stream, `-webkit-canvas()`.** Each rejected in [F14].
- **Re-litigating the `<img>` decision.** The user restated the constraint as the premise of this work.
- **Keeping hosts alive across viewport eviction.** A chip scrolled out of a long text card loses its widget and its host until it returns; the composer is short and this was not one of the four requirements.

---

## Exit {#exit}

An arc. The spike's shape is the arc's raw material, and it was discarded rather than kept so that the arc builds it under review rather than inheriting a probe. Its pieces, in the order they depend on each other:

1. `tugdeck/src/lib/session-dot-overlay.ts`: the two well attribute names. The spike also carried an on/off constant; the arc decides whether a switch survives.
2. `tugdeck/src/lib/tug-atom-img.ts`: `paintPillChip` takes an `omitDot` flag and skips the dot fill; `bakeAtomChipDataUri` accepts `omitDot` and returns `dotWell: { x: g.iconX + g.fontSize / 2, y: g.height / 2 }`; `createAtomImgElement` accepts `dotOverlay` and writes the two attributes.
3. `atom-decoration.ts`: `AtomWidget.toDOM` passes `dotOverlay` for session atoms; `syncSelectedAtoms` passes `omitDot` when the img carries the well attribute.
4. `tugdeck/src/components/tugways/tug-text-editor/session-dot-layer.tsx`: the `layer({ above: true })` with `markers()` reading `img[data-atom-type][data-atom-well-x]` from `view.contentDOM`, the `DotMarker` with `eq`, `draw` and an in-place `update` keyed on session id, the host store fed by a MutationObserver on the layer element, `sessionIdForChip` reading `data-atom-session-id` or resolving the callsign through `sessionTagStore` and `sessionLineStore`, a base theme making the layer `pointer-events: none` and hosts `position: absolute`, and `SessionDotPortals` rendering `SessionPhaseDot` at `markBoxForDot(atomRegisterMetrics().dotSize)` into each host.
5. `tug-text-editor.tsx`: the layer in the extension list beside `sessionVerdictRegenPlugin`, and `<SessionDotPortals view={view} />` beside `CompletionOverlay`.
6. The verdict rule and the selected tint from Open Questions.
7. Pins. Re-point at0376 ([B09]). Add a pin built from the spike's probe: bind a session, send a message so it is in a turn, paste a session atom naming that session through a `ClipboardEvent` carrying the `application/x-tug-atoms` sidecar, assert the host is centred on the well at rest, install a MutationObserver-armed sampler that reads registration in a task after each frame and type in front of the chip, assert every painted offset is 0, assert ArrowRight then Backspace removes chip and host, and assert the dot's breathe animation is running while the session is in a turn. The frozen-main-thread photographs ([F12]) are a human check rather than an assertion.

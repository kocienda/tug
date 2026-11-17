<!-- brief-skeleton v1 -->

# Figure image export

**Purpose:** A chart or diagram in the Session card can only be copied as its JSON spec. The user wants the picture: on the pasteboard as an image, and as a PNG or PDF file.

---

## Purpose {#purpose}

The report, on pressing the copy button at the top right of an `/explain` diagram:

> Hitting that little copy button in the top right of an /explain diagram *gives me text???!!!*. I want the diagram! We should offer this as an image or PDF. Same for charts I get with `tugtool chart`!

The button's label says "Copy diagram source", and it does what it says. The complaint is that the source is the only thing a figure can give up: there is no way to get the drawn figure out of the card and into a message, a slide or a document.

---

## Evidence {#evidence}

**[F01] The copy button copies the spec by construction.** `tugdeck/src/lib/chart/render-chart.ts` builds the figure's header with `buildCopyButton(() => source, diagram ? "Copy diagram source" : "Copy chart source")`, at the rendered state and again in `showUndrawn` for a figure that did not draw. **(verified)**

**[F02] Every figure goes through that one file.** A `tugchart` or `tugdiagram` fence in the transcript, a `TUG-CHART:` line under a Bash block, the gallery (`gallery-chart-block.tsx`) and the Visualize sheet all reach `render-chart.ts` (`enhance-chart.ts` calls it "the one renderer every door shares"). A change to the header there reaches all of them. **(verified by reading the importers; not every call path was traced)**

**[F03] The figure is an SVG string whose look belongs to the page.** `compile_round` in `tuggraphics-wasm` returns `round.svg`, landed with `innerHTML`. Its colours are role classes the theme's CSS resolves and its text is set in the deck's web faces. The Rust side has a standalone mode (`draw/svg.rs`, `standalone: Option<&Palette>`, one `<style>` resolving the classes), which `tugtool chart render --out` uses, but the wasm surface in `load-tuggraphics.ts` does not expose it. **(verified)**

**[F04] Turn sharing already renders PDF and PNG.** `tugapp/Sources/ShareRenderer.swift` loads the share page (`tugdeck/src/share/share-main.ts`) in a hidden `WKWebView`, takes `shareRenderReady { id, height }`, and writes a PNG from tiled snapshots at the backing scale or a single-page vector PDF from `createPDF`. The page side is `shareRender(format, document)` in `tugdeck/src/lib/os-share.ts`. **(verified)**

**[F05] The exits exist too.** `MainWindow.copyShareFile` writes the rendered file to the pasteboard as `.pdf` or `.png` together with a plain-text flavour (`declareTypes([type, .string])`). `presentShareSave` runs the save panel, `presentSharePicker` the system share picker, and `SharePreviewSheet` stands in front of all three. Each refuses a path that `ShareRenderOutput.isRenderedArtifact` does not recognise. **(verified)**

**[F06] The share path is fixed at 720 points and at turns.** `ShareRenderDocument` requires `width: 720`, a `header`, `turns`, `turnNumbers` and `offerRuns`; `decodeShareRenderDocument` returns `null` for anything else, and the page then posts nothing until the host's 60 s deadline answers `failed`. `ShareRenderer.width` is a constant used for the view's frame, the PDF rect, the bitmap and every tile. `SharePreviewSheet` sizes itself from `ShareRenderer.width` and its comments assume a 720-point page. **(verified)**

**[F07] A render costs seconds, most of it a font wait.** `ShareRenderer.swift` records 2.4 to 4.4 s per render on 2026-11-13 and attributes about 2 s of each to the share page's bounded wait on fonts that never load. `share-main.ts` has `FACE_HORIZON_MS = 2000`. **(read from the recorded figures and the constant; not re-measured, and why the faces never load was not investigated)**

**[F08] The figure can draw its own title.** `ChartCompileOpts.figure_title` exists; the deck passes `false` because the block header shows the title instead. **(verified)**

---

## Decisions {#decisions}

**[B01] A figure is exported through the share renderer, as a new kind of share document.** The share page mounts one figure through `render-chart.ts` itself, so the image has the card's fonts, theme and layout by construction ([F03], [F04]). The document carries the theme, the spec source and its layers, and nothing about turns. An in-page rasteriser (SVG to canvas) was rejected: an SVG drawn as an image cannot load the page's web faces, and it cannot make a PDF.

**[B02] The figure export is drawn at the figure's own width, not 720.** The page reports a width beside the height, and the host sizes the view, the PDF rect and the bitmap from the report ([F06]). A chart is drawn at its spec's or its form's default width, a diagram at its natural width, each with a margin on the block's ground. `SharePreviewSheet` takes the artifact's size instead of assuming the column.

**[B03] The exported figure draws its title.** `figure_title: true` ([F08]). An image leaves the card without the block header, and a figure whose title states its finding is half a figure without it.

**[B04] A diagram's keyed table rides along; a chart exports the figure alone.** The numbered discs on a diagram refer to the table beneath it and mean nothing without it. A chart's Table view is an alternative reading of the same data, not part of the picture.

**[B05] The header's Copy button copies the picture.** It renders a PNG and writes it to the pasteboard with the spec as the plain-text flavour, which `copyShareFile` already does for a share ([F05]). Pasting into a mail, chat or slide app gives the figure; pasting into a text editor still gives the source, so the old behaviour survives the change. The button's label changes to match. PNG is the copy format because it pastes everywhere, where a PDF pastes as a vector in only a few apps.

**[B06] A second header button, Share, opens the existing preview sheet for the figure.** The sheet offers PNG or PDF and its Copy, Save… and Share… exits. This is where the PDF lives. Putting both a PDF and a PNG on the pasteboard at Copy was rejected: it is two renders per press.

**[B07] The image is drawn in the user's current theme, on the block's own ground.** The same call turn sharing makes. No light or print variant.

**[B08] Where no host can render, Copy copies the source as it does today.** In a plain browser `isShareAvailable()` is false; the button keeps its present behaviour and label there, and Share is absent. A figure that did not draw ([F01], `showUndrawn`) keeps "Copy source" too: there is no picture to copy.

**[B09] The font wait is fixed in this work.** A Copy press that takes two or more seconds reads as a broken button ([F07]). The work finds why the share page's faces never load and removes the wait, or bounds it for a figure document; whichever it is, the button shows a busy state while a render is out. Turn sharing gets the same gain.

---

## Open Questions {#open-questions}

- **What does Copy do on the share page and in a thumbnail?** A thumbnail has no header, and the share page draws figures inside shared turns where no report can be answered. The expectation is that neither offers the button, but the share page's context was not read closely enough to say so as a decision.

---

## Non-goals {#non-goals}

- **SVG export.** The standalone mode exists in Rust but not in the wasm, and the deck's faces would not travel with the file ([F03]). Worth its own look later.
- **`tugtool chart render` writing PNG or PDF.** That is the CLI, with no web view; it would need a rasteriser dependency. This work is the Session card's button.
- **A light or print theme for the export.** [B07].
- **Exporting a chart's Table view.** [B04].

---

## Exit {#exit}

**An arc.** Its raw material, in the order the pieces depend on each other:

- The figure document: its shape, its codec beside `decodeShareRenderDocument`, and the share page mounting it and reporting width and height ([B01], [B02], [B03], [B04]).
- The host taking a reported width: `ShareRenderer` and `SharePreviewSheet` off the 720 constant for a figure ([B02], [F06]).
- The font wait ([B09]), before the button, since the button's feel depends on it.
- The header: Copy as picture with the source as text, the Share button, the busy state, and the fallbacks ([B05], [B06], [B08]).
- An app-test that copies a diagram and reads a PNG off the pasteboard, and one that saves a PDF.

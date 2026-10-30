<!-- brief-skeleton v1 -->

# A graphics language for Tug, and a charting library on top of it

**Purpose:** Tug has no way to draw an information graphic in the transcript or on a card. The model has only prose and tables, and the one diagram engine the deck ships, mermaid, produces graphics nobody wants to look at. What is wanted is a general-purpose 2D graphics language that the deck owns, a charting and information-graphics library built on it, and the hinting that gets the model to reach for a chart at the right moment.

---

## Purpose {#purpose}

The user's framing, across two conversations:

> "I'm mostly thinking about graphs and charts, i.e. not pictures/images, but information graphics."

> "What I really would love here is a *graphical language*. Think of *turtle graphics* or the old v1.0 Adobe Illustrator file format. We could draw *anything*. A general-purpose 2D graphics language. We could then build a charting and information graphics library on top. Once we have that in hand, then we could figure out how to hint the model to use the library in the right places. Obvious applications are statistics for git commits, arcs, code line counts, perf charts for tests, and more."

And on the incumbent: "I *hate* mermaid with the fire of a thousand suns. I have *never ever ever* seen a mermaid graphic that's good."

The work is three layers: a drawing language the deck renders, a chart compiler that turns data into that language, and the doors and prompt doc that put charts in front of the model and the tools. The whole point is that a chart should look drawn by the same hand as the arc track and the status cells, which only a renderer that reads Tug's own tokens can deliver.

---

## Evidence {#evidence}

**[F01] The transcript already has the fence-promotion pipeline this needs.** Fenced code blocks pass through the block-transformer registry in `tugdeck/src/lib/markdown/block-transformers/index.ts`; `mermaid.ts` there promotes a ` ```mermaid ` fence to a `tug-mermaid` body kind only once the source is complete, so a half-streamed diagram never renders as a parse error, and the `MermaidBlock` body kind renders it inside an error boundary. The registry's own comment anticipates "future fences for the others." A new fence is a new transformer plus a body kind, following that template. **(verified)**

**[F02] Mermaid's information graphics are not acceptable, and the model is never told they exist.** The previous session rendered mermaid's best case live in the transcript, with a theme directive: an `xychart` bar-and-line, a pie, and a quadrant chart. Typography does not sit on Tug's type scale, the bar chart has no legend, no series names and no value labels, the theme directive reaches only some knobs so the palette never reads as the deck, and every stroke shows the flowchart heritage. Separately, nothing in `tugplug/` mentions fences, so the model does not know the card renders mermaid or math at all. **(verified by rendering; the user judged the result and confirmed the premise)**

**[F03] The deck already measures text against the face that renders it.** `tugdeck/src/lib/font-metrics.ts` builds a canvas measurer from an element's computed style and waits on `document.fonts.load` for that specific face, closing the trap where `document.fonts.ready` resolves against an empty queue. Exact label metrics are therefore available to a chart compiler running in the deck after face load. **(verified)**

**[F04] Rust compiled to WASM is an established shape in the deck.** `tugdeck/crates/` holds `tugmark` and `tugmark-wasm` (the markdown lexer, `cdylib` via `wasm-bindgen`) and `tugdiff-wasm`, built by `scripts/build-wasm.sh` under the `just wasm` recipe, with the convention written in `tuglaws/wasm-crates.md`. A graphics crate takes the same route. **(verified)**

**[F05] Structured stdout blocks are already how a tool talks to the card.** `TUG-FILE-RECEIPT: ` is a marker constant in `tugrust/crates/tugcast/src/feeds/attribution.rs` that tugcast reads out of a tool result's output, and the Bash tool block in `tugdeck/src/components/tugways/cards/blocks/bash-tool-block.tsx` renders receipts. A chart block in stdout has a precedent for both the marker and the card-side reader. **(verified)**

**[F06] Motion tokens and a motion breaker already exist.** The theme files carry named durations (`--tug-motion-duration-fast`, `moderate`, `slow`, `glacial`) multiplied by `--tug-timing`, and named easings for enter, exit and standard. The deck has a hand-operated motion demotion switch and reduced-motion handling. CSS animations driven by those tokens inherit all of it with no code. **(verified)**

**[F07] The deck's existing sparkline is a canvas instrument, not a document graphic.** `tugdeck/src/lib/sparkline-instrument.ts` paints a live activity tape on a canvas, on a worker where the platform allows. It is the wrong base for a static document graphic that must restyle under a theme switch and be searchable, but it is proof that a Tug-drawn figure can read as part of the deck. **(verified)**

**[F08] Several data sources are already ledgers a verb can read.** Commit and change statistics (`changes.db`, read by `tugtool changes`), test runs and wall times (`tugtool test last`, `apptest_results.db` via `tugtool apptest history`), report gaps (`tugtool report gaps`), and arc step state (`tugtool arc`). None of them needs new collection; each needs an output shape a chart can consume. **(verified by the verbs' existence; the exact fields each would chart were not read)**

---

## Decisions {#decisions}

**[B01] Layer 0 is a drawing language that is a file format, not a program.** This is the design stolen from Illustrator 1.0, whose file was PostScript with the interpreter removed: a fixed operator set in sequence, with no variables, no loops, no arithmetic and no procedures. It keeps the renderer a parser rather than an interpreter, so rendering is bounded, safe, and identical everywhere. Anything that needs computing is a layer 1 form or is computed by a tool before it is written down. The operator groups are path (`move`, `line`, `curve`, `arc`, `close`, with `rect`, `circle`, `polyline` shorthands), paint (`fill`, `stroke`, `width`, `dash`, `opacity`), text (`text` with anchor, baseline and a type role), structure (`group` with translate, scale, rotate, clip), and a turtle group (`pen`, `forward`, `turn`) whose heading state accumulates into the current path. No raster, no filters, no gradients. Coordinates are y-down in a declared `frame`, since that is what every model and tool already knows from SVG and canvas; the chart compiler is the only party that cares about axes.

**[B02] Both layers are JSON.** The model is better at emitting JSON than an invented line syntax, and a tool naturally emits JSON, so one encoding serves every author and no hand parser is maintained. A layer 0 program is an object with a `frame` and an `ops` array, each op an array with the verb first and an options object last. A layer 1 spec is an object naming a form and carrying its series, labels, unit and annotations. The exact schemas are the arc's to write; what is decided is the encoding and that there are exactly two.

**[B03] Color operands are tokens, never literals.** The language names roles (`ink`, `ink-muted`, `grid`, `accent`, `good`, `bad`, `series-1` through `series-8`) and the theme engine supplies the ink. A hex literal is not in the grammar. The rendered SVG carries CSS variables for every role, so a theme switch restyles a chart already on screen without a re-render, and dark and light come for free. New viz tokens land in all ten theme files, the contrast audit (`bun run audit:theme-contrast`) is extended to cover them, and ironclad is the exemplar per the theme doctrine. This is the decision that makes a chart look like Tug rather than like a chart pasted into Tug.

**[B04] Text carries a type role, not a font.** Roles come from the deck's type scale (`label`, `title`, `mono` and whatever the scale names). The renderer resolves a role to the deck's face and size, so a chart's type is the deck's type by construction.

**[B05] Layout uses exact measurement, and the compiler takes a measurer as an input.** An estimate scheme was proposed and rejected by the user: "We need to *know* where text will go and what its size is." The compiler is a function of the spec and a measurer that returns width, ascent and descent for a text and role. In the deck the measurer is the face-aware one in `font-metrics.ts` [F03], and compile never runs before the face is loaded. In tests the measurer is a fixed-metric table, so golden SVGs are deterministic. Truncation, label collision avoidance and axis margins are exact.

**[B06] The compiler and renderer live in one Rust crate, compiled to WASM for the deck.** The user chose Rust over TypeScript. The reason is portability, not performance: a chart is a few hundred ops and compiling it in either language is microseconds. One implementation serves the deck through WASM [F04], `tugtool` writing an SVG to a file, and any site or document build that wants the same figures. The measurement contract [B05] is what makes this work across the boundary: the WASM compiler receives a pre-measured table for the labels it is about to lay out, supplied by the deck, and a standalone `tugtool` render measures against the bundled face with a Rust font library. The crate goes under `tugdeck/crates/` beside `tugmark`, built by the existing WASM recipe.

**[B07] Animation is a property on an op, drawn from a closed set, and never a program.** This keeps [B01] intact while adding what the user called spice. Any op may carry `enter`, one of `draw` (a stroke revealed along its length), `grow` (a bar rising from its baseline), `fade`, or `rise`, plus a `delay`; the chart compiler assigns a stagger across a series. Durations are named motion tokens [F06], never milliseconds, so timing matches the arc track. The implementation is CSS animations on the SVG elements over transform, opacity and dash offset only: no timers, no React state, nothing lands mid-motion, and reduced motion and the motion breaker apply by construction. Transitions between two data states are explicitly deferred.

**[B08] Charts are otherwise static.** No hover, no inspection state in version one. The spec carries its data, so the text alternative is a table toggle on the body kind, and transcript search indexes the labels and values, as mermaid source is indexed today. This honours the state-preservation law and keeps the first version small.

**[B09] One body kind, reached through three doors.** A `tugchart` fence in the model's prose, promoted on completion by a new block transformer following the mermaid template [F01]. A `TUG-CHART` structured block in tool stdout, recognized the way `TUG-FILE-RECEIPT` is [F05] and rendered by the Bash block beneath the output, so a tool can chart five hundred rows the model never retypes. And card instruments with no author, such as a wall-time sparkline beside an app-test result table, drawing from the same renderer. The three share the compiler, the renderer, the tokens and the body kind, so there is nothing for them to disagree about.

**[B10] Only the `tugchart` fence is given to the model in version one.** The user's call: "only tugchart for now. let's see how that goes." Layer 0 exists and tools may write it, but the model is not taught a `tugdraw` fence and no transformer promotes one. The drawing door is the one most likely to produce ugly freehand figures before the chart door has shown what good looks like. Revisit once the chart door has been observed in use.

**[B11] The first form set is closed and has no pie.** Bar in horizontal, vertical, stacked and grouped; line and area; sparkline; dot strip; histogram; a span strip for durations such as arc steps or the files of a run; a heat strip for counts by day; a range or bullet for a value against its history. Each form is one function from data to a layer 0 program, and layout arithmetic lives in these functions and nowhere else. The model never positions a bar.

**[B12] The first data verbs are commit statistics and test history.** Commit and change statistics from the changes ledger and test wall times from the test ledger [F08], each with a `--chart` flag that emits a layer 1 spec as a `TUG-CHART` block. These two are chosen because the data already exists, both are things the user asked for by name, and together they exercise bar, line, sparkline and dot-strip forms. Arc step durations and report gaps follow once the shape is proven.

**[B13] Hinting is one plugin doc, written last.** A `tugplug/graphics.md` riding every session's system prompt beside the other files in that directory, as the standalone contract requires. It carries the `tugchart` schema, the token and role names, the form list, the rule that a chart carries one message and labels directly, and the repertoire with the data verb for each: commits per day on a branch, lines added and removed per crate, arc step durations, test wall-time trend, app-test history as a good-and-bad dot strip, report gaps as horizontal bars. The `dataviz` skill's form heuristics are the source to compress. It is written last because it points at forms and verbs that must exist first, and because the question it answers, whether the model reaches for a chart when told it can and picks good moments, can only be read after it ships.

**[B14] Order of landing.** Layer 0 renderer with golden SVG tests first, since it is small and pure. Then the WASM build and the deck-side measurer bridge. Then layer 1 with three forms over the two data verbs [B12], the fence transformer and body kind, and the stdout block. Then the remaining forms. Then the plugin doc. Mermaid is removed once the chart fence lands, not before, so the transcript is never without a figure path.

---

## Open Questions {#open-questions}

- **The exact JSON schemas for both layers.** Decided in encoding and shape [B02], not in field names. The arc writes them, and the layer 1 schema is the one the plugin doc must teach, so it should be settled before any form is built.
- **Which Rust font library measures text for a standalone `tugtool` render.** The deck path needs none [B05]. The standalone path needs one that reads the bundled face and agrees with the browser closely enough that an SVG written by `tugtool` and one compiled in the deck lay out the same. Candidate crates exist; none was evaluated.
- **The viz token set and its contrast budget.** How many series tokens the ten themes can carry at the ironclad accessibility budget is a question for the audit, not for this brief. Eight is the proposal; the audit may say six.
- **Whether mermaid's removal takes KaTeX's lazy-load plumbing with it.** Mermaid and math share the lazy-load and promotion pattern. Removing the mermaid transformer, body kind, walker and dependency should leave math untouched, but the shared pieces were not traced.

---

## Non-goals {#non-goals}

- **Documenting or theming mermaid.** Rendered live and judged unacceptable [F02]. No plugin doc will tell the model it exists, and no `themeVariables` map will be built. The mermaid path is removed, not improved.
- **Vega-Lite or any adopted chart library.** Considered as the fallback if a closed form set proved too small. Rejected because a large lazy chunk and a style you fight rather than own cannot meet [B03]; the point is token sovereignty.
- **A raw `svg` fence.** DOMPurify could sanitize one cheaply, but models lay out hand-drawn figures badly and the tokens stream slowly. It is not a door.
- **A `tugdraw` fence for the model in version one.** Deferred by [B10], not rejected forever.
- **Arithmetic, variables, loops or procedures in layer 0.** Ruled out by [B01]. Computation belongs in a form or a tool.
- **Literal colors or fonts anywhere in either grammar.** Ruled out by [B03] and [B04].
- **Hover, tooltips, data-to-data transitions, or any interactive state.** Deferred by [B07] and [B08].
- **A canvas or worker renderer.** The existing sparkline instrument [F07] is the right thing for a live tape and the wrong thing for a document graphic that must restyle under a theme and be searchable. Charts render to SVG.
- **A TypeScript compiler.** The user chose Rust [B06]. The JSON spec and the golden SVGs are the seam that would make a port possible later, but none is planned.

---

## Exit {#exit}

**An arc.** Its first steps in the order they must land:

1. The graphics crate under `tugdeck/crates/`: layer 0 parser and SVG renderer, tokens as CSS variables, the measurer interface, golden SVG tests with a fixed-metric measurer.
2. The WASM build of the crate via the existing recipe, and the deck-side bridge that measures labels with the face-aware measurer and hands the table across.
3. Viz tokens in the ten theme files, the contrast audit extended, ironclad first.
4. Layer 1 with bar, line and sparkline forms; the `tugchart` block transformer and body kind with the table toggle; entry animation over the motion tokens.
5. The `TUG-CHART` stdout block, read by tugcast and rendered by the Bash block, with `--chart` on the changes and test verbs.
6. The remaining forms from [B11], then mermaid's removal.
7. `tugplug/graphics.md`, and a reading of whether the model uses it.

Each step has a fast layer, the crate's goldens and the deck's unit tests, and a slow one, a single app-test selection over the body kind and the Bash block, run once as the verdict.

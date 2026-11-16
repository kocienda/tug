<!-- brief-skeleton v1 -->

# Code explainers: diagrams of code, drawn by the chart engine

**Purpose:** Tug can chart data but cannot draw a picture of how code works. What is wanted is a small set of beautiful, concise diagram forms, each paired with a keyed table that points into the code, so a reader can take in one flow through a project without stitching it together from paragraphs.

---

## Purpose {#purpose}

The request came from Tito Ciuro, who sent a page from his own workflow: a figure of how one service keeps its users apart, with a caption reading its colours and a table beneath keyed by number to the marks in the figure. His words:

> "Being new to a project can be daunting. IMHO, getting to know the main flows in a graphical manner helps me absorb the project better because I can see not one, but the different flows worth knowing. Text alone can be too much sometimes. Seeing a flowchart (even ASCII) helps me understand faster because I can concentrate on the main points, not having to 'stitch' info from different paragraphs in order to find the sense of it."

> "Oh, and the 'Where it is' shows me where it's in the code. Quite powerful."

> "It comes a time when I simply don't remember some of the details. These focused views of the project lets me refresh my memory (or learn stuff I had no idea how it was implemented!)"

The user's framing of the work: "a project explainer. For this, I think we'll need to revise and extend our graphics-generation code that we put recently (the Illustrator v1-inspired declarative work). The idea is to come up *beautiful, concise, and informative* diagrams of code."

A design spike was then built and revised once. After the second rev the user said: "These are *amazing*. Brief this. Preserve the spike for now. We might want to refer back to it as we implement and try this for real."

---

## Evidence {#evidence}

**[F01] The unit that works is a figure plus a keyed table, not a figure alone.** Tito's page has a numbered title, a figure, one caption sentence reading the colours, a short lead, and a table whose rows are keyed by number to marks in the figure and carry a "where it is" column. The spike reproduces that stack for five subjects, and the user accepted it. **(verified by the spike; the user judged it)**

**[F02] Layer 0 needs no new operator to draw these figures.** The spike's four forms emit ordinary `tugdraw` programs: rounded `rect`, `circle`, `move`/`line`/`curve`, `dash`, `opacity`, `text`, and `group` with `translate` and `rotate` for upright text. Arrowheads are filled three-point paths. All five subjects validate and render through `tugtool chart render` and through `render_program` in `tuggraphics-wasm`. **(verified)**

**[F03] A figure with no coordinates in its spec reaches Tito's figure.** The benchmark subject restates his figure as three columns, two boxes with rows, and four edges, with no x or y anywhere. The `flow` form lays it out with zero edge crossings, including the dashed refusal that loops back underneath. The author gives column order and order within a column; the form computes sizes, gaps, ports, lanes and routes. **(verified)**

**[F04] The four type roles are one short.** `TypeRole` in `tugdeck/crates/tuggraphics/src/measure.rs` is `title`, `label`, `value`, `mono`. A row name inside a box wants a semibold at label size; the only semibold is `title`, one size up. The spike sets row names in plain `label`. **(verified, read)**

**[F05] The measure contract carries the font box only, which cannot centre a digit in a disc.** `Metrics` is advance width plus font-box ascent and descent. A number centred by the font box sits low in a key disc. The spike reads the glyph's actual bounds from the page canvas (`actualBoundingBoxAscent` and its siblings) and places the number by those. This placement was not confirmed visually: the headless check used an approximate measurer, and nobody has yet reported how it looks on the deck. **(the gap is verified by reading the code; the fix is unconfirmed)**

**[F06] There is no text wrapping.** Every label in every form is one line, so long names make wide figures. The edit-gate flow comes out about 1,190 px wide. **(verified)**

**[F07] Two more semantic colours can be had without new theme ink.** `ColourRole` today is `ink`, `ink-muted`, `grid`, `surface`, `accent`, `good`, `bad` and `series-1` to `series-8`. Every theme file already carries tone tokens the chart roles do not use: `--tug7-element-tone-fill-normal-caution-rest` and `--tug7-element-tone-fill-normal-data-rest` among them (also `agent` and `active`). The spike writes the two proposed roles as `series-7` and `series-8` and repaints those two classes from the caution and data tones inside its own figures. Whether those tones pass the chart contrast budget on the content surface in all ten themes was not checked. **(the tokens are verified in `ironclad.css` and `sloop.css`; the contrast is not)**

**[F08] The delivery path exists.** The `tugchart` fence transformer, the `ChartBlock` body kind, `renderChartInto`, the measure protocol, the table alternative, Find text, hover hit regions and entrance animation are all in place for charts. Hit regions name a table row, which is what a keyed diagram mark needs. **(verified, read)**

**[F09] The spike's layout code is TypeScript and is not the implementation.** The forms live in `tugdeck/src/spikes/spike-code-explainer-layout.ts` so they could be changed without a WASM build. They do the measuring in one pass against a synchronous measurer, which the WASM engine cannot do: it runs the round-based measure protocol. **(verified)**

**[F10] Edge crossings are cheap to count.** The spike counts strict crossings between the axis-aligned runs of different edges and reports the number under each figure. All five subjects read zero. **(verified)**

**[F11] Whether the Text card's Markdown preview renders chart fences was not checked.** The preview landed in `656188211`; nothing in this conversation read whether it runs the same fence pipeline as the transcript. **(not verified)**

---

## Decisions {#decisions}

**[B01] Diagrams are a sibling spec, `tugdiagram`, in the same crate as `tugchart`.** A `diagram` module beside `chart` in `tuggraphics`, compiled to the same layer 0, rendered by the same body kind, with its own fence. It is separate from `tugchart` because the chart fields (`unit`, `format`, `series`) mean nothing here, and unknown keys being errors only stays useful when the two do not share a schema.

**[B02] There is no general graph layout.** A diagram is one of a closed set of forms, as a chart is. The author gives names, relations and order; the form gives every coordinate. A spec has no x and no y. This is the same rule as "the model never positions a bar", and it is what separates these figures from Mermaid's [F03].

**[B03] The first form set is four: `flow`, `sequence`, `layers`, `stack`.**

- `flow`: columns of boxes left to right, a box may hold rows, edges route themselves. Forward edges run straight wherever one end is free to meet the other; anything else turns in a lane or loops underneath.
- `sequence`: actors across, messages down, replies dashed, a self-message as a short loop.
- `layers`: full-width strata top to bottom with a label on what crosses each boundary.
- `stack`: the plain architecture block diagram. Layers ruled on a column grid with names in the left margin and rows of cells inside; a layer may span part of the grid; outside blocks above and below reach the first layer in their way; cross-cutting bars with upright text run down the side.

`layers` and `stack` overlap. Both are kept for now because `layers` says what crosses each boundary and `stack` says what is outside and what cuts across.

**[B04] The accent is spent on key discs and nowhere else.** The user's note on the first rev: "There's too much accent color. We need to limit to just the discs." Boxes that hold things are neutral, and names are ordinary ink.

**[B05] A key is a disc, level with the top of what it numbers, with its number centred by its ink.** In a row or cell the disc sits on the first text line, not the row's middle. In a sequence it sits on the label's line, not the arrow's. In a centred stack cell it sits in the box's top-left corner. There is no inline-number variant.

**[B06] Two semantic roles are added: `caution` and `outside`.** `caution` is the outcome between good and bad: allowed but degraded, a fallback, a retry; in a chart, a run past its budget or a stalled item. `outside` is a place and never an outcome: what lies beyond the system the figure explains; in a chart, a context series from elsewhere. They are painted from the themes' existing caution and data tones [F07], and they are roles of the whole graphics language, so charts get them too. `good` and `bad` stay reserved for outcomes.

**[B07] The keyed table is part of the figure and is shown by default.** Each keyed mark has a row: number, name, what it does, where it is. It is the diagram's table alternative, and unlike a chart's it is on screen with the figure, not behind a toggle. The "where it is" cell is a live file reference through the existing resolver.

**[B08] A `where` that does not resolve is shown as unresolved.** The risk in a code explainer is invented structure. A location the resolver cannot confirm renders with a visible mark, never as a working link.

**[B09] The compiler refuses a figure that would be ugly.** Each form carries a budget for nodes and edges, caps on name length measured exactly, and a bar on edge crossings [F10]. A spec over a bar is an error that says to split the figure in two. The numbers are the arc's to set against the spike's subjects.

**[B10] The measure contract gains ink bounds.** Centring a number in a disc needs the drawn shape of the string, which the font box does not give [F05]. The contract grows by the ink box for the strings a form asks it for, and the deck, the standalone face measurer and the fixed-metric test measurer all answer it.

**[B11] The door is an `/explain` skill in `tugplug`.** It carries the template from [F01]: one question per section, a title that states the finding, figure, one caption sentence, a short lead, the keyed table. Given a subject it explains that subject. It ships in the plugin, so it works on any project, per the standalone contract. The prompt doc that teaches the fence is written last, as the chart doc was.

**[B12] The spike stays.** `spike-code-explainer.tsx`, `spike-code-explainer-layout.ts`, `spike-code-explainer-subjects.ts`, `spike-code-explainer.css` and their two lines in `spike-registry.tsx` are the reference for layout and look while this is built, and no step of the arc deletes them. Its five subjects are the natural goldens for the Rust forms. It graduates or is deleted after the real forms have been judged against it.

---

## Open Questions {#open-questions}

- **Rounded elbows or curves for forward edges?** The spike offers elbow, rounded and curve. Rounded is its default and what the user saw first, but the user has not picked one. The spike's Routing control settles it.
- **Tinted or plain for boxes that hold things?** The neutral tint is the default the user praised; plain is still on the control. Same door.
- **Is `outside` the right second colour, or `agent`?** `agent` (the violet tone) would mean "what the model does, versus what you or the code does". `outside` was chosen because every architecture diagram has externals. The user accepted the rev without choosing between them explicitly.
- **Do the caution and data tones pass the chart contrast budget in all ten themes?** Not checked [F07]. `bun run audit:theme-contrast` extended to the two roles settles it; a failing theme means tuning that theme's tone or giving the role its own token.
- **Does one more type role land, and what is it called?** [F04]. A semibold at label size would let a row name carry weight without colour. Whether the figures need it now that keyed names are plain ink is a look question for the spike.
- **How does text wrap?** [F06]. Wrapping by measured words means more rounds of the measure protocol than the current limit of three calls, or a different shape of request. This changes what gets written in the compiler.
- **Where does a kept explainer live, and does the Text card render it?** The sketch proposed a Markdown file in a project `explainers/` directory, viewed in the Text card's preview. [F11] is unverified, and the directory was never confirmed by the user.
- **Does a kept explainer record the commit it was drawn at?** The sketch proposed it, with a `tugtool` verb that says which `where` paths have changed since. It was not discussed further.

---

## Non-goals {#non-goals}

- **A general graph layout, or any Mermaid-like auto-layout.** Ruled out by [B02]. Layout by a closed set of forms is the whole idea.
- **Diagram forms inside `tugchart`.** Rejected by [B01]; the two specs share a crate and a body kind, not a schema.
- **A `tugdraw` fence for the model.** Still deferred, as in the graphics language brief. A diagram is a form, never freehand layer 0.
- **Accent on boxes, borders or names.** Ruled out by [B04].
- **Inline key numbers.** The first rev offered them; the second removed them [B05].
- **A state-machine form and an annotated tree form.** Named in the sketch as the obvious next two. They wait until the first four are in use.
- **A project tour.** `/explain` with no subject, proposing the five to eight flows worth knowing in a project, was sketched and is a later piece of work than the forms and the single-subject skill.
- **Shipping the spike's TypeScript layout.** It is a prototype [F09]. The forms are written in Rust beside the chart forms.

---

## Exit {#exit}

**An arc.** Its first steps, in the order they must land:

1. The two colour roles [B06] in `tuggraphics`, the deck's chart stylesheet and the standalone palette, with the contrast audit extended to them. This is small, serves charts at once, and removes the spike's `series-7`/`series-8` stand-ins.
2. Ink bounds in the measure contract [B10], answered by all three measurers.
3. The `diagram` module: the spec, validation with errors addressed by JSON pointer, and the `flow` form with goldens taken from the spike's benchmark and edit-gate subjects.
4. The `tugdiagram` fence, the body kind's keyed table [B07], and unresolved-location marking [B08].
5. `sequence`, `layers` and `stack`, each with a golden from its spike subject, and the refusal bars [B09].
6. The `/explain` skill and the prompt doc [B11].

The spike is read beside every form step and is not touched [B12]. The open look questions (routing, tint, the second colour) are answered in the spike before step 3 fixes them in Rust.

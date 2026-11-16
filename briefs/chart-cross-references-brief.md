# Chart cross-references

**Purpose:** A chart names files, commits, sessions and arcs, and none of them can be reached from it. The data in a chart should link to the content it was computed from or mentions, and the chart and the prose beside it should point at each other.

---

## Purpose {#purpose}

The request, made on 2026-11-16 against a post on X: "Let's figure out how to *hyperlink and cross-reference* the data in a chart with the relevant content used or mentioned in the chart," for "all the chart types everywhere it makes sense."

Today a chart is a dead end. The `commits` recipe draws a 57-commit bar and the reader cannot get to one of the 57. The `hotspots` recipe prints a row per file and the row is not the file. The `test-history` recipe shows a red dot and nothing says which run or which commit it was. Every one of those entities is something the rest of the transcript already links, with one rule and one menu per kind.

The post itself was never read: the agent fetch was refused and `WebFetch` returned HTTP 402 for the x.com URL. Everything below rests on the one-sentence description in the request.

---

## Evidence {#evidence}

**[F01] Every mark is already addressed into the chart's table.** The compiler writes an invisible `.tgh` path per mark with `data-row` and, where one value is the mark's own, `data-col` (`tugdeck/crates/tuggraphics/src/draw/svg.rs:204`, `chart/build.rs:135`). `tugdeck/src/lib/chart/chart-hover.ts` holds no numbers: its bubble reads the row out of the same `ChartTable` the Table view shows. **(verified, read)**

**[F02] The table is `{caption, head, rows}` of strings, built from the spec alone.** `tugdeck/crates/tuggraphics/src/chart/table.rs`. Each form has natural columns; a sparkline has a table but no title and no hover targets worth a link. `find_text` is the caption, head and rows joined, and it is what transcript Find counts. **(verified, read)**

**[F03] Diagrams already cross-reference, by the mechanism charts lack.** A `tugdiagram` key carries `where`; `buildKeyedTable` in `tugdeck/src/lib/chart/render-chart.ts` writes it as inline `<code>`, and `enhanceChart` (`tugdeck/src/lib/markdown/enhance-chart.ts`) runs `annotateElement` over the landed figure with the block's `AnnotationContext`, so a confirmed location becomes the same file link prose gets and a late verdict re-marks it. **(verified, read)**

**[F04] Only the fence door has an annotation context.** `enhanceChart` receives one; `ChartBlock` (`tugdeck/src/components/tugways/body-kinds/chart-block.tsx`) takes `source`, `layers`, `className`, `findable`, `thumbnail` and nothing else. Recipes arrive as `TUG-CHART:` lines through the Bash block, which mounts `ChartBlock`, so the door that carries nearly every computed chart cannot resolve anything today. **(verified, read)**

**[F05] The entity doctrine already answers what a ref in a spec field is.** `tuglaws/entity-presentation.md`: a value that arrives in a slot is *placed* and renders as an atom; the resolver is the one gate; the underline is the one resting affordance and a resting tint is retired; `tugdeck/src/lib/annotator/registry.ts` owns the click and the menu per kind. **(verified, read)**

**[F06] The annotator has ten kinds and no arc kind.** `AnnotationKind` in `tugdeck/src/lib/annotator/types.ts`: `url`, `email`, `slash-command`, `shell-command`, `file-path`, `directory`, `image`, `commit-sha`, `session`, `help`. A commit's primary act is its Commit card (`tugdeck/src/lib/open-commit-in-card.ts`). **(verified, read)**

**[F07] History has no range entry.** The History shade's filter is a text query matched over four aimable surfaces, hash, message, detail and files (`tugdeck/src/lib/commit-filter-scope.ts`, `session-history/history-list.tsx`). Nothing takes a commit range or a list of shas. Whether the shade can be opened with a seeded query from outside was not checked. **(verified for the filter, read; the seeded open is unchecked)**

**[F08] The app-test ledger records the commit of every run.** `runs` carries `head_sha`, `dirty` and `branch` (`tugrust/crates/tugtool-core/src/apptest_ledger.rs:62`), so a `test-history` dot can name the commit its run stood on. **(verified, read)**

**[F09] An arc's timeline carries no commit per step.** `StepSpan` is `start_ms`/`end_ms` and `ArcTimelineStage` is stage, time and model (`tugrust/crates/tugarc-core/src/timeline.rs`, `tugcast-core/src/types.rs`). A step's commit and a stage's session would have to be read from elsewhere in the arc record; where was not looked for. **(verified for the timeline, read)**

**[F10] The recipes hold the entities and drop them.** `tugrust/crates/tugchart-core/src/commits.rs` buckets `LogEntry` values by day, week, hour, weekday and subject prefix and emits counts; `hotspots_chart` and `landed_rows` clip paths into labels (`clip_front` in `context.rs`), so a label is not a usable path. **(verified, read)**

**[F11] WebKit's handling of `text-decoration` on SVG `<text>` is unverified.** Nothing in the chart sheet uses it today. A one-line probe in the gallery settles it.

---

## Decisions {#decisions}

**[B01] A chart spec carries refs, and a ref is a typed string.** `commit:63de5762a`, `file:tugdeck/src/app.ts`, `dir:tugdeck/src/lib`, `session:tug/mighty-cabin`, `arc:code-explainers`, `url:https://…`, `command:just app-test`. The spelling is the one the atoms already show (`commit:<8ch>`, `session:<8ch>`), so the spec, the label and the clipboard agree. A ref is separate from a label because labels are clipped and a ref has to hold the whole value [F10]. An unknown prefix is a validation error with a JSON pointer, like any other spec error.

**[B02] Refs attach where the table has a row, a column or a cell.**

| Form | Ref slots |
|---|---|
| `bar`, `line`, `area`, `heat` | each category (row), each series (column), each value (cell) |
| `dots` | each row, each dot |
| `spans`, `bullet` | each item |
| `scatter` | each point |
| `histogram` | each sample; a bin's refs are its samples' |
| annotations | a `mark` |
| `sparkline` | none |

A slot is optional everywhere, so every spec written today stays valid.

**[B03] A slot holds one ref or a set of one kind, and a set is always one atom.** A 57-commit day is `57 commits`, a single atom whose act opens a list of its members; it is never 57 atoms, in the figure, the bubble or the table. The set is spelled as its members, not as a range, because a range can say "this day" but not "the `tugdeck` commits this day" or "everything committed at 7am" [F10], and the same shape then serves sessions per day and arcs per week. A cap per slot bounds the spec; past it the slot carries the count alone and the atom has no act.

**[B04] The set's list is a popover on the atom, not the History shade.** History takes a text query and nothing else [F07], and a set of sessions or arcs has no shade at all. One list surface, rows of ordinary atoms each with its kind's own act and menu, serves every kind. Seeding History from a commit set can follow if a range entry is ever built.

**[B05] Refs ride the chart table, so the three faces cannot disagree.** The compiler copies refs into `ChartTable` beside the rows it already builds [F02], and everything reads from there, the same discipline `chart-hover` keeps for numbers [F01]:

- *Table view* shows the atom: commit pill, file or directory ref, session chip. It is the keyboard and screen-reader path.
- *The hover bubble* gains a foot line naming what a click opens.
- *The mark* answers the pointer: a click is the kind's primary act, a right-click its menu, both through `registry.ts` [F05]. Only a mark whose ref the resolver confirmed takes the pointer cursor.

**[B06] The resolver gates every ref, exactly as it gates prose.** A ref that names nothing links nothing and shows as plain text, with no error state and no dimming, and it lights if the thing later exists. This is what makes a hand-written ref safe: a wrong one costs a lookup.

**[B07] The resting signal is the underline on the label, with a header glyph as the floor.** A label drawn for a row whose ref is confirmed, an axis category or a row name in `dots`, `spans`, `bullet` and a horizontal `bar`, wears the one resting rule. If WebKit does not draw `text-decoration` on SVG text [F11], the compiler writes a hidden 1px rule under each ref-bearing label and CSS reveals it, the shape `tgh-cross` already has. Marks do not change at rest: a tint is retired as an affordance [F05]. Because a thinned axis or a `scatter` can leave a linked mark with no label, a chart holding any confirmed ref also shows a link glyph in its header beside the Table toggle, and pressing it opens the Table view, where every ref stands as an atom. So no chart's links are discoverable only by hovering.

**[B08] The chart and its surroundings point at each other.** A table row under the pointer lights its mark and the reverse. Within one message, a mention in the prose and a mark whose ref names the same entity light together, keyed on the annotator's verdict keys, which already say when two references are one thing.

**[B09] `ChartBlock` takes an annotation context.** The Bash block and any instrument pass theirs down, so a recipe's chart resolves refs on the same terms a fence's does [F04]. Without this the feature works only for hand-written fences, which carry the fewest refs.

**[B10] Recipes emit refs; the model follows one rule.** Each recipe fills the slots its data already holds [F10]: `hotspots` and `landed` rows are files or directories; `test-history` rows are test files and dots are their runs' commits [F08]; `commits`, `commit-kinds`, `churn`, `velocity`, `commit-hours`, `commit-days` and `commit-size` carry commit sets; `arcs` and `arc-stages` carry arcs; `gaps` rows are commands; `tokens`, `cost` and `turns` carry session sets. For a fence written by hand, `tugplug/graphics.md` and the `/viz` skill gain the rule: when a row is a file, a commit, a session or an arc, put it in the ref, and never invent one.

**[B11] `arc` becomes an annotator kind.** It is the eleventh [F06], with its own primary act and menu, added to the two enumerated lists in `tug-annotation.css`. It is needed by three recipes and is useful to prose on its own.

---

## Open Questions {#open-questions}

- **What the post shows.** It could not be read. If it demonstrates a specific interaction, it may move [B05] or [B07]; the text or a screenshot settles it.
- **Do ref atoms enter Find?** The engine's `find_text` and the Table view's DOM text are held equal [F02]. A ref's label either joins both or is excluded from both, and which reads better in a Find for `commit:63de5762` is a judgment about what a reader expects a chart to match.
- **The cap on a set.** Large enough for a busy day's commits, small enough that a 90-day recipe's spec stays a line a terminal can carry. A number wants one look at the largest real spec.
- **What an arc ref and a session ref open from `arc-timeline`.** The timeline has no commit per step and no session per stage [F09]; whether the arc record holds them elsewhere decides whether those spans link or only the arc does.

---

## Non-goals {#non-goals}

- **Many atoms for one mark.** Rejected in the conversation: a set is one atom and a list on demand [B03].
- **A resting colour on a linked mark.** Already retired in `tuglaws/entity-presentation.md`; colour in a chart means series and outcome.
- **A range entry for the History shade.** A different feature [B04].
- **Links in a thumbnail, a gallery sample or a standalone SVG.** A thumbnail is not read, a sample's refs name nothing real, and a file has no resolver. A `url:` ref in a standalone render could become a plain link later.
- **A reverse index from an entity to the charts that name it.** Cross-reference stops at the message [B08].
- **Refs on a sparkline.** It has no hover and no title; a figure that small is not a place to click.

---

## Exit {#exit}

**An arc.** The pieces in the order they have to land:

1. The probe for [F11], and the `arc` kind [B11], which nothing else depends on being late.
2. The spec and the table: ref slots validated in `chart/spec.rs`, carried in `ChartTable`, with the set shape and its cap [B01]–[B03].
3. The context through `ChartBlock` [B09], then the Table view's atoms [B05] and the gate [B06]. At this point every ref is reachable and nothing in the figure has changed.
4. The figure: the mark's click and menu, the bubble's foot, the label rule and the header glyph [B05] [B07], and the set's popover [B04].
5. The recipes, single-entity rows first (`hotspots`, `landed`, `test-history`), then the sets [B10]; the prompt rule beside them.
6. The two-way highlight [B08].

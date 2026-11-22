<!-- brief-skeleton v1 -->

# The sketch holds the idea: one record, three panels

**Purpose:** An arc keeps two records of where its work came from, the idea and the sketch, and the arc shade gives each a panel. The idea is a sentence or two; it does not earn a record or a panel of its own. Fold it into the top of the sketch, and let the shade's top row be one full-width Sketch panel over Brief and Arc.

---

## Purpose {#purpose}

The user's words: "I want to think about how we might collapse idea and sketch into one entity, a revised/expanded sketch. We can simply move the idea to the top of the sketch, eh? Simple. For arc shade, this means that the top row can go full-width, with the brief and arc in the second/lower row as it is now."

Today the arc shade is a 2×2 grid: Idea and Sketch across the top, Brief and Arc beneath. The Idea panel holds at most forty words and stands beside a Sketch panel holding a sentence and a short list. Two files, two panels, an arrow between them and a return arrow down to the Brief, for what reads as one short account of what is wanted and the shape it will take.

---

## Evidence {#evidence}

**[F01] The two records are two files with fixed shapes.** `tugplug/doctrine/arc-work-doctrine.md`, under *The record of where the work came from*, defines `idea.md` (one or two sentences, at most 40 words, under `# Idea`, ending on a `Source:` line) and `sketch.md` (one approach sentence and three to six bullets of at most 15 words, under `# Sketch`, ending on a `Source:` line). Both live at `.tug/arcs/<name>/`, untracked. **(verified)**

**[F02] The door writes both and every later stage keeps both current.** `tugplug/skills/arc/SKILL.md` writes the pair at the hand-off; `arc-devise`, `arc-review`, `arc-implement` and `arc-audit` each carry a sentence telling the stage to keep "its idea and sketch" current. The doctrine already says a record that is not in the given shape "is rewritten in that shape from its source session." `tugplug/CLAUDE.md` lists the two records among an arc's five files. **(verified)**

**[F03] The records reach the deck as two optional strings.** `ArcDocuments` in `tugrust/crates/tugarc-core/src/ops/documents.rs` carries `idea_text` and `sketch_text`, read by `read_record` from the two files; `idea_file` and `sketch_file` name the paths; `tugtool arc documents` (`tugrust/crates/tugtool/src/arc.rs`) reports `idea`, `sketch`, `idea_exists` and `sketch_exists`. The deck's guard is `isArcDocuments` in `tugdeck/src/lib/changeset-types.ts`. **(verified)**

**[F04] The `arc/idea.md` strings elsewhere are unrelated.** The occurrences in `tugarc-core/src/arc.rs`, `log.rs`, `ops/discard.rs`, `tugcast/src/wheel/prompt.rs` and `tugarclab/src/executor.rs` are the name of an arc's start document in fixtures, not the idea record. **(verified)**

**[F05] The panel text parser already reads the merged shape.** `parseArcRecord` in `tugdeck/src/lib/arc-record-text.ts` turns a record into paragraphs and lists, split on blank lines, so two paragraphs followed by a list parse with no change. `recordPanel` in `session-arc-shade-content.tsx` draws the blocks. **(verified)**

**[F06] The shade's grid is four rungs and three seams.** `ARC_PANEL_RUNGS` in `tugdeck/src/lib/arc-panels.ts` is `["idea", "sketch", "brief", "arc"]` and `arcPanelSeamStates` returns three seams. `session-arc-panels.tsx` and `.css` place the panels at grid areas `1/1`, `1/3`, `3/1`, `3/3`, with a row seam across each row, a return seam from Sketch down to Brief on subgrid columns, and a seam tail that fills the gap under a Sketch panel shorter than its row. A press on a panel widens its column to two parts against one and doubles its body's line cap. **(verified)**

**[F07] A full panel is already uncapped.** The Arc panel is marked full and, since `36b5e9595`, has no line cap; it gives way only when the shade reaches four fifths of the transcript. **(verified)**

**[F08] The tests that name the four panels.** `tests/app-test/at0860-arc-panels.test.ts` asserts the rung list, the seam states, the Idea panel's text, and expands the Idea panel by press; `tugdeck/src/components/tugways/cards/__tests__/session-arc-record-panel.test.tsx` covers `isArcDocuments` and `recordPanel`; the `documents.rs` unit tests and `tugrust/crates/tugtool/tests/cli_integration_tests.rs` read the idea fields. **(verified)**

**[F09] The user guide describes four panels.** `docs/features.md`, in its arcs section, lists Idea and Sketch as separate panels, says "the four tell one story", and describes an arrow "across each row, and from Sketch back down to Brief". D234 in `tuglaws/design-decisions.md` records the arc shade and its amendments. **(verified)**

---

## Decisions {#decisions}

**[B01] `sketch.md` is the one record, and the idea is its opening paragraph.** The shape becomes: the `# Sketch` heading; the want, one or two sentences of at most 40 words, under today's rules for the idea; the one approach sentence; three to six bullets; the `Source:` line. `idea.md` is no longer written or read. The idea's rules move with it unchanged, so nothing about what a good want says is reopened.

**[B02] "Idea" stays a word in the ladder.** Idea, sketch, brief, plan is still the order work is spoken of in; the idea remains the seed a session starts from. What goes is its separate record and its panel. No new term is introduced for the merged record: it is the sketch.

**[B03] The doctrine's read-back test becomes one test over one record.** A stranger can say what the work is for from the opening paragraph alone and what its parts are from the rest, and no sentence of the one repeats in the other. The rules on the user's words (no paths, identifiers, labels, or mention of the conversation) stand as written.

**[B04] The arc shade has three panels: 1 Sketch, 2 Brief, 3 Arc.** Sketch spans the full width of the top row; Brief and Arc keep the lower row as they are. `ARC_PANEL_RUNGS` becomes `["sketch", "brief", "arc"]` and the numbers follow from it.

**[B05] Two seams remain.** The Idea to Sketch arrow goes with the panel. Sketch to Brief becomes a plain drop: from the Sketch panel's bottom edge straight down into the middle of the Brief panel's top edge. Brief to Arc is unchanged. The seam tail goes entirely: Sketch is alone in its row, the row is exactly as tall as the panel, and there is never a gap beneath it. Solid where both sides hold something and dotted where not, as now.

**[B06] The Sketch panel is not pressable and not line-capped.** It has no column to widen, and the doctrine already bounds what it holds to about eight lines, so it is shown whole, as the Arc panel is since [F07]. A press still expands Brief or Arc as it does today. The shade's own cap, four fifths of the transcript, is unchanged, and when it binds the short top row keeps its height while the lower row gives way.

**[B07] The opening paragraph reads as the panel's lead.** The want is drawn in the full-strength ink of the panel's text and the approach sentence in a quieter tone, so the want is what the eye takes first. This was proposed to the user and not answered before the brief was written; it is the default, and the cheapest thing in the brief to reverse.

**[B08] Existing arcs fold on their next stage; no reader bridge.** The doctrine already has every stage rewrite a record that is not in shape ([F02]). One sentence is added: a stage that finds an `idea.md` folds its want into the top of `sketch.md` and deletes it. Until that stage runs, such an arc's Sketch panel shows its sketch without the want. The alternative, a reader that prepends `idea.md` when it exists, is the kind of compatibility bridge the project declines while it has no installs in the wild. This too was proposed and not answered; it is the default.

**[B09] The idea fields are removed from the wire, not left empty.** `idea_text`, `idea_file`, and the `idea` and `idea_exists` fields of `tugtool arc documents` go, and the deck's guard and types follow. A field nothing writes is a question for the next reader.

---

## Non-goals {#non-goals}

- **Changing the Brief or Arc panels.** Their content, their expansion and the verb row are as they stand.
- **Renaming the start-document fixtures.** The `arc/idea.md` strings of [F04] name something else and stay.
- **A reader that merges `idea.md` at read time.** Rejected in [B08].
- **A new name for the merged record.** Rejected in [B02]; it is the sketch.
- **Reworking what a sketch says.** The approach sentence and the bullets keep their rules; only the want is added above them.

---

## Exit {#exit}

**An arc.** The work has three parts that can land in this order:

- **The record.** The doctrine section rewritten for one record with its new example and test; the door's skill writing one file; the four stage skills and `tugplug/CLAUDE.md` saying "sketch"; the fold sentence of [B08]. Then the Rust side: `ArcDocuments`, `idea_file`, `tugtool arc documents` and their tests ([F03], [B09]).
- **The shade.** `arc-panels.ts` to three rungs and two seams; `session-arc-panels.tsx` and `.css` to the full-width top row, the plain drop, no seam tail, and a Sketch panel that is neither pressable nor capped; `session-arc-shade-content.tsx` passing one record; the lead paragraph's ink ([B04] to [B07]); `changeset-types.ts` and the unit test.
- **The verdict and the documents.** `at0860` rewritten for three panels and the full-width row, with the Idea assertions moved to the Sketch panel's opening paragraph; `docs/features.md`'s arcs section; an amendment to D234.

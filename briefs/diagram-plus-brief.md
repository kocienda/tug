# Diagram Plus: clearer connectors, fuller forms, and two new diagram forms

**Purpose:** The four diagram forms `/explain` draws say too little and say it weakly: their arrows are the lightest marks in the figure, their labels sit away from what they name, and several things an explainer needs to say have no field. Two questions about code, "what states can this be in" and "what is inside what", have no form at all.

---

## Purpose {#purpose}

The request, in the user's words, over a `layers` figure from a real explainer:

> Let's look at *each /explain diagram type we now have*, and see how we can *plus* each type with better, clearer, and more complete information. For example, the arrows between these levels are *essential* for communicating the architecture, but they are these mean, scrawny, little things that are off center. That's the kind of issue I want addressed and improved throughout.

A design spike answered it form by form, drawing each shipped form beside a proposed one. The user's verdict on the result: "These changes are *great*... exactly what I wanted." A follow-up asked to "expand the diagram repertoire a little", which the spike answered with two new forms, and then: "Brief these changes! Include updates to the skills and the help docs."

So the work is to port what the spike drew into the shipped forms, add the two new forms, and bring the model-facing docs, the skills and the user-facing help in line with what the forms can now do.

---

## Evidence {#evidence}

**[F01] The spike is the visual specification.** `tugdeck/src/spikes/spike-diagram-plus.tsx` draws six sections. Four show a shipped form (rendered by the real `renderChartInto` from a `tugdiagram` spec) above a proposed one; two show new forms. The proposed figures are laid out in TypeScript in `tugdeck/src/spikes/spike-diagram-plus-layout.ts` and emitted as layer 0 programs drawn by the real engine, so colour and type are the shipping ones. `tugdeck/src/spikes/spike-diagram-plus-subjects.ts` holds each subject's spec and a numbered list of changes, each tagged look, layout or spec and marked drawn or not drawn. The first four sections landed as `30d2a15b7`; the `states` and `tree` sections are in the working tree, uncommitted at the time of writing. **(verified)**

**[F02] The proposed figures were checked by rendering, not on the deck.** Each layout was run under bun with approximated text widths and its program rendered through `tugtool chart render`, then viewed. `tsc` and `vite build` are green with all six sections. Nobody has yet read the spike card on a running deck with real measurement, so exact spacing is unconfirmed. **(verified as stated; the on-deck look is not verified)**

**[F03] The shipped connector is the lightest mark in a figure.** `tugdeck/crates/tuggraphics/src/diagram/pen.rs` draws every edge at `EDGE_WIDTH` 1.5 px with a head of `HEAD` 8 px long and `HALF` 4 px half-width. The forms pass `ColourRole::InkMuted` for an untoned edge. `both_ways`, the double-headed arrow `layers` and `stack` use, is the same weight. **(verified)**

**[F04] The `layers` crossing is off the band's centre by construction.** In `diagram/layers.rs` the arrow's x is `x + label_w + inner / 2`, the middle of the cell area, which starts after the label column; the label is then drawn `ARROW_LABEL` 10 px to the arrow's right. The gap that holds the arrow is `CROSSING_GAP` 34 px, so with two 8 px heads and 3 px insets the shaft is 12 px long. **(verified)**

**[F05] A `layers` crossing cannot say a direction.** The spec's one field is `below`, a string, always drawn with `pen.both_ways`. There is no way to name what goes down, what comes back, or the channel between. **(verified)**

**[F06] `stack` arrows carry nothing.** `above` and `below` blocks are `{"name", "sub"?, "span"}` and their arrows are unlabelled; adjacent layers have no connector at all. The golden subject (`tests/diagram-golden/stack-architecture.json`) writes "stream-json over stdio" as the Claude Code block's `sub`, which is what the arrow carries and not a fact about the block. A keyed cell pins its disc to the cell's top-left corner while the name stays centred. **(verified by reading the golden's render)**

**[F07] `sequence` hides the shape of the exchange.** Key discs stand in a gutter at the far left, a column away from the arrows they number. Every row is one pitch from the next, so a reply is no closer to its call than to the next call. A reply differs from a call only by dashes and muted ink. There are no activation marks and no way to group messages or say that a run of them repeats. **(verified by reading the golden's render)**

**[F08] `flow` parks labels away from their edges and takes back edges the long way.** In the `flow-edit-gate` golden, "denied before it runs" sits under a loop nearer to another edge than its own, and the refusal leaves a row on the right, wraps under its own box and climbs into the target from below. Two edges that skip a column run at nearly the same depth with their labels side by side beneath. A lit row is a row whose name is coloured and nothing else. What the tones mean is said only in the caption sentence outside the figure. **(verified by reading the golden's render)**

**[F09] Labels on edges cost width in `flow`.** With chips on edges, gaps sized to the chip, and chips wrapped at 96 px, the proposed `flow-edit-gate` figure measured about 1,066 px wide in the approximated preview, against 1,017 px for the shipped one and the 1,040 px figure limit in `tugplug/diagrams.md`. The other three proposed figures were inside the limit (`layers` 740, `stack` 917, `sequence` 928). The numbers come from approximated text widths. **(measured approximately; real widths are read from the spike's readout line on a running deck)**

**[F10] No shipped form can draw a cycle or containment.** `flow` runs left to right by column, `sequence` is one run through time, and `layers` and `stack` are strata. A lifecycle such as the `idle | loading | ready | error` phases of `tugdeck/src/lib/git-diff-store.ts` (the same four recur in `git-log-store.ts`, `git-commit-files-store.ts` and `skills-inventory-store.ts`) has no figure, and neither does a module tree. **(verified)**

**[F11] A form is named in several places, all of which must agree.** Adding or changing one touches: the parser, `Form` enum, `name()` and `keyed()` in `diagram/spec.rs`; the dispatch in `diagram/mod.rs`; a layout file per form; `diagram/budget.rs`; the golden specs and SVGs under `tests/diagram-golden/` and `tests/diagram.rs`; the form list `tugtool chart forms` prints, in `tugrust/crates/tugchart-core/src/forms.rs`; `tugplug/diagrams.md`, which rides every session's system prompt; `tugplug/skills/explain/SKILL.md` (its `argument-hint` lists the four forms and its text says "four forms"); `tugplug/skills/viz/SKILL.md`; the `diagrams.md` entry in `tugplug/CLAUDE.md`; and the app-test fixtures `tests/app-test/tugchart-fixture.ts`, `at0838`, `at0839`, `at0840`. **(verified by grep)**

**[F12] The help docs name four forms in five places.** `docs/features.md` (the Diagrams paragraph, line 95), `docs/recipes.md` ("Choose the kind of diagram", line 355) and `docs/glossary.md` (the Diagram and Form entries, lines 69 and 95) each say a diagram has four forms and list them. Session `tug/hasty-cycle` brought those three files current in `50e89026d` and `55ff41fdb`; session `tug/elated-flag`, the chart cross-references arc, also edited `docs/glossary.md` afterwards, and that edit is already committed. Each recipe carries a `<!-- source: … -->` comment naming the files it was written from. **(verified)**

**[F13] An unknown key in a `tugdiagram` spec is ignored with a warning, and an unknown `form` falls through to `flow`.** `diagram/spec.rs` ends its form match with `_ => self.flow(obj)`. So a spec written for a new form and read by an older build is parsed as a `flow` with nothing to draw. **(verified in the match; the consequence is inferred)**

---

## Decisions {#decisions}

**[B01] One connector for every form, changed in the pen.** A connector is 2 px in full ink with a head 11 px long and 5.5 px half-width. A tone recolours the line, the head and its label together. The change lives in `diagram/pen.rs` so every form inherits it; no form keeps the 1.5 px muted arrow. This is the user's opening complaint and the change every section of the spike shares.

**[B02] A label sits on its connector, in a chip.** The pen gains a chip: the figure's surface under the text, a thin outline, the connector's tone, drawn after the edges so the line runs into it and out the other side. Every edge label, crossing label and link label in every form uses it. A label is never drawn beside or under the line it names.

**[B03] An edge that leaves a box or a row starts with a dot.** A 3.5 px dot in the edge's tone at its origin, in `flow` and `states`, says which row an edge belongs to when several leave one box.

**[B04] `layers`: the crossing is centred on the band and says what goes each way.** The crossing sits on the band's own centre line and is laid out symmetrically about it; the gap grows from 34 px to 58 px. `below` keeps its name and takes either a string (today's meaning: one double-headed arrow with that label) or an object `{"via"?, "down"?, "up"?}`. With both `down` and `up`, two one-way arrows replace the double-headed one, `down`'s label to the left and `up`'s to the right, and `via` is set in the code face in a chip between them. With one direction named, a single one-way arrow. The spike spelled this field `cross`; keeping `below` means specs already in transcripts draw as before and `stack` and `layers` share one word for the same idea.

**[B05] `layers`: a layer may be `outside`, and its name is ruled off from its cells.** A layer takes an optional `tone` of `outside`, drawn with the wash and outline an outside block has in `stack`. A faint vertical rule separates the label column from the cells.

**[B06] `stack`: arrows carry labels, and adjacent layers may say what passes between them.** An `above` or `below` block takes an optional `link`, drawn as a chip on its arrow. A layer takes an optional `below`, a string, drawn as a labelled connector to the layer under it, centred on the columns the two share; a layer without it keeps today's 12 px gap. A labelled gap is 66 px, enough for both heads and the chip.

**[B07] `stack`: a key and its name are centred as one group.** The disc sits immediately before the name and the pair is centred in the cell.

**[B08] `sequence`: the key sits on the sender's lifeline.** A keyed message's disc is centred on the sending lifeline where the arrow starts, and the left gutter of discs is gone. An unkeyed call gets a small dot in the same place.

**[B09] `sequence`: activations, exchange spacing, and a return with its own shape.** A narrow bar marks an actor from a call it receives to the reply it sends for it, derived from the messages with no new field. A reply sits closer under the message before it than a new call does. A reply is drawn dashed with an open head; a call is solid with a filled head. Lifelines are drawn at readable strength and each actor's name is repeated where its line ends.

**[B10] `sequence`: a `phases` list names runs of messages.** Each phase is `{"label", "note"?, "from", "to"}` over 0-based message indices, drawn as a faint band behind the run with its label and wrapped note in the left gutter. It is the one place a figure can say that a part repeats.

**[B11] `flow`: a back edge to the neighbouring column takes the short way.** An edge between adjacent columns, forward or back, leaves the side of its source that faces the target and crosses the one gap. Only an edge that skips a column runs under the boxes, and each such edge gets a lane of its own 30 px from the next. An edge that skips a column and ends at a row comes up in the gap before that row's box and turns into the row.

**[B12] `flow`: a `legend` names the tones, and a lit row is marked with more than its text.** `legend` is a list of `{"tone", "text"}` drawn as one line under the figure. A lit row gets a wash, an outline and a dot in its tone.

**[B13] A new form, `states`.** It answers what a thing can be and what moves it between states. The spec is `start`, `states` (`{"id", "name", "sub"?, "key"?, "tone"?, "end"?, "under"?}`) and `transitions` (`{"from", "to", "label"?, "tone"?, "dashed"?}`). States without `under` stand on a main line left to right in the order given; a state `under` another hangs beneath it. A transition to the next state on the line is a straight arrow; any other transition between two main-line states goes over the top in its own lane; a side state returns along the bottom into the target's lower edge. States are round-ended, the start is a dot with an arrow, and an `end` state wears a second outline. There is no general graph layout: placement is by these rules, so a spec always draws the same figure. Budget: six states on the main line, one side state under each, twelve transitions, three lanes over the top.

**[B14] A new form, `tree`.** It answers what is inside what. The spec is one `root` whose nodes are `{"name", "sub"?, "mono"?, "key"?, "tone"?, "children"?}`. The root is at the left with one column per depth, every node in a column is the column's width, a parent is centred on its children, and the joining lines turn in one lane per level. The lines have no heads and are drawn at 1.5 px in muted ink, because containment has no direction; this is the one connector exempt from [B01]. A node with children has the full outline and a leaf a fainter one. Budget: four levels and twenty nodes.

**[B15] The layouts are ported to Rust and the spike is deleted.** The six layouts move into `tugdeck/crates/tuggraphics/src/diagram/`, the pen changes into `pen.rs`, with the spike's constants as the starting values. Both new forms get keyed rows, budgets, a golden spec and SVG, and an entry in `tugchart-core/src/forms.rs` so `tugtool chart forms` lists them with the words a request might use and an example ask. The golden SVGs for the four shipped forms are regenerated, since every one changes. When the port lands, the three `spike-diagram-plus*` files, the stylesheet and the two registry lines are removed, as `tugdeck/src/spikes/README.md` asks of a graduated spike.

**[B16] `tugplug/diagrams.md` is rewritten to teach what the forms now take.** It is the source the model writes fences from. It gains the new fields with one example each, the two new forms in the form table and with a complete example each, their budgets in *Limits and repairs*, and the repairs for the new fields (a `phases` range off the end, a `legend` tone not used, an `under` naming nothing). Its examples are compiled with `tugtool chart render` before they are written, as the document itself requires. The statement that a lit row colours the row is updated to [B12].

**[B17] The skills name six forms.** `tugplug/skills/explain/SKILL.md` updates its `argument-hint`, its "four forms" text and its guidance on choosing a form, adding when a question wants `states` (a lifecycle, anything that returns to an earlier state) or `tree` (parts and where they live). `tugplug/skills/viz/SKILL.md` and the `diagrams.md` entry in `tugplug/CLAUDE.md` are brought to match. The skills keep reading the form list from `tugtool chart forms --kind diagram` and do not hardcode it a second time.

**[B18] The help docs are brought current in the same arc.** `docs/features.md`, `docs/recipes.md` and `docs/glossary.md` say six forms and describe the two new ones in the user's terms; the "Choose the kind of diagram" recipe gains an example ask for each; the glossary's Diagram and Form entries are updated; and what a reader now sees in a figure (labels on arrows, a tone legend, phases, activation bars) is described where the docs describe a diagram. Each touched recipe's `<!-- source: … -->` comment is kept accurate. These files were last edited by `tug/hasty-cycle` and `tug/elated-flag`, so the edits are made against the files as they stand, not against an earlier reading.

---

## Open Questions {#open-questions}

- **Does the proposed `flow` fit the 1,040 px limit with real measurement?** [F09] puts the edit-gate figure about 26 px over with approximated widths. Reading the spike's readout on a running deck settles the number. If it is over, the choice is between a narrower chip wrap, a tighter gap, and a lower column budget for a `flow` whose gaps carry labels, and that choice changes what `diagrams.md` tells the model.
- **What does an older build do with a `states` or `tree` fence?** [F13] says an unknown form is parsed as a `flow`. The install base is zero, so this is about the user's own transcripts opened in an older build, and may need no answer; if it does, the answer is an explicit "unknown form" error in place of the `flow` fall-through.
- **Which of the not-drawn proposals come along?** The spike lists seven ideas it described but did not draw: a `layers` crossing between two named cells; a named gap beside a short `stack` layer; an across bar that spans only some layers; a `note` on a `sequence` lifeline; `start` and `end` flags on `flow` boxes; a self-loop transition in `states`; and a `count` on a folded `tree` node. Separate cause and guard fields on a `states` transition is an eighth. None is decided. The self-loop is the one with a known need: the diff store ignoring a stale reply is the most interesting fact about its lifecycle and the form cannot draw it.

---

## Non-goals {#non-goals}

- **A general graph layout.** `states` places by rule ([B13]) and refuses what the rules cannot place. A force-directed or layered-graph layout would make the same spec draw differently as it grows, which is the property the closed forms exist to avoid.
- **A schema form and a who-touches-what matrix.** Both were considered as new forms. The matrix is a table, which Markdown already draws; the schema form is worth revisiting only if explainers about the ledgers become common.
- **Changes to the chart forms.** `tugchart` and its ten forms are untouched. Only the diagram pen and the diagram forms change.
- **A new skill or a new fence.** The two forms ride the existing `tugdiagram` fence and the existing `/explain` and `/viz` doors.
- **Keeping the spike as a gallery of the forms.** It is deleted when the port lands ([B15]). The goldens and `diagrams.md` are the durable record of how each form looks.

---

## Exit {#exit}

**An arc.** The spike's uncommitted `states` and `tree` sections need to be committed first, or the arc's worktree will not hold the layouts it is porting.

A workable order:

1. The pen: the 2 px connector, the larger head, the open head, the bare line, the chip and the origin dot ([B01]–[B03]). Regenerate the four goldens, since every figure changes here.
2. `layers` and `stack` ([B04]–[B07]), which share the vertical connector and the string-or-object `below`.
3. `sequence` ([B08]–[B10]).
4. `flow` ([B11], [B12]), with the width question from [F09] settled by measurement before its budget is written.
5. `states`, then `tree` ([B13], [B14]): spec, layout, keyed rows, budget, golden, and the `tugtool chart forms` entry for each.
6. `tugplug/diagrams.md`, the two skills and `tugplug/CLAUDE.md` ([B16], [B17]), every example compiled.
7. The help docs ([B18]).
8. Delete the spike ([B15]).

The app-tests that render a diagram fence (`at0838`, `at0839`, `at0840`) assert on figures whose geometry changes in step 1, so they are in the verdict selection from that step on.

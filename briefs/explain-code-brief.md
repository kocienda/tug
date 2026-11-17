# Explain Code: a sheet of the diagram forms

**Purpose:** Visualize Data shows every chart recipe and places its request in the composer. `/explain` has no such door: its six diagram forms are discoverable only by typing the skill bare or knowing the words. This brief settles the command and the sheet that give `/explain` the same door.

---

## Purpose {#purpose}

The user, after the Data Visualization command was renamed Visualize Data: "we need an analog to this *Visualize Data* command for our /explain diagramming."

What is wanted is a menu command, a slash command and a chord that open a sheet listing what `/explain` can draw, with a button per row that starts the request. The command is named with a verb, as Visualize Data now is.

---

## Evidence {#evidence}

**[F01] The diagram forms already have a machine-readable catalog.** `tugtool chart forms --kind diagram --json` prints six entries (flow, sequence, layers, stack, states, tree), each with `name`, `shows`, `said` (the everyday words) and `ask` (an example request such as `/explain how login works as a sequence`). The source is `tugrust/crates/tugchart-core/src/forms.rs`. It carries no sample figure. **(verified)**

**[F02] Chart recipes carry a sample; forms do not.** Each recipe in `tugrust/crates/tugchart-core/src/catalog.rs` has a `sample` function, and a test in `forms.rs` holds every recipe's sample to be a valid chart in every form it offers. `tugdeck/src/lib/chart-recipes-store.ts` reads `GET /api/chart/list` once and then `GET /api/chart/<recipe>?project=<dir>` per recipe; a row with no data or a failed read draws the sample, marked Sample. **(verified)**

**[F03] The list route is one handler in tugcast.** `chart_list_handler` in `tugrust/crates/tugcast/src/server.rs` serves `/api/chart/list`, loopback only and read-only, with the same list `tugtool chart list --json` prints. **(verified)**

**[F04] The composer can place a command with the caret mid-text.** Visualize… calls `insertCommandChip(VIZ_SKILL_COMMAND, name)` from `tugdeck/src/components/tugways/cards/session-card.tsx`. That reaches `computeCommandChipInsert` in `tugdeck/src/components/tugways/cards/prompt-entry.tsx`, a pure function that returns the draft's text, atoms and an explicit `selection`. Today it puts the argument after the chip and the caret after the argument; nothing in its shape prevents text after the caret. **(verified by reading; no caret-mid-text call exists yet)**

**[F05] The explain skill's grammar puts the form last.** `tugplug/skills/explain/SKILL.md` declares `argument-hint: "<subject> [as flow|sequence|layers|stack|states|tree] [keep [path]]"`, and a bare `/explain` prints the forms and stops. **(verified)**

**[F06] Control-Command-X is unassigned.** Neither `tuglaws/chord-tiers.md` nor `tuglaws/menus.md` mentions ⌃⌘X, and the only `KeyX` chord in `tugdeck/src/components/tugways/command-registry.ts` is ⌘X. ⌃⌘E is taken. ⌃⌘D is the system's Look Up in a text view. **(verified for the two documents and the registry; the system claim is from memory, not tested)**

**[F07] The Visualize Data sheet is the pattern to copy.** `tugdeck/src/components/tugways/cards/data-visualization-sheet.tsx` composes `TugSheetScaffold`, `ChartBlock`, `SheetNotice` and `TugPushButton`, names no recipe itself, closes on Done, Escape or its own command arriving again, and is opened from the card's slash-command table. Its menu row is one `sessionCommandItem` in `tugapp/Sources/MenuBarBuilder.swift`, pinned by `tugapp/TugTests/MenuBarBuilderTests.swift`, the registry's menu table, `command-routing-drift.test.ts` and the generated catalog in `tuglaws/menus.md`. **(verified)**

**[F08] Whether `ChartBlock` draws a `tugdiagram` spec as a still thumbnail is not established.** Diagrams render through `tugdeck/src/lib/markdown/enhance-chart.ts` and the tuggraphics WASM, and the keyed table is built in `tugdeck/src/lib/chart/keyed-table.ts`. I did not read whether the block the sheet uses accepts a diagram spec or can suppress the keyed table. Reading `chart-block.tsx` settles it.

---

## Decisions {#decisions}

**[B01] The command is Explain Code….** Menu title `Explain Code…` in the Session menu directly beneath Visualize Data…; slash command `/explain-code`; menu identifier `session.explainCode`; sheet title `Explain Code`. It is a verb with an object, as Visualize Data is, and the ellipsis is true because the command needs a form and a subject before anything happens. The slash command has a name of its own because `/explain` stays the skill's, the same split as `/visualize-data` and `/viz`.

**[B02] The chord is Control-Command-X.** X for eXplain, in the Tug tier beside ⌃⌘V. E is taken and D collides with Look Up ([F06]). The user chose it over having no chord.

**[B03] The sheet has one row per diagram form, and a first row with no form.** The six forms appear in catalog order. The first row, "Let the question choose", stands for `/explain` with no form named, which is the skill's default behaviour; it has no thumbnail.

**[B04] A row shows the form's name, an icon, what it shows, its everyday words, a thumbnail, and its example request.** The example request is the catalog's `ask`, drawn muted as an example. It is shown and never placed, because its subject is about someone else's code.

**[B05] Every thumbnail is a sample and is marked Sample.** A diagram exists only after the model reads code, so there is nothing of the project's to draw before the request is sent. The thumbnail is still and carries no keyed table.

**[B06] The row button is Explain…, and it places the request with the caret where the subject goes.** It seeds the `/tugplug:explain` chip followed by ` as <form>`, unsent, with the caret between the chip and ` as`, so the user types the subject and sends. The no-form row seeds the chip alone. This needs `computeCommandChipInsert` to take text that follows the caret ([F04]). If that turns out not to hold, the fallback the user accepted is `/tugplug:explain as <form>: ` with the subject typed at the end, and the skill's argument grammar ([F05]) widened to accept it.

**[B07] The catalog gains a sample per form, and tugcast serves the forms.** Each diagram form in `forms.rs` gets a `sample` that is a small `tugdiagram` spec, shipped in the binary and held valid by a test as recipe samples are ([F02]). tugcast serves the forms list with samples on a route beside `/api/chart/list` ([F03]), and a small store in tugdeck reads it once. The sheet names no form itself, so a seventh form needs no change there.

**[B08] The sheet has no per-project reads.** There is no pending, no-data or failed row state. The one failure is the forms read itself, which the sheet says in a notice line as Visualize Data does.

**[B09] Everything else follows Visualize Data.** Done, Escape or the chord again closes the sheet; the sheet is card-scoped; the menu row is gated by the registry as its neighbour is. The docs that name Visualize Data (`docs/features.md`, `docs/recipes.md`, `docs/glossary.md`, `tuglaws/menus.md`, `tuglaws/chord-tiers.md`, and the Operator's term and heading lists in `overview_agent.rs`) gain the matching entries for Explain Code.

---

## Open Questions {#open-questions}

- Whether the sheet can reuse `ChartBlock` for a still diagram thumbnail without its keyed table ([F08]). It is answered by reading `chart-block.tsx`; it changes which component the row composes, not what the sheet is.

---

## Non-goals {#non-goals}

- **A subject field in the sheet.** The composer is where the request is written, and Explain… leaves it there unsent. A second text field would be a second place to type the same sentence.
- **Live figures of the project.** Drawing one means a model turn that reads code, which is the request the sheet exists to start.
- **Placing the example request.** See [B04].
- **Control-Command-D or Control-Command-E.** See [B02].
- **Folding diagrams into the Visualize Data sheet.** The two sheets feed different skills with different shapes of request: a recipe is complete, an explain needs a subject.
- **Renaming the `data-visualization-sheet` files.** Out of scope here; the new sheet's files are named for it.

---

## Exit {#exit}

**An arc.** The first steps, in the order they depend on each other:

1. A `sample` per diagram form in `tugchart-core`, with the test that holds each valid, and `tugtool chart forms --json` carrying it.
2. The tugcast route that serves the forms, and the tugdeck store that reads it.
3. The caret-mid-text placement in `computeCommandChipInsert`, with its pure tests.
4. The sheet, its slash command, registry entry and chord, and the Swift menu row with its pins.
5. The docs and laws entries, and one app-test that opens the sheet from the menu row and presses Explain….

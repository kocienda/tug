# Data Visualization Sheet

**Purpose:** The chart recipes can only be discovered by asking for a list of names. The user wants a sheet that shows every recipe with a preview of what it produces and a short description of what its data tells, built so the set of recipes can grow freely.

---

## Purpose {#purpose}

The request, in the user's words:

> I want to add a new sheet that displays all the `/viz` recipes. We can also add a new keyboard shortcut and ⌃⌘V and a menu command to display the sheet (in the Session menu at the end (Data Visualization...).
>
> The sheet should include previews of what the different recipes produce, which a short description of what the data tells.
>
> This must be done in an open-ended manner, since after we add this new feature, I want to revisit and expand on the recipes we offer.

The last sentence is a requirement on the design, not a note about the future: adding a recipe afterwards must not mean changing the sheet.

---

## Evidence {#evidence}

**[F01] There is already one list of recipes.** `RECIPES` in `tugrust/crates/tugchart-core/src/catalog.rs` holds twelve rows of `name`, `question`, `form`, `data`, `args` and a run function. The command line, `tugtool chart list` and tugcast's `GET /api/chart/list` are all built from it through `catalog_json()`. **(verified)**

**[F02] The deck can already draw every recipe live.** `tugdeck/src/lib/chart-recipes-store.ts` reads the list, runs each recipe with `GET /api/chart/<recipe>?project=<dir>`, and publishes each answer as it lands, as `pending`, `chart`, `noData` or `failed`. `tugdeck/src/components/tugways/cards/gallery-chart-recipes.tsx` draws those outcomes through `ChartBlock`. **(verified)**

**[F03] The store resets a project's rows on every read.** `refreshRecipes` publishes every row as `pending` before it reads, so a surface that re-reads on open would blank figures it already holds. **(verified)**

**[F04] Reads are cheap on this project.** Timed from the CLI over this checkout, every recipe took 1.3s or less: `churn` and `hotspots` took about 1.3s and the rest under 0.1s. These are CLI timings on one project. The cost of mounting twelve `ChartBlock`s in one sheet was not measured. **(verified, for the reads)**

**[F05] Recipes can have nothing to draw.** `landed` returned `spec: null` with the summary "no changes, the working tree" on a clean tree; the other eleven drew here. This project has months of history and ledgers. How many recipes come back empty on a new project was not measured, but the test and arc recipes read records such a project will not have yet. **(verified for `landed`; inferred for a new project)**

**[F06] Recipe specs carry no size.** None of the eleven specs returned here sets `size`, so each takes its form's default. Whether those defaults fit a figure column beside text in an `xl` sheet has not been tried. **(verified that no size is set; the fit is untested)**

**[F07] A sheet has a settled route from the menu.** `/usage` is the pattern: a row in `SLASH_BRIDGES` and a chord in `tugdeck/src/components/tugways/command-registry.ts`, a `sessionCommandItem` in `tugapp/Sources/MenuBarBuilder.swift`, a handler in `session-card.tsx`, and a `useUsageSheet` hook whose `openUsageSheet` closes the sheet when it is already showing. `TugSheetScaffold` gives a pinned header and footer around a scrolling body. **(verified)**

**[F08] The Session menu currently ends with the `Inspect ▸` submenu.** See `tugapp/Sources/MenuBarBuilder.swift`. **(verified)**

**[F09] ⌃⌘V is free.** No command in `command-registry.ts` holds it. None of the 29 hotkeys in the user's Keyboard Maestro macros is on V. Under `tuglaws/chord-tiers.md`, ⌃⌘ is the tier for Tug's own surfaces and its letters read as initials (C changes, H history, U usage), so V for Visualization fits. **(verified)**

**[F10] The summary line has a wording flaw.** `commits` reports "669 commit(s) over 31 day(s), last 30 days". The figure has 31 categories under a 30-day label. The sheet would show this on every open. **(verified)**

**[F11] How the sheet reaches the composer has not been traced.** The Draw action needs to place text in the session's composer from inside a sheet. `Insert File…` shows the composer accepts programmatic insertion, but the exact path was not read. **(not verified)**

---

## Decisions {#decisions}

**[B01] The sheet is a Session card sheet titled "Data Visualization".** It uses `TugSheetScaffold`, runs over the session card's own project rather than the frontmost project, and follows the `/usage` pattern [F07]. It sits beside the gallery card and does not replace it.

**[B02] The door is a `Data Visualization…` row at the end of the Session menu, with ⌃⌘V.** The row goes after `Inspect ▸`, behind a separator [F08], and the chord opens and closes the sheet as `/usage` does. The chord is recorded in `tuglaws/chord-tiers.md` as an initial [F09].

**[B03] `/viz` stays the skill.** The card command behind the row takes another name, so typing `/viz` still reaches the skill. This work adds no typed command as a goal of its own.

**[B04] The catalog is the only source, and the deck names no recipe.** Everything the sheet shows comes from `RECIPES` through `/api/chart/list` and the recipe routes. This is what makes the sheet open-ended: a new recipe is one catalog row, its run function and its sample, with no deck change. Anything that would require a recipe's name in deck code is the wrong design.

**[B05] The catalog gains three required fields: `tells`, `group` and `sample`.**
- `tells` is one sentence on what the data tells the reader. It also appears in `tugtool chart list` and its `--json`, so `/viz` can read it too.
- `group` names the section a recipe sits in. Sections and their order come from the catalog, so a longer list stays readable.
- `sample` is a small built-in spec, drawn when the project has no data for that recipe.

**[B06] A row shows the recipe's name, question, `tells` line and live summary as text on the left, and the figure on the right.** The figure is drawn at real size by the normal chart renderer, with hover and the enter animation intact. Shrunken thumbnails are ruled out because labels are laid out by exact text measurement, so a shrunk figure misrepresents the chart. The form's default size is the starting point, and the fit is an open question [F06].

**[B07] A preview is live when the recipe has data, and otherwise the recipe's sample, marked "Sample".** A sample keeps the sheet useful on a clean tree or a new project [F05], and the mark keeps it from being read as the project's numbers. A `noData` row shows the recipe's summary beside its sample; a `failed` row shows the failure message there instead.

**[B08] Each row has a Draw button that puts `/viz <name>` in the composer and closes the sheet, without sending.** The user settled this. It gives the sheet a next step and leaves the send to the user, who can add a path or a day count first. A sample row has the same button: the sample shows what the recipe produces, and the run answers from the project.

**[B09] Re-opening shows the last results while it re-reads.** The store stops blanking rows it already holds [F03], and each row updates as its answer lands. The gallery card gets the same behaviour from the same store.

**[B10] Completeness is enforced by tests, not by review.** A Rust test requires `tells`, `group` and `sample` on every recipe. A deck-side test compiles every sample through the real chart compiler. A recipe missing a field, or with a sample that does not draw, cannot land. An app-test opens the sheet from the door and exercises a live row, a sample row, a failed row and the Draw button.

**[B11] The twelve recipes start with these groups and `tells` lines.** They are a starting point the arc may polish, and the groups are data like everything else.

| Group | Recipe | `tells` |
|---|---|---|
| Activity | `commits` | How steady the work is, and which days spiked. |
| Activity | `churn` | How many lines were added and removed each day, so size shows where commit counts can't. |
| Activity | `commit-kinds` | Which areas of the project each day's work went to. |
| Activity | `commit-hours` | Which hours of the day work tends to land. |
| Changes | `hotspots` | Where changes concentrate, which is often where the risk is. |
| Changes | `landed` | How a change spreads across the tree, and whether it stayed where you meant it to. |
| Arcs | `arc-timeline` | Which stages and steps an arc's time went to. |
| Tests | `suite-times` | Whether each suite is slowing down, and when that started. |
| Tests | `test-distribution` | Whether test time is evenly spread or dominated by a few slow files. |
| Tests | `test-budget` | Which app-test files are closest to going over their time budget. |
| Tests | `test-history` | Which files have been red, and whether a failure is new or persistent. |
| Telemetry | `gaps` | Which long commands ran without reporting progress, so which to fix next. |

**[B12] The day-count wording is fixed in this work.** The summary and the figure must agree on how many days they cover [F10]. The sheet makes the flaw permanent and visible, so it is fixed here rather than left for the recipe revisit.

---

## Open Questions {#open-questions}

- **Does a form's default size fit the figure column at `xl`?** [F06] This needs a look at the real sheet. If it does not fit, the column widths or the sheet's width move, or the sheet passes a size to the figure. The decision in [B06] that figures are not shrunk stands either way.
- **Does mounting twelve figures on open cost a visible hitch?** [F04] Only a reading from the running sheet can settle this. If it does, off-screen rows can mount on approach; they must still animate when they come into view.

---

## Non-goals {#non-goals}

- **A filter field.** Twelve recipes in sections do not need one. The user settled leaving it out, and because the sheet reads the catalog it is easy to add once the list grows.
- **New or expanded recipes.** The user will revisit the recipes after this lands. This work gives the existing twelve their new fields and changes nothing else about what they compute, apart from [B12].
- **Replacing `/viz` or its skill.** `/viz` with no arguments still prints `tugtool chart list`, and a request still goes through the skill's rungs.
- **Running the recipe or sending from the sheet.** Draw places the command and stops [B08].
- **Thumbnails or a grid of small multiples.** Rejected in [B06] because a shrunk figure misrepresents the chart.
- **Empty rows for a recipe with no data.** Rejected in [B07] because a sheet of blanks on a new project shows nothing of what the recipes do.
- **Hard-coded recipe descriptions or a deck-side recipe list.** Rejected in [B04] because that is exactly what would make the next recipe a deck change.

---

## Exit {#exit}

An arc. The natural order starts at the catalog: add `tells`, `group` and `sample`, with their test, and fix the day-count wording. Next comes the store's re-read behaviour, then the sheet itself with its live, sample and failed rows and the Draw button, and last the door: the card command, the menu row, the chord and its record in `tuglaws/chord-tiers.md`. The two open questions are answered by looking at the running sheet once it draws.

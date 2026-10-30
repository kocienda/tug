# Chart recipes, a catalogue, and a `/viz` door

**Purpose:** The graphics language landed and its charts look right, but every chart beyond the three data verbs was hand-built from an `awk` pipeline and hand-copied numbers, nothing lists what charts exist, and a developer has no way to ask for one by name. This round fixes what the first showing exposed, makes each well-known chart a verb that computes its own data, publishes the list from that one source, and opens `/viz` as the door onto it.

---

## Purpose {#purpose}

After `tug-graphics-language` joined as `3839c64a4c`, the user asked to see what it could do. The three verbs drew commits per day, suite wall times and app-test history straight into their Bash blocks, and the model wrote eight more `tugchart` fences from numbers it pulled out of git and the ledgers by hand. The user's verdict: "These look *great*." Then three notes.

- A. "Two problems I found while doing this. Need to fix these problems." Those were the sparkline claim in the prompt doc and a dropped row the verb's summary did not name. The two screenshots the user attached showed more.
- B. "We need to make it easier to refer to these kinds of graphics, so the human dev can call for these on demand. Like a list of well-known/available charts and visualizations that we could list out so people know what's available. I want to dig in and build out a great list (using the *most excellent* examples you just showed above)."
- C. "Could we add a new slash command or skill (`/viz`)… then the user could do something like `/viz changes in tugcast over the past 30 days` and get a great visualization."

The sketch's one amendment, which the user accepted by asking for this brief: the list is not a document but a set of **executable recipes**, and `/viz` is a thin door onto them. The charts the user liked were made of one-off pipelines and retyped numbers, which nothing checks and which do not scale. The tool should compute each chart; the model's part is to choose which one, set its scope, and say what it shows.

---

## Evidence {#evidence}

**[F01] The prompt doc claims an inline sparkline the fence cannot deliver** — `tugplug/graphics.md` line 49 says a sparkline is for "a trend at a glance inside a sentence or a table cell", and line 92 says "it lives beside a number". A `tugchart` fence is a block, so a sparkline can only stand alone. **(verified)**

**[F02] `apptest history --chart` drops files without naming them** — `tugrust/crates/tugtool/src/apptest.rs` prints "{plotted} of {n} file(s) with recorded runs" and omits any file with no rows from the chart and from the line. In the showing, a mistyped `at0578` filename became "7 of 8" with no way to tell which one was missing. Row labels are full filenames such as `at0307-transcript-file-path-links-prose.test.ts`, which crowd the row gutter. **(verified)**

**[F03] Every chart draws its title twice in the deck** — the block header built in `tugdeck/src/lib/chart/render-chart.ts` sets `round.table.caption` as its identity span, and the compiler's header pass in `tugdeck/crates/tuggraphics/src/chart/forms/mod.rs` draws `spec.title` again inside the figure. Both screenshots show the same title on the header line and the first line of the SVG. **(verified)**

**[F04] A `sparkline` block's header reads "chart"** — `render-chart.ts` falls back to the literal `"chart"` when the caption is empty, and a sparkline has no title by design. The screenshot shows full block chrome (header, Copy, Table) around a figure a few lines tall, with a placeholder word as its name. **(verified)**

**[F05] Heat cells collapse to hairlines** — `heat.rs` fills `bottom - top` with the cells, and that is whatever is left of the form's default height once the title and subtitle lines are taken. In the commits-by-hour chart the cells are thin dashes with no readable intensity and no values. **(verified)** from the screenshot and the code; the exact default height was not re-measured.

**[F06] Duration axes are not time-aware and overshoot** — `chart/ticks.rs` is a 1-2-5 nice-number axis with no knowledge of `Format::Secs`. The arc-timeline spans chart ticked at `0s`, `1h23m`, `2h47m`, `4h10m` for data ending near 2h49m, so about a third of the plot was empty and no tick fell on an hour. The same axis serves every form, so any `secs` axis has the same shape. **(verified)**

**[F07] Stacked-area end labels lose stack order** — the commits-by-kind chart's right-edge labels read `briefs, other, deck, arcs` top-down, while the stack was `other, briefs, deck, arcs`. `area.rs` hands its ends to `line::end_labels`, whose collision nudging does not preserve the stacking order it was given. **(verified)** from the screenshot; the nudging code was not re-read.

**[F08] Histogram bin edges are not nice numbers** — `histogram.rs` divides the range into equal bins, giving labels like `4s–7.5s` and `7.5s–11s`. A title that says "under 10 seconds" cannot be read off the bars. **(verified)**

**[F09] Bullet history traces cross the bars and value labels** — `bullet.rs` draws the history as a faint line across the whole row, scaled to its own range, so it runs through the value bar and the label. Visible in the screenshot. **(verified)**

**[F10] Today's verbs cannot answer the user's example** — `tugtool log` takes `--limit`, `--range`, `--days`, `--json`, `--chart` and nothing else: no path filter, no lines added or removed. `tugtool diff` gives per-file stats for the tree, the index, a range or the session, with no time window. `tugtool chart` has only `render`. So `/viz changes in tugcast over the past 30 days` has no verb to call, and the model would have to shell to git, which is the retyping this brief exists to end. **(verified)** by `--help`.

**[F11] The eight showing charts were made from ad hoc pipelines** — churn by area, added versus removed, the arc timeline, commits by kind per day, commits by hour, the file-time histogram, the budget bullets and the sparkline all came from `git`, `awk` and `just db-inspect` one-liners, with the numbers pasted into fences by hand. One of those one-liners failed on BSD `sed` and was rewritten; nothing checked the rest. **(verified)**

**[F12] Bare `/viz` already resolves to `tugplug:viz`** — `tuglaws/slash-commands.md`, under *Namespace resolution*: `resolveRemoteCommand()` and `canonicalizeBareCommandLine()` resolve a bare name against the namespaced catalog, and the same resolver answers the popup, submit and the transcript chip. A plugin skill named `viz` is reachable by typing `/viz` with no alias. **(verified)** by reading the law; not exercised.

**[F13] `test last --chart` puts eight suites on one axis** — the emitted spec carries `rust` runs up to about 110 s beside `tugproto` runs of 0.07 s on one `secs` axis, so the short suites lie flat along the bottom. **(verified)** from the spec; the chart itself was not in the user's screenshots.

**[F14] The first brief already deferred two recipes** — `briefs/tug-graphics-language-brief.md` [B12]: "Arc step durations and report gaps follow once the shape is proven." The shape is proven.

---

## Decisions {#decisions}

**[B01] A well-known chart is a recipe: a `tugtool` verb that computes its data and emits the spec.** The model never retypes a number into a catalogued chart [F11]. Recipes live under `tugtool chart <recipe>`, each with a stable name, the one question it answers, its form, and its arguments. The existing `log --chart`, `test last --chart` and `apptest history --chart` stay as they are and share the recipe code behind them. The `tugchart` fence remains the door for one-off questions no recipe answers.

**[B02] Recipes are Rust in `tugtool`, not data or scripts.** They are tested in the workspace, run on any project the app opens, and need no interpreter under the standalone contract. The cost accepted is that a new recipe is a new release. Project-declared recipes in `.tugtool/config.toml` are deferred, not rejected (see Non-goals).

**[B03] The list is generated from the recipes, and reaches the reader three ways from that one source.** `tugtool chart list`, also as `--json`, prints every recipe's name, question, form and arguments. `/viz` with no arguments prints the same list. A gallery card shows one live example per recipe. Nothing hand-maintains a second copy.

**[B04] `tugplug/graphics.md` points at the list rather than carrying it.** The prompt doc rides every session, so a list there is paid for every turn and drifts the moment a recipe is added. It names `tugtool chart list` and the rule in [B01], and keeps the fence teaching for one-off charts.

**[B05] The starting recipe set is the showing's charts plus the two deferred by [B12].** The bar for a recipe is a question someone actually asks, not a form that happens to exist. The set to start from, for the user to argue over:

| Recipe | Question | Form | Data |
|---|---|---|---|
| `commits` | How active has this been? | bar | `log`, gains `--path` |
| `churn` | How much changed here, over time? | stacked area, added and removed | new: numstat per day under a path |
| `hotspots` | Which files or directories change most? | horizontal bar | new |
| `landed` | Where did this commit or range land? | horizontal bar, optionally stacked added/removed | `diff --range` |
| `commit-kinds` | What kind of work was it, by day? | stacked area | new: commit subject prefixes |
| `commit-hours` | When does work land? | heat | new |
| `arc-timeline` | Where did this arc's time go? | spans | new: the arc's record, since the branch is gone at join |
| `suite-times` | Are the suites getting slower? | line | `test last` |
| `test-distribution` | How are test times spread? | histogram | test ledger |
| `test-budget` | Which tests are near their budget? | bullet | apptest ledger |
| `test-history` | What has been red, and when? | dots | `apptest history` |
| `gaps` | Which long commands report nothing? | horizontal bar | `report gaps` |

**[B06] Every recipe takes `--title`, and the default title names the subject.** A verb cannot know the finding, so "Commits per day" is the honest default, even though `graphics.md` tells the model a title states a message. The model, or `/viz`, reads the data and either re-runs with a `--title` that states the finding or writes the finding in the sentence beside the chart.

**[B07] A recipe with no data says so and exits 0.** Tug opens projects that are not this repo. Git recipes run wherever git is. A ledger recipe on a project with no rows prints one plain line and no chart; it is not an error.

**[B08] `/viz` is a user-invoked plugin skill that maps a request to one recipe and runs it.** `tugplug/skills/viz/SKILL.md`, with `disable-model-invocation: true` and `disallowed-tools: Task` like `draft`. Given free text it picks the best-matching recipe and arguments, runs it, reads the numbers, and titles or captions the finding [B06]. Ambiguity takes the best match and says which recipe ran, with no dialog. With no arguments it prints the list [B03]. It reads and draws and never writes a file. Bare `/viz` needs no alias [F12].

**[B09] A request no recipe answers falls back to a one-off fence, and says so.** The skill builds the chart from the data it can read and labels it a one-off. That is how the list grows from real misses rather than from forms we happen to have.

**[B10] The fixes from the showing are this round's first work.** Each is a defect in a landed feature and useful on its own, and every recipe after them shows them off.

- The sparkline claim comes out of `graphics.md` [F01]; a sparkline is a small standalone block.
- `apptest history --chart` names every dropped file in its summary line, and row labels drop `.test.ts` [F02].
- The deck draws a title once: the block header keeps it and the figure omits it. A standalone SVG from `tugtool chart render` has no header, so it still draws its own [F03].
- An untitled chart gets quiet chrome: no placeholder word and a lighter header [F04].
- Heat cells have a guaranteed height and the figure grows to fit [F05].
- A `secs` axis ticks on time boundaries and ends near the data, in `ticks.rs` so every form gets it [F06].
- Stacked-area end labels keep stack order through collision nudging [F07].
- Histogram bins fall on nice edges [F08].
- Bullet history traces stay clear of the bar and label [F09].
- `suite-times` defaults to the suites that matter rather than all eight on one axis; the exact rule is the recipe's to settle [F13].

**[B11] Order of landing.** The fixes [B10], then the data capabilities and recipes with `chart list`, then `/viz`, then the gallery card. The `churn` recipe and `--path` on `commits` come first among the recipes, because they are what the user's own example needs [F10].

---

## Open Questions {#open-questions}

- **The exact recipe set.** [B05] is a starting list and the user said they want to dig in on it. Which entries stay, which merge (`landed` and `hotspots` may be one recipe with a range), and whether `commit-kinds` can infer a project's prefixes without configuration, are for the arc to settle against real use.
- **Where `arc-timeline` reads from.** The branch is gone at join, so the recipe must read the arc's record. Whether the step and round times it keeps are enough for a spans chart is a read of `tugarc-core` the brief did not make.

---

## Non-goals {#non-goals}

- **A hand-written catalogue document.** Rejected: it drifts from what exists the day a recipe is added, and it would be a second copy of [B03].
- **A dialog in `/viz`.** Rejected: the user typed a sentence and wants a chart. Ambiguity is resolved by choosing and saying so [B08].
- **Project-declared recipes in `.tugtool/config.toml`.** Deferred, not rejected. The built-in list has to prove its shape first, as the report runners did before their config rows.
- **A true inline sparkline inside prose or a table cell.** Out of scope. The fence is a block; an inline figure would be a new door, and the doc claim is corrected rather than honoured [F01].
- **`/viz` writing files or specs to disk.** It reads and draws. Saving a chart is `tugtool chart render`.
- **A `tugdraw` fence for the model.** Still deferred by the first brief's [B10].

---

## Exit {#exit}

**An arc.** Its first steps, in the order they must land:

1. The fixes [B10], smallest first: the doc line, the dropped-file naming and label trim, the duplicate title, the sparkline chrome. Then the compiler work: heat height, time-aware `secs` ticks, label order, nice bins, bullet traces. Golden tests move with each.
2. The data capabilities under `tugchanges-core`: `--path` on `log`, and a per-day numstat reader for `churn` and `hotspots`.
3. `tugtool chart <recipe>` and `tugtool chart list --json`, with the three existing `--chart` verbs re-pointed at the shared code.
4. `tugplug/skills/viz/SKILL.md` and the pointer in `graphics.md`, under the standalone contract and `just tugplug-lint`.
5. The gallery card, one live example per recipe.

Each step ends with the chart it touched drawn in the Session card, since the user's eye is the test that found the defects in the first place.

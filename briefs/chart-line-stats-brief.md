# Chart line stats and reach

**Purpose:** The chart recipes that measure work in lines are not clear, and several charts lead nowhere when pressed. This brief records an audit of all 18 recipes and decides how the line figures are computed and drawn from here.

---

## Purpose {#purpose}

The user asked for an audit of charting: "What resources do we currently visualize? commits (obviously). charts like commits and churn should be showing me *better stats* on the lines changed. they're not at all clear now. some charts don't seem to have any visualization." And: "Where do you think these visualizations are working? What can we do to improve them from here?"

So there are three complaints: the line figures do not read, some charts seem to show nothing, and there is no agreed picture of what is covered and what is next.

---

## Evidence {#evidence}

All readings were taken on 2026-11-17 on `main` at `cd59e2c01`, with `./tugrust/target/debug/tugtool chart <recipe> --json` over this checkout and with `git log --since=2026-10-19 --numstat`.

**[F01] Eighteen recipes over six kinds of resource** — `tugtool chart list` names them. Commits by count: `commits`, `commit-kinds`, `commit-hours`, `commit-days`. Commits by lines: `churn`, `commit-size`, `hotspots`, `velocity`, `landed`. Arcs: `arcs`, `arc-timeline`, `arc-stages`. Tests: `test-history`. Bash calls: `gaps`, `calls`. Model use: `tokens`, `cost`, `turns`. Their data sources are the `data:` lines of `tugrust/crates/tugchart-core/src/catalog.rs`. **(verified)**

**[F02] Every recipe draws on this checkout** — all 18 returned `status: ok` with a spec. None answered "nothing to draw", and the slowest read was `velocity` at 3.6 s, far inside the Data Visualization sheet's 30 s read bound (`READ_TIMEOUT_MS` in `tugdeck/src/lib/chart-recipes-store.ts`). A chart with no figure was not reproduced. **(verified)**

**[F03] The line recipes sum raw numstat with no classification** — `read_numstat_log` in `tugrust/crates/tugchanges-core/src/preflight.rs` runs `git log -z --format=… --numstat HEAD`, and `churn`, `commit-size`, `hotspots` and `velocity` in `tugrust/crates/tugchart-core/src/commits.rs` sum what it returns. A binary file counts 0 and a rename counts where it ended up; nothing else is filtered. **(verified)**

**[F04] Tests are 40% of every line figure** — of 607,224 lines changed in 30 days, 325,989 are source (54%), 243,898 tests (40%), 20,620 data files such as JSON fixtures, goldens, `.plist` and `.ai` (3%), and 16,717 docs (3%). The split was by path pattern (`__tests__`, `/tests/`, `.test.`, `TugTests`; `.md`; `.json|lock|ai|plist|svg|toml|snap`), so the boundaries are approximate. **(verified)**

**[F05] `churn` draws a sum nobody wants** — it is a stacked area with `added` under `removed`, so its top edge is added plus removed. The 30-day figures are +439,607 and −167,617, a net of +271,990, and net is not drawn anywhere on it. **(verified)**

**[F06] Arc joins set the scale** — the twelve largest commits of the window are all `tugarc(...)` squash joins, the largest 31,150 lines. There are no merge commits in the window (561 commits, 0 with two parents), so nothing is double counted; a tall day is a day an arc landed. **(verified)**

**[F07] `commit-size` leaves out where the lines are** — it drops the largest tenth: 56 of 563 commits, each over 2,484 lines. The median commit is 124 lines. **(verified)**

**[F08] `hotspots` is too coarse at its default and admits data files** — at depth 2 the top row is `tugdeck/src` with 226,318 lines, and `resources/dmg-preview.ai` and `tugapp/Info.plist` are in the top ten of 261 paths. **(verified)**

**[F09] A line chart's report gives one number per commit** — `measured_rows` in `commits.rs` attaches a single `measure` (lines changed) to each member, and `MemberTable::measured` names one unit. A row of `churn` therefore opens commits with a total, not `+n −m`. **(verified)**

**[F10] Four recipes' marks open nothing useful** — `calls` carries no refs of any kind. `hotspots` and `landed` rows carry `dir:` refs (or `file:` for a lone file) with an empty member table, and `gaps` rows carry `command:` refs with an empty member table, so none opens a report of what is behind its number. **(verified)**

**[F11] Where it works** — the count recipes over commits open their commits from every bar; `test-history` rows link their file and the commits of their runs; `arc-timeline` spans link their sessions; `tokens`, `cost` and `turns` carry members per cell. **(verified)**

**[F12] Resources with no recipe** — unit-suite results (`test-history` reads the app-test ledger only), sessions themselves (how many per day, how long, turn duration), per-session change attribution, and prompt history. This is read from the catalog's data sources against the ledgers `CLAUDE.md` describes, not from a search for demand. **(verified for the absence; the value of each is a judgment)**

**[F13] A stacked bar draws either side of zero; a stacked area does not** — a two-series spec with `added` positive and `removed` negative was compiled with `tugtool chart render` in both forms and looked at. As a `bar` with `"layout": "stacked"` the added bars stand above the zero line and the removed bars hang below it, each with its own value label. As an `area` with `"layout": "stacked"` the two are summed into one band, which is the present chart's fault again. **(verified)**

---

## Decisions {#decisions}

**[B01] Lines are classified once, where numstat is read.** Each file of a numstat read is one of `source`, `tests`, `data` or `docs`, decided by path, and every line recipe reads the classified result. One classifier means `churn`, `velocity`, `hotspots`, `commit-size` and `landed` cannot disagree about what a line is. [F03] [F04]

**[B02] The classification is the project's to state, with defaults in the binary.** The patterns ship as built-in defaults and a project overrides them in `.tugtool/config.toml`, since Tug runs on projects whose tests and generated files live elsewhere and nothing in the plugin may assume this checkout's layout.

**[B03] Line recipes count source and tests by default and say what they left out.** `data` and `docs` are excluded unless asked for, and the subtitle names the lines left out, as `commit-size` already names the commits it did not draw. This removes `.ai`, `.plist` and fixture JSON from `hotspots` without hiding that they changed. [F04] [F08]

**[B04] `churn` is redrawn as a stacked bar, added above zero and removed below, with net.** The stacked sum goes. `removed` is carried as negative values, which the engine already draws below the axis in a stacked bar, so no engine change is needed for the default. Net is stated, because net growth is the number the chart is consulted for. `churn` also offers `--form line` and `--form area`, and neither may fall back to the summed band: each needs a drawing that keeps added and removed apart, or the form is withdrawn from the recipe. [F05] [F13]

**[B05] `churn` and `velocity` can split by kind of file.** An option draws the same window as series of source and tests, so the share of a week that was tests is visible. [F04]

**[B06] `hotspots` chooses its depth from the data.** With no `--depth`, it descends until no row holds more than about a third of the total, so the default answer names something a reader can act on. An explicit `--depth` still wins. [F08]

**[B07] A line recipe's report rows carry added and removed apart.** The member measure for these recipes becomes a pair, shown as `+n −m`, so the report agrees with the redrawn `churn`. [F09]

**[B08] Every recipe's marks open a report.** `hotspots` and `landed` rows open the files under the path and the commits that touched them; `gaps` rows open the calls behind the head; `calls` bins open their calls. A mark that opens nothing reads as a chart with nothing behind it. [F10]

**[B09] The outlier commits stay visible.** `commit-size` keeps its trimmed histogram but its largest tenth becomes reachable (a final "over n" bin whose members are those commits), and the line recipes do not clip or rescale days that an arc join made tall. The joins are real work; hiding them would make the charts lie the other way. [F06] [F07]

**[B10] New resources come after the line work.** Unit-suite history and a sessions recipe are wanted, and they do not depend on the classifier, so they land last and can be dropped from the arc without harming the rest. [F12]

---

## Open Questions {#open-questions}

- **What did "some charts don't seem to have any visualization" refer to?** Every recipe drew here [F02]. The two candidates are marks that open nothing [F10], which [B08] answers, and rows of the Data Visualization sheet that drew their sample, marked "Sample", because a read had no data or failed. The second would be a defect this brief does not cover; the user naming the rows would settle it.
- **Where is net stated?** A bar chart has no line overlay today, so net is either a figure in the subtitle and the summary, or a new mark in the engine. The subtitle is the default unless the plan finds the mark is cheap.
- **What do `churn --form line` and `--form area` draw?** [B04] rules out the summed band; whether they draw two overlapping series, a net series, or are withdrawn is not settled.

---

## Non-goals {#non-goals}

- **Excluding arc joins or other large commits from line totals.** Considered as a way to steady the scale and rejected: there are no merge commits to double count, and a join's lines are the arc's work. [F06]
- **A log scale for the line charts.** It would flatten the tall days and make added-against-removed unreadable.
- **Counting by blame, by token or by any measure other than numstat lines.** The complaint is that the existing figures are unclear, and classification and a better drawing answer it.
- **Charts of prompt history or per-session attribution.** Named in [F12] as uncovered and left out here; nobody has asked a question they would answer.
- **Changing the count recipes, the arc recipes or the model recipes.** They work. [F11]

---

## Exit {#exit}

**An arc.** The order that matters:

1. The classifier and its config row, in `tugchanges-core` beside the numstat readers, with the classified result available to every line recipe. [B01] [B02]
2. The default exclusion and the left-out subtitle across `churn`, `velocity`, `hotspots`, `commit-size` and `landed`. [B03]
3. `churn` redrawn, once the open question about two series either side of zero is settled by compiling a spec. [B04]
4. The split by kind of file, the adaptive `hotspots` depth, and the reachable outliers in `commit-size`. [B05] [B06] [B09]
5. Added and removed as a pair in the member measure and the report row. [B07]
6. Reports for `hotspots`, `landed`, `gaps` and `calls`. [B08]
7. Unit-suite history and a sessions recipe. [B10]

Steps 1 and 2 answer the complaint about lines on their own. The catalog samples in `tugrust/crates/tugchart-core/catalog.json` and the recipe tests in `tugrust/crates/tugtool/tests/chart_recipes_cli.rs` move with each recipe that changes shape.

# Chart Recipes Revisit

**Purpose:** The twelve `/viz` recipes were written to prove the chart engine, and the Data Visualization sheet now shows them side by side. Read as a set, some groups are strong, one is a mishmash of timing charts nobody acts on, the arc chart puts its audit in the wrong place, and two things the user wants to see, code velocity and token use by model, have no recipe at all.

---

## Purpose {#purpose}

The user reviewed the sheet group by group:

> - The ACTIVITY charts are great. Love them. Any more we can add here?
> - CHANGES are good, too. Some kind of *code velocity* metric here would be great, i.e. lines changed over a time period.
> - ARCS is a little confusing as it is. We need to be more clear about the ordering. Audit bar should come *last*, not after implement. We should name the arc more clearly in the chart title. We should number the steps more clearly. We should say how many total steps there were. We could also give stats about the *number* of arcs run recently, eh?
> - TESTS is the least effective to me, since it just kinda mishmashes different tests together. The timing isn't all that interesting, since they should just be quick (or as quick as possible) all the time.
> - TELEMETRY is interesting.
> - MODELS. Can we include some kind of token usage over time, perhaps broken down by model?

The work is three things at once: fix what reads wrong, cut what nobody acts on, and add the recipes the records can already answer. The Data Visualization sheet reads the catalog and names no recipe, so none of this touches the sheet.

---

## Evidence {#evidence}

**[F01] The catalog is one list and every surface reads it.** `RECIPES` in `tugrust/crates/tugchart-core/src/catalog.rs` holds the twelve rows, each with `name`, `question`, `tells`, `group`, `form`, `data`, `args`, `sample` and `run`. `tugtool chart list`, its `--json`, tugcast's `GET /api/chart/list` and the sheet all read it through `catalog_json()`. The run functions live in `commits.rs`, `arcs.rs`, `gaps.rs` and `tests.rs` (used as `test_recipes`). **(verified)**

**[F02] Tests pin the catalog's shape.** `tugrust/crates/tugtool/tests/chart_recipes_cli.rs` asserts 12 recipes and 36 list lines and reads the `commits` line's text; `tugchart-core` tests pin the section order `Activity, Changes, Arcs, Tests, Telemetry`, require a `tells` ending in a period, a non-empty `group` and a sample whose form the recipe claims; `tugrust/crates/tugchart-core/catalog.json` is a dump held equal to the catalog and regenerated with `TUGCHART_BLESS=1 cargo nextest run -p tugchart-core`; and `tugdeck/src/lib/__tests__/chart-recipe-samples.test.ts` compiles every sample through the real engine. Every recipe added or cut moves these. **(verified)**

**[F03] The arc chart lists every stage before every step.** `arc_chart` in `tugrust/crates/tugchart-core/src/arcs.rs` chains `stages` then `steps`, so the audit stage, which starts after the last step, is drawn among the stages above the steps. Its title is `Arc <name>: stages and steps`; a step's label is the plan heading with backticks stripped, or `step N` when the heading is absent; the summary counts stages and step spans and never says the plan's total. The log's `step-start` note already carries `n/total` (for example `1/3 Step 1: First`), so the total is on hand. **(verified)**

**[F04] The arc log can count arcs.** The project's log at `~/Library/Application Support/Tug/projects/<slug>/arc-log.md` holds 14,129 lines: 381 `arc-start`, 334 `joined`, 29 discards, 318 `arc-done`, 328 `audited`, and 878 `arc-stage` lines of which 82 are `devise`, 81 `review`, 393 `implement` and 322 `audit`. 148 arcs started in October 2026. `tugarc_core::timeline` already folds the log into per-arc stages, steps and a typical audit time. **(verified)**

**[F05] The session ledger holds per-turn tokens and cost, with the model on the session.** `turn_telemetry` in tugcast's `sessions.db` carries `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `total_cost_usd` and `ended_at` per turn; `sessions` carries `project_dir` and `stage_model`; `session_metadata` carries the live `model` in its JSON payload. The live `release-main` ledger has 1,054 turns from 2026-10-21 to 2026-10-30 across 244 sessions, 706k output tokens, 193M cache-read tokens and about $5,337 of cost. There is no per-turn model column. **(verified)**

**[F06] The model is named three ways.** Grouping that ledger by day and model gives rows named `opus` (from `stage_model` on arc stage sessions), `claude-opus-5-5`, `claude-fable-5-1`, `claude-fable-5-1[1m]` and `claude-sonnet-5-5`. A chart by model has to fold these into one family name each. **(verified)**

**[F07] The ledger is per instance and tugchart-core cannot link tugcast.** `tugchart-core` depends on `tugcore` only. The session index sets the pattern for a cross-crate read: `tugcore::session_index` opens its database with `SQLITE_OPEN_READ_ONLY` and treats a missing file or table as an empty answer. A read-only open of the instance's `sessions.db` along the same lines is how a recipe reaches the telemetry; `ctx.paths` already names the instance. **(verified for the pattern; the reader itself does not exist)**

**[F08] The test recipes measure time in three of four cases.** `suite-times` plots wall time per suite run by run, and because `rust` and `tsc` mix scoped and full runs the line swings from under a second to 107 s and shows no trend; `test-distribution` is a histogram of file times; `test-budget` sorts by median but draws the latest run as its value, so one slow run tops the chart. Only `test-history`, the red and green dots, is about whether tests pass. **(verified)**

**[F09] The gaps record keeps every call's wall time.** `report_gaps.db` holds `call_times` with `head`, `wall_ms` and `ended_at_ms` for the most recent 20,000 foreground Bash calls, and `tugtool report gaps` already reads it. **(verified)**

**[F10] Two thumbnails misread at the sheet's size.** `hotspots` draws 20 rows and is illegible in a 220 px box; `commits` over 90 days draws 90 bars and its first axis label truncates. **(verified by looking at the sheet)**

**[F11] `churn` already draws lines per day.** It draws added and removed as two series per day over `--days`. A per-day two-series chart does not answer whether throughput is rising or falling over a quarter. **(verified)**

---

## Decisions {#decisions}

**[B01] The set is refined to seventeen recipes in six groups, with Tests shrinking to one.** The user agreed the sketch's recommendations with one change: Tests keeps only `test-history`. The final set is:

| Group | Recipes |
|---|---|
| Activity | `commits`, `churn`, `commit-kinds`, `commit-hours`, `commit-size`, `commit-days` |
| Changes | `hotspots`, `landed`, `velocity` |
| Arcs | `arc-timeline`, `arcs`, `arc-stages` |
| Tests | `test-history` |
| Telemetry | `gaps`, `calls` |
| Models | `tokens`, `cost`, `turns` |

**[B02] `suite-times`, `test-distribution` and `test-budget` are removed.** They are timing charts and the user's position is that tests should be quick all the time, so their time is not a finding. `suite-times` also shows no trend because scoped and full runs share a line [F08]. Removal is removal: the rows, their run functions and their tests go, and the pinned counts move [F02].

**[B03] `arc-timeline` draws its rows in time order, so the audit falls last.** One sort over the chained stage and step rows by start time replaces the stages-first chain [F03]. Stage labels read `Devise`, `Review`, `Implement`, `Audit`. Step labels carry their number and the plan's total, `3/5 Build the sheet…`, read from the `step-start` note. The title becomes `Arc <name>: N steps, <duration>` and the summary says how many of the N steps finished. The arc test that pins the item order moves with it, asserting the same spans in time order.

**[B04] `arcs` counts arcs per week.** A stacked bar over the arc log of arcs started, joined and discarded per week over `--days` (default 90), with joined as `good` and discarded as `bad`. It answers the user's "how many arcs run recently" [F04].

**[B05] `arc-stages` compares recent arcs.** A horizontal stacked bar, one row per arc for the newest `--limit` arcs (default 8), of time in each stage from the timeline fold [F04]. It makes arcs comparable, which the timeline of one arc cannot.

**[B06] `velocity` is its own recipe in Changes.** An area of lines changed per week over `--days` (default 90), with a rule at the median week and a `--net` flag for added minus removed. It is not a `--by week` on `churn`, because its question, is throughput rising or falling, differs from churn's, which is how much changed on each day [F11].

**[B07] `commits` gains `--by week`, and `hotspots` defaults to ten rows.** The weekly bucket makes 90 days read as 13 bars and ends the truncated first label; ten rows keep `hotspots` legible as a thumbnail [F10]. The day window's meaning, N calendar days from local midnight, is unchanged.

**[B08] Activity gains `commit-size` and `commit-days`.** `commit-size` is a histogram of lines changed per commit, which tells whether work lands small or big. `commit-days` is a heat strip of commits by weekday, the pair of `commit-hours`. Both read the same log the other Activity recipes do.

**[B09] Telemetry gains `calls`.** A histogram of Bash call wall times from `call_times` [F09]. `gaps` is its tail.

**[B10] Models is a new group of three recipes over the session ledger, scoped to the project.** `tokens` draws output tokens per day stacked by model, with `--kind` selecting `output` (default), `input`, `cache-read` or `cache-creation`, because cache reads outnumber output by three orders of magnitude and would flatten everything else on one axis [F05]. `cost` draws dollars per day by model. `turns` draws turns per day by model. All three take `--days` (default 30) and read only sessions whose `project_dir` is the project, like every other recipe; a machine-wide view is not this work.

**[B11] Model names fold into families.** A recipe maps `opus`, `claude-opus-5-5` and any `[1m]` suffix onto one family name, so a day has one bar per family [F06]. The fold lives beside the reader so every Models recipe shares it.

**[B12] The ledger is read through a read-only reader in `tugcore`.** It follows `session_index`: `SQLITE_OPEN_READ_ONLY`, a missing file or table is an empty answer, no schema is created [F07]. The reader exposes the per-day sums the three recipes need and nothing more. It redirects with the same environment variable the instance's paths already honour, so a test can point it at a scratch ledger.

**[B13] Every recipe keeps the sheet's contract.** Each new row carries `tells`, a `group` and a `sample`, the section order gains `Models` at the end, and the dump and pinned counts are regenerated [F02]. The sheet changes nothing.

---

## Open Questions {#open-questions}

- **Which `--days` default suits `arcs` and `velocity`.** The sketch says 90 for both because a weekly bucket needs weeks to show. The arc that lands them should look at the figures over this project and pick.

---

## Non-goals {#non-goals}

- **Any change to the Data Visualization sheet.** It reads the catalog [F01]; a recipe that would need a deck change is the wrong design.
- **A machine-wide Models view.** Rejected in [B10]; every recipe answers for the project it runs in.
- **A per-turn model column in the ledger.** The session's model is enough to attribute its turns [F05]; a schema change buys nothing here.
- **Keeping `test-budget` with a median value.** The sketch offered it; the user chose a one-recipe Tests group.
- **A `--by week` flag on `churn` instead of `velocity`.** Rejected in [B06].
- **Two scales on one axis for tokens.** Output and cache-read tokens are separate draws through `--kind` [B10].

---

## Exit {#exit}

An arc. The natural order starts with the cuts and the arc chart, since they move the pinned counts and the item-order test: remove the three test recipes, fix `arc-timeline`'s order, title and labels. Then the git-log additions and flags, which share one module: `velocity`, `commit-size`, `commit-days`, `--by week` on `commits`, ten rows on `hotspots`. Then the arc log additions, `arcs` and `arc-stages`, over the existing timeline fold. Then `calls` over the gaps record. Last the Models group, which needs the `tugcore` reader and the name fold before its three recipes. Each landing regenerates the dump and keeps the sample test green.

<!-- brief-skeleton v1 -->

# Chart ref reports

**Purpose:** A press on a chart mark that stands for many things opens a list of bare pills. It should open a report: one row per thing, drawn the way the app draws that thing elsewhere, with the number it contributed, paged so that a set of any size can be read.

---

## Purpose {#purpose}

The chart cross-references arc (`6b08929a4`) gave chart rows and marks refs, and `5e56ffc1f` laid the set list in flow under the figure so it is no longer clipped. With the press and the data plumbed, the user asked for the next thing:

> now we *need to do more than simply list the associated data*. We need to *plus* this display, and make it more of a report, a listing of commits, arcs, etc. For commits, I think we can borrow from the *history* display.

The panel today answers "which 15 commits?" with fifteen `commit:b9180493` pills. The reader learns nothing about any of them without opening each one. Sets over 100 members open nothing at all.

---

## Evidence {#evidence}

**[F01] The set panel is a wrapping row of ref pills and nothing else** — `tugdeck/src/lib/chart/chart-ref-set.ts` appends a `.tugx-chart-set-list` to the figure holding a head ("15 commits") and one ref host per member; the annotator stamps each host and the surface's portals mount a pill or chip into it. The module says of itself that "nothing here knows what a commit is". **(verified)**

**[F02] The panel is imperative DOM inside the figure because the chart has two doors** — the React block (`chart-block.tsx`) and the markdown fence both render through `renderChartInto`. The module's docblock records that "a React popover would need a React parent the fence door does not have". React content reaches the figure only as portals into hosts the annotator's walk discovers (`tugdeck/src/components/tugways/annotation-portals.tsx`). **(verified)**

**[F03] The History row is reusable as a component but not from the data the deck holds for a chart ref** — `HistoryList` (`tugdeck/src/components/tugways/cards/session-history/history-list.tsx`) takes `commits: GitLogCommit[]` and a `projectDir`, and builds its row from the shared `CommitIdentityLine`, `CommitMetaCell`, `CommitCopyControl` and `CommitRecordBody`. A `GitLogCommit` carries the body, the committer, and the `Tug-Arc` and `Tug-Session` trailers that drive the join badge and the session citation. **(verified)**

**[F04] No query returns a `GitLogCommit` for a named sha** — `GIT_LOG_QUERY` takes `{root, requestId, offset, limit}` and pages recent history only (`tugdeck/src/lib/git-log-store.ts`). The one by-sha path is `CommitResolutionStore` (`tugdeck/src/lib/annotator/commit-resolution.ts`), which asks `GIT_COMMIT_FILES_QUERY` and yields `CommitFacts`: subject, author, date and files. It has no body and no trailers, and its queries "drain one at a time" over a shared single-slot feed, so a page of 25 shas is 25 sequential round trips. **(verified)**

**[F05] `arcCitationStore` answers only fate and join sha** — a `CitedArcAnswer` is `pending`, `missing`, or `found` with `fate: "live" | "joined"` and an optional `joinSha` (`tugdeck/src/lib/arc-citation-store.ts`). Start and end times, rounds and the owning session are not in it. **(verified)**

**[F06] A slot holds at most 100 members and a spec at most 800; past either, the slot is a bare count** — `set_slots` in `tugrust/crates/tugchart-core/src/refs.rs` writes `{"kind", "count"}` when a bucket exceeds `MAX_SET` or the `RefBudget` cannot carry it. A count-form slot carries no `data-tugx-ref-set` and so opens nothing ([L31] in `chart-ref-set.ts`). **(verified)**

**[F07] Two recipe specs already sit at about 27 KB against the 30,000-character Bash result limit** — measured during the `chart-cross-references` audit. Anything added per member to the spec is paid against that margin. **(verified in that audit, not re-measured here)**

**[F08] tugcast already runs recipes for the deck** — `GET /api/chart/list` and `GET /api/chart/<recipe>?project=<dir>` are served from `tugrust/crates/tugcast/src/server.rs` and read by `tugdeck/src/lib/chart-recipes-store.ts`. The recipes live in `tugchart-core`, which tugcast links. **(verified)**

**[F09] Which recipes emit which kinds** — commit sets: `commits.rs` (the seven activity recipes) and the dots of `test-history`; file refs: `test-history` rows and the path recipes; session sets: `models.rs` (`tokens`, `cost`, `turns`); arc sets and single arc refs: `arcs.rs`; a session ref per stage: `arc-timeline`; command refs: `gaps.rs`. Read from the emitters' call sites; I did not run each recipe to confirm what its spec carries today. **(read, not run)**

---

## Decisions {#decisions}

**[B01] The panel becomes a report with three parts: a header, rows, and a measure column.** The header says what was pressed and what it sums to ("2026-10-23 · 57 commits") and carries Copy and a close control. Each row is one member, drawn as that kind is drawn elsewhere in the app. The measure column shows the member's share of the mark where the chart counted something other than 1, so the column sums to the bar. The open and close behaviour of `5e56ffc1f` is unchanged: in flow under the plot, one per page, closed by Escape, an outside press, a second press on the anchor, or a re-render.

**[B02] A single ref keeps opening the thing it names; reports are for sets.** One thing has nothing to list, and a direct open is the shorter path. The exceptions are `dots` and `spans`, whose marks are single but carry facts the click target does not: a dot is one test run (status, when, duration, head commit) and a span is one arc stage (start, end, duration, the session that ran it). Those open a one-row report.

**[B03] Paging is part of the report from the first step.** A report shows a first page of 25 rows and a foot row that says how far it has got ("25 of 340") and pages in the next 25. The cap exists for two reasons: row identity is fetched, not carried, so an unpaged set of 100 is 100 lookups before the first paint; and it is what lets a set of any size open at all. With paging in place the count-form slot of [F06] stops being a dead end.

**[B04] A recipe's spec names its source, and a report's pages are read from that source.** The spec gains a top-level `source`: the recipe name and its arguments resolved to absolute values (a date range, never `--days 30`; a path; a depth). tugcast serves a members read beside the recipe read of [F08], addressed by source, row, series, offset and limit, answering one page of row records and the set's total. This is the query the user's paging decision needs, and it puts the membership question to the one thing that can answer it: the recipe that counted. A slot whose members did not fit in the spec is opened this way; so is a slot whose members did fit, since the page carries the row facts the pills lack.

**[B05] The measure column rides the page, not the spec.** The sketch put per-member numbers in the spec for the recipes whose measure is not 1 (`churn`, `velocity`, `commit-size`, `tokens`, `cost`, `turns`). Once [B04] exists the members read returns each member's measure with its row, so the spec grows by one small `source` object instead of up to 800 numbers, and the margin of [F07] is left alone. The column appears for the same six recipes; only where the numbers travel has changed. A hand-written fence has no source and so no measure column, which is accepted: its author can put the numbers in the chart.

**[B06] One row record per kind, served by tugcast, reached two ways.** A page comes either from a source ([B04]) or, for a spec with no source (a fence written by hand), from a describe read that takes a page of inline refs and answers the same row records. This settles [F04] and [F05] in one place rather than per store: the commit record is the `GitLogCommit` shape, so `HistoryList`'s row components are mounted unchanged; the arc record adds what `arcCitationStore` lacks. The existing resolvers keep their job, which is deciding whether a ref is real; a ref the describe read cannot find is drawn as plain text, as the annotator already rules.

**[B07] Every kind gets a report row; none stays a bare pill.**

| Kind | Row | Folds open to |
|---|---|---|
| `commit` | `sha : subject`, arc-join badge, session citation, author and date, from the History row's own components | the message and changed files (`CommitRecordBody`) |
| `session` | the citation chip, title, project, last used | nothing in the first pass |
| `arc` | the arc atom, fate (live, joined, discarded), join commit, started and ended, rounds | nothing in the first pass |
| `file`, `dir` | the path with the file hover | the commits behind it, as a nested page of commit rows |
| `command` | the command head in the code face, run count and total time | nothing |
| `url` | host and path | nothing |

**[B08] The report body is a portal host; the panel stays imperative.** `chart-ref-set.ts` goes on building, placing and closing the panel as DOM, and stamps one host for the report body. `useAnnotationPortals` mounts a React `ChartRefReport` into it, the same way pills reach the figure today ([F02]), so both doors are served and nothing about opening is React state. The report's pages enter React through a store and `useSyncExternalStore` [L02].

**[B09] What a press reports follows the form.**

| Form | The press | The report |
|---|---|---|
| `bar`, `line`, `area` | a bar or point | that category's members |
| stacked `bar`, `area` | a segment, or the row label | the segment's members; the label reports the whole row grouped by series |
| `heat` | a cell | members grouped by date, since an hour-of-day cell spans many days |
| `histogram` | a bin | the bin's samples sorted by value, each with its own size |
| `dots` | a dot, or the row label | the one run ([B02]); the label reports the file's run history |
| `spans` | a span | the one stage ([B02]) |
| `bullet`, `scatter` | an item or point | single refs, opened directly ([B02]) |
| `sparkline` | none | it has no refs |

**[B10] When the source's answer differs from the drawn mark, the report says so.** A chart in a transcript is a picture of a past reading, and the repository moves. The header shows the total the members read returned; when that is not the number on the mark, one muted line says the chart was drawn from an earlier reading. The report never pads or trims rows to match the picture. Absolute arguments in `source` ([B04]) keep this rare.

**[B11] Commits land first, then sessions and arcs, then files, commands and urls, then the per-form headers and grouping.** Commits come first because the row exists and the most recipes emit them ([F09]). The order is of landing only: [B07] is the scope, and the arc is not done while any kind is still a pill.

---

## Open Questions {#open-questions}

- **How tall may the panel grow when a row is unfolded?** The panel is capped at `16rem` and scrolls. A commit row unfolded to its message and file list can be taller than that by itself. Whether the panel lifts its cap while a row is open, or the detail scrolls inside it, is a matter of how it feels and wants a look in the running app before it is fixed.
- **Does the test ledger hold what a dot's report shows?** [B02] names status, when, duration and head commit for one run. The `test-history` recipe reads the ledger and has the status and the head sha; I did not check that per-file duration and timestamp are read by it today. Reading `tugrust/crates/tugchart-core/src/tests.rs` settles it.

---

## Non-goals {#non-goals}

- **Carrying row identity in the spec.** Subjects, titles and fates in the spec would make a report work with no fetch, and would blow the margin of [F07] on the first large chart. Identity is fetched.
- **A filter field or sort control in the report.** History has a filter; a report of one bar's members is already a filtered set. Revisit if paged sets of hundreds prove hard to read.
- **A hand-off to the History card filtered to the report's members.** It needs a by-range filter History does not have, and the report is meant to make the trip unnecessary.
- **Reports for single refs beyond `dots` and `spans`.** Rejected in [B02].
- **Floating the report over the figure.** Rejected by `5e56ffc1f`: the figure clips, and a heat strip cannot hold a floated panel at any placement.

---

## Exit {#exit}

An arc. A shape for its first steps, in the order they depend on each other:

- `source` on the spec: the field in `tuggraphics`' chart spec, stamped by every recipe with absolute arguments, ignored by the renderer.
- The members read and the describe read in tugcast, answering commit row records first, with the set total and a member's measure.
- The report: a page store on the deck, the portal host stamped by `chart-ref-set.ts`, `ChartRefReport` mounting the History row components, the header, the foot row and paging. Count-form slots with a source become pressable here.
- The measure column for `churn`, `velocity`, `commit-size`.
- Session and arc row records and rows, with the measure for `tokens`, `cost`, `turns`.
- File and directory rows with their nested commit page; command and url rows.
- Per-form headers and grouping: stacked segment against row label, `heat` by date, `histogram` by value, the one-row reports of `dots` and `spans`.
- The docs that describe refs to the model (`tugplug/graphics.md`) gain `source` and lose the claim that a count form "has no list to open".

`at0842` and `at0843` are the app-tests that drive the panel today and are where the report's assertions belong.

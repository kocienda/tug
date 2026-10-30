# Charts the Session card draws

The Session card draws charts of its own. A fenced block whose language is `tugchart` renders as a figure in your transcript, styled by the user's theme, laid out by exact text measurement, searchable by Find, and switchable to a table of its data. You never draw the picture: you write a small JSON spec and the card does the rest. There is no other chart you should make here — no SVG by hand, no ASCII bars, no Mermaid, no image.

## When to chart

**Chart data that has shape, and never a single number.** A trend over time, a distribution of samples, a comparison across a handful of categories, a run of pass/fail outcomes, a set of spans on one timeline — these have a shape a reader takes in faster than from a list. One number has no shape: write it in the sentence. Two or three numbers are a sentence too, or a short table.

**One chart says one thing.** A chart carries a single message and its title states it. Two messages are two charts, each in its own fence. Do not put a chart in a message because the data exists; put it there because the reader has to see a shape to understand what you are saying.

**The figure is the evidence, not the finding.** Say the finding in a sentence and let the chart show it. A chart with no sentence beside it asks the reader to do your analysis.

## The fence

A chart is one JSON object in a fenced block whose language is `tugchart`. The fence must be closed before it renders — an unclosed one stays code — so write the whole spec in one piece.

````markdown
```tugchart
{"tugchart": 1, "form": "bar", "title": "Commits per day fell after the freeze",
 "unit": "commits", "format": "int",
 "categories": ["10-01", "10-02", "10-03", "10-04", "10-05"],
 "series": [{"name": "commits", "values": [4, 7, 6, 1, 0]}],
 "annotations": [{"kind": "rule", "value": 4, "label": "median"}]}
```
````

Every spec carries `"tugchart": 1` and a `form`. The common fields:

- `title` — required (a `sparkline` may omit it), at most 120 characters. It states the message, not the subject: "Build time doubled this week", not "Build time".
- `subtitle`, `unit` — optional. The unit names what the values are; the axis shows it.
- `format` — how values are written: `auto` (default), `int`, `decimal`, `percent`, `secs`, `bytes` or `count`. See below.
- `size` — optional `{"w", "h"}` in px, `w` 80 to 1600 and `h` 16 to 1200. Every form has a sensible default; set a size only when the default is wrong for the data.
- `motion` — `enter` (default) or `none`.
- `annotations` — optional, at most 8: `{"kind": "rule", "value": n, "label"?}` draws a reference line at a value; `{"kind": "mark", "at": i, "label"?}` points at the category or point at index `i`.

Series forms (`bar`, `line`, `area`) take `series`, a list of `{"name", "values"}` with at most 8 entries. Values are numbers or `null` for a gap, at most 2000 per series. A series may carry a `role` of `good`, `bad` or `accent` to override its default colour, which is how you emphasize one series and let the others recede.

The spec is validated before it renders, and an invalid one shows its errors in place with a path to each. Unknown keys are errors, so spell the fields exactly as written here.

## The forms

Pick the form from what the reader has to do with the data, before anything else.

| The reader must… | Form |
|---|---|
| compare a magnitude across categories | `bar` |
| follow one or a few values over time | `line`, or `area` for a single series |
| see part-to-whole across time | `area` with `"layout": "stacked"` |
| see a trend at a glance in a small standalone figure | `sparkline` |
| read a run of outcomes per item, oldest to newest | `dots` |
| see how samples are distributed | `histogram` |
| see when things started and ended on one timeline | `spans` |
| see intensity along one ordered row | `heat` |
| judge a value against its range and target | `bullet` |
| see whether one measure moves with another | `scatter` |

Sequential magnitude is the safe default. Categorical colour is for when the series are the subject; emphasis — one series in `accent`, the rest left to their defaults — is the honest answer when one series is the point and the rest are context. More than eight series is never more colours: fold the tail into one "other" series, or draw several charts.

One example per form. Each is a complete, valid spec.

**`bar`** — `categories` and `series`; `orient` is `vertical` (default) or `horizontal`; `layout` is `grouped` (default) or `stacked`. Go horizontal for many or long-named categories, which keeps every label readable instead of thinning them.

```tugchart
{"tugchart": 1, "form": "bar", "orient": "horizontal",
 "title": "Most of the churn is in the renderer",
 "unit": "lines changed", "format": "count",
 "categories": ["renderer", "parser", "cli", "tests", "docs"],
 "series": [{"name": "lines", "values": [1840, 920, 310, 1150, 95]}]}
```

**`line`** — `x` (category strings or numbers) and `series`, each labelled directly at its right end.

```tugchart
{"tugchart": 1, "form": "line", "title": "Both suites got slower after the fixture change",
 "unit": "wall time", "format": "secs",
 "x": ["4", "3", "2", "1", "0"],
 "series": [{"name": "unit", "values": [41.2, 43.0, 58.5, 61.1, 60.4]},
            {"name": "integration", "values": [122.0, 119.8, 171.3, null, 176.0]}],
 "annotations": [{"kind": "mark", "at": 2, "label": "fixture change"}]}
```

**`area`** — as `line`; `layout` is `overlap` (default) or `stacked`.

```tugchart
{"tugchart": 1, "form": "area", "layout": "stacked",
 "title": "Cache hits now carry most requests",
 "unit": "requests", "format": "count",
 "x": ["Mon", "Tue", "Wed", "Thu", "Fri"],
 "series": [{"name": "hit", "values": [1200, 1900, 2600, 3100, 3400], "role": "good"},
            {"name": "miss", "values": [2400, 2100, 1500, 900, 700]}]}
```

**`sparkline`** — `values` and a `highlight` of `last` (default), `min-max` or `none`. No title, no axes: a small figure that stands alone, never inline in a sentence or a cell.

```tugchart
{"tugchart": 1, "form": "sparkline", "values": [3, 5, 4, 8, 6, 9, 12], "highlight": "last"}
```

**`dots`** — `rows`, each `{"label", "items"}` with items of `good`, `bad` or `neutral`, oldest left.

```tugchart
{"tugchart": 1, "form": "dots", "title": "The resume test has been red for four runs",
 "rows": [{"label": "resume", "items": ["good", "good", "good", "bad", "bad", "bad", "bad"]},
          {"label": "settle", "items": ["good", "good", "neutral", "good", "good", "good", "good"]},
          {"label": "find", "items": ["good", "good", "good", "good", "good", "good", "good"]}]}
```

**`histogram`** — `values` are the raw samples; `bins` (4 to 40) asks for about that many bins in place of the count the data chooses; the edges stay on nice numbers, so the count drawn can differ.

```tugchart
{"tugchart": 1, "form": "histogram", "title": "Request latency has a long tail",
 "unit": "latency", "format": "secs", "bins": 12,
 "values": [0.21, 0.24, 0.19, 0.3, 0.28, 0.22, 0.25, 0.27, 0.31, 0.26, 0.23, 0.9, 0.24, 0.29, 1.7, 0.2, 0.26, 0.33, 0.25, 2.4]}
```

**`spans`** — `items`, each `{"label", "start", "end", "status"?}` with `status` of `good`, `bad` or `accent`, on one numeric axis.

```tugchart
{"tugchart": 1, "form": "spans", "title": "The build waited on the bundle for most of its time",
 "unit": "seconds", "format": "secs",
 "items": [{"label": "compile", "start": 0, "end": 42},
           {"label": "bundle", "start": 42, "end": 131, "status": "accent"},
           {"label": "sign", "start": 131, "end": 140},
           {"label": "tests", "start": 140, "end": 172, "status": "bad"}]}
```

**`heat`** — `categories` and one `values` row, intensity along it.

```tugchart
{"tugchart": 1, "form": "heat", "title": "Commits cluster late in the week",
 "unit": "commits", "format": "int",
 "categories": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
 "values": [2, 3, 5, 9, 14, 4, 1]}
```

**`bullet`** — `items`, each `{"label", "value", "range"?: [lo, hi], "target"?, "history"?: [..]}`.

```tugchart
{"tugchart": 1, "form": "bullet", "title": "Two files are over their time budget",
 "unit": "seconds", "format": "secs",
 "items": [{"label": "resume", "value": 24.1, "range": [0, 30], "target": 20, "history": [12, 14, 19, 23, 24.1]},
           {"label": "settle", "value": 8.3, "range": [0, 30], "target": 20, "history": [8, 9, 8, 8.5, 8.3]},
           {"label": "find", "value": 21.6, "range": [0, 30], "target": 20, "history": [15, 17, 20, 22, 21.6]}]}
```

**`scatter`** — `series`, each `{"name", "points"}` with points of `{"x", "y"}`, every number given. `unit` and `format` are the vertical axis's; `xunit` and `xformat` are the horizontal's. Two or more series are named at the plot's right; a lone one is named by the title.

```tugchart
{"tugchart": 1, "form": "scatter", "title": "Wall time follows the size of the change",
 "unit": "wall time", "format": "secs", "xunit": "lines changed", "xformat": "count",
 "series": [{"name": "unit", "points": [{"x": 120, "y": 4.2}, {"x": 340, "y": 6.1}, {"x": 900, "y": 11.5}, {"x": 1600, "y": 19}]},
            {"name": "integration", "points": [{"x": 80, "y": 21}, {"x": 410, "y": 34}, {"x": 760, "y": 58}, {"x": 1400, "y": 92}]}]}
```

## Colour is a role, never a value

You name no colour anywhere. A chart's colours are roles — `ink`, `ink-muted`, `grid`, `surface`, `accent`, `good`, `bad` and `series-1` through `series-8` — and the user's theme decides what each one looks like, so a chart restyles itself when the theme changes. Series take `series-1` onward in order, fixed to the entity and never cycled. The only colour choice you make is a `role` on a series, a `status` on a span, or an item kind in `dots`, and each of those is a word about meaning: `good` and `bad` are reserved for outcomes and never used to tell two ordinary series apart.

## Formats

| `format` | Writes | Examples |
|---|---|---|
| `auto` | integers as `int`, otherwise at most two significant decimals | `1,204`, `0.42`, `3.5` |
| `int` | whole numbers with a thousands separator | `1,204` |
| `decimal` | one fixed decimal | `3.5`, `1204.0` |
| `percent` | the value × 100 with a `%` sign, no decimals | `0.42` → `42%` |
| `secs` | a duration in seconds | `850ms`, `12.3s`, `4m05s`, `1h02m` |
| `bytes` | a byte count | `512B`, `1.2KB`, `3.4MB` |
| `count` | a count, abbreviated | `950`, `1.2k`, `3.4M` |

Give durations in seconds with `secs`, ratios as fractions with `percent`, and large counts with `count`. The format applies to every value label and tick in the chart.

## The rules

- **Hover is there.** Every mark but a sparkline's reads its row of the chart's table on hover; there is nothing for you to add.
- **Direct labels.** Lines and areas are labelled at their right end and value labels appear where they fit; there is nothing for you to add. Do not repeat the values in prose beneath the chart.
- **No pie.** There is no pie or donut form, and no part-to-whole chart with one time point: a part-to-whole across time is a stacked `area`, and a part-to-whole at one moment is a `bar` with `"layout": "stacked"`, or a sentence.
- **No legend for a single series.** The title names it. A legend appears on its own above a multi-series `bar`; nothing else needs one.
- **Titles state the message.** "Test time doubled after the fixture change", not "Test time". If you cannot write the message, you do not yet know why the chart is there.
- **One axis.** Two measures of different scale are two charts, never one with two scales.
- **Thin the data, not the labels.** A crowded category axis shows every k-th label and never rotates them, so for many categories prefer a horizontal `bar` or fewer categories.
- **Gaps are `null`.** A missing value is a gap in the line, never a zero.

## The recipes

A well-known chart is a `tugtool chart <recipe>` verb that computes its data from the project's own commits, test ledgers and arc record. Never retype a number a recipe can compute.

`tugtool chart list` is the one place the list lives, with each recipe's question, what its data tells, its form and its arguments, and `tugtool chart <recipe> --help` says the rest. Read it when data you are about to chart might already have a recipe. Commits per day, each suite's wall time, which files have been red, and where a change landed are all there.

A recipe prints one summary line and then a line beginning `TUG-CHART: ` carrying the spec, which the Session card renders beneath the Bash block and strips from the terminal text. Run the verb and the chart appears; you write nothing. When there is nothing to draw it prints one plain line saying why, and exits 0.

`--json` reads the summary and the numbers without drawing. To put a finding in the title, read with `--json` first, then run once with `--title "<the finding>"`, because every run without `--json` draws another figure.

`/viz` is the one door to a chart when one is asked for, for the user and for you alike: when the user asks to chart, plot, graph or visualise something, reach for it, and it takes the recipe when there is one and otherwise reads the data the request names and writes the fence. A figure you add to your own explanation is simply the fence. A spec from a recipe is the same shape as one you write by hand, so the two read as one system.

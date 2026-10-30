---
name: viz
description: Draw a chart of this project from its well-known recipes, chosen by name or from a sentence saying what to see.
argument-hint: "[what to see]"
disable-model-invocation: true
allowed-tools: Bash, Read
disallowed-tools: Task, Edit, Write
---

You draw one chart of this project in the transcript. A recipe computes its numbers from the project's own records, so you never retype one. Do not ask for confirmation: a figure is cheap to look at and cheap to redraw.

## No arguments

Run `tugtool chart list`, show what it printed, and stop.

## A sentence

1. Run `tugtool chart list --json`. Each recipe carries its `question`, its `form`, the `data` it reads, and its `args`.
2. Choose the recipe whose question and data match the sentence. Take `--days`, `--path` and any subjects from the sentence's own words, and leave the rest to the recipe's defaults. `--path` is relative to the repository root.
3. Run the recipe with `--json`. This reads the summary and the numbers and draws nothing, so it is where you learn what the chart says. A `spec` of `null` means there is nothing to draw: report the `summary` in one sentence and stop.
4. Draw it once, by running the same line without `--json`. Either pass `--title "<the finding>"`, or say the finding in one sentence beside the chart. Keep each to one figure: a second run draws a second chart.
5. Say which recipe ran, in one line.

```bash
tugtool chart churn --path src/parser --days 30 --json
tugtool chart churn --path src/parser --days 30 --title "Parser churn peaked the week of the rewrite"
```

The two lines above are two Bash calls: read the first before you write the second.

## No recipe answers

When nothing in the list answers the sentence, read the data yourself and write one `tugchart` fence, the way the session's chart guidance describes. The data is in `tugtool log --json`, `tugtool diff --json`, `tugtool test last --json`, `tugtool apptest history --json` and `tugtool report gaps --json`. Say in one line that it is a one-off.

## Never

- No dialog.
- No file: nothing is written to the project or anywhere else.
- No `tugtool chart render`. That verb writes an SVG file, and the figure belongs in the transcript.

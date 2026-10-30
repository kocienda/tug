---
name: viz
description: Draw a chart, plot, graph or visualisation in the transcript, from anything that holds the numbers — this project's records, a file, a CSV, a command's output, or figures already in the conversation. Use for any request to chart, plot, graph or visualise data in a Tug session.
argument-hint: "[what to see]"
allowed-tools: Bash, Read, Glob, Grep
disallowed-tools: Task, Edit, Write
---

You draw one chart in the transcript. It is the one door to a chart here, and it takes any request. Do not ask for confirmation: a figure is cheap to look at and cheap to redraw.

A request for a program that makes a chart, such as a matplotlib script or a notebook, is not a job for this skill. That is ordinary work.

## No arguments

Run `tugtool chart list`, show what it printed, and stop.

## A request

Work down these rungs in order. A recipe that answers ends the request at the first; otherwise read the data at the second and draw it at the third.

### 1. A recipe answers it

A recipe computes its numbers from the project's own records, so you never retype one.

1. Run `tugtool chart list --json`. Each recipe carries its `question`, what its data `tells`, its `group`, its `form`, the `data` it reads, its `args`, and a `sample` spec.
2. Choose the recipe whose question and data match the request. Take `--days`, `--path` and any subjects from the request's own words, and leave the rest to the recipe's defaults. `--path` is relative to the repository root.
3. Run the recipe with `--json`. This reads the summary and the numbers and draws nothing, so it is where you learn what the chart says. A `spec` of `null` means there is nothing to draw: report the `summary` in one sentence and stop.
4. Draw it once, by running the same line without `--json`. Either pass `--title "<the finding>"`, or say the finding in one sentence beside the chart. Keep each to one figure: a second run draws a second chart.
5. Say which recipe ran, in one line.

```bash
tugtool chart churn --path src/parser --days 30 --json
tugtool chart churn --path src/parser --days 30 --title "Parser churn peaked the week of the rewrite"
```

The two lines above are two Bash calls: read the first before you write the second.

### 2. Read the data the request names

When no recipe answers, read the numbers from wherever the request says they are, with whatever tool fits: a file or a CSV with `Read`, a command's output with `Bash`, figures already in the conversation as they stand. When the request names no source, the project's records are in `tugtool log --json`, `tugtool diff --json`, `tugtool test last --json`, `tugtool apptest history --json` and `tugtool report gaps --json`.

Compute what the chart needs from what you read, with a read-only command when there are too many rows to add up by eye, so that every number in the figure came from the source rather than from your memory of it. When the source does not hold the numbers the request asks for, say what is missing in one sentence and draw nothing.

### 3. Draw it as one fence

Write one `tugchart` fence, the way the session's chart guidance describes: the form from what the reader has to do with the data, and a title that states the message. Say the finding in one sentence beside it, and say in one line where the numbers came from.

## Never

- No dialog.
- No file: nothing is written to the project or anywhere else.
- No `tugtool chart render`. That verb writes an SVG file, and the figure belongs in the transcript.

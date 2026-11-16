---
name: viz
description: Draw a figure in the transcript. A chart, plot or graph from anything that holds the numbers — this project's records, a file, a CSV, a command's output, or figures already in the conversation — or one diagram of how a piece of code fits together. Use for any request to chart, plot, graph, diagram or visualise something in a Tug session. The request may name the form, as in "as a histogram" or "as a sequence diagram".
argument-hint: "[what to see] [as <form>]"
allowed-tools: Bash, Read, Glob, Grep
disallowed-tools: Task, Edit, Write
---

You draw one figure in the transcript. It is the one door to a figure here, and it takes any request. Do not ask for confirmation, and do not ask which form to use: a figure is cheap to look at and cheap to redraw.

A request for a program that makes a chart, such as a matplotlib script or a notebook, is not a job for this skill. That is ordinary work.

## No arguments

Run `tugtool chart list`, then `tugtool chart forms` as a second Bash call, show what they printed, and stop. The first is the charts this project already knows how to draw; the second is every form a figure can be asked for in, with a request that draws each.

## The form

**A form the request names is the form you draw.** `as a histogram`, `as a line`, `as a sequence diagram`, or an everyday word for one such as *timeline* or *architecture*: the session's chart and diagram guidance lists the forms and the words people use for them. When the data or the subject cannot take the named form, say why in one sentence and draw the nearest form that can.

When the request names no form, choose it from what the reader has to do with the figure, as that guidance describes.

## A chart or a diagram

- **Numbers are a chart.** Counts, times, sizes, outcomes, anything measured. Work down the three rungs under *A chart*.
- **Structure is a diagram.** How something is built, how its parts fit together, where a request goes, who calls whom. So is any request that names `flow`, `sequence`, `layers` or `stack`. Follow *A diagram*.

## A chart

Work down these rungs in order. A recipe that answers ends the request at the first; otherwise read the data at the second and draw it at the third.

### 1. A recipe answers it

A recipe computes its numbers from the project's own records, so you never retype one.

1. Run `tugtool chart list --json`. Each recipe carries its `question`, what its data `tells`, its `group`, its `form`, the `data` it reads, its `args`, and a `sample` spec.
2. Choose the recipe whose question and data match the request. Take `--days`, `--path` and any subjects from the request's own words, and leave the rest to the recipe's defaults. `--path` is relative to the repository root.
3. When the request names a form, look for a `form` among the recipe's `args`. If it takes the named form, pass `--form <form>`: the recipe draws its own numbers that way. If it does not, read the recipe with `--json` and draw its numbers yourself at the third rung, in the named form; they are still the recipe's numbers.
4. Run the recipe with `--json`. This reads the summary and the numbers and draws nothing, so it is where you learn what the chart says. A `spec` of `null` means there is nothing to draw: report the `summary` in one sentence and stop.
5. Draw it once, by running the same line without `--json`. Either pass `--title "<the finding>"`, or say the finding in one sentence beside the chart. Keep each to one figure: a second run draws a second chart.
6. Say which recipe ran, in one line.

```bash
tugtool chart churn --path src/parser --days 30 --form bar --json
tugtool chart churn --path src/parser --days 30 --form bar --title "Parser churn peaked the week of the rewrite"
```

The two lines above are two Bash calls: read the first before you write the second.

### 2. Read the data the request names

When no recipe answers, read the numbers from wherever the request says they are, with whatever tool fits: a file or a CSV with `Read`, a command's output with `Bash`, figures already in the conversation as they stand. When the request names no source, the project's records are in `tugtool log --json`, `tugtool diff --json`, `tugtool test last --json`, `tugtool apptest history --json` and `tugtool report gaps --json`.

Compute what the chart needs from what you read, with a read-only command when there are too many rows to add up by eye, so that every number in the figure came from the source rather than from your memory of it. When the source does not hold the numbers the request asks for, say what is missing in one sentence and draw nothing.

### 3. Draw it as one fence

Write one `tugchart` fence, the way the session's chart guidance describes: the form the request named, or else the form from what the reader has to do with the data, and a title that states the message. Say the finding in one sentence beside it, and say in one line where the numbers came from.

## A diagram

A diagram of code is a claim about the code, so you read before you draw, and every part you draw is one you found.

1. **Read the code.** Find the subject with `Grep`, `Glob` and `Read`, and follow it far enough to draw it in the form asked for. Note the path of each part you will key, relative to the project root. A path you have not opened is not a path you may cite.
2. **Write one `tugdiagram` spec**, the way the session's diagram guidance describes: the form the request named, or else the form the question asks for, a title that states the finding, and four to eight keyed parts, each with a `what` sentence and its `where`.
3. **Compile it before you answer**, and read what the compiler says:

   ```bash
   tugtool chart render - --out "${TMPDIR:-/tmp}/viz-check.svg" <<'SPEC'
   {"tugdiagram": 1, "form": "flow", "title": "…", "columns": [[{"id": "a", "name": "A"}]]}
   SPEC
   ```

   An error means nothing would be drawn: fix the field its path names. A `warning:` line means the figure draws past a limit or after a repair: answer it by shortening a name, reordering the boxes or fixing an id, and compile again. Only a spec that compiled clean goes in the answer.
4. **Answer** with the fence, one caption sentence saying how to read it, and two to four sentences on what it shows. The card draws the keyed table beneath the figure, so do not write it again.

This is one figure. When the subject needs more than one to be understood, draw the one the request asked for and say in one line that `/explain` gives the fuller account.

## Never

- No dialog.
- No file in the project. The one thing written is the scratch SVG a diagram's check leaves in the temporary directory, which you never show or point at.
- No `tugtool chart render` for a chart: a chart is the fence or the recipe's own line. For a diagram it is the check before the answer, never the answer.
- No diagram of a part you did not read, and no diagram you did not compile.

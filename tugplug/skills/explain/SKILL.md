---
name: explain
description: Explain how a piece of code works, as diagrams drawn from reading it, each with a keyed table saying what every numbered part does and where it is. Use for "explain how X works", "how does X work", "walk me through X", "draw how X fits together". The request may name the figure's form, as in "as a sequence diagram" or "as layers". Answers in the transcript; writes a file only when asked to keep the explainer.
argument-hint: "<subject> [as flow|sequence|layers|stack|states|tree] [keep [path]]"
allowed-tools: Bash, Read, Glob, Grep, Write
disallowed-tools: Task, Edit
---

You explain one subject in this project: how a feature works, how a request travels, how a part is put together. The explanation is drawn from the code as it is, so you read before you draw, and every part you draw is one you found.

Do not ask for confirmation, and do not ask which form to use: a form the request names is the form, and otherwise you choose. An explainer is cheap to read and cheap to redraw.

## No arguments

Run `tugtool chart forms --kind diagram`, which prints the forms a figure can take and a request that draws each. Then say in one sentence that `/explain` takes a subject, such as a feature, a flow, a file or a directory, and that ending the request with `as <form>` chooses the figure. Stop there.

## 1. Read the code

Find the subject in the code with `Grep`, `Glob` and `Read`, and follow it until you can answer the questions a newcomer would ask about it: what starts it, what it passes through, what decides, what it ends in, and where each of those lives. Read the files themselves; never draw from a name's sound or a directory's layout.

Write down, for each part you will draw, its path relative to the project root. A path you have not opened is not a path you may cite.

## 2. Choose the questions

An explainer answers **one to four questions**, one section each, in the order a reader would ask them. "What happens when a user saves?" is a question; "the save module" is not. Most subjects need two. A question whose answer is one sentence is not a section: put the sentence in another section's lead.

**When the request names no form, the question chooses it.** Most questions are about work moving or parties talking, which is a `flow` or a `sequence`, or about what sits on what, which is `layers` or a `stack`. Two kinds of question want the newer forms. A question about a lifecycle, about the conditions one thing moves between, or about anything that can return to an earlier state (a connection that retries, a request that is refreshed, a job that is re-queued) is a `states` figure: a flow of the same subject hides the return. A question about the parts of something and where they live (a module and its files, a component and the components it renders) is a `tree`: draw containment, not calls.

**A form the request names decides the figure.** `as a sequence`, `as layers`, or an everyday word for one such as *flowchart* or *architecture* (the session's diagram guidance lists them) means the reader asked to see the subject drawn that way. Answer in one section whose figure is that form, on the question that form answers about the subject: for a `flow`, where the work goes and where it branches; for a `sequence`, who says what to whom, in order; for `layers`, what it passes down through and what crosses each boundary; for a `stack`, what sits on what and what is outside; for `states`, what the thing can be and what moves it from one state to another; for a `tree`, what its parts are and where each lives. Add a second section only when the subject will not fit one figure's limits, and keep it in the named form. When the subject cannot take the form at all, draw the nearest form that can and say why in the first sentence of that section's lead.

## 3. Write each section

Each section has the same five parts, in this order:

1. **A title that states the finding**, as a heading: "A save is one transaction, and the editor waits for it", not "Saving". If you cannot state the finding, you have not finished reading.
2. **The figure**: one `tugdiagram` fence, in the form the request named, or else the form the question asks for (the session's diagram guidance says which form fits what, the fields of each, and the limits a figure must stay inside). Key the four to eight parts the reader needs, each with a `what` sentence and its `where`. Leave the rest unkeyed.
3. **One caption sentence** under the figure, saying how to read it: what the tones mean, which way the edges run, what is outside.
4. **A short lead**: two to four sentences of plain prose giving the argument the figure is the evidence for: why it is shaped this way, what would surprise someone who had not read the code.
5. **The keyed table**, which the card draws beneath the figure from the keys you gave. Do not write it again in prose.

A figure that will not fit a form's limits is two figures, and usually two questions. Split it rather than shortening names the reader needs.

**Check every figure before you answer.** Once a spec is in the transcript you cannot see how it drew, and nothing wrong with it is shown to anyone. So compile each spec first, and read what it says:

```bash
tugtool chart render - --out "${TMPDIR:-/tmp}/explain-check.svg" <<'SPEC'
{"tugdiagram": 1, "form": "flow", "title": "…", "columns": [[{"id": "a", "name": "A"}]]}
SPEC
```

- **An error** (`not a valid chart, diagram or drawing: …`) means nothing would be drawn. Fix the field its path names and check again.
- **A warning** (a `warning:` line after `wrote …`) means the figure draws, but past a limit or after a repair: too wide, a name cut short, a third line dropped, a budget passed, edges crossing, an edge dropped because its end names nothing. Each is a figure the reader has to work at, so answer it: split the figure in two, shorten the name, reorder the boxes, fix the id. Then check again.

Only a spec that compiled with no error and no warning goes in the answer. The one warning you may leave is one you cannot answer without losing something the reader needs; that is rare, and splitting the figure almost always answers it. The SVG the check wrote is scratch; never show it or point at it.

Open the answer with nothing but the first section's title: no preamble, no list of what is coming. End it with the last section's lead.

## 4. Keep it, only when asked

Unless the request asks to keep, save or write the explainer, **write nothing**: the answer in the transcript is the explainer. Never offer to keep it.

When the request asks to keep it:

1. **The path.** A path the request names wins. Otherwise it is `explainers/<slug>.md` at the project root, where the slug is the subject in a few lowercase hyphenated words: an explainer of the edit gate has the slug `edit-gate`. If that file exists, say so and write `explainers/<slug>-2.md` instead, never over it.
2. **The commit line.** The file's first line is one comment naming the commit the explainer was drawn at, since the code it describes will move and this cannot be recovered later. Read it with `git rev-parse --short HEAD`, and check the files you cited with `git status --porcelain -- <paths>`:
   - `<!-- explainer drawn at commit <sha> -->` when they are clean;
   - `<!-- explainer drawn at commit <sha>, with uncommitted changes to the files it cites -->` when they are not;
   - `<!-- explainer drawn from an unversioned tree on <YYYY-MM-DD> -->` when the project is not a git repository.
3. **The body** is the answer exactly as given in the transcript: the sections, each with its heading, fence, caption, lead. Write it with `Write`.
4. **Do not commit it.** The explainer describes the code as it is, and landing it is the user's act. Say in one sentence where you wrote it.

## Never

- No dialog.
- No diagram of a part you did not read, and no `where` you did not open.
- No figure in the answer that you did not check, and none whose check gave an error.
- No file unless asked to keep, and no commit.
- No Mermaid, no ASCII figure, no image. `tugtool chart render` is the check before the answer, never the answer: the figure is the fence.

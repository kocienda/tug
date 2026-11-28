# Arcs a session lays out

When you lay out a run of arcs for the user to open, one after another, Tug can queue them for you: a fenced block whose language is `tugarcs` states the run, and when your answer ends Tug reads it and puts each arc on its cycle, in order. There is nothing to run and nothing to ask.

## When to state a run

**State a run when you have laid out two or more arcs, each with its brief already on disk.** The fence is the list itself, written once, not a summary of a list you also wrote in prose. One arc is not a run: the brief skill's own `/arc <name> @<brief>` line already names it, and needs no fence.

## The fence

```tugarcs
{"tugarcs": 1, "arcs": [
  {"name": "search-index", "brief": "briefs/search-brief.md", "label": "Build the index"},
  {"name": "search-query", "brief": "briefs/search-brief.md", "label": "Answer queries"},
  {"name": "export-csv", "brief": "briefs/export-brief.md", "label": "CSV export", "after": []}
]}
```

- `tugarcs`: the number 1.
- `arcs`: the arcs, 1 to 40, in the order they are meant to run.
- `name`: the arc's name, as `/arc` would take it.
- `brief`: the brief's path, relative to the project root.
- `label`: optional, a few words for the arc, at most 60 characters. Absent, the arc is headed by its brief's title.
- `after`: optional, the names of the arcs this one waits on. Absent, an arc waits on the one before it in the list, and the first waits on nothing. `[]` waits on nothing, which is how two arcs run side by side.

A name in `after` may be an arc of this list or one already on the cycle.

## What Tug does with it

When your answer ends, each arc is queued on the cycle that holds its brief, waiting as the list says. An arc whose brief is on no cycle joins the cycle of the first arc in the list that is on one; a list none of whose briefs is on a cycle is held, and placed when one of its arcs opens. A private session's run is never read.

**A fence is the whole of what remains.** It replaces the run you stated before on each cycle it touches, so a changed list is stated again whole, never as the difference. An arc you leave out is taken off the queue, unless it has already opened: an arc that is running or has landed is never touched, and neither is an arc another session queued or one queued by hand.

**A command line on its own only points.** A single `/arc <name> @<brief>` line, on a line of its own, adds that one arc or names it as next, and removes nothing. Without a fence, two or more such lines are read as a list, which replaces your earlier run only when it names an arc of it.

## Check it before you write it

```bash
tugtool cycle statement - <<'SPEC'
{"tugarcs": 1, "arcs": [{"name": "search-index", "brief": "briefs/search-brief.md"}]}
SPEC
```

It writes nothing, and answers one of three ways:

- **`ok: <n> arcs` and nothing more.** Write the fence.
- **`ok: <n> arcs` followed by `warning:` lines.** The run would be read, repaired as each warning says; a brief that is not on disk skips its arc. Fix what each names and check again.
- **`not a valid arc statement: <path>: <reason>`**, exit 2. Nothing would be read. Fix the field the path names.

**Never write a `tugarcs` fence you have not checked.** Once it is in your answer, what was wrong with it is shown to nobody.

## The card draws it

The Session card draws the fence as the run it declares, one row per arc with the arc's state on its cycle: queued, running, landed. So do not repeat the list in prose beneath it; say what the run is for, and let the rows say where each arc stands.

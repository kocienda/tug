# Diagrams the Session card draws

Beside its charts, the Session card draws diagrams of how things work: what calls what, who sends what to whom, what sits on what, what a thing can be, and what is inside what. A fenced block whose language is `tugdiagram` renders as a figure in your transcript, styled by the user's theme, laid out by exact text measurement, and searchable by Find. Beneath it the card shows a **keyed table**: one row for each numbered mark, saying what that part does and where it is in the code. You write a small JSON spec of names, relations and order. The form decides every coordinate, so a spec has no x and no y. There is no other diagram you should make here: no Mermaid, no ASCII boxes, no SVG by hand.

## When to diagram

**Draw a diagram when the reader has to see structure to follow you.** A request crossing four processes, a call and its replies, the layers a keystroke passes through, the states a connection moves between: these are shapes a reader takes in faster from a figure than from paragraphs. A single call, a list of files, or a two-step relation is a sentence.

**One diagram says one thing, and its title states it.** "A shell edit the gate cannot read never reaches the file", not "The edit gate". If you cannot write the finding, you do not yet know why the figure is there.

**Every box is something you read.** A diagram of code is a claim about the code, so draw only what you found by reading it. Each `where` names a real path relative to the project root, and the card checks it: a location it cannot confirm is shown as unresolved, never as a working link. Never draw a part you guessed at.

**Say the finding in a sentence, and let the figure show it.** Put one caption sentence under the figure saying how to read it. Where the figure carries a legend, the caption need not repeat what the colours mean.

## The fence

A diagram is one JSON object in a fenced block whose language is `tugdiagram`. The fence must be closed before it renders (an open one stays code), so write the whole spec in one piece.

Every spec carries `"tugdiagram": 1`, a `form`, and a `title` that states the finding. `motion` is `enter` (the default) or `none`. Everything else belongs to the form. A key the form does not have is ignored, coordinates included, so spell the fields exactly as written here: a misspelt field is a field left out.

**A diagram that parses always draws.** Only a spec with nothing to draw is an error, shown in place with a path to the field at fault: not JSON, a required field missing or of the wrong type, or a `form` that is missing or is not one of the six, which the error lists. Everything else wrong with a spec is repaired and the figure is drawn all the same, so the reader is never shown a withheld figure over a slip. The repairs are listed under *Limits and repairs* below. They are silent in the transcript, which is why you compile a spec before you write it.

**Keys.** A mark you want to explain carries a `key`, a whole number from 1 to 99 given once in the figure, and with it `what` (one sentence on what this part does) and `where` (its path, relative to the project root). The key is drawn as a numbered disc on the mark, and the keyed table beneath the figure lists every key in order with its name, its `what` and its `where`. `what` and `where` belong only to a keyed mark. Key the four to eight parts the reader needs and leave the rest plain; a figure whose every box is keyed has keyed nothing.

**Labels sit on their lines.** Every label on an edge, a transition, a crossing or a link is drawn in a small chip on the line it names, the line running into the chip and out the other side, in the line's tone. An edge that leaves a row or a state starts with a dot, so the reader can tell which row it belongs to.

## The forms

Pick the form from what the reader has to follow.

| The reader must follow… | Form |
|---|---|
| work moving through parts, left to right, with branches | `flow` |
| messages between a few parties, in time order | `sequence` |
| the strata a request passes down, and what crosses each boundary | `layers` |
| the architecture: what sits on what, what is outside, what cuts across | `stack` |
| what states a thing can be in, and what moves it back to an earlier one | `states` |
| what is inside what: the parts of something and where they live | `tree` |

One example per form. Each is a complete, valid spec, and each shows every field its form takes.

**`flow`**: `columns`, left to right, each a list of boxes, and `edges` between them. A box is `{"id", "name", "sub"?, "rows"?, "notes"?}`: an `id` with no space, a name, an optional sub-label, optional `rows` inside it, and optional `notes`, short lines of muted text under it. A row is `{"name", "sub"?, "mono"?, "lit"?, "key"?}`. `mono` sets the name in the code face, for an identifier or a path; `lit` marks the row in a tone, with a wash, an outline and a dot in that tone. An edge is `{"from", "to", "tone"?, "label"?, "dashed"?}`, whose ends name a box by its `id` or one of its rows as `id.N`, counting from 1. Edges route themselves: an edge between neighbouring columns, forward or back, crosses the one gap between them, and only an edge that skips a column runs under the boxes, in a lane of its own. `legend` is an optional list of `{"tone", "text"}`, drawn as one line under the figure, saying what each tone the figure uses means.

```tugdiagram
{"tugdiagram": 1, "form": "flow",
 "title": "A request is checked before it reaches the store",
 "columns": [
  [{"id": "client", "name": "Client", "sub": "sends a request"}],
  [{"id": "api", "name": "API server", "sub": "src/server",
    "rows": [{"key": 1, "name": "Authenticate", "sub": "checks the token", "what": "Rejects a request whose token has expired.", "where": "src/server/auth.ts"},
             {"key": 2, "name": "Validate", "sub": "checks the body", "what": "Parses the body against the schema.", "where": "src/server/validate.ts"}]}],
  [{"id": "refuse", "name": "Refusal", "sub": "401, nothing written"},
   {"id": "store", "name": "Store", "sub": "Postgres",
    "rows": [{"name": "orders", "mono": true, "lit": "good"},
             {"name": "audit_log", "mono": true}]}]
 ],
 "edges": [
  {"from": "client", "to": "api"},
  {"from": "api.1", "to": "refuse", "tone": "bad", "dashed": true, "label": "token expired"},
  {"from": "api.2", "to": "store.1", "tone": "good", "label": "writes the order"}
 ],
 "legend": [
  {"tone": "good", "text": "the order is written"},
  {"tone": "bad", "text": "refused, nothing written"}
 ]}
```

**`sequence`**: `actors` across the top and `messages` down the page in time order. An actor is `{"id", "name", "sub"?}`. A message is `{"from", "to", "label", "tone"?, "reply"?, "key"?}`, whose ends are actor ids. A call is solid with a filled head; a `reply` is dashed with an open head and sits closer under the message before it. A message from an actor to itself is a short loop. A keyed message's disc sits on the sender's lifeline where the arrow starts, and an unkeyed one starts with a dot there. A message label stays on one line. The bar on a lifeline, from a call an actor receives to the reply it sends, is drawn from the messages; there is no field for it. `phases` is an optional list of `{"label", "note"?, "from", "to"}` over 0-based message indices, each drawn as a faint band behind its run of messages with its label and note at the left: the one way a figure says that a part repeats or belongs together.

```tugdiagram
{"tugdiagram": 1, "form": "sequence",
 "title": "A cache miss costs one round trip to the database",
 "actors": [
  {"id": "app", "name": "Handler", "sub": "src/routes"},
  {"id": "cache", "name": "Cache", "sub": "Redis"},
  {"id": "db", "name": "Database", "sub": "Postgres"}
 ],
 "messages": [
  {"key": 1, "from": "app", "to": "cache", "label": "GET user:42", "what": "Looks the user up by id before touching the database.", "where": "src/routes/user.ts"},
  {"from": "cache", "to": "app", "label": "miss", "reply": true, "tone": "caution"},
  {"key": 2, "from": "app", "to": "db", "label": "SELECT the user", "what": "Reads the row the cache did not have.", "where": "src/db/users.ts"},
  {"from": "db", "to": "app", "label": "row", "reply": true},
  {"from": "app", "to": "cache", "label": "SET user:42, 60 s"},
  {"from": "app", "to": "app", "label": "render the page"}
 ],
 "phases": [
  {"label": "Look up", "from": 0, "to": 1},
  {"label": "Fill", "note": "only on a miss", "from": 2, "to": 4}
 ]}
```

**`layers`**: `layers` from top to bottom, each a full-width band. A layer is `{"name", "sub"?, "tone"?, "cells", "below"?}`, where `cells` is a list of `{"name", "sub"?, "mono"?, "key"?}`. `tone` is `outside` alone, for a layer beyond the system the figure explains. `below` says what crosses the boundary into the next layer down. As a string it is one two-headed arrow with that label. As an object `{"via"?, "down"?, "up"?}` it says what goes each way: `down` labels an arrow going down, `up` one coming back, and `via` names the channel between them in the code face. The last layer has nothing beneath it, so it takes no `below`.

```tugdiagram
{"tugdiagram": 1, "form": "layers",
 "title": "A keystroke passes through three layers before it is saved",
 "layers": [
  {"name": "Editor", "sub": "the browser",
   "below": {"via": "HTTP", "down": "a JSON patch", "up": "the new revision"},
   "cells": [{"key": 1, "name": "Keymap", "sub": "binds the chord", "what": "Turns the chord into a save command.", "where": "web/src/keymap.ts"},
             {"name": "Buffer", "sub": "the open text"}]},
  {"name": "Server", "sub": "the API", "below": "one transaction",
   "cells": [{"key": 2, "name": "Save handler", "what": "Applies the patch to the stored document.", "where": "server/src/save.rs"},
             {"name": "Auth"}]},
  {"name": "Storage", "sub": "managed SQLite", "tone": "outside",
   "cells": [{"name": "documents", "mono": true}, {"name": "revisions", "mono": true}]}
 ]}
```

**`stack`**: the plain architecture diagram, ruled on a grid of `columns` (1 to 12). `layers` run top to bottom; each is `{"name", "sub"?, "span"?, "rows", "below"?}`, where `rows` is a list of rows of cells `{"name", "sub"?, "key"?}`, `span` is `[first, last]`, the columns the layer covers (all of them if absent), and `below` is a string saying what passes to the layer under it, drawn as a labelled arrow between the two. `above` and `below` at the top level are blocks outside the system, `{"name", "sub"?, "span", "link"?}`, each drawn with an arrow to the first layer in its way, and `link` labels that arrow. `across` is `{"title", "names"}`: bars that cut across every layer, drawn down the right side with their names upright.

```tugdiagram
{"tugdiagram": 1, "form": "stack",
 "title": "The service is three layers between the user and the database",
 "columns": 3,
 "above": [{"name": "Browser", "sub": "the user", "span": [1, 2], "link": "HTTPS"}],
 "layers": [
  {"name": "Web", "sub": "React", "rows": [[{"name": "Pages"}, {"name": "Forms"}, {"name": "Styles"}]]},
  {"name": "API", "sub": "Go", "below": "typed queries", "rows": [[{"key": 1, "name": "Router", "what": "Sends each path to its handler.", "where": "api/router.go"}, {"name": "Handlers"}, {"name": "Jobs"}]]},
  {"name": "Data", "sub": "access layer", "span": [1, 2], "rows": [[{"name": "Queries"}, {"name": "Migrations"}]]}
 ],
 "below": [{"name": "Postgres", "sub": "managed", "span": [1, 2], "link": "SQL"}],
 "across": {"title": "Shared", "names": ["logging", "config"]}}
```

**`states`**: what a thing can be, and what moves it between states. `states` is a list of `{"id", "name", "sub"?, "key"?, "tone"?, "end"?, "under"?}` and `transitions` a list of `{"from", "to", "label"?, "tone"?, "dashed"?}`, whose ends are state ids; `start` names the state it begins in (the first on the main line if absent), marked by a dot and an arrow. States without `under` stand on a main line left to right in the order given, the path when all goes well; a state `under` another hangs beneath it, for a failure or a side exit. A transition to the next state on the line is a straight arrow, any other between two states on the line goes over the top in a lane of its own, and a side state goes back up to its own state or along the bottom into another's lower edge. Placement is by these rules alone, so a spec always draws the same figure. A `tone` on a state is an outcome; `end` gives a state a second outline.

```tugdiagram
{"tugdiagram": 1, "form": "states",
 "title": "A dropped connection retries until it is closed on purpose",
 "start": "idle",
 "states": [
  {"id": "idle", "name": "idle", "sub": "no socket yet"},
  {"id": "connecting", "name": "connecting", "sub": "handshake in flight", "key": 1, "what": "Opens the socket and waits for the server's hello.", "where": "src/net/connection.ts"},
  {"id": "open", "name": "open", "sub": "frames flow", "tone": "good"},
  {"id": "closed", "name": "closed", "sub": "closed on purpose", "end": true},
  {"id": "backoff", "name": "backoff", "sub": "waiting to retry", "tone": "caution", "under": "connecting", "key": 2, "what": "Doubles the wait after each refusal, up to 30 s.", "where": "src/net/backoff.ts"}
 ],
 "transitions": [
  {"from": "idle", "to": "connecting", "label": "connect()"},
  {"from": "connecting", "to": "open", "label": "hello", "tone": "good"},
  {"from": "open", "to": "closed", "label": "close()"},
  {"from": "open", "to": "connecting", "label": "the server drops it", "dashed": true},
  {"from": "connecting", "to": "backoff", "label": "refused", "tone": "caution"},
  {"from": "backoff", "to": "connecting", "label": "timer fires"}
 ]}
```

**`tree`**: what is inside what. One `root` node, each node `{"name", "sub"?, "mono"?, "key"?, "tone"?, "children"?}` with its parts in `children`. The root stands at the left and each level is a column to its right; a parent is centred on its children, and the lines joining them have no heads and are drawn thin and muted, since containment has no direction. A node with children wears the full outline and a leaf a fainter one; a `tone` on a node colours it and the short stub of line into it, never the trunk its siblings share.

```tugdiagram
{"tugdiagram": 1, "form": "tree",
 "title": "The settings page owns its form state; the fields only render it",
 "root": {"name": "SettingsPage", "sub": "holds the draft and saves it", "mono": true, "key": 1, "what": "Keeps the unsaved draft and writes it on Save.", "where": "src/settings/page.tsx",
  "children": [
   {"name": "Header", "mono": true},
   {"name": "SettingsForm", "sub": "lays out the sections", "mono": true,
    "children": [
     {"name": "AccountSection", "mono": true},
     {"name": "ThemeSection", "mono": true},
     {"name": "KeysSection", "sub": "the one section that validates", "mono": true, "tone": "caution", "key": 2, "what": "Refuses a chord that is already bound.", "where": "src/settings/keys.tsx"}
    ]},
   {"name": "SaveBar", "sub": "Save and Revert", "mono": true}
  ]}}
```

## A form the user names

**A form the user names is the form you draw.** The table under *The forms* is how you choose when the request leaves the form to you. It is never a reason to overrule a request that names one. "As a sequence diagram" and "show it as layers" each settle the form, wherever in the request they come.

People name forms in their own words. Read these as the form beside them:

| They say… | Draw |
|---|---|
| flowchart, pipeline, data flow | `flow` |
| message diagram, who calls whom, handshake | `sequence` |
| levels, what it passes through, top to bottom | `layers` |
| architecture, block diagram, big picture | `stack` |
| lifecycle, state machine, what states it can be in | `states` |
| hierarchy, what contains what, component tree | `tree` |

When the subject cannot take the named form, say why in one sentence and draw the nearest form that can: a `sequence` needs parties that exchange messages, `layers` need strata that something passes down through, `states` need one thing that moves between conditions, and a `tree` needs parts that each belong to one whole.

**A follow-up that names another form redraws the last figure.** "Same thing as layers" needs no command: draw the subject again from what you already read, reading further only for what the new form shows and the old one did not. Compile it as you would any other figure.

`tugtool chart forms --kind diagram` prints the six forms with what each shows, these words, and a request that draws one. Run it when the user asks what they can ask for.

## Colour is a role, never a value

You name no colour. The accent is spent on the key discs and nowhere else; boxes are plain, and names are ordinary ink. The one colour choice you make is a **tone**: `tone` on an edge, a message, a transition, a state or a tree node, `lit` on a flow row, and `tone: "outside"` on a `layers` layer. A tone is a word about meaning, one of four:

- `good` and `bad`: outcomes, the path that succeeds and the one that fails.
- `caution`: the outcome between them, allowed but degraded, a fallback or a retry.
- `outside`: a place, never an outcome: what lies beyond the system the figure explains.

A toned line recolours its head and its label with it; a toned row, state or node wears a wash and an outline in its tone, and a lit row a dot as well, so the tone reads without the text. `accent` is not a tone. Leave most marks untoned so that the toned ones mean something, and say what the tones mean: in a `flow`, with a `legend`; elsewhere, in the caption sentence.

## Compile it before you write it

**Never put a `tugdiagram` fence in an answer you have not compiled.** Once a fence is in the transcript you cannot see how it drew, and what was wrong with it is shown to nobody. So pipe each spec through the compiler first and read what it prints:

```bash
tugtool chart render - --out "${TMPDIR:-/tmp}/diagram-check.svg" <<'SPEC'
{"tugdiagram": 1, "form": "flow", "title": "…", "columns": [[{"id": "a", "name": "A"}]]}
SPEC
```

It answers one of three ways:

- **`wrote … (W×H px, …)` and nothing more.** The figure is inside every limit. Write the fence.
- **`wrote …` followed by `warning:` lines.** The figure draws, and each warning names a part and what is wrong with it. A warning is a figure the reader has to work at, so answer it before you write the fence: split the figure in two, shorten the name, reorder the boxes, fix the id. Then compile again.
- **`not a valid chart, diagram or drawing: …`.** Nothing would be drawn. Fix the field the path names and compile again.

The SVG it writes is scratch. Never show it, link it or point at it: the figure is the fence.

## Limits and repairs

These are the limits a figure should stay inside. None of them withholds a figure: past one, the figure is still drawn in the way described, and the compiler prints a warning. Write within them and the compile prints no warning.

- **Names never wrap.** A box, row, cell, actor, layer, state or node name is one line, at most 320 px wide, roughly 45 characters. A sequence message label and a phase label are one line too. One longer is cut to fit and ends in an ellipsis; the keyed table still shows a keyed name whole.
- **Secondary text wraps to two lines and no more.** A sub-label, an edge or transition label, a note, a phase note, a link and a `below` label wrap by words at a width the form sets. An edge label in a `flow` wraps at 96 px, about fourteen characters a line, because a turn between neighbouring columns takes the gap's centre lane and its chip has to fit in that gap. What would run onto a third line is dropped and the second ends in an ellipsis. Put the detail in `what`, which the table shows in full.
- **Every string is at most 120 characters**, `what` included. A `what` is one short sentence; a longer one is shown whole and warned of.
- **A whole figure is at most 1,040 px wide.** One wider is drawn at its own width: the card scales it down to fit, to no less than three quarters of its size, and past that the reader has to scroll it sideways. Five columns of ordinary boxes are already over, so a flow that wide is usually two figures.
- **Each form has a budget.** A `flow` holds at most 5 columns, 10 boxes, 6 rows in a box, 18 rows in all, and 10 edges. A `sequence` holds 6 actors and 16 messages. `layers` holds 7 layers of at most 5 cells. A `stack` holds 7 layers, 3 rows in a layer, 6 cells in a row, 24 cells in all, 4 blocks above or beneath, and 4 bars across. A `states` figure holds 6 states on the main line, 1 side state beneath each, 12 transitions, and 3 lanes over the top. A `tree` holds 4 levels and 20 nodes. A figure over a budget is drawn crowded. An upright bar name longer than its bar is tall is cut to the bar.
- **Edges may cross at most once.** Two crossings mean the boxes want reordering: put the boxes an edge joins in the order the edge reads. A `states` transition that runs through a state it does not join is warned of the same way: reorder the main line.

A figure past a limit is two figures, each with its own title and its own finding. Never squeeze one by abbreviating names into something the reader cannot follow.

What the compiler repairs, each with a warning:

- **An unknown key is ignored**, so a misspelt `sub` or `tone` is simply absent from the figure.
- **An optional field of the wrong shape is left out**: a `tone` that is not one of the four, a layer `tone` other than `outside`, a `span` off the grid (the layer takes every column), a `mono` that is not `true` or `false`, an empty `sub`, a `below` object naming none of `via`, `down` and `up`, and a `below` on the last layer, which has nothing beneath it.
- **An edge, message or transition whose end names nothing is dropped**: a box id, a row number, an actor id or a state id that does not exist, or an edge from a box to itself. The figure is drawn without it.
- **A `states` figure places only what its rules place.** A transition from a state to itself, one between two side states, and one into a side state from anything but the state it hangs beneath are dropped. A state whose `under` names nothing, itself, or a state that itself hangs beneath another stands on the main line. A `start` naming nothing begins at the first state on the main line.
- **A phase that cannot be drawn is left out**: one with no label, a `from` or `to` that is not a whole number, a `from` past the last message, a `to` before its `from`, one holding no message that is drawn, or one that overlaps the phase before it. A `to` past the last message is cut to the last.
- **A legend entry that explains nothing is left out**: one with no tone or no text, one whose tone no edge or row in the figure wears, and a second entry for a tone already in the legend.
- **A key number given twice keeps its first mark.** The later mark is drawn unkeyed and has no row in the table, as has a `key` that is not a whole number from 1 to 99. A `what` or `where` on a mark with no key is ignored.

## Explaining code

`/explain <subject>` is the door to a written explanation of how something works: it reads the code, and for each question it answers it gives a title that states the finding, the diagram, one caption sentence, a short lead, and the keyed table. A request that ends `as <form>` gets its figure in that form. `/viz` draws a single diagram when the user asks to visualise how something is built. A diagram you add to your own explanation is simply the fence.

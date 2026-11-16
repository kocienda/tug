# Diagrams the Session card draws

Beside its charts, the Session card draws diagrams of how things work: what calls what, who sends what to whom, what sits on what. A fenced block whose language is `tugdiagram` renders as a figure in your transcript, styled by the user's theme, laid out by exact text measurement, and searchable by Find. Beneath it the card shows a **keyed table**: one row for each numbered mark, saying what that part does and where it is in the code. You write a small JSON spec of names, relations and order. The form decides every coordinate, so a spec has no x and no y. There is no other diagram you should make here: no Mermaid, no ASCII boxes, no SVG by hand.

## When to diagram

**Draw a diagram when the reader has to see structure to follow you.** A request crossing four processes, a call and its replies, the layers a keystroke passes through: these are shapes a reader takes in faster from a figure than from paragraphs. A single call, a list of files, or a two-step relation is a sentence.

**One diagram says one thing, and its title states it.** "A shell edit the gate cannot read never reaches the file", not "The edit gate". If you cannot write the finding, you do not yet know why the figure is there.

**Every box is something you read.** A diagram of code is a claim about the code, so draw only what you found by reading it. Each `where` names a real path relative to the project root, and the card checks it: a location it cannot confirm is shown as unresolved, never as a working link. Never draw a part you guessed at.

**Say the finding in a sentence, and let the figure show it.** Put one caption sentence under the figure saying how to read it, for example what the colours mean.

## The fence

A diagram is one JSON object in a fenced block whose language is `tugdiagram`. The fence must be closed before it renders (an open one stays code), so write the whole spec in one piece.

Every spec carries `"tugdiagram": 1`, a `form`, and a `title` that states the finding. `motion` is `enter` (the default) or `none`. Everything else belongs to the form. Unknown keys are errors, coordinates included, so spell the fields exactly as written here. An invalid spec shows its errors in place, each with a path to the field at fault.

**Keys.** A mark you want to explain carries a `key`, a whole number from 1 to 99 given once in the figure, and with it `what` (one sentence on what this part does) and `where` (its path, relative to the project root). The key is drawn as a numbered disc on the mark, and the keyed table beneath the figure lists every key in order with its name, its `what` and its `where`. `what` and `where` belong only to a keyed mark. Key the four to eight parts the reader needs and leave the rest plain; a figure whose every box is keyed has keyed nothing.

## The forms

Pick the form from what the reader has to follow.

| The reader must follow… | Form |
|---|---|
| work moving through parts, left to right, with branches | `flow` |
| messages between a few parties, in time order | `sequence` |
| the strata a request passes down, and what crosses each boundary | `layers` |
| the architecture: what sits on what, what is outside, what cuts across | `stack` |

One example per form. Each is a complete, valid spec.

**`flow`**: `columns`, left to right, each a list of boxes, and `edges` between them. A box is `{"id", "name", "sub"?, "rows"?, "notes"?}`: an `id` with no space, a name, an optional sub-label, optional `rows` inside it, and optional `notes`, short lines of muted text under it. A row is `{"name", "sub"?, "mono"?, "lit"?, "key"?}`. `mono` sets the name in the code face, for an identifier or a path; `lit` colours the row with a tone. An edge is `{"from", "to", "tone"?, "label"?, "dashed"?}`, whose ends name a box by its `id` or one of its rows as `id.N`, counting from 1. Edges route themselves: forward edges run straight where they can, and the rest turn in a lane or loop underneath.

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
 ]}
```

**`sequence`**: `actors` across the top and `messages` down the page in time order. An actor is `{"id", "name", "sub"?}`. A message is `{"from", "to", "label", "tone"?, "reply"?, "key"?}`, whose ends are actor ids. A `reply` is drawn dashed; a message from an actor to itself is a short loop. A message label stays on one line.

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
 ]}
```

**`layers`**: `layers` from top to bottom, each a full-width band. A layer is `{"name", "sub"?, "cells", "below"?}`, where `cells` is a list of `{"name", "sub"?, "mono"?, "key"?}` and `below` says what crosses the boundary into the next layer down. The last layer has nothing beneath it, so it takes no `below`.

```tugdiagram
{"tugdiagram": 1, "form": "layers",
 "title": "A keystroke passes through three layers before it is saved",
 "layers": [
  {"name": "Editor", "sub": "the browser", "below": "a JSON patch over HTTP",
   "cells": [{"key": 1, "name": "Keymap", "sub": "binds the chord", "what": "Turns the chord into a save command.", "where": "web/src/keymap.ts"},
             {"name": "Buffer", "sub": "the open text"}]},
  {"name": "Server", "sub": "the API", "below": "one transaction",
   "cells": [{"key": 2, "name": "Save handler", "what": "Applies the patch to the stored document.", "where": "server/src/save.rs"},
             {"name": "Auth"}]},
  {"name": "Storage", "sub": "SQLite",
   "cells": [{"name": "documents", "mono": true}, {"name": "revisions", "mono": true}]}
 ]}
```

**`stack`**: the plain architecture diagram, ruled on a grid of `columns` (1 to 12). `layers` run top to bottom; each is `{"name", "sub"?, "span"?, "rows"}`, where `rows` is a list of rows of cells `{"name", "sub"?, "key"?}`, and `span` is `[first, last]`, the columns the layer covers (all of them if absent). `above` and `below` are blocks outside the system, `{"name", "sub"?, "span"}`, each drawn with an arrow to the first layer in its way. `across` is `{"title", "names"}`: bars that cut across every layer, drawn down the right side with their names upright.

```tugdiagram
{"tugdiagram": 1, "form": "stack",
 "title": "The service is three layers between the user and the database",
 "columns": 3,
 "above": [{"name": "Browser", "sub": "the user", "span": [1, 2]}],
 "layers": [
  {"name": "Web", "sub": "React", "rows": [[{"name": "Pages"}, {"name": "Forms"}, {"name": "Styles"}]]},
  {"name": "API", "sub": "Go", "rows": [[{"key": 1, "name": "Router", "what": "Sends each path to its handler.", "where": "api/router.go"}, {"name": "Handlers"}, {"name": "Jobs"}]]},
  {"name": "Data", "sub": "access layer", "span": [1, 2], "rows": [[{"name": "Queries"}, {"name": "Migrations"}]]}
 ],
 "below": [{"name": "Postgres", "sub": "managed", "span": [1, 2]}],
 "across": {"title": "Shared", "names": ["logging", "config"]}}
```

## Colour is a role, never a value

You name no colour. The accent is spent on the key discs and nowhere else; boxes are plain, and names are ordinary ink. The one colour choice you make is a **tone**: `tone` on an edge or a message, `lit` on a flow row. A tone is a word about meaning, one of four:

- `good` and `bad`: outcomes, the path that succeeds and the one that fails.
- `caution`: the outcome between them, allowed but degraded, a fallback or a retry.
- `outside`: a place, never an outcome: what lies beyond the system the figure explains.

`accent` is not a tone. Leave most marks untoned so that the toned ones mean something, and say what the tones mean in the caption sentence.

## Wrapping and refusals

A diagram refuses a figure a reader would have to work at, and the error says what to change. Write within these rules and the first spec renders.

- **Names never wrap.** A box, row, cell, actor or layer name is one line, at most 320 px wide, roughly 45 characters. A sequence message label is one line too. One longer is an error carrying its measured width, so shorten it.
- **Secondary text wraps to two lines and no more.** A sub-label, an edge label, a note and a `below` label wrap by words at a width the form sets; a third line is an error. Put the detail in `what`, which the table shows in full.
- **A whole figure is at most 1,040 px wide.** One wider is an error that says to split it.
- **Each form has a budget.** A `flow` holds at most 5 columns, 10 boxes, 6 rows in a box, 18 rows in all, and 10 edges. A `sequence` holds 6 actors and 16 messages. `layers` holds 7 layers of at most 5 cells. A `stack` holds 7 layers, 3 rows in a layer, 6 cells in a row, 24 cells in all, 4 blocks above or beneath, and 4 bars across, and an upright bar name may be no longer than its bar is tall.
- **Edges may cross at most once.** Two crossings mean the boxes want reordering: put the boxes an edge joins in the order the edge reads.

A figure over a budget is two figures, each with its own title and its own finding. Never squeeze one by abbreviating names into something the reader cannot follow.

## Explaining code

`/explain <subject>` is the door to a written explanation of how something works: it reads the code, and for each question it answers it gives a title that states the finding, the diagram, one caption sentence, a short lead, and the keyed table. A diagram you add to your own explanation is simply the fence.

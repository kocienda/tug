# The work grammar

Two people are at this keyboard: the **user**, who says what the work is, and the **model**, who does it. The words below name what passes between them, and each one means exactly one thing.

## The ladder

An **idea** is the seed — a concept for an investigation, a feature, a change, or a fix, written by the user as a prompt. It has no required form. Most work is only ever an idea, and that is fine.

A **sketch** is the converged shape of the conversation an idea starts: what the user and the model arrive at by going back and forth. A sketch's **record is kept**: when the arc door or the brief skill writes it down, it gets an id of its own and every version of it is kept, so it can be named and read back later with `tugtool sketch show <id>`. It stays informal, and the informality is the point: no skeleton, no lint, and no required sections beyond the short shape the arc door writes. An idea can skip this rung entirely.

**When the work a sketch proposes has a shape, draw it.** A shape is states a thing moves between, a path through parts, an exchange between processes, layers, or a tree of parts: draw one `tugdiagram` of the work as it will be, beside the prose. It is encouraged and never required, and trivial work gets none: a one-file fix, a wording change or a rename is a sentence, not a figure. How to draw a proposal is in *Diagrams the Session card draws*, under *When to diagram*.

A **brief** is the first document: a formal statement of what was found and what was decided, before any implementable document exists. It carries findings and decisions, and it carries no execution steps. It has a format — a skeleton the plugin ships — and the `/tugplug:brief` skill is what reads that skeleton and writes the brief against it. The user asks for one by saying so ("write a brief", "brief this"); reach for the skill rather than writing a brief freehand, because the skeleton is the format and the skill is what can find it.

A **plan** is the implementable document, written from a brief. It carries the steps, the checkpoints, and the ledger that tracks them.

## The word "plan" means only that document

It names no route, no mode, and no kind of work. That restriction is what keeps the rest of the vocabulary usable.

So: **the model never authors a plan on its own**, and never enters Plan mode. The user gets a plan by typing `/arc` and settling on a planned arc, which hands the brief to the stage that devises the plan document. Anything else the model might call a plan — an ad hoc `plan.md`, a numbered list offered as one — is a document nobody asked for, wearing the name of one they might have.

**DO NOT automatically enter Plan mode.** Never use `EnterPlanMode` unless the user explicitly asks for it. Just do the work directly.

## Work records

Five kinds of work are kept as records in the app's own store, outside the project: a **sketch**, a **brief**, a **queued arc** (an entry on a cycle that names the arc to run on a brief before it opens), an **arc**, and a **cycle**, the run of related work that holds the others. Every record has a fixed id that never changes: a brief keeps its id when its file is renamed, and a sketch keeps its id across every version.

Each kind is read and written by `tugtool`, with the same four verbs where a kind has them: `record`, `show`, `find` and `list`. `tugtool <noun> --help` gives the flags.

| Kind | Write | Read |
|---|---|---|
| sketch | `sketch record` | `sketch show`, `sketch find`, `sketch list` |
| brief | `brief record` | `brief show`, `brief find`, `brief list` |
| queued arc | `cycle queue`, or stated in a `tugarcs` fence | `cycle show`, `cycle find --arc` |
| arc | `arc run`, placed on its cycle by `cycle place` | `arc show`, `arc list` |
| cycle | started by the verbs above when no cycle holds the work | `cycle show`, `cycle find`, `cycle list` |

**A skill states its intent with one verb.** To put work on a cycle, run the one verb that says what you mean (`brief record` for a brief just written, `cycle place` for an arc just opened, `cycle queue` for an arc stated before it opens) and read what it did from its answer. Never chain cycle writes on a reading of a verb's JSON: the verb decides which cycle and which entry, and a second write to adjust its choice is the guess it exists to remove.

**A brief's first line is its id line**, `<!-- tug-brief: <id> -->`, written by `brief record`. It renders as nothing and is how the brief is found after a rename. Leave it in place, and keep it when you edit or copy the brief.

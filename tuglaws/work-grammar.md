# The Work Grammar

This document is the lexicon for how work happens in this repository: the two roles, the documents they produce, the lanes a change can travel, and the names of the machinery that carries it. It exists because these names once grew by accretion — dash, plan, wheel, arc, course, door — until two of the words were each naming three things. The rule that fixes that is the rule of this document: **every term names exactly one thing, and no thing has two names.** When another document's vocabulary conflicts with this one, this one wins and the other is stale.

---

## The two roles

**The user** is the human developer. The user originates ideas, exercises judgment in conversation, and performs every landing gesture — the user is the only party who commits to `main`.

**The model** is the AI. The model sharpens ideas, composes documents, and executes work: on `main` only alongside the user, alone only on a worktree.

These are the spellings the doctrine has always used ("landing is the user's act," "a running model cannot drive it"), now canonized. Do not write "the developer," "the human," "the assistant," or "the agent" — the last collides with the agentless charter of `tugplug/` and makes sentences about it unreadable.

---

## The artifact ladder

Work descends from thought to document in a fixed order. Each rung has one defining property.

**Idea → sketch → brief → plan.**

- An **idea** is the seed: a concept for an investigation, feature, change, or fix, written by the user as a prompt. It has no required form.
- A **sketch** is the converged shape of the conversation the idea starts — what the user and the model arrive at by going back and forth. A sketch lives **in the transcript only and is never written to a file**; that is its defining property, and the informality is the point. (An idea can skip this rung and go straight to a brief.)
- A **brief** is the first document: a formal statement of what was found and what was decided, conforming to [tuglaws/brief-skeleton.md](brief-skeleton.md). It is not directly actionable — the test of a brief is whether a devise round can be run from it, not whether an implementer can work from it.
- A **plan** is the implementable document, conforming to [tuglaws/devise-skeleton.md](devise-skeleton.md), written by the wheel's devise stage and read cold by its review stage.

**The word "plan" means only the document.** It names no route, no skill, no kind of work. That restriction is what un-jams the rest of the vocabulary.

---

## The two lanes

A **work unit** is the whole of one undertaking, from idea to landed change. Every work unit lands through one of two lanes, and each lane has exactly one landing gesture — always performed by the user, in the Session card.

- The **main lane**: edits made directly on the checkout, by the user alone or by the user and the model together. No brief is required (though one may exist). Landed by `/commit`.
- The **arc lane**: work the model performs on an isolated worktree, driven by the wheel, coming back to `main` in a single operation. Landed by `/arc-join <name>`.

---

## The arc

An **arc** is the arc lane's work unit: work that leaves `main` on its own worktree and branch, is driven by the wheel through stages, and returns through a **join**. The name is the metaphor — an arc is the curve that departs a line and comes back to it, and a narrative arc is a story that resolves. An arc that never joins is a story that never ends.

Every arc opens on a **brief**. One handed in with the invocation is used as-is; otherwise composing one is the door's first act.

There are two kinds of arc, and the axis between them is **settling time** — whether the work earns a written, cold-reviewed plan before a step is walked. The axis is not size; size is a symptom, settling is the decision.

- A **dash** is the short arc: brief → implement → audit. You just go. Small, concrete work whose decisions are already made belongs here.
- A **trek** is the long arc: brief → devise → review → implement → audit. Nobody dashes up a mountain — you trek it, provisioned, with a plan, in stages. Work with enough parts that their order is itself a problem, or whose decisions are the hard part, belongs here.

The sentence that defines them: **a dash is a short arc, a trek is a long arc.** Everything downstream of the opening is identical — one step per turn, compaction between steps, an audit of the whole diff by a session that never saw the run, the join offered through the Changes shade. A dash is not a lesser arc; it is the same arc entered by a door that has already answered what devise and review would have asked.

---

## The wheel, the doors, the stages

The **wheel** drives every arc. It rotates the **stages** — devise, review, implement, audit — onto fresh sessions of its own, on the same card, one step per turn, so each stage reads the documents cold. A running model cannot drive the wheel; it cannot end its own turn to start the next stage.

The **doors** are the two skills that open the arc lane, and a door's whole job is to settle what the work is and hand it over: sharpen the conversation into a brief, hand the brief to the wheel, end the turn. A door creates no worktree, commits nothing, implements nothing, joins nothing.

- **`/dash`** — the door onto a dash.
- **`/trek`** — the door onto a trek.

Which door the user typed **is** the routing decision. The stage skills are internal machinery — stages of an arc that refuse to run outside one — not doors, and not vocabulary anyone speaks.

---

## Where documents live

- **`notes/`** is the top-level home for working papers: briefs, audits, surveys, investigation write-ups — the documents produced *in the course of* the work that are not the work's product. Its charter is **inertness**: no tool reads it, no tool writes it, no skill resolves paths into it by convention, and nothing in `tugrust/` or `tugplug/` may ever mention it. Documents are handed to arcs by explicit path. This charter is the lesson of the old `roadmap/` directory, which went bad the moment machinery entangled itself with it. Disposition of a note after its work lands is the user's exercise — nothing automates it. What proves durable graduates into `tuglaws/`; `notes/` is an anteroom, not an archive.
- **`.tug/arcs/<name>/`** is the machinery's document home for one arc — the brief, the plan when one exists, the ledger. Never tracked.
- **`tuglaws/`** is the curated durable surface: laws, doctrine, skeletons, design decisions.

---

## Retired names

Per the retirement doctrine, the designs go and the spellings stay findable — here, with what replaced them:

- **course** — once named the stage-sequence variant ("dash course" / "plan course"), and before that "arc" named the same thing. Retired totally: the variant axis is now the **kind** (dash | trek), and the stage sequence needs no proper noun — say "a trek's stages."
- **planned dash** / **`/dash-plan`** — the old marked kind and its door. Now: **a trek**, entered by `/trek`.
- **proposal** — once the name for the in-conversation converged shape; retired for its formality inversion (a proposal outranks a brief in common usage, but this artifact ranks below one). Now: **a sketch**, and a sketch is never a file.
- **roadmap/** — the old document directory, deleted; its successor is `notes/` under the inertness charter above.
- **arc** (old sense) — briefly named the stage sequence in the machinery (`TUG_DASH_ARC`, `ArcStage`). The word is promoted, not retired: it now names the work unit whole, which is what its value (the dash's name) always pointed at anyway.

---

## Spellings in transition

*This section describes the gap between this grammar and the tree, and is deleted when the rename campaign closes it.* The machinery still speaks the old lexicon: the `tugtool dash` verb family, the `tugdash-core` crate, `.tug/dashes/`, `/dash-join`, `TUG_DASH_COURSE`/`TUG_DASH_ARC`, the `dash-plan` door and `dash-*` stage skills, and the `tuglaws/dash-*.md` doctrine. The campaign that brings the spellings to this grammar is chartered in `notes/arc-lexicon-brief.md`.

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
- A **brief** is the first document: a formal statement of what was found and what was decided, conforming to the brief skeleton the plugin ships ([brief-skeleton.md](brief-skeleton.md) points at it). It is not directly actionable — the test of a brief is whether a devise round can be run from it, not whether an implementer can work from it.
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

- An **arc** — a plain one, and the default — is brief → implement → audit. You just go. Small, concrete work whose decisions are already made belongs here.
- A **planned arc** is brief → devise → review → implement → audit. Work with enough parts that their order is itself a problem, or whose decisions are the hard part, belongs here: the plan is written, then read cold by a session that did not write it, before a step is walked.

The sentence that defines them: **a planned arc is an arc that earns a plan before a step is walked.** Everything downstream of the opening is identical — one step per turn, compaction between steps, an audit of the whole diff by a session that never saw the run, the join offered through the Changes shade. A plain arc is not a lesser arc; it is the same arc entered by a door that has already answered what devise and review would have asked.

---

## The wheel, the door, the stages

The **wheel** drives every arc. It rotates the **stages** — devise, review, implement, audit — onto fresh sessions of its own, on the same card, one step per turn, so each stage reads the documents cold. A running model cannot drive the wheel; it cannot end its own turn to start the next stage.

The **door** is the one skill that opens the arc lane, and its whole job is to settle what the work is and hand it over: sharpen the conversation into a brief, decide which kind of arc it wants, hand the brief to the wheel, end the turn. The door creates no worktree, commits nothing, implements nothing, joins nothing.

- **`/arc`** — the door onto an arc, plain or planned.

The **kind is the door's decision, not the user's spelling**. It reads the user's own words first — an instruction typed at the door, or said in the conversation, that asks for a plan or for going straight at it settles it — and otherwise makes the call itself on the axis above: whether the work earns a written, cold-reviewed plan before a step is walked. That call is made **from the work**: the brief's decisions counted against its open questions, and the code the brief names, read rather than glanced at. **Nothing inside a document decides it.** A brief's Exit section, or any sentence in it about what should come next, is what the brief's author expected the successor to be called on the day, not a measure of how much settling the work needs — and the user hands in briefs as a matter of course, so a door that obeyed such a line would route every arc the same way and decide nothing. Only on genuine ambiguity does it confirm by dialog, and either way it says which shape it chose **and why** before it hands off, so a wrong call is visible in the first sentence on the card rather than a stage later. A plain arc leaves a task list beside the brief; a planned arc leaves the brief alone, and the engine reads the kind off exactly that when the arc opens. The stage skills are internal machinery — stages of an arc that refuse to run outside one — not doors, and not vocabulary anyone speaks.

---

## Where documents live

- **`briefs/`** is the top-level home for working papers — briefs first, and the audits, surveys and sketches-that-became-files beside them: the documents produced *in the course of* the work that are not the work's product. **Its address is a setting**, the Briefs Directory in Settings ▸ General, default `briefs/` inside the project. **The `brief` skill is the one writer, and it writes only briefs**, through `tugtool brief dir`. Otherwise the charter holds as before: no tool reads the directory, nothing indexes it, nothing resolves any other document kind into it, and documents are handed to arcs by explicit path. Disposition after the work lands is the user's exercise — nothing automates it. What proves durable graduates into `tuglaws/`; this is an anteroom, not an archive. The old `roadmap/` directory is the lesson the charter is drawn from: machinery entangling itself with a document directory is what went bad, and one skill writing one document kind to a user-set path is the narrowest entanglement that makes the directory usable at all — the setting is what keeps the path the user's.
- **`.tug/arcs/<name>/`** is the machinery's document home for one arc — the brief, the plan when one exists, the ledger. Never tracked.
- **`tuglaws/`** is the curated durable surface: laws, doctrine, skeletons, design decisions.

---

## Where knowledge lives

The standalone contract ([tugplug/CLAUDE.md](../tugplug/CLAUDE.md#the-standalone-contract)) says which *files* the plugin may depend on. This is its other half, about *knowledge*: **anything the model must know to drive Tug correctly ships in the bundle, and reaches the session through the system prompt or a skill.**

Tug is distributed to people whose projects have nothing to do with this checkout — no `tuglaws/`, no `CLAUDE.md` of ours, no source tree. A rule written only in this checkout's `CLAUDE.md` therefore holds only here, which for a rule about how to drive the app is the same as not holding at all. The channel that reaches every project is the system prompt: `tugcode` appends the plugin's root prompt files to it at every spawn, and `tugplug/CLAUDE.md` names them.

**The test for any new paragraph in this checkout's `CLAUDE.md` is one question: would this be true in a project that is not Tug?** A yes means it is in the wrong file — it belongs in a plugin prompt file, and the checkout keeps only the residue, the crate or path or recipe that is true here alone, plus a pointer at the prompt file as the source. One contract, one home, and no second copy to drift.

---

## Retired names

Per the retirement doctrine, the designs go and the spellings stay findable — here, with what replaced them:

- **course** — once named the stage-sequence variant ("dash course" / "plan course"), and before that "arc" named the same thing. Retired totally: the variant axis is now the **kind** (plain | planned), and the stage sequence needs no proper noun — say "a planned arc's stages."
- **dash** — the old name for the short arc, and one of the three words this lexicon's own rule could not keep. Now: **an arc**, entered by `/arc`.
- **trek** — the old name for the long arc. Now: **a planned arc**, entered by `/arc` like every other.
- **planned dash** / **`/dash-plan`** — the old marked kind and its door. It went to `/trek`, and `/trek` goes to the one door `/arc`; the collision that retired the first spelling was in *dash*, never in *plan*.
- **`tugdash/`** — the old branch prefix, with its four `branch.tugdash/<name>.*` config keys. Now: **`tugarc/`**, migrated at the top of every arc verb.
- **`/arc-plan`** — the second door, onto a planned arc. Now: the one door **`/arc`**, which decides the kind from the conversation and its own reading. The retired flag `tugtool arc run --plan` and the `arc_run` frame's `kind` field went with it: each was a second source of truth for what the arc's own documents already say.
- **`Tug-Dash:`** — the old join trailer. Now: **`Tug-Arc:`**; landed trailers are read for life.
- **`dash-log`** — the old per-project record file. Now: **the arc log** (`arc-log.md`), renamed once on first read.
- **`/dash-discard`** — the discard receipt's old spelling. Now: **`/arc-discard`**, with the old one read for life below.
- **proposal** — once the name for the in-conversation converged shape; retired for its formality inversion (a proposal outranks a brief in common usage, but this artifact ranks below one). Now: **a sketch**, and a sketch is never a file.
- **roadmap/** — the old document directory, deleted; its successor is `briefs/` under the charter above.
- **notes/** — the working-papers directory under the inertness charter; now **`briefs/`**, with the charter revised above (2026-09).
- **arc** (old sense) — briefly named the stage sequence in the machinery (`TUG_DASH_ARC`, `ArcStage`). The word is promoted, not retired: it now names the work unit whole, which is what its value (the unit's name) always pointed at anyway.

**A spelling that ever reached a durable ledger stays a *read* spelling for life.** The list above is about prose; this is about the two places a rename touches code that reads the past. Replay re-derives a designed transcript block by matching the ledger row's recorded `command` string, so a row written under the old verb renders as the designed receipt only for as long as something still claims that string. Drop it and every act already recorded reverts to a raw shell row — retroactively, on the next card reload, for work the user did months ago.

So a rename of a verb that writes a receipt must touch two things beyond the verb itself, and neither is optional:

- **The deck's matcher** — `matchesJoinReceipt` (`tugdeck/src/lib/landing-mode.ts`) and `matchesDiscardReceipt` (`tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx`) claim both spellings, the new one written and the old one read.
- **The ledger's eviction exemption** — `LANDING_RECEIPT_COMMANDS` (`tugrust/crates/tugcast/src/shell_ledger.rs`) names both, or the historical receipt loses the exemption that keeps the per-session cap from evicting it. That is the quieter half: the row does not merely render wrong, it goes away.

Five renames have run this course. `/dash-join` → `/arc-join` (the arc rename), `/dash-release` → `/dash-discard` (the discard rename), and this arc's three: `/dash-discard` → `/arc-discard`, the `Tug-Dash:` trailer → `Tug-Arc:`, and the shell-ledger quiet row's `dash <verb>` → `arc <verb>`. Every old spelling is read and never written, in the places named above.

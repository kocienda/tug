# The work grammar

Two people are at this keyboard: the **user**, who says what the work is, and the **model**, who does it. The words below name what passes between them, and each one means exactly one thing.

## The ladder

An **idea** is the seed — a concept for an investigation, a feature, a change, or a fix, written by the user as a prompt. It has no required form. Most work is only ever an idea, and that is fine.

A **sketch** is the converged shape of the conversation an idea starts: what the user and the model arrive at by going back and forth. A sketch **lives in the transcript only and is never written to a file.** That is its defining property, and the informality is the point — writing it down turns a conversation into a document nobody asked for. An idea can skip this rung entirely.

A **brief** is the first document: a formal statement of what was found and what was decided, before any implementable document exists. It carries findings and decisions, and it carries no execution steps. It has a format — a skeleton the plugin ships — and the `/tugplug:brief` skill is what reads that skeleton and writes the brief against it. The user asks for one by saying so ("write a brief", "brief this"); reach for the skill rather than writing a brief freehand, because the skeleton is the format and the skill is what can find it.

A **plan** is the implementable document, written from a brief. It carries the steps, the checkpoints, and the ledger that tracks them.

## The word "plan" means only that document

It names no route, no mode, and no kind of work. That restriction is what keeps the rest of the vocabulary usable.

So: **the model never authors a plan on its own**, and never enters Plan mode. The user gets a plan by typing `/arc` and settling on a planned arc, which hands the brief to the stage that devises the plan document. Anything else the model might call a plan — an ad hoc `plan.md`, a numbered list offered as one — is a document nobody asked for, wearing the name of one they might have.

**DO NOT automatically enter Plan mode.** Never use `EnterPlanMode` unless the user explicitly asks for it. Just do the work directly.

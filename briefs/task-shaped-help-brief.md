# Task-shaped help: the content that makes the Overview an expert on Tug

**Purpose:** Tug's two help documents say what things are. An expert answers how to do things, names the exact gesture, and says plainly when something does not exist. With a semantic index making document size free, the help corpus should grow into a third, task-shaped document and a much fuller guide, measured by a fixed question set until the Overview stops finding gaps.

---

## Purpose {#purpose}

The user's complaint, from the session that started this program: "The AI doesn't know how the app works." The Overview, asked how to create an arc, correctly described the `/arc` door and then wrote its longest paragraph about what the documents did not settle: "any button, menu item or chord for starting an arc from the Arcs sidebar, or what exactly you type after `/arc`." That hedge was accurate. There is no New Arc button, and the documents never say so, so the model could not say so with confidence either.

The user's standard: "The overview must be an *expert* in how Tug works!" And, once embeddings were in reach: "we could *substantially expand* the amount of help documentation available."

This is the third of three briefs. The first, `briefs/semantic-search-seam-brief.md`, builds the index and the eval set. The second, `briefs/semantic-history-streams-brief.md`, brings history into it. This one is writing, not code, and it is the one whose value the other two exist to unlock.

---

## Evidence {#evidence}

**[F01] The help corpus is two documents of about nine thousand words.** `docs/glossary.md` is 4,034 words across 101 terms, one paragraph each. `docs/features.md` is 4,970 words across 10 top-level sections and 34 headings in all, with a "Keyboard shortcuts" section and a "Getting help" section. Both ship in `Contents/Resources/docs/` by the Xcode copy phase, and `help_docs.rs` reads exactly these two file names. **(verified)**

**[F02] The guide is organised by part of the app, not by task.** Its sections are The window, Session cards, Other cards, Sidebar cards, Attributed edits and commits, Arcs, Keyboard shortcuts. "Opening an arc" is a subsection under Arcs and does answer the question, but it is reached by knowing the app's structure rather than by naming what one wants to do. **(verified, read from the headings)**

**[F03] The documents never state a negative.** No section says a control does not exist. The Overview's answer prompt forbids inventing "a chord, a menu item, or a control" and tells the model to say the documents do not say when they do not settle it, so every absent control becomes a hedge rather than a fact. **(verified, `OPERATOR_ANSWER_INSTRUCTIONS` in `feeds/overview_agent.rs`)**

**[F04] The retrieve prompt inlines every glossary term today, so document size has been a prompt-size cost.** The 101 terms ride every retrieval round; adding the guide's headings is the first brief's `[B09]`. Growing either document further under the current search would mean growing the prompt or losing findability. With the index, neither. **(verified)**

**[F05] The hedging shape of the answer is prompted.** The answer instructions reward stating what the documents do not settle; in the user's example that paragraph was the longest one, and the first-session diagnosis called it "reads as ignorance even when the gap is real". **(verified, read from the prompt and the transcript)**

**[F06] The sources of truth for gestures exist and are scattered.** Chords live in `tugapp/Sources/MenuBarBuilder.swift` and the deck's dispatch; slash commands are the plugin's skills under `tugplug/skills/` plus the Session card's own commands; menu items are the menu builder; sidebar controls are their card components. The guide's shortcut section carries 68 mentions of chords and is hand-maintained. **(verified by listing; the mechanism is not verified to be complete)**

---

## Decisions {#decisions}

**[B01] A third help document, task-shaped: one recipe per thing a person does in Tug.** Each recipe is a heading that is the task as a person would say it ("Start new work on a branch", "Stop an arc", "Find a commit from last week"), then the gesture: the slash command, chord, menu item or control, in the order a person would reach for them, then what they will see. It is organised by intent, which is how questions arrive, and it is the document the index will match a question to first.

**[B02] Every recipe says what does not exist.** Where a person might expect a button, a menu item or a chord and there is none, the recipe says so in a sentence: "There is no New Arc button in the Arcs sidebar; the one door is `/arc`." This is the sentence the Overview could not write [F03]. A stated negative is a fact the model can rest on; an unstated one is a hedge.

**[B03] The feature guide grows too, and the glossary stays as it is.** The guide's sections fill out with every control, chord and state each part of the app has, since the index makes length free [F04]. The glossary is definitions, one paragraph per term, and that is right for what it is; a definition that grows into a how-to belongs in the recipes.

**[B04] The answer's shape changes: lead with the gesture, keep it short, and name a gap only when the question asked for the missing thing.** The hedge paragraph [F05] goes. When a recipe states a negative [B02], the answer states it as fact and cites the recipe. When the documents are silent on something the question did not ask about, the answer does not volunteer the silence.

**[B05] The eval set is the measure, and it grows with the content.** The first brief's set of twenty to thirty questions with expected help refs runs through `tugcast operator-ask`. This brief adds a question for every recipe written, and the recipes are written against the failures: a question the set gets wrong because no passage answers it is the next recipe. The work is done when the set stops finding gaps, not when a word count is reached.

**[B06] Gestures are written from the sources, not from memory, and the sources are named in the recipe's own file as comments.** Chords come from the menu builder and the dispatch table, slash commands from the plugin and the Session card, controls from the components [F06]. A recipe that names a chord names where it was read, so a later change to the chord has a path back to the sentence it stales. A mechanical check that the chords in the documents still exist in the code is worth having; whether it is a lint or a test is the arc's call.

**[B07] The documents stay plain Markdown in `docs/` and ship the way the two existing ones do.** `help_docs.rs` learns a third file name and a third unit kind; the help card renders it like the others; its headings join the retrieve prompt's map. No new format, no generator.

---

## Open Questions {#open-questions}

- **Who writes the recipes.** The user has written both existing documents. The arc can draft recipes from the sources [B06] and the eval failures [B05], but the voice and the claims are the user's to approve, and a recipe written by the model about a gesture it has never performed is the risk this brief should name. The arc should draft, the user should read every recipe before it ships.
- **A gesture check.** Whether a check that every chord and slash command named in the documents exists in the code is built in this arc or left as the first follow-on. It is cheap if the dispatch table is readable; it is a project if it is not.

---

## Non-goals {#non-goals}

- **Generated documentation.** A document extracted from code reads like code. The recipes are written prose, checked against code [B06].
- **Changing the glossary's shape.** Definitions stay definitions [B03].
- **Help content about the user's own work.** That is history, and the second brief indexes it. These documents are about Tug.
- **Anything in the index or the Operator's verbs.** Built by the first two briefs; this one only adds a document and a prompt change.
- **Hedging as a policy.** The answer states what the documents state, including negatives, and stops [B04].

---

## Exit {#exit}

**An arc**, opened once the first brief's arc has landed hybrid `help.search` and the eval set, since the set is what the writing is measured by. The first steps, in the order they must land:

1. The third document's skeleton in `docs/`, `help_docs.rs` reading it, the help card rendering it, its headings in the retrieve prompt [B07].
2. The answer prompt's new shape [B04], with the eval set run before and after.
3. Recipes written against the eval set's failures, in batches, each batch adding its questions to the set [B01][B02][B05][B06]; the user reads each batch.
4. The feature guide filled out section by section the same way [B03].
5. The gesture check, if the arc finds the dispatch table readable [B06].

<!-- brief-skeleton v1 -->

# A sketch draws the proposed work

**Purpose:** A sketch that carries a diagram of the work it proposes is far easier to judge than one in prose alone, but nothing in the prompt asks for one, and the diagram rules as written discourage drawing parts that do not exist yet. Encourage the figure, without requiring it.

---

## Purpose {#purpose}

The user's words: "We should *encourage* the AI when making a *sketch* to produce a diagram of the work that is being proposed. It's not a requirement, but seeing this was *incredible*."

The occasion was the run-command timeout sketch in `tug/petite-steel`. Its answer carried a `states` diagram, "A quiet command is asked about, never stopped on a clock", that showed the whole proposal as one figure: running, might be stuck, exited, terminated, with keyed rows naming where each part would live. The model drew it on its own initiative. No rule asked for it, so it will not happen reliably.

---

## Evidence {#evidence}

**[F01] The prompt says nothing about what a sketch contains.** `tugplug/work-grammar.md` defines a sketch as "the converged shape of the conversation an idea starts" that "lives in the transcript only and is never written to a file", and says nothing of its contents. `tuglaws/work-grammar.md` (line 24) mirrors it in its ladder. **(verified)**

**[F02] The diagram rules are written for explaining existing code.** `tugplug/diagrams.md`, under *When to diagram*, says "Every box is something you read … draw only what you found by reading it" and "Never draw a part you guessed at", and each `where` "names a real path". Read strictly, that rules out a figure of proposed work, where some parts do not exist yet. **(verified)**

**[F03] Both files already reach every session.** `PLUGIN_PROMPT_FILES` in `tugcode/src/spawn-config.ts` lists `work-grammar.md` and `diagrams.md`, so they are appended to every session's system prompt on every project. The change is to wording only, and no loader work is needed. **(verified)**

**[F04] Two tests read `diagrams.md`.** `tugdeck/crates/tuggraphics/tests/diagram.rs` parses its `tugdiagram` examples and refuses an unclosed one; `tugrust/crates/tugchart-core/src/forms.rs` reads the file for the forms listing. Prose added outside a fence touches neither, and a new example fence would have to compile. **(verified)**

**[F05] No diagram tone means "new".** The four tones are outcomes (`good`, `bad`, `caution`) and a place (`outside`). The sketch that preceded this brief marked its added part `good` with a legend saying "what this change adds", and it read clearly. **(verified)**

**[F06] The arc's sketch record cannot hold a figure.** `sketch.md` is one sentence and three to six bullets (`tugplug/doctrine/arc-work-doctrine.md`), and `parseArcRecord` in `tugdeck/src/lib/arc-record-text.ts` reads only paragraphs and lists. **(verified)**

---

## Decisions {#decisions}

**[B01] The sketch paragraph in `tugplug/work-grammar.md` gains one encouragement: when the proposed work has a shape, draw it.** A shape means states, a path through parts, an exchange between processes, layers, or a tree of parts. The no-figure cases are named so the rule does not put a figure on trivial work: a one-file fix, a wording change, a rename. The wording is "draw one when the work has a shape", not "consider a diagram", which would be skipped, and not "always", which would put figures on trivial sketches. The sentence points at the diagram rules for how. `tuglaws/work-grammar.md`'s sketch bullet carries the same sentence.

**[B02] *When to diagram* in `tugplug/diagrams.md` names a sketch as an occasion, with a short mapping from kind of change to form.** New behaviour over time → `states`; a new path through parts → `flow`; a new exchange between processes → `sequence`; a new component → `tree` or `stack`. The mapping is what makes the encouragement cheap to act on.

**[B03] The "something you read" rule gains a clause for proposed parts.** A figure in a sketch draws the work as it will be. Every existing part is still something read. A key's `where` names the real file where the part lives or will land, and a part with no home yet is drawn unkeyed. The title states the proposal's point, as "A quiet command is asked about, never stopped on a clock" did. A sketch still never draws a part of the *current* code it has not read.

**[B04] One figure, of the after.** The figure is the proposal, not the current state. "What is there now" stays prose, unless the change can only be understood as a before set against an after, which is then two figures, each with its own title.

**[B05] New parts are marked with the `good` tone and a legend, in a `flow` only.** The proposal clause blesses what [F05] found working: in a `flow`, a part the change adds may be lit `good` with a legend entry saying "what this change adds". Other forms do not mark new parts, since the whole figure is the proposal. No fifth tone is added.

---

## Non-goals {#non-goals}

- **A required figure.** The user was explicit that the figure is encouraged, not mandated. A sketch of a one-line fix with a diagram is noise.
- **A "new" tone.** Adding a fifth tone means renderer, theme-token and contrast-audit work across ten themes for one use. `good` with a legend ([B05]) carries the meaning today.
- **The figure in the arc's `sketch.md` and the Sketch panel.** The record's shape and the panel parser hold no fences ([F06]). Carrying a sketch's figure into the arc shade is separate work, if it is wanted at all.
- **A new example fence in `diagrams.md`.** The six existing examples already show every form; a proposal example adds length to every session's prompt for little gain. If one is added after all, it must compile under [F04]'s test.

---

## Exit {#exit}

An arc, small: one round of prose edits.

- `tugplug/work-grammar.md`: the sketch paragraph gains [B01].
- `tugplug/diagrams.md`: *When to diagram* gains the occasion and the mapping ([B02]), the proposal clause ([B03]), the after-not-before rule ([B04]), and the `good`-plus-legend allowance for `flow` ([B05]).
- `tuglaws/work-grammar.md`: the sketch bullet mirrors [B01].
- Verdict: `just tugplug-lint` and the `tuggraphics` diagram test stay green.

# How a reference looks — placed things are atoms, written things are mentions

A file path in the transcript can be painted four different ways. A commit sha, three. Which one you get is decided by the container the entity arrived in — an editor atom, a tool input, a ref list, a pair of backticks the model happened to type — and the container is a fact about our plumbing that the reader cannot see and does not care about. This brief replaces that with a rule about authorship.

**In one paragraph.** An **atom** is something someone *placed* — an `@`-mention, a tool's `file_path` field, an entry in a post's `refs` array — and it renders as a glyph plus a **name**, boxed only where the object can be manipulated in place. A **mention** is something someone *wrote* — characters in a sentence — and it renders as those characters plus a **1px underline at `currentColor` 45%** when a resolver confirms it. Placed-ness is structural, recorded in the data before anything renders, so the choice is never a judgment call. Detection stops caring about backticks; appearance keeps caring, because backticks are the author's emphasis and the code tone is a separate channel from the actionable one. Nothing about *behaviour* changes: `registry.ts` was already right.

## What is already right

The system is three layers, and two of them are finished.

| Layer | Where | State |
|---|---|---|
| **Detection** — is this token an entity? | `annotator/detect-path-reference.ts`, `detect-commit-sha.ts`, `detect-session-ref.ts` | Sound, but gated inconsistently — see [P03] |
| **Behavior** — what does a gesture do? | `annotator/registry.ts` | **Done.** Nine kinds, one delegated listener, one context-menu provider. A file path opens in a Text card whatever painted it |
| **Presentation** — what does it look like? | Five components, no shared rule | The subject of this brief |

`registry.ts` did the hard part years before the presentation question was asked, which is why nothing here needs a new mechanism. Every fix below changes which component paints a mark that is already correct.

## The five forms in shipping ink

1. **Boxed atom chip** — `TugAtomChip` (React inline SVG) and `createAtomImgElement` (the CM6 `<img>`). Fill, border, icon, label.
2. **Unboxed file ref** — `ToolFileRef`: muted glyph + basename in code font, transparent, no border.
3. **Annotated inline `<code>`** — `tug-markdown-view.css` §403–441, plus `CommitShaText`, which hand-rolls a second one.
4. **Split-out prose run** — `[data-tugx-wrapped]` from `wrapMatchesInTextNode`, styled by `styles/tug-annotation.css`. Byte-identical to its surroundings at rest.
5. **Session citation** — `TugSessionCitation`, portaled in by `useSessionCitationPortals`. Live dot + `project/callsign`.

Per entity kind: **file path 4 forms, commit sha 3, command 1, session 1.** The two that are right are the two that only ever had one renderer.

## The four arbitrarinesses

**A1 — backticks gate detection.** `annotatePathsInText` licenses a candidate when `inCode || proseCitesPaths || isUnambiguousInProse(reference)`. Inside `<code>` any path shape qualifies; in bare prose only an absolute path or a `file.ts:180` line-cite does. Whether a reference is clickable depends on whether the model reached for backticks, which is a coin flip we promoted to a rule.

**A2 — nothing on the surface says *actionable*.** In one Reporter sentence, `ConfigureTug`, `deck.addCard("session")`, `fireRestore` and `session-restore.ts` are pixel-identical. Four are identifiers that go nowhere; one is a file you can open. `tug-annotation.css`'s **resting-plain** decision — written to stop a filename-dense paragraph becoming a field of links — answered a real worry by removing the signal entirely, and you cannot hover what you do not know is there.

**A3 — the Gazette paints the same fact two ways in one post.** `unmentionedRefs` suppresses a ref chip when the prose already names the target. So the operative rule is: *a file the sentence happened to mention renders as tinted text; a file the sentence happened to omit renders as a boxed chip.* Same kind, same post, two forms, selected by where the model put the words.

**A4 — the gate is per-surface.** `proseCitesPaths` is set only by `useGazetteAnnotation` (`gazette-card.tsx:359`). The Session card's context — `useAnnotationContext` in `transcript-host-helpers.ts:134` — leaves it off, so the identical sentence naming the identical file is a live reference in one card and dead text in the other.

## How it got this way

Each rule was locally correct. Chips came from the editor, where a box is honest: it means *this is one object you can select, delete, and drag*. `ToolFileRef` was invented precisely because that box reads as chrome in a read-only header. Inline `<code>` came from markdown fidelity — the model wrote backticks, we honor backticks. Gazette ref chips came from a list, which has no sentence to sit inside. What was never written is the sentence that makes them a system, and in its absence appearance defaulted to encoding provenance-of-container.

## Why prose mentions are not atoms

This is the question the rule has to answer first, because "make every actionable thing a chip" is the obvious proposal and it is wrong for two reasons — one measurable, one about what a transcript is *for*.

**Measurable.** `tug-atom-markdown-body.css:36` floors *every* markdown line — chip-bearing or not — to `max(1lh, atom-height + 4px)`, today 25px. The floor exists to serve a hard invariant: an atom must never change line height. Extend chips into assistant prose and the floor extends to every paragraph in the transcript, whether or not it names a file. The whole transcript loosens to accommodate a chip most lines do not have.

**About the transcript.** A chip does not decorate text, it **replaces** it. `session-citation-portals.tsx:80` empties the span it mounts into, and the original spelling has to be preserved on `data-tugx-session-text` precisely so the words can be put back if the mark is later dropped. That is honest when an object is what was there and a lie when it is not: the model wrote the characters `session-restore.ts` into a sentence, and a box asserts it placed an object. The transcript's contract is that it shows what was written.

**The counter-evidence, recorded so it is not re-discovered as an objection.** We already put atoms in prose — session citations mint a live chip into a confirmed run, late verdict and all. It works there for two reasons that do not generalize: a post names *one* session, and the chip carries a live status dot that text genuinely cannot render. Neither holds for file paths, which are dense and static.

The density worry that produced resting-plain is nonetheless real and is answered by [P05] with weight rather than absence.

## The rule

**[P01] An atom is something someone *placed*. A mention is something someone *wrote*.**

The rule's value is that it is never a judgment call: **placed things arrive in a slot, written things arrive in a stream**, and the substrate records which before anything renders.

| Arrived as | Authorship | Form |
|---|---|---|
| `U+FFFC` + an entry in the `atoms` array | the user picked it from `@`-completion | **Atom** |
| a tool call's `file_path` JSON field | the system placed it in a field | **Atom** |
| an entry in a Gazette post's `refs` array | the model placed it in a list | **Atom** |
| characters inside a markdown string | somebody wrote a word | **Mention** |

No heuristic, no resolver verdict, no per-surface flag, no backtick inspection. Placed-ness is structural, so it cannot drift.

**[P02] The user/assistant axis is really *picked versus typed*, and it cuts across both.** `@`-mention a file and you get a chip; type the same path by hand into the same message and you get a mention. Those genuinely were two different acts, and the distinction is learnable in one exposure. This is what `atom-mention-marker.ts` already implements, and it survives by name: **what you placed comes back as what you placed.**

### Vocabulary

Four words, used precisely everywhere below. A plan that renames them is fine; a plan that blurs them is not.

- **Atom** — the rendering of a *placed* value. Shows a **name**, not the raw value ([P09]). Two skins, never more.
- **Editable skin** — the boxed chip (`TugAtomChip` / `createAtomImgElement`). Only where the object can be selected, deleted or dragged in place.
- **Read-only skin** — glyph + label, transparent, no border (`ToolFileRef` today). Everywhere else a placed value appears.
- **Mention** — the rendering of a *written* value: the characters exactly as written, plus the rule when a resolver confirms them.

There is no third form. "Chip", "ref", and "citation" are legacy words for one of these two skins and should not survive the plan as separate concepts.

## Decisions

**[P03] Backticks stop gating detection.** Retire the `inCode` license asymmetry and the per-surface `proseCitesPaths` flag; the transcript family cites paths, all of it. `resolvePath` was always the real gate — permissive detection behind a strict confirm — so a wrong guess costs one cached lookup and text that stays text. The Gazette has been running this way and it is the surface that reads best. (Resolves A1, A4.)

**[P04] Backticks stop gating *actionability*, and keep gating *emphasis*. Two orthogonal channels.** An earlier draft of this decision said a backticked path and a bare one "render identically." That was wrong, and the bench showed it: `annotate-content.ts` reads green and `registry.ts` does not, which looks like the old arbitrariness surviving the fix. It isn't — they are two different channels, and the confusion was ours for not naming them.

| Channel | Says | Driven by |
|---|---|---|
| **Code tone** (mono + `--tug7-…-code-rest`) | *the author formatted this as code* | the backticks, exactly like `*` drives italic |
| **The rule** (1px underline) | *this responds to a click* | the resolver verdict, and nothing else |

They compose, four ways, and every combination is legible: backticked + resolves = green and underlined; bare + resolves = body colour and underlined; backticked + resolves-to-nothing = green only (`AnnotationContext`); bare + nothing = plain prose.

So the code tone stays. Stripping it from a resolved path would be us overriding what was written, which is the same fidelity violation [P01] refuses for chips — backticks are the author's emphasis and we honour them as we honour bold. What changed is that actionability finally has a channel of its own, which is why `annotate-content.ts` and `registry.ts` now agree on the thing that matters and differ only in the thing the author chose.

**[P05] A Mention's signal is an underline, at rest.** Not a tint. Colour is not an affordance: a hue shift says *this token is a different category of thing*, which is what the code tone already says, and stacking a second subtler hue on top asks the reader to read two levels of one channel and infer *clickable* from the difference. Nobody learns that. An underline is the one signal already learned, unambiguous, specifically meaning *you can act on this* — and it costs nothing in layout metrics, which matters because verdicts land after the ink is painted and must never reflow a streaming transcript.

Two tiers, so density is answered by weight rather than by absence: **at rest**, 1px at reduced opacity, offset off the baseline — present and scannable, quiet enough that six in a paragraph read as a referenced document; **on hover**, the full link treatment already in `tug-annotation.css`. Resting-plain retires. (Resolves A2.)

**Settled on the bench: 1px solid, `currentColor` at 45%.** Faint (28%) and dotted (70%) were auditioned against a six-mention paragraph and recorded there; they are not open questions.

**[P06] One atom, two skins. LOCKED.** Boxed where the object is manipulable in place (the composer, and its echo in the submitted message, where it can be selected and deleted); unboxed everywhere read-only (tool headers, Gazette refs). The box is not a third form — it is the editable skin. Which means **`ToolFileRef` *is* the read-only atom**, already shipping; we built the same component twice without noticing. The Gazette's trailing refs stay atoms — they are a placed array — and take the read-only skin. (Resolves A3: the row was never wrong to differ from the prose; the prose was wrong to look like nothing.)

**[P07] `CommitShaText` is a placed value, so it becomes the read-only atom — labelled `Commit <short>`.** An earlier draft folded it into the Mention form, which [P01] contradicts: a sha in a receipt header or a History row arrives in a *field* of a commit record, not as characters somebody wrote in a sentence. It is placed, so it is an atom, and it takes the read-only skin like every other placed thing.

The label matters as much as the form. A bare underlined `227a8eb9` names nothing a reader can act on — eight hex characters do not announce themselves, and a small glyph does not rescue them. A sha **written in prose** needs no help, because the sentence around it supplies the word; a sha standing alone has no sentence, so the word belongs in the label. See [P09].

Commit shas go from three forms to the same two positions every other kind has: an atom where they are placed, a Mention where they are written.

**[P08] The session citation keeps its live dot and obeys [P06].** The dot is real information no other form carries, so the component stays; which skin it wears is decided like everything else.

**[P09] An atom labels itself; a mention is labelled by its sentence.** An atom's label is a *name*, never the raw value — a file atom shows the basename, a commit atom shows `Commit 227a8eb9`. A Mention shows the characters as written and adds no word, because inventing one would be the same fidelity violation as replacing them with a box.

This is not a new idea; it is already written down. `gazette-card.tsx:264` says it exactly: *"A chip stands alone with no sentence around it, so a bare hash names nothing a reader can use. The word is part of the label for that reason — an inline mention needs none, because the prose supplies it."* [P09] is that note promoted from one call site to the rule it always was, which is why the fix for the unreadable bare sha falls out rather than being bolted on.

After this there are **two forms and one variant**, and which one applies is decided before rendering by how the value arrived.

## Call-site inventory

Every place a reference is painted today, and what it becomes. Nothing outside this table needs to change.

| Surface | Today | Becomes | Item |
|---|---|---|---|
| Composer atoms (CM6) | editable skin (`<img>`) | unchanged | — |
| User message replay (`tug-atom-markdown-body`, `tug-atom-text-body`) | editable skin | unchanged — the user placed it, and it stays manipulable in the composer it came from | — |
| Read / Edit / Write / NotebookEdit headers | `ToolFileRef` | unchanged — this *is* the read-only skin | — |
| `pulse-beat-text.tsx` | `ToolFileRef` | unchanged | — |
| Gazette trailing refs (`RefAtom`) | editable skin (`TugAtomChip`) | read-only skin | W4 |
| Gazette commit ref | editable skin, label `Commit: <9>` | read-only skin, label `Commit <8>` | W4 + W5 |
| `CommitShaText` (commit receipt, History rows) | hand-rolled `<code>` | read-only skin, label `Commit <8>` | W5 |
| Inline `<code>` the annotator confirmed | code tone, no resting signal | code tone **plus** the rule | W2 |
| Split-out prose run (`[data-tugx-wrapped]`) | invisible at rest | the rule | W2 |
| Session citation | `TugSessionCitation` | unchanged component; skin per [P06] | W4 |
| Bare paths in Session-card prose | unmarked | marked | W1 |

Two things are deliberately absent. **`unmentionedRefs` stays** — a ref already named in the prose still should not also appear in the trailing row; the suppression was never the bug ([P06]). And **`registry.ts` is untouched** — behavior was already right, and the whole shape of this work is that no gesture changes.

## Retired — do not re-propose

Recorded because each was considered and rejected with a reason, and each is the obvious next idea for anyone reading this cold.

- **A resting colour/tint for a resolved entity.** Failed on the bench. Colour is not an affordance, and it collides with the code tone, which already uses that channel to mean something else. [P05].
- **Token / Ref / Mention as three peer forms.** An earlier draft's model. The box is a *skin*, not a form — treating it as a third form is what let two components drift into being the same thing. [P06].
- **Unboxing every placed value, including the Gazette's trailing refs, on the theory that boxes mean "editing".** Half right. Boxes mean *manipulable in place*, and the Gazette row is read-only, so it unboxes — but it stays an **atom**, because `refs` is a placed array. The distinction matters: the row was never the defect.
- **Atoms (chips) for actionable entities in prose.** The measurable cost is the 25px line-height floor spreading to every paragraph; the principled cost is that a chip replaces text the author wrote. See *Why prose mentions are not atoms*.
- **Folding `CommitShaText` into the Mention form.** An earlier draft's [P07]. Contradicted by [P01] — a sha in a receipt header is a field, not a sentence.
- **Stripping the code tone from a confirmed path so backticked and bare look identical.** [P04]: that overrides the author's own emphasis, which is the same violation as replacing prose with a box.

## Open questions for the plan

Three, all narrow, none blocking the shape.

1. **Does the read-only skin carry the code font?** `ToolFileRef` sets `font-family: inherit`, which lands correctly in a tool header (the detail slot is already mono) and lands as *prose font* in the Gazette's trailing row. The bench pins the row to mono explicitly (`.gep-refs-unboxed`) to make the question visible. Decide it once, in the component, rather than per consumer.
2. **Does `ToolFileRef` get renamed?** It is no longer "the thing in a tool header" — it is the read-only atom skin, and W5 widens it past `file-path` to commits. The name will actively mislead. Renaming is mechanical but touches six call sites; the plan should either do it in W5 or say why not.
3. **Copy round-trip for the relabelled commit atom.** The Gazette row's label goes from `Commit: <9>` to `Commit <8>`, and `CommitShaText`'s right-click already writes `Commit <8>`. Check `copy-as-plain-text.ts` and `selectionToTranscriptMarkdown` yield one spelling, not two.

**Explicitly not a question: theme tokens.** The rule is `1px solid color-mix(in srgb, currentColor 45%, transparent)` — derived from the ink it underlines, so it needs no per-theme value and cannot drift across the six themes. No `--tug7-*` addition, no `audit:theme-contrast` exposure.

## Work

| # | Change | Files |
|---|---|---|
| W1 | Retire the `inCode` license and the `proseCitesPaths` field; one detection gate for every surface | `annotator/annotate-content.ts` (`annotatePathsInText`), `annotator/types.ts` (delete the field), `gazette-card.tsx` (`useGazetteAnnotation`), `transcript-host-helpers.ts` (`useAnnotationContext`) |
| W2 | Resting underline (1px solid, `currentColor` 45%) for a resolved Mention; hover keeps the full link treatment | `styles/tug-annotation.css`, `tug-markdown-view.css` |
| W3 | The two channels kept independent: code tone from backticks, rule from the verdict | `tug-markdown-view.css` |
| W4 | `ToolFileRef` becomes the read-only atom skin; Gazette refs adopt it | `gazette-card.tsx` (`RefAtom`), `tool-file-ref.tsx` |
| W5 | Widen the read-only skin past `file-path`; `CommitShaText` → commit atom labelled `Commit <short>` | `tool-file-ref.tsx`, `commit-sha-text.tsx`, `commit-presentation.tsx`, `tug-history-list.tsx` |
| W6 | Doctrine into tuglaws; placed-vs-written and [P09] named as the vocabulary | `tuglaws/` |

W1 is the one with reach — it changes what gets marked on the Session card, the surface with the most ink, and it is the only item that can regress performance. W2/W3 are CSS. W4/W5 are component swaps onto marks already stamped correctly. W6 is prose.

Order matters once: **W1 before W2.** The rule is only legible against a corpus of marks that is already consistent, and shipping the underline first would paint the current arbitrariness in a brighter colour.

**W1's real risk is cost, not correctness.** Widening `proseCitesPaths` to the Session card means every path-shaped token in every assistant paragraph asks `resolvePath`. The answer is cached and detection was always permissive, but the Session card carries far more ink than the Gazette, and `at0309` exists to measure exactly this. Read it before and after; a plan that does not is not done.

**Bench:** `gallery-entity-presentation.tsx` + `.css`, registered in `gallery-registrations.tsx`, covered by `at0381`. Temporary by construction — it paints today and proposed side by side against real resolvers, and it has served its purpose once the app itself shows the proposed column. **Retire all four files as the last step of the last work item**, whether the brief ships or is abandoned; a bench that outlives its question becomes a second source of truth.

**Coverage.** `at0346` (annotation atom + whole entity), `at0368` (Gazette session citations), `at0310` (commit receipt annotations), `at0309` (annotator cost — the W1 gate), `at0381` (the bench). New assertions belong with the surface they cover, not in a new file per work item.

## Done means

1. A path that resolves is marked, and looks the same, whether it was backticked, written bare, or cited with a line number — on the Session card and in the Gazette alike.
2. An inline `<code>` span that resolves to nothing looks exactly as it does today.
3. `grep -r proseCitesPaths` returns nothing.
4. Every placed value in read-only ink wears the read-only skin, and every commit atom says the word `Commit`.
5. No gesture changed. `registry.ts` is untouched, and every click and context menu that worked before works identically.
6. `at0309` shows no meaningful regression in annotator cost on the Session card.
7. The bench and its test are deleted.

# Entity presentation — placed atoms, written mentions

A file path in the transcript could once be painted four different ways and a commit sha three, and which one you got was decided by the container the entity arrived in — an editor atom, a tool input, a ref list, a pair of backticks the model happened to type. The container is a fact about our plumbing that the reader cannot see and does not care about. This doc is the rule that replaced it, and it is a rule about **authorship**.

## The rule

**An atom is something someone _placed_. A mention is something someone _wrote_.**

The rule's value is that it is never a judgment call: **placed things arrive in a slot, written things arrive in a stream**, and the substrate records which before anything renders.

| Arrived as | Authorship | Form |
|---|---|---|
| `U+FFFC` plus an entry in the `atoms` array | the user picked it from `@`-completion | **Atom** |
| a tool call's `file_path` JSON field | the system placed it in a field | **Atom** |
| an entry in a Overview post's `refs` array | the model placed it in a list | **Atom** |
| a commit record's sha, in a receipt header or a History row | the record placed it in a field | **Atom** |
| characters inside a markdown string | somebody wrote a word | **Mention** |

No heuristic, no resolver verdict, no per-surface flag, no backtick inspection decides the form. Placed-ness is structural, so it cannot drift.

The user/assistant axis is really *picked versus typed*, and it cuts across both. `@`-mention a file and you get an atom; type the same path by hand into the same message and you get a mention. Those genuinely were two different acts. What you placed comes back as what you placed.

## Vocabulary

Four words, used precisely. A change that renames them is fine; a change that blurs them is not.

- **Atom** — the rendering of a *placed* value. Shows a **name**, never the raw value. Two skins, never more.
- **Editable skin** — the boxed chip (`TugAtomChip`, and the CM6 `createAtomImgElement`). Only where the object can be selected, deleted, or dragged **in place**: the composer, and its echo in the submitted message.
- **Read-only skin** — glyph plus label, transparent, no border (`TugAtomRef`). Everywhere else a placed value appears: tool-call headers, pulse beats, Overview trailing refs, commit receipts, History rows.
- **Mention** — the rendering of a *written* value: the characters exactly as written, plus the resting rule when a resolver confirms them. One kind is normalized rather than as-written: a confirmed commit sha displays as `commit:<8ch>` (see below), because a sha's spelling is git's output, not the author's prose.

There is no third form. "Chip", "ref", and "citation" are legacy words for one of the two skins and are not separate concepts.

The box is not a form, it is a **skin**, and it means one thing: *this object is manipulable where it sits*. Treating the box as a third form is what let two components drift into being the same thing — `ToolFileRef` was the read-only atom for years before anyone noticed we had built it twice.

## Two channels, not one

Backticks stopped gating *actionability* and kept gating *emphasis*. These are orthogonal channels, and confusing them was ours to fix, not the reader's.

| Channel | Says | Driven by |
|---|---|---|
| **Code tone** (mono + `--tugx-md-inline-code-*`) | *the author formatted this as code* | the backticks, exactly as `*` drives italic |
| **The rule** (1px underline) | *this responds to a click* | the resolver verdict, and nothing else |

They compose four ways and every combination is legible: backticked and resolves = code tone plus the rule; bare and resolves = body colour plus the rule; backticked and resolves to nothing = code tone alone; bare and nothing = plain prose.

The code tone **stays** on a confirmed path. Stripping it would be us overriding what the author wrote, which is the same fidelity violation the rule refuses when it declines to replace prose with a box.

### The house voices backtick every path

The four combinations are legible, but a paragraph that uses two of them for the *same file* is not saying anything by the difference — and that is what produced most of the variance a reader sees. The fix is not at the renderer, which must show what was written; it is at the writer.

**Anything authoring prose for these surfaces backticks every file path it writes, every time** — this assistant in a transcript, the Overview's Observer and Operator, the tripwire's headline, the dash skills. Not the first mention and then bare afterwards: one reference, one face. This is the same move the commit sha already makes, for the same reason and one step further along — there the app supplies a *word* the writer omits, here the writer supplies a *tone* only they can, because backticks are authorship and the renderer may not invent them.

A **user's** prose is untouched by this. Their spelling is theirs, backticked or not, and the resolver confirms it either way; the rule binds the voices we write, which are the ones that were inconsistent.

## One detection gate

`resolvePath` is the gate, and it is the only one. Detection is permissive by design and every path-shaped token on every surface is sent to the resolver; nothing becomes a link until a resolver confirms a real file. Markup does not gate, and neither does the surface: there is no per-surface "this prose cites paths" flag, and there is no license earned by sitting inside `<code>`.

The cost of a wrong guess is one cached lookup and text that stays text. The cost of the old license was that the identical sentence naming the identical file was a live reference in one card and dead text in another.

## The resting rule

A confirmed **Mention**, and an **Atom** the annotator marked, carry the same thing at rest:

```css
text-decoration-line: underline;
text-decoration-style: solid;
text-decoration-thickness: 1px;
text-decoration-color: color-mix(in srgb, currentColor 45%, transparent);
text-underline-offset: 0.2em;
```

On hover it takes the full link treatment, unchanged.

Three things about this are load-bearing:

- **It is an underline, not a tint.** Colour is not an affordance. A hue shift says *this token is a different category of thing*, which is what the code tone already says, and stacking a second subtler hue on top asks the reader to read two levels of one channel and infer *clickable* from the difference. Nobody learns that. An underline is the one signal already learned to mean *you can act on this*.
- **It is weight, not absence.** Six mentions in a paragraph is the density that once produced a resting-plain rule — the affordance removed entirely, so you could not hover what you did not know was there. The answer is a quiet rule, settled at 45% against exactly that paragraph. 28% and 70%-dotted were auditioned and rejected.
- **It costs no layout metric.** A verdict lands *after* the ink is painted. `text-decoration` never reflows, so a late answer can add the signal to a streaming transcript without moving anything. A border, a padding, or a font change here would not have that property, and none may be added.

The colour is derived from the ink it underlines, so it needs no per-theme value, cannot drift across the six themes, and is deliberately absent from `audit:theme-contrast`. Do not give it a `--tug7-*` token.

**An atom wears it too.** The rule says one thing — *this responds to a click* — and that fact is the same fact whether the reference was written into a sentence or placed in a field. For a while it was not: the atom skin declared a hover-only version of its own, so the identical file, named in prose and named in the tool header of the very edit that touched it, disagreed at rest about whether it could be clicked. A reader cannot hover what nothing tells them to hover, and "there is a small glyph beside it" is not that signal — the glyph says *an object is here*, which is the other channel again. The affordance is one channel, one weight, everywhere.

### Where the rule is registered

**One place: `tugdeck/styles/tug-annotation.css`.** One declaration, keyed on the annotation contract rather than on the element the contract landed on — which is what lets a split-out run, a whole `<code>` span, and an atom's label share it instead of restating it three times, as they did until they drifted.

Two lists are enumerated there, not wildcarded, and **adding a kind means adding it to them.**

The **kinds** that take the rule: `file-path`, `directory`, `commit-sha`, and — on `<code>` only, because `classifyInlineCode` is their only producer — `slash-command` and `shell-command`. Excluded:

- `session` — a confirmed session run is the mount point for a live citation chip, which carries its own affordance and empties the span it mounts into. The chip is the atom; the run is only its host.
- `url` / `email` — anchors, already links.

The **shapes** a reference takes, because `.tugx-annotation` is the *behaviour* contract and more than references wear it. A Grep match row and a path-list row are annotated so that a click anywhere along them opens the file; underlining those would draw a line across a whole line of code. So the rule reaches `[data-tugx-wrapped]` runs, `code` spans, and `.tug-atom-ref-label` — and a host that is merely a target says so in its own sheet, with a wash and a cursor.

The label is a box of its own for exactly this reason: a decoration set on the skin paints across every inline box inside it, and the leading glyph is one. **An atom's mark is its name.** The glyph is not a character and takes no rule; on hover the whole skin lights, because the colour is not the affordance and never was.

An inline `<code>` span with no annotation matches nothing and looks exactly as it always has. That is the test that the two channels really are independent.

## An atom labels itself; a mention is labelled by its sentence

An atom's label is a **name**, never the raw value. A file atom shows its basename. A commit atom shows `commit:227a8eb9`, and a claude session — an arc stage's, in the `/dash-arc` receipt — shows `session:d0a7daa1` on the same terms and at the same length.

The word is part of the label because an atom stands with no sentence around it. Eight bare hex characters name nothing a reader can act on, and a small glyph does not rescue them.

**The spelling is one token.** Lowercase word, colon, hash, no space anywhere: `commit:227a8eb9`. The colon is what makes the word a qualifier rather than a sentence — `Commit 227a8eb9` reads as prose the app wrote on the author's behalf, and `Commit: 227a8eb9` reads as a field in a form; the closed-up form reads as what it is, a machine name for a machine value.

**The label never changes size.** It is set in whatever it sits in — a History row's mono, an Overview post's prose, a receipt header — and the sheets say nothing about its size. Shrinking it was tried in both places and was wrong in both: a commit is rarely alone. A History row and a `/commit` receipt lead with `commit:<8ch>` and set the subject immediately beside it; a post says `Confirmed commit:eea258a9 is a real commit` in one breath. A label a fraction smaller than the words it stands among reads as a different, lesser kind of text rather than as the thing the sentence is about, and the mono face already says everything about it that a size change was trying to.

**The atom answers the pointer.** The skin's hover rule is keyed to the annotation contract, and a commit atom carries none — `CommitShaText` stops every pointer gesture on the sha so a right-click cannot fold the row out from under its own menu — so the rollover is stated there instead (`commit-sha-text.css`): the same underline an annotated atom and a confirmed mention wear, and no more. The cursor stays `default` and the colour does not move: a sha is a copy target, and a link's hover colour would promise a navigation that never comes.

**A confirmed commit mention takes the same label.** The as-written rule protects authorship, and a sha's spelling has none to protect: the author pasted whatever short form git happened to emit, and git's short form lengthens with the repository, so raw shas drift between 7 and 12 characters from one post to the next. That variance is machine noise wearing the costume of prose. So a commit sha the resolver confirms displays as `commit:<8ch>` wherever it was written — Overview posts, session transcripts — via the tip portal that already owns the span (`useCommitTipPortals`), with the written characters preserved on `data-tugx-commit-text` for re-scan and for the unwrap path. When the prose immediately before the run already ends with the word — `Commit abc123def`, `commit: abc123def` — the label yields it and shows the hash alone, so the sentence never reads `Commit commit:abc123de`. **A yield is a repair, not the target form:** anything authoring prose for these surfaces — the Overview agent, the dash skills, this assistant — writes the bare sha and lets the app supply the word, so the reader gets `commit:<8ch>` rather than the sentence's own spelling of it. An *unconfirmed* hex run stays exactly as written: normalization is earned by the verdict, and prose that merely looks sha-shaped is never rewritten.

This is deliberately narrower than it looks. File paths, commands, and session refs stay as-written — their spelling *is* authorship (a relative vs. absolute path, a flag order, a nickname). The commit sha is the one entity whose written form carries zero authorial intent, which is why it is the one entity that normalizes.

One consequence worth stating: because the label is what the DOM holds, and plain copy writes the selection's own text, the label is also the clipboard spelling. One string, not two — and for a commit mention that string is `commit:<8ch>`, the same one the atom's right-click Copy writes.

## An atom's size is its surface's register, never a call site's choice

The rules above settle what an atom *is*. This one settles how big it is, and it exists because the answer used to be "whatever the host it landed in happened to be set in."

**A register is a fact about the surface; a size is a value a call site invents.** That is the whole distinction. There are two, and they are named for what the surface is rather than for how big it wants its marks:

- **`prose`** — an atom standing in a line of running text. A transcript row, a composer line, a list row's hint, a rail's ink. The line box is floored to hold the atom, so the atom never changes the leading of the lines around it by being present.
- **`reading`** — an atom in a block at reading scale, where there is no line to disturb and the mark can breathe. The Changes shade's dash block, the telemetry placard.

They differ in **one number**, the box height, and agree on everything else — type size, dot diameter, inline padding, corner radius, border. A citation in the transcript and a citation in the Changes shade are the same mark at two densities, not two marks, and a register that drifted on type or dot would make them two.

**The face is the atom's, like the size.** A register decides the box and the type size; the *typeface* is not a register dimension because it does not vary — an identity atom is a named object, not a run of its host's text, and there is no mono rendition of one. The chip skin declares it, so a mono host cannot restyle the mark: dropped into the History shade's mono commit rows the pill came out in IBM Plex Mono, a size larger and a good deal wider than the 12px mono subject beside it, which read as a different kind of thing on every row that carried one. The `line` tier declares nothing, because presence IS the surface's own text.

**One table, three renderers.** `lib/atom-register.ts` holds it. The DOM renderers take it as custom properties a host publishes (`atomRegisterVars`); the pixel renderers — the inline `<svg>` and the Canvas → PNG bake the editor's CM6 widget mounts — take it as numbers (`atomRegisterMetrics`). There is no third place a vertical number may be authored. The dot is published as its **painted** diameter rather than as a box, because the live mark is a ring glyph that paints a fraction of itself while the bake paints a plain circle; publishing the box would have let the two disagree in exactly the way they did.

**A mark inside an enclosure is sized by its envelope, not by its diameter.** The phase mark is not a dot: it breathes, and it sheds a ring that runs to 1.75× its own glyph box at atom scale. That overflow is deliberate and it is free *where nothing bounds the mark* — which is every surface the indicator was designed for and not this one. Sized as a dot, a 7px mark is a 14px box and a 24.5px halo through a 20px opening, so the ring crossed the pill's border on every beat. So the register's dot is the diameter that fits under a ceiling (`ATOM_DOT_CLEARANCE` inside the pill's opening), the indicator publishes `markRingEnvelope` for any bounded caller to size against, and the rest of the mark's geometry is still the indicator's own. The ring is not clipped and the reach is not reduced: a ring that stops on the border reads as touching it, and a mark touching its own pill reads as a fault in the pill rather than as liveness.

**The line box is sized for the atom, not the atom for the line box.** This is the inversion the register performs. Every prose surface floors its leading from the register — the transcript's two bodies with a cushion for a baseline-aligned mark's overhang, the editor with a pixel of air so two atoms on adjacent wrapped rows keep apart — and the editor's leading is therefore *derived* rather than pinned. The old arrangement pinned the editor at 1.5 and shrank the chip to fit, which is precisely how an atom came to change size at the moment it was sent.

What that arrangement cost, recorded so the shape of the failure is legible: one session atom stood 18px tall in the composer, 20px in the transcript it was sent to, 21px cited in an Overview post, and 25px in the Changes shade. It stayed invisible for as long as it did because no surface showed two renderers together — the atom gallery showed the bakes and the dash gallery showed the pills. The gallery's Registers section now stands them side by side, and `at0490-atom-register-parity` measures them in the real app, because a stylesheet and a module disagreeing about a number is a defect a type cannot catch.

## Why prose mentions are not atoms

"Make every actionable thing a chip" is the obvious proposal and it is wrong for two reasons.

**Measurable.** `tug-atom-markdown-body.css` floors *every* markdown line — chip-bearing or not — to the `prose` register's own line-box floor. The floor serves a hard invariant: an atom must never change line height. Extend chips into assistant prose and the floor extends to every paragraph in the transcript, whether or not it names a file.

**About what a transcript is.** A chip does not decorate text, it **replaces** it. `session-citation-portals.tsx` empties the span it mounts into, and the original spelling has to be preserved on `data-tugx-session-text` precisely so the words can be put back if the mark is later dropped. That is honest when an object is what was there and a lie when it is not: the model wrote the characters `session-restore.ts` into a sentence, and a box asserts it placed an object. The transcript's contract is that it shows what was written.

The counter-evidence, recorded so it is not re-discovered as an objection: we already put atoms in prose, since session citations mint a live chip into a confirmed run. It works there for two reasons that do not generalize — a post names *one* session, and the chip carries a live status dot that text genuinely cannot render. Neither holds for file paths, which are dense and static.

## Behavior is not presentation

`tugdeck/src/lib/annotator/registry.ts` owns what a gesture *does*: nine kinds, one delegated listener, one context-menu provider. A file path opens in a Text card whatever painted it, and answers one menu wherever it is shown — the grammar of that menu, and the rule that a surface supplies facts rather than items, is [menus.md](menus.md#context-menus--one-entity-one-menu). None of the above changes any of that, and a presentation change that needs to touch `registry.ts` is a sign the change is not a presentation change.

The read-only skin has two stamping modes for exactly this reason. It stamps the annotation contract on itself where nothing else does (tool headers, pulse beats), and stamps nothing where a host already owns the contract — the Overview's wrapper span, which also owns the pending and unresolvable tooltip states, and `CommitShaText`, which owns every pointer gesture on a sha so a right-click cannot fold the History row out from under its own menu.

The link affordance rides the annotation contract rather than a modifier class: an annotated skin, or a skin inside an annotated wrapper, is clickable. A ref nothing could resolve carries no annotation anywhere and so invites nothing, with no prop threaded to say so. "Annotated" and "actionable" are the same fact — and because the affordance is declared once against that fact, in `tug-annotation.css`, the skin's own sheet does not restate it. A presentation change that adds a second declaration of the rule is re-opening the drift this doc closed.

## Retired — do not re-propose

Each was considered and rejected with a reason, and each is the obvious next idea for a cold reader.

- **A resting colour or tint for a resolved entity.** Failed on the bench. Colour is not an affordance, and it collides with the code tone, which already uses that channel to mean something else.
- **Token / Ref / Mention as three peer forms.** The box is a *skin*, not a form. Treating it as a third form is what let two components drift into being the same thing.
- **Unboxing every placed value on the theory that boxes mean "editing".** Half right. Boxes mean *manipulable in place*. The Overview's trailing refs row is read-only, so it unboxes — but its entries stay **atoms**, because `refs` is a placed array. The row was never the defect; the prose beside it was, for looking like nothing.
- **Atoms (chips) for actionable entities in prose.** The measurable cost is the line-height floor spreading to every paragraph; the principled cost is that a chip replaces text the author wrote.
- **Folding a commit sha into the Mention form.** A sha in a receipt header is a field, not a sentence.
- **Stripping the code tone from a confirmed path so backticked and bare look identical.** That overrides the author's own emphasis, which is the same violation as replacing prose with a box.
- **Suppressing the Overview's `unmentionedRefs` rule.** A ref the prose already named should still not also appear in the trailing row. The suppression was never the bug.
- **A theme token for the rule's colour.** It is `currentColor`-derived by construction. A token would let it drift.
- **A hover-only affordance for a placed atom**, on the theory that a header should stay quiet until reached for. It made a placed reference and a written one disagree at rest about the same fact, which is the drift this doc exists to prevent. Quiet is what the 45% weight is for; absence is not a quieter weight, it is no signal.

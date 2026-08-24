# Entity presentation — placed atoms, written mentions

A file path in the transcript could once be painted four different ways and a commit sha three, and which one you got was decided by the container the entity arrived in — an editor atom, a tool input, a ref list, a pair of backticks the model happened to type. The container is a fact about our plumbing that the reader cannot see and does not care about. This doc is the rule that replaced it, and it is a rule about **authorship**.

Origin: `dash/entity-presentation.md`, which carries the full argument and the record of what was auditioned on the bench.

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

## One detection gate

`resolvePath` is the gate, and it is the only one. Detection is permissive by design and every path-shaped token on every surface is sent to the resolver; nothing becomes a link until a resolver confirms a real file. Markup does not gate, and neither does the surface: there is no per-surface "this prose cites paths" flag, and there is no license earned by sitting inside `<code>`.

The cost of a wrong guess is one cached lookup and text that stays text. The cost of the old license was that the identical sentence naming the identical file was a live reference in one card and dead text in another.

## The resting rule

A confirmed **Mention** carries, at rest:

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

### Where the rule is registered

The kinds that take the rule are enumerated, not wildcarded, in two places:

- `tugdeck/styles/tug-annotation.css` — runs the annotator split out of prose (`[data-tugx-wrapped]`).
- `tugdeck/src/components/tugways/tug-markdown-view.css` — whole inline `<code>` spans the annotator marked.

**Adding a Mention kind means adding it to those lists.** What is excluded, and why:

- `session` — a confirmed session run is the mount point for a live citation chip, which carries its own affordance and empties the span it mounts into. The chip is the atom; the run is only its host.
- `url` / `email` — anchors, already links.
- The atom skins — elements of their own, with their own hover; they never carry `[data-tugx-wrapped]` and match nothing in those lists.

An inline `<code>` span with no annotation matches nothing and looks exactly as it always has. That is the test that the two channels really are independent.

## An atom labels itself; a mention is labelled by its sentence

An atom's label is a **name**, never the raw value. A file atom shows its basename. A commit atom shows `commit:227a8eb9`.

The word is part of the label because an atom stands with no sentence around it. Eight bare hex characters name nothing a reader can act on, and a small glyph does not rescue them.

**The spelling is one token.** Lowercase word, colon, hash, no space anywhere: `commit:227a8eb9`. The colon is what makes the word a qualifier rather than a sentence — `Commit 227a8eb9` reads as prose the app wrote on the author's behalf, and `Commit: 227a8eb9` reads as a field in a form; the closed-up form reads as what it is, a machine name for a machine value.

**The label never changes size.** It is set in whatever it sits in — a History row's mono, an Overview post's prose, a receipt header — and the sheets say nothing about its size. Shrinking it was tried in both places and was wrong in both: a commit is rarely alone. A History row and a `/commit` receipt lead with `commit:<8ch>` and set the subject immediately beside it; a post says `Confirmed commit:eea258a9 is a real commit` in one breath. A label a fraction smaller than the words it stands among reads as a different, lesser kind of text rather than as the thing the sentence is about, and the mono face already says everything about it that a size change was trying to.

**The atom answers the pointer.** The skin's hover rule is keyed to the annotation contract, and a commit atom carries none — `CommitShaText` stops every pointer gesture on the sha so a right-click cannot fold the row out from under its own menu — so the rollover is stated there instead (`commit-sha-text.css`): the same underline an annotated atom and a confirmed mention wear, and no more. The cursor stays `default` and the colour does not move: a sha is a copy target, and a link's hover colour would promise a navigation that never comes.

**A confirmed commit mention takes the same label.** The as-written rule protects authorship, and a sha's spelling has none to protect: the author pasted whatever short form git happened to emit, and git's short form lengthens with the repository, so raw shas drift between 7 and 12 characters from one post to the next. That variance is machine noise wearing the costume of prose. So a commit sha the resolver confirms displays as `commit:<8ch>` wherever it was written — Overview posts, session transcripts — via the tip portal that already owns the span (`useCommitTipPortals`), with the written characters preserved on `data-tugx-commit-text` for re-scan and for the unwrap path. When the prose immediately before the run already ends with the word — `Commit abc123def`, `commit: abc123def` — the label yields it and shows the hash alone, so the sentence never reads `Commit commit:abc123de`. **A yield is a repair, not the target form:** anything authoring prose for these surfaces — the Overview agent, the dash skills, this assistant — writes the bare sha and lets the app supply the word, so the reader gets `commit:<8ch>` rather than the sentence's own spelling of it. An *unconfirmed* hex run stays exactly as written: normalization is earned by the verdict, and prose that merely looks sha-shaped is never rewritten.

This is deliberately narrower than it looks. File paths, commands, and session refs stay as-written — their spelling *is* authorship (a relative vs. absolute path, a flag order, a nickname). The commit sha is the one entity whose written form carries zero authorial intent, which is why it is the one entity that normalizes.

One consequence worth stating: because the label is what the DOM holds, and plain copy writes the selection's own text, the label is also the clipboard spelling. One string, not two — and for a commit mention that string is `commit:<8ch>`, the same one the atom's right-click Copy writes.

## Why prose mentions are not atoms

"Make every actionable thing a chip" is the obvious proposal and it is wrong for two reasons.

**Measurable.** `tug-atom-markdown-body.css` floors *every* markdown line — chip-bearing or not — to `max(1lh, atom-height + 4px)`. The floor serves a hard invariant: an atom must never change line height. Extend chips into assistant prose and the floor extends to every paragraph in the transcript, whether or not it names a file.

**About what a transcript is.** A chip does not decorate text, it **replaces** it. `session-citation-portals.tsx` empties the span it mounts into, and the original spelling has to be preserved on `data-tugx-session-text` precisely so the words can be put back if the mark is later dropped. That is honest when an object is what was there and a lie when it is not: the model wrote the characters `session-restore.ts` into a sentence, and a box asserts it placed an object. The transcript's contract is that it shows what was written.

The counter-evidence, recorded so it is not re-discovered as an objection: we already put atoms in prose, since session citations mint a live chip into a confirmed run. It works there for two reasons that do not generalize — a post names *one* session, and the chip carries a live status dot that text genuinely cannot render. Neither holds for file paths, which are dense and static.

## Behavior is not presentation

`tugdeck/src/lib/annotator/registry.ts` owns what a gesture *does*: nine kinds, one delegated listener, one context-menu provider. A file path opens in a Text card whatever painted it. None of the above changes any of that, and a presentation change that needs to touch `registry.ts` is a sign the change is not a presentation change.

The read-only skin has two stamping modes for exactly this reason. It stamps the annotation contract on itself where nothing else does (tool headers, pulse beats), and stamps nothing where a host already owns the contract — the Overview's wrapper span, which also owns the pending and unresolvable tooltip states, and `CommitShaText`, which owns every pointer gesture on a sha so a right-click cannot fold the History row out from under its own menu.

The link affordance rides the annotation contract rather than a modifier class: an annotated skin, or a skin inside an annotated wrapper, is clickable. A ref nothing could resolve carries no annotation anywhere and so invites nothing, with no prop threaded to say so. "Annotated" and "actionable" are the same fact.

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

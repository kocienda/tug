# List-surface grammar — headers, fact runs, and how an arc is named

The Changes shade, the Arcs card, and the `/arc-bind` picker are three surfaces that answer overlapping questions about the same objects. Each one arrived separately, so each one spelled the same three things its own way: a header over a bucket of rows, a run of small facts after a row's name, and an arc's name. This doc is what they agreed on, and it is a rule about **which component**, not about which numbers.

Origin: a design spike, since deleted, whose findings this document carries. This is the written one.

## The rule

**A surface does not author a header, a fact run, or an arc name. It renders the component that does.**

| The thing | The component | Owns |
|---|---|---|
| The eyebrow over a bucket of rows | `TugSectionLabel` | `--tugx-section-label-*` |
| The small facts after a row's name | `TugMetaRun` / `TugMetaBullet` | `--tugx-meta-run-*` |
| An arc's name, in either register | `TugArcAtom` (`ArcSigil` atom) | `--tugx-atom-*` |
| What a collapsed arc is doing | `ArcLifecycleLine` (track · fraction · note · facts) | its own type and tones |

This is not a style guideline that a careful author upholds. Before the extraction, `tug-changes-list.css` and `session-changes-arc-lane.css` each spelled the eyebrow's five declarations in full, with a comment conceding the duplication was cheaper than a cross-import. That reasoning holds at two users and stops holding at the third. The components exist so that a fourth surface cannot get it wrong by being written carefully.

## The eyebrow

A small tracked-out label at the left, the hairline running through the rest of the line, the bucket's name ahead of a dimmer qualifier.

**A label is a name and an optional qualifier**, not one string with an em dash in it. The two paint differently — so "unattributed" reads before "no session claims these" — and a renderer cannot do that to a flat string without splitting on punctuation, which is a parser standing where a data shape belongs. The em dash is `TugSectionLabel`'s and appears nowhere in the data.

**No bucket carries hue.** Colour here would have to mean something, and the four things it could have meant — ownership, urgency, species, staleness — are all said in words a line below. The headers are spacing with words in it; the rows carry the surface.

The hairline is the label's own trailing `::after`, not a border on the host, so a long header shortens its rule instead of wrapping under it.

## The fact run

A row names one thing and then says a few short things about it: a file's `edit · exact`, an arc's `main · 4 rounds · uncommitted · implementing`. One rule divides the name from its facts, bullets separate the facts from each other, and the type is small and **proportional** — these are read as a sentence about the row, not as identifiers to be typed back. The name ahead of the rule is the run somebody copies, and it keeps its own family. So does any single fact that is genuinely an identifier: an arc's base ref is monospace inside an otherwise proportional run.

**Parts are atomic.** A run lives on a line that is allowed to get narrow, and a fact that shrinks below its own text wraps mid-phrase — `4 / rounds`, `step / 2/5`. A fact is legible whole or it should not be on the line. Exactly one part may give way, and only if it is prose: a step's title, a commit's subject. A counter never gives way, because a half-shown `step 2/5` says nothing while a half-shown sentence still reads.

Two ways to hand parts over, and the difference is real rather than stylistic:

- **`parts`** — a fixed list where some entries may be absent. Nulls drop out and bullets go between whatever survives, so a run missing its middle fact never shows two bullets in a row. Entries must be elements; a bare string lands as an anonymous flex item that no selector can reach, and the atomicity rule would silently skip it.
- **`children`** — for facts that are not a list: conditional fragments interleaved by the surface, some carrying their own bullets and some deliberately carrying none. (The arc lane was the original example; its collapsed row now renders `ArcLifecycleLine` instead — see [D141], [D168] — so the fact run there is retired, not restyled.)

**A run never paints outside its own box.** Atomicity has a cost: parts that will not shrink make a run that cannot shrink, and on a row whose leading and trailing slots are fixed, the excess lands *on top of* the trailing controls — fact text through a Bind button, which is what shipped until it was caught by eye. `fit` is the answer, and a row-borne run has to ask for it: `"clip"` bounds the run to its box and fades the last visible fact out at the trailing edge. `"natural"` stays the default, because a run sized by its own content — a rail row's right-aligned tail, a file row's metadata beside a path that truncates instead — is already correct, and clipping it would cut a fact that had the room.

The fade needs no measured overflow gate the way `TugClamp` does. It covers the trailing edge of the *box*, and a run that fits ends short of that edge, so the gradient falls on empty space and paints nothing. It bites exactly when there is something to cut.

## An arc is named in one of two registers, and the register is the fact

**Bound** — one session atom per live session mated to the arc, each carrying the arc inside it. A session is always shown WITH its bound arc; splitting the two onto one line would state the pairing twice and let the halves drift.

**Unbound** — the caret run in monospace, in the same pill.

Proportional in a pill means somebody is on this. Monospace means nobody is. A reader can sort a list on that before a word is read, which is the whole point: the register carries the fact, so the surface does not have to spend a word on it.

`bound_session` is **one session or none**: an arc is bound to at most one live card, so the register shows one atom or the caret run. Nothing invents a second.

**The pill is never authored at the call site.** `ArcSigil atom` and `TugSessionIdentity` both wear the settled session-atom skin, so radius, hairline, padding and size scale live in `tug-session-identity.css` and change with it. An arc atom and a session atom are siblings by construction, not by two sets of numbers kept equal by hand. Copying those values into a new surface — even as a design proposal — is the specific mistake this paragraph exists to prevent.

The arc is **passed, not looked up**. A surface rendering the row already holds the fact; making the atom re-derive it from the changeset store would put something the row was built from behind a feed arriving.

### The optical outdent

A pill holds its text a border plus its own inline padding in from its edge. A pill that **leads a row**, set flush, makes its edge agree with the glyphs below while its text reads a step right of them. `TugArcAtom` takes back part of that inset — not all of it, because pulling the border to the glyph column aligns the text and misaligns every enclosure, and the enclosure is what a reader sees first.

This applies to a pill in a row's leading slot, which is where `TugArcAtom` puts it. An arc atom rendered mid-line inside a content run is not leading anything and takes no outdent — reach for `ArcSigil atom` directly there.

The outdent is also why a row does not need a second mark saying the arc is unbound. The register already says it: proportional in a pill means somebody is on this, the mono caret run means nobody is, and on the Arcs card the eyebrow's right side says it a second way (a worker's atom, or nothing at all). A dashed-circle glyph ahead of the name once said it a third time and was removed for exactly that redundancy.

### A line stacked under an atom starts on the atom's NAME

An arc block is two lines and sometimes three: who, then what the arc is doing, then what its join is doing. The lines below the first hang under the **name**, not under the pill that holds it — and the pill's text is a border plus its inline padding in from its own edge, which is a number no spacing token knows.

**Indent by that inset, never by a space token that resembles it.** `tug-session-identity.css` publishes it (`--tugx-session-atom-text-inset`, and `-2xs` for the small chip) beside the padding it describes, so retuning the skin retunes what hangs under it. The Arcs card takes the `-2xs` inset directly; the Changes shade takes `--tugx-arc-stack-indent`, which is the **full** inset plus the row's own content indent minus the outdent above — full because the shade's eyebrow atom wears the chip tier's own size — and the lines are siblings of the row rather than children of it.

**One grammar, one scale — and the atom leads it.** The Arcs card, the Changes shade and the arc receipt render the same `ArcLifecycleBlock` at the same scale, the atom at the chip tier's one size. A `size` dial once let the card ask for a rail scale and the shade for a reading scale, and it was retired with the second atom register ([entity-presentation](entity-presentation.md#an-atoms-size-is-its-surfaces-register-never-a-call-sites-choice)): the rule that keeps a block coherent is that the atom and the lines beneath it move together — an atom a step smaller than the facts it heads reads as a caption over its own content, and a line a step smaller than the register beneath it reads as a footnote to its own block — and one scale is the only way to hold it without a second number to keep in step.

**And two shapes, which is a different axis from scale.** The block above is for a surface whose subject is the arc. Where a SESSION is the subject — the masthead's title run, the Cards card's session rows — the row wears `ArcLifecycleMark` instead, and never the track ([D168]): a strip beside an eliding name is a graphic competing with the thing the row is named for.

The failure this prevents is specific and it shipped once. A near-miss is worse than no indent at all: a second line two pixels short of the name on the card, and nine short of it in the shade, reads as two lines that *missed* each other rather than as a column. Nothing could catch it, because the surfaces were compared by eye against a design that used the same components at a different offset. `at0407` and `at0405` now assert the two lefts are equal, measured against the rendered name so the assertion cannot outlive a retune.

**The block is separated from its neighbour by a step, not a hairline.** The eyebrow's rule divides one arc from the next *within* a line; it cannot also make a two-line block read as a unit. At a hairline of padding the second line of one arc sits as close to the eyebrow of the next as to its own.

## An endgame surface is the commit receipt's own row

An arc's endgame — the Changes shade's arc fold, the Arcs card's ready row — used to be three lookalike strips, each with its own type scale and its own spacing. That is how a directory row came to set its subordinate fact *larger* than the path the fact qualified. The correction is the same move the eyebrow and the fact run already made: stop authoring the row and render the one that exists.

**The row is the commit receipt's: `TugListRow` in `variant="flush" density="compact" mono`.** A document, a conflict path, a rung, a changed directory, a round's subject — every line the fold draws is that row, so the fold's rows and a receipt's rows cannot drift apart. A 2ch leading cell holds a glyph or an ordinal, so the content column starts where a `TugStatusMark` would put it.

**One height, and it is declared rather than left to the content.** A row carrying an open cue is as tall as the button; a row carrying only text is as tall as its line. Left alone the two differ by a few pixels, and a strip standing over a strip then reads as two lists. `TugListRow` publishes `--tugx-list-row-min-height` for exactly this, and the fold sets it once, as arithmetic over the button's own published geometry and the row's own padding — never a literal, which would be right until the first retune.

**Two type sizes, and no more.** The fold's own text is `xs`, except the one line the reader came for — a draft's subject — at `sm`. Nothing else steps. **Distinctions are carried by face and tone, never by size**: mono for a path, sans for prose and for a fact, muted for what qualifies and full strength for what is named. A fact set smaller than the row it qualifies is what sets a column's baselines wandering, and it says nothing a tone does not say better. Chrome the surface hosts but does not author — a `TugSectionLabel`, a `TugBadge`, a `TugInlineDialog`, a mounted wizard — keeps its own scale; that is a short, named list rather than a filter that grows until a test passes.

**A row's trailing cluster is ordered counts · pop-out · fold, and the last control on a row is the one that acts on the row.** The counts describe, the pop-out takes the row's subject somewhere else, and the fold opens the row itself — so the cursor's shortest travel ends on the act with the largest effect on what is in front of it.

**Air comes from a row's own padding and a section eyebrow's own margin, and from nothing else.** No gap between sections, no per-section content hang, no block margins on nested lists. Each of those compounds with the other two, which is how three short sections come to fill a screen. A `TugSectionLabel`'s `margin-top` is what separates one section from the last row of the one before it; a row's own 1px is what separates it from its neighbour. A section that wants its rows to hang under its heading is asking for a level of nesting the eyebrow already supplies.

### One fact, one colour

A fact that is worth tinting is tinted **once, in one hue, everywhere it appears on the line**. A conflicted path's glyph, its path and its trailing fact all take `--tug7-element-tone-icon-normal-danger-rest` — the same red the lifecycle line's stopped reading takes — rather than a mark in one red and its words in a lighter one.

Two strengths of the same signal read as two facts of different severity, and there is only one fact. The lighter `--tug7-element-tone-text-normal-danger-rest` exists for prose set in danger, not for a second rung under the icon tone; a row that mixes them is saying something about its own parts that is not true. The tone families themselves are [theme-engine](theme-engine.md#tinted-neutral-authoring-doctrine)'s — signals are fixed across themes by hue — and this is the rule about spending one.

## Vocabulary

- **`uncommitted`**, never `dirty`. `worktree_dirty` is the wire's spelling and stays the wire's; no surface shows the word.
- **No possessives.** A bucket is named by where its files live: "changes in this session", never "this session's changes". The apostrophe-s reads as ownership language in a surface whose whole subject is contested ownership, where "claimed", "unattributed" and "orphaned" already carry that meaning precisely.
- **The fronted arc's header names what is true.** Usually the fronted arc is the one the session is mated to, and the header says so. But a join aimed by name fronts its target, which may be an arc the card never bound — and one label covering both would claim a binding that does not exist, on precisely the row offering **Adopt** to create it.

## Adjacent, and deliberately not settled here

The trailing dismiss on the Changes shade — an X at card-header button size at the top-right — is chrome placement, not list grammar. Whether every other sheet adopts it is a chrome audit that has not been done, and this doc does not claim it.

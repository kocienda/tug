# List-surface grammar — headers, fact runs, and how a dash is named

The Changes shade, the Lens's Unbound Dashes section, and the `/dash-bind` picker are three surfaces that answer overlapping questions about the same objects. Each one arrived separately, so each one spelled the same three things its own way: a header over a bucket of rows, a run of small facts after a row's name, and a dash's name. This doc is what they agreed on, and it is a rule about **which component**, not about which numbers.

Origin: the design spike in `gallery-changes-dashes`, which is the rendering reference. This is the written one.

## The rule

**A surface does not author a header, a fact run, or a dash name. It renders the component that does.**

| The thing | The component | Owns |
|---|---|---|
| The eyebrow over a bucket of rows | `TugSectionLabel` | `--tugx-section-label-*` |
| The small facts after a row's name | `TugMetaRun` / `TugMetaBullet` | `--tugx-meta-run-*` |
| A dash's name, in either register | `TugDashName` | `--tugx-dash-name-*` |

This is not a style guideline that a careful author upholds. Before the extraction, `tug-changes-list.css` and `session-changes-dash-lane.css` each spelled the eyebrow's five declarations in full, with a comment conceding the duplication was cheaper than a cross-import. That reasoning holds at two users and stops holding at the third. The components exist so that a fourth surface cannot get it wrong by being written carefully.

## The eyebrow

A small tracked-out label at the left, the hairline running through the rest of the line, the bucket's name ahead of a dimmer qualifier.

**A label is a name and an optional qualifier**, not one string with an em dash in it. The two paint differently — so "unattributed" reads before "no session claims these" — and a renderer cannot do that to a flat string without splitting on punctuation, which is a parser standing where a data shape belongs. The em dash is `TugSectionLabel`'s and appears nowhere in the data.

**No bucket carries hue.** Colour here would have to mean something, and the four things it could have meant — ownership, urgency, species, staleness — are all said in words a line below. The headers are spacing with words in it; the rows carry the surface.

The hairline is the label's own trailing `::after`, not a border on the host, so a long header shortens its rule instead of wrapping under it.

## The fact run

A row names one thing and then says a few short things about it: a file's `edit · exact`, a dash's `main · 4 rounds · uncommitted · implementing`. One rule divides the name from its facts, bullets separate the facts from each other, and the type is small and **proportional** — these are read as a sentence about the row, not as identifiers to be typed back. The name ahead of the rule is the run somebody copies, and it keeps its own family. So does any single fact that is genuinely an identifier: a dash's base ref is monospace inside an otherwise proportional run.

**Parts are atomic.** A run lives on a line that is allowed to get narrow, and a fact that shrinks below its own text wraps mid-phrase — `4 / rounds`, `step / 2/5`. A fact is legible whole or it should not be on the line. Exactly one part may give way, and only if it is prose: a step's title, a commit's subject. A counter never gives way, because a half-shown `step 2/5` says nothing while a half-shown sentence still reads.

Two ways to hand parts over, and the difference is real rather than stylistic:

- **`parts`** — a fixed list where some entries may be absent. Nulls drop out and bullets go between whatever survives, so a run missing its middle fact never shows two bullets in a row. Entries must be elements; a bare string lands as an anonymous flex item that no selector can reach, and the atomicity rule would silently skip it.
- **`children`** — for facts that are not a list. The dash lane interleaves conditional fragments, some carrying their own bullets and one (the step title) deliberately carrying none.

## A dash is named in one of two registers, and the register is the fact

**Bound** — one session atom per live session mated to the dash, each carrying the dash inside it. A session is always shown WITH its bound dash; splitting the two onto one line would state the pairing twice and let the halves drift.

**Unbound** — the caret run in monospace, in the same pill.

Proportional in a pill means somebody is on this. Monospace means nobody is. A reader can sort a list on that before a word is read, which is the whole point: the register carries the fact, so the surface does not have to spend a word on it.

`bound_sessions` is a **list**, and two cards on one dash is doctrine rather than a race. Every bound session gets an atom. Nothing invents a "+1 more".

**The pill is never authored at the call site.** `DashSigil atom` and `TugSessionIdentity` both wear the settled session-atom skin, so radius, hairline, padding and size scale live in `tug-session-identity.css` and change with it. A dash atom and a session atom are siblings by construction, not by two sets of numbers kept equal by hand. Copying those values into a new surface — even as a design proposal — is the specific mistake this paragraph exists to prevent.

The dash is **passed, not looked up**. A surface rendering the row already holds the fact; making the atom re-derive it from the changeset store would put something the row was built from behind a feed arriving.

### The optical outdent

A pill holds its text a border plus its own inline padding in from its edge. A pill that **leads a row**, set flush, makes its edge agree with the glyphs below while its text reads a step right of them. `TugDashName` takes back part of that inset — not all of it, because pulling the border to the glyph column aligns the text and misaligns every enclosure, and the enclosure is what a reader sees first.

This applies to a pill in a row's leading slot, which is where `TugDashName` puts it. A dash atom rendered mid-line inside a content run is not leading anything and takes no outdent — reach for `DashSigil atom` directly there.

The outdent is also why a row does not need a second mark saying the dash is unbound. The Lens's Unbound Dashes section carried a dashed-circle glyph ahead of every name, under a header already reading **Unbound Dashes**, over rows that are unbound by construction: three statements of one fact on one line. Removing it left the name leading the row, which is the shape `TugDashName` is built for.

## Vocabulary

- **`uncommitted`**, never `dirty`. `worktree_dirty` is the wire's spelling and stays the wire's; no surface shows the word.
- **No possessives.** A bucket is named by where its files live: "changes in this session", never "this session's changes". The apostrophe-s reads as ownership language in a surface whose whole subject is contested ownership, where "claimed", "unattributed" and "orphaned" already carry that meaning precisely.
- **The fronted dash's header names what is true.** Usually the fronted dash is the one the session is mated to, and the header says so. But a join aimed by name fronts its target, which may be a dash the card never bound — and one label covering both would claim a binding that does not exist, on precisely the row offering **Adopt** to create it.

## Adjacent, and deliberately not settled here

The trailing dismiss on the Changes shade — an X at card-header button size at the top-right — is chrome placement, not list grammar. Whether every other sheet adopts it is a chrome audit that has not been done, and this doc does not claim it.

# New Arc

**Purpose:** Starting an arc depends on knowing to type `/arc`. Give it a graphical hook that belongs to the session, and stop the arc shade spending room on panels that have nothing in them.

---

## Purpose {#purpose}

A File ▸ New Arc menu item was built on `main` (landed as `e598aecc1`) and tried. The user's notes on it:

> The *New Arc* menu doesn't really do what I want, since it just creates a new session card. Maybe the menu command in the *File* menu is just wrong. Maybe this command, if we want it at all, belongs in the *Session* menu. Whatever we do, we need to think about what this means, to start an arc using some kind of graphical hook that lives in the UI. We can't relay only on someone knowing they can type /arc.

> When we show the arc shade, we should more intelligently size the 2×2. Each row should only be as tall as it needs to be to accommodate the content (i.e. the latter of the two columns in that row).

and, once the sketch had been through two rounds:

> The idea is that this operation brings the arc into existence. It should dimmed if there is already an arc for that session.

> [Idea and Sketch are] still in-transcript resources only, I think. However, if an arc exists, they should be taken up into it and updated if they change.

> arcs are tied to sessions, and the card isn't

The standing constraint from the earlier work holds: the command is named **New Arc**, and no new term enters the product.

---

## Evidence {#evidence}

**[F01] File ▸ New Arc opens an empty Session card and sends `/arc` into it.** The build on `main` (`e598aecc1`) adds the item `file.newArc`, the action `new-arc`, a deck handler that adds a Session card and stashes `/arc` as its opening command, and an `openingCommand` field on the `restore` body intent so the command survives the card's hand-off to its body and its picker. `tests/app-test/at0862-new-arc-menu.test.ts` passes on it. The card it opens holds no idea, no sketch and no brief, which is the state in which `/arc` has the least to work from. **(verified, built and run)**

**[F02] The short arc shade tells the user to type.** `SessionArcShadeHint` (`tugdeck/src/components/tugways/cards/session-arc-shade-hint.tsx`) shows `None`, one sentence on what an arc is ending "describe the change in this session and type `/arc`", and a help link. It has no control that starts an arc. **(verified, by reading)**

**[F03] The four panels appear only when an arc is bound.** `SessionArcShadeContent` renders the hint when the session has no arc fact and `SessionArcPanels` otherwise; `SessionArcShade` picks its height form the same way, `short` (content height, up to 80%) with no arc and `full` (a fixed 80% of the transcript slot) with one. **(verified, by reading)**

**[F04] The grid's rows split a fixed height 3:2.** `session-arc-panels.css` gives the grid `height: 100%` and `min-height: 400px`, with row and column tracks of `1fr` that become `3fr`/`2fr` according to the grid's `data-focus`. So the row holding Idea and Sketch takes two or three fifths of the shade whatever is in it. **(verified, by reading)**

**[F05] Idea and Sketch are always empty today.** Both panels are the constant `NOT_RECORDED` ("Nothing recorded for this arc yet") in `session-arc-shade-content.tsx`, and nothing in the `/arc` skill or `tugtool arc documents` records an idea or a sketch: the documents are the brief, the devised plan and the door's task list. With [F04], the top row of every arc shade is two one-line panels in 40% or more of the shade. **(verified, by reading)**

**[F06] The larger share drives two other behaviours.** `SessionArcPanels` writes `data-focus` on a press or on keyboard focus and scrolls the pressed panel into view; the sheet hides every verb but the lead one in the Arc panel while it is not the focused panel (`verbLabels="lead-only"`). `at0860-arc-panels.test.ts` asserts the share on press, on focus and on a fresh raise, and the small panel's lone verb. **(verified, by reading; the test's assertions are from its landing commit `aeda932cc7`)**

**[F07] Session menu items that run a slash command already exist.** `sessionCommandItem(title, command, id)` in `tugapp/Sources/MenuBarBuilder.swift` builds an item whose action runs the named command in the key Session card: Commit Changes, Rename Session…, Compact Conversation and the rest. **(verified, by reading)**

**[F08] The arc shade has a command and a chord.** `TOGGLE_ARC_SHADE` ("Show Arc", ⌥⌘R, routed to the key card) raises and lowers it. **(verified, by reading)**

**[F09] An arc needs a name and a document before it can exist.** The `/arc` skill settles the name in conversation and opens an arc on a document, "never on an idea"; `tugtool arc run <name>` needs the document. **(verified, by reading `tugplug/skills/arc/SKILL.md`)**

---

## Decisions {#decisions}

### Where an arc starts

**[B01] New Arc is an act on a session, and it runs `/arc` in that session.** An arc is tied to a session and climbs from what that session holds, so the command acts on the session the user is in and never opens a card. Pressing it sends `/arc` as a turn; the door then does what it does today.

**[B02] The arc exists after the door's turn, not at the press.** The door names the arc and settles its brief ([F09]). An arc that exists the instant the button is pressed would have no name, no brief and no worktree, and the user does not want unnamed arcs designed.

**[B03] New Arc is offered in two places: a button in the short arc shade, and Session ▸ New Arc.** The shade is where the session's arc is shown, so it is where an absent arc is started; the menu item is the same command for the key Session card. The item carries no chord.

**[B04] New Arc is dimmed when the session already has an arc, and while a turn is running.** With an arc, the menu item is disabled; in the shade the question does not arise, because the button is on the short form, which a session with an arc never shows. While a turn is running both the menu item and the shade's button are dimmed: the door is a conversation, and it is not queued behind work in flight. A card with no session yet has nothing to run `/arc` in, so the menu item is dimmed there too.

**[B05] File ▸ New Arc is removed.** The build of [F01] landed on `main` as `e598aecc1`, and the arc takes it out whole: the menu item, the `new-arc` action and handler, the `openingCommand` on the `restore` intent with its test, the census rows, `at0862`, and the two documentation edits. File ▸ New makes containers and an arc is not one.

### The shade before an arc exists

**[B06] The shade stays short until there is an arc, and gains the New Arc button.** The idea and the sketch are things in the transcript until an arc takes them up ([B08]), so four panels before an arc would be three empty seats and a button. The short form keeps its sentence on what an arc is and its help link; the instruction to type `/arc` gives way to the button. This replaces the "brief and no arc" form the arc shade brief described ([B06] of `briefs/arc-shade-brief.md`), which nothing built.

### What the arc takes up

**[B07] When the arc starts, it takes up the idea and the sketch.** The door records both in the arc's own documents beside the brief, as the arc shade brief already decided ([B12] of `briefs/arc-shade-brief.md`): a copy, with a reference to the session and turns it came from.

**[B14] The idea's record is what is wanted, and the sketch's is the shape the work will take.** *Amended 2026-11-21: this first read "the idea's record is the prompt the work began as; the sketch's is a short digest", and the records it produced were a long prompt copied out and a paragraph reciting the brief. The four panels tell one story at growing specificity, and each record is written for the user: the idea in one or two plain sentences, the sketch as one sentence and three to six bullets naming the parts, with no paths, identifiers, labels or mention of the conversation. The shapes are in the arc doctrine. What follows is the original reasoning.* A few sentences on what the conversation settled, with the reference to the session and its turns. The turns themselves are not copied: the brief carries the decisions in full, so the sketch only says how the idea became the brief. *Settled at implement:* each record is a markdown file with a fixed heading (`# Idea`, `# Sketch`), the text, and a last line `Source: session <full uuid>, turn <n>` (or `turns <first>–<last>`), so a stage can tell from the line alone whether the source has moved on, and the panels can show the text without the line. The arc doctrine carries the shape under *The record of where the work came from*, which is also where every stage after the door is told to keep the record current.

**[B15] A door that no longer holds the conversation reads it from disk, and never invents it.** When the session was compacted, or `/arc` runs in a session other than the one that shaped the work, the door reads the source session's transcript with `tugtool session show`, read-only, when it can find one. When it cannot, as with a brief written by hand, nothing is recorded and the panels say so. A record is never made up from the brief alone.

**[B08] The record is kept current.** If the idea or the sketch changes after the arc exists, the arc's record is rewritten. This amends the earlier [B12], which captured once. The record is rewritten by the door and by each later stage when it runs; nothing watches the transcript between stages.

**[B09] The Idea and Sketch panels show that record.** Until an arc has one, and for arcs opened before this lands, they keep saying nothing is recorded. *Settled at implement:* the records ride the arc fact's documents as text, `idea_text` and `sketch_text`, with the heading and the `Source:` line taken off and the text shown as written, line breaks kept. A record past 8000 characters is cut there with an ellipsis, since it rides every snapshot of the feed. A record is not a document, so a directory holding only records is still an arc with no documents.

### The grid

**[B10] Each row is as tall as its taller panel needs.** Down to a floor of a panel's header and one line. The 400 px minimum height on the grid goes; the per-row floor replaces it.

**[B11] The shade is as tall as its rows, up to four fifths of the transcript.** The `short` and `full` forms become one rule: content height, capped at the 80% line. Past the cap a row that needs little keeps what it needs, the other takes the rest, and panels scroll inside themselves as they do now.

**[B12] The larger share is removed.** Two equal columns, rows by content, and nothing moves on a press. A wider column rewraps a panel's text, which would change row heights on every press once rows follow content. With it go `data-focus`, the press and focus handlers that write it, the reveal of the pressed panel, and the resting-panel mapping in `lib/arc-panels.ts`. This reverses that part of the arc shade panels work (`aeda932cc7`, D234), and its assertions in `at0860` are removed with it, said plainly in the commit.

**[B13] The Arc panel shows its whole verb row always.** The lone-lead-verb form existed for the small panel ([F06]); with equal columns there is no small panel. The first verb keeps its word and the rest stay icons.

---

## Open Questions {#open-questions}

Both were measured in the running app by `at0860`, at the Session card's minimum width of 675 px and a height of 680 px, and are answered.

- **Whether the verb row fits a half-width panel at the card's 675 px minimum.** It does, with room to spare: the whole row (Start in words, then Changes, Unbind, Replay and Discard as icons) needs 171 px, and a half-width panel gives 312.5 px. [B13] needs no narrow form.
- **How WebKit sizes content rows under a height cap.** As the grid specification says, once nothing in the grid has a fill-the-host height. Rows of `minmax(floor, auto)` take the max-content height of their taller panel. That needs the panel bodies, the Arc panel's list and its scroller to be `flex: 0 1 auto` rather than `1 1 0`, which is what gave a scroller no natural height. The grid is a shrinking flex item in a shade whose height is `auto` capped at 80%, so when the cap binds the track sizing grows both rows evenly from their floors and stops each at its content. At this card size the cap already binds at rest: the Idea and Sketch row keeps its whole 59 px, and the Brief and Arc row takes the rest, both panels scrolling inside themselves. Held 30 px shorter, the top row still keeps its height and the bottom row gives way. No explicit row ceiling is needed. Inside the Arc panel, flex shrinks each item in proportion to its own size, so a long ledger dragged the list's head down with it, crushing the arc's name and track to a few pixels; the ledger's scroller now carries a shrink factor that dwarfs the head's, so it gives way first, as the `1 1 0` scroller did. It stops at one row: at 900 × 680 the capped Arc panel left the ledger 29 px, less than a step row, so the step under way could not be revealed. Past that row the head gives way instead, since its first line repeats the arc's name the shade's header already carries. And the row holding the Arc panel has a floor of its own, that panel's header, one ledger row and its verb row (115 px read, 120 px set), because the general floor of a header and one line let the verbs fall out of the panel when the cap bound tighter. At 680 px tall the two floors fill the cap almost exactly, so the cap's sharing is read on a card 800 px tall. Below the two rows' floors the grid shrinks no further and the shade's body scrolls. There the Arc panel, held at its floor of a header and one line, clips its verb row; that takes a transcript slot under about 250 px, against the 321 px of a card 680 px tall.

---

## Non-goals {#non-goals}

- **File ▸ New Arc.** Built, tried and rejected; see [B05].
- **A New Arc button in the Arcs sidebar.** An arc is tied to a session and that card is not. The user may revisit this; for now, no.
- **An arc that exists before its name and brief.** See [B02].
- **Idea and Sketch content before an arc exists.** Showing the session's opening prompt and a turn count in a no-arc shade was proposed and refused: they are the transcript's until an arc takes them up.
- **A wider column for the pressed panel.** Considered as the surviving half of the larger share and dropped; see [B12].
- **A new term.** The command is New Arc. No "Flow", no "work unit".
- **Watching the transcript to keep the record current.** See [B08].

---

## Exit {#exit}

**An arc**, in two parts that can land in either order, the first standing alone.

*The hook and the grid (deck and app).* Remove the File ▸ New Arc build of `e598aecc1`. Add the New Arc command for the key Session card, its Session menu item and its dimming; put the button on the short shade and reword the hint. Size the grid's rows by content and the shade by its rows, remove the larger share and what hangs off it, show the whole verb row, and bring `at0860`, `at0861`, D234, the feature guide, the glossary and the recipe for creating an arc into line. The two measurements under Open Questions come first, since they decide the row sizing and the verb row.

*The record (plugin and Rust, then deck).* The door writes the idea and the sketch into the arc's documents when the arc starts, each stage rewrites them when they have changed, `tugtool arc documents` reports them, and the Idea and Sketch panels read them.

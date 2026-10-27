# Tug glossary

The words Tug uses, each with one meaning. Entries are alphabetical. A word in *italics* inside a definition has its own entry.

**Address.** Where a *card* sits on the *deck*, shown as a badge in its *masthead*. The first part is the *slot* number. The second depends on how the slot is arranged: in a *stack* it is a count of the cards in the slot, in a *split* it is a letter, A for the top *band* and B, C for the rest. An address like 2B reads the same in a masthead, a sidebar row or the *Overview*'s narration. The badge is also a control: press it to send the card somewhere else.

**Arc.** A substantial change that leaves your main branch on its own git *worktree* and branch, is driven through *stages* by the *wheel*, and comes back through a *join*. The name is the metaphor: a curve that departs a line and returns to it. An arc is four things in git, a branch named `tugarc/<name>`, a worktree, a little branch config, and an *arc log*, plus a directory of documents under `.tug/arcs/<name>/`. There are two *kinds*, *plain* and *planned*. Wherever an arc is named to a person it wears the caret *sigil*.

**Arc log.** The append-only record of an arc: every *round*, every *step* declaration, every *mark*, every *stop*. Everything a surface says about an arc that git cannot see is read from here. `tugtool arc record <name>` reads it back.

**Arcs (sidebar).** The *sidebar card* that lists every arc in every open project with its lifecycle strip and step progress, and the verbs to run, stop, join, replay or discard it.

**Atom.** The one mark a thing wears everywhere it appears. A file, a commit, a session, an arc or an image is the same atom in a prompt, a transcript, a sidebar row or a receipt. Each kind has one hover tip, one context menu and one copy form, and an atom pastes between Tug windows intact.

**Audit.** The last *stage* of every arc. A fresh session reads the whole diff cold against the *plan* (or *task list*) and the *brief*, fixes what does not match as ordinary *rounds*, verifies the fit against the moving base, writes the *join draft*, and *marks* the arc `audited`. The author never grades its own work.

**Awaiting.** The session state in which the model has asked you something, a question or a permission, and is waiting on your answer. The *pulsing dot* turns yellow.

**Band.** One of the lettered regions of a *split* slot. Bands are stacked top to bottom, A at the top, with a seam to drag between them.

**Base.** The branch an *arc* departed from and will *join* back onto, usually `main`. "The base moved" means new commits landed there while the arc was out.

**Bind / Binding.** The link between a live *session card* and an *arc*. A bound card is the one the *wheel* seats stages on and the one the *join* offer reaches. A session has at most one arc, and an arc is bound to at most one live card. Closing the card unbinds it, and the arc stops as `card closed`.

**Brief.** The first document in the *artifact ladder*: a formal statement of what was found and what was decided, written against the skeleton the plugin ships. It carries findings and decisions, and no execution steps. Every arc opens on a brief. Written by `/tugplug:brief`, or by the *door* from the conversation.

**Bullseye.** A posture that takes the focused *card* to the center of the window at a comfortable reading width and slides every other card off to the side it was on. It writes nothing to the layout: click another card, move keyboard focus, or press ⌃⌘B again and everything returns. See *Fold* for the other way to concentrate.

**Callsign.** A session's generated name, two words like `curly-apple`, unique within one Tug instance. It is a name, not an address: a *session reference* carries it along with the project.

**Canvas.** The single macOS window's working area, on which Tug lays out a *deck* of *cards*. Also the name of the thing the *Layout* card controls.

**Card.** The unit of the *deck*. There are cards for AI sessions, text files, diffs, images, PDFs, commits, settings, keyboard shortcuts and about, and *sidebar cards* for Overview, Arcs, Jots, Workspaces and Layout. Every card has a *masthead* and lives in a *slot* at a width you set.

**Carry.** An option when creating an arc: move the uncommitted work already on the *base* into the new *worktree* and leave the base clean. For the case where you were halfway through a change before deciding it should be an arc.

**Changes (tab, shade).** The panel on each *session card* that sorts the checkout into this session's changes, unattributed changes, orphaned changes and the arcs in flight, with a status mark, a line count, a diff and a checkbox on every file and hunk. Commits happen here. On a card bound to a finished arc it is also where the *join* is offered. ⌃⌘C shows it.

**Chord.** A keyboard shortcut. Tug's chords follow one pattern: ⌘ with a digit moves a card to that slot, ⌃⌘ with the same digit moves you there; `[` is always back and `]` always forward; ⌥⌘ with an arrow focuses the card in that direction. The Keyboard Shortcuts card (⌃⌘K) lists them all.

**Claim.** A session's link to an edit in the *ledger*. Most claims are written for you as the work happens: a file edit claims its file, a shell command that names its files claims those. In the *Changes* tab, Claim brings a file or hunk into this session and *Disclaim* lets it go. See also *hint*.

**Cold.** Read by a session that did not write it. The *review* stage reads the plan cold, the *audit* reads the diff cold. Cold eyes are why the *wheel* rotates sessions between stages.

**Commit card.** A card that opens one commit's full record.

**Compaction.** Reducing a session's context so a long piece of work can continue. You can ask for it with `/compact`; the *wheel* sends one to a stage whose context has crossed the project's threshold, and rotates to a fresh session only if compaction could not bring it back under.

**Composer.** The prompt entry at the bottom of a session card, and the matching entry in the *Overview*. It styles Markdown as you type, accepts dropped and pasted *atoms*, and takes *jots*.

**Context.** The amount of the model's window a session has used. The *status row* reads it out.

**Deck.** The set of cards in one *workspace*, arranged on the *canvas* under *imposition*. The deck holds the arrangement, not you.

**Devise.** The first stage of a *planned arc*: a fresh session writes the *plan* from the *brief*.

**Diff card.** A card that shows the project diff, inline or side by side, whole or scoped to a path, a range or a commit.

**Disclaim.** Let a file or hunk go from this session's *claims*, so it shows as unattributed. ⌃⇧⌘A disclaims everything in the Changes tab; ⌃⌘A claims everything.

**Discard.** End an arc without landing it. The worktree's uncommitted work is returned to the base first, the branch and worktree are removed, and the arc's documents are kept so you can come back to the decisions. `/arc-discard <name>`. A discard can be undone.

**Door.** The one skill that opens the arc lane, `/arc`. It sharpens the conversation into a *brief* (or takes one you hand it), decides the arc's *kind* from the work, says which shape it chose and why, hands the brief to the *wheel*, and ends the turn. The door creates no worktree, commits nothing and joins nothing.

**Dot.** See *pulsing dot*.

**Fit.** One of the two ways *slots* resolve across the window. Fit spreads the slots so every card is inside the window at once; when cards are wider than the window, neighbors overlap and the front one wins. Fit is for monitoring. See *Flow*.

**Flow.** The other way slots resolve. Flow stands the cards side by side at their full widths and lets the row run past the window's edge. Activating a card slides the row just far enough to bring it into view, with a strip along the bottom drawing the whole arrangement. Flow is for reading.

**Fold.** Collapse a card to its *masthead*. It keeps its slot, its address and its live readings and opens again on one press (⌃⌘Y). In a *split* slot, folding makes a *wall*.

**Hint.** What a shell command earns in the *ledger* when it names no files: a note of what git saw change while it ran. A hint never makes a session an owner of a change.

**Idea.** The seed of work: a concept for an investigation, feature, change or fix, typed as a prompt. The bottom rung of the *artifact ladder*, which runs idea, *sketch*, *brief*, *plan*.

**Image card.** A card that shows a picture fit to the card, filling it, or at actual size. A click opens it full screen.

**Implement.** The stage that walks the *plan* or *task list* one *step* per turn, closing each on its *checkpoint* and committing each piece of work as a *round*.

**Imposition.** The scheme under which the *deck* arranges cards. The word comes from printing, where imposition is the arrangement of pages on the press sheet so each lands in place when folded and bound. You choose one to six *slots*; every card lives in one at the width you set; the deck does the arithmetic. You never position a card by hand.

**Join.** The merge of an arc back onto its *base*, done by Tug and asked for by you. It lands the whole arc as one commit, with the *join draft* as its message, a `Tug-Arc:` trailer, and one receipt in the transcript, and cleans up the branch and worktree. The model never joins. A conflicted join runs a resolution ladder and then a resolver in the arc's *workshop*; it asks you only when the two sides want incompatible things. `/arc-join <name>`. A join can be undone.

**Join draft.** The squash message the join will land, written by the *audit* stage with `tugtool draft set`. The only durable prose the base carries about an arc, so it describes the change, never the arc's history.

**Jot.** A saved prompt fragment, something you found yourself typing again, kept in the *Jots* sidebar and ready to drag into any *composer*. ⌘J makes a new one.

**Kind (of arc).** *Plain* or *planned*. The axis between them is settling time, whether the work earns a written, cold-reviewed plan before a step is walked. The *door* decides from the work. A plain arc runs implement then audit from a *task list*; a planned arc runs devise, review, implement, audit from a *plan*.

**Landing.** Any act that changes the tree from the session card without the model: a commit, a push, a *join*, a *discard*. A landing leaves a receipt in the transcript, and the model is told of it on its next turn.

**Layout (card).** The sidebar card that is a to-scale miniature of the deck you can press and hover, with rows for slot count, *Fit* or *Flow*, card width, gap, zoom and sidebar placement. ⌃⌘L shows it.

**Ledger.** Tug's record of which session changed which files, and which hunks within them, so several sessions can share one checkout. It holds *claims* and *hints*. Git status, not the ledger, decides what exists; the ledger says who did it.

**Mark.** A declaration a stage writes into the *arc log* that git cannot see: `built` after a build, `audited` when the audit has run. The audit's mark is its whole product; an arc whose audit ends without one is stopped with `audit did not mark`.

**Masthead.** The strip across the top of every card that names it and carries its controls. A session card's masthead carries the *pulsing dot*, the session's name, its *address* badges, a live activity *sparkline*, and two lines of narration from the *Observer*: what the session is working on and what it is doing right now.

**Observer.** The narrator behind the *Overview*. It digests what each session is doing into sentences as it goes, writes the two narration lines in each masthead, and answers questions about what any session did.

**Orphaned.** Changes that belonged to a session that has since closed. Nothing is lost: the files stay in the tree and any session can *claim* them.

**Overview (sidebar).** The narration channel. One feed reports every session's progress across every project as it happens, each post carrying its session's *atom*, and its *composer* takes questions about what any session did, today or last week.

**PDF card.** A card that reads a document page by page, continuous, single or two-up, at any zoom, with the arrow and page keys turning its pages.

**Plain arc.** See *kind*.

**Plan.** The implementable document of a *planned arc*, written by the *devise* stage from the *brief* and read *cold* by *review*. It carries the *steps*, their *checkpoints*, and the ledger that tracks them. The word means only this document.

**Planned arc.** See *kind*.

**Pulsing dot.** The small circle every session carries. It pulses while the session is working, turns yellow when the session is *awaiting* you, settles green when a turn has finished and the next move is yours, and holds still when the session is idle.

**Rail.** The strip down the left or right edge of the window where *sidebar cards* pin. ⌃⌘← and ⌃⌘→ show a rail or hand it the keyboard; ⌃⌘S hides and shows both.

**Receipt.** The block a transcript keeps for an act with a durable result: a commit, with its hash, message and files; a join; a discard; a file edit. A commit receipt names the session, and the arc if any, that made it.

**Replay.** Moving an arc's commits onto the current tip of its *base* as the base advances. Tug does it automatically whenever the arc's worktree is quiet, no join is in flight, and no bound session is mid-turn. A clean replay interrupts nobody and leaves a line in the arc log; a conflicted one becomes an ordinary turn on the arc's bound session. `tugtool arc replay <name>` runs one by hand. A replay can be undone.

**Review.** The second stage of a *planned arc*: a session that did not write the *plan* reads it against a rubric and the project's own rules, fixes the plan, and stamps it. If a decision is yours it stops the arc and asks in writing.

**Rotation.** The *wheel*'s act of retiring the Claude session seated under a card and seating a fresh one, on a chosen model and opening prompt, while the card, its transcript, its *callsign* and its place on the deck stay put. A rotation happens only at the settled end of a turn. The transcript labels a rotated turn **Wheel** with its own divider.

**Round.** One commit on an arc's worktree plus one line in the *arc log* saying what was asked and what landed. `tugtool arc commit <name>` makes one.

**Seat.** The session a card is currently running. A *stage* is seated under a card by a *rotation*.

**Session.** One Claude Code conversation and everything attached to it: a shell, the plans, the code review and the git commits for that line of work. Shown as a *session card*.

**Session card.** The card that holds one *session* as one scrolling document: the *masthead*, the transcript, the *status row* and the *composer*. Many can run at once, on one project or several.

**Session reference.** A way to hand one session to another: the marker `@session:<project>/<callsign>`, placed by dropping a session *atom* into a prompt. The receiving session can read the referenced transcript with `tugtool session show`, and only read it.

**Settings.** The card for app-wide preferences (⌘,). Card Settings, from a card's menu, hold the per-kind preferences for text, image and PDF cards.

**Sidebar card.** A card that pins to a *rail* instead of living in a slot: *Overview*, *Arcs*, *Jots*, *Workspaces* and *Layout*.

**Sigil.** The caret, `^`, that an arc wears wherever it is named to a person, as in `juicy-roach^arc-steps`. It draws the departure and return the word names.

**Sketch.** The converged shape of the conversation an *idea* starts: what you and the model arrive at by going back and forth. A sketch lives only in the transcript and is never written to a file. An idea can skip this rung.

**Slot.** One of the one to six numbered places on the *deck*. Every card lives in a slot at the width you set. A slot holding more than one card is either a *stack* or a *split*.

**Sparkline.** The small live chart of activity in a session's *masthead*.

**Split.** A slot arrangement in which the slot's height is divided among its cards, each a lettered *band* with a seam to drag between them. ⌃⌘/ toggles a slot between split and *stack*.

**Stack.** The default arrangement of a slot with several cards: they share one place, the front card is the one you see, and a layers badge counts the ones behind it. Click the badge or press ⌘R for a picker. ⌥⌘[ and ⌥⌘] step through the stack.

**Stage.** One rotation of the *wheel* on an arc: *devise*, *review*, *implement* or *audit*, each a fresh session that reads the arc's documents cold. Not to be confused with the arc's derived *state* words.

**State (of an arc).** One of seven words read from git and the arc log on every look: `created`, `working`, `implementing`, `built`, `audited`, `draft-ready` and `joining`. The Arcs sidebar shows them on each arc's lifecycle strip.

**State (of a session).** What the *status row* reads out: Idle, Working, Thinking, Streaming, Awaiting, Compacting, Done, Error or Stopped. The *pulsing dot* draws the same thing.

**Status row.** The strip under a session's transcript that reads out the session's state, elapsed time, *context*, tasks and background jobs.

**Step.** One unit of a *plan* or *task list*, walked by the *implement* stage one per turn and closed on its *checkpoint*. A checkpoint is the set of checks the plan names for the work that step did: the type checker, the tests that touch what moved, a real-app test when only the running program can show the change.

**Stop.** An arc that has halted with a reason the receipt can explain, always with a Resume: `needs a decision`, `stalled`, `implement idle`, `stopped by user`, `card closed`, `card taken` and others. `tugtool arc run <name>` or the Resume button on the stop's receipt picks the work back up.

**Task list.** The step list a *plain arc* carries instead of a *plan*, written by the *door* beside the brief. Shorter, with no decisions and no checkpoints, and walked the same way.

**Text card.** A CodeMirror editor over a file, with autosave or manual save, a find bar and conflict handling.

**Theme.** One of ten colorings, five dark (Ironclad, Caravel, Barque, Galleon, Collier) and five light (Sloop, Ketch, Skiff, Kayak, Pinnace), each a single tint hue laid over a shared tone skeleton. A *workspace* wears its own theme. ⇧⌘T steps to the next.

**Thinking wave.** Three bars that appear beside a session while the model is mid-turn and disappear when the turn ends.

**Tug-Arc trailer.** The line a *join*'s commit carries naming the arc branch and base it landed from.

**tugtool.** The command-line program the model and you use to drive Tug's machinery: arcs, briefs, drafts, file edits with receipts, session reads, test reporting. `tugtool arc`, `tugtool file edit`, `tugtool session show` and so on.

**Turn.** One exchange: a prompt in, the model's work, and the reply. The *wheel* acts only between turns. ⌃⌘[ and ⌃⌘] move through a transcript's turns; ⌃⇧⌘[ and ⌃⇧⌘] go to the first and last.

**Unattributed.** Changes no session has *claimed*: your own hand edits, in your editor or in the card's shell. They stay in plain view and start unchecked at commit time.

**Wall.** What a *split* slot becomes when its cards *fold*. Open any card in the wall and its neighbors fold, so you read one card at a time while the rest stay a glance away.

**Wheel.** The layer that drives every arc through its *stages*. It seats a fresh session for each stage by *rotation*, prompts the implement stage one *step* per turn, compacts or rotates a stage whose context has grown, judges a stage only at a settled idle edge, and stops the arc with a reason when a stage ends without what it owed. A running model cannot drive the wheel.

**Workshop.** The worktree a *join*'s resolver works in when a merge conflicts: the merge as a real tree with the whole project around it.

**Workspace.** A named *deck* with its own arrangement and its own *theme*, one per project or per kind of work. The Window menu cuts between workspaces, and a parked one keeps every card exactly as you left it. The *Workspaces* sidebar maps every workspace and the cards on each; the open eye marks the one you are in.

**Worktree.** Git's second checkout of a repository on another branch. An *arc* takes one so the model's work leaves your main checkout untouched, and the join cleans it up.

**Zoom.** ⌘+ and ⌘− scale the whole app from 50 to 200 percent, layout, type and spacing together; ⌘0 returns to actual size. Transcripts have a magnification of their own.

# Tug: what it does and how to use it

Tug is a macOS IDE for AI-assisted development. It runs Claude Code sessions, many at once, in one window, and keeps track of what each of them is doing, what each of them changed, and how big changes get from an idea to a commit on your main branch. This document describes each part of the app in turn, with the controls and keyboard chords for it. The [glossary](glossary.md) defines the words.

The three verbs of the loop organize what follows. You **prompt** in session cards. You **monitor** through one graphical language and the sidebars. You **review** through attributed edits and arcs.

## Setup

Tug needs a Mac with Apple silicon and macOS 14 Sonoma or later, plus two things it does not ship:

- A paid Claude plan that includes Claude Code (Pro or Max; the free plan does not). First launch installs the `claude` program if needed and logs you in.
- `git`, for changes and commits. If it is missing, setup offers to install Apple's Command Line Tools (about 3 GB). You can skip this at first and add `git` before your first commit.

Open a project with File ▸ Open, or create a new session card with ⌘T and point it at a directory. Tug is beta software: expect rough edges and frequent changes.

## The window: canvas, deck, cards

Tug is a single window. Its working area is the **canvas**, on which Tug lays out a **deck** of **cards**. A card is the unit of everything: an AI session, a text file, a diff, an image, a PDF, a commit, settings, keyboard shortcuts. Every card has a **masthead**, the strip across its top that names it and carries its controls.

You never position a card by hand. The deck arranges cards under a scheme called **imposition**: you choose one to six numbered **slots**, every card lives in a slot at the width you set, and the deck does the arithmetic. Resize the window and every card re-finds its place. Every rearrangement animates, so you see where things went.

### Fit and Flow

Slots resolve across the window in one of two ways, chosen in the Layout card.

- **Fit** spreads the slots so every card is inside the window at once. When cards are wider than the window, neighbors overlap and the front one wins. Fit is for monitoring a deck of sessions.
- **Flow** stands the cards side by side at their full widths and lets the row run past the window's edge. Activating a card slides the row just far enough to bring it into view, and a strip along the bottom draws the whole arrangement to scale. Flow is for reading one transcript.

### Stack and split

A slot can hold more than one card.

- By default the cards in a slot **stack**: they share one place, the front card is the one you see, and a layers badge in its masthead counts the ones behind it. Click the badge or press ⌘R for a picker of what is in the stack. ⌥⌘[ and ⌥⌘] step through it.
- **Split** the slot instead when you want its cards in view at once, for instance a test log above the transcript driving it. The slot's height is divided among its cards, each lettered A, B, C from the top, with a seam to drag between them.

⌃⌘/ toggles a slot between stack and split, so the choice is never a commitment. In a split slot, ⌃⌘↑ and ⌃⌘↓ move a card up or down, and ⌃⇧⌘↑ and ⌃⇧⌘↓ send it to the top or bottom.

### Addresses

Every card shows its **address** in its masthead. The first part is the slot number. The second depends on the slot: in a stack it is the count of cards, in a split it is the card's letter. An address like 2B reads the same wherever you meet it, in a masthead, a sidebar row or the Overview's narration. The address badge is also a control: press it to send the card somewhere else.

### Moving cards

- **By name.** Press the slot badge in a card's masthead and the whole arrangement opens as a picker, a miniature of the deck with every slot drawn. One click sends the card there. From the keyboard, ⌘1 through ⌘9 does the same. ⌥⇧⌘[ and ⌥⇧⌘] nudge a card one slot left or right.
- **By hand.** Drag a card by its masthead. Exactly one drop zone lights at a time, the slot it will land in if you let go, and the zone snaps from slot to slot as the pointer crosses the deck. Escape cancels and the card goes home.
- **Moving yourself.** ⌃⌘1 through ⌃⌘6 go to a slot, bringing it into view under Flow. ⇧⌘[ and ⇧⌘] step to the previous or next card across the deck. ⌥⌘ with an arrow key hands the keyboard to the card to the left, above, right or below.

### Fold and Bullseye

Two ways to concentrate without rebuilding the deck.

- **Fold** (⌃⌘Y) collapses a card to its masthead. It keeps its slot, its address and its live readings, takes almost no room, and opens again on one press. In a split slot, folding makes a **wall**: open any card in the wall and its neighbors fold, so you read one at a time while the rest stay a glance away.
- **Bullseye** (⌃⌘B) takes the focused card to the center of the window at a comfortable reading width and slides every other card off to the side it was on. It is a posture, not a rearrangement: it writes nothing to the layout. Click another card, move keyboard focus, or press the chord again and everything returns.

### Workspaces

A **workspace** is a named deck with its own arrangement and its own theme, one per project or per kind of work. The Window menu cuts between workspaces, and carries New, Rename, Duplicate and Delete. A parked workspace keeps every card exactly as you left it, so coming back to a project is a cut, not a rebuild. The Workspaces sidebar lists every workspace with the cards on each, and you can drop a session on another workspace to move it there.

### Zoom and themes

⌘+ and ⌘− zoom the whole app from 50 to 200 percent, scaling layout, type and spacing together. ⌘0 returns to actual size, and ⌥⌘0 toggles between actual size and your zoom. Transcripts have a magnification of their own, so the words can be larger without the chrome growing with them.

Ten **themes** ship, five dark (Ironclad, Caravel, Barque, Galleon, Collier) and five light (Sloop, Ketch, Skiff, Kayak, Pinnace). Each is a single tint hue laid over a shared tone skeleton, so every theme has the same structure and only the color changes, and all ten stay within a contrast budget that keeps text, links and controls legible. A workspace wears its theme on its own, so the color of the window tells you which project you are in. Choose a theme from the View menu, step to the next with ⇧⌘T, or apply one to every workspace at once.

## Session cards

A **session card** holds one Claude Code session as one scrolling document: the conversation, every shell command, every file edit, the plans, the code review and the git commits for that line of work. Several run at once, on one project or several, each with a card of its own.

### The masthead

The masthead carries, left to right: the session's **pulsing dot**, its name (which you can set with `/rename`), the address badges that say where it sits on the deck, a live activity **sparkline**, and two lines of narration written by the Observer: what the session is working on, and what it is doing right now to get there. Hover the masthead and its verbs unfurl from behind an ellipsis. Right-click the session's atom for its copy menu.

### The transcript

Read it top to bottom. Your prompts, the model's replies, and each shell command and file edit as its own block. A tool block opens and closes on its chevron, shows a blue running dot with a ticking clock while it runs, and settles green with its time or red with its exit status. A diff inside a block renders as a diff, inline or side by side. A test run draws its progress as it goes: a count, a bar, a row per unit, the failures as they land. Every commit lands as a **receipt** with its hash, message and files.

When the model needs an answer or a permission, it asks in the transcript, with its options and Cancel and Submit buttons, and you answer there. The status row reads Awaiting and the dot turns yellow until you do.

⌃⌘[ and ⌃⌘] move between turns; ⌃⇧⌘[ and ⌃⇧⌘] jump to the first and last. ⌘F finds in the transcript, ⌘G and ⇧⌘G step through matches, and ⌘E uses the selection for find.

### The status row

Under the transcript, the status row reads out the session's **state** (Idle, Working, Thinking, Streaming, Awaiting, Compacting, Done, Error or Stopped), its elapsed time, its context window usage, its tasks as a fraction, and its background jobs as they appear, run and finish.

### The prompt entry

The composer is at the bottom, where any messaging app puts it. ⌘K focuses it from anywhere in the card.

- **Markdown styles itself as you type**: headings, bold, code, italics and task lists.
- **Atoms paste intact.** Drop or paste a file, a commit, a session or an arc from anywhere in Tug and the prompt carries the same mark the rest of the app uses. A session atom becomes a session reference the model can read.
- **Insert File…** (⇧⌘I) puts a file's contents or reference into the prompt.
- **Jots.** Drag a saved fragment from the Jots sidebar into the composer.
- **Dictation.** ⌘D starts dictation into the composer; ⇧⌘D stops it and sends.
- **Stop** a running turn from the masthead's verbs, or cancel with ⌘. or Escape.
- **Quote and Unquote** (⌘' and ⇧⌘'), **Paste as Quote** (⌥⌘V) and **Paste as Plain Text** (⌥⇧⌘V) are in the Edit menu, with Make Uppercase and Make Lowercase.

### Slash commands and the command picker

⌘/ opens the command picker. Commands the model understands are typed into the composer with a leading slash. The ones you will use most:

- `/arc <idea or brief path>` opens an arc (see Arcs below). `/arc-run <name>` resumes a stopped one. `/arc-join <name>` and `/arc-discard <name>` land or abandon one.
- `/tugplug:brief` writes the conversation's settled findings and decisions as a brief.
- `/btw <question>` asks a side question without disturbing the work in hand.
- `/compact` reduces the session's context. `/new` starts a fresh session on the same card. `/model` switches the model. `/rename <name>` names the session.

### Model and permission mode

The model menu in the card chooses which Claude model the session runs on. ⌃⌥⌘P cycles the permission mode, which decides how much the model may do without asking. A card on an arc may be running a different model for the current stage; it returns to your own when the stage ends.

### Observer narration and questions

Every session's masthead says what the session is doing. The same narrator, the Observer, posts a digest of each session's progress to the Overview sidebar, and its composer answers questions about what any session did, today or last week.

## Other cards

What a session works with opens beside it, on the same deck, rather than in another app. A file, a diff, a screenshot or a PDF the model mentions opens as a card in a slot next to the session. File ▸ New Text File, Open File…, Open Quickly…, Open Diff and Open Commit open them by hand. ⌘T makes a new card in the active pane. ⌘W closes a card; ⌥⌘W closes every card in its stack.

- **Text card.** A CodeMirror editor with line numbers, a find bar (⌘F), and a status bar. Save with ⌘S, or turn on autosave in Card Settings. Save As… (⇧⌘S), Save a Copy…, Revert to Saved and Reload from Disk are in the File menu. If the file changes on disk while you have unsaved edits, the card says so and lets you choose.
- **Diff card.** The project diff, inline or side by side, whole or scoped to a path, a range or a commit.
- **Image card.** A picture fit to the card, filling it, or at actual size. A click opens it full screen.
- **PDF card.** A document page by page, continuous, single or two-up, at any zoom. The arrow and page keys turn pages.
- **Commit card.** One commit's full record: message, trailers, and files with their diffs.
- **Settings** (⌘,), **Keyboard Shortcuts** (⌃⌘K) and **About** round out the set. Card Settings… in a card's menu holds the per-kind preferences for text, image and PDF cards.

Reveal in Finder is in the File menu for any card backed by a file.

## Sidebar cards

Sidebar cards pin to the **rails** along the window's left and right edges rather than taking a slot. ⌃⌘← and ⌃⌘→ show a rail or hand it the keyboard, ⌃⌘S hides and shows the sidebars, and ⌥⇧⌘S resizes them to fit. Where each sidebar sits is set in the Layout card.

- **Overview.** The narration channel. One feed reports every session's progress across every project as it happens, each post timestamped and carrying its session's atom. Its composer takes questions about what any session did.
- **Arcs.** Every arc in every open project, with its lifecycle strip, the stage in hand lit, and each step's progress, plus the verbs to run, stop, join, replay or discard it. An arc that has stopped reads as a red cell before you read why. File ▸ Reveal Arcs brings it up.
- **Jots.** Prompt fragments you find yourself typing again, filterable, ready to drag into any composer. ⌘J makes a new one.
- **Workspaces.** The map of everything open: every workspace, and under it every card on that workspace's deck, grouped by kind. A session's row shows its name, the line that says what it is for, its latest activity and its state dot, with slot badges for where it sits. The open eye marks the workspace you are in; the others show a closed eye. Click a row to bring its card to the front, filter the list to find a session, drag rows to reorder cards and workspaces, or drop a session on another workspace to move it there.
- **Layout** (⌃⌘L). A to-scale miniature of the deck you can press and hover, with rows for slot count, Fit or Flow, card width, gap, zoom and sidebar placement.

## One graphical language

The state of concurrent work is drawn, not described, and the same marks mean the same thing everywhere.

- **A thing looks the same everywhere.** A file, a commit, a session, an arc or an image is one **atom** wherever it appears: in a prompt, a transcript, a sidebar row or a receipt. Each kind has one hover tip, one context menu and one copy form, and every atom pastes between Tug windows intact. An arc's atom wears the caret sigil, as in `juicy-roach^arc-steps`.
- **Which session needs you, from across the room.** The pulsing dot pulses while a session works, turns yellow when it is waiting on you, settles green when a turn has finished and the next move is yours, and holds still when the session is idle. A three-bar thinking wave appears beside a session mid-turn. Every session has an activity sparkline. An arc's whole life is one strip with the stage in hand lit.
- **Learn a control once.** About a hundred purpose-built components follow one authoring guide and one theme system, so a control learned in one card is known in every card. A consequential action asks first, in a confirm popover right where it was pressed.

## Attributed edits and commits

When several sessions work at once on one checkout, git sees one tangled pile. Tug keeps a **ledger** that records which session made each change, file by file and hunk by hunk, so each session knows what it did when it is time to commit.

### Claims and hints

A session's link to an edit is a **claim**, and most are written for you as the work happens: a file edit claims its file, and a shell command that names its files claims those. A command that names nothing earns only a **hint**, from what git saw change while it ran, and a hint never makes a session an owner. Edits you make yourself, in your editor or in the card's shell, are never claimed by anyone: they show as **unattributed**. Git status, not the ledger, decides what exists.

What this buys: three sessions can run on main at once, each committing its own work as it finishes, without a worktree or branch apiece. You can review one session's changes while the others keep going, land half of what a session did and leave the rest for later, and close a session with work uncommitted without losing it: its files become **orphaned**, and any session can claim them. When two sessions reach into the same lines, Tug marks the file as shared and asks, rather than letting one bury the other.

### The Changes tab

⌃⌘C shows the Changes tab on a session card. It sorts the checkout into this session's changes, unattributed changes, orphaned changes and the arcs in flight, with a status mark, a line count and a diff on every file, and a checkbox on every hunk.

- **Claim** brings a file or a hunk into this session; **Disclaim** lets it go. ⌃⌘A claims everything, ⌃⇧⌘A disclaims everything.
- A commit takes exactly this session's work by default. Anything unattributed or shared starts unchecked, so nothing lands that you did not decide on.
- **Generate a Commit Message** (⌃⌘M) drafts one from the diff and the session's prompts, word by word into the composer: a subject, a paragraph, and bullets. Edit it or send it as is.
- Press Commit. The tab drops and the commit's receipt lands in the transcript with its hash, message and files. The commit itself carries the session that made it, and the arc if any, as trailers.

⌃⌘H shows the commit history. A push and any other landing you make from the card is recorded the same way, and the model is told of it on its next turn.

### Edits with receipts

The model's own file edits go through tools that name the file they write, so each edit lands attributed and leaves a receipt in the transcript. A shell command that writes files by means the ledger cannot read is refused with the attributed form to use instead.

## Arcs

A big change with AI goes wrong in a familiar way: the model works on your checkout for an hour, main moves underneath it, you lose track of what is done, and at the end you are handed one enormous diff. An **arc** is Tug's answer. It takes git's worktree and does the bookkeeping: the work leaves your main branch on its own worktree and branch, is driven through stages by the app, replays onto main as main moves, and comes back through a **join** as one commit. Your own checkout is untouched the whole time, so you can keep working on main, or run several arcs side by side.

### Opening an arc

An arc begins as an idea typed into a session. Talk it over with the model until the shape is settled; that converged shape is a **sketch** and lives only in the conversation. When it is settled, `/tugplug:brief` writes it down as a **brief**, a short record of what was found and what was decided. Then `/arc` is the one door. It takes the brief, or writes one from the conversation, decides whether the work earns a written plan first, says which shape it chose and why, and hands the arc to the app.

There are two **kinds** of arc, and the axis between them is settling time, not size:

- A **plain** arc gets a task list beside its brief and goes straight to implement, then audit. Small, concrete work whose decisions are already made.
- A **planned** arc gets the brief alone, and runs devise, review, implement, audit. Work with enough parts that their order is a problem, or whose decisions are the hard part.

The arc's documents live under `.tug/arcs/<name>/` in your project, never tracked by git.

### The stages

From the door on, the app drives. The **wheel** seats a fresh session for each stage on the card bound to the arc, so the transcript, the name and the card's place on the deck stay put while the model underneath changes. Each rotated turn is labeled **Wheel** in the transcript with a divider naming the stage.

- **Devise** writes the plan from the brief: steps, checkpoints, and a ledger to track them.
- **Review** reads the plan cold, by a session that did not write it, against a rubric and the project's rules, fixes it, and stamps it. A decision that is yours stops the arc and asks in writing.
- **Implement** walks the plan one step per turn, closes each step on its checkpoint (the type checker, the tests that touch what moved, a real-app test when only the running program can show the change), and commits each piece as a **round**. It never commits red.
- **Audit** reads the whole diff cold against the plan and the brief, fixes mismatches as rounds, verifies the fit against the current base, writes the join draft, and marks the arc audited.

Every hand-off is checked by machine. A stage that ends without what it owed stops the arc with a reason, and the Arcs sidebar shows where every arc in every project stands.

### Stops and resumes

An interrupted arc always ends in a state the receipt can name and a gesture that picks it back up. The receipt reads `arc stopped · <name> · in <stage> — <why>`, and carries a Resume button; `tugtool arc run <name>` or `/arc-run <name>` is the same act typed. Among the reasons: `needs a decision` (the stage met a choice that is yours, and wrote its question as the arc's last note), `stopped by user`, `card taken` (you started a new session on the card), `card closed`, `stalled` (a turn that never ended, judged by a half-hour clock), and `implement idle` (the stage was asked twice and closed no step).

You can take the card back at any time: a prompt typed into a stage during implement redirects it, and `/btw` asks a side question without disturbing anything.

### Replay: main keeps moving

As your main branch advances, Tug replays the arc's commits onto it automatically, whenever the arc's worktree is clean, no join is in flight, and no bound session is mid-turn. A clean replay interrupts nobody: it leaves a line in the arc log and a settled mark on the Arcs row. A conflicted replay becomes an ordinary turn on the arc's bound session, which resolves it with the whole tree and the tests in hand. By the time the arc is finished it already fits the main you have now. The Arcs sidebar has a Replay verb to run one by hand, and a replay can be undone.

### The join

A **join** is the merge back to main, done by Tug and asked for by you. The model never joins. Once the audit has marked the arc, the Changes tab on the bound card reveals the arc's row in a quiet moment, showing what the join would land and the message it would carry. Enter the landing mode and press send, or type `/arc-join <name>`.

Tug checks that the base is clean where it meets the arc's files, previews the merge in memory, resolves what its conflict ladder can resolve on its own and hands the rest to a resolver working in the arc's workshop worktree, and asks you only when the two sides want genuinely incompatible things. Then it lands the whole arc as one commit with the join draft as its message and a `Tug-Arc:` trailer, leaves one receipt in the transcript, and removes the branch and the worktree. You never open a terminal to merge, prune or delete anything.

Nothing here is a one-way door. `/arc-discard <name>` ends an arc without landing it, copying its uncommitted work back to you and keeping its documents. A join, a replay or a discard can be undone.

### Arcs from the command line

Everything the Arcs sidebar does has a `tugtool arc` verb: `list`, `status`, `record`, `show`, `run`, `stop`, `replay`, `join`, `discard`, `documents`. A session can read another session's transcript with `tugtool session show <uuid>`, read-only.

## Keyboard shortcuts

The Keyboard Shortcuts card (⌃⌘K) lists everything. The ones that matter most:

| Chord | What it does |
|---|---|
| ⌘T | New card in the active pane |
| ⌘W / ⌥⌘W | Close the card, or every card in its stack |
| ⌘1 … ⌘9 | Move the focused card to slot 1 through 9 |
| ⌃⌘1 … ⌃⌘6 | Go to slot 1 through 6 |
| ⌥⇧⌘[ / ⌥⇧⌘] | Nudge the card one slot left or right |
| ⇧⌘[ / ⇧⌘] | Previous or next card across the deck |
| ⌥⌘[ / ⌥⌘] | Previous or next card in the stack |
| ⌘R | Reveal the stack behind the focused card |
| ⌥⌘← ↑ → ↓ | Focus the card to the left, above, right or below |
| ⌃⌘↑ / ⌃⌘↓ | Move the card up or down within its split slot |
| ⌃⇧⌘↑ / ⌃⇧⌘↓ | Move the card to the top or bottom of its split slot |
| ⌃⌘/ | Split or stack the slot |
| ⌃⌘Y | Fold or unfold the card |
| ⌃⌘B | Bullseye the focused card, or leave Bullseye |
| ⌃⌘← / ⌃⌘→ | Show the left or right rail, or hand it the keyboard |
| ⌃⌘S / ⌥⇧⌘S | Hide or show the sidebars; resize them to fit |
| ⌃⌘L | Show the Layout card |
| ⌘+ / ⌘− / ⌘0 / ⌥⌘0 | Zoom in, zoom out, actual size, toggle actual size |
| ⇧⌘T | Next theme |
| ⌘K | Focus the prompt |
| ⌘/ | Open the command picker |
| ⇧⌘I | Insert a file into the prompt |
| ⌘D / ⇧⌘D | Start dictation; stop dictation and send |
| ⌘. or Escape | Cancel |
| ⌃⌘[ / ⌃⌘] | Previous or next turn |
| ⌃⇧⌘[ / ⌃⇧⌘] | First or last turn |
| ⌘F / ⌘G / ⇧⌘G / ⌘E | Find; find next; find previous; use selection for find |
| ⌃⌘C | Show the session's Changes tab |
| ⌃⌘M | Generate a commit message |
| ⌃⌘A / ⌃⇧⌘A | Claim or disclaim all changes |
| ⌃⌘H | Show the commit history |
| ⌃⌥⌘P | Cycle the permission mode |
| ⌘J | New jot |
| ⌘S / ⇧⌘S | Save; Save As… |
| ⌘, | Settings |
| ⌃⌘K | Keyboard Shortcuts |
| ⌃⌘F | Enter full screen |
| ⌥Tab | Cycle the focus mode |

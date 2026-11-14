# Tug: what it does and how to use it

Tug is a macOS IDE for AI-assisted development. It runs Claude Code sessions, many at once, in one window, and keeps track of what each of them is doing, what each of them changed, and how big changes get from an idea to a commit on your main branch. This document describes each part of the app in turn, with the controls and keyboard chords for it. The [recipes](recipes.md) say how to do one thing at a time, and the [glossary](glossary.md) defines the words.

The three verbs of the loop organize what follows. You **prompt** in session cards. You **monitor** through one graphical language and the sidebars. You **review** through attributed edits and arcs.

## Setup

Tug needs a Mac with Apple silicon and macOS 15 Sequoia or later, including macOS 26 Tahoe and macOS 27 Golden Gate, plus two things it does not ship:

- A paid Claude plan that includes Claude Code (Pro or Max; the free plan does not). First launch installs the `claude` program if needed and logs you in.
- `git`, for changes and commits. If it is missing, setup offers to install Apple's Command Line Tools (about 3 GB). You can skip this at first and add `git` before your first commit.

Press Command-N, or choose File > New Session, for a session card, and pick a project or an earlier session from the list it opens. Tug > Configure Tug runs setup again, and Tug > Log Out or `/logout` logs you out and returns you to it. Tug > Check for Updates fetches a new version; a build that cannot replace itself does not show the item. Tug is beta software: expect rough edges and frequent changes.

## The window: canvas, deck, cards

Tug is a single window. Its working area is the **canvas**, on which Tug lays out a **deck** of **cards**. A card is the unit of everything: an AI session, a text file, a diff, an image, a PDF, a commit, settings, keyboard shortcuts. Every card has a **masthead**, the strip across its top that names it and carries its controls.

You never position a card by hand. The deck arranges cards under a scheme called **imposition**: you choose one to six numbered **slots**, every card lives in a slot at the width you set, and the deck does the arithmetic. Resize the window and every card re-finds its place. Every rearrangement animates, so you see where things went.

### Fit and Flow

Slots resolve across the window in one of two ways, chosen in the Layout card (Control-Command-L). Neither has a chord or a menu item of its own.

- **Fit** spreads the slots so every card is inside the window at once. When cards are wider than the window, neighbors overlap and the front one wins. Fit is for monitoring a deck of sessions.
- **Flow** stands the cards side by side at their full widths and lets the row run past the window's edge. Activating a card slides the row just far enough to bring it into view, and a strip along the bottom draws the whole arrangement to scale. Flow is for reading one transcript.

### Stack and split

A slot can hold more than one card.

- By default the cards in a slot **stack**: they share one place, the front card is the one you see, and a layers badge in its masthead counts the ones behind it. Click the badge or press Command-R for a picker of what is in the stack. Option-Command-Left Bracket and Option-Command-Right Bracket step through it.
- **Split** the slot instead when you want its cards in view at once, for instance a test log above the transcript driving it. The slot's height is divided among its cards, each lettered A, B, C from the top, with a seam to drag between them.

Control-Command-Slash, or View > Split or Stack Slot, toggles a slot between stack and split, so the choice is never a commitment. In a split slot, Control-Command-Up Arrow and Control-Command-Down Arrow move a card up or down, and Control-Shift-Command-Up Arrow and Control-Shift-Command-Down Arrow send it to the top or bottom. Control-Command-E, or View > Equalize Heights, evens out one slot, and Option-Shift-Command-E, or View > Equalize All Heights, every slot.

### Addresses

Every card shows its **address** in its masthead. The first part is the slot number. The second depends on the slot: in a stack it is the count of cards, in a split it is the card's letter. An address like 2B reads the same wherever you meet it, in a masthead, a sidebar row or the Overview's narration. The address badge is also a control: click it to send the card somewhere else.

### Moving cards

- **By name.** Press the slot badge in a card's masthead and the whole arrangement opens as a picker, a miniature of the deck with every slot drawn. One click sends the card there. From the keyboard, Command-1 through Command-6 does the same. Option-Shift-Command-Left Bracket and Option-Shift-Command-Right Bracket nudge a card one slot left or right.
- **By hand.** Drag a card by its masthead. Exactly one drop zone lights at a time, the slot it will land in if you let go, and the zone snaps from slot to slot as the pointer crosses the deck. Escape cancels and the card goes home.
- **Moving yourself.** Control-Command-1 through Control-Command-6 go to a slot, bringing it into view under Flow. Shift-Command-Left Bracket and Shift-Command-Right Bracket step to the previous or next card across the deck. Option-Command with an arrow key hands the keyboard to the card to the left, above, right or below. The Go menu carries the same moves, with Reveal Stack and a Go to Slot row for each slot.

### Fold and Bullseye

Two ways to concentrate without rebuilding the deck.

- **Fold** (Control-Command-Y) collapses a card to its masthead. It keeps its slot, its address and its live readings, takes almost no room, and opens again on one press. View > Fold Card is the same act. In a split slot, folding makes a **wall**: open any card in the wall and its neighbors fold, so you read one at a time while the rest stay a glance away.
- **Bullseye** (Control-Command-B, or View > Bullseye) takes the focused card to the center of the window at a comfortable reading width and slides every other card off to the side it was on. It is a posture, not a rearrangement: it writes nothing to the layout. Click another card, move keyboard focus, or press the chord again and everything returns.

### Workspaces

A **workspace** is a named deck with its own arrangement and its own theme, one per project or per kind of work. The Window menu cuts between workspaces, and carries New Workspace, Rename Workspace, Duplicate Workspace and Delete Workspace; none has a chord. A parked workspace keeps every card exactly as you left it, so coming back to a project is a cut, not a rebuild. The Workspaces sidebar lists every workspace with the cards on each, and you can drop a session on another workspace to move it there.

### Zoom and themes

Shift-Command-Plus Sign (Command-Equal Sign works too) and Command-Minus Sign zoom the whole app from 50 to 200 percent, scaling layout, type and spacing together. The View menu has all of these. Command-0 returns to actual size, and Option-Command-0 toggles between actual size and your zoom. Transcripts have a magnification of their own, under Transcript on the Sessions tab of Settings, so the words can be larger without the chrome growing with them.

Ten **themes** ship, five dark (Ironclad, Caravel, Barque, Galleon, Collier) and five light (Sloop, Ketch, Skiff, Kayak, Pinnace). Each is a single tint hue laid over a shared tone skeleton, so every theme has the same structure and only the color changes, and all ten stay within a contrast budget that keeps text, links and controls legible. A workspace wears its theme on its own, so the color of the window tells you which project you are in. Choose a theme from View > Theme, step to the next with Shift-Command-T, or give every workspace this one with View > Apply To All Workspaces, which is lit only while some workspace wears a different theme.

## Session cards

A **session card** holds one Claude Code session as one scrolling document: the conversation, every shell command, every file edit, the plans, the code review and the git commits for that line of work. Several run at once, on one project or several, each with a card of its own.

### The masthead

The masthead carries, left to right: the session's **pulsing dot**, its name (which you can set with `/rename`), the address badges that say where it sits on the deck, a live activity **sparkline**, and two lines of narration written by the Observer: what the session is working on, and what it is doing right now to get there. Hover the masthead and its verbs unfurl from behind an ellipsis. Right-click the session's atom for its copy menu: Copy as Atom, Copy as Citation, Copy Session ID, Copy Description and, while it runs, Copy Activity Line. A summary button shows the session's summary, and another reveals the project folder in Finder.

### The transcript

Read it top to bottom. Your prompts, the model's replies, and each shell command and file edit as its own block. A tool block opens and closes on its chevron, shows a blue running dot with a ticking clock while it runs, and settles green with its time or red with its exit status. A diff inside a block renders as a diff, inline or side by side. A test run draws its progress as it goes: a count, a bar, a row per unit, the failures as they land. Every commit lands as a **receipt** with its hash, message and files.

When the model needs an answer or a permission, it asks in the transcript, with its options and Cancel and Submit buttons, and you answer there. The status row reads Awaiting and the dot turns yellow until you do.

Control-Command-Left Bracket and Control-Command-Right Bracket move between turns; Control-Shift-Command-Left Bracket and Control-Shift-Command-Right Bracket jump to the first and last. The Go menu has all four. `/copy` or Edit > Copy Last Response copies the model's latest message, and `/export` or File > Export Session saves the whole transcript as Markdown or JSON Lines.

**Find.** Command-F opens a find bar under the transcript. Matches highlight as you type, the bar counts them ("3 of 12"), and the current one is brought into view. Command-G and Shift-Command-G step to the next and previous match, Return and Shift-Return do the same from the field, and Escape closes the bar. Command-E searches for whatever you have selected. Case, Word and Grep narrow the search, and they are one setting across the deck. The same bar finds in a Text card's file and in a help card, so every help document can be searched too.

### The status row

Under the transcript, the status row reads out five things, and each opens a panel of detail when pressed: the session's **state**, its elapsed **time**, its **context** window usage, the **arc** it is driving, or `None`, and its background **jobs** as they appear, run and finish. `/context` and `/bashes` open the context and jobs panels from the composer. A `/btw` side question's answers open from under this row too.

The state reads one of: **Idle** or **Ready**, with no turn in flight; **Sending** and **Waiting**, on the way to the model; **Streaming** while it writes; **Working** while it runs tools; **Running** when a turn has ended and background work carries on; **Awaiting** when it needs your answer; **Interrupting** while a stop is on its way, and **Unanswered** if it goes unheeded; **Restoring** while an earlier session is read back; **Reconnecting** and **Disconnected** for the link to the session; and **Error**.

### The prompt entry

The composer is at the bottom, where any messaging app puts it. Command-K, or Session > Focus Prompt, focuses it from anywhere in the card. It always talks to the model; a shell command, a side question or a search each has a slash command of its own, and there is no mode to switch into first.

- **Sending.** Shift-Return or the send button sends, Return starts a new line, and a numeric keypad's Enter sends. Settings > Sessions > Prompt Editor swaps Return and Shift-Return, and keeps the keypad's Enter apart. While a turn runs the same key, or the **+** button beside Stop, queues the prompt, and the model picks it up at its next pause.
- **Earlier prompts.** Option-Up Arrow and Option-Down Arrow walk your prompts wherever the caret is; Command-Up Arrow does so with the caret at the very start and Command-Down Arrow at the very end.
- **Markdown styles itself as you type**: headings, bold, code, italics and task lists.
- **Atoms paste intact.** Drop or paste a file, a commit, a session or an arc from anywhere in Tug and the prompt carries the same mark the rest of the app uses. A session atom becomes a session reference the model can read.
- **Files.** Type `@` and part of a name to pick a file. **Insert File** (Shift-Command-I, or the Session menu) picks one from a panel, and a dragged file lands the same way. `@` completes files only.
- **Jots.** Drag a saved fragment from the Jots sidebar into the composer.
- **Dictation.** Command-D or the microphone starts dictation into the composer, and Command-D again stops it; Shift-Command-D stops it and sends. Session > Start Dictation and Stop Dictation and Send are the same two acts. A microphone that cannot start says why on its hover.
- **Stop.** The send button becomes a red Stop while a turn runs. It, Command-Period and Escape each take back the newest queued prompt first and stop the turn once the queue is empty, and an open sheet takes the Escape before any of that. Session > Stop stops the turn. A taken-back prompt returns to the composer if the composer is empty.
- **Routes.** Control-Command-P is the prompt route and Control-Command-C the Changes route, which the tabs on the card also choose. In the Changes route the composer is the commit message editor.
- **Paste as Quote** (Option-Command-V), **Paste as Plain Text** (Option-Shift-Command-V) and **Copy as Plain Text** (Option-Shift-Command-C) are in the Edit menu. **Make Uppercase** (Option-Command-U), **Make Lowercase** (Option-Command-L), **Increase Quote Level** (Command-Apostrophe) and **Decrease Quote Level** (Shift-Command-Apostrophe) are in the Text menu.

### Slash commands and the command picker

Command-Slash, or Session > Open Command Picker, opens the command picker; typing `/` at the start of an empty composer does the same, and anywhere else `/` is an ordinary character. `/help` opens a sheet of the commands, and `/skills` and `/agents` list what your project adds. A command the app and the session do not know brings up an **Unknown Command** alert rather than spending a turn. By kind:

- **Arcs.** `/arc <idea or brief path>` opens one (see Arcs below). `/arc-bind <name>` binds this card to one, and `/arc-join <name>` lands one. `/arc-review` reviews a plan.
- **Documents and charts.** `/tugplug:brief` writes the conversation's settled findings and decisions as a brief. `/tugplug:viz` draws a chart, and `/data-visualization` (Control-Command-V) shows every chart recipe.
- **Asking and looking aside.** `/btw <question>` asks a side question without disturbing the work in hand. `/shell <command>` runs one shell command. `/match <name>` and `/search <text>` find files and lines as numbered rows, and `/ref 3` opens rows by number.
- **The conversation.** `/compact` reduces the session's context, and `/rewind` cuts back to an earlier message. `/clear`, `/new` or `/reset` starts a fresh session on the same card, and `/resume` or `/continue` brings an earlier one back. `/rename <name>` or `/name` names the session and `/unname` clears it. `/private` keeps it out of the Overview. `/copy` and `/export` copy and save it.
- **Its settings.** `/ai` (Control-Command-I) opens the AI settings, with `/model`, `/effort` and `/mode` at their own rows. `/permissions` or `/allowed-tools` edits the tool rules. `/cd <path>` or `/change-directory` moves the card to another directory, and `/add-dir <path>` or Session > Add Project Directory lets the session read and write another one as well, listed in the Session Summary. `/memory` and `/hooks` open what those name.
- **Its readings.** `/context`, `/bashes`, `/usage` (Control-Command-U) and `/diff`.
- **Landing.** `/commit` opens the commit editor and `/push` pushes the branch.

### Model and permission mode

The **AI Model Settings** chip, Control-Command-I, `/ai` or Session > AI Settings open one sheet that holds the model, the effort and the permission mode, and it refuses while a turn is running. Control-Option-Command-P or Session > Cycle Permission Mode cycles the permission mode, which decides how much the model may do without asking: Default asks before it edits or runs anything consequential, Accept Edits lets file edits through, Plan has it plan without changing anything, and Auto lets it decide which actions are safe on its own. Bypass, which asks for nothing, is never in the cycle; choose it in the AI settings sheet if you mean it. Shift-Tab moves the keyboard between the card's controls and does not touch the mode. Rules for single tools are apart, in `/permissions` or Session > Permission Rules. A card on an arc may be running a different model for the current stage; it returns to your own when the stage ends.

### Narration and questions

Every session's masthead says what the session is doing. The narrator, the **Observer**, writes those lines and posts a digest of each session's progress to the Overview sidebar. It only narrates. Questions go to the **Operator**, in the Overview's composer: ask it how Tug works or what any session did, today or last week. It answers from what Tug has recorded and from this guide, the recipes and the glossary, and links each answer to what it rests on.

## Other cards

What a session works with opens beside it, on the same deck, rather than in another app. A file, a diff, a screenshot or a PDF the model mentions opens as a card in a slot next to the session. File > New Text File (Option-Command-N), Open File (Command-O), Open Quickly (Shift-Command-O) and Open Recent open files by hand, `/diff` or Session > Show Project Diff opens the project diff, and a commit atom opens its commit on a click. Command-T makes a new card in the active pane. Command-W or File > Close closes a card; Option-Command-W or File > Close All Tabs closes every card in its stack.

- **Text card.** A CodeMirror editor with line numbers, a find bar (Command-F), and a status bar. Save with Command-S, or turn on autosave in Card Settings. Save As (Shift-Command-S), Save a Copy, Revert to Saved and Reload from Disk are in the File menu. Settings > Text Files holds the defaults. If the file changes on disk while you have unsaved edits, the card says so and lets you choose.
- **Diff card.** The project diff, inline or side by side, whole or scoped to a path, a range or a commit.
- **Image card.** A picture at Fit, Fill or Actual Size, over a Checkerboard, Surface, Black or White background. A click opens it full screen. Read-only.
- **PDF card.** A document as Continuous, Single Page or Two Pages, at Fit Width, Fit Page or Actual Size. The arrow and page keys turn pages. Read-only.
- **Commit card.** One commit's full record: message, trailers, and files with their diffs.
- **Settings** (Command-Comma), **Keyboard Shortcuts** (Control-Command-K), **About** and the four **help** cards (this guide, the recipes, the glossary and the release notes, from the Help menu) round out the set. Settings has four tabs: General, Sessions, Text Files and Viewer Cards. Keyboard Shortcuts shows every command, its chord and any chord that shadows it, and rebinds the ones that are yours to change. Card Settings in a card's menu holds the same preferences for that one text, image or PDF card.

Reveal in Finder is in the card's menu for any card backed by a file.

## Sidebar cards

Sidebar cards pin to the **rails** along the window's left and right edges rather than taking a slot. Control-Command-Left Arrow and Control-Command-Right Arrow show a rail or hand it the keyboard, Control-Command-S hides and shows the sidebars, and Option-Shift-Command-S resizes them to fit. Control-Command-O, Control-Command-R, Control-Command-J, Control-Command-W and Control-Command-L show the Overview, Arcs, Jots, Workspaces and Layout one by one, and the View menu has a row for each. Where each sidebar sits is set in the Layout card.

- **Overview.** The narration channel. One feed reports every session's progress across every project as it happens, each post timestamped and carrying its session's atom. Its composer asks the Operator, which answers questions about how Tug works and about what any session did.
- **Arcs.** Every arc in every open project, with its lifecycle strip, the stage in hand lit, and each step's progress, plus its verbs in one order: its next step (**Start**, **Stop**, **Resume** or **Join**), **Changes**, **Bind** or **Unbind**, **Replay** and **Discard**. A refused verb stays and says why on its hover. An arc that has stopped reads as a red cell before you read why.
- **Jots.** Prompt fragments you find yourself typing again, filterable, ready to drag into any composer. Command-J or File > New Jot makes a new one, and so does the **+**. Arrows walk the rows and Return opens one to edit, and each row has a **Copy** and a **✕**.
- **Workspaces.** The map of everything open: every workspace, and under it every card on that workspace's deck, grouped by kind. A session's row shows its name, the line that says what it is for, its latest activity and its state dot, with slot badges for where it sits. The open eye marks the workspace you are in; the others show a closed eye. Click a row to bring its card to the front, filter the list to find a session, drag rows to reorder cards and workspaces, or drop a session on another workspace to move it there.
- **Layout** (Control-Command-L). A to-scale miniature of the deck you can press and hover, with rows for slot count (One Up to Six Up), Fit or Flow, card width (Slim, Comfy or Wide), gap (Snug, Cozy or Roomy), zoom and sidebar placement.

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

Control-Command-C shows the Changes tab on a session card. It sorts the checkout into this session's changes, unattributed changes, orphaned changes and the arcs in flight, with a status mark, a line count and a diff on every file, and a checkbox on every hunk.

- **Claim** brings a file or a hunk into this session; **Disclaim** lets it go. **Claim all** and **Disclaim all** take a section; Control-Command-A claims everything, Control-Shift-Command-A disclaims everything. The chords are live only while the tab is up.
- A commit takes exactly this session's work by default. Anything unattributed or shared starts unchecked, so nothing lands that you did not decide on.
- **Generate a Commit Message** (Control-Command-M) drafts one from the diff and the session's prompts, word by word into the composer: a subject, a paragraph, and bullets. Edit it or send it as is.
- Press Commit. The tab drops and the commit's receipt lands in the transcript with its hash, message and files. The commit itself carries the session that made it, and the arc if any, as trailers.

**Push** in the header, showing only while the branch is ahead of its upstream, is the same act as `/push`, and a button opens the whole diff in a card. Control-Command-C, `/commit` or Session > Commit Changes enters the commit editor, setting aside a prompt you had typed; Control-Command-P or Escape leaves it and brings the prompt back. A commit is never made by a chord alone.

Control-Command-H or Session > Show Commit History shows the commit history, with a **Filter commit history** field whose **Hash**, **Message**, **Detail** and **Files** toggles say where it looks, **Author**, **Date** and **Time** to choose what a row shows, and **Done** to close it. A push and any other landing you make from the card is recorded the same way, and the model is told of it on its next turn.

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

An interrupted arc always ends in a state the receipt can name and a gesture that picks it back up. The receipt reads `arc stopped · <name> · in <stage> — <why>`, and carries a Resume button; `tugtool arc run <name>` is the same act from a shell. Among the reasons: `needs a decision` (the stage met a choice that is yours, and wrote its question as the arc's last note), `stopped by user`, `card taken` (you started a new session on the card), `card closed`, `stalled` (a turn that never ended, judged by a half-hour clock), and `implement idle` (the stage was asked twice and closed no step).

You can take the card back at any time: a prompt typed into a stage during implement redirects it, and `/btw` asks a side question without disturbing anything.

### Replay: main keeps moving

As your main branch advances, Tug replays the arc's commits onto it automatically, whenever the arc's worktree is clean, no join is in flight, and no bound session is mid-turn. A clean replay interrupts nobody: it leaves a line in the arc log and a settled mark on the Arcs row. A conflict on an arc still being walked is a mark on its row and nothing more: the arc's audit replays it onto the live base and resolves what conflicts there as ordinary rounds, with the worktree and the tests in hand. So the arc that reaches you already fits the main you have now. The Arcs sidebar has a Replay verb to run one by hand, `tugtool arc replay <name>` is the same act, and a replay can be undone.

### The join

A **join** is the merge back to main, done by Tug and asked for by you. The model never joins. Once the audit has marked the arc, the Changes tab on the bound card reveals the arc's row in a quiet moment, showing what the join would land and the message it would carry. Enter the landing mode and press send, or type `/arc-join <name>`.

The join resolves nothing, because there is nothing left to resolve: an arc reads ready only while its audit stands on the live base, so its fit was verified against exactly the tree the join lands. If the base moves under it, or a round lands after the audit, the arc goes back to its audit on the Wheel, which fits it to the new base in the transcript, and the join offer comes back when the audit marks again. Tug checks that the base is clean where it meets the arc's files, then lands the whole arc as one commit with the join draft as its message and a `Tug-Arc:` trailer, leaves one receipt in the transcript, and removes the branch and the worktree. You never open a terminal to merge, prune or delete anything.

Nothing here is a one-way door. **Discard** on the arc's row in the Arcs sidebar, or `tugtool arc discard <name>`, ends an arc without landing it, copying its uncommitted work back to you and keeping its documents. `tugtool arc undo` reverses a join, a replay or a discard.

### Arcs from the command line

Everything the Arcs sidebar does has a `tugtool arc` verb: `list`, `status`, `record`, `show`, `run`, `stop`, `replay`, `join`, `discard`, `undo`, `redo`, `documents`. A session can read another session's transcript with `tugtool session show <uuid>`, read-only.

## Keyboard shortcuts

The Keyboard Shortcuts card (Control-Command-K) lists everything. A shortcut is written as its keys joined by hyphens: Control-Command-K means hold down the Control and Command keys and press K. The ones that matter most:

| Chord | What it does |
|---|---|
| Command-N / Option-Command-N | New session card; new text file |
| Command-O / Shift-Command-O | Open File; Open Quickly |
| Command-T | New card in the active pane |
| Command-W / Option-Command-W | Close the card, or every card in its stack |
| Command-1 through Command-6 | Move the focused card to slot 1 through 6 |
| Control-Command-1 through Control-Command-6 | Go to slot 1 through 6 |
| Option-Shift-Command-Left Bracket / Option-Shift-Command-Right Bracket | Nudge the card one slot left or right |
| Shift-Command-Left Bracket / Shift-Command-Right Bracket | Previous or next card across the deck |
| Option-Command-Left Bracket / Option-Command-Right Bracket | Previous or next card in the stack |
| Command-R | Reveal the stack behind the focused card |
| Option-Command with an arrow key | Focus the card to the left, above, right or below |
| Control-Command-Up Arrow / Control-Command-Down Arrow | Move the card up or down within its split slot |
| Control-Shift-Command-Up Arrow / Control-Shift-Command-Down Arrow | Move the card to the top or bottom of its split slot |
| Control-Command-Slash | Split or stack the slot |
| Control-Command-E / Option-Shift-Command-E | Equalize one slot's heights; every slot's |
| Control-Command-Y | Fold or unfold the card |
| Control-Command-B | Bullseye the focused card, or leave Bullseye |
| Control-Command-Left Arrow / Control-Command-Right Arrow | Show the left or right rail, or hand it the keyboard |
| Control-Command-S / Option-Shift-Command-S | Hide or show the sidebars; resize them to fit |
| Control-Command-O / Control-Command-R / Control-Command-J / Control-Command-W / Control-Command-L | Show the Overview, Arcs, Jots, Workspaces or Layout |
| Shift-Command-Plus Sign or Command-Equal Sign / Command-Minus Sign / Command-0 / Option-Command-0 | Zoom in, zoom out, actual size, toggle actual size |
| Shift-Command-T | Next theme |
| Command-K | Focus the prompt |
| Command-Slash | Open the command picker |
| Shift-Command-I | Insert a file into the prompt |
| Command-D / Shift-Command-D | Start dictation; stop dictation and send |
| Command-Period or Escape | Cancel; take back a queued prompt, then stop the turn |
| Option-Up Arrow / Option-Down Arrow | Earlier or later prompt |
| Command-Apostrophe / Shift-Command-Apostrophe | Increase Quote Level; Decrease Quote Level |
| Option-Command-V / Option-Shift-Command-V / Option-Shift-Command-C | Paste as Quote; Paste as Plain Text; Copy as Plain Text |
| Option-Command-U / Option-Command-L | Make Uppercase; Make Lowercase |
| Control-Command-Left Bracket / Control-Command-Right Bracket | Previous or next turn |
| Control-Shift-Command-Left Bracket / Control-Shift-Command-Right Bracket | First or last turn |
| Command-F / Command-G / Shift-Command-G / Command-E | Find; find next; find previous; use selection for find |
| Control-Command-P / Control-Command-C | The prompt route; the session's Changes tab |
| Control-Command-M | Generate a commit message |
| Control-Command-A / Control-Shift-Command-A | Claim or disclaim all changes |
| Control-Command-H | Show the commit history |
| Control-Option-Command-P | Cycle the permission mode |
| Control-Command-I | AI settings |
| Control-Command-U / Control-Command-V | Usage; Data Visualization |
| Command-J | New jot |
| Command-S / Shift-Command-S | Save; Save As |
| Command-Comma | Settings |
| Control-Command-K | Keyboard Shortcuts |
| Control-Command-F | Enter full screen |
| Command-M | Minimize |
| Command-H / Option-Command-H | Hide Tug; Hide Others |
| Command-Q | Quit |
| Option-Tab | Cycle the focus mode |

## Getting help

- **Help > Tug Help** opens this guide as a card, **Help > Getting Started** opens a short first walk through the loop, **Help > How Do I** opens the recipes, one per thing a person does, **Help > Glossary** opens the glossary, and **Help > Release Notes** opens what changed in every version, newest first. A link from one opens another's card.
- **Ask the Overview.** The Overview's composer asks the Operator, which answers questions about how the app works from these documents, as well as questions about your projects, and links to the passage it answered from.
- **Help > Keyboard Shortcuts & Commands** opens the `/help` sheet in the session card, listing its slash commands.
- **Control-Command-K** opens the Keyboard Shortcuts card, which lists every chord.

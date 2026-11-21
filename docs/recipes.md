# How do I…

One recipe per thing you can do in Tug, headed the way you would say it. Each gives the gesture first, whether a slash command, a chord, a menu item or a control, then what you will see, then what you won't, to try and cover your expectations and avoid confusion (as much as possible). For what a word means, see the [glossary](glossary.md); see the [feature guide](features.md) to another take on what Tug does and how.

## Arcs

### Create an arc
<!-- source: tugplug/skills/arc/SKILL.md (forms of /arc); tugdeck/src/lib/slash-commands.ts (/arc is not local; /arc-bind); tugdeck/src/lib/arc-verbs.ts (Start); tugdeck/src/components/tugways/cards/session-arc-shade-hint.tsx (New Arc); tugapp/Sources/MenuBarBuilder.swift (session.newArc) -->

Type `/arc` in a Session card, followed by whatever you have:

- `/arc make the ring pulse` opens on an idea in prose.
- `/arc ring-pulse` opens on a name, and `/arc ring-pulse make it pulse` on a name and an instruction.
- `/arc briefs/ring-pulse-brief.md` hands in a brief you already wrote.

The model settles what is still open, decides whether the work earns a written plan, says which shape it chose and why, and hands the arc to the app. You will see the arc's name on the card and a **Wheel** divider in the transcript as its first stage starts, and the arc takes its own branch and worktree, so your checkout is untouched.

**New Arc** does the same as typing a bare `/arc`, in the session you are in. It is a button in the arc shade of a session with no arc, and Session > New Arc. Talk the change over first, then press it: the door takes up what the conversation has settled. New Arc is dimmed while a turn is running, and Session > New Arc is also dimmed when the session already has an arc or the card has no session yet. It opens no new card, and the arc gets its name and brief from the door's turn rather than at the press. It has no chord, and the Arcs sidebar has no New Arc. A row in the Arcs sidebar for documents that are already waiting offers **Start**, which runs those documents and opens nothing new. `/arc-bind <name>` with a new name does make an arc, but a bare one: a branch and a worktree, with no brief and nothing driving it. It is not how work is started.

### Write a brief
<!-- source: tugplug/skills/brief/SKILL.md -->

Type `/tugplug:brief` once the conversation has settled the shape, or say "write a brief". The model writes what was found and what was decided as a document and commits that one file. It opens no arc: `/arc` is what takes a brief further, and `/arc` will write the brief itself if you have not. There is no button or chord for it.

### See where my arcs stand
<!-- source: tugdeck/src/components/tugways/command-registry.ts (SIDEBAR_MENU_CARDS, Arcs Control-Command-R); tugdeck/src/components/arcs/arcs-card.tsx; tugrust/crates/tugtool/src/arc.rs -->

Press Control-Command-R to show the Arcs sidebar. It lists every arc in every open project, nearest to done first, each with its stage and a row of verbs: its next step, then **Changes**, **Bind** or **Unbind**, **Replay** and **Discard**. Waiting plan documents follow beneath the arcs. **Changes** fronts the card working the arc and shows its Changes tab, and a right-click on a row offers the same housekeeping verbs. From a shell, `tugtool arc list` and `tugtool arc status <name>` read the same facts.

### Stop an arc
<!-- source: tugdeck/src/lib/arc-verbs.ts (Stop); tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-lane.tsx; tugrust/crates/tugtool/src/arc.rs (run_arc_stop); tugdeck/src/lib/slash-commands.ts -->

While an arc is running, the first verb on its row in the Arcs sidebar and in the Changes tab is **Stop**. Click it, or run `tugtool arc stop <name>` from a shell. The arc stops at once with a receipt reading `arc stopped · <name> · in <stage> — stopped by user`, and it keeps its branch and worktree, so nothing is lost.

There is no `/arc-stop` slash command and no chord for it. Starting a new session on the arc's card, or closing the card, also stops the arc, and the receipt says which happened.

### Resume a stopped arc
<!-- source: tugdeck/src/components/tugways/cards/session-arc-receipt-block.tsx (Resume this arc); tugdeck/src/lib/arc-verbs.ts (Resume); tugplug/skills/arc/SKILL.md (continuation); tugrust/crates/tugtool/src/arc.rs -->

Click **Resume** on the stop receipt in the transcript, or on the arc's row in the Arcs sidebar. `tugtool arc run <name>` is the same act from a shell. The arc picks up at the stage it stopped in, on its bound card, with a **Wheel** divider. If it stopped as `needs a decision`, its question is the last note on the receipt: answer it in the conversation, then resume.

`/arc <name>` on an existing arc reads where it stands and offers to continue. There is no `/arc-run` slash command: that is only the label a receipt row carries, and typing it brings up an **Unknown Command** alert.

### Discard an arc
<!-- source: tugdeck/src/lib/arc-verbs.ts (Discard and its confirm sentences); tugdeck/src/components/arcs/arcs-card.tsx; tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-lane.tsx (canDiscardFromHere); tugrust/crates/tugtool/src/arc.rs; tugplug/skills/arc/SKILL.md -->

Click **Discard** on the arc's row in the Arcs sidebar, or in the Changes tab of the card that holds it, and confirm "Discard this arc?". From a shell, `tugtool arc discard <name>`. The branch and worktree go, the arc's uncommitted work comes back to your checkout, and its documents stay. An arc that is only documents says "Delete this arc's documents?" instead, and that delete is the whole of it.

There is no `/arc-discard` slash command: that is only the label a receipt row carries. The Changes tab withholds Discard on an arc another live session holds, so go through the Arcs sidebar for that one.

### Undo a join, a replay or a discard
<!-- source: tugrust/crates/tugtool/src/arc.rs (run_undo, redo); tugdeck/src/lib/arc-verbs.ts (no undo verb) -->

Run `tugtool arc undo <name>` from a shell, or `tugtool arc undo` for the newest operation on any arc, and `tugtool arc undo --list` to see what could be undone. It reverses the most recent join, replay or discard, and refuses by name if the world has moved since. `tugtool arc redo` puts it back.

The Arcs sidebar has no Undo verb, and there is no slash command or chord for it.

### Replay an arc onto main
<!-- source: tugdeck/src/lib/arc-verbs.ts (Replay); tugdeck/src/components/arcs/arcs-card.tsx (Replay onto <base>); tugrust/crates/tugtool/src/arc.rs -->

Usually you do nothing: an arc replays by itself as its base moves. To do it by hand, click **Replay** on the arc's row, or run `tugtool arc replay <name>`. A clean replay leaves a line in the arc's log and interrupts nobody. There is no slash command or chord for it.

### Join an arc
<!-- source: tugdeck/src/lib/slash-commands.ts (/arc-join); tugdeck/src/components/tugways/cards/session-card.tsx (arc-join surface); tugdeck/src/lib/arc-verbs.ts (Join, joinRefusal); tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-join.tsx -->

Once the audit has marked the arc, its first verb becomes **Join**. Click it on the arc's row in the Arcs sidebar, or press Control-Command-C on the card holding the arc to enter the landing mode and press send, or type `/arc-join <name>`, which opens the same editor over the message the audit wrote. You can edit the message before you send it. The arc lands as one commit, a receipt lands in the transcript, and the branch and worktree are removed.

The model never joins, and nothing joins on its own. There is no chord for Join beyond Control-Command-C. **Join** is refused, and says why on its hover, when no open card holds the arc, when it has no message yet, or while a turn or an earlier join is running.

### Work on an existing arc from this card
<!-- source: tugdeck/src/components/tugways/cards/session-card.tsx (arc-bind surface); tugdeck/src/lib/arc-verbs.ts (Bind, Unbind) -->

Type `/arc-bind <name>`, or `/arc-bind` alone to pick from the project's arcs, or click **Bind** on its row in the Arcs sidebar, which binds it to the card the sidebar follows. **Unbind** lets it go. Careful with the name: `/arc-bind` means work on this arc, making it if needed, so a mistyped name makes a new arc and the receipt says so.

## Changes and commits

### See what changed
<!-- source: tugdeck/src/components/tugways/command-registry.ts (TOGGLE_CHANGES_VIEW Control-Command-C); tugapp/Sources/MenuBarBuilder.swift (session.toggleChanges, session.diff); tugdeck/src/lib/slash-commands.ts (/diff) -->

Press Control-Command-C, or choose Session > Show Session Changes, to show the Changes tab. It sorts the checkout into this session's changes, unattributed changes, orphaned changes and the arcs in flight, each file with its diff. Control-Command-C again closes it. For one whole diff in its own card, type `/diff` or choose Session > Show Project Diff.

### Claim a file
<!-- source: tugdeck/src/components/tugways/tug-changes-list.tsx (Claim); tugdeck/src/components/tugways/command-registry.ts (CLAIM_ALL_CHANGES Control-Command-A) -->

In the Changes tab, click **Claim** on the file or the hunk to bring it into this session. **Claim all** on a section takes that section, and Control-Command-A claims everything unattributed and orphaned at once. Control-Command-A is live only while the Changes tab is up. There is no slash command for it.

### Disclaim a file
<!-- source: tugdeck/src/components/tugways/tug-changes-list.tsx (Disclaim); tugdeck/src/components/tugways/command-registry.ts (DISCLAIM_ALL_CHANGES Control-Shift-Command-A) -->

In the Changes tab, click **Disclaim** on the file or the hunk to let it go from this session. **Disclaim all** takes the whole section, and Control-Shift-Command-A disclaims everything. Control-Shift-Command-A is live only while the Changes tab is up. The file stays changed on disk and shows as unattributed. There is no slash command for it.

### Commit my changes
<!-- source: tugdeck/src/lib/slash-commands.ts (/commit); tugdeck/src/components/tugways/cards/session-card.tsx (commit surface); tugapp/Sources/MenuBarBuilder.swift (session.commit); tugdeck/src/components/tugways/command-registry.ts (LAND_COMMIT, TOGGLE_CHANGES_VIEW) -->

Type `/commit`, or `/commit <message>` with the message already written, or choose Session > Commit Changes, or press Control-Command-C. The composer becomes the commit message editor over the Changes tab, and a prompt you had typed is set aside and comes back when you leave. Write the message and click **Commit**, or the composer's own submit key. The tab drops and a receipt lands in the transcript with the hash, the message and the files.

A commit takes this session's work by default, and anything unattributed or shared starts unchecked. Nothing commits unless you do it, and there is no chord that commits.

### Commit only part of my changes
<!-- source: tugdeck/src/components/tugways/tug-changes-list.tsx -->

In the Changes tab, uncheck the files or hunks to leave out, then commit as usual. What you left stays uncommitted and still belongs to this session.

### Generate a commit message
<!-- source: tugdeck/src/components/tugways/command-registry.ts (COMMIT_AUTO_MESSAGE Control-Command-M) -->

Press Control-Command-M while the composer is the commit message editor, or click the pencil-sparkles button beside it. A message drafted from the diff and the session's prompts arrives word by word, and you can edit it or send it as it is. Control-Command-M does nothing outside the commit editor.

### Push my commits
<!-- source: tugdeck/src/lib/slash-commands.ts (/push); tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx (Push shown when ahead) -->

Type `/push`, or click **Push** in the Changes tab's header, which shows only while the branch is ahead of its upstream. It pushes the branch the checkout is on, takes no arguments, and leaves a receipt in the transcript. There is no menu item and no chord for it.

### Find a past commit
<!-- source: tugdeck/src/components/tugways/command-registry.ts (TOGGLE_HISTORY_VIEW Control-Command-H); tugapp/Sources/MenuBarBuilder.swift (session.toggleHistory); tugdeck/src/components/tugways/cards/session-history/session-history-view.tsx; tugrust/crates/tugcast/src/feeds/overview_agent.rs (git.log) -->

Press Control-Command-H, or choose Session > Show Commit History, to show the commit history, and type in its **Filter commit history** field. The **Hash**, **Message**, **Detail** and **Files** toggles beside the field say where it looks; **Files** matches the paths a commit changed and **Detail** its author and date. **Done** closes it.

For a commit you can only describe, such as "the one from last week that fixed the fold", ask the Overview in its composer, which searches the project's git history and links the commit it finds. Git's own `git log` works too in the Session card's shell.

## The Session card

### Send a prompt
<!-- source: tugdeck/src/components/tugways/tug-prompt-entry.tsx (input model); tugdeck/src/lib/editor-settings-store.ts (defaults); tugdeck/src/components/tugways/cards/settings-session-card-body.tsx; tugdeck/src/components/tugways/command-registry.ts (FOCUS_PROMPT Command-K) -->

Press Shift-Return, or click the send button at the composer's end. Return alone starts a new line, and the Enter key on a numeric keypad sends. Command-K puts the keyboard in the composer from anywhere in the card. To make Return send instead, open Settings with Command-Comma and choose **Return submits** under Prompt Editor on the Sessions tab.

The composer always talks to the model. A shell command, a side question or a search goes through its own slash command, and there is no mode to switch into first.

### Queue a prompt while the model is working
<!-- source: tugdeck/src/components/tugways/tug-prompt-entry.tsx (performSubmit, the queue button) -->

Send it as usual, with Shift-Return, or click the **+** button beside Stop, which shows while a turn runs. The prompt waits in the queue and the model picks it up at its next pause, inside the turn it is running, rather than only when the turn ends.

### Take back a queued prompt
<!-- source: tugdeck/src/components/tugways/tug-prompt-entry.tsx (popInteractive, draft restore) -->

Press Escape, Command-Period or the Stop button. Each press takes back the newest queued prompt, and the turn itself is stopped only once the queue is empty. The prompt's text returns to the composer if the composer is empty. If you have started typing something else, your draft stays and the queued text is gone.

### Stop the model
<!-- source: tugdeck/src/components/tugways/tug-prompt-entry.tsx (popInteractive, the Stop button); tugdeck/src/components/tugways/command-registry.ts (CANCEL_DIALOG, INTERRUPT_SESSION); tugapp/Sources/MenuBarBuilder.swift (session.stop) -->

Press Escape or Command-Period, click the red Stop button where the send button was, or choose Session > Stop. An open sheet or popover takes the Escape first, and a queued prompt is taken back before the turn stops. A turn stopped before the model wrote anything returns your prompt to the composer to edit.

### Recall an earlier prompt
<!-- source: tugdeck/src/components/tugways/tug-text-editor/keymap.ts (history navigation) -->

Press Option-Up Arrow to step back through your prompts and Option-Down Arrow to step forward, wherever the caret is. Command-Up Arrow does the same with the caret at the very start of the composer, and Command-Down Arrow at the very end. A recalled prompt keeps its atoms.

### Ask a quick side question
<!-- source: tugdeck/src/lib/slash-commands.ts (/btw); tugdeck/src/components/tugways/cards/session-card.tsx (btw surface); tugdeck/src/components/tugways/cards/side-question-overlay.tsx -->

Type `/btw <question>`. It works while the model is busy and disturbs nothing: the model answers from the conversation with no tools, in a panel under the status row, and neither the question nor the answer enters the transcript. A bare `/btw` reopens the panel to show earlier answers, each with a **×**, and **Clear** empties it. Side questions do not survive a reload. There is no menu item or chord for it.

### Run a shell command
<!-- source: tugdeck/src/lib/slash-commands.ts (/shell); tugdeck/src/components/tugways/cards/session-card.tsx (shell surface) -->

Type `/shell <command>`. The command runs in the card's own shell and its output lands in the transcript as a block. One runs at a time: a second is refused with "A shell command is already running". There is no shell mode in the composer, and no menu item or chord for it.

### Run a command the model offers
<!-- source: tugdeck/src/lib/markdown/enhance-run-offer.ts; tugdeck/src/lib/run-offer-store.ts; tugdeck/src/lib/run-offer-terminal.ts; tugdeck/src/lib/run-liveness.ts; tugplug/run-offers.md -->

Press **Play** on the command's frame in the transcript. The command runs in the card's shell, the same one `/shell` uses, so it starts in the directory the last command left. Its output streams in under the command, and the footer shows the exit status, how long it took and where it ran. **Copy** copies the command instead, and **Stop** stops one that is running.

Play is dim until the model has finished its turn, and while any other command is running. A command runs until it ends or you stop it. If it prints nothing and does no work for two minutes, a band under its output says it might be stuck: **Terminate** stops it and keeps what it printed, **Keep Waiting** leaves it running and waits twice as long before asking again. A running command holds the card's one shell, so start a server or a watcher in a terminal. A command that needs a password, such as one starting with `sudo` or `ssh`, has no Play and says it needs a terminal. An ordinary shell example in a reply has a small Play in its header too. There is no chord for it.

### Show the model what a command printed
<!-- source: tugdeck/src/lib/markdown/enhance-run-offer.ts (Add to context); tugdeck/src/lib/run-offer-binding.ts -->

After running a command the model offered, click **Add to context** in the footer under its output. The result is attached to your next prompt, and the button reads as staged until you send. Without that press the model never learns the command ran or what it printed: the result is yours.

### See every slash command
<!-- source: tugdeck/src/components/tugways/command-registry.ts (OPEN_COMMAND_PICKER Command-Slash); tugdeck/src/components/tugways/tug-prompt-entry.tsx (openCommandPicker); tugapp/Sources/MenuBarBuilder.swift (session.commandPicker); tugdeck/src/components/tugways/cards/help-sheet.tsx; tugdeck/src/lib/slash-commands.ts -->

Press Command-Slash, choose Session > Open Command Picker, or type `/` in an empty composer, and a list of commands opens to narrow as you type. `/help` opens a sheet with the commands written out, and `/skills` and `/agents` list what the project adds. The list opens only at the start of an empty composer; anywhere else `/` is an ordinary character.

### Put a file in my prompt
<!-- source: tugdeck/src/components/tugways/cards/use-session-card-services.ts ("@" provider); tugdeck/src/components/tugways/command-registry.ts (INSERT_FILE Shift-Command-I); tugapp/Sources/MenuBarBuilder.swift (session.insertFile); tugdeck/src/components/tugways/use-composer-drop.ts -->

Type `@` and start the file's name, then pick it from the list. Press Shift-Command-I or choose Session > Insert File to choose one from a panel. Or drag a file into the composer. Each way puts a file atom in the prompt, a small mark the model reads as the path. `@` offers sessions and commits beside files; it does not complete arcs.

### Mention a session or a commit in my prompt
<!-- source: tugdeck/src/lib/mention-kinds.ts (MENTION_SIGIL_HINT); tugdeck/src/components/tugways/cards/completion-providers/mention-merge.ts -->

Type `@` and part of its name, and pick it from the list, which offers files, sessions and commits together. Type `@@` to see sessions only, or `@#` for commits only. The pick lands as an atom, the same mark the session or commit wears everywhere else, and the model reads it as a reference. The Overview's composer completes the same way. There is no menu item or chord for it.

### Refer to another session
<!-- source: tugdeck/src/components/tugways/session-identity-menu.tsx (Copy as Atom); tugdeck/src/lib/session-ref-block.ts; tugdeck/src/lib/atom-mention-marker.ts -->

Type `@@` in the composer and pick the session, or right-click the session's atom, in its masthead or wherever else it shows, choose **Copy as Atom**, and paste into the composer. Either way the prompt holds a session atom, and the model is told how to read that session's transcript for itself, whichever project it ran in. If the session is not on this machine, the model is told that rather than left to guess. The other session is only read: nothing is resumed and nothing reaches whoever is working in it.

### Dictate a prompt
<!-- source: tugdeck/src/components/tugways/command-registry.ts (TOGGLE_DICTATION Command-D, STOP_DICTATION_AND_SEND Shift-Command-D); tugapp/Sources/MenuBarBuilder.swift (session.dictate, session.dictateAndSend); tugdeck/src/components/tugways/tug-dictation-button.tsx -->

Press Command-D, press the microphone in the composer, or choose Session > Start Dictation, and speak. The words arrive in the composer. Command-D again stops, and leaves the text for you to edit and send. Shift-Command-D, or Session > Stop Dictation and Send, stops and sends once the last words have landed. The Overview's composer has the same microphone. A microphone that cannot start says why on its hover, and clicking it again tries again, so you can grant a missing system permission without reloading.

### Find text in the transcript
<!-- source: tugapp/Sources/MenuBarBuilder.swift (edit.find, edit.findNext, edit.findPrevious, edit.useSelectionForFind); tugdeck/src/components/tugways/tug-find-bar.tsx -->

Press Command-F, or choose Edit > Find > Find, and type. Command-G and Shift-Command-G step to the next and previous match, as do Return and Shift-Return from the field. Command-E searches for what you have selected. **Case**, **Word** and **Grep** narrow the search. Escape or Command-F again closes the bar.

Find reads the card it is in. To search what other sessions said, ask the Overview in its composer.

### Find a file or a line from the composer
<!-- source: tugdeck/src/lib/slash-commands.ts (/match, /search, /ref); tugdeck/src/components/tugways/cards/session-card.tsx (runRefsCommand, ref surface); tugdeck/src/lib/refs-flags.ts -->

Type `/match <name>` to find files by name, or `/search <text>` to find text inside them. The results land in the transcript as numbered rows you can click. `/ref 3`, `/ref 3-5` or `/ref 3 7 9` opens rows from the latest run by number. There is no menu item or chord for these.

### Change the permission mode
<!-- source: tugdeck/src/components/tugways/command-registry.ts (CYCLE_PERMISSION_MODE Control-Option-Command-P); tugapp/Sources/MenuBarBuilder.swift (session.permissionMode.cycle); tugdeck/src/lib/permission-mode.ts; tugdeck/src/lib/slash-commands.ts (/mode); tugdeck/src/components/tugways/cards/ai-chip.tsx; tugdeck/src/components/tugways/cards/ai-config-editor.tsx -->

Press Control-Option-Command-P, or choose Session > Cycle Permission Mode, to step through Default, which asks before edits and commands; Accept Edits, which approves file edits; Plan, which is read-only; and Auto, where a model approves or denies each call. Each mode lasts until you change it, and `/mode` opens the AI settings sheet at its row instead.

Bypass, which asks for nothing, is not in the cycle: choose it in that sheet. Shift-Tab, the terminal's chord for this, moves the keyboard between the card's controls here. The mode cannot change while a turn is running.

### Allow or deny a tool
<!-- source: tugdeck/src/lib/slash-commands.ts (/permissions, /allowed-tools); tugapp/Sources/MenuBarBuilder.swift (session.permissionRules) -->

Type `/permissions`, or choose Session > Permission Rules, to edit the rules that allow, ask for or deny a tool. There is no chord for it. The permission mode is a separate setting: see the recipe above.

### Change the model or effort
<!-- source: tugdeck/src/lib/slash-commands.ts (/ai, /model, /effort); tugdeck/src/components/tugways/command-registry.ts (SLASH_BRIDGE_BINDINGS Control-Command-I); tugdeck/src/components/tugways/cards/ai-chip.tsx; tugdeck/src/components/tugways/cards/session-card.tsx (guardTurnIdleForSetting); tugapp/Sources/MenuBarBuilder.swift (session.ai) -->

Press Control-Command-I, click the **AI Model Settings** chip, type `/ai`, or choose Session > AI Settings. One sheet holds the model, the effort and the permission mode, and `/model` and `/effort` open it at their own rows. While a turn is running it refuses with "Can't change the AI configuration while a turn is in flight".

### Compact the conversation
<!-- source: tugdeck/src/lib/slash-commands.ts (/compact); tugdeck/src/components/tugways/cards/session-card.tsx (compact surface); tugdeck/src/components/tugways/cards/compaction-progress-sheet.tsx; tugapp/Sources/MenuBarBuilder.swift (session.compact) -->

Type `/compact`, or `/compact <what to keep in focus>`, or choose Session > Compact Conversation. A **Compacting…** sheet covers the card, with **Cancel**, and a full context can take minutes. The session stays the same one, with a divider in the transcript and a summary carried forward. It cannot start while a turn is running, and there is no chord for it.

### See how much context is left
<!-- source: tugdeck/src/lib/slash-commands.ts (/context, /usage); tugapp/Sources/MenuBarBuilder.swift (session.context, session.usage); tugdeck/src/components/tugways/command-registry.ts (Control-Command-U) -->

Read the context reading in the status row under the transcript. Type `/context`, or choose Session > Show Context, to open its breakdown. For subscription limits and this session's cost, press Control-Command-U, type `/usage`, or choose Session > Show Usage.

### Rewind the conversation
<!-- source: tugdeck/src/lib/slash-commands.ts (/rewind); tugdeck/src/components/tugways/cards/rewind-sheet.tsx; tugapp/Sources/MenuBarBuilder.swift (session.rewind) -->

Type `/rewind`, or choose Session > Rewind. The sheet lists your messages, and you place a line between two of them: everything above stays and everything below goes. Choose **Conversation**, or **Code + conversation** when the cut has a checkpoint to restore, and click **Rewind**. It cannot be cancelled once pressed. A cut that would cross a `/compact` cannot be picked, and the row says why. There is no chord for it.

### Move this card to another directory
<!-- source: tugdeck/src/lib/slash-commands.ts (/cd, /change-directory); tugdeck/src/components/tugways/cards/session-card.tsx (changeDirectory); tugdeck/src/lib/directory-change.ts -->

Type `/cd <path>`, or `/change-directory <path>`, or `/cd` with a path atom in it. A bare `/cd` opens a folder picker. The card moves and the conversation comes with it, carried into a new session in that directory. It is refused while a turn is running, on a card bound to an arc, and for the directory the card is already in. There is no menu item or chord for it.

### Give this session another directory
<!-- source: tugdeck/src/lib/slash-commands.ts (/add-dir); tugdeck/src/components/tugways/cards/session-card.tsx (addDirectory); tugdeck/src/lib/directory-grant.ts; tugapp/Sources/MenuBarBuilder.swift (session.addProjectDir); tugdeck/src/components/tugways/session-masthead.tsx (Directories row, add-dir button) -->

Type `/add-dir <path>`, or `/add-dir` with a path atom in it, or choose Session > Add Project Directory, or click the folder-plus button in the session's title bar. A bare `/add-dir` and the button open a folder picker. The card stays where it is and the session may now read and write that folder too. Click **Add** to grant it to this session, which keeps it when you resume the session later. Check **Include this directory in all … sessions in the future** first to also save it to the project's local settings, so every later session in the project has it. It is refused while a turn is running, and a path that is not a folder is reported with the reason. The Directories row in the Session Summary lists every folder the session holds beyond its own.

### Take a directory away from this session
<!-- source: tugdeck/src/lib/slash-commands.ts (/remove-dir); tugdeck/src/components/tugways/cards/session-card.tsx (removeDirectoryCommand, registerDirectoryRemover); tugdeck/src/lib/directory-grant.ts (classifyDirectory, removeDirectory); tugdeck/src/components/tugways/session-masthead.tsx (Directories row); tugcode/src/session.ts (removeDirectory) -->

Open the Session Summary and click the **x** at the end of a folder's line in the Directories row, or type `/remove-dir <path>`, or `/remove-dir` with a path atom in it. A bare `/remove-dir` opens the Session Summary. Either way you are asked **Remove this directory?**; click **Remove** and the session can no longer read or write that folder, starting now and in later resumes of the session. A folder you also saved for the project is taken out of the project's local settings too, so later sessions in the project no longer start with it, and `/remove-dir`'s question says so. A folder that your user settings or the project's shared settings also grant has no **x**: its tooltip names those settings, `/remove-dir` says so, and it is removed in Permission Rules. `/remove-dir` on a folder the session does not hold says so. Removing is refused while a turn is running. A folder the session was started with is removed by restarting Claude in place with the shorter list, which keeps the conversation.

### Start a fresh session
<!-- source: tugdeck/src/lib/slash-commands.ts (/clear, aliases /new and /reset); tugdeck/src/components/tugways/cards/session-card.tsx (clear surface); tugapp/Sources/MenuBarBuilder.swift (session.new, file.newSessionCard) -->

Type `/clear`, `/new` or `/reset`, or choose Session > Clear Session, for a fresh session in this card on the same project. The one you left stays resumable if it had any turns. For a new card, press Command-N or choose File > New Session, and pick the project in the list it opens.

### Resume a session
<!-- source: tugdeck/src/lib/slash-commands.ts (/resume, alias /continue); tugdeck/src/components/tugways/cards/session-card.tsx (resume surface); tugdeck/src/components/tugways/cards/resume-sheet.tsx; tugapp/Sources/MenuBarBuilder.swift (session.resume); tugdeck/src/components/tugways/cards/session-picker-form.tsx -->

Type `/resume`, `/continue`, or choose Session > Resume Session, and pick from this project's earlier sessions, or type `/resume <callsign>` to go straight to one. The session comes back into this card with its transcript. A session open in another card is refused with "<callsign> is open elsewhere", and an unknown name with "No session called <callsign>".

For a session in another project, press Command-N and pick it from the list a new card opens with. There is no chord for resuming.

### Move a session to the Trash
<!-- source: tugdeck/src/components/tugways/cards/session-picker-form.tsx (trash confirm, trash all); tugdeck/src/components/tugways/cards/session-picker-cells.tsx (trash button); tugrust/crates/tugcast/src/session_ledger.rs (trash); tugdeck/src/lib/slash-commands.ts -->

Press Command-N to open a new card and find the session in its list. Click the trash icon on the session's row and confirm "Move to Trash?". **Move all sessions in <project> to Trash**, below the list, takes the selected project's whole list, and the sessions too empty to be listed.

A live session has no trash icon: close its card first. A session running in a terminal has none either. The session leaves the list and its transcript moves to a `.tug-trash` folder, and Tug has no command that brings it back. There is no slash command, menu item or chord for it.

### Name a session
<!-- source: tugdeck/src/lib/slash-commands.ts (/rename, alias /name, /unname); tugapp/Sources/MenuBarBuilder.swift (session.rename, session.unname) -->

Type `/rename <name>`, or a bare `/rename` or Session > Rename Session to edit the name in place in the masthead; the masthead's right-click menu and the pencil beside the name open the same field. The name shows in the masthead and the session chooser. `/unname`, or Session > Unname Session, clears it and the callsign comes back.

### Keep a session out of the Overview
<!-- source: tugdeck/src/lib/slash-commands.ts (/private); tugdeck/src/components/tugways/cards/session-card.tsx (private surface) -->

Type `/private`, and again to undo it. From then on nothing new from this session reaches the Overview, its text leaves the search index, and a note confirms the change once it has taken. There is no menu item or chord for it.

### Save or copy a session's words
<!-- source: tugdeck/src/lib/slash-commands.ts (/export, /copy); tugdeck/src/components/tugways/cards/session-card.tsx (export, copy surfaces); tugapp/Sources/MenuBarBuilder.swift (file.exportTranscript, edit.copyLastResponse) -->

Type `/export`, or choose File > Export Session, to save the transcript as Markdown or JSON Lines. Type `/copy`, or choose Edit > Copy Last Response, to put the model's latest message on the clipboard. To send someone only some of the turns, as a PDF, an image or Markdown, see the recipe for sharing part of a conversation.

## Sharing, charts and diagrams

### Share part of a conversation
<!-- source: tugdeck/src/lib/slash-commands.ts (/share); tugapp/Sources/MenuBarBuilder.swift (file.shareTurns); tugdeck/src/components/tugways/cards/session-share-view.tsx; tugdeck/src/components/tugways/cards/share-turn-mark.tsx (Share from Here…); tugdeck/src/lib/share-actions.ts; tugdeck/src/lib/share-turns.ts -->

Type `/share`, or choose File > Share Turns. A shade titled **Share Turns** rises from the bottom of the card, and every prompt, answer and shell exchange in the transcript shows a checkbox at the right of its header. Check the ones you want, choose **PDF**, **Image** or **Markdown** under Format, choose **Preview**, **Copy**, **Save** or **Share** from the Action menu, and press the button beside it, which wears the action's name. Return presses it too. **Done** or Escape leaves.

Each box selects its own row and nothing else, so a prompt and its answer are checked apart. The button stays dim until something is selected, and a turn that is still running has no box until it ends. Secrets are removed and your home folder is written as `~` before anything is made, and the model's thinking is never included. There is no chord for it.

### Share everything from one turn on
<!-- source: tugdeck/src/components/tugways/cards/share-turn-mark.tsx (Share from Here…); tugdeck/src/components/tugways/cards/session-card.tsx (shareFromTurn) -->

Right-click the row where the part worth sharing starts and choose **Share from Here**. The Share Turns shade opens with that row and every later one already selected, and you can uncheck what you do not want.

### Select a run of turns to share
<!-- source: tugdeck/src/components/tugways/cards/share-turn-mark.tsx (shift-click extends from the anchor); tugdeck/src/components/tugways/cards/session-share-view.tsx (Select All, Clear All, the count) -->

With the Share Turns shade up, click the checkbox on the first row, then hold Shift and click the box on the last: every row between them is selected. **Select All** takes the whole transcript and **Clear All** starts over, and the count beside them says how many turns are selected.

### Choose how tool calls look in a share
<!-- source: tugdeck/src/components/tugways/cards/session-share-view.tsx (TOOL_MODE_ITEMS); tugdeck/src/lib/share-turns.ts (ShareToolMode) -->

In the Share Turns shade, choose under **Tools**: **Summaries** writes each tool call as one line, **Full** keeps its input and output, and **None** leaves tool calls out so only the words remain. Summaries is what a shade starts with.

### Look at a share before sending it
<!-- source: tugdeck/src/lib/share-actions.ts (previewShare); tugdeck/src/components/tugways/cards/session-share-view.tsx (SHARE_ACTIONS) -->

Choose **Preview** from the Action menu and press the button. The result opens in a preview with **Done**, drawn exactly as it would be sent: a PDF is one continuous page, and an image is the whole selection as one picture in your current theme. Copy, Save and Share never show a preview first, so choose Preview when you want to look.

### Share a private session
<!-- source: tugdeck/src/components/tugways/cards/session-card.tsx (confirmPrivate); tugdeck/src/lib/share-actions.ts (makeArtifact) -->

Share it as any other. A session you marked with `/private` asks once, "This session is private. Render its turns for sharing?", before it makes anything; click **Render** to go on. Sharing does not change the session's privacy.

### Draw a chart
<!-- source: tugplug/skills/viz/SKILL.md; tugplug/graphics.md; tugdeck/src/lib/chart/render-chart.ts; tugrust/crates/tugtool (chart list, chart forms) -->

Ask for it in the composer, in words: "chart commits per day this month", "plot how long the tests take". Or type `/tugplug:viz` and what you want to see. The chart is drawn in the transcript, in your theme, with a title that states what it found and a sentence beside it. The numbers can come from the project's records, a file, a CSV, a command's output, or figures already in the conversation.

A bare `/tugplug:viz` lists the charts Tug can already compute and every form a figure can take. There is no menu item or chord that draws a chart; Control-Command-V opens the list of recipes, in the recipe below.

### Choose the kind of chart
<!-- source: tugplug/skills/viz/SKILL.md (The form); tugrust/crates/tugtool (chart forms) -->

End the request with the form: `/tugplug:viz how big commits are as a histogram`. The ten forms are bar, line, area, sparkline, dots, histogram, spans, heat, bullet and scatter, and everyday words work too: "timeline" draws spans, "heatmap" draws heat, "trend" draws a line, "distribution" draws a histogram. With no form named, the model picks one from the data. Ask for a pie and you get one stacked bar, because there is no pie. If the data cannot take the form you named, the model says why and draws the nearest one that can.

### See which charts Tug can draw
<!-- source: tugdeck/src/components/tugways/cards/data-visualization-sheet.tsx; tugdeck/src/lib/slash-commands.ts (/visualize-data); tugdeck/src/components/tugways/command-registry.ts (Control-Command-V); tugapp/Sources/MenuBarBuilder.swift (session.visualizeData) -->

Press Control-Command-V, type `/visualize-data`, or choose Session > Visualize Data. A sheet lists every chart recipe under Activity, Changes, Arcs, Tests, Telemetry and Models, each with a line on what its data tells and a small figure. The figure is drawn from this project's own data, or is marked **Sample** when the project has none for it yet. Click **Visualize…** and the recipe's command lands in the composer, unsent, so you can add a path, a number of days or a form before you send it. **Done**, Escape or the chord again closes the sheet.

The sheet draws nothing in the transcript by itself: Visualize… only writes the command for you. From a shell, `tugtool chart list` prints the same recipes.

### See the numbers behind a chart
<!-- source: tugdeck/src/lib/chart/render-chart.ts (buildViewToggle, buildTable, Copy chart source); tugdeck/src/lib/chart/chart-hover.ts; tugdeck/src/lib/chart/chart-view-memory.ts -->

Hover a bar, a point or a span to read its values. For all of them at once, click the table button in the chart's header: the figure becomes a table of its data, and the same button brings the figure back. The card remembers which you chose for that chart. **Copy** in the header copies the chart's source, the short description the figure was drawn from, which you can paste into a prompt to ask for a change. Command-F finds text in a chart as it does in the rest of the transcript.

### Have the model explain how code works
<!-- source: tugplug/skills/explain/SKILL.md; tugplug/diagrams.md; tugdeck/src/lib/chart/keyed-table.ts; tugdeck/src/lib/chart/render-chart.ts (buildKeyedTable) -->

Type `/tugplug:explain` and the subject: a feature, a flow, a file or a directory, as in `/tugplug:explain how a save reaches the disk`. Asking in words works too: "explain how login works", "walk me through the parser". The model reads the code and answers with one to four sections, each with a heading that states a finding, a diagram, a sentence on how to read it, and a short lead.

Under each diagram is its keyed table: a row for every numbered disc in the figure, with the part's name, what it does and where it is in the code. Click a location to open the file in a card. A location marked unresolved is one Tug could not find, usually because the file has moved since. A bare `/tugplug:explain` lists the six diagram forms, and Session > Explain Code shows them with a sample of each.

### Choose the kind of diagram
<!-- source: tugplug/skills/explain/SKILL.md (a form the request names); tugplug/skills/viz/SKILL.md (A diagram); tugrust/crates/tugtool (chart forms --kind diagram) -->

End the request with the form: `/tugplug:explain how login works as a sequence`. A **flow** follows work through its parts and branches, a **sequence** shows who says what to whom in order, **layers** shows what a request passes down through, a **stack** shows the architecture, **states** shows what one thing can be and what moves it between them, and a **tree** shows what is inside what. Ask `/tugplug:explain the connection's lifecycle as states` for the states a thing passes through and back, or `/tugplug:explain the parts of the settings page as a tree` for its parts and where they live. "Flowchart", "architecture", "who calls whom", "state machine" and "hierarchy" are understood as well. For one diagram with no written sections around it, ask `/tugplug:viz` for the structure instead.

### See which diagrams Tug can draw
<!-- source: tugdeck/src/components/tugways/cards/explain-code-sheet.tsx; tugdeck/src/lib/slash-commands.ts (/explain-code); tugdeck/src/components/tugways/command-registry.ts (Control-Command-X); tugapp/Sources/MenuBarBuilder.swift (session.explainCode) -->

Press Control-Command-X, type `/explain-code`, or choose Session > Explain Code. A sheet lists the six diagram forms, each with a line on what it shows, the everyday words that ask for it, an example request and a small figure marked **Sample**. The figure is always a sample, because a diagram of your project exists only after the model has read the code. Click **Explain…** on a form and `/tugplug:explain` lands in the composer, unsent, with the form already written and the caret where the subject goes: type what you want explained and send. Words already in the composer are kept as the subject. The first row, **Let the question choose**, places the command with no form, and the model picks one for each part of its answer. **Done**, Escape or the chord again closes the sheet.

### Keep an explainer as a file
<!-- source: tugplug/skills/explain/SKILL.md (Keep it, only when asked) -->

Add "keep" to the request, as in `/tugplug:explain the edit gate keep`, or name a path to write to. The explainer is written to `explainers/` at the top of your project, named for its subject, with a first line recording the commit it was drawn at. It is never written over an earlier one and never committed for you. Without "keep" nothing is written: the answer in the transcript is the explainer.

### Share a chart or a diagram
<!-- source: tugdeck/src/share/share-root.tsx; tugdeck/src/lib/share-actions.ts (shareRender) -->

Share the turn that holds it: type `/share`, check that answer, and choose **PDF** or **Image**. The figure is drawn in the share as it is in the card, in your current theme, and a diagram keeps its keyed table with each location written out. Markdown carries the figure's source rather than a picture, so choose it only for a reader who has Tug.

## The window and its cards

### Open a file
<!-- source: tugapp/Sources/MenuBarBuilder.swift (file.openFile, file.openQuickly, file.openRecent, file.newTextCard); tugdeck/src/components/chrome/open-quickly-overlay.tsx; tugdeck/src/lib/open-file-in-card.ts -->

Press Command-O or choose File > Open File for a panel, or press Shift-Command-O or choose File > Open Quickly and type part of the name, which searches the frontmost card's project. File > Open Recent lists what you opened lately, and Option-Command-N or File > New Text File starts an empty one. A text file opens in a Text card you can edit. An image or a PDF opens in a read-only viewer card. A file atom in a transcript opens on a click too.

### Save a text file
<!-- source: tugapp/Sources/MenuBarBuilder.swift (file.save, file.saveAs, file.saveACopy, file.revertToSaved, file.reloadFromDisk) -->

Press Command-S or choose File > Save. File > Save As, Save a Copy, Revert to Saved and Reload from Disk are beside it in the File menu.

### Preview a Markdown file
<!-- source: tugdeck/src/components/tugways/cards/text-card.tsx (the Preview toggle); tugdeck/src/components/tugways/command-registry.ts (toggle-markdown-preview Option-Command-P) -->

With the file open in a Text card, click **Preview** in the card's status bar, press Option-Command-P, or choose View > Show Markdown Preview. The rendered document covers the editor, including edits you have not saved. The same gesture brings the editor back with its caret, selection and undo history as they were. Command-F searches the rendered text, a link to a file beside the document opens it, and Command-S still saves.

The preview is read-only. The toggle shows only when the card's file type is Markdown, so a file with another extension gets it once you set its type to Markdown in the status bar, and Option-Command-P does nothing over any other card.

### See a commit in its own card
<!-- source: tugdeck/src/components/tugways/command-registry.ts (OPEN_COMMIT, its doors) -->

Click a commit atom, in a transcript, a receipt or anywhere else it appears, or right-click it for its menu. A Commit card opens with the message, the trailers and the files with their diffs. There is no menu item or chord for it. To find the commit first, see the recipe for finding a past commit.

### See a diff in its own card
<!-- source: tugdeck/src/components/tugways/command-registry.ts (OPEN_DIFF, its doors); tugdeck/src/lib/slash-commands.ts (/diff); tugapp/Sources/MenuBarBuilder.swift (session.diff) -->

Type `/diff`, or choose Session > Show Project Diff, for everything uncommitted in this project. There is no Open Diff menu item and no chord for it.

### Close a card
<!-- source: tugdeck/src/components/tugways/command-registry.ts (CLOSE Command-W, CLOSE_ALL Option-Command-W); tugapp/Sources/MenuBarBuilder.swift (Close, Close All Tabs) -->

Press Command-W, or choose File > Close. Option-Command-W, or File > Close All Tabs, closes every card in the stack.

### Change how many cards the window holds
<!-- source: tugdeck/src/components/layout/layout-card.tsx (One Up to Six Up); tugdeck/src/components/tugways/command-registry.ts (Control-Command-L) -->

Press Control-Command-L to show the Layout card, and choose from One Up to Six Up in its first row. Each number is how many slots the deck has, and the deck arranges the cards itself. You never drag a card to a position or size it by its edges. The same card sets the card width and the gap between cards.

### Switch between Fit and Flow
<!-- source: tugdeck/src/components/layout/layout-card.tsx (fit, flow) -->

Press Control-Command-L to show the Layout card, and choose **Fit** or **Flow**. Fit keeps every card in the window, overlapping when it must. Flow keeps each card at full width and lets the row run past the window's edge. There is no chord or menu item for it.

### Move a card to another slot
<!-- source: tugdeck/src/components/tugways/command-registry.ts (Command-1 through Command-6); tugdeck/src/components/cards/slot-picker.tsx; docs/features.md (Moving cards) -->

Press Command-1 through Command-6, click the slot badge in the card's masthead and pick from the miniature of the deck, or drag the card by its masthead. Escape cancels a drag. Option-Shift-Command-Left Bracket and Option-Shift-Command-Right Bracket nudge the card one slot left or right.

### Go to another card
<!-- source: tugapp/Sources/MenuBarBuilder.swift (go.previousCard, go.nextCard, go.previousCardInStack, go.nextCardInStack, go.goToSlot, go.revealStack); tugdeck/src/components/tugways/command-registry.ts -->

Press Control-Command-1 through Control-Command-6 to go to a slot, or Shift-Command-Left Bracket and Shift-Command-Right Bracket to step across the deck. Option-Command-Left Bracket and Option-Command-Right Bracket step through a stack, and Command-R shows what is in it. Option-Command with an arrow key goes to the card to the left, above, right or below. All of these are in the Go menu. To jump to a session you can name, use its row in the Workspaces sidebar.

### Go back to the card I was just in
<!-- source: tugdeck/src/lib/focus-trail.ts; tugapp/Sources/MenuBarBuilder.swift (go.back, go.forward); tugdeck/src/components/tugways/command-registry.ts -->

Press Control-Option-Command-Left Bracket, or choose Go > Back. Each press steps one card further back through the cards you had focused, in the order you focused them, and Control-Option-Command-Right Bracket, or Go > Forward, retraces the steps. A sidebar card counts as a stop, a card in another workspace takes you to that workspace, and a card you have closed is skipped.

It works as a browser's Back does: focus a different card after going back and the forward steps are gone. At either end of the trail the focused card's border flashes and nothing moves. The trail is not kept across a relaunch.

### Show two cards in one slot at once
<!-- source: tugdeck/src/components/tugways/command-registry.ts (TOGGLE_SLOT_SPLIT Control-Command-Slash, Move Card in Slot, Equalize Heights); tugapp/Sources/MenuStateSync.swift (view.slotSplit) -->

Press Control-Command-Slash, or choose View > Split or Stack Slot, and the slot's stack becomes a split, each card lettered from the top. The same chord turns it back. Control-Command-Up Arrow and Control-Command-Down Arrow move a card up or down, Control-Shift-Command-Up Arrow and Control-Shift-Command-Down Arrow send it to the top or bottom, and View > Equalize Heights evens them out. Drag the seam between two cards to size them by hand.

### Fold a card
<!-- source: tugdeck/src/components/tugways/command-registry.ts (TOGGLE_CARD_FOLD Control-Command-Y); tugapp/Sources/MenuBarBuilder.swift (View menu, built from the registry) -->

Press Control-Command-Y, or choose View > Fold Card. The card shrinks to its masthead, keeps its slot and its live readings, and opens again on the same chord.

### Read one card at the center of the window
<!-- source: tugdeck/src/components/tugways/command-registry.ts (TOGGLE_BULLSEYE Control-Command-B); tugapp/Sources/MenuBarBuilder.swift (View menu, built from the registry) -->

Press Control-Command-B, or choose View > Bullseye. The card takes the center at a reading width and the rest slide aside. The chord again, a click on another card or moving the keyboard to one brings everything back, and nothing about the layout has changed.

### Make everything bigger or smaller
<!-- source: tugdeck/src/components/tugways/command-registry.ts (ZOOM_IN, ZOOM_OUT, ZOOM_ACTUAL, ZOOM_TOGGLE_ACTUAL); tugdeck/src/components/tugways/cards/settings-session-card-body.tsx (Magnification) -->

Press Shift-Command-Plus Sign or Command-Minus Sign to zoom the whole app, Command-0 for actual size, and Option-Command-0 to go back and forth between actual size and your zoom. The View menu has all four. For larger words in transcripts only, open Settings with Command-Comma and move **Magnification** under Transcript on the Sessions tab.

### Show or hide a sidebar card
<!-- source: tugdeck/src/components/tugways/command-registry.ts (SIDEBAR_MENU_CARDS, TOGGLE_SIDEBARS, RESIZE_SIDEBARS_TO_FIT, rail rows); tugapp/Sources/MenuBarBuilder.swift (per-card sidebar rows under View) -->

Press Control-Command-O for the Overview, Control-Command-R for Arcs, Control-Command-W for Workspaces, Control-Command-J for Jots or Control-Command-L for Layout. The View menu has a row for each. Control-Command-S hides and shows all the sidebars, Option-Shift-Command-S sizes them to fit, and Control-Command-Left Arrow and Control-Command-Right Arrow show a rail or give it the keyboard. The Layout card says which rail each one sits on.

### Save a prompt fragment for later
<!-- source: tugdeck/src/components/jots/jots-card.tsx; tugdeck/src/components/tugways/command-registry.ts (NEW_JOT Command-J); tugapp/Sources/MenuBarBuilder.swift (file.newJot) -->

Press Command-J, or choose File > New Jot, and write it. It lands in the Jots sidebar, which Control-Command-J shows. Drag a row into any composer to use it, or click its **Copy**.

### Keep separate decks for separate work
<!-- source: tugapp/Sources/MenuBarBuilder.swift (window.newWorkspace, window.renameWorkspace, window.duplicateWorkspace, window.deleteWorkspace); docs/features.md (Workspaces) -->

Choose Window > New Workspace and type its name; Cancel makes nothing. Each workspace is a named deck with its own cards and theme, and the Window menu cuts between them and holds Rename, Duplicate and Delete. Control-Command-W shows the Workspaces sidebar, where you can drop a session on another workspace to move it there. There is no chord for making one.

### Change the theme
<!-- source: tugapp/Sources/MenuBarBuilder.swift (dynamic Theme menu); tugdeck/src/components/tugways/command-registry.ts (Next Theme Shift-Command-T, apply-theme-to-all-workspaces); tugdeck/src/action-dispatch.ts (SHIPPED_THEME_NAMES) -->

Choose View > Theme, or press Shift-Command-T for the next one. The theme belongs to the workspace you are in. View > Apply To All Workspaces gives every workspace this one. The ten that ship are the only ones: there is no theme editor.

### Change a setting
<!-- source: tugapp/Sources/MenuBarBuilder.swift (Settings...); tugdeck/src/components/tugways/cards/settings-card.tsx (General, Sessions, Text Files, Viewer Cards); tugdeck/src/components/tugways/command-registry.ts (SHOW_CARD_SETTINGS) -->

Press Command-Comma or choose Tug > Settings. The card has four tabs: General, Sessions, Text Files and Viewer Cards. A Text, image or PDF card also has **Card Settings** in its own menu, for that card alone.

### Be told when a session finishes or needs me
<!-- source: tugdeck/src/components/tugways/cards/settings-general-body.tsx (Session Notifications); tugdeck/src/lib/session-notify.ts; tugapp/Sources/SessionNotifier.swift -->

Open Settings with Command-Comma and find **Session Notifications** on the General tab. **When a session completes** and **When a session needs your input** each choose **Keep bouncing**, **Bounce once** or **Don't bounce** for the Dock icon, and each has a **Post macOS notification** switch. macOS asks for permission the first time a notification is posted, and clicking one opens that session's card.

Tug starts with one bounce and no notifications. Nothing bounces or posts while Tug is the frontmost app, since the session's dot already tells you there.

### Make tooltips appear sooner or later
<!-- source: tugdeck/src/components/tugways/cards/settings-general-body.tsx (Tooltip Delay); tugdeck/src/lib/tooltip-delay.ts -->

Open Settings with Command-Comma and set **Tooltip Delay** on the General tab, from 0s to 0.7s, or Never to turn tooltips off.

### See or change a keyboard shortcut
<!-- source: tugdeck/src/components/tugways/command-registry.ts (SHOW_KEYBOARD_SHORTCUTS Control-Command-K); tugdeck/src/components/tugways/cards/keyboard-card.tsx; tugdeck/src/components/tugways/cards/settings-keymap-body.tsx -->

Press Control-Command-K, or choose Tug > Keyboard Shortcuts. The card lists every command and what it is bound to, says when a chord is shadowed and by what, and lets you rebind the ones that are yours to change. A collision shows before you commit it.

### Update Tug
<!-- source: tugapp/Sources/MenuBarBuilder.swift (Check for Updates); tugapp/Sources/UpdateState.swift (menuTitle) -->

Choose Tug > Check for Updates. The item's title follows the update as it goes, reading "Update to Tug <version>…" when one is available and "Install and Relaunch Tug <version>…" when it is ready. A build that cannot replace itself does not show the item.

When the new version needs a newer Claude Code than you have, the update panel shows an **Update Claude Code** step naming both versions, and holds the install until that step is done. Decline and nothing is installed: the Tug you have keeps working. Escape closes the panel.

### Ask Tug how something works
<!-- source: tugdeck/src/components/tugways/command-registry.ts (TOGGLE_OVERVIEW Control-Command-O); tugapp/Sources/MenuBarBuilder.swift (Help menu); tugrust/crates/tugcast/src/feeds/overview_agent.rs -->

Press Control-Command-O to show the Overview and type your question in its composer. It answers from these documents and from what your sessions have recorded, and links what it rests on. To read for yourself, the Help menu opens **Tug Help**, **How Do I…** and **Glossary** as cards, and **Keyboard Shortcuts & Commands** opens the `/help` sheet.

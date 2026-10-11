I started the Tug project eight months ago today, with the goal of creating an Integrated Development Environment (IDE) for AI coding. 

AI has dramatically increased the potential scope and speed of software development, and I think our software development tools can and should change as well. To some extent, they are. Some IDEs have bolted on AI features, but have otherwise stayed mostly the same. Claude Code offers a terminal app (that works far better than I imagined it could), but it fails to capitalize gives up much of the iconography, typography, and other advantages of graphical user interface programs. Other apps and efforts underway as well, but in my view, we are now in a period where we should try a lot of different things, to question and re-make long-held conventions and beliefs about how software can get made.

This is what I've done. Tug is a native macOS IDE for AI coding. Claude Code does the AI work. Tug wraps it in a graphical application where the conversation, the shell, the files, the git history and in-flight work all live on one surface, with excellent typography, graphical text input, direct manipulation, fully-integrated keyboard commands, and many custom components that help track the development process.

It is built on a few core ideas:

- **Sessions replace the terminal.** Shell commands and AI turns coexist in one scrolling document. Tool calls render as purpose-built blocks that promote legibility. Interactivity takes place inline to answer questions and give permission when needed. Several sessions can run at once across several projects. Each gets a permanent name/callsign, a live activity sparkline and a status row showing its state, time elapsed, context window and background jobs. 
- **Every edit is attributed.** Tug records which session changed which file, and which lines, so a commit can be composed from exactly one line of work, even with several sessions open on one checkout. The Changes view shows a session's files with their diffs, lets you land a file one hunk at a time, and keeps a commit message draft that fills in as the work proceeds.
- **Big work leaves `main` and comes back.** Tug offers a construct called an *arc* that runs the AI model on its own git worktree through a progression of stages: devise, review, implement and audit, each on a fresh session that reads the plan cold. As the base branch moves, the arc replays onto it, and conflicts are resolved as the work proceeds, so that when the arc is complete, the worktree changes can be easily merged back into the main line of development.
- **Many sessions, one picture.** The Overview channel narrates all of them: an *Observer* digests what every session is doing, an *Operator* answers questions about the work, and you can post there too. Any session can read another's transcript, and a session reference pasted into a prompt resolves even if another copy of Tug recorded it.
- **A graphical language.** Tug draws on a custom-built visual toolkit. The state of concurrent work can be read at a glance rather than parsed out of text.
    - *Atoms:* a file, a commit, a session, an arc or an image is one mark wherever it appears, in a prompt, a transcript, a sidebar row or a receipt. Each kind has one hover tip, one context menu and one copy form, and every atom pastes between Tug windows intact.
    - *Marks that mean something:* a session's dot carries its phase and breathes while it works, shedding a ring on each beat. A commit's node is a plain ring and never moves, because a commit has no phase. A three-bar *wave* says a turn is in flight. Rings, bars, pies and spinners each have a running pose, a stopped pose and a completed pose.
    - *Instruments:* an activity sparkline on every session, a context-window gauge, a step fraction and lifecycle track on every arc, placards that open from the status row with links into the transcript, and receipts for every landing.
    - *Motion that tells the truth:* only live work animates. A settled session is still, a layout change animates into place, a sheet drops from the title bar like a window shade, and the whole deck is measured so that nothing moving costs a frame when the work is at rest.
    - *A component system:* about a hundred purpose-built components, each one implementation and one stylesheet, drawn from a shared palette of theme tokens. Everything from a checkbox to the transcript follows one authoring guide, which is why the ten themes can recolor the whole app.
- **The canvas** provides a unified graphical surface where all this work takes place. One macOS window holds a *deck* of *cards*, and cards come in two kinds.
    - *Content cards* carry the work. The **Session card** is the AI coding session described above. The **Text card** is a CodeMirror editor with autosave or manual save, a find bar and conflict handling. The **File viewer** shows images and PDFs. The **Diff card** shows the project diff, inline or side by side, whole or scoped to a path, range or commit. The **Commit card** opens one commit's full record. **Settings**, **Keyboard Shortcuts** and **About** round out the set.
    - *Sidebar cards* pin to the window's edges and watch over the content. **Overview** is the narration channel. **Arcs** lists every arc in every open project with its lifecycle track, step progress and verbs to start, stop, join, replay or discard. **Workspaces** mirrors every deck's cards with live session tallies. **Jots** holds reusable prompt fragments you can drag into any composer. **Layout** is a to-scale miniature of the deck you can press and hover, with rows for slot count, arrangement, card width, zoom and sidebar placement.
    - *Imposition:* the deck auto-arranges cards into *slots*. **Fit** keeps every card in the window and lets crowded cards overlap, while **Flow** keeps cards from overlapping and lets the arrangement run past the right edge, creating a scrolling list of cards that make it easy to move between to keep the most relevant card front and center.
    - *Moving cards:* Every card wears a slot badge, and pressing it opens the whole arrangement so you can place the card anywhere. Rearrangements animate into place. Drag a card and drop zones light up one place at a time; hold ⌘ at the drop to free it from the arrangement entirely.
    - *Free geometry:* a freed card drags anywhere and resizes from eight handles, with snap guides while Option is held. Pin it back to a slot or a rail whenever you like.
    - *Columns and stacks:* split or stack a column, move cards within it, drag the seam to resize, step through a stack.
    - *Bullseye:* one chord centers the focused pane at reading width while the others slide aside. Nothing is written to the layout.
    - *Fold:* collapse any card to its masthead. A folded Session card keeps its status row.
    - *Workspaces:* named decks, each with its own theme. New, rename, duplicate, delete from the Window menu.
    - *Whole-app zoom:* 50 to 200 percent, scaling layout, type and spacing together. Transcripts have a separate magnification.
    - *Ten themes:* five dark and five light themes, one tint hue each over a shared tone skeleton, all held within a contrast budget that ensures excellent legibility.
    - *Keyboard integration:* a tiered chord scheme, directional focus between cards, a keyboard-focus mode where Tab walks a linear order and arrows move spatially.




undertake big software development projects where AI assistance plays a pivotal role.

To me, *AI profoundly expands the potential scope and speed software development*, and I have some numbers to support this below.  

Tug keeps the underlying reliance on Claude Code to provide the core of the AI contribution, but it wraps these AI interactions in a new app that provides a more varied, informative, and graphically rich experience, with new displays and facilities like multi-session tracking, git worktree tools, file tracking, themes

Beyond the desire to investigate, I had a couple more personal goals: I wanted to make an app I would be happy to use *all day every day*. I also wanted the code to be open source, since I have benefitted so much from 

Today, I am pleased with Tug. I do indeed use it *all day every day*. About four months ago, I cut over to developing Tug with Tug (I did the preceding bootstrapping period with Claude Code in the terminal). From that day, I never looked back. This gives me the confidence that Tug is becoming suitable for serious projects, and while there's much more I can do to add and improve features, I think I succeeded.

Amd now, some numbers. In Tug, over eight months, I've done nearly 7k commits in over 3.9k files and almost 875k lines of code in a half-dozen languages. These numbers don't tell anything about quality, of course, but they do speak to the pace of my work. This rate of change is incredible to me. In 2020, I did a six-month project I did to create Up Spell, an iOS word game. I wrote that project in the *old-fashioned* style where I typed each line of code, one at a time. The results were: 235 files and 31k lines of code.

|  | Up | Tug | Tug ÷ Up |
| --- | --- | --- | --- |
| Commits/day | ~4.8 | ~29 | ~6× |
| Files/day (net) | ~1.3 | ~16 | ~12× |
| Code lines/day (net) | ~175 | ~3,600 | ~20× |
| Code lines per commit | ~36 | ~125 | ~3.5× |
| Total code lines | 31.6k | 875k | ~28× |

In Tug, I have been adding about 20 times as many lines of code per day as I did during Up Spell. I have produced all this code as the only human on the project. In the times before AI, I doubt I would have even attempted a project of this size and complexity. It feels as if it would have taken me *many years* to do the work I have done in the past few months.




, and with so much of human-AI interaction revolving around reading and writing text, giving up on  in favor of the rows and columns of a terminal emulator feels like too much. 
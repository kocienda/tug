All four surveys are in. Here is the first cut: a short framing you can lift into the essay, then the list in *feature: description* form, graphical surface first and underpinnings second.

## How to describe what Tug does

Tug is a native macOS IDE for AI coding. Claude Code does the AI work. Tug wraps it in a graphical application where the conversation, the shell, the files, the git history and the work in flight all live on one surface, with real typography, direct manipulation and keyboard command throughout. It is built on three ideas worth stating up front:

- **The Session card replaces the terminal.** Shell commands and AI turns coexist in one scrolling document. Tool calls render as purpose-built blocks, not log lines.
- **Every edit is attributed.** Tug records which session changed which file, so a commit can be composed from exactly one line of work, even with several sessions open on one checkout.
- **Big work leaves `main` and comes back.** An arc runs the model on its own worktree through devise, review, implement and audit stages, each on a fresh session that reads the documents cold. You land it with one gesture.

Candidate one-liners: "An IDE for AI coding." "Claude Code, with a user interface." "The terminal was the first draft."

## The graphical surface

**The deck**

- *Deck, panes and cards:* one window holds a deck of panes, each pane a tabbed stack of cards. Cards drag between panes, with drop zones shown one place at a time.
- *Three geometry modes:* Free (drag, eight-handle resize, snap guides on Option), Pinned (sidebar rails) and Imposed (numbered slots laid out as Flow or Fit).
- *Slots:* ⌘1 through ⌘9 send a card to a slot. Rearrangements animate into place.
- *Columns and stacks:* split or stack a column, move cards within it, drag the seam to resize, step through a stack.
- *Bullseye:* one chord centers the focused pane at reading width while the others slide aside. Nothing is written to the layout.
- *Fold:* collapse any card to its masthead. A folded Session card keeps its status row.
- *Workspaces:* named decks, each with its own theme. New, rename, duplicate, delete from the Window menu.
- *Layout card:* a live to-scale miniature of the deck you can press and hover, plus rows for slot count, Flow versus Fit, card width, zoom and sidebar placement.
- *Whole-app zoom:* 50 to 200 percent, scaling layout, type and spacing together. Transcripts have a separate magnification.
- *Ten themes:* five dark ships (Ironclad, Caravel, Barque, Galleon, Collier) and five light boats (Sloop, Ketch, Skiff, Kayak, Pinnace), one tint hue each over a shared tone skeleton, all held within one contrast budget.

**The Session card**

- *Transcript:* virtualized markdown with KaTeX math, Mermaid diagrams, ANSI output, JSON trees, images with fullscreen view and nested subagent transcripts.
- *Dedicated tool blocks:* Bash, Read, Edit, Write, Glob, Grep, Agent, AskUserQuestion, Skill, WebFetch, WebSearch, worktree and task tools each render as a purpose-built block. Edits show word-level diffs.
- *Inline permission dialog:* a tool approval appears in the transcript with a preview of what it will do, not as a modal.
- *Question wizard:* AskUserQuestion becomes a paged in-place form that stays in the transcript as the record of the answer.
- *Composer:* a CodeMirror editor with `@` file completion, `/` command completion with argument hints, drag-and-drop of files and jots, image attachments, and Up-arrow history that never forgets.
- *Atoms:* files, commits, sessions, arcs and images are first-class pills in prompts and prose. Each has one hover tip, one context menu and one copy form. They paste between Tug windows intact.
- *Smart shell routing:* type a shell command with no prefix and Tug runs it in the shell instead of sending it to Claude. Output can be added to the next prompt as context.
- *Dictation:* on-device speech to prompt text. One chord toggles, another stops and sends.
- *Side questions:* `/btw` asks a quick question with no tools, kept out of the transcript.
- *AI chip:* model, effort and permission mode in one control, with a sheet to change them. Permission mode survives reconnects.
- *Status row:* state, elapsed time, context-window gauge, tasks and background jobs, each opening a placard with links into the transcript.
- *Masthead:* session name, callsign, phase dot, description and a live activity sparkline.
- *Navigation:* previous and next turn, first and last turn, find with case, word and grep toggles, jump to bottom, load older on resumed sessions.
- *Rewind:* pick a turn and restore the conversation, and optionally the code, to that point.
- *Session management:* resume any earlier session into the card, rename, clear, mark private, compact, export as Markdown or JSON Lines, change directory while keeping the conversation.
- *Info sheets:* usage and cost, context breakdown, skills, agents, hooks, memory files, help.

**Changes, commits and history**

- *Changes shade:* this session's changed files with inline diffs. Select individual hunks to land part of a file.
- *Commit mode:* the composer becomes the commit message editor. A maintained draft fills in live, or one chord generates a message.
- *Receipts:* commit, push, join and discard each leave a receipt block in the transcript.
- *History shade:* the project log as compact rows, opening into a full Commit card.
- *Project Diff card:* the repo-wide diff, inline or side by side, or scoped to a path, range or commit.

**Sidebar cards**

- *Overview:* an app-wide narration channel. An Observer digests what every session is doing, an Operator answers questions about it, and you can post too.
- *Arcs:* every arc in every open project with its lifecycle track, step fraction, notes and divergence, plus Start, Resume, Stop, Join, Diff, Replay, Discard and Bind.
- *Workspaces:* a mirror of every workspace's deck, with live session tallies, latest activity lines and a slot picker per card.
- *Jots:* reusable prompt fragments, kept machine-wide, draggable into any composer.

**Other cards and app flows**

- *Text card:* a CodeMirror 6 editor with autosave or manual save, find bar, status bar and external-change conflict handling.
- *File viewer card:* images and PDFs, each with its own view settings.
- *Settings card:* System Settings style sections for general, sessions, text files and viewers.
- *Keyboard Shortcuts card:* every command and its chord, rebindable in place.
- *Open Quickly and Open Recent:* fuzzy file open across the project.
- *Keyboard-first design:* a tiered chord scheme (⌘ universal, ⌃⌘ for Tug, ⇧ for the counterpart, ⌥ for the variant), directional focus between cards, and a keyboard-focus mode where Tab walks a linear order and arrows move spatially.
- *Native menu bar:* the macOS menus are a projection of the command registry. Every menu item, chord and context menu goes through one funnel.
- *Setup wizard:* detects git, installs or updates Claude Code with a resumable verified download, signs you in, picks a project directory.
- *In-app updates:* Sparkle under Tug's own UI. A pill, a four-step wizard, and release notes rendered in the dialog.
- *Rate-limit notices:* one quiet notice per step as usage approaches the limit.

## The underpinnings

**Arcs: the model working alone, safely**

- *Worktree isolation:* an arc is a branch, a worktree, a record and an append-only log. The model's working root is the worktree and nothing else.
- *Two kinds of arc:* plain (brief, implement, audit) and planned (brief, devise, review, implement, audit). The axis is settling time, not size.
- *The wheel:* each stage runs on a fresh Claude session seated under the same card, so the plan is read cold by a session that did not write it. Context compaction and rotation happen between steps.
- *One step per turn:* a hook enforces it. A round is one commit plus one log line. The ledger is never hand-edited.
- *Replay onto a moving base:* when `main` moves, the arc's rounds replay in memory and swap in only if clean.
- *Join:* one squash commit on the base with a `Tug-Arc` trailer. Preflight names its blockers. Teardown is resumable.
- *Conflict ladder:* rerere, merge-file, a structured merge driver, a one-shot model scribe, then a multi-turn resolver in a workshop worktree.
- *Undo and redo:* join, replay and discard write an operation log first. Undo is compare-and-swap with named refusals.
- *Doctor:* compares the five records an arc keeps and names every disagreement.
- *Stops with a reason:* a stage that reaches a decision only you can make stops the arc with the question as its last note. You resume from the receipt.

**Change tracking and landing**

- *Attributed edits:* a machine-wide changes ledger records who changed which file and which lines, per session, per tool call. Git status decides what is dirty, so nothing dirty is ever invisible.
- *Three buckets:* attributed, foreign (another live session's) and unattributed. A default commit refuses to sweep in unattributed files.
- *Hunk-level contention:* two sessions editing the same file are told which regions overlap.
- *Maintained drafts:* a commit message draft per session or arc that fills in as work proceeds and is never overwritten once you edit it.
- *Landing is the user's act:* skills write drafts. Only you commit, push or join.

**tugtool: one CLI for the model and the human**

- *Edit programs:* a small transactional language (`replace`, `patch`, `insert`, `delete`, `move`, `sub` with count guards) that resolves every address against the original bytes, writes all or nothing, and reports every failure at once.
- *Receipted file verbs:* `file edit`, `rm`, `mv`, `cp`, `run` (formatters and codegen) and `probe` (patch, run, restore) each print a receipt so the ledger knows what moved.
- *Pre-tool-use gate:* refuses shell writes the ledger cannot read (heredocs, inline interpreters, globbed `sed -i`) and says what to write instead. Fails open, always exits zero.
- *Session reading:* find and show any session on the machine, read-only, by uuid or callsign.
- *Plan tooling:* lint a plan against the skeleton, stamp a review with a content hash.
- *Machine-wide gate:* mutual exclusion through a port bind, for serializing expensive runs.
- *JSON envelope:* one schema for every verb, stable issue codes, exit codes that mean the same with or without JSON.

**The agentless plugin**

- *Seven skills, no subagents:* arc (the door), devise, review, implement, audit, brief, draft. Each ships in the app bundle and works on any project with no checkout of Tug's own.
- *System-prompt fragments:* the work grammar, the file-editing contract, prose rules, tool-call rules, session references, landings and working rules ride every session.
- *Standalone contract:* lint and a test with an empty PATH guarantee the plugin depends only on itself and the bundle.

**Sessions and ledgers**

- *Callsigns:* every line of work gets a permanent adjective-noun name, never recycled. Commits cite them.
- *Session ledger:* never evicted automatically. Only trashing removes a row.
- *Session index:* machine-global, so a reference to a session recorded by another Tug instance still resolves.
- *Prompt history:* append-only, no retention policy, recall survives forks and resumes.
- *Test ledgers:* app-test and unit-test runs recorded per checkout, so a red file arrives with its own history.
- *Ledger reliability:* one opener, WAL, integrity check on open, quarantine and rebuild on corruption, a loud degraded banner, one writer process, versioned schemas, journal and snapshots for recovery.
- *External session adoption:* sessions started in Claude Code outside Tug can be picked up.

**Architecture**

- *tugcast:* a Rust WebSocket multiplexer carrying terminal, filesystem, git, changesets, Claude sessions, defaults, search, overview and heartbeat over one binary frame protocol.
- *tugcode:* the Claude Code bridge over stream-json. Respawn with resume on settings changes, permission relay, capabilities capture, replay of resumed transcripts.
- *tugproto:* one typed contract shared by deck and bridge, with structural decoders that name any drift.
- *tugways:* the component framework. Appearance in CSS and DOM, structure through external stores, actions routed up a Cocoa-style responder chain, state preserved across tabs, moves and reloads.
- *WASM in the browser:* markdown lexing and diffing in Rust compiled to WebAssembly.
- *Native host:* Swift app with a WKWebView, a supervised tugcast, a guarded bridge, native panels, Tug-to-Tug pasteboard, page-fault capture to a log, bundled tmux, login-shell PATH resolution.
- *App-test harness:* tests drive the real app through trusted native events. Selection is derived from `@covers` declarations and the session's own changes, runs serialize behind a machine-wide gate, and a wedged file is killed rather than waited on.
- *Signed and notarized:* Developer ID on every build, notarized releases, an EdDSA-signed appcast, release builds produced only by CI.
- *Open source and GPL-free:* MIT-licensed plugin, no GPL components shipped. Git comes from Apple.

## Things to check before this goes public

- *The Hello World card* is registered in production and not hidden.
- *The "no notifications" gap:* nothing uses macOS notifications. Rate-limit notices are in-deck only.
- *Verb naming drift:* the docs say `tugtool changes claim`, but the CLI defines `claim` and `disclaim` as top-level verbs.
- *Overview's Observer and Operator* are the least documented large feature. If they are shipping, they deserve a paragraph of their own in the essay.
- *The essay's "multi-session tracking, git worktree tools, file tracking, themes" sentence* undersells the list above. Arcs and attributed edits are the two features no other tool has and should lead.

Nothing was written to disk. If you want this as a file to iterate on, say where and I will put it there.
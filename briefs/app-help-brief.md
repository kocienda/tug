# In-app help: bundled docs, Help menu, and an Overview that answers questions about Tug

**Purpose:** Tug has a glossary and a feature guide in `docs/`, but nothing in the app can show them, and the Overview's Operator can only answer questions about the work, never about Tug itself. Bundle the two documents, link them from the Help menu as rendered cards, and give the Operator a way to read them.

---

## Purpose {#purpose}

The user wrote two documents, `docs/glossary.md` (every word Tug uses, one paragraph per term) and `docs/features.md` (each part of the app in turn, with its controls and chords), and asked for four things:

1. Suggestions to improve the documents.
2. Build or include the documents into the app so the Swift Help menu can link to them.
3. Make the documents available as supporting material to the Overview, whose prompt should be expanded to refer to that material to answer questions about the app and its features.
4. Change the Overview composer's placeholder to: *Ask Tug about how the app works or about your projects, recent or historical.*

The placeholder is the invitation: it tells the user that the Overview is the place to ask how the app works, so the Overview has to be able to answer.

---

## Evidence {#evidence}

**[F01] The Help menu has no door to any document.** `tugapp/Sources/MenuBarBuilder.swift` (around line 789) builds the Help menu with Keyboard Shortcuts & Commands (which opens the session card's `/help` sheet via `run-card-command`), Project Home and GitHub (which open URLs with `NSWorkspace`), and Capture Frames (Diagnostic). `NSApp.helpMenu` is set to it in `AppDelegate.swift`, so macOS supplies the Help search field over its item titles. **(verified)**

**[F02] The precedent for a menu item that opens a card is About.** `showAbout` in `AppDelegate.swift` sends a `show-card` control with `component: "about"` and a payload the About card reads. A help item should send the same control with a `help` component and a document name. **(verified)**

**[F03] The bundle copy phase is the place to ship the docs.** The Xcode "Copy Rust binaries, tugdeck dist, capabilities, and tugplug" shell script in `tugapp/Tug.xcodeproj/project.pbxproj` copies `tugplug/` into `Contents/Resources/tugplug`. tugcode resolves that directory beside its own binary (`tugcode/src/spawn-config.ts`), with a `TUG_PLUGIN_DIR` override for the dev harness. The same shape serves a `Contents/Resources/docs` directory. **(verified)**

**[F04] The Operator is a verb-naming retrieval loop, and every verb reads the project repo.** `tugrust/crates/tugcast/src/feeds/operator.rs` lists sixteen verbs in `VERB_NAMES` (overview, facts, shell, sessions, changes, git and repo families); `overview_agent.rs` carries two prompts, `OPERATOR_RETRIEVE_INSTRUCTIONS` and `OPERATOR_ANSWER_INSTRUCTIONS`, which list the same verbs, and a test pins the two lists together. The repo verbs read `bootstrap_project_dir`, the user's project, not the app bundle. Nothing in the pipeline can reach a bundled document today. **(verified)**

**[F05] The answer prompt's ref kinds are session, file, commit, plan and brief.** A ref pointing at a help document has no kind to wear, so a help answer could not link to the passage it rests on. **(verified)**

**[F06] `tugcast operator-ask` runs the real pipeline from a terminal.** `feeds/operator_ask.rs` takes a ledger copy and a question and prints every verb chosen and the answer. It builds the same `OperatorContext`, so anything the context gains (a docs directory) is one argument away from being testable by command. **(verified)**

**[F07] The placeholder is one expression.** `tugdeck/src/components/overview/overview-card.tsx` line 2397: `pending ? "Waiting for an answer…" : "Ask Tug about your work, recent or historical"`. **(verified)**

**[F08] A rendered markdown view already exists.** `tugdeck/src/components/tugways/tug-markdown-view.tsx` and `tug-markdown-block.tsx` render markdown in the house style; the text card is a CodeMirror editor and would show a document as raw markdown. **(verified)**

**[F09] The docs name one voice where the app has two.** The Overview card labels posts "Observer" and "Operator" (`overview-card.tsx` lines 236 to 237) and the Rust prompts are split the same way: the Observer narrates, the Operator answers. The glossary's Observer entry and the features document both say the Observer answers questions, and neither has an Operator entry. **(verified)**

**[F10] The glossary italicizes *artifact ladder* twice with no entry for it,** and the features document uses permission mode, the command picker and dictation without glossary entries. **(verified)**

**[F11] The chord table and the slot count may disagree.** `features.md` says ⌘1 through ⌘9 move a card and ⌃⌘1 through ⌃⌘6 go to a slot, while slots run one to six. Not checked against `command-registry.ts`; the arc should check and correct whichever side is wrong. **(not verified)**

**[F12] `docs/` is untracked.** `git status` shows `?? docs/`. The documents are not yet in the repository. **(verified)**

---

## Decisions {#decisions}

**[B01] The docs ship inside the bundle at `Contents/Resources/docs/`, copied by the same phase that copies tugplug.** The standalone contract (`tugplug/CLAUDE.md`) says everything the app needs on a stranger's project is inside the bundle; help is no exception. They are a directory of their own, not part of tugplug, because they are the app's help and not the session plugin's instructions. tugcast resolves the directory beside its binary the way tugcode resolves the plugin, with a `TUG_DOCS_DIR` override for dev launches from a checkout. `docs/` is tracked in the repository as part of this work.

**[B02] tugcast serves the documents, and the help card fetches them.** One resolver feeds both the card and the Operator, so the two can never read different files. The alternative, Swift reading the file and passing the text in the `show-card` payload, would leave tugcast without the directory the Operator needs anyway.

**[B03] Two Help menu items, "Tug Help" and "Glossary", at the top of the menu.** Then the existing Keyboard Shortcuts & Commands item, a separator, and the rest as today. Each sends a `show-card` control with a `help` component and the document name, mirroring About [F02]. The titles were settled with the user.

**[B04] A help card is a new card kind: rendered markdown, read-only, keyed per document.** It uses the existing markdown view [F08], takes its title from the document's heading, opens in the active pane and closes with ⌘W like About, and a second pick of the same item brings the open card forward rather than opening another. Links between the two documents open the other help card; `#anchor` links scroll. A read-only text card was rejected because it shows raw markdown.

**[B05] The Operator gains a `help` verb family that reads the bundled docs: `help.outline`, `help.read`, `help.search`.** `help.outline` returns the features headings and the glossary's term list. `help.read` returns one glossary entry, one features section, or a whole document. `help.search` is full text across both and returns whole entries and sections. They join `VERB_NAMES`, both prompts, and the pinning test [F04]. Verbs rather than inlining the documents, because the pipeline already runs up to three model rounds per question and 46 KB of prose on every round is the wrong price; and because the existing design is retrieval, so this is the same design extended.

**[B06] The retrieval prompt says the Overview answers two kinds of question, and app questions come from the help verbs, never from memory.** The prompt also inlines the glossary's bare term list (about 120 words) so round one names the right `help.read` target. The answer prompt gains a `help` ref kind whose target names a document and an entry or heading, which the Overview card renders as a link that opens the help card at that place [F05].

**[B07] `tugcast operator-ask` takes a `--docs-dir`.** Then "what is a split slot?" is a command-line check against a real ledger copy, in the same instrument that already checks work questions [F06].

**[B08] The glossary stays one paragraph per term and the feature guide stays section-shaped.** The paragraph is the glossary's retrieval unit for `help.read` and `help.search`; the heading is the feature guide's. Neither document is restructured for the machine.

**[B09] The documents get these edits as part of the arc.** Add an **Operator** entry and trim the Observer entry to narration, in both documents [F09]. Add entries for artifact ladder, permission mode, command picker, dictation, and Help [F10]. Add a closing "Getting help" section to `features.md` naming the Help menu items, ⌃⌘K, the `/help` sheet, and the Overview composer. Settle the ⌘1 to ⌘9 row against the command registry [F11].

**[B10] The placeholder becomes "Ask Tug about how the app works or about your projects, recent or historical."** The `pending` branch is unchanged. Any app-test asserting the old text moves with it [F07].

---

## Open Questions {#open-questions}

None that change what gets written. The menu titles and the Overview-only scope were settled with the user.

---

## Non-goals {#non-goals}

- **The session model does not get the glossary.** The user ruled this out: help questions go to the Overview, which is what the placeholder invites. No change to tugplug or to any session prompt.
- **No help search over document content from the Help menu.** macOS searches item titles; searching the prose is the Overview's job.
- **No new help prose.** The two documents are the help. Other surfaces (the `/help` sheet, the Keyboard Shortcuts card, About) are untouched beyond being named in the new "Getting help" section.
- **No docs lint in this arc.** A `just docs-lint` that checks italicized glossary words against entries and the chord table against `command-registry.ts` was raised in the sketch and is worth a later piece of work, not this one.

---

## Exit {#exit}

An arc. The shape of the first steps, in the order they have to land:

1. Track `docs/` and make the document edits [B09], [B10]'s placeholder beside them.
2. Bundle and resolve: the copy phase, the `TUG_DOCS_DIR` override, and a tugcast route serving the documents [B01], [B02].
3. The help card kind in tugdeck and the two Help menu items in Swift wired to it [B03], [B04].
4. The `help` verbs, the two prompt changes, the `help` ref kind and its rendering, the pinning test, and `operator-ask --docs-dir` [B05], [B06], [B07].

Steps 3 and 4 both depend on 2 and are independent of each other.

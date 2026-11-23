# A docket is one line of work, in its own card

**Purpose:** The docket was built as a list of many separate lines of work with a list of ideas beside it, reachable only through a tab bar's `+`. The user wants one concept: a docket, made by File ▸ New Docket, opened in its own card, holding everything one line of work produces.

This brief revises the docket as built by `briefs/docket-record-and-card-brief.md`, `briefs/docket-authoring-brief.md` and `briefs/docket-loop-brief.md`. Where it disagrees with them, this one wins, and the Decisions say which of theirs it reverses.

---

## Purpose {#purpose}

After the four docket arcs landed, the user asked "*where* is the docket card and how do I use it?" The answer was the `+` on a pane's tab bar: "Tab bar? Seriously? No. It can't be that. We need to do ***wayyyyy*** better for this feature."

The user then set the model: "*Docket* is the concept here. It is the construct that encompasses an idea, a project, the sessions, the brief, arcs, commits, everything. The menu item should be File > New Docket." Dockets live in cards, with a custom card type, and are not a sidebar construct. The word *thread* is not to be used, and an idea is not a top-level concept. Jots have nothing to do with dockets.

The user also wants membership to show: "the session callsign could expand to be a more URL-like entity … Something like: session-name$feature-docket^arc-name."

---

## Evidence {#evidence}

**[F01] The Docket card has no menu row and no chord.** `tugdeck/src/components/docket/docket-card-registration.tsx` registers it as an ordinary deck card in the type picker under "Files". Nothing in `tugapp/Sources` names it. The picker is the tab bar's `+`, and `tugdeck/src/components/chrome/pane-chrome.tsx` draws a tab bar only when a pane holds more than one tab. The other two ways in, a docket atom and the arc shade's docket line, need a docket to exist already. **(verified)**

**[F02] A docket as built holds many lines of work.** `DocketEntry` in `tugdeck/src/lib/docket-types.ts` carries `threads: DocketThread[]`, each with its own idea, sketch, brief, arc, sessions and commits. The card's header has a chooser that switches between dockets inside one card. **(verified)**

**[F03] An idea was built as its own object.** It has a record, an atom, an `@`-completion provider (`tugdeck/src/components/tugways/cards/completion-providers/idea-mentions.ts`), and `tugtool idea show|list`. The card's top field captures one on Return and lists unstarted ones first. **(verified)**

**[F04] The retired words are written into shipped documents.** `tugplug/arc-references.md`, `docs/glossary.md`, `tuglaws/entity-presentation.md`, `tuglaws/work-grammar.md` and `tugplug/work-grammar.md` all describe ideas as objects, and the first three describe threads. **(verified by count; not read line by line)**

**[F05] ⇧⌘N is free.** `tugapp/Sources/MenuBarBuilder.swift` binds ⌘N to New Session and ⌥⌘N to New Text File. ⇧⌘N appears in neither the menu builder nor the chord table in `tuglaws/menus.md`. **(verified)**

**[F06] An arc already wears a sigil.** `tugdeck/src/components/tugways/arc-sigil.tsx` draws every arc name with a leading `^`. A session is spelled `project/callsign`, and `Reference::parse` in `tugrust/crates/tugcore/src/session_finder.rs` splits at the last `/` and accepts only a callsign shape after it. **(verified)**

**[F07] `$` is eaten by the shell.** Unquoted, `echo mighty-cabin$feature-docket^arc-name` prints `mighty-cabin-docket^arc-name`: the shell reads `$feature` as a variable. `+` in the same place passes through unchanged. **(verified by running both)**

**[F08] Every docket gesture opens a fresh Session card.** Keep sketch, Write brief, Revise brief, Open arc and Reopen arc each open a new session whose first turn is the plugin command (`docket-card.tsx`, header comment). **(verified)**

---

## Decisions {#decisions}

**[B01] A docket is one line of work.** It holds the text that says what is wanted, a sketch, a brief, the arcs opened on that brief, the sessions that did the work, and the commits that landed. This reverses [B08] of `briefs/docket-record-and-card-brief.md`, which showed a docket as many separate lines of work ([F02]).

**[B02] The vocabulary is docket, sketch, brief, arc, session and commit.** The word *thread* is not used for anything in this feature, in the interface, the documents or the code's public names. Jots are unrelated and are not mentioned beside dockets.

**[B03] What is wanted is the docket's first field, not an object.** This reverses [B01] and [B02] of `briefs/docket-authoring-brief.md`. The idea record, its atom, its completion provider and `tugtool idea` are removed ([F03]); the text moves onto the docket. The install base is zero, so existing idea records are dropped, not migrated.

**[B04] One Docket card shows one docket.** The card keeps its custom card type. The header's chooser goes ([F02]); a card is bound to its docket for its life.

**[B05] File ▸ New Docket, ⇧⌘N, makes a docket and opens its card.** The cursor is in the first field. The docket takes its name from that text and can be renamed ([F05]).

**[B06] File ▸ Open Docket lists the checkout's dockets.** Choosing one raises its card; a card already showing it is brought forward and never duplicated. Retired dockets are reachable from the same list.

**[B07] The card is the opening text over three panels: Sketch, Brief, Arc.** Each panel carries its own gesture. Sketch opens a session whose first turn is the opening text, and Keep Sketch puts the result on the card, where it can be read and edited by hand. Write Brief becomes Revise Brief once one exists. Open Arc shows the arc's steps as it runs. Stale markers, sketch versions, the successor arc, parked arcs and Revert stay as built.

**[B08] Results come back to the same card.** A landed arc shows its commit. The card marks what is waiting on the user: an arc ready to join, an arc that stopped to ask, and a running arc whose brief has moved.

**[B09] An audit's follow-ups are offered as new dockets.** Accepting one makes a docket whose opening text is the follow-up, linked to the docket it came from. This replaces the proposals that became ideas in `briefs/docket-loop-brief.md` [B09].

**[B10] Membership shows in the object's own name.** A session, arc or commit on a docket is spelled with its docket, and its arc where it has one, after its own name: the user's form is `session-name$feature-docket^arc-name`. The object named comes first and its context trails.

**[B11] Own name first, context after, because a name is cut from the right.** A pill that runs out of room keeps what identifies the object and loses the context. Docket-first would start every atom on a docket's own card with the same word and cut the part that tells them apart. The context runs from the outer container to the inner: docket, then arc.

**[B12] The own name alone resolves; the context is information.** A reference is found by its head, as it is today. A context that has gone stale, because the object was moved to another docket, still resolves and is shown with its current context. `Reference::parse` learns to read past the context ([F06]).

**[B13] The full spelling is the citation; a surface may show less.** Copy writes the full form, and the reference block the model reads carries it. Inside a docket's own card the docket part is dropped, since every row would repeat it. A Session card working on a docket shows the docket in its identity, and pressing it opens the Docket card.

**[B14] The documents are corrected in the same arc.** Every shipped document that describes threads or ideas as objects ([F04]) is rewritten to this model, the plugin's prompt files first, since those reach every project.

---

## Open Questions {#open-questions}

- **The docket's sigil.** The user wrote `$`. The shell deletes it from an unquoted spelling ([F07]), which matters because these names are typed into `tugtool` commands by the user and by the model. `+` survives the shell and reads as "plus its context": `mighty-cabin+feature-docket^arc-name`. The recommendation is `+`. If `$` is kept, every command that takes a reference must be documented as needing quotes, and the model's prompt file must say so.
- **Where the gestures run.** Keep Sketch and Write Brief open a fresh session today ([F08]). The session that held the conversation has the context and would write the better brief. Whether those two act in that session when it is live is undecided.
- **Dockets that already hold several lines of work.** With no installs, the simple answer is to split each into its own docket on first read, or to drop them. This checkout has some from testing the feature.

---

## Non-goals {#non-goals}

- **A docket in the sidebar.** The user ruled that dockets are cards with their own card type.
- **An idea as a top-level concept.** Ruled out by the user; see [B03].
- **The word thread.** Ruled out by the user; see [B02].
- **Any tie to jots.** They are separate features.
- **A global capture field or a second chord for it.** It was proposed and dropped with the idea object.
- **Widening the arc shade to show a docket.** Proposed and dropped: the Docket card is where the panels live, and the Session card shows a door to it ([B13]).
- **Docket-first spelling.** Considered and rejected by [B11].

---

## Exit {#exit}

**An arc.** Its parts, in this order:

1. The record: a docket holds one line of work and its opening text; the idea record and its verbs are removed.
2. The card: one docket per card, the opening field over the three panels, the chooser removed.
3. The doors: File ▸ New Docket on ⇧⌘N, File ▸ Open Docket, and the docket shown in a Session card's identity.
4. The spelling: the context after an object's own name, in atoms, in Copy, in the reference block and in the resolver, once the sigil is settled.
5. Follow-ups as new dockets, and the document corrections.

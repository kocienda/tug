# The brief hand-off offers three ways to run the brief as an arc

**Purpose:** Writing a brief ends with a bare path, and running it as an arc means reconstructing `/arc <name> @<path>` by hand in a card of the user's choosing. The hand-off should offer that gesture three ways: run it here, run it in a new session, or copy the command to run somewhere the user has configured first.

---

## Purpose {#purpose}

The user's words: "When we write a brief, I think we should offer an easy way to run that brief in an arc, with three options: run in existing session, run in new session, copy arc command so I can run that in a session where I want, assuming that I want to configure that session in some way before kicking it off."

The `tug/satiny-disk` session is the record of the gap. `/tugplug:brief` wrote `briefs/session-minimize-reveal-brief.md` and ended with the path and one sentence. Three minutes later the user typed `/arc ses-min-reveal @briefs/session-minimize-reveal-brief.md` by hand in the same card. The name, the `@` atom, and the choice of card were all theirs to rebuild from nothing the skill had offered.

---

## Evidence {#evidence}

**[F01] The `/arc` door is a model judgment, not a server verb** — `tugplug/skills/arc/SKILL.md` settles the name (grammar rule 1: a handed-in path's stem with `-brief` stripped), copies the brief into `.tug/arcs/<name>/`, reads the brief and the code it names to decide plain versus planned, writes the task list when plain, and only then runs `tugtool arc run`. Every route onto an arc from a brief in `briefs/` must therefore end in the prompt `/arc <name> @<path>` submitted to some session. **(verified)**

**[F02] The Arcs card's Start button is the wrong shortcut for this** — [D178] gives an arc with a document on disk and no run a Start face that fires the server's `arc_run` directly. That reaches only briefs already inside `.tug/arcs/<name>/`, skips the door's kind decision, and opens every such arc as planned at devise, because a brief alone is what the engine reads as the planned shape. Nothing reaches a file in `briefs/`. **(verified)**

**[F03] A `/arc …` line in the transcript is already a `slash-command` entity** — `tugdeck/src/lib/annotator/payloads.ts` parses one to `{ name, args }` and `tugdeck/src/lib/annotator/registry.ts` registers the kind with a primary click that seeds the composer (`seedCommand` → `insertCommandDraft`) and a menu of `Copy Command`, `Copy Command as Plain Text`, and `Insert into Prompt`. The `Copy Arc Command` option is one of those items already; it only needs the skill to print the line. **(verified)**

**[F04] Seeding is not submitting** — `tug-prompt-entry.tsx` consumes `pendingCommandInsert` by restoring the editor state to the command atom plus its args and focusing the editor. The draft is left for the user to send. There is no store method that seeds and submits in one act. **(verified)**

**[F05] The menu already has the dim-with-reason shape** — `AnnotationMenuEntry.disabled` renders an item present but non-interactive, and the registry's doc states the rule: an item a surface cannot perform right now is dimmed, never dropped, so the menu's height does not change between right-clicks. `AnnotationMenuFacts` is the discriminated bag of live facts a surface hands the menu builder; it carries `session` and `commit-sha` cases today and none for `slash-command`. **(verified)**

**[F06] A new Session card on a project is a two-step spawn with nowhere to put a first prompt** — `action-dispatch.ts` adds a card with `deckManager.addCard("session")`, the picker's `onOpen` resolves `(projectDir, mode, sessionId)`, and `fireFreshSpawn` in `lib/session-restore.ts` sends `spawn_session(mode=new)` and registers a restore hold until the binding arrives. Only the wheel's rotation carries an opening prompt on the wire, as `SessionStageSpec.prompt` on `session_command`, and that shape is documented as absent on every deck-originated command. **(verified)**

**[F07] The deck already has a home for a message that must outlive the store that queued it** — `stashQueuedSends` / `drainQueuedSends` in `lib/session-restore.ts` hold a card's queued sends across a store dispose and drain them into the replacement store, keyed by card id, bounded to the app session. A first prompt for a card whose session is not yet bound is the same shape: a send that waits for the binding. **(verified)**

**[F08] The composer's submit path already routes `/arc` to claude** — `lib/slash-supported.ts` classifies a name that is neither local nor hidden as pass-through, and at submit the card refines it against claude's reported catalog; `/arc` is a plugin skill claude reports, so it is sent verbatim and runs a real turn. No new submit semantics are needed for the command itself. **(verified)**

**[F09] The brief skill's hand-off names the path and stops** — `tugplug/skills/brief/SKILL.md`, "Hand off": name the path you wrote and stop; what happens next is the user's call. The skill is standalone plugin content and must say nothing Tug-specific beyond what the bundle carries. **(verified)**

---

## Decisions {#decisions}

**[B01] Go simple: no bespoke receipt block, no new `tugtool` verb, no server-formatted line.** The hand-off is the `/arc <name> @<path>` line the skill prints, and the three verbs ride the `slash-command` entity's existing context menu. A parsed receipt block on the model of `session-arc-receipt-block.tsx` was sketched and set aside for now; it can be built later on top of this without undoing any of it. The user's call, 2026-09-12.

**[B02] The brief skill prints the arc command as its last line, with the name proposed by the door's own rule.** The line is `/arc <slug> @<path>` where `<slug>` is the filename's stem with a trailing `-brief` removed, which is exactly what `/arc` grammar rule 1 would derive from the path alone. Printing it makes the proposed name visible and editable before anything runs. The skill still opens nothing; a line of text is not an act.

**[B03] The `slash-command` menu grows three entries: `Run Here`, `Run in New Session`, `Copy Arc Command` is the existing `Copy Command`.** The entries are general to every slash-command atom, not special-cased to `/arc`; a brief is the first customer, not the only one. `Copy Command` already exists and is not duplicated. The menu keeps its fixed order per [D122]'s companion rule in the registry: reach it, take it, send it.

**[B04] `Run Here` submits.** It seeds the command draft the way the primary click does and then submits it as the next turn of the card the atom sits in. A seeded-but-unsent composer is the same reconstruction the verb exists to remove, and `Copy` already covers the case where the user wants to touch the prompt first. Confirmed by the user.

**[B05] "Here" is the card that wrote the brief, always.** The entry acts through the surface's own `PromptInsertTarget`, which is the card's composer. It never raises another card or picks a session. Confirmed by the user.

**[B06] `Run in New Session` opens a new Session card, never a rotation on this card.** The wheel's rotation could put a fresh session on this card at the turn's end with a prompt, but that reads as the wheel driving something no arc has bound yet, and it ends this card's transcript, which the user may still be reading. The new card opens on the same project as the originating card, next to it, flashed the way `resume-session` flashes its answer, and submits the command as its first turn. Confirmed by the user.

**[B07] The first prompt of a new card is a deck-side queued send, not a wire field.** Per [F06] the wire's opening prompt belongs to rotations and is documented as absent on deck commands; adding a deck variant would blur that line. Per [F07] the deck already holds sends for a card whose store is not yet live. So the new card's first prompt is stashed against the new card id and drained into its store once the binding arrives, then submitted through the same pass-through path as any typed `/arc`.

**[B08] Entries dim with a reason when stale, never vanish.** Per [F05] a menu's height is constant per surface. The two `Run` entries dim when the surface has no composer to run in, which is the rule `Insert into Prompt` already follows, and when the command's args carry a file path that no longer resolves. An arc that already exists is not a staleness case: the door treats `/arc <existing-name> …` as a continuation and says where it stands, which is better than a dimmed row. So staleness reduces to one file check, carried in a new `slash-command` case of `AnnotationMenuFacts`.

**[B09] The skill change is plugin content and says nothing Tug-specific.** The printed line is a plain prompt any claude session can take. Which menu the deck hangs on it is the deck's business, and the standalone contract in `tugplug/CLAUDE.md` is untouched.

---

## Open Questions {#open-questions}

- **How the `@<path>` in the printed line becomes a file atom in the seeded draft.** `seedCommand` seeds `name` and `args` as text after a command atom. Whether the prompt entry's own atomization turns `@briefs/x-brief.md` into a file atom on restore, or the args need to be seeded with the atom segment explicitly, is settled by reading `buildEditingStateFromDraftRestore` at implementation time. It changes how the seed is built, not what gets built.

---

## Non-goals {#non-goals}

- **A Start button on files in `briefs/` in the Arcs card.** That is the `arc_run` shortcut of [F02] and would skip the door.
- **Any change to the door's plain-versus-planned judgment, or to where a brief is written.** The three verbs deliver a prompt; what the prompt does is unchanged.
- **Auto-running.** Writing a brief never opens an arc. The skill's promise stands.
- **A `TUG-BRIEF-RECEIPT` line and a parsed receipt block.** Sketched, set aside by [B01]. Not rejected forever, deferred.
- **A rotation on the originating card.** Rejected by [B06].
- **An opening-prompt field on deck-originated `session_command` or `spawn_session`.** Rejected by [B07] in favour of the deck's own queued-send home.

---

## Exit {#exit}

An arc. The first steps, in the order they depend on each other:

1. The brief skill's hand-off prints `/arc <slug> @<path>` as its last line, slug derived per [B02]. Plugin-only, no deck dependency, verifiable in `tug/satiny-disk`'s own shape by writing any brief.
2. `slash-command` gets an `AnnotationMenuFacts` case carrying whether the args' file path resolves, and its menu grows `Run Here` and `Run in New Session` per [B03] and [B08], dimmed on the two conditions. `Copy Command` stays as it is.
3. `Run Here`: seed through the surface's `PromptInsertTarget` and submit, per [B04] and [B05]. The one open question above is answered here.
4. `Run in New Session`: an action that adds a session card beside the originating one on the same project, fires the fresh spawn, and stashes the command as the new card's first send, drained and submitted on binding, per [B06] and [B07].
5. The unit and app-tests the touched files' `@covers` lines select, plus one app-test per verb on a transcript that carries a `/arc` line.

<!-- brief-skeleton v1 -->

# Tripwires card: say what a tripwire does in a sentence, and let it be deleted from the card

**Purpose:** The Tripwires card's definition rows lead with "Asks the AI to" and print the whole brief, which is the prompt a trip runs on and not a thing a person reads on a sidebar. The brief leaves the card entirely and a one-sentence, human-written description takes its place. And the card offers no way to remove a tripwire: `tugtool tripwire rm` is the only door, which contradicts the rule that the terminal is never required. The card gains a Delete verb behind a confirm.

---

## Purpose {#purpose}

The user's notes, after `briefs/tripwires-multi-phase-brief.md` closed with phase 7:

> The *Asks the AI to* section is far too voluminous to show to the user. It's an AI prompt, not a human-readable string that can be understood and absorbed by a user. We need to hide this from the UI completely, and replace it with a description of what the tripwire does that is tailored for human consumption.

> There should be a way to delete/trash a tripwire directly from the Tripwires sidebar card. Clicking the delete should offer a confirm-popover.

The screenshot that prompted the first note is the `ci` tripwire's fold: six short rows, then a brief of roughly four hundred words behind a two-line clamp that, once opened, fills the whole card with instructions addressed to the model ("Resolve `--quiet` when…", "Add `--author` only for…"). Nothing on that surface tells the reader in one line that this tripwire runs `just lint` after each landing on `main` and raises its hand only when the landing broke it.

---

## Evidence {#evidence}

**[F01] The card's "Asks the AI to" row is the brief, whole, and the brief is the prompt.** `tripwireDefinition` in `tugdeck/src/components/tripwires/tripwire-presentation.ts` emits seven rows; the fifth is `{ label: "Asks the AI to", value: tripwire.brief.trim(), clamp: true }`, and the `Definition` component in `tripwires-card.tsx` renders that one row inside a `TugClamp` with a More/Less reveal. On the engine side, `tripwire_dossier.rs` opens both the diagnosis prompt and the authoring prompt with `brief.trim()` as the first thing the model reads. The brief has exactly one consumer that is not a display: the model. **(verified)**

**[F02] The ledger has no field that describes a tripwire for a person.** `CREATE_TRIPWIRES_SQL` in `tugrust/crates/tugtool-core/src/tripwire_ledger.rs` carries `name`, `trigger`, `scope`, `probe`, `brief`, `model`, `permission_mode`, `paused`, `branch`. `TRIPWIRE_SCHEMA_VERSION` is 6. Every other definition row on the card is derived in English from an enum or a path (`describeTrigger`, `describeScope`, `describeProbe`, `describePermissions`); the brief is the one row with no derivation because it is free text. A description has to be a new column, and the doctrine for this ledger is a version bump with a registered migration, never a DDL edit. **(verified)**

**[F03] The brief is authored by the `/tripwire` skill, which already writes to two readers.** `tugplug/skills/tripwire/SKILL.md` tells the AI to write the brief "as a question, not an instruction" for the model, and separately, under "Write the brief for the reader of the headline", to think of the person who "saw none of what the tripwire saw". The skill is the only door to laying a tripwire ([D192]); `tugtool tripwire lay` requires `--on` and `--brief`, and `edit` takes the same flags plus `--clear scope|probe|model`. The skill, not the card, is where a description would be composed, and the user's own sentence to the skill ("tell me when the build breaks") is usually the description already. **(verified)**

**[F04] The doctrine already says the card reads the definition back in English, and the brief is where that promise is not kept.** [D192] and `tuglaws/tripwires.md`: the card "reads the definition back in English rather than in the enums the ledger holds". The trigger, scope, probe and permissions rows do that. The brief row prints the ledger's bytes. The app-test `tests/app-test/at0492-tripwires-card.test.ts` pins the current behaviour: it lays a five-sentence `LONG_BRIEF` and asserts the fold contains its last sentence and mounts no tooltip. That pin was made against the wall-of-text tooltip it replaced, not against a description row, and will be re-pointed rather than kept. **(verified)**

**[F05] `RosterRow` carries the brief to three callers through one projection.** `tugtool_core::tripwire_roster::RosterRow` is what the request surface, the `TRIPWIRES` feed and `tugtool tripwire list` all serialize, and `brief` is one of its fields. The doctrine ("One projection, three callers") is that the three cannot disagree. Removing the brief from the projection to hide it from the card would also remove it from `list --json`, which the skill reads during revision. **(verified)**

**[F06] Removal exists only as a CLI verb, and it is one unguarded DELETE.** `ledger::remove` in `tripwire_ledger.rs` runs `DELETE FROM tripwires WHERE name = ?1`; trips and marks cascade. `run_rm` in `tugrust/crates/tugtool/src/tripwire.rs` calls it and then `bump_live_instance()`, which is a `tugtool tell tripwire_bump` so a live deck re-reads the roster. No HTTP route removes a tripwire: `server.rs` mounts `GET /api/tripwires`, `POST /api/tripwires/{name}` (knobs: `paused`, `model`), `GET …/trips`, `POST …/trip`, `POST …/dismiss`. `tripwires-store.ts` has `setKnobs`, `trip`, `dismiss` and nothing that removes. **(verified)**

**[F07] Nothing checks for a live trip before removal.** `ledger::remove` does not read `trips`, and `run_rm` does not consult the roster projection. A tripwire with a `running` trip has a headless session working in an inspection tree and a claimed row; one with an `awaiting` trip holds an arc named `tripwire-<name>-<key8>`. What the engine does when the row under a running trip cascades away, whether the settle path errors on a vanished trip id or the arc is orphaned, was not traced. **(not verified; the arc reads `run_pending` and the settle path before choosing how to guard)**

**[F08] The row's verbs live on a right-click menu with no visible door, and the card has the two confirm precedents it needs.** `useTripwireRowVerbs` mounts a `TugEditorContextMenu` on `onContextMenu` only; the row's visible controls are the pause/resume icon button and the fold cue. The Arcs card put its rare destructive verb, Discard, behind a visible `⋯` on the row's second button ([D142]: "the rare verbs go behind a `⋯`"), and raises one controlled `TugConfirmPopover` for the whole card with `confirmRole="danger"` (default focus on Cancel), `side="top"`, anchored to the row cell rather than the menu item because the menu unmounts on selection. The Jots card does the same over its per-row ✕. Both are in `tugdeck/src/components/tugways/tug-confirm-popover.tsx`. **(verified)**

**[F09] The card's roster updates without the card asking.** The `TRIPWIRES` feed re-composes on the ledger's `PRAGMA data_version`, with bumps as latency only. A removal committed through any door drops the row from the next snapshot; the card needs no local delete of its own state. **(verified, `tuglaws/tripwires.md`, "The observation model")**

---

## Decisions {#decisions}

**[B01] A tripwire carries a `description`: one sentence, written for the person reading the card.** A new `description TEXT NOT NULL DEFAULT ''` column on `tripwires`, `TRIPWIRE_SCHEMA_VERSION` bumped to 7 with a registered migration. It is the human-facing counterpart of the brief, not a summary derived from it: the brief is written to the model as a question, the description is written to the reader as a statement of what the tripwire does and when it will speak ("Runs `just lint` after every landing on `main` and reports which check went red and whether the landing broke it"). It joins `RosterRow` so the three callers stay one projection [F05].

**[B02] The migration backfills the first sentence of the brief, and the skill writes a real description from then on.** The install base is zero and this machine has two tripwires, so a backfill exists to keep the card sensible on the next launch rather than to be permanent. `lay` gains `--description` and refuses without one, on the same footing as the brief's placeholder guard: a tripwire nobody can describe in a sentence is a tripwire nobody will recognise on the card. `edit --description` rewrites it; it is not `--clear`-able. The `/tripwire` skill composes it from the user's own sentence, states it in the receipt, and says it is the line the card shows.

**[B03] The brief leaves the card entirely.** The "Asks the AI to" row and its clamp are removed from `tripwireDefinition` and `Definition`; no More/Less, no tooltip, no secondary reveal. The user's call was "hide this from the UI completely", and a fold-within-a-fold would be the same wall one click further away. The brief stays in the ledger, in `RosterRow`, and in `tugtool tripwire list --json` and `log`, which is where the skill reads it during revision [F03]. The card never renders `brief`, and the app-test pins that it does not.

**[B04] The description is the definition's first row, under a plain label.** The rows become: description, Watches for, Lands on, In, Runs first, Model, Permissions. The label is a plain word the reader does not have to decode; "What it does" is the working choice and is the arc's to keep or improve. It is not clamped and not mono: one sentence at the rail's measure, in `TugLabel size="2xs"` like its neighbours.

**[B05] Delete is a verb on the row, behind a visible `⋯`, and the row's context menu gains it too.** The row grows a `⋯` icon button in `tripwires-controls` beside pause and the fold cue, opening the same `TugEditorContextMenu` the right-click already opens, so there is one menu with one item list. Delete is its last item after a separator, labelled `Delete`. This follows [D142]: a destructive verb that is real and almost never pressed belongs behind a menu, not standing on the row as a peer of pause. A per-row trash icon was considered and rejected for that reason. The verb is a registered `TUG_ACTIONS.DELETE_TRIPWIRE` on the row's responder, so the keyboard reaches it the way it reaches Pause and Release.

**[B06] Delete raises one controlled `TugConfirmPopover` for the whole card, in the Arcs card's shape.** `confirmRole="danger"` so Return cannot delete, `confirmLabel="Delete"`, `side="top"`, anchored to the row's list cell and never to the menu item [F08]. The message names the tripwire and what goes with it: `Delete <name>? Its trip log goes with it.` Cancel, outside click and Escape dismiss; nothing is remembered across a dismissal ([L24]).

**[B07] Removal goes through an HTTP verb the card and the CLI both stand on, and the guard for a live trip lives once.** A loopback `DELETE /api/tripwires/{name}` in `tripwires_api.rs`, a `remove(name)` on `tripwires-store.ts`, and no local state change: the feed drops the row [F09]. The CLI's `run_rm` and the endpoint call the same core operation, and that operation is where the live-trip rule is enforced so the two doors cannot disagree. The rule: **a tripwire with a running trip cannot be deleted**, and the menu item carries its refusal in its own label (`Delete — a trip is running`), per [D142] and [L31]; **a tripwire with an awaiting trip can be**, and the confirm says so (`… Its trip log goes with it, and the arc it is holding is discarded.`), performing the existing dismiss first so the arc is discarded through the path that already knows how. The CLI states the same refusal in its error.

**[B08] The tests move with the surface, and the doctrine is amended.** `at0492` stops asserting the brief's last sentence and asserts instead that the description is shown, that the string "Asks the AI to" and the brief's text are absent from the card, that `⋯` opens the menu, that Delete arms the confirm, that Cancel leaves the row and Confirm removes it, and that the disabled label appears while a trip is running. `tripwire-presentation.test.ts` covers the new row order. `tripwire_cli.rs` covers `lay --description`, the refusal without one, `edit --description`, and `rm` refused on a running trip. `tripwires_api.rs` covers the endpoint. `tuglaws/tripwires.md` and [D192]'s verb list gain Delete and say the card shows a description and never the brief.

---

## Open Questions {#open-questions}

- **What happens to a running trip whose tripwire is removed from under it by a door that races the guard?** [B07] refuses removal while a trip runs, but the check and the DELETE are two statements, and `tugtool tripwire rm` from another process can land between a claim and the guard. The arc reads the engine's settle path [F07] and decides whether the guard needs to be one statement (a `DELETE … WHERE NOT EXISTS (running trip)`) or whether a settle against a vanished row is already harmless.
- **Is a first-sentence backfill good enough for `edits` and `ci` on this machine?** The user can `edit --description` either one after the migration; the question is only whether the arc should do that as part of landing, given both tripwires are the user's own.

---

## Non-goals {#non-goals}

- **A More/Less, tooltip, or secondary reveal for the brief on the card.** Rejected: the ask is to hide it completely, and every reveal is the wall of text one gesture away [B03].
- **Deriving the description from the brief at read time.** Rejected: a heuristic first sentence of a prompt written as a question reads as a question, and the card would be showing the model's instructions again with the seams hidden. The description is authored [B01].
- **Dropping `brief` from `RosterRow`.** Rejected: it would take the brief out of `list --json`, which the skill reads, to hide it from one surface that can simply not render it [F05].
- **A trash icon standing on every row.** Rejected under [D142]; rare destructive verbs go behind a `⋯` [B05].
- **A lay or edit form on the card for the description.** The card still grows no form ([D192]); the description is authored and revised through the skill like every other definition field.
- **Force-deleting a running tripwire from the card.** Rejected: the refusal is stated in the item's label, and the user can open the session or wait. If a stuck trip turns out to be common, that is the engine's problem to fix, not a reason to widen the delete.

---

## Exit {#exit}

**An arc.** The shape, in the order the pieces depend on each other:

1. The ledger: `description` column, migration with first-sentence backfill, `TRIPWIRE_SCHEMA_VERSION` 7, `RosterRow.description`, `lay --description` with its refusal, `edit --description`, and the guarded core `remove` that both doors will share.
2. The request surface: `DELETE /api/tripwires/{name}`, the store's `remove`, the CLI's `rm` re-pointed at the shared operation.
3. The card: the description row in, the brief row out, the `⋯` button, the Delete item with its disabled label, the confirm popover, the `DELETE_TRIPWIRE` action.
4. The tests and the words: `at0492`, the presentation unit test, `tripwire_cli.rs`, `tripwires_api.rs`; the `/tripwire` skill's flag list and receipt; `tuglaws/tripwires.md` and the [D192] amendment.

The first step must land before the third can be written against real frames; the second and third can be written together once the first is in.

<!-- brief-skeleton v1 -->

# Session Atom Reach

**Purpose:** A session atom placed in a prompt reaches the model as an inert string, so the model cannot see the session it names — and nothing in the UI says whether a given atom is findable on this machine. Both must be true: the model can read a referenced session, and the pill says whether it can be found.

---

## Purpose {#purpose}

The report, in the user's words:

> Tug can't see sessions from other projects when I paste in a session atom. This must be fixed. Tug must be able to see projects on the same machine. […] I understand that cross-machine atoms are impossible, but *we should be able to know* whether an atom is findable/linkable or not, and the UI should reflect this, eh?

The reproduction was a `tug/warm-grit` session asked "Can you see `eucit/curly-apple` from here?" with the session atom placed in the prompt. The model answered that `@eucit/curly-apple` is "not a package I know of" — it read the reference as an npm scope.

Two wants are in that report and they are separable: **reach** (the model can read a session that lives elsewhere on the machine) and **an honest verdict** (whether an atom is findable is known, and the pill shows it — including the unfixable cross-machine case).

---

## Evidence {#evidence}

Findings marked **(verified)** were read out of the code or the filesystem directly in this session. Findings marked **(sweep)** were read out of the code by a delegated search; the files are right, but line numbers were not re-checked and should be treated as approximate.

**[F01] The model receives a bare string and nothing else.** A session atom's wire form is `` `@eucit/curly-apple` `` — `build-wire-payload.ts` substitutes `wrapAtomMention(atom.value)` (`tugdeck/src/lib/atom-mention-marker.ts`) for every non-image atom. No id, no project path, no transcript location travels with it. **(sweep)**

**[F02] Nothing tells the model what a session reference is.** The appended system prompt is `SESSION_SYSTEM_PROMPT_NUDGE` plus the four `PLUGIN_PROMPT_FILES` in `tugcode/src/session.ts` (`work-grammar.md`, `file-editing.md`, `transcript-prose.md`, `ask-user-question.md`). None mentions sessions-as-references, atoms, or `project/callsign`. **(sweep)**

**[F03] The model has no verb to read another session.** `tugtool session` has exactly one subcommand, `rotate` (`tugrust/crates/tugtool/src/session.rs`). **(verified)**

**[F04] So the failure is not cross-project at all — it is every session atom.** From [F01]–[F03], a session atom naming a session in the *same* project is equally unreadable to the model. Cross-project only made it obvious. This is inference from the three findings above, not a separate reproduction; pasting a same-project session atom and asking the same question would confirm it.

**[F05] In the reproduction the UI appears to have found the session.** The transcript pill in the screenshot is solid with a dot, not dashed; the dashed `data-missing` skin is what an unresolved citation wears ([F10]). This is read off an image, not the DOM — it implies both projects were open in one Tug instance, which was not confirmed.

**[F06] The atom carries `project/callsign` and nothing else.** `tugdeck/src/lib/session-atom-shape.ts`: value is `<project-leaf>/<callsign>`; no session id, no project path. The callsign is what it resolves through. The plain-text clipboard citation does carry an 8-char short id (`project/tag (shortid8)`, `session-atom.ts`), but the atom itself does not. **(sweep)**

**[F07] The session ledger is per app instance, not per machine.** `tugcore::instance::sessions_db_path` resolves to `<base>/Tug/instances/<TUG_INSTANCE_ID>/sessions.db` (`tugrust/crates/tugcore/src/instance.rs:200`). This machine has over a dozen instance directories (`production-main`, `release-main`, `debug-tugdash-*`, …). A callsign is unique per ledger (`lines.tag`), so it is not a machine-wide key, and a session run under one instance cannot be resolved from another. **(verified)**

**[F08] The fallback scan is per opened project.** `list_sessions` takes `{project_dir}` and the external scanner walks only `~/.claude/projects/<encoded-dir>/` for that directory (`tugrust/crates/tugcast/src/external_sessions.rs`), feeding `external_scan_cache`. A project never opened in this instance has no rows. The ledger's resolve arms themselves (`session_ledger.rs` `resolve_session_ids`: uuid, 8-hex prefix, exact callsign, `minted_tags` alias, scan-cache fallback) carry no project filter. **(sweep)**

**[F09] A foreign session atom silently becomes a file atom on replay.** `mentionAtomType` (`tugdeck/src/lib/synthesize-user-message.ts`) recovers atom type by *shape*: a two-segment `a/b` value is a session only if `isKnownSessionTag(b)`, which reads a client-local cache seeded from project-scoped lists, card bindings, spawn acks, and resolve answers. An unknown callsign falls through to `file`. The composer's baked chip label (`sessionChipLabel` in `tugdeck/src/lib/tug-atom-img.ts`) has the same dependency. **(sweep)**

**[F10] The verdict vocabulary exists on the React pill and nowhere else.** `TugSessionCitation` (`tugdeck/src/components/tugways/tug-session-identity.tsx`) derives `pending` / `missing` / resolved; `missing` emits `data-missing="true"` → dashed border, muted ink, inert (`tug-session-identity.css`). Pending is deliberately not dashed ([D132], [P13] in `tuglaws/design-decisions.md`). The composer chip is a baked PNG whose `ChipVariant` is only `default` / `selected` — there is no way for an atom in the composer to look unfindable. **(sweep)**

**[F11] The prose resolver's project check refutes a mismatch, not a foreign project.** `tugdeck/src/lib/annotator/session-resolution.ts` checks the `project/` half against the answer's `projectDir` basename and refutes when they disagree. `eucit/curly-apple` resolving to a session under `eucit` agrees and is confirmed regardless of which project is asking. **(verified)**

**[F12] Claude Code's transcript for a session is `~/.claude/projects/<encoded-dir>/<uuid>.jsonl`.** The session uuid is therefore machine-unique and is a filename: holding the uuid makes finding the transcript a lookup rather than a search. This is the layout `external_sessions.rs` already walks. **(sweep)**

---

## Decisions {#decisions}

**[B01] The atom carries identity: the full session uuid and the project dir, alongside the `project/callsign` it displays.** The callsign is unique per ledger only ([F07]); the uuid is unique per machine and names the transcript file ([F12]). `value` stays `project/callsign` so every surface reads as it does now; the clipboard sidecar carries the new fields too. Install base is zero, so this is a clean break with no bridge for atoms minted before it.

**[B02] The wire marker for a session atom is self-typing.** Something of the shape `` `@session:eucit/curly-apple` `` rather than `` `@eucit/curly-apple` ``, so replay reads the type from the text instead of guessing it from a client cache. This retires the shape-guess for sessions ([F09]) and, for the model, ends the collision with an npm scope ([F01]). The exact spelling is the arc's to settle; that it is typed is decided.

**[B03] One finder, in Rust, that everything asks.** It lives in `tugcore` and tries, in order: this instance's ledger → a machine-wide session index → the Claude projects tree by uuid. It returns a verdict *with provenance*: `here` (this ledger), `elsewhere` (on this machine — a foreign instance, or a project this instance never opened), or `absent`. The `resolve_sessions` wire verb and the new CLI verbs ([B05]) are both faces of it, so the pill and the model can never disagree about whether a session exists.

**[B04] A machine-wide session index, as a shared top-level ledger.** Every instance writes `uuid · callsign · project_dir · instance · title` at mint and at rename. It is the same regime as `changes.db` and `prompt_history.db`: opened through `tugcore::ledger_db`, schema gated on a version with a registered migration list. An atom carrying a uuid ([B01]) can be found without it; the index is what makes a *typed* `eucit/curly-apple`, or a pasted plain-text citation, resolve across instances — and what supplies a title for a session this instance has never held.

**[B05] The model gets a door: `tugtool session show <ref>` and `tugtool session find <ref>`.** `<ref>` is a uuid, a short id, or `project/callsign`. `show` runs the finder and prints a header (project dir, title, state, turn count, last updated) followed by the transcript rendered as markdown, with `--last N`, `--turn`, and `--grep` to keep a long session from flooding context. `find` prints the verdict alone. The exit code distinguishes `absent` from an error. Both are in the bundle binary, so the standalone contract holds on a project that has never heard of this checkout.

**[B06] The send carries the reference, and a plugin prompt file teaches it.** At send time each session atom appends a small reference block to the wire payload: callsign, uuid, project dir, the finder's verdict, and the one command that reads it. A new `tugplug/session-references.md` joins `PLUGIN_PROMPT_FILES` and says what a `@session:` reference is, that it is read with `tugtool session show`, and that on `absent` the model says so plainly. The model is *told* `absent` rather than left to infer it — that is the difference between "that session isn't on this machine" and an invented package.

**[B07] The pill shows the verdict, extending the existing axis rather than replacing it.** `here` with a card open: solid, live dot, click raises. `here` with no card: solid, quiet dot, click opens or resumes. `elsewhere`: solid, project half emphasized, no live dot, click opens the transcript read-only and offers to open the project. `pending`: solid, never dashed ([D132] stands). `absent`: dashed and inert, with a tooltip that names the reason — "Not on this machine" — which is the honest rendering of the cross-machine case the user called unfixable.

**[B08] The composer chip learns the `missing` state, and resolves at paste.** `ChipVariant` gains a `missing` bake ([F10]), and a pasted or inserted session atom is resolved immediately, so an unfindable atom looks unfindable *before* the prompt is sent rather than after the model has guessed at it.

**[B09] Verdicts are pushed, never polled.** They ride the existing verdict keys (`sessionVerdictKey`); an index write emits a feed event that re-runs the pass, so an `absent` atom heals when its session appears. No timer is added anywhere.

**[B10] Reach across projects is read-only.** `show` reads a foreign transcript and never resumes it or writes into it. Resuming a session belongs to a card in that session's own project. Confirmed by the user.

**[B11] No ambient access.** The model learns of a foreign session only through an atom the user placed or a reference the finder confirmed. There is no verb that lists every session on the machine. Confirmed by the user.

**[B12] The prose resolver's project-half check stays.** It refutes a mismatch between the spelled project and the resolved one, which is still wrong after this work ([F11]). What changes is that a confirmed answer may now carry `elsewhere` provenance.

---

## Open Questions {#open-questions}

- **What does "open the transcript read-only" mount into?** [B07] gives an `elsewhere` pill a click that shows a foreign transcript without resuming it. Whether a read-only transcript surface already exists, or whether this click is the first thing to need one, was not established. If none exists, the smallest honest `elsewhere` click may be "Open project" alone, with the read-only view following.
- **How does the reference block ride the wire?** [B06] decides that it does. Whether it is a trailing text block in the user message, or something the bridge adds, affects replay (`synthesize-user-message.ts` must not re-render it as prose the user typed) and was not worked out.
- **Is the top-level `Tug/sessions.db` live?** `~/Library/Application Support/Tug/sessions.db` exists beside the `instances/` tree, with a WAL. `instance.rs` describes a pre-instances legacy path. Whether anything still writes it bears on where the [B04] index lives and whether that file is a name to avoid.

---

## Non-goals {#non-goals}

- **Cross-machine atoms.** Impossible, and the user said so. The work here is that the `absent` verdict says it truthfully.
- **Making the ledger machine-global.** Merging every instance's `sessions.db` into one would solve [F07] by undoing the instance isolation that debug, release, and app-test instances depend on. The index ([B04]) shares the four facts needed to *find* a session and nothing else.
- **Resuming or driving a foreign session from here.** Ruled out by [B10].
- **A session browser for the model.** Ruled out by [B11]. `find` answers about one reference; nothing enumerates.
- **An `@`-completion source for sessions in the composer.** There is none today — atoms arrive by menu and clipboard — and whether there should be is a separate question about the composer, not about reach.
- **Teaching the model to read raw JSONL.** Handing it the transcript path and nothing else would work and would be poor: the file is large, noisy, and its shape is Claude Code's to change. `show` is the stable face.

---

## Exit {#exit}

**An arc.** The order that matters: the finder and its verdict first, because the pill, the CLI, and the wire block all read it.

Raw material for the steps, roughly in landing order:

- The atom shape gains uuid and project dir; minting, the clipboard sidecar, and paste re-materialization carry them ([B01]).
- The typed wire marker, and replay reading the type from it ([B02]) — with a test that a foreign session atom replays as a session atom, not a file atom.
- The machine-wide index as a shared ledger, written at mint and rename ([B04]).
- The finder in `tugcore`, and `resolve_sessions` answering through it with provenance ([B03]).
- `tugtool session find` and `tugtool session show` ([B05]).
- The send-time reference block and `tugplug/session-references.md` in `PLUGIN_PROMPT_FILES` ([B06]); `just tugplug-lint` and `just test-standalone` are the guards.
- The `elsewhere` and reasoned-`absent` pill states ([B07]), and the `missing` chip bake with resolve-at-paste ([B08]).

Proof, as app-tests carrying `@covers`: the reproduction itself with two projects in one instance, where the model answers with the cited session's title and turn count; a foreign-instance fixture resolving to `elsewhere`; a fabricated uuid baking dashed in the composer; the replay test above.

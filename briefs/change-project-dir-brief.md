# Changing a Session card's project directory

**Purpose:** A Session card is born in one project directory and cannot leave it. The user wants to point a card at a different directory without closing the card, and asked whether Tug and Claude Code can support that.

---

## Purpose {#purpose}

The user's question was: "Does Tug, and the underlying code we rely on for claude, support changing project directories? That would be a great feature."

Today a card's project directory is fixed at spawn. The deck's `spawn_session` frame carries a `projectDir`, tugcast validates it and binds the card to a workspace, and tugcode spawns claude with that directory as `cwd`. There is no verb, gesture, or slash command that moves a live card to another directory. The only way to work in a second directory is to open a second card.

---

## Evidence {#evidence}

**[F01] Claude Code resumes a session from a different cwd, but the transcript stays where the session was born.** Probed on 2026-09-30 with the installed `claude` (2.1.285). A session started in temp dir A with `--session-id`, then resumed by id from temp dir B with `--resume`, picked up its history, reported B as its working directory, and appended the new turn to the **same** JSONL under A's folder in `~/.claude/projects/`. Every transcript line carries its own `cwd`, so the file held lines from A followed by lines from B. Claude also created an auto-memory folder under B's project folder on resume. **(verified)**

**[F02] tugcode already respawns claude in place for settings claude has no live verb for.** `tugcode/src/session.ts` handles `/add-dir` and effort changes by killing the process and respawning with `--resume` or `--session-id` (`handleAddDirectory`, `liveRespawnMode`). Model, effort, the add-dir list, and the arc environment variable are all recorded on the session object and re-applied on every respawn, so a respawn for any new reason inherits them. **(verified)**

**[F03] tugcode locates a session's transcript by encoding its project directory.** `encodeProjectDir` in `tugcode/src/session.ts` builds the JSONL path as `<claudeProjectsRoot>/<encoded projectDir>/<id>.jsonl`, and the drop and replay paths read from there. A session resumed under a different directory than it was born in would be looked up in the wrong folder. This is the concrete cost of a birth-dir versus current-dir split. **(verified by reading the code; not exercised)**

**[F04] `/new` already spawns a fresh claude session on the same card.** `handleNewSession` in `tugcode/src/session.ts` kills the process, mints a new session id, spawns with `--session-id`, and writes a `session_segment` line of kind `new` carrying the parent and new ids, so the card's transcript keeps a lineage boundary. The spawn reads `this.projectDir` for `cwd`. **(verified)**

**[F05] A Tug instance already hosts several project directories at once.** The workspace registry in tugcast holds one entry per project with a live Session card, the changeset feed aggregates every open project into one snapshot ([D113]), and the Changes shade and attribution key on a per-card `workspace_key`. An arc's worktree is a directory of its own and cards already run there. Nothing on the deck side assumes one directory per instance. **(verified)**

**[F06] tugcode surfaces claude's cwd to the deck on every init.** `emitInitialSessionCwd` and the `system:init` handling in `tugcode/src/session.ts` forward `cwd` to the deck, and the memory sheet, path commands, and permission-rules surfaces read it from there. A session born in a new directory would update those surfaces with no new plumbing. **(verified)**

**[F07] The shell lane tracks its own cwd.** `tugdeck/src/lib/shell-session-store.ts` seeds its cwd chip from the project dir and follows the shell's own `cd` through `cwd_after`. The shell's directory and claude's directory are already two facts on one card. **(verified)**

**[F08] The Session card already refuses some acts while a turn is in flight.** `session-card.tsx` derives `turnInFlight` through `useSyncExternalStore` and the AI-config editor is gated on it. **(verified)**

---

## Decisions {#decisions}

**[B01] Changing a card's project directory is a fresh session born in the target directory, never a resume of the existing session under a new cwd.** The user ruled the split out in so many words: "I never want to deal with complications surrounding a birth-dir split. Let's not go there." [F01] shows claude would permit the resume, and [F03] shows what it would cost: tugcode, the sessions ledger, and `session_index.db` would each need to carry two directories per session and know which one answers which question. A fresh session has one directory from its first line. The mechanism is [F04]'s `/new` path with a new `projectDir`, and the card keeps its transcript across the boundary through the `session_segment` record it already writes. To revisit this, claude would have to move or re-home a transcript on resume, which nothing suggests it will.

**[B02] A directory change is refused while a turn is in flight.** The user's word was "It must," with the AI-configuration block as the model. The gate is the card's existing `turnInFlight` [F08]. The refusal reads in the control's own label rather than in a tooltip on a disabled item, per the Session card's rule that a disabled item's refusal rides its label ([D142]).

**[B03] Three gestures, one verb.** `/cd <dir>` typed in the composer, the native folder chooser, and a directory atom dropped on the composer all resolve to one CONTROL verb on the bound session carrying the new directory. tugcast validates the path exactly as `spawn_session` does, moves the card's workspace binding, registers the new project if it has no open card and releases the old one if this was its last, then asks tugcode for a new session in that directory. Three doors to one act keeps the act's rules in one place.

**[B04] The shell lane's cwd stays independent.** A `cd` in the shell lane never respawns claude or rebinds the card. Shell users step into build and scratch directories constantly, and each step would otherwise cost a claude respawn and a workspace rebind. `/cd` is the explicit act. [F07] shows the two directories are already separate facts.

**[B05] A card bound to an arc refuses a directory change.** An arc's worktree is its directory, and arc commits and the join pilot assume the card sits in it. The refusal wears the same label style as [B02]. Unbinding first is the user's act, not the verb's.

**[B06] The change announces itself at the live edge.** A `Directory changed` block naming the old and new paths, in the same place fork and effort changes announce themselves, and the card's title line picks up the new project.

---

## Non-goals {#non-goals}

- **Resuming the existing claude session in the new directory.** Rejected under [B01]. Claude permits it, but the transcript stays in the birth directory's folder with a per-line `cwd`, and every Tug reader of a session's directory would have to learn the split.
- **A second directory column in the sessions ledger or `session_index.db`.** Follows from [B01]. A session has one project directory for its whole life.
- **Steering claude from the shell lane's `cd`.** Rejected under [B04].
- **Carrying context across the boundary.** The new session starts with no history. A hand-off summary is a separate idea and is not part of this work.
- **Changing the default project directory setting.** That is the configuration wizard's step and is untouched. This work is about one live card.

---

## Exit {#exit}

**An arc.** The first steps, in the order they must land:

1. The CONTROL verb in tugcast, with the path validation shared with `spawn_session` and the workspace rebind, and the tugcode handler that runs `handleNewSession` with the new `projectDir`. The IPC frame between them carries the directory.
2. The `turnInFlight` and arc-bound refusals on the deck side, with label-borne reasons.
3. The three gestures: `/cd` in the slash-command registry, the folder chooser, and the directory atom drop, each resolving to the one verb.
4. The live-edge receipt and the title line.
5. An app-test that changes a card's directory, sees the new session's cwd on the memory sheet and the Changes shade re-keyed, and confirms the refusal while a turn is in flight.

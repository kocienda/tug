# Add Project Directory

**Purpose:** A session should be able to reach a second folder without moving out of its own, the way Claude Code's `/add-dir` allows in the terminal. Tug's earlier attempt was removed as obsolete; this brief records what the underlying command really does and how Tug supports it properly.

---

## Purpose {#purpose}

The user removed the old "Add Working Directory…" command (`ad6028fd6c`) as "an obsolete notion that has lingered in the app beyond all point of usefulness", then asked for the real thing:

> I want a sketch for what the underlying Claude Code `/add-dir` slash command actually does. We need to figure out a way to support this command. Once we do, we should add back a "Add Project Directory..." command to the Session menu.

And, on seeing the sketch:

> where do we show the added directories in the UI? We need some kind of visibility and an affordance to show it. Maybe in the session summary?

The old command respawned Claude to apply a folder, reported success unconditionally, showed the added folders nowhere, and forgot them when the app relaunched.

---

## Evidence {#evidence}

**[F01] `/add-dir` is a permission grant, not a move.** It adds a folder to the session's working directories, so the file tools treat it like the project directory instead of asking per file. The session's own directory is unchanged. Read out of the Claude Code 2.1.322 binary: the command yields an `addDirectories` permission update. **(verified)**

**[F02] The terminal offers two scopes.** "Yes, for this session" grants until the process ends. "Yes, and remember this directory" writes the folder to `permissions.additionalDirectories` in the project's local settings file. Both strings are in the 2.1.322 binary. **(verified)**

**[F03] Claude Code validates the path.** It refuses an empty path, a missing path, a non-directory, a network path, and a folder already inside a working directory, each with its own message. Read from the validation function in the binary. **(verified)**

**[F04] The slash command is unavailable over the bridge.** Sent as a user message to a `--input-format stream-json` session, `/add-dir <path>` answers "/add-dir isn't available in this environment." with no model call, and `add-dir` is absent from the `init` frame's `slash_commands`. Probed against a real headless `claude` in a scratch directory. **(verified)**

**[F05] A live route exists: `apply_flag_settings`.** The control request `{"subtype": "apply_flag_settings", "settings": {"permissions": {"additionalDirectories": [path]}}}` grants the folder mid-session with no respawn. Probed with a baseline: without it, a Read in the other folder raised a `can_use_tool` request; with it, the same Read returned the file with no prompt. **(verified)**

**[F06] The grant is reported on the wire.** Every `system:init` frame carries `additional_directories`, described in the binary's schema as the folders added "by `--add-dir`, the SDK option, settings, a grant or a host's request made mid-session". In the probe it was empty at baseline and listed the folder after the grant. **(verified)**

**[F07] The flag layer dies with the process.** `apply_flag_settings` writes a per-process settings layer, so a respawn starts without it. This is inference from the layer's description ("session-scoped"), not probed; the `--add-dir` spawn flag is the known way to carry a folder into a new process, and the removed code used it.

**[F08] Whether a second `apply_flag_settings` merges or replaces the directory list is unprobed.** Sending the full list every time is correct under either behaviour.

**[F09] Tug already edits the remembered list.** The Permission Rules editor's "Workspace" tab reads and writes `permissions.additionalDirectories` through `tugrust/crates/tugcast/src/permissions.rs`. **(verified)**

**[F10] tugcode does not use `apply_flag_settings` today.** No reference in `tugcode/src`. The removed handler's premise, "claude has no live add-directory verb over the bridge", is now false. **(verified)**

**[F11] The Session Summary is the masthead popover.** It lives in `tugdeck/src/components/tugways/session-masthead.tsx` and today lists State, Turns, Created, Branch, Atom and Citation. **(verified)**

---

## Decisions {#decisions}

**[B01] The command returns as Session > "Add Project Directory…" and `/add-dir`.** Both open the native folder picker. `/add-dir <path>` and a path atom in the draft name the folder directly, the way `/cd` takes its target. "Project" replaces "Working" because the session keeps one working directory; this adds a second place it may reach.

**[B02] The grant is applied live through `apply_flag_settings`, never by respawn.** [F05] makes the respawn unnecessary, and a respawn interrupts a running turn. tugcode keeps the session's list and sends the whole list each time, which sidesteps [F08].

**[B03] After the picker, a two-choice dialog matches the terminal.** "Yes, for this session" and "Yes, and remember this directory", the terminal's own wording [F02], so a user who knows one knows the other. "Remember" writes the project's local settings file through the path the Workspace tab already uses [F09], and also applies the grant live so the running session need not wait on a settings reload.

**[B04] A session's grants are recorded in the session ledger.** A resumed session has the folders it had, across app launches. tugcode re-applies them as `--add-dir` flags on every spawn it performs (first spawn of a resume, effort change, fork, continue), because of [F07].

**[B05] There is no remove command.** Claude Code has none. A session grant belongs to that one session, so a new session starts without it; a remembered folder is removed in the Workspace tab. Note the consequence of [B04]: closing and resuming the same session keeps its grants, by design.

**[B06] The Session Summary shows the added folders.** A "Directories" row in the popover [F11] lists each added folder, absent when there are none. The row reads the `additional_directories` the wire reports [F06], so it shows what Claude actually holds, including remembered folders and ones granted by settings, rather than what Tug believes it sent.

**[B07] Confirmation comes from the wire, and a refusal is reported.** tugcode checks the path is a directory before sending. The card's success bulletin waits on the folder appearing in `additional_directories`; a control-request error or a failed check posts a caution instead. The old unconditional "Working directory added" does not return.

---

## Open Questions {#open-questions}

- Does a successful `apply_flag_settings` emit a fresh `init` frame at once, or only at the next turn? The probe saw the folder on the `init` that followed a user message. If no frame arrives at once, [B06] and [B07] need tugcode to reflect its own list to the card on the control request's success. A one-run probe settles it.

---

## Non-goals {#non-goals}

- **Routing the `/add-dir` text to Claude.** It is refused over the bridge [F04].
- **Respawning to apply a folder.** Rejected by [B02].
- **A `/remove-dir` command or a remove affordance in the Session Summary.** Rejected by [B05].
- **Loading the added folder's `CLAUDE.md` or skills.** What Claude Code loads from an added folder is its own behaviour; Tug adds nothing to it.
- **Changing the Permission Rules "Workspace" tab.** It already does its job [F09].
- **Touching the Tug data root's `--add-dir`.** That one flag is how every session reads Tug's runtime state and is unrelated.

---

## Exit {#exit}

**An arc.** The first steps, in the order they depend on each other:

1. Probe the open question, and whether repeated `apply_flag_settings` merges or replaces [F08].
2. Wire: an `add_directory` inbound verb in `tugproto`, a tugcode handler that validates, keeps the list and sends `apply_flag_settings`, and the `--add-dir` flags on respawn. `ad6028fd6c` shows every site the old verb touched.
3. Ledger: persist the list per session and feed it to the spawn of a resumed session.
4. Surface `additional_directories` from `init` to the card's store.
5. Deck: the slash command, the registry row, the picker, the two-choice dialog, the "remember" write, and the bulletins.
6. The "Directories" row in the Session Summary.
7. Menu item in `MenuBarBuilder.swift` with its test and the `tuglaws/menus.md` row; `docs/features.md` and `docs/recipes.md`.

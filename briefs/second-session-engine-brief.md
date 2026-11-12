# A second session engine: Codex CLI beside Claude Code

**Purpose:** Tug's sessions run only on Claude Code. This brief maps what ties Tug to it and settles the shape of adding Codex CLI as a second engine that a session or an arc can choose.

---

## Purpose {#purpose}

The question as asked: "Let's say I wanted to wire a different AI backend into Tug, so that it wasn't tied to Claude Code exclusively. What would I need to do?" It named three areas to cover (the tugcast multiplexer, how the frontend reducer parses and formats messages, the UI touch points) and asked for whatever else was being skipped.

The central finding is that Tug depends on Claude Code as a *harness*, not as a model. Claude Code supplies the tool loop, permissions, hooks, plugins and skills, transcript storage, resume, fork, rewind, compaction and subscription login. Very little of the work is the wire; most of it is replacing, borrowing or gating those services.

---

## Evidence {#evidence}

How these were established: [F01]–[F12] come from three read-only exploration sweeps run in this session on 2026-11-11, which read the cited code or its module headers. The author of this brief read the sweeps' reports, not each file, so line-level claims should be re-read before they are built on. [F13]–[F16] come from a web search the same day whose results were mostly third-party write-ups; none is confirmed against OpenAI's own documentation or a Codex binary.

**[F01] No backend abstraction exists, and no document contemplates one.** A search of `tuglaws/`, `briefs/`, `docs/` and all sources for provider, backend, codex, gemini, openai, ACP and similar terms found nothing about a second agent backend. The seams that exist (`ChildSpawner`, `ScribeSpawner`, `AgentWorkerSpawner`, `CrossingResolverSpawner`) are documented as test seams. **(verified by sweep)**

**[F02] The wire and feed framework are backend-neutral.** Frames are `[FeedId][flags][len][payload]` (`tugrust/crates/tugcast-core/src/protocol.rs`); the conversation rides `CODE_OUTPUT 0x40` and `CODE_INPUT 0x41`, each frame stamped with `tug_session_id`. `StreamFeed` and `SnapshotFeed` carry nothing agent-specific. The deck's Worker, frame peeler and per-session routing (`tugdeck/src/lib/ingest/`) are equally generic. **(verified by sweep)**

**[F03] tugcast's supervisor has a process seam, but the relay above it reads Claude facts.** `default_spawner_factory` always builds `TugcodeSpawner` (`tugcast/src/agent_supervisor/mod.rs`). The relay in `feeds/agent_bridge.rs` recomputes turn counts from Claude's JSONL at `replay_complete`, gates respawn on `claude auth status --json`, and carries `claude_session_id` on the ledger entry. `feeds/attribution.rs` matches `Write`, `Edit`, `MultiEdit` and `NotebookEdit` by name; Claude tool-name literals recur in about ten other tugcast files (digest, Observer, arc runner, semantic transcript). **(verified by sweep)**

**[F04] tugcode is entirely Claude-shaped, and already hosts a second engine for tests.** `spawn-config.ts` builds the `claude` argv; `session.ts` (`SessionManager`) drives Claude's stdin control requests (`initialize`, `interrupt`, `set_permission_mode`, `set_model`, `rewind_files`, `side_question`); `event-mapping.ts` normalizes stream-json into Tug's outbound messages. `--stub-transcript` routes the same IPC loop through `StubReplayEngine` (`stub-replay.ts`) instead, which shows tugcast accepts a non-Claude producer for the subset of frames it emits. **(verified by sweep; the last clause is inference)**

**[F05] The IPC vocabulary has Tug's names and Claude's semantics.** `tugproto/src/outbound.ts` defines 56 outbound tags and `inbound.ts` 20 inbound verbs. Content is keyed `(msg_id, block_index)` after the Anthropic streaming API, tool results pair by `tool_use_id`, usage is Anthropic's four token fields, `PermissionMode` is exactly Claude's set, and `ToolApproval` answers `can_use_tool`. **(verified by sweep)**

**[F06] The frontend never sees raw stream-json, and restore uses the live path.** `session-engine.ts` decodes frames against `OUTBOUND_DECODERS` and feeds `reduce()` (`tugdeck/src/lib/code-session-store/reducer.ts`). History is replayed by tugcode as the same frames inside `replay_started` / `replay_complete` brackets. The reducer's skeleton (turns of ordered messages, a phase machine, replay brackets) is generic; its inputs are Claude's. It also parses Claude's English in places, such as "Command running in background with ID:" for the jobs ledger and the `<command-name>` echo envelope. **(verified by sweep)**

**[F07] Tool rendering is keyed on Claude Code's tool names and result shapes, with a generic fallback.** The registry in `session-assistant-renderer-dispatch.ts` resolves about 25 bespoke blocks under `cards/blocks/`, each reading Claude's input keys and `tool_use_result` shapes. An unknown tool resolves to `DefaultToolBlock`, which shows input and result as JSON trees and raises a drift caution. **(verified by sweep)**

**[F08] Markdown, the annotator and charts take text in.** The only Claude assumptions are the slash-command catalog (`payloads.ts`) and the `WRITING_TOOLS` list (`lib/annotator/written-paths.ts`). **(verified by sweep)**

**[F09] The Session card chrome mirrors Claude Code's terminal.** The model list is data from Claude's `initialize` response, parsed for selectors like `opus[1m]`; the permission-mode cycle is Claude's; about 40 local slash commands re-create Claude's terminal commands, and the skills, agents, hooks, memory and permissions sheets read and write `~/.claude/`. `/usage` parses the text of `claude -p "/usage"`; rate limits use Claude's subscription enum. The setup wizard (`configure-tug.tsx`, `feeds/claude_auth.rs`, `feeds/claude_download.rs`) installs, versions and logs in `claude`. **(verified by sweep)**

**[F10] Much of Tug's tool-call behaviour rides Claude's PreToolUse hook.** `tugplug/hooks/hooks.json` routes Bash, Skill and the Edit family through `tugtool hook pre-tool-use`, which uses `updatedInput` to prefix each Bash call with `# tug-call: <id>`. That prefix is how output links to its block, how test runs are wrapped, how the report panel is fed, and how the arc turn boundary and the unreadable-edit gate are enforced. Bash attribution by snapshot, `TUG-FILE-RECEIPT`, `TUG_SESSION_ID` inheritance, and the landings and session-refs blocks do not depend on the hook. **(verified by sweep)**

**[F11] Arcs are the deepest dependency.** Stage prompts are skill invocations (`/tugplug:arc-implement …`, `tugcast/src/wheel/prompt.rs`); the wheel rotates sessions with a per-stage `--model`, compacts with `/compact`, and `feeds/arc_runner.rs` tracks `claude_session_id`. Skills read doctrine at `${CLAUDE_PLUGIN_ROOT}` and carry Claude-only frontmatter. Nine `tugplug/*.md` prompt files ride `--append-system-prompt` and name Claude's tools. **(verified by sweep)**

**[F12] Claude's on-disk transcript is read directly in many places, and all background model work shells out to `claude`.** JSONL readers: `external_sessions.rs` (picker), `turn_engine.rs`, `dead_branch.rs`, `semantic/transcript.rs`, `tugcore/src/session_transcript.rs` (`tugtool session show`), and tugcode's `replay.ts` and `rewind.ts`. Background work: `scribe.rs` (commit drafts), `shared_agent.rs` (classifier, Observer, Operator), `crossing_resolver.rs`, `claude_usage.rs`; session auto-titles are Claude Code's own `aiTitle`. The capability captures, golden catalog and drift tests pin a Claude Code version. **(verified by sweep)**

**[F13] Codex has a long-lived control protocol.** `codex app-server` reportedly speaks newline-delimited JSON-RPC over stdio: `initialize`, `thread/start`, `turn/start`, then `item/started` and `item/completed` notifications until `turn/completed`. Its schema can be dumped with `codex app-server generate-ts` or `generate-json-schema`. **(not verified; third-party sources and one OpenAI engineering post)**

**[F14] Codex approvals are server-initiated requests that pause the turn.** `item/commandExecution/requestApproval` and a file-change equivalent, answered by the client. **(not verified)**

**[F15] Codex reportedly has a PreToolUse hook with Claude's output shape.** It returns `permissionDecision` and `updatedInput`; the rewrite is said to be honoured for shell calls and rejected for other tools, and `apply_patch` is said to emit hook events from v0.123. **(not verified; confirm by running a hook against a Codex binary)**

**[F16] Codex reads `SKILL.md` but invokes skills differently.** Invocation is reportedly `$skill-name`; skills live under `.agents/skills/`; `AGENTS.override.md` overrides instructions. **(not verified)**

---

## Decisions {#decisions}

**[B01] The target is another agent CLI, and Codex CLI is first.** A borrowed harness keeps someone else's tool loop, sandbox, session storage and login, so the work is one adapter plus deciding what degrades. A raw model API would have Tug build all of that; a generic agent protocol would cap features at what the protocol exposes. Revisit if the spike in Exit shows the app-server cannot carry approvals or interrupts.

**[B02] Arcs run on Codex from the start.** The second engine is not plain sessions only. This pulls skill invocation, compaction, per-stage model choice and turn-boundary enforcement into the first cut, and it is why the open questions below matter.

**[B03] Claude Code stays a required install and keeps all background model work.** Commit drafts, the classifier, the Observer and Operator, the merge resolver and auto-titles stay on `claude -p`. Codex is a second engine beside Claude, so the setup wizard gains a row and none of the background jobs needs a Codex path.

**[B04] Engine is a property of the session.** It is carried from the ledger row to the spawner, and `claude_session_id` generalises to an engine session id. A deck can hold Claude and Codex sessions side by side.

**[B05] The existing `tugproto` IPC stays the contract, and the Codex engine imitates it.** The engine sits beside `SessionManager` in tugcode and synthesises the `(msg_id, block_index)` keys, `tool_use_id` pairing and usage fields the reducer expects. Names are neutralised only after a second producer shows which ones hurt. This keeps the reducer and transport untouched in the first cut.

**[B06] Codex's shell and patch items are emitted in the `Bash` and `Edit`/`Write` shapes.** They then get the real blocks, and `feeds/attribution.rs` attributes them unchanged because it matches by name. Everything else lands in `DefaultToolBlock`.

**[B07] The adapter journals the outbound frames it emits, and replay reads the journal.** Codex's own thread id is still used for model context on resume. This gives the picker, turn counts, semantic ingest and `tugtool session show` a Tug-owned source and avoids tracking a second on-disk transcript format across versions.

**[B08] The chrome gates on a capabilities frame from the engine.** Rewind, `/compact`, `/btw`, effort and the permission-mode cycle appear only when the engine claims them. Claude-only sheets stay Claude-only.

**[B09] The adapter targets `codex app-server`, not `codex exec --json`.** The exec stream is one process per turn with no approval round-trip, which would cost the permission dialog and mid-turn interrupt. Rests on [F13] and [F14].

**[B10] Tug never writes into the user's Codex configuration or project to inject hooks or instructions.** Whatever Codex is given is supplied per launch. If no per-launch route exists, that is a finding to bring back, not a licence to write `AGENTS.md` or `~/.codex/hooks.json`.

---

## Open Questions {#open-questions}

All four are facts about Codex that reading Tug's code cannot settle. The spike in Exit settles them.

- **Does the app-server expose compaction as a request?** The wheel compacts between stages; `/compact` is confirmed only as a terminal command.
- **Is there a counterpart to `AskUserQuestion`?** Any arc skill that asks the user a question needs a route on Codex.
- **Can the model be chosen per thread or per turn?** The wheel sets a model per stage.
- **Can a hook and instructions be registered per launch?** [B10] depends on it, and so does porting `tugtool hook pre-tool-use` ([F10], [F15]).

---

## Non-goals {#non-goals}

- **A raw model API engine.** Rejected for now: Tug would own the tool loop, permissions and transcript itself.
- **A generic agent-protocol adapter.** Rejected as the first target; Codex's own protocol is richer than a common denominator.
- **Running Tug without Claude Code installed.** Ruled out by [B03].
- **Moving background model work off Claude.** Ruled out by [B03].
- **Renaming the protocol.** `CODE_*`, `claude_session_id` in wire types and the outbound tags keep their names until [B05]'s condition is met.
- **Bespoke tool blocks for Codex-only tools.** They render through `DefaultToolBlock` at first.
- **Importing Codex sessions made outside Tug.** The picker lists Codex sessions Tug created, from the journal.

---

## Exit {#exit}

**A spike, then an arc.**

The spike: install Codex, dump the app-server schema, and lay it against `tugproto`'s outbound tags and inbound verbs in one table. Run one hook against the binary to confirm [F15]. The table is the true size of the adapter, and it answers the four open questions.

The arc that follows, in the order the pieces depend on each other:

1. Engine kind carried from ledger row to spawner, proven end to end with a trivial echo engine.
2. The Codex engine in tugcode: text, thinking, shell and patch items, mapped per [B06].
3. Approvals into the existing permission dialog; interrupt.
4. The frame journal, and replay, resume and turn counts read from it.
5. `tugtool hook pre-tool-use` taught Codex's tool names and call-id field, registered per launch.
6. The wheel: per-engine stage invocation, compaction and model choice; `arc_runner.rs` tracking a thread id; Codex variants of the prompt files and skill paths.
7. The capabilities frame and chrome gating; the wizard's Codex row.
8. The Codex schema dump and a recorded fixture corpus as the drift guard.

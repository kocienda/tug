# Tug-Feed: Structured Progress Reporting for Skills and Agents

## Vision

A **tug-feed** is a structured, real-time progress stream that reports what skills and agents are doing as they run in a tugtool project. It serves multiple audiences: a developer watching work happen, a dashboard rendering live status, and a post-hoc analysis tool reconstructing what happened and why.

The feed transforms opaque agent execution into a legible narrative: which agent is running, what tools it's calling, what files it's touching, what decisions it's making, and how the work maps back to the plan steps driving it.

## Landscape: What Already Exists

### 1. JSONL Transcript Files

Claude Code stores every conversation as JSONL at `~/.claude/projects/{project-key}/{session-id}.jsonl`. Subagent transcripts live in `{session-id}/subagents/agent-{agent-id}.jsonl`.

**What's in them:**
- User messages with timestamps, session IDs, git branch, CWD
- Assistant messages with model ID, token usage, cost, thinking blocks
- Tool use blocks: tool name, input parameters, caller context
- Tool result blocks: output content, success/failure
- System messages: compaction boundaries, session metadata
- Linked parent-child UUIDs forming a conversation tree

**Strengths:** Complete record of everything. Per-agent isolation via subagent transcripts.

**Gaps:** No semantic tagging (which plan step? which workflow phase?). No distinction between orchestrator chatter and meaningful progress events. Raw format requires heavy parsing. Files grow large (10MB+ for implementation sessions). No real-time access pattern; file is append-only.

### 2. Hooks System (16 Lifecycle Events)

Claude Code provides 16 hook events that fire at specific lifecycle points. The most relevant for feed construction:

| Event | Data Available | Real-Time? |
|-------|---------------|------------|
| `PreToolUse` | tool_name, tool_input, tool_use_id | Yes |
| `PostToolUse` | tool_name, tool_input, tool_response, tool_use_id | Yes |
| `PostToolUseFailure` | tool_name, error, tool_use_id | Yes |
| `SubagentStart` | **agent_id**, agent_type | Yes |
| `SubagentStop` | **agent_id**, agent_type, **agent_transcript_path**, **last_assistant_message** | Yes |
| `UserPromptSubmit` | prompt text | Yes |
| `Stop` | stop_reason, last_assistant_message | Yes |
| `TaskCompleted` | task details | Yes |
| `SessionStart` | source, model, agent_type | Yes |
| `SessionEnd` | reason | Yes |

Every hook receives `session_id`, `transcript_path`, `cwd`, `permission_mode`, and `hook_event_name` as common input fields via stdin JSON.

**Strengths:** Real-time. Async hooks don't block execution. Can run arbitrary commands. Scoped to plugins, skills, or agents. Subagent hooks provide `agent_id` for tracking and correlation.

**Gaps:** Hooks fire per-event, not per-semantic-unit. No built-in aggregation or collection point. Semantic context (plan step, workflow phase) must be reconstructed from correlated events.

### 3. claude-code-chat-to-markdown.py (Reference Implementation)

A post-hoc converter that reads JSONL transcripts and renders them as Markdown. Key design patterns:

- Reads raw JSONL via `arbors` library for tree-structured parsing
- Handles parent-child UUID relationships
- Filters: skips meta messages, sidechain messages, tool-result-only messages, compaction summaries
- Coalesces consecutive same-speaker messages
- Formats tool calls semantically: `*Reading file: path*`, `*Launching agent: desc*`
- Groups by calendar date, supports incremental progress tracking via state file
- Renders to stdout or per-date files with overwrite/append/skip/unique modes

**Strengths:** Proves the transcript format is parseable and renderable. Good filtering heuristics. Progress tracking across runs.

**Gaps:** Post-hoc only (reads completed transcripts). No plan-step awareness. No real-time capability. Treats all agents uniformly; doesn't understand the tugplug orchestration model.

### 4. Third-Party Observability (claude_telemetry, Dev-Agent-Lens)

- **claude_telemetry**: Wraps Claude Code CLI with OTel spans. Creates a trace hierarchy: `claude.agent.run` > `tool.read`, `tool.write`, etc. Uses hook system (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`).
- **Dev-Agent-Lens (Arize)**: Claude Code observability focused on tracing and debugging.
- **Langfuse**: Agent SDK integration for LLM observability.

**Strengths:** Proven that hooks can create meaningful traces. Shows the pattern works.

**Gaps:** Generic agent observability, not tugtool-workflow-aware.

## What Tug-Feed Needs That Nothing Provides Today

The gap between what exists and what we want is **semantic context**:

1. **Plan-step correlation**: "This tool call is part of step-3 implementation" vs. just "a Bash tool ran"
2. **Workflow phase tracking**: "We're in the architect phase of the implementer loop" vs. just "a subagent started"
3. **Progress aggregation**: "Step 2 of 5 complete, step 3 in progress (coder phase)" vs. raw event counts
4. **Agent role attribution**: "The reviewer found 3 issues" vs. "an agent returned text"
5. **Semantic event types**: file-created, test-ran, build-succeeded, drift-detected, review-verdict-APPROVE vs. raw tool names
6. **Cross-agent correlation**: Linking the architect's strategy to the coder's implementation to the reviewer's verdict for the same step

## The Hooks-First Correlation Strategy

The key insight is that hooks provide enough data to reconstruct full semantic context **without polluting the orchestrator**. The orchestrator already calls `tugcode state` at the right boundaries; the hooks system fires events at those same boundaries. The feed captures and correlates them independently.

### The Correlation Chain

Four hook events, firing in sequence for each agent dispatch, form a complete picture:

```
1. PreToolUse (Task)     → orchestrator context: step_anchor, plan_path, agent_role
                            from tool_input.prompt; also tool_use_id
2. SubagentStart         → agent_id, agent_type
3. SubagentStop          → agent_id, agent_type, last_assistant_message,
                            agent_transcript_path
4. PostToolUse (Task)    → tool_use_id, full agent result in tool_response
```

**Step 1 → Step 2 correlation:** `PreToolUse` for a `Task` call provides `tool_input.subagent_type` (e.g., `"tugplug:coder-agent"`) and `tool_input.prompt` (which contains the orchestrator's JSON payload with `step_anchor`, `plan_path`, etc.). The `SubagentStart` that fires next provides `agent_id` and the same `agent_type`. The feed-capture process matches these by `(session_id, agent_type, temporal sequence)` — a pending `PreToolUse` for `Task(tugplug:coder-agent)` matches to the next `SubagentStart` of `tugplug:coder-agent`.

**Step 2 → Step 3 correlation:** Trivial. Same `agent_id` on both `SubagentStart` and `SubagentStop`.

**Step 3 → Step 4 correlation:** `SubagentStop` and `PostToolUse(Task)` fire in sequence for the same agent completion. The `PostToolUse` carries `tool_use_id` matching the original `PreToolUse`, closing the loop.

**Result:** The feed-capture process can build a complete record:

| Field | Source |
|-------|--------|
| `agent_id` | `SubagentStart` / `SubagentStop` |
| `agent_type` | `SubagentStart` (e.g., `tugplug:coder-agent`) |
| `step_anchor` | Parsed from `PreToolUse(Task).tool_input.prompt` |
| `plan_path` | Parsed from `PreToolUse(Task).tool_input.prompt` |
| `agent_result` | `SubagentStop.last_assistant_message` or `PostToolUse(Task).tool_response` |
| `agent_transcript` | `SubagentStop.agent_transcript_path` |
| `tool_use_id` | `PreToolUse(Task)` / `PostToolUse(Task)` |
| `is_resume` | Detected from `PreToolUse(Task).tool_input.resume` field |

### Tugstate as Ground Truth

The feed-capture process can independently query `tugcode state show` to get authoritative step status at any point. This provides:

- Step titles and ordering
- Step status (pending, in_progress, completed)
- Artifact records (architect strategies, reviewer verdicts)
- Checklist item completion

The correlation works because `tugcode state` transitions happen at the same boundaries as the hook events. When the orchestrator calls `tugcode state start step-3`, it then spawns the architect agent. The `SubagentStart` hook fires at that moment. The feed doesn't need the orchestrator to tell it — it observes the same transition independently.

## Architecture

### Layer 1: Event Capture (Plugin Hooks)

Extend the existing `tugplug/hooks/hooks.json` with async feed-capture hooks.

```
tugplug/
  hooks/
    hooks.json              # existing + new feed hooks
    feed-capture.sh         # main async hook handler
    feed-file-change.sh     # agent-scoped: file modifications
    feed-command-result.sh  # agent-scoped: bash command results
```

**Parent-session hooks** (in `hooks.json`):

| Hook | Matcher | Captures |
|------|---------|----------|
| `PreToolUse` | `Task` | Orchestrator prompt (step context), subagent_type, tool_use_id |
| `PostToolUse` | `Task` | Agent result, tool_use_id |
| `SubagentStart` | `tugplug:.*` | agent_id, agent_type |
| `SubagentStop` | `tugplug:.*` | agent_id, agent_type, last_assistant_message, agent_transcript_path |

**Agent-scoped hooks** (in agent frontmatter):

| Agent | Hook | Matcher | Captures |
|-------|------|---------|----------|
| coder-agent | `PostToolUse` | `Edit\|Write` | File path, operation |
| coder-agent | `PostToolUse` | `Bash` | Command, exit code, description |
| reviewer-agent | `Stop` | — | last_assistant_message (verdict) |

All hooks use `"async": true` to avoid blocking agent execution.

```yaml
# Example: coder-agent.md frontmatter addition
hooks:
  PostToolUse:
    - matcher: "Edit|Write"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/feed-file-change.sh"
          async: true
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/feed-command-result.sh"
          async: true
```

### Layer 2: Feed-Capture Process

The `feed-capture.sh` handler (and its per-agent variants) receives hook JSON on stdin and:

1. Extracts the relevant fields for the event type
2. For `PreToolUse(Task)`: parses `tool_input.prompt` to extract `step_anchor`, `plan_path`, `agent_role`; stashes this context keyed by `(session_id, agent_type)` in a temp file for later correlation
3. For `SubagentStart`: reads the stashed context from step 2, associates it with `agent_id`
4. For `SubagentStop`: looks up context by `agent_id`, parses `last_assistant_message` for structured results (verdict, drift, build status)
5. Optionally queries `tugcode state show --json` to enrich with current step status
6. Appends a structured feed event to `.tugtool/feed/feed.jsonl`

**Correlation state** is maintained in a lightweight temp file at `.tugtool/feed/.pending-agents.json`:

```json
{
  "pending_tasks": {
    "tugplug:coder-agent": {
      "tool_use_id": "toolu_01ABC...",
      "step_anchor": "step-3",
      "plan_path": ".tugtool/tugplan-feature.md",
      "timestamp": "2026-02-26T15:30:00.000Z"
    }
  },
  "active_agents": {
    "agent-def456": {
      "agent_type": "tugplug:coder-agent",
      "step_anchor": "step-3",
      "plan_path": ".tugtool/tugplan-feature.md",
      "started_at": "2026-02-26T15:30:01.000Z"
    }
  }
}
```

### Layer 3: Feed Event Schema

Every feed event is a JSON object:

```json
{
  "version": 1,
  "timestamp": "2026-02-26T15:30:00.000Z",
  "session_id": "abc-123",
  "event_type": "agent_started",
  "plan_path": ".tugtool/tugplan-feature.md",
  "step_anchor": "step-3",
  "agent_role": "coder",
  "agent_id": "agent-def456",
  "workflow_phase": "code",
  "data": { "is_resume": false, "model": "claude-opus-4-6" }
}
```

**Event type catalog:**

| Event Type | Source Hook | Data Fields |
|-----------|------------|-------------|
| `agent_started` | `SubagentStart` | `agent_role`, `is_resume`, `model` |
| `agent_completed` | `SubagentStop` | `agent_role`, `duration_ms`, `result_summary` |
| `phase_changed` | `SubagentStart` (new role) | `from_phase`, `to_phase` |
| `step_started` | `SubagentStart` (new step) | `step_title`, `step_index`, `total_steps` |
| `step_completed` | Tugstate query after `SubagentStop` | `step_title`, `duration_ms` |
| `file_modified` | Agent `PostToolUse(Edit\|Write)` | `file_path`, `operation` (create/edit) |
| `command_ran` | Agent `PostToolUse(Bash)` | `command`, `description`, `exit_code`, `duration_ms` |
| `build_result` | Parsed from coder `last_assistant_message` | `success`, `error_count`, `warning_count` |
| `test_result` | Parsed from coder `last_assistant_message` | `passed`, `failed`, `skipped` |
| `review_verdict` | Parsed from reviewer `last_assistant_message` | `verdict` (APPROVE/REVISE), `findings` |
| `drift_detected` | Parsed from coder `last_assistant_message` | `severity`, `unexpected_files`, `budget` |
| `commit_created` | Agent `PostToolUse(Bash)` for git commit | `sha`, `message` |
| `error` | `PostToolUseFailure` | `tool`, `error_message` |

### Layer 4: Feed Consumers

#### 4a. CLI Viewer (`tugcode feed`)

A Rust CLI command that tails `feed.jsonl` and renders a live progress view:

```
[step-1] Authentication Module           COMPLETE  (3m 22s)
[step-2] Database Schema                 COMPLETE  (5m 41s)
[step-3] API Endpoints                   IN PROGRESS
         architect: strategy complete
         coder: implementing... (2 files modified)
           src/api/routes.rs (created)
           src/api/handlers.rs (editing)
         build: passing
[step-4] Frontend Integration            PENDING
[step-5] Tests                           PENDING
```

#### 4b. Web Dashboard (tugdeck via tugcast)

Feed events reach the tugdeck frontend through **tugcast** — the existing WebSocket server that already bridges all data feeds (terminal, git, filesystem, stats, agent messages) to the browser. Tugcast uses a binary framing protocol (`[1-byte FeedId][4-byte length][payload]`) over a single WebSocket connection. A new `FeedId` (e.g., `TugFeed = 0x50`) carries tug-feed events as JSON payloads through the same infrastructure.

The feed-capture process (Layer 2) writes to `.tugtool/feed/feed.jsonl`. A new tugcast feed implementation (a `SnapshotFeed` or `StreamFeed` depending on the delivery pattern) tails that file and publishes events as frames. Tugdeck's feed-progress card subscribes to this feed ID via the standard `TugConnection.onFrame()` mechanism — no new transport layer needed.

The dashboard card can render:

- Live step-by-step progress bars
- Agent activity timeline
- File change heatmap
- Build/test status indicators
- Cost and token accumulation

#### 4c. Post-Hoc Report Generator

A successor to `claude-code-chat-to-markdown.py` that reads `feed.jsonl` and produces:

- Step-by-step implementation narrative
- Time and cost breakdown per step and agent
- File change summary
- Decision audit trail (review verdicts, drift decisions)

#### 4d. Notification Sink

Feed events can trigger notifications:

- Step completion → desktop notification
- Review verdict → Slack message
- Build failure → alert
- Drift detected → prompt for user attention

## Implementation Strategy

### Phase 1: Core Hook Capture and Correlation

**What:** Add async hooks to tugplug that capture agent lifecycle events, correlate them with orchestrator context, and write enriched events to `.tugtool/feed/feed.jsonl`.

**How:**
1. Add `PreToolUse(Task)`, `PostToolUse(Task)`, `SubagentStart`, `SubagentStop` hooks to `tugplug/hooks/hooks.json`
2. Write `feed-capture.sh` that implements the correlation chain: stash orchestrator context from `PreToolUse(Task)`, associate with `agent_id` on `SubagentStart`, enrich and emit on `SubagentStop`
3. Parse `tool_input.prompt` from `PreToolUse(Task)` to extract `step_anchor`, `plan_path` from the orchestrator's JSON payload
4. Parse `last_assistant_message` from `SubagentStop` to extract agent results (verdict, drift, build status) from the agent's structured JSON output
5. Add `tugcode feed tail` command for live viewing

**Effort:** Small-medium. No changes to orchestrator skills or agent prompts. Pure observation layer.

**What this gives you:** Agent lifecycle (started/completed) with full semantic context (which step, which phase, which plan) plus agent result summaries. Enough for the progress dashboard.

### Phase 2: Agent-Internal Fine Events

**What:** Add agent-scoped hooks in frontmatter to capture file modifications and command results within agents.

**How:**
1. Add `PostToolUse` hooks to `coder-agent.md` frontmatter for `Edit|Write` and `Bash`
2. Write `feed-file-change.sh` and `feed-command-result.sh` handlers
3. These handlers look up the active agent context from `.tugtool/feed/.pending-agents.json` to tag events with step/plan context

**Effort:** Small. Frontmatter additions only. No prompt changes.

**What this gives you:** File-level and command-level detail within agent executions. The "2 files modified" and "build: passing" details in the progress view.

### Phase 3: Transcript Enrichment

**What:** Post-process JSONL transcripts to extract additional detail not available via hooks.

**How:**
1. Build a `tugcode feed backfill` command that reads transcript JSONL files (including subagent transcripts via `agent_transcript_path`) and produces enriched feed events
2. Use the same parsing approach as `claude-code-chat-to-markdown.py` but with tugplug-aware semantics
3. Merge with hook-captured events for a complete picture

**What this gives you:** Full assistant text, thinking blocks, and detailed tool I/O that hooks don't surface. Useful for post-hoc reports and debugging.

### Phase 4: Live Dashboard via Tugcast

**What:** Real-time feed consumption in the tugdeck web dashboard.

**How:**
1. Add a new `TugFeedFeed` implementation in tugcast (either `StreamFeed` using `broadcast` for append-stream delivery, or `SnapshotFeed` using `watch` for latest-state snapshots — likely `StreamFeed` since events are append-only and consumers need the full sequence)
2. The feed implementation tails `.tugtool/feed/feed.jsonl` using `notify` file watcher (same pattern as `FilesystemFeed`) and publishes each new event as a frame with a new `FeedId::TugFeed` (`0x50`)
3. Register the new feed ID in `tugcast-core/src/protocol.rs` (Rust) and `tugdeck/src/protocol.ts` (TypeScript)
4. Tugdeck's feed-progress card subscribes via the standard `TugConnection.onFrame(FeedId.TUG_FEED, cb)` mechanism — same as every other card

**No new transport infrastructure.** Tugcast already provides authenticated WebSocket connections, binary framing, heartbeat, reconnection with bootstrap, and per-client state management. The tug-feed is just another feed.

## Key Design Decisions

### Feed Location

`.tugtool/feed/` inside the project, alongside the plan files and state database. This keeps feed data colocated with the work it describes.

### Event Granularity

Two levels:
- **Coarse events** (step/phase/agent lifecycle): Always captured via parent-session hooks. Small volume. Sufficient for dashboard and notifications.
- **Fine events** (individual tool calls, file changes): Captured via agent-scoped hooks in frontmatter. Higher volume. Useful for detailed progress and debugging.

### Orchestrator Independence

The orchestrator (skill) is **not modified**. The feed system is a pure observation layer. This is possible because:
- Hooks fire at the same boundaries as `tugcode state` transitions
- The orchestrator's prompt to each agent (visible in `PreToolUse(Task).tool_input.prompt`) contains the semantic context needed for correlation
- `tugcode state show` provides authoritative step status independently

If the hooks API ever provides insufficient context, orchestrator integration remains a fallback option — but the goal is to avoid it.

### Correlation State Management

The `.tugtool/feed/.pending-agents.json` file tracks in-flight correlations. It's a lightweight working file, not a durable store. If it's lost (e.g., crash), the feed loses correlation for in-flight agents but recovers for subsequent ones. Transcript backfill (Phase 3) can reconstruct missing correlations.

### Backward Compatibility with Transcripts

The feed is a **new, parallel data stream**, not a replacement for JSONL transcripts. Transcripts remain the complete record. The feed is a curated, semantically-enriched view. Post-hoc tools can reconstruct feed events from transcripts if needed.

## Risks and Open Questions

1. **PreToolUse(Task) prompt parsing:** The orchestrator's prompt to agents is a natural-language string containing embedded JSON. Parsing `step_anchor` and `plan_path` from it requires pattern matching against the orchestrator's prompt format. If the skill prompt format changes, the parser needs updating. Mitigation: the orchestrator passes structured JSON payloads with well-known keys; the parser can look for those keys.

2. **Subagent hook isolation:** Agent-scoped hooks (Phase 2) fire within the agent's execution context, not the parent session. The agent's hooks need access to the correlation state file to tag events with step context. The `$CLAUDE_PROJECT_DIR` environment variable should provide the path, but this needs verification.

3. **Feed file contention:** Multiple agents running in parallel (e.g., conformance + critic in the plan workflow) may write to `feed.jsonl` and `.pending-agents.json` concurrently. Mitigation: use atomic appends for JSONL (open with `O_APPEND`); use file locking or per-agent state files for `.pending-agents.json`.

4. **Worktree isolation:** Agents running in isolated worktrees have a different CWD. The feed file path must be resolved relative to the main project root, not the worktree. Use `$CLAUDE_PROJECT_DIR` or an absolute path.

5. **PreToolUse → SubagentStart race:** If two agents of the same type are spawned in rapid succession, the temporal-sequence matching could mismatch. Mitigation: for tugplug workflows this is rare (the orchestrator spawns agents sequentially within a step), but parallel dispatches (conformance + critic) use different agent types, so matching by type is unambiguous.

## Sources

- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code Skills](https://code.claude.com/docs/en/skills)
- [Claude Code Monitoring (OpenTelemetry)](https://code.claude.com/docs/en/monitoring-usage)
- [claude_telemetry (OpenTelemetry wrapper)](https://github.com/TechNickAI/claude_telemetry)
- [Claude Code Hooks Mastery](https://github.com/disler/claude-code-hooks-mastery)
- [claude-conversation-extractor](https://github.com/ZeroSumQuant/claude-conversation-extractor)
- [Dev-Agent-Lens (Arize)](https://arize.com/blog/claude-code-observability-and-tracing-introducing-dev-agent-lens/)

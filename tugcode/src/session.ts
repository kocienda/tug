// Session lifecycle management via direct claude CLI spawning

import { PermissionManager, type PermissionMode } from "./permissions.ts";
import { writeLine, writeLineAndExit, drainPendingWrites } from "./ipc.ts";
import {
  sendControlRequest,
  sendControlResponse,
  formatPermissionAllow,
  formatPermissionDeny,
  formatQuestionAnswer,
  generateRequestId,
} from "./control.ts";
import {
  parseInitializeControlResponse,
  readControlResponseRequestId,
  parseClaudeVersion,
  enumeratePluginCommands,
  mergePluginCommands,
} from "./capabilities.ts";
import type {
  UserMessage,
  ToolApproval,
  QuestionAnswer,
  PermissionModeMessage,
  OutboundMessage,
  ThinkingText,
  ToolInputProgress,
  CompactBoundary,
  ApiRetry,
  RateLimitEvent,
  ControlRequestForward,
  ControlRequestCancel,
  ReplayComplete,
  SystemMetadata,
  CostUpdate,
  StreamingUsage,
  ActivityChannel,
  ActivityDelta,
  WakeStarted,
  TaskStarted,
  TaskUpdated,
  TaskProgress,
  Attachment,
  ContentBlock,
  RewindPreview,
  SessionRewind,
  RewindPreviewResult,
  RewindResult,
  ReplayWindow,
  ReplayLineageEntry,
  SideQuestion,
  SideQuestionAnswer,
  SessionStageSpec,
} from "./types.ts";
import { join, dirname, resolve } from "node:path";
import { realpath, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { Database } from "bun:sqlite";
import { logSessionLifecycle } from "./session-lifecycle-log.ts";
import {
  type JsonlEntry,
  type ReplayInput,
  type ReplayTelemetry,
  type SubagentTranscript,
  type SubagentTranscriptMeta,
  translateJsonlSession,
} from "./replay.ts";
import { ContextBreakdownEmitter } from "./context-breakdown.ts";
import { SubagentTailer } from "./subagent-tail.ts";
import { isSessionHeldByOtherProcess } from "./terminal-liveness.ts";

/**
 * Resolve the `claude` executable: the user's PATH first, then the native
 * installer's `~/.local/bin/claude` fallback — so Tug finds a `claude`
 * installed by `claude.ai/install.sh` even when `~/.local/bin` isn't on the
 * user's shell PATH (we don't edit their shell environment). Mirrors
 * `claude_auth::claude_executable` on the tugcast side. Returns null when
 * nothing is found. Resolved per spawn so a just-installed `claude` is found
 * without relaunch.
 */
function resolveClaudePath(): string | null {
  const onPath = Bun.which("claude");
  if (onPath) return onPath;
  const fallback = join(homedir(), ".local", "bin", "claude");
  return existsSync(fallback) ? fallback : null;
}

/**
 * Resolve the Claude Code CLI version by running `claude --version` (output:
 * `"2.1.195 (Claude Code)"`) and parsing the leading semver. claude's
 * `initialize` handshake carries no version — only the post-turn `system/init`
 * does — so tugcode sources it locally and folds it into
 * `session_capabilities`, making the frontend's Claude Code badge correct from
 * the drop rather than "?" until the first turn.
 *
 * Best-effort: a spawn failure / unexpected output yields `null` (the badge
 * then falls back to its last-known / post-turn value). Synchronous and cheap
 * (one short-lived process), run once per spawn.
 */
function resolveClaudeCodeVersion(claudePath: string): string | null {
  try {
    const proc = Bun.spawnSync([claudePath, "--version"]);
    if (!proc.success) return null;
    return parseClaudeVersion(proc.stdout.toString());
  } catch {
    return null;
  }
}

/**
 * Resolve the tugplug `--plugin-dir`.
 *
 * tugplug is an **app-level resource** — universal across every project
 * directory and bundled into every app variant. It is ALWAYS the bundled copy
 * that sits beside this binary (`Contents/Resources/tugplug`, one level up
 * from the `MacOS` dir), so a Session card on any directory gets the same
 * skills/agents. It is **never** the open project's source tree — there is no
 * per-project resolution and no fall-back to `<projectDir>/tugplug`.
 *
 * `TUG_PLUGIN_DIR` overrides the path for the dev-only `bun run` harness,
 * where there is no app bundle to resolve against. That is an explicit
 * injection, not a per-project fallback.
 *
 * Shared by the spawn ({@link SessionManager}) and the context-breakdown
 * emitter so both read the same plugin dir.
 */
export function resolvePluginDir(): string {
  const override = process.env.TUG_PLUGIN_DIR;
  if (override && override.length > 0) {
    console.log(`Plugin dir (env override): ${override}`);
    return override;
  }
  const bundled = resolve(
    dirname(process.execPath),
    "..",
    "Resources",
    "tugplug",
  );
  console.log(`Plugin dir (bundled app resource): ${bundled}`);
  return bundled;
}

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// Image attachment validation constants (per PN-12)
// ---------------------------------------------------------------------------

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // ~5MB decoded

// ---------------------------------------------------------------------------
// Permission deny — canonical SDK rejection text
// ---------------------------------------------------------------------------

/**
 * Canonical permission-deny message the SDK's own built-in interactive
 * prompts send when the user denies a tool call. We mirror it verbatim
 * so the AI receives the same STOP directive it's trained to honor —
 * passing a shorter string (e.g. "User denied") into the SDK leaves the
 * AI without any "STOP and wait" instruction and it proceeds with
 * follow-up tool calls (verified bug, 2026-05-23 session
 * `f39f74c6-80cb-4378-b1a3-fa7a8af7862f`). The SDK forwards the
 * `message` field of our `tool_approval` response verbatim into the
 * `tool_result.content` the AI sees, so the literal text matters.
 */
const CANONICAL_PERMISSION_DENY_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

// ---------------------------------------------------------------------------
// Replay constants and helpers
// ---------------------------------------------------------------------------

/**
 * Hard-budget timeout for the per-session replay window. If the JSONL
 * iterator hasn't finished by this point, the replay aborts with
 * `replay_complete { error: { kind: "replay_timeout" } }` and live
 * forwarding resumes. Matches the wall-clock budget called out in
 * `dash/tugplan-session-transcript-resume.md` (D10).
 */
export const REPLAY_HARD_TIMEOUT_MS = 10_000;

/**
 * Health gate for the resume-mode `initialize` handshake. A `--resume`
 * spawn with a stale id prints "No conversation found" and exits well
 * inside ~1s (the supervisor's eager-spawn contract leans on the same
 * fast-exit); a spawn still alive after this delay is a healthy resume,
 * safe to handshake without perturbing the early-exit watcher's view of
 * a failing spawn. See `sendInitializeHandshake`.
 */
export const RESUME_INITIALIZE_DELAY_MS = 2_000;

/**
 * Cap on how long a `/rewind` respawn waits for its `initialize` handshake
 * ack before the `rewind_result` goes out anyway ([#step-7-2]). The ack is
 * what makes the sheet's progress state honest: it means "rewound AND the
 * resumed claude has loaded", so the sheet stays up — indeterminate — for the
 * whole opaque window rather than dismissing onto a session that cannot yet
 * answer. A claude that never acks (crashed on the respawn) must not strand
 * the sheet, so the wait is bounded; the rewind itself already succeeded on
 * disk by then, and the ack reports that truthfully.
 */
export const REWIND_READY_TIMEOUT_MS = 20_000;

/**
 * Soft cap on the number of raw lines captured from claude's stdout
 * during the replay window. claude on `--resume` with no new user
 * input is essentially silent (a `system:init` plus occasional
 * keep-alives). Anything beyond this is pathological — the bound
 * exists so a runaway claude can't exhaust the OS pipe buffer or
 * tugcode's heap during a slow replay. On overflow, further bytes are
 * still consumed (so claude stays unblocked) but discarded; a single
 * `dev::replay::live_buffer_overflow` warn line marks the event.
 */
export const REPLAY_LIVE_BUFFER_MAX = 1024;

/**
 * Default location of claude's per-session JSONL archive. Each
 * project gets its own subdirectory under this root, named by the
 * encoded form of the absolute project directory (see
 * {@link encodeProjectDir}). Tests inject an override via
 * {@link SessionManager}'s `claudeProjectsRoot` option so they read
 * fixtures from a tmp path instead.
 */
export const DEFAULT_CLAUDE_PROJECTS_ROOT =
  `${process.env.HOME ?? ""}/.claude/projects`;

/**
 * Encode an absolute project directory the way claude names its
 * per-project subdirectory under `~/.claude/projects/`. Claude
 * replaces every character outside `[A-Za-z0-9-]` with `-` — not just
 * slashes: dots and underscores collapse too (a `/` → `-`-only
 * encoding misses e.g. a `.tugtree/tugdash__foo` worktree path, and
 * the resulting miss makes every replay report `jsonl_missing`). The
 * leading `-` arises because the absolute path begins with `/`.
 *
 * Examples (verified against `~/.claude/projects/` on dev machines,
 * claude 2.1.198):
 *
 *   `/Users/foo`               → `-Users-foo`
 *   `/private/tmp/py-calc`     → `-private-tmp-py-calc`
 *   `/repo/.tugtree/a__b`      → `-repo--tugtree-a--b`
 *
 * Exported for unit tests.
 */
export function encodeProjectDir(absDir: string): string {
  return absDir.replace(/[^A-Za-z0-9-]/g, "-");
}

/**
 * Resolve the on-disk JSONL path for a given resume target.
 *
 *   `<claudeProjectsRoot>/<encodeProjectDir(projectDir)>/<id>.jsonl`
 */
export function jsonlPathFor(
  claudeProjectsRoot: string,
  projectDir: string,
  claudeSessionId: string,
): string {
  return join(
    claudeProjectsRoot,
    encodeProjectDir(projectDir),
    `${claudeSessionId}.jsonl`,
  );
}

/**
 * Resolve the directory holding a session's background-agent transcripts.
 * Claude Code writes them beside the main JSONL, under a directory named
 * by the session id (no `.jsonl` suffix):
 *
 *   `<claudeProjectsRoot>/<encodeProjectDir(projectDir)>/<id>/subagents`
 *
 * Each async `Agent` launch persists `agent-<agentId>.jsonl` (the agent's
 * full transcript) + `agent-<agentId>.meta.json` (the launching
 * `tool_use.id` + display fields) here.
 */
export function subagentsDirFor(
  claudeProjectsRoot: string,
  projectDir: string,
  claudeSessionId: string,
): string {
  return join(
    claudeProjectsRoot,
    encodeProjectDir(projectDir),
    claudeSessionId,
    "subagents",
  );
}

/**
 * Default on-disk location of the tugcast SessionLedger database.
 * Mirrors the Rust-side `SessionLedger::default_path()` resolution so
 * tugcast (writer) and tugcode (reader) hit the same file:
 *
 *   - macOS: `~/Library/Application Support/Tug/sessions.db`
 *   - Linux: `$XDG_DATA_HOME/tugcast/sessions.db` (falling back to
 *     `~/.local/share/tugcast/sessions.db`)
 *
 * Tests inject a different path via the `sessionsDbPath` constructor
 * option so they don't read the real user's database.
 */
export function defaultSessionsDbPath(): string {
  const home = homedir();
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "Tug", "sessions.db");
  }
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(home, ".local", "share");
  return join(base, "tugcast", "sessions.db");
}

/**
 * Result of attempting to read a JSONL file from disk. A discriminated
 * union so the resume-spawn flow can pass the outcome straight to
 * {@link translateJsonlSession} without losing the error category.
 */
export type JsonlReadResult =
  | { kind: "ok"; jsonl: string }
  | { kind: "missing"; message: string }
  | { kind: "unreadable"; message: string };

/**
 * One row of the `turns` submission journal read by tugcode through
 * the cross-process bun:sqlite handle. Mirrors the Rust `JournalRow`
 * shape (mid-turn-replay [Step 5.2](dash/tugplan-session-mid-turn-replay.md#step-5-2)).
 * Tugcode never writes to this table; tugcast's `dispatch_one`
 * intercept owns inserts ([Step 4.3](dash/tugplan-session-mid-turn-replay.md#step-4-3))
 * and the merger's `apply_outbound_turn_intercept` owns FIFO deletes
 * ([Step 5.3](dash/tugplan-session-mid-turn-replay.md#step-5-3)).
 */
interface JournalRow {
  journal_id: string;
  session_id: string;
  user_text: string;
  user_attachments: Buffer | Uint8Array;
  created_at: number;
}

/**
 * Build a multiset (text → count) of user-message texts seen in the
 * JSONL bytes. Used by [`runReplay`]'s pending-row injection
 * (mid-turn-replay [Step 5.6](dash/tugplan-session-mid-turn-replay.md#step-5-6))
 * to decide which journal rows still need a synthetic
 * `add_user_message` emit (i.e., the rows whose `user_text` does
 * NOT appear as a `user_message` line in JSONL — claude has not yet
 * acknowledged those submissions).
 *
 * Multi-occurrence handling: if claude has written N user_messages
 * with the same text, the count is N; the journal-pass decrements
 * the count once per matched row and emits a synthetic only when
 * the count is exhausted. This handles duplicate-text submissions
 * better than a Set membership check at no extra parse cost.
 *
 * Tool-result entries (also `type: "user"` in JSONL but with
 * `tool_result` content blocks) are skipped — they're not user
 * submissions. Malformed JSON lines are skipped silently (matches
 * the translator's permissiveness).
 */
export function extractUserMessageTextCounts(jsonl: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rawLine of jsonl.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const entry = parsed as { type?: unknown; message?: unknown };
    if (entry.type !== "user") continue;
    const message = entry.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    const textParts: string[] = [];
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") {
        textParts.push(b.text);
      }
    }
    if (textParts.length === 0) continue;
    const text = textParts.join("");
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return counts;
}

/**
 * Outcome of computing the conversation-rewind truncation boundary
 * ([#step-7-2]) for a `promptUuid` anchor against a session JSONL.
 *
 *   - `ok` — `boundary` is the line index of the anchor's user-prompt
 *     record; keeping `lines.slice(0, boundary)` drops that turn and
 *     everything after it (verified live: the resumed session forgets the
 *     dropped turns and nothing downstream references them).
 *   - `not_found` — no user-prompt record carries `promptUuid` (a stale
 *     anchor, or one pointing at a tool_result rather than a submission).
 *   - `compaction_blocked` — a `/compact` boundary (an on-disk
 *     `subtype:"compact_boundary"` system record or an `isCompactSummary`
 *     user record) sits between the anchor and the tip. Chopping across a
 *     compaction rewrites claude's resume pointers → "No conversation
 *     found", so the rewind is refused rather than silently corrupting the
 *     session ([#step-7a] constraint).
 */
export type ConversationTruncation =
  | { kind: "ok"; boundary: number }
  | { kind: "not_found" }
  | { kind: "compaction_blocked" }
  | { kind: "no_retained_turns" };

/**
 * Compute where to truncate a session JSONL to rewind the conversation to
 * the turn anchored at `promptUuid` ([#step-7-2]). Pure (no I/O) so the
 * boundary + compaction-guard logic is unit-testable without disk or a live
 * claude.
 *
 * The anchor is claude's user-prompt-record `uuid` ([#step-7a]). The on-disk
 * JSONL interleaves the conversational `user`/`assistant` records with
 * metadata records (`queue-operation`, `attachment`, `file-history-snapshot`,
 * `ai-title`, `mode`, …) that carry no `uuid`; only a genuine user
 * *submission* (a `user` record whose `message.content` is a string or an
 * array with a non-`tool_result` block) is a valid anchor. We find that
 * record and return its index as the slice boundary — `slice(0, boundary)`
 * retains every record before the picked turn.
 *
 * The compaction guard is checked first: if any record from the tip back to
 * the anchor is a compaction marker, the chop would cross it, so we refuse.
 *
 * A uuid does NOT identify one record. Claude Code re-appends a compaction's
 * preserved messages verbatim — same `uuid`, later position — so an anchor
 * can name two lines, and this path chops bytes off the real file. Two
 * properties keep it safe. The scan latches on the FIRST matching submission
 * (`boundary === -1`), so a re-appended copy can never move the boundary
 * later than the original. And a duplicate exists only because a compaction
 * created it, which puts a compaction marker between the first occurrence and
 * the tip — so the guard refuses a duplicated anchor outright. In normal
 * operation the anchor is captured live from the current turn and post-dates
 * the last compaction, so it is unique and resolves cleanly.
 *
 * Finally, the retained prefix must contain at least one *earlier* user
 * submission. Rewinding to the very first turn would leave only leading
 * bookkeeping records — claude rejects that on `--resume` ("No conversation
 * found"), and for the destructive in-place variant we'd have already
 * truncated the original. We refuse (`no_retained_turns`) rather than produce
 * an unresumable session; clearing the whole conversation is a new-session
 * operation, not a rewind.
 */
export function computeConversationTruncation(
  jsonl: string,
  promptUuid: string,
): ConversationTruncation {
  const lines = jsonl.split("\n");
  let boundary = -1;
  let sawCompactionAfter = false;
  let priorSubmissions = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const entry = parsed as {
      type?: unknown;
      subtype?: unknown;
      uuid?: unknown;
      isCompactSummary?: unknown;
      message?: { content?: unknown } | undefined;
    };
    // Compaction markers: a `compact_boundary` system record or an
    // `isCompactSummary` user record. Track whether one appears at or after
    // the anchor (the chop range).
    const isCompaction =
      (entry.type === "system" && entry.subtype === "compact_boundary") ||
      entry.isCompactSummary === true;
    const isUserSubmission =
      entry.type === "user" &&
      isUserSubmissionContent(entry.message?.content);
    if (boundary === -1) {
      if (
        isUserSubmission &&
        typeof entry.uuid === "string" &&
        entry.uuid === promptUuid
      ) {
        boundary = i;
      } else if (isUserSubmission) {
        // A user submission strictly before the anchor → the retained prefix
        // will hold at least one real turn.
        priorSubmissions += 1;
      }
    }
    // A compaction at or after the boundary is in the chop range. Until the
    // boundary is found we don't yet know if a compaction precedes it, so
    // record any compaction and resolve once the boundary is known.
    if (isCompaction && (boundary === -1 || i >= boundary)) {
      sawCompactionAfter = true;
    }
  }
  if (boundary === -1) return { kind: "not_found" };
  if (priorSubmissions === 0) return { kind: "no_retained_turns" };
  // Re-evaluate compaction strictly within [boundary, tip]: a compaction
  // BEFORE the boundary is fine (it stays in the retained prefix); only one
  // at/after the anchor blocks the chop.
  if (sawCompactionAfter) {
    for (let i = boundary; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = parsed as {
        type?: unknown;
        subtype?: unknown;
        isCompactSummary?: unknown;
      };
      if (
        (entry.type === "system" && entry.subtype === "compact_boundary") ||
        entry.isCompactSummary === true
      ) {
        return { kind: "compaction_blocked" };
      }
    }
  }
  return { kind: "ok", boundary };
}

/**
 * True when a JSONL `user` record's `message.content` is a genuine user
 * submission (string content, or an array carrying at least one non-
 * `tool_result` block) rather than a tool-result echo. Mirrors the
 * submission test in {@link routeTopLevelEvent}'s `promptUuid` capture so a
 * tool_result `user` record is never mistaken for a rewind anchor.
 */
function isUserSubmissionContent(content: unknown): boolean {
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (typeof block !== "object" || block === null) return false;
    return (block as { type?: unknown }).type !== "tool_result";
  });
}

/**
 * Default JSONL writer ([#step-7-2] conversation rewind). Writes the
 * truncated session bytes back to disk. Replaceable from tests via
 * {@link SessionManager}'s `jsonlWriter` option so unit tests never touch a
 * real `~/.claude/projects` file.
 */
export async function defaultJsonlWriter(
  path: string,
  content: string,
): Promise<void> {
  await Bun.write(path, content);
}

/**
 * Default JSONL reader. Uses `Bun.file(path)` and treats `ENOENT` as
 * `missing`, every other error as `unreadable`. Replaceable from
 * tests via {@link SessionManager}'s `jsonlReader` option.
 */
export async function defaultJsonlReader(
  path: string,
): Promise<JsonlReadResult> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return { kind: "missing", message: `JSONL not found at ${path}` };
    }
    const jsonl = await file.text();
    return { kind: "ok", jsonl };
  } catch (err) {
    return {
      kind: "unreadable",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Narrow the parsed `.meta.json` sidecar to a {@link SubagentTranscriptMeta}.
 * `toolUseId` is required (it is the splice linkage key); a sidecar without a
 * string `toolUseId` is unusable and yields `undefined` so the caller skips it.
 */
function narrowSubagentMeta(value: unknown): SubagentTranscriptMeta | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.toolUseId !== "string" || v.toolUseId.length === 0) {
    return undefined;
  }
  return {
    toolUseId: v.toolUseId,
    agentType: typeof v.agentType === "string" ? v.agentType : undefined,
    description: typeof v.description === "string" ? v.description : undefined,
    spawnDepth: typeof v.spawnDepth === "number" ? v.spawnDepth : undefined,
  };
}

/**
 * Parse a subagent JSONL body into entries, dropping blank/malformed lines.
 * Malformed lines are tolerated (skipped) rather than failing the whole
 * transcript — the same permissiveness the main-JSONL translator applies.
 */
function parseSubagentEntries(jsonl: string): JsonlEntry[] {
  const entries: JsonlEntry[] = [];
  for (const rawLine of jsonl.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    try {
      entries.push(JSON.parse(line) as JsonlEntry);
    } catch {
      // Skip the malformed line; a partial transcript still restores the
      // calls that did parse.
    }
  }
  return entries;
}

/**
 * Discover and read every background-agent transcript in a session's
 * `subagents/` directory (see {@link subagentsDirFor}). Each pairs an
 * `agent-<agentId>.jsonl` body with its `agent-<agentId>.meta.json` sidecar.
 *
 * Best-effort and shape-guarded: a missing directory yields `[]`; a file
 * whose meta is missing / unparseable / lacks a `toolUseId`, or whose body
 * can't be read, is skipped (the caller may log). Reading never throws and
 * never blocks the resume — a session with no restorable subagent data
 * simply replays as it does today.
 *
 * `dir` defaults to the real filesystem; tests point it at a fixture
 * directory of real captured transcripts.
 */
export async function readSubagentTranscripts(
  dir: string,
): Promise<SubagentTranscript[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const transcripts: SubagentTranscript[] = [];
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    const stem = name.slice(0, -".meta.json".length);
    const jsonlName = `${stem}.jsonl`;
    if (!names.includes(jsonlName)) continue;
    try {
      const metaText = await Bun.file(join(dir, name)).text();
      const meta = narrowSubagentMeta(JSON.parse(metaText));
      if (meta === undefined) continue;
      const bodyText = await Bun.file(join(dir, jsonlName)).text();
      const entries = parseSubagentEntries(bodyText);
      transcripts.push({ meta, entries });
    } catch {
      // Skip an unreadable pair; other transcripts still restore.
    }
  }
  return transcripts;
}

/**
 * Count newline characters without allocating a split array — the
 * `perf.replay_read` line count runs against whale-sized JSONLs where
 * a `split("\n")` just for counting would double the read cost.
 */
function countNewlines(s: string): number {
  let n = 0;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) {
    n += 1;
  }
  return n;
}

function logReplay(event: string, fields: Record<string, unknown>): void {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${formatReplayValue(v)}`);
  }
  console.log(`[dev::replay::${event}] ${parts.join(" ")}`);
}

function formatReplayValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") {
    if (v.length === 0 || /[\s"']/.test(v)) return JSON.stringify(v);
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------
// Exported pure functions for testability
// ---------------------------------------------------------------------------

/**
 * Build Anthropic-API content blocks from the tugcast journal's
 * legacy `(text, attachments)` shape — flat: `text` first (if
 * non-empty), then all attachments in order. Used on the never-drop
 * synthetic emit path (`injectPendingRowSynthetics`) where the
 * source of truth is the journal's legacy columns, not a live
 * `user_message` frame.
 *
 * Renamed from `buildContentBlocks` (Step 5c). The live
 * `handleUserMessage` path no longer constructs content blocks here
 * — the inbound `user_message` frame already carries `content`, and
 * the SDK forwarding is pass-through. This helper survives because
 * the never-drop synthetic must bridge from the journal's legacy
 * shape (tugcast's `session_ledger.rs` `turns.user_text` /
 * `turns.user_attachments`) to the wire's content-block shape.
 *
 * Interleaving is lost here — the original atom positions cannot be
 * recovered from the flat journal columns. The never-drop path is
 * the gap-bridge, not the primary restore path. The JSONL-replay
 * path preserves interleaving because Anthropic records `content`
 * arrays verbatim.
 *
 * Validates image types and sizes per PN-12 (#pn-image-limits).
 * Exported for unit testing.
 */
export function buildContentBlocksFromLegacyJournal(
  text: string,
  attachments: Array<Attachment>
): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  // Text always comes first.
  if (text.length > 0) {
    blocks.push({ type: "text", text });
  }

  for (const att of attachments) {
    // Inline attachments are images-only — the Claude Agent SDK's
    // user-message input pipeline accepts text + image content
    // blocks only. Any non-image attachment in a legacy journal row
    // is silently dropped (an artifact of an older drop pipeline
    // that briefly supported text-file attachments; no new
    // submissions write them).
    if (!att.media_type.startsWith("image/")) continue;
    // Validate media_type per PN-12.
    if (!ALLOWED_IMAGE_TYPES.has(att.media_type)) {
      throw new Error(
        `Unsupported image type: ${att.media_type}. Supported: image/png, image/jpeg, image/gif, image/webp`
      );
    }
    // Validate decoded size (~5MB limit). Base64 encodes 3 bytes as 4 chars.
    const sizeBytes = Math.ceil((att.content.length * 3) / 4);
    if (sizeBytes > MAX_IMAGE_SIZE_BYTES) {
      throw new Error(
        `Image exceeds ~5MB limit: ${att.filename} (${Math.round(sizeBytes / 1024 / 1024)}MB)`
      );
    }
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: att.media_type,
        data: att.content,
      },
    });
  }

  // Ensure at least one block (fallback for empty text + no attachments).
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }

  return blocks;
}

/**
 * Configuration for building claude CLI spawn arguments.
 */
export interface ClaudeSpawnConfig {
  pluginDir: string;
  /**
   * Model selector for `--model`. When omitted / null, no `--model` flag is
   * passed and the claude CLI uses its own configured default model — which
   * is exactly what the `default` selector means, so it records as null.
   */
  model?: string | null;
  permissionMode: string;
  /**
   * Reasoning-effort level for `--effort` ([#step-4]). When omitted / null,
   * no `--effort` flag is passed and the model runs at its built-in default
   * (claude exposes no current-effort value, so unset is genuinely unset).
   */
  effort?: string | null;
  /**
   * Extra working directories granted as claude read roots ([#step-13c]),
   * each emitted as an additional `--add-dir`. Accumulated by `/add-dir` and
   * re-applied on every (re)spawn, like {@link effort}.
   */
  additionalDirectories?: readonly string[];
  sessionId: string | null;
  continue?: boolean;
  forkSession?: boolean;
  sessionIdOverride?: string;
}

/**
 * Dev-side system-prompt nudge appended to every spawn.
 *
 * Dev renders each tool call as a structured visual block (icon +
 * verb-qualified header + per-tool body), so the user sees the input
 * and result without the model needing to restate it in prose. Without
 * a nudge, Claude defaults to "tool result + prose summary" — which
 * reads as redundant duplication once the bespoke rendering lands.
 * The nudge is intentionally short: one sentence stating the surface
 * contract, one sentence carving out the legitimate restate case
 * (synthesis across multiple results, analysis the user can't derive
 * from the raw output, framing for what to do next).
 *
 * Companion to the tool-block chrome's `fold` opt-in
 * (`tugdeck/src/components/tugways/cards/tool-blocks/tool-block-chrome.tsx`)
 * — the chrome lets users hide the block once they've read it; this
 * nudge reduces the volume of restatement that makes hiding feel
 * necessary in the first place. Tackling redundancy from both ends.
 */
const SESSION_SYSTEM_PROMPT_NUDGE =
  "The user is reading this conversation in Dev, which renders each " +
  "tool call as a structured visual block — icon, verb-qualified header, " +
  "and per-tool body showing inputs and results. The block is the user's " +
  "primary surface for what the tool did and what it returned. Do not " +
  "restate or summarize a tool's input or result in prose unless you are " +
  "adding analysis, synthesis across multiple calls, or framing for what " +
  "comes next — repeating what the block already shows is duplication, " +
  "not communication. " +
  "This applies with extra force to summary-shaped tools like WebFetch " +
  "and Read whose result IS the model-readable rendering of the source: " +
  "the block already shows the markdown summary or file contents the " +
  "user asked for; restating those bullets or paragraphs in prose is " +
  "pure noise. The block stands on its own — your prose should add what " +
  "the block can't (cross-source synthesis, a specific judgment call, " +
  "the next step you're about to take).";

/**
 * The Tug application-data root (`<data_dir>/Tug`).
 *
 * Registered as a claude read root on every spawn (via `--add-dir`) so the
 * per-project runtime state that now lives outside the repo — the dash-log,
 * the code-sign sentinel, and future side-command output — is readable without
 * a permission prompt. One entry covers every `Tug/projects/<slug>/` subdir.
 *
 * Honors `TUG_DATA_DIR` as the base override (matching
 * `tugutil_core::project_state_dir`); otherwise the macOS app-support dir.
 */
export function tugDataRoot(): string {
  const override = process.env.TUG_DATA_DIR;
  const base =
    override && override.length > 0
      ? override
      : join(homedir(), "Library", "Application Support");
  return join(base, "Tug");
}

/**
 * Build the CLI argument array for spawning the claude process.
 * Exported for unit tests.
 */
export function buildClaudeArgs(config: ClaudeSpawnConfig): string[] {
  // Validate session flag combinations per D10.
  const sessionFlagCount = [
    !!config.sessionId,
    !!config.continue,
    !!config.sessionIdOverride,
  ].filter(Boolean).length;
  if (sessionFlagCount > 1) {
    throw new Error("Only one of sessionId, continue, or sessionIdOverride may be set");
  }

  if (config.forkSession && !config.sessionId && !config.continue) {
    throw new Error("forkSession requires either sessionId or continue to be set");
  }

  const args: string[] = [
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--permission-prompt-tool", "stdio",
    "--include-partial-messages",
    "--replay-user-messages",
    "--plugin-dir", config.pluginDir,
    "--permission-mode", config.permissionMode,
    "--append-system-prompt", SESSION_SYSTEM_PROMPT_NUDGE,
    // Grant frictionless reads of out-of-repo Tug runtime state (dash-log,
    // code-sign sentinel, side-command output) for every session.
    "--add-dir", tugDataRoot(),
  ];

  // Extra working directories from `/add-dir` ([#step-13c]) — one `--add-dir`
  // each, applied on every (re)spawn so they survive resume / fork / continue.
  for (const dir of config.additionalDirectories ?? []) {
    args.push("--add-dir", dir);
  }

  if (config.model) {
    args.push("--model", config.model);
  }

  if (config.effort) {
    args.push("--effort", config.effort);
  }

  if (config.sessionId) {
    args.push("--resume", config.sessionId);
  }

  if (config.continue) {
    args.push("--continue");
  }

  if (config.forkSession) {
    args.push("--fork-session");
  }

  if (config.sessionIdOverride) {
    args.push("--session-id", config.sessionIdOverride);
  }

  return args;
}

/**
 * Context passed to mapStreamEvent and routeTopLevelEvent for IPC message construction.
 */
export interface EventMappingContext {
  msgId: string;
  /**
   * The owning turn's synthesized opener id ({@link ActiveTurn.openerId}).
   * The `msg_id` fallback for frames synthesized while claude has not
   * revealed a `message.id` (`msgId === ""`) — e.g. the local-command
   * stdout echo of a `/compact` or `/model` turn. Empty string when no
   * turn context applies.
   */
  openerId: string;
  seq: number;
  rev: number;
  /**
   * Whether a preceding `compact_boundary` this turn has armed the summary
   * capture ([P08]). The next synthetic `user` event carrying a plain-string
   * summary is captured as a `compact_summary` frame while this is true.
   * `routeTopLevelEvent` reads this and returns the updated state on
   * {@link TopLevelRoutingResult.pendingCompactSummary}; the caller latches it
   * back onto {@link ActiveTurn.pendingCompactSummary} across events.
   */
  pendingCompactSummary?: boolean;
}

/**
 * Result of mapping a single stream-json (inner) event to IPC outbound messages.
 *
 * `messageId` carries claude's `message.id` whenever the stream event reveals
 * it (today: `message_start` only; future event types may also expose it).
 * `dispatchEventToTurn` slides `ActiveTurn.currentMessageId` to this value so
 * subsequent events whose claude shape doesn't carry an id directly
 * (`content_block_delta`, `content_block_start`) emit under the right key.
 * Absent on events that don't reveal the id.
 *
 * `messageStartUsage` / `messageDeltaUsage` carry the raw token-bearing
 * `usage` object whenever a `message_start` / `message_delta` revealed
 * one. `dispatchEventToTurn` latches them onto `ActiveTurn` so the
 * terminal `result` event can emit `cost_update.usage` from the turn's
 * LAST tool-loop iteration — never `result.usage`, which is the
 * per-turn SUM across every iteration. Absent on every other event.
 */
export interface EventMappingResult {
  messages: OutboundMessage[];
  newRev: number;
  partialText: string;
  gotResult: boolean;
  messageId?: string;
  messageStartUsage?: Record<string, unknown>;
  messageDeltaUsage?: Record<string, unknown>;
}

/**
 * Result metadata from a result event, stored for CostUpdate emission.
 */
export interface ResultMetadata {
  subtype: string;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  permission_denials?: unknown[];
  is_api_error?: boolean;
  resultValue?: string;
}

/**
 * Result of routing a single top-level stdout message to IPC outbound messages.
 * Per D03 (#d03-event-routing) two-tier routing architecture.
 */
/**
 * Clamp a `system/task_notification` summary to a terse, single-line wake
 * label. The wake-trigger chip is a subdued marker naming what woke the
 * session ("Agent \"X\" completed") — it is NOT a surface for the agent's
 * answer, which renders in full under the Agent block. Claude Code
 * 2.1.150–2.1.173 emitted a terse `summary`; 2.1.207 began packing the
 * agent's entire final message into that same field, which the chip then
 * rendered as a wall of raw markdown. Take the first non-empty line, strip a
 * leading markdown heading / quote / list marker, and cap the length so the
 * chip stays a one-liner whatever the field carries. An already-terse
 * summary (a scheduled-wake label, an older-CLI notice) passes through
 * unchanged. The replay path reads the JSONL envelope's own short
 * `<summary>`, so it needs no clamp — only the live event field bloated.
 */
export function terseWakeSummary(summary: string): string {
  const firstLine = summary
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return "";
  const unmarked = firstLine.replace(/^(?:#{1,6}|>|[-*+])\s+/, "");
  const MAX = 140;
  return unmarked.length > MAX
    ? `${unmarked.slice(0, MAX - 1).trimEnd()}…`
    : unmarked;
}

/**
 * Pure factory for the {@link WakeStarted} IPC frame from a
 * `system/task_notification` event. Returns null for events that
 * are not task notifications, or for ones missing the expected
 * `task_id` field.
 *
 * The SDK's `SDKTaskNotificationMessage` payload
 * (`@anthropic-ai/claude-agent-sdk/sdk.d.ts:1659-1668`) is forwarded
 * onto `wake_trigger`, except `summary` is clamped to a terse label via
 * {@link terseWakeSummary}. Missing optional fields default to
 * empty strings or "stopped" for status — permissive on the wire so
 * a malformed event doesn't drop the wake bracket entirely.
 *
 * Caller (handleInterTurnEvent) is responsible for:
 *   - Side effects (writeLine, set isInWake, open ActiveTurn).
 *   - Idempotency (suppress emit on nested wake).
 *   - turnKey minting — NOT carried on the wire; the tugdeck store
 *     wrapper mints it on receipt, mirroring the existing
 *     add_user_message pattern.
 *
 * See `dash/tugplan-session-wake.md` [D02] for the detector
 * rationale and [Q01] for the empirical wire shape this contract is
 * pinned against.
 */
export function buildWakeStartedMessage(
  event: Record<string, unknown>,
  sessionId: string,
): WakeStarted | null {
  if (event.type !== "system" || event.subtype !== "task_notification") {
    return null;
  }
  const taskId = event.task_id;
  if (typeof taskId !== "string" || taskId.length === 0) {
    return null;
  }
  const status = event.status as "completed" | "failed" | "stopped" | undefined;
  return {
    type: "wake_started",
    session_id: sessionId,
    wake_trigger: {
      task_id: taskId,
      tool_use_id: (event.tool_use_id as string) ?? "",
      status: status ?? "stopped",
      summary: terseWakeSummary((event.summary as string) ?? ""),
      output_file: (event.output_file as string) ?? "",
    },
    ipc_version: 2,
  };
}

/**
 * Distinct `system/<subtype>` values already reported by
 * {@link noteUnhandledSystemSubtype}, so each unknown subtype is logged
 * once per process rather than on every occurrence (`system/status`
 * fires ~once per API request — many times a turn).
 */
const reportedUnhandledSystemSubtypes = new Set<string>();

/**
 * Surface a `system` event whose `subtype` tugcode does not translate.
 * The `case "system"` dispatch translates a known set
 * (`init` / `compact_boundary` / `api_retry` / `model_refusal_fallback`
 * / `task_started` / `task_updated` / `task_progress`) and historically
 * had no final branch, so a newly-introduced subtype vanished silently —
 * the failure mode that hid `task_progress`. This makes the next wire
 * addition visible (e.g. `system/status`) so it can be classified and
 * forwarded deliberately rather than discovered by accident.
 */
function noteUnhandledSystemSubtype(subtype: string): void {
  if (reportedUnhandledSystemSubtypes.has(subtype)) return;
  reportedUnhandledSystemSubtypes.add(subtype);
  console.log(`[tugcode] unhandled system subtype="${subtype}" (not forwarded)`);
}

/**
 * Pure factory for the {@link TaskStarted} IPC frame from a
 * `system/task_started` event. Returns null for non-matching events or
 * ones missing the required `task_id` / `tool_use_id` strings —
 * permissive on the optional fields so a partial frame still forwards.
 *
 * Note the frame fires for foreground subagents too (shape-identical
 * to the background case); tugcode forwards verbatim and leaves the
 * background gate to the consumer, which holds the launching tool
 * call's `input.run_in_background`. Empirical contract:
 * `stream-json-catalog/v2.1.173-jobs-spike/`.
 */
export function buildTaskStartedMessage(
  event: Record<string, unknown>,
  sessionId: string,
): TaskStarted | null {
  if (event.type !== "system" || event.subtype !== "task_started") {
    return null;
  }
  const taskId = event.task_id;
  const toolUseId = event.tool_use_id;
  if (typeof taskId !== "string" || taskId.length === 0) return null;
  if (typeof toolUseId !== "string" || toolUseId.length === 0) return null;
  const subagentType = event.subagent_type;
  return {
    type: "task_started",
    session_id: sessionId,
    task_id: taskId,
    tool_use_id: toolUseId,
    description: typeof event.description === "string" ? event.description : "",
    task_type: typeof event.task_type === "string" ? event.task_type : "",
    ...(typeof subagentType === "string" ? { subagent_type: subagentType } : {}),
    ipc_version: 2,
  };
}

/**
 * Pure factory for the {@link TaskUpdated} IPC frame from a
 * `system/task_updated` event. Flattens claude's `patch` object onto
 * the frame (`patch.status` / `patch.end_time`). Returns null for
 * non-matching events or ones missing `task_id` / `patch.status`.
 */
export function buildTaskUpdatedMessage(
  event: Record<string, unknown>,
  sessionId: string,
): TaskUpdated | null {
  if (event.type !== "system" || event.subtype !== "task_updated") {
    return null;
  }
  const taskId = event.task_id;
  if (typeof taskId !== "string" || taskId.length === 0) return null;
  const patch =
    typeof event.patch === "object" && event.patch !== null
      ? (event.patch as Record<string, unknown>)
      : null;
  const status = patch?.status;
  if (typeof status !== "string" || status.length === 0) return null;
  const endTime = patch?.end_time;
  return {
    type: "task_updated",
    session_id: sessionId,
    task_id: taskId,
    status,
    ...(typeof endTime === "number" ? { end_time: endTime } : {}),
    ipc_version: 2,
  };
}

/**
 * The trio a background-agent async-launch echo hands tugcode — enough
 * to start a {@link SubagentTailer} with no directory scan or sidecar
 * parse: the launching `Agent` call's id (stamps every child frame),
 * the agent id (the tailer map key, also the task id of its lifecycle
 * frames), and the live-growing transcript path.
 */
export interface AsyncLaunch {
  parentToolUseId: string;
  agentId: string;
  outputFile: string;
}

/**
 * Narrow a raw claude stdout event to an {@link AsyncLaunch}, or
 * `undefined` for anything that isn't a background-agent launch echo.
 *
 * The echo is a `user` event whose **live** `tool_use_result` field
 * (snake_case — the persisted JSONL's camelCase `toolUseResult` is the
 * replay path's concern) carries `isAsync: true` /
 * `status: "async_launched"` plus `agentId` + `outputFile`, and whose
 * `message.content` holds the linked `tool_result` block naming the
 * launching `Agent` call. All four fields must be present — a
 * foreground result, or a drifted echo missing the linkage, yields
 * `undefined` and no tailer starts.
 */
export function extractAsyncLaunch(
  event: Record<string, unknown>,
): AsyncLaunch | undefined {
  if (event.type !== "user") return undefined;
  const result = event.tool_use_result;
  if (result === null || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  if (r.isAsync !== true && r.status !== "async_launched") return undefined;
  const agentId = r.agentId;
  const outputFile = r.outputFile;
  if (typeof agentId !== "string" || agentId.length === 0) return undefined;
  if (typeof outputFile !== "string" || outputFile.length === 0) {
    return undefined;
  }
  const message = event.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content as Array<Record<string, unknown>>) {
    if (
      block.type === "tool_result" &&
      typeof block.tool_use_id === "string" &&
      block.tool_use_id.length > 0
    ) {
      return { parentToolUseId: block.tool_use_id, agentId, outputFile };
    }
  }
  return undefined;
}

/**
 * Pure factory for the {@link TaskProgress} IPC frame from a
 * `system/task_progress` event. Returns null for non-matching events or
 * ones missing the required `task_id` / `tool_use_id` strings —
 * permissive on the optional progress detail (`last_tool_name`,
 * `usage`) so a partial frame still forwards. Like
 * {@link buildTaskStartedMessage} the frame fires for foreground
 * subagents too; tugcode forwards verbatim and leaves the background
 * gate to the consumer.
 */
export function buildTaskProgressMessage(
  event: Record<string, unknown>,
  sessionId: string,
): TaskProgress | null {
  if (event.type !== "system" || event.subtype !== "task_progress") {
    return null;
  }
  const taskId = event.task_id;
  const toolUseId = event.tool_use_id;
  if (typeof taskId !== "string" || taskId.length === 0) return null;
  if (typeof toolUseId !== "string" || toolUseId.length === 0) return null;
  const subagentType = event.subagent_type;
  const lastToolName = event.last_tool_name;
  const rawUsage =
    typeof event.usage === "object" && event.usage !== null
      ? (event.usage as Record<string, unknown>)
      : null;
  const usage = rawUsage
    ? {
        ...(typeof rawUsage.total_tokens === "number"
          ? { total_tokens: rawUsage.total_tokens }
          : {}),
        ...(typeof rawUsage.tool_uses === "number"
          ? { tool_uses: rawUsage.tool_uses }
          : {}),
        ...(typeof rawUsage.duration_ms === "number"
          ? { duration_ms: rawUsage.duration_ms }
          : {}),
      }
    : undefined;
  return {
    type: "task_progress",
    session_id: sessionId,
    task_id: taskId,
    tool_use_id: toolUseId,
    description: typeof event.description === "string" ? event.description : "",
    ...(typeof subagentType === "string" ? { subagent_type: subagentType } : {}),
    ...(typeof lastToolName === "string" ? { last_tool_name: lastToolName } : {}),
    ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
    ipc_version: 2,
  };
}

export interface TopLevelRoutingResult {
  messages: OutboundMessage[];
  gotResult: boolean;
  sessionId?: string;
  streamEvent?: Record<string, unknown>;
  controlRequest?: Record<string, unknown>;
  cancelledRequestId?: string;
  parentToolUseId?: string;
  resultMetadata?: ResultMetadata;
  systemMetadata?: Record<string, unknown>;
  /**
   * Claude's `message.id` for the turn, when revealed by this top-level
   * event (today: the `assistant` snapshot only). Belt-and-suspenders to the
   * `mapStreamEvent` `message_start` path: whichever lands first slides
   * `ActiveTurn.currentMessageId` to it. Absent on events that don't reveal
   * the id.
   */
  messageId?: string;
  /**
   * Claude's user-prompt-record `uuid`, set when this top-level event is
   * the live echo of the turn's own submission (`--replay-user-messages`).
   * The `/rewind` anchor ([#step-7-1]); `dispatchEventToTurn` captures it
   * onto `ActiveTurn.promptUuid` and emits a {@link PromptAnchor}. Absent
   * on tool-result `user` events and on echoes carrying no `uuid`.
   */
  promptUuid?: string;
  /**
   * Updated armed state for the ordering-armed summary capture ([P08]).
   * `true` after a `compact_boundary` arms it, `false` after the summary is
   * captured or a `result` disarms it, `undefined` when this event leaves the
   * armed state unchanged. `dispatchEventToTurn` writes any non-`undefined`
   * value back onto {@link ActiveTurn.pendingCompactSummary}.
   */
  pendingCompactSummary?: boolean;
}

/**
 * Hex-encode the first `maxBytes` bytes of an event's JSON serialization,
 * for the `unknown_event` frame's `payload_hex_preview`. A short, bounded
 * peek at an untranslated payload — enough for an operator to recognize
 * the shape without forwarding (and bloating the wire with) the whole
 * thing. Serialization failures (e.g. a cyclic payload) yield an empty
 * preview rather than throwing. Pure; exported for unit testing.
 */
export function payloadHexPreview(payload: unknown, maxBytes = 64): string {
  let json: string;
  try {
    json = JSON.stringify(payload) ?? "";
  } catch {
    json = "";
  }
  const bytes = new TextEncoder().encode(json).subarray(0, maxBytes);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Route a single top-level stdout message to IPC outbound messages.
 * Handles all 8+ top-level message types per D03.
 * Exported for unit testing.
 *
 * `lastIterationUsage` is the `usage` of the turn's LAST tool-loop
 * iteration — the most recent `message_delta` (or `message_start`
 * fallback) `ActiveTurn` latched while draining the turn. The `result`
 * branch emits it as `cost_update.usage`. `result.usage` (on the event
 * itself) is deliberately NOT used for the wire `usage`: it is the
 * per-turn SUM across every API call, so a K-tool-call turn would
 * over-report context by ~K×. `result.usage` still flows into
 * `resultMetadata.usage` untouched. Omitted (pure-function callers
 * with no turn) → `cost_update.usage` is `{}`.
 */
export function routeTopLevelEvent(
  event: Record<string, unknown>,
  ctx: EventMappingContext,
  lastIterationUsage?: Record<string, unknown> | null
): TopLevelRoutingResult {
  const messages: OutboundMessage[] = [];
  let gotResult = false;
  let sessionId: string | undefined;
  let streamEvent: Record<string, unknown> | undefined;
  let controlRequest: Record<string, unknown> | undefined;
  let cancelledRequestId: string | undefined;
  let parentToolUseId: string | undefined;
  let resultMetadata: ResultMetadata | undefined;
  let systemMetadata: Record<string, unknown> | undefined;
  let messageId: string | undefined;
  let promptUuid: string | undefined;
  // Undefined = this event leaves the armed summary-capture state unchanged;
  // true/false = it arms/disarms it ([P08]).
  let pendingCompactSummary: boolean | undefined;

  // parent_tool_use_id is present on all 5 message types per PN-8.
  const rawParentId = event.parent_tool_use_id;
  if (typeof rawParentId === "string" && rawParentId.length > 0) {
    parentToolUseId = rawParentId;
  }

  const eventType = event.type as string | undefined;

  switch (eventType) {
    case "system": {
      const subtype = event.subtype as string | undefined;
      if (subtype === "init") {
        const sid = event.session_id as string | undefined;
        if (sid) {
          sessionId = sid;
        }
        systemMetadata = {
          tools: event.tools,
          model: event.model,
          permissionMode: event.permissionMode,
          cwd: event.cwd,
          slash_commands: event.slash_commands,
          plugins: event.plugins,
          agents: event.agents,
          skills: event.skills,
          mcp_servers: event.mcp_servers,
          claude_code_version: event.claude_code_version,
          output_style: event.output_style,
          fast_mode_state: event.fast_mode_state,
          apiKeySource: event.apiKeySource,
        };
        // Emit SystemMetadata IPC so the frontend can populate settings and help panels.
        const ccVersion =
          typeof event.claude_code_version === "string" &&
          event.claude_code_version.length > 0
            ? event.claude_code_version
            : undefined;
        const sysMsg: SystemMetadata = {
          type: "system_metadata",
          session_id: sid || "",
          cwd: (event.cwd as string) || "",
          tools: (event.tools as unknown[]) || [],
          model: (event.model as string) || "",
          permissionMode: (event.permissionMode as string) || "",
          slash_commands: (event.slash_commands as unknown[]) || [],
          plugins: (event.plugins as unknown[]) || [],
          agents: (event.agents as unknown[]) || [],
          skills: (event.skills as unknown[]) || [],
          mcp_servers: (event.mcp_servers as unknown[]) || [],
          // Only include `version` when claude's init event actually
          // carried `claude_code_version`. An empty string here would
          // race the live init through the merge layer and mislead
          // the frontend into showing "Claude Code " (empty) instead
          // of letting its fallback chain fire — see the rename plan
          // and the merge rules in `session_metadata_merge.rs`.
          ...(ccVersion !== undefined ? { version: ccVersion } : {}),
          output_style: (event.output_style as string) || "",
          fast_mode_state: (event.fast_mode_state as string) || "",
          apiKeySource: (event.apiKeySource as string) || "",
          ipc_version: 2,
        };
        messages.push(sysMsg);
      } else if (subtype === "compact_boundary") {
        // Forward claude's `compact_metadata` (trigger + pre-compaction
        // token count) when present so the session-card divider can show it;
        // the bare marker stands alone otherwise. The SDK shape is
        // snake_case (`compact_metadata.pre_tokens`); tolerate a camelCase
        // variant defensively.
        const meta = (event.compact_metadata ?? event.compactMetadata ?? {}) as {
          trigger?: unknown;
          pre_tokens?: unknown;
          preTokens?: unknown;
          post_tokens?: unknown;
          postTokens?: unknown;
        };
        const preTokens =
          typeof meta.pre_tokens === "number"
            ? meta.pre_tokens
            : typeof meta.preTokens === "number"
              ? meta.preTokens
              : undefined;
        const postTokens =
          typeof meta.post_tokens === "number"
            ? meta.post_tokens
            : typeof meta.postTokens === "number"
              ? meta.postTokens
              : undefined;
        const marker: CompactBoundary = {
          type: "compact_boundary",
          ...(typeof meta.trigger === "string" ? { trigger: meta.trigger } : {}),
          ...(preTokens !== undefined ? { pre_tokens: preTokens } : {}),
          ...(postTokens !== undefined ? { post_tokens: postTokens } : {}),
          ipc_version: 2,
        };
        messages.push(marker);
        // Arm the ordering-armed summary capture ([P08]): the next synthetic
        // `user` event carrying a plain-string summary is the compaction
        // summary (no `isCompactSummary` flag on the live wire — ordering
        // after the boundary is the reliable discriminator).
        pendingCompactSummary = true;
      } else if (subtype === "api_retry") {
        messages.push({
          type: "api_retry",
          attempt: (event.attempt as number) || 0,
          max_retries: (event.max_retries as number) || 10,
          retry_delay_ms: (event.retry_delay_ms as number) || 0,
          error_status: (event.error_status as number | null) ?? null,
          error: (event.error as string) || "unknown",
          ipc_version: 2,
        });
      } else if (subtype === "model_refusal_fallback") {
        // The model declined and the SDK retried on a fallback model — a
        // non-fatal recovery the session card surfaces as a one-shot notice.
        // Tolerate snake/camel field variants defensively.
        messages.push({
          type: "model_refusal_fallback",
          original_model:
            (event.originalModel as string) ??
            (event.original_model as string) ??
            "",
          fallback_model:
            (event.fallbackModel as string) ??
            (event.fallback_model as string) ??
            "",
          trigger: (event.trigger as string) || "",
          direction: (event.direction as string) || "",
          ipc_version: 2,
        });
      } else if (subtype === "task_started") {
        // Background-task lifecycle frames can fire mid-turn (the
        // launching tool call runs inside the turn; a fast job can
        // even flip terminal before the turn ends — observed in the
        // v2.1.173-jobs-spike capture). Forward both verbatim.
        const frame = buildTaskStartedMessage(
          event,
          (event.session_id as string) || "",
        );
        if (frame !== null) messages.push(frame);
      } else if (subtype === "task_updated") {
        const frame = buildTaskUpdatedMessage(
          event,
          (event.session_id as string) || "",
        );
        if (frame !== null) messages.push(frame);
      } else if (subtype === "task_progress") {
        // In-flight background-agent progress (NEW on the 2.1.197-era
        // wire). Carries the agent's most recent tool + cumulative
        // usage so the JOBS cell can show what a backgrounded agent is
        // doing instead of a bare running→done flip. Like the other
        // task frames it can fire mid-turn (the agent runs concurrently
        // with the launching turn).
        const frame = buildTaskProgressMessage(
          event,
          (event.session_id as string) || "",
        );
        if (frame !== null) messages.push(frame);
      } else if (subtype === "status") {
        // Agent activity heartbeat (NEW at 2.1.197) — `system/status`,
        // one per outbound API request (`status:"requesting"` observed).
        // Deliberately NOT forwarded: it is a foreground per-request
        // pulse whose "the loop is alive" meaning is already conveyed by
        // the deck's `activeTurn`-driven live-activity readout, and
        // piping a high-frequency heartbeat into the catalog-pinned wire
        // earns drift churn for no gain the live line doesn't provide.
        // Characterized + handled here (not a silent drop) so the choice
        // is explicit; revisit if a finer foreground request pulse is
        // ever wanted.
      } else if (subtype !== undefined) {
        // Guard against silently dropping a newly-introduced system
        // subtype (e.g. `system/status`, observed first at 2.1.197).
        // The catch-all dispatch had NO final branch, so any unknown
        // subtype vanished with no trace — exactly how `task_progress`
        // went unforwarded for several releases. Log each distinct
        // subtype once per process so a future wire addition surfaces
        // in the dev log / stderr instead of disappearing.
        noteUnhandledSystemSubtype(subtype);
      }
      break;
    }

    case "assistant": {
      // The assistant top-level event is a complete snapshot of the message.
      // For normal API responses, text was already delivered via stream_event
      // as partial assistant_text messages — we skip re-emitting to avoid
      // duplicates. Tool use blocks are still emitted since they may not
      // arrive via streaming.
      //
      // EXCEPTION: Synthetic messages (model: "<synthetic>") are produced by
      // built-in slash commands like /cost, /compact. These have no streaming
      // events — the assistant message is the only source of text. Emit it.
      const message = event.message as Record<string, unknown> | undefined;
      const rawId = message?.id;
      if (typeof rawId === "string" && rawId.length > 0) {
        messageId = rawId;
      }
      // Use claude's id for any messages built here when present, so the
      // first emit (synthetic text or tool_use within this snapshot)
      // already carries the same id the wire / reducer will use.
      // dispatchEventToTurn slides `turn.currentMessageId` to this id
      // after this function returns; the messages built below already
      // carry it via this local.
      const effectiveMsgId = messageId ?? ctx.msgId;
      const model = (message?.model as string) || "";
      const isSynthetic = model === "<synthetic>";
      const content = (message?.content as Array<Record<string, unknown>>) || [];

      // A message that closed on `max_tokens` was cut off at the output
      // ceiling, not a clean `end_turn`. Surface a one-shot notice so the
      // truncation is visible rather than reading as a silent stop. (Live
      // path only — replay has its own translator and shouldn't re-fire a
      // past turn's truncation.)
      if (message?.stop_reason === "max_tokens") {
        messages.push({ type: "output_truncated", ipc_version: 2 });
      }

      for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
        const block = content[blockIndex];
        if (block.type === "text" && isSynthetic) {
          const text = (block.text as string) || "";
          if (text.length > 0) {
            // Synthetic messages have no streaming `content_block_start`
            // (they arrive as a complete snapshot). Synthesize one so
            // the reducer's mint path is uniform with the live and
            // replay paths per [D07].
            messages.push({
              type: "content_block_start",
              msg_id: effectiveMsgId,
              block_index: blockIndex,
              kind: "text",
              ipc_version: 2,
            });
            messages.push({
              type: "assistant_text",
              msg_id: effectiveMsgId,
              block_index: blockIndex,
              seq: ctx.seq,
              rev: ctx.rev,
              text,
              is_partial: false,
              status: "complete",
              ipc_version: 2,
            });
          }
        } else if (block.type === "tool_use") {
          // Emit content_block_start before tool_use for defensive
          // consistency with the streaming and replay paths. For a
          // tool_use that already arrived via the streaming wire's
          // content_block_start, the reducer's mint is idempotent so
          // this re-emit is a no-op. For a synthetic message whose
          // tool block has no streaming origin (rare — slash-command
          // outputs are usually pure text, but the type system doesn't
          // forbid synthetic tool blocks), this emission is the ONLY
          // mint signal the reducer gets; without it the tool would
          // arrive at the reducer without a minted ToolUseMessage and
          // be silently dropped.
          //
          // Wire-input boundary check: top-level assistant snapshots
          // MUST carry `id` and `name` on tool_use content blocks (the
          // snapshot is supposed to be the complete summary of the
          // message). Missing fields surface as a console.error;
          // emission proceeds so the reducer at least mints something.
          const toolUseId = (block.id as string) || "";
          const toolName = (block.name as string) || "";
          if (toolUseId === "" || toolName === "") {
            console.error(
              `[tugcode] assistant snapshot tool_use missing id or name (msg_id=${effectiveMsgId}, block_index=${blockIndex}, id="${toolUseId}", name="${toolName}")`,
            );
          }
          messages.push({
            type: "content_block_start",
            msg_id: effectiveMsgId,
            block_index: blockIndex,
            kind: "tool_use",
            tool_use_id: toolUseId,
            tool_name: toolName,
            ipc_version: 2,
          });
          messages.push({
            type: "tool_use",
            msg_id: effectiveMsgId,
            seq: ctx.seq,
            tool_name: toolName,
            tool_use_id: toolUseId,
            input: (block.input as object) || {},
            ipc_version: 2,
          });
        }
      }
      break;
    }

    case "user": {
      const message = event.message as Record<string, unknown> | undefined;
      const rawContent = message?.content;

      // Goal-evaluator feedback. While a `/goal` is active, the Stop-hook
      // evaluator injects synthetic user events (`isSynthetic: true`, text
      // `Stop hook feedback:\n[<condition>]: <reason>`) into the SAME result
      // cycle — a goal run is one long turn (see
      // tugcode/probes/goal-loop/FINDINGS.md#q01-goal). Translate the event
      // to a `goal_feedback` frame and stop: it is not the user's prompt
      // (it must not latch the rewind anchor below) and it carries no
      // tool_result blocks.
      if (event.isSynthetic === true) {
        const feedback = parseGoalFeedbackText(rawContent);
        if (feedback !== null) {
          messages.push({
            type: "goal_feedback",
            condition: feedback.condition,
            reason: feedback.reason,
            ipc_version: 2,
          });
        } else if (
          ctx.pendingCompactSummary === true &&
          typeof rawContent === "string" &&
          !rawContent.startsWith("<local-command-stdout>")
        ) {
          // The post-boundary summary event ([P08]): capture it as a
          // `compact_summary` frame and disarm. Goal feedback is parsed and
          // consumed first (above); `<local-command-stdout>` echoes are
          // excluded by prefix; disarm ensures one-shot capture per compaction.
          messages.push({
            type: "compact_summary",
            summary: rawContent,
            ipc_version: 2,
          });
          pendingCompactSummary = false;
        }
        break;
      }

      // `/rewind` anchor capture ([#step-7-1]). With `--replay-user-messages`
      // claude echoes the turn's own submission back as a `user` event
      // carrying the prompt-record `uuid`. That uuid is the rewind anchor
      // (`rewind_files.user_message_id` + the JSONL truncation boundary).
      // Capture it only from a *submission* echo — content that is a
      // plain string (slash command) or an array bearing a non-`tool_result`
      // block (the user's text/image). Mid-turn tool-result `user` events
      // (content is exclusively `tool_result` blocks) are NOT the prompt and
      // must not overwrite the anchor. `dispatchEventToTurn` latches the
      // surfaced value onto `ActiveTurn` and emits a `prompt_anchor`.
      const echoUuid = event.uuid;
      if (typeof echoUuid === "string" && echoUuid.length > 0) {
        const isSubmissionEcho =
          typeof rawContent === "string" ||
          (Array.isArray(rawContent) &&
            (rawContent as Array<Record<string, unknown>>).some(
              (b) => b.type !== "tool_result",
            ));
        if (isSubmissionEcho) {
          promptUuid = echoUuid;
        }
      }

      // Slash commands return content as a plain string (not an array).
      // Per §13c: {"type":"user","isReplay":true,"message":{"role":"user",
      //   "content":"<local-command-stdout>...</local-command-stdout>"}}
      //
      // A local-command-only turn never reveals a claude `message.id`, so
      // `ctx.msgId` is still "" when the stdout echo arrives — key the
      // synthesized block on the turn's opener id so the frames (and the
      // reducer's `activeMsgId`) match the terminal `turn_complete`.
      const localEchoMsgId = ctx.msgId !== "" ? ctx.msgId : ctx.openerId;
      if (event.isReplay === true && typeof rawContent === "string") {
        const stdoutMatch = rawContent.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
        if (stdoutMatch) {
          // Slash-command stdout: synthesize a single text block.
          messages.push({
            type: "content_block_start",
            msg_id: localEchoMsgId,
            block_index: 0,
            kind: "text",
            ipc_version: 2,
          });
          messages.push({
            type: "assistant_text",
            msg_id: localEchoMsgId,
            block_index: 0,
            seq: ctx.seq,
            rev: ctx.rev,
            text: stdoutMatch[1],
            is_partial: false,
            status: "complete",
            ipc_version: 2,
          });
        }
        const stderrMatch = rawContent.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/);
        if (stderrMatch) {
          messages.push({
            type: "error",
            message: stderrMatch[1],
            recoverable: true,
            ipc_version: 2,
          });
        }
        break;
      }

      const content = (rawContent as Array<Record<string, unknown>>) || [];

      let firstToolUseId: string | undefined;

      for (const block of content) {
        if (block.type === "tool_result") {
          const blockContent = block.content;
          let output = "";
          if (typeof blockContent === "string") {
            // Per PN-3: strip <tool_use_error> tags when is_error is true.
            if (block.is_error === true && blockContent.includes("<tool_use_error>")) {
              output = blockContent
                .replace(/<tool_use_error>/g, "")
                .replace(/<\/tool_use_error>/g, "")
                .trim();
            } else {
              output = blockContent;
            }
          } else if (Array.isArray(blockContent)) {
            output = (blockContent as Array<Record<string, unknown>>)
              .filter((b) => b.type === "text")
              .map((b) => b.text as string)
              .join("");
          }
          const toolUseId = (block.tool_use_id as string) || "";
          if (!firstToolUseId) {
            firstToolUseId = toolUseId;
          }
          messages.push({
            type: "tool_result",
            tool_use_id: toolUseId,
            output,
            is_error: block.is_error === true,
            ipc_version: 2,
          });
        }
      }

      // Check outer event for tool_use_result (structured result) per PN-4.
      const toolUseResult = event.tool_use_result as Record<string, unknown> | undefined;
      if (toolUseResult && firstToolUseId) {
        messages.push({
          type: "tool_use_structured",
          tool_use_id: firstToolUseId,
          tool_name: (toolUseResult.toolName as string) || "",
          structured_result: toolUseResult,
          ipc_version: 2,
        });
      }

      // Handle isReplay + slash command output in tool_result blocks (array content).
      if (event.isReplay === true) {
        for (const block of content) {
          if (block.type === "tool_result") {
            const blockContent = block.content;
            if (typeof blockContent === "string") {
              const stdoutMatch = blockContent.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
              if (stdoutMatch) {
                // Slash-command stdout via tool_result: same synthesized
                // block pattern as the user-content path above.
                messages.push({
                  type: "content_block_start",
                  msg_id: localEchoMsgId,
                  block_index: 0,
                  kind: "text",
                  ipc_version: 2,
                });
                messages.push({
                  type: "assistant_text",
                  msg_id: localEchoMsgId,
                  block_index: 0,
                  seq: ctx.seq,
                  rev: ctx.rev,
                  text: stdoutMatch[1],
                  is_partial: false,
                  status: "complete",
                  ipc_version: 2,
                });
              }
              const stderrMatch = blockContent.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/);
              if (stderrMatch) {
                messages.push({
                  type: "error",
                  message: stderrMatch[1],
                  recoverable: true,
                  ipc_version: 2,
                });
              }
            }
          }
        }
      }
      break;
    }

    case "result": {
      gotResult = true;
      // Disarm the summary capture ([P08]) so a summary-less compaction can't
      // leak the armed state into the next turn.
      pendingCompactSummary = false;
      const subtype = (event.subtype as string) || "error";
      const resultText = event.result as string | undefined;

      let isApiError = false;
      if (subtype === "success" && typeof resultText === "string" && resultText.startsWith("API Error:")) {
        isApiError = true;
      }

      resultMetadata = {
        subtype,
        is_error: event.is_error === true,
        total_cost_usd: event.total_cost_usd as number | undefined,
        num_turns: event.num_turns as number | undefined,
        duration_ms: event.duration_ms as number | undefined,
        duration_api_ms: event.duration_api_ms as number | undefined,
        usage: event.usage as Record<string, unknown> | undefined,
        modelUsage: event.modelUsage as Record<string, unknown> | undefined,
        permission_denials: event.permission_denials as unknown[] | undefined,
        is_api_error: isApiError || undefined,
      };

      // Emit CostUpdate from result event. The final assistant_text and
      // turn_complete are emitted by handleUserMessage with fresh seq values
      // so they pass through the frontend ordering buffer's dedup logic.
      //
      // `usage` carries the turn's LAST tool-loop iteration's usage
      // (`lastIterationUsage`), NOT `result.usage`. `result.usage` is a
      // SUM across every API call of the turn — a context-window snapshot
      // it is not. The last iteration's `input + cache_read +
      // cache_creation + output` IS the resident context after the turn.
      const costMsg: CostUpdate = {
        type: "cost_update",
        total_cost_usd: (event.total_cost_usd as number) || 0,
        num_turns: (event.num_turns as number) || 0,
        duration_ms: (event.duration_ms as number) || 0,
        duration_api_ms: (event.duration_api_ms as number) || 0,
        usage: lastIterationUsage ?? {},
        modelUsage: (event.modelUsage as Record<string, unknown>) || {},
        // Forward the turn's denials so the session card can surface them in its
        // Recently-denied tab; omit the field entirely when there were none.
        ...(resultMetadata.permission_denials &&
        resultMetadata.permission_denials.length > 0
          ? { permission_denials: resultMetadata.permission_denials }
          : {}),
        ipc_version: 2,
      };
      messages.push(costMsg);

      // Store result value for handleUserMessage to emit turn_complete.
      resultMetadata.resultValue = subtype === "success" ? "success" : "error";
      break;
    }

    case "stream_event": {
      streamEvent = event.event as Record<string, unknown> | undefined;
      break;
    }

    case "control_request": {
      controlRequest = event;
      break;
    }

    case "control_response": {
      console.log(`Received control_response: ${JSON.stringify(event)}`);
      break;
    }

    case "rate_limit_event": {
      // Subscription-quota broadcast emitted once per turn (post
      // `system/init`, pre-stream) since claude 2.1.x. Forward the
      // structured info so the frontend can show reset time + status;
      // the claude top-level `uuid` and `session_id` are dropped
      // because tugcode tracks session_id authoritatively and the
      // UI doesn't need claude's per-event uuid.
      const info = event.rate_limit_info as Record<string, unknown> | undefined;
      if (info && typeof info === "object") {
        const evt: RateLimitEvent = {
          type: "rate_limit_event",
          rate_limit_info: {
            status: (info.status as string) || "",
            resetsAt: (info.resetsAt as number) || 0,
            rateLimitType: (info.rateLimitType as string) || "",
            overageStatus: (info.overageStatus as string) || "",
            ...(typeof info.overageDisabledReason === "string"
              ? { overageDisabledReason: info.overageDisabledReason }
              : {}),
            isUsingOverage: Boolean(info.isUsingOverage),
            ...(typeof info.utilization === "number"
              ? { utilization: info.utilization }
              : {}),
          },
          ipc_version: 2,
        };
        messages.push(evt);
      }
      break;
    }

    case "keep_alive": {
      break;
    }

    case "tool_progress": {
      // Top-level progress/heartbeat telemetry the engine yields while a
      // long-running tool executes: `bash_progress` / `powershell_progress`
      // (elapsed_time_seconds + task_id), `repl_call`, `heartbeat:true`, and
      // subagent-retry frames. None carries tool output — they exist only to
      // report liveness — so there is nothing to render in the Session card.
      // Streaming tool input already flows through `tool_input_progress`, and
      // subagent progress through the `system/task_progress` path; claude's own
      // SDK adapter ignores the heartbeat/subagent-retry variants. Swallow it
      // so it does not fall into the `unknown_event` default and raise a
      // spurious "Unsupported event" banner downstream.
      break;
    }

    case "control_cancel_request": {
      const cancelId = event.request_id as string | undefined;
      if (cancelId) {
        cancelledRequestId = cancelId;
        const cancelMsg: ControlRequestCancel = {
          type: "control_request_cancel",
          request_id: cancelId,
          ipc_version: 2,
        };
        messages.push(cancelMsg);
      } else {
        console.log(`Received control_cancel_request with no request_id: ${JSON.stringify(event)}`);
      }
      break;
    }

    default: {
      const originalType = eventType ?? "unknown";
      // Forward-compat: keep the operator-visible log AND emit an
      // `unknown_event` IPC frame instead of silently dropping, so a
      // newer claude that streams an event type this build doesn't
      // translate still surfaces a soft warn banner downstream.
      console.log(`Unhandled top-level event type=${originalType}`);
      messages.push({
        type: "unknown_event",
        original_type: originalType,
        payload_hex_preview: payloadHexPreview(event),
        ipc_version: 2,
      });
      break;
    }
  }

  return {
    messages,
    gotResult,
    sessionId,
    streamEvent,
    controlRequest,
    cancelledRequestId,
    parentToolUseId,
    resultMetadata,
    systemMetadata,
    messageId,
    promptUuid,
    pendingCompactSummary,
  };
}

/** The four token-count keys a claude `usage` object carries. */
const USAGE_TOKEN_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

/**
 * Build a `streaming_usage` IPC frame from a raw claude `usage` object,
 * or `null` when there is nothing worth emitting: an empty `msg_id`
 * (claude has not revealed the message id yet) or a `usage` carrying
 * none of the four token fields (a lifecycle-only payload, an empty
 * `{}`, a malformed object). The gate keeps the high-frequency wire
 * quiet rather than emitting an all-zero frame.
 *
 * The whole `usage` object is forwarded raw — same as `cost_update`
 * does with `result.usage` — so the client reads whichever fields it
 * needs without tugcode taking a position on the shape.
 */
function streamingUsageFrame(
  msgId: string,
  usage: unknown,
): StreamingUsage | null {
  if (msgId.length === 0) return null;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  if (!USAGE_TOKEN_KEYS.some((k) => typeof u[k] === "number")) return null;
  return { type: "streaming_usage", msg_id: msgId, usage: u, ipc_version: 2 };
}

/**
 * Map a single stream-json inner event (from stream_event wrapper) to IPC messages.
 * Exported for unit testing.
 */
// ---------------------------------------------------------------------------
// Tool-input progress — derived from the streaming `input_json_delta`
// fragments claude emits while assembling a tool's argument JSON. tugcode's
// reducer otherwise waits for the terminal `tool_use` (assembled input); these
// fragments let the pulse strip narrate a long Write as it happens.
//
// `parseToolInputProgress` is pure and unit-tested: given the partial argument
// JSON accumulated so far, it returns a best-effort progress summary. While the
// JSON is still open, file path / line count are best-effort regex reads
// (exact once the value's closing quote streams in).
// ---------------------------------------------------------------------------

export interface ToolInputProgressSummary {
  /** Raw bytes of partial argument JSON accumulated so far. */
  bytes: number;
  /** `file_path` field value once it has streamed in, else null. */
  filePath: string | null;
  /** Newlines seen inside the `content` field so far (best-effort while open). */
  contentLines: number | null;
}

export function parseToolInputProgress(partialJson: string): ToolInputProgressSummary {
  const pathMatch = partialJson.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const filePath = pathMatch ? pathMatch[1] : null;

  // Count escaped newlines (`\n`, two chars in JSON) inside the content field.
  // While the JSON is still open this is best-effort; exact once parseable.
  let contentLines: number | null = null;
  const contentKey = partialJson.indexOf('"content"');
  if (contentKey !== -1) {
    const after = partialJson.slice(contentKey);
    const matches = after.match(/\\n/g);
    contentLines = (matches ? matches.length : 0) + 1;
  }

  return { bytes: partialJson.length, filePath, contentLines };
}

/**
 * Parse a goal-evaluator feedback text out of a synthetic user event's
 * content. The wire shape (pinned by the goal-lifecycle capture in
 * `tugcode/probes/goal-loop/`) is a single text block:
 *
 *     Stop hook feedback:\n[<condition>]: <reason>
 *
 * The condition match is greedy (a condition may itself contain `]: `);
 * the reason is whatever follows the last `]: `. Returns null when the
 * content carries no such text — synthetic events that are not goal
 * feedback stay untranslated rather than guessed at.
 */
export function parseGoalFeedbackText(
  rawContent: unknown,
): { condition: string; reason: string } | null {
  let text = "";
  if (typeof rawContent === "string") {
    text = rawContent;
  } else if (Array.isArray(rawContent)) {
    text = (rawContent as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text")
      .map((b) => (b.text as string) || "")
      .join("");
  }
  const match = text.match(/^Stop hook feedback:\s*\n\[([\s\S]*)\]:\s([\s\S]*)$/);
  if (match === null) return null;
  return { condition: match[1], reason: match[2].trim() };
}

export function mapStreamEvent(
  event: Record<string, unknown>,
  ctx: EventMappingContext,
  accumulatedPartialText: string
): EventMappingResult {
  const messages: OutboundMessage[] = [];
  let newRev = ctx.rev;
  let partialText = accumulatedPartialText;
  let gotResult = false;
  let messageId: string | undefined;
  let messageStartUsage: Record<string, unknown> | undefined;
  let messageDeltaUsage: Record<string, unknown> | undefined;

  const eventType = event.type as string | undefined;

  if (eventType === "message_start") {
    // claude reveals its message.id in the message_start frame BEFORE any
    // emit-bearing event for the message (content_block_start / _delta
    // land after). Surface it so dispatchEventToTurn can slide
    // ActiveTurn.currentMessageId to claude's id before any wire emit
    // for this message. Multi-message claude turns (text → tool_use →
    // tool_result → second text) trigger another `message_start` with a
    // fresh id; the slide simply overwrites — no rejection, no warning.
    const message = event.message as Record<string, unknown> | undefined;
    const rawId = message?.id;
    if (typeof rawId === "string" && rawId.length > 0) {
      messageId = rawId;
    }
    // Surface the message's opening `usage` snapshot so the client's
    // live token cells update the moment a message begins (the
    // input + cache figures are known here; `output` is a small
    // partial that the terminal `message_delta` finalizes).
    const startUsage = streamingUsageFrame(
      typeof rawId === "string" ? rawId : "",
      message?.usage,
    );
    if (startUsage) {
      messages.push(startUsage);
      // Latch the raw `usage` so the turn can fall back to the last
      // `message_start` when it produced no `message_delta` at all.
      messageStartUsage = startUsage.usage;
    }
  } else if (eventType === "message_delta") {
    // The terminal per-message frame: carries the message's final,
    // authoritative four-token `usage`. `ctx.msgId` is the current
    // message id, slid by this message's earlier `message_start`.
    const deltaUsage = streamingUsageFrame(ctx.msgId, event.usage);
    if (deltaUsage) {
      messages.push(deltaUsage);
      // Latch the raw `usage`: the most recent `message_delta` of the
      // turn is the last tool-loop iteration, and `dispatchEventToTurn`
      // emits it as `cost_update.usage` at the terminal `result`.
      messageDeltaUsage = deltaUsage.usage;
    }
  } else if (eventType === "content_block_start") {
    const contentBlock = event.content_block as Record<string, unknown> | undefined;
    const blockIndex = typeof event.index === "number" ? event.index : 0;
    if (contentBlock?.type === "text") {
      // Surface the block open to tugdeck so the reducer can mint an
      // assistant_text Message before any delta lands. Idempotent on
      // the reducer side per [D07].
      messages.push({
        type: "content_block_start",
        msg_id: ctx.msgId,
        block_index: blockIndex,
        kind: "text",
        ipc_version: 2,
      });
    } else if (contentBlock?.type === "thinking") {
      messages.push({
        type: "content_block_start",
        msg_id: ctx.msgId,
        block_index: blockIndex,
        kind: "thinking",
        ipc_version: 2,
      });
    } else if (contentBlock?.type === "tool_use") {
      // Two emissions: a content_block_start so the reducer mints the
      // ToolUseMessage with kind/id/name, and the existing tool_use
      // IPC frame so the toolCallMap entry forms with empty input
      // (input is filled in by the post-`input_json_delta` `tool_use`
      // emission at the matching `assistant` top-level event or via a
      // continuation `tool_use` event).
      //
      // Wire-input boundary check: claude's wire MUST carry `id` and
      // `name` on tool_use content blocks (verified across all captured
      // probes). If either is missing the emission still proceeds with
      // an empty string so the reducer at least mints SOMETHING, but
      // we surface the anomaly loudly — a regression in claude's wire
      // shape would otherwise produce a tool Message with an empty
      // toolUseId that no tool_result could correlate against.
      const toolUseId = (contentBlock.id as string) || "";
      const toolName = (contentBlock.name as string) || "";
      if (toolUseId === "" || toolName === "") {
        console.error(
          `[tugcode] content_block_start tool_use missing id or name on live wire (msg_id=${ctx.msgId}, block_index=${blockIndex}, id="${toolUseId}", name="${toolName}")`,
        );
      }
      messages.push({
        type: "content_block_start",
        msg_id: ctx.msgId,
        block_index: blockIndex,
        kind: "tool_use",
        tool_use_id: toolUseId,
        tool_name: toolName,
        ipc_version: 2,
      });
      messages.push({
        type: "tool_use",
        msg_id: ctx.msgId,
        seq: ctx.seq,
        tool_name: toolName,
        tool_use_id: toolUseId,
        input: {},
        ipc_version: 2,
      });
    }
  } else if (eventType === "content_block_delta") {
    const delta = event.delta as Record<string, unknown> | undefined;
    const blockIndex = typeof event.index === "number" ? event.index : 0;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      partialText += delta.text;
      // The wire emit carries the delta only (`text: delta.text`), not
      // the cumulative `partialText`. The reducer's append-or-mutate
      // rule keyed on `(msg_id, block_index)` appends each delta to
      // the Message minted by the preceding `content_block_start`. See
      // [D07] § Append-or-mutate rule.
      messages.push({
        type: "assistant_text",
        msg_id: ctx.msgId,
        block_index: blockIndex,
        seq: ctx.seq,
        rev: newRev++,
        text: delta.text,
        is_partial: true,
        status: "partial",
        ipc_version: 2,
      });
    } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
      // Per §14: thinking_delta has delta.thinking (NOT delta.text).
      const thinkingMsg: ThinkingText = {
        type: "thinking_text",
        msg_id: ctx.msgId,
        block_index: blockIndex,
        seq: ctx.seq,
        text: delta.thinking,
        is_partial: true,
        status: "partial",
        ipc_version: 2,
      };
      messages.push(thinkingMsg);
    }
    // `input_json_delta` is intentionally not mapped to an outbound message
    // here — mapStreamEvent stays pure and stateless. The cumulative
    // `tool_input_progress` frame is emitted from `dispatchEventToTurn`,
    // which holds the per-turn block state needed to correlate the delta's
    // block_index to its tool_use_id / tool_name.
  } else if (eventType === "tool_use") {
    messages.push({
      type: "tool_use",
      msg_id: ctx.msgId,
      seq: ctx.seq,
      tool_name: event.name as string,
      tool_use_id: event.id as string,
      input: (event.input as object) || {},
      ipc_version: 2,
    });
  } else if (eventType === "tool_result" || eventType === "tool_progress") {
    messages.push({
      type: "tool_result",
      tool_use_id: (event.tool_use_id as string) || "",
      output: (event.output as string) || "",
      is_error: event.is_error === true,
      ipc_version: 2,
    });
  }

  return {
    messages,
    newRev,
    partialText,
    gotResult,
    messageId,
    messageStartUsage,
    messageDeltaUsage,
  };
}

// ---------------------------------------------------------------------------
// ActiveTurn — per-turn mutable state owned by handleUserMessage and
// dispatched-into by the stdout drain task (Step R1e).
// ---------------------------------------------------------------------------

/**
 * Per-turn state for a `handleUserMessage` invocation.
 *
 * Pre-R1e: these were local variables inside `handleUserMessage`'s
 * line-pulling `while (true)` loop. Post-R1e the loop is gone — the
 * stdout drain task reads claude's stdout continuously and dispatches
 * events into an `ActiveTurn` registered by `handleUserMessage`. The
 * turn's `completion` promise resolves when the drain sees
 * `turn_complete` (or claude's stdout closes). `handleUserMessage`
 * awaits that promise rather than pulling lines itself.
 *
 * Pure data + a Promise handle. No I/O. The drain mutates `rev`,
 * `partialText`, `gotResult`, `interrupted` as it processes lines;
 * `handleInterrupt` mutates `interrupted` directly when the user
 * cancels a turn in flight. Single-threaded JS event loop guarantees
 * mutation safety without locks.
 */
/**
 * Per-content-block tracking entry on `ActiveTurn.messageBlocks`. Captures
 * the kind and contents of a single content block (text / thinking /
 * tool_use) as it arrives, so `emitInflightTurnFromActiveTurn` can replay
 * the per-block event stream faithfully on mid-turn reconnect ([D07]
 * § Mid-turn replay snapshot).
 *
 * Discriminated by `kind` — text/thinking variants carry only an
 * accumulating `text` string; tool_use variant carries identity
 * (toolUseId + toolName) plus mutable input/result fields. The
 * discriminated union prevents nonsensical constructions like a "text"
 * block carrying a `toolUseId` from type-checking.
 *
 * Mutation discipline: BlockState fields are mutated IN PLACE by
 * {@link ActiveTurn.updateBlockStateFromMessages} — the `text` string is
 * concatenated, `toolInput` / `toolResult` / `toolStructuredResult` are
 * replaced. The mutability is internal to the owning ActiveTurn and is
 * safe because (a) there are no external subscribers to BlockState
 * references, and (b) the only reader (`emitInflightTurnFromActiveTurn`)
 * runs at a moment when all upstream mutations for the relevant events
 * have already landed. Future contributors: do NOT pass BlockState
 * references to long-lived holders that expect immutability.
 *
 * Tool-result and structured-result data is folded onto the matching
 * tool_use entry — when the wire's `tool_result` lands (via the `user`
 * top-level event), we look up by `toolUseId` (O(1) via
 * {@link ActiveTurn.toolCallByToolUseId}) and stash the output, so a
 * snapshot can emit the full tool lifecycle.
 */
type BlockState = TextBlockState | ThinkingBlockState | ToolUseBlockState;

interface TextBlockState {
  index: number;
  kind: "text";
  /** Accumulated text; appended by text_delta, replaced by terminal text. */
  text: string;
}

interface ThinkingBlockState {
  index: number;
  kind: "thinking";
  /** Accumulated thinking text. */
  text: string;
}

interface ToolUseBlockState {
  index: number;
  kind: "tool_use";
  /** Wire-assigned tool call id; primary key for tool_result correlation. */
  toolUseId: string;
  /** Tool name (e.g. "Bash"). */
  toolName: string;
  /**
   * Tool input. Starts as `{}` at content_block_start time, replaced by
   * the post-`input_json_delta` `tool_use` IPC event with the assembled
   * input. Always present; may be empty.
   */
  toolInput: Record<string, unknown>;
  /**
   * Streaming accumulator for the argument JSON as `input_json_delta`
   * fragments arrive, used to derive `tool_input_progress` frames. Distinct
   * from `toolInput`, which holds the final assembled object.
   */
  partialInputJson?: string;
  /**
   * Last `(file_path|content_lines)` tuple emitted as a `tool_input_progress`
   * frame, so progress emits only when the narratable state changes.
   */
  progressKey?: string;
  /** Populated when the matching `tool_result` lands. */
  toolResult?: { output: string; isError: boolean };
  /** Populated when the matching `tool_use_structured` lands. */
  toolStructuredResult?: Record<string, unknown>;
}

/**
 * Per-lane stream state for one concurrent claude stream within a turn.
 *
 * A turn's stdout multiplexes the main loop's stream with any background
 * subagents' streams; every event is tagged with `parent_tool_use_id`
 * (present on all 5 message types per PN-8) — absent/empty for the main
 * loop, the launching tool_use id for a subagent. Each such source is a
 * **lane**, keyed `parent_tool_use_id ?? null`, and each lane runs its
 * own `message_start` → deltas → `message_delta` cycle with its own
 * `message.id`s. Sharing one pointer across lanes lets a subagent's
 * `message_start` re-stamp the main loop's in-flight deltas with the
 * subagent's msg_id — the reducer then mints a spurious second Message
 * mid-block (the "I / 'll wait…" transcript split).
 */
interface LaneState {
  /**
   * Sliding pointer to the most recent claude `message.id` seen on this
   * lane's stream. Updated on every `message_start` (via
   * `mapStreamEvent.messageId`) and on every top-level `assistant`
   * snapshot (via `routeTopLevelEvent.messageId`). Used by
   * `dispatchEventToTurn` to populate `msg_id` on frames whose claude
   * stream event doesn't carry one directly (`content_block_delta`,
   * `content_block_start`). `null` before the lane's first id-bearing
   * event.
   *
   * Multi-message cycles (text → tool_use → tool_result → second text)
   * overwrite this pointer on the second `message.id`. Each
   * `message.id` is its own thing on the wire; the reducer renders them
   * as separate panels keyed by id.
   */
  msgId: string | null;
  /** Streaming-text revision counter, bumped per stream-event delta. */
  rev: number;
  /** Accumulated streaming text for this lane. */
  partialText: string;
  /**
   * Per-message content blocks observed on this lane, in arrival
   * order. Keyed by msg_id (a lane may span multiple msgIds via
   * tool-use-loop iterations); each value is the ordered list of blocks
   * for that message.
   *
   * Why this lives here rather than being inferred from `partialText`:
   * the wire emits text in discrete blocks separated by tool calls.
   * `partialText` concatenates everything since the lane began (no
   * block boundaries preserved); for a faithful replay snapshot we need
   * the per-block structure too.
   */
  messageBlocks: Map<string, BlockState[]>;
}

/** The main-loop lane key; subagent lanes key by their launching tool_use id. */
const MAIN_LANE: string | null = null;

// ── Activity counting units (Spec S04) ──────────────────────────────────────
// Relocated verbatim from the deck's former `recordThroughput` so the
// producer emits the same magnitudes the sparkline was tuned against. A
// subagent/background beat and a foreground tool call each pulse a fixed
// burst (subagents stream no partial deltas to the parent, so a burst is
// the only signal that keeps the line alive); tool results are credited
// their output length, capped so one large result can't swamp the window.
const SUBAGENT_ACTIVITY_UNITS = 250;
const TOOL_USE_ACTIVITY_UNITS = 250;
const SUBAGENT_RESULT_UNITS_CAP = 600;
const FOREGROUND_RESULT_UNITS_CAP = 600;

/**
 * Activity-flush cadence ([Q06]). 250 ms matches the deck meter's bin so the
 * consumer math is unchanged: one `activity_delta` per bin per live turn.
 */
const ACTIVITY_FLUSH_MS = 250;

/**
 * Cancel-escalation grace. `handleInterrupt` first sends the in-band
 * `interrupt` control-request (the graceful path — a healthy claude ends the
 * turn and emits its own `result`). If the turn hasn't ended within this
 * window claude is wedged and can't service its own stdin, so tugcode
 * escalates to an OS-level force-terminate + resume-respawn. The user's cancel
 * must always win; 2s is comfortably longer than a healthy interrupt
 * round-trip.
 */
const INTERRUPT_ACK_GRACE_MS = 2000;

/**
 * Result-liveness watchdog. Claude closes each assistant message with a
 * `message_delta` carrying a terminal `stop_reason`, then emits its turn-final
 * `result` almost immediately. If a terminal stop is seen but no `result`
 * lands within this window the turn is wedged post-content (the 2026-07-22
 * commit-xp hang: final text delivered, `result` never arrived, cancel
 * powerless). Force-terminate and resume-respawn rather than spin forever.
 * Generous enough that a slow final flush never trips it.
 */
const RESULT_WATCHDOG_MS = 12000;

/**
 * Force-terminate signal grace. {@link killAndCleanup} in `escalate` mode
 * sends SIGINT, waits this long for claude to exit, then SIGKILLs. Unlike the
 * graceful teardown (stdin EOF + 5s), a wedged claude isn't reading stdin, so
 * the ladder is signal-based and short.
 */
const FORCE_TERMINATE_SIGINT_GRACE_MS = 1500;

/**
 * Default grace for the graceful teardown: how long a healthy claude gets
 * to finish and exit after its stdin is closed (EOF). Used by respawn /
 * fork / truncate, where nothing is waiting on the process. Shutdown
 * passes a smaller grace — see {@link SessionManager.shutdown} — because
 * there the `tug-quiesce` budget is what claude's exit has to fit inside.
 */
const CLAUDE_EOF_GRACE_MS = 5000;

/**
 * The `message_delta.delta.stop_reason` values that close an assistant message
 * for good — the turn's `result` must follow. `tool_use` is deliberately
 * excluded: it opens another tool-loop iteration, not the turn's end, so it
 * must never arm the result watchdog.
 */
const TERMINAL_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "stop_sequence",
  "max_tokens",
]);

export class ActiveTurn {
  /**
   * Per-lane stream state, keyed `parent_tool_use_id ?? null` (see
   * {@link LaneState}). The main lane (`null`) is created eagerly so
   * the accessors below always have a target; subagent lanes are
   * created on their first event via {@link laneFor}.
   */
  private readonly lanes: Map<string | null, LaneState> = new Map([
    [
      MAIN_LANE,
      { msgId: null, rev: 0, partialText: "", messageBlocks: new Map() },
    ],
  ]);

  /**
   * Resolve (creating on first touch) the lane for one event's
   * `parent_tool_use_id ?? null`.
   */
  laneFor(laneKey: string | null): LaneState {
    let lane = this.lanes.get(laneKey);
    if (lane === undefined) {
      lane = { msgId: null, rev: 0, partialText: "", messageBlocks: new Map() };
      this.lanes.set(laneKey, lane);
    }
    return lane;
  }

  /**
   * The MAIN lane's sliding `message.id` pointer (see
   * {@link LaneState.msgId}). Turn-scoped consumers — the terminal
   * emits on `gotResult`, `signalEofToActiveTurn`, and
   * `emitInflightTurnFromActiveTurn` — key on the main loop's message,
   * never a subagent's, so the accessor reads the main lane. `null`
   * before claude's first id-bearing event — degenerate-state emit
   * sites treat null as "nothing claude-keyable to emit yet."
   */
  get currentMessageId(): string | null {
    return this.laneFor(MAIN_LANE).msgId;
  }
  set currentMessageId(value: string | null) {
    this.laneFor(MAIN_LANE).msgId = value;
  }
  /**
   * The MAIN lane's per-message content blocks (see
   * {@link LaneState.messageBlocks}). Read by
   * `emitInflightTurnFromActiveTurn` to reconstruct the per-block event
   * stream for mid-turn replay ([D07] § Mid-turn replay snapshot) —
   * which deliberately replays only the main lane: subagent content is
   * re-derived from the subagent JSONL on the deck side, and replaying
   * it here would inject agent-lane blocks into the main transcript.
   */
  get messageBlocks(): Map<string, BlockState[]> {
    return this.laneFor(MAIN_LANE).messageBlocks;
  }
  /**
   * Index from `tool_use_id` to the matching ToolUseBlockState in
   * {@link messageBlocks}. Maintained alongside `messageBlocks` by
   * `updateBlockStateFromMessages` so that `tool_use` / `tool_result` /
   * `tool_use_structured` events can locate their target block in O(1)
   * — without this index, lookup would walk every msgId's blocks per
   * event, which is O(turns × blocks) per tool event.
   *
   * Same mutation discipline as the BlockState entries themselves: the
   * map value is a reference to the live BlockState in `messageBlocks`,
   * mutated in place.
   */
  toolCallByToolUseId: Map<string, ToolUseBlockState> = new Map();
  /** Outbound `seq` for the user-message half of this turn. */
  readonly seq: number;
  /**
   * Synthesized per-turn opener id (`t-<seq>`), the terminal frames'
   * `msg_id` fallback when claude never revealed a `message.id` this
   * turn. A local-command turn (`/compact`, `/model`, …) streams no
   * assistant message, so {@link currentMessageId} stays null for its
   * whole run; stamping its `turn_complete` with `""` made every such
   * turn share one dedupe key in the reducer's `committedMsgIds` — the
   * second no-content turn's commit was swallowed as a duplicate (the
   * `/compact`-row-vanishes / stuck-Waiting failure). The `t-` prefix
   * is disjoint from claude's real `msg_*` ids and from the replay
   * translator's `u-` / `w-` / `a-` opener namespaces.
   */
  readonly openerId: string;
  /**
   * The user's submitted content blocks, captured by
   * `handleUserMessage` from the inbound `UserMessage`. Source-of-truth
   * for the in-flight turn's synthetic `add_user_message` payload
   * during `runReplay` (mid-turn replay re-emits exactly these
   * blocks). Per [Step 5c](dash/dev-atoms.md#step-5c).
   *
   * Replaces the prior `userText` + `userAttachments` pair — the
   * inbound wire shape is now Anthropic-API content blocks directly,
   * and the synthetic emit forwards them unchanged.
   */
  readonly userContent: ReadonlyArray<ContentBlock>;
  /**
   * Claude's user-prompt-record `uuid` for this turn — the `/rewind`
   * anchor ([#step-7-1]). Captured from the live user-echo event
   * (`--replay-user-messages`) the first time the turn's own submission
   * is echoed back; `null` until then (and for turns whose echo carries
   * no `uuid`). Emitted live as a {@link PromptAnchor} and re-emitted on
   * the mid-turn snapshot's `add_user_message.promptUuid`.
   */
  promptUuid: string | null = null;
  /**
   * Armed-capture flag for the live compaction summary ([P08]). A
   * `compact_boundary` this turn sets it `true`; the next synthetic
   * plain-string `user` event is then captured as a `compact_summary` frame
   * and it flips back to `false` (also disarmed at the turn's `result`).
   */
  pendingCompactSummary = false;
  /** The MAIN lane's streaming-text revision counter (see {@link LaneState.rev}). */
  get rev(): number {
    return this.laneFor(MAIN_LANE).rev;
  }
  set rev(value: number) {
    this.laneFor(MAIN_LANE).rev = value;
  }
  /**
   * The MAIN lane's accumulated streaming text (see
   * {@link LaneState.partialText}); emitted as a final `assistant_text`
   * on `gotResult` and as `turn_cancelled.partial_result` on interrupt.
   */
  get partialText(): string {
    return this.laneFor(MAIN_LANE).partialText;
  }
  set partialText(value: string) {
    this.laneFor(MAIN_LANE).partialText = value;
  }
  /** True once the drain has seen claude's terminal `result` event for this turn. */
  gotResult: boolean = false;
  /**
   * The `usage` of the turn's most recent `message_delta` — the latest
   * tool-loop iteration. `dispatchEventToTurn` emits this as
   * `cost_update.usage` at the terminal `result` event. `null` until
   * the first `message_delta` lands. A fresh `ActiveTurn` per
   * `handleUserMessage` IS the per-turn reset.
   */
  lastMessageDeltaUsage: Record<string, unknown> | null = null;
  /**
   * The `usage` of the turn's most recent `message_start`. The
   * `cost_update.usage` fallback for a degenerate turn that produced no
   * `message_delta` at all (an interrupt before the first iteration's
   * terminal frame). `null` until the first `message_start` lands.
   */
  lastMessageStartUsage: Record<string, unknown> | null = null;
  /** True if `handleInterrupt` was invoked while this turn was active. */
  interrupted: boolean = false;
  /**
   * True if the interrupt was a retraction (`interrupt{retract:true}` —
   * the client's CASE A pull-down). When the turn closes, the manager's
   * close hook truncates the session JSONL at this turn's
   * {@link promptUuid} record and silently respawns, so the aborted
   * prompt leaves claude's history instead of lingering as a
   * phantom-context entry. Meaningless unless {@link interrupted} is
   * also set.
   */
  retractRequested: boolean = false;
  /**
   * Set by `runReplay` when it adopts this turn for in-flight emission
   * (mid-turn replay design). While true, the per-turn `writeLine`
   * sites in `dispatchEventToTurn` and `signalEofToActiveTurn` skip
   * emission but continue to mutate state (`partialText` accumulates,
   * `gotResult`/`interrupted` latch, `finish()` still runs). Cleared
   * by `runReplay`'s `finally` after `replay_complete` is on the wire.
   *
   * Gated emit sites — five in dispatchEventToTurn, two in
   * signalEofToActiveTurn:
   *   1. dispatch: routeResult.messages forwarding
   *   2. dispatch: streamResult.messages forwarding (live deltas)
   *   3. dispatch: control_request_forward
   *   4. dispatch: final complete `assistant_text` on gotResult
   *   5. dispatch: `turn_complete` on gotResult
   *   6. EOF: `turn_cancelled` on interrupted
   *   7. EOF: `error` on unexpected stream end
   */
  suppressEmit: boolean = false;
  /**
   * Per-channel work accumulated since the last activity flush (Spec S04).
   * Drained each 250 ms bin by {@link drainActivity}; the subagent/foreground
   * split is expressed as the `subagents`/`tools` channels (keyed off the
   * event's `parent_tool_use_id`), not by lane — the wire frame is one
   * per-session sample, not per-lane.
   */
  private readonly activity: Record<ActivityChannel, number> = {
    text: 0,
    tokens: 0,
    tools: 0,
    subagents: 0,
  };
  /**
   * Last cumulative `output_tokens` observed per `msg_id`, for token-velocity
   * deltas ([Q01]/[P06]). `output_tokens` is cumulative within a `msg_id`, so
   * the recorded units are `max(0, cur − last)`, seeded on a new id.
   */
  private readonly tokenByMsgId = new Map<string, number>();
  /** Cumulative `tool_input_progress` bytes per `tool_use_id`, differenced into `text`. */
  private readonly toolInputBytes = new Map<string, number>();
  /** Subagent `tool_use` ids already credited a burst (dedupe by id). */
  private readonly subagentToolSeen = new Set<string>();
  /** Foreground `tool_use` ids already credited a burst (dedupe; enhancement row). */
  private readonly foregroundToolSeen = new Set<string>();
  /** Resolves when the turn ends (either via `gotResult` or stdout EOF). */
  readonly completion: Promise<void>;
  private resolveCompletion: (() => void) | null;

  constructor(
    seq: number,
    userContent: ReadonlyArray<ContentBlock>,
  ) {
    this.seq = seq;
    this.openerId = `t-${seq}`;
    this.userContent = userContent;
    let resolve: () => void = () => {};
    this.completion = new Promise<void>((r) => {
      resolve = r;
    });
    this.resolveCompletion = resolve;
  }

  /**
   * Resolve {@link completion}. Idempotent — subsequent calls are
   * no-ops, so the EOF and `gotResult` paths can both call it without
   * coordinating.
   */
  finish(): void {
    if (this.resolveCompletion !== null) {
      this.resolveCompletion();
      this.resolveCompletion = null;
    }
  }

  /**
   * Fold one outbound frame into the activity accumulator (Spec S04). Called
   * for every frame `dispatchEventToTurn` writes to the wire for this turn;
   * unrecognized types are ignored. The (parity) rows replicate the deck's
   * former `recordThroughput` field reads and units exactly; the two
   * (enhancement) rows — output-token velocity replacing the flat
   * `streaming_usage` pip, and a foreground `tool_use` burst the deck never
   * counted — are the deliberate, fixture-pinned changes ([P21]).
   *
   * Only reached inside `dispatchEventToTurn`'s `!suppressEmit` guards, so a
   * replay bracket's re-emitted frames never generate activity — the flush
   * is gated the same way ([Q06]).
   */
  accountActivity(msg: Record<string, unknown>): void {
    const t = msg.type;
    const toolUseId =
      typeof msg.tool_use_id === "string" ? msg.tool_use_id : null;
    const parent =
      typeof msg.parent_tool_use_id === "string" &&
      msg.parent_tool_use_id.length > 0;
    if (
      (t === "assistant_text" || t === "thinking_text") &&
      msg.is_partial === true &&
      typeof msg.text === "string"
    ) {
      this.activity.text += msg.text.length;
    } else if (
      t === "tool_input_progress" &&
      typeof msg.bytes === "number" &&
      toolUseId !== null
    ) {
      const last = this.toolInputBytes.get(toolUseId) ?? 0;
      const delta = msg.bytes - last;
      this.toolInputBytes.set(toolUseId, msg.bytes);
      if (delta > 0) this.activity.text += delta;
    } else if (
      parent &&
      t === "tool_use" &&
      toolUseId !== null &&
      msg.input != null &&
      typeof msg.input === "object" &&
      Object.keys(msg.input as object).length > 0
    ) {
      // A subagent's tool call. Subagents stream no partial deltas to the
      // parent, so this complete frame is the only activity signal — pulse
      // once per call to keep the sparkline alive while an agent works.
      if (!this.subagentToolSeen.has(toolUseId)) {
        this.subagentToolSeen.add(toolUseId);
        this.activity.subagents += SUBAGENT_ACTIVITY_UNITS;
      }
    } else if (parent && t === "tool_result" && typeof msg.output === "string") {
      this.activity.subagents += Math.min(
        msg.output.length,
        SUBAGENT_RESULT_UNITS_CAP,
      );
    } else if (!parent && t === "tool_result" && typeof msg.output === "string") {
      this.activity.tools += Math.min(
        msg.output.length,
        FOREGROUND_RESULT_UNITS_CAP,
      );
    } else if (
      !parent &&
      t === "tool_use" &&
      toolUseId !== null &&
      msg.input != null &&
      typeof msg.input === "object" &&
      Object.keys(msg.input as object).length > 0
    ) {
      // Enhancement: a foreground tool call the deck never counted. The
      // burst reads the tool launching as a beat, keeping the line off the
      // floor through an otherwise-silent tool run.
      if (!this.foregroundToolSeen.has(toolUseId)) {
        this.foregroundToolSeen.add(toolUseId);
        this.activity.tools += TOOL_USE_ACTIVITY_UNITS;
      }
    } else if (t === "streaming_usage") {
      // Enhancement: real output-token velocity. `output_tokens` is
      // cumulative within a `msg_id`; record its per-bin growth.
      const usage = msg.usage as Record<string, unknown> | undefined;
      const cur =
        usage && typeof usage.output_tokens === "number"
          ? usage.output_tokens
          : 0;
      const msgId = typeof msg.msg_id === "string" ? msg.msg_id : "";
      const last = this.tokenByMsgId.get(msgId) ?? 0;
      this.tokenByMsgId.set(msgId, cur);
      const delta = Math.max(0, cur - last);
      if (delta > 0) this.activity.tokens += delta;
    } else if (t === "task_progress") {
      // A backgrounded agent step; its tool calls don't stream to the
      // parent, so this is the only signal while it runs.
      this.activity.tools += SUBAGENT_ACTIVITY_UNITS;
    }
  }

  /**
   * Drain the accumulated activity into a wire `channels` object carrying
   * only the non-zero channels, resetting the accumulator. Returns `null`
   * for an idle bin so the flush emits no frame ([P15]).
   */
  drainActivity(): Partial<Record<ActivityChannel, number>> | null {
    const channels: Partial<Record<ActivityChannel, number>> = {};
    let any = false;
    for (const ch of ["text", "tokens", "tools", "subagents"] as const) {
      const v = this.activity[ch];
      if (v > 0) {
        channels[ch] = v;
        any = true;
      }
      this.activity[ch] = 0;
    }
    return any ? channels : null;
  }

  /**
   * Update {@link messageBlocks} from a batch of emitted IPC messages.
   * Called by `dispatchEventToTurn` after each `routeTopLevelEvent` /
   * `mapStreamEvent` batch — the messages reveal the block events
   * (content_block_start / text deltas / tool_use / tool_result), and
   * this method mirrors them onto per-block state so the mid-turn
   * snapshot path can reconstruct the wire sequence.
   *
   * Pure structural mutation — no I/O, no emit. The same messages are
   * either written to the wire (live) or suppressed (during runReplay's
   * bracket); either way the block state must update so the snapshot is
   * ready if the bracket fires.
   *
   * `laneKey` is the batch's `parent_tool_use_id ?? null` — blocks
   * mirror into that lane's map so a subagent's blocks never collide
   * with (or leak into) the main lane's mid-turn snapshot.
   * `toolCallByToolUseId` stays turn-global: tool_use ids are unique
   * across lanes, and `tool_result` correlation events don't re-state
   * which lane minted the block.
   */
  updateBlockStateFromMessages(
    messages: ReadonlyArray<OutboundMessage>,
    laneKey: string | null = MAIN_LANE,
  ): void {
    const laneBlocks = this.laneFor(laneKey).messageBlocks;
    for (const msg of messages) {
      if (msg.type === "content_block_start") {
        const blocks = laneBlocks.get(msg.msg_id) ?? [];
        // Idempotent: if a block with this index already exists, leave
        // it alone. Mirrors the reducer-side `handleContentBlockStart`
        // idempotence ([D07] § Mid-turn replay snapshot).
        if (blocks.some((b) => b.index === msg.block_index)) {
          continue;
        }
        // Construct the kind-specific BlockState variant. The
        // discriminated union guarantees that the required fields
        // (tool_use_id + tool_name for tool_use blocks) are present at
        // type-check time, so no `?? ""` defensive defaults.
        let entry: BlockState;
        if (msg.kind === "text") {
          entry = { index: msg.block_index, kind: "text", text: "" };
        } else if (msg.kind === "thinking") {
          entry = { index: msg.block_index, kind: "thinking", text: "" };
        } else if (msg.kind === "tool_use") {
          entry = {
            index: msg.block_index,
            kind: "tool_use",
            toolUseId: msg.tool_use_id,
            toolName: msg.tool_name,
            toolInput: {},
          };
          // Index the tool block by tool_use_id for O(1) lookup from
          // subsequent tool_use / tool_result / tool_use_structured
          // events. The map holds a reference to the live BlockState
          // in messageBlocks; mutations to it (input fill, result
          // landing) flow through both views automatically.
          this.toolCallByToolUseId.set(msg.tool_use_id, entry);
        } else {
          // Exhaustiveness check — if a future ContentBlockStart kind
          // is added to the discriminated union, this `never` typecheck
          // fails at compile-time, forcing the mint logic to handle the
          // new case explicitly.
          const _exhaustive: never = msg;
          throw new Error(`unknown content_block_start kind: ${JSON.stringify(_exhaustive)}`);
        }
        blocks.push(entry);
        // Keep blocks sorted by index for predictable iteration.
        blocks.sort((a, b) => a.index - b.index);
        laneBlocks.set(msg.msg_id, blocks);
      } else if (msg.type === "assistant_text" || msg.type === "thinking_text") {
        const blocks = laneBlocks.get(msg.msg_id);
        const block = blocks?.find((b) => b.index === msg.block_index);
        if (block === undefined) {
          // Text delta without a matching minted block — either
          // tugcode emitted out of order or the wire shape regressed.
          // Surface loudly so the bug is detectable; the reducer's
          // own append-or-mutate rule would silently drop too.
          console.error(
            `[tugcode] ${msg.type} (msg_id=${msg.msg_id}, block_index=${msg.block_index}) without a matching content_block_start mint`,
          );
          continue;
        }
        if (block.kind !== "text" && block.kind !== "thinking") {
          // Kind mismatch — a text delta arrived under a tool_use
          // block_index. Wire-shape regression.
          console.error(
            `[tugcode] ${msg.type} for (msg_id=${msg.msg_id}, block_index=${msg.block_index}) targets a ${block.kind} block`,
          );
          continue;
        }
        // is_partial: false (the terminal frame) carries the full text;
        // replace. is_partial: true is a delta; append.
        block.text = msg.is_partial ? block.text + msg.text : msg.text;
      } else if (msg.type === "tool_use") {
        // Tool_use IPC events may carry the final input (post
        // input_json_delta accumulation) — update the matching block's
        // toolInput. O(1) lookup via toolCallByToolUseId.
        const block = this.toolCallByToolUseId.get(msg.tool_use_id);
        if (block === undefined) {
          // No matching block — either tugcode emitted the tool_use
          // without a preceding content_block_start, or the wire
          // shape regressed. Surface loudly.
          console.error(
            `[tugcode] tool_use (tool_use_id=${msg.tool_use_id}) without a matching content_block_start mint`,
          );
          continue;
        }
        if (Object.keys(msg.input).length > 0) {
          block.toolInput = msg.input as Record<string, unknown>;
        }
        block.toolName = msg.tool_name;
      } else if (msg.type === "tool_result") {
        const block = this.toolCallByToolUseId.get(msg.tool_use_id);
        if (block === undefined) {
          // tool_result without a corresponding minted tool_use — the
          // reducer would silently drop. Surface here.
          console.error(
            `[tugcode] tool_result (tool_use_id=${msg.tool_use_id}) without a matching tool_use mint`,
          );
          continue;
        }
        block.toolResult = { output: msg.output, isError: msg.is_error };
      } else if (msg.type === "tool_use_structured") {
        const block = this.toolCallByToolUseId.get(msg.tool_use_id);
        if (block === undefined) {
          console.error(
            `[tugcode] tool_use_structured (tool_use_id=${msg.tool_use_id}) without a matching tool_use mint`,
          );
          continue;
        }
        block.toolStructuredResult = msg.structured_result as Record<string, unknown>;
      }
    }
  }

  /**
   * Accumulate one streaming `input_json_delta` fragment onto its tool block
   * and, when the narratable state advances, return a `tool_input_progress`
   * frame for the caller to emit. Returns null when the block isn't a known
   * tool_use block or when nothing display-relevant changed (throttle).
   *
   * Correlation lives here, not in `mapStreamEvent`: the delta carries only
   * `block_index`, and the block was minted (with its tool_use_id / name) by
   * the preceding `content_block_start` via `updateBlockStateFromMessages`
   * — in the lane the delta arrived on, so `laneKey` selects the same map.
   */
  recordToolInputDelta(
    msgId: string,
    blockIndex: number,
    fragment: string,
    laneKey: string | null = MAIN_LANE,
  ): ToolInputProgress | null {
    const blocks = this.laneFor(laneKey).messageBlocks.get(msgId);
    const block = blocks?.find((b) => b.index === blockIndex);
    if (block === undefined || block.kind !== "tool_use") return null;

    block.partialInputJson = (block.partialInputJson ?? "") + fragment;
    const prog = parseToolInputProgress(block.partialInputJson);
    const lines = prog.contentLines ?? 0;

    // Only Write/Edit-shaped inputs (a file path or growing content) are
    // worth narrating; skip frames that would render as a bare tool name.
    if (prog.filePath === null && lines === 0) return null;

    const key = `${prog.filePath ?? ""}|${lines}`;
    if (key === block.progressKey) return null;
    block.progressKey = key;

    return {
      type: "tool_input_progress",
      msg_id: msgId,
      seq: this.seq,
      block_index: blockIndex,
      tool_use_id: block.toolUseId,
      tool_name: block.toolName,
      bytes: prog.bytes,
      content_lines: lines,
      file_path: prog.filePath,
      ipc_version: 2,
    };
  }
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

// The main spawn pipes stderr so it can be pattern-matched for failure
// classification; fork / continue inherit stderr because no
// classification is needed for those paths. Both share stdin/stdout
// "pipe", so the field accepts either stderr mode.
type ClaudeSubprocess =
  | Bun.Subprocess<"pipe", "pipe", "pipe">
  | Bun.Subprocess<"pipe", "pipe", "inherit">;

/**
 * Manages claude CLI process lifecycle, message identity, and streaming.
 * Spawns claude with --output-format stream-json --input-format stream-json
 * per D01/D02.
 */
export class SessionManager {
  private claudeProcess: ClaudeSubprocess | null = null;
  /**
   * Background task draining claude's stdout (Step R1e). Started by
   * {@link spawnClaudeAndWatch} (and the session-command handlers
   * after their respawn) and runs until claude's stdout EOFs. The
   * drain owns the only `getReader()` on `claudeProcess.stdout`;
   * nothing else may read claude's stdout directly. `null` between
   * spawn lifecycles.
   */
  private stdoutDrainTask: Promise<void> | null = null;
  /**
   * The currently-in-flight turn. Opened either by
   * {@link handleUserMessage} (the idle case — no turn running) or by
   * the stdout drain (a buffered follow-on turn — see
   * {@link handleClaudeLine}); closed by the drain when claude's
   * `result` lands or its stdout EOFs. The stdout drain dispatches
   * every parsed claude event into this field's value; when it's
   * `null`, events route through {@link handleInterTurnEvent} unless a
   * turn input is pending. Single-threaded JS guarantees the drain and
   * `handleUserMessage` see a consistent view without locks.
   */
  private activeTurn: ActiveTurn | null = null;
  /**
   * The 250 ms activity-flush interval ([Q06], [P13]). Started lazily the
   * first time a turn dispatches an event and left running (unref'd, so it
   * never blocks process exit) for the session's life; each tick flushes the
   * live turn's accumulator as an `activity_delta`, a no-op between turns.
   * The final decaying bin is emitted by an explicit trailing flush at
   * turn end (before `activeTurn` is cleared), so a short turn that ends
   * within a bin still reports its work. `null` until the first turn.
   */
  private activityFlushTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * FIFO of user messages written to claude's stdin while a turn was
   * already in flight — submitted but not yet bracketed by an
   * `ActiveTurn`. claude buffers a mid-turn `user_message` and runs it
   * as a separate follow-on turn with its own `result`; the stdout
   * drain opens an `ActiveTurn` for that turn and claims the head of
   * this FIFO as the turn's user-message payload. Empty in the common,
   * non-overlapping case (one turn fully completes before the next
   * `handleUserMessage`), so the drain-open path in
   * {@link handleClaudeLine} is dormant in normal operation.
   *
   * Exception: when claude *merges* a mid-turn message into the
   * running turn — it does this at an agent-loop iteration boundary;
   * see `probe-tool-overlap.ts` — no follow-on turn is produced and
   * the merged message's entry is left stale here. tugcode cannot
   * distinguish merge from buffer at submit time (claude emits no
   * signal for it), so a stale entry mislabels at most one later
   * turn's replay-synthetic `add_user_message` text; the wire
   * `turn_complete` bracketing is unaffected. Threading the user's
   * merge-vs-queue intent down from tugdeck is a follow-on concern.
   */
  private pendingTurnInputs: Array<{
    content: ReadonlyArray<ContentBlock>;
  }> = [];
  /**
   * True once the stdout drain has observed EOF on claude's stdout.
   * Read by {@link handleUserMessage} as a fast-path check before
   * installing an `ActiveTurn` — if claude's stdout has already
   * closed, no events will dispatch into the turn and the await on
   * its completion would block forever. The handler emits the
   * canonical end-of-stream error frame and returns instead. Reset
   * by {@link startStdoutDrain} when a fresh claude is spawned.
   */
  private claudeStdoutEofObserved: boolean = false;
  private permissionManager: PermissionManager;
  /**
   * The session's current reasoning-effort level ([#step-4]), or `null` when
   * no `--effort` override is in force. tugcode owns the `--effort` flag, so
   * this is the authority for the effort surfaced in `session_capabilities`
   * and re-applied on every (re)spawn. Set by {@link handleEffortChange},
   * which respawns claude to apply it (there is no live `set_effort` control
   * subtype in 2.1.158 — [R07]).
   */
  private currentEffort: string | null = null;
  /**
   * The model selector the user has chosen (`sonnet`, `fable`, …), or `null`
   * for the account default (which needs no `--model` flag).
   *
   * Unlike model *setting*, which is a live `set_model` control request to the
   * running process, model *survival* is tugcode's job: every respawn tugcode
   * performs for its own reasons — an `--effort` change, an `--add-dir`, a
   * fork, a continue — starts a process that knows nothing of the control
   * requests the old one received. Without this record those respawns silently
   * drop the user's model back to the account default. Recorded by
   * {@link handleModelChange} and re-applied by {@link liveSpawnConfig}.
   */
  private currentModel: string | null = null;
  /**
   * The dash name of the arc this session's claude runs under, or null when it
   * runs under none.
   *
   * Recorded here beside {@link currentModel} rather than in
   * {@link liveSpawnConfig}, which carries spawn *flags* and not environment:
   * the variable must survive tugcode's own respawns (an `--effort` change, an
   * `/add-dir`) exactly as the model does, and {@link spawnClaude} reads it
   * into the child's environment on every one.
   *
   * Per-arc, not per-card: a fresh session started with no stage clears it, so
   * the first plain `/new` after an arc spawns without `TUG_DASH_ARC`.
   */
  private currentArc: string | null = null;
  /**
   * Working directories added via `/add-dir` ([#step-13c]), in add order. Like
   * {@link currentEffort}, tugcode owns the `--add-dir` flags and re-applies
   * these on every (re)spawn (claude has no live add-directory control verb
   * over the bridge). {@link handleAddDirectory} appends + respawns to apply.
   */
  private additionalDirectories: string[] = [];
  /**
   * Optional `/context`-style breakdown emitter. Injected by main.ts
   * after reading the user's Claude Code settings; null in tests and
   * any caller that doesn't supply one. When present, the dispatcher
   * invokes its lifecycle methods on `system:init`, `result`
   * (cost_update), and `system:compact_boundary` events, and on every
   * inbound user message (for calibration anchor data).
   */
  private contextBreakdownEmitter: ContextBreakdownEmitter | null = null;
  private seq: number = 0;
  // Legacy pending maps kept for reference; control flow is now via control_response writes.
  private pendingApprovals = new Map<string, PendingRequest<"allow" | "deny">>();
  private pendingQuestions = new Map<string, PendingRequest<Record<string, string>>>();
  // Stores raw control_requests by request_id for correlation with IPC messages.
  private pendingControlRequests = new Map<string, Record<string, unknown>>();
  private projectDir: string;
  /**
   * The one identifier for this session. Generated by tugdeck (for a
   * fresh spawn) or picked from the tugbank `sessions` record (for a
   * resume), passed to tugcast on `spawn_session`, and forwarded to
   * tugcode via `--session-id`. Claude uses it as its own session id
   * (`claude --session-id <id>` for fresh, `claude --resume <id>` for
   * resume), and tugcode keys the sessions record by it.
   */
  private sessionId: string;
  /**
   * `"new"` spawns claude with `--session-id <id>` (claiming the id);
   * `"resume"` spawns claude with `--resume <id>` (loading an existing
   * conversation). Both modes share the same `initialize()` path; the
   * only mode-specific thing is the claude flag, plus a background
   * watcher that surfaces resume failures via `resume_failed` IPC.
   */
  private sessionMode: "new" | "resume";
  /**
   * The persisted claude session id, threaded in from tugcast via
   * `--resume-session <id>`. Set when tugcast's tugbank record carries
   * a `claude_session_id` for this card; `null` for fresh spawns and
   * for resume spawns whose claude id was never captured (pre-
   * `session_init` crash, or an older tugbank record).
   *
   * In resume mode, this id wins over `sessionId` for the claude
   * `--resume <id>` invocation: when claude has rotated its internal id
   * (e.g., after a fork) the JSONL on disk is keyed by the claude id,
   * not the tug id. The fallback to `sessionId` covers un-forked
   * sessions whose tug and claude ids happen to match.
   */
  private resumeSessionId: string | null;
  /**
   * Set true the first time `handleUserMessage` successfully writes a
   * user message to claude's stdin. After that, claude has been seen
   * alive end-to-end and any subsequent exit is a runtime crash, not
   * an init failure. The early-exit watcher gates its IPC emission on
   * this flag — without it, indefinite watching would mis-classify
   * mid-conversation crashes as init failures.
   */
  private claudeReceivedInput: boolean = false;
  /**
   * Set true when shutdown has begun (signal handler, stdin EOF,
   * killAndCleanup). The early-exit watcher reads this before emitting
   * to avoid surfacing a phantom resume_failed for a claude exit that
   * was caused by us killing it.
   */
  private isShuttingDown: boolean = false;
  /**
   * Definitive failure classification harvested from claude's stderr
   * stream by `startStderrReader`. Overrides the watcher's mode-based
   * heuristic so a `--session-id` collision in fresh mode and a stale
   * `--resume` id are always classified by their actual cause:
   *   `"resume_failed"` ← stderr contained "No conversation found"
   *   `"collision"`     ← stderr contained "is already in use"
   *   `null`            ← nothing recognizable; fall back to mode default
   */
  private claudeStderrClassification:
    | "resume_failed"
    | "collision"
    | null = null;
  /**
   * `true` while `runReplay` is iterating the JSONL bracket. Read by
   * `installEarlyExitWatcher` so a claude crash *during* replay is
   * surfaced through `runReplay`'s own crash branch (which emits
   * `replay_complete { claude_exited_during_replay }` first, then a
   * lifecycle `resume_failed`). Without this flag the watcher would
   * race the replay path and emit `resume_failed` while the card was
   * still in `replaying` phase.
   */
  private replayActive: boolean = false;
  /**
   * Resolver for the in-flight replay's abort race, or `null` when no
   * replay is running. `runReplay` installs it while iterating the
   * JSONL bracket; a `cancel_replay` verb calls it to make the loop's
   * `Promise.race` resolve on the abort branch, which stops pulling the
   * translator and closes the bracket with `replay_complete{aborted}`.
   * Cleared in `runReplay`'s `finally`. Idempotent — calling it when no
   * replay is in flight is a no-op.
   */
  private replayAbortResolve: (() => void) | null = null;
  /**
   * True while a spontaneous-wake bracket is open on the wire — set
   * when `handleInterTurnEvent` emits a `wake_started` IPC frame in
   * response to a `system/task_notification` event, cleared when the
   * wake's terminal `result` lands and the ActiveTurn closes.
   *
   * Gates two behaviors:
   *   1. Nested `system/task_notification` arriving inside an open
   *      wake is a no-op (idempotent — one bracket per wake on the
   *      wire; inner trigger metadata is logged at debug level only).
   *   2. The ActiveTurn-cleanup site in `handleClaudeLine` also clears
   *      this flag so the next `system/task_notification` re-opens a
   *      fresh bracket.
   *
   * See `dash/tugplan-session-wake.md` [D02] for the detector
   * design and [Q01] for the empirical wire shape that justifies
   * `handleInterTurnEvent` (not `routeTopLevelEvent`) as the detector
   * site — `task_notification` arrives strictly between turns.
   */
  private isInWake: boolean = false;
  /**
   * Live tailers for running background agents, keyed by `agentId`
   * (= the agent's task id on its lifecycle frames). Started from the
   * async-launch echo ({@link extractAsyncLaunch}), stopped with a
   * final flush on the agent's terminal `task_updated` /
   * `task_notification` or on claude teardown, and rewound to offset 0
   * by `runReplay` so a reconnecting deck re-receives the full child
   * set (the deck's id-keyed dedup absorbs the overlap).
   */
  private subagentTailers = new Map<string, SubagentTailer>();
  /** Configurable JSONL archive root; defaults to ~/.claude/projects. */
  private claudeProjectsRoot: string;
  /** Configurable JSONL reader; default uses `Bun.file`. */
  private jsonlReader: (path: string) => Promise<JsonlReadResult>;
  /** Configurable JSONL writer ([#step-7-2]); default uses `Bun.write`. */
  private jsonlWriter: (path: string, content: string) => Promise<void>;
  /** Hard-timeout override (test hook). */
  private replayTimeoutMs: number;
  /** Live-buffer overflow threshold (test hook). */
  private replayLiveBufferMax: number;
  /** Replay telemetry sink forwarded into `translateJsonlSession`. */
  private replayTelemetry: ReplayTelemetry | undefined;
  /** Translate-loop slice override; `undefined` → translator default. */
  private replayTimeSliceMs: number | undefined;
  /**
   * Read-only handle on tugcast's `sessions.db`. Opened once at
   * construction (so each `runReplay` call reuses one prepared statement
   * cache) and held for the lifetime of the manager. `null` when the
   * file doesn't exist yet (fresh install with no tugcast writes), when
   * the open fails for any reason, or when a test explicitly skips it
   * via the `sessionsDbPath: null` option. Production tugcast keeps the
   * file in WAL mode; cross-process WAL visibility is verified by
   * `sessions-db-cross-process.test.ts` and gates the rest of Step 4.6.
   */
  private sessionsDb: Database | null = null;
  /** Resolved path of `sessionsDb` for diagnostics; `null` if no DB. */
  private sessionsDbPath: string | null = null;
  /**
   * Promise that resolves once {@link spawnClaudeAndWatch} has
   * finished its synchronous setup (claude process handle assigned,
   * watchers installed). {@link handleUserMessage} awaits this before
   * any claude stdin write so a user submit that lands during the
   * cold-boot replay window — between `prepareSession()` and the
   * background `spawnClaudeAndWatch()` — blocks until claude is
   * ready, rather than throwing "Session not initialized".
   *
   * `null` until {@link prepareSession} or {@link spawnClaudeAndWatch}
   * sets it. New-mode `initialize()` resolves it eagerly inside the
   * spawn step (no preceding gate); resume-mode flows establish the
   * gate in `prepareSession()` and resolve it in
   * `spawnClaudeAndWatch()`.
   */
  private claudeReadyPromise: Promise<void> | null = null;
  private claudeReadyResolve: (() => void) | null = null;
  /**
   * Held while a respawn is in flight — the kill of the live claude through
   * the seating of the next one. Inbound frames are dispatched without
   * awaiting one another, so a `user_message` that arrives behind a
   * `session_command` would otherwise be written to the process being
   * retired, or refused on its EOF, and never reach the fresh one.
   * {@link handleUserMessage} waits on this; {@link respawn} owns it.
   */
  private respawnGate: Promise<void> | null = null;
  /**
   * Set true the first time the stdout drain observes a `system/init`
   * event for the current claude subprocess. Subsequent `system/init`
   * events from the same subprocess are **wake bracket signals** — the
   * harness's built-in scheduler fires `ScheduleWakeup` / `CronCreate`
   * timers between turns and emits a fresh `system/init` to bracket
   * the resulting assistant turn (verified by long-hold capture probes;
   * see `dash/wake-investigation-findings.md` and design decision
   * [D07]). Reset to false in {@link killAndCleanup} so a respawn
   * (fork / continue / new session) treats its own first init as a
   * first init, not as a wake.
   */
  private sessionInitSeen: boolean = false;

  /**
   * `request_id` of the `initialize` control-request sent at spawn, or
   * `null` before it's sent / after its response lands. claude answers
   * this turn-free with a `control_response` carrying the session's
   * capabilities (model list, command catalog, …); the stdout drain
   * correlates the response by this id and emits a `session_capabilities`
   * IPC. Reset on respawn so a fresh handshake is issued each spawn.
   */
  private initializeRequestId: string | null = null;
  /**
   * Set true once claude's turn-free `initialize` control-response has been
   * correlated (the handshake ack). Proof that claude launched, loaded, and —
   * for a resume — successfully opened its JSONL. {@link installEarlyExitWatcher}
   * reads it so a *later* clean exit is classified as a runtime crash
   * (recoverable, retried by the bridge's crash budget) rather than a phantom
   * `resume_failed`: a genuinely stale `--resume` id exits within ~1s and never
   * acks the handshake. Reset in {@link killAndCleanup} so each spawn re-proves
   * itself.
   */
  private initializeHandshakeAcked: boolean = false;
  /**
   * Resolvers parked on {@link awaitSpawnReady} — callers that need to know
   * the CURRENT spawn has loaded, not merely that it was launched. Drained
   * when the handshake acks and again in {@link killAndCleanup}, so a waiter
   * whose process died never hangs. Empty when nobody is waiting.
   */
  private initializeAckWaiters: Array<() => void> = [];
  /**
   * Pending cancel-escalation timer. Armed by {@link handleInterrupt} after the
   * in-band interrupt control-request; fires {@link forceTerminateAndRespawn}
   * if a wedged claude doesn't end the turn within {@link INTERRUPT_ACK_GRACE_MS}.
   * Cleared the moment the turn completes by any path. `null` when unarmed.
   */
  private interruptEscalationTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Pending result-liveness watchdog timer. Armed when a terminal `stop_reason`
   * is seen with no `result` yet; fires {@link forceTerminateAndRespawn} after
   * {@link RESULT_WATCHDOG_MS}. Cleared on `result` or a fresh `message_start`
   * (a new iteration means claude kept working). `null` when unarmed.
   */
  private resultWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Re-entrancy guard for {@link forceTerminateAndRespawn}: the interrupt
   * ladder and the result watchdog can both fire for the same wedge, and the
   * teardown/respawn must run exactly once.
   */
  private forceTerminateInProgress: boolean = false;
  /**
   * The Claude Code CLI version (`claude --version`), resolved once per spawn
   * and folded into the turn-free `session_capabilities` handshake so the
   * frontend's Claude Code badge reads a real version from the drop instead of
   * "?" until the first turn. `null` until resolved / when resolution fails.
   * claude's `initialize` response carries no version — only the post-turn
   * `system/init` does — so tugcode sources it locally, mirroring the bundled
   * plugin-command augmentation.
   */
  private claudeCodeVersion: string | null = null;
  /**
   * In-flight `rewind_files` control requests ([#step-7-1]), keyed by the
   * `request_id` sent to claude. Each entry carries the originating
   * `promptUuid` + the rewind dimension so the `control_response` (caught
   * turn-free in {@link handleClaudeLine}, same pattern as the `initialize`
   * handshake) can be mapped back to the right outbound IPC — a
   * `rewind_preview_result` for a `dry_run` query, or a `rewind_result`
   * ack for an apply. Cleared on correlation.
   */
  private pendingRewindRequests = new Map<
    string,
    {
      promptUuid: string;
      kind: "preview";
      /**
       * Whether the conversation dimension can rewind to this anchor
       * ([#step-7-3]) — computed from the session JSONL at request time (the
       * same `computeConversationTruncation` "ok" condition the apply path
       * enforces) and relayed on the `rewind_preview_result`. Lets the picker
       * disable a row whose conversation rewind would error.
       */
      conversationRewindable: boolean;
    } | {
      promptUuid: string;
      kind: "apply";
      scope: "conversation" | "code" | "both";
      /**
       * Resolver for the promisified code-restore leg ([#step-7-2]). The
       * apply path awaits the `control_response` so `scope:"both"` can run
       * the code restore FIRST, then the conversation rewind, then emit a
       * single combined `rewind_result`. A `preview` entry has none (its
       * result is emitted directly on correlation).
       */
      resolve: (r: { canRewind: boolean; error?: string }) => void;
    }
  >();

  /**
   * In-flight `/btw` side questions, keyed by the `request_id` the client
   * minted (reused verbatim as the control `request_id`, so one map keys the
   * whole round-trip). Each entry carries the originating `question` for
   * logging. The `control_response` is caught turn-free in
   * {@link handleClaudeLine} — the same pre-routing pattern as the
   * `initialize` handshake and {@link pendingRewindRequests} — which is why a
   * side question answers idle *and* mid-turn (the correlation is
   * turn-state-independent). Cleared on correlation.
   */
  private pendingSideQuestions = new Map<string, { question: string }>();

  /**
   * Cached JSONL read for the `/rewind` preview batch ([#step-7-3]). The sheet
   * fires one `rewind_preview` per row when it opens — all while idle, so the
   * session JSONL is stable — and each needs to know whether its anchor is
   * conversation-rewindable. Reading the (possibly large) JSONL once and
   * sharing the promise avoids N re-reads. Cleared when a turn opens
   * ({@link handleUserMessage}) or the session respawns ({@link killAndCleanup})
   * — i.e. whenever the JSONL could change.
   */
  private rewindPreviewJsonl: Promise<JsonlReadResult> | null = null;

  constructor(
    projectDir: string,
    sessionId: string,
    sessionMode: "new" | "resume" = "new",
    resumeSessionId?: string,
    options?: {
      claudeProjectsRoot?: string;
      jsonlReader?: (path: string) => Promise<JsonlReadResult>;
      jsonlWriter?: (path: string, content: string) => Promise<void>;
      replayTimeoutMs?: number;
      replayLiveBufferMax?: number;
      replayTelemetry?: ReplayTelemetry;
      /**
       * Override for the translate loop's continuous-work budget
       * (`TranslateSessionOptions.timeSliceMs`). Tests pass `0` to
       * force a yield after every message — the deterministic stand-in
       * for "the iterator stalls mid-replay" that the hard-timeout
       * test needs. Omit → the translator's default slice.
       */
      replayTimeSliceMs?: number;
      /**
       * Override for the sessions.db path. Tests pass a tempfile so
       * they don't read the real user's database. Pass `null` to
       * explicitly skip opening any DB (cold-boot fallback paths
       * exercise this). Omit / undefined → use {@link defaultSessionsDbPath}.
       */
      sessionsDbPath?: string | null;
      /**
       * Pre-constructed context_breakdown emitter. main.ts builds it
       * once at startup (after reading settings.json) and threads it
       * here so the emitter knows the session id and the user's
       * autocompact preference. `null` / undefined → no
       * `context_breakdown` frames are produced; the popover hits its
       * 20.4.7.C fallback view. Tests omit it for backwards-compat.
       */
      contextBreakdownEmitter?: ContextBreakdownEmitter | null;
      /**
       * Permission mode to seed the session with — tugdeck's resolved
       * per-card / deck-wide default, forwarded by tugcast as
       * `--permission-mode` ([main.ts]). Applied to the {@link PermissionManager}
       * before the first spawn, so `buildClaudeArgs` passes the correct
       * `--permission-mode` from claude's first instant rather than tugcode's
       * baseline default (which a post-spawn `permission_mode` frame would
       * otherwise have to correct at runtime, racing the first turn). Omit /
       * undefined → the manager keeps its `"default"` baseline.
       */
      initialPermissionMode?: PermissionMode;
    },
  ) {
    if (!sessionId) {
      throw new Error("SessionManager: sessionId is required");
    }
    this.projectDir = projectDir;
    this.sessionId = sessionId;
    this.sessionMode = sessionMode;
    // Seed the permission manager with tugdeck's resolved default (forwarded
    // as `--permission-mode`) so the first spawn carries it; absent → the
    // manager's own `"default"` baseline.
    this.permissionManager = new PermissionManager(options?.initialPermissionMode);
    // Coerce `undefined` / empty string to `null` so the fallback
    // logic in `initialize()` has a single test (`!= null`) rather
    // than two (`!== undefined && !== ""`).
    this.resumeSessionId =
      typeof resumeSessionId === "string" && resumeSessionId.length > 0
        ? resumeSessionId
        : null;
    this.claudeProjectsRoot =
      options?.claudeProjectsRoot ?? DEFAULT_CLAUDE_PROJECTS_ROOT;
    this.jsonlReader = options?.jsonlReader ?? defaultJsonlReader;
    this.jsonlWriter = options?.jsonlWriter ?? defaultJsonlWriter;
    this.replayTimeoutMs = options?.replayTimeoutMs ?? REPLAY_HARD_TIMEOUT_MS;
    this.replayLiveBufferMax =
      options?.replayLiveBufferMax ?? REPLAY_LIVE_BUFFER_MAX;
    this.replayTelemetry = options?.replayTelemetry;
    this.replayTimeSliceMs = options?.replayTimeSliceMs;
    this.contextBreakdownEmitter = options?.contextBreakdownEmitter ?? null;
    this.openSessionsDb(options?.sessionsDbPath);
  }

  /**
   * Try to open the sessions.db file read-only. Failure (file missing,
   * permission error, malformed) is logged but non-fatal: `runReplay`
   * falls back to JSONL-driven cold-boot when `sessionsDb === null`.
   * This preserves D08 equivalence for fresh installs / pre-migration
   * sessions and survives the case where tugcast hasn't yet been run.
   */
  private openSessionsDb(override: string | null | undefined): void {
    if (override === null) {
      // Explicit opt-out (test path that wants the no-DB cold-boot
      // fallback exercised).
      return;
    }
    const path = override ?? defaultSessionsDbPath();
    try {
      this.sessionsDb = new Database(path, { readonly: true });
      this.sessionsDbPath = path;
    } catch (err) {
      // File missing / unreadable: leave sessionsDb null. runReplay
      // checks `this.sessionsDb !== null` before any read.
      this.sessionsDb = null;
      this.sessionsDbPath = null;
      logReplay("sessions_db_unavailable", {
        session_id: this.sessionId,
        path,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Close the sessions.db handle. The existing public `shutdown()`
   * already covers the claude-subprocess teardown; this private
   * helper wraps the read-only DB close so production teardown and
   * tests can call it without re-entering the subprocess kill path.
   */
  private closeSessionsDb(): void {
    if (this.sessionsDb !== null) {
      try {
        this.sessionsDb.close();
      } catch {
        // Already closed or never fully opened — no-op.
      }
      this.sessionsDb = null;
    }
  }

  private nextSeq(): number {
    return this.seq++;
  }

  /**
   * Spawn the claude CLI process with stream-json flags.
   *
   * `mode` picks between `--session-id <id>` (for a fresh spawn that
   * claims a tugdeck-generated UUID as claude's own session id) and
   * `--resume <id>` (for a resume of an existing conversation). `null`
   * lets claude generate its own session id — used by the fork/new
   * session handlers below.
   */
  /**
   * The spawn fields that describe the LIVE session's settings rather than
   * which conversation to open — plugin dir, permission mode, reasoning
   * effort, model, and the `/add-dir` roots.
   *
   * Every `buildClaudeArgs` caller needs all of them, and each caller differs
   * only in its session flags (`--resume` / `--session-id` / `--continue` /
   * `--fork-session`). Threading them by hand at three call sites is how the
   * model came to be applied at none of them: a field added beside
   * `currentEffort` reaches only the call site whose author remembered it.
   * Spread this instead, and the next flag lands everywhere at once.
   */
  private liveSpawnConfig(): Pick<
    ClaudeSpawnConfig,
    "pluginDir" | "permissionMode" | "effort" | "model" | "additionalDirectories"
  > {
    return {
      pluginDir: this.getPluginDir(),
      permissionMode: this.permissionManager.getMode(),
      effort: this.currentEffort,
      model: this.currentModel,
      additionalDirectories: this.additionalDirectories,
    };
  }

  private spawnClaude(
    id: string | null,
    mode: "session-id" | "resume",
  ): ClaudeSubprocess {
    const claudePath = resolveClaudePath();
    if (!claudePath) {
      throw new Error("claude CLI not found (PATH or ~/.local/bin)");
    }

    // Resolve the Claude Code version once per session (it is stable for a
    // given binary). Folded into the turn-free `session_capabilities`
    // handshake below so the frontend's Claude Code badge reads a real version
    // from the drop.
    if (this.claudeCodeVersion === null) {
      this.claudeCodeVersion = resolveClaudeCodeVersion(claudePath);
    }

    const args = buildClaudeArgs({
      ...this.liveSpawnConfig(),
      sessionId: mode === "resume" ? id : null,
      sessionIdOverride: mode === "session-id" && id !== null ? id : undefined,
    });

    console.log(`Spawning claude with args: ${args.join(" ")}`);
    logSessionLifecycle("tugcode.claude_spawn", {
      session_id: this.sessionId,
      mode,
      cwd: this.projectDir,
      args: args.join(" "),
    });

    // Scrub Anthropic auth env vars so the claude CLI authenticates via
    // `~/.claude.json` (the user's Max/Pro subscription) rather than
    // per-token API billing. Bun.spawn inherits the parent process
    // environment by default when `env` is omitted, so we must pass an
    // explicit env with these keys removed.
    //
    // Keep this list in sync with `AUTH_ENV_VARS` in
    // `tugrust/crates/tugcast/tests/common/catalog.rs` and the
    // `env_remove` calls in `tugrust/crates/tugcast/src/feeds/agent_bridge.rs`.
    const {
      ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN,
      ...scrubbedEnv
    } = process.env as Record<string, string | undefined>;
    void ANTHROPIC_API_KEY;
    void ANTHROPIC_AUTH_TOKEN;
    void CLAUDE_CODE_OAUTH_TOKEN;

    // `TUG_SESSION_ID` (set by tugcast on the tugcode spawn, next to the
    // `env_remove` auth-scrub above) is deliberately NOT destructured out
    // here — it rides through `scrubbedEnv` to claude, which forwards its
    // environment to Bash tool calls. This is the chain that lets a skill
    // or CLI run inside the session read `$TUG_SESSION_ID` and self-
    // identify; `tugutil changes` keys its file-event query on it. If the
    // auth-scrub destructure ever grows, keep this variable out of it.

    // Enable file checkpointing so the session-card's `/rewind` can restore the
    // *code* dimension (not just the conversation). The terminal has this on
    // by default; in stream-json/SDK mode it is opt-in via this env var.
    // Once enabled, claude snapshots files it edits via Edit/Write (not bash
    // or manual edits) into its per-session `fileHistory`, and the
    // `rewind_files` control request becomes answerable — `{canRewind}` plus
    // `{filesChanged, insertions, deletions}` for the picker's per-turn diff
    // stats (empirically captured against claude 2.1.158; see
    // dash/transport-exploration.md#rewind-files-control-request).
    scrubbedEnv.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = "true";

    // Under an arc, the stage's claude carries the dash name so the three
    // stage skills can read it from a Bash step and stop at their natural end
    // instead of printing a chip or reviewing inline. Set per spawn from
    // {@link currentArc}, so it survives every respawn the session makes; a
    // session started with no stage clears the record and spawns without it.
    if (this.currentArc !== null) {
      scrubbedEnv.TUG_DASH_ARC = this.currentArc;
    } else {
      delete scrubbedEnv.TUG_DASH_ARC;
    }

    return Bun.spawn([claudePath, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      // Pipe stderr (rather than inherit) so we can pattern-match
      // claude's diagnostic strings ("No conversation found", "already
      // in use") for definitive early-exit classification. The reader
      // forwards every line verbatim to process.stderr so tugcast's
      // tugcode_stderr capture continues to see exactly what claude
      // emitted — no observable behavior change for operators.
      stderr: "pipe",
      cwd: this.projectDir,
      env: scrubbedEnv,
    });
  }

  /**
   * Kill and clean up the current claude process.
   *
   * Default (graceful): closes stdin (EOF) to signal claude to finish, waits
   * up to 5s, then force-kills if still running — used by respawn / fork /
   * truncate where claude is healthy and reading stdin.
   *
   * `escalate` mode: a *wedged* claude isn't servicing its stdin, so an EOF
   * won't land. Skip the graceful wait and go straight to the signal ladder —
   * SIGINT, a short {@link FORCE_TERMINATE_SIGINT_GRACE_MS} grace, then
   * SIGKILL. This is the OS-level lever the in-band interrupt can't reach
   * (the 2026-07-22 commit-xp hang).
   *
   * Either way, the old stdout drain is awaited before returning so its EOF
   * `finally` ({@link signalEofToActiveTurn} — emits the turn's terminal frame
   * and resolves its completion) runs before a respawn resets
   * `claudeStdoutEofObserved`; without the await the two race and a fresh
   * spawn can inherit a stale "EOF observed" flag.
   */
  private async killAndCleanup(opts?: {
    escalate?: boolean;
    graceMs?: number;
  }): Promise<void> {
    const escalate = opts?.escalate === true;
    const graceMs = opts?.graceMs ?? CLAUDE_EOF_GRACE_MS;
    // Mark shutdown so the early-exit watcher ignores the exit code
    // from our kill rather than surfacing a phantom resume_failed.
    this.isShuttingDown = true;
    // A deliberate teardown cancels any armed cancel-escalation / result
    // watchdog — the process we were guarding is going away.
    this.clearInterruptEscalation();
    this.clearResultWatchdog();
    // The session is changing (respawn / fork / truncate) — drop the cached
    // `/rewind` preview JSONL so the next preview re-reads ([#step-7-3]).
    this.rewindPreviewJsonl = null;
    // Stop the activity-flush heartbeat; a respawn re-arms it on its first
    // turn event via `ensureActivityFlush`.
    if (this.activityFlushTimer !== null) {
      clearInterval(this.activityFlushTimer);
      this.activityFlushTimer = null;
    }
    // Claude exit forces each live background-agent tailer's final
    // flush: drain what its file holds and compose the final answer.
    await this.stopAllSubagentTailers();
    const drainTask = this.stdoutDrainTask;
    if (this.claudeProcess) {
      const child = this.claudeProcess;
      if (escalate) {
        // Signal ladder for a wedged claude: SIGINT, brief grace, SIGKILL.
        try {
          child.kill("SIGINT");
          await Promise.race([
            child.exited,
            new Promise<void>((res) =>
              setTimeout(res, FORCE_TERMINATE_SIGINT_GRACE_MS),
            ),
          ]);
        } catch {
          // Process may already be gone.
        }
        try {
          child.kill("SIGKILL");
          await child.exited;
        } catch {
          // Already terminated.
        }
      } else {
        let exited = false;
        try {
          // Close stdin to signal EOF (graceful shutdown).
          child.stdin.end();
          // Wait for the process to exit, bounded by the caller's grace.
          exited = await Promise.race([
            child.exited.then(() => true),
            new Promise<boolean>((res) =>
              setTimeout(() => res(false), graceMs),
            ),
          ]);
        } catch {
          // Process may already be gone.
        }
        if (!exited) {
          // A claude that outlives its EOF grace gets the signal ladder,
          // with SIGKILL as the guaranteed last rung: a SIGTERM-ignoring
          // claude would otherwise never close its stdout, pinning
          // `drainTask` — and the whole shutdown — open forever. The
          // rung is scaled to the caller's grace so a quiesce-budgeted
          // teardown stays inside its budget.
          const rungMs = Math.min(
            FORCE_TERMINATE_SIGINT_GRACE_MS,
            Math.max(250, graceMs / 2),
          );
          try {
            child.kill();
            const terminated = await Promise.race([
              child.exited.then(() => true),
              new Promise<boolean>((res) =>
                setTimeout(() => res(false), rungMs),
              ),
            ]);
            if (!terminated) {
              child.kill("SIGKILL");
              await child.exited;
            }
          } catch {
            // Already terminated.
          }
        }
      }
      this.claudeProcess = null;
      // The drain task observes EOF on the closed stdout stream and
      // exits its loop; reset the handle so a subsequent respawn can
      // start a fresh drain without cross-contamination.
      this.stdoutDrainTask = null;
    }
    // Let the old drain finish its EOF `finally` before we return (and before
    // any respawn resets `claudeStdoutEofObserved`). Cheap: the reader is
    // already at EOF on a killed process.
    if (drainTask) {
      try {
        await drainTask;
      } catch {
        // Drain surfaced its own error already; nothing to do here.
      }
    }
    // Reset the re-init tracker so the respawn's first `system/init`
    // is classified as a first init (not a wake bracket signal). See
    // [D07] for the wake-bracket detector design. Lives outside the
    // `if (this.claudeProcess)` guard so the reset still happens for
    // an already-dead subprocess (manager state can drift if a prior
    // crash left `sessionInitSeen` true but `claudeProcess` null).
    this.sessionInitSeen = false;
    // Clear the pending `initialize` correlation so a respawn issues a
    // fresh handshake rather than matching the dead process's id.
    this.initializeRequestId = null;
    // The next spawn must re-prove itself before its exit is read as a crash.
    this.initializeHandshakeAcked = false;
    // Nobody may wait on a handshake from a process that is gone; the next
    // spawn parks its own waiters.
    this.drainInitializeAckWaiters();
  }

  /** Clear the armed cancel-escalation timer, if any. */
  private clearInterruptEscalation(): void {
    if (this.interruptEscalationTimer !== null) {
      clearTimeout(this.interruptEscalationTimer);
      this.interruptEscalationTimer = null;
    }
  }

  /** Clear the armed result-liveness watchdog timer, if any. */
  private clearResultWatchdog(): void {
    if (this.resultWatchdogTimer !== null) {
      clearTimeout(this.resultWatchdogTimer);
      this.resultWatchdogTimer = null;
    }
  }

  /**
   * Force-terminate a wedged claude and respawn `--resume`, keeping the card
   * bound. The recovery primitive shared by the cancel-escalation ladder
   * ({@link handleInterrupt}) and the result-liveness watchdog
   * ({@link armResultWatchdog}).
   *
   * The turn (if any) is flagged `interrupted` first so the drain's EOF path
   * closes it as `turn_cancelled` (a clean cancel receipt), not `error`. The
   * kill is the escalate signal ladder; the respawn is a plain resume against
   * the current claude id, so everything claude persisted to its JSONL is
   * retained — this is a recovery, never a retraction/truncation. Resume mode
   * is forced even for a `new`-mode session: its on-disk JSONL already exists
   * under its id, so `--resume` is correct and avoids a `--session-id`
   * collision.
   *
   * Idempotent via {@link forceTerminateInProgress}: the interrupt ladder and
   * the watchdog may both fire for one wedge.
   */
  private async forceTerminateAndRespawn(reason: string): Promise<void> {
    if (this.forceTerminateInProgress) return;
    this.forceTerminateInProgress = true;
    try {
      logSessionLifecycle("tugcode.force_terminate", {
        session_id: this.sessionId,
        reason,
      });
      // Close the in-flight turn as a cancel, not an error, when the drain
      // observes the kill's EOF.
      if (this.activeTurn !== null) {
        this.activeTurn.interrupted = true;
      }

      await this.killAndCleanup({ escalate: true });

      // killAndCleanup latched `isShuttingDown` for the teardown; clear it so
      // the fresh spawn's watcher is armed normally.
      this.isShuttingDown = false;

      // Respawn resume — keep the card bound, reload the intact JSONL.
      this.sessionMode = "resume";
      const claudeId = this.resolveClaudeId();
      this.claudeProcess = this.spawnClaude(claudeId, "resume");
      this.startStdoutDrain(this.claudeProcess);
      this.startStderrReader();
      this.installEarlyExitWatcher();
      this.sendInitializeHandshake();
      this.writeSyntheticSessionInit(claudeId);

      logSessionLifecycle("tugcode.force_terminate_respawned", {
        session_id: this.sessionId,
        claude_session_id: claudeId,
        reason,
      });
    } finally {
      this.forceTerminateInProgress = false;
    }
  }

  /**
   * Arm the cancel-escalation timer for an interrupted turn. If the in-band
   * interrupt control-request doesn't end the turn within
   * {@link INTERRUPT_ACK_GRACE_MS}, claude is wedged and can't service its own
   * stdin — force-terminate and resume-respawn so the user's cancel wins.
   * The timer is cancelled the instant the turn completes by any path.
   */
  private armInterruptEscalation(turn: ActiveTurn): void {
    this.clearInterruptEscalation();
    const timer = setTimeout(() => {
      this.interruptEscalationTimer = null;
      // The turn ended on its own (clean interrupt ack, or the drain already
      // closed it) — nothing to escalate.
      if (this.activeTurn !== turn || turn.gotResult) return;
      logSessionLifecycle("tugcode.interrupt_escalation", {
        session_id: this.sessionId,
      });
      void this.forceTerminateAndRespawn("interrupt_unacked");
    }, INTERRUPT_ACK_GRACE_MS);
    // A pending escalation must never keep tugcode alive at shutdown.
    timer.unref?.();
    this.interruptEscalationTimer = timer;
    // Cancel the escalation the moment the turn completes by ANY path
    // (clean result, or the force-kill's own EOF).
    void turn.completion.then(() => this.clearInterruptEscalation());
  }

  /**
   * Arm the result-liveness watchdog for a turn that just closed its final
   * assistant message (terminal `stop_reason`) but hasn't emitted `result`.
   * If `result` doesn't land within {@link RESULT_WATCHDOG_MS} the turn is
   * wedged post-content — force-terminate and resume-respawn. Re-arming (a
   * later terminal stop in the same turn) resets the clock.
   */
  private armResultWatchdog(turn: ActiveTurn): void {
    this.clearResultWatchdog();
    const timer = setTimeout(() => {
      this.resultWatchdogTimer = null;
      if (this.activeTurn !== turn || turn.gotResult) return;
      logSessionLifecycle("tugcode.result_watchdog_fired", {
        session_id: this.sessionId,
      });
      void this.forceTerminateAndRespawn("result_timeout");
    }, RESULT_WATCHDOG_MS);
    // A pending watchdog must never keep tugcode alive at shutdown.
    timer.unref?.();
    this.resultWatchdogTimer = timer;
  }

  /**
   * Pick the claude session id this session will spawn / resume
   * against. For new mode it's the tug session id. For resume mode
   * the persisted claude id wins (the two diverge after a fork; for
   * un-forked sessions they're equal, so the fallback to `sessionId`
   * is safe and preserves legacy behavior for older tugbank records).
   */
  private resolveClaudeId(): string {
    return this.sessionMode === "resume"
      ? (this.resumeSessionId ?? this.sessionId)
      : this.sessionId;
  }

  /**
   * Emit the synthesized `session_init` IPC line.
   *
   * The synthesized init carries the same id we'll spawn claude with
   * (`claudeId`), not always `this.sessionId`. For fresh spawns the
   * two are equal. For resume spawns whose claude id has diverged
   * from the tug id (forked session, or a resume of a session whose
   * claude id was already different), the distinction matters:
   * tugcast's `relay_session_io` atomic-promote block reads this id
   * and persists it as `LedgerEntry::claude_session_id`, so emitting
   * the wrong id here would briefly corrupt the on-disk record until
   * the real `system:init` from claude's stream-json arrives on the
   * first user message and overwrites it.
   */
  private writeSyntheticSessionInit(claudeId: string): void {
    writeLine({
      type: "session_init",
      session_id: claudeId,
      ipc_version: 2,
    });
  }

  /**
   * Resume-only: emit the synthetic `session_init` and arm the
   * `claudeReadyPromise` gate, all *before* claude has been spawned.
   * The cold-boot resume flow (Step R0d / R4) is:
   *
   *   1. `prepareSession()` — emit the init synchronously so tugcast
   *      sees the session as live and broadcasts `spawn_session_ok`;
   *      tugdeck constructs services and dispatches `request_replay`
   *      (Step R1c). The user sees the card open.
   *   2. `void spawnClaudeAndWatch()` — spawn claude in the
   *      background. The returned Promise resolves once the spawn
   *      handle is wired up; `handleUserMessage` awaits it. The
   *      stdout drain (Step R1e) starts here.
   *
   * The replay step is no longer in this list. Step R4 (Phase A-R4)
   * removed the direct `runReplay()` invocation from cold-boot:
   * replay is request-driven only, triggered by the `request_replay`
   * inbound verb. The supervisor queues the verb during the Spawning
   * window and drains it into tugcode's stdin during the same
   * critical section that promotes Spawning→Live, so replay arrives
   * at the same wire timing as the pre-collapse startup-replay path.
   *
   * Wire-semantic note. Pre-R0d, `spawn_session_ok` reaching tugdeck
   * meant "claude is alive on the other side". Post-R0d, it means
   * "tugcode has accepted ownership of this id, and claude is being
   * spawned in the background." The wire bytes are identical; only
   * the timing relative to the claude spawn changes. Future code
   * must not silently rely on `spawn_session_ok` as a "claude alive"
   * signal — use the `claudeReadyPromise` gate instead.
   *
   * Throws on `sessionMode === "new"`. New-mode spawns retain the
   * historical eager path through `initialize()`.
   */
  prepareSession(): void {
    if (this.sessionMode !== "resume") {
      throw new Error(
        "SessionManager.prepareSession(): resume-mode only; " +
          "new-mode callers should call initialize() directly.",
      );
    }
    const claudeId = this.resolveClaudeId();

    // Establish the readiness gate. handleUserMessage awaits it;
    // spawnClaudeAndWatch resolves it. Order:
    // prepareSession → runReplay → spawnClaudeAndWatch — and any
    // user_message that lands during replay is gated until claude
    // is ready instead of throwing "Session not initialized".
    this.claudeReadyPromise = new Promise<void>((resolve) => {
      this.claudeReadyResolve = resolve;
    });

    logSessionLifecycle("tugcode.prepare_session", {
      session_id: this.sessionId,
      claude_session_id: claudeId,
      session_mode: "resume",
    });

    this.writeSyntheticSessionInit(claudeId);
  }

  /**
   * Spawn claude with `--session-id` (new mode) or `--resume` (resume
   * mode), wire up the stdout reader, and install the stderr reader
   * + early-exit watcher. Resolves the `claudeReadyPromise` so any
   * subsequent `handleUserMessage` may proceed.
   *
   * Used by both modes. New mode calls this from `initialize()`
   * (eager). Resume mode (Step R0d) calls it directly from `main.ts`
   * after `runReplay()` so claude's 5–10s binary load happens in the
   * background while the user is already looking at the populated
   * transcript.
   *
   * Failure-detection posture (post-R1d):
   *
   * The early-exit watcher (`installEarlyExitWatcher`) catches the
   * common cases — claude exits during init for any reason (stale
   * `--resume` id, `--session-id` collision, missing binary, immediate
   * crash) — by pattern-matching claude's stderr and surfacing
   * `resume_failed`. That is the only observable "claude failed"
   * signal tugcode has at startup.
   *
   * R0d originally introduced a 30s spawn-watchdog timer on top of
   * the watcher to catch a "claude is hung silently — running but
   * unresponsive" failure mode. That timer was removed in
   * [Step R1d](dash/tugplan-session-transcript-resume.md#step-r1d):
   * the proxy it used (`claudeReceivedInput`) only flips on user
   * input, so its actual semantic was "user idle for 30s," not
   * "claude is hung." Smoke B exposed this — Maker>Reload doesn't
   * trigger a `user_message`, the timer fired regardless of claude's
   * health, and a healthy claude got killed at the 30-second mark.
   *
   * The trade-off the removal accepts: a genuinely-hung claude
   * (running but never emits, never exits) leaves the user with a
   * populated transcript that doesn't react to the first submit.
   * That failure mode is rare; the user's recourse is to close the
   * card and reopen. The false-positive on user idle was the larger
   * cost. Empirically (kept from the pre-R0d notes): claude in
   * stream-json mode does NOT emit `system:init` until it receives
   * input, regardless of mode — so absence-of-stdout is
   * indistinguishable from absence-of-input, and there is no
   * observable signal we could plumb that would distinguish "hung"
   * from "idle" without sending a probe.
   */
  spawnClaudeAndWatch(): Promise<void> {
    const claudeFlag = this.sessionMode === "resume" ? "resume" : "session-id";
    const claudeId = this.resolveClaudeId();

    this.claudeProcess = this.spawnClaude(claudeId, claudeFlag);
    this.startStdoutDrain(this.claudeProcess);
    this.startStderrReader();
    this.installEarlyExitWatcher();
    this.sendInitializeHandshake();

    logSessionLifecycle("tugcode.spawn_claude_async", {
      session_id: this.sessionId,
      session_mode: this.sessionMode,
      claude_session_id: claudeId,
    });

    // Resolve (or freshly satisfy) the readiness gate. If
    // `prepareSession()` set it up, callers awaiting on it can now
    // proceed. Otherwise we install an already-resolved promise so
    // `handleUserMessage`'s `await` is a clean no-op for the
    // new-mode `initialize()` path.
    if (this.claudeReadyResolve !== null) {
      this.claudeReadyResolve();
      this.claudeReadyResolve = null;
    } else {
      this.claudeReadyPromise = Promise.resolve();
    }

    return this.claudeReadyPromise!;
  }

  /**
   * Send the `initialize` control-request to claude after spawn so the
   * frontend learns the session's capabilities (model list, command
   * catalog with plugin commands merged, version, …) without waiting for
   * the first user turn — claude in stream-json mode is otherwise silent
   * until input arrives.
   *
   * **Every spawn mode needs this handshake.** The capabilities frame is
   * the ONLY producer of the command catalog: tugcast retains it in an
   * in-memory `latest_capabilities` slot (not persisted), so after an app
   * restart a resumed session's catalog exists only if ITS spawn ran the
   * handshake. The on-bind ledger-metadata replay covers model / version /
   * mode — never capabilities. Historically resume spawns skipped the
   * handshake and got away with it because the pre-[D06]/[D11] sideband
   * broadcast leaked every session's capabilities to every card; the
   * per-session isolation filter (correctly) ended that, which surfaced
   * the gap as "resumed sessions lose their slash commands until the
   * first turn."
   *
   * **Resume spawns are health-gated, not skipped.** The original reason
   * for skipping resume was real: a `--resume` spawn with a stale id
   * emits "No conversation found" and exits fast (< ~1s — the supervisor
   * eager-spawn contract), and injecting a control-request into that
   * dying window perturbed failure classification. The gate preserves
   * that property by *waiting out the fast-exit window*: the handshake is
   * sent only after claude has survived {@link RESUME_INITIALIZE_DELAY_MS}
   * — a failing resume is dead before we ever write to it (byte-identical
   * to the pre-handshake behavior), and classification is stderr-pattern
   * driven regardless (`claudeStderrClassification`). A healthy resume
   * gets its catalog seconds after spawn, and tugcast captures it for
   * every later bind / reload of the card.
   *
   * Fire-and-forget: the response is correlated by `request_id` and
   * handled in {@link handleClaudeLine}. This does NOT block the first
   * user message — `spawnClaudeAndWatch`'s readiness gate is independent.
   * No-op if the process is gone (or replaced) by send time.
   */
  private sendInitializeHandshake(): void {
    if (!this.claudeProcess) return;
    if (this.sessionMode === "new") {
      this.dispatchInitializeHandshake(this.claudeProcess);
      return;
    }
    // Resume: defer past the stale-id fast-exit window so a failing
    // spawn is never written to and its exit stays byte-identical for
    // the early-exit watcher.
    const child = this.claudeProcess;
    setTimeout(() => {
      if (this.isShuttingDown) return;
      // The spawn we gated on must still be the live process — a
      // respawn or crash-restart in the window minted a new subprocess
      // (whose own sendInitializeHandshake re-arms the gate).
      if (this.claudeProcess !== child) return;
      if (child.exitCode !== null) return;
      this.dispatchInitializeHandshake(child);
    }, RESUME_INITIALIZE_DELAY_MS);
  }

  /**
   * Write the `initialize` control-request to a live claude subprocess
   * and arm the `request_id` correlation. Split from
   * {@link sendInitializeHandshake} so the immediate (new-mode) and
   * health-gated (resume-mode) paths share one send site. A write racing
   * a just-exited process is swallowed — the early-exit watcher owns
   * that outcome, and a dangling correlation id is cleared so a later
   * unrelated control_response can't match it.
   */
  private dispatchInitializeHandshake(child: ClaudeSubprocess): void {
    this.initializeRequestId = generateRequestId();
    logSessionLifecycle("tugcode.initialize_handshake", {
      session_id: this.sessionId,
      session_mode: this.sessionMode,
    });
    try {
      sendControlRequest(child.stdin, this.initializeRequestId, {
        subtype: "initialize",
      });
    } catch {
      this.initializeRequestId = null;
    }
  }

  /** Release everyone parked on {@link awaitSpawnReady}. */
  private drainInitializeAckWaiters(): void {
    if (this.initializeAckWaiters.length === 0) return;
    const waiters = this.initializeAckWaiters;
    this.initializeAckWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Resolve once the live spawn has proven it loaded — its `initialize`
   * handshake acked ({@link initializeHandshakeAcked}) — or once waiting is
   * pointless: the subprocess exited, or `timeoutMs` elapsed.
   *
   * Spawned is not ready. `--resume` against a real conversation takes seconds
   * to read the JSONL back in, and claude in stream-json mode is silent for
   * all of it, so the only observable proof that it is answering is a
   * control-response. `/rewind` awaits this before acking, so the sheet's
   * progress state covers the whole window ([#step-7-2]).
   *
   * Never rejects: every path here means stop waiting, and the caller decides
   * what an unproven spawn is worth.
   */
  private awaitSpawnReady(
    child: ClaudeSubprocess,
    timeoutMs: number,
  ): Promise<void> {
    if (this.initializeHandshakeAcked) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(settle, timeoutMs);
      this.initializeAckWaiters.push(settle);
      void child.exited.then(settle, settle);
    });
  }

  /**
   * Initialize session — single entry point for new mode and the
   * legacy (eager) resume path.
   *
   * Resume mode (cold-boot, Step R0d / R4): `main.ts` does NOT call
   * `initialize()`; it calls `prepareSession()` →
   * `void spawnClaudeAndWatch()` so the claude spawn runs in the
   * background while tugdeck dispatches the `request_replay` verb
   * (Step R1c) that — queued during Spawning, drained on
   * Spawning→Live (Step R4) — drives the actual replay. `initialize()`
   * remains for non-cold-boot callers (and tests that don't care to
   * exercise the cold-boot order); for resume mode it composes
   * `prepareSession()` + `await spawnClaudeAndWatch()`. It does NOT
   * invoke `runReplay()` itself; replay is request-driven only
   * post-R4.
   *
   * New mode: spawns claude eagerly via `spawnClaudeAndWatch()`,
   * then emits the synthetic `session_init`. Same wire shape as
   * pre-R0d.
   *
   * The empirical "claude doesn't emit system:init until input
   * arrives" fact, plus the early-exit watcher's stderr pattern-
   * matching, is documented on `spawnClaudeAndWatch`.
   */
  async initialize(): Promise<void> {
    const inputSessionId = this.sessionId;
    const inputMode = this.sessionMode;
    logSessionLifecycle("tugcode.init.start", {
      session_id: inputSessionId,
      session_mode: inputMode,
      resume_session_id: this.resumeSessionId ?? "",
    });

    if (this.sessionMode === "resume") {
      // Legacy / non-cold-boot order: synthesize the init, then spawn
      // claude eagerly. Bytes-identical to the pre-R0d wire shape;
      // tests that prime via `initialize()` continue to see the same
      // observable outcome.
      this.prepareSession();
      await this.spawnClaudeAndWatch();
      // Surface the resolved cwd from the drop on resume too — symmetric
      // with the new-session branch. The replay's synthesized
      // `system_metadata` carries an empty cwd, and a session resumed
      // before it ever took a turn has no persisted cwd to replay, so
      // without this its cwd-derived surfaces (e.g. `/memory`) would be
      // blank until the first turn. The merge keeps this value over the
      // replay's empty one.
      this.emitInitialSessionCwd();
    } else {
      // New mode: spawn first, then synthesize the init. Order
      // matches the pre-R0d code; the only refactor here is the
      // helper extraction.
      await this.spawnClaudeAndWatch();
      this.writeSyntheticSessionInit(this.resolveClaudeId());
      // Emit the `context_breakdown` immediately — claude stays silent
      // (no `system:init`) until the first input, so the static
      // estimate is computed from disk so the Context surface is
      // populated the moment the session opens.
      this.emitInitialContextBreakdown();
      this.emitInitialSessionCwd();
    }

    const claudeId = this.resolveClaudeId();
    logSessionLifecycle("tugcode.init.end", {
      session_mode: inputMode,
      session_id_in: inputSessionId,
      session_id_out: claudeId,
      fallback_taken: false,
    });
  }

  /**
   * Read claude's stderr line-by-line, forward each line verbatim to
   * `process.stderr` (preserving the existing tugcast::tugcode_stderr
   * capture), and pattern-match the first line carrying a known
   * failure signature into `claudeStderrClassification`. Returns
   * immediately if stderr is not available; runs as a detached task
   * for the lifetime of the claude subprocess.
   */
  private startStderrReader(): void {
    const stderr = this.claudeProcess?.stderr;
    if (!stderr) return;
    const stream = stderr as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            if (buffer.length > 0) process.stderr.write(buffer);
            return;
          }
          buffer += decoder.decode(result.value, { stream: true });
          let lineEnd = buffer.indexOf("\n");
          while (lineEnd >= 0) {
            const line = buffer.slice(0, lineEnd);
            buffer = buffer.slice(lineEnd + 1);
            // Forward verbatim so tugcast::tugcode_stderr keeps seeing
            // exactly what claude wrote — operator visibility unchanged.
            process.stderr.write(line + "\n");
            // First-match-wins classification. Subsequent lines from
            // the same stderr stream don't override; the failure cause
            // is whatever claude reported first.
            if (this.claudeStderrClassification === null) {
              if (line.includes("No conversation found with session ID")) {
                this.claudeStderrClassification = "resume_failed";
              } else if (line.includes("is already in use")) {
                this.claudeStderrClassification = "collision";
              }
            }
            lineEnd = buffer.indexOf("\n");
          }
        }
      } catch (err) {
        process.stderr.write(`[tugcode] stderr reader error: ${err}\n`);
      }
    })();
  }

  /**
   * Watch claude's exit indefinitely. The watcher only emits IPC if
   * claude exits AND none of these guards apply:
   *
   *   - the exited process is no longer `this.claudeProcess`: a
   *     deliberate teardown ({@link killAndCleanup} /
   *     {@link forceTerminateAndRespawn}) nulls or replaces the handle
   *     before this callback runs, so its exit was ours — never a failure.
   *   - `isShuttingDown`: we initiated the kill (signal, stdin EOF,
   *     close); a phantom resume_failed for a user-driven close would
   *     reach the bridge after the card is already gone.
   *   - `claudeReceivedInput`: claude has been seen alive end-to-end
   *     (it accepted at least one user message). A subsequent exit
   *     is a runtime crash, not an init failure — the existing
   *     handleUserMessage stream-end path classifies it.
   *
   * A `resume_failed` is only correct BEFORE claude proves it launched.
   * Once the turn-free `initialize` handshake is acked
   * ({@link initializeHandshakeAcked}), claude has fully loaded and — for a
   * resume — opened its JSONL, so any later exit is a runtime crash. Emitting
   * `resume_failed` there is the 2026-07-22 commit-xp regression: a healthy
   * resumed session that a force-kill or a genuine crash later tore down was
   * mislabeled a stale-id failure, which unbinds the card and marks the ledger
   * row failed instead of letting the bridge's crash budget retry the resume.
   * So a post-handshake exit with no *definitive* stderr signature is routed
   * to the bridge's crash path (recoverable), which respawns and re-resumes.
   *
   * When a genuine init failure IS emitted, the failure mode is taken from
   * `claudeStderrClassification` (definitive, harvested from stderr by
   * `startStderrReader`) and falls back to the session mode only when stderr
   * carried nothing recognizable.
   */
  private installEarlyExitWatcher(): void {
    if (!this.claudeProcess) return;
    const child = this.claudeProcess;
    const sessionId = this.sessionId;
    const sessionMode = this.sessionMode;

    void child.exited.then(async (code) => {
      // The live handle moved on (teardown / respawn) — this exit was ours.
      if (this.claudeProcess !== child) return;
      if (this.isShuttingDown) return;
      if (this.claudeReceivedInput) return;
      if (this.replayActive) {
        // `runReplay` watches `child.exited` itself: it surfaces the
        // crash via `replay_complete { claude_exited_during_replay }`
        // first, then emits the lifecycle `resume_failed`. Letting the
        // watcher run in parallel would race that ordering and leave
        // the card stuck in `replaying` phase.
        return;
      }

      // Definitive classification wins; mode is the fallback. A stale
      // `--resume` id ("No conversation found") and a `new`-mode `--session-id`
      // that collides with an existing transcript ("is already in use") are
      // both non-retrying resume failures: re-spawning with the same args just
      // hits the same wall. Route both to the bridge's `resume_failed` path
      // (which clears the binding and offers the picker) rather than letting
      // the bridge read the exit as a generic crash and burn its retry budget
      // on three identical collisions before locking the card as `errored`.
      const classification = this.claudeStderrClassification;
      const definitiveInitFailure =
        classification === "resume_failed" || classification === "collision";

      // Post-handshake exit with no definitive stderr → a runtime crash, not an
      // init/resume failure. Exit WITHOUT `resume_failed` so the bridge reads
      // stdout-close as `Crashed` and its crash budget respawns + re-resumes
      // the intact JSONL. Emitting the error frame keeps the card honest about
      // the blip; the retry re-populates it.
      if (this.initializeHandshakeAcked && !definitiveInitFailure) {
        const reason = `claude exited with code ${code} after handshake (runtime crash)`;
        logSessionLifecycle("tugcode.claude_crash_post_handshake", {
          session_id: sessionId,
          reason,
          exit_code: code,
        });
        await writeLineAndExit(
          {
            type: "error",
            message: reason,
            recoverable: true,
            ipc_version: 2,
          },
          0,
        );
        return;
      }

      const isResumeFailure =
        definitiveInitFailure ||
        (classification === null && sessionMode === "resume");

      if (isResumeFailure) {
        const reason =
          classification === "collision"
            ? `claude reported session id "${sessionId}" is already in use`
            : classification === "resume_failed"
              ? `claude reported "No conversation found" (stale --resume id)`
              : `claude exited with code ${code} during resume init (likely stale id)`;
        logSessionLifecycle("tugcode.resume_failed", {
          stale_session_id: sessionId,
          reason,
          exit_code: code,
          classification: classification ?? "mode_default",
        });
        await writeLineAndExit(
          {
            type: "resume_failed",
            reason,
            stale_session_id: sessionId,
            ipc_version: 2,
          },
          0,
        );
      } else {
        const reason = `claude exited with code ${code} during fresh init`;
        await writeLineAndExit(
          {
            type: "error",
            message: reason,
            recoverable: false,
            ipc_version: 2,
          },
          0,
        );
      }
    });
  }

  /**
   * Read the JSONL archive for the resumed session and stream its
   * translated events to IPC stdout, bracketed by `replay_started` /
   * `replay_complete`. Runs only in resume mode.
   *
   * **Trigger** (post-Step R4 / Phase A-R4): `request_replay` inbound
   * verb only. The verb is dispatched by tugdeck's
   * `cardServicesStore` whenever fresh services are constructed for
   * a resume binding (cold boot, HMR, Maker > Reload), forwarded
   * by tugcast's supervisor through tugcode's stdin via the existing
   * CODE_INPUT path, and dispatched to this method by tugcode's IPC
   * loop (`main.ts` `isRequestReplay` branch). The supervisor queues
   * the verb during the Spawning window and drains it on
   * Spawning→Live promotion, so cold-boot replay arrives at the same
   * wire timing as the pre-collapse startup-replay path.
   *
   * The legacy direct invocation from `main.ts` and `initialize()`
   * was removed in [Step R4](dash/tugplan-session-transcript-resume.md#step-r4)
   * to eliminate dual replay-trigger paths. The `replayActive`
   * re-entrancy guard remains as defense-in-depth: a future caller
   * that reintroduces overlap is dropped at the entry rather than
   * producing interleaved replay output on IPC stdout.
   *
   * Concurrency model. The replay iterator is awaited sequentially
   * with a race against:
   *   - a hard-budget timer (`replayTimeoutMs`, default 10s),
   *   - claude's exit (`claudeProcess.exited`).
   *
   * On natural completion the iterator emits its own
   * `replay_complete` (success, or `jsonl_malformed` when individual
   * lines failed to parse). We just write each yielded
   * `OutboundMessage` in turn.
   *
   * On timeout we abandon the iterator, emit our own
   * `replay_complete { replay_timeout }`, and return. The JSONL was
   * readable but didn't finish in time; claude is still alive on the
   * other side and live forwarding takes over via the stdout drain
   * (Step R1e) once handleUserMessage runs.
   *
   * On a claude crash *during* replay we emit
   * `replay_complete { jsonl_unreadable: claude_exited_during_replay }`
   * so the card transitions out of `replaying` cleanly, then surface
   * the subprocess loss through the existing `resume_failed` path and
   * exit.
   *
   * Live-buffer note. While replay runs, claude's stdout sits in the
   * OS pipe (~64 KB on Linux/macOS). claude on `--resume` with no
   * user input is essentially silent — a `system:init` plus
   * occasional keep-alives — so the pipe is well within bounds. The
   * hard timeout is the ultimate guard against a pathologically
   * chatty claude. {@link REPLAY_LIVE_BUFFER_MAX} stays available as
   * a documented threshold; it is not load-bearing post-R1e.
   */

  /**
   * Abort the in-flight replay, if any (the `cancel_replay` verb). Wakes
   * the `runReplay` loop's abort race so it stops pulling the translator
   * at the next time-slice yield and closes the bracket with
   * `replay_complete{aborted:true}`. A no-op when no replay is running
   * (`replayAbortResolve` is null), so a stray cancel is harmless.
   */
  cancelReplay(): void {
    this.replayAbortResolve?.();
  }

  /**
   * Translate every session in an arc's lineage *ahead of* the one being
   * resumed, and return their frames in reading order ([P10]).
   *
   * An arc's stages each own their own JSONL, so a card that replays only its
   * own shows a transcript beginning in the middle. The chain arrives on the
   * `request_replay` payload, oldest ancestor first, and each entry that ran a
   * stage is preceded by a `replay_stage` divider — including the last entry,
   * the session being resumed, whose own turns come from the main pass right
   * after these frames.
   *
   * Two frame kinds are dropped from an ancestor's output. The bracket pair
   * (`replay_started` / `replay_complete`) belongs to the whole replay, which
   * is one bracket, not one per session. The metadata frames
   * (`system_metadata` / `session_capabilities`) describe the *live* session's
   * model and capabilities, and an ancestor's would overwrite them with a
   * stage that ended.
   *
   * Best-effort throughout: a missing or unreadable ancestor JSONL
   * contributes its divider and no turns, because a restore that shows less
   * history is better than one that fails.
   */
  private async collectLineagePrefix(
    lineage: ReplayLineageEntry[],
    canonicalProjectDir: string,
  ): Promise<OutboundMessage[]> {
    const frames: OutboundMessage[] = [];
    for (let i = 0; i < lineage.length; i++) {
      const entry = lineage[i]!;
      if (entry.stage !== undefined && entry.stage !== "") {
        frames.push({
          type: "replay_stage",
          stage: entry.stage,
          model: entry.model ?? "",
          document: entry.document ?? "",
          arc: entry.arc ?? "",
          ipc_version: 2,
        });
      }
      // The last entry is the session being resumed; the main pass emits its
      // turns. Only its divider belongs here.
      if (i === lineage.length - 1) continue;

      const path = jsonlPathFor(
        this.claudeProjectsRoot,
        canonicalProjectDir,
        entry.sessionId,
      );
      const read = await this.jsonlReader(path);
      if (read.kind !== "ok") {
        logReplay("lineage_entry_unreadable", {
          session_id: this.sessionId,
          claude_session_id: entry.sessionId,
          kind: read.kind,
        });
        continue;
      }
      const iter = translateJsonlSession(
        { ...read, claudeSessionId: entry.sessionId },
        {
          telemetry: this.replayTelemetry,
          timeSliceMs: this.replayTimeSliceMs,
          // An ancestor is finished by definition: any cycle left open at its
          // end-of-JSONL has no live turn to continue it.
          synthesizeDanglingTerminal: true,
        },
      );
      for await (const msg of iter) {
        if (
          msg.type === "replay_started" ||
          msg.type === "replay_complete" ||
          msg.type === "system_metadata" ||
          msg.type === "session_capabilities"
        ) {
          continue;
        }
        frames.push(msg);
      }
    }
    return frames;
  }

  async runReplay(
    window?: ReplayWindow,
    lineage?: ReplayLineageEntry[],
  ): Promise<void> {
    // Pre-Step-5 the early-return `if (this.sessionMode !== "resume") return;`
    // gated runReplay by the original spawn mode. That assumption (mode=new
    // ⇒ no JSONL to replay) holds at the moment of spawn but rots once the
    // session has had wire activity. After the first turn lands, any
    // request_replay against the same session — sent from tugdeck on
    // `Maker > Reload` / HMR / card remount — needs the JSONL pass to
    // rehydrate the freshly-mounted CodeSessionStore. The mid-turn-replay
    // [Step 5](dash/tugplan-session-mid-turn-replay.md#step-5) close-out
    // smoke surfaced this: open new card, type "hello", get response,
    // Maker > Reload → empty window because both tugdeck's
    // `binding.sessionMode === "resume"` gate (also dropped) and this
    // early-return swallowed the rebind's request_replay. Dropping both
    // gates makes runReplay always-on; for a truly fresh new session whose
    // JSONL doesn't exist yet, the translator emits
    // `replay_started → replay_complete{kind: "jsonl_missing"}` and the
    // reducer flashes through `replaying` to `idle`. Harmless.

    // Re-entrancy guard for the request_replay verb (Phase A-R1 /
    // [D12]). Cold-boot replay and request-driven replay share this
    // method. If a request lands while a replay is already in flight,
    // drop it: the in-flight bracket's events satisfy the request, and
    // overlapping output would interleave on IPC stdout, producing
    // out-of-order frames that violate L23 (user-visible state
    // preservation) at tugdeck.
    if (this.replayActive) {
      logReplay("request_dropped", {
        session_id: this.sessionId,
        reason: "replay_in_flight",
      });
      return;
    }
    // Step R0d cold-boot order calls runReplay before claude has been
    // spawned — `claudeProcess` is null and the JSONL is read straight
    // from disk. The Phase A-R1 request_replay path runs against an
    // already-live claude. Whether `claudeProcess` exists determines
    // only whether we race the JSONL iterator against `child.exited`;
    // both flows still use the hard-budget timer.
    const claudeSessionId = this.resumeSessionId ?? this.sessionId;

    // Mark replay active *before* the first await so a claude crash
    // during the JSONL read can't slip past the early-exit watcher
    // and emit a stray `resume_failed` while we're still mid-replay.
    // The crash branch below picks up `child.exited` via the loop's
    // race promise and surfaces it through the canonical
    // `replay_complete { claude_exited_during_replay }` then
    // `resume_failed` order.
    this.replayActive = true;

    // Resolve symlinks on `projectDir` so the encoded form matches
    // the encoding claude itself uses when writing the per-session
    // JSONL. Claude canonicalizes its cwd internally (getcwd()
    // returns the resolved path), so its on-disk directory is named
    // after the canonical absolute path. Without this resolve step,
    // a project the user reaches via symlink (e.g.
    // `/u/src/tugtool` → `/Users/<u>/Mounts/u/src/tugtool`)
    // produces an `encodeProjectDir(...)` form that has no directory
    // under `~/.claude/projects/`, and `runReplay` fires
    // `replay_complete{jsonl_missing}` for what's actually a
    // populated session — the cold-boot Smoke C failure mode
    // surfaced in [Step R0b]. The fallback to the raw path is safe:
    // if the directory doesn't exist (test fixtures, edge cases),
    // `jsonlReader` reports `kind: "missing"` downstream, which is
    // the same behavior the raw form already produces.
    let canonicalProjectDir = this.projectDir;
    try {
      canonicalProjectDir = await realpath(this.projectDir);
    } catch {
      // Path doesn't resolve (test fixture, deleted dir, etc.).
      // Keep the raw form; downstream reader reports missing.
    }
    if (canonicalProjectDir !== this.projectDir) {
      logReplay("path_canonicalized", {
        session_id: this.sessionId,
        raw: this.projectDir,
        canonical: canonicalProjectDir,
      });
    }
    const jsonlPath = jsonlPathFor(
      this.claudeProjectsRoot,
      canonicalProjectDir,
      claudeSessionId,
    );

    logReplay("started", {
      session_id: this.sessionId,
      claude_session_id: claudeSessionId,
      jsonl_path: jsonlPath,
    });
    logSessionLifecycle("perf.replay_requested", {
      tug_session_id: this.sessionId,
    });

    const startedAt = Date.now();
    const rawInput = await this.jsonlReader(jsonlPath);
    logSessionLifecycle("perf.replay_read", {
      tug_session_id: this.sessionId,
      ms: Date.now() - startedAt,
      bytes: rawInput.kind === "ok" ? rawInput.jsonl.length : 0,
      lines: rawInput.kind === "ok" ? countNewlines(rawInput.jsonl) : 0,
    });
    // Thread the claude session id into the replay input so the
    // synthesized `system_metadata` IPC at the top of replay carries
    // the right session_id field. Only the `ok` variant carries
    // payload; missing/unreadable variants pass through unchanged.
    let input: ReplayInput = rawInput.kind === "ok"
      ? { ...rawInput, claudeSessionId }
      : rawInput;

    // Restore any background-agent transcripts Claude Code persisted
    // out-of-band beside the main JSONL (`subagents/agent-*.jsonl`). On
    // resume the main JSONL records only the async-launch echo for a
    // backgrounded `Agent`, so without this its child tool calls + final
    // answer are lost. Best-effort: a missing/unreadable subagents dir yields
    // none and replay proceeds exactly as before.
    if (input.kind === "ok") {
      const subagentsDir = subagentsDirFor(
        this.claudeProjectsRoot,
        canonicalProjectDir,
        claudeSessionId,
      );
      const subagents = await readSubagentTranscripts(subagentsDir);
      if (subagents.length > 0) {
        input = { ...input, subagents };
        logReplay("subagents_restored", {
          session_id: this.sessionId,
          count: subagents.length,
          entries: subagents.reduce((n, t) => n + t.entries.length, 0),
        });
      }
    }

    // The arc's earlier stages, translated up front so the loop below stays
    // the single-session loop it has always been: with no lineage this is an
    // empty array and every byte on the wire is what it was before lineage
    // existed ([P10]).
    const lineagePrefix: OutboundMessage[] =
      lineage !== undefined && lineage.length > 1
        ? await this.collectLineagePrefix(lineage, canonicalProjectDir)
        : [];
    if (lineagePrefix.length > 0) {
      logReplay("lineage_prefix", {
        session_id: this.sessionId,
        sessions: lineage!.length,
        frames: lineagePrefix.length,
      });
    }

    // Exit race only applies when claude is alive. In Step R0d's
    // cold-boot order, claude hasn't been spawned yet — there's
    // nothing to crash. In the future request_replay path (Phase
    // A-R1), claude IS alive and a crash mid-replay must surface as
    // `replay_complete{claude_exited_during_replay}` followed by
    // `resume_failed`. Skipping this branch when there's no process
    // keeps `Promise.race` total without inventing a never-resolving
    // exit promise.
    const child = this.claudeProcess;
    const exitPromise: Promise<{ kind: "exit"; code: number | null }> | null =
      child !== null
        ? child.exited.then((code) => ({
            kind: "exit" as const,
            code: typeof code === "number" ? code : null,
          }))
        : null;

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve({ kind: "timeout" }),
        this.replayTimeoutMs,
      );
    });

    // Abort race: a `cancel_replay` verb resolves this promise, making
    // the loop below break at its next iteration (≤ one translator
    // time-slice later). The user cancelled a load-previous / load-all;
    // we stop pulling the translator and close the bracket cleanly with
    // `replay_complete{aborted:true}` so the client discards the partial
    // older batch. The resolver is published on the instance for the
    // verb handler and cleared in `finally`.
    const abortPromise = new Promise<{ kind: "abort" }>((resolve) => {
      this.replayAbortResolve = () => resolve({ kind: "abort" });
    });

    // Snapshot the active turn at entry. Only adopt it as in-flight
    // when the drain hasn't yet observed its terminal event — a
    // turn that already latched gotResult/interrupted is "done" from
    // tugcode's perspective and the translator's path handles it
    // (or the orphan synthesis does, when ids don't match).
    //
    // Setting suppressEmit BEFORE the first translator yield is
    // load-bearing: live deltas dispatched by the drain in parallel
    // would otherwise interleave with replay events on the wire.
    // The window stays open through the buffered replay_complete
    // emission below; the finally clears it.
    const inflight = (
      this.activeTurn !== null &&
      !this.activeTurn.gotResult &&
      !this.activeTurn.interrupted
    ) ? this.activeTurn : null;
    if (inflight !== null) {
      inflight.suppressEmit = true;
    }

    // JSONL-driven replay (the only path post-Step-5.4). The
    // translator emits `replay_started` → committed-turn frames →
    // `replay_complete`, raced against the exit + timeout promises.
    // The trailing in-flight turn's predicate is the
    // [Step 5.5](dash/tugplan-session-mid-turn-replay.md#step-5-5)
    // territory; this substep restores the pre-Step-4 translator-driven
    // shape unchanged. The journal-driven pending-row injection lands
    // in [Step 5.6](dash/tugplan-session-mid-turn-replay.md#step-5-6),
    // wrapping this path with a pre-pass over `sessions.db`.
    let count = 0;
    // `messagesEmitted` counts wire lines (one per `writeLine`);
    // `framesEmitted` counts the inner frames those lines carry. With
    // batching the two diverge — a `replay_batch` is one wire line
    // carrying many frames.
    let messagesEmitted = 0;
    let framesEmitted = 0;
    let lastProgressPosted = 0;
    const progressBatch = 16;
    // Cold replay ships committed-turn frames in coarse batches: the
    // per-frame syscall / relay / WebSocket cost is what dominates load
    // time, not the frames themselves. Buffer content frames and flush
    // them as one `replay_batch` wire line; bracket frames
    // (`replay_started` / `replay_complete`) and lone flushes stay raw
    // so the browser's paint gate and fold flush keep their timing.
    const REPLAY_BATCH_SIZE = 256;
    const batch: OutboundMessage[] = [];
    const yieldToLoop = (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, 0));
    // Emit a single frame as its own raw wire line: one wire line, one
    // inner frame.
    const writeRaw = (m: OutboundMessage): void => {
      writeLine(m);
      messagesEmitted += 1;
      framesEmitted += 1;
    };
    // Flush the buffer: empty → no-op; one frame → raw; ≥2 → one
    // `replay_batch` envelope (one wire line carrying N inner frames).
    const flushBatch = (): void => {
      if (batch.length === 0) return;
      if (batch.length === 1) {
        writeRaw(batch[0]!);
      } else {
        writeLine({ type: "replay_batch", frames: [...batch], ipc_version: 2 });
        messagesEmitted += 1;
        framesEmitted += batch.length;
      }
      batch.length = 0;
    };
    let aborted:
      | { kind: "timeout" }
      | { kind: "exit"; code: number | null }
      | { kind: "abort" }
      | null = null;
    // Bracket accounting: once `replay_started` is on the wire, exactly one
    // `replay_complete` MUST follow — tugcast's relay latches an `in_replay`
    // flag between the two, and a bracket left open disables its Bash and
    // turn attribution for the rest of the relay's life. Every exit from
    // this function below funnels through this pair of flags.
    let bracketOpened = false;
    let bracketClosed = false;
    let replayException: unknown = null;
    // The translator yields `replay_complete` BEFORE returning. Buffer
    // the bracket-close so we can write it last after the loop, in case
    // a future caller (Step 5.6's pending-row injection) wants to add
    // post-iteration work between the last committed-turn frame and the
    // bracket-closing event.
    let bufferedReplayComplete: OutboundMessage | null = null;
    // Step 5.6: pending-row synthetics inject between replay_started
    // and the next translator emit, ONCE per replay. Tracked via this
    // flag so the loop body fires the injection on the first
    // `replay_started` it forwards and skips it on every subsequent
    // event.
    let pendingRowSyntheticsInjected = false;

    const translateStartedAt = Date.now();
    const iter = translateJsonlSession(input, {
      telemetry: this.replayTelemetry,
      timeSliceMs: this.replayTimeSliceMs,
      // A cycle left open at end-of-JSONL has no live `ActiveTurn` to
      // continue it on a cold resume (`inflight === null`) — ask the
      // translator to synthesize its terminal `turn_complete` so the
      // dangling turn commits instead of stranding an in-flight row
      // ([replay-1]). When `inflight !== null` this IS a live turn
      // still streaming (reload-mid-stream); leave it for the live
      // drain + `emitInflightTurnFromActiveTurn` as before.
      synthesizeDanglingTerminal: inflight === null,
      // Recency window threaded from the request (absent ⇒ whole
      // session). The translator emits only the requested turn range
      // and reports the window on `replay_complete`, which the buffered
      // bracket-close below forwards verbatim.
      window,
    });

    try {
      while (true) {
        const nextPromise = iter
          .next()
          .then((r) => ({ kind: "next" as const, value: r }));
        const racers: Array<
          Promise<
            | { kind: "next"; value: IteratorResult<OutboundMessage, { count: number }> }
            | { kind: "timeout" }
            | { kind: "exit"; code: number | null }
            | { kind: "abort" }
          >
        > = [nextPromise, timeoutPromise, abortPromise];
        if (exitPromise !== null) racers.push(exitPromise);
        const winner = await Promise.race(racers);

        if (winner.kind === "next") {
          if (winner.value.done) {
            // Generator returned. The cold-boot path doesn't read
            // the return value — count tracking happens via the
            // streamed `replay_complete` message.
            break;
          }
          const msg = winner.value.value;
          if (msg.type === "turn_complete") {
            count++;
            if (count - lastProgressPosted >= progressBatch) {
              logReplay("progress", {
                session_id: this.sessionId,
                count,
              });
              lastProgressPosted = count;
            }
          }
          if (msg.type === "replay_complete") {
            // Buffer it; the bracket-close emits last after the
            // remaining content batch is flushed.
            if (typeof msg.count === "number") count = msg.count;
            bufferedReplayComplete = msg;
            continue;
          }
          if (msg.type === "replay_started") {
            // Bracket frame: emit raw so the browser's paint gate
            // mounts immediately. Then inject any pending-row synthetic
            // `add_user_message` frames into the buffer ahead of the
            // JSONL content — they land in `phase: replaying` (the
            // reducer's handleAddUserMessage phase guard) so the user's
            // pending submissions render before the JSONL pass emits
            // anything else. See `injectPendingRowSynthetics`.
            writeRaw(msg);
            bracketOpened = true;
            // The arc's earlier stages, in order, ahead of this session's own
            // turns — inside the one bracket, because one restore is one
            // replay however many JSONLs it read ([P10]). Empty for every
            // card that is not an arc.
            for (const frame of lineagePrefix) batch.push(frame);
            if (!pendingRowSyntheticsInjected) {
              pendingRowSyntheticsInjected = true;
              this.injectPendingRowSynthetics(input, (m) => batch.push(m));
            }
            continue;
          }
          // Sideband metadata frames bypass the batch. The replay synth
          // yields `system_metadata` (the active model) — and a future pass
          // may yield `session_capabilities` — interleaved with turn content.
          // These ride the SESSION_SIDEBAND feed, where the client's
          // `SessionMetadataStore` consumes STANDALONE frames and does not
          // unwrap a `replay_batch`. Swept into a batch, the synth's model
          // frame never reaches that store, so MODEL and the CONTEXT
          // denominator stay unresolved (the active model is lost). Flush any
          // buffered content first so wire order is preserved, then emit the
          // metadata frame raw so tugcast's fan-out rewraps it onto
          // SESSION_SIDEBAND as its own line.
          if (msg.type === "system_metadata" || msg.type === "session_capabilities") {
            flushBatch();
            writeRaw(msg);
            continue;
          }
          // Committed-turn content: buffer and flush in batches. The
          // per-batch yield lets the write tail drain and keeps the
          // abort/timeout race responsive.
          batch.push(msg);
          if (batch.length >= REPLAY_BATCH_SIZE) {
            flushBatch();
            await yieldToLoop();
          }
        } else {
          aborted = winner;
          break;
        }
      }

      // Flush any committed-turn content still in the buffer before the
      // in-flight snapshot and the bracket-close, so wire order stays
      // content → snapshot → replay_complete.
      flushBatch();

      // After the JSONL pass and before the bracket-close: emit the
      // in-flight turn's snapshot from `ActiveTurn` state. This is the
      // only path that delivers claude's pre-HMR streaming content
      // (`turn.partialText` + tool state) to a freshly-connected
      // client. The CODE_OUTPUT broadcast doesn't backfill new
      // subscribers (LagPolicy::Replay only triggers on lag overflow,
      // not on initial subscription); the JSONL only contains
      // committed turns; the Step 5.6 synthetic delivers the
      // user-side echo only. Without this snapshot, the new client
      // sees a `pendingUserMessage` with no scratch — post-bracket
      // deltas land into a fresh empty scratch and the user sees
      // only the tail of the response, missing the head.
      //
      // The snapshot keys on `turn.currentMessageId` (claude's most
      // recent `message.id` for the turn). It writes one consolidated
      // `assistant_text { is_partial: false }` that the reducer
      // REPLACES into its scratch; subsequent live deltas (post-
      // suppression) carry `is_partial: true` and append from that
      // baseline. If the turn's terminal already latched while
      // suppressed (`gotResult` / `interrupted`), the snapshot also
      // synthesizes the corresponding `turn_complete` /
      // `turn_cancelled` so the bracket delivers a complete
      // TurnEntry.
      if (inflight !== null) {
        try {
          this.emitInflightTurnFromActiveTurn(inflight);
        } catch (err) {
          // The snapshot is a rendering nicety; the bracket-close below is
          // load-bearing (see `bracketOpened`). Never let a bad in-flight
          // turn state take `replay_complete` down with it.
          logReplay("error", {
            session_id: this.sessionId,
            kind: "inflight_snapshot_exception",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // After clean iterator completion (no abort): emit the buffered
      // replay_complete raw to close the bracket.
      if (aborted === null && bufferedReplayComplete !== null) {
        writeRaw(bufferedReplayComplete);
        bracketClosed = true;
      }
    } catch (err) {
      // A throw anywhere in the replay loop (translator, synthetics
      // injection, write plumbing) must not escape with the bracket open:
      // the caller is fire-and-forget, so an escaped rejection is only a
      // log line — while tugcast would keep `in_replay` latched forever.
      // Record it; the fallback close-out below emits the error bracket.
      replayException = err;
      logReplay("error", {
        session_id: this.sessionId,
        kind: "replay_exception",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      this.replayActive = false;
      // Drop the abort resolver — this replay is no longer cancellable.
      // A `cancel_replay` arriving after this point finds it null (no-op).
      this.replayAbortResolve = null;
      // Clear suppressEmit AFTER replay_complete is on the wire so
      // post-suppression live deltas land outside the bracket and
      // observe the reducer's idle/streaming phase, not replaying.
      if (inflight !== null) {
        inflight.suppressEmit = false;
      }
      // Rewind every live background-agent tailer to offset 0 so its
      // next poll re-streams the agent's full child set to the
      // freshly-rebuilt deck. Done after the bracket closes so the
      // re-streamed frames land post-replay, where the re-hydrated job
      // can own them; the deck's id-keyed dedup absorbs the overlap
      // with the replay's turn-attached children.
      for (const tailer of this.subagentTailers.values()) {
        tailer.resetForReplay();
      }
      try {
        await iter.return?.({ count: 0 });
      } catch {
        // generator already finished or threw — nothing to clean up.
      }
    }

    const elapsedMs = Date.now() - startedAt;
    // `ms` is generator-iteration wall time (translate + pacing yields,
    // but writes are fire-and-forget on the `writeTail`). Drain the
    // tail and measure separately so the perf line splits "time to
    // produce frames" from "time to flush bytes into the pipe" — the
    // emit-side counterpart to the browser's `perf.replay_ingest`.
    const iterMs = Date.now() - translateStartedAt;
    const drainStart = Date.now();
    await drainPendingWrites();
    const drainMs = Date.now() - drainStart;
    logSessionLifecycle("perf.replay_translate", {
      tug_session_id: this.sessionId,
      ms: iterMs,
      drain_ms: drainMs,
      // `messages`/`batches` are wire lines emitted (the count that
      // collapses under batching); `frames` is the inner-frame total
      // those lines carry (≈ the browser's dispatched-frame count).
      messages: messagesEmitted,
      batches: messagesEmitted,
      frames: framesEmitted,
      turns: count,
    });

    if (aborted?.kind === "abort") {
      // User cancelled the load. Close the bracket cleanly with the
      // abort marker so the client discards the partial older batch and
      // keeps its prior window. Not an error — no `error` payload.
      const complete: ReplayComplete = {
        type: "replay_complete",
        count,
        aborted: true,
        ipc_version: 2,
      };
      writeLine(complete);
      logReplay("aborted", {
        session_id: this.sessionId,
        count,
        elapsed_ms: elapsedMs,
      });
      return;
    }

    if (aborted?.kind === "timeout") {
      const complete: ReplayComplete = {
        type: "replay_complete",
        count,
        error: {
          kind: "replay_timeout",
          message: `replay exceeded ${this.replayTimeoutMs}ms budget`,
        },
        ipc_version: 2,
      };
      writeLine(complete);
      logReplay("error", {
        session_id: this.sessionId,
        kind: "replay_timeout",
        count,
        elapsed_ms: elapsedMs,
      });
      return;
    }

    if (aborted?.kind === "exit") {
      const complete: ReplayComplete = {
        type: "replay_complete",
        count,
        error: {
          kind: "jsonl_unreadable",
          message: "claude_exited_during_replay",
        },
        ipc_version: 2,
      };
      writeLine(complete);
      logReplay("error", {
        session_id: this.sessionId,
        kind: "claude_exited_during_replay",
        count,
        exit_code: aborted.code,
      });
      // Surface the subprocess loss through the existing lifecycle
      // path so the card unbinds with the canonical resume-failure
      // shape. `claudeStderrClassification` may already be set if
      // claude wrote a recognizable diagnostic before exiting.
      const classification = this.claudeStderrClassification;
      const reason =
        classification === "resume_failed"
          ? `claude reported "No conversation found" (stale --resume id)`
          : `claude exited with code ${aborted.code} during replay`;
      logSessionLifecycle("tugcode.resume_failed", {
        stale_session_id: this.sessionId,
        reason,
        exit_code: aborted.code,
        classification: classification ?? "replay_crash",
      });
      await writeLineAndExit(
        {
          type: "resume_failed",
          reason,
          stale_session_id: this.sessionId,
          ipc_version: 2,
        },
        0,
      );
      return;
    }

    // Bracket-close backstop: every early `return` above wrote its own
    // `replay_complete`; the only way to reach here with the bracket still
    // open is the exception path (`replayException`) — or a future edit
    // that forgets the contract. Either way, close it: an open bracket is
    // a standing attribution outage on the tugcast side.
    if (bracketOpened && !bracketClosed) {
      const complete: ReplayComplete = {
        type: "replay_complete",
        count,
        error: {
          kind: "replay_exception",
          message:
            replayException instanceof Error
              ? replayException.message
              : String(replayException ?? "replay ended without bracket close"),
        },
        ipc_version: 2,
      };
      writeLine(complete);
    }

    logReplay("complete", {
      session_id: this.sessionId,
      count,
      elapsed_ms: elapsedMs,
    });
  }

  /**
   * Pull the submission journal's pending rows for this session via
   * the cross-process bun:sqlite handle. Read-only; the supervisor's
   * `dispatch_one` intercept owns inserts and the merger's
   * `apply_outbound_turn_intercept` owns FIFO deletes — tugcode never
   * writes here. Returns `[]` when the DB handle is unavailable
   * (file missing at construction, opted-out by tests) or the read
   * fails (corruption, schema mismatch); the caller treats either as
   * "no pending rows to surface" so a sqlite hiccup doesn't block
   * the user-visible JSONL replay.
   *
   * Mid-turn-replay [Step 5.6](dash/tugplan-session-mid-turn-replay.md#step-5-6).
   */
  private readPendingTurnsForSession(): JournalRow[] {
    if (this.sessionsDb === null) return [];
    try {
      const stmt = this.sessionsDb.query<JournalRow, [string]>(
        `SELECT journal_id, session_id, user_text, user_attachments, created_at
         FROM turns
         WHERE session_id = ?
         ORDER BY created_at ASC, journal_id ASC`,
      );
      return stmt.all(this.sessionId);
    } catch (err) {
      logReplay("sessions_db_read_error", {
        session_id: this.sessionId,
        reason: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Decode the BLOB-encoded `user_attachments` JSON array into the
   * `Attachment[]` shape the wire `add_user_message` carries. A
   * malformed BLOB (shouldn't happen under tugcast's writer; pinned
   * defensively) yields an empty array so the synthetic emit's user
   * side still surfaces.
   */
  private decodeUserAttachmentsBlob(blob: Buffer | Uint8Array): Attachment[] {
    try {
      const text = Buffer.from(blob).toString("utf8");
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed as Attachment[];
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Pre-translator pass for the never-drop guarantee
   * (mid-turn-replay [Step 5.6](dash/tugplan-session-mid-turn-replay.md#step-5-6)
   * — the load-bearing implementation of [DM08]).
   *
   * For each pending journal row whose `user_text` does not appear as
   * a `user_message` line in the JSONL, emit a synthetic
   * `add_user_message` frame. The synthetic carries the journal id
   * as `msg_id` (a TEMPORARY KEY for the reducer's
   * `pendingUserMessage` slot) and the row's user_text + attachments.
   *
   * **Why no terminal event for the synthetic.** The pending row by
   * definition has no claude response yet — there is no scratch
   * content and no claude message id. Emitting a `turn_complete`
   * here would commit an empty assistant TurnEntry. Withholding the
   * terminal leaves `pendingUserMessage` populated; when the live
   * drain produces the response post-replay (claude --resume
   * continues), the first response frame's claude `message.id`
   * becomes `activeMsgId` and the eventual live `turn_complete`
   * commits a proper TurnEntry whose `userMessage` text comes from
   * `pendingUserMessage` — the journal id is a temporary key for the
   * reducer's state during the gap.
   *
   * **Why the synthetic emits BEFORE the JSONL pass.** Per
   * [DM08]'s implications and the plan's "synthetic injection happens
   * inside the `replay_started` / `replay_complete` bracket (between
   * `replay_started` emit and the first translator emit)" — the
   * synthetic emits at the start of the bracket so it arrives in
   * `phase: replaying` (the reducer's
   * [`handleAddUserMessage`] phase guard) and, when the JSONL is
   * empty (cold-boot of a fresh session whose only state is the
   * pending journal row), the synthetic's `pendingUserMessage`
   * survives until the live drain consumes it.
   *
   * **Acknowledged residual gap (a):** when JSONL has committed
   * turns OR an in-flight trailing turn AND the journal also has
   * unmatched pending rows, the JSONL pass's
   * `add_user_message` frames overwrite the synthetic's
   * `pendingUserMessage`. Confirmed-acceptable 2026-05-05; the
   * messages remain durably stored, render fully when claude
   * responds (in the common single-pending case), and the merger's
   * FIFO deletion keeps the journal coherent.
   */
  private injectPendingRowSynthetics(
    input: ReplayInput,
    emit: (m: OutboundMessage) => void,
  ): void {
    const pendingRows = this.readPendingTurnsForSession();
    if (pendingRows.length === 0) return;

    const jsonl = input.kind === "ok" ? input.jsonl : "";
    const userMessageCounts = extractUserMessageTextCounts(jsonl);

    for (const row of pendingRows) {
      const remaining = userMessageCounts.get(row.user_text) ?? 0;
      if (remaining > 0) {
        // The submission appears in JSONL — claude has acknowledged
        // it; the JSONL pass will emit the corresponding
        // `add_user_message`. Decrement so a duplicate-text
        // submission later in the journal correctly accounts for
        // multiple JSONL matches.
        userMessageCounts.set(row.user_text, remaining - 1);
        continue;
      }
      const attachments = this.decodeUserAttachmentsBlob(row.user_attachments);
      // Synthesize Anthropic-API content blocks from the journal's
      // legacy `text` + `attachments` columns. Flat shape (text
      // first, then attachments); interleaving is unrecoverable
      // from these columns. The never-drop synthetic path is the
      // gap-bridge, not the primary restore path — the JSONL replay
      // pass preserves interleaving via `replay.ts`'s pass-through.
      const content = buildContentBlocksFromLegacyJournal(row.user_text, attachments);
      emit({
        type: "add_user_message",
        content,
        ipc_version: 2,
      });
      logReplay("pending_row_synthetic_emit", {
        session_id: this.sessionId,
        journal_id: row.journal_id,
      });
    }
  }

  /**
   * Start a long-lived stdout drain task on the given claude process
   * (Step R1e). The drain reads claude's stdout line-by-line until
   * EOF, parses each line as JSON, and dispatches it via
   * {@link handleClaudeLine}. On EOF, signals the active turn (if
   * any) before exiting.
   *
   * Single-owner invariant: nothing else in this class may call
   * `getReader()` on `claudeProcess.stdout`. The drain is the only
   * reader for claude's stdout for the lifetime of `claudeProcess`.
   */
  private startStdoutDrain(claudeProcess: ClaudeSubprocess): void {
    // Reset the EOF flag — a fresh claude means a fresh stdout
    // stream that hasn't EOF'd yet. Without this reset, a respawn
    // (fork / continue / new) after a prior EOF would leave
    // handleUserMessage on the fast-path "claude is dead" branch
    // forever.
    this.claudeStdoutEofObserved = false;
    const reader = (
      claudeProcess.stdout as ReadableStream<Uint8Array>
    ).getReader();
    this.stdoutDrainTask = this.runStdoutDrain(reader);
  }

  /**
   * Drain loop. Reads claude's stdout one chunk at a time, splits on
   * newlines, dispatches each non-empty line to
   * {@link handleClaudeLine}. Exits cleanly on EOF (claude closed
   * its stdout, e.g., on exit) or on read error.
   *
   * The drain decodes incrementally (TextDecoder with `{stream: true}`)
   * so multi-byte UTF-8 sequences split across chunks are handled
   * correctly. Lines longer than a single chunk are accumulated in
   * `buffer` until a newline is seen.
   */
  private async runStdoutDrain(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          result = await reader.read();
        } catch {
          break;
        }
        if (result.done) {
          const remaining = buffer.trim();
          if (remaining.length > 0) this.handleClaudeLineGuarded(remaining);
          buffer = "";
          break;
        }
        buffer += decoder.decode(result.value, { stream: true });
        let lineEnd = buffer.indexOf("\n");
        while (lineEnd >= 0) {
          const line = buffer.slice(0, lineEnd).trim();
          buffer = buffer.slice(lineEnd + 1);
          if (line.length > 0) this.handleClaudeLineGuarded(line);
          lineEnd = buffer.indexOf("\n");
        }
      }
    } finally {
      // EOF: surface to the active turn (if any) so a turn that was
      // mid-stream when claude died doesn't hang `handleUserMessage`'s
      // await on the turn's completion promise.
      this.signalEofToActiveTurn();
    }
  }

  /**
   * Dispatch a parsed claude stdout line. If a turn is currently
   * active (`handleUserMessage` registered an `ActiveTurn`), route
   * the event into it via {@link dispatchEventToTurn}. Otherwise the
   * event is between turns — forward init-shaped events through
   * {@link handleInterTurnEvent} so `session_init` and
   * `system_metadata` arrive at tugcast immediately rather than
   * waiting for a user submit to drain the pipe (the pre-R1e
   * blocker).
   *
   * Bad JSON is logged and skipped (preserves the pre-R1e
   * `handleUserMessage` shape).
   */
  /**
   * {@link handleClaudeLine} behind a throw barrier. The stdout drain has
   * no `catch`: before this guard, one synchronous throw from any handler
   * escaped the read loop, the drain exited for good, and every subsequent
   * claude line — tool frames, turn completes, everything — was silently
   * lost while the process stayed alive (a full session wedge that also
   * blinds attribution). One bad line loses that line only.
   */
  private handleClaudeLineGuarded(line: string): void {
    try {
      this.handleClaudeLine(line);
    } catch (err) {
      logSessionLifecycle("stdout_drain.line_exception", {
        session_id: this.sessionId,
        message: err instanceof Error ? err.message : String(err),
        line_preview: line.slice(0, 200),
      });
    }
  }

  private handleClaudeLine(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.log(`Skipping non-JSON line: ${line}`);
      return;
    }
    // Background-agent tailer lifecycle. Observed here — not in the
    // per-turn or inter-turn dispatchers — because the launch echo
    // arrives in-turn while the completion signals can land in either
    // tier; this is the one site that sees every event. Purely
    // observational: it never consumes the line, and it never throws
    // into the drain.
    this.observeSubagentLifecycle(event);
    // `ai-title`: claude's auto-generated session title. It arrives
    // turn-free and carries no `uuid`, so it must be caught here rather
    // than in the turn dispatchers. Forwarded as `session_title` and
    // consumed — tugcast writes it to the ledger (never over a
    // `/rename`), so the picker and the chip see the title as it is
    // written rather than at the next external scan.
    if (event.type === "ai-title") {
      const title = typeof event.aiTitle === "string" ? event.aiTitle.trim() : "";
      if (title.length > 0) {
        writeLine({ type: "session_title", title });
      }
      return;
    }
    // Intercept the `initialize` control-response before any turn
    // routing — it arrives turn-free (no active turn), so it must be
    // caught here rather than in `routeTopLevelEvent` (which only runs
    // for an open turn). Correlate by `request_id` against the one we
    // sent at spawn; emit the capabilities as `session_capabilities` and
    // consume the line. Any other `control_response` falls through to the
    // normal path.
    if (
      this.initializeRequestId !== null &&
      readControlResponseRequestId(event) === this.initializeRequestId
    ) {
      this.initializeRequestId = null;
      // The handshake ack proves claude launched and (for a resume) opened
      // its JSONL. A later exit is now a runtime crash, not a resume failure.
      // Correlated on the id alone: claude answered, which is the proof —
      // a response whose payload doesn't parse as capabilities still proves
      // the process is up and reading, and anyone awaiting readiness
      // ({@link awaitSpawnReady}) must not be left hanging on the shape of a
      // payload they never look at.
      this.initializeHandshakeAcked = true;
      this.drainInitializeAckWaiters();
      const parsed = parseInitializeControlResponse(
        event,
        this.currentEffort,
        this.claudeCodeVersion,
      );
      if (parsed !== null) {
        // claude's turn-free handshake omits `--plugin-dir` plugin commands
        // (they load lazily, surfacing only with the first turn's system
        // init). Merge the bundled plugin's commands from disk so a fresh
        // card can list and submit them from the drop.
        const withPlugins = mergePluginCommands(
          parsed.capabilities,
          enumeratePluginCommands(this.getPluginDir()),
        );
        writeLine(withPlugins);
      }
      return;
    }
    // `rewind_files` control-response correlation ([#step-7-1]). Like the
    // `initialize` handshake, a rewind response arrives turn-free (we only
    // issue rewind requests while claude is idle), so it must be caught
    // here before turn routing. Correlate by `request_id` against the map
    // and relay as the matching outbound IPC. Any uncorrelated
    // `control_response` falls through (logged at the `case` site).
    if (
      event.type === "control_response" &&
      this.pendingRewindRequests.size > 0 &&
      this.tryHandleRewindControlResponse(event)
    ) {
      return;
    }
    // `/btw` side-question control-response correlation. Like the
    // `initialize` handshake and rewind, it must be caught turn-free before
    // turn routing — but UNLIKE them, the response can arrive mid-turn (the
    // whole point of `/btw`), and this pre-routing catch is exactly why that
    // works: a correlated response is consumed and does not reach
    // `dispatchEventToTurn` (Risk R01). Uncorrelated responses fall through.
    if (
      event.type === "control_response" &&
      this.pendingSideQuestions.size > 0 &&
      this.trySideQuestionControlResponse(event)
    ) {
      return;
    }
    // Wake bracket detector ([D07]). The harness's built-in scheduler
    // fires ScheduleWakeup / CronCreate timers between turns and emits
    // a fresh `system/init` to bracket the resulting assistant turn.
    // But `system/init` ALSO re-emits mid-turn after `compact_boundary`
    // events — the SDK reissues init metadata once the compact
    // completes. Distinguish by turn state: a wake re-init arrives
    // between turns (`activeTurn === null`), a compact re-init arrives
    // inside an open turn.
    //
    // First init: flip the flag, fall through to normal dispatch.
    // Re-init between turns: handle as wake (emit `wake_started`,
    //   open a fresh ActiveTurn so subsequent stream events route).
    // Re-init mid-turn: fall through to `dispatchEventToTurn` so the
    //   refreshed `system_metadata` IPC is forwarded normally.
    //
    // Lives in `handleClaudeLine` (not `handleInterTurnEvent`) because
    // claude's first real `system/init` in new-mode sessions arrives
    // DURING the first user turn — it must flip the flag even when
    // routed through `dispatchEventToTurn`.
    if (event.type === "system" && event.subtype === "init") {
      if (this.sessionInitSeen) {
        if (this.activeTurn === null) {
          this.handleWakeReInit();
          this.maybeEmitContextBreakdown(event);
          return;
        }
        // Mid-turn re-init (compact boundary). Fall through.
      } else {
        this.sessionInitSeen = true;
      }
    }
    // Open a turn for a buffered follow-on. `handleUserMessage` opens
    // the turn for the idle case; when it instead queued the message
    // (a turn was already running), claude runs it as a separate turn
    // after the current one's `result`. Those events would otherwise
    // arrive with `activeTurn === null` and be dropped as inter-turn —
    // the overlapping-turn routing bug. The drain claims the head of
    // `pendingTurnInputs` as the follow-on turn's user-message payload.
    if (this.activeTurn === null && this.pendingTurnInputs.length > 0) {
      this.openTurnFromPending();
    }
    if (this.activeTurn !== null) {
      const turn = this.activeTurn;
      this.dispatchEventToTurn(turn, event);
      // `result` ends the turn — `dispatchEventToTurn` latched
      // `gotResult` and resolved `turn.completion`. Clear the slot so
      // the next claude event opens a fresh turn instead of
      // dispatching into a finished one. Turn ownership is
      // `result`-bounded and lives here, not in `handleUserMessage`.
      //
      // Also clear `isInWake` if it was set — the terminating
      // `result` closes the wake bracket (no separate `wake_complete`
      // frame on the wire; the tugdeck reducer's commit path maps
      // `waking → idle` on the `turn_complete` that this `result`
      // produces). See `handleTaskNotification` for the bracket-open
      // side and `dash/tugplan-session-wake.md` [D02].
      if (turn.gotResult) {
        // Trailing flush ([Q06]): emit the final bin's accumulated work
        // before the turn's slot clears, so a turn that ends within a bin
        // still reports its last decaying sample.
        this.flushActivity(turn);
        this.activeTurn = null;
        if (this.isInWake) {
          this.isInWake = false;
        }
        // Retraction hook: a turn interrupted with `retract: true`
        // truncates its own prompt out of the session JSONL now that
        // the turn is closed. Only on this clean `result`-bounded
        // close — the EOF close means claude died, and a respawn
        // decision there belongs to the crash/early-exit paths, not
        // the retraction.
        this.maybeScheduleRetraction(turn);
      }
    } else {
      this.handleInterTurnEvent(event);
    }
    // After the canonical dispatch has written its own frames, give
    // the context_breakdown emitter a chance to append its frame for
    // the same event. Order matters: a `cost_update` from the
    // dispatcher is followed by a `context_breakdown` so reducers
    // that join the two by arrival order see them in the expected
    // sequence. The emitter is silent when not initialized or when
    // the event is not a trigger.
    this.maybeEmitContextBreakdown(event);
  }

  /**
   * Start / stop live background-agent tailers from the raw claude
   * event stream. Three signals:
   *
   *  - **Launch** — the async-launch echo ({@link extractAsyncLaunch})
   *    starts a {@link SubagentTailer} on the echo's `outputFile`,
   *    keyed by `agentId`. The tailer's frames go straight to
   *    `writeLine` with seqs from the shared live counter, exactly like
   *    any other live frame.
   *  - **Genuine completion** — a terminal `system/task_updated`
   *    (`completed` / `failed` / `stopped`) or a
   *    `system/task_notification` (the wake trigger) for the agent's
   *    task id stops its tailer with a final flush, which drains any
   *    remaining lines and composes the parent's final answer.
   *  - Anything else is ignored. Foreground agents never emit the
   *    async echo, so they never get a tailer.
   *
   * Best-effort: nothing here may throw into the stdout drain.
   */
  private observeSubagentLifecycle(event: Record<string, unknown>): void {
    try {
      const launch = extractAsyncLaunch(event);
      if (launch !== undefined && !this.subagentTailers.has(launch.agentId)) {
        const tailer = new SubagentTailer({
          parentToolUseId: launch.parentToolUseId,
          agentId: launch.agentId,
          outputFile: launch.outputFile,
          emit: (frame) => writeLine(frame),
          nextSeq: () => this.nextSeq(),
        });
        this.subagentTailers.set(launch.agentId, tailer);
        tailer.start();
        return;
      }
      if (event.type !== "system") return;
      let taskId: string | undefined;
      if (event.subtype === "task_updated") {
        const patch =
          typeof event.patch === "object" && event.patch !== null
            ? (event.patch as Record<string, unknown>)
            : null;
        const status = patch?.status;
        if (
          status === "completed" ||
          status === "failed" ||
          status === "stopped"
        ) {
          taskId = typeof event.task_id === "string" ? event.task_id : undefined;
        }
      } else if (event.subtype === "task_notification") {
        taskId = typeof event.task_id === "string" ? event.task_id : undefined;
      }
      if (taskId === undefined) return;
      const tailer = this.subagentTailers.get(taskId);
      if (tailer === undefined) return;
      this.subagentTailers.delete(taskId);
      void tailer.stop(true);
    } catch {
      // Tailer bookkeeping must never kill the drain.
    }
  }

  /**
   * Stop every live tailer with a final flush — claude is going away
   * (respawn / fork / shutdown), so whatever the agents' files hold now
   * is all the deck will ever get from this process. Awaited so the
   * composed final answers are written before stdout ownership changes.
   */
  private async stopAllSubagentTailers(): Promise<void> {
    const tailers = Array.from(this.subagentTailers.values());
    this.subagentTailers.clear();
    for (const tailer of tailers) {
      await tailer.stop(true);
    }
  }

  /**
   * Open an `ActiveTurn` for the head of {@link pendingTurnInputs} and
   * install it as {@link activeTurn}. Called by the stdout drain when
   * claude's events for a buffered follow-on turn begin to arrive
   * (see {@link handleClaudeLine}). A fresh `seq` is allocated here,
   * at turn-open, so the user-half `seq` orders just before the
   * turn's own frames. No-op when the FIFO is empty.
   */
  private openTurnFromPending(): void {
    const pending = this.pendingTurnInputs.shift();
    if (pending === undefined) return;
    this.activeTurn = new ActiveTurn(
      this.nextSeq(),
      pending.content,
    );
  }

  /**
   * Inspect a parsed claude stdout event and, if it is a trigger,
   * write a corresponding `context_breakdown` frame to the wire.
   * Trigger events (per spike S4):
   *   - `system:init`      → initial frame after static-categories tokenize
   *   - `result`           → recomputed frame after each cost_update
   *   - `system:compact_boundary` → emitter is notified; the next
   *      `result` produces the updated frame via subtraction
   *
   * No-op when the emitter is not injected. Defensive: any
   * unexpected event shape (missing fields, wrong types) leaves the
   * emitter untouched and produces no frame.
   */
  /**
   * Emit the session-open `context_breakdown` frame — the static
   * estimate computed entirely from disk, so the Context surface
   * populates the moment the session opens (before claude's
   * `system:init`, which only lands once the first turn sends input).
   * No-op when the emitter is not injected (tests).
   */
  private emitInitialContextBreakdown(): void {
    const emitter = this.contextBreakdownEmitter;
    if (emitter) writeLine(emitter.onSpawn());
  }

  /**
   * Emit the session's resolved cwd at spawn — before claude's first turn —
   * as a minimal `system_metadata` frame ([#step-12a]). claude stays silent
   * (no `system:init`, hence no `cwd`) until the first input, so without this
   * the client wouldn't know the project's resolved path from the drop, and
   * cwd-derived surfaces (e.g. `/memory`'s auto-memory folder) would have to
   * guess from the user-typed (possibly symlinked) path. `this.projectDir` is
   * already canonicalized in `main.ts` to claude's resolved form. Only `cwd`
   * is carried; tugcast's field-aware merge fills the rest from claude's real
   * `system_metadata` once it arrives, and on a resumed session the persisted
   * richer metadata is preserved (incoming-absent fields keep current).
   */
  private emitInitialSessionCwd(): void {
    writeLine({
      type: "system_metadata",
      cwd: this.projectDir,
      ipc_version: 2,
    });
  }

  /**
   * Inter-turn `system/task_notification` arm — the wake detector.
   *
   * A `system/task_notification` event arrives between turns when an
   * async deferred-completion tool (Monitor timeout, Cron firing,
   * ScheduleWakeup arrival, etc.) raises an event after the parent
   * assistant turn has already completed. Claude resumes in a fresh
   * turn to respond to the notification, *without* a preceding user
   * submission.
   *
   * Detection and emission:
   *   1. Build the {@link WakeStarted} IPC frame via
   *      {@link buildWakeStartedMessage} (pure helper — testable).
   *      Returns null on malformed events; we silently drop those.
   *   2. Suppress emission if a wake bracket is already open
   *      ({@link isInWake} true). Nested wakes flatten to one outer
   *      bracket on the wire; inner trigger metadata is logged at
   *      debug level only. See plan [#spec-phase-transitions].
   *   3. Emit the frame, flip {@link isInWake}, open a fresh
   *      `ActiveTurn` so the wake's content events (which will
   *      arrive next — `message_start`, `assistant`, `stream_event`,
   *      and the terminal `result`) route through the existing
   *      `dispatchEventToTurn` machinery. Without opening a turn,
   *      every subsequent wake event would fall back to
   *      `handleInterTurnEvent` and be silently dropped — the
   *      precise upstream cause of [PPF-01] before this fix.
   *
   * The wake turn carries no user-typed text: the `ActiveTurn` is
   * opened with empty `userText` + empty `userAttachments`. The
   * tugdeck reducer recognizes this via the `wake_started` bracket
   * (not by inspecting the user text), so the empty marker does not
   * leak as a phantom user bubble in normal rendering. A mid-wake card
   * reload that triggers `runReplay` no longer surfaces an empty
   * `add_user_message`: replay opens orphan assistant content with an
   * honest `assistant_opener` (`tuglaws/turn-metric.md` S02), never a
   * fabricated user message.
   *
   * The wake bracket closes implicitly: when the wake's terminal
   * `result` lands, `handleClaudeLine` clears `activeTurn` AND
   * {@link isInWake} — no `wake_complete` frame on the wire.
   */
  private handleTaskNotification(event: Record<string, unknown>): void {
    const frame = buildWakeStartedMessage(event, this.sessionId);
    if (frame === null) {
      return;
    }
    if (this.isInWake) {
      console.log(
        `[tugcode/wake] nested task_notification ignored ` +
          `(task_id=${frame.wake_trigger.task_id})`,
      );
      return;
    }
    writeLine(frame);
    this.isInWake = true;
    this.activeTurn = new ActiveTurn(this.nextSeq(), []);
  }

  /**
   * Cohort B wake bracket — the harness's built-in scheduler fired a
   * `ScheduleWakeup` / `CronCreate` timer and re-bracketed the session
   * with a fresh `system/init`. Mirrors {@link handleTaskNotification}'s
   * Cohort A semantics: emit a `wake_started` frame, set
   * {@link isInWake}, and open a fresh `ActiveTurn` so the subsequent
   * stream events route through {@link dispatchEventToTurn}.
   *
   * The harness's re-init carries no task id / tool_use_id on the wire
   * (verified in `tugcode/probes/wake-investigation/capture-*.stdout`),
   * so the frame's `wake_trigger.task_id` / `tool_use_id` are empty
   * strings. Slice 2 chrome may later snapshot `ScheduleWakeup` /
   * `CronCreate` tool_use payloads and match them to upcoming wakes;
   * for this slice we just open the bracket so the wake turn paints.
   *
   * See `dash/wake-investigation-findings.md` and design decision
   * [D07].
   */
  private handleWakeReInit(): void {
    if (this.isInWake) {
      console.log(
        `[tugcode/wake] re-init during open wake bracket — ignored`,
      );
      return;
    }
    // Drain the pending-trigger FIFO so the wake carries its label —
    // "loop pacing" beats a bare "scheduled wake". A wakeup entry is
    // consumed by its fire; a cron entry persists (recurring) until
    // CronDelete clears it.
    const trigger =
      this.pendingScheduledTriggers.length > 0
        ? this.pendingScheduledTriggers[0]
        : null;
    if (trigger !== null && trigger.kind === "wakeup") {
      this.pendingScheduledTriggers.shift();
    }
    const frame: WakeStarted = {
      type: "wake_started",
      session_id: this.sessionId,
      wake_trigger: {
        task_id: "",
        tool_use_id: trigger?.toolUseId ?? "",
        status: "completed",
        summary:
          trigger !== null && trigger.label.length > 0
            ? trigger.label
            : "scheduled wake",
        output_file: "",
      },
      ipc_version: 2,
    };
    writeLine(frame);
    this.isInWake = true;
    this.activeTurn = new ActiveTurn(this.nextSeq(), []);
  }

  private maybeEmitContextBreakdown(event: Record<string, unknown>): void {
    const emitter = this.contextBreakdownEmitter;
    if (!emitter) return;
    if (event.type === "system") {
      const subtype = event.subtype;
      if (subtype === "init") {
        // `system:init` reports the built-in tool count — the one
        // input the filesystem can't reveal. Re-emit with it so
        // `system_tools` switches from the flat heuristic to the
        // exact count. A missing/empty `tools` keeps the heuristic.
        if (Array.isArray(event.tools) && event.tools.length > 0) {
          writeLine(emitter.onSessionInit(event.tools.length));
        }
      } else if (subtype === "compact_boundary") {
        emitter.onCompactBoundary();
      }
    } else if (event.type === "result") {
      const modelUsage =
        typeof event.modelUsage === "object" && event.modelUsage !== null
          ? (event.modelUsage as Record<string, unknown>)
          : undefined;
      const frame = emitter.onCostUpdate(modelUsage);
      if (frame) writeLine(frame);
    }
  }

  /**
   * Forward init-shaped events that arrive when no turn is active.
   * Pre-R1e these were stuck in the OS pipe between claude and
   * tugcode until a user submit ran the per-turn reader. Post-R1e
   * the drain forwards them as soon as they arrive — improving
   * tugcast/tugdeck observability without changing the wire shape.
   *
   * Wake-bracket detection (`system/init` re-init = wake fire) lives
   * in `handleClaudeLine`, which sees every event regardless of turn
   * state. By the time an event reaches this method, a re-init has
   * already been handled and returned. So a `system/init` here is
   * guaranteed to be the FIRST init for this subprocess — forward
   * normally as `session_init` IPC.
   */
  private handleInterTurnEvent(event: Record<string, unknown>): void {
    if (event.type === "system" && event.subtype === "init") {
      const sessionId = (event.session_id as string) || "unknown";
      writeLine({ type: "session_init", session_id: sessionId, ipc_version: 2 });
    }
    if (event.type === "system" && event.subtype === "task_notification") {
      this.handleTaskNotification(event);
    }
    // Background-task lifecycle frames also fire BETWEEN turns — an
    // idle completion delivers its terminal `task_updated` after the
    // launch turn's result (v2.1.173-jobs-spike capture). Forward them
    // from the drain so the deck's jobs ledger flips without waiting
    // for the next turn.
    if (event.type === "system" && event.subtype === "task_started") {
      const frame = buildTaskStartedMessage(
        event,
        (event.session_id as string) || this.sessionId,
      );
      if (frame !== null) writeLine(frame);
    }
    if (event.type === "system" && event.subtype === "task_updated") {
      const frame = buildTaskUpdatedMessage(
        event,
        (event.session_id as string) || this.sessionId,
      );
      if (frame !== null) writeLine(frame);
    }
    // A backgrounded agent emits its `task_progress` ticks concurrently
    // with the launching turn, so they too can land in the inter-turn
    // drain (observed inter-result in the background-Agent catalog
    // probe). Forward from both tiers, mirroring task_started/updated.
    if (event.type === "system" && event.subtype === "task_progress") {
      const frame = buildTaskProgressMessage(
        event,
        (event.session_id as string) || this.sessionId,
      );
      if (frame !== null) writeLine(frame);
    }
    // `system/status` (the 2.1.197 heartbeat) is intentionally not
    // forwarded from either tier — see the in-turn `routeTopLevelEvent`
    // note for the rationale.
    // Other inter-turn event types are currently no-ops. The drain
    // is intentionally permissive here — it must not throw, since
    // unhandled-but-syntactically-valid lines from claude (a future
    // `system_metadata` between turns, etc.) shouldn't kill the
    // drain task.
  }

  /**
   * Per-turn dispatcher. Migrates the body of pre-R1e
   * `handleUserMessage`'s line-pulling loop verbatim, with one
   * substitution: per-turn mutable state lives on `turn` instead of
   * SessionManager fields. The two-tier routing (`routeTopLevelEvent`
   * + `mapStreamEvent`) is unchanged; control_request/cancel
   * handling is unchanged; turn-end emission of the final
   * `assistant_text` + `turn_complete` is unchanged.
   *
   * On `gotResult`, calls `turn.finish()` to resolve the completion
   * promise so `handleUserMessage`'s await returns.
   */
  /**
   * Ensure the 250 ms activity-flush interval is running ([Q06]). Idempotent
   * — created once on the first turn's first event and left running for the
   * session. The timer is unref'd so a quiescent tugcode still exits cleanly
   * (the drain / stdin loops own liveness, not this heartbeat).
   */
  private ensureActivityFlush(): void {
    if (this.activityFlushTimer !== null) return;
    const timer = setInterval(() => {
      this.flushActivity(this.activeTurn);
    }, ACTIVITY_FLUSH_MS);
    // Bun's Timer supports unref(); guard for any host that doesn't.
    timer.unref?.();
    this.activityFlushTimer = timer;
  }

  /**
   * Drain `turn`'s accumulated activity and emit one `activity_delta` frame
   * for the bin (behind `!suppressEmit` — a replay bracket emits nothing).
   * A no-op for a null / idle / suppressed turn. tugcast splices the
   * `tug_session_id` and diverts the frame onto `FeedId::ACTIVITY`.
   */
  private flushActivity(turn: ActiveTurn | null): void {
    if (turn === null || turn.suppressEmit) return;
    const channels = turn.drainActivity();
    if (channels === null) return;
    const frame: ActivityDelta = {
      type: "activity_delta",
      channels,
      ipc_version: 2,
    };
    writeLine(frame);
  }

  /**
   * Pending scheduled-trigger labels, FIFO. When the main lane calls
   * `ScheduleWakeup` / `CronCreate`, the harness's later fire arrives as
   * a bare re-init with no id (Cohort B), so the only way to label the
   * wake is to remember what was scheduled. `handleWakeReInit` drains
   * this: a wakeup entry is consumed by its fire (fire-once); a cron
   * entry persists across fires until `CronDelete`. `ScheduleWakeup
   * {stop:true}` clears pending wakeups (the loop-skill end signal).
   * Bounded — a runaway scheduler can't grow it without limit.
   */
  private pendingScheduledTriggers: Array<{
    toolUseId: string;
    kind: "wakeup" | "cron";
    label: string;
  }> = [];

  /**
   * Observe outbound `tool_use` frames for scheduled-work registration.
   * Main lane only — a subagent's scheduling isn't this session's wake.
   */
  private noteScheduledTriggerFrames(
    messages: OutboundMessage[],
    laneKey: string | null,
  ): void {
    if (laneKey !== null) return;
    for (const m of messages) {
      if (m.type !== "tool_use") continue;
      const name = m.tool_name.toLowerCase();
      if (name !== "schedulewakeup" && name !== "croncreate" && name !== "crondelete") {
        continue;
      }
      const input = m.input as Record<string, unknown> | undefined;
      if (name === "schedulewakeup") {
        if (input?.stop === true) {
          this.pendingScheduledTriggers = this.pendingScheduledTriggers.filter(
            (t) => t.kind !== "wakeup",
          );
          continue;
        }
        const label =
          typeof input?.reason === "string" && input.reason.length > 0
            ? input.reason
            : typeof input?.prompt === "string"
              ? input.prompt
              : "";
        this.pendingScheduledTriggers.push({
          toolUseId: m.tool_use_id,
          kind: "wakeup",
          label,
        });
      } else if (name === "croncreate") {
        const label =
          typeof input?.prompt === "string" && input.prompt.length > 0
            ? input.prompt
            : typeof input?.cron === "string"
              ? input.cron
              : "";
        this.pendingScheduledTriggers.push({
          toolUseId: m.tool_use_id,
          kind: "cron",
          label,
        });
      } else {
        this.pendingScheduledTriggers = this.pendingScheduledTriggers.filter(
          (t) => t.kind !== "cron",
        );
      }
      if (this.pendingScheduledTriggers.length > 8) {
        this.pendingScheduledTriggers = this.pendingScheduledTriggers.slice(-8);
      }
    }
  }

  private dispatchEventToTurn(
    turn: ActiveTurn,
    event: Record<string, unknown>,
  ): void {
    // Keep the per-turn activity heartbeat alive (idempotent). Started here
    // so every turn-open path (handleUserMessage, buffered follow-on,
    // compact/wake re-inits) is covered by construction.
    this.ensureActivityFlush();
    // Resolve the event's lane BEFORE any mapping: a turn's stdout
    // multiplexes the main loop with background subagents' streams,
    // and each runs its own message cycle with its own `message.id`s.
    // All per-message pointer state (msgId / rev / partialText /
    // messageBlocks) is lane-scoped so a subagent's `message_start`
    // can never re-stamp the main loop's in-flight deltas (or vice
    // versa) with the wrong msg_id.
    const rawLaneId = event.parent_tool_use_id;
    const laneKey: string | null =
      typeof rawLaneId === "string" && rawLaneId.length > 0
        ? rawLaneId
        : null;
    const lane = turn.laneFor(laneKey);

    const ctx: EventMappingContext = {
      msgId: lane.msgId ?? "",
      openerId: turn.openerId,
      seq: turn.seq,
      rev: lane.rev,
      pendingCompactSummary: turn.pendingCompactSummary,
    };

    // Tier 1: route the top-level message type. The turn's last
    // tool-loop iteration's `usage` (latest `message_delta`, else last
    // `message_start`) is handed in so the `result` branch emits it as
    // `cost_update.usage` — not `result.usage`, the per-iteration sum.
    const routeResult = routeTopLevelEvent(
      event,
      ctx,
      turn.lastMessageDeltaUsage ?? turn.lastMessageStartUsage,
    );

    // Slide the lane's pointer to claude's most recent `message.id`.
    // Top-level `assistant` snapshots carry it directly; nothing rejects,
    // nothing freezes. Multi-message cycles simply move the pointer to
    // the new id when the next `message_start` (below) arrives.
    if (routeResult.messageId !== undefined) {
      lane.msgId = routeResult.messageId;
      ctx.msgId = lane.msgId;
    }

    // Latch the updated armed-capture state across events ([P08]): a boundary
    // arms it, the captured summary or a `result` disarms it, other events
    // leave it unchanged (`undefined`).
    if (routeResult.pendingCompactSummary !== undefined) {
      turn.pendingCompactSummary = routeResult.pendingCompactSummary;
    }

    // `/rewind` anchor ([#step-7-1]). The live user-echo reveals the
    // turn's prompt-record uuid; latch it onto the turn (so the mid-turn
    // snapshot can carry it on `add_user_message.promptUuid`) and deliver
    // it live as a `prompt_anchor`. Emit once — the first echo carrying a
    // uuid wins. Gated by `suppressEmit`: during a replay bracket the
    // anchor rides `add_user_message.promptUuid` instead, so a live
    // `prompt_anchor` would be redundant (state still latches).
    if (routeResult.promptUuid !== undefined && turn.promptUuid === null) {
      turn.promptUuid = routeResult.promptUuid;
      if (!turn.suppressEmit) {
        writeLine({
          type: "prompt_anchor",
          promptUuid: routeResult.promptUuid,
          ipc_version: 2,
        });
      }
    }

    for (const ipcMsg of routeResult.messages) {
      if (routeResult.parentToolUseId) {
        (ipcMsg as unknown as Record<string, unknown>).parent_tool_use_id =
          routeResult.parentToolUseId;
      }
      // Gate site 1/7: suppressEmit holds back live forwarding while
      // runReplay's bracket is on the wire. State mutations (the lane's
      // msgId / rev / partialText / messageBlocks) continue regardless —
      // the snapshot emission in emitInflightTurnFromActiveTurn reads
      // them. Activity accounting rides the same gate so a replay
      // bracket's re-emitted frames never generate a sample ([Q06]).
      if (!turn.suppressEmit) {
        turn.accountActivity(ipcMsg as unknown as Record<string, unknown>);
        writeLine(ipcMsg);
      }
    }
    // Mirror routed messages onto the lane's per-block state for
    // mid-turn replay snapshot ([D07] § Mid-turn replay snapshot). Runs
    // regardless of suppressEmit so the snapshot has up-to-date block
    // state if the bracket fires.
    turn.updateBlockStateFromMessages(routeResult.messages, laneKey);
    this.noteScheduledTriggerFrames(routeResult.messages, laneKey);

    // Tier 2: delegate stream_event inner payload to mapStreamEvent().
    if (routeResult.streamEvent) {
      const streamResult = mapStreamEvent(
        routeResult.streamEvent,
        ctx,
        lane.partialText,
      );
      // Slide the lane's pointer when `message_start` reveals a new id.
      // claude emits this before any content-bearing event of the
      // message, so by the time `content_block_delta` lands, ctx.msgId
      // is already claude's. Multi-message cycles: a second
      // `message_start` simply moves the pointer to the new id; the
      // prior message's frames are already on the wire under its own
      // id. Lane-scoped: a background subagent's `message_start` slides
      // only ITS lane, so the main loop's in-flight deltas keep their
      // msg_id (and vice versa).
      if (streamResult.messageId !== undefined) {
        lane.msgId = streamResult.messageId;
        ctx.msgId = lane.msgId;
        // A fresh main-lane `message_start` means claude opened another
        // tool-loop iteration — it's alive and working, so disarm any
        // result watchdog a prior terminal `stop_reason` set. (Subagent
        // lanes never gate the main turn's liveness.)
        if (laneKey === null) this.clearResultWatchdog();
      }
      // Result-liveness watchdog ([defect 5]): claude closes its final
      // assistant message with a terminal `stop_reason`, then emits the
      // turn's `result` almost immediately. Arm the watchdog on that terminal
      // stop; if `result` never lands the turn is wedged post-content (the
      // commit-xp hang). Main lane + live only — never during a replay bracket
      // (historical deltas) or on a subagent's message.
      if (
        laneKey === null &&
        !turn.suppressEmit &&
        routeResult.streamEvent.type === "message_delta"
      ) {
        const delta = routeResult.streamEvent.delta as
          | Record<string, unknown>
          | undefined;
        const stopReason = delta?.stop_reason;
        if (typeof stopReason === "string" && TERMINAL_STOP_REASONS.has(stopReason)) {
          this.armResultWatchdog(turn);
        }
      }
      for (const ipcMsg of streamResult.messages) {
        if (routeResult.parentToolUseId) {
          (ipcMsg as unknown as Record<string, unknown>).parent_tool_use_id =
            routeResult.parentToolUseId;
        }
        // Gate site 2/7: live deltas during the suppressed window
        // accumulate into turn state (partialText, messageBlocks) but
        // stay off the wire. After runReplay clears suppressEmit,
        // future deltas writeLine normally. Mid-turn replay's
        // snapshot path emits per-block events from messageBlocks
        // ([D07] § Mid-turn replay snapshot); subsequent live deltas
        // append via (msg_id, block_index) match against Messages the
        // snapshot already minted.
        if (!turn.suppressEmit) {
          turn.accountActivity(ipcMsg as unknown as Record<string, unknown>);
          writeLine(ipcMsg);
        }
      }
      // Mirror streamed messages onto the lane's per-block state. Same
      // rationale as the routeResult call above.
      turn.updateBlockStateFromMessages(streamResult.messages, laneKey);
      this.noteScheduledTriggerFrames(streamResult.messages, laneKey);

      // Tool-input progress: claude streams a tool's argument JSON as
      // `input_json_delta` fragments. The block state (minted by the
      // preceding content_block_start) was just refreshed above, so the
      // delta's block_index now resolves to its tool_use_id / name. Emit a
      // cumulative `tool_input_progress` frame when the narratable state
      // advances. Gate site shares the suppressEmit discipline of the
      // sibling delta emits — accumulation continues, the wire stays quiet
      // during a replay bracket.
      const inner = routeResult.streamEvent;
      if (inner.type === "content_block_delta") {
        const innerDelta = inner.delta as Record<string, unknown> | undefined;
        if (
          innerDelta?.type === "input_json_delta" &&
          typeof innerDelta.partial_json === "string"
        ) {
          const innerIndex =
            typeof inner.index === "number" ? inner.index : 0;
          const progress = turn.recordToolInputDelta(
            ctx.msgId,
            innerIndex,
            innerDelta.partial_json,
            laneKey,
          );
          if (progress !== null) {
            // Tag subagent-lane progress like every other subagent
            // frame so the deck routes it under the Agent block.
            if (routeResult.parentToolUseId) {
              (progress as unknown as Record<string, unknown>).parent_tool_use_id =
                routeResult.parentToolUseId;
            }
            if (!turn.suppressEmit) {
              turn.accountActivity(
                progress as unknown as Record<string, unknown>,
              );
              writeLine(progress);
            }
          }
        }
      }

      lane.rev = streamResult.newRev;
      lane.partialText = streamResult.partialText;
      // Latch this iteration's `usage` — MAIN lane only. The latched
      // pair feeds the turn's terminal `cost_update.usage` and the
      // mid-turn snapshot's `streaming_usage` re-emit, both of which
      // describe the main loop; a background subagent's message cycle
      // must not clobber them.
      if (laneKey === null) {
        if (streamResult.messageStartUsage !== undefined) {
          turn.lastMessageStartUsage = streamResult.messageStartUsage;
        }
        if (streamResult.messageDeltaUsage !== undefined) {
          turn.lastMessageDeltaUsage = streamResult.messageDeltaUsage;
        }
      }
    }

    // Handle control_request: emit ControlRequestForward and store for
    // correlation.
    if (routeResult.controlRequest) {
      const cr = routeResult.controlRequest;
      const requestId = cr.request_id as string;
      const request = cr.request as Record<string, unknown> | undefined;
      const subtype = request?.subtype as string | undefined;

      if (subtype === "can_use_tool" && requestId && request) {
        const toolName = (request.tool_name as string) || "";
        const isQuestion = toolName === "AskUserQuestion";

        // Bypass mode auto-allows every permission request at the bridge:
        // respond to the CLI immediately and never forward, so no dialog
        // surfaces in the deck. AskUserQuestion rides the same
        // `can_use_tool` wire but is a question, not a permission prompt —
        // it still forwards. Nothing is stored in pendingControlRequests,
        // so the mid-turn snapshot re-emit can't resurrect a bypassed
        // request either.
        if (
          !isQuestion &&
          this.permissionManager.getMode() === "bypassPermissions" &&
          this.claudeProcess
        ) {
          sendControlResponse(
            this.claudeProcess.stdin,
            formatPermissionAllow(
              requestId,
              (request.input as Record<string, unknown>) || {},
            ),
          );
          return;
        }

        this.pendingControlRequests.set(requestId, cr);

        const forward: ControlRequestForward = {
          type: "control_request_forward",
          request_id: requestId,
          tool_name: toolName,
          input: (request.input as Record<string, unknown>) || {},
          decision_reason: request.decision_reason as string | undefined,
          permission_suggestions: request.permission_suggestions as
            | unknown[]
            | undefined,
          blocked_path: request.blocked_path as string | undefined,
          tool_use_id: request.tool_use_id as string | undefined,
          is_question: isQuestion,
          ipc_version: 2,
        };
        // Gate site 3/7. The pendingControlRequests entry above is
        // still recorded so a tool_approval response from tugdeck
        // would correlate; the forward itself is held back so the
        // reducer's replaying phase doesn't surface a tool dialog
        // while the bracket is on the wire. In practice runReplay's
        // window is short (tens of ms) and tool approvals are rare
        // mid-window — a request that lands here would deadlock on
        // tugdeck's side until claude retries. Acceptable for v1;
        // see [#roadmap].
        if (!turn.suppressEmit) writeLine(forward);
      } else {
        console.log(`Unhandled control_request subtype=${subtype ?? "unknown"}`);
      }
    }

    // Handle control_cancel_request: clean up pending entry.
    if (routeResult.cancelledRequestId) {
      this.pendingControlRequests.delete(routeResult.cancelledRequestId);
    }

    if (routeResult.gotResult) {
      turn.gotResult = true;
      // The turn's `result` landed — the wedge the watchdog guards against
      // did not happen. Disarm it (and any cancel-escalation timer, which the
      // completion hook also clears).
      this.clearResultWatchdog();
      // Emit final complete terminal frames for each text/thinking
      // block of the current message. The per-delta path has already
      // delivered the text incrementally; these terminal frames serve
      // as a safety baseline (REPLACE-equivalent for the matching
      // Message) and let the reducer recover from any delta-loss
      // window. One frame per block — under [D07]'s per-Message
      // substrate, a single consolidated terminal emit for the full
      // turn's text would be miskeyed (turn spans multiple msgIds and
      // blocks).
      //
      // Scope: ONLY currentMessageId's blocks. A multi-msgId tool-use
      // loop (e.g. thinking+tool → tool_result → thinking+tool →
      // tool_result → text) emits per-delta wire events as it
      // progresses; each iteration's text reaches the reducer
      // incrementally via is_partial: true deltas BEFORE the next
      // iteration's message_start. The intermediate iterations'
      // content is already in the reducer's scratch by the time the
      // terminal `result` lands, so we only need to baseline the
      // FINAL iteration's blocks here. (For mid-turn replay snapshot
      // the picture is different: that path replays ALL msgIds'
      // blocks because the new client never saw the earlier deltas.
      // See emitInflightTurnFromActiveTurn below.)
      //
      // Slash commands (local commands) deliver output via the
      // user/isReplay handler synthesizing both a content_block_start
      // and a terminal assistant_text — those blocks land in
      // messageBlocks via updateBlockStateFromMessages above, so the
      // iteration below picks them up too. No special-case needed.
      //
      // Gate site 4/7. Skipped emits during the suppressed window are
      // reconstructed by emitInflightTurnFromActiveTurn.
      const currentBlocks =
        turn.currentMessageId !== null
          ? turn.messageBlocks.get(turn.currentMessageId) ?? []
          : [];
      for (const block of currentBlocks) {
        if (block.kind !== "text" && block.kind !== "thinking") continue;
        if (block.text.length === 0) continue;
        if (turn.suppressEmit) continue;
        const completeSeq = this.nextSeq();
        if (block.kind === "text") {
          writeLine({
            type: "assistant_text",
            msg_id: turn.currentMessageId ?? "",
            block_index: block.index,
            seq: completeSeq,
            rev: 0,
            text: block.text,
            is_partial: false,
            status: "complete",
            ipc_version: 2,
          });
        } else {
          writeLine({
            type: "thinking_text",
            msg_id: turn.currentMessageId ?? "",
            block_index: block.index,
            seq: completeSeq,
            text: block.text,
            is_partial: false,
            status: "complete",
            ipc_version: 2,
          });
        }
      }

      const turnSeq = this.nextSeq();
      const resultValue =
        (routeResult.resultMetadata?.resultValue as string) || "success";
      // Gate site 5/7. The reconstructed terminal event lives in
      // emitInflightTurnFromActiveTurn (turn_complete branch when
      // gotResult).
      if (!turn.suppressEmit) {
        writeLine({
          type: "turn_complete",
          // Fall back to the turn's opener id, never "": a no-content
          // turn (`/compact`, `/model`) has no claude message id, and an
          // empty msg_id collides in the reducer's `committedMsgIds`
          // dedupe with every other no-content turn's commit.
          msg_id: turn.currentMessageId ?? turn.openerId,
          seq: turnSeq,
          result: resultValue,
          ipc_version: 2,
        });
      }
      turn.finish();
    }
  }
  /**
   * Emit the in-flight turn's content from `ActiveTurn` state, inside
   * `runReplay`'s bracket. Called unconditionally by `runReplay` after
   * the JSONL pass finishes and before the buffered `replay_complete`
   * is written, whenever an in-flight `ActiveTurn` was adopted at
   * bracket entry (`activeTurn !== null && !gotResult && !interrupted`).
   *
   * This is the load-bearing delivery path for claude's pre-HMR
   * streaming content (Step 5.11's never-drop chain link 8). The
   * CODE_OUTPUT broadcast does not backfill new subscribers
   * (`LagPolicy::Replay` only triggers on broadcast lag overflow,
   * not on initial subscribe), the JSONL only contains committed
   * turns, and the Step 5.6 pending-row synthetic delivers only the
   * user-side echo. Without this snapshot, the freshly-connected
   * client sees `pendingUserMessage` set but no scratch text, and
   * post-bracket `is_partial: true` deltas append onto an empty
   * baseline — losing the head of claude's response.
   *
   * The reads here (`turn.userText`, `turn.partialText`, etc.) are
   * tugcode's authoritative state — fresher and more complete than
   * JSONL (the JSONL's incomplete-flush window is the E1 race we're
   * routing around). Caller has set `turn.suppressEmit = true` for
   * the duration of the bracket so live deltas land in turn state but
   * stay off the wire; `runReplay` clears it after `replay_complete`.
   *
   * Tool calls inside the in-flight turn are NOT reconstructed here —
   * the drain currently dispatches tool events through writeLine
   * without buffering per-turn tool state, so we have no record to
   * replay. After this bracket clears, post-suppression live emit
   * resumes; any tool events that landed mid-window did update the
   * pendingControlRequests map but their forwards were skipped (gate
   * site 3/7). A tool approval mid-window is rare given the bracket's
   * tens-of-ms window; documented as a known limitation in the
   * roadmap.
   *
   * Terminal-event branch closes the [DM06] crash-during-suppression
   * pitfall: if the drain hit EOF or claude emitted result while
   * `suppressEmit=true`, `signalEofToActiveTurn` / `dispatchEventToTurn`
   * latched `gotResult` / `interrupted` but skipped their writeLine.
   * Without an explicit terminal here, the reducer's
   * `pendingUserMessage` would stay set and the TurnEntry would
   * never commit. The terminal we synthesize here makes the bracket
   * deliver a complete TurnEntry even when the drain dies mid-replay.
   */
  private emitInflightTurnFromActiveTurn(turn: ActiveTurn): void {
    const msgId = turn.currentMessageId ?? turn.openerId;
    // 1. add_user_message — synthetic. Carries the turn's content
    //    blocks (Anthropic API shape) as-submitted. No `msg_id` on
    //    this frame ([D14]): the reducer's `activeMsgId` is set by
    //    the first content event of the turn (`assistant_text` /
    //    `thinking_text` / `tool_use` / `content_block_start`), not
    //    by the user-side opener. `msgId` from `turn.currentMessageId`
    //    is still locally tracked below so the content frames (which
    //    DO carry msg_id) can be re-emitted with claude's real id.
    writeLine({
      type: "add_user_message",
      content: turn.userContent.slice(),
      // `/rewind` anchor ([#step-7-1]). On this snapshot path the live
      // `prompt_anchor` was suppressed (it fires only outside a replay
      // bracket), so carry the captured uuid here so the freshly-bound
      // client recovers the anchor for the in-flight turn.
      ...(turn.promptUuid !== null ? { promptUuid: turn.promptUuid } : {}),
      ipc_version: 2,
    });

    // 2. Per-message block stream — for each msg_id observed during
    //    this turn (a tool-use loop may span several), iterate the
    //    blocks in arrival order and emit the wire-faithful sequence:
    //    content_block_start (mints the reducer's Message) followed
    //    by the terminal text / tool_use / tool_result frames that
    //    carry the block's accumulated content.
    //
    //    This is [D07]'s Mid-turn replay snapshot pattern (Option 4 —
    //    replay-the-stream): the snapshot IS the event stream that
    //    built the turn up to this moment. The reducer processes
    //    these events through the same handlers it uses live and
    //    during cold-boot replay; content_block_start is idempotent
    //    so any Messages the live path minted before the disconnect
    //    are not duplicate-minted.
    //
    //    Iteration order is by msg_id insertion order (Map iteration
    //    is insertion-ordered in ECMA), then by block.index within
    //    each msg_id (sorted on insert in updateBlockStateFromMessages).
    for (const [blockMsgId, blocks] of turn.messageBlocks) {
      for (const block of blocks) {
        // Emit the kind-specific content_block_start. Under the
        // discriminated BlockState union, the tool_use branch's
        // toolUseId / toolName are guaranteed strings (not undefined),
        // so the wire frame is built without defensive `?? ""`.
        if (block.kind === "text") {
          writeLine({
            type: "content_block_start",
            msg_id: blockMsgId,
            block_index: block.index,
            kind: "text",
            ipc_version: 2,
          });
          if (block.text.length > 0) {
            writeLine({
              type: "assistant_text",
              msg_id: blockMsgId,
              block_index: block.index,
              seq: this.nextSeq(),
              rev: turn.rev,
              text: block.text,
              is_partial: false,
              status: "streaming",
              ipc_version: 2,
            });
          }
        } else if (block.kind === "thinking") {
          writeLine({
            type: "content_block_start",
            msg_id: blockMsgId,
            block_index: block.index,
            kind: "thinking",
            ipc_version: 2,
          });
          if (block.text.length > 0) {
            writeLine({
              type: "thinking_text",
              msg_id: blockMsgId,
              block_index: block.index,
              seq: this.nextSeq(),
              text: block.text,
              is_partial: false,
              status: "streaming",
              ipc_version: 2,
            });
          }
        } else if (block.kind === "tool_use") {
          // Discriminated union narrows toolUseId and toolName to
          // required strings; no fallback needed.
          writeLine({
            type: "content_block_start",
            msg_id: blockMsgId,
            block_index: block.index,
            kind: "tool_use",
            tool_use_id: block.toolUseId,
            tool_name: block.toolName,
            ipc_version: 2,
          });
          writeLine({
            type: "tool_use",
            msg_id: blockMsgId,
            seq: this.nextSeq(),
            tool_name: block.toolName,
            tool_use_id: block.toolUseId,
            input: block.toolInput,
            ipc_version: 2,
          });
          if (block.toolResult !== undefined) {
            writeLine({
              type: "tool_result",
              tool_use_id: block.toolUseId,
              output: block.toolResult.output,
              is_error: block.toolResult.isError,
              ipc_version: 2,
            });
          }
          if (block.toolStructuredResult !== undefined) {
            writeLine({
              type: "tool_use_structured",
              tool_use_id: block.toolUseId,
              tool_name: block.toolName,
              structured_result: block.toolStructuredResult,
              ipc_version: 2,
            });
          }
        } else {
          // Exhaustiveness check — a new BlockState kind added in the
          // future fails this compile-time `never` typecheck, forcing
          // the snapshot path to handle the new case explicitly.
          const _exhaustive: never = block;
          throw new Error(`unknown BlockState kind: ${JSON.stringify(_exhaustive)}`);
        }
      }
    }

    // 3. streaming_usage — re-emit the turn's most recent in-flight
    //    `usage` tuple (delta-iteration preferred, message_start
    //    fallback) so the status bar's TOKENS / CONTEXT cells climb
    //    back to where they were before the reload. Drives
    //    `state.liveTurnUsage` via the reducer's phase-tolerant
    //    `handleStreamingUsage` — same channel the live wire uses
    //    mid-turn, no fake-zero shim required. The reducer's logic
    //    is monotonic-by-iteration (later frame replaces earlier),
    //    so the live `streaming_usage` that lands after the bracket
    //    transparently supersedes this re-emitted one.
    //
    //    Gated by `streamingUsageFrame` on a non-empty msg_id and a
    //    `usage` carrying at least one of the four token fields —
    //    a turn the bracket fired against before `message_start`
    //    revealed any id stays quiet rather than emitting an
    //    all-zero frame.
    const usageForSnapshot =
      turn.lastMessageDeltaUsage ?? turn.lastMessageStartUsage;
    if (usageForSnapshot !== null) {
      const usageFrame = streamingUsageFrame(msgId, usageForSnapshot);
      if (usageFrame !== null) writeLine(usageFrame);
    }

    // 4. Re-emit any pending `can_use_tool` control_request_forward.
    //
    //    Under [D07]'s per-block tracking, the matching tool_use is
    //    already in messageBlocks and was re-emitted in step 2 above.
    //    We only need to re-emit the OOB control_request_forward
    //    here (the SDK's approval request, which never lands in
    //    JSONL). The forward references the tool by `tool_use_id` so
    //    the rehydrated dialog correlates back to the same SDK
    //    request.
    //
    //    Defensive fallback: if the tool_use_id is NOT in any
    //    messageBlocks entry (race / lossy stream / regression), we
    //    synthesize a content_block_start + tool_use pair here at
    //    block_index 0 of the current msg_id so the reducer has
    //    something to anchor the dialog to. The reducer's
    //    content_block_start is idempotent — if the real
    //    content_block_start arrives later, it's a no-op.
    //
    //    Only `can_use_tool` subtypes carry the tool-shape we need;
    //    other subtypes (set_model, set_permission_mode, interrupt,
    //    stop_task) are not dialog-driving and skipped.
    for (const [requestId, cr] of this.pendingControlRequests) {
      const request = cr.request as Record<string, unknown> | undefined;
      const subtype = request?.subtype as string | undefined;
      if (subtype !== "can_use_tool" || !request) continue;
      const toolName = (request.tool_name as string) || "";
      const toolUseId = (request.tool_use_id as string) || "";
      const toolInput =
        (request.input as Record<string, unknown>) || {};
      const isQuestion = toolName === "AskUserQuestion";
      // Defensive synthesis: only fire if the tool wasn't already
      // re-emitted in step 2 (its tool_use_id isn't in any block of
      // any msg_id).
      let toolAlreadyEmitted = false;
      for (const blocks of turn.messageBlocks.values()) {
        if (blocks.some((b) => b.kind === "tool_use" && b.toolUseId === toolUseId)) {
          toolAlreadyEmitted = true;
          break;
        }
      }
      if (!toolAlreadyEmitted && toolUseId !== "" && msgId !== "") {
        writeLine({
          type: "content_block_start",
          msg_id: msgId,
          block_index: 0,
          kind: "tool_use",
          tool_use_id: toolUseId,
          tool_name: toolName,
          ipc_version: 2,
        });
        writeLine({
          type: "tool_use",
          msg_id: msgId,
          seq: this.nextSeq(),
          tool_name: toolName,
          tool_use_id: toolUseId,
          input: toolInput,
          ipc_version: 2,
        });
      }
      writeLine({
        type: "control_request_forward",
        request_id: requestId,
        tool_name: toolName,
        input: toolInput,
        decision_reason: request.decision_reason as string | undefined,
        permission_suggestions: request.permission_suggestions as
          | unknown[]
          | undefined,
        blocked_path: request.blocked_path as string | undefined,
        tool_use_id: request.tool_use_id as string | undefined,
        is_question: isQuestion,
        ipc_version: 2,
      });
    }

    // 5. Terminal event — only fires if the turn already finished
    //    while suppressed. Live turns (gotResult=false, interrupted=false)
    //    skip this; the drain's post-suppression dispatch will emit
    //    the real `turn_complete` when claude's `result` lands.
    if (turn.gotResult) {
      writeLine({
        type: "turn_complete",
        msg_id: msgId,
        seq: this.nextSeq(),
        result: "success",
        ipc_version: 2,
      });
    } else if (turn.interrupted) {
      writeLine({
        type: "turn_cancelled",
        msg_id: msgId,
        seq: this.nextSeq(),
        partial_result: turn.partialText.length > 0
          ? turn.partialText
          : "User interrupted",
        ipc_version: 2,
      });
    }
  }

  /**
   * Drain-EOF handler. Called once when claude's stdout closes (EOF
   * or read error). If no turn was active, nothing is emitted — the
   * `early-exit watcher` covers process-exit lifecycle separately.
   * If a turn was active, emit the canonical end-of-stream IPC frame
   * (`turn_cancelled` if the user had interrupted, `error` otherwise)
   * and resolve the turn's completion promise so `handleUserMessage`
   * returns.
   */
  private signalEofToActiveTurn(): void {
    // Latch the flag before any branch — handleUserMessage's
    // fast-path read after this point must see "EOF observed."
    this.claudeStdoutEofObserved = true;
    // The turn (if any) is ending on this EOF — disarm the liveness watchdog
    // so a stale timer can't fire against a closed turn.
    this.clearResultWatchdog();
    // claude's stdout is gone: no follow-on turn will ever be
    // bracketed, so drop any still-queued inputs rather than let a
    // respawn's drain claim them for an unrelated turn.
    this.pendingTurnInputs.length = 0;
    const turn = this.activeTurn;
    if (turn === null) {
      logSessionLifecycle("tugcode.claude_stdout_eof", {
        session_id: this.sessionId,
      });
      return;
    }
    // Gate sites 6 & 7. The EOF emit is held back during the
    // suppressed window — a claude crash mid-replay would otherwise
    // race the bracket. emitInflightTurnFromActiveTurn re-synthesizes
    // the right terminal event (turn_complete for gotResult,
    // turn_cancelled for interrupted) from latched state so the
    // bracket delivers a complete TurnEntry even if the drain dies.
    if (turn.interrupted) {
      if (!turn.suppressEmit) {
        writeLine({
          type: "turn_cancelled",
          msg_id: turn.currentMessageId ?? turn.openerId,
          seq: turn.seq,
          partial_result: turn.partialText || "User interrupted",
          ipc_version: 2,
        });
      }
    } else if (!turn.gotResult) {
      if (!turn.suppressEmit) {
        writeLine({
          type: "error",
          message: "Claude process stream ended unexpectedly",
          recoverable: true,
          ipc_version: 2,
        });
      }
    }
    turn.finish();
    // Trailing activity flush ([Q06]) before the slot clears — the final
    // bin's work (including a turn that ends within a bin via EOF/interrupt)
    // still reports.
    this.flushActivity(turn);
    // Turn ownership is drain-bounded: clear the slot now the turn is
    // finished. `handleUserMessage` no longer clears it — it no longer
    // owns the turn lifecycle.
    this.activeTurn = null;
  }

  /**
   * Handle user_message: forward the inbound content blocks to
   * claude's stdin verbatim (the wire shape IS the API shape post-
   * Step-5c — no construction). If no turn is running, open the
   * `ActiveTurn` for it and await its completion; if a turn is
   * already in flight, queue the message in {@link pendingTurnInputs}
   * and return — claude buffers it and the stdout drain opens its
   * follow-on turn. Turn ownership is drain-bounded: one `ActiveTurn`
   * per claude `result`, never one per `handleUserMessage` call.
   */
  async handleUserMessage(msg: UserMessage): Promise<void> {
    // A new turn will grow the JSONL — drop the cached `/rewind` preview read
    // so the next preview reflects it ([#step-7-3]).
    this.rewindPreviewJsonl = null;
    // Step R0d cold-boot order may dispatch handleUserMessage before
    // `spawnClaudeAndWatch()` has finished its synchronous setup —
    // i.e., the user typed and submitted while replay was still
    // streaming events. The readiness gate established in
    // `prepareSession()` blocks until the spawn has completed, so the
    // first claude stdin write here is sequenced correctly. After
    // the gate resolves it stays resolved; subsequent submits await
    // it as a no-op.
    if (this.claudeReadyPromise !== null) {
      await this.claudeReadyPromise;
    }
    // A respawn in flight owns the process slot; the message is for the
    // claude it seats, not the one it is retiring.
    while (this.respawnGate !== null) {
      await this.respawnGate;
    }

    if (!this.claudeProcess) {
      throw new Error("Session not initialized");
    }

    // Fast-path: the drain already observed claude's stdout
    // closing. Installing an `ActiveTurn` here would block on a
    // completion promise nothing will ever resolve. Emit the
    // canonical end-of-stream error frame and return — same shape
    // pre-R1e's read-loop emitted when its `readNextLine` returned
    // null on the first iteration.
    if (this.claudeStdoutEofObserved) {
      writeLine({
        type: "error",
        message: "Claude process stream ended unexpectedly",
        recoverable: true,
        ipc_version: 2,
      });
      return;
    }

    // Forward the inbound content blocks directly to claude. The
    // wire shape IS the Anthropic API shape post-Step-5c; no
    // construction step. Per [Step 5c](dash/dev-atoms.md#step-5c).
    const contentBlocks = msg.content;

    const userInput = JSON.stringify({
      type: "user",
      session_id: "",
      message: {
        role: "user",
        content: contentBlocks,
      },
      parent_tool_use_id: null,
    }) + "\n";
    const stdin = this.claudeProcess.stdin;
    stdin.write(userInput);
    stdin.flush();
    // Claude has now received input from us, so it has been seen alive
    // end-to-end. The early-exit watcher reads this flag to gate its
    // init-failure classification: any exit from this point on is a
    // runtime crash (handled by the stream-end branch in
    // `signalEofToActiveTurn`), not a resume_failed.
    this.claudeReceivedInput = true;

    // Turn ownership is drain-bounded — one `ActiveTurn` per claude
    // `result`. If no turn is running and nothing is queued ahead of
    // this message, it starts a turn: open the `ActiveTurn` now so an
    // immediate `runReplay` adopts a live turn and the pre-claude
    // submission window brackets exactly as before, then await the
    // drain bracketing it (`result`) or claude's stdout EOFing.
    //
    // If a turn IS already in flight (or messages are queued ahead),
    // claude buffers this message and runs it as a follow-on turn with
    // its own `result`. Queue it; the stdout drain opens its
    // `ActiveTurn` when claude's events for it arrive (see
    // `handleClaudeLine`). Queuing — never installing a second
    // `ActiveTurn` here — is the fix for the overlapping-turn routing
    // bug: a second install would clobber the running turn's slot and
    // strand both turns' events.
    //
    // The turn's `currentMessageId` slot is null until claude reveals
    // its `message.id` on the first stream event. `userText` /
    // `userAttachments` are the source of truth for the in-flight
    // turn's `add_user_message` payload during a mid-turn
    // `runReplay`.
    if (this.activeTurn === null && this.pendingTurnInputs.length === 0) {
      const turn = new ActiveTurn(
        this.nextSeq(),
        msg.content,
      );
      this.activeTurn = turn;
      // The drain clears `this.activeTurn` when it brackets the turn;
      // this await only lets callers that sequence on turn completion
      // (the tests, any future awaiting caller) observe it.
      await turn.completion;
    } else {
      this.pendingTurnInputs.push({
        content: msg.content,
      });
    }
  }

  /**
   * Handle tool_approval: send control_response to claude stdin per D05/D06.
   * Uses "behavior" not "decision" per PN-1.
   *
   * Allow scope: when the user picked a durable scope the chosen
   * `permission_suggestions` entry rides back as `msg.updatedPermissions`
   * and is forwarded as the SDK `updatedPermissions`, so the CLI writes
   * the rule at its `destination`. A plain "Allow once" carries none.
   *
   * Deny message: the SDK passes our `message` string verbatim into the
   * `tool_result.content` the AI sees. A short string like "User denied"
   * leaves the AI without the canonical STOP directive — verified in a
   * 2026-05-23 session where the AI saw "User denied" and proceeded to
   * fire AskUserQuestion instead of halting. The SDK's canonical
   * rejection text (which its own built-in interactive prompts send)
   * is what the AI is trained to honor: "STOP what you are doing and
   * wait for the user to tell you how to proceed." So this is the
   * default when the caller doesn't supply a custom message.
   */
  handleToolApproval(msg: ToolApproval): void {
    if (!this.claudeProcess) {
      console.error("handleToolApproval called with no active claude process");
      return;
    }

    const pending = this.pendingControlRequests.get(msg.request_id);
    if (!pending) {
      console.error(`No pending control_request for request_id: ${msg.request_id}`);
      return;
    }

    const stdin = this.claudeProcess.stdin;
    const pendingRequest = pending.request as Record<string, unknown> | undefined;
    const originalInput = (pendingRequest?.input as Record<string, unknown>) || {};

    if (msg.decision === "allow") {
      const response = formatPermissionAllow(
        msg.request_id,
        msg.updatedInput || originalInput,
        msg.updatedPermissions,
      );
      sendControlResponse(stdin, response);
    } else {
      const response = formatPermissionDeny(
        msg.request_id,
        msg.message || CANONICAL_PERMISSION_DENY_MESSAGE,
      );
      sendControlResponse(stdin, response);
    }

    this.pendingControlRequests.delete(msg.request_id);
  }

  /**
   * Handle question_answer: send control_response with answers per D05.
   */
  handleQuestionAnswer(msg: QuestionAnswer): void {
    if (!this.claudeProcess) {
      console.error("handleQuestionAnswer called with no active claude process");
      return;
    }

    const pending = this.pendingControlRequests.get(msg.request_id);
    if (!pending) {
      console.error(`No pending control_request for request_id: ${msg.request_id}`);
      return;
    }

    const stdin = this.claudeProcess.stdin;
    const pendingRequest = pending.request as Record<string, unknown> | undefined;
    const originalInput = (pendingRequest?.input as Record<string, unknown>) || {};

    const response = formatQuestionAnswer(
      msg.request_id,
      originalInput,
      msg.answers,
      msg.response,
    );
    sendControlResponse(stdin, response);

    this.pendingControlRequests.delete(msg.request_id);
  }

  /**
   * Handle interrupt: send interrupt control_request per D07.
   *
   * Marks the active turn (if any) as interrupted so the stdout
   * drain's `signalEofToActiveTurn` path emits `turn_cancelled`
   * rather than `error` if claude tears down before responding.
   * The flag is per-turn (lives on `ActiveTurn`); a stale interrupt
   * arriving when no turn is active is a no-op.
   *
   * `retract` marks the interrupt as a pull-back (the client's CASE A
   * pull-down): once the turn closes, the aborted prompt must leave
   * claude's history entirely, not merely stop. The SDK has no live
   * verb for this — its `interrupt` keeps the prompt in the session
   * JSONL and appends an `"[Request interrupted by user]"` marker — so
   * the turn is flagged and the close hook
   * ({@link maybeScheduleRetraction}) runs the conversation-rewind
   * truncation anchored at the turn's own prompt record.
   */
  handleInterrupt(retract: boolean = false): void {
    if (!this.claudeProcess) {
      console.log("No active claude process to interrupt");
      return;
    }

    console.log(
      `Interrupting current turn via control_request interrupt${retract ? " (retract)" : ""}`,
    );
    if (this.activeTurn !== null) {
      this.activeTurn.interrupted = true;
      if (retract) this.activeTurn.retractRequested = true;
    }
    const stdin = this.claudeProcess.stdin;
    sendControlRequest(stdin, generateRequestId(), { subtype: "interrupt" });
    // The in-band interrupt is the graceful path — a healthy claude ends the
    // turn and emits `result`. Arm the escalation ladder so a wedged claude
    // that never services the request still gets force-terminated: the user's
    // cancel must always win.
    if (this.activeTurn !== null) {
      this.armInterruptEscalation(this.activeTurn);
    }
  }

  /**
   * Handle permission_mode: update local permission manager and notify the CLI.
   * Sends a set_permission_mode control_request to the running CLI process so
   * it can apply the new mode without restarting.
   */
  handlePermissionMode(msg: PermissionModeMessage): void {
    console.log(`Setting permission mode: ${msg.mode}`);
    this.permissionManager.setMode(msg.mode);

    // Also notify the CLI process of the mode change.
    if (this.claudeProcess) {
      const stdin = this.claudeProcess.stdin;
      sendControlRequest(stdin, generateRequestId(), {
        subtype: "set_permission_mode",
        mode: msg.mode,
      });
    }
  }

  /**
   * Handle stop_task: send stop_task control_request to claude stdin per §2e.
   */
  handleStopTask(taskId: string): void {
    if (!this.claudeProcess) {
      console.log("No active claude process for stop_task");
      return;
    }
    const stdin = this.claudeProcess.stdin;
    sendControlRequest(stdin, generateRequestId(), { subtype: "stop_task", task_id: taskId });
  }

  /**
   * Handle a `/btw` side question: forward it as a `side_question`
   * control-request on claude's stdin, reusing the client's `request_id` as
   * the control `request_id` so the whole round-trip is keyed by one id. The
   * `control_response` is correlated turn-free in
   * {@link trySideQuestionControlResponse}, so this works idle or mid-turn.
   * Claude applies the side-question semantics itself (system-reminder
   * framing, tool suppression, cache reuse, history exclusion) — tugcode is
   * transport only ([P01]).
   */
  handleSideQuestion(msg: SideQuestion): void {
    if (!this.claudeProcess) {
      console.log("No active claude process for side_question");
      this.emitSideQuestionAnswer(msg.request_id, null, false);
      return;
    }
    this.pendingSideQuestions.set(msg.request_id, { question: msg.question });
    sendControlRequest(this.claudeProcess.stdin, msg.request_id, {
      subtype: "side_question",
      question: msg.question,
    });
  }

  /** Emit a {@link SideQuestionAnswer} frame (overlay-only; see [P05]). */
  private emitSideQuestionAnswer(
    requestId: string,
    answer: string | null,
    synthetic: boolean,
  ): void {
    const frame: SideQuestionAnswer = {
      type: "side_question_answer",
      tug_session_id: this.sessionId,
      request_id: requestId,
      answer,
      synthetic,
      ipc_version: 2,
    };
    writeLine(frame);
  }

  /**
   * Handle model change: record the selector, then send a `set_model`
   * control_request to the live claude.
   *
   * The record comes FIRST, above the no-process bail, for two reasons. A
   * model chosen before claude is up must still reach the first spawn (the
   * shape {@link handleEffortChange} already uses). And when the user commits
   * a model and an effort together, the effort's respawn follows this frame
   * immediately — the respawn reads {@link currentModel}, not the control
   * request, so the record must be written before the process it describes is
   * killed.
   *
   * The `default` selector records as `null`: it names no particular model,
   * so the honest expression of it is the absence of a `--model` flag.
   */
  handleModelChange(model: string): void {
    this.currentModel = model === "default" ? null : model;
    if (!this.claudeProcess) {
      console.log("No active claude process for model change");
      return;
    }
    const stdin = this.claudeProcess.stdin;
    sendControlRequest(stdin, generateRequestId(), { subtype: "set_model", model });
  }

  /**
   * True when no turn is in flight — the precondition for a
   * `rewind_files` control request ([#step-7-1]). claude services a
   * `rewind_files` request turn-free; issuing one mid-turn races the
   * in-flight agent loop against a working-tree mutation, so the rewind
   * verbs gate on this. A turn that has latched `gotResult`/`interrupted`
   * is finished from the bridge's view even before the drain clears the
   * slot, so it counts as idle.
   */
  private isClaudeIdle(): boolean {
    return (
      this.activeTurn === null ||
      this.activeTurn.gotResult ||
      this.activeTurn.interrupted
    );
  }

  /**
   * Read the live session's on-disk JSONL — canonicalizing the project dir
   * the way claude names its per-session file (`realpath`, since claude
   * resolves symlinks). Used by the `/rewind` conversation checks.
   */
  private async readLiveSessionJsonl(): Promise<JsonlReadResult> {
    const liveId = this.resumeSessionId ?? this.sessionId;
    let canonicalProjectDir = this.projectDir;
    try {
      canonicalProjectDir = await realpath(this.projectDir);
    } catch {
      // Unresolvable (test fixture / deleted dir) — fall back to raw.
    }
    return this.jsonlReader(
      jsonlPathFor(this.claudeProjectsRoot, canonicalProjectDir, liveId),
    );
  }

  /** Cached JSONL read for the `/rewind` preview batch (see
   *  {@link rewindPreviewJsonl}). */
  private readSessionJsonlForPreview(): Promise<JsonlReadResult> {
    if (this.rewindPreviewJsonl === null) {
      this.rewindPreviewJsonl = this.readLiveSessionJsonl();
    }
    return this.rewindPreviewJsonl;
  }

  /**
   * Handle `rewind_preview` ([#step-7-1]/[#step-7-3]): issue a
   * `rewind_files{dry_run:true}` control request for the turn anchored at
   * `promptUuid` (the picker's per-row code diff-stat) AND determine whether
   * the CONVERSATION dimension can rewind to that anchor — by running the same
   * `computeConversationTruncation` "ok" check the apply path uses against the
   * session JSONL. Both ride back on the one `rewind_preview_result`, so the
   * picker can show the diff-stat and disable any turn whose conversation
   * rewind would cross a `/compact` boundary (or otherwise error).
   */
  async handleRewindPreview(msg: RewindPreview): Promise<void> {
    if (!this.claudeProcess) {
      this.emitRewindPreviewResult(msg.promptUuid, {
        canRewind: false,
        error: "No active claude process.",
      });
      return;
    }
    if (!this.isClaudeIdle()) {
      // Idle gating: a `rewind_files` request mid-turn is rejected; the
      // session-card ([#step-7-3]) reflects the busy state and retries when
      // the turn completes.
      this.emitRewindPreviewResult(msg.promptUuid, {
        canRewind: false,
        error: "Claude is busy; rewind preview requires an idle session.",
      });
      return;
    }
    // Conversation-rewindability from the (cached) JSONL — same condition the
    // apply-time guard enforces. Default true if the JSONL can't be read (the
    // apply path will still refuse if needed; the picker just won't pre-disable).
    let conversationRewindable = true;
    const read = await this.readSessionJsonlForPreview();
    if (read.kind === "ok") {
      conversationRewindable =
        computeConversationTruncation(read.jsonl, msg.promptUuid).kind === "ok";
    }
    // Non-rewindable anchor (crosses a /compact, etc.): the picker hides this
    // row, so the code diff-stat is never shown — skip the `rewind_files`
    // round-trip to claude entirely and answer from the JSONL alone. This also
    // bounds the dry-run calls to the rewindable window (no claude traffic for
    // the pre-compaction turns).
    if (!conversationRewindable) {
      this.emitRewindPreviewResult(msg.promptUuid, {
        canRewind: false,
        conversationRewindable: false,
      });
      return;
    }
    // Re-check liveness after the await — a turn could have opened. If so,
    // reject rather than issue a mid-turn control request.
    if (!this.claudeProcess || !this.isClaudeIdle()) {
      this.emitRewindPreviewResult(msg.promptUuid, {
        canRewind: false,
        error: "Claude is busy; rewind preview requires an idle session.",
        conversationRewindable,
      });
      return;
    }
    const requestId = generateRequestId();
    this.pendingRewindRequests.set(requestId, {
      promptUuid: msg.promptUuid,
      kind: "preview",
      conversationRewindable,
    });
    sendControlRequest(this.claudeProcess.stdin, requestId, {
      subtype: "rewind_files",
      user_message_id: msg.promptUuid,
      dry_run: true,
    });
  }

  /**
   * Handle `session_rewind` ([#step-7-1]/[#step-7-2]) — the two restore
   * dimensions of `/rewind`, applied to an idle session.
   *
   * - **code** (`scope:"code"`, and the code leg of `"both"`) → a
   *   `rewind_files{dry_run:false}` control request reverts the working-tree
   *   files claude edited since the anchor turn ([#step-7-1]).
   * - **conversation** (`scope:"conversation"`, and the conversation leg of
   *   `"both"`) → truncate the session JSONL at the anchor + silent
   *   `--resume` respawn, forking by default ([#step-7-2]).
   * - **both** → code restore FIRST on the live session (it reverts files
   *   via the live `fileHistory`), THEN the conversation rewind. If the code
   *   restore fails, the conversation leg is skipped and the failure is
   *   reported — never a partial restore.
   *
   * A single `rewind_result` ack reports the combined outcome (carrying the
   * fork's `newSessionId` when applicable).
   */
  async handleSessionRewind(msg: SessionRewind): Promise<void> {
    const restoresCode = msg.scope === "code" || msg.scope === "both";
    const restoresConversation =
      msg.scope === "conversation" || msg.scope === "both";

    if (!this.claudeProcess) {
      this.emitRewindResult(msg.promptUuid, msg.scope, {
        canRewind: false,
        error: "No active claude process.",
      });
      return;
    }
    if (!this.isClaudeIdle()) {
      this.emitRewindResult(msg.promptUuid, msg.scope, {
        canRewind: false,
        error: "Claude is busy; rewind requires an idle session.",
      });
      return;
    }

    // Code dimension first (live session, working-tree revert). For
    // `scope:"both"` a failed code restore aborts before the conversation
    // leg so the two dimensions never diverge.
    if (restoresCode) {
      const codeResult = await this.applyCodeRewind(msg.promptUuid);
      if (!codeResult.canRewind) {
        this.emitRewindResult(msg.promptUuid, msg.scope, codeResult);
        return;
      }
      if (!restoresConversation) {
        this.emitRewindResult(msg.promptUuid, msg.scope, codeResult);
        return;
      }
    }

    // Conversation dimension (JSONL truncate + silent respawn, fork default).
    const convResult = await this.applyConversationRewind(
      msg.promptUuid,
      msg.fork ?? true,
    );
    this.emitRewindResult(msg.promptUuid, msg.scope, convResult);
  }

  /**
   * Issue the code-restore `rewind_files{dry_run:false}` control request and
   * resolve once its `control_response` correlates ([#step-7-1]/[#step-7-2]).
   * Promisified so {@link handleSessionRewind} can sequence
   * `scope:"both"` (code, then conversation) and emit a single ack.
   */
  private applyCodeRewind(
    promptUuid: string,
  ): Promise<{ canRewind: boolean; error?: string }> {
    return new Promise((resolve) => {
      if (!this.claudeProcess) {
        resolve({ canRewind: false, error: "No active claude process." });
        return;
      }
      const requestId = generateRequestId();
      this.pendingRewindRequests.set(requestId, {
        promptUuid,
        kind: "apply",
        scope: "code",
        resolve,
      });
      sendControlRequest(this.claudeProcess.stdin, requestId, {
        subtype: "rewind_files",
        user_message_id: promptUuid,
        dry_run: false,
      });
    });
  }

  /**
   * Hold the rewind open until its respawned claude has loaded ([#step-7-2]).
   *
   * The rewind ack is the client's whole signal: the `/rewind` sheet stays
   * modal, showing indeterminate progress, from the Rewind press until the
   * ack lands. So the ack has to mean "the session is ready", not "a process
   * was launched" — a `--resume` against a rewound conversation reads its
   * JSONL back in for seconds after `spawnClaude` returns, and dismissing the
   * sheet into that window hands the card back before it can answer.
   *
   * The proof is the `initialize` handshake ack, the same one every other
   * spawn path uses. It is dispatched here directly rather than through
   * {@link sendInitializeHandshake}: that path's {@link
   * RESUME_INITIALIZE_DELAY_MS} health gate exists to avoid writing into a
   * `--resume` that is about to die on a stale id, and this id is not stale —
   * we just wrote the file ourselves. Waiting out the gate would only add two
   * seconds of barber pole. The wait itself is bounded ({@link
   * REWIND_READY_TIMEOUT_MS}), and an unproven spawn still acks: the rewind
   * landed on disk either way.
   */
  private async provePostRewindSpawnReady(
    child: ClaudeSubprocess,
  ): Promise<void> {
    // `killAndCleanup` latched the teardown flag; the fresh spawn is not
    // shutting down (same clearing as `forceTerminateAndRespawn`).
    this.isShuttingDown = false;
    this.dispatchInitializeHandshake(child);
    await this.awaitSpawnReady(child, REWIND_READY_TIMEOUT_MS);
  }

  /**
   * Conversation rewind ([#step-7-2]): truncate the session JSONL at the
   * `promptUuid` anchor and silent-respawn `--resume` to reload the rewound
   * context for the next turn — resolving only once that respawn has proven
   * it loaded ({@link provePostRewindSpawnReady}), so the ack the client
   * waits on says "ready" rather than merely "launched". NOT a replay
   * rebuild — the respawn emits no
   * transcript (the session-card truncates its own store locally, [#step-7-3]),
   * so survivors keep their mount identity ([L26]).
   *
   * `fork` (the default) preserves the original session: it copies the
   * truncated history into a freshly-minted claude session id and resumes
   * THAT, returning `newSessionId` for the card→session rebind (so a
   * cold-boot resumes the fork, not the untruncated original). The
   * destructive in-place variant (`fork:false`) truncates the live session's
   * own JSONL — a pre-truncation snapshot is kept so a failed respawn rolls
   * back.
   *
   * Concurrency: the truncate happens only while the claude subprocess is
   * DOWN (between {@link killAndCleanup} and the resume spawn), so there is
   * no write race against claude. A `/compact` boundary in the chop range,
   * a missing JSONL, or an unknown anchor all refuse cleanly rather than
   * corrupt the session.
   */
  private async applyConversationRewind(
    promptUuid: string,
    fork: boolean,
  ): Promise<{ canRewind: boolean; error?: string; newSessionId?: string }> {
    const liveId = this.resumeSessionId ?? this.sessionId;

    // Resolve the on-disk JSONL the same way runReplay does — claude names
    // its per-session file after the canonicalized cwd.
    let canonicalProjectDir = this.projectDir;
    try {
      canonicalProjectDir = await realpath(this.projectDir);
    } catch {
      // Unresolvable (test fixture / deleted dir) — fall back to raw; the
      // reader reports `missing` if the path doesn't exist.
    }
    const livePath = jsonlPathFor(
      this.claudeProjectsRoot,
      canonicalProjectDir,
      liveId,
    );

    const read = await this.jsonlReader(livePath);
    if (read.kind !== "ok") {
      return {
        canRewind: false,
        error: `Could not read session JSONL (${read.message}).`,
      };
    }

    const truncation = computeConversationTruncation(read.jsonl, promptUuid);
    if (truncation.kind === "not_found") {
      return {
        canRewind: false,
        error: "Rewind anchor not found in this session.",
      };
    }
    if (truncation.kind === "compaction_blocked") {
      return {
        canRewind: false,
        error:
          "Cannot rewind across a /compact boundary; the conversation was compacted after this turn.",
      };
    }
    if (truncation.kind === "no_retained_turns") {
      return {
        canRewind: false,
        error:
          "Cannot rewind to the first turn (it would leave an empty, unresumable session); start a new session instead.",
      };
    }

    const lines = read.jsonl.split("\n");
    const truncated = lines.slice(0, truncation.boundary).join("\n") + "\n";

    // Destructive in-place rewind only: refuse while a live process
    // other than our own claude child holds this session (a terminal
    // resumed it after this card opened it). Truncating under a live
    // holder yanks history out from under its in-memory conversation.
    // Fork mode stays ungated — it only writes a brand-new file.
    if (!fork) {
      const ownPid = this.claudeProcess?.pid;
      const held = isSessionHeldByOtherProcess(liveId, {
        excludePids: ownPid !== undefined ? [ownPid] : [],
      });
      if (held) {
        return {
          canRewind: false,
          error:
            "This session is open in a terminal; rewinding in place would truncate it out from under that process. Close it there and retry.",
        };
      }
    }

    // Subprocess DOWN before any disk write — no race against claude.
    await this.killAndCleanup();

    if (fork) {
      // Copy the truncated history under a fresh id; the original `livePath`
      // is left intact. The new id is known synchronously (we mint it), so
      // the ack + the rebind don't depend on claude's first-input init.
      const newId = crypto.randomUUID();
      const forkPath = jsonlPathFor(
        this.claudeProjectsRoot,
        canonicalProjectDir,
        newId,
      );
      try {
        await this.jsonlWriter(forkPath, truncated);
      } catch (err) {
        return {
          canRewind: false,
          error: `Could not write forked session (${err instanceof Error ? err.message : String(err)}).`,
        };
      }
      // Announce the parentage BEFORE the synthetic `session_init` that
      // records the spawn: tugcast transfers the parent's callsign to the fork
      // and stages it, so the fork is recorded as the same line of work rather
      // than as an unrelated fresh pair. The rewound-to prompt uuid is the
      // branch point.
      writeLine({
        type: "session_fork",
        parentSessionId: liveId,
        newSessionId: newId,
        forkPoint: promptUuid,
      });
      // Point the manager at the fork for this and every later (re)spawn,
      // and tell tugcast so the card→session binding is rebound + persisted
      // (a cold-boot then resumes the truncated fork, not the original).
      this.resumeSessionId = newId;
      const forked = this.spawnClaude(newId, "resume");
      this.claudeProcess = forked;
      this.startStdoutDrain(forked);
      this.writeSyntheticSessionInit(newId);
      await this.provePostRewindSpawnReady(forked);
      return { canRewind: true, newSessionId: newId };
    }

    // Destructive in-place: snapshot the full pre-truncation bytes so a
    // failed respawn can roll back, then overwrite the live JSONL.
    try {
      await this.jsonlWriter(livePath, truncated);
    } catch (err) {
      return {
        canRewind: false,
        error: `Could not truncate session (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
    try {
      const respawned = this.spawnClaude(liveId, "resume");
      this.claudeProcess = respawned;
      this.startStdoutDrain(respawned);
      await this.provePostRewindSpawnReady(respawned);
    } catch (err) {
      // Roll back the truncation so the session isn't left half-rewound.
      try {
        await this.jsonlWriter(livePath, read.jsonl);
      } catch {
        // Best-effort; the spawn failure is the reported error.
      }
      return {
        canRewind: false,
        error: `Respawn after rewind failed (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
    return { canRewind: true };
  }

  /**
   * Schedule the retraction of a just-closed turn's prompt
   * (`interrupt{retract:true}` — the client's CASE A pull-down). Runs
   * on a fresh tick: the close hook fires inside the stdout drain
   * loop, and the retraction kills the claude subprocess — deferring
   * lets the old drain observe EOF and exit on its own, the same
   * process-swap shape as an effort-change respawn.
   *
   * A retraction with no captured {@link ActiveTurn.promptUuid} is
   * skipped: the SDK never echoed the prompt record, so there is
   * nothing on disk to truncate (the escape beat the persist) — the
   * degenerate case IS the desired end state.
   */
  private maybeScheduleRetraction(turn: ActiveTurn): void {
    if (!turn.retractRequested) return;
    const promptUuid = turn.promptUuid;
    if (promptUuid === null) {
      console.log("Retraction skipped: no prompt uuid captured for the turn");
      return;
    }
    setTimeout(() => {
      this.applyPromptRetraction(promptUuid).catch((err) => {
        console.log(
          `Retraction failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, 0);
  }

  /**
   * Retract an aborted prompt from claude's history: truncate the
   * session JSONL at the prompt's record and silently respawn
   * `--resume` — the in-place leg of {@link applyConversationRewind},
   * anchored at the retracted prompt itself. `slice(0, boundary)`
   * semantics make the anchor the first record dropped, so the prompt,
   * the SDK's `"[Request interrupted by user]"` marker, and the
   * synthetic assistant stop all leave the file — the model's context
   * and any future replay match what the client already shows (the
   * CASE A pull-down removed the row locally at Escape time).
   *
   * Degrades to a plain interrupt (poison stays, honestly replayable)
   * rather than risking the session on every guard:
   *   - a follow-on turn opened at the close boundary (queued steering
   *     send) — retraction must never kill a live turn;
   *   - the prompt record never landed on disk (`not_found`);
   *   - the prompt is the session's first submission
   *     (`no_retained_turns` — truncation would leave an unresumable
   *     empty session);
   *   - a compaction raced into the chop range
   *     (`compaction_blocked`);
   *   - the session is held by another process (terminal resume) —
   *     guarded inside {@link applyConversationRewind}.
   */
  private async applyPromptRetraction(promptUuid: string): Promise<void> {
    if (!this.isClaudeIdle()) {
      console.log("Retraction skipped: a follow-on turn is already running");
      return;
    }
    const read = await this.readLiveSessionJsonl();
    if (read.kind !== "ok") {
      console.log(`Retraction skipped: could not read session JSONL (${read.message})`);
      return;
    }
    const truncation = computeConversationTruncation(read.jsonl, promptUuid);
    if (truncation.kind !== "ok") {
      console.log(`Retraction skipped: ${truncation.kind}`);
      return;
    }
    const result = await this.applyConversationRewind(promptUuid, false);
    if (!result.canRewind) {
      console.log(`Retraction skipped: ${result.error ?? "rewind refused"}`);
      return;
    }
    console.log(`Retracted prompt ${promptUuid} from session history`);
    logSessionLifecycle("tugcode.prompt_retracted", {
      session_id: this.sessionId,
      prompt_uuid: promptUuid,
    });
  }

  /**
   * Correlate a turn-free `control_response` against
   * {@link pendingRewindRequests} ([#step-7-1]). Returns `true` when the
   * response matched a pending rewind request (and was consumed into the
   * matching outbound IPC), `false` when it did not (the caller lets it
   * fall through). Mirrors the `initialize`-handshake correlation: the
   * `request_id` lives on the inner `response` object.
   */
  private tryHandleRewindControlResponse(
    event: Record<string, unknown>,
  ): boolean {
    const response = event.response as Record<string, unknown> | undefined;
    if (!response || typeof response !== "object") return false;
    const requestId = response.request_id as string | undefined;
    if (typeof requestId !== "string") return false;
    const pending = this.pendingRewindRequests.get(requestId);
    if (!pending) return false;
    this.pendingRewindRequests.delete(requestId);

    // The rewind payload is the doubly-nested `response.response`
    // ({canRewind, error?, filesChanged?, insertions?, deletions?}) per
    // the [#step-7a] envelope. A `subtype:"error"` or a missing inner
    // payload degrades to a non-rewindable result rather than throwing.
    const inner = response.response as Record<string, unknown> | undefined;
    const canRewind = inner?.canRewind === true;
    const error =
      typeof inner?.error === "string" ? (inner.error as string) : undefined;

    if (pending.kind === "preview") {
      const filesChanged = Array.isArray(inner?.filesChanged)
        ? (inner!.filesChanged as unknown[]).filter(
            (f): f is string => typeof f === "string",
          )
        : undefined;
      const insertions =
        typeof inner?.insertions === "number"
          ? (inner.insertions as number)
          : undefined;
      const deletions =
        typeof inner?.deletions === "number"
          ? (inner.deletions as number)
          : undefined;
      this.emitRewindPreviewResult(pending.promptUuid, {
        canRewind,
        error,
        filesChanged,
        insertions,
        deletions,
        conversationRewindable: pending.conversationRewindable,
      });
    } else {
      // Apply leg: hand the outcome to the awaiting
      // {@link applyCodeRewind} promise. The `rewind_result` ack is emitted
      // by {@link handleSessionRewind} once the full (possibly combined)
      // rewind completes — never here.
      pending.resolve({ canRewind, error });
    }
    return true;
  }

  /**
   * Correlate a turn-free `control_response` against
   * {@link pendingSideQuestions} (`/btw`). Returns `true` when the response
   * matched a pending side question (and was consumed into a
   * `side_question_answer` frame), `false` when it did not (the caller lets it
   * fall through). Mirrors the `initialize`/rewind correlation: the
   * `request_id` lives on the inner `response` object, and the settled answer
   * is doubly nested at `response.response.{response,synthetic}` (confirmed by
   * the #step-1 probe capture). Runs BEFORE turn routing so a mid-turn
   * response is caught the same way an idle one is (Risk R01).
   */
  private trySideQuestionControlResponse(
    event: Record<string, unknown>,
  ): boolean {
    const response = event.response as Record<string, unknown> | undefined;
    if (!response || typeof response !== "object") return false;
    const requestId = response.request_id as string | undefined;
    if (typeof requestId !== "string") return false;
    if (!this.pendingSideQuestions.has(requestId)) return false;
    this.pendingSideQuestions.delete(requestId);

    // Settled payload: `response.response = { response: string|null,
    // synthetic: boolean }`. A `subtype:"error"` or a missing inner payload
    // degrades to a null answer rather than throwing.
    const inner = response.response as Record<string, unknown> | undefined;
    const answer =
      typeof inner?.response === "string" ? (inner.response as string) : null;
    const synthetic = inner?.synthetic === true;
    this.emitSideQuestionAnswer(requestId, answer, synthetic);
    return true;
  }

  /** Emit a {@link RewindPreviewResult} ([#step-7-1]/[#step-7-3]). */
  private emitRewindPreviewResult(
    promptUuid: string,
    fields: {
      canRewind: boolean;
      error?: string;
      filesChanged?: string[];
      insertions?: number;
      deletions?: number;
      conversationRewindable?: boolean;
    },
  ): void {
    const msg: RewindPreviewResult = {
      type: "rewind_preview_result",
      promptUuid,
      canRewind: fields.canRewind,
      ...(fields.error !== undefined ? { error: fields.error } : {}),
      ...(fields.filesChanged !== undefined
        ? { filesChanged: fields.filesChanged }
        : {}),
      ...(fields.insertions !== undefined
        ? { insertions: fields.insertions }
        : {}),
      ...(fields.deletions !== undefined
        ? { deletions: fields.deletions }
        : {}),
      ...(fields.conversationRewindable !== undefined
        ? { conversationRewindable: fields.conversationRewindable }
        : {}),
      ipc_version: 2,
    };
    writeLine(msg);
  }

  /** Emit a {@link RewindResult} ack ([#step-7-1]/[#step-7-2]). */
  private emitRewindResult(
    promptUuid: string,
    scope: "conversation" | "code" | "both",
    fields: { canRewind: boolean; error?: string; newSessionId?: string },
  ): void {
    const msg: RewindResult = {
      type: "rewind_result",
      promptUuid,
      scope,
      canRewind: fields.canRewind,
      ...(fields.error !== undefined ? { error: fields.error } : {}),
      ...(fields.newSessionId !== undefined
        ? { newSessionId: fields.newSessionId }
        : {}),
      ipc_version: 2,
    };
    writeLine(msg);
  }

  /**
   * Handle reasoning-effort change ([#step-4], [R07]).
   *
   * claude 2.1.158 has NO live control subtype for effort — it is set only via
   * the `--effort` spawn flag — so unlike model / permission mode (which are
   * live `control_request`s) this must respawn claude with the new `--effort`
   * + `--resume <sessionId>`. The transcript survives the brief reconnect via
   * tugcast's resume/replay; the chip already reflects the change optimistically
   * (the client sent it before this frame). Records the level so every
   * subsequent (re)spawn — including the immediate one here — carries it and so
   * the next `session_capabilities` surfaces it.
   *
   * A no-op of the respawn when there is no live session id yet (nothing to
   * resume): the level is still recorded, so it takes effect on the next spawn.
   */
  /**
   * Run one respawn under {@link respawnGate}. Respawns queue behind one
   * another, and user messages queue behind all of them.
   */
  private async respawn<T>(work: () => Promise<T>): Promise<T> {
    while (this.respawnGate !== null) {
      await this.respawnGate;
    }
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.respawnGate = gate;
    try {
      return await work();
    } finally {
      if (this.respawnGate === gate) this.respawnGate = null;
      release();
    }
  }

  async handleEffortChange(effort: string): Promise<void> {
    return this.respawn(() => this.effortChange(effort));
  }

  private async effortChange(effort: string): Promise<void> {
    console.log(`Setting reasoning effort: ${effort}`);
    this.currentEffort = effort;

    // No conversation to resume yet — record the level and let the next spawn
    // pick it up via `buildClaudeArgs`.
    if (this.sessionId === null || this.sessionId === "") return;

    await this.killAndCleanup();
    const mode = this.liveRespawnMode();
    this.claudeProcess = this.spawnClaude(this.liveRespawnId(mode), mode);
    this.startStdoutDrain(this.claudeProcess);
    // The drain forwards claude's `system:init` to tugcast asynchronously, as
    // in `handleSessionFork` / `handleSessionContinue`; no synchronous await.
  }

  /**
   * Spawn mode for a live setting change (effort, add-dir) that must respawn
   * the current session in place: `--resume` when claude has a conversation on
   * disk to load, `--session-id` (re-create the id) when it does not.
   *
   * Claude writes a session's JSONL only once a turn lands, AND rejects
   * `--session-id` for an id that already exists ("is already in use"). So the
   * choice must match the on-disk reality on BOTH ends:
   *  - A session **resumed from disk** (`sessionMode === "resume"`) already has
   *    history — resume it. Re-creating it with `--session-id` collides.
   *  - A **fresh** session that has since committed a turn this process
   *    (`claudeReceivedInput`, set on the first user-message write) likewise has
   *    history — resume it.
   *  - A fresh session with **no** committed turn has nothing on disk — resume
   *    fails with "No conversation found", so re-create it under the same id
   *    (carrying the new setting) instead.
   *
   * Both wrong choices kill the process immediately; the next submit then hits
   * the stdout-EOF path and surfaces "Claude process stream ended unexpectedly".
   */
  private liveRespawnMode(): "resume" | "session-id" {
    return this.sessionMode === "resume" || this.claudeReceivedInput
      ? "resume"
      : "session-id";
  }

  /**
   * The claude id to (re)spawn against for a live-setting respawn: the resume
   * id (`resolveClaudeId()`, which honors a forked session's rotated claude id)
   * when resuming, or the tug session id when re-creating a fresh session.
   */
  private liveRespawnId(mode: "resume" | "session-id"): string {
    return mode === "resume" ? this.resolveClaudeId() : this.sessionId;
  }

  /**
   * Add a working directory to the session ([#step-13c]). Records the dir
   * (deduped) so every (re)spawn grants it via `--add-dir`, then respawns the
   * session in place to apply it now ({@link liveRespawnMode} picks `--resume`
   * vs `--session-id`) — the same shape as {@link handleEffortChange}, because
   * claude exposes no live add-directory control verb over the bridge. A blank
   * or already-present dir is a no-op (no needless respawn). Before the first
   * spawn (no `sessionId` yet) we just record it; the initial spawn picks it up
   * via `buildClaudeArgs`.
   */
  async handleAddDirectory(directory: string): Promise<void> {
    return this.respawn(() => this.addDirectory(directory));
  }

  private async addDirectory(directory: string): Promise<void> {
    const dir = directory.trim();
    if (dir === "" || this.additionalDirectories.includes(dir)) return;
    console.log(`Adding working directory: ${dir}`);
    this.additionalDirectories.push(dir);

    if (this.sessionId === null || this.sessionId === "") return;

    await this.killAndCleanup();
    const mode = this.liveRespawnMode();
    this.claudeProcess = this.spawnClaude(this.liveRespawnId(mode), mode);
    this.startStdoutDrain(this.claudeProcess);
  }

  /**
   * Fork the current session: kill current process, respawn with --continue --fork-session.
   * Per D10 (#d10-session-forking).
   */
  async handleSessionFork(): Promise<void> {
    return this.respawn(() => this.sessionFork());
  }

  private async sessionFork(): Promise<void> {
    await this.killAndCleanup();

    const claudePath = resolveClaudePath();
    if (!claudePath) throw new Error("claude CLI not found (PATH or ~/.local/bin)");

    const args = buildClaudeArgs({
      ...this.liveSpawnConfig(),
      sessionId: null,
      continue: true,
      forkSession: true,
    });

    this.claudeProcess = Bun.spawn([claudePath, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      cwd: this.projectDir,
    });
    this.startStdoutDrain(this.claudeProcess);
    // Post-R1e: the drain task forwards claude's `system:init` to
    // tugcast as a `session_init` IPC frame as soon as it arrives
    // (see {@link handleInterTurnEvent}). The handler does not
    // synchronously await readiness — `claudeProcess.stdin` buffers
    // any bytes the next `handleUserMessage` writes before claude
    // finishes its handshake, and the drain catches up in the
    // background. Pre-R1e the legacy `waitForSessionReady` await
    // existed because the pull-based reader could not run in the
    // background; that constraint is gone.
  }

  /**
   * Continue in a new session picking up conversation history.
   * Respawns with --continue per D10.
   */
  async handleSessionContinue(): Promise<void> {
    return this.respawn(() => this.sessionContinue());
  }

  private async sessionContinue(): Promise<void> {
    await this.killAndCleanup();

    const claudePath = resolveClaudePath();
    if (!claudePath) throw new Error("claude CLI not found (PATH or ~/.local/bin)");

    const args = buildClaudeArgs({
      ...this.liveSpawnConfig(),
      sessionId: null,
      continue: true,
    });

    this.claudeProcess = Bun.spawn([claudePath, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      cwd: this.projectDir,
    });
    this.startStdoutDrain(this.claudeProcess);
    // See `handleSessionFork` — the drain forwards claude's
    // `system:init` asynchronously; no synchronous await needed.
  }

  /**
   * Start a fresh session with no prior history.
   * Kills current process and respawns without --resume.
   *
   * `stage` is present only when the server-driven arc originated this
   * rotation. It does two things and nothing else: it records the arc name so
   * every spawn from here carries `TUG_DASH_ARC`, and it announces the fresh
   * session as lineage before the synthetic `session_init` — the placement
   * {@link rewindSession}'s fork announcement already uses, because the bridge
   * must stage the identity transfer before the `session_init` that consumes
   * it.
   *
   * With no stage the path is byte-identical to what a plain `/new` from the
   * deck emits today, and the arc record is *cleared* — the variable belongs
   * to an arc, not to a card.
   */
  async handleNewSession(stage?: SessionStageSpec): Promise<void> {
    return this.respawn(() => this.newSession(stage));
  }

  private async newSession(stage?: SessionStageSpec): Promise<void> {
    const parentSessionId = this.resolveClaudeId();
    await this.killAndCleanup();

    this.currentArc = stage?.arc ?? null;

    // Generate a new id for the fresh session and claim it with claude
    // via --session-id so downstream persistence and routing have a
    // stable identifier from spawn time forward.
    this.sessionId = crypto.randomUUID();
    this.claudeProcess = this.spawnClaude(this.sessionId, "session-id");
    this.startStdoutDrain(this.claudeProcess);
    if (stage) {
      writeLine({
        type: "session_stage",
        parentSessionId,
        newSessionId: this.sessionId,
        stage: stage.name,
        model: this.currentModel ?? "",
        document: stage.document,
        arc: stage.arc,
        steps: stage.steps,
        ...(stage.prompt !== undefined ? { prompt: stage.prompt } : {}),
        ipc_version: 2,
      });
    }
    // Synthesize a session_init for tugcast immediately — the
    // claude id is known synchronously here (we minted it above), so
    // no need to wait for claude's own emission.
    writeLine({ type: "session_init", session_id: this.sessionId, ipc_version: 2 });
  }

  /**
   * Dispatch a session command to the appropriate session management method.
   */
  async handleSessionCommand(
    command: "fork" | "continue" | "new",
    stage?: SessionStageSpec,
  ): Promise<void> {
    switch (command) {
      case "fork":
        return this.handleSessionFork();
      case "continue":
        return this.handleSessionContinue();
      case "new":
        return this.handleNewSession(stage);
    }
  }

  /**
   * Public shutdown: close stdin and kill the process gracefully.
   * Called from `main.ts`'s quiesce path. Also closes the read-only
   * sessions.db handle so the file lock is released before any temp
   * teardown the OS / test fixtures may run.
   *
   * `graceMs` bounds how long a healthy claude gets to exit on its own
   * after EOF. Shutdown passes the `tug-quiesce` flush budget: waiting
   * out the full respawn-sized grace is what used to push tugcode past
   * the conductor's drain deadline and earn it a SIGKILL.
   */
  async shutdown(opts?: { graceMs?: number }): Promise<void> {
    this.closeSessionsDb();
    await this.killAndCleanup({ graceMs: opts?.graceMs });
  }

  /**
   * Upsert the record for this session into `dev.tugtool.dev /
   * sessions`. Keyed by the session id (which claude uses as its own
   * session id and tugcast uses for feed routing — a single identifier
   * across the stack). Value shape:
   *
   *   `{ [sessionId]: { projectDir, createdAt } }`
   *
   * `createdAt` is the epoch-ms timestamp the session was first
   * recorded. Resume keeps the existing `createdAt`; the picker sorts
   * by it to show the newest session first for a given project.
   */
  /**
   * Resolve the tugplug plugin directory for `--plugin-dir`. Delegates to the
   * shared app-level {@link resolvePluginDir} so the context-breakdown emitter
   * (`main.ts`) and the spawn agree on the (universal) plugin dir.
   */
  private getPluginDir(): string {
    return resolvePluginDir();
  }
}

// Session journals on disk: claude's JSONL transcripts (paths, reading,
// conversation-rewind truncation, background-agent transcripts), the
// location of tugcast's session ledger, and the content blocks rebuilt from
// its legacy `turns` journal columns.

import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import type { Attachment, ContentBlock } from "./types.ts";
import type { ClaudeHome } from "./claude-home.ts";
import type {
  JsonlEntry,
  SubagentTranscript,
  SubagentTranscriptMeta,
} from "./replay.ts";

// ---------------------------------------------------------------------------
// Image attachment validation constants (per PN-12)
// ---------------------------------------------------------------------------

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // ~5MB decoded

/**
 * Resolve the on-disk JSONL path for a given resume target.
 *
 *   `<projects>/<encodeProjectDir(projectDir)>/<id>.jsonl`
 */
export function jsonlPathFor(
  claudeHome: ClaudeHome,
  projectDir: string,
  claudeSessionId: string,
): string {
  return join(claudeHome.projectDir(projectDir), `${claudeSessionId}.jsonl`);
}

/**
 * Resolve the directory holding a session's background-agent transcripts.
 * Claude Code writes them beside the main JSONL, under a directory named
 * by the session id (no `.jsonl` suffix):
 *
 *   `<projects>/<encodeProjectDir(projectDir)>/<id>/subagents`
 *
 * Each async `Agent` launch persists `agent-<agentId>.jsonl` (the agent's
 * full transcript) + `agent-<agentId>.meta.json` (the launching
 * `tool_use.id` + display fields) here.
 */
export function subagentsDirFor(
  claudeHome: ClaudeHome,
  projectDir: string,
  claudeSessionId: string,
): string {
  return join(claudeHome.projectDir(projectDir), claudeSessionId, "subagents");
}

/**
 * Default on-disk location of the tugcast SessionLedger database.
 *
 * `sessions.db` is **per-instance**, and the instance is tugcast's to know —
 * so the answer is the one tugcast puts on the spawn, and these paths are
 * only the pre-instances location a tugcode running without a tugcast falls
 * back to:
 *
 *   - macOS: `~/Library/Application Support/Tug/sessions.db`
 *   - Linux: `$XDG_DATA_HOME/tugcast/sessions.db` (falling back to
 *     `~/.local/share/tugcast/sessions.db`)
 *
 * Tests inject a different path via the `sessionsDbPath` constructor
 * option so they don't read the real user's database.
 */
export function defaultSessionsDbPath(): string {
  // What tugcast told us, which is the ledger tugcast itself opened. Set on
  // the spawn (`TUG_SESSIONS_DB`), and authoritative: `sessions.db` is
  // per-instance, so the paths below are the pre-instances location and are a
  // fallback for a tugcode run outside a tugcast — a test, or a bare launch.
  const told = process.env.TUG_SESSIONS_DB;
  if (told !== undefined && told.length > 0) return told;
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
 * shape (mid-turn-replay Step 5.2).
 * Tugcode never writes to this table; tugcast's `dispatch_one`
 * intercept owns inserts (Step 4.3)
 * and the merger's `apply_outbound_turn_intercept` owns FIFO deletes
 * (Step 5.3).
 */
export interface JournalRow {
  journal_id: string;
  session_id: string;
  user_text: string;
  user_attachments: Buffer | Uint8Array;
  created_at: number;
}

/**
 * Build a multiset (text → count) of user-message texts seen in the
 * JSONL bytes. Used by [`runReplay`]'s pending-row injection
 * (mid-turn-replay Step 5.6)
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
 * The epoch-ms `timestamp` of one JSONL record, or `undefined` when the line
 * does not parse or carries none — so a rewind's cut is reported only when it
 * is known, never guessed.
 */
export function recordTimestampMs(line: string | undefined): number | undefined {
  if (line === undefined) return undefined;
  try {
    const parsed = JSON.parse(line) as { timestamp?: unknown };
    if (typeof parsed.timestamp !== "string") return undefined;
    const ms = Date.parse(parsed.timestamp);
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

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
export function countNewlines(s: string): number {
  let n = 0;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) {
    n += 1;
  }
  return n;
}

/**
 * Every entry `uuid` in a JSONL — a relocation's parent, whose lines the fork
 * carried with their uuids intact. Unparseable lines are skipped.
 */
export function collectJsonlUuids(jsonl: string): Set<string> {
  const uuids = new Set<string>();
  for (const line of jsonl.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const entry = JSON.parse(line) as { uuid?: unknown };
      if (typeof entry.uuid === "string" && entry.uuid.length > 0) uuids.add(entry.uuid);
    } catch {
      // A torn or foreign line carries no uuid worth knowing.
    }
  }
  return uuids;
}

/**
 * The uuid of the first user prompt a relocated session's own JSONL holds that
 * its parent does not — the first thing said after the move. A prompt is a
 * non-meta `user` entry carrying text or an image rather than only tool
 * results. `null` when every prompt was carried.
 */
export function firstUncarriedPromptUuid(jsonl: string, carried: Set<string>): string | null {
  for (const line of jsonl.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: {
      type?: unknown;
      uuid?: unknown;
      isMeta?: unknown;
      message?: { content?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "user" || entry.isMeta === true) continue;
    if (typeof entry.uuid !== "string" || carried.has(entry.uuid)) continue;
    const content = entry.message?.content;
    const isPrompt =
      typeof content === "string" ||
      (Array.isArray(content) &&
        content.some(
          (block: { type?: unknown }) => block?.type === "text" || block?.type === "image",
        ));
    if (isPrompt) return entry.uuid;
  }
  return null;
}

/**
 * The `tug:landings` block's first two lines — copies of
 * `LANDINGS_MARKER` and `LANDINGS_HEADING` in
 * `tugrust/crates/tugcore/src/session_transcript.rs`, which is the
 * source. tugcast appends the block to a user message when the line
 * holds landings its model has not been told.
 */
const LANDINGS_MARKER = "<!-- tug:landings -->";
const LANDINGS_HEADING =
  "Since your last turn (the user's acts; your view of the tree may be stale):";

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
 *
 * A journal text that ends in tugcast's `tug:landings` block is split
 * back into two text blocks — the user's words, then the block. The
 * journal stores one flat string (tugcast appends the block before it
 * writes the row, so the row's text matches the JSONL's), and without
 * the split the block would ride inside the user's own text block,
 * where the deck's `startsWith` strip cannot see it and the user would
 * read the model's fact sheet in their own row. The split keys on the
 * marker, a newline and the heading together, so a user who types the
 * bare marker in a sentence is never cut.
 */
export function buildContentBlocksFromLegacyJournal(
  text: string,
  attachments: Array<Attachment>
): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  // Text always comes first — the user's words, then any landings block.
  const at = text.lastIndexOf(LANDINGS_MARKER + "\n" + LANDINGS_HEADING);
  if (at >= 0) {
    const own = text.slice(0, at);
    if (own.length > 0) {
      blocks.push({ type: "text", text: own });
    }
    blocks.push({ type: "text", text: text.slice(at) });
  } else if (text.length > 0) {
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

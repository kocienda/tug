// `/rewind` and prompt retraction: the two restore dimensions of a rewind
// (code through claude's `rewind_files` control request, conversation
// through a JSONL truncate and a silent `--resume`), and the retraction of
// an interrupted prompt from the session's history.
//
// `Rewind` is a collaborator the session manager constructs. It owns the
// in-flight `rewind_files` requests, the cached preview read, the verbs and
// their acks, and the JSONL side of a conversation rewind — the read, the
// truncation check, the fork or in-place write and its rollback. The process
// swap is the manager's: a respawn carries session identity, so the
// collaborator asks for one through {@link RewindHost}.

import type {
  RewindPreview,
  SessionRewind,
  RewindPreviewResult,
  RewindResult,
} from "./types.ts";
import { IPC_VERSION } from "./types.ts";
import { realpath } from "node:fs/promises";
import { writeLine } from "./ipc.ts";
import { sendControlRequest, generateRequestId } from "./control.ts";
import { logSessionLifecycle } from "./session-lifecycle-log.ts";
import type { ClaudeHome } from "./claude-home.ts";
import { isSessionHeldByOtherProcess } from "./terminal-liveness.ts";
import {
  type JsonlReadResult,
  computeConversationTruncation,
  jsonlPathFor,
  recordTimestampMs,
} from "./journal.ts";
import type { ActiveTurn } from "./active-turn.ts";
import type { ClaudeSubprocess } from "./claude-process.ts";

/**
 * What the rewind collaborator reads from, and asks of, the session it
 * serves. The reads are functions because the answers move under it: a
 * rotation mints a new session id, a fork moves the resume id, a respawn
 * replaces the child.
 */
export interface RewindHost {
  sessionId(): string;
  resumeSessionId(): string | null;
  projectDir(): string;
  claudeHome(): ClaudeHome;
  readJsonl(path: string): Promise<JsonlReadResult>;
  writeJsonl(path: string, content: string): Promise<void>;
  /** The live claude child, or `null` when none is running. */
  claudeProcess(): ClaudeSubprocess | null;
  activeTurn(): ActiveTurn | null;
  /** Take the claude subprocess down before any disk write. */
  killAndCleanup(): Promise<void>;
  /**
   * Point the session at the fork `newId` for this and every later spawn,
   * spawn `--resume` on it, and resolve once it has proven it loaded.
   */
  respawnIntoRewindFork(newId: string): Promise<void>;
  /** Respawn `--resume` on the truncated `liveId`; throws if the spawn fails. */
  respawnRewoundInPlace(liveId: string): Promise<void>;
}

export class Rewind {
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
   * Cached JSONL read for the `/rewind` preview batch ([#step-7-3]). The sheet
   * fires one `rewind_preview` per row when it opens — all while idle, so the
   * session JSONL is stable — and each needs to know whether its anchor is
   * conversation-rewindable. Reading the (possibly large) JSONL once and
   * sharing the promise avoids N re-reads. Cleared when a turn opens
   * ({@link handleUserMessage}) or the session respawns ({@link killAndCleanup})
   * — i.e. whenever the JSONL could change.
   */
  private rewindPreviewJsonl: Promise<JsonlReadResult> | null = null;

  constructor(private readonly host: RewindHost) {}

  /**
   * Drop the cached preview read. The manager calls it whenever the JSONL
   * could change: a turn opening, or the session respawning.
   */
  clearPreviewCache(): void {
    this.rewindPreviewJsonl = null;
  }

  /** Whether any `rewind_files` request is waiting on its control response. */
  hasPendingRequests(): boolean {
    return this.pendingRewindRequests.size > 0;
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
    const turn = this.host.activeTurn();
    return (
      turn === null ||
      turn.gotResult ||
      turn.interrupted
    );
  }

  /**
   * Read the live session's on-disk JSONL — canonicalizing the project dir
   * the way claude names its per-session file (`realpath`, since claude
   * resolves symlinks). Used by the `/rewind` conversation checks.
   */
  private async readLiveSessionJsonl(): Promise<JsonlReadResult> {
    const liveId = this.host.resumeSessionId() ?? this.host.sessionId();
    let canonicalProjectDir = this.host.projectDir();
    try {
      canonicalProjectDir = await realpath(this.host.projectDir());
    } catch {
      // Unresolvable (test fixture / deleted dir) — fall back to raw.
    }
    return this.host.readJsonl(
      jsonlPathFor(this.host.claudeHome(), canonicalProjectDir, liveId),
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
    if (!this.host.claudeProcess()) {
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
    const child = this.host.claudeProcess();
    if (!child || !this.isClaudeIdle()) {
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
    sendControlRequest(child.stdin, requestId, {
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

    if (!this.host.claudeProcess()) {
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
      const child = this.host.claudeProcess();
      if (!child) {
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
      sendControlRequest(child.stdin, requestId, {
        subtype: "rewind_files",
        user_message_id: promptUuid,
        dry_run: false,
      });
    });
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
  ): Promise<{
    canRewind: boolean;
    error?: string;
    newSessionId?: string;
    cutAtMs?: number;
  }> {
    const liveId = this.host.resumeSessionId() ?? this.host.sessionId();

    // Resolve the on-disk JSONL the same way runReplay does — claude names
    // its per-session file after the canonicalized cwd.
    let canonicalProjectDir = this.host.projectDir();
    try {
      canonicalProjectDir = await realpath(this.host.projectDir());
    } catch {
      // Unresolvable (test fixture / deleted dir) — fall back to raw; the
      // reader reports `missing` if the path doesn't exist.
    }
    const livePath = jsonlPathFor(
      this.host.claudeHome(),
      canonicalProjectDir,
      liveId,
    );

    const read = await this.host.readJsonl(livePath);
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
    const cutAtMs = recordTimestampMs(lines[truncation.boundary]);

    // Destructive in-place rewind only: refuse while a live process
    // other than our own claude child holds this session (a terminal
    // resumed it after this card opened it). Truncating under a live
    // holder yanks history out from under its in-memory conversation.
    // Fork mode stays ungated — it only writes a brand-new file.
    if (!fork) {
      const ownPid = this.host.claudeProcess()?.pid;
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
    await this.host.killAndCleanup();

    if (fork) {
      // Copy the truncated history under a fresh id; the original `livePath`
      // is left intact. The new id is known synchronously (we mint it), so
      // the ack + the rebind don't depend on claude's first-input init.
      const newId = crypto.randomUUID();
      const forkPath = jsonlPathFor(
        this.host.claudeHome(),
        canonicalProjectDir,
        newId,
      );
      try {
        await this.host.writeJsonl(forkPath, truncated);
      } catch (err) {
        return {
          canRewind: false,
          error: `Could not write forked session (${err instanceof Error ? err.message : String(err)}).`,
        };
      }
      // Announce the parentage BEFORE the synthetic `session_init` that
      // records the spawn: the fork is another segment of the same line, and
      // the announcement is what attaches it to one ([P05]). The rewound-to
      // prompt uuid is the branch point.
      writeLine({
        type: "session_segment",
        kind: "rewind",
        parentSessionId: liveId,
        newSessionId: newId,
        forkPoint: promptUuid,
        ipc_version: IPC_VERSION,
      });
      await this.host.respawnIntoRewindFork(newId);
      return { canRewind: true, newSessionId: newId, cutAtMs };
    }

    // Destructive in-place: snapshot the full pre-truncation bytes so a
    // failed respawn can roll back, then overwrite the live JSONL.
    try {
      await this.host.writeJsonl(livePath, truncated);
    } catch (err) {
      return {
        canRewind: false,
        error: `Could not truncate session (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
    try {
      await this.host.respawnRewoundInPlace(liveId);
    } catch (err) {
      // Roll back the truncation so the session isn't left half-rewound.
      try {
        await this.host.writeJsonl(livePath, read.jsonl);
      } catch {
        // Best-effort; the spawn failure is the reported error.
      }
      return {
        canRewind: false,
        error: `Respawn after rewind failed (${err instanceof Error ? err.message : String(err)}).`,
      };
    }
    // The id did not change, so no segment frame says anything happened.
    // tugcast re-reads the truncated file and pushes the corrected row.
    writeLine({ type: "session_rewound", sessionId: liveId, ipc_version: IPC_VERSION });
    return { canRewind: true, cutAtMs };
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
  maybeScheduleRetraction(turn: ActiveTurn): void {
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
      session_id: this.host.sessionId(),
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
  tryHandleRewindControlResponse(
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
      ipc_version: IPC_VERSION,
    };
    writeLine(msg);
  }

  /** Emit a {@link RewindResult} ack ([#step-7-1]/[#step-7-2]). */
  private emitRewindResult(
    promptUuid: string,
    scope: "conversation" | "code" | "both",
    fields: {
      canRewind: boolean;
      error?: string;
      newSessionId?: string;
      cutAtMs?: number;
    },
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
      ...(fields.cutAtMs !== undefined ? { cutAtMs: fields.cutAtMs } : {}),
      ipc_version: IPC_VERSION,
    };
    writeLine(msg);
  }
}

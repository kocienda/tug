// Session replay: read a resumed session's JSONL archive and stream its
// translated frames to IPC stdout inside one `replay_started` /
// `replay_complete` bracket.
//
// `ReplayRunner` is a collaborator the session manager constructs. It owns
// the replay's own state — the in-flight flag, the abort resolver, the
// timing overrides, and the read-only `sessions.db` handle the pending-row
// and wheel-prompt reads go through — and reads everything else from the
// manager through a narrow {@link ReplayHost}.

import type {
  OutboundMessage,
  ReplayComplete,
  Attachment,
  ReplayWindow,
  ReplayLineageEntry,
  ReplayRelocationOrigin,
  ReplayRelocation,
} from "./types.ts";
import { IPC_VERSION } from "./types.ts";
import { realpath } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { writeLine, writeLineAndExit, drainPendingWrites } from "./ipc.ts";
import { logSessionLifecycle } from "./session-lifecycle-log.ts";
import {
  type ReplayInput,
  type ReplayTelemetry,
  translateJsonlSession,
  type WheelPromptLedger,
  wheelPromptLedger,
} from "./replay.ts";
import type { ClaudeHome } from "./claude-home.ts";
import {
  type JournalRow,
  type JsonlReadResult,
  buildContentBlocksFromLegacyJournal,
  collectJsonlUuids,
  countNewlines,
  defaultSessionsDbPath,
  extractUserMessageTextCounts,
  firstUncarriedPromptUuid,
  jsonlPathFor,
  readSubagentTranscripts,
  subagentsDirFor,
} from "./journal.ts";
import type { ActiveTurn } from "./active-turn.ts";
import type {
  ClaudeStderrClassification,
  ClaudeSubprocess,
} from "./claude-process.ts";

/**
 * Hard-budget timeout for the per-session replay window. If the JSONL
 * iterator hasn't finished by this point, the replay aborts with
 * `replay_complete { error: { kind: "replay_timeout" } }` and live
 * forwarding resumes. Matches the wall-clock budget called out in
 * the transcript-resume design record (D10).
 */
export const REPLAY_HARD_TIMEOUT_MS = 10_000;
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
// ReplayRunner
// ---------------------------------------------------------------------------

/**
 * What the replay runner reads from the session it serves. Every member is
 * a function because the answers move: a rotation mints a new `sessionId`,
 * a respawn replaces the claude child, and a turn opens and closes.
 */
export interface ReplayHost {
  /** The card's session id. */
  sessionId(): string;
  /** The claude session id being resumed, when it differs from the card's. */
  resumeSessionId(): string | null;
  projectDir(): string;
  claudeHome(): ClaudeHome;
  readJsonl(path: string): Promise<JsonlReadResult>;
  /** The conversation a directory change forks from, or `null`. */
  relocation(): { parentClaudeId: string; parentProjectDir: string } | null;
  /** The live claude child, or `null` before the first spawn. */
  claudeProcess(): ClaudeSubprocess | null;
  activeTurn(): ActiveTurn | null;
  stderrClassification(): ClaudeStderrClassification | null;
  /** Write the adopted in-flight turn's snapshot inside the bracket. */
  emitInflightTurnFromActiveTurn(turn: ActiveTurn): void;
  /** Rewind every live background-agent tailer to offset 0. */
  resetSubagentTailersForReplay(): void;
}

export interface ReplayRunnerOptions {
  /** Hard-timeout override (test hook). */
  replayTimeoutMs?: number;
  /** Live-buffer overflow threshold (test hook). */
  replayLiveBufferMax?: number;
  /** Replay telemetry sink forwarded into `translateJsonlSession`. */
  replayTelemetry?: ReplayTelemetry;
  /** Translate-loop slice override; `undefined` → translator default. */
  replayTimeSliceMs?: number;
  /**
   * Override for the sessions.db path. `null` skips opening any DB;
   * omit → {@link defaultSessionsDbPath}.
   */
  sessionsDbPath?: string | null;
}

export class ReplayRunner {
  /**
   * `true` while `runReplay` is iterating the JSONL bracket. Read by the
   * manager's early-exit watcher so a claude crash *during* replay is
   * surfaced through `runReplay`'s own crash branch (which emits
   * `replay_complete { claude_exited_during_replay }` first, then a
   * lifecycle `resume_failed`). Without this flag the watcher would
   * race the replay path and emit `resume_failed` while the card was
   * still in `replaying` phase.
   */
  private active: boolean = false;
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
  private readonly replayTimeoutMs: number;
  private readonly replayLiveBufferMax: number;
  private readonly replayTelemetry: ReplayTelemetry | undefined;
  private readonly replayTimeSliceMs: number | undefined;
  /**
   * Read-only handle on tugcast's `sessions.db`. Opened once at
   * construction (so each `runReplay` call reuses one prepared statement
   * cache) and held for the lifetime of the session. `null` when the
   * file doesn't exist yet (fresh install with no tugcast writes), when
   * the open fails for any reason, or when a test explicitly skips it
   * via the `sessionsDbPath: null` option. Production tugcast keeps the
   * file in WAL mode; cross-process WAL visibility is verified by
   * `sessions-db-cross-process.test.ts`.
   */
  private sessionsDb: Database | null = null;
  /** Resolved path of `sessionsDb` for diagnostics; `null` if no DB. */
  private sessionsDbPath: string | null = null;

  constructor(
    private readonly host: ReplayHost,
    options: ReplayRunnerOptions = {},
  ) {
    this.replayTimeoutMs = options.replayTimeoutMs ?? REPLAY_HARD_TIMEOUT_MS;
    this.replayLiveBufferMax =
      options.replayLiveBufferMax ?? REPLAY_LIVE_BUFFER_MAX;
    this.replayTelemetry = options.replayTelemetry;
    this.replayTimeSliceMs = options.replayTimeSliceMs;
    this.openSessionsDb(options.sessionsDbPath);
  }

  /** Whether a replay bracket is open right now. */
  get replayActive(): boolean {
    return this.active;
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
        session_id: this.host.sessionId(),
        path,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Close the sessions.db handle. The manager's `shutdown()` calls it
   * after the claude-subprocess teardown; it is separate so the DB close
   * never re-enters the subprocess kill path.
   */
  closeSessionsDb(): void {
    if (this.sessionsDb !== null) {
      try {
        this.sessionsDb.close();
      } catch {
        // Already closed or never fully opened — no-op.
      }
      this.sessionsDb = null;
    }
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
   * was removed in Step R4
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
    wheelPrompts: WheelPromptLedger,
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
          ipc_version: IPC_VERSION,
        });
      }
      // The last entry is the session being resumed; the main pass emits its
      // turns. Only its divider belongs here.
      if (i === lineage.length - 1) continue;

      const path = jsonlPathFor(
        this.host.claudeHome(),
        canonicalProjectDir,
        entry.sessionId,
      );
      const read = await this.host.readJsonl(path);
      if (read.kind !== "ok") {
        logReplay("lineage_entry_unreadable", {
          session_id: this.host.sessionId(),
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
          // One ledger for the whole restore, walked file by file in the order
          // the work happened — so a prompt the wheel sent in an earlier stage
          // is claimed there and cannot be claimed again downstream.
          wheelPrompts,
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
    relocation?: ReplayRelocationOrigin,
  ): Promise<void> {
    // Pre-Step-5 the early-return `if (this.sessionMode !== "resume") return;`
    // gated runReplay by the original spawn mode. That assumption (mode=new
    // ⇒ no JSONL to replay) holds at the moment of spawn but rots once the
    // session has had wire activity. After the first turn lands, any
    // request_replay against the same session — sent from tugdeck on
    // `Maker > Reload` / HMR / card remount — needs the JSONL pass to
    // rehydrate the freshly-mounted CodeSessionStore. The mid-turn-replay
    // Step 5 close-out
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
        session_id: this.host.sessionId(),
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
    const claudeSessionId = this.host.resumeSessionId() ?? this.host.sessionId();

    // Mark replay active *before* the first await so a claude crash
    // during the JSONL read can't slip past the early-exit watcher
    // and emit a stray `resume_failed` while we're still mid-replay.
    // The crash branch below picks up `child.exited` via the loop's
    // race promise and surfaces it through the canonical
    // `replay_complete { claude_exited_during_replay }` then
    // `resume_failed` order.
    this.active = true;

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
    let canonicalProjectDir = this.host.projectDir();
    try {
      canonicalProjectDir = await realpath(this.host.projectDir());
    } catch {
      // Path doesn't resolve (test fixture, deleted dir, etc.).
      // Keep the raw form; downstream reader reports missing.
    }
    if (canonicalProjectDir !== this.host.projectDir()) {
      logReplay("path_canonicalized", {
        session_id: this.host.sessionId(),
        raw: this.host.projectDir(),
        canonical: canonicalProjectDir,
      });
    }
    const jsonlPath = jsonlPathFor(
      this.host.claudeHome(),
      canonicalProjectDir,
      claudeSessionId,
    );

    logReplay("started", {
      session_id: this.host.sessionId(),
      claude_session_id: claudeSessionId,
      jsonl_path: jsonlPath,
    });
    logSessionLifecycle("perf.replay_requested", {
      tug_session_id: this.host.sessionId(),
    });

    const startedAt = Date.now();
    let rawInput = await this.host.readJsonl(jsonlPath);

    // A directory change ([P03], [P04]). The move is known from tugcast's
    // request (derived from the ledger's cross-directory fork edge) or, on the
    // session that did the moving, from its own argv. While the fork is
    // unwritten — its own JSONL missing, the same file fact
    // `relocationForkPending` reads — the carried context lives only in the
    // parent's transcript, so that is what replays, followed by the divider.
    // Once the fork is written, its own JSONL already holds the carried lines
    // with their uuids intact, and the divider goes before the first prompt the
    // parent does not hold. An unreadable parent draws no divider at all.
    const ownRelocation = this.host.relocation();
    const reloc: ReplayRelocationOrigin | undefined =
      relocation ??
      (ownRelocation !== null
        ? {
            parentSessionId: ownRelocation.parentClaudeId,
            fromDir: ownRelocation.parentProjectDir,
            toDir: this.host.projectDir(),
          }
        : undefined);
    let relocationDivider: ReplayRelocation | null = null;
    let carriedUuids: Set<string> | null = null;
    let firstUncarriedPrompt: string | null = null;
    let transcriptDir = canonicalProjectDir;
    let transcriptSessionId = claudeSessionId;
    if (reloc !== undefined && rawInput.kind !== "unreadable") {
      let parentDir = reloc.fromDir;
      try {
        parentDir = await realpath(reloc.fromDir);
      } catch {
        // Unresolvable — keep the raw path; the reader reports missing.
      }
      const parentRead = await this.host.readJsonl(
        jsonlPathFor(this.host.claudeHome(), parentDir, reloc.parentSessionId),
      );
      if (parentRead.kind === "ok") {
        relocationDivider = {
          type: "replay_relocation",
          from_dir: reloc.fromDir,
          to_dir: reloc.toDir,
          ipc_version: IPC_VERSION,
        };
        if (rawInput.kind === "missing") {
          rawInput = parentRead;
          transcriptDir = parentDir;
          transcriptSessionId = reloc.parentSessionId;
        } else {
          carriedUuids = collectJsonlUuids(parentRead.jsonl);
          firstUncarriedPrompt = firstUncarriedPromptUuid(rawInput.jsonl, carriedUuids);
        }
      }
      logReplay("relocation", {
        session_id: this.host.sessionId(),
        parent_session_id: reloc.parentSessionId,
        parent_read: parentRead.kind,
        fork_pending: transcriptSessionId !== claudeSessionId,
      });
    }
    logSessionLifecycle("perf.replay_read", {
      tug_session_id: this.host.sessionId(),
      ms: Date.now() - startedAt,
      bytes: rawInput.kind === "ok" ? rawInput.jsonl.length : 0,
      lines: rawInput.kind === "ok" ? countNewlines(rawInput.jsonl) : 0,
    });
    // Thread the claude session id into the replay input so the
    // synthesized `system_metadata` IPC at the top of replay carries
    // the right session_id field — this session's own id even when a
    // pending relocation reads the parent's transcript, because the card is
    // bound to this session. Only the `ok` variant carries payload;
    // missing/unreadable variants pass through unchanged.
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
        this.host.claudeHome(),
        transcriptDir,
        transcriptSessionId,
      );
      const subagents = await readSubagentTranscripts(subagentsDir);
      if (subagents.length > 0) {
        input = { ...input, subagents };
        logReplay("subagents_restored", {
          session_id: this.host.sessionId(),
          count: subagents.length,
          entries: subagents.reduce((n, t) => n + t.entries.length, 0),
        });
      }
    }

    // The arc's earlier stages, translated up front so the loop below stays
    // the single-session loop it has always been: with no lineage this is an
    // empty array and every byte on the wire is what it was before lineage
    // existed ([P10]).
    // Read once, spent across every file this restore walks — the lineage
    // prefix first, then the resumed session — so the wheel's prompts come
    // back under the wheel's name wherever in the work they were sent.
    const wheelPrompts = wheelPromptLedger(this.readWheelPromptsForLine());
    // A backward page is not a restore. `turnRange` asks for turns older than
    // the ones already on screen, in the TIP's coordinates, and the ancestors
    // are already loaded — whole, since only the tip is ever windowed. Sending
    // their frames again would prepend the whole arc above itself: every
    // divider and every ancestor turn twice, and a numerator counting them
    // twice against a denominator that counts each file once. The lineage
    // belongs to the replay that builds the transcript, not to the one that
    // extends it upward.
    const backwardPage = window !== undefined && "turnRange" in window;
    const lineagePrefix: OutboundMessage[] =
      lineage !== undefined && lineage.length > 1 && !backwardPage
        ? await this.collectLineagePrefix(
            lineage,
            canonicalProjectDir,
            wheelPrompts,
          )
        : [];
    if (lineagePrefix.length > 0) {
      logReplay("lineage_prefix", {
        session_id: this.host.sessionId(),
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
    const child = this.host.claudeProcess();
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
    const activeTurn = this.host.activeTurn();
    const inflight = (
      activeTurn !== null &&
      !activeTurn.gotResult &&
      !activeTurn.interrupted
    ) ? activeTurn : null;
    if (inflight !== null) {
      inflight.suppressEmit = true;
    }

    // JSONL-driven replay (the only path post-Step-5.4). The
    // translator emits `replay_started` → committed-turn frames →
    // `replay_complete`, raced against the exit + timeout promises.
    // The trailing in-flight turn's predicate is the
    // Step 5.5
    // territory; this substep restores the pre-Step-4 translator-driven
    // shape unchanged. The journal-driven pending-row injection lands
    // in Step 5.6,
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
        writeLine({ type: "replay_batch", frames: [...batch], ipc_version: IPC_VERSION });
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
    // Whether this pass has forwarded a prompt the relocation's parent holds —
    // the evidence that the move's boundary, if this pass reaches it, falls
    // inside it rather than above its first turn.
    let carriedPromptSeen = false;

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
      // The same ledger the lineage prefix walked, carrying whatever it did
      // not spend. The resumed session is the lineage's last entry, so this
      // pass is the end of one continuous walk, not a second one.
      wheelPrompts,
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
                session_id: this.host.sessionId(),
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
              this.injectPendingRowSynthetics(
                input,
                (m) => batch.push(m),
                wheelPrompts,
              );
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
          if (
            carriedUuids !== null &&
            msg.type === "add_user_message" &&
            typeof msg.promptUuid === "string"
          ) {
            if (carriedUuids.has(msg.promptUuid)) {
              carriedPromptSeen = true;
            } else if (relocationDivider !== null) {
              // The first uncarried prompt in this pass. It is the move's
              // boundary when a carried prompt came before it, or when it is
              // the first thing said after the move; otherwise the boundary
              // lies above this page, which draws no divider.
              if (carriedPromptSeen || msg.promptUuid === firstUncarriedPrompt) {
                batch.push(relocationDivider);
              }
              relocationDivider = null;
            }
          }
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

      // A divider still unplaced trails the content: after the parent's turns
      // while the fork is unwritten, or after every turn when all of them were
      // carried. Only on the pass that builds the transcript — the end of a
      // backward page is not the end of the transcript.
      if (aborted === null && relocationDivider !== null && !backwardPage) {
        batch.push(relocationDivider);
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
          this.host.emitInflightTurnFromActiveTurn(inflight);
        } catch (err) {
          // The snapshot is a rendering nicety; the bracket-close below is
          // load-bearing (see `bracketOpened`). Never let a bad in-flight
          // turn state take `replay_complete` down with it.
          logReplay("error", {
            session_id: this.host.sessionId(),
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
        session_id: this.host.sessionId(),
        kind: "replay_exception",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      this.active = false;
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
      this.host.resetSubagentTailersForReplay();
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
      tug_session_id: this.host.sessionId(),
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
        ipc_version: IPC_VERSION,
      };
      writeLine(complete);
      logReplay("aborted", {
        session_id: this.host.sessionId(),
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
        ipc_version: IPC_VERSION,
      };
      writeLine(complete);
      logReplay("error", {
        session_id: this.host.sessionId(),
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
        ipc_version: IPC_VERSION,
      };
      writeLine(complete);
      logReplay("error", {
        session_id: this.host.sessionId(),
        kind: "claude_exited_during_replay",
        count,
        exit_code: aborted.code,
      });
      // Surface the subprocess loss through the existing lifecycle
      // path so the card unbinds with the canonical resume-failure
      // shape. The stderr classification may already be set if
      // claude wrote a recognizable diagnostic before exiting.
      const classification = this.host.stderrClassification();
      const reason =
        classification === "resume_failed"
          ? `claude reported "No conversation found" (stale --resume id)`
          : `claude exited with code ${aborted.code} during replay`;
      logSessionLifecycle("tugcode.resume_failed", {
        stale_session_id: this.host.sessionId(),
        reason,
        exit_code: aborted.code,
        classification: classification ?? "replay_crash",
      });
      await writeLineAndExit(
        {
          type: "resume_failed",
          reason,
          stale_session_id: this.host.sessionId(),
          ipc_version: IPC_VERSION,
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
        ipc_version: IPC_VERSION,
      };
      writeLine(complete);
    }

    logReplay("complete", {
      session_id: this.host.sessionId(),
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
   * Mid-turn-replay Step 5.6.
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
      return stmt.all(this.host.sessionId());
    } catch (err) {
      logReplay("sessions_db_read_error", {
        session_id: this.host.sessionId(),
        reason: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Tug's own record of what the **wheel** put on the wire, for this card's
   * line of work — read through the same cross-process bun:sqlite handle, and
   * read-only for the same reason: tugcast's wheel owns the writes.
   *
   * The wheel speaks in the transcript under its own name, and claude's JSONL
   * cannot say so — that file is claude's, and it records a prompt the wheel
   * sent exactly as it records one the user typed. So the wheel writes down
   * what it sends, and a reload states authorship from that record instead of
   * guessing it from a prompt's position in the file.
   *
   * Keyed on the **line**, not on `this.host.sessionId()`: an arc rotates a card
   * through several session ids and the wheel's prompts belong to the work.
   * Kept in lockstep with `SessionLedger::list_wheel_prompts_for_line`.
   *
   * Answers `[]` when the handle is unavailable or the read fails, which
   * attributes nothing to the wheel — the same transcript this replay produced
   * before the record existed.
   */
  private readWheelPromptsForLine(): string[] {
    if (this.sessionsDb === null) return [];
    try {
      const stmt = this.sessionsDb.query<{ text: string }, [string]>(
        `SELECT text FROM wheel_prompts
         WHERE line_id = (SELECT line_id FROM sessions WHERE session_id = ?)
         ORDER BY sent_at ASC, prompt_id ASC`,
      );
      return stmt.all(this.host.sessionId()).map((row) => row.text);
    } catch (err) {
      logReplay("sessions_db_read_error", {
        session_id: this.host.sessionId(),
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
   * (mid-turn-replay Step 5.6
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
    wheelPrompts: WheelPromptLedger,
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
        // A submission still pending is one claude has not written down yet,
        // so this frame is the only place its author can be named. The row
        // holds the text as it went out, which is what the wheel's record
        // holds too.
        ...(wheelPrompts.claim(row.user_text) ? { origin: "wheel" as const } : {}),
        ipc_version: IPC_VERSION,
      });
      logReplay("pending_row_synthetic_emit", {
        session_id: this.host.sessionId(),
        journal_id: row.journal_id,
      });
    }
  }
}

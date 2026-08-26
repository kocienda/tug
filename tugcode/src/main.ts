#!/usr/bin/env bun
// Tugcode: Claude Code bridge — stream-json IPC between Claude Code and tugcast

import {
  drainPendingWrites,
  readLine,
  writeLine,
  writeLineAndExit,
} from "./ipc.ts";
import { isProtocolInit, isUserMessage } from "./types.ts";
import { dispatchInbound } from "./inbound-dispatch.ts";
import { SessionManager, resolvePluginDir } from "./session.ts";
import { isPermissionMode, type PermissionMode } from "./permissions.ts";
import { loadTranscript, StubReplayEngine } from "./stub-replay.ts";
import { readClaudeCodeSettings } from "./claude-code-settings.ts";
import { ContextBreakdownEmitter } from "./context-breakdown.ts";
import { initTokenizer } from "./tokenizer.ts";
import { logSessionLifecycle } from "./session-lifecycle-log.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  realpathSync,
  readFileSync,
  readdirSync,
  statSync,
  writeSync,
} from "node:fs";
import { computeDeadEntryIndices, segmentJsonlOrigins } from "./replay.ts";
import type { JsonlEntry } from "./replay.ts";

// Process-start wall clock for the boot-latency split. Captured at
// module evaluation — before arg parsing, settings reads, or the
// protocol handshake — so `perf.boot` measures everything the user
// waits on between subprocess exec and "ready to serve verbs".
const PROCESS_STARTED_AT = Date.now();

// Redirect console.log/warn/error to stderr to keep stdout clean for JSON-lines
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args: unknown[]) => {
  originalError("[tugcode]", ...args);
};
console.warn = (...args: unknown[]) => {
  originalError("[tugcode WARN]", ...args);
};
console.error = (...args: unknown[]) => {
  originalError("[tugcode ERROR]", ...args);
};

// Parse CLI arguments
let projectDir: string = process.cwd();
// `--session-id <uuid>` is the one identifier for this session:
// claude's own session id (either claimed via `--session-id` for a
// fresh spawn or matched via `--resume` for a resume), the tugbank
// sessions-record key, and the id tugcast routes CODE_OUTPUT under.
// Default to a freshly minted UUID so SessionManager always has a stable
// identifier; `--session-id <id>` from the args loop below overrides it
// when tugcast supplies one.
let sessionId: string = crypto.randomUUID();
// `--session-mode new|resume` picks between a fresh spawn (claude
// claims `sessionId` as its own id) and resuming an existing
// conversation. Absent / unknown values fall through to "new".
let sessionMode: "new" | "resume" = "new";
// `--resume-session <id>` is the persisted claude session id — the
// canonical key for the on-disk JSONL at
// `~/.claude/projects/<encoded-dir>/<id>.jsonl`. When tugcast has a
// persisted record for this card with `claude_session_id != null`,
// it passes the id through this flag so resume mode forwards
// `--resume <id>` to claude using the *claude* id rather than the
// tug session id (which only matches when no fork has occurred).
//
// Absent in two cases:
//   - Fresh spawns (`--session-mode new`): no resume id needed.
//   - Resume spawns whose claude id was never captured (a previous
//     session crashed pre-`session_init`, or an older tugbank record
//     written before persistence was added). In both cases
//     `SessionManager` falls back to using `sessionId` for the
//     claude `--resume <id>` flag — the legacy path that works for
//     un-forked sessions.
let resumeSessionId: string | undefined;
// `--permission-mode <mode>` is the deck-wide / per-card default permission
// mode tugdeck resolved at spawn time and tugcast forwarded ([agent_bridge.rs]
// `build_tugcode_command`). Seeds the SessionManager's PermissionManager
// before the first spawn so claude starts in the right mode — no post-spawn
// `permission_mode` frame racing the first turn. Validated against the known
// modes below; an unknown / absent value leaves the manager at its baseline.
let permissionMode: PermissionMode | undefined;
// `--stub-transcript=<path>` (or `--stub-transcript <path>`) routes
// the IPC loop through the deterministic replay engine in
// `stub-replay.ts` instead of spawning claude. Test-only;
// production tugcode never sees this flag.
let stubTranscriptPath: string | undefined;
const args = Bun.argv.slice(2); // Skip bun and script path

// `tugcode segment <file-or-dir>` — the real-corpus contract's tugcode
// side (`tuglaws/turn-metric.md` S03, #step-7). Emits tugcode's ordered
// per-turn origin list for each session JSONL as a JSON map
// `{ "<basename>": ["user" | "assistant", …] }` on stdout, then exits.
// A batch entrypoint (no live session) so the Rust engine's contract test
// can diff the two segmentations over the whole local corpus in one spawn.
if (args[0] === "segment") {
  const target = args[1];
  if (target === undefined) {
    originalError("usage: tugcode segment <file-or-dir>");
    process.exit(2);
  }
  const out: Record<string, Array<"user" | "assistant">> = {};
  const segmentOne = (path: string): void => {
    const base = path.split("/").pop() ?? path;
    try {
      out[base] = segmentJsonlOrigins(readFileSync(path, "utf8"));
    } catch (err) {
      originalError(`tugcode segment: skip ${path}: ${String(err)}`);
    }
  };
  const st = statSync(target);
  if (st.isDirectory()) {
    for (const name of readdirSync(target)) {
      if (name.endsWith(".jsonl")) segmentOne(join(target, name));
    }
  } else {
    segmentOne(target);
  }
  // Synchronous write to fd 1: `process.stdout.write` is async/buffered on
  // a pipe, and the immediately-following `process.exit` can truncate it
  // (the Rust contract test captures this over a pipe). `writeSync` flushes
  // before we exit.
  writeSync(1, JSON.stringify(out));
  process.exit(0);
}

// `tugcode dead <file-or-dir>` — the tugcode side of the dead-branch
// parity contract, the sibling of `segment` above. Emits the dead-entry
// index set for each session JSONL as `{ "<basename>": [index, …] }` on
// stdout, ascending, so the Rust `dead_branch` port can be diffed against
// this walk over the whole local corpus in one spawn.
if (args[0] === "dead") {
  const target = args[1];
  if (target === undefined) {
    originalError("usage: tugcode dead <file-or-dir>");
    process.exit(2);
  }
  const out: Record<string, number[]> = {};
  const deadOne = (path: string): void => {
    const base = path.split("/").pop() ?? path;
    try {
      const parsed = readFileSync(path, "utf8")
        .split("\n")
        .map((line) => {
          if (line.trim().length === 0) return null;
          try {
            return JSON.parse(line) as JsonlEntry;
          } catch {
            return null;
          }
        });
      out[base] = [...computeDeadEntryIndices(parsed)].sort((a, b) => a - b);
    } catch (err) {
      originalError(`tugcode dead: skip ${path}: ${String(err)}`);
    }
  };
  const st = statSync(target);
  if (st.isDirectory()) {
    for (const name of readdirSync(target)) {
      if (name.endsWith(".jsonl")) deadOne(join(target, name));
    }
  } else {
    deadOne(target);
  }
  writeSync(1, JSON.stringify(out));
  process.exit(0);
}

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dir" && i + 1 < args.length) {
    projectDir = args[i + 1];
    i++;
  } else if (args[i] === "--session-id" && i + 1 < args.length) {
    sessionId = args[i + 1];
    i++;
  } else if (args[i] === "--session-mode" && i + 1 < args.length) {
    const raw = args[i + 1];
    sessionMode = raw === "resume" ? "resume" : "new";
    i++;
  } else if (args[i] === "--resume-session" && i + 1 < args.length) {
    resumeSessionId = args[i + 1];
    i++;
  } else if (args[i] === "--permission-mode" && i + 1 < args.length) {
    const raw = args[i + 1];
    // Ignore an unknown value (future / corrupt client) rather than seed the
    // session with a bogus mode; the manager keeps its "default" baseline.
    if (isPermissionMode(raw)) permissionMode = raw;
    i++;
  } else if (args[i].startsWith("--stub-transcript=")) {
    stubTranscriptPath = args[i].slice("--stub-transcript=".length);
  } else if (args[i] === "--stub-transcript" && i + 1 < args.length) {
    stubTranscriptPath = args[i + 1];
    i++;
  }
}

// Canonicalize the project dir to claude's resolved-cwd form ONCE, here, so
// every cwd-derived consumer reads one value: the context-breakdown emitter,
// the spawn-time `system_metadata` cwd ([#step-12a]), the JSONL replay path,
// and claude's own cwd (it's spawned in this dir). The user may reach a
// project via symlink (e.g. `/u/src/tugtool` → `/Users/<u>/Mounts/u/src/tugtool`);
// claude names its `~/.claude/projects/<encoded-cwd>/…` dirs after the
// resolved form, and Bun's `realpathSync` yields exactly that form (matching
// claude). Best-effort: a path that doesn't resolve (test fixture) keeps the
// raw value.
try {
  projectDir = realpathSync(projectDir);
} catch {
  // Unresolvable (deleted dir, test fixture) — keep the raw path.
}

console.log(
  `Starting tugcode (projectDir: ${projectDir}, sessionId: ${sessionId}, sessionMode: ${sessionMode}${resumeSessionId ? `, resumeSessionId: ${resumeSessionId}` : ""}${permissionMode ? `, permissionMode: ${permissionMode}` : ""}${stubTranscriptPath ? `, stubTranscript: ${stubTranscriptPath}` : ""})`,
);

// Session manager (initialized after protocol handshake). Only
// populated in the live (claude-spawning) path; stub-replay mode
// leaves this null and routes all messages through `stubReplay`.
let sessionManager: SessionManager | null = null;
let stubReplay: StubReplayEngine | null = null;

/**
 * The `tug-quiesce` flush budget: how long tugcode gives itself to end
 * the claude subprocess, close its ledger handles, and get its last IPC
 * frames onto the pipe before exiting anyway. Mirror of
 * `tugcore::quiesce::FLUSH_BUDGET_MS` — the Rust test
 * `quiesce_constants_are_mirrored` fails the build if this drifts.
 *
 * The budget is enforced by tugcode on itself so a hung flush costs the
 * the shutdown supervisor nothing: it exits on its own terms well inside the
 * supervisor's drain deadline, and never has to be SIGKILLed.
 */
const QUIESCE_FLUSH_BUDGET_MS = 2000;

/** Set once quiesce has begun, so a second signal can't restart it. */
let quiescing = false;

/**
 * The exit code quiesce will use. Latched to the first non-zero code any
 * quiesce request carries — a fatal error arriving while a code-0 quiesce
 * is already in flight must not be laundered into a clean exit.
 */
let quiesceExitCode = 0;

/**
 * Run `work` with a hard time bound. Resolves `true` when it finished,
 * `false` when the budget ran out first. The timer is unref'd so it can
 * never be the thing keeping the process alive.
 */
async function withBudget(
  work: () => Promise<void>,
  budgetMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), budgetMs);
    (timer as { unref?: () => void }).unref?.();
  });
  const done = work().then(
    () => true,
    (err) => {
      console.error("Shutdown error:", err);
      return true;
    },
  );
  const finished = await Promise.race([done, expired]);
  if (timer !== undefined) clearTimeout(timer);
  return finished;
}

/**
 * The quiesce path — the single shutdown route for every way tugcode is
 * asked to stop (SIGTERM, SIGHUP, stdin EOF, a fatal main-loop error).
 *
 * Ends the claude subprocess, closes the read-only sessions.db handle,
 * and — the part a bare `process.exit` used to skip — drains the
 * serialized stdout queue, so the last frames tugcode emitted (a turn's
 * terminal frame, its telemetry) reach tugcast instead of dying in a
 * half-written pipe.
 */
async function quiesce(reason: string, code = 0): Promise<void> {
  if (code !== 0 && quiesceExitCode === 0) quiesceExitCode = code;
  if (quiescing) return;
  quiescing = true;
  console.log(`${reason}, shutting down`);
  const flushed = await withBudget(async () => {
    // Claude gets half the budget as its EOF grace: killAndCleanup's
    // escalation ladder can spend up to ~1.5× the grace before SIGKILL
    // guarantees an exit, and the stdout drain below needs the rest.
    // Passing the full budget down would starve the drain — the very
    // frames this path exists to protect — whenever claude is slow.
    await sessionManager?.shutdown({ graceMs: QUIESCE_FLUSH_BUDGET_MS / 2 });
    await drainPendingWrites();
  }, QUIESCE_FLUSH_BUDGET_MS);
  if (!flushed) {
    console.error(
      `quiesce: flush budget (${QUIESCE_FLUSH_BUDGET_MS}ms) expired after ${reason}; exiting anyway`,
    );
  }
  process.exit(quiesceExitCode);
}

// Graceful signal handlers, all routed through the same quiesce path.
// SIGTERM is the supervisor's quiesce request (tugcast signals its
// process group at shutdown). The orphaned-parent case is covered by
// the stdin-EOF path (the for-await loop below exits when the pipe
// closes); SIGHUP is belt-and-suspenders for anything that still
// delivers it, and SIGINT covers a dev-terminal Ctrl-C on the group so
// even a hand-run tugcode flushes before it dies.
process.on("SIGTERM", () => void quiesce("SIGTERM received"));
process.on("SIGHUP", () => void quiesce("SIGHUP received"));
process.on("SIGINT", () => void quiesce("SIGINT received"));

// A rejected promise nobody re-chained (an EPIPE on the write tail after
// tugcast died first, for one) must still exit through quiesce — the
// default handler would kill the process with everything unflushed.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
  void quiesce("unhandled rejection", 1);
});

// IPC loop. When stdin closes (parent hangup / pipe EOF), the for-await
// loop exits naturally. We then run the same shutdown path as SIGTERM so
// the live claude subprocess doesn't keep Bun's event loop alive and
// leave tugcode running as an orphan.
async function main() {
  // Build the Claude tokenizer (embedded tiktoken wasm) before any session
  // handling so the synchronous `countTokens` in the context breakdown /
  // skills inventory has its encoder ready. See `tokenizer.ts` for why this
  // is an explicit init rather than an import-time side effect.
  await initTokenizer();

  // Stub-replay mode: load the transcript up front so a malformed
  // file fails fast (before the harness has issued protocol_init).
  // The engine doesn't emit anything until protocol_init arrives.
  if (stubTranscriptPath !== undefined) {
    try {
      const transcript = loadTranscript(stubTranscriptPath);
      stubReplay = new StubReplayEngine({
        transcript,
        sessionId,
        emit: (msg) => writeLine(msg),
      });
    } catch (err) {
      // writeLineAndExit awaits Bun.write before process.exit so
      // the error frame actually lands in tugcode's stdout pipe.
      // A bare writeLine + process.exit races the async write
      // against the exit and silently drops the frame.
      await writeLineAndExit(
        {
          type: "error",
          message: `${err instanceof Error ? err.message : String(err)}`,
          recoverable: false,
          ipc_version: 2,
        },
        1,
      );
      return; // unreachable in production; guard for tests that stub process.exit
    }
  }

  for await (const msg of readLine()) {
    if (isProtocolInit(msg)) {
      // Protocol handshake
      if (msg.version !== 1) {
        // Use writeLineAndExit so the error frame is flushed to
        // stdout before the process exits. With writeLine being
        // serialized through a promise chain, a plain
        // `writeLine(...); process.exit(1)` would race the queued
        // microtask against the exit and silently drop the frame.
        await writeLineAndExit(
          {
            type: "error",
            message: `Unsupported protocol version: ${msg.version}`,
            recoverable: false,
            ipc_version: 2,
          },
          1,
        );
        return; // unreachable in production; guard for tests that stub process.exit
      }

      // Stub mode: synthesize the handshake from the replay engine
      // and skip claude-spawn entirely.
      if (stubReplay !== null) {
        stubReplay.synthesizeHandshake(msg.version);
        continue;
      }

      // Read the user's Claude Code settings once at session start
      // and build the context_breakdown emitter from them. Settings
      // come from `~/.claude/settings.json` and degrade to documented
      // defaults on missing / malformed file — the emitter is
      // production-resilient. See claude-code-settings.ts for the
      // exact fallback policy.
      const claudeCodeSettings = await readClaudeCodeSettings();
      const contextBreakdownEmitter = new ContextBreakdownEmitter({
        sessionId,
        homeDir: homedir(),
        cwd: projectDir,
        // The effective plugin dir — mirrors `SessionManager.getPluginDir()`:
        // the universal, app-level bundled tugplug (never the project source).
        // Its `agents/` and `skills/` fold into the breakdown.
        pluginDir: resolvePluginDir(),
        settings: claudeCodeSettings,
      });

      // Create session manager and initialize claude process
      sessionManager = new SessionManager(
        projectDir,
        sessionId,
        sessionMode,
        resumeSessionId,
        { contextBreakdownEmitter, initialPermissionMode: permissionMode },
      );

      // Send protocol_ack first (with placeholder session_id)
      writeLine({
        type: "protocol_ack",
        version: 1,
        session_id: "pending", // Will be replaced by session_init
        ipc_version: 2,
      });

      // Step R0d cold-boot order. Resume mode emits the synthetic
      // `session_init` via `prepareSession()` so tugcast can promote
      // the supervisor's entry from Spawning to Live and broadcast
      // `spawn_session_ok` immediately; tugdeck constructs services
      // and dispatches `request_replay` (Phase A-R1 / Step R1c). The
      // claude spawn happens in the background — `handleUserMessage`
      // awaits the readiness gate established in `prepareSession()`
      // so any user submit that lands before claude is ready blocks
      // until it is.
      //
      // Step R4 (Phase A-R4): the cold-boot path no longer invokes
      // `runReplay()` directly. Replay is request-driven only — the
      // `request_replay` verb is the single trigger. The supervisor
      // queues the verb during the Spawning window and drains it
      // into tugcode's stdin during the same critical section that
      // promotes Spawning→Live, so replay still arrives at the same
      // wire timing as the pre-collapse startup-replay path.
      //
      // New mode keeps the historical eager path: `initialize()`
      // spawns claude and emits the synthetic init synchronously.
      // There's no JSONL to replay and no user-perceived dead window
      // to fix.
      if (sessionMode === "resume") {
        try {
          sessionManager.prepareSession();
        } catch (err) {
          console.error("Session prepare failed:", err);
          await writeLineAndExit(
            {
              type: "error",
              message: `Session prepare failed: ${err}`,
              recoverable: false,
              ipc_version: 2,
            },
            1,
          );
        }

        // Ready to serve verbs: the synthetic session_init is on the
        // wire and the supervisor can promote Spawning→Live. The
        // background claude spawn below is NOT part of this split —
        // the user-visible replay path doesn't wait on it.
        logSessionLifecycle("perf.boot", {
          ms: Date.now() - PROCESS_STARTED_AT,
          session_id: sessionId,
          session_mode: sessionMode,
        });

        // Background claude spawn. The IPC loop continues; the
        // returned Promise is the readiness gate that
        // `handleUserMessage` awaits.
        const claudeReady = sessionManager.spawnClaudeAndWatch();
        // Surface unhandled rejection from the spawn promise to
        // stderr so a synchronous exception inside `spawnClaude`
        // (e.g. a missing claude binary) doesn't go silent. The
        // typical failure surfaces through the early-exit watcher,
        // which writes its own IPC lines and calls process.exit;
        // this catch is for the unexpected synchronous-throw case.
        claudeReady.catch(async (err) => {
          console.error("Background claude spawn failed:", err);
          await writeLineAndExit(
            {
              type: "error",
              message: `Background claude spawn failed: ${err}`,
              recoverable: false,
              ipc_version: 2,
            },
            1,
          );
        });
      } else {
        // New mode: eager spawn + emit init via the historical
        // single-call entry point. Behavior unchanged from pre-R0d.
        try {
          await sessionManager.initialize();
        } catch (err) {
          console.error("Session initialization failed:", err);
          await writeLineAndExit(
            {
              type: "error",
              message: `Session initialization failed: ${err}`,
              recoverable: false,
              ipc_version: 2,
            },
            1,
          );
        }
        logSessionLifecycle("perf.boot", {
          ms: Date.now() - PROCESS_STARTED_AT,
          session_id: sessionId,
          session_mode: sessionMode,
        });
      }
    } else if (isUserMessage(msg)) {
      // Stub mode: dispatch the next recorded turn. Out-of-bounds
      // produces an error event from the engine and asks us to
      // shut down.
      if (stubReplay !== null) {
        const ok = stubReplay.dispatchTurn();
        if (!ok) {
          // The engine emitted its own error event; quiesce drains it
          // onto the pipe instead of racing a bare exit against it.
          await quiesce("stub replay exhausted", 1);
        }
        continue;
      }
      if (sessionManager) {
        sessionManager.handleUserMessage(msg).catch((err) => {
          console.error("handleUserMessage failed:", err);
          writeLine({
            type: "error",
            message: `Failed to handle user message: ${err}`,
            recoverable: true,
            ipc_version: 2,
          });
        });
      } else {
        console.error("User message received before session initialized");
      }
    } else {
      // Every other inbound verb dispatches through the registry
      // ([#step-13c1]). Unknown verbs can't reach here — `isInboundMessage`
      // gated `readLine`, and protocol_init / user_message are handled above.
      dispatchInbound(msg, {
        sessionManager,
        sessionId,
        projectDir,
        writeLine,
      });
    }
  }
}

main()
  .then(async () => {
    // stdin closed. Kill the claude subprocess (which would otherwise
    // hold the event loop open on its stdout pipe) and exit.
    await quiesce("stdin closed");
  })
  .catch(async (err) => {
    console.error("Fatal error in main loop:", err);
    await quiesce("fatal error in main loop", 1);
  });

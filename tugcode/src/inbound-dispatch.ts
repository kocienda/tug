/**
 * inbound-dispatch — the tugcode CODE_INPUT verb registry ([#step-13c1]).
 *
 * Replaces the hand-written `if/else` chain that mirrored the inbound verb
 * union by hand. Each verb maps to one handler entry; {@link dispatchInbound}
 * looks the handler up by `msg.type`. Adding a verb is one registry entry (+
 * its shared payload type in `@tugproto/inbound` + the SessionManager handler),
 * never a new dispatch branch — and the shared `isInboundMessage` (derived from
 * the same verb list) gates unknown verbs before they reach here.
 *
 * `protocol_init` and `user_message` are NOT in the registry: they carry the
 * connection handshake and the hot turn path (stub-replay branch, init
 * ordering) and stay special-cased in `main.ts`. The registry owns the
 * config / command / query verbs — the ones whose dispatch was pure boilerplate.
 *
 * Handlers receive a {@link InboundDispatchCtx} (the live `SessionManager` plus
 * the loop's `sessionId` / `projectDir` / `writeLine`) so this module needs no
 * module-global state.
 *
 * @module inbound-dispatch
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { InboundMessage } from "@tugproto/inbound";
import type { OutboundMessage } from "./types.ts";
import type { SessionManager } from "./session.ts";
import { errorFrame } from "./ipc.ts";
import { buildSkillsInventory } from "./skills-inventory.ts";
import { buildHooksInventory } from "./hooks-inventory.ts";

/** Ambient state a verb handler may need beyond the message itself. */
export interface InboundDispatchCtx {
  /** Null until the session is initialized; handlers no-op via `?.`. */
  sessionManager: SessionManager | null;
  /** This tugcode process's session id (logging / inventory correlation). */
  sessionId: string;
  /** The session's project cwd (inventory roots). */
  projectDir: string;
  /** Emit an outbound IPC frame to stdout. */
  writeLine: (msg: OutboundMessage) => void;
}

/** The verbs the registry owns — everything except the two special-cased ones. */
type RegistryVerb = Exclude<
  InboundMessage["type"],
  "protocol_init" | "user_message"
>;

type InboundHandlers = {
  [V in RegistryVerb]: (
    msg: Extract<InboundMessage, { type: V }>,
    ctx: InboundDispatchCtx,
  ) => void;
};

/** Wrap a rejected fire-and-forget handler in a recoverable `error` frame. */
function reportAsync(
  promise: Promise<unknown> | void,
  label: string,
  writeLine: (msg: OutboundMessage) => void,
): void {
  if (promise instanceof Promise) {
    promise.catch((err) => {
      console.error(`${label}:`, err);
      // The frame goes out through the injected `writeLine` (the ctx's, so a
      // test can capture it); the builder is what logs the site beside it.
      writeLine(errorFrame("inbound_dispatch", `${label}: ${err}`, true));
    });
  }
}

/**
 * The verb registry. Exported so a coverage test can assert it has an entry for
 * every non-special verb in {@link INBOUND_VERBS} — a verb added to the shared
 * contract but not here would otherwise dispatch to `undefined` at runtime.
 */
export const INBOUND_HANDLERS: InboundHandlers = {
  tool_approval: (msg, { sessionManager }) =>
    sessionManager?.handleToolApproval(msg),
  question_answer: (msg, { sessionManager }) =>
    sessionManager?.handleQuestionAnswer(msg),
  interrupt: (msg, { sessionManager }) =>
    sessionManager?.handleInterrupt(msg.retract === true),
  permission_mode: (msg, { sessionManager }) =>
    sessionManager?.handlePermissionMode(msg),
  model_change: (msg, { sessionManager }) =>
    sessionManager?.handleModelChange(msg.model),

  // Reasoning-effort change ([#step-4]) — respawn-with-resume (no live control
  // verb in 2.1.158, [R07]). Fire-and-forget: awaiting would block the IPC loop
  // while killAndCleanup drains the old process.
  effort_change: (msg, { sessionManager, writeLine }) =>
    reportAsync(
      sessionManager?.handleEffortChange(msg.effort),
      "Effort change failed",
      writeLine,
    ),

  // Add a working directory ([#step-13c]) — same respawn-to-apply shape as
  // effort, fire-and-forget for the same reason.
  add_directory: (msg, { sessionManager, writeLine }) =>
    reportAsync(
      sessionManager?.handleAddDirectory(msg.directory),
      "Add directory failed",
      writeLine,
    ),

  stop_task: (msg, { sessionManager }) =>
    sessionManager?.handleStopTask(msg.task_id),

  // Replay the session JSONL ([D12]). Fire-and-forget: runReplay's re-entrancy
  // guard drops a request that races an in-flight replay, and awaiting would
  // block the loop behind the replay tail.
  request_replay: (msg, { sessionManager, sessionId }) => {
    if (!sessionManager) {
      console.error("request_replay received before session initialized");
      return;
    }
    console.log(`[dev::replay::request] session_id=${sessionId}`);
    sessionManager.runReplay(msg.window, msg.lineage).catch((err) => {
      console.error("request_replay failed:", err);
    });
  },

  // Abort an in-flight replay (user cancelled a load-previous / load-all).
  // Synchronous + idempotent: `cancelReplay` is a no-op when nothing is
  // running, so a late cancel after the bracket already closed is harmless.
  cancel_replay: (_msg, { sessionManager }) => {
    sessionManager?.cancelReplay();
  },

  // `/rewind` diff-stat preview ([#step-7-1]). On throw, surface a failed
  // preview ack rather than an unhandled rejection.
  rewind_preview: (msg, { sessionManager, writeLine }) => {
    sessionManager?.handleRewindPreview(msg).catch((err) => {
      console.error("Rewind preview failed:", err);
      writeLine({
        type: "rewind_preview_result",
        promptUuid: msg.promptUuid,
        canRewind: false,
        error: `Rewind preview failed: ${err}`,
        ipc_version: 2,
      });
    });
  },

  // `/rewind` apply ([#step-7-1]/[#step-7-2]). The handler emits its own
  // `rewind_result`; surface an unexpected throw as a failed ack.
  session_rewind: (msg, { sessionManager, writeLine }) => {
    sessionManager?.handleSessionRewind(msg).catch((err) => {
      console.error("Session rewind failed:", err);
      writeLine({
        type: "rewind_result",
        promptUuid: msg.promptUuid,
        scope: msg.scope,
        canRewind: false,
        error: `Session rewind failed: ${err}`,
        ipc_version: 2,
      });
    });
  },

  // `/skills` listing ([#step-12d]) — synchronous, idle-time, best-effort; the
  // response rides CODE_OUTPUT, relayed verbatim by tugcast.
  skills_inventory_query: (msg, { sessionId, projectDir, writeLine }) => {
    writeLine(
      buildSkillsInventory({
        sessionId,
        requestId: msg.request_id,
        homeDir: homedir(),
        pluginDir: join(projectDir, "tugplug"),
      }),
    );
  },

  // `/hooks` listing ([#step-12c]) — same shape as skills.
  hooks_query: (msg, { sessionId, projectDir, writeLine }) => {
    writeLine(
      buildHooksInventory({
        sessionId,
        requestId: msg.request_id,
        homeDir: homedir(),
        cwd: projectDir,
      }),
    );
  },

  session_command: (msg, { sessionManager, writeLine }) => {
    if (!sessionManager) return;
    reportAsync(
      sessionManager.handleSessionCommand(msg.command, msg.stage),
      "Session command failed",
      writeLine,
    );
  },

  // `/btw` side question — forward as a `side_question` control-request on
  // Claude's stdin; the correlated `control_response` becomes a
  // `side_question_answer` frame. Turn-state-independent (idle or mid-turn).
  side_question: (msg, { sessionManager }) =>
    sessionManager?.handleSideQuestion(msg),
};

/**
 * Route a registry verb to its handler. `msg` is any inbound message except the
 * two special-cased verbs (`main.ts` handles those before calling this). The
 * lookup narrows by `msg.type`; the `as` bridges TS's inability to correlate
 * the keyed handler with the narrowed payload (the map type guarantees it).
 */
export function dispatchInbound(
  msg: Extract<InboundMessage, { type: RegistryVerb }>,
  ctx: InboundDispatchCtx,
): void {
  const handler = INBOUND_HANDLERS[msg.type] as (
    m: typeof msg,
    c: InboundDispatchCtx,
  ) => void;
  handler(msg, ctx);
}

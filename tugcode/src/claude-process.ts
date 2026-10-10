// The claude subprocess: launching it, reading its stdout and stderr, and
// tearing it down through the signal ladder, and the one record of where the
// live child is in its lifecycle ({@link ClaudeProcessPhase}). The
// SessionManager owns what the process means — session identity, turns, the
// handshake — and drives this through the few verbs below.

import { LineSplitter } from "./line-splitter.ts";
import { logSessionLifecycle } from "./session-lifecycle-log.ts";
import { resolveClaudeCodeVersion, resolveClaudePath } from "./spawn-config.ts";

// The main spawn pipes stderr so it can be pattern-matched for failure
// classification; fork / continue inherit stderr because no
// classification is needed for those paths. Both share stdin/stdout
// "pipe", so the field accepts either stderr mode.
export type ClaudeSubprocess =
  | Bun.Subprocess<"pipe", "pipe", "pipe">
  | Bun.Subprocess<"pipe", "pipe", "inherit">;

/**
 * Launches the claude CLI with the given arguments and environment. The
 * manager composes both; the spawner only starts the process. The default
 * resolves the binary and calls `Bun.spawn`; tests pass a fake through the
 * `spawner` constructor option so they never replace a method on an instance.
 */
export type ClaudeSpawner = (
  args: string[],
  env: Record<string, string | undefined>,
) => ClaudeSubprocess;

/** Definitive failure cause read from claude's stderr; see {@link ClaudeProcess.stderrClassification}. */
export type ClaudeStderrClassification = "resume_failed" | "collision";

/**
 * Force-terminate signal grace. {@link ClaudeProcess.terminate} in `escalate`
 * mode sends SIGINT, waits this long for claude to exit, then SIGKILLs. Unlike
 * the graceful teardown (stdin EOF + 5s), a wedged claude isn't reading stdin,
 * so the ladder is signal-based and short.
 */
export const FORCE_TERMINATE_SIGINT_GRACE_MS = 1500;

/**
 * Default grace for the graceful teardown: how long a healthy claude gets
 * to finish and exit after its stdin is closed (EOF). Used by respawn /
 * fork / truncate, where nothing is waiting on the process. Shutdown
 * passes a smaller grace — see `SessionManager.shutdown` — because
 * there the `tug-quiesce` budget is what claude's exit has to fit inside.
 */
export const CLAUDE_EOF_GRACE_MS = 5000;

/**
 * Where the live claude child is in its lifecycle. Each move goes through
 * {@link ClaudeProcess.setPhase}, which logs it as `tugcode.process_phase`.
 *
 * - `dead` — no child: the initial value, and where {@link ClaudeProcess.terminate} ends.
 * - `spawning` — a child is seated and no `initialize` handshake has been sent to it.
 * - `handshaking` — the handshake was sent and has not been acked.
 * - `running` — the handshake acked: claude launched and (for a resume) opened its JSONL.
 * - `terminating` — inside {@link ClaudeProcess.terminate}.
 *
 * Stdout EOF is not a phase: it lands before or after the ack, and the
 * manager's early-exit watcher must still read the ack after it, so the
 * manager keeps EOF as a named fact of its own.
 */
export type ClaudeProcessPhase =
  | "spawning"
  | "handshaking"
  | "running"
  | "terminating"
  | "dead";

/** What the process reports back to its owner. */
export interface ClaudeProcessHost {
  /** One non-empty, trimmed line of claude's stdout. */
  onStdoutLine(line: string): void;
  /** The stdout drain ended: claude closed its stdout, or a read failed. */
  onStdoutEnd(): void;
  /** The session id the phase log names. */
  sessionId(): string;
}

export class ClaudeProcess {
  private seated: ClaudeSubprocess | null = null;
  private current: ClaudeProcessPhase = "dead";

  /** The live claude child, or `null` between spawn lifecycles. */
  get child(): ClaudeSubprocess | null {
    return this.seated;
  }
  /** Seating a child where there was none moves the phase `dead → spawning`. */
  set child(child: ClaudeSubprocess | null) {
    this.seated = child;
    if (child !== null && this.current === "dead") this.setPhase("spawning");
  }

  /** Where the live child is in its lifecycle. */
  get phase(): ClaudeProcessPhase {
    return this.current;
  }

  /**
   * Whether the live child acked its `initialize` handshake. The manager's
   * early-exit watcher reads it so a later clean exit is classified as a
   * runtime crash rather than a phantom `resume_failed` (a genuinely stale
   * `--resume` id exits within ~1s and never acks), and readiness waits
   * resolve on it. False again once the child is torn down, so each spawn
   * re-proves itself.
   */
  get handshakeAcked(): boolean {
    return this.current === "running";
  }

  /** The `initialize` handshake was sent to the live child. */
  markHandshakeSent(): void {
    if (this.current === "spawning") this.setPhase("handshaking");
  }

  /**
   * The live child acked its handshake. An ack that lands while the child is
   * being torn down moves nothing: the child is going away.
   */
  markHandshakeAcked(): void {
    if (this.current === "spawning" || this.current === "handshaking") {
      this.setPhase("running");
    }
  }

  /** Move to `next`, logging the transition. A move to the current phase is a no-op. */
  setPhase(next: ClaudeProcessPhase): void {
    if (next === this.current) return;
    const from = this.current;
    this.current = next;
    logSessionLifecycle("tugcode.process_phase", {
      session_id: this.host.sessionId(),
      from,
      to: next,
    });
  }

  /**
   * The Claude Code CLI version (`claude --version`), resolved once per spawn
   * and folded into the turn-free `session_capabilities` handshake so the
   * frontend's Claude Code badge reads a real version from the drop instead of
   * "?" until the first turn. `null` until resolved / when resolution fails.
   * claude's `initialize` response carries no version — only the post-turn
   * `system/init` does — so tugcode sources it locally, mirroring the bundled
   * plugin-command augmentation.
   */
  claudeCodeVersion: string | null = null;
  /**
   * Definitive failure classification harvested from claude's stderr
   * stream by {@link startStderrReader}. Overrides the exit watcher's
   * mode-based heuristic so a `--session-id` collision in fresh mode and a
   * stale `--resume` id are always classified by their actual cause:
   *   `"resume_failed"` ← stderr contained "No conversation found"
   *   `"collision"`     ← stderr contained "is already in use"
   *   `null`            ← nothing recognizable; fall back to mode default
   */
  stderrClassification: ClaudeStderrClassification | null = null;
  /**
   * Background task draining claude's stdout. Started by
   * {@link startStdoutDrain} and runs until claude's stdout EOFs. The
   * drain owns the only `getReader()` on the child's stdout; nothing else
   * may read claude's stdout directly. `null` between spawn lifecycles.
   */
  private stdoutDrainTask: Promise<void> | null = null;
  private readonly spawner: ClaudeSpawner;
  private readonly cwd: string;
  private readonly host: ClaudeProcessHost;

  constructor(opts: {
    /** Working directory the default spawner launches claude in. */
    cwd: string;
    host: ClaudeProcessHost;
    /** Omit → {@link spawnReal}. */
    spawner?: ClaudeSpawner;
  }) {
    this.cwd = opts.cwd;
    this.host = opts.host;
    this.spawner = opts.spawner ?? ((args, env) => this.spawnReal(args, env));
  }

  /**
   * Start a claude child from a composed argv and environment. Returns the
   * child without seating it: the caller decides whether it becomes
   * {@link child}.
   */
  launch(args: string[], env: Record<string, string | undefined>): ClaudeSubprocess {
    return this.spawner(args, env);
  }

  /**
   * The default {@link ClaudeSpawner}: resolve the `claude` binary and launch
   * it in the project directory, leading its own process group.
   */
  private spawnReal(
    args: string[],
    env: Record<string, string | undefined>,
  ): ClaudeSubprocess {
    const claudePath = resolveClaudePath();
    if (!claudePath) {
      throw new Error("claude CLI not found (PATH or ~/.local/bin)");
    }

    // Resolve the Claude Code version once per session (it is stable for a
    // given binary). Folded into the turn-free `session_capabilities`
    // handshake so the frontend's Claude Code badge reads a real version
    // from the drop.
    if (this.claudeCodeVersion === null) {
      this.claudeCodeVersion = resolveClaudeCodeVersion(claudePath);
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
      cwd: this.cwd,
      env,
      // `setsid()` before exec, the same move tugcast's shell feed makes for
      // its shells: claude leads a NEW session with NO controlling TTY and is
      // its own process-group leader (pgid == pid), so `kill(-pid, …)` reaps
      // claude AND every tool subprocess it has running — the backgrounded
      // `sleep`, the test sweep, the build. That is what makes a stop end
      // the work rather than the process that started it ([P04]). macOS
      // ships no `setsid` binary, so this option is the only route. This is
      // the one site that spawns the CLI; every respawn and the fork come
      // through it.
      detached: true,
    });
  }

  /**
   * Start the long-lived stdout drain on `child`. The drain reads claude's
   * stdout line-by-line until EOF and hands each non-empty line to
   * {@link ClaudeProcessHost.onStdoutLine}; on EOF it calls
   * {@link ClaudeProcessHost.onStdoutEnd}.
   *
   * Single-owner invariant: nothing else may call `getReader()` on the
   * child's stdout. The drain is the only reader for its lifetime.
   */
  startStdoutDrain(child: ClaudeSubprocess): void {
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    this.stdoutDrainTask = this.runStdoutDrain(reader);
  }

  /**
   * Drain loop. Reads claude's stdout one chunk at a time, splits on
   * newlines, and dispatches each non-empty line. Exits cleanly on EOF
   * (claude closed its stdout, e.g., on exit) or on read error.
   *
   * Splitting is a {@link LineSplitter}'s: multi-byte UTF-8 sequences
   * split across chunks arrive whole, lines longer than a chunk are
   * carried until their newline, and a line over the splitter's cap is
   * dropped and logged rather than carried without bound.
   */
  private async runStdoutDrain(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<void> {
    const splitter = new LineSplitter({ stream: "claude_stdout" });
    try {
      while (true) {
        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          result = await reader.read();
        } catch {
          break;
        }
        if (result.done) {
          const remaining = splitter.end()?.trim() ?? "";
          if (remaining.length > 0) this.host.onStdoutLine(remaining);
          break;
        }
        for (const raw of splitter.push(result.value)) {
          const line = raw.trim();
          if (line.length > 0) this.host.onStdoutLine(line);
        }
      }
    } finally {
      // EOF: surface to the owner so a turn that was mid-stream when claude
      // died doesn't hang on its completion promise.
      this.host.onStdoutEnd();
    }
  }

  /**
   * Read claude's stderr line-by-line, forward each line verbatim to
   * `process.stderr` (preserving the existing tugcast::tugcode_stderr
   * capture), and pattern-match the first line carrying a known
   * failure signature into {@link stderrClassification}. Returns
   * immediately if stderr is not available; runs as a detached task
   * for the lifetime of the claude subprocess.
   */
  startStderrReader(): void {
    const stderr = this.child?.stderr;
    if (!stderr) return;
    const stream = stderr as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    void (async () => {
      const splitter = new LineSplitter({ stream: "claude_stderr" });
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            const rest = splitter.end();
            if (rest !== null) process.stderr.write(rest);
            return;
          }
          for (const line of splitter.push(result.value)) {
            // Forward verbatim so tugcast::tugcode_stderr keeps seeing
            // exactly what claude wrote — operator visibility unchanged.
            process.stderr.write(line + "\n");
            // First-match-wins classification. Subsequent lines from
            // the same stderr stream don't override; the failure cause
            // is whatever claude reported first.
            if (this.stderrClassification === null) {
              if (line.includes("No conversation found with session ID")) {
                this.stderrClassification = "resume_failed";
              } else if (line.includes("is already in use")) {
                this.stderrClassification = "collision";
              }
            }
          }
        }
      } catch (err) {
        process.stderr.write(`[tugcode] stderr reader error: ${err}\n`);
      }
    })();
  }

  /**
   * End the live child and wait for its stdout drain to finish.
   *
   * Default (graceful): closes stdin (EOF) to signal claude to finish, waits
   * up to `graceMs`, then runs the signal ladder if it is still running.
   *
   * `escalate` mode: a *wedged* claude isn't servicing its stdin, so an EOF
   * won't land. Skip the graceful wait and go straight to the signal ladder —
   * SIGINT, a short {@link FORCE_TERMINATE_SIGINT_GRACE_MS} grace, then
   * SIGKILL.
   *
   * Either way the group is swept after the exit, the child handle is
   * dropped, and the old drain is awaited so its EOF `finally` has run
   * before this returns.
   */
  async terminate(opts: { escalate: boolean; graceMs: number }): Promise<void> {
    const { escalate, graceMs } = opts;
    const drainTask = this.stdoutDrainTask;
    const tearingDown = this.child !== null;
    if (this.child) {
      this.setPhase("terminating");
      const child = this.child;
      // Captured now: the handle is dropped below, and the group sweep after
      // the exit needs the pid claude led its group under.
      const pid = child.pid;
      if (escalate) {
        // Signal ladder for a wedged claude: SIGINT, brief grace, SIGKILL.
        // Group-wide, so a wedged claude's children go with it ([P04]).
        try {
          this.signalGroupOrChild(child, "SIGINT");
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
          this.signalGroupOrChild(child, "SIGKILL");
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
            this.signalGroupOrChild(child, "SIGTERM");
            const terminated = await Promise.race([
              child.exited.then(() => true),
              new Promise<boolean>((res) =>
                setTimeout(() => res(false), rungMs),
              ),
            ]);
            if (!terminated) {
              this.signalGroupOrChild(child, "SIGKILL");
              await child.exited;
            }
          } catch {
            // Already terminated.
          }
        }
      }
      // **The unconditional sweep — not redundant with the ladders above.**
      // The ladders run only for a claude that outlived its grace. A healthy
      // claude exits politely on its stdin EOF, and on that path — the one
      // every `stop_all_work` takes — nothing above ever signals it, so its
      // children would outlive the very teardown [P04] exists for. So after
      // the child has exited, on either branch and however it exited, one
      // SIGKILL to what is left of the group. `ESRCH` is the ordinary answer
      // (nothing left) and is swallowed.
      this.sweepProcessGroup(pid);
      this.child = null;
      // The drain task observes EOF on the closed stdout stream and
      // exits its loop; reset the handle so a subsequent respawn can
      // start a fresh drain without cross-contamination.
      this.stdoutDrainTask = null;
    }
    // Let the old drain finish its EOF `finally` before we return (and before
    // any respawn resets the owner's EOF state). Cheap: the reader is
    // already at EOF on a killed process.
    if (drainTask) {
      try {
        await drainTask;
      } catch {
        // Drain surfaced its own error already; nothing to do here.
      }
    }
    if (tearingDown) this.setPhase("dead");
  }

  /**
   * Signal claude's whole process group, falling back to the child alone when
   * the group is already gone. `signal` is a name so the fallback can carry
   * it unchanged.
   *
   * The group is the point ([P04]): claude leads it (`detached: true` in
   * {@link spawnReal}), so `kill(-pid, …)` reaches every tool subprocess
   * it has running. `ESRCH` on the group means no such group — a claude
   * that never became a leader, or one whose group has already emptied —
   * and the child itself is signalled instead, which is what this did
   * before it was group-wide.
   */
  private signalGroupOrChild(child: ClaudeSubprocess, signal: NodeJS.Signals): void {
    if (this.signalProcessGroup(child.pid, signal) === "gone") {
      child.kill(signal);
    }
  }

  /**
   * The post-exit sweep: one SIGKILL to whatever is left of the group claude
   * led. `ESRCH` — nothing left — is the ordinary answer and is swallowed;
   * any other refusal is logged and swallowed too, because a sweep inside a
   * teardown must never be what throws.
   */
  private sweepProcessGroup(pid: number): void {
    if (!(pid > 0)) return;
    this.signalProcessGroup(pid, "SIGKILL");
  }

  /**
   * `kill(-pid, signal)`, answered rather than thrown: `"sent"`, `"gone"`
   * (`ESRCH`), or `"failed"` (anything else, logged). The one place the
   * negative-pid form is spelled, and the one seam a test stubs — a test that
   * let this reach the OS with a made-up pid would be signalling somebody
   * else's process group.
   */
  private signalProcessGroup(
    pid: number,
    signal: NodeJS.Signals,
  ): "sent" | "gone" | "failed" {
    if (!(pid > 0)) return "gone";
    try {
      process.kill(-pid, signal);
      return "sent";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return "gone";
      console.error(`process group ${pid} refused ${signal}:`, err);
      return "failed";
    }
  }
}

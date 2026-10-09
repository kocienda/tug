// Investigation harness: JSONL flush timing.
//
// Question: when claude emits a `result` event on stdout in
// stream-json mode, has it already flushed the final assistant
// entry (the one with `stop_reason: end_turn`) to the per-session
// JSONL on disk?
//
// Methodology:
//   1. Spawn `claude` with the same arg shape `tugcode/src/session.ts`
//      uses (stream-json bidirectional, `--session-id` so the JSONL
//      path is deterministic).
//   2. Send one deterministic user message via stdin.
//   3. Capture every stdout line with a monotonic timestamp.
//   4. Concurrently poll the on-disk JSONL file every 5ms and record
//      its size, mtime, last-line type, and (when present) the last
//      assistant entry's `stop_reason`.
//   5. After the turn completes, compute:
//        t_result_stdout      — when {"type":"result"} appeared on stdout
//        t_jsonl_assistant_complete
//                             — when the JSONL first contained an
//                               assistant entry whose terminal block
//                               had stop_reason set
//        t_jsonl_settled      — when the JSONL stopped growing
//      Report all three plus the deltas.
//
// Output: a single-run JSON object on stdout, written to whatever
// the caller redirects it to. Run multiple times to get N samples.
//
// Usage:
//   bun run tugcode/scripts/investigate-jsonl-flush-timing.ts \
//     [--prompt "...prompt..."] \
//     [--cwd /path/to/project-dir] \
//     [--out /path/to/trace.json]
//
// Exit code:
//   0  — clean run; trace JSON emitted
//   1  — claude returned a non-success result OR didn't emit `result`
//        within the deadline (60s)
//   2  — claude binary unavailable / argv parse error

import { mkdirSync, statSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

interface CliArgs {
  prompt: string;
  cwd: string;
  out: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    prompt: 'reply with exactly the string FOO and nothing else',
    cwd: resolve("/tmp/e1-jsonl-flush-timing"),
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prompt") args.prompt = argv[++i];
    else if (a === "--cwd") args.cwd = resolve(argv[++i]);
    else if (a === "--out") args.out = resolve(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.error(
        "Usage: bun run investigate-jsonl-flush-timing.ts [--prompt P] [--cwd D] [--out F]",
      );
      process.exit(0);
    }
  }
  return args;
}

function encodeProjectDir(absDir: string): string {
  return absDir.replace(/\//g, "-");
}

// Wall-clock ms via Date.now(). Used for deadline checks AND for
// timestamps in the trace; the JSONL `mtime_ms` from `statSync` is
// also wall-clock, so they're directly comparable.
function nowMs(): number {
  return Date.now();
}

interface StdoutEvent {
  t_ms: number;
  type: string;
  raw: string;
}

interface JsonlSample {
  t_ms: number;
  size: number;
  mtime_ms: number;
  last_line_type: string | null;
  last_assistant_has_stop_reason: boolean | null;
  assistant_stop_reason: string | null;
}

interface RunReport {
  prompt: string;
  cwd: string;
  session_id: string;
  jsonl_path: string;
  spawn_t_ms: number;
  exit_code: number | null;
  stdout: StdoutEvent[];
  stderr: string;
  jsonl_samples: JsonlSample[];
  derived: {
    t_result_stdout_ms: number | null;
    t_jsonl_assistant_complete_ms: number | null;
    t_jsonl_settled_ms: number | null;
    delta_jsonl_complete_minus_result_ms: number | null;
    delta_jsonl_settled_minus_result_ms: number | null;
  };
  notes: string[];
}

function readJsonlSnapshot(path: string, t_ms: number): JsonlSample {
  let size = 0;
  let mtime_ms = 0;
  try {
    const s = statSync(path);
    size = s.size;
    mtime_ms = Math.floor(s.mtimeMs);
  } catch {
    return {
      t_ms,
      size: 0,
      mtime_ms: 0,
      last_line_type: null,
      last_assistant_has_stop_reason: null,
      assistant_stop_reason: null,
    };
  }
  let lastLineType: string | null = null;
  let lastAssistantHasStop: boolean | null = null;
  let assistantStopReason: string | null = null;
  // Scan ALL lines for an `assistant` entry whose `stop_reason` is
  // set — claude writes additional non-assistant lines after the
  // turn (`last-prompt`, `ai-title`) so checking only the tail
  // misses the moment of interest. Capture the first such entry's
  // stop_reason so the snapshot reports it accurately.
  try {
    const content = readFileSync(path, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length > 0) {
      try {
        const parsedLast = JSON.parse(lines[lines.length - 1]) as { type?: string };
        lastLineType = parsedLast.type ?? null;
      } catch {
        // partial last line — leave lastLineType null
      }
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as {
            type?: string;
            message?: {
              role?: string;
              stop_reason?: string | null;
              content?: Array<{ type: string }>;
            };
          };
          if (
            parsed.type === "assistant" &&
            parsed.message &&
            typeof parsed.message.stop_reason === "string" &&
            parsed.message.stop_reason.length > 0
          ) {
            lastAssistantHasStop = true;
            assistantStopReason = parsed.message.stop_reason;
            break;
          }
        } catch {
          // partial / unparseable line — skip
        }
      }
      if (lastAssistantHasStop === null) {
        // Distinguish "no assistant-with-stop yet" (false) from
        // "file unreadable" (null). The non-empty branch reaches
        // here only when no qualifying assistant entry was found.
        lastAssistantHasStop = false;
      }
    }
  } catch {
    // file disappeared mid-read; report what stat gave us
  }
  return {
    t_ms,
    size,
    mtime_ms,
    last_line_type: lastLineType,
    last_assistant_has_stop_reason: lastAssistantHasStop,
    assistant_stop_reason: assistantStopReason,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sessionId = crypto.randomUUID();
  const claudeProjectsRoot = join(homedir(), ".claude", "projects");

  // Ensure cwd exists, then canonicalize. Claude internally calls
  // getcwd() which resolves symlinks; on macOS /tmp -> /private/tmp,
  // so the JSONL path under ~/.claude/projects/ is encoded from the
  // canonical form. Match that here.
  mkdirSync(args.cwd, { recursive: true });
  const canonicalCwd = realpathSync(args.cwd);
  const jsonlPathCanonical = join(
    claudeProjectsRoot,
    encodeProjectDir(canonicalCwd),
    `${sessionId}.jsonl`,
  );

  const claudePath = Bun.which("claude");
  if (!claudePath) {
    console.error("claude binary not found on PATH");
    process.exit(2);
  }

  const argv = [
    claudePath,
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages",
    "--model", "claude-haiku-4-5",
    "--permission-mode", "default",
    "--session-id", sessionId,
  ];

  const notes: string[] = [];
  const stdoutEvents: StdoutEvent[] = [];
  const jsonlSamples: JsonlSample[] = [];

  const spawnT = nowMs();

  // Build a clean env. Filter out auth env vars (matches tugcode's
  // session.ts spawn) so claude uses ~/.claude.json subscription auth.
  // Important: rebuild as a fresh object — Bun.spawn treats `undefined`
  // values as empty strings rather than absent, so a destructure-and-
  // spread does NOT actually remove the key.
  const scrubbedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (
      k === "ANTHROPIC_API_KEY" ||
      k === "ANTHROPIC_AUTH_TOKEN" ||
      k === "CLAUDE_CODE_OAUTH_TOKEN"
    ) continue;
    if (typeof v === "string") scrubbedEnv[k] = v;
  }

  const proc = Bun.spawn(argv, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: args.cwd,
    env: scrubbedEnv,
  });

  // Drain stderr concurrently so we can surface any auth / CLI
  // errors in the report rather than missing them entirely.
  const stderrChunks: string[] = [];
  const stderrDrain = (async () => {
    const r = proc.stderr.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await r.read();
        if (done) break;
        stderrChunks.push(dec.decode(value, { stream: true }));
      }
    } catch {
      // ignore
    } finally {
      try { r.releaseLock(); } catch { /* */ }
    }
  })();

  // Send the user_message in stream-json input format.
  const userInput = JSON.stringify({
    type: "user",
    session_id: "",
    message: {
      role: "user",
      content: [{ type: "text", text: args.prompt }],
    },
    parent_tool_use_id: null,
  }) + "\n";
  proc.stdin.write(userInput);
  proc.stdin.flush();
  // Send EOF so claude processes the one queued turn and exits, the
  // same way the `echo "..." | claude --output-format stream-json`
  // manual smoke does. Without EOF, claude waits for more stream-json
  // input and never emits the `result` event we're looking for.
  // tugcode keeps stdin open for an indefinite session of turns; the
  // investigation harness exercises a single turn so EOF is the right
  // termination signal here.
  proc.stdin.end();

  // Concurrent JSONL polling. Sample every 5ms.
  let pollerStop = false;
  const poller = (async () => {
    while (!pollerStop) {
      jsonlSamples.push(readJsonlSnapshot(jsonlPathCanonical, nowMs()));
      await Bun.sleep(5);
    }
    // Final sample post-poller-stop so the trace shows the settled
    // file state.
    jsonlSamples.push(readJsonlSnapshot(jsonlPathCanonical, nowMs()));
  })();

  // Stdout reader.
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let buf = "";
  let sawResult = false;
  const deadline = nowMs() + 60_000;
  let exitCode: number | null = null;
  try {
    readLoop: while (nowMs() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      while (buf.includes("\n")) {
        const idx = buf.indexOf("\n");
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim().length === 0) continue;
        const t = nowMs();
        let type = "<unparseable>";
        try {
          const parsed = JSON.parse(line) as { type?: string };
          type = parsed.type ?? "<no-type>";
        } catch {
          // keep the raw line for the trace
        }
        stdoutEvents.push({ t_ms: t, type, raw: line });
        if (type === "result") {
          sawResult = true;
          // Wait briefly to also catch any post-result events
          // (system: end_turn flush, etc.) before stopping.
          break readLoop;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }

  if (!sawResult) {
    notes.push("No `result` event observed within 60s deadline.");
  }

  // Wait for JSONL to settle (no growth for 200ms straight) or
  // 2s max after `result` arrived.
  const settleDeadline = nowMs() + 2000;
  let lastSize = -1;
  let lastChangeT = nowMs();
  while (nowMs() < settleDeadline) {
    const s = readJsonlSnapshot(jsonlPathCanonical, nowMs());
    if (s.size !== lastSize) {
      lastSize = s.size;
      lastChangeT = s.t_ms;
    } else if (s.t_ms - lastChangeT >= 200) {
      break;
    }
    await Bun.sleep(5);
  }

  pollerStop = true;
  await poller;

  // Tear down claude.
  try {
    proc.stdin.end();
  } catch {
    // already closed
  }
  try {
    exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 5000)),
    ]);
  } catch {
    exitCode = -1;
  }
  if (exitCode === -1) {
    notes.push("claude did not exit within 5s after stdin EOF; killed.");
    proc.kill();
  }

  // Derived timings.
  const resultEvent = stdoutEvents.find((e) => e.type === "result");
  const t_result_stdout_ms = resultEvent ? resultEvent.t_ms : null;

  // The first sample where the JSONL contained any `assistant`
  // entry with a non-null `stop_reason`. The `last_line_type` may
  // be a trailing `last-prompt` / `ai-title` line claude writes
  // after the turn, so don't condition on it.
  const firstCompleteSample = jsonlSamples.find(
    (s) => s.last_assistant_has_stop_reason === true,
  );
  const t_jsonl_assistant_complete_ms = firstCompleteSample
    ? firstCompleteSample.t_ms
    : null;

  // "Settled" = first sample where size matches the final size.
  let t_jsonl_settled_ms: number | null = null;
  if (jsonlSamples.length > 0) {
    const finalSize = jsonlSamples[jsonlSamples.length - 1].size;
    if (finalSize > 0) {
      const firstAtFinal = jsonlSamples.find((s) => s.size === finalSize);
      t_jsonl_settled_ms = firstAtFinal ? firstAtFinal.t_ms : null;
    }
  }

  const delta_complete = t_result_stdout_ms !== null && t_jsonl_assistant_complete_ms !== null
    ? t_jsonl_assistant_complete_ms - t_result_stdout_ms
    : null;
  const delta_settled = t_result_stdout_ms !== null && t_jsonl_settled_ms !== null
    ? t_jsonl_settled_ms - t_result_stdout_ms
    : null;

  await stderrDrain;
  const stderrText = stderrChunks.join("");
  if (stderrText.length > 0) {
    notes.push(`stderr captured (${stderrText.length} bytes)`);
  }

  const report: RunReport = {
    prompt: args.prompt,
    cwd: args.cwd,
    session_id: sessionId,
    jsonl_path: jsonlPathCanonical,
    spawn_t_ms: spawnT,
    exit_code: exitCode,
    stdout: stdoutEvents,
    stderr: stderrText,
    jsonl_samples: jsonlSamples,
    derived: {
      t_result_stdout_ms,
      t_jsonl_assistant_complete_ms,
      t_jsonl_settled_ms,
      delta_jsonl_complete_minus_result_ms: delta_complete,
      delta_jsonl_settled_minus_result_ms: delta_settled,
    },
    notes,
  };

  const out = JSON.stringify(report, null, 2);
  if (args.out) {
    await Bun.write(args.out, out);
    console.error(`Wrote report to ${args.out}`);
  } else {
    console.log(out);
  }

  // Exit non-zero if the run was incomplete so callers can detect.
  if (!sawResult || exitCode !== 0) {
    process.exit(1);
  }
  // Also non-zero if the JSONL never showed an assistant-complete
  // entry (claude couldn't be reached / broken in some unrelated way).
  if (existsSync(jsonlPathCanonical) && t_jsonl_assistant_complete_ms === null) {
    notes.push("JSONL never recorded an assistant entry with a stop_reason.");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Harness failed:", err);
  process.exit(2);
});

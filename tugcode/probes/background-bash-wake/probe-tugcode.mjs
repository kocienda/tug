#!/usr/bin/env bun
// Probe tugcode end-to-end for [Q01]: what does the live SDK send when a
// backgrounded Bash command completes, and what does tugcode forward?
//
// Adapted from `../wake-investigation/probe-tugcode.mjs`. Same shape — spawn
// the real tugcode binary, hand it one `user_message` over stdin, hold the
// process, and keep every byte of stdout and stderr — with three changes the
// question needs:
//
//   1. The prompt launches a backgrounded Bash command rather than a
//      ScheduleWakeup, because the incident's six turn-ends were background
//      completions (see `#incident-as-frames`).
//   2. The hold is measured from the FIRST `turn_complete`, not from the
//      prompt, so the capture is guaranteed to span the whole gap between the
//      turn the launch ended and whatever the completion opens.
//   3. It captures three views rather than one, because no single view holds
//      the whole answer. tugcode's stdout is what the runner and the deck
//      actually see. claude's persisted JSONL holds the `<task-notification>`
//      envelope, which tugcode forwards nowhere — it forwards `user` events
//      only as `tool_result` / `goal_feedback` / `compact_summary` /
//      `prompt_anchor`. And a second phase spawns claude directly with
//      tugcode's own args to keep the raw system events verbatim, which is
//      the only place `background_tasks_changed` survives at all (tugcode
//      logs it as an unhandled subtype and drops it). Step 5's tests quote
//      these lines, so paraphrase is not good enough.
//
// Usage: bun probe-tugcode.mjs [hold_after_turn_complete_sec]
//
// Both phases make a live model call, so a run costs two of them.

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Hold this long AFTER the first `turn_complete`. The plan asks for at least
// 30s; the default leaves room for the 8s sleep plus a slow wake.
const HOLD_AFTER_TURN_SEC = Number(process.argv[2] ?? 45);
// A ceiling so a probe that never sees `turn_complete` still terminates.
const MAX_TOTAL_SEC = 240;

const OUT_DIR = dirname(fileURLToPath(import.meta.url));
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const BASE = `capture-bgbash-${TIMESTAMP}`;

const SESSION_ID = crypto.randomUUID();
const PROJECT_DIR = "/private/tmp/background-bash-wake";
// The scratch project's claude-projects slug, for finding the JSONL after.
const PROJECT_SLUG = "-private-tmp-background-bash-wake";
// The built binary. Prefer this checkout's debug build; fall back to the one
// in the app bundle, which is what a release checkout has.
const CANDIDATE_BINS = [
  join(OUT_DIR, "..", "..", "..", "tugrust", "target", "debug", "tugcode"),
  process.env.TUG_BUNDLE_PATH
    ? join(process.env.TUG_BUNDLE_PATH, "Contents", "MacOS", "tugcode")
    : null,
].filter((p) => p !== null);
const TUGCODE_BIN = CANDIDATE_BINS.find((p) => existsSync(p));
if (!TUGCODE_BIN) {
  console.error(`[probe] no tugcode binary found; looked at:\n  ${CANDIDATE_BINS.join("\n  ")}`);
  process.exit(2);
}

// A scratch data root so the probe touches no real ledger.
const DATA_ROOT = "/private/tmp/background-bash-wake-data";
mkdirSync(PROJECT_DIR, { recursive: true });
mkdirSync(DATA_ROOT, { recursive: true });

console.error(`[probe] tugcode binary: ${TUGCODE_BIN}`);
console.error(`[probe] session=${SESSION_ID} hold_after_turn=${HOLD_AFTER_TURN_SEC}s`);

const env = { ...process.env };
// Subscription auth, as the sibling probes do.
delete env.ANTHROPIC_API_KEY;
delete env.ANTHROPIC_AUTH_TOKEN;
delete env.CLAUDE_CODE_OAUTH_TOKEN;
// Do not let the probe inherit the arc session it is being run from.
delete env.TUG_SESSION_ID;
delete env.TUG_ARC;
env.TUG_DATA_DIR = DATA_ROOT;
env.TUG_SESSIONS_DB = join(DATA_ROOT, "sessions.db");

const proc = spawn(
  TUGCODE_BIN,
  [
    "--dir", PROJECT_DIR,
    "--session-id", SESSION_ID,
    "--session-mode", "new",
  ],
  { cwd: PROJECT_DIR, env, stdio: ["pipe", "pipe", "pipe"] },
);

const stdoutLines = [];
const stderrLines = [];

// Resolves at the first `turn_complete` frame on stdout.
let firstTurnCompleteAt = null;
let signalTurnComplete = () => {};
const turnComplete = new Promise((r) => { signalTurnComplete = r; });

proc.stdout.on("data", (chunk) => {
  const t = new Date().toISOString();
  for (const line of chunk.toString().split("\n")) {
    if (line.length === 0) continue;
    stdoutLines.push(`${t}\t${line}`);
    if (firstTurnCompleteAt === null && line.includes('"turn_complete"')) {
      firstTurnCompleteAt = t;
      console.error(`[probe] first turn_complete at ${t}`);
      signalTurnComplete();
    }
  }
});
proc.stderr.on("data", (chunk) => {
  const t = new Date().toISOString();
  for (const line of chunk.toString().split("\n")) {
    if (line.length > 0) stderrLines.push(`${t}\t${line}`);
  }
});

let exited = false;
proc.on("exit", (code, signal) => {
  exited = true;
  console.error(`[probe] tugcode exited code=${code} signal=${signal}`);
});

const flush = () => {
  writeFileSync(`${OUT_DIR}/${BASE}.stdout`, stdoutLines.join("\n") + "\n");
  writeFileSync(`${OUT_DIR}/${BASE}.stderr`, stderrLines.join("\n") + "\n");
};
const flushTick = setInterval(flush, 10_000);
process.on("SIGINT", () => { flush(); try { proc.kill("SIGTERM"); } catch {} process.exit(0); });

// Wait for tugcode to spin up, then send protocol_init, the permission mode,
// and the user_message.
await new Promise((r) => setTimeout(r, 1500));
proc.stdin.write(JSON.stringify({ type: "protocol_init", version: 1 }) + "\n");

// tugcode spawns claude with `--permission-mode default`, under which the Bash
// call would sit on a `can_use_tool` request the probe never answers and the
// turn would end having launched nothing. Bypass it: the probe is measuring
// what the SDK emits around a launch, not the approval path.
proc.stdin.write(JSON.stringify({
  type: "permission_mode",
  mode: "bypassPermissions",
}) + "\n");

await new Promise((r) => setTimeout(r, 500));

// One prompt: launch a backgrounded Bash command, then end the turn. The turn
// has to END for the question to mean anything — the incident's frames are
// what arrives BETWEEN one turn ending and the next beginning.
const PROMPT =
  "Run the command `sleep 8 && echo background-done` using the Bash tool with " +
  "run_in_background set to true. Do not wait for it and do not check on it. " +
  "As soon as the tool call returns, reply with exactly the single word " +
  "\"launched\" and nothing else, and end your turn.";

proc.stdin.write(JSON.stringify({
  type: "user_message",
  content: [{ type: "text", text: PROMPT }],
}) + "\n");
console.error("[probe] sent user_message");

const startMs = Date.now();
const tick = setInterval(() => {
  const elapsed = Math.floor((Date.now() - startMs) / 1000);
  console.error(`[probe] elapsed=${elapsed}s stdout=${stdoutLines.length} stderr=${stderrLines.length}`);
}, 15_000);

// Hold from the first turn_complete, with a hard ceiling either way.
const ceiling = new Promise((r) => setTimeout(r, MAX_TOTAL_SEC * 1000));
await Promise.race([turnComplete, ceiling]);
if (firstTurnCompleteAt === null) {
  console.error("[probe] WARNING: no turn_complete seen; holding to the ceiling");
}
await Promise.race([
  new Promise((r) => setTimeout(r, HOLD_AFTER_TURN_SEC * 1000)),
  ceiling,
]);
clearInterval(tick);
clearInterval(flushTick);

if (!exited) {
  console.error("[probe] hold done — killing tugcode");
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 2000));
  if (!exited) proc.kill("SIGKILL");
}

flush();

// claude's persisted view of the same session — the only place a `user`-role
// envelope tugcode did not forward can still be read verbatim.
const jsonlPath = join(homedir(), ".claude", "projects", PROJECT_SLUG, `${SESSION_ID}.jsonl`);
if (existsSync(jsonlPath)) {
  writeFileSync(`${OUT_DIR}/${BASE}.jsonl`, readFileSync(jsonlPath, "utf8"));
  console.error(`[probe] copied claude JSONL ${jsonlPath} -> ${BASE}.jsonl`);
} else {
  console.error(`[probe] NO JSONL at ${jsonlPath}`);
}

// ---------------------------------------------------------------------------
// Phase 2: the raw claude wire.
//
// tugcode is a lossy view on purpose. `background_tasks_changed` is logged as
// an unhandled subtype and forwarded nowhere, and the `<task-notification>`
// envelope reaches the model as a `user` event tugcode does not forward
// either — so neither survives verbatim in phase 1's captures, and the JSONL
// holds the envelope but no system event at all. Spawn claude directly with
// tugcode's own args (`buildClaudeArgs`, tugcode/src/session.ts) and keep
// every byte, so Step 5's tests can quote the lines rather than paraphrase.
// ---------------------------------------------------------------------------

const RAW_SESSION_ID = crypto.randomUUID();
const rawArgs = [
  "--output-format", "stream-json",
  "--input-format", "stream-json",
  "--verbose",
  "--permission-prompt-tool", "stdio",
  "--include-partial-messages",
  "--replay-user-messages",
  "--permission-mode", "bypassPermissions",
  "--session-id", RAW_SESSION_ID,
];
console.error(`[probe/raw] spawning: claude ${rawArgs.join(" ")}`);

const rawProc = spawn("claude", rawArgs, { cwd: PROJECT_DIR, env, stdio: ["pipe", "pipe", "pipe"] });
const rawLines = [];
let rawFirstResultAt = null;
let signalRawResult = () => {};
const rawResult = new Promise((r) => { signalRawResult = r; });
rawProc.stdout.on("data", (chunk) => {
  const t = new Date().toISOString();
  for (const line of chunk.toString().split("\n")) {
    if (line.length === 0) continue;
    rawLines.push(`${t}\t${line}`);
    if (rawFirstResultAt === null && line.includes('"type":"result"')) {
      rawFirstResultAt = t;
      signalRawResult();
    }
  }
});
rawProc.stderr.on("data", (chunk) => {
  const t = new Date().toISOString();
  for (const line of chunk.toString().split("\n")) {
    if (line.length > 0) rawLines.push(`${t}\tSTDERR\t${line}`);
  }
});
let rawExited = false;
rawProc.on("exit", () => { rawExited = true; });

await new Promise((r) => setTimeout(r, 500));
rawProc.stdin.write(JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "text", text: PROMPT }] },
}) + "\n");

await Promise.race([rawResult, new Promise((r) => setTimeout(r, 90_000))]);
await new Promise((r) => setTimeout(r, HOLD_AFTER_TURN_SEC * 1000));
if (!rawExited) {
  rawProc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 2000));
  if (!rawExited) rawProc.kill("SIGKILL");
}
writeFileSync(`${OUT_DIR}/${BASE}.raw.stdout`, rawLines.join("\n") + "\n");
console.error(`[probe/raw] ${rawLines.length} lines -> ${BASE}.raw.stdout`);

writeFileSync(`${OUT_DIR}/${BASE}.meta`, JSON.stringify({
  sessionId: SESSION_ID,
  tugcodeBin: TUGCODE_BIN,
  projectDir: PROJECT_DIR,
  prompt: PROMPT,
  holdAfterTurnCompleteSec: HOLD_AFTER_TURN_SEC,
  firstTurnCompleteAt,
  stdoutLines: stdoutLines.length,
  stderrLines: stderrLines.length,
  rawSessionId: RAW_SESSION_ID,
  rawStdoutLines: rawLines.length,
}, null, 2) + "\n");

console.error(`[probe] done -> ${BASE}.{stdout,stderr,jsonl,meta,raw.stdout}`);

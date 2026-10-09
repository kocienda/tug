#!/usr/bin/env bun
/**
 * Probe: CASE A interrupt — send user_message, then interrupt
 * BEFORE any content frame from claude arrives. Observe what
 * tugcode emits on stdout for the aborted cycle.
 *
 * Hypothesis: claude's SDK either (a) emits a `turn_complete` with
 * `result: "error"` and some `msg_id`, or (b) emits a turn_cancelled,
 * or (c) emits nothing at all and the active turn closes silently.
 *
 * The reducer's CASE A suppression strategy depends on which.
 */

import { spawn } from "bun";
import { resolve } from "path";

const PROJECT_DIR = resolve(import.meta.dir, "..");

console.log("=== CASE A Interrupt Probe ===\n");

const proc = spawn({
  cmd: ["bun", "run", "tugcode/src/main.ts", "--dir", PROJECT_DIR],
  cwd: PROJECT_DIR,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

// Drain stderr
(async () => {
  const decoder = new TextDecoder();
  for await (const chunk of proc.stderr) {
    for (const line of decoder.decode(chunk, { stream: true }).split("\n").filter(Boolean)) {
      console.log(`  [log] ${line}`);
    }
  }
})();

function send(msg: object) {
  const json = JSON.stringify(msg) + "\n";
  console.log(`>>> ${JSON.stringify(msg)}`);
  proc.stdin.write(json);
}

let messageSent = false;
let interruptSent = false;
const wireFramesSinceInterrupt: string[] = [];

setTimeout(() => {
  console.log("\n[60s timeout]");
  console.log(`\nFrames received post-interrupt: ${wireFramesSinceInterrupt.length}`);
  for (const t of wireFramesSinceInterrupt) console.log(`  - ${t}`);
  proc.kill();
  process.exit(1);
}, 60_000);

send({ type: "protocol_init", version: 1 });

const decoder = new TextDecoder();
let buffer = "";

for await (const chunk of proc.stdout) {
  buffer += decoder.decode(chunk, { stream: true });

  let lineEnd = buffer.indexOf("\n");
  while (lineEnd >= 0) {
    const line = buffer.slice(0, lineEnd).trim();
    buffer = buffer.slice(lineEnd + 1);

    if (line.length > 0) {
      try {
        const msg = JSON.parse(line);
        const type = msg.type || "unknown";

        if (type === "system_metadata") {
          console.log(`<<< ${type} (omitted for brevity)`);
        } else if (type === "cost_update") {
          console.log(`<<< ${type}: $${msg.total_cost_usd?.toFixed(4)} (${msg.num_turns} turns)`);
        } else {
          console.log(`<<< ${JSON.stringify(msg)}`);
        }

        if (interruptSent) {
          wireFramesSinceInterrupt.push(`${type} ${JSON.stringify(msg).slice(0, 120)}`);
        }

        if (type === "session_init" && !messageSent) {
          messageSent = true;
          console.log("\n--- Sending user_message + immediate interrupt ---");
          send({
            type: "user_message",
            text: "Write a detailed 500-word essay about the history of computing.",
            attachments: [],
          });
          // Send interrupt IMMEDIATELY (same tick, before any stdout
          // could come back) so we test the no-content abort path.
          send({ type: "interrupt" });
          interruptSent = true;
          console.log("");
        }

        if (type === "turn_complete" || type === "turn_cancelled") {
          console.log("\n--- Terminal frame received ---");
          console.log(`Total frames after interrupt: ${wireFramesSinceInterrupt.length}`);
          for (const t of wireFramesSinceInterrupt) console.log(`  - ${t}`);
          proc.kill();
          process.exit(0);
        }
      } catch {
        console.log(`<<< RAW: ${line}`);
      }
    }

    lineEnd = buffer.indexOf("\n");
  }
}

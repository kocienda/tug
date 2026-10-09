#!/usr/bin/env bun
/**
 * Transport probe — spawns tugcode directly, sends a basic message,
 * and dumps every event that comes back.
 *
 * Usage: bun run tugcode/probe.ts [message]
 * Default message: "Say hello in exactly 5 words."
 */

import { spawn } from "bun";
import { resolve } from "path";

const PROJECT_DIR = resolve(import.meta.dir, "..");
const message = Bun.argv[2] || "Say hello in exactly 5 words.";

console.log("=== Tugtalk Transport Probe ===");
console.log(`Message: "${message}"\n`);

const proc = spawn({
  cmd: ["bun", "run", "tugcode/src/main.ts", "--dir", PROJECT_DIR],
  cwd: PROJECT_DIR,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

// Drain stderr in background
(async () => {
  const decoder = new TextDecoder();
  for await (const chunk of proc.stderr) {
    for (const line of decoder.decode(chunk, { stream: true }).split("\n").filter(Boolean)) {
      console.log(`  [log] ${line}`);
    }
  }
})();

// Send JSON-line to stdin
function send(msg: object) {
  const json = JSON.stringify(msg) + "\n";
  console.log(`>>> ${JSON.stringify(msg)}`);
  proc.stdin.write(json);
}

// Track state
let messageSent = false;
let gotTurnComplete = false;

// Overall timeout
const TIMEOUT = 60_000;
setTimeout(() => {
  console.log("\n[timeout — killing process]");
  proc.kill();
  process.exit(1);
}, TIMEOUT);

// Single reader loop — process every stdout line
const decoder = new TextDecoder();
let buffer = "";

// Step 1: send handshake immediately
send({ type: "protocol_init", version: 1 });

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

        if (type === "assistant_text") {
          const preview = (msg.text || "").slice(-120);
          const len = (msg.text || "").length;
          console.log(`<<< ${type} [partial=${msg.is_partial}, status=${msg.status}, len=${len}] "...${preview}"`);
        } else if (type === "cost_update") {
          console.log(`<<< ${type}: $${msg.total_cost_usd?.toFixed(4)} (${msg.num_turns} turns)`);
        } else {
          console.log(`<<< ${type}: ${JSON.stringify(msg)}`);
        }

        // After session_init, send the user message
        if (type === "session_init" && !messageSent) {
          messageSent = true;
          console.log(`\n--- Sending user message ---`);
          send({ type: "user_message", text: message, attachments: [] });
          console.log("");
        }

        // After turn_complete, we're done
        if (type === "turn_complete") {
          gotTurnComplete = true;
          console.log("\n--- Turn complete. Cleaning up. ---");
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

if (!gotTurnComplete) {
  console.log("\n[stdout closed without turn_complete]");
  process.exit(1);
}

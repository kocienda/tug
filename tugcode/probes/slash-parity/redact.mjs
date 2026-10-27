#!/usr/bin/env bun
// Redact a probe capture before it is committed.
//
// `/doctor` is a bundled skill that reads the machine it runs on — the user's
// `~/.claude.json`, `~/.claude/settings.json`, plugin stores, transcripts — and
// those reads land in the capture as tool results. They are the user's setup,
// not evidence about the command, so this pass replaces every tool result's
// content with a marker giving its length, and drops `stream_event` lines (the
// partial-message deltas, which repeat the assistant text the capture already
// carries whole). Every other event is kept verbatim, including each tool call
// `/doctor` made, which is the evidence.
//
// Usage: bun redact.mjs <capture.stdout> — rewrites the file in place.

import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun redact.mjs <capture.stdout>");
  process.exit(1);
}

let dropped = 0;
let elided = 0;
const out = [];
for (const line of readFileSync(path, "utf-8").split("\n")) {
  if (!line) continue;
  const tab = line.indexOf("\t");
  const stamp = line.slice(0, tab);
  let event;
  try {
    event = JSON.parse(line.slice(tab + 1));
  } catch {
    out.push(line);
    continue;
  }
  if (event.type === "stream_event") {
    dropped++;
    continue;
  }
  if (event.type === "user" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block.type !== "tool_result") continue;
      const size = JSON.stringify(block.content ?? "").length;
      block.content = `[redacted: ${size} chars of the probing machine's local setup]`;
      elided++;
    }
  }
  if (event.type === "user" && event.tool_use_result !== undefined) {
    event.tool_use_result = "[redacted]";
  }
  out.push(`${stamp}\t${JSON.stringify(event)}`);
}
writeFileSync(path, out.join("\n") + "\n");
console.error(`[redact] ${path}: dropped ${dropped} stream_event lines, elided ${elided} tool results`);

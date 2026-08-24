#!/usr/bin/env bun
/**
 * audit-claude-sessions.ts — Empirical analysis of the local Claude Code session
 * corpus. Drives the threshold calibrations and tool-coverage decisions for
 * dev-assistant rendering.
 *
 * The script streams every `*.jsonl` file under
 * `~/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/` (~1k+ files,
 * ~2 GB), parses each line as JSON, and emits frequency / distribution
 * summaries. Output is written as both:
 *
 *   - JSON at `dash/dev-assistant-rendering-session-audit.json` (machine readable,
 *     useful as a future drift baseline)
 *   - A markdown digest written by hand into
 *     `dash/dev-assistant-rendering-session-audit.md`
 *
 * Note on data shape:
 *   This script reads Claude Code's *session-log* format (JSONL files written by
 *   the CLI to its own state directory), which is RELATED to but DISTINCT from
 *   the stream-json wire format cataloged at
 *   `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/`.
 *
 *   Mapping:
 *     session log                        ↔  stream-json
 *     ──────────────────────────────────────────────────────────────────────
 *     assistant.message.content[text]    →  assistant_text
 *     assistant.message.content[thinking]→  thinking_text
 *     assistant.message.content[tool_use]→  tool_use
 *     user.message.content[tool_result]  →  tool_result (no separate _structured)
 *     user.message.content[image]        →  inbound image attachment
 *
 *   Things NOT in session logs:
 *     - control_request_forward (permission / question events) — these are wire
 *       events; the session log only captures the resolved outcome
 *     - cost_update (per-turn) — captured separately at session level if at all
 *     - tool_use_structured (the typed wrapper) — the session log has the raw
 *       tool_result text only
 *
 *   So this audit calibrates: tool frequency, tool input/output sizes, fenced
 *   code-block language frequency, error rates per tool, sub-agent depth.
 *   It does NOT calibrate: permission frequency, AskUserQuestion frequency,
 *   structured-shape coverage. Those need wire-level capture instrumentation
 *   to measure (out of scope for this audit).
 *
 * Usage:
 *   bun run tugdeck/scripts/audit-claude-sessions.ts                # full run
 *   bun run tugdeck/scripts/audit-claude-sessions.ts --sample 100   # sample N files
 *   bun run tugdeck/scripts/audit-claude-sessions.ts --json out.json
 *
 * The script is deletable after the audit per the plan; the durable artifact is
 * the audit markdown.
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import os from "os";

// ---------------------------------------------------------------------------
// Paths and CLI
// ---------------------------------------------------------------------------

const SESSIONS_DIR = path.join(
  os.homedir(),
  ".claude",
  "projects",
  "-Users-kocienda-Mounts-u-src-tugtool",
);

interface CliArgs {
  sample: number | null;
  jsonOut: string | null;
}

function parseArgs(): CliArgs {
  const args: CliArgs = { sample: null, jsonOut: null };
  for (let i = 2; i < process.argv.length; i += 1) {
    const a = process.argv[i];
    if (a === "--sample") {
      args.sample = Number(process.argv[i + 1]);
      i += 1;
    } else if (a === "--json") {
      args.jsonOut = process.argv[i + 1];
      i += 1;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Aggregator state — accumulated across all sessions.
// ---------------------------------------------------------------------------

interface Aggregator {
  filesRead: number;
  filesSkipped: number;
  totalLines: number;
  parseErrors: number;
  // Top-level event counts per session log ('assistant' / 'user' / etc.)
  topLevelTypes: Record<string, number>;
  // Inner content-block counts (assistant / user message.content[].type)
  assistantContentTypes: Record<string, number>;
  userContentTypes: Record<string, number>;
  // tool_use frequency by tool name
  toolUseCounts: Record<string, number>;
  // tool_result outcomes per tool name (joined via tool_use_id within session)
  toolResultErrorCounts: Record<string, number>;
  toolResultOkCounts: Record<string, number>;
  // tool_use input string-length samples per tool
  toolInputLengths: Record<string, number[]>;
  // tool_result content string-length samples per tool
  toolResultLengths: Record<string, number[]>;
  // tool_result line counts (newline-delimited) per tool
  toolResultLineCounts: Record<string, number[]>;
  // Read-specific: numLines parsed from result text "Showing N of M lines"-like patterns
  readNumLines: number[];
  // Edit-specific: old_string and new_string line counts from tool_use.input
  editOldLines: number[];
  editNewLines: number[];
  // Glob-specific: result count parsed from "Found N files" or content array length
  globResultCounts: number[];
  // Bash-specific: stdout line count from tool_result content
  bashStdoutLines: number[];
  // Fenced code-block lang counts in assistant text content
  fencedLangs: Record<string, number>;
  // is_question true / false (always 0 in session log; documented limitation)
  questionTrue: number;
  questionFalse: number;
  // Sub-agent depth observed via tool_use.caller chains within a session
  // (collected per-session, max recorded here)
  maxAgentDepth: number;
  // Sessions with at least one Task/Agent invocation
  sessionsWithAgent: number;
  // Sessions with at least one Mermaid block
  sessionsWithMermaid: number;
  // Sessions with at least one math fence
  sessionsWithMath: number;
  // Total sessions audited
  totalSessions: number;
}

function newAggregator(): Aggregator {
  return {
    filesRead: 0,
    filesSkipped: 0,
    totalLines: 0,
    parseErrors: 0,
    topLevelTypes: {},
    assistantContentTypes: {},
    userContentTypes: {},
    toolUseCounts: {},
    toolResultErrorCounts: {},
    toolResultOkCounts: {},
    toolInputLengths: {},
    toolResultLengths: {},
    toolResultLineCounts: {},
    readNumLines: [],
    editOldLines: [],
    editNewLines: [],
    globResultCounts: [],
    bashStdoutLines: [],
    fencedLangs: {},
    questionTrue: 0,
    questionFalse: 0,
    maxAgentDepth: 0,
    sessionsWithAgent: 0,
    sessionsWithMermaid: 0,
    sessionsWithMath: 0,
    totalSessions: 0,
  };
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function pushSample(map: Record<string, number[]>, key: string, val: number): void {
  if (!map[key]) map[key] = [];
  map[key].push(val);
}

// ---------------------------------------------------------------------------
// Per-session state (resets between files).
// Tracks tool_use_id → tool_name so tool_result can be joined back to its tool.
// ---------------------------------------------------------------------------

interface SessionState {
  toolUseIdToName: Map<string, string>;
  toolUseIdToInput: Map<string, unknown>;
  hasAgent: boolean;
  hasMermaid: boolean;
  hasMath: boolean;
  // Subagent depth tracking via caller chains
  maxDepth: number;
}

function newSessionState(): SessionState {
  return {
    toolUseIdToName: new Map(),
    toolUseIdToInput: new Map(),
    hasAgent: false,
    hasMermaid: false,
    hasMath: false,
    maxDepth: 0,
  };
}

// ---------------------------------------------------------------------------
// Content-block processing
// ---------------------------------------------------------------------------

const FENCE_RE = /^```([a-zA-Z0-9_+-]*)/gm;

function processAssistantText(text: string, agg: Aggregator, ses: SessionState): void {
  // Count fenced code blocks by language tag
  let m: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const lang = (m[1] || "").toLowerCase().trim();
    const key = lang === "" ? "(none)" : lang;
    bump(agg.fencedLangs, key);
    if (key === "mermaid") ses.hasMermaid = true;
    if (key === "math" || key === "latex" || key === "tex") ses.hasMath = true;
  }
  // Inline math heuristic: $...$ or $$...$$ in prose. Count each session, not each occurrence.
  if (!ses.hasMath && /\$\$?[^\s$][^$]*\$\$?/.test(text)) {
    ses.hasMath = true;
  }
}

function processToolUse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  block: any,
  agg: Aggregator,
  ses: SessionState,
): void {
  const name = (block?.name as string) ?? "(unknown)";
  bump(agg.toolUseCounts, name);
  ses.toolUseIdToName.set(block.id, name);
  ses.toolUseIdToInput.set(block.id, block.input);

  const inputJson = block.input == null ? "" : JSON.stringify(block.input);
  pushSample(agg.toolInputLengths, name, inputJson.length);

  if (name === "Task" || name === "Agent") {
    ses.hasAgent = true;
    // Each Task call is at least depth 1
    if (ses.maxDepth < 1) ses.maxDepth = 1;
    // If this Task itself is being invoked from inside another Task (i.e., the
    // session log has a nested chain), the `caller` field would indicate it.
    // Track the longest chain we see by counting nested invocations within
    // a Task's own content, but the session log flattens this — accurate depth
    // measurement requires the wire-level subagent_spawn fixtures.
  }

  if (name === "Edit" || name === "MultiEdit") {
    const input = block.input as { old_string?: string; new_string?: string } | null;
    if (input?.old_string != null) {
      agg.editOldLines.push(input.old_string.split("\n").length);
    }
    if (input?.new_string != null) {
      agg.editNewLines.push(input.new_string.split("\n").length);
    }
  }
}

function processToolResult(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  block: any,
  agg: Aggregator,
  ses: SessionState,
): void {
  const useId = block.tool_use_id as string;
  const toolName = ses.toolUseIdToName.get(useId) ?? "(unknown)";
  const isError = !!block.is_error;

  if (isError) bump(agg.toolResultErrorCounts, toolName);
  else bump(agg.toolResultOkCounts, toolName);

  // tool_result.content is either a string or an array of content blocks
  // (each with type:"text" / type:"image"). For sizing, sum up text length.
  let textOut = "";
  if (typeof block.content === "string") {
    textOut = block.content;
  } else if (Array.isArray(block.content)) {
    for (const c of block.content) {
      if (c && typeof c === "object" && typeof c.text === "string") {
        textOut += c.text;
      }
    }
  }

  const lineCount = textOut === "" ? 0 : textOut.split("\n").length;
  pushSample(agg.toolResultLengths, toolName, textOut.length);
  pushSample(agg.toolResultLineCounts, toolName, lineCount);

  // Tool-specific extraction
  if (toolName === "Bash") {
    agg.bashStdoutLines.push(lineCount);
  } else if (toolName === "Read") {
    // Try to extract numLines from common patterns. Read often returns line-numbered
    // text; the line count is a fine proxy for the file slice rendered.
    agg.readNumLines.push(lineCount);
  } else if (toolName === "Glob") {
    // Glob results are typically one path per line, sometimes prefixed with a
    // count line. Use line count as the path count proxy.
    agg.globResultCounts.push(lineCount);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function processAssistantMessage(msg: any, agg: Aggregator, ses: SessionState): void {
  const content = msg?.content;
  if (!Array.isArray(content)) return;
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const t = c.type as string;
    bump(agg.assistantContentTypes, t);
    if (t === "text" && typeof c.text === "string") {
      processAssistantText(c.text, agg, ses);
    } else if (t === "tool_use") {
      processToolUse(c, agg, ses);
    }
    // thinking: counted; no further processing
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function processUserMessage(msg: any, agg: Aggregator, ses: SessionState): void {
  const content = msg?.content;
  if (typeof content === "string") {
    bump(agg.userContentTypes, "text");
    return;
  }
  if (!Array.isArray(content)) return;
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const t = c.type as string;
    bump(agg.userContentTypes, t);
    if (t === "tool_result") {
      processToolResult(c, agg, ses);
    }
  }
}

// ---------------------------------------------------------------------------
// File processing
// ---------------------------------------------------------------------------

async function processFile(filePath: string, agg: Aggregator): Promise<void> {
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  } catch {
    agg.filesSkipped += 1;
    return;
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const ses = newSessionState();

  for await (const line of rl) {
    if (!line) continue;
    agg.totalLines += 1;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      agg.parseErrors += 1;
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev = obj as any;
    const t = ev.type as string;
    bump(agg.topLevelTypes, t);
    if (t === "assistant") {
      processAssistantMessage(ev.message, agg, ses);
    } else if (t === "user") {
      processUserMessage(ev.message, agg, ses);
    }
  }

  agg.filesRead += 1;
  agg.totalSessions += 1;
  if (ses.hasAgent) agg.sessionsWithAgent += 1;
  if (ses.hasMermaid) agg.sessionsWithMermaid += 1;
  if (ses.hasMath) agg.sessionsWithMath += 1;
  if (ses.maxDepth > agg.maxAgentDepth) agg.maxAgentDepth = ses.maxDepth;
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

interface DistSummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

function summarize(samples: number[]): DistSummary {
  if (samples.length === 0) {
    return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    count: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    max: Math.max(...samples),
    mean: Math.round((sum / samples.length) * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatReport(agg: Aggregator): string {
  const lines: string[] = [];

  const totalToolUses = Object.values(agg.toolUseCounts).reduce(
    (a, b) => a + b,
    0,
  );

  lines.push("=== Session corpus audit ===");
  lines.push(`Files read:          ${agg.filesRead}`);
  lines.push(`Files skipped:       ${agg.filesSkipped}`);
  lines.push(`Total JSONL lines:   ${agg.totalLines}`);
  lines.push(`Parse errors:        ${agg.parseErrors}`);
  lines.push("");

  lines.push("--- Top-level event types (per JSONL line) ---");
  for (const [k, v] of Object.entries(agg.topLevelTypes).sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`  ${v.toString().padStart(10)}  ${k}`);
  }
  lines.push("");

  lines.push("--- Assistant content-block types ---");
  for (const [k, v] of Object.entries(agg.assistantContentTypes).sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`  ${v.toString().padStart(10)}  ${k}`);
  }
  lines.push("");

  lines.push("--- User content-block types ---");
  for (const [k, v] of Object.entries(agg.userContentTypes).sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`  ${v.toString().padStart(10)}  ${k}`);
  }
  lines.push("");

  lines.push("--- Tool-use frequency (by tool name) ---");
  lines.push(`  total tool_use events: ${totalToolUses}`);
  for (const [k, v] of Object.entries(agg.toolUseCounts).sort(
    (a, b) => b[1] - a[1],
  )) {
    const pct = ((v / totalToolUses) * 100).toFixed(2);
    lines.push(`  ${v.toString().padStart(10)}  ${pct.padStart(6)}%  ${k}`);
  }
  lines.push("");

  lines.push("--- Per-tool error ratios ---");
  const allTools = new Set([
    ...Object.keys(agg.toolResultOkCounts),
    ...Object.keys(agg.toolResultErrorCounts),
  ]);
  for (const name of [...allTools].sort()) {
    const ok = agg.toolResultOkCounts[name] ?? 0;
    const err = agg.toolResultErrorCounts[name] ?? 0;
    const total = ok + err;
    const errPct = total === 0 ? 0 : ((err / total) * 100).toFixed(2);
    lines.push(
      `  ${name.padEnd(28)}  ok=${ok.toString().padStart(6)}  err=${err.toString().padStart(5)}  err%=${errPct.toString().padStart(6)}`,
    );
  }
  lines.push("");

  lines.push("--- tool_use input size distribution (chars JSON-stringified) ---");
  for (const [name, samples] of Object.entries(agg.toolInputLengths).sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const s = summarize(samples);
    lines.push(
      `  ${name.padEnd(28)}  n=${s.count.toString().padStart(6)}  p50=${s.p50}  p95=${s.p95}  p99=${s.p99}  max=${s.max}`,
    );
  }
  lines.push("");

  lines.push("--- tool_result output size distribution (chars) ---");
  for (const [name, samples] of Object.entries(agg.toolResultLengths).sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const s = summarize(samples);
    lines.push(
      `  ${name.padEnd(28)}  n=${s.count.toString().padStart(6)}  p50=${s.p50}  p95=${s.p95}  p99=${s.p99}  max=${s.max}`,
    );
  }
  lines.push("");

  lines.push("--- tool_result output line-count distribution ---");
  for (const [name, samples] of Object.entries(agg.toolResultLineCounts).sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const s = summarize(samples);
    lines.push(
      `  ${name.padEnd(28)}  n=${s.count.toString().padStart(6)}  p50=${s.p50}  p95=${s.p95}  p99=${s.p99}  max=${s.max}`,
    );
  }
  lines.push("");

  lines.push("--- Read tool: numLines (proxy from output line count) ---");
  lines.push(`  ${JSON.stringify(summarize(agg.readNumLines))}`);
  lines.push("");

  lines.push("--- Edit tool: old_string / new_string line counts ---");
  lines.push(`  old_string: ${JSON.stringify(summarize(agg.editOldLines))}`);
  lines.push(`  new_string: ${JSON.stringify(summarize(agg.editNewLines))}`);
  lines.push("");

  lines.push("--- Bash tool: stdout line count distribution ---");
  lines.push(`  ${JSON.stringify(summarize(agg.bashStdoutLines))}`);
  lines.push("");

  lines.push("--- Glob tool: result count distribution ---");
  lines.push(`  ${JSON.stringify(summarize(agg.globResultCounts))}`);
  lines.push("");

  lines.push("--- Fenced code-block languages in assistant text ---");
  const totalFences = Object.values(agg.fencedLangs).reduce((a, b) => a + b, 0);
  lines.push(`  total fenced blocks: ${totalFences}`);
  for (const [k, v] of Object.entries(agg.fencedLangs).sort(
    (a, b) => b[1] - a[1],
  )) {
    const pct = totalFences === 0 ? 0 : ((v / totalFences) * 100).toFixed(2);
    lines.push(`  ${v.toString().padStart(8)}  ${pct.toString().padStart(6)}%  ${k}`);
  }
  lines.push("");

  lines.push("--- Per-session feature presence ---");
  lines.push(`  Total sessions:          ${agg.totalSessions}`);
  lines.push(`  Sessions with Task/Agent: ${agg.sessionsWithAgent}`);
  lines.push(`  Sessions with mermaid:   ${agg.sessionsWithMermaid}`);
  lines.push(`  Sessions with math:      ${agg.sessionsWithMath}`);
  lines.push(`  Max observed agent depth (in-session, conservative): ${agg.maxAgentDepth}`);
  lines.push("");

  lines.push("--- Limitations (session-log format does not carry these) ---");
  lines.push("  - control_request_forward (permission / question) — wire-only");
  lines.push("  - cost_update per turn — wire-only");
  lines.push("  - tool_use_structured typed shapes — wire-only");
  lines.push("  - True subagent depth requires parsing wire-level subagent_spawn");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  const agg = newAggregator();

  let files: string[];
  try {
    files = fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(SESSIONS_DIR, f));
  } catch (e) {
    console.error(`Cannot read sessions dir: ${SESSIONS_DIR}`);
    console.error(String(e));
    process.exit(1);
  }

  if (args.sample !== null && args.sample > 0 && args.sample < files.length) {
    // Take the most recent N files (sorted by mtime desc)
    files = files
      .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, args.sample)
      .map((x) => x.f);
    console.error(`Sampling ${files.length} most-recent files (of ${files.length} total)`);
  } else {
    console.error(`Processing all ${files.length} files`);
  }

  let processed = 0;
  for (const f of files) {
    await processFile(f, agg);
    processed += 1;
    if (processed % 25 === 0) {
      console.error(`  ${processed}/${files.length}`);
    }
  }
  console.error(`Done. ${agg.filesRead} files, ${agg.totalLines} lines, ${agg.parseErrors} parse errors.`);

  console.log(formatReport(agg));

  if (args.jsonOut) {
    // Trim sample arrays out of JSON; keep summarized statistics + counts.
    const trimmed = {
      filesRead: agg.filesRead,
      filesSkipped: agg.filesSkipped,
      totalLines: agg.totalLines,
      parseErrors: agg.parseErrors,
      topLevelTypes: agg.topLevelTypes,
      assistantContentTypes: agg.assistantContentTypes,
      userContentTypes: agg.userContentTypes,
      toolUseCounts: agg.toolUseCounts,
      toolResultErrorCounts: agg.toolResultErrorCounts,
      toolResultOkCounts: agg.toolResultOkCounts,
      toolInputLengthsSummary: Object.fromEntries(
        Object.entries(agg.toolInputLengths).map(([k, v]) => [k, summarize(v)]),
      ),
      toolResultLengthsSummary: Object.fromEntries(
        Object.entries(agg.toolResultLengths).map(([k, v]) => [k, summarize(v)]),
      ),
      toolResultLineCountsSummary: Object.fromEntries(
        Object.entries(agg.toolResultLineCounts).map(([k, v]) => [k, summarize(v)]),
      ),
      readNumLinesSummary: summarize(agg.readNumLines),
      editOldLinesSummary: summarize(agg.editOldLines),
      editNewLinesSummary: summarize(agg.editNewLines),
      globResultCountsSummary: summarize(agg.globResultCounts),
      bashStdoutLinesSummary: summarize(agg.bashStdoutLines),
      fencedLangs: agg.fencedLangs,
      sessionsWithAgent: agg.sessionsWithAgent,
      sessionsWithMermaid: agg.sessionsWithMermaid,
      sessionsWithMath: agg.sessionsWithMath,
      maxAgentDepth: agg.maxAgentDepth,
      totalSessions: agg.totalSessions,
    };
    fs.writeFileSync(args.jsonOut, JSON.stringify(trimmed, null, 2));
    console.error(`Wrote ${args.jsonOut}`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

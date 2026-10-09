#!/usr/bin/env bun
/**
 * replay-corpus-audit.ts — replay-fidelity corpus audit harness.
 *
 * Runs the *real* JSONL replay translator (`translateJsonlSession`)
 * over the on-disk Claude Code session corpus (`~/.claude/projects/`)
 * and checks structural invariants. The corpus is ~4,000 real
 * sessions spanning months of Claude Code use — every entry shape,
 * stop-reason, subagent nesting, compaction, and interrupt the tool
 * has produced. This harness turns it into a regression surface no
 * hand-authored fixture set can match.
 *
 * It is a run-on-demand QA tool, NOT a CI test: CI has no session
 * corpus. The permanent CI coverage is the curated fixtures the
 * 20.5.B.1 fix sub-steps distil from what this audit flags.
 *
 *   Run:  bun tugcode/scripts/replay-corpus-audit.ts [--cap-mb N] [--limit N]
 *
 * Invariants checked per translated session:
 *   [I1] brackets — exactly one `replay_started` first, one
 *        `replay_complete` last.
 *   [I2] cycle balance — count(user_message_replay) ===
 *        count(turn_complete). An imbalance is a cycle left open at
 *        end-of-JSONL; classified by the last assistant `stop_reason`.
 *   [I3] the translator never throws.
 *   [I4] no duplicate `turn_complete` msg_id (the reducer dedupe-drops
 *        a repeat, stranding pending state).
 *   [I5] `replay_complete.count` === emitted `turn_complete` count.
 *
 * Plus a raw-shape census: top-level entry types, assistant
 * `stop_reason` distribution (W1), trailing user-only orphans (W2),
 * `parent_tool_use_id` sessions (W3), compaction / overloaded_error /
 * interrupt-marker sessions (W5), and string-valued `message.content`
 * split genuine-submission vs slash-command scaffolding (W5a).
 *
 * Each session is translated twice — with `synthesizeDanglingTerminal`
 * off (the reload-mid-stream default) and on (the cold-resume path,
 * [replay-1]) — so the report measures how many open cycles the
 * [replay-1] synthetic actually closes.
 *
 * @module scripts/replay-corpus-audit
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { translateJsonlSession } from "../src/replay.ts";
import type { OutboundMessage } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CORPUS_ROOT = join(homedir(), ".claude", "projects");

/** Files at or under this size are translated; larger ones are
 *  raw-scanned only. Override with `--cap-mb N`. */
let translateCapBytes = 4 * 1024 * 1024;
/** Files larger than this are skipped entirely — a multi-hundred-MB
 *  JSONL would blow the heap reading it into a string. The handful of
 *  giant sessions don't change the statistical picture. */
const HUGE_SKIP_BYTES = 64 * 1024 * 1024;
/** Optional cap on how many sessions to process (`--limit N`). */
let sessionLimit = Infinity;

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--cap-mb") translateCapBytes = Number(process.argv[++i]) * 1024 * 1024;
  else if (arg === "--limit") sessionLimit = Number(process.argv[++i]);
}

/** Assistant stop-reasons that close a cycle cleanly. As of
 *  Step 20.5.B.1.a the translator recognises all four (`replay.ts`
 *  `TERMINAL_STOP_REASONS`); `tool_use` / `pause_turn` / a null
 *  stop_reason are non-terminal continuations. */
const CLEAN_TERMINAL_STOPS = new Set([
  "end_turn",
  "stop_sequence",
  "max_tokens",
  "refusal",
]);

const INTERRUPT_MARKER = "[Request interrupted by user]";

/** Bare-string `message.content` prefixes Claude Code uses for slash-
 *  command scaffolding — the translator skips these (mirrors
 *  `replay.ts` `COMMAND_SCAFFOLDING_PREFIXES`). Re-stated here rather
 *  than imported: the raw scan is deliberately independent of the
 *  translator, so a drift between the two is itself observable. */
const COMMAND_SCAFFOLDING_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-caveat>",
];

/** True when a bare-string `user` `message.content` is Claude Code
 *  scaffolding (slash-command markers, or the `isCompactSummary`
 *  continuation block) rather than a genuine submission. */
function isScaffoldingString(
  entry: Record<string, unknown>,
  content: string,
): boolean {
  if (entry.isCompactSummary === true) return true;
  const trimmed = content.trimStart();
  return COMMAND_SCAFFOLDING_PREFIXES.some((p) => trimmed.startsWith(p));
}

// ---------------------------------------------------------------------------
// Corpus discovery
// ---------------------------------------------------------------------------

/** Main session JSONLs — the files directly under each project dir.
 *  (`<project>/<session>/subagents/*.jsonl` are sub-transcripts, not
 *  resume targets, and are excluded.) */
function findMainSessions(root: string): string[] {
  const out: string[] = [];
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const proj of projectDirs) {
    const projDir = join(root, proj);
    let files: string[];
    try {
      files = readdirSync(projDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const f of files) out.push(join(projDir, f));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Raw-shape scan (cheap; runs on every file regardless of size)
// ---------------------------------------------------------------------------

interface RawScan {
  topTypes: Map<string, number>;
  stopReasons: Map<string, number>;
  /** The last `user`/`assistant` entry is a `user` entry with text
   *  content — a trailing submission with no response (W2). */
  trailingUserOrphan: boolean;
  /** The last assistant entry's `stop_reason`, or null if none. */
  lastAssistantStop: string | null;
  hasParentToolUseId: boolean;
  hasCompaction: boolean;
  hasOverloadedError: boolean;
  hasInterruptMarker: boolean;
  /** `user` entries whose `message.content` is a bare string ([W5a]). */
  stringContentUserEntries: number;
  /** Of `stringContentUserEntries`, how many are Claude Code
   *  scaffolding the translator skips — the rest are genuine
   *  submissions normalised to text. */
  stringContentScaffolding: number;
  malformedLines: number;
  lineCount: number;
}

function rawScan(text: string): RawScan {
  const scan: RawScan = {
    topTypes: new Map(),
    stopReasons: new Map(),
    trailingUserOrphan: false,
    lastAssistantStop: null,
    // `parent_tool_use_id` with a real (non-null) string value — the
    // W3 (subagent-nesting) signal. `"parent_tool_use_id":null` rows
    // (top-level tool calls) deliberately do not match.
    hasParentToolUseId: /"parent_tool_use_id":\s*"[^"]/.test(text),
    hasCompaction: /"isCompactSummary"|"subtype":"compact/.test(text),
    hasOverloadedError: text.includes('"overloaded_error"'),
    hasInterruptMarker: text.includes(INTERRUPT_MARKER),
    stringContentUserEntries: 0,
    stringContentScaffolding: 0,
    malformedLines: 0,
    lineCount: 0,
  };

  let lastUserAssistant: { role: string; hasText: boolean } | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    scan.lineCount += 1;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      scan.malformedLines += 1;
      continue;
    }
    const type = typeof entry.type === "string" ? entry.type : "(none)";
    scan.topTypes.set(type, (scan.topTypes.get(type) ?? 0) + 1);

    if (type === "assistant" || type === "user") {
      const message =
        entry.message !== null && typeof entry.message === "object"
          ? (entry.message as Record<string, unknown>)
          : null;
      const rawContent = message?.content;
      // `hasText` drives the trailing-orphan (W2) classification: a
      // trailing user entry "with text" is a genuine submission with
      // no response. Account for the [W5a] bare-string shape — a
      // genuine string submission has text; scaffolding does not count
      // as a transcript submission.
      let hasText = false;
      if (typeof rawContent === "string") {
        if (type === "user") {
          scan.stringContentUserEntries += 1;
          if (isScaffoldingString(entry, rawContent)) {
            scan.stringContentScaffolding += 1;
          } else {
            hasText = rawContent.trim().length > 0;
          }
        } else {
          hasText = rawContent.trim().length > 0;
        }
      } else if (Array.isArray(rawContent)) {
        hasText = rawContent.some(
          (b) =>
            b !== null &&
            typeof b === "object" &&
            (b as Record<string, unknown>).type === "text",
        );
      }
      lastUserAssistant = { role: type, hasText };
      if (type === "assistant") {
        const stop =
          typeof message?.stop_reason === "string"
            ? message.stop_reason
            : "(null)";
        scan.stopReasons.set(stop, (scan.stopReasons.get(stop) ?? 0) + 1);
        scan.lastAssistantStop = stop;
      }
    }
  }
  // A trailing user-text entry as the final user/assistant entry is a
  // submission with no response — the W2 dropped-orphan candidate.
  scan.trailingUserOrphan =
    lastUserAssistant !== null &&
    lastUserAssistant.role === "user" &&
    lastUserAssistant.hasText;
  return scan;
}

// ---------------------------------------------------------------------------
// Translate + invariant checks
// ---------------------------------------------------------------------------

interface TranslateResult {
  threw: string | null;
  userReplays: number;
  turnCompletes: number;
  firstType: string | null;
  lastType: string | null;
  replayStartedCount: number;
  replayCompleteCount: number;
  replayCompleteCount_field: number | null;
  dupTurnCompleteMsgIds: string[];
}

async function translate(
  jsonl: string,
  claudeSessionId: string,
  synthesizeDanglingTerminal: boolean,
): Promise<TranslateResult> {
  const r: TranslateResult = {
    threw: null,
    userReplays: 0,
    turnCompletes: 0,
    firstType: null,
    lastType: null,
    replayStartedCount: 0,
    replayCompleteCount: 0,
    replayCompleteCount_field: null,
    dupTurnCompleteMsgIds: [],
  };
  const seenTurnMsgIds = new Set<string>();
  try {
    const messages: OutboundMessage[] = [];
    for await (const m of translateJsonlSession(
      { kind: "ok", jsonl, claudeSessionId },
      { disableYield: true, synthesizeDanglingTerminal },
    )) {
      messages.push(m);
    }
    if (messages.length > 0) {
      r.firstType = messages[0].type;
      r.lastType = messages[messages.length - 1].type;
    }
    for (const m of messages) {
      if (m.type === "replay_started") r.replayStartedCount += 1;
      else if (m.type === "replay_complete") {
        r.replayCompleteCount += 1;
        const count = (m as { count?: unknown }).count;
        if (typeof count === "number") r.replayCompleteCount_field = count;
      } else if (m.type === "add_user_message") r.userReplays += 1;
      else if (m.type === "turn_complete") {
        r.turnCompletes += 1;
        const msgId = String((m as { msg_id?: unknown }).msg_id ?? "");
        if (seenTurnMsgIds.has(msgId)) r.dupTurnCompleteMsgIds.push(msgId);
        else seenTurnMsgIds.add(msgId);
      }
    }
  } catch (err) {
    r.threw = err instanceof Error ? err.message : String(err);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function makeBucket(): Map<string, string[]> {
  return new Map();
}
function record(bucket: Map<string, string[]>, label: string, id: string): void {
  const list = bucket.get(label) ?? [];
  if (list.length < 10) list.push(id);
  bucket.set(label, list);
}

function mergeCounts(into: Map<string, number>, from: Map<string, number>): void {
  for (const [k, v] of from) into.set(k, (into.get(k) ?? 0) + v);
}

function pct(n: number, total: number): string {
  return total === 0 ? "0%" : `${((n / total) * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const sessions = findMainSessions(CORPUS_ROOT);
  if (sessions.length === 0) {
    console.log(
      `No sessions found under ${CORPUS_ROOT} — corpus absent; nothing to audit.`,
    );
    return;
  }
  const toProcess = sessions.slice(0, sessionLimit);
  console.log(
    `replay-corpus-audit — ${toProcess.length} main session(s) under ${CORPUS_ROOT}` +
      (toProcess.length < sessions.length ? ` (of ${sessions.length}; --limit applied)` : "") +
      `\n  translate cap: ${(translateCapBytes / 1024 / 1024).toFixed(0)} MB\n`,
  );

  let translated = 0;
  let rawOnly = 0;
  let readFailed = 0;
  let skippedHuge = 0;

  // Invariant violation buckets.
  const i1Bracket = makeBucket();
  const i3Threw = makeBucket();
  const i4DupMsgId = makeBucket();
  const i5CountMismatch = makeBucket();
  // I2 cycle imbalance, classified.
  const imbalanceByDelta = new Map<number, number>(); // (userReplays - turnCompletes) → session count
  const w1CleanTerminalDangling = makeBucket(); // last turn ended clean but cycle left open
  const w1Cascade = makeBucket(); // imbalance ≥ 2 — mid-session terminal corruption
  const danglingToolTurn = makeBucket(); // imbalance == 1, last stop tool_use/(null) — expected [replay-1]
  const synthUnfixed = makeBucket(); // still imbalanced even WITH synthesizeDanglingTerminal

  // Raw census.
  const topTypes = new Map<string, number>();
  const stopReasons = new Map<string, number>();
  const w2TrailingOrphan = makeBucket();
  let w3ParentToolUse = 0;
  let w5Compaction = 0;
  let w5Overloaded = 0;
  const w5CompactionExamples: string[] = [];
  const w5OverloadedExamples: string[] = [];
  let interruptMarker = 0;
  let malformedSessions = 0;
  // [W5a] string-valued message.content census.
  let stringContentUserEntries = 0;
  let stringContentScaffolding = 0;
  let sessionsWithGenuineStringPrompt = 0;

  let done = 0;
  for (const path of toProcess) {
    const id = basename(path, ".jsonl");
    done += 1;
    if (done % 250 === 0) console.log(`  …${done}/${toProcess.length}`);

    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      readFailed += 1;
      continue;
    }
    if (size > HUGE_SKIP_BYTES) {
      skippedHuge += 1;
      continue;
    }

    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      readFailed += 1;
      continue;
    }

    const scan = rawScan(text);
    mergeCounts(topTypes, scan.topTypes);
    mergeCounts(stopReasons, scan.stopReasons);
    if (scan.trailingUserOrphan) record(w2TrailingOrphan, "w2", id);
    if (scan.hasParentToolUseId) w3ParentToolUse += 1;
    if (scan.hasCompaction) {
      w5Compaction += 1;
      if (w5CompactionExamples.length < 10) w5CompactionExamples.push(id);
    }
    if (scan.hasOverloadedError) {
      w5Overloaded += 1;
      if (w5OverloadedExamples.length < 10) w5OverloadedExamples.push(id);
    }
    if (scan.hasInterruptMarker) interruptMarker += 1;
    if (scan.malformedLines > 0) malformedSessions += 1;
    stringContentUserEntries += scan.stringContentUserEntries;
    stringContentScaffolding += scan.stringContentScaffolding;
    if (scan.stringContentUserEntries - scan.stringContentScaffolding > 0) {
      sessionsWithGenuineStringPrompt += 1;
    }

    if (size > translateCapBytes) {
      rawOnly += 1;
      continue;
    }
    translated += 1;

    const off = await translate(text, id, false);
    const on = await translate(text, id, true);

    // [I3] throws
    if (off.threw !== null) {
      record(i3Threw, off.threw.slice(0, 80), id);
      continue;
    }
    // [I1] brackets
    if (
      off.firstType !== "replay_started" ||
      off.lastType !== "replay_complete" ||
      off.replayStartedCount !== 1 ||
      off.replayCompleteCount !== 1
    ) {
      record(
        i1Bracket,
        `first=${off.firstType} last=${off.lastType} started=${off.replayStartedCount} complete=${off.replayCompleteCount}`,
        id,
      );
    }
    // [I4] duplicate turn_complete msg_id
    if (off.dupTurnCompleteMsgIds.length > 0) {
      record(i4DupMsgId, off.dupTurnCompleteMsgIds[0] || "(empty)", id);
    }
    // [I5] replay_complete.count vs emitted turn_complete count
    if (
      off.replayCompleteCount_field !== null &&
      off.replayCompleteCount_field !== off.turnCompletes
    ) {
      record(
        i5CountMismatch,
        `field=${off.replayCompleteCount_field} emitted=${off.turnCompletes}`,
        id,
      );
    }
    // [I2] cycle balance
    const delta = off.userReplays - off.turnCompletes;
    imbalanceByDelta.set(delta, (imbalanceByDelta.get(delta) ?? 0) + 1);
    if (delta >= 2) {
      record(w1Cascade, `Δ=${delta} lastStop=${scan.lastAssistantStop}`, id);
    } else if (delta === 1) {
      const stop = scan.lastAssistantStop;
      if (stop !== null && stop !== "tool_use" && stop !== "(null)") {
        // Cycle left open though the last assistant turn ended on a
        // clean terminal stop — the W1 mislabel risk.
        record(w1CleanTerminalDangling, `lastStop=${stop}`, id);
      } else {
        // Cut off mid-tool / no stop — the expected [replay-1] dangling
        // turn; the cold-resume synthetic is meant to close it.
        record(danglingToolTurn, `lastStop=${stop ?? "(none)"}`, id);
      }
    }
    // Does the [replay-1] synthetic actually rebalance it?
    if (on.userReplays - on.turnCompletes !== 0 && off.threw === null) {
      record(
        synthUnfixed,
        `off Δ=${delta} → on Δ=${on.userReplays - on.turnCompletes}`,
        id,
      );
    }
  }

  // ---- Report --------------------------------------------------------------
  const line = "─".repeat(72);
  const section = (t: string): void => console.log(`\n${line}\n${t}\n${line}`);
  const bucket = (b: Map<string, string[]>): void => {
    let total = 0;
    for (const [label, ids] of b) {
      total += ids.length;
      console.log(`  • ${label}`);
      console.log(`      ${ids.join(", ")}`);
    }
    if (total === 0) console.log("  (none)");
  };

  section("CORPUS");
  console.log(`  sessions processed : ${toProcess.length}`);
  console.log(`  translated         : ${translated}`);
  console.log(`  raw-scanned only   : ${rawOnly} (over ${(translateCapBytes / 1024 / 1024).toFixed(0)} MB cap)`);
  console.log(`  skipped (huge)     : ${skippedHuge} (over ${(HUGE_SKIP_BYTES / 1024 / 1024).toFixed(0)} MB)`);
  console.log(`  read failures      : ${readFailed}`);
  console.log(`  sessions w/ malformed lines : ${malformedSessions}`);

  section("[I1] BRACKET violations (replay_started first / replay_complete last)");
  bucket(i1Bracket);
  section("[I3] translator THREW");
  bucket(i3Threw);
  section("[I4] duplicate turn_complete msg_id");
  bucket(i4DupMsgId);
  section("[I5] replay_complete.count ≠ emitted turn_complete count");
  bucket(i5CountMismatch);

  section("[I2] cycle balance — (user_message_replay − turn_complete) distribution");
  for (const delta of [...imbalanceByDelta.keys()].sort((a, b) => a - b)) {
    const n = imbalanceByDelta.get(delta)!;
    const tag =
      delta === 0 ? "balanced"
      : delta === 1 ? "one cycle open at EOF"
      : delta >= 2 ? "MULTIPLE cycles open — W1 cascade suspect"
      : "negative — extra terminal (unexpected)";
    console.log(`  Δ=${delta}: ${n} session(s)  [${tag}]`);
  }

  section("[W1] cycle left open though last turn ended on a CLEAN terminal stop");
  console.log("  (a clean turn the cold-resume synthetic would mislabel `interrupted`)");
  bucket(w1CleanTerminalDangling);
  section("[W1] cascade — imbalance ≥ 2 (a mid-session non-end_turn terminal corrupting later turns)");
  bucket(w1Cascade);
  section("[replay-1] expected dangling tool/abandoned turn (imbalance = 1, last stop tool_use/none)");
  bucket(danglingToolTurn);
  section("[replay-1] synthetic does NOT fully rebalance (synthesizeDanglingTerminal on, still imbalanced)");
  bucket(synthUnfixed);

  section("[W2] trailing user-only orphan (last user/assistant entry is a user submission, no response)");
  bucket(w2TrailingOrphan);

  section("[W3 / W5] raw-shape census");
  console.log(`  [W3] sessions with a non-null parent_tool_use_id (subagent nesting) : ${w3ParentToolUse} (${pct(w3ParentToolUse, toProcess.length)})`);
  console.log(`  [W5] sessions with compaction markers                             : ${w5Compaction}`);
  if (w5CompactionExamples.length > 0) {
    console.log(`       e.g. ${w5CompactionExamples.join(", ")}`);
  }
  console.log(`  [W5] sessions with overloaded_error blocks                        : ${w5Overloaded}`);
  if (w5OverloadedExamples.length > 0) {
    console.log(`       e.g. ${w5OverloadedExamples.join(", ")}`);
  }
  console.log(`       sessions with the "${INTERRUPT_MARKER}" marker      : ${interruptMarker}`);

  section("[W5a] string-valued user message.content");
  console.log("  Claude Code persists a plain-text user message as a bare string.");
  console.log("  The translator normalises a genuine submission to text and skips");
  console.log("  slash-command / compaction scaffolding (replay.ts `contentBlocks` /");
  console.log("  `translateJsonlEntry`'s bare-string branch). Pre-fix, every string-content entry");
  console.log("  was char-iterated to nothing — genuine prompts silently dropped.");
  const genuineStringEntries =
    stringContentUserEntries - stringContentScaffolding;
  console.log(`  total string-content user entries           : ${stringContentUserEntries}`);
  console.log(`    genuine submissions (normalised to text)  : ${genuineStringEntries}`);
  console.log(`    command/compaction scaffolding (skipped)  : ${stringContentScaffolding}`);
  console.log(`  sessions carrying >=1 genuine string prompt : ${sessionsWithGenuineStringPrompt} (${pct(sessionsWithGenuineStringPrompt, toProcess.length)})`);

  section("assistant stop_reason distribution (occurrences across all entries)");
  for (const [reason, n] of [...stopReasons.entries()].sort((a, b) => b[1] - a[1])) {
    const flag = CLEAN_TERMINAL_STOPS.has(reason)
      ? "  (clean terminal — closes a cycle)"
      : reason === "tool_use" || reason === "pause_turn"
        ? "  (non-terminal continuation)"
        : reason === "(null)"
          ? "  (non-terminal — truncated mid-stream)"
          : "  ← unrecognised";
    console.log(`  ${reason.padEnd(16)} ${String(n).padStart(8)}${flag}`);
  }

  section("top-level entry .type distribution");
  for (const [type, n] of [...topTypes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(24)} ${String(n).padStart(8)}`);
  }

  console.log(`\n${line}\nDONE.\n${line}`);
}

void main();

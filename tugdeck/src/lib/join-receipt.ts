/**
 * The join and discard receipts' parsers — the server-formatted `/arc-join`
 * (S01) and `/arc-discard` (S02) summaries the shell ledger records.
 *
 * Pure: `SessionJoinReceiptBlock` renders what these read and re-exports them,
 * and the transcript data source reads a join without importing the block.
 * The `files:` line is read through the commit receipt's own parser, and a
 * record's stage lines take the arc receipt's stage shape.
 *
 * @module lib/join-receipt
 */

import type { ArcReceiptStage } from "@/lib/arc-receipt";
import {
  FILES_PREFIX,
  parseFilesLine,
  type CommitReceiptFile,
} from "@/lib/commit-receipt";

/** The display facts parsed from an S01 join summary. */
export interface ParsedJoinReceipt {
  /** The landing commit on the base branch. */
  sha: string;
  arc: string;
  base: string;
  rounds: number;
  /** The squash message the join landed with, verbatim. */
  message: string;
  /**
   * The files the join landed (from the `files:` line). Empty for a receipt
   * written before the line existed, and for a non-squash join — the server
   * omits the line rather than writing a partial list, so both arrive here as
   * the same absence and render the same way.
   */
  files: CommitReceiptFile[];
  /**
   * What the last green verify said about the tree this join landed, from the
   * `fit:` line. Absent for a receipt written before the line existed, and for
   * an arc nothing verified — the server omits the line rather than writing an
   * empty one, so both arrive here as the same absence.
   */
  fit?: { verified: boolean; head: string; base: string };
  /**
   * The arc's own record, from the `arc: ` lines ([B03], [B08]) — the
   * document it opened on, the stages it walked, and the plan that came out.
   * Absent for a receipt written before the lines existed and for a join
   * whose arc log had nothing to say, which arrive here as the same absence
   * and fold behind the boundary as nothing at all.
   */
  record?: {
    document: string | null;
    stages: ArcReceiptStage[];
    plan: string | null;
  };
}

/** The display facts parsed from an S02 discard summary. */
export interface ParsedDiscardReceipt {
  arc: string;
  rounds: number;
  /** Files the arc touched, from its range diff; 0 when the header omits them. */
  files: number;
  /** The round subjects the discard preflight showed. */
  subjects: string[];
}

// The S01 / S02 headers, matched exactly — `·` is U+00B7 and `→` U+2192, so a
// hand-typed arrow or dot never false-parses into a receipt.
//   joined <sha> · <arc> → <base> · <N> round(s)
//   discarded <arc> · <N> round(s)[, <M> file(s)]
const JOIN_HEAD_RE = /^joined (\S+) · (\S+) → (\S+) · (\d+) round\(s\)$/;
const DISCARD_HEAD_RE = /^discarded (\S+) · (\d+) round\(s\)(?:, (\d+) file\(s\))?$/;

// The optional fit line, between the header and `files:`:
//   fit: verified <head> onto <base>
const FIT_RE = /^fit: (verified|stale) (\S+) onto (\S+)$/;

/**
 * The arc record's own prefix, one token for all three of its line kinds
 * ([B08]). Every line of the record wears it, so a squash message whose first
 * word is *plan* — or *opened* — is never read as the record: only a line
 * starting `arc: ` is a candidate, and a commit subject does not reach that
 * by accident.
 */
const ARC_PREFIX = "arc: ";
/**
 * A stage line's three fields, behind the prefix. Keyed on the closed stage
 * vocabulary for the same reason `lib/arc-receipt.ts`'s copy is: the
 * set of stages is fixed, while a model name or an id format can change.
 */
const ARC_STAGE_RE = /^(devise|review|implement|audit) · (.+) · (\S+)$/;

// The header the verb wrote before it was renamed, when it led with `released`
// and then said `discarded` again in front of the count. A transcript is
// replayed from its JSONL on every card reload, so every receipt already
// written keeps arriving here forever; this pattern is read and never written.
const HISTORICAL_DISCARD_HEAD_RE =
  /^released (\S+) · discarded (\d+) round\(s\)(?:, (\d+) file\(s\))?$/;

/**
 * Parse a `/arc-join` receipt from its `output` string, or `null` when the
 * output is not an S01 summary — a truncated row, or one written before the
 * format existed. The caller then renders the raw output rather than nothing.
 *
 * Every line after the header is claimed by its own **prefix**, and the
 * message begins wherever the cursor stops. That is what makes every join
 * receipt already in JSONL keep parsing forever: a transcript replays from its
 * record on every card reload, so a parser that read `files:` at a fixed index
 * would orphan the file list of every past join the moment a line was added
 * above it. An unrecognized line ends the optional block and belongs to the
 * message; only a header that does not match yields `null`, which is what
 * sends the row to the generic shell block.
 */
export function parseJoinReceipt(output: string): ParsedJoinReceipt | null {
  const lines = output.split("\n");
  const head = JOIN_HEAD_RE.exec(lines[0] ?? "");
  if (head === null) return null;
  let cursor = 1;
  let files: CommitReceiptFile[] = [];
  let fit: ParsedJoinReceipt["fit"];
  const fitLine = FIT_RE.exec(lines[cursor] ?? "");
  if (fitLine !== null) {
    fit = { verified: fitLine[1] === "verified", head: fitLine[2], base: fitLine[3] };
    cursor += 1;
  }
  // The record's run, claimed by its prefix like every optional line around
  // it, and read in the order the server writes them — between `fit:` and
  // `files:`. An `arc: ` line whose remainder matches none of the three kinds
  // is consumed and dropped rather than ending the run: the prefix is the
  // server's own, so a line wearing it belongs to the record whether or not
  // this build knows what it says, and letting it fall into the message
  // would put a machine line in the middle of a commit body.
  let record: ParsedJoinReceipt["record"];
  while (lines[cursor]?.startsWith(ARC_PREFIX) === true) {
    const line = (lines[cursor] ?? "").slice(ARC_PREFIX.length);
    cursor += 1;
    record ??= { document: null, stages: [], plan: null };
    if (line.startsWith("opened on ")) {
      record.document = line.slice("opened on ".length);
      continue;
    }
    if (line.startsWith("plan ")) {
      record.plan = line.slice("plan ".length);
      continue;
    }
    const stage = ARC_STAGE_RE.exec(line);
    if (stage !== null) {
      record.stages.push({ stage: stage[1], model: stage[2], sessionId: stage[3] });
    }
  }
  if (lines[cursor]?.startsWith(FILES_PREFIX) === true) {
    files = parseFilesLine(lines[cursor] ?? "");
    cursor += 1;
  }
  const messageStart = cursor;
  return {
    sha: head[1],
    arc: head[2],
    base: head[3],
    rounds: Number.parseInt(head[4], 10),
    // A trailing blank line would paint as an empty row under `pre-wrap`.
    message: lines.slice(messageStart).join("\n").replace(/\s+$/, ""),
    files,
    fit,
    record,
  };
}

/**
 * Parse an `/arc-discard` receipt, or `null` on a non-matching first line.
 *
 * The current header is tried first and the historical one second. Both yield
 * the same facts in the same capture positions, but they are written as two
 * patterns rather than one alternation because only one of them is a shape
 * this code still produces.
 */
export function parseDiscardReceipt(output: string): ParsedDiscardReceipt | null {
  const lines = output.split("\n");
  const head =
    DISCARD_HEAD_RE.exec(lines[0] ?? "") ??
    HISTORICAL_DISCARD_HEAD_RE.exec(lines[0] ?? "");
  if (head === null) return null;
  return {
    arc: head[1],
    rounds: Number.parseInt(head[2], 10),
    files: head[3] === undefined ? 0 : Number.parseInt(head[3], 10),
    subjects: lines
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  };
}

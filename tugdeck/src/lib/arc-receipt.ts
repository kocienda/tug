/**
 * The arc receipt's parser — the `/arc-run` row the shell ledger records when
 * an arc completes, stops, or picks itself back up.
 *
 * Pure: `SessionArcReceiptBlock` renders what this reads and re-exports it,
 * and the transcript data source reads it to know what a row is without
 * importing the block.
 *
 * @module lib/arc-receipt
 */

/**
 * One stage line of the record: `<stage> · <model> · <claude session id>`.
 *
 * The server writes the literal `account default` where the config declared no
 * model, so the absence is already a word by the time it arrives and is never
 * reconstructed here.
 */
export interface ArcReceiptStage {
  stage: string;
  model: string;
  sessionId: string;
}

/** The display facts parsed from an arc receipt, complete or stopped. */
export interface ParsedArcReceipt {
  outcome: "complete" | "stopped" | "resumed";
  arc: string;
  /** The document the arc opened on; absent on a record that had none. */
  document: string | null;
  stages: ArcReceiptStage[];
  /** The plan that came out; absent when the arc stopped before one existed. */
  plan: string | null;
  /**
   * A stop's stage, its sentence, whatever the stage said for itself, and
   * whether the arc it stopped is over.
   *
   * `said` is the `arc ask` question a `NeedsDecision` stop carries — the
   * stage's own words, written as the record's last note and read back
   * beneath the header. It is the row's tail, and it is why that stop needs
   * no answer affordance of its own ([B03]).
   *
   * `terminal` is read off the frozen sentence `there is nothing to resume`,
   * which the server writes for a discard and a join and for nothing else.
   * **No wire field carries this and none should**: the receipt is a record
   * of a past moment that has to still read correctly after a relaunch weeks
   * later, and its own text is the only thing a restored transcript has
   * ([B05]).
   */
  stop: {
    stage: string;
    reason: string;
    said: string | null;
    terminal: boolean;
  } | null;
  /**
   * A pick-up's stage and the fact that undid the stop, or `null` on the other
   * two outcomes.
   *
   * The stage is on the receipt's own header rather than looked up, and it has
   * to be: `trackModelFor` cannot build an identity strip without one, and a
   * receipt is a frozen record of a past moment with no live store to ask —
   * the same reason `terminal` is read off a frozen sentence rather than
   * carried on the wire.
   */
  resumed: { stage: string; moved: string } | null;
}

// The two headers, matched exactly. `·` is U+00B7 and the em arc U+2014, so a
// hand-typed line never false-parses into a receipt — the discipline the join
// and commit receipts keep, for the same reason.
const COMPLETE_RE = /^arc complete · (.+)$/;
const STOPPED_RE = /^arc stopped · (.+?) · in (.+?) — (.+)$/;
/**
 * The third header: a silence-judged stop that the stopped stage itself
 * contradicted. Tried **before** `STOPPED_RE`, which it cannot collide with —
 * the two differ in their second word — but ordering the more specific first
 * is the discipline that keeps a fourth header from having to think about it.
 */
const RESUMED_RE = /^arc picked back up · (.+?) · in (.+?) · (.+)$/;
/**
 * A stage line, keyed on the closed stage vocabulary rather than on the shape
 * of a session id. `ArcStage::as_str` is the whole set, and matching it is what
 * keeps `opened on …` and `plan …` from ever being read as stages — a receipt
 * cannot grow a fourth field, but a model name or an id format can change.
 */
const STAGE_RE = /^(devise|review|implement|audit) · (.+) · (\S+)$/;
/**
 * The one sentence a stop receipt writes when the arc is over. Matched
 * exactly — it is the marker, not a phrase to search within.
 */
export const TERMINAL_LINE = "there is nothing to resume";
/**
 * The line a stop receipt used to close with, before the resume became a
 * button in this block ([B01]). Recognized so that a receipt already in a
 * shell ledger — which replays on every card reload, and which nothing
 * rewrites — is not read as something the stage said, and so the command the
 * user asked never to see again does not survive in the rows that predate the
 * change.
 */
const LEGACY_RESUME_RE = /^resume with tugtool arc run \S+$/;

export function parseArcReceipt(output: string): ParsedArcReceipt | null {
  const lines = output.split("\n");
  const head = lines[0] ?? "";
  const resumed = RESUMED_RE.exec(head);
  const stopped = resumed === null ? STOPPED_RE.exec(head) : null;
  const complete = resumed === null && stopped === null ? COMPLETE_RE.exec(head) : null;
  if (resumed === null && stopped === null && complete === null) return null;

  const parsed: ParsedArcReceipt = {
    outcome: resumed !== null ? "resumed" : stopped !== null ? "stopped" : "complete",
    arc: (resumed?.[1] ?? (stopped !== null ? stopped[1] : complete?.[1])) ?? "",
    document: null,
    stages: [],
    plan: null,
    stop:
      stopped !== null
        ? {
            stage: stopped[2] ?? "",
            reason: stopped[3] ?? "",
            said: null,
            terminal: false,
          }
        : null,
    resumed:
      resumed !== null
        ? { stage: resumed[2] ?? "", moved: resumed[3] ?? "" }
        : null,
  };

  for (const line of lines.slice(1)) {
    if (line.startsWith("opened on ")) {
      parsed.document = line.slice("opened on ".length);
      continue;
    }
    if (line.startsWith("plan ")) {
      parsed.plan = line.slice("plan ".length);
      continue;
    }
    const stage = STAGE_RE.exec(line);
    if (stage !== null) {
      parsed.stages.push({
        stage: stage[1] ?? "",
        model: stage[2] ?? "",
        sessionId: stage[3] ?? "",
      });
      continue;
    }
    if (parsed.stop !== null && line === TERMINAL_LINE) {
      parsed.stop.terminal = true;
      continue;
    }
    if (parsed.stop !== null && LEGACY_RESUME_RE.test(line)) continue;
    // Whatever else the stop wrote after its header is the stage's own words,
    // which carry no marker — the two marked lines above and the terminal
    // sentence are all eligible to be something else first.
    if (parsed.stop !== null && parsed.stop.said === null && line.length > 0) {
      parsed.stop.said = line;
    }
  }
  return parsed;
}

/**
 * Claims `/arc-run`, the one command `useLandingReceipts` writes for an arc —
 * and `/dash-arc`, the command it wrote under the retired name. Those rows are
 * in the shell ledger and replay on every card reload, so dropping the retired
 * spelling would turn every arc ending already recorded back into a raw shell
 * row ([F19], `tuglaws/work-grammar.md`).
 */
export function matchesArcReceipt(command: string): boolean {
  return (
    command === "/arc-run" ||
    command.startsWith("/arc-run ") ||
    command === "/dash-arc" ||
    command.startsWith("/dash-arc ")
  );
}

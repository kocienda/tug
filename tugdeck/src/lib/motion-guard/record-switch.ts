/**
 * The record switch — the deck's motion instruments, on and off by hand.
 *
 * Every per-frame record the settle and the switch write (`settle-frames`,
 * `settle-land`, `settle-beat`, `space-switch-frames`) sits behind the deck
 * trace, and nothing in the product turns the trace on: the instruments are
 * off by default, by the user's ruling, and the release deck records nothing
 * until a hand asks it to. This is that hand's switch, reached from the shell
 * as `tugtool deck motion record on|off` and from the Session card as
 * `/motion-record on|off`.
 *
 * `on` does what it can live and arranges the rest for the next load:
 *
 * - **Live:** the deck trace and the four recording kinds, and the commit
 *   census's walk where the census is in the page.
 * - **Next load:** the lead recorder and the commit census install only in a
 *   page that loaded with a flag set, because each has to be in place before
 *   React evaluates (`index.html`). `on` sets the `tug-motion-record`
 *   sessionStorage flag, so the next load carries both; a relaunch sheds it,
 *   and nothing persists it across instances.
 *
 * `off` takes all of it back and leaves the trace as `on` found it. Every row
 * already recorded stays readable.
 */

import { deckTrace, type DeckTraceEvent } from "@/deck-trace";

/** The sessionStorage flag `index.html` reads at load. */
export const MOTION_RECORD_FLAG = "tug-motion-record";

/** The recording kinds the switch arms. */
export const RECORDED_KINDS: readonly DeckTraceEvent["kind"][] = [
  "settle-frames",
  "settle-land",
  "settle-beat",
  "space-switch-frames",
];

/** What the switch armed, and what waits on a reload. */
export interface RecordReading {
  /** Whether the switch is on. */
  recording: boolean;
  /** The kinds armed now. */
  kinds: DeckTraceEvent["kind"][];
  /** Whether the deck trace is recording. */
  trace: boolean;
  /** Whether the commit census walks every commit now; `false` when it is not in this page. */
  census: boolean;
  /** Whether the lead recorder is in this page. */
  leadRecorder: boolean;
  /** Whether the next load carries the recorder and the census. */
  flagged: boolean;
  /** What is not in this page and comes with the next load, while recording. */
  nextLoad: string[];
}

interface CensusSwitch {
  record?: (on: boolean) => boolean;
}

/** The trace's state before `on`, so `off` can put it back. */
let traceBefore: boolean | null = null;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function census(): CensusSwitch | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window.__tugCommits as CensusSwitch | undefined);
}

function leadInstalled(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as unknown as { __tugLead?: unknown }).__tugLead !== undefined
  );
}

/** Turn the instruments on or off; with no argument, report where they stand. */
export function recordSwitch(on?: boolean): RecordReading {
  let censusWalks = false;
  if (on === true) {
    if (traceBefore === null) traceBefore = deckTrace.isEnabled();
    deckTrace.enable(true);
    for (const kind of RECORDED_KINDS) deckTrace.enableKind(kind, true);
    storage()?.setItem(MOTION_RECORD_FLAG, "1");
    censusWalks = census()?.record?.(true) ?? false;
  } else if (on === false) {
    for (const kind of RECORDED_KINDS) deckTrace.enableKind(kind, false);
    if (traceBefore !== null) deckTrace.enable(traceBefore);
    traceBefore = null;
    storage()?.removeItem(MOTION_RECORD_FLAG);
    censusWalks = census()?.record?.(false) ?? false;
  }
  const recording = traceBefore !== null;
  if (on === undefined) {
    // A report only: the census walks if this page loaded flagged and nobody
    // has turned it off since; asking it costs a call that changes nothing.
    censusWalks = recording && census()?.record !== undefined;
  }
  const kinds = RECORDED_KINDS.filter((kind) => deckTrace.isKindEnabled(kind));
  const nextLoad: string[] = [];
  if (recording && census()?.record === undefined) nextLoad.push("commit census");
  if (recording && !leadInstalled()) nextLoad.push("lead recorder");
  return {
    recording,
    kinds,
    trace: deckTrace.isEnabled(),
    census: censusWalks,
    leadRecorder: leadInstalled(),
    flagged: storage()?.getItem(MOTION_RECORD_FLAG) === "1",
    nextLoad,
  };
}

/**
 * A page that loaded with the flag set is recording from its first frame:
 * the census already walks, so the switch's own state has to say so, or the
 * first `off` would leave the trace on.
 */
export function adoptRecordFlagAtLoad(): void {
  if (storage()?.getItem(MOTION_RECORD_FLAG) === "1") recordSwitch(true);
}

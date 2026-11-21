/**
 * `catch-up-log` — one `tugcast.log` line for every catch-up a card makes,
 * written when it ends.
 *
 * A dormant body's reveal asks its session for what it missed
 * (`begin_catch_up`), and the reducer's catch-up record ({@link CatchUpState})
 * moves through `asked`, `open` and back to `none` by a dozen paths. Before
 * this module none of them said, afterwards, what had happened: a card that
 * woke still believing a turn ran (`briefs/card-turn-state-reconcile-brief.md`,
 * [F06]) left no line saying whether its catch-up was answered, how much the
 * answer carried, or what the card believed when it closed.
 *
 * The reducer stays pure: {@link CatchUpLog} watches the reductions the engine
 * runs — the state before and after each one, and the event between them —
 * and says a line when a catch-up ends:
 *
 * - `answered`: the bracket naming the ask opened and closed. The line counts
 *   the frames and turns the bracket carried, and says whether a held cycle
 *   survived the close ("never-drop chain link 13" in `handleReplayComplete`).
 *   A late answer, one that opened after the catch-up lapsed, says `late`.
 * - `lapsed`: `CATCH_UP_DEADLINE_MS` passed and no bracket opened.
 * - `let go`: the ask will never be answered — dropped by tugcast or tugcode,
 *   the wire closed, the session respawned twice, or it is gone.
 * - `re-asked`: the bracket the ask stood behind closed first, and the card
 *   asked again under a fresh id (`askAgainIfBehind`). The re-ask is its own
 *   catch-up and gets its own line.
 * - `superseded`: a newer reveal asked again while this ask was waiting.
 * - `refused`: the reveal asked nothing — inside the catch-up's own bracket,
 *   or on a wire that is not open.
 * - `closed`: the store closed while the catch-up stood.
 * - `answer set aside`: a bracket naming an ask the card made opened after
 *   that catch-up's line was written, and was shadowed rather than entered.
 *
 * Every line names the brackets set aside while the catch-up waited, with the
 * reason each was: `ahead-of-ask` (a bracket not its answer opened while it
 * waited), `let-go` (the answer to an ask let go), `inflight-only` and
 * `live-shadow` (an answer arriving over a turn the card is running).
 *
 * The body's own endings — a reveal over a session that cannot answer, which
 * asks nothing at all — are said by the body (`catchUpCard`, `body-main.ts`),
 * which is the one place that knows.
 *
 * @module lib/code-session-store/catch-up-log
 */

import type { CodeSessionEvent } from "./events";
import { phaseCanInterrupt } from "./lifecycle-state";
import type { CodeSessionState } from "./reducer";
import type { CodeSessionPhase } from "./types";

/** The `source` every catch-up line carries in `tugcast.log`. */
export const CATCH_UP_LOG_SOURCE = "catch-up";

/** One line to log: `deck: <message> source="catch-up" detail=<data>`. */
export interface CatchUpLine {
  readonly message: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Why a bracket was shadowed rather than entered while a catch-up stood. */
export type SetAsideReason = "ahead-of-ask" | "let-go" | "inflight-only" | "live-shadow";

interface CardReading {
  readonly phase: CodeSessionPhase;
  readonly canInterrupt: boolean;
  readonly pendingTurn: boolean;
  readonly turns: number;
}

interface Record_ {
  readonly askId: string;
  readonly cardId: string | null;
  readonly before: CardReading;
  readonly late: boolean;
  /** The ask this one replaced, when the card asked again behind a bracket. */
  readonly reaskOf: string | null;
  readonly setAside: Array<{ askId: string | null; reason: SetAsideReason }>;
  /** Set when the bracket answering the ask opened. */
  opened: { answeredBy: string; frames: number; turnsEnded: number } | null;
}

const TURN_ENDS: ReadonlySet<CodeSessionEvent["type"]> = new Set(["turn_complete", "turn_cancelled"]);

function reading(state: CodeSessionState, turns: number): CardReading {
  return {
    phase: state.phase,
    canInterrupt: phaseCanInterrupt(state.phase),
    pendingTurn: state.pendingTurn !== null,
    turns,
  };
}

/** The ending a catch-up that left `asked` with no bracket was given, from the event that ended it. */
function unansweredEnding(event: CodeSessionEvent): { ending: string; reason?: string } {
  switch (event.type) {
    case "tick_catch_up":
      return { ending: "lapsed" };
    case "request_replay_dropped":
      return { ending: "let go", reason: "dropped" };
    case "transport_close":
      return { ending: "let go", reason: "wire closed" };
    case "session_spawn_state":
      return { ending: "let go", reason: "respawned again" };
    default:
      return { ending: "let go", reason: event.type };
  }
}

/** Why the bracket `event` opened was shadowed, read from the state it opened over. */
function setAsideReason(prev: CodeSessionState, event: Extract<CodeSessionEvent, { type: "replay_started" }>): SetAsideReason {
  if (prev.catchUp.stage === "asked") return "ahead-of-ask";
  if (event.ask_id !== undefined && prev.catchUp.letGo.includes(event.ask_id)) return "let-go";
  if (event.inflight_only === true) return "inflight-only";
  return "live-shadow";
}

/**
 * Watches one session's reductions and says one line per catch-up when it
 * ends. Hold one per engine; call {@link observe} after every reduction,
 * {@link refused} when a reveal's ask was not taken, and {@link closed} when
 * the engine closes.
 */
export class CatchUpLog {
  private record: Record_ | null = null;
  /** The last catch-up to end, so a re-ask or a late answer after it keeps its card. */
  private lastEnded: Record_ | null = null;

  constructor(private readonly tugSessionId: string) {}

  /**
   * The reduction `prev` → `next` over `event` has run, and the transcript now
   * holds `turns` turns. Returns the lines it ended, oldest first: none for
   * almost every reduction.
   */
  observe(
    prev: CodeSessionState,
    next: CodeSessionState,
    event: CodeSessionEvent,
    turns: number,
    cardId?: string,
  ): CatchUpLine[] {
    const lines: CatchUpLine[] = [];
    const record = this.record;
    if (record?.opened != null && prev.catchUp.stage === "open") {
      record.opened.frames += 1;
      if (TURN_ENDS.has(event.type)) record.opened.turnsEnded += 1;
    }
    if (prev.catchUp === next.catchUp && event.type !== "replay_started") return lines;

    if (event.type === "replay_started" && next.replayShadowActive && !prev.replayShadowActive) {
      const setAside = { askId: event.ask_id ?? null, reason: setAsideReason(prev, event) };
      if (record !== null) {
        record.setAside.push(setAside);
      } else if (
        event.ask_id !== undefined &&
        (prev.catchUp.letGo.includes(event.ask_id) || prev.catchUp.asks.some((a) => a.id === event.ask_id))
      ) {
        lines.push(this.line("answer set aside", event.ask_id, this.lastEnded?.cardId ?? null, null, reading(prev, turns), next, turns, {
          reason: setAside.reason,
        }));
      }
    }

    const from = prev.catchUp.stage;
    const to = next.catchUp.stage;
    const newest = next.catchUp.asks[next.catchUp.asks.length - 1]?.id;

    if (to === "asked") {
      const begun = event.type === "begin_catch_up" ? event.askId : null;
      if (record !== null && begun !== null && begun !== record.askId) {
        lines.push(this.end(record, "superseded", next, turns, { by: begun }));
        this.record = null;
      } else if (record !== null && newest !== undefined && newest !== record.askId && record.opened === null) {
        lines.push(this.end(record, "re-asked", next, turns, { as: newest }));
        this.record = null;
      }
      if (this.record === null && newest !== undefined && (from !== "asked" || newest !== record?.askId)) {
        const earlier = record ?? this.lastEnded;
        this.record = {
          askId: newest,
          cardId: cardId ?? earlier?.cardId ?? null,
          before: begun === null ? (record?.before ?? reading(prev, turns)) : reading(prev, turns),
          late: false,
          reaskOf: begun === null ? (earlier?.askId ?? null) : null,
          setAside: [],
          opened: null,
        };
      }
      return lines;
    }

    if (to === "open" && from !== "open") {
      const answeredBy = next.catchUp.answering?.id ?? newest ?? "unknown";
      if (this.record === null) {
        this.record = {
          askId: answeredBy,
          cardId: this.lastEnded?.cardId ?? null,
          before: reading(prev, turns),
          late: true,
          reaskOf: null,
          setAside: [],
          opened: null,
        };
      }
      this.record.opened = { answeredBy, frames: 1, turnsEnded: 0 };
      return lines;
    }

    if (to === "none" && this.record !== null) {
      const ended = this.record;
      this.record = null;
      if (ended.opened !== null) {
        lines.push(this.end(ended, "answered", next, turns, {
          closedBy: event.type,
          result: next.lastReplayResult?.kind ?? null,
        }));
      } else {
        const { ending, reason } = unansweredEnding(event);
        lines.push(this.end(ended, ending, next, turns, {
          ...(reason !== undefined ? { reason } : {}),
          heldFrames: prev.catchUp.held.length,
        }));
      }
    }
    return lines;
  }

  /** The reveal's ask was not taken: `prev` is the state the reveal found. */
  refused(prev: CodeSessionState, askId: string, turns: number, cardId?: string): CatchUpLine {
    const reason =
      prev.catchUp.stage === "open" ? "inside its own bracket" : `wire ${prev.transportState}`;
    return this.line("refused", askId, cardId ?? null, null, reading(prev, turns), prev, turns, { reason });
  }

  /** The engine is closing: a catch-up still standing ends with it. */
  closed(state: CodeSessionState, turns: number): CatchUpLine | null {
    const record = this.record;
    this.record = null;
    return record === null ? null : this.end(record, "closed", state, turns, {});
  }

  private end(
    record: Record_,
    ending: string,
    after: CodeSessionState,
    turns: number,
    extra: Record<string, unknown>,
  ): CatchUpLine {
    this.lastEnded = record;
    return this.line(ending, record.askId, record.cardId, record, record.before, after, turns, extra);
  }

  private line(
    ending: string,
    askId: string,
    cardId: string | null,
    record: Record_ | null,
    before: CardReading,
    after: CodeSessionState,
    turns: number,
    extra: Record<string, unknown>,
  ): CatchUpLine {
    const late = record?.late === true;
    return {
      message: `catch-up ${ending}${late ? " late" : ""}`,
      data: {
        cardId,
        tugSessionId: this.tugSessionId,
        askId,
        ending,
        ...(late ? { late } : {}),
        ...(record?.reaskOf != null ? { reaskOf: record.reaskOf } : {}),
        ...(record?.opened != null
          ? {
              answeredBy: record.opened.answeredBy,
              frames: record.opened.frames,
              turnsEnded: record.opened.turnsEnded,
            }
          : {}),
        before,
        after: reading(after, turns),
        setAside: record?.setAside ?? [],
        ...extra,
      },
    };
  }
}

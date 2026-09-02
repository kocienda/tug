/**
 * dash-join-register — what the join says, in one sentence, everywhere.
 *
 * A dash on its way to landing passes through reconciling, ready, question,
 * joining, blocked. Three surfaces show that: the Dashes card's
 * row, the Changes shade's dash row, and the composer's status row. Before
 * this, each derived its own words, which is how two surfaces come to disagree
 * about one dash — and one of the sentences named a control that had been
 * deleted.
 *
 * So the sentence is derived exactly once, here, and it is a **pure function of
 * its arguments**: no store reads, no clock, no imports from `components/`.
 * Every caller passes what it already subscribes to ([L02]), which is what
 * makes the whole state→sentence table unit-testable with no DOM — the same
 * shape `deriveJoinFace` has.
 *
 * The `phase` it returns is a {@link ToolCallPhase}, the transcript's own
 * lifecycle vocabulary, because the register wears the transcript's own chrome:
 * `BlockHeader`'s pulsing dot already means *work in flight*, *waiting on a
 * person*, *settled green*, *settled red*. Inventing a second status vocabulary
 * for the same kind of fact is how two surfaces drift; reusing this one means
 * they cannot.
 *
 * @module lib/dash-join-register
 */

import type { ToolCallPhase } from "@/lib/code-session-store/tool-call-phase-visual";
import type { DashJoinStateWire } from "@/lib/changeset-types";

/** What one dash's join reads as right now. */
export interface DashJoinRegister {
  /** The lifecycle dot's phase — pulsing, settled, or quiet. */
  phase: ToolCallPhase;
  /** The sentence. Always says what is happening or what is wanted. */
  line: string;
  /** One word for the trailing summary slot — the state, named. */
  word: string;
}

/**
 * The stage words that mean "this dash can be joined" ([D147], Spec S04).
 *
 * The server derives readiness once and spends it on a single word; this is
 * the client's reading of that word, and it is deliberately a set rather than
 * an equality test — `ready` is the derived arm, `built` and `audited` are the
 * declarations that outrank it, and all three describe the same joinable dash.
 * A test against one of them alone leaves the register dark on the other two
 * while the join modal fires.
 */
const JOINABLE_STAGES = new Set(["ready", "built", "audited"]);

/** Everything the register reads. Nothing here is fetched; it is all passed. */
export interface DashJoinRegisterInput {
  /** The dash's display name. */
  dash: string;
  /** The base branch it joins onto. */
  base: string;
  /** The dash's stage — `ready`, `built` and `audited` reach the decision states. */
  stage?: string | null;
  /** The `join` block from the dash's feed entry. */
  join?: DashJoinStateWire | null;
  /** The client's resolve overlay phase for this dash. */
  resolvePhase?: "idle" | "resolving" | "error";
  /**
   * What a join last reported ([P03]) — a beat while it runs, its result once
   * it is over (`terminal`).
   */
  landBeat?: { beat: string; status: string; terminal?: boolean } | null;
  /** Whether the deck's wire is up. */
  connected?: boolean;
  /**
   * Whether a session holding this dash is still working — mid-turn, or
   * waiting on a background job it launched. Straight off the feed's
   * `holders_busy`.
   *
   * A join is an offer to land finished work, so it is not made until the work
   * is finished. The turn ending is not that: the model stops speaking while
   * the tests it backgrounded are still deciding whether the dash is any good,
   * and a "Ready to join" shown in that window invites the user to land
   * something nobody has finished checking.
   */
  holdersBusy?: boolean;
  /**
   * Whether any live session holds this dash.
   *
   * The pilot works only for bound dashes ([D147]), so an unbound one is not
   * mid-check — nothing is going to happen to it at all. Defaults to `true`
   * for the callers that only ever render a dash they are holding.
   */
  bound?: boolean;
}

/**
 * How long a landed join rests on its own last word before the surface
 * carrying it stands down.
 *
 * A success that vanished on the terminal frame would be a progress surface
 * that erases its own result — the failure `LandProgress.terminal` exists to
 * prevent one layer down. A failure never rests out: it is the one outcome the
 * user has something to do about.
 *
 * One constant for both surfaces that settle — the inline join surface departs
 * on it, and the composer register retires its narration on it — so the two
 * cannot leave the screen at different moments telling the same story.
 */
export const SETTLED_REST_MS = 1600;

/**
 * The words each beat of a join in flight reads as.
 *
 * Exported because the inline join surface's landing phase narrates the same
 * beats from the same store, and two tables for one vocabulary drift the
 * moment one of them gains a beat.
 */
export const BEAT_WORDS: Record<string, string> = {
  // The front of the run: `requested` is written by the press itself and
  // `preflight` by the server the moment it accepts one, so the span before
  // the squash — occupancy, the identity reads, the join's own preflight —
  // has words of its own instead of resting on "Ready to join" ([P01], [P03]).
  requested: "starting",
  preflight: "checking the base",
  squash: "squashing",
  teardown: "tearing down the workshop",
  release: "releasing the branch",
  record: "recording the landing",
};

/**
 * What the arc says about one dash.
 *
 * **The arm order is the whole derivation**, and it is the part a later reader
 * will re-derive wrongly, so it is stated here rather than left to be inferred
 * from the `if`s:
 *
 * 1. **wire-drop** — nothing below can be trusted when the feed is not
 *    arriving. Every other state is a claim about a moment that may be past.
 * 2. **joining** — a live join is the most specific thing happening, and it
 *    outranks both the verdict that permitted it and any blocker. A blocker
 *    answers *may this dash be joined*; a join in flight is past that question,
 *    so a refusal painted over a running join reports a decision that has
 *    already been made.
 * 3. **blocked** — an act somebody must take elsewhere, which outranks a green
 *    verdict: a tree that builds still cannot land onto a dirty base.
 * 4. **question** — a person is being waited on. Louder than a run, because a
 *    run that is waiting is not progressing.
 * 5. **stuck** — a refusal already stated, which is not a wait.
 * 6. **running** — the pilot's reconcile or check, from the feed's own `run`
 *    fact or the client's overlay.
 * 7. **verdict** — red, then green.
 * 7a. **still working** — above the readiness arms only. A dash whose holder
 *    has not stopped is not being offered, but a join already in flight, a
 *    blocker, a question and a stated refusal all outrank it: each reports
 *    something that has already happened, and none of them is an offer.
 * 8. **nothing** — a dash still being worked has no join yet, and `null`
 *    is how that is said. A register with nothing to report does not mount.
 */
export function dashJoinRegister(
  input: DashJoinRegisterInput,
): DashJoinRegister | null {
  const { dash, base, join, landBeat } = input;
  const connected = input.connected ?? true;

  // **The arc begins where the dash is joinable.** The server derives that and
  // says it in one word — `ready` for a dash whose facts arm it, `built` or
  // `audited` for one somebody declared finished ([D147]). Before that there is
  // nothing to say: a dash being worked is not trying to join, and its blockers
  // are not a join failure — a freshly created dash with no rounds carries an
  // `empty` blocker that means "nothing here yet", which read as a join refusal
  // would put a red register on every new dash in the Dashes card.
  //
  // The exception is anything that implies somebody already acted. A live
  // join, a run in flight, a standing question or a stated refusal cannot
  // happen to a dash nobody has touched, and each of them is worth saying
  // whatever the stage reads.
  const acted =
    (landBeat !== null && landBeat !== undefined) ||
    (join?.run ?? null) !== null ||
    input.resolvePhase === "resolving" ||
    (join?.question ?? null) !== null ||
    (typeof join?.stuck === "string" && join.stuck !== "");
  if (!JOINABLE_STAGES.has(input.stage ?? "") && !acted) return null;

  if (!connected) {
    return {
      phase: "idle",
      line: "Connection dropped — the run continues on the server",
      word: "offline",
    };
  }

  // Above the blockers, deliberately. A press that is refused on the live
  // re-check has its beat retracted (`JoinModeController.retractNarration`), so
  // a standing non-terminal beat means a join really is running — and a running
  // join is past the question blockers answer.
  const landing = landBeat ?? null;
  if (landing !== null && landing.terminal !== true) {
    const beat = BEAT_WORDS[landing.beat] ?? landing.beat;
    return {
      phase: "in_flight",
      line: `Joining ${dash} into ${base} — ${beat}`,
      word: "joining",
    };
  }

  const blockers = join?.blockers ?? [];
  if (blockers.length > 0) {
    return {
      phase: "error",
      // The blocker's own sentence, which names the act that clears it — a
      // sentence composed here instead would be a second, worse copy.
      line: blockers[0]?.detail ?? "This join is blocked",
      word: "blocked",
    };
  }

  if (join?.question !== undefined && join.question !== null) {
    return {
      phase: "awaiting",
      line: "The resolver needs a decision — answer the prompt",
      word: "question",
    };
  }

  if (typeof join?.stuck === "string" && join.stuck !== "") {
    return { phase: "error", line: join.stuck, word: "stuck" };
  }

  const running = join?.run ?? (input.resolvePhase === "resolving" ? "resolve" : null);
  if (running === "resolve") {
    const files = join?.conflicts?.length ?? 0;
    return {
      phase: "in_flight",
      line:
        files > 0
          ? `Reconciling with ${base} — resolving ${files} ${files === 1 ? "file" : "files"}`
          : `Reconciling with ${base}`,
      word: "reconciling",
    };
  }
  // The run's last word, which rests until a new press replaces it. Below the
  // blocker, the question and the stated refusal — each of those explains a
  // failure better than "Join failed" does — and above the readiness line,
  // because a "ready to join" left standing over a join that did not land
  // would read as an invitation to do the thing that just failed.
  if (landing !== null) {
    const ok = landing.status !== "error";
    return {
      phase: ok ? "success" : "error",
      line: ok ? `Joined ${dash} into ${base}` : `Join failed — ${dash} is still here`,
      word: ok ? "joined" : "join-failed",
    };
  }

  // Everything above reports something already in motion. Everything below
  // *offers* the join — and an offer waits for the work to be finished, which
  // the turn ending does not mean on its own.
  if (input.holdersBusy === true) {
    return {
      phase: "in_flight",
      line: `${dash} is still working — the join waits for it to finish`,
      word: "working",
    };
  }

  // A candidate that stands is the whole readiness fact now. Nothing is built
  // here: the run's ending verified the tree that lands, so reconcile-clean is
  // what the arc was waiting for.
  if (typeof join?.candidate === "string" && join.candidate !== "") {
    return { phase: "success", line: "Ready to join", word: "ready" };
  }

  // No candidate, nothing running. On a joinable dash somebody is holding,
  // that is the gap between the recompute and the pilot's dispatch landing — a
  // beat away rather than a resting state, so it reads as the reconcile that
  // is about to happen.
  //
  // On an **unbound** one it is not a gap at all: the pilot never runs for a
  // dash nobody holds, so naming a reconcile would be a promise the machine
  // has already declined to keep, standing forever. Say nothing instead —
  // `/dash-join <name>` and binding a card are both still open, and neither is a
  // thing this line was reporting.
  if (JOINABLE_STAGES.has(input.stage ?? "")) {
    return (input.bound ?? true)
      ? { phase: "in_flight", line: `Reconciling with ${base}`, word: "reconciling" }
      : null;
  }

  // Reachable only through the `acted` exception above: a run that has ended
  // on a dash that never became joinable. Nothing to report.
  return null;
}

/**
 * arc-join-register — what the join says, in one sentence, everywhere.
 *
 * An arc on its way to landing passes through reconciling, ready, question,
 * joining, blocked. Three surfaces show that: the Arcs card's
 * row, the Changes shade's arc row, and the composer's status row. Before
 * this, each derived its own words, which is how two surfaces come to disagree
 * about one arc — and one of the sentences named a control that had been
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
 * @module lib/arc-join-register
 */

import type { ToolCallPhase } from "@/lib/code-session-store/tool-call-phase-visual";
import type { ArcJoinStateWire, ArcRunState } from "@/lib/changeset-types";

/** What one arc's join reads as right now. */
export interface ArcJoinRegister {
  /** The lifecycle dot's phase — pulsing, settled, or quiet. */
  phase: ToolCallPhase;
  /** The sentence. Always says what is happening or what is wanted. */
  line: string;
  /** One word for the trailing summary slot — the state, named. */
  word: string;
}

/**
 * The stage words that mean "this arc can be joined" ([D147], Spec S04).
 *
 * The server derives readiness once and spends it on a single word; this is
 * the client's reading of that word, and it is deliberately a set rather than
 * an equality test — `ready` is the derived arm, `built` and `audited` are the
 * declarations that outrank it, and all three describe the same joinable arc.
 * A test against one of them alone leaves the register dark on the other two
 * while the join modal fires.
 */
const JOINABLE_STAGES = new Set(["ready", "built", "audited"]);

/**
 * The register's word for an arc that can be joined.
 *
 * Named rather than spelled at each site because the Z2 ARC cell says it too
 * ([B08]): while a join offer stands the cell reads the register's word rather
 * than the lifecycle's `Finished`, and one constant is what keeps the cell,
 * the Arcs card row and the shade from saying two things about one arc.
 */
export const ARC_JOIN_READY_WORD = "ready";

/**
 * The register's sentence for an arc that can be joined.
 *
 * The base is in it because on the Arcs card the sentence is the only thing
 * that names the branch the offer is about — see the ready arm below. Exported
 * for the masthead beat, which composes this line over the narration
 * digester's while the offer stands ([B10]); composing it there from the same
 * function is what keeps the two surfaces one sentence rather than two that
 * happen to match today.
 */
export function arcJoinReadyLine(base: string): string {
  return `Ready to join to ${base}`;
}

/** Everything the register reads. Nothing here is fetched; it is all passed. */
export interface ArcJoinRegisterInput {
  /** The arc's display name. */
  arc: string;
  /** The base branch it joins onto. */
  base: string;
  /** The arc's stage — `ready`, `built` and `audited` reach the decision states. */
  stage?: string | null;
  /** The `join` block from the arc's feed entry. */
  join?: ArcJoinStateWire | null;
  /** The client's resolve overlay phase for this arc. */
  resolvePhase?: "idle" | "resolving" | "error";
  /**
   * Which act the client's overlay is running, when one is.
   *
   * The two acts share the resolving phase and do not share a sentence: a
   * ladder run reconciles, a fold commits base work. Read beside `join.run` so
   * the register speaks from the press rather than waiting for the recompute
   * that confirms it.
   */
  resolveAct?: "resolve" | "resolve-base";
  /**
   * What a join last reported ([P03]) — a beat while it runs, its result once
   * it is over (`terminal`).
   */
  landBeat?: { beat: string; status: string; terminal?: boolean } | null;
  /** Whether the deck's wire is up. */
  connected?: boolean;
  /**
   * Whether a session holding this arc is still working — mid-turn, or
   * waiting on a background job it launched. Straight off the feed's
   * `holders_busy`.
   *
   * A join is an offer to land finished work, so it is not made until the work
   * is finished. The turn ending is not that: the model stops speaking while
   * the tests it backgrounded are still deciding whether the arc is any good,
   * and a "Ready to join" shown in that window invites the user to land
   * something nobody has finished checking.
   */
  holdersBusy?: boolean;
  /**
   * Whether any live session holds this arc.
   *
   * The pilot works only for bound arcs ([D147]), so an unbound one is not
   * mid-check — nothing is going to happen to it at all. Defaults to `true`
   * for the callers that only ever render an arc they are holding.
   */
  bound?: boolean;
  /**
   * The run driving this arc, when one is — the wheel's own record of which
   * stage is seated and whether it has finished ([P06]).
   *
   * Optional, and absent is not "there is no run": two of the five call sites
   * pass nothing on purpose, and the arm that reads this does not fire on
   * `undefined`, so those two keep today's behavior exactly.
   */
  run?: ArcRunState | null;
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
 * What the arc says about one arc.
 *
 * **The arm order is the whole derivation**, and it is the part a later reader
 * will re-derive wrongly, so it is stated here rather than left to be inferred
 * from the `if`s:
 *
 * 1. **wire-drop** — nothing below can be trusted when the feed is not
 *    arriving. Every other state is a claim about a moment that may be past.
 * 2. **joining** — a live join is the most specific thing happening, and it
 *    outranks both the verdict that permitted it and any blocker. A blocker
 *    answers *may this arc be joined*; a join in flight is past that question,
 *    so a refusal painted over a running join reports a decision that has
 *    already been made.
 * 2a. **folding** — the fold that commits the base-side work refusing this
 *    join, from the feed's `run` fact or the client's own act. It sits here
 *    for the same reason a join does: the fold is past the question the
 *    blocker it is clearing asks, so the blocker's refusal must not paint over
 *    the act clearing it.
 * 3. **blocked** — an act somebody must take elsewhere, which outranks a green
 *    verdict: a tree that builds still cannot land onto a dirty base.
 * 4. **question** — a person is being waited on. Louder than a run, because a
 *    run that is waiting is not progressing.
 * 5. **stuck** — a refusal already stated, which is not a wait.
 * 6. **running** — the pilot's reconcile or check, from the feed's own `run`
 *    fact or the client's overlay.
 * 7. **verdict** — red, then green.
 * 7a. **still working** — above the readiness arms only. An arc whose holder
 *    has not stopped is not being offered, but a join already in flight, a
 *    blocker, a question and a stated refusal all outrank it: each reports
 *    something that has already happened, and none of them is an offer.
 * 7b. **the arc is still running** — beside 7a and for the same reason: the
 *    work is not finished. A live wheel means a stage is seated, and the audit
 *    is the one that most often is; it commits fixup rounds, so the tree the
 *    join would land is still moving.
 * 7c. **the audit stopped** — and did not mark. A stop in any earlier stage
 *    releases the offer, because the join was always possible without a
 *    wheel; a stop in the audit is different in kind, because the stop *means*
 *    nothing audited the tree. The server holds `join_ready` shut over it and
 *    this arm says why, as a wait on a person rather than as readiness.
 * 8. **nothing** — an arc still being worked has no join yet, and `null`
 *    is how that is said. A register with nothing to report does not mount.
 */
export function arcJoinRegister(
  input: ArcJoinRegisterInput,
): ArcJoinRegister | null {
  const { arc, base, join, landBeat } = input;
  const connected = input.connected ?? true;

  // **The arc begins where the arc is joinable.** The server derives that and
  // says it in one word — `ready` for an arc whose facts arm it, `built` or
  // `audited` for one somebody declared finished ([D147]). Before that there is
  // nothing to say: an arc being worked is not trying to join, and its blockers
  // are not a join failure — a freshly created arc with no rounds carries an
  // `empty` blocker that means "nothing here yet", which read as a join refusal
  // would put a red register on every new arc in the Arcs card.
  //
  // The exception is anything that implies somebody already acted. A live
  // join, a run in flight, a standing question or a stated refusal cannot
  // happen to an arc nobody has touched, and each of them is worth saying
  // whatever the stage reads.
  //
  // A stopped audit is the same kind of exception. The server holds
  // `join_ready` shut over it, so its stage reads below joinable — and that
  // is exactly the arc this register has a sentence for, because the stop
  // means somebody has to choose between resuming the audit and landing
  // without one. Silence here would be the gate hiding the one wait it was
  // built to surface.
  const run = input.run ?? null;
  const auditStopped =
    run !== null &&
    run.done !== true &&
    (run.stopped ?? "") !== "" &&
    run.stopped_stage === "audit" &&
    input.stage !== "audited";
  const acted =
    (landBeat !== null && landBeat !== undefined) ||
    (join?.run ?? null) !== null ||
    input.resolvePhase === "resolving" ||
    input.resolveAct === "resolve-base" ||
    (join?.question ?? null) !== null ||
    (typeof join?.stuck === "string" && join.stuck !== "") ||
    auditStopped;
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
      line: `Joining ${arc} into ${base} — ${beat}`,
      word: "joining",
    };
  }

  const blockers = join?.blockers ?? [];
  // The fold, above the blocker it is clearing (2a). Its own act is read
  // beside the feed's, because the recompute that puts `run` on the entry
  // lands a moment after the press and the register may not go quiet in
  // between — a sentence that arrives late is the seam this whole round is
  // about.
  if (join?.run === "resolve-base" || input.resolveAct === "resolve-base") {
    const files = blockers
      .filter((blocker) => blocker.kind === "base-dirt")
      .reduce((sum, blocker) => sum + (blocker.paths?.length ?? 0), 0);
    return {
      phase: "in_flight",
      line:
        files > 0
          ? `Committing base work · ${files} ${files === 1 ? "file" : "files"}`
          : "Committing base work",
      word: "committing",
    };
  }

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
      line: ok ? `Joined ${arc} into ${base}` : `Join failed — ${arc} is still here`,
      word: ok ? "joined" : "join-failed",
    };
  }

  // Everything above reports something already in motion. Everything below
  // *offers* the join — and an offer waits for the work to be finished, which
  // the turn ending does not mean on its own.
  if (input.holdersBusy === true) {
    return {
      phase: "in_flight",
      line: `${arc} is still working — the join waits for it to finish`,
      word: "working",
    };
  }

  // A live wheel is the same category as a busy holder: the work is not
  // finished, so the join is not offered. It sits here rather than below the
  // candidate because everything above this line reports something in motion
  // and everything below it makes an offer.
  //
  // Without it, [P05]'s gate produces a worse sentence than the one it fixes.
  // `JOINABLE_STAGES` still contains `built` and `derive_stage` still says
  // `built` mid-audit, so with `join_ready` false there is no candidate and the
  // fall-through would paint `Reconciling with <base>` — a sentence promising
  // something imminent — for the whole length of an audit.
  //
  // This also speaks for an **unbound** arc, where the `Reconciling`
  // fall-through below is silent by design. That difference is intended: the
  // fall-through is silent because the *pilot* never runs for an arc nobody
  // holds, which is a statement about a promise, whereas a running audit is a
  // fact about the work and is true whoever is holding it.
  //
  // **Two things it does not speak over.** An arc whose derived stage is
  // already `audited` has had the audit sign off — `derive_stage` returns that
  // word only for a declared `audited`, which is the same declaration [P05]'s
  // gate arms the join on — so holding the offer shut there would deny an
  // offer the server has already made, for as long as `arc-done` takes to
  // land. And a record carrying no rotated stage has no seat to name: there is
  // nothing running to wait for, and the sentence below would interpolate the
  // absence into the user's face.
  const runStage = run?.stage ?? "";
  if (
    run !== null &&
    run.done !== true &&
    (run.stopped ?? "") === "" &&
    runStage !== "" &&
    input.stage !== "audited"
  ) {
    return run.stage === "audit"
      ? {
          phase: "in_flight",
          line: `${arc} is being audited — the join waits for it`,
          word: "auditing",
        }
      : {
          phase: "in_flight",
          line: `${arc} is in ${run.stage} — the join waits for the audit`,
          word: "arc-running",
        };
  }

  // A stopped audit is not a released offer. Every other stop falls through
  // to the candidate — the join never needed a wheel — but a stop in the
  // audit stage, whatever its reason and whoever stopped it, is an arc whose
  // audit did not mark, and the sentence that fits is the caution pulse the
  // register already defines for work that has stopped for somebody. The join
  // stays possible (`/arc-join` lands an unaudited branch, and its receipt
  // says so); what this line never does is call it ready. A derived
  // `audited` stage outranks it for the same reason it outranks the arm above.
  if (auditStopped) {
    return {
      phase: "awaiting",
      line: `${arc}'s audit stopped — resume it, or land it unaudited`,
      word: "unaudited",
    };
  }

  // A candidate that stands is the whole readiness fact now. Nothing is built
  // here: the run's ending verified the tree that lands, so reconcile-clean is
  // what the arc was waiting for.
  //
  // The sentence names the base because on the Arcs card it is now the only
  // thing that does: a ready arc reads in the lifecycle line's own words and
  // the register band under it is not drawn at all ([P08]), so "Ready to join"
  // alone would have dropped the branch the offer is about. It is derived here
  // rather than composed at any surface, which is what keeps the shade, the
  // composer and the card reading one sentence.
  if (typeof join?.candidate === "string" && join.candidate !== "") {
    return {
      phase: "success",
      line: arcJoinReadyLine(base),
      word: ARC_JOIN_READY_WORD,
    };
  }

  // No candidate, nothing running. On a joinable arc somebody is holding,
  // that is the gap between the recompute and the pilot's dispatch landing — a
  // beat away rather than a resting state, so it reads as the reconcile that
  // is about to happen.
  //
  // On an **unbound** one it is not a gap at all: the pilot never runs for a
  // arc nobody holds, so naming a reconcile would be a promise the machine
  // has already declined to keep, standing forever. Say nothing instead —
  // `/arc-join <name>` and binding a card are both still open, and neither is a
  // thing this line was reporting.
  if (JOINABLE_STAGES.has(input.stage ?? "")) {
    return (input.bound ?? true)
      ? { phase: "in_flight", line: `Reconciling with ${base}`, word: "reconciling" }
      : null;
  }

  // Reachable only through the `acted` exception above: a run that has ended
  // on an arc that never became joinable. Nothing to report.
  return null;
}

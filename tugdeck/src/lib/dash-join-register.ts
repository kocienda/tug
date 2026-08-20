/**
 * dash-join-register — what the join arc says, in one sentence, everywhere.
 *
 * A dash on its way to landing passes through reconciling, checking, ready,
 * question, red, joining, blocked. Three surfaces show that: the Lens Dashes
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

/** What one dash's join arc reads as right now. */
export interface DashJoinRegister {
  /** The lifecycle dot's phase — pulsing, settled, or quiet. */
  phase: ToolCallPhase;
  /** The sentence. Always says what is happening or what is wanted. */
  line: string;
  /** One word for the trailing summary slot — the state, named. */
  word: string;
}

/** Everything the register reads. Nothing here is fetched; it is all passed. */
export interface DashJoinRegisterInput {
  /** The dash's display name. */
  dash: string;
  /** The base branch it joins onto. */
  base: string;
  /** The dash's stage — only `built` reaches the decision states. */
  stage?: string | null;
  /** The `join` block from the dash's feed entry. */
  join?: DashJoinStateWire | null;
  /** The client's resolve overlay phase for this dash. */
  resolvePhase?: "idle" | "resolving" | "error";
  /** The beat a join in flight last reported ([P03]). */
  landBeat?: { beat: string; status: string } | null;
  /** Whether the deck's wire is up. */
  connected?: boolean;
}

/** The words each beat of a join in flight reads as. */
const BEAT_WORDS: Record<string, string> = {
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
 * 2. **blocked** — a blocker is an act somebody must take elsewhere, and it
 *    outranks a green verdict: a tree that builds still cannot land onto a
 *    dirty base.
 * 3. **joining** — a live join is the most specific thing happening, and it
 *    outranks the verdict that permitted it.
 * 4. **question** — a person is being waited on. Louder than a run, because a
 *    run that is waiting is not progressing.
 * 5. **stuck** — a refusal already stated, which is not a wait.
 * 6. **running** — the pilot's reconcile or check, from the feed's own `run`
 *    fact or the client's overlay.
 * 7. **verdict** — red, then green.
 * 8. **nothing** — a dash still being worked has no join arc yet, and `null`
 *    is how that is said. A register with nothing to report does not mount.
 */
export function dashJoinRegister(
  input: DashJoinRegisterInput,
): DashJoinRegister | null {
  const { dash, base, join, landBeat } = input;
  const connected = input.connected ?? true;

  // **The arc begins at `built`.** Before that there is nothing to say: a dash
  // being worked is not trying to join, and its blockers are not a join
  // failure — a freshly created dash with no rounds carries an `empty` blocker
  // that means "nothing here yet", which read as a join refusal would put a
  // red register on every new dash in the Lens.
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
  if (input.stage !== "built" && !acted) return null;

  if (!connected) {
    return {
      phase: "idle",
      line: "Connection dropped — the run continues on the server",
      word: "offline",
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

  if (landBeat !== null && landBeat !== undefined) {
    const beat = BEAT_WORDS[landBeat.beat] ?? landBeat.beat;
    return {
      phase: "in_flight",
      line: `Joining ${dash} into ${base} — ${beat}`,
      word: "joining",
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
  if (running === "verify") {
    return { phase: "in_flight", line: "Building the joined tree", word: "checking" };
  }

  const tier0 = join?.verification?.tier0;
  if (tier0 === "red") {
    return {
      phase: "error",
      line: "Build red on the joined tree — join is a decision now",
      word: "checks-red",
    };
  }
  if (tier0 === "running") {
    return { phase: "in_flight", line: "Building the joined tree", word: "checking" };
  }
  if (tier0 === "green") {
    return { phase: "success", line: "Ready to join", word: "ready" };
  }

  // No verdict, nothing running. On a `built` dash that is the gap between the
  // recompute and the pilot's dispatch landing — a beat away rather than a
  // resting state, so it reads as the check that is about to happen.
  if (input.stage === "built") {
    return { phase: "in_flight", line: "Building the joined tree", word: "checking" };
  }

  // Reachable only through the `acted` exception above: a run that has ended
  // on a dash that never reached `built`. Nothing to report.
  return null;
}

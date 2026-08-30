/**
 * tripwire-presentation — English for everything the tripwire ledger stores as
 * an enum, a JSON blob, or a mode string.
 *
 * The section used to print `trip.status` and `swallow_reason` straight out of
 * the row, so a reader met `settled` and `swallowed: cooldown` with nothing to
 * read them against. A status enum is a name two halves of the engine agree on;
 * it is not a sentence, and a surface that shows one is asking its reader to
 * have read the schema.
 *
 * Pure functions, no React, no store: every one of these takes a row and
 * returns a string, which is what makes the vocabulary something tests pin
 * rather than something a component decides in passing.
 *
 * @module components/lens/sections/tripwire-presentation
 */

import type { TripRow, TripwireRow } from "@/lib/tripwires-store";

/**
 * What a trip is doing, in the five states a reader actually distinguishes.
 *
 * The ledger's seven statuses collapse here on purpose: `claimed` and `queued`
 * are both "it hasn't started", and `swallowed` and `superseded` are both "it
 * never ran". The differences between them matter to the engine and to the
 * `swallow_reason` sentence below — they do not deserve four glyphs.
 *
 * `awaiting` is the one status that does not collapse into anything. A run
 * that resolved awaiting has finished and is holding the wire's live-run slot
 * until somebody sees what it found ([P07]) — the only state on this list that
 * is waiting on a person rather than on a machine.
 */
export type TripState =
  | "waiting"
  | "running"
  | "awaiting"
  | "finished"
  | "failed"
  | "skipped";

export function tripState(trip: TripRow): TripState {
  switch (trip.status) {
    case "running":
      return "running";
    case "awaiting":
      return "awaiting";
    case "settled":
      return "finished";
    case "failed":
      return "failed";
    case "swallowed":
    case "superseded":
      return "skipped";
    default:
      return "waiting";
  }
}

/**
 * Why a trip was skipped or stopped, as a clause that finishes "Didn't run —"
 * or "Stopped —".
 *
 * An unrecognized reason is passed through rather than swallowed: a reason the
 * engine writes and this table has not learned yet is still more use to a
 * reader than nothing, and it shows up as slightly-off English rather than as
 * a silence nobody can debug.
 */
function reasonClause(reason: string): string {
  switch (reason) {
    case "busy":
      return "this tripwire was already working a trip";
    case "own-dash":
      return "the landing was this tripwire's own dash";
    case "no-scope":
      return "the event was outside this tripwire's scope";
    case "superseded":
      return "a newer event took its place";
    case "instance restarted":
      return "Tug restarted while it was running";
    case "abandoned":
      return "the run was abandoned";
    default:
      return reason;
  }
}

/**
 * What a trip row says when the agent left no headline.
 *
 * Every trip says something, because the whole value of the log is that a
 * firing which produced no post is still visible in it. A trip that never ran
 * says so in a full sentence and gives the reason inline, which is what
 * retires the bare `swallowed: cooldown` this replaced.
 */
export function tripSentence(trip: TripRow): string {
  const reason = trip.swallow_reason;
  switch (tripState(trip)) {
    case "running":
      return "Running now…";
    case "awaiting":
      return "Waiting for you to look.";
    case "waiting":
      return trip.status === "queued"
        ? "Waiting — this tripwire is already busy."
        : "Starting…";
    case "skipped":
      return `Didn't run — ${reasonClause(reason ?? "superseded")}.`;
    case "failed":
      return reason === null
        ? "Stopped before it finished."
        : `Stopped — ${reasonClause(reason)}.`;
    case "finished":
      return "Finished with nothing to report.";
  }
}

/**
 * The short state word beside a trip's time.
 *
 * Returns null for the states {@link tripSentence} already spells out, so a row
 * never says "Didn't run" twice. It is the headline-bearing rows that need this:
 * their body is the agent's prose, which says what was found and not whether the
 * trip is over.
 */
export function tripStateLabel(trip: TripRow): string | null {
  switch (tripState(trip)) {
    case "running":
      return "running";
    case "awaiting":
      return "awaiting";
    case "finished":
      return "finished";
    case "failed":
      return "stopped";
    default:
      return null;
  }
}

/**
 * The dot a row earns, as the three things a dot can mean here and nothing
 * else ([P08]).
 *
 * A decision rather than a component because it is made twice — once for a
 * roster row, reading the tripwire's projection, and once for a trip in the
 * log, reading the trip — and the two must agree. Two components each deciding
 * for themselves is how a roster comes to pulse for a run its own log calls
 * finished.
 *
 * `session` is the live pulse, keyed on the session the run is in, which is
 * what `SessionPhaseDot` reads. `working` is the same liveness with no session
 * to key on: a trip inside its probe is running before any session exists, and
 * a session dot keyed on nothing would answer `idle` and rest — a still dot on
 * a wire that is working. `awaiting` is the held state, and it is deliberately
 * not a session dot: by the time a trip is awaiting its session has ended, and
 * `useSessionPhase` answers `idle` for a session it cannot reach.
 */
export type TripwireDot =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "working" }
  | { readonly kind: "awaiting" }
  | null;

/** The roster row's dot. Nothing at rest — a wire with no run in flight and no
 *  question outstanding has nothing to say, and says it with silence. */
export function tripwireDot(tripwire: TripwireRow): TripwireDot {
  if (tripwire.running) {
    return tripwire.running_session === null
      ? { kind: "working" }
      : { kind: "session", sessionId: tripwire.running_session };
  }
  return tripwire.awaiting ? { kind: "awaiting" } : null;
}

/** One trip's dot in the log — the same three meanings, read off the row. */
export function tripDot(trip: TripRow): TripwireDot {
  switch (tripState(trip)) {
    case "running":
      return trip.session_id === null
        ? { kind: "working" }
        : { kind: "session", sessionId: trip.session_id };
    case "awaiting":
      return { kind: "awaiting" };
    default:
      return null;
  }
}

/**
 * A trigger predicate, read back as the sentence somebody would have said to
 * lay it.
 *
 * The stored trigger is the Spec S01 JSON verbatim, which is the right thing to
 * store and the wrong thing to show: `{"commit":{}}` tells a reader nothing
 * about what this tripwire is watching. A trigger this build cannot parse falls
 * back to its own text — an older deck against a newer predicate grammar shows
 * the raw JSON rather than claiming the tripwire watches for nothing.
 */
export function describeTrigger(trigger: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trigger);
  } catch {
    return trigger;
  }
  if (typeof parsed !== "object" || parsed === null) return trigger;
  const value = parsed as Record<string, unknown>;

  if ("fact" in value) {
    const fact = (value.fact ?? {}) as Record<string, unknown>;
    const kind = typeof fact.kind === "string" ? fact.kind : null;
    if (kind === null) return trigger;
    const head = `Any ${kind} fact`;
    const where = fact.where;
    if (typeof where !== "object" || where === null) return head;
    const clauses = Object.entries(where as Record<string, unknown>).map(([field, m]) =>
      describeMatcher(field, m),
    );
    return clauses.length === 0 ? head : `${head} where ${clauses.join(" and ")}`;
  }

  return trigger;
}

/** One `where` clause. A bare string is the exact match, as the grammar has it. */
function describeMatcher(field: string, matcher: unknown): string {
  if (typeof matcher === "string") return `${field} is ${matcher}`;
  if (typeof matcher === "object" && matcher !== null) {
    const m = matcher as Record<string, unknown>;
    if (typeof m.contains === "string") return `${field} contains ${m.contains}`;
    if (typeof m.prefix === "string") return `${field} starts with ${m.prefix}`;
  }
  return `${field} matches`;
}

/** What the tripwire runs before the AI sees anything. */
export function describeProbe(probe: string | null): string {
  return probe ?? "Nothing — the AI looks at the event itself";
}

/** Where the tripwire is listening. */
export function describeScope(scope: string | null): string {
  return scope ?? "Anywhere on this machine";
}

/**
 * What the tripwire's agent is allowed to do.
 *
 * The reassurance is the important half: a permissive posture is safe because
 * the agent works on its own dash worktree, never in the checkout you are in,
 * and a reader deciding whether to trust a tripwire is entitled to that fact
 * on the surface rather than in the doctrine.
 */
export function describePermissions(mode: string): string {
  switch (mode) {
    case "acceptEdits":
      return "Can write, in a dash worktree of its own";
    case "plan":
    case "read-only":
      return "Read-only — it diagnoses, it does not change files";
    default:
      return mode;
  }
}

/**
 * A brief's gist: its first sentence, and no more than a line's worth of it.
 *
 * A brief is the whole instruction a trip runs on, and a good one is
 * paragraphs — printing it whole turned the definition into a wall of text
 * that buried the six other rows and the trip log under it. The first sentence
 * is what the author wrote to say what the tripwire is for; the rest is how.
 * The full text is still reachable, on the row itself.
 */
export function briefGist(brief: string): string {
  const flat = brief.trim().replace(/\s+/g, " ");
  // The sentence end, not a period: `tugutil file edit` and `v1.2` both carry
  // one, and neither ends a sentence. A terminator followed by a space and a
  // capital is the shape a sentence actually ends on.
  const end = flat.search(/[.!?](?=\s+[A-Z(`"'“])/u);
  const first = end === -1 ? flat : flat.slice(0, end + 1);
  if (first.length <= GIST_MAX) return first;
  const cut = first.lastIndexOf(" ", GIST_MAX);
  return `${first.slice(0, cut === -1 ? GIST_MAX : cut)}…`;
}

/** Two lines at the rail's width. Past it the gist is the wall it replaced. */
const GIST_MAX = 120;

/**
 * The tripwire's definition, as the rows the detail level leads with.
 *
 * A trip log with no statement of what the tripwire is watching for is a list
 * of answers to an unasked question — this is the question.
 *
 * A row's `full` is the whole text when the `value` is an abbreviation of it,
 * and absent when the value is already whole — which is what tells the surface
 * whether there is anything more to show.
 */
export function tripwireDefinition(
  tripwire: TripwireRow,
): readonly {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly full?: string;
}[] {
  return [
    { label: "Watches for", value: describeTrigger(tripwire.trigger) },
    { label: "Lands on", value: tripwire.branch, mono: true },
    { label: "In", value: describeScope(tripwire.scope) },
    { label: "Runs first", value: describeProbe(tripwire.probe), mono: tripwire.probe !== null },
    {
      label: "Asks the AI to",
      value: briefGist(tripwire.brief),
      full: briefGist(tripwire.brief) === tripwire.brief.trim() ? undefined : tripwire.brief,
    },
    { label: "Model", value: tripwire.model ?? "The session default" },
    { label: "Permissions", value: describePermissions(tripwire.permission_mode) },
  ];
}

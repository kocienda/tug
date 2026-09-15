/**
 * tripwire-presentation — English for everything the tripwire ledger stores as
 * an enum, a JSON blob, or a mode string.
 *
 * The section used to print `trip.status` and its reason straight out of the
 * row, so a reader met `quiet` and `skipped: busy` with nothing to read them
 * against. A status enum is a name two halves of the engine agree on;
 * it is not a sentence, and a surface that shows one is asking its reader to
 * have read the schema.
 *
 * Pure functions, no React, no store: every one of these takes a row and
 * returns a string, which is what makes the vocabulary something tests pin
 * rather than something a component decides in passing.
 *
 * @module components/tripwires/tripwire-presentation
 */

import type { TripRow, TripwireRow } from "@/lib/tripwires-store";

/**
 * What a trip is doing, in the five states a reader actually distinguishes.
 *
 * The ledger's four statuses ([P05]) map almost one to one: every way a trip
 * can fail to run is one `skipped` row whose reason says which, and `done` —
 * a trip that ran to the end, whatever it found — reads as finished. The
 * differences the engine keeps live in the reason sentence below, which is
 * where a word like `busy` earns its clause instead of a glyph.
 *
 * `waiting` survives the collapse with no status of its own. It is the
 * `default:` arm's answer — a status this build has not learned — and a
 * newer engine's row reads as "Starting…" rather than as nothing.
 */
export type TripState =
  | "waiting"
  | "running"
  | "finished"
  | "failed"
  | "skipped";

export function tripState(trip: TripRow): TripState {
  switch (trip.status) {
    case "running":
      return "running";
    case "done":
      return "finished";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    default:
      return "waiting";
  }
}

/**
 * Why a trip was skipped or stopped, as a clause that finishes "Didn't run —"
 * or "Stopped —".
 *
 * An unrecognized reason is passed through rather than dropped: a reason the
 * engine writes and this table has not learned yet is still more use to a
 * reader than nothing, and it shows up as slightly-off English rather than as
 * a silence nobody can debug.
 */
function reasonClause(reason: string): string {
  switch (reason) {
    case "busy":
      return "this tripwire was already working a trip";
    case "ceiling":
      return "the machine was already running its limit of trips";
    case "no-room":
      return "the host had no room for a session";
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
 * retires the bare `skipped: busy` this replaced.
 */
export function tripSentence(trip: TripRow): string {
  const reason = trip.reason;
  switch (tripState(trip)) {
    case "running":
      return "Running now…";
    case "waiting":
      return "Starting…";
    case "skipped":
      return `Didn't run — ${reasonClause(reason ?? "busy")}.`;
    case "failed":
      return reason === null
        ? "Stopped before it finished."
        : `Stopped — ${reasonClause(reason)}.`;
    case "finished":
      return "Finished.";
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
    case "finished":
      return "finished";
    case "failed":
      return "stopped";
    default:
      return null;
  }
}

/**
 * The dot a row earns, as the two things a dot can mean here and nothing
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
 * a tripwire that is working. There is no third kind: a finished trip is not
 * holding anything, so a row at rest says so with silence ([P05]).
 */
export type TripwireDot =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "working" }
  | null;

/** The roster row's dot. Nothing at rest — a tripwire with no run in flight has
 *  nothing to say, and says it with silence. */
export function tripwireDot(tripwire: TripwireRow): TripwireDot {
  if (tripwire.running) {
    return tripwire.open_session === null
      ? { kind: "working" }
      : { kind: "session", sessionId: tripwire.open_session };
  }
  return null;
}

/** One trip's dot in the log — the same three meanings, read off the row.
 *
 *  Any trip that had a session keeps its dot, done and failed included
 *  ([B04]): the session is what the reader opens to see what the trip did,
 *  and a finished trip is exactly the row they reach for it from. The dot
 *  rests when the session is over, which is what a session dot is for. */
export function tripDot(trip: TripRow): TripwireDot {
  if (trip.session_id !== null) {
    return { kind: "session", sessionId: trip.session_id };
  }
  switch (tripState(trip)) {
    // Running with no session yet: still inside its probe.
    case "running":
      return { kind: "working" };
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

/** What the card calls a tripwire with no model of its own — the label the
 *  definition's Model row shows, and the popup's first item. */
export const SESSION_DEFAULT_MODEL = "The session default";

/**
 * The model knob's items, in the order the popup offers them.
 *
 * The session default leads, because a tripwire that names no model is the
 * ordinary case and the one a reader undoes a choice back to.
 */
export const MODEL_CHOICES: readonly string[] = [
  SESSION_DEFAULT_MODEL,
  "opus",
  "sonnet",
  "haiku",
];

/**
 * What the ledger is asked to hold when the reader picks `label`.
 *
 * The session default is `null` rather than its own string: the column means
 * "this tripwire overrides the account's model", and a tripwire that overrode
 * it with the words "the session default" would be a row nothing could read
 * back. A label the popup does not offer writes nothing at all — the knob
 * cannot mint a model name, and a payload that arrived from somewhere else is
 * not a reason to store one.
 */
export function modelKnobValue(label: string): { model: string | null } | null {
  if (!MODEL_CHOICES.includes(label)) return null;
  return { model: label === SESSION_DEFAULT_MODEL ? null : label };
}

/** Where the tripwire is listening. */
export function describeScope(scope: string | null): string {
  return scope ?? "Anywhere on this machine";
}

/**
 * What the tripwire's agent is allowed to do.
 *
 * The reassurance is the important half: a permissive posture is safe because
 * the agent works on its own arc worktree, never in the checkout you are in,
 * and a reader deciding whether to trust a tripwire is entitled to that fact
 * on the surface rather than in the doctrine.
 */
export function describePermissions(mode: string): string {
  switch (mode) {
    case "acceptEdits":
      return "Can write, in an arc worktree of its own";
    case "plan":
    case "read-only":
      return "Read-only — it diagnoses, it does not change files";
    default:
      return mode;
  }
}

/** What the card calls the description row. A plain word the reader does not
 *  have to decode, over a sentence written for them rather than for the model
 *  ([B04]). */
export const DESCRIPTION_ROW_LABEL = "What it does";

/**
 * The tripwire's definition, as the rows the detail level leads with.
 *
 * A trip log with no statement of what the tripwire is watching for is a list
 * of answers to an unasked question — this is the question.
 *
 * It leads with the description — one sentence, written for the person reading
 * the rail, saying what this tripwire does and when it will speak ([B04]).
 *
 * **The brief is not here, and its absence is the decision** ([B03]). The brief
 * is the prompt a trip runs on: it is addressed to the model, it runs to
 * hundreds of words, and printing it here filled the card with instructions
 * nobody on this surface is the reader of. It stays in the ledger, in the
 * roster projection and in `tugtool tripwire list --json`, which is where the
 * `/tripwire` skill reads it during revision. No clamp, no tooltip, no
 * secondary reveal — every one of those is the same wall of text one gesture
 * further away.
 *
 * Every row's `value` is the whole of what it says, and `mono` marks the rows
 * that are read character by character.
 */
export function tripwireDefinition(
  tripwire: TripwireRow,
): readonly {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}[] {
  return [
    { label: DESCRIPTION_ROW_LABEL, value: tripwire.description.trim() },
    { label: "Watches for", value: describeTrigger(tripwire.trigger) },
    { label: "In", value: describeScope(tripwire.scope) },
    { label: "Runs first", value: describeProbe(tripwire.probe), mono: tripwire.probe !== null },
    { label: "Model", value: tripwire.model ?? SESSION_DEFAULT_MODEL },
    { label: "Permissions", value: describePermissions(tripwire.permission_mode) },
  ];
}

/**
 * Why Delete is unavailable on this tripwire, or null when it is available.
 *
 * One rule, and it is the ledger's: a tripwire with a **running** trip cannot
 * be removed, because a session is working in the tripwire's arc worktree
 * against it and the row going away would leave that work with nothing to
 * answer to ([B07]). A finished trip is not a refusal — nothing is holding
 * anything, and the arc the removal discards is the tripwire's own, which is
 * what the confirm below says out loud.
 */
export function deleteDisabledReason(tripwire: TripwireRow): string | null {
  return tripwire.running ? "a trip is running" : null;
}

/**
 * The Delete item's label, carrying its own refusal when it has one.
 *
 * A disabled item takes no pointer events, so a tooltip on one can never fire
 * ([L31]); the reason rides the label the way the arc row's menu states its
 * own, and the item stays present rather than vanishing.
 */
export function deleteMenuLabel(tripwire: TripwireRow): string {
  const reason = deleteDisabledReason(tripwire);
  return reason === null ? "Delete" : `Delete — ${reason}`;
}

/**
 * What the confirm asks, naming the tripwire and everything that goes with it.
 *
 * The trip log always goes: the trips hang off the row and cascade with it.
 * So does the tripwire's own arc ([P02]) — `tripwire-<name>` and the worktree
 * under it — and that is stated because a reader who is about to lose a
 * worktree is entitled to read it before pressing Delete rather than after
 * ([B06]). It is named unconditionally now: every tripwire owns one from the
 * moment it is laid, so there is no case where the sentence would be a guess.
 */
export function deleteConfirmMessage(tripwire: TripwireRow): string {
  return (
    `Delete ${tripwire.name}? Its trip log goes with it, and its arc ` +
    `tripwire-${tripwire.name} is discarded.`
  );
}

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
 * @module components/tripwires/tripwire-presentation
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
 *
 * Nor does `adopted`: a Session card took the run's session over and somebody
 * is working in it. It is the one state that is neither the machine's nor a
 * question — it is a conversation. It has its own member because the
 * `default:` arm below reads every unknown status as `waiting`, and printing
 * "Starting…" over a session the reader is sitting inside is the worst
 * sentence this surface could say.
 */
export type TripState =
  | "waiting"
  | "running"
  | "awaiting"
  | "adopted"
  | "finished"
  | "failed"
  | "skipped";

export function tripState(trip: TripRow): TripState {
  switch (trip.status) {
    case "running":
      return "running";
    case "awaiting":
      return "awaiting";
    case "adopted":
      return "adopted";
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
    case "own-arc":
      return "the landing was this tripwire's own arc";
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
    case "adopted":
      return "You took this one over.";
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
    // Nothing: `tripSentence` already says the reader took this one over, and
    // a label beside it would say it twice.
    case "adopted":
      return null;
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
 *  question outstanding has nothing to say, and says it with silence.
 *
 *  An adopted trip earns the same live dot a running one does, and reaches it
 *  by the same field: the projection folds the adopted session into
 *  `running_session` when nothing is running, so the row keeps the dot the
 *  user takes the session over through. No new dot kind ([P07]). */
export function tripwireDot(tripwire: TripwireRow): TripwireDot {
  if (tripwire.running || tripwire.adopted) {
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
    // An adopted trip's session is alive and the reader may be in it, so the
    // dot is the live pulse the running case earns — not the held `awaiting`
    // glyph, which means a question nobody has answered.
    case "adopted":
      return trip.session_id === null
        ? null
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
    { label: "Lands on", value: tripwire.branch, mono: true },
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
 * be removed, because a headless session is working in an inspection tree
 * against it and the row going away would leave that work with nothing to
 * answer to ([B07]). An **awaiting** trip is not a refusal — the removal
 * dismisses it first, discarding the arc it is holding through the path that
 * already knows how, which is what the confirm below says out loud.
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
 * The trip log always goes: the trips hang off the row and cascade with it. An
 * arc a live trip is holding is the second sentence's worth of consequence,
 * and it is stated because a reader who is about to lose a worktree is
 * entitled to read that before pressing Delete rather than after ([B06]).
 *
 * **Awaiting or adopted, either holds one.** The removal runs the same dismiss
 * for both — an adopted trip's arc is discarded exactly as an awaiting one's
 * is — so a sentence that named only the awaiting case would destroy a
 * worktree it never mentioned, on the row where the user is most likely to
 * have one open.
 */
export function deleteConfirmMessage(tripwire: TripwireRow): string {
  const arc =
    (tripwire.awaiting ? tripwire.awaiting_arc : null) ??
    (tripwire.adopted ? tripwire.adopted_arc : null);
  const held = arc === null ? "" : ", and the arc it is holding is discarded";
  return `Delete ${tripwire.name}? Its trip log goes with it${held}.`;
}

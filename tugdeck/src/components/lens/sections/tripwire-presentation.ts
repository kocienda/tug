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
 */
export type TripState = "waiting" | "running" | "finished" | "failed" | "skipped";

export function tripState(trip: TripRow): TripState {
  switch (trip.status) {
    case "running":
      return "running";
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
    case "cooldown":
      return "this tripwire had just fired";
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
    case "finished":
      return "finished";
    case "failed":
      return "stopped";
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

  if ("commit" in value) {
    const commit = (value.commit ?? {}) as Record<string, unknown>;
    const branch = typeof commit.branch === "string" ? commit.branch : null;
    return branch === null ? "Any commit, on any branch" : `Any commit on ${branch}`;
  }

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

/** The cooldown, as the silence it buys rather than as a number of seconds. */
export function describeCooldown(seconds: number): string {
  if (seconds <= 0) return "None — every matching event trips it";
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `At most one trip an hour${hours === 1 ? "" : ` (${hours}h)`}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `Waits ${minutes} minute${minutes === 1 ? "" : "s"} between trips`;
  }
  return `Waits ${seconds} seconds between trips`;
}

/** The post policies the section offers, quietest first. */
export const POST_CHOICES = [
  { value: "never", label: "Never" },
  { value: "auto", label: "Auto" },
  { value: "always", label: "Always" },
];

/**
 * What the chosen post policy means, in one line under the control.
 *
 * Three unlabelled words in a segmented control are a puzzle: they do not say
 * what is being posted, where, or which one a reader would want. The caption is
 * the control's meaning, and it changes with the selection so the reader is
 * always reading about the setting they are looking at.
 */
export function postPolicyCaption(value: string): string {
  switch (value) {
    case "never":
      return "Nothing reaches the Overview. Trips are recorded here and nowhere else.";
    case "always":
      return "Every trip reaches the Overview, routine ones included — how you shake down a new tripwire.";
    default:
      return "Only trips worth your attention reach the Overview. Routine ones stay in this log.";
  }
}

/**
 * The tripwire's definition, as the rows the detail level leads with.
 *
 * A trip log with no statement of what the tripwire is watching for is a list
 * of answers to an unasked question — this is the question.
 */
export function tripwireDefinition(
  tripwire: TripwireRow,
): readonly { readonly label: string; readonly value: string; readonly mono?: boolean }[] {
  return [
    { label: "Watches for", value: describeTrigger(tripwire.trigger) },
    { label: "In", value: describeScope(tripwire.scope) },
    { label: "Runs first", value: describeProbe(tripwire.probe), mono: tripwire.probe !== null },
    { label: "Asks the AI to", value: tripwire.brief },
    { label: "Model", value: tripwire.model ?? "The session default" },
    { label: "Permissions", value: describePermissions(tripwire.permission_mode) },
    { label: "Cooldown", value: describeCooldown(tripwire.cooldown_secs) },
  ];
}

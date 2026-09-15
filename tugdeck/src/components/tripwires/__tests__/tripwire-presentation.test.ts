/**
 * The English the Tripwires section speaks.
 *
 * What these pin is a single rule: nothing the ledger stores as an enum, a mode
 * string, or a JSON predicate reaches the surface in that form. A reader who has
 * not read the schema met `quiet`, `skipped: busy` and
 * `{"fact":{"kind":"edit_failed"}}` and could not tell what any of them said —
 * so every one of them is a sentence here, and a test says which sentence.
 */

import { describe, expect, test } from "bun:test";

import {
  deleteConfirmMessage,
  deleteDisabledReason,
  deleteMenuLabel,
  describePermissions,
  describeProbe,
  describeScope,
  describeTrigger,
  modelKnobValue,
  MODEL_CHOICES,
  tripSentence,
  tripState,
  tripStateLabel,
  tripDot,
  tripwireDot,
  tripwireDefinition,
  DESCRIPTION_ROW_LABEL,
} from "../tripwire-presentation";
import type { TripRow, TripwireRow } from "@/lib/tripwires-store";

function trip(over: Partial<TripRow> = {}): TripRow {
  return {
    id: 1,
    tripwire_id: 1,
    event_key: "commit:abc1234",
    at_ms: 1_700_000_000_000,
    instance: "inst",
    status: "quiet",
    reason: null,
    event_payload: null,
    probe_exit: null,
    probe_tail: null,
    session_id: null,
    arc: null,
    headline: null,
    refs: null,
    settled_at_ms: 1_700_000_001_000,
    repo_root: "/Users/me/src/tugtool",
    report: null,
    rounds: null,
    ...over,
  };
}

function tripwire(over: Partial<TripwireRow> = {}): TripwireRow {
  return {
    name: "ci-confidence",
    trigger: '{"fact":{"kind":"edit_failed"}}',
    scope: "/Users/me/src/tugtool",
    probe: "just ci",
    brief: "Flag anything red.",
    description: "Runs `just ci` after every landing on main and says what went red",
    model: null,
    permission_mode: "acceptEdits",
    paused: false,
    max_seconds: 120,
    max_tool_calls: 30,
    running: false,
    open_session: null,
    open_session_dir: null,
    last_trip: null,
    trip_count: 0,
    trip_log_revision: 0,
    ...over,
  };
}

describe("a trip's state", () => {
  test("the four ledger statuses read as the words a reader tells apart", () => {
    expect(tripState(trip({ status: "skipped" }))).toBe("skipped");
    expect(tripState(trip({ status: "running" }))).toBe("running");
    expect(tripState(trip({ status: "done" }))).toBe("finished");
    expect(tripState(trip({ status: "failed" }))).toBe("failed");
  });

  test("a status this build has never heard of is treated as not yet started", () => {
    // Better than throwing, and better than claiming it finished: a newer
    // engine's status reads as "something is happening" until this deck learns
    // the word.
    expect(tripState(trip({ status: "quarantined" }))).toBe("waiting");
  });
});

describe("the sentence a trip says when the agent left no headline", () => {
  test("a busy skip says what skipped it, in English", () => {
    // The regression: this row read `skipped: busy`, which named a column
    // value and a database verb and told the reader nothing.
    expect(tripSentence(trip({ status: "skipped", reason: "busy" }))).toBe(
      "Didn't run — this tripwire was already working a trip.",
    );
  });

  test("the two budget skips each give their own reason", () => {
    expect(tripSentence(trip({ status: "skipped", reason: "ceiling" }))).toBe(
      "Didn't run — the machine was already running its limit of trips.",
    );
    expect(tripSentence(trip({ status: "skipped", reason: "no-room" }))).toBe(
      "Didn't run — the host had no room for a session.",
    );
  });

  test("a failure names the thing that stopped it", () => {
    expect(
      tripSentence(trip({ status: "failed", reason: "instance restarted" })),
    ).toBe("Stopped — Tug restarted while it was running.");
    expect(tripSentence(trip({ status: "failed" }))).toBe("Stopped before it finished.");
  });

  test("a reason this build has not learned is passed through, not dropped", () => {
    expect(tripSentence(trip({ status: "skipped", reason: "rate limit" }))).toBe(
      "Didn't run — rate limit.",
    );
  });

  test("a finished trip with nothing to say still says something", () => {
    // The fallback, not the ordinary case: a finished row shows the trip's
    // own report. This is what it says if one ever arrives without.
    expect(tripSentence(trip({ status: "done" }))).toBe("Finished.");
  });
});

describe("the state word beside a trip's time", () => {
  test("it is absent exactly where the sentence already carries the state", () => {
    // No row says "didn't run" twice: the skipped and waiting states put their
    // state in the body, so the meta line beside them is the clock alone.
    expect(tripStateLabel(trip({ status: "skipped", reason: "cooldown" }))).toBeNull();
    expect(tripStateLabel(trip({ status: "quarantined" }))).toBeNull();
    expect(tripStateLabel(trip({ status: "done" }))).toBe("finished");
    expect(tripStateLabel(trip({ status: "running" }))).toBe("running");
    expect(tripStateLabel(trip({ status: "failed" }))).toBe("stopped");
  });
});

describe("the dot a row earns", () => {
  test("a wire at rest has none", () => {
    // The whole of [P08]: a reporter that only raises its hand when it has a
    // question needs no mark for the times it has nothing to say.
    expect(tripwireDot(tripwire())).toBeNull();
    expect(tripDot(trip({ status: "quiet" }))).toBeNull();
    expect(tripDot(trip({ status: "skipped", reason: "busy" }))).toBeNull();
  });

  test("a quiet trip with a session keeps its dot, so the work stays reachable", () => {
    // [B04]: a trip that ran and found nothing is still a trip somebody can
    // open and read. The dot is the door, and a finished row keeps it.
    expect(tripDot(trip({ status: "quiet", session_id: "sess-3" }))).toEqual({
      kind: "session",
      sessionId: "sess-3",
    });
    expect(tripDot(trip({ status: "failed", session_id: "sess-4" }))).toEqual({
      kind: "session",
      sessionId: "sess-4",
    });
  });

  test("a run with a session is the live pulse, keyed on that session", () => {
    expect(tripwireDot(tripwire({ running: true, open_session: "sess-7" }))).toEqual({
      kind: "session",
      sessionId: "sess-7",
    });
    expect(tripDot(trip({ status: "running", session_id: "sess-7" }))).toEqual({
      kind: "session",
      sessionId: "sess-7",
    });
  });

  test("a run inside its probe still moves, with no session to key on", () => {
    // The failure this rules out: a session dot keyed on nothing answers
    // `idle` and rests, so a wire running its probe would look asleep.
    expect(tripwireDot(tripwire({ running: true }))).toEqual({ kind: "working" });
    expect(tripDot(trip({ status: "running" }))).toEqual({ kind: "working" });
  });

  test("a finished trip keeps the dot its session earned", () => {
    // The row must not go dark the moment a trip ends: the dot is what the
    // reader reaches the session through, and a finished trip is exactly the
    // row they reach for it from ([B04]).
    expect(tripDot(trip({ status: "done", session_id: "sess-11" }))).toEqual({
      kind: "session",
      sessionId: "sess-11",
    });
    // And a tripwire at rest says so with silence ([P05]).
    expect(tripwireDot(tripwire({ open_session: "sess-11" }))).toBeNull();
  });
});

describe("a trigger read back as the sentence that laid it", () => {
  test("a trigger this build cannot read is passed through rather than swallowed", () => {
    // A v1 `commit` trigger is a foreign grammar now: the branch a wire watches
    // is a column on the wire. A row carrying one is still listable, and what a
    // reader sees is the stored text rather than an invented sentence.
    expect(describeTrigger('{"commit":{}}')).toBe('{"commit":{}}');
  });

  test("a fact trigger names its kind, and its where clauses read as conditions", () => {
    expect(describeTrigger('{"fact":{"kind":"edit_error"}}')).toBe("Any edit_error fact");
    expect(
      describeTrigger('{"fact":{"kind":"edit_error","where":{"route":"claude"}}}'),
    ).toBe("Any edit_error fact where route is claude");
  });

  test("the three matcher shapes each get their own verb", () => {
    expect(
      describeTrigger('{"fact":{"kind":"e","where":{"path":{"contains":"tugdeck"}}}}'),
    ).toBe("Any e fact where path contains tugdeck");
    expect(
      describeTrigger('{"fact":{"kind":"e","where":{"path":{"prefix":"tugrust/"}}}}'),
    ).toBe("Any e fact where path starts with tugrust/");
    expect(
      describeTrigger('{"fact":{"kind":"e","where":{"a":"1","b":{"contains":"x"}}}}'),
    ).toBe("Any e fact where a is 1 and b contains x");
  });

  test("a trigger this build cannot read shows its own text", () => {
    // An older deck against a newer predicate grammar: showing the raw JSON is
    // honest, and claiming the tripwire watches for nothing would not be.
    expect(describeTrigger('{"schedule":{"cron":"0 * * * *"}}')).toBe(
      '{"schedule":{"cron":"0 * * * *"}}',
    );
    expect(describeTrigger("not json at all")).toBe("not json at all");
  });
});

describe("the rest of a tripwire's definition", () => {
  test("absence is stated, never left blank", () => {
    expect(describeScope(null)).toBe("Anywhere on this machine");
    expect(describeProbe(null)).toBe("Nothing — the AI looks at the event itself");
  });

  test("a permission mode says what the agent can do and where", () => {
    expect(describePermissions("acceptEdits")).toBe("Can write, in an arc worktree of its own");
    expect(describePermissions("plan")).toBe(
      "Read-only — it diagnoses, it does not change files",
    );
  });

  test("the brief is nowhere in the definition, however long it is", () => {
    const brief =
      "Diagnose the failure and say who was wrong. The evidence carries the " +
      "class, the report, and the program itself.";
    const rows = tripwireDefinition(tripwire({ brief }));
    // Not clamped, not truncated, not behind a reveal — absent. The brief is
    // the prompt a trip runs on, and every reveal is the same wall of text one
    // gesture further away ([B03]).
    expect(rows.some((r) => r.label === "Asks the AI to")).toBe(false);
    expect(rows.some((r) => r.value.includes("Diagnose the failure"))).toBe(false);
    expect(rows.some((r) => "clamp" in r)).toBe(false);
  });

  test("the definition leads with what the tripwire does, in a sentence", () => {
    const rows = tripwireDefinition(tripwire());
    expect(rows[0]).toEqual({
      label: "What it does",
      value: "Runs `just ci` after every landing on main and says what went red",
    });
    expect(rows.map((r) => r.label)).toEqual([
      DESCRIPTION_ROW_LABEL,
      "Watches for",
      "In",
      "Runs first",
      "Model",
      "Permissions",
    ]);
  });

  test("a description is trimmed, so the rail's first row never leads with space", () => {
    const rows = tripwireDefinition(
      tripwire({ description: "  Says what broke on the last landing\n" }),
    );
    expect(rows[0]?.value).toBe("Says what broke on the last landing");
  });

  test("the model knob offers the session default first, then the three names", () => {
    expect(MODEL_CHOICES).toEqual(["The session default", "opus", "sonnet", "haiku"]);
  });

  test("the session default clears the column rather than storing its own words", () => {
    // The column means "this tripwire overrides the account's model", and a row
    // holding the words "The session default" is one nothing could read back.
    expect(modelKnobValue("The session default")).toEqual({ model: null });
  });

  test("a named model is stored as itself", () => {
    expect(modelKnobValue("opus")).toEqual({ model: "opus" });
    expect(modelKnobValue("haiku")).toEqual({ model: "haiku" });
  });

  test("a label the knob does not offer writes nothing", () => {
    // The knob cannot mint a model name: a payload that arrived from somewhere
    // else is not a reason to store one.
    expect(modelKnobValue("gpt-4")).toBeNull();
    expect(modelKnobValue("")).toBeNull();
  });

  test("only a real probe is set in the command face", () => {
    const withProbe = tripwireDefinition(tripwire()).find((r) => r.label === "Runs first");
    const without = tripwireDefinition(tripwire({ probe: null })).find(
      (r) => r.label === "Runs first",
    );
    expect(withProbe?.mono).toBe(true);
    expect(without?.mono).toBe(false);
  });
});

describe("what Delete says before it is pressed", () => {
  test("a running trip is the one refusal, and it rides the label", () => {
    const running = tripwire({ running: true });
    expect(deleteDisabledReason(running)).toBe("a trip is running");
    // A disabled item takes no pointer events, so the reason has nowhere else
    // to be read ([L31]).
    expect(deleteMenuLabel(running)).toBe("Delete — a trip is running");
  });

  test("a finished trip is not a refusal", () => {
    // Nothing is holding anything, so the verb stays available.
    const finished = tripwire({ last_trip: { at_ms: 1, status: "done", headline: null, session_id: "s", report: "looked", rounds: 0 } });
    expect(deleteDisabledReason(finished)).toBeNull();
    expect(deleteMenuLabel(finished)).toBe("Delete");
  });

  test("the confirm names the tripwire, its log, and the arc it owns", () => {
    expect(deleteConfirmMessage(tripwire())).toBe(
      "Delete ci-confidence? Its trip log goes with it, and its arc tripwire-ci-confidence is discarded.",
    );
  });
});

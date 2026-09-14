/**
 * The English the Tripwires section speaks.
 *
 * What these pin is a single rule: nothing the ledger stores as an enum, a mode
 * string, or a JSON predicate reaches the surface in that form. A reader who has
 * not read the schema met `settled`, `swallowed: busy` and
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
    status: "settled",
    swallow_reason: null,
    event_payload: null,
    probe_exit: null,
    probe_tail: null,
    session_id: null,
    arc: null,
    headline: null,
    refs: null,
    settled_at_ms: 1_700_000_001_000,
    author_ask: null,
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
    branch: "main",
    permission_mode: "acceptEdits",
    paused: false,
    running: false,
    adopted: false,
    running_session: null,
    awaiting: false,
    awaiting_arc: null,
    adopted_arc: null,
    last_trip: null,
    trip_log_revision: 0,
    ...over,
  };
}

describe("a trip's state", () => {
  test("the nine ledger statuses collapse to the seven a reader tells apart", () => {
    expect(tripState(trip({ status: "claimed" }))).toBe("waiting");
    expect(tripState(trip({ status: "queued" }))).toBe("waiting");
    expect(tripState(trip({ status: "running" }))).toBe("running");
    expect(tripState(trip({ status: "awaiting" }))).toBe("awaiting");
    expect(tripState(trip({ status: "settled" }))).toBe("finished");
    expect(tripState(trip({ status: "failed" }))).toBe("failed");
    expect(tripState(trip({ status: "swallowed" }))).toBe("skipped");
    expect(tripState(trip({ status: "superseded" }))).toBe("skipped");
    // Never "waiting": the `default:` arm below would print "Starting…" over
    // a session the reader is sitting inside.
    expect(tripState(trip({ status: "adopted" }))).toBe("adopted");
  });

  test("a status this build has never heard of is treated as not yet started", () => {
    // Better than throwing, and better than claiming it finished: a newer
    // engine's status reads as "something is happening" until this deck learns
    // the word.
    expect(tripState(trip({ status: "quarantined" }))).toBe("waiting");
  });
});

describe("the sentence a trip says when the agent left no headline", () => {
  test("a busy swallow says what swallowed it, in English", () => {
    // The regression: this row read `swallowed: busy`, which named a column
    // value and a database verb and told the reader nothing.
    expect(tripSentence(trip({ status: "swallowed", swallow_reason: "busy" }))).toBe(
      "Didn't run — this tripwire was already working a trip.",
    );
    expect(tripSentence(trip({ status: "swallowed", swallow_reason: "own-arc" }))).toBe(
      "Didn't run — the landing was this tripwire's own arc.",
    );
  });

  test("an out-of-scope event and a superseded one each give their own reason", () => {
    expect(tripSentence(trip({ status: "swallowed", swallow_reason: "no-scope" }))).toBe(
      "Didn't run — the event was outside this tripwire's scope.",
    );
    expect(tripSentence(trip({ status: "superseded", swallow_reason: "superseded" }))).toBe(
      "Didn't run — a newer event took its place.",
    );
  });

  test("a failure names the thing that stopped it", () => {
    expect(
      tripSentence(trip({ status: "failed", swallow_reason: "instance restarted" })),
    ).toBe("Stopped — Tug restarted while it was running.");
    expect(tripSentence(trip({ status: "failed" }))).toBe("Stopped before it finished.");
  });

  test("a trip somebody took over says so, and never says Starting", () => {
    const sentence = tripSentence(trip({ status: "adopted", session_id: "sess-11" }));
    expect(sentence).toBe("You took this one over.");
    expect(sentence).not.toContain("Starting");
  });

  test("a reason this build has not learned is passed through, not dropped", () => {
    expect(tripSentence(trip({ status: "swallowed", swallow_reason: "rate limit" }))).toBe(
      "Didn't run — rate limit.",
    );
  });

  test("a settled trip with nothing to say still says something", () => {
    expect(tripSentence(trip())).toBe("Finished with nothing to report.");
  });

  test("an awaiting trip says it is waiting on the reader", () => {
    // The fallback, not the ordinary case: the resolution verb refuses
    // `--awaiting` without a headline, so a real awaiting row shows the
    // agent's line. This is what the row says if one ever arrives without.
    expect(tripSentence(trip({ status: "awaiting" }))).toBe("Waiting for you to look.");
  });
});

describe("the state word beside a trip's time", () => {
  test("it is absent exactly where the sentence already carries the state", () => {
    // No row says "didn't run" twice: the skipped and waiting states put their
    // state in the body, so the meta line beside them is the clock alone.
    expect(tripStateLabel(trip({ status: "swallowed", swallow_reason: "cooldown" }))).toBeNull();
    expect(tripStateLabel(trip({ status: "queued" }))).toBeNull();
    expect(tripStateLabel(trip({ status: "settled" }))).toBe("finished");
    expect(tripStateLabel(trip({ status: "running" }))).toBe("running");
    expect(tripStateLabel(trip({ status: "awaiting" }))).toBe("awaiting");
    expect(tripStateLabel(trip({ status: "failed" }))).toBe("stopped");
    // And an adopted trip: the sentence says the reader took it over, so the
    // label beside it would be the same fact twice.
    expect(tripStateLabel(trip({ status: "adopted" }))).toBeNull();
  });
});

describe("the dot a row earns", () => {
  test("a wire at rest has none", () => {
    // The whole of [P08]: a reporter that only raises its hand when it has a
    // question needs no mark for the times it has nothing to say.
    expect(tripwireDot(tripwire())).toBeNull();
    expect(tripDot(trip({ status: "settled" }))).toBeNull();
    expect(tripDot(trip({ status: "swallowed", swallow_reason: "busy" }))).toBeNull();
    expect(tripDot(trip({ status: "queued" }))).toBeNull();
  });

  test("a run with a session is the live pulse, keyed on that session", () => {
    expect(tripwireDot(tripwire({ running: true, running_session: "sess-7" }))).toEqual({
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

  test("awaiting is its own dot, never the session's", () => {
    // By the time a trip is awaiting its session has ended, and the phase hook
    // answers `idle` for a session it cannot reach — so the held state cannot
    // be read off a session and is driven by the trip status instead.
    expect(tripwireDot(tripwire({ awaiting: true }))).toEqual({ kind: "awaiting" });
    expect(tripDot(trip({ status: "awaiting", session_id: "sess-7" }))).toEqual({
      kind: "awaiting",
    });
  });

  test("a run in flight outranks a question already asked", () => {
    // Both can be true of one wire — an awaiting trip holds the slot, and a
    // later landing can still be working — and the row has one dot. The live
    // one wins, because it is the one that is changing.
    expect(
      tripwireDot(tripwire({ running: true, running_session: "sess-9", awaiting: true })),
    ).toEqual({ kind: "session", sessionId: "sess-9" });
  });

  test("an adopted trip keeps the live dot, keyed on the session somebody is in", () => {
    // The row must not go dark at the moment the session is taken over: the
    // dot is what the user reaches it through. The projection folds the
    // adopted session into `running_session`, so no new dot kind is needed
    // ([P07]).
    expect(tripwireDot(tripwire({ adopted: true, running_session: "sess-11" }))).toEqual({
      kind: "session",
      sessionId: "sess-11",
    });
    // And not the held `awaiting` glyph, which means a question nobody has
    // answered — this is a conversation somebody is having.
    expect(tripDot(trip({ status: "adopted", session_id: "sess-11" }))).toEqual({
      kind: "session",
      sessionId: "sess-11",
    });
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
      "Lands on",
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

  test("an awaiting trip is not a refusal", () => {
    // The removal dismisses it first and discards the arc it holds, which is
    // what the confirm below says out loud — so the verb stays available.
    const awaiting = tripwire({ awaiting: true, awaiting_arc: "tripwire-ci-abcd1234" });
    expect(deleteDisabledReason(awaiting)).toBeNull();
    expect(deleteMenuLabel(awaiting)).toBe("Delete");
  });

  test("the confirm names the tripwire and the log that goes with it", () => {
    expect(deleteConfirmMessage(tripwire())).toBe(
      "Delete ci-confidence? Its trip log goes with it.",
    );
  });

  test("an arc being held is the second thing the confirm says", () => {
    expect(
      deleteConfirmMessage(
        tripwire({ awaiting: true, awaiting_arc: "tripwire-ci-abcd1234" }),
      ),
    ).toBe(
      "Delete ci-confidence? Its trip log goes with it, and the arc it is holding is discarded.",
    );
    // Awaiting with no arc authored has nothing to discard, and the sentence
    // must not promise otherwise.
    expect(deleteConfirmMessage(tripwire({ awaiting: true, awaiting_arc: null }))).toBe(
      "Delete ci-confidence? Its trip log goes with it.",
    );
  });

  test("an adopted trip's arc is named too, because the removal discards that one as well", () => {
    // The removal runs one dismiss, and it takes an adopted trip when there is
    // no awaiting one — so the worktree the user took over goes with the
    // tripwire, and the confirm has to say so before they press Delete.
    expect(
      deleteConfirmMessage(
        tripwire({ adopted: true, adopted_arc: "tripwire-ci-abcd1234" }),
      ),
    ).toBe(
      "Delete ci-confidence? Its trip log goes with it, and the arc it is holding is discarded.",
    );
    expect(deleteConfirmMessage(tripwire({ adopted: true, adopted_arc: null }))).toBe(
      "Delete ci-confidence? Its trip log goes with it.",
    );
  });
});

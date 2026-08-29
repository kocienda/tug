/**
 * The English the Tripwires section speaks.
 *
 * What these pin is a single rule: nothing the ledger stores as an enum, a mode
 * string, or a JSON predicate reaches the surface in that form. A reader who has
 * not read the schema met `settled`, `swallowed: cooldown` and `{"commit":{}}`
 * and could not tell what any of them said — so every one of them is a sentence
 * here, and a test says which sentence.
 */

import { describe, expect, test } from "bun:test";

import {
  describeCooldown,
  describePermissions,
  describeProbe,
  describeScope,
  describeTrigger,
  postPolicyCaption,
  tripSentence,
  tripState,
  tripStateLabel,
  tripwireDefinition,
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
    probe_exit: null,
    probe_tail: null,
    session_id: null,
    dash: null,
    interest: "routine",
    outcome: "verdict",
    headline: null,
    refs: null,
    settled_at_ms: 1_700_000_001_000,
    ...over,
  };
}

function tripwire(over: Partial<TripwireRow> = {}): TripwireRow {
  return {
    name: "ci-confidence",
    trigger: '{"commit":{"branch":"main"}}',
    scope: "/Users/me/src/tugtool",
    probe: "just ci",
    brief: "Flag anything red.",
    model: null,
    tier: "auto",
    permission_mode: "acceptEdits",
    post: "auto",
    paused: false,
    cooldown_secs: 300,
    running: false,
    staged_dash: null,
    last_trip: null,
    ...over,
  };
}

describe("a trip's state", () => {
  test("the seven ledger statuses collapse to the five a reader tells apart", () => {
    expect(tripState(trip({ status: "claimed" }))).toBe("waiting");
    expect(tripState(trip({ status: "queued" }))).toBe("waiting");
    expect(tripState(trip({ status: "running" }))).toBe("running");
    expect(tripState(trip({ status: "settled" }))).toBe("finished");
    expect(tripState(trip({ status: "failed" }))).toBe("failed");
    expect(tripState(trip({ status: "swallowed" }))).toBe("skipped");
    expect(tripState(trip({ status: "superseded" }))).toBe("skipped");
  });

  test("a status this build has never heard of is treated as not yet started", () => {
    // Better than throwing, and better than claiming it finished: a newer
    // engine's status reads as "something is happening" until this deck learns
    // the word.
    expect(tripState(trip({ status: "quarantined" }))).toBe("waiting");
  });
});

describe("the sentence a trip says when the agent left no headline", () => {
  test("the cooldown swallow says what swallowed it, in English", () => {
    // The regression: this row read `swallowed: cooldown`, which named a column
    // value and a database verb and told the reader nothing.
    expect(tripSentence(trip({ status: "swallowed", swallow_reason: "cooldown" }))).toBe(
      "Didn't run — this tripwire had just fired.",
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

  test("a reason this build has not learned is passed through, not dropped", () => {
    expect(tripSentence(trip({ status: "swallowed", swallow_reason: "rate limit" }))).toBe(
      "Didn't run — rate limit.",
    );
  });

  test("a settled trip with nothing to say still says something", () => {
    expect(tripSentence(trip())).toBe("Finished with nothing to report.");
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
    expect(tripStateLabel(trip({ status: "failed" }))).toBe("stopped");
  });
});

describe("a trigger read back as the sentence that laid it", () => {
  test("a bare commit trigger says it watches every branch", () => {
    expect(describeTrigger('{"commit":{}}')).toBe("Any commit, on any branch");
  });

  test("a branch-narrowed commit trigger names the branch", () => {
    expect(describeTrigger('{"commit":{"branch":"main"}}')).toBe("Any commit on main");
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
    expect(describePermissions("acceptEdits")).toBe("Can write, in a dash worktree of its own");
    expect(describePermissions("plan")).toBe(
      "Read-only — it diagnoses, it does not change files",
    );
  });

  test("a cooldown is the silence it buys, not a count of seconds", () => {
    expect(describeCooldown(0)).toBe("None — every matching event trips it");
    expect(describeCooldown(60)).toBe("Waits 1 minute between trips");
    expect(describeCooldown(300)).toBe("Waits 5 minutes between trips");
    expect(describeCooldown(3600)).toBe("At most one trip an hour");
    expect(describeCooldown(90)).toBe("Waits 90 seconds between trips");
  });

  test("the definition leads with what the tripwire watches for", () => {
    const rows = tripwireDefinition(tripwire());
    expect(rows[0]).toEqual({ label: "Watches for", value: "Any commit on main" });
    expect(rows.map((r) => r.label)).toEqual([
      "Watches for",
      "In",
      "Runs first",
      "Asks the AI to",
      "Model",
      "Permissions",
      "Cooldown",
    ]);
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

describe("the post policy's caption", () => {
  test("each setting says where its trips go and where they do not", () => {
    expect(postPolicyCaption("never")).toContain("Nothing reaches the Overview");
    expect(postPolicyCaption("always")).toContain("Every trip");
    expect(postPolicyCaption("auto")).toContain("Only trips worth your attention");
  });

  test("an unknown value reads as auto, which is the column's own default", () => {
    expect(postPolicyCaption("wat")).toBe(postPolicyCaption("auto"));
  });
});

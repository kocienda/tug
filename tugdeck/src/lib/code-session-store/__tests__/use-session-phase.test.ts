/**
 * The doubt rule, and the fold that carries it.
 *
 * `useSessionPhase` walks session → card → services → snapshot, and that walk
 * only exists in a running app; the picker row for a closed session is covered
 * by an app-test. What IS a decision rather than plumbing is what the hook
 * answers when the walk comes up empty, and that lives in
 * `sessionPhaseFromSnapshot`, which is pure — and, beside it, which arc row in
 * the changes feed makes a card's join offer stand (`joinOfferStands`).
 */

import { describe, expect, test } from "bun:test";

import type { JobItem } from "../select-jobs";
import type { ArcChangesetEntry } from "@/lib/changeset-types";
import { sessionSessionPhaseVisual } from "../session-phase-visual";
import {
  joinOfferStands,
  joinOfferArcName,
  joinOfferBase,
  sessionPhaseFromSnapshot,
  type SessionPhaseSource,
} from "../use-session-phase";

function snapshot(over: Partial<SessionPhaseSource> = {}): SessionPhaseSource {
  return {
    phase: "idle",
    transportState: "online",
    interruptInFlight: false,
    jobs: [],
    pendingAsk: null,
    ...over,
  };
}

describe("unknown liveness reads idle, never danger", () => {
  test("no snapshot — no card, or services not yet constructed — is idle", () => {
    expect(sessionPhaseFromSnapshot(null)).toBe("idle");
  });

  test("idle is not the danger role, which is what makes the fallback safe", () => {
    // The two halves of the decision have to be checked together: answering
    // `idle` would buy nothing if `idle` painted red, and this is the mapping
    // the retired offline fallback went through to get there.
    expect(sessionSessionPhaseVisual("idle").role).not.toBe("danger");
    expect(sessionSessionPhaseVisual("offline").role).toBe("danger");
  });

  test("a card whose transport is genuinely offline still reads danger", () => {
    // Doubt is not failure, but failure is still failure: a session with a live
    // card and a dead wire has something real to report.
    expect(
      sessionPhaseFromSnapshot(snapshot({ transportState: "offline" })),
    ).toBe("offline");
  });
});

describe("the fold reports what the snapshot holds", () => {
  test("a quiet session is idle", () => {
    expect(sessionPhaseFromSnapshot(snapshot())).toBe("idle");
  });

  test("agents running with no turn in flight is background, not idle", () => {
    const job: JobItem = {
      jobId: "j1",
      source: "claude",
      kind: "agent",
      toolUseId: "t1",
      description: "auditing the theme tokens",
      status: "running",
      startedAtMs: 0,
      endedAtMs: null,
    };
    expect(
      sessionPhaseFromSnapshot(snapshot({ phase: "idle", jobs: [job] })),
    ).toBe("background");
  });

  test("a turn in flight reports its own phase", () => {
    expect(sessionPhaseFromSnapshot(snapshot({ phase: "streaming" }))).toBe(
      "streaming",
    );
  });
});

function arcRow(over: Partial<ArcChangesetEntry> = {}): ArcChangesetEntry {
  return {
    kind: "arc",
    owner_id: "tugarc/ready#a1",
    display_name: "ready",
    files: [],
    ...over,
  } as ArcChangesetEntry;
}

describe("joinOfferStands — the offer-stands fact", () => {
  const offer = {
    request_id: "ready:base1:head1",
    base_sha: "base1",
    arc_head: "head1",
  };

  test("an arc row carrying an offer stands", () => {
    expect(
      joinOfferStands("tugarc/ready#a1", [
        arcRow({ join: { phase: "resolved", offer } }),
      ]),
    ).toBe(true);
  });

  test("the same arc with no offer does not — a working arc is not ready", () => {
    expect(
      joinOfferStands("tugarc/ready#a1", [arcRow({ join: { phase: "resolved" } })]),
    ).toBe(false);
  });

  test("an arc with no join block at all does not", () => {
    expect(joinOfferStands("tugarc/ready#a1", [arcRow()])).toBe(false);
  });

  test("a card mated to no arc never reads ready", () => {
    expect(
      joinOfferStands(null, [arcRow({ join: { phase: "resolved", offer } })]),
    ).toBe(false);
  });

  test("another arc's standing offer is not this card's", () => {
    expect(
      joinOfferStands("tugarc/mine#b2", [
        arcRow({ join: { phase: "resolved", offer } }),
      ]),
    ).toBe(false);
  });

  test("an empty feed reads quiet rather than unknown", () => {
    expect(joinOfferStands("tugarc/ready#a1", [])).toBe(false);
  });
});

describe("the fold folds the offer in", () => {
  test("a quiet session whose arc has finished reads ready, not idle", () => {
    expect(sessionPhaseFromSnapshot(snapshot(), true)).toBe("ready");
  });

  test("omitted makes no Ready claim — a replayed row has no register to read", () => {
    expect(sessionPhaseFromSnapshot(snapshot())).toBe("idle");
  });

  test("a turn in flight keeps its own phase over a standing offer", () => {
    expect(sessionPhaseFromSnapshot(snapshot({ phase: "streaming" }), true)).toBe(
      "streaming",
    );
  });

  test("no snapshot still reads idle, offer or not", () => {
    expect(sessionPhaseFromSnapshot(null, true)).toBe("idle");
  });
});

describe("joinOfferBase and joinOfferArcName — what stands, and about what", () => {
  const offer = {
    request_id: "ready:base1:head1",
    base_sha: "base1",
    arc_head: "head1",
  };
  const standing = [
    arcRow({ base: "main", join: { phase: "resolved", offer } }),
  ];

  test("the base is the branch the offer would land on", () => {
    expect(joinOfferBase("tugarc/ready#a1", standing)).toBe("main");
  });

  test("no offer, no base — an arc still being worked names nothing", () => {
    expect(
      joinOfferBase("tugarc/ready#a1", [
        arcRow({ base: "main", join: { phase: "resolved" } }),
      ]),
    ).toBe(null);
  });

  test("the name is the arc the standing offer is about", () => {
    expect(joinOfferArcName("tugarc/ready#a1", standing)).toBe("ready");
  });

  test("no offer, no name", () => {
    expect(joinOfferArcName("tugarc/ready#a1", [arcRow({ base: "main" })])).toBe(
      null,
    );
  });

  test("all three readings agree about whether an offer stands", () => {
    // The receipt's Join, the beat's sentence and the dot's key are three
    // surfaces of one fact; a row where they could disagree is the bug.
    for (const arcs of [standing, [arcRow({ base: "main" })], []]) {
      const stands = joinOfferStands("tugarc/ready#a1", arcs);
      expect(joinOfferBase("tugarc/ready#a1", arcs) !== null).toBe(stands);
      expect(joinOfferArcName("tugarc/ready#a1", arcs) !== null).toBe(stands);
    }
  });
});

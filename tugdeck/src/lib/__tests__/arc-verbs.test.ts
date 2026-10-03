/**
 * `arc-verbs` — the one verb set, as tables across the arc's life, the three
 * surfaces, and what each surface may reach.
 */

import { describe, expect, it } from "bun:test";

import {
  arcVerbs,
  type ArcVerbInput,
  type ArcVerbJoinGate,
  type ArcVerbSet,
} from "@/lib/arc-verbs";
import type { FollowedCardFacts } from "@/lib/arc-transport";

const PROJECT = "/p/tug";
const BRIEF = `${PROJECT}/.tug/arcs/demo/brief.md`;

const FOLLOWED: FollowedCardFacts = {
  cardId: "card-1",
  tugSessionId: "sess-follow",
  projectDir: PROJECT,
  cardName: "follow",
  runningArc: null,
};

const BRANCH = {
  base: "main",
  worktree_dirty: false,
  hasRange: true,
};

/** A join gate with nothing in the way: a clean preview, nobody working. */
const CLEAN_GATE: ArcVerbJoinGate = {
  state: { phase: "previewed" },
  holderBusy: false,
  turnInProgress: false,
  pending: false,
};

/** A full-reach input: every housekeeping verb offered, nothing refused. */
function input(over: Partial<ArcVerbInput> = {}): ArcVerbInput {
  return {
    surface: "arcs",
    arc: "demo",
    projectDir: PROJECT,
    run: null,
    documents: { brief: BRIEF },
    boundSession: null,
    boundCardOpen: false,
    stage: undefined,
    draft: null,
    joinGate: CLEAN_GATE,
    branch: BRANCH,
    followed: FOLLOWED,
    reach: {
      binding: { bound: false, refusal: null },
      replay: { refusal: null },
      discard: { refusal: null },
    },
    ...over,
  };
}

/** The row as a list of kinds, in order — the shape a reader scans. */
function kinds(set: ArcVerbSet): string[] {
  return [
    ...(set.next === null ? [] : [set.next.kind]),
    ...(set.view === null ? [] : [set.view.kind]),
    ...set.housekeeping.map((v) => v.kind),
  ];
}

describe("the first slot across an arc's life ([B04])", () => {
  it("is Start for a briefed arc", () => {
    const next = arcVerbs(input()).next;
    expect(next?.kind).toBe("start");
    expect(next?.refusal).toBeNull();
  });

  it("is Stop while it runs, acting as the bound card", () => {
    const next = arcVerbs(
      input({
        run: { stage: "implement" },
        boundSession: "sess-bound",
        boundCardOpen: true,
      }),
    ).next;
    expect(next?.kind).toBe("stop");
    expect(next && "actor" in next ? next.actor.tugSessionId : null).toBe(
      "sess-bound",
    );
  });

  it("is Resume once stopped", () => {
    const next = arcVerbs(
      input({ run: { stage: "implement", stopped: "stopped by user" } }),
    ).next;
    expect(next?.kind).toBe("resume");
  });

  it("is Join when the arc is ready, for every joinable stage word", () => {
    for (const stage of ["ready", "built", "audited"]) {
      const next = arcVerbs(
        input({
          stage,
          run: { stage: "audit", done: true },
          boundSession: "sess-bound",
          boundCardOpen: true,
          draft: "Land the demo",
        }),
      ).next;
      expect(next?.kind).toBe("join");
      expect(next?.refusal).toBeNull();
      expect(next?.label).toBe("Join arc demo onto main");
    }
  });

  it("is Join over a Resume on a ready arc", () => {
    const next = arcVerbs(
      input({ stage: "ready", run: { stage: "audit", stopped: "x" } }),
    ).next;
    expect(next?.kind).toBe("join");
  });

  it("is Stop, not Join, while a wheel runs on a ready arc", () => {
    const next = arcVerbs(
      input({ stage: "ready", run: { stage: "audit" }, boundSession: "s" }),
    ).next;
    expect(next?.kind).toBe("stop");
  });

  it("is empty for a finished arc that is not ready", () => {
    expect(arcVerbs(input({ run: { stage: "audit", done: true } })).next).toBeNull();
  });

  it("is empty for an arc with nothing to start from", () => {
    expect(arcVerbs(input({ documents: undefined })).next).toBeNull();
  });
});

describe("Join's refusals ([B05])", () => {
  const ready = {
    stage: "ready",
    run: { stage: "audit", done: true },
  } as const;

  it("refuses an unbound arc", () => {
    const next = arcVerbs(input({ ...ready })).next;
    expect(next?.refusal).toBe("no card holds it");
    expect(next?.label).toBe("Join arc demo onto main — no card holds it");
  });

  it("refuses when the bound card is closed", () => {
    const next = arcVerbs(
      input({ ...ready, boundSession: "s", boundCardOpen: false }),
    ).next;
    expect(next?.refusal).toBe("its card is closed");
  });

  it("refuses when there is no join message", () => {
    const next = arcVerbs(
      input({ ...ready, boundSession: "s", boundCardOpen: true, draft: null }),
    ).next;
    expect(next?.refusal).toBe("it has no join message yet");
  });

  /** A ready arc on its open bound card with a message — only the gate left. */
  function gated(gate: Partial<ArcVerbJoinGate>): string | null | undefined {
    return arcVerbs(
      input({
        ...ready,
        boundSession: "s",
        boundCardOpen: true,
        draft: "Land the demo",
        joinGate: { ...CLEAN_GATE, ...gate },
      }),
    ).next?.refusal;
  }

  // The composer's own gate, in its own sentences: a row's Join is the same
  // join through a second door, so it refuses what the composer refuses.
  it("refuses a conflicted merge", () => {
    expect(gated({ state: { phase: "conflicted", conflicts: ["a.ts"] } })).toBe(
      "Resolve the conflicts first",
    );
  });

  it("refuses a join with blockers, and one with no join state at all", () => {
    expect(
      gated({ state: { phase: "blocked", blockers: [{ kind: "base-dirt", title: "Base dirt", detail: "d" }] } }),
    ).toBe("Clear what blocks this join first");
    expect(gated({ state: null })).toBe("Clear what blocks this join first");
  });

  it("refuses a stale resolution in the server's own sentence", () => {
    expect(
      gated({ state: { phase: "previewed", stale_note: "main moved" } }),
    ).toBe("main moved");
  });

  it("admits a conflicted merge whose resolved candidate still verifies", () => {
    expect(
      gated({
        state: { phase: "resolved", conflicts: ["a.ts"], candidate: "abc123" },
      }),
    ).toBeNull();
  });

  it("refuses while the holder works, a turn runs, or a join is out", () => {
    expect(gated({ holderBusy: true })).toBe("Wait for the arc to finish its work");
    expect(gated({ turnInProgress: true })).toBe("Wait for the turn to finish");
    expect(gated({ pending: true })).toBe("Joining…");
  });
});

describe("transport refusals carry over unchanged ([B09])", () => {
  it("refuses Start with no followed card, naming why", () => {
    const next = arcVerbs(input({ followed: null })).next;
    expect(next?.kind).toBe("start");
    expect(next?.refusal).toBe("no Session card to run it on");
    expect(next?.label).toBe("Start arc demo — no Session card to run it on");
  });

  it("refuses Stop on a live arc nobody holds", () => {
    const next = arcVerbs(input({ run: { stage: "implement" } })).next;
    expect(next?.refusal).toBe("no card is running it");
  });
});

describe("the view slot by surface ([B06])", () => {
  it("is Changes on the Arcs card, refused with no open bound card", () => {
    expect(arcVerbs(input()).view).toMatchObject({
      kind: "changes",
      refusal: "no card holds it",
    });
    expect(
      arcVerbs(input({ boundSession: "s", boundCardOpen: false })).view?.refusal,
    ).toBe("its card is closed");
    expect(
      arcVerbs(input({ boundSession: "s", boundCardOpen: true })).view?.refusal,
    ).toBeNull();
  });

  it("is Changes on the popover, never refused", () => {
    expect(arcVerbs(input({ surface: "popover" })).view).toMatchObject({
      kind: "changes",
      refusal: null,
    });
  });

  it("is Diff in the lane, absent with nothing past the base", () => {
    expect(arcVerbs(input({ surface: "changes" })).view?.kind).toBe("diff");
    expect(
      arcVerbs(
        input({ surface: "changes", branch: { ...BRANCH, hasRange: false } }),
      ).view,
    ).toBeNull();
    expect(arcVerbs(input({ surface: "changes", branch: null })).view).toBeNull();
  });
});

describe("the housekeeping verbs ([B02], [B07], [B09])", () => {
  it("run in one order: binding, replay, discard", () => {
    expect(kinds(arcVerbs(input()))).toEqual([
      "start",
      "changes",
      "bind",
      "replay",
      "discard",
    ]);
  });

  it("read Unbind on a bound arc", () => {
    const set = arcVerbs(
      input({ reach: { binding: { bound: true, refusal: null }, replay: null, discard: null } }),
    );
    expect(set.housekeeping.map((v) => v.word)).toEqual(["Unbind"]);
  });

  it("are absent where the surface has no reach", () => {
    const set = arcVerbs(
      input({ reach: { binding: null, replay: null, discard: null } }),
    );
    expect(set.housekeeping).toEqual([]);
  });

  it("carry the surface's refusal verbatim", () => {
    const set = arcVerbs(
      input({
        reach: {
          binding: { bound: false, refusal: "Focus a session card to bind this arc" },
          replay: { refusal: "A replay is in flight" },
          discard: { refusal: "a turn is running" },
        },
      }),
    );
    expect(set.housekeeping.map((v) => v.refusal)).toEqual([
      "Focus a session card to bind this arc",
      "A replay is in flight",
      "a turn is running",
    ]);
  });

  it("name Replay's destination and take its terms from the arc's facts", () => {
    const current = arcVerbs(input()).housekeeping.find((v) => v.kind === "replay");
    expect(current?.word).toBe("Replay onto main");
    expect(current?.refusal).toBe("already current with main");
    const diverged = arcVerbs(
      input({ branch: { ...BRANCH, base_ahead: 2 } }),
    ).housekeeping.find((v) => v.kind === "replay");
    expect(diverged?.refusal).toBeNull();
  });

  it("drop Replay and keep Discard on a branchless arc", () => {
    expect(arcVerbs(input({ branch: null })).housekeeping.map((v) => v.kind)).toEqual([
      "bind",
      "discard",
    ]);
  });
});

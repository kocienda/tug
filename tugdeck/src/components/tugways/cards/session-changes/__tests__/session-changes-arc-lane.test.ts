/**
 * The arc lane's ordering, over the shared golden snapshot.
 *
 * The fronting rule keys on the owner key, never the display name — the whole
 * point being that a stale binding to a dead incarnation of a reused name must
 * not front the wrong arc.
 *
 * The rest group is the unbound arcs: an arc another live session holds is
 * not a row in this card's lane (its room is the card working it, [D153]),
 * and what remains comes back in the Arcs card's order.
 */

import { describe, expect, test } from "bun:test";

import golden from "@/__tests__/fixtures/workspaces-changeset-snapshot.golden.json";
import type {
  ArcChangesetEntry,
  ArcJoinBlockerWire,
  WorkspacesChangesetSnapshot,
} from "@/lib/changeset-types";
import {
  canDiscardFromHere,
  arcBranchRef,
  arcRowOpensItself,
  orderArcLane,
  discardConfirmMessage,
} from "../session-changes-arc-lane";
import { compareArcEntries } from "@/lib/arc-order";

const DATA = golden as WorkspacesChangesetSnapshot;

const ARCS: ArcChangesetEntry[] = DATA.projects
  .flatMap((project) => project.changesets)
  .filter((entry): entry is ArcChangesetEntry => entry.kind === "arc");

/** The session the golden arc is bound to — this card, when a test says so. */
const HOLDER = ARCS[0]!.bound_sessions![0]!;

describe("orderArcLane", () => {
  test("the golden snapshot carries an arc to order", () => {
    expect(ARCS.length).toBeGreaterThan(0);
    expect(ARCS[0]!.display_name).toBe("fix-join");
    expect(HOLDER).toBeString();
  });

  test("the bound owner key fronts its arc", () => {
    const bound = ARCS[0]!;
    const order = orderArcLane(ARCS, bound.owner_id, HOLDER);
    expect(order.fronted).toBe(bound);
    expect(order.rest).not.toContain(bound);
    expect(order.rest.length).toBe(ARCS.length - 1);
  });

  test("an unbound card fronts nothing and lists the unbound arcs", () => {
    const order = orderArcLane(ARCS, null, "some-other-session");
    expect(order.fronted).toBeNull();
    // The golden arc is held by a live session that is not this card's, so
    // it is not a row here: its room is the card working it.
    expect(order.rest).toEqual([]);
  });

  test("a binding to a dead incarnation fronts nothing", () => {
    // Same name, different id — the haunting case the owner-key match retires.
    const stale = `tugarc/${ARCS[0]!.display_name}#0-deadbeef`;
    const order = orderArcLane(ARCS, stale, HOLDER);
    expect(order.fronted).toBeNull();
    // This session holds the arc, so it stays, unfronted.
    expect(order.rest).toEqual(ARCS);
  });

  test("fronting follows the id it is given, which need not be the binding", () => {
    // `/arc-join <name>` aims at an arc without binding the card to it, and
    // the landing face — outcome, blockers, the resolve ladder — mounts on the
    // fronted row alone. Fronting by the binding left a named join live in the
    // composer with nothing in the room to explain a refusal.
    const aimed = ARCS[0]!;
    // Aimed from a card whose session does not hold it: a held arc is still
    // fronted, because fronting is about what is being landed, not held.
    const order = orderArcLane(ARCS, aimed.owner_id, "some-other-session");
    expect(order.fronted).toBe(aimed);
    // Which row is fronted says nothing about which arc the card is mated to:
    // the lane takes both, and Unbind-vs-Bind reads the binding.
    expect(order.rest).not.toContain(aimed);
  });

  test("an empty lane orders to nothing", () => {
    const order = orderArcLane([], "tugarc/whatever#1", HOLDER);
    expect(order.fronted).toBeNull();
    expect(order.rest).toEqual([]);
  });

  test("later arcs front just as well as the first", () => {
    const second: ArcChangesetEntry = { ...ARCS[0]!, owner_id: "tugarc/b#2", display_name: "b" };
    const order = orderArcLane([ARCS[0]!, second], second.owner_id, HOLDER);
    expect(order.fronted).toBe(second);
    expect(order.rest).toEqual([ARCS[0]!]);
  });

  describe("the rest is the unbound arcs", () => {
    const OWN_SESSION = "session-here";
    const arc = (
      name: string,
      over: Partial<ArcChangesetEntry> = {},
    ): ArcChangesetEntry => ({
      ...ARCS[0]!,
      owner_id: `tugarc/${name}#1`,
      display_name: name,
      bound_sessions: [],
      ...over,
    });

    test("an arc another live session holds is absent", () => {
      const theirs = arc("theirs", { bound_sessions: ["some-other-session"] });
      const order = orderArcLane([theirs], null, OWN_SESSION);
      expect(order.rest).toEqual([]);
    });

    test("an arc held by several sessions, none of them this one, is absent", () => {
      const theirs = arc("theirs", { bound_sessions: ["a", "b", "c"] });
      expect(orderArcLane([theirs], null, OWN_SESSION).rest).toEqual([]);
    });

    test("an arc this session holds without fronting stays", () => {
      // A card can be mated to arc A while arc B also lists this session.
      const mine = arc("mine", { bound_sessions: [OWN_SESSION] });
      const other = arc("other", { bound_sessions: [OWN_SESSION, "a"] });
      const order = orderArcLane([mine, other], "tugarc/a#1", OWN_SESSION);
      expect(order.fronted).toBeNull();
      expect(order.rest).toContain(mine);
      expect(order.rest).toContain(other);
    });

    test("an unbound arc stays", () => {
      const unbound = arc("unbound", { bound_sessions: [] });
      expect(orderArcLane([unbound], null, OWN_SESSION).rest).toEqual([unbound]);
    });

    test("an older sender that omits bound_sessions reads as unbound", () => {
      // The same safe direction canDiscardFromHere takes: absence is not
      // evidence of a holder.
      const legacy = arc("legacy", { bound_sessions: undefined });
      expect(orderArcLane([legacy], null, OWN_SESSION).rest).toEqual([legacy]);
    });

    test("a card with no session id keeps only the unbound arcs", () => {
      const theirs = arc("theirs", { bound_sessions: ["some-other-session"] });
      const unbound = arc("unbound");
      expect(orderArcLane([theirs, unbound], null, undefined).rest).toEqual([unbound]);
    });

    test("the aimed-join case still fronts a held arc", () => {
      const theirs = arc("theirs", { bound_sessions: ["some-other-session"] });
      const order = orderArcLane([theirs], theirs.owner_id, OWN_SESSION);
      expect(order.fronted).toBe(theirs);
      expect(order.rest).toEqual([]);
    });

    test("the rest comes back in the Arcs card's order, not snapshot order", () => {
      const created = arc("created", { stage: "created", last_activity: "2026-09-03T10:00:00Z" });
      const joining = arc("joining", { stage: "joining", last_activity: "2026-09-01T10:00:00Z" });
      const older = arc("older", { stage: "implementing", last_activity: "2026-09-01T10:00:00Z" });
      const newer = arc("newer", { stage: "implementing", last_activity: "2026-09-02T10:00:00Z" });
      const snapshotOrder = [created, older, joining, newer];
      const order = orderArcLane(snapshotOrder, null, OWN_SESSION);
      expect(order.rest.map((e) => e.display_name)).toEqual([
        "joining",
        "newer",
        "older",
        "created",
      ]);
      expect(order.rest).toEqual([...snapshotOrder].sort(compareArcEntries));
    });

    test("the input array is never reordered in place", () => {
      const a = arc("a", { stage: "created" });
      const b = arc("b", { stage: "joining" });
      const input = [a, b];
      orderArcLane(input, null, OWN_SESSION);
      expect(input).toEqual([a, b]);
    });
  });
});

describe("canDiscardFromHere", () => {
  const OWN_SESSION = "session-here";
  const OWN_ARC = "tugarc/mine#1";
  const arc = (over: Partial<ArcChangesetEntry> = {}): ArcChangesetEntry => ({
    ...ARCS[0]!,
    owner_id: "tugarc/theirs#2",
    bound_sessions: [],
    ...over,
  });

  test("this card's own arc is always releasable from here", () => {
    // Even while this very session holds it — it is the session doing the
    // releasing, so there is nobody to take it away from.
    const own = arc({ owner_id: OWN_ARC, bound_sessions: [OWN_SESSION] });
    expect(canDiscardFromHere(own, OWN_SESSION, OWN_ARC)).toBe(true);
  });

  test("an arc no live session holds is releasable", () => {
    // Unbound or orphaned — exactly the mess a shade should be able to clear.
    const unbound = arc({ bound_sessions: [] });
    expect(canDiscardFromHere(unbound, OWN_SESSION, OWN_ARC)).toBe(true);
  });

  test("an arc this session holds without fronting is releasable", () => {
    // A card can be mated to arc A while arc B also lists this session. The
    // predicate answers by fact rather than by which row happens to be fronted.
    const other = arc({ bound_sessions: [OWN_SESSION] });
    expect(canDiscardFromHere(other, OWN_SESSION, OWN_ARC)).toBe(true);
  });

  test("an arc another live session holds is NOT releasable from here", () => {
    const theirs = arc({ bound_sessions: ["some-other-session"] });
    expect(canDiscardFromHere(theirs, OWN_SESSION, OWN_ARC)).toBe(false);
  });

  test("an arc held by several sessions, none of them this one, is theirs", () => {
    const theirs = arc({ bound_sessions: ["a", "b", "c"] });
    expect(canDiscardFromHere(theirs, OWN_SESSION, OWN_ARC)).toBe(false);
  });

  test("an older sender that omits bound_sessions reads as unbound", () => {
    // Absence is not evidence of a holder, and the safe direction is to offer
    // the gesture: the popover still names the stake, and the destructive
    // overlap case is refused server-side regardless.
    const legacy = arc({ bound_sessions: undefined });
    expect(canDiscardFromHere(legacy, OWN_SESSION, OWN_ARC)).toBe(true);
  });

  test("an unbound card can still discard an unbound arc", () => {
    expect(canDiscardFromHere(arc(), OWN_SESSION, null)).toBe(true);
  });

  test("a card with no session id cannot claim another session's arc", () => {
    const theirs = arc({ bound_sessions: ["some-other-session"] });
    expect(canDiscardFromHere(theirs, undefined, null)).toBe(false);
  });
});

describe("discardConfirmMessage", () => {
  const base: ArcChangesetEntry = {
    ...ARCS[0]!,
    display_name: "sporty-snail",
    base: "main",
    rounds: 0,
    files: [],
    worktree_dirty: false,
    documents: undefined,
  };

  test("names the arc and what teardown deletes, always", () => {
    expect(discardConfirmMessage(base)).toBe(
      "Discard sporty-snail: deletes the branch and worktree.",
    );
  });

  test("an arc with no work carries no discards clause", () => {
    // Saying "discards 0 rounds" would invent a stake that is not there.
    expect(discardConfirmMessage(base)).not.toContain("Discards");
  });

  test("rounds and files are counted into one discards clause", () => {
    const worked: ArcChangesetEntry = {
      ...base,
      rounds: 2,
      files: [ARCS[0]!.files[0]!].filter(Boolean),
    };
    const message = discardConfirmMessage(worked);
    expect(message).toContain("Discards 2 rounds · 1 file");
  });

  test("a dirty worktree names the hand-back and its destination", () => {
    // `arc discard` writes the worktree's uncommitted files back into the
    // base checkout rather than destroying them. A reader who was not told
    // that has not consented to it.
    const dirty: ArcChangesetEntry = { ...base, worktree_dirty: true };
    expect(discardConfirmMessage(dirty)).toContain(
      "Uncommitted files in the worktree are handed back to main.",
    );
  });

  test("a clean worktree says nothing about a hand-back", () => {
    expect(discardConfirmMessage(base)).not.toContain("handed back");
  });

  test("an arc with documents says they stay", () => {
    // A discard keeps the arc's documents precisely so it can never destroy
    // decisions the user may want back; the message says where they are.
    const planned: ArcChangesetEntry = {
      ...base,
      documents: { plan: "/repo/.tug/arcs/sporty-snail/plan.md" },
    };
    expect(discardConfirmMessage(planned)).toContain(
      "Its documents stay at .tug/arcs/sporty-snail/.",
    );
  });

  test("the round subjects are not in the message", () => {
    // They live on the row, which renders them when expanded. The popover's
    // message is one flat string that would size itself off the longest
    // subject, and duplicating the row's own list is what this pass deleted.
    const subjects = ["tugarc(x): a very long round subject indeed"];
    const withSubjects: ArcChangesetEntry = {
      ...base,
      rounds: 1,
      round_subjects: subjects,
    };
    expect(discardConfirmMessage(withSubjects)).not.toContain(subjects[0]!);
  });
});

describe("arcBranchRef", () => {
  test("uses the sent branch when present", () => {
    expect(arcBranchRef(ARCS[0]!)).toBe("tugarc/fix-join");
  });

  test("falls back to the tugarc/<name> spelling for an older sender", () => {
    const older: ArcChangesetEntry = { ...ARCS[0]!, branch: undefined };
    expect(arcBranchRef(older)).toBe("tugarc/fix-join");
  });
});

describe("arcRowOpensItself", () => {
  const withBlockers = (
    blockers: readonly ArcJoinBlockerWire[],
  ): ArcChangesetEntry => ({
    ...ARCS[0]!,
    join: { phase: blockers.length > 0 ? "blocked" : "clean", blockers: [...blockers] },
  });

  test("an arc with no join answer stays shut", () => {
    expect(arcRowOpensItself({ ...ARCS[0]!, join: undefined })).toBe(false);
  });

  test("an arc whose join is clean stays shut", () => {
    expect(arcRowOpensItself(withBlockers([]))).toBe(false);
  });

  test("a blocked arc opens itself, so the report is not behind a fold", () => {
    expect(
      arcRowOpensItself(
        withBlockers([
          {
            kind: "base-dirt",
            title: "Another session's edit",
            detail: "Cannot join: ^ink-anchor holds an uncommitted edit.",
          },
        ]),
      ),
    ).toBe(true);
  });
});

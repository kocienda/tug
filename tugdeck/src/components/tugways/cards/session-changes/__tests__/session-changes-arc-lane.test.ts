/**
 * The arc lane's ordering, over the shared golden snapshot.
 *
 * The fronting rule keys on the owner key, never the display name — the whole
 * point being that a stale binding to a dead incarnation of a reused name must
 * not front the wrong dash.
 */

import { describe, expect, test } from "bun:test";

import golden from "@/__tests__/fixtures/workspaces-changeset-snapshot.golden.json";
import type {
  DashChangesetEntry,
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

const DATA = golden as WorkspacesChangesetSnapshot;

const DASHES: DashChangesetEntry[] = DATA.projects
  .flatMap((project) => project.changesets)
  .filter((entry): entry is DashChangesetEntry => entry.kind === "dash");

describe("orderArcLane", () => {
  test("the golden snapshot carries a dash to order", () => {
    expect(DASHES.length).toBeGreaterThan(0);
    expect(DASHES[0]!.display_name).toBe("fix-join");
  });

  test("the bound owner key fronts its dash", () => {
    const bound = DASHES[0]!;
    const order = orderArcLane(DASHES, bound.owner_id);
    expect(order.fronted).toBe(bound);
    expect(order.rest).not.toContain(bound);
    expect(order.rest.length).toBe(DASHES.length - 1);
  });

  test("an unbound card fronts nothing and folds everything", () => {
    const order = orderArcLane(DASHES, null);
    expect(order.fronted).toBeNull();
    expect(order.rest).toEqual(DASHES);
  });

  test("a binding to a dead incarnation fronts nothing", () => {
    // Same name, different id — the haunting case the owner-key match retires.
    const stale = `tugdash/${DASHES[0]!.display_name}#0-deadbeef`;
    const order = orderArcLane(DASHES, stale);
    expect(order.fronted).toBeNull();
    expect(order.rest).toEqual(DASHES);
  });

  test("fronting follows the id it is given, which need not be the binding", () => {
    // `/arc-join <name>` aims at a dash without binding the card to it, and
    // the landing face — outcome, blockers, the resolve ladder — mounts on the
    // fronted row alone. Fronting by the binding left a named join live in the
    // composer with nothing in the room to explain a refusal.
    const aimed = DASHES[0]!;
    const order = orderArcLane(DASHES, aimed.owner_id);
    expect(order.fronted).toBe(aimed);
    // Which row is fronted says nothing about which dash the card is mated to:
    // the lane takes both, and Unbind-vs-Bind reads the binding.
    expect(order.rest).not.toContain(aimed);
  });

  test("an empty lane orders to nothing", () => {
    const order = orderArcLane([], "tugdash/whatever#1");
    expect(order.fronted).toBeNull();
    expect(order.rest).toEqual([]);
  });

  test("later dashes front just as well as the first", () => {
    const second: DashChangesetEntry = { ...DASHES[0]!, owner_id: "tugdash/b#2", display_name: "b" };
    const order = orderArcLane([DASHES[0]!, second], second.owner_id);
    expect(order.fronted).toBe(second);
    expect(order.rest).toEqual([DASHES[0]!]);
  });
});

describe("canDiscardFromHere", () => {
  const OWN_SESSION = "session-here";
  const OWN_DASH = "tugdash/mine#1";
  const dash = (over: Partial<DashChangesetEntry> = {}): DashChangesetEntry => ({
    ...DASHES[0]!,
    owner_id: "tugdash/theirs#2",
    bound_sessions: [],
    ...over,
  });

  test("this card's own dash is always releasable from here", () => {
    // Even while this very session holds it — it is the session doing the
    // releasing, so there is nobody to take it away from.
    const own = dash({ owner_id: OWN_DASH, bound_sessions: [OWN_SESSION] });
    expect(canDiscardFromHere(own, OWN_SESSION, OWN_DASH)).toBe(true);
  });

  test("a dash no live session holds is releasable", () => {
    // Unbound or orphaned — exactly the mess a shade should be able to clear.
    const unbound = dash({ bound_sessions: [] });
    expect(canDiscardFromHere(unbound, OWN_SESSION, OWN_DASH)).toBe(true);
  });

  test("a dash this session holds without fronting is releasable", () => {
    // A card can be mated to dash A while dash B also lists this session. The
    // predicate answers by fact rather than by which row happens to be fronted.
    const other = dash({ bound_sessions: [OWN_SESSION] });
    expect(canDiscardFromHere(other, OWN_SESSION, OWN_DASH)).toBe(true);
  });

  test("a dash another live session holds is NOT releasable from here", () => {
    const theirs = dash({ bound_sessions: ["some-other-session"] });
    expect(canDiscardFromHere(theirs, OWN_SESSION, OWN_DASH)).toBe(false);
  });

  test("a dash held by several sessions, none of them this one, is theirs", () => {
    const theirs = dash({ bound_sessions: ["a", "b", "c"] });
    expect(canDiscardFromHere(theirs, OWN_SESSION, OWN_DASH)).toBe(false);
  });

  test("an older sender that omits bound_sessions reads as unbound", () => {
    // Absence is not evidence of a holder, and the safe direction is to offer
    // the gesture: the popover still names the stake, and the destructive
    // overlap case is refused server-side regardless.
    const legacy = dash({ bound_sessions: undefined });
    expect(canDiscardFromHere(legacy, OWN_SESSION, OWN_DASH)).toBe(true);
  });

  test("an unbound card can still discard an unbound dash", () => {
    expect(canDiscardFromHere(dash(), OWN_SESSION, null)).toBe(true);
  });

  test("a card with no session id cannot claim another session's dash", () => {
    const theirs = dash({ bound_sessions: ["some-other-session"] });
    expect(canDiscardFromHere(theirs, undefined, null)).toBe(false);
  });
});

describe("discardConfirmMessage", () => {
  const base: DashChangesetEntry = {
    ...DASHES[0]!,
    display_name: "sporty-snail",
    base: "main",
    rounds: 0,
    files: [],
    worktree_dirty: false,
    documents: undefined,
  };

  test("names the dash and what teardown deletes, always", () => {
    expect(discardConfirmMessage(base)).toBe(
      "Discard sporty-snail: deletes the branch and worktree.",
    );
  });

  test("a dash with no work carries no discards clause", () => {
    // Saying "discards 0 rounds" would invent a stake that is not there.
    expect(discardConfirmMessage(base)).not.toContain("Discards");
  });

  test("rounds and files are counted into one discards clause", () => {
    const worked: DashChangesetEntry = {
      ...base,
      rounds: 2,
      files: [DASHES[0]!.files[0]!].filter(Boolean),
    };
    const message = discardConfirmMessage(worked);
    expect(message).toContain("Discards 2 rounds · 1 file");
  });

  test("a dirty worktree names the hand-back and its destination", () => {
    // `dash discard` writes the worktree's uncommitted files back into the
    // base checkout rather than destroying them. A reader who was not told
    // that has not consented to it.
    const dirty: DashChangesetEntry = { ...base, worktree_dirty: true };
    expect(discardConfirmMessage(dirty)).toContain(
      "Uncommitted files in the worktree are handed back to main.",
    );
  });

  test("a clean worktree says nothing about a hand-back", () => {
    expect(discardConfirmMessage(base)).not.toContain("handed back");
  });

  test("a dash with documents says they stay", () => {
    // A discard keeps the dash's documents precisely so it can never destroy
    // decisions the user may want back; the message says where they are.
    const planned: DashChangesetEntry = {
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
    const subjects = ["tugdash(x): a very long round subject indeed"];
    const withSubjects: DashChangesetEntry = {
      ...base,
      rounds: 1,
      round_subjects: subjects,
    };
    expect(discardConfirmMessage(withSubjects)).not.toContain(subjects[0]!);
  });
});

describe("arcBranchRef", () => {
  test("uses the sent branch when present", () => {
    expect(arcBranchRef(DASHES[0]!)).toBe("tugdash/fix-join");
  });

  test("falls back to the tugdash/<name> spelling for an older sender", () => {
    const older: DashChangesetEntry = { ...DASHES[0]!, branch: undefined };
    expect(arcBranchRef(older)).toBe("tugdash/fix-join");
  });
});

describe("arcRowOpensItself", () => {
  const withBlockers = (
    blockers: readonly ArcJoinBlockerWire[],
  ): DashChangesetEntry => ({
    ...DASHES[0]!,
    join: { phase: blockers.length > 0 ? "blocked" : "clean", blockers: [...blockers] },
  });

  test("a dash with no join answer stays shut", () => {
    expect(arcRowOpensItself({ ...DASHES[0]!, join: undefined })).toBe(false);
  });

  test("a dash whose join is clean stays shut", () => {
    expect(arcRowOpensItself(withBlockers([]))).toBe(false);
  });

  test("a blocked dash opens itself, so the report is not behind a fold", () => {
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

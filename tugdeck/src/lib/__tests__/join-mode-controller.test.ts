/**
 * join-mode-controller — the land gate, the outcome derivation, and the
 * controller's lifecycle ([P01], [P05]).
 *
 * The gate is commit's, field for field, with one reason swapped: the third
 * check is what is being landed rather than how many files are selected. That
 * parity is the point — two landing gates that disagreed about "a turn is
 * running" would be worse than one that is imprecise — so the table below walks
 * the reasons in the same precedence order commit's does.
 *
 * The controller half drives the real verb and draft singletons attached to a
 * fake connection, the way the verb-store suites do, so a land press is a real
 * frame on a real store rather than a spy. What a landing *would* do is not
 * asked for at all: it rides the dash's feed entry, so the fixtures below set a
 * `join` block and the controller reads it.
 */

import { beforeEach, afterEach, describe, expect, it } from "bun:test";

import {
  JoinModeController,
  deriveJoinOutcome,
  evaluateJoinGate,
  joinDisabledReason,
  joinLandConfirm,
  verificationVerdict,
  redOverrideStands,
  joinTargetFromEntry,
  type JoinTarget,
} from "@/lib/join-mode-controller";
import {
  _resetChangesetDraftStoreForTest,
  attachChangesetDraftStore,
} from "@/lib/changeset-draft-store";
import {
  _resetChangesetVerbStoreForTest,
  attachChangesetVerbStore,
} from "@/lib/changeset-verb-store";
import {
  _resetChangesetJoinStoreForTest,
  attachChangesetJoinStore,
} from "@/lib/changeset-join-store";
import { CHANGES_SERVICE_DISCONNECTED } from "@/lib/landing-mode";
import type { ChangesRouteController } from "@/lib/changes-route-controller";
import type { CodeSessionStore } from "@/lib/code-session-store";
import type { CommitModeController } from "@/lib/commit-mode-controller";
import type { DashChangesetEntry, DashJoinStateWire } from "@/lib/changeset-types";

/**
 * A dash whose merge is clean and whose candidate the project's own checks have
 * passed — the state a join may actually proceed from.
 *
 * The candidate and the verdict are not decoration. Every join rides a
 * candidate now ([P03]): entering join mode on a clean dash resolves it, the
 * server verifies what that produced, and the gate refuses until there is a
 * green verdict about the exact tree that would land. A bare `{ phase:
 * "previewed" }` is the *unverified* window, and it is deliberately not
 * joinable — see {@link UNVERIFIED_CLEAN}.
 */
const CLEAN_JOIN: DashJoinStateWire = {
  phase: "previewed",
  candidate: "cafe1234",
  verification: {
    tier0: "green",
    tier1: "green",
    base_sha: "base0000",
    candidate_sha: "cafe1234",
  },
};

/** Clean, and nothing has been built or judged yet — the auto-resolve window. */
const UNVERIFIED_CLEAN: DashJoinStateWire = { phase: "previewed" };

describe("joinDisabledReason", () => {
  // The regression this pins: a real `base-dirt` blocker derives `blocked`,
  // the gate refuses on the outcome, and the composer's land button used to
  // report a constant that named no cause — leaving a disabled button, a
  // generated message, and no way to learn what was wrong.
  it("names the cause for a dash the server reports blocked", () => {
    expect(joinDisabledReason("outcome", "blocked")).toBe(
      "Clear what blocks this join first",
    );
  });

  it("reports the turn and the round trip before the outcome has a say", () => {
    expect(joinDisabledReason("turn", "blocked")).toBe(
      "Wait for the turn to finish",
    );
    // `pending` can only mean an execute in flight now that nothing previews,
    // so the sentence says that rather than describing a round trip that no
    // longer exists.
    expect(joinDisabledReason("pending", "blocked")).toBe("Joining…");
  });

  it("names each verdict's own act or its wait, whatever the outcome reads", () => {
    // The outcome word is `clean` here — a resolved candidate derives clean —
    // so the sentence has to come from the reason, not from the outcome.
    //
    // The first two are waits, not acts: the pilot builds the joined tree at
    // `built` with no gesture, so there is no Verify control left to name and
    // a sentence that named one would point at nothing.
    expect(joinDisabledReason("unverified", "clean")).toBe(
      "Building the joined tree",
    );
    expect(joinDisabledReason("verifying", "conflicted")).toBe(
      "Building the joined tree",
    );
  });

  it("names the missing message rather than falling through to the outcome", () => {
    // Without its own arm this reason lands in the outcome switch and, over a
    // clean preview, reads "This join cannot land yet" — which names nothing
    // the user can do about a message they simply have not typed.
    expect(joinDisabledReason("empty-message", "clean")).toBe("Write a join message");
  });

  it("distinguishes conflicted and empty", () => {
    expect(joinDisabledReason("outcome", "conflicted")).toBe(
      "Resolve the conflicts first",
    );
    expect(joinDisabledReason("outcome", "empty")).toBe("Nothing to join");
  });

  it("quotes the server's stale sentence, which names which side moved", () => {
    // The note is the refusal: only the server knows whether the base or the
    // dash moved, and "resolve again" without that is advice without a cause.
    expect(
      joinDisabledReason("outcome", "stale", "main moved since this was resolved — resolve again"),
    ).toBe("main moved since this was resolved — resolve again");
    // A stale state whose note did not survive still refuses in words.
    expect(joinDisabledReason("outcome", "stale")).toBe(
      "The resolution is out of date — resolve again",
    );
  });
});

describe("verificationVerdict", () => {
  it("reads the candidate's verdict, and calls absence unrun rather than green", () => {
    // No candidate and nothing on offer to build one from: a blocked dash is
    // never going to be verified, so demanding a verdict would refuse with a
    // sentence naming an act that would not help.
    expect(
      verificationVerdict({
        phase: "blocked",
        blockers: [{ kind: "base-dirt", detail: "commit outstanding changes", paths: [] }],
      }),
    ).toBe("not-applicable");
    // But a *clean* dash with no candidate yet is `unrun`, not exempt. That is
    // the window between entering join mode and the auto-resolve anchoring a
    // candidate, and reading it as not-applicable let the gate wave a join
    // through in the seconds before anything had been built or judged.
    expect(verificationVerdict({ phase: "previewed" })).toBe("unrun");
    // A candidate nobody has asked about. This is the distinction the whole
    // type exists for: "nobody ran the checks" is not "the checks passed", and
    // conflating them is how a tree nobody built joins looking verified.
    expect(verificationVerdict({ phase: "resolved", candidate: "abc" })).toBe(
      "unrun",
    );
    const verdict = (tier0: string, tier1: string) =>
      verificationVerdict({
        phase: "resolved",
        candidate: "abc",
        verification: {
          tier0,
          tier1,
          base_sha: "b",
          candidate_sha: "abc",
        },
      });
    expect(verdict("green", "green")).toBe("green");
    expect(verdict("red", "unrun")).toBe("red");
    expect(verdict("running", "unrun")).toBe("running");
    // Tier 0 alone decides, so tier1 cannot move the verdict in any
    // direction. It stays on the wire as durable branch state; a `running`
    // tier1 that could refuse a join would be a wait nothing on screen
    // explains, which is exactly what the arc deletes.
    expect(verdict("green", "running")).toBe("green");
    expect(verdict("green", "unrun")).toBe("green");
    expect(verdict("green", "red")).toBe("green");
  });

  it("asks nothing of a dash the feed has said nothing about", () => {
    expect(verificationVerdict(undefined)).toBe("not-applicable");
    expect(verificationVerdict(null)).toBe("not-applicable");
  });
});

describe("redOverrideStands", () => {
  it("holds only for the candidate it was decided over", () => {
    // The comparison is the whole design. A re-resolve — the ordinary answer
    // to a red — puts a new candidate up, and one press of Join anyway must
    // not wave through every candidate the dash produces afterwards.
    expect(redOverrideStands("cafe1234", "cafe1234")).toBe(true);
    expect(redOverrideStands("beef5678", "cafe1234")).toBe(false);
    expect(redOverrideStands("cafe1234", null)).toBe(false);
    expect(redOverrideStands(null, "cafe1234")).toBe(false);
    // Absent on the wire, which is how every dash with no override arrives.
    expect(redOverrideStands("cafe1234", undefined)).toBe(false);
  });
});

describe("evaluateJoinGate", () => {
  const base = {
    turnInProgress: false,
    joinPhase: "idle" as const,
    outcome: "clean" as const,
    candidateCommit: null,
    verdict: "not-applicable" as const,
    redOverride: false,
    message: "land it",
  };

  it("passes over a clean merge with a message", () => {
    expect(evaluateJoinGate(base)).toEqual({ ok: true });
  });

  it("fails first on a running turn, before every other reason", () => {
    expect(
      evaluateJoinGate({
        ...base,
        turnInProgress: true,
        joinPhase: "pending",
        outcome: "blocked",
        message: "",
      }),
    ).toEqual({ ok: false, reason: "turn" });
  });

  it("fails on a pending round trip before the outcome / message checks", () => {
    expect(
      evaluateJoinGate({ ...base, joinPhase: "pending", outcome: "blocked", message: "" }),
    ).toEqual({ ok: false, reason: "pending" });
  });

  it("fails on the outcome before the message check", () => {
    expect(evaluateJoinGate({ ...base, outcome: "blocked", message: "" })).toEqual({
      ok: false,
      reason: "outcome",
    });
  });

  it("refuses a dash the server reports blocked", () => {
    // The face that carries blockers derives `blocked`, and blocked never lands.
    expect(evaluateJoinGate({ ...base, outcome: "blocked" })).toEqual({
      ok: false,
      reason: "outcome",
    });
  });

  it("lands a resolved candidate even though the history conflicted", () => {
    // Driven through the deriver rather than by handing the gate an outcome
    // and a candidate separately: the candidate's authority lives in
    // `deriveJoinOutcome` alone, so a pair the deriver cannot produce is not a
    // state worth asserting about.
    const outcome = deriveJoinOutcome({
      phase: "resolved",
      conflicts: ["a.rs"],
      candidate: "cafe1234",
    });
    expect(outcome).toBe("clean");
    expect(evaluateJoinGate({ ...base, outcome, candidateCommit: "cafe1234" })).toEqual({
      ok: true,
    });
  });

  it("refuses a candidate nobody has verified, and lets a red through to the confirm", () => {
    // The 2026-08-15 failure: a stale rerere replay built a candidate that
    // armed Join exactly as a clean preview would ([P31]).
    expect(
      evaluateJoinGate({
        ...base,
        outcome: "clean",
        candidateCommit: "cafe1234",
        verdict: "unrun",
      }),
    ).toEqual({ ok: false, reason: "unverified" });
    // A red does NOT refuse ([P05]). The gate passes it and the button asks —
    // which is the whole point of the change: the act that clears a red is now
    // the control the user is already looking at, not a second one somewhere
    // else. What guards the base is the server's own gate, and what passes it
    // is an answered confirm.
    expect(
      evaluateJoinGate({
        ...base,
        candidateCommit: "cafe1234",
        verdict: "red",
      }),
    ).toEqual({ ok: true });
    expect(
      evaluateJoinGate({
        ...base,
        candidateCommit: "cafe1234",
        verdict: "red",
        redOverride: true,
      }),
    ).toEqual({ ok: true });
  });

  it("arms the confirm on a red, and asks nothing when the decision already stands", () => {
    // The confirm and the role are one derivation, so a danger-shaded button
    // always has a question behind it and an ordinary land never does.
    expect(joinLandConfirm("green", false, [])).toBeNull();
    expect(joinLandConfirm("unrun", false, undefined)).toBeNull();
    expect(joinLandConfirm("red", false, undefined)).toBe(
      "The build is red on the joined tree. Join anyway?",
    );
    // The verdict's own failures, counted — "how much is broken" is the fact
    // that decides this, and a confirm that could only say "something" would
    // be asking the user to go look somewhere else before answering.
    expect(joinLandConfirm("red", false, ["cargo build"])).toBe(
      "The build is red on the joined tree — 1 failing check. Join anyway?",
    );
    expect(joinLandConfirm("red", false, ["cargo build", "bun test"])).toBe(
      "The build is red on the joined tree — 2 failing checks. Join anyway?",
    );
    // A standing override is this same decision, already made about this same
    // candidate. Asking again is how a confirm becomes something to click
    // through without reading.
    expect(joinLandConfirm("red", true, ["cargo build"])).toBeNull();
  });

  it("refuses a candidate the base still blocks — resolving is not committing", () => {
    // The ladder resolves conflicts. It does not commit the base's outstanding
    // changes, so a candidate must not clear a blocker that names them: ranked
    // the other way the badge read `clean` over its own "commit outstanding
    // changes" line, and the gate believed the badge.
    const outcome = deriveJoinOutcome({
      phase: "blocked",
      conflicts: ["a.rs"],
      blockers: [{ kind: "base-dirt", detail: "commit outstanding changes", paths: ["x.ts"] }],
      candidate: "cafe1234",
    });
    expect(outcome).toBe("blocked");
    expect(evaluateJoinGate({ ...base, outcome, candidateCommit: "cafe1234" })).toEqual({
      ok: false,
      reason: "outcome",
    });
  });

  it("fails on the outcome before the verdict — nothing to join outranks unverified", () => {
    expect(
      evaluateJoinGate({ ...base, outcome: "blocked", verdict: "unrun" }),
    ).toEqual({ ok: false, reason: "outcome" });
  });

  it("fails on the verdict before the message check", () => {
    expect(
      evaluateJoinGate({
        ...base,
        candidateCommit: "cafe1234",
        verdict: "unrun",
        message: "",
      }),
    ).toEqual({ ok: false, reason: "unverified" });
  });

  it("fails on an empty (whitespace) message when everything else is ready", () => {
    expect(evaluateJoinGate({ ...base, message: "   " })).toEqual({
      ok: false,
      reason: "empty-message",
    });
  });
});

describe("deriveJoinOutcome", () => {
  const base: DashJoinStateWire = { phase: "previewed" };
  const blocker = (kind: string) => ({ kind, detail: `${kind} detail`, paths: [] });

  it("reads a clean merge as clean", () => {
    expect(deriveJoinOutcome(base)).toBe("clean");
  });

  it("refuses a dash the feed says nothing about", () => {
    // An older tugcast, or an entry that arrived before the board composed:
    // there is no reading of silence that makes a landing safe.
    expect(deriveJoinOutcome(undefined)).toBe("blocked");
    expect(deriveJoinOutcome(null)).toBe("blocked");
  });

  it("calls out empty separately from the other blockers", () => {
    expect(deriveJoinOutcome({ ...base, blockers: [blocker("empty")] })).toBe("empty");
    expect(deriveJoinOutcome({ ...base, blockers: [blocker("off-base")] })).toBe("blocked");
    // Empty wins when it arrives beside another blocker: release is the act.
    expect(
      deriveJoinOutcome({ ...base, blockers: [blocker("off-base"), blocker("empty")] }),
    ).toBe("empty");
  });

  it("reads conflicting paths as conflicted, and a candidate as landable", () => {
    expect(deriveJoinOutcome({ ...base, conflicts: ["a.ts"] })).toBe("conflicted");
    expect(deriveJoinOutcome({ ...base, conflicts: ["a.ts"], candidate: "cafe1234" })).toBe(
      "clean",
    );
  });

  it("refuses a merge that is clean under a candidate the server dropped", () => {
    // The trap: the base moved, the server invalidated the candidate, and the
    // merge underneath happens to be clean. Landing it would land an unread
    // machine merge under a review that answered a different one.
    expect(
      deriveJoinOutcome({
        ...base,
        stale_note: "main moved since this was resolved — resolve again",
      }),
    ).toBe("stale");
  });

  it("ranks a live candidate over a stale note, so a re-resolve lands", () => {
    expect(
      deriveJoinOutcome({ ...base, candidate: "cafe1234", stale_note: "leftover" }),
    ).toBe("clean");
  });
});

// ---------------------------------------------------------------------------
// Controller — real verb / draft singletons over a fake connection.
// ---------------------------------------------------------------------------

interface Sent {
  action: string;
  body: Record<string, unknown>;
}

const sent: Sent[] = [];
/** Every CONTROL handler the attached stores registered, so `reply` reaches them. */
const controlHandlers: ((payload: Uint8Array) => void)[] = [];

function fakeConnection(): never {
  return {
    onFrame: (_feed: number, cb: (payload: Uint8Array) => void) => {
      controlHandlers.push(cb);
      return () => {};
    },
    sendControlFrame: (action: string, body: Record<string, unknown>) => {
      sent.push({ action, body });
    },
  } as never;
}

/** Deliver a server frame to the attached stores, the way the verb suites do. */
function reply(body: Record<string, unknown>): void {
  const payload = new TextEncoder().encode(JSON.stringify(body));
  for (const handler of [...controlHandlers]) handler(payload);
}

const DASH_ENTRY: DashChangesetEntry = {
  kind: "dash",
  owner_id: "tugdash/join-lane#1",
  display_name: "join-lane",
  base: "main",
  rounds: 2,
  worktree: ".tug/worktrees/join-lane",
  worktree_dirty: false,
  files: [],
  draft: {
    fingerprint: "abc123",
    message: "the maintained join message",
    updated_at: 0,
    edited: false,
  },
  join: CLEAN_JOIN,
};

/**
 * The card's binding path and the workspace's canonical key, deliberately
 * spelled differently — the shape the 2026-08-18 deadlock was made of. Nothing
 * in the join pipeline may key on the raw one ([L29]).
 */
const RAW_DIR = "/Users/dev/Mounts/u/src/tugtool";
const WORKSPACE_KEY = "/u/src/tugtool";

function fakeChangesController(
  join: DashJoinStateWire | undefined = CLEAN_JOIN,
): ChangesRouteController & { _setJoin: (next: DashJoinStateWire | undefined) => void } {
  let notify: (() => void) | null = null;
  let entry: DashChangesetEntry = { ...DASH_ENTRY, join };
  const controller = {
    entryKey: "session:s1",
    projectDir: RAW_DIR,
    workspaceKey: WORKSPACE_KEY,
    tugSessionId: "s1",
    subscribe: (listener: () => void) => {
      notify = listener;
      return () => {
        notify = null;
      };
    },
    getSnapshot: () => ({
      entry: null,
      dashes: [entry],
      unattributed: [],
      orphaned: [],
      project: { project_dir: RAW_DIR, workspace_key: WORKSPACE_KEY },
      committedPaths: new Set<string>(),
    }),
    commit: () => {},
    requestDraft: () => {},
    /** Test hook: fire the subscription without changing anything. */
    _notify: () => notify?.(),
    /** Test hook: republish the dash with a different server-owned join state. */
    _setJoin: (next: DashJoinStateWire | undefined): void => {
      entry = { ...DASH_ENTRY, join: next };
      notify?.();
    },
  };
  return controller as unknown as ChangesRouteController & {
    _setJoin: (next: DashJoinStateWire | undefined) => void;
  };
}

function fakeCodeSessionStore(canInterrupt: boolean): CodeSessionStore & {
  _setTurn: (running: boolean) => void;
} {
  let running = canInterrupt;
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => ({ canInterrupt: running }),
    /** Test hook: start or end a turn between two presses. */
    _setTurn: (next: boolean): void => {
      running = next;
    },
  };
  return store as unknown as CodeSessionStore & { _setTurn: (running: boolean) => void };
}

function fakeCommitMode(): CommitModeController & { exits: number } {
  const stub = {
    exits: 0,
    exit(): void {
      stub.exits += 1;
    },
  };
  return stub as unknown as CommitModeController & { exits: number };
}

const TARGET: JoinTarget = joinTargetFromEntry(DASH_ENTRY);

beforeEach(() => {
  sent.length = 0;
  controlHandlers.length = 0;
  _resetChangesetDraftStoreForTest();
  _resetChangesetVerbStoreForTest();
  _resetChangesetJoinStoreForTest();
  attachChangesetVerbStore(fakeConnection());
  attachChangesetDraftStore(fakeConnection());
  // Attached like the other two because the controller now speaks to it on
  // entry ([P03]) — a clean dash resolves itself so the join rides a candidate.
  attachChangesetJoinStore(fakeConnection());
});

afterEach(() => {
  _resetChangesetDraftStoreForTest();
  _resetChangesetVerbStoreForTest();
  _resetChangesetJoinStoreForTest();
});

describe("JoinModeController", () => {
  function build(canInterrupt = false) {
    const commitMode = fakeCommitMode();
    const changesController = fakeChangesController();
    const codeSessionStore = fakeCodeSessionStore(canInterrupt);
    const controller = new JoinModeController({
      changesController,
      codeSessionStore,
      commitModeController: commitMode,
    });
    return { controller, commitMode, changesController, codeSessionStore };
  }

  it("enter seeds an edited dash draft and exits commit mode", () => {
    const { controller, commitMode } = build();
    controller.enter(TARGET, "a seeded join message");

    expect(controller.getSnapshot().active).toBe(true);
    expect(controller.getSnapshot().seedMessage).toBe("a seeded join message");
    expect(controller.getSnapshot().dash?.name).toBe("join-lane");
    expect(commitMode.exits).toBe(1);

    const draft = sent.find((s) => s.action === "changeset_draft_set");
    expect(draft?.body).toMatchObject({
      owner_kind: "dash",
      owner_id: DASH_ENTRY.owner_id,
      message: "a seeded join message",
      edited: true,
    });
    controller.dispose();
  });

  it("enter asks the server nothing — the feed already answered", () => {
    // Entering used to fire a `--preview`, which is what made the surface's
    // answer a round trip that could come back after the face had moved on.
    const { controller } = build();
    controller.enter(TARGET);
    expect(sent.filter((s) => s.action === "changeset_join")).toHaveLength(0);
    expect(controller.getSnapshot().outcome).toBe("clean");
    controller.dispose();
  });

  it("enter resolves a clean dash, so the join rides a candidate", () => {
    // The one thing entry *does* ask for ([P03]). A clean dash used to join on
    // the strength of git finding no overlapping text, which is not the same
    // claim as the result building; the resolve is what anchors a candidate for
    // the checks to judge.
    const { controller, changesController } = build();
    changesController._setJoin(UNVERIFIED_CLEAN);
    controller.enter(TARGET);
    const resolves = sent.filter((s) => s.action === "changeset_join_resolve");
    expect(resolves).toHaveLength(1);
    expect(resolves[0]?.body).toMatchObject({
      project_dir: WORKSPACE_KEY,
      dash: "join-lane",
    });
    controller.dispose();
  });

  it("leaves a dash that already has a candidate, a live run, or conflicts", () => {
    const { controller, changesController } = build();

    // Already judged, or already being judged: re-resolving would throw away a
    // verdict and start the whole ladder again.
    changesController._setJoin({ phase: "previewed", candidate: "cafe1234" });
    controller.enter(TARGET);
    expect(sent.filter((s) => s.action === "changeset_join_resolve")).toHaveLength(0);
    controller.exit();

    changesController._setJoin({ phase: "previewed", run: "resolve" });
    controller.enter(TARGET);
    expect(sent.filter((s) => s.action === "changeset_join_resolve")).toHaveLength(0);
    controller.exit();

    // A conflicted dash keeps its Resolve control: the press is the user's
    // acknowledgement that an agent is about to reconcile their divergence.
    changesController._setJoin({ phase: "previewed", conflicts: ["a.ts"] });
    controller.enter(TARGET);
    expect(sent.filter((s) => s.action === "changeset_join_resolve")).toHaveLength(0);
    controller.dispose();
  });

  it("aim costs nothing either — opening a row is not a question", () => {
    const { controller } = build();
    controller.aim(TARGET);
    expect(sent.filter((s) => s.action === "changeset_join")).toHaveLength(0);
    expect(controller.getSnapshot().active).toBe(false);
    controller.dispose();
  });

  it("derives every landing state from the feed's join block", () => {
    const { controller, changesController } = build();
    controller.enter(TARGET);
    expect(controller.getSnapshot().canLandIgnoringMessage).toBe(true);

    changesController._setJoin({
      phase: "blocked",
      blockers: [{ kind: "base-dirt", detail: "commit outstanding changes", paths: ["x.ts"] }],
    });
    expect(controller.getSnapshot().outcome).toBe("blocked");
    expect(controller.getSnapshot().landBlockedReason).toBe(
      "Clear what blocks this join first",
    );

    changesController._setJoin({ phase: "conflicted", conflicts: ["a.rs"] });
    expect(controller.getSnapshot().outcome).toBe("conflicted");
    expect(controller.getSnapshot().landBlockedReason).toBe("Resolve the conflicts first");

    changesController._setJoin({
      phase: "resolved",
      candidate: "cafe1234",
      resolved: [{ path: "a.rs", resolved_by: "driver" }],
    });
    expect(controller.getSnapshot().outcome).toBe("clean");
    expect(controller.getSnapshot().landBlockedReason).toBe(
      "Building the joined tree",
    );

    changesController._setJoin({
      phase: "resolved",
      candidate: "cafe1234",
      resolved: [{ path: "a.rs", resolved_by: "driver" }],
      verification: {
        tier0: "green",
        tier1: "green",
        base_sha: "base0000",
        candidate_sha: "cafe1234",
      },
    });
    expect(controller.getSnapshot().canLandIgnoringMessage).toBe(true);
    controller.dispose();
  });

  it("carries the server's stale sentence into the composer's refusal", () => {
    const { controller, changesController } = build();
    controller.enter(TARGET);
    changesController._setJoin({
      phase: "previewed",
      stale_note: "main moved since this was resolved — resolve again",
    });
    expect(controller.getSnapshot().outcome).toBe("stale");
    expect(controller.getSnapshot().landBlockedReason).toBe(
      "main moved since this was resolved — resolve again",
    );
    const outcome = controller.land("land it");
    expect(outcome).toEqual({
      kind: "refused",
      sentence: "main moved since this was resolved — resolve again",
    });
    controller.dispose();
  });

  it("addresses the land by workspace key, never by the card's binding path", () => {
    // The 2026-08-18 deadlock in one assertion: the card is bound with a raw
    // spelling of a directory whose canonical key reads differently, and every
    // address on the join path has to be the canonical one ([L29]).
    const { controller } = build();
    controller.enter(TARGET);
    controller.land("land it");
    const land = sent.find((s) => s.action === "changeset_join" && s.body.preview === false);
    expect(land?.body.project_dir).toBe(WORKSPACE_KEY);
    expect(land?.body.project_dir).not.toBe(RAW_DIR);
    controller.dispose();
  });

  it("opens on the dash's maintained draft when nothing was seeded", () => {
    const { controller } = build();
    controller.enter(TARGET);
    expect(controller.getSnapshot().persistedMessage).toBe("the maintained join message");
    expect(controller.getSnapshot().seedMessage).toBe(null);
    // Nothing was typed, so nothing was written.
    expect(sent.some((s) => s.action === "changeset_draft_set")).toBe(false);
    controller.dispose();
  });

  it("keeps the snapshot referentially stable across an unrelated notification", () => {
    const { controller, changesController } = build();
    controller.enter(TARGET);
    const before = controller.getSnapshot();
    (changesController as unknown as { _notify: () => void })._notify();
    expect(controller.getSnapshot()).toBe(before);
    controller.dispose();
  });

  it("a refused land speaks its reason and sends nothing ([L31])", () => {
    // Mid-turn: the gate's first reason. Nothing goes on the wire, and the
    // press produces a sentence rather than the silence that made the
    // dead-button incident unreproducible for days.
    const { controller } = build(true);
    controller.enter(TARGET);
    sent.length = 0;
    const outcome = controller.land("land it");
    expect(outcome).toEqual({ kind: "refused", sentence: "Wait for the turn to finish" });
    expect(sent.filter((s) => s.action === "changeset_join")).toHaveLength(0);
    const snapshot = controller.getSnapshot();
    expect(snapshot.active).toBe(true);
    expect(snapshot.landRefusal).toEqual({
      sentence: "Wait for the turn to finish",
      kind: "gate",
      seq: 1,
    });
    controller.dispose();
  });

  it("a second refused press speaks again, with a fresh seq", () => {
    // The two sentences are word for word identical; only `seq` distinguishes
    // them, which is what lets a notice surface re-post for the second press.
    const { controller } = build(true);
    controller.enter(TARGET);
    let fires = 0;
    controller.subscribe(() => {
      fires += 1;
    });
    controller.land("land it");
    const first = controller.getSnapshot().landRefusal;
    controller.land("land it");
    const second = controller.getSnapshot().landRefusal;
    expect(first?.seq).toBe(1);
    expect(second?.seq).toBe(2);
    expect(second?.sentence).toBe(first?.sentence);
    expect(fires).toBe(2);
    controller.dispose();
  });

  it("exiting the mode drops the published refusal", () => {
    const { controller } = build(true);
    controller.enter(TARGET);
    controller.land("land it");
    expect(controller.getSnapshot().landRefusal).not.toBe(null);
    controller.exit();
    expect(controller.getSnapshot().landRefusal).toBe(null);
    controller.dispose();
  });

  it("an accepted land clears a refusal the same press answered", () => {
    // Refuse once mid-turn, then land over a clean preview: the stale sentence
    // must not outlive the press that answered it.
    const { controller, codeSessionStore } = build();
    controller.enter(TARGET);
    codeSessionStore._setTurn(true);
    controller.land("land it");
    expect(controller.getSnapshot().landRefusal?.seq).toBe(1);

    codeSessionStore._setTurn(false);
    const outcome = controller.land("land it");
    expect(outcome).toEqual({ kind: "fired" });
    expect(controller.getSnapshot().landRefusal).toBe(null);
    expect(sent.some((s) => s.action === "changeset_join" && s.body.preview === false)).toBe(
      true,
    );
    controller.dispose();
  });

  it("the staged re-check refuses out loud and re-enters the mode ([L31])", () => {
    // The staged path fires a beat after the shade dismissed the mode. A
    // refusal there used to re-enter the mode and say nothing at all — the
    // exact shape that made the dead Join press unreadable.
    const { controller, codeSessionStore } = build();
    controller.enter(TARGET);
    let staged: (() => void) | null = null;
    controller.setLandHook((run) => {
      staged = run;
      controller.exit();
    });
    const outcome = controller.land("land it");
    expect(outcome).toEqual({ kind: "staged" });
    expect(controller.getSnapshot().active).toBe(false);

    // A turn starts between the press and the beat.
    codeSessionStore._setTurn(true);
    (staged as unknown as () => void)();
    const snapshot = controller.getSnapshot();
    expect(snapshot.active).toBe(true);
    expect(snapshot.landRefusal?.kind).toBe("gate");
    expect(snapshot.landRefusal?.sentence).toBe("Wait for the turn to finish");
    controller.dispose();
  });

  it("a staged land still reaches the wire after the host exits the mode", () => {
    // The host stages a landing by exiting the mode, and exiting clears the
    // target. A staged join that re-read `this.target` on the later beat found
    // null and returned — the press produced no frame, no error, and no trace,
    // which is the dead-Join-button failure exactly.
    const { controller } = build();
    controller.enter(TARGET);
    let staged: (() => void) | null = null;
    controller.setLandHook((run) => {
      staged = run;
      controller.exit();
    });
    controller.land("land it");
    sent.length = 0;
    (staged as unknown as () => void)();

    const lands = sent.filter((s) => s.action === "changeset_join" && s.body.preview === false);
    expect(lands).toHaveLength(1);
    expect(lands[0]?.body).toMatchObject({ dash: "join-lane", message: "land it" });
    expect(controller.getSnapshot().landRefusal).toBe(null);
    controller.dispose();
  });

  it("a missing changes service is a spoken fault, not a no-op ([L31])", () => {
    const { controller } = build();
    controller.enter(TARGET);
    let staged: (() => void) | null = null;
    controller.setLandHook((run) => {
      staged = run;
    });
    controller.land("land it");
    _resetChangesetVerbStoreForTest();
    (staged as unknown as () => void)();
    expect(controller.getSnapshot().landRefusal).toEqual({
      sentence: CHANGES_SERVICE_DISCONNECTED,
      kind: "fault",
      seq: 1,
    });
    controller.dispose();
  });

  it("exit clears the target and the seed", () => {
    const { controller } = build();
    controller.enter(TARGET, "seed");
    controller.exit();
    const snapshot = controller.getSnapshot();
    expect(snapshot.active).toBe(false);
    expect(snapshot.dash).toBe(null);
    expect(snapshot.seedMessage).toBe(null);
    controller.dispose();
  });

  it("dispose releases every subscription ([L27])", () => {
    const { controller, changesController } = build();
    let fires = 0;
    controller.subscribe(() => {
      fires += 1;
    });
    controller.dispose();
    (changesController as unknown as { _notify: () => void })._notify();
    expect(fires).toBe(0);
  });
});

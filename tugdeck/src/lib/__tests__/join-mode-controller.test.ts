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
  _ingestJoinFrameForTest,
  _resetChangesetJoinStoreForTest,
  attachChangesetJoinStore,
  getChangesetJoinStore,
} from "@/lib/changeset-join-store";
import { CHANGES_SERVICE_DISCONNECTED } from "@/lib/landing-mode";
import type { ChangesRouteController } from "@/lib/changes-route-controller";
import type { CodeSessionStore } from "@/lib/code-session-store";
import type { Message } from "@/lib/code-session-store/types";
import type { CommitModeController } from "@/lib/commit-mode-controller";
import type { DashChangesetEntry, DashJoinStateWire } from "@/lib/changeset-types";

/**
 * A dash whose merge is clean and whose candidate stands — the state a join
 * may actually proceed from.
 *
 * The candidate is not decoration. Every join rides one ([P03]): entering join
 * mode on a clean dash reconciles it, and the gate reads the outcome that
 * produces. A bare `{ phase: "previewed" }` is the window before the candidate
 * anchors — see {@link UNRECONCILED_CLEAN}.
 */
const CLEAN_JOIN: DashJoinStateWire = {
  phase: "previewed",
  candidate: "cafe1234",
};

/** Clean, and nothing reconciled yet — the auto-resolve window. */
const UNRECONCILED_CLEAN: DashJoinStateWire = { phase: "previewed" };

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


describe("evaluateJoinGate", () => {
  const base = {
    turnInProgress: false,
    holderBusy: false,
    joinPhase: "idle" as const,
    outcome: "clean" as const,
    candidateCommit: null,
    message: "land it",
  };

  it("passes over a clean merge with a message", () => {
    expect(evaluateJoinGate(base)).toEqual({ ok: true });
  });

  it("refuses while the dash's own session is still working", () => {
    expect(evaluateJoinGate({ ...base, holderBusy: true })).toEqual({
      ok: false,
      reason: "holder",
    });
  });

  it("names the dash, not the turn, when the holder is busy", () => {
    expect(joinDisabledReason("holder", "clean")).toBe("Wait for the dash to finish its work");
  });

  it("puts the holder above the round trip and the outcome", () => {
    // A blocked, mid-flight join on a busy dash still reports the holder: the
    // work is not finished, so nothing downstream of it is worth saying yet.
    expect(
      evaluateJoinGate({
        ...base,
        holderBusy: true,
        joinPhase: "pending",
        outcome: "blocked",
      }),
    ).toEqual({ ok: false, reason: "holder" });
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

  it("asks nothing about a build — a standing candidate is the whole gate", () => {
    // What stood here refused an unverified candidate and let a red through to
    // a confirm. Both are gone: the run's ending verified the tree that lands,
    // so a reconcile-clean dash joins on the press.
    expect(
      evaluateJoinGate({ ...base, outcome: "clean", candidateCommit: "cafe1234" }),
    ).toEqual({ ok: true });
  });

  it("refuses a candidate the base still blocks — resolving is not committing", () => {
    // The ladder resolves conflicts. It does not commit the base's outstanding
    // changes, so a candidate must not clear a blocker that names them: ranked
    // the other way the badge read `clean` over its own "commit outstanding
    // changes" line, and the gate believed the badge.
    const outcome = deriveJoinOutcome({
      phase: "blocked",
      conflicts: ["a.rs"],
      blockers: [{ kind: "base-dirt", title: "Base work in the way", detail: "commit outstanding changes", paths: ["x.ts"] }],
      candidate: "cafe1234",
    });
    expect(outcome).toBe("blocked");
    expect(evaluateJoinGate({ ...base, outcome, candidateCommit: "cafe1234" })).toEqual({
      ok: false,
      reason: "outcome",
    });
  });

  it("fails on the outcome before the message — nothing to join outranks a blank draft", () => {
    expect(
      evaluateJoinGate({ ...base, outcome: "blocked", message: "" }),
    ).toEqual({ ok: false, reason: "outcome" });
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
  const blocker = (kind: string) => ({
    kind,
    title: `${kind} title`,
    detail: `${kind} detail`,
    paths: [],
  });

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
  _landJoinReceipt: (exchangeId: string) => void;
} {
  let running = canInterrupt;
  // The controller reads the transcript to find the durable `/dash-join` row a
  // landed join writes, so the fake carries a real one rather than a stub —
  // the rows below are the shape the reducer builds from the wire.
  const messages: Message[] = [];
  const listeners = new Set<() => void>();
  const store = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => ({
      canInterrupt: running,
      transcript: [{ messages }],
      activeTurn: null,
    }),
    /** Test hook: start or end a turn between two presses. */
    _setTurn: (next: boolean): void => {
      running = next;
    },
    /** Test hook: append the settled `/dash-join` row a landed join writes. */
    _landJoinReceipt: (exchangeId: string): void => {
      messages.push({
        kind: "shell_exchange",
        exchangeId,
        command: "/dash-join join-lane",
        output: "joined abc1234 · join-lane → main · 2 round(s)\nsubject",
        exitCode: 0,
        cwd: RAW_DIR,
        cwdAfter: RAW_DIR,
        startedAtMs: 1,
        settledAtMs: 2,
      } as unknown as Message);
      for (const listener of [...listeners]) listener();
    },
  };
  return store as unknown as CodeSessionStore & {
    _setTurn: (running: boolean) => void;
    _landJoinReceipt: (exchangeId: string) => void;
  };
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

  it("narrates a join the server started, without entering the mode", () => {
    // The prompt-sheet route. There is nothing to compose and no press to
    // make — the work is under way — so entering the mode would put the
    // composer into a landing editor over a join already running. All the
    // narration buys is that the register resolves and carries the beats.
    const { controller } = build();
    controller.narrateServerJoin(TARGET);

    expect(controller.getSnapshot().active).toBe(false);
    expect(controller.getSnapshot().narrating).toBe(true);
    // And it asks the server for nothing: the join is the server's already.
    expect(sent.filter((s) => s.action === "changeset_join")).toHaveLength(0);

    // What the narration buys: the register resolves, so the beats streaming
    // in from the server's own join reach the composer's status row. Without
    // it there is no target to derive a register from and the beats render
    // nowhere on this card.
    _ingestJoinFrameForTest({
      action: "changeset_join_land_delta",
      project_dir: WORKSPACE_KEY,
      dash: "join-lane",
      beat: "squash",
      status: "start",
    });
    expect(controller.getSnapshot().register?.line).toBe(
      "Joining join-lane into main — squashing",
    );
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
    changesController._setJoin(UNRECONCILED_CLEAN);
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
      blockers: [{ kind: "base-dirt", title: "Base work in the way", detail: "commit outstanding changes", paths: ["x.ts"] }],
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

  it("the press narrates itself, before the server has heard about it", () => {
    // The gap this closes: the staged press exits the mode, which clears the
    // register's first-choice target, and the narration used to be aimed only
    // once `performJoin` ran a beat later. Between the two the register either
    // did not mount or fell through to "Ready to join" — a green resting
    // sentence over a running join ([L31]).
    const { controller } = build();
    controller.enter(TARGET);
    controller.setLandHook(() => {
      controller.exit();
    });
    controller.land("land it");

    const snapshot = controller.getSnapshot();
    expect(snapshot.active).toBe(false);
    expect(snapshot.register).toMatchObject({
      phase: "in_flight",
      line: "Joining join-lane into main — starting",
      word: "joining",
    });
    // Keyed by the workspace key the wire echoes, never the card's raw
    // binding path ([L29]) — the beat and the frames must meet in one cell.
    expect(getChangesetJoinStore()?.landProgress(WORKSPACE_KEY, "join-lane")).toEqual({
      beat: "requested",
      status: "start",
    });
    expect(getChangesetJoinStore()?.landProgress(RAW_DIR, "join-lane")).toBeNull();
    controller.dispose();
  });

  it("the server's front beat takes over the press's placeholder", () => {
    const { controller } = build();
    controller.enter(TARGET);
    let staged: (() => void) | null = null;
    controller.setLandHook((run) => {
      staged = run;
      controller.exit();
    });
    controller.land("land it");
    (staged as unknown as () => void)();

    _ingestJoinFrameForTest({
      action: "changeset_join_land_delta",
      project_dir: WORKSPACE_KEY,
      dash: "join-lane",
      beat: "preflight",
      status: "start",
    });
    expect(controller.getSnapshot().register?.line).toBe(
      "Joining join-lane into main — checking the base",
    );
    controller.dispose();
  });

  it("a refused staged press unsays what it announced", () => {
    // The press writes its own first beat, so a press refused on the live
    // re-check has to take it back. A register reporting a join nobody is
    // running is the same resting lie pointed the other way.
    const { controller, codeSessionStore } = build();
    controller.enter(TARGET);
    let staged: (() => void) | null = null;
    controller.setLandHook((run) => {
      staged = run;
      controller.exit();
    });
    controller.land("land it");
    expect(controller.getSnapshot().register?.phase).toBe("in_flight");

    codeSessionStore._setTurn(true);
    (staged as unknown as () => void)();

    expect(getChangesetJoinStore()?.landProgress(WORKSPACE_KEY, "join-lane")).toBeNull();
    expect(controller.getSnapshot().register?.word).not.toBe("joining");
    controller.dispose();
  });

  it("the join's receipt takes the live sentence down with it", () => {
    // The 2026-08-29 report: two identical "Joined tripwire-rename into main"
    // rows at the moment a join went through. One is the durable receipt's own
    // settled register, the other the live narration resting out its timer —
    // and for that window the transcript said the same thing twice. The
    // receipt is what the narration was narrating toward, so its arrival is
    // what retires the live copy, not the clock.
    const { controller, codeSessionStore } = build();
    controller.enter(TARGET);
    let staged: (() => void) | null = null;
    controller.setLandHook((run) => {
      staged = run;
      controller.exit();
    });
    controller.land("land it");
    (staged as unknown as () => void)();

    _ingestJoinFrameForTest({
      action: "changeset_join_ok",
      project_dir: WORKSPACE_KEY,
      dash: "join-lane",
      summary: "joined abc1234 · join-lane → main · 2 round(s)",
    });
    // The settled sentence stands while it is the only one there is.
    expect(controller.getSnapshot().register?.word).toBe("joined");

    codeSessionStore._landJoinReceipt("exch-1");
    expect(controller.getSnapshot().register).toBe(null);
    controller.dispose();
  });

  it("a receipt already in the transcript is not this join's", () => {
    // The mark is taken at the press, so an earlier join's row — a dash
    // recreated under the same name, joined twice in one session — cannot
    // retire the narration of the join now running.
    const { controller, codeSessionStore } = build();
    codeSessionStore._landJoinReceipt("exch-old");

    controller.enter(TARGET);
    let staged: (() => void) | null = null;
    controller.setLandHook((run) => {
      staged = run;
      controller.exit();
    });
    controller.land("land it");
    (staged as unknown as () => void)();

    _ingestJoinFrameForTest({
      action: "changeset_join_ok",
      project_dir: WORKSPACE_KEY,
      dash: "join-lane",
      summary: "joined abc1234 · join-lane → main · 2 round(s)",
    });
    expect(controller.getSnapshot().register?.word).toBe("joined");
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

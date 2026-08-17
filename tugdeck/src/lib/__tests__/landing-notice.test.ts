/**
 * landing-notice — what a landing surface says, and when it says it again.
 *
 * The decision is driven here over real snapshots produced by the real
 * `JoinModeController` running against the real verb and draft singletons on a
 * fake connection: the server's `changeset_join_err` arrives as an actual
 * CONTROL frame, and the refusals come from actual refused presses. What is
 * deliberately not here is the React controller that applies these actions to
 * the bulletin api — bun has no DOM substrate, so its on-screen behavior is
 * pinned in the app-test corpus instead.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { JoinModeController, joinTargetFromEntry } from "@/lib/join-mode-controller";
import {
  NO_LANDING_NOTICE,
  landingNoticeDecision,
  landingNoticeIds,
} from "@/lib/landing-notice";
import type { LandingNoticeState } from "@/lib/landing-notice";
import {
  _resetChangesetDraftStoreForTest,
  attachChangesetDraftStore,
} from "@/lib/changeset-draft-store";
import {
  _resetChangesetVerbStoreForTest,
  attachChangesetVerbStore,
  getChangesetVerbStore,
} from "@/lib/changeset-verb-store";
import { _resetChangesetJoinStoreForTest } from "@/lib/changeset-join-store";
import type { ChangesRouteController } from "@/lib/changes-route-controller";
import type { CodeSessionStore } from "@/lib/code-session-store";
import type { CommitModeController } from "@/lib/commit-mode-controller";
import type { DashChangesetEntry } from "@/lib/changeset-types";

const ENTRY_KEY = "session:s1";
const PROJECT = "/p";

const DASH_ENTRY: DashChangesetEntry = {
  kind: "dash",
  owner_id: "tugdash/notice-lane#1",
  display_name: "notice-lane",
  base: "main",
  rounds: 2,
  worktree: ".tug/worktrees/notice-lane",
  worktree_dirty: false,
  files: [],
  draft: { fingerprint: "abc", message: "a join message", updated_at: 0, edited: false },
};

const controlHandlers: ((payload: Uint8Array) => void)[] = [];

function fakeConnection(): never {
  return {
    onFrame: (_feed: number, cb: (payload: Uint8Array) => void) => {
      controlHandlers.push(cb);
      return () => {};
    },
    sendControlFrame: () => {},
  } as never;
}

function reply(body: Record<string, unknown>): void {
  const payload = new TextEncoder().encode(JSON.stringify(body));
  for (const handler of [...controlHandlers]) handler(payload);
}

let turnRunning = false;

function buildController(): JoinModeController {
  const changesController = {
    entryKey: ENTRY_KEY,
    projectDir: PROJECT,
    workspaceKey: PROJECT,
    tugSessionId: "s1",
    subscribe: () => () => {},
    getSnapshot: () => ({
      entry: null,
      dashes: [DASH_ENTRY],
      unattributed: [],
      orphaned: [],
      project: { project_dir: PROJECT },
      committedPaths: new Set<string>(),
    }),
    commit: () => {},
    requestDraft: () => {},
  } as unknown as ChangesRouteController;

  return new JoinModeController({
    changesController,
    codeSessionStore: {
      subscribe: () => () => {},
      getSnapshot: () => ({ canInterrupt: turnRunning }),
    } as unknown as CodeSessionStore,
    commitModeController: { exit: () => {} } as unknown as CommitModeController,
  });
}

beforeEach(() => {
  controlHandlers.length = 0;
  turnRunning = false;
  _resetChangesetDraftStoreForTest();
  _resetChangesetVerbStoreForTest();
  _resetChangesetJoinStoreForTest();
  attachChangesetVerbStore(fakeConnection());
  attachChangesetDraftStore(fakeConnection());
});

afterEach(() => {
  _resetChangesetDraftStoreForTest();
  _resetChangesetVerbStoreForTest();
  _resetChangesetJoinStoreForTest();
});

describe("landingNoticeDecision", () => {
  it("gives each landing kind its own notice ids, so surfaces never collide", () => {
    expect(landingNoticeIds("commit")).toEqual({
      error: "commit-error",
      refusal: "commit-refusal",
    });
    expect(landingNoticeIds("join")).toEqual({ error: "join-error", refusal: "join-refusal" });
  });

  it("posts a server join failure and takes it down when it clears", () => {
    const controller = buildController();
    controller.enter(joinTargetFromEntry(DASH_ENTRY));

    // The real error path: the server refuses the join and the verb store
    // settles it into `landError`. Nothing read this for join before.
    reply({
      action: "changeset_join_err",
      project_dir: PROJECT,
      dash: "notice-lane",
      detail: "Cannot join: the worktree is dirty",
    });

    let posted: LandingNoticeState = NO_LANDING_NOTICE;
    const first = landingNoticeDecision("join", posted, controller.getSnapshot());
    posted = first.next;
    expect(first.actions).toEqual([
      {
        kind: "post",
        id: "join-error",
        tone: "danger",
        title: "Join failed",
        description: "Cannot join: the worktree is dirty",
      },
    ]);

    // A settled error re-read changes nothing — the notice is already up.
    const again = landingNoticeDecision("join", posted, controller.getSnapshot());
    expect(again.actions).toEqual([]);

    // The next attempt goes pending, which clears the error.
    getChangesetVerbStore()?.join(ENTRY_KEY, PROJECT, "notice-lane", { preview: true });
    const cleared = landingNoticeDecision("join", posted, controller.getSnapshot());
    expect(cleared.actions).toEqual([{ kind: "dismiss", id: "join-error" }]);
    controller.dispose();
  });

  it("speaks a refused press, and speaks again on the second press", () => {
    const controller = buildController();
    controller.enter(joinTargetFromEntry(DASH_ENTRY));
    turnRunning = true;

    controller.land("land it");
    let posted: LandingNoticeState = NO_LANDING_NOTICE;
    const first = landingNoticeDecision("join", posted, controller.getSnapshot());
    posted = first.next;
    expect(first.actions).toEqual([
      {
        kind: "post",
        id: "join-refusal",
        tone: "caution",
        title: "Join not sent",
        description: "Wait for the turn to finish",
      },
    ]);

    // Word for word the same sentence. Keyed on the sentence this would say
    // nothing, which is silence for a user who just pressed again.
    controller.land("land it");
    const second = landingNoticeDecision("join", posted, controller.getSnapshot());
    expect(second.actions).toHaveLength(1);
    expect(second.actions[0]).toMatchObject({ kind: "post", id: "join-refusal" });
    controller.dispose();
  });

  it("makes a fault sticky and a gate refusal transient", () => {
    const controller = buildController();
    controller.enter(joinTargetFromEntry(DASH_ENTRY));
    reply({
      action: "changeset_join_ok",
      project_dir: PROJECT,
      dash: "notice-lane",
      previewed: true,
      conflicts: [],
      commit_hash: null,
      blockers: [],
    });

    // Stage the land, then take the changes service away before it runs: the
    // app is broken, not the user, so the notice has to persist.
    let staged: (() => void) | null = null;
    controller.setLandHook((run) => {
      staged = run;
    });
    controller.land("land it");
    _resetChangesetVerbStoreForTest();
    (staged as unknown as () => void)();

    const decision = landingNoticeDecision("join", NO_LANDING_NOTICE, controller.getSnapshot());
    expect(decision.actions).toHaveLength(1);
    expect(decision.actions[0]).toMatchObject({ tone: "danger", title: "Join cannot run" });
    controller.dispose();
  });

  it("dismisses the refusal when the mode exits", () => {
    const controller = buildController();
    controller.enter(joinTargetFromEntry(DASH_ENTRY));
    turnRunning = true;
    controller.land("land it");
    const posted = landingNoticeDecision("join", NO_LANDING_NOTICE, controller.getSnapshot())
      .next;

    controller.exit();
    const decision = landingNoticeDecision("join", posted, controller.getSnapshot());
    expect(decision.actions).toEqual([{ kind: "dismiss", id: "join-refusal" }]);
    controller.dispose();
  });
});

describe("release errors reach a reader", () => {
  it("settles a changeset_release_err into the state the notice controller reads", () => {
    // The controller subscribes to exactly this; before it existed the detail
    // landed here and no surface in the app ever asked for it.
    getChangesetVerbStore()?.release(ENTRY_KEY, PROJECT, "notice-lane");
    reply({
      action: "changeset_release_err",
      project_dir: PROJECT,
      dash: "notice-lane",
      detail: "Cannot release: the worktree has uncommitted changes",
    });
    expect(getChangesetVerbStore()?.releaseState(ENTRY_KEY).error).toBe(
      "Cannot release: the worktree has uncommitted changes",
    );
  });
});

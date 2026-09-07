/**
 * landing-notice — what a landing surface says, and when it says it again.
 *
 * The words are driven here over real snapshots produced by the real
 * `JoinModeController` running against the real verb and draft singletons on a
 * fake connection: the server's `changeset_join_err` arrives as an actual
 * CONTROL frame, and the refusals come from actual refused presses. The cause
 * table is driven with the stderr git actually printed on 2026-09-05. What is
 * deliberately not here is the strip that renders the face — bun has no DOM
 * substrate, so its on-screen behavior is pinned in the app-test corpus.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { JoinModeController, joinTargetFromEntry } from "@/lib/join-mode-controller";
import {
  describeLandingFailure,
  landingNoticeFace,
} from "@/lib/landing-notice";
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
import type { ArcChangesetEntry } from "@/lib/changeset-types";
import type { LandingNoticeFace } from "@/lib/landing-notice";
import type { LandingSnapshot } from "@/lib/landing-mode";

const ENTRY_KEY = "session:s1";
const PROJECT = "/p";

const ARC_ENTRY: ArcChangesetEntry = {
  kind: "arc",
  owner_id: "tugarc/notice-lane#1",
  display_name: "notice-lane",
  base: "main",
  rounds: 2,
  worktree: ".tug/worktrees/notice-lane",
  worktree_dirty: false,
  files: [],
  draft: { fingerprint: "abc", message: "a join message", updated_at: 0, edited: false },
  // The server says this arc merges clean and carries a standing candidate,
  // which is what makes the land press below reach the wire rather than being
  // refused. Every join rides a candidate ([P03]), clean ones included.
  join: {
    phase: "previewed",
    candidate: "cafe1234",
  },
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
      arcs: [ARC_ENTRY],
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
      // An empty transcript with no turn in flight — this file is about the
      // notice, and no join here lands a receipt.
      getSnapshot: () => ({
        canInterrupt: turnRunning,
        transcript: [],
        activeTurn: null,
      }),
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


describe("discard errors reach a reader", () => {
  it("settles a changeset_discard_err into the state the notice controller reads", () => {
    // The controller subscribes to exactly this; before it existed the detail
    // landed here and no surface in the app ever asked for it.
    getChangesetVerbStore()?.discard(ENTRY_KEY, PROJECT, "notice-lane");
    reply({
      action: "changeset_discard_err",
      project_dir: PROJECT,
      arc: "notice-lane",
      detail: "Cannot discard: the worktree has uncommitted changes",
    });
    expect(getChangesetVerbStore()?.discardState(ENTRY_KEY).error).toBe(
      "Cannot discard: the worktree has uncommitted changes",
    );
  });
});

// The stderr git printed on 2026-09-05, verbatim — the failure this whole arc
// was reported against.
const INDEX_LOCK_STDERR = [
  "fatal: Unable to create '/u/src/tug/.git/index.lock': File exists.",
  "",
  "Another git process seems to be running in this repository, e.g.",
  "an editor opened by 'git commit'. Please make sure all processes",
  "are terminated then try again. If it still fails, a git process",
  "may have crashed in this repository earlier:",
  "remove the file manually to continue.",
].join("\n");

describe("describeLandingFailure", () => {
  it("names the lock, and keeps every word git said", () => {
    const said = describeLandingFailure("commit", INDEX_LOCK_STDERR);
    expect(said.title).toBe("Another git process is holding the repository lock");
    expect(said.remedy).toContain("remove the lock file");
    expect(said.remedy).toContain("your message is kept");
    // The evidence is never paraphrased away — it is folded, not dropped.
    expect(said.detail).toBe(INDEX_LOCK_STDERR);
  });

  it("names an unset identity", () => {
    const said = describeLandingFailure(
      "commit",
      '*** Please tell me who you are.\n\nRun\n\n  git config --global user.email "you@example.com"',
    );
    expect(said.title).toBe("Git doesn't know who you are yet");
    expect(said.remedy).toContain("git config");
  });

  it("names a refusing hook", () => {
    const said = describeLandingFailure(
      "commit",
      "pre-commit hook failed (exit code 1)\nlint: 3 errors",
    );
    expect(said.title).toBe("A commit hook refused the commit");
    expect(said.remedy).toContain("Read the hook's output below");
  });

  it("names an empty commit", () => {
    expect(describeLandingFailure("commit", "nothing to commit, working tree clean").title).toBe(
      "Nothing left to commit",
    );
    expect(describeLandingFailure("commit", 'no changes added to commit (use "git add")').title).toBe(
      "Nothing left to commit",
    );
  });

  it("names drifted hunks", () => {
    const said = describeLandingFailure("commit", "hunk drift: src/main.rs no longer matches");
    expect(said.title).toBe("The hunks you picked have moved");
    expect(said.remedy).toContain("pick the hunks again");
  });

  // Matching is over the whole detail and case-insensitive, so a row still
  // speaks when git shouts or buries the phrase on a later line.
  it("matches whatever line the phrase lands on, in whatever case", () => {
    expect(
      describeLandingFailure("commit", "error: could not commit\nNOTHING TO COMMIT, clean").title,
    ).toBe("Nothing left to commit");
  });

  it("falls back to git's first line, without the severity word", () => {
    const detail =
      "fatal: could not read Username for 'https://github.com'\nterminal prompts disabled";
    const said = describeLandingFailure("commit", detail);
    expect(said.title).toBe("could not read Username for 'https://github.com'");
    expect(said.remedy).toContain("Read git's message below");
    expect(said.detail).toBe(detail);
  });

  it("takes a join detail's first line, and folds nothing when that is all there was", () => {
    const single = describeLandingFailure("join", "Cannot join: the worktree is dirty");
    expect(single.title).toBe("Cannot join: the worktree is dirty");
    expect(single.remedy).toContain("Fix what it names");
    // Folding the detail here would show the same sentence twice.
    expect(single.detail).toBeNull();

    const many = describeLandingFailure("join", "Cannot join: 2 conflicts\nsrc/a.rs\nsrc/b.rs");
    expect(many.title).toBe("Cannot join: 2 conflicts");
    expect(many.detail).toBe("Cannot join: 2 conflicts\nsrc/a.rs\nsrc/b.rs");
  });
});

describe("landingNoticeFace", () => {
  it("carries a server join failure as a retryable danger notice", () => {
    const controller = buildController();
    controller.enter(joinTargetFromEntry(ARC_ENTRY));

    controller.land("land it");
    reply({
      action: "changeset_join_err",
      project_dir: PROJECT,
      arc: "notice-lane",
      detail: "Cannot join: the worktree is dirty",
    });

    const face = landingNoticeFace("join", controller.getSnapshot());
    expect(face.refusal).toBeNull();
    expect(face.error).toEqual({
      key: "Cannot join: the worktree is dirty",
      channel: "error",
      tone: "danger",
      title: "Cannot join: the worktree is dirty",
      remedy: "Fix what it names and try again — your message is kept.",
      detail: null,
      retry: true,
    });

    // The next attempt goes pending, which empties the channel.
    getChangesetVerbStore()?.join(ENTRY_KEY, PROJECT, "notice-lane", { preview: false });
    expect(landingNoticeFace("join", controller.getSnapshot()).error).toBeNull();
    controller.dispose();
  });

  it("keys a refusal on seq, so a second identical press is a second notice", () => {
    const controller = buildController();
    controller.enter(joinTargetFromEntry(ARC_ENTRY));
    turnRunning = true;

    controller.land("land it");
    expect(landingNoticeFace("join", controller.getSnapshot()).refusal).toEqual({
      key: "1",
      channel: "refusal",
      tone: "caution",
      title: "Join not sent",
      remedy: "Wait for the turn to finish",
      detail: null,
      retry: false,
    });

    // Word for word the same sentence. Keyed on the sentence this would be the
    // same notice, which is silence for a user who just pressed again.
    controller.land("land it");
    expect(landingNoticeFace("join", controller.getSnapshot()).refusal?.key).toBe("2");
    controller.dispose();
  });

  it("tells a fault from a gate refusal by tone and word", () => {
    const controller = buildController();
    controller.enter(joinTargetFromEntry(ARC_ENTRY));

    // Stage the land, then take the changes service away before it runs: the
    // app is broken, not the user, so the notice reads as a fault.
    let staged: (() => void) | null = null;
    controller.setLandHook((run) => {
      staged = run;
    });
    controller.land("land it");
    _resetChangesetVerbStoreForTest();
    (staged as unknown as () => void)();

    const refusal = landingNoticeFace("join", controller.getSnapshot()).refusal;
    expect(refusal).toMatchObject({ tone: "danger", title: "Join cannot run", retry: false });
    controller.dispose();
  });

  it("empties the refusal channel when the mode exits", () => {
    const controller = buildController();
    controller.enter(joinTargetFromEntry(ARC_ENTRY));
    turnRunning = true;
    controller.land("land it");
    expect(landingNoticeFace("join", controller.getSnapshot()).refusal).not.toBeNull();

    controller.exit();
    expect(landingNoticeFace("join", controller.getSnapshot()).refusal).toBeNull();
    controller.dispose();
  });

  it("empties the channel between two identical failures, which is what dismiss rides on", () => {
    // The strip clears a dismissal when its channel goes null ([P02]), so the
    // same failure twice must not read as one uninterrupted notice — otherwise
    // a user who dismissed the first would never see the second. The strip's
    // own button is app-test territory; the null in the middle is the fact it
    // rides on, and it is testable here.
    const controller = buildController();
    getChangesetVerbStore()?.commit(ENTRY_KEY, PROJECT, ["src/a.rs"], "a message");
    reply({ action: "changeset_commit_err", project_dir: PROJECT, detail: INDEX_LOCK_STDERR });

    const faceNow = (): LandingNoticeFace =>
      landingNoticeFace("commit", {
        ...controller.getSnapshot(),
        landError: getChangesetVerbStore()?.commitState(ENTRY_KEY).error ?? null,
        landRefusal: null,
      });

    expect(faceNow().error).not.toBeNull();

    // The retry goes pending, which empties the channel…
    getChangesetVerbStore()?.commit(ENTRY_KEY, PROJECT, ["src/a.rs"], "a message");
    expect(faceNow().error).toBeNull();

    // …and the identical failure settles as a notice again.
    reply({ action: "changeset_commit_err", project_dir: PROJECT, detail: INDEX_LOCK_STDERR });
    expect(faceNow().error?.key).toBe(INDEX_LOCK_STDERR);
    controller.dispose();
  });

  it("reads a real changeset_commit_err into the lock notice", () => {
    // The commit side of the same path: the verb store settles git's stderr for
    // the entry key, and that string is what the commit mode publishes as
    // `landError`. Only `landError` and `landRefusal` are read here, so the
    // snapshot is built over a real one rather than through a second controller.
    const controller = buildController();
    getChangesetVerbStore()?.commit(ENTRY_KEY, PROJECT, ["src/a.rs"], "a message");
    reply({
      action: "changeset_commit_err",
      project_dir: PROJECT,
      detail: INDEX_LOCK_STDERR,
    });

    const settled = getChangesetVerbStore()?.commitState(ENTRY_KEY).error ?? null;
    expect(settled).toBe(INDEX_LOCK_STDERR);

    const snapshot: LandingSnapshot = {
      ...controller.getSnapshot(),
      landError: settled,
      landRefusal: null,
    };
    const face = landingNoticeFace("commit", snapshot);
    expect(face.error).toMatchObject({
      key: INDEX_LOCK_STDERR,
      tone: "danger",
      title: "Another git process is holding the repository lock",
      detail: INDEX_LOCK_STDERR,
      retry: true,
    });
    controller.dispose();
  });
});

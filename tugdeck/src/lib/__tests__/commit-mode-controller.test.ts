import { beforeEach, describe, expect, it } from "bun:test";

import {
  CommitModeController,
  evaluateCommitLandGate,
} from "@/lib/commit-mode-controller";
import { CHANGES_SERVICE_DISCONNECTED } from "@/lib/landing-mode";
import { _resetChangesetDraftStoreForTest } from "@/lib/changeset-draft-store";
import { _resetChangesetVerbStoreForTest } from "@/lib/changeset-verb-store";
import type { ChangesRouteController } from "@/lib/changes-route-controller";
import type { CodeSessionStore } from "@/lib/code-session-store";

// Detach the app-level verb / draft singletons so this suite runs hermetically
// regardless of order — another test file may have attached them to a mock
// connection whose `setDraft` frame would throw inside `enter()`.
beforeEach(() => {
  _resetChangesetDraftStoreForTest();
  _resetChangesetVerbStoreForTest();
});

describe("evaluateCommitLandGate", () => {
  const base = {
    turnInProgress: false,
    commitPhase: "idle" as const,
    message: "fix",
    fileCount: 2,
  };

  it("passes when idle, not pending, changeset and message non-empty", () => {
    expect(evaluateCommitLandGate(base)).toEqual({ ok: true });
  });

  it("fails first on a running turn, before every other reason", () => {
    expect(
      evaluateCommitLandGate({
        turnInProgress: true,
        commitPhase: "pending",
        message: "",
        fileCount: 0,
      }),
    ).toEqual({ ok: false, reason: "turn" });
  });

  it("fails on a pending commit before the changeset / message checks", () => {
    expect(
      evaluateCommitLandGate({ ...base, commitPhase: "pending", message: "", fileCount: 0 }),
    ).toEqual({ ok: false, reason: "pending" });
  });

  it("fails on an empty changeset before the message check", () => {
    expect(
      evaluateCommitLandGate({ ...base, fileCount: 0, message: "" }),
    ).toEqual({ ok: false, reason: "empty-changeset" });
  });

  it("fails on an empty (whitespace) message when everything else is ready", () => {
    expect(evaluateCommitLandGate({ ...base, message: "   " })).toEqual({
      ok: false,
      reason: "empty-message",
    });
  });
});

// ---------------------------------------------------------------------------
// Minimal fakes — the controller only reads `subscribe` / `getSnapshot` /
// identity fields off these; the verb + draft singletons are absent in tests
// (the controller's derivation tolerates null).
// ---------------------------------------------------------------------------

function fakeChangesController(
  fileCount: number,
  claimable?: { unattributed?: number; orphaned?: number },
): ChangesRouteController {
  const mk = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => ({ path: `${tag}${i}` }));
  return {
    entryKey: "session:s1",
    projectDir: "/p",
    tugSessionId: "s1",
    subscribe: () => () => {},
    getSnapshot: () => ({
      entry: null,
      dashes: [],
      unattributed: mk(claimable?.unattributed ?? 0, "u"),
      orphaned: mk(claimable?.orphaned ?? 0, "o"),
      project: { project_dir: "/p" },
      committedPaths: new Set(Array.from({ length: fileCount }, (_, i) => `f${i}`)),
    }),
    commit: () => {},
    requestDraft: () => {},
  } as unknown as ChangesRouteController;
}

function fakeCodeSessionStore(canInterrupt: boolean): CodeSessionStore {
  return {
    subscribe: () => () => {},
    getSnapshot: () => ({ canInterrupt }),
  } as unknown as CodeSessionStore;
}

describe("CommitModeController", () => {
  it("enter / exit toggles the active flag and fires listeners", () => {
    const controller = new CommitModeController({
      changesController: fakeChangesController(2),
      codeSessionStore: fakeCodeSessionStore(false),
    });
    let fires = 0;
    controller.subscribe(() => {
      fires += 1;
    });

    expect(controller.getSnapshot().active).toBe(false);
    controller.enter("fix the thing");
    expect(controller.getSnapshot().active).toBe(true);
    expect(controller.getSnapshot().seedMessage).toBe("fix the thing");
    controller.exit();
    expect(controller.getSnapshot().active).toBe(false);
    expect(controller.getSnapshot().seedMessage).toBe(null);
    expect(fires).toBeGreaterThanOrEqual(2);
    controller.dispose();
  });

  it("reports canLandIgnoringMessage off the turn + changeset state", () => {
    const idle = new CommitModeController({
      changesController: fakeChangesController(2),
      codeSessionStore: fakeCodeSessionStore(false),
    });
    expect(idle.getSnapshot().canLandIgnoringMessage).toBe(true);
    expect(idle.getSnapshot().fileCount).toBe(2);
    idle.dispose();

    const midTurn = new CommitModeController({
      changesController: fakeChangesController(2),
      codeSessionStore: fakeCodeSessionStore(true),
    });
    expect(midTurn.getSnapshot().canLandIgnoringMessage).toBe(false);
    midTurn.dispose();

    const empty = new CommitModeController({
      changesController: fakeChangesController(0),
      codeSessionStore: fakeCodeSessionStore(false),
    });
    expect(empty.getSnapshot().canLandIgnoringMessage).toBe(false);
    expect(empty.getSnapshot().fileCount).toBe(0);
    expect(empty.getSnapshot().claimableCount).toBe(0);
    empty.dispose();
  });

  it("a refused land speaks its reason and reports it by type ([L31])", () => {
    const controller = new CommitModeController({
      changesController: fakeChangesController(2),
      codeSessionStore: fakeCodeSessionStore(true),
    });
    controller.enter();
    const outcome = controller.land("fix the thing");
    expect(outcome).toEqual({ kind: "refused", sentence: "Wait for the turn to finish" });
    expect(controller.getSnapshot().landRefusal).toEqual({
      sentence: "Wait for the turn to finish",
      kind: "gate",
      seq: 1,
    });
    expect(controller.getSnapshot().active).toBe(true);
    controller.dispose();
  });

  it("an empty message refuses with the sentence that names the fix", () => {
    const controller = new CommitModeController({
      changesController: fakeChangesController(2),
      codeSessionStore: fakeCodeSessionStore(false),
    });
    controller.enter();
    expect(controller.land("   ")).toEqual({
      kind: "refused",
      sentence: "Write a commit message",
    });
    controller.dispose();
  });

  it("a second refused press speaks again, with a fresh seq", () => {
    const controller = new CommitModeController({
      changesController: fakeChangesController(0),
      codeSessionStore: fakeCodeSessionStore(false),
    });
    controller.enter();
    controller.land("fix the thing");
    controller.land("fix the thing");
    expect(controller.getSnapshot().landRefusal?.seq).toBe(2);
    expect(controller.getSnapshot().landRefusal?.sentence).toBe(
      "Nothing to commit — this session has claimed no changes",
    );
    controller.dispose();
  });

  it("exiting the mode drops the published refusal", () => {
    const controller = new CommitModeController({
      changesController: fakeChangesController(0),
      codeSessionStore: fakeCodeSessionStore(false),
    });
    controller.enter();
    controller.land("fix the thing");
    expect(controller.getSnapshot().landRefusal).not.toBe(null);
    controller.exit();
    expect(controller.getSnapshot().landRefusal).toBe(null);
    controller.dispose();
  });

  it("a missing changes service is a spoken fault, not a no-op ([P04], [L31])", () => {
    // No verb store is attached in these tests, so the commit goes out with
    // nothing to settle its round trip. That used to be a bare `return`, which
    // left the mode waiting on a phase that could never arrive.
    const controller = new CommitModeController({
      changesController: fakeChangesController(2),
      codeSessionStore: fakeCodeSessionStore(false),
    });
    controller.enter();
    expect(controller.land("fix the thing")).toEqual({ kind: "fired" });
    expect(controller.getSnapshot().landRefusal).toEqual({
      sentence: CHANGES_SERVICE_DISCONNECTED,
      kind: "fault",
      seq: 1,
    });
    controller.dispose();
  });

  it("sums unattributed + orphaned into claimableCount — the chip's pointer", () => {
    const controller = new CommitModeController({
      changesController: fakeChangesController(0, { unattributed: 2, orphaned: 3 }),
      codeSessionStore: fakeCodeSessionStore(false),
    });
    // Nothing attributed, but five claimable files — commit mode points at them.
    expect(controller.getSnapshot().fileCount).toBe(0);
    expect(controller.getSnapshot().claimableCount).toBe(5);
    controller.dispose();
  });
});

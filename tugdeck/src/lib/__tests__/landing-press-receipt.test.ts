/**
 * landing-press-receipt — the durable record a land press leaves behind.
 *
 * Three facts. Every press sends exactly one receipt whichever way it went, so
 * the log answers "was the button pressed?" and not only "did a join run?".
 * The receipt carries the message's length and never its text. And the send can
 * neither refuse nor throw: a diagnostic that could break the landing it
 * describes would be worse than no diagnostic at all.
 *
 * Driven through the real `CommitModeController`, so what is asserted is the
 * frame an actual press produces rather than a hand-built payload.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { _resetChangesetDraftStoreForTest } from "@/lib/changeset-draft-store";
import { _resetChangesetVerbStoreForTest } from "@/lib/changeset-verb-store";
import type { ChangesRouteController } from "@/lib/changes-route-controller";
import type { CodeSessionStore } from "@/lib/code-session-store";
import type { TugConnection } from "@/connection";

interface Sent {
  action: string;
  body: Record<string, unknown>;
}

let sent: Sent[] = [];

// The singleton is mocked rather than driven through `setConnection` because
// pinning `getConnection` to a local is deterministic regardless of file order —
// what `git-log-store.test.ts` does for the same reason. `setConnection` is the
// REAL setter, frozen before the mock lands, so this process-wide mock cannot
// swallow another suite's call to it. [B10]
import { setConnection as _realSetConnection } from "@/lib/connection-singleton";
const realSetConnection = _realSetConnection;
let activeConnection: TugConnection | null = null;
mock.module("@/lib/connection-singleton", () => ({
  getConnection: () => activeConnection,
  setConnection: realSetConnection,
}));

// Imported after the mock so the receipt sender binds to it.
const { CommitModeController } = await import("@/lib/commit-mode-controller");

function recordingConnection(): TugConnection {
  return {
    sendControlFrame: (action: string, body: Record<string, unknown>) => {
      sent.push({ action, body });
    },
  } as unknown as TugConnection;
}

function throwingConnection(): TugConnection {
  return {
    sendControlFrame: () => {
      throw new Error("transport closed");
    },
  } as unknown as TugConnection;
}

function changesController(fileCount: number): ChangesRouteController {
  return {
    entryKey: "session:s1",
    projectDir: "/p",
    workspaceKey: "/p",
    tugSessionId: "s1",
    subscribe: () => () => {},
    getSnapshot: () => ({
      entry: null,
      arcs: [],
      unattributed: [],
      orphaned: [],
      project: { project_dir: "/p" },
      committedPaths: new Set(Array.from({ length: fileCount }, (_, i) => `f${i}`)),
    }),
    commit: () => {},
    requestDraft: () => {},
  } as unknown as ChangesRouteController;
}

function codeSessionStore(canInterrupt: boolean): CodeSessionStore {
  return {
    subscribe: () => () => {},
    getSnapshot: () => ({ canInterrupt }),
  } as unknown as CodeSessionStore;
}

function build(fileCount: number, canInterrupt = false) {
  return new CommitModeController({
    changesController: changesController(fileCount),
    codeSessionStore: codeSessionStore(canInterrupt),
  });
}

function receipts(): Sent[] {
  return sent.filter((s) => s.action === "landing_receipt");
}

beforeEach(() => {
  sent = [];
  _resetChangesetDraftStoreForTest();
  _resetChangesetVerbStoreForTest();
  activeConnection = recordingConnection();
});

afterEach(() => {
  _resetChangesetDraftStoreForTest();
  _resetChangesetVerbStoreForTest();
  // The module mock outlives this file, so the connection it hands out must
  // not: a later suite testing its own no-transport path would otherwise be
  // handed this file's fake and fail on a method it never stubbed.
  activeConnection = null;
});

describe("sendLandingReceipt", () => {
  it("writes a refused press down with its reason and the gate it judged", () => {
    const controller = build(2, true);
    controller.enter();
    controller.land("fix the thing");

    expect(receipts()).toHaveLength(1);
    expect(receipts()[0]?.body).toMatchObject({
      kind: "commit",
      verdict: "refused",
      reason: "turn",
      sentence: "Wait for the turn to finish",
    });
    expect(receipts()[0]?.body.gate).toMatchObject({
      turnInProgress: true,
      commitPhase: "idle",
      fileCount: 2,
    });
    controller.dispose();
  });

  it("writes an accepted press down too — the log answers 'was it pressed?'", () => {
    // The 2026-08-17 hunt could see joins that ran and nothing else. A receipt
    // only for failures would leave the same blind spot one step over.
    const controller = build(2);
    controller.enter();
    controller.land("fix the thing");

    const ok = receipts().filter((r) => r.body.verdict === "ok");
    expect(ok).toHaveLength(1);
    expect(ok[0]?.body.reason).toBeUndefined();
    controller.dispose();
  });

  it("carries the message's length and never its words", () => {
    const controller = build(2, true);
    controller.enter();
    controller.land("a private draft nobody put in a log");

    const gate = receipts()[0]?.body.gate as Record<string, unknown>;
    expect(gate.messageLen).toBe("a private draft nobody put in a log".length);
    expect(JSON.stringify(receipts()[0]?.body)).not.toContain("private draft");
    controller.dispose();
  });

  it("a transport that throws does not take the refusal with it", () => {
    activeConnection = throwingConnection();
    const controller = build(2, true);
    controller.enter();
    // The press still produces its verdict and its published sentence.
    expect(controller.land("fix the thing")).toEqual({
      kind: "refused",
      sentence: "Wait for the turn to finish",
    });
    expect(controller.getSnapshot().landRefusal?.seq).toBe(1);
    controller.dispose();
  });
});

// tugcode/src/__tests__/rewind.test.ts
//
// `Rewind` driven directly through a fake `RewindHost`: the verbs' gates,
// the preview that answers from the JSONL alone, the conversation rewind's
// ordering (subprocess down before any write, then the respawn the manager
// owns), and the in-place rollback when that respawn fails. The control
// round-trips through `SessionManager` stay in `rewind-bridge.test.ts`.

import { describe, expect, test } from "bun:test";

import { ActiveTurn } from "../active-turn.ts";
import { ClaudeHome } from "../claude-home.ts";
import type { ClaudeSubprocess } from "../claude-process.ts";
import { drainPendingWrites } from "../ipc.ts";
import type { JsonlReadResult } from "../journal.ts";
import { Rewind, type RewindHost } from "../rewind.ts";
import type { OutboundMessage } from "../types.ts";

/** Capture every frame written to IPC stdout while `fn` runs. */
async function captureIpc(fn: () => Promise<void>): Promise<OutboundMessage[]> {
  const captured: OutboundMessage[] = [];
  const originalWrite = Bun.write;
  const decoder = new TextDecoder();
  (Bun as unknown as { write: unknown }).write = (dest: unknown, data: unknown) => {
    if (dest === Bun.stdout) {
      const text =
        typeof data === "string" ? data : data instanceof Uint8Array ? decoder.decode(data) : "";
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (t.length > 0) captured.push(JSON.parse(t) as OutboundMessage);
      }
    }
    return Promise.resolve(
      data instanceof Uint8Array ? data.length : (data as string).length,
    );
  };
  try {
    await fn();
    await drainPendingWrites();
  } finally {
    (Bun as unknown as { write: typeof originalWrite }).write = originalWrite;
  }
  return captured;
}

const PROMPT_1 = "prompt-one-uuid";
const PROMPT_2 = "prompt-two-uuid";

/** Two committed turns; rewinding to the second keeps the first. */
const SESSION_JSONL =
  [
    { type: "user", uuid: PROMPT_1, parentUuid: null, message: { role: "user", content: [{ type: "text", text: "first" }] } },
    { type: "assistant", uuid: "asst-1", parentUuid: PROMPT_1, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    { type: "user", uuid: PROMPT_2, parentUuid: "asst-1", message: { role: "user", content: [{ type: "text", text: "second" }] } },
    { type: "assistant", uuid: "asst-2", parentUuid: PROMPT_2, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n";

interface Recorder {
  calls: string[];
  stdin: string[];
  writes: Map<string, string>;
}

function fakeHost(opts: {
  jsonl?: string;
  child?: boolean;
  activeTurn?: ActiveTurn | null;
  respawnInPlaceThrows?: boolean;
}): RewindHost & Recorder {
  const stdin: string[] = [];
  const child = {
    stdin: { write: (data: unknown) => stdin.push(String(data)), flush: () => {} },
  } as unknown as ClaudeSubprocess;
  const host: RewindHost & Recorder = {
    calls: [],
    stdin,
    writes: new Map(),
    sessionId: () => "rewind-session",
    resumeSessionId: () => null,
    projectDir: () => "/tmp/rewind-test-project-does-not-exist",
    claudeHome: () => ClaudeHome.at("/tmp/rewind-test-fixtures"),
    readJsonl: async (): Promise<JsonlReadResult> =>
      opts.jsonl === undefined
        ? { kind: "missing", message: "no such file" }
        : { kind: "ok", jsonl: opts.jsonl },
    writeJsonl: async (path, content) => {
      host.calls.push("write");
      host.writes.set(path, content);
    },
    claudeProcess: () => (opts.child === false ? null : child),
    activeTurn: () => opts.activeTurn ?? null,
    killAndCleanup: async () => {
      host.calls.push("kill");
    },
    respawnIntoRewindFork: async (newId) => {
      host.calls.push(`fork:${newId}`);
    },
    respawnRewoundInPlace: async (liveId) => {
      host.calls.push(`in-place:${liveId}`);
      if (opts.respawnInPlaceThrows === true) throw new Error("spawn failed");
    },
  };
  return host;
}

describe("Rewind gates", () => {
  test("a preview with no claude process answers non-rewindable", async () => {
    const rewind = new Rewind(fakeHost({ child: false }));
    const emitted = await captureIpc(() => rewind.handleRewindPreview({ type: "rewind_preview", promptUuid: PROMPT_2 }));
    expect(emitted).toEqual([
      expect.objectContaining({ type: "rewind_preview_result", promptUuid: PROMPT_2, canRewind: false, error: "No active claude process." }),
    ]);
  });

  test("a rewind while a turn is open is refused as busy", async () => {
    const rewind = new Rewind(fakeHost({ jsonl: SESSION_JSONL, activeTurn: new ActiveTurn(0, []) }));
    const emitted = await captureIpc(() =>
      rewind.handleSessionRewind({ type: "session_rewind", promptUuid: PROMPT_2, scope: "conversation" }),
    );
    expect(emitted).toEqual([
      expect.objectContaining({ type: "rewind_result", canRewind: false, error: "Claude is busy; rewind requires an idle session." }),
    ]);
  });
});

describe("Rewind preview", () => {
  test("an anchor the JSONL cannot rewind to answers without asking claude", async () => {
    const host = fakeHost({ jsonl: SESSION_JSONL });
    const rewind = new Rewind(host);
    const emitted = await captureIpc(() =>
      rewind.handleRewindPreview({ type: "rewind_preview", promptUuid: "unknown-uuid" }),
    );
    expect(emitted).toEqual([
      expect.objectContaining({ type: "rewind_preview_result", canRewind: false, conversationRewindable: false }),
    ]);
    expect(host.stdin).toEqual([]);
    expect(rewind.hasPendingRequests()).toBe(false);
  });

  test("a rewindable anchor sends a dry-run rewind_files and correlates its response", async () => {
    const host = fakeHost({ jsonl: SESSION_JSONL });
    const rewind = new Rewind(host);
    const emitted = await captureIpc(async () => {
      await rewind.handleRewindPreview({ type: "rewind_preview", promptUuid: PROMPT_2 });
      expect(host.stdin.length).toBe(1);
      const sent = JSON.parse(host.stdin[0]!) as { request_id: string; request: Record<string, unknown> };
      expect(sent.request).toEqual({ subtype: "rewind_files", user_message_id: PROMPT_2, dry_run: true });
      expect(rewind.hasPendingRequests()).toBe(true);
      const handled = rewind.tryHandleRewindControlResponse({
        type: "control_response",
        response: { request_id: sent.request_id, response: { canRewind: true, filesChanged: ["a.ts"], insertions: 3, deletions: 1 } },
      });
      expect(handled).toBe(true);
    });
    expect(emitted).toEqual([
      expect.objectContaining({
        type: "rewind_preview_result",
        promptUuid: PROMPT_2,
        canRewind: true,
        filesChanged: ["a.ts"],
        insertions: 3,
        deletions: 1,
        conversationRewindable: true,
      }),
    ]);
    expect(rewind.hasPendingRequests()).toBe(false);
  });
});

describe("Rewind conversation", () => {
  test("a fork takes the subprocess down, writes the truncated history under a new id, then asks for the respawn", async () => {
    const host = fakeHost({ jsonl: SESSION_JSONL });
    const rewind = new Rewind(host);
    const emitted = await captureIpc(() =>
      rewind.handleSessionRewind({ type: "session_rewind", promptUuid: PROMPT_2, scope: "conversation" }),
    );

    const result = emitted.find((m) => m.type === "rewind_result") as { canRewind: boolean; newSessionId?: string };
    expect(result.canRewind).toBe(true);
    const newId = result.newSessionId!;
    expect(host.calls).toEqual(["kill", "write", `fork:${newId}`]);
    const [forkPath, forkContent] = [...host.writes.entries()][0]!;
    expect(forkPath.endsWith(`${newId}.jsonl`)).toBe(true);
    expect(forkContent).toContain(PROMPT_1);
    expect(forkContent).not.toContain(PROMPT_2);
    const segment = emitted.find((m) => m.type === "session_segment");
    expect(segment).toEqual(
      expect.objectContaining({ kind: "rewind", parentSessionId: "rewind-session", newSessionId: newId, forkPoint: PROMPT_2 }),
    );
  });

  test("an in-place rewind whose respawn fails puts the original bytes back", async () => {
    const host = fakeHost({ jsonl: SESSION_JSONL, respawnInPlaceThrows: true });
    const rewind = new Rewind(host);
    const emitted = await captureIpc(() =>
      rewind.handleSessionRewind({ type: "session_rewind", promptUuid: PROMPT_2, scope: "conversation", fork: false }),
    );

    expect(host.calls).toEqual(["kill", "write", "in-place:rewind-session", "write"]);
    expect([...host.writes.values()]).toEqual([SESSION_JSONL]);
    expect(emitted).toEqual([
      expect.objectContaining({ type: "rewind_result", canRewind: false, error: "Respawn after rewind failed (spawn failed)." }),
    ]);
  });
});

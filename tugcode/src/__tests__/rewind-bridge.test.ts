// `rewind_files` control-request bridge ([#step-7-1]).
//
// Covers the three tugcode-unit obligations of the sub-step: the
// `/rewind` anchor capture (`promptUuid` from the live user-echo), the
// control-request send + `control_response` correlation (reusing the
// `initialize` turn-free interception pattern), and the inbound→outbound
// IPC mapping (`rewind_preview` → `rewind_files{dry_run:true}` →
// `rewind_preview_result`; `session_rewind{scope:"code"}` →
// `rewind_files{dry_run:false}` → `rewind_result`). The round-trip
// against real claude is the probe in
// `tugrust/crates/tugcast/tests/common/probes.rs`.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ActiveTurn,
  SessionManager,
  routeTopLevelEvent,
  computeConversationTruncation,
} from "../session.ts";
import type { EventMappingContext, JsonlReadResult } from "../session.ts";
import { respondingProcess } from "./responding-process.ts";

// Capture writeLine() output (it routes through Bun.write(Bun.stdout)).
// Mirrors session.test.ts's helper.
async function captureIpcOutput(fn: () => void | Promise<void>): Promise<any[]> {
  const captured: any[] = [];
  const originalWrite = Bun.write;
  const decoder = new TextDecoder();
  (Bun as any).write = (dest: unknown, data: unknown) => {
    let text: string | null = null;
    if (dest === Bun.stdout && typeof data === "string") text = data;
    else if (dest === Bun.stdout && data instanceof Uint8Array)
      text = decoder.decode(data);
    if (text !== null) {
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          try {
            captured.push(JSON.parse(trimmed));
          } catch {
            // ignore non-JSON lines
          }
        }
      }
    }
    return Promise.resolve(
      data instanceof Uint8Array ? data.length : (data as string).length,
    );
  };
  try {
    await fn();
    const { drainPendingWrites } = await import("../ipc.ts");
    await drainPendingWrites();
  } finally {
    (Bun as any).write = originalWrite;
  }
  return captured;
}

// A mock claude subprocess whose stdin records every written line.
function mockProcessWithStdinSpy(): { manager: SessionManager; written: string[] } {
  const manager = new SessionManager(
    "/tmp/tugcode-rewind-" + Date.now() + "-" + Math.floor(performance.now()),
    crypto.randomUUID(),
  );
  const written: string[] = [];
  (manager as any).claudeProcess = {
    stdin: {
      write: (data: unknown) => written.push(String(data)),
      flush: () => {},
    },
  };
  return { manager, written };
}

const CTX: EventMappingContext = { msgId: "", openerId: "t-0", seq: 0, rev: 0 };

// A mock manager whose JSONL reader returns a fixed session log — for the
// conversation-rewindability ([#step-7-3]) preview checks.
function managerWithJsonl(jsonl: string): { manager: SessionManager; written: string[] } {
  const manager = new SessionManager(
    "/tmp/tugcode-rewind-" + Date.now() + "-" + Math.floor(performance.now()),
    crypto.randomUUID(),
    "new",
    undefined,
    { jsonlReader: async () => ({ kind: "ok" as const, jsonl }), sessionsDbPath: null },
  );
  const written: string[] = [];
  (manager as any).claudeProcess = {
    stdin: { write: (d: unknown) => written.push(String(d)), flush: () => {} },
  };
  return { manager, written };
}

describe("rewind anchor capture (promptUuid)", () => {
  test("a live user-submission echo surfaces promptUuid", () => {
    const result = routeTopLevelEvent(
      {
        type: "user",
        uuid: "dcec4c42-prompt-uuid",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
      CTX,
    );
    expect(result.promptUuid).toBe("dcec4c42-prompt-uuid");
  });

  test("a slash-command echo (string content) surfaces promptUuid", () => {
    const result = routeTopLevelEvent(
      {
        type: "user",
        uuid: "slash-prompt-uuid",
        message: { role: "user", content: "/rewind" },
      },
      CTX,
    );
    expect(result.promptUuid).toBe("slash-prompt-uuid");
  });

  test("a tool_result user event does NOT surface promptUuid", () => {
    const result = routeTopLevelEvent(
      {
        type: "user",
        uuid: "tool-result-uuid",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu-1", content: "ok" },
          ],
        },
      },
      CTX,
    );
    expect(result.promptUuid).toBeUndefined();
  });

  test("a user echo with no uuid surfaces nothing", () => {
    const result = routeTopLevelEvent(
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      CTX,
    );
    expect(result.promptUuid).toBeUndefined();
  });

  test("dispatch latches promptUuid onto the turn and emits prompt_anchor once", async () => {
    const { manager } = mockProcessWithStdinSpy();
    const turn = new ActiveTurn(0, [{ type: "text", text: "hello" }]);
    (manager as any).activeTurn = turn;

    const echo = JSON.stringify({
      type: "user",
      uuid: "live-anchor-uuid",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });

    const out = await captureIpcOutput(() => {
      (manager as any).handleClaudeLine(echo);
      // A second echo (e.g. claude re-emitting) must not double-fire.
      (manager as any).handleClaudeLine(echo);
    });

    const anchors = out.filter((m) => m.type === "prompt_anchor");
    expect(anchors.length).toBe(1);
    expect(anchors[0].promptUuid).toBe("live-anchor-uuid");
    expect(turn.promptUuid).toBe("live-anchor-uuid");
  });
});

describe("rewind_preview → rewind_files{dry_run:true}", () => {
  test("sends the control request and registers a pending preview", async () => {
    const { manager, written } = mockProcessWithStdinSpy();
    await manager.handleRewindPreview({
      type: "rewind_preview",
      promptUuid: "anchor-1",
    });
    expect(written.length).toBe(1);
    const sent = JSON.parse(written[0].replace(/\n$/, ""));
    expect(sent.type).toBe("control_request");
    expect(sent.request.subtype).toBe("rewind_files");
    expect(sent.request.user_message_id).toBe("anchor-1");
    expect(sent.request.dry_run).toBe(true);
    expect(typeof sent.request_id).toBe("string");
    expect((manager as any).pendingRewindRequests.size).toBe(1);
  });

  test("a matching control_response relays a rewind_preview_result", async () => {
    const { manager, written } = mockProcessWithStdinSpy();
    await manager.handleRewindPreview({
      type: "rewind_preview",
      promptUuid: "anchor-2",
    });
    const requestId = JSON.parse(written[0].replace(/\n$/, "")).request_id;

    const controlResponse = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: {
          canRewind: true,
          filesChanged: ["/repo/note.txt"],
          insertions: 0,
          deletions: 1,
        },
      },
    });

    const out = await captureIpcOutput(() => {
      (manager as any).handleClaudeLine(controlResponse);
    });

    const results = out.filter((m) => m.type === "rewind_preview_result");
    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject({
      promptUuid: "anchor-2",
      canRewind: true,
      filesChanged: ["/repo/note.txt"],
      insertions: 0,
      deletions: 1,
    });
    // Correlation consumed the pending entry.
    expect((manager as any).pendingRewindRequests.size).toBe(0);
  });

  test("a canRewind:false response relays the gating error", async () => {
    const { manager, written } = mockProcessWithStdinSpy();
    await manager.handleRewindPreview({
      type: "rewind_preview",
      promptUuid: "aged-out",
    });
    const requestId = JSON.parse(written[0].replace(/\n$/, "")).request_id;

    const out = await captureIpcOutput(() => {
      (manager as any).handleClaudeLine(
        JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId,
            response: {
              canRewind: false,
              error: "No file checkpoint found for this message.",
            },
          },
        }),
      );
    });

    const result = out.find((m) => m.type === "rewind_preview_result");
    expect(result.canRewind).toBe(false);
    expect(result.error).toContain("No file checkpoint found");
  });

  test("idle gating: a preview mid-turn is rejected without a control request", async () => {
    const { manager, written } = mockProcessWithStdinSpy();
    // An in-flight turn (not gotResult, not interrupted) ⇒ not idle.
    (manager as any).activeTurn = new ActiveTurn(0, []);

    const out = await captureIpcOutput(() => {
      manager.handleRewindPreview({
        type: "rewind_preview",
        promptUuid: "busy-anchor",
      });
    });

    expect(written.length).toBe(0);
    expect((manager as any).pendingRewindRequests.size).toBe(0);
    const result = out.find((m) => m.type === "rewind_preview_result");
    expect(result.canRewind).toBe(false);
    expect(result.error).toContain("busy");
  });
});

describe("rewind_preview conversationRewindable ([#step-7-3])", () => {
  // turn1 / turn2, then a /compact boundary + summary, then turn3.
  const u = (uuid: string, text: string) =>
    JSON.stringify({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text }] } });
  const a = (uuid: string) =>
    JSON.stringify({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
  const JSONL = [
    u("uuid-1", "one"),
    a("asst-1"),
    u("uuid-2", "two"),
    a("asst-2"),
    JSON.stringify({ type: "system", subtype: "compact_boundary" }),
    JSON.stringify({ type: "user", uuid: "sum", isCompactSummary: true, message: { role: "user", content: "summary" } }),
    u("uuid-3", "three"),
    a("asst-3"),
  ].join("\n") + "\n";

  async function previewResult(
    manager: SessionManager,
    written: string[],
    promptUuid: string,
  ): Promise<any> {
    written.length = 0;
    await manager.handleRewindPreview({ type: "rewind_preview", promptUuid });
    const reqId = JSON.parse(written[0].replace(/\n$/, "")).request_id;
    const out = await captureIpcOutput(() => {
      (manager as any).handleClaudeLine(
        JSON.stringify({
          type: "control_response",
          response: { subtype: "success", request_id: reqId, response: { canRewind: false } },
        }),
      );
    });
    return out.find((m) => m.type === "rewind_preview_result");
  }

  test("an anchor BEFORE a /compact boundary is not conversation-rewindable", async () => {
    const { manager, written } = managerWithJsonl(JSONL);
    // A non-rewindable anchor answers from the JSONL alone — no `rewind_files`
    // round-trip to claude — so the result rides back during the preview call
    // itself, with nothing written to claude's stdin.
    const out = await captureIpcOutput(() => {
      return manager.handleRewindPreview({ type: "rewind_preview", promptUuid: "uuid-2" });
    });
    expect(written.length).toBe(0);
    const r = out.find((m) => m.type === "rewind_preview_result");
    expect(r.conversationRewindable).toBe(false);
  });

  test("an anchor after the last /compact boundary is conversation-rewindable", async () => {
    const { manager, written } = managerWithJsonl(JSONL);
    const r = await previewResult(manager, written, "uuid-3");
    expect(r.conversationRewindable).toBe(true);
  });
});

describe("session_rewind code dimension → rewind_files{dry_run:false}", () => {
  test("scope:code sends an apply control request", () => {
    const { manager, written } = mockProcessWithStdinSpy();
    manager.handleSessionRewind({
      type: "session_rewind",
      promptUuid: "anchor-apply",
      scope: "code",
    });
    expect(written.length).toBe(1);
    const sent = JSON.parse(written[0].replace(/\n$/, ""));
    expect(sent.request.subtype).toBe("rewind_files");
    expect(sent.request.user_message_id).toBe("anchor-apply");
    expect(sent.request.dry_run).toBe(false);
  });

  test("scope:both sends the code apply FIRST (before the conversation leg)", () => {
    const { manager, written } = mockProcessWithStdinSpy();
    // Not awaited: with no control_response delivered, the code-restore
    // promise never resolves, so the conversation leg never starts — exactly
    // the ordering guarantee (code, then conversation). The one synchronous
    // write is the code `rewind_files{dry_run:false}`.
    void manager.handleSessionRewind({
      type: "session_rewind",
      promptUuid: "anchor-both",
      scope: "both",
    });
    expect(written.length).toBe(1);
    expect(JSON.parse(written[0].replace(/\n$/, "")).request.dry_run).toBe(false);
  });

  test("a matching control_response relays a rewind_result ack", async () => {
    const { manager, written } = mockProcessWithStdinSpy();
    manager.handleSessionRewind({
      type: "session_rewind",
      promptUuid: "anchor-ack",
      scope: "code",
    });
    const requestId = JSON.parse(written[0].replace(/\n$/, "")).request_id;

    const out = await captureIpcOutput(() => {
      (manager as any).handleClaudeLine(
        JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId,
            response: { canRewind: true },
          },
        }),
      );
    });

    const ack = out.find((m) => m.type === "rewind_result");
    expect(ack).toMatchObject({
      promptUuid: "anchor-ack",
      scope: "code",
      canRewind: true,
    });
  });

  test("scope:conversation issues NO rewind_files control request", async () => {
    const { manager, written } = mockProcessWithStdinSpy();
    await manager.handleSessionRewind({
      type: "session_rewind",
      promptUuid: "anchor-convo",
      scope: "conversation",
    });
    // The conversation dimension never touches the claude control channel;
    // it truncates the JSONL + respawns. (No JSONL here ⇒ it errors out, but
    // still without any control request.)
    expect(written.length).toBe(0);
    expect((manager as any).pendingRewindRequests.size).toBe(0);
  });

  test("idle gating: an apply mid-turn is rejected without a control request", async () => {
    const { manager, written } = mockProcessWithStdinSpy();
    (manager as any).activeTurn = new ActiveTurn(0, []);

    const out = await captureIpcOutput(() => {
      manager.handleSessionRewind({
        type: "session_rewind",
        promptUuid: "busy-apply",
        scope: "code",
      });
    });

    expect(written.length).toBe(0);
    const ack = out.find((m) => m.type === "rewind_result");
    expect(ack.canRewind).toBe(false);
    expect(ack.error).toContain("busy");
  });
});

// A realistic multi-turn session JSONL: conversational user/assistant
// records interleaved with the metadata records claude actually writes
// (queue-operation / attachment / file-history-snapshot / mode), none of
// which carry a usable anchor uuid. Mirrors the shape captured live in the
// [#step-7-2] experiment.
function buildSessionJsonl(): { jsonl: string; anchors: string[] } {
  const a1 = "uuid-prompt-alpha";
  const a2 = "uuid-prompt-beta";
  const a3 = "uuid-prompt-gamma";
  const lines = [
    { type: "queue-operation" },
    { type: "user", uuid: a1, parentUuid: null, message: { role: "user", content: [{ type: "text", text: "Remember ALPHA" }] } },
    { type: "attachment", uuid: "att-1", parentUuid: a1 },
    { type: "file-history-snapshot" },
    { type: "assistant", uuid: "asst-1", parentUuid: a1, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    { type: "ai-title" },
    { type: "user", uuid: a2, parentUuid: "asst-1", message: { role: "user", content: [{ type: "text", text: "Remember BETA" }] } },
    { type: "assistant", uuid: "asst-2", parentUuid: a2, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    { type: "mode" },
    { type: "user", uuid: a3, parentUuid: "asst-2", message: { role: "user", content: [{ type: "text", text: "Remember GAMMA" }] } },
    { type: "file-history-snapshot" },
  ];
  return { jsonl: lines.map((l) => JSON.stringify(l)).join("\n") + "\n", anchors: [a1, a2, a3] };
}

describe("computeConversationTruncation (pure boundary + compaction guard)", () => {
  test("boundary is the index of the anchor's user-prompt record", () => {
    const { jsonl, anchors } = buildSessionJsonl();
    const lines = jsonl.split("\n");
    // rewind to GAMMA (last turn): boundary excludes the GAMMA prompt record.
    const r = computeConversationTruncation(jsonl, anchors[2]);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(JSON.parse(lines[r.boundary]).uuid).toBe(anchors[2]);
    // The retained prefix keeps ALPHA + BETA, drops GAMMA.
    const kept = lines.slice(0, r.boundary).join("\n");
    expect(kept).toContain("Remember ALPHA");
    expect(kept).toContain("Remember BETA");
    expect(kept).not.toContain("Remember GAMMA");
  });

  test("rewinding to the FIRST turn is refused (would leave an unresumable empty session)", () => {
    const { jsonl, anchors } = buildSessionJsonl();
    // anchors[0] is the first user submission — slicing before it retains only
    // leading bookkeeping, which claude rejects on --resume. Guard it.
    expect(computeConversationTruncation(jsonl, anchors[0]).kind).toBe(
      "no_retained_turns",
    );
  });

  test("an unknown anchor is not_found", () => {
    const { jsonl } = buildSessionJsonl();
    expect(computeConversationTruncation(jsonl, "no-such-uuid").kind).toBe(
      "not_found",
    );
  });

  test("a tool_result user record is not a valid anchor", () => {
    const jsonl =
      JSON.stringify({
        type: "user",
        uuid: "tr-uuid",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      }) + "\n";
    expect(computeConversationTruncation(jsonl, "tr-uuid").kind).toBe(
      "not_found",
    );
  });

  test("a compact_boundary system record AFTER the anchor blocks the rewind", () => {
    const { jsonl, anchors } = buildSessionJsonl();
    // Splice a compaction between BETA and GAMMA, then rewind to BETA: the
    // chop range [BETA..tip] now crosses the compaction → refuse.
    const lines = jsonl.split("\n").filter((l) => l.trim());
    const idx = lines.findIndex((l) => l.includes('"mode"'));
    lines.splice(idx, 0, JSON.stringify({ type: "system", subtype: "compact_boundary" }));
    const spliced = lines.join("\n") + "\n";
    expect(computeConversationTruncation(spliced, anchors[1]).kind).toBe(
      "compaction_blocked",
    );
  });

  test("an isCompactSummary user record after the anchor blocks the rewind", () => {
    const { jsonl, anchors } = buildSessionJsonl();
    const lines = jsonl.split("\n").filter((l) => l.trim());
    const idx = lines.findIndex((l) => l.includes('"mode"'));
    lines.splice(idx, 0, JSON.stringify({ type: "user", uuid: "sum-1", isCompactSummary: true, message: { role: "user", content: "summary" } }));
    const spliced = lines.join("\n") + "\n";
    expect(computeConversationTruncation(spliced, anchors[1]).kind).toBe(
      "compaction_blocked",
    );
  });

  test("a compaction BEFORE the anchor does not block (stays in the kept prefix)", () => {
    const { jsonl, anchors } = buildSessionJsonl();
    const lines = jsonl.split("\n").filter((l) => l.trim());
    // Compaction between ALPHA and BETA; rewind to GAMMA → compaction is in
    // the retained prefix, not the chop range → allowed.
    const betaIdx = lines.findIndex((l) => l.includes(anchors[1]));
    lines.splice(betaIdx, 0, JSON.stringify({ type: "system", subtype: "compact_boundary" }));
    const spliced = lines.join("\n") + "\n";
    expect(computeConversationTruncation(spliced, anchors[2]).kind).toBe("ok");
  });
});

// The truncation path is destructive — it chops bytes off the real session
// file — and compaction re-appends make a uuid name several records. These
// run over a projection of a real re-appended session (the same fixture
// `replay-compact-reappend.test.ts` uses) rather than a built topology,
// because "which occurrence does the scan land on" is exactly the question.
describe("computeConversationTruncation against duplicate-uuid anchors", () => {
  const FIXTURE = new URL(
    "./fixtures/compact-reappend/chain-topology.jsonl",
    import.meta.url,
  ).pathname;
  const jsonl = readFileSync(FIXTURE, "utf8");
  const lines = jsonl.split("\n");

  // A user submission preserved by a compaction and re-appended verbatim:
  // the same uuid at line 31 (original) and 850 (the copy).
  const DUPLICATED_ANCHOR = "953bead5-4dfb-4dc0-8aa5-08c86810439c";
  // A submission after the file's last compaction — the ordinary live case.
  const LATE_ANCHOR = "b5e95347-27a5-4c61-9793-4f435981e690";

  const linesWithUuid = (uuid: string): number[] =>
    lines
      .map((line, i) => {
        if (line.trim().length === 0) return -1;
        return (JSON.parse(line) as { uuid?: unknown }).uuid === uuid ? i : -1;
      })
      .filter((i) => i >= 0);

  test("the fixture really does duplicate the anchor's uuid", () => {
    expect(linesWithUuid(DUPLICATED_ANCHOR)).toEqual([31, 850]);
    expect(linesWithUuid(LATE_ANCHOR).length).toBe(1);
  });

  test("a re-appended anchor is refused, never truncated at either occurrence", () => {
    // A duplicate exists only because a compaction preserved and re-appended
    // the record, so a compaction always sits between the first occurrence
    // and the tip. The guard refuses before the first-occurrence scan can
    // matter — which is what makes the destructive path safe.
    const result = computeConversationTruncation(jsonl, DUPLICATED_ANCHOR);
    expect(result.kind).toBe("compaction_blocked");
  });

  test("an anchor after the last compaction still resolves, duplicates earlier notwithstanding", () => {
    const result = computeConversationTruncation(jsonl, LATE_ANCHOR);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(JSON.parse(lines[result.boundary]).uuid).toBe(LATE_ANCHOR);
    // Everything the re-append duplicated stays in the retained prefix.
    expect(result.boundary).toBeGreaterThan(1195);
  });
});

// Build a manager wired for conversation-rewind integration tests: canned
// JSONL in, captured writes out, and the spawn/kill primitives stubbed so no
// real claude is launched and no real file is touched.
function convManager(
  jsonl: string | null,
  // How a respawn's subprocess behaves; defaults to one that answers its
  // handshake immediately (see `respondingProcess`).
  spawnStub: (manager: SessionManager) => unknown = respondingProcess,
) {
  const writes: { path: string; content: string }[] = [];
  const spawns: { id: string | null; mode: string }[] = [];
  let killCalls = 0;
  const manager = new SessionManager(
    "/tmp/tugcode-conv-" + Date.now() + "-" + Math.floor(performance.now()),
    crypto.randomUUID(),
    "resume",
    "live-claude-id",
    {
      jsonlReader: async (): Promise<JsonlReadResult> =>
        jsonl === null
          ? { kind: "missing", message: "no jsonl" }
          : { kind: "ok", jsonl },
      jsonlWriter: async (path: string, content: string) => {
        writes.push({ path, content });
      },
      sessionsDbPath: null,
    },
  );
  // A claude process must look present + idle for the guards.
  (manager as any).claudeProcess = { stdin: { write: () => {}, flush: () => {} } };
  (manager as any).spawnClaude = (id: string | null, mode: string) => {
    spawns.push({ id, mode });
    return spawnStub(manager);
  };
  (manager as any).startStdoutDrain = () => {};
  (manager as any).killAndCleanup = async () => {
    killCalls++;
    (manager as any).claudeProcess = null;
  };
  return { manager, writes, spawns, killCalls: () => killCalls };
}

describe("conversation rewind — the ack waits for the respawn to load", () => {
  // The `/rewind` sheet stays modal, running an indeterminate bar, from the
  // Rewind press until the ack lands. That is only honest if the ack means the
  // rewound session can answer — so the manager holds it until the respawn's
  // `initialize` handshake is acked, not merely until `spawnClaude` returns.
  test("no rewind_result until the respawned claude answers its handshake", async () => {
    const { jsonl, anchors } = buildSessionJsonl();
    // A spawn stub that holds the handshake open: it captures the reply and
    // sends it only when this test says so.
    let answer: (() => void) | null = null;
    const { manager, spawns } = convManager(jsonl, (mgr) => ({
      stdin: {
        write: (data: unknown) => {
          const request = JSON.parse(String(data).replace(/\n$/, ""));
          answer = (): void => {
            (mgr as any).handleClaudeLine(
              JSON.stringify({
                type: "control_response",
                response: {
                  subtype: "success",
                  request_id: request.request_id,
                  response: {},
                },
              }),
            );
          };
        },
        flush: () => {},
        end: () => {},
      },
      exited: new Promise<number>(() => {}),
    }));

    const out = await captureIpcOutput(async () => {
      let settled = false;
      const rewound = manager
        .handleSessionRewind({
          type: "session_rewind",
          promptUuid: anchors[1],
          scope: "conversation",
          fork: true,
        })
        .then(() => {
          settled = true;
        });

      // Give the chop + fork copy + respawn every chance to complete.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      // The process is up and was handshaked — and the rewind is still
      // waiting on the answer, so no ack has gone out.
      expect(spawns.length).toBe(1);
      expect(answer).not.toBeNull();
      expect(settled).toBe(false);

      answer!();
      await rewound;
      expect(settled).toBe(true);
    });

    // Answering releases the ack.
    const ack = out.find((m) => m.type === "rewind_result");
    expect(ack.canRewind).toBe(true);
  });
});

describe("conversation rewind — fork (default)", () => {
  test("forks: writes a truncated COPY under a new id, respawns it, acks newSessionId, leaves the original untouched", async () => {
    const { jsonl, anchors } = buildSessionJsonl();
    const { manager, writes, spawns } = convManager(jsonl);

    const out = await captureIpcOutput(async () => {
      await manager.handleSessionRewind({
        type: "session_rewind",
        promptUuid: anchors[1], // rewind to BETA
        scope: "conversation",
        fork: true,
      });
    });

    const ack = out.find((m) => m.type === "rewind_result");
    expect(ack.canRewind).toBe(true);
    expect(ack.scope).toBe("conversation");
    expect(typeof ack.newSessionId).toBe("string");
    expect(ack.newSessionId).not.toBe("live-claude-id");

    // Exactly one write — the fork copy — and it is NOT the live session's
    // path (the original is preserved).
    expect(writes.length).toBe(1);
    expect(writes[0].path).toContain(ack.newSessionId);
    expect(writes[0].path).not.toContain("live-claude-id");
    // The copy is truncated to before BETA: keeps ALPHA, drops BETA + GAMMA.
    expect(writes[0].content).toContain("Remember ALPHA");
    expect(writes[0].content).not.toContain("Remember BETA");
    expect(writes[0].content).not.toContain("Remember GAMMA");

    // Respawned --resume against the new fork id.
    expect(spawns).toEqual([{ id: ack.newSessionId, mode: "resume" }]);
    // resumeSessionId now points at the fork (so later respawns + cold-boot
    // follow the fork, not the original).
    expect((manager as any).resumeSessionId).toBe(ack.newSessionId);
  });

  test("silent respawn: no replay/transcript frames — only the ack and the synthetic session_init for the rebind", async () => {
    const { jsonl, anchors } = buildSessionJsonl();
    const { manager } = convManager(jsonl);

    const out = await captureIpcOutput(async () => {
      await manager.handleSessionRewind({
        type: "session_rewind",
        promptUuid: anchors[2],
        scope: "conversation",
        fork: true,
      });
    });

    // [L26] precondition: the respawn must not re-emit the transcript.
    const types = out.map((m) => m.type);
    expect(types).not.toContain("replay_started");
    expect(types).not.toContain("replay_complete");
    expect(types).not.toContain("add_user_message");
    expect(types).not.toContain("assistant_text");
    // The only frames are the rebind's session_init and the ack.
    const sessionInit = out.find((m) => m.type === "session_init");
    const ack = out.find((m) => m.type === "rewind_result");
    expect(sessionInit.session_id).toBe(ack.newSessionId);
  });

  test("announces the fork's parentage and branch point BEFORE the session_init that records it", async () => {
    const { jsonl, anchors } = buildSessionJsonl();
    const { manager } = convManager(jsonl);

    const out = await captureIpcOutput(async () => {
      await manager.handleSessionRewind({
        type: "session_rewind",
        promptUuid: anchors[1],
        scope: "conversation",
        fork: true,
      });
    });

    const ack = out.find((m) => m.type === "rewind_result");
    const announcement = out.find((m) => m.type === "session_fork");
    expect(announcement).toEqual({
      type: "session_fork",
      parentSessionId: "live-claude-id",
      newSessionId: ack.newSessionId,
      // The rewound-to prompt uuid IS the branch point: two forks taken
      // there share a lineage letter.
      forkPoint: anchors[1],
    });
    // Ordering is the contract — tugcast stages the allocated lineage on the
    // announcement and consumes it on the init that follows.
    const types = out.map((m) => m.type);
    expect(types.indexOf("session_fork")).toBeLessThan(
      types.indexOf("session_init"),
    );
  });

  test("a destructive in-place rewind announces no fork", async () => {
    const { jsonl, anchors } = buildSessionJsonl();
    const { manager } = convManager(jsonl);

    const out = await captureIpcOutput(async () => {
      await manager.handleSessionRewind({
        type: "session_rewind",
        promptUuid: anchors[1],
        scope: "conversation",
        fork: false,
      });
    });
    expect(out.map((m) => m.type)).not.toContain("session_fork");
  });
});

describe("conversation rewind — destructive in-place (fork:false)", () => {
  test("overwrites the live JSONL in place, respawns the same id, no newSessionId", async () => {
    const { jsonl, anchors } = buildSessionJsonl();
    const { manager, writes, spawns } = convManager(jsonl);

    const out = await captureIpcOutput(async () => {
      await manager.handleSessionRewind({
        type: "session_rewind",
        promptUuid: anchors[2],
        scope: "conversation",
        fork: false,
      });
    });

    const ack = out.find((m) => m.type === "rewind_result");
    expect(ack.canRewind).toBe(true);
    expect(ack.newSessionId).toBeUndefined();
    // The write targets the live session's own path (destructive).
    expect(writes.length).toBe(1);
    expect(writes[0].path).toContain("live-claude-id");
    expect(spawns).toEqual([{ id: "live-claude-id", mode: "resume" }]);
  });
});

describe("conversation rewind — guards", () => {
  test("a missing JSONL refuses without killing or respawning", async () => {
    const { manager, writes, spawns, killCalls } = convManager(null);
    const out = await captureIpcOutput(async () => {
      await manager.handleSessionRewind({
        type: "session_rewind",
        promptUuid: "anchor",
        scope: "conversation",
      });
    });
    const ack = out.find((m) => m.type === "rewind_result");
    expect(ack.canRewind).toBe(false);
    expect(ack.error).toContain("Could not read session JSONL");
    expect(writes.length).toBe(0);
    expect(spawns.length).toBe(0);
    expect(killCalls()).toBe(0);
  });

  test("an unknown anchor refuses before any kill/truncate/respawn", async () => {
    const { jsonl } = buildSessionJsonl();
    const { manager, writes, spawns, killCalls } = convManager(jsonl);
    const out = await captureIpcOutput(async () => {
      await manager.handleSessionRewind({
        type: "session_rewind",
        promptUuid: "stale-anchor",
        scope: "conversation",
      });
    });
    const ack = out.find((m) => m.type === "rewind_result");
    expect(ack.canRewind).toBe(false);
    expect(ack.error).toContain("anchor not found");
    expect(writes.length).toBe(0);
    expect(spawns.length).toBe(0);
    expect(killCalls()).toBe(0);
  });

  test("a rewind across a /compact boundary is refused, not silently corrupted", async () => {
    const { jsonl, anchors } = buildSessionJsonl();
    const lines = jsonl.split("\n").filter((l) => l.trim());
    const idx = lines.findIndex((l) => l.includes('"mode"'));
    lines.splice(idx, 0, JSON.stringify({ type: "system", subtype: "compact_boundary" }));
    const { manager, writes, spawns } = convManager(lines.join("\n") + "\n");
    const out = await captureIpcOutput(async () => {
      await manager.handleSessionRewind({
        type: "session_rewind",
        promptUuid: anchors[1], // BETA, before the spliced compaction
        scope: "conversation",
      });
    });
    const ack = out.find((m) => m.type === "rewind_result");
    expect(ack.canRewind).toBe(false);
    expect(ack.error).toContain("/compact boundary");
    expect(writes.length).toBe(0);
    expect(spawns.length).toBe(0);
  });

  test("a rewind to the first turn is refused before any kill/truncate/respawn", async () => {
    const { jsonl, anchors } = buildSessionJsonl();
    const { manager, writes, spawns, killCalls } = convManager(jsonl);
    const out = await captureIpcOutput(async () => {
      await manager.handleSessionRewind({
        type: "session_rewind",
        promptUuid: anchors[0], // first turn → empty retained prefix
        scope: "conversation",
      });
    });
    const ack = out.find((m) => m.type === "rewind_result");
    expect(ack.canRewind).toBe(false);
    expect(ack.error).toContain("first turn");
    expect(writes.length).toBe(0);
    expect(spawns.length).toBe(0);
    expect(killCalls()).toBe(0);
  });

  test("idle gating: a conversation rewind mid-turn is rejected without touching disk", async () => {
    const { jsonl, anchors } = buildSessionJsonl();
    const { manager, writes, spawns } = convManager(jsonl);
    (manager as any).activeTurn = new ActiveTurn(0, []);
    const out = await captureIpcOutput(async () => {
      await manager.handleSessionRewind({
        type: "session_rewind",
        promptUuid: anchors[1],
        scope: "conversation",
      });
    });
    const ack = out.find((m) => m.type === "rewind_result");
    expect(ack.canRewind).toBe(false);
    expect(ack.error).toContain("busy");
    expect(writes.length).toBe(0);
    expect(spawns.length).toBe(0);
  });
});

describe("conversation rewind — scope:both ordering", () => {
  test("code restore runs first, then the fork; combined ack carries newSessionId", async () => {
    const { jsonl, anchors } = buildSessionJsonl();
    const { manager, writes, spawns } = convManager(jsonl);
    // Capture the code-restore control request as it's sent, and answer it.
    const sentControl: any[] = [];
    (manager as any).claudeProcess = {
      stdin: {
        write: (data: unknown) => {
          const ev = JSON.parse(String(data).replace(/\n$/, ""));
          sentControl.push(ev);
          // Reply success on the next tick so the awaiting code leg resolves.
          queueMicrotask(() => {
            (manager as any).handleClaudeLine(
              JSON.stringify({
                type: "control_response",
                response: {
                  subtype: "success",
                  request_id: ev.request_id,
                  response: { canRewind: true },
                },
              }),
            );
          });
        },
        flush: () => {},
      },
    };

    const out = await captureIpcOutput(async () => {
      await manager.handleSessionRewind({
        type: "session_rewind",
        promptUuid: anchors[2],
        scope: "both",
        fork: true,
      });
    });

    // Code restore was issued (rewind_files{dry_run:false}) ...
    expect(sentControl.length).toBe(1);
    expect(sentControl[0].request.subtype).toBe("rewind_files");
    expect(sentControl[0].request.dry_run).toBe(false);
    // ... and the conversation fork followed (a copy write + a respawn).
    expect(writes.length).toBe(1);
    expect(spawns.length).toBe(1);

    const acks = out.filter((m) => m.type === "rewind_result");
    expect(acks.length).toBe(1); // exactly one combined ack
    expect(acks[0]).toMatchObject({ scope: "both", canRewind: true });
    expect(typeof acks[0].newSessionId).toBe("string");
  });

  test("scope:both aborts the conversation leg if the code restore fails", async () => {
    const { jsonl, anchors } = buildSessionJsonl();
    const { manager, writes, spawns } = convManager(jsonl);
    (manager as any).claudeProcess = {
      stdin: {
        write: (data: unknown) => {
          const ev = JSON.parse(String(data).replace(/\n$/, ""));
          queueMicrotask(() => {
            (manager as any).handleClaudeLine(
              JSON.stringify({
                type: "control_response",
                response: {
                  subtype: "success",
                  request_id: ev.request_id,
                  response: { canRewind: false, error: "No file checkpoint found." },
                },
              }),
            );
          });
        },
        flush: () => {},
      },
    };

    const out = await captureIpcOutput(async () => {
      await manager.handleSessionRewind({
        type: "session_rewind",
        promptUuid: anchors[2],
        scope: "both",
        fork: true,
      });
    });

    const ack = out.find((m) => m.type === "rewind_result");
    expect(ack.canRewind).toBe(false);
    expect(ack.error).toContain("No file checkpoint");
    // The conversation leg never ran — no fork write, no respawn.
    expect(writes.length).toBe(0);
    expect(spawns.length).toBe(0);
  });
});

describe("control_response correlation isolation", () => {
  test("an uncorrelated control_response is not consumed by the rewind path", async () => {
    const { manager } = mockProcessWithStdinSpy();
    // No pending rewind requests ⇒ tryHandleRewindControlResponse is never
    // reached; the line falls through harmlessly (no rewind IPC emitted).
    const out = await captureIpcOutput(() => {
      (manager as any).handleClaudeLine(
        JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: "some-other-request",
            response: { canRewind: true },
          },
        }),
      );
    });
    expect(out.filter((m) => m.type === "rewind_preview_result").length).toBe(0);
    expect(out.filter((m) => m.type === "rewind_result").length).toBe(0);
  });
});

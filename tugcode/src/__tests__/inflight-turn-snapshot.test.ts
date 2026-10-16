// emitInflightTurnFromActiveTurn — Option 4 replay-the-stream pattern.
//
// Pins [D07]'s Mid-turn replay snapshot contract: the snapshot emits a
// content_block_start + terminal-frame pair per Message in messageBlocks,
// in arrival order, across every msgId of the active turn. Reducer-side
// idempotence (content_block_start for an already-minted pair is a
// no-op) is the invariant that makes this pattern safe under
// live-then-snapshot races.

import { describe, expect, test } from "bun:test";
import {
  ActiveTurn,
  SessionManager,
} from "../session.ts";
import { unwrapReplayBatches } from "./capture-ipc.ts";
import type {
  AssistantText,
  ContentBlockStart,
  OutboundMessage,
  ToolResult,
  ToolUse,
} from "../types.ts";

async function captureStdout(
  fn: () => Promise<void> | void,
): Promise<{ emitted: OutboundMessage[] }> {
  const captured: OutboundMessage[] = [];
  const originalWrite = Bun.write;
  const decoder = new TextDecoder();
  (Bun as unknown as { write: typeof Bun.write }).write = ((
    dest: unknown,
    data: unknown,
  ) => {
    if (dest === Bun.stdout) {
      let text = "";
      if (typeof data === "string") text = data;
      else if (data instanceof Uint8Array) text = decoder.decode(data);
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (t.length > 0) {
          try {
            captured.push(JSON.parse(t) as OutboundMessage);
          } catch {
            // ignore
          }
        }
      }
    }
    return Promise.resolve(
      data instanceof Uint8Array
        ? data.length
        : typeof data === "string"
          ? data.length
          : 0,
    );
  }) as typeof Bun.write;
  try {
    await fn();
    const { drainPendingWrites } = await import("../ipc.ts");
    await drainPendingWrites();
  } finally {
    (Bun as unknown as { write: typeof Bun.write }).write = originalWrite;
  }
  return { emitted: unwrapReplayBatches(captured) };
}

function newManagerWithTurn(turn: ActiveTurn): SessionManager {
  const manager = new SessionManager(
    "/tmp/inflight-snap-" + Date.now() + "-" + Math.random().toString(36).slice(2),
    crypto.randomUUID(),
  );
  (manager as unknown as { activeTurn: ActiveTurn }).activeTurn = turn;
  return manager;
}

describe("request_inflight — the turn as it now stands, and nothing older", () => {
  function streamingTurn(): ActiveTurn {
    const turn = new ActiveTurn(0, []);
    turn.currentMessageId = "msg_live";
    turn.messageBlocks.set("msg_live", [{ index: 0, kind: "text", text: "Half of the answer" }]);
    return turn;
  }

  test("a turn in flight: a bracket marked inflight_only around its snapshot, and no end", async () => {
    const manager = newManagerWithTurn(streamingTurn());
    const { emitted } = await captureStdout(() => manager.requestInflight());

    expect(emitted[0]).toMatchObject({ type: "replay_started", inflight_only: true });
    expect(emitted[emitted.length - 1]).toMatchObject({ type: "replay_complete", count: 0 });
    expect(emitted.find((m) => m.type === "add_user_message")).toMatchObject({ inflightSnapshot: true });
    const text = emitted.find((m): m is AssistantText => m.type === "assistant_text");
    expect(text).toMatchObject({ msg_id: "msg_live", text: "Half of the answer", is_partial: false });
    expect(emitted.some((m) => m.type === "turn_complete")).toBe(false);
  });

  test("a turn that finished while the card was away: its snapshot carries the end", async () => {
    const manager = newManagerWithTurn(streamingTurn());
    const finished = (manager as unknown as { activeTurn: ActiveTurn }).activeTurn;
    finished.gotResult = true;
    (manager as unknown as { activeTurn: ActiveTurn | null }).activeTurn = null;
    (manager as unknown as { lastFinishedTurn: ActiveTurn | null }).lastFinishedTurn = finished;

    const { emitted } = await captureStdout(() => manager.requestInflight());

    expect(emitted[0]).toMatchObject({ type: "replay_started", inflight_only: true });
    expect(emitted.find((m) => m.type === "turn_complete")).toMatchObject({ msg_id: "msg_live", result: "success" });
    expect(emitted[emitted.length - 1]).toMatchObject({ type: "replay_complete" });
  });

  test("a turn that died with claude: an empty bracket, never the turn before it", async () => {
    // The card holds the turn that died. Describing the one that finished
    // before it would hand that card another turn's end as its own.
    const earlier = new ActiveTurn(0, []);
    earlier.currentMessageId = "msg_earlier";
    earlier.messageBlocks.set("msg_earlier", [{ index: 0, kind: "text", text: "Done" }]);
    earlier.gotResult = true;
    const dying = new ActiveTurn(1, []);
    dying.currentMessageId = "msg_dying";
    dying.messageBlocks.set("msg_dying", [{ index: 0, kind: "text", text: "Half of" }]);
    const manager = newManagerWithTurn(dying);
    (manager as unknown as { lastFinishedTurn: ActiveTurn | null }).lastFinishedTurn = earlier;
    await captureStdout(() =>
      (manager as unknown as { signalEofToActiveTurn(): void }).signalEofToActiveTurn(),
    );

    const { emitted } = await captureStdout(() => manager.requestInflight());
    expect(emitted.map((m) => m.type)).toEqual(["replay_started", "replay_complete"]);
  });

  test("no turn yet: an empty bracket", async () => {
    const manager = new SessionManager("/tmp/inflight-none-" + Date.now(), crypto.randomUUID());
    const { emitted } = await captureStdout(() => manager.requestInflight());
    expect(emitted.map((m) => m.type)).toEqual(["replay_started", "replay_complete"]);
  });
});

describe("emitInflightTurnFromActiveTurn — per-Message replay-the-stream", () => {
  test("multi-block turn: snapshot emits content_block_start + terminal frame per block, in arrival order", async () => {
    // A turn that streamed: text(0) → tool_use(1) → tool_result → text(2).
    // The snapshot must replay all four as separate frames, preserving
    // the wire's temporal interleaving so the reducer rebuilds the
    // same `messages` sequence the live path would have.
    const turn = new ActiveTurn(0, []);
    turn.currentMessageId = "msg_loop";
    turn.messageBlocks.set("msg_loop", [
      { index: 0, kind: "text", text: "Working on it..." },
      {
        index: 1,
        kind: "tool_use",
        toolUseId: "tu_1",
        toolName: "Bash",
        toolInput: { command: "ls" },
        toolResult: { output: "file1\nfile2", isError: false },
      },
      { index: 2, kind: "text", text: "Two files." },
    ]);
    const manager = newManagerWithTurn(turn);

    const { emitted } = await captureStdout(() =>
      (manager as any).emitInflightTurnFromActiveTurn(turn),
    );

    // Three content_block_start frames, one per block, with the right
    // kind + block_index + (for tool_use) tool_use_id.
    const cbs = emitted.filter((m): m is ContentBlockStart => m.type === "content_block_start");
    expect(cbs).toHaveLength(3);
    expect(cbs[0]).toMatchObject({ msg_id: "msg_loop", block_index: 0, kind: "text" });
    expect(cbs[1]).toMatchObject({
      msg_id: "msg_loop",
      block_index: 1,
      kind: "tool_use",
      tool_use_id: "tu_1",
      tool_name: "Bash",
    });
    expect(cbs[2]).toMatchObject({ msg_id: "msg_loop", block_index: 2, kind: "text" });

    // Both text blocks reach the wire as is_partial: false terminals.
    const texts = emitted.filter((m): m is AssistantText => m.type === "assistant_text");
    expect(texts.some((t) => t.text === "Working on it..." && t.block_index === 0)).toBe(true);
    expect(texts.some((t) => t.text === "Two files." && t.block_index === 2)).toBe(true);

    // Tool_use + tool_result both emit.
    const toolUse = emitted.find((m): m is ToolUse => m.type === "tool_use");
    expect(toolUse?.tool_use_id).toBe("tu_1");
    expect(toolUse?.input).toEqual({ command: "ls" });
    const toolResult = emitted.find((m): m is ToolResult => m.type === "tool_result");
    expect(toolResult?.tool_use_id).toBe("tu_1");
    expect(toolResult?.output).toBe("file1\nfile2");
  });

  test("multi-msgId turn: snapshot spans every msgId iteration", async () => {
    // A tool-use loop iterates over multiple message_start events, each
    // with its own msgId. messageBlocks keys by msgId; the snapshot
    // iterates ALL of them. This is the correctness improvement over
    // today's substrate (which dropped intermediate iterations' content
    // at commit — see [D07] § Multi-msgId-per-turn handling).
    const turn = new ActiveTurn(0, []);
    turn.currentMessageId = "msg_B";  // sliding pointer points at last
    turn.messageBlocks.set("msg_A", [
      { index: 0, kind: "thinking", text: "let me think" },
      {
        index: 1,
        kind: "tool_use",
        toolUseId: "tu_A",
        toolName: "Read",
        toolInput: { path: "/foo" },
        toolResult: { output: "data", isError: false },
      },
    ]);
    turn.messageBlocks.set("msg_B", [
      { index: 0, kind: "text", text: "Here is the answer." },
    ]);
    const manager = newManagerWithTurn(turn);

    const { emitted } = await captureStdout(() =>
      (manager as any).emitInflightTurnFromActiveTurn(turn),
    );

    // Content_block_start frames span BOTH msgIds.
    const cbs = emitted.filter((m): m is ContentBlockStart => m.type === "content_block_start");
    const cbsByMsgId = new Map<string, ContentBlockStart[]>();
    for (const c of cbs) {
      const list = cbsByMsgId.get(c.msg_id) ?? [];
      list.push(c);
      cbsByMsgId.set(c.msg_id, list);
    }
    expect(cbsByMsgId.get("msg_A")?.length).toBe(2);
    expect(cbsByMsgId.get("msg_B")?.length).toBe(1);

    // msg_A's intermediate thinking + tool reach the wire.
    expect(emitted.some((m: any) => m.type === "thinking_text" && m.msg_id === "msg_A")).toBe(true);
    const tu = emitted.find((m): m is ToolUse => m.type === "tool_use");
    expect(tu?.msg_id).toBe("msg_A");
    expect(tu?.tool_use_id).toBe("tu_A");

    // msg_B's final text reaches the wire.
    const finalText = emitted.find(
      (m): m is AssistantText =>
        m.type === "assistant_text" && m.msg_id === "msg_B",
    );
    expect(finalText?.text).toBe("Here is the answer.");
  });

  test("seq is monotonically increasing across the snapshot's emissions", async () => {
    // Contract: every emission that carries a `seq` field gets a fresh
    // seq from this.nextSeq(); the resulting sequence is strictly
    // monotonic across the snapshot. This invariant was implicit in
    // the deleted gotResult=true shape-pin test (which checked
    // assistant_text.seq < turn_complete.seq). Pinning it explicitly
    // here so a future regression to "reuse turn.seq" or "skip
    // nextSeq" is caught.
    const turn = new ActiveTurn(0, []);
    turn.currentMessageId = "msg_seq";
    turn.messageBlocks.set("msg_seq", [
      { index: 0, kind: "text", text: "first" },
      { index: 1, kind: "thinking", text: "pondering" },
      {
        index: 2,
        kind: "tool_use",
        toolUseId: "tu_seq",
        toolName: "Bash",
        toolInput: { command: "ls" },
      },
      { index: 3, kind: "text", text: "second" },
    ]);
    turn.gotResult = true; // triggers terminal turn_complete with its own seq
    const manager = newManagerWithTurn(turn);
    const { emitted } = await captureStdout(() =>
      (manager as any).emitInflightTurnFromActiveTurn(turn),
    );

    // Collect every seq carried by an emitted message in order. Most
    // IPC types carry `seq`; some don't (content_block_start,
    // tool_result, replay_started, etc.). Order check applies only to
    // those that do.
    const seqs: number[] = [];
    for (const m of emitted) {
      const seq = (m as { seq?: unknown }).seq;
      if (typeof seq === "number") seqs.push(seq);
    }
    expect(seqs.length).toBeGreaterThan(1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  test("idempotence on the wire: the snapshot's content_block_start for an already-minted block is safe to re-emit", async () => {
    // Reducer-side idempotence is enforced in tugdeck (handleContentBlockStart
    // no-ops on existing blockIndex entries — pinned separately by
    // tugdeck's reducer.snapshot-idempotence test). What we pin here is
    // tugcode's side of the contract: the snapshot emits the SAME
    // content_block_start for every block in messageBlocks, regardless
    // of whether the reducer already saw it live. tugcode does not try
    // to remember "was this block already emitted before the bracket"
    // — it always emits, trusting the reducer's idempotence.
    const turn = new ActiveTurn(0, []);
    turn.currentMessageId = "msg_idem";
    turn.messageBlocks.set("msg_idem", [
      { index: 0, kind: "text", text: "block-zero" },
    ]);
    const manager = newManagerWithTurn(turn);
    const { emitted: first } = await captureStdout(() =>
      (manager as any).emitInflightTurnFromActiveTurn(turn),
    );
    const { emitted: second } = await captureStdout(() =>
      (manager as any).emitInflightTurnFromActiveTurn(turn),
    );
    // Each call emits the same shape — proving tugcode is stateless
    // across snapshot invocations and the idempotence guarantee lives
    // on the reducer side.
    const firstCbs = first.filter((m): m is ContentBlockStart => m.type === "content_block_start");
    const secondCbs = second.filter((m): m is ContentBlockStart => m.type === "content_block_start");
    expect(firstCbs).toHaveLength(1);
    expect(secondCbs).toHaveLength(1);
    expect(firstCbs[0]).toMatchObject({ msg_id: "msg_idem", block_index: 0, kind: "text" });
    expect(secondCbs[0]).toMatchObject({ msg_id: "msg_idem", block_index: 0, kind: "text" });
  });
});

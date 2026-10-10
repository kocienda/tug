import { describe, test, expect } from "bun:test";
import { ActiveTurn } from "../active-turn.ts";

describe("ActiveTurn identity", () => {
  test("ActiveTurn mints t-<seq> as its opener id", () => {
    const turn = new ActiveTurn(7, []);
    expect(turn.openerId).toBe("t-7");
    expect(turn.currentMessageId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ActiveTurn tool-input progress
// ---------------------------------------------------------------------------

describe("ActiveTurn.recordToolInputDelta", () => {
  test("recordToolInputDelta correlates, throttles, and reports progress", () => {
    const turn = new ActiveTurn(7, [{ type: "text", text: "" }]);
    // Mint the tool_use block the way dispatchEventToTurn does, via the
    // content_block_start message — this is what gives the delta's
    // block_index its tool_use_id / tool_name.
    turn.updateBlockStateFromMessages([
      {
        type: "content_block_start",
        msg_id: "m1",
        block_index: 0,
        kind: "tool_use",
        tool_use_id: "toolu_1",
        tool_name: "Write",
        ipc_version: 2,
      },
    ]);

    // Fragment 1: opens the JSON, path value not yet closed → nothing
    // narratable yet, so no frame.
    expect(turn.recordToolInputDelta("m1", 0, '{"file_path":"src/a')).toBeNull();

    // Fragment 2: closes the path and opens content's first line.
    const p1 = turn.recordToolInputDelta("m1", 0, '.ts","content":"one\\n');
    expect(p1).not.toBeNull();
    expect(p1!.type).toBe("tool_input_progress");
    expect(p1!.tool_use_id).toBe("toolu_1");
    expect(p1!.tool_name).toBe("Write");
    expect(p1!.file_path).toBe("src/a.ts");
    expect(p1!.content_lines).toBe(2);

    // Fragment 3: line count advances → a fresh frame.
    const p2 = turn.recordToolInputDelta("m1", 0, "two\\nthree");
    expect(p2!.content_lines).toBe(3);

    // Fragment 4: no narratable change (still 3 lines, same path) → throttled.
    expect(turn.recordToolInputDelta("m1", 0, " words")).toBeNull();

    // Unknown block index → no correlation, no frame.
    expect(turn.recordToolInputDelta("m1", 9, '{"x":1}')).toBeNull();
  });
});

/**
 * Unit tests for the attention report rule (`attentionReportKey`): when the
 * deck tells tugcast that the user attended a session.
 */

import { afterEach, describe, expect, it } from "bun:test";

import {
  attentionReportKey,
  installSessionAttention,
  nextAttendReport,
} from "@/lib/session-attention";
import {
  cardSessionBindingStore,
  type CardSessionBinding,
} from "@/lib/card-session-binding-store";
import type { Frame } from "@/protocol";

describe("attentionReportKey", () => {
  it("reports nothing when no session is attended", () => {
    expect(attentionReportKey(null, null, null)).toBeNull();
  });

  it("reports activating a session whose result is unseen", () => {
    const row = { last_turn_end_at: 2_000, last_attended_at: 1_000 };
    expect(attentionReportKey("s1", row, null)).toBe("s1:2000");
  });

  it("reports nothing for a session already seen, so a click costs no write", () => {
    const row = { last_turn_end_at: 2_000, last_attended_at: 3_000 };
    expect(attentionReportKey("s1", row, null)).toBeNull();
  });

  it("reports a row the deck has not listed yet, once", () => {
    expect(attentionReportKey("s1", null, null)).toBe("s1:unknown");
    expect(attentionReportKey("s1", null, "s1:unknown")).toBeNull();
  });

  it("answers a turn that completes on the attended card, which keeps the mark from standing", () => {
    // The user is attending s1 and has seen everything.
    let reported: string | null = null;
    const seen = { last_turn_end_at: 1_000, last_attended_at: 1_500 };
    expect(attentionReportKey("s1", seen, reported)).toBeNull();

    // The turn ends: the push raises the end stamp under the user's eyes.
    const ended = { last_turn_end_at: 2_000, last_attended_at: 1_500 };
    reported = attentionReportKey("s1", ended, reported);
    expect(reported).toBe("s1:2000");

    // Ledger ticks before the answering push do not repeat the report.
    expect(attentionReportKey("s1", ended, reported)).toBeNull();

    // The push comes back seen; the next turn's end is reported afresh.
    expect(attentionReportKey("s1", { last_turn_end_at: 2_000, last_attended_at: 2_010 }, reported)).toBeNull();
    expect(attentionReportKey("s1", { last_turn_end_at: 3_000, last_attended_at: 2_010 }, reported)).toBe("s1:3000");
  });
});

describe("nextAttendReport", () => {
  const seen = { last_turn_end_at: 1_000, last_attended_at: 1_500 };
  const unseen = { last_turn_end_at: 2_000, last_attended_at: 1_500 };

  it("names the attended session on the first review, mark or not", () => {
    expect(nextAttendReport("s1", seen, null, undefined)).toEqual({ send: "s1", lastReported: null });
  });

  it("sends nothing while the attended session stays put and reads seen", () => {
    expect(nextAttendReport("s1", seen, null, "s1")).toBeNull();
  });

  it("names nobody when the app goes to the background, so a turn end there raises the mark", () => {
    expect(nextAttendReport(null, null, null, "s1")).toEqual({ send: null, lastReported: null });
    expect(nextAttendReport(null, null, null, null)).toBeNull();
  });

  it("carries a standing mark's spending with a move onto its session", () => {
    expect(nextAttendReport("s2", unseen, null, "s1")).toEqual({ send: "s2", lastReported: "s2:2000" });
  });

  it("answers an unseen turn end on the attended session once", () => {
    const first = nextAttendReport("s1", unseen, null, "s1");
    expect(first).toEqual({ send: "s1", lastReported: "s1:2000" });
    expect(nextAttendReport("s1", unseen, "s1:2000", "s1")).toBeNull();
  });
});

describe("installSessionAttention", () => {
  afterEach(() => {
    cardSessionBindingStore.clearBinding("c1");
  });

  it("names the attended session again when the wire reopens, for a tugcast that forgot it", () => {
    cardSessionBindingStore.setBinding("c1", {
      tugSessionId: "s1",
      lineId: "l1",
      workspaceKey: "w1",
      projectDir: "/p",
    } as unknown as CardSessionBinding);
    const sent: unknown[] = [];
    let wireOpen = (): void => {};
    const release = installSessionAttention({
      isAppActive: () => true,
      getFirstResponderCardId: () => "c1",
      observeCardDidActivate: () => () => {},
      observeDeck: () => () => {},
      observeWireOpen: (cb) => {
        wireOpen = cb;
        return () => {};
      },
      send: (frame: Frame) => sent.push(JSON.parse(new TextDecoder().decode(frame.payload))),
    });
    try {
      cardSessionBindingStore.setBinding("c1", {
        tugSessionId: "s1",
        lineId: "l1",
        workspaceKey: "w1",
        projectDir: "/q",
      } as unknown as CardSessionBinding);
      const named = sent.length;
      expect(sent[sent.length - 1]).toEqual({ action: "attend_session", session_id: "s1" });

      // Nothing moved: no second report.
      cardSessionBindingStore.setBinding("c1", {
        tugSessionId: "s1",
        lineId: "l1",
        workspaceKey: "w1",
        projectDir: "/r",
      } as unknown as CardSessionBinding);
      expect(sent.length).toBe(named);

      wireOpen();
      expect(sent.length).toBe(named + 1);
      expect(sent[sent.length - 1]).toEqual({ action: "attend_session", session_id: "s1" });
    } finally {
      release();
    }
  });
});

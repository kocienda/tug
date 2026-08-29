// Wheel authorship on a reload is READ FROM TUG'S OWN RECORD.
//
// The wheel speaks in the transcript under its own name. Claude's JSONL cannot
// say so — that file is claude's, and it records a prompt the wheel sent
// exactly as it records one the user typed. So tugcast writes down every
// prompt the wheel puts on the wire (`wheel_prompts` in `sessions.db`), and the
// translator reads it back: a submission the record still holds is the wheel's,
// and claiming it spends it.
//
// The alternative — deducing authorship from where a prompt sits in the file —
// is what this replaced. It could only ever recognize one prompt per session,
// the stage opener, so every prompt the arc sent afterwards came back as the
// user's, and a windowed replay could hand the wheel's label to somebody else's
// words. A record has neither failure mode: it names what it names.

import { describe, expect, test } from "bun:test";

import { translateJsonlSession, wheelPromptLedger } from "../replay.ts";
import type {
  AddUserMessage,
  OutboundMessage,
  ReplayWindow,
} from "../types.ts";

async function collect(
  jsonl: string,
  opts: { sent?: string[]; window?: ReplayWindow } = {},
): Promise<AddUserMessage[]> {
  const out: OutboundMessage[] = [];
  for await (const m of translateJsonlSession(
    { kind: "ok", jsonl, claudeSessionId: "sess-wheel" },
    {
      disableYield: true,
      synthesizeDanglingTerminal: true,
      wheelPrompts:
        opts.sent === undefined ? undefined : wheelPromptLedger(opts.sent),
      window: opts.window,
    },
  )) {
    out.push(m);
  }
  return out.filter((m): m is AddUserMessage => m.type === "add_user_message");
}

const user = (text: string): string =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });

/**
 * What claude writes when a submission began with a slash command: the literal
 * is gone, replaced by an envelope. This is the shape a wheel prompt actually
 * comes back in, since every prompt the arc sends is a `/tugplug:…` or
 * `/compact`.
 */
const commandUser = (name: string, args: string): string =>
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content:
        `<command-message>${name.slice(1)}</command-message>\n` +
        `<command-name>${name}</command-name>\n` +
        `<command-args>${args}</command-args>`,
    },
  });

const assistant = (msgId: string, text: string): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      id: msgId,
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
    },
  });

/** Three turns, each a user prompt and its answer. */
const THREE_TURNS = [
  user("the wheel's opening prompt"),
  assistant("m1", "on it"),
  user("the user's own second message"),
  assistant("m2", "done"),
  user("the user's own third message"),
  assistant("m3", "done again"),
].join("\n");

describe("the wheel's prompts on a reload", () => {
  test("are marked wherever in the session they were sent", async () => {
    // The whole point of the record: the wheel's LATER prompts come back as
    // the wheel's too. Under the positional rule only the first one could.
    const msgs = await collect(THREE_TURNS, {
      sent: ["the wheel's opening prompt", "the user's own third message"],
    });
    expect(msgs.map((m) => m.origin)).toEqual(["wheel", undefined, "wheel"]);
  });

  test("survive claude rewriting a slash command into its envelope", async () => {
    // Tug's record holds what Tug SENT. Claude stores an envelope instead, so
    // the match is made against the sent text put back together — name, then
    // args. Every prompt the arc sends is a slash command, so this is the
    // ordinary case, not an edge one.
    const sent =
      "/tugplug:dash-implement tripwire Steps 4-13 — close one step and end your turn";
    const jsonl = [
      commandUser(
        "/tugplug:dash-implement",
        "tripwire Steps 4-13 — close one step and end your turn",
      ),
      assistant("m1", "on it"),
    ].join("\n");
    const msgs = await collect(jsonl, { sent: [sent] });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.origin).toBe("wheel");
  });

  test("match an argument-less command by its name alone", async () => {
    const jsonl = [commandUser("/compact", ""), assistant("m1", "ok")].join(
      "\n",
    );
    const msgs = await collect(jsonl, { sent: ["/compact"] });
    expect(msgs[0]?.origin).toBe("wheel");
  });

  test("are spent one per record, so a repeat the user typed stays theirs", async () => {
    // The wheel sent `/compact` once; the user typed the same thing later.
    // One record, one claim — the second is the user's.
    const jsonl = [
      commandUser("/compact", ""),
      assistant("m1", "ok"),
      commandUser("/compact", ""),
      assistant("m2", "ok"),
    ].join("\n");
    const msgs = await collect(jsonl, { sent: ["/compact"] });
    expect(msgs.map((m) => m.origin)).toEqual(["wheel", undefined]);
  });

  test("are both marked when the wheel really sent the same prompt twice", async () => {
    const jsonl = [
      commandUser("/compact", ""),
      assistant("m1", "ok"),
      commandUser("/compact", ""),
      assistant("m2", "ok"),
    ].join("\n");
    const msgs = await collect(jsonl, { sent: ["/compact", "/compact"] });
    expect(msgs.map((m) => m.origin)).toEqual(["wheel", "wheel"]);
  });

  test("leave the user's own words alone, first prompt included", async () => {
    // The positional rule's failure, now structurally impossible: nothing is
    // marked by where it sits, so a session the wheel never spoke on comes
    // back entirely the user's.
    const msgs = await collect(THREE_TURNS, { sent: [] });
    expect(msgs.map((m) => m.origin)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("are absent when no record was handed over at all", async () => {
    // Every replay of a card no arc ever drove, and the fallback when the
    // ledger handle is unavailable.
    const msgs = await collect(THREE_TURNS);
    expect(msgs.every((m) => m.origin === undefined)).toBe(true);
  });

  test("go unmarked when the window starts after them, relabelling nobody", async () => {
    const msgs = await collect(THREE_TURNS, {
      sent: ["the wheel's opening prompt"],
      window: { lastTurns: 1 },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.content).toEqual([
      { type: "text", text: "the user's own third message" },
    ]);
    expect(msgs[0]?.origin).toBeUndefined();
  });

  test("are still marked when the window reaches back to them", async () => {
    const msgs = await collect(THREE_TURNS, {
      sent: ["the wheel's opening prompt"],
      window: { lastTurns: 3 },
    });
    expect(msgs.map((m) => m.origin)).toEqual(["wheel", undefined, undefined]);
  });

  test("are claimed by a genuine submission, not by scaffolding that quotes it", async () => {
    // A `<local-command-stdout>` entry is CLI bookkeeping the translator
    // skips. Claiming happens at the emit site, so the record is still whole
    // when the submission that really carries the wheel's words arrives.
    const jsonl = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "<local-command-stdout>/compact</local-command-stdout>" },
      }),
      commandUser("/compact", ""),
      assistant("m1", "ok"),
    ].join("\n");
    const msgs = await collect(jsonl, { sent: ["/compact"] });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.origin).toBe("wheel");
  });
});

describe("the ledger itself", () => {
  test("holds nothing when nothing was sent", () => {
    expect(wheelPromptLedger([]).claim("anything")).toBe(false);
  });

  test("spends each holding exactly once", () => {
    const ledger = wheelPromptLedger(["a", "a", "b"]);
    expect(ledger.claim("a")).toBe(true);
    expect(ledger.claim("b")).toBe(true);
    expect(ledger.claim("a")).toBe(true);
    expect(ledger.claim("a")).toBe(false);
    expect(ledger.claim("b")).toBe(false);
  });

  test("matches on the whole text, never a prefix", () => {
    const ledger = wheelPromptLedger(["/compact"]);
    expect(ledger.claim("/compact now")).toBe(false);
    expect(ledger.claim("/compact")).toBe(true);
  });
});

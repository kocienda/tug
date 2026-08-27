/**
 * transcript-export.test.ts — pure-logic coverage for the `/export` formatter
 * ([#step-13c]): the Markdown + JSON Lines renderings the save panel writes.
 *
 * Teeth: JSONL must be one independently-parseable object per Message in order
 * (a serialization change that dropped or merged messages would fail); Markdown
 * must carry both the user prompt and the assistant response under their
 * headings (a structure regression would fail).
 */

import { describe, expect, test } from "bun:test";
import {
  exportBaseName,
  exportExtension,
  transcriptToJsonl,
  transcriptToMarkdown,
} from "../transcript-export";
import type { Message, TurnEntry } from "@/lib/code-session-store/types";
import { sessionTagStore } from "@/lib/session-tag-store";

let seq = 0;
function assistantText(text: string): Message {
  seq += 1;
  return { kind: "assistant_text", text, messageKey: `a${seq}`, createdAt: seq };
}
function userMessage(text: string): Message {
  seq += 1;
  return {
    kind: "user_message",
    text,
    attachments: [],
    origin: "user",
    submitAt: seq,
    messageKey: `u${seq}`,
    createdAt: seq,
  };
}
function turn(...messages: Message[]): TurnEntry {
  return { messages } as unknown as TurnEntry;
}

describe("transcriptToJsonl", () => {
  test("emits one parseable JSON object per Message, in order", () => {
    const transcript = [
      turn(userMessage("hi"), assistantText("hello")),
      turn(userMessage("bye"), assistantText("later")),
    ];
    const lines = transcriptToJsonl(transcript).trimEnd().split("\n");
    expect(lines).toHaveLength(4); // 2 turns × (user + assistant)
    const parsed = lines.map((l) => JSON.parse(l) as { kind: string; text: string });
    expect(parsed.map((p) => p.kind)).toEqual([
      "user_message",
      "assistant_text",
      "user_message",
      "assistant_text",
    ]);
    expect(parsed[0].text).toBe("hi");
    expect(parsed[3].text).toBe("later");
  });

  test("an empty transcript is the empty string", () => {
    expect(transcriptToJsonl([])).toBe("");
  });
});

describe("transcriptToMarkdown", () => {
  test("renders each turn's prompt and response under headings", () => {
    const md = transcriptToMarkdown([
      turn(userMessage("what is 2+2?"), assistantText("4")),
    ]);
    expect(md).toContain("# Session transcript");
    expect(md).toContain("## You\n\nwhat is 2+2?");
    expect(md).toContain("## Claude\n\n4");
  });

  test("an empty transcript yields just the title", () => {
    expect(transcriptToMarkdown([])).toBe("# Session transcript\n");
  });
});

describe("filenames", () => {
  test("extension matches the format", () => {
    expect(exportExtension("markdown")).toBe("md");
    expect(exportExtension("jsonl")).toBe("jsonl");
  });

  test("base name leads with the callsign, keeping the short id after it", () => {
    sessionTagStore.setTag("0123456789abcdef", "stocky-pixie");
    expect(exportBaseName("0123456789abcdef")).toBe(
      "tug-session-stocky-pixie-01234567",
    );
    // A legacy session with no callsign degrades to the short id alone —
    // exactly what this produced before the callsign led.
    expect(exportBaseName("fedcba9876543210")).toBe("tug-session-fedcba98");
    expect(exportBaseName(null)).toBe("tug-session");
  });
});

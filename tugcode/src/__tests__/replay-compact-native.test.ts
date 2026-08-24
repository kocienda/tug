// Replay of a **real** natively-compacted session JSONL. The fixture was
// generated against Claude Code 2.1.207 by running ~9 haiku turns in a scratch
// project and then sending `/compact` over the stream-json bridge; the file is
// the verbatim `~/.claude/projects/<enc>/<sid>.jsonl` Claude Code persisted.
//
// The compaction span is three consecutive records:
//   - `system` / `compact_boundary` with camelCase `compactMetadata.preTokens`
//   - `user` `isCompactSummary` carrying the summary as a bare string
//   - scaffolding (`<command-name>/compact…`, `<local-command-stdout>Compacted…`)
//
// Replay must emit exactly one `compact_boundary` frame (pre_tokens from the
// record) immediately followed by one `compact_summary` frame (summary verbatim),
// with the surrounding turn frames unchanged and the scaffolding still skipped.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { translateJsonlSession } from "../replay.ts";
import type {
  OutboundMessage,
  CompactBoundary,
  CompactSummary,
} from "../types.ts";

const FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "compact-native",
  "0967f3f0-013d-4849-b967-4b66dc702146.jsonl",
);

async function collectSession(jsonl: string): Promise<OutboundMessage[]> {
  const out: OutboundMessage[] = [];
  for await (const m of translateJsonlSession(
    { kind: "ok", jsonl, claudeSessionId: "sess-compact-native" },
    { disableYield: true },
  )) {
    out.push(m);
  }
  return out;
}

/** The verbatim `isCompactSummary` string content straight out of the fixture —
 *  the exact text replay must forward as the `compact_summary` summary. */
function readSummaryFromFixture(jsonl: string): string {
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const entry = JSON.parse(trimmed) as {
      type?: string;
      isCompactSummary?: boolean;
      message?: { content?: unknown };
    };
    if (entry.type === "user" && entry.isCompactSummary === true) {
      return entry.message?.content as string;
    }
  }
  throw new Error("fixture has no isCompactSummary record");
}

describe("translateJsonlSession — native compaction replay", () => {
  test("emits one compact_boundary then one compact_summary from the real fixture", async () => {
    const jsonl = readFileSync(FIXTURE, "utf8");
    const out = await collectSession(jsonl);

    const boundaries = out.filter(
      (m): m is CompactBoundary => m.type === "compact_boundary",
    );
    const summaries = out.filter(
      (m): m is CompactSummary => m.type === "compact_summary",
    );

    expect(boundaries).toHaveLength(1);
    expect(summaries).toHaveLength(1);

    // Pre- and post-compaction context sizes carried off camelCase
    // `compactMetadata` (post_tokens drives the CONTEXT-drops-in-place readout).
    expect(boundaries[0].trigger).toBe("manual");
    expect(boundaries[0].pre_tokens).toBe(26239);
    expect(boundaries[0].post_tokens).toBe(1442);

    // The boundary carries the record's own time. The divider note it mints
    // can open a turn's Message list — the transcript's sort key — and a
    // fabricated time there walls every later replayed turn behind it.
    const boundaryRecord = jsonl
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { subtype?: string; timestamp?: string })
      .find((e) => e.subtype === "compact_boundary");
    expect(boundaryRecord?.timestamp).toBeDefined();
    expect(boundaries[0].timestamp).toBe(Date.parse(boundaryRecord!.timestamp!));

    // Summary verbatim — Claude Code's own continuation framing included.
    expect(summaries[0].summary).toBe(readSummaryFromFixture(jsonl));
    expect(summaries[0].summary).toStartWith(
      "This session is being continued from a previous conversation",
    );

    // Boundary strictly precedes summary on the wire.
    const boundaryIdx = out.findIndex((m) => m.type === "compact_boundary");
    const summaryIdx = out.findIndex((m) => m.type === "compact_summary");
    expect(boundaryIdx).toBeGreaterThanOrEqual(0);
    expect(summaryIdx).toBeGreaterThan(boundaryIdx);

    // The `/compact` scaffolding user records never surface as submissions.
    const userMsgs = out.filter((m) => m.type === "add_user_message");
    expect(
      userMsgs.some((m) =>
        JSON.stringify(m).includes("<local-command-stdout>"),
      ),
    ).toBe(false);
  });

  test("a slice without compaction records emits neither frame", async () => {
    // Drop the boundary + summary + scaffolding tail; the remaining turns must
    // replay with no compaction frames at all (no regression on the skip).
    const jsonl = readFileSync(FIXTURE, "utf8");
    const kept = jsonl
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return false;
        const entry = JSON.parse(trimmed) as {
          type?: string;
          subtype?: string;
          isCompactSummary?: boolean;
        };
        if (entry.type === "system" && entry.subtype === "compact_boundary")
          return false;
        if (entry.type === "user" && entry.isCompactSummary === true)
          return false;
        return true;
      })
      .join("\n");

    const out = await collectSession(kept);

    expect(out.some((m) => m.type === "compact_boundary")).toBe(false);
    expect(out.some((m) => m.type === "compact_summary")).toBe(false);
  });
});

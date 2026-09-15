// Chain-aware replay — compaction re-appends and the dead-branch walk.
//
// A uuid is not unique in a Claude session file. Compaction re-appends
// the preserved messages verbatim — same `uuid`, same `parentUuid`, a
// later file position — so a `parentUuid` names several records. Parent
// resolution that takes the file's LAST occurrence walks the ancestor
// chain FORWARD into the re-appended copy, where it meets an
// already-live entry and stops; the segment root is then an ordinary
// assistant record, no compaction bridge fires, and the dead-roots
// sweep discards the genuinely-live history the walk never visited.
//
// `chain-topology.jsonl` is a projection of a real 4-compaction session
// (8b8d7bf1, records 3870–5080) covering a compaction and its verbatim
// re-append block — 362 uuids appear twice. Regenerate it with
// `fixtures/compact-reappend/project-session.ts`.

import { describe, expect, test } from "bun:test";

import { computeDeadEntryIndices } from "../replay.ts";
import type { JsonlEntry } from "../replay.ts";
import { computeDeadEntryIndicesLastWins } from "./dead-branch-walks.ts";

const FIXTURE = new URL(
  "./fixtures/compact-reappend/chain-topology.jsonl",
  import.meta.url,
).pathname;

const entries: JsonlEntry[] = (await Bun.file(FIXTURE).text())
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as JsonlEntry);

function chainIndices(parsed: ReadonlyArray<JsonlEntry>): number[] {
  const out: number[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (entry.isSidechain === true) continue;
    if (typeof entry.uuid !== "string" || entry.uuid.length === 0) continue;
    out.push(i);
  }
  return out;
}

function occurrences(
  parsed: ReadonlyArray<JsonlEntry>,
): Map<string, number[]> {
  const occ = new Map<string, number[]>();
  for (const i of chainIndices(parsed)) {
    const uuid = parsed[i].uuid as string;
    const at = occ.get(uuid);
    if (at === undefined) occ.set(uuid, [i]);
    else at.push(i);
  }
  return occ;
}

describe("compact re-append fixture", () => {
  test("carries the topology the walk has to survive", () => {
    expect(entries.length).toBe(1211);

    const chain = chainIndices(entries);
    expect(chain.length).toBe(1001);
    expect(entries.length - chain.length).toBe(210); // no-uuid bookkeeping

    const duplicated = [...occurrences(entries).values()].filter(
      (at) => at.length > 1,
    );
    expect(duplicated.length).toBe(362);
    // Every duplicate is a plain second occurrence — a verbatim re-append,
    // not a uuid reused three times over.
    expect(duplicated.every((at) => at.length === 2)).toBe(true);

    // The originals sit in one contiguous span and their re-appended
    // copies in a later one: 3–512 preserved, re-appended at 834–1195.
    const firsts = duplicated.map((at) => at[0]);
    const seconds = duplicated.map((at) => at[1]);
    expect([Math.min(...firsts), Math.max(...firsts)]).toEqual([3, 512]);
    expect([Math.min(...seconds), Math.max(...seconds)]).toEqual([834, 1195]);

    const compaction = entries
      .map((e, i) =>
        (e.type === "system" && e.subtype === "compact_boundary") ||
        e.isCompactSummary === true
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
    expect(compaction).toEqual([14, 15, 523, 524, 834, 835, 1196, 1197]);
  });
});

describe("computeDeadEntryIndices over compaction re-appends", () => {
  test("keeps the whole session live", () => {
    const dead = computeDeadEntryIndices(entries);
    expect([...dead]).toEqual([]);
  });

  test("keeps the post-re-append tail live", () => {
    const dead = computeDeadEntryIndices(entries);
    // Everything after the re-append block (the newest compaction and
    // the work that followed it) is the history the forward-resolving
    // walk used to discard.
    const tail = chainIndices(entries).filter((i) => i > 1195);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.filter((i) => dead.has(i))).toEqual([]);
  });

  test("keeps the preserved originals live, not just their copies", () => {
    const dead = computeDeadEntryIndices(entries);
    const firsts = [...occurrences(entries).values()]
      .filter((at) => at.length > 1)
      .map((at) => at[0]);
    expect(firsts.filter((i) => dead.has(i))).toEqual([]);
  });

  test("the fixture discriminates: last-wins resolution strands the session", () => {
    // The guard. Without it the tests above could pass vacuously on a
    // fixture that had lost the topology making occurrence-aware
    // resolution load-bearing. 980 is the whole loss the live session
    // suffered — every entry the forward-resolving walk discarded there
    // falls inside this slice.
    const regressed = computeDeadEntryIndicesLastWins(entries);
    expect(regressed.size).toBe(980);
    expect(computeDeadEntryIndices(entries).size).toBe(0);
  });
});

// The corpus has no session where a genuine rewind branch and a compaction
// coexist, so this one was generated: a real Claude Code REPL driven under
// tmux in a scratch project with throwaway prompts — ALPHA through GOLF and
// six paragraphs about small numbers — with `/rewind` → "Restore
// conversation" used to strand the DELTA and ECHO turns, and `/compact` run
// three times around them.
//
// It carries no verbatim re-append: Claude Code 2.1.219 did not produce one
// on any manual path (three compactions, two of them in resumed sessions,
// yielded zero duplicated uuids). Re-append coverage stays with
// `chain-topology.jsonl`, whose duplicates are real. What this fixture pins
// is the other half — that a compaction in the file does not stop the walk
// from finding a real abandoned branch, and does not let it find more.
const adversarial: JsonlEntry[] = (
  await Bun.file(
    new URL(
      "./fixtures/compact-reappend/rewind-and-compact.jsonl",
      import.meta.url,
    ).pathname,
  ).text()
)
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as JsonlEntry);

describe("a real rewind branch alongside compactions", () => {
  test("the fixture carries both shapes", () => {
    expect(adversarial.length).toBe(117);
    const compaction = adversarial
      .map((e, i) =>
        (e.type === "system" && e.subtype === "compact_boundary") ||
        e.isCompactSummary === true
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
    expect(compaction).toEqual([27, 28, 62, 63, 110, 111]);
    // No duplicated uuids — see the note above.
    const duplicated = [...occurrences(adversarial).values()].filter(
      (at) => at.length > 1,
    );
    expect(duplicated).toEqual([]);
  });

  test("exactly the rewound-away branch is dead", () => {
    // The two stranded turns (DELTA and ECHO), each a user submission, its
    // thinking and text assistant records, and its trailing system record.
    // Index 39 is a `file-history-snapshot` between them: no uuid, so it is
    // exempt and stays visible even though it sits inside the branch.
    const dead = computeDeadEntryIndices(adversarial);
    expect([...dead].sort((a, b) => a - b)).toEqual([
      35, 36, 37, 38, 40, 41, 42, 43,
    ]);
    expect(adversarial[39].type).toBe("file-history-snapshot");
    expect(adversarial[39].uuid).toBeUndefined();
  });

  test("the diverging submission and everything after it stay live", () => {
    const dead = computeDeadEntryIndices(adversarial);
    const after = chainIndices(adversarial).filter((i) => i > 43);
    expect(after.length).toBeGreaterThan(0);
    expect(after.filter((i) => dead.has(i))).toEqual([]);
  });
});

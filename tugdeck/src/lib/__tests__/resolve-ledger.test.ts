import { describe, expect, test } from "bun:test";

import type { ArcJoinLedgerWire, ArcJoinStateWire } from "@/lib/changeset-types";
import {
  EMPTY_LIVE,
  documentDisplayPath,
  foldReceiptText,
  ledgerBlocks,
  mergeLedgerEvents,
  offersResolveAgain,
} from "@/lib/resolve-ledger";

describe("documentDisplayPath", () => {
  test("a path under the checkout reads relative to it", () => {
    expect(documentDisplayPath("/u/src/tug/.tug/arcs/x/brief.md", "/u/src/tug")).toBe(
      ".tug/arcs/x/brief.md",
    );
  });

  test("a path outside the checkout keeps its full spelling", () => {
    expect(documentDisplayPath("/elsewhere/.tug/arcs/x/plan.md", "/u/src/tug")).toBe(
      "/elsewhere/.tug/arcs/x/plan.md",
    );
    // A sibling whose name merely begins with the root's is not under it.
    expect(documentDisplayPath("/u/src/tugdeck/plan.md", "/u/src/tug")).toBe(
      "/u/src/tugdeck/plan.md",
    );
  });

  test("a trailing slash on the root is tolerated", () => {
    expect(documentDisplayPath("/u/src/tug/.tug/arcs/x/tasks.md", "/u/src/tug/")).toBe(
      ".tug/arcs/x/tasks.md",
    );
  });

  test("no root shows the path whole", () => {
    expect(documentDisplayPath("/u/src/tug/brief.md", undefined)).toBe("/u/src/tug/brief.md");
    expect(documentDisplayPath("/u/src/tug/brief.md", "")).toBe("/u/src/tug/brief.md");
  });
});

describe("offersResolveAgain", () => {
  const join = (extra: Partial<ArcJoinStateWire>): ArcJoinStateWire =>
    ({ phase: "conflicted", blockers: [], conflicts: [], ...extra }) as ArcJoinStateWire;
  const ledger = { run: "1", started_ms: 0, events: [] } as unknown as ArcJoinLedgerWire;

  test("offer with a stale note offers it", () => {
    expect(offersResolveAgain("offer", join({ stale_note: "the base moved" }))).toBe(true);
  });

  test("offer with a standing ledger offers it", () => {
    expect(offersResolveAgain("offer", join({ ledger }))).toBe(true);
  });

  test("an untried offer, a run in progress and a resolved candidate do not", () => {
    expect(offersResolveAgain("offer", join({}))).toBe(false);
    expect(offersResolveAgain("progress", join({ stale_note: "moved", ledger }))).toBe(false);
    expect(offersResolveAgain("resolved", join({ stale_note: "moved", ledger }))).toBe(false);
    expect(offersResolveAgain("offer", null)).toBe(false);
  });
});

describe("foldReceiptText", () => {
  test("one folded path held by another session names the holder", () => {
    const text = foldReceiptText({
      seq: 4,
      commit: "abc1234def",
      base: "main",
      folded: ["src/a.ts"],
      folded_from: { "src/a.ts": "curly-apple" },
    });
    expect(text.title).toBe("curly-apple's edit to src/a.ts is now a commit on main");
    expect(text.sentence).toContain("Keep leaves the commit on main");
    expect(text.sentence).toContain("Undo takes it back off main");
    expect(text.sentence).toContain("blocks the join again");
  });

  test("one folded path of the user's own says it is theirs", () => {
    const text = foldReceiptText({ seq: 1, commit: "abc1234", base: "main", folded: ["Justfile"] });
    expect(text.title).toBe("Your edit to Justfile is now a commit on main");
    expect(text.sentence).toContain("returns the edit uncommitted");
  });

  test("several folded paths are counted", () => {
    const text = foldReceiptText({
      seq: 2,
      commit: "abc1234",
      base: "dev",
      folded: ["a", "b", "c"],
      folded_from: { a: "odd-kiln" },
    });
    expect(text.title).toBe("Committed 3 files of base work on dev");
    expect(text.sentence).toContain("returns the edits uncommitted");
  });

  test("a fold that only dropped copies says so, and Undo restores them", () => {
    expect(foldReceiptText({ seq: 3, base: "main", dropped: ["x"] }).title).toBe(
      "Dropped 1 identical file",
    );
    const text = foldReceiptText({ seq: 3, base: "main", dropped: ["x", "y"] });
    expect(text.title).toBe("Dropped 2 identical files");
    expect(text.sentence).toContain("Undo restores the dropped copies");
  });
});

const conflicted: ArcJoinStateWire = {
  phase: "conflicted",
  conflicts: ["Justfile"],
  archaeology: [
    {
      path: "Justfile",
      commits: [
        { sha: "f6de1041b", subject: "Run capture legs under test run" },
        { sha: "2a91c0e4d", subject: "Fold covers-check into lint" },
      ],
      total: 3,
    },
  ],
};

const input = (join: ArcJoinStateWire | null, running = false) => ({
  join,
  durable: null,
  live: EMPTY_LIVE,
  base: "main",
  running,
});

describe("ledgerBlocks, from join facts alone", () => {
  test("an untried conflict is one probe block whose body lists the base's commits", () => {
    const blocks = ledgerBlocks(input(conflicted));
    expect(blocks.map((b) => b.kind)).toEqual(["probe"]);
    const probe = blocks[0]!;
    expect(probe.identity.path).toBe("Justfile");
    expect(probe.identity.text).toContain("conflicts with main");
    expect(probe.summary).toEqual({ kind: "count", count: 3, noun: "commit" });
    expect(probe.phase).toBe("success");
    expect(probe.body.kind).toBe("commits");
    if (probe.body.kind !== "commits") throw new Error("unreachable");
    expect(probe.body.conflicts[0]!.history?.commits?.map((c) => c.sha)).toEqual([
      "f6de1041b",
      "2a91c0e4d",
    ]);
  });

  test("a resolved candidate with a report is probe, audit and a receipt-variant candidate", () => {
    const blocks = ledgerBlocks(
      input({
        ...conflicted,
        phase: "resolved",
        candidate: "9f3c1e2a7",
        resolved: [{ path: "Justfile", resolved_by: "ai" }],
        report: { files: [{ path: "Justfile", reconciliation: "both recipes kept" }] },
      }),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["probe", "audit", "candidate"]);
    const candidate = blocks[2]!;
    expect(candidate.variant).toBe("receipt");
    expect(candidate.identity.sha).toBe("9f3c1e2a7");
    expect(candidate.body).toEqual({ kind: "files", files: [{ path: "Justfile", fact: "ai" }] });
    expect(blocks[1]!.body.kind).toBe("audit");
  });

  test("a clean candidate that resolved nothing draws no candidate block", () => {
    expect(ledgerBlocks(input({ phase: "resolved", candidate: "abc", resolved: [] }))).toEqual([]);
  });

  test("a stale candidate draws a stale block whose identity is the server's note", () => {
    const note = "main moved to f6de104 since this candidate was built";
    const blocks = ledgerBlocks(input({ phase: "conflicted", stale_note: note }));
    const stale = blocks.find((b) => b.kind === "stale")!;
    expect(stale.identity.text).toBe(note);
    expect(stale.phase).toBe("error");
    expect(stale.toolName).toBe("main");
  });

  test("a waiting question is a resolver block, awaiting, with the question as its body", () => {
    const question = {
      request_id: "q1",
      question: "Where does the gate run?",
      options: [{ label: "before the tier" }, { label: "after the tier" }],
    };
    const blocks = ledgerBlocks(input({ ...conflicted, question }, true));
    const resolver = blocks.find((b) => b.kind === "resolver")!;
    expect(resolver.phase).toBe("awaiting");
    expect(resolver.body).toEqual({ kind: "question", question });
    // Waiting on a person is not working: nothing else is drawn as live.
    expect(blocks.filter((b) => b.phase === "in_flight")).toEqual([]);
  });

  test("a running resolve has exactly one in-flight block, and it carries the band", () => {
    const blocks = ledgerBlocks(input(conflicted, true));
    expect(blocks.map((b) => b.kind)).toEqual(["probe", "ladder"]);
    const live = blocks.filter((b) => b.phase === "in_flight");
    expect(live).toHaveLength(1);
    expect(live[0]!.kind).toBe("ladder");
    expect(live[0]!.identity.text).toBe("Resolving 1 file");
    expect(live[0]!.live).toBe("working through the ladder");
    expect(live[0]!.status).toBe("streaming");
  });
});

describe("ledgerBlocks and mergeLedgerEvents, over recorded events", () => {
  const ledger: ArcJoinLedgerWire = {
    run: "100",
    started_ms: 100_000,
    ended_ms: 131_000,
    events: [
      { seq: 0, at_ms: 100_000, kind: "probe", paths: ["Justfile"] },
      { seq: 1, at_ms: 100_100, kind: "rung", rung: "replay", outcome: "declined", said: "stopped at round 2" },
      { seq: 2, at_ms: 100_200, kind: "rung", rung: "salvage", path: "Justfile", outcome: "declined", said: "no prior chain to salvage from" },
      { seq: 3, at_ms: 100_300, kind: "scribe", path: "Justfile", status: "started" },
      { seq: 4, at_ms: 130_300, kind: "scribe", path: "Justfile", status: "resolved", added: 4, removed: 1 },
      { seq: 5, at_ms: 131_000, kind: "candidate", sha: "9f3c1e2a7", base_sha: "f6de104", files: [{ path: "Justfile", resolved_by: "ai" }] },
      { seq: 6, at_ms: 131_000, kind: "ended", outcome: "candidate" },
    ],
  };

  test("a durable ledger folds into probe, ladder, scribe and candidate, none in flight", () => {
    const blocks = ledgerBlocks({ join: null, durable: ledger, live: EMPTY_LIVE, base: "main", running: false });
    expect(blocks.map((b) => b.kind)).toEqual(["probe", "ladder", "scribe", "candidate"]);
    const ladder = blocks[1]!;
    expect(ladder.identity.text).toContain("2 rungs declined, handed to the scribe");
    expect(ladder.summary).toEqual({ kind: "text", text: "rungs 1–2" });
    const scribe = blocks[2]!;
    expect(scribe.summary).toEqual([
      { kind: "text", text: "rung 5" },
      { kind: "diff", added: 4, removed: 1 },
      { kind: "text", text: "0:30" },
    ]);
    expect(blocks[3]!.summary).toEqual([
      { kind: "count", count: 1, noun: "file" },
      { kind: "text", text: "0:31 in all" },
    ]);
    expect(blocks.every((b) => b.phase === "success")).toBe(true);
  });

  test("a live scribe is the one in-flight block, with its tail as the body", () => {
    const live = {
      run: "100",
      events: ledger.events.slice(0, 4),
      stream: { scribe: { path: "Justfile", text: "build:\n  just test" } },
    };
    const blocks = ledgerBlocks({ join: null, durable: null, live, base: "main", running: true });
    const inFlight = blocks.filter((b) => b.phase === "in_flight");
    expect(inFlight.map((b) => b.kind)).toEqual(["scribe"]);
    expect(inFlight[0]!.live).toBe("merging Justfile");
    expect(inFlight[0]!.body).toEqual({ kind: "scribe-tail", text: "build:\n  just test" });
  });

  test("four declined rungs and a scribe start read handed to the scribe, with the scribe live", () => {
    const declined = (seq: number, rung: "salvage" | "rerere" | "merge-file" | "driver") => ({
      seq,
      at_ms: 100_000 + seq,
      kind: "rung" as const,
      rung,
      path: "Justfile",
      outcome: "declined" as const,
      said: `${rung} declined`,
    });
    const live = {
      run: "300",
      events: [
        { seq: 0, at_ms: 100_000, kind: "probe" as const, paths: ["Justfile"] },
        declined(1, "salvage"),
        declined(2, "rerere"),
        declined(3, "merge-file"),
        declined(4, "driver"),
        { seq: 5, at_ms: 100_005, kind: "scribe" as const, path: "Justfile", status: "started" as const },
      ],
      stream: {},
    };
    const blocks = ledgerBlocks({ join: null, durable: null, live, base: "main", running: true });
    const ladder = blocks.find((b) => b.kind === "ladder")!;
    expect(ladder.identity.path).toBe("Justfile");
    expect(ladder.identity.text).toBe("— 4 rungs declined, handed to the scribe");
    expect(ladder.phase).toBe("success");
    if (ladder.body.kind !== "rungs") throw new Error("unreachable");
    expect(ladder.body.rows.map((r) => r.rung)).toEqual(["salvage", "rerere", "merge-file", "driver"]);
    const scribe = blocks.find((b) => b.kind === "scribe")!;
    expect(scribe.phase).toBe("in_flight");
    expect(scribe.live).toBe("merging Justfile");
  });

  test("the resolver's band follows its last tool, and falls back while it has none", () => {
    const events = [
      { seq: 0, at_ms: 0, kind: "probe" as const, paths: ["Justfile"] },
      { seq: 1, at_ms: 1, kind: "rung" as const, rung: "driver" as const, path: "Justfile", outcome: "declined" as const, said: "no merge driver on PATH" },
      { seq: 2, at_ms: 2, kind: "resolver" as const, turn: 0, status: "started" as const },
    ];
    const at = (stream: { resolver?: { turn: number; text: string; tool?: string } }) =>
      ledgerBlocks({ join: null, durable: null, live: { run: "500", events, stream }, base: "main", running: true }).find(
        (b) => b.kind === "resolver",
      )!;
    const reading = at({});
    expect(reading.phase).toBe("in_flight");
    expect(reading.live).toBe("reading the workshop");
    expect(reading.identity.text).toBe("finishing Justfile");
    const working = at({ resolver: { turn: 1, text: "Both sides edit the recipe.", tool: "Read Justfile" } });
    expect(working.live).toBe("Read Justfile");
    expect(working.body).toEqual({ kind: "words", text: "Both sides edit the recipe." });
    expect(working.summary).toEqual({ kind: "text", text: "turn 1" });
  });

  test("an asked-then-answered audit keeps the exchange in its words", () => {
    const events = [
      { seq: 0, at_ms: 0, kind: "probe" as const, paths: ["Justfile"] },
      { seq: 1, at_ms: 1, kind: "rung" as const, rung: "merge-file" as const, path: "Justfile", outcome: "resolved" as const, said: "merged clean three ways" },
      { seq: 2, at_ms: 2, kind: "resolver" as const, turn: 0, status: "started" as const },
      { seq: 3, at_ms: 3, kind: "resolver" as const, turn: 1, status: "asked" as const, question: "Where does the gate run?" },
      { seq: 4, at_ms: 4, kind: "resolver" as const, turn: 1, status: "turn" as const },
      { seq: 5, at_ms: 5, kind: "resolver" as const, turn: 1, status: "answered" as const, answer: "before the tier" },
      { seq: 6, at_ms: 6, kind: "resolver" as const, turn: 2, status: "turn" as const, text: "Moved the gate." },
      {
        seq: 7,
        at_ms: 7,
        kind: "resolver" as const,
        turn: 2,
        status: "reported" as const,
        notes: "Kept both recipes.",
        files: [{ path: "Justfile", resolved_by: "merge-file", what_each_side_did: "", reconciliation: "both kept", audit: "kept" }],
      },
      { seq: 8, at_ms: 8, kind: "ended" as const, outcome: "candidate" as const },
    ];
    const blocks = ledgerBlocks({ join: null, durable: null, live: { run: "600", events, stream: {} }, base: "main", running: false });
    const resolver = blocks.find((b) => b.kind === "resolver")!;
    expect(resolver.phase).toBe("success");
    expect(resolver.identity.text).toBe("auditing 1 machine-resolved file against the arc's intent");
    const audit = blocks.find((b) => b.kind === "audit")!;
    expect(audit.summary).toEqual([
      { kind: "count", count: 1, noun: "file" },
      { kind: "text", text: "2 turns" },
    ]);
    expect(audit.body).toMatchObject({
      kind: "audit",
      notes: "Kept both recipes.\n\nAsked once — Where does the gate run? — and was told: before the tier.",
    });
  });

  test("an ask the run ended without answering is no longer awaiting", () => {
    const events = [
      { seq: 0, at_ms: 0, kind: "probe" as const, paths: ["Justfile"] },
      { seq: 1, at_ms: 1, kind: "resolver" as const, turn: 0, status: "started" as const },
      { seq: 2, at_ms: 2, kind: "resolver" as const, turn: 1, status: "asked" as const, question: "Where does the gate run?" },
      { seq: 3, at_ms: 3, kind: "ended" as const, outcome: "stuck" as const, detail: "no answer came" },
    ];
    const durable: ArcJoinLedgerWire = { run: "700", started_ms: 0, ended_ms: 3, events };
    const resolver = ledgerBlocks({ join: null, durable, live: EMPTY_LIVE, base: "main", running: false }).find(
      (b) => b.kind === "resolver",
    )!;
    expect(resolver.phase).toBe("success");
  });

  test("a new run over the last run's ended ledger draws its own live block, not the old account", () => {
    const join = { phase: "conflicted", conflicts: ["Justfile"] } as ArcJoinStateWire;
    // Pressed, and nothing heard of the new run yet: the ended ledger is the
    // last run's, and the press still has its one live block.
    const pressed = ledgerBlocks({ join, durable: ledger, live: EMPTY_LIVE, base: "main", running: true });
    expect(pressed.map((b) => b.kind)).toEqual(["probe", "ladder"]);
    expect(pressed[1]!.phase).toBe("in_flight");
    expect(pressed[1]!.live).toBe("working through the ladder");
    // At rest the same ledger is the account it always was.
    const atRest = ledgerBlocks({ join, durable: ledger, live: EMPTY_LIVE, base: "main", running: false });
    expect(atRest.map((b) => b.kind)).toEqual(["probe", "ladder", "scribe", "candidate"]);
    // And a reload mid-run, whose durable ledger has not ended, still draws it.
    const { ended_ms: _ended, ...open } = ledger;
    const midRun: ArcJoinLedgerWire = { ...open, events: ledger.events.slice(0, 4) };
    const reloaded = ledgerBlocks({ join, durable: midRun, live: EMPTY_LIVE, base: "main", running: true });
    expect(reloaded.map((b) => b.kind)).toEqual(["probe", "ladder", "scribe"]);
    expect(reloaded[2]!.phase).toBe("in_flight");
  });

  test("a whole-arc replay reads replayed clean", () => {
    const live = {
      run: "400",
      events: [
        { seq: 0, at_ms: 0, kind: "probe" as const, paths: ["a.ts"] },
        { seq: 1, at_ms: 1, kind: "rung" as const, rung: "replay" as const, outcome: "resolved" as const, said: "every round replayed clean onto the base" },
      ],
      stream: {},
    };
    const ladder = ledgerBlocks({ join: null, durable: null, live, base: "main", running: true }).find(
      (b) => b.kind === "ladder",
    )!;
    expect(ladder.identity.text).toBe("the arc — replayed clean");
  });

  test("live events past the durable ledger's last seq are appended, a newer run replaces it", () => {
    const durable = { ...ledger, events: ledger.events.slice(0, 3) };
    const same = { run: "100", events: ledger.events.slice(2, 5), stream: {} };
    expect(mergeLedgerEvents({ durable, live: same }).map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    const newer = { run: "200", events: [ledger.events[0]!], stream: {} };
    expect(mergeLedgerEvents({ durable, live: newer })).toEqual([ledger.events[0]!]);
    expect(mergeLedgerEvents({ durable, live: EMPTY_LIVE })).toBe(durable.events);
  });

  test("a reload draws the durable ledger alone; no durable ledger draws the live run", () => {
    // Reload: the page heard nothing of the run, the feed carries all of it.
    expect(mergeLedgerEvents({ durable: ledger, live: EMPTY_LIVE })).toBe(ledger.events);
    // Resume: the page heard the same events the durable record already holds,
    // and draws each once.
    const overlap = { run: ledger.run, events: ledger.events, stream: {} };
    expect(mergeLedgerEvents({ durable: ledger, live: overlap }).map((e) => e.seq)).toEqual(
      ledger.events.map((e) => e.seq),
    );
    // No ledger yet on the entry: the live run is the whole account.
    const live = { run: "100", events: ledger.events.slice(0, 2), stream: {} };
    expect(mergeLedgerEvents({ durable: null, live })).toBe(live.events);
  });
});

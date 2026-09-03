/**
 * Wire-contract test for the CHANGESET feed types.
 *
 * Validates the shared golden fixture (also deserialized by the Rust side
 * in tugcast-core) against the TS type guards, so a drifted mirror fails
 * here even when tsc is happy.
 */

import { describe, expect, test } from "bun:test";
import golden from "./fixtures/changeset-snapshot.golden.json";
import aggregateGolden from "./fixtures/workspaces-changeset-snapshot.golden.json";
import {
  isChangesetEntry,
  isChangesetFile,
  isChangesetSnapshot,
  isOptionalChangesetDraft,
  isDocumentArcEntry,
  isProjectChangeset,
  isWorkspacesChangesetSnapshot,
  type ChangesetSnapshot,
  type WorkspacesChangesetSnapshot,
} from "@/lib/changeset-types";
import { FeedId } from "@/protocol";

describe("changeset wire contract", () => {
  test("golden fixture satisfies the snapshot guard", () => {
    expect(isChangesetSnapshot(golden)).toBe(true);
    const snapshot = golden as ChangesetSnapshot;
    expect(snapshot.branch).toBe("main");
    expect(snapshot.changesets).toHaveLength(2);
    expect(snapshot.unattributed).toHaveLength(1);

    const [session, arc] = snapshot.changesets;
    expect(session.kind).toBe("session");
    if (session.kind === "session") {
      expect(session.live).toBe(true);
      expect(session.files[1].shared).toBe(true);
    }
    expect(arc.kind).toBe("arc");
    if (arc.kind === "arc") {
      expect(arc.base).toBe("main");
      expect(arc.rounds).toBe(3);
      expect(arc.worktree_dirty).toBe(false);
      // This fixture is deliberately an *older* sender's shape — no id in the
      // key, none of the added fields — so the guard's tolerance for both is
      // covered by a real payload rather than a hand-built one.
      expect(arc.owner_id).toBe("tugarc/fix-join");
      expect(arc.branch).toBeUndefined();
      expect(arc.stage).toBeUndefined();
      expect(arc.bound_sessions).toBeUndefined();
    }
  });

  test("the aggregate fixture carries the extended arc shape", () => {
    const aggregate = aggregateGolden as WorkspacesChangesetSnapshot;
    const arc = aggregate.projects[0].changesets.find((e) => e.kind === "arc");
    expect(arc).toBeDefined();
    if (arc?.kind !== "arc") throw new Error("expected an arc entry");
    // `owner_id` is the opaque owner key; the git ref is its own field.
    expect(arc.owner_id).toBe("tugarc/fix-join#1723500000000-a1b2c3");
    expect(arc.branch).toBe("tugarc/fix-join");
    expect(arc.stage).toBe("draft-ready");
    expect(arc.bound_sessions).toEqual([
      "sess-0197a2b4-c8d1-7e02-9f3a-b5c6d7e8f901",
    ]);
    // Phase 3's slots are declared but not yet sent.
    expect(arc.step_current).toBeUndefined();
    expect(arc.step_total).toBeUndefined();
  });

  test("the arc guard rejects wrong types on the added fields", () => {
    const base = {
      kind: "arc",
      owner_id: "tugarc/x",
      display_name: "x",
      base: "main",
      rounds: 0,
      worktree: ".tug/worktrees/x",
      worktree_dirty: false,
      files: [],
    };
    expect(isChangesetEntry(base)).toBe(true);
    expect(isChangesetEntry({ ...base, branch: 7 })).toBe(false);
    expect(isChangesetEntry({ ...base, stage: {} })).toBe(false);
    expect(isChangesetEntry({ ...base, bound_sessions: "sess-1" })).toBe(false);
    expect(isChangesetEntry({ ...base, bound_sessions: [1] })).toBe(false);
    expect(isChangesetEntry({ ...base, step_total: "3" })).toBe(false);
    // The run's counters are optional both ways: absent from every arc-log
    // written before runs were declared, a number once one is.
    expect(isChangesetEntry({ ...base, run_position: 2, run_length: 3 })).toBe(
      true,
    );
    expect(isChangesetEntry({ ...base, run_position: "2" })).toBe(false);
    expect(isChangesetEntry({ ...base, run_length: null })).toBe(false);
    // `documents` is optional both ways: absent on an arc with neither
    // document, an object of absolute paths and titles once one exists. Each
    // field inside it is optional and, when present, a string.
    expect(
      isChangesetEntry({
        ...base,
        documents: { plan: "/repo/.tug/arcs/x/plan.md", plan_title: "X" },
      }),
    ).toBe(true);
    expect(isChangesetEntry({ ...base, documents: {} })).toBe(true);
    expect(isChangesetEntry({ ...base, documents: { plan: 7 } })).toBe(false);
    expect(isChangesetEntry({ ...base, documents: { brief: null } })).toBe(
      false,
    );
    expect(isChangesetEntry({ ...base, documents: 7 })).toBe(false);
    expect(isChangesetEntry({ ...base, documents: null })).toBe(false);
    // The ledger is optional both ways: the wire skips it entirely for an arc
    // driving no plan, and a whole array of `{title, status}` arrives once one
    // is. A row missing either half is drift, not a sparse row — a step list
    // that cannot say what a step is or where it stands is not a step list.
    expect(
      isChangesetEntry({
        ...base,
        steps: [{ title: "Do it", status: "in progress" }],
      }),
    ).toBe(true);
    expect(isChangesetEntry({ ...base, steps: [] })).toBe(true);
    expect(isChangesetEntry({ ...base, steps: [{ title: "Do it" }] })).toBe(
      false,
    );
    expect(isChangesetEntry({ ...base, steps: ["Do it"] })).toBe(false);
    expect(isChangesetEntry({ ...base, steps: null })).toBe(false);
    // `last_activity` is an ISO-8601 string or nothing. A number — an epoch
    // millisecond count, the plausible drift — is not a date this side parses.
    expect(isChangesetEntry({ ...base, last_activity: "2026-08-14T12:00:00Z" })).toBe(true);
    expect(isChangesetEntry({ ...base, last_activity: 1_755_000_000_000 })).toBe(false);
  });

  test("guards reject shape drift", () => {
    expect(isChangesetSnapshot({})).toBe(false);
    expect(isChangesetSnapshot(null)).toBe(false);
    expect(isChangesetEntry({ kind: "session", owner_id: "x" })).toBe(false);
    expect(isChangesetEntry({ kind: "branch", owner_id: "x", display_name: "x", files: [] })).toBe(
      false,
    );
    expect(
      isChangesetFile({
        path: "a",
        git_status: ".M",
        op: "edit",
        origin: "exact",
        shared: false,
        last_touched: "not-a-number",
      }),
    ).toBe(false);

    const missingUnattributed = { ...(golden as Record<string, unknown>) };
    delete missingUnattributed.unattributed;
    expect(isChangesetSnapshot(missingUnattributed)).toBe(false);
  });

  test("file guard is tolerant of shared_with's absence and strict about its shape", () => {
    const base = {
      path: "a",
      git_status: ".M",
      op: "edit",
      origin: "exact",
      shared: true,
      last_touched: 1,
    };
    // A pre-plan server sends no `shared_with` at all.
    expect(isChangesetFile(base)).toBe(true);
    expect(
      isChangesetFile({
        ...base,
        shared_with: [{ id: "s1", name: "probe", live: false }],
      }),
    ).toBe(true);
    expect(
      isChangesetFile({ ...base, shared_with: [{ id: "s1", name: "probe" }] }),
    ).toBe(false);
    expect(isChangesetFile({ ...base, shared_with: "probe" })).toBe(false);
  });

  test("draft guard accepts old and new shapes", () => {
    // Pre-edited/selection shape (legacy wire) is still valid.
    expect(
      isOptionalChangesetDraft({ fingerprint: "fp", message: "m", updated_at: 1 }),
    ).toBe(true);
    // The extended shape rides through.
    expect(
      isOptionalChangesetDraft({
        fingerprint: "fp",
        message: "m",
        updated_at: 1,
        edited: true,
        selection: { include: ["a.rs"], exclude: [] },
      }),
    ).toBe(true);
    // Absent draft is valid; malformed extensions are not.
    expect(isOptionalChangesetDraft(undefined)).toBe(true);
    expect(
      isOptionalChangesetDraft({
        fingerprint: "fp",
        message: "m",
        updated_at: 1,
        edited: "yes",
      }),
    ).toBe(false);
    expect(
      isOptionalChangesetDraft({
        fingerprint: "fp",
        message: "m",
        updated_at: 1,
        selection: { include: [42] },
      }),
    ).toBe(false);
  });

  test("CHANGESET feed id is registered at 0x23", () => {
    expect(FeedId.CHANGESET).toBe(0x23);
  });
});

describe("aggregate changeset wire contract", () => {
  test("golden fixture satisfies the aggregate guard", () => {
    expect(isWorkspacesChangesetSnapshot(aggregateGolden)).toBe(true);
    const snapshot = aggregateGolden as WorkspacesChangesetSnapshot;
    expect(snapshot.projects).toHaveLength(2);

    const [repo, nonRepo] = snapshot.projects;
    expect(repo.display_name).toBe("tugtool");
    expect(repo.no_repo).toBe(false);
    // The per-project payload is flattened onto the project (Spec S06).
    expect(repo.branch).toBe("main");
    expect(repo.workspace_key).toBe("a1b2c3d4e5f60718");
    expect(repo.changesets).toHaveLength(2);
    expect(repo.unattributed).toHaveLength(1);

    expect(nonRepo.display_name).toBe("scratchpad");
    expect(nonRepo.no_repo).toBe(true);
    expect(nonRepo.branch).toBe("");
    expect(nonRepo.changesets).toHaveLength(0);
  });

  test("a document-only arc rides the aggregate, guarded field for field", () => {
    const snapshot = aggregateGolden as WorkspacesChangesetSnapshot;
    const planning = snapshot.projects[0]!.document_arcs;
    expect(planning).toHaveLength(2);
    const first = planning![0]!;
    expect(first.display_name).toBe("arc-cockpit");
    // Absolute, because the deck composes nothing: it is handed the path.
    expect(first.documents.plan).toBe("/repo/.tug/arcs/arc-cockpit/plan.md");
    expect(first.documents.brief_title).toBe("The arc cockpit");
    expect(first.review).toBe("reviewed");
    expect([first.steps_done, first.steps_begun]).toEqual([1, 2]);
    // A project with none carries no key at all, so an older sender decodes.
    expect(snapshot.projects[1]!.document_arcs).toBeUndefined();

    expect(isDocumentArcEntry(first)).toBe(true);
    // The documents object is required — a row with no document is not a row.
    const { documents: _dropped, ...documentless } = first;
    expect(isDocumentArcEntry(documentless)).toBe(false);
    expect(isDocumentArcEntry({ ...first, step_total: "3" })).toBe(false);
    expect(isDocumentArcEntry({ ...first, owner_id: 7 })).toBe(false);
    // `review` is optional: an arc with a brief and no plan has none.
    const { review: _review, ...unreviewed } = first;
    expect(isDocumentArcEntry(unreviewed)).toBe(true);
  });

  test("aggregate guards reject shape drift", () => {
    expect(isWorkspacesChangesetSnapshot({})).toBe(false);
    expect(isWorkspacesChangesetSnapshot(null)).toBe(false);
    // A project missing its identity fields is not a ProjectChangeset even
    // though it is a valid ChangesetSnapshot.
    expect(isProjectChangeset(golden)).toBe(false);
    // A project missing the flattened snapshot payload is rejected too.
    expect(
      isProjectChangeset({ project_dir: "/x", display_name: "x", no_repo: true }),
    ).toBe(false);
  });


  test("the fixture's arc carries its join block, field for field", () => {
    const arc = golden.changesets.find((e) => e.kind === "arc");
    if (arc?.kind !== "arc") throw new Error("expected an arc entry");
    const join = arc.join;
    expect(join).toBeDefined();
    if (!join) throw new Error("expected a join block");

    expect(join.phase).toBe("resolved");
    expect(join.candidate).toBe("9f1c2d3e4b5a60718293a4b5c6d7e8f901234567");
    expect(join.reviewed).toBe(false);
    expect(join.conflicts).toEqual(["tugrust/crates/tugtool/src/commands/arc.rs"]);
    expect(join.archaeology?.[0]?.total).toBe(1);
    expect(join.archaeology?.[0]?.commits?.[0]?.sha).toBe("3722f24");

    // The review payload's two halves: the diff (recomputed server-side from
    // git) and the rung (persisted, because git cannot answer it).
    expect(join.resolved).toHaveLength(1);
    expect(join.resolved?.[0]?.resolved_by).toBe("driver");
    expect(join.resolved?.[0]?.diff).toContain("@@");
    expect(join.resolved?.[0]?.added).toBe(1);
    expect(join.resolved?.[0]?.removed).toBe(1);

  });

  test("an arc entry with no join block still parses", () => {
    // An older server sends none, and absence has to read as "nothing to say"
    // rather than as a parse failure — otherwise a version skew drops the whole
    // entry and the card shows no arc at all.
    const joinless = {
      kind: "arc",
      owner_id: "tugarc/x",
      display_name: "x",
      base: "main",
      rounds: 0,
      worktree: "/repo/.tug/worktrees/x",
      worktree_dirty: false,
      files: [],
    };
    expect(isChangesetEntry(joinless)).toBe(true);
  });

  test("the arc guard admits absence and every sparse shape, and rejects drift", () => {
    const withArc = (arc: unknown) => ({
      kind: "arc",
      owner_id: "tugarc/x",
      display_name: "x",
      base: "main",
      rounds: 0,
      worktree: "/repo/.tug/worktrees/x",
      worktree_dirty: false,
      files: [],
      arc,
    });

    // No arc at all is the ordinary case — most arcs are hand-driven, and a
    // server that predates arcs sends nothing. Both have to read as an entry.
    expect(isChangesetEntry(withArc(undefined))).toBe(true);
    // Every field is optional: an arc that has started but not yet rotated has
    // no stage to name, and saying so is not drift.
    expect(isChangesetEntry(withArc({}))).toBe(true);
    expect(isChangesetEntry(withArc({ stage: "devise" }))).toBe(true);
    expect(
      isChangesetEntry(
        withArc({ stage: "review", stopped: "lint failed", stopped_stage: "review" }),
      ),
    ).toBe(true);
    expect(isChangesetEntry(withArc({ stage: "implement", done: true }))).toBe(true);

    // Drift is rejected rather than passed through, so a surface reading
    // `arc.stopped` can trust it is a string it can render.
    expect(isChangesetEntry(withArc({ stage: 3 }))).toBe(false);
    expect(isChangesetEntry(withArc({ stopped: true }))).toBe(false);
    expect(isChangesetEntry(withArc({ stopped_stage: 1 }))).toBe(false);
    expect(isChangesetEntry(withArc({ done: "yes" }))).toBe(false);
    expect(isChangesetEntry(withArc("devise"))).toBe(false);
  });

  test("the join guard rejects shape drift rather than passing it through", () => {
    const withJoin = (join: unknown) => ({
      kind: "arc",
      owner_id: "tugarc/x",
      display_name: "x",
      base: "main",
      rounds: 0,
      worktree: "/repo/.tug/worktrees/x",
      worktree_dirty: false,
      files: [],
      join,
    });

    // A sparse block is the ordinary case — the wire skips empty collections.
    expect(isChangesetEntry(withJoin({ phase: "previewed" }))).toBe(true);
    // …but the one required field really is required.
    expect(isChangesetEntry(withJoin({}))).toBe(false);
    expect(isChangesetEntry(withJoin({ phase: 3 }))).toBe(false);
    // A resolved file without its rung would render as a diff nobody can
    // attribute, which is the signal the review panel exists to carry.
    expect(
      isChangesetEntry(withJoin({ phase: "resolved", resolved: [{ path: "a" }] })),
    ).toBe(false);
    expect(
      isChangesetEntry(
        withJoin({ phase: "blocked", blockers: [{ kind: "empty" }] }),
      ),
    ).toBe(false);
    expect(isChangesetEntry(withJoin({ phase: "resolved", candidate: 7 }))).toBe(false);
  });

  test("the live-run fact round-trips, and absence means nothing is running", () => {
    const withJoin = (join: unknown) => ({
      kind: "arc",
      owner_id: "tugarc/x",
      display_name: "x",
      base: "main",
      rounds: 0,
      worktree: "/repo/.tug/worktrees/x",
      worktree_dirty: false,
      files: [],
      join,
    });

    const running: unknown = withJoin({ phase: "conflicted", run: "resolve" });
    if (!isChangesetEntry(running) || running.kind !== "arc") {
      throw new Error("expected an arc entry carrying a live run");
    }
    expect(running.join?.run).toBe("resolve");

    // The server skips the field entirely when nothing holds the arc, so
    // absence is the ordinary case and must not read as drift.
    expect(isChangesetEntry(withJoin({ phase: "conflicted" }))).toBe(true);
    expect(isChangesetEntry(withJoin({ phase: "conflicted", run: 1 }))).toBe(false);
  });

  test("CHANGESET_ALL feed id is registered at 0x24", () => {
    expect(FeedId.CHANGESET_ALL).toBe(0x24);
  });

  test("the fixture's arc carries its resolve receipt, field for field", () => {
    const aggregate = aggregateGolden as WorkspacesChangesetSnapshot;
    const arc = aggregate.projects[0].changesets.find((e) => e.kind === "arc");
    if (arc?.kind !== "arc") throw new Error("expected an arc entry");
    const receipt = arc.join?.resolved_base;
    expect(receipt).toBeDefined();
    expect(receipt?.seq).toBe(12);
    expect(receipt?.commit).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
    expect(receipt?.base).toBe("main");
    expect(receipt?.folded).toEqual([
      "tugrust/crates/tugtool/src/commands/arc.rs",
    ]);
    expect(receipt?.dropped).toEqual([]);
    expect(receipt?.folded_from).toEqual({
      "tugrust/crates/tugtool/src/commands/arc.rs": "other-session",
    });
  });

  test("the join guard rejects a resolve receipt with a non-numeric seq", () => {
    const withJoin = (join: unknown) => ({
      kind: "arc",
      owner_id: "tugarc/x",
      display_name: "x",
      base: "main",
      rounds: 0,
      worktree: "/repo/.tug/worktrees/x",
      worktree_dirty: false,
      files: [],
      join,
    });

    const receipt = { seq: 3, base: "main", folded: ["a.ts"] };
    expect(
      isChangesetEntry(withJoin({ phase: "blocked", resolved_base: receipt })),
    ).toBe(true);
    // The seq is what an Undo names, so a receipt carrying a string there
    // would offer a control that cannot address anything.
    expect(
      isChangesetEntry(
        withJoin({
          phase: "blocked",
          resolved_base: { ...receipt, seq: "3" },
        }),
      ),
    ).toBe(false);
    // …and a holder map whose values are not names is not a holder map.
    expect(
      isChangesetEntry(
        withJoin({
          phase: "blocked",
          resolved_base: { ...receipt, folded_from: { "a.ts": 7 } },
        }),
      ),
    ).toBe(false);
    // Absent is the ordinary case — most arcs have had no fold.
    expect(isChangesetEntry(withJoin({ phase: "blocked" }))).toBe(true);
  });
});

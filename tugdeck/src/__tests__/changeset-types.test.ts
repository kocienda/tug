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

    const [session, dash] = snapshot.changesets;
    expect(session.kind).toBe("session");
    if (session.kind === "session") {
      expect(session.live).toBe(true);
      expect(session.files[1].shared).toBe(true);
    }
    expect(dash.kind).toBe("dash");
    if (dash.kind === "dash") {
      expect(dash.base).toBe("main");
      expect(dash.rounds).toBe(3);
      expect(dash.worktree_dirty).toBe(false);
      // This fixture is deliberately an *older* sender's shape — no id in the
      // key, none of the added fields — so the guard's tolerance for both is
      // covered by a real payload rather than a hand-built one.
      expect(dash.owner_id).toBe("tugdash/fix-join");
      expect(dash.branch).toBeUndefined();
      expect(dash.stage).toBeUndefined();
      expect(dash.bound_sessions).toBeUndefined();
    }
  });

  test("the aggregate fixture carries the extended dash shape", () => {
    const aggregate = aggregateGolden as WorkspacesChangesetSnapshot;
    const dash = aggregate.projects[0].changesets.find((e) => e.kind === "dash");
    expect(dash).toBeDefined();
    if (dash?.kind !== "dash") throw new Error("expected a dash entry");
    // `owner_id` is the opaque owner key; the git ref is its own field.
    expect(dash.owner_id).toBe("tugdash/fix-join#1723500000000-a1b2c3");
    expect(dash.branch).toBe("tugdash/fix-join");
    expect(dash.stage).toBe("draft-ready");
    expect(dash.bound_sessions).toEqual([
      "sess-0197a2b4-c8d1-7e02-9f3a-b5c6d7e8f901",
    ]);
    // Phase 3's slots are declared but not yet sent.
    expect(dash.step_current).toBeUndefined();
    expect(dash.step_total).toBeUndefined();
  });

  test("the dash guard rejects wrong types on the added fields", () => {
    const base = {
      kind: "dash",
      owner_id: "tugdash/x",
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
    // The run's counters are optional both ways: absent from every dash-log
    // written before runs were declared, a number once one is.
    expect(isChangesetEntry({ ...base, run_position: 2, run_length: 3 })).toBe(
      true,
    );
    expect(isChangesetEntry({ ...base, run_position: "2" })).toBe(false);
    expect(isChangesetEntry({ ...base, run_length: null })).toBe(false);
    // `plan_path` is optional both ways: absent on every dash no run has
    // stepped, a worktree-relative string once one has.
    expect(isChangesetEntry({ ...base, plan_path: "dash/plan.md" })).toBe(true);
    expect(isChangesetEntry({ ...base, plan_path: 7 })).toBe(false);
    expect(isChangesetEntry({ ...base, plan_path: null })).toBe(false);
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


  test("the fixture's dash carries its join block, field for field", () => {
    const dash = golden.changesets.find((e) => e.kind === "dash");
    if (dash?.kind !== "dash") throw new Error("expected a dash entry");
    const join = dash.join;
    expect(join).toBeDefined();
    if (!join) throw new Error("expected a join block");

    expect(join.phase).toBe("resolved");
    expect(join.candidate).toBe("9f1c2d3e4b5a60718293a4b5c6d7e8f901234567");
    expect(join.reviewed).toBe(false);
    expect(join.conflicts).toEqual(["tugrust/crates/tugutil/src/commands/dash.rs"]);
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

  test("a dash entry with no join block still parses", () => {
    // An older server sends none, and absence has to read as "nothing to say"
    // rather than as a parse failure — otherwise a version skew drops the whole
    // entry and the card shows no dash at all.
    const joinless = {
      kind: "dash",
      owner_id: "tugdash/x",
      display_name: "x",
      base: "main",
      rounds: 0,
      worktree: "/repo/.tug/worktrees/x",
      worktree_dirty: false,
      files: [],
    };
    expect(isChangesetEntry(joinless)).toBe(true);
  });

  test("the join guard rejects shape drift rather than passing it through", () => {
    const withJoin = (join: unknown) => ({
      kind: "dash",
      owner_id: "tugdash/x",
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
      kind: "dash",
      owner_id: "tugdash/x",
      display_name: "x",
      base: "main",
      rounds: 0,
      worktree: "/repo/.tug/worktrees/x",
      worktree_dirty: false,
      files: [],
      join,
    });

    const running: unknown = withJoin({ phase: "conflicted", run: "resolve" });
    if (!isChangesetEntry(running) || running.kind !== "dash") {
      throw new Error("expected a dash entry carrying a live run");
    }
    expect(running.join?.run).toBe("resolve");

    // The server skips the field entirely when nothing holds the dash, so
    // absence is the ordinary case and must not read as drift.
    expect(isChangesetEntry(withJoin({ phase: "conflicted" }))).toBe(true);
    expect(isChangesetEntry(withJoin({ phase: "conflicted", run: 1 }))).toBe(false);
  });

  test("CHANGESET_ALL feed id is registered at 0x24", () => {
    expect(FeedId.CHANGESET_ALL).toBe(0x24);
  });
});

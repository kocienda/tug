/**
 * ChangesRouteController — pure-derivation unit tests ([P07]).
 *
 * `deriveChangesRouteSnapshot` scopes the account-global aggregate
 * (`WorkspacesChangesetSnapshot`) to one card's workspace + session. The
 * committed set is the session's full attributed file list — no per-file
 * election; unattributed and dash files never enter it. Exercised against the
 * shared golden fixture so drift on either side fails.
 */
import { describe, it, expect } from "bun:test";

import {
  deriveChangesRouteSnapshot,
  draftDrifted,
  type ChangesRouteBinding,
} from "@/lib/changes-route-controller";
import type { WorkspacesChangesetSnapshot } from "@/lib/changeset-types";
import golden from "@/__tests__/fixtures/workspaces-changeset-snapshot.golden.json";

const DATA = golden as WorkspacesChangesetSnapshot;

// The tugtool project's binding (workspace_key + the session that owns its
// changeset entry), read from the fixture's first project.
const BINDING: ChangesRouteBinding = {
  tugSessionId: "sess-0197a2b4-c8d1-7e02-9f3a-b5c6d7e8f901",
  workspaceKey: "a1b2c3d4e5f60718",
  projectDir: "/Users/dev/src/tugtool",
};

describe("deriveChangesRouteSnapshot", () => {
  it("selects this card's project by workspace_key", () => {
    const snap = deriveChangesRouteSnapshot(DATA, BINDING);
    expect(snap.project.project_dir).toBe("/Users/dev/src/tugtool");
    expect(snap.project.branch).toBe("main");
  });

  it("marks a matched project composed; the placeholder is not", () => {
    // A workspace the aggregate emitted is a verified, composed frame.
    expect(deriveChangesRouteSnapshot(DATA, BINDING).composed).toBe(true);
    // Before the first emit the fallback placeholder is NOT composed, so an
    // empty view must not read as a verified all-clear ([P02]).
    expect(deriveChangesRouteSnapshot({ projects: [] }, BINDING).composed).toBe(
      false,
    );
  });

  it("matches the session entry by owner_id and collects dashes separately", () => {
    const snap = deriveChangesRouteSnapshot(DATA, BINDING);
    expect(snap.entry?.kind).toBe("session");
    expect(snap.entry?.owner_id).toBe(BINDING.tugSessionId);
    expect(snap.entry?.files.map((f) => f.path)).toEqual([
      "tugdeck/src/lib/changeset-types.ts",
      "tugrust/crates/tugcast/src/feeds/changeset.rs",
    ]);
    // `owner_id` is the dash's opaque owner key, not a git ref — the ref is
    // its own field.
    expect(snap.dashes.map((d) => d.owner_id)).toEqual([
      "tugdash/fix-join#1723500000000-a1b2c3",
    ]);
    expect(snap.dashes.map((d) => d.branch)).toEqual(["tugdash/fix-join"]);
  });

  it("passes the unattributed bucket through", () => {
    const snap = deriveChangesRouteSnapshot(DATA, BINDING);
    expect(snap.unattributed.map((f) => f.path)).toEqual(["notes/scratch.md"]);
  });

  it("passes the orphaned bucket through, never into the commit set", () => {
    const snap = deriveChangesRouteSnapshot(DATA, BINDING);
    expect(snap.orphaned.map((f) => f.path)).toEqual(["notes/orphan.md"]);
    expect(snap.orphaned[0]?.prior_owner_name).toBe("ghost work");
    // An orphan is claimable, never silently committed by this session.
    expect(snap.committedPaths.has("notes/orphan.md")).toBe(false);
  });

  it("commits the session's full attributed set, including shared files", () => {
    const snap = deriveChangesRouteSnapshot(DATA, BINDING);
    // Both attributed files land — an AI session emits one unified changeset.
    expect([...snap.committedPaths].sort()).toEqual([
      "tugdeck/src/lib/changeset-types.ts",
      "tugrust/crates/tugcast/src/feeds/changeset.rs",
    ]);
  });

  it("never commits unattributed files", () => {
    const snap = deriveChangesRouteSnapshot(DATA, BINDING);
    // notes/scratch.md is unattributed — shown for awareness, never in this
    // session's commit.
    expect(snap.committedPaths.has("notes/scratch.md")).toBe(false);
  });

  it("dash files never enter the committed set", () => {
    const snap = deriveChangesRouteSnapshot(DATA, BINDING);
    expect(
      snap.committedPaths.has("tugrust/crates/tugtool/src/commands/dash.rs"),
    ).toBe(false);
  });

  it("falls back to a placeholder project when the feed hasn't emitted it", () => {
    const snap = deriveChangesRouteSnapshot({ projects: [] }, BINDING);
    expect(snap.entry).toBeNull();
    expect(snap.dashes).toEqual([]);
    expect(snap.unattributed).toEqual([]);
    expect(snap.project.display_name).toBe("tugtool");
    expect(snap.project.workspace_key).toBe("a1b2c3d4e5f60718");
    expect(snap.committedPaths.size).toBe(0);
  });

  it("returns a null entry when no session owns a changeset in this workspace", () => {
    const snap = deriveChangesRouteSnapshot(DATA, {
      ...BINDING,
      tugSessionId: "sess-unknown",
    });
    expect(snap.entry).toBeNull();
    // The dash + unattributed bucket still belong to the project.
    expect(snap.dashes).toHaveLength(1);
    // A session with no attributed files commits nothing — it never sweeps up
    // another session's unattributed work.
    expect(snap.committedPaths.size).toBe(0);
  });
});

describe("draftDrifted", () => {
  it("plumbs the drift boolean from file touches vs the draft timestamp", () => {
    const snap = deriveChangesRouteSnapshot(DATA, BINDING);
    const entry = snap.entry;
    expect(entry).not.toBeNull();
    // Fixture: draft.updated_at (1752264130000) is newer than both files'
    // last_touched — no drift.
    expect(draftDrifted(entry)).toBe(false);
    // A file touched after the draft was written → drift.
    const drifted = {
      ...entry!,
      files: entry!.files.map((f, i) =>
        i === 0 ? { ...f, last_touched: 1752264999999 } : f,
      ),
    };
    expect(draftDrifted(drifted)).toBe(true);
    // No draft, no drift.
    expect(draftDrifted({ ...entry!, draft: undefined })).toBe(false);
    expect(draftDrifted(null)).toBe(false);
  });
});

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
  ChangesRouteController,
  type ChangesRouteBinding,
} from "@/lib/changes-route-controller";
import type { ChangesetAllStore } from "@/lib/changeset-all-store";
import type { WorkspacesChangesetSnapshot } from "@/lib/changeset-types";
import { sessionLineStore } from "@/lib/session-line-store";
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

// ---------------------------------------------------------------------------
// The request identity ([B01], [B02])
// ---------------------------------------------------------------------------

/**
 * The card's binding id after a rotation: a demoted segment of the line the
 * server now seats elsewhere. This is the shape of the incident — the display
 * resolved through the line, and the requests did not.
 */
const RETIRED_SEGMENT = "sess-0197a2b4-c8d1-7e02-9f3a-000000000000";
const LINE = "line-8530e2a8-ba99-4151-99bf-84fc9fe5b7ca";
const SEAT = "sess-0197a2b4-c8d1-7e02-9f3a-b5c6d7e8f901";

/** The fixture with the session entry seated on `SEAT` and carrying `LINE`. */
function rotatedData(): WorkspacesChangesetSnapshot {
  return {
    ...DATA,
    projects: DATA.projects.map((project) =>
      project.workspace_key !== BINDING.workspaceKey
        ? project
        : {
            ...project,
            changesets: project.changesets.map((changeset) =>
              changeset.kind === "session"
                ? { ...changeset, owner_id: SEAT, line_id: LINE }
                : changeset,
            ),
          },
    ),
  };
}

/**
 * A minimal stand-in for the app-level aggregate store. `publish` swaps the
 * snapshot and fires the listeners, which is the same path a CHANGESET_ALL
 * frame takes — so a test that moves the seat exercises the controller's real
 * recompute rather than a hook that exists only for tests.
 */
function stubAllStore(initial: WorkspacesChangesetSnapshot): {
  store: ChangesetAllStore;
  publish: (next: WorkspacesChangesetSnapshot) => void;
} {
  let data = initial;
  const listeners = new Set<() => void>();
  const store = {
    getSnapshot: () => data,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ChangesetAllStore;
  return {
    store,
    publish: (next) => {
      data = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("ChangesRouteController.requestOwnerId", () => {
  it("is the displayed entry's owner_id when that differs from the binding", () => {
    // The card is bound to a segment the line has demoted; the server keys the
    // entry by the line's current seat. `lineOf` is what lets the display find
    // it, and the request identity must land on the same entry.
    sessionLineStore.bind(RETIRED_SEGMENT, LINE);
    const controller = new ChangesRouteController(
      { ...BINDING, tugSessionId: RETIRED_SEGMENT },
      stubAllStore(rotatedData()).store,
    );

    expect(controller.getSnapshot().entry?.owner_id).toBe(SEAT);
    expect(controller.requestOwnerId()).toBe(SEAT);
    // The binding id is still what the card was constructed with — the fix is
    // that it is no longer what gets sent.
    expect(controller.tugSessionId).toBe(RETIRED_SEGMENT);
    expect(controller.requestOwnerId()).not.toBe(controller.tugSessionId);

    controller.dispose();
  });

  it("falls back to the binding id when no entry resolved", () => {
    // Nothing in the aggregate belongs to this card, so there is no entry to
    // read an owner off — the binding id is all there is, and sending it is
    // strictly better than sending nothing ([B01]).
    const controller = new ChangesRouteController(
      { ...BINDING, tugSessionId: "sess-nobody-knows-me" },
      stubAllStore(DATA).store,
    );

    expect(controller.getSnapshot().entry).toBeNull();
    expect(controller.requestOwnerId()).toBe("sess-nobody-knows-me");

    controller.dispose();
  });

  it("is the binding id when the card is seated on its own entry", () => {
    // The unrotated case must be unchanged: one reading of identity means the
    // same answer display and request alike, not a different one.
    const controller = new ChangesRouteController(
      BINDING,
      stubAllStore(DATA).store,
    );

    expect(controller.requestOwnerId()).toBe(BINDING.tugSessionId);

    controller.dispose();
  });

  it("is a derivation, not a value frozen at construction ([B02])", () => {
    // The seat can move while the card is alive — that is what a rotation is.
    // A request identity read once in the constructor would be the same defect
    // one rotation along, so the store's snapshot is what it reads, every time.
    // Its own segment id, so the module-scope line store carries nothing from
    // the case above into this one.
    const segment = "sess-0197a2b4-c8d1-7e02-9f3a-111111111111";
    const all = stubAllStore(DATA);
    const controller = new ChangesRouteController(
      { ...BINDING, tugSessionId: segment },
      all.store,
    );

    // Before the line is known, nothing resolves and the binding id stands.
    expect(controller.requestOwnerId()).toBe(segment);

    // The rotation lands: the aggregate re-keys the entry and the line pair
    // arrives. The controller recomputes and the request identity moves with
    // the display, without the card being rebuilt.
    sessionLineStore.bind(segment, LINE);
    all.publish(rotatedData());

    expect(controller.requestOwnerId()).toBe(SEAT);

    controller.dispose();
  });
});

/**
 * The landing face's two pure decisions: which act clears a blocker, and what
 * the disabled Join affordance says instead of being silent.
 *
 * The outcome derivation itself is proved next door in
 * `join-mode-controller.test.ts` — the component reads it, it does not own it.
 */

import { describe, expect, it } from "bun:test";

import {
  blockerAct,
  discardPreflightLine,
  resolutionDiffPayload,
  resolutionReviewLine,
} from "@/components/tugways/cards/session-changes/session-changes-dash-landing";
import { joinDisabledReason } from "@/lib/join-mode-controller";
import type { JoinBlocker } from "@/lib/changeset-verb-store";
import type { ResolvedFile } from "@/lib/changeset-join-store";

const blocker = (kind: string, paths: readonly string[] = []): JoinBlocker => ({
  kind,
  detail: `detail for ${kind}`,
  paths,
});

describe("blockerAct", () => {
  it("names the act that clears each kind the server can report", () => {
    expect(blockerAct(blocker("off-base"), "main")).toBe("Check out main first");
    expect(blockerAct(blocker("base-dirt", ["a.ts", "b.ts"]), "main")).toBe(
      "Commit or stash a.ts, b.ts",
    );
    expect(blockerAct(blocker("stale-journal"), "main")).toBe(
      "Resume the interrupted teardown",
    );
    expect(blockerAct(blocker("empty"), "main")).toBe("Discard this dash");
  });

  it("falls back to a pathless sentence when base-dirt names nothing", () => {
    expect(blockerAct(blocker("base-dirt"), "main")).toBe(
      "Commit or stash the overlapping changes",
    );
  });

  it("has no act for a kind it has never heard of, leaving the detail to show", () => {
    expect(blockerAct(blocker("some-future-refusal"), "main")).toBe(null);
  });
});

describe("discardPreflightLine", () => {
  it("names both halves of what the confirm destroys", () => {
    expect(discardPreflightLine(2, 3)).toBe("Discards 2 rounds · 3 files");
  });

  it("uses the singular where the singular is true", () => {
    expect(discardPreflightLine(1, 1)).toBe("Discards 1 round · 1 file");
  });

  it("omits the half that is zero", () => {
    expect(discardPreflightLine(4, 0)).toBe("Discards 4 rounds");
    expect(discardPreflightLine(0, 2)).toBe("Discards 2 files");
  });

  it("does not invent a stake for a dash with no work", () => {
    expect(discardPreflightLine(0, 0)).toBe("Discards nothing — this dash has no work");
  });
});

describe("joinDisabledReason", () => {
  it("answers with the gate's own reason before it looks at the outcome", () => {
    expect(joinDisabledReason("turn", "clean")).toBe("Wait for the turn to finish");
    expect(joinDisabledReason("pending", "clean")).toBe("Previewing…");
  });

  it("names what the outcome is waiting on", () => {
    expect(joinDisabledReason("outcome", "unknown")).toBe("Not previewed yet");
    expect(joinDisabledReason("outcome", "previewing")).toBe("Previewing…");
    expect(joinDisabledReason("outcome", "conflicted")).toBe(
      "Resolve the conflicts first",
    );
    expect(joinDisabledReason("outcome", "blocked")).toBe(
      "Clear what blocks this join first",
    );
    expect(joinDisabledReason("outcome", "empty")).toBe("Nothing to join");
  });
});

describe("resolutionDiffPayload", () => {
  const file = (
    path: string,
    resolvedBy: string,
    diff: string | null,
    added: number | null = null,
    removed: number | null = null,
  ): ResolvedFile => ({ path, resolvedBy, diff, added, removed });

  const modified = [
    "diff --git a/a.ts b/a.ts",
    "index 111..222 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,3 +1,3 @@",
    " keep",
    "-was",
    "+is",
    "+extra",
  ].join("\n");

  it("carries the server's counts through to the payload", () => {
    const payload = resolutionDiffPayload([file("a.ts", "rerere", modified, 2, 1)], "ws");
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]).toMatchObject({
      path: "a.ts",
      status: "modified",
      added: 2,
      removed: 1,
      binary: false,
      unified: modified,
    });
    expect(payload.total_added).toBe(2);
    expect(payload.total_removed).toBe(1);
    expect(payload.file_count).toBe(1);
  });

  it("reports the whole resolution when the diff text it ships is capped", () => {
    // The `+0 −395` incident. The server caps the diff, and git emits deletions
    // before additions, so a large resolution's single `+` line falls past the
    // cap — the text here has 3 deletions and no addition at all. Counting it
    // would report a resolution that added nothing; the counts say otherwise,
    // and the counts are what land.
    const capped = [
      "diff --git a/big.ts b/big.ts",
      "--- a/big.ts",
      "+++ b/big.ts",
      "@@ -1,2050 +1 @@",
      "-line 1",
      "-line 2",
      "-line 3",
      "… 2048 more lines",
    ].join("\n");
    const payload = resolutionDiffPayload([file("big.ts", "driver", capped, 1, 2050)], "ws");
    expect(payload.files[0]).toMatchObject({ added: 1, removed: 2050, unified: capped });
    expect(payload.total_added).toBe(1);
    expect(payload.total_removed).toBe(2050);
  });

  it("renders an absent count as zero and still shows the diff", () => {
    // A binary path: git reports `-` rather than a line count, so there is no
    // number to show — but there is still a resolution to review.
    const payload = resolutionDiffPayload([file("a.ts", "driver", modified)], "ws");
    expect(payload.files[0]).toMatchObject({ added: 0, removed: 0, unified: modified });
    expect(payload.total_added).toBe(0);
    expect(payload.file_count).toBe(1);
  });

  it("reads create and delete off the header git already wrote", () => {
    const created = "diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n+one\n";
    const deleted = "diff --git a/g.ts b/g.ts\ndeleted file mode 100644\n--- a/g.ts\n+++ /dev/null\n-one\n";
    const payload = resolutionDiffPayload(
      [file("n.ts", "ai", created), file("g.ts", "driver", deleted)],
      "ws",
    );
    expect(payload.files.map((f) => f.status)).toEqual(["added", "deleted"]);
  });

  it("drops a resolution with no diff rather than showing an empty row", () => {
    // A file the ladder resolved to exactly what the base already has changes
    // nothing; an accordion row for it would read as though it did.
    const payload = resolutionDiffPayload(
      [file("a.ts", "rerere", modified), file("b.ts", "rerere", null)],
      "ws",
    );
    expect(payload.files.map((f) => f.path)).toEqual(["a.ts"]);
  });
});

describe("resolutionReviewLine", () => {
  it("names the count and every rung that decided, deduplicated", () => {
    expect(
      resolutionReviewLine([
        { path: "a.ts", resolvedBy: "rerere", diff: "d", added: null, removed: null },
        { path: "b.ts", resolvedBy: "ai", diff: "d", added: null, removed: null },
        { path: "c.ts", resolvedBy: "rerere", diff: "d", added: null, removed: null },
      ]),
    ).toBe("3 files resolved by ai, rerere — read this before it lands");
  });

  it("agrees with itself in the singular", () => {
    expect(resolutionReviewLine([{ path: "a.ts", resolvedBy: "rerere", diff: "d", added: null, removed: null }])).toBe(
      "1 file resolved by rerere — read this before it lands",
    );
  });
});

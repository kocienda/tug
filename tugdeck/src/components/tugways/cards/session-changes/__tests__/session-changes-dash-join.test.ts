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
} from "@/components/tugways/cards/session-changes/session-changes-dash-join";
import { joinDisabledReason } from "@/lib/join-mode-controller";
import type { DashJoinBlockerWire, DashResolvedFileWire } from "@/lib/changeset-types";

const blocker = (kind: string, paths: string[] = []): DashJoinBlockerWire => ({
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
    expect(joinDisabledReason("pending", "clean")).toBe("Joining…");
  });

  it("names what the outcome is waiting on", () => {
    expect(joinDisabledReason("outcome", "stale", "the dash has moved")).toBe(
      "the dash has moved",
    );
    expect(joinDisabledReason("outcome", "conflicted")).toBe(
      "Resolve the conflicts first",
    );
    expect(joinDisabledReason("outcome", "blocked")).toBe(
      "Clear what blocks this join first",
    );
    expect(joinDisabledReason("outcome", "empty")).toBe("Nothing to join");
  });
});


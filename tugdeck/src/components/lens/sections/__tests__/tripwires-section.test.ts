/**
 * The Tripwires section's collapsed summary — the one line the band shows when
 * the section is folded, and the whole reason the surface is a Lens section
 * rather than a card.
 *
 * The law it pins is that the line says only what is true: a count that is zero
 * is absent, not printed as a zero, and a machine holding tripwires is never
 * silent, because armed and paused between them account for every row.
 */

import { describe, expect, test } from "bun:test";

import { tripwiresCollapsedSummary } from "../tripwires-section";
import type { TripwireRow } from "@/lib/tripwires-store";

function row(over: Partial<TripwireRow> = {}): TripwireRow {
  return {
    name: "ci",
    trigger: '{"commit":{}}',
    scope: null,
    probe: null,
    brief: "watch it",
    model: null,
    tier: "auto",
    permission_mode: "default",
    post: "auto",
    paused: false,
    cooldown_secs: 0,
    running: false,
    staged_dash: null,
    last_trip: null,
    ...over,
  };
}

describe("the Tripwires band's collapsed summary", () => {
  test("an empty machine says so rather than counting to zero", () => {
    expect(tripwiresCollapsedSummary([])).toBe("No tripwires");
  });

  test("a quiet roster is just its armed count", () => {
    expect(tripwiresCollapsedSummary([row(), row({ name: "b" })])).toBe("2 armed");
  });

  test("every count that is zero is absent, and the rest read in order", () => {
    const rows = [
      row({ name: "a", running: true }),
      row({ name: "b", staged_dash: "tripwire-b-abc1234d" }),
      row({ name: "c", paused: true }),
    ];
    expect(tripwiresCollapsedSummary(rows)).toBe("2 armed · 1 paused · 1 running · 1 staged");
  });

  test("a roster that is entirely paused still says something", () => {
    // The failure this rules out is a band reading "0 armed" — true, useless,
    // and the shape a summary that always printed its first count would take.
    expect(tripwiresCollapsedSummary([row({ paused: true })])).toBe("1 paused");
  });
});

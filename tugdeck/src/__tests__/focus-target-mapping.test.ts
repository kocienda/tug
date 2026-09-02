/**
 * focus-target-mapping.test.ts — the pure shape mapping from persisted
 * `bag.focus` snapshots to the focus engine's unified `FocusTarget`
 * descriptor. All four legacy snapshot shapes must keep restoring without
 * a tugbank migration, so this mapping is pinned exactly.
 */

import { describe, expect, test } from "bun:test";

import { focusSnapshotToTarget } from "../focus-transfer";

describe("focusSnapshotToTarget", () => {
  test("absent / null / none map to a none target", () => {
    expect(focusSnapshotToTarget(undefined)).toEqual({
      target: { kind: "none" },
      modality: "pointer",
    });
    expect(focusSnapshotToTarget(null)).toEqual({
      target: { kind: "none" },
      modality: "pointer",
    });
    expect(focusSnapshotToTarget({ kind: "none" })).toEqual({
      target: { kind: "none" },
      modality: "pointer",
    });
  });

  test("dom snapshot maps to focus-key; keyboard flag carries the ring", () => {
    expect(
      focusSnapshotToTarget({
        kind: "dom",
        focusKey: "layout-card-kind:0",
        keyboard: true,
      }),
    ).toEqual({
      target: { kind: "focus-key", focusKey: "layout-card-kind:0" },
      modality: "keyboard",
    });
    expect(
      focusSnapshotToTarget({ kind: "dom", focusKey: "g:2" }),
    ).toEqual({
      target: { kind: "focus-key", focusKey: "g:2" },
      modality: "pointer",
    });
    expect(
      focusSnapshotToTarget({ kind: "dom", focusKey: "g:2", keyboard: false }),
    ).toEqual({
      target: { kind: "focus-key", focusKey: "g:2" },
      modality: "pointer",
    });
  });

  test("form-control snapshot maps to state-key (focus identity implicit in the preservation key)", () => {
    expect(
      focusSnapshotToTarget({
        kind: "form-control",
        componentStatePreservationKey: "picker:model",
      }),
    ).toEqual({
      target: { kind: "state-key", key: "picker:model" },
      modality: "pointer",
    });
  });

  test("engine snapshot maps to the engine target (no ring asserted; the caret is the focus mark)", () => {
    expect(focusSnapshotToTarget({ kind: "engine" })).toEqual({
      target: { kind: "engine" },
      modality: "pointer",
    });
  });
});

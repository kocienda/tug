/**
 * row-45-fit-solved.test.ts — Resize Sidebars to Fit carries every rail
 * member it re-divides to its new height with nothing owed at the land.
 *
 * The leg is `_row-45.ts`'s: a bare rail of Cards and Jots, the verb driven
 * through its View menu item, each member's page laid out at its new height
 * before the motion, and the land empty on both sides for both.
 *
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/components/chrome/deck-canvas.tsx
 * @covers tugapp/Sources/MainWindow.swift
 */

import { describe, test } from "bun:test";

import { SHOULD_RUN, TEST_TIMEOUT_MS, fitLeg } from "./_row-45";

describe.skipIf(!SHOULD_RUN)("body-grounding row 45: resize sidebars to fit", () => {
  test("the verb carries each re-divided member to its height, the land owing nothing", fitLeg, TEST_TIMEOUT_MS);
});

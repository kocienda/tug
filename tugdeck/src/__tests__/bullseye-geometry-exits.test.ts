/**
 * Every geometry write releases the pane it names from bullseye.
 *
 * The rule is stated over WHAT CHANGED, not over which caller changed it:
 * a gesture saying "this pane is exactly this wide, here" and a posture
 * saying "this pane is comfy, centered" cannot both be true, and the
 * explicit gesture wins. `DeckManager._clearBullseyeFor` is its one
 * implementation, and four paths write a pane's `position`, `size`, or
 * `slot`:
 *
 *   - `movePane` — the drag and resize commits, AND every width door, which
 *     reaches it through `_setPaneWidth`. Gated on the `positionChanged ||
 *     sizeChanged` locals it already computes, deliberately not on
 *     `evictSlot`: the width doors never pass that flag, so a gate on it
 *     would miss all of them.
 *   - `setContentWidth` — builds its pane array inline for `_commitImposition`,
 *     bypassing `movePane` entirely.
 *   - `setCardWidths` — the card-addressed width verb, same inline shape.
 *   - `assignCardsToSlots` — writes `slot` on its own path. `assignCardToSlot`
 *     is a one-element batch through it and therefore has no clear of its own.
 *
 * WHAT THIS TEST CATCHES: a clear being dropped from one of the four, and
 * a fifth call site appearing without this file being updated to say why.
 * WHAT IT DOES NOT: a brand-new geometry mutator written with no clear at
 * all — no source grep can see the absence of a call it was never told to
 * expect. The behavioral half is `at0372-bullseye.test.ts`, which drives
 * every exit door through the real app and the real store.
 *
 * A source guard rather than a `DeckManager` suite because the constructor
 * calls `createRoot(container)`: there is no DOM substrate under `bun test`
 * (happy-dom is deleted, jsdom render tests are banned), and hand-rolling a
 * mock store to count method calls is the other banned shape.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(import.meta.dir, "..", "deck-manager.ts"),
  "utf8",
);

/**
 * The body of a two-space-indented class method, from its signature to the
 * closing brace at that indentation. Comments are kept: a commented-out call
 * is caught by the `bodyOf(...)` assertions below only because those look for
 * a live call, so the extraction stays verbatim and the check does the work.
 */
function bodyOf(methodSignature: string): string {
  const start = SRC.indexOf(methodSignature);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SRC.indexOf("\n  }\n", start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

/** Strip comments so a commented-out call does not read as a live one. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("_clearBullseyeFor is called from every geometry-writing path", () => {
  test("movePane clears, gated on what changed rather than on evictSlot", () => {
    const body = stripComments(bodyOf("  movePane("));
    expect(body).toContain("this._clearBullseyeFor(paneId)");
    // The gate is the pair of locals the function already computes. A gate on
    // `evictSlot` would miss every width door, which is the mistake this
    // assertion exists to catch.
    expect(body).toMatch(
      /if\s*\(positionChanged\s*\|\|\s*sizeChanged\)\s*this\._clearBullseyeFor\(paneId\)/,
    );
    expect(body).not.toMatch(/evictSlot[^\n]*_clearBullseyeFor/);
  });

  test("setContentWidth clears — it bypasses movePane", () => {
    const body = stripComments(bodyOf("  setContentWidth("));
    expect(body).toContain("this._clearBullseyeFor(");
  });

  test("assignCardsToSlots clears — it writes slot on its own path", () => {
    const body = stripComments(bodyOf("  assignCardsToSlots("));
    expect(body).toContain("this._clearBullseyeFor(");
  });

  test("assignCardToSlot delegates, so it needs no clear of its own", () => {
    const body = stripComments(bodyOf("  assignCardToSlot("));
    expect(body).toContain("this.assignCardsToSlots(");
    expect(body).not.toContain("_clearBullseyeFor");
  });

  test("movePaneToSlot clears — it writes slot on its own path too", () => {
    // The drop-zone drag's commit ([P10]). Pane-addressed rather than
    // card-addressed, so it does not reach `assignCardsToSlots`' clear and needs
    // its own: a pane dragged out of bullseye into a slot is being re-placed,
    // and a posture that survived the placing would be a resting lie.
    const body = stripComments(bodyOf("  movePaneToSlot("));
    expect(body).toContain("this._clearBullseyeFor(");
  });

  test("setCardWidths clears — it bypasses movePane, as setContentWidth does", () => {
    const body = stripComments(bodyOf("  setCardWidths("));
    expect(body).toContain("this._clearBullseyeFor(");
  });

  test("setPaneFolded clears — folding changes the pane's height", () => {
    // The fold commit ([P01]) builds its pane array inline and hands it to
    // `_commitImposition`, bypassing `movePane` so the settle measures once —
    // the same shape `setCardWidths` takes, and it owes the same clear. A
    // bullseye that survived a fold would be a posture claimed for a card whose
    // transcript is no longer on screen.
    const body = stripComments(bodyOf("  setPaneFolded("));
    expect(body).toContain("this._clearBullseyeFor(");
  });

  test("setCardFolded does NOT clear — it delegates to setPaneFolded", () => {
    const body = stripComments(bodyOf("  setCardFolded("));
    expect(body).not.toContain("_clearBullseyeFor");
    expect(body).toContain("this.setPaneFolded(");
  });

  test("_setPaneWidth does NOT clear — it reaches movePane, and one rule is enough", () => {
    const body = stripComments(bodyOf("  private _setPaneWidth("));
    expect(body).not.toContain("_clearBullseyeFor");
    expect(body).toContain("this.movePane(");
  });

  test("there are exactly six honoring call sites", () => {
    // Pinned so a seventh site cannot arrive without this file being updated
    // to say which path it is and why it needs its own clear.
    const calls = stripComments(SRC).match(/this\._clearBullseyeFor\(/g) ?? [];
    expect(calls.length).toBe(6);
  });
});

describe("the focus-shaped exit clears from the one flip funnel", () => {
  // The other half of the rule, and a different shape: geometry writes are
  // many sites honoring one helper, while every focus move — the click, the
  // ⌘R picker, the depth and lateral rings, the sidebar chords, the
  // canvas-background deselect — funnels through `_flipFirstResponder`. One
  // call there covers all of them and every path added later.
  //
  // The derived accessor makes a stale id UNREADABLE; this makes it GONE.
  // Both are needed: without the clear, focusing away and back resurrects a
  // posture the user never re-asked for, which is the failure at0372's third
  // exit door caught.
  test("_flipFirstResponder clears before the commit it wraps", () => {
    const body = stripComments(bodyOf("  private _flipFirstResponder("));
    expect(body).toContain("this._clearBullseyeOnFocusFlip(newFR)");
    // Before the `commit()` it wraps, so the clear rides the state
    // replacement that commit is about to notify rather than needing a
    // second notify of its own. `lastIndexOf` because the same-bit branch
    // returns through a `commit()` of its own earlier in the function — that
    // branch is a no-op flip and has nothing to clear.
    expect(body.indexOf("this._clearBullseyeOnFocusFlip(newFR)")).toBeLessThan(
      body.lastIndexOf("commit();"),
    );
  });

  test("it is called from that funnel and nowhere else", () => {
    const calls =
      stripComments(SRC).match(/this\._clearBullseyeOnFocusFlip\(/g) ?? [];
    expect(calls.length).toBe(1);
  });
});

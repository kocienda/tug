/**
 * `addCard({ activate: false })` suppresses **three** things, not one.
 *
 * A card that arrives without taking the user's view is what lets a tripwire's
 * trip open its own Session card while somebody is working ([P08], [B03]). The
 * option reads as one thing and is three, and the third is the one that would
 * be quietly dropped: `addCard` ends by calling `_revealAfterArrival`, which
 * travels the deck to the new card. A card that takes no first responder but
 * scrolls the band to itself has still taken the view, and `activePaneId`
 * would read correct the whole time — so nothing about the deck's state says
 * the promise was broken.
 *
 * This is a **source guard**, in the shape `boot-faithful-restore.test.ts`
 * uses, and that is a deliberate choice rather than a shortcut. `DeckManager`
 * takes an `HTMLElement` and a `TugConnection`; there is no in-process DOM
 * substrate in this suite and hand-rolling one is banned outright. So the
 * behaviour is pinned where the real app can show it —
 * `tests/app-test/at0576-trip-session-card.test.ts` drives a real trip card
 * and asserts the key view and the band are where the user left them — and
 * what is pinned here is the thing an app-test cannot see: that all three
 * branches are still written, so a later edit that drops one fails at once
 * rather than at whatever moment somebody next watches a trip fire.
 *
 * @module __tests__/add-card-activate
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Strip block and line comments, so the prose that explains a suppression is
 *  never mistaken for the code that performs it. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const SRC = stripComments(
  readFileSync(resolve(import.meta.dir, "..", "deck-manager.ts"), "utf8"),
);

/** The `addCard` body: from its signature to the `return firstCardId;` that
 *  ends it, so a match elsewhere in a four-thousand-line file proves nothing
 *  about this method. */
function addCardBody(): string {
  const start = SRC.indexOf("  addCard(");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = SRC.indexOf("return firstCardId;", start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("addCard({ activate: false })", () => {
  test("the option is declared and defaults to activating", () => {
    const body = addCardBody();
    expect(body).toContain("activate?: boolean");
    // `!== false` rather than `=== true`: an omitted option activates, which
    // is every opener but the trip card's.
    expect(body).toContain("options?.activate !== false");
  });

  test("suppression 1: the commit runs without a first-responder flip", () => {
    const body = addCardBody();
    // The flip is conditional, and the same commit runs bare on the other
    // branch — one commit either way, never a flip and a flip back ([L23]).
    expect(body).toMatch(
      /if \(activate\) \{\s*this\._flipFirstResponder\(firstCardId, commit, "addCard"\);\s*\} else \{\s*commit\(\);\s*\}/,
    );
    expect(body).toContain("...(activate ? { activePaneId: paneId } : {})");
  });

  test("suppression 2: the focused card is not rewritten", () => {
    const body = addCardBody();
    expect(body).toMatch(
      /if \(activate\) \{\s*this\.putFocusedCardIdGuarded\(firstCardId\);/,
    );
  });

  test("suppression 3: the band is not travelled to the new card", () => {
    const body = addCardBody();
    // The one that would be dropped without a guard saying so: every
    // `_revealAfterArrival` in `addCard` is behind the flag.
    const reveals = body.match(/_revealAfterArrival\(/g) ?? [];
    expect(reveals.length).toBe(1);
    expect(body).toContain("if (activate) this._revealAfterArrival(firstCardId)");
  });
});

/**
 * row-41-fold-pressed.test.ts — a folded card keeps its body under memory
 * pressure, and its unfold carries that body, holding row 9's carried bar.
 *
 * A fold does not hide a body: every card draws its folded form in its own
 * page and stays shown at the folded rect (`card-placement.ts`), so a folded
 * card is a shown card, and a shown card is never evicted. This row holds
 * that against the strongest pressure there is. A Session card is folded as
 * row 9's unmeasured set-up; while it stands folded, critical pressure — the
 * host's stand-in for the dispatch source, which takes every body the last
 * placement did not name visible, the spare with them — is raised and
 * cleared. The spare goes, which says the pressure ran; the folded card's
 * body stays, shown, on every reading. The unfold is then read exactly as
 * row 9 reads the Session card's: the host carries the same body from its
 * folded strip to its open box, the lid stays lifted, no frame shows the
 * bare window, the content box never shows the floor while the chrome moves,
 * the host's container tracks the placeholder, and it lands on it.
 *
 * @foreground activation
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugdeck/src/lib/card-fold.ts
 */

import { describe, expect, test } from "bun:test";

import { note, type App } from "../_harness";
import { bodyOf } from "./_bodies";
import { SHOULD_RUN, TEST_TIMEOUT_MS, foldSession } from "./_row-09";

/** How long the folded card is read under critical pressure. */
const PRESSED_MS = 1_500;

/** While folded: critical pressure takes the spare and leaves the folded card's body, shown. */
async function pressWhileFolded(app: App, card: string): Promise<void> {
  const folded = await bodyOf(app, card);
  expect(folded, "the folded card's body is placed visible at its folded strip").toMatchObject({ visible: true, shown: true });
  await app.simulateMemoryPressure("critical");
  const until = Date.now() + PRESSED_MS;
  let readings = 0;
  let lost = 0;
  let spare = true;
  while (Date.now() < until) {
    const all = await app.bodies();
    readings += 1;
    const own = all.find((b) => b.cardId === card);
    if (own === undefined || !own.visible) lost += 1;
    spare = all.some((b) => b.cardId === null);
    await Bun.sleep(100);
  }
  await app.simulateMemoryPressure("normal");
  note(`under critical pressure while folded: ${readings} readings, the folded body missing or hidden on ${lost}; the spare ${spare ? "stands" : "is gone"}`);
  expect(spare, "critical pressure ran: the spare is gone").toBe(false);
  expect(lost, "the folded card keeps its body, shown, on every reading under critical pressure").toBe(0);
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 41: a folded card under pressure", () => {
  test(
    "a folded card keeps its body under critical pressure, and the unfold carries it",
    () => foldSession({ foreground: true }, "unfold", pressWhileFolded, "body-grounding-row-41-fold-pressed"),
    TEST_TIMEOUT_MS,
  );
});

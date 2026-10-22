/**
 * _tiers.ts — the tier a row's hidden bodies are put in before its gesture.
 *
 * A row's tier variant runs the row's own set-up and its own gesture with its
 * own bars, and between the two puts every body the host holds hidden into a
 * tier: `dormant` (hidden past the body's `dormantAfterMs`, its subscription
 * dropped and its content lidded) or `evicted` (dormant first, then hidden
 * past the reader's `evictAfterMs`, its page gone). The delays are shortened
 * once the set-up is done, so the set-up runs as the row's does, and put back
 * to their defaults once the tier is reached, so the gesture does too: what
 * differs is only the state the hidden cards are in when it starts. A test
 * write of a tugbank value lands in the page that makes it, so the dormant
 * delay is written in each hidden body, whose clock it is, and the eviction
 * delay in the shell, whose reader tells the host. A hidden card's page may
 * still be loading when the set-up ends — the host stages a page nobody sees
 * behind the ones that are shown, and a shown workspace's card is not shown
 * until its page has loaded and been placed. So the hidden cards are the
 * parked ones — every card with a page that the shown workspace's deck does
 * not hold — read once every page has loaded: a page still loading cannot
 * answer a write, and one in the shown workspace is not parked however it
 * stands at the moment it is read.
 *
 * A variant over a set-up that hides nothing would be the row run twice, so
 * a tier with no hidden body to put in it fails.
 *
 * Not a test: no `describe` here.
 */

import { expect } from "bun:test";

import { note, type App } from "../_harness";
import { pollFor } from "./_bodies";

export type Tier = "dormant" | "evicted";

/** The shortened delays: past the hidden bodies' time hidden, so the tier arrives at once or soon. */
const DORMANT_AFTER_MS = 600;
const EVICT_AFTER_MS = 1_500;
/** The readers' defaults (`dormant-after-pref.ts`, `evict-after-pref.ts`), put back for the gesture. */
const DEFAULT_DORMANT_AFTER_MS = 60_000;
const DEFAULT_EVICT_AFTER_MS = 900_000;

const setDelay = (key: string, ms: number): string =>
  `(window.__tug.setTugbankValue("dev.tugapp.body-dormancy", ${JSON.stringify(key)}, { kind: "i64", value: ${ms} }), null)`;

/** Put every hidden body into `tier`, then give the delays back their defaults. Answers the cards it tiered. */
export async function intoTier(app: App, tier: Tier, label: string): Promise<string[]> {
  const shownDeck = new Set(await app.evalJS<string[]>("window.tugdeck.diag.getDeckState().cards.map(function (c) { return c.id; })"));
  const settled = await pollFor(
    async () => (await app.bodies()).filter((b) => b.cardId !== null),
    (all) => all.every((b) => b.state === "ready"),
    10_000,
  );
  expect(
    settled.filter((b) => b.state !== "ready").map((b) => b.cardId),
    `${label}: every card's page has loaded`,
  ).toEqual([]);
  const hidden = settled.filter((b) => !shownDeck.has(b.cardId!)).map((b) => b.cardId!);
  expect(hidden.length, `${label}: a body is hidden to put in the ${tier} tier`).toBeGreaterThan(0);
  const startedAt = Date.now();
  await Promise.all(hidden.map((id) => app.body(id).evalJS<null>(setDelay("dormantAfterMs", DORMANT_AFTER_MS))));
  const dormant = await pollFor(
    () => Promise.all(hidden.map((id) => app.body(id).evalJS<boolean>("window.__tug.bodyDormancy().dormant").catch(() => false))),
    (all) => all.every((d) => d),
    DORMANT_AFTER_MS + 6_000,
  );
  if (!dormant.every((d) => d)) {
    const readings = await Promise.all(
      hidden.map(async (id) => `${id} ${JSON.stringify(await app.body(id).evalJS<unknown>("window.__tug.bodyDormancy()").catch((e) => String(e)))}`),
    );
    const host = (await app.bodies()).filter((b) => b.cardId !== null && hidden.includes(b.cardId)).map((b) => [b.cardId, b.state, b.visible, b.shown]);
    note(`${label}: not every hidden body slept — pages ${readings.join("; ")}; host ${JSON.stringify(host)}`);
  }
  expect(dormant.every((d) => d), `${label}: every hidden body is dormant`).toBe(true);
  if (tier === "evicted") {
    await app.evalJS<null>(setDelay("evictAfterMs", EVICT_AFTER_MS));
    const left = await pollFor(
      async () => (await app.bodies()).filter((b) => b.cardId !== null && hidden.includes(b.cardId)).map((b) => b.cardId),
      (ids) => ids.length === 0,
      EVICT_AFTER_MS + 6_000,
    );
    expect(left, `${label}: every hidden body is evicted`).toEqual([]);
    await app.evalJS<null>(setDelay("evictAfterMs", DEFAULT_EVICT_AFTER_MS));
  }
  // An evicted body has no page to put back; a dormant one keeps its clock.
  const standing = new Set((await app.bodies()).map((b) => b.cardId));
  await Promise.all(
    hidden.filter((id) => standing.has(id)).map((id) => app.body(id).evalJS<null>(setDelay("dormantAfterMs", DEFAULT_DORMANT_AFTER_MS))),
  );
  note(`${label}: ${hidden.join(", ")} ${tier} ${Date.now() - startedAt} ms after the delays were shortened`);
  return hidden;
}

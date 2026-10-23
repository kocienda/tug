/**
 * row-38-evicted-fold.test.ts — a card brought back from an eviction and
 * folded before its new page has painted stands under one cover, its last
 * frame, from the hand-off through the fold's land.
 *
 * The app launches on two workspaces: two Session cards side by side, shown,
 * and a Text card's, parked. The Text card's workspace is shown, which parks
 * the Session cards; past the host's eviction delay, shortened here, both
 * bodies are evicted by the clock, which keeps each one's last frame. The
 * Session workspace is shown again: one card takes the spare and the other
 * is made cold behind it, and each stands under its kept frame from the
 * hand-off. The row folds the first card the host reports standing covered,
 * placed visible and not yet painted — the cold one where it can — so its
 * page has not painted when the fold's plan reaches the host.
 *
 * The fold is a crossing that covers a whole card, and the body already
 * stands under a cover. The host stands one: the crossing takes the frame
 * the card came back under rather than snapshotting a page that has shown
 * nothing, and that cover comes off at the later of the page's paint and the
 * fold's land. The crossing's account names where its cover came from; once
 * the fold has landed the body is ready, painted, shown and folded, its
 * cover gone and its page following its container again.
 *
 * @family row-38
 * @covers tugapp/Sources/BodyCovers.swift
 * @covers tugapp/Sources/BodyBeatsRunner.swift
 * @covers tugapp/Sources/BodyLifecycle.swift
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import type { BodyViewSnapshot } from "../_harness/client";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { bodyOf, foldedOf, pollFor, sessionPane, settleFor } from "./_bodies";
import { activate, SHOULD_RUN, TEST_TIMEOUT_MS, textDeck } from "./_row-44";

const A = "r38f-a";
const B = "r38f-b";
const T = "r38f-text";
const SESSION_SPACE = "r38f-session";
const TEXT_SPACE = "r38f-text-space";
/** The eviction delay, shortened; the kept frame ages out after as long again, which the switch back beats. */
const EVICT_AFTER_MS = 1_500;

const LAYOUT = {
  version: 5,
  activeSpaceId: SESSION_SPACE,
  spaces: [
    {
      id: SESSION_SPACE,
      name: "Sessions",
      deck: {
        cards: [
          { id: A, componentId: "session", title: "A", closable: true },
          { id: B, componentId: "session", title: "B", closable: true },
        ],
        panes: [sessionPane(A, 0), sessionPane(B, 1)],
        activePaneId: `${A}-pane`,
        imposition: { kind: "two-up", layout: "fit", sidebars: {} },
        hasFocus: true,
      },
    },
    { id: TEXT_SPACE, name: "Text", deck: textDeck([T]) },
  ],
};

/** A body's last crossing, as the host accounts for it. */
interface CrossingAccount {
  planId: number;
  cover: "standing" | "snapshot" | "kept-page" | null;
  snapshotMs: number | null;
  restored?: boolean;
}

type CrossingSnapshot = BodyViewSnapshot & { crossing?: CrossingAccount | null; beatsPlanId?: number | null };

describe.skipIf(!SHOULD_RUN)("body-grounding row 38: a revived card folded before it paints", () => {
  test(
    "the fold's crossing takes the cover the card came back under, and it comes off once the card has painted and landed",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
      const app = await launchTugApp({
        testName: "body-grounding-row-38-evicted-fold",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        await app.bodyDelays({ evictAfterMs: EVICT_AFTER_MS });
        for (const id of [A, B]) {
          const up = await settleFor(() => bodyOf(app, id), (b) => b?.state === "ready" && b.painted && b.visible, 30_000);
          expect(up?.visible, `${id}: its body is ready and shown`).toBe(true);
        }

        // ---- Parked, and evicted by the clock, which keeps each last frame ----
        await activate(app, TEXT_SPACE);
        const gone = await pollFor(() => app.bodies(), (all) => !all.some((b) => b.cardId === A || b.cardId === B), EVICT_AFTER_MS + 6_000);
        expect(gone.some((b) => b.cardId === A || b.cardId === B), "both parked bodies are evicted").toBe(false);

        // ---- Shown again; the first card standing covered and unpainted is folded ----
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(SESSION_SPACE)} }), null)`);
        const waiting = (b: BodyViewSnapshot): boolean => (b.cardId === A || b.cardId === B) && b.covered && b.visible && !b.painted;
        const until = Date.now() + 5_000;
        let target: BodyViewSnapshot | undefined;
        while (target === undefined && Date.now() < until) {
          const all = (await app.bodies()).filter(waiting);
          target = all.find((b) => b.start === "cold") ?? all[0];
        }
        expect(target, "a revived card stands covered, placed visible and unpainted").toBeDefined();
        const card = target!.cardId!;
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("set-card-folded", { cardId: ${JSON.stringify(card)}, folded: true }), null)`);
        note(`folded ${card}, made ${target!.start}`);

        const landed = (await settleFor(
          () => bodyOf(app, card) as Promise<CrossingSnapshot | null>,
          (b) => b !== null && b.painted && b.crossing?.restored === true && b.beatsPlanId === null,
          10_000,
        )) as CrossingSnapshot | null;
        note(`crossing ${JSON.stringify(landed?.crossing ?? null)}; covered ${landed?.covered}, wasCovered ${landed?.wasCovered}, start ${landed?.start}`);
        expect(landed?.wasCovered, "the card came back under the frame its eviction kept").toBe(true);
        expect(landed?.crossing?.cover, "the fold's crossing took the cover the unpainted card stood under").toBe("standing");
        expect(landed?.crossing?.snapshotMs ?? null, "no snapshot was taken of a page that had shown nothing").toBeNull();
        expect(landed?.crossing?.restored, "the fold landed and the page follows its container again").toBe(true);
        expect(landed, "the body is ready, painted and shown, its cover gone").toMatchObject({ state: "ready", painted: true, visible: true, covered: false });
        expect(await foldedOf(app, card), "the card stands folded").toBe(true);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

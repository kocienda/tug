/**
 * at0864-dormant-card-last-frame.test.ts — a hidden card declared dormant has
 * its last frame taken at that moment, and shows it at the cut back.
 *
 * Two workspaces: home with one Text card, away with a Text card and a
 * Session card bound to a stubbed session (`streaming-stub-fixture.ts`). The
 * Session card is shown and painted, the keyboard is left with its Text
 * neighbour, and the deck goes home; the host takes the parked card's last
 * frame. A prompt is then sent into the hidden card, so its page draws past
 * that frame and says `bodyStale`. The dormant clock is shortened
 * (`bodyDelays`), and the host declares the card dormant.
 *
 * Asserts that the frame kept for the card after the declaration was taken
 * after its page said stale — a second frame, newer than the one the cut
 * took — that the host's log has that frame before the declaration, and that
 * the card's picture at the cut back is its last frame.
 *
 * @covers tugapp/Sources/BodyLifecycle.swift
 * @covers tugapp/Sources/BodyCovers.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "./_harness/tugbank-helpers";
import { bodyOf, pollFor, settleFor } from "./body-grounding/_bodies";
import { deckOf, space } from "./readings/_workspace-deck";
import { bindStreamingStubs, STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";
/** The host's dormant clock, shortened: already past when it is set. */
const DORMANT_MS = 1_000;

const HOME = space("g864", "home", ["text"]);
const AWAY = space("g864", "away", ["text", "session"]);
const TEXT = HOME.content[0].id;
const NEIGHBOUR = AWAY.content[0].id;
const SESSION = AWAY.content[1].id;

describe.skipIf(!SHOULD_RUN)("at0864 — a card declared dormant, at the cut back", () => {
  test(
    "its last frame is taken as it is declared dormant, and the cut back shows that frame",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const layout = {
        version: 5,
        activeSpaceId: HOME.id,
        spaces: [
          { id: HOME.id, name: "Home", deck: deckOf(HOME) },
          { id: AWAY.id, name: "Away", deck: deckOf(AWAY) },
        ],
      };
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(layout));
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: "at0864-dormant-card-last-frame",
        env: { TUGBANK_PATH: tugbankPath, [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        const go = async (id: string): Promise<void> => {
          await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(id)} }), null)`);
          await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (x) => x === id, 5_000);
        };
        const shown = (id: string) => settleFor(() => bodyOf(app, id), (b) => b?.state === "ready" && b.painted === true && b.visible === true, 30_000);
        const cover = async () => (await app.stages()).parkCovers.cards[SESSION];

        // Show the Session card, bind it, and let it paint.
        await shown(TEXT);
        await go(AWAY.id);
        await shown(SESSION);
        await bindStreamingStubs(app, [SESSION], stubDir);
        await app.dispatchControlAction("focus-session-card", { cardId: NEIGHBOUR });
        await settleFor(() => app.getFocusedCardId(), (id) => id === NEIGHBOUR, 3_000);
        await Bun.sleep(300);

        // Park it, and wait for the frame the cut owes it.
        await go(HOME.id);
        const first = await settleFor(cover, (c) => c !== undefined, 8_000);
        note(`parked: the cut's frame ${first === undefined ? "not taken" : `taken at ${Math.round(first.takenAt)}`}`);

        // Its session moves while it is hidden: the page draws past that frame.
        const logAt = app.tugappLog().length;
        const sent = Date.now();
        await app.driveSession(SESSION, { op: "send", text: "Walk the module and report each pass." });
        const stale = await settleFor(
          () =>
            app
              .body(SESSION)
              .evalJS<{ parts: string[]; at: number } | null>("window.__tugBodyStale === undefined ? null : window.__tugBodyStale", { timeoutMs: 1_000 })
              .catch(() => null),
          (s) => s !== null && s.at >= sent,
          10_000,
        );
        note(`hidden: the page said stale ${stale === null ? "never" : `for ${stale.parts.join(", ")}`}`);

        // The dormant clock falls due.
        await app.bodyDelays({ dormantAfterMs: DORMANT_MS, pageDormantAfterMs: null });
        const lines = (): string[] => app.tugappLog().slice(logAt).split("\n");
        const declared = await settleFor(
          async () => lines().findIndex((l) => l.includes(`dormant card=${SESSION} dormant=yes`)),
          (i) => i >= 0,
          8_000,
        );
        const framed = lines().findIndex((l) => l.includes(`park cover card=${SESSION}`));
        const second = await cover();
        note(
          `dormant: declared ${declared >= 0 ? "yes" : "no"}; a frame in the log ${framed < 0 ? "never" : framed < declared ? "before the declaration" : "after the declaration"}; ` +
            `the frame kept ${second === undefined ? "none" : `taken ${Math.round(second.takenAt - (first?.takenAt ?? 0))} ms after the cut's`}`,
        );

        // Cut back.
        const cut = Date.now();
        await go(AWAY.id);
        const record = (await app.stages()).cuts.filter((c) => c.to === AWAY.id && c.gestureWall >= cut - 50).at(-1) ?? null;
        const picture = record?.pictures[SESSION] ?? null;
        note(`the card's picture at the cut: ${picture ?? "none recorded"}`);

        expect(stale, "the hidden page said stale after the prompt").not.toBeNull();
        expect(declared, "the host declared the hidden card dormant").toBeGreaterThanOrEqual(0);
        expect(second, "a last frame is kept for the dormant card").toBeDefined();
        expect(second!.takenAt, "the frame kept was taken after the page said stale").toBeGreaterThan(stale!.at);
        expect(framed, "the host took a frame for the card after the prompt").toBeGreaterThanOrEqual(0);
        expect(framed, "the frame was taken before the card was declared dormant").toBeLessThan(declared);
        expect(record?.to, "the cut onto the card's workspace was made").toBe(AWAY.id);
        expect(picture, "the dormant card's picture at the cut is its last frame").toBe("lastFrame");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

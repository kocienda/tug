/**
 * row-43-bodiless-phase.test.ts — a parked card's dot follows its session
 * while its body is dormant and after it is evicted.
 *
 * The app launches on two workspaces: the Session card's, shown, and one
 * holding a Cards rail, parked. The Session card streams a turn; the Cards
 * workspace is shown under it, which parks the Session card's, and the Cards
 * body lists the parked card.
 * The parked body goes dormant past its delay and is evicted past the
 * reader's, both shortened here, so for most of the turn the card has a body
 * that hears nothing, and then none. Its row's dot in the Cards body reads
 * working through both tiers, and when the turn ends on tugcast — which no
 * page of that card hears — the dot goes still. The facts the body last
 * published said streaming, so a dot read from them would run for ever.
 *
 * @foreground
 * @covers tugdeck/src/lib/bodiless-facts-store.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/code-session-store/use-session-phase.ts
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { STREAM_PACE_MS, STUB_TRANSCRIPT_DIR_ENV, streamingTranscript, stubDirectory } from "../streaming-stub-fixture";
import { pollFor, promptPhase, sessionPane, waitForBody } from "./_bodies";
import { standUpKind } from "./_kind-bodies";
import { cardKind, kindPane, kindSidebars } from "./_kinds";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r43-a";
const CARDS = "r43-cards";
const SESSION_SPACE = "r43-session";
const CARDS_SPACE = "r43-cards-space";
/** The body's delay before dormancy and the reader's before eviction, shortened for the row. */
const DORMANT_AFTER_MS = 800;
const EVICT_AFTER_MS = 1_500;
const WORDS_PER_MESSAGE = 100;
const MESSAGES = 2;
/** How long the turn streams, at the stub's pace (a delta a word). */
const TURN_MS = WORDS_PER_MESSAGE * MESSAGES * STREAM_PACE_MS;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

/** A message of plain words, so the turn streams for {@link TURN_MS}. */
function text(index: number): string {
  return Array.from({ length: WORDS_PER_MESSAGE }, (_, i) => `word${index}-${i}`).join(" ");
}

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [sessionPane(A, 0)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

function cardsDeck(): Record<string, unknown> {
  return {
    cards: [{ id: CARDS, componentId: "cards", title: "Cards", closable: true }],
    panes: [kindPane("cards", CARDS, 0)],
    activePaneId: `${CARDS}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: kindSidebars(["cards"]) },
    hasFocus: true,
  };
}

const LAYOUT = {
  version: 5,
  activeSpaceId: SESSION_SPACE,
  spaces: [
    { id: SESSION_SPACE, name: "Session", deck: deck() },
    { id: CARDS_SPACE, name: "Cards", deck: cardsDeck() },
  ],
};

/** In the Cards body: the state of the dot on the row for `sessionId`, or null while there is no such row. */
function rowDot(sessionId: string): string {
  return `(function () {
    var row = document.querySelector('[data-session-id=${JSON.stringify(sessionId)}]');
    if (row === null) return null;
    var dot = row.querySelector('[data-slot="tug-progress-indicator"]');
    return dot === null ? null : dot.getAttribute("data-state");
  })()`;
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 43: a bodiless card's dot follows its session", () => {
  test(
    "a parked card's Cards row runs while its body is dormant and evicted, and stills when the turn ends unheard",
    async () => {
      const stubDir = stubDirectory();
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
      tugbankWrite(tugbankPath, "dev.tugapp.body-dormancy", "dormantAfterMs", "int", String(DORMANT_AFTER_MS));
      tugbankWrite(tugbankPath, "dev.tugapp.body-dormancy", "evictAfterMs", "int", String(EVICT_AFTER_MS));
      const app = await launchTugApp({
        testName: "body-grounding-row-43-bodiless-phase",
        foreground: true,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir, TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        const sid = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r43-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        writeFileSync(join(stubDir, `${sid}.json`), JSON.stringify(streamingTranscript(MESSAGES, 1, text)));
        await app.spawnSessionNew(A, { tugSessionId: sid, projectDir });
        await waitForBody(app, A);
        const body = app.body(A);

        // ---- A turn streams; the Cards workspace is shown under it, parking the Session card's ----
        await body.driveSession({ op: "send", text: "Stream the turn." });
        await body.waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: 10_000 });
        const streamingAt = Date.now();
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(CARDS_SPACE)} }), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === CARDS_SPACE, 5_000);
        const cards = await standUpKind(app, cardKind("cards"), CARDS);

        // ---- Dormant: the body hears nothing, and the row runs ----
        const asleep = await pollFor(() => body.evalJS<boolean>("window.__tug.bodyDormancy().dormant"), (d) => d, 5_000);
        expect(asleep, "the parked body is dormant past its delay").toBe(true);
        const dormantDot = await pollFor(() => cards.evalJS<string | null>(rowDot(sid)), (s) => s !== null, 5_000);
        note(`dormant ${Date.now() - streamingAt} ms into a ${TURN_MS} ms turn; the row's dot ${dormantDot}`);
        expect(dormantDot, "the Cards row runs for a dormant card mid-turn").toBe("running");

        // ---- Evicted: no body at all, and the row still runs ----
        const gone = await pollFor(() => app.bodies(), (all) => !all.some((b) => b.cardId === A), EVICT_AFTER_MS + 5_000);
        expect(gone.some((b) => b.cardId === A), "the parked body is evicted past the reader's delay").toBe(false);
        const evictedAt = Date.now() - streamingAt;
        const evictedDot = await cards.evalJS<string | null>(rowDot(sid));
        note(`evicted ${evictedAt} ms into the turn; the row's dot ${evictedDot}`);
        expect(evictedAt, "the turn is still streaming when the body goes").toBeLessThan(TURN_MS);
        expect(evictedDot, "the Cards row runs for an evicted card mid-turn").toBe("running");

        // ---- The turn ends on tugcast, unheard by any page of the card: the row stills ----
        const still = await pollFor(
          () => cards.evalJS<string | null>(rowDot(sid)),
          (s) => s === "stopped",
          Math.max(0, streamingAt + TURN_MS - Date.now()) + 6_000,
        );
        note(`the row's dot ${still} ${Date.now() - streamingAt} ms after the turn began`);
        expect(still, "the row's dot stills when the session's turn ends, its card still bodiless").toBe("stopped");
        expect((await app.bodies()).some((b) => b.cardId === A), "the card is still without a body").toBe(false);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * row-43-bodiless-closed.test.ts — a parked card whose session ends mid-turn
 * while its body is dormant reads still, not working.
 *
 * The app launches on two workspaces: the Session card's, shown, and one
 * holding a Cards rail, parked. The Session card streams a turn long enough
 * that it is still streaming when the row is done; the Cards workspace is
 * shown under it, which parks the Session card's, and its body goes dormant
 * past a shortened delay, so it hears nothing more. While the Cards row's dot
 * runs for it, the session is closed on tugcast (`close_session`) — the turn
 * never ends, so the ledger stamps no turn's end, and only the row's `state`
 * says the session is gone. The dot must still. The facts the body last
 * published said streaming, and a reading that waited for a turn-end stamp
 * would run for ever.
 *
 * @family row-43
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
import { pollFor, settleFor, promptPhase, sessionPane, waitForBody } from "./_bodies";
import { standUpKind } from "./_kind-bodies";
import { cardKind, kindPane, kindSidebars } from "./_kinds";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r43c-a";
const CARDS = "r43c-cards";
const SESSION_SPACE = "r43c-session";
const CARDS_SPACE = "r43c-cards-space";
/** The body's delay before dormancy, shortened for the row; eviction is left at its default. */
const DORMANT_AFTER_MS = 800;
const WORDS_PER_MESSAGE = 200;
const MESSAGES = 4;
/** How long the turn would stream, at the stub's pace (a delta a word): well past the row. */
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

describe.skipIf(!SHOULD_RUN)("body-grounding row 43: a bodiless card whose session ends", () => {
  test(
    "a dormant card's Cards row stills when its session is closed mid-turn, with no turn's end stamped",
    async () => {
      const stubDir = stubDirectory();
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
      const app = await launchTugApp({
        testName: "body-grounding-row-43-bodiless-closed",
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir, TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        await app.bodyDelays({ dormantAfterMs: DORMANT_AFTER_MS });
        const sid = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r43c-project-")));
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

        // ---- Dormant mid-turn: the row runs ----
        const asleep = await settleFor(() => body.evalJS<boolean>("window.__tug.bodyDormancy().dormant"), (d) => d, 5_000);
        expect(asleep, "the parked body is dormant past its delay").toBe(true);
        const running = await settleFor(() => cards.evalJS<string | null>(rowDot(sid)), (s) => s !== null, 5_000);
        expect(running, "the Cards row runs for a dormant card mid-turn").toBe("running");

        // ---- The session is closed under the dormant card, its turn never ended: the row stills ----
        const closedAt = Date.now();
        expect(closedAt - streamingAt, "the turn is still streaming when the session is closed").toBeLessThan(TURN_MS - 2_000);
        await app.evalJS<null>(`(window.__tug.closeSession(${JSON.stringify(A)}, ${JSON.stringify(sid)}), null)`);
        const still = await settleFor(() => cards.evalJS<string | null>(rowDot(sid)), (s) => s === "stopped", 5_000);
        note(`closed ${closedAt - streamingAt} ms into a ${TURN_MS} ms turn; the row's dot ${still} ${Date.now() - closedAt} ms after the close`);
        expect(still, "the row's dot stills once the session's row is closed, though no turn's end was stamped").toBe("stopped");
        expect(
          await body.evalJS<boolean>("window.__tug.bodyDormancy().dormant"),
          "the card's body is still dormant: the shell, not the body, read the close",
        ).toBe(true);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
